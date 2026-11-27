/**
 * Tiny in-memory stale-while-revalidate cache for the board's read endpoints.
 *
 * The board page must paint with whatever is known *now*: waiting for a 9 s
 * history scan on a cold cache is what made the first load feel broken. `serve`
 * therefore returns the previous value immediately once it is stale and
 * refreshes it in the background (one refresh per key), while the response
 * carries `{ value, at, stale }` so the client can say "更新于 …" instead of
 * blocking.
 *
 * No persistence: a dsh restart starts cold, and the startup warmer (lib/warm.js)
 * refills the common windows before the user opens the page.
 */

export function createSwrCache(options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const now = typeof opts.now === "function" ? opts.now : Date.now
  const entries = new Map()
  const inflight = new Map()

  function load(key, ttlMs, loader) {
    const pending = inflight.get(key)
    if (pending !== undefined) return pending
    const promise = Promise.resolve()
      .then(loader)
      .then(function (value) {
        entries.set(key, { value: value, at: now() })
        return value
      })
    inflight.set(key, promise)
    const done = function () { if (inflight.get(key) === promise) inflight.delete(key) }
    promise.then(done, done)
    return promise
  }

  /**
   * `serve(key, ttlMs, loader)` resolves to `{ value, at, stale }`:
   * - fresh entry → immediately, stale=false
   * - stale entry → immediately with the old value, stale=true, refresh in background
   * - no entry   → waits for the loader
   */
  function serve(key, ttlMs, loader) {
    const entry = entries.get(key)
    const at = now()
    if (entry !== undefined && at - entry.at < ttlMs) {
      return Promise.resolve({ value: entry.value, at: entry.at, stale: false })
    }
    if (entry !== undefined) {
      load(key, ttlMs, loader).catch(function () {})
      return Promise.resolve({ value: entry.value, at: entry.at, stale: true })
    }
    return load(key, ttlMs, loader).then(function (value) {
      const stored = entries.get(key)
      return { value: value, at: stored === undefined ? now() : stored.at, stale: false }
    })
  }

  function invalidate(key) {
    entries.delete(key)
    inflight.delete(key)
  }

  function clear() {
    entries.clear()
    inflight.clear()
  }

  return { serve: serve, invalidate: invalidate, clear: clear, size: function () { return entries.size } }
}

/** Process-wide cache used by the host routes; tests build their own instance. */
export const swr = createSwrCache()