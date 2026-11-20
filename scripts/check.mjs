#!/usr/bin/env node
/** Offline smoke checks for the plugin modules (no network, no dsh runtime). */
import assert from 'node:assert/strict'
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
import { abortSession } from '../lib/sessions.js'

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