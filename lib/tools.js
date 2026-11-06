/** Model-facing dsh tools for the OpenCode client. */
import { parseModel } from './config.js'
import { collectStatus, abortSession } from './sessions.js'

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
        if (task === '') return Promise.resolve('opencode_delegate: task is required')
        return delegate(target, directory, task, session, opts).then(function (outcome) {
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
      description: 'Read the last messages of one remote OpenCode session (text, tool and file content). Read-only. Use it to decide whether a session is the right one to continue.',
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

  effect(function () {
    const dispose = tools.register(dshTools.defineTool({
      name: 'opencode_agents',
      description: 'List agents advertised by the configured OpenCode servers (primary and subagent, native/custom). Read-only. Use it before opencode_delegate when you need to pick an agent name (build/plan/explore/general/...).',
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

  effect(function () {
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

  catalogTool('opencode_models', 'List LLM providers and model ids available on the configured OpenCode servers (credentials are never returned). Read-only. Use it to pick a "provider/model" for opencode_delegate.', collectModels, 'provider(s)')
  catalogTool('opencode_commands', 'List custom OpenCode commands (name, description, agent/model) available on the configured servers. Read-only. Execute one with opencode_command.', collectCommands, 'command(s)')
  catalogTool('opencode_skills', 'List Agent Skills visible to the configured OpenCode servers (name, description, location; contents omitted). Read-only.', collectSkills, 'skill(s)')
  catalogTool('opencode_tools', 'List the tool ids exposed by the configured OpenCode servers (built-in tools plus MCP/custom). Read-only.', collectToolIds, 'server(s)')
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
        directory: { type: 'string', description: 'Optional remote directory override.' },
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
      description: 'Read the changed-file summary of a remote OpenCode workspace. mode=git (default, working tree) or branch; patch=true also includes per-file patches (truncated). Read-only.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        directory: { type: 'string', description: 'Remote directory; defaults to the server directory.' },
        mode: { type: 'string', description: 'git (default) or branch.' },
        patch: { type: 'boolean', description: 'Include per-file patches (truncated to 20k characters).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const directory = args !== null && typeof args === 'object' && typeof args.directory === 'string' && args.directory !== '' ? args.directory : server.directory
        const mode = args !== null && typeof args === 'object' && args.mode === 'branch' ? 'branch' : 'git'
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
      description: 'Search a remote OpenCode workspace. kind=file (default) searches file paths; kind=text searches file contents. Read-only.',
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
      description: 'Summarize/compact one remote OpenCode session (uses the given remote model). Mutating: it updates the session history summary. Requires model "provider/model" from opencode_models.',
      parameters: {
        server: { type: 'string', description: 'OpenCode server id.' },
        session: { type: 'string', description: 'Remote session id.' },
        model: { type: 'string', description: 'Model as "providerID/modelID" (from opencode_models).' },
      },
      output: { schema: { type: 'string' }, render: function (_args, result) { return [{ type: 'text', text: result }] } },
      execute: function (args) {
        const serverId = args !== null && typeof args === 'object' && typeof args.server === 'string' ? args.server : ''
        const session = args !== null && typeof args === 'object' && typeof args.session === 'string' ? args.session : ''
        const server = servers.find(function (candidate) { return candidate.id === serverId }) || defaultServer
        const model = parseModel(args !== null && typeof args === 'object' ? args.model : undefined)
        if (session === '' || model === undefined) return Promise.resolve('opencode_summarize: session and model "provider/model" are required')
        return summarize(server, session, model.providerID, model.modelID).then(function (done) {
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
      description: 'Run the remote /init flow (writes/updates AGENTS.md in the session workspace). Mutating: requires confirm=true. Requires a remote model "provider/model".',
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
        if (session === '' || model === undefined) return Promise.resolve('opencode_init: session and model "provider/model" are required')
        return initSession(server, session, model.providerID, model.modelID).then(function (done) {
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
      description: 'Abort a running remote OpenCode session (sends POST /session/{id}/abort). Use it to stop a stuck or runaway remote run. NOTE: dsh serializes tool calls inside one turn, so call this from ANOTHER session/agent (or while the run was started asynchronously); calling it in the same turn as a blocking opencode_delegate will queue behind that call. The waiting delegation then returns an abort error instead of hanging.',
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
          return aborted ? 'aborted ' + session + ' on ' + server.id : 'abort returned false for ' + session
        }, function (error) {
          return 'opencode_abort failed: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
        })
      },
    }))
    return function () { try { dispose() } catch {} }
  }, 'opencode-client: opencode_abort tool')
}
