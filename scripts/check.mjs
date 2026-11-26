#!/usr/bin/env node
/** Offline smoke checks for the plugin modules (no network, no dsh runtime). */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as entry from '../lib/index.js'
import { normalizeServers, normalizeApiVersion, parseModel, parsePathMap } from '../lib/config.js'
import { apiPath, describeApiVersion, jsonResponse, OpenCodeError } from '../lib/http.js'
import { completionKind, eventTarget, normalizeEvent } from '../lib/events.js'
import { promptBody, extractAssistant } from '../lib/delegate.js'
import { stopReasonFor } from '../lib/provider.js'
import { parseStructured } from '../lib/run.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus } from '../lib/catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from '../lib/workspace.js'
import { forkSession, summarize, initSession, sessionChildren } from '../lib/manage.js'
import { abortSession, collectPending } from '../lib/sessions.js'
import { createObservation, observationKey, OBSERVATION_STATUSES } from '../lib/observation.js'

// Client bundle smoke: the helpers the card click depends on must exist (a
// refactor once deleted boardSessionUrl and clicks died silently).
// Syntax gate: `client.js` is a browser bundle that no unit test imports, and
// the string assertions below only see text — a stray brace would ship green.
for (const dir of ['../lib', '../scripts', '../test']) {
  const absolute = fileURLToPath(new URL(dir + '/', import.meta.url))
  for (const name of readdirSync(absolute).sort()) {
    if (!/\.(js|mjs)$/.test(name)) continue
    const file = resolve(absolute, name)
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      assert.fail('syntax error in ' + relative(process.cwd(), file) + '\n' + String(error.stderr ?? ''))
    }
  }
}

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /function boardSessionUrl\(/)
assert.match(clientSource, /function openOverlay\(/)
assert.match(clientSource, /function BoardPage\(/)
// Server filter persistence: the "全部" chip must go through setFilter, or the
// remembered per-server pick survives a remount and the board sticks to it.
assert.match(clientSource, /function setFilter\(next\)/)
assert.match(clientSource, /function setFilter\(next\)[\s\S]{0,200}localStorage\.setItem\("dsh-opencode-board-server"/)
assert.doesNotMatch(clientSource, /boardChip\("全部"[^\n]*setSelected\("all"\)/)
assert.match(clientSource, /boardChip\("全部"[^\n]*setFilter\("all"\)/)
// Unread completions: the "刚完成 · 未查看" section, the seen report and the run
// line must survive refactors — the section is the whole point of the feature.
assert.match(clientSource, /boardSection\("刚完成 · 未查看"/)
assert.match(clientSource, /function markSeen\(serverId, sessionId, idle\)/)
assert.match(clientSource, /\/api\/opencode-client\/seen/)
assert.match(clientSource, /function boardRunLine\(row\)/)
// The watcher polls `unseen`; without it a just-finished row leaves the polled
// set on the same tick it enters unseen, so the completion toast never fires.
assert.match(clientSource, /payload\.needsMe \|\| \[\]\)\.concat\(payload\.unseen/)

// The model-facing board must surface the same partition, or finished-but-unread
// sessions vanish from the agent's view entirely.
const toolsSource = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8')
assert.match(toolsSource, /finished, not looked at/)
assert.match(toolsSource, /snapshot\.unseen/)

// Observation registry: key shape, precedence, and the board projection.
assert.equal(observationKey('n100', 'ses_1'), 'n100\u0000ses_1')
assert.deepEqual(OBSERVATION_STATUSES.slice(0, 2), ['waiting-permission', 'waiting-question'])
assert.equal(typeof collectPending, 'function')
const observationSmoke = createObservation({ now: function () { return 1000 } })
observationSmoke.observeIdentity('s1', { id: 'ses_1', title: 't' })
observationSmoke.observeRunning('s1', new Set(['ses_1']), true)
assert.equal(observationSmoke.rows('s1')[0].status, 'running')
observationSmoke.markPending('s1', 'ses_1', { kind: 'permission', requestId: 'r1', detail: 'bash' })
assert.equal(observationSmoke.board().needsMe.length, 1)
assert.equal(observationSmoke.board().running.length, 0)

// Unread comes from OpenCode's own markers: idle > viewed, and a viewed session
// returns to idle instead of lingering in `unseen`.
const unreadSmoke = createObservation({ now: function () { return 3000 } })
unreadSmoke.observeIdentity('e5', { id: 'ses_u', busyAt: 1000, idleAt: 2000, viewedAt: 500 })
unreadSmoke.observeRunning('e5', new Set(['ses_u']), true)
unreadSmoke.observeRunning('e5', new Set(), true)
assert.equal(unreadSmoke.board().unseen.length, 1)
assert.equal(unreadSmoke.board().idle.length, 0)
unreadSmoke.observeIdentity('e5', { id: 'ses_u', viewedAt: 2000 })
assert.equal(unreadSmoke.board().unseen.length, 0)
assert.equal(unreadSmoke.board().idle.length, 1)

assert.equal(entry.name, 'opencode-client')
assert.deepEqual(entry.inject, ['connection'])
assert.equal(typeof entry.apply, 'function')

assert.deepEqual(parseModel('deepseek/deepseek-chat'), { providerID: 'deepseek', modelID: 'deepseek-chat' })
assert.deepEqual(parseModel({ providerID: 'p', modelID: 'm' }), { providerID: 'p', modelID: 'm' })
assert.equal(parseModel('nope'), undefined)

const servers = normalizeServers([{ id: 'n100', url: 'http://127.0.0.1:4096/', label: 'n100' }])
assert.equal(servers.length, 1)
assert.equal(servers[0].url, 'http://127.0.0.1:4096')
assert.equal(servers[0].label, 'n100')
assert.deepEqual(normalizeServers([{ id: '', url: 'http://x' }]), [])
assert.deepEqual(parsePathMap([{ from: '/a/', to: '/b/' }]), [{ from: '/a', to: '/b' }])
assert.equal(normalizeApiVersion(undefined), 'auto')
assert.equal(normalizeApiVersion('2'), '2')
assert.equal(normalizeServers([{ id: 's', url: 'http://x' }])[0].apiVersion, 'auto')
assert.equal(normalizeServers([{ id: 's', url: 'http://x', apiVersion: 2 }])[0].apiVersion, '2')

assert.equal(apiPath('2', '/session'), '/api/session')
assert.equal(apiPath('2', '/api/reference'), '/api/reference')
assert.equal(apiPath('1', '/session'), '/session')
const probeError = new OpenCodeError('opencode.unauthorized', 'denied', { status: 401, serverId: 's' })
assert.equal(probeError.name, 'OpenCodeError')
assert.equal(probeError.code, 'opencode.unauthorized')
assert.equal(probeError.status, 401)
assert.equal(describeApiVersion({ version: '2', reason: 'probe-ok', status: 200 }), 'v2 (probe-ok, status 200)')

assert.equal(eventTarget('1'), '/global/event')
assert.equal(eventTarget('2'), '/api/event')
const smokeV1 = normalizeEvent('1', { type: 'session.idle', properties: { sessionID: 'ses_1' } })
assert.equal(smokeV1.kind, 'run.finished')
assert.equal(completionKind('1', smokeV1), 'idle')
const smokeV2 = normalizeEvent('2', { type: 'session.text.delta', data: { sessionID: 'ses_1', delta: 'x' } })
assert.equal(smokeV2.kind, 'text.delta')
assert.equal(smokeV2.sessionId, 'ses_1')
const smokeV2Done = normalizeEvent('2', { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })
assert.equal(completionKind('2', smokeV2Done), 'succeeded')
assert.equal(completionKind('2', normalizeEvent('2', { type: 'session.idle', data: { sessionID: 'ses_1' } })), undefined)
assert.equal(normalizeEvent('2', { type: 'future.event', data: {} }).kind, 'unknown')

const body = promptBody(servers[0], 'hello', { agent: 'plan', model: { providerID: 'p', modelID: 'm' } })
assert.equal(body.agent, 'plan')
assert.deepEqual(body.model, { providerID: 'p', modelID: 'm' })
assert.deepEqual(body.parts, [{ type: 'text', text: 'hello' }])

assert.deepEqual(parseStructured('\u0060\u0060\u0060json\n{"answer":"42"}\n\u0060\u0060\u0060', { type: 'object', required: ['answer'] }), { answer: '42' })
assert.equal(parseStructured('not json', { type: 'object' }), undefined)

const reply = jsonResponse({ ok: true })
assert.equal(reply.status, 200)
assert.equal(reply.headers.get('content-type'), 'application/json; charset=utf-8')
assert.deepEqual(await reply.json(), { ok: true })

assert.deepEqual(extractAssistant({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] }), { text: 'ok', structured: undefined, finish: undefined, error: undefined })
assert.equal(stopReasonFor({ finish: 'length' }, false), 'max-tokens')
assert.equal(stopReasonFor({ finish: 'content-filter' }, false), 'refusal')
assert.equal(stopReasonFor({ finish: 'stop' }, true), 'aborted')

for (const fn of [collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus, runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText, forkSession, summarize, initSession, sessionChildren, abortSession]) {
  assert.equal(typeof fn, 'function')
}

console.log('check ok')