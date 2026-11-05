/** Per-server SSE subscription over GET /global/event. */
import http from 'node:http'
import { serverHeaders } from './http.js'

export function createEventStream(options) {
  const activeRuns = options.activeRuns
  const handlePermission = options.handlePermission
  const handleQuestion = options.handleQuestion

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
    const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : (typeof properties.sessionId === 'string' ? properties.sessionId : undefined)
    server.events = Array.isArray(server.events) ? server.events : []
    server.events.push({ at: Date.now(), type: payload.type, sessionId: sessionId === undefined ? null : sessionId })
    if (server.events.length > 200) server.events.splice(0, server.events.length - 200)
    if (sessionId !== undefined) {
      if (!(server.sessionState instanceof Map)) server.sessionState = new Map()
      const current = server.sessionState.get(sessionId) || {}
      current.lastAt = Date.now()
      current.lastType = payload.type
      if (payload.type === 'session.deleted') {
        server.sessionState.delete(sessionId)
        return
      }
      if (payload.type === 'session.idle' || payload.type === 'session.error') current.running = false
      else if (payload.type === 'session.status') {
        const status = properties.status
        current.running = !(status !== null && typeof status === 'object' && status.type === 'idle')
        current.status = status !== null && typeof status === 'object' && typeof status.type === 'string' ? status.type : null
      } else if (payload.type === 'session.next.prompt.admitted' || payload.type === 'session.next.step.started') current.running = true
      server.sessionState.set(sessionId, current)
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

  return { subscribeEvents: subscribeEvents }
}
