# dsh-opencode-client

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that acts as an
**OpenCode client**: it connects to one or more remote `opencode serve` instances and exposes their
projects, sessions and messages to dsh, delegates tasks into them, and registers OpenCode as a
native dsh subagent backend.

> OpenCode's own architecture: `opencode serve` exposes an OpenAPI HTTP server "that an opencode
> client can use"; the TUI/web/SDK are clients. This plugin is another client, hosted in dsh.

## Features

- **Server configuration** — `servers: [{ id, label?, url, password?, directory? }]`
- **Discovery** — `GET /api/opencode-client/list` (server health, projects, sessions grouped by directory)
- **Session listing** — tool `opencode_sessions` + `GET /api/opencode-client/sessions`
- **Session messages** — tool `opencode_messages` + `GET /api/opencode-client/messages`
- **Agent catalog** — tool `opencode_agents` + `GET /api/opencode-client/agents` (primary/subagent, native/custom)
- **Delegation** — tool `opencode_delegate` (new session, or continue with `session=`; optional `agent`, `model` and prompt-enforced `schema`); uses `prompt_async` + message polling with a blocking-prompt fallback
- **Session info** — tool `opencode_session_info` (title/summary/todos/diff) and `opencode_share` (share/unshare link)
- **Catalogs** — `opencode_models` (providers/models, credentials stripped), `opencode_commands`, `opencode_skills`, `opencode_tools`, `opencode_references`
- **Command execution** — `opencode_command` runs a remote command (e.g. `init`) inside a session
- **Workspace ops** — `opencode_shell`, `opencode_git_status`, `opencode_git_diff`, `opencode_read_file`, `opencode_find`
- **Session management** — `opencode_fork`, `opencode_children`, `opencode_summarize` (mutating), `opencode_init` (writes AGENTS.md, requires confirm=true)
- **Permission approval** — `permission: ask` (default) turns remote permission requests into dsh approval cards; `allow`/`reject` answer deterministically
- **Live events** — per-server SSE subscription (`/global/event`) with reconnect; fast permission/question handling, live state, `GET /api/opencode-client/events` and `/status`
- **Native subagent** — provider `opencode-<serverId>`; pair with `@deepseek-ai/dsh-tool-subagent`
- **Plugin page** — "OpenCode Client" section: servers/workspaces/sessions, messages, create session, open OpenCode UI

## Install (profile)

```sh
dsh plugin --profile web add /path/to/dsh-opencode-client
```

or add it manually to the profile and select it as a bundle:

```json
{
  "dependencies": { "dsh-opencode-client": "file:/path/to/dsh-opencode-client" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-opencode-client"] } }
}
```

## Configuration

```yaml
- id: opencode-client
  name: dsh-opencode-client
  config:
    servers:
      - id: n100
        label: n100 opencode
        url: http://192.168.4.50:4096
        # password: xxx          # OPENCODE_SERVER_PASSWORD (basic auth, user "opencode")
        # directory: /home/yhuan/workspace   # default remote dir when the caller does not give one
        # agent: plan            # default OpenCode agent for delegation
        # model: deepseek/deepseek-chat      # default model "provider/model"
      - id: m65
        label: 4.65 opencode
        url: http://192.168.4.65:4096
    permission: ask              # ask (default, dsh approval card) | allow | reject
    question: reject             # reject (default) interactive questions or "ignore" them
    pathMap:                     # only when local and remote path layouts differ
      - { from: /home/yhuan, to: /home/yhuan }
```

To expose an OpenCode server as a native dsh subagent, add a tool row:

```yaml
- insert:
    - id: tool-opencode-n100
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: opencode-n100   # "opencode-" + server id
        maxDepth: provider-managed
        toolName: subagent_n100
```

## Compatibility & versioning

See [COMPATIBILITY.md](COMPATIBILITY.md). The plugin follows independent semantic versioning, is
verified against dsh `0.2.1-rc.2` and OpenCode `1.18.10/1.18.31/1.18.33`, and is not published to
npm for now (install from git or a local path).

## Notes

- The remote OpenCode server must be reachable from the dsh host; `opencode serve` binds
  `127.0.0.1` by default — bind `0.0.0.0` or put it behind an SSH tunnel.
- Session continuation is done through the OpenCode HTTP API; native external subagents still
  execute once (matching Codex/Claude Code backends).
- Interactive questions asked by the remote agent are forwarded to dsh's user-question UI when the
  run was started by `opencode_delegate` (an agent is in scope); otherwise they are rejected.
- **Structured output is prompt-enforced, not `format=`-enforced**: opencode 1.18.x has an upstream
  bug — after a prompt carrying `format: {type:"json_schema"}`, it persists a `retryCount` field
  that makes `GET /session/{id}/message` return 400 (BadRequest), poisoning the session. The plugin
  therefore appends a "return only JSON matching this schema" instruction and validates the result
  locally (`schema` parameter), leaving the session readable.
- **Permission cards need a tool-initiated run**: approval bridging uses the calling agent; a
  delegation started over the HTTP endpoint (no agent in scope) falls back to `allow`/`reject`.
- **Multiple servers** are configured as an array and aggregated by the client (opencode itself has
  no server-side federation).
- Permission/question requests are answered while a delegated run is active: SSE events are handled
  immediately, with a 15s polling fallback when the stream is unavailable.
- The plugin page shows `live` (SSE connected) and the number of currently running sessions.