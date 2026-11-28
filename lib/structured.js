/**
 * Structured output for `opencode_subagent` / the native provider.
 *
 * OpenCode's own `format=` is broken upstream (see CHANGELOG), so the contract is
 * prompt-enforced: ask for JSON, then validate locally against the subset of
 * JSON Schema a caller actually uses. When a caller passes an object-rooted
 * schema, the native provider advertises `outputSchema: true` and returns the
 * validated value as `SubagentResult.structured`.
 */

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
