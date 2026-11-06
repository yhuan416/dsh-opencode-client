#!/usr/bin/env node
/** Offline smoke checks for the plugin modules (no network, no dsh runtime). */
import assert from 'node:assert/strict'
import * as entry from '../lib/index.js'
import { normalizeServers, parseModel, parsePathMap } from '../lib/config.js'
import { jsonResponse } from '../lib/http.js'
import { promptBody, extractAssistant } from '../lib/delegate.js'
import { parseStructured } from '../lib/run.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand } from '../lib/catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from '../lib/workspace.js'

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

for (const fn of [collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText]) {
  assert.equal(typeof fn, 'function')
}

console.log('check ok')