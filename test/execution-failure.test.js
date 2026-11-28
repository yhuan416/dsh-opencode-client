import test from 'node:test'
import assert from 'node:assert/strict'

import { remoteFailure } from '../lib/delegate.js'

test('a failed execution names its error and keeps the payload', () => {
  const error = remoteFailure({
    outcome: 'failed',
    error: { name: 'ProviderAuthError', message: 'invalid api key', data: { code: 'provider_auth', provider: 'qwen' } },
  })
  assert.equal(error.message, 'opencode: remote session failed (ProviderAuthError): invalid api key')
  assert.equal(error.code, 'provider_auth')
  assert.equal(error.opencodeName, 'ProviderAuthError')
  assert.deepEqual(error.data, { code: 'provider_auth', provider: 'qwen' })
})

test('a failure without a named error still produces an actionable line', () => {
  const error = remoteFailure({ outcome: 'failed' })
  assert.equal(error.message, 'opencode: remote session failed (OpenCodeError)')
  assert.equal(error.code, 'opencode.execution_failed')
  assert.equal(error.opencodeName, 'OpenCodeError')
  assert.equal(error.data, undefined)
})

test('a string failure payload is used as the message', () => {
  const error = remoteFailure({ error: 'tool crashed' })
  assert.match(error.message, /tool crashed/)
})

test('a long failure message is truncated', () => {
  const error = remoteFailure({ error: { name: 'X', message: 'y'.repeat(2000) } })
  assert.ok(error.message.length < 520)
  assert.ok(error.message.endsWith('…'))
})