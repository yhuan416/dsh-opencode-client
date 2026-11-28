import test from 'node:test'
import assert from 'node:assert/strict'

import { createLedger, statusOf } from '../lib/ledger.js'

test('statusOf maps dsh stop reasons onto ledger statuses', () => {
  assert.equal(statusOf('completed'), 'ok')
  assert.equal(statusOf('aborted'), 'aborted')
  assert.equal(statusOf('error'), 'failed')
  assert.equal(statusOf('max-tokens'), 'failed')
  assert.equal(statusOf('refusal'), 'failed')
  assert.equal(statusOf(undefined), 'ok')
})

test('a run opens as running and closes with duration and status', () => {
  const ledger = createLedger()
  const row = ledger.begin({ kind: 'subagent', server: 'a', task: 'fix the bug', label: 'task' })
  assert.equal(row.status, 'running')
  assert.equal(row.endedAt, null)
  assert.equal(row.durationMs, null)
  assert.equal(row.task, 'fix the bug')

  ledger.attach(row, 'ses_1')
  const closed = ledger.finish(row, { stopReason: 'completed' })
  assert.equal(closed.sessionId, 'ses_1')
  assert.equal(closed.status, 'ok')
  assert.equal(closed.stopReason, 'completed')
  assert.equal(typeof closed.durationMs, 'number')
  assert.ok(closed.durationMs >= 0)
})

test('a failed run keeps the error text and a second finish is a no-op', () => {
  const ledger = createLedger()
  const row = ledger.begin({ server: 'a' })
  ledger.finish(row, { stopReason: 'error', error: new Error('opencode: 401') })
  assert.equal(row.status, 'failed')
  assert.equal(row.error, 'opencode: 401')
  const endedAt = row.endedAt
  ledger.finish(row, { stopReason: 'completed' })
  assert.equal(row.status, 'failed', 'a settled row is not overwritten')
  assert.equal(row.endedAt, endedAt)
})

test('list returns newest first and honours limit, server and status filters', () => {
  const ledger = createLedger()
  const first = ledger.begin({ server: 'a', task: 'one' })
  ledger.finish(first, { stopReason: 'completed' })
  const second = ledger.begin({ server: 'b', task: 'two' })
  ledger.finish(second, { stopReason: 'error', error: 'boom' })
  const third = ledger.begin({ server: 'a', task: 'three' })

  const all = ledger.list()
  assert.deepEqual(all.rows.map((row) => row.task), ['three', 'two', 'one'])
  assert.equal(all.summary.total, 3)
  assert.equal(all.summary.running, 1)
  assert.equal(all.summary.ok, 1)
  assert.equal(all.summary.failed, 1)

  const onlyB = ledger.list({ server: 'b' })
  assert.deepEqual(onlyB.rows.map((row) => row.task), ['two'])
  assert.equal(onlyB.summary.total, 1)

  const onlyFailed = ledger.list({ status: 'failed' })
  assert.deepEqual(onlyFailed.rows.map((row) => row.task), ['two'])

  assert.equal(ledger.list({ limit: 2 }).rows.length, 2)
  assert.equal(ledger.list({ limit: 2 }).summary.total, 3, 'limit caps rows, not the summary')
})

test('summary groups by server with failure counts and average duration', () => {
  const ledger = createLedger()
  for (const server of ['a', 'a', 'b']) {
    const row = ledger.begin({ server: server })
    ledger.finish(row, { stopReason: server === 'b' ? 'error' : 'completed' })
  }
  const { summary } = ledger.list()
  const a = summary.byServer.find((bucket) => bucket.server === 'a')
  const b = summary.byServer.find((bucket) => bucket.server === 'b')
  assert.equal(a.total, 2)
  assert.equal(a.failed, 0)
  assert.equal(typeof a.avgMs, 'number')
  assert.equal(b.total, 1)
  assert.equal(b.failed, 1)
})

test('the ledger is bounded and drops the oldest rows', () => {
  const ledger = createLedger({ max: 3 })
  for (let index = 0; index < 5; index += 1) ledger.begin({ server: 'a', task: 'task ' + index })
  assert.equal(ledger.size(), 3)
  assert.deepEqual(ledger.list().rows.map((row) => row.task), ['task 4', 'task 3', 'task 2'])
})

test('long task and error text is truncated instead of bloating the payload', () => {
  const ledger = createLedger()
  const row = ledger.begin({ server: 'a', task: 'x'.repeat(1000) })
  assert.ok(row.task.length <= 241)
  assert.ok(row.task.endsWith('…'))
  ledger.finish(row, { stopReason: 'error', error: 'y'.repeat(1000) })
  assert.ok(row.error.length <= 501)
})

test('clear empties the ledger and keeps it usable', () => {
  const ledger = createLedger()
  ledger.begin({ server: 'a' })
  ledger.clear()
  assert.equal(ledger.size(), 0)
  const empty = ledger.list()
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(
    { total: empty.summary.total, running: empty.summary.running, ok: empty.summary.ok, failed: empty.summary.failed, aborted: empty.summary.aborted, steps: empty.summary.steps, cost: empty.summary.cost, byServer: empty.summary.byServer },
    { total: 0, running: 0, ok: 0, failed: 0, aborted: 0, steps: 0, cost: 0, byServer: [] },
  )
  const row = ledger.begin({ server: 'a', kind: 'delegate' })
  assert.equal(row.kind, 'delegate')
  assert.equal(ledger.size(), 1)
})

test('a failed row keeps the error identity, not just the message', () => {
  const ledger = createLedger()
  const row = ledger.begin({ server: 'a' })
  const error = new Error('opencode: remote session failed (ProviderAuthError): invalid api key')
  error.name = 'OpenCodeError'
  error.code = 'provider_auth'
  error.opencodeName = 'ProviderAuthError'
  ledger.finish(row, { stopReason: 'error', error })
  assert.equal(row.status, 'failed')
  assert.equal(row.errorName, 'ProviderAuthError')
  assert.equal(row.errorCode, 'provider_auth')
  assert.match(row.error, /invalid api key/)
  const listed = ledger.list().rows[0]
  assert.equal(listed.errorName, 'ProviderAuthError', 'the identity survives list()')
})

test('usage is recorded as the delta between a run start and its settle', () => {
  const ledger = createLedger()
  const before = { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: 0 }
  const row = ledger.begin({ server: 'a', task: 'costed run', parent: 'ses_parent', usage: before })
  assert.equal(row.parent, 'ses_parent')
  const after = { tokens: { input: 900, output: 120, reasoning: 30, cacheRead: 400, cacheWrite: 0 }, cost: 0.42, steps: 3 }
  ledger.finish(row, { stopReason: 'completed', usage: after })
  assert.equal(row.steps, 3)
  assert.equal(row.cost, 0.42)
  assert.equal(row.tokens.input, 900)
  assert.equal(row.tokens.cacheRead, 400)
  const listed = ledger.list()
  assert.equal(listed.summary.steps, 3)
  assert.ok(Math.abs(listed.summary.cost - 0.42) < 1e-9)
  assert.ok(Math.abs(listed.summary.byServer[0].cost - 0.42) < 1e-9)
})

test('a run that reported no steps keeps tokens/cost empty instead of zeroes', () => {
  const ledger = createLedger()
  const zero = { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, steps: 0 }
  const row = ledger.begin({ server: 'a', usage: zero })
  ledger.finish(row, { stopReason: 'completed', usage: zero })
  assert.equal(row.tokens, null)
  assert.equal(row.cost, null)
})
