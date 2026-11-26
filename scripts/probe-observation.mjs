#!/usr/bin/env node
/**
 * Observation probe — collect real session state from one `opencode serve`
 * without dsh and without any UI.
 *
 * This is the acceptance surface of the observation slice: if the probe prints
 * the right rows, the registry is collecting; the panel only re-renders it.
 *
 * Usage:
 *   OPC_PROBE_URL=http://192.168.4.65:4096 \
 *   [OPC_PROBE_PASSWORD='<OPENCODE_SERVER_PASSWORD, v2 only>'] \
 *   [OPC_PROBE_ID=n100] \
 *   [OPC_PROBE_JSON=1] \
 *   node scripts/probe-observation.mjs
 *
 * Exit codes: 0 ok, 2 missing url, 3 every source failed.
 */
import { normalizeServers } from '../lib/config.js'
import { ensureApiVersion, describeApiVersion, apiVersionOf } from '../lib/http.js'
import { collectServer, collectStatus, collectPending } from '../lib/sessions.js'
import { createObservation } from '../lib/observation.js'

const url = process.env.OPC_PROBE_URL
if (url === undefined || url === '') {
  console.error('OPC_PROBE_URL is required (e.g. http://192.168.4.65:4096)')
  process.exit(2)
}
const servers = normalizeServers([{
  id: process.env.OPC_PROBE_ID || 'probe',
  label: process.env.OPC_PROBE_ID || 'probe',
  url: url,
  password: process.env.OPC_PROBE_PASSWORD,
}])
const asJson = process.env.OPC_PROBE_JSON === '1'

function ago(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '-'
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  return Math.round(minutes / 60) + 'h'
}

function pad(value, width) {
  const text = value === undefined || value === null ? '-' : String(value)
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)
}

const observation = createObservation()
const report = []
let failures = 0

for (const server of servers) {
  let version = '?'
  try {
    const info = await ensureApiVersion(server)
    version = describeApiVersion(info)
  } catch (error) {
    failures += 1
    report.push({ id: server.id, url: server.url, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
    continue
  }

  let identity = { projects: [] }
  try {
    identity = await collectServer(server)
  } catch (error) {
    failures += 1
  }
  const groups = Array.isArray(identity.projects) ? identity.projects : []
  let sessionCount = 0
  for (const group of groups) {
    for (const summary of Array.isArray(group.sessions) ? group.sessions : []) {
      observation.observeIdentity(server.id, summary)
      sessionCount += 1
    }
  }

  let statuses = {}
  try {
    statuses = await collectStatus(server)
  } catch (error) {}
  const runningIds = new Set(Object.keys(statuses).filter(function (sessionId) {
    const status = statuses[sessionId]
    return status !== null && typeof status === 'object' && status.type !== 'idle'
  }))
  observation.observeRunning(server.id, runningIds, true)

  let pending = []
  try {
    pending = await collectPending(server, Array.from(runningIds))
  } catch (error) {}
  observation.observePendingSnapshot(server.id, pending)

  report.push({
    id: server.id,
    url: server.url,
    version: version,
    apiVersion: apiVersionOf(server),
    sessions: sessionCount,
    running: runningIds.size,
    pending: pending.length,
  })
}

const board = observation.board({ idleLimit: 50 })

if (asJson) {
  console.log(JSON.stringify({ servers: report, board: board }, null, 2))
} else {
  for (const line of report) {
    if (line.error !== undefined) {
      console.log('server ' + line.id + '  ' + (line.url ?? '') + '  ERROR ' + line.error)
      continue
    }
    console.log('server ' + line.id + '  ' + line.url + '  ' + line.version + '  sessions=' + line.sessions + '  running=' + line.running + '  pending=' + line.pending)
  }
  const sections = [
    ['需要你', board.needsMe],
    ['运行中', board.running],
    ['其他', board.unknown],
    ['空闲', board.idle],
  ]
  for (const [title, list] of sections) {
    if (list.length === 0) continue
    console.log('')
    console.log('--- ' + title + ' (' + list.length + (title === '空闲' && board.idleCount > list.length ? ' / ' + board.idleCount : '') + ') ---')
    for (const row of list) {
      const age = ago(row.since)
      const detail = row.pending !== null
        ? row.pending.detail + '  ' + ago(row.pending.at)
        : (row.progress !== null && row.progress.tool !== undefined ? 'tool=' + row.progress.tool : '')
      console.log(pad(row.status, 18) + ' ' + pad(row.serverId, 8) + ' ' + pad(row.sessionId, 24) + ' ' + pad(row.title, 28) + ' ' + pad(row.directory, 34) + ' ' + pad(age, 5) + ' ' + detail)
    }
  }
  if (board.needsMe.length === 0 && board.running.length === 0) console.log('\n(no session is running or waiting)')
}

process.exit(failures === servers.length ? 3 : 0)