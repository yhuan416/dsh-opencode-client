/** Shared lifecycle for one remote OpenCode run (delegate tool and subagent provider). */
import { opencodeRequest } from './http.js'
import { asyncPrompt } from './delegate.js'

/** Reuse an existing session id or create one (title = session title). */
export function ensureSession(server, options) {
  if (typeof options.sessionId === 'string' && options.sessionId !== '') return Promise.resolve(options.sessionId)
  const title = typeof options.title === 'string' && options.title !== '' ? options.title : 'dsh'
  return opencodeRequest(server, '/session', { method: 'POST', body: { title: title }, directory: options.directory, timeoutMs: 20000 }).then(function (created) {
    if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
      throw new Error(options.errorPrefix === undefined ? 'opencode: cannot create a session on ' + server.id : options.errorPrefix)
    }
    return created.value.id
  })
}

/**
 * Register one run in the interaction bridge (approvals/questions) and the
 * active-run table. Returns an idempotent stop() that removes the tracking.
 */
export function trackRun(server, sessionId, options) {
  const activeRuns = options.activeRuns
  const watchInteractions = options.watchInteractions
  const directory = options.directory
  if (activeRuns instanceof Map) {
    activeRuns.set(sessionId, {
      serverId: server.id,
      directory: directory,
      agent: options.agent,
      signal: options.signal,
    })
  }
  const stopWatching = typeof watchInteractions === 'function' ? watchInteractions(server, sessionId, directory) : function () {}
  let stopped = false
  return function stop() {
    if (stopped) return
    stopped = true
    try { stopWatching() } catch (error) {}
    if (activeRuns instanceof Map) activeRuns.delete(sessionId)
    server.snapshot = undefined
  }
}

/**
 * Send one message to an existing remote session.
 * wait=false (default) returns as soon as the server accepts it (prompt_async),
 * which lets the caller come back later — the remote session stays continuable.
 * wait=true waits for that turn to finish via SSE idle + polling fallback.
 */
export function sendSessionMessage(server, sessionId, body, options) {
  const directory = options === undefined ? undefined : options.directory
  if (options !== undefined && options.wait === true) {
    return asyncPrompt(server, sessionId, body, directory, options.signal, options.subscribeIdle).then(function (outcome) {
      return { waited: true, sessionId: sessionId, text: outcome.text, structured: outcome.structured }
    })
  }
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/prompt_async', {
    method: 'POST',
    body: body,
    directory: directory,
    timeoutMs: 20000,
  }).then(function (reply) {
    return { waited: false, sessionId: sessionId, status: reply === undefined ? 0 : reply.status, accepted: reply !== undefined && (reply.status === 200 || reply.status === 201 || reply.status === 204) }
  })
}

/** Best-effort remote abort for one session. */
export function abortRemote(server, sessionId) {
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/abort', { method: 'POST', timeoutMs: 5000 }).catch(function () {})
}
