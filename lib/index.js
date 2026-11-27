/**
 * dsh-opencode-client — dsh as an OpenCode client.
 *
 * OpenCode's own architecture: `opencode serve` exposes an OpenAPI HTTP server
 * "that an opencode client can use"; the TUI/web/SDK are clients of that server.
 * This plugin is another client, hosted inside dsh: server configuration, project
 * and session discovery, message reading, delegation, approval/question bridging,
 * SSE live state, and a native dsh subagent provider.
 */
import { normalizeServers, parsePathMap } from './config.js'
import { ensureApiVersion, describeApiVersion } from './http.js'
import { loadDshTools } from './dsh-tools.js'
import { createInteractions, questionPolicyOf } from './interactions.js'
import { createEventStream } from './sse.js'
import { createObservation } from './observation.js'
import { createBoard } from './board.js'
import { normalizeServers as normalizeServerList } from './config.js'
import { createProvider, createRoutedProvider, mapDirectory } from './provider.js'
import { createDelegate } from './run.js'
import { normalizeRouting } from './routing.js'
import { createRoutes } from './routes.js'
import { createAbout } from './about.js'
import { registerTools } from './tools.js'
import { collectSessionRows, readMessages, collectAgents, collectSessionInfo, shareSession, abortSession, collectStats } from './sessions.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus } from './catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from './workspace.js'
import { forkSession, summarize, initSession, sessionChildren } from './manage.js'
import { scheduleWarm } from './warm.js'

export const name = 'opencode-client'
export const inject = ['connection']

export async function apply(ctx, config) {
  const cfg = config === undefined || config === null ? {} : config
  const servers = normalizeServers(cfg.servers)
  for (const server of servers) {
    // Probe once at startup so the chosen API version (and any v1 fallback reason) is logged.
    ensureApiVersion(server).then(function (info) {
      const line = 'opencode-client: server ' + server.id + ' API ' + describeApiVersion(info)
      if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info(line)
    }).catch(function () {})
  }
  // The first board page must not pay for a cold 7-day history scan (~9 s measured):
  // warm board / insights / activity during the first idle window (best effort,
  // unref'd timer). A profile reload cancels it when the plugin is disposed.
  scheduleWarm(servers, { delayMs: typeof cfg.warmupMs === 'number' ? cfg.warmupMs : undefined })
  // `auto` restores the pre-observation behaviour: answer requests no run owns instead of recording them.
  const permissionMode = cfg.permission === 'reject'
    ? 'reject'
    : (cfg.permission === 'auto' ? 'auto' : (cfg.permission === 'allow' || cfg.permission === 'always' ? 'allow' : 'ask'))
  const permission = permissionMode === 'reject' ? 'reject' : 'always'
  // Questions from a session dsh did not start are kept pending by default, so
  // the board's "needs you" row and the attention toast can surface them; only
  // an explicit `question: reject` dismisses them (unattended deployments).
  const questionPolicy = questionPolicyOf(cfg.question)
  const pathMap = parsePathMap(cfg.pathMap)
  const routing = normalizeRouting(cfg.routing, servers.length)
  const activeRuns = new Map()
  const observation = createObservation({
    staleAfterMs: typeof cfg.staleAfterMs === 'number' && cfg.staleAfterMs > 0 ? cfg.staleAfterMs : undefined,
  })
  const dshTools = await loadDshTools()

  let userQuestionsService
  ctx.inject(['userQuestions'], function (subCtx) {
    userQuestionsService = subCtx.userQuestions !== undefined ? subCtx.userQuestions : (typeof subCtx.get === 'function' ? subCtx.get('userQuestions') : undefined)
  })
  let approvalService
  ctx.inject(['approval'], function (subCtx) {
    approvalService = subCtx.approval !== undefined ? subCtx.approval : (typeof subCtx.get === 'function' ? subCtx.get('approval') : undefined)
  })

  const interactions = createInteractions({
    permissionMode: permissionMode,
    permission: permission,
    questionPolicy: questionPolicy,
    activeRuns: activeRuns,
    getUserQuestions: function () { return userQuestionsService },
    getApproval: function () { return approvalService },
    markPending: function (server, sessionId, pending) { observation.markPending(server.id, sessionId, pending) },
  })
  const board = createBoard({ servers: servers, observation: observation })

  // Config write-back goes through dsh's config editor: it owns the profile patch,
  // validates, serializes with HMR and restarts this plugin so `apply` rebuilds the
  // server list. Never parse or rewrite cordis.patch.yml ourselves.
  function configEditor() {
    const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined
    const entry = ctx.fiber !== undefined && ctx.fiber !== null ? ctx.fiber.entry : undefined
    if (editor === undefined || entry === undefined || typeof editor.edit !== 'function') return undefined
    return { editor: editor, entry: entry }
  }
  const configApi = {
    available: function () { return configEditor() !== undefined },
    add: function (server) {
      const handle = configEditor()
      if (handle === undefined) return Promise.resolve({ ok: false, error: '当前 profile 未挂载 config-editor，无法从界面保存' })
      return handle.editor.edit(handle.entry, function (current) {
        const list = Array.isArray(current.servers) ? current.servers : []
        const next = list.filter(function (item) { return item !== null && typeof item === 'object' && String(item.id) !== String(server.id) })
        next.push(server)
        return Object.assign({}, current, { servers: next })
      }).then(function () { return { ok: true } }, function (error) { return { ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) } })
    },
    // Rename / re-point / re-password an existing remote. Fields that are absent
    // stay untouched — above all `password`, which is never sent to the client:
    // POST /servers replaces the whole entry, so editing through it would drop
    // the password and the remote would come back as 401.
    update: function (id, fields) {
      const handle = configEditor()
      if (handle === undefined) return Promise.resolve({ ok: false, error: '当前 profile 未挂载 config-editor，无法从界面保存' })
      let found = false
      return handle.editor.edit(handle.entry, function (current) {
        const list = Array.isArray(current.servers) ? current.servers : []
        const next = list.map(function (item) {
          if (item === null || typeof item !== 'object' || String(item.id) !== String(id)) return item
          found = true
          const entry = Object.assign({}, item)
          if (fields.label !== undefined) {
            if (fields.label === '') delete entry.label
            else entry.label = fields.label
          }
          if (fields.url !== undefined) entry.url = fields.url
          if (fields.directory !== undefined) {
            if (fields.directory === '') delete entry.directory
            else entry.directory = fields.directory
          }
          if (fields.password !== undefined && fields.password !== '') entry.password = fields.password
          return entry
        })
        return found ? Object.assign({}, current, { servers: next }) : current
      }).then(function () {
        return found ? { ok: true } : { ok: false, error: '没有找到 id 为 ' + id + ' 的远端' }
      }, function (error) { return { ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) } })
    },
    remove: function (id) {
      const handle = configEditor()
      if (handle === undefined) return Promise.resolve({ ok: false, error: '当前 profile 未挂载 config-editor，无法从界面保存' })
      return handle.editor.edit(handle.entry, function (current) {
        const list = Array.isArray(current.servers) ? current.servers : []
        return Object.assign({}, current, { servers: list.filter(function (item) { return item === null || typeof item !== 'object' || String(item.id) !== String(id) }) })
      }).then(function () { return { ok: true } }, function (error) { return { ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) } })
    },
  }
  const events = createEventStream({
    activeRuns: activeRuns,
    handlePermission: interactions.handlePermission,
    handleQuestion: interactions.handleQuestion,
    onEvent: function (server, event) { observation.observeEvent(server.id, event) },
  })
  const delegate = createDelegate({
    watchInteractions: interactions.watchInteractions,
    activeRuns: activeRuns,
    subscribeIdle: events.subscribeIdle,
  })

  // The About block's data: this package's own version and repository, plus
  // whether the Host itself can update this installation (pluginManager lists
  // `update: 'registry' | 'git'`; a path link has none).
  const about = createAbout({
    manager: function () { return typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined },
  })

  ctx.effect(function () {
    const disposers = []
    for (const route of createRoutes({ servers: servers, delegate: delegate, observation: observation, board: board, config: configApi, normalizeServers: normalizeServerList, about: about })) {
      // One conflicting route must not unregister every other route.
      try {
        const registered = ctx.connection.fetch.register(route)
        if (typeof registered === 'function') disposers.push(registered)
      } catch (error) {
        if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn('opencode-client: route ' + route.path + ' not registered: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
        }
      }
    }
    return function () {
      for (const dispose of disposers) { try { dispose() } catch {} }
    }
  }, 'opencode-client: HTTP routes')

  ctx.effect(function () {
    const disposers = servers.map(function (server) { return events.subscribeEvents(server) })
    return function () {
      for (const dispose of disposers) { try { dispose() } catch {} }
    }
  }, 'opencode-client: SSE subscriptions')

  ctx.inject(['subagents'], function (subCtx) {
    const subagents = subCtx.subagents !== undefined ? subCtx.subagents : (typeof subCtx.get === 'function' ? subCtx.get('subagents') : undefined)
    if (subagents === undefined || typeof subagents.registerProvider !== 'function') return
    const providerOptions = {
      pathMap: pathMap,
      watchInteractions: interactions.watchInteractions,
      activeRuns: activeRuns,
      subscribeIdle: events.subscribeIdle,
    }
    for (const server of servers) {
      try {
        subagents.registerProvider(createProvider(server, providerOptions))
      } catch (error) {
        if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('opencode-client: cannot register provider opencode-' + server.id + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
      }
    }
    if (routing.enabled && servers.length > 0) {
      try {
        subagents.registerProvider(createRoutedProvider(servers, Object.assign({}, providerOptions, {
          routing: routing,
          mapCwd: function (server, cwd) { return mapDirectory(pathMap, server, cwd) },
          logger: ctx.logger,
        })))
        if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
          ctx.logger.info('opencode-client: routed provider ' + routing.providerName + ' over ' + servers.map(function (server) { return server.id }).join(' → ') + ' (policies: ' + routing.policies.join(', ') + ')')
        }
      } catch (error) {
        if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('opencode-client: cannot register routed provider ' + routing.providerName + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
      }
    }
  })

  if (dshTools !== undefined) {
    ctx.inject(['tools'], function (subCtx) {
      const tools = subCtx.tools !== undefined ? subCtx.tools : (typeof subCtx.get === 'function' ? subCtx.get('tools') : undefined)
      if (tools === undefined || typeof tools.register !== 'function' || servers[0] === undefined) return
      registerTools({
        board: board,
        collectStats: collectStats,
        toolsService: tools,
        dshTools: dshTools,
        servers: servers,
        delegate: delegate,
        collectSessionRows: collectSessionRows,
        readMessages: readMessages,
        collectAgents: collectAgents,
        collectSessionInfo: collectSessionInfo,
        shareSession: shareSession,
        collectModels: collectModels,
        collectCommands: collectCommands,
        collectSkills: collectSkills,
        collectToolIds: collectToolIds,
        collectReferences: collectReferences,
        runCommand: runCommand,
        collectSessionSearch: collectSessionSearch,
        collectMcpStatus: collectMcpStatus,
        abortSession: abortSession,
        runShell: runShell,
        gitStatus: gitStatus,
        gitDiff: gitDiff,
        readRemoteFile: readRemoteFile,
        findFiles: findFiles,
        findText: findText,
        forkSession: forkSession,
        summarize: summarize,
        initSession: initSession,
        sessionChildren: sessionChildren,
        effect: function (fn, label) { return ctx.effect(fn, label) },
      })
    })
  }

  const line = 'opencode-client: ' + String(servers.length) + ' server(s): ' + servers.map(function (server) { return server.id }).join(', ')
  if (ctx.logger !== undefined && typeof ctx.logger.info === 'function') ctx.logger.info(line)
  else console.log(line)
}
