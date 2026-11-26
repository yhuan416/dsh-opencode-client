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

// Shape returned by OpenCode 2.3.0 (`/api/experimental/session/stats`), with the
// `models` array trimmed: the stats assertions below do not cover attribution.
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
  models: [],
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

// One fake v2 server with two priced sessions (one paginated) and a priced
// session that has not run inside the window. Message cost is the only
// window-scoped source, so the walk must sum messages, not lifetime session cost.
function attributionFixture(now) {
  return {
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/project': function () {
      return { data: [{ id: 'p1', canonical: '/work/alpha' }, { id: 'p2', canonical: '/work/beta' }] }
    },
    '/api/session': function () {
      return {
        data: [
          { id: 's1', projectID: 'p1', title: 'a1', location: { directory: '/work/alpha' }, cost: 5, time: { created: now - 86400000, updated: now, busy: now - 1000 } },
          { id: 's2', projectID: 'p1', title: 'free', location: { directory: '/work/alpha' }, cost: 0, time: { created: now - 86400000, updated: now, busy: now - 2000 } },
          { id: 's3', projectID: 'p2', title: 'b1', location: { directory: '/work/beta' }, cost: 9, time: { created: now - 86400000, updated: now, busy: now - 3000 } },
          { id: 's4', projectID: 'p2', title: 'stale', location: { directory: '/work/beta' }, cost: 9, time: { created: now - 900000000, updated: now - 864000000, busy: now - 864000000 } },
          // `global` project sessions answer directory `/`, which must not become
          // the bucket that holds the fleet total.
          { id: 's5', projectID: 'p1', title: 'slash', location: { directory: '/' }, cost: 2, time: { created: now - 86400000, updated: now, busy: now - 4000 } },
        ],
      }
    },
    '/api/session/s1/message': function () {
      return { data: [
        { type: 'assistant', cost: 3, time: { created: now - 3600000 } },
        { type: 'assistant', cost: 2, time: { created: now - 7200000 } },
      ] }
    },
    '/api/session/s3/message': function (request) {
      if (request.url.indexOf('cursor=') !== -1) {
        return {
          data: [
            { type: 'assistant', cost: 0.5, time: { created: now - 10800000 } },
            { type: 'assistant', cost: 4, time: { created: now - 864000000 } },
          ],
          cursor: { next: null },
        }
      }
      return {
        data: [{ type: 'assistant', cost: 1.5, time: { created: now - 1800000 } }],
        cursor: { next: 's3-page-2' },
      }
    },
    '/api/session/s5/message': function () {
      return { data: [{ type: 'assistant', cost: 7, time: { created: now - 600000 } }] }
    },
  }
}

test('collectCostByDirectory sums in-window message cost, not lifetime session cost', async function () {
  const now = Date.now()
  const fake = await startServer(attributionFixture(now))
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const report = await collectCostByDirectory(server, { from: now - 7 * 86400000 })
    assert.equal(report.kind, 'windowed')
    // s1: 5 (two messages), s3: 2 (1.5 + 0.5, stops before the 10-day-old one),
    // s5: 7 (directory `/` falls back to the project worktree).
    assert.equal(report.total.cost, 14)
    assert.equal(report.total.sessions, 4, 'every session active in the window counts, priced or not')
    assert.equal(report.total.priced, 3, 'messages are only read for sessions with a priced lifetime cost')
    assert.equal(report.total.partial, false)
    assert.deepEqual(report.directories, [
      { directory: '/work/alpha', cost: 12, sessions: 3 },
      { directory: '/work/beta', cost: 2, sessions: 1 },
    ], 'the stale session (s4) and the `/` bucket are gone')
    const messageCalls = function (id) {
      return fake.requests.filter(function (url) { return url.indexOf('/api/session/' + id + '/message') === 0 }).length
    }
    assert.equal(messageCalls('s4'), 0, 'a session that did not run in the window is never read')
    assert.equal(messageCalls('s2'), 0, 'a session without priced cost is never read')
    assert.equal(messageCalls('s3'), 2, 'pagination stops as soon as a message predates the window')
  } finally {
    await fake.close()
  }
})

test('collectCostByDirectory marks a capped report partial instead of under-counting silently', async function () {
  const now = Date.now()
  const fake = await startServer(attributionFixture(now))
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const report = await collectCostByDirectory(server, { from: now - 7 * 86400000, maxSessions: 2 })
    assert.equal(report.total.priced, 2)
    assert.equal(report.total.skipped, 1)
    assert.equal(report.total.partial, true)
    assert.ok(report.total.cost < 14)
  } finally {
    await fake.close()
  }
})

test('collectCostByDirectory sums only the message type stats counts (compaction excluded)', async function () {
  const now = Date.now()
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/project': function () { return { data: [] } },
    '/api/session': function () {
      return { data: [{ id: 's1', location: { directory: '/work/alpha' }, cost: 2, time: { created: now - 3600000, updated: now, busy: now - 1000 } }] }
    },
    '/api/session/s1/message': function () {
      return { data: [
        { type: 'assistant', cost: 1.5, time: { created: now - 1000 } },
        { type: 'compaction', cost: 0.5, time: { created: now - 2000 } },
      ] }
    },
  })
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const report = await collectCostByDirectory(server, { from: now - 7 * 86400000 })
    assert.equal(report.total.cost, 1.5, 'compaction cost is outside the stats/session.cost definition and must not count')
  } finally {
    await fake.close()
  }
})

test('collectCostByDirectory stops at the request budget and flags the report partial', async function () {
  const now = Date.now()
  const fake = await startServer(attributionFixture(now))
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const report = await collectCostByDirectory(server, { from: now - 7 * 86400000, maxRequests: 1 })
    assert.equal(report.total.partial, true)
    assert.ok(report.total.cost < 14, 'a budget stop must not be reported as a complete total')
    assert.ok(fake.requests.filter(function (url) { return url.indexOf('/message') !== -1 }).length <= 1)
  } finally {
    await fake.close()
  }
})

test('collectCostByDirectory refuses to approximate on v1 (no per-message cost)', async function () {
  const fake = await startServer({ '/api/info': function () { return { version: '2.3.0' } } })
  try {
    // No password: the probe resolves v1 without any HTTP call.
    const server = normalizeServers([{ id: 'old', url: fake.url }])[0]
    const report = await collectCostByDirectory(server, { from: Date.now() - 86400000 })
    assert.equal(report.kind, 'unsupported')
    assert.equal(report.directories.length, 0)
    assert.equal(report.total.partial, false)
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test('GET /usage exposes byModel and, on request, a reconciled byDirectory', async function () {
  const now = Date.now()
  const fixture = attributionFixture(now)
  const fake = await startServer({
    ...fixture,
    '/api/experimental/session/stats': function () {
      return {
        data: {
          sessions: 2, steps: 10, cost: 14,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40 } },
          tools: { totals: { calls: 3, succeeded: 3, failed: 0 } },
          models: [
            { model: { providerID: 'x', id: 'm1' }, steps: 6, tokens: { input: 60 }, cost: 9 },
            { model: { providerID: 'y', id: 'm2' }, steps: 4, tokens: { input: 40 }, cost: 5 },
          ],
        },
      }
    },
  })
  try {
    const observation = createObservation()
    const servers = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])
    const routes = createRoutes({ servers: servers, delegate: {}, observation: observation, board: boardStub(observation) })
    const usage = routes.find(function (route) { return route.path === '/api/opencode-client/usage' })

    const window = 'from=' + (now - 7 * 86400000)
    const plain = await (await usage.fetch({ url: '/api/opencode-client/usage?' + window })).json()
    assert.deepEqual(plain.total.byModel.map(function (entry) { return [entry.model, entry.cost] }), [['x/m1', 9], ['y/m2', 5]])
    assert.equal(plain.total.byDirectory, undefined, 'directory split is opt-in')

    const grouped = await (await usage.fetch({ url: '/api/opencode-client/usage?' + window + '&group=directory' })).json()
    assert.deepEqual(grouped.total.byDirectory.map(function (entry) { return [entry.directory, entry.cost] }), [['/work/alpha', 12], ['/work/beta', 2]])
    assert.equal(grouped.total.byDirectoryKind, 'windowed')
    assert.equal(grouped.total.byDirectoryPartial, false)
    assert.equal(grouped.total.byDirectoryDelta, 0)
    assert.equal(grouped.total.reconciled, true, 'directory cost must reconcile with the stats total')
    assert.deepEqual(grouped.servers[0].directories.map(function (entry) { return entry.directory }), ['/work/alpha', '/work/beta'])
  } finally {
    await fake.close()
  }
})

test('GET /usage does not pay for a directory pull on an unsupported (v1) server', async function () {
  const fake = await startServer({ '/api/info': function () { return { version: '2.3.0' } } })
  try {
    const observation = createObservation()
    const servers = normalizeServers([{ id: 'old', url: fake.url }])
    const routes = createRoutes({ servers: servers, delegate: {}, observation: observation, board: boardStub(observation) })
    const usage = routes.find(function (route) { return route.path === '/api/opencode-client/usage' })
    const grouped = await (await usage.fetch({ url: '/api/opencode-client/usage?from=' + (Date.now() - 86400000) + '&group=directory' })).json()
    assert.deepEqual(grouped.total.byDirectory, [])
    assert.equal(grouped.total.byDirectoryKind, undefined)
    assert.equal(fake.requests.length, 0, 'v1 is known without a probe, so nothing is fetched')
  } finally {
    await fake.close()
  }
})
