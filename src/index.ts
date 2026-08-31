#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname, platform } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const VERSION = '0.2.0'
const CONFIG_DIR = path.join(homedir(), '.dockploy-agent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
const HEARTBEAT_MS = 5_000

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

type AgentCommand = StartCommand | StopCommand

interface ManagedProcess {
  child: ChildProcess
  stopping: boolean
}

const processes = new Map<string, ManagedProcess>()

function usage(): void {
  console.log(`Dockploy Agent ${VERSION}

Uso:
  dockploy-agent login <URL_DOCKPLOY> <EMAIL_O_NOMBRE> <CONTRASEÑA>
  dockploy-agent configure <URL_DOCKPLOY> <TOKEN_EQUIPO>
  dockploy-agent run
  dockploy-agent status

El login usa tu cuenta de Dockploy y renueva solo el token del equipo.
configure sigue valiendo si ya tienes un token dcp_ del panel.

Ejemplo:
  dockploy-agent login https://dockployback.gaolania.com.es ana@empresa.com tuclave
  dockploy-agent run`)
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
    throw new Error(body.error || `Dockploy respondió ${response.status}`)
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

async function heartbeat(config: AgentConfig): Promise<void> {
  const response = await api<{ commands: AgentCommand[] }>(config, '/api/remote-agent/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      hostname: hostname(),
      platform: `${platform()}-${process.arch}`,
      version: VERSION,
    }),
  })

  for (const command of response.commands) {
    if (command.action === 'start') await startTunnel(config, command)
    else await stopTunnel(config, command.tunnelId)
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
  console.log(`Dockploy Agent ${VERSION} iniciado en ${hostname()}`)
  console.log(`Conectando con ${config.serverUrl}`)

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    for (const managed of processes.values()) {
      managed.stopping = true
      managed.child.kill('SIGTERM')
    }
    setTimeout(() => process.exit(0), 1_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (!stopping) {
    try {
      config = await heartbeatWithRenewal(config)
    } catch (error: any) {
      console.error('Heartbeat fallido:', error.message)
      if (/Invalid connector token/i.test(error.message)) {
        console.error('Vuelve a emparejar con: dockploy-agent login <URL> <EMAIL> <CONTRASEÑA>')
        shutdown()
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS))
  }
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
    console.log(`Configurado para ${config.serverUrl}`)
    console.log(`Procesos de túnel activos: ${processes.size}`)
    return
  }
  if (command === 'run') {
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
