/**
 * Integration tests for the SSE consumer (lib/sse.js): version-specific
 * endpoints, Basic auth on the v2 stream, progress state and completion kinds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createEventStream } from '../lib/sse.js'
import { normalizeServers } from '../lib/config.js'

const SES = 'ses_00000000000000000000000002'
const BASIC = 'Basic ' + Buffer.from('opencode:secret').toString('base64')

function startServer(handler) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      requests.push({ url: request.url, headers: request.headers })
      handler(request, response, requests)
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        close: function () {
          return new Promise(function (done) {
            server.closeAllConnections()
            server.close(function () { done() })
          })
        },
      })
    })
  })
}

function replyJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function openSse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  response.write(': heartbeat\n\n')
}

function writeEvent(response, payload) {
  response.write('data: ' + JSON.stringify(payload) + '\n\n')
}

function waitFor(predicate, timeoutMs) {
  const limit = timeoutMs === undefined ? 3000 : timeoutMs
  return new Promise(function (resolve, reject) {
    const startedAt = Date.now()
    const timer = setInterval(function () {
      let value
      try { value = predicate() } catch (error) { clearInterval(timer); reject(error); return }
      if (value) { clearInterval(timer); resolve(value); return }
      if (Date.now() - startedAt > limit) { clearInterval(timer); reject(new Error('timed out waiting for condition')) }
    }, 10)
  })
}

function makeServer(input) {
  const servers = normalizeServers([input])
  assert.equal(servers.length, 1)
  return servers[0]
}

function createStream() {
  return createEventStream({
    activeRuns: new Map(),
    handlePermission: function () {},
    handleQuestion: function () {},
  })
}

test('v2: subscribes /api/event and maps the execution/tool sequence to completion', async function () {
  let stream
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/event') {
      openSse(response)
      stream = response
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  const events = createStream()
  const server = makeServer({ id: 'v2', url: fake.url, apiVersion: '2' })
  let dispose
  try {
    dispose = events.subscribeEvents(server)
    await waitFor(function () { return server.sse.state === 'open' && stream !== undefined })
    assert.equal(server.sse.target, '/api/event')

    const idle = new Promise(function (resolve) { events.subscribeIdle(server, SES, resolve) })
    writeEvent(stream, { id: 'e1', created: 1, type: 'session.tool.called', data: { sessionID: SES, id: 'call_1', name: 'bash', input: {} } })
    writeEvent(stream, { id: 'e2', created: 2, type: 'session.text.delta', data: { sessionID: SES, delta: 'hello ' } })
    writeEvent(stream, { id: 'e3', created: 3, type: 'session.tool.success', data: { sessionID: SES, id: 'call_1', name: 'bash', content: [{ type: 'text', text: 'hello world' }] } })
    writeEvent(stream, { id: 'e4', created: 4, type: 'session.execution.succeeded', data: { sessionID: SES } })

    assert.equal(await idle, 'succeeded')
    const progress = server.progress.get(SES)
    assert.equal(progress.status, 'idle')
    assert.equal(progress.tool, 'bash')
    assert.equal(progress.tail, 'hello world')
    const kinds = server.events.map(function (event) { return event.type })
    assert.ok(kinds.indexOf('tool.started') >= 0)
    assert.ok(kinds.indexOf('text.delta') >= 0)
    assert.ok(kinds.indexOf('tool.finished') >= 0)
    assert.ok(kinds.indexOf('run.finished') >= 0)
  } finally {
    if (dispose !== undefined) dispose()
    await fake.close()
  }
})

test('v2: probes /api/info, subscribes /api/event with Basic auth, completes on execution.succeeded', async function () {
  let stream
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.3.0', pid: 1, urls: [], paths: { tmp: '/tmp' } })
      return
    }
    if (request.url === '/api/event') {
      openSse(response)
      stream = response
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  const events = createStream()
  const server = makeServer({ id: 'v2', url: fake.url, password: 'secret' })
  let dispose
  try {
    dispose = events.subscribeEvents(server)
    await waitFor(function () { return server.sse.state === 'open' && stream !== undefined })
    assert.equal(server.sse.version, '2')
    assert.equal(server.sse.target, '/api/event')
    const probe = fake.requests.find(function (request) { return request.url === '/api/info' })
    const eventRequest = fake.requests.find(function (request) { return request.url === '/api/event' })
    assert.equal(probe.headers.authorization, BASIC)
    assert.equal(eventRequest.headers.authorization, BASIC)

    const idle = new Promise(function (resolve) { events.subscribeIdle(server, SES, resolve) })
    writeEvent(stream, { id: 'evt_1', created: 1, type: 'session.execution.started', data: { sessionID: SES } })
    writeEvent(stream, { id: 'evt_2', created: 2, type: 'session.text.delta', data: { sessionID: SES, assistantMessageID: 'msg_1', ordinal: 0, delta: 'PONG' } })
    writeEvent(stream, { id: 'evt_3', created: 3, type: 'session.tool.called', data: { sessionID: SES, assistantMessageID: 'msg_1', id: 'call_1', name: 'shell', input: { command: 'echo x' }, executed: false } })
    writeEvent(stream, { id: 'evt_4', created: 4, type: 'session.tool.success', data: { sessionID: SES, assistantMessageID: 'msg_1', id: 'call_1', content: [{ type: 'text', text: 'HELLO\n' }], metadata: { exit: 0 }, executed: false } })
    // Forward compatibility: an unknown event must not stop the stream or crash.
    writeEvent(stream, { id: 'evt_5', created: 5, type: 'session.future.event', data: { sessionID: SES } })
    writeEvent(stream, { id: 'evt_6', created: 6, type: 'session.execution.succeeded', data: { sessionID: SES } })

    assert.equal(await idle, 'succeeded')
    const progress = server.progress.get(SES)
    assert.equal(progress.status, 'idle')
    assert.equal(progress.tool, 'shell')
    assert.equal(progress.tail, 'HELLO\n')
    const kinds = server.events.map(function (event) { return event.type })
    assert.ok(kinds.indexOf('run.started') >= 0)
    assert.ok(kinds.indexOf('tool.finished') >= 0)
    assert.ok(kinds.indexOf('unknown') >= 0)
  } finally {
    if (dispose !== undefined) dispose()
    await fake.close()
  }
})

test('v2: session.idle is not completion; execution.failed completes as failed', async function () {
  let stream
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.3.0' })
      return
    }
    if (request.url === '/api/event') {
      openSse(response)
      stream = response
      return
    }
    replyJson(response, 404, {})
  })
  const events = createStream()
  const server = makeServer({ id: 'v2-failed', url: fake.url, password: 'secret', apiVersion: '2' })
  let dispose
  try {
    dispose = events.subscribeEvents(server)
    await waitFor(function () { return server.sse.state === 'open' && stream !== undefined })
    const kinds = []
    events.subscribeIdle(server, SES, function (kind) { kinds.push(kind) })

    writeEvent(stream, { id: 'evt_1', created: 1, type: 'session.idle', data: { sessionID: SES } })
    writeEvent(stream, { id: 'evt_2', created: 2, type: 'session.status', data: { sessionID: SES, status: { type: 'idle' } } })
    await new Promise(function (resolve) { setTimeout(resolve, 60) })
    assert.deepEqual(kinds, [], 'v2 session.idle/session.status must not complete a run')

    writeEvent(stream, { id: 'evt_3', created: 3, type: 'session.execution.failed', data: { sessionID: SES, error: { type: 'unknown', message: 'boom' } } })
    await waitFor(function () { return kinds.length > 0 })
    assert.deepEqual(kinds, ['failed'])
    assert.equal(server.progress.get(SES).status, 'error')
  } finally {
    if (dispose !== undefined) dispose()
    await fake.close()
  }
})

test('v2: execution.interrupted completes as interrupted', async function () {
  let stream
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.3.0' })
      return
    }
    if (request.url === '/api/event') {
      openSse(response)
      stream = response
      return
    }
    replyJson(response, 404, {})
  })
  const events = createStream()
  const server = makeServer({ id: 'v2-interrupted', url: fake.url, password: 'secret', apiVersion: '2' })
  let dispose
  try {
    dispose = events.subscribeEvents(server)
    await waitFor(function () { return server.sse.state === 'open' && stream !== undefined })
    const idle = new Promise(function (resolve) { events.subscribeIdle(server, SES, resolve) })
    writeEvent(stream, { id: 'evt_1', created: 1, type: 'session.execution.interrupted', data: { sessionID: SES, reason: 'user' } })
    assert.equal(await idle, 'interrupted')
  } finally {
    if (dispose !== undefined) dispose()
    await fake.close()
  }
})
test('v2: permission and form events reach the interaction bridge', async function () {
  let stream
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.3.0' })
      return
    }
    if (request.url === '/api/event') {
      openSse(response)
      stream = response
      return
    }
    replyJson(response, 404, {})
  })
  const seen = []
  const events = createEventStream({
    activeRuns: new Map(),
    handlePermission: function (server, run, data) { seen.push({ kind: 'permission', data: data }) },
    handleQuestion: function (server, run, data) { seen.push({ kind: 'question', data: data }) },
  })
  const server = makeServer({ id: 'v2-bridge', url: fake.url, password: 'secret', apiVersion: '2' })
  let dispose
  try {
    dispose = events.subscribeEvents(server)
    await waitFor(function () { return server.sse.state === 'open' && stream !== undefined })
    writeEvent(stream, {
      id: 'evt_1', created: 1, type: 'permission.asked',
      data: { id: 'per_1', sessionID: SES, action: 'read', resources: ['a.txt'] },
    })
    writeEvent(stream, {
      id: 'evt_2', created: 2, type: 'form.created',
      data: { form: { id: 'frm_1', sessionID: SES, title: 'Questions', fields: [{ key: 'q0', type: 'string' }] } },
    })
    await waitFor(function () { return seen.length === 2 })
    assert.equal(seen[0].kind, 'permission')
    assert.equal(seen[0].data.action, 'read')
    assert.equal(seen[1].kind, 'question')
    assert.equal(seen[1].data.form.id, 'frm_1')
  } finally {
    if (dispose !== undefined) dispose()
    await fake.close()
  }
})

test('v2: onEvent feeds the observation registry before the state switch', async function () {
  const { createObservation } = await import('../lib/observation.js')
  const observation = createObservation()
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/event') {
      openSse(response)
      writeEvent(response, { id: 'e1', created: 1, type: 'permission.asked', data: { id: 'perm_9', sessionID: 'ses_x', action: 'bash', resources: ['git push'] } })
      return
    }
    replyJson(response, 404, {})
  })
  try {
    const stream = createEventStream({
      activeRuns: new Map(),
      handlePermission: function () {},
      handleQuestion: function () {},
      onEvent: function (server, event) { observation.observeEvent(server.id, event) },
    })
    const dispose = stream.subscribeEvents(makeServer({ id: 'v2', url: fake.url, apiVersion: '2' }))
    const waiting = await waitFor(function () {
      const board = observation.board()
      return board.needsMe.length > 0 ? board.needsMe[0] : undefined
    })
    assert.equal(waiting.status, 'waiting-permission')
    assert.equal(waiting.sessionId, 'ses_x')
    assert.match(waiting.pending.detail, /push/)
    dispose()
  } finally {
    await fake.close()
  }
})
