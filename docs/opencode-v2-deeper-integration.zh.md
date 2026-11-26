# OpenCode v2 深度整合机会（2.3.0 实测）

> 状态：**调研 + 实测**（2026-11-20；基线已随 0.7.1/0.7.2 前移——工具数 26 → 28，`opencode_usage` 已落地、未读分区已上线、v1 已冻结）。基线：`dsh-opencode-client` 0.2.0 已把 26 个工具在 v2 上跑通，共接入 **39 / 139** 个 OpenAPI path；本文盘点剩余 **100 个**未接入端点里值得做、且实测确认可行的整合方向。
>
> 关联：[docs/opencode-v2-migration.zh.md](opencode-v2-migration.zh.md)（v2 兼容迁移）、[COMPATIBILITY.md](../COMPATIBILITY.md)（支持矩阵）。

---

## 0. 结论摘要

1. **契约没有变化**：n100（192.168.4.50）与 e5（192.168.4.65）均为 `opencode 2.3.0`，`/openapi.json` 仍是 **139 paths / 515 schemas**，与 2026-11-18 迁移基线逐条比对无新增、无删除。所以现有 0.2.0 的适配仍然成立，不需要再改契约层。
2. **深度整合空间在 v2 独有的 6 类能力**（v1 没有或不可用）：
   - 消息队列 / steer（`inbox`、`delivery: steer|queue`、`resume`）
   - 检查点回滚（`revert/stage|commit|DELETE`）
   - 隔离工作区（`worktree`）
   - 会话运维（`stats`、`export/import`、`move`、`migration/v1`、`context`）
   - 定时调度（`experimental/schedule`，需远端开关）
   - PTY 终端（`pty`、`experimental/persistent-pty`、`experimental/session/{id}/terminal`）
   另有高价值/高风险的“远端能力管理”（MCP / plugin / config / integration）和“反向 MCP / RPC”（`client-mcp`、`rpc`、`pair`）。
3. **已实测可用**（本次在 n100 的 `/tmp` 临时会话上验证，见 §2）：`inbox` 队列/取消、`revert/stage` + discard、`generate`（不产生消息的一次性生成）、`export?sanitize=true`、`session/stats`、`migration/v1`、`worktree` 列表、`terminal` 列表。
4. **2.3.0 上 spec 存在但不可用 / 需开关**：`environment`(404)、`instructions/entries`(404)、`schedule`(403，需 `experimental.schedules`)、`artifacts`(403，需 `experimental.artifacts`)、`vcs/base`(503，需配置 review base)、`usage/limits`(返回 `data: null`)。

---

## 1. 现状：已接入 vs 未接入

已接入（39，0.2.0 实现）：`/api/info`、`/api/event`、`/api/project`、`/api/session`(GET/POST)、`/api/session/{id}`、`/message`、`/diff`、`/prompt`、`/agent`(session 级)、`/model`(session 级)、`/interrupt`、`/command`、`/shell`、`/compact`、`/fork`、`/form*`、`/permission*`、`/api/session/active`、`/api/agent`、`/api/model`、`/api/model/default`、`/api/provider`、`/api/command`、`/api/skill`、`/api/reference`、`/api/mcp`、`/api/vcs/status|diff`、`/api/fs/read/*|find`、`/api/shell*`、`/api/permission/request`、`/api/form`、`/api/experimental/session/{id}/wait`。

未接入的 100 个端点按主题归类：

| 主题 | 端点（节选） | 说明 |
|---|---|---|
| 会话控制 | `GET/PATCH/DELETE /api/session/{id}/inbox*`、`POST .../synthetic`、`POST .../move`、`POST .../view`、`GET .../context`、`GET .../message/{msgID}`、`POST .../generate`、`POST .../background` | 队列/插话、上下文检查、单条消息、一次性生成、会话搬目录、标记已读 |
| 检查点 | `POST .../revert/stage`、`POST .../revert/commit`、`DELETE .../revert` | 按 messageID 撤销文件改动：预览 → 应用 / 丢弃 |
| 会话运维 | `GET /api/experimental/session/stats`、`.../{id}/export`、`POST .../session/import`、`GET /api/experimental/migration/v1`、`GET .../{id}/log` | 用量/成本聚合、导出导入、v1→v2 迁移状态、事件日志流 |
| 工作区 | `GET/POST/DELETE /api/worktree`、`POST /api/vcs/init`、`GET /api/vcs`、`GET /api/vcs/branch`、`POST /api/experimental/fs/write`、`POST/DELETE .../fs/watch`、`GET /api/fs/list` | 隔离 worktree、仓库/分支信息、写文件与监听 |
| 终端 | `GET/POST /api/pty*`、`/api/experimental/persistent-pty/*`、`GET/POST /api/experimental/session/{id}/terminal*` | 交互式 shell / 会话终端（`capabilities.persistentPty: true`） |
| 调度 | `GET/POST /api/experimental/schedule*` | 按会话定时注入 prompt（需远端 `experimental.schedules`） |
| 权限 | `GET /api/permission/saved`、`PATCH/DELETE /api/permission/saved/{id}`、`GET .../permission/{requestID}` | 持久化审批规则的管理与查看 |
| 远端能力管理 | `/api/experimental/mcp/{server}`(PUT/DELETE)、`/connect`、`/disconnect`、`GET /api/plugin`、`POST /api/plugin/update`、`PATCH /api/experimental/config`、`/api/integration*`、`/api/credential*` | 管理远端 opencode 的 MCP/插件/配置/凭据/集成 |
| 反向调用 | `GET/POST /api/experimental/client-mcp*`、`POST /api/rpc/{rpcID}/{method}`、`POST /api/pair` | 让远端 agent 用客户端提供的 MCP；调用远端插件 RPC；配对拿 ticket |
| 产物 | `GET/POST/PATCH/DELETE /api/experimental/artifacts*`、`.../view/*` | agent 产物托管（需远端 `experimental.artifacts`） |
| 其它 | `GET /api/config`、`GET /api/config/shell`、`GET /api/websearch/provider`、`POST /api/websearch`、`GET /api/location`、`GET /api/agent/{id}`、`GET /api/provider/{id}`、`/api/debug/*`、`/api/experimental/voice/*` | 配置/能力/位置/agent 详情/调试/语音等 |

---

## 2. 实测证据（n100，2.3.0）

| 调用 | 结果 | 结论 |
|---|---|---|
| `POST /api/session`（body `location.directory=/tmp`） | 200 | 建会话正常 |
| `POST .../prompt`（默认 `delivery: steer`） | 200 `{data:{id,...,delivery:"steer"}}` | 默认 steer |
| `POST .../prompt` + `{"delivery":"queue"}`（会话运行中） | 200 | 进入队列 |
| `GET /api/session/{id}/inbox` | 200，`items=1`（payload/delivery 可见） | 队列可观察 |
| `PATCH .../inbox/{msgID}` `{"delivery":"steer"}` | 204 | 可改投递方式 |
| `DELETE .../inbox/{msgID}` | 204，之后 inbox=0 | 可取消待发消息 |
| `POST .../revert/stage` `{messageID, files:true}` | 200 `{data:{messageID, files:[]}}` | 检查点 API 可用（本用例文件经 shell 创建，未进 snapshot 所以 files 为空） |
| `DELETE .../revert` | 204 | 丢弃 staged 回滚 |
| `POST .../generate` `{"prompt":"Summarize..."}` | 200 `{data:{text,tokens,cost}}` | **不产生消息**的一次性生成（可做摘要/标题） |
| `GET /api/experimental/session/{id}/export?sanitize=true` | 200，~3.7KB `{data}` | 导出可用，支持脱敏 |
| `GET /api/experimental/migration/v1` | 200 `{"status":"completed"}` | 可暴露"旧会话是否已迁移"诊断 |
| `GET /api/experimental/session/stats` | 200：`sessions 248 / prompts 4142 / steps 50669 / cost $106.8 / tools calls 52743(success 52342, failed 399, unfinished 2) / activeDays 77 / streak 6 / activity[]` | 聚合统计可直接做面板/预算 |
| `GET /api/location` | 200：`{directory, project:{id,directory,canonical}}` | 目录→项目解析，worktree 需要 projectID |
| `GET /api/worktree?projectID=…` | 200 `[{directory}]` | worktree 列表可用 |
| `GET /api/experimental/session/{id}/terminal` | 200 `{data:[]}` | 终端列表可用 |
| `GET /api/session/{id}/context` | 200 `{data:[message…]}` | 模型实际上下文可读 |
| `GET /api/session/{id}/environment` | **404** | 2.3.0 未实现 |
| `GET /api/session/{id}/instructions/entries` | **404** | 2.3.0 未实现 |
| `GET /api/experimental/schedule?sessionID=…` | **403** `Scheduled tasks are disabled; set experimental.schedules in config` | 需远端开关 |
| `GET /api/experimental/artifacts/providers` | **403** `Artifacts are disabled; set experimental.artifacts in config` | 需远端开关 |
| `GET /api/vcs/base` | **503** `Choose a review base` | 需在 opencode 配置 review base |
| `GET /api/experimental/usage/limits` | 200 `{data:null}` | 本机无 plan limits |

---

## 3. 候选整合方向（按价值 / 成本 / 风险）

### A. 消息队列与中途插话（高价值 / 低成本 / 低风险）→ 建议 0.3.0

现状：`opencode_prompt` 只有 fire-and-forget 或阻塞等待，运行中无法追加/排队/撤回。

- `prompt`/`synthetic` 增加 `delivery: steer|queue`、`resume` 参数；
- 新工具 `opencode_inbox`：列出某会话队列、`PATCH` 改投递方式、`DELETE` 取消；
- 价值：dsh 可以在远端跑长任务时"插话纠正方向"、连续排两条指令、发现跑偏时撤回未发消息，而不必 abort 重开。

### B. 检查点 / 回滚（高价值 / 低成本 / 中风险）→ 建议 0.3.0

- 新工具 `opencode_revert`：`stage(messageID)` 预览将撤销的文件 → dsh 审批卡确认 → `commit` 应用；`discard` 放弃；
- 与 `opencode_fork` 组合：分叉 → 回滚到某点 → 重跑，形成"安全试错"；
- 风险：回滚会改远端工作区，必须走审批；且只有经 write/edit 工具产生的文件才进 snapshot（shell 创建的文件可能不在 `files` 里，需在工具描述里说清）。

### C. worktree 隔离委派（高价值 / 中成本 / 中风险）→ 建议 0.4.0

- 新工具 `opencode_worktree`：`create(projectID, from|branch, directory, name)` → `list` → `remove`；
- 典型流程：为一次委派建独立 worktree → 会话建在 worktree 目录 → 完成后 `git_diff` 验收 → 合并或删除；
- 与 dsh 自身 worktree 能力对齐，解决"远端 agent 直接改主工作区"的风险。

### D. 观测 / 成本（中高价值 / 低成本 / 无风险）→ 建议 0.4.0

- 新工具 `opencode_usage`（0.7.1 已落地；参数收敛为 `server` / `days`，默认 7 天、`0` = 全部历史）：会话数、prompt/step、token、成本、工具成功率、活跃度；
- `opencode_session_info` 增加 context 规模（message 数 / token 估算）；
- 预算护栏：按 `stats` 的**日窗口成本**设阈值并告警（与目录归因同源；`usage/limits` 本机为空，需自建预算表）。
  **不要用 `session.cost`**——实测它是终生累计，跨窗口会重复计入。

### E. 会话运维（中价值 / 低成本 / 中风险）→ 建议 0.4.0

- `export`（支持 `sanitize`）+ `import`：n100↔e5 迁移会话、归档到 dsh、脱敏分享给同事；
- `move`：把会话搬到另一个目录（"把这个会话挪进新项目"）；
- `migration/v1`：升级 v2 后诊断"旧 v1 会话是否已迁移"（直接回应迁移文档 §6 R6 的用户痛点）；
- `view`：标记会话已读，影响 UI 未读状态。

### F. 调度桥（中价值 / 中成本 / 中风险）→ 建议 0.5.0

- opencode 自带 per-session schedule（`when`/`if`/`until`/`ends`/`prompt`），需远端 `experimental.schedules: true`；
- 可做双向桥：dsh `schedule` 到点 → 给远端 session 发 prompt；或把远端 schedule 同步展示到 dsh；
- 注意：这是"远端定时自动执行"，必须可见/可暂停（`schedule/{id}/pause|resume`）。

### G. PTY / 终端（中价值 / 中高成本 / 低风险）→ 建议 0.5.0

- `pty` + `persistent-pty`（handoff/shutdown/connect-token）+ per-session `terminal`；
- 价值：插件页嵌入远端交互式终端（长驻进程、REPL、调试），比现有 `opencode_shell`（一次性、异步、无交互）强；
- 成本：需要前端 xterm + websocket 连接协议（`connect-token` + `input_protocol`）。

### H. 远端能力管理（高价值 / 中成本 / **高风险**）→ 需单独设计

- `/api/experimental/mcp/{server}` PUT/DELETE + connect/disconnect：dsh 里统一管理远端 opencode 的 MCP 服务器（现在只能读状态）；
- `plugin` 列表/更新、`PATCH /api/experimental/config`、`integration`（OAuth/key 连接）、`credential`；
- 风险：都是在改远端环境，且 `credential`/`config` 可能触及凭据；建议"只读展示 + 写操作强制审批 + 不碰 credential"。

### I. 反向 MCP / RPC（**最高价值 / 高复杂度 / 高信任风险**）→ 单独立项

- `POST /api/experimental/client-mcp/token` + `GET /api/experimental/client-mcp?name=&ticket=`：让**远端 opencode agent 调用 dsh 暴露的 MCP 工具**（把 dsh 的设备/云/串口/媒体能力反向注入远端 agent）；
- `POST /api/rpc/{rpcID}/{method}`：调用远端 opencode 插件注册的 RPC；
- 需要 `pair`（PairingCode）与 ticket 生命周期设计、工具白名单、审计；
- 一旦做成，dsh 与 opencode 从"单向委派"变成"能力互补"。

### J. Artifacts（中价值 / 低成本 / 前置条件）

- 需远端 `experimental.artifacts: true`；开启后 agent 产物（HTML 报告、图片、数据集）可由 dsh 展示/下载（`/api/experimental/artifacts/{id}/view/*`）；
- 对"委派做完的交付物"场景很合适，但依赖远端配置，作为可选能力。

---

## 4. 风险与安全要点

| 风险 | 涉及 | 建议 |
|---|---|---|
| 改远端工作区/文件 | revert、move、fs/write、worktree remove | 强制 dsh 审批卡 + 默认只读工具 |
| 改远端配置/凭据 | mcp、config、credential、integration、plugin | 只读展示优先；写操作逐条确认；不暴露凭据明文 |
| 远端定时执行 | schedule | 展示 nextDue/status，支持 pause/resume；默认关闭 |
| 反向信任 | client-mcp、rpc、pair | 工具白名单 + ticket 短时效 + 审计日志 |
| 长会话导出含敏感内容 | export | 默认 `sanitize=true`；输出前提示大小 |

---

## 5. 建议路线与版本策略

| 版本 | 内容 | 备注 |
|---|---|---|
| **0.3.0** | A 消息队列/steer + B 检查点回滚 | 纯 API、收益最大、风险可控（回滚走审批） |
| **0.4.0** | C worktree + D 观测/成本 + E 会话运维（export/import/move/migration） | 运维与安全能力 |
| **0.5.0** | F 调度桥 + G PTY 终端 | 需要前端/远端开关配合 |
| 待定 | H 远端能力管理、I 反向 MCP/RPC、J artifacts | 单独设计 + 安全评审 |

配套：
- 把本文 §2 的探针固化成 `scripts/e2e-v2-deep.mjs`（可选 nightly，检测新端点是否可用/失效）；
- 继续用 `/api/info` 版本 + 契约测试守护：2.3.x 小版本升级时重跑 139 paths 的 diff，而不是只测我们已接入的 39 个。

---

## 附：本次实测脚本

临时脚本（不随仓库发布）：`/tmp/deep-probe.mjs`、`/tmp/env-probe2.mjs`，用 `fetch` + Basic auth 直连 `http://192.168.4.50:4096`，覆盖 §2 表格中的端点。关键片段：

```js
const r = await fetch(H + `/api/session/${SID}/prompt`, {
  method: 'POST',
  headers: { authorization: AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'QUEUED_SECOND_MESSAGE', delivery: 'queue' }),
})
// 队列可见、可 PATCH(steer)、可 DELETE 取消
```

[![](https://img.shields.io/badge/powered_by_dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)