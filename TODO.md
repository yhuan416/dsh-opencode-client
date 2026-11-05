# TODO — dsh-opencode-client

> dsh 作为 OpenCode server 的客户端：会话列表/读取/继续、委派、原生 subagent、SSE 实时、多 server 聚合。
> 本文档只记录"还没做/要做"的内容；已完成能力见 README。

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

## 1. P0 — 上游阻塞（等 opencode 修复）

- [ ] 结构化输出：opencode 1.18.x 的 `format: {type:"json_schema"}` 会把 `retryCount` 持久化进 user message，之后 `GET /session/{id}/message` 返回 400（会话"毒化"）。
      → 已改用 prompt 约束 + 本地校验（`schema` 参数）；等上游修复后恢复真 format。
- [ ] OpenCode 2 的 policies（`experimental.policies`）只在 2.x 生效；1.x 不读。
- [ ] 后台子代理：1.18.31 的 `experimental/capabilities` 仍是 `backgroundSubagents: false`。

## 2. P1 — 客户端目录能力（只读，低风险）

- [ ] `opencode_models`：`GET /config/providers` + `GET /provider`，列出 provider/model；delegate 的 `model` 参数做存在性校验。
- [ ] `opencode_commands`：`GET /command` 列出自定义命令（/init、/review 等）。
- [ ] `opencode_command`：`POST /session/{id}/command` 在远端会话执行命令。
- [ ] `opencode_skills`：`GET /skill` 列出远端 skills。
- [ ] `opencode_references`：`GET /reference` 列出项目 references。
- [ ] `opencode_tools`：`GET /experimental/tool` + `/tool/ids` 列出远端可用工具。

验收：新会话工具列表可见；只读调用不改变远端状态。

## 3. P2 — 验证闭环（中高价值）

- [ ] `opencode_shell`：`POST /session/{id}/shell` 在远端会话跑 shell 命令（确定性执行，不跑完整 agent）。
- [ ] `opencode_read_file`：`GET /file/content` 读远端文件。
- [ ] `opencode_find`：`GET /find/file`、`/find/text` 搜索。
- [ ] `opencode_git_diff`：`GET /vcs/status`、`/vcs/diff`、`/vcs/diff/raw`，委派后验收"改了什么"。

验收：委派 → diff 核对 → 必要时再委派修复，形成闭环。

## 4. P3 — 会话管理（mutating，需确认）

- [ ] `opencode_fork`：`POST /session/{id}/fork`
- [ ] `opencode_summarize`：`POST /session/{id}/summarize`（长会话压缩）
- [ ] `opencode_init`：`POST /session/{id}/init`
- [ ] `opencode_revert` / `opencode_unrevert`：默认禁用，需显式参数 + 审批卡
- [ ] `opencode_children`：`GET /session/{id}/children`
- [ ] 消息 part 编辑/删除（`PATCH/DELETE .../part/{id}`），低优先级

## 5. P4 — 权限/实时增强

- [ ] saved permissions 查看/删除（v1 `GET /permission` 规则、v2 `/api/permission/saved`）
- [ ] 读远端 `GET /config` 的 permission 配置，对齐本地档位
- [ ] 工具进度事件：`session.next.tool.called/progress/success/failed` → 状态/UI 展示
- [ ] 流式文本：`message.part.delta` → 可选实时输出
- [ ] v2 `POST /api/session/{id}/wait` 替代消息轮询（需 `GET /api/health` 探测）
- [ ] v2 `delivery: steer|queue`、`resume` 语义接入

## 6. P5 — 可选

- [ ] MCP 只读列表/状态（`GET /mcp`）；connect/disconnect/auth 属远端管理员，不做
- [ ] PTY 远端终端（`POST /pty`、`/pty/{id}/connect-token`）
- [ ] 附件发送（FilePartInput）；目前只展示
- [ ] 会话搜索（v2 `/api/session?search=`）

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
- [ ] 统一版本策略（跟随 dsh rc 版本 or 独立语义化）

## 9. 决策记录

- **v1 为基线，v2 可选**：v1 覆盖 share/todo/diff/fork 等；v2 补 wait/steer/history，按 `/api/health` 探测后增量使用。
- **结构化输出暂用 prompt 约束**：上游 format bug；本地校验 required 字段。
- **多 server 客户端聚合**：server 无联邦 API。
- **权限默认 `ask`**：工具发起的委派走 dsh 审批卡；无 agent 的 HTTP 调用回落到 allow。