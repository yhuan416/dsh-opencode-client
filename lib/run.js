/** One-shot delegation into an OpenCode session (new or continued). */
import { asyncPrompt, buildPrompt, promptFailureMessage } from './delegate.js'
import { ensureSession, trackRun, prepareTurn } from './session-run.js'
import { invalidateSnapshot } from './snapshot.js'

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
  const subscribeIdle = options.subscribeIdle
  const ledger = options.ledger

  return async function delegate(server, directory, task, sessionId, opts) {
    const continuing = typeof sessionId === 'string' && sessionId !== ''
    const effectiveDirectory = continuing ? undefined : directory
    const jsonSchema = opts !== undefined ? opts.jsonSchema : undefined
    const instruction = jsonSchema === undefined ? '' : '\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n' + JSON.stringify(jsonSchema)
    const promptTask = task + instruction
    const row = ledger === undefined || ledger === null ? null : ledger.begin({
      kind: 'delegate',
      server: server.id,
      task: task,
      directory: directory,
      model: opts !== undefined ? opts.model : undefined,
    })
    let id
    try {
      id = await ensureSession(server, {
        sessionId: continuing ? sessionId : undefined,
        title: 'dsh delegate',
        directory: directory,
        agent: opts !== undefined ? opts.agent : undefined,
        model: opts !== undefined ? opts.model : undefined,
        errorPrefix: 'opencode: cannot create a session on ' + server.id,
      })
    } catch (error) {
      if (row !== null) ledger.finish(row, { stopReason: 'error', error: error })
      throw error
    }
    if (row !== null) ledger.attach(row, id)
    const finish = trackRun(server, id, {
      directory: effectiveDirectory,
      agent: opts !== undefined ? opts.dshAgent : undefined,
      signal: opts !== undefined ? opts.signal : undefined,
      watchInteractions: watchInteractions,
      activeRuns: activeRuns,
    })
    try {
      // v2 keeps agent/model as session state: fresh sessions got them at
      // creation, continued sessions need them applied before the prompt.
      if (continuing && opts !== undefined) await prepareTurn(server, id, opts)
      const prompt = await buildPrompt(server, promptTask, opts)
      const signal = opts !== undefined ? opts.signal : undefined
      const outcome = await asyncPrompt(server, id, prompt, effectiveDirectory, signal, subscribeIdle)
      finish()
      invalidateSnapshot(server)
      const structured = outcome.structured !== undefined ? outcome.structured : (jsonSchema === undefined ? undefined : parseStructured(outcome.text, jsonSchema))
      if (row !== null) ledger.finish(row, { stopReason: outcome.finish === 'length' ? 'max-tokens' : 'completed' })
      return { sessionId: id, text: outcome.text === '' ? '(remote agent returned no text)' : outcome.text, structured: structured }
    } catch (error) {
      finish()
      if (row !== null) ledger.finish(row, { stopReason: 'error', error: error })
      if (error !== null && typeof error === 'object' && error.name === 'OpenCodeError') throw new Error(promptFailureMessage(error, server, effectiveDirectory))
      throw error
    }
  }
}