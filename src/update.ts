import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** No repetir el mismo intento fallido en cada latido: el backend puede pedir una versión que aún no está publicada. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000

export interface UpdateState {
  target: string
  attemptedAt: number
}

export function parseVersion(value?: string | null): [number, number, number] | null {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
}

export function isNewerVersion(candidate?: string | null, current?: string | null): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let index = 0; index < 3; index += 1) {
    if (a[index] === b[index]) continue
    return a[index] > b[index]
  }
  return false
}

export function shouldAttemptUpdate(
  target: string,
  current: string,
  state: UpdateState | undefined,
  now = Date.now(),
): boolean {
  if (!isNewerVersion(target, current)) return false
  if (!state || state.target !== target) return true
  return now - state.attemptedAt >= RETRY_AFTER_MS
}

/** El agente corre desde `dist/index.js`, así que su repositorio es el directorio padre. */
export function installRoot(moduleUrl: string): string {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)))
}

export interface UpdateOutcome {
  ok: boolean
  message: string
}

/** `npm install` reescribe el lockfile, así que ese cambio no es trabajo de nadie. */
export const REGENERATED_FILES = ['package-lock.json']

export function changedFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.trim().length > 0)
    // Formato `XY ruta`, y `XY origen -> destino` en los renombrados. El primer
    // hueco del estado puede venir recortado, así que no se corta por posición.
    .map((line) => line.replace(/^\s?\S{1,2}\s+/, '').split(' -> ').pop()!.trim())
    .filter((file) => file.length > 0)
}

function run(command: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (result.error) return { ok: false, output: result.error.message }
  return { ok: result.status === 0, output }
}

/**
 * Actualiza la copia local desde git y la recompila. No reinicia nada: si la
 * compilación falla, el `dist` anterior sigue en pie y el agente puede seguir.
 */
export function updateInstallation(root: string, log: (line: string) => void): UpdateOutcome {
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], root)
  if (!inside.ok) {
    return { ok: false, message: `${root} no es un repositorio git; actualízalo como lo instalaste.` }
  }

  const dirty = run('git', ['status', '--porcelain'], root)
  if (dirty.ok && dirty.output) {
    const changed = changedFiles(dirty.output)
    const blocking = changed.filter((file) => !REGENERATED_FILES.includes(file))
    if (blocking.length > 0) {
      return {
        ok: false,
        message: `Hay cambios locales sin guardar (${blocking.slice(0, 3).join(', ')}); actualiza a mano para no perderlos.`,
      }
    }
    // Sin descartarlos, el lockfile que npm acaba de reescribir choca con el
    // siguiente pull y la actualización automática no volvería a funcionar.
    const regenerated = changed.filter((file) => REGENERATED_FILES.includes(file))
    if (regenerated.length > 0) {
      log(`Descartando cambios de npm en ${regenerated.join(', ')}`)
      run('git', ['checkout', '--', ...regenerated], root)
    }
  }

  for (const [command, args] of [
    ['git', ['pull', '--ff-only']],
    ['npm', ['install', '--no-audit', '--no-fund']],
    ['npm', ['run', 'build']],
  ] as const) {
    log(`Actualizando: ${command} ${args.join(' ')}`)
    const step = run(command, [...args], root)
    if (!step.ok) {
      return { ok: false, message: `Falló ${command} ${args.join(' ')}: ${step.output.slice(-500)}` }
    }
  }

  return { ok: true, message: 'Actualización aplicada.' }
}
