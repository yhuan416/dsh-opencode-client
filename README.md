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
- **Delegation** — tool `opencode_delegate` (new session, or continue with `session=`; optional `agent` and `model`); uses `prompt_async` + message polling with a blocking-prompt fallback
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
    permission: allow            # allow (default) or reject for remote permission prompts
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

## Notes

- The remote OpenCode server must be reachable from the dsh host; `opencode serve` binds
  `127.0.0.1` by default — bind `0.0.0.0` or put it behind an SSH tunnel.
- Session continuation is done through the OpenCode HTTP API; native external subagents still
  execute once (matching Codex/Claude Code backends).
- Interactive questions asked by the remote agent are forwarded to dsh's user-question UI when the
  run was started by `opencode_delegate` (an agent is in scope); otherwise they are rejected.
- **Structured output is disabled** until upstream fixes `GET /session/{id}/message`: after a
  prompt that carries `format: {type:"json_schema"}`, opencode 1.18.x persists a `retryCount`
  field that makes its own message reader return 400 (BadRequest). The plugin therefore does not
  send `format`, to keep sessions readable.
- Permission/question requests are answered while a delegated run is active: SSE events are handled
  immediately, with a 15s polling fallback when the stream is unavailable.
- The plugin page shows `live` (SSE connected) and the number of currently running sessions.