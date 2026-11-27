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
  // v2 forms carry the question in fields[].description; title is just the dock
  // header ("Questions") and must not be preferred over the real text.
  assert.equal(
    describePending('form', { form: { title: 'Questions', fields: [{ key: 'q0', title: '继续吗', type: 'string', description: 'state-test：是否继续？' }] } }),
    'form: state-test：是否继续？',
  )
  assert.equal(describePending('form', { form: { title: 'Questions', fields: [{ key: 'q0', title: '继续吗', type: 'string' }] } }), 'form: 继续吗')
  assert.equal(describePending('form', { form: { title: 'Questions', fields: [] } }), 'form: Questions')
  // Hidden fields and headers must not shadow the real question.
  assert.equal(
    describePending('form', { form: { title: 'Questions', fields: [
      { key: 'q0', type: 'string', hidden: true, description: 'internal hidden text' },
      { key: 'q1', type: 'string', title: 'Short header' },
      { key: 'q2', type: 'string', description: 'real question' },
    ] } }),
    'form: real question',
  )
})

test('retain drops rows missing from a fresh listing but keeps listed and newer ones', function () {
  const observation = createObservation()
  observation.observeIdentity('n100', { id: 'ses_live', title: 'live' })
  observation.observeIdentity('n100', { id: 'ses_gone', title: 'deleted while the stream was down' })
  observation.observeIdentity('e5', { id: 'ses_other', title: 'other server' })
  observation.observeRunning('n100', new Set(), true)
  observation.observeRunning('e5', new Set(), true)
  // A deletion event was missed: the stale row is still on the board.
  assert.equal(observation.board().idleCount, 3)
  const removed = observation.retain('n100', ['ses_live'])
  assert.equal(removed, 1)
  const board = observation.board()
  assert.equal(board.idleCount, 2)
  assert.deepEqual(board.idle.map(function (row) { return row.sessionId }).sort(), ['ses_live', 'ses_other'])
  assert.equal(observation.retain('n100', ['ses_live']), 0, 'idempotent')
})

test('retain protects sessions the event stream announced after the request started', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('n100', { id: 'ses_old', title: 'listed before' })
  c.advance(1000)
  const since = c.now()
  // A session created after the list request started: the listing cannot know it
  // yet, so pruning it would fight the event stream.
  c.advance(1000)
  observation.observeEvent('n100', { kind: 'session.created', sessionId: 'ses_new', at: 9999, data: {} })
  observation.observeRunning('n100', new Set(), true)
  assert.equal(observation.retain('n100', [], { since: since }), 1)
  const rows = observation.rows('n100')
  assert.deepEqual(rows.map(function (row) { return row.sessionId }), ['ses_new'])
  // Without the protection the same row would go.
  assert.equal(observation.retain('n100', [], {}), 1)
})

test('retain on a truncated listing only prunes rows below the page boundary', function () {
  const observation = createObservation()
  observation.observeIdentity('n100', { id: 'ses_very_old', title: 'old', updatedAt: 100 })
  observation.observeIdentity('n100', { id: 'ses_page_edge', title: 'edge', updatedAt: 900 })
  observation.observeRunning('n100', new Set(), true)
  // The page only returned ses_page_edge; rows older than its oldest row are
  // provably deleted, rows whose age is unproven are kept.
  assert.equal(observation.retain('n100', ['ses_page_edge'], { olderThan: 500 }), 1)
  assert.deepEqual(observation.board().idle.map(function (row) { return row.sessionId }), ['ses_page_edge'])
  assert.equal(observation.retain('n100', ['ses_page_edge'], { olderThan: 50 }), 0)
})
test('finished-but-unread stays out of idle until viewed', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  // OpenCode records the run boundaries and the read marker on the session.
  observation.observeIdentity('e5', { id: 'ses_done', title: 'done', busyAt: 1000, idleAt: 2000, outcome: 'succeeded' })
  // The reminder is armed by the finish we actually watched, not by the marker:
  // a never-viewed session has no `viewed` at all (measured on 2.3.0).
  observation.observeRunning('e5', new Set(['ses_done']), true)
  observation.observeRunning('e5', new Set(), true)
  const before = observation.board()
  assert.equal(before.unseen.length, 1)
  assert.equal(before.unseen[0].sessionId, 'ses_done')
  assert.equal(before.unseen[0].unread, true)
  assert.equal(before.unseen[0].runMs, 1000, 'duration comes from busy→idle')
  assert.equal(before.idle.length, 0, 'never in both partitions')
  assert.equal(before.idleCount, 0)

  // Viewing it on the remote pushes `viewed` up to `idle`: it becomes plain idle.
  observation.observeIdentity('e5', { id: 'ses_done', viewedAt: 2000 })
  const after = observation.board()
  assert.equal(after.unseen.length, 0)
  assert.equal(after.unseenCount, 0)
  assert.equal(after.idle.length, 1)
  assert.equal(after.idle[0].unread, false)
})

test('a running session is never "unseen" even with idle > viewed', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('e5', { id: 'ses_run', busyAt: 1000, idleAt: 2000, viewedAt: 500 })
  observation.observeRunning('e5', new Set(['ses_run']), true)
  const board = observation.board()
  assert.equal(board.unseen.length, 0)
  assert.equal(board.running.length, 1)
})

test('step.ended accumulates per run and freezes into lastRun', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  observation.observeIdentity('e5', { id: 'ses_r', title: 'r' })
  observation.observeEvent('e5', { kind: 'run.started', sessionId: 'ses_r', at: 1000, data: {} })
  observation.observeEvent('e5', {
    kind: 'step.ended', sessionId: 'ses_r', at: 1100, data: { finish: 'tool-calls', tokens: { input: 100, output: 10, cache: { read: 5 } }, cost: 0.25 },
  })
  observation.observeEvent('e5', {
    kind: 'step.ended', sessionId: 'ses_r', at: 1200, data: { finish: 'stop', tokens: { input: 50, output: 20, cache: { read: 5 } }, cost: 0.5 },
  })
  const live = observation.rows('e5')[0]
  assert.equal(live.lastRun, null, 'still running: nothing frozen yet')
  observation.observeEvent('e5', { kind: 'run.finished', sessionId: 'ses_r', at: 1300, data: { outcome: 'succeeded' } })
  const row = observation.rows('e5')[0]
  assert.equal(row.status, 'idle')
  assert.deepEqual(row.lastRun, {
    startedAt: 1000,
    steps: 2,
    tokens: { input: 150, output: 30, cacheRead: 10 },
    cost: 0.75,
    finish: 'stop',
    outcome: 'succeeded',
    endedAt: 1300,
  })
})

test('v1 never enters the unseen partition (no idle marker at all)', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  // v1 sessions only carry time.created/updated, so there is no idle/viewed pair
  // to reason about; the reminder must stay off rather than guess.
  observation.observeIdentity('old', { id: 'ses_v1', busyAt: undefined, idleAt: undefined, viewedAt: undefined })
  observation.observeRunning('old', new Set(['ses_v1']), true)
  observation.observeRunning('old', new Set(), true)
  const board = observation.board()
  assert.equal(board.unseen.length, 0)
  assert.equal(board.idle.length, 1)
})

test('a never-viewed session still warns (no `viewed` marker exists yet)', function () {
  const c = clock()
  const observation = createObservation({ now: c.now })
  // Measured on OpenCode 2.3.0: sessions that were never opened have no
  // `time.viewed` at all — deriving unread from the marker alone would drop them.
  observation.observeIdentity('e5', { id: 'ses_new', busyAt: 1000, idleAt: 2000 })
  observation.observeRunning('e5', new Set(['ses_new']), true)
  observation.observeRunning('e5', new Set(), true)
  assert.equal(observation.board().unseen.length, 1)
  // Looking at it in dsh clears it locally even before the remote marker lands.
  assert.equal(observation.markSeen('e5', 'ses_new'), true)
  assert.equal(observation.board().unseen.length, 0)
  assert.equal(observation.board().idle.length, 1)
})
