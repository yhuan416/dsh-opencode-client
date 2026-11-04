#!/usr/bin/env bash
# Install dsh-opencode-client into a dsh web profile (manual, no pnpm store needed).
# Usage: bash scripts/install-into-profile.sh [opencode-url] [server-id]
set -euo pipefail

PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCODE_URL="${1:-http://192.168.4.50:4096}"
SERVER_ID="${2:-n100}"

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

node - "$PROFILE_DIR/cordis.patch.yml" "$SERVER_ID" "$OPENCODE_URL" <<'NODE'
const fs = require('fs')
const file = process.argv[2]
const id = process.argv[3]
const url = process.argv[4]
let text = ''
try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
if (text.includes('id: opencode-client')) {
  console.log('profile patch already has opencode-client; skip')
  process.exit(0)
}
text = text.replace(/\s*$/, '') + '\n' + [
  '',
  '# OpenCode client (dsh-opencode-client)',
  '- id: opencode-client',
  '  name: dsh-opencode-client',
  '  config:',
  '    servers:',
  '      - id: ' + id,
  '        label: ' + id + ' opencode',
  '        url: ' + url,
  '    permission: allow',
  '',
].join('\n')
fs.writeFileSync(file, text)
console.log('profile patch updated')
NODE

cat <<EOF

Done. Restart the dsh web profile, then use a NEW session.
Tools: opencode_sessions / opencode_messages / opencode_delegate
Optional native subagent row:

- insert:
    - id: tool-opencode-$SERVER_ID
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: opencode-$SERVER_ID
        maxDepth: provider-managed
        toolName: subagent_$SERVER_ID
EOF
