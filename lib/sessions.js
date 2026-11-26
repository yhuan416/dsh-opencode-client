/**
 * Read-only OpenCode session discovery, messages, metadata and status.
 *
 * Both API generations are supported: v1 (`/session`, `/project`, ...) and v2
 * (`/api/*`, `{data}`/`{location,data}` envelopes, `location.directory`,
 * `content[]` messages, `/session/active`, `/session/interrupt`). Callers see
 * one normalized shape, so routes and tools never branch on the version.
 */
import { opencodeRequest, opencodeValue, ensureApiVersion, unwrap, unwrapList, withLocation, apiVersionOf } from './http.js'
import { modelLabel } from './config.js'

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

/** Health + projects + sessions of one server, grouped by directory. */
export function collectServer(server) {
  if (server.snapshot !== undefined && Date.now() - server.snapshot.at < 10000) {
    return Promise.resolve(server.snapshot.value)
  }
  return ensureApiVersion(server).then(function () {
    const healthTarget = apiVersionOf(server) === '2' ? '/info' : '/global/health'
    // v2 pages the list (v1 returns everything): take a large first page and flag truncation.
    const sessionTarget = apiVersionOf(server) === '2' ? '/session?limit=500' : '/session'
    return Promise.all([
      opencodeValue(server, healthTarget),
      opencodeValue(server, '/project'),
      opencodeValue(server, sessionTarget),
    ])
  }).then(function (results) {
    const health = results[0] !== undefined && results[0] !== null && typeof results[0] === 'object' ? results[0] : undefined
    const projects = Array.isArray(results[1]) ? results[1] : []
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
      truncated: cursor !== undefined && cursor.next !== null && cursor.next !== undefined && sessions.length >= 500,
    }
    server.snapshot = { at: Date.now(), value: value }
    return value
  })
}

/**
 * One line per session across servers. Per-server failures are reported in the
 * text (and `errors`) instead of silently shrinking the list to zero rows.
 */
export function collectSessionRows(servers, serverId, directory, query, limit) {
  const wanted = typeof serverId === 'string' && serverId !== '' ? serverId : undefined
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
    const lines = capped.map(function (row) {
      const when = row.updatedAt === null || row.updatedAt === undefined ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
      const extras = []
      if (row.model !== undefined) extras.push(row.model)
      if (row.agent !== undefined) extras.push('agent=' + row.agent)
      if (row.outcome !== undefined) extras.push(row.outcome)
      if (row.cost !== undefined && row.cost > 0) extras.push('$' + row.cost.toFixed(2))
      return '- [' + row.server + '] ' + (row.directory === '' ? '(no dir)' : row.directory) + ' | ' + row.title + (when === '' ? '' : ' | ' + when) + ' | ' + row.id + (extras.length === 0 ? '' : ' | ' + extras.join(' · '))
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    for (const server of servers) {
      if (wanted !== undefined && server.id !== wanted) continue
      if (server.snapshot !== undefined && server.snapshot.value !== undefined && server.snapshot.value.truncated === true) {
        lines.push('- [' + server.id + '] more sessions exist; narrow with directory/query or use opencode_search')
      }
    }
    return { count: rows.length, shown: capped.length, text: lines.length === 0 ? 'no matching opencode sessions' : lines.join('\n'), errors: errors }
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

function v1Message(entry) {
  const info = entry !== null && typeof entry === 'object' && entry.info !== null && typeof entry.info === 'object' ? entry.info : {}
  const parts = Array.isArray(entry.parts) ? entry.parts : []
  const text = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
  }).map(function (part) { return part.text }).join('\n').trim()
  const toolLines = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'tool'
  }).map(function (part) {
    const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
    return flattenToolPart(state, typeof part.tool === 'string' ? part.tool : 'tool')
  })
  const fileLines = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'file'
  }).map(function (part) {
    return '[file] ' + (typeof part.filename === 'string' ? part.filename : 'file') + (typeof part.mime === 'string' ? ' (' + part.mime + ')' : '')
  })
  const combined = [text].concat(toolLines).concat(fileLines).filter(function (piece) { return piece !== '' }).join('\n').trim()
  return {
    role: typeof info.role === 'string' ? info.role : 'unknown',
    created: info.time !== null && typeof info.time === 'object' && typeof info.time.created === 'number' ? info.time.created : null,
    text: combined,
    tools: toolLines.length,
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
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) === '2') {
      return readV2MessagePages(server, sessionId, size, wanted).then(function (raw) {
        // newest-first -> oldest-first, like v1.
        return raw.slice().reverse().map(function (entry) { return v2Message(entry, wanted !== undefined) }).filter(function (message) { return message !== undefined })
      })
    }
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/message', { timeoutMs: 20000 }).then(function (result) {
      const value = result === undefined ? undefined : result.value
      const raw = Array.isArray(value) ? value : unwrapList(value)
      if (result === undefined || result.status !== 200 || !Array.isArray(raw)) {
        throw new Error('opencode: cannot read messages of ' + server.id + '/' + sessionId)
      }
      const picked = limit !== undefined && limit > 0 ? raw.slice(-limit) : raw
      return picked.map(v1Message).filter(function (message) {
        return message !== undefined && (wanted === undefined || message.role === wanted)
      })
    })
  })
}

function readV2MessagePages(server, sessionId, size, type) {
  const base = '/session/' + encodeURIComponent(sessionId) + '/message'
  const typed = typeof type === 'string' && type !== '' ? '&type=' + encodeURIComponent(type) : ''
  const pageSize = Math.min(Math.max(size, 1), 100)
  const MAX_PAGES = 20
  const MAX_ENTRIES = 4000
  const collected = []
  function fetchPage(query) {
    return opencodeRequest(server, base + '?' + query, { timeoutMs: 20000 }).then(function (result) {
      if (result === undefined || result.status !== 200) {
        throw new Error('opencode: cannot read messages of ' + server.id + '/' + sessionId)
      }
      const value = result.value
      const data = value !== null && typeof value === 'object' && Array.isArray(value.data)
        ? value.data
        : (Array.isArray(value) ? value : unwrapList(value))
      for (const entry of data) collected.push(entry)
      const cursor = value !== null && typeof value === 'object' && value.cursor !== null && typeof value.cursor === 'object' ? value.cursor : {}
      const next = typeof cursor.next === 'string' && cursor.next !== '' ? cursor.next : undefined
      if (collected.length >= size || next === undefined || collected.length >= MAX_ENTRIES || pages >= MAX_PAGES) {
        // A page may overshoot the requested size; keep only the newest `size`.
        return collected.slice(0, size)
      }
      pages += 1
      const remaining = Math.max(size - collected.length, 1)
      return fetchPage('cursor=' + encodeURIComponent(next) + '&limit=' + String(Math.min(pageSize, remaining, 100)) + typed)
    })
  }
  let pages = 1
  return fetchPage('order=desc&limit=' + String(pageSize) + typed)
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
  return ensureApiVersion(server).then(function () {
    const sessionRequest = opencodeValue(server, '/session/' + encodeURIComponent(sessionId), { timeoutMs: 8000 })
    const diffRequest = opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/diff', { timeoutMs: 8000 })
    if (apiVersionOf(server) === '2') {
      const todoRequest = opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/message?order=desc&limit=100', { timeoutMs: 15000 }).catch(function () { return [] })
      return Promise.all([sessionRequest, diffRequest, todoRequest]).then(function (results) {
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
    const todoRequest = opencodeValue(server, '/session/' + encodeURIComponent(sessionId) + '/todo', { timeoutMs: 8000 })
    return Promise.all([sessionRequest, todoRequest, diffRequest]).then(function (results) {
      const session = results[0] !== null && typeof results[0] === 'object' ? results[0] : {}
      return {
        session: session,
        todos: Array.isArray(results[1]) ? results[1] : [],
        diffs: Array.isArray(results[2]) ? results[2] : [],
        todosSupported: true,
      }
    })
  })
}

export function shareSession(server, sessionId, action) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) === '2') {
      return {
        ok: false,
        error: 'OpenCode 2 has no session share endpoint (v1 /session/{id}/share was removed); use the OpenCode web UI instead',
      }
    }
    const method = action === 'unshare' ? 'DELETE' : 'POST'
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/share', { method: method, timeoutMs: 10000 }).then(function (result) {
      if (result === undefined || result.status !== 200) return { ok: false, error: 'opencode share failed (status ' + (result === undefined ? 'none' : String(result.status)) + ')' }
      const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
      return {
        ok: true,
        url: typeof value.url === 'string' ? value.url : (typeof value.share === 'object' && value.share !== null && typeof value.share.url === 'string' ? value.share.url : null),
        raw: value,
      }
    })
  })
}

/** Abort one session (v1 /abort, v2 /interrupt). Returns whether it was running. */
export function abortSession(server, sessionId) {
  return ensureApiVersion(server).then(function () {
    const version = apiVersionOf(server)
    const target = version === '2'
      ? '/session/' + encodeURIComponent(sessionId) + '/interrupt'
      : '/session/' + encodeURIComponent(sessionId) + '/abort'
    return opencodeRequest(server, target, { method: 'POST', body: version === '2' ? undefined : {}, timeoutMs: 15000 }).then(function (result) {
    if (result === undefined || result.status !== 200) {
      throw new Error('opencode: abort failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
    }
    if (!(server.abortedSessions instanceof Set)) server.abortedSessions = new Set()
    server.abortedSessions.add(sessionId)
    if (server.progress instanceof Map) server.progress.delete(sessionId)
      if (version === '2') {
        const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
        return value.interrupted === true
      }
      return result.value !== false
    })
  })
}

/** Running sessions as `{sessionId: {type}}` (v1 /session/status, v2 /session/active). */
export function collectStatus(server) {
  if (server.statusSnapshot !== undefined && Date.now() - server.statusSnapshot.at < 5000) {
    return Promise.resolve(server.statusSnapshot.value)
  }
  return ensureApiVersion(server).then(function () {
    const target = apiVersionOf(server) === '2' ? '/session/active' : '/session/status'
    return opencodeRequest(server, target, { timeoutMs: 5000 })
  }).then(function (result) {
    const payload = result === undefined ? undefined : unwrap(result.value)
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
        const version = apiVersionOf(server)
        const target = version === '2' ? withLocation('/agent', server.directory) : '/agent'
        return opencodeValue(server, target, { timeoutMs: 8000 }).then(function (value) {
        const list = Array.isArray(value) ? value : unwrapList(value)
        for (const raw of list) {
          if (raw === null || typeof raw !== 'object') continue
          if (version === '2') {
            const agent = v2Agent(raw)
            if (agent.id === undefined) continue
            agent.server = server.id
            rows.push(agent)
            continue
          }
          if (typeof raw.name !== 'string' || raw.name === '') continue
          rows.push({
            server: server.id,
            id: raw.name,
            name: raw.name,
            mode: typeof raw.mode === 'string' ? raw.mode : null,
            native: raw.native === true,
            hidden: false,
            description: typeof raw.description === 'string' ? raw.description : null,
          })
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
    if (apiVersionOf(server) !== '2') return agent
    return opencodeValue(server, withLocation('/agent', server.directory), { timeoutMs: 8000 }).then(function (value) {
    const list = unwrapList(value)
    const lower = agent.toLowerCase()
    const match = list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.id === agent }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.name === agent }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && String(candidate.name).toLowerCase() === lower }) ||
      list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && String(candidate.id).toLowerCase() === lower })
      return match === undefined || match === null ? agent : match.id
    }, function () { return agent })
  })
}

/** Directory a session belongs to (v2 reads it from the session, v1 from config). */
export function sessionDirectory(server, sessionId, fallback) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') return fallback
    return opencodeValue(server, '/session/' + encodeURIComponent(sessionId), { timeoutMs: 8000 }).then(function (session) {
      const location = session !== null && typeof session === 'object' && session.location !== null && typeof session.location === 'object' ? session.location : null
      if (location !== null && typeof location.directory === 'string' && location.directory !== '') return location.directory
      return fallback
    }, function () { return fallback })
  })
}
/** One-line readable description of a pending permission request. */
function describePermission(request) {
  if (request === null || typeof request !== 'object') return 'permission'
  const action = typeof request.permission === 'string' && request.permission !== ''
    ? request.permission
    : (typeof request.action === 'string' && request.action !== '' ? request.action : 'permission')
  const raw = Array.isArray(request.patterns) ? request.patterns : (Array.isArray(request.resources) ? request.resources : [])
  const detail = raw.filter(function (item) { return typeof item === 'string' }).join(', ')
  return detail === '' ? action : action + ' (' + detail.slice(0, 120) + ')'
}

/** One-line readable description of a pending question/form. */
function describeQuestion(request) {
  if (request === null || typeof request !== 'object') return 'form'
  const questions = Array.isArray(request.questions) ? request.questions : []
  const first = questions.find(function (item) { return item !== null && typeof item === 'object' && typeof item.text === 'string' && item.text !== '' })
  if (first !== undefined) return 'form: ' + first.text.slice(0, 120)
  if (typeof request.title === 'string' && request.title !== '') return 'form: ' + request.title.slice(0, 120)
  return 'form'
}

function pendingEntry(kind, request, sessionId, fallbackAt) {
  const requestId = typeof request.id === 'string' ? request.id : (typeof request.requestID === 'string' ? request.requestID : undefined)
  if (requestId === undefined) return undefined
  const at = request !== null && typeof request === 'object' && request.time !== null && typeof request.time === 'object' && typeof request.time.created === 'number' ? request.time.created : fallbackAt
  return {
    sessionId: sessionId,
    kind: kind,
    requestId: requestId,
    detail: kind === 'form' ? describeQuestion(request) : describePermission(request),
    at: at,
  }
}

/** One location-scoped v2 pending list; `unsupported` marks an endpoint an older build lacks. */
function awaitGlobal(server, target, at) {
  return opencodeValue(server, target.path, { timeoutMs: 5000 }).then(function (value) {
    const entries = []
    for (const item of unwrapList(value)) {
      const form = target.kind === 'form' && item !== null && typeof item === 'object' && item.form !== undefined ? item.form : item
      const sessionId = item !== null && typeof item === 'object'
        ? (typeof item.sessionID === 'string' ? item.sessionID : (form !== item && typeof form.sessionID === 'string' ? form.sessionID : undefined))
        : undefined
      const entry = pendingEntry(target.kind, form, sessionId, at)
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
    if (apiVersionOf(server) !== '2') {
      return Promise.all([
        opencodeRequest(server, '/permission', { timeoutMs: 5000 }).then(function (result) {
          const list = result !== undefined && Array.isArray(result.value) ? result.value : []
          return list.map(function (request) { return pendingEntry('permission', request, request === null || typeof request !== 'object' ? undefined : request.sessionID, at) }).filter(Boolean)
        }, function () { return [] }),
        opencodeRequest(server, '/question', { timeoutMs: 5000 }).then(function (result) {
          const list = result !== undefined && Array.isArray(result.value) ? result.value : []
          return list.map(function (request) { return pendingEntry('form', request, request === null || typeof request !== 'object' ? undefined : request.sessionID, at) }).filter(Boolean)
        }, function () { return [] }),
      ]).then(function (parts) { return parts[0].concat(parts[1]) })
    }
    // v2 exposes location-scoped global lists (`/api/permission/request`, `/api/form`);
    // older builds only answer per session, so keep that as a fallback.
    const globalTargets = [
      { path: '/permission/request', kind: 'permission' },
      { path: '/form', kind: 'form' },
    ]
    const results = []
    for (const target of globalTargets) {
      results.push(awaitGlobal(server, target, at))
    }
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
    tools: { calls: number(totals.calls), succeeded: number(totals.succeeded), failed: number(totals.failed) },
    activeDays: number(payload.activeDays),
    streak: number(payload.streak),
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
  // Cache keyed by the range start, bucketed, and *not* by `to` (which moves with
  // every request). Callers derive `from` from `Date.now()` too (the board's 7-day
  // window), so an exact key would miss on every poll; the bucket plus a TTL longer
  // than the poll interval is what makes repeated polls reuse one history scan.
  // `from: 0` means "all history" and gets its own key so it cannot collide.
  const cacheKey = from === 0 ? 'all' : String(Math.floor(from / STATS_BUCKET_MS))
  server.statsCache = server.statsCache instanceof Map ? server.statsCache : new Map()
  const cached = server.statsCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < STATS_TTL_MS) return Promise.resolve(cached.value)
  if (server.statsCache.size > 32) server.statsCache.clear()
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') return { supported: false }
    const query = '?from=' + from + '&to=' + to + '&tools=summary'
    return opencodeValue(server, '/experimental/session/stats' + query, { timeoutMs: 20000 }).then(function (value) {
      const payload = value !== null && typeof value === 'object' && value.data !== undefined ? value.data : value
      const result = { supported: true, range: { from: from, to: to }, ...summarizeStats(payload) }
      server.statsCache.set(cacheKey, { at: Date.now(), value: result })
      return result
    }, function (error) {
      return { supported: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
    })
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
    if (apiVersionOf(server) !== '2') return { supported: false, ok: false }
    if (typeof idle !== 'number' || !Number.isFinite(idle) || idle <= 0) return { supported: true, ok: false, error: 'idle required' }
    return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/view', {
      method: 'POST',
      body: { idle: Math.floor(idle) },
      timeoutMs: 8000,
    }).then(function () {
      return { supported: true, ok: true }
    }, function (error) {
      return { supported: true, ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
    })
  })
}
