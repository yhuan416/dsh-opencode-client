/** Native dsh subagent provider backed by one OpenCode server. */
import { buildPrompt, asyncPrompt, promptFailureMessage } from './delegate.js'
import { ensureSession, trackRun, abortRemote } from './session-run.js'
import { createRouter } from './routing.js'

export function mapDirectory(pathMap, server, cwd) {
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

/** Flatten dsh ContentBlock[] into the text the remote agent receives. */
export function promptText(prompt) {
  if (!Array.isArray(prompt)) return ''
  const parts = []
  for (const block of prompt) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Map one completed OpenCode turn onto dsh's `SubagentResult.stopReason`.
 * OpenCode's `finish` is `stop | length | tool-calls | content-filter | error |
 * unknown` on v2 (adapter-specific on v1); dsh can name `max-tokens` and
 * `refusal`, which gives the parent an accurate settlement line ("ran out of
 * room" / "declined the task") instead of a generic success/failure.
 */
export function stopReasonFor(outcome, aborted) {
  if (aborted === true) return 'aborted'
  const value = outcome !== null && typeof outcome === 'object' ? outcome : {}
  if (value.finish === 'length') return 'max-tokens'
  if (value.finish === 'content-filter') return 'refusal'
  if (value.finish === 'error') return 'error'
  if (value.error !== undefined && value.error !== null) return 'error'
  return 'completed'
}

/**
 * External subagent backend over one OpenCode server.
 * Implements the dsh out-of-process seam: start(request) -> { id, result, dispose },
 * result resolves (never rejects) to { output, stopReason, diagnostic? }.
 */
export function createProvider(server, options) {
  const pathMap = options.pathMap
  const watchInteractions = options.watchInteractions
  const activeRuns = options.activeRuns
  const subscribeIdle = options.subscribeIdle
  const titleSuffix = typeof options.titleSuffix === 'string' ? options.titleSuffix : ''

  function startRun(request) {
    const controller = new AbortController()
    const parentSignal = request.signal
    const onAbort = function () { controller.abort() }
    if (parentSignal !== undefined && parentSignal !== null) {
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', onAbort, { once: true })
    }
    const label = typeof request.label === 'string' && request.label !== '' ? request.label : 'dsh subagent'
    const directory = mapDirectory(pathMap, server, request.cwd)
    const task = promptText(request.prompt) || '(empty task)'
    const detach = function () {
      if (parentSignal !== undefined && parentSignal !== null) parentSignal.removeEventListener('abort', onAbort)
    }
    return ensureSession(server, {
      title: 'dsh subagent: ' + label + titleSuffix,
      directory: directory,
      errorPrefix: 'opencode provider ' + server.id + ': cannot create a session in ' + (directory === undefined ? 'the server default directory' : directory),
    }).then(function (sessionId) {
      // The parent Agent is required for approval cards / user questions to reach
      // the right dsh agent; without it the interaction bridge falls back to allow/reject.
      const stopTracking = trackRun(server, sessionId, {
        directory: directory,
        agent: request.parent,
        signal: controller.signal,
        watchInteractions: watchInteractions,
        activeRuns: activeRuns,
      })
      const settle = function (result) {
        stopTracking()
        detach()
        return result
      }
      const result = buildPrompt(server, task).then(function (body) {
        return asyncPrompt(server, sessionId, body, directory, controller.signal, subscribeIdle)
      }).then(function (outcome) {
        const text = typeof outcome.text === 'string' ? outcome.text : ''
        const result = { output: text === '' ? [] : [{ type: 'text', text: text }], stopReason: stopReasonFor(outcome, controller.signal.aborted) }
        if (result.stopReason === 'max-tokens' || result.stopReason === 'refusal') {
          // dsh treats these as abnormal endings; keep one bounded diagnostic line.
          result.diagnostic = 'opencode: the remote turn ended with finish=' + String(outcome.finish)
        }
        return settle(result)
      }, function (error) {
        const message = promptFailureMessage(error, server, directory)
        if (controller.signal.aborted || message.indexOf('aborted') >= 0) {
          abortRemote(server, sessionId)
          return settle({ output: [], stopReason: 'aborted' })
        }
        const diagnostic = message.length > 4096 ? message.slice(0, 4096) : message
        return settle({ output: [], stopReason: 'error', diagnostic: diagnostic })
      })
      let disposal
      return {
        id: sessionId,
        result: result,
        dispose: function () {
          if (disposal !== undefined) return disposal
          controller.abort()
          disposal = abortRemote(server, sessionId).then(function () { return result }).catch(function () {})
          return disposal
        },
      }
    })
  }

  return {
    name: 'opencode-' + server.id,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start: function (request) { return startRun(request) },
  }
}

/**
 * Aggregated provider that routes each subagent start across `servers`
 * (`opencode-auto`). dsh binds a tool row to one provider, so automatic
 * per-call server choice has to live inside a provider; this one asks
 * `lib/routing.js` for ordered candidates and falls back to the next server
 * when a start fails before the run is published (transport/5xx/timeout).
 *
 * Options: everything `createProvider` accepts, plus
 * `routing` (normalized config), `mapCwd(server, cwd)` and `logger`.
 */
export function createRoutedProvider(servers, options) {
  const opts = options === undefined || options === null ? {} : options
  const routing = opts.routing !== undefined && opts.routing !== null ? opts.routing : {}
  const router = createRouter(servers, {
    policies: routing.policies,
    sticky: routing.sticky,
    stickyTtlMs: routing.stickyTtlMs,
    mapCwd: opts.mapCwd,
    statusCount: opts.statusCount,
  })
  const failover = routing.failover !== false
  const logger = opts.logger
  const makeProvider = typeof opts.makeProvider === 'function' ? opts.makeProvider : createProvider
  const perServer = new Map()
  for (const server of servers) {
    perServer.set(server.id, makeProvider(server, Object.assign({}, opts, { titleSuffix: ' @' + server.id })))
  }
  function note(message) {
    if (logger !== undefined && typeof logger.info === 'function') {
      try { logger.info('opencode-auto: ' + message) } catch (error) {}
    }
  }
  return {
    name: routing.providerName !== undefined && routing.providerName !== '' ? routing.providerName : 'opencode-auto',
    // Same honest advertisement as the per-server providers (P1 stopReason only).
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    async start(request) {
      const candidates = await router.order(request)
      let lastError
      for (const server of candidates) {
        const provider = perServer.get(server.id)
        if (provider === undefined) continue
        try {
          const run = await provider.start(request)
          router.report(server, request)
          note('routed ' + (typeof request.label === 'string' ? request.label : '(unlabelled)') + ' -> ' + server.id + ' (' + run.id + ')')
          return run
        } catch (error) {
          lastError = error
          note('start failed on ' + server.id + ': ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
          if (!failover) throw error
        }
      }
      throw lastError !== undefined ? lastError : new Error('opencode: no server available to start a subagent')
    },
    /** Candidate order for one request (exposed for diagnostics/tests). */
    route: function (request) { return router.order(request) },
    servers: servers.map(function (server) { return server.id }),
  }
}
