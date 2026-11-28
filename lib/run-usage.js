/**
 * Per-server token / cost counters, fed by `session.step.ended`.
 *
 * The ledger needs "how much did THIS run cost", but the only cheap source is a
 * running counter: `step.ended` carries `{ tokens, cost }` per step, while
 * asking the server for per-run usage would mean reading every message again.
 * So the SSE stream accumulates here and each ledger row keeps the delta
 * between its own start and settle.
 */

function zeroTokens() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A fresh, all-zero usage record. */
export function emptyUsage() {
  return { tokens: zeroTokens(), cost: 0, steps: 0 }
}

/** The server's live counters, created on first use. */
export function usageOf(server) {
  if (server.usage === undefined || server.usage === null || typeof server.usage !== 'object') server.usage = emptyUsage()
  const usage = server.usage
  if (usage.tokens === undefined || usage.tokens === null || typeof usage.tokens !== 'object') usage.tokens = zeroTokens()
  if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost)) usage.cost = 0
  if (typeof usage.steps !== 'number' || !Number.isFinite(usage.steps)) usage.steps = 0
  return usage
}

/** Add one `step.ended` payload to the server's counters. */
export function addStepUsage(server, data) {
  const usage = usageOf(server)
  const value = data !== null && typeof data === 'object' ? data : {}
  const tokens = value.tokens !== null && typeof value.tokens === 'object' ? value.tokens : {}
  const cache = tokens.cache !== null && typeof tokens.cache === 'object' ? tokens.cache : {}
  usage.steps += 1
  usage.tokens.input += count(tokens.input)
  usage.tokens.output += count(tokens.output)
  usage.tokens.reasoning += count(tokens.reasoning)
  usage.tokens.cacheRead += count(cache.read)
  usage.tokens.cacheWrite += count(cache.write)
  usage.cost += count(value.cost)
  return usage
}

/** A copy safe to keep as a run's baseline. */
export function snapshotUsage(server) {
  const usage = usageOf(server)
  return { tokens: Object.assign({}, usage.tokens), cost: usage.cost, steps: usage.steps }
}

/** Counters gained between two snapshots (never negative). */
export function diffUsage(before, after) {
  const from = before !== null && typeof before === 'object' ? before : emptyUsage()
  const to = after !== null && typeof after === 'object' ? after : emptyUsage()
  const fromTokens = from.tokens !== null && typeof from.tokens === 'object' ? from.tokens : {}
  const toTokens = to.tokens !== null && typeof to.tokens === 'object' ? to.tokens : {}
  const tokens = zeroTokens()
  for (const key of Object.keys(tokens)) tokens[key] = Math.max(0, count(toTokens[key]) - count(fromTokens[key]))
  return { tokens: tokens, cost: Math.max(0, count(to.cost) - count(from.cost)), steps: Math.max(0, count(to.steps) - count(from.steps)) }
}

/** Whether a delta describes a run that actually reported usage. */
export function hasUsage(usage) {
  if (usage === null || typeof usage !== 'object') return false
  if (count(usage.steps) > 0 || count(usage.cost) > 0) return true
  const tokens = usage.tokens !== null && typeof usage.tokens === 'object' ? usage.tokens : {}
  return Object.keys(tokens).some(function (key) { return count(tokens[key]) > 0 })
}
