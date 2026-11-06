/** Remote workspace operations: shell, git status/diff, file read, search. */
import { opencodeRequest } from './http.js'
import { extractAssistant } from './delegate.js'

/** Shell replies put the command output in a tool part, not in text parts. */
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

export function runShell(server, sessionId, command, directory) {
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

export function gitStatus(server, directory) {
  const query = directory === undefined ? '' : '?directory=' + encodeURIComponent(directory)
  return opencodeRequest(server, '/vcs/status' + query, { timeoutMs: 60000 }).then(function (result) {
    if (result === undefined || result.status !== 200 || !Array.isArray(result.value)) {
      throw new Error('opencode: git status failed on ' + server.id + (result === undefined ? ' (timeout or transport error; large repos can take longer)' : ' (status ' + String(result.status) + ')'))
    }
    const files = result.value
    const lines = files.slice(0, 50).map(function (entry) {
      return '- [' + entry.status + '] ' + entry.file + ' (+' + String(entry.additions) + ' -' + String(entry.deletions) + ')'
    })
    if (files.length > 50) lines.push('… (' + String(files.length - 50) + ' more)')
    return { files: files, text: lines.length === 0 ? 'working tree clean' : lines.join('\n') }
  })
}

/** Summary diff by default; patch=true adds per-file patches (truncated). */
export function gitDiff(server, directory, mode, patch) {
  const params = ['mode=' + encodeURIComponent(mode === undefined ? 'git' : mode)]
  if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
  return opencodeRequest(server, '/vcs/diff?' + params.join('&'), { timeoutMs: 60000 }).then(function (result) {
    if (result === undefined || result.status !== 200 || !Array.isArray(result.value)) {
      throw new Error('opencode: diff failed on ' + server.id + (result === undefined ? ' (timeout or transport error)' : ' (status ' + String(result.status) + ')'))
    }
    const files = result.value
    const lines = files.slice(0, 100).map(function (entry) {
      return '- [' + (entry.status === undefined ? '?' : entry.status) + '] ' + entry.file + ' (+' + String(entry.additions) + ' -' + String(entry.deletions) + ')'
    })
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

export function readRemoteFile(server, directory, path) {
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

export function findFiles(server, directory, query, limit) {
  const params = ['query=' + encodeURIComponent(query)]
  if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
  if (limit !== undefined) params.push('limit=' + String(limit))
  return opencodeRequest(server, '/find/file?' + params.join('&'), { timeoutMs: 15000 }).then(function (result) {
    const list = result !== undefined && Array.isArray(result.value) ? result.value : []
    return { count: list.length, text: list.length === 0 ? 'no matching files' : list.map(function (path) { return '- ' + path }).join('\n') }
  })
}

export function findText(server, directory, pattern) {
  const params = ['pattern=' + encodeURIComponent(pattern)]
  if (directory !== undefined) params.push('directory=' + encodeURIComponent(directory))
  return opencodeRequest(server, '/find?' + params.join('&'), { timeoutMs: 15000 }).then(function (result) {
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
