#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { constants, openSync } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, freemem, homedir, hostname, platform, totalmem } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process'
import { HEARTBEAT_MS, nextDelayMs, shouldLogFailure } from './backoff.js'
import { recommendedConcurrency } from './capacity.js'
import { once } from './once.js'
import { installChromium, isChromiumReady } from './chromium.js'
import { runLoadTest } from './loadTest.js'
import { normalizeScenario, type StartLoadTestCommand } from './loadTestTypes.js'

const VERSION = '0.5.0'
const CONFIG_DIR = path.join(homedir(), '.dockploy-agent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const PID_PATH = path.join(CONFIG_DIR, 'agent.pid')
const LOG_PATH = path.join(CONFIG_DIR, 'agent.log')

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
  dockploy-agent logs           Muestra el registro
  dockploy-agent run            Arranca en primer plano (ocupa la terminal)
  dockploy-agent prepare        Instala Chromium para simulaciones de carga
  dockploy-agent status

Con start puedes cerrar la terminal: el agente sigue corriendo.
El login usa tu cuenta de Dockploy y renueva solo el token del equipo.

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
  const response = await fetch(`${serverUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || `Dockploy respondió ${response.status}`)
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

async function refreshUserSession(config: AgentConfig): Promise<AgentConfig & { accessToken: string }> {
  if (!config.refreshToken) throw new Error('No hay sesión de usuario guardada')
  const session = await postJson<{ accessToken: string; refreshToken: string }>(
    config.serverUrl,
    '/api/auth/refresh',
    { refreshToken: config.refreshToken },
  )
  const next = { ...config, refreshToken: session.refreshToken }
  await writeConfig(next)
  return { ...next, accessToken: session.accessToken }
}

async function renewDeviceToken(config: AgentConfig): Promise<AgentConfig> {
  const withSession = await refreshUserSession(config)
  const token = await enrollDevice(withSession.serverUrl, withSession.accessToken, hostname())
  const next = { serverUrl: withSession.serverUrl, token, refreshToken: withSession.refreshToken }
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
  await saveConfig(url, token, session.refreshToken)
}

async function api<T>(
  config: AgentConfig,
  endpoint: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${config.serverUrl}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) {
    const message = response.status === 429
      ? 'Dockploy está limitando las peticiones de este equipo (429)'
      : body.error || `Dockploy respondió ${response.status}`
    const retryAfter = Number(response.headers.get('retry-after'))
    throw Object.assign(new Error(message), {
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
  extra: { error?: string; localPort?: number } = {},
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

function pipeClientToDatabase(config: AgentConfig, sessionId: string, client: net.Socket): void {
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
  ws.addEventListener('close', closeBoth)
  ws.addEventListener('error', closeBoth)
  client.on('error', closeBoth)
  client.on('close', closeBoth)
}

async function startDbProxy(config: AgentConfig, command: StartDbProxyCommand): Promise<void> {
  if (dbProxies.has(command.sessionId)) return
  console.log(`[${command.alias}] Abriendo ${command.engine} en este equipo...`)
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    pipeClientToDatabase(config, command.sessionId, client)
  })
  const managed: ManagedDbProxy = { server, sockets, stopping: false }
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
  console.log(`[${command.alias}] Listo en 127.0.0.1:${address.port}`)
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

async function heartbeat(config: AgentConfig): Promise<void> {
  const response = await api<{ commands: AgentCommand[] }>(config, '/api/remote-agent/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      hostname: hostname(),
      platform: `${platform()}-${process.arch}`,
      version: VERSION,
      loadTesting: loadTestingHeartbeatPayload(),
    }),
  })

  for (const command of response.commands) {
    if (command.action === 'start') await startTunnel(config, command)
    else if (command.action === 'stop') await stopTunnel(config, command.tunnelId)
    else if (command.action === 'start-db-proxy') await startDbProxy(config, command)
    else if (command.action === 'stop-db-proxy') await stopDbProxy(config, command.sessionId)
    else if (command.action === 'prepare-load-testing') void ensureChromium(config, command.runId)
    else if (command.action === 'start-load-test') void startLoadTest(config, command)
    else if (command.action === 'cancel-load-test') cancelLoadTest(command.runId)
  }
}

async function heartbeatWithRenewal(config: AgentConfig): Promise<AgentConfig> {
  try {
    await heartbeat(config)
    return config
  } catch (error: any) {
    if (!/Invalid connector token/i.test(error.message) || !config.refreshToken) throw error
    console.log('El token del equipo ya no vale. Renovando con la sesión de Dockploy...')
    const renewed = await renewDeviceToken(config)
    await heartbeat(renewed)
    return renewed
  }
}

function assertCloudflaredInstalled(): void {
  const result = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' })
  if (result.error || result.status !== 0) {
    throw new Error('No se encontró cloudflared. Instálalo antes de arrancar Dockploy Agent.')
  }
}

async function runAgent(): Promise<void> {
  let config = await loadConfig()
  assertCloudflaredInstalled()
  chromiumReady = await isChromiumReady()
  console.log(`Dockploy Agent ${VERSION} iniciado en ${hostname()}`)
  console.log(`Conectando con ${config.serverUrl}`)
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
  let retryAfterSeconds: number | undefined

  while (!stopping) {
    try {
      config = await heartbeatWithRenewal(config)
      if (failures > 0) console.log('Conexión con Dockploy restablecida.')
      failures = 0
      retryAfterSeconds = undefined
    } catch (error: any) {
      failures += 1
      retryAfterSeconds = error.retryAfterSeconds
      if (shouldLogFailure(failures)) {
        console.error(`Heartbeat fallido (${failures}):`, error.message)
      }
      if (/Invalid connector token/i.test(error.message)) {
        console.error('Vuelve a emparejar con: dockploy-agent login <URL> <EMAIL> <CONTRASEÑA>')
        shutdown()
        throw error
      }
    }
    const delay = failures === 0 ? HEARTBEAT_MS : nextDelayMs({ failures, retryAfterSeconds })
    await new Promise((resolve) => setTimeout(resolve, delay))
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

async function startDaemon(): Promise<void> {
  const running = await readDaemonPid()
  if (running) {
    console.log(`El agente ya está funcionando en segundo plano (PID ${running}).`)
    return
  }
  await loadConfig()
  assertCloudflaredInstalled()
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
    console.log(`Sesión y token de equipo guardados en ${CONFIG_PATH}`)
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
    console.log(`Configurado para ${config.serverUrl}`)
    console.log(pid ? `En segundo plano, funcionando (PID ${pid})` : 'Parado. Arráncalo con: dockploy-agent start')
    console.log(`Simulaciones: Chromium ${(await isChromiumReady()) ? 'listo' : 'pendiente (dockploy-agent prepare)'}`)
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
