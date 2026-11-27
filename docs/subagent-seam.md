# dsh subagent seam 对接分析（dsh 0.2.2-rc.4）

> 目的：回答"**opencode 能不能作为 dsh 的子智能体被调用，能插多深**"。
> 依据：dsh 0.2.2-rc.4 源码契约（`@deepseek-ai/dsh-subagent`、`dsh-tool-subagent`、`dsh-agent-team`）+ 本插件实现 + 真机验证（n100/m65，opencode 2.3.0）。
> 关联：[docs/opencode-v2-deeper-integration.zh.md](opencode-v2-deeper-integration.zh.md)（opencode 侧的深度整合盘点）。

---

## 0. 结论（TL;DR）

1. **可以，而且已经是"一等公民"形态**：opencode 会话作为 dsh 子智能体有两种已验证的调用方式：
   - **原生 provider 工具**：`opencode_subagent_n100` / `opencode_subagent_m65`（`@deepseek-ai/dsh-tool-subagent` + `subagents.registerProvider(provider)`）——异步启动、立即返回子代理名、结束时由 runtime 送结算通知回父会话；
   - **通用委派工具**：本插件的 `opencode_subagent`（一次性/续聊、可带 agent/model/schema/附件）。
2. **当前只用了 seam 的"最小外部后端"形态**：4 个 start capability 全 `false`、无 `structured`、`stopReason` 只覆盖 `completed/aborted/error`。
3. **还能诚实提升 3 处**：`outputSchema`（结构化结果）、`stopReason` 保真（max-tokens/refusal）、`agentOptions`（需配合模型映射配置）；另有 UI 级增强可接 `subagent/start|end` 事件。
4. **3 件事不是"没做"而是 seam 语义不允许**（都需要本地 Agent 或本地 inbox）：
   - 子代理续聊 / `send_message` steer（外部 start-only 后端在 `deliverToMember` → `requireLocalActivation` 处被拒）；
   - agent-team teammate（要求 `mode === "continuable"` 的本地子代理）；
   - `prepareContinuable`（continuable 子代理必须由本地 Agent 承载）。
   → opencode 的"续聊"只能走 seam 之外的 `opencode_prompt`（本插件已提供）。

---

## 1. seam 契约（0.2.2-rc.4）

**Provider 对象**（`ctx.subagents.registerProvider(provider)`）：

| 字段 | 含义 |
|---|---|
| `name` | 全局唯一 provider 名；本插件为 `opencode-<serverId>` |
| `capabilities` | `{agentOptions, agentPreset, outputSchema, depthLimit}`，服务在 `start` 前校验，未声明能力被请求会在 start 前拒绝（不会"接受后忽略"） |
| `inheritsParentContext` | 子代理是否看到父会话已完成回合（外部后端为 `false`，决定工具描述措辞） |
| `agentRouteDefaults?` | provider 自带的 provider/model 默认路由（需 `agentOptions`） |
| `start?(request)` | 外部后端：返回 `{id, result, dispose}`；支持并发、独立取消 |
| `prepareContinuable?(request)` | 本地后端/可续子代理的创建钩子；**方法存在即选择本地激活**，外部实现不适用 |

**`start` 收到的 request**：`cwd`（绝对路径）、`prompt: ContentBlock[]`、`parent: Agent`（精确的父 Agent，用于审批/提问归属）、`signal`（唯一取消通道）、`label?`（工具层的 `description`）、以及按能力启用时才会有的 `agentPreset` / `agentOptions {provider, model, reasoningEffort, maxTokens}` / `outputSchema` / `maxDepth`。

**返回的 run**：`id`（跨 parent/provider/session 唯一）、`result`（**永不 reject**，resolve `{output, structured?, diagnostic?, stopReason}`；`output` 取"最后一条非空 assistant 消息"）、`dispose()`（幂等：取消 + 等待退出）。

**stopReason**（merge-extensible）：`completed | aborted | error | max-tokens | refusal`。

**服务面**：`registerProvider`、`resolveMaxDepth`、`rootOf`、`namesOf`、`listDescendants`、`sendMessage`、`interrupt(target, {kind:'user'|'ancestor'})`；生命周期事件 `subagent/start`、`subagent/end`（携带 `runId/provider/parentSessionId/id/local/stopReason/lastAssistantMessage`）。激活层还给子代理分配 `name`（`agent-N`，或父链命名后的 `a/b` 路径）与 `delivery: 'parent' | 'caller'`。

**工具层**（`dsh-tool-subagent`，per-provider 配置）：参数 `cwd`/`description`/`name`/`prompt`，按能力追加 `agentPreset`、模型选择（`modelSelection: true` + `agentOptions` 时出现，配合 `list_subagent_models`）、`maxDepth`（或 `provider-managed`）；描述文案会按 `prepareContinuable` 是否存在自动切换"可用 send_message 续聊/不支持后续消息"（**本插件当前命中后者**）。工具启动后立即返回子代理名，结算通知回父会话（摘要 + 收尾文本 + 可选 structured + diagnostic）。

### 1.1 DSH 侧能挂 opencode 的三个"插座"

| 插座 | 形态 | 当前是否可用 | 受 capability 门控 |
|---|---|---|---|
| **① per-provider 工具**：`opencode_subagent_n100` / `_m65` | `dsh-tool-subagent` 以本插件 provider 起一次性子代理；异步 + 结算通知 | ✅ 已启用并验证 | 模型选择需 `agentOptions` + 工具行 `modelSelection: true`；`maxDepth` 只能 `provider-managed` |
| **①′ 路由工具**：`opencode_subagent_auto` | provider 换成 `opencode-auto`：每次 start 在 n100/m65 间自动选（directory → sticky → least-busy → round-robin，失败自动换台） | ✅ 0.3.0 已实现并真机验证 | 同 ①；`routing` 配置可调策略 |
| **② workflow 引擎后端**：`workflow(script)` 里的 `agent(prompt, opts)` | `workflow-ptc` 的 `provider` 配置（默认 `spawn`）决定所有 `agent()` 子代理跑在哪个后端；可改成 `opencode-n100` | ⚙️ 配置级可用（未切换） | `opts.schema` 需 `outputSchema`；`opts.provider/model`（LLM 路由覆盖）需 `agentOptions`；并发上限 `maxConcurrentAgents`（默认 ≤16）、`maxTotalAgents`（默认 1000） |
| **③ 本插件自有 delegate 工具** `opencode_subagent` | seam 之外：一次性/续聊、agent/model/schema/附件、`opencode_prompt` 续聊、`opencode_progress` 进度 | ✅ 已启用 | 无（插件自管） |

> workflow 后端是**配置级**深度集成：`workflow-ptc` 在 profile 的 agent 工具组里默认 `provider: spawn`（本地子代理），把它改成 `provider: opencode-n100` 后，workflow 脚本里每个 `agent()` 都会变成远端 opencode 会话（`cwd` 经插件的 `pathMap` 映射）。代价：远端并发/成本/延迟，且脚本里 `agent()` 默认拿不到结构化结果（除非 provider 广告 `outputSchema`）。

---

## 2. 插件当前映射与验证

| seam | 本插件 |
|---|---|
| provider name | `opencode-<serverId>`（多 server 各一个） |
| capabilities | 全 `false` |
| inheritsParentContext | `false` |
| start | 复用 `lib/session-run.js`：`ensureSession`（v2 用 `location.directory` + agent/model）→ `prompt` → 等待 execution/idle 完成 |
| id | 远端会话 id（`ses_...`） |
| output | 最后一条 assistant 文本（v2 `content[]` 的 text parts） |
| stopReason | `completed` / `aborted` / `error` / `max-tokens`（finish=length）/ `refusal`（content-filter），diagnostic ≤4096B |
| dispose | 幂等：abort controller + 远端 `interrupt`，等待结算 |
| 父 Agent 归属 | `activeRuns[agent]` 携带 `request.parent` → 审批卡/提问落到正确 dsh agent |
| 工具行 | profile 里 `tool-opencode-n100/m65`，`maxDepth: provider-managed` |

**真机证据（2026-11-20，opencode 2.3.0）**：

- `opencode_subagent_n100` / `opencode_subagent_m65` 启动后分别返回 `NATIVE_PROVIDER_N100_OK` / `NATIVE_PROVIDER_M65_OK`（异步启动 + 结算通知正常）；
- 远端 child session：父会话用 `task` 派生 `ses_e07ac7d25…`（`parentID` 正确、agent=general、succeeded），`opencode_children` 正确列出；
- 历史 seam 直测（OpenCode 1.18.31，v1 已移除）：`capabilities` 全 false、`activeRuns.agent is parent: true`、`result.stopReason=completed`、`dispose` 幂等、abort 路径 0.0s 结算。

---

## 3. 差距分析（按 capability）

### 3.1 `outputSchema`：**可以做**（当前 false）

seam 允许外部后端自行用"prompt 约束 + 本地校验"满足 schema：请求带 `outputSchema` 时在 prompt 追加"只返回 JSON"，解析后用本地 JSON Schema 子集校验，成功则 `result.structured = value`；失败返回 `stopReason: 'error'` + diagnostic（seam 明确允许"请求了 schema 也不保证 structured"）。

收益：
- 原生子代理工具（`opencode_subagent_n100`）本身**没有** `outputSchema` 参数（工具层不传），所以这条路主要服务**编程调用方**；
- **workflow 的 `agent(prompt, {schema})` 需要它**：provider 广告 `outputSchema: true` 后，workflow 脚本就能要求远端子代理返回结构化 JSON（否则 start 前被 seam 拒绝）。
代码点：`lib/provider.js`（start 前判定 + 结束解析校验）、`lib/run.js::parseStructured`（已有，可提升为 type/required 递归校验）。

### 3.2 `stopReason` 保真：**已实现（0.3.0）**

opencode v2 的 assistant 消息带 `finish: stop|length|tool-calls|content-filter|error|unknown`，可映射：

| opencode | dsh stopReason |
|---|---|
| `length` | `max-tokens` |
| `content-filter` | `refusal` |
| `error` / execution.failed | `error` |
| 用户中断 | `aborted` |
| 其它 | `completed` |

收益：dsh 工具层可以把 `max-tokens/refusal` 映射成更准确的 `isError` 与结算摘要。
实现：`lib/delegate.js`（`extractAssistant` 保留 `finish`/`error`）、`lib/provider.js`（`stopReasonFor`），
测试见 `test/provider.test.js`。

### 3.3 `agentOptions` / 模型选择：**有条件可做**

seam 的 `agentOptions = {provider, model, reasoningEffort, maxTokens}`，来源是 dsh 的 LLM 路由（`list_subagent_models` 列出的是 dsh provider/model）。opencode 的模型是 `{providerID, id, variant}`，两套目录**不同名**。

可行方案：插件配置加一张映射表（如 `subagentModelMap: {"qwen-token-plan-cn/deepseek-v4.1-flash": {providerID:"alibaba-token-plan-cn", id:"deepseek-v4.1-flash-1017", variant:"high"}}`），`agentOptions: true` 后工具层自动出现模型选择；`reasoningEffort` 映射到 opencode 的 `variant`；`maxTokens` 无对应 → 在 `start` 里**明确拒绝**（诚实失败），而不是忽略。
收益场景：
- per-provider 工具出现 `model`/`reasoning_effort` 参数（工具行需 `modelSelection: true`）；
- **workflow 的 `agent(prompt, {provider, model})` 需要它**（否则 start 前被拒绝）。
代价：需要维护映射表、文档化；不配置时退回 server 默认 agent/model（现状）。

### 3.4 `agentPreset` / `depthLimit`：**保持 false（做不到）**

`agentPreset` 是 dsh 的 agent 预设（system prompt/工具/权限组合），远端 opencode 没有对应概念；`depthLimit` 是 dsh 对子代理递归深度的强制预算，远端无法执行（工具行继续用 `provider-managed`）。

### 3.5 续聊 / `send_message` steer：**seam 不支持（正确保持 start-only）**

服务层 `deliverToMember` 对非本地激活调用 `requireLocalActivation` → 外部子代理无法接收后续消息；工具描述也明确"does not accept follow-up messages"。
替代：本插件的 `opencode_prompt(session=…)` 可在 seam 之外续聊（远端会话跨 dsh 回合存活），`opencode_progress` 看进度。

### 3.6 agent-team teammate：**不可行**

`dsh-agent-team` 只认 `mode === "continuable"` 的本地子代理（`listDescendants` 过滤），外部后端进不了 team。需要"队友"能力时只能选本地 provider（spawn/fork）。

### 3.7 生命周期事件：**可接入（当前未用）**

`subagent/start` / `subagent/end` 带 `runId/provider/parentSessionId/id/local/stopReason/lastAssistantMessage`。插件可订阅后在插件页/状态里显示"远端子代理树 + 每个 run 的 stopReason"，把现在的 `activeRuns` 内存表补成可观测视图（含结算后的历史）。

### 3.8 命名 / 树：**dsh 侧自动，插件只需配合**

dsh 会给每个子代理分配 `name`（`agent-N` 或命名路径）并维护 tree；插件侧目前用 session title（`dsh subagent: <label>`）对应。可以做得更好：把 `request.label` 同时写进远端会话 title（已做），结算通知里带 session id（已做），无需改 seam。

### 3.9 interrupt：**已覆盖**

dsh 的 `interrupt(user|ancestor)` 最终走 `dispose`/`signal`；插件 `dispose` 里已 abort + 远端 `interrupt`。可增强：把远端 `{interrupted:false}`（本来空闲）如实回报为"已结束"，而不是当成取消。

### 3.10 `delivery: parent|caller`：插件不参与

由工具层固定为 `parent`（父会话收结算通知）。若将来需要"静默调用"（不打扰父会话），只能自建工具或等工具层暴露配置。

---

## 4. 升级建议

| 优先级 | 内容 | 代码点 | 风险 |
|---|---|---|---|
| **P1（0.3.0，已完成）** | `stopReason` 保真映射（`finish=length→max-tokens`、`content-filter→refusal`、`error→error`） | `lib/delegate.js`、`lib/provider.js` | 低：纯本地映射 |
| **P2（0.4.0）** | `outputSchema: true` + 结构化校验（打通 workflow 的 `agent(...,{schema})`）；`subagentModelMap` + `agentOptions: true` + 工具行 `modelSelection: true`（打通 workflow 的 `agent(...,{provider,model})` 与工具模型选择）；`maxTokens` 明确拒绝 | `lib/config.js`、`lib/provider.js`、`lib/run.js`（校验器）、profile 配置 | 中：需维护映射；schema 不满足按 seam 语义返回 error |
| **P3（0.3.0，已完成）** | `opencode-auto` 路由 provider：directory → sticky → least-busy → round-robin，start 失败换台；工具行 `opencode_subagent_auto` | `lib/routing.js`、`lib/provider.js`、`lib/index.js`、`test/routing.test.js` | 中：多 server 时默认开启；续聊不路由 |
| **P2.5（配置级，无代码）** | 把 `workflow-ptc.provider` 切到 `opencode-<id>`（或 `opencode-auto`），让 workflow 编排跑在远端 opencode | profile patch（agent 工具组内嵌套条目） | 中高：远端并发/成本/延迟、cwd 映射需确认 |
| **P3（0.5.0）** | 订阅 `subagent/start|end`，插件页展示远端子代理运行/结算 | `lib/index.js`、`lib/routes.js`、`lib/client.js` | 低 |
| **不做** | `prepareContinuable`、`agentPreset`、`depthLimit`、team teammate、外部 `send_message` | — | seam 语义不支持 |

验证方式：`test/provider.test.js`（假 server 驱动 prompt/完成/abort，断言 `result.output/structured/stopReason/dispose` 幂等）；真机用 `opencode_subagent_n100` + 一个"故意超 token/结构化 JSON"的任务做 e2e。

---

## 4.1 0.3.0 真机验证（n100 + m65，OpenCode 2.3.0）

```text
1) cwd=/tmp          -> n100  completed "ok"   (directory policy: n100.directory=/tmp)
2) cwd=/home/yhuan    -> m65   completed "ok"   (directory policy: m65.directory=/home/yhuan)
3) round-robin(4)     -> n100 | m65 | n100 | m65
4) failover           -> broken(127.0.0.1:1) failed, routed -> n100 completed
5) missing dir        -> error: "opencode: m65 cannot see directory /home/yhuan/nope-dir
                         (LocationNotFoundError); configure pathMap ..."
```

## 5. 历史验证记录（0.2.1-rc.2 时期）

```text
name: opencode-n100 capabilities: {"agentOptions":false,"agentPreset":false,"outputSchema":false,"depthLimit":false}
run id: ses_e5047ca1cffe7bw1... | activeRuns.agent is parent: true
result: {"stopReason":"completed","text":"provider-ok"}
dispose idempotent: true

abort path (task runs sleep 120):
started: ses_e5047bbedffePCUY... | dispose+result took 0.0s | stopReason: aborted
```

[![](https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)