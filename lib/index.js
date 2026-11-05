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

function parseModel(raw) {
  if (typeof raw === 'string' && raw.indexOf('/') > 0) {
    const at = raw.indexOf('/')
    return { providerID: raw.slice(0, at), modelID: raw.slice(at + 1) }
  }
  if (raw !== null && typeof raw === 'object' && typeof raw.providerID === 'string' && typeof raw.modelID === 'string') {
    return { providerID: raw.providerID, modelID: raw.modelID }
  }
  return undefined
}

/** Config: { servers: [{ id, label?, url, password?, directory?, agent?, model? }], permission?: 'allow'|'reject', question?: 'reject'|'ignore', pathMap?: [{from,to}] } */
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
      agent: typeof item.agent === 'string' && item.agent !== '' ? item.agent : undefined,
      model: parseModel(item.model),
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
  const permissionMode = cfg.permission === 'reject' ? 'reject' : (cfg.permission === 'allow' || cfg.permission === 'always' ? 'allow' : 'ask')
  const permission = permissionMode === 'reject' ? 'reject' : 'always'
  const questionPolicy = cfg.question === 'ignore' ? 'ignore' : 'reject'
  const activeRuns = new Map()
  let userQuestionsService
  ctx.inject(['userQuestions'], function (subCtx) {
    userQuestionsService = subCtx.userQuestions !== undefined ? subCtx.userQuestions : (typeof subCtx.get === 'function' ? subCtx.get('userQuestions') : undefined)
  })
  let approvalService
  ctx.inject(['approval'], function (subCtx) {
    approvalService = subCtx.approval !== undefined ? subCtx.approval : (typeof subCtx.get === 'function' ? subCtx.get('approval') : undefined)
  })
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

  function serverPermissionHeaders(server) {
    const headers = { accept: 'application/json' }
    if (server.password !== undefined) {
      headers.authorization = 'Basic ' + Buffer.from('opencode:' + server.password).toString('base64')
    }
    return headers
  }

  function replyPermissionFromEvent(server, properties, directory) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    opencodeRequest(server, '/permission/' + encodeURIComponent(requestId) + '/reply', {
      method: 'POST',
      body: { reply: permission },
      directory: directory,
      timeoutMs: 5000,
    })
  }

  function rejectQuestionFromEvent(server, properties, directory) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    opencodeRequest(server, '/question/' + encodeURIComponent(requestId) + '/reject', {
      method: 'POST',
      directory: directory,
      timeoutMs: 5000,
    })
  }

  /**
   * Answer one OpenCode permission request. When the run has a live dsh agent and the
   * deployment composes the approval seam, the request becomes a host approval card;
   * otherwise it follows the configured allow/reject policy.
   */
  function handlePermission(server, run, properties) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    const toolName = typeof properties.permission === 'string' ? properties.permission : 'permission'
    const patterns = Array.isArray(properties.patterns) && properties.patterns.length > 0 ? ' (' + properties.patterns.filter(function (pattern) { return typeof pattern === 'string' }).join(', ') + ')' : ''
    const reply = function (value) {
      opencodeRequest(server, '/permission/' + encodeURIComponent(requestId) + '/reply', {
        method: 'POST',
        body: { reply: value },
        directory: run === undefined ? undefined : run.directory,
        timeoutMs: 5000,
      })
    }
    const fallback = function () {
      if (permissionMode === 'reject') reply('reject')
      else reply('always')
    }
    if (permissionMode === 'ask' && run !== undefined && run.agent !== undefined && approvalService !== undefined && typeof approvalService.request === 'function') {
      approvalService.request({
        agent: run.agent,
        toolName: 'opencode:' + toolName,
        reason: 'OpenCode agent requests permission: ' + toolName + patterns,
        signal: run.signal,
      }).then(function (outcome) {
        reply(outcome === 'allowed-once' ? 'once' : 'reject')
      }, function () {
        reply('reject')
      })
      return
    }
    fallback()
  }

  /**
   * Forward one OpenCode question request to the dsh user-questions UI (when the run
   * was started by a tool call with a live agent), then reply to OpenCode with the
   * selected labels. Falls back to rejecting the question.
   */
  function handleQuestion(server, run, properties) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    const rawQuestions = Array.isArray(properties.questions) ? properties.questions : []
    const reject = function () {
      opencodeRequest(server, '/question/' + encodeURIComponent(requestId) + '/reject', {
        method: 'POST',
        directory: run === undefined ? undefined : run.directory,
        timeoutMs: 5000,
      })
    }
    if (rawQuestions.length === 0 || run === undefined || run.agent === undefined || userQuestionsService === undefined || typeof userQuestionsService.ask !== 'function') {
      if (questionPolicy === 'reject') reject()
      return
    }
    const questions = rawQuestions.map(function (item, index) {
      const options = Array.isArray(item.options) ? item.options.filter(function (option) {
        return option !== null && typeof option === 'object' && typeof option.label === 'string'
      }).map(function (option) {
        return { label: option.label, description: typeof option.description === 'string' ? option.description : undefined }
      }) : []
      return {
        id: 'q' + String(index + 1),
        question: typeof item.question === 'string' ? item.question : 'OpenCode question',
        header: typeof item.header === 'string' ? item.header : undefined,
        options: options.length === 0 ? undefined : options,
        multiSelect: item.multiple === true,
      }
    })
    userQuestionsService.ask({ agent: run.agent, questions: questions, signal: run.signal }).then(function (answer) {
      const answers = Array.isArray(answer.answers) ? answer.answers : []
      const labels = questions.map(function (question, index) {
        const item = answers.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.id === question.id }) || answers[index]
        const selected = item !== null && typeof item === 'object' && Array.isArray(item.selected) ? item.selected.filter(function (label) { return typeof label === 'string' }) : []
        if (selected.length === 0 && item !== null && typeof item === 'object' && typeof item.custom === 'string' && item.custom !== '') return [item.custom]
        return selected
      })
      return opencodeRequest(server, '/question/' + encodeURIComponent(requestId) + '/reply', {
        method: 'POST',
        body: { answers: labels },
        directory: run.directory,
        timeoutMs: 10000,
      })
    }, function () {
      reject()
    })
  }

  function handleEventBlock(server, block) {
    const lines = block.split('\n')
    const dataLines = []
    for (const line of lines) if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    if (dataLines.length === 0) return
    let parsed
    try { parsed = JSON.parse(dataLines.join('\n')) } catch { return }
    const payload = parsed !== null && typeof parsed === 'object' && parsed.payload !== undefined ? parsed.payload : parsed
    if (payload === null || typeof payload !== 'object' || typeof payload.type !== 'string') return
    const properties = payload.properties !== null && typeof payload.properties === 'object' ? payload.properties : {}
    const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : (typeof properties.sessionId === 'string' ? properties.sessionId : undefined)
    server.events = Array.isArray(server.events) ? server.events : []
    server.events.push({ at: Date.now(), type: payload.type, sessionId: sessionId === undefined ? null : sessionId })
    if (server.events.length > 200) server.events.splice(0, server.events.length - 200)
    if (sessionId !== undefined) {
      if (!(server.sessionState instanceof Map)) server.sessionState = new Map()
      const current = server.sessionState.get(sessionId) || {}
      current.lastAt = Date.now()
      current.lastType = payload.type
      if (payload.type === 'session.deleted') {
        server.sessionState.delete(sessionId)
        return
      }
      if (payload.type === 'session.idle' || payload.type === 'session.error') current.running = false
      else if (payload.type === 'session.status') {
        const status = properties.status
        current.running = !(status !== null && typeof status === 'object' && status.type === 'idle')
        current.status = status !== null && typeof status === 'object' && typeof status.type === 'string' ? status.type : null
      } else if (payload.type === 'session.next.prompt.admitted' || payload.type === 'session.next.step.started') current.running = true
      server.sessionState.set(sessionId, current)
    }
    if (payload.type === 'permission.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handlePermission(server, run, properties)
    }
    if (payload.type === 'question.asked') {
      const run = sessionId === undefined ? undefined : activeRuns.get(sessionId)
      handleQuestion(server, run, properties)
    }
  }

  /** Subscribe to a server's SSE event stream with reconnect/backoff; used for live state and fast interaction handling. */
  function subscribeEvents(server) {
    const sse = { state: 'closed', attempts: 0, timer: undefined, request: undefined, disposed: false, buffer: '' }
    server.sse = sse
    function schedule(delay) {
      if (sse.disposed) return
      if (sse.timer !== undefined) clearTimeout(sse.timer)
      sse.timer = setTimeout(connect, delay)
    }
    function connect() {
      if (sse.disposed) return
      let url
      try { url = new URL(server.url + '/global/event') } catch { schedule(5000); return }
      sse.state = 'connecting'
      const request = http.request({
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        method: 'GET',
        path: url.pathname + url.search,
        headers: Object.assign(serverPermissionHeaders(server), { accept: 'text/event-stream' }),
      }, function (response) {
        if (response.statusCode !== 200) {
          response.resume()
          sse.state = 'closed'
          sse.attempts += 1
          schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(sse.attempts, 5))))
          return
        }
        sse.state = 'open'
        sse.attempts = 0
        response.setEncoding('utf8')
        response.on('data', function (chunk) {
          sse.buffer += chunk
          let index
          while ((index = sse.buffer.indexOf('\n\n')) >= 0) {
            const block = sse.buffer.slice(0, index)
            sse.buffer = sse.buffer.slice(index + 2)
            try { handleEventBlock(server, block) } catch (error) {}
          }
        })
        response.on('end', function () { sse.state = 'closed'; schedule(1500) })
        response.on('error', function () { sse.state = 'closed'; schedule(3000) })
      })
      request.on('error', function () {
        sse.state = 'closed'
        sse.attempts += 1
        schedule(Math.min(30000, 1000 * Math.pow(2, Math.min(sse.attempts, 5))))
      })
      request.end()
      sse.request = request
    }
    connect()
    return function () {
      sse.disposed = true
      if (sse.timer !== undefined) clearTimeout(sse.timer)
      try { if (sse.request !== undefined) sse.request.destroy() } catch (error) {}
    }
  }

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

  function promptBody(server, task, options) {
    const body = { parts: [{ type: 'text', text: task }] }
    const agent = options !== undefined && typeof options.agent === 'string' && options.agent !== '' ? options.agent : server.agent
    if (agent !== undefined) body.agent = agent
    const model = options !== undefined && options.model !== undefined ? options.model : server.model
    if (model !== undefined) body.model = model
    return body
  }

  /** Answer pending permission AND question requests of one session while a run is active. */
  function watchInteractions(server, sessionId, directory) {
    const answered = new Set()
    let tick = 0
    const timer = setInterval(function () {
      tick += 1
      if (tick % 10 !== 0 && server.sse !== undefined && server.sse.state === 'open') return
      opencodeRequest(server, '/permission', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has(request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add(request.id)
          handlePermission(server, activeRuns.get(sessionId), request)
        }
      })
      opencodeRequest(server, '/question', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has('q:' + request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add('q:' + request.id)
          handleQuestion(server, activeRuns.get(sessionId) || { directory: directory }, request)
        }
      })
    }, 1500)
    return function () { clearInterval(timer) }
  }

  function extractAssistant(entry) {
    const info = entry !== null && typeof entry === 'object' && entry.info !== null && typeof entry.info === 'object' ? entry.info : {}
    const parts = entry !== null && typeof entry === 'object' && Array.isArray(entry.parts) ? entry.parts : []
    const text = parts.filter(function (part) {
      return part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string'
    }).map(function (part) { return part.text }).join('\n').trim()
    return { text: text, structured: info.structured }
  }

  /** Poll a session's messages until its last assistant message is completed. */
  function waitAssistant(server, sessionId, directory, signal, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const deadline = Date.now() + timeoutMs
      let done = false
      let timer
      function finish(error, value) {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        if (error !== undefined && error !== null) reject(error)
        else resolve(value)
      }
      function poll() {
        if (done) return
        if (signal !== undefined && signal !== null && signal.aborted) { finish(new Error('opencode: aborted')); return }
        if (Date.now() > deadline) { finish(new Error('opencode: timeout')); return }
        opencodeRequest(server, '/session/' + sessionId + '/message?limit=2', { directory: directory, timeoutMs: 15000 }).then(function (result) {
          if (done) return
          const list = result !== undefined && Array.isArray(result.value) ? result.value : []
          if (result !== undefined && result.value !== undefined && !Array.isArray(result.value) && typeof result.value === 'object' && result.value !== null) {
            const detail = result.value.name === undefined ? JSON.stringify(result.value) : String(result.value.name) + ': ' + JSON.stringify(result.value.data).slice(0, 300)
            finish(new Error('opencode: message read failed: ' + detail))
            return
          }
          const last = list.length === 0 ? undefined : list[list.length - 1]
          const info = last !== undefined && last !== null && typeof last === 'object' && last.info !== null && typeof last.info === 'object' ? last.info : {}
          const completed = info.time !== null && typeof info.time === 'object' && typeof info.time.completed === 'number'
          if (info.role === 'assistant' && completed) {
            finish(undefined, extractAssistant(last))
            return
          }
          timer = setTimeout(poll, 1500)
        }, function () { if (!done) timer = setTimeout(poll, 3000) })
      }
      timer = setTimeout(poll, 300)
      if (signal !== undefined && signal !== null) {
        signal.addEventListener('abort', function () { finish(new Error('opencode: aborted')) }, { once: true })
      }
    })
  }

  function syncPrompt(server, id, body, directory, signal) {
    return opencodeRequest(server, '/session/' + id + '/message', {
      method: 'POST',
      body: body,
      directory: directory,
      timeoutMs: 900000,
      signal: signal,
    }).then(function (reply) {
      if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
        throw new Error('opencode: no reply from ' + server.id + ' session ' + id)
      }
      return extractAssistant(reply.value)
    })
  }

  /** Prefer prompt_async + message polling; fall back to the blocking prompt endpoint. */
  function asyncPrompt(server, id, body, directory, signal) {
    const waited = waitAssistant(server, id, directory, signal, 900000)
    return opencodeRequest(server, '/session/' + id + '/prompt_async', {
      method: 'POST',
      body: body,
      directory: directory,
      timeoutMs: 20000,
      signal: signal,
    }).then(function (accepted) {
      if (accepted === undefined || (accepted.status !== 200 && accepted.status !== 201 && accepted.status !== 204)) {
        return syncPrompt(server, id, body, directory, signal)
      }
      return waited
    }, function () {
      return syncPrompt(server, id, body, directory, signal)
    })
  }

  /** Prompt-enforced JSON: ask the agent for JSON and validate it locally (opencode's format= is broken upstream). */
  function parseStructured(text, schema) {
    if (typeof text !== 'string') return undefined
    const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    let value
    try { value = JSON.parse(cleaned) } catch { return undefined }
    if (schema !== null && typeof schema === 'object' && schema.type === 'object' && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value === null || typeof value !== 'object' || !(key in value)) return undefined
      }
    }
    return value
  }

  function delegate(server, directory, task, sessionId, options) {
    const continuing = typeof sessionId === 'string' && sessionId !== ''
    const effectiveDirectory = continuing ? undefined : directory
    const jsonSchema = options !== undefined ? options.jsonSchema : undefined
    const instruction = jsonSchema === undefined ? '' : '\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n' + JSON.stringify(jsonSchema)
    const promptTask = task + instruction
    const ensure = continuing
      ? Promise.resolve(sessionId)
      : opencodeRequest(server, '/session', { method: 'POST', body: { title: 'dsh delegate' }, directory: directory, timeoutMs: 20000 }).then(function (created) {
        if (created === undefined || created.status !== 200 || created.value === undefined || typeof created.value.id !== 'string') {
          throw new Error('opencode: cannot create a session on ' + server.id)
        }
        return created.value.id
      })
    return ensure.then(function (id) {
      if (typeof id === 'string' && id !== '') {
        activeRuns.set(id, {
          serverId: server.id,
          directory: effectiveDirectory,
          agent: options !== undefined ? options.dshAgent : undefined,
          signal: options !== undefined ? options.signal : undefined,
        })
      }
      const stopWatching = watchInteractions(server, id, effectiveDirectory)
      const finish = function () { stopWatching(); activeRuns.delete(id) }
      const prompt = promptBody(server, promptTask, options)
      const signal = options !== undefined ? options.signal : undefined
      return asyncPrompt(server, id, prompt, effectiveDirectory, signal).then(function (outcome) {
        finish()
        server.snapshot = undefined
        const structured = outcome.structured !== undefined ? outcome.structured : (jsonSchema === undefined ? undefined : parseStructured(outcome.text, jsonSchema))
        return { sessionId: id, text: outcome.text === '' ? '(remote agent returned no text)' : outcome.text, structured: structured }
      }, function (error) {
        finish()
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
      activeRuns.set(sessionId, { serverId: server.id, directory: directory, signal: controller.signal })
      const stopWatching = watchInteractions(server, sessionId, directory)
      const settle = function (result) {
        stopWatching()
        activeRuns.delete(sessionId)
        detach()
        server.snapshot = undefined
        return result
      }
      const result = opencodeRequest(server, '/session/' + sessionId + '/message', {
        method: 'POST',
        body: promptBody(server, task),
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

  /** Title/summary/todos/diff of one session. */
  function collectSessionInfo(server, sessionId) {
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

  function shareSession(server, sessionId, action) {
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
  function collectStatus(server) {
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
  function collectAgents(serverId) {
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
                const run = activeRuns.get(sessionId)
                rows.push({
                  server: server.id,
                  session: sessionId,
                  directory: run === undefined ? null : run.directory,
                  status: typeof status.type === 'string' ? status.type : null,
                })
              }
            })
          })
        }
        return chain.then(function () { return jsonResponse({ ok: true, running: rows }) })
      },
    },
    {
      path: '/api/opencode-client/session-info',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = servers.find(function (candidate) { return candidate.id === String(url.searchParams.get('server') === null ? '' : url.searchParams.get('server')) }) || servers[0]
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
          const server = servers.find(function (candidate) { return candidate.id === String(body.server === undefined ? '' : body.server) }) || servers[0]
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
      path: '/api/opencode-client/agents',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectAgents(server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
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
            agent: { type: 'string', description: 'OpenCode agent name (e.g. build, plan, explore, general). Omit to use the server default.' },
            model: { type: 'string', description: 'Model as "providerID/modelID" (e.g. deepseek/deepseek-chat). Omit to use the server default.' },
            schema: { type: 'string', description: 'Optional JSON schema (JSON string). The task is extended with a "return only JSON matching this schema" instruction and the result is validated locally (prompt-enforced, not opencode format=).' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args, exec) {
            const configured = args !== null && typeof args === 'object' && typeof args.server === 'string' ? servers.find(function (candidate) { return candidate.id === args.server }) : undefined
            const target = configured === undefined ? defaultServer : configured
            const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
            const task = args !== null && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
            const session = args !== null && typeof args === 'object' && typeof args.session === 'string' && args.session !== '' ? args.session : undefined
            const options = {}
            if (args !== null && typeof args === 'object' && typeof args.agent === 'string' && args.agent !== '') options.agent = args.agent
            const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
            if (model !== undefined) options.model = model
            if (exec !== undefined && typeof exec === 'object') {
              options.dshAgent = exec.agent
              options.signal = exec.signal
            }
            if (args !== null && typeof args === 'object' && typeof args.schema === 'string' && args.schema !== '') {
              try { options.jsonSchema = JSON.parse(args.schema) } catch (error) {}
            }
            if (task === '') return Promise.resolve('opencode_delegate: task is required')
            return delegate(target, directory, task, session, options).then(function (outcome) {
              let suffix = outcome.text
              if (outcome.structured !== undefined && outcome.structured !== null) suffix = suffix + '\n\nstructured: ' + JSON.stringify(outcome.structured)
              return 'remote opencode ' + target.id + ' session ' + outcome.sessionId + '\n(pass session="' + outcome.sessionId + '" to continue this remote session)\n\n' + suffix
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

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_agents',
          description: 'List agents advertised by the configured OpenCode servers (primary and subagent, native/custom). Read-only. Use it before opencode_delegate when you need to pick an agent name (build/plan/explore/general/...).',
          parameters: {
            server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
            return collectAgents(serverId).then(function (result) {
              return result.count + ' agent(s):\n' + result.text
            }, function (error) {
              return 'opencode_agents failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_agents tool')

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_session_info',
          description: 'Read the metadata, todo list and changed-file diff of one remote OpenCode session. Read-only. Use it to judge what a session did before continuing it.',
          parameters: {
            server: { type: 'string', description: 'OpenCode server id.' },
            session: { type: 'string', description: 'Remote session id.' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
            const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
            const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
            if (session === '') return Promise.resolve('opencode_session_info: session is required')
            return collectSessionInfo(server, session).then(function (info) {
              const data = info.session
              const lines = []
              lines.push('session ' + session + ' on ' + server.id)
              lines.push('title: ' + (typeof data.title === 'string' ? data.title : '(untitled)'))
              lines.push('directory: ' + (typeof data.directory === 'string' ? data.directory : '?'))
              if (typeof data.agent === 'string') lines.push('agent: ' + data.agent)
              if (data.model !== null && typeof data.model === 'object') lines.push('model: ' + String(data.model.providerID) + '/' + String(data.model.id))
              if (data.summary !== null && typeof data.summary === 'object') lines.push('summary: +' + String(data.summary.additions) + ' -' + String(data.summary.deletions) + ' (' + String(data.summary.files) + ' files)')
              if (data.cost !== undefined) lines.push('cost: ' + String(data.cost))
              lines.push('todos (' + info.todos.length + '):')
              for (const todo of info.todos.slice(0, 20)) lines.push('  - [' + (typeof todo.status === 'string' ? todo.status : '?') + '] ' + (typeof todo.content === 'string' ? todo.content : ''))
              lines.push('diff (' + info.diffs.length + '):')
              for (const diff of info.diffs.slice(0, 20)) lines.push('  - ' + (typeof diff.file === 'string' ? diff.file : '?') + ' (+' + String(diff.additions) + ' -' + String(diff.deletions) + ')')
              return lines.join('\n')
            }, function (error) {
              return 'opencode_session_info failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_session_info tool')

      ctx.effect(function () {
        const dispose = tools.register(dshTools.defineTool({
          name: 'opencode_share',
          description: 'Share or unshare one remote OpenCode session (opencode creates a public share link). Use action "share" or "unshare".',
          parameters: {
            server: { type: 'string', description: 'OpenCode server id.' },
            session: { type: 'string', description: 'Remote session id.' },
            action: { type: 'string', description: 'share (default) or unshare.' },
          },
          output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
          execute: function (args) {
            const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
            const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
            const action = args !== null && typeof args === 'object' && args.action === 'unshare' ? 'unshare' : 'share'
            const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
            if (session === '') return Promise.resolve('opencode_share: session is required')
            return shareSession(server, session, action).then(function (result) {
              return result.ok ? (action === 'unshare' ? 'unshared ' + session : 'shared ' + session + (result.url === null ? '' : ': ' + result.url)) : 'opencode_share failed: ' + String(result.error)
            }, function (error) {
              return 'opencode_share failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
            })
          },
        }))
        return function () { try { dispose() } catch {} }
      }, 'opencode-client: opencode_share tool')
    })
  }

  ctx.effect(function () {
    const disposers = servers.map(function (server) { return subscribeEvents(server) })
    return function () {
      for (const dispose of disposers) { try { dispose() } catch (error) {} }
    }
  }, 'opencode-client: SSE subscriptions')

  const logger = ctx.logger !== undefined && typeof ctx.logger.info === 'function' ? ctx.logger : undefined
  const line = 'opencode-client: ' + String(servers.length) + ' server(s): ' + servers.map(function (server) { return server.id }).join(', ')
  if (logger !== undefined) logger.info(line)
  else console.log(line)
}
