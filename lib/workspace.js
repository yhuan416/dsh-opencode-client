/**
 * Remote workspace operations: shell, git status/diff, file read, search.
 *
 * v1: synchronous `/session/{id}/shell` reply, `/vcs/*`, `/file/content`,
 * `/find/file`, `/find`.
 * v2: shell is asynchronous (`POST /api/shell` returns an id and output is read
 * from `/api/shell/{id}/output`), VCS answers `{location,data}` with
 * `mode=working|branch|committed`, file reads are raw `/api/fs/read/*` bytes and
 * `find` only covers file paths (no text search endpoint).
 */
import { opencodeRequest, opencodeValue, opencodeRaw, ensureApiVersion, unwrapList, withLocation, apiVersionOf } from './http.js'
import { sessionDirectory } from './sessions.js'

/** v1 shell replies put the command output in a tool part, not in text parts. */
function extractShellOutput(value) {
  const texts = []
  const parts = value !== null && typeof value === 'object' && Array.isArray(value.parts) ? value.parts : []
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') texts.push(part.text)
    if (part.type === 'tool' && part.state !== null && typeof part.state === 'object') {
      const output = typeof part.state.output === 'string' ? part.state.output : (part.state.metadata !== null && typeof part.state.metadata === 'object' && typeof part.state.metadata.output === 'string' ? part.state.metadata.output : '')
      if (output !== '') texts.push(output)
    }
  }
  return texts.join('\n').trim()
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

/** Poll one v2 shell run until it leaves `running` (bounded by timeoutMs). */
function pollShell(server, directory, shellId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs === undefined ? 900000 : timeoutMs)
  function once() {
    return opencodeValue(server, withLocation('/shell/' + encodeURIComponent(shellId), directory), { timeoutMs: 15000 }).then(function (shell) {
      const status = shell !== null && typeof shell === 'object' && typeof shell.status === 'string' ? shell.status : 'running'
      if (status !== 'running' || Date.now() > deadline) return shell
      return sleep(300).then(once)
    })
  }
  return once()
}

export function runShell(server, sessionId, command, directory) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      return opencodeRequest(server, '/session/' + encodeURIComponent(sessionId) + '/shell', {
        method: 'POST',
        body: { agent: server.agent === undefined ? 'build' : server.agent, command: command },
        directory: directory,
        timeoutMs: 900000,
      }).then(function (reply) {
        if (reply === undefined || reply.status !== 200 || reply.value === undefined) {
          throw new Error('opencode: shell failed on ' + server.id + ' session ' + sessionId + (reply === undefined ? '' : ' (status ' + String(reply.status) + ')'))
        }
        const text = extractShellOutput(reply.value)
        return { sessionId: sessionId, text: text === '' ? '(shell returned no output)' : text }
      })
    }
    // OpenCode 2: POST a shell in the requested (or session) workspace, then read its output.
    const requested = typeof directory === 'string' && directory !== '' ? directory : undefined
    return (requested === undefined ? sessionDirectory(server, sessionId, server.directory) : Promise.resolve(requested)).then(function (resolved) {
      return opencodeValue(server, withLocation('/shell', resolved), {
        method: 'POST',
        body: resolved === undefined ? { command: command } : { command: command, cwd: resolved },
        timeoutMs: 20000,
      }).then(function (created) {
        if (created === null || typeof created !== 'object' || typeof created.id !== 'string') {
          throw new Error('opencode: shell failed on ' + server.id + ' session ' + sessionId + ' (no shell id)')
        }
        return pollShell(server, resolved, created.id).then(function (shell) {
          return opencodeValue(server, withLocation('/shell/' + encodeURIComponent(created.id) + '/output', resolved), { timeoutMs: 15000 }).then(function (payload) {
            const output = payload !== null && typeof payload === 'object' && typeof payload.output === 'string' ? payload.output : ''
            const exit = shell !== null && typeof shell === 'object' && shell.exit !== undefined ? String(shell.exit) : '?'
            const status = shell !== null && typeof shell === 'object' && typeof shell.status === 'string' ? shell.status : 'exited'
            const suffix = status === 'exited' ? '' : ' (shell ' + status + ', exit ' + exit + ')'
            const body = output.trim()
            return { sessionId: sessionId, text: body === '' ? '(shell returned no output)' + suffix : body + suffix }
          })
        })
      })
    })
  })
}

function diffRows(files) {
  return files.map(function (entry) {
    const status = typeof entry.status === 'string' ? entry.status : '?'
    return '- [' + status + '] ' + entry.file + ' (+' + String(entry.additions) + ' -' + String(entry.deletions) + ')'
  })
}

export function gitStatus(server, directory) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      const query = directory === undefined ? '' : '?directory=' + encodeURIComponent(directory)
      return opencodeRequest(server, '/vcs/status' + query, { timeoutMs: 60000 }).then(function (result) {
        if (result === undefined || result.status !== 200 || !Array.isArray(result.value)) {
          throw new Error('opencode: git status failed on ' + server.id + (result === undefined ? ' (timeout or transport error; large repos can take longer)' : ' (status ' + String(result.status) + ')'))
        }
        return result.value
      })
    }
    return opencodeValue(server, withLocation('/vcs/status', directory), { timeoutMs: 60000 })
  }).then(function (files) {
    const list = Array.isArray(files) ? files : unwrapList(files)
    const lines = diffRows(list).slice(0, 50)
    if (list.length > 50) lines.push('… (' + String(list.length - 50) + ' more)')
    return { files: list, text: lines.length === 0 ? 'working tree clean' : lines.join('\n') }
  })
}

/** Summary diff by default; patch=true adds per-file patches (truncated). */
export function gitDiff(server, directory, mode, patch) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      const params = ['mode=' + encodeURIComponent(mode === undefined ? 'git' : mode)]
      if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
      return opencodeRequest(server, '/vcs/diff?' + params.join('&'), { timeoutMs: 60000 }).then(function (result) {
        if (result === undefined || result.status !== 200 || !Array.isArray(result.value)) {
          throw new Error('opencode: diff failed on ' + server.id + (result === undefined ? ' (timeout or transport error)' : ' (status ' + String(result.status) + ')'))
        }
        return result.value
      })
    }
    // v2 renamed the modes: git -> working (v1 `git` answers 400 on v2).
    const requested = mode === undefined ? 'git' : mode
    const v2Mode = requested === 'branch' ? 'branch' : (requested === 'committed' ? 'committed' : 'working')
    return opencodeValue(server, withLocation('/vcs/diff?mode=' + encodeURIComponent(v2Mode), directory), { timeoutMs: 60000 })
  }).then(function (value) {
    const files = Array.isArray(value) ? value : unwrapList(value)
    const lines = diffRows(files).slice(0, 100)
    if (files.length > 100) lines.push('… (' + String(files.length - 100) + ' more)')
    let text = lines.length === 0 ? '(empty diff)' : lines.join('\n')
    if (patch === true) {
      const blocks = []
      let budget = 20000
      for (const entry of files) {
        const change = typeof entry.patch === 'string' ? entry.patch : ''
        if (change === '') continue
        if (change.length > budget) { blocks.push(change.slice(0, budget) + '\n… (truncated)'); break }
        blocks.push(change)
        budget -= change.length
      }
      if (blocks.length > 0) text = text + '\n\n' + blocks.join('\n\n')
    }
    return { files: files, text: text }
  })
}

function encodePath(path) {
  return String(path).split('/').map(function (segment) { return encodeURIComponent(segment) }).join('/')
}

export function readRemoteFile(server, directory, path) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      const params = ['path=' + encodeURIComponent(path)]
      if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
      return opencodeRequest(server, '/file/content?' + params.join('&'), { timeoutMs: 15000 }).then(function (result) {
        if (result === undefined || result.status !== 200 || result.value === undefined) {
          throw new Error('opencode: cannot read ' + path + ' on ' + server.id + (result === undefined ? '' : ' (status ' + String(result.status) + ')'))
        }
        const value = result.value
        if (value.type === 'binary') return { text: '(binary file: ' + path + ')', binary: true }
        const content = typeof value.content === 'string' ? value.content : ''
        return { text: content.length > 40000 ? content.slice(0, 40000) + '\n… (truncated)' : content, binary: false }
      })
    }
    // v2 answers the raw file body with its own content type.
    return opencodeRaw(server, withLocation('/fs/read/' + encodePath(path), directory), { timeoutMs: 30000 }).then(function (response) {
      const binary = /^application\/(octet-stream|pdf|zip|gzip)/.test(response.contentType) || response.text.indexOf('\u0000') >= 0
      if (binary) return { text: '(binary file: ' + path + ')', binary: true }
      const content = response.text
      return { text: content.length > 40000 ? content.slice(0, 40000) + '\n… (truncated)' : content, binary: false }
    })
  })
}

/**
 * v2 `/api/fs/find` matches a plain substring, not a glob (v1's `/find/file`
 * accepts both). Retry with the wildcard characters stripped so `*.md` still
 * behaves like the expected path filter.
 */
function findQueryVariants(query) {
  const variants = [query]
  if (/[*?]/.test(query)) {
    const stripped = String(query).replace(/[*?]/g, '').trim()
    if (stripped !== '' && stripped !== query) variants.push(stripped)
  }
  return variants
}

export function findFiles(server, directory, query, limit) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) !== '2') {
      const params = ['query=' + encodeURIComponent(query)]
      if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
      if (limit !== undefined) params.push('limit=' + String(limit))
      return opencodeRequest(server, '/find/file?' + params.join('&'), { timeoutMs: 15000 }).then(function (result) {
        return result !== undefined && Array.isArray(result.value) ? result.value : []
      })
    }
    const variants = findQueryVariants(query)
    function runVariant(index) {
      const params = ['query=' + encodeURIComponent(variants[index]), 'type=file']
      if (limit !== undefined) params.push('limit=' + String(limit))
      return opencodeValue(server, withLocation('/fs/find?' + params.join('&'), directory), { timeoutMs: 20000 }).then(function (value) {
        const paths = unwrapList(value).map(function (entry) {
          return entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : undefined
        }).filter(function (path) { return path !== undefined })
        if (paths.length === 0 && index + 1 < variants.length) return runVariant(index + 1)
        return paths
      })
    }
    return runVariant(0)
  }).then(function (paths) {
    return { count: paths.length, text: paths.length === 0 ? 'no matching files' : paths.map(function (path) { return '- ' + path }).join('\n') }
  })
}

export function findText(server, directory, pattern) {
  return ensureApiVersion(server).then(function () {
    if (apiVersionOf(server) === '2') {
      throw new Error('OpenCode 2 has no content-search endpoint (v1 /find?pattern= was removed); use opencode_shell with rg/grep instead, or opencode_find kind=file for paths')
    }
    const params = ['pattern=' + encodeURIComponent(pattern)]
    if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
    return opencodeRequest(server, '/find?' + params.join('&'), { timeoutMs: 15000 })
  }).then(function (result) {
    const list = result !== undefined && Array.isArray(result.value) ? result.value : []
    const lines = list.slice(0, 100).map(function (match) {
      const path = match !== null && typeof match === 'object' && match.path !== null && typeof match.path === 'object' && typeof match.path.text === 'string' ? match.path.text : '?'
      const line = match !== null && typeof match === 'object' && match.lines !== null && typeof match.lines === 'object' && typeof match.lines.text === 'string' ? match.lines.text.trim() : ''
      const number = match !== null && typeof match === 'object' && typeof match.line_number === 'number' ? match.line_number : '?'
      return path + ':' + String(number) + ': ' + line
    })
    return { count: list.length, text: lines.length === 0 ? 'no matches' : lines.join('\n') }
  })
}