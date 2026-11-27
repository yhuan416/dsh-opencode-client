# Architecture

`dsh-opencode-client` is a dsh plugin (host plugin + Web client bundle) that treats one or
more remote `opencode serve` instances as its backend. It does not reimplement OpenCode;
it is another OpenCode client, hosted in dsh. One install supports both OpenCode 1.18.x
(v1 API) and OpenCode 2.x (v2 API: `/api/*` + HTTP Basic); the version is probed per server
and tools/routes only consume the normalized surface.

## Process / component map

```text
dsh web host process
├── lib/index.js                 wiring: config → services → routes/providers/tools/SSE; probes and logs each server's API version
│   ├── lib/config.js            normalizeServers / normalizeApiVersion / parseModel / parsePathMap
│   ├── lib/http.js              transport: version probe (ensureApiVersion / apiVersionOf), /api prefix (apiPath),
│   │                            Basic auth, OpenCodeError; v2 envelope unwrapping (unwrap / unwrapList /
│   │                            opencodeValue / opencodeRaw / directoryQuery / withLocation)
│   ├── lib/events.js            unified v1/v2 event model: wire format → canonical event, completionKind split
│   ├── lib/sessions.js          normalized read surface: discovery, messages, status, agents, session-info, share, abort,
│   │                            usage/stats and per-directory cost attribution
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP; v2 provider+model,
│   │                            async command, v1-only capabilities
│   ├── lib/workspace.js         shell (v1 sync / v2 async polling), git status/diff, read file, find
│   ├── lib/manage.js            fork, children, summarize/compact, init
│   ├── lib/delegate.js          prompt construction (v1 parts / v2 text+files), extractAssistant, waitAssistant,
│   │                            syncPrompt/asyncPrompt
│   ├── lib/session-run.js       shared lifecycle: ensureSession, prepareTurn, trackRun, sendSessionMessage, abortRemote
│   ├── lib/run.js               opencode_subagent delegation (session= continuation, schema)
│   ├── lib/provider.js          native dsh subagent provider (external backend)
│   ├── lib/interactions.js      remote permission/question → dsh approval / userQuestions
│   │                            (v1 global / v2 session-scoped + forms)
│   ├── lib/sse.js               per-server SSE (v1 /global/event, v2 /api/event); progress, idle listeners, events ring
│   ├── lib/observation.js       (server, session) registry: running/pending/jobs/SSE merged into one status
│   ├── lib/jobs.js              v2 background jobs (`/experimental/job`): work that outlives the turn
│   ├── lib/insights.js          window-scoped fleet insights (stats + session counts) for the board's top area
│   ├── lib/skills.js            per-skill counts: walks messages for `skill` input.id (lazy, cached)
│   ├── lib/version.js          "is a newer OpenCode out?" via the official update service (1 h cache)
│   ├── lib/board.js             shared refresher behind /board, /list row status and opencode_board
│   ├── lib/routes.js            /api/opencode-client/* host HTTP routes
│   └── lib/tools.js             28 model-facing opencode_* tools
└── lib/client.js                browser bundle: "OpenCode Client" plugin-page section

remote machines
└── opencode serve               HTTP API (v1 `/session` etc.; v2 `/api/*` + Basic) + SSE
```

## v1 / v2 split

| Layer | v1 (1.18.x) | v2 (2.x) | Code |
|---|---|---|---|
| Transport / auth | No `/api` prefix; Basic only when `password` is configured | Probe `GET /api/info` (Basic, user `opencode`); once the version is >= 2 every request gets `/api`; a missing password means v1, while 401 / non-JSON / unreachable falls back to v1 with a recorded reason | `http.js` |
| Session read surface | `/global/health`, `/project` (`worktree`), `/session`, `/agent` (`name`/`native`), `/session/status` | `/info`, `/project` (`canonical`), `/session` (`{data,cursor}`, `location.directory`), `/agent` (`id`/`name`/`mode`/`hidden`), `/session/active` | `sessions.js` |
| Messages | `info` + `parts` | `content[]`; fetched with `order=desc` and reversed to oldest-first in the output | `sessions.js` |
| Models / commands / tool discovery | `/config/providers`, `/command`, `/skill`, `/experimental/tool/ids`, `/mcp` | `/provider` + `/model` + `/model/default`, `/command` (name/description only), `/skill` (`path`), no tool ids, `/mcp` (`status` object) | `catalog.js` |
| Delegation / prompts | `parts` + `agent`/`model` on the prompt; `prompt_async`, falling back to the blocking `/message` | `{text,files:[{uri,name}]}`; agent/model are session state (set at creation or via `POST /session/{id}/agent` / `/model`); `/prompt` | `delegate.js`, `session-run.js`, `run.js` |
| Completion | `session.idle` / `session.error` + message polling | `session.execution.succeeded` / `failed` / `interrupted` + the `idle` message `outcome` | `events.js`, `delegate.js` |
| Interactions | global `/permission`, `/question` + `/reply` / `/reject`, driven by SSE events | session-scoped `/session/{sid}/permission/{rid}/reply {decision}`, `/session/{sid}/form` + `/reply {answer}` / `DELETE`; SSE events, with run-scoped polling as the fallback | `interactions.js` |
| Workspace | synchronous `/session/{id}/shell`, `/vcs/*`, `/file/content`, `/find/file`, `/find` | async `/shell` → `/shell/{id}` → `/shell/{id}/output`, `/vcs/*` (`mode=working` / `branch` / `committed`), raw `/fs/read/*`, `/fs/find` (files only) | `workspace.js` |
| Management | `/fork {messageID}`, `/summarize`, `/init`, `/children` | `/fork {before}`, `/compact`, built-in `init` command, `/session?parentID=` | `manage.js` |
| Insights (board top area) | no stats endpoint → unsupported | windowed aggregates from `/experimental/session/stats` (tools=detail) + session counts; daily series is steps-only | `insights.js` |
| Skill usage | no data | walks session messages for `skill` calls and their `input.id` (lazy endpoint, 10-min cache, `truncated` flag) | `skills.js` |
| Upgrade hint | version only (`/api/info`) | latest release from the official update service (the local API has no check endpoint); startup + daily, 24 h cache, failures hide the badge | `version.js` |
| Background jobs | no endpoint | `/experimental/job` (experimental) lists running jobs; the board shows their session as `background` even though `time.idle` is set | `jobs.js`, `observation.js` |
| v1 only | share, tool ids, text find, session todos | no endpoint: explicit error or visible hint, never silent empty data | `sessions.js`, `catalog.js`, `workspace.js` |

The split lands as "normalize the read surface, branch the write paths": `sessions` / `catalog` /
`workspace` / `manage` return one shape, so `tools.js` and `routes.js` never branch on the version;
`delegate.js` and `session-run.js` own the prompt/completion differences; `interactions.js` owns the
interaction protocol; `events.js` maps both wire formats onto the canonical event model.

## Data flows

### Tool / route call (direct operation)

```text
model tool call ──▶ lib/tools.js ──▶ lib/http.js ──▶ opencode HTTP API (remote)
HTTP route call ──▶ lib/routes.js ─┘
```

`http.js` adds the `/api` prefix and Basic header for v2 according to the per-server probe, and
unwraps `{data}` / `{location,data}` / `{data,cursor}` envelopes into payloads (`opencodeValue`);
v2 endpoints that answer raw bytes (`/fs/read/*`) use `opencodeRaw`. tools/routes are version
agnostic; a v2-unsupported endpoint or argument becomes an explicit `OpenCodeError` or tool error
text, never empty data.

Direct calls never involve a remote model: shell commands, file reads, git status/diff,
catalog listings, search, abort, prompt send are deterministic HTTP requests.

### Delegation (agent-mediated)

```text
opencode_subagent / native subagent
  → ensureSession (create or reuse; title "dsh delegate" / "dsh subagent: <label>")
       v2 create: body carries location.directory + agent/model
  → trackRun (activeRuns + interaction bridge + snapshot invalidation)
  → prepareTurn (v2 continuation only: POST /session/{id}/agent and /model write session state)
  → buildPrompt (v1 parts + agent/model; v2 {text, files:[{uri,name}]})
  → v1 POST /session/{id}/prompt_async (falls back to the blocking /session/{id}/message)
    v2 POST /session/{id}/prompt
  → wait: SSE completion events + message-polling safety net (5s with a subscriber, 1.5s without)
       v1 session.idle; v2 session.execution.* / idle message outcome
  → settle: text output / structured; cleanup tracking
```

The native provider (`lib/provider.js`) implements the dsh out-of-process seam
(`start → {id, result, dispose}`) and reuses exactly the same lifecycle as the
`opencode_subagent` tool. See `docs/subagent-seam.md`.

### SSE pipeline

```text
GET /global/event (v1) or /api/event (v2, Basic) per server, reconnect/backoff
  → normalizeEvent (lib/events.js): v1 message.part.* / session.* / permission.* / question.*,
    v2 session.text / reasoning / tool / step / execution.* / permission.* / form.* → canonical event
  → completionKind split: v1 session.idle / session.error; v2 only session.execution.*
  → server.sessionState (running)         → GET /list, /status (v2 /session/active)
  → server.progress (tool, elapsed, tail) → opencode_progress, /progress, activeTool
  → completion listeners (v1 idle; v2 execution.succeeded / failed / interrupted) → delegation wait
  → permission.asked / question.asked (including v2 form.created) → interaction bridge (SSE fast path)
  → the same canonical events also feed the run-scoped watchInteractions poller as a fallback
    (v1 global /permission, /question; v2 session-scoped /session/{sid}/permission, /form)
```

### Interaction bridge

```text
remote permission.asked ──▶ interactions.handlePermission
  ├─ run has a dsh agent + permission: ask → ctx.approval.request
  │    ├ v1 → POST /permission/{id}/reply {reply}
  │    └ v2 → POST /session/{sid}/permission/{rid}/reply {decision: once|always|reject}
  └─ otherwise                            → deterministic allow/reject
remote question.asked (v1) / form.created (v2) ──▶ forward only for tool-initiated runs
  ├ v1 → POST /question/{id}/reply {answers} or /reject
  └ v2 → POST /session/{sid}/form/{fid}/reply {answer:{key:value}}; dismissal is DELETE
```

v2 form fields are typed (`string` / `number` / `integer` / `boolean` / `multiselect`); the reply is
assembled per field `key` into `{key: value}`, and dismissal (reject / user close) is a `DELETE` —
the equivalent of v1's `/question/{id}/reject`.

## Design decisions

| Decision | Rationale |
|---|---|
| Probe the version per server and route every request by it | one install serves v1 and v2; tools/routes never branch on version, and one profile can mix both server generations |
| Normalize read surfaces in `sessions` / `catalog` / `workspace` | the 26 tools consume one shape; version differences stay centralized and testable instead of leaking into tool definitions |
| Use v1 on probe failure / missing password / 401, recording the reason | v1 is stable across tested versions (1.18.10/31/33); the fallback is diagnosable (startup log + `server.versionProbe`) instead of silent |
| Transport failures raise `OpenCodeError`, never degrade to empty data | 401, HTML/SPA, non-JSON, non-2xx and timeouts are explicit errors, so "0 results" cannot mask a real failure |
| Capabilities without a v2 endpoint fail explicitly | share, tool ids, text find and session todos have no replacement endpoint; return a clear error/hint |
| Structured output is prompt-enforced, not `format=` | upstream bug poisons the message read (400 BadRequest) |
| Native subagent provider advertises no capabilities | the remote backend cannot honor `agentOptions`/`outputSchema`/`maxDepth`; refused before start |
| One shared session-run lifecycle | delegate tool and native provider must not drift in timing/abort/cleanup |
| Multi-server aggregation in the client | opencode has no server-side federation |
| Plugin page is read-mostly + open-in-OpenCode | deep interactive editing belongs to the OpenCode UI |

## Adding a feature (checklist)

1. Pure API helper in the matching module (`sessions`/`catalog`/`workspace`/`manage`); keep the
   v1/v2 branches in the module and never put HTTP calls or version checks directly in `tools.js`.
2. Check both generations' path, envelope and directory scoping before adding an endpoint (v2 uses
   `opencodeValue`/`unwrapList`/`withLocation`/`opencodeRaw`), and add a case to
   `test/v2-surface.test.js`.
3. Route in `lib/routes.js` only if the Web page or an external client needs it.
4. Tool in `lib/tools.js` (register via `ctx.effect`; deps passed from `lib/index.js`).
5. Wire in `lib/index.js` if new services/options are needed.
6. Update `scripts/check.mjs` when a new module export should be smoke-checked.
7. Docs: README feature list, CHANGELOG, COMPATIBILITY, TODO checklist.
