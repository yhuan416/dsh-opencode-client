/**
 * Usage path test: a fake OpenCode v2 server feeding `collectStats`, plus the
 * caching the board's 2-minute poll depends on (a stats call is a history scan
 * server-side, so a key that moves with `Date.now()` would refetch every poll).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectStats, summarizeStats, STATS_BUCKET_MS } from '../lib/sessions.js'

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