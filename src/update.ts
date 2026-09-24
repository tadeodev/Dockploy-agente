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

/** `npm ci` reescribe el lockfile, así que ese cambio no es trabajo de nadie. */
export const REGENERATED_FILES = ['package-lock.json']

/** El código que se ejecuta solo puede salir de este repositorio. */
export const OFFICIAL_REPOSITORY = 'tadeodev/Dockploy-agente'
const GITHUB_MAIN_COMMIT = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/commits/main`

export function isOfficialRemote(url: string): boolean {
  const normalized = url.trim().replace(/\.git$/, '').replace(/\/$/, '')
  return normalized === `https://github.com/${OFFICIAL_REPOSITORY}`
    || normalized === `git@github.com:${OFFICIAL_REPOSITORY}`
    || normalized === `ssh://git@github.com/${OFFICIAL_REPOSITORY}`
}

export interface RemoteCommit {
  sha: string
  verified: boolean
}

/**
 * Cambios sin subir, o commits que no están en el main firmado, no pueden
 * arrancar: esa copia no es la que está publicada.
 */
export function localInstallBlockReason(input: {
  porcelain: string
  head: string
  officialSha: string
  ancestor: boolean
}): string | undefined {
  const changed = changedFiles(input.porcelain)
  if (changed.length > 0) {
    return `Hay cambios locales sin subir (${changed.slice(0, 3).join(', ')}). El agente no arranca con código modificado.`
  }
  const head = input.head.trim().toLowerCase()
  const official = input.officialSha.trim().toLowerCase()
  if (!head || !official) return 'No se pudo comprobar que esta copia es la publicada.'
  if (head === official || input.ancestor) return undefined
  return 'Esta copia tiene commits que no están en main. El agente no arranca con código sin publicar.'
}

/** El commit descargado tiene que ser exactamente el que GitHub firma en main. */
export function commitIsTrusted(fetchedSha: string, remote?: RemoteCommit | null): boolean {
  if (!remote?.verified || !remote.sha) return false
  return fetchedSha.trim().toLowerCase() === remote.sha.trim().toLowerCase()
}

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

async function githubMainCommit(): Promise<RemoteCommit | undefined> {
  let response: Response
  try {
    response = await fetch(GITHUB_MAIN_COMMIT, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dockploy-agent',
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const body = await response.json().catch(() => null) as {
    sha?: string
    commit?: { verification?: { verified?: boolean } }
  } | null
  if (!body?.sha) return undefined
  return { sha: body.sha, verified: body.commit?.verification?.verified === true }
}

/** Niega el arranque si la copia local no es el main firmado del repositorio oficial. */
export async function publishedInstallationProblem(root: string): Promise<string | undefined> {
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], root)
  if (!inside.ok) return `${root} no es un repositorio git.`

  const origin = run('git', ['remote', 'get-url', 'origin'], root)
  if (!origin.ok || !isOfficialRemote(origin.output)) {
    return 'El remoto no es github.com/tadeodev/Dockploy-agente.'
  }

  const dirty = run('git', ['status', '--porcelain'], root)
  if (!dirty.ok) return 'No se pudo comprobar si hay cambios locales.'
  const head = run('git', ['rev-parse', 'HEAD'], root)
  if (!head.ok) return 'No se pudo leer el commit local.'

  const fetched = run('git', ['fetch', 'origin', 'main'], root)
  if (!fetched.ok) return 'No se pudo comprobar main en el repositorio oficial.'
  const remote = await githubMainCommit()
  if (!commitIsTrusted(run('git', ['rev-parse', 'FETCH_HEAD'], root).output, remote)) {
    return 'No se pudo comprobar en GitHub que main está firmado.'
  }

  const ancestor = run('git', ['merge-base', '--is-ancestor', head.output.trim(), remote!.sha], root)
  return localInstallBlockReason({
    porcelain: dirty.output,
    head: head.output,
    officialSha: remote!.sha,
    ancestor: ancestor.ok,
  })
}

/**
 * Actualiza la copia local desde git y la recompila. No reinicia nada: si la
 * compilación falla, el `dist` anterior sigue en pie y el agente puede seguir.
 * Solo instala el commit que GitHub tiene firmado en main del repositorio oficial.
 */
export async function updateInstallation(root: string, log: (line: string) => void): Promise<UpdateOutcome> {
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

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (!branch.ok || branch.output.trim() !== 'main') {
    return { ok: false, message: 'El agente solo se actualiza desde la rama main del repositorio oficial.' }
  }

  const origin = run('git', ['remote', 'get-url', 'origin'], root)
  if (!origin.ok || !isOfficialRemote(origin.output)) {
    return { ok: false, message: 'El remoto no es github.com/tadeodev/Dockploy-agente; no se actualiza.' }
  }

  log('Actualizando: git fetch origin main')
  const fetched = run('git', ['fetch', 'origin', 'main'], root)
  if (!fetched.ok) {
    return { ok: false, message: `Falló git fetch origin main: ${fetched.output.slice(-500)}` }
  }

  const fetchedSha = run('git', ['rev-parse', 'FETCH_HEAD'], root)
  if (!fetchedSha.ok) {
    return { ok: false, message: 'No se pudo leer el commit descargado.' }
  }

  const remote = await githubMainCommit()
  if (!remote) {
    return { ok: false, message: 'No se pudo comprobar en GitHub que el commit está firmado; no se instala.' }
  }
  if (!commitIsTrusted(fetchedSha.output, remote)) {
    return {
      ok: false,
      message: 'El commit descargado no es el que GitHub firma en main; no se instala.',
    }
  }

  for (const [command, args] of [
    ['git', ['merge', '--ff-only', 'FETCH_HEAD']],
    ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']],
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
