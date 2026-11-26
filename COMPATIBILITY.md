# Compatibility

This plugin follows **independent semantic versioning** (it does not mirror the dsh release train)
and is **not published to npm**; install it from git or a local path. **Current release: `0.7.2`**
(2026-11-26). Release line: `0.2.0` first read OpenCode 2, `0.7.1` completed v2 end to end
([PR #5](https://github.com/yhuan416/dsh-opencode-client/pull/5)), `0.7.2` fixed the manifest/exports
and added the CI gates. `1.0.0` is deliberately not cut yet: the host seam is still `0.2.x` and the
v1 question is open (see below).

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
| `ctx.slots.inject` / `ctx.slots.register` on `main`, `sidebar.panellist`, `sidebar.right.pane.tab(.title)`, `conversation.session.header.actions`, `shell.overlay`, `plugins.detail.section` | board page, rail icon + badge, right-pane session tab, header button, toasts, settings section |
| `ctx.sidebarRightTabs.register`, `ctx.sidebarRight.openTab` | registers the `opencode` tab kind and opens it |
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

## v1 policy (frozen)

- **OpenCode 2 is the supported target.** The v1 path (`OpenCode 1.18.x`) stays in the code for
  existing installs, but it is **frozen**: no new capability is added to it, and the v1 column in
  the tables below records current behaviour rather than a support commitment.
- **Field verification is gone.** There is no v1 server in this project any more; v1 behaviour is
  exercised only by offline fixtures (`test/board.test.js`, `test/http.test.js`). Treat field
  behaviour on 1.18.x as unverified.
- **New features land on v2 only** — `opencode_usage`, the board's "finished, not looked at"
  partition and `POST /api/opencode-client/seen` all depend on v2-only data (`time.viewed`,
  `POST /session/{id}/view`, `step.ended`).
- **Removal would be a breaking release**, announced in the CHANGELOG — not a silent drop. Nothing
  is scheduled; the frozen path costs nothing to keep but is not maintained either.

## OpenCode compatibility

Both API generations are read from one install (**v1 is frozen**, see the policy below). The server API version is detected per
server (`apiVersion: auto | 1 | 2`): `auto` probes `GET /api/info` with HTTP Basic auth
(username `opencode`, password from the serve process' `OPENCODE_SERVER_PASSWORD`); a server
reporting OpenCode >= 2 gets every request prefixed with `/api` plus the Basic header, while v1
paths stay untouched. Probe failure, a missing password or HTTP 401 falls back to v1 and records
one diagnosable reason on `server.versionProbe` (logged at startup). Force a version per server
with `apiVersion: 1|2`.

| Capability | OpenCode 1.18.x (v1 API) | OpenCode 2.x (v2 API) |
|---|---|---|
| Version/health probe | `/global/health` | `/api/info` |
| Project/session discovery | `/project` (`worktree`), `/session` | `/api/project` (`canonical`), `/api/session` (`{data,cursor}`, `location.directory`, `?directory=`) |
| Messages | `info` + `parts` | `content[]`; fetched `order=desc` and presented oldest-first |
| Agents | `/agent` (`name`/`native`) | `/api/agent` (`id`/`name`/`mode`/`hidden`) |
| Models | `/config/providers` | `/api/provider` + `/api/model` + `/api/model/default` |
| Commands / skills / references / MCP | bare arrays | `{location,data}`; commands keep only name/description, skills expose `path`, MCP `status` is an object |
| Prompt | `prompt_async` `{parts,agent,model}` | `prompt` `{text,files}`; agent/model are session state (`/agent`, `/model`) |
| Completion | `session.idle` + message polling | `session.execution.succeeded\|failed\|interrupted` + `idle` message `outcome` |
| Abort | `/session/{id}/abort` | `/session/{id}/interrupt` (`{interrupted}`) |
| Status | `/session/status` | `/session/active` |
| Permissions | `/permission` + `/permission/{id}/reply {reply}` | session-scoped `/session/{sid}/permission` + `/reply {decision: once\|always\|reject}` |
| Questions | `/question` + `/reply|/reject` | forms: `/session/{sid}/form` + `/reply {answer:{key:value}}` / `DELETE` |
| Shell | synchronous `/session/{id}/shell` | asynchronous `POST /api/shell` + `/api/shell/{id}/output` (output pages followed via `cursor`, truncation reported) |
| VCS status/diff | `/vcs/status`, `/vcs/diff?mode=git|branch` | `{location,data}`, `mode=working|branch|committed` (`git`→`working`) |
| File read / find | `/file/content`, `/find/file`, `/find` | raw `/api/fs/read/*`, `/api/fs/find` (file paths only); content search emulated with workspace `grep` via `/api/shell` |
| Fork / summarize / init / children | `/fork {messageID}`, `/summarize`, `/init`, `/children` | `/fork {before}`, `/compact`, built-in `init` command, `/session?parentID=` |
| Share / tool ids | available | **not available** (explicit error, never silent empty data) |
| Session todos | `/session/{id}/todo` | no endpoint; derived from the last `todowrite` tool call (`state.input.todos`) |
| Model variants | none | `/api/model` `variants[]` (reasoning-effort ids) surfaced by `opencode_models`; selectable as `provider/model#variant` (v2 `Model.Ref.variant`) |

- **Verified against**: OpenCode `1.18.10`, `1.18.31`, `1.18.33` (v1) and OpenCode `2.3.0`
  (Linux x64, live server; measured 2026-11-18, v2 surface completed 2026-11-20).
- v1 remains the baseline for existing installs: all 26 `opencode_*` tools keep their names and
  v1 behaviour. `COMPATIBILITY` is aggregated across servers, so one profile can mix v1 and v2.
- Transport failures are never degraded into "0 results": 401, HTML/SPA bodies, non-JSON bodies,
  other non-2xx responses and network/timeout errors raise `OpenCodeError`, and per-server
  discovery failures are reported in the tool output.
- v2 session listing pages the API (v1 returns everything): one request asks for the 500 newest
  sessions per server and the tool output says so when more exist; older sessions stay reachable
  through `opencode_search`.
- v2 limitations that stay explicit (never silent): `opencode_share` and `opencode_tools` have no
  v2 endpoint. `opencode_shell` runs asynchronously in the session workspace and does not append a
  message to the session history; `opencode_summarize` maps to `compact` (session's own model, so
  `model` is optional on v2); `opencode_init` runs the built-in `init` command.
- v2 capability restorations (fallbacks, 0.4.0): `opencode_find(kind=text)` runs a workspace
  `grep -rIn -F` through the async shell (literal substring, first 100 matches, `.git` skipped);
  `opencode_session_info` derives todos from the last `todowrite` tool call; `opencode_messages`
  follows `cursor.next` so long sessions are not truncated at the server page size.
- The live acceptance run for both generations is `npm run e2e` (`scripts/e2e-live.mjs`) with
  `OPC_LIVE_URL` / `OPC_LIVE_PASSWORD` / `OPC_LIVE_DIR` and optional `OPC_LIVE_INTERACTIONS=1`.

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

- `format: {type:"json_schema"}` (structured output) persists a `retryCount` field in the user
  message and makes `GET /session/{id}/message` return 400 afterwards (1.18.10 and 1.18.31).
  The plugin therefore uses prompt-enforced JSON (`schema` parameter) instead of `format`.
- Live progress on v1 comes from `message.part.updated` / `message.part.delta` /
  `session.status` / `session.idle`; v2 reports progress through `session.text.*`,
  `session.reasoning.*`, `session.tool.*` and `session.step.*`, which `lib/events.js` maps to the
  same canonical model.
- `POST /api/session/{id}/wait` (v2) returns `503 Session wait is not available yet` on 1.18.31
  and 1.18.33, so completion uses SSE events (`session.idle` on v1, `session.execution.*` on v2)
  with a polling fallback instead of the v2 wait endpoint.
- `session.idle` / `session.status` still exist in the 2.3.0 schema but are not emitted for
  completed v2 runs; they are logged as informational events and are never used as v2
  completion signals.
- `GET /experimental/capabilities` reports `backgroundSubagents: false` on 1.18.31.
- Servers are single-tenant and have no server-side federation; multiple servers are aggregated by
  this client.

## Versioning policy

- `0.y.z` while pre-1.0; **minor** bumps add capabilities, **patch** bumps fix bugs/compat.
- Breaking seam/API changes bump the **minor** version and are listed in `CHANGELOG.md`.
- `CHANGELOG.md` records the tested dsh/OpenCode versions per release.