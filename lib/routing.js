/**
 * Multi-server routing for the aggregated subagent provider (`opencode-auto`).
 *
 * dsh binds one tool row to one provider, and this plugin registers one
 * provider per server, so dispatching a subagent is pinned unless the provider
 * itself chooses. `opencode-auto` is that choosing provider: `start()` asks the
 * router for an ordered candidate list and falls back to the next server when
 * one is unreachable.
 *
 * Policies (in decision order; the first hit wins):
 *   directory   — the server whose `directory` covers the requested cwd
 *   sticky      — the server previously used by the same parent agent
 *   least-busy  — fewest running sessions (per-server `/session/active`)
 *   round-robin — rotate through the remaining candidates
 */
import { collectStatus } from './sessions.js'

export const ROUTING_POLICIES = ['directory', 'sticky', 'least-busy', 'round-robin']

export const ROUTING_DEFAULTS = {
  providerName: 'opencode-auto',
  policies: ['directory', 'sticky', 'least-busy', 'round-robin'],
  sticky: true,
  failover: true,
  stickyTtlMs: 30 * 60 * 1000,
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Normalize the `routing` config block; defaults to on when more than one server exists. */
export function normalizeRouting(raw, serverCount) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const requested = Array.isArray(input.policy)
    ? input.policy
    : (typeof input.policy === 'string' ? input.policy.split(',') : ROUTING_DEFAULTS.policies)
  const policies = requested.map(function (policy) { return String(policy).trim() }).filter(function (policy) { return ROUTING_POLICIES.includes(policy) })
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : serverCount > 1,
    providerName: typeof input.providerName === 'string' && input.providerName !== '' ? input.providerName : ROUTING_DEFAULTS.providerName,
    policies: policies.length > 0 ? policies : ROUTING_DEFAULTS.policies.slice(),
    sticky: input.sticky !== false,
    failover: input.failover !== false,
    stickyTtlMs: positiveNumber(input.stickyTtlMs, ROUTING_DEFAULTS.stickyTtlMs),
  }
}

/** Does one server's configured workspace cover the absolute cwd? */
export function directoryCovers(server, cwd, mapCwd) {
  if (server === null || typeof server !== 'object' || typeof cwd !== 'string' || cwd === '') return false
  const mapped = typeof mapCwd === 'function' ? mapCwd(server, cwd) : cwd
  if (typeof mapped !== 'string' || mapped === '') return false
  if (typeof server.directory !== 'string' || server.directory === '') return false
  const root = server.directory.replace(/\/+$/, '') === '' ? '/' : server.directory.replace(/\/+$/, '')
  if (root === '/') return true
  return mapped === root || mapped.startsWith(root + '/')
}

function parentKey(parent) {
  if (parent === null || typeof parent !== 'object') return undefined
  if (typeof parent.id === 'string' && parent.id !== '') return parent.id
  return undefined
}

/**
 * Build a router over a fixed server list. `statusCount` is injectable for
 * tests (default: count each server's `/session/active` entries).
 */
export function createRouter(servers, options) {
  const opts = Object.assign({}, ROUTING_DEFAULTS, options === undefined || options === null ? {} : options)
  const statusCount = typeof opts.statusCount === 'function' ? opts.statusCount : function (server) {
    return collectStatus(server).then(function (statuses) {
      return statuses !== null && typeof statuses === 'object' ? Object.keys(statuses).length : 0
    })
  }
  const sticky = new Map()
  let rotation = 0

  function withFirst(list, index) {
    if (index <= 0) return list
    return [list[index]].concat(list.slice(0, index), list.slice(index + 1))
  }

  /** Ordered candidates for one start; never empty when `servers` is non-empty. */
  async function order(request) {
    let candidates = servers.slice()
    if (candidates.length <= 1) return candidates
    const cwd = request !== null && typeof request === 'object' && typeof request.cwd === 'string' ? request.cwd : undefined

    if (opts.policies.includes('directory') && cwd !== undefined) {
      const covered = candidates.filter(function (server) { return directoryCovers(server, cwd, opts.mapCwd) })
      if (covered.length > 0) candidates = covered
    }

    if (candidates.length <= 1) return candidates

    if (opts.sticky && request !== null && typeof request === 'object') {
      const key = parentKey(request.parent)
      if (key !== undefined) {
        const entry = sticky.get(key)
        if (entry !== undefined && entry.until > Date.now()) {
          const index = candidates.findIndex(function (server) { return server.id === entry.serverId })
          if (index >= 0) return withFirst(candidates, index)
        }
      }
    }

    if (opts.policies.includes('least-busy')) {
      const counts = await Promise.all(candidates.map(function (server) {
        return statusCount(server).catch(function () { return Number.POSITIVE_INFINITY })
      }))
      const sorted = candidates.map(function (server, index) {
        return { server: server, count: counts[index] }
      }).sort(function (a, b) { return a.count - b.count })
      // Rotate each equal-count group so an idle fleet is not always sent to server[0].
      const groups = []
      for (const entry of sorted) {
        const last = groups[groups.length - 1]
        if (last !== undefined && last.count === entry.count) last.items.push(entry)
        else groups.push({ count: entry.count, items: [entry] })
      }
      const ordered = []
      for (const group of groups) {
        const offset = group.items.length > 1 ? rotation % group.items.length : 0
        ordered.push.apply(ordered, group.items.slice(offset).concat(group.items.slice(0, offset)))
      }
      rotation += 1
      return ordered.map(function (entry) { return entry.server })
    }

    if (opts.policies.includes('round-robin')) {
      const start = rotation % candidates.length
      rotation += 1
      return candidates.slice(start).concat(candidates.slice(0, start))
    }

    return candidates
  }

  /** Remember the server that accepted a run for this parent (sticky policy). */
  function report(server, request) {
    if (!opts.sticky || request === null || typeof request !== 'object') return
    const key = parentKey(request.parent)
    if (key === undefined) return
    sticky.set(key, { serverId: server.id, until: Date.now() + opts.stickyTtlMs })
  }

  return { order: order, report: report }
}