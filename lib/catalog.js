/** Read-only OpenCode catalogs (models, commands, skills, tools, references) and command execution. */
import { opencodeRequest } from './http.js'
import { extractAssistant } from './delegate.js'

/** Providers/models without credentials: only id/name/source and model ids/names are surfaced. */
export function collectModels(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/config/providers', { timeoutMs: 10000 }).then(function (result) {
        const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
        const providers = Array.isArray(value.providers) ? value.providers : []
        const defaults = value.default !== null && typeof value.default === 'object' ? value.default : {}
        for (const provider of providers) {
          if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
          const models = provider.models !== null && typeof provider.models === 'object' ? provider.models : {}
          const modelRows = Object.keys(models).map(function (id) {
            const model = models[id] !== null && typeof models[id] === 'object' ? models[id] : {}
            return { id: typeof model.id === 'string' ? model.id : id, name: typeof model.name === 'string' ? model.name : id }
          })
          rows.push({
            server: server.id,
            provider: provider.id,
            name: typeof provider.name === 'string' ? provider.name : provider.id,
            source: typeof provider.source === 'string' ? provider.source : null,
            defaultModel: typeof defaults[provider.id] === 'string' ? defaults[provider.id] : null,
            models: modelRows,
          })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.provider.localeCompare(b.provider) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + row.provider + ' (' + row.name + ')' + (row.defaultModel === null ? '' : ' default=' + row.defaultModel) + ' models: ' + row.models.map(function (model) { return model.id }).join(', ')
    })
    return { count: rows.length, text: lines.length === 0 ? 'no providers' : lines.join('\n') }
  })
}

export function collectCommands(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/command', { timeoutMs: 8000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const command of list) {
          if (command === null || typeof command !== 'object' || typeof command.name !== 'string') continue
          rows.push({
            server: server.id,
            name: command.name,
            description: typeof command.description === 'string' ? command.description : null,
            source: typeof command.source === 'string' ? command.source : null,
            agent: typeof command.agent === 'string' ? command.agent : null,
            model: typeof command.model === 'string' ? command.model : null,
            subtask: command.subtask === true,
          })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      const meta = [row.agent === null ? null : 'agent=' + row.agent, row.model === null ? null : 'model=' + row.model, row.subtask ? 'subtask' : null, row.source].filter(function (piece) { return piece !== null })
      return '- [' + row.server + '] /' + row.name + (row.description === null ? '' : ' — ' + row.description) + (meta.length === 0 ? '' : ' (' + meta.join(', ') + ')')
    })
    return { count: rows.length, text: lines.length === 0 ? 'no commands' : lines.join('\n') }
  })
}

export function collectSkills(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/skill', { timeoutMs: 8000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const skill of list) {
          if (skill === null || typeof skill !== 'object' || typeof skill.name !== 'string') continue
          rows.push({
            server: server.id,
            name: skill.name,
            description: typeof skill.description === 'string' ? skill.description : null,
            location: typeof skill.location === 'string' ? skill.location : null,
          })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + row.name + (row.description === null ? '' : ' — ' + row.description) + (row.location === null ? '' : ' (' + row.location + ')')
    })
    return { count: rows.length, text: lines.length === 0 ? 'no skills' : lines.join('\n') }
  })
}

export function collectToolIds(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/experimental/tool/ids', { timeoutMs: 8000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        rows.push({ server: server.id, ids: list.filter(function (id) { return typeof id === 'string' }) })
      }, function () {})
    })
  }
  return chain.then(function () {
    const lines = rows.map(function (row) { return '- [' + row.server + '] ' + (row.ids.length === 0 ? '(none)' : row.ids.join(', ')) })
    return { count: rows.length, text: lines.length === 0 ? 'no tools' : lines.join('\n') }
  })
}

export function collectReferences(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/api/reference', { timeoutMs: 8000 }).then(function (result) {
        const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
        const data = Array.isArray(value.data) ? value.data : []
        for (const item of data) {
          if (item === null || typeof item !== 'object') continue
          rows.push({
            server: server.id,
            name: typeof item.name === 'string' ? item.name : (typeof item.alias === 'string' ? item.alias : null),
            description: typeof item.description === 'string' ? item.description : null,
            path: typeof item.path === 'string' ? item.path : null,
          })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + (row.name === null ? '(unnamed)' : row.name) + (row.description === null ? '' : ' — ' + row.description) + (row.path === null ? '' : ' (' + row.path + ')')
    })
    return { count: rows.length, text: lines.length === 0 ? 'no references' : lines.join('\n') }
  })
}

/** Session search via the v2 API (falls back to v1 listing + title filter). */
export function collectSessionSearch(servers, serverId, query, limit, directory) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      const params = ['search=' + encodeURIComponent(query), 'limit=' + String(limit)]
      if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
      function fallback() {
        return opencodeRequest(server, '/session?search=' + encodeURIComponent(query), { timeoutMs: 10000 }).then(function (result) {
          const list = result !== undefined && Array.isArray(result.value) ? result.value : []
          for (const session of list) {
            if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
            const title = typeof session.title === 'string' ? session.title : ''
            if (title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
            rows.push({
              server: server.id,
              id: session.id,
              title: title === '' ? '(untitled)' : title,
              directory: typeof session.directory === 'string' ? session.directory : null,
              updatedAt: session.time !== null && typeof session.time === 'object' && typeof session.time.updated === 'number' ? session.time.updated : null,
            })
          }
        }, function () {})
      }
      return opencodeRequest(server, '/api/session?' + params.join('&'), { timeoutMs: 15000 }).then(function (result) {
        const value = result !== undefined ? result.value : undefined
        const list = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : null
        if (list === null) return fallback()
        for (const session of list) {
          if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
          const location = session.location !== null && typeof session.location === 'object' ? session.location : {}
          rows.push({
            server: server.id,
            id: session.id,
            title: typeof session.title === 'string' ? session.title : '(untitled)',
            directory: typeof location.directory === 'string' ? location.directory : null,
            updatedAt: session.time !== null && typeof session.time === 'object' && typeof session.time.updated === 'number' ? session.time.updated : null,
          })
        }
      }, function () { return fallback() }).then(function () {
        rows.sort(function (a, b) { return (b.updatedAt === null ? 0 : b.updatedAt) - (a.updatedAt === null ? 0 : a.updatedAt) })
      })
    })
  }
  return chain.then(function () {
    const lines = rows.map(function (row) {
      const when = row.updatedAt === null ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' | '
      return '- [' + row.server + '] ' + (row.directory === null ? '' : row.directory + ' | ') + row.title + ' | ' + when + row.id
    })
    return { count: rows.length, rows: rows, text: lines.length === 0 ? 'no matching sessions' : lines.join('\n') }
  })
}

/** Read-only MCP server status. */
export function collectMcpStatus(servers, serverId) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return opencodeRequest(server, '/mcp', { timeoutMs: 10000 }).then(function (result) {
        const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
        for (const name of Object.keys(value)) {
          const entry = value[name] !== null && typeof value[name] === 'object' ? value[name] : {}
          rows.push({ server: server.id, name: name, status: typeof entry.status === 'string' ? entry.status : 'unknown' })
        }
      }, function () {})
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) { return '- [' + row.server + '] ' + row.name + ': ' + row.status })
    return { count: rows.length, text: lines.length === 0 ? 'no MCP servers' : lines.join('\n') }
  })
}

/** Execute one OpenCode command inside an existing session. */
export function runCommand(server, sessionId, command, args, directory) {
  return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/command', {
    method: 'POST',
    body: args === undefined || args === '' ? { command: command } : { command: command, arguments: args },
    directory: directory,
    timeoutMs: 900000,
  }).then(function (reply) {
    if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
      throw new Error('opencode: command failed on ' + server.id + ' session ' + sessionId + (reply === undefined ? '' : ' (status ' + String(reply.status) + ')'))
    }
    const outcome = extractAssistant(reply.value)
    return { sessionId: sessionId, text: outcome.text === '' ? '(command returned no text)' : outcome.text }
  })
}
