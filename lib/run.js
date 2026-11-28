/** One-shot delegation into an OpenCode session (new or continued). */
import { asyncPrompt, buildPrompt, promptFailureMessage } from './delegate.js'
import { ensureSession, trackRun, prepareTurn } from './session-run.js'
import { invalidateSnapshot } from './snapshot.js'

function matchesType(value, type) {
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Validate a decoded value against the JSON-schema subset an `opencode_subagent`
 * caller actually uses: `type` (string or list), `required`, `properties`
 * (recursive), `items` (recursive), `enum`. Keywords outside that subset are
 * accepted rather than rejected — the prompt asked for a shape, and refusing a
 * valid answer because the caller used a keyword we do not model would be worse
 * than passing it through unchanged.
 */
export function matchesSchema(value, schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return true
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some(function (item) { return sameJson(item, value) })) return false
  }
  const types = Array.isArray(schema.type) ? schema.type : (typeof schema.type === 'string' ? [schema.type] : [])
  if (types.length > 0 && !types.some(function (type) { return matchesType(value, type) })) return false
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value)
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    if (!isObject) return false
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) return false
    }
  }
  if (isObject && schema.properties !== null && typeof schema.properties === 'object') {
    for (const key of Object.keys(schema.properties)) {
      if (Object.hasOwn(value, key) && !matchesSchema(value[key], schema.properties[key])) return false
    }
  }
  if (Array.isArray(value) && schema.items !== undefined && schema.items !== null) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items]
    for (let index = 0; index < value.length; index += 1) {
      const rule = items.length === 1 ? items[0] : items[index]
      if (rule !== undefined && !matchesSchema(value[index], rule)) return false
    }
  }
  return true
}

/** Prompt-enforced JSON: ask for JSON and validate locally (opencode format= is broken upstream). */
export function parseStructured(text, schema) {
  if (typeof text !== 'string') return undefined
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  let value
  try { value = JSON.parse(cleaned) } catch { return undefined }
  if (!matchesSchema(value, schema)) return undefined
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