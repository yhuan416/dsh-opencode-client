/** Shared lifecycle for one remote OpenCode run (delegate tool and subagent provider). */
import { ocCall } from './oc-client.js'
import { asyncPrompt, promptFailureMessage } from './delegate.js'
import { resolveAgentId } from './sessions.js'
import { invalidateSnapshot } from './snapshot.js'

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
  const agent = options !== undefined && typeof options.agent === 'string' && options.agent !== '' ? options.agent : undefined
  const model = options !== undefined && options.model !== undefined ? options.model : undefined
  let chain = Promise.resolve()
  if (agent !== undefined) {
    chain = chain.then(function () { return resolveAgentId(server, agent) }).then(function (agentId) {
      return ocCall(server, function (client, requestOptions) {
        return client.session.switchAgent({ sessionID: sessionId, agent: agentId }, requestOptions)
      }, 10000)
    })
  }
  if (model !== undefined) {
    const ref = modelRef(model)
    if (ref !== undefined) {
      chain = chain.then(function () {
        return ocCall(server, function (client, requestOptions) {
          return client.session.switchModel({ sessionID: sessionId, model: ref }, requestOptions)
        }, 10000)
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
  const agent = typeof options.agent === 'string' && options.agent !== '' ? options.agent : server.agent
  const model = options.model !== undefined ? options.model : server.model
  return resolveAgentId(server, agent).then(function (agentId) {
    const input = { title: title }
    if (typeof directory === 'string' && directory !== '') input.location = { directory: directory }
    if (typeof agentId === 'string' && agentId !== '') input.agent = agentId
    const ref = modelRef(model)
    if (ref !== undefined) input.model = ref
    return ocCall(server, function (client, requestOptions) {
      return client.session.create(input, requestOptions)
    }, 20000)
  }).then(function (created) {
    if (created === undefined || created === null || typeof created !== 'object' || typeof created.id !== 'string') {
      throw new Error(options.errorPrefix === undefined ? 'opencode: cannot create a session on ' + server.id : options.errorPrefix)
    }
    return created.id
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
    invalidateSnapshot(server)
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
  const prepared = prepareTurn(server, sessionId, options).catch(function () {})
  return prepared.then(function () {
    if (options !== undefined && options.wait === true) {
      return asyncPrompt(server, sessionId, body, directory, options.signal, options.subscribeIdle).then(function (outcome) {
        return { waited: true, sessionId: sessionId, text: outcome.text, structured: outcome.structured }
      }, function (error) {
        if (error !== null && typeof error === 'object' && error.name === 'OpenCodeError') throw new Error(promptFailureMessage(error, server, directory))
        throw error
      })
    }
    return ocCall(server, function (client, requestOptions) {
      return client.session.prompt(Object.assign({ sessionID: sessionId }, body), requestOptions)
    }, 20000).then(function () {
      return { waited: false, sessionId: sessionId, status: 200, accepted: true }
    })
  })
}

/** Best-effort remote abort for one session. */
export function abortRemote(server, sessionId) {
  return ocCall(server, function (client, requestOptions) {
    return client.session.interrupt({ sessionID: sessionId }, requestOptions)
  }, 5000).catch(function () {})
}
