## 0.4.1 (2026-11-20)

OpenCode 2 model variants are selectable, not just listable.

### Added

- `model` accepts `"providerID/modelID#variant"` (e.g.
  `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high`). The variant rides the v2
  `Model.Ref.variant` field when the session is created or the model is switched, and shows up on
  the remote session (`session.model.variant`). Plain `"provider/model"` still means the model
  default; `opencode_models` lists the variant ids per model.
- v1 stays strict: prompt bodies only send `{providerID, modelID}` (the `variant` field is
  v2-only), while v2 session creation carries the full `Model.Ref`.

### Changed

- `npm test`: 61 cases (adds the variant parse/ref shape test).
- `package.json`: version `0.4.1`.

### Verified

- Live on n100 (OpenCode 2.3.0): delegating with
  `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high` created a session whose
  `model.variant` is `high`; omitting the variant yields the server default.

## 0.4.0 (2026-11-20)

OpenCode 2 compatibility backfill: three v1 capabilities that v2 removed or degraded are restored
through v2-native fallbacks, and message pagination is now correct for long sessions.

### Added

- `opencode_find kind=text` works on OpenCode 2 again. v2 removed `/find?pattern=`, so the plugin
  runs a workspace `grep -rIn -F` through the async shell (`lib/workspace.js::runShellCommand`) and
  returns the same `path:line: text` shape (first 100 matches, literal substring, `.git` skipped).
- `opencode_session_info` todo list works on OpenCode 2 again, derived from the last `todowrite`
  tool call in the session (`state.input.todos`); output marks it `[derived from the last todowrite
  call]`. v1 keeps using `/session/{id}/todo`.
- `opencode_models` surfaces OpenCode 2 model `variants` (reasoning-effort ids) as
  `model{none|low|high}` so a variant can be picked without guessing.

### Fixed

- `opencode_messages` follows the v2 cursor (`cursor.next`) instead of silently truncating at the
  server page size: requesting N messages now pages until N entries are collected (bounded to 20
  pages / 4000 raw entries) and keeps exactly the newest N.
- `opencode_find kind=text` no longer answers "not available on OpenCode 2".

### Changed

- `npm test` covers 60 cases (4 new v2-compat tests: shell-grep search, cursor pagination, derived
  todos, model variants).
- `package.json`: version `0.4.0`.

### Verified

- Live on n100 (OpenCode 2.3.0): content search returned `./a.txt:1: alpha needle here` (2 hits);
  a session that used `todowrite` reported all 6 todos with priorities; a 199-message session
  returned 149 of 150 requested messages (one raw entry is not a text message); model listing
  showed `qwen4-max-preview{none|low|medium|xhigh}` and `deepseek-v4.1-flash-1017{none|low|high}`.

## 0.3.0 (2026-11-20)

Multi-server subagent routing, accurate stop reasons, and a crash fix in the shared prompt path.

### Added

- `opencode-auto` routed provider. Per-server providers are pinned to one machine; when more than
  one server is configured the plugin also registers `opencode-auto`, which orders candidates per
  start (`directory` → `sticky` → `least-busy` → `round-robin`) and falls back to the next server
  when a start fails before the run is published. The chosen server is appended to the child
  session title (`dsh subagent: <label> @<server>`) and logged.
- `routing` config block: `providerName` (default `opencode-auto`), `policy`, `sticky`,
  `failover`, `stickyTtlMs`. Enabled by default when `servers.length > 1`; set
  `routing.enabled: false` to opt out.
- `opencode_subagent_auto` tool row example (add `tool-opencode-auto` with
  `provider: opencode-auto`).
- `stopReason` fidelity: OpenCode's `finish=length` now maps to dsh `max-tokens` and
  `content-filter` to `refusal` (was always `completed`), so the parent's settlement notice says
  "ran out of room before it finished" / "declined the task". `finish=error`/`error` map to
  `error`; cancellation still wins with `aborted`.
- Actionable `LocationNotFoundError` diagnostics: a child cwd the remote cannot see now reports
  "server <id> cannot see directory <dir>; configure pathMap …" instead of a bare HTTP 404
  (OpenCode creates the session first and rejects the prompt).

### Fixed

- Refused/failed prompts leaked a pending completion waiter: disposing or aborting afterwards
  produced an unhandled rejection (`opencode: aborted`) that could crash the host process after
  the run had already settled as an error. Every early-exit path now settles the waiter and marks
  the abandoned promises handled (`lib/delegate.js`).

### Changed

- `npm test` covers 56 cases (adds `test/provider.test.js` for finish/stopReason mapping and
  `test/routing.test.js` for routing policies, directory scoping, tie rotation and failover).
- `package.json`: version `0.3.0`.

### Verified

- Live routed provider across n100 + m65 (OpenCode 2.3.0): directory routing (`/tmp` → n100,
  `/home/yhuan` → m65), round-robin alternating (`n100 → m65 → n100 → m65`), failover from a dead
  endpoint to n100, and the missing-directory diagnostic.

## 0.2.0 (2026-11-20)

OpenCode 2 support, end to end. The plugin now speaks both OpenCode 1.18.x (v1 API) and
OpenCode 2.x (v2 API) from the same install; the 26 `opencode_*` tool names are unchanged and
v1 behaviour is preserved. Completes the phased plan in `docs/opencode-v2-migration.zh.md`
(phases 1–2 shipped earlier as transport + SSE/completion; this release adds the read-only
surface, prompts/delegation, permissions/forms, workspace/manage calls and tool semantics).

### Added

- OpenCode 2 read-only surface: `/api/info` health, `/api/project` (`canonical`), `/api/session`
  (`{data,cursor}`, `location.directory`, `?directory=` filtering), `/api/session/{id}/message`
  (`order=desc` fetched then presented oldest-first, `content[]` text/reasoning/tool parts),
  `/api/agent` (`id`/`name`/`mode`/`hidden`), `/api/session/active` and `/api/session/{id}/diff`;
  session info reports `outcome`/`cost`/`tokens` and no longer claims a todo list on v2.
- OpenCode 2 catalogs: providers and models from `/api/provider` + `/api/model` +
  `/api/model/default` (credentials never surfaced, disabled models hidden), commands (name and
  description only), skills (`path` instead of `location`), references, MCP status objects and
  session search through the list endpoint; `/experimental/tool/ids` is reported as unavailable.
- OpenCode 2 prompts and delegation: `{text,files:[{uri,name}]}` prompt bodies, directory in the
  create body (`location.directory`), agent/model applied as session state
  (`POST /api/session/{id}/agent|model`), completion from `session.execution.*` with the `idle`
  message outcome as the polling safety net, and `/api/session/{id}/interrupt` for aborts.
- OpenCode 2 workspace and session management: asynchronous shells (`POST /api/shell`, poll
  `/api/shell/{id}`, read `/api/shell/{id}/output`), `{location,data}` VCS status/diff with
  `mode=working|branch|committed` (`git`→`working`), raw `/api/fs/read/*` file reads,
  `/api/fs/find` path search, fork (`before`), compact in place of summarize, `init` as the
  built-in command and children through `GET /api/session?parentID=`.
- OpenCode 2 interactions: session-scoped permissions replied with `once|always|reject` and
  questions bridged as forms with typed fields (string/number/integer/boolean/multiselect),
  `{answer:{key:value}}` replies and `DELETE` dismissal; `form.created|replied|cancelled` map to
  the canonical question events so the SSE fast path and the polling fallback both work.
- `lib/http.js` helpers shared by the v2 branches: `apiVersionOf`, `unwrap`, `unwrapList`,
  `withLocation`, `opencodeValue` and `opencodeRaw` (raw `/api/fs/read/*` bodies).
- `test/v2-surface.test.js`: 8 offline tests over a fake v2 server (sessions/messages/agents,
  catalogs and secret redaction, workspace and async shell, manage calls, prompt bodies and
  agent/model session state, permission/form bridging, explicit unsupported paths).
- `scripts/e2e-live.mjs` (`npm run e2e`): live acceptance run against a real `opencode serve`,
  for v1 and v2, covering probe, read surface, delegation, follow-up, shell, workspace calls,
  fork/children/compact, abort and the version-specific unsupported paths; optional
  `OPC_LIVE_INTERACTIONS=1` exercises the approval/question bridges.
- CI: `.github/workflows/check.yml` runs `npm run check` on push to the main branches and on every
  pull request, with Node 22.
- `.gitattributes` (LF normalization, PNG/JPG binary, SVG text/eol=lf) and `.editorconfig`
  (UTF-8, LF, final newline, 2 spaces; Markdown keeps trailing whitespace).
- README facelift in both languages: centered shields badges (release, license, Node, dsh, CI),
  a positioning tagline, a quick start (install → configure → restart → verify), a table of
  contents, a Mermaid architecture diagram (browser → dsh origin → plugin → `opencode serve` plus
  the SSE `/global/event` direction), an ecosystem table, and a thematic grouping of the feature
  list.
- `docs/TOOLS.zh.md`: tool-by-tool reference for the 26 `opencode_*` tools — purpose, key
  parameters, read-only vs mutating, and the remote HTTP API each one uses.
- `docs/ARCHITECTURE.zh.md`: Chinese architecture companion (module map, data flows, design
  decisions, feature checklist) mirroring `ARCHITECTURE.md`.
- `test/http.test.js` (18 `node:test` cases) and `npm test`; `npm run check` now runs the offline
  smoke checks plus the transport tests.
- `lib/events.js`: one canonical event model for both wire formats, with version-split completion
  classification.
- `test/events.test.js`, `test/sse.test.js`, `test/completion.test.js`: v1/v2 event sequences,
  succeed/fail/interrupt endings, unknown-event forward compatibility, and version-aware SSE
  endpoints/auth (37 test cases in total).

### Changed

- `lib/sessions.js`, `lib/catalog.js`, `lib/delegate.js`, `lib/session-run.js`,
  `lib/interactions.js`, `lib/workspace.js`, `lib/manage.js`, `lib/routes.js` and `lib/tools.js`
  now branch on the detected API version and expose one normalized shape to routes/tools, so a
  single install aggregates v1 and v2 servers. Every version probe runs before a version-specific
  path is chosen (a fresh server is never assumed to be v1).
- Unsupported-on-v2 features fail loudly instead of returning empty data: `opencode_share`,
  `opencode_tools`, `opencode_find(kind=text)` and the `opencode_session_info` todo list return
  explicit "not available on OpenCode 2" messages; v1 keeps the old behaviour.
- `opencode_summarize` maps to v2 `compact` (the session's own model is used, so its `model`
  argument is optional on v2); `opencode_init` runs the built-in `init` command; `opencode_shell`
  runs asynchronously in the session workspace; `opencode_git_diff` accepts `committed` and maps
  `git` to v2's `working`.
- `package.json`: version `0.2.0`; the plugin is still not published to npm.
- `lib/http.js`: transport-level OpenCode API version support (Phase 1 of
  `docs/opencode-v2-migration.zh.md`). Servers default to `apiVersion: auto`, which probes
  `GET /api/info` with HTTP Basic auth and switches to `/api`-prefixed requests for OpenCode 2; a
  failed probe, missing password or 401 falls back to v1 with one recorded reason. 401, HTML/SPA
  bodies, non-JSON bodies, other non-2xx responses and network/timeout errors now raise
  `OpenCodeError` instead of returning `undefined`/empty data. The 26 `opencode_*` tool names are
  unchanged; event streaming, permissions/forms, directory scoping and the tool surface remain
  v1-only.
- `lib/config.js`: per-server `apiVersion` option (`auto` | `1` | `2`).
- `lib/sse.js`: subscribes to v1 `/global/event` or v2 `/api/event` (prefix + Basic auth) per
  detected version, consumes canonical events, and reports v2 completion from
  `session.execution.*` instead of `session.idle`. Interaction fallback polling is skipped on v2
  (session-scoped permission/form replies are Phase 3) and no longer leaves transport rejections
  unhandled.
- `lib/delegate.js`: completion kinds `failed`/`interrupted` now reject immediately instead of
  falling through to polling.
- `README.md` / `README.zh.md`: features regrouped by theme (subagent delegation, sessions and
  messages, catalogs and discovery, workspace and git, permissions and events, UI) without
  dropping any documented tool or capability; the documentation index points at the new Chinese
  docs.

## 0.1.0 (2026-11-06)

First milestone release (not published to npm).

### Added

- Multi-server OpenCode configuration (`servers` array) with aggregated discovery.
- Tools: `opencode_sessions`, `opencode_messages`, `opencode_agents`, `opencode_subagent`
  (agent/model/prompt-enforced `schema`, session continuation), `opencode_session_info`,
  `opencode_share`, `opencode_models`, `opencode_commands`, `opencode_skills`, `opencode_tools`,
  `opencode_references`, `opencode_command`, `opencode_shell`, `opencode_git_status`,
  `opencode_git_diff`, `opencode_read_file`, `opencode_find`, `opencode_fork`, `opencode_children`,
  `opencode_summarize`, `opencode_init`, `opencode_progress`, `opencode_search`, `opencode_mcp`,
  `opencode_abort`, `opencode_prompt`.
- Turn-by-turn remote session continuation (`opencode_prompt`, fire-and-forget or wait), so one
  remote worker session can be driven across dsh turns; both entry points share `lib/session-run.js`.
- Attachments via `opencode_subagent` `files` (data-URL file parts; text/* content is also inlined as a
  text part so the model actually sees it); session search (v2 + v1 fallback); MCP server status.
- Live run progress from SSE tool/step events (current tool, elapsed, output tail) exposed via
  `opencode_progress`, `GET /status` and `activeTool` in `GET /list`.
- Delegation completion is now event-driven (SSE `session.idle`) with a slow polling fallback.
- Native dsh subagent provider `opencode-<serverId>` (external out-of-process seam):
  parent-agent attribution for approval/question bridging, `prompt_async` + SSE idle wait,
  idempotent `dispose`, bounded diagnostics; see `docs/subagent-seam.md`.
- Shared session-run lifecycle (`lib/session-run.js`) used by both `opencode_subagent` and the
  native provider: same session creation, interaction tracking, async wait and abort handling.
- Permission requests bridged to dsh approval cards (`permission: ask|allow|reject`), question
  requests bridged to the dsh user-question UI, with polling fallback.
- Per-server SSE (`/global/event`) with reconnect; `/events`, `/status`, `live`/`running` state.
- `prompt_async` + message polling completion wait, falling back to the blocking prompt endpoint.
- Plugin page section "OpenCode Client" (servers, sessions, messages, create session, open UI).
- Embedded OpenCode Web UI as a right-sidebar tab type (`kind: opencode`): per-server selector + iframe of
  the real OpenCode client inside the current session page; opened from a server's "侧边栏打开" button or the
  sidebar add-tab guide. Full-screen overlay and new-tab remain as fallbacks.
- dsh plugin manifest compliance: `engines.dsh`, `dsh.manifestVersion`, bundle patch, client
  declaration, locale metadata, icon, LICENSE, README.zh.
- Offline smoke check: `npm run check` (`scripts/check.mjs`).

### Documentation

- `ARCHITECTURE.md` (module map, data flows, design decisions, feature checklist).
- `docs/subagent-seam.md` (dsh subagent provider contract and optimizations).
- `docs/chat-ui-proposal.md` (in-page remote-session chat proposal).
- README / README.zh documentation index, TODO refresh, compatibility matrix.

### Compatibility

- dsh `0.2.1-rc.2` (declared `>=0.2.1-rc.2`).
- OpenCode `1.18.10`, `1.18.31`, `1.18.33` (v1 HTTP API).

### Known limitations

- Structured output via `format=` is disabled (upstream message-read bug); prompt-enforced JSON only.
- Permission card / question forwarding need a tool-initiated run (a live dsh agent).
- OpenCode 2 and the v2 API are not integrated yet.
