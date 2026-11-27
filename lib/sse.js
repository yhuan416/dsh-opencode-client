/** Per-server SSE subscription: OpenCode 2 `GET /api/event` (+ Basic auth). */
import http from 'node:http'
import { ensureApiVersion, serverHeaders } from './http.js'
import { completionKind, eventTarget, normalizeEvent } from './events.js'
import { ocCall } from './oc-client.js'
import { collectRunningTool } from './sessions.js'

export function createEventStream(options) {
  const activeRuns = options.activeRuns
  const handlePermission = options.handlePermission
  const handleQuestion = options.handleQuestion
  const idleListeners = new Map()

  function notifyIdle(server, sessionId, kind) {
    const key = server.id + ':' + sessionId
    const listeners = idleListeners.get(key)
    if (listeners === undefined) return
    for (const listener of Array.from(listeners)) {
      try { listener(kind) } catch (error) {}
    }
  }

  function subscribeIdle(server, sessionId, listener) {
    const key = server.id + ':' + sessionId
    let listeners = idleListeners.get(key)
    if (listeners === undefined) {
      listeners = new Set()
      idleListeners.set(key, listeners)
    }
    listeners.add(listener)
    return function () {
      listeners.delete(listener)
      if (listeners.size === 0) idleListeners.delete(key)
    }
  }

  /** Apply one canonical event to the per-session live state and idle listeners. */
  function handleEvent(server, version, event) {
    const sessionId = event.sessionId
    server.events = Array.isArray(server.events) ? server.events : []
    server.events.push({
      at: Date.now(),
      type: event.kind,
      wireType: event.wireType,
      sessionId: sessionId === undefined ? null : sessionId,
      version: version,
    })
    if (server.events.length > 200) server.events.splice(0, server.events.length - 200)

    // Observation hook (lib/observation.js). Runs before the state switch so a
    // `session.deleted` that returns early is still seen by the registry.
    if (typeof options.onEvent === 'function') {
      try { options.onEvent(server, event) } catch (error) {}
    }

    if (sessionId !== undefined) {
      if (!(server.sessionState instanceof Map)) server.sessionState = new Map()
      if (!(server.progress instanceof Map)) server.progress = new Map()
      const current = server.sessionState.get(sessionId) || {}
      const progress = server.progress.get(sessionId) || { status: 'idle', tool: null, tail: '', since: Date.now() }
      current.lastAt = Date.now()
      current.lastType = event.wireType
      switch (event.kind) {
        case 'session.deleted':
          server.sessionState.delete(sessionId)
          server.progress.delete(sessionId)
          notifyIdle(server, sessionId, 'deleted')
          return
        case 'tool.started':
          progress.status = 'tool'
          progress.tool = typeof event.data.tool === 'string' && event.data.tool !== '' ? event.data.tool : (progress.tool === undefined ? 'tool' : progress.tool)
          progress.callID = event.data.callID === undefined ? (progress.callID === undefined ? null : progress.callID) : event.data.callID
          progress.since = typeof event.data.since === 'number' ? event.data.since : event.at
          progress.tail = ''
          break
        case 'tool.input.started':
          progress.status = 'tool'
          progress.callID = event.data.callID === undefined ? (progress.callID === undefined ? null : progress.callID) : event.data.callID
          progress.since = event.at
          progress.tail = ''
          break
        case 'tool.progress':
          progress.status = 'tool'
          break
        case 'tool.finished':
          progress.status = event.data.ok === true ? 'tool-done' : 'tool-failed'
          progress.endedAt = event.at
          if (event.data.callID !== undefined) progress.callID = event.data.callID
          if (typeof event.data.tail === 'string' && event.data.tail !== '') progress.tail = event.data.tail.slice(-400)
          break
        case 'text.updated':
          if (progress.status !== 'tool' && progress.status !== 'tool-done' && progress.status !== 'tool-failed') progress.status = 'text'
          break
        case 'text.started':
          if (progress.status === 'idle' || progress.status === 'text') progress.status = 'text'
          break
        case 'text.delta': {
          const delta = typeof event.data.delta === 'string' ? event.data.delta : ''
          if (delta !== '') progress.tail = (typeof progress.tail === 'string' ? progress.tail + delta : delta).slice(-400)
          if (progress.status === 'idle') progress.status = 'text'
          break
        }
        case 'text.ended':
          if (typeof event.data.text === 'string' && event.data.text !== '' && (typeof progress.tail !== 'string' || progress.tail === '')) {
            progress.tail = event.data.text.slice(-400)
          }
          break
        case 'thinking.started':
        case 'thinking.updated':
        case 'thinking.delta':
          if (progress.status === 'idle' || progress.status === 'text') progress.status = 'thinking'
          break
        case 'step.started':
          progress.status = 'thinking'
          progress.tool = null
          progress.since = event.at
          progress.tail = ''
          break
        case 'step.first-token':
        case 'step.streamed':
        case 'step.ended':
        case 'step.failed':
          break
        case 'run.started':
          current.running = true
          if (progress.status === 'idle') progress.status = 'thinking'
          break
        case 'run.finished': {
          const outcome = event.data.outcome
          current.running = false
          current.outcome = outcome
          progress.status = outcome === 'failed' ? 'error' : 'idle'
          progress.endedAt = Date.now()
          const kind = completionKind(version, event)
          if (kind !== undefined) notifyIdle(server, sessionId, kind)
          break
        }
        case 'session.status': {
          const status = event.data.status
          current.running = status !== 'idle'
          current.status = status === undefined ? null : status
          if (current.running === false) {
            progress.status = 'idle'
            progress.endedAt = Date.now()
            const kind = completionKind(version, event)
            if (kind !== undefined) notifyIdle(server, sessionId, kind)
          } else if (progress.status === 'idle' || progress.status === 'text') {
            progress.status = 'thinking'
          }
          break
        }
        // Present in the v2 schema but not a v2 completion signal (2.3.0 does not emit it).
        case 'session.idle':
        case 'session.created':
        case 'part.updated':
        case 'permission.replied':
          break
        default:
          break
      }
      server.sessionState.set(sessionId, current)
      server.progress.set(sessionId, progress)
    }

    // Both wire formats map to the same canonical permission/question kinds, so the
    // interaction bridge (v1 global replies, v2 session-scoped permission/form replies)
    // is driven by the event stream for both API versions.
    if (event.kind === 'permission.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handlePermission(server, run, event.data)
    }
    if (event.kind === 'question.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handleQuestion(server, run, event.data)
    }
  }

  function handleEventBlock(server, version, block) {
    const lines = block.split('\n')
    const dataLines = []
    for (const line of lines) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    if (dataLines.length === 0) return
    let parsed
    try { parsed = JSON.parse(dataLines.join('\n')) } catch { return }
    const event = normalizeEvent(version, parsed)
    if (event === null) return
    handleEvent(server, version, event)
  }

  /** Subscribe with reconnect/backoff; returns a disposal function. */
  function subscribeEvents(server) {
    // Seed the shared maps up front: callers read them while `connect()` is still
    // probing, and the catch-up path fills progress before the first event.
    if (!(server.progress instanceof Map)) server.progress = new Map()
    if (!(server.sessionState instanceof Map)) server.sessionState = new Map()
    const sse = {
      state: 'closed',
      attempts: 0,
      // Health counters the board reports: `connects` counts successful opens
      // (so >1 means it had to reconnect), `attempts` is the current failure
      // streak and resets on success.
      connects: 0,
      openedAt: undefined,
      timer: undefined,
      request: undefined,
      disposed: false,
      buffer: '',
      version: undefined,
      target: undefined,
    }
    server.sse = sse
    function backoff() {
      sse.attempts += 1
      return Math.min(30000, 1000 * Math.pow(2, Math.min(sse.attempts, 5)))
    }
    function schedule(delay) {
      if (sse.disposed) return
      if (sse.timer !== undefined) clearTimeout(sse.timer)
      sse.timer = setTimeout(connect, delay)
    }
    function backfillProgress() {
      // SSE has no replay: seed progress for sessions that were already running
      // when this stream opened, without overwriting live progress.
      if (!(server.progress instanceof Map)) server.progress = new Map()
      ocCall(server, function (client, requestOptions) {
        return client.session.active(requestOptions)
      }, 5000).then(function (active) {
        const ids = active !== null && typeof active === 'object' ? Object.keys(active) : []
        let chain = Promise.resolve()
        for (const sessionId of ids) {
          chain = chain.then(function () {
            const current = server.progress instanceof Map ? server.progress.get(sessionId) : undefined
            if (current !== undefined && current.status !== 'idle') return
            return collectRunningTool(server, sessionId).then(function (progress) {
              if (progress !== undefined && server.progress instanceof Map) server.progress.set(sessionId, progress)
            })
          })
        }
        return chain
      }).catch(function () {})
    }
    function connect() {
      if (sse.disposed) return
      sse.state = 'connecting'
      ensureApiVersion(server).then(function (info) {
        if (sse.disposed) return
        if (info === null || typeof info !== 'object' || info.version !== '2') {
          sse.state = 'closed'
          sse.error = 'requires OpenCode 2.x'
          return
        }
        sse.version = info.version
        sse.target = eventTarget(info.version)
        open()
      }, function () {
        if (sse.disposed) return
        sse.state = 'closed'
        schedule(backoff())
      })
    }
    function open() {
      if (sse.disposed) return
      let url
      try { url = new URL(server.url + sse.target) } catch { schedule(5000); return }
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'GET',
        path: url.pathname + url.search,
        headers: Object.assign(serverHeaders(server), { accept: 'text/event-stream' }),
      }, function (response) {
        if (response.statusCode !== 200) {
          response.resume()
          sse.state = 'closed'
          schedule(backoff())
          return
        }
        sse.state = 'open'
        sse.attempts = 0
        sse.connects += 1
        sse.openedAt = Date.now()
        backfillProgress()
        response.setEncoding('utf8')
        response.on('data', function (chunk) {
          sse.buffer += chunk
          let index
          while ((index = sse.buffer.indexOf('\n\n')) >= 0) {
            const block = sse.buffer.slice(0, index)
            sse.buffer = sse.buffer.slice(index + 2)
            try { handleEventBlock(server, sse.version, block) } catch (error) {}
          }
        })
        response.on('end', function () { sse.state = 'closed'; schedule(1500) })
        response.on('error', function () { sse.state = 'closed'; schedule(3000) })
      })
      request.on('error', function () {
        sse.state = 'closed'
        schedule(backoff())
      })
      request.end()
      sse.request = request
    }
    connect()
    return function () {
      sse.disposed = true
      if (sse.timer !== undefined) clearTimeout(sse.timer)
      try { if (sse.request !== undefined) sse.request.destroy() } catch (error) {}
    }
  }

  return { subscribeEvents: subscribeEvents, subscribeIdle: subscribeIdle }
}