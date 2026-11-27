/**
 * Read-only OpenCode 2 session discovery, messages, metadata and status.
 *
 * `/api/*`, `{data}`/`{location,data}` envelopes, `location.directory`,
 * `content[]` messages, `/session/active`, `/session/interrupt`. Callers see
 * one normalized shape.
 */
import { opencodeValue, ensureApiVersion, unwrap, unwrapList } from './http.js'
import { ocCall } from './oc-client.js'
import { modelLabel } from './config.js'
import { describePending, describePermission } from './pending-text.js'

/** One page of `session.list`; also the truncation threshold for pruning. */
const SESSION_PAGE_LIMIT = 500
const SNAPSHOT_TTL_MS = 10000

/**
 * Normalize an OpenCode token counter (`{input,output,reasoning,cache:{read,write}}`)
 * into the flat shape the UI and tools use, dropping zero counters.
 * v2 uses this shape both on sessions and on `step.ended` events.
 */
export function normalizeTokens(value) {
  const tokens = value !== null && typeof value === 'object' ? value : undefined
  if (tokens === undefined) return undefined
  const cache = tokens.cache !== null && typeof tokens.cache === 'object' ? tokens.cache : {}
  const counters = { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: cache.read, cacheWrite: cache.write }
  const normalized = {}
  for (const key of Object.keys(counters)) {
    const count = counters[key]
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) normalized[key] = count
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function summarizeSession(session) {
  const time = session !== null && typeof session === 'object' && session.time !== null && typeof session.time === 'object' ? session.time : undefined
  const location = session !== null && typeof session === 'object' && session.location !== null && typeof session.location === 'object' ? session.location : undefined
  const directory = session.directory !== undefined
    ? session.directory
    : (location !== undefined && typeof location.directory === 'string' ? location.directory : undefined)
  const summary = {
    id: session.id,
    title: typeof session.title === 'string' && session.title !== '' ? session.title : (typeof session.slug === 'string' ? session.slug : session.id),
    directory: typeof directory === 'string' ? directory : null,
    updatedAt: time !== undefined && typeof time.updated === 'number' ? time.updated : null,
  }
  const tokens = normalizeTokens(session.tokens)
  if (tokens !== undefined) summary.tokens = tokens
  const model = modelLabel(session.model)
  if (model !== undefined) summary.model = model
  if (typeof session.agent === 'string' && session.agent !== '') summary.agent = session.agent
  if (typeof session.outcome === 'string' && session.outcome !== '') summary.outcome = session.outcome
  if (typeof session.cost === 'number' && Number.isFinite(session.cost)) summary.cost = session.cost
  if (time !== undefined && typeof time.created === 'number') summary.createdAt = time.created
  // Run boundaries and the read marker live on the session itself: `busy`→`idle`
  // is the last run's duration, and `viewed` is how OpenCode's own UI decides to
  // draw the unread dot (`idle > viewed`), so the board reads the same facts
  // instead of tracking its own start/finish state.
  if (time !== undefined && typeof time.busy === 'number') summary.busyAt = time.busy
  if (time !== undefined && typeof time.idle === 'number') summary.idleAt = time.idle
  if (time !== undefined && typeof time.viewed === 'number') summary.viewedAt = time.viewed
  if (typeof session.parentID === 'string' && session.parentID !== '') summary.parentID = session.parentID
  return summary
}

/**
 * Health + projects + sessions of one server, grouped by directory.
 *
 * Per-server single-flight: concurrent callers (board page, toast watcher,
 * agent tool) share one listing request, so a slow older response can never
 * resolve after a newer one and prune live sessions. `options.onListing` is
 * called with `{ ids, requestedAt, truncated, pageFloorUpdatedAt }` only for an
 * authoritative (fresh, complete, not raced) listing; the board uses it to drop
 * rows the server no longer has. A listing that a create/delete invalidated
 * mid-flight is served once with a non-enumerable `raced` flag and not cached.
 */
export function collectServer(server, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const onListing = typeof opts.onListing === 'function' ? opts.onListing : undefined

  if (server.collecting !== undefined) {
    if (onListing !== undefined) server.collecting.listeners.push(onListing)
    return server.collecting.promise
  }
  if (server.snapshot !== undefined && Date.now() - server.snapshot.at < SNAPSHOT_TTL_MS) {
    return Promise.resolve(server.snapshot.value)
  }

  const requestedAt = Date.now()
  const epoch = typeof server.snapshotEpoch === 'number' ? server.snapshotEpoch : 0
  const listeners = onListing === undefined ? [] : [onListing]
  const built = ocCall(server, function (client, requestOptions) {
    return Promise.all([
      client.server.info(requestOptions),
      client.project.list(undefined, requestOptions),
      // Truncated-page pruning assumes newest-first; pin the order instead of
      // trusting the server default.
      client.session.list({ limit: SESSION_PAGE_LIMIT, order: 'desc' }, requestOptions),
    ])
  }, 15000).then(function (results) {
    const health = results[0] !== undefined && results[0] !== null && typeof results[0] === 'object' ? results[0] : undefined
    const projects = Array.isArray(results[1]) ? results[1] : unwrapList(results[1])
    const sessionList = results[2]
    const sessions = Array.isArray(sessionList) ? sessionList : unwrapList(sessionList)
    const projectById = new Map(projects.map(function (project) { return [project.id, project] }))
    const groups = new Map()
    function worktreeOf(project) {
      const worktree = project !== undefined && typeof project.canonical === 'string' ? project.canonical : (project !== undefined ? project.worktree : undefined)
      return typeof worktree === 'string' && worktree !== '' && worktree !== '/' ? worktree : undefined
    }
    for (const project of projects) {
      const worktree = worktreeOf(project)
      if (worktree !== undefined) groups.set(project.id, { id: project.id, worktree: worktree, sessions: [] })
    }
    for (const session of sessions) {
      const summary = summarizeSession(session)
      const projectId = typeof session.projectID === 'string' ? session.projectID : ''
      const project = projectById.get(projectId)
      const worktree = worktreeOf(project)
      let group
      if (worktree !== undefined) {
        group = groups.get(project.id)
      } else {
        const directory = summary.directory === null ? '(unknown directory)' : summary.directory
        const key = 'dir:' + directory
        group = groups.get(key)
        if (group === undefined) {
          group = { id: key, worktree: directory, sessions: [] }
          groups.set(key, group)
        }
      }
      if (group !== undefined) group.sessions.push(summary)
    }
    const ordered = Array.from(groups.values())
    ordered.forEach(function (group) { group.sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) }) })
    ordered.sort(function (a, b) { return (b.sessions[0] === undefined ? 0 : b.sessions[0].updatedAt || 0) - (a.sessions[0] === undefined ? 0 : a.sessions[0].updatedAt || 0) })
    const cursor = sessionList !== null && typeof sessionList === 'object' && sessionList.cursor !== null && typeof sessionList.cursor === 'object' ? sessionList.cursor : undefined
    const value = {
      state: health !== undefined ? 'online' : 'offline',
      version: health !== undefined && typeof health.version === 'string' ? health.version : null,
      projects: ordered,
      truncated: cursor !== undefined && cursor.next !== null && cursor.next !== undefined && sessions.length >= SESSION_PAGE_LIMIT,
    }
    const raced = (typeof server.snapshotEpoch === 'number' ? server.snapshotEpoch : 0) !== epoch
    const validListing = Array.isArray(sessionList) || (sessionList !== null && typeof sessionList === 'object' && Array.isArray(sessionList.data))
    let listing
    if (validListing && raced !== true) {
      const updatedTimes = []
      const ids = []
      for (const session of sessions) {
        if (typeof session.id === 'string' && session.id !== '') ids.push(session.id)
        const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : (session.time !== null && typeof session.time === 'object' && typeof session.time.updated === 'number' ? session.time.updated : undefined)
        if (typeof updatedAt === 'number') updatedTimes.push(updatedAt)
      }
      listing = {
        ids: ids,
        requestedAt: requestedAt,
        truncated: value.truncated === true,
        // Truncated pages are ordered newest-first; the oldest row on the page
        // is the floor above which a missing row proves deletion.
        pageFloorUpdatedAt: updatedTimes.length > 0 ? Math.min.apply(null, updatedTimes) : undefined,
      }
    }
    if (raced === true) Object.defineProperty(value, 'raced', { value: true })
    else server.snapshot = { at: Date.now(), value: value }
    return { value: value, listing: listing }
  })
  const promise = built.then(function (result) {
    // Release the single-flight slot before announcing the listing, so a caller
    // arriving now starts its own fetch instead of silently missing the event.
    server.collecting = undefined
    if (result.listing !== undefined) {
      for (const listener of listeners) {
        try { listener(result.listing) } catch (error) {}
      }
    }
    return result.value
  }, function (error) {
    server.collecting = undefined
    throw error
  })
  server.collecting = { promise: promise, listeners: listeners }
  return promise
}

/**
 * One line per session across servers. Per-server failures are reported in the
 * text (and `errors`) instead of silently shrinking the list to zero rows.
 */
function sessionRowLine(row) {
  const when = row.updatedAt === null || row.updatedAt === undefined ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
  const extras = []
  if (row.model !== undefined) extras.push(row.model)
  if (row.agent !== undefined) extras.push('agent=' + row.agent)
  if (row.outcome !== undefined) extras.push(row.outcome)
  if (row.cost !== undefined && row.cost > 0) extras.push('$' + row.cost.toFixed(2))
  return '- [' + row.server + '] ' + (row.directory === '' ? '(no dir)' : row.directory) + ' | ' + row.title + (when === '' ? '' : ' | ' + when) + ' | ' + row.id + (extras.length === 0 ? '' : ' | ' + extras.join(' · '))
}

/** One page of `session.list` (archived or cursor mode). */
function collectSessionPage(server, directory, query, limit, options) {
  const input = { limit: Math.min(Math.max(limit, 1), 200) }
  if (options.archived === true) input.archived = true
  if (typeof options.cursor === 'string' && options.cursor !== '') input.cursor = options.cursor
  return ocCall(server, function (client, requestOptions) {
    return client.session.list(input, requestOptions)
  }, 15000).then(function (response) {
    const rows = []
    for (const session of unwrapList(response)) {
      if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
      const sessionDirectory = session.location !== null && typeof session.location === 'object' && typeof session.location.directory === 'string' ? session.location.directory : ''
      if (directory !== undefined && directory !== '' && !sessionDirectory.startsWith(directory)) continue
      const title = typeof session.title === 'string' ? session.title : ''
      if (query !== undefined && query !== '' && title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
      const summary = summarizeSession(session)
      rows.push({
        server: server.id,
        serverState: 'online',
        directory: sessionDirectory,
        title: summary.title,
        updatedAt: summary.updatedAt,
        id: summary.id,
        model: summary.model,
        agent: summary.agent,
        outcome: summary.outcome,
        cost: summary.cost,
      })
    }
    const next = response !== null && typeof response === 'object' && response.cursor !== null && typeof response.cursor === 'object' && typeof response.cursor.next === 'string' && response.cursor.next !== '' ? response.cursor.next : undefined
    return { rows: rows, nextCursor: next }
  })
}

export function collectSessionRows(servers, serverId, directory, query, limit, options) {
  const wanted = typeof serverId === 'string' && serverId !== '' ? serverId : undefined
  const paged = options !== null && typeof options === 'object' && (options.archived === true || (typeof options.cursor === 'string' && options.cursor !== ''))
  if (paged) {
    const selected = servers.filter(function (server) { return wanted === undefined || server.id === wanted })
    if (selected.length === 0) return Promise.resolve({ count: 0, shown: 0, text: 'no matching server', nextCursor: undefined })
    if (typeof options.cursor === 'string' && options.cursor !== '' && selected.length > 1) {
      return Promise.resolve({ count: 0, shown: 0, text: 'cursor requires a single server (pass server=)', nextCursor: undefined })
    }
    const rows = []
    let nextCursor
    let chain = Promise.resolve()
    for (const server of selected) {
      chain = chain.then(function () {
        return collectSessionPage(server, directory, query, limit, options).then(function (page) {
          for (const row of page.rows) rows.push(row)
          if (selected.length === 1) nextCursor = page.nextCursor
        }, function () {})
      })
    }
    return chain.then(function () {
      rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
      const capped = limit !== undefined && limit > 0 ? rows.slice(0, limit) : rows
      const lines = capped.map(sessionRowLine)
      return {
        count: rows.length,
        shown: capped.length,
        text: lines.length === 0 ? 'no matching sessions' : lines.join('\n'),
        nextCursor: nextCursor,
        errors: [],
      }
    })
  }
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (wanted !== undefined && server.id !== wanted) continue
    chain = chain.then(function () {
      return collectServer(server).then(function (snapshot) {
        const projects = Array.isArray(snapshot.projects) ? snapshot.projects : []
        for (const project of projects) {
          const sessions = Array.isArray(project.sessions) ? project.sessions : []
          for (const session of sessions) {
            const sessionDirectory = session.directory === null ? (project.worktree === null ? '' : project.worktree) : session.directory
            if (directory !== undefined && directory !== '' && !sessionDirectory.startsWith(directory)) continue
            if (query !== undefined && query !== '' && session.title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
            rows.push({
              server: server.id,
              serverState: snapshot.state,
              directory: sessionDirectory,
              title: session.title,
              updatedAt: session.updatedAt,
              id: session.id,
              model: session.model,
              agent: session.agent,
              outcome: session.outcome,
              cost: session.cost,
            })
          }
        }
        return rows
      }, function (error) {
        errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
        return rows
      })
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
    const capped = limit !== undefined && limit > 0 ? rows.slice(0, limit) : rows
    const lines = capped.map(sessionRowLine)
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, shown: capped.length, text: lines.length === 0 ? 'no matching sessions' : lines.join('\n'), nextCursor: undefined, errors: errors }
  })
}

/** One-line preview of a tool call's input (v2 `state.input`, v1 `state.input` too). */
function summarizeToolInput(input) {
  if (input === null || typeof input !== 'object') return ''
  for (const key of ['command', 'path', 'filePath', 'file', 'pattern', 'query', 'url', 'description', 'name']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const flat = value.replace(/\s+/g, ' ').trim()
      return flat.length > 80 ? flat.slice(0, 79) + '…' : flat
    }
  }
  if (Array.isArray(input.todos)) return String(input.todos.length) + ' todo(s)'
  const keys = Object.keys(input)
  return keys.length === 0 ? '' : keys.slice(0, 3).join(', ')
}

/** First line of a tool's output text (v2 `state.content[]`, v1 `state.output`). */
function summarizeToolOutput(state) {
  let text = ''
  if (typeof state.output === 'string') text = state.output
  else if (Array.isArray(state.content)) {
    text = state.content.filter(function (part) {
      return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    }).map(function (part) { return part.text }).join(' ')
  }
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? line.slice(0, 119) + '…' : line
}

function flattenToolPart(state, name) {
  const value = state !== null && typeof state === 'object' ? state : {}
  const status = typeof value.status === 'string' ? value.status : ''
  const input = summarizeToolInput(value.input)
  const output = status === 'completed' || status === 'error' ? summarizeToolOutput(value) : ''
  return '[tool] ' + (typeof name === 'string' ? name : 'tool') + (status === '' ? '' : ': ' + status) + (input === '' ? '' : ' · ' + input) + (output === '' ? '' : ' → ' + output)
}

/** v2 message body: user `text`/`files`, assistant `content[]` (text/reasoning/tool). */
function v2Message(entry, includeBookkeeping) {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const created = entry.time !== null && typeof entry.time === 'object' && typeof entry.time.created === 'number' ? entry.time.created : null
  const pieces = []
  let tools = 0
  if (type === 'user') {
    if (typeof entry.text === 'string' && entry.text.trim() !== '') pieces.push(entry.text)
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (file === null || typeof file !== 'object') continue
      const name = typeof file.name === 'string' ? file.name : (typeof file.uri === 'string' ? file.uri.slice(0, 80) : 'file')
      pieces.push('[file] ' + name)
    }
  } else if (type === 'assistant') {
    const content = Array.isArray(entry.content) ? entry.content : []
    const texts = content.filter(function (part) {
      return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    }).map(function (part) { return part.text })
    if (texts.length > 0) pieces.push(texts.join('\n'))
    for (const part of content) {
      if (part === null || typeof part !== 'object' || part.type !== 'tool') continue
      pieces.push(flattenToolPart(part.state, part.name))
      tools += 1
    }
  } else if (type === 'shell') {
    const output = entry.output !== null && typeof entry.output === 'object' && typeof entry.output.output === 'string' ? entry.output.output.trim() : ''
    pieces.push('[shell] ' + (typeof entry.command === 'string' ? entry.command : '') + (typeof entry.exit === 'number' ? ' (exit ' + String(entry.exit) + ')' : ''))
    if (output !== '') pieces.push(output.slice(0, 2000))
  } else if (includeBookkeeping === true) {
    // Only when the caller filtered by type: render the bookkeeping message instead of hiding it.
    if (type === 'idle') {
      const outcome = typeof entry.outcome === 'string' ? entry.outcome : 'unknown'
      const error = entry.error !== null && typeof entry.error === 'object' && typeof entry.error.message === 'string' ? ': ' + entry.error.message : ''
      pieces.push('[idle] ' + outcome + error)
    } else {
      const detail = typeof entry.text === 'string' && entry.text !== ''
        ? entry.text
        : (typeof entry.description === 'string' && entry.description !== ''
          ? entry.description
          : (typeof entry.command === 'string' ? entry.command : JSON.stringify(entry).slice(0, 200)))
      pieces.push('[' + type + '] ' + detail)
    }
  } else {
    // idle/compaction/skill/system entries are bookkeeping, not conversation.
    return undefined
  }
  return {
    role: type,
    created: created,
    text: pieces.filter(function (piece) { return piece !== '' }).join('\n').trim(),
    tools: tools,
  }
}

/** Last N messages with text, tool and file parts flattened. */
/**
 * Read a session's messages oldest -> newest.
 * v2 answers newest-first and paginates with an opaque cursor, so a request
 * larger than one server page (default 50) follows `cursor.next` until `limit`
 * entries are collected (bounded: 20 pages / 4000 raw entries).
 */
export function readMessages(server, sessionId, limit, type) {
  const size = limit !== undefined && limit > 0 ? limit : 20
  const wanted = typeof type === 'string' && type !== '' ? type : undefined
  return readV2MessagePages(server, sessionId, size, wanted).then(function (raw) {
    // newest-first -> oldest-first
    return raw.slice().reverse().map(function (entry) { return v2Message(entry, wanted !== undefined) }).filter(function (message) { return message !== undefined })
  })
}

function readV2MessagePages(server, sessionId, size, type) {
  const pageSize = Math.min(Math.max(size, 1), 100)
  const MAX_PAGES = 20
  const MAX_ENTRIES = 4000
  const collected = []
  let pages = 1
  function fetchPage(cursor) {
    const input = { sessionID: sessionId, limit: pageSize }
    if (typeof type === 'string' && type !== '') input.type = type
    if (typeof cursor === 'string' && cursor !== '') input.cursor = cursor
    else input.order = 'desc'
    return ocCall(server, function (client, requestOptions) {
      return client.message.list(input, requestOptions)
    }, 20000).then(function (response) {
      const data = response !== null && typeof response === 'object' && Array.isArray(response.data) ? response.data : []
      for (const entry of data) collected.push(entry)
      const next = response !== null && typeof response === 'object' && response.cursor !== null && typeof response.cursor === 'object' && typeof response.cursor.next === 'string' && response.cursor.next !== '' ? response.cursor.next : undefined
      if (collected.length >= size || next === undefined || collected.length >= MAX_ENTRIES || pages >= MAX_PAGES) {
        return collected.slice(0, size)
      }
      pages += 1
      return fetchPage(next)
    })
  }
  return fetchPage(undefined)
}

/**
 * Derive a todo list from OpenCode 2 messages: v2 has no `/session/{id}/todo`
 * endpoint, but the `todowrite` tool call carries the authoritative list in
 * `state.input.todos` (verified on 2.3.0). Newest message wins.
 */
export function deriveTodosFromMessages(value) {
  const raw = Array.isArray(value) ? value : unwrapList(value)
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || entry.type !== 'assistant' || !Array.isArray(entry.content)) continue
    for (let index = entry.content.length - 1; index >= 0; index -= 1) {
      const part = entry.content[index]
      if (part === null || typeof part !== 'object' || part.type !== 'tool') continue
      const name = typeof part.name === 'string' ? part.name : (typeof part.tool === 'string' ? part.tool : '')
      if (!/^todo/i.test(name)) continue
      const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
      const input = state.input !== null && typeof state.input === 'object' ? state.input : {}
      const todos = Array.isArray(input.todos) ? input.todos : []
      if (todos.length === 0) continue
      const rows = todos.map(function (todo) {
        const value = todo !== null && typeof todo === 'object' ? todo : {}
        const row = { content: typeof value.content === 'string' ? value.content : '', status: typeof value.status === 'string' ? value.status : 'pending' }
        if (typeof value.priority === 'string') row.priority = value.priority
        return row
      })
      return rows
    }
  }
  return []
}

/** Title/summary/todos/diff of one session (v2 todos are derived from todowrite). */
export function collectSessionInfo(server, sessionId) {
  return ocCall(server, function (client, requestOptions) {
    return Promise.all([
      client.session.get({ sessionID: sessionId }, requestOptions),
      client.session.diff({ sessionID: sessionId }, requestOptions),
      client.message.list({ sessionID: sessionId, order: 'desc', limit: 100 }, requestOptions).catch(function () { return { data: [] } }),
    ])
  }, 20000).then(function (results) {
    const session = results[0] !== null && typeof results[0] === 'object' && !Array.isArray(results[0]) ? results[0] : {}
    return {
      session: session,
      todos: deriveTodosFromMessages(results[2]),
      todosSupported: true,
      todosDerived: true,
      diffs: Array.isArray(results[1]) ? results[1] : [],
    }
  })
}

export function shareSession(server, sessionId, action) {
  return Promise.resolve({
    ok: false,
    error: 'OpenCode 2 has no session share endpoint (v1 /session/{id}/share was removed); use the OpenCode web UI instead',
  })
}

/** Abort one session (v1 /abort, v2 /interrupt). Returns whether it was running. */
export function abortSession(server, sessionId) {
  return ocCall(server, function (client, requestOptions) {
    return client.session.interrupt({ sessionID: sessionId }, requestOptions)
  }, 15000).then(function (response) {
    if (!(server.abortedSessions instanceof Set)) server.abortedSessions = new Set()
    server.abortedSessions.add(sessionId)
    if (server.progress instanceof Map) server.progress.delete(sessionId)
    return response !== null && typeof response === 'object' && response.interrupted === true
  })
}

/** Running sessions as `{sessionId: {type}}` (v1 /session/status, v2 /session/active). */
export function collectStatus(server) {
  if (server.statusSnapshot !== undefined && Date.now() - server.statusSnapshot.at < 5000) {
    return Promise.resolve(server.statusSnapshot.value)
  }
  return ocCall(server, function (client, requestOptions) {
    return client.session.active(requestOptions)
  }, 5000).then(function (payload) {
    const value = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
    server.statusSnapshot = { at: Date.now(), value: value }
    return value
  }, function () { return {} })
}

function v2Agent(agent) {
  const id = typeof agent.id === 'string' ? agent.id : (typeof agent.name === 'string' ? agent.name : undefined)
  const name = typeof agent.name === 'string' ? agent.name : id
  return {
    id: id,
    name: name,
    mode: typeof agent.mode === 'string' ? agent.mode : null,
    native: undefined,
    hidden: agent.hidden === true,
    description: typeof agent.description === 'string' ? agent.description : null,
  }
}

/** Agents advertised by each server (primary + subagent, native/custom). */
export function collectAgents(servers, serverId) {
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () {
        return ocCall(server, function (client, requestOptions) {
          return client.agent.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
        }, 8000).then(function (value) {
          const list = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : unwrapList(value)
          for (const raw of list) {
            if (raw === null || typeof raw !== 'object') continue
            const agent = v2Agent(raw)
            if (agent.id === undefined) continue
            agent.server = server.id
            rows.push(agent)
          }
        }, function (error) {
          errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
        })
      })
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      const label = row.id !== row.name ? row.id + ' (' + row.name + ')' : row.name
      const meta = [row.mode === null ? '?' : row.mode, row.native === true ? 'native' : null, row.hidden ? 'hidden' : null].filter(function (piece) { return piece !== null })
      return '- [' + row.server + '] ' + label + ' (' + meta.join(', ') + ')' + (row.description === null ? '' : ' — ' + row.description)
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no agents' : lines.join('\n'), errors: errors }
  })
}

/**
 * Map a user-supplied agent name to the v2 agent id (`name` is a display name
 * in OpenCode 2; the session API expects `Agent.ID`). Falls back to the input.
 */
export function resolveAgentId(server, agent) {
  if (typeof agent !== 'string' || agent === '') return Promise.resolve(agent)
  return ensureApiVersion(server).then(function () {
    return ocCall(server, function (client, requestOptions) {
      return client.agent.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
    }, 8000).then(function (value) {
    const list = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : unwrapList(value)
    const lower = agent.toLowerCase()
    const match = list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.id === agent }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.name === agent }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && String(candidate.name).toLowerCase() === lower }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && String(candidate.id).toLowerCase() === lower })
      return match === undefined || match === null ? agent : match.id
    }, function () { return agent })
  })
}

/** Directory a session belongs to (read from the session's location). */
export function sessionDirectory(server, sessionId, fallback) {
  return ocCall(server, function (client, requestOptions) {
    return client.session.get({ sessionID: sessionId }, requestOptions)
  }, 8000).then(function (session) {
      const location = session !== null && typeof session === 'object' && session.location !== null && typeof session.location === 'object' ? session.location : null
      if (location !== null && typeof location.directory === 'string' && location.directory !== '') return location.directory
      return fallback
    }, function () { return fallback })
}
/**
 * Current unfinished tool of a running session (for SSE catch-up). OpenCode 2
 * does not replay progress events, so a stream opened mid-run has to read the
 * latest message once and seed the same `progress` shape the SSE mapper uses.
 */
export function collectRunningTool(server, sessionId) {
  return ocCall(server, function (client, requestOptions) {
    return client.message.list({ sessionID: sessionId, order: 'desc', limit: 20 }, requestOptions)
  }, 8000).then(function (response) {
    const messages = response !== null && typeof response === 'object' && Array.isArray(response.data) ? response.data : []
    for (const entry of messages) {
      if (entry === null || typeof entry !== 'object' || entry.type !== 'assistant' || !Array.isArray(entry.content)) continue
      for (let index = entry.content.length - 1; index >= 0; index -= 1) {
        const part = entry.content[index]
        if (part === null || typeof part !== 'object' || part.type !== 'tool') continue
        const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
        if (state.status !== 'running' && state.status !== 'pending') continue
        const time = part.time !== null && typeof part.time === 'object' ? part.time : {}
        return {
          status: 'tool',
          tool: typeof part.name === 'string' && part.name !== '' ? part.name : 'tool',
          callID: typeof part.id === 'string' ? part.id : null,
          since: typeof time.ran === 'number' ? time.ran : (typeof time.created === 'number' ? time.created : Date.now()),
          tail: '',
        }
      }
    }
    return undefined
  }, function () { return undefined })
}

function pendingEntry(kind, request, sessionId, fallbackAt) {
  const requestId = typeof request.id === 'string' ? request.id : (typeof request.requestID === 'string' ? request.requestID : undefined)
  if (requestId === undefined) return undefined
  const at = request !== null && typeof request === 'object' && request.time !== null && typeof request.time === 'object' && typeof request.time.created === 'number' ? request.time.created : fallbackAt
  return {
    sessionId: sessionId,
    kind: kind,
    requestId: requestId,
    detail: kind === 'form' ? describePending('form', request) : describePermission(request),
    at: at,
  }
}

/** One location-scoped v2 pending list; `unsupported` marks an endpoint an older build lacks. */
function awaitGlobal(server, kind, at) {
  const location = typeof server.directory === 'string' && server.directory !== '' ? { directory: server.directory } : undefined
  return ocCall(server, function (client, requestOptions) {
    if (kind === 'form') return client.form.list({ location: location }, requestOptions)
    return client.permission.request.list({ location: location }, requestOptions)
  }, 5000).then(function (result) {
    const entries = []
    const list = result !== null && typeof result === 'object' && Array.isArray(result.data) ? result.data : unwrapList(result)
    for (const item of list) {
      const form = kind === 'form' && item !== null && typeof item === 'object' && item.form !== undefined ? item.form : item
      const sessionId = item !== null && typeof item === 'object'
        ? (typeof item.sessionID === 'string' ? item.sessionID : (form !== item && typeof form.sessionID === 'string' ? form.sessionID : undefined))
        : undefined
      const entry = pendingEntry(kind, form, sessionId, at)
      if (entry !== undefined) entries.push(entry)
    }
    return { unsupported: false, entries: entries }
  }, function () {
    return { unsupported: true, entries: [] }
  })
}

/**
 * Pending permission/form requests, normalized to
 * `[{sessionId, kind:'permission'|'form', requestId, detail, at}]`.
 *
 * v1 exposes global lists (`/permission`, `/question`); v2 exposes location-scoped
 * `/permission/request` and `/form`. Only when a build lacks those (older v2) do we
 * fall back to querying the given running sessions one by one.
 */
export function collectPending(server, sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter(function (id) { return typeof id === 'string' && id !== '' }) : []
  const at = Date.now()
  return ensureApiVersion(server).then(function () {
    // v2 exposes location-scoped global lists (`/api/permission/request`, `/api/form`);
    // older builds only answer per session, so keep that as a fallback.
    const results = [awaitGlobal(server, 'permission', at), awaitGlobal(server, 'form', at)]
    return Promise.all(results).then(function (settled) {
      const unsupported = settled.some(function (item) { return item.unsupported === true })
      if (!unsupported) {
        const out = []
        for (const item of settled) {
          for (const entry of item.entries) out.push(entry)
        }
        return out
      }
      const chain = []
      for (const sessionId of ids) {
        chain.push(opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/permission', { timeoutMs: 5000 }).then(function (value) {
          return unwrapList(value).map(function (request) { return pendingEntry('permission', request, sessionId, at) }).filter(Boolean)
        }, function () { return [] }))
        chain.push(opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/form', { timeoutMs: 5000 }).then(function (value) {
          return unwrapList(value).map(function (request) { return pendingEntry('form', request, sessionId, at) }).filter(Boolean)
        }, function () { return [] }))
      }
      return Promise.all(chain).then(function (parts) {
        const out = []
        for (const part of parts) for (const item of part) out.push(item)
        return out
      })
    })
  })
}

/** Normalize `/experimental/session/stats` into the shape the UI and tools use. */
export function summarizeStats(raw) {
  const payload = raw !== null && typeof raw === 'object' ? raw : {}
  const tokens = payload.tokens !== null && typeof payload.tokens === 'object' ? payload.tokens : {}
  const cache = tokens.cache !== null && typeof tokens.cache === 'object' ? tokens.cache : {}
  const tools = payload.tools !== null && typeof payload.tools === 'object' ? payload.tools : {}
  const totals = tools.totals !== null && typeof tools.totals === 'object' ? tools.totals : {}
  const number = function (value) { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
  // Per-model attribution is authoritative server-side (it is computed over the
  // requested range, not over the session's *current* model), so pass it through
  // instead of re-deriving it from session rows. Sorted by cost, top 10.
  const models = (Array.isArray(payload.models) ? payload.models : []).map(function (entry) {
    const source = entry !== null && typeof entry === 'object' && entry.model !== null && typeof entry.model === 'object' ? entry.model : {}
    const label = modelLabel(source)
    return {
      model: label === undefined ? [source.providerID, source.id].filter(function (part) { return typeof part === 'string' && part !== '' }).join('/') : label,
      steps: number(entry === null || typeof entry !== 'object' ? 0 : entry.steps),
      tokens: normalizeTokens(entry === null || typeof entry !== 'object' ? undefined : entry.tokens) ?? {},
      cost: number(entry === null || typeof entry !== 'object' ? 0 : entry.cost),
    }
  }).filter(function (item) { return item.model !== '' }).sort(function (a, b) { return b.cost - a.cost }).slice(0, 10)
  // `tools=detail` adds per-tool rows (calls + P50). Normalize and sort by calls;
  // `summary` responses omit `usage`, so the shape stays unchanged for old callers.
  const usage = (Array.isArray(tools.usage) ? tools.usage : []).map(function (entry) {
    const row = entry !== null && typeof entry === 'object' ? entry : {}
    return {
      name: typeof row.name === 'string' && row.name !== '' ? row.name : undefined,
      calls: number(row.calls),
      succeeded: number(row.succeeded),
      failed: number(row.failed),
      unfinished: number(row.unfinished),
      durationP50: typeof row.durationP50 === 'number' && Number.isFinite(row.durationP50) ? row.durationP50 : undefined,
    }
  }).filter(function (item) { return item.name !== undefined }).sort(function (a, b) { return b.calls - a.calls })
  const toolsResult = { calls: number(totals.calls), succeeded: number(totals.succeeded), failed: number(totals.failed) }
  if (typeof totals.unfinished === 'number') toolsResult.unfinished = number(totals.unfinished)
  if (usage.length > 0) toolsResult.usage = usage
  // `activity` is the only per-day series the endpoint offers: steps, nothing
  // else. Callers that draw a daily chart must fill the gaps themselves.
  const activity = (Array.isArray(payload.activity) ? payload.activity : []).map(function (entry) {
    const row = entry !== null && typeof entry === 'object' ? entry : {}
    return { date: typeof row.date === 'string' && row.date !== '' ? row.date : undefined, steps: number(row.steps) }
  }).filter(function (item) { return item.date !== undefined })

  return {
    sessions: number(payload.sessions),
    subagents: number(payload.subagents),
    prompts: number(payload.prompts),
    steps: number(payload.steps),
    tokens: {
      input: number(tokens.input),
      output: number(tokens.output),
      reasoning: number(tokens.reasoning),
      cacheRead: number(cache.read),
      cacheWrite: number(cache.write),
    },
    cost: number(payload.cost),
    tools: toolsResult,
    activeDays: number(payload.activeDays),
    streak: number(payload.streak),
    activity: activity,
    models: models,
  }
}

/**
 * Token/cost usage for one server and time range.
 * v1 has no equivalent endpoint, so it reports `unsupported` instead of zeros.
 */
// One stats call is a full history scan server-side (~0.2–0.6 s for a 7-day window,
// ~15 s for all history on a busy server), so the cache must actually serve polls.
export const STATS_TTL_MS = 300000
export const STATS_BUCKET_MS = 300000
export function collectStats(server, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const from = typeof opts.from === 'number' && opts.from >= 0 ? Math.floor(opts.from) : 0
  const to = typeof opts.to === 'number' && opts.to > 0 ? Math.floor(opts.to) : Date.now()
  const tools = opts.tools === 'detail' ? 'detail' : 'summary'
  // Cache keyed by the range start, bucketed, and *not* by `to` (which moves with
  // every request). Callers derive `from` from `Date.now()` too (the board's 7-day
  // window), so an exact key would miss on every poll; the bucket plus a TTL longer
  // than the poll interval is what makes repeated polls reuse one history scan.
  // `from: 0` means "all history" and gets its own key so it cannot collide.
  // The tool mode is part of the key: `detail` carries per-tool usage that
  // `summary` lacks, so sharing a slot would silently downgrade a detail caller.
  const cacheKey = tools + ':' + (from === 0 ? 'all' : String(Math.floor(from / STATS_BUCKET_MS)))
  server.statsCache = server.statsCache instanceof Map ? server.statsCache : new Map()
  const cached = server.statsCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < STATS_TTL_MS) return Promise.resolve(cached.value)
  if (server.statsCache.size > 32) server.statsCache.clear()
  // Single-flight: /insights, /usage and the activity warmer can ask for the same
  // window at the same time; without this each miss ran its own history scan.
  server.statsInflight = server.statsInflight instanceof Map ? server.statsInflight : new Map()
  const pending = server.statsInflight.get(cacheKey)
  if (pending !== undefined) return pending
  const promise = ocCall(server, function (client, requestOptions) {
    const input = { to: to, tools: tools }
    if (from > 0) input.from = from
    return client.session.stats(input, requestOptions)
  }, 20000).then(function (payload) {
    const result = { supported: true, range: { from: from, to: to }, ...summarizeStats(payload) }
    server.statsCache.set(cacheKey, { at: Date.now(), value: result })
    return result
  }, function (error) {
    return { supported: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
  })
  server.statsInflight.set(cacheKey, promise)
  const done = function () { if (server.statsInflight.get(cacheKey) === promise) server.statsInflight.delete(cacheKey) }
  promise.then(done, done)
  return promise
}

/**
 * Count archived sessions on one server.
 *
 * v2 pages `/session` with a cursor; archived sessions are opt-in
 * (`archived=true` returns only those). The count is small, but the page cap
 * keeps a pathological server from turning the dashboard into a pagination
 * loop; when the cap is hit the caller is told via `truncated`.
 */
export const ARCHIVED_TTL_MS = 300000
export function collectArchivedCount(server) {
  const cached = server.archivedCache
  if (cached !== undefined && Date.now() - cached.at < ARCHIVED_TTL_MS) return Promise.resolve(cached.value)
  let count = 0
  let pages = 0
  function page(cursor) {
    const input = { archived: true, limit: 500 }
    if (typeof cursor === 'string' && cursor !== '') input.cursor = cursor
    return ocCall(server, function (client, requestOptions) {
      return client.session.list(input, requestOptions)
    }, 15000).then(function (response) {
      const data = response !== null && typeof response === 'object' && Array.isArray(response.data) ? response.data : []
      count += data.length
      pages += 1
      const next = response !== null && typeof response === 'object' && response.cursor !== null && typeof response.cursor === 'object' && typeof response.cursor.next === 'string' && response.cursor.next !== '' ? response.cursor.next : undefined
      if (next === undefined || data.length === 0) return { supported: true, count: count, truncated: false }
      if (pages >= 5) return { supported: true, count: count, truncated: true }
      return page(next)
    })
  }
  return page(undefined).then(function (value) {
    server.archivedCache = { at: Date.now(), value: value }
    return value
  }, function (error) {
    const failed = { supported: false, count: 0, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
    server.archivedCache = { at: Date.now(), value: failed }
    return failed
  })
}

/**
 * Cap on message pulls for one attribution call. A fleet where every model is
 * priced could otherwise turn one report into hundreds of requests; when the
 * cap bites the result is marked `partial` instead of silently under-counting.
 */
const ATTRIBUTION_MAX_SESSIONS = 50
const ATTRIBUTION_MAX_PAGES = 20
const ATTRIBUTION_PAGE_SIZE = 100
const ATTRIBUTION_CONCURRENCY = 4
// Hard ceiling on message requests for one report: `from: 0` (all history) has no
// natural stop, and 50 sessions x 20 pages would be a thousand requests.
const ATTRIBUTION_MAX_REQUESTS = 200
// The settings panel polls the grouped report every 240 s, so the directory
// cache must outlive that poll; sharing STATS_TTL_MS (300 s) made every poll a
// guaranteed miss.
export const ATTRIBUTION_TTL_MS = 600000

/** Message of an unknown thrown value, for failure reasons. */
function errorText(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Sum message `cost` inside the window.
 *
 * Messages are fetched newest-first (`type=assistant`, the type stats counts)
 * and the walk stops at the first message older than `from`, so a long-lived
 * session normally costs one page. Compaction messages can also carry `cost`,
 * but stats and `session.cost` both exclude them — counting them here would
 * make the directory split disagree with the headline total (measured on e5:
 * one compaction worth $0.444 pushed the split 0.45% above stats). The split
 * must reconcile with stats, so only the type stats includes is summed.
 * Hitting the page cap returns `truncated` rather than pretending the older
 * part of the window was empty. A message without a timestamp is skipped: it
 * cannot be placed in the window, and charging it would inflate the window it
 * may not belong to.
 */
function sessionWindowCost(server, sessionId, from, budget) {
  const base = '/session/' + encodeURIComponent(sessionId) + '/message'
  let sum = 0
  let pages = 0
  let cursor
  function page() {
    if (budget !== undefined && budget.left <= 0) return Promise.resolve({ sum: sum, truncated: true })
    if (budget !== undefined) budget.left -= 1
    return ocCall(server, function (client, requestOptions) {
      const input = { sessionID: sessionId, limit: ATTRIBUTION_PAGE_SIZE, type: 'assistant' }
      if (typeof cursor === 'string' && cursor !== '') input.cursor = cursor
      else input.order = 'desc'
      return client.message.list(input, requestOptions)
    }, 20000).then(function (value) {
      const data = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : []
      let older = false
      for (const entry of data) {
        // The server filters `type=assistant`; re-check locally so a server that
        // ignores the parameter cannot slip compaction cost into the sum.
        if (entry === null || typeof entry !== 'object' || entry.type !== 'assistant') continue
        const at = entry.time !== null && typeof entry.time === 'object' ? entry.time.created : undefined
        if (typeof at !== 'number') continue
        if (from > 0 && at < from) { older = true; break }
        if (typeof entry.cost === 'number' && Number.isFinite(entry.cost)) sum += entry.cost
      }
      pages += 1
      const next = value.cursor !== null && typeof value.cursor === 'object' && typeof value.cursor.next === 'string' && value.cursor.next !== '' ? value.cursor.next : undefined
      if (older || next === undefined || data.length === 0) return { sum: sum, truncated: false }
      if (pages >= ATTRIBUTION_MAX_PAGES) return { sum: sum, truncated: true }
      cursor = next
      return page()
    })
  }
  return page()
}

/**
 * Read a session's window cost, retrying once from a fresh first page.
 *
 * A single failed read used to drop that session's whole cost (a transient 5xx
 * on e5 silently removed $27.39 and flipped the report to `partial`). Re-reading
 * is cheap — the fleet's whole attribution pass is under a second — and a
 * deterministic failure simply fails again with its reason recorded.
 */
function sessionWindowCostRetried(server, sessionId, from, budget) {
  return sessionWindowCost(server, sessionId, from, budget).catch(function (firstError) {
    return sessionWindowCost(server, sessionId, from, budget).then(function (value) {
      value.retried = true
      return value
    }, function (retryError) {
      const error = retryError !== null && typeof retryError === 'object' && retryError.message !== undefined ? retryError : firstError
      throw error
    })
  })
}

/** Run `run` over `items` with at most `limit` in flight, never rejecting. */
function mapWithLimit(items, limit, run) {
  const results = new Array(items.length)
  let index = 0
  function worker() {
    if (index >= items.length) return Promise.resolve()
    const position = index
    index += 1
    return Promise.resolve().then(function () { return run(items[position], position) }).then(
      function (value) { results[position] = { ok: true, value: value } },
      function (error) { results[position] = { ok: false, error: error } },
    ).then(worker)
  }
  const workers = []
  for (let start = 0; start < Math.min(limit, items.length); start += 1) workers.push(worker())
  return Promise.all(workers).then(function () { return results })
}

/**
 * Cost grouped by directory, restricted to the time window.
 *
 * Two facts about the upstream API decide the implementation:
 *
 * 1. `session.cost` is a **lifetime** total. Summing it over sessions that were
 *    touched in the window counts every step the session ever ran — measured
 *    5.1x too high on OpenCode 2.3.0 (7 days: $72.52 vs the authoritative
 *    $14.08). `time.updated` is also the wrong activity signal: viewing or
 *    renaming a session bumps it, so sessions that never ran get included
 *    (90 sessions vs 59 that actually ran).
 * 2. The server does keep **per-message** `assistant.cost`, which is what
 *    `/experimental/session/stats` aggregates. Summing messages created inside
 *    the window reproduces the stats total exactly (14.0841 vs 14.0841), which
 *    is what makes a directory split comparable with the model split.
 *
 * So: an active session is one whose `time.busy` is inside the window
 * (OpenCode only reports `busy` for sessions that ran); messages are read only
 * for active sessions carrying a priced lifetime cost. The directory is the
 * session's own, falling back to the project worktree when it is empty or `/`
 * (the `global` project's worktree is `/`, and charging the fleet total to `/`
 * is worse than saying "unattributed").
 *
 * Cached like stats: the session pull is not free.
 */
export function collectCostByDirectory(server, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const from = typeof opts.from === 'number' && opts.from > 0 ? Math.floor(opts.from) : 0
  const rawMax = typeof opts.maxSessions === 'number' && opts.maxSessions > 0 ? Math.floor(opts.maxSessions) : ATTRIBUTION_MAX_SESSIONS
  const rawBudget = typeof opts.maxRequests === 'number' && opts.maxRequests > 0 ? Math.floor(opts.maxRequests) : ATTRIBUTION_MAX_REQUESTS
  const cacheKey = from === 0 ? 'dir:all' : 'dir:' + Math.floor(from / STATS_BUCKET_MS)
  server.directoryCostCache = server.directoryCostCache instanceof Map ? server.directoryCostCache : new Map()
  const cached = server.directoryCostCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < ATTRIBUTION_TTL_MS) return Promise.resolve(cached.value)
  return ensureApiVersion(server).then(function () {
    return collectServer(server).then(function (value) {
      const now = Date.now()
      const groups = value !== null && typeof value === 'object' && Array.isArray(value.projects) ? value.projects : []
      const active = []
      for (const group of groups) {
        const worktree = group !== null && typeof group === 'object' && typeof group.worktree === 'string' && group.worktree !== '' && group.worktree !== '/' ? group.worktree : undefined
        const sessions = group !== null && typeof group === 'object' && Array.isArray(group.sessions) ? group.sessions : []
        for (const session of sessions) {
          // v2 reports `time.busy` for sessions that actually ran; a missing value
          // means it never ran, and `time.updated` is bumped by viewing/renaming,
          // so it is not an activity signal here (that fallback is what counted
          // 90 sessions where 60 had run).
          const activeAt = typeof session.busyAt === 'number' ? session.busyAt : undefined
          if (activeAt === undefined) continue
          if (from > 0 && activeAt < from) continue
          const own = typeof session.directory === 'string' && session.directory !== '' && session.directory !== '/' ? session.directory : undefined
          active.push({
            id: session.id,
            directory: own !== undefined ? own : (worktree !== undefined ? worktree : '(unattributed)'),
            cost: session.cost,
          })
        }
      }
      const priced = active.filter(function (entry) { return typeof entry.cost === 'number' && entry.cost > 0 })
      const todo = priced.slice(0, rawMax)
      const skipped = priced.length - todo.length
      const budget = { left: rawBudget }
      return mapWithLimit(todo, ATTRIBUTION_CONCURRENCY, function (entry) { return sessionWindowCostRetried(server, entry.id, from, budget) }).then(function (results) {
        const byDirectory = new Map()
        for (const entry of active) {
          const row = byDirectory.get(entry.directory) ?? { directory: entry.directory, cost: 0, sessions: 0 }
          row.sessions += 1
          byDirectory.set(entry.directory, row)
        }
        let cost = 0
        let failed = 0
        let retried = 0
        let truncated = false
        const failures = []
        results.forEach(function (result, position) {
          const entry = todo[position]
          if (result.ok !== true) {
            failed += 1
            // Keep the reason: without it a partial report can only be noticed,
            // not diagnosed (the $27.39 incident had to be reverse-engineered
            // from the missing amount).
            if (failures.length < 5) failures.push({ session: entry.id, reason: errorText(result.error).slice(0, 160) })
            return
          }
          if (result.value.retried === true) retried += 1
          const row = byDirectory.get(entry.directory) ?? { directory: entry.directory, cost: 0, sessions: 0 }
          row.cost += result.value.sum
          cost += result.value.sum
          byDirectory.set(entry.directory, row)
          if (result.value.truncated === true) truncated = true
        })
        const all = Array.from(byDirectory.values())
        const report = {
          kind: 'windowed',
          range: { from: from, to: now },
          total: {
            cost: roundCost(cost),
            // `directories` below is cut to the top 10 for display; the totals
            // must not be, or a fleet with >10 priced directories would look
            // inconsistent purely because the display list was truncated.
            directoryCount: all.filter(function (entry) { return entry.cost > 0 }).length,
            sessions: active.length,
            priced: todo.length,
            skipped: skipped,
            failed: failed,
            retried: retried,
            failures: failures,
            partial: skipped > 0 || truncated || failed > 0,
          },
          directories: all.filter(function (entry) { return entry.cost > 0 })
            .sort(function (a, b) { return b.cost - a.cost })
            .slice(0, 10)
            .map(function (entry) { return { directory: entry.directory, cost: roundCost(entry.cost), sessions: entry.sessions } }),
        }
        return report
      })
    })
  }).then(function (report) {
    // Only complete reports are cached: caching a partial one kept a single
    // transient read failure on screen for the whole 600 s TTL, across two
    // settings polls, instead of letting the next poll retry.
    if (report.kind === 'windowed' && report.total.partial !== true) server.directoryCostCache.set(cacheKey, { at: Date.now(), value: report })
    return report
  }).catch(function (error) {
    const message = String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
    return {
      kind: 'error',
      range: { from: from },
      total: { cost: 0, sessions: 0, priced: 0, skipped: 0, failed: 0, partial: true },
      directories: [],
      error: message,
    }
  })
}

/**
 * Mark a session as viewed on the remote, which is how OpenCode's own UI clears
 * its unread dot: `POST /session/{id}/view {idle}` pushes `viewed` up to that
 * idle moment, so `idle > viewed` becomes false. The state lives in OpenCode,
 * not here — dsh restarts cannot lose it, and both UIs agree.
 *
 * Resolves `{supported, ok}`: v1 has no such endpoint, and a missing `idle` is
 * never guessed from the clock (`Date.now()` could run ahead of a live run and
 * mark an in-flight turn read).
 */
export function markSessionViewed(server, sessionId, idle) {
  return ensureApiVersion(server).then(function () {
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle <= 0) return { supported: true, ok: false, error: 'idle required' }
    return ocCall(server, function (client, requestOptions) {
      return client.session.view({ sessionID: sessionId, idle: Math.floor(idle) }, requestOptions)
    }, 8000).then(function () {
      return { supported: true, ok: true }
    }, function (error) {
      // A v1 server (or any transport failure) means the read marker is not
      // available; report unsupported instead of pretending the endpoint worked.
      return { supported: false, ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
    })
  })
}
