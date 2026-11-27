/**
 * Unit tests for the v2 OpenCode event model (lib/events.js):
 * wire mapping, completion split, forward compatibility.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionKind, eventTarget, normalizeEvent, toolOutputTail } from '../lib/events.js'

const SES = 'ses_00000000000000000000000001'

function v2(type, data, created) {
  return { id: 'evt_1', created: created === undefined ? 100 : created, type: type, location: { directory: '/tmp/work' }, data: data }
}

test('eventTarget always targets the v2 SSE endpoint', function () {
  assert.equal(eventTarget('1'), '/api/event')
  assert.equal(eventTarget('2'), '/api/event')
  assert.equal(eventTarget(undefined), '/api/event')
  assert.equal(eventTarget('auto'), '/api/event')
})

test('v2 event sequence maps to the canonical model', function () {
  const events = [
    v2('session.execution.started', { sessionID: SES }),
    v2('session.step.started', { sessionID: SES, assistantMessageID: 'msg_1', agent: 'build', model: { providerID: 'opencode', id: 'big-pickle' } }),
    v2('session.text.started', { sessionID: SES, assistantMessageID: 'msg_1', ordinal: 0 }),
    v2('session.text.delta', { sessionID: SES, assistantMessageID: 'msg_1', ordinal: 0, delta: 'PONG' }),
    v2('session.text.ended', { sessionID: SES, assistantMessageID: 'msg_1', ordinal: 0, text: 'PONG' }),
    v2('session.tool.called', { sessionID: SES, assistantMessageID: 'msg_1', id: 'call_1', name: 'shell', input: { command: 'echo x' }, executed: false }),
    v2('session.tool.success', { sessionID: SES, assistantMessageID: 'msg_1', id: 'call_1', content: [{ type: 'text', text: 'x\n' }], metadata: { exit: 0 }, executed: false }),
    v2('session.step.ended', { sessionID: SES, assistantMessageID: 'msg_1', finish: 'stop', tokens: { input: 1, output: 1 } }),
    v2('session.execution.succeeded', { sessionID: SES }),
  ]
  const normalized = events.map(function (event) { return normalizeEvent('2', event) })
  assert.deepEqual(normalized.map(function (event) { return event.kind }), [
    'run.started',
    'step.started',
    'text.started',
    'text.delta',
    'text.ended',
    'tool.started',
    'tool.finished',
    'step.ended',
    'run.finished',
  ])
  for (const event of normalized) {
    assert.equal(event.version, '2')
    assert.equal(event.sessionId, SES)
  }
  assert.equal(normalized[1].data.agent, 'build')
  assert.equal(normalized[3].data.delta, 'PONG')
  assert.equal(normalized[5].data.tool, 'shell')
  assert.equal(normalized[5].data.callID, 'call_1')
  assert.equal(normalized[6].data.ok, true)
  assert.equal(normalized[6].data.tail, 'x\n')
  assert.equal(normalized[8].data.outcome, 'succeeded')
  assert.equal(completionKind('2', normalized[8]), 'succeeded')
  // Only the terminal execution event is a completion.
  for (const event of normalized.slice(0, 8)) assert.equal(completionKind('2', event), undefined)
})

test('v2 completion split: failed and interrupted', function () {
  const failed = normalizeEvent('2', v2('session.execution.failed', { sessionID: SES, error: { type: 'unknown', message: 'boom' } }))
  assert.equal(failed.kind, 'run.finished')
  assert.equal(failed.data.outcome, 'failed')
  assert.equal(completionKind('2', failed), 'failed')

  const interrupted = normalizeEvent('2', v2('session.execution.interrupted', { sessionID: SES, reason: 'user' }))
  assert.equal(interrupted.data.outcome, 'interrupted')
  assert.equal(interrupted.data.reason, 'user')
  assert.equal(completionKind('2', interrupted), 'interrupted')
})

test('v2 session.idle/session.status are never completion signals', function () {
  const idle = normalizeEvent('2', v2('session.idle', { sessionID: SES }))
  assert.equal(idle.kind, 'session.idle')
  assert.equal(completionKind('2', idle), undefined)

  const status = normalizeEvent('2', v2('session.status', { sessionID: SES, status: { type: 'idle' } }))
  assert.equal(status.kind, 'session.status')
  assert.equal(status.data.status, 'idle')
  assert.equal(completionKind('2', status), undefined)

})

test('v2 permission events are canonical but require no v1 bridging', function () {
  const asked = normalizeEvent('2', v2('permission.asked', {
    id: 'per_1', sessionID: SES, action: 'shell', resources: ['echo x'], save: ['echo *'],
    source: { type: 'tool', messageID: 'msg_1', id: 'call_1' },
  }))
  assert.equal(asked.kind, 'permission.asked')
  assert.equal(asked.sessionId, SES)
  assert.equal(asked.data.action, 'shell')
  assert.deepEqual(asked.data.resources, ['echo x'])

  const replied = normalizeEvent('2', v2('permission.replied', { sessionID: SES, requestID: 'per_1', reply: 'once' }))
  assert.equal(replied.kind, 'permission.replied')
  assert.equal(replied.data.reply, 'once')
})

test('unknown and malformed events never throw (forward compatibility)', function () {
  const future = normalizeEvent('2', v2('session.future.thing', { sessionID: SES, value: 1 }))
  assert.equal(future.kind, 'unknown')
  assert.equal(future.sessionId, SES)
  assert.equal(completionKind('2', future), undefined)

  assert.equal(normalizeEvent('2', null), null)
  assert.equal(normalizeEvent('2', 'not an object'), null)
  assert.equal(normalizeEvent('2', { type: 42 }), null)
  assert.doesNotThrow(function () { normalizeEvent('2', { type: 'x', data: 'oops' }) })
  assert.equal(normalizeEvent('2', { type: 'x', data: 'oops' }).kind, 'unknown')
  assert.equal(completionKind('2', undefined), undefined)
  assert.equal(completionKind('2', { kind: 'run.finished', data: { outcome: 'weird' } }), undefined)
})

test('toolOutputTail renders a bounded text tail', function () {
  assert.equal(toolOutputTail([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(toolOutputTail(undefined), '')
  const long = toolOutputTail([{ type: 'text', text: 'x'.repeat(1000) }])
  assert.equal(long.length, 400)
})