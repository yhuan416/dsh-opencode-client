/**
 * Read-marker path: dsh must not invent unread state. OpenCode keeps it on the
 * session (`time.idle` / `time.viewed`), so "looked at" is just its own
 * `POST /session/{id}/view {idle}` — asserted here against a fake v2 server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { createObservation } from '../lib/observation.js'
import { createRoutes } from '../lib/routes.js'
import { summarizeSession, markSessionViewed } from '../lib/sessions.js'

function startServer(routes) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const path = request.url.split('?')[0]
      let body = ''
      request.on('data', function (chunk) { body += chunk })
      request.on('end', function () {
        requests.push({ method: request.method, path: path, body: body })
        const handler = routes[path]
        response.writeHead(handler === undefined ? 404 : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(handler === undefined ? {} : handler(request, body)))
      })
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        views: function () { return requests.filter(function (item) { return item.path.indexOf('/view') !== -1 }) },
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

const IDLE = 1_760_000_000_000

function boardStub(observation) {
  return {
    observedById: function () { return new Map() },
    refreshAll: function () { return Promise.resolve() },
    snapshot: function (options) { return observation.board(options) },
    serverInfo: function () { return undefined },
  }
}

test('POST /seen marks the session viewed on the remote with the row idle', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/session/ses_1/view': function () { return {} },
  })
  try {
    const servers = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])
    const observation = createObservation()
    observation.observeIdentity('e5', { id: 'ses_1', busyAt: IDLE - 5000, idleAt: IDLE, viewedAt: IDLE - 90000 })
    // Watch it run, then stop: that edge is what arms the reminder.
    observation.observeRunning('e5', new Set(['ses_1']), true)
    observation.observeRunning('e5', new Set(), true)
    const routes = createRoutes({ servers: servers, delegate: {}, observation: observation, board: boardStub(observation) })
    const seen = routes.find(function (route) { return route.path === '/api/opencode-client/seen' })

    // The row is in the unseen partition before the call.
    assert.equal(observation.board().unseen.length, 1)

    const response = await seen.fetch({ url: '/api/opencode-client/seen', json: function () { return Promise.resolve({ server: 'e5', session: 'ses_1' }) } })
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.supported, true)
    assert.equal(payload.idle, IDLE, 'the idle comes from the observed row, not the clock')
    assert.equal(fake.views().length, 1)
    assert.equal(fake.views()[0].method, 'POST')
    assert.equal(fake.views()[0].path, '/api/session/ses_1/view')
    assert.deepEqual(JSON.parse(fake.views()[0].body), { idle: IDLE })
  } finally {
    await fake.close()
  }
})

test('POST /seen prefers an explicit idle and refuses to guess one', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/session/ses_2/view': function () { return {} },
  })
  try {
    const servers = normalizeServers([{ id: 'e5', url: fake.url, password: 'pw' }])
    const observation = createObservation()
    const routes = createRoutes({ servers: servers, delegate: {}, observation: observation, board: boardStub(observation) })
    const seen = routes.find(function (route) { return route.path === '/api/opencode-client/seen' })

    const explicit = await seen.fetch({ url: '/api/opencode-client/seen', json: function () { return Promise.resolve({ server: 'e5', session: 'ses_2', idle: 1234 }) } })
    assert.equal((await explicit.json()).ok, true)
    assert.deepEqual(JSON.parse(fake.views()[0].body), { idle: 1234 })

    // Unknown session and no idle: 400 and no remote write, never `Date.now()`
    // (which could run ahead of a live run and mark an in-flight turn read).
    const unknown = await seen.fetch({ url: '/api/opencode-client/seen', json: function () { return Promise.resolve({ server: 'e5', session: 'ses_missing' }) } })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /idle required/)
    assert.equal(fake.views().length, 1, 'no view request for the refused call')
  } finally {
    await fake.close()
  }
})

test('markSessionViewed reports v1 as unsupported without touching it', async function () {
  const fake = await startServer({ '/api/info': function () { return { version: '2.3.0' } } })
  try {
    // No password: the probe treats it as v1, which has no read marker at all.
    const server = normalizeServers([{ id: 'old', url: fake.url }])[0]
    assert.deepEqual(await markSessionViewed(server, 'ses_1', IDLE), { supported: false, ok: false })
    assert.equal(fake.views().length, 0)
  } finally {
    await fake.close()
  }
})

test('summarizeSession carries busy/idle/viewed and outcome, and v1 simply lacks them', function () {
  const v2 = summarizeSession({
    id: 'ses_1',
    title: 't',
    outcome: 'succeeded',
    time: { created: 1, updated: 2, busy: 100, idle: 200, viewed: 50 },
  })
  assert.equal(v2.busyAt, 100)
  assert.equal(v2.idleAt, 200)
  assert.equal(v2.viewedAt, 50)
  assert.equal(v2.outcome, 'succeeded')
  // v1 sessions only carry time.created/updated.
  const v1 = summarizeSession({ id: 'ses_old', time: { created: 1, updated: 2 } })
  assert.equal(v1.busyAt, undefined)
  assert.equal(v1.idleAt, undefined)
  assert.equal(v1.viewedAt, undefined)
})