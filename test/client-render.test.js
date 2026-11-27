import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// The client bundle is a browser module (`window.__ModuleLoader__.load`), so a
// full DOM is out of scope here. What this test does is render every surface the
// plugin registers into the host, with data stores still loading, and fail on any
// exception: that is exactly how the settings section once went blank — an
// asyncSlot body built eagerly dereferenced a still-null `/usage` payload.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function makeReact() {
  const hooks = []
  return {
    __hooks: hooks,
    reset() { hooks.length = 0 },
    useState(init) { const i = hooks.length; hooks.push(typeof init === 'function' ? init() : init); return [hooks[i], () => {}] },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(init) { return { current: init === undefined ? null : init } },
    useReducer(reducer, init) { return [init, () => {}] },
    useSyncExternalStore(subscribe, snapshot) {
      try {
        const unsubscribe = subscribe(() => {})
        if (typeof unsubscribe === 'function') unsubscribe()
      } catch {
        // store may be in its pre-start state; then the snapshot is just stale
      }
      return snapshot()
    },
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } }
    },
  }
}

function loadClient() {
  const head = { appendChild() {} }
  const document = { head, getElementById: () => null, createElement: () => ({ id: '', set textContent(value) {} }) }
  const window = {
    localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    removeEventListener() {},
    performance: { now: () => 0, mark() {} },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  }
  window.document = document
  const React = makeReact()
  const sandbox = {
    window,
    document,
    React,
    console,
    navigator: { userAgent: 'node' },
    performance: window.performance,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
  }
  sandbox.globalThis = sandbox
  let loaded = null
  window.__ModuleLoader__ = { load: (mod) => { loaded = mod } }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const registered = {}
  const exports = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  exports.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        registered[options.name + (options.id ? '#' + options.id : '')] = component
        return () => {}
      },
    },
    effect: (fn) => { fn() },
    get: () => undefined,
  })
  return { registered, React }
}

function renderTree(React, node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => renderTree(React, child, depth + 1))
  if (typeof node.type === 'function') {
    React.reset()
    return renderTree(React, node.type(node.props || {}), depth + 1)
  }
  const children = node.props === undefined ? undefined : node.props.children
  if (children === undefined || depth > 80) return node
  return { type: node.type, props: { ...node.props, children: renderTree(React, children, depth + 1) } }
}

const SUBJECT = { kind: 'bundle', pkg: { name: 'dsh-opencode-client' } }

test('every registered surface renders while its data is still loading', () => {
  const { registered, React } = loadClient()
  const names = Object.keys(registered).sort()
  assert.deepEqual(names, [
    'main',
    'plugins.detail.badge#opencode-client-about',
    'plugins.detail.section#opencode-client',
    'shell.overlay#opencode-attention',
    'sidebar.panellist#opencode-client',
  ])
  for (const name of names) {
    React.reset()
    const tree = renderTree(React, registered[name]({ subject: SUBJECT, id: 'opencode-client' }))
    assert.doesNotThrow(() => JSON.stringify(tree), name + ' must be renderable')
  }
})

test('the settings section keeps the remote form when /board and /usage are still loading', () => {
  const { registered, React } = loadClient()
  React.reset()
  const tree = renderTree(React, registered['plugins.detail.section#opencode-client']({ subject: SUBJECT }))
  const flat = JSON.stringify(tree)
  // The manager-side form is the only way to add/remove remotes: if an async
  // block throws before it, the whole section disappears.
  assert.match(flat, /添加远端/)
  assert.match(flat, /测试连接/)
  assert.match(flat, /保存/)
})

test('the board page renders its first-frame skeleton before /board lands', () => {
  const { registered, React } = loadClient()
  React.reset()
  const flat = JSON.stringify(renderTree(React, registered['main']({})))
  assert.match(flat, /OpenCode 会话/)
  assert.match(flat, /洞察/)
  assert.doesNotMatch(flat, /正在采集会话状态/)
})
