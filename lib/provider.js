/** Native dsh subagent provider backed by one OpenCode server. */
import { opencodeRequest } from './http.js'
import { promptBody } from './delegate.js'

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

export function createProvider(server, options) {
  const pathMap = options.pathMap
  const watchInteractions = options.watchInteractions
  const activeRuns = options.activeRuns

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

  return {
    name: 'opencode-' + server.id,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start: function (request) { return startRun(request) },
  }
}
