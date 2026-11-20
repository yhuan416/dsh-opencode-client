/**
 * Read-only OpenCode catalogs (models, commands, skills, tools, references) and
 * command execution.
 *
 * v1: bare arrays from `/config/providers`, `/command`, `/skill`, ...
 * v2: `/api/*` with `{location,data}` envelopes; providers and models are
 * separate endpoints, commands only keep name/description, skills expose
 * `path` (and inline content, which is deliberately not surfaced), tool ids
 * were removed and the model ref uses `id` instead of `modelID`.
 */
import { opencodeRequest, opencodeValue, ensureApiVersion, unwrapList, withLocation, apiVersionOf } from './http.js'
import { captureTurnBaseline, waitAssistant } from './delegate.js'

function cleanModelName(model, fallback) {
  return typeof model.name === 'string' && model.name !== '' ? model.name : fallback
}

/** Providers/models without credentials: only ids and display names are surfaced. */
export function collectModels(servers, serverId) {
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () {
        if (apiVersionOf(server) !== '2') {
          return collectV1Models(server).then(function (v1rows) {
            for (const row of v1rows) rows.push(row)
          })
        }
        const scope = server.directory
        return Promise.all([
          opencodeValue(server, withLocation('/provider', scope), { timeoutMs: 10000 }),
          opencodeValue(server, withLocation('/model', scope), { timeoutMs: 15000 }).catch(function () { return [] }),
          opencodeValue(server, withLocation('/model/default', scope), { timeoutMs: 8000 }).catch(function () { return undefined }),
        ]).then(function (results) {
          const providers = unwrapList(results[0])
          const models = unwrapList(results[1])
          const defaultModel = results[2] !== null && typeof results[2] === 'object' && typeof results[2].id === 'string' ? results[2] : undefined
          for (const provider of providers) {
            if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
            const modelRows = models.filter(function (model) {
              return model !== null && typeof model === 'object' && model.providerID === provider.id && model.enabled !== false
            }).map(function (model) {
              const variants = Array.isArray(model.variants)
                ? model.variants.map(function (variant) {
                  return variant !== null && typeof variant === 'object' && typeof variant.id === 'string' ? variant.id : undefined
                }).filter(function (id) { return id !== undefined })
                : []
              return {
                id: typeof model.id === 'string' ? model.id : String(model.modelID),
                name: cleanModelName(model, String(model.id)),
                variants: variants,
              }
            })
            rows.push({
              server: server.id,
              provider: provider.id,
              name: cleanModelName(provider, provider.id),
              source: typeof provider.activation === 'string' ? provider.activation : null,
              defaultModel: defaultModel !== undefined && defaultModel.providerID === provider.id ? defaultModel.id : null,
              models: modelRows,
            })
          }
        })
      }).catch(function (error) {
        errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
      })
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.provider.localeCompare(b.provider) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + row.provider + ' (' + row.name + ')' + (row.defaultModel === null ? '' : ' default=' + row.defaultModel) + ' models: ' + row.models.map(function (model) {
        const variants = Array.isArray(model.variants) && model.variants.length > 0 ? '{' + model.variants.join('|') + '}' : ''
        return model.id + variants
      }).join(', ')
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no providers' : lines.join('\n'), errors: errors }
  })
}

function collectV1Models(server) {
  return opencodeRequest(server, '/config/providers', { timeoutMs: 10000 }).then(function (result) {
    const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
    const providers = Array.isArray(value.providers) ? value.providers : []
    const defaults = value.default !== null && typeof value.default === 'object' ? value.default : {}
    const rows = []
    for (const provider of providers) {
      if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
      const models = provider.models !== null && typeof provider.models === 'object' ? provider.models : {}
      const modelRows = Object.keys(models).map(function (id) {
        const model = models[id] !== null && typeof models[id] === 'object' ? models[id] : {}
        return { id: typeof model.id === 'string' ? model.id : id, name: cleanModelName(model, id) }
      })
      rows.push({
        server: server.id,
        provider: provider.id,
        name: cleanModelName(provider, provider.id),
        source: typeof provider.source === 'string' ? provider.source : null,
        defaultModel: typeof defaults[provider.id] === 'string' ? defaults[provider.id] : null,
        models: modelRows,
      })
    }
    return rows
  })
}

function catalogRows(servers, serverId, load, mapRow, errors) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () { return load(server) }).then(function (list) {
        for (const item of list) {
          const row = mapRow(server, item)
          if (row !== undefined) rows.push(row)
        }
      }, function (error) {
        if (Array.isArray(errors)) errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
      })
    })
  }
  return chain.then(function () { return rows })
}

function v2List(server, path) {
  return opencodeValue(server, withLocation(path, server.directory), { timeoutMs: 8000 }).then(function (value) { return unwrapList(value) })
}

export function collectCommands(servers, serverId) {
  const errors = []
  return catalogRows(servers, serverId, function (server) {
    if (apiVersionOf(server) !== '2') {
      return opencodeRequest(server, '/command', { timeoutMs: 8000 }).then(function (result) { return result !== undefined && Array.isArray(result.value) ? result.value : [] })
    }
    return v2List(server, '/command')
  }, function (server, command) {
    if (command === null || typeof command !== 'object' || typeof command.name !== 'string') return undefined
    return {
      server: server.id,
      name: command.name,
      description: typeof command.description === 'string' ? command.description : null,
      source: typeof command.source === 'string' ? command.source : null,
      agent: typeof command.agent === 'string' ? command.agent : null,
      model: typeof command.model === 'string' ? command.model : null,
      subtask: command.subtask === true,
    }
  }, errors).then(function (rows) {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      const meta = [row.agent === null ? null : 'agent=' + row.agent, row.model === null ? null : 'model=' + row.model, row.subtask ? 'subtask' : null, row.source].filter(function (piece) { return piece !== null })
      return '- [' + row.server + '] /' + row.name + (row.description === null ? '' : ' — ' + row.description) + (meta.length === 0 ? '' : ' (' + meta.join(', ') + ')')
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no commands' : lines.join('\n') }
  })
}

export function collectSkills(servers, serverId) {
  const errors = []
  return catalogRows(servers, serverId, function (server) {
    if (apiVersionOf(server) !== '2') {
      return opencodeRequest(server, '/skill', { timeoutMs: 8000 }).then(function (result) { return result !== undefined && Array.isArray(result.value) ? result.value : [] })
    }
    return v2List(server, '/skill')
  }, function (server, skill) {
    if (skill === null || typeof skill !== 'object' || typeof skill.name !== 'string') return undefined
    const location = typeof skill.path === 'string' ? skill.path : (typeof skill.location === 'string' ? skill.location : null)
    return {
      server: server.id,
      name: skill.name,
      description: typeof skill.description === 'string' ? skill.description : null,
      location: location,
    }
  }, errors).then(function (rows) {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + row.name + (row.description === null ? '' : ' — ' + row.description) + (row.location === null ? '' : ' (' + row.location + ')')
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no skills' : lines.join('\n') }
  })
}

/** Tool ids exist only on v1; v2 removed `/experimental/tool/ids` without a replacement. */
export function collectToolIds(servers, serverId) {
  const rows = []
  const notes = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () {
        if (apiVersionOf(server) === '2') {
          notes.push('- [' + server.id + '] not available on OpenCode 2 (the v1 /experimental/tool/ids endpoint was removed)')
          return
        }
        return opencodeRequest(server, '/experimental/tool/ids', { timeoutMs: 8000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
          rows.push({ server: server.id, ids: list.filter(function (id) { return typeof id === 'string' }) })
        }, function () {})
      })
    })
  }
  return chain.then(function () {
    const lines = rows.map(function (row) { return '- [' + row.server + '] ' + (row.ids.length === 0 ? '(none)' : row.ids.join(', ')) }).concat(notes)
    return { count: rows.length, text: lines.length === 0 ? 'no tools' : lines.join('\n') }
  })
}

export function collectReferences(servers, serverId) {
  const errors = []
  return catalogRows(servers, serverId, function (server) {
    const target = apiVersionOf(server) === '2' ? withLocation('/reference', server.directory) : '/api/reference'
    return opencodeValue(server, target, { timeoutMs: 8000 }).then(function (value) {
      return Array.isArray(value) ? value : unwrapList(value)
    })
  }, function (server, item) {
    if (item === null || typeof item !== 'object') return undefined
    return {
      server: server.id,
      name: typeof item.name === 'string' ? item.name : (typeof item.alias === 'string' ? item.alias : null),
      description: typeof item.description === 'string' ? item.description : null,
      path: typeof item.path === 'string' ? item.path : (typeof item.location === 'string' ? item.location : null),
    }
  }, errors).then(function (rows) {
    const lines = rows.map(function (row) {
      return '- [' + row.server + '] ' + (row.name === null ? '(unnamed)' : row.name) + (row.description === null ? '' : ' — ' + row.description) + (row.path === null ? '' : ' (' + row.path + ')')
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no references' : lines.join('\n') }
  })
}

/** Session search via the list endpoint's `search` filter (v1 falls back to title filtering). */
export function collectSessionSearch(servers, serverId, query, limit, directory) {
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () {
        const version = apiVersionOf(server)
        const params = ['search=' + encodeURIComponent(query), 'limit=' + String(limit)]
        if (typeof directory === 'string' && directory !== '') params.push('directory=' + encodeURIComponent(directory))
        const target = version === '2'
          ? '/session?' + params.join('&')
          : '/session?search=' + encodeURIComponent(query)
        return opencodeRequest(server, target, { timeoutMs: 15000 }).then(function (result) {
          const list = result !== undefined && Array.isArray(result.value) ? result.value : unwrapList(result === undefined ? undefined : result.value)
          for (const session of list) {
            if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
            const title = typeof session.title === 'string' ? session.title : ''
            if (version !== '2' && title.toLowerCase().indexOf(query.toLowerCase()) < 0) continue
            const summary = {
              server: server.id,
              id: session.id,
              title: title === '' ? '(untitled)' : title,
              directory: null,
              updatedAt: session.time !== null && typeof session.time === 'object' && typeof session.time.updated === 'number' ? session.time.updated : null,
            }
            const location = session.location !== null && typeof session.location === 'object' ? session.location : undefined
            if (location !== undefined && typeof location.directory === 'string') summary.directory = location.directory
            else if (typeof session.directory === 'string') summary.directory = session.directory
            if (typeof directory === 'string' && directory !== '' && summary.directory !== null && !summary.directory.startsWith(directory)) continue
            rows.push(summary)
          }
        })
      }).catch(function (error) {
        errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
      }).then(function () {
        rows.sort(function (a, b) { return (b.updatedAt === null ? 0 : b.updatedAt) - (a.updatedAt === null ? 0 : a.updatedAt) })
      })
    })
  }
  return chain.then(function () {
    const lines = rows.map(function (row) {
      const when = row.updatedAt === null ? '' : new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' | '
      return '- [' + row.server + '] ' + (row.directory === null ? '' : row.directory + ' | ') + row.title + ' | ' + when + row.id
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, rows: rows, text: lines.length === 0 ? 'no matching sessions' : lines.join('\n') }
  })
}

/** Read-only MCP server status (`status` is a string on v1, an object on v2). */
export function collectMcpStatus(servers, serverId) {
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ensureApiVersion(server).then(function () {
        if (apiVersionOf(server) !== '2') return null
        return v2List(server, '/mcp').then(function (list) {
          for (const entry of list) {
            if (entry === null || typeof entry !== 'object') continue
            const status = entry.status !== null && typeof entry.status === 'object' && typeof entry.status.status === 'string'
              ? entry.status.status
              : (typeof entry.status === 'string' ? entry.status : 'unknown')
            const error = entry.status !== null && typeof entry.status === 'object' && typeof entry.status.error === 'string' ? entry.status.error : null
            rows.push({ server: server.id, name: typeof entry.name === 'string' ? entry.name : '?', status: status, error: error })
          }
          return rows
        })
      }).then(function () {
        if (apiVersionOf(server) === '2') return rows
        return opencodeRequest(server, '/mcp', { timeoutMs: 10000 }).then(function (result) {
          const value = result !== undefined && result.value !== null && typeof result.value === 'object' ? result.value : {}
          for (const name of Object.keys(value)) {
            const entry = value[name] !== null && typeof value[name] === 'object' ? value[name] : {}
            rows.push({ server: server.id, name: name, status: typeof entry.status === 'string' ? entry.status : 'unknown', error: null })
          }
          return rows
        })
      }).catch(function (error) {
        errors.push({ server: server.id, message: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
      })
    })
  }
  return chain.then(function () {
    rows.sort(function (a, b) { return a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server) })
    const lines = rows.map(function (row) { return '- [' + row.server + '] ' + row.name + ': ' + row.status + (row.error === null ? '' : ' (' + row.error + ')') })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no MCP servers' : lines.join('\n') }
  })
}

/**
 * Execute one OpenCode command inside an existing session.
 * v1 answers synchronously with the assistant message; v2 answers 204 and runs
 * asynchronously, so the turn is awaited before the last assistant text is read.
 */
export function runCommand(server, sessionId, command, args, directory) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/command', {
        method: 'POST',
        body: args === undefined || args === '' ? { command: command } : { command: command, arguments: args },
        directory: directory,
        timeoutMs: 900000,
      }).then(function (reply) {
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          throw new Error('opencode: command failed on ' + server.id + ' session ' + sessionId + (reply === undefined ? '' : ' (status ' + String(reply.status) + ')'))
        }
        const outcome = extractAssistantText(reply.value)
        return { sessionId: sessionId, text: outcome === '' ? '(command returned no text)' : outcome }
      })
    }
    return captureTurnBaseline(server, sessionId).then(function (baseline) {
      const body = { name: command }
      if (typeof args === 'string') body.text = args
      return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/command', {
        method: 'POST',
        body: body,
        timeoutMs: 20000,
      }).then(function (accepted) {
        if (accepted === undefined || (accepted.status !== 204 && accepted.status !== 200)) {
          throw new Error('opencode: command failed on ' + server.id + ' session ' + sessionId + ' (status ' + (accepted === undefined ? 'none' : String(accepted.status)) + ')')
        }
        return waitAssistant(server, sessionId, directory, undefined, 900000, undefined, baseline)
      }).then(function (outcome) {
        const text = outcome !== undefined && typeof outcome.text === 'string' ? outcome.text : ''
        return { sessionId: sessionId, text: text === '' ? '(command returned no text)' : text }
      })
    })
  })
}

/** Minimal assistant-text extraction for the synchronous v1 command reply. */
function extractAssistantText(value) {
  const parts = value !== null && typeof value === 'object' && Array.isArray(value.parts) ? value.parts : []
  const texts = parts.filter(function (part) {
    return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
  }).map(function (part) { return part.text })
  if (texts.length > 0) return texts.join('\n').trim()
  if (value !== null && typeof value === 'object' && Array.isArray(value.content)) {
    return value.content.filter(function (part) {
      return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    }).map(function (part) { return part.text }).join('\n').trim()
  }
  return ''
}