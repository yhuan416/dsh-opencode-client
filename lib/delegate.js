/**
 * Prompt construction and completion waiting for delegated OpenCode runs.
 *
 * v1: parts-based `prompt_async` + blocking `/message` prompt, completion from
 * `session.idle` with message polling.
 * v2: `{text,files}` prompt (agent/model are session-level), completion from
 * `session.execution.*` events, the `/experimental/session/{id}/wait` endpoint
 * and the `idle` message `outcome`.
 */
import { opencodeRequest, opencodeValue, ensureApiVersion, unwrapList, apiVersionOf } from './http.js'

function textPart(text) {
  return { type: 'text', text: text }
}

function inlineTextAttachments(pieces, files) {
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const mime = typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream'
    if (!(mime.indexOf('text/') === 0 || mime === 'application/json')) continue
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    if (base64 === '') continue
    try {
      const decoded = Buffer.from(base64, 'base64').toString('utf8')
      if (decoded !== '') pieces.push(textPart('Attached file ' + (typeof file.filename === 'string' ? file.filename : 'attachment') + ' (' + mime + '):\n\n' + decoded.slice(0, 20000)))
    } catch (error) {}
  }
}

/** v1 request body: one text/file part per piece, agent/model on the prompt. */
export function promptBody(server, task, options) {
  const parts = []
  if (typeof task === 'string' && task !== '') parts.push(textPart(task))
  const files = options !== undefined && Array.isArray(options.files) ? options.files : []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const mime = typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream'
    const filename = typeof file.filename === 'string' ? file.filename : 'attachment'
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    if (base64 === '') continue
    parts.push({ type: 'file', mime: mime, filename: filename, url: typeof file.url === 'string' ? file.url : 'data:' + mime + ';base64,' + base64 })
  }
  inlineTextAttachments(parts, files)
  const body = { parts: parts.length === 0 ? [textPart(task)] : parts }
  const agent = options !== undefined && typeof options.agent === 'string' && options.agent !== '' ? options.agent : server.agent
  if (agent !== undefined) body.agent = agent
  const model = options !== undefined && options.model !== undefined ? options.model : server.model
  if (model !== undefined) body.model = v1ModelRef(model)
  return body
}

/** v1 prompt model: only `{providerID, modelID}` (the `variant` field is v2-only). */
function v1ModelRef(model) {
  if (model === null || typeof model !== 'object') return model
  const modelID = typeof model.modelID === 'string' ? model.modelID : (typeof model.id === 'string' ? model.id : undefined)
  if (typeof model.providerID !== 'string' || modelID === undefined) return model
  return { providerID: model.providerID, modelID: modelID }
}

/** v2 request body: `{text, files:[{uri,name}]}`; agent/model are session state. */
export function v2PromptBody(server, task, options) {
  const files = options !== undefined && Array.isArray(options.files) ? options.files : []
  const pieces = typeof task === 'string' && task !== '' ? [task] : []
  const attachments = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const mime = typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream'
    const filename = typeof file.filename === 'string' ? file.filename : 'attachment'
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    if (base64 === '') continue
    attachments.push({ uri: typeof file.url === 'string' ? file.url : 'data:' + mime + ';base64,' + base64, name: filename })
  }
  // v2 has no text parts: inline small text attachments into the prompt text.
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const mime = typeof file.mime === 'string' && file.mime !== '' ? file.mime : 'application/octet-stream'
    if (!(mime.indexOf('text/') === 0 || mime === 'application/json')) continue
    const base64 = typeof file.base64 === 'string' ? file.base64 : ''
    if (base64 === '') continue
    try {
      const decoded = Buffer.from(base64, 'base64').toString('utf8')
      if (decoded !== '') pieces.push('Attached file ' + (typeof file.filename === 'string' ? file.filename : 'attachment') + ' (' + mime + '):\n\n' + decoded.slice(0, 20000))
    } catch (error) {}
  }
  const body = { text: pieces.join('\n\n') }
  if (attachments.length > 0) body.files = attachments
  return body
}

/** Build the prompt body for the detected API version (async: v2 needs a probe). */
export function buildPrompt(server, task, options) {
  return ensureApiVersion(server).then(function () {
    return apiVersionOf(server) === '2' ? v2PromptBody(server, task, options) : promptBody(server, task, options)
  })
}

/**
 * Flatten one assistant message. `finish` is OpenCode's native completion
 * reason (`stop|length|tool-calls|content-filter|error|unknown` on v2, the
 * adapter-specific string on v1) and `error` is present on failed turns; the
 * subagent provider maps both onto dsh's `stopReason`.
 */
export function extractAssistant(entry) {
  if (entry === null || typeof entry !== 'object') return { text: '', structured: undefined, finish: undefined, error: undefined }
  if (entry.type === 'assistant') {
    const content = Array.isArray(entry.content) ? entry.content : []
    const text = content.filter(function (part) {
      return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    }).map(function (part) { return part.text }).join('\n').trim()
    return {
      text: text,
      structured: entry.structured,
      finish: typeof entry.finish === 'string' ? entry.finish : undefined,
      error: entry.error !== undefined && entry.error !== null ? entry.error : undefined,
    }
  }
  const info = entry.info !== null && typeof entry.info === 'object' ? entry.info : {}
  const parts = Array.isArray(entry.parts) ? entry.parts : []
  const text = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
  }).map(function (part) { return part.text }).join('\n').trim()
  return {
    text: text,
    structured: info.structured,
    finish: typeof info.finish === 'string' ? info.finish : undefined,
    error: info.error !== undefined && info.error !== null ? info.error : undefined,
  }
}

/** Last `idle` message (newest first) or undefined. */
function readLastIdle(server, sessionId) {
  return opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/message?type=idle&order=desc&limit=1', { timeoutMs: 15000 }).then(function (value) {
    const list = unwrapList(value)
    return list.length === 0 ? undefined : list[0]
  })
}

/** Last assistant message of a session (newest first). */
function readLastAssistantMessage(server, sessionId) {
  return opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/message?order=desc&limit=50', { timeoutMs: 15000 }).then(function (value) {
    const list = unwrapList(value)
    for (const entry of list) {
      if (entry !== null && typeof entry === 'object' && entry.type === 'assistant') return entry
    }
    return undefined
  })
}

function readLastAssistant(server, sessionId) {
  return readLastAssistantMessage(server, sessionId).then(function (entry) {
    return entry === undefined ? { text: '', structured: undefined, finish: undefined, error: undefined } : extractAssistant(entry)
  })
}

/** Baseline used to tell this turn's `idle` message apart from the previous one. */
export function captureTurnBaseline(server, sessionId) {
  if (apiVersionOf(server) !== '2') return Promise.resolve(undefined)
  return readLastIdle(server, sessionId).then(function (idle) {
    return idle !== undefined && typeof idle.id === 'string' ? idle.id : ''
  }, function () { return '' })
}

/**
 * Wait for a session's turn to complete.
 * Completion is normally detected through the SSE stream (subscribeIdle): v1
 * reports `idle`, v2 reports `succeeded`/`failed`/`interrupted` from
 * `session.execution.*`. Polling is a slow safety net, and falls back to 1.5s
 * when no subscriber exists. `baseline` (v2) is the previous turn's idle id.
 */
export function waitAssistant(server, sessionId, directory, signal, timeoutMs, subscribeIdle, baseline) {
  return new Promise(function (resolve, reject) {
    const deadline = Date.now() + timeoutMs
    let done = false
    let timer
    let polling = false
    let unsubscribe
    let v2Misses = 0
    // With a live event stream completion is event-driven; keep a slow safety-net poll.
    // Without one (or while the stream reconnects) poll faster.
    const streamLive = server.sse !== undefined && server.sse.state === 'open'
    const interval = typeof subscribeIdle === 'function' && streamLive ? 5000 : 1500
    const version = apiVersionOf(server)
    function finish(error, value) {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      if (typeof unsubscribe === 'function') { try { unsubscribe() } catch (error) {} }
      if (error !== undefined && error !== null) reject(error)
      else resolve(value)
    }
    function pollV2() {
      polling = true
      readLastIdle(server, sessionId).then(function (idle) {
        polling = false
        if (done) return
        if (idle !== undefined && typeof idle.id === 'string' && idle.id !== baseline) {
          v2Misses = 0
          const outcome = typeof idle.outcome === 'string' ? idle.outcome : 'succeeded'
          if (outcome === 'failed') {
            const error = idle.error !== null && typeof idle.error === 'object' && typeof idle.error.message === 'string' ? ': ' + idle.error.message : ''
            finish(new Error('opencode: remote session failed' + error))
            return
          }
          if (outcome === 'interrupted') {
            finish(new Error('opencode: aborted'))
            return
          }
          readLastAssistant(server, sessionId).then(function (outcomeValue) {
            finish(undefined, outcomeValue)
          }, function () { finish(undefined, { text: '', structured: undefined }) })
          return
        }
        // The execution event can arrive just before the idle message is visible;
        // retry briefly before falling back to the slow interval.
        v2Misses += 1
        timer = setTimeout(poll, v2Misses < 3 ? 300 : interval)
      }, function () {
        polling = false
        if (!done) timer = setTimeout(poll, interval * 2)
      })
    }
    function pollV1() {
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
    function poll() {
      if (done || polling) return
      if (signal !== undefined && signal !== null && signal.aborted) { finish(new Error('opencode: aborted')); return }
      if (server.abortedSessions instanceof Set && server.abortedSessions.has(sessionId)) {
        server.abortedSessions.delete(sessionId)
        finish(new Error('opencode: aborted by request'))
        return
      }
      if (Date.now() > deadline) { finish(new Error('opencode: timeout')); return }
      if (version === '2') pollV2()
      else pollV1()
    }
    if (typeof subscribeIdle === 'function') {
      try {
        unsubscribe = subscribeIdle(server, sessionId, function (kind) {
          if (kind === 'failed' || kind === 'error') finish(new Error('opencode: remote session failed'))
          else if (kind === 'interrupted' || kind === 'aborted') finish(new Error('opencode: aborted'))
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

/**
 * Turn a prompt failure into an actionable line. OpenCode happily creates a
 * session for a directory it cannot see and only rejects the prompt with
 * `LocationNotFoundError` (HTTP 404); without this hint the caller just sees
 * "answered HTTP 404" and has no idea the child cwd is the problem.
 */
export function promptFailureMessage(error, server, directory) {
  const message = error !== null && typeof error === 'object' && error.message !== undefined ? String(error.message) : String(error)
  const body = error !== null && typeof error === 'object' && typeof error.bodySnippet === 'string' ? error.bodySnippet : ''
  if (body.indexOf('LocationNotFoundError') >= 0 || message.indexOf('Location not found') >= 0) {
    return 'opencode: ' + server.id + ' cannot see directory ' + (typeof directory === 'string' && directory !== '' ? directory : '(unknown)') + ' (LocationNotFoundError); configure pathMap so the child cwd exists on the remote, or start the child in a directory that server mounts'
  }
  return message
}

export function syncPrompt(server, id, body, directory, signal) {
  if (apiVersionOf(server) === '2') {
    return captureTurnBaseline(server, id).then(function (baseline) {
      return opencodeRequest(server, '/session/' + encodeURIComponent(id) + '/prompt', { method: 'POST', body: body, timeoutMs: 20000, signal: signal })
        .then(function (accepted) {
          if (accepted === undefined || accepted.status < 200 || accepted.status >= 300) throw new Error('opencode: no reply from ' + server.id + ' session ' + id)
          return waitAssistant(server, id, directory, signal, 900000, undefined, baseline)
        })
    })
  }
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

/**
 * Send one turn and wait for it to finish.
 * v1: `prompt_async` + SSE/poll wait, falling back to the blocking prompt endpoint.
 * v2: `prompt` (200 Inbox) + execution events/poll wait.
 */
export function asyncPrompt(server, id, body, directory, signal, subscribeIdle) {
  // The wait owns its own signal so every early-exit path can settle it:
  // abandoning a pending `waitAssistant` would leave its abort listener to
  // reject a promise nobody observes (an unhandled rejection that can crash
  // the host after the run was already settled as an error).
  const controller = new AbortController()
  const callerSignal = signal !== undefined && signal !== null ? signal : undefined
  const onAbort = function () { controller.abort() }
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }
  const release = function () {
    if (callerSignal !== undefined) callerSignal.removeEventListener('abort', onAbort)
  }
  const dropWait = function () {
    controller.abort()
    release()
    if (server.abortedSessions instanceof Set) server.abortedSessions.delete(id)
  }
  const waitSignal = controller.signal
  if (apiVersionOf(server) === '2') {
    return captureTurnBaseline(server, id).then(function (baseline) {
      const waited = waitAssistant(server, id, directory, waitSignal, 900000, subscribeIdle, baseline)
      // Mark handled: the failure branches below abandon `waited` on purpose.
      waited.catch(function () {})
      const settled = waited.then(function (value) { release(); return value }, function (error) { release(); throw error })
      // The refusal branch abandons `settled` too; keep it handled.
      settled.catch(function () {})
      return opencodeRequest(server, '/session/' + encodeURIComponent(id) + '/prompt', {
        method: 'POST',
        body: body,
        timeoutMs: 20000,
        signal: waitSignal,
      }).then(function (accepted) {
        if (accepted === undefined || accepted.status < 200 || accepted.status >= 300) {
          throw new Error('opencode: prompt rejected by ' + server.id + ' session ' + id + ' (status ' + (accepted === undefined ? 'none' : String(accepted.status)) + ')')
        }
        return settled
      }).catch(function (error) {
        // Stop the pending wait so it does not leak when the prompt was refused.
        dropWait()
        throw error
      })
    })
  }
  const waited = waitAssistant(server, id, directory, waitSignal, 900000, subscribeIdle)
  waited.catch(function () {})
  const settled = waited.then(function (value) { release(); return value }, function (error) { release(); throw error })
  settled.catch(function () {})
  return opencodeRequest(server, '/session/' + id + '/prompt_async', {
    method: 'POST',
    body: body,
    directory: directory,
    timeoutMs: 20000,
    signal: waitSignal,
  }).then(function (accepted) {
    if (accepted === undefined || (accepted.status !== 200 && accepted.status !== 201 && accepted.status !== 204)) {
      dropWait()
      return syncPrompt(server, id, body, directory, callerSignal)
    }
    return settled
  }, function () {
    dropWait()
    return syncPrompt(server, id, body, directory, callerSignal)
  })
}
