import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudflaredBlockReason, cloudflaredIsOlder, parseCloudflaredVersion, versionFromRun } from './cloudflared.js'

test('lee la versión aunque cloudflared la escriba en stderr', () => {
  assert.equal(parseCloudflaredVersion('cloudflared version 2025.8.1 (built 2025-08-01)'), '2025.8.1')
  assert.equal(versionFromRun({ status: 0, stderr: 'cloudflared version 2025.8.1' }), '2025.8.1')
  assert.equal(versionFromRun({ status: 1, stdout: 'cloudflared version 2025.8.1' }), null)
})

test('una versión anterior bloquea el túnel', () => {
  assert.equal(cloudflaredIsOlder('2025.8.1', '2025.8.2'), true)
  assert.equal(cloudflaredIsOlder('2024.12.2', '2025.1.0'), true)
  assert.equal(cloudflaredIsOlder('2025.8.2', '2025.8.2'), false)
  assert.equal(cloudflaredIsOlder('2025.8.2', undefined), false)
  assert.equal(cloudflaredIsOlder(undefined, '2025.8.2'), true)
  assert.match(cloudflaredBlockReason('2025.8.1', '2025.8.2') || '', /cloudflared update/)
  assert.equal(cloudflaredBlockReason('2025.8.2', '2025.8.2'), null)
})
