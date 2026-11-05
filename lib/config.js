/** Server list and option normalization for the OpenCode client. */

export function normalizeServers(raw) {
  if (!Array.isArray(raw)) return []
  const servers = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const base = typeof item.url === 'string' ? item.url.trim().replace(/\/+$/, '') : ''
    if (id === '' || base === '') continue
    servers.push({
      id: id,
      label: typeof item.label === 'string' && item.label !== '' ? item.label : id,
      url: base,
      password: typeof item.password === 'string' && item.password !== '' ? item.password : undefined,
      directory: typeof item.directory === 'string' && item.directory !== '' ? item.directory : undefined,
      agent: typeof item.agent === 'string' && item.agent !== '' ? item.agent : undefined,
      model: parseModel(item.model),
      snapshot: undefined,
    })
  }
  return servers
}

/** Accept "provider/model" or {providerID, modelID}. */
export function parseModel(raw) {
  if (typeof raw === 'string' && raw.indexOf('/') > 0) {
    const at = raw.indexOf('/')
    return { providerID: raw.slice(0, at), modelID: raw.slice(at + 1) }
  }
  if (raw !== null && typeof raw === 'object' && typeof raw.providerID === 'string' && typeof raw.modelID === 'string') {
    return { providerID: raw.providerID, modelID: raw.modelID }
  }
  return undefined
}

/** Prefix mapping used when the host and remote filesystem layouts differ. */
export function parsePathMap(raw) {
  if (!Array.isArray(raw)) return []
  const rules = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.from !== 'string' || item.from === '' || typeof item.to !== 'string') continue
    rules.push({ from: item.from.replace(/\/+$/, ''), to: item.to.replace(/\/+$/, '') })
  }
  return rules
}
