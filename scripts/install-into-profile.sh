#!/usr/bin/env bash
# Install dsh-opencode-client into a dsh web profile (manual, no pnpm store needed).
# Usage: [OPENCODE_SERVER_PASSWORD=...] bash scripts/install-into-profile.sh [opencode-url] [server-id]
#
# The password is optional but required for OpenCode 2.x servers: without it the
# plugin falls back to the v1 API and the server shows as offline.
set -euo pipefail

PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_URL="${1:-http://192.168.4.50:4096}"
SERVER_ID="${2:-n100}"
PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"

echo "==> plugin : $PLUGIN_DIR"
echo "==> profile: $PROFILE_DIR"
echo "==> server : $SERVER_ID -> $OPENCODE_URL"

mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-opencode-client"
cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-$(date +%s)"
[ -f "$PROFILE_DIR/cordis.patch.yml" ] && cp "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml.bak-$(date +%s)"

node - "$PROFILE_DIR/package.json" "$PLUGIN_DIR" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const pluginDir = process.argv[3]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-opencode-client'] = 'file:' + pluginDir
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (!pkg.dsh.profile.bundles.includes('dsh-opencode-client')) pkg.dsh.profile.bundles.push('dsh-opencode-client')
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('profile package.json updated')
NODE

node - "$PROFILE_DIR/cordis.patch.yml" "$SERVER_ID" "$OPENCODE_URL" "$PASSWORD" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const id = process.argv[3]
const url = process.argv[4]
const password = process.argv[5] || ''
let text = ''
try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
if (text.includes('id: opencode-client')) {
  console.log('profile patch already has opencode-client; skip')
  process.exit(0)
}
const lines = [
  '',
  '# OpenCode client (dsh-opencode-client)',
  '- id: opencode-client',
  '  name: dsh-opencode-client',
  '  config:',
  '    servers:',
  '      - id: ' + id,
  '        label: ' + id + ' opencode',
  '        url: ' + url,
]
if (password !== '') lines.push('        password: ' + password)
lines.push('')
lines.push('    # ask: 无 dsh run 归属的权限请求不再自动批准，登记为「需要你」；')
lines.push('    # 想回到旧的自动批准行为，改成 auto。')
lines.push('    permission: ask')
lines.push('')
text = text.replace(/\s*$/, '') + '\n' + lines.join('\n')
fs.writeFileSync(file, text)
console.log('profile patch updated')
NODE

cat <<EOF

Done. Restart the dsh web profile, then use a NEW session.

Left rail: "OpenCode" opens the observation board (cards).
Tool: opencode_board  -> who is running / who is waiting, across every server.
Also: opencode_sessions / opencode_messages / opencode_subagent

If the server shows offline with apiVersion=1, the password was missing
(export OPENCODE_SERVER_PASSWORD and re-run, or edit the profile patch).
Optional native subagent row:

- insert:
    - id: tool-opencode-$SERVER_ID
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: opencode-$SERVER_ID
        maxDepth: provider-managed
        toolName: opencode_subagent_$SERVER_ID
EOF