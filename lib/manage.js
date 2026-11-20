/**
 * Session management: fork, summarize/compact, init, children.
 *
 * v1: `/session/{id}/fork {messageID}`, `/summarize`, `/init`, `/children`.
 * v2: `/fork {before}` returning `{data: Session.Info}`, `/compact` (replaces
 * summarize; the session's own model is used), `init` as the built-in
 * `/command`, and children through `GET /api/session?parentID=`.
 */
import { opencodeRequest, opencodeValue, ensureApiVersion, unwrap, unwrapList, apiVersionOf } from './http.js'
import { summarizeSession } from './sessions.js'
import { captureTurnBaseline, waitAssistant } from './delegate.js'

export function forkSession(server, sessionId, messageId) {
  return ensureApiVersion(server).then(function () {
    const version = apiVersionOf(server)
    const body = version === '2'
      ? (messageId === undefined || messageId === '' ? {} : { before: messageId })
      : (messageId === undefined || messageId === '' ? {} : { messageID: messageId })
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/fork', {
      method: 'POST',
      body: body,
      timeoutMs: 30000,
    }).then(function (result) {
      const value = result === undefined ? undefined : unwrap(result.value)
      if (result === undefined || result.status !== 200 || value === undefined || typeof value.id !== 'string') {
        throw new Error('opencode: fork failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
      }
      return summarizeSession(value)
    })
  })
}

/**
 * Summarize/compact one session. OpenCode 2 only offers `compact`, which uses
 * the session's own agent/model, so the v1 provider/model arguments are ignored.
 */
export function summarize(server, sessionId, providerID, modelID) {
  return ensureApiVersion(server).then(function () {
    const version = apiVersionOf(server)
    if (version === '2') {
      return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/compact', {
        method: 'POST',
        body: {},
        timeoutMs: 600000,
      }).then(function (result) {
        if (result === undefined || (result.status !== 200 && result.status !== 204)) {
          throw new Error('opencode: compact failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
        }
        return true
      })
    }
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/summarize', {
      method: 'POST',
      body: { providerID: providerID, modelID: modelID },
      timeoutMs: 600000,
    }).then(function (result) {
      if (result === undefined || result.status !== 200) {
        throw new Error('opencode: summarize failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
      }
      return result.value === true
    })
  })
}

/** Run the /init flow (writes AGENTS.md). On v2 it is the built-in `init` command. */
export function initSession(server, sessionId, providerID, modelID) {
  return ensureApiVersion(server).then(function () {
    const version = apiVersionOf(server)
    if (version === '2') {
      return captureTurnBaseline(server, sessionId).then(function (baseline) {
        return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/command', {
          method: 'POST',
          body: { name: 'init', text: '' },
          timeoutMs: 20000,
        }).then(function (accepted) {
          if (accepted === undefined || (accepted.status !== 204 && accepted.status !== 200)) {
            throw new Error('opencode: init failed on ' + server.id + ' session ' + sessionId + ' (status ' + (accepted === undefined ? 'none' : String(accepted.status)) + ')')
          }
          // The command runs asynchronously; wait for the turn so callers know AGENTS.md settled.
          return waitAssistant(server, sessionId, undefined, undefined, 600000, undefined, baseline).then(function () { return true })
        })
      })
    }
    const messageID = 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/init', {
      method: 'POST',
      body: { providerID: providerID, modelID: modelID, messageID: messageID },
      timeoutMs: 600000,
    }).then(function (result) {
      if (result === undefined || result.status !== 200) {
        throw new Error('opencode: init failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
      }
      return true
    })
  })
}

export function sessionChildren(server, sessionId) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) === '2') {
      return opencodeValue(server, '/session?parentID=' + encodeURIComponent(sessionId) + '&limit=200', { timeoutMs: 15000 }).then(function (value) {
        return unwrapList(value)
      })
    }
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/children', { timeoutMs: 15000 }).then(function (result) {
      return result !== undefined && Array.isArray(result.value) ? result.value : []
    })
  }).then(function (list) {
    const rows = list.map(function (session) { return summarizeSession(session) })
    const lines = rows.map(function (row) {
      return '- ' + row.id + ' | ' + row.title + (row.updatedAt === null ? '' : ' | ' + new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16))
    })
    return { count: rows.length, rows: rows, text: lines.length === 0 ? 'no child sessions' : lines.join('\n') }
  })
}