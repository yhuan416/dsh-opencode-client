/** Minimal HTTP client for the OpenCode OpenAPI surface. */
import http from 'node:http'

export function opencodeRequest(server, target, options) {
  return new Promise(function (resolve) {
    let url
    try { url = new URL(server.url + target) } catch { resolve(undefined); return }
    const headers = { accept: 'application/json' }
    if (server.password !== undefined) {
      headers.authorization = 'Basic ' + Buffer.from('opencode:' + server.password).toString('base64')
    }
    if (options !== undefined && typeof options.directory === 'string' && options.directory !== '') {
      headers['x-opencode-directory'] = options.directory
    }
    const body = options !== undefined && options.body !== undefined ? JSON.stringify(options.body) : undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const request = http.request({
      host: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      method: options !== undefined && options.method !== undefined ? options.method : 'GET',
      path: url.pathname + url.search,
      timeout: 8000,
      headers: headers,
      ...options !== undefined && options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
    }, function (response) {
      const chunks = []
      response.on('data', function (chunk) { chunks.push(chunk) })
      response.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8')
        let value
        try { value = text === '' ? undefined : JSON.parse(text) } catch { value = undefined }
        resolve({ status: response.statusCode, value: value })
      })
    })
    request.on('timeout', function () { request.destroy(new Error('opencode timeout')) })
    request.on('error', function () { resolve(undefined) })
    if (options !== undefined && options.signal !== undefined && options.signal !== null) {
      const signal = options.signal
      const onAbort = function () { request.destroy(new Error('opencode aborted')) }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        request.on('close', function () { signal.removeEventListener('abort', onAbort) })
      }
    }
    request.end(body)
  })
}

export function serverHeaders(server, accept) {
  const headers = { accept: accept === undefined ? 'application/json' : accept }
  if (server.password !== undefined) {
    headers.authorization = 'Basic ' + Buffer.from('opencode:' + server.password).toString('base64')
  }
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
