# Architecture

`dsh-opencode-client` is a dsh plugin (host plugin + Web client bundle) that treats one or
more remote `opencode serve` instances as its backend. It does not reimplement OpenCode;
it is another OpenCode client, hosted in dsh.

## Process / component map

```text
dsh web host process
├── lib/index.js                 wiring: config → services → routes/providers/tools/SSE
│   ├── lib/config.js            normalizeServers / parseModel / parsePathMap
│   ├── lib/http.js              opencodeRequest (per-server headers, directory, timeout)
│   ├── lib/sessions.js          discovery, messages, status, agents, session-info, share, abort
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP
│   ├── lib/workspace.js         shell, git status/diff, read file, find
│   ├── lib/manage.js            fork, children, summarize, init
│   ├── lib/delegate.js          promptBody, extractAssistant, waitAssistant, asyncPrompt
│   ├── lib/session-run.js       shared lifecycle: ensureSession, trackRun, sendSessionMessage, abortRemote
│   ├── lib/run.js               opencode_subagent delegation (session= continuation, schema)
│   ├── lib/provider.js          native dsh subagent provider (external backend)
│   ├── lib/interactions.js      remote permission/question → dsh approval / userQuestions
│   ├── lib/sse.js               per-server /global/event stream; progress, idle listeners, events ring
│   ├── lib/routes.js            /api/opencode-client/* host HTTP routes
│   └── lib/tools.js             26 model-facing opencode_* tools
└── lib/client.js                browser bundle: "OpenCode Client" plugin-page section

remote machines
└── opencode serve               HTTP API (v1 baseline) + SSE /global/event
```

## Data flows

### Tool / route call (direct operation)

```text
model tool call ──▶ lib/tools.js ──▶ lib/http.js ──▶ opencode HTTP API (remote)
HTTP route call ──▶ lib/routes.js ─┘
```

Direct calls never involve a remote model: shell commands, file reads, git status/diff,
catalog listings, search, abort, prompt send are deterministic HTTP requests.

### Delegation (agent-mediated)

```text
opencode_subagent / native subagent
  → ensureSession (create or reuse; title "dsh delegate" / "dsh subagent: <label>")
  → trackRun (activeRuns + interaction bridge + snapshot invalidation)
  → POST /session/{id}/prompt_async
  → wait: SSE session.idle (immediate) + 5s message polling fallback
  → settle: text output / stopReason; cleanup tracking
```

The native provider (`lib/provider.js`) implements the dsh out-of-process seam
(`start → {id, result, dispose}`) and reuses exactly the same lifecycle as the
`opencode_subagent` tool. See `docs/subagent-seam.md`.

### SSE pipeline

```text
GET /global/event (per server, reconnect/backoff)
  → parse v1 events: message.part.updated / message.part.delta / session.status / session.idle
  → server.sessionState (running)         → GET /list, /status
  → server.progress (tool, elapsed, tail) → opencode_progress, /progress, activeTool
  → session.idle listeners                → completion wait for delegation
  → permission.asked / question.asked     → interaction bridge (approval card / user question)
```

### Interaction bridge

```text
remote permission.asked ──▶ interactions.handlePermission
  ├─ run has a dsh agent + permission: ask → ctx.approval.request → POST /permission/{id}/reply
  └─ otherwise                            → deterministic allow/reject
remote question.asked  ──▶ forward only for tool-initiated runs (ctx.userQuestions.ask), else reject
```

## Design decisions

| Decision | Rationale |
|---|---|
| v1 HTTP API is the baseline; v2 only where v1 lacks it (session search, fallback) | v1 is stable across tested versions (1.18.10/31/33); v2 `wait` is 503 upstream |
| Structured output is prompt-enforced, not `format=` | upstream bug poisons the message read (400 BadRequest) |
| Native subagent provider advertises no capabilities | the remote backend cannot honor `agentOptions`/`outputSchema`/`maxDepth`; refused before start |
| One shared session-run lifecycle | delegate tool and native provider must not drift in timing/abort/cleanup |
| Multi-server aggregation in the client | opencode has no server-side federation |
| Plugin page is read-mostly + open-in-OpenCode | deep interactive editing belongs to the OpenCode UI |

## Adding a feature (checklist)

1. Pure API helper in the matching module (`sessions`/`catalog`/`workspace`/`manage`);
   never put HTTP calls directly in `tools.js`.
2. Route in `lib/routes.js` only if the Web page or an external client needs it.
3. Tool in `lib/tools.js` (register via `ctx.effect`; deps passed from `lib/index.js`).
4. Wire in `lib/index.js` if new services/options are needed.
5. Update `scripts/check.mjs` when a new module export should be smoke-checked.
6. Docs: README feature list, CHANGELOG, TODO checklist.
