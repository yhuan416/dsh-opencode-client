/**
 * In-memory observation registry for OpenCode sessions.
 *
 * One row per `(server, session)`, derived from three sources with a fixed
 * priority: pending snapshots > SSE increments > running snapshots. Nothing is
 * persisted: every row can be rebuilt from the snapshots, so the registry can
 * never drift into a second source of truth.
 *
 * Status precedence: waiting-permission > waiting-question > error > running >
 * background > idle > unknown. `background` is a running OpenCode job whose
 * session already went idle (a shell script started from a finished turn); it
 * is the only way to see work that outlives an agent turn. `stale` is a flag,
 * not a status: a running row that stopped receiving events keeps saying
 * `running` instead of silently claiming `idle`.
 */

import { describePending } from './pending-text.js'
import { normalizeTokens } from './sessions.js'

export const OBSERVATION_STATUSES = Object.freeze([
  'waiting-permission',
  'waiting-question',
  'error',
  'running',
  'background',
  'idle',
  'unknown',
])

const KEY_SEP = '\u0000'

/** Composite key: OpenCode v2 session ids are unique per server, not across servers. */
export function observationKey(serverId, sessionId) {
  return String(serverId) + KEY_SEP + String(sessionId)
}

/** Sum two normalized token counters (both already flat: input/output/cacheRead/...). */
function mergeCounters(into, counters) {
  const out = into === undefined ? {} : Object.assign({}, into)
  for (const key of Object.keys(counters)) out[key] = (typeof out[key] === 'number' ? out[key] : 0) + counters[key]
  return out
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Re-exported for the existing call sites/tests; the implementation lives in
 * `lib/pending-text.js` so every pending producer shows the same text. */
export { describePending } from './pending-text.js'

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
        tokens: undefined,
        cost: undefined,
        model: undefined,
        busyAt: undefined,
        idleAt: undefined,
        viewedAt: undefined,
        outcome: undefined,
        updatedAt: undefined,
        running: undefined,
        error: false,
        // A running background job (OpenCode `experimental/job`), independent of
        // `running`: the session can be idle while the job still works.
        job: null,
        jobCount: 0,
        pending: null,
        progress: null,
        // Current run (accumulating `step.ended`) and the frozen copy kept after
        // `run.finished`, so a finished card can say what the run cost and took.
        run: null,
        lastRun: null,
        // "We watched this run end" — the candidate signal for the unseen list.
        // OpenCode only writes `time.viewed` once a session has been opened, so a
        // never-viewed (dsh-created) session has no read marker at all; deriving
        // "unseen" from that alone would silently drop exactly the runs nobody
        // looked at. The marker still decides when it is *cleared*.
        sawFinish: false,
        finishedAt: undefined,
        lastEventAt: undefined,
        lastSnapshotAt: undefined,
        // Local clock of the last SSE proof that this session exists. `retain`
        // uses it (never the remote wire timestamps) to protect sessions that
        // were announced after the listing it is pruning against was requested.
        seenInEventAt: undefined,
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
    if (isObject(summary.tokens)) entry.tokens = summary.tokens
    if (typeof summary.cost === 'number' && Number.isFinite(summary.cost)) entry.cost = summary.cost
    if (textOf(summary.model) !== undefined) entry.model = summary.model
    const directory = textOf(summary.directory) ?? (isObject(summary.location) ? textOf(summary.location.directory) : undefined)
    if (directory !== undefined) entry.directory = directory
    const parentID = textOf(summary.parentID)
    if (parentID !== undefined) entry.parentID = parentID
    const updatedAt = typeof summary.updatedAt === 'number' ? summary.updatedAt : (isObject(summary.time) && typeof summary.time.updated === 'number' ? summary.time.updated : undefined)
    if (updatedAt !== undefined) entry.updatedAt = updatedAt
    // Authoritative on every refresh: OpenCode records the run boundaries and
    // the read marker itself, so the board never has to invent them.
    if (typeof summary.busyAt === 'number') entry.busyAt = summary.busyAt
    if (typeof summary.idleAt === 'number') entry.idleAt = summary.idleAt
    if (typeof summary.viewedAt === 'number') entry.viewedAt = summary.viewedAt
    if (textOf(summary.outcome) !== undefined) entry.outcome = summary.outcome
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
      const wasRunning = entry.running === true
      const isRunning = ids.has(entry.sessionId)
      entry.running = isRunning
      entry.lastSnapshotAt = at
      // Only a real running→idle edge arms the reminder: `undefined → idle` at
      // startup is "we never saw it run", not "it just finished".
      if (wasRunning && !isRunning) { entry.sawFinish = true; entry.finishedAt = at }
      if (!wasRunning && isRunning) { entry.sawFinish = false; entry.finishedAt = undefined }
    }
    for (const id of ids) {
      const entry = ensure(serverId, id)
      entry.running = true
      entry.lastSnapshotAt = at
    }
  }

  /**
   * Replace the background-job view of one server.
   *
   * Jobs are keyed by session and can outlive the turn; one session may own
   * several (shell + image + subagent), so the earliest-started one becomes the
   * row's headline and the rest only contribute to `jobCount`. Absent jobs are
   * cleared, which is how a finished script returns the row to `idle`.
   */
  function observeJobs(serverId, jobs) {
    const list = Array.isArray(jobs) ? jobs : []
    const picked = new Map()
    for (const job of list) {
      if (!isObject(job)) continue
      const sessionId = textOf(job.sessionID) ?? textOf(job.sessionId)
      if (sessionId === undefined) continue
      const normalized = {
        id: textOf(job.id),
        kind: textOf(job.kind) ?? 'job',
        title: textOf(job.title) ?? '',
        command: textOf(job.command) ?? '',
        startedAt: typeof job.startedAt === 'number' ? job.startedAt : undefined,
      }
      const current = picked.get(sessionId)
      if (current === undefined) {
        picked.set(sessionId, { job: normalized, count: 1 })
        continue
      }
      current.count += 1
      if ((normalized.startedAt ?? Infinity) < (current.job.startedAt ?? Infinity)) current.job = normalized
    }
    for (const entry of sessions.values()) {
      if (entry.serverId !== serverId) continue
      entry.job = null
      entry.jobCount = 0
    }
    for (const [sessionId, value] of picked) {
      const entry = ensure(serverId, sessionId)
      entry.job = value.job
      entry.jobCount = value.count
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
    entry.seenInEventAt = now()
    const at = typeof event.at === 'number' ? event.at : now()
    const data = isObject(event.data) ? event.data : {}
    entry.lastEventAt = at
    switch (event.kind) {
      case 'run.started':
        entry.running = true
        entry.error = false
        entry.sawFinish = false
        entry.finishedAt = undefined
        entry.run = { startedAt: at, steps: 0, tokens: undefined, cost: 0, finish: undefined }
        break
      case 'step.ended': {
        // One event per model step: accumulate so a card can report the whole run
        // rather than only its last step.
        const step = entry.run === null ? { startedAt: at, steps: 0, tokens: undefined, cost: 0, finish: undefined } : entry.run
        const tokens = normalizeTokens(data.tokens)
        step.steps += 1
        if (tokens !== undefined) step.tokens = mergeCounters(step.tokens, tokens)
        if (typeof data.cost === 'number' && Number.isFinite(data.cost)) step.cost += data.cost
        if (textOf(data.finish) !== undefined) step.finish = data.finish
        entry.run = step
        break
      }
      case 'step.failed':
        if (entry.run !== null) entry.run.finish = 'error'
        break
      case 'run.finished':
        entry.running = false
        entry.error = data.outcome === 'failed'
        entry.progress = null
        entry.sawFinish = true
        entry.finishedAt = at
        entry.lastRun = entry.run === null ? null : Object.assign({}, entry.run, {
          outcome: textOf(data.outcome) ?? entry.outcome,
          endedAt: at,
        })
        entry.run = null
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

  /** True once the remote read marker has caught up with the last finish. */
  function exitUnread(entry) {
    return typeof entry.viewedAt === 'number' && entry.idleAt !== undefined && entry.viewedAt >= entry.idleAt
  }

  /** Local half of "looked at": stops the reminder even if the remote write fails. */
  function markSeen(serverId, sessionId) {
    const entry = sessions.get(observationKey(serverId, sessionId))
    if (entry === undefined) return false
    entry.sawFinish = false
    entry.finishedAt = undefined
    return true
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

  /**
   * Drop rows whose session is missing from an authoritative session listing for
   * that server. A missed `session.deleted` event (stream reconnect, plugin
   * reload after the deletion) used to leave the row on the board forever; the
   * listing is the backstop.
   *
   * `since` is the local time the listing request started: rows whose existence
   * the event stream proved after it may be too new to be listed and are kept.
   * `olderThan` is set when the listing was truncated: only rows known to
   * predate the oldest listed session may be pruned, so a page limit can never
   * delete sessions that simply fell off the page.
   */
  function retain(serverId, sessionIds, options) {
    const opts = isObject(options) ? options : {}
    const since = typeof opts.since === 'number' ? opts.since : undefined
    const olderThan = typeof opts.olderThan === 'number' ? opts.olderThan : undefined
    const keep = new Set()
    for (const item of Array.isArray(sessionIds) ? sessionIds : []) {
      const sessionId = textOf(item)
      if (sessionId !== undefined) keep.add(sessionId)
    }
    let removed = 0
    for (const entry of Array.from(sessions.values())) {
      if (entry.serverId !== serverId) continue
      if (keep.has(entry.sessionId)) continue
      if (since !== undefined && typeof entry.seenInEventAt === 'number' && entry.seenInEventAt > since) continue
      if (olderThan !== undefined) {
        // Truncated listing: only rows we know predate the page boundary.
        if (typeof entry.updatedAt !== 'number' || !(entry.updatedAt < olderThan)) continue
      }
      forget(serverId, entry.sessionId)
      removed += 1
    }
    return removed
  }

  /** Derived status for one entry, honoring the fixed precedence. */
  function statusOf(entry) {
    if (entry.pending !== null) return entry.pending.kind === 'form' ? 'waiting-question' : 'waiting-permission'
    if (entry.error === true) return 'error'
    if (entry.running === true) return 'running'
    if (entry.job !== null) return 'background'
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
      model: entry.model,
      tokens: entry.tokens,
      cost: entry.cost,
      updatedAt: entry.updatedAt,
      status: status,
      since: entry.since,
      busyAt: entry.busyAt,
      idleAt: entry.idleAt,
      viewedAt: entry.viewedAt,
      outcome: entry.outcome,
      runMs: typeof entry.busyAt === 'number' && typeof entry.idleAt === 'number' && entry.idleAt > entry.busyAt ? entry.idleAt - entry.busyAt : undefined,
      // Armed by the finish we witnessed; cleared once OpenCode says it has been
      // read (`viewed` caught up with `idle`) or dsh reports it seen. v1 has no
      // `idle` marker at all, so the whole partition stays off there.
      unread: status === 'idle' && entry.sawFinish === true && typeof entry.idleAt === 'number' && !exitUnread(entry),
      finishedAt: entry.finishedAt,
      lastRun: entry.lastRun,
      lastEventAt: entry.lastEventAt,
      stale: stale,
      progress: entry.progress,
      pending: entry.pending,
      job: entry.job,
      jobCount: entry.jobCount,
      childCount: 0,
      childRunning: 0,
      childBackground: 0,
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
    const unseenLimit = typeof opts2.unseenLimit === 'number' && opts2.unseenLimit >= 0 ? opts2.unseenLimit : 20
    const at = now()
    const all = rows()
    const map = byKey(all)
    for (const row of all) {
      if (row.parentID === undefined) continue
      const parent = map.get(observationKey(row.serverId, row.parentID))
      if (parent === undefined) continue
      parent.childCount += 1
      if (row.status === 'running' || row.status === 'waiting-permission' || row.status === 'waiting-question') parent.childRunning += 1
      if (row.status === 'background') parent.childBackground += 1
    }
    const top = all.filter(function (row) {
      if (row.parentID === undefined) return true
      return map.get(observationKey(row.serverId, row.parentID)) === undefined
    })
    const needsMe = top.filter(function (row) { return row.status === 'waiting-permission' || row.status === 'waiting-question' })
    needsMe.sort(function (a, b) { return (a.pending === null ? 0 : a.pending.at) - (b.pending === null ? 0 : b.pending.at) })
    const running = top.filter(function (row) { return row.status === 'running' })
    running.sort(function (a, b) { return a.since - b.since })
    // Work that outlived its turn: the session is idle, a job is not. Ordered by
    // when the job started, longest-running first.
    const background = top.filter(function (row) { return row.status === 'background' })
    background.sort(function (a, b) {
      const aStart = a.job !== null && typeof a.job.startedAt === 'number' ? a.job.startedAt : a.since
      const bStart = b.job !== null && typeof b.job.startedAt === 'number' ? b.job.startedAt : b.since
      return aStart - bStart
    })
    // Finished but not looked at: kept out of `idle` (and `idleCount`) so a row
    // never appears twice; ordered newest finish first.
    const unseen = top.filter(function (row) { return row.unread === true })
    unseen.sort(function (a, b) { return (b.idleAt ?? 0) - (a.idleAt ?? 0) })
    const idle = top.filter(function (row) { return row.status === 'idle' && row.unread !== true })
    idle.sort(function (a, b) { return (b.updatedAt ?? 0) - (a.updatedAt ?? 0) })
    const unknown = top.filter(function (row) { return row.status === 'unknown' || row.status === 'error' })
    return {
      at: at,
      needsMe: needsMe,
      unseen: unseenLimit === 0 ? [] : unseen.slice(0, unseenLimit),
      unseenCount: unseen.length,
      running: running,
      background: background,
      backgroundCount: background.length,
      idle: idleLimit === 0 ? [] : idle.slice(0, idleLimit),
      idleCount: idle.length,
      unknown: unknown,
    }
  }

  return {
    observeIdentity: observeIdentity,
    observeRunning: observeRunning,
    observeJobs: observeJobs,
    observePendingSnapshot: observePendingSnapshot,
    observeEvent: observeEvent,
    markPending: markPending,
    markSeen: markSeen,
    resolvePending: resolvePending,
    forget: forget,
    forgetServer: forgetServer,
    retain: retain,
    statusOf: statusOf,
    rows: rows,
    board: board,
    size: function () { return sessions.size },
  }
}