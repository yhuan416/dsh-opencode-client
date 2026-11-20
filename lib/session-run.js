/** Shared lifecycle for one remote OpenCode run (delegate tool and subagent provider). */
import { opencodeRequest, ensureApiVersion, unwrap, apiVersionOf } from './http.js'
import { asyncPrompt, promptFailureMessage } from './delegate.js'
import { resolveAgentId } from './sessions.js'

/** v2 `Model.Ref`: `{id, providerID}` (note `id`, not `modelID`). */
export function modelRef(model) {
  if (model === null || typeof model !== 'object') return undefined
  const id = typeof model.id === 'string' ? model.id : (typeof model.modelID === 'string' ? model.modelID : undefined)
  if (id === undefined || typeof model.providerID !== 'string') return undefined
  const ref = { id: id, providerID: model.providerID }
  if (typeof model.variant === 'string' && model.variant !== '') ref.variant = model.variant
  return ref
}

/**
 * Apply per-turn agent/model on v2. OpenCode 2 keeps them as session state
 * (`POST /session/{id}/agent`, `POST /session/{id}/model`) instead of reading
 * them from the prompt body; the setting persists for later turns.
 */
export function prepareTurn(server, sessionId, options) {
  if (apiVersionOf(server) !== '2') return Promise.resolve()
  const agent = options !== undefined && typeof options.agent === 'string' && options.agent !== '' ? options.agent : undefined
  const model = options !== undefined && options.model !== undefined ? options.model : undefined
  let chain = Promise.resolve()
  if (agent !== undefined) {
    chain = chain.then(function () { return resolveAgentId(server, agent) }).then(function (agentId) {
      return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/agent', { method: 'POST', body: { agent: agentId }, timeoutMs: 10000 })
    })
  }
  if (model !== undefined) {
    const ref = modelRef(model)
    if (ref !== undefined) {
      chain = chain.then(function () {
        return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/model', { method: 'POST', body: { model: ref }, timeoutMs: 10000 })
      })
    }
  }
  return chain
}

/**
 * Reuse an existing session id or create one (title = session title).
 * v2 creation carries the directory in the body (`location.directory`) — query
 * and header scoping are ignored by the server there.
 */
export function ensureSession(server, options) {
  if (typeof options.sessionId === 'string' && options.sessionId !== '') return Promise.resolve(options.sessionId)
  const title = typeof options.title === 'string' && options.title !== '' ? options.title : 'dsh'
  const directory = typeof options.directory === 'string' && options.directory !== '' ? options.directory : server.directory
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) === '2') {
      const agent = typeof options.agent === 'string' && options.agent !== '' ? options.agent : server.agent
      const model = options.model !== undefined ? options.model : server.model
      return resolveAgentId(server, agent).then(function (agentId) {
        const body = { title: title }
        if (typeof directory === 'string' && directory !== '') body.location = { directory: directory }
        if (typeof agentId === 'string' && agentId !== '') body.agent = agentId
        const ref = modelRef(model)
        if (ref !== undefined) body.model = ref
        return opencodeRequest(server, '/session', { method: 'POST', body: body, timeoutMs: 20000 }).then(function (created) {
          return created === undefined ? undefined : unwrap(created.value)
        })
      }).then(function (created) {
        if (created === undefined || created === null || typeof created !== 'object' || typeof created.id !== 'string') {
          throw new Error(options.errorPrefix === undefined ? 'opencode: cannot create a session on ' + server.id : options.errorPrefix)
        }
        return created.id
      })
    }
    return opencodeRequest(server, '/session', { method: 'POST', body: { title: title }, directory: options.directory, timeoutMs: 20000 }).then(function (created) {
      const value = created === undefined ? undefined : unwrap(created.value)
      if (created === undefined || created.status !== 200 || value === undefined || typeof value.id !== 'string') {
        throw new Error(options.errorPrefix === undefined ? 'opencode: cannot create a session on ' + server.id : options.errorPrefix)
      }
      return value.id
    })
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
 * wait=false (default) returns as soon as the server accepts it (v1
 * `prompt_async`, v2 `prompt`), which lets the caller come back later — the
 * remote session stays continuable.
 * wait=true waits for that turn to finish via execution/idle events + polling.
 */
export function sendSessionMessage(server, sessionId, body, options) {
  const directory = options === undefined ? undefined : options.directory
  const version = apiVersionOf(server)
  const prepared = version === '2'
    ? prepareTurn(server, sessionId, options).catch(function () {})
    : Promise.resolve()
  return prepared.then(function () {
    if (options !== undefined && options.wait === true) {
      return asyncPrompt(server, sessionId, body, directory, options.signal, options.subscribeIdle).then(function (outcome) {
        return { waited: true, sessionId: sessionId, text: outcome.text, structured: outcome.structured }
      }, function (error) {
        if (error !== null && typeof error === 'object' && error.name === 'OpenCodeError') throw new Error(promptFailureMessage(error, server, directory))
        throw error
      })
    }
    const target = version === '2'
      ? '/session/' + encodeURIComponent(sessionId) + '/prompt'
      : '/session/' + encodeURIComponent(sessionId) + '/prompt_async'
    return opencodeRequest(server, target, {
      method: 'POST',
      body: body,
      directory: version === '2' ? undefined : directory,
      timeoutMs: 20000,
    }).then(function (reply) {
      return { waited: false, sessionId: sessionId, status: reply === undefined ? 0 : reply.status, accepted: reply !== undefined && (reply.status === 200 || reply.status === 201 || reply.status === 204) }
    })
  })
}

/** Best-effort remote abort for one session (v1 /abort, v2 /interrupt). */
export function abortRemote(server, sessionId) {
  const target = apiVersionOf(server) === '2'
    ? '/session/' + encodeURIComponent(sessionId) + '/interrupt'
    : '/session/' + encodeURIComponent(sessionId) + '/abort'
  return opencodeRequest(server, target, { method: 'POST', timeoutMs: 5000 }).catch(function () {})
}
