/** Host HTTP routes under /api/opencode-client/. */
import { jsonResponse, readJsonBody } from './http.js'
import { collectServer, collectSessionRows, readMessages, collectAgents, collectSessionInfo, shareSession, collectStatus, abortSession } from './sessions.js'
import { parseModel } from './config.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus } from './catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from './workspace.js'
import { forkSession, summarize, initSession, sessionChildren } from './manage.js'
import { promptBody } from './delegate.js'
import { sendSessionMessage } from './session-run.js'

export function createRoutes(deps) {
  const servers = deps.servers
  const delegate = deps.delegate
  const defaultServer = servers[0]

  function findServer(body) {
    return servers.find(function (candidate) { return candidate.id === String(body === undefined ? '' : body) }) || defaultServer
  }

  /** Normalize HTTP attachment input ({filename,mime,content|base64}) into data-URL parts. */
  function normalizeAttachments(raw) {
    if (!Array.isArray(raw)) return undefined
    const files = []
    for (const entry of raw.slice(0, 10)) {
      if (entry === null || typeof entry !== 'object') continue
      const base64 = typeof entry.base64 === 'string' ? entry.base64 : (typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8').toString('base64') : '')
      if (base64 === '' || base64.length > 7 * 1024 * 1024) continue
      files.push({
        filename: typeof entry.filename === 'string' ? entry.filename : 'attachment',
        mime: typeof entry.mime === 'string' ? entry.mime : 'application/octet-stream',
        base64: base64,
      })
    }
    return files.length === 0 ? undefined : files
  }

  /** Latest live tool/step name for a server, from the SSE progress map. */
  function activeToolOf(server) {
    if (!(server.progress instanceof Map)) return null
    let latest = null
    for (const progress of server.progress.values()) {
      if (progress === null || typeof progress !== 'object') continue
      if (progress.status === 'tool' && typeof progress.tool === 'string') return progress.tool
      if (progress.status === 'thinking') latest = latest === null ? 'thinking' : latest
    }
    return latest
  }

  const routes = [
    {
      path: '/api/opencode-client/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        let chain = Promise.resolve([])
        for (const server of servers) {
          chain = chain.then(function (rows) {
            return collectServer(server).then(function (value) {
              return collectStatus(server).then(function (statuses) {
                const runningIds = new Set(Object.keys(statuses).filter(function (sessionId) {
                  const status = statuses[sessionId]
                  return status !== null && typeof status === 'object' && status.type !== 'idle'
                }))
                if (server.progress instanceof Map) {
                  for (const entry of server.progress.entries()) {
                    const progress = entry[1]
                    if (progress !== null && typeof progress === 'object' && progress.status !== 'idle' && progress.status !== 'error') runningIds.add(entry[0])
                  }
                }
                const running = runningIds.size
                rows.push({
                  id: server.id,
                  label: server.label,
                  state: value.state,
                  version: value.version,
                  live: server.sse !== undefined && server.sse.state === 'open',
                  running: running,
                  activeTool: activeToolOf(server),
                  projects: value.projects,
                })
                return rows
              })
            }, function () {
              rows.push({ id: server.id, label: server.label, state: 'offline', version: null, live: server.sse !== undefined && server.sse.state === 'open', running: 0, projects: [] })
              return rows
            })
          })
        }
        return chain.then(function (rows) { return jsonResponse({ servers: rows }) })
      },
    },
    {
      path: '/api/opencode-client/sessions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null ? undefined : url.searchParams.get('server')
        const directory = url.searchParams.get('directory') === null ? undefined : url.searchParams.get('directory')
        const query = url.searchParams.get('query') === null ? undefined : url.searchParams.get('query')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        return collectSessionRows(servers, server, directory, query, limit).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, shown: result.shown, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/messages',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = servers.find(function (candidate) { return candidate.id === String(url.searchParams.get('server') === null ? '' : url.searchParams.get('server')) })
        const sessionId = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || sessionId === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        const rawLimit = Number(url.searchParams.get('limit') === null ? '20' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20
        return readMessages(server, sessionId, limit).then(function (messages) {
          return jsonResponse({ ok: true, server: server.id, session: sessionId, messages: messages })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/fork',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          const message = typeof body.message === 'string' && body.message !== '' ? body.message : undefined
          return forkSession(server, session, message).then(function (created) {
            return jsonResponse({ ok: true, server: server.id, session: session, forked: created })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/summarize',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const model = parseModel(body.model)
          if (server === undefined || session === '' || model === undefined) return jsonResponse({ ok: false, error: 'server, session and model "provider/model" required' }, 400)
          return summarize(server, session, model.providerID, model.modelID).then(function (done) {
            return jsonResponse({ ok: true, server: server.id, session: session, summarized: done })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/init',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const model = parseModel(body.model)
          if (body.confirm !== true) return jsonResponse({ ok: false, error: 'init writes AGENTS.md; pass confirm:true to run' }, 400)
          if (server === undefined || session === '' || model === undefined) return jsonResponse({ ok: false, error: 'server, session and model "provider/model" required' }, 400)
          return initSession(server, session, model.providerID, model.modelID).then(function (done) {
            return jsonResponse({ ok: true, server: server.id, session: session, initialized: done })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/children',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const session = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || session === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        return sessionChildren(server, session).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, session: session, count: result.count, children: result.rows, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/shell',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const command = typeof body.command === 'string' ? body.command : ''
          if (server === undefined || session === '' || command === '') return jsonResponse({ ok: false, error: 'server, session and command required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return runShell(server, session, command, directory).then(function (result) {
            return jsonResponse({ ok: true, server: server.id, session: result.sessionId, text: result.text })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/git/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        if (server === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'no server' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        return gitStatus(server, directory).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, count: result.files.length, files: result.files, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/git/diff',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        if (server === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'no server' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const mode = url.searchParams.get('mode') === 'branch' ? 'branch' : 'git'
        const patch = url.searchParams.get('patch') === '1' || url.searchParams.get('patch') === 'true'
        return gitDiff(server, directory, mode, patch).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/file',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const path = url.searchParams.get('path') === null ? '' : url.searchParams.get('path')
        if (server === undefined || path === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and path required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        return readRemoteFile(server, directory, path).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, path: path, binary: result.binary, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/find',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const query = url.searchParams.get('query') === null ? '' : url.searchParams.get('query')
        if (server === undefined || query === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and query required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const kind = url.searchParams.get('kind') === 'text' ? 'text' : 'file'
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const pending = kind === 'text' ? findText(server, directory, query) : findFiles(server, directory, query, limit)
        return pending.then(function (result) {
          return jsonResponse({ ok: true, server: server.id, kind: kind, count: result.count, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/models',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectModels(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/commands',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectCommands(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/skills',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectSkills(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/tools',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectToolIds(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/references',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectReferences(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/command',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const command = typeof body.command === 'string' ? body.command : ''
          if (server === undefined || session === '' || command === '') return jsonResponse({ ok: false, error: 'server, session and command required' }, 400)
          const args = typeof body.arguments === 'string' ? body.arguments : ''
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return runCommand(server, session, command, args, directory).then(function (result) {
            return jsonResponse({ ok: true, server: server.id, session: result.sessionId, text: result.text })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/agents',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectAgents(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/session-info',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const session = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || session === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        return collectSessionInfo(server, session).then(function (info) {
          return jsonResponse({ ok: true, server: server.id, session: session, info: info })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/share',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          const action = body.action === 'unshare' ? 'unshare' : 'share'
          return shareSession(server, session, action).then(function (result) {
            return jsonResponse(Object.assign({ ok: result.ok, server: server.id, session: session, action: action }, result.ok ? { url: result.url } : { error: result.error }))
          })
        })
      },
    },
    {
      path: '/api/opencode-client/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const serverId = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const events = []
        for (const server of servers) {
          if (serverId !== undefined && server.id !== serverId) continue
          const buffered = Array.isArray(server.events) ? server.events : []
          for (const event of buffered) events.push(Object.assign({ server: server.id }, event))
        }
        events.sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
        const capped = events.slice(0, limit)
        return Promise.resolve(jsonResponse({ ok: true, count: events.length, shown: capped.length, events: capped, live: servers.map(function (server) { return { id: server.id, state: server.sse === undefined ? 'closed' : server.sse.state } }) }))
      },
    },
    {
      path: '/api/opencode-client/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        const rows = []
        let chain = Promise.resolve()
        for (const server of servers) {
          chain = chain.then(function () {
            return collectStatus(server).then(function (statuses) {
              for (const sessionId of Object.keys(statuses)) {
                const status = statuses[sessionId]
                if (status === null || typeof status !== 'object') continue
                if (status.type === 'idle') continue
                const progress = server.progress instanceof Map ? server.progress.get(sessionId) : undefined
                rows.push({
                  server: server.id,
                  session: sessionId,
                  status: typeof status.type === 'string' ? status.type : null,
                  tool: progress !== undefined && typeof progress.tool === 'string' ? progress.tool : null,
                  progress: progress !== undefined ? progress.status : null,
                  since: progress !== undefined && typeof progress.since === 'number' ? progress.since : null,
                  tail: progress !== undefined && typeof progress.tail === 'string' ? progress.tail : '',
                })
              }
            })
          })
        }
        return chain.then(function () {
          const seen = new Set(rows.map(function (row) { return row.server + ':' + row.session }))
          for (const server of servers) {
            if (!(server.progress instanceof Map)) continue
            for (const entry of server.progress.entries()) {
              const progress = entry[1]
              if (progress === null || typeof progress !== 'object' || progress.status === 'idle' || progress.status === 'error') continue
              if (seen.has(server.id + ':' + entry[0])) continue
              rows.push({
                server: server.id,
                session: entry[0],
                status: 'busy',
                tool: typeof progress.tool === 'string' ? progress.tool : null,
                progress: progress.status,
                since: typeof progress.since === 'number' ? progress.since : null,
                tail: typeof progress.tail === 'string' ? progress.tail : '',
              })
            }
          }
          return jsonResponse({ ok: true, running: rows })
        })
      },
    },
    {
      path: '/api/opencode-client/prompt',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const message = typeof body.message === 'string' ? body.message : ''
          if (server === undefined || session === '' || message === '') return jsonResponse({ ok: false, error: 'server, session and message required' }, 400)
          const turn = {}
          if (typeof body.agent === 'string' && body.agent !== '') turn.agent = body.agent
          const model = parseModel(body.model)
          if (model !== undefined) turn.model = model
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return sendSessionMessage(server, session, promptBody(server, message, turn), { wait: body.wait === true, directory: directory }).then(function (result) {
            return jsonResponse(Object.assign({ ok: true, server: server.id, session: session }, result))
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/abort',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          return abortSession(server, session).then(function (aborted) {
            return jsonResponse({ ok: true, server: server.id, session: session, aborted: aborted })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/search',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        const query = url.searchParams.get('query') === null ? '' : url.searchParams.get('query')
        if (query === '') return Promise.resolve(jsonResponse({ ok: false, error: 'query required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '20' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20
        return collectSessionSearch(servers, server, query, limit, directory).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, sessions: result.rows, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/mcp',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectMcpStatus(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/progress',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        const rows = []
        for (const server of servers) {
          if (!(server.progress instanceof Map)) continue
          for (const entry of server.progress.entries()) {
            const sessionId = entry[0]
            const progress = entry[1]
            if (progress === null || typeof progress !== 'object') continue
            rows.push({
              server: server.id,
              session: sessionId,
              status: progress.status,
              tool: progress.tool,
              since: progress.since,
              elapsedMs: typeof progress.since === 'number' ? Math.max(0, Date.now() - progress.since) : null,
              tail: progress.tail,
            })
          }
        }
        return Promise.resolve(jsonResponse({ ok: true, count: rows.length, progress: rows }))
      },
    },
    {
      path: '/api/opencode-client/delegate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          if (server === undefined) return jsonResponse({ ok: false, error: 'no opencode server configured' }, 400)
          const task = typeof body.task === 'string' ? body.task : ''
          if (task === '') return jsonResponse({ ok: false, error: 'task required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          const session = typeof body.session === 'string' && body.session !== '' ? body.session : undefined
          const options = {}
          if (typeof body.agent === 'string' && body.agent !== '') options.agent = body.agent
          const model = parseModel(body.model)
          if (model !== undefined) options.model = model
          if (typeof body.schema === 'string' && body.schema !== '') {
            try { options.jsonSchema = JSON.parse(body.schema) } catch (error) {}
          }
          const attachments = normalizeAttachments(body.files)
          if (attachments !== undefined) options.files = attachments
          return delegate(server, directory, task, session, options).then(function (outcome) {
            const payload = { ok: true, sessionId: outcome.sessionId, text: outcome.text }
            if (outcome.structured !== undefined && outcome.structured !== null) payload.structured = outcome.structured
            return jsonResponse(payload)
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/session',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          if (server === undefined) return jsonResponse({ ok: false, error: 'unknown opencode server' }, 400)
          const title = typeof body.title === 'string' && body.title !== '' ? body.title : 'session'
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return import('./http.js').then(function (http) {
            return http.opencodeRequest(server, '/session', { method: 'POST', body: { title: title }, directory: directory }).then(function (result) {
              if (result === undefined || result.status !== 200 || result.value === undefined) {
                return jsonResponse({ ok: false, error: 'opencode create failed' })
              }
              server.snapshot = undefined
              return jsonResponse({ ok: true, session: { id: result.value.id, title: title, directory: directory === undefined ? null : directory }, url: server.url + '/', sessionUrl: server.url + '/session/' + result.value.id })
            })
          })
        })
      },
    },
  ]
  return routes
}
