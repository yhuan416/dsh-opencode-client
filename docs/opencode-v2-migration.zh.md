# OpenCode v2（2.3.0）兼容缺口与迁移计划

> 状态：**方案与结论，运行时未改**。本文是 `dsh-opencode-client` 0.1.0 对 OpenCode 2.3.0 的实测兼容报告和可执行迁移计划；代码迁移尚未开始。
>
> 实测日期：2026-11-18。实测对象：`opencode v2.3.0`（Linux x64 官方 release）。相关 issue：<https://github.com/yhuan416/dsh-opencode-client/issues/1>。
>
> 本文中的“v1”指 OpenCode 1.18.x/1.19.x 的 `/session`、`/global/event` 等接口；“v2”指 2.x 的 `/api/*` 接口。

---

## 0. 结论摘要

### 0.1 一句话结论

**0.1.0 对 OpenCode 2.3.0 不是“改几个路径”就能兼容，而是传输层、响应包络、目录作用域、运行/委派语义、交互作用域、SSE 事件模型六层同时变化。** 直接改路径最多能恢复“列会话 / 读消息”的一部分；委派、完成等待、权限/提问、实时进度、shell、fork/compact 等仍会失败，而且当前代码会把失败**静默降级成 0 条或空结果**，比报错更危险。

### 0.2 关键结论（按影响排序）

1. **v1 路径返回 200 HTML**：`/session`、`/agent`、`/global/health` 在 2.3.0 上返回 Web SPA 的 HTML。`opencodeRequest` 的 `JSON.parse` 失败后返回 `undefined`，上层普遍按“空数组/离线”处理。所以升级到 2.3.0 后，`opencode_sessions`、`opencode_agents`、`opencode_models` 等看起来都是 0 条，而不是“不兼容”。
2. **API 统一移到 `/api/*` 并要求 Basic auth**：用户名固定 `opencode`，密码来自 serve 进程的 `OPENCODE_SERVER_PASSWORD`；不带凭据 `/api/*` 和 `/openapi.json` 都是 401。`lib/http.js` 已能发 Basic 头（用户名也固定为 `opencode`），但 `password` 缺失时没有启动校验，且 401 会被静默吞掉。
3. **响应多一层包络，字段也换了**：列表多为 `{location,data}` 或 `{data,cursor}`；`Project` 的 `worktree` 变成 `canonical`；`Session` 的 `directory` 变成 `location.directory`；消息从 `parts` 变成 `content`；模型从 `/config/providers` 拆成 `/api/provider` + `/api/model`。
4. **目录作用域不是统一的 `?directory=`**：实测 `GET /api/session` 用 `?directory=` 生效；**创建会话用 body `location.directory`，query 和 `x-opencode-directory` 头都被忽略**；`/api/agent`、`/api/fs/*`、`/api/vcs/*` 等规范参数是 `location[directory]` deep object，`x-opencode-directory` 头在多数读接口仍生效。迁移时不能只加一个 query 参数。
5. **`prompt` 的语义变了**：v1 的 `POST /api/session/{id}/prompt_async` 变成 `POST /api/session/{id}/prompt`；请求体从 `{parts, agent, model}` 变成 `{text, files, ...}`，**agent/model 不再放在 prompt body**，而是通过 `POST /api/session/{id}/agent`、`POST /api/session/{id}/model` 设置（包括创建会话时指定）。附件也从 `FilePartInput` 变成 `{uri, name}` 的 `FileAttachment`。
6. **完成信号不能用 `session.idle`**：`session.idle`/`session.status` 仍出现在 2.3.0 的事件枚举和 schema 里，但本次实测的真实执行都没有发出；实际可用的完成信号是 `session.execution.succeeded` / `session.execution.failed` / `session.execution.interrupted`，轮询兜底可看 `Session.Message.Idle` 消息的 `outcome`。另有 `POST /api/experimental/session/{id}/wait` 可阻塞等待会话空闲（实测运行中调用约 8.5s 后返回 204）。
7. **权限和提问改成 session 作用域**：权限列表是 `GET /api/permission/request`（或 `GET /api/session/{id}/permission`），回复是 `POST /api/session/{sid}/permission/{rid}/reply`，body `{decision: "once"|"always"|"reject"}`；提问变成 form：`GET /api/session/{sid}/form`，回复 `POST /api/session/{sid}/form/{fid}/reply` `{answer:{key:value}}`，拒绝/取消用 `DELETE /api/session/{sid}/form/{fid}`。
8. **一批 v1 接口被移除，部分有替代、部分没有**：`/session/{id}/todo`、`/session/{id}/share`、`/session/{id}/children`、`/session/{id}/summarize`、`/session/{id}/init`、`/experimental/tool/ids`、`/config/providers`、`/session/status`、`/global/health`。children→`session?parentID=`、summarize→`compact`、init→`command init`、models→`provider+model`、status→`session/active`、health→`api/info`；**share、todo、tool ids、文本搜索没有 v2 对应接口**，必须产品决策（删除或降级）。
9. **当前 0.1.0 的“在线”判断也不成立**：`collectServer` 用 `/global/health` 的 `healthy === true` 判断在线；v2 没有该接口，必须改用 `/api/info` 的 200/version。
10. **工作量**：v2-only 约 **5–8 人日**；保留 v1 的双栈约 **6.5–9.5 人日**（含测试/文档；不含 Web UI 代理和真实 provider 矩阵。Web UI 如果要求“嵌入后免登录”，另需 0.5–1 人日做一个 dsh 侧认证代理）。

### 0.3 推荐路线

**推荐 B1：v2-first + v1 兼容层（同一 0.2.0 同时支持 1.18.x 和 2.x）。**

- 理由：issue 的诉求是“add support for OpenCode v2”，不是“drop v1”；0.1.0 的 `COMPATIBILITY.md` 明确支持 1.18.10/31/33。直接 v2-only 会让现有 1.x 用户升级插件即断。
- 实现方式：在 `lib/http.js` 增加 `apiVersion: auto|1|2` 和版本探测；把 v1 的请求/事件解析保留为兼容分支，新增 v2 分支；只在语义真正不同的地方（prompt、SSE、permission/form、shell）写双路径，路径/包络/字段这类机械差异放到 helper 里。
- 如果维护者明确接受“0.1.x 留在 v1、0.2.0 只支持 v2”，则走 **B0：v2-only**，可省 1.5–2 人日；代码结构上仍建议保留 `apiVersion` 抽象，便于以后再接 v3。
- **不推荐**把 v1 sidecar 当长期方案（只能临时救急，见 §4.1 选项 A）；**不推荐** v1→v2 转换 shim（维护两套语义，长期成本最高，见选项 C）。

---

## 1. 验证范围与证据

### 1.1 环境与方法

- 官方 release：`anomalyco/opencode` `v2.3.0`（`opencode-linux-x64.tar.gz`），`./opencode --version` → `opencode v2.3.0`。
- 隔离 HOME/XDG 目录启动，避免污染本机 1.18.10 的 `~/.local/share/opencode`：

  ```bash
  HOME=/tmp/oc2home XDG_CONFIG_HOME=/tmp/oc2home/config \
  XDG_DATA_HOME=/tmp/oc2home/data XDG_CACHE_HOME=/tmp/oc2home/cache \
  XDG_STATE_HOME=/tmp/oc2home/state \
  OPENCODE_SERVER_PASSWORD=testpass \
  /tmp/oc2/opencode serve --hostname 127.0.0.1 --port 4199
  ```

- 用 `curl -u opencode:$OPENCODE_SERVER_PASSWORD` 拉 `/openapi.json`，并用真实模型（默认免费 `opencode/big-pickle`）跑通 session、prompt、SSE、tool、permission、form、shell、interrupt、fork、wait、compact 等流程。
- `/openapi.json` 统计：**139 个 path、515 个 schema、`V2Event` 100 个变体、事件过滤枚举 98 个类型**。

### 1.2 实测到的关键行为

| 探测 | 结果 |
|---|---|
| `GET /session`、`/agent`、`/global/health`（无 auth） | `200 text/html`，返回 SPA，不是 JSON |
| `GET /api/info` 无 auth | `401 {"_tag":"UnauthorizedError","message":"Authentication required"}` |
| `GET /api/info` 带 `opencode:testpass` | `200 {"version":"2.3.0","pid":...,"urls":[...],"paths":{"tmp":...},"capabilities":{...}}` |
| 用户名错误（`foo:testpass`） | `401`，用户名固定为 `opencode` |
| `GET /openapi.json` 无 auth | `401` |
| `GET /api/session` 带 auth | `{"data":[],"cursor":{"previous":null,"next":null}}` |
| `POST /api/session` + body `location` | `200 {"data":{"id":"ses_...","location":{"directory":"/tmp/..."},...}}` |
| `POST /api/session?directory=...` / `x-opencode-directory` 头 | **目录被忽略**，落在 server 默认 cwd |
| `POST /api/session/{id}/prompt` `{text:"Reply PONG"}` | `200 {"data":{"id":"msg_...","sessionID":"...","type":"user","delivery":"steer"}}`，执行开始 |
| SSE `/api/event` | `data: {...}` 纯 data 行 + `: heartbeat` 注释；事件 envelope `{id,created,type,location?,data,durable?}` |
| 一次真实执行的事件序列 | `session.execution.started` → `session.step.started` → `session.text.started/delta/ended` → `session.step.ended` → `session.execution.succeeded`；**没有观察到 `session.idle` / `session.status`** |
| shell 工具 | `session.tool.input.started/ended`、`session.tool.called`（`data.name/input`）、`session.tool.progress`、`session.tool.success`（`data.content`） |
| `POST /api/experimental/session/{id}/wait`（运行中调用） | 阻塞到执行结束，`204`，本次约 8.5s |
| `POST /api/session/{id}/interrupt` | `200 {"interrupted":true|false}` |
| `GET /api/session/active` | `{"data":{"ses_...":{"type":"running"}}}`；空闲时 `data:{}` |
| `POST /api/session/{id}/shell` `{command}` | `204`；输出在 `GET /message?type=shell` 的 `Session.Message.Shell.output.output` |
| `POST /api/session/{id}/command` `{name:"init",text:""}` | `204`，异步执行 |
| `POST /api/session/{id}/compact` `{}` | `200 {"data":{"type":"compaction",...}}` |
| `POST /api/session/{id}/fork` `{}` | `200 {"data":{... Session.Info ...}}` |
| `GET /api/session/{id}/form` | `{"data":[{Form.Info}]}`；字段为 `{key,title,type,options[custom],...}` |
| `POST /api/session/{id}/form/{fid}/reply` `{answer:{"q0":"Blue"}}` | `204`；随后 `form.replied` + `session.execution.succeeded` |
| `DELETE /api/session/{id}/form/{fid}` | `204`；tool state 变 `error: "The user dismissed this question"` |
| `GET /api/permission/request?location[directory]=...` | `{location,data:[Permission.Request]}` |
| `POST /api/session/{sid}/permission/{rid}/reply` `{decision:"once"}` | `204`；随后 `permission.replied` + tool 继续执行 |
| `GET /api/project` | 裸数组，字段 `canonical`（不是 `worktree`） |
| `GET /api/provider` / `/api/model` | `{location,data:[...]}`；provider/model 分开 |
| `GET /api/vcs/diff?mode=git` | `400 Expected Vcs.Mode`；合法值 `working|branch|committed` |
| `GET /api/fs/read/a.txt` | `200 text/plain` 原始字节；`location` 作用域 |
| `GET /api/session/{id}` | `{"data": Session.Info}` |
| `GET /api/session/{id}/message` | `{"data":[Message...],"cursor":{...}}`；**默认 desc（最新在前）**，`order=asc` 可正序 |
| `GET /api/session/{id}/message?type=shell` | 可直接取 shell 消息和 output |
| 移除路径 | `/api/session/{id}/todo|share|children|summarize|init` → 404；`/api/experimental/tool/ids`、`/api/config/providers` → 404 |

### 1.3 与 issue 线索的差异（重要）

- 线索说“`session.idle` 已不存在”。**schema 和事件过滤枚举里仍有 `session.idle` / `session.status`**，但本次 2.3.0 真实执行中没有发出。结论不变：**不要把 `session.idle` 当完成信号**，用 `session.execution.*` + 轮询兜底。
- 线索说“多数接口需 `?directory=`”。**不准确**：`?directory=` 只在 `GET /api/session` 等少数接口生效；创建会话要 body `location`，多数读接口要 `location[directory]` 或 `x-opencode-directory` 头。按“统一加 query”会踩坑。
- 线索说“响应多一层 `data`”。大体正确，但不是所有接口都一样：也有裸数组（`/api/project`）、`{data,cursor}`（session/message）、`{location,data}`（catalog/fs/vcs）、`{interrupted}`（interrupt）、`204`（reply/shell/command/agent/model）。

### 1.4 验证限制

- 只验证了 **2.3.0 / Linux x64**；2.3.2 已发布，2.x 仍在快速变化，迁移时要做**版本矩阵**而不是只测一个点。
- 只用了免费 `opencode/big-pickle` 模型；没有覆盖所有 provider、reasoning、图片/多模态、MCP、PTY、worktree、持久会话迁移。
- 没有用浏览器实际操作 v2 Web UI；嵌入 iframe 的登录行为只做了静态判断（SPA 有 `authentication` 状态和 server/password 概念，未做点击验证）。
- 没有跑 1.18.x 的回归（本机是 1.18.10，但是 0.1.0 的既有基线；迁移时必须补）。
- 没有验证上游 v1→v2 会话数据迁移；这属于 OpenCode 自身行为，但会直接影响“升级后列表为空”的用户体验（见 §6）。

---

## 2. 断点清单

### 2.1 传输层：前缀、认证、错误可见性

| # | 断点 | 0.1.0 现状 | 2.3.0 实测 | 处理 |
|---|---|---|---|---|
| A1 | API 前缀 | `lib/http.js` 直接拼 `/session`、`/global/health` 等 | 全部在 `/api/*`；根路径是 SPA | 新增 `server.apiVersion` 和 `apiPath()`；v2 分支加 `/api` 前缀 |
| A2 | Basic auth | `http.js` 已发 `Basic opencode:<password>`；`sse.js` 复用 | 2.3.0 要求 auth；用户名固定 `opencode`；密码来自 serve 环境变量 | 保留现有实现；增加“password 未配置但服务器返回 401”的显式诊断；文档写清 `OPENCODE_SERVER_PASSWORD` |
| A3 | 401/HTML 被静默吞掉 | `opencodeRequest` 在 JSON 解析失败/网络错误时 resolve `undefined`；上层当空数组 | v1 路径 200 HTML、401 JSON 都会变成 `undefined` | **Phase 0 必做**：`opencodeRequest` 返回/抛出结构化错误（status、content-type、body 片段），所有 collector 对非 2xx/非 JSON 显式失败 |
| A4 | 响应包络 | 直接读 `result.value` | `{data}`、`{data,cursor}`、`{location,data}`、裸数组、`204`、`{interrupted}` | 新增 `unwrapData`/`unwrapList`/`assertOk` helper；按接口显式处理，不要假设统一 |
| A5 | 目录作用域 | 用 `x-opencode-directory` 头 | session list 用 `?directory=`；create 用 body `location`；多数读接口用 `location[directory]` 或头；create 忽略头/query | 每个调用点显式选择作用域方式；`ensureSession` 改 body `location`；`collectSessionRows` 用 API `directory` 或客户端过滤 |
| A6 | OpenAPI 也需 auth | 未使用 | `/openapi.json` 无 auth 401 | 探测/文档时带 auth；不要把 openapi 当公开资源 |

### 2.2 只读目录与会话

| # | 断点 | 0.1.0 现状 | 2.3.0 实测 | 处理 |
|---|---|---|---|---|
| B1 | health | `/global/health`，读 `healthy`/`version` | `/api/info`，`{version,pid,urls,paths,capabilities}`；200 即在线 | `collectServer` 改 `/api/info`；版本用于探测 |
| B2 | project | `/project`，`worktree` | `/api/project` 裸数组，`canonical` | 字段映射；`realWorktree` 逻辑改用 `canonical` |
| B3 | session list | `/session`，裸数组，`directory`/`time.updated` | `/api/session`，`{data,cursor}`，`location.directory`/`time.updated`，支持 `limit/order/search/directory/parentID/archived/cursor` | 取 `data`；分页（cursor）；字段映射；目录过滤 |
| B4 | session get | `/session/{id}` 裸对象 | `/api/session/{id}` `{data}` | 解包；`outcome`/`cost`/`tokens` 新增展示 |
| B5 | messages | `/session/{id}/message` 裸数组、`info/parts`、默认升序 | `/api/session/{id}/message` `{data,cursor}`、`text`/`content`、**默认 desc**、支持 `order/type/cursor` | 解包；取最新 N 用 `order=desc&limit=N` 后 reverse；`type=assistant|idle|shell` 过滤 |
| B6 | message part 结构 | `info.role` + `parts[].type/state` | user `text` / `files`；assistant `content[]`（text/reasoning/tool）；tool `name/state{status,input,content,error}`；另有 `idle` 消息 | 重写 `readMessages`/`extractAssistant`/`extractShellOutput` |
| B7 | agents | `/agent`，裸数组，`name/mode/native` | `/api/agent`，`{location,data}`，`id/name/mode/hidden/description`；`native` 字段没了 | 解包；`name` 仍是展示名，`id` 才是 agent 标识；`native` 用 `mode`/`hidden` 推断或去掉 |
| B8 | models | `/config/providers` `{providers,default}` | `/api/provider` + `/api/model` + `/api/model/default`，各自 `{location,data}`；`Model.Info` 有 `id/modelID/providerID/name/enabled` | 重写 `collectModels`；默认模型单独取 |
| B9 | commands | `/command`，裸数组，`name/description/source/agent/model/subtask` | `/api/command` `{location,data}`，**只有 `name/description`** | 解包；丢失字段从输出/测试中去掉 |
| B10 | skills | `/skill`，裸数组，`name/description/location` | `/api/skill` `{location,data}`，`id/name/description/path/content/autoinvoke` | 解包；`path` 替代 `location`；内容仍不输出 |
| B11 | tool ids | `/experimental/tool/ids` | 无对应接口（404） | `opencode_tools` 在 v2 降级/移除；不要伪造 |
| B12 | references | `/api/reference` 已经是 v2，但无 auth/包络处理 | `/api/reference` `{location,data}`，`name/path/description/hidden/source` | 解包；`alias/location` 改 `name/path` |
| B13 | MCP | `/mcp` 裸对象 `{name:{status:string}}` | `/api/mcp` `{location,data:[{name,status:{status:...},title}]}`，`status` 是对象 | 解包；取 `status.status` |
| B14 | session search | `/api/session?search=`（v2）并回退 v1 标题过滤 | `/api/session?search=` 正常，`{data,cursor}` | 去回退；字段 `location.directory`；limit/cursor |

### 2.3 运行与委派

| # | 断点 | 0.1.0 现状 | 2.3.0 实测 | 处理 |
|---|---|---|---|---|
| C1 | async prompt | `POST /session/{id}/prompt_async` `{parts,agent,model}` | `POST /api/session/{id}/prompt` `{text,files,...}`；返回 `{data: Inbox.User}`；200；409 冲突 | 重写 `promptBody`/`asyncPrompt`；`agent/model` 通过 session 级接口设置 |
| C2 | sync prompt | `POST /session/{id}/message` 阻塞 | 无阻塞 prompt；`prompt` + `/api/experimental/session/{id}/wait`（204）或轮询 | `syncPrompt` 改为 prompt+wait+读最后 assistant；注意 wait 期间连接中断/取消 |
| C3 | abort | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt`，返回 `{interrupted:boolean}` | 改路径/解析；`false` 表示本来就空闲，不算失败 |
| C4 | status | `GET /session/status` 全量 map | `GET /api/session/active` 只返回运行中的 `{ses:{type:"running"}}` | 缺省视为 idle；不要再用 `status.type === "idle"` 过滤 |
| C5 | 完成等待 | SSE `session.idle` + 5s 轮询；回退阻塞 prompt | `session.execution.succeeded/failed/interrupted`；`Session.Message.Idle.outcome`；`wait` 204 | 以 execution 事件为主；轮询 `type=idle&order=desc` 或 `wait`；`session.idle` 仅作兼容分支 |
| C6 | agent/model 覆盖 | prompt body 的 `agent`/`model` | `POST /api/session/{id}/agent` `{agent}`；`POST .../model` `{model:{id,providerID,variant?}}`；也可创建时指定 | 新会话创建时带 `agent/model`；续聊时先设置再 prompt；要记录“设置会持久化到会话”的语义变化 |
| C7 | shell | `POST /session/{id}/shell` 同步返回 message parts | `POST /api/session/{id}/shell` `{command}` → 204；输出在 `Session.Message.Shell.output`（`GET /message?type=shell`） | 改为异步；用 `shell.created/exited` 事件或轮询 shell 消息；按 command/created 关联 |
| C8 | command | `POST /session/{id}/command` `{command,arguments}` 同步返回 | `POST /api/session/{id}/command` `{name,text}` → 204，异步 | 改 body；`init` 用 `{name:"init",text:""}`；等待/读结果 |
| C9 | fork | `{messageID}`，返回 session | `{before}`，返回 `{data: Session.Info}` | 改 body/解包；`before` 与 v1 `messageID` 语义对应 |
| C10 | summarize | `POST /session/{id}/summarize` | `/api/session/{id}/compact`（Inbox.Compaction） | 实现 compact；语义可能不等于 summarize，需在工具描述中改名/说明 |
| C11 | init | `POST /session/{id}/init` | 无；用 command `init` | 改 command；204 异步，需等待 |
| C12 | children | `GET /session/{id}/children` | 无；`GET /api/session?parentID={id}` | 改查询；分页/字段映射 |
| C13 | 附件 | `FilePartInput {type:"file",mime,filename,url}` | `PromptInput.FileAttachment {uri,name?,source?}`；实测 data URL 被接受，user message 存 `data/mime/source/name` | data URL 映射 `uri`；文本仍可追加为 text 让模型“看见”；限制大小 |
| C14 | 结构化输出 | prompt 约束 + 本地校验；v1 `format=` 有 bug | v2 未验证 `format`，继续用 prompt 约束 | 不变；不要启用未验证的 format |

### 2.4 SSE 与交互

| # | 断点 | 0.1.0 现状 | 2.3.0 实测 | 处理 |
|---|---|---|---|---|
| D1 | SSE 路径/认证 | `GET /global/event`，`serverHeaders` 带 auth | `GET /api/event`，必须 auth | 改路径；保留 auth |
| D2 | SSE 包络 | v1 解析 `payload` / `{type,properties}` | v2 顶层 `{id,created,type,location,data,durable?}`；`data.sessionID` 在 data 里 | 重写 `handleEventBlock`；兼容两种包络 |
| D3 | SSE 行格式 | `data:` 行；`\n\n` 分块 | `data:` 行 + `: heartbeat` 注释；无 `event:` 字段 | 现有分块逻辑可用；忽略 heartbeat/空 data |
| D4 | 事件类型 | `message.part.updated/delta`、`session.status`、`session.idle`、`permission.asked`、`question.asked` | `session.text.*`、`session.reasoning.*`、`session.tool.*`、`session.step.*`、`session.execution.*`、`permission.asked/replied`、`form.created/replied/cancelled`、`session.inbox.*`、`session.deleted` 等 | 重写事件映射；`session.idle/status` 作为可选兼容 |
| D5 | 进度 tail | `message.part.delta`/`properties.delta` | `session.text.delta.data.delta`；`session.reasoning.delta`；tool `data.content` | 改取 `data`；tool 名用 `data.name`（实测存在）；输出 tail 用 text delta / tool content |
| D6 | 权限列表 | `GET /permission` 裸数组 | `GET /api/permission/request?location[directory]=...` 或 `GET /api/session/{id}/permission`，`{data}` | 改端点/解包；优先 session 级，避免 location 作用域问题 |
| D7 | 权限回复 | `POST /permission/{id}/reply` `{reply}` | `POST /api/session/{sid}/permission/{rid}/reply` `{decision:"once"|"always"|"reject", message?}` | 改路径/body；`allowed-once→once`，`allow→always`，`reject→reject` |
| D8 | 提问列表 | `GET /question` 裸数组 | `GET /api/form?location[directory]=...` 或 `GET /api/session/{id}/form`，`{data}`；`Form.Info` 多字段 | 改端点/解包；字段映射到 dsh userQuestions |
| D9 | 提问回复 | `POST /question/{id}/reply` `{answers}` | `POST /api/session/{sid}/form/{fid}/reply` `{answer:{key:value}}` | 改路径/body；按 field `key` 组装答案；多选/数字/布尔类型按 `Form.Value` |
| D10 | 提问拒绝 | `POST /question/{id}/reject` | 无 reject；`DELETE /api/session/{sid}/form/{fid}` | 改为 DELETE；tool 会得到 “user dismissed” |
| D11 | 事件与请求竞态 | SSE 快路径 + 1.5s 轮询 | 同样适用；但列表端点要 session 作用域 | 保留快路径+轮询；轮询用 session 级 form/permission |

### 2.5 工作区与 Git

| # | 断点 | 0.1.0 现状 | 2.3.0 实测 | 处理 |
|---|---|---|---|---|
| E1 | 文件读 | `GET /file/content?path=`，返回 `{type,content}` | `GET /api/fs/read/{path}`，原始字节（`content-type`），`location` 作用域；404 `FileNotFoundError` | 改路径；按 `content-type`/UTF-8 判断文本/二进制；路径编码 |
| E2 | 文件查找 | `GET /find/file?query=` 裸数组；`GET /find?pattern=` 文本搜索 | `GET /api/fs/find?query=&type=file|directory`，`{location,data:[{path,type}]}` | 改路径/解包；**文本搜索无接口**，v2 下降级或走 shell |
| E3 | VCS status | `GET /vcs/status` 裸数组，`{file,additions,deletions,status}` | `GET /api/vcs/status` `{location,data:[...]}`，status 枚举 `added|deleted|modified` | 解包；status 映射（无 `?`） |
| E4 | VCS diff | `GET /vcs/diff?mode=git|branch` 裸数组 | `GET /api/vcs/diff?mode=working|branch|committed`，`{location,data:[FileDiff.Info]}`；`mode=git` 400 | 改 mode 映射（`git→working`）；解包；`patch` 字段名不变 |
| E5 | 文件列表 | 无 | `GET /api/fs/list`（可选用） | 可选 |

### 2.6 移除/降级功能

| # | v1 功能 | v2 状态 | 建议 |
|---|---|---|---|
| F1 | `/session/{id}/todo` | 无接口 | `opencode_session_info` 去掉 todos；不要伪造。若产品需要，在 v2 侧用外部存储/消息解析另做 |
| F2 | `/session/{id}/share` | 无接口 | `opencode_share` 在 v2 不可用；返回明确错误或按 server 版本隐藏 |
| F3 | `/experimental/tool/ids` | 无接口 | `opencode_tools` 在 v2 不可用；返回明确错误或按版本隐藏 |
| F4 | `/find?pattern=` 文本搜索 | 无接口 | `opencode_find(kind=text)` 在 v2 不可用；或改走 `opencode_shell` + `grep`（需要 session，且输出/超时受限） |
| F5 | `/session/{id}/children` | 无直接接口，`session?parentID=` 可替代 | 改查询 |
| F6 | `/session/{id}/summarize` | `compact` 近似替代 | 改 compact；工具描述改名/说明差异 |
| F7 | `/session/{id}/init` | command `init` 替代 | 改 command |
| F8 | `/session/status` | `session/active` 替代 | 改 active |
| F9 | `/config/providers` | `provider` + `model` 替代 | 改 catalog |

### 2.7 完整端点映射表（按代码实际调用）

| 功能 | 0.1.0 调用 | 2.3.0 调用 | 状态/要点 |
|---|---|---|---|
| 健康 | `GET /global/health` | `GET /api/info` | 替代；`version` 判断 v2 |
| 项目 | `GET /project` | `GET /api/project` | 裸数组；`canonical` |
| 会话列表 | `GET /session` | `GET /api/session` | `{data,cursor}`；支持 `limit/order/search/directory/parentID` |
| 创建会话 | `POST /session` `{title}` + 头 | `POST /api/session` `{title,location:{directory},agent?,model?}` | body location；query/header 无效 |
| 会话详情 | `GET /session/{id}` | `GET /api/session/{id}` | `{data}` |
| 消息列表 | `GET /session/{id}/message` | `GET /api/session/{id}/message` | `{data,cursor}`；默认 desc；`order/type` |
| 发消息（异步） | `POST /session/{id}/prompt_async` | `POST /api/session/{id}/prompt` | body `{text,files,...}`；200 Inbox |
| 发消息（同步） | `POST /session/{id}/message` | `prompt` + `POST /api/experimental/session/{id}/wait` | wait 204；或轮询 idle |
| 中断 | `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` | `{interrupted}` |
| 状态 | `GET /session/status` | `GET /api/session/active` | 只含 running |
| 权限列表 | `GET /permission` | `GET /api/permission/request` / `GET /api/session/{id}/permission` | `{location,data}` / `{data}` |
| 权限回复 | `POST /permission/{id}/reply` | `POST /api/session/{sid}/permission/{rid}/reply` | `{decision}`；session 作用域 |
| 提问列表 | `GET /question` | `GET /api/form` / `GET /api/session/{id}/form` | `{location,data}` / `{data}` |
| 提问回复 | `POST /question/{id}/reply` | `POST /api/session/{sid}/form/{fid}/reply` | `{answer:{key:value}}` |
| 提问拒绝 | `POST /question/{id}/reject` | `DELETE /api/session/{sid}/form/{fid}` | 204；tool 收到 dismissed |
| TODO | `GET /session/{id}/todo` | — | 无替代 |
| Diff | `GET /session/{id}/diff` | `GET /api/session/{id}/diff` | `{data}` |
| Context | — | `GET /api/session/{id}/context` | 新增；`{data}` 消息数组 |
| Share | `POST/DELETE /session/{id}/share` | — | 无替代 |
| Agent 列表 | `GET /agent` | `GET /api/agent` | `{location,data}`；`id/name/mode/hidden` |
| 模型 | `GET /config/providers` | `GET /api/provider` + `GET /api/model` + `/api/model/default` | 分开；默认模型单取 |
| 命令列表 | `GET /command` | `GET /api/command` | 只剩 `name/description` |
| 技能 | `GET /skill` | `GET /api/skill` | `path` 代替 `location` |
| 工具 ids | `GET /experimental/tool/ids` | — | 无替代 |
| References | `GET /api/reference` | `GET /api/reference` | 需 auth + `{location,data}` |
| 执行命令 | `POST /session/{id}/command` | `POST /api/session/{id}/command` | `{name,text}`；204 异步 |
| Shell | `POST /session/{id}/shell` | `POST /api/session/{id}/shell` | 204 异步；输出在 shell 消息 |
| VCS status | `GET /vcs/status` | `GET /api/vcs/status` | `{location,data}` |
| VCS diff | `GET /vcs/diff?mode=git|branch` | `GET /api/vcs/diff?mode=working|branch|committed` | mode 映射；`{location,data}` |
| 读文件 | `GET /file/content?path=` | `GET /api/fs/read/{path}` | 原始字节；location |
| 找文件 | `GET /find/file?query=` | `GET /api/fs/find?query=` | `{location,data:[{path,type}]}` |
| 找文本 | `GET /find?pattern=` | — | 无替代 |
| Fork | `POST /session/{id}/fork` `{messageID}` | `POST /api/session/{id}/fork` `{before}` | `{data}` |
| Summarize | `POST /session/{id}/summarize` | `POST /api/session/{id}/compact` | 近似；异步 Inbox |
| Init | `POST /session/{id}/init` | `POST /api/session/{id}/command` `{name:"init",text:""}` | 204 异步 |
| Children | `GET /session/{id}/children` | `GET /api/session?parentID={id}` | 查询替代 |
| SSE | `GET /global/event` | `GET /api/event` | 包络/事件全变；需 auth |
| 设置 agent | prompt body | `POST /api/session/{id}/agent` `{agent}` | 204；持久化 |
| 设置 model | prompt body | `POST /api/session/{id}/model` `{model:{id,providerID}}` | 204；持久化；注意 `id` 不是 `modelID` |
| 等待 | — | `POST /api/experimental/session/{id}/wait` | 204；运行中阻塞 |

---

## 3. 受影响模块

### 3.1 文件级影响

| 文件 | 当前职责 | 需要的改动 | 风险 |
|---|---|---|---|
| `lib/http.js` | `opencodeRequest`、Basic 头、`x-opencode-directory`、JSON 响应 | 增加 `OpenCodeError`/状态校验/`content-type` 校验；`apiVersion`/`apiPath`；`unwrapData`/`unwrapList`；按接口选择 `location[directory]`/`directory`/header/body location | **高**：所有模块都经过这里；先改这里才能让失败可见 |
| `lib/config.js` | server 归一化、`parseModel`、`parsePathMap` | 增加 `apiVersion: auto|1|2`；password 校验；v2 model ref 映射辅助（`modelID→id`） | 中 |
| `lib/index.js` | wiring、SSE、provider、tools、routes | 启动时探测每个 server 的 `apiVersion`；401/HTML 时记录明确健康状态；可选：按版本注册工具能力 | 中 |
| `lib/sessions.js` | health/projects/sessions/messages/status/agents/share/abort | 重写为 v1+v2 分支；v2 解包/字段映射/分页/`order`；移除 share；status→active | **高** |
| `lib/catalog.js` | models/commands/skills/tool ids/references/search/MCP/runCommand | v2 端点/包络/字段；models 拆分；tool ids 移除；runCommand 改 body/异步 | 中高 |
| `lib/workspace.js` | shell/git status/diff/read/find | v2 shell 异步+读 shell 消息；fs read 原始字节；fs find；vcs mode/包络；文本 find 降级 | **高** |
| `lib/manage.js` | fork/summarize/init/children | fork body/解包；summarize→compact；init→command；children→session?parentID | 中 |
| `lib/delegate.js` | promptBody/extractAssistant/waitAssistant/syncPrompt/asyncPrompt | v2 prompt body；message content 提取；wait 改为 execution/wait；sync 改为 prompt+wait | **高** |
| `lib/session-run.js` | ensureSession/trackRun/sendSessionMessage/abortRemote | create body location；prompt 端点；interrupt；wait 参数 | 高 |
| `lib/interactions.js` | permission/question -> dsh approval/userQuestions | v2 permission/form 事件、列表、回复、DELETE；session 作用域 | **高** |
| `lib/sse.js` | `/global/event` 解析、progress、idle、interaction 快路径 | v2 `/api/event` 包络/事件映射；execution 完成；tool/step/text；兼容 v1 | **高** |
| `lib/routes.js` | dsh HTTP 路由 | 字段/状态适配；remove/410 share；v2 session create body；events/progress；`session-info` 去 todo | 中 |
| `lib/tools.js` | 26 个 `opencode_*` 工具 | 逐工具适配；share/tools 在 v2 明确不可用；find text 降级；init/summarize/shell/children 语义变化 | 中高 |
| `lib/client.js` | Web UI 嵌入、插件页 | 显示 v2 状态；嵌入登录（手动/代理）；session 深链验证；字段 `location.directory` | 中 |
| `scripts/check.mjs` | 离线冒烟 | 保留 v1 断言；新增 v2 fixtures/断言；不要再断言旧 `promptBody.parts` | 低 |
| `COMPATIBILITY.md`、`CHANGELOG.md`、`TODO.md`、`README*`、`docs/TOOLS.zh.md` | 兼容性/版本/工具文档 | 实测矩阵、v1/v2 支持策略、0.2.0 说明、移除功能说明 | 低 |
| 新增 `test/`（建议） | 无 | v2 contract/SSE/tool 测试、fixtures、可选 e2e | 中 |

### 3.2 工具级影响（26 个 `opencode_*`）

| 工具 | v2 可用性 | 改动 |
|---|---|---|
| `opencode_subagent` | 可用 | prompt/wait/agent/model/附件；完成判断改 execution |
| `opencode_sessions` | 可用 | 解包/字段/分页；`location.directory` |
| `opencode_messages` | 可用 | 解包/`content`/`order`；最新 N 反序 |
| `opencode_agents` | 可用 | 解包；`id/name/mode/hidden`；`native` 语义调整 |
| `opencode_session_info` | 部分 | 信息/diff 可用；**todo 移除** |
| `opencode_share` | **不可用** | 明确报错/按版本隐藏；无 v2 替代 |
| `opencode_models` | 可用 | provider/model 拆分；默认模型单取 |
| `opencode_commands` | 可用 | 解包；`source/agent/model/subtask` 丢失 |
| `opencode_skills` | 可用 | 解包；`path` 替代 `location` |
| `opencode_tools` | **不可用** | 明确报错/按版本隐藏；无 v2 替代 |
| `opencode_references` | 可用 | 解包；字段 `name/path` |
| `opencode_command` | 可用 | body `{name,text}`；异步；等待/读结果 |
| `opencode_shell` | 可用 | 异步 204；读 shell 消息 output |
| `opencode_git_status` | 可用 | 解包；status 枚举 |
| `opencode_git_diff` | 可用 | `mode=working`；解包；patch |
| `opencode_read_file` | 可用 | `/api/fs/read/{path}`；二进制判断 |
| `opencode_find` | 部分 | 文件可用；`kind=text` 不可用（降级/报错） |
| `opencode_fork` | 可用 | `{before}`；`{data}` |
| `opencode_children` | 可用 | `session?parentID=` |
| `opencode_summarize` | 近似 | 改 compact；描述/语义说明 |
| `opencode_init` | 可用 | command `init`；异步 |
| `opencode_progress` | 可用 | v2 事件映射 |
| `opencode_search` | 可用 | v2 `session?search=`；去 v1 回退 |
| `opencode_mcp` | 可用 | status 对象 |
| `opencode_abort` | 可用 | interrupt；`{interrupted}` |
| `opencode_prompt` | 可用 | prompt；wait 改 execution/wait；附件 |

### 3.3 关键数据结构差异

| 概念 | v1 | v2 |
|---|---|---|
| 会话 | `id,title,directory,projectID,time.updated` | `id,title,location.directory,projectID,time.updated,outcome,cost,tokens` |
| 消息 | `{info,parts}` | `{type,text}` / `{type,content}` / `{type:"idle",outcome}`；`cursor` |
| 工具 part | `part.type=tool, part.state.{status,output,metadata}` | `content[].type=tool, name,state.{status,input,content,error}` |
| 项目 | `{id,worktree}` | `{id,canonical,time,...}` |
| Agent | `{name,mode,native,description}` | `{id,name,mode,hidden,description}` |
| 模型 | `/config/providers` 的 `providers/default` | `Provider.Info` + `Model.Info`（`id/modelID/providerID`） |
| 权限 | `{id,sessionID,permission,patterns}` + `reply` | `{id,sessionID,action,resources,save,source}` + `decision` |
| 提问 | `{id,sessionID,questions[]}` + `answers` | `Form.Info{id,sessionID,title,fields[]}` + `answer{key:value}` |
| SSE | `{type,properties}` | `{id,created,type,location,data,durable}` |
| 健康 | `{healthy,version}` | `{version,pid,urls,paths,capabilities}` |

---

## 4. 分阶段迁移计划

### 4.1 路线选择

| 选项 | 做法 | 成本 | 风险/评价 |
|---|---|---|---|
| A. v1 sidecar | 另装 1.19.x 到独立前缀/端口，插件继续连 v1 | 0.5–1 小时 | 只救急；两套 server、两套认证/数据；不是产品方案 |
| B0. v2-only | 0.2.0 只支持 v2，0.1.x 留 v1 | 5–8 人日 | 最干净；1.x 用户升级即断 |
| **B1. v2-first 双栈** | 0.2.0 同时支持 v1/v2，`apiVersion: auto` | **6.5–9.5 人日** | **推荐**：不破坏 1.x；多一套测试矩阵，需在 0.3 定 v1 退场 |
| C. v1→v2 shim | 插件不动，中间层翻译 | 2–3 人日 | 长期维护两套语义，bug 定位困难；不推荐 |
| D. 显式禁用 | 启动时检测 v2 并报“不支持” | 0.5 小时 | 立即消除“0 条”误导；不能算支持 |

**推荐 B1**。如果维护者决定不保留 1.x，则 B0；两者都从 Phase 0 开始，代码结构都保留 `apiVersion`，所以 Phase 0 不会白做。

### 4.2 Phase 0 — 让失败可见 + 版本探测 + 契约夹具（0.5–1 人日）

目标：**在任何功能迁移前，先把“静默空结果”变成明确错误，并能识别 v1/v2。**

- [ ] `lib/http.js`：新增 `OpenCodeError`（`status`、`contentType`、`bodySnippet`、`url`）；非 2xx、非 JSON（HTML）、网络错误都抛错；`opencodeRequest` 不再返回 `undefined` 让上层猜。
- [ ] `lib/http.js`：新增 `apiPath(server, path)`、`unwrapData`、`unwrapList`、`withDirectory`（按接口选择 query/header/body）。
- [ ] `lib/config.js`：`apiVersion: 'auto'|'1'|'2'`（默认 auto）；`password` 缺失时允许启动，但探测失败要提示。
- [ ] `lib/index.js`：每个 server 启动探测：`GET /api/info`（带 auth）→ 200 且 `version` 主版本 ≥2 判 v2；否则 `GET /global/health` → v1；HTML/401 → 明确 `incompatible`/`unauthorized` 状态。
- [ ] 记录 fixtures：从 2.3.0 抓取一组 JSON/SSE 样本（session list/message、prompt、permission、form、tool、execution、heartbeat），放到 `test/fixtures/v2/`（不要放凭据/模型私密内容）。
- [ ] `scripts/check.mjs` 保留 v1 断言；新增探测/错误路径测试。
- [ ] 文档：写清 `OPENCODE_SERVER_PASSWORD`、用户名固定 `opencode`、1.x 与 2.x 的启动差异。

**退出标准**：对 2.3.0 执行 `opencode_sessions`/`opencode_models` 时，如果未配置密码/服务端不兼容，工具返回明确错误（含 401/HTML 提示），不再是“0 条”；对 1.18.x 行为不变；`npm run check` 通过。

### 4.3 Phase 1 — 只读面（会话/消息/目录/状态）（1–1.5 人日）

目标：v2 上“看得见”——列会话、读消息、看 agents/models/commands/skills/references/mcp、看 status。

- [ ] `sessions.js`：`collectServer`（info/project/session 列表）、`collectSessionRows`（`location.directory`、分页）、`readMessages`（`content`/`order`/`type`）、`collectAgents`、`collectStatus`（active）。
- [ ] `catalog.js`：models（provider+model+default）、commands、skills、references、MCP、session search。
- [ ] `routes.js`：`/list`、`/sessions`、`/messages`、`/agents`、`/models`、`/commands`、`/skills`、`/references`、`/mcp`、`/search`、`/status` 的字段/包络。
- [ ] `tools.js`：`opencode_sessions/messages/agents/models/commands/skills/references/mcp/search/progress`（progress 先接 status 兜底）。
- [ ] `session_info`：v2 显示 `outcome/cost/tokens` + diff；**todo 字段去掉**。
- [ ] 分页：`/api/session` 默认 50，需 cursor；至少保证“默认最近 N 条”，不要假设一次拿全。
- [ ] 测试：v2 只读 fixtures + v1 回归。

**退出标准**：v2 server 下列会话/读消息/列目录有真实数据；分页/搜索/目录过滤正确；v1 全部现有只读行为不回归；错误路径有测试。

### 4.4 Phase 2 — 运行/委派/SSE 完成（1.5–2 人日）

目标：v2 上“跑得通”——委派、续聊、完成等待、进度、abort。

- [ ] `delegate.js`：`promptBody` v2（`text/files`）；`extractAssistant`（content）；`waitAssistant`（execution 事件 + idle 消息/ wait 兜底）；`syncPrompt`/`asyncPrompt`。
- [ ] `session-run.js`：`ensureSession`（body location/title/agent/model）、`sendSessionMessage`（prompt）、`abortRemote`（interrupt）。
- [ ] `sse.js`：`/api/event` 包络；`session.execution.*` 完成；`session.text.*`/`reasoning.*`/`tool.*`/`step.*` 进度；`session.deleted`；`permission.asked`/`form.created` 快路径（Phase 3 完整接）。
- [ ] `provider.js`/`run.js`：result 映射、abort、dispose；`agent/model` 覆盖走 session 级接口。
- [ ] `routes.js`：`/prompt`、`/abort`、`/delegate`、`/progress`、`/events`。
- [ ] `tools.js`：`opencode_subagent`、`opencode_prompt`、`opencode_abort`、`opencode_progress`。
- [ ] 完成判定：优先 `execution.succeeded/failed/interrupted`；轮询 `message?type=idle&order=desc&limit=1`；`session.idle` 仅兼容分支。
- [ ] 测试：真实 2.3.0 e2e（PONG/工具/shell）+ fixtures；timeout/abort/interrupt。

**退出标准**：v2 上 `opencode_subagent` 能返回最终文本；`opencode_prompt(wait=true)` 能等到本轮结束；abort 生效；progress 有 tool/step/tail；v1 委派不回归。

### 4.5 Phase 3 — 权限/提问交互（0.5–1 人日）

目标：v2 上审批卡/提问 UI 继续工作。

- [ ] `sse.js`：`permission.asked` / `form.created` 解析（`data` 包络）。
- [ ] `interactions.js`：permission 列表（session 级优先）/回复（`decision`）/`action+resources` 映射；form 列表/回复（`answer`）/DELETE 取消；多字段/多选/数字/布尔映射。
- [ ] `watchInteractions`：轮询改 `/api/session/{id}/permission`、`/api/session/{id}/form`。
- [ ] 配置语义：`permission: ask|allow|reject` 映射 `once|always|reject`；question policy 映射“转发/取消”。
- [ ] 测试：真实 permission 触发/回复；真实 form 触发/回复/取消；并发/重复事件幂等。

**退出标准**：v2 上 dsh 审批卡能允许/拒绝；dsh 提问 UI 能回答/取消；远端继续执行；事件丢失时轮询兜底；v1 不回归。

### 4.6 Phase 4 — 工作区/写操作/移除功能（1–1.5 人日）

目标：把剩余工具补齐或明确标记不可用。

- [ ] `workspace.js`：shell（204 + shell 消息/事件）、git status/diff、read file、find file；文本 find 降级。
- [ ] `manage.js`：fork（`before`）、compact（替代 summarize）、init（command）、children（parentID）。
- [ ] `routes.js`：`/shell`、`/git/*`、`/file`、`/find`、`/fork`、`/children`、`/summarize`、`/init`、`/share`。
- [ ] `tools.js`：`opencode_shell/git_status/git_diff/read_file/find/fork/children/summarize/init/command`。
- [ ] 移除/降级：`opencode_share`、`opencode_tools`、`opencode_find(kind=text)`、`session_info.todos`；v2 下返回明确错误/按版本隐藏，v1 保留。
- [ ] 附件：v2 `files[{uri,name}]`；文本仍追加 text；大小/类型限制。
- [ ] `client.js`：字段/版本显示；嵌入登录方案（先手动，后代理）。
- [ ] 测试：每个工具的成功/不可用/错误路径。

**退出标准**：26 个工具在 v2 上要么工作、要么明确“不支持”；无静默空结果；文件/ git/shell 真实可用；v1 回归。

### 4.7 Phase 5 — UI/文档/发布（0.5–1 人日）

- [ ] Web UI：确认 iframe 打开 v2 SPA 时的登录流程；如果要求免登录，增加 dsh 侧反向代理（注入 Basic auth，不把密码放 URL）；验证 session 深链。
- [ ] `COMPATIBILITY.md`：加入 2.3.0 实测矩阵、v1/v2 支持策略、已知限制。
- [ ] `CHANGELOG.md`：0.2.0（能力新增，按仓库策略走 minor）记录 v2 支持、移除/降级功能。
- [ ] `README*`/`TODO.md`/`docs/TOOLS.zh.md`：工具可用性、配置（`OPENCODE_SERVER_PASSWORD`、`apiVersion`）、迁移说明。
- [ ] CI：`npm run check` + `npm test`；可选 nightly e2e（有 `OPENCODE_V2_BIN` 时跑）。
- [ ] 发布：版本号、tag、升级说明；明确 1.x 维护窗口。

**退出标准**：文档准确；CI 绿；手工 UI 验证通过；发布说明能让 1.x/2.x 用户各自找到路径。

### 4.8 工作量汇总

| 阶段 | v2-only | 双栈 |
|---|---|---|
| Phase 0 | 0.5–1 | 0.5–1 |
| Phase 1 | 1–1.5 | 1–1.5 |
| Phase 2 | 1.5–2 | 2–2.5 |
| Phase 3 | 0.5–1 | 0.75–1.25 |
| Phase 4 | 1–1.5 | 1.5–2 |
| Phase 5 | 0.5–1 | 0.5–1 |
| 合计 | **5–8 人日** | **6.5–9.5 人日** |

不含：OpenCode 侧数据迁移排障、Web UI 代理（+0.5–1 人日）、真实 provider 矩阵；各阶段已含对应的 fixture/单测。

---

## 5. 测试计划

### 5.1 测试层次

1. **fixture/contract 单测**（默认 CI，离线）：用 2.3.0 抓取的 JSON/SSE 样本驱动 `http`/`sessions`/`delegate`/`interactions`/`sse`，断言解析和错误。
2. **工具级测试**：每个 `opencode_*` 的 v2 成功路径 + 不可用/401/HTML/超时路径；重点是“不会静默返回 0”。
3. **真实 e2e**（可选/夜间）：启动 2.3.0 binary，临时 HOME 和 `OPENCODE_SERVER_PASSWORD`，用免费模型或本地 stub provider 跑完整流程。
4. **v1 回归**：1.18.33 上跑现有 26 工具的关键路径，防止双栈破坏旧版。
5. **手工 UI**：iframe 嵌入、登录、会话列表、新建会话、深链。

### 5.2 必测用例

| # | 场景 | 断言 |
|---|---|---|
| T1 | 无 auth 访问 `/api/*` | 工具返回明确 401 错误，不是空结果 |
| T2 | 错误密码/未配密码 | 明确 `unauthorized` 提示；启动状态可见 |
| T3 | v1 路径返回 HTML | 明确 `incompatible server` 错误；不 JSON.parse 成空 |
| T4 | 版本探测 | 2.3.0 判 v2；1.18.x 判 v1；`apiVersion` 覆盖生效 |
| T5 | 包络 | `{data}`/`{data,cursor}`/`{location,data}`/裸数组/204/`{interrupted}` 全部正确解包 |
| T6 | 会话列表 | 目录/搜索/parentID/limit/order/cursor；`location.directory`/`time.updated` |
| T7 | 创建会话 | body `location.directory` 生效；query/header 不生效（防回归）；agent/model 指定 |
| T8 | 消息 | 默认 desc；最新 N 反序；`type` 过滤；user text；assistant content；tool state；idle outcome |
| T9 | prompt | `{text,files}`；200 Inbox；409；agent/model 设置；附件 data URL |
| T10 | 完成 | execution success/fail/interrupted；idle 消息轮询；timeout；wait 204 |
| T11 | abort | interrupt `{interrupted}`；运行中 true、空闲 false；等待方返回取消 |
| T12 | SSE | data 行/heartbeat/多事件；text/reasoning/tool/step/execution；`session.deleted`；重连；401 |
| T13 | 权限 | 列表/事件/回复 once/always/reject；session 作用域；404/重复回复 |
| T14 | 提问 | form 列表/事件；string/multiselect/number/boolean；回复；DELETE 取消；invalid answer |
| T15 | shell | 204；`message?type=shell` 输出；exit/timeout/kill；多个 shell 关联 |
| T16 | command | `{name,text}`；init 204；等待；失败 |
| T17 | fork/compact/children | body/返回/分页；compact 语义说明 |
| T18 | fs/vcs | read text/binary/404；find file；vcs status/diff mode/patch |
| T19 | 移除功能 | share/tools/text-find/todo 在 v2 明确不可用；v1 仍可用（双栈） |
| T20 | 多 server | v1+v2 混合聚合；单 server 失败不影响其他 server |
| T21 | 附件 | data URL；文本 inline；大小限制；二进制/图片 |
| T22 | 结构化输出 | prompt 约束 JSON 仍可解析；required 校验 |
| T23 | 超时/网络错误 | 明确错误；不永久挂起；SSE 重连退避 |
| T24 | 凭据 | 工具输出/日志/错误不泄露 password/Basic 头 |

### 5.3 夹具与 e2e

- `test/fixtures/v2/`：
  - `session-list.json`、`session-create.json`、`messages.json`、`agents.json`、`providers.json`、`models.json`、`commands.json`、`skills.json`、`references.json`、`mcp.json`、`vcs-*.json`、`fs-*.json`；
  - `sse-execution.sse`、`sse-tool.sse`、`sse-permission.sse`、`sse-form.sse`、`sse-heartbeat.sse`。
- `scripts/e2e-v2.mjs`（可选）：
  - 读 `OPENCODE_V2_BIN`；没有则 skip；
  - 临时 HOME/XDG + `OPENCODE_SERVER_PASSWORD`；`serve --port` 随机空闲端口；
  - 等 `/api/info`；创建会话；prompt（优先本地 stub provider；否则免费模型）；
  - 断言事件顺序/最终文本/permission/form；退出时 kill server。
- `npm test` 用 `node --test`；CI 至少跑离线单测 + `npm run check`；e2e 可夜间/手动。

### 5.4 手工验收

- v2 server 配好密码，dsh 插件页显示 online/version 2.3.0。
- 会话列表/目录/标题/更新时间正确；新建会话落到指定目录。
- `opencode_subagent` 返回最终文本；`opencode_prompt(wait)` 返回本轮文本。
- 侧边栏嵌入 v2 Web UI：能登录/使用；或在文档中明确需要手动登录。
- v1 server 回归：原有功能不变。

---

## 6. 风险、决策与未决问题

| # | 风险/问题 | 影响 | 建议 |
|---|---|---|---|
| R1 | v2 仍在快速变化（2.3.0→2.3.2 已发布） | 端点/字段可能再变 | 固定测试矩阵；用 `/api/info` 版本 + 能力探测；不要把 2.3.0 当永久契约 |
| R2 | 双栈维护成本 | v1/v2 两套测试/行为 | 明确 v1 退场版本（如 0.3.0）；v1 只修 bug，不加功能 |
| R3 | `session.idle` 是否在某些场景发出 | 完成等待可能挂起/超时 | 以 `execution.*` 为主；`wait`/idle 消息兜底；保留兼容分支 |
| R4 | 移除 share/todo/tool ids/text search | 用户功能回退 | 产品决策：删除/隐藏/用 shell 近似；在 CHANGELOG/工具描述写清 |
| R5 | Web UI iframe 需要登录 | 嵌入体验下降 | 先文档说明手动登录；要无缝则 dsh 侧代理注入 Basic auth（不要把密码放 URL） |
| R6 | 上游 v1→v2 会话迁移 | 升级后列表为空/缺会话 | 插件无法修复；文档提示 + 健康检查/诊断；必要时让用户跑 OpenCode 迁移 |
| R7 | provider/model 凭据/免费模型变化 | e2e 不稳定 | e2e 优先本地 stub；免费模型只做手工冒烟 |
| R8 | `x-opencode-directory` 头未来可能移除 | 目录作用域失效 | 逐步改用显式 `location[directory]`/body location；头作为兼容 |
| R9 | 401/HTML 静默失败是当前最大风险 | 用户以为“没数据” | Phase 0 必须先修；所有工具错误可读 |
| R10 | shell 异步关联 | 可能取到别的 shell 消息 | 用 `shell.created/exited` 事件中的 shellID/命令关联；超时/多命令测试 |
| R11 | 大仓库 diff/read | 超时/内存 | 保留截断/上限；分页/cursor；超时参数 |

### 需要 owner 决策的点

1. **v1 是否保留在 0.2.0**：B1（双栈，推荐）还是 B0（v2-only，省 1.5–2 人日）？
2. **移除功能**：share/todo/tool ids/text find 是删除、隐藏，还是用 shell/外部存储近似？
3. **Web UI**：接受手动登录，还是要求 dsh 侧代理免登录？
4. **目标版本**：只保证 2.3.0，还是 2.3.x/latest 2.x 矩阵？
5. **发布版本**：0.2.0（推荐，能力新增）还是 0.1.1（若只修 bug）？双栈/破坏 v1 语义时按仓库策略应 minor。

---

## 7. 立即可执行的第一步（本计划之后）

1. 先做 Phase 0 的 `lib/http.js` 错误可见化（0.5 天），这是后续所有验证的前提。
2. 用 2.3.0 抓 fixtures（session/message/prompt/SSE/permission/form/tool/execution），进 `test/fixtures/v2/`。
3. 实现 `apiVersion` 探测（`/api/info` vs `/global/health`），在插件页/日志显示 `online v2.3.0`、`unauthorized`、`incompatible`。
4. 再按 Phase 1 → 2 → 3 → 4 推进；每个 Phase 结束都跑 v1 回归 + v2 fixture/e2e。
5. 最后再决定 share/todo/tool ids/text find 的产品处理，不要在没有决策前“假装支持”。

---

## 附录 A：本次实测命令（可复现）

```bash
# 1) 下载并解压 2.3.0（Linux x64）
mkdir -p /tmp/oc2 && cd /tmp/oc2
curl -sL -o oc2.tar.gz \
  https://github.com/anomalyco/opencode/releases/download/v2.3.0/opencode-linux-x64.tar.gz
tar xzf oc2.tar.gz
./opencode --version   # opencode v2.3.0

# 2) 隔离启动
mkdir -p /tmp/oc2home/{config,data,cache,state,share} /tmp/oc2work
cd /tmp/oc2work
HOME=/tmp/oc2home XDG_CONFIG_HOME=/tmp/oc2home/config \
XDG_DATA_HOME=/tmp/oc2home/data XDG_CACHE_HOME=/tmp/oc2home/cache \
XDG_STATE_HOME=/tmp/oc2home/state \
OPENCODE_SERVER_PASSWORD=testpass \
/tmp/oc2/opencode serve --hostname 127.0.0.1 --port 4199

# 3) 探测
A=opencode:testpass
curl -s -u "$A" http://127.0.0.1:4199/api/info
curl -s -u "$A" -o /tmp/openapi.json http://127.0.0.1:4199/openapi.json
curl -s -u "$A" http://127.0.0.1:4199/api/session
curl -s -u "$A" -X POST http://127.0.0.1:4199/api/session \
  -H 'content-type: application/json' \
  -d '{"title":"probe","location":{"directory":"/tmp/oc2work"}}'

# 4) SSE + prompt
curl -sN -u "$A" http://127.0.0.1:4199/api/event > /tmp/events.sse &
SID=ses_xxx
curl -s -u "$A" -X POST "http://127.0.0.1:4199/api/session/$SID/prompt" \
  -H 'content-type: application/json' \
  -d '{"text":"Reply with exactly: PONG"}'
# 观察 session.execution.started/succeeded、session.text.delta 等
```

## 附录 B：v2 关键事件/数据形状

```text
SSE  block:  data: {"id":"evt_...","created":...,"type":"...","location":{...},"data":{...},"durable":{...}}
             : heartbeat

session.execution.started       data:{sessionID}
session.execution.succeeded     data:{sessionID}
session.execution.failed        data:{sessionID,error}
session.execution.interrupted   data:{sessionID,reason:user|shutdown|superseded|inactivity}
session.text.delta              data:{sessionID,assistantMessageID,ordinal,delta}
session.text.ended              data:{sessionID,assistantMessageID,ordinal,text}
session.reasoning.delta         data:{sessionID,assistantMessageID,ordinal,delta}
session.tool.called             data:{sessionID,assistantMessageID,id,name,input,executed}
session.tool.progress           data:{sessionID,assistantMessageID,id,metadata}
session.tool.success            data:{sessionID,assistantMessageID,id,content,metadata,executed}
session.tool.failed             data:{sessionID,assistantMessageID,id,error,content?,metadata?}
session.step.started/ended      data:{sessionID,assistantMessageID,agent?,model?,finish?,tokens?,cost?}
permission.asked                data:{id,sessionID,action,resources,save?,source,message?}
permission.replied              data:{sessionID,requestID,reply}
form.created                    data:{form:{id,sessionID,title,fields}}
form.replied                    data:{id,sessionID,answer}
session.deleted                 data:{sessionID}
session.created                 data:{sessionID,slug,projectID,location,title,...}
server.connected                data:{}
```

消息示例（v2）：

```json
{
  "data": [
    {"id":"msg_...","type":"idle","outcome":"succeeded","time":{"created":...}},
    {"id":"msg_...","type":"assistant","content":[
      {"type":"text","text":"PONG"},
      {"type":"tool","id":"call_...","name":"shell","state":{"status":"completed","input":{"command":"echo x"},"content":[{"type":"text","text":"x\n"}],"metadata":{"exit":0}}}
    ],"finish":"stop","time":{"created":...,"completed":...}},
    {"id":"msg_...","type":"user","text":"...","files":[{"data":"...","mime":"text/plain","source":{"type":"inline"},"name":"note.txt"}]}
  ],
  "cursor": {"previous":"...","next":"..."}
}
```

## 附录 C：参考

- OpenCode 2.3.0 release：<https://github.com/anomalyco/opencode/releases/tag/v2.3.0>
- 实测 OpenAPI：本机 `http://127.0.0.1:4199/openapi.json`（需 Basic auth；139 paths / 515 schemas）
- 本仓库 issue：<https://github.com/yhuan416/dsh-opencode-client/issues/1>
- 代码基线：`lib/http.js`、`lib/sse.js`、`lib/sessions.js`、`lib/delegate.js`、`lib/interactions.js`、`lib/catalog.js`、`lib/workspace.js`、`lib/manage.js`、`lib/session-run.js`、`lib/routes.js`、`lib/tools.js`

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
