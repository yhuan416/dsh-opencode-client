/** One-shot delegation into an OpenCode session (new or continued). */
import { asyncPrompt, buildPrompt, promptFailureMessage } from './delegate.js'
import { ensureSession, trackRun, prepareTurn } from './session-run.js'
import { invalidateSnapshot } from './snapshot.js'
import { parseStructured } from './structured.js'
import { parentSessionId } from './provider.js'
import { snapshotUsage } from './run-usage.js'

export { matchesSchema, parseStructured } from './structured.js'


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
      parent: parentSessionId(opts !== undefined ? opts.dshAgent : undefined),
      usage: snapshotUsage(server),
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
      if (row !== null) ledger.finish(row, { stopReason: 'error', error: error, usage: snapshotUsage(server) })
      throw error
    }
    if (row !== null) ledger.attach(row, id)
    const signal = opts !== undefined ? opts.signal : undefined
    const finish = trackRun(server, id, {
      directory: effectiveDirectory,
      agent: opts !== undefined ? opts.dshAgent : undefined,
      signal: signal,
      watchInteractions: watchInteractions,
      activeRuns: activeRuns,
    })
    try {
      // v2 keeps agent/model as session state: fresh sessions got them at
      // creation, continued sessions need them applied before the prompt.
      if (continuing && opts !== undefined) await prepareTurn(server, id, opts)
      const prompt = await buildPrompt(server, promptTask, opts)
      const outcome = await asyncPrompt(server, id, prompt, effectiveDirectory, signal, subscribeIdle)
      finish()
      invalidateSnapshot(server)
      const structured = outcome.structured !== undefined ? outcome.structured : (jsonSchema === undefined ? undefined : parseStructured(outcome.text, jsonSchema))
      // Same mapping the provider uses (lib/provider.js stopReasonFor): a
      // truncated or filtered turn is an abnormal ending even though no error
      // was thrown, and a cancelled one is "aborted", not "failed".
      const cancelTone = signal !== undefined && signal !== null && signal.aborted === true
      const stopReason = cancelTone ? 'aborted' : (outcome.finish === 'length' ? 'max-tokens' : (outcome.finish === 'content-filter' ? 'refusal' : 'completed'))
      if (row !== null) ledger.finish(row, { stopReason: stopReason, usage: snapshotUsage(server) })
      return { sessionId: id, text: outcome.text === '' ? '(remote agent returned no text)' : outcome.text, structured: structured }
    } catch (error) {
      finish()
      // An abort reaches here as a thrown `opencode: aborted*`; recording it as
      // "failed" would make cancelled runs look like broken ones.
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
      const aborted = (signal !== undefined && signal !== null && signal.aborted === true) || message.indexOf('aborted') >= 0
      if (row !== null) ledger.finish(row, { stopReason: aborted ? 'aborted' : 'error', error: error, usage: snapshotUsage(server) })
      if (error !== null && typeof error === 'object' && error.name === 'OpenCodeError') throw new Error(promptFailureMessage(error, server, effectiveDirectory))
      throw error
    }
  }
}