/** Read-only OpenCode session discovery, messages, metadata and status. */
import { opencodeRequest } from './http.js'

export function summarizeSession(session) {
  const time = session !== null && typeof session === 'object' && session.time !== null && typeof session.time === 'object' ? session.time : undefined
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title !== '' ? session.title : (typeof session.slug === 'string' ? session.slug : session.id),
    directory: typeof session.directory === 'string' ? session.directory : null,
    updatedAt: time !== undefined && typeof time.updated === 'number' ? time.updated : null,
  }
}

/** Health + projects + sessions of one server, grouped by directory. */
export function collectServer(server) {
  if (server.snapshot !== undefined && Date.now() - server.snapshot.at < 10000) {
    return Promise.resolve(server.snapshot.value)
  }
  return Promise.all([
    opencodeRequest(server, '/global/health'),
    opencodeRequest(server, '/project'),
    opencodeRequest(server, '/session'),
  ]).then(function (results) {
    const health = results[0] !== undefined && results[0].value !== undefined ? results[0].value : undefined
    const projects = results[1] !== undefined && Array.isArray(results[1].value) ? results[1].value : []
    const sessions = results[2] !== undefined && Array.isArray(results[2].value) ? results[2].value : []
    const projectById = new Map(projects.map(function (project) { return [project.id, project] }))
    const groups = new Map()
    function realWorktree(project) {
      return project !== undefined && typeof project.worktree === 'string' && project.worktree !== '' && project.worktree !== '/'
    }
    for (const project of projects) {
      if (realWorktree(project)) groups.set(project.id, { id: project.id, worktree: project.worktree, sessions: [] })
    }
    for (const session of sessions) {
      const summary = summarizeSession(session)
      const projectId = typeof session.projectID === 'string' ? session.projectID : ''
      const project = projectById.get(projectId)
      let group
      if (realWorktree(project)) {
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
    const value = {
      state: health !== undefined && health.healthy === true ? 'online' : 'offline',
      version: health !== undefined && typeof health.version === 'string' ? health.version : null,
      projects: ordered,
    }
    server.snapshot = { at: Date.now(), value: value }
    return value
  })
}

export function collectSessionRows(servers, serverId, directory, query, limit) {
  const wanted = typeof serverId === 'string' && serverId !== '' ? serverId : undefined
  const rows = []
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
            rows.push({ server: server.id, serverState: snapshot.state, directory: sessionDirectory, title: session.title, updatedAt: session.updatedAt, id: session.id })
          }
        }
        return rows
      }, function () { return rows })
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0) })
    const capped = limit !== undefined && limit > 0 ? rows.slice(0, limit) : rows
    const lines = capped.map(function (row) {
      const when = row.updatedAt === null || row.updatedAt === undefined ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
      return '- [' + row.server + '] ' + (row.directory === '' ? '(no dir)' : row.directory) + ' | ' + row.title + (when === '' ? '' : ' | ' + when) + ' | ' + row.id
    })
    return { count: rows.length, shown: capped.length, text: lines.length === 0 ? 'no matching opencode sessions' : lines.join('\n') }
  })
}

/** Last N messages with text, tool and file parts flattened. */
export function readMessages(server, sessionId, limit) {
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/message', { timeoutMs: 20000 }).then(function (result) {
    if (result === undefined || result.status !== 200 || !Array.isArray(result.value)) {
      throw new Error('opencode: cannot read messages of ' + server.id + '/' + sessionId)
    }
    const messages = result.value
    const picked = limit !== undefined && limit > 0 ? messages.slice(-limit) : messages
    return picked.map(function (entry) {
      const info = entry !== null && typeof entry === 'object' && entry.info !== null && typeof entry.info === 'object' ? entry.info : {}
      const parts = Array.isArray(entry.parts) ? entry.parts : []
      const text = parts.filter(function (part) {
        return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
      }).map(function (part) { return part.text }).join('\n').trim()
      const toolLines = parts.filter(function (part) {
        return part !== null && typeof part === 'object' && part.type === 'tool'
      }).map(function (part) {
        const state = part.state !== null && typeof part.state === 'object' ? part.state : {}
        const status = typeof state.status === 'string' ? state.status : ''
        return '[tool] ' + (typeof part.tool === 'string' ? part.tool : 'tool') + (status === '' ? '' : ': ' + status)
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
    })
  })
}

/** Title/summary/todos/diff of one session. */
export function collectSessionInfo(server, sessionId) {
  return Promise.all([
    opencodeRequest(server, '/session/' + encodeURIComponent(sessionId), { timeoutMs: 8000 }),
    opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/todo', { timeoutMs: 8000 }),
    opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/diff', { timeoutMs: 8000 }),
  ]).then(function (results) {
    const session = results[0] !== undefined && results[0].value !== null && typeof results[0].value === 'object' ? results[0].value : {}
    const todos = results[1] !== undefined && Array.isArray(results[1].value) ? results[1].value : []
    const diffs = results[2] !== undefined && Array.isArray(results[2].value) ? results[2].value : []
    return { session: session, todos: todos, diffs: diffs }
  })
}

export function shareSession(server, sessionId, action) {
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
}

/** Authoritative running states from GET /session/status (cached 5s). */
export function abortSession(server, sessionId) {
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/abort', { method: 'POST', body: {}, timeoutMs: 15000 }).then(function (result) {
    if (result === undefined || result.status !== 200) {
      throw new Error('opencode: abort failed on ' + server.id + ' session ' + sessionId + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
    }
    if (!(server.abortedSessions instanceof Set)) server.abortedSessions = new Set()
    server.abortedSessions.add(sessionId)
    if (server.progress instanceof Map) server.progress.delete(sessionId)
    return result.value !== false
  })
}

export function collectStatus(server) {
  if (server.statusSnapshot !== undefined && Date.now() - server.statusSnapshot.at < 5000) {
    return Promise.resolve(server.statusSnapshot.value)
  }
  return opencodeRequest(server, '/session/status', { timeoutMs: 5000 }).then(function (result) {
    const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
    server.statusSnapshot = { at: Date.now(), value: value }
    return value
  }, function () { return {} })
}

/** Agents advertised by each server (primary + subagent, native/custom). */
export function collectAgents(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/agent', { timeoutMs: 8000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const agent of list) {
          if (agent === null || typeof agent !== 'object' || typeof agent.name !== 'string') continue
          rows.push({
            server: server.id,
            name: agent.name,
            mode: typeof agent.mode === 'string' ? agent.mode : null,
            native: agent.native === true,
            description: typeof agent.description === 'string' ? agent.description : null,
          })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const text = rows.length === 0 ? 'no agents' : rows.map(function (row) {
      return '- [' + row.server + '] ' + row.name + ' (' + (row.mode === null ? '?' : row.mode) + (row.native ? ', native' : '') + ')' + (row.description === null ? '' : ' — ' + row.description)
    }).join('\n')
    return { count: rows.length, text: text }
  })
}
