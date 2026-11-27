/** Host HTTP routes under /api/opencode-client/. */
import { jsonResponse, readJsonBody, apiVersionOf, ensureApiVersion, describeApiVersion, opencodeValue } from './http.js'
import { collectServer, collectSessionRows, readMessages, collectAgents, collectSessionInfo, shareSession, collectStatus, collectPending, collectStats, abortSession, markSessionViewed, collectCostByDirectory } from './sessions.js'
import { parseModel } from './config.js'
import { collectModels, collectCommands, collectSkills, collectToolIds, collectReferences, runCommand, collectSessionSearch, collectMcpStatus } from './catalog.js'
import { runShell, gitStatus, gitDiff, readRemoteFile, findFiles, findText } from './workspace.js'
import { forkSession, summarize, initSession, sessionChildren } from './manage.js'
import { collectJobs } from './jobs.js'
import { collectInsights } from './insights.js'
import { collectSkillUsage } from './skills.js'
import { latestVersion } from './version.js'
import { buildPrompt } from './delegate.js'
import { sendSessionMessage, ensureSession } from './session-run.js'

export function createRoutes(deps) {
  const servers = deps.servers
  const delegate = deps.delegate
  const observation = deps.observation
  const defaultServer = servers[0]

  const board = deps.board
  const configApi = deps.config
  const normalizeServers = deps.normalizeServers
  const versionSource = typeof deps.versionSource === 'function' ? deps.versionSource : latestVersion

  /**
   * Resolve a route's `server` field against the configured servers; an empty or
   * unknown id falls back to the default (first) server, which is what every
   * handler below expects. (This used to be an unbound name — 16 handlers threw
   * ReferenceError; see the regression test in test/board.test.js.)
   */
  function findServer(body) {
    return servers.find(function (candidate) { return candidate.id === String(body === undefined ? '' : body) }) || defaultServer
  }

  /** Normalize HTTP attachment input ({filename,mime,content|base64}) into data-URL parts. */
  function normalizeAttachments(raw) {
    if (!Array.isArray(raw)) return undefined
    const files = []
    for (const entry of raw.slice(0, 10)) {
      if (entry === null || typeof entry !== 'object') continue
      const base64 = typeof entry.base64 === 'string' ? entry.base64 : (typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8').toString('base64') : '')
      if (base64 === '' || base64.length > 7 * 1024 * 1024) continue
      files.push({
        filename: typeof entry.filename === 'string' ? entry.filename : 'attachment',
        mime: typeof entry.mime === 'string' ? entry.mime : 'application/octet-stream',
        base64: base64,
      })
    }
    return files.length === 0 ? undefined : files
  }

  /** Latest live tool/step name for a server, from the SSE progress map. */
  function activeToolOf(server) {
    if (!(server.progress instanceof Map)) return null
    let latest = null
    for (const progress of server.progress.values()) {
      if (progress === null || typeof progress !== 'object') continue
      if (progress.status === 'tool' && typeof progress.tool === 'string') return progress.tool
      if (progress.status === 'thinking') latest = latest === null ? 'thinking' : latest
    }
    return latest
  }

  const routes = [
    {
      path: '/api/opencode-client/list',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        let chain = Promise.resolve([])
        for (const server of servers) {
          chain = chain.then(function (rows) {
            return collectServer(server).then(function (value) {
              return collectStatus(server).then(function (statuses) {
                const runningIds = new Set(Object.keys(statuses).filter(function (sessionId) {
                  const status = statuses[sessionId]
                  return status !== null && typeof status === 'object' && status.type !== 'idle'
                }))
                if (server.progress instanceof Map) {
                  for (const entry of server.progress.entries()) {
                    const progress = entry[1]
                    if (progress !== null && typeof progress === 'object' && progress.status !== 'idle' && progress.status !== 'error') runningIds.add(entry[0])
                  }
                }
                const running = runningIds.size
                if (observation !== undefined) {
                  const observed = board.observedById(server.id)
                  for (const group of Array.isArray(value.projects) ? value.projects : []) {
                    for (const summary of Array.isArray(group.sessions) ? group.sessions : []) {
                      const row = observed.get(summary.id)
                      summary.status = row === undefined ? 'unknown' : row.status
                      if (row !== undefined && row.stale === true) summary.stale = true
                    }
                  }
                }
                rows.push({
                  id: server.id,
                  label: server.label,
                  url: server.url,
                  state: value.state,
                  version: value.version,
                  live: server.sse !== undefined && server.sse.state === 'open',
                  running: running,
                  activeTool: activeToolOf(server),
                  projects: value.projects,
                })
                return rows
              })
            }, function () {
              rows.push({ id: server.id, label: server.label, url: server.url, state: 'offline', version: null, live: server.sse !== undefined && server.sse.state === 'open', running: 0, activeTool: null, projects: [] })
              return rows
            })
          })
        }
        return chain.then(function (rows) { return jsonResponse({ servers: rows }) })
      },
    },
    {
      path: '/api/opencode-client/probe',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const draft = normalizeServers([{ id: 'probe', url: body !== null && typeof body === 'object' ? body.url : '', password: body !== null && typeof body === 'object' ? body.password : undefined }])
          if (draft.length === 0) return jsonResponse({ ok: false, error: 'url 无效' }, 400)
          const probe = draft[0]
          return ensureApiVersion(probe).then(function (info) {
            const target = '/info'
            return opencodeValue(probe, target, { timeoutMs: 8000 }).then(function (value) {
              const version = value !== null && typeof value === 'object' && typeof value.version === 'string' ? value.version : null
              return jsonResponse({ ok: true, apiVersion: apiVersionOf(probe), version: version, detail: describeApiVersion(info) })
            }, function () {
              return jsonResponse({ ok: true, apiVersion: apiVersionOf(probe), version: null, detail: describeApiVersion(info) })
            })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) })
          })
        }, function (error) {
          return jsonResponse({ ok: false, error: 'invalid body' }, 400)
        })
      },
    },
    {
      path: '/api/opencode-client/servers',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        if (configApi === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'configuration is read-only here' }, 400))
        return readJsonBody(request).then(function (body) {
          const raw = body !== null && typeof body === 'object' && body.server !== null && typeof body.server === 'object' ? body.server : null
          if (raw === null) return jsonResponse({ ok: false, error: 'server is required' }, 400)
          const draft = normalizeServers([raw])
          if (draft.length === 0) return jsonResponse({ ok: false, error: 'id 与 url 必填，且 url 需为 http(s) 地址' }, 400)
          const server = draft[0]
          const record = { id: server.id, url: server.url }
          if (server.label !== server.id) record.label = server.label
          if (server.password !== undefined) record.password = server.password
          if (server.directory !== undefined) record.directory = server.directory
          if (server.apiVersion !== 'auto') record.apiVersion = server.apiVersion
          return configApi.add(record).then(function (result) {
            return jsonResponse(result.ok === true ? { ok: true, server: { id: server.id, url: server.url } } : { ok: false, error: result.error }, result.ok === true ? 200 : 400)
          })
        }, function () { return jsonResponse({ ok: false, error: 'invalid body' }, 400) })
      },
    },
    {
      // Registration is keyed by exact path, so removal needs its own route.
      path: '/api/opencode-client/servers/remove',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        if (configApi === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'configuration is read-only here' }, 400))
        return readJsonBody(request).then(function (body) {
          const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : ''
          if (id === '') return jsonResponse({ ok: false, error: 'id is required' }, 400)
          return configApi.remove(id).then(function (result) {
            return jsonResponse(result.ok === true ? { ok: true, id: id } : { ok: false, error: result.error }, result.ok === true ? 200 : 400)
          })
        }, function () { return jsonResponse({ ok: false, error: 'invalid body' }, 400) })
      },
    },
    {
      path: '/api/opencode-client/usage',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const rawFrom = Number(url.searchParams.get('from') === null ? '0' : url.searchParams.get('from'))
        const from = Number.isFinite(rawFrom) && rawFrom >= 0 ? Math.floor(rawFrom) : 0
        const wanted = url.searchParams.get('server')
        // `group=directory` opts into the per-directory split. It reads messages
        // (one or two pages per priced session) because only per-message cost is
        // window-scoped — see collectCostByDirectory.
        // so an unsupported row must not pay for a directory pull either.
        const grouped = url.searchParams.get('group') === 'directory'
        const chain = []
        for (const server of servers) {
          if (wanted !== null && wanted !== '' && server.id !== wanted) continue
          chain.push(collectStats(server, { from: from }).then(function (value) {
            if (grouped !== true || value.supported !== true) return { id: server.id, label: server.label, ...value }
            return collectCostByDirectory(server, { from: from }).then(function (byDirectory) {
              const summary = byDirectory.total !== null && typeof byDirectory.total === 'object' ? byDirectory.total : {}
              return {
                id: server.id, label: server.label, ...value,
                directories: byDirectory.directories,
                // Un-truncated totals: the display list is top-10, reconciliation
                // must not be biased by that cut.
                directoryCost: typeof summary.cost === 'number' ? summary.cost : 0,
                directoryCount: typeof summary.directoryCount === 'number' ? summary.directoryCount : byDirectory.directories.length,
                directoryKind: byDirectory.kind,
                directoryPartial: summary.partial === true,
                directoryRetried: typeof summary.retried === 'number' ? summary.retried : 0,
                directoryFailures: Array.isArray(summary.failures) ? summary.failures : [],
                directoryError: byDirectory.error,
              }
            })
          }, function (error) {
            return { id: server.id, label: server.label, supported: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }
          }))
        }
        return Promise.all(chain).then(function (rows) {
          const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0, steps: 0 }
          const byModel = new Map()
          const byDirectory = new Map()
          const directoryKinds = new Set()
          let directoryPartial = false
          let directoryCost = 0
          let directoryCount = 0
          let directoryRetried = 0
          const directoryFailures = []
          for (const row of rows) {
            if (row.supported !== true) continue
            total.input += row.tokens.input
            total.output += row.tokens.output
            total.reasoning += row.tokens.reasoning
            total.cacheRead += row.tokens.cacheRead
            total.cacheWrite += row.tokens.cacheWrite
            total.cost += row.cost
            total.sessions += row.sessions
            total.steps += row.steps
            for (const model of Array.isArray(row.models) ? row.models : []) {
              const entry = byModel.get(model.model) ?? { model: model.model, cost: 0, steps: 0 }
              entry.cost += model.cost
              entry.steps += model.steps
              byModel.set(model.model, entry)
            }
            for (const directory of Array.isArray(row.directories) ? row.directories : []) {
              const entry = byDirectory.get(directory.directory) ?? { directory: directory.directory, cost: 0, sessions: 0 }
              entry.cost += directory.cost
              entry.sessions += directory.sessions
              byDirectory.set(directory.directory, entry)
            }
            if (typeof row.directoryCost === 'number' && Number.isFinite(row.directoryCost)) directoryCost += row.directoryCost
            if (typeof row.directoryCount === 'number' && Number.isFinite(row.directoryCount)) directoryCount += row.directoryCount
            if (typeof row.directoryKind === 'string' && row.directoryKind !== '') directoryKinds.add(row.directoryKind)
            if (row.directoryPartial === true) directoryPartial = true
            directoryRetried += row.directoryRetried
            for (const failure of Array.isArray(row.directoryFailures) ? row.directoryFailures : []) {
              if (directoryFailures.length < 5) directoryFailures.push({ server: row.id, ...failure })
            }
          }
          total.byModel = Array.from(byModel.values()).sort(function (a, b) { return b.cost - a.cost }).slice(0, 10)
          if (grouped === true) {
            // The directory split is only comparable with `total.cost` when it is
            // window-scoped (kind `windowed`); say so in the payload instead of
            // leaving the two numbers to look identical. `directoryCost` is the
            // un-truncated per-server total, so the top-10 display cut above
            // cannot make a healthy fleet look inconsistent.
            total.byDirectory = Array.from(byDirectory.values()).sort(function (a, b) { return b.cost - a.cost }).slice(0, 10)
            total.byDirectoryCount = directoryCount
            total.byDirectoryKind = directoryKinds.size === 0 ? undefined : (directoryKinds.size === 1 ? Array.from(directoryKinds)[0] : 'mixed')
            total.byDirectoryPartial = directoryPartial
            total.byDirectoryRetried = directoryRetried
            total.byDirectoryFailures = directoryFailures
            total.byDirectoryDelta = Math.round((directoryCost - total.cost) * 1e6) / 1e6
            total.reconciled = Math.abs(directoryCost - total.cost) <= Math.max(0.01, total.cost * 0.01)
          }
          return jsonResponse({ ok: true, from: from, to: Date.now(), total: total, servers: rows })
        })
      },
    },
    {
      // Mark a session read on the remote: OpenCode keeps the read marker itself
      // (`time.viewed`), so this is a thin `POST /session/{id}/view` and both UIs
      // stay in sync. The `idle` value must come from the caller's board row: a
      // guessed clock could run ahead of a live run and mark an in-flight turn read.
      path: '/api/opencode-client/seen',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          let idle = typeof body.idle === 'number' && Number.isFinite(body.idle) && body.idle > 0 ? Math.floor(body.idle) : undefined
          if (idle === undefined && observation !== undefined && typeof observation.rows === 'function') {
            const row = observation.rows(server.id).find(function (candidate) { return candidate.sessionId === session })
            if (row !== undefined && typeof row.idleAt === 'number') idle = row.idleAt
          }
          if (idle === undefined) return jsonResponse({ ok: false, supported: true, error: 'idle required' }, 400)
          // Clear the local reminder as soon as the human looked, even if the
          // remote marker write fails: the next refresh reads `viewed` again and
          // would otherwise resurrect the card.
          if (observation !== undefined && typeof observation.markSeen === 'function') observation.markSeen(server.id, session)
          return markSessionViewed(server, session, idle).then(function (result) {
            return jsonResponse({ ok: result.ok === true, server: server.id, session: session, idle: idle, supported: result.supported === true, error: result.error }, result.ok === true || result.supported === false ? 200 : 502)
          })
        }, function () { return jsonResponse({ ok: false, error: 'invalid body' }, 400) })
      },
    },
    {
      path: '/api/opencode-client/board',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const refresh = url.searchParams.get('refresh') !== '0'
        const idleRaw = Number(url.searchParams.get('idleLimit') === null ? '20' : url.searchParams.get('idleLimit'))
        const idleLimit = Number.isFinite(idleRaw) && idleRaw >= 0 ? Math.min(Math.floor(idleRaw), 200) : 20
        return (refresh ? board.refreshAll() : Promise.resolve()).then(function () {
          // `snapshot` must not shadow `board` (the refresher service) — shadowing
          // silently made serverInfo() undefined and every server look offline.
          const snapshot = observation.board({ idleLimit: idleLimit })
          return jsonResponse({
            ok: true,
            at: snapshot.at,
            servers: servers.map(function (server) {
              const rowsOfServer = observation.rows(server.id)
              const info = typeof board.serverInfo === 'function' ? board.serverInfo(server.id) : undefined
              return {
                id: server.id,
                label: server.label,
                url: server.url,
                version: info === undefined ? null : info.version,
                state: info === undefined ? 'offline' : info.state,
                groups: info === undefined ? 0 : info.groups,
                apiVersion: apiVersionOf(server),
                // Health: why the version probe decided what it did, and whether the
                // event stream had to reconnect (counters live on server.sse).
                probe: typeof server.versionProbe === 'object' && server.versionProbe !== null
                  ? { version: server.versionProbe.version, reason: server.versionProbe.reason, at: server.versionProbe.at, detail: server.versionProbe.detail }
                  : null,
                sse: server.sse === undefined
                  ? null
                  : { state: server.sse.state, attempts: server.sse.attempts, connects: server.sse.connects, openedAt: server.sse.openedAt },
                sessions: rowsOfServer.length,
                live: server.sse !== undefined && server.sse.state === 'open',
                running: rowsOfServer.filter(function (row) { return row.status === 'running' }).length,
                background: rowsOfServer.filter(function (row) { return row.status === 'background' }).length,
                pending: rowsOfServer.filter(function (row) { return row.pending !== null }).length,
              }
            }),
            needsMe: snapshot.needsMe,
            unseen: snapshot.unseen,
            unseenCount: snapshot.unseenCount,
            running: snapshot.running,
            background: snapshot.background,
            backgroundCount: snapshot.backgroundCount,
            idle: snapshot.idle,
            idleCount: snapshot.idleCount,
            unknown: snapshot.unknown,
          })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      // Latest OpenCode release for the server-card badge. Cached server-side for
      // an hour; failures are reported as `ok:false` so the UI shows no badge.
      path: '/api/opencode-client/upgrade',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        return Promise.resolve(versionSource()).then(function (value) {
          const result = value !== null && typeof value === 'object' ? value : {}
          return jsonResponse({
            ok: result.ok === true,
            latest: result.latest,
            checkedAt: result.checkedAt,
            error: result.ok === true ? undefined : result.error,
          })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      // Fleet insights for the board's top area. Window-scoped aggregates only:
      // see lib/insights.js for why lifetime session values are not used.
      path: '/api/opencode-client/insights',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const rawFrom = Number(url.searchParams.get('from') === null ? '0' : url.searchParams.get('from'))
        const from = Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : undefined
        const rawDays = Number(url.searchParams.get('days') === null ? '0' : url.searchParams.get('days'))
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 30) : undefined
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectInsights(servers, { from: from, days: days, serverId: server }).then(function (result) {
          return jsonResponse({ ok: true, from: result.from, to: result.to, total: result.total, servers: result.servers })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      // Per-skill counts. Separate from /insights because it walks messages (the
      // only place the skill name exists) and is fetched lazily by the page.
      path: '/api/opencode-client/insights/skills',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const rawDays = Number(url.searchParams.get('days') === null ? '7' : url.searchParams.get('days'))
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 30) : 7
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectSkillUsage(servers, { days: days, serverId: server }).then(function (result) {
          return jsonResponse({ ok: true, from: result.from, to: result.to, days: result.days, total: result.total, servers: result.servers })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/sessions',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null ? undefined : url.searchParams.get('server')
        const directory = url.searchParams.get('directory') === null ? undefined : url.searchParams.get('directory')
        const query = url.searchParams.get('query') === null ? undefined : url.searchParams.get('query')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const archived = url.searchParams.get('archived') === '1' || url.searchParams.get('archived') === 'true'
        const cursor = url.searchParams.get('cursor') === null || url.searchParams.get('cursor') === '' ? undefined : url.searchParams.get('cursor')
        return collectSessionRows(servers, server, directory, query, limit, { archived: archived, cursor: cursor }).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, shown: result.shown, text: result.text, nextCursor: result.nextCursor })
        })
      },
    },
    {
      path: '/api/opencode-client/messages',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = servers.find(function (candidate) { return candidate.id === String(url.searchParams.get('server') === null ? '' : url.searchParams.get('server')) })
        const sessionId = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || sessionId === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        const rawLimit = Number(url.searchParams.get('limit') === null ? '20' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 20
        return readMessages(server, sessionId, limit).then(function (messages) {
          return jsonResponse({ ok: true, server: server.id, session: sessionId, messages: messages })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/fork',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          const message = typeof body.message === 'string' && body.message !== '' ? body.message : undefined
          return forkSession(server, session, message).then(function (created) {
            return jsonResponse({ ok: true, server: server.id, session: session, forked: created })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/summarize',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const model = parseModel(body.model)
          if (server === undefined || session === '' || model === undefined) return jsonResponse({ ok: false, error: 'server, session and model "provider/model" required' }, 400)
          return summarize(server, session, model.providerID, model.modelID).then(function (done) {
            return jsonResponse({ ok: true, server: server.id, session: session, summarized: done })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/init',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const model = parseModel(body.model)
          if (body.confirm !== true) return jsonResponse({ ok: false, error: 'init writes AGENTS.md; pass confirm:true to run' }, 400)
          if (server === undefined || session === '' || model === undefined) return jsonResponse({ ok: false, error: 'server, session and model "provider/model" required' }, 400)
          return initSession(server, session, model.providerID, model.modelID).then(function (done) {
            return jsonResponse({ ok: true, server: server.id, session: session, initialized: done })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/children',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const session = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || session === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        return sessionChildren(server, session).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, session: session, count: result.count, children: result.rows, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/shell',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const command = typeof body.command === 'string' ? body.command : ''
          if (server === undefined || session === '' || command === '') return jsonResponse({ ok: false, error: 'server, session and command required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return runShell(server, session, command, directory).then(function (result) {
            return jsonResponse({ ok: true, server: server.id, session: result.sessionId, text: result.text })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/git/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        if (server === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'no server' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        return gitStatus(server, directory).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, count: result.files.length, files: result.files, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/git/diff',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        if (server === undefined) return Promise.resolve(jsonResponse({ ok: false, error: 'no server' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const requestedMode = url.searchParams.get('mode')
        const mode = requestedMode === 'branch' || requestedMode === 'committed' ? requestedMode : 'git'
        const patch = url.searchParams.get('patch') === '1' || url.searchParams.get('patch') === 'true'
        const rawUntracked = url.searchParams.get('untracked')
        const untracked = rawUntracked === 'files' || rawUntracked === 'folders' ? rawUntracked : (rawUntracked === '1' || rawUntracked === 'true' ? 'files' : undefined)
        const base = url.searchParams.get('base') === null || url.searchParams.get('base') === '' ? undefined : url.searchParams.get('base')
        return gitDiff(server, directory, mode, patch, { untracked: untracked, base: base }).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/file',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const path = url.searchParams.get('path') === null ? '' : url.searchParams.get('path')
        if (server === undefined || path === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and path required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        return readRemoteFile(server, directory, path).then(function (result) {
          return jsonResponse({ ok: true, server: server.id, path: path, binary: result.binary, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/find',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const query = url.searchParams.get('query') === null ? '' : url.searchParams.get('query')
        if (server === undefined || query === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and query required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const rawKind = url.searchParams.get('kind')
        const kind = rawKind === 'text' ? 'text' : (rawKind === 'dir' || rawKind === 'directory' ? 'dir' : 'file')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const pending = kind === 'text' ? findText(server, directory, query) : findFiles(server, directory, query, limit, kind)
        return pending.then(function (result) {
          return jsonResponse({ ok: true, server: server.id, kind: kind, count: result.count, text: result.text })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/models',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectModels(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/commands',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectCommands(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/skills',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectSkills(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/tools',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectToolIds(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/references',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectReferences(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/command',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const command = typeof body.command === 'string' ? body.command : ''
          if (server === undefined || session === '' || command === '') return jsonResponse({ ok: false, error: 'server, session and command required' }, 400)
          const args = typeof body.arguments === 'string' ? body.arguments : ''
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return runCommand(server, session, command, args, directory).then(function (result) {
            return jsonResponse({ ok: true, server: server.id, session: result.sessionId, text: result.text })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/agents',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectAgents(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/session-info',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = findServer(url.searchParams.get('server') === null ? '' : url.searchParams.get('server'))
        const session = url.searchParams.get('session') === null ? '' : url.searchParams.get('session')
        if (server === undefined || session === '') return Promise.resolve(jsonResponse({ ok: false, error: 'server and session required' }, 400))
        return collectSessionInfo(server, session).then(function (info) {
          return jsonResponse({ ok: true, server: server.id, session: session, info: info })
        }, function (error) {
          return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
        })
      },
    },
    {
      path: '/api/opencode-client/share',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          const action = body.action === 'unshare' ? 'unshare' : 'share'
          return shareSession(server, session, action).then(function (result) {
            return jsonResponse(Object.assign({ ok: result.ok, server: server.id, session: session, action: action }, result.ok ? { url: result.url } : { error: result.error }))
          })
        })
      },
    },
    {
      path: '/api/opencode-client/events',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const serverId = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '50' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50
        const events = []
        for (const server of servers) {
          if (serverId !== undefined && server.id !== serverId) continue
          const buffered = Array.isArray(server.events) ? server.events : []
          for (const event of buffered) events.push(Object.assign({ server: server.id }, event))
        }
        events.sort(function (a, b) { return (b.at || 0) - (a.at || 0) })
        const capped = events.slice(0, limit)
        return Promise.resolve(jsonResponse({ ok: true, count: events.length, shown: capped.length, events: capped, live: servers.map(function (server) { return { id: server.id, state: server.sse === undefined ? 'closed' : server.sse.state } }) }))
      },
    },
    {
      path: '/api/opencode-client/status',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        const rows = []
        let chain = Promise.resolve()
        for (const server of servers) {
          chain = chain.then(function () {
            return collectStatus(server).then(function (statuses) {
              for (const sessionId of Object.keys(statuses)) {
                const status = statuses[sessionId]
                if (status === null || typeof status !== 'object') continue
                if (status.type === 'idle') continue
                const progress = server.progress instanceof Map ? server.progress.get(sessionId) : undefined
                rows.push({
                  server: server.id,
                  session: sessionId,
                  status: typeof status.type === 'string' ? status.type : null,
                  tool: progress !== undefined && typeof progress.tool === 'string' ? progress.tool : null,
                  progress: progress !== undefined ? progress.status : null,
                  since: progress !== undefined && typeof progress.since === 'number' ? progress.since : null,
                  tail: progress !== undefined && typeof progress.tail === 'string' ? progress.tail : '',
                })
              }
            })
          })
        }
        return chain.then(function () {
          const seen = new Set(rows.map(function (row) { return row.server + ':' + row.session }))
          for (const server of servers) {
            if (!(server.progress instanceof Map)) continue
            for (const entry of server.progress.entries()) {
              const progress = entry[1]
              if (progress === null || typeof progress !== 'object' || progress.status === 'idle' || progress.status === 'error') continue
              if (seen.has(server.id + ':' + entry[0])) continue
              rows.push({
                server: server.id,
                session: entry[0],
                status: 'busy',
                tool: typeof progress.tool === 'string' ? progress.tool : null,
                progress: progress.status,
                since: typeof progress.since === 'number' ? progress.since : null,
                tail: typeof progress.tail === 'string' ? progress.tail : '',
              })
            }
          }
          const jobSeen = new Set(rows.map(function (row) { return row.server + ':' + row.session }))
          let chain2 = Promise.resolve()
          for (const server of servers) {
            chain2 = chain2.then(function () {
              return collectJobs(server).then(function (result) {
                if (result.supported !== true) return
                for (const job of result.jobs) {
                  if (jobSeen.has(server.id + ':' + job.sessionID)) continue
                  jobSeen.add(server.id + ':' + job.sessionID)
                  rows.push({
                    server: server.id,
                    session: job.sessionID,
                    status: 'background',
                    tool: job.kind,
                    progress: 'background',
                    since: typeof job.startedAt === 'number' ? job.startedAt : null,
                    tail: job.command.slice(0, 200),
                  })
                }
              })
            })
          }
          return chain2.then(function () {
            return jsonResponse({ ok: true, running: rows })
          })
        })
      },
    },
    {
      path: '/api/opencode-client/prompt',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          const message = typeof body.message === 'string' ? body.message : ''
          if (server === undefined || session === '' || message === '') return jsonResponse({ ok: false, error: 'server, session and message required' }, 400)
          const turn = {}
          if (typeof body.agent === 'string' && body.agent !== '') turn.agent = body.agent
          const model = parseModel(body.model)
          if (model !== undefined) turn.model = model
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return buildPrompt(server, message, turn).then(function (prompt) {
            return sendSessionMessage(server, session, prompt, { wait: body.wait === true, directory: directory, agent: turn.agent, model: turn.model })
          }).then(function (result) {
            return jsonResponse(Object.assign({ ok: true, server: server.id, session: session }, result))
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/abort',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          const session = typeof body.session === 'string' ? body.session : ''
          if (server === undefined || session === '') return jsonResponse({ ok: false, error: 'server and session required' }, 400)
          return abortSession(server, session).then(function (aborted) {
            return jsonResponse({ ok: true, server: server.id, session: session, aborted: aborted })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/search',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        const query = url.searchParams.get('query') === null ? '' : url.searchParams.get('query')
        if (query === '') return Promise.resolve(jsonResponse({ ok: false, error: 'query required' }, 400))
        const directory = url.searchParams.get('directory') === null || url.searchParams.get('directory') === '' ? undefined : url.searchParams.get('directory')
        const rawLimit = Number(url.searchParams.get('limit') === null ? '20' : url.searchParams.get('limit'))
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20
        return collectSessionSearch(servers, server, query, limit, directory).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, sessions: result.rows, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/mcp',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function (request) {
        const url = new URL(request.url, 'http://localhost')
        const server = url.searchParams.get('server') === null || url.searchParams.get('server') === '' ? undefined : url.searchParams.get('server')
        return collectMcpStatus(servers, server).then(function (result) {
          return jsonResponse({ ok: true, count: result.count, text: result.text })
        })
      },
    },
    {
      path: '/api/opencode-client/progress',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: function () {
        const rows = []
        for (const server of servers) {
          if (!(server.progress instanceof Map)) continue
          for (const entry of server.progress.entries()) {
            const sessionId = entry[0]
            const progress = entry[1]
            if (progress === null || typeof progress !== 'object') continue
            rows.push({
              server: server.id,
              session: sessionId,
              status: progress.status,
              tool: progress.tool,
              since: progress.since,
              elapsedMs: typeof progress.since === 'number' ? Math.max(0, Date.now() - progress.since) : null,
              tail: progress.tail,
            })
          }
        }
        const seen = new Set(rows.map(function (row) { return row.server + ':' + row.session }))
        let chain = Promise.resolve()
        for (const server of servers) {
          chain = chain.then(function () {
            return collectJobs(server).then(function (result) {
              if (result.supported !== true) return
              for (const job of result.jobs) {
                if (seen.has(server.id + ':' + job.sessionID)) continue
                seen.add(server.id + ':' + job.sessionID)
                rows.push({
                  server: server.id,
                  session: job.sessionID,
                  status: 'background',
                  tool: job.kind,
                  since: typeof job.startedAt === 'number' ? job.startedAt : null,
                  elapsedMs: typeof job.startedAt === 'number' ? Math.max(0, Date.now() - job.startedAt) : null,
                  tail: '',
                  job: job,
                })
              }
            })
          })
        }
        return chain.then(function () {
          return jsonResponse({ ok: true, count: rows.length, progress: rows })
        })
      },
    },
    {
      path: '/api/opencode-client/delegate',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          if (server === undefined) return jsonResponse({ ok: false, error: 'no opencode server configured' }, 400)
          const task = typeof body.task === 'string' ? body.task : ''
          if (task === '') return jsonResponse({ ok: false, error: 'task required' }, 400)
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          const session = typeof body.session === 'string' && body.session !== '' ? body.session : undefined
          const options = {}
          if (typeof body.agent === 'string' && body.agent !== '') options.agent = body.agent
          const model = parseModel(body.model)
          if (model !== undefined) options.model = model
          if (typeof body.schema === 'string' && body.schema !== '') {
            try { options.jsonSchema = JSON.parse(body.schema) } catch (error) {}
          }
          const attachments = normalizeAttachments(body.files)
          if (attachments !== undefined) options.files = attachments
          return delegate(server, directory, task, session, options).then(function (outcome) {
            const payload = { ok: true, sessionId: outcome.sessionId, text: outcome.text }
            if (outcome.structured !== undefined && outcome.structured !== null) payload.structured = outcome.structured
            return jsonResponse(payload)
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error) }, 500)
          })
        })
      },
    },
    {
      path: '/api/opencode-client/session',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: function (request) {
        return readJsonBody(request).then(function (body) {
          const server = findServer(body.server)
          if (server === undefined) return jsonResponse({ ok: false, error: 'unknown opencode server' }, 400)
          const title = typeof body.title === 'string' && body.title !== '' ? body.title : 'session'
          const directory = typeof body.directory === 'string' && body.directory !== '' ? body.directory : undefined
          return ensureSession(server, { title: title, directory: directory, errorPrefix: 'opencode create failed' }).then(function (sessionId) {
            server.snapshot = undefined
            return jsonResponse({ ok: true, session: { id: sessionId, title: title, directory: directory === undefined ? null : directory }, url: server.url + '/', sessionUrl: server.url + '/session/' + sessionId })
          }, function (error) {
            return jsonResponse({ ok: false, error: String(error && error.message !== undefined ? error.message : error) })
          })
        })
      },
    },
  ]
  return routes
}
