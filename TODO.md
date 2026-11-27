# TODO — dsh-opencode-client

> dsh 作为 OpenCode server 的客户端：会话列表/读取/继续、委派、原生 subagent、SSE 实时、多 server 聚合。
> 本文档只记录"还没做/要做"的内容；已完成能力见 README，架构见 ARCHITECTURE.md。
>
> **当前里程碑：v1.1.0（2026-11-27，tag `v1.1.0`）** —— 插件自身版本/更新检查、无主提问挂起、
> 看板删除残留与洞察布局修复已发布；`@opencode/client` 锁定 `2.4.2`。
> 后续：观测台性能与数据流（§11）、delegate 轨（§10.3/10.4）与若干待裁项。

## 0.1 v0.2.0 新增（OpenCode v2 端到端）

- [x] 传输/探测：`apiVersion: auto|2`，`/api/info` + Basic auth 探测，v1 直接 `opencode.v1_unsupported`；401/HTML/非 JSON/网络错误 `OpenCodeError`（不再静默空结果）
- [x] 只读面：session/project/message/agent/provider+model/command/skill/reference/MCP/active/diff 的 v2 解包、字段映射与目录作用域
- [x] 运行/委派：`{text,files}` prompt、创建时 `location.directory`、会话级 agent/model、execution 事件完成判定、`interrupt`
- [x] 交互：session 作用域权限（`once|always|reject`）+ 表单（类型化字段、`{answer}`、`DELETE` 取消）桥接 dsh 审批/提问
- [x] 工作区/管理：异步 shell（`/api/shell` + `/output`）、vcs `mode=working|branch|committed`、`/api/fs/read/*` 原始字节、`/api/fs/find`、fork `{before}`、compact、`init` 命令、`parentID` 子会话
- [x] 不可用功能明确报错：v2 的 share / tool ids / 文本搜索 / session todo
- [x] 测试：离线 129 项（`npm run check`）+ `scripts/e2e-live.mjs`（两台 OpenCode 2.4.2 真机，`npm run e2e`）
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
- [x] `collectPending()`：location 级 `permission.request.list` + `form.list`（一次查询替代逐会话；旧版 v2 保留 per-session 回退）
- [x] 无 dsh run 归属的权限请求不再自动答复（`permission: ask`），登记为待办；`permission: auto` 回退旧行为
- [x] `GET /api/opencode-client/board`；`/list` 每行带 `status`
- [x] 面板改卡片看板：紧急组置顶、空闲按远端分组、远端筛选、点卡片浮层打开会话
- [x] `opencode_board` 工具（跨 server 汇报，手机远程客户端也能用）
- [x] `scripts/probe-observation.mjs` 独立探针（无需 dsh，直连 `opencode serve`）
- [ ] 同源代理（消除 iframe 跨域的登录 + Esc 限制）
- [x] 空闲会话按（机器, directory）分组 + 机器过滤（0.8.0）
- [x] SSE 连上之前就在跑的会话补一次当前 tool（0.8.0）

### v0.7.1 / v0.7.2 —— 用量与未读、清单与门禁（2026-11-26 完成）

- [x] `opencode_usage` + `GET /api/opencode-client/usage`：按 server/时间窗聚合 sessions/steps/tokens/cost/工具成功率（`/experimental/session/stats`）
- [x] 看板 per-server 概览卡（状态/版本/会话·运行·待办/token/cost），点卡即过滤
- [x] 「刚完成 · 未查看」分区：候选 = 本地看到的 running→idle，清除 = OpenCode 的 `viewed >= idle` 或 dsh 的 `/seen`；左栏徽标 = 待处理 + 未查看
- [x] 完成 toast 带本轮用时/用量；`opencode_board` 同步输出未查看分区
- [x] 看板 server 筛选（「全部」chip）落盘，修上次选中项单向粘滞
- [x] 清单修复：`exports` 导出 `./locale/*.json` / `./icon`、`dsh.client.inject`、客户端注册逐条 guard、路由 `findServer` 未定义修复
- [x] CI 门禁：`scripts/check-manifest.mjs`（版本/导出/locale/图标/files/patch）+ 全量 `node --check`，均做过负向验证
- [x] 发布 `v0.7.2`（tag 在 master）
- [x] v1 去留：**删除**（1.0.0 breaking）——传输层拒绝，13 个 lib 文件的 v1 死分支已清，v1-only 工具文案与测试夹具已改；`COMPATIBILITY.md` §v1 policy 记录

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
- [x] 28 个 `opencode_*` 模型工具（会话 58 工具）

## 1. P0 — 上游阻塞（等 opencode 修复）

- [ ] 结构化输出：继续用 prompt 约束 + 本地校验，不依赖上游 `format`。
      → 已改用 prompt 约束 + 本地校验（`schema` 参数）；等上游修复后恢复真 format。
- [ ] OpenCode 2 的 policies（`experimental.policies`）只在 2.x 生效；1.x 不读。
- [ ] 后台子代理：`experimental/capabilities` 的 `backgroundSubagents` 在部分构建仍为 false。

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

- [x] 工具进度事件（`session.text.*` / `reasoning.*` / `tool.*` / `step.*`）→ `opencode_progress`、`GET /progress`、`/status` 的 tool/progress/tail、`/list` 的 `activeTool`。
- [x] 完成等待改为 **SSE `session.idle` 事件驱动** + 5s 轮询兜底（原 1.5s 纯轮询）。
- [x] 流式文本 tail：`message.part.delta` 记录 400 字符（未做完整流式渲染，够用于进度展示）。
- [ ] `POST /api/session/{id}/wait`：部分 2.x 构建返回 503 `Session wait is not available yet`，已由 SSE wait 替代。
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
- [x] 会话搜索：`opencode_search` → `/api/session?search=`

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

- **只支持 OpenCode 2（1.0.0，2026-11-27）**：传输层探测到 v1 直接
  `opencode.v1_unsupported`；`apiVersion: 1` 视为 auto。13 个 lib 文件的 v1 死分支已清。
- **语义跟随上游**：prompt 为 `{text,files}`、agent/model 走会话状态、完成看
  `session.execution.*`、权限 `decision`、提问变表单、shell 异步；没有 v1→v2 翻译 shim。
- **传输统一走 `@opencode/client`**：按模块迁移完成，`oc-client.js` 每台 server 缓存一个实例；
  剩余 raw 调用只有旧版 v2 的 per-session 回退、`/probe` 诊断与启动探测。
- **上游 client 锁版本（2026-11-27）**：`@opencode/client` 固定精确版本（现 `2.4.2`），插件版本独立；**只在遇到兼容性问题或需要新端点时**才升级，每次升级单独 PR + `npm run check` + 真机 e2e + 更新 COMPATIBILITY。CI 门禁禁止 `^`/`~`/`*`，防止浮动把上游 churn 带进运行中的插件。
- **结构化输出暂用 prompt 约束**：上游 format bug；本地校验 required 字段。
- **多 server 客户端聚合**：server 无联邦 API。
- **权限默认 `ask`**：工具发起的委派走 dsh 审批卡；无 agent 的 HTTP 调用回落到 allow。
- **产品定位（一核两轨，2026-11-27）**：**核心**（传输与版本探测、错误可见性、会话模型、事件流）被两个面共用，永不回归；**轨道 A · 观测台**（消费者＝**人**：看板、注意力、成本治理）——**当前优先，先把观测做完善**；**轨道 B · 委派面**（消费者＝**agent**：28 个工具（含观测用的 `opencode_board`/`opencode_usage`）+ 原生 subagent provider）——后续版本逐步推进。会话内交互交给 OpenCode 自己的 TUI/Web（插件只做深链与嵌入）。准入判据：核心/观测/委派三选一，答不出来的进「不排期」（§10.6）。
- **原生 subagent 一次性、远端会话可续**：外部 provider 无法实现 `prepareContinuable`；续用通过 `opencode_subagent(session=)`（任务级）或 `opencode_prompt`（消息级）。
- **直接操作 vs 委派**：确定性操作走 shell/read/git 等直连工具；开放式任务才走远端 agent。

## 10. 后续迭代计划（2026-11-27：一核两轨，观测优先）

> **结构**：`core` 永不回归（四道门禁守着）｜`[observe]` 人看的观测台｜`[delegate]` agent 用的委派面。
> **优先级**：先把 `[observe]` 做完善（0.8.0 / 0.9.0），`[delegate]` 从 0.10.0 起逐步推进。
> **准入判据**：这条特性属于 `core` / `observe` / `delegate` 哪一轨，服务于「让看板更可信」还是
> 「让委派更可靠」；两问都答不出 → §10.6 不排期。
> **分支策略**：走 PR（规则集不再要求人工批准，但要求 PR + 线性历史）+ annotated tag；每版 =
> 代码 + `npm run check`（语法/客户端/清单/测试四道）+ 文档 + 真机验证（仅 v2）。

### 10.1 v0.8.0 —— [observe] 可信度（约 2–3 天）

目标：看板说的事必须是**对**的、**全**的、**能追到钱**的。

> 2026-11-27 决策：**不做预算/成本护栏**（订阅/未报价模型 `cost=0` 会让阈值失真；
> 7/30 天洞察已覆盖成本可见；只提醒不阻断，维护成本大于收益）——移入 §10.6。
- [x] **成本归因**：`/api/opencode-client/usage` 增 `byModel` / `byDirectory`（窗口内 assistant 消息成本，与 stats 同口径；`reconciled` 守门）。初稿用会话累计成本 + `time.updated` 判活，实测虚高 5.1 倍，已改
- [x] **后台任务可见**：`/experimental/job` 合并进登记表，新增 `background` 状态；看板「后台运行」分区、`opencode_board`/`opencode_progress` 同步（v2 only，接口缺失静默降级）
- [x] **机群健康**：`/board` 的 `servers[]` 增 `probe`（版本/原因/时间/详情）与 `sse`（state/attempts/connects/openedAt）；设置页与看板卡展示
- [x] **空闲会话过滤/分组**：按 (机器, directory) 分组；机器 chip 过滤已有；折叠/展开按目录各自 6 条
- [x] **SSE 补 progress**：stream 打开后读 `/session/active` + 最近消息，补一次当前 tool
- [x] 回收小项：`opencode_git_diff` 增 `untracked`（files/folders）/`base`；`opencode_find` 增 `kind=dir`；`opencode_sessions` 增 `archived` + `cursor` 翻页（`nextCursor`）；~~`opencode_read_file` 截断提示~~（已实现）
- 验收：每台 server 的版本/探测/重连与成本归因可见；`npm run check` 全绿

### 10.2 v0.9.0 —— [observe] 注意力与趋势（约 2–3 天）

目标：观测台**不吵、不丢、看得出趋势**。

- [x] **洞察**：看板页顶部洞察（7/30 天切换）——概览卡/日 steps 柱状/模型/MCP 工具/技能/项目；
      `lib/insights.js` + `GET /api/opencode-client/insights`；窗口内口径、单台失败隔离、
      stats `tools=detail` 缓存键含模式。MCP 按内置白名单之外拆分；技能名由
      `lib/skills.js` 扫消息（独立懒加载 + 10 分钟缓存）得到。
- [x] **活跃度热力图**：固定 30 天、独立于 7/30 窗口；`/insights/activity` 按日 stats 聚合
      会话/Token，前端二选一（默认 Token）；与 6 张卡、steps 柱状图同排；首算约 1.9s，10 分钟缓存

- 其余观察台打磨（未读批量、7 日趋势、徽标口径、看板密度）暂不做，见 §10.6

### 10.3 v0.10.0 —— [delegate] 可编排（约 4–6 天）

目标：远端 agent 作为 dsh 子代理**可编排、可归因**。

- [ ] provider 广告 `outputSchema: true`（prompt 约束 + 本地校验）→ workflow `agent(...,{schema})`
- [ ] provider 广告 `agentOptions: true` + `subagentModelMap` → workflow `agent(...,{provider,model})`；`maxTokens` 明确拒绝
- [ ] `workflow-ptc.provider` 切 `opencode-auto`（配置级）+ 并发/成本护栏
- [ ] 订阅 `subagent/start|end` → **委派台账**：谁委派了什么、花了多少、成功/失败原因，插件页可回看
- [ ] 错误可见性：`execution.failed` 透出 `error.name/data`；结构化输出校验补 `enum`/`items`/`properties`
- 验收：workflow 扇出跑在远端 opencode 且结构化出参可靠；台账能回答「这次花了多少、为什么失败」

### 10.4 v0.11.0 —— [delegate] 可纠偏与安全（约 4–6 天）

- [ ] `opencode_prompt` 支持 `delivery: steer|queue`；新工具 `opencode_inbox`（列出/改投递/取消）
- [ ] `opencode_session_context`（或 `session_info` 扩展）：读模型实际上下文
- [ ] `opencode_revert` 检查点：`stage` 预览 → dsh 审批 → `commit`/`discard`
- [ ] `opencode_worktree`：create/list/remove；委派会话建在独立 worktree，完成后 `git_diff` 验收
- [ ] 委派路径默认带「改动预览」进审批卡
- 验收：跑偏能 steer、能撤回；误操作可回滚；主工作区不被直改

### 10.5 v1.0.0 —— 承诺（条件驱动，不排期）

- [x] v1 去留定案：**删除**（1.0.0 breaking）；运行路径已拒绝 v1，死分支已清理
- [x] 传输迁移到 `@opencode/client`（锁定 `2.4.2`），全部 v2 调用按模块完成
- [x] `COMPATIBILITY.md` 写明 SemVer 覆盖范围：**工具名 / 文档化 HTTP 路由 / config 结构**；
      其余路由 internal、dsh 宿主契约不在承诺内
- [x] 发布方式定稿：**git-only + annotated tag，不发布 npm**（`private: true`）

### 10.6 不排期 / 已否决（要做先改定位）

| 项 | 为什么不做 |
|---|---|
| PTY 终端（`pty` / `persistent-pty` / per-session terminal） | 会话内交互交给 OpenCode TUI/Web；做它就变成「OpenCode 控制台」 |
| 远端能力管理（MCP/plugin/config/integration） | 管理实例 ≠ 观测或委派；高风险且与定位无关 |
| `client-mcp` / `rpc` 反向调用 | 与本定位无关 |
| `export` / `import` / `move` / `migration` 诊断 | 会话运维属于客户端能力，交给 OpenCode 自己演进 |
| 调度桥（远端 `experimental.schedules`） | 无人值守委派，收益/风险未论证；若要做，先给出「可见、可暂停」的设计 |
| 预算/成本护栏（日预算阈值提醒） | 订阅/未报价模型 `cost=0` 会让阈值失真；7/30 天洞察已能看成本；「只提醒不阻断」收益低、维护成本高（2026-11-27 决定不做） |
| 提醒策略（静默时段 / 去重窗口 / 按 server 静音 / 铃铛菜单） | 现有 toast（固定 8s、最多 3 条）+ badge 已够用；DSH 也没有可复用的通知服务，自建策略层收益低（2026-11-27 决定暂不做，等真正觉得吵再上） |
| 观察台打磨（未读批量、7 日趋势、徽标口径、看板密度） | 当前看板与徽标够用，先不加交互复杂度；等实际使用中明确觉得缺再回头做（2026-11-27 决定暂不做） |
| 聊天页 / 聚合工作台 / LLM 桥接 | 0.6.0 定位已明确排除 |

### 10.7 历史残项台账

| 项 | 状态 |
|---|---|
| `opencode_children` 补 `outcome`/`model` | ✅ 已随 `summarizeSession` 带出（`mode` 仍缺） |
| `opencode_messages` 的 `include` | ✅ 已由 `type=` 覆盖 |
| `read_file` 截断提示（静默 40k） | ⬜ 归入 §10.1 |
| 重启验证 0.5.1 | ⬜ 并入下次真机验证 |
| 同源代理（iframe 免登录） | ⬜ 入口体验，低优先（不做也能用，需手动登录） |
| routing per-server `directory` 是否进模板默认 | 待决策 |
| workflow backend 是否默认开 | 待决策（会显著放大远端调用与成本） |
| v1 删除 | ✅ 完成：传输层拒绝，13 个 lib 文件的死分支已清，文档/工具文案/测试夹具已对齐 |
| client 迁移 | ✅ 完成：sessions / catalog / workspace / delegate / session-run / interactions / manage / skills；`@opencode/client` 锁定 `2.4.2` |

### 10.8 待裁：HTTP API 面（第三面）

`lib/routes.js` 共 **40 条**宿主路由，其中：

- 观测台在用 **11 条**：`/board`、`/list`、`/probe`、`/seen`、`/usage`、`/insights`、`/insights/activity`、`/insights/skills`、`/upgrade`、`/servers`、`/servers/remove`
- 其余 **29 条**在仓库内**没有调用方**（工具面直连 `lib/*`，e2e 直连 OpenCode）：`/abort`、`/agents`、`/children`、`/command`、`/commands`、`/delegate`、`/events`、`/file`、`/find`、`/fork`、`/git/*`、`/init`、`/mcp`、`/messages`、`/models`、`/progress`、`/prompt`、`/references`、`/search`、`/session`、`/session-info`、`/sessions`、`/share`、`/shell`、`/skills`、`/status`、`/summarize`、`/tools`

它们等于「把工具能力再用 HTTP 说一遍」，是第二份实现与第二份测试负担。选项：

| 选项 | 后果 |
|---|---|
| 保留为**公开 HTTP API** | 需要补消费者文档 + 鉴权说明 + 契约测试；合并逻辑去重 |
| **合并/裁剪**：只留有独立价值的（如 `/events` 调试、`/status` 健康快照） | 代码与测试各减一份；外部若有人依赖会断（目前无证据） |
| 暂不动 | 记账即可，但新增特性不要再往这里加 |

### 固定动作与边界

- 每版：`npm run check`（`node --check` → 客户端/观测断言 → 清单门禁 → 100+ 测试）+ README/TOOLS/COMPATIBILITY/CHANGELOG 同步 + annotated tag + 真机重启验证（**仅 v2**）。
- 永不支持（seam/上游限制）：`opencode_share`、`opencode_tools`、agent-team teammate、外部 `send_message`/`prepareContinuable`。


## 11. 观测台性能与数据流（2026-11-28 计划，v1.1.x）

> 设计：[docs/plans/2026-11-28-opencode-observe-performance-design.md](docs/plans/2026-11-28-opencode-observe-performance-design.md)
> 现象：冷加载卡顿、控件刷新节奏不一致、30 天活动表有延迟感；实测后端单点不慢（30 天热力
> 冷加载仅 ~60ms），问题在客户端请求编排/渲染 gating/无 SWR 预热。方向：渐进填充 + 统一调度
> + 渲染拆分 + 服务端 SWR/预热 + board 数据流合并。

### Phase 1 — 客户端骨架与调度（P0）

- [ ] 新增客户端 `scheduler` 单例：1s tick、任务注册（key/interval/priority/visibleOnly）、
      同 key in-flight 去重、并发上限（普通 3 / 重任务 1）
- [ ] 统一 `visibilitychange`：恢复时只对「已到期」任务补刷一次（300ms 抖动 + 串行），
      移除各 effect 自带的监听
- [ ] 洞察区去掉 `insights === null ? null` 整体 gate：布局与骨架立即渲染
- [ ] 每张洞察卡独立 loading/数据 slice；局部「更新中/更新于 hh:mm」指示；固定 min-height
- [ ] 首屏请求分层：P0 board、P1 insights+activity 立即；P2 usage/about/upgrade
      `requestIdleCallback` 延迟；P3 skills 等 insights 到达后再排
- [ ] toast watcher 与 BoardPage 的 `/board` 轮询共享 in-flight（先止血，Phase 4 再全量 store）
- [x] 占位符审计：所有异步块（看板首帧、远端条、设置页列表/用量/归因、版本 chip）在数据到达前
      预留与最终内容等高的占位（`asyncSlot` + 看板形状缓存），避免布局被撑开

### Phase 2 — 渲染拆分（P0）

- [x] 渲染边界用「board store 内容去重 + `insightBlock` useMemo + `LazyRender`」达成等效目标
      （未逐组件拆五个 memo 组件：实测挂载 55ms、空转 0 长任务，拆分收益不足）
- [x] board 刷新只在内容变化时重渲染；洞察到达只重渲染对应卡（store 去重 + useMemo）
- [x] 筛选（7/30 天、server）切换：保留旧数据 + loading 标记 + `AbortController` 取消在途
- [x] 骨架与最终卡片等高（占位符审计 PR #64/#65：asyncSlot + 看板形状缓存 + 固定行高）

### Phase 3 — 服务端 SWR / 预热 / single-flight（P1）

- [ ] 新增 `lib/swr.js` 内存 SWR（`{value, at, stale}`，过期先返回旧值后台刷新，单飞）+ 单测
- [ ] `/insights` 接入 SWR（key: days+server，TTL 60s）
- [ ] `/insights/activity`：历史天 stats 进程内永久缓存、今天 60s；按天 key
- [ ] `/insights/skills` 补 SWR（TTL 600s，重任务并发 1）
- [ ] `/usage` 接入 SWR（TTL 60s；`from=0` 全历史不走 SWR）
- [ ] `collectStats` 加 `server.statsInflight`（key→promise）合并并发扫描
- [ ] 启动预热：首个 server probe 成功后 idle 串行预热 board → insights(7d,all) →
      activity(30d,all)；失败静默退避重试一次
- [ ] `?timing=1` 调试字段：`{ ms, cache: hit|stale|miss }`（SWR 响应已带 `at`/`stale`，够用；暂不做）

### Phase 4 — Board 数据流合并（P1）

- [ ] 新增客户端 board store（仿 about store）：BoardPage / toast watcher / 设置页共享
      `{ value, at, inflight, listeners }`
- [x] 轮询分级：页面可见 5s，其中每 3 个 tick 才 `refresh=1` 全量采集，中间 tick `refresh=0`
      读服务端 observation 快照；配置变更/手动刷新强制全量
- [ ] 设置页改为复用 board store（去掉自己的 15s 轮询）
- [ ] （后续 v1.2 候选）board 改 SSE 事件驱动 + 兜底轮询

### Phase 5 — 度量与回归（贯穿）

- [x] 客户端 `performance.mark`：board-skeleton / board-ready / insights-core / activity / skills / idle
      + `PerformanceObserver("longtask")`（`localStorage.dsh-oc-perf=1` 开启，`__dshOcPerf.dump()` 出表）
- [ ] 真机验收数值写进 design doc §6：看板暖<300ms、7 天卡<800ms、热力<1s、skills 不阻塞
- [ ] `npm run check` 补 swr / scheduler / board store 单测
- [ ] `scripts/e2e-live.mjs` 补「预热后冷加载命中缓存（stale/miss 分层）」断言

### 收尾结论（2026-11-28，1.1.1 批次）

PR 序列：#57–#63（统一调度 / 渐进填充 / SWR+预热 / board store / 占位修复）、#64（占位符审计）、
#65（远端卡用量/健康/top 固定行高）、#66（中段 tick 免采集 + 快照去重 + 刷新指示 + 埋点）、
#67（离屏 LazyRender）、#68（空闲卡上限 12 + 卡片固定高度）、#69（去掉卡片 content-visibility +
滚动容器合成提示，待发版）。

实测（本机 dsh-web，两台 OpenCode 2.4.2）：

- 服务端暖后：`/board` 2–8ms、`/insights?days=7` 2–4ms、`/activity` 2ms、`/usage` 2ms
  （冷 `/insights` 原 ~9s，预热 + SWR 后首个页面不再等）。
- 客户端：看板首帧从一行式 gate 改为骨架；挂载长任务 95ms → 55ms；看板空转 23s 内 **0 条 >50ms
  长任务**；滚动期间原本 321ms 的尖峰消失。
- 剩余：滚动仍有 20–60ms 帧间隔。trace 归因显示渲染主线程 15s 内 JS 仅 231ms（Paint 119ms /
  HitTest 91ms / Layerize 91ms），Compositor 与 Viz 线程空闲，**GPU 进程 RunTask 2726ms +
  GPUTask 1859ms** 才是大头 —— 合成/光栅化侧，插件侧不再继续优化（会话页滚动也不卡，
  说明是观测台内容合成成本，收益递减）。

未做（推迟）：Phase 2 的逐组件 memo 拆分、`?timing=1`、e2e 预热分层断言；
工具页 / 列表页的占位符审计（下一批）。

### 1.1.2 批次（进行中）

- [x] 卡片系统统一：`cardSurface()` 覆盖会话卡 / 远端条 / KPI 卡 / 洞察面板 / 热力图 / 设置页三块；
      `.dsh-oc-card` hover + focus-visible；会话卡 104px 等高；设置页信息块收进卡片。
- [ ] 工具页 / 列表页的占位符审计（同样 `asyncSlot` + 等高占位）。
- [x] README/ARCHITECTURE 同步（客户端 scheduler、board store、`lib/swr.js`/`lib/warm.js` 数据流、
      `dsh-oc-perf` 埋点；见 README「观测台性能与数据流」与 ARCHITECTURE「Observe page data flow」）
