import assert from 'node:assert/strict'
import test from 'node:test'
import { mapPool, recommendedConcurrency } from './capacity.js'
import { buildTimeline } from './loadTest.js'
import { looksLikeCssSelector, normalizeScenario, parseClickTarget } from './loadTestTypes.js'
import type { VirtualUserResult } from './loadTestTypes.js'

test('recommendedConcurrency se acota a CPU, memoria y 25', () => {
  assert.equal(recommendedConcurrency({ cpus: 8, freeMem: 16 * 1024 * 1024 * 1024 }), 21)
  assert.equal(recommendedConcurrency({ cpus: 2, freeMem: 512 * 1024 * 1024 }), 2)
  assert.equal(recommendedConcurrency({ cpus: 1, freeMem: 128 * 1024 * 1024 }), 1)
})

test('mapPool respeta la concurrencia y conserva el orden', async () => {
  let peak = 0
  let current = 0
  const result = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
    current += 1
    peak = Math.max(peak, current)
    await new Promise((resolve) => setTimeout(resolve, 20))
    current -= 1
    return value * 10
  })
  assert.deepEqual(result, [10, 20, 30, 40, 50])
  assert.equal(peak, 2)
})

test('normalizeScenario acepta clic por texto o selector', () => {
  assert.deepEqual(normalizeScenario({ text: 'Entrar' }), { steps: [{ type: 'click', text: 'Entrar' }] })
  assert.deepEqual(normalizeScenario({ selector: '#login' }), { steps: [{ type: 'click', selector: '#login' }] })
  const advanced = normalizeScenario({
    steps: [
      { type: 'fill', selector: '#email', value: 'ana@test.com' },
      { type: 'click', text: 'Enviar' },
    ],
  })
  assert.equal(advanced.steps.length, 2)
})

test('parseClickTarget y CSS heurístico', () => {
  assert.deepEqual(parseClickTarget({ type: 'click', selector: 'button.primary' }), { kind: 'css', value: 'button.primary' })
  assert.deepEqual(parseClickTarget({ type: 'click', text: 'Comprar' }), { kind: 'text', value: 'Comprar' })
  assert.equal(looksLikeCssSelector('#submit'), true)
  assert.equal(looksLikeCssSelector('Comprar ahora'), false)
})

test('buildTimeline agrupa peticiones por segundo', () => {
  const origin = Date.parse('2026-09-07T12:00:00.000Z')
  const users: VirtualUserResult[] = [{
    userIndex: 1,
    status: 'passed',
    startedAt: '2026-09-07T12:00:00.000Z',
    finishedAt: '2026-09-07T12:00:02.000Z',
    durationMs: 2000,
    requestCount: 2,
    errorCount: 1,
    bytes: 10,
    requests: [
      {
        method: 'GET',
        url: 'https://app.example/a',
        domain: 'app.example',
        path: '/a',
        resourceType: 'document',
        status: 200,
        bytes: 4,
        durationMs: 40,
        startedAt: '2026-09-07T12:00:00.200Z',
        phase: 'initial-load',
      },
      {
        method: 'POST',
        url: 'https://app.example/b',
        domain: 'app.example',
        path: '/b',
        resourceType: 'xhr',
        status: 500,
        bytes: 6,
        durationMs: 80,
        startedAt: '2026-09-07T12:00:01.100Z',
        phase: 'after-click',
        error: 'server',
      },
    ],
  }]
  const timeline = buildTimeline(users, origin)
  assert.equal(timeline[0]?.t, 0)
  assert.equal(timeline[0]?.requests, 1)
  assert.equal(timeline[1]?.errors, 1)
})
