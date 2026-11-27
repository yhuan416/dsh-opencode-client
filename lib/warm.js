/**
 * Startup cache warmer.
 *
 * The first board page load used to pay for one cold history scan per window:
 * `/insights` measured ~9 s cold (vs ~0.6 s warm) and the 30-day activity grid
 * ~2.2 s. Once the plugin has servers, warm the common windows during the first
 * idle window so the page opens against a warm cache. Best effort: every step is
 * silent on failure and the timer is unref'd so it can never keep node alive.
 */
import { collectServer } from './sessions.js'
import { collectInsights, collectActivity } from './insights.js'

const DEFAULT_DELAY_MS = 8000

/**
 * Schedule a one-shot warm-up. Returns a cancel function (used by tests and a
 * profile reload). Never throws.
 */
export function scheduleWarm(servers, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const list = Array.isArray(servers) ? servers.filter(function (server) { return server !== null && typeof server === 'object' }) : []
  if (list.length === 0) return function () {}
  const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : DEFAULT_DELAY_MS
  let cancelled = false
  const timer = setTimeout(function () {
    if (cancelled) return
    warm(list).catch(function () {})
  }, delayMs)
  if (timer !== null && typeof timer.unref === 'function') timer.unref()
  return function () {
    cancelled = true
    clearTimeout(timer)
  }
}

/** Warm board listing, 7-day insights and the 30-day activity grid, in order. */
export function warm(servers) {
  const list = Array.isArray(servers) ? servers : []
  let chain = Promise.resolve()
  for (const server of list) {
    chain = chain.then(function () { return collectServer(server) }).catch(function () {})
  }
  return chain
    .then(function () { return collectInsights(list, { days: 7 }) })
    .catch(function () {})
    .then(function () { return collectActivity(list, { days: 30 }) })
    .catch(function () {})
}