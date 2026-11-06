/** Host HTTP routes under /api/opencode-client/. */
import { jsonResponse, readJsonBody } from './http.js'
import { collectServer, collectSessionRows, readMessages, collectAgents, collectSessionInfo, shareSession, collectStatus } from './sessions.js'
import { parseModel } from './config.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand } from './catalog.js'

export function createRoutes(deps) {
  const servers = deps.servers
  const delegate = deps.delegate
  const defaultServer = servers[0]

  function findServer(body) {
    return servers.find(function (candidate) { return candidate.id === String(body === undefined ? '' : body) }) || defaultServer
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
                const running = Object.keys(statuses).filter(function (sessionId) {
                  const status = statuses[sessionId]
                  return status !== null && typeof status === 'object' && status.type !== 'idle'
                }).length
                rows.push({
                  id: server.id,
                  label: server.label,
                  state: value.state,
                  version: value.version,
                  live: server.sse !== undefined && server.sse.state === 'open',
                  running: running,
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
                rows.push({ server: server.id, session: sessionId, status: typeof status.type === 'string' ? status.type : null })
              }
            })
          })
        }
        return chain.then(function () { return jsonResponse({ ok: true, running: rows }) })
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
