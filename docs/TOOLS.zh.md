# 工具总览 — dsh-opencode-client

本插件的 27 个面向模型的工具全部由 `lib/tools.js` 的 `registerTools()` 通过
`ctx.tools.register(defineTool(...))` 注册，工具名统一以 `opencode_*` 开头。本文按主题列出每个
工具的用途、关键参数、只读/可变属性、对应的远端 OpenCode HTTP API，以及 OpenCode 2（v2）上的
可用性与行为差异；以源码为准，不包含未实现的工具。

## 通用约定

- **API 版本**：每台 server 独立探测（配置 `apiVersion: auto | 1 | 2`）。`auto` 用
  `GET /api/info`（HTTP Basic，用户名固定 `opencode`，密码来自 `OPENCODE_SERVER_PASSWORD`）
  探测；OpenCode >= 2 时后续所有请求自动加 `/api` 前缀。未配置密码时直接按 v1 处理；探测失败或
  返回 401 时回退 v1。原因记录在 server 上（启动日志可见）。工具本身不判断版本，按探测结果选择端点。
- **v2 差异列**：每张表最后一列说明该工具在 v2 上是否可用。“同 v1”表示归一化后行为一致，但
  底层端点/包络可能不同（见“远端 API”列）；“不可用”表示 v2 缺少对应端点，调用会返回明确错误。
  v1 与 v2 server 可以在同一份配置里混用。
- **server 参数**：省略时使用配置里的第一台 server（默认 server）；`opencode_sessions`、
  `opencode_search`、`opencode_agents`、`opencode_models`、`opencode_commands`、
  `opencode_skills`、`opencode_tools`、`opencode_references`、`opencode_mcp`、
  `opencode_progress`、`opencode_board` 省略时会聚合所有已配置 server。
- **directory 参数**：省略时使用该 server 配置里的 `directory`；两者都没有时由远端 OpenCode
  使用它自己的默认目录。注意会话作用域的操作在 v2 上以会话自身的 `location.directory` 为准：
  `opencode_prompt` / `opencode_command` 的 `directory` 参数在 v2 不生效；`opencode_shell` 例外，
  显式 `directory` 会作为 v2 shell 的 `cwd`，缺省时才用会话目录。
- **只读 / 可变**：只读工具只发起 GET 或纯查询，不改变远端状态；可变工具会新建/修改会话、
  执行命令或改动工作区，调用前应确认意图（`opencode_init` 还强制要求 `confirm=true`）。
- **返回值**：所有工具的 output 都是字符串（便于模型直接阅读），失败时返回
  `<工具名> failed: ...` 形式的错误文本。
- **认证**：配置了 `password` 就发送 Basic auth（用户名固定 `opencode`），与
  `OPENCODE_SERVER_PASSWORD` 对应；v2 强制要求，未配置密码时按 v1 处理，v1 通常不校验。

## 1. 委派与续聊

| 工具 | 用途 | 关键参数 | 类型 | 远端 API（v1 / v2） | v2 差异 |
|---|---|---|---|---|---|
| `opencode_subagent` | 把任务委派给远端 OpenCode：新建会话或 `session=` 续用，等待本轮结束并返回最终答案 + 会话 id | `task`（必填）、`directory`、`server`、`session`、`agent`、`model`、`schema`、`files` | 可变（会创建会话并驱动远端 agent） | v1 `POST /session` + `POST /session/{id}/prompt_async`（失败回退阻塞式 `POST /session/{id}/message`）；v2 `POST /session`（body 带 `location.directory`、`agent`、`model`）+ `POST /session/{id}/prompt` | 同 v1；提示词为 `{text, files:[{uri,name}]}`，agent/model 是会话级状态（新建时写入；续聊时发送前写入）；v2 的 `model` 可写 `provider/model#variant` 选择推理档 |
| `opencode_prompt` | 向已有远端会话发一条消息；默认 fire-and-forget，`wait=true` 阻塞本轮并返回最终文本 | `server`、`session`（必填）、`message`（必填）、`wait`、`agent`、`model`、`directory` | 可变 | v1 `POST /session/{id}/prompt_async`；v2 `POST /session/{id}/prompt` | 同 v1；`agent`/`model` 在 v2 通过 `POST /session/{id}/agent`、`/session/{id}/model` 写为会话状态（持续影响后续轮次），`wait=true` 依据 `session.execution.*` + `idle` 消息判定完成 |
| `opencode_progress` | 查看运行中远端任务的实时进度：当前工具/步骤、耗时、输出 tail | `server`（省略=全部） | 只读 | v1 SSE 进度缓存 + `GET /session/status` 兜底；v2 同缓存 + `GET /session/active` 兜底 | 同 v1（兜底状态端点不同） |
| `opencode_abort` | 中止运行中的远端会话；等待中的委派会以 abort 错误返回而不是挂起 | `server`、`session`（必填） | 可变 | v1 `POST /session/{id}/abort`；v2 `POST /session/{id}/interrupt`（响应 `{interrupted}`） | 同 v1（v2 端点改名；远端以 `interrupted` 结束，等待中的委派返回 abort 错误） |

> `opencode_abort` 需从另一个 dsh 会话/agent 发起：同一轮次内工具调用是串行的，无法抢占同轮次
> 里阻塞中的 `opencode_subagent`。

## 2. 会话与消息

| 工具 | 用途 | 关键参数 | 类型 | 远端 API（v1 / v2） | v2 差异 |
|---|---|---|---|---|---|
| `opencode_board` | **观测台**：跨 server 汇报「谁在跑 / 谁在等我 / 空闲」，先刷新快照再读登记表；与 Web 面板的 `/api/opencode-client/board` 共用同一个 `lib/board.js` | `server`、`idle`（默认 5，上限 30） | 只读 | v1 `GET /session/status` + `GET /permission` + `GET /question`；v2 `GET /session/active` + `GET /api/permission/request` + `GET /api/form` | 同 v1（v2 走 location 级全局端点，一次查询拿全） |
| `opencode_sessions` | 列出远端会话（server、工作区、标题、最后更新、会话 id；服务端提供时附 model#variant/agent/outcome/cost），可按目录/标题过滤 | `server`、`directory`、`query`、`limit`（默认 50，上限 200） | 只读 | v1 `GET /global/health` + `GET /project` + `GET /session`；v2 `GET /info` + `GET /project` + `GET /session?limit=200` | 同 v1；v2 用 `canonical` 作工作区、列表为 `{data,cursor}`、目录在 `location.directory`，目录/标题过滤仍在客户端完成 |
| `opencode_messages` | 读取某会话的最近消息（text / tool / file 展平；tool 行带入参摘要与输出首行） | `server`、`session`（必填）、`limit`（默认 20，上限 200）、`type`（可选消息类型过滤） | 只读 | v1 `GET /session/{id}/message`；v2 `GET /session/{id}/message?order=desc&limit=N`（跟随 `cursor.next` 分页） | 同 v1；v2 消息体是 `content[]`（无 `parts`），按 `order=desc` 取回后反转为旧→新输出；请求超过一页（服务端默认 50）时自动翻页，最多 20 页/4000 条；`type=` 在 v2 服务端过滤、v1 本地过滤，默认隐藏 idle/system 等记账消息 |
| `opencode_session_info` | 读取会话元数据、todo 列表与改动文件 diff，用于判断会话做过什么 | `server`、`session`（必填） | 只读 | v1 `GET /session/{id}` + `/todo` + `/diff`；v2 `GET /session/{id}` + `/diff` + 最近消息（推导 todo） | v1 用 `/todo`；v2 无 todo 端点，从最后一次 `todowrite` 工具调用（`state.input.todos`）推导并标注 `[derived from the last todowrite call]`；元数据/cost/tokens/outcome/diff 可用 |
| `opencode_share` | 分享会话（生成公开链接）或取消分享 | `server`、`session`（必填）、`action`（`share` 默认 / `unshare`） | 可变（仅改分享状态） | v1 `POST` / `DELETE /session/{id}/share`；v2 无端点 | **仅 v1**：v2 调用返回明确错误（建议改用 OpenCode Web UI），不会静默成功 |
| `opencode_search` | 按标题搜索会话 | `server`、`query`（必填）、`directory`、`limit`（默认 20，上限 100） | 只读 | v1 `GET /session?search=` + 客户端标题过滤；v2 `GET /session?search=&limit=&directory=` | 同 v1；v2 由服务端搜索并支持 `directory` 限定，v1 在本地按标题包含关系过滤 |

## 3. 会话管理

| 工具 | 用途 | 关键参数 | 类型 | 远端 API（v1 / v2） | v2 差异 |
|---|---|---|---|---|---|
| `opencode_fork` | 把会话分叉成一个新的分支会话，返回新会话 id | `server`、`session`（必填）、`message`（可选分叉点消息 id） | 可变（仅新建会话） | v1 `POST /session/{id}/fork {messageID?}`；v2 同路径 `{before?}`（响应 `{data}`） | 同 v1；分叉点字段改名为 `before` |
| `opencode_children` | 列出某会话派生的子会话（例如远端 subagent 创建的） | `server`、`session`（必填） | 只读 | v1 `GET /session/{id}/children`；v2 `GET /session?parentID=&limit=200` | 同 v1（v2 无 `/children`，改用列表过滤） |
| `opencode_summarize` | 压缩/总结会话历史（更新会话 summary） | `session`、`model`（v1 必填，`provider/model` 来自 `opencode_models`）、`server` | 可变 | v1 `POST /session/{id}/summarize {providerID,modelID}`；v2 `POST /session/{id}/compact`（无 body） | v2 映射为 `compact`，使用会话自身的 agent/model，`model` 可省略；v1 仍必填 |
| `opencode_init` | 运行远端 `/init` 流程（写/更新 AGENTS.md） | `session`、`model`（v1 必填）、`confirm=true`（必填）、`server` | 可变（写文件） | v1 `POST /session/{id}/init {providerID,modelID,messageID}`；v2 `POST /session/{id}/command {name:"init",text:""}` 并等待本轮 | `model` 在 v2 可省略；v2 通过内置 `init` 命令异步执行并等待该轮结束。`confirm=true` 两代都强制 |

## 4. 目录与工具发现

| 工具 | 用途 | 关键参数 | 类型 | 远端 API（v1 / v2） | v2 差异 |
|---|---|---|---|---|---|
| `opencode_agents` | 列出 server 提供的 agent，委派前用来选 agent 名 | `server` | 只读 | v1 `GET /agent`；v2 `GET /agent?location[directory]=` | 同 v1；v2 agent 为 `id`/`name`/`mode`/`hidden`（无 `native` 标记）；用户传的 `name` 会在发送前解析为 `id` |
| `opencode_models` | 列出 LLM provider 与 model id（凭据字段已剔除），用来选 `provider/model#variant` | `server` | 只读 | v1 `GET /config/providers`；v2 `GET /provider` + `GET /model` + `GET /model/default` | 同 v1（凭据依旧不下发；v2 额外汇总默认模型、`variants` 推理档与 `limit` 上下文/输出上限，如 `[ctx 1M, out 384k]`） |
| `opencode_commands` | 列出自定义命令 | `server` | 只读 | v1 `GET /command`；v2 `GET /command` | 同 v1；v2 只返回 `name`/`description`（不再有 agent/model/source/subtask） |
| `opencode_skills` | 列出远端可见的 Agent Skills（名称、描述、位置，内容省略） | `server` | 只读 | v1 `GET /skill`；v2 `GET /skill` | 同 v1；v2 位置字段为 `path`，内容不展示 |
| `opencode_tools` | 列出远端可用工具 id（内置 + MCP/自定义） | `server` | 只读 | v1 `GET /experimental/tool/ids`；v2 无端点 | **仅 v1**：v2 输出明确说明端点被移除（不是空列表） |
| `opencode_references` | 列出项目 references | `server` | 只读 | v1/v2 均为 `GET /api/reference`（v2 带 `location[directory]=`） | 同 v1（v1 也使用 `/api/reference`，与 v2 的 `/api` 前缀不是同一概念） |
| `opencode_command` | 在已有会话内执行一个 OpenCode 命令（如 `init`）并返回最终文本 | `server`、`session`（必填）、`command`（必填，不带前导 `/`）、`arguments`、`directory` | 可变 | v1 `POST /session/{id}/command {command,arguments}`（同步 200）；v2 同路径 `{name,text}`（204 后异步执行） | 同 v1 语义，但 v2 需等待该轮结束才返回文本；`directory` 参数在 v2 不生效（以会话 `location.directory` 为准） |
| `opencode_mcp` | 查看 MCP 服务状态（connected/needs_auth/disabled）；只读，不提供 connect/disconnect/auth | `server` | 只读 | v1 `GET /mcp`（`status` 为字符串）；v2 `GET /mcp`（`{location,data}`，`status` 为对象） | 同 v1；v2 从对象中取 `status.status` / `status.error` |

## 5. 工作区与 git

| 工具 | 用途 | 关键参数 | 类型 | 远端 API（v1 / v2） | v2 差异 |
|---|---|---|---|---|---|
| `opencode_shell` | 在已有会话内跑一条 shell 命令（确定性执行，不跑完整 agent），用于验收/构建 | `server`、`session`（必填）、`command`（必填）、`directory` | 可变（命令可能改动工作区） | v1 `POST /session/{id}/shell`（同步返回）；v2 `POST /shell` → 轮询 `GET /shell/{id}` → `GET /shell/{id}/output` | 同 v1 语义但 v2 异步；显式 `directory` 作为 cwd，缺省用会话 `location.directory`；v2 输出按 cursor 翻页（上限 1 MiB），截断显式提示 `[output truncated at N bytes; cursor=M]`，并带 exit/signal；v2 不写入会话消息历史 |
| `opencode_read_file` | 读取远端工作区中的一个文本文件（路径相对 `directory`） | `server`、`directory`、`path`（必填） | 只读 | v1 `GET /file/content?path=&directory=`；v2 `GET /fs/read/{path}`（原始字节） | 同 v1；v2 按 `content-type` / 空字节判断二进制，文本截断到 40k 字符 |
| `opencode_find` | 搜索远端工作区：`kind=file`（默认）按路径/glob，`kind=text` 按文件内容 | `server`、`directory`、`query`（必填）、`kind`、`limit`（仅 file 搜索生效，默认 50，上限 200） | 只读 | v1 `GET /find/file`（file）或 `GET /find`（text）；v2 `GET /fs/find?query=&type=file&limit=`（file）、`POST /shell` 跑 `grep -rIn -F`（text） | v2 的 file `query` 是**子串匹配**（不认 glob），工具会先按原样查，0 结果时去掉 `*`/`?` 再试一次（`*.txt` → `.txt`）；`kind=text` 在 v2 通过工作区 `grep` 补回：字面子串、最多 100 条、跳过 `.git`，输出 `path:line: text` |
| `opencode_git_status` | 读取工作树状态（改动文件 + 增删行数），用于核对远端 agent 改了什么 | `server`、`directory` | 只读 | v1 `GET /vcs/status?directory=`；v2 `GET /vcs/status?location[directory]=` | 同 v1（v2 解包 `{location,data}`） |
| `opencode_git_diff` | 读取改动文件摘要；`mode=branch` 看分支对比，`patch=true` 附带每个文件的 patch（截断到约 20k 字符） | `server`、`directory`、`mode`（`git` 默认 / `branch` / `committed`）、`patch` | 只读 | v1 `GET /vcs/diff?mode=git` / `branch`；v2 `GET /vcs/diff?mode=working` / `branch` / `committed` | 同 v1；v2 上 `git`→`working`，`branch`/`committed` 同名（v1 不支持 `committed`） |

## 典型流程

1. **发现**：`opencode_sessions` 找到目标会话；`opencode_agents` / `opencode_models` 选定
   agent 与模型（v2 上 agent 以 `id` 为准，工具会自动把 `name` 解析成 `id`）。
2. **委派**：`opencode_subagent` 带 `task`（可加 `agent`/`model`/`schema`/`files`）执行，记下返回
   的 `session` id。
3. **观察**：任务运行期间用 `opencode_progress` 看当前工具与 tail；需要停止时从另一个会话调用
   `opencode_abort`（v2 走 `/interrupt`）。
4. **验收**：`opencode_git_status` / `opencode_git_diff` 看改动，`opencode_read_file` 读关键文件，
   `opencode_shell` 跑构建/测试（v2 异步执行，但工具会等到输出返回）。
5. **续聊**：`opencode_prompt` 向同一会话继续发消息（默认异步，`wait=true` 等本轮），回复用
   `opencode_messages` 读取；也可以用 `opencode_fork` 从某个分叉点另开分支。

以上流程的步骤在 v1/v2 上一致，端点与少数参数的差异见上表；v2 上 `opencode_share`、
`opencode_tools` 不可用，调用时会得到明确提示；`opencode_find(kind=text)` 与
`opencode_session_info` 的 todo 已通过 v2 原生能力补回（shell grep / `todowrite` 推导）。

## 注意

- `opencode_subagent` 的 `schema` 是 **prompt 约束**（不发送 OpenCode 的 `format`），结果在本地
  校验 required 字段；原因见 README 的 upstream bug 说明。
- `files` 是 JSON 数组，元素为 `{filename, mime, content|base64}`，最多 10 个、单文件约 5 MB。
  v1 以 data URL file part 发送并内联 `text/*` 内容；v2 以 `files:[{uri,name}]` 发送，`text/*`
  仍内联进提示词的 `text`。
- `opencode_summarize` / `opencode_init` 的 `model` 在 v1 必须来自 `opencode_models`；v2 可省略
  （compact 用会话自身模型、init 用内置命令）。`opencode_init` 两代都不传 `confirm=true` 会直接拒绝。
- v2 无替代的能力（`opencode_share`、`opencode_tools`）一律显式报错，不会退化成空结果；
  `opencode_find(kind=text)`、`opencode_session_info` 的 todo、消息分页与模型 variants 已在
  0.4.0 用 v2 原生能力补回；v1 行为保持不变。
- 结构化输出、权限卡、多 server 聚合等行为限制见仓库根目录 README 的 Notes 与
  [COMPATIBILITY.md](../COMPATIBILITY.md)。
