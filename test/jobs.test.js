/**
 * Background jobs: work that outlives the agent turn.
 *
 * Verified on OpenCode 2.3.0: an agent-started shell keeps running after the
 * session is `idle` (time.idle set, `/session/active` empty, execution
 * succeeded), and only `/experimental/job` still reports it. These tests pin
 * the normalization, the degradation, the status precedence and the board row.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers } from '../lib/config.js'
import { collectJobs } from '../lib/jobs.js'
import { createObservation } from '../lib/observation.js'
import { createBoard } from '../lib/board.js'

function startFake(routes) {
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
        hits: function (needle) {
          return requests.filter(function (url) { return url.indexOf(needle) !== -1 }).length
        },
        close: function () { return new Promise(function (done) { server.close(done) }) },
      })
    })
  })
}

const JOB = {
  kind: 'shell',
  id: 'sh_1',
  sessionID: 'ses_a',
  status: 'running',
  title: '/usr/bin/python3 script.py',
  command: '/usr/bin/python3 /tmp/jira_weekly_report.py',
  time: { started: 1_760_000_000_000 },
}

test('collectJobs keeps running jobs, drops finished ones and caches', async function () {
  const fake = await startFake({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/experimental/job': function () {
      return { data: [JOB, { ...JOB, id: 'sh_2', sessionID: 'ses_b', status: 'completed' }] }
    },
  })
  try {
    const server = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])[0]
    const first = await collectJobs(server)
    assert.equal(first.supported, true)
    assert.deepEqual(first.jobs.map(function (job) { return [job.id, job.sessionID, job.status, job.startedAt] }), [
      ['sh_1', 'ses_a', 'running', 1_760_000_000_000],
    ])
    assert.equal(first.jobs[0].command, '/usr/bin/python3 /tmp/jira_weekly_report.py')
    await collectJobs(server)
    assert.equal(fake.hits('/api/experimental/job'), 1, 'the board polls every 5 s; the cache must dedupe within a tick')
  } finally {
    await fake.close()
  }
})

test('collectJobs degrades to no background rows when the endpoint is missing', async function () {
  const fake = await startFake({ '/api/info': function () { return { version: '2.3.0' } } })
  try {
    const server = normalizeServers([{ id: 'old2x', url: fake.url, password: 'pw' }])[0]
    const first = await collectJobs(server)
    assert.equal(first.supported, false)
    assert.deepEqual(first.jobs, [])
    await collectJobs(server)
    assert.equal(fake.hits('/api/experimental/job'), 1, 'a failed probe is cached instead of retried every tick')
  } finally {
    await fake.close()
  }
})

test('collectJobs never probes a v1 server', async function () {
  const fake = await startFake({ '/api/info': function () { return { version: '1.18.31' } } })
  try {
    const server = normalizeServers([{ id: 'v1', url: fake.url }])[0]
    const result = await collectJobs(server)
    assert.equal(result.supported, false)
    assert.equal(fake.requests.length, 0)
  } finally {
    await fake.close()
  }
})

test('a running job makes an idle session `background`, and dropping it restores idle', function () {
  const observation = createObservation({ now: function () { return 5_000 } })
  observation.observeIdentity('server-b', { id: 'ses_a', title: '你好', updatedAt: 2_000 })
  observation.observeRunning('server-b', new Set(), true)
  observation.observeJobs('server-b', [{ ...JOB }])
  let rows = observation.rows('server-b')
  assert.equal(rows[0].status, 'background')
  assert.equal(rows[0].job.command, JOB.command)
  assert.equal(rows[0].job.kind, 'shell')
  const board = observation.board({})
  assert.equal(board.background.length, 1)
  assert.equal(board.backgroundCount, 1)
  assert.equal(board.idle.length, 0, 'a background row is not idle')

  observation.observeJobs('server-b', [])
  rows = observation.rows('server-b')
  assert.equal(rows[0].status, 'idle')
  assert.equal(rows[0].job, null)
})

test('background yields to running and to a pending request', function () {
  const observation = createObservation({ now: function () { return 5_000 } })
  observation.observeIdentity('server-b', { id: 'ses_a', title: 'x' })
  observation.observeJobs('server-b', [{ ...JOB }])
  observation.observeRunning('server-b', new Set(['ses_a']), true)
  assert.equal(observation.rows('server-b')[0].status, 'running')
  observation.markPending('server-b', 'ses_a', { kind: 'permission', requestId: 'p1', detail: 'bash' })
  assert.equal(observation.rows('server-b')[0].status, 'waiting-permission')
})

test('board refresh reports a job whose session already went idle', async function () {
  const fake = await startFake({
    '/api/info': function () { return { version: '2.3.0' } },
    '/api/project': function () { return { data: [] } },
    '/api/session': function () {
      return {
        data: [{
          id: 'ses_a', title: '你好', location: { directory: '/home/user' }, cost: 0,
          time: { created: 1_760_000_000_000, updated: 1_760_000_010_000, busy: 1_760_000_005_000, idle: 1_760_000_010_000 },
        }],
      }
    },
    '/api/session/active': function () { return { data: {} } },
    '/api/permission/request': function () { return { data: [] } },
    '/api/form': function () { return { data: [] } },
    '/api/experimental/job': function () { return { data: [JOB] } },
  })
  try {
    const servers = normalizeServers([{ id: 'server-b', url: fake.url, password: 'pw' }])
    const observation = createObservation({ now: function () { return 1_760_000_020_000 } })
    const board = createBoard({ servers: servers, observation: observation })
    await board.refreshAll()
    const snapshot = board.snapshot({})
    assert.equal(snapshot.background.length, 1)
    assert.equal(snapshot.background[0].status, 'background')
    assert.equal(snapshot.background[0].job.command, JOB.command)
    assert.equal(snapshot.idle.length, 0)
    assert.equal(snapshot.running.length, 0)
  } finally {
    await fake.close()
  }
})