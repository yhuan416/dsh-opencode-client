/**
 * OpenCode 2 surface tests: the normalized session/catalog/workspace shapes,
 * v2 request bodies (location scoping, prompt, agent/model, permission/form
 * replies) and the "explicitly unsupported" paths.
 *
 * A local fake server answers the v2 endpoints; nothing here needs a real
 * `opencode serve`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { normalizeServers, parseModel, modelLabel } from '../lib/config.js'
import {
  collectServer, collectSessionRows, readMessages, collectSessionInfo, collectAgents,
  collectStatus, abortSession, shareSession, resolveAgentId,
} from '../lib/sessions.js'
import {
  collectModels, collectCommands, collectSkills, collectReferences, collectMcpStatus,
  collectToolIds, collectSessionSearch, runCommand,
} from '../lib/catalog.js'
import { gitStatus, gitDiff, readRemoteFile, findFiles, findText, runShell } from '../lib/workspace.js'
import { forkSession, summarize, sessionChildren, initSession } from '../lib/manage.js'
import { ensureSession, sendSessionMessage, prepareTurn, modelRef } from '../lib/session-run.js'
import { buildPrompt, captureTurnBaseline, extractAssistant, promptBody, v2PromptBody } from '../lib/delegate.js'
import { createInteractions } from '../lib/interactions.js'

const SESSION = {
  id: 'ses_1',
  projectID: 'p1',
  title: 'demo session',
  agent: 'build',
  model: { id: 'm1', providerID: 'p', variant: 'high' },
  parentID: 'ses_root',
  outcome: 'succeeded',
  cost: 0.5,
  tokens: { input: 10, output: 20, reasoning: 3 },
  time: { created: 100, updated: 200 },
  location: { directory: '/work' },
}

function startServer() {
  return new Promise(function (resolve) {
    const requests = []
    const server = http.createServer(function (request, response) {
      const chunks = []
      request.on('data', function (chunk) { chunks.push(chunk) })
      request.on('end', function () {
        const entry = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }
        requests.push(entry)
        handle(entry, response)
      })
    })
    server.listen(0, '127.0.0.1', function () {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requests: requests,
        close: function () {
          return new Promise(function (done) {
            server.closeAllConnections()
            server.close(function () { done() })
          })
        },
      })
    })
  })
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function noContent(response) {
  response.writeHead(204)
  response.end()
}

function handle(entry, response) {
  const url = new URL(entry.url, 'http://localhost')
  const path = url.pathname
  if (path === '/api/info') return json(response, 200, { version: '2.3.0' })
  if (path === '/api/project') return json(response, 200, [{ id: 'p1', canonical: '/work' }, { id: 'root', canonical: '/' }])
  if (path === '/api/session' && entry.method === 'GET') {
    if (url.searchParams.get('parentID') === 'ses_1') return json(response, 200, { data: [], cursor: {} })
    if (url.searchParams.get('search') === 'demo') return json(response, 200, { data: [SESSION], cursor: {} })
    return json(response, 200, { data: [SESSION], cursor: { next: null } })
  }
  if (path === '/api/session' && entry.method === 'POST') return json(response, 200, { data: { id: 'ses_new', location: { directory: '/work' } } })
  if (path === '/api/session/active') return json(response, 200, { data: { ses_9: { type: 'running' } } })
  if (path === '/api/session/ses_long/message') {
    const total = 120
    const all = []
    for (let index = 0; index < total; index += 1) {
      all.push({ id: 'msg_l' + String(index).padStart(3, '0'), type: 'user', time: { created: 1000 + index }, text: 'message ' + String(index) })
    }
    const order = url.searchParams.get('order')
    const limit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
    const offset = Number(url.searchParams.get('cursor') === null ? '0' : url.searchParams.get('cursor'))
    const ordered = order === 'asc' ? all : all.slice().reverse()
    const page = ordered.slice(offset, offset + Math.min(limit, 50))
    const next = offset + page.length < total ? String(offset + page.length) : null
    return json(response, 200, { data: page, cursor: { previous: null, next: next } })
  }
  if (path === '/api/session/ses_todo') return json(response, 200, { data: { id: 'ses_todo', title: 'todo session', location: { directory: '/work' } } })
  if (path === '/api/session/ses_todo/diff') return json(response, 200, { data: [] })
  if (path === '/api/session/ses_todo/message') {
    return json(response, 200, {
      data: [{
        id: 'msg_todo', type: 'assistant', time: { created: 5 },
        content: [{
          type: 'tool', id: 'call_todo', name: 'todowrite',
          state: { status: 'completed', input: { todos: [{ content: 'write docs', status: 'completed', priority: 'high' }, { content: 'run tests', status: 'pending' }] }, content: [] },
        }],
      }],
      cursor: {},
    })
  }
  if (path === '/api/session/ses_1/message') {
    const type = url.searchParams.get('type')
    if (type === 'idle') return json(response, 200, { data: [{ id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 300 } }] })
    const allMessages = [
        { id: 'msg_idle', type: 'idle', outcome: 'succeeded', time: { created: 300 } },
        {
          id: 'msg_a', type: 'assistant', time: { created: 200, completed: 250 }, agent: 'build', model: { id: 'm1', providerID: 'p' },
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'the answer' },
            { type: 'tool', id: 'call_1', name: 'read', state: { status: 'completed', input: { path: 'src/a.js' }, content: [{ type: 'text', text: 'export const a = 1' }] }, time: { created: 210 } },
          ],
        },
        { id: 'msg_u', type: 'user', time: { created: 100 }, text: 'the question', files: [{ uri: 'data:text/plain;base64,eA==', name: 'note.txt' }] },
    ]
    const filtered = type === null ? allMessages : allMessages.filter(function (message) { return message.type === type })
    return json(response, 200, { data: filtered, cursor: {} })
  }
  if (path === '/api/session/ses_1') return json(response, 200, { data: SESSION })
  if (path === '/api/session/ses_1/diff') return json(response, 200, { data: [] })
  if (path === '/api/session/ses_1/prompt') return json(response, 200, { data: { id: 'msg_new' } })
  if (path === '/api/session/ses_1/agent') return noContent(response)
  if (path === '/api/session/ses_1/model') return noContent(response)
  if (path === '/api/session/ses_1/interrupt') return json(response, 200, { interrupted: true })
  if (path === '/api/session/ses_idle/interrupt') return json(response, 200, { interrupted: false })
  if (path === '/api/session/ses_1/fork') return json(response, 200, { data: { id: 'ses_fork', title: 'demo session (fork #1)', time: { updated: 400 }, location: { directory: '/work' } } })
  if (path === '/api/session/ses_1/compact') return json(response, 200, { data: { type: 'compaction' } })
  if (path === '/api/session/ses_1/command') return noContent(response)
  if (path === '/api/session/ses_1/permission') return json(response, 200, { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'read', resources: ['a.txt'] }] })
  if (path === '/api/session/ses_1/form') return json(response, 200, {
    data: [{
      id: 'frm_1', sessionID: 'ses_1', title: 'Questions',
      metadata: { kind: 'question' },
      fields: [
        { key: 'q0', title: 'Color', description: 'Favorite color?', type: 'string', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }], custom: true },
        { key: 'q1', title: 'Count', description: 'How many?', type: 'integer' },
        { key: 'q2', title: 'Tags', description: 'Pick tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      ],
    }],
  })
  if (path === '/api/session/ses_1/permission/per_1/reply') return noContent(response)
  if (path === '/api/session/ses_1/form/frm_1') {
    if (entry.method === 'DELETE') return noContent(response)
    return noContent(response)
  }
  if (path === '/api/agent') return json(response, 200, { location: { directory: '/work' }, data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false, description: 'default' }] })
  if (path === '/api/provider') return json(response, 200, { location: { directory: '/work' }, data: [{ id: 'p', name: 'Provider', activation: 'enabled' }] })
  if (path === '/api/model') return json(response, 200, {
    location: { directory: '/work' },
    data: [
      { id: 'm1', modelID: 'm1', providerID: 'p', name: 'Model One', enabled: true, settings: { apiKey: 'secret' }, variants: [{ id: 'minimal' }, { id: 'high' }], limit: { context: 1000000, output: 32000 } },
      { id: 'm2', modelID: 'm2', providerID: 'p', name: 'Model Two', enabled: false },
    ],
  })
  if (path === '/api/model/default') return json(response, 200, { location: { directory: '/work' }, data: { id: 'm1', providerID: 'p' } })
  if (path === '/api/command') return json(response, 200, { location: { directory: '/work' }, data: [{ name: 'init', description: 'guided setup' }] })
  if (path === '/api/skill') return json(response, 200, { location: { directory: '/work' }, data: [{ id: 's1', name: 'Skill One', description: 'does things', path: 'skill://s1/SKILL.md', content: 'SECRET BODY' }] })
  if (path === '/api/mcp') return json(response, 200, { location: { directory: '/work' }, data: [{ name: 'drawio', status: { status: 'connected' } }, { name: 'jira', status: { status: 'failed', error: 'boom' } }] })
  if (path === '/api/reference') return json(response, 200, { location: { directory: '/work' }, data: [] })
  if (path === '/api/vcs/status') return json(response, 200, { location: { directory: '/work' }, data: [{ file: 'a.txt', status: 'modified', additions: 1, deletions: 2 }] })
  if (path === '/api/vcs/diff') {
    const mode = url.searchParams.get('mode')
    if (mode === 'git') return json(response, 400, { message: 'Expected Vcs.Mode' })
    return json(response, 200, { location: { directory: '/work' }, data: [{ file: 'a.txt', status: 'modified', additions: 1, deletions: 2, patch: '@@ -1 +1 @@' }] })
  }
  if (path === '/api/fs/read/a.txt') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('hello from v2\n')
    return
  }
  if (path === '/api/fs/read/bin.dat') {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(Buffer.from([0, 1, 2, 3]))
    return
  }
  if (path === '/api/fs/find') {
    // v2 matches a substring only: a glob query finds nothing and forces the fallback.
    const query = url.searchParams.get('query') === null ? '' : url.searchParams.get('query')
    if (query.indexOf('*') >= 0 || query.indexOf('?') >= 0) return json(response, 200, { location: { directory: '/work' }, data: [] })
    return json(response, 200, { location: { directory: '/work' }, data: [{ path: 'src/a.js', type: 'file' }] })
  }
  if (path === '/api/shell' && entry.method === 'POST') {
    const body = entry.body === '' ? {} : JSON.parse(entry.body)
    const command = typeof body.command === 'string' ? body.command : ''
    if (command.indexOf('grep') >= 0) return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_grep', status: 'running', command: command } })
    if (command.indexOf('big') >= 0) return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_big', status: 'running', command: command } })
    if (command.indexOf('page') >= 0) return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_page', status: 'running', command: command } })
    if (command.indexOf('fail') >= 0) return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_fail', status: 'running', command: command } })
    return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_1', status: 'running', command: command } })
  }
  if (path === '/api/shell/sh_grep') return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_grep', status: 'exited', exit: 0 } })
  if (path === '/api/shell/sh_big') return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_big', status: 'exited', exit: 0 } })
  if (path === '/api/shell/sh_page') return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_page', status: 'exited', exit: 0 } })
  if (path === '/api/shell/sh_fail') return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_fail', status: 'exited', exit: 3 } })
  if (path === '/api/shell/sh_fail/output') return json(response, 200, { location: { directory: '/work' }, data: { output: '', cursor: 0, size: 0, truncated: false } })
  if (path === '/api/shell/sh_page/output') {
    const cursor = url.searchParams.get('cursor')
    if (cursor === '4') return json(response, 200, { location: { directory: '/work' }, data: { output: 'bbbb', cursor: 8, size: 8, truncated: false } })
    return json(response, 200, { location: { directory: '/work' }, data: { output: 'aaaa', cursor: 4, size: 8, truncated: false } })
  }
  if (path === '/api/shell/sh_big/output') return json(response, 200, { location: { directory: '/work' }, data: { output: 'line 1\nline 2\n', cursor: 1234, size: 1234, truncated: true } })
  if (path === '/api/shell/sh_grep/output') return json(response, 200, { location: { directory: '/work' }, data: { output: 'src/a.js:3: needle here\nsrc/b.js:9: needle too\n', cursor: 20, size: 20, truncated: false } })
  if (path === '/api/shell/sh_1') return json(response, 200, { location: { directory: '/work' }, data: { id: 'sh_1', status: 'exited', exit: 0 } })
  if (path === '/api/shell/sh_1/output') return json(response, 200, { location: { directory: '/work' }, data: { output: 'hi\nexit 0\n', cursor: 9, size: 9, truncated: false } })
  return json(response, 404, { message: 'not found: ' + path })
}

function makeServer(fake) {
  const servers = normalizeServers([{ id: 'v2', url: fake.url, password: 'secret', directory: '/work' }])
  assert.equal(servers.length, 1)
  return servers[0]
}

function lastRequest(fake, method, path) {
  return fake.requests.filter(function (request) {
    const url = new URL(request.url, 'http://localhost')
    return request.method === method && url.pathname === path
  }).pop()
}

test('v2 sessions: list/info/messages/agents/status normalize to the v1 shapes', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const snapshot = await collectServer(server)
    assert.equal(snapshot.state, 'online')
    assert.equal(snapshot.version, '2.3.0')
    assert.equal(snapshot.projects.length, 1)
    assert.equal(snapshot.projects[0].worktree, '/work')
    assert.equal(snapshot.projects[0].sessions[0].directory, '/work')

    const rows = await collectSessionRows([server], undefined, '/work', 'demo', 10)
    assert.equal(rows.count, 1)
    assert.match(rows.text, /demo session/)
    assert.equal(rows.errors.length, 0)

    const messages = await readMessages(server, 'ses_1', 10)
    assert.deepEqual(messages.map(function (message) { return message.role }), ['user', 'assistant'])
    assert.match(messages[1].text, /the answer/)
    assert.match(messages[1].text, /\[tool\] read: completed/)
    assert.match(messages[0].text, /\[file\] note.txt/)
    const listRequest = lastRequest(fake, 'GET', '/api/session/ses_1/message')
    assert.match(listRequest.url, /order=desc/)

    const info = await collectSessionInfo(server, 'ses_1')
    // v2 has no /todo endpoint; todos are derived from todowrite and empty here.
    assert.equal(info.todosSupported, true)
    assert.equal(info.todosDerived, true)
    assert.equal(info.todos.length, 0)
    assert.equal(info.session.outcome, 'succeeded')
    assert.equal(info.session.title, 'demo session')

    const agents = await collectAgents([server])
    assert.equal(agents.count, 1)
    assert.match(agents.text, /build \(Build\) \(primary\)/)

    const status = await collectStatus(server)
    assert.equal(status.ses_9.type, 'running')
    assert.equal(await resolveAgentId(server, 'Build'), 'build')
  } finally {
    await fake.close()
  }
})

test('v2 sessions: abort hits interrupt and share is explicitly unsupported', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    assert.equal(await abortSession(server, 'ses_1'), true)
    assert.ok(lastRequest(fake, 'POST', '/api/session/ses_1/interrupt'))
    const share = await shareSession(server, 'ses_1', 'share')
    assert.equal(share.ok, false)
    assert.match(share.error, /no session share endpoint/)
  } finally {
    await fake.close()
  }
})

test('v2 catalogs: models (no secrets), commands, skills path, mcp status object, tool ids note', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const models = await collectModels([server])
    assert.equal(models.count, 1)
    assert.match(models.text, /\[v2\] p \(Provider\) default=m1 models: m1/)
    assert.doesNotMatch(models.text, /Model Two/) // disabled models are hidden
    assert.doesNotMatch(models.text, /secret/) // provider credentials never surface

    const commands = await collectCommands([server])
    assert.match(commands.text, /\/init — guided setup/)
    const skills = await collectSkills([server])
    assert.match(skills.text, /skill:\/\/s1\/SKILL\.md/)
    assert.doesNotMatch(skills.text, /SECRET BODY/) // skill content is never surfaced
    const mcp = await collectMcpStatus([server])
    assert.match(mcp.text, /drawio: connected/)
    assert.match(mcp.text, /jira: failed \(boom\)/)
    const refs = await collectReferences([server])
    assert.equal(refs.count, 0)
    const toolIds = await collectToolIds([server])
    assert.match(toolIds.text, /not available on OpenCode 2/)
    const search = await collectSessionSearch([server], undefined, 'demo', 5)
    assert.equal(search.count, 1)
    assert.equal(search.rows[0].directory, '/work')
  } finally {
    await fake.close()
  }
})

test('v2 workspace: vcs envelope, mode rename, raw fs read, fs find and async shell', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const status = await gitStatus(server, '/work')
    assert.equal(status.files.length, 1)
    assert.match(status.text, /\[modified\] a\.txt \(\+1 -2\)/)

    const diff = await gitDiff(server, '/work', 'git', true)
    assert.match(diff.text, /@@ -1 \+1 @@/)
    assert.match(lastRequest(fake, 'GET', '/api/vcs/diff').url, /mode=working/)

    const file = await readRemoteFile(server, '/work', 'a.txt')
    assert.equal(file.binary, false)
    assert.match(file.text, /hello from v2/)
    const binary = await readRemoteFile(server, '/work', 'bin.dat')
    assert.equal(binary.binary, true)

    const found = await findFiles(server, '/work', '*.js', 5)
    assert.equal(found.count, 1)
    assert.match(found.text, /src\/a\.js/)
    const findUrls = fake.requests.filter(function (request) { return new URL(request.url, 'http://localhost').pathname === '/api/fs/find' }).map(function (request) { return request.url })
    assert.match(findUrls[findUrls.length - 2], /query=\*\.js/) // glob tried first
    assert.match(findUrls[findUrls.length - 1], /query=\.js/)    // then the stripped substring
    // v2 removed content search; findText emulates it with a workspace grep.
    const textSearch = await findText(server, '/work', 'needle')
    assert.equal(textSearch.mode, 'shell-grep')
    assert.equal(textSearch.count, 2)

    const shell = await runShell(server, 'ses_1', 'echo hi')
    assert.match(shell.text, /hi/)
    const post = lastRequest(fake, 'POST', '/api/shell')
    assert.equal(JSON.parse(post.body).command, 'echo hi')
    assert.equal(JSON.parse(post.body).cwd, '/work')
  } finally {
    await fake.close()
  }
})

test('v2 manage: fork uses before + data, compact replaces summarize, children use parentID', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const forked = await forkSession(server, 'ses_1', 'msg_9')
    assert.equal(forked.id, 'ses_fork')
    assert.equal(forked.directory, '/work')
    assert.equal(JSON.parse(lastRequest(fake, 'POST', '/api/session/ses_1/fork').body).before, 'msg_9')

    assert.equal(await summarize(server, 'ses_1'), true)
    assert.ok(lastRequest(fake, 'POST', '/api/session/ses_1/compact'))

    const children = await sessionChildren(server, 'ses_1')
    assert.equal(children.count, 0)
    assert.match(lastRequest(fake, 'GET', '/api/session').url, /parentID=ses_1/)
  } finally {
    await fake.close()
  }
})

test('v2 prompts: create carries location/agent/model, prompt has text, agent/model are session state', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    server.agent = 'build'
    server.model = { providerID: 'p', modelID: 'm1' }
    const sessionId = await ensureSession(server, { title: 'x', directory: '/work' })
    assert.equal(sessionId, 'ses_new')
    const created = JSON.parse(lastRequest(fake, 'POST', '/api/session').body)
    assert.deepEqual(created.location, { directory: '/work' })
    assert.equal(created.agent, 'build')
    assert.deepEqual(created.model, { id: 'm1', providerID: 'p' })

    const body = await buildPrompt(server, 'hello', { files: [{ filename: 'n.txt', mime: 'text/plain', base64: Buffer.from('inline me').toString('base64') }] })
    assert.equal(body.parts, undefined)
    assert.match(body.text, /hello/)
    assert.match(body.text, /inline me/)
    assert.equal(body.files.length, 1)
    assert.match(body.files[0].uri, /^data:text\/plain;base64,/)
    assert.equal(body.agent, undefined)

    const sent = await sendSessionMessage(server, 'ses_1', body, { wait: false, agent: 'build', model: { providerID: 'p', modelID: 'm1' } })
    assert.equal(sent.accepted, true)
    assert.ok(lastRequest(fake, 'POST', '/api/session/ses_1/prompt'))
    assert.ok(lastRequest(fake, 'POST', '/api/session/ses_1/agent'))
    const modelBody = JSON.parse(lastRequest(fake, 'POST', '/api/session/ses_1/model').body)
    assert.deepEqual(modelBody.model, { id: 'm1', providerID: 'p' })

    await prepareTurn(server, 'ses_1', { agent: 'plan' })
    assert.deepEqual(JSON.parse(lastRequest(fake, 'POST', '/api/session/ses_1/agent').body), { agent: 'plan' })

    assert.equal(await captureTurnBaseline(server, 'ses_1'), 'msg_idle')
    assert.equal(extractAssistant({ type: 'assistant', content: [{ type: 'text', text: 'answer' }] }).text, 'answer')
  } finally {
    await fake.close()
  }
})

test('v2 interactions: permission decisions and typed form answers', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const approvals = []
    const questions = []
    const interactions = createInteractions({
      permissionMode: 'ask',
      questionPolicy: 'reject',
      activeRuns: new Map([['ses_1', { agent: 'lead', directory: '/work' }]]),
      getUserQuestions: function () {
        return {
          ask: function (request) {
            questions.push(request.questions)
            return Promise.resolve({
              answers: [
                { id: 'q0', selected: ['Blue'] },
                { id: 'q1', custom: '7' },
                { id: 'q2', selected: ['A', 'B'] },
              ],
            })
          },
        }
      },
      getApproval: function () {
        return { request: function (request) { approvals.push(request); return Promise.resolve('allowed-once') } }
      },
    })

    interactions.handlePermission(server, { agent: 'lead', sessionId: 'ses_1' }, { id: 'per_1', sessionID: 'ses_1', action: 'read', resources: ['a.txt'] })
    await new Promise(function (resolve) { setTimeout(resolve, 80) })
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].toolName, 'opencode:read')
    const permissionReply = lastRequest(fake, 'POST', '/api/session/ses_1/permission/per_1/reply')
    assert.deepEqual(JSON.parse(permissionReply.body), { decision: 'once' })

    interactions.handleQuestion(server, { agent: 'lead', sessionId: 'ses_1' }, {
      form: {
        id: 'frm_1',
        sessionID: 'ses_1',
        title: 'Questions',
        fields: [
          { key: 'q0', title: 'Color', description: 'Favorite color?', type: 'string', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }], custom: true },
          { key: 'q1', title: 'Count', description: 'How many?', type: 'integer' },
          { key: 'q2', title: 'Tags', description: 'Pick tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
        ],
      },
    })
    await new Promise(function (resolve) { setTimeout(resolve, 80) })
    assert.equal(questions.length, 1)
    assert.equal(questions[0][0].id, 'q0')
    assert.equal(questions[0][0].question, 'Favorite color?')
    const formReply = lastRequest(fake, 'POST', '/api/session/ses_1/form/frm_1/reply')
    assert.deepEqual(JSON.parse(formReply.body), { answer: { q0: 'blue', q1: 7, q2: ['a', 'b'] } })
  } finally {
    await fake.close()
  }
})

test('v2 interactions: reject policy dismisses the form with DELETE', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const interactions = createInteractions({
      permissionMode: 'ask',
      questionPolicy: 'reject',
      activeRuns: new Map(),
      getUserQuestions: function () { return undefined },
      getApproval: function () { return undefined },
    })
    interactions.handleQuestion(server, undefined, { form: { id: 'frm_1', sessionID: 'ses_1', title: 'Q', fields: [{ key: 'q0', type: 'string' }] } })
    await new Promise(function (resolve) { setTimeout(resolve, 80) })
    const dismissed = fake.requests.filter(function (request) { return request.method === 'DELETE' }).pop()
    assert.ok(dismissed)
    assert.equal(dismissed.url, '/api/session/ses_1/form/frm_1')
  } finally {
    await fake.close()
  }
})

test('v2 compat: content search falls back to workspace grep', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const found = await findText(server, '/work', 'needle')
    assert.equal(found.mode, 'shell-grep')
    assert.equal(found.count, 2)
    assert.match(found.text, /src\/a\.js:3: needle here/)
    const shell = lastRequest(fake, 'POST', '/api/shell')
    assert.match(JSON.parse(shell.body).command, /grep -rIn .* -F -e 'needle' \./)
  } finally {
    await fake.close()
  }
})

test('v2 compat: messages follow cursor pages up to the requested limit', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const messages = await readMessages(server, 'ses_long', 120)
    assert.equal(messages.length, 120)
    assert.equal(messages[0].text, 'message 0')
    assert.equal(messages[119].text, 'message 119')
    const pageRequests = fake.requests.filter(function (request) { return request.url.indexOf('/api/session/ses_long/message') >= 0 })
    const cursorRequests = pageRequests.filter(function (request) { return request.url.indexOf('cursor=') >= 0 })
    assert.ok(cursorRequests.length >= 2)
    assert.equal(new URL(pageRequests[0].url, 'http://localhost').searchParams.get('order'), 'desc')
  } finally {
    await fake.close()
  }
})

test('v2 compat: session info derives todos from the last todowrite call', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const info = await collectSessionInfo(server, 'ses_todo')
    assert.equal(info.todosSupported, true)
    assert.equal(info.todosDerived, true)
    assert.equal(info.todos.length, 2)
    assert.deepEqual(info.todos[0], { content: 'write docs', status: 'completed', priority: 'high' })
    assert.deepEqual(info.todos[1], { content: 'run tests', status: 'pending' })
  } finally {
    await fake.close()
  }
})

test('v2 compat: model variants are surfaced', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const models = await collectModels([server])
    assert.match(models.text, /m1\{minimal\|high\}/)
  } finally {
    await fake.close()
  }
})


test('v2 model refs: provider/model#variant parses and reaches Model.Ref only on v2', async function () {
  assert.deepEqual(parseModel('p/m#high'), { providerID: 'p', modelID: 'm', variant: 'high' })
  assert.deepEqual(parseModel('p/m'), { providerID: 'p', modelID: 'm' })
  assert.deepEqual(parseModel({ providerID: 'p', modelID: 'm', variant: 'low' }), { providerID: 'p', modelID: 'm', variant: 'low' })
  assert.deepEqual(modelRef(parseModel('p/m#high')), { id: 'm', providerID: 'p', variant: 'high' })
  // The v1 prompt body must not carry the v2-only variant field.
  const bodyModel = { providerID: 'p', modelID: 'm', variant: 'high' }
  assert.deepEqual(promptBody({ id: 'v1', model: bodyModel }, 'hi').model, { providerID: 'p', modelID: 'm' })
  assert.equal(v2PromptBody({ id: 'v2', model: bodyModel }, 'hi').model, undefined)
})


test('model label shows a non-default variant only', function () {
  assert.equal(modelLabel({ providerID: 'p', id: 'm', variant: 'high' }), 'p/m#high')
  assert.equal(modelLabel({ providerID: 'p', id: 'm', variant: 'default' }), 'p/m')
  assert.equal(modelLabel({ providerID: 'p', id: 'm' }), 'p/m')
  assert.equal(modelLabel({ providerID: 'p', modelID: 'm2' }), 'p/m2')
  assert.equal(modelLabel(undefined), undefined)
})


test('v2 detail: session rows carry model/agent/outcome/cost', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const rows = await collectSessionRows([server])
    assert.match(rows.text, /p\/m1#high/)
    assert.match(rows.text, /agent=build/)
    assert.match(rows.text, /succeeded/)
    assert.match(rows.text, /\$0\.50/)
  } finally {
    await fake.close()
  }
})

test('v2 detail: message tool lines include input and output, and type filters server-side', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const messages = await readMessages(server, 'ses_1', 20)
    const assistant = messages.find(function (message) { return message.role === 'assistant' })
    assert.match(assistant.text, /\[tool\] read: completed · src\/a\.js → export const a = 1/)
    const users = await readMessages(server, 'ses_1', 20, 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0].role, 'user')
    const request = lastRequest(fake, 'GET', '/api/session/ses_1/message')
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('type'), 'user')
  } finally {
    await fake.close()
  }
})

test('v2 detail: shell reports truncated output and an idle interrupt returns false', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const shell = await runShell(server, 'ses_1', 'big output')
    assert.match(shell.text, /line 1/)
    assert.match(shell.text, /\[output truncated at 1234 bytes; cursor=1234\]/)
    assert.equal(await abortSession(server, 'ses_idle'), false)
  } finally {
    await fake.close()
  }
})

test('v2 detail: session info exposes model/parent and models expose token limits', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const info = await collectSessionInfo(server, 'ses_1')
    assert.equal(info.session.parentID, 'ses_root')
    assert.deepEqual(info.session.model, { id: 'm1', providerID: 'p', variant: 'high' })
    const models = await collectModels([server])
    assert.match(models.text, /\[ctx 1M, out 32k\]/)
  } finally {
    await fake.close()
  }
})


test('v2 detail: shell output follows the cursor across pages', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const shell = await runShell(server, 'ses_1', 'page output')
    assert.equal(shell.text, 'aaaabbbb')
    const pageTwo = fake.requests.filter(function (request) {
      return request.url.indexOf('/api/shell/sh_page/output') >= 0 && request.url.indexOf('cursor=4') >= 0
    })
    assert.equal(pageTwo.length, 1)
  } finally {
    await fake.close()
  }
})


test('v2 detail: a non-zero exit is reported even when the shell exited', async function () {
  const fake = await startServer()
  try {
    const server = makeServer(fake)
    const shell = await runShell(server, 'ses_1', 'fail build')
    assert.match(shell.text, /\(shell exited, exit 3\)/)
  } finally {
    await fake.close()
  }
})
