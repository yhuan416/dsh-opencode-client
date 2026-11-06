# TODO — dsh-opencode-client

> dsh 作为 OpenCode server 的客户端：会话列表/读取/继续、委派、原生 subagent、SSE 实时、多 server 聚合。
> 本文档只记录"还没做/要做"的内容；已完成能力见 README，架构见 ARCHITECTURE.md。
>
> **当前里程碑：v0.1.0（2026-11-06）** —— P1–P5 完成；剩余为上游阻塞项、明确暂缓项和 P6 提案。

## 0. 已完成（基线）

- [x] server 配置（url / password / directory / agent / model），多 server 数组聚合
- [x] 会话列表 / 搜索过滤 / 消息读取（text + tool + file parts）
- [x] 委派（新建 / `session=` 续用 / `agent` / `model` / prompt 级 `schema` 校验）
- [x] 原生 subagent provider（`opencode-<serverId>`）
- [x] 权限审批卡（`permission: ask`）、question 转发到 dsh
- [x] SSE 实时事件（permission/question 快速应答、live/running 状态）
- [x] `prompt_async` + 消息轮询等待（回退阻塞 prompt）
- [x] session-info（title/summary/todo/diff）、share/unshare
- [x] 插件页「OpenCode Client」
- [x] 共享运行生命周期 `lib/session-run.js`（delegate 与原生 provider 复用）
- [x] `opencode_prompt` 回合制续聊（远端会话跨 dsh 回合存活）
- [x] 工具进度 / SSE idle 完成等待 / abort
- [x] 26 个 `opencode_*` 模型工具（会话 58 工具）

## 1. P0 — 上游阻塞（等 opencode 修复）

- [ ] 结构化输出：opencode 1.18.x 的 `format: {type:"json_schema"}` 会把 `retryCount` 持久化进 user message，之后 `GET /session/{id}/message` 返回 400（会话"毒化"）。
      → 已改用 prompt 约束 + 本地校验（`schema` 参数）；等上游修复后恢复真 format。
- [ ] OpenCode 2 的 policies（`experimental.policies`）只在 2.x 生效；1.x 不读。
- [ ] 后台子代理：1.18.31 的 `experimental/capabilities` 仍是 `backgroundSubagents: false`。

## 2. P1 — 客户端目录能力（只读，低风险）

- [x] `opencode_models`：`GET /config/providers`，列出 provider/model（凭据字段已剔除）；delegate 的 `model` 参数不做强校验。
- [x] `opencode_commands`：`GET /command` 列出自定义命令（/init、/review 等）。
- [x] `opencode_command`：`POST /session/{id}/command` 在远端会话执行命令。
- [x] `opencode_skills`：`GET /skill` 列出远端 skills（内容省略）。
- [x] `opencode_references`：`GET /api/reference`（v2）列出项目 references。
- [x] `opencode_tools`：`GET /experimental/tool/ids` 列出远端可用工具。

验收：新会话工具列表可见；只读调用不改变远端状态。

## 3. P2 — 验证闭环（中高价值）

- [x] `opencode_shell`：`POST /session/{id}/shell` 在远端会话跑 shell 命令（确定性执行，不跑完整 agent）。
- [x] `opencode_read_file`：`GET /file/content` 读远端文件。
- [x] `opencode_find`：`GET /find/file`、`/find`（文本搜索）搜索。
- [x] `opencode_git_status` / `opencode_git_diff`：`GET /vcs/status`、`/vcs/diff`（摘要，patch 可选，避免大仓库 raw diff 爆炸），委派后验收"改了什么"。

验收：委派 → diff 核对 → 必要时再委派修复，形成闭环。

## 4. P3 — 会话管理（mutating，需确认）

- [x] `opencode_fork`：`POST /session/{id}/fork`
- [x] `opencode_summarize`：`POST /session/{id}/summarize`（需 provider/model）
- [x] `opencode_init`：`POST /session/{id}/init`（写 AGENTS.md，需 confirm=true）
- [ ] `opencode_revert` / `opencode_unrevert`：暂不开放（高风险；后续加审批卡再启用）
- [x] `opencode_children`：`GET /session/{id}/children`
- [x] `opencode_prompt`：`POST /session/{id}/prompt_async`，回合制续聊（默认非阻塞，`wait=true` 等本轮结束）——远端会话不再只能"一次性"用
- [ ] 消息 part 编辑/删除（`PATCH/DELETE .../part/{id}`）——**暂缓：低频、且可绕过（重开/分叉）**

## 5. P4 — 权限/实时增强

- [x] 工具进度事件（v1 SSE `message.part.updated`/`session.status`/`session.idle`）→ `opencode_progress`、`GET /progress`、`/status` 的 tool/progress/tail、`/list` 的 `activeTool`。v2 `session.next.tool.*` 在 1.18.x 不发，已按 v1 实现。
- [x] 完成等待改为 **SSE `session.idle` 事件驱动** + 5s 轮询兜底（原 1.5s 纯轮询）。
- [x] 流式文本 tail：`message.part.delta` 记录 400 字符（未做完整流式渲染，够用于进度展示）。
- [ ] v2 `POST /api/session/{id}/wait`：**上游不可用**——1.18.31/1.18.33 实测 503 `Session wait is not available yet`，已由 SSE wait 替代。
- [ ] saved permissions 查看/删除——**暂缓：本地审批卡已覆盖交互，远端规则管理属低频诊断**
- [ ] 读远端 `GET /config` 的 permission 配置——**暂缓：本地档位已够用**
- [ ] v2 `delivery: steer|queue`、`resume`——**暂缓：一发式委派，无并发插话需求**
- [x] `opencode_abort`：`POST /session/{id}/abort`，取消远端长任务；等待中的委派会以 abort 错误返回（不再干等超时）。

## 5.5 P6 — 插件页远端会话聊天（提案，暂缓）

> **暂缓原因（2026-11-06）**：定位收敛为"subagent 核心 + 原生 OpenCode UI 嵌入入口"。
> 聚合工作台 / 自研聊天页 / LLM 桥接都暂不做；完整交互使用嵌入的 OpenCode 原生 Web UI。


见 [docs/chat-ui-proposal.md](docs/chat-ui-proposal.md)。

- [ ] Phase 1（MVP，仅 client）：会话级「聊天」按钮 + 消息渲染 + 输入框（`prompt`，`wait` 可选）+ 1.5–2s 轮询 + 中止 + OpenCode 深链
- [ ] Phase 2：宿主 SSE 代理（`/stream`）+ 页面 EventSource，渲染 delta/工具状态
- [ ] Phase 3（可选）：页面内附件、markdown、内联权限卡

## 6. P5 — 可选

- [x] MCP 只读列表/状态：`opencode_mcp` → `GET /mcp`（connect/disconnect/auth 仍不做）
- [ ] PTY 远端终端——**暂缓：需要 WebSocket 客户端交互，当前没有；`opencode_shell` 已覆盖确定性命令**
- [x] 附件发送：`opencode_subagent` 的 `files` JSON 数组（text/base64 → data URL FilePartInput），单文件 ≤5MB
- [x] 会话搜索：`opencode_search` → v2 `/api/session?search=`，v1 列表过滤兜底

## 7. 不做（边界）

- 替远端改配置：agents / models / providers / MCP / plugins / credentials / policies
- TUI 控制（`/tui/*`）、IDE/Web 替代客户端
- GitHub / GitLab CI 集成
- ACP（openCode 作为 ACP agent 被编辑器接，方向不同）
- 多 server 的服务端联邦（opencode server 本身不支持，只能客户端聚合——我们已这样做）

## 8. 工程/规范化整理（待办）

对照 dsh 插件约定（`dsh-package-manifest` / `dsh-app-boot` / `dsh-client-modules`）：

- [x] `package.json`：补 `engines.dsh`（如 `>=0.2.1-rc.2`）、`dsh.manifestVersion: 1`、`main`、`exports["./package.json"]`、`exports["./cordis.patch.yml"]`
- [x] 移除 `dsh.client.inject`（非规范字段；注入应放在 client bundle 的 `exports.inject`，已存在）
- [x] `files` 补 `LICENSE`、`locale/*.json`、`icon.svg`
- [x] 增加 `icon.svg`、`locale/en.json`、`locale/zh.json`（`{meta:{title,description}}`）
- [x] 增加 `README.zh.md`（或中文段落）
- [x] 增加 `LICENSE`（MIT）
- [x] 增加 `.gitignore`
- [x] 拆分 `lib/index.js`：config/http/sessions/delegate/provider/sse/tools 模块化（保持单入口）
- [x] 增加 `scripts/check.mjs` 冒烟测试（语法 + 配置归一化 + 工具注册 + 假 ctx），`npm run check`
- [x] 增加 `repository` 字段；若发布 npm 则补 `publishConfig`
- [x] 统一版本策略（独立语义化；见 COMPATIBILITY.md 与 CHANGELOG.md）
- [x] 文档整理：ARCHITECTURE.md、文档索引、聊天提案；v0.1.0 里程碑打 tag

## 9. 决策记录

- **v1 为基线，v2 可选**：v1 覆盖 share/todo/diff/fork 等；v2 补 wait/steer/history，按 `/api/health` 探测后增量使用。
- **结构化输出暂用 prompt 约束**：上游 format bug；本地校验 required 字段。
- **多 server 客户端聚合**：server 无联邦 API。
- **权限默认 `ask`**：工具发起的委派走 dsh 审批卡；无 agent 的 HTTP 调用回落到 allow。
- **产品定位**：核心是`opencode_subagent_<server>` 原生 subagent 后端；`opencode_subagent`/`opencode_prompt` 提供可控委派与续聊；UI 只做入口（左侧栏/右侧栏/会话头/嵌入原生 OpenCode），不做聚合工作台、聊天页或 LLM 桥接。
- **原生 subagent 一次性、远端会话可续**：外部 provider 无法实现 `prepareContinuable`；续用通过 `opencode_subagent(session=)`（任务级）或 `opencode_prompt`（消息级）。
- **直接操作 vs 委派**：确定性操作走 shell/read/git 等直连工具；开放式任务才走远端 agent。