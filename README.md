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
- **Delegation** — tool `opencode_delegate` (new session, or continue with `session=`)
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
    permission: allow            # allow (default) or reject for remote permission prompts
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
