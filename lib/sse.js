/** Per-server SSE subscription over GET /global/event. */
import http from 'node:http'
import { serverHeaders } from './http.js'

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

  function handleEventBlock(server, block) {
    const lines = block.split('\n')
    const dataLines = []
    for (const line of lines) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    if (dataLines.length === 0) return
    let parsed
    try { parsed = JSON.parse(dataLines.join('\n')) } catch { return }
    const payload = parsed !== null && typeof parsed === 'object' && parsed.payload !== undefined ? parsed.payload : parsed
    if (payload === null || typeof payload !== 'object' || typeof payload.type !== 'string') return
    const properties = payload.properties !== null && typeof payload.properties === 'object' ? payload.properties : {}
    let sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : (typeof properties.sessionId === 'string' ? properties.sessionId : undefined)
    if (sessionId === undefined && properties.part !== null && typeof properties.part === 'object' && typeof properties.part.sessionID === 'string') sessionId = properties.part.sessionID
    if (sessionId === undefined && properties.info !== null && typeof properties.info === 'object' && typeof properties.info.sessionID === 'string') sessionId = properties.info.sessionID
    server.events = Array.isArray(server.events) ? server.events : []
    server.events.push({ at: Date.now(), type: payload.type, sessionId: sessionId === undefined ? null : sessionId })
    if (server.events.length > 200) server.events.splice(0, server.events.length - 200)
    if (sessionId !== undefined) {
      if (!(server.sessionState instanceof Map)) server.sessionState = new Map()
      if (!(server.progress instanceof Map)) server.progress = new Map()
      const current = server.sessionState.get(sessionId) || {}
      const progress = server.progress.get(sessionId) || { status: 'idle', tool: null, tail: '', since: Date.now() }
      const at = typeof properties.timestamp === 'number' ? properties.timestamp : Date.now()
      current.lastAt = Date.now()
      current.lastType = payload.type
      if (payload.type === 'session.deleted') {
        server.sessionState.delete(sessionId)
        server.progress.delete(sessionId)
        notifyIdle(server, sessionId, 'deleted')
        return
      }
      if (payload.type === 'message.part.updated') {
        const part = properties.part !== null && typeof properties.part === 'object' ? properties.part : null
        if (part !== null && part.type === 'tool') {
          const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
          progress.tool = typeof part.tool === 'string' ? part.tool : 'tool'
          progress.callID = typeof part.callID === 'string' ? part.callID : null
          const started = state.time !== null && typeof state.time === 'object' && typeof state.time.start === 'number' ? state.time.start : at
          progress.since = started
          if (state.status === 'completed') { progress.status = 'tool-done'; progress.endedAt = at }
          else if (state.status === 'error') { progress.status = 'tool-failed'; progress.endedAt = at }
          else progress.status = 'tool'
          const output = typeof state.output === 'string' ? state.output : (state.metadata !== null && typeof state.metadata === 'object' && typeof state.metadata.output === 'string' ? state.metadata.output : '')
          if (output !== '') progress.tail = output.slice(-400)
        } else if (part !== null && part.type === 'text') {
          if (progress.status !== 'tool' && progress.status !== 'tool-done' && progress.status !== 'tool-failed') progress.status = 'text'
        } else if (part !== null && part.type === 'reasoning') {
          if (progress.status === 'idle' || progress.status === 'text') progress.status = 'thinking'
        }
      } else if (payload.type === 'message.part.delta') {
        const delta = typeof properties.delta === 'string' ? properties.delta : ''
        if (delta !== '') progress.tail = (typeof progress.tail === 'string' ? progress.tail + delta : delta).slice(-400)
        if (progress.status === 'idle') progress.status = 'text'
      } else if (payload.type === 'session.next.tool.called') {
        progress.status = 'tool'
        progress.tool = typeof properties.tool === 'string' ? properties.tool : 'tool'
        progress.callID = typeof properties.callID === 'string' ? properties.callID : null
        progress.since = at
        progress.tail = ''
      } else if (payload.type === 'session.next.tool.progress') {
        progress.status = 'tool'
      } else if (payload.type === 'session.next.tool.success') {
        progress.status = 'tool-done'
        progress.endedAt = at
      } else if (payload.type === 'session.next.tool.failed') {
        progress.status = 'tool-failed'
        progress.endedAt = at
      } else if (payload.type === 'session.next.step.started') {
        progress.status = 'thinking'
        progress.tool = null
        progress.since = at
        progress.tail = ''
      } else if (payload.type === 'session.next.text.delta') {
        const delta = typeof properties.delta === 'string' ? properties.delta : ''
        if (delta !== '') progress.tail = (progress.tail + delta).slice(-400)
      }
      if (payload.type === 'session.idle' || payload.type === 'session.error') {
        current.running = false
        progress.status = payload.type === 'session.error' ? 'error' : 'idle'
        progress.endedAt = Date.now()
        notifyIdle(server, sessionId, payload.type)
      } else if (payload.type === 'session.status') {
        const status = properties.status
        current.running = !(status !== null && typeof status === 'object' && status.type === 'idle')
        current.status = status !== null && typeof status === 'object' && typeof status.type === 'string' ? status.type : null
        if (current.running === false) {
          progress.status = 'idle'
          progress.endedAt = Date.now()
          notifyIdle(server, sessionId, 'status-idle')
        } else if (progress.status === 'idle' || progress.status === 'text') {
          progress.status = 'thinking'
        }
      } else if (payload.type === 'session.next.prompt.admitted') current.running = true
      server.sessionState.set(sessionId, current)
      server.progress.set(sessionId, progress)
    }
    if (payload.type === 'permission.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handlePermission(server, run, properties)
    }
    if (payload.type === 'question.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handleQuestion(server, run, properties)
    }
  }

  /** Subscribe with reconnect/backoff; returns a disposal function. */
  function subscribeEvents(server) {
    const sse = { state: 'closed', attempts: 0, timer: undefined, request: undefined, disposed: false, buffer: '' }
    server.sse = sse
    function schedule(delay) {
      if (sse.disposed) return
      if (sse.timer !== undefined) clearTimeout(sse.timer)
      sse.timer = setTimeout(connect, delay)
    }
    function connect() {
      if (sse.disposed) return
      let url
      try { url = new URL(server.url + '/global/event') } catch { schedule(5000); return }
      sse.state = 'connecting'
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
          sse.attempts += 1
          schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(sse.attempts, 5))))
          return
        }
        sse.state = 'open'
        sse.attempts = 0
        response.setEncoding('utf8')
        response.on('data', function (chunk) {
          sse.buffer += chunk
          let index
          while ((index = sse.buffer.indexOf('\n\n')) >= 0) {
            const block = sse.buffer.slice(0, index)
            sse.buffer = sse.buffer.slice(index + 2)
            try { handleEventBlock(server, block) } catch (error) {}
          }
        })
        response.on('end', function () { sse.state = 'closed'; schedule(1500) })
        response.on('error', function () { sse.state = 'closed'; schedule(3000) })
      })
      request.on('error', function () {
        sse.state = 'closed'
        sse.attempts += 1
        schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(sse.attempts, 5))))
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
