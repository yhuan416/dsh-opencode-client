import test from 'node:test'
import assert from 'node:assert/strict'

import { createLedger } from '../lib/ledger.js'
import { createRoutes } from '../lib/routes.js'

function routesFor(delegations) {
  return createRoutes({
    servers: [{ id: 'server-a', url: 'http://127.0.0.1:1' }],
    delegate: {},
    observation: {},
    board: {},
    config: {},
    normalizeServers: function (list) { return list },
    delegations: delegations,
  })
}

function routeOf(routes) {
  return routes.find(function (candidate) { return candidate.path === '/api/opencode-client/delegations' })
}

test('GET /delegations serves rows and a summary, and applies limit / server / status', async function () {
  const ledger = createLedger()
  const ok = ledger.begin({ kind: 'delegate', server: 'server-a', task: 'one' })
  ledger.finish(ok, { stopReason: 'completed' })
  const failed = ledger.begin({ kind: 'subagent', server: 'server-b', task: 'two' })
  ledger.finish(failed, { stopReason: 'error', error: new Error('boom') })

  const route = routeOf(routesFor(ledger))
  const all = await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations'), {})
  assert.equal(all.status, 200)
  const body = await all.json()
  assert.equal(body.rows.length, 2)
  assert.equal(body.summary.total, 2)
  assert.equal(body.summary.failed, 1)

  const limited = await (await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations?limit=1'), {})).json()
  assert.equal(limited.rows.length, 1)
  assert.equal(limited.summary.total, 2, 'limit caps rows, not the summary')

  const byServer = await (await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations?server=server-b'), {})).json()
  assert.equal(byServer.rows.length, 1)
  assert.equal(byServer.rows[0].task, 'two')

  const byStatus = await (await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations?status=failed'), {})).json()
  assert.equal(byStatus.rows.length, 1)
  assert.equal(byStatus.rows[0].server, 'server-b')
})

test('DELETE /delegations clears the ledger', async function () {
  const ledger = createLedger()
  ledger.begin({ server: 'server-a' })
  const route = routeOf(routesFor(ledger))
  const response = await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations', { method: 'DELETE' }), {})
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(ledger.size(), 0)
})

test('the route degrades to an empty payload when no ledger is wired', async function () {
  const route = routeOf(routesFor(null))
  const body = await (await route.fetch(new Request('http://127.0.0.1:3080/api/opencode-client/delegations'), {})).json()
  assert.deepEqual(body, { rows: [], summary: null })
})
