/**
 * Per-skill usage walks messages (the only place the skill *name* exists), so
 * these tests pin: window filtering, per-skill aggregation, the page cap and the
 * lazy endpoint's caching. A session's messages are returned newest first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectSkillUsage } from '../lib/skills.js'
import { createRoutes } from '../lib/routes.js'

const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime()
const DAY = 86400000

function skillPart(id) { return { type: 'tool', name: 'skill', state: { input: { id: id } } } }
function legacySkillPart(name) { return { type: 'tool', name: 'skill', state: { input: { name: name } } } }
function shellPart() { return { type: 'tool', name: 'shell', state: { input: { command: 'ls' } } } }
function assistant(created, parts) { return { type: 'assistant', time: { created: created }, content: parts } }

function session(id, busyAt) {
  return { id: id, title: id, location: { directory: '/work/alpha' }, cost: 0, time: { created: busyAt, updated: busyAt, busy: busyAt, idle: busyAt + 1000 } }
}

const SESSIONS = [
  session('s1', NOW - DAY),
  session('s2', NOW - DAY),
  session('old', NOW - 10 * DAY),
]

const MESSAGES = {
  s1: [
    assistant(NOW - DAY, [skillPart('jira')]),
    assistant(NOW - DAY - 1000, [skillPart('jira'), skillPart('gitlab'), shellPart()]),
    assistant(NOW - 10 * DAY, [skillPart('outside-window')]),
  ],
  s2: [
    assistant(NOW - DAY, [skillPart('jira'), legacySkillPart('legacy'), shellPart()]),
  ],
}

function startFake(options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const path = request.url.split('?')[0]
      requests.push(request.url)
      const messageMatch = path.match(/^\/api\/session\/([^/]+)\/message$/)
      if (path === '/api/info') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ version: opts.version || '2.3.0' }))
        return
      }
      if (path === '/api/project') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [] }))
        return
      }
      if (path === '/api/session') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: SESSIONS, cursor: { next: null } }))
        return
      }
      if (messageMatch !== null) {
        const id = decodeURIComponent(messageMatch[1])
        const data = opts.loopCursor === true
          ? [assistant(NOW - DAY, [skillPart('jira')])]
          : (MESSAGES[id] || [])
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: data, cursor: { next: opts.loopCursor === true ? 'next' : null } }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        messageRequests: function () { return requests.filter(function (url) { return url.indexOf('/message') !== -1 }).length },
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

test('collectSkillUsage aggregates skill names inside the window', async function () {
  const fake = await startFake()
  try {
    const servers = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])
    const result = await collectSkillUsage(servers, { now: NOW, days: 7 })
    assert.deepEqual(result.total.skills, [{ name: 'jira', calls: 3 }, { name: 'gitlab', calls: 1 }, { name: 'legacy', calls: 1 }])
    assert.equal(result.total.calls, 5)
    assert.equal(result.total.sessions, 2, 'only sessions whose busy time is inside the window')
    assert.equal(result.total.truncated, false)
    const row = result.servers[0]
    assert.equal(row.supported, true)
    assert.equal(row.pages, 2)
    assert.equal(row.failed, 0)
    assert.deepEqual(row.skills.map(function (entry) { return [entry.name, entry.calls] }), [['jira', 3], ['gitlab', 1], ['legacy', 1]])
  } finally {
    await fake.close()
  }
})

test('collectSkillUsage caches per server/window bucket', async function () {
  const fake = await startFake()
  try {
    const servers = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])
    await collectSkillUsage(servers, { now: NOW, days: 7 })
    const first = fake.messageRequests()
    await collectSkillUsage(servers, { now: NOW, days: 7 })
    assert.equal(fake.messageRequests(), first, 'second call is served from the 10-minute cache')
  } finally {
    await fake.close()
  }
})

test('a session that never reaches the window edge is reported truncated', async function () {
  const fake = await startFake({ loopCursor: true })
  try {
    const servers = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])
    servers[0].skillsCache = new Map()
    const result = await collectSkillUsage(servers, { now: NOW, days: 7 })
    assert.equal(result.total.truncated, true)
    assert.equal(result.servers[0].truncated, true)
    assert.equal(fake.messageRequests(), 120, 'page cap is 60 per session, for both in-window sessions')
  } finally {
    await fake.close()
  }
})

test('v1 reports unsupported without walking messages', async function () {
  const fake = await startFake({ version: '1.18.0' })
  try {
    const servers = normalizeServers([{ id: 'old', url: fake.url, password: 'pw', apiVersion: '1' }])
    servers[0].apiVersion = '1'
    const result = await collectSkillUsage(servers, { now: NOW })
    assert.equal(result.total.calls, 0)
    assert.equal(result.servers[0].supported, false)
    assert.equal(fake.messageRequests(), 0)
  } finally {
    await fake.close()
  }
})

test('route returns the skills payload', async function () {
  const fake = await startFake()
  try {
    const servers = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])
    const observation = { board: function () { return {} }, observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function () { return {} }, serverInfo: function () { return undefined } }
    const route = createRoutes({ servers: servers, delegate: {}, observation: observation, board: observation })
      .find(function (item) { return item.path === '/api/opencode-client/insights/skills' })
    assert.ok(route, 'skills route is registered')
    const response = await route.fetch({ url: '/api/opencode-client/insights/skills?days=7' })
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.days, 7)
    assert.deepEqual(payload.total.skills.map(function (entry) { return entry.name }), ['jira', 'gitlab', 'legacy'])
  } finally {
    await fake.close()
  }
})