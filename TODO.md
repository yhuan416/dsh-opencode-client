# TODO / Roadmap — dsh-opencode-client

> dsh 作为 OpenCode server 的客户端：会话列表/读取/继续、委派、原生 subagent、SSE 实时、多 server 聚合。
>
> **定位（一核两轨）**：`core`（传输/版本探测/错误可见/会话模型/事件流）永不回归；
> **轨道 A `[observe]`**（给人看：看板、注意力、成本）｜**轨道 B `[delegate]`**（给 agent 用：工具面 + provider）。
> 新条目必须答得出「属于 core / observe / delegate 哪一轨，服务哪个目标」，答不出 → §4 不做。
>
> **当前版本 `1.2.0`**（npm 主通道，`v*` tag 触发 OIDC 发布）· 本文档更新于 2026-11-28。
> 本文只放**还没做**的；已完成能力见 README / CHANGELOG，架构见 ARCHITECTURE.md。
>
> 维护约定：每版发版后把做完的从 §1/§2 移出（细节进 CHANGELOG，§7 只留一行）；条目要带验收标准。

## 1. 下一批（按优先级，可直接开工）

### 1.1 `[delegate]` 可编排 —— 目标 v1.3.0（台账与失败原因已落地）

目标：远端 agent 作为 dsh 子代理**可编排、可归因**。

- [x] **委派台账**：两条委派路径各记一行（server / 任务 / 目录 / 耗时 / 状态 / 失败原因，
      建会话就失败也留痕）；`GET /api/opencode-client/delegations` + `opencode_delegations` +
      设置页卡片。进程内 200 行，不落盘（远端会话本身就是持久记录）
- [x] **失败原因可见**：`execution.failed` 的 `{name,message,data}` → 错误对象的
      `opencodeName` / `code` / `data`，台账带 `errorName` / `errorCode`；结构化校验补
      `type` / `required` / `properties` / `items` / `enum`
- [x] **单次 run 的 tokens / 成本**：SSE 累加 `step.ended` 的 `{tokens, cost}`，台账按 run 差值记账
      （未报价模型显示 `unpriced` 而不是 `$0`）
- [x] **父子委派关系**：行上记录 `parent`（provider 取 `request.parent.sessionId`、工具取
      `exec.agent.sessionId`）；跨层扇出的完整树聚合仍未做
- [x] **`outputSchema` 能力**：provider 广告 `outputSchema: true`，schema 走 prompt 约束 + 本地校验，
      成功返回 `SubagentResult.structured`
- [ ] **`agentOptions` 能力**：`subagentModelMap` → workflow 的 `agent(...,{provider,model})`；
      `maxTokens` 明确拒绝（需要先确认模型映射与远端 provider/model 的对应关系）
- [ ] **workflow 扇出切远端**（配置级，无代码）：`workflow-ptc.provider` 从 `spawn` 改为
      `opencode-<id>` / `opencode-auto`；先量化远端并发、延迟与成本，再决定是否默认开

验收：workflow 扇出跑在远端 OpenCode 且结构化出参可靠；台账能回答「这次花了多少、为什么失败」。

### 1.2 `[delegate]` 可纠偏与安全 —— 候选 v1.4（约 4–6 天）

- [ ] `opencode_prompt` 支持 `delivery: steer|queue`；新工具 `opencode_inbox`（列出 / 改投递 / 取消）
- [ ] `opencode_session_context`（或 `session_info` 扩展）：读模型实际上下文占用
- [ ] `opencode_revert` 检查点：`stage` 预览 → dsh 审批卡 → `commit` / `discard`（`revert` 高风险，
      `unrevert` 一并设计）
- [ ] `opencode_worktree`：create/list/remove；委派会话建在独立 worktree，完成后 `git_diff` 验收
- [ ] 委派路径默认带「改动预览」进审批卡

验收：跑偏能 steer、能撤回；误操作可回滚；主工作区不被直改。

### 1.3 `[observe]` 收尾小项（随下一次发版带走，不必单独排期）

- [ ] `npm run check` 补 `lib/swr.js` / 客户端 scheduler / board store 的单测
- [ ] `scripts/e2e-live.mjs` 补「预热后冷加载命中缓存（stale / miss 分层）」断言
- [ ] 把 1.1.x 批次的真机数值写进
      [design doc](docs/plans/2026-11-28-opencode-observe-performance-design.md) §6
      （看板暖 <300ms、7 天卡 <800ms、热力 <1s、skills 不阻塞）
- [ ] 设置页是否改为复用客户端 board store（去掉自己的 15s 轮询）——量一下收益再决定
- [ ] `opencode_children` 补 `mode`（`outcome` / `model` 已随 `summarizeSession` 带出）
- [ ] 可选：`?timing=1` 调试字段（SWR 响应已带 `at` / `stale`，可能永远不需要）
- [ ] 候选：board 改 SSE 事件驱动 + 兜底轮询（先量当前 5s 轮询的实际成本）

## 2. 待裁决策（先拍板，不动手）

### 2.1 HTTP API 面（第三面）

`lib/routes.js` 共 **40 条**宿主路由：

- 观测台在用 **11 条**：`/board`、`/list`、`/probe`、`/seen`、`/usage`、`/insights`、
  `/insights/activity`、`/insights/skills`、`/upgrade`、`/servers`、`/servers/remove`
- 其余 **29 条**仓库内**没有调用方**（工具面直连 `lib/*`，e2e 直连 OpenCode）：`/abort`、`/agents`、
  `/children`、`/command`、`/commands`、`/delegate`、`/events`、`/file`、`/find`、`/fork`、`/git/*`、
  `/init`、`/mcp`、`/messages`、`/models`、`/progress`、`/prompt`、`/references`、`/search`、`/session`、
  `/session-info`、`/sessions`、`/share`、`/shell`、`/skills`、`/status`、`/summarize`、`/tools`

它们等于「把工具能力再用 HTTP 说一遍」，是第二份实现与第二份测试负担。

| 选项 | 后果 |
|---|---|
| 保留为**公开 HTTP API** | 要补消费者文档 + 鉴权说明 + 契约测试；合并逻辑去重 |
| **裁剪**：只留有独立价值的（如 `/events` 调试、`/status` 健康快照） | 代码与测试各减一份；外部若有人依赖会断（目前无证据） |
| 暂不动 | 记账即可，但新增特性不要再往这里加 |

建议：先裁，理由是 1.0 已经清过一轮 v1 死分支，这类「第二份实现」是同类负担。

### 2.2 其他待裁

- **版本矩阵**：目前实测只有 OpenCode 2.4.2（2.3.0 有历史记录）。要不要做 2.3/2.4 双向 e2e +
  按 `/api/info` 版本跑的 nightly 契约测试？发到 npm 后用户版本会更分散。
- **routing 的 per-server `directory`**：是否进 subagent 模板默认值。
- **workflow backend 是否默认开**：会显著放大远端调用与成本（与 §1.1 一起决定）。

## 3. 上游阻塞 / 依赖宿主（我们自己推不动）

| 项 | 现状 |
|---|---|
| 结构化输出 `format` | 上游 bug；现用 prompt 约束 + 本地校验，等修复后恢复真 format |
| `experimental.policies` | 只在 2.x 生效 |
| `backgroundSubagents` | 部分构建仍为 `false` |
| v2 Web UI iframe 免登录 | 需要 dsh 宿主侧注入 Basic auth 的同源代理；现在要在嵌入的 UI 里手动登录 |
| v2 的 share / todo / tool-ids / text-search | 无 v2 端点，插件明确报错；替代方案（外部存储 / shell 近似）价值未论证 |
| `POST /api/session/{id}/wait` | 部分 2.x 构建返回 503，已由 SSE 等待替代 |

## 4. 明确不做（边界，要做先改定位）

| 项 | 为什么不做 |
|---|---|
| 替远端改配置（agents / models / providers / MCP / plugins / credentials / policies） | 管理实例 ≠ 观测或委派；高风险且与定位无关 |
| 聊天页 / 聚合工作台 / LLM 桥接 | 0.6.0 已排除；会话内交互交给 OpenCode 自己的 TUI/Web |
| PTY 终端（`pty` / `persistent-pty`） | 需要 WebSocket 交互；`opencode_shell` 已覆盖确定性命令 |
| 会话 part 编辑 / 删除 | 低频，且可用「重开 / 分叉」绕过 |
| saved permissions 查看 / 删除、读远端 `GET /config` 的 permission | 本地审批卡 + 档位已覆盖，属低频诊断 |
| `export` / `import` / `move` / `migration` 诊断 | 会话运维交给 OpenCode 自己演进 |
| 调度桥（远端 `experimental.schedules`） | 无人值守委派收益/风险未论证；要做先给「可见、可暂停」设计 |
| 反向 MCP / `client-mcp` / `rpc` | 与本定位无关 |
| 预算 / 成本护栏 | 订阅与未报价模型 `cost=0` 会让阈值失真；7/30 天洞察已能看成本 |
| 提醒策略（静默时段 / 去重窗口 / 按 server 静音 / 铃铛菜单） | 现有 toast + badge 够用，等真觉得吵再上 |
| 观察台打磨（未读批量、7 日趋势、徽标口径、看板密度） | 当前够用，先不加交互复杂度 |
| 观测台逐组件 memo 拆分 | 实测挂载 55ms、空转 0 条长任务，拆分收益不足（1.1.1 批次结论） |
| 滚动帧间隔继续优化（20–60ms） | trace 归因在 GPU 合成/光栅化侧，插件侧收益递减（1.1.1 批次结论） |
| TUI 控制、IDE/Web 替代客户端、GitHub/GitLab CI 集成、ACP | 方向不同 |
| 多 server 服务端联邦 | OpenCode server 不支持，只能客户端聚合（已这么做） |

## 5. 每版固定动作

- **发布**：bump `package.json` + `package-lock.json` → CHANGELOG 定稿（release 节带日期）→ PR 合并 →
  打 `v<version>` tag 并推 → `publish.yml` 走 OIDC 发布（带 provenance）。tag 与版本不一致会被门禁拦下。
- **门禁**：`npm run check`（`node --check` → 客户端/观测断言 → 清单门禁 → 179 项测试）；CI 跑同一条。
- **文档同步**：README 两版 / `COMPATIBILITY.md` / `ARCHITECTURE.zh.md` / `docs/TOOLS.zh.md` / CHANGELOG
  / 本文件（做完的移出）。
- **真机验证**（仅 OpenCode 2.x）：board 与 insights 数据对得上 stats；委派 + `git_diff` 闭环；
  权限/提问桥接正常。
- **市场侧**：描述改动才需要上游 PR（`awesome-dsh-plugin`）；截图只改仓库内 `screenshots.json`，
  下一次夜间构建自动生效。
- **永不支持**（seam/上游限制）：`opencode_share`、`opencode_tools`、agent-team teammate、
  外部 `send_message` / `prepareContinuable`。

## 6. 决策记录（append-only）

- **只支持 OpenCode 2（1.0.0，2026-11-27）**：传输层探测到 v1 直接 `opencode.v1_unsupported`；
  13 个 lib 文件的 v1 死分支已清。
- **语义跟随上游**：prompt 为 `{text,files}`、agent/model 走会话状态、完成看 `session.execution.*`、
  权限 `decision`、提问变表单、shell 异步；没有 v1→v2 翻译 shim。
- **传输统一走 `@opencode/client`**：`oc-client.js` 每台 server 缓存一个实例；剩余 raw 调用只有
  旧版 v2 的 per-session 回退、`/probe` 诊断与启动探测。
- **上游 client 锁版本**：`@opencode/client` 固定精确版本（现 `2.4.2`），插件版本独立；只在遇到
  兼容性问题或需要新端点时升级，每次升级单独 PR + `npm run check` + 真机 e2e + 更新 COMPATIBILITY。
  门禁禁止 `^` / `~` / `*`。
- **结构化输出暂用 prompt 约束**：上游 format bug；本地校验 required 字段。
- **多 server 客户端聚合**：server 无联邦 API。
- **权限默认 `ask`**：工具发起的委派走 dsh 审批卡；无 agent 的 HTTP 调用回落到 allow。
- **原生 subagent 一次性、远端会话可续**：外部 provider 无法实现 `prepareContinuable`；续用通过
  `opencode_subagent(session=)`（任务级）或 `opencode_prompt`（消息级）。
- **直接操作 vs 委派**：确定性操作走 shell/read/git 等直连工具；开放式任务才走远端 agent。
- **发布方式（1.2.0，2026-11-28）**：npm 主通道（`publishConfig` + `prepublishOnly` 门禁 + tag 触发
  `publish.yml`，OIDC + provenance），git / 本地 checkout 作开发通道。推翻了 1.0.0 的 git-only 定稿，
  原因见 CHANGELOG 1.1.3 / 1.2.0。
- **不做预算是刻意的**：`cost=0` 的模型会让阈值失真，观测已覆盖成本可见（2026-11-27）。

## 7. 归档（已完成，一行一条；细节见 CHANGELOG）

- **版本线**：`0.2.0` v2 端到端 → `0.6.0` 观测台 v0 → `0.7.x` 用量/未读/清单门禁 → `0.8.0` 观测可信度
  → `0.9.0` 洞察与活跃度 → `1.0.0` 删除 v1、传输迁移 → `1.1.0` 版本/更新检查 → `1.1.1` 观测台性能
  （统一调度 / SWR + 预热 / board store）→ `1.1.2` 卡片系统 / 远端可编辑 / 权限诊断 →
  `1.1.3` npm 主通道 → `1.1.4` OIDC + provenance → `1.2.0` 文档与仓库对齐、脱敏。
- **已废弃**：插件页远端会话聊天（2026-11-26 定位收敛，决策记录见
  [docs/chat-ui-proposal.md](docs/chat-ui-proposal.md)）。
- **历史残项已清**：v1 删除、client 迁移、`opencode_children` 的 `outcome`/`model`、
  `opencode_messages` 的 `include`（由 `type=` 覆盖）、`read_file` 截断提示。
- **文档重整**：2026-11-28 把原 §0.1–§8、§11 的完成清单从本文件移出（内容已在 CHANGELOG 与 git 历史里），
  本文件只保留未完成项、待裁决策与边界。