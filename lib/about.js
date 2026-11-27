/**
 * The plugin's own identity and "is a newer release published?" for the About
 * block on the board page and in the plugin settings section.
 *
 * Version and repository come from this package's package.json — the single
 * source of truth, so the browser bundle never hardcodes them. The newest
 * release comes from the GitHub Releases API (the plugin is published as
 * GitHub releases, not on npm), cached like the OpenCode upgrade badge
 * (24 h on success, 1 h on failure): the unauthenticated GitHub limit is
 * 60 requests/hour/IP, and a page poll must never spend it.
 *
 * Concurrent lookups share one in-flight request, and a failed check keeps the
 * last known version (marked `stale`) instead of blanking the update hint. Every
 * failure degrades to `latest.status: 'unavailable'` with a user-readable
 * reason; the version and repository link stay visible, because they are read
 * from disk.
 */

import { readFileSync } from 'node:fs'
import { compareVersions } from './version.js'

export const RELEASE_TTL_MS = 86400000
export const RELEASE_FAIL_TTL_MS = 3600000
const GITHUB_API = 'https://api.github.com'
const FETCH_TIMEOUT_MS = 6000
const USER_AGENT = 'dsh-opencode-client'

/** This package's manifest as the About block needs it; `url` exists for tests. */
export function readPackageInfo(url) {
  const source = url === undefined ? new URL('../package.json', import.meta.url) : url
  const manifest = JSON.parse(readFileSync(source, 'utf8'))
  const info = {
    name: typeof manifest.name === 'string' ? manifest.name : 'dsh-opencode-client',
    version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
  }
  const repository = repositoryWebUrl(manifest.repository)
  if (repository !== undefined) info.repository = repository
  if (typeof manifest.license === 'string') info.license = manifest.license
  if (typeof manifest.homepage === 'string') info.homepage = manifest.homepage
  return info
}

/**
 * A manifest `repository` field as a browsable https URL, or undefined. Handles
 * a plain string, `{ url }`, `git+https://…git` and scp-like
 * `git@github.com:owner/repo.git` (the form this repo pushes with). A
 * `#fragment`, query or trailing slash is dropped, and so is `.git`.
 */
export function repositoryWebUrl(repository) {
  const raw = typeof repository === 'string'
    ? repository
    : (repository !== null && typeof repository === 'object' && typeof repository.url === 'string' ? repository.url : '')
  let text = raw.trim().replace(/^git\+/i, '')
  if (text === '') return undefined
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(text)
  if (scp !== null) text = 'https://' + scp[1] + '/' + scp[2]
  text = text.replace(/^ssh:\/\/git@/i, 'https://').replace(/^git:\/\//i, 'https://')
  let parsed
  try {
    parsed = new URL(text)
  } catch (error) {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  let path = parsed.pathname.replace(/\/+$/, '')
  if (/\.git$/i.test(path)) path = path.slice(0, -4).replace(/\/+$/, '')
  if (path === '' || path === '/') return undefined
  return parsed.origin + path
}

/** `owner/repo` of a GitHub repository URL; undefined for another host or a bad URL. */
export function githubSlug(repository) {
  const web = repositoryWebUrl(repository)
  if (web === undefined) return undefined
  const parsed = new URL(web)
  if (parsed.host.toLowerCase() !== 'github.com') return undefined
  const segments = parsed.pathname.split('/').filter(function (segment) { return segment !== '' })
  return segments.length >= 2 ? segments[0] + '/' + segments[1] : undefined
}

/** `1.2.3`, `v1.2.3` and pre-release tags, normalized without the `v`; undefined otherwise. */
function normalizeVersion(raw) {
  let text = typeof raw === 'string' ? raw.trim().replace(/^v/i, '') : ''
  // Build metadata (`+sha`) never affects precedence, and compareVersions()
  // cannot order it (Number('3+sha') is NaN, which compares equal): drop it.
  const build = text.indexOf('+')
  if (build !== -1) text = text.slice(0, build)
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(text) ? text : undefined
}

/** One release payload as `{ version, url, publishedAt }`; undefined when unreadable. */
export function parseRelease(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : (typeof payload.name === 'string' ? payload.name : '')
  const version = normalizeVersion(tag)
  if (version === undefined) return undefined
  const release = { version: version }
  if (typeof payload.html_url === 'string') release.url = payload.html_url
  if (typeof payload.published_at === 'string') release.publishedAt = payload.published_at
  return release
}

/** The highest version among `/tags` entries, as `{ version, tag }`; undefined when none parse. */
export function parseTags(payload) {
  if (!Array.isArray(payload)) return undefined
  let best
  for (const entry of payload) {
    const tag = entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : ''
    const version = normalizeVersion(tag)
    if (version === undefined) continue
    if (best === undefined || compareVersions(version, best.version) > 0) best = { version: version, tag: tag }
  }
  return best
}

function messageOf(error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
}

/** User-readable reason for a rejected GitHub response. */
function githubFailure(status) {
  if (status === 403 || status === 429) return 'GitHub 接口限流，请稍后再试'
  return 'GitHub 返回 ' + String(status)
}

/** User-readable reason for a transport or payload failure. */
function networkFailure(error) {
  const text = messageOf(error)
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPIPE|fetch failed|network/i.test(text)) return '无法连接 GitHub（网络问题）'
  if (/abort|timeout/i.test(text)) return '连接 GitHub 超时'
  if (/JSON|Unexpected token/i.test(text)) return 'GitHub 返回了无法解析的内容'
  return text
}

async function githubJson(fetchImpl, url, timeoutMs) {
  const init = { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT } }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(url, init)
  if (response === undefined || response === null) throw new Error('GitHub 无响应')
  if (response.status === 404) return { status: 404, value: undefined }
  if (response.ok !== true) {
    const error = new Error(githubFailure(response.status))
    error.status = response.status
    throw error
  }
  return { status: response.status, value: await response.json() }
}

/**
 * Ask GitHub for the newest release; `/releases/latest` excludes drafts and
 * pre-releases, and repositories without releases fall back to their tags.
 * Returns `{ ok: true, version, url, publishedAt, checkedAt }` or
 * `{ ok: false, checkedAt, error }` — never throws.
 */
export async function fetchLatestRelease(options) {
  const opts = options === undefined || options === null ? {} : options
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : FETCH_TIMEOUT_MS
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const checkedAt = now()
  const slug = githubSlug(opts.repository)
  if (slug === undefined) return { ok: false, checkedAt: checkedAt, error: 'package.json 没有 GitHub 仓库地址' }
  if (typeof fetchImpl !== 'function') return { ok: false, checkedAt: checkedAt, error: 'fetch is unavailable' }
  try {
    const latest = await githubJson(fetchImpl, GITHUB_API + '/repos/' + slug + '/releases/latest', timeoutMs)
    const release = latest.status === 404 ? undefined : parseRelease(latest.value)
    if (release !== undefined) return Object.assign({ ok: true, checkedAt: checkedAt }, release)
    const tags = await githubJson(fetchImpl, GITHUB_API + '/repos/' + slug + '/tags?per_page=100', timeoutMs)
    const tag = tags.status === 404 ? undefined : parseTags(tags.value)
    if (tag === undefined) return { ok: false, checkedAt: checkedAt, error: 'GitHub 没有可用的版本标签' }
    return { ok: true, checkedAt: checkedAt, version: tag.version, url: 'https://github.com/' + slug + '/releases/tag/' + tag.tag }
  } catch (error) {
    const status = error !== null && typeof error === 'object' && typeof error.status === 'number' ? error.status : undefined
    return { ok: false, checkedAt: checkedAt, error: status === undefined ? networkFailure(error) : messageOf(error) }
  }
}

let cached
let pending
let lastGood

/** The last successful `{ version, url, publishedAt }`, filled by latestRelease(). */
function rememberGood(value) {
  lastGood = { version: value.version, url: value.url, publishedAt: value.publishedAt }
}

/** A failed check keeps the last known version, marked `stale`, so the hint survives an outage. */
function withLastGood(value) {
  if (value.ok === true || lastGood === undefined) return value
  return Object.assign({}, value, lastGood, { stale: true })
}

/**
 * Cached release lookup: 24 h on success, 1 h on failure. Concurrent callers
 * share one in-flight request; `force: true` (the UI's 重新检查) skips the cache
 * but still joins a request already on the wire.
 */
export function latestRelease(options) {
  const opts = options === undefined || options === null ? {} : options
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  if (opts.force !== true && cached !== undefined) {
    const ttl = cached.value.ok === true ? RELEASE_TTL_MS : RELEASE_FAIL_TTL_MS
    if (now() - cached.at < ttl) return Promise.resolve(cached.value)
  }
  if (pending !== undefined) return pending
  pending = fetchLatestRelease(opts).then(function (value) {
    const merged = withLastGood(value)
    if (value.ok === true) rememberGood(value)
    cached = { at: now(), value: merged }
    pending = undefined
    return merged
  }, function (error) {
    pending = undefined
    throw error
  })
  return pending
}

/** Test hook: forget the cached lookup, the in-flight request and the last good version. */
export function resetLatestReleaseCache() {
  cached = undefined
  pending = undefined
  lastGood = undefined
}

/**
 * `latest` payload of the About block from a release check. A check that failed
 * after an earlier success keeps `version`/`url` and adds `stale: true`.
 */
export function latestState(current, check) {
  const checkedAt = check !== null && typeof check === 'object' && typeof check.checkedAt === 'number' ? check.checkedAt : Date.now()
  if (check === null || typeof check !== 'object' || check.ok !== true || typeof check.version !== 'string' || check.version === '') {
    const error = check !== null && typeof check === 'object' && typeof check.error === 'string' ? check.error : '无法检查更新'
    const state = { status: 'unavailable', checkedAt: checkedAt, error: error }
    if (check !== null && typeof check === 'object' && typeof check.version === 'string' && check.version !== '') {
      state.version = check.version
      if (check.stale === true) state.stale = true
      if (typeof check.url === 'string') state.url = check.url
      if (typeof check.publishedAt === 'string') state.publishedAt = check.publishedAt
    }
    return state
  }
  const state = {
    status: compareVersions(check.version, current) > 0 ? 'update-available' : 'latest',
    version: check.version,
    checkedAt: checkedAt,
  }
  if (typeof check.url === 'string') state.url = check.url
  if (typeof check.publishedAt === 'string') state.publishedAt = check.publishedAt
  return state
}

/**
 * Build the About payload the client renders.
 *
 * `packageInfo` defaults to this package's manifest (tests pass a URL),
 * `releaseSource` to the cached GitHub lookup, and `manager` returns the Host's
 * `pluginManager` service when the profile has one, so the client knows whether
 * DSH itself can update this installation. The release check and the install
 * lookup run together: reading the profile must not wait on the network.
 */
export function createAbout(options) {
  const opts = options === undefined || options === null ? {} : options
  const packageInfo = opts.packageInfo !== undefined ? opts.packageInfo : readPackageInfo()
  const releaseSource = typeof opts.releaseSource === 'function' ? opts.releaseSource : latestRelease
  const manager = typeof opts.manager === 'function' ? opts.manager : function () { return undefined }

  async function readInstall() {
    try {
      const service = manager()
      if (service === undefined || service === null || typeof service.listBundles !== 'function') return undefined
      const bundles = await service.listBundles()
      if (!Array.isArray(bundles)) return undefined
      const own = bundles.find(function (bundle) {
        return bundle !== null && typeof bundle === 'object' && bundle.name === packageInfo.name
      })
      if (own === undefined) return undefined
      const install = {}
      if (typeof own.source === 'string') install.source = own.source
      install.update = typeof own.update === 'string' ? own.update : null
      return install
    } catch (error) {
      return undefined
    }
  }

  return async function about(request) {
    const force = request !== undefined && request !== null && request.refresh === true
    const results = await Promise.all([
      Promise.resolve(releaseSource({ repository: packageInfo.repository, force: force })),
      readInstall(),
    ])
    const payload = { ok: true, plugin: packageInfo, latest: latestState(packageInfo.version, results[0]) }
    if (results[1] !== undefined) payload.install = results[1]
    return payload
  }
}