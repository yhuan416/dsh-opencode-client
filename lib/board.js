/**
 * Shared observation refresher behind `/api/opencode-client/board`, the `/list`
 * per-row status and the `opencode_board` agent tool: one implementation, so the
 * page and the model can never disagree about who is running or waiting.
 */
import { collectServer, collectStatus, collectPending } from './sessions.js'

export function createBoard(deps) {
  const servers = deps.servers
  const observation = deps.observation
  const pendingCache = new Map()
  // Per-server facts the settings page shows without pulling the session tree.
  const serverInfo = new Map()

  function observedById(serverId) {
    const map = new Map()
    for (const row of observation.rows(serverId)) map.set(row.sessionId, row)
    return map
  }

  /** Refresh one server's observation: identity, liveness seed, pending snapshot. */
  function refreshServer(server) {
    const startedAt = Date.now()
    const cached = pendingCache.get(server.id)
    return collectServer(server).then(function (value) {
      serverInfo.set(server.id, {
        version: typeof value.version === 'string' ? value.version : null,
        state: typeof value.state === 'string' ? value.state : 'offline',
        groups: Array.isArray(value.projects) ? value.projects.length : 0,
      })
      const groups = Array.isArray(value.projects) ? value.projects : []
      for (const group of groups) {
        const sessions = Array.isArray(group.sessions) ? group.sessions : []
        for (const summary of sessions) observation.observeIdentity(server.id, summary)
      }
      return collectStatus(server)
    }).then(function (statuses) {
      const runningIds = new Set(Object.keys(statuses).filter(function (sessionId) {
        const status = statuses[sessionId]
        return status !== null && typeof status === 'object' && status.type !== 'idle'
      }))
      observation.observeRunning(server.id, runningIds, true)
      if (cached !== undefined && startedAt - cached.at < 5000) return cached.value
      return collectPending(server, Array.from(runningIds)).then(function (entries) {
        pendingCache.set(server.id, { at: Date.now(), value: entries })
        observation.observePendingSnapshot(server.id, entries)
        return entries
      }, function () {
        // A failed pending snapshot must not clear what we already know.
        return cached === undefined ? [] : cached.value
      })
    }, function () {
      // A failed liveness snapshot keeps previous values instead of declaring idle.
      observation.observeRunning(server.id, new Set(), false)
      return []
    })
  }

  function refreshAll() {
    let chain = Promise.resolve()
    for (const server of servers) {
      chain = chain.then(function () { return refreshServer(server) })
    }
    return chain
  }

  function findServer(body) {
    return servers.find(function (candidate) { return candidate.id === String(body === undefined ? '' : body) }) || defaultServer
  }

  return {
    observation: observation,
    observedById: observedById,
    refreshServer: refreshServer,
    refreshAll: refreshAll,
    snapshot: function (options) { return observation.board(options) },
    serverInfo: function (serverId) { return serverInfo.get(serverId) },
  }
}
