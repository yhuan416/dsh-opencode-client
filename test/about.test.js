/**
 * Offline tests for the About block's data path: package identity, repository
 * URL normalization, the GitHub release lookup with its tag fallback and cache,
 * the status wording, and the route payload. No network: every lookup takes a
 * fake `fetch`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readPackageInfo, repositoryWebUrl, githubSlug, parseRelease, parseTags,
  fetchLatestRelease, latestRelease, resetLatestReleaseCache, latestState, createAbout,
} from '../lib/about.js'

const RELEASE = {
  tag_name: 'v1.2.0',
  html_url: 'https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.2.0',
  published_at: '2026-11-27T11:18:37Z',
  prerelease: false,
  draft: false,
}

/** A fetch that answers per URL suffix and counts its calls. */
function fakeFetch(routes) {
  const calls = []
  const impl = function (url) {
    calls.push(String(url))
    for (const [suffix, answer] of Object.entries(routes)) {
      if (String(url).endsWith(suffix)) {
        if (answer instanceof Error) return Promise.reject(answer)
        return Promise.resolve(answer)
      }
    }
    return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}) } })
  }
  impl.calls = calls
  return impl
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(value) } }
}

test('readPackageInfo reads this package identity', function () {
  const info = readPackageInfo()
  assert.equal(info.name, 'dsh-opencode-client')
  assert.match(info.version, /^\d+\.\d+\.\d+/)
  assert.equal(info.repository, 'https://github.com/yhuan416/dsh-opencode-client')
  assert.equal(info.license, 'MIT')
})

test('repositoryWebUrl normalizes every manifest form', function () {
  const expected = 'https://github.com/yhuan416/dsh-opencode-client'
  assert.equal(repositoryWebUrl('git+https://github.com/yhuan416/dsh-opencode-client.git'), expected)
  assert.equal(repositoryWebUrl('https://github.com/yhuan416/dsh-opencode-client.git'), expected)
  assert.equal(repositoryWebUrl('git@github.com:yhuan416/dsh-opencode-client.git'), expected)
  assert.equal(repositoryWebUrl('ssh://git@github.com/yhuan416/dsh-opencode-client.git'), expected)
  assert.equal(repositoryWebUrl({ type: 'git', url: expected }), expected)
  assert.equal(repositoryWebUrl(''), undefined)
  assert.equal(repositoryWebUrl(undefined), undefined)
  assert.equal(repositoryWebUrl('not a url'), undefined)
})

test('githubSlug only resolves github.com URLs', function () {
  assert.equal(githubSlug('https://github.com/yhuan416/dsh-opencode-client'), 'yhuan416/dsh-opencode-client')
  assert.equal(githubSlug('https://gitlab.com/owner/repo'), undefined)
  assert.equal(githubSlug(undefined), undefined)
})

test('parseRelease normalizes the tag and keeps the release facts', function () {
  assert.deepEqual(parseRelease(RELEASE), {
    version: '1.2.0',
    url: 'https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.2.0',
    publishedAt: '2026-11-27T11:18:37Z',
  })
  assert.equal(parseRelease({ tag_name: 'v1.2.0-rc.1' }).version, '1.2.0-rc.1')
  assert.equal(parseRelease({ name: '1.2.0' }).version, '1.2.0')
  assert.equal(parseRelease({ tag_name: 'nightly' }), undefined)
  assert.equal(parseRelease(null), undefined)
  assert.equal(parseRelease([]), undefined)
})

test('parseTags picks the highest semver tag and ignores the rest', function () {
  const value = parseTags([{ name: 'v1.0.0' }, { name: 'v0.9.9' }, { name: 'latest' }, { name: 'v1.1.0' }])
  assert.deepEqual(value, { version: '1.1.0', tag: 'v1.1.0' })
  assert.equal(parseTags([]), undefined)
  assert.equal(parseTags('nope'), undefined)
})

test('fetchLatestRelease reads releases/latest', async function () {
  const fetchImpl = fakeFetch({ '/releases/latest': jsonResponse(200, RELEASE) })
  const value = await fetchLatestRelease({ repository: 'https://github.com/yhuan416/dsh-opencode-client', fetchImpl: fetchImpl, timeoutMs: 1000 })
  assert.equal(value.ok, true)
  assert.equal(value.version, '1.2.0')
  assert.equal(value.url, RELEASE.html_url)
  assert.equal(typeof value.checkedAt, 'number')
  assert.equal(fetchImpl.calls.length, 1)
})

test('fetchLatestRelease falls back to tags when there is no release', async function () {
  const fetchImpl = fakeFetch({
    '/releases/latest': jsonResponse(404, {}),
    '/tags?per_page=100': jsonResponse(200, [{ name: 'v1.0.0' }, { name: 'v1.3.1' }]),
  })
  const value = await fetchLatestRelease({ repository: 'https://github.com/yhuan416/dsh-opencode-client', fetchImpl: fetchImpl })
  assert.equal(value.ok, true)
  assert.equal(value.version, '1.3.1')
  assert.equal(value.url, 'https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.3.1')
})

test('fetchLatestRelease degrades instead of throwing', async function () {
  const failed = await fetchLatestRelease({
    repository: 'https://github.com/yhuan416/dsh-opencode-client',
    fetchImpl: fakeFetch({ '/releases/latest': jsonResponse(500, {}) }),
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /500/)

  const offline = await fetchLatestRelease({
    repository: 'https://github.com/yhuan416/dsh-opencode-client',
    fetchImpl: fakeFetch({ '/releases/latest': new Error('getaddrinfo ENOTFOUND api.github.com') }),
  })
  assert.equal(offline.ok, false)
  assert.match(offline.error, /ENOTFOUND/)

  const noGithub = await fetchLatestRelease({ repository: 'https://gitlab.com/owner/repo', fetchImpl: function () { throw new Error('must not run') } })
  assert.equal(noGithub.ok, false)
  assert.match(noGithub.error, /GitHub/)
})

test('latestRelease caches success for 24 h and failure for 1 h', async function () {
  resetLatestReleaseCache()
  const fetchImpl = fakeFetch({ '/releases/latest': jsonResponse(200, RELEASE) })
  let now = 1_700_000_000_000
  const options = { repository: 'https://github.com/yhuan416/dsh-opencode-client', fetchImpl: fetchImpl, now: function () { return now } }
  assert.equal((await latestRelease(options)).ok, true)
  now += 3600_000
  await latestRelease(options)
  assert.equal(fetchImpl.calls.length, 1, 'a second call within the TTL must reuse the cache')
  now += 24 * 3600_000
  await latestRelease(options)
  assert.equal(fetchImpl.calls.length, 2, 'an expired cache must re-check')

  resetLatestReleaseCache()
  const failing = fakeFetch({ '/releases/latest': jsonResponse(502, {}) })
  const failOptions = { repository: 'https://github.com/yhuan416/dsh-opencode-client', fetchImpl: failing, now: function () { return now } }
  assert.equal((await latestRelease(failOptions)).ok, false)
  now += 1800_000
  await latestRelease(failOptions)
  assert.equal(failing.calls.length, 1, 'a failure is reused for an hour')
  now += 3600_000
  await latestRelease(failOptions)
  assert.equal(failing.calls.length, 2)
  resetLatestReleaseCache()
})

test('latestState words the three outcomes', function () {
  assert.equal(latestState('1.0.1', { ok: true, version: '1.0.1', checkedAt: 1 }).status, 'latest')
  assert.equal(latestState('1.0.1', { ok: true, version: '1.1.0', checkedAt: 1 }).status, 'update-available')
  assert.equal(latestState('1.0.1', { ok: false, error: 'offline', checkedAt: 1 }).status, 'unavailable')
  // A pre-release sorts before its own release, so it is an update.
  assert.equal(latestState('1.1.0-rc.1', { ok: true, version: '1.1.0', checkedAt: 1 }).status, 'update-available')
  assert.equal(latestState('1.1.0', { ok: true, version: '1.1.0-rc.1', checkedAt: 1 }).status, 'latest')
})

test('createAbout combines package, install and release facts', async function () {
  const about = createAbout({
    packageInfo: { name: 'dsh-opencode-client', version: '1.0.1', repository: 'https://github.com/yhuan416/dsh-opencode-client' },
    releaseSource: function () { return Promise.resolve({ ok: true, version: '1.1.0', url: 'https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.1.0', checkedAt: 5 }) },
    manager: function () {
      return {
        listBundles: function () {
          return Promise.resolve([
            { name: 'other', source: 'other@1.0.0' },
            { name: 'dsh-opencode-client', source: 'file:/tmp/plugin' },
          ])
        },
      }
    },
  })
  const payload = await about({ refresh: false })
  assert.deepEqual(payload, {
    ok: true,
    plugin: { name: 'dsh-opencode-client', version: '1.0.1', repository: 'https://github.com/yhuan416/dsh-opencode-client' },
    install: { source: 'file:/tmp/plugin', update: null },
    latest: { status: 'update-available', version: '1.1.0', checkedAt: 5, url: 'https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.1.0' },
  })
})

test('createAbout survives a missing plugin manager and a failing lookup', async function () {
  const about = createAbout({
    packageInfo: { name: 'dsh-opencode-client', version: '1.0.1', repository: 'https://github.com/yhuan416/dsh-opencode-client' },
    releaseSource: function () { return Promise.resolve({ ok: false, error: '无法连接 GitHub', checkedAt: 7 }) },
  })
  const payload = await about()
  assert.equal(payload.ok, true)
  assert.equal(payload.install, undefined)
  assert.equal(payload.latest.status, 'unavailable')
  assert.equal(payload.latest.error, '无法连接 GitHub')
})

test('GET /api/opencode-client/about forwards refresh and returns the payload', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const seen = []
  const routes = createRoutes({
    servers: [{ id: 'n100', url: 'http://127.0.0.1:1', label: 'n100' }],
    delegate: {},
    observation: {},
    board: {},
    config: {},
    normalizeServers: function (list) { return list },
    about: function (request) {
      seen.push(request)
      return Promise.resolve({ ok: true, plugin: { name: 'dsh-opencode-client', version: '1.0.1' }, latest: { status: 'latest', checkedAt: 9 } })
    },
  })
  const route = routes.find(function (candidate) { return candidate.path === '/api/opencode-client/about' })
  assert.ok(route !== undefined)
  const response = await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/about?refresh=1'), {})
  assert.equal(response.status, 200)
  assert.deepEqual(seen, [{ refresh: true }])
  const body = await response.json()
  assert.equal(body.plugin.version, '1.0.1')
  assert.equal(body.latest.status, 'latest')

  const plain = await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/about'), {})
  assert.equal((await plain.json()).ok, true)
  assert.deepEqual(seen.at(-1), { refresh: false })
})

test('the about route reports its absence instead of failing the profile', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const routes = createRoutes({ servers: [], delegate: {}, observation: {}, board: {}, config: {}, normalizeServers: function (list) { return list } })
  const route = routes.find(function (candidate) { return candidate.path === '/api/opencode-client/about' })
  const response = await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/about'), {})
  assert.equal(response.status, 503)
  assert.equal((await response.json()).ok, false)
})