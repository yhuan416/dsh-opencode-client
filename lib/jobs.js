/**
 * Background jobs of OpenCode 2 (`GET /experimental/job`).
 *
 * This is the only place the plugin can see work that outlives an agent turn:
 * when an agent starts a background shell, the session itself goes `idle`
 * (`time.idle` set, `/session/active` empty, execution `succeeded`) while the
 * script keeps running. OpenCode exposes those jobs here — verified on 2.3.0:
 * a weekly-report python job ran for 9+ minutes with the session already idle.
 *
 * The endpoint is experimental, so any failure degrades to `supported: false`
 * and the board simply shows no background rows; it must never affect the rest
 * of the observation. v1 has no equivalent endpoint (frozen, no calls).
 */
import { ensureApiVersion, opencodeValue, apiVersionOf } from './http.js'

/** The board refreshes every 5 s; a shorter cache would only duplicate calls. */
export const JOBS_TTL_MS = 5000
/** A missing/unsupported endpoint is retried rarely, not on every board tick. */
const JOBS_FAIL_TTL_MS = 30000

function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Normalize one `Job.Info` (shell | subagent | image) into the row shape. */
function normalizeJob(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const sessionID = textOf(raw.sessionID) ?? textOf(raw.sessionId)
  if (sessionID === undefined) return undefined
  const time = raw.time !== null && typeof raw.time === 'object' ? raw.time : {}
  return {
    id: textOf(raw.id),
    kind: textOf(raw.kind) ?? 'job',
    sessionID: sessionID,
    status: textOf(raw.status) ?? 'running',
    title: textOf(raw.title) ?? textOf(raw.command) ?? '',
    command: textOf(raw.command) ?? '',
    startedAt: typeof time.started === 'number' ? time.started : undefined,
  }
}

/**
 * Running background jobs of one server, grouped by session at the call site.
 * Resolves `{ supported, jobs, error? }` and never rejects.
 */
export function collectJobs(server) {
  const cached = server.jobsCache
  const ttl = cached !== undefined && cached.value.supported === true ? JOBS_TTL_MS : JOBS_FAIL_TTL_MS
  if (cached !== undefined && Date.now() - cached.at < ttl) return Promise.resolve(cached.value)
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      const unsupported = { supported: false, jobs: [] }
      server.jobsCache = { at: Date.now(), value: unsupported }
      return unsupported
    }
    return opencodeValue(server, '/experimental/job?status=running', { timeoutMs: 8000 }).then(function (value) {
      const list = Array.isArray(value) ? value : (value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : [])
      const jobs = list.map(normalizeJob).filter(function (job) {
        return job !== undefined && job.status === 'running'
      })
      const result = { supported: true, jobs: jobs }
      server.jobsCache = { at: Date.now(), value: result }
      return result
    }, function (error) {
      const result = { supported: false, jobs: [], error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
      server.jobsCache = { at: Date.now(), value: result }
      return result
    })
  })
}