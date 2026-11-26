/**
 * Unit tests for the observation registry (lib/observation.js): status
 * precedence, snapshot/increment merging, ghost clearing, child folding and
 * staleness.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createObservation, observationKey, describePending } from '../lib/observation.js'

function clock(start) {
  let value = start === undefined ? 1000 : start
  return {
    now: function () { return value },
    advance: function (ms) { value += ms; return value },
  }
}

test('a session is unknown until a source establishes something', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1', title: 'work' })
  assert.equal(observation.rows('n100')[0].status, 'unknown')
})

test('running snapshot seeds running and idle, a failed snapshot does not reset', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeIdentity('n100', { id: 'ses_2' })
  observation.observeRunning('n100', new Set(['ses_1']), true)
  const byId = new Map(observation.rows('n100').map(function (row) { return [row.sessionId, row.status] }))
  assert.equal(byId.get('ses_1'), 'running')
  assert.equal(byId.get('ses_2'), 'idle')

  observation.observeRunning('n100', new Set(), false)
  const after = new Map(observation.rows('n100').map(function (row) { return [row.sessionId, row.status] }))
  assert.equal(after.get('ses_1'), 'running', 'failed snapshot must not declare idle')
})

test('a pending request outranks running, and a reply clears it', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeRunning('n100', new Set(['ses_1']), true)
  observation.observeEvent('n100', { kind: 'permission.asked', sessionId: 'ses_1', at: c.now(), data: { id: 'req_1', action: 'bash', resources: ['rm -rf /tmp/x'] } })
  const waiting = observation.rows('n100')[0]
  assert.equal(waiting.status, 'waiting-permission')
  assert.equal(waiting.pending.requestId, 'req_1')
  assert.match(waiting.pending.detail, /bash/)
  assert.match(waiting.pending.detail, /rm -rf/)

  observation.observeEvent('n100', { kind: 'permission.replied', sessionId: 'ses_1', at: c.now(), data: { requestID: 'req_1' } })
  assert.equal(observation.rows('n100')[0].status, 'running')
})

test('a form outranks a permission and a pending snapshot clears ghosts', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeRunning('n100', new Set(['ses_1']), true)
  observation.markPending('n100', 'ses_1', { kind: 'permission', requestId: 'p1', detail: 'bash' })
  assert.equal(observation.rows('n100')[0].status, 'waiting-permission')

  // The snapshot no longer lists p1: it was answered elsewhere, drop it.
  observation.observePendingSnapshot('n100', [{ sessionId: 'ses_1', kind: 'form', requestId: 'f1', detail: 'pick a branch' }])
  const row = observation.rows('n100')[0]
  assert.equal(row.status, 'waiting-question')
  assert.equal(row.pending.requestId, 'f1')
})

test('a failed run becomes error; a new run clears it', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeEvent('n100', { kind: 'run.finished', sessionId: 'ses_1', at: c.now(), data: { outcome: 'failed' } })
  assert.equal(observation.rows('n100')[0].status, 'error')
  observation.observeEvent('n100', { kind: 'run.started', sessionId: 'ses_1', at: c.now(), data: {} })
  assert.equal(observation.rows('n100')[0].status, 'running')
})

test('deleted sessions leave the registry', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeEvent('n100', { kind: 'session.deleted', sessionId: 'ses_1', at: c.now(), data: {} })
  assert.equal(observation.rows('n100').length, 0)
})

test('child sessions fold into their parent instead of adding rows', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_parent', title: 'parent' })
  observation.observeIdentity('n100', { id: 'ses_child1', title: 'c1', parentID: 'ses_parent' })
  observation.observeIdentity('n100', { id: 'ses_child2', title: 'c2', parentID: 'ses_parent' })
  observation.observeRunning('n100', new Set(['ses_parent', 'ses_child1', 'ses_child2']), true)
  const board = observation.board()
  const total = board.needsMe.length + board.running.length + board.idle.length + board.unknown.length
  assert.equal(total, 1, 'only the parent gets a row')
  const parent = board.running[0]
  assert.equal(parent.sessionId, 'ses_parent')
  assert.equal(parent.childCount, 2)
  assert.equal(parent.childRunning, 2)
  assert.equal(observationKey('n100', 'ses_parent'), 'n100\u0000ses_parent')
})

test('an orphan child keeps its own row', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_child', parentID: 'ses_missing' })
  observation.observeRunning('n100', new Set(['ses_child']), true)
  assert.equal(observation.board().running.length, 1)
})

test('running without events goes stale but never idle', function () {
  const c = clock(0)
  const observation = createObservation({ now: c.now, staleAfterMs: 90000 })
  observation.observeIdentity('n100', { id: 'ses_1' })
  observation.observeRunning('n100', new Set(['ses_1']), true)
  c.advance(120000)
  const row = observation.rows('n100')[0]
  assert.equal(row.status, 'running')
  assert.equal(row.stale, true)
})

test('needs-me sorts oldest wait first, idle is capped and counted', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_a', title: 'a' })
  observation.observeIdentity('n100', { id: 'ses_b', title: 'b' })
  observation.markPending('n100', 'ses_a', { kind: 'permission', requestId: 'pa', detail: 'x', at: 2000 })
  observation.markPending('n100', 'ses_b', { kind: 'permission', requestId: 'pb', detail: 'y', at: 1000 })
  const board = observation.board({ idleLimit: 1 })
  assert.equal(board.needsMe.length, 2)
  assert.equal(board.needsMe[0].sessionId, 'ses_b', 'oldest wait comes first')
  observation.observeIdentity('n100', { id: 'ses_c' })
  observation.observeRunning('n100', new Set(), true)
  const capped = observation.board({ idleLimit: 1 })
  // ses_a and ses_b still wait for an answer; only ses_c is idle.
  assert.equal(capped.needsMe.length, 2)
  assert.equal(capped.idle.length, 1)
  assert.equal(capped.idleCount, 1)
})

test('describePending keeps permission and form readable', function () {
  assert.equal(describePending('permission', { action: 'bash', resources: ['a', 'b'] }), 'bash (a, b)')
  assert.equal(describePending('permission', {}), 'permission')
  assert.equal(describePending('form', { form: { questions: [{ text: 'which branch?' }] } }), 'form: which branch?')
})