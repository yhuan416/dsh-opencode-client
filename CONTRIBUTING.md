# Contributing to dsh-opencode-client

Thanks for taking the time to improve the plugin. This project is a DeepSeek Harness (dsh) client
plugin for OpenCode 2 servers: a cross-server observation console plus a native dsh subagent
backend. Contributions are welcome in both Chinese and English.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **OpenCode 2 only.** v1 support was removed in 1.0.0. A v1 server is rejected on purpose; do not
  reintroduce v1 branches, fallbacks or compatibility shims.
- **Do not commit secrets.** Server passwords, launch tokens and `.env` files are never part of a
  patch. Use environment variables or the dsh profile config for local testing.
- **Keep the seams small.** Prefer one implementation shared by routes, tools and the UI over a new
  parallel code path. If a change adds a public tool, route, config field or UI slot, say so in the
  PR and update the docs.

## Development setup

Requirements:

- Node.js **>= 22**
- npm (the repository uses `package-lock.json`)
- For live checks: a reachable OpenCode **2.4.x** server with `OPENCODE_SERVER_PASSWORD` set

```sh
git clone https://github.com/yhuan416/dsh-opencode-client.git
cd dsh-opencode-client
npm ci
npm run check
```

There is no client build step: `lib/client.js` is a hand-written browser bundle and is loaded
directly by dsh. Do not add a bundler just for a UI change.

Useful commands:

| Command | What it does |
|---|---|
| `npm run check` | node syntax checks, manifest gate and the full offline test suite |
| `npm test` | the offline test suite only |
| `npm run manifest` | plugin manifest / version / changelog / tag consistency |
| `node scripts/e2e-live.mjs` | live acceptance against a real OpenCode 2 server |

## Running the live end-to-end check

The live run creates a session, delegates a short turn, sends a follow-up, runs shell/workspace
calls, forks/compacts and aborts a long turn. It is safe against a disposable `/tmp` directory, but
it does create sessions on the target server.

```sh
OPC_LIVE_URL=http://192.0.2.10:4096 \
OPC_LIVE_PASSWORD='<server password>' \
OPC_LIVE_DIR=/tmp \
node scripts/e2e-live.mjs
```

Never paste a real password into an issue, PR, screenshot or commit. If a failure depends on a
private server, reproduce it with a minimal local server or redact the details.

## Project layout

| Path | Responsibility |
|---|---|
| `lib/index.js` | plugin entry, config, tools/provider registration |
| `lib/client.js` | browser bundle: board, insights, settings, toasts |
| `lib/routes.js` | `/api/opencode-client/*` host routes |
| `lib/sessions.js` | sessions, messages, stats, pending, attribution |
| `lib/insights.js` | 7/30-day insights and 30-day activity |
| `lib/tools.js` | the 28 `opencode_*` model tools |
| `lib/provider.js`, `lib/session-run.js` | native dsh subagent backend |
| `lib/workspace.js`, `lib/manage.js`, `lib/catalog.js` | workspace, session management, catalogs |
| `test/` | offline tests; `scripts/e2e-live.mjs` is the live check |
| `docs/` | architecture, tools, compatibility, migration notes |

## Coding conventions

- ES modules, 2-space indentation, single quotes, no semicolon-free style changes.
- Keep the `@opencode/client` dependency **exactly pinned**; a floating range fails the manifest
  gate. Upgrades are separate, deliberate changes.
- Route every OpenCode call through `ocCall()` / the shared client. Do not add a second HTTP stack.
- Normalize errors through `OpenCodeError`; do not degrade a failed call into empty data.
- Preserve the existing UI vocabulary and dark-theme tokens. UI changes should also update
  `README.md` and `README.zh.md` when the visible behavior changes.
- No new disk state for observation data unless the design explicitly allows it (see the
  "observation layer does not persist" rule in `TODO.md`).

## Tests and docs checklist

Before opening a PR:

- [ ] `npm run check` passes (currently 131 tests)
- [ ] If you changed a runtime path, run the live e2e against OpenCode 2.4.x and paste the result
- [ ] Update `CHANGELOG.md` for user-visible changes
- [ ] Update `README.md` / `README.zh.md` or the relevant `docs/` page when behavior, config, tools
      or routes change
- [ ] Keep `TODO.md` honest: check off completed items instead of leaving stale "unfinished" notes
- [ ] No secrets, tokens, private hostnames or personal data in the diff or screenshots

## Commits and pull requests

- Use a short type prefix: `feat:`, `fix:`, `docs:`, `perf:`, `refactor:`, `test:`, `chore:`.
- Keep one concern per PR. A feature + its docs + tests is one concern; unrelated cleanups are not.
- The repository uses a linear history and **squash merges**. Rebase your branch before merging.
- Fill in the PR template, including the verification section and any SemVer impact.

## Release policy

Releases are **git-only**: an annotated tag on `master`, no npm publish (`private: true`).
Maintainers cut tags; contributors should not create release tags. The versioning promise and the
covered API surface are in [COMPATIBILITY.md](COMPATIBILITY.md#semver-scope-100).

## Reporting bugs and security issues

- Bug reports and feature requests: use the issue templates.
- Security vulnerabilities: **do not open a public issue**; see [SECURITY.md](SECURITY.md).

## Questions

For usage questions, read the [README](README.md), [docs/TOOLS.zh.md](docs/TOOLS.zh.md) and
[COMPATIBILITY.md](COMPATIBILITY.md) first. If the answer is still missing, open a discussion-worthy
issue with the smallest reproducible setup.
