# 架构

`dsh-opencode-client` 是一个 dsh 插件（宿主插件 + Web client bundle），把一台或多台远端
`opencode serve` 当作自己的后端。它不重新实现 OpenCode；它是宿主在 dsh 里的另一个 OpenCode
客户端。同一份代码同时支持 OpenCode 1.18.x（v1 API）和 OpenCode 2.x（v2 API：`/api/*` +
HTTP Basic）；版本按 server 独立探测，工具与路由只消费归一化后的接口。

## 进程 / 组件地图

```text
dsh web 宿主进程
├── lib/index.js                 装配：config → services → routes/providers/tools/SSE；启动时探测并记录每台 server 的 API 版本
│   ├── lib/config.js            normalizeServers / normalizeApiVersion / parseModel / parsePathMap
│   ├── lib/http.js              传输层：版本探测（ensureApiVersion / apiVersionOf）、/api 前缀（apiPath）、
│   │                            Basic、OpenCodeError；v2 包络解包（unwrap / unwrapList / opencodeValue /
│   │                            opencodeRaw / directoryQuery / withLocation）
│   ├── lib/events.js            统一 v1/v2 事件模型：线上格式 → canonical event，completionKind 版本分流
│   ├── lib/sessions.js          归一化读面：discovery、messages、status、agents、session-info、share、abort、
│   │                            usage/stats 与按目录成本归因
│   ├── lib/catalog.js           models/commands/skills/tools/references/search/MCP；v2 的 provider+model、
│   │                            异步 command 与“仅 v1”能力
│   ├── lib/workspace.js         shell（v1 同步 / v2 异步轮询）、git status/diff、read file、find
│   ├── lib/manage.js            fork、children、summarize/compact、init
│   ├── lib/delegate.js          prompt 构造（v1 parts / v2 text+files）、extractAssistant、waitAssistant、
│   │                            syncPrompt/asyncPrompt
│   ├── lib/session-run.js       共享生命周期：ensureSession、prepareTurn、trackRun、sendSessionMessage、abortRemote
│   ├── lib/run.js               opencode_subagent 委派（session= 续用、schema）
│   ├── lib/provider.js          原生 dsh subagent provider（外部后端）
│   ├── lib/interactions.js      远端 permission/question → dsh approval / userQuestions
│   │                            （v1 全局 / v2 会话作用域 + 表单）
│   ├── lib/sse.js               每台 server 的 SSE（v1 /global/event、v2 /api/event）；progress、idle 监听、events 环形缓冲
│   ├── lib/observation.js       (server, session) 登记表：running/待办/后台任务/SSE/未读合并成一份状态
│   │                            （未读不自己记：取 OpenCode 的 time.idle > time.viewed）
│   ├── lib/jobs.js              v2 后台任务（`/experimental/job`）：活过回合的工作（脚本还在跑、会话已 idle）
│   ├── lib/insights.js          看板顶部近 7 天洞察：stats + 会话计数的窗口内聚合
│   ├── lib/board.js             /board、/list 行内状态与 opencode_board 共用的刷新器
│   ├── lib/routes.js            /api/opencode-client/* 宿主 HTTP 路由
│   └── lib/tools.js             28 个面向模型的 opencode_* 工具
└── lib/client.js                浏览器 bundle：「OpenCode Client」插件页区块

远端机器
└── opencode serve               HTTP API（v1 `/session` 等；v2 `/api/*` + Basic）+ SSE
```

## v1 / v2 分层

| 层 | v1（1.18.x） | v2（2.x） | 代码 |
|---|---|---|---|
| 传输 / 认证 | 不加 `/api` 前缀；配置了 `password` 才带 Basic | 探测 `GET /api/info`（Basic，用户名 `opencode`），版本 >= 2 后所有请求加 `/api`；缺密码直接按 v1 处理，401 / 非 JSON / 不可达则回退 v1 并记录原因 | `http.js` |
| 会话读面 | `/global/health`、`/project`（`worktree`）、`/session`、`/agent`（`name`/`native`）、`/session/status` | `/info`、`/project`（`canonical`）、`/session`（`{data,cursor}`、`location.directory`）、`/agent`（`id`/`name`/`mode`/`hidden`）、`/session/active` | `sessions.js` |
| 消息 | `info` + `parts` | `content[]`；`order=desc` 取回，输出反转为旧→新 | `sessions.js` |
| 模型 / 命令 / 工具发现 | `/config/providers`、`/command`、`/skill`、`/experimental/tool/ids`、`/mcp` | `/provider` + `/model` + `/model/default`、`/command`（仅 name/description）、`/skill`（`path`）、无 tool ids、`/mcp`（`status` 对象） | `catalog.js` |
| 委派 / 提示词 | `parts` + prompt 内 `agent`/`model`；`prompt_async`，失败回退阻塞 `/message` | `{text,files:[{uri,name}]}`；agent/model 为会话状态（创建时写入或 `POST /session/{id}/agent` / `/model`）；`/prompt` | `delegate.js`、`session-run.js`、`run.js` |
| 完成检测 | `session.idle` / `session.error` + 消息轮询 | `session.execution.succeeded` / `failed` / `interrupted` + `idle` 消息的 `outcome` | `events.js`、`delegate.js` |
| 交互 | 全局 `/permission`、`/question` + `/reply` / `/reject`，SSE 事件驱动 | 会话作用域 `/session/{sid}/permission/{rid}/reply {decision}`、`/session/{sid}/form` + `/reply {answer}` / `DELETE`；SSE 事件驱动 + run 作用域轮询兜底 | `interactions.js` |
| 工作区 | 同步 `/session/{id}/shell`、`/vcs/*`、`/file/content`、`/find/file`、`/find` | 异步 `/shell` → `/shell/{id}` → `/shell/{id}/output`、`/vcs/*`（`mode=working` / `branch` / `committed`）、原始 `/fs/read/*`、`/fs/find`（仅文件） | `workspace.js` |
| 管理 | `/fork {messageID}`、`/summarize`、`/init`、`/children` | `/fork {before}`、`/compact`、内置 `init` 命令、`/session?parentID=` | `manage.js` |
| 仅 v1（保持显式失败） | share、tool ids | 无端点：显式报错，绝不返回静默空数据 | `sessions.js`、`catalog.js` |
| v2 回退实现 | 文本 find、session todo、消息分页、模型 variants | 文本搜索走 workspace `grep`；todo 从 `todowrite` 推导；消息跟随 cursor；variants 透出 | `workspace.js`、`sessions.js`、`catalog.js` |

版本分流的落点是“读面归一化 + 写路径按版本分支”：`sessions` / `catalog` / `workspace` / `manage`
返回统一形状，`tools.js` 和 `routes.js` 不判断版本；`delegate.js` 与 `session-run.js` 负责提示词/
完成检测的差异；`interactions.js` 负责交互协议差异；`events.js` 负责线上事件到 canonical event
的映射。

## 数据流

### 工具 / 路由调用（直接操作）

```text
模型工具调用 ──▶ lib/tools.js ──▶ lib/http.js ──▶ opencode HTTP API（远端）
HTTP 路由调用 ──▶ lib/routes.js ─┘
```

`http.js` 按 server 的探测结果给 v2 请求加 `/api` 前缀与 Basic 头，并把 `{data}` /
`{location,data}` / `{data,cursor}` 解包成载荷（`opencodeValue`）；需要原始字节的 v2 端点
（`/fs/read/*`）走 `opencodeRaw`。tools / routes 不感知版本；v2 不支持的端点或参数在模块内转成
明确的 `OpenCodeError` 或工具错误文本，不会退化成空数据。

直接调用从不经过远端模型：shell 命令、文件读取、git status/diff、目录列举、搜索、abort、
消息发送都是确定性的 HTTP 请求。

### 委派（agent 中介）

```text
opencode_subagent / 原生 subagent
  → ensureSession（新建或复用；标题 "dsh delegate" / "dsh subagent: <label>"）
       v2 新建：body 带 location.directory + agent/model
  → trackRun（activeRuns + 交互桥 + snapshot 失效）
  → prepareTurn（仅 v2 续聊：POST /session/{id}/agent、/session/{id}/model 写入会话状态）
  → buildPrompt（v1 parts + agent/model；v2 {text, files:[{uri,name}]}）
  → v1 POST /session/{id}/prompt_async（失败回退阻塞式 /session/{id}/message）
    v2 POST /session/{id}/prompt
  → 等待：SSE 完成事件 + 消息轮询兜底（有订阅 5s 间隔，无订阅 1.5s）
       v1 session.idle；v2 session.execution.* / idle 消息 outcome
  → 结算：text output / structured；清理跟踪
```

原生 provider（`lib/provider.js`）实现 dsh 的进程外接缝
（`start → {id, result, dispose}`），并复用与 `opencode_subagent` 工具完全相同的生命周期。
详见 `docs/subagent-seam.md`。

### SSE 管道

```text
GET /global/event（v1）或 /api/event（v2，Basic），每台 server，重连/退避
  → normalizeEvent（lib/events.js）：v1 message.part.* / session.* / permission.* / question.*，
    v2 session.text / reasoning / tool / step / execution.* / permission.* / form.* → canonical event
  → completionKind 版本分流：v1 session.idle / session.error；v2 仅 session.execution.*
  → server.sessionState（running）         → GET /list、/status（v2 /session/active）
  → server.progress（tool、elapsed、tail） → opencode_progress、/progress、activeTool
  → 完成监听（v1 idle；v2 execution.succeeded / failed / interrupted） → 委派等待
  → permission.asked / question.asked（含 v2 form.created）→ 交互桥（SSE 快路径）
  → 同一 canonical 事件也交给 run 作用域的 watchInteractions 轮询兜底
    （v1 全局 /permission、/question；v2 session 级 /session/{sid}/permission、/form）
```

### 交互桥

```text
远端 permission.asked ──▶ interactions.handlePermission
  ├─ run 有 dsh agent 且 permission: ask → ctx.approval.request
  │    ├ v1 → POST /permission/{id}/reply {reply}
  │    └ v2 → POST /session/{sid}/permission/{rid}/reply {decision: once|always|reject}
  └─ 否则                                → 确定性 allow/reject
远端 question.asked（v1）/ form.created（v2）──▶ 仅工具发起的 run 转发（ctx.userQuestions.ask），否则拒绝
  ├ v1 → POST /question/{id}/reply {answers} 或 /reject
  └ v2 → POST /session/{sid}/form/{fid}/reply {answer:{key:value}}，取消用 DELETE
```

v2 表单字段带类型（`string` / `number` / `integer` / `boolean` / `multiselect`），回答按字段
`key` 组装成 `{key: value}`；取消（reject / 用户关闭）走 `DELETE`，等价于 v1 的 `/question/{id}/reject`。

## 设计决策

| 决策 | 理由 |
|---|---|
| 每台 server 独立探测版本，请求按版本自动路由 | 一份安装同时服务 v1/v2，tools/routes 不必判断版本；同一 profile 内可混用两代 server |
| 读面在 `sessions` / `catalog` / `workspace` 归一化 | 28 个工具只消费统一形状，版本差异集中、可测试，不会泄漏到工具定义 |
| 探测失败、缺密码或 401 时按 v1 处理并记录原因 | 现有 v1 安装在 1.18.10/31/33 上验证过；回退可诊断（启动日志 + `server.versionProbe`）而非静默 |
| 传输失败一律抛 `OpenCodeError`，不降级为空数据 | 401、HTML/SPA、非 JSON、非 2xx、超时都是显式错误，避免“0 条结果”掩盖真实故障 |
| v2 无对应端点的能力：能补则补，不能补才显式失败 | 文本 find / session todo 用 v2 原生能力补回；share、tool ids 没有替代端点，返回明确错误/提示 |
| 结构化输出用 prompt 约束，而非 `format=` | 上游 bug 会毒化消息读取（400 BadRequest） |
| 原生 subagent provider 不声明任何能力 | 远端后端无法兑现 `agentOptions`/`outputSchema`/`maxDepth`；在 start 前就拒绝 |
| 共享同一条 session-run 生命周期 | 委派工具与原生 provider 不能在时序/中止/清理上产生漂移 |
| 多 server 在客户端聚合 | opencode 没有服务端联邦 |
| 插件页以只读展示 + 打开 OpenCode 为主 | 深度编辑交互属于 OpenCode UI |

## 新增功能的检查清单

1. 在对应模块（`sessions`/`catalog`/`workspace`/`manage`）里加纯 API 辅助函数；v1/v2 分支留在
   模块内，不要把 HTTP 调用或版本判断写进 `tools.js`。
2. 新端点先核对两代的路径、包络与目录作用域（v2 用 `opencodeValue`/`unwrapList`/`withLocation`/
   `opencodeRaw`），并在 `test/v2-surface.test.js` 补用例。
3. 只有 Web 页面或外部客户端需要时才在 `lib/routes.js` 加路由。
4. 在 `lib/tools.js` 加工具（通过 `ctx.effect` 注册；依赖从 `lib/index.js` 传入）。
5. 需要新服务/选项时在 `lib/index.js` 里装配。
6. 新增应被冒烟检查的模块导出时更新 `scripts/check.mjs`。
7. 文档：README 功能列表、CHANGELOG、COMPATIBILITY、TODO 清单。
