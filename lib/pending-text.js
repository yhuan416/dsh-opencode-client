/**
 * One-line, human-readable description of a pending permission request or
 * question form.
 *
 * This used to exist three times (observation/pending events, interactions'
 * notifyPending, sessions' pending snapshot). The later writer overwrote the
 * earlier one, so a fix in one copy was invisible to the user: keep exactly one
 * implementation and let every producer call it.
 */

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function joinList(value) {
  return (Array.isArray(value) ? value : []).filter(function (item) { return typeof item === 'string' }).join(', ')
}

/**
 * The question itself, in the order OpenCode has carried it:
 * v1 `questions[].text`, v2 `fields[].description` (title is only a short dock
 * header such as "Questions"), then the form title.
 */
function questionText(form) {
  const questions = Array.isArray(form.questions) ? form.questions : []
  const asked = questions.find(function (item) { return isObject(item) && textOf(item.text) !== undefined })
  if (asked !== undefined) return textOf(asked.text)
  const fields = Array.isArray(form.fields) ? form.fields.filter(function (item) { return isObject(item) && item.hidden !== true }) : []
  const described = fields.find(function (item) { return textOf(item.description) !== undefined })
  if (described !== undefined) return textOf(described.description)
  const titled = fields.find(function (item) { return textOf(item.title) !== undefined })
  if (titled !== undefined) return textOf(titled.title)
  return textOf(form.title)
}

/** One-line description of a pending permission request (v2 event or REST shape). */
export function describePermission(data) {
  if (!isObject(data)) return 'permission'
  const action = textOf(data.action) ?? textOf(data.permission) ?? 'permission'
  const detail = joinList(data.resources) || joinList(data.patterns)
  return detail === '' ? action : action + ' (' + detail.slice(0, 120) + ')'
}

/** One-line description of a pending request: `form: <question>` / `<action> (<detail>)`. */
export function describePending(kind, data) {
  if (!isObject(data)) return kind === 'form' ? 'form' : 'permission'
  if (kind !== 'form') return describePermission(data)
  const form = isObject(data.form) ? data.form : data
  const text = questionText(form)
  return text === undefined ? 'form' : 'form: ' + text.slice(0, 120)
}
