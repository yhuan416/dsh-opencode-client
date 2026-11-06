/** Prompt construction and completion waiting for delegated OpenCode runs. */
import { opencodeRequest } from './http.js'

export function promptBody(server, task, options) {
  const parts = []
  if (typeof task === 'string' && task !== '') parts.push({ type: 'text', text: task })
  const files = options !== undefined && Array.isArray(options.files) ? options.files : []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const mime = typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream'
    const filename = typeof file.filename === 'string' ? file.filename : 'attachment'
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    if (base64 === '') continue
    parts.push({ type: 'file', mime: mime, filename: filename, url: typeof file.url === 'string' ? file.url : 'data:' + mime + ';base64,' + base64 })
    if (mime.indexOf('text/') === 0 || mime === 'application/json') {
      try {
        const decoded = Buffer.from(base64, 'base64').toString('utf8')
        if (decoded !== '') parts.push({ type: 'text', text: 'Attached file ' + filename + ' (' + mime + '):\n\n' + decoded.slice(0, 20000) })
      } catch (error) {}
    }
  }
  const body = { parts: parts.length === 0 ? [{ type: 'text', text: task }] : parts }
  const agent = options !== undefined && typeof options.agent === 'string' && options.agent !== '' ? options.agent : server.agent
  if (agent !== undefined) body.agent = agent
  const model = options !== undefined && options.model !== undefined ? options.model : server.model
  if (model !== undefined) body.model = model
  return body
}

export function extractAssistant(entry) {
  const info = entry !== null && typeof entry === 'object' && entry.info !== null && typeof entry.info === 'object' ? entry.info : {}
  const parts = entry !== null && typeof entry === 'object' && Array.isArray(entry.parts) ? entry.parts : []
  const text = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
  }).map(function (part) { return part.text }).join('\n').trim()
  return { text: text, structured: info.structured }
}

/**
 * Wait for a session's assistant message to complete.
 * Completion is normally detected through the global SSE stream (subscribeIdle);
 * polling is a slow safety net, and falls back to 1.5s when no subscriber exists.
 */
export function waitAssistant(server, sessionId, directory, signal, timeoutMs, subscribeIdle) {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + timeoutMs
    let done = false
    let timer
    let polling = false
    let unsubscribe
    const interval = typeof subscribeIdle === 'function' ? 5000 : 1500
    function finish(error, value) {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      if (typeof unsubscribe === 'function') { try { unsubscribe() } catch (error) {} }
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    }
    function poll() {
      if (done || polling) return
      if (signal !== undefined && signal !== null && signal.aborted) { finish(new Error('opencode: aborted')); return }
      if (server.abortedSessions instanceof Set && server.abortedSessions.has(sessionId)) {
        server.abortedSessions.delete(sessionId)
        finish(new Error('opencode: aborted by request'))
        return
      }
      if (Date.now() > deadline) { finish(new Error('opencode: timeout')); return }
      polling = true
      opencodeRequest(server, '/session/' + sessionId + '/message?limit=2', { directory: directory, timeoutMs: 15000 }).then(function (result) {
        polling = false
        if (done) return
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        if (result !== undefined && result.value !== undefined && !Array.isArray(result.value) && typeof result.value === 'object' && result.value !== null) {
          const detail = result.value.name === undefined ? JSON.stringify(result.value) : String(result.value.name) + ': ' + JSON.stringify(result.value.data).slice(0, 300)
          finish(new Error('opencode: message read failed: ' + detail))
          return
        }
        const last = list.length === 0 ? undefined : list[list.length - 1]
        const info = last !== undefined && last !== null && typeof last === 'object' && last.info !== null && typeof last.info === 'object' ? last.info : {}
        const completed = info.time !== null && typeof info.time === 'object' && typeof info.time.completed === 'number'
        if (info.role === 'assistant' && completed) {
          finish(undefined, extractAssistant(last))
          return
        }
        timer = setTimeout(poll, interval)
      }, function () {
        polling = false
        if (!done) timer = setTimeout(poll, interval * 2)
      })
    }
    if (typeof subscribeIdle === 'function') {
      try {
        unsubscribe = subscribeIdle(server, sessionId, function (kind) {
          if (kind === 'error') finish(new Error('opencode: remote session failed'))
          else poll()
        })
      } catch (error) {}
    }
    timer = setTimeout(poll, 300)
    if (signal !== undefined && signal !== null) {
      signal.addEventListener('abort', function () { finish(new Error('opencode: aborted')) }, { once: true })
    }
  })
}

export function syncPrompt(server, id, body, directory, signal) {
  return opencodeRequest(server, '/session/' + id + '/message', {
    method: 'POST',
    body: body,
    directory: directory,
    timeoutMs: 900000,
    signal: signal,
  }).then(function (reply) {
    if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
      throw new Error('opencode: no reply from ' + server.id + ' session ' + id)
    }
    return extractAssistant(reply.value)
  })
}

/** prompt_async + SSE/poll completion wait, falling back to the blocking prompt endpoint. */
export function asyncPrompt(server, id, body, directory, signal, subscribeIdle) {
  const waited = waitAssistant(server, id, directory, signal, 900000, subscribeIdle)
  return opencodeRequest(server, '/session/' + id + '/prompt_async', {
    method: 'POST',
    body: body,
    directory: directory,
    timeoutMs: 20000,
    signal: signal,
  }).then(function (accepted) {
    if (accepted === undefined || (accepted.status !== 200 && accepted.status !== 201 && accepted.status !== 204)) {
      return syncPrompt(server, id, body, directory, signal)
    }
    return waited
  }, function () {
    return syncPrompt(server, id, body, directory, signal)
  })
}
