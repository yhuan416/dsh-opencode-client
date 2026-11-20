/**
 * Subagent-provider mapping tests: OpenCode's `finish`/`error` must survive
 * extraction and land on dsh's `SubagentResult.stopReason` (completed /
 * aborted / max-tokens / refusal / error).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopReasonFor } from '../lib/provider.js'
import { extractAssistant } from '../lib/delegate.js'

test('extractAssistant keeps finish and error from v1 and v2 messages', function () {
  const v2 = extractAssistant({ type: 'assistant', finish: 'length', content: [{ type: 'text', text: 'partial' }] })
  assert.equal(v2.text, 'partial')
  assert.equal(v2.finish, 'length')

  const v2Error = extractAssistant({ type: 'assistant', finish: 'error', error: { message: 'boom' }, content: [] })
  assert.equal(v2Error.finish, 'error')
  assert.deepEqual(v2Error.error, { message: 'boom' })

  const v1 = extractAssistant({ info: { role: 'assistant', finish: 'content-filter' }, parts: [{ type: 'text', text: 'no' }] })
  assert.equal(v1.finish, 'content-filter')

  const empty = extractAssistant(undefined)
  assert.deepEqual(empty, { text: '', structured: undefined, finish: undefined, error: undefined })
})

test('stopReasonFor maps OpenCode finish reasons onto dsh stop reasons', function () {
  assert.equal(stopReasonFor({ finish: 'stop' }, false), 'completed')
  assert.equal(stopReasonFor({ finish: 'tool-calls' }, false), 'completed')
  assert.equal(stopReasonFor({ finish: 'length' }, false), 'max-tokens')
  assert.equal(stopReasonFor({ finish: 'content-filter' }, false), 'refusal')
  assert.equal(stopReasonFor({ finish: 'error' }, false), 'error')
  assert.equal(stopReasonFor({ finish: 'unknown' }, false), 'completed')
  assert.equal(stopReasonFor({}, false), 'completed')
  assert.equal(stopReasonFor({ error: { message: 'failed' } }, false), 'error')
  // Cancellation wins over any finish reason the remote reported.
  assert.equal(stopReasonFor({ finish: 'length' }, true), 'aborted')
  assert.equal(stopReasonFor(undefined, false), 'completed')
})