#!/usr/bin/env node
/**
 * Manifest gate: the checks a plugin must pass before it can look right in
 * Plugin Manager and before a release can claim a version.
 *
 * These are the failures that a unit-test-only gate cannot see — a missing
 * `exports` subpath (the locale silently stops resolving, measured with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`), a version that disagrees between
 * package.json / CHANGELOG / the git tag, an icon over the size limit, or a
 * `files` entry that no longer exists. Rules come from
 * `@deepseek-ai/dsh-package-manifest` and the `dsh-doc` host-plugin references.
 *
 * Offline: no network, no package installation, no writes.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))

// ---------------------------------------------------------------- identity
assert.match(manifest.name, /^[a-z0-9][a-z0-9._-]*$/, 'package name must be a valid npm name')
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'version must be semver')

// ---------------------------------------------------------------- publishing
// npm is the primary install channel: the market's card command prefers a
// verified npm name over a git spec, and DSH only offers its own update flow
// for registry installs. The manifest must therefore be publishable, and a
// publish must never be the first place the gates run — `prepublishOnly` is
// the hook `npm publish` calls right before packing.
assert.notEqual(manifest.private, true, 'a publishable plugin must not set private: true')
assert.equal(
  manifest.publishConfig?.access,
  'public',
  'publishConfig.access must be public: an unscoped package is published public',
)
assert.match(
  String(manifest.scripts?.prepublishOnly ?? ''),
  /\bcheck\b/,
  'prepublishOnly must run the check gate before npm publish',
)

assert.ok(manifest.engines !== undefined, 'engines is required (node and dsh)')
assert.equal(typeof manifest.engines.node, 'string', 'engines.node must declare the Node range')
assert.equal(
  typeof manifest.engines.dsh,
  'string',
  'engines.dsh declares the compatible dsh range; plugin_manager refuses packages without it',
)

// ------------------------------------------------------- pinned upstream client
// The generated client follows OpenCode core releases; a range would silently
// pull a different API surface into a running installation. Upgrades are a
// deliberate PR (see COMPATIBILITY.md), so the gate refuses `^`/`~`/`*`.
const OPENCODE_CLIENT = '@opencode/client'
const pinnedClient = manifest.dependencies?.[OPENCODE_CLIENT]
assert.equal(typeof pinnedClient, 'string', OPENCODE_CLIENT + ' must be a pinned dependency')
assert.match(pinnedClient, /^\d+\.\d+\.\d+$/, OPENCODE_CLIENT + ' must be an exact version (no ^/~/*)')
const lockfile = JSON.parse(read('package-lock.json'))
assert.equal(
  lockfile.packages?.['node_modules/' + OPENCODE_CLIENT]?.version,
  pinnedClient,
  'package-lock.json must resolve ' + OPENCODE_CLIENT + ' to the pinned version',
)

// ------------------------------------------------------- bundle declarations
assert.equal(manifest.dsh?.manifestVersion, 1, 'dsh.manifestVersion must be the declared format 1')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must point at the patch file')
assert.equal(manifest.dsh?.client?.platform, 'web', 'dsh.client.platform must be web for a Web-UI plugin')
assert.ok(
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0,
  'dsh.client.inject must list the client packages whose slots/services this plugin registers into',
)

const patch = read('cordis.patch.yml')
assert.match(patch, /^- insert:/m, 'patch must insert its row')
assert.match(patch, new RegExp(`name: ['"]?${manifest.name}['"]?`), 'patch row name must be the package name')
assert.match(patch, /id: [a-z0-9-]+/, 'patch row needs an id')

// ----------------------------------------------------------------- exports
// A subpath that is not exported resolves nowhere: the host reads locale meta
// (`meta.title`/`meta.description`) and the icon through the export map.
for (const subpath of ['.', './client', './cordis.patch.yml', './package.json', './locale/*.json', './icon']) {
  assert.ok(Object.hasOwn(manifest.exports ?? {}, subpath), 'exports is missing ' + subpath)
}
for (const [subpath, target] of Object.entries(manifest.exports)) {
  if (subpath.includes('*')) continue
  assert.ok(existsSync(resolve(ROOT, target)), 'export ' + subpath + ' points at a missing file: ' + target)
}

// Self-reference resolution is what the host does; a missing export stays broken
// even though the file exists on disk.
for (const specifier of [manifest.name + '/locale/en.json', manifest.name + '/icon', manifest.name + '/client']) {
  let url
  try {
    url = import.meta.resolve(specifier)
  } catch (error) {
    assert.fail('cannot resolve ' + specifier + ' through package exports (' + (error.code ?? error.message) + ')')
  }
  assert.ok(existsSync(fileURLToPath(url)), specifier + ' resolved to a missing file: ' + url)
}

// ------------------------------------------------------------------ locale
const locales = readdirSync(resolve(ROOT, 'locale')).filter((name) => name.endsWith('.json')).sort()
assert.ok(locales.includes('en.json'), 'locale/en.json is the required English fallback')
assert.ok(locales.includes('zh.json'), 'locale/zh.json keeps the Chinese UI labelled')
const localeMeta = {}
for (const file of locales) {
  const bundle = JSON.parse(read('locale/' + file))
  const meta = bundle.meta ?? {}
  assert.equal(typeof meta.title, 'string', file + ': meta.title is required')
  assert.equal(typeof meta.description, 'string', file + ': meta.description is required')
  assert.ok(meta.title.trim() !== '', file + ': meta.title is empty')
  assert.ok(meta.description.trim() !== '', file + ': meta.description is empty')
  if (meta.detail !== undefined) {
    const detailPath = resolve(ROOT, meta.detail)
    assert.ok(existsSync(detailPath), file + ': meta.detail points at a missing document: ' + meta.detail)
    assert.ok(statSync(detailPath).size <= 1024 * 1024, file + ': meta.detail exceeds the 1 MiB detail limit')
  }
  localeMeta[file] = Object.keys(meta).sort().join(',')
}
assert.equal(
  new Set(Object.values(localeMeta)).size,
  1,
  'every locale must declare the same meta keys: ' + JSON.stringify(localeMeta),
)

// -------------------------------------------------------------------- icon
const iconPath = resolve(ROOT, manifest.icon ?? manifest.exports['./icon'])
assert.ok(existsSync(iconPath), 'icon file is missing: ' + iconPath)
assert.ok(statSync(iconPath).size <= 256 * 1024, 'icon exceeds the 256 KiB limit')
assert.match(iconPath, /\.(svg|png|jpe?g|webp)$/, 'icon must be SVG, PNG, JPEG or WebP')
if (iconPath.endsWith('.svg')) {
  const svg = readFileSync(iconPath, 'utf8')
  assert.match(svg, /<svg[\s>]/, 'declared SVG icon does not contain an <svg> root')
  assert.match(svg, /viewBox=|width=|height=/, 'SVG icon must be renderable (viewBox or explicit size)')
}

// ------------------------------------------------------------------- files
// `files` is what a packed install actually contains; a linked checkout ignores
// it, so verify the listed paths really exist instead of trusting the list.
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'files must be declared')
for (const entry of manifest.files) {
  if (entry.includes('*')) {
    const dir = resolve(ROOT, entry.slice(0, entry.indexOf('*')).replace(/\/$/, '') || '.')
    assert.ok(existsSync(dir), 'files entry has no directory: ' + entry)
    const pattern = entry.slice(entry.lastIndexOf('/') + 1).replace('*', '')
    const match = existsSync(dir) && statSync(dir).isDirectory()
      ? readdirSync(dir).some((name) => name.endsWith(pattern))
      : true
    assert.ok(match, 'files entry matches nothing: ' + entry)
    continue
  }
  assert.ok(existsSync(resolve(ROOT, entry)), 'files entry does not exist: ' + entry)
}
const packed = manifest.files.map((entry) => entry.replace(/^\.\//, ''))
for (const required of ['lib', 'locale/*.json', (manifest.icon ?? 'icon.svg').replace(/^\.\//, ''), 'cordis.patch.yml', 'LICENSE']) {
  assert.ok(
    packed.some((entry) => entry === required || entry.startsWith(required.replace(/\*.*$/, '') + '/')),
    'files must keep ' + required,
  )
}

// ----------------------------------------------------- version consistency
const changelog = read('CHANGELOG.md')
const headings = Array.from(changelog.matchAll(/^## (\d+\.\d+\.\d+)( \(unreleased\))?/gm)).map((match) => ({
  version: match[1],
  unreleased: match[2] !== undefined,
}))
assert.ok(headings.length > 0, 'CHANGELOG.md needs at least one "## x.y.z" section')
const released = headings.find((heading) => heading.unreleased !== true)
assert.ok(released !== undefined, 'CHANGELOG.md needs a released section to compare package.json against')
assert.equal(
  manifest.version,
  released.version,
  'package.json ' + manifest.version + ' disagrees with the latest released CHANGELOG section ' + released.version +
    (headings[0].unreleased ? ' (top section ' + headings[0].version + ' is unreleased)' : ''),
)
if (headings[0].unreleased && headings[0].version === manifest.version) {
  assert.fail('CHANGELOG top section is unreleased but already carries the published version ' + manifest.version)
}

// An exact-match tag must name this version, otherwise a release went out under
// a different number than the one the manifest claims.
let tag = null
try {
  tag = execFileSync('git', ['describe', '--exact-match', '--tags', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
} catch {
  tag = null
}
if (tag !== null) {
  assert.equal(tag, 'v' + manifest.version, 'git tag ' + tag + ' does not match package.json ' + manifest.version)
}

console.log(
  'manifest ok · ' + manifest.name + '@' + manifest.version +
  ' · dsh ' + manifest.engines.dsh +
  ' · inject ' + manifest.dsh.client.inject.length + ' client packages' +
  ' · locales ' + locales.join('/') +
  (tag === null ? '' : ' · tag ' + tag),
)