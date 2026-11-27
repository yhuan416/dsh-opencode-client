/**
 * Tests for v2 completion handling in delegate.waitAssistant: `succeeded`
 * resolves (with polling extraction), `failed` and `interrupted` reject
 * instead of hanging. v1 is no longer supported.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { waitAssistant } from '../lib/delegate.js'
import { normalizeServers } from '../lib/config.js'

const ASSISTANT_MESSAGE = [{
  type: 'assistant',
  id: 'msg_1',
  content: [{ type: 'text', text: 'DONE' }],
  time: { created: 1, completed: 2 },
}]
const IDLE_MESSAGE = [{ type: 'idle', id: 'idle_1', outcome: 'succeeded', time: { created: 3, completed: 3 } }]

function startServer(handler) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      requests.push({ method: request.method, url: request.url })
      handler(request, response)
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

function makeServer(input) {
  const servers = normalizeServers([input])
  assert.equal(servers.length, 1)
  return servers[0]
}

/** Fake subscribeIdle that reports one completion kind shortly after subscribing. */
function idleSubscriber(kind) {
  return function (server, sessionId, listener) {
    const timer = setTimeout(function () { listener(kind) }, 10)
    return function () { clearTimeout(timer) }
  }
}

async function runWith(kind) {
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.4.2' })
      return
    }
    if (request.url.indexOf('type=idle') !== -1) {
      replyJson(response, 200, { data: IDLE_MESSAGE, cursor: { next: null } })
      return
    }
    replyJson(response, 200, { data: ASSISTANT_MESSAGE, cursor: { next: null } })
  })
  try {
    const server = makeServer({ id: 'done', url: fake.url, password: 'secret', apiVersion: '2' })
    return await waitAssistant(server, 'ses_1', undefined, undefined, 5000, idleSubscriber(kind))
  } finally {
    await fake.close()
  }
}

test('v2 succeeded completion resolves after the polling extraction', async function () {
  const outcome = await runWith('succeeded')
  assert.equal(outcome.text, 'DONE')
})

test('v2 failed completion rejects with a failed-run error', async function () {
  await assert.rejects(runWith('failed'), /remote session failed/)
})

test('v2 interrupted completion rejects as aborted', async function () {
  await assert.rejects(runWith('interrupted'), /aborted/)
})

test('a transport error kind still rejects instead of polling forever', async function () {
  await assert.rejects(runWith('error'), /remote session failed/)
})