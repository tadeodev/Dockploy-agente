import { spawnSync } from 'node:child_process'
import { isNewerVersion } from './update.js'

export const CLOUDFLARED_UPDATE_EVERY_MS = 6 * 60 * 60 * 1000
const UPDATE_TIMEOUT_MS = 120_000

export function parseCloudflaredVersion(text?: string | null): string | null {
  const match = String(text || '').match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? null
}

export function cloudflaredIsOlder(current?: string | null, expected?: string | null): boolean {
  const wanted = parseCloudflaredVersion(expected)
  if (!wanted) return false
  const installed = parseCloudflaredVersion(current)
  if (!installed) return true
  return isNewerVersion(wanted, installed)
}

export function cloudflaredBlockReason(current?: string | null, expected?: string | null): string | null {
  if (!cloudflaredIsOlder(current, expected)) return null
  const wanted = parseCloudflaredVersion(expected)
  if (!parseCloudflaredVersion(current)) {
    return `cloudflared no está actualizado. Hace falta ${wanted}. Ejecuta cloudflared update en este equipo.`
  }
  return `cloudflared ${parseCloudflaredVersion(current)} está desactualizado. Hace falta ${wanted}. Ejecuta cloudflared update en este equipo.`
}

export interface CloudflaredRun {
  stdout?: string
  stderr?: string
  status: number | null
  error?: Error
}

export function versionFromRun(result: CloudflaredRun): string | null {
  if (result.error || result.status !== 0) return null
  return parseCloudflaredVersion(`${result.stdout || ''}\n${result.stderr || ''}`)
}

export function readCloudflaredVersion(): string | null {
  const result = spawnSync('cloudflared', ['--version'], { encoding: 'utf8', timeout: 15_000 })
  return versionFromRun({
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    error: result.error,
  })
}

export function updateCloudflared(): { ok: boolean; message: string } {
  const result = spawnSync('cloudflared', ['update'], { encoding: 'utf8', timeout: UPDATE_TIMEOUT_MS })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  if (!result.error && result.status === 0) {
    return { ok: true, message: output || 'cloudflared actualizado' }
  }
  if (/homebrew|brew/i.test(output)) {
    const brew = spawnSync('brew', ['upgrade', 'cloudflared'], { encoding: 'utf8', timeout: UPDATE_TIMEOUT_MS })
    const brewOut = `${brew.stdout || ''}\n${brew.stderr || ''}`.trim()
    if (!brew.error && brew.status === 0) {
      return { ok: true, message: brewOut || 'cloudflared actualizado con brew' }
    }
    return { ok: false, message: brewOut || output || 'No se pudo actualizar cloudflared' }
  }
  return { ok: false, message: output || result.error?.message || 'No se pudo actualizar cloudflared' }
}
