# Architecture

`dsh-opencode-client` is a dsh plugin (host plugin + Web client bundle) that treats one or
more remote `opencode serve` instances as its backend. It does not reimplement OpenCode;
it is another OpenCode client, hosted in dsh. It requires **OpenCode 2.x** (`/api/*` + HTTP
Basic); the version is probed per server, v1 is rejected, and tools/routes consume one
normalized surface. HTTP calls go through the official `@opencode/client` package, pinned to an
exact version (`2.4.2`).

## Process / component map

```text
dsh web host process
├── lib/index.js                 wiring: config → services → routes/providers/tools/SSE; probes and logs each server's API version
│   ├── lib/config.js            normalizeServers / normalizeApiVersion / parseModel / parsePathMap
│   ├── lib/http.js              server probe (ensureApiVersion / apiVersionOf), Basic auth, OpenCodeError,
│   │                            v1 rejection, location helpers
│   ├── lib/oc-client.js         @opencode/client factory per server (id+url+password), call timeout +
│   │                            error mapping (ocCall / resetOcClients)
│   ├── lib/events.js            v2 event model: wire format → canonical event, completionKind
│   ├── lib/sessions.js          normalized read surface: discovery, messages, status, agents, session-info, share, abort,
│   │                            usage/stats and per-directory cost attribution
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP
│   ├── lib/workspace.js         async shell (submit/poll/read), git status/diff, read file, find
│   ├── lib/manage.js            fork, children, summarize/compact, init
│   ├── lib/delegate.js          prompt construction ({text, files}), extractAssistant, waitAssistant,
│   │                            syncPrompt/asyncPrompt
│   ├── lib/session-run.js       shared lifecycle: ensureSession, prepareTurn, trackRun, sendSessionMessage, abortRemote
│   ├── lib/run.js               opencode_subagent delegation (session= continuation, schema)
│   ├── lib/provider.js          native dsh subagent provider (external backend)
│   ├── lib/interactions.js      remote permission/form → dsh approval / userQuestions
│   ├── lib/sse.js               per-server SSE (/api/event); progress, idle listeners, events ring
│   ├── lib/observation.js       (server, session) registry: running/pending/jobs/SSE merged into one status;
│   │                            a fresh session listing prunes rows deleted while the stream was down
│   ├── lib/pending-text.js      one-line text for a pending permission/form (single implementation)
│   ├── lib/snapshot.js          invalidate a server's cached session listing (+ epoch vs in-flight)
│   ├── lib/jobs.js              v2 background jobs (`/experimental/job`): work that outlives the turn
│   ├── lib/insights.js          windowed fleet insights + 30-day daily activity (sessions/tokens/steps)
│   ├── lib/skills.js            per-skill counts: walks messages for `skill` input.id (lazy, cached)
│   ├── lib/version.js          "is a newer OpenCode out?" via the official update service (1 h cache)
│   ├── lib/about.js             own version/repository + GitHub release check (About block, 24 h cache)
│   ├── lib/board.js             shared refresher behind /board, /list row status and opencode_board
│   │                            (fresh listing → observation.retain)
│   ├── lib/routes.js            /api/opencode-client/* host HTTP routes
│   └── lib/tools.js             28 model-facing opencode_* tools
└── lib/client.js                browser bundle: "OpenCode Client" plugin-page section

remote machines
└── opencode serve               OpenCode 2 HTTP API (`/api/*` + Basic) + SSE
```

## OpenCode 2 surface

| Layer | OpenCode 2 | Code |
|---|---|---|
| Transport / auth | Probe `GET /api/info` (Basic, user `opencode`); calls go through `@opencode/client` (`2.4.2`); a v1 answer is rejected with `opencode.v1_unsupported` | `http.js`, `oc-client.js` |
| Session read surface | `/info`, `/project` (`canonical`), `/session` (`{data,cursor}`, `location.directory`), `/agent` (`id`/`name`/`mode`/`hidden`), `/session/active` | `sessions.js` |
| Messages | `content[]`; paged with `cursor` (first page `order=desc`), reversed to oldest-first in the output | `sessions.js` |
| Models / commands / tool discovery | `/provider` + `/model` + `/model/default`, `/command`, `/skill`, `/mcp` (`status` object); no tool-ids endpoint | `catalog.js` |
| Delegation / prompts | `{text,files:[{uri,name}]}`; agent/model are session state (set at creation or via `/session/{id}/agent` / `/model`); `/prompt` | `delegate.js`, `session-run.js`, `run.js` |
| Completion | `session.execution.succeeded` / `failed` / `interrupted` + the `idle` message `outcome` | `events.js`, `delegate.js` |
| Interactions | session-scoped `/session/{sid}/permission/{rid}/reply {decision}`, `/session/{sid}/form` + `/reply {answer}` / `DELETE`; SSE events, with run-scoped polling as the fallback | `interactions.js` |
| Workspace | async `/shell` → `/shell/{id}` → `/shell/{id}/output`, `/vcs/*` (`mode=working` / `branch` / `committed`), raw `/fs/read`, `/fs/find` (files only) | `workspace.js` |
| Management | `/fork {before}`, `/compact`, built-in `init` command, `/session?parentID=` | `manage.js` |
| Insights (board top area) | windowed aggregates from `/experimental/session/stats` (tools=detail) + session counts; daily series is steps-only | `insights.js` |
| Skill usage | walks session messages for `skill` calls and their `input.id` (lazy endpoint, 10-min cache, `truncated` flag) | `skills.js` |
| Upgrade hint | latest release from the official update service (the local API has no check endpoint); startup + daily, 24 h cache, failures hide the badge | `version.js` |
| Background jobs | `/experimental/job` (experimental) lists running jobs; the board shows their session as `background` even though `time.idle` is set | `jobs.js`, `observation.js` |
| Removed v1 endpoints | no share/tool-ids endpoints; text find and todos restored via v2-native fallbacks (workspace `grep`; todos from `todowrite`) | `sessions.js`, `catalog.js`, `workspace.js` |

Read surfaces are normalized in `sessions` / `catalog` / `workspace` / `manage`, so `tools.js` and
`routes.js` never branch on the API version. `delegate.js` and `session-run.js` own prompt and
completion handling; `interactions.js` owns the interaction protocol; `events.js` maps the v2 wire
format onto the canonical event model.

## Data flows

### Tool / route call (direct operation)

```text
model tool call ──▶ lib/tools.js ──▶ lib/oc-client.js ──▶ @opencode/client ──▶ opencode HTTP API
HTTP route call ──▶ lib/routes.js ──┘
```

`oc-client.js` caches one client per server (id + url + password), applies a per-call timeout and
maps client failures to `OpenCodeError`; `@opencode/client` owns paths, Basic auth and response
envelopes. `http.js` still probes `/api/info`, adds Basic auth for the few diagnostic calls and
rejects v1. tools/routes are version agnostic; an unsupported endpoint or argument becomes an
explicit `OpenCodeError` or tool error text, never empty data.

Direct calls never involve a remote model: shell commands, file reads, git status/diff,
catalog listings, search, abort, prompt send are deterministic HTTP requests.

### Observe page (board + insights) data flow

```text
client scheduler (1s tick, keyed, priority, max 3, heavy serial)
  ├─ board store   5s: refresh=1 every 3rd tick, else refresh=0 (host observation snapshot)
  │                dedupe payload → no notify when nothing changed
  ├─ insights      120s  /insights?days=N     (SWR 60s, warmed at boot)
  ├─ activity      600s  /insights/activity   (per-day cache; past days immutable)
  ├─ skills        600s  /insights/skills     (heavy, starts after insights)
  └─ usage/about   120s / 1h

first paint: skeleton + equal-height placeholders (asyncSlot / boardSkeleton from the
last board shape in localStorage); below-the-fold blocks mount via LazyRender
(IntersectionObserver, 400px margin) instead of building their DOM on mount.

routes.js wraps the history scans in lib/swr.js (stale-while-revalidate, single flight);
lib/warm.js pre-warms board / insights(7d) / activity(30d) after the first probe;
lib/insights.js keeps per-(server,day) activity aggregates (past days for the process
lifetime, today 60s); lib/sessions.js single-flights collectStats per server.
```

Debug: `localStorage.setItem("dsh-oc-perf", "1")` + reload exposes `window.__dshOcPerf`
(`marks`, `longTasks`, `slowFrames`, `dump()`); off by default.

### Delegation (agent-mediated)

```text
opencode_subagent / native subagent
  → ensureSession (create or reuse; title "dsh delegate" / "dsh subagent: <label>")
       create carries location.directory + agent/model
  → trackRun (activeRuns + interaction bridge + snapshot invalidation)
  → prepareTurn (continuation: POST /session/{id}/agent and /model write session state)
  → buildPrompt ({text, files:[{uri,name}]})
  → POST /session/{id}/prompt
  → wait: SSE completion events + message-polling safety net (5s with a subscriber, 1.5s without)
       session.execution.* / idle message outcome
  → settle: text output / structured; cleanup tracking
```

The native provider (`lib/provider.js`) implements the dsh out-of-process seam
(`start → {id, result, dispose}`) and reuses exactly the same lifecycle as the
`opencode_subagent` tool. See `docs/subagent-seam.md`.

### SSE pipeline

```text
GET /api/event (Basic) per server, reconnect/backoff
  → normalizeEvent (lib/events.js): session.text / reasoning / tool / step / execution.* /
    permission.* / form.* → canonical event
  → completionKind: session.execution.* only
  → server.sessionState (running)         → GET /list, /status (/session/active)
  → server.progress (tool, elapsed, tail) → opencode_progress, /progress, activeTool
  → completion listeners (execution.succeeded / failed / interrupted) → delegation wait
  → permission.asked / form.created → interaction bridge (SSE fast path)
  → the same canonical events also feed the run-scoped watchInteractions poller as a fallback
    (session-scoped /session/{sid}/permission, /form)
```

### Interaction bridge

```text
remote permission.asked ──▶ interactions.handlePermission
  ├─ run has a dsh agent + permission: ask → ctx.approval.request
  │    └ POST /session/{sid}/permission/{rid}/reply {decision: once|always|reject}
  └─ otherwise                            → deterministic allow/reject
remote form.created ──▶ forward only for tool-initiated runs
  └ POST /session/{sid}/form/{fid}/reply {answer:{key:value}}; dismissal is DELETE
```

Form fields are typed (`string` / `number` / `integer` / `boolean` / `multiselect`); the reply is
assembled per field `key` into `{key: value}`, and dismissal (reject / user close) is a `DELETE`.

## Design decisions

| Decision | Rationale |
|---|---|
| Require OpenCode 2 and reject v1 at the transport | one supported generation keeps the read surface small; an old server fails with an actionable error instead of silently degrading |
| Normalize read surfaces in `sessions` / `catalog` / `workspace` | all tools consume one shape; API differences stay centralized and testable instead of leaking into tool definitions |
| Pin `@opencode/client` to an exact version | upgrades are deliberate: compatibility is verified, then the pin is bumped and released independently |
| Probe once and record failures | a 401 means a bad password; other failures are diagnosable (startup log + `server.versionProbe`) instead of silent |
| Transport failures raise `OpenCodeError`, never degrade to empty data | 401, HTML/SPA, non-JSON, non-2xx and timeouts are explicit errors, so "0 results" cannot mask a real failure |
| Capabilities without a v2 endpoint fail explicitly | share, tool ids, text find and session todos have no replacement endpoint; return a clear error/hint |
| Structured output is prompt-enforced, not `format=` | schemas stay portable across models; result is validated locally |
| Native subagent provider advertises no capabilities | the remote backend cannot honor `agentOptions`/`outputSchema`/`maxDepth`; refused before start |
| One shared session-run lifecycle | delegate tool and native provider must not drift in timing/abort/cleanup |
| Multi-server aggregation in the client | opencode has no server-side federation |
| Plugin page is read-mostly + open-in-OpenCode | deep interactive editing belongs to the OpenCode UI |

## Adding a feature (checklist)

1. Pure API helper in the matching module (`sessions`/`catalog`/`workspace`/`manage`); use
   `ocCall` + `@opencode/client`, and never put HTTP calls or version checks directly in `tools.js`.
2. Check the OpenCode 2 path, envelope and directory scoping before adding an endpoint, and add a
   case to `test/v2-surface.test.js`.
3. Route in `lib/routes.js` only if the Web page or an external client needs it.
4. Tool in `lib/tools.js` (register via `ctx.effect`; deps passed from `lib/index.js`).
5. Wire in `lib/index.js` if new services/options are needed.
6. Update `scripts/check.mjs` when a new module export should be smoke-checked.
7. Docs: README feature list, CHANGELOG, COMPATIBILITY, TODO checklist.
