# 架构

`dsh-opencode-client` 是一个 dsh 插件（宿主插件 + Web client bundle），把一台或多台远端
`opencode serve` 当作自己的后端。它不重新实现 OpenCode；它是宿主在 dsh 里的另一个 OpenCode
客户端。

## 进程 / 组件地图

```text
dsh web 宿主进程
├── lib/index.js                 装配：config → services → routes/providers/tools/SSE
│   ├── lib/config.js            normalizeServers / parseModel / parsePathMap
│   ├── lib/http.js              opencodeRequest（按 server 加头、directory、超时）
│   ├── lib/sessions.js          discovery、messages、status、agents、session-info、share、abort
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP
│   ├── lib/workspace.js         shell、git status/diff、read file、find
│   ├── lib/manage.js            fork、children、summarize、init
│   ├── lib/delegate.js          promptBody、extractAssistant、waitAssistant、asyncPrompt
│   ├── lib/session-run.js       共享生命周期：ensureSession、trackRun、sendSessionMessage、abortRemote
│   ├── lib/run.js               opencode_subagent 委派（session= 续用、schema）
│   ├── lib/provider.js          原生 dsh subagent provider（外部后端）
│   ├── lib/interactions.js      远端 permission/question → dsh approval / userQuestions
│   ├── lib/sse.js               每台 server 的 /global/event 流；progress、idle 监听、events 环形缓冲
│   ├── lib/routes.js            /api/opencode-client/* 宿主 HTTP 路由
│   └── lib/tools.js             26 个面向模型的 opencode_* 工具
└── lib/client.js                浏览器 bundle：「OpenCode Client」插件页区块

远端机器
└── opencode serve               HTTP API（v1 基线）+ SSE /global/event
```

## 数据流

### 工具 / 路由调用（直接操作）

```text
模型工具调用 ──▶ lib/tools.js ──▶ lib/http.js ──▶ opencode HTTP API（远端）
HTTP 路由调用 ──▶ lib/routes.js ─┘
```

直接调用从不经过远端模型：shell 命令、文件读取、git status/diff、目录列举、搜索、abort、
消息发送都是确定性的 HTTP 请求。

### 委派（agent 中介）

```text
opencode_subagent / 原生 subagent
  → ensureSession（新建或复用；标题 "dsh delegate" / "dsh subagent: <label>"）
  → trackRun（activeRuns + 交互桥 + snapshot 失效）
  → POST /session/{id}/prompt_async
  → 等待：SSE session.idle（立即）+ 5s 消息轮询兜底
  → 结算：text output / stopReason；清理跟踪
```

原生 provider（`lib/provider.js`）实现 dsh 的进程外接缝
（`start → {id, result, dispose}`），并复用与 `opencode_subagent` 工具完全相同的生命周期。
详见 `docs/subagent-seam.md`。

### SSE 管道

```text
GET /global/event（每台 server，重连/退避）
  → 解析 v1 事件：message.part.updated / message.part.delta / session.status / session.idle
  → server.sessionState（running）         → GET /list、/status
  → server.progress（tool、elapsed、tail） → opencode_progress、/progress、activeTool
  → session.idle 监听器                    → 委派的完成等待
  → permission.asked / question.asked      → 交互桥（审批卡 / 用户提问）
```

### 交互桥

```text
远端 permission.asked ──▶ interactions.handlePermission
  ├─ run 有 dsh agent 且 permission: ask → ctx.approval.request → POST /permission/{id}/reply
  └─ 否则                                → 确定性 allow/reject
远端 question.asked  ──▶ 仅工具发起的 run 转发（ctx.userQuestions.ask），否则拒绝
```

## 设计决策

| 决策 | 理由 |
|---|---|
| v1 HTTP API 为基线；仅在 v1 缺能力时用 v2（会话搜索、兜底） | v1 在已验证版本（1.18.10/31/33）上稳定；v2 的 `wait` 上游 503 |
| 结构化输出用 prompt 约束，而非 `format=` | 上游 bug 会毒化消息读取（400 BadRequest） |
| 原生 subagent provider 不声明任何能力 | 远端后端无法兑现 `agentOptions`/`outputSchema`/`maxDepth`；在 start 前就拒绝 |
| 共享同一条 session-run 生命周期 | 委派工具与原生 provider 不能在时序/中止/清理上产生漂移 |
| 多 server 在客户端聚合 | opencode 没有服务端联邦 |
| 插件页以只读展示 + 打开 OpenCode 为主 | 深度编辑交互属于 OpenCode UI |

## 新增功能的检查清单

1. 在对应模块（`sessions`/`catalog`/`workspace`/`manage`）里加纯 API 辅助函数；不要把 HTTP 调用
   直接写进 `tools.js`。
2. 只有 Web 页面或外部客户端需要时才在 `lib/routes.js` 加路由。
3. 在 `lib/tools.js` 加工具（通过 `ctx.effect` 注册；依赖从 `lib/index.js` 传入）。
4. 需要新服务/选项时在 `lib/index.js` 里装配。
5. 新增应被冒烟检查的模块导出时更新 `scripts/check.mjs`。
6. 文档：README 功能列表、CHANGELOG、TODO 清单。
