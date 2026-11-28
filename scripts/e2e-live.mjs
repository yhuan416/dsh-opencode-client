#!/usr/bin/env node
/**
 * Live acceptance run against a real OpenCode server — v1 (1.18.x) or v2 (2.x).
 * Everything offline lives in `npm test`; this is the part that needs a running
 * `opencode serve` and real models.
 *
 * Usage:
 *   OPC_LIVE_URL=http://127.0.0.1:4199 \
 *   OPC_LIVE_PASSWORD='<OPENCODE_SERVER_PASSWORD, v2 only>' \
 *   OPC_LIVE_DIR=/tmp \
 *   [OPC_LIVE_INTERACTIONS=1] \
 *   [OPC_LIVE_URL2=http://other:4096 OPC_LIVE_PASSWORD2=...] \
 *   node scripts/e2e-live.mjs
 *
 * OPC_LIVE_DIR must exist on the remote machine. Steps: probe, read surface,
 * create session, delegate a "reply with PONG" turn (prompt + completion),
 * follow-up turn, shell, read-only workspace calls, fork/children/compact,
 * abort a long turn, and the version-specific unsupported paths. Exits non-zero
 * when a step fails.
 */
import { normalizeServers } from '../lib/config.js'
import { ensureApiVersion, describeApiVersion, opencodeValue } from '../lib/http.js'
import {
  collectServer, collectSessionRows, readMessages, collectAgents, collectSessionInfo,
  collectStatus, abortSession, shareSession,
} from '../lib/sessions.js'
import {
  collectModels, collectCommands, collectSkills, collectReferences, collectMcpStatus,
  collectToolIds, collectSessionSearch,
} from '../lib/catalog.js'
import { runShell, gitStatus, gitDiff, findFiles, findText } from '../lib/workspace.js'
import { forkSession, summarize, sessionChildren } from '../lib/manage.js'
import { createDelegate } from '../lib/run.js'
import { createRoutedProvider } from '../lib/provider.js'
import { normalizeRouting } from '../lib/routing.js'
import { createInteractions } from '../lib/interactions.js'
import { buildPrompt } from '../lib/delegate.js'
import { sendSessionMessage } from '../lib/session-run.js'

const url = process.env.OPC_LIVE_URL || process.env.OCV2_URL
if (url === undefined || url === '') {
  console.error('OPC_LIVE_URL is required (e.g. http://server-a:4096)')
  process.exit(2)
}
const password = process.env.OPC_LIVE_PASSWORD || process.env.OCV2_PASSWORD
const directory = process.env.OPC_LIVE_DIR || process.env.OCV2_DIR || '/tmp'
const wantInteractions = process.env.OPC_LIVE_INTERACTIONS === '1' || process.env.OCV2_INTERACTIONS === '1'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' — ' + detail))
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    record(name, true, (detail === undefined ? '' : String(detail) + ' ') + '(' + ((Date.now() - started) / 1000).toFixed(1) + 's)')
  } catch (error) {
    record(name, false, String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error))
  }
}

const [server] = normalizeServers([{ id: 'live', url, password, directory }])
if (server === undefined) {
  console.error('invalid OPC_LIVE_URL')
  process.exit(2)
}
const secondUrl = process.env.OPC_LIVE_URL2
const secondPassword = process.env.OPC_LIVE_PASSWORD2 || password
const [secondServer] = secondUrl === undefined || secondUrl === ''
  ? []
  : normalizeServers([{ id: 'live2', url: secondUrl, password: secondPassword, directory }])

const activeRuns = new Map()
const approvals = []
const questions = []
const interactions = createInteractions({
  permissionMode: 'ask',
  questionPolicy: 'reject',
  activeRuns,
  getUserQuestions: function () {
    return {
      ask: function (request) {
        questions.push(request.questions)
        return Promise.resolve({
          answers: request.questions.map(function (question) {
            const hasOptions = question.options !== undefined && question.options.length > 0
            return { id: question.id, selected: hasOptions ? [question.options[0].label] : [], custom: hasOptions ? '' : 'e2e' }
          }),
        })
      },
    }
  },
  getApproval: function () {
    return { request: function (request) { approvals.push(request); return Promise.resolve('allowed-once') } }
  },
})
const delegate = createDelegate({ watchInteractions: interactions.watchInteractions, activeRuns })

let version = '?'
let sessionId

await step('probe API version', async function () {
  const info = await ensureApiVersion(server)
  version = info.version
  if (version !== '1' && version !== '2') throw new Error('unexpected probe: ' + describeApiVersion(info))
  return describeApiVersion(info)
})

await step('read surface', async function () {
  const snapshot = await collectServer(server)
  if (snapshot.state !== 'online') throw new Error('server not online')
  const rows = await collectSessionRows([server], undefined, undefined, undefined, 5)
  if (rows.errors.length > 0) throw new Error(rows.errors[0].message)
  const agents = await collectAgents([server])
  const models = await collectModels([server])
  const commands = await collectCommands([server])
  const skills = await collectSkills([server])
  const mcp = await collectMcpStatus([server])
  await collectReferences([server])
  await collectToolIds([server])
  await collectSessionSearch([server], undefined, 'session', 5).catch(function () {})
  await collectStatus(server)
  return snapshot.projects.length + ' groups, ' + rows.count + ' sessions, ' + agents.count + ' agents, ' + models.count + ' providers, ' + commands.count + ' commands, ' + skills.count + ' skills, ' + mcp.count + ' mcp'
})

await step('create session + delegate', async function () {
  const outcome = await delegate(server, directory, 'Reply with exactly: E2E_PONG', undefined, { dshAgent: 'e2e' })
  sessionId = outcome.sessionId
  if (!/E2E_PONG/.test(outcome.text)) throw new Error('unexpected answer: ' + outcome.text.slice(0, 120))
  return outcome.sessionId
})

await step('read messages / session info', async function () {
  const messages = await readMessages(server, sessionId, 10)
  if (messages.length === 0) throw new Error('no messages')
  const info = await collectSessionInfo(server, sessionId)
  // v1 reads /session/{id}/todo; v2 derives todos from the last todowrite call.
  if (info.todosSupported !== true) throw new Error('session info should support todos on 0.4.0')
  if (version === '2' && info.todosDerived !== true) throw new Error('v2 todos should be marked derived')
  return messages.length + ' messages, outcome=' + info.session.outcome + ', todos=' + info.todos.length
})

await step('follow-up prompt (blocking)', async function () {
  const body = await buildPrompt(server, 'Say exactly: FOLLOWUP')
  const sent = await sendSessionMessage(server, sessionId, body, { wait: true })
  if (!/FOLLOWUP/.test(sent.text)) throw new Error('unexpected answer: ' + sent.text.slice(0, 120))
  return 'session ' + sessionId
})

await step('shell', async function () {
  const shell = await runShell(server, sessionId, 'echo e2e-shell-ok; pwd')
  if (!/e2e-shell-ok/.test(shell.text)) throw new Error('unexpected shell output: ' + shell.text.slice(0, 120))
  return shell.text.split('\n')[0]
})

await step('workspace read-only', async function () {
  const status = await gitStatus(server, directory)
  const diff = await gitDiff(server, directory, 'git', false)
  await findFiles(server, directory, '*.md', 5)
  // v1 searches through /find; v2 emulates content search with a workspace grep
  // through the async shell, so both generations must report "available".
  let textSearch
  try {
    const found = await findText(server, directory, 'x')
    textSearch = 'available(' + found.count + ')'
  } catch (error) {
    textSearch = 'unavailable: ' + String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)
  }
  if (textSearch.indexOf('available(') !== 0) throw new Error('text search ' + textSearch)
  return status.files.length + ' changed, ' + diff.files.length + ' diff files, text search: ' + textSearch
})

await step('fork / children / compact', async function () {
  const forked = await forkSession(server, sessionId)
  if (typeof forked.id !== 'string') throw new Error('fork returned no id')
  await sessionChildren(server, sessionId)
  if (version === '1') {
    // v1 summarize needs an explicit provider/model; v2 compact uses the session's own.
    const providers = await opencodeValue(server, '/config/providers')
    const list = providers !== null && typeof providers === 'object' && Array.isArray(providers.providers) ? providers.providers : []
    const provider = list.find(function (candidate) { return candidate !== null && typeof candidate === 'object' && candidate.models !== null && typeof candidate.models === 'object' && Object.keys(candidate.models).length > 0 })
    if (provider === undefined) throw new Error('no provider/model available for v1 summarize')
    await summarize(server, sessionId, provider.id, Object.keys(provider.models)[0])
  } else {
    await summarize(server, sessionId)
  }
  return 'forked ' + forked.id
})

await step('abort long turn', async function () {
  const body = await buildPrompt(server, 'Run the shell command "sleep 90" and then reply done.')
  const pending = sendSessionMessage(server, sessionId, body, { wait: true }).then(function () { return 'finished' }, function (error) { return 'error:' + error.message })
  await new Promise(function (resolve) { setTimeout(resolve, 4000) })
  const aborted = await abortSession(server, sessionId)
  if (!aborted) throw new Error('interrupt returned false while running')
  const settled = await Promise.race([pending, new Promise(function (resolve) { setTimeout(function () { resolve('still-running') }, 60000) })])
  if (settled === 'still-running') throw new Error('waiter did not settle after abort')
  return settled
})

if (secondServer !== undefined) {
  await step('routed provider alternates servers', async function () {
    const routed = createRoutedProvider([server, secondServer], {
      pathMap: [],
      watchInteractions: interactions.watchInteractions,
      activeRuns: new Map(),
      routing: normalizeRouting({ policy: ['round-robin'], sticky: false, failover: false }, 2),
      logger: { info: function () {}, warn: function () {} },
    })
    const sessions = []
    for (const index of [0, 1]) {
      const controller = new AbortController()
      const run = await routed.start({
        prompt: [{ type: 'text', text: 'Reply with exactly: ok' }],
        parent: { id: 'e2e-route' },
        signal: controller.signal,
        label: 'e2e route ' + String(index),
      })
      sessions.push(run.id)
      const result = await run.result
      await run.dispose()
      if (result.stopReason !== 'completed') throw new Error('routed run ' + String(index) + ' ended ' + result.stopReason)
    }
    return 'sessions ' + sessions.join(', ')
  })
}

await step('version-specific unsupported paths', async function () {
  const share = await shareSession(server, sessionId, 'share')
  if (version === '2' && share.ok !== false) throw new Error('share should be unsupported on v2')
  if (version === '1' && share.ok !== true) throw new Error('share should work on v1: ' + String(share.error))
  return version === '2' ? share.error : 'share url ' + String(share.url === null ? '(none)' : share.url)
})

if (wantInteractions) {
  await step('permission bridge', async function () {
    const before = approvals.length
    await delegate(server, directory, 'Read the file ' + directory + '/dsh-e2e.env with the read tool, then reply exactly: PERMISSION_OK', undefined, { dshAgent: 'e2e' })
    if (approvals.length === before) throw new Error('no approval request bridged')
    return approvals.length + ' approval(s)'
  })
  await step('form/question bridge', async function () {
    const before = questions.length
    await delegate(server, directory, 'Use the question tool to ask me one question: "Pick one" with options A and B. Then stop.', undefined, { dshAgent: 'e2e' })
    if (questions.length === before) throw new Error('no form bridged')
    return questions.length + ' form(s)'
  })
}

const failed = results.filter(function (result) { return !result.ok })
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' steps passed')
if (failed.length > 0) {
  console.error('failed: ' + failed.map(function (result) { return result.name }).join(', '))
  process.exit(1)
}
process.exit(0)