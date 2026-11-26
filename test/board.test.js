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