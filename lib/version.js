/**
 * "Is a newer OpenCode available?" for the board's server cards.
 *
 * The local OpenCode API has no REST endpoint for this: `/api/info` only reports
 * the installed version, and `installation.update-available` is a *volatile* SSE
 * event (missed if the client was not connected when the server checked). So the
 * badge is driven by the official update service that `opencode upgrade` itself
 * uses. It is plain HTTPS + JSON, cached for an hour; any failure degrades to "no
 * badge" instead of reporting a version we do not know.
 *
 * See docs/plans/2026-11-27-opencode-insights-design.md and the update service
 * README: https://github.com/anomalyco/opencode/blob/dev/services/update/README.md
 */
export const UPDATE_URL = 'https://opencode.ai/update/api/latest/cli/npm'
export const UPDATE_TTL_MS = 3600000
// A failed lookup is retried sooner than a successful one, but not on every poll.
const UPDATE_FAIL_TTL_MS = 300000

/**
 * Compare two version strings (`2.3.0` vs `2.4.2`, `2.4.2-rc.1`). Returns -1, 0
 * or 1. Missing segments count as 0; a pre-release sorts before its release.
 */
export function compareVersions(left, right) {
  const parse = function (value) {
    const text = typeof value === 'string' ? value.trim().replace(/^v/, '') : ''
    const [core, ...rest] = text.split('-')
    const parts = core.split('.').map(function (part) { return Number(part) })
    return { parts: parts, pre: rest.join('-') }
  }
  const a = parse(left)
  const b = parse(right)
  if (a.parts.some(function (part) { return !Number.isFinite(part) }) || b.parts.some(function (part) { return !Number.isFinite(part) })) return 0
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const av = a.parts[index] || 0
    const bv = b.parts[index] || 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre < b.pre ? -1 : 1
}

/**
 * Fetch the latest version. `options.url` / `options.fetchImpl` / `options.timeoutMs`
 * exist for tests; production uses the official endpoint.
 */
export function fetchLatestVersion(options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const url = typeof opts.url === 'string' && opts.url !== '' ? opts.url : UPDATE_URL
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 5000
  if (typeof fetchImpl !== 'function') return Promise.resolve({ ok: false, checkedAt: Date.now(), error: 'fetch is unavailable' })
  return fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) }).then(function (response) {
    if (response === undefined || response.ok !== true) throw new Error('update service responded ' + String(response === undefined ? 'nothing' : response.status))
    return response.json()
  }).then(function (payload) {
    const latest = payload !== null && typeof payload === 'object' && typeof payload.version === 'string' ? payload.version : undefined
    if (latest === undefined) throw new Error('update service returned no version')
    return { ok: true, latest: latest.replace(/^v/, ''), checkedAt: Date.now() }
  }).catch(function (error) {
    const text = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    return { ok: false, checkedAt: Date.now(), error: text }
  })
}

let cached = undefined

/** Cached latest version for the upgrade badge (1 h on success, 5 min on failure). */
export function latestVersion(options) {
  if (cached !== undefined) {
    const ttl = cached.value.ok === true ? UPDATE_TTL_MS : UPDATE_FAIL_TTL_MS
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.value)
  }
  return fetchLatestVersion(options).then(function (value) {
    cached = { at: Date.now(), value: value }
    return value
  })
}

/** Test hook: forget the cached lookup. */
export function resetLatestVersionCache() {
  cached = undefined
}