/**
 * In-memory observation registry for OpenCode sessions.
 *
 * One row per `(server, session)`, derived from three sources with a fixed
 * priority: pending snapshots > SSE increments > running snapshots. Nothing is
 * persisted: every row can be rebuilt from the snapshots, so the registry can
 * never drift into a second source of truth.
 *
 * Status precedence: waiting-permission > waiting-question > error > running >
 * idle > unknown. `stale` is a flag, not a status: a running row that stopped
 * receiving events keeps saying `running` instead of silently claiming `idle`.
 */

export const OBSERVATION_STATUSES = Object.freeze([
  'waiting-permission',
  'waiting-question',
  'error',
  'running',
  'idle',
  'unknown',
])

const KEY_SEP = '\u0000'

/** Composite key: OpenCode v2 session ids are unique per server, not across servers. */
export function observationKey(serverId, sessionId) {
  return String(serverId) + KEY_SEP + String(sessionId)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Short human description of a pending request, safe to render in one line. */
export function describePending(kind, data) {
  if (!isObject(data)) return kind
  if (kind === 'form') {
    const form = isObject(data.form) ? data.form : data
    const questions = Array.isArray(form.questions) ? form.questions : []
    const first = questions.find(function (item) { return isObject(item) && typeof item.text === 'string' })
    if (first !== undefined) return 'form: ' + first.text.slice(0, 120)
    if (typeof form.title === 'string') return 'form: ' + form.title.slice(0, 120)
    return 'form'
  }
  const action = textOf(data.action) ?? textOf(data.permission)
  const resources = Array.isArray(data.resources) ? data.resources : (Array.isArray(data.patterns) ? data.patterns : [])
  const detail = resources.filter(function (item) { return typeof item === 'string' }).join(', ')
  const head = action === undefined ? 'permission' : action
  return detail === '' ? head : head + ' (' + detail.slice(0, 120) + ')'
}

/** Create one registry. `now` and `staleAfterMs` are injectable for tests. */
export function createObservation(options) {
  const opts = isObject(options) ? options : {}
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const staleAfterMs = typeof opts.staleAfterMs === 'number' && opts.staleAfterMs > 0 ? opts.staleAfterMs : 90000
  const sessions = new Map()
  const byRequest = new Map()

  function ensure(serverId, sessionId) {
    const key = observationKey(serverId, sessionId)
    let entry = sessions.get(key)
    if (entry === undefined) {
      entry = {
        serverId: serverId,
        sessionId: sessionId,
        parentID: undefined,
        title: undefined,
        directory: undefined,
        updatedAt: undefined,
        running: undefined,
        error: false,
        pending: null,
        progress: null,
        lastEventAt: undefined,
        lastSnapshotAt: undefined,
        since: now(),
        status: 'unknown',
      }
      sessions.set(key, entry)
    }
    return entry
  }

  /** Merge identity fields from a `/session` row (title, cwd, parent, updated time). */
  function observeIdentity(serverId, summary) {
    if (!isObject(summary)) return undefined
    const sessionId = textOf(summary.id) ?? textOf(summary.sessionId)
    if (sessionId === undefined) return undefined
    const entry = ensure(serverId, sessionId)
    if (textOf(summary.title) !== undefined) entry.title = summary.title
    const directory = textOf(summary.directory) ?? (isObject(summary.location) ? textOf(summary.location.directory) : undefined)
    if (directory !== undefined) entry.directory = directory
    const parentID = textOf(summary.parentID)
    if (parentID !== undefined) entry.parentID = parentID
    const updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : (isObject(summary.time) && typeof summary.time.updated === 'number' ? summary.time.updated : undefined)
    if (updatedAt !== undefined) entry.updatedAt = updatedAt
    return entry
  }

  /**
   * Seed liveness from `/session/active` (v2) or `/session/status` (v1).
   * `ok === false` means the snapshot failed: rows keep their previous value
   * instead of being declared idle.
   */
  function observeRunning(serverId, runningIds, ok) {
    const ids = runningIds instanceof Set ? runningIds : new Set(Array.isArray(runningIds) ? runningIds : Object.keys(runningIds ?? {}))
    if (ok === false) return
    const at = now()
    for (const entry of sessions.values()) {
      if (entry.serverId !== serverId) continue
      entry.running = ids.has(entry.sessionId)
      entry.lastSnapshotAt = at
    }
    for (const id of ids) {
      const entry = ensure(serverId, id)
      entry.running = true
      entry.lastSnapshotAt = at
    }
  }

  /** Replace the pending set of one server from a full snapshot. */
  function observePendingSnapshot(serverId, entries) {
    const seen = new Set()
    for (const item of Array.isArray(entries) ? entries : []) {
      if (!isObject(item)) continue
      const sessionId = textOf(item.sessionId)
      if (sessionId === undefined) continue
      const pending = { kind: item.kind === 'form' ? 'form' : 'permission', requestId: textOf(item.requestId), detail: textOf(item.detail) ?? '', at: typeof item.at === 'number' ? item.at : now() }
      if (pending.requestId === undefined) continue
      seen.add(serverId + KEY_SEP + pending.requestId)
      markPending(serverId, sessionId, pending)
    }
    for (const [requestKey, entryKey] of byRequest.entries()) {
      if (!requestKey.startsWith(String(serverId) + KEY_SEP)) continue
      if (seen.has(requestKey)) continue
      clearPendingByKey(entryKey, requestKey)
    }
  }

  function indexPending(serverId, sessionId, pending) {
    const entry = ensure(serverId, sessionId)
    const previous = entry.pending
    if (previous !== null && previous.requestId !== undefined && previous.requestId !== pending.requestId) {
      byRequest.delete(serverId + KEY_SEP + previous.requestId)
    }
    entry.pending = pending
    if (pending.requestId !== undefined) byRequest.set(serverId + KEY_SEP + pending.requestId, observationKey(serverId, sessionId))
  }

  /** Record one pending request without answering it. */
  function markPending(serverId, sessionId, pending) {
    if (!isObject(pending) || textOf(sessionId) === undefined) return undefined
    indexPending(serverId, sessionId, {
      kind: pending.kind === 'form' ? 'form' : 'permission',
      requestId: textOf(pending.requestId),
      detail: textOf(pending.detail) ?? '',
      at: typeof pending.at === 'number' ? pending.at : now(),
    })
    return sessions.get(observationKey(serverId, sessionId))
  }

  function clearPendingByKey(entryKey, requestKey) {
    const entry = sessions.get(entryKey)
    if (entry !== undefined && entry.pending !== null && entry.pending.requestId !== undefined && entryKey === observationKey(entry.serverId, entry.sessionId)) {
      if (requestKey === entry.serverId + KEY_SEP + entry.pending.requestId) entry.pending = null
    }
    byRequest.delete(requestKey)
  }

  /** Drop one pending request, by request id (reply seen) or by session. */
  function resolvePending(serverId, requestId, sessionId) {
    if (textOf(requestId) !== undefined) {
      const requestKey = String(serverId) + KEY_SEP + requestId
      const entryKey = byRequest.get(requestKey)
      if (entryKey !== undefined) {
        const entry = sessions.get(entryKey)
        if (entry !== undefined && entry.pending !== null && entry.pending.requestId === requestId) entry.pending = null
        byRequest.delete(requestKey)
      }
      return
    }
    if (textOf(sessionId) !== undefined) {
      const entry = sessions.get(observationKey(serverId, sessionId))
      if (entry !== undefined && entry.pending !== null) {
        if (entry.pending.requestId !== undefined) byRequest.delete(String(serverId) + KEY_SEP + entry.pending.requestId)
        entry.pending = null
      }
    }
  }

  /** Apply one canonical SSE event (`lib/events.js` shape). */
  function observeEvent(serverId, event) {
    if (!isObject(event)) return
    const sessionId = textOf(event.sessionId)
    if (sessionId === undefined) return
    const entry = ensure(serverId, sessionId)
    const at = typeof event.at === 'number' ? event.at : now()
    const data = isObject(event.data) ? event.data : {}
    entry.lastEventAt = at
    switch (event.kind) {
      case 'run.started':
        entry.running = true
        entry.error = false
        break
      case 'run.finished':
        entry.running = false
        entry.error = data.outcome === 'failed'
        entry.progress = null
        break
      case 'session.status': {
        const status = data.status
        if (typeof status === 'string') {
          entry.running = status !== 'idle'
          if (entry.running === false) entry.progress = null
        }
        break
      }
      case 'session.deleted':
        forget(serverId, sessionId)
        return
      case 'tool.started':
      case 'tool.progress':
        entry.progress = { status: 'tool', tool: textOf(data.tool) ?? (entry.progress === null ? undefined : entry.progress.tool), tail: '' }
        break
      case 'tool.finished':
        entry.progress = { status: data.ok === true ? 'tool-done' : 'tool-failed', tool: entry.progress === null ? undefined : entry.progress.tool, tail: typeof data.tail === 'string' ? data.tail.slice(-400) : '' }
        break
      case 'text.delta':
        entry.progress = { status: 'text', tool: entry.progress === null ? undefined : entry.progress.tool, tail: (typeof data.delta === 'string' ? data.delta : '').slice(-400) }
        break
      case 'permission.asked':
        markPending(serverId, sessionId, { kind: 'permission', requestId: textOf(data.id) ?? textOf(data.requestID), detail: describePending('permission', data), at: at })
        break
      case 'question.asked': {
        const form = isObject(data.form) ? data.form : data
        markPending(serverId, sessionId, { kind: 'form', requestId: textOf(form.id) ?? textOf(data.id), detail: describePending('form', data), at: at })
        break
      }
      case 'permission.replied':
        resolvePending(serverId, textOf(data.requestID) ?? textOf(data.id), sessionId)
        break
      case 'question.replied':
      case 'question.rejected':
        resolvePending(serverId, textOf(data.id), sessionId)
        break
      default:
        break
    }
  }

  function forget(serverId, sessionId) {
    const key = observationKey(serverId, sessionId)
    const entry = sessions.get(key)
    if (entry !== undefined && entry.pending !== null && entry.pending.requestId !== undefined) {
      byRequest.delete(String(serverId) + KEY_SEP + entry.pending.requestId)
    }
    sessions.delete(key)
  }

  function forgetServer(serverId) {
    for (const [key, entry] of Array.from(sessions.entries())) {
      if (entry.serverId === serverId) sessions.delete(key)
    }
    for (const requestKey of Array.from(byRequest.keys())) {
      if (requestKey.startsWith(String(serverId) + KEY_SEP)) byRequest.delete(requestKey)
    }
  }

  /** Derived status for one entry, honoring the fixed precedence. */
  function statusOf(entry) {
    if (entry.pending !== null) return entry.pending.kind === 'form' ? 'waiting-question' : 'waiting-permission'
    if (entry.error === true) return 'error'
    if (entry.running === true) return 'running'
    if (entry.running === false) return 'idle'
    return 'unknown'
  }

  function view(entry, at) {
    const status = statusOf(entry)
    if (status !== entry.status) {
      entry.status = status
      entry.since = at
    }
    // Freshness is "the newest of a successful snapshot and an SSE event": a
    // running row whose snapshot still answers is not stale even without events.
    const hasSeen = typeof entry.lastEventAt === 'number' || typeof entry.lastSnapshotAt === 'number'
    const seenAt = Math.max(typeof entry.lastEventAt === 'number' ? entry.lastEventAt : -Infinity, typeof entry.lastSnapshotAt === 'number' ? entry.lastSnapshotAt : -Infinity)
    const stale = status === 'running' && hasSeen && at - seenAt > staleAfterMs
    return {
      serverId: entry.serverId,
      sessionId: entry.sessionId,
      parentID: entry.parentID,
      title: entry.title,
      directory: entry.directory,
      updatedAt: entry.updatedAt,
      status: status,
      since: entry.since,
      lastEventAt: entry.lastEventAt,
      stale: stale,
      progress: entry.progress,
      pending: entry.pending,
      childCount: 0,
      childRunning: 0,
    }
  }

  /** All rows for one server (or every server). Child sessions keep their parentID. */
  function rows(serverId) {
    const at = now()
    const out = []
    for (const entry of sessions.values()) {
      if (serverId !== undefined && entry.serverId !== serverId) continue
      out.push(view(entry, at))
    }
    return out
  }

  function byKey(list) {
    const map = new Map()
    for (const row of list) map.set(observationKey(row.serverId, row.sessionId), row)
    return map
  }

  /**
   * Board projection: needs-me first (oldest wait first), then running, then a
   * capped idle list. Child sessions do not get their own row while the parent
   * is known; they are counted on it instead.
   */
  function board(options) {
    const opts2 = isObject(options) ? options : {}
    const idleLimit = typeof opts2.idleLimit === 'number' && opts2.idleLimit >= 0 ? opts2.idleLimit : 20
    const at = now()
    const all = rows()
    const map = byKey(all)
    for (const row of all) {
      if (row.parentID === undefined) continue
      const parent = map.get(observationKey(row.serverId, row.parentID))
      if (parent === undefined) continue
      parent.childCount += 1
      if (row.status === 'running' || row.status === 'waiting-permission' || row.status === 'waiting-question') parent.childRunning += 1
    }
    const top = all.filter(function (row) {
      if (row.parentID === undefined) return true
      return map.get(observationKey(row.serverId, row.parentID)) === undefined
    })
    const needsMe = top.filter(function (row) { return row.status === 'waiting-permission' || row.status === 'waiting-question' })
    needsMe.sort(function (a, b) { return (a.pending === null ? 0 : a.pending.at) - (b.pending === null ? 0 : b.pending.at) })
    const running = top.filter(function (row) { return row.status === 'running' })
    running.sort(function (a, b) { return a.since - b.since })
    const idle = top.filter(function (row) { return row.status === 'idle' })
    idle.sort(function (a, b) { return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) })
    const unknown = top.filter(function (row) { return row.status === 'unknown' || row.status === 'error' })
    return {
      at: at,
      needsMe: needsMe,
      running: running,
      idle: idleLimit === 0 ? [] : idle.slice(0, idleLimit),
      idleCount: idle.length,
      unknown: unknown,
    }
  }

  return {
    observeIdentity: observeIdentity,
    observeRunning: observeRunning,
    observePendingSnapshot: observePendingSnapshot,
    observeEvent: observeEvent,
    markPending: markPending,
    resolvePending: resolvePending,
    forget: forget,
    forgetServer: forgetServer,
    statusOf: statusOf,
    rows: rows,
    board: board,
    size: function () { return sessions.size },
  }
}