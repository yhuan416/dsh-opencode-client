# 架构

`dsh-opencode-client` 是一个 dsh 插件（宿主插件 + Web client bundle），把一台或多台远端
`opencode serve` 当作自己的后端。它不重新实现 OpenCode；它是宿主在 dsh 里的另一个 OpenCode
客户端。**只支持 OpenCode 2.x**（`/api/*` + HTTP Basic）；版本按 server 独立探测，v1 会被
拒绝，工具与路由只消费归一化后的接口。HTTP 调用走官方 `@opencode/client`，并锁定精确版本
（`2.4.2`）。

## 进程 / 组件地图

```text
dsh web 宿主进程
├── lib/index.js                 装配：config → services → routes/providers/tools/SSE；启动时探测并记录每台 server 的 API 版本
│   ├── lib/config.js            normalizeServers / normalizeApiVersion / parseModel / parsePathMap
│   ├── lib/http.js              版本探测（ensureApiVersion / apiVersionOf）、Basic、OpenCodeError、
│   │                            v1 拒绝、location 辅助
│   ├── lib/oc-client.js         每台 server 的 @opencode/client 工厂（id+url+password）、调用超时、
│   │                            错误映射（ocCall / resetOcClients）
│   ├── lib/events.js            v2 事件模型：线上格式 → canonical event，completionKind
│   ├── lib/sessions.js          归一化读面：discovery、messages、status、agents、session-info、share、abort、
│   │                            usage/stats 与按目录成本归因
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP
│   ├── lib/workspace.js         异步 shell（提交/轮询/读输出）、git status/diff、read file、find
│   ├── lib/manage.js            fork、children、summarize/compact、init
│   ├── lib/delegate.js          prompt 构造（{text, files}）、extractAssistant、waitAssistant、
│   │                            syncPrompt/asyncPrompt
│   ├── lib/session-run.js       共享生命周期：ensureSession、prepareTurn、trackRun、sendSessionMessage、abortRemote
│   ├── lib/run.js               opencode_subagent 委派（session= 续用、schema）
│   ├── lib/provider.js          原生 dsh subagent provider（外部后端）
│   ├── lib/interactions.js      远端 permission/form → dsh approval / userQuestions
│   ├── lib/sse.js               每台 server 的 SSE（/api/event）；progress、idle 监听、events 环形缓冲
│   ├── lib/observation.js       (server, session) 登记表：running/待办/后台任务/SSE/未读合并成一份状态
│   │                            （未读不自己记：取 OpenCode 的 time.idle > time.viewed）
│   ├── lib/jobs.js              v2 后台任务（`/experimental/job`）：活过回合的工作（脚本还在跑、会话已 idle）
│   ├── lib/insights.js          看板顶部洞察（7/30 天）：stats + 会话计数的窗口内聚合
│   ├── lib/skills.js            技能加载明细：扫消息取 skill 的 input.id（懒加载、缓存）
│   ├── lib/version.js          是否有新版：查官方更新服务（启动 + 每天一次，24 小时缓存，失败不显示）
│   ├── lib/board.js             /board、/list 行内状态与 opencode_board 共用的刷新器
│   ├── lib/routes.js            /api/opencode-client/* 宿主 HTTP 路由
│   └── lib/tools.js             28 个面向模型的 opencode_* 工具
└── lib/client.js                浏览器 bundle：「OpenCode Client」插件页区块

远端机器
└── opencode serve               OpenCode 2 HTTP API（`/api/*` + Basic）+ SSE
```

## OpenCode 2 分层

| 层 | OpenCode 2 | 代码 |
|---|---|---|
| 传输 / 认证 | 探测 `GET /api/info`（Basic，用户名 `opencode`）；调用走 `@opencode/client`（`2.4.2`）；v1 应答以 `opencode.v1_unsupported` 拒绝 | `http.js`、`oc-client.js` |
| 会话读面 | `/info`、`/project`（`canonical`）、`/session`（`{data,cursor}`、`location.directory`）、`/agent`（`id`/`name`/`mode`/`hidden`）、`/session/active` | `sessions.js` |
| 消息 | `content[]`；按 `cursor` 分页（首页 `order=desc`），输出反转为旧→新 | `sessions.js` |
| 模型 / 命令 / 工具发现 | `/provider` + `/model` + `/model/default`、`/command`、`/skill`、`/mcp`（`status` 对象）；无 tool-ids 端点 | `catalog.js` |
| 委派 / 提示词 | `{text,files:[{uri,name}]}`；agent/model 为会话状态（创建时写入或 `POST /session/{id}/agent` / `/model`）；`/prompt` | `delegate.js`、`session-run.js`、`run.js` |
| 完成检测 | `session.execution.succeeded` / `failed` / `interrupted` + `idle` 消息的 `outcome` | `events.js`、`delegate.js` |
| 交互 | 会话作用域 `/session/{sid}/permission/{rid}/reply {decision}`、`/session/{sid}/form` + `/reply {answer}` / `DELETE`；SSE 事件驱动 + run 作用域轮询兜底 | `interactions.js` |
| 工作区 | 异步 `/shell` → `/shell/{id}` → `/shell/{id}/output`、`/vcs/*`（`mode=working` / `branch` / `committed`）、原始 `/fs/read`、`/fs/find`（仅文件） | `workspace.js` |
| 管理 | `/fork {before}`、`/compact`、内置 `init` 命令、`/session?parentID=` | `manage.js` |
| 看板洞察 | `/experimental/session/stats`（tools=detail）+ 会话计数的窗口聚合；日序列只含 steps | `insights.js` |
| 技能使用 | 扫会话消息里的 `skill` 调用与 `input.id`（懒加载端点、10 分钟缓存、`truncated` 标记） | `skills.js` |
| 升级提示 | 官方更新服务（本地 API 没有检查端点）；启动 + 每天一次、24 小时缓存，失败隐藏徽标 | `version.js` |
| 后台任务 | `/experimental/job`（实验性）列出运行中的任务；即使 `time.idle` 已置，看板仍显示 `background` | `jobs.js`、`observation.js` |
| 已移除的 v1 端点 | 无 share/tool-ids；文本 find 与会话 todo 用 v2 原生能力补回（workspace `grep`；todo 从 `todowrite` 推导），绝不静默返回空数据 | `sessions.js`、`catalog.js`、`workspace.js` |

读面在 `sessions` / `catalog` / `workspace` / `manage` 归一化，`tools.js` 和 `routes.js` 不判断
版本；`delegate.js` 与 `session-run.js` 负责提示词/完成检测；`interactions.js` 负责交互协议；
`events.js` 负责 v2 线上事件到 canonical event 的映射。

## 数据流

### 工具 / 路由调用（直接操作）

```text
模型工具调用 ──▶ lib/tools.js ──▶ lib/oc-client.js ──▶ @opencode/client ──▶ opencode HTTP API
HTTP 路由调用 ──▶ lib/routes.js ─┘
```

`oc-client.js` 每台 server（id + url + password）缓存一个 client，负责调用超时并把 client 错误
映射成 `OpenCodeError`；路径、Basic 认证与响应包络由 `@opencode/client` 负责。`http.js` 仍负责
`/api/info` 探测、少量诊断调用的 Basic 认证与 v1 拒绝。tools / routes 不感知版本；不支持的端点
或参数在模块内转成明确的 `OpenCodeError` 或工具错误文本，不会退化成空数据。

直接调用从不经过远端模型：shell 命令、文件读取、git status/diff、目录列举、搜索、abort、
消息发送都是确定性的 HTTP 请求。

### 委派（agent 中介）

```text
opencode_subagent / 原生 subagent
  → ensureSession（新建或复用；标题 "dsh delegate" / "dsh subagent: <label>"）
       新建：body 带 location.directory + agent/model
  → trackRun（activeRuns + 交互桥 + snapshot 失效）
  → prepareTurn（续聊：POST /session/{id}/agent、/session/{id}/model 写入会话状态）
  → buildPrompt（{text, files:[{uri,name}]}）
  → POST /session/{id}/prompt
  → 等待：SSE 完成事件 + 消息轮询兜底（有订阅 5s 间隔，无订阅 1.5s）
       session.execution.* / idle 消息 outcome
  → 结算：text output / structured；清理跟踪
```

原生 provider（`lib/provider.js`）实现 dsh 的进程外接缝
（`start → {id, result, dispose}`），并复用与 `opencode_subagent` 工具完全相同的生命周期。
详见 `docs/subagent-seam.md`。

### SSE 管道

```text
GET /api/event（Basic），每台 server，重连/退避
  → normalizeEvent（lib/events.js）：session.text / reasoning / tool / step / execution.* /
    permission.* / form.* → canonical event
  → completionKind：仅 session.execution.*
  → server.sessionState（running）         → GET /list、/status（/session/active）
  → server.progress（tool、elapsed、tail） → opencode_progress、/progress、activeTool
  → 完成监听（execution.succeeded / failed / interrupted） → 委派等待
  → permission.asked / form.created → 交互桥（SSE 快路径）
  → 同一 canonical 事件也交给 run 作用域的 watchInteractions 轮询兜底
    （session 级 /session/{sid}/permission、/form）
```

### 交互桥

```text
远端 permission.asked ──▶ interactions.handlePermission
  ├─ run 有 dsh agent 且 permission: ask → ctx.approval.request
  │    └ POST /session/{sid}/permission/{rid}/reply {decision: once|always|reject}
  └─ 否则                                → 确定性 allow/reject
远端 form.created ──▶ 仅工具发起的 run 转发（ctx.userQuestions.ask），否则拒绝
  └ POST /session/{sid}/form/{fid}/reply {answer:{key:value}}，取消用 DELETE
```

表单字段带类型（`string` / `number` / `integer` / `boolean` / `multiselect`），回答按字段
`key` 组装成 `{key: value}`；取消（reject / 用户关闭）走 `DELETE`。

## 设计决策

| 决策 | 理由 |
|---|---|
| 只支持 OpenCode 2，v1 在传输层拒绝 | 只维护一代读面，代码与测试都更小；旧 server 得到明确错误而不是静默降级 |
| 读面在 `sessions` / `catalog` / `workspace` 归一化 | 所有工具只消费统一形状，API 差异集中、可测试，不会泄漏到工具定义 |
| `@opencode/client` 锁定精确版本 | 升级是刻意行为：先验证兼容性，再单独发版抬高 pin |
| 探测一次并记录失败原因 | 401 表示密码错误；其它失败可在启动日志与 `server.versionProbe` 诊断，而不是静默 |
| 传输失败一律抛 `OpenCodeError`，不降级为空数据 | 401、HTML/SPA、非 JSON、非 2xx、超时都是显式错误，避免“0 条结果”掩盖真实故障 |
| v2 无对应端点的能力：能补则补，不能补才显式失败 | 文本 find / session todo 用 v2 原生能力补回；share、tool ids 没有替代端点，返回明确错误/提示 |
| 结构化输出用 prompt 约束，而非 `format=` | schema 跨模型可移植，结果在本地校验 |
| 原生 subagent provider 不声明任何能力 | 远端后端无法兑现 `agentOptions`/`outputSchema`/`maxDepth`；在 start 前就拒绝 |
| 共享同一条 session-run 生命周期 | 委派工具与原生 provider 不能在时序/中止/清理上产生漂移 |
| 多 server 在客户端聚合 | opencode 没有服务端联邦 |
| 插件页以只读展示 + 打开 OpenCode 为主 | 深度编辑交互属于 OpenCode UI |

## 新增功能的检查清单

1. 在对应模块（`sessions`/`catalog`/`workspace`/`manage`）里加纯 API 辅助函数；使用
   `ocCall` + `@opencode/client`，不要把 HTTP 调用或版本判断写进 `tools.js`。
2. 新端点先核对 OpenCode 2 的路径、包络与目录作用域，并在 `test/v2-surface.test.js` 补用例。
3. 只有 Web 页面或外部客户端需要时才在 `lib/routes.js` 加路由。
4. 在 `lib/tools.js` 加工具（通过 `ctx.effect` 注册；依赖从 `lib/index.js` 传入）。
5. 需要新服务/选项时在 `lib/index.js` 里装配。
6. 新增应被冒烟检查的模块导出时更新 `scripts/check.mjs`。
7. 文档：README 功能列表、CHANGELOG、COMPATIBILITY、TODO 清单。
