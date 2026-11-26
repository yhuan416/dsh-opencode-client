# TODO — dsh-opencode-client

> dsh 作为 OpenCode server 的客户端：会话列表/读取/继续、委派、原生 subagent、SSE 实时、多 server 聚合。
> 本文档只记录"还没做/要做"的内容；已完成能力见 README，架构见 ARCHITECTURE.md。
>
> **当前里程碑：v0.7.2（2026-11-26）** —— OpenCode v2 端到端支持已合入 `master`（PR #5），用量/成本、完成未查看分区、清单与 CI 门禁落地；**v1 已冻结**（保留代码、不再扩展、不再实机验证）。详见 CHANGELOG 与「10. 后续迭代计划」。

## 0.1 v0.2.0 新增（OpenCode v2 端到端）

- [x] 传输/探测：`apiVersion: auto|1|2`，`/api/info` + Basic auth 探测，v1 回退原因记录；401/HTML/非 JSON/网络错误 `OpenCodeError`（不再静默空结果）
- [x] 只读面：session/project/message/agent/provider+model/command/skill/reference/MCP/active/diff 的 v2 解包、字段映射与目录作用域
- [x] 运行/委派：`{text,files}` prompt、创建时 `location.directory`、会话级 agent/model、execution 事件完成判定、`interrupt`
- [x] 交互：session 作用域权限（`once|always|reject`）+ 表单（类型化字段、`{answer}`、`DELETE` 取消）桥接 dsh 审批/提问
- [x] 工作区/管理：异步 shell（`/api/shell` + `/output`）、vcs `mode=working|branch|committed`、`/api/fs/read/*` 原始字节、`/api/fs/find`、fork `{before}`、compact、`init` 命令、`parentID` 子会话
- [x] 不可用功能明确报错：v2 的 share / tool ids / 文本搜索 / session todo
- [x] 测试：`test/v2-surface.test.js`（8 项离线）+ `scripts/e2e-live.mjs`（v1/v2 真实 server 各 10 步，`npm run e2e`）
- [x] 文档：COMPATIBILITY 兼容矩阵、CHANGELOG 0.2.0、README/工具文档/架构文档同步
- [ ] v2 Web UI iframe 免登录（dsh 侧注入 Basic auth 的代理）——**遗留：目前需在嵌入的 v2 UI 里手动登录**
- [ ] v2 share/todo/tool-ids/text-search 的替代方案（外部存储或 shell 近似）——**暂缓：当前明确报错**
- [ ] v2 版本矩阵（2.3.0 之外）与 nightly e2e——**建议后续用 `/api/info` 版本 + 契约测试持续校验**
- [ ] v2 深度整合（消息队列/steer、revert 检查点、worktree、stats/成本、export/import、调度桥、PTY、反向 MCP）——见 [docs/opencode-v2-deeper-integration.zh.md](docs/opencode-v2-deeper-integration.zh.md)，建议按 0.3.0/0.4.0/0.5.0 分版推进
- [ ] dsh subagent seam 升级（0.3.0/0.4.0）——见 [docs/subagent-seam.md](docs/subagent-seam.md)：
      ~~P1 `stopReason` 保真（max-tokens/refusal）~~ ✅ 0.3.0；~~P3 `opencode-auto` 路由 provider~~ ✅ 0.3.0；
      P2 `outputSchema: true` + `agentOptions: true`（配合 `subagentModelMap`），
      以打通 workflow 的 `agent(...,{schema})` / `agent(...,{provider,model})` 与 per-provider 工具的模型选择；
      订阅 `subagent/start|end` 事件，在插件页展示远端子代理运行/结算
- [ ] workflow 后端切到 opencode（配置级，无代码）：把 profile 里 agent 工具组内 `workflow-ptc.provider` 从 `spawn` 改为 `opencode-<id>`，
      让 workflow 编排跑在远端 opencode；需先完成 P2 capability，并评估远端并发/成本/延迟与 cwd 映射

### v0.6.0 —— 观测台 v0（2026-11-26 完成）

- [x] `lib/observation.js`：`(server, session)` 登记表，三层来源（running 快照 / SSE 增量 / 待办快照），
      优先级 `waiting-permission > waiting-question > error > running > idle > unknown`；子会话折叠进父行；stale 只标记不改状态
- [x] `lib/board.js`：`/board`、`/list` 行内状态、`opencode_board` 工具共用的刷新器
- [x] `collectPending()`：v1 全局 `/permission`+`/question`；v2 location 级 `/api/permission/request`+`/api/form`（实测 2.3.0，一次查询替代逐会话）
- [x] 无 dsh run 归属的权限请求不再自动答复（`permission: ask`），登记为待办；`permission: auto` 回退旧行为
- [x] `GET /api/opencode-client/board`；`/list` 每行带 `status`
- [x] 面板改卡片看板：紧急组置顶、空闲按远端分组、远端筛选、点卡片浮层打开会话
- [x] `opencode_board` 工具（跨 server 汇报，手机远程客户端也能用）
- [x] `scripts/probe-observation.mjs` 独立探针（无需 dsh，直连 `opencode serve`）
- [ ] **未完成**：同源代理（消除 iframe 跨域的登录 + Esc 限制）
- [ ] **未完成**：空闲会话的机器会话过滤 / 按项目分组（等真实密度反馈）
- [ ] **未完成**：SSE 连上之前就在跑的会话，`progress` 为空（可考虑快照补一次当前 tool）

### v0.7.1 / v0.7.2 —— 用量与未读、清单与门禁（2026-11-26 完成）

- [x] `opencode_usage` + `GET /api/opencode-client/usage`：按 server/时间窗聚合 sessions/steps/tokens/cost/工具成功率（v2 `/experimental/session/stats`，v1 明确报不支持）
- [x] 看板 per-server 概览卡（状态/版本/会话·运行·待办/token/cost），点卡即过滤
- [x] 「刚完成 · 未查看」分区：候选 = 本地看到的 running→idle，清除 = OpenCode 的 `viewed >= idle` 或 dsh 的 `/seen`；左栏徽标 = 待处理 + 未查看
- [x] 完成 toast 带本轮用时/用量；`opencode_board` 同步输出未查看分区
- [x] 看板 server 筛选（「全部」chip）落盘，修上次选中项单向粘滞
- [x] 清单修复：`exports` 导出 `./locale/*.json` / `./icon`、`dsh.client.inject`、客户端注册逐条 guard、路由 `findServer` 未定义修复
- [x] CI 门禁：`scripts/check-manifest.mjs`（版本/导出/locale/图标/files/patch）+ 全量 `node --check`，均做过负向验证
- [x] 发布 `v0.7.2`（tag 在 master）
- [ ] v1 去留：当前**冻结**（见 `COMPATIBILITY.md` §v1 policy）；若删除，作为 breaking 版本单独执行（清单：12 个 lib 文件的 92 处分派点、2 个 v1-only 工具、3 个测试夹具、8 份文档）

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

- [x] 工具进度事件（v1 SSE `message.part.updated`/`session.status`/`session.idle`；v2 `session.text.*`/`reasoning.*`/`tool.*`/`step.*`）→ `opencode_progress`、`GET /progress`、`/status` 的 tool/progress/tail、`/list` 的 `activeTool`。
- [x] 完成等待改为 **SSE `session.idle` 事件驱动** + 5s 轮询兜底（原 1.5s 纯轮询）。
- [x] 流式文本 tail：`message.part.delta` 记录 400 字符（未做完整流式渲染，够用于进度展示）。
- [ ] v2 `POST /api/session/{id}/wait`：**上游不可用**——1.18.31/1.18.33 实测 503 `Session wait is not available yet`，已由 SSE wait 替代。
- [ ] saved permissions 查看/删除——**暂缓：本地审批卡已覆盖交互，远端规则管理属低频诊断**
- [ ] 读远端 `GET /config` 的 permission 配置——**暂缓：本地档位已够用**
- [ ] v2 `delivery: steer|queue`、`resume`——**暂缓：一发式委派，无并发插话需求**
- [x] `opencode_abort`：`POST /session/{id}/abort`，取消远端长任务；等待中的委派会以 abort 错误返回（不再干等超时）。

## 5.5 P6 — 插件页远端会话聊天（**已废弃**，2026-11-26）

> **废弃原因**：v0.6.0 把定位收敛为「观测台」——会话内的对话体验交给 OpenCode 自己的
> TUI/Web，插件只做观测、授权、调度。自研聊天页是在别人的主场竞争，且会持续制造
> 「这插件到底是干嘛的」的歧义。完整交互使用嵌入的 OpenCode 原生 Web UI 或新标签。


见 [docs/chat-ui-proposal.md](docs/chat-ui-proposal.md)（保留作为决策记录）。

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

- **双栈（v2-first + v1 兼容）**：同一版本同时支持 v1（1.18.x）与 v2（2.x），按 `/api/info` 探测；v1 行为保持不变，v2 缺失能力（share/todo/tool ids/文本搜索）明确报错而不是伪造。
- **v2 语义跟随上游**：prompt 改 `{text,files}`、agent/model 走会话状态、完成看 `session.execution.*`、权限 `decision`、提问变表单、shell 异步；不做 v1→v2 翻译 shim。
- **结构化输出暂用 prompt 约束**：上游 format bug；本地校验 required 字段。
- **多 server 客户端聚合**：server 无联邦 API。
- **权限默认 `ask`**：工具发起的委派走 dsh 审批卡；无 agent 的 HTTP 调用回落到 allow。
- **产品定位**：核心是`opencode_subagent_<server>` 原生 subagent 后端；`opencode_subagent`/`opencode_prompt` 提供可控委派与续聊；UI 只做入口（左侧栏/右侧栏/会话头/嵌入原生 OpenCode），不做聚合工作台、聊天页或 LLM 桥接。
- **原生 subagent 一次性、远端会话可续**：外部 provider 无法实现 `prepareContinuable`；续用通过 `opencode_subagent(session=)`（任务级）或 `opencode_prompt`（消息级）。
- **直接操作 vs 委派**：确定性操作走 shell/read/git 等直连工具；开放式任务才走远端 agent。

## 10. 后续迭代计划（2026-11-21 起）

> 分支策略（2026-11-26 起更新）：v2 线已 rebase-merge 进 `master`，此后每个版本走 PR（规则集不再要求人工批准，但仍要求走 PR + 线性历史）+ tag；每个版本 = 代码 + 测试 + 门禁（`npm run check`）+ e2e + 文档 + 真机重启验证。

### 10.0 v0.5.2 —— 收尾当前批次（立即，~0.5 天）

- [ ] 重启验证 0.5.1（非零退出码显示）；补 `read_file` 截断提示（现在直接截 40k 无提示）
- [ ] `opencode_children` 补 `outcome/model/mode` 字段
- [ ] `opencode_find` 支持 `kind=dir`（v2 `/fs/find?type=directory`）

### 10.1 v0.6.0 —— v2 读取面补全（1–2 天）

- [ ] `opencode_git_diff` 支持 `untracked` / `context` / `base`（v2 参数）
- [ ] `opencode_sessions` 改用 v2 服务端 `search/directory/archived/cursor`，去掉 500 条截断
- [ ] `opencode_messages` 可选 `include`（system/synthetic）与 type+limit 组合的边界整理
- [ ] 结构化输出校验强化：`type/enum/items/properties`（workflow 同款子集），减少假“structured”
- [ ] `execution.failed` 错误结构化：透出 `error.name/data` 摘要
- 验收：离线 75+ 测试；e2e 增加 1–2 步；真机重启验证

### 10.2 v0.7.0 —— v2 交互与观测（2–3 天，opencode 独有）

- [ ] `opencode_prompt` 支持 `delivery: steer|queue`（运行中插话/排队）
- [ ] 新工具 `opencode_inbox`：列出/改投递/取消队列消息
- [x] 新工具 `opencode_usage`（计划里叫 `opencode_stats`，0.7.1 落地）：`/experimental/session/stats` 聚合（会话/step/cost/工具成功率/活跃度）
- [ ] `opencode_session_context`（或 session_info 扩展）：读模型实际上下文（`/session/{id}/context`）
- 验收：真机演示 steer/queue/inbox 闭环；stats 面板数据一致

### 10.3 v0.8.0 —— 安全与工作区（3–5 天）

- [ ] `opencode_revert` 检查点：`stage` 预览 → dsh 审批 → `commit`/discard
- [ ] `opencode_worktree`：create/list/remove；委派会话建在独立 worktree，完成后 diff/验收
- [ ] `export` / `import` / `move` / `migration/v1` 诊断（跨 server 迁移、归档、v1→v2 状态）
- 验收：revert/worktree 的安全 e2e（误操作可回滚、主工作区不被直改）

### 10.4 v0.9.0 —— 编排（DSH 侧深整合，3–5 天）

- [ ] provider 广告 `outputSchema: true`（prompt 约束 + 本地校验）→ workflow `agent(...,{schema})`
- [ ] provider 广告 `agentOptions: true` + `subagentModelMap`（dsh 路由 → opencode `Model.Ref+variant`）→ workflow `agent(...,{provider,model})` 与原生工具模型选择；`maxTokens` 明确拒绝
- [ ] `workflow-ptc.provider` 切 `opencode-auto`（配置级）+ 并发/成本护栏
- [ ] 订阅 `subagent/start|end`，插件页展示远端子代理运行/结算
- 验收：workflow 扇出跑在远端 opencode，结构化出参；原生子代理树可观测

### 10.5 v1.0 候选 —— 终端/远端管理/反向调用（按需，暂不排期）

- [ ] PTY 终端（`pty`/`persistent-pty`/per-session terminal）
- [ ] 远端能力管理（MCP/plugin/config/integration；高风险，只读优先 + 审批）
- [ ] `client-mcp`/`rpc` 反向调用（安全评审 + ticket 生命周期）
- [ ] 发布决策：是否合入 master、是否发 npm、文档/迁移指南定稿

### 固定动作与边界

- 每版：`npm run check` + `npm run e2e`（n100+m65；v1 本地 1.18.10）+ CHANGELOG/README/TOOLS 同步 + 真机重启验证。
- 永不支持（seam/上游限制）：`opencode_share`、`opencode_tools`、agent-team teammate、外部 `send_message`/`prepareContinuable`。
- 待决策：routing 的 per-server `directory` 是否进模板默认；workflow backend 是否默认开；1.0 的合并/发布方式。
