/** Session management: fork, summarize, init, children. */
import { opencodeRequest } from './http.js'
import { summarizeSession } from './sessions.js'

export function forkSession(server, sessionId, messageId) {
  const body = messageId === undefined || messageId === '' ? {} : { messageID: messageId }
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/fork', {
    method: 'POST',
    body: body,
    timeoutMs: 30000,
  }).then(function (result) {
    if (result === undefined || result.status !== 200 || result.value === undefined) {
      throw new Error('opencode: fork failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
    }
    return summarizeSession(result.value)
  })
}

export function summarize(server, sessionId, providerID, modelID) {
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
}

export function initSession(server, sessionId, providerID, modelID) {
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
}

export function sessionChildren(server, sessionId) {
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/children', { timeoutMs: 15000 }).then(function (result) {
    const list = result !== undefined && Array.isArray(result.value) ? result.value : []
    const rows = list.map(function (session) { return summarizeSession(session) })
    const lines = rows.map(function (row) {
      return '- ' + row.id + ' | ' + row.title + (row.updatedAt === null ? '' : ' | ' + new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16))
    })
    return { count: rows.length, rows: rows, text: lines.length === 0 ? 'no child sessions' : lines.join('\n') }
  })
}
