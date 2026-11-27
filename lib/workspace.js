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
import { unwrapList } from './http.js'
import { ocCall } from './oc-client.js'
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
    return ocCall(server, function (client, requestOptions) {
      return client.shell.get({ id: shellId, location: directory === undefined ? undefined : { directory: directory } }, requestOptions)
    }, 15000).then(function (response) {
      const shell = response !== null && typeof response === 'object' && response.data !== undefined ? response.data : response
      const status = shell !== null && typeof shell === 'object' && typeof shell.status === 'string' ? shell.status : 'running'
      if (status !== 'running' || Date.now() > deadline) return shell
      return sleep(300).then(once)
    })
  }
  return once()
}

export function runShell(server, sessionId, command, directory) {
    // OpenCode 2: POST a shell in the requested (or session) workspace, then read its output.
    const requested = typeof directory === 'string' && directory !== '' ? directory : undefined
    return (requested === undefined ? sessionDirectory(server, sessionId, server.directory) : Promise.resolve(requested)).then(function (resolved) {
      return runShellCommand(server, resolved, command).then(function (result) {
        const body = result.text.replace(/\s+$/, '')
        const lines = [body === '' ? '(shell returned no output)' : body]
        if (result.truncated === true) {
          // The server caps one output page; say so instead of silently dropping the tail.
          lines.push('[output truncated at ' + (typeof result.size === 'number' ? String(result.size) : '?') + ' bytes' + (typeof result.cursor === 'number' ? '; cursor=' + String(result.cursor) : '') + ']')
        }
        // Report a non-zero exit even when the shell exited normally: a failed
        // build must not look like success just because stderr was empty.
        const detail = []
        if (result.exit !== undefined && result.exit !== 0) detail.push('exit ' + String(result.exit))
        if (typeof result.signal === 'string' && result.signal !== '') detail.push('signal ' + result.signal)
        if (result.status !== 'exited' || detail.length > 0) {
          lines.push('(shell ' + result.status + (detail.length === 0 ? '' : ', ' + detail.join(', ')) + ')')
        }
        return { sessionId: sessionId, text: lines.join('\n') }
      })
    })
}

/**
 * Run one workspace-scoped shell command without a session. OpenCode 2 shells
 * are workspace-scoped (`POST /api/shell` with a cwd), so this is how v1's
 * removed `/find` content search is emulated. v1 shells are session-scoped and
 * are not supported here.
 */
export function runShellCommand(server, directory, command) {
    const resolved = typeof directory === 'string' && directory !== '' ? directory : server.directory
    return ocCall(server, function (client, requestOptions) {
      const input = { command: command }
      if (resolved !== undefined) input.cwd = resolved
      if (resolved !== undefined) input.location = { directory: resolved }
      return client.shell.create(input, requestOptions)
    }, 20000).then(function (response) {
      const created = response !== null && typeof response === 'object' && response.data !== undefined ? response.data : response
      if (created === null || typeof created !== 'object' || typeof created.id !== 'string') {
        throw new Error('opencode: shell failed on ' + server.id + ' (no shell id)')
      }
      return pollShell(server, resolved, created.id).then(function (shell) {
        // Output pages at 64 KiB by default; follow `cursor` until the reported
        // `size` is reached (capped, so a runaway command cannot flood a caller).
        const MAX_OUTPUT_BYTES = 1024 * 1024
        const chunks = []
        let bytes = 0
        let total
        let nextCursor
        let serverTruncated = false
        function readPage(cursor) {
          return ocCall(server, function (client, requestOptions) {
            const input = { id: created.id, limit: 262144 }
            if (typeof cursor === 'number') input.cursor = cursor
            if (resolved !== undefined) input.location = { directory: resolved }
            return client.shell.output(input, requestOptions)
          }, 15000).then(function (payload) {
            const data = payload !== null && typeof payload === 'object' && payload.data !== undefined ? payload.data : (payload !== null && typeof payload === 'object' ? payload : {})
            const chunk = typeof data.output === 'string' ? data.output : ''
            chunks.push(chunk)
            bytes += Buffer.byteLength(chunk, 'utf8')
            if (data.truncated === true) serverTruncated = true
            if (typeof data.size === 'number') total = data.size
            if (typeof data.cursor === 'number') nextCursor = data.cursor
            const more = typeof total === 'number' && typeof nextCursor === 'number' && nextCursor < total && bytes < MAX_OUTPUT_BYTES && serverTruncated !== true
            if (more) return readPage(nextCursor)
            const incomplete = serverTruncated === true || (typeof total === 'number' && bytes < total)
            return {
              text: chunks.join(''),
              exit: shell !== null && typeof shell === 'object' && shell.exit !== undefined ? shell.exit : undefined,
              status: shell !== null && typeof shell === 'object' && typeof shell.status === 'string' ? shell.status : 'exited',
              signal: shell !== null && typeof shell === 'object' && typeof shell.signal === 'string' ? shell.signal : undefined,
              truncated: incomplete,
              size: total,
              cursor: incomplete && typeof nextCursor === 'number' ? nextCursor : undefined,
            }
          })
        }
        return readPage(undefined)
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
  return ocCall(server, function (client, requestOptions) {
    return client.vcs.status({ location: directory === undefined ? undefined : { directory: directory } }, requestOptions)
  }, 60000).then(function (response) {
    const list = unwrapList(response)
    const lines = diffRows(list).slice(0, 50)
    if (list.length > 50) lines.push('… (' + String(list.length - 50) + ' more)')
    return { files: list, text: lines.length === 0 ? 'working tree clean' : lines.join('\n') }
  })
}

/** Summary diff by default; patch=true adds per-file patches (truncated). */
export function gitDiff(server, directory, mode, patch) {
  const requested = mode === undefined ? 'git' : mode
  const v2Mode = requested === 'branch' ? 'branch' : (requested === 'committed' ? 'committed' : 'working')
  return ocCall(server, function (client, requestOptions) {
    const input = { mode: v2Mode }
    if (directory !== undefined) input.location = { directory: directory }
    return client.vcs.diff(input, requestOptions)
  }, 60000).then(function (response) {
    const files = unwrapList(response)
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
  return ocCall(server, function (client, requestOptions) {
    const input = { path: path }
    if (directory !== undefined) input.location = { directory: directory }
    return client.file.read(input, requestOptions)
  }, 30000).then(function (bytes) {
    const buffer = Buffer.from(bytes)
    const binary = buffer.indexOf(0) >= 0 || /^application\/(octet-stream|pdf|zip|gzip)/.test('')
    if (binary) return { text: '(binary file: ' + path + ')', binary: true }
    const content = buffer.toString('utf8')
    return { text: content.length > 40000 ? content.slice(0, 40000) + '\n… (truncated)' : content, binary: false }
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
  const variants = findQueryVariants(query)
  function run(index) {
    return ocCall(server, function (client, requestOptions) {
      const input = { query: variants[index], type: 'file' }
      if (limit !== undefined) input.limit = limit
      if (directory !== undefined) input.location = { directory: directory }
      return client.file.find(input, requestOptions)
    }, 20000).then(function (response) {
      const paths = unwrapList(response).map(function (entry) {
        return entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : undefined
      }).filter(function (path) { return path !== undefined })
      if (paths.length === 0 && index + 1 < variants.length) return run(index + 1)
      return paths
    })
  }
  return run(0).then(function (paths) {
    return { count: paths.length, text: paths.length === 0 ? 'no matching files' : paths.map(function (path) { return '- ' + path }).join('\n') }
  })
}

/**
 * Content search. v1 serves `/find?pattern=`; OpenCode 2 removed content search
 * entirely, so v2 emulates it with a workspace `grep` through the (already
 * supported) async shell and returns the same `path:line: text` shape.
 */
export function findText(server, directory, pattern) {
  // -F keeps the pattern literal and -e removes option injection; single-quote
  // escaping keeps shell metacharacters inert.
  const literal = String(pattern).replace(/'/g, "'\\''")
  const command = "grep -rIn --binary-files=without-match --exclude-dir=.git -F -e '" + literal + "' . 2>/dev/null | head -100"
  return runShellCommand(server, directory, command).then(function (result) {
    const body = String(result.text).replace(/\s+$/, '')
    if (body === '') return { count: 0, text: 'no matches', mode: 'shell-grep' }
    const lines = body.split('\n').filter(function (line) { return line !== '' }).map(function (line) {
      return line.length > 300 ? line.slice(0, 300) + '…' : line
    })
    return { count: lines.length, text: lines.join('\n'), mode: 'shell-grep' }
  })
}
