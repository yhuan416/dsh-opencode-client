# dsh subagent seam vs. dsh-opencode-client

This note records how the plugin plugs into dsh's native subagent framework
(`ctx.subagents.registerProvider`), what the seam actually requires, and which
optimizations were applied or deliberately skipped.

## 1. The seam (dsh 0.2.1-rc.2)

A provider is a plain object:

```js
{
  name,                       // unique provider name
  capabilities: {             // parent-enforced start features it can honor
    agentOptions, agentPreset, outputSchema, depthLimit
  },
  inheritsParentContext,      // does the child see the parent's completed turns?
  start(request) { ... },     // external backend
  // or
  prepareContinuable(request) { ... }, // local backend (in-process Agent)
}
```

External backend `start(request)` must return `{ id, result, dispose }`:

- `id` — the child id (durable identity used by the runtime and settlement notice)
- `result` — a promise that **never rejects**; resolves to
  `{ output: ContentBlock[], stopReason, structured?, diagnostic? }` where
  `stopReason` is `completed | aborted | max-tokens | refusal | error`
- `dispose()` — idempotent teardown: cancel the child, then await its exit

`request` carries `prompt` (ContentBlock[]), `cwd` (absolute), `label`,
`parent` (the exact dsh parent Agent), `signal`, and — only when the provider
advertises the matching capability — `agentOptions`, `agentPreset`,
`outputSchema`, `maxDepth`. The service rejects an unsupported capability
**before** `start` runs, never accepts-and-ignores.

The model-facing tool is `@deepseek-ai/dsh-tool-subagent` configured per
provider; it starts an activation and returns the child id immediately. The
runtime delivers the settlement notice (summary + closing text + optional
structured result + diagnostic) into the parent conversation.

## 2. Our mapping

| dsh seam | dsh-opencode-client |
|---|---|
| provider name | `opencode-<serverId>` |
| `capabilities` | all `false` (remote cannot honor them) |
| `inheritsParentContext` | `false` — remote agent never sees the dsh transcript |
| `start` | create OpenCode session (title = label, directory = mapped cwd) → `prompt_async` → wait for the assistant message |
| `id` | the remote session id |
| `result.output` | assistant text blocks |
| `result.stopReason` | `completed` / `aborted` / `error` (diagnostic ≤ 4096 bytes) |
| `dispose` | abort controller + `POST /session/{id}/abort`, await settlement (memoized) |
| `agentOptions` / `agentPreset` | not supported: dsh route/model names do not map to OpenCode providers/models |
| `outputSchema` | not supported by the tool's external path; the separate `opencode_delegate` tool implements prompt-enforced schema |
| `depthLimit` | not supported remotely; tool rows use `maxDepth: provider-managed` |
| continuation / `send_message` steering | not supported: external backend is one-shot by design |

## 2.1 Shared lifecycle with the delegate tool

`opencode_delegate` and the native provider both go through `lib/session-run.js`:

- `ensureSession` — reuse the session id or create one with the same title semantics
- `trackRun` — one active-run entry (server, directory, parent agent, signal) plus the
  interaction bridge (`watchInteractions`) and snapshot invalidation
- `abortRemote` — best-effort `POST /session/{id}/abort`

Both then use the same `prompt_async` + SSE idle wait from `lib/delegate.js`, so timing,
abort and cleanup behavior cannot drift between the two entry points.

## 3. Optimizations applied

1. **Parent-agent attribution.** `activeRuns` entries now carry `agent` = the dsh
   parent Agent. Approval cards (`ctx.approval.request`) and user questions
   (`ctx.userQuestions.ask`) from native `subagent_*` runs now reach the right
   agent; previously they fell back to plain allow/reject because `run.agent`
   was missing.
2. **Event-driven wait.** The provider no longer holds a blocking
   `POST /session/{id}/message` for up to an hour; it uses the same
   `prompt_async` + SSE `session.idle` wait (with a polling fallback) as
   `opencode_delegate`, so long runs survive idle proxies and match the
   delegate path's timing/abort semantics.
3. **Idempotent dispose.** Repeated `dispose()` returns the same promise, as the
   seam requires; teardown aborts the remote session and awaits settlement.
4. **Clearer failures.** Session-creation failures include the mapped directory;
   diagnostics are bounded before returning.
5. **Identifiable native sessions.** Provider sessions are titled
   `dsh subagent: <label>`; the plugin page shows session ids and the active tool of
   running servers, so a settlement notice's child id can be matched to a listed
   session without any new UI flow.

## 4. Deliberately not done

- **Continuable child** (`prepareContinuable`) would require the child to be a
  local dsh Agent; an external OpenCode session cannot be resumed by dsh.
  `opencode_delegate` covers continuation via `session=`.
- **Child model selection** (`agentOptions`) would map dsh LLM routes onto
  OpenCode provider/model ids; the two catalogs are unrelated, so advertising it
  would be dishonest.
- **Remote depth enforcement** — the recursion budget stays in dsh's
  provider-managed mode.

## 5. Verification

Direct seam test against a live OpenCode server (`n100`, 1.18.31):

```text
name: opencode-n100 capabilities: {"agentOptions":false,"agentPreset":false,"outputSchema":false,"depthLimit":false}
run id: ses_e5047ca1cffe7bw1... | activeRuns.agent is parent: true
result: {"stopReason":"completed","text":"provider-ok"}
dispose idempotent: true
```

Abort path (task runs `sleep 120`):

```text
started: ses_e5047bbedffePCUY...
dispose+result took 0.0s | stopReason: aborted
```