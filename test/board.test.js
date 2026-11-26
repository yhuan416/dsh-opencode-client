/**
 * Collection-path test: one fake OpenCode v1 server feeding the real
 * `collect*` functions into the observation registry, then reading the board.
 * This is the offline stand-in for `scripts/probe-observation.mjs`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectServer, collectStatus, collectPending } from '../lib/sessions.js'
import { createObservation } from '../lib/observation.js'

const NOW = 1_760_000_000_000

function startServer(routes) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const path = request.url.split('?')[0]
      requests.push(path)
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
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

const SESSIONS = [
  { id: 'ses_running', title: 'api probe', directory: '/home/yhuan/workspace', time: { created: NOW - 60000, updated: NOW - 1000 } },
  { id: 'ses_child', title: 'subagent', parentID: 'ses_running', directory: '/home/yhuan/workspace', time: { updated: NOW - 500 } },
  { id: 'ses_idle', title: '周报', directory: '/home/yhuan/workspace/gitlab', time: { updated: NOW - 86400000 } },
]

test('collectServer + collectStatus + collectPending fill the board', async function () {
  const fake = await startServer({
    '/global/health': function () { return { healthy: true } },
    '/project': function () { return [{ id: 'proj_1', worktree: '/home/yhuan/workspace' }] },
    '/session': function () { return SESSIONS },
    '/session/status': function () { return { ses_running: { type: 'busy' }, ses_child: { type: 'busy' } } },
    '/permission': function () {
      return [{ id: 'perm_1', sessionID: 'ses_running', permission: 'bash', patterns: ['rm -rf /tmp/x'] }]
    },
    '/question': function () { return [] },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url }])
    const server = servers[0]
    const observation = createObservation()

    const value = await collectServer(server)
    for (const group of value.projects) {
      for (const summary of group.sessions) observation.observeIdentity(server.id, summary)
    }
    const statuses = await collectStatus(server)
    const runningIds = new Set(Object.keys(statuses).filter(function (id) {
      return statuses[id] !== null && typeof statuses[id] === 'object' && statuses[id].type !== 'idle'
    }))
    assert.deepEqual(Array.from(runningIds).sort(), ['ses_child', 'ses_running'])
    observation.observeRunning(server.id, runningIds, true)

    const pending = await collectPending(server, Array.from(runningIds))
    assert.equal(pending.length, 1)
    assert.equal(pending[0].sessionId, 'ses_running')
    assert.equal(pending[0].kind, 'permission')
    assert.match(pending[0].detail, /bash/)
    observation.observePendingSnapshot(server.id, pending)

    const board = observation.board()
    assert.equal(board.needsMe.length, 1)
    assert.equal(board.needsMe[0].sessionId, 'ses_running')
    assert.equal(board.needsMe[0].status, 'waiting-permission')
    // The child folds into its parent; the idle session stays out of needs-me.
    assert.equal(board.idleCount, 1)
    assert.equal(board.idle[0].sessionId, 'ses_idle')
    assert.equal(board.needsMe[0].childCount, 1)
    // v1 uses the global pending endpoints, never per-session ones.
    assert.ok(fake.requests.includes('/permission'))
    assert.ok(fake.requests.includes('/question'))
  } finally {
    await fake.close()
  }
})

test('an unreachable server yields no pending and no throw', async function () {
  const servers = normalizeServers([{ id: 'dead', url: 'http://127.0.0.1:9' }])
  const observation = createObservation()
  const pending = await collectPending(servers[0], ['ses_x'])
  assert.deepEqual(pending, [])
  assert.equal(observation.rows().length, 0)
})
test('GET /board exposes per-server version/state/groups', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const observation = createObservation()
  const fakeServer = { id: 'n100', label: 'n100 opencode', url: 'http://127.0.0.1:4096', sse: { state: 'open' } }
  const boardService = {
    observedById: function () { return new Map() },
    refreshAll: function () { return Promise.resolve() },
    snapshot: function (options) { return observation.board(options) },
    serverInfo: function () { return { version: '2.3.0', state: 'online', groups: 3 } },
  }
  const routes = createRoutes({ servers: [fakeServer], delegate: {}, observation: observation, board: boardService })
  const route = routes.find(function (candidate) { return candidate.path === '/api/opencode-client/board' })
  assert.ok(route, 'board route is registered')
  const response = await route.fetch({ url: '/api/opencode-client/board' })
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.servers.length, 1)
  assert.equal(payload.servers[0].version, '2.3.0')
  assert.equal(payload.servers[0].state, 'online')
  assert.equal(payload.servers[0].groups, 3)
})

test('POST /servers and /probe drive the config editor and a real probe', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const { normalizeServers } = await import('../lib/config.js')
  const calls = []
  const configApi = {
    available: function () { return true },
    add: function (server) { calls.push(['add', server]); return Promise.resolve({ ok: true }) },
    remove: function (id) { calls.push(['remove', id]); return Promise.resolve({ ok: true }) },
  }
  const routes = createRoutes({
    servers: [],
    delegate: {},
    observation: createObservation(),
    board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function () { return { needsMe: [], running: [], idle: [], idleCount: 0, unknown: [] } }, serverInfo: function () { return undefined } },
    config: configApi,
    normalizeServers: normalizeServers,
  })
  const serversRoute = routes.filter(function (route) { return route.path === '/api/opencode-client/servers' })
  const post = serversRoute.find(function (route) { return route.methods.includes('POST') })
  const del = routes.find(function (route) { return route.path === '/api/opencode-client/servers/remove' })

  const body = JSON.stringify({ server: { id: 'e5', url: 'http://192.168.4.65:4096/', password: 'pw', label: 'e5 opencode' } })
  const created = await post.fetch({ url: '/api/opencode-client/servers', json: function () { return Promise.resolve(JSON.parse(body)) } })
  const createdPayload = await created.json()
  assert.equal(createdPayload.ok, true)
  assert.deepEqual(calls[0], ['add', { id: 'e5', url: 'http://192.168.4.65:4096', label: 'e5 opencode', password: 'pw' }])

  const removed = await del.fetch({ url: '/api/opencode-client/servers/remove', json: function () { return Promise.resolve({ id: 'e5' }) } })
  assert.equal((await removed.json()).ok, true)
  assert.deepEqual(calls[1], ['remove', 'e5'])
})

test('POST /probe reports the API generation of a live server', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const { normalizeServers } = await import('../lib/config.js')
  const fake = await startServer({
    '/api/info': function () { return { version: '2.3.0', urls: [] } },
  })
  try {
    const routes = createRoutes({
      servers: [],
      delegate: {},
      observation: createObservation(),
      board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function () { return { needsMe: [], running: [], idle: [], idleCount: 0, unknown: [] } }, serverInfo: function () { return undefined } },
      config: undefined,
      normalizeServers: normalizeServers,
    })
    const probe = routes.find(function (route) { return route.path === '/api/opencode-client/probe' })
    // v2 probing needs a password: without one the transport treats the server as v1.
    const response = await probe.fetch({ url: '/api/opencode-client/probe', json: function () { return Promise.resolve({ url: fake.url, password: 'pw' }) } })
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.apiVersion, '2')
    assert.equal(payload.version, '2.3.0')
  } finally {
    await fake.close()
  }
})

test('route paths are unique (registration is keyed by path, not method)', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const routes = createRoutes({
    servers: [],
    delegate: {},
    observation: createObservation(),
    board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function () { return { needsMe: [], running: [], idle: [], idleCount: 0, unknown: [] } }, serverInfo: function () { return undefined } },
    config: undefined,
  })
  const paths = routes.map(function (route) { return route.path })
  assert.equal(new Set(paths).size, paths.length, 'duplicate route path: ' + paths.join(', '))
})

test('server-scoped routes resolve a server instead of throwing ReferenceError', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const observation = createObservation()
  const routes = createRoutes({
    servers: [{ id: 'n100', url: 'http://127.0.0.1:4096' }],
    delegate: {},
    observation: observation,
    board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function (options) { return observation.board(options) }, serverInfo: function () { return undefined } },
  })
  // 16 handlers used to call an unbound `findServer`, so every one of them threw
  // ReferenceError. Validation errors (400) prove the lookup now resolves.
  const fork = routes.find(function (route) { return route.path === '/api/opencode-client/fork' })
  const response = await fork.fetch({ url: '/api/opencode-client/fork', json: function () { return Promise.resolve({ server: 'n100' }) } })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /server and session required/)
  // An unknown id falls back to the default server rather than being rejected.
  const other = await fork.fetch({ url: '/api/opencode-client/fork', json: function () { return Promise.resolve({ server: 'nope' }) } })
  assert.equal(other.status, 400)
  assert.match((await other.json()).error, /server and session required/)
})
