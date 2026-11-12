# 工具总览 — dsh-opencode-client

本插件的 26 个面向模型的工具全部由 `lib/tools.js` 的 `registerTools()` 通过
`ctx.tools.register(defineTool(...))` 注册，工具名统一以 `opencode_` 开头。本文按主题列出每个
工具的用途、关键参数、只读/可变属性以及对应的远端 OpenCode HTTP API；以源码为准，不包含
未实现的工具。

## 通用约定

- **server 参数**：省略时使用配置里的第一台 server（默认 server）；`opencode_sessions`、
  `opencode_search`、`opencode_agents`、`opencode_models`、`opencode_commands`、
  `opencode_skills`、`opencode_tools`、`opencode_references`、`opencode_mcp`、
  `opencode_progress` 省略时会聚合所有已配置 server。
- **directory 参数**：省略时使用该 server 配置里的 `directory`；两者都没有时由远端 OpenCode
  使用它自己的默认目录。
- **只读 / 可变**：只读工具只发起 GET 或纯查询，不改变远端状态；可变工具会新建/修改会话、
  执行命令或改动工作区，调用前应确认意图（`opencode_init` 还强制要求 `confirm=true`）。
- **返回值**：所有工具的 output 都是字符串（便于模型直接阅读），失败时返回
  `<工具名> failed: ...` 形式的错误文本。
- **认证**：使用 server 配置里的 `password` 走 Basic auth（用户名固定 `opencode`），与
  `OPENCODE_SERVER_PASSWORD` 对应。

## 1. 委派与续聊

| 工具 | 用途 | 关键参数 | 类型 | 远端 API |
|---|---|---|---|---|
| `opencode_subagent` | 把任务委派给远端 OpenCode：新建会话或 `session=` 续用，等待本轮结束并返回最终答案 + 会话 id | `task`（必填）、`directory`、`server`、`session`、`agent`、`model`、`schema`、`files` | 可变（会创建会话并驱动远端 agent） | `POST /session` + `POST /session/{id}/prompt_async`（失败回退阻塞式 `POST /session/{id}/message`） |
| `opencode_prompt` | 向已有远端会话发一条消息；默认 fire-and-forget，`wait=true` 阻塞本轮并返回最终文本 | `server`、`session`（必填）、`message`（必填）、`wait`、`agent`、`model`、`directory` | 可变 | `POST /session/{id}/prompt_async` |
| `opencode_progress` | 查看运行中远端任务的实时进度：当前工具/步骤、耗时、输出 tail | `server`（省略=全部） | 只读 | SSE 进度缓存 + `GET /session/status` 兜底 |
| `opencode_abort` | 中止运行中的远端会话；等待中的委派会以 abort 错误返回而不是挂起 | `server`、`session`（必填） | 可变 | `POST /session/{id}/abort` |

> `opencode_abort` 需从另一个 dsh 会话/agent 发起：同一轮次内工具调用是串行的，无法抢占同轮次
> 里阻塞中的 `opencode_subagent`。

## 2. 会话与消息

| 工具 | 用途 | 关键参数 | 类型 | 远端 API |
|---|---|---|---|---|
| `opencode_sessions` | 列出远端会话（server、工作区、标题、最后更新、会话 id），可按目录/标题过滤 | `server`、`directory`、`query`、`limit`（默认 50，上限 200） | 只读 | `GET /global/health` + `GET /project` + `GET /session` |
| `opencode_messages` | 读取某会话的最近消息（text / tool / file part 展平） | `server`、`session`（必填）、`limit`（默认 20，上限 200） | 只读 | `GET /session/{id}/message` |
| `opencode_session_info` | 读取会话元数据、todo 列表与改动文件 diff，用于判断会话做过什么 | `server`、`session`（必填） | 只读 | `GET /session/{id}` + `/todo` + `/diff` |
| `opencode_share` | 分享会话（生成公开链接）或取消分享 | `server`、`session`（必填）、`action`（`share` 默认 / `unshare`） | 可变（仅改分享状态） | `POST` / `DELETE /session/{id}/share` |
| `opencode_search` | 按标题搜索会话（v2 API，失败回退 v1 列表过滤） | `server`、`query`（必填）、`directory`、`limit`（默认 20，上限 100） | 只读 | `GET /api/session?search=` → 回退 `GET /session?search=` |

## 3. 会话管理

| 工具 | 用途 | 关键参数 | 类型 | 远端 API |
|---|---|---|---|---|
| `opencode_fork` | 把会话分叉成一个新的分支会话，返回新会话 id | `server`、`session`（必填）、`message`（可选分叉点消息 id） | 可变（仅新建会话） | `POST /session/{id}/fork` |
| `opencode_children` | 列出某会话派生的子会话（例如远端 subagent 创建的） | `server`、`session`（必填） | 只读 | `GET /session/{id}/children` |
| `opencode_summarize` | 压缩/总结会话历史（更新会话 summary） | `session`、`model`（必填，`provider/model` 来自 `opencode_models`）、`server` | 可变 | `POST /session/{id}/summarize` |
| `opencode_init` | 运行远端 `/init` 流程（写/更新 AGENTS.md） | `session`、`model`（必填）、`confirm=true`（必填）、`server` | 可变（写文件） | `POST /session/{id}/init` |

## 4. 目录与工具发现

| 工具 | 用途 | 关键参数 | 类型 | 远端 API |
|---|---|---|---|---|
| `opencode_agents` | 列出 server 提供的 agent（primary/subagent、native/custom），委派前用来选 agent 名 | `server` | 只读 | `GET /agent` |
| `opencode_models` | 列出 LLM provider 与 model id（凭据字段已剔除），用来选 `provider/model` | `server` | 只读 | `GET /config/providers` |
| `opencode_commands` | 列出自定义命令（名称、描述、agent/model） | `server` | 只读 | `GET /command` |
| `opencode_skills` | 列出远端可见的 Agent Skills（名称、描述、位置，内容省略） | `server` | 只读 | `GET /skill` |
| `opencode_tools` | 列出远端可用工具 id（内置 + MCP/自定义） | `server` | 只读 | `GET /experimental/tool/ids` |
| `opencode_references` | 列出项目 references（v2 API） | `server` | 只读 | `GET /api/reference` |
| `opencode_command` | 在已有会话内执行一个 OpenCode 命令（如 `init`）并返回最终文本 | `server`、`session`（必填）、`command`（必填，不带前导 `/`）、`arguments`、`directory` | 可变 | `POST /session/{id}/command` |
| `opencode_mcp` | 查看 MCP 服务状态（connected/needs_auth/disabled）；只读，不提供 connect/disconnect/auth | `server` | 只读 | `GET /mcp` |

## 5. 工作区与 git

| 工具 | 用途 | 关键参数 | 类型 | 远端 API |
|---|---|---|---|---|
| `opencode_shell` | 在已有会话内跑一条 shell 命令（确定性执行，不跑完整 agent），用于验收/构建 | `server`、`session`（必填）、`command`（必填）、`directory` | 可变（命令可能改动工作区） | `POST /session/{id}/shell` |
| `opencode_read_file` | 读取远端工作区中的一个文本文件（路径相对 `directory`） | `server`、`directory`、`path`（必填） | 只读 | `GET /file/content` |
| `opencode_find` | 搜索远端工作区：`kind=file`（默认）按路径/glob，`kind=text` 按文件内容 | `server`、`directory`、`query`（必填）、`kind`、`limit`（仅 file 搜索生效，默认 50，上限 200） | 只读 | `GET /find/file`（file）或 `GET /find`（text） |
| `opencode_git_status` | 读取工作树状态（改动文件 + 增删行数），用于核对远端 agent 改了什么 | `server`、`directory` | 只读 | `GET /vcs/status` |
| `opencode_git_diff` | 读取改动文件摘要；`mode=branch` 看分支对比，`patch=true` 附带每个文件的 patch（截断到约 20k 字符） | `server`、`directory`、`mode`（`git` 默认 / `branch`）、`patch` | 只读 | `GET /vcs/diff` |

## 典型流程

1. **发现**：`opencode_sessions` 找到目标会话；`opencode_agents` / `opencode_models` 选定
   agent 与模型。
2. **委派**：`opencode_subagent` 带 `task`（可加 `agent`/`model`/`schema`/`files`）执行，记下返回
   的 `session` id。
3. **观察**：任务运行期间用 `opencode_progress` 看当前工具与 tail；需要停止时从另一个会话调用
   `opencode_abort`。
4. **验收**：`opencode_git_status` / `opencode_git_diff` 看改动，`opencode_read_file` 读关键文件，
   `opencode_shell` 跑构建/测试。
5. **续聊**：`opencode_prompt` 向同一会话继续发消息（默认异步，`wait=true` 等本轮），回复用
   `opencode_messages` 读取；也可以用 `opencode_fork` 从某个分叉点另开分支。

## 注意

- `opencode_subagent` 的 `schema` 是 **prompt 约束**（不发送 OpenCode 的 `format`），结果在本地
  校验 required 字段；原因见 README 的 upstream bug 说明。
- `files` 是 JSON 数组，元素为 `{filename, mime, content|base64}`，最多 10 个、单文件约 5 MB，
  以 data URL file part 发送；`text/*` 内容还会内联为 text part。
- `opencode_summarize` / `opencode_init` 的 `model` 必须来自 `opencode_models`；`opencode_init`
  不传 `confirm=true` 会直接拒绝。
- 结构化输出、权限卡、多 server 聚合等行为限制见仓库根目录 README 的 Notes 与
  [COMPATIBILITY.md](../COMPATIBILITY.md)。
