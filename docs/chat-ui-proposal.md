# Proposal: remote-session chat in the plugin page

Status: proposal (not implemented). This note describes what an in-page chat against a remote
OpenCode session could look like, which existing pieces it reuses, and how much work each phase is.

## Goal

Let the user stay inside the dsh Web UI and converse with a remote OpenCode session turn by turn —
instead of switching to the OpenCode TUI/Web for every follow-up, or delegating a whole task and
waiting for a blocking result.

This is **session bridging** (message list + input + live updates), not a replacement for the
OpenCode UI: remote execution, permissions, questions and files all stay on the OpenCode side.

## Wireframe

```text
┌ OpenCode Client ─────────────────────────────────────────────────────────────┐
│ n100  v1.18.31  live  · 2 running · bash                                       │
│   /home/yhuan/workspace/gitlab   [新建会话]                                    │
│     · 日志查11.5 App回放失败  · ses_xxx  [聊天] [内嵌打开] [新标签]             │
│     · dsh subagent: api probe · ses_yyy  [聊天] ...                           │
│                                                                              │
│ ── chat: ses_xxx @ n100 ──────────────────────────────────────────────────── │
│  [user]      刚才让你记住的数字是多少？           2026-11-06 15:52           │
│  [assistant] 7391                                                           │
│  [tool]      bash completed · 1.2s · git status                              │
│                                                                              │
│  [消息输入框                                        ] [发送] [发送并等待]     │
│  [中止] [重新加载] [打开 OpenCode 原生界面]        progress: bash (3s) tail…  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Reused pieces (no new backend needed for MVP)

Everything below already exists in the plugin:

| Need | Existing API |
|---|---|
| session list / pick session | `GET /api/opencode-client/list`, `/sessions`, `/search` |
| message history | `GET /api/opencode-client/messages` |
| send one message (non-blocking) | `POST /api/opencode-client/prompt` |
| send and wait for this turn | `POST /api/opencode-client/prompt` (`wait=true`) |
| live status / current tool | `GET /api/opencode-client/progress`, `/status`, `/list.activeTool` |
| abort | `POST /api/opencode-client/abort` |
| permissions / questions | existing approval-card and user-question bridge (SSE) |
| open native UI | `server.url + "/session/" + sessionId` (deep link) |

So the MVP is **client-only** (`lib/client.js`) plus one small helper: a combined poll endpoint
(or two existing calls per tick is fine).

## Phases

### Phase 1 — MVP (polling, client-only)

- Add a "聊天" button per session; show a chat pane in the same plugin page section.
- On select: load last N messages, render text + tool/file parts, show session title/model.
- Input box: `发送` (`prompt` wait=false), `发送并等待` (wait=true), `中止`.
- Poll every 1.5–2s while the pane is open: messages (incremental) + progress; stop polling when
  the remote reports idle for a few ticks.
- Deep-link button: open `server.url/session/<id>` in the embedded iframe (or new tab).

Effort: roughly 150–250 lines in `lib/client.js`; no host changes required. Latency: 1.5–2s
between a remote reply and it appearing (acceptable for "remote worker" usage, not for
pairing on a single word).

### Phase 2 — streaming

- Add a host SSE proxy route (`GET /api/opencode-client/stream?server=&session=`) that forwards
  the existing per-server SSE (already parsed in `lib/sse.js`) as `text/event-stream`.
- Page uses `EventSource` to render `message.part.delta` text and tool state without polling.
- Benefits: near-real-time text, lower request volume; still no change to OpenCode.

### Phase 3 — extras (optional)

- Attachments in the page: file picker → base64 → `files` field of the prompt tool.
- Minimal markdown rendering (code blocks, lists) for assistant messages.
- Inline permission cards in the chat pane (in addition to dsh approval cards).
- "Start new session here" from the current workspace.

## Limits / honest trade-offs

- Remote agent is still the executor; the page is a client, not an IDE.
- Remote does not see the dsh conversation; context must be in the messages.
- Phase 1 has polling latency; phase 2 fixes it but adds an SSE proxy route.
- Approvals still use dsh's approval UI; the page only shows that a permission is pending.

## Decision

Recommended order: finish the milestone docs, then do Phase 1 if "stay in dsh while talking to a
remote session" is a real daily need; Phase 2 only if the polling latency feels annoying in use.
