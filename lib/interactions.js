/**
 * Permission and question bridging between OpenCode and dsh.
 *
 * OpenCode 2: `permission.asked` with `action`/`resources` and session-scoped
 * `/api/session/{sid}/permission/{rid}/reply {decision}`; questions are forms
 * (`form.created`, `/api/session/{sid}/form/{fid}/reply {answer}`, DELETE to
 * dismiss) with typed fields (string/number/integer/boolean/multiselect).
 */
import { ocCall } from './oc-client.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

/** v1 questions[] and v2 Form.Info fields[] both map to this shape. */
function normalizeQuestions(source) {
  const version = source.form !== undefined ? '2' : '1'
  if (version === '2') {
    const form = isObject(source.form) ? source.form : {}
    const fields = Array.isArray(form.fields) ? form.fields : []
    return fields.filter(function (field) {
      return isObject(field) && typeof field.key === 'string' && field.hidden !== true
    }).map(function (field, index) {
      const options = Array.isArray(field.options) ? field.options.filter(function (option) {
        return isObject(option) && (typeof option.label === 'string' || typeof option.value === 'string')
      }).map(function (option) {
        return { label: text(option.label) || text(option.value), description: typeof option.description === 'string' ? option.description : undefined, value: typeof option.value === 'string' ? option.value : text(option.label) }
      }) : []
      const type = typeof field.type === 'string' ? field.type : 'string'
      const choices = options.length > 0
        ? options
        : (type === 'boolean' ? [{ label: 'Yes', value: true }, { label: 'No', value: false }] : [])
      return {
        id: field.key,
        question: text(field.description) || text(field.title) || field.key,
        header: text(field.title) || undefined,
        options: choices.length === 0 ? undefined : choices.map(function (choice) { return { label: choice.label, description: choice.description } }),
        multiSelect: type === 'multiselect',
        type: type,
        custom: field.custom === true || choices.length === 0,
        choices: choices,
        required: field.required === true,
      }
    })
  }
  const rawQuestions = Array.isArray(source.questions) ? source.questions : []
  return rawQuestions.map(function (item, index) {
    const options = Array.isArray(item.options) ? item.options.filter(function (option) {
      return isObject(option) && typeof option.label === 'string'
    }).map(function (option) {
      return { label: option.label, description: typeof option.description === 'string' ? option.description : undefined, value: option.label }
    }) : []
    return {
      id: 'q' + String(index + 1),
      question: text(item.question) || 'OpenCode question',
      header: typeof item.header === 'string' ? item.header : undefined,
      options: options.length === 0 ? undefined : options.map(function (option) { return { label: option.label, description: option.description } }),
      multiSelect: item.multiple === true,
      type: 'string',
      custom: options.length === 0,
      choices: options,
      required: false,
    }
  })
}

/** Turn dsh answers back into a v2 `Form.Answer` (`{key: value}`). */
function formAnswer(fields, answers) {
  const picked = []
  const answer = {}
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    const item = answers.find(function (candidate) { return isObject(candidate) && candidate.id === field.id }) || answers[index]
    const selected = isObject(item) && Array.isArray(item.selected) ? item.selected.filter(function (label) { return typeof label === 'string' }) : []
    const custom = isObject(item) && typeof item.custom === 'string' && item.custom !== '' ? item.custom : ''
    if (selected.length === 0 && custom === '') continue
    let value
    if (field.type === 'boolean') {
      const label = selected.length > 0 ? selected[0] : custom
      value = /^(yes|true|1)$/i.test(label)
    } else if (field.type === 'number' || field.type === 'integer') {
      const raw = selected.length > 0 ? selected[0] : custom
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) continue
      value = field.type === 'integer' ? Math.trunc(parsed) : parsed
    } else if (field.type === 'multiselect') {
      const chosen = selected.length > 0 ? selected : (custom === '' ? [] : [custom])
      value = chosen.map(function (label) {
        const option = field.choices.find(function (candidate) { return candidate.label === label })
        return option === undefined ? label : option.value
      })
      if (value.length === 0) continue
    } else {
      const label = selected.length > 0 ? selected[0] : custom
      const option = field.choices.find(function (candidate) { return candidate.label === label })
      value = option === undefined ? label : option.value
    }
    answer[field.id] = value
    picked.push(field.id)
  }
  return { answer: answer, keys: picked }
}


/** One-line description of a pending form/question. */
function formDetail(properties) {
  if (!isObject(properties)) return 'form'
  const form = isObject(properties.form) ? properties.form : properties
  const questions = Array.isArray(form.questions) ? form.questions : []
  const first = questions.find(function (item) { return isObject(item) && typeof item.text === 'string' && item.text !== '' })
  if (first !== undefined) return 'form: ' + first.text.slice(0, 120)
  if (typeof form.title === 'string' && form.title !== '') return 'form: ' + form.title.slice(0, 120)
  return 'form'
}

export function createInteractions(options) {
  const permissionMode = options.permissionMode
  const questionPolicy = options.questionPolicy
  const activeRuns = options.activeRuns
  const getUserQuestions = options.getUserQuestions
  const getApproval = options.getApproval
  // Observability hook: a request no dsh run owns is recorded instead of answered.
  const notifyPending = typeof options.markPending === 'function' ? options.markPending : function () {}

  function permissionSessionId(properties, run) {
    if (isObject(properties) && typeof properties.sessionID === 'string') return properties.sessionID
    return run !== undefined ? run.sessionId : undefined
  }

  function replyPermission(server, run, properties, requestId, decision) {
    const sessionId = permissionSessionId(properties, run)
    if (sessionId === undefined) return Promise.resolve()
    return ocCall(server, function (client, requestOptions) {
      return client.permission.reply({ sessionID: sessionId, requestID: requestId, decision: decision === 'always' ? 'always' : (decision === 'once' ? 'once' : 'reject') }, requestOptions)
    }, 5000).catch(function () {})
  }

  function handlePermission(server, run, properties) {
    return Promise.resolve().then(function () {
      return handlePermissionNow(server, run, properties)
    }).catch(function () {})
  }

  function handlePermissionNow(server, run, properties) {
    const requestId = isObject(properties)
      ? (typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined))
      : undefined
    if (requestId === undefined) return
    if (run === undefined && isObject(properties) && typeof properties.sessionID === 'string' && activeRuns instanceof Map) {
      run = activeRuns.get(properties.sessionID)
    }
    const toolName = typeof properties.action === 'string' ? properties.action : 'permission'
    const patterns = Array.isArray(properties.resources) && properties.resources.length > 0 ? ' (' + properties.resources.filter(function (item) { return typeof item === 'string' }).join(', ') + ')' : ''
    // A session dsh did not start (e.g. driven from the OpenCode TUI) has no run:
    // never answer for the user, record the request so the board can show it.
    if (run === undefined && permissionMode === 'ask') {
      const pendingSessionId = permissionSessionId(properties, run)
      if (pendingSessionId !== undefined) {
        notifyPending(server, pendingSessionId, { kind: 'permission', requestId: requestId, detail: 'OpenCode ' + toolName + patterns })
        return
      }
    }
    const approval = getApproval()
    if (permissionMode === 'ask' && run !== undefined && run.agent !== undefined && approval !== undefined && typeof approval.request === 'function') {
      approval.request({
        agent: run.agent,
        toolName: 'opencode:' + toolName,
        reason: 'OpenCode agent requests permission: ' + toolName + patterns,
        signal: run.signal,
      }).then(function (outcome) {
        return replyPermission(server, run, properties, requestId, outcome === 'allowed-once' ? 'once' : (outcome === 'allowed-always' ? 'always' : 'reject'))
      }, function () {
        return replyPermission(server, run, properties, requestId, 'reject')
      })
      return
    }
    if (permissionMode === 'ask' || permissionMode === 'allow') replyPermission(server, run, properties, requestId, 'always')
    else replyPermission(server, run, properties, requestId, 'reject')
  }

  function handleQuestion(server, run, properties) {
    return Promise.resolve().then(function () {
      return handleQuestionNow(server, run, properties)
    }).catch(function () {})
  }

  function handleQuestionNow(server, run, properties) {
    const isForm = isObject(properties) && properties.form !== undefined
    const form = isForm ? properties.form : (isObject(properties) ? properties : {})
    const requestId = isObject(form) && typeof form.id === 'string' ? form.id : undefined
    if (requestId === undefined) return
    const sessionId = isObject(form) && typeof form.sessionID === 'string' ? form.sessionID : undefined
    if (run === undefined && sessionId !== undefined && activeRuns instanceof Map) run = activeRuns.get(sessionId)
    const normalized = normalizeQuestions({ form: form })
    const reject = function () {
      if (sessionId === undefined) return Promise.resolve()
      return ocCall(server, function (client, requestOptions) {
        return client.session.form.cancel({ sessionID: sessionId, formID: requestId }, requestOptions)
      }, 5000).catch(function () {})
    }
    // Same rule for forms: no owning run means no answer on the user's behalf.
    if (run === undefined && questionPolicy !== 'reject' && sessionId !== undefined) {
      notifyPending(server, sessionId, { kind: 'form', requestId: requestId, detail: formDetail(properties) })
      return
    }
    const userQuestions = getUserQuestions()
    if (normalized.length === 0 || run === undefined || run.agent === undefined || userQuestions === undefined || typeof userQuestions.ask !== 'function') {
      if (questionPolicy === 'reject') reject()
      return
    }
    const questions = normalized.map(function (question) {
      return {
        id: question.id,
        question: question.question,
        header: question.header,
        options: question.options,
        multiSelect: question.multiSelect,
      }
    })
    userQuestions.ask({ agent: run.agent, questions: questions, signal: run.signal }).then(function (answer) {
      const answers = Array.isArray(answer.answers) ? answer.answers : []
      if (sessionId === undefined) return
      const built = formAnswer(normalized, answers)
      if (built.keys.length === 0) {
        reject()
        return
      }
      return ocCall(server, function (client, requestOptions) {
        return client.session.form.reply({ sessionID: sessionId, formID: requestId, answer: built.answer }, requestOptions)
      }, 10000).catch(function () { reject() })
    }, function () {
      reject()
    })
  }

  /** Poll pending permission/question requests while a run is active (SSE is the fast path). */
  function watchInteractions(server, sessionId, directory) {
    const answered = new Set()
    let tick = 0
    const timer = setInterval(function () {
      tick += 1
      if (tick % 10 !== 0 && server.sse !== undefined && server.sse.state === 'open') return
        ocCall(server, function (client, requestOptions) {
          return client.permission.request.list({}, requestOptions)
        }, 5000).then(function (value) {
          const list = value !== null && typeof value === 'object' && Array.isArray(value.data) ? value.data : []
          for (const request of list) {
            if (!isObject(request) || typeof request.id !== 'string') continue
            if (request.sessionID !== sessionId) continue
            if (answered.has('p:' + request.id)) continue
            answered.add('p:' + request.id)
            handlePermission(server, activeRuns.get(sessionId), request)
          }
        }, function () {})
        ocCall(server, function (client, requestOptions) {
          return client.session.form.list({ sessionID: sessionId }, requestOptions)
        }, 5000).then(function (list) {
          for (const form of Array.isArray(list) ? list : []) {
            if (!isObject(form) || typeof form.id !== 'string') continue
            if (answered.has('f:' + form.id)) continue
            answered.add('f:' + form.id)
            handleQuestion(server, activeRuns.get(sessionId) || { directory: directory }, { form: form })
          }
        }, function () {})
    }, 1500)
    return function () { clearInterval(timer) }
  }

  return { handlePermission: handlePermission, handleQuestion: handleQuestion, watchInteractions: watchInteractions }
}