/** Prompt construction and completion waiting for delegated OpenCode runs. */
import { opencodeRequest } from './http.js'

export function promptBody(server, task, options) {
  const body = { parts: [{ type: 'text', text: task }] }
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

/** Poll a session's last messages until its assistant message is completed. */
export function waitAssistant(server, sessionId, directory, signal, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + timeoutMs
    let done = false
    let timer
    function finish(error, value) {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    }
    function poll() {
      if (done) return
      if (signal !== undefined && signal !== null && signal.aborted) { finish(new Error('opencode: aborted')); return }
      if (Date.now() > deadline) { finish(new Error('opencode: timeout')); return }
      opencodeRequest(server, '/session/' + sessionId + '/message?limit=2', { directory: directory, timeoutMs: 15000 }).then(function (result) {
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
        timer = setTimeout(poll, 1500)
      }, function () { if (!done) timer = setTimeout(poll, 3000) })
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

/** prompt_async + message polling, falling back to the blocking prompt endpoint. */
export function asyncPrompt(server, id, body, directory, signal) {
  const waited = waitAssistant(server, id, directory, signal, 900000)
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
