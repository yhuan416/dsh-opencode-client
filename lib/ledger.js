/**
 * Delegation ledger: one row per remote run, kept in memory and bounded.
 *
 * Both delegation paths — the native `opencode-<id>` subagent provider and the
 * `opencode_subagent` tool — open a row when a run starts and close it with the
 * outcome. That is what lets the plugin page (and `opencode_delegations`)
 * answer "what did I delegate, to which server, how long did it take, and why
 * did it fail", which the board cannot: the board shows what a session is doing
 * now, not the runs that already settled.
 *
 * Rows are process-local on purpose. The durable record of a run is the remote
 * session itself; keeping a second history on disk would need pruning rules and
 * a migration, and would drift from the server it describes.
 */

const DEFAULT_MAX = 100
const TASK_CHARS = 240
const ERROR_CHARS = 500

/** Boundary values that dsh treats as an abnormal, but not errored, ending. */
const FAILED_STOP_REASONS = new Set(['error', 'max-tokens', 'refusal'])

export function statusOf(stopReason) {
  if (stopReason === 'aborted') return 'aborted'
  if (FAILED_STOP_REASONS.has(stopReason)) return 'failed'
  return 'ok'
}

function text(value, max) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed
}

function messageOf(error) {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return text(error, ERROR_CHARS)
  if (typeof error === 'object' && typeof error.message === 'string') return text(error.message, ERROR_CHARS)
  return text(String(error), ERROR_CHARS)
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * @param options.max - rows kept (oldest dropped first); default 100.
 */
export function createLedger(options) {
  const settings = options === undefined || options === null ? {} : options
  const max = positiveInt(settings.max, DEFAULT_MAX)
  let seq = 0
  /** Newest first. */
  const rows = []

  /** Open a row for a run that is starting. */
  function begin(fields) {
    const value = fields === undefined || fields === null ? {} : fields
    const row = {
      id: ++seq,
      kind: value.kind === 'delegate' ? 'delegate' : 'subagent',
      server: typeof value.server === 'string' ? value.server : String(value.server === undefined ? '' : value.server),
      sessionId: typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : null,
      task: text(value.task, TASK_CHARS),
      label: text(value.label, 120),
      directory: text(value.directory, 240),
      model: text(value.model, 120),
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      stopReason: null,
      durationMs: null,
      error: null,
    }
    rows.unshift(row)
    if (rows.length > max) rows.length = max
    return row
  }

  /** Fill in the session id once the remote session exists. */
  function attach(row, sessionId) {
    if (row !== null && typeof row === 'object' && row.endedAt === null && typeof sessionId === 'string' && sessionId !== '') row.sessionId = sessionId
    return row
  }

  /** Close a row with its outcome; a second close is a no-op. */
  function finish(row, outcome) {
    if (row === null || typeof row !== 'object' || row.endedAt !== null) return row
    const value = outcome === undefined || outcome === null ? {} : outcome
    const stopReason = typeof value.stopReason === 'string' && value.stopReason !== '' ? value.stopReason : 'completed'
    row.endedAt = Date.now()
    row.durationMs = row.endedAt - row.startedAt
    row.stopReason = stopReason
    row.status = statusOf(stopReason)
    row.error = messageOf(value.error)
    return row
  }

  function matches(row, query) {
    if (query.server !== undefined && row.server !== query.server) return false
    if (query.status !== undefined && row.status !== query.status) return false
    if (query.since !== undefined && row.startedAt < query.since) return false
    return true
  }

  /**
   * Read rows plus a summary over the same filter.
   * @param query - `{ server, status, since, limit }`; `limit` caps returned rows only.
   */
  function list(query) {
    const value = query === undefined || query === null ? {} : query
    const filter = {
      server: typeof value.server === 'string' && value.server !== '' ? value.server : undefined,
      status: typeof value.status === 'string' && value.status !== '' ? value.status : undefined,
      since: typeof value.since === 'number' && Number.isFinite(value.since) ? value.since : undefined,
    }
    const matched = rows.filter(function (row) { return matches(row, filter) })
    const summary = { total: matched.length, running: 0, ok: 0, failed: 0, aborted: 0, byServer: [] }
    const perServer = new Map()
    for (const row of matched) {
      summary[row.status] = (summary[row.status] === undefined ? 0 : summary[row.status]) + 1
      const bucket = perServer.get(row.server) === undefined ? { server: row.server, total: 0, failed: 0, avgMs: null, _sum: 0, _settled: 0 } : perServer.get(row.server)
      bucket.total += 1
      if (row.status === 'failed') bucket.failed += 1
      if (typeof row.durationMs === 'number') {
        bucket._sum += row.durationMs
        bucket._settled += 1
      }
      perServer.set(row.server, bucket)
    }
    for (const bucket of perServer.values()) {
      if (bucket._settled > 0) bucket.avgMs = Math.round(bucket._sum / bucket._settled)
      delete bucket._sum
      delete bucket._settled
      summary.byServer.push(bucket)
    }
    summary.byServer.sort(function (left, right) { return right.total - left.total })
    const limit = positiveInt(value.limit, matched.length)
    return { rows: matched.slice(0, limit), summary }
  }

  function clear() {
    rows.length = 0
  }

  function size() {
    return rows.length
  }

  return { begin: begin, attach: attach, finish: finish, list: list, clear: clear, size: size }
}