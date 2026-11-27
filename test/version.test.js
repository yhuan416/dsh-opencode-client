/**
 * The upgrade badge is driven by the official update service (the local API has
 * no "latest version" endpoint). These tests pin version ordering, the failure
 * mode (no badge, never a throw) and the one-hour cache.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, fetchLatestVersion, latestVersion, resetLatestVersionCache } from '../lib/version.js'
import { createRoutes } from '../lib/routes.js'
import { normalizeServers } from '../lib/config.js'

function fakeFetch(payload, status) {
  const calls = []
  const impl = function (url) {
    calls.push(url)
    if (status !== undefined) return Promise.resolve({ ok: false, status: status, json: function () { return Promise.resolve({}) } })
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(payload) } })
  }
  impl.calls = calls
  return impl
}

test('compareVersions orders releases and pre-releases', function () {
  assert.equal(compareVersions('2.3.0', '2.4.2'), -1)
  assert.equal(compareVersions('2.4.2', '2.3.0'), 1)
  assert.equal(compareVersions('2.4.2', '2.4.2'), 0)
  assert.equal(compareVersions('v2.3.0', '2.3.1'), -1)
  assert.equal(compareVersions('2.4', '2.4.0'), 0)
  assert.equal(compareVersions('2.4.2-rc.1', '2.4.2'), -1)
  assert.equal(compareVersions('2.4.2', '2.4.2-rc.1'), 1)
})

test('fetchLatestVersion returns the service version and degrades to ok:false', async function () {
  const good = await fetchLatestVersion({ fetchImpl: fakeFetch({ version: '2.4.2' }), url: 'http://update.test' })
  assert.deepEqual(Object.keys(good).sort(), ['checkedAt', 'latest', 'ok'])
  assert.equal(good.ok, true)
  assert.equal(good.latest, '2.4.2')

  const bad = await fetchLatestVersion({ fetchImpl: fakeFetch({}, 500), url: 'http://update.test' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /500/)
  assert.equal(bad.latest, undefined)

  const empty = await fetchLatestVersion({ fetchImpl: fakeFetch({}), url: 'http://update.test' })
  assert.equal(empty.ok, false)

  const thrown = await fetchLatestVersion({ fetchImpl: function () { return Promise.reject(new Error('offline')) }, url: 'http://update.test' })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /offline/)
})

test('latestVersion caches a successful lookup', async function () {
  resetLatestVersionCache()
  const impl = fakeFetch({ version: '2.4.2' })
  const first = await latestVersion({ fetchImpl: impl, url: 'http://update.test' })
  const second = await latestVersion({ fetchImpl: impl, url: 'http://update.test' })
  assert.equal(first.latest, '2.4.2')
  assert.equal(second.latest, '2.4.2')
  assert.equal(impl.calls.length, 1, 'second call is served from the cache')
  resetLatestVersionCache()
})

test('upgrade route exposes only the latest version', async function () {
  const servers = normalizeServers([{ id: 'e5', url: 'http://127.0.0.1:1', password: 'pw' }])
  const observation = { board: function () { return {} }, observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function () { return {} }, serverInfo: function () { return undefined } }
  const route = createRoutes({
    servers: servers,
    delegate: {},
    observation: observation,
    board: observation,
    versionSource: function () { return Promise.resolve({ ok: true, latest: '2.4.2', checkedAt: 123 }) },
  }).find(function (item) { return item.path === '/api/opencode-client/upgrade' })
  assert.ok(route, 'upgrade route is registered')
  const payload = await (await route.fetch({ url: '/api/opencode-client/upgrade' })).json()
  assert.deepEqual(payload, { ok: true, latest: '2.4.2', checkedAt: 123 })
})