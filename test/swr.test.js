/**
 * Stale-while-revalidate cache used by the board read routes: a cold 7-day
 * insights scan is ~9 s, a warm one ~0.6 s, so after the first load the page must
 * keep painting the previous value while a single background refresh runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSwrCache } from '../lib/swr.js'

function clock(start) {
  let value = start === undefined ? 1000 : start
  return {
    now: function () { return value },
    advance: function (ms) { value += ms; return value },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise(function (done, fail) { resolve = done; reject = fail })
  return { promise: promise, resolve: resolve, reject: reject }
}

test('a miss waits for the loader, then serves fresh hits without calling it again', async function () {
  const c = clock()
  const swr = createSwrCache({ now: c.now })
  let calls = 0
  const first = await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v1') })
  assert.deepEqual(first, { value: 'v1', at: 1000, stale: false })
  const second = await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v2') })
  assert.equal(second.value, 'v1')
  assert.equal(calls, 1, 'fresh entry must not load again')
})

test('a stale entry answers immediately and refreshes once in the background', async function () {
  const c = clock()
  const swr = createSwrCache({ now: c.now })
  let calls = 0
  let release
  await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v1') })
  c.advance(150)
  const stale = await swr.serve('k', 100, function () {
    calls += 1
    return new Promise(function (resolve) { release = resolve })
  })
  assert.deepEqual(stale, { value: 'v1', at: 1000, stale: true }, 'stale value returned before the refresh finishes')
  assert.equal(calls, 2)
  // A second caller during the background refresh must not start a second scan.
  const concurrent = await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v3') })
  assert.equal(concurrent.value, 'v1')
  assert.equal(calls, 2, 'one background refresh per key')
  release('v2')
  await new Promise(function (resolve) { setTimeout(resolve, 0) })
  const after = await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v4') })
  assert.equal(after.value, 'v2')
  assert.equal(calls, 2)
})

test('concurrent cold callers share one loader', async function () {
  const swr = createSwrCache()
  const gate = deferred()
  let calls = 0
  const loader = function () { calls += 1; return gate.promise }
  const a = swr.serve('k', 100, loader)
  const b = swr.serve('k', 100, loader)
  gate.resolve('v')
  const [first, second] = await Promise.all([a, b])
  assert.equal(first.value, 'v')
  assert.equal(second.value, 'v')
  assert.equal(calls, 1)
})

test('a failed background refresh keeps the stale value and retries next time', async function () {
  const c = clock()
  const swr = createSwrCache({ now: c.now })
  await swr.serve('k', 100, function () { return Promise.resolve('v1') })
  c.advance(150)
  let calls = 0
  await swr.serve('k', 100, function () { calls += 1; return Promise.reject(new Error('boom')) })
  await new Promise(function (resolve) { setTimeout(resolve, 0) })
  const still = await swr.serve('k', 100, function () { calls += 1; return Promise.resolve('v2') })
  assert.equal(still.stale, true)
  assert.equal(still.value, 'v1')
  assert.equal(calls, 2, 'a rejected refresh does not poison the cache')
  // `invalidate` forces the next call to wait for a real load.
  swr.invalidate('k')
  const fresh = await swr.serve('k', 100, function () { return Promise.resolve('v3') })
  assert.deepEqual(fresh, { value: 'v3', at: c.now(), stale: false })
})