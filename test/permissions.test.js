import assert from 'node:assert/strict'
import { test } from 'node:test'

test('permission log counts each answer and keeps a bounded ring (issue #57)', async function () {
  const { createPermissionLog } = await import('../lib/permissions.js')
  const log = createPermissionLog({ limit: 2 })
  assert.equal(log.snapshot('e5'), undefined)
  log.record('e5', { action: 'read', resources: ['.env'], reply: 'once', source: 'host-approval' })
  log.record('e5', { action: 'read', resources: ['.env'], reply: 'reject', source: 'host-approval' })
  log.record('e5', { action: 'bash', resources: ['ls'], reply: 'auto', source: 'ask-no-approval' })
  log.record('e5', { action: 'write', resources: [], reply: 'pending', source: 'unowned-session' })
  const state = log.snapshot('e5')
  assert.equal(state.asked, 4)
  assert.equal(state.userApproved, 1)
  assert.equal(state.autoApproved, 1)
  assert.equal(state.rejected, 1)
  assert.equal(state.pending, 1)
  assert.equal(state.recent.length, 2)
  assert.equal(log.snapshot('n100'), undefined)
})

test('/board exposes permission diagnostics per server', async function () {
  const { createRoutes } = await import('../lib/routes.js')
  const { createObservation } = await import('../lib/observation.js')
  const { createPermissionLog } = await import('../lib/permissions.js')
  const { normalizeServers } = await import('../lib/config.js')
  const permissions = createPermissionLog({ limit: 5 })
  permissions.record('e5', { action: 'read', resources: ['.env'], reply: 'auto', source: 'ask-no-approval' })
  const observation = createObservation()
  const routes = createRoutes({
    servers: [{ id: 'e5', label: 'e5', url: 'http://127.0.0.1:4096', sse: { state: 'open' } }],
    delegate: {},
    observation: observation,
    board: { observedById: function () { return new Map() }, refreshAll: function () { return Promise.resolve() }, snapshot: function (options) { return observation.board(options) }, serverInfo: function () { return undefined } },
    normalizeServers: normalizeServers,
    permissions: permissions,
  })
  const route = routes.find(function (candidate) { return candidate.path === '/api/opencode-client/board' })
  const payload = await (await route.fetch({ url: '/api/opencode-client/board' })).json()
  assert.equal(payload.servers[0].permissions.asked, 1)
  assert.equal(payload.servers[0].permissions.autoApproved, 1)
})
