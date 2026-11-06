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
- v2 (`/api/*`) is present in 1.18.x but **not used yet**; see `TODO.md`.
- OpenCode 2 (separate major release) is **not tested**. It uses the same `opencode` command and
  cannot be installed alongside OpenCode 1; treat it as unsupported until verified.

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