import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export async function chromiumExecutablePath(): Promise<string> {
  const { chromium } = await import('playwright')
  return chromium.executablePath()
}

export async function isChromiumReady(): Promise<boolean> {
  try {
    const executable = await chromiumExecutablePath()
    await access(executable)
    return true
  } catch {
    return false
  }
}

export async function installChromium(onLog?: (line: string) => void): Promise<void> {
  const cli = require.resolve('playwright/cli')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const handle = (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) onLog?.(text)
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`playwright install chromium terminó con código ${code ?? 'desconocido'}`))
    })
  })
  if (!await isChromiumReady()) {
    throw new Error('Chromium se instaló pero no está disponible')
  }
}
