/**
 * Shared observation refresher behind `/api/opencode-client/board`, the `/list`
 * per-row status and the `opencode_board` agent tool: one implementation, so the
 * page and the model can never disagree about who is running or waiting.
 */
import { collectServer, collectStatus, collectPending } from './sessions.js'
import { collectJobs } from './jobs.js'

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
    let listing
    return collectServer(server, {
      onListing: function (value) { listing = value },
    }).then(function (value) {
      serverInfo.set(server.id, {
        version: typeof value.version === 'string' ? value.version : null,
        state: typeof value.state === 'string' ? value.state : 'offline',
        groups: Array.isArray(value.projects) ? value.projects.length : 0,
      })
      // A listing raced by a deletion still contains that session; applying it
      // would observe the dead row straight back onto the board.
      const raced = value !== null && typeof value === 'object' && value.raced === true
      if (raced !== true) {
        const groups = Array.isArray(value.projects) ? value.projects : []
        for (const group of groups) {
          const sessions = Array.isArray(group.sessions) ? group.sessions : []
          for (const summary of sessions) observation.observeIdentity(server.id, summary)
        }
      }
      // Jobs are fetched alongside liveness: a background job is the only sign
      // that a session already marked idle is still doing work.
      return Promise.all([
        collectStatus(server).then(function (statuses) { return { ok: true, statuses: statuses } }, function () { return { ok: false } }),
        collectJobs(server),
      ])
    }).then(function (results) {
      const statusResult = results[0]
      const jobs = results[1]
      if (jobs !== undefined && jobs.supported === true) observation.observeJobs(server.id, jobs.jobs)
      // Sessions deleted while the stream was down must not stay on the board:
      // a fresh complete listing is the authoritative membership set. Run the
      // prune after the pending snapshot below, or a stale pending entry for the
      // deleted session would re-create the row we just removed.
      function prune(entries) {
        // A truncated listing has no membership guarantee: prune only with a
        // proven page boundary, never by absence alone.
        const bounded = listing !== undefined && (listing.truncated !== true || typeof listing.minUpdatedAt === 'number')
        if (bounded) {
          observation.retain(server.id, listing.ids, {
            since: listing.requestedAt,
            olderThan: listing.truncated === true ? listing.minUpdatedAt : undefined,
          })
        }
        return entries
      }
      if (statusResult.ok !== true) {
        observation.observeRunning(server.id, new Set(), false)
        return prune([])
      }
      const statuses = statusResult.statuses
      const runningIds = new Set(Object.keys(statuses).filter(function (sessionId) {
        const status = statuses[sessionId]
        return status !== null && typeof status === 'object' && status.type !== 'idle'
      }))
      observation.observeRunning(server.id, runningIds, true)
      if (cached !== undefined && startedAt - cached.at < 5000) return prune(cached.value)
      return collectPending(server, Array.from(runningIds)).then(function (entries) {
        pendingCache.set(server.id, { at: Date.now(), value: entries })
        observation.observePendingSnapshot(server.id, entries)
        return prune(entries)
      }, function () {
        // A failed pending snapshot must not clear what we already know.
        return prune(cached === undefined ? [] : cached.value)
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

  return {
    observation: observation,
    observedById: observedById,
    refreshServer: refreshServer,
    refreshAll: refreshAll,
    snapshot: function (options) { return observation.board(options) },
    serverInfo: function (serverId) { return serverInfo.get(serverId) },
  }
}
