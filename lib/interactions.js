/** Permission and question bridging between OpenCode and dsh. */
import { opencodeRequest } from './http.js'

export function createInteractions(options) {
  const permissionMode = options.permissionMode
  const permission = options.permission
  const questionPolicy = options.questionPolicy
  const activeRuns = options.activeRuns
  const getUserQuestions = options.getUserQuestions
  const getApproval = options.getApproval

  function handlePermission(server, run, properties) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    const toolName = typeof properties.permission === 'string' ? properties.permission : 'permission'
    const patterns = Array.isArray(properties.patterns) && properties.patterns.length > 0 ? ' (' + properties.patterns.filter(function (pattern) { return typeof pattern === 'string' }).join(', ') + ')' : ''
    const reply = function (value) {
      opencodeRequest(server, '/permission/' + encodeURIComponent(requestId) + '/reply', {
        method: 'POST',
        body: { reply: value },
        directory: run === undefined ? undefined : run.directory,
        timeoutMs: 5000,
      })
    }
    const approval = getApproval()
    if (permissionMode === 'ask' && run !== undefined && run.agent !== undefined && approval !== undefined && typeof approval.request === 'function') {
      approval.request({
        agent: run.agent,
        toolName: 'opencode:' + toolName,
        reason: 'OpenCode agent requests permission: ' + toolName + patterns,
        signal: run.signal,
      }).then(function (outcome) {
        reply(outcome === 'allowed-once' ? 'once' : 'reject')
      }, function () {
        reply('reject')
      })
      return
    }
    if (permissionMode === 'ask' || permissionMode === 'allow') reply('always')
    else reply('reject')
  }

  function handleQuestion(server, run, properties) {
    const requestId = typeof properties.id === 'string' ? properties.id : (typeof properties.requestID === 'string' ? properties.requestID : undefined)
    if (requestId === undefined) return
    const rawQuestions = Array.isArray(properties.questions) ? properties.questions : []
    const reject = function () {
      opencodeRequest(server, '/question/' + encodeURIComponent(requestId) + '/reject', {
        method: 'POST',
        directory: run === undefined ? undefined : run.directory,
        timeoutMs: 5000,
      })
    }
    const userQuestions = getUserQuestions()
    if (rawQuestions.length === 0 || run === undefined || run.agent === undefined || userQuestions === undefined || typeof userQuestions.ask !== 'function') {
      if (questionPolicy === 'reject') reject()
      return
    }
    const questions = rawQuestions.map(function (item, index) {
      const options = Array.isArray(item.options) ? item.options.filter(function (option) {
        return option !== null && typeof option === 'object' && typeof option.label === 'string'
      }).map(function (option) {
        return { label: option.label, description: typeof option.description === 'string' ? option.description : undefined }
      }) : []
      return {
        id: 'q' + String(index + 1),
        question: typeof item.question === 'string' ? item.question : 'OpenCode question',
        header: typeof item.header === 'string' ? item.header : undefined,
        options: options.length === 0 ? undefined : options,
        multiSelect: item.multiple === true,
      }
    })
    userQuestions.ask({ agent: run.agent, questions: questions, signal: run.signal }).then(function (answer) {
      const answers = Array.isArray(answer.answers) ? answer.answers : []
      const labels = questions.map(function (question, index) {
        const item = answers.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.id === question.id }) || answers[index]
        const selected = item !== null && typeof item === 'object' && Array.isArray(item.selected) ? item.selected.filter(function (label) { return typeof label === 'string' }) : []
        if (selected.length === 0 && item !== null && typeof item === 'object' && typeof item.custom === 'string' && item.custom !== '') return [item.custom]
        return selected
      })
      return opencodeRequest(server, '/question/' + encodeURIComponent(requestId) + '/reply', {
        method: 'POST',
        body: { answers: labels },
        directory: run.directory,
        timeoutMs: 10000,
      })
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
      opencodeRequest(server, '/permission', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has(request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add(request.id)
          handlePermission(server, activeRuns.get(sessionId), request)
        }
      })
      opencodeRequest(server, '/question', { timeoutMs: 5000 }).then(function (result) {
        const list = result !== undefined && Array.isArray(result.value) ? result.value : []
        for (const request of list) {
          if (request === null || typeof request !== 'object' || typeof request.id !== 'string') continue
          if (answered.has('q:' + request.id)) continue
          if (request.sessionID !== sessionId) continue
          answered.add('q:' + request.id)
          handleQuestion(server, activeRuns.get(sessionId) || { directory: directory }, request)
        }
      })
    }, 1500)
    return function () { clearInterval(timer) }
  }

  return { handlePermission: handlePermission, handleQuestion: handleQuestion, watchInteractions: watchInteractions }
}
