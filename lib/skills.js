/**
 * Per-skill usage for the insights page.
 *
 * OpenCode's stats endpoint only reports the aggregate `skill` tool count — the
 * skill *name* lives in the tool call's `state.input.id`, i.e. in the messages.
 * There is no aggregate endpoint for that, so this module walks the messages of
 * sessions that ran inside the window (newest first, stop at the window edge).
 *
 * The walk is the expensive part: measured on OpenCode 2.3.0, a 7-day window was
 * 191 pages / 7.0 s on e5 and 157 pages / 2.6 s on n100 (serial). It is therefore
 * a separate, lazily-fetched endpoint with a 10-minute cache, a session/page
 * budget and a `partial` flag — never part of the fast `/insights` response.
 */
import { ocCall } from './oc-client.js'
import { collectServer } from './sessions.js'

export const SKILLS_TTL_MS = 600000
const DAY_MS = 86400000
const MAX_SESSIONS = 250
const MAX_PAGES = 60
const MAX_REQUESTS = 1200
const CONCURRENCY = 6
const PAGE_SIZE = 100

function startOfDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** Run `run` over `items` with at most `limit` in flight, collecting outcomes. */
function mapWithLimit(items, limit, run) {
  const results = new Array(items.length)
  let index = 0
  function worker() {
    if (index >= items.length) return Promise.resolve()
    const position = index
    index += 1
    return Promise.resolve().then(function () { return run(items[position]) }).then(
      function (value) { results[position] = { ok: true, value: value } },
      function (error) { results[position] = { ok: false, error: error } },
    ).then(worker)
  }
  const workers = []
  for (let start = 0; start < Math.min(limit, items.length); start += 1) workers.push(worker())
  return Promise.all(workers).then(function () { return results })
}

/**
 * Walk one session's messages and count `skill` tool calls by `input.id`.
 * Pages descend and stop at the first message older than `from`; the per-session
 * page cap returns `truncated` instead of silently dropping the rest.
 */
function scanSessionSkills(server, sessionId, from, budget) {
  const base = '/session/' + encodeURIComponent(sessionId) + '/message'
  const skills = new Map()
  let pages = 0
  let cursor
  let truncated = false
  function page() {
    if (budget.left <= 0) {
      truncated = true
      return Promise.resolve({ skills: skills, pages: pages, truncated: true })
    }
    budget.left -= 1
    const input = { sessionID: sessionId, limit: PAGE_SIZE }
    if (typeof cursor === 'string' && cursor !== '') input.cursor = cursor
    else input.order = 'desc'
    return ocCall(server, function (client, requestOptions) {
      return client.message.list(input, requestOptions)
    }, 20000).then(function (value) {
      const data = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : []
      let older = false
      for (const message of data) {
        const at = message !== null && typeof message === 'object' && message.time !== null && typeof message.time === 'object' ? message.time.created : undefined
        if (typeof at === 'number' && at < from) { older = true; break }
        if (message === null || typeof message !== 'object' || message.type !== 'assistant' || !Array.isArray(message.content)) continue
        for (const part of message.content) {
          if (part === null || typeof part !== 'object' || part.type !== 'tool' || part.name !== 'skill') continue
          const input = part.state !== null && typeof part.state === 'object' && part.state.input !== null && typeof part.state.input === 'object' ? part.state.input : {}
          // OpenCode 2.3.0 uses `id`; older sessions used `name` (and a few used
          // `skill`), so accept all three instead of dropping those calls.
          const id = typeof input.id === 'string' && input.id !== ''
            ? input.id
            : (typeof input.name === 'string' && input.name !== '' ? input.name : (typeof input.skill === 'string' && input.skill !== '' ? input.skill : 'unknown'))
          skills.set(id, (skills.get(id) || 0) + 1)
        }
      }
      pages += 1
      const next = value.cursor !== null && typeof value.cursor === 'object' && typeof value.cursor.next === 'string' && value.cursor.next !== '' ? value.cursor.next : undefined
      if (older || next === undefined || data.length === 0) return { skills: skills, pages: pages, truncated: false }
      if (pages >= MAX_PAGES) return { skills: skills, pages: pages, truncated: true }
      cursor = next
      return page()
    })
  }
  return page()
}

function collectServerSkills(server, from, now) {
  const bucket = Math.floor(from / DAY_MS)
  server.skillsCache = server.skillsCache instanceof Map ? server.skillsCache : new Map()
  const cached = server.skillsCache.get(bucket)
  if (cached !== undefined && Date.now() - cached.at < SKILLS_TTL_MS) return Promise.resolve(cached.value)
  return collectServer(server).then(function (value) {
      const groups = value !== null && typeof value === 'object' && Array.isArray(value.projects) ? value.projects : []
      // `updatedAt`, not `busyAt`: a session whose run started before the window
      // but whose messages were written inside it must still be scanned (its
      // stats-recorded skill calls do count in the window).
      const active = []
      for (const group of groups) {
        const sessions = group !== null && typeof group === 'object' && Array.isArray(group.sessions) ? group.sessions : []
        for (const session of sessions) {
          if (session === null || typeof session !== 'object') continue
          const at = typeof session.updatedAt === 'number' ? session.updatedAt : (typeof session.busyAt === 'number' ? session.busyAt : 0)
          if (at >= from) active.push({ session: session, at: at })
        }
      }
      active.sort(function (a, b) { return b.at - a.at })
      const todo = active.slice(0, MAX_SESSIONS)
      const skipped = active.length - todo.length
      const budget = { left: MAX_REQUESTS }
      return mapWithLimit(todo, CONCURRENCY, function (entry) {
        return scanSessionSkills(server, entry.session.id, from, budget)
      }).then(function (results) {
        const skills = new Map()
        let pages = 0
        let failed = 0
        let truncated = skipped > 0 || budget.left <= 0
        for (const result of results) {
          if (result.ok !== true) { failed += 1; continue }
          pages += result.value.pages
          if (result.value.truncated === true) truncated = true
          for (const entry of result.value.skills.entries()) skills.set(entry[0], (skills.get(entry[0]) || 0) + entry[1])
        }
        const list = Array.from(skills.entries()).map(function (entry) { return { name: entry[0], calls: entry[1] } })
          .sort(function (a, b) { return b.calls - a.calls })
        const calls = list.reduce(function (sum, entry) { return sum + entry.calls }, 0)
        const report = {
          id: server.id,
          label: server.label,
          supported: true,
          skills: list,
          calls: calls,
          sessions: todo.length,
          skipped: skipped,
          pages: pages,
          failed: failed,
          truncated: truncated,
        }
      server.skillsCache.set(bucket, { at: Date.now(), value: report })
      return report
    })
  }).catch(function (error) {
    const failed = { id: server.id, label: server.label, supported: false, error: errorText(error) }
    server.skillsCache.set(bucket, { at: Date.now(), value: failed })
    return failed
  })
}

/**
 * Per-skill counts for the given servers and window (default 7 calendar days).
 * Resolves `{ from, to, total, servers }`; never rejects for a single server.
 */
export function collectSkillUsage(servers, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now()
  const days = typeof opts.days === 'number' && Number.isFinite(opts.days)
    ? Math.min(Math.max(Math.floor(opts.days), 1), 30)
    : 7
  const from = startOfDay(now - (days - 1) * DAY_MS)
  const wanted = typeof opts.serverId === 'string' && opts.serverId !== '' ? opts.serverId : undefined
  const picked = wanted === undefined ? servers : servers.filter(function (server) { return server.id === wanted })
  return Promise.all(picked.map(function (server) { return collectServerSkills(server, from, now) })).then(function (rows) {
    const merged = new Map()
    let calls = 0
    let sessions = 0
    let pages = 0
    let failed = 0
    let truncated = false
    for (const row of rows) {
      if (row.supported !== true) continue
      calls += row.calls
      sessions += row.sessions
      pages += row.pages
      failed += row.failed
      if (row.truncated === true) truncated = true
      for (const entry of row.skills) merged.set(entry.name, (merged.get(entry.name) || 0) + entry.calls)
    }
    const skills = Array.from(merged.entries()).map(function (entry) { return { name: entry[0], calls: entry[1] } })
      .sort(function (a, b) { return b.calls - a.calls })
    return {
      from: from,
      to: now,
      days: days,
      total: { skills: skills, calls: calls, sessions: sessions, pages: pages, failed: failed, truncated: truncated },
      servers: rows,
    }
  })
}