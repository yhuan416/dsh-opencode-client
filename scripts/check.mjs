#!/usr/bin/env node
/** Offline smoke checks for the plugin modules (no network, no dsh runtime). */
import assert from 'node:assert/strict'
import * as entry from '../lib/index.js'
import { normalizeServers, normalizeApiVersion, parseModel, parsePathMap } from '../lib/config.js'
import { apiPath, describeApiVersion, jsonResponse, OpenCodeError } from '../lib/http.js'
import { promptBody, extractAssistant } from '../lib/delegate.js'
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

assert.deepEqual(extractAssistant({ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] }), { text: 'ok', structured: undefined })

for (const fn of [collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus, runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText, forkSession, summarize, initSession, sessionChildren, abortSession]) {
  assert.equal(typeof fn, 'function')
}

console.log('check ok')