/**
 * Thin adapter around the upstream `@opencode/client`.
 *
 * The pilot migrates one read path at a time: call sites keep their existing
 * caching/normalisation, while URL building, auth headers and `{data}` unwrapping
 * move into the generated client. v1 servers still use the hand-written transport
 * in `http.js` until v1 is removed (the final state is v2-only).
 *
 * The client is pinned to an exact version: its generated API follows OpenCode
 * core's releases, and minor bumps can change payloads.
 */
import { OpenCode } from '@opencode/client'
import { basicAuthorization, OpenCodeError, requireV2 } from './http.js'

const clients = new Map()

function clientKey(server) {
  return String(server.id) + '\n' + String(server.url) + '\n' + String(server.password === undefined || server.password === null ? '' : server.password)
}

/** Cached `@opencode/client` instance for one configured server. */
export function ocClient(server) {
  const key = clientKey(server)
  const cached = clients.get(key)
  if (cached !== undefined) return cached
  const headers = {}
  const authorization = basicAuthorization(server)
  if (authorization !== undefined) headers.authorization = authorization
  const client = OpenCode.make({ baseUrl: server.url, headers: headers })
  clients.set(key, client)
  return client
}

/**
 * Run one generated-client call with a timeout, mapping failures to the same
 * `OpenCodeError` shape the hand-written transport uses (callers already format
 * those messages and treat them as visible failures, never empty data).
 */
export function ocCall(server, run, timeoutMs) {
  const client = ocClient(server)
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 8000
  return requireV2(server).then(function () {
    return run(client, { signal: AbortSignal.timeout(timeout) })
  }).catch(function (error) {
    if (error instanceof OpenCodeError) throw error
    const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    throw new OpenCodeError('opencode.client', 'opencode: ' + String(server.id) + ' request failed: ' + message, { serverId: server.id })
  })
}

/** Test hook: drop cached clients (password/url changes are keyed, but tests want a clean slate). */
export function resetOcClients() {
  clients.clear()
}