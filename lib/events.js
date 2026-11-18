/**
 * Unified OpenCode event model.
 *
 * OpenCode 1 publishes `{type, properties}` payloads on `GET /global/event`;
 * OpenCode 2 publishes `{id, created, type, location, data, durable}` on
 * `GET /api/event`. This module maps both wire formats into one canonical
 * event (`{version, wireType, kind, sessionId, at, data, raw}`) so the SSE
 * consumer, live progress and completion detection do not branch on the
 * version everywhere.
 *
 * Canonical kinds are lowercase names, grouped by concern:
 *   run.*      run.started | run.finished
 *   text.*     text.started | text.updated | text.delta | text.ended
 *   thinking.* thinking.started | thinking.updated | thinking.delta | thinking.ended
 *   tool.*     tool.input.started | tool.input.delta | tool.input.ended |
 *              tool.started | tool.progress | tool.finished
 *   step.*     step.started | step.first-token | step.streamed | step.ended | step.failed
 *   session.*  session.status | session.created | session.deleted
 *   permission.asked | permission.replied | question.asked | question.replied | question.rejected
 *   unknown    (forward compatibility: never throws, never stops the stream)
 */

export const EVENT_TARGETS = Object.freeze({ '1': '/global/event', '2': '/api/event' })

/** SSE endpoint for one API version. */
export function eventTarget(version) {
  return version === '2' ? EVENT_TARGETS['2'] : EVENT_TARGETS['1']
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function v1SessionId(properties) {
  if (!isObject(properties)) return undefined
  const direct = properties.sessionID !== undefined ? properties.sessionID : properties.sessionId
  if (typeof direct === 'string') return direct
  if (isObject(properties.part) && typeof properties.part.sessionID === 'string') return properties.part.sessionID
  if (isObject(properties.info) && typeof properties.info.sessionID === 'string') return properties.info.sessionID
  return undefined
}

function v2SessionId(type, data) {
  if (!isObject(data)) return undefined
  if (typeof data.sessionID === 'string') return data.sessionID
  if (type === 'form.created' && isObject(data.form) && typeof data.form.sessionID === 'string') return data.form.sessionID
  return undefined
}

/** Flatten v2 `Tool.Content[]` into a short output tail. */
export function toolOutputTail(content) {
  if (!Array.isArray(content)) return ''
  const texts = []
  for (const item of content) {
    if (isObject(item) && item.type === 'text' && typeof item.text === 'string' && item.text !== '') texts.push(item.text)
  }
  return texts.join('\n').slice(-400)
}

function v1ToolState(part, state) {
  const output = typeof state.output === 'string'
    ? state.output
    : (isObject(state.metadata) && typeof state.metadata.output === 'string' ? state.metadata.output : '')
  const since = isObject(state.time) && typeof state.time.start === 'number' ? state.time.start : undefined
  return {
    tool: typeof part.tool === 'string' ? part.tool : 'tool',
    callID: typeof part.callID === 'string' ? part.callID : undefined,
    ok: state.status === 'completed',
    tail: output.slice(-400),
    since: since,
  }
}

function mapV1(type, properties) {
  switch (type) {
    case 'message.part.updated': {
      const part = isObject(properties.part) ? properties.part : {}
      if (part.type === 'tool') {
        const state = isObject(part.state) ? part.state : {}
        const finished = state.status === 'completed' || state.status === 'error'
        return { kind: finished ? 'tool.finished' : 'tool.started', data: v1ToolState(part, state) }
      }
      if (part.type === 'text') return { kind: 'text.updated', data: { text: typeof part.text === 'string' ? part.text : undefined } }
      if (part.type === 'reasoning') return { kind: 'thinking.updated', data: {} }
      return { kind: 'part.updated', data: { partType: typeof part.type === 'string' ? part.type : undefined } }
    }
    case 'message.part.delta':
      return { kind: 'text.delta', data: { delta: typeof properties.delta === 'string' ? properties.delta : '' } }
    case 'session.status': {
      const status = isObject(properties.status) ? properties.status : {}
      return { kind: 'session.status', data: { status: typeof status.type === 'string' ? status.type : undefined } }
    }
    case 'session.idle':
      return { kind: 'run.finished', data: { outcome: 'idle' } }
    case 'session.error':
      return { kind: 'run.finished', data: { outcome: 'failed', error: properties.error } }
    case 'session.created':
      return { kind: 'session.created', data: {} }
    case 'session.deleted':
      return { kind: 'session.deleted', data: {} }
    case 'permission.asked':
      return { kind: 'permission.asked', data: properties }
    case 'permission.replied':
      return { kind: 'permission.replied', data: properties }
    case 'question.asked':
      return { kind: 'question.asked', data: properties }
    case 'question.replied':
      return { kind: 'question.replied', data: properties }
    case 'question.rejected':
      return { kind: 'question.rejected', data: properties }
    default:
      return { kind: 'unknown', data: { wireType: type } }
  }
}

function mapV2(type, data) {
  const callID = typeof data.id === 'string' ? data.id : undefined
  switch (type) {
    case 'session.text.started':
      return { kind: 'text.started', data: {} }
    case 'session.text.delta':
      return { kind: 'text.delta', data: { delta: typeof data.delta === 'string' ? data.delta : '' } }
    case 'session.text.ended':
      return { kind: 'text.ended', data: { text: typeof data.text === 'string' ? data.text : '' } }
    case 'session.reasoning.started':
      return { kind: 'thinking.started', data: {} }
    case 'session.reasoning.delta':
      return { kind: 'thinking.delta', data: { delta: typeof data.delta === 'string' ? data.delta : '' } }
    case 'session.reasoning.ended':
      return { kind: 'thinking.ended', data: { text: typeof data.text === 'string' ? data.text : '' } }
    case 'session.tool.input.started':
      return { kind: 'tool.input.started', data: { callID: callID } }
    case 'session.tool.input.delta':
      return { kind: 'tool.input.delta', data: { callID: callID } }
    case 'session.tool.input.ended':
      return { kind: 'tool.input.ended', data: { callID: callID, text: typeof data.text === 'string' ? data.text : '' } }
    case 'session.tool.called':
      return {
        kind: 'tool.started',
        data: { tool: typeof data.name === 'string' ? data.name : 'tool', callID: callID, input: data.input },
      }
    case 'session.tool.progress':
      return { kind: 'tool.progress', data: { callID: callID, metadata: data.metadata } }
    case 'session.tool.success':
      return { kind: 'tool.finished', data: { ok: true, callID: callID, tail: toolOutputTail(data.content) } }
    case 'session.tool.failed':
      return { kind: 'tool.finished', data: { ok: false, callID: callID, error: data.error } }
    case 'session.step.started':
      return { kind: 'step.started', data: { agent: data.agent, model: data.model } }
    case 'session.step.first-token':
      return { kind: 'step.first-token', data: {} }
    case 'session.step.streamed':
      return { kind: 'step.streamed', data: {} }
    case 'session.step.ended':
      return { kind: 'step.ended', data: { finish: data.finish, tokens: data.tokens, cost: data.cost } }
    case 'session.step.failed':
      return { kind: 'step.failed', data: { error: data.error } }
    case 'session.execution.started':
      return { kind: 'run.started', data: {} }
    case 'session.execution.succeeded':
      return { kind: 'run.finished', data: { outcome: 'succeeded' } }
    case 'session.execution.failed':
      return { kind: 'run.finished', data: { outcome: 'failed', error: data.error } }
    case 'session.execution.interrupted':
      return { kind: 'run.finished', data: { outcome: 'interrupted', reason: data.reason } }
    case 'permission.asked':
      return {
        kind: 'permission.asked',
        data: {
          id: data.id,
          sessionID: data.sessionID,
          action: data.action,
          resources: data.resources,
          save: data.save,
          source: data.source,
          message: data.message,
        },
      }
    case 'permission.replied':
      return { kind: 'permission.replied', data: { sessionID: data.sessionID, requestID: data.requestID, reply: data.reply } }
    case 'session.created':
      return { kind: 'session.created', data: {} }
    case 'session.deleted':
      return { kind: 'session.deleted', data: {} }
    // Present in the v2 schema, but observed 2.3.0 runs emit execution.* instead:
    // keep them visible in the ring, never use them as v2 completion signals.
    case 'session.idle':
      return { kind: 'session.idle', data: {} }
    case 'session.status':
      return { kind: 'session.status', data: { status: isObject(data.status) ? data.status.type : undefined } }
    default:
      return { kind: 'unknown', data: { wireType: type } }
  }
}

/**
 * Map one parsed SSE payload (v1 `{type, properties}` or v2 event object) into
 * the canonical event. Returns null when the payload is not an event; unknown
 * event types map to `kind: 'unknown'` and never throw.
 */
export function normalizeEvent(version, payload) {
  try {
    if (!isObject(payload)) return null
    if (version === '2') {
      const type = typeof payload.type === 'string' ? payload.type : undefined
      if (type === undefined) return null
      const data = isObject(payload.data) ? payload.data : {}
      const mapped = mapV2(type, data)
      return {
        version: '2',
        wireType: type,
        kind: mapped.kind,
        data: mapped.data,
        sessionId: v2SessionId(type, data),
        at: typeof payload.created === 'number' ? payload.created : Date.now(),
        raw: data,
      }
    }
    const raw = isObject(payload.payload) ? payload.payload : payload
    const type = typeof raw.type === 'string' ? raw.type : undefined
    if (type === undefined) return null
    const properties = isObject(raw.properties) ? raw.properties : {}
    const mapped = mapV1(type, properties)
    return {
      version: '1',
      wireType: type,
      kind: mapped.kind,
      data: mapped.data,
      sessionId: v1SessionId(properties),
      at: typeof properties.timestamp === 'number' ? properties.timestamp : Date.now(),
      raw: properties,
    }
  } catch (error) {
    return null
  }
}

/**
 * Completion signal of one canonical event, split by API version:
 * - v1: `session.idle`, a `session.status` of `idle`, or `session.error`
 *   (the existing behaviour; polling remains the extraction safety net).
 * - v2: only `session.execution.succeeded|failed|interrupted`. `session.idle`
 *   and `session.status` stay informational because 2.3.0 does not emit them
 *   for completed runs.
 *
 * Returns `succeeded` | `failed` | `interrupted` | `idle`, or undefined.
 */
export function completionKind(version, event) {
  if (!isObject(event)) return undefined
  if (event.kind === 'run.finished') {
    const outcome = isObject(event.data) ? event.data.outcome : undefined
    if (version === '2') {
      if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'interrupted') return outcome
      return undefined
    }
    return outcome === 'failed' ? 'failed' : 'idle'
  }
  if (version !== '2' && event.kind === 'session.status' && isObject(event.data) && event.data.status === 'idle') return 'idle'
  return undefined
}