/** Native dsh subagent provider backed by one OpenCode server. */
import { promptBody, asyncPrompt } from './delegate.js'
import { ensureSession, trackRun, abortRemote } from './session-run.js'

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
 * External subagent backend over one OpenCode server.
 * Implements the dsh out-of-process seam: start(request) -> { id, result, dispose },
 * result resolves (never rejects) to { output, stopReason, diagnostic? }.
 */
export function createProvider(server, options) {
  const pathMap = options.pathMap
  const watchInteractions = options.watchInteractions
  const activeRuns = options.activeRuns
  const subscribeIdle = options.subscribeIdle

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
      title: 'dsh subagent: ' + label,
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
      const result = asyncPrompt(server, sessionId, promptBody(server, task), directory, controller.signal, subscribeIdle).then(function (outcome) {
        const text = typeof outcome.text === 'string' ? outcome.text : ''
        return settle({ output: text === '' ? [] : [{ type: 'text', text: text }], stopReason: 'completed' })
      }, function (error) {
        const message = String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
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
