/**
 * Collection-path test: one fake OpenCode v2 server feeding the real
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
      Promise.resolve(handler(request)).then(function (value) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      })
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
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [], paths: { tmp: '/tmp' } } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/home/yhuan/workspace' }] } },
    '/api/session': function () { return { data: SESSIONS, cursor: { next: null } } },
    '/api/session/active': function () { return { data: { ses_running: { type: 'busy' }, ses_child: { type: 'busy' } } } },
    '/api/permission/request': function () {
      return { data: [{ id: 'perm_1', sessionID: 'ses_running', permission: 'bash', patterns: ['rm -rf /tmp/x'] }] }
    },
    '/api/form': function () { return { data: [] } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
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
    // v2 uses the location-level pending endpoints, never the v1 globals.
    assert.ok(fake.requests.includes('/api/permission/request'))
    assert.ok(fake.requests.includes('/api/form'))
    assert.equal(fake.requests.includes('/permission'), false)
    assert.equal(fake.requests.includes('/question'), false)
  } finally {
    await fake.close()
  }
})

test('a fresh listing prunes sessions deleted while the stream was down', async function () {
  let sessions = [
    { id: 'ses_keep', title: 'keep', directory: '/tmp', time: { updated: NOW - 1000 } },
    { id: 'ses_vanish', title: 'deleted elsewhere', directory: '/tmp', time: { updated: NOW - 2000 } },
  ]
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () { return { data: sessions, cursor: { next: null } } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    const server = servers[0]
    const observation = createObservation()
    const sync = function (value) {
      for (const group of value.projects) for (const summary of group.sessions) observation.observeIdentity(server.id, summary)
    }
    const fresh = function (listing) {
      observation.retain(server.id, listing.ids, { since: listing.requestedAt, olderThan: listing.truncated === true ? listing.minUpdatedAt : undefined })
    }

    const first = await collectServer(server, { onListing: fresh })
    sync(first)
    observation.observeRunning(server.id, new Set(), true)
    assert.equal(observation.board().idleCount, 2)

    // A cached listing must not run the prune callback (it is not authoritative).
    let calls = 0
    const cached = await collectServer(server, { onListing: function (listing) { calls += 1; fresh(listing) } })
    assert.equal(calls, 0)
    assert.equal(cached, first, 'served from the snapshot cache')

    // Deleted out of band: the next fresh listing no longer contains it, and the
    // board drops the stale row instead of keeping it forever.
    sessions = sessions.filter(function (item) { return item.id !== 'ses_vanish' })
    server.snapshot = undefined
    const second = await collectServer(server, { onListing: fresh })
    sync(second)
    observation.observeRunning(server.id, new Set(), true)
    const board = observation.board()
    assert.equal(board.idleCount, 1)
    assert.deepEqual(board.idle.map(function (row) { return row.sessionId }), ['ses_keep'])
  } finally {
    await fake.close()
  }
})

test('a listing raced by a deletion is served but not cached', async function () {
  let serverRef
  let bumpEpoch = true
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () {
      // Simulates `session.deleted` arriving while the listing request is in
      // flight: the response still contains the deleted session.
      if (bumpEpoch) {
        bumpEpoch = false
        serverRef.snapshotEpoch = (typeof serverRef.snapshotEpoch === 'number' ? serverRef.snapshotEpoch : 0) + 1
      }
      return { data: [{ id: 'ses_old', title: 'old', directory: '/tmp', time: { updated: NOW } }], cursor: { next: null } }
    },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    serverRef = servers[0]
    const raced = await collectServer(serverRef)
    assert.equal(raced.raced, true, 'raced listing is marked for the board')
    assert.equal(serverRef.snapshot, undefined, 'raced listing must not be cached')
    const before = fake.requests.filter(function (path) { return path === '/api/session' }).length
    await collectServer(serverRef)
    const after = fake.requests.filter(function (path) { return path === '/api/session' }).length
    assert.equal(after, before + 1, 'next call refetches instead of reusing a stale snapshot')
  } finally {
    await fake.close()
  }
})

test('createBoard prunes sessions the server listing dropped', async function () {
  const { createBoard } = await import('../lib/board.js')
  let sessions = [
    { id: 'ses_a', title: 'a', directory: '/tmp', time: { updated: NOW - 1000 } },
    { id: 'ses_b', title: 'b', directory: '/tmp', time: { updated: NOW - 500 } },
  ]
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () { return { data: sessions, cursor: { next: null } } },
    '/api/session/active': function () { return { data: {} } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    const server = servers[0]
    const observation = createObservation()
    const board = createBoard({ servers: servers, observation: observation })
    await board.refreshServer(server)
    await board.refreshServer(server)
    assert.equal(board.snapshot().idleCount, 2)

    sessions = sessions.filter(function (item) { return item.id !== 'ses_a' })
    server.snapshot = undefined
    await board.refreshServer(server)
    const after = board.snapshot()
    assert.equal(after.idleCount, 1)
    assert.deepEqual(after.idle.map(function (row) { return row.sessionId }), ['ses_b'])
  } finally {
    await fake.close()
  }
})

test('concurrent refreshes share one listing request', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () { return { data: [{ id: 'ses_a', title: 'a', directory: '/tmp', time: { updated: NOW } }], cursor: { next: null } } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    const server = servers[0]
    const seen = []
    const [first, second] = await Promise.all([
      collectServer(server, { onListing: function (listing) { seen.push(['first', listing.ids.length]) } }),
      collectServer(server, { onListing: function (listing) { seen.push(['second', listing.ids.length]) } }),
    ])
    assert.equal(first, second, 'both callers see the same snapshot')
    // Both waiting refreshes must hear about the shared listing; a listener that
    // joins mid-flight may not be dropped or the second board refresh loses its
    // prune opportunity.
    assert.deepEqual(seen.sort(), [['first', 1], ['second', 1]])
    const listings = fake.requests.filter(function (path) { return path === '/api/session' }).length
    assert.equal(listings, 1, 'concurrent refreshes must not fan out into duplicate list calls')
  } finally {
    await fake.close()
  }
})

test('a truncated listing reports the page boundary for safe pruning', async function () {
  const many = []
  for (let index = 0; index < 500; index += 1) {
    many.push({ id: 'ses_' + index, title: 't', directory: '/tmp', time: { updated: NOW - index * 1000 } })
  }
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () { return { data: many, cursor: { next: 'cursor-2' } } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    let listing
    await collectServer(servers[0], { onListing: function (value) { listing = value } })
    assert.ok(listing, 'a full page still reports its listing metadata')
    assert.equal(listing.truncated, true)
    assert.equal(listing.ids.length, 500)
    assert.equal(listing.minUpdatedAt, NOW - 499 * 1000, 'the oldest listed row is the prune lower bound')
  } finally {
    await fake.close()
  }
})

test('a raced listing is not applied to the board', async function () {
  const { createBoard } = await import('../lib/board.js')
  const { invalidateSnapshot } = await import('../lib/snapshot.js')
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/project': function () { return { data: [{ id: 'proj_1', canonical: '/tmp' }] } },
    '/api/session': function () {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ data: [{ id: 'ses_gone', title: 'gone', directory: '/tmp', time: { updated: NOW } }], cursor: { next: null } }) }, 120)
      })
    },
    '/api/session/active': function () { return { data: {} } },
    '/api/form': function () { return { data: [] } },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    const server = servers[0]
    const observation = createObservation()
    const board = createBoard({ servers: servers, observation: observation })
    const refreshing = board.refreshServer(server)
    await new Promise(function (resolve) { setTimeout(resolve, 30) })
    // The session is deleted while the listing request is still in flight.
    invalidateSnapshot(server)
    await refreshing
    assert.equal(observation.rows().length, 0, 'the raced listing must not observe the deleted row back')
    assert.equal(board.snapshot().idleCount, 0)
  } finally {
    await fake.close()
  }
})

test('collectPending renders the v2 question text on the card detail', async function () {
  const fake = await startServer({
    '/api/info': function () { return { version: '2.4.2', pid: 1, urls: [] } },
    '/api/permission/request': function () { return { data: [] } },
    '/api/form': function () {
      return { data: [{ id: 'frm_1', sessionID: 'ses_q', title: 'Questions', fields: [{ key: 'q0', type: 'string', description: 'state-test：是否继续？' }] }] }
    },
  })
  try {
    const servers = normalizeServers([{ id: 'n100', url: fake.url, password: 'secret' }])
    const entries = await collectPending(servers[0], ['ses_q'])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].detail, 'form: state-test：是否继续？')
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

test('GET /board reports probe reason and SSE reconnect health', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const observation = createObservation()
  const server = {
    id: 'old', label: 'old opencode', url: 'http://127.0.0.1:4096', detectedVersion: '1',
    versionProbe: { version: '1', reason: 'missing-password', at: 1700000000000, detail: undefined },
    sse: { state: 'open', attempts: 0, connects: 4, openedAt: 1700000001000 },
  }
  const routes = createRoutes({
    servers: [server],
    delegate: {},
    observation: observation,
    board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function (options) { return observation.board(options) }, serverInfo: function () { return { version: null, state: 'online', groups: 0 } } },
  })
  const route = routes.find(function (candidate) { return candidate.path === '/api/opencode-client/board' })
  const payload = await (await route.fetch({ url: '/api/opencode-client/board' })).json()
  const row = payload.servers[0]
  assert.equal(row.apiVersion, '1', 'v1 instances stay visible so the board can flag them as frozen')
  assert.equal(row.probe.reason, 'missing-password')
  assert.equal(row.probe.at, 1700000000000)
  assert.equal(row.sse.state, 'open')
  assert.equal(row.sse.attempts, 0)
  assert.equal(row.sse.connects, 4, 'connects > 1 means the stream had to reconnect')
})
