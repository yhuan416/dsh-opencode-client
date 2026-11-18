# Compatibility

This plugin follows **independent semantic versioning** (it does not mirror the dsh release train)
and is **not published to npm** for now; install it from git or a local path.

## dsh compatibility

Declared in `package.json`:

```json
"engines": { "node": ">=22", "dsh": ">=0.2.1-rc.2" }
```

- **Verified against**: dsh `0.2.1-rc.2` (the runtime used in development).
- **Minimum declared**: `0.2.1-rc.2`. dsh 0.1.x is **not supported** (untested).
- The range has no upper bound because the seam surface below has been stable across 0.2.x;
  if a future dsh breaks it, the plugin manager's version-exemption mechanism is the escape hatch.

dsh integration points used (each must exist for the plugin to load):

| Seam | Used for |
|---|---|
| `dsh.manifestVersion: 1`, `dsh.bundle.patch` | profile bundle insertion |
| `dsh.client.platform: "web"`, exports `./client` | plugin page section in the Web UI |
| host `apply(ctx, config)`, `ctx.effect`, `ctx.inject`, `ctx.logger` | plugin lifecycle |
| `ctx.connection.fetch.register(route)` | `/api/opencode-client/*` routes |
| `ctx.tools.register(defineTool(...))` (from `@deepseek-ai/dsh-tools`) | model-facing tools |
| `ctx.subagents.registerProvider(provider)` | native subagent provider `opencode-<id>` |
| `ctx.approval.request(...)` | remote permission → dsh approval card |
| `ctx.userQuestions.ask(...)` | remote question → dsh user-question UI |
| client bundle `window.__ModuleLoader__`, `ctx.slots.inject("plugins.detail.section")` | plugin page section |

## OpenCode compatibility

- **Verified against**: OpenCode `1.18.10`, `1.18.31`, `1.18.33` (all expose the v1 and v2 APIs).
- The plugin uses the **v1 HTTP API** as its baseline:
  `/global/health`, `/global/event` (SSE), `/project`, `/session`, `/session/{id}/message`,
  `/session/{id}/prompt_async`, `/session/{id}/abort`, `/session/{id}/todo`,
  `/session/{id}/diff`, `/session/{id}/share`, `/session/status`, `/permission`,
  `/permission/{id}/reply`, `/question`, `/question/{id}/reply|reject`, `/agent`.
- v2 (`/api/*`): present in 1.18.x; only the transport layer probes/uses it (next bullets).
- **OpenCode 2 — measured 2026-11-18 against `2.3.0`: transport supported, not compatible end to
  end.** The v1 HTTP API is gone
  (the old paths now return the web SPA), the API moved to an authenticated `/api/*` surface, and the
  SSE event taxonomy was rewritten. See
  [docs/opencode-v2-migration.zh.md](docs/opencode-v2-migration.zh.md) for the measured break list,
  affected modules, phased migration plan and tests. The v2 API surface is not migrated yet (only
  the transport probe below).
  OpenCode 2 uses the same `opencode` command and cannot be installed alongside OpenCode 1;
  `opencode serve --help` in v2 describes only the v2 API/web server (no v1 compatibility flag).
- **Transport layer (Phase 1, implemented)**: `lib/http.js` detects the API version per server.
  In `auto` mode (the default) it probes `GET /api/info` with HTTP Basic auth (user `opencode`,
  password from `OPENCODE_SERVER_PASSWORD`); a server that reports OpenCode 2 gets every request
  prefixed with `/api` plus the Basic header, while v1 paths stay untouched. Probe failure, a
  missing password or HTTP 401 falls back to v1 and records one diagnosable reason on
  `server.versionProbe` (logged once at startup). Transport failures — 401, HTML/SPA bodies,
  non-JSON bodies, other non-2xx responses and network/timeout errors — raise `OpenCodeError`
  instead of degrading to empty results. Force a version per server with `apiVersion: 1|2`.
  Event streaming, permissions/forms, directory scoping and the `opencode_*` tool surface are
  **still v1-only**, so OpenCode 2 remains unsupported end to end.

Known upstream issues that shape the integration:

- `format: {type:"json_schema"}` (structured output) persists a `retryCount` field in the user
  message and makes `GET /session/{id}/message` return 400 afterwards (1.18.10 and 1.18.31).
  The plugin therefore uses prompt-enforced JSON (`schema` parameter) instead of `format`.
- Live progress comes from the v1 SSE stream (`message.part.updated`, `message.part.delta`,
  `session.status`, `session.idle`); the v2 `session.next.tool.*` events are not emitted by 1.18.x.
- `POST /api/session/{id}/wait` (v2) returns `503 Session wait is not available yet` on 1.18.31 and
  1.18.33; completion is therefore detected from SSE (`session.idle`/`session.status`) with a polling
  fallback instead of the v2 wait endpoint.
- `GET /experimental/capabilities` reports `backgroundSubagents: false` on 1.18.31.
- Servers are single-tenant and have no server-side federation; multiple servers are aggregated by
  this client.

## Versioning policy

- `0.y.z` while pre-1.0; **minor** bumps add capabilities, **patch** bumps fix bugs/compat.
- Breaking seam/API changes bump the **minor** version and are listed in `CHANGELOG.md`.
- `CHANGELOG.md` records the tested dsh/OpenCode versions per release.