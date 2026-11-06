# Changelog

## 0.1.0 (unreleased)

Initial independent release.

### Added

- Multi-server OpenCode configuration (`servers` array) with aggregated discovery.
- Tools: `opencode_sessions`, `opencode_messages`, `opencode_agents`, `opencode_subagent`
  (agent/model/prompt-enforced `schema`, session continuation), `opencode_session_info`,
  `opencode_share`, `opencode_models`, `opencode_commands`, `opencode_skills`, `opencode_tools`,
  `opencode_references`, `opencode_command`, `opencode_shell`, `opencode_git_status`,
  `opencode_git_diff`, `opencode_read_file`, `opencode_find`, `opencode_fork`, `opencode_children`,
  `opencode_summarize`, `opencode_init`, `opencode_progress`, `opencode_search`, `opencode_mcp`,
  `opencode_abort`.
- Attachments via `opencode_subagent` `files` (data-URL file parts; text/* content is also inlined as a
  text part so the model actually sees it); session search (v2 + v1 fallback); MCP server status.
- Live run progress from SSE tool/step events (current tool, elapsed, output tail) exposed via
  `opencode_progress`, `GET /status` and `activeTool` in `GET /list`.
- Delegation completion is now event-driven (SSE `session.idle`) with a slow polling fallback.
- Native dsh subagent provider `opencode-<serverId>` (external out-of-process seam):
  parent-agent attribution for approval/question bridging, `prompt_async` + SSE idle wait,
  idempotent `dispose`, bounded diagnostics; see `docs/subagent-seam.md`.
- Shared session-run lifecycle (`lib/session-run.js`) used by both `opencode_subagent` and the
  native provider: same session creation, interaction tracking, async wait and abort handling.
- Permission requests bridged to dsh approval cards (`permission: ask|allow|reject`), question
  requests bridged to the dsh user-question UI, with polling fallback.
- Per-server SSE (`/global/event`) with reconnect; `/events`, `/status`, `live`/`running` state.
- `prompt_async` + message polling completion wait, falling back to the blocking prompt endpoint.
- Plugin page section "OpenCode Client" (servers, sessions, messages, create session, open UI).
- dsh plugin manifest compliance: `engines.dsh`, `dsh.manifestVersion`, bundle patch, client
  declaration, locale metadata, icon, LICENSE, README.zh.
- Offline smoke check: `npm run check` (`scripts/check.mjs`).

### Compatibility

- dsh `0.2.1-rc.2` (declared `>=0.2.1-rc.2`).
- OpenCode `1.18.10`, `1.18.31`, `1.18.33` (v1 HTTP API).

### Known limitations

- Structured output via `format=` is disabled (upstream message-read bug); prompt-enforced JSON only.
- Permission card / question forwarding need a tool-initiated run (a live dsh agent).
- OpenCode 2 and the v2 API are not integrated yet.