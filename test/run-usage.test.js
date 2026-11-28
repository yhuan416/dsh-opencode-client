import test from 'node:test'
import assert from 'node:assert/strict'

import { addStepUsage, diffUsage, emptyUsage, hasUsage, snapshotUsage, usageOf } from '../lib/run-usage.js'

test('step.ended payloads accumulate tokens, cost and steps on the server', function () {
  const server = {}
  addStepUsage(server, { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 40, write: 2 } }, cost: 0.25 })
  addStepUsage(server, { tokens: { input: 50 }, cost: 0.5 })
  const usage = usageOf(server)
  assert.equal(usage.steps, 2)
  assert.equal(usage.tokens.input, 150)
  assert.equal(usage.tokens.output, 10)
  assert.equal(usage.tokens.reasoning, 5)
  assert.equal(usage.tokens.cacheRead, 40)
  assert.equal(usage.tokens.cacheWrite, 2)
  assert.equal(usage.cost, 0.75)
})

test('a malformed step payload counts the step but adds nothing else', function () {
  const server = {}
  addStepUsage(server, undefined)
  addStepUsage(server, { tokens: null, cost: 'free' })
  const usage = usageOf(server)
  assert.equal(usage.steps, 2)
  assert.equal(usage.cost, 0)
  assert.equal(usage.tokens.input, 0)
})

test('diffUsage reports only what a run added and never goes negative', function () {
  const server = {}
  addStepUsage(server, { tokens: { input: 100 }, cost: 1 })
  const before = snapshotUsage(server)
  addStepUsage(server, { tokens: { input: 30 }, cost: 0.5 })
  const after = snapshotUsage(server)
  const delta = diffUsage(before, after)
  assert.equal(delta.tokens.input, 30)
  assert.equal(delta.cost, 0.5)
  assert.equal(delta.steps, 1)
  assert.deepEqual(diffUsage(after, before), { tokens: emptyUsage().tokens, cost: 0, steps: 0 })
})

test('hasUsage distinguishes "no steps reported" from "a zero-cost priced run"', function () {
  assert.equal(hasUsage(null), false)
  assert.equal(hasUsage(emptyUsage()), false)
  assert.equal(hasUsage({ tokens: { input: 1 }, cost: 0, steps: 1 }), true)
  assert.equal(hasUsage({ tokens: { input: 0 }, cost: 0, steps: 0 }), false)
})

test('snapshotUsage is a copy: later steps do not mutate the baseline', function () {
  const server = {}
  addStepUsage(server, { tokens: { input: 7 } })
  const baseline = snapshotUsage(server)
  addStepUsage(server, { tokens: { input: 7 } })
  assert.equal(baseline.tokens.input, 7)
})
