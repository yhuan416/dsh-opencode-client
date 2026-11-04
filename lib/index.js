/**
 * dsh-opencode-client — dsh 作为 opencode server 的客户端。
 *
 * In opencode's own words: "opencode serve runs a headless HTTP server that exposes an
 * OpenAPI endpoint that an opencode client can use"; the TUI/web/SDK are clients of that
 * server. This plugin is another opencode client, hosted inside dsh.
 *
 * It gives dsh:
 *  - server configuration (ip:port, optional basic auth, optional default directory)
 *  - project/workspace/session discovery
 *  - session message reading
 *  - delegation into a remote opencode session (new or continued)
 *  - a native dsh subagent provider backed by opencode
 */
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'opencode-client'
export const inject = ['connection', 'webServer']

/** Config: { servers: [{ id, label?, url, password?, directory? }], permission?: 'allow' | 'reject', pathMap?: [{from,to}] } */
function normalizeServers(raw) {
  if (!Array.isArray(raw)) return []
  const servers = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const base = typeof item.url === 'string' ? item.url.trim().replace(/\/+$/, '') : ''
    if (id === '' || base === '') continue
    servers.push({
      id: id,
      label: typeof item.label === 'string' && item.label !== '' ? item.label : id,
      url: base,
      password: typeof item.password === 'string' && item.password !== '' ? item.password : undefined,
      directory: typeof item.directory === 'string' && item.directory !== '' ? item.directory : undefined,
      snapshot: undefined,
    })
  }
  return servers
}

function opencodeRequest(server, target, options) {
  return new Promise(function (resolve) {
    let url
    try { url = new URL(server.url + target) } catch { resolve(undefined); return }
    const headers = { accept: 'application/json' }
    if (server.password !== undefined) {
      headers.authorization = 'Basic ' + Buffer.from('opencode:' + server.password).toString('base64')
    }
    if (options !== undefined && typeof options.directory === 'string' && options.directory !== '') {
      headers['x-opencode-directory'] = options.directory
    }
    const body = options !== undefined && options.body !== undefined ? JSON.stringify(options.body) : undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const request = http.request({
      host: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      method: options !== undefined && options.method !== undefined ? options.method : 'GET',
      path: url.pathname + url.search,
      timeout: 8000,
      headers: headers,
      ...options !== undefined && options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
    }, function (response) {
      const chunks = []
      response.on('data', function (chunk) { chunks.push(chunk) })
      response.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8')
        let value
        try { value = text === '' ? undefined : JSON.parse(text) } catch { value = undefined }
        resolve({ status: response.statusCode, value: value })
      })
    })
    request.on('timeout', function () { request.destroy(new Error('opencode timeout')) })
    request.on('error', function () { resolve(undefined) })
    if (options !== undefined && options.signal !== undefined && options.signal !== null) {
      const signal = options.signal
      const onAbort = function () { request.destroy(new Error('opencode aborted')) }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        request.on('close', function () { signal.removeEventListener('abort', onAbort) })
      }
    }
    request.end(body)
  })
}

function summarizeSession(session) {
  const time = session !== null && typeof session === 'object' && session.time !== null && typeof session.time === 'object' ? session.time : undefined
  return {
    id: session.id,
    title: typeof session.title === 'string' && session.title !== '' ? session.title : (typeof session.slug === 'string' ? session.slug : session.id),
    directory: typeof session.directory === 'string' ? session.directory : null,
    updatedAt: time !== undefined && typeof time.updated === 'number' ? time.updated : null,
  }
}

/** Health + projects + sessions of one opencode server, grouped by directory. */
function collectServer(server) {
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

const toolAttempts = []

/** dsh-tools is ESM: resolve it through the running dsh install and import by file URL. */
async function loadDshTools() {
  const globalPrefix = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai')
  const anchors = [
    path.join(globalPrefix, 'dsh', 'package.json'),
    path.join(globalPrefix, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
  ]
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') anchors.push(path.join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'))
  if (process.argv[1] !== undefined) anchors.push(process.argv[1])
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-tools')
      const loaded = await import(pathToFileURL(resolved).href)
      const mod = loaded !== null && typeof loaded === 'object' && loaded.default !== undefined && typeof loaded.default.defineTool === 'function' ? loaded.default : loaded
      if (mod !== null && typeof mod === 'object' && typeof mod.defineTool === 'function') {
        toolAttempts.push({ anchor: anchor, resolved: resolved, ok: true })
        return mod
      }
    } catch (error) {
      toolAttempts.push({ anchor: anchor, ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error).slice(0, 160) })
    }
  }
  return undefined
}

export async function apply(ctx, config) {
  const cfg = config === undefined || config === null ? {} : config
  const servers = normalizeServers(cfg.servers)
  const permission = cfg.permission === 'reject' ? 'reject' : 'always'
  const pathMap = (function () {
    const raw = cfg.pathMap
    if (!Array.isArray(raw)) return []
    const rules = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      if (typeof item.from !== 'string' || item.from === '' || typeof item.to !== 'string') continue
      rules.push({ from: item.from.replace(/\/+$/, ''), to: item.to.replace(/\/+$/, '') })
    }
    return rules
  })()
  const dshTools = await loadDshTools()
  const providerStatus = { registered: [], errors: [] }

  function jsonResponse(value, status) {
    return new Response(JSON.stringify(value), {
      status: status === undefined ? 200 : status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  function readJsonBody(request) {
    return request.json().then(function (value) {
      return value === null || typeof value !== 'object' ? {} : value
    }).catch(function () { return {} })
  }

  function mapDirectory(server, cwd) {
    if (typeof cwd === 'string' && cwd !== '') {
      for (const rule of pathMap) {
        if (cwd === rule.from) return rule.to === '' ? '/' : rule.to
        if (cwd.startsWith(rule.from + '/')) {
          const suffix = cwd.slice(rule.from.length)
          return rule.to === '' ? suffix : rule.to + suffix
        }
      }
      return cwd
    }
    return typeof server.directory === 'string' && server.directory !== '' ? server.directory : undefined
  }

  function promptText(prompt) {
    if (!Array.isArray(prompt)) return ''
    const parts = []
    for (const block of prompt) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  function watchPermissions(server, sessionId, directory) {
    const answered = new Set()
    const timer = setInterval(function () {
      opencodeRequest(server, '/permission', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has(request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add(request.id)
          opencodeRequest(server, '/permission/' + encodeURIComponent(request.id) + '/reply', {
            method: 'POST',
            body: { reply: permission },
            directory: directory,
            timeoutMs: 5000,
          })
        }
      })
    }, 1500)
    return function () { clearInterval(timer) }
  }

  function delegate(server, directory, task, sessionId) {
    const continuing = typeof sessionId === 'string' && sessionId !== ''
    const effectiveDirectory = continuing ? undefined : directory
    const ensure = continuing
      ? Promise.resolve(sessionId)
      : opencodeRequest(server, '/session', { method: 'POST', body: { title: 'dsh delegate' }, directory: directory, timeoutMs: 20000 }).then(function (created) {
        if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
          throw new Error('opencode: cannot create a session on ' + server.id)
        }
        return created.value.id
      })
    return ensure.then(function (id) {
      const stopWatching = watchPermissions(server, id, effectiveDirectory)
      return opencodeRequest(server, '/session/' + id + '/message', {
        method: 'POST',
        body: { parts: [{ type: 'text', text: task }] },
        directory: effectiveDirectory,
        timeoutMs: 900000,
      }).then(function (reply) {
        stopWatching()
        server.snapshot = undefined
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          throw new Error('opencode: no reply from ' + server.id + ' session ' + id)
        }
        const parts = Array.isArray(reply.value.parts) ? reply.value.parts : []
        const text = parts.filter(function (part) {
          return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        }).map(function (part) { return part.text }).join('\n').trim()
        return { sessionId: id, text: text === '' ? '(remote agent returned no text)' : text }
      }, function (error) {
        stopWatching()
        throw error
      })
    })
  }

  function startProviderRun(server, request) {
    const controller = new AbortController()
    const parentSignal = request.signal
    const onAbort = function () { controller.abort() }
    if (parentSignal !== undefined && parentSignal !== null) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', onAbort, { once: true })
    }
    const label = typeof request.label === 'string' && request.label !== '' ? request.label : 'dsh subagent'
    const directory = mapDirectory(server, request.cwd)
    const task = promptText(request.prompt) || '(empty task)'
    const detach = function () {
      if (parentSignal !== undefined && parentSignal !== null) parentSignal.removeEventListener('abort', onAbort)
    }
    return opencodeRequest(server, '/session', { method: 'POST', body: { title: label }, directory: directory, timeoutMs: 20000 }).then(function (created) {
      if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
        detach()
        throw new Error('opencode provider ' + server.id + ': cannot create a session')
      }
      const sessionId = created.value.id
      const stopWatching = watchPermissions(server, sessionId, directory)
      const settle = function (result) {
        stopWatching()
        detach()
        server.snapshot = undefined
        return result
      }
      const result = opencodeRequest(server, '/session/' + sessionId + '/message', {
        method: 'POST',
        body: { parts: [{ type: 'text', text: task }] },
        directory: directory,
        timeoutMs: 3600000,
        signal: controller.signal,
      }).then(function (reply) {
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          return settle({ output: [], stopReason: controller.signal.aborted ? 'aborted' : 'error', diagnostic: 'opencode: no reply from ' + server.id + ' session ' + sessionId })
        }
        const parts = Array.isArray(reply.value.parts) ? reply.value.parts : []
        const text = parts.filter(function (part) {
          return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
        }).map(function (part) { return part.text }).join('\n').trim()
        return settle({ output: text === '' ? [] : [{ type: 'text', text: text }], stopReason: 'completed' })
      }, function (error) {
        if (controller.signal.aborted) {
          opencodeRequest(server, '/session/' + sessionId + '/abort', { method: 'POST', timeoutMs: 5000 })
          return settle({ output: [], stopReason: 'aborted' })
        }
        const detail = String(error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : error)
        return settle({ output: [], stopReason: 'error', diagnostic: Buffer.byteLength(detail) > 4096 ? detail.slice(0, 4096) : detail })
      })
      return {
        id: sessionId,
        result: result,
        dispose: async function () {
          controller.abort()
          await result.catch(function () {})
        },
      }
    })
  }

  function makeProvider(server) {
    return {
      name: 'opencode-' + server.id,
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      start: function (request) { return startProviderRun(server, request) },
    }
  }

  function collectSessionRows(serverId, directory, query, limit) {
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

  /** Read the last N messages of one session (text parts only). */
  function readMessages(server, sessionId, limit) {
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
        return {
          role: typeof info.role === 'string' ? info.role : 'unknown',
          created: info.time !== null && typeof info.time === 'object' && typeof info.time.created === 'number' ? info.time.created : null,
          text: text,
        }
      })
    })
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
              rows.push({ id: server.id, label: server.label, state: value.state, version: value.version, projects: value.projects })
              return rows
            }, function () {
              rows.push({ id: server.id, label: server.label, state: 'offline', version: null, projects: [] })
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
        return collectSessionRows(server, directory, query, limit).then(function (result) {
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
      path: '/api/opencode-client/delegate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = servers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) }) || servers[0]
          if (server === undefined) return jsonResponse({ ok: false, error: 'no opencode server configured' }, 400)
          const task = typeof body.task === 'string' ? body.task : ''
          if (task === '') return jsonResponse({ ok: false, error: 'task required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          const session = typeof body.session === 'string' && body.session !== '' ? body.session : undefined
          return delegate(server, directory, task, session).then(function (outcome) {
            return jsonResponse({ ok: true, sessionId: outcome.sessionId, text: outcome.text })
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
          const server = servers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) })
          if (server === undefined) return jsonResponse({ ok: false, error: 'unknown opencode server' }, 400)
          const title = typeof body.title === 'string' && body.title !== '' ? body.title : 'session'
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return opencodeRequest(server, '/session', { method: 'POST', body: { title: title }, directory: directory }).then(function (result) {
            if (result === undefined || result.status !== 200 || result.value === undefined) {
              return jsonResponse({ ok: false, error: 'opencode create failed' })
            }
            server.snapshot = undefined
            return jsonResponse({ ok: true, session: summarizeSession(result.value), url: server.url + '/', sessionUrl: server.url + '/session/' + result.value.id })
          })
        })
      },
    },
  ]

  ctx.effect(function () {
    const disposers = []
    for (const route of routes) {
      const registered = ctx.connection.fetch.register(route)
      if (typeof registered === 'function') disposers.push(registered)
    }
    return function () {
      for (const dispose of disposers) { try { dispose() } catch {} }
    }
  }, 'opencode-client: HTTP routes')

  ctx.inject(['subagents'], function (subCtx) {
    const subagents = subCtx.subagents !== undefined ? subCtx.subagents : (typeof subCtx.get === 'function' ? subCtx.get('subagents') : undefined)
    if (subagents === undefined || typeof subagents.registerProvider !== 'function') return
    for (const server of servers) {
      try {
        subagents.registerProvider(makeProvider(server))
        providerStatus.registered.push('opencode-' + server.id)
      } catch (error) {
        providerStatus.errors.push('opencode-' + server.id + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
      }
    }
  })

  if (dshTools !== undefined) {
    ctx.inject(['tools'], function (subCtx) {
      const tools = subCtx.tools !== undefined ? subCtx.tools : (typeof subCtx.get === 'function' ? subCtx.get('tools') : undefined)
      if (tools === undefined || typeof tools.register !== 'function') return
      const defaultServer = servers[0]
      if (defaultServer === undefined) return

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_delegate',
          description: 'Delegate a task to a remote OpenCode agent. Without a session id it creates a new remote session (in the given remote directory); with a session id it continues that earlier session. Waits for the agent to finish and returns its final answer plus the session id.',
          parameters: {
            task: { type: 'string', description: 'Complete instructions for the remote agent. It cannot see this conversation.' },
            directory: { type: 'string', description: 'Absolute remote directory (ignored when continuing a session).' },
            server: { type: 'string', description: 'OpenCode server id; omit to use the first configured one.' },
            session: { type: 'string', description: 'Remote session id from a previous call, to continue that session.' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const configured = args !== null && typeof args === 'object' && typeof args.server === 'string' ? servers.find(function (candidate) { return candidate.id === args.server }) : undefined
            const target = configured === undefined ? defaultServer : configured
            const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
            const task = args !== null && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
            const session = args !== null && typeof args === 'object' && typeof args.session === 'string' && args.session !== '' ? args.session : undefined
            if (task === '') return Promise.resolve('opencode_delegate: task is required')
            return delegate(target, directory, task, session).then(function (outcome) {
              return 'remote opencode ' + target.id + ' session ' + outcome.sessionId + '\n(pass session="' + outcome.sessionId + '" to continue this remote session)\n\n' + outcome.text
            }, function (error) {
              return 'opencode_delegate failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_delegate tool')

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_sessions',
          description: 'List sessions (conversations) on the configured remote OpenCode servers: server, workspace directory, title, last update and session id. Read-only.',
          parameters: {
            server: { type: 'string', description: 'Only this OpenCode server id; omit to list every configured server.' },
            directory: { type: 'string', description: 'Only sessions whose absolute directory starts with this prefix.' },
            query: { type: 'string', description: 'Only sessions whose title contains this text.' },
            limit: { type: 'number', description: 'Maximum rows (default 50, cap 200).' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const server = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
            const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
            const query = args !== null && typeof args === 'object' && typeof args.query === 'string' && args.query !== '' ? args.query : undefined
            const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 50
            const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
            return collectSessionRows(server, directory, query, limit).then(function (result) {
              return result.count + ' remote session(s), showing ' + result.shown + ':\n' + result.text
            }, function (error) {
              return 'opencode_sessions failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_sessions tool')

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_messages',
          description: 'Read the last messages of one remote OpenCode session (text content). Read-only. Use it to decide whether a session is the right one to continue.',
          parameters: {
            server: { type: 'string', description: 'OpenCode server id.' },
            session: { type: 'string', description: 'Remote session id from opencode_sessions.' },
            limit: { type: 'number', description: 'Number of latest messages (default 20, cap 200).' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
            const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
            const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
            if (session === '') return Promise.resolve('opencode_messages: session is required')
            const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 20
            const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20
            return readMessages(server, session, limit).then(function (messages) {
              const lines = messages.map(function (message) { return '[' + message.role + '] ' + message.text })
              return 'server ' + server.id + ' session ' + session + ' (' + messages.length + ' message(s)):\n' + (lines.length === 0 ? '(no text messages)' : lines.join('\n'))
            }, function (error) {
              return 'opencode_messages failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_messages tool')
    })
  }

  const logger = ctx.logger !== undefined && typeof ctx.logger.info === 'function' ? ctx.logger : undefined
  const line = 'opencode-client: ' + String(servers.length) + ' server(s): ' + servers.map(function (server) { return server.id }).join(', ')
  if (logger !== undefined) logger.info(line)
  else console.log(line)
}
