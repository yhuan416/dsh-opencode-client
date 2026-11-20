/**
 * Routing tests for the aggregated `opencode-auto` provider: config
 * normalization, directory scoping, sticky/least-busy/round-robin ordering and
 * failover when a server refuses a start.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRouting, directoryCovers, createRouter, ROUTING_POLICIES } from '../lib/routing.js'
import { createRoutedProvider } from '../lib/provider.js'

function servers() {
  return [
    { id: 'a', directory: '/work/a' },
    { id: 'b', directory: '/work/b' },
    { id: 'c' },
  ]
}

test('normalizeRouting: defaults, policy parsing and validation', function () {
  const single = normalizeRouting(undefined, 1)
  assert.equal(single.enabled, false)
  const multi = normalizeRouting(undefined, 2)
  assert.equal(multi.enabled, true)
  assert.deepEqual(multi.policies, ROUTING_POLICIES.slice())
  assert.equal(multi.sticky, true)
  assert.equal(multi.failover, true)
  assert.equal(multi.providerName, 'opencode-auto')

  const custom = normalizeRouting({ enabled: true, policy: 'round-robin, directory,bogus', sticky: false, failover: false, providerName: 'mine', stickyTtlMs: 1234 }, 1)
  assert.equal(custom.enabled, true)
  assert.deepEqual(custom.policies, ['round-robin', 'directory'])
  assert.equal(custom.sticky, false)
  assert.equal(custom.failover, false)
  assert.equal(custom.providerName, 'mine')
  assert.equal(custom.stickyTtlMs, 1234)
})

test('directoryCovers: absolute workspace scoping with optional mapping', function () {
  const a = { id: 'a', directory: '/work/a' }
  assert.equal(directoryCovers(a, '/work/a'), true)
  assert.equal(directoryCovers(a, '/work/a/sub'), true)
  assert.equal(directoryCovers(a, '/work/ab'), false)
  assert.equal(directoryCovers({ id: 'x' }, '/work/a'), false)
  assert.equal(directoryCovers(a, '/host/work/a', function (_server, cwd) { return cwd.replace('/host', '') }), true)
})

test('directory policy narrows candidates to servers covering the cwd', async function () {
  const router = createRouter(servers(), { policies: ['directory'], sticky: false, statusCount: function () { return Promise.resolve(0) } })
  const ordered = await router.order({ cwd: '/work/b/project' })
  assert.deepEqual(ordered.map(function (server) { return server.id }), ['b'])
  const none = await router.order({ cwd: '/elsewhere' })
  assert.equal(none.length, 3)
})

test('sticky policy keeps one parent on the server that accepted its first child', async function () {
  const router = createRouter(servers(), { policies: ['sticky'], sticky: true, statusCount: function () { return Promise.resolve(0) } })
  const parent = { id: 'parent-1' }
  assert.equal((await router.order({ parent: parent }))[0].id, 'a')
  router.report(servers()[1], { parent: parent })
  assert.equal((await router.order({ parent: parent }))[0].id, 'b')
  // A different parent is unaffected.
  assert.equal((await router.order({ parent: { id: 'parent-2' } }))[0].id, 'a')
})

test('least-busy policy prefers the server with fewer running sessions and rotates ties', async function () {
  const counts = { a: 2, b: 0, c: 0 }
  const router = createRouter(servers(), {
    policies: ['least-busy', 'round-robin'],
    sticky: false,
    statusCount: function (server) { return Promise.resolve(counts[server.id]) },
  })
  assert.equal((await router.order({}))[0].id, 'b')
  // b and c tie at 0 running sessions: the tie rotates instead of pinning b.
  assert.equal((await router.order({}))[0].id, 'c')
  counts.a = 0
  const third = (await router.order({}))[0].id
  assert.ok(['a', 'b', 'c'].includes(third))
})

test('round-robin cycles through candidates', async function () {
  const router = createRouter(servers(), { policies: ['round-robin'], sticky: false, statusCount: function () { return Promise.resolve(0) } })
  const first = (await router.order({})).map(function (server) { return server.id })
  const second = (await router.order({})).map(function (server) { return server.id })
  const third = (await router.order({})).map(function (server) { return server.id })
  assert.deepEqual([first[0], second[0], third[0]], ['a', 'b', 'c'])
})

test('routed provider fails over to the next candidate when a start rejects', async function () {
  const attempts = []
  const fake = function (server) {
    return {
      start: function () {
        attempts.push(server.id)
        if (server.id === 'a') return Promise.reject(new Error('cannot reach ' + server.id))
        return Promise.resolve({ id: 'ses_' + server.id, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: function () { return Promise.resolve() } })
      },
    }
  }
  const routed = createRoutedProvider(servers(), {
    routing: { policies: ['round-robin'], sticky: false, failover: true, providerName: 'opencode-auto' },
    makeProvider: fake,
    statusCount: function () { return Promise.resolve(0) },
  })
  const run = await routed.start({ prompt: [{ type: 'text', text: 'x' }], parent: { id: 'p' }, signal: new AbortController().signal, label: 't' })
  assert.equal(run.id, 'ses_b')
  assert.deepEqual(attempts, ['a', 'b'])
  assert.deepEqual(routed.servers, ['a', 'b', 'c'])
})

test('routed provider surfaces the failure when failover is disabled', async function () {
  const fake = function (server) {
    return {
      start: function () {
        return Promise.reject(new Error('boom ' + server.id))
      },
    }
  }
  const routed = createRoutedProvider(servers(), {
    routing: { policies: ['round-robin'], sticky: false, failover: false },
    makeProvider: fake,
    statusCount: function () { return Promise.resolve(0) },
  })
  await assert.rejects(
    routed.start({ prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
    /boom a/,
  )
})