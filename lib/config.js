/** Server list and option normalization for the OpenCode client. */

/** Accept "auto" (probe), 1/2 as string or number; anything else means auto. */
export function normalizeApiVersion(raw) {
  if (raw === 1 || raw === '1') return '1'
  if (raw === 2 || raw === '2') return '2'
  return 'auto'
}

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
      apiVersion: normalizeApiVersion(item.apiVersion),
      snapshot: undefined,
    })
  }
  return servers
}

/** Accept "provider/model" or {providerID, modelID}. */
/**
 * Parse a model reference. `"provider/model"` is the v1/v2 baseline; OpenCode 2
 * additionally accepts a reasoning variant, written `"provider/model#variant"`
 * (variant ids are listed by `opencode_models`, e.g. `none|low|high`).
 */
export function parseModel(raw) {
  if (typeof raw === 'string' && raw.indexOf('/') > 0) {
    const at = raw.indexOf('/')
    const providerID = raw.slice(0, at)
    let rest = raw.slice(at + 1)
    let variant
    const hash = rest.lastIndexOf('#')
    if (hash > 0) {
      variant = rest.slice(hash + 1)
      rest = rest.slice(0, hash)
    }
    if (rest === '') return undefined
    const model = { providerID: providerID, modelID: rest }
    if (variant !== undefined && variant !== '') model.variant = variant
    return model
  }
  if (raw !== null && typeof raw === 'object' && typeof raw.providerID === 'string' && typeof raw.modelID === 'string') {
    const model = { providerID: raw.providerID, modelID: raw.modelID }
    if (typeof raw.variant === 'string' && raw.variant !== '') model.variant = raw.variant
    return model
  }
  return undefined
}

/**
 * Display form of a model reference: `providerID/modelID` plus `#variant`
 * when OpenCode 2 reports a non-default reasoning variant.
 */
export function modelLabel(model) {
  if (model === null || typeof model !== 'object') return undefined
  const id = typeof model.id === 'string' ? model.id : (typeof model.modelID === 'string' ? model.modelID : undefined)
  if (typeof model.providerID !== 'string' || id === undefined) return undefined
  const variant = typeof model.variant === 'string' && model.variant !== '' && model.variant !== 'default' ? '#' + model.variant : ''
  return model.providerID + '/' + id + variant
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
