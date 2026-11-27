/**
 * Session management: fork, summarize/compact, init, children.
 *
 * v1: `/session/{id}/fork {messageID}`, `/summarize`, `/init`, `/children`.
 * v2: `/fork {before}` returning `{data: Session.Info}`, `/compact` (replaces
 * summarize; the session's own model is used), `init` as the built-in
 * `/command`, and children through `GET /api/session?parentID=`.
 */
import { ocCall } from './oc-client.js'
import { summarizeSession } from './sessions.js'
import { captureTurnBaseline, waitAssistant } from './delegate.js'

export function forkSession(server, sessionId, messageId) {
  const input = { sessionID: sessionId }
  if (typeof messageId === 'string' && messageId !== '') input.before = messageId
  return ocCall(server, function (client, requestOptions) {
    return client.session.fork(input, requestOptions)
  }, 30000).then(function (value) {
    if (value === undefined || value === null || typeof value !== 'object' || typeof value.id !== 'string') {
      throw new Error('opencode: fork failed on ' + server.id + ' session ' + sessionId)
    }
    return summarizeSession(value)
  })
}

/**
 * Summarize/compact one session. OpenCode 2 only offers `compact`, which uses
 * the session's own agent/model, so the v1 provider/model arguments are ignored.
 */
export function summarize(server, sessionId, providerID, modelID) {
  return ocCall(server, function (client, requestOptions) {
    return client.session.compact({ sessionID: sessionId }, requestOptions)
  }, 600000).then(function () { return true })
}

/** Run the /init flow (writes AGENTS.md). On v2 it is the built-in `init` command. */
export function initSession(server, sessionId, providerID, modelID) {
  return captureTurnBaseline(server, sessionId).then(function (baseline) {
    return ocCall(server, function (client, requestOptions) {
      return client.session.command({ sessionID: sessionId, name: 'init', text: '' }, requestOptions)
    }, 20000).then(function () {
      // The command runs asynchronously; wait for the turn so callers know AGENTS.md settled.
      return waitAssistant(server, sessionId, undefined, undefined, 600000, undefined, baseline).then(function () { return true })
    })
  })
}

export function sessionChildren(server, sessionId) {
  return ocCall(server, function (client, requestOptions) {
    return client.session.list({ parentID: sessionId, limit: 200 }, requestOptions)
  }, 15000).then(function (response) {
    return response !== null && typeof response === 'object' && Array.isArray(response.data) ? response.data : []
  }).then(function (list) {
    const rows = list.map(function (session) { return summarizeSession(session) })
    const lines = rows.map(function (row) {
      return '- ' + row.id + ' | ' + row.title + (row.updatedAt === null ? '' : ' | ' + new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16))
    })
    return { count: rows.length, rows: rows, text: lines.length === 0 ? 'no child sessions' : lines.join('\n') }
  })
}