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
import { unwrapList } from './http.js'
import { ocCall } from './oc-client.js'
import { captureTurnBaseline, waitAssistant } from './delegate.js'

function cleanModelName(model, fallback) {
  return typeof model.name === 'string' && model.name !== '' ? model.name : fallback
}

/** Providers/models without credentials: only ids and display names are surfaced. */
/** Compact token counts for model listings (1000000 -> 1M). */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '?'
  if (value >= 1000000) return String(Math.round(value / 100000) / 10) + 'M'
  if (value >= 1000) return String(Math.round(value / 100) / 10) + 'k'
  return String(value)
}

export function collectModels(servers, serverId) {
  const rows = []
  const errors = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return ocCall(server, function (client, requestOptions) {
        const location = server.directory === undefined ? undefined : { directory: server.directory }
        return Promise.all([
          client.provider.list({ location: location }, requestOptions),
          client.model.list({ location: location }, requestOptions).catch(function () { return { data: [] } }),
          client.model.default({ location: location }, requestOptions).catch(function () { return { data: null } }),
        ])
      }, 15000).then(function (results) {
          const providers = unwrapList(results[0])
          const models = unwrapList(results[1])
          const defaultData = results[2] !== null && typeof results[2] === 'object' && results[2].data !== undefined ? results[2].data : results[2]
          const defaultModel = defaultData !== null && typeof defaultData === 'object' && typeof defaultData.id === 'string' ? defaultData : undefined
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
              const limit = model.limit !== null && typeof model.limit === 'object' ? model.limit : {}
              return {
                id: typeof model.id === 'string' ? model.id : String(model.modelID),
                name: cleanModelName(model, String(model.id)),
                variants: variants,
                context: typeof limit.context === 'number' ? limit.context : undefined,
                maxOutput: typeof limit.output === 'number' ? limit.output : undefined,
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
        // Only OpenCode 2 reports token limits; show the context window when known.
        const context = typeof model.context === 'number' ? ' [ctx ' + formatTokens(model.context) + (typeof model.maxOutput === 'number' ? ', out ' + formatTokens(model.maxOutput) : '') + ']' : ''
        return model.id + variants + context
      }).join(', ')
    })
    for (const failure of errors) lines.push('- [' + failure.server + '] unavailable: ' + failure.message)
    return { count: rows.length, text: lines.length === 0 ? 'no providers' : lines.join('\n'), errors: errors }
  })
}

function catalogRows(servers, serverId, load, mapRow, errors) {
  const rows = []
  let chain = Promise.resolve()
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    chain = chain.then(function () {
      return load(server).then(function (list) {
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

function viaClient(server, run, timeoutMs) {
  return ocCall(server, run, timeoutMs === undefined ? 8000 : timeoutMs).then(function (value) { return unwrapList(value) })
}

export function collectCommands(servers, serverId) {
  const errors = []
  return catalogRows(servers, serverId, function (server) {
    return viaClient(server, function (client, requestOptions) {
      return client.command.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
    })
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
    return viaClient(server, function (client, requestOptions) {
      return client.skill.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
    })
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

/** Tool ids were removed from OpenCode 2 without a replacement. */
export function collectToolIds(servers, serverId) {
  const notes = []
  for (const server of servers) {
    if (typeof serverId === 'string' && serverId !== '' && server.id !== serverId) continue
    notes.push('- [' + server.id + '] not available on OpenCode 2 (the v1 /experimental/tool/ids endpoint was removed)')
  }
  return Promise.resolve({ count: 0, text: notes.length === 0 ? 'no tools' : notes.join('\n') })
}

export function collectReferences(servers, serverId) {
  const errors = []
  return catalogRows(servers, serverId, function (server) {
    return viaClient(server, function (client, requestOptions) {
      return client.reference.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
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
      return ocCall(server, function (client, requestOptions) {
        const input = { search: query, limit: limit }
        if (typeof directory === 'string' && directory !== '') input.directory = directory
        return client.session.list(input, requestOptions)
      }, 15000).then(function (result) {
          const list = unwrapList(result)
          for (const session of list) {
            if (session === null || typeof session !== 'object' || typeof session.id !== 'string') continue
            const title = typeof session.title === 'string' ? session.title : ''
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
      return viaClient(server, function (client, requestOptions) {
          return client.mcp.list({ location: server.directory === undefined ? undefined : { directory: server.directory } }, requestOptions)
        }).then(function (list) {
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
      .catch(function (error) {
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
 * OpenCode 2 answers 204 and runs asynchronously, so the turn is awaited before
 * the last assistant text is read.
 */
export function runCommand(server, sessionId, command, args, directory) {
    return captureTurnBaseline(server, sessionId).then(function (baseline) {
      return ocCall(server, function (client, requestOptions) {
        return client.session.command({ sessionID: sessionId, name: command, text: typeof args === 'string' ? args : '' }, requestOptions)
      }, 20000).then(function () {
        return waitAssistant(server, sessionId, directory, undefined, 900000, undefined, baseline)
      }).then(function (outcome) {
        const text = outcome !== undefined && typeof outcome.text === 'string' ? outcome.text : ''
        return { sessionId: sessionId, text: text === '' ? '(command returned no text)' : text }
      })
    })
}
