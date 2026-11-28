# Compatibility

This plugin follows **independent semantic versioning** (it does not mirror the dsh release train)
and **is published to npm**; `dsh plugin --profile web add dsh-opencode-client` is the primary
channel, while a local checkout or an explicit git spec stays supported as the development channel.
**Current release: `1.1.4`** (2026-11-28, annotated tag `v1.1.4`): the release pipeline moves to npm
trusted publishing (OIDC), so published tarballs carry a provenance attestation; `1.1.3` made npm the
primary install channel (`publishConfig`, a `prepublishOnly` gate, a tag-driven publish workflow); the
plugin is otherwise unchanged from `1.1.2` — one card system across the observe page and settings, editable
remotes in the manager UI (label / url / password, the stored password is never echoed back), and
permission-request diagnostics (`/board` `permissions` + board chip). It also fixes the settings
section blanking out and the `promptFailureMessage` ReferenceError. Folds in `1.1.1` (progressive
fill, one scheduler, placeholders, SWR + warm-up), `1.1.0` and the `1.0.2` insights layout.
Release line: `0.2.0` first read OpenCode 2, `0.7.1`
completed v2 end to end ([PR #5](https://github.com/yhuan416/dsh-opencode-client/pull/5)),
`0.7.2` fixed the manifest/exports and added the CI gates. `1.0.0` removes v1, pins
`@opencode/client@2.4.2`, and includes the untagged 0.8.0/0.9.0 observation changes. `1.1.0` adds
the plugin's own version/update check and the question/board fixes; `1.1.1` is the observe-page
performance pass (progressive fill, one scheduler, placeholders, SWR + warm-up); `1.1.2` unifies the
card surfaces, makes remotes editable and adds permission-request diagnostics.

## dsh compatibility

Declared in `package.json`:

```json
"engines": { "node": ">=22", "dsh": ">=0.2.1-rc.2" }
```

- **Verified against**: dsh `0.2.2-rc.5` (current runtime), with `0.2.1-rc.2` still exercised by the
  offline suite.
- **Minimum declared**: `0.2.1-rc.2`. dsh 0.1.x is **not supported** (untested).
- The range has no upper bound because the seam surface below has been stable across 0.2.x;
  if a future dsh breaks it, the plugin manager's version-exemption mechanism is the escape hatch.
- **How it is enforced**: `plugin_manager` refuses to install or activate a package whose
  `engines.dsh` (or, when absent, whose dsh peer ranges) do not admit the running version. The base
  loader only reads the fields declaratively, so this is a management-surface gate, not a runtime check.

dsh integration points used (each must exist for the plugin to load):

| Seam | Used for |
|---|---|
| `dsh.manifestVersion: 1`, `dsh.bundle.patch` | profile bundle insertion |
| `dsh.client.platform: "web"`, exports `./client` | plugin page section in the Web UI |
| exports `./locale/*.json`, `./icon` | Plugin Manager reads `meta.title` / `meta.description` and renders the icon without activating the plugin |
| `dsh.client.inject` (`dsh-client-ui-chat`, `-conversation`, `-sidebar`, `-sidebar-right`, `-plugin-manager`) | activation order for the slots and client services below |
| `ctx.slots.inject` / `ctx.slots.register` on `main`, `sidebar.panellist`, `shell.overlay`, `plugins.detail.section` | board page, rail icon + badge, toasts, settings section |
| `pluginNavigation.openBundle(owner)` | the settings pill that jumps to this plugin's config page |
| `ctx.configEditor.edit(entry, fn)` | writing the `servers` list back to the profile row |
| host `apply(ctx, config)`, `ctx.effect`, `ctx.inject`, `ctx.logger` | plugin lifecycle |
| `ctx.connection.fetch.register(route)` | `/api/opencode-client/*` routes |
| `ctx.tools.register(defineTool(...))` (from `@deepseek-ai/dsh-tools`) | model-facing tools |
| `ctx.subagents.registerProvider(provider)` | native subagent provider `opencode-<id>` |
| `ctx.approval.request(...)` | remote permission → dsh approval card |
| `ctx.userQuestions.ask(...)` | remote question → dsh user-question UI |
| client bundle `window.__ModuleLoader__`, `ctx.slots.inject("plugins.detail.section")` | plugin page section |

## Gates

`npm run check` is the offline gate; CI (`.github/workflows/check.yml`) runs the same command on
pull requests and on pushes to `master`:

1. `scripts/check.mjs` — `node --check` over `lib/`, `scripts/`, `test/` (a syntax error in the
   browser bundle would otherwise ship green, since no test imports it), client-bundle source
   assertions, and observation-registry smoke checks.
2. `scripts/check-manifest.mjs` — identity/engines, bundle + `inject` declarations, `exports`
   subpaths **resolved through Node's self-reference** (this is what silently breaks the locale),
   locale `meta` parity across languages, icon format/size, `files` coverage, and version agreement
   between `package.json`, the latest released `CHANGELOG` section and an exact-match git tag.
3. `node --test` — the offline suite.

Each gate has been exercised against a deliberately broken tree (missing export, version mismatch,
oversized icon, injected syntax error) and fails on all four.

## v1 policy (removed)

- **OpenCode 2 is the only supported generation.** OpenCode 1.x (1.18.x) was frozen in 0.7.2 and
  is **removed in 1.0.0**: a server that answers as v1 (old server, or no `/api/info`) fails every
  call with `opencode.v1_unsupported` and an actionable "requires OpenCode 2.x" message. `apiVersion: 1` is treated as `auto` and then rejected.
- **The v1 rows below are historical** and kept for migration context; they are not a support
  commitment.
- **Field verification is v2-only.** `npm run e2e` and the weekly-free maintenance checks run
  against real OpenCode 2 servers; there is no v1 fixture in the suite anymore.
- **New features land on v2 only** — `opencode_usage`, the board's "finished, not looked at"
  partition, the `background` status, the insights page (including the lazy per-skill scan) and
  `POST /api/opencode-client/seen` all depend on v2-only data (`time.viewed`,
  `POST /session/{id}/view`, `step.ended`, `/experimental/job`, `/experimental/session/stats`,
  `skill` tool messages).

## OpenCode compatibility

Only OpenCode 2 is supported (**v1 removed in 1.0.0**). Every request goes through
`@opencode/client` (pinned `2.4.2`) and carries HTTP Basic auth (username `opencode`, password from
the serve process' `OPENCODE_SERVER_PASSWORD`). `apiVersion: auto|2` is accepted (`auto` probes
`GET /api/info`); a missing password or HTTP 401 records one diagnosable reason on
`server.versionProbe`, and any v1 answer is rejected — never silently routed to old paths.

| Capability | OpenCode 2 |
|---|---|
| Version/health probe | `/api/info` |
| Project/session discovery | `/api/project` (`canonical`), `/api/session` (`{data,cursor}`, `location.directory`, `?directory=`) |
| Messages | `content[]`; first page `order=desc`, later pages `cursor` only; presented oldest-first |
| Agents | `/api/agent` (`id`/`name`/`mode`/`hidden`) |
| Models | `/api/provider` + `/api/model` + `/api/model/default` |
| Commands / skills / references / MCP | `{location,data}`; commands keep name/description, skills expose `path`, MCP `status` is an object |
| Prompt | `prompt` `{text,files}`; agent/model are session state (`/agent`, `/model`) |
| Completion | `session.execution.succeeded\|failed\|interrupted` + `idle` message `outcome` |
| Abort | `/session/{id}/interrupt` (`{interrupted}`) |
| Status | `/session/active` |
| Permissions | session-scoped `/session/{sid}/permission` + `/reply {decision: once\|always\|reject}` |
| Questions | forms: `/session/{sid}/form` + `/reply {answer:{key:value}}` / `DELETE` |
| Shell | asynchronous `POST /api/shell` + `/api/shell/{id}/output` (output pages followed via `cursor`, truncation reported) |
| VCS status/diff | `{location,data}`, `mode=working\|branch\|committed` (`git`→`working`) |
| File read / find | raw `/api/fs/read`, `/api/fs/find` (file paths only); content search emulated with workspace `grep` via `/api/shell` |
| Fork / summarize / init / children | `/fork {before}`, `/compact`, built-in `init` command, `/session?parentID=` |
| Share / tool ids | **not available** (explicit error, never silent empty data) |
| Session todos | no endpoint; derived from the last `todowrite` tool call (`state.input.todos`) |
| Model variants | `/api/model` `variants[]` (reasoning-effort ids) surfaced by `opencode_models`; selectable as `provider/model#variant` |

- **Verified against**: OpenCode `2.3.0` and `2.4.2` (Linux x64, live servers; v2 surface
  completed 2026-11-20, 2.4.2 added 2026-11-27 — `npm run e2e` 10/10 on two 2.4.2 servers).

### Upstream client pinning (2026-11-27)

`@opencode/client` is a generated client released in lockstep with OpenCode core
(`2.4.2` ↔ core `2.4.2`, stable every 0–7 days). This plugin deliberately does
**not** track that cadence:

- the dependency is pinned to an **exact version** (`2.4.2`, no `^`/`~`), and
  `scripts/check-manifest.mjs` fails the build if the range or the lockfile drifts;
- the plugin version (`0.9.x`, `1.0.x`, …) is independent of the OpenCode version;
- upgrades happen **only** when (a) a server version we must support breaks a
  field/endpoint we read, or (b) a feature needs a newer client — each upgrade is
  a deliberate PR with `npm run check`, live `npm run e2e`, and an update to this
  section;
- newer OpenCode versions are best-effort: additive fields are ignored, but we do
  not promise a version we have not run against. A runtime version probe already
  reports the server version on the board.

This trades new upstream capabilities for stability: the observation console
prefers a known-good client over chasing weekly releases.

- All `opencode_*` tools keep their names; no profile can mix v1 and v2 because v1 servers are
  rejected at the transport.
- Transport failures are never degraded into "0 results": 401, HTML/SPA bodies, non-JSON bodies,
  other non-2xx responses and network/timeout errors raise `OpenCodeError`, and per-server
  discovery failures are reported in the tool output.
- Session listing pages the API: one request asks for the 500 newest sessions per server and the
  tool output says so when more exist; older sessions stay reachable through `opencode_search`.
- Limitations that stay explicit (never silent): `opencode_share` and `opencode_tools` have no
  endpoint. `opencode_shell` runs asynchronously in the session workspace and does not append a
  message to the session history; `opencode_summarize` maps to `compact` (session's own model, so
  `model` is optional); `opencode_init` runs the built-in `init` command.
- Capability restorations (fallbacks, 0.4.0): `opencode_find(kind=text)` runs a workspace
  `grep -rIn -F` through the async shell (literal substring, first 100 matches, `.git` skipped);
  `opencode_session_info` derives todos from the last `todowrite` tool call; `opencode_messages`
  follows `cursor.next` so long sessions are not truncated at the server page size.
- The live acceptance run is `npm run e2e` (`scripts/e2e-live.mjs`) with
  `OPC_LIVE_URL` / `OPC_LIVE_PASSWORD` / `OPC_LIVE_DIR` and optional `OPC_LIVE_INTERACTIONS=1`.

### 2.4.x deltas (2.3.0 → 2.4.2, measured 2026-11-27)

Compared from the two servers' own `GET /openapi.json` (170 → 188 operations, 515 → 556 schemas):

- **Removed**: only `/api/experimental/schedule*` (6 operations, replaced by
  `/api/experimental/automation*`). This plugin never used schedules, so nothing to migrate.
- **Added**: `POST /api/experimental/job/{id}/cancel`, video (`/api/experimental/generate/video`),
  blob, machine and push endpoints, `GET /api/experimental/skill/{skillID}/file/*`.
- **Nothing this plugin reads was removed.** `V2Event` grew 100 → 102 members
  (`experimental.job.updated`, `experimental.push.updated`); the event schemas mapped by
  `lib/events.js` (`session.text|tool|step|execution|idle.*`) are byte-identical.
- **Additions only** on payloads we parse: `Job.Kind`/`Job.Info` gain `video` and `codemode`
  (unknown kinds flow through the board as-is), `Model.Type` gains `video`,
  `Agent.Info.instructions`, `Model.Info.experimental`, `Skill.Info.content.description`,
  `Session.Inbox.Delivery` (steer/queue) — all optional.
- **MCP protocol default changed `legacy` → `auto`** (2.4.0). A stdio server that only serves the
  `2026-07-28` revision can now fail: the discovery probe is answered too late (`Received a
  response for an unknown message ID` in the server log), opencode falls back to the legacy
  `initialize`, and such a server rejects it. Fix per server: put it under `mcp.servers.<name>`
  (v2 shape) and set `"protocol": "2026-07-28"`. The legacy `mcp.<name>` config shape **silently drops**
  the `protocol` field during normalisation, so setting it there has no effect.
- **First catalog read after a restart can be empty/partial** (2.4.0 restored asynchronous plugin
  loading). `model`/`provider`/`skill`/`mcp` answer with whatever has loaded; subsequent reads are
  complete. Never cache the first snapshot — re-read, or refresh on the matching `*.updated` event.
- **Shell timeout moved to the background** (2.3.1): a command still running at its timeout is no
  longer killed, it becomes a background job (visible via `/api/experimental/job`). This plugin's
  `opencode_shell` contract is unchanged.
- Structured-output and tool-name changes (`experimental_image_generate` → `generate_image`) only
  affect permission allow-lists on the server, not this client.

Subagent dispatch:

- A tool row is bound to one provider, and each `opencode-<server>` provider is bound to one
  OpenCode server, so `opencode_subagent_<server>` is deterministic by construction.
- `opencode-auto` (registered when more than one server is configured, tunable via `routing`) is
  the routing layer: directory coverage → parent stickiness → least running sessions →
  round-robin, with failover to the next candidate when a start fails before publication.
- Routing never changes continuation: a remote session id belongs to one server, so resumed
  sessions must go back to that server (pinned tool or `server` on `opencode_subagent`).
- A failed start leaves no partial run: the provider cleans up before rejecting (seam contract),
  which is what makes failover safe.
- OpenCode creates a session even for a directory it cannot see and only rejects the prompt, so
  the plugin maps `LocationNotFoundError` to an actionable `pathMap` hint.

Known upstream issues that shape the integration:

- Structured output uses prompt-enforced JSON (`schema` parameter) instead of upstream `format`,
  and the result is validated locally.
- Live progress is derived from `session.text.*`, `session.reasoning.*`, `session.tool.*` and
  `session.step.*`, which `lib/events.js` maps to the canonical model.
- `POST /api/session/{id}/wait` returns `503 Session wait is not available yet` on some 2.x
  builds, so completion uses SSE events (`session.execution.*`) with a polling fallback.
- `session.idle` / `session.status` still exist in the 2.3.0 schema but are not emitted for
  completed runs; they are logged as informational events and are never used as completion
  signals.
- Servers are single-tenant and have no server-side federation; multiple servers are aggregated by
  this client.

## SemVer scope (1.0.0)

Covered by the 1.x compatibility promise:

- `opencode_*` tool names and their documented parameters / return shape.
- The config structure: `servers` (`id`/`url`/`password`/`directory`/`agent`/`model`/`apiVersion`),
  `permission`, `question`, `pathMap`, `routing`.
- The host routes the bundled UI actually calls: `/api/opencode-client/board`, `/about`, `/list`, `/probe`,
  `/seen`, `/usage`, `/insights`, `/insights/activity`, `/insights/skills`, `/upgrade`, `/servers`,
  `/servers/remove`.

Explicitly **not** covered:

- The other `/api/opencode-client/*` routes: they mirror tool capabilities for external clients and
  are **internal/experimental**; they may change without a major bump.
- The dsh host seam (`engines.dsh`, slots/services) — it follows dsh, not this plugin.
- The OpenCode upstream HTTP API and `@opencode/client` — pinned and upgraded independently.
- UI layout, copy and `localStorage` keys.

Breaking changes bump **major**, additive changes **minor**, fixes **patch**. Releases are
git-only (annotated tag); the package is `private` and never published to npm.

## Versioning policy

- `0.y.z` while pre-1.0; **minor** bumps add capabilities, **patch** bumps fix bugs/compat.
- `1.0.0` removes the v1 API and moves the transport to `@opencode/client`; after it, breaking
  seam/API changes bump the **major** version and are listed in `CHANGELOG.md`.
- `CHANGELOG.md` records the tested dsh/OpenCode versions per release.