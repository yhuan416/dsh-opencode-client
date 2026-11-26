/**
 * Usage path test: a fake OpenCode v2 server feeding `collectStats`, plus the
 * caching the board's 2-minute poll depends on (a stats call is a history scan
 * server-side, so a key that moves with `Date.now()` would refetch every poll).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectStats, collectCostByDirectory, summarizeStats, STATS_BUCKET_MS } from '../lib/sessions.js'
import { createObservation } from '../lib/observation.js'
import { createRoutes } from '../lib/routes.js'

// Verbatim shape returned by OpenCode 2.3.0 (`/api/experimental/session/stats`).
const STATS = {
  range: { from: 0, to: 1_760_000_000_000 },
  sessions: 167,
  subagents: 9,
  prompts: 4142,
  steps: 46072,
  tokens: { input: 713293301, output: 12779134, reasoning: 19027199, cache: { read: 16662285424, write: 0 } },
  cost: 601.4825927438002,
  tools: { mode: 'summary', totals: { calls: 49504, succeeded: 49043, failed: 461, unfinished: 0 } },
  activeDays: 60,
  streak: 12,
  activity: [],
  models: {},
}

function boardStub(observation) {
  return {
    observedById: function () { return new Map() },
    refreshAll: function () { return Promise.resolve() },
    snapshot: function (options) { return observation.board(options) },
    serverInfo: function () { return undefined },
  }
}

function startServer(routes) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const path = request.url.split('?')[0]
      requests.push(request.url)
      const handler = routes[path]
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(handler(request)))
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        statsCalls: function () {
          return requests.filter(function (url) { return url.indexOf('/experimental/session/stats') !== -1 }).length
        },
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

test('collectStats normalizes a v2 stats payload', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/experimental/session/stats': function () { return { data: STATS } },
  })
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'x' }])[0]
    const usage = await collectStats(server, { from: 0 })
    assert.equal(usage.supported, true)
    assert.equal(usage.sessions, 167)
    assert.equal(usage.steps, 46072)
    assert.equal(usage.cost, STATS.cost)
    assert.deepEqual(usage.tokens, { input: 713293301, output: 12779134, reasoning: 19027199, cacheRead: 16662285424, cacheWrite: 0 })
    assert.deepEqual(usage.tools, { calls: 49504, succeeded: 49043, failed: 461 })
    assert.equal(usage.activeDays, 60)
    assert.equal(usage.streak, 12)
  } finally {
    await fake.close()
  }
})

test('collectStats caches by bucketed range start, not by `to`', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/experimental/session/stats': function () { return { data: STATS } },
  })
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'x' }])[0]
    // Two polls inside one bucket: different `from` by 200 s, different `to`.
    const base = 1_760_000_000_000
    const bucketStart = Math.floor(base / STATS_BUCKET_MS) * STATS_BUCKET_MS
    const first = await collectStats(server, { from: bucketStart + 1000 })
    const second = await collectStats(server, { from: bucketStart + 201000 })
    assert.equal(first.sessions, second.sessions)
    assert.equal(fake.statsCalls(), 1, 'second poll inside the same bucket must hit the cache')

    // "All history" is its own key, so it cannot be served a 7-day result.
    await collectStats(server, { from: 0 })
    assert.equal(fake.statsCalls(), 2)
    const third = await collectStats(server, { from: 0 })
    assert.equal(third.sessions, 167)
    assert.equal(fake.statsCalls(), 2, 'repeat all-history call stays cached')

    // A later bucket refetches.
    await collectStats(server, { from: bucketStart + STATS_BUCKET_MS })
    assert.equal(fake.statsCalls(), 3)
  } finally {
    await fake.close()
  }
})

test('collectStats reports v1 servers as unsupported instead of zeros', async function () {
  const fake = await startServer({ '/api/info': function () { return { version: '2.3.0' } } })
  try {
    // No password: the probe treats it as v1, and there is no stats endpoint.
    const server = normalizeServers([{ id: 'old', url: fake.url }])[0]
    const usage = await collectStats(server, { from: 0 })
    assert.deepEqual(usage, { supported: false })
    assert.equal(fake.statsCalls(), 0)
  } finally {
    await fake.close()
  }
})

test('summarizeStats survives missing or malformed fields', function () {
  const empty = summarizeStats(null)
  assert.equal(empty.sessions, 0)
  assert.equal(empty.cost, 0)
  assert.deepEqual(empty.tokens, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(empty.tools, { calls: 0, succeeded: 0, failed: 0 })
  const partial = summarizeStats({ tokens: { input: 5 }, tools: {} })
  assert.equal(partial.tokens.input, 5)
  assert.equal(partial.tokens.output, 0)
  assert.equal(partial.tools.calls, 0)
})
test('summarizeStats carries per-model attribution, cost-sorted and normalized', function () {
  const stats = summarizeStats({
    sessions: 1,
    models: [
      { model: { providerID: 'x', id: 'm2', variant: 'high' }, steps: 3, tokens: { input: 10 }, cost: 2 },
      { model: { providerID: 'y', id: 'm1' }, steps: 1, tokens: { input: 5, cache: { read: 7 } }, cost: 5 },
      { model: { id: '' }, steps: 0, cost: 0 },
    ],
  })
  assert.equal(stats.models.length, 2, 'entries without a usable model label are dropped')
  assert.equal(stats.models[0].model, 'y/m1', 'sorted by cost descending')
  assert.equal(stats.models[1].model, 'x/m2#high', 'variant is part of the label')
  assert.deepEqual(stats.models[0].tokens, { input: 5, cacheRead: 7 })
  assert.equal(stats.models[0].cost, 5)
  const empty = summarizeStats({})
  assert.deepEqual(empty.models, [])
})

test('collectCostByDirectory aggregates session cost by current directory', async function () {
  const now = Date.now()
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/project': function () { return { data: [] } },
    '/api/session': function () {
      return {
        data: [
          { id: 's1', title: 'a1', location: { directory: '/work/alpha' }, cost: 1.5, time: { updated: now } },
          { id: 's2', title: 'a2', location: { directory: '/work/alpha' }, cost: 0.5, time: { updated: now } },
          { id: 's3', title: 'b1', location: { directory: '/work/beta' }, cost: 3, time: { updated: now } },
          { id: 's4', title: 'old', location: { directory: '/work/beta' }, cost: 9, time: { updated: 1000 } },
        ],
      }
    },
  })
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const all = await collectCostByDirectory(server, {})
    assert.deepEqual(all.directories.map(function (entry) { return [entry.directory, entry.cost, entry.sessions] }), [
      ['/work/beta', 12, 2],
      ['/work/alpha', 2, 2],
    ])
    assert.equal(all.total.cost, 14)
    assert.equal(all.total.sessions, 4)

    // `from` only filters by "touched in this window" — cost is cumulative.
    const recent = await collectCostByDirectory(normalizeServers([{ id: 'e6', url: fake.url, password: 'pw' }])[0], { from: now - 60000 })
    assert.deepEqual(recent.directories.map(function (entry) { return [entry.directory, entry.cost] }), [
      ['/work/beta', 3],
      ['/work/alpha', 2],
    ])
  } finally {
    await fake.close()
  }
})

test('GET /usage exposes byModel and, on request, byDirectory', async function () {
  const now = Date.now()
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/experimental/session/stats': function () {
      return {
        data: {
          sessions: 2, steps: 10, cost: 7,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40 } },
          tools: { totals: { calls: 3, succeeded: 3, failed: 0 } },
          models: [
            { model: { providerID: 'x', id: 'm1' }, steps: 6, tokens: { input: 60 }, cost: 5 },
            { model: { providerID: 'y', id: 'm2' }, steps: 4, tokens: { input: 40 }, cost: 2 },
          ],
        },
      }
    },
    '/api/project': function () { return { data: [] } },
    '/api/session': function () {
      return {
        data: [
          { id: 's1', location: { directory: '/work/alpha' }, cost: 4, time: { updated: now } },
          { id: 's2', location: { directory: '/work/beta' }, cost: 3, time: { updated: now } },
        ],
      }
    },
  })
  try {
    const observation = createObservation()
    const servers = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])
    const routes = createRoutes({ servers: servers, delegate: {}, observation: observation, board: boardStub(observation) })
    const usage = routes.find(function (route) { return route.path === '/api/opencode-client/usage' })

    const plain = await (await usage.fetch({ url: '/api/opencode-client/usage?from=0' })).json()
    assert.deepEqual(plain.total.byModel.map(function (entry) { return [entry.model, entry.cost] }), [['x/m1', 5], ['y/m2', 2]])
    assert.equal(plain.total.byDirectory, undefined, 'directory split costs an extra pull, so it is opt-in')

    const grouped = await (await usage.fetch({ url: '/api/opencode-client/usage?from=0&group=directory' })).json()
    assert.deepEqual(grouped.total.byDirectory.map(function (entry) { return [entry.directory, entry.cost] }), [['/work/alpha', 4], ['/work/beta', 3]])
    assert.deepEqual(grouped.servers[0].directories.map(function (entry) { return entry.directory }), ['/work/alpha', '/work/beta'])
  } finally {
    await fake.close()
  }
})
