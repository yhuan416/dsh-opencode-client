/**
 * Insights aggregation: window-scoped numbers for the board's top area.
 *
 * The fake server serves `tools=summary` and `tools=detail` from the same path,
 * so these tests also pin that the two modes never share a stats cache slot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectStats } from '../lib/sessions.js'
import { collectInsights, computeCacheHitRate, fillActivity, sessionFacts } from '../lib/insights.js'

const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime()
const DAY = 86400000

function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function startFake(handlers) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const path = request.url.split('?')[0]
      requests.push(request.url)
      const handler = handlers[path]
      if (handler === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      const payload = handler(request)
      if (payload !== null && typeof payload === 'object' && typeof payload.__status === 'number') {
        response.writeHead(payload.__status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload.body === undefined ? {} : payload.body))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        hits: function (needle) { return requests.filter(function (url) { return url.indexOf(needle) !== -1 }).length },
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

const SESSIONS = [
  { id: 's1', projectID: 'p1', title: 'a1', location: { directory: '/work/alpha' }, cost: 3, tokens: { input: 10, output: 2 }, time: { created: NOW - 2 * DAY, updated: NOW - DAY, busy: NOW - DAY, idle: NOW - DAY + 1000 } },
  { id: 's2', projectID: 'p1', title: 'a2', location: { directory: '/work/alpha' }, cost: 0, time: { created: NOW - 2 * DAY, updated: NOW - DAY, busy: NOW - DAY, idle: NOW - DAY + 1000 } },
  { id: 's3', projectID: 'p2', title: 'old', location: { directory: '/work/beta' }, cost: 5, time: { created: NOW - 20 * DAY, updated: NOW - 10 * DAY, busy: NOW - 10 * DAY, idle: NOW - 10 * DAY + 1000 } },
  { id: 's4', title: 'slash', location: { directory: '/' }, cost: 0, time: { created: NOW - 2 * DAY, updated: NOW - 2 * DAY, busy: NOW - 2 * DAY, idle: NOW - 2 * DAY + 1000 } },
]

const PROJECTS = [{ id: 'p1', canonical: '/work/alpha' }, { id: 'p2', canonical: '/work/beta' }]

const STATS = {
  sessions: 2,
  subagents: 1,
  prompts: 3,
  steps: 10,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 0 } },
  cost: 7.5,
  tools: {
    mode: 'detail',
    totals: { calls: 3, succeeded: 2, failed: 1, unfinished: 0 },
    usage: [
      { name: 'read', calls: 1, succeeded: 1, failed: 0, unfinished: 0, durationP50: 30 },
      { name: 'bash', calls: 2, succeeded: 1, failed: 1, unfinished: 0, durationP50: 12 },
    ],
  },
  activeDays: 1,
  streak: 2,
  activity: [{ date: dayKey(NOW - DAY), steps: 7 }],
  models: [{ model: { providerID: 'x', id: 'm', variant: 'high' }, steps: 5, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900 } }, cost: 7.5 }],
}

function fakeHandlers(overrides) {
  return Object.assign({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/project': function () { return { data: PROJECTS } },
    '/api/session': function (request) {
      if (request.url.indexOf('archived=true') !== -1) {
        return { data: [{ id: 'arch1', time: { archived: 1 } }], cursor: { next: null } }
      }
      return { data: SESSIONS }
    },
    '/api/experimental/session/stats': function (request) {
      if (request.url.indexOf('tools=detail') !== -1) return { data: STATS }
      return { data: Object.assign({}, STATS, { tools: { mode: 'summary', totals: STATS.tools.totals } }) }
    },
  }, overrides)
}

test('collectInsights aggregates window-scoped totals, activity fill and project counts', async function () {
  const fake = await startFake(fakeHandlers())
  try {
    const servers = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])
    const result = await collectInsights(servers, { now: NOW })
    const total = result.total
    assert.equal(total.sessions, 2)
    assert.equal(total.subagents, 1)
    assert.equal(total.prompts, 3)
    assert.equal(total.steps, 10)
    assert.equal(total.cost, 7.5)
    assert.equal(total.archived, 1)
    assert.equal(total.quotedSessions, 1, 'only s1 carries a priced cost inside the window')
    assert.equal(total.tools.calls, 3)
    assert.deepEqual(total.tools.usage.map(function (row) { return [row.name, row.calls] }), [['bash', 2], ['read', 1]], 'usage sorted by calls')
    assert.equal(total.tools.usage[0].durationP50, 12)
    assert.equal(total.cacheHitRate, 900 / 1000)
    assert.equal(total.activity.length, 7, '7 calendar days, including today')
    assert.equal(total.activity.filter(function (day) { return day.steps > 0 }).length, 1)
    assert.equal(total.activeDays, 1)
    assert.deepEqual(total.models.map(function (row) { return [row.model, row.cost] }), [['x/m#high', 7.5]])

    const projects = total.projects.map(function (row) { return [row.directory, row.sessions] }).sort()
    assert.deepEqual(projects, [['(unattributed)', 1], ['/work/alpha', 2]], 'sessions are windowed by time.busy; project `/` is unattributed')
    assert.equal(result.servers[0].supported, true)
  } finally {
    await fake.close()
  }
})

test('collectInsights isolates a failing server from the total', async function () {
  const good = await startFake(fakeHandlers())
  const bad = await startFake(fakeHandlers({
    '/api/experimental/session/stats': function () { return { __status: 500, body: { error: 'nope' } } },
  }))
  try {
    const servers = normalizeServers([
      { id: 'e5', url: good.url, password: 'pw' },
      { id: 'n100', url: bad.url, password: 'pw' },
    ])
    const result = await collectInsights(servers, { now: NOW })
    assert.equal(result.total.sessions, 2, 'only the healthy server contributes')
    const failed = result.servers.find(function (row) { return row.id === 'n100' })
    assert.equal(failed.supported, false)
    assert.equal(failed.sessions, undefined)
    assert.ok(result.servers.find(function (row) { return row.id === 'e5' }).supported === true)
  } finally {
    await good.close()
    await bad.close()
  }
})

test('stats summary and detail never share a cache slot', async function () {
  const fake = await startFake(fakeHandlers())
  try {
    const server = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])[0]
    const from = new Date(2026, 10, 20, 0, 0, 0).getTime()
    const summary = await collectStats(server, { from: from, tools: 'summary' })
    assert.deepEqual(summary.tools.usage, undefined, 'summary has no per-tool usage')
    await collectStats(server, { from: from, tools: 'summary' })
    assert.equal(fake.hits('tools=summary'), 1, 'summary cached')
    const detail = await collectStats(server, { from: from, tools: 'detail' })
    assert.equal(detail.tools.usage.length, 2, 'detail must not be served the summary cache entry')
    await collectStats(server, { from: from, tools: 'detail' })
    assert.equal(fake.hits('tools=detail'), 1, 'detail cached separately')
  } finally {
    await fake.close()
  }
})

test('helpers: cache hit rate, activity fill and windowed session facts', function () {
  assert.equal(computeCacheHitRate({ input: 0, cacheRead: 0 }), null)
  assert.equal(computeCacheHitRate({ input: 100, cacheRead: 900 }), 0.9)

  const filled = fillActivity([{ date: dayKey(NOW), steps: 4 }], new Date(NOW - 2 * DAY).setHours(0, 0, 0, 0), NOW)
  assert.equal(filled.length, 3)
  assert.deepEqual(filled.map(function (day) { return day.steps }), [0, 0, 4])

  const facts = sessionFacts({ projects: [
    { worktree: '/work/alpha', sessions: [{ busyAt: NOW - DAY, cost: 2 }, { busyAt: NOW - DAY, cost: 0 }, { busyAt: NOW - 10 * DAY, cost: 5 }] },
    { worktree: '/', sessions: [{ busyAt: NOW - DAY, cost: 0 }] },
  ] }, NOW - 2 * DAY)
  assert.deepEqual(facts.projects, [{ directory: '/work/alpha', sessions: 2 }, { directory: '(unattributed)', sessions: 1 }])
  assert.equal(facts.quotedSessions, 1)
})