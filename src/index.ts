#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { constants, openSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, freemem, homedir, hostname, platform, totalmem } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process'
import { HEARTBEAT_MS, nextDelayMs } from './backoff.js'
import { recommendedConcurrency } from './capacity.js'
import { once } from './once.js'
import { installChromium, isChromiumReady } from './chromium.js'
import { runLoadTest } from './loadTest.js'
import { normalizeScenario, type StartLoadTestCommand } from './loadTestTypes.js'
import { installRoot, publishedInstallationProblem, shouldAttemptUpdate, updateInstallation, type UpdateState } from './update.js'
import { describeRequestFailure, httpFailureMessage, REQUEST_TIMEOUT_MS } from './connection.js'

const VERSION = '0.5.3'
const CONFIG_DIR = path.join(homedir(), '.dockploy-agent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const PID_PATH = path.join(CONFIG_DIR, 'agent.pid')
const LOG_PATH = path.join(CONFIG_DIR, 'agent.log')
const UPDATE_STATE_PATH = path.join(CONFIG_DIR, 'update.json')

interface AgentConfig {
  serverUrl: string
  token: string
  refreshToken?: string
}

interface StartCommand {
  action: 'start'
  tunnelId: string
  alias: string
  port: number
  connectorToken: string
}

interface StopCommand {
  action: 'stop'
  tunnelId: string
}

interface StartDbProxyCommand {
  action: 'start-db-proxy'
  sessionId: string
  alias: string
  engine: string
}

interface StopDbProxyCommand {
  action: 'stop-db-proxy'
  sessionId: string
}

interface PrepareLoadTestingCommand {
  action: 'prepare-load-testing'
  runId?: string
}

interface CancelLoadTestCommand {
  action: 'cancel-load-test'
  runId: string
}

type AgentCommand =
  | StartCommand
  | StopCommand
  | StartDbProxyCommand
  | StopDbProxyCommand
  | PrepareLoadTestingCommand
  | StartLoadTestCommand
  | CancelLoadTestCommand

interface ManagedProcess {
  child: ChildProcess
  stopping: boolean
}

interface ManagedDbProxy {
  server: net.Server
  sockets: Set<net.Socket>
  stopping: boolean
  localPort?: number
  engine?: string
  reachable?: boolean
  probing?: boolean
}

const processes = new Map<string, ManagedProcess>()
const dbProxies = new Map<string, ManagedDbProxy>()
let chromiumReady = false
let installingChromium = false
let activeLoadTest: { runId: string; abort: AbortController } | undefined

function usage(): void {
  console.log(`Dockploy Agent ${VERSION}

Uso:
  dockploy-agent login <URL_DOCKPLOY> <EMAIL_O_NOMBRE> <CONTRASEÑA>
  dockploy-agent configure <URL_DOCKPLOY> <TOKEN_EQUIPO>
  dockploy-agent start          Arranca en segundo plano
  dockploy-agent stop           Detiene el proceso en segundo plano
  dockploy-agent update         Descarga la última versión y reinicia
  dockploy-agent logs           Muestra el registro
  dockploy-agent run            Arranca en primer plano (ocupa la terminal)
  dockploy-agent prepare        Instala Chromium para simulaciones de carga
  dockploy-agent status         Dice si el proceso corre y si Dockploy acepta el equipo

Con start puedes cerrar la terminal: el agente sigue corriendo.
Funciona desde cualquier carpeta y se actualiza solo cuando Dockploy lo pide.
El login usa tu cuenta un momento para crear el token del equipo y no guarda la sesión.

Ejemplo:
  dockploy-agent login https://dockployback.gaolania.com.es ana@empresa.com tuclave
  dockploy-agent start`)
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Dockploy debe usar HTTPS (solo localhost puede usar HTTP)')
  }
  return url.toString().replace(/\/$/, '')
}

async function writeConfig(config: AgentConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
}

async function saveConfig(serverUrl: string, token: string, refreshToken?: string): Promise<void> {
  if (!token.startsWith('dcp_')) throw new Error('El token del equipo no es válido')
  await writeConfig({
    serverUrl: normalizeServerUrl(serverUrl),
    token,
    ...(refreshToken ? { refreshToken } : {}),
  })
}

async function loadConfig(): Promise<AgentConfig> {
  const raw = await readFile(CONFIG_PATH, 'utf8').catch(() => '')
  if (!raw) throw new Error('Agente no configurado. Ejecuta dockploy-agent login <URL> <EMAIL> <CONTRASEÑA>')
  const parsed = JSON.parse(raw) as Partial<AgentConfig>
  if (!parsed.serverUrl || !parsed.token) throw new Error('Configuración del agente incompleta')
  return {
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    token: parsed.token,
    refreshToken: parsed.refreshToken,
  }
}

async function postJson<T>(
  serverUrl: string,
  endpoint: string,
  body: unknown,
  bearer?: string,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${serverUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(describeRequestFailure(error, endpoint))
  }
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    throw new Error(httpFailureMessage(response.status, endpoint, payload.error))
  }
  return payload as T
}

async function enrollDevice(
  serverUrl: string,
  accessToken: string,
  name: string,
): Promise<string> {
  const enrolled = await postJson<{ token: string }>(
    serverUrl,
    '/api/remote-connectors/enroll',
    { name },
    accessToken,
  )
  if (!enrolled.token?.startsWith('dcp_')) throw new Error('Dockploy no devolvió un token de equipo')
  return enrolled.token
}

/** La sesión de usuario no se queda en el equipo: con ella el código local llamaría a Dockploy como el usuario. */
async function discardUserSession(config: AgentConfig): Promise<AgentConfig> {
  if (!config.refreshToken) return config
  try {
    const session = await postJson<{ accessToken: string }>(
      config.serverUrl,
      '/api/auth/refresh',
      { refreshToken: config.refreshToken },
    )
    await postJson(config.serverUrl, '/api/auth/logout', {}, session.accessToken)
  } catch {
    // Si el token ya no vale, basta con borrarlo del disco.
  }
  const next = { serverUrl: config.serverUrl, token: config.token }
  await writeConfig(next)
  return next
}

async function loginAndEnroll(serverUrl: string, identifier: string, password: string): Promise<void> {
  const url = normalizeServerUrl(serverUrl)
  const session = await postJson<{ accessToken: string; refreshToken: string }>(
    url,
    '/api/auth/login',
    { email: identifier, password },
  )
  const token = await enrollDevice(url, session.accessToken, hostname())
  await postJson(url, '/api/auth/logout', {}, session.accessToken).catch(() => undefined)
  await saveConfig(url, token)
}

async function api<T>(
  config: AgentConfig,
  endpoint: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${config.serverUrl}${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(describeRequestFailure(error, endpoint))
  }
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('retry-after'))
    throw Object.assign(new Error(httpFailureMessage(response.status, endpoint, body.error)), {
      statusCode: response.status,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    })
  }
  return body as T
}

async function reportStatus(
  config: AgentConfig,
  tunnelId: string,
  status: 'starting' | 'running' | 'error' | 'stopped',
  error?: string,
): Promise<void> {
  await api(config, `/api/remote-agent/tunnels/${tunnelId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, error }),
  }).catch((statusError) => {
    console.error(`[${tunnelId}] No se pudo reportar estado:`, statusError.message)
  })
}

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(2_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function startTunnel(config: AgentConfig, command: StartCommand): Promise<void> {
  if (processes.has(command.tunnelId)) return
  if (!await portIsOpen(command.port)) {
    await reportStatus(
      config,
      command.tunnelId,
      'error',
      `No hay ninguna aplicación escuchando en localhost:${command.port}`,
    )
    return
  }

  console.log(`[${command.alias}] Abriendo ${command.port} mediante Cloudflare...`)
  const child = spawn('cloudflared', [
    'tunnel',
    '--no-autoupdate',
    'run',
    '--token',
    command.connectorToken,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const managed: ManagedProcess = { child, stopping: false }
  processes.set(command.tunnelId, managed)
  await reportStatus(config, command.tunnelId, 'starting')

  let registered = false
  const handleOutput = (chunk: Buffer) => {
    const output = chunk.toString('utf8')
    process.stdout.write(`[${command.alias}] ${output}`)
    if (!registered && /registered tunnel connection/i.test(output)) {
      registered = true
      void reportStatus(config, command.tunnelId, 'running')
    }
  }
  child.stdout?.on('data', handleOutput)
  child.stderr?.on('data', handleOutput)
  child.once('error', (error) => {
    processes.delete(command.tunnelId)
    void reportStatus(config, command.tunnelId, 'error', error.message)
  })
  child.once('exit', (code, signal) => {
    processes.delete(command.tunnelId)
    if (managed.stopping) {
      void reportStatus(config, command.tunnelId, 'stopped')
      return
    }
    void reportStatus(
      config,
      command.tunnelId,
      'error',
      `cloudflared terminó (${signal || `código ${code ?? 'desconocido'}`})`,
    )
  })
}

async function reportDbStatus(
  config: AgentConfig,
  sessionId: string,
  status: 'starting' | 'running' | 'error' | 'stopped',
  extra: { error?: string; localPort?: number; reachable?: boolean } = {},
): Promise<void> {
  await api(config, `/api/remote-agent/db-proxies/${sessionId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status, ...extra }),
  }).catch((statusError) => {
    console.error(`[db ${sessionId}] No se pudo reportar estado:`, statusError.message)
  })
}

function websocketUrl(serverUrl: string, path: string, token: string): string {
  const url = new URL(path, `${serverUrl}/`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', token)
  return url.toString()
}

function pipeClientToDatabase(
  config: AgentConfig,
  sessionId: string,
  client: net.Socket,
  alias: string,
): void {
  const WebSocketImpl = (globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket
  if (!WebSocketImpl) {
    client.destroy()
    return
  }
  const ws = new WebSocketImpl(websocketUrl(config.serverUrl, `/api/remote-agent/db-proxy/${sessionId}`, config.token))
  ws.binaryType = 'arraybuffer'
  const pending: Buffer[] = []
  const send = (chunk: Buffer) => {
    if (ws.readyState === WebSocketImpl.OPEN) ws.send(new Uint8Array(chunk))
    else pending.push(chunk)
  }
  client.on('data', (chunk) => send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
  ws.addEventListener('open', () => {
    for (const chunk of pending) ws.send(new Uint8Array(chunk))
    pending.length = 0
  })
  ws.addEventListener('message', (event) => {
    const raw = event.data
    if (client.destroyed) return
    if (raw instanceof ArrayBuffer) client.write(Buffer.from(raw))
    else if (Buffer.isBuffer(raw)) client.write(raw)
    else if (typeof raw === 'string') client.write(raw)
  })
  const closeBoth = once(() => {
    client.destroy()
    if (ws.readyState === WebSocketImpl.OPEN || ws.readyState === WebSocketImpl.CONNECTING) {
      try {
        ws.close()
      } catch {
        // El socket ya se estaba cerrando por su cuenta.
      }
    }
  })
  ws.addEventListener('close', (event) => {
    // Un cierre del servidor deja al cliente SQL esperando un saludo que no llega.
    // Sin esta línea el fallo es mudo y parece que el puerto local no funciona.
    const { code, reason } = event as CloseEvent
    if (code && code !== 1000 && code !== 1005) {
      console.error(`[${alias}] Dockploy cerró el túnel (${code}${reason ? `: ${reason}` : ''})`)
    }
    closeBoth()
  })
  ws.addEventListener('error', (event) => {
    const detail = (event as ErrorEvent).message
      || (event as unknown as { error?: { message?: string } }).error?.message
    console.error(`[${alias}] No se pudo abrir el túnel con Dockploy${detail ? `: ${detail}` : ''}`)
    closeBoth()
  })
  client.on('error', closeBoth)
  client.on('close', closeBoth)
}

async function startDbProxy(config: AgentConfig, command: StartDbProxyCommand): Promise<void> {
  const existing = dbProxies.get(command.sessionId)
  if (existing) {
    if (existing.reachable || existing.probing || !existing.localPort) return
    existing.probing = true
    const reachable = await probeLocalDatabase(existing.engine || command.engine, existing.localPort)
    existing.probing = false
    if (!reachable || !dbProxies.has(command.sessionId)) return
    existing.reachable = true
    await reportDbStatus(config, command.sessionId, 'running', { localPort: existing.localPort, reachable: true })
    console.log(`[${command.alias}] La base contesta en 127.0.0.1:${existing.localPort}`)
    return
  }
  console.log(`[${command.alias}] Abriendo ${command.engine} en este equipo...`)
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    pipeClientToDatabase(config, command.sessionId, client, command.alias)
  })
  const managed: ManagedDbProxy = { server, sockets, stopping: false, engine: command.engine }
  dbProxies.set(command.sessionId, managed)
  await reportDbStatus(config, command.sessionId, 'starting')

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
  } catch (error: any) {
    dbProxies.delete(command.sessionId)
    await reportDbStatus(config, command.sessionId, 'error', { error: error.message })
    return
  }

  const address = server.address()
  if (!address || typeof address === 'string') {
    dbProxies.delete(command.sessionId)
    await reportDbStatus(config, command.sessionId, 'error', { error: 'No se pudo reservar un puerto local' })
    return
  }
  await reportDbStatus(config, command.sessionId, 'running', { localPort: address.port })
  console.log(`[${command.alias}] Listo en 127.0.0.1:${address.port}. Comprobando que la base contesta...`)
  const reachable = await probeLocalDatabase(command.engine, address.port)
  managed.localPort = address.port
  managed.reachable = reachable
  if (reachable) {
    await reportDbStatus(config, command.sessionId, 'running', { localPort: address.port, reachable: true })
  }
  console.log(reachable
    ? `[${command.alias}] La base contesta en 127.0.0.1:${address.port}`
    : `[${command.alias}] El puerto está abierto, pero la base no contesta`)
}

function probeLocalDatabase(engine: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('data', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      if (engine === 'mysql') return
      socket.write(probePayload(engine))
    })
  })
}

function probePayload(engine: string): Buffer {
  if (engine === 'redis') return Buffer.from('*1\r\n$4\r\nPING\r\n')
  if (engine === 'postgres') {
    const user = Buffer.from('user\0postgres\0\0')
    const body = Buffer.alloc(8 + user.length)
    body.writeInt32BE(body.length, 0)
    body.writeInt32BE(196608, 4)
    user.copy(body, 8)
    return body
  }
  const query = Buffer.concat([
    Buffer.from([0x10]),
    Buffer.from('hello\0'),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from([0x02]),
    Buffer.from('$db\0'),
    Buffer.from([6, 0, 0, 0]),
    Buffer.from('admin\0'),
    Buffer.from([0]),
  ])
  const document = Buffer.alloc(4 + query.length)
  document.writeInt32LE(document.length, 0)
  query.copy(document, 4)
  const header = Buffer.alloc(16 + 4 + 1)
  header.writeInt32LE(header.length + document.length, 0)
  header.writeInt32LE(1, 4)
  header.writeInt32LE(2013, 12)
  header.writeUInt8(0, 20)
  return Buffer.concat([header, document])
}

async function stopDbProxy(config: AgentConfig, sessionId: string): Promise<void> {
  const managed = dbProxies.get(sessionId)
  if (!managed) {
    await reportDbStatus(config, sessionId, 'stopped')
    return
  }
  managed.stopping = true
  for (const socket of managed.sockets) socket.destroy()
  await new Promise<void>((resolve) => managed.server.close(() => resolve()))
  dbProxies.delete(sessionId)
  await reportDbStatus(config, sessionId, 'stopped')
}

async function stopTunnel(config: AgentConfig, tunnelId: string): Promise<void> {
  const managed = processes.get(tunnelId)
  if (!managed) {
    await reportStatus(config, tunnelId, 'stopped')
    return
  }
  managed.stopping = true
  managed.child.kill('SIGTERM')
  setTimeout(() => {
    if (processes.has(tunnelId)) managed.child.kill('SIGKILL')
  }, 5_000).unref()
}

async function reportLoadTest(
  config: AgentConfig,
  runId: string,
  endpoint: 'status' | 'progress' | 'users' | 'complete',
  body: unknown,
): Promise<void> {
  await api(config, `/api/remote-agent/load-tests/${runId}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(body),
  }).catch((error) => {
    console.error(`[load-test ${runId}] No se pudo reportar ${endpoint}:`, error.message)
  })
}

async function ensureChromium(config: AgentConfig, runId?: string): Promise<boolean> {
  if (chromiumReady || await isChromiumReady()) {
    chromiumReady = true
    return true
  }
  if (installingChromium) return false
  installingChromium = true
  try {
    if (runId) await reportLoadTest(config, runId, 'status', { status: 'preparing', message: 'Instalando Chromium...' })
    console.log('Instalando Chromium para simulaciones de carga...')
    await installChromium((line) => console.log(line))
    chromiumReady = true
    if (runId) await reportLoadTest(config, runId, 'status', { status: 'queued', message: 'Chromium listo' })
    return true
  } catch (error: any) {
    if (runId) {
      await reportLoadTest(config, runId, 'complete', {
        status: 'failed',
        failureReason: error.message || 'No se pudo instalar Chromium',
      })
    }
    throw error
  } finally {
    installingChromium = false
  }
}

async function startLoadTest(config: AgentConfig, command: StartLoadTestCommand): Promise<void> {
  if (activeLoadTest) {
    if (activeLoadTest.runId === command.runId) return
    await reportLoadTest(config, command.runId, 'complete', {
      status: 'failed',
      failureReason: 'Este equipo ya tiene una simulación en curso',
    })
    return
  }
  const abort = new AbortController()
  activeLoadTest = { runId: command.runId, abort }
  try {
    if (!await ensureChromium(config, command.runId)) return
    await reportLoadTest(config, command.runId, 'status', { status: 'running', message: 'Lanzando usuarios virtuales' })
    console.log(`[load-test ${command.runId}] ${command.virtualUsers} usuarios → ${command.targetUrl}`)
    const result = await runLoadTest({
      ...command,
      scenario: normalizeScenario(command.scenario),
    }, {
      signal: abort.signal,
      onProgress: async (progress, batch) => {
        await reportLoadTest(config, command.runId, 'progress', progress)
        if (batch.length > 0) {
          await reportLoadTest(config, command.runId, 'users', {
            users: batch,
          })
        }
      },
    })
    await reportLoadTest(config, command.runId, 'complete', {
      status: result.status,
      failureReason: result.failureReason,
      timeline: result.timeline,
    })
  } catch (error: any) {
    await reportLoadTest(config, command.runId, 'complete', {
      status: 'failed',
      failureReason: error.message || 'La simulación falló',
    })
  } finally {
    if (activeLoadTest?.runId === command.runId) activeLoadTest = undefined
  }
}

function cancelLoadTest(runId: string): void {
  if (activeLoadTest?.runId === runId) activeLoadTest.abort.abort()
}

function loadTestingHeartbeatPayload() {
  return {
    supported: true,
    chromiumReady,
    installing: installingChromium,
    busy: Boolean(activeLoadTest),
    recommendedConcurrency: recommendedConcurrency({ cpus: cpus().length, freeMem: freemem() }),
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  }
}

interface HeartbeatBody {
  connectorId?: string
  commands?: AgentCommand[]
  expectedAgentVersion?: string
  forceUpdate?: boolean
}

interface HeartbeatInfo {
  connectorId?: string
  commandCount: number
  elapsedMs: number
}

const HEARTBEAT_ENDPOINT = '/api/remote-agent/heartbeat'
const CONNECTED_LOG_EVERY = 12

function heartbeatBody(): string {
  return JSON.stringify({
    hostname: hostname(),
    platform: `${platform()}-${process.arch}`,
    version: VERSION,
    loadTesting: loadTestingHeartbeatPayload(),
  })
}

async function postHeartbeat(config: AgentConfig): Promise<{ body: HeartbeatBody; elapsedMs: number }> {
  const started = Date.now()
  const body = await api<HeartbeatBody>(config, HEARTBEAT_ENDPOINT, {
    method: 'POST',
    body: heartbeatBody(),
  })
  return { body, elapsedMs: Date.now() - started }
}

function logConnection(serverUrl: string, info: HeartbeatInfo, kind: 'connected' | 'still' | 'restored'): void {
  const id = info.connectorId ? ` Equipo ${info.connectorId}.` : ''
  const orders = info.commandCount > 0
    ? ` Órdenes pendientes: ${info.commandCount}.`
    : ' Sin órdenes pendientes.'
  if (kind === 'restored') {
    console.log(`Conexión con Dockploy restablecida (${info.elapsedMs} ms).${id}${orders}`)
    return
  }
  if (kind === 'still') {
    console.log(`Sigue conectado a ${serverUrl} (${info.elapsedMs} ms).${id}${orders}`)
    return
  }
  console.log(`Conectado a ${serverUrl} (${info.elapsedMs} ms).${id}${orders}`)
}

async function heartbeat(config: AgentConfig): Promise<HeartbeatInfo> {
  const { body, elapsedMs } = await postHeartbeat(config)
  const commands = Array.isArray(body.commands) ? body.commands : []

  for (const command of commands) {
    if (command.action === 'start') await startTunnel(config, command)
    else if (command.action === 'stop') await stopTunnel(config, command.tunnelId)
    else if (command.action === 'start-db-proxy') await startDbProxy(config, command)
    else if (command.action === 'stop-db-proxy') await stopDbProxy(config, command.sessionId)
    else if (command.action === 'prepare-load-testing') void ensureChromium(config, command.runId)
    else if (command.action === 'start-load-test') void startLoadTest(config, command)
    else if (command.action === 'cancel-load-test') cancelLoadTest(command.runId)
    else console.error(`Orden desconocida del servidor: ${String((command as { action?: unknown }).action)}`)
  }

  if (body.forceUpdate) await forceUpdate(config)
  else await maybeAutoUpdate(body.expectedAgentVersion)
  return {
    connectorId: body.connectorId ? String(body.connectorId) : undefined,
    commandCount: commands.length,
    elapsedMs,
  }
}

async function heartbeatWithRenewal(config: AgentConfig): Promise<{ config: AgentConfig; info: HeartbeatInfo }> {
  return { config, info: await heartbeat(config) }
}

function assertCloudflaredInstalled(): void {
  const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' })
  if (result.error || result.status !== 0) {
    throw new Error('No se encontró cloudflared. Instálalo antes de arrancar Dockploy Agent.')
  }
}

async function runAgent(): Promise<void> {
  const tampered = await publishedInstallationProblem(installRoot(import.meta.url))
  if (tampered) throw new Error(tampered)
  let config = await discardUserSession(await loadConfig())
  assertCloudflaredInstalled()
  chromiumReady = await isChromiumReady()
  console.log(`Dockploy Agent ${VERSION} iniciado en ${hostname()}`)
  console.log(`Conectando con ${config.serverUrl}${HEARTBEAT_ENDPOINT} (timeout ${REQUEST_TIMEOUT_MS / 1000} s)`)
  if (!chromiumReady) {
    console.log('Chromium no está instalado. Las simulaciones pedirán instalarlo o ejecuta: dockploy-agent prepare')
  }

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    for (const managed of processes.values()) {
      managed.stopping = true
      managed.child.kill('SIGTERM')
    }
    for (const [sessionId, managed] of dbProxies) {
      managed.stopping = true
      for (const socket of managed.sockets) socket.destroy()
      managed.server.close()
      dbProxies.delete(sessionId)
    }
    activeLoadTest?.abort.abort()
    setTimeout(() => process.exit(0), 1_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Un fallo aislado en un socket no debe llevarse por delante los túneles abiertos.
  process.on('uncaughtException', (error) => {
    console.error('Error no controlado:', error instanceof Error ? error.stack || error.message : error)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('Promesa rechazada sin gestionar:', reason instanceof Error ? reason.message : reason)
  })

  let failures = 0
  let successes = 0
  let retryAfterSeconds: number | undefined

  while (!stopping) {
    const hadFailures = failures > 0
    try {
      const beat = await heartbeatWithRenewal(config)
      config = beat.config
      successes += 1
      if (hadFailures || successes === 1 || successes % CONNECTED_LOG_EVERY === 0) {
        const kind = hadFailures ? 'restored' : successes === 1 ? 'connected' : 'still'
        logConnection(config.serverUrl, beat.info, kind)
      }
      failures = 0
      retryAfterSeconds = undefined
    } catch (error: any) {
      failures += 1
      successes = 0
      retryAfterSeconds = error.retryAfterSeconds
      const delay = nextDelayMs({ failures, retryAfterSeconds })
      console.error(
        `Sin conexión con ${config.serverUrl} (intento ${failures}): ${error.message}. Reintento en ${Math.round(delay / 1000)} s.`,
      )
      if (/Invalid connector token/i.test(error.message)) {
        console.error('El panel no puede marcarlo conectado: Dockploy no reconoce el token de este equipo.')
        console.error('Vuelve a emparejar con: dockploy-agent login <URL> <EMAIL> <CONTRASEÑA>')
        shutdown()
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

async function readDaemonPid(): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(PID_PATH, 'utf8')
  } catch {
    return null
  }
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (processAlive(pid)) return pid
  await rm(PID_PATH, { force: true })
  return null
}

async function readUpdateState(): Promise<UpdateState | undefined> {
  try {
    return JSON.parse(await readFile(UPDATE_STATE_PATH, 'utf8')) as UpdateState
  } catch {
    return undefined
  }
}

async function writeUpdateState(state: UpdateState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await writeFile(UPDATE_STATE_PATH, JSON.stringify(state), { mode: 0o600 })
}

/** Arranca el agente recién compilado y termina el proceso antiguo. */
async function relaunchAfterUpdate(): Promise<void> {
  await rm(PID_PATH, { force: true })
  const log = openSync(LOG_PATH, 'a', 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start'], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  process.exit(0)
}

async function forceUpdate(config: AgentConfig): Promise<void> {
  try {
    await api(config, '/api/remote-agent/update-ack', { method: 'POST', body: '{}' })
  } catch (error: any) {
    console.error(`No se pudo confirmar la actualización pedida: ${error.message}`)
    return
  }
  console.log('Dockploy pidió actualizar ahora.')
  const outcome = await updateInstallation(installRoot(import.meta.url), (line) => console.log(line))
  if (!outcome.ok) {
    console.error(`No se pudo actualizar: ${outcome.message}`)
    return
  }
  console.log('Actualización aplicada. Reiniciando el agente...')
  await relaunchAfterUpdate()
}

async function maybeAutoUpdate(expected?: string): Promise<void> {
  if (!expected) return
  const state = await readUpdateState()
  if (!shouldAttemptUpdate(expected, VERSION, state)) return

  // Se anota antes de empezar: si la versión pedida no llega a publicarse, el
  // agente no repite el git pull en cada latido.
  await writeUpdateState({ target: expected, attemptedAt: Date.now() })
  console.log(`Dockploy espera la versión ${expected} y esta es la ${VERSION}. Actualizando...`)

  const outcome = await updateInstallation(installRoot(import.meta.url), (line) => console.log(line))
  if (!outcome.ok) {
    console.error(`No se pudo actualizar: ${outcome.message}`)
    return
  }
  console.log('Actualización aplicada. Reiniciando el agente...')
  await relaunchAfterUpdate()
}

async function rememberStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const line = `[${new Date().toISOString()}] No se pudo arrancar: ${message}\n`
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined)
  await appendFile(LOG_PATH, line).catch(() => undefined)
}

async function startDaemon(): Promise<void> {
  const running = await readDaemonPid()
  if (running) {
    console.log(`El agente ya está funcionando en segundo plano (PID ${running}).`)
    return
  }
  try {
    await loadConfig()
    assertCloudflaredInstalled()
    const tampered = await publishedInstallationProblem(installRoot(import.meta.url))
    if (tampered) throw new Error(tampered)
  } catch (error) {
    await rememberStartupFailure(error)
    throw error
  }
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const log = openSync(LOG_PATH, 'a', 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  if (!child.pid) throw new Error('No se pudo arrancar el agente en segundo plano')
  await writeFile(PID_PATH, `${child.pid}\n`, { mode: 0o600 })
  console.log(`Agente arrancado en segundo plano (PID ${child.pid}). Ya puedes cerrar la terminal.`)
  console.log(`Registro: ${LOG_PATH}`)
}

async function stopDaemon(): Promise<void> {
  const pid = await readDaemonPid()
  if (!pid) {
    console.log('No hay ningún agente en segundo plano.')
    await rm(PID_PATH, { force: true })
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50 && processAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  await rm(PID_PATH, { force: true })
  console.log('Agente detenido. Los túneles publicados dejan de estar accesibles.')
}

async function showLogs(count: number): Promise<void> {
  let content: string
  try {
    content = await readFile(LOG_PATH, 'utf8')
  } catch {
    console.log('Todavía no hay registro. Arranca el agente con: dockploy-agent start')
    return
  }
  const lines = content.split('\n').filter((line) => line.length > 0)
  console.log(lines.slice(-count).join('\n'))
  console.log(`\n(${LOG_PATH})`)
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv
  if (command === 'login') {
    if (args.length !== 3) {
      usage()
      process.exitCode = 1
      return
    }
    await loginAndEnroll(args[0], args[1], args[2])
    console.log(`Token de equipo guardado en ${CONFIG_PATH}`)
    return
  }
  if (command === 'configure') {
    if (args.length !== 2) {
      usage()
      process.exitCode = 1
      return
    }
    await saveConfig(args[0], args[1])
    console.log(`Configuración guardada en ${CONFIG_PATH}`)
    return
  }
  if (command === 'status') {
    await access(CONFIG_PATH, constants.R_OK)
    const config = await loadConfig()
    const pid = await readDaemonPid()
    const cloudflared = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' })
    console.log(`Dockploy Agent ${VERSION}`)
    console.log(`Servidor: ${config.serverUrl}`)
    console.log(pid ? `Proceso: en segundo plano (PID ${pid})` : 'Proceso: parado. Arráncalo con: dockploy-agent start')
    console.log(cloudflared.error || cloudflared.status !== 0
      ? 'cloudflared: no está instalado. Sin él el agente no arranca y el panel no lo marca conectado.'
      : 'cloudflared: instalado')
    console.log(`Simulaciones: Chromium ${(await isChromiumReady()) ? 'listo' : 'pendiente (dockploy-agent prepare)'}`)
    console.log(`Comprobando ${config.serverUrl}${HEARTBEAT_ENDPOINT} ...`)
    try {
      const { body, elapsedMs } = await postHeartbeat(config)
      const id = body.connectorId ? String(body.connectorId) : 'sin id'
      const orders = Array.isArray(body.commands) ? body.commands.length : 0
      console.log(`Conectado. Dockploy aceptó el equipo ${id} en ${elapsedMs} ms. Órdenes pendientes: ${orders}.`)
      if (!pid) {
        console.log('El token vale, pero el proceso está parado: el panel volverá a offline en unos 30 segundos.')
        console.log('Déjalo en marcha con: dockploy-agent start')
      }
    } catch (error: any) {
      console.error(`No conecta: ${error.message}`)
      if (/Invalid connector token/i.test(error.message)) {
        console.error('Vuelve a emparejar con: dockploy-agent login <URL> <EMAIL> <CONTRASEÑA>')
      }
      process.exitCode = 1
    }
    return
  }
  if (command === 'prepare') {
    const ready = await isChromiumReady()
    if (ready) {
      console.log('Chromium ya está instalado.')
      return
    }
    if (stdinStream.isTTY) {
      const rl = createInterface({ input: stdinStream, output: stdoutStream })
      const answer = await new Promise<string>((resolve) => {
        rl.question('¿Instalar Chromium para las simulaciones de carga? [s/N] ', resolve)
      })
      rl.close()
      if (!/^s(i|í)?$/i.test(answer.trim())) {
        console.log('Instalación cancelada.')
        return
      }
    }
    await installChromium((line) => console.log(line))
    console.log('Chromium listo para simulaciones.')
    return
  }
  if (command === 'update') {
    const root = installRoot(import.meta.url)
    console.log(`Actualizando ${root}`)
    const outcome = await updateInstallation(root, (line) => console.log(line))
    if (!outcome.ok) {
      console.error(outcome.message)
      process.exitCode = 1
      return
    }
    if (await readDaemonPid()) {
      await stopDaemon()
      await startDaemon()
    }
    console.log(outcome.message)
    return
  }
  if (command === 'start') {
    await startDaemon()
    return
  }
  if (command === 'stop') {
    await stopDaemon()
    return
  }
  if (command === 'logs') {
    const count = Number.parseInt(args[0] ?? '', 10)
    await showLogs(Number.isInteger(count) && count > 0 ? count : 50)
    return
  }
  if (command === 'run') {
    const running = await readDaemonPid()
    if (running && running !== process.pid) {
      throw new Error(`Ya hay un agente en segundo plano (PID ${running}). Detenlo con: dockploy-agent stop`)
    }
    await runAgent()
    return
  }
  usage()
  if (command) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
