/** Resolve dsh-tools (ESM) from the running dsh installation for tool registration. */
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const dshToolsAttempts = []

export async function loadDshTools() {
  const globalPrefix = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai')
  const anchors = [
    path.join(globalPrefix, 'dsh', 'package.json'),
    path.join(globalPrefix, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
  ]
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '') anchors.push(path.join(process.env.DSH_HOME, 'profiles', 'web', 'package.json'))
  if (process.argv[1] !== undefined) anchors.push(process.argv[1])
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-tools')
      const loaded = await import(pathToFileURL(resolved).href)
      const mod = loaded !== null && typeof loaded === 'object' && loaded.default !== undefined && typeof loaded.default.defineTool === 'function' ? loaded.default : loaded
      if (mod !== null && typeof mod === 'object' && typeof mod.defineTool === 'function') {
        dshToolsAttempts.push({ anchor: anchor, resolved: resolved, ok: true })
        return mod
      }
      dshToolsAttempts.push({ anchor: anchor, resolved: resolved, ok: false, error: 'no defineTool export' })
    } catch (error) {
      dshToolsAttempts.push({ anchor: anchor, ok: false, error: String(error !== null && typeof error === 'object' && error.message !== undefined ? error.message : error).slice(0, 160) })
    }
  }
  return undefined
}
