/**
 * Transport-layer tests for lib/http.js: v1/v2 routing, API version probing,
 * Basic auth, and loud failures (401, HTML/SPA, non-JSON, HTTP/network errors).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { apiPath, describeApiVersion, ensureApiVersion, OpenCodeError, opencodeRequest, resetApiVersion } from '../lib/http.js'
import { normalizeApiVersion, normalizeServers } from '../lib/config.js'

const BASIC = 'Basic ' + Buffer.from('opencode:secret').toString('base64')

/** Start a local fake OpenCode server and record every request it receives. */
function startServer(handler) {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const chunks = []
      request.on('data', function (chunk) { chunks.push(chunk) })
      request.on('end', function () {
        const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
        requests.push(entry)
        handler(entry, response)
      })
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

function reply(response, status, value, contentType) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  response.writeHead(status, { 'content-type': contentType === undefined ? 'application/json' : contentType })
  response.end(body)
}

function replyJson(response, status, value) {
  reply(response, status, value, 'application/json')
}

function makeServer(input) {
  const servers = normalizeServers([input])
  assert.equal(servers.length, 1)
  return servers[0]
}

function rejectWith(promise, expected) {
  return assert.rejects(promise, function (error) {
    assert.ok(error instanceof OpenCodeError, 'expected OpenCodeError, got ' + String(error))
    assert.equal(error.code, expected.code)
    assert.equal(error.name, 'OpenCodeError')
    if (expected.status !== undefined) assert.equal(error.status, expected.status)
    if (expected.serverId !== undefined) assert.equal(error.serverId, expected.serverId)
    if (expected.messageMatch !== undefined) assert.match(error.message, expected.messageMatch)
    return true
  })
}

test('apiPath prefixes v2 requests exactly once and leaves v1 paths alone', function () {
  assert.equal(apiPath('2', '/session'), '/api/session')
  assert.equal(apiPath('2', '/session/ses_1/message?limit=2'), '/api/session/ses_1/message?limit=2')
  assert.equal(apiPath('2', '/api/reference'), '/api/reference')
  assert.equal(apiPath('2', '/api'), '/api')
  assert.equal(apiPath('1', '/session'), '/session')
  assert.equal(apiPath('1', '/api/reference'), '/api/reference')
})

test('normalizeApiVersion accepts auto/1/2 strings and numbers, defaults to auto', function () {
  assert.equal(normalizeApiVersion(undefined), 'auto')
  assert.equal(normalizeApiVersion('auto'), 'auto')
  assert.equal(normalizeApiVersion('1'), '1')
  assert.equal(normalizeApiVersion(1), '1')
  assert.equal(normalizeApiVersion('2'), '2')
  assert.equal(normalizeApiVersion(2), '2')
  assert.equal(normalizeApiVersion('v2'), 'auto')
})

test('auto mode detects v2, prefixes /api and sends Basic auth', async function () {
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 200, { version: '2.3.0', pid: 42, urls: [], paths: { tmp: '/tmp' } })
      return
    }
    if (request.url === '/api/session?limit=1') {
      replyJson(response, 200, { data: [], cursor: { previous: null, next: null } })
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  try {
    const server = makeServer({ id: 'v2', url: fake.url, password: 'secret' })
    const result = await opencodeRequest(server, '/session?limit=1')
    assert.equal(result.status, 200)
    assert.deepEqual(result.value, { data: [], cursor: { previous: null, next: null } })
    assert.equal(server.versionProbe.version, '2')
    assert.equal(server.versionProbe.reason, 'probe-ok')
    assert.equal(server.versionProbe.detail, '2.3.0')
    assert.equal(server.detectedVersion, '2')
    assert.equal(fake.requests[0].url, '/api/info')
    const sessionRequest = fake.requests.find(function (entry) { return entry.url === '/api/session?limit=1' })
    assert.ok(sessionRequest !== undefined)
    assert.equal(sessionRequest.headers.authorization, BASIC)
    // The probe result is cached: a second call makes no additional /api/info request.
    await opencodeRequest(server, '/session?limit=1')
    assert.equal(fake.requests.filter(function (entry) { return entry.url === '/api/info' }).length, 1)
  } finally {
    await fake.close()
  }
})

test('auto mode falls back to v1 when /api/info is not a v2 endpoint', async function () {
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 404, { _tag: 'NotFoundError' })
      return
    }
    if (request.url === '/global/health') {
      replyJson(response, 200, { healthy: true, version: '1.18.10' })
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  try {
    const server = makeServer({ id: 'v1', url: fake.url, password: 'secret' })
    const result = await opencodeRequest(server, '/global/health')
    assert.deepEqual(result.value, { healthy: true, version: '1.18.10' })
    assert.equal(server.versionProbe.version, '1')
    assert.equal(server.versionProbe.reason, 'http-error')
    assert.equal(server.versionProbe.status, 404)
    assert.equal(fake.requests[0].url, '/api/info')
    assert.ok(fake.requests.some(function (entry) { return entry.url === '/global/health' }))
    // v1 calls are not prefixed.
    assert.equal(fake.requests.some(function (entry) { return entry.url === '/api/global/health' }), false)
  } finally {
    await fake.close()
  }
})

test('auto mode falls back to v1 when the probe answers 401, and records why', async function () {
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      replyJson(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
      return
    }
    replyJson(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
  })
  try {
    const server = makeServer({ id: 'v1-401', url: fake.url, password: 'wrong' })
    const info = await ensureApiVersion(server)
    assert.equal(info.version, '1')
    assert.equal(info.reason, 'unauthorized')
    assert.equal(info.status, 401)
    await rejectWith(opencodeRequest(server, '/session'), { code: 'opencode.unauthorized', status: 401, serverId: 'v1-401' })
  } finally {
    await fake.close()
  }
})

test('missing password falls back to v1 without probing', async function () {
  let hits = 0
  const fake = await startServer(function (request, response) {
    hits += 1
    if (request.url === '/session') {
      replyJson(response, 200, [])
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  try {
    const server = makeServer({ id: 'no-password', url: fake.url })
    const info = await ensureApiVersion(server)
    assert.equal(info.version, '1')
    assert.equal(info.reason, 'missing-password')
    assert.equal(hits, 0, 'a missing password must not trigger a network probe')
    const result = await opencodeRequest(server, '/session')
    assert.deepEqual(result.value, [])
    const request = fake.requests[0]
    assert.equal(request.url, '/session')
    assert.equal(request.headers.authorization, undefined)
  } finally {
    await fake.close()
  }
})

test('explicit apiVersion=1 skips the probe entirely', async function () {
  const fake = await startServer(function (request, response) {
    if (request.url === '/session') {
      replyJson(response, 200, [])
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  try {
    const server = makeServer({ id: 'forced-v1', url: fake.url, password: 'secret', apiVersion: '1' })
    const info = await ensureApiVersion(server)
    assert.equal(info.version, '1')
    assert.equal(info.reason, 'configured')
    await opencodeRequest(server, '/session')
    assert.equal(fake.requests.some(function (entry) { return entry.url === '/api/info' }), false)
  } finally {
    await fake.close()
  }
})

test('explicit apiVersion=2 skips the probe and uses /api + Basic', async function () {
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/session') {
      replyJson(response, 200, { data: [] })
      return
    }
    replyJson(response, 404, { _tag: 'NotFoundError' })
  })
  try {
    const server = makeServer({ id: 'forced-v2', url: fake.url, password: 'secret', apiVersion: '2' })
    const result = await opencodeRequest(server, '/session')
    assert.deepEqual(result.value, { data: [] })
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.requests[0].url, '/api/session')
    assert.equal(fake.requests[0].headers.authorization, BASIC)
  } finally {
    await fake.close()
  }
})

test('401 raises opencode.unauthorized with a password hint', async function () {
  const fake = await startServer(function (request, response) {
    replyJson(response, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' })
  })
  try {
    const server = makeServer({ id: 'v2-401', url: fake.url, password: 'wrong', apiVersion: '2' })
    await rejectWith(opencodeRequest(server, '/session'), {
      code: 'opencode.unauthorized',
      status: 401,
      serverId: 'v2-401',
      messageMatch: /OPENCODE_SERVER_PASSWORD/,
    })
  } finally {
    await fake.close()
  }
})

test('HTML/SPA responses raise opencode.html_response, never empty data', async function () {
  const fake = await startServer(function (request, response) {
    reply(response, 200, '<!doctype html><html lang="en"><head><title>OpenCode</title></head></html>', 'text/html')
  })
  try {
    const server = makeServer({ id: 'spa', url: fake.url, password: 'secret', apiVersion: '1' })
    await assert.rejects(opencodeRequest(server, '/session'), function (error) {
      assert.ok(error instanceof OpenCodeError)
      assert.equal(error.code, 'opencode.html_response')
      assert.equal(error.status, 200)
      assert.match(error.contentType, /text\/html/)
      assert.match(String(error.bodySnippet), /doctype html/i)
      return true
    })
  } finally {
    await fake.close()
  }
})

test('non-JSON responses raise opencode.non_json', async function () {
  const fake = await startServer(function (request, response) {
    reply(response, 200, 'not json', 'text/plain')
  })
  try {
    const server = makeServer({ id: 'text', url: fake.url, password: 'secret', apiVersion: '1' })
    await rejectWith(opencodeRequest(server, '/session'), { code: 'opencode.non_json', status: 200 })
  } finally {
    await fake.close()
  }
})

test('non-2xx JSON responses raise opencode.http_error', async function () {
  const fake = await startServer(function (request, response) {
    replyJson(response, 500, { _tag: 'UnknownError', message: 'boom' })
  })
  try {
    const server = makeServer({ id: 'boom', url: fake.url, password: 'secret', apiVersion: '2' })
    await rejectWith(opencodeRequest(server, '/session'), { code: 'opencode.http_error', status: 500 })
  } finally {
    await fake.close()
  }
})

test('an unreachable server falls back to v1 with a recorded reason', async function () {
  const fake = await startServer(function (request, response) { replyJson(response, 200, {}) })
  const url = fake.url
  await fake.close()
  const server = makeServer({ id: 'dead', url: url, password: 'secret' })
  const info = await ensureApiVersion(server)
  assert.equal(info.version, '1')
  assert.equal(info.reason, 'unreachable')
  await assert.rejects(opencodeRequest(server, '/session'), function (error) {
    assert.ok(error instanceof OpenCodeError)
    assert.equal(error.code, 'opencode.network')
    return true
  })
})

test('a timed-out probe falls back to v1 with reason=timeout', async function () {
  const fake = await startServer(function () { /* never respond */ })
  try {
    const server = makeServer({ id: 'slow', url: fake.url, password: 'secret' })
    const info = await ensureApiVersion(server, { timeoutMs: 120 })
    assert.equal(info.version, '1')
    assert.equal(info.reason, 'timeout')
    assert.equal(info.errorCode, 'opencode.timeout')
  } finally {
    await fake.close()
  }
})

test('a v2 probe answering an unexpected version number falls back to v1', async function () {
  const fake = await startServer(function (request, response) {
    replyJson(response, 200, { version: '1.18.10' })
  })
  try {
    const server = makeServer({ id: 'odd', url: fake.url, password: 'secret' })
    const info = await ensureApiVersion(server)
    assert.equal(info.version, '1')
    assert.equal(info.reason, 'version-1')
    assert.equal(info.detail, '1.18.10')
  } finally {
    await fake.close()
  }
})

test('204 responses resolve with an undefined value', async function () {
  const fake = await startServer(function (request, response) {
    response.writeHead(204)
    response.end()
  })
  try {
    const server = makeServer({ id: 'v2-204', url: fake.url, password: 'secret', apiVersion: '2' })
    const result = await opencodeRequest(server, '/session/ses_1/interrupt', { method: 'POST', body: {} })
    assert.equal(result.status, 204)
    assert.equal(result.value, undefined)
  } finally {
    await fake.close()
  }
})

test('resetApiVersion forces a fresh probe', async function () {
  let probes = 0
  const fake = await startServer(function (request, response) {
    if (request.url === '/api/info') {
      probes += 1
      replyJson(response, 200, { version: '2.3.0' })
      return
    }
    replyJson(response, 200, { data: [] })
  })
  try {
    const server = makeServer({ id: 'reprobe', url: fake.url, password: 'secret' })
    await ensureApiVersion(server)
    assert.equal(probes, 1)
    await ensureApiVersion(server, { force: true })
    assert.equal(probes, 2)
    resetApiVersion(server)
    assert.equal(server.versionProbe, undefined)
    await ensureApiVersion(server)
    assert.equal(probes, 3)
  } finally {
    await fake.close()
  }
})

test('describeApiVersion renders a diagnosable one-liner', function () {
  assert.equal(describeApiVersion({ version: '2', reason: 'probe-ok', status: 200 }), 'v2 (probe-ok, status 200)')
  assert.equal(describeApiVersion({ version: '1', reason: 'missing-password' }), 'v1 (missing-password)')
  assert.equal(describeApiVersion(undefined), 'unknown')
})