/**
 * Minimal HTTP client for the OpenCode API.
 *
 * OpenCode 1.18.x/1.19.x (v1) is the baseline. OpenCode 2 serves the same
 * resources under `/api/*` and requires HTTP Basic auth (user `opencode`, the
 * password from the serve process env `OPENCODE_SERVER_PASSWORD`). The
 * transport probes `GET /api/info` once per server, then routes every request
 * to the detected API version. Transport failures are raised as
 * `OpenCodeError` — they are never degraded into `undefined`/empty data.
 */
import http from 'node:http'

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const API_VERSIONS = ['auto', '1', '2']

/** Recognisable transport/HTTP failure. Callers must surface it, not treat it as empty data. */
export class OpenCodeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'OpenCodeError'
    this.code = code
    const extra = details === undefined || details === null ? {} : details
    this.status = extra.status
    this.contentType = extra.contentType
    this.bodySnippet = extra.bodySnippet
    this.url = extra.url
    this.serverId = extra.serverId
    this.reason = extra.reason
  }
}

function bodySnippet(text) {
  if (typeof text !== 'string' || text === '') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

/** Basic auth for OpenCode 2: username is fixed to `opencode`. */
export function basicAuthorization(server) {
  if (server === null || typeof server !== 'object') return undefined
  if (server.password === undefined || server.password === null) return undefined
  return 'Basic ' + Buffer.from('opencode:' + String(server.password)).toString('base64')
}

function hintForProbe(server) {
  const probe = server !== null && typeof server === 'object' ? server.versionProbe : undefined
  if (probe === null || typeof probe !== 'object' || probe.version !== '1') return ''
  if (probe.reason === 'unauthorized') return ' (the v2 probe was rejected with 401 — check OPENCODE_SERVER_PASSWORD)'
  if (probe.reason === 'missing-password') return ' (no password configured — OpenCode 2 requires OPENCODE_SERVER_PASSWORD)'
  if (probe.reason === 'html-response' || probe.reason === 'non-json') return ' (the v2 probe returned non-JSON — this looks like the OpenCode 2 web SPA)'
  return ''
}

function describeTarget(server, target) {
  return String(server.id) + ' (' + String(server.url) + target + ')'
}

function transportFailure(server, target, code, detail) {
  const base = { serverId: server === null || typeof server !== 'object' ? undefined : server.id, url: target, reason: detail }
  if (code === 'opencode.timeout') {
    return new OpenCodeError(code, 'opencode: request to ' + describeTarget(server, target) + ' timed out' + hintForProbe(server), base)
  }
  if (code === 'opencode.aborted') {
    return new OpenCodeError(code, 'opencode: request to ' + describeTarget(server, target) + ' was aborted', base)
  }
  return new OpenCodeError(code, 'opencode: cannot reach ' + describeTarget(server, target) + ': ' + detail + hintForProbe(server), base)
}

/** Raw HTTP call; resolves `{status, contentType, text, url}` or rejects with OpenCodeError. */
function requestRaw(server, target, options) {
  return new Promise(function (resolve, reject) {
    let url
    try {
      url = new URL(server.url + target)
    } catch (error) {
      reject(new OpenCodeError('opencode.invalid_url', 'opencode: invalid server url for ' + describeTarget(server, target), { serverId: server.id, url: target }))
      return
    }
    const headers = { accept: 'application/json' }
    const authorization = basicAuthorization(server)
    if (authorization !== undefined) headers.authorization = authorization
    if (options !== undefined && typeof options.directory === 'string' && options.directory !== '') {
      headers['x-opencode-directory'] = options.directory
    }
    const body = options !== undefined && options.body !== undefined ? JSON.stringify(options.body) : undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    let timedOut = false
    let aborted = false
    const request = http.request({
      host: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      method: options !== undefined && options.method !== undefined ? options.method : 'GET',
      path: url.pathname + url.search,
      timeout: options !== undefined && options.timeoutMs !== undefined ? options.timeoutMs : 8000,
      headers: headers,
    }, function (response) {
      const chunks = []
      response.on('data', function (chunk) { chunks.push(chunk) })
      response.on('end', function () {
        resolve({
          status: response.statusCode,
          contentType: String(response.headers['content-type'] === undefined ? '' : response.headers['content-type']),
          text: Buffer.concat(chunks).toString('utf8'),
          path: url.pathname + url.search,
        })
      })
    })
    request.on('timeout', function () {
      timedOut = true
      request.destroy(new Error('opencode timeout'))
    })
    request.on('error', function (error) {
      if (timedOut) reject(transportFailure(server, target, 'opencode.timeout'))
      else if (aborted) reject(transportFailure(server, target, 'opencode.aborted'))
      else reject(transportFailure(server, target, 'opencode.network', String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error)))
    })
    if (options !== undefined && options.signal !== undefined && options.signal !== null) {
      const signal = options.signal
      const onAbort = function () {
        aborted = true
        request.destroy(new Error('opencode aborted'))
      }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        request.on('close', function () { signal.removeEventListener('abort', onAbort) })
      }
    }
    request.end(body)
  })
}

function responseFailure(server, response) {
  const base = {
    status: response.status,
    contentType: response.contentType,
    bodySnippet: bodySnippet(response.text),
    url: response.path,
    serverId: server.id,
  }
  if (response.status === 401) {
    return new OpenCodeError(
      'opencode.unauthorized',
      'opencode: ' + describeTarget(server, response.path) + ' answered 401 Unauthorized; OpenCode 2 requires HTTP Basic auth with user "opencode" and the password from OPENCODE_SERVER_PASSWORD',
      base,
    )
  }
  return new OpenCodeError(
    'opencode.http_error',
    'opencode: ' + describeTarget(server, response.path) + ' answered HTTP ' + response.status + hintForProbe(server),
    base,
  )
}

/** Turn a raw response into `{status, value}`, or throw a typed OpenCodeError. */
function interpretResponse(server, response) {
  if (response.status < 200 || response.status >= 300) throw responseFailure(server, response)
  if (response.text === '') return { status: response.status, value: undefined }
  try {
    return { status: response.status, value: JSON.parse(response.text) }
  } catch (error) {
    const html = /html/i.test(response.contentType)
    const code = html ? 'opencode.html_response' : 'opencode.non_json'
    const what = html ? 'HTML (OpenCode web SPA)' : 'a non-JSON body'
    throw new OpenCodeError(
      code,
      'opencode: ' + describeTarget(server, response.path) + ' returned ' + what + ' instead of JSON; this call is not available on the detected API version' + hintForProbe(server),
      {
        status: response.status,
        contentType: response.contentType,
        bodySnippet: bodySnippet(response.text),
        url: response.path,
        serverId: server.id,
      },
    )
  }
}

function recordProbe(server, version, reason, extra) {
  const details = extra === undefined || extra === null ? {} : extra
  const info = {
    version: version,
    reason: reason,
    at: Date.now(),
    status: details.status,
    detail: details.detail,
    errorCode: details.errorCode,
  }
  server.versionProbe = info
  server.detectedVersion = version
  return info
}

function probeApiInfo(server, options) {
  const timeoutMs = options !== undefined && typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  return requestRaw(server, '/api/info', { timeoutMs: timeoutMs }).then(function (response) {
    if (response.status === 401) return recordProbe(server, '1', 'unauthorized', { status: response.status })
    if (response.status !== 200) return recordProbe(server, '1', 'http-error', { status: response.status })
    let value
    try {
      value = JSON.parse(response.text)
    } catch (error) {
      const reason = /html/i.test(response.contentType) ? 'html-response' : 'non-json'
      return recordProbe(server, '1', reason, { status: response.status })
    }
    const version = value !== null && typeof value === 'object' && typeof value.version === 'string' ? value.version : undefined
    if (version === undefined) return recordProbe(server, '1', 'invalid-response', { status: response.status })
    const major = Number.parseInt(version, 10)
    if (Number.isFinite(major) && major >= 2) return recordProbe(server, '2', 'probe-ok', { status: response.status, detail: version })
    return recordProbe(server, '1', major === 1 ? 'version-1' : 'invalid-response', { status: response.status, detail: version })
  }, function (error) {
    const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'opencode.network'
    const reason = code === 'opencode.timeout' ? 'timeout' : (code === 'opencode.network' ? 'unreachable' : code)
    return recordProbe(server, '1', reason, { errorCode: code })
  })
}

/**
 * Detect and cache the API version of one server.
 *
 * `server.apiVersion` may force `'1'` or `'2'`; the default `'auto'` probes
 * `GET /api/info` (Basic auth) and falls back to v1 with one recorded reason
 * when the probe fails, the password is missing, or the server answers 401.
 * The returned info object is also stored on `server.versionProbe`.
 */
export function ensureApiVersion(server, options) {
  if (server === null || typeof server !== 'object') {
    return Promise.resolve({ version: '1', reason: 'invalid-server' })
  }
  const force = options !== undefined && options.force === true
  if (force) resetApiVersion(server)
  if (server.versionProbe !== undefined && server.versionProbe !== null) return Promise.resolve(server.versionProbe)
  if (server.versionProbePromise !== undefined) return server.versionProbePromise
  const configured = server.apiVersion === '1' || server.apiVersion === '2' ? server.apiVersion : 'auto'
  let pending
  if (configured !== 'auto') {
    pending = Promise.resolve(recordProbe(server, configured, 'configured'))
  } else if (server.password === undefined || server.password === null) {
    pending = Promise.resolve(recordProbe(server, '1', 'missing-password'))
  } else {
    pending = probeApiInfo(server, options)
  }
  server.versionProbePromise = pending.then(function (info) {
    server.versionProbePromise = undefined
    return info
  }, function (error) {
    server.versionProbePromise = undefined
    throw error
  })
  return server.versionProbePromise
}

/** Drop the cached probe (tests, config reload). */
export function resetApiVersion(server) {
  if (server === null || typeof server !== 'object') return
  delete server.versionProbe
  delete server.detectedVersion
  delete server.versionProbePromise
}

/** Prefix a request path for the detected version; already-prefixed paths stay untouched. */
export function apiPath(version, target) {
  const path = typeof target === 'string' ? target : ''
  if (version !== '2') return path
  if (path === '/api' || path.startsWith('/api/')) return path
  return path.startsWith('/') ? '/api' + path : '/api/' + path
}

/** One-line description of a probe result, used for startup logging. */
export function describeApiVersion(info) {
  if (info === null || typeof info !== 'object') return 'unknown'
  const detail = info.status === undefined || info.status === null ? '' : ', status ' + info.status
  return 'v' + String(info.version) + ' (' + String(info.reason) + detail + ')'
}

/** Request one OpenCode HTTP resource; resolves `{status, value}` or rejects with OpenCodeError. */
export function opencodeRequest(server, target, options) {
  return ensureApiVersion(server).then(function (info) {
    return requestRaw(server, apiPath(info.version, target), options)
  }).then(function (response) {
    return interpretResponse(server, response)
  })
}

export function serverHeaders(server, accept) {
  const headers = { accept: accept === undefined ? 'application/json' : accept }
  const authorization = basicAuthorization(server)
  if (authorization !== undefined) headers.authorization = authorization
  return headers
}

export function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status === undefined ? 200 : status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export function readJsonBody(request) {
  return request.json().then(function (value) {
    return value === null || typeof value !== 'object' ? {} : value
  }).catch(function () { return {} })
}