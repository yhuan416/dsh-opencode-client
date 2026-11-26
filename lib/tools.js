/** Model-facing dsh tools for the OpenCode client. */
import { parseModel, modelLabel } from './config.js'
import { collectStatus, abortSession } from './sessions.js'
import { buildPrompt } from './delegate.js'
import { apiVersionOf } from './http.js'
import { sendSessionMessage } from './session-run.js'

function parseAttachmentList(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let list
  try { list = JSON.parse(raw) } catch { return undefined }
  if (!Array.isArray(list)) return undefined
  const files = []
  for (const entry of list.slice(0, 10)) {
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

export function registerTools(options) {
  const tools = options.toolsService
  const dshTools = options.dshTools
  const servers = options.servers
  const defaultServer = servers[0]
  const delegate = options.delegate
  const board = options.board
  const collectStats = options.collectStats
  const collectSessionRows = options.collectSessionRows
  const readMessages = options.readMessages
  const collectAgents = options.collectAgents
  const collectSessionInfo = options.collectSessionInfo
  const shareSession = options.shareSession
  const collectModels = options.collectModels
  const collectCommands = options.collectCommands
  const collectSkills = options.collectSkills
  const collectToolIds = options.collectToolIds
  const collectReferences = options.collectReferences
  const runCommand = options.runCommand
  const runShell = options.runShell
  const gitStatus = options.gitStatus
  const gitDiff = options.gitDiff
  const readRemoteFile = options.readRemoteFile
  const findFiles = options.findFiles
  const findText = options.findText
  const forkSession = options.forkSession
  const summarize = options.summarize
  const initSession = options.initSession
  const sessionChildren = options.sessionChildren
  const collectSessionSearch = options.collectSessionSearch
  const collectMcpStatus = options.collectMcpStatus
  const effect = options.effect

  function catalogTool(name, description, collector, label) {
    effect(function () {
      const dispose = tools.register(dshTools.defineTool({
        name: name,
        description: description,
        parameters: {
          server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
        },
        output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
        execute: function (args) {
          const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
          return collector(servers, serverId).then(function (result) {
            return result.count + ' ' + label + ':\n' + result.text
          }, function (error) {
            return name + ' failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
          })
        },
      }))
      return function () { try { dispose() } catch {} }
    }, 'opencode-client: ' + name + ' tool')
  }

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_subagent',
      description: 'Delegate a task to a remote OpenCode subagent on the chosen OpenCode server: starts a new remote session (in directory) or continues an existing one with session=, waits for it to finish and returns the final answer plus the session id. Prefer this over the native opencode_subagent_<server> tools when you need an agent/model override, prompt-enforced JSON schema output, or to resume a remote session; the native tools are fire-and-forget one-shot runs.',
      parameters: {
        task: { type: 'string', description: 'Complete instructions for the remote agent. It cannot see this conversation.' },
        directory: { type: 'string', description: 'Absolute remote directory (ignored when continuing a session).' },
        server: { type: 'string', description: 'OpenCode server id; omit to use the first configured one.' },
        session: { type: 'string', description: 'Remote session id from a previous call, to continue that session.' },
        agent: { type: 'string', description: 'OpenCode agent name (e.g. build, plan, explore, general). Omit to use the server default.' },
        model: { type: 'string', description: 'Model as "providerID/modelID" (e.g. deepseek/deepseek-chat); on OpenCode 2 append "#variant" for a reasoning variant (e.g. "alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high"; variants are listed by opencode_models). Omit to use the server default.' },
        schema: { type: 'string', description: 'Optional JSON schema (JSON string). The task is extended with a "return only JSON matching this schema" instruction and the result is validated locally (prompt-enforced, not opencode format=).' },
        files: { type: 'string', description: 'Optional JSON array of attachments: [{"filename":"note.txt","mime":"text/plain","content":"..."}] or {"base64":"..."}; max 5 MB each, sent as data URLs.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args, exec) {
        const configured = args !== null && typeof args === 'object' && typeof args.server === 'string' ? servers.find(function (candidate) { return candidate.id === args.server }) : undefined
        const target = configured === undefined ? defaultServer : configured
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
        const task = args !== null && typeof args === 'object' && typeof args.task === 'string' ? args.task : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' && args.session !== '' ? args.session : undefined
        const opts = {}
        if (args !== null && typeof args === 'object' && typeof args.agent === 'string' && args.agent !== '') opts.agent = args.agent
        const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
        if (model !== undefined) opts.model = model
        if (args !== null && typeof args === 'object' && typeof args.schema === 'string' && args.schema !== '') {
          try { opts.jsonSchema = JSON.parse(args.schema) } catch (error) {}
        }
        const files = parseAttachmentList(args !== null && typeof args === 'object' ? args.files : undefined)
        if (files !== undefined) opts.files = files
        if (exec !== undefined && typeof exec === 'object') {
          opts.dshAgent = exec.agent
          opts.signal = exec.signal
        }
        if (task === '') return Promise.resolve('opencode_subagent: task is required')
        return delegate(target, directory, task, session, opts).then(function (outcome) {
          let suffix = outcome.text
          if (outcome.structured !== undefined && outcome.structured !== null) suffix = suffix + '\n\nstructured: ' + JSON.stringify(outcome.structured)
          return 'remote opencode ' + target.id + ' session ' + outcome.sessionId + '\n(pass session="' + outcome.sessionId + '" to continue this remote session)\n\n' + suffix
        }, function (error) {
          return 'opencode_subagent failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_subagent tool')

  effect(function () {
    function compact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
      if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k'
      return String(Math.round(value))
    }
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_usage',
      description: 'Token and cost usage of the remote OpenCode servers (v2 only; v1 has no stats endpoint). Reports per-server and combined totals for a time range: sessions, steps, input/output/reasoning/cache tokens, cost and tool call success rate. Read-only.',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for every configured server.' },
        days: { type: 'number', description: 'Look back this many days (default 7, 0 = all recorded history).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const wanted = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        const rawDays = args !== null && typeof args === 'object' && typeof args.days === 'number' ? args.days : 7
        const days = Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : 7
        const from = days === 0 ? 0 : Date.now() - days * 86400000
        const picked = wanted === undefined ? servers : servers.filter(function (server) { return server.id === wanted })
        if (picked.length === 0) return Promise.resolve('opencode_usage: no server matches ' + String(wanted))
        const chain = picked.map(function (server) {
          return collectStats(server, { from: from }).then(function (value) { return { server: server, value: value } })
        })
        return Promise.all(chain).then(function (results) {
          const lines = ['opencode usage · last ' + (days === 0 ? 'all time' : days + ' days')]
          let supported = 0
          for (const item of results) {
            const value = item.value
            if (value === undefined || value.supported !== true) {
              lines.push('- ' + item.server.id + ': v1 server or stats unavailable' + (value !== undefined && value.error ? ' (' + value.error + ')' : ''))
              continue
            }
            supported += 1
            lines.push('- ' + item.server.id + ': ' + value.sessions + ' sessions · ' + value.steps + ' steps · in ' + compact(value.tokens.input) + ' · out ' + compact(value.tokens.output) + ' · reasoning ' + compact(value.tokens.reasoning) + ' · cache read ' + compact(value.tokens.cacheRead) + ' · cost ' + value.cost.toFixed(2) + ' · tools ' + value.tools.succeeded + '/' + value.tools.calls + ' ok')
          }
          if (supported === 0) lines.push('note: cost is only meaningful where the server has a pricing mapping; tokens are always reported as recorded.')
          return lines.join('\n')
        }, function (error) {
          return 'opencode_usage failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_usage tool')

  effect(function () {
    function ago(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return seconds + 's'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + 'm'
      const hours = Math.round(minutes / 60)
      if (hours < 48) return hours + 'h'
      return Math.round(hours / 24) + 'd'
    }
    function one(row) {
      const title = typeof row.title === 'string' && row.title !== '' ? row.title : row.sessionId.slice(0, 14)
      const directory = typeof row.directory === 'string' && row.directory !== '' ? ' (' + row.directory + ')' : ''
      const child = row.childCount > 0 ? ' +' + row.childCount + 'child' : ''
      return row.serverId + ' ' + row.sessionId + ' ' + title + directory + child + ' — ' + row.status
    }
    function detail(row) {
      if (row.pending !== null && row.pending !== undefined) return ' · ' + row.pending.detail + ' (waited ' + ago(row.pending.at) + ')'
      if (row.progress !== null && row.progress !== undefined && row.progress.tool) return ' · tool ' + row.progress.tool + ' (' + ago(row.since) + ')'
      if (row.stale === true) return ' · stale'
      return row.updatedAt !== undefined && row.updatedAt !== null ? ' · ' + ago(row.updatedAt) : ''
    }
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_board',
      description: 'Session board across every configured OpenCode server: which sessions are running right now and which are waiting for the user (permission or question). Read-only. Prefer this over guessing when the user asks what remote OpenCode is doing or whether anything needs them.',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for every configured server.' },
        idle: { type: 'number', description: 'How many idle sessions to include (default 5, cap 30).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const wanted = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        const rawIdle = args !== null && typeof args === 'object' && typeof args.idle === 'number' ? args.idle : 5
        const idleLimit = Number.isFinite(rawIdle) && rawIdle >= 0 ? Math.min(Math.floor(rawIdle), 30) : 5
        return board.refreshAll().then(function () {
          const snapshot = board.snapshot({ idleLimit: idleLimit })
          const pick = function (rows) {
            return wanted === undefined ? rows : rows.filter(function (row) { return row.serverId === wanted })
          }
          const live = servers.filter(function (server) { return server.sse !== undefined && server.sse.state === 'open' }).map(function (server) { return server.id })
          const lines = ['opencode board · ' + live.length + '/' + servers.length + ' live (' + (live.join(', ') || 'none') + ')']
          const needsMe = pick(snapshot.needsMe)
          const running = pick(snapshot.running)
          const broken = pick(snapshot.unknown)
          const idle = pick(snapshot.idle)
          lines.push('')
          lines.push('needs you (' + needsMe.length + ')')
          if (needsMe.length === 0) lines.push('- none')
          for (const row of needsMe) lines.push('- ' + one(row) + detail(row))
          lines.push('')
          lines.push('running (' + running.length + ')')
          if (running.length === 0) lines.push('- none')
          for (const row of running) lines.push('- ' + one(row) + detail(row))
          if (broken.length > 0) {
            lines.push('')
            lines.push('error/unknown (' + broken.length + ')')
            for (const row of broken) lines.push('- ' + one(row))
          }
          lines.push('')
          lines.push('idle ' + snapshot.idleCount + ' (showing ' + idle.length + ')')
          for (const row of idle) lines.push('- ' + one(row) + detail(row))
          return lines.join('\n')
        }, function (error) {
          return 'opencode_board failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_board tool')

  effect(function () {
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
        return collectSessionRows(servers, server, directory, query, limit).then(function (result) {
          return result.count + ' remote session(s), showing ' + result.shown + ':\n' + result.text
        }, function (error) {
          return 'opencode_sessions failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_sessions tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_messages',
      description: 'Read the last messages of one remote OpenCode session (text, tool and file content; tool lines include the input summary and the first output line). Read-only. Use it to decide whether a session is the right one to continue. On OpenCode 2 pass type= to read only one message kind (e.g. assistant, user, shell, system, synthetic, idle); without type, bookkeeping messages are hidden.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id from opencode_sessions.' },
        limit: { type: 'number', description: 'Number of latest messages (default 20, cap 200).' },
        type: { type: 'string', description: 'Optional message type filter: user | assistant | synthetic | system | shell | skill | idle | compaction | agent-switched | model-switched | location-switched. OpenCode 2 filters server-side; v1 filters locally.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '') return Promise.resolve('opencode_messages: session is required')
        const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 20
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20
        const type = args !== null && typeof args === 'object' && typeof args.type === 'string' && args.type !== '' ? args.type : undefined
        return readMessages(server, session, limit, type).then(function (messages) {
          const lines = messages.map(function (message) { return '[' + message.role + '] ' + message.text })
          return 'server ' + server.id + ' session ' + session + ' (' + messages.length + ' message(s)):\n' + (lines.length === 0 ? '(no text messages)' : lines.join('\n'))
        }, function (error) {
          return 'opencode_messages failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_messages tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_agents',
      description: 'List agents advertised by the configured OpenCode servers (primary and subagent, native/custom). Read-only. Use it before opencode_subagent when you need to pick an agent name (build/plan/explore/general/...).',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        return collectAgents(servers, serverId).then(function (result) {
          return result.count + ' agent(s):\n' + result.text
        }, function (error) {
          return 'opencode_agents failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_agents tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_session_info',
      description: 'Read the metadata, todo list, outcome/cost/tokens and changed-file diff of one remote OpenCode session. Read-only. On OpenCode 1 the todo list comes from /session/{id}/todo; OpenCode 2 has no todo endpoint, so it is derived from the last todowrite tool call in the session. Use it to judge what a session did before continuing it.',
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
          const infoDirectory = typeof data.directory === 'string' ? data.directory : (data.location !== null && typeof data.location === 'object' && typeof data.location.directory === 'string' ? data.location.directory : undefined)
          lines.push('directory: ' + (infoDirectory === undefined ? '?' : infoDirectory))
          if (typeof data.agent === 'string') lines.push('agent: ' + data.agent)
          if (data.model !== null && typeof data.model === 'object') {
            const label = modelLabel(data.model)
            lines.push('model: ' + (label === undefined ? String(data.model.providerID) + '/' + String(data.model.id) : label))
          } else {
            lines.push('model: (server default)')
          }
          if (typeof data.parentID === 'string' && data.parentID !== '') lines.push('parent session: ' + data.parentID)
          if (data.fork !== null && typeof data.fork === 'object' && typeof data.fork.sessionID === 'string') lines.push('forked from: ' + data.fork.sessionID)
          if (data.time !== null && typeof data.time === 'object') {
            const created = typeof data.time.created === 'number' ? new Date(data.time.created).toISOString().replace('T', ' ').slice(0, 19) : undefined
            const updated = typeof data.time.updated === 'number' ? new Date(data.time.updated).toISOString().replace('T', ' ').slice(0, 19) : undefined
            if (created !== undefined) lines.push('created: ' + created)
            if (updated !== undefined) lines.push('updated: ' + updated)
          }
          if (data.summary !== null && typeof data.summary === 'object') lines.push('summary: +' + String(data.summary.additions) + ' -' + String(data.summary.deletions) + ' (' + String(data.summary.files) + ' files)')
          if (data.cost !== undefined) lines.push('cost: ' + String(data.cost))
          if (info.todosSupported === false) {
            lines.push('todos: not available on this server')
          } else {
            lines.push('todos (' + info.todos.length + ')' + (info.todosDerived === true ? ' [derived from the last todowrite call]' : '') + ':')
            for (const todo of info.todos.slice(0, 20)) lines.push('  - [' + (typeof todo.status === 'string' ? todo.status : '?') + '] ' + (typeof todo.content === 'string' ? todo.content : ''))
          }
          if (typeof data.outcome === 'string') lines.push('outcome: ' + data.outcome)
          if (data.tokens !== null && typeof data.tokens === 'object') lines.push('tokens: in ' + String(data.tokens.input) + ', out ' + String(data.tokens.output) + (data.tokens.reasoning === undefined ? '' : ', reasoning ' + String(data.tokens.reasoning)))
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

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_share',
      description: 'Share or unshare one remote OpenCode session (opencode creates a public share link). Use action "share" or "unshare". v1 only: OpenCode 2 removed the share endpoint.',
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

  catalogTool('opencode_models', 'List LLM providers and model ids available on the configured OpenCode servers (credentials are never returned). Read-only. Use it to pick a "provider/model" for opencode_subagent.', collectModels, 'provider(s)')
  catalogTool('opencode_commands', 'List custom OpenCode commands (name, description, agent/model) available on the configured servers. Read-only. Execute one with opencode_command.', collectCommands, 'command(s)')
  catalogTool('opencode_skills', 'List Agent Skills visible to the configured OpenCode servers (name, description, location; contents omitted). Read-only.', collectSkills, 'skill(s)')
  catalogTool('opencode_tools', 'List the tool ids exposed by the configured OpenCode servers (built-in tools plus MCP/custom). Read-only. v1 only: OpenCode 2 removed /experimental/tool/ids.', collectToolIds, 'server(s)')
  catalogTool('opencode_references', 'List project references configured on the configured OpenCode servers. Read-only.', collectReferences, 'reference(s)')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_command',
      description: 'Run one OpenCode command (for example /init) inside an existing remote session and return its final text. The session id comes from opencode_sessions.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id.' },
        command: { type: 'string', description: 'Command name without the leading slash (e.g. init).' },
        arguments: { type: 'string', description: 'Optional command arguments (may be empty).' },
        directory: { type: 'string', description: 'Optional remote directory override.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const command = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command.replace(/^\//, '') : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '' || command === '') return Promise.resolve('opencode_command: session and command are required')
        const commandArguments = args !== null && typeof args === 'object' && typeof args.arguments === 'string' ? args.arguments : ''
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
        return runCommand(server, session, command, commandArguments, directory).then(function (result) {
          return 'server ' + server.id + ' session ' + result.sessionId + ' /' + command + ':\n\n' + result.text
        }, function (error) {
          return 'opencode_command failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_command tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_shell',
      description: 'Run a shell command inside an existing remote OpenCode session and return its output. Use it for deterministic verification (git status, ls, build commands) without asking the remote agent to plan.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id.' },
        command: { type: 'string', description: 'Shell command to run on the remote machine.' },
        directory: { type: 'string', description: 'Optional remote directory override (OpenCode 1). OpenCode 2 runs the shell in this directory when given, else in the session workspace.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const command = args !== null && typeof args === 'object' && typeof args.command === 'string' ? args.command : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '' || command === '') return Promise.resolve('opencode_shell: session and command are required')
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
        return runShell(server, session, command, directory).then(function (result) {
          return 'server ' + server.id + ' session ' + result.sessionId + ' $ ' + command + '\n\n' + result.text
        }, function (error) {
          return 'opencode_shell failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_shell tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_git_status',
      description: 'Read the git working-tree status of a remote OpenCode workspace (changed files with additions/deletions). Read-only. Use it to verify what a remote agent changed.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        directory: { type: 'string', description: 'Remote directory; defaults to the server directory.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : server.directory
        return gitStatus(server, directory).then(function (result) {
          return 'server ' + server.id + (directory === undefined ? '' : ' ' + directory) + ': ' + result.files.length + ' changed file(s)\n' + result.text
        }, function (error) {
          return 'opencode_git_status failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_git_status tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_git_diff',
      description: 'Read the changed-file summary of a remote OpenCode workspace. mode=git (default, working tree), branch or committed; patch=true also includes per-file patches (truncated). Read-only.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        directory: { type: 'string', description: 'Remote directory; defaults to the server directory.' },
        mode: { type: 'string', description: 'git (default, working tree), branch or committed.' },
        patch: { type: 'boolean', description: 'Include per-file patches (truncated to 20k characters).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : server.directory
        const requestedMode = args !== null && typeof args === 'object' && typeof args.mode === 'string' ? args.mode : 'git'
        const mode = requestedMode === 'branch' || requestedMode === 'committed' ? requestedMode : 'git'
        const patch = args !== null && typeof args === 'object' && args.patch === true
        return gitDiff(server, directory, mode, patch).then(function (result) {
          return 'server ' + server.id + ' diff (' + mode + '):\n\n' + result.text
        }, function (error) {
          return 'opencode_git_diff failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_git_diff tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_read_file',
      description: 'Read one file from a remote OpenCode workspace (text). Read-only. Path is relative to the remote directory.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        directory: { type: 'string', description: 'Remote directory; defaults to the server directory.' },
        path: { type: 'string', description: 'File path relative to the remote directory.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const path = args !== null && typeof args === 'object' && typeof args.path === 'string' ? args.path : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (path === '') return Promise.resolve('opencode_read_file: path is required')
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : server.directory
        return readRemoteFile(server, directory, path).then(function (result) {
          return 'server ' + server.id + ' ' + path + (result.binary ? ' (binary)' : '') + ':\n\n' + result.text
        }, function (error) {
          return 'opencode_read_file failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_read_file tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_find',
      description: 'Search a remote OpenCode workspace. kind=file (default) searches file paths; kind=text searches file contents. Read-only. query is fuzzy/glob on OpenCode 1 and a plain substring on OpenCode 2 (glob characters are stripped as a fallback for file search). OpenCode 2 removed content search, so kind=text there runs a workspace grep through the shell and returns path:line: text (literal substring, first 100 matches).',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        directory: { type: 'string', description: 'Remote directory; defaults to the server directory.' },
        query: { type: 'string', description: 'Glob (file path search) or text pattern (content search).' },
        kind: { type: 'string', description: 'file (default) or text.' },
        limit: { type: 'number', description: 'Maximum file results (default 50, cap 200).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const query = args !== null && typeof args === 'object' && typeof args.query === 'string' ? args.query : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (query === '') return Promise.resolve('opencode_find: query is required')
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : server.directory
        const kind = args !== null && typeof args === 'object' && args.kind === 'text' ? 'text' : 'file'
        const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 50
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const pending = kind === 'text' ? findText(server, directory, query) : findFiles(server, directory, query, limit)
        return pending.then(function (result) {
          return 'server ' + server.id + ' ' + kind + ' search "' + query + '": ' + result.count + ' result(s)\n' + result.text
        }, function (error) {
          return 'opencode_find failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_find tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_fork',
      description: 'Fork one remote OpenCode session into a new branch conversation. Read-mostly: it only creates a new session. Use opencode_sessions afterwards to find the new id.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id to fork.' },
        message: { type: 'string', description: 'Optional message id to fork at.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '') return Promise.resolve('opencode_fork: session is required')
        const message = args !== null && typeof args === 'object' && typeof args.message === 'string' ? args.message : undefined
        return forkSession(server, session, message).then(function (created) {
          return 'forked ' + session + ' -> ' + created.id + ' | ' + created.title
        }, function (error) {
          return 'opencode_fork failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_fork tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_summarize',
      description: 'Summarize/compact one remote OpenCode session. Mutating: it updates the session history summary. OpenCode 1 requires model "provider/model" from opencode_models; OpenCode 2 maps this to compact and uses the session\'s own model.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id.' },
        model: { type: 'string', description: 'Model as "providerID/modelID" (from opencode_models); OpenCode 2 also accepts "providerID/modelID#variant".' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
        if (session === '') return Promise.resolve('opencode_summarize: session is required')
        if (model === undefined && apiVersionOf(server) !== '2') return Promise.resolve('opencode_summarize: session and model "provider/model" are required')
        return summarize(server, session, model === undefined ? undefined : model.providerID, model === undefined ? undefined : model.modelID).then(function (done) {
          return done ? 'summarized ' + session + ' on ' + server.id : 'summarize returned false for ' + session
        }, function (error) {
          return 'opencode_summarize failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_summarize tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_init',
      description: 'Run the remote /init flow (writes/updates AGENTS.md in the session workspace). Mutating: requires confirm=true. OpenCode 1 requires a remote model "provider/model"; OpenCode 2 runs the built-in init command with the session\'s own agent/model.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id whose directory receives AGENTS.md.' },
        model: { type: 'string', description: 'Model as "providerID/modelID".' },
        confirm: { type: 'boolean', description: 'Must be true; init writes AGENTS.md.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
        if (args === null || typeof args !== 'object' || args.confirm !== true) return Promise.resolve('opencode_init: confirm must be true (it writes AGENTS.md)')
        if (session === '') return Promise.resolve('opencode_init: session is required')
        if (model === undefined && apiVersionOf(server) !== '2') return Promise.resolve('opencode_init: session and model "provider/model" are required')
        return initSession(server, session, model === undefined ? undefined : model.providerID, model === undefined ? undefined : model.modelID).then(function (done) {
          return done ? 'initialized ' + session + ' on ' + server.id + ' (AGENTS.md written)' : 'init returned false for ' + session
        }, function (error) {
          return 'opencode_init failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_init tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_children',
      description: 'List child sessions created from one remote OpenCode session (e.g. by opencode subagents). Read-only.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote parent session id.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '') return Promise.resolve('opencode_children: session is required')
        return sessionChildren(server, session).then(function (result) {
          return 'server ' + server.id + ' session ' + session + ': ' + result.count + ' child session(s)\n' + result.text
        }, function (error) {
          return 'opencode_children failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_children tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_progress',
      description: 'Show live progress of active remote OpenCode runs (current tool/step, elapsed time, output tail). Read-only. Use it while a long delegation is running; it is also exposed as GET /api/opencode-client/progress.',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        const lines = []
        let chain = Promise.resolve()
        for (const server of servers) {
          if (serverId !== undefined && server.id !== serverId) continue
          chain = chain.then(function () {
            const rows = []
            if (server.progress instanceof Map) {
              for (const entry of server.progress.entries()) {
                const progress = entry[1]
                if (progress === null || typeof progress !== 'object' || progress.status === 'idle') continue
                const elapsed = typeof progress.since === 'number' ? Math.max(0, Math.round((Date.now() - progress.since) / 1000)) : null
                rows.push('- [' + server.id + '] ' + entry[0] + ': ' + (progress.tool === null || progress.tool === undefined ? progress.status : progress.status + ' · ' + progress.tool) + (elapsed === null ? '' : ' (' + String(elapsed) + 's)') + (typeof progress.tail === 'string' && progress.tail !== '' ? '\n  tail: ' + progress.tail.replace(/\s+/g, ' ').slice(-200) : ''))
              }
            }
            if (rows.length > 0) {
              for (const line of rows) lines.push(line)
              return
            }
            return collectStatus(server).then(function (statuses) {
              const running = Object.keys(statuses).filter(function (sessionId) {
                const status = statuses[sessionId]
                return status !== null && typeof status === 'object' && status.type !== 'idle'
              })
              if (running.length === 0) lines.push('- [' + server.id + '] no active run')
              else for (const sessionId of running) lines.push('- [' + server.id + '] ' + sessionId + ': ' + String(statuses[sessionId].type) + ' (no progress event yet)')
            }, function () { lines.push('- [' + server.id + '] offline') })
          })
        }
        return chain.then(function () { return lines.length === 0 ? 'no active run' : lines.join('\n') })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_progress tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_search',
      description: 'Search sessions on the configured OpenCode servers by title text (v2 API, falls back to v1 filtering). Read-only. Use it when there are many sessions and opencode_sessions is too broad.',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
        query: { type: 'string', description: 'Text to search for in session titles.' },
        directory: { type: 'string', description: 'Optional directory filter.' },
        limit: { type: 'number', description: 'Maximum results (default 20, cap 100).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        const query = args !== null && typeof args === 'object' && typeof args.query === 'string' ? args.query : ''
        if (query === '') return Promise.resolve('opencode_search: query is required')
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
        const rawLimit = args !== null && typeof args === 'object' && typeof args.limit === 'number' ? args.limit : 20
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20
        return collectSessionSearch(servers, serverId, query, limit, directory).then(function (result) {
          return result.count + ' session(s) matching "' + query + '":\n' + result.text
        }, function (error) {
          return 'opencode_search failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_search tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_mcp',
      description: 'List MCP server status on the configured OpenCode servers (connected/needs_auth/disabled). Read-only; connect/disconnect/auth is a remote-admin operation and is not exposed.',
      parameters: {
        server: { type: 'string', description: 'Only this OpenCode server id; omit for all.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        return collectMcpStatus(servers, serverId).then(function (result) {
          return result.count + ' MCP server(s):\n' + result.text
        }, function (error) {
          return 'opencode_mcp failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_mcp tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_abort',
      description: 'Abort a running remote OpenCode session (v1 POST /session/{id}/abort, v2 POST /session/{id}/interrupt). Use it to stop a stuck or runaway remote run. NOTE: dsh serializes tool calls inside one turn, so call this from ANOTHER session/agent (or while the run was started asynchronously); calling it in the same turn as a blocking opencode_subagent will queue behind that call. The waiting delegation then returns an abort error instead of hanging.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id to abort.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '') return Promise.resolve('opencode_abort: session is required')
        return abortSession(server, session).then(function (aborted) {
          return aborted
            ? 'aborted ' + session + ' on ' + server.id
            : 'nothing to interrupt: ' + session + ' on ' + server.id + ' is idle (interrupted=false)' 
        }, function (error) {
          return 'opencode_abort failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_abort tool')

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_prompt',
      description: 'Send one message to an existing remote OpenCode session. Default is fire-and-forget: it returns as soon as the server accepts it, the remote keeps working, and you read that turn later with opencode_messages / opencode_progress, then send the next message. This makes a remote session continuable across dsh turns (unlike the one-shot native opencode_subagent_<server> tools). Pass wait=true to block until this turn finishes and get its final text.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id (existing).' },
        message: { type: 'string', description: 'Message to send to the remote agent.' },
        wait: { type: 'boolean', description: 'Block until this turn finishes and return the final text (default false).' },
        agent: { type: 'string', description: 'Optional remote agent name for this turn.' },
        model: { type: 'string', description: 'Optional remote model as "providerID/modelID".' },
        directory: { type: 'string', description: 'Optional remote directory override.' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const message = args !== null && typeof args === 'object' && typeof args.message === 'string' ? args.message : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        if (session === '' || message === '') return Promise.resolve('opencode_prompt: session and message are required')
        const turn = {}
        if (args !== null && typeof args === 'object' && typeof args.agent === 'string' && args.agent !== '') turn.agent = args.agent
        const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
        if (model !== undefined) turn.model = model
        const wait = args !== null && typeof args === 'object' && args.wait === true
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : undefined
        return buildPrompt(server, message, turn).then(function (body) {
          return sendSessionMessage(server, session, body, { wait: wait, directory: directory, agent: turn.agent, model: turn.model })
        }).then(function (result) {
          if (result.waited === true) return 'server ' + server.id + ' session ' + session + ':\n\n' + (result.text === '' ? '(no text)' : result.text)
          return result.accepted === true
            ? 'sent to ' + session + ' on ' + server.id + '; read the reply with opencode_messages or opencode_progress, then send the next message'
            : 'opencode_prompt: server did not accept the message (status ' + String(result.status) + ')'
        }, function (error) {
          return 'opencode_prompt failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_prompt tool')
}