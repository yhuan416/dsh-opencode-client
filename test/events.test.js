/**
 * Unit tests for the unified OpenCode event model (lib/events.js):
 * v1/v2 wire mapping, completion split by version, forward compatibility.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionKind, eventTarget, normalizeEvent, toolOutputTail } from '../lib/events.js'

const SES = 'ses_00000000000000000000000001'

function v1(type, properties) {
  return { type: type, properties: properties }
}

function v2(type, data, created) {
  return { id: 'evt_1', created: created === undefined ? 100 : created, type: type, location: { directory: '/tmp/work' }, data: data }
}

test('eventTarget selects the version-specific SSE endpoint', function () {
  assert.equal(eventTarget('1'), '/global/event')
  assert.equal(eventTarget('2'), '/api/event')
  assert.equal(eventTarget(undefined), '/global/event')
  assert.equal(eventTarget('auto'), '/global/event')
})

test('v1 event sequence maps to the canonical model', function () {
  const events = [
    v1('message.part.updated', { sessionID: SES, part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running', time: { start: 50 } } } }),
    v1('message.part.delta', { sessionID: SES, delta: 'hello ' }),
    v1('message.part.updated', { sessionID: SES, part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', output: 'hello world' } } }),
    v1('session.status', { sessionID: SES, status: { type: 'busy' } }),
    v1('session.status', { sessionID: SES, status: { type: 'idle' } }),
    v1('session.idle', { sessionID: SES }),
  ]
  const normalized = events.map(function (event) { return normalizeEvent('1', event) })
  assert.deepEqual(normalized.map(function (event) { return event.kind }), [
    'tool.started', 'text.delta', 'tool.finished', 'session.status', 'session.status', 'run.finished',
  ])
  for (const event of normalized) {
    assert.equal(event.version, '1')
    assert.equal(event.sessionId, SES)
  }
  assert.equal(normalized[0].data.tool, 'bash')
  assert.equal(normalized[0].data.callID, 'call_1')
  assert.equal(normalized[0].data.since, 50)
  assert.equal(normalized[1].data.delta, 'hello ')
  assert.equal(normalized[2].data.ok, true)
  assert.equal(normalized[2].data.tail, 'hello world')
  assert.equal(normalized[3].data.status, 'busy')
  // v1 completion: idle status and session.idle both count.
  assert.equal(completionKind('1', normalized[3]), undefined)
  assert.equal(completionKind('1', normalized[4]), 'idle')
  assert.equal(completionKind('1', normalized[5]), 'idle')
})

test('v1 session.error is a failed completion; permission/question stay canonical', function () {
  const failed = normalizeEvent('1', v1('session.error', { sessionID: SES, error: { message: 'boom' } }))
  assert.equal(failed.kind, 'run.finished')
  assert.equal(failed.data.outcome, 'failed')
  assert.equal(completionKind('1', failed), 'failed')

  const permission = normalizeEvent('1', v1('permission.asked', { sessionID: SES, id: 'per_1', permission: 'bash', patterns: ['ls'] }))
  assert.equal(permission.kind, 'permission.asked')
  assert.equal(permission.sessionId, SES)
  assert.equal(permission.data.id, 'per_1')

  const question = normalizeEvent('1', v1('question.asked', { sessionID: SES, id: 'q_1', questions: [] }))
  assert.equal(question.kind, 'question.asked')
  assert.equal(question.sessionId, SES)
})

test('v1 wraps payload.payload and extracts the session id from part/info', function () {
  const wrapped = normalizeEvent('1', { payload: v1('message.part.delta', { delta: 'x' }) })
  assert.equal(wrapped.kind, 'text.delta')
  assert.equal(wrapped.sessionId, undefined)
  const fromPart = normalizeEvent('1', v1('message.part.updated', { part: { type: 'text', sessionID: SES, text: 'hi' } }))
  assert.equal(fromPart.kind, 'text.updated')
  assert.equal(fromPart.sessionId, SES)
  const fromInfo = normalizeEvent('1', v1('session.updated', { info: { sessionID: SES } }))
  assert.equal(fromInfo.kind, 'unknown')
  assert.equal(fromInfo.sessionId, SES)
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

  // The same wire events on v1 do complete.
  assert.equal(completionKind('1', normalizeEvent('1', v1('session.idle', { sessionID: SES }))), 'idle')
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

  const v1Future = normalizeEvent('1', v1('future.thing', { sessionID: SES }))
  assert.equal(v1Future.kind, 'unknown')
  assert.equal(v1Future.sessionId, SES)

  assert.equal(normalizeEvent('2', null), null)
  assert.equal(normalizeEvent('2', 'not an object'), null)
  assert.equal(normalizeEvent('2', { type: 42 }), null)
  assert.equal(normalizeEvent('1', {}), null)
  assert.equal(normalizeEvent('1', { type: 'x', properties: 'oops' }).kind, 'unknown')
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