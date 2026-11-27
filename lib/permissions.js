/**
 * Diagnostics for OpenCode permission requests (issue #57).
 *
 * The permission bridge answers most requests itself (host approval card, the
 * configured mode, or "pending" for sessions dsh did not start), so from the
 * outside "the remote never asked" and "the remote asked and dsh answered it
 * silently" look identical. This log keeps, per server, how many requests were
 * seen and how each one was answered, plus a short ring of the latest ones; the
 * board exposes it so a missing approval card can be diagnosed without switching
 * the permission mode to `reject` and retrying.
 */
export function createPermissionLog(options) {
  const limit = options !== null && typeof options === 'object' && typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 20
  const byServer = new Map()

  function stateOf(serverId) {
    let state = byServer.get(serverId)
    if (state === undefined) {
      state = { asked: 0, autoApproved: 0, userApproved: 0, rejected: 0, pending: 0, recent: [] }
      byServer.set(serverId, state)
    }
    return state
  }

  /** @param {{action?:string, resources?:string[], reply:'auto'|'once'|'always'|'reject'|'pending', source?:string, sessionId?:string}} entry */
  function record(serverId, entry) {
    if (typeof serverId !== 'string' || serverId === '') return
    const state = stateOf(serverId)
    state.asked += 1
    if (entry.reply === 'auto') state.autoApproved += 1
    else if (entry.reply === 'reject') state.rejected += 1
    else if (entry.reply === 'pending') state.pending += 1
    else state.userApproved += 1
    state.recent.push({
      at: Date.now(),
      action: entry.action,
      resources: Array.isArray(entry.resources) ? entry.resources : [],
      reply: entry.reply,
      source: entry.source,
      sessionId: entry.sessionId,
    })
    if (state.recent.length > limit) state.recent.shift()
  }

  /** undefined when this server never asked: the board payload stays lean. */
  function snapshot(serverId) {
    const state = byServer.get(serverId)
    if (state === undefined) return undefined
    return {
      asked: state.asked,
      autoApproved: state.autoApproved,
      userApproved: state.userApproved,
      rejected: state.rejected,
      pending: state.pending,
      recent: state.recent.slice(),
    }
  }

  function reset() {
    byServer.clear()
  }

  return { record: record, snapshot: snapshot, reset: reset }
}
