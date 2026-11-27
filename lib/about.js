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
 * Every failure degrades to `latest.status: 'unavailable'` with a reason; the
 * version and repository link stay visible, because they are read from disk.
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
 * `git@github.com:owner/repo.git` (the form this repo pushes with).
 */
export function repositoryWebUrl(repository) {
  const raw = typeof repository === 'string'
    ? repository
    : (repository !== null && typeof repository === 'object' && typeof repository.url === 'string' ? repository.url : '')
  let url = raw.trim().replace(/^git\+/i, '')
  if (url === '') return undefined
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(url)
  if (scp !== null) url = 'https://' + scp[1] + '/' + scp[2]
  url = url.replace(/^ssh:\/\/git@/i, 'https://').replace(/^git:\/\//i, 'https://')
  url = url.replace(/\.git$/i, '').replace(/\/+$/, '')
  return /^https?:\/\//i.test(url) ? url : undefined
}

/** `owner/repo` of a GitHub web URL; undefined for another host or a bad URL. */
export function githubSlug(repository) {
  const match = /^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i.exec(typeof repository === 'string' ? repository : '')
  return match === null ? undefined : match[1] + '/' + match[2]
}

/** `1.2.3`, `v1.2.3` and pre-release tags, normalized without the `v`; undefined otherwise. */
function normalizeVersion(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/^v/i, '') : ''
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : undefined
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

async function githubJson(fetchImpl, url, timeoutMs) {
  const init = { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT } }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(timeoutMs)
  const response = await fetchImpl(url, init)
  if (response === undefined || response === null) throw new Error('GitHub responded nothing')
  if (response.status === 404) return { status: 404, value: undefined }
  if (response.ok !== true) throw new Error('GitHub responded ' + String(response.status))
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
    return { ok: false, checkedAt: checkedAt, error: messageOf(error) }
  }
}

let cached

/** Cached release lookup: 24 h on success, 1 h on failure. */
export function latestRelease(options) {
  const opts = options === undefined || options === null ? {} : options
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  if (cached !== undefined) {
    const ttl = cached.value.ok === true ? RELEASE_TTL_MS : RELEASE_FAIL_TTL_MS
    if (now() - cached.at < ttl) return Promise.resolve(cached.value)
  }
  return fetchLatestRelease(opts).then(function (value) {
    cached = { at: now(), value: value }
    return value
  })
}

/** Test hook: forget the cached lookup. */
export function resetLatestReleaseCache() {
  cached = undefined
}

/** `latest` payload of the About block from a release check. */
export function latestState(current, check) {
  const checkedAt = check !== null && typeof check === 'object' && typeof check.checkedAt === 'number' ? check.checkedAt : Date.now()
  if (check === null || typeof check !== 'object' || check.ok !== true) {
    return { status: 'unavailable', checkedAt: checkedAt, error: check !== null && typeof check === 'object' && typeof check.error === 'string' ? check.error : '无法检查更新' }
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
 * DSH itself can update this installation.
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
    if (request !== undefined && request !== null && request.refresh === true) resetLatestReleaseCache()
    const check = await Promise.resolve(releaseSource({ repository: packageInfo.repository }))
    const payload = { ok: true, plugin: packageInfo, latest: latestState(packageInfo.version, check) }
    const install = await readInstall()
    if (install !== undefined) payload.install = install
    return payload
  }
}