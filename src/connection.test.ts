import assert from 'node:assert/strict'
import test from 'node:test'
import { describeRequestFailure, httpFailureMessage, REQUEST_TIMEOUT_MS } from './connection.js'

test('describeRequestFailure distingue timeout, DNS y rechazo', () => {
  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  assert.equal(
    describeRequestFailure(timeout, '/api/remote-agent/heartbeat'),
    `Dockploy no respondió a /api/remote-agent/heartbeat en ${REQUEST_TIMEOUT_MS / 1000} s`,
  )

  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })
  assert.match(describeRequestFailure(dns, '/api/remote-agent/heartbeat'), /ENOTFOUND/)
  assert.match(describeRequestFailure(dns, '/api/remote-agent/heartbeat'), /no se pudo resolver/)

  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
  assert.match(describeRequestFailure(refused, '/health'), /rechazó la conexión/)
})

test('httpFailureMessage conserva el texto que dispara la renovación del token', () => {
  assert.match(httpFailureMessage(401, '/api/remote-agent/heartbeat', 'Invalid connector token'), /Invalid connector token/)
  assert.match(httpFailureMessage(429, '/api/remote-agent/heartbeat'), /429/)
  assert.match(httpFailureMessage(502, '/api/remote-agent/heartbeat', 'bad gateway'), /502/)
})
