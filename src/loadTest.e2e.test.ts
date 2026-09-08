import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import test from 'node:test'
import { runLoadTest } from './loadTest.js'

test('Playwright captura carga inicial y el clic contra un servidor local', async (t) => {
  let executable = ''
  try {
    const { chromium } = await import('playwright')
    executable = chromium.executablePath()
    await access(executable)
  } catch {
    t.skip('Chromium no está instalado en esta máquina')
    return
  }

  const server = createServer((request, response) => {
    if (request.url === '/click') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<html><body><button id="go">Go</button><script>document.getElementById("go").onclick=()=>fetch("/click")</script></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const targetUrl = `http://127.0.0.1:${address.port}/`
  try {
    const abort = new AbortController()
    const result = await runLoadTest({
      action: 'start-load-test',
      runId: 'test',
      targetUrl,
      scenario: { steps: [{ type: 'click', selector: '#go' }] },
      virtualUsers: 1,
      concurrency: 1,
      navigationTimeoutMs: 15_000,
      afterClickTimeoutMs: 5_000,
    }, {
      signal: abort.signal,
      onProgress: async () => undefined,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.users[0]?.status, 'passed')
    const phases = new Set(result.users[0]?.requests.map((request) => request.phase))
    assert.equal(phases.has('initial-load'), true)
    assert.equal(result.users[0]?.requests.some((request) => request.path === '/click'), true)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
