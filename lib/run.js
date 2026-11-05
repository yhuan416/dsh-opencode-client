/** One-shot delegation into an OpenCode session (new or continued). */
import { asyncPrompt } from './delegate.js'
import { promptBody } from './delegate.js'
import { opencodeRequest } from './http.js'

/** Prompt-enforced JSON: ask for JSON and validate locally (opencode format= is broken upstream). */
export function parseStructured(text, schema) {
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

export function createDelegate(options) {
  const watchInteractions = options.watchInteractions
  const activeRuns = options.activeRuns

  return function delegate(server, directory, task, sessionId, opts) {
    const continuing = typeof sessionId === 'string' && sessionId !== ''
    const effectiveDirectory = continuing ? undefined : directory
    const jsonSchema = opts !== undefined ? opts.jsonSchema : undefined
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
          agent: opts !== undefined ? opts.dshAgent : undefined,
          signal: opts !== undefined ? opts.signal : undefined,
        })
      }
      const stopWatching = watchInteractions(server, id, effectiveDirectory)
      const finish = function () { stopWatching(); activeRuns.delete(id) }
      const prompt = promptBody(server, promptTask, opts)
      const signal = opts !== undefined ? opts.signal : undefined
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
}
