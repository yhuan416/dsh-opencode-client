/**
 * Fleet insights for the board's top area.
 *
 * Everything here is **window-scoped**: the numbers must come from
 * `/experimental/session/stats`, never from a session's lifetime `cost`/`tokens`
 * (that mistake was already made once in cost attribution). The only exception
 * is the session table, which is used for *counts* (projects, quoted sessions),
 * not for money.
 *
 * OpenCode offers far less than the dsh "context insight" plugin: no daily
 * token/cost series (only daily steps), no token composition and no duration
 * breakdown. Those panels are intentionally absent rather than faked; the board
 * footnote says so.
 *
 * See docs/plans/2026-11-27-opencode-insights-design.md.
 */
import { collectStats, collectServer, collectArchivedCount } from './sessions.js'

/** The stats endpoint scans history; 30 days is the practical ceiling. */
export const INSIGHTS_MAX_DAYS = 30
const DAY_MS = 86400000
const MIN_WINDOW_MS = 3600000

function startOfDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function dayKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

function addTokens(into, tokens) {
  const source = tokens !== null && typeof tokens === 'object' ? tokens : {}
  into.input += typeof source.input === 'number' ? source.input : 0
  into.output += typeof source.output === 'number' ? source.output : 0
  into.reasoning += typeof source.reasoning === 'number' ? source.reasoning : 0
  into.cacheRead += typeof source.cacheRead === 'number' ? source.cacheRead : 0
  into.cacheWrite += typeof source.cacheWrite === 'number' ? source.cacheWrite : 0
  return into
}

/** `cache.read / (input + cache.read)`, or null when nothing was billed. */
export function computeCacheHitRate(tokens) {
  const source = tokens !== null && typeof tokens === 'object' ? tokens : {}
  const input = typeof source.input === 'number' ? source.input : 0
  const read = typeof source.cacheRead === 'number' ? source.cacheRead : 0
  if (input + read <= 0) return null
  return read / (input + read)
}

/**
 * Fill the daily steps series from `from` to today. The endpoint omits inactive
 * days, so a chart drawn straight from `activity[]` would silently compress the
 * timeline; missing days become 0 instead.
 */
export function fillActivity(activity, from, now) {
  const seen = new Map()
  for (const entry of Array.isArray(activity) ? activity : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.date !== 'string' || typeof entry.steps !== 'number') continue
    seen.set(entry.date, (seen.get(entry.date) || 0) + entry.steps)
  }
  const out = []
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  for (let offset = 0; offset <= 62; offset += 1) {
    const day = new Date(start.getTime() + offset * DAY_MS)
    if (day.getTime() > now) break
    const key = dayKey(day)
    out.push({ date: key, steps: seen.get(key) || 0 })
  }
  return out
}

/**
 * Window-scoped session facts available from the session table: how many active
 * sessions per project and how many of them carry a priced cost (the "quoted"
 * ratio). Lifetime tokens/cost are deliberately not read here.
 */
export function sessionFacts(snapshot, from) {
  const groups = snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.projects) ? snapshot.projects : []
  const projects = []
  let quotedSessions = 0
  for (const group of groups) {
    const sessions = group !== null && typeof group === 'object' && Array.isArray(group.sessions) ? group.sessions : []
    let active = 0
    for (const session of sessions) {
      if (session === null || typeof session !== 'object') continue
      if (typeof session.busyAt !== 'number' || session.busyAt < from) continue
      active += 1
      if (typeof session.cost === 'number' && session.cost > 0) quotedSessions += 1
    }
    if (active === 0) continue
    const worktree = typeof group.worktree === 'string' && group.worktree !== '' ? group.worktree : undefined
    projects.push({ directory: worktree === undefined || worktree === '/' ? '(unattributed)' : worktree, sessions: active })
  }
  projects.sort(function (a, b) { return b.sessions - a.sessions })
  return { projects: projects.slice(0, 10), quotedSessions: quotedSessions }
}

function collectInsightRow(server, from, now) {
  return Promise.all([
    collectStats(server, { from: from, to: now, tools: 'detail' }),
    collectServer(server).then(function (value) { return value }, function () { return undefined }),
    collectArchivedCount(server),
  ]).then(function (results) {
    const stats = results[0]
    const snapshot = results[1]
    const archived = results[2]
    const base = { id: server.id, label: server.label }
    if (stats === undefined || stats.supported !== true) {
      return Object.assign(base, {
        supported: false,
        error: stats !== undefined && stats.error !== undefined ? stats.error : 'v1 server or stats unavailable',
      })
    }
    const facts = sessionFacts(snapshot, from)
    return Object.assign(base, {
      supported: true,
      sessions: stats.sessions,
      subagents: stats.subagents,
      prompts: stats.prompts,
      steps: stats.steps,
      tokens: stats.tokens,
      cost: stats.cost,
      cacheHitRate: computeCacheHitRate(stats.tokens),
      activeDays: stats.activeDays,
      streak: stats.streak,
      archived: archived.supported === true ? archived.count : null,
      archivedTruncated: archived.truncated === true,
      quotedSessions: facts.quotedSessions,
      truncated: snapshot !== undefined && snapshot !== null && snapshot.truncated === true,
      activity: fillActivity(stats.activity, from, now),
      tools: stats.tools,
      models: stats.models,
      projects: facts.projects.map(function (project) { return Object.assign({ server: server.id }, project) }),
    })
  })
}

function mergeTools(rows) {
  const totals = { calls: 0, succeeded: 0, failed: 0 }
  let unfinished = 0
  const byName = new Map()
  for (const row of rows) {
    const tools = row.tools !== null && typeof row.tools === 'object' ? row.tools : {}
    totals.calls += typeof tools.calls === 'number' ? tools.calls : 0
    totals.succeeded += typeof tools.succeeded === 'number' ? tools.succeeded : 0
    totals.failed += typeof tools.failed === 'number' ? tools.failed : 0
    if (typeof tools.unfinished === 'number') unfinished += tools.unfinished
    for (const usage of Array.isArray(tools.usage) ? tools.usage : []) {
      const entry = byName.get(usage.name) ?? { name: usage.name, calls: 0, succeeded: 0, failed: 0, unfinished: 0, p50: [], p50same: true }
      entry.calls += usage.calls
      entry.succeeded += usage.succeeded
      entry.failed += usage.failed
      entry.unfinished += usage.unfinished
      if (typeof usage.durationP50 === 'number') entry.p50.push(usage.durationP50)
      byName.set(usage.name, entry)
    }
  }
  if (unfinished > 0) totals.unfinished = unfinished
  const usage = Array.from(byName.values()).map(function (entry) {
    // P50 is not aggregatable across servers: use it when every server agrees,
    // otherwise expose the observed range instead of inventing one number.
    const distinct = Array.from(new Set(entry.p50)).sort(function (a, b) { return a - b })
    const row = { name: entry.name, calls: entry.calls, succeeded: entry.succeeded, failed: entry.failed, unfinished: entry.unfinished }
    if (distinct.length === 1) row.durationP50 = distinct[0]
    else if (distinct.length > 1) row.durationP50Range = [distinct[0], distinct[distinct.length - 1]]
    return row
  }).sort(function (a, b) { return b.calls - a.calls })
  const merged = totals
  if (usage.length > 0) merged.usage = usage
  return merged
}

function mergeModels(rows) {
  const byModel = new Map()
  for (const row of rows) {
    for (const model of Array.isArray(row.models) ? row.models : []) {
      const entry = byModel.get(model.model) ?? { model: model.model, steps: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
      entry.steps += model.steps
      addTokens(entry.tokens, model.tokens)
      entry.cost += model.cost
      byModel.set(model.model, entry)
    }
  }
  return Array.from(byModel.values()).sort(function (a, b) {
    const total = function (entry) { return entry.tokens.input + entry.tokens.output + entry.tokens.reasoning + entry.tokens.cacheRead }
    return total(b) - total(a)
  }).slice(0, 10)
}

function totalOf(rows, from, now) {
  const supported = rows.filter(function (row) { return row.supported === true })
  const total = {
    sessions: 0,
    subagents: 0,
    prompts: 0,
    steps: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    cacheHitRate: null,
    activeDays: 0,
    streak: 0,
    archived: 0,
    archivedTruncated: false,
    quotedSessions: 0,
    truncated: false,
    activity: [],
    tools: { calls: 0, succeeded: 0, failed: 0 },
    models: [],
    projects: [],
  }
  let archivedKnown = false
  for (const row of supported) {
    total.sessions += row.sessions
    total.subagents += row.subagents
    total.prompts += row.prompts
    total.steps += row.steps
    addTokens(total.tokens, row.tokens)
    total.cost += row.cost
    total.quotedSessions += row.quotedSessions
    total.truncated = total.truncated || row.truncated === true
    total.archivedTruncated = total.archivedTruncated || row.archivedTruncated === true
    if (typeof row.archived === 'number') { total.archived += row.archived; archivedKnown = true }
    if (typeof row.streak === 'number') total.streak = Math.max(total.streak, row.streak)
  }
  total.cacheHitRate = computeCacheHitRate(total.tokens)
  total.tools = mergeTools(supported)
  total.models = mergeModels(supported)
  const activity = new Map()
  for (const row of supported) {
    for (const day of row.activity) activity.set(day.date, (activity.get(day.date) || 0) + day.steps)
  }
  total.activity = fillActivity(Array.from(activity.entries()).map(function (entry) { return { date: entry[0], steps: entry[1] } }), from, now)
  total.activeDays = total.activity.filter(function (day) { return day.steps > 0 }).length
  const projects = []
  for (const row of supported) for (const project of row.projects) projects.push(project)
  projects.sort(function (a, b) { return b.sessions - a.sessions })
  total.projects = projects.slice(0, 20)
  if (!archivedKnown) total.archived = null
  if (total.tokens.input === 0 && total.tokens.cacheRead === 0) total.cacheHitRate = null
  return total
}

/**
 * Aggregate insights for the configured servers.
 *
 * `from` defaults to 7 days and is clamped to [now - 30 days, now - 1 hour]; the
 * stats endpoint scans server-side history, so an unbounded window would time out.
 */
export function collectInsights(servers, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  // Default window is 7 *calendar* days (including today), so the daily chart
  // shows exactly 7 bars instead of 8 partial ones.
  const requested = typeof opts.from === 'number' && opts.from > 0 ? Math.floor(opts.from) : startOfDay(now - 6 * DAY_MS)
  const earliest = now - INSIGHTS_MAX_DAYS * DAY_MS
  const from = Math.min(Math.max(requested, earliest), now - MIN_WINDOW_MS)
  const wanted = typeof opts.serverId === 'string' && opts.serverId !== '' ? opts.serverId : undefined
  const picked = wanted === undefined ? servers : servers.filter(function (server) { return server.id === wanted })
  return Promise.all(picked.map(function (server) { return collectInsightRow(server, from, now) })).then(function (rows) {
    return { from: from, to: now, total: totalOf(rows, from, now), servers: rows }
  })
}