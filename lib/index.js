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
import { opencodeRequest } from './http.js'
import { loadDshTools } from './dsh-tools.js'
import { createInteractions } from './interactions.js'
import { createEventStream } from './sse.js'
import { createProvider } from './provider.js'
import { createDelegate } from './run.js'
import { createRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { collectSessionRows, readMessages, collectAgents, collectSessionInfo, shareSession } from './sessions.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus } from './catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from './workspace.js'
import { forkSession, summarize, initSession, sessionChildren } from './manage.js'

export const name = 'opencode-client'
export const inject = ['connection']

export async function apply(ctx, config) {
  const cfg = config === undefined || config === null ? {} : config
  const servers = normalizeServers(cfg.servers)
  const permissionMode = cfg.permission === 'reject' ? 'reject' : (cfg.permission === 'allow' || cfg.permission === 'always' ? 'allow' : 'ask')
  const permission = permissionMode === 'reject' ? 'reject' : 'always'
  const questionPolicy = cfg.question === 'ignore' ? 'ignore' : 'reject'
  const pathMap = parsePathMap(cfg.pathMap)
  const activeRuns = new Map()
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
  })
  const events = createEventStream({
    activeRuns: activeRuns,
    handlePermission: interactions.handlePermission,
    handleQuestion: interactions.handleQuestion,
  })
  const delegate = createDelegate({
    watchInteractions: interactions.watchInteractions,
    activeRuns: activeRuns,
    subscribeIdle: events.subscribeIdle,
  })

  ctx.effect(function () {
    const disposers = []
    for (const route of createRoutes({ servers: servers, delegate: delegate })) {
      const registered = ctx.connection.fetch.register(route)
      if (typeof registered === 'function') disposers.push(registered)
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
    for (const server of servers) {
      try {
        subagents.registerProvider(createProvider(server, {
          pathMap: pathMap,
          watchInteractions: interactions.watchInteractions,
          activeRuns: activeRuns,
        }))
      } catch (error) {
        if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') ctx.logger.warn('opencode-client: cannot register provider opencode-' + server.id + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
      }
    }
  })

  if (dshTools !== undefined) {
    ctx.inject(['tools'], function (subCtx) {
      const tools = subCtx.tools !== undefined ? subCtx.tools : (typeof subCtx.get === 'function' ? subCtx.get('tools') : undefined)
      if (tools === undefined || typeof tools.register !== 'function' || servers[0] === undefined) return
      registerTools({
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
