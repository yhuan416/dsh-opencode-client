# dsh-opencode-client

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 **OpenCode server**
接入 dsh，充当 OpenCode 的客户端。它连接一台或多台远端 `opencode serve`，向 dsh 暴露它们的
projects、sessions 和 messages，把任务委派进去，并把 OpenCode 注册为 dsh 的原生子代理后端。

> OpenCode 的官方架构：`opencode serve` 暴露 OpenAPI HTTP 服务，"an opencode client can use"；
> TUI / Web / SDK 都是它的客户端。本插件是另一个客户端，宿主在 dsh 里。

## 功能

- **服务配置**：`servers: [{ id, label?, url, password?, directory?, agent?, model? }]`，支持多台
- **发现**：`GET /api/opencode-client/list`（健康状态、projects、按目录分组的 sessions）
- **会话列表 / 消息**：工具 `opencode_sessions`、`opencode_messages`（含 tool / file part）
- **会话信息 / 分享**：`opencode_session_info`（title/summary/todo/diff）、`opencode_share`
- **目录类**：`opencode_models`（provider/model，已脱敏）、`opencode_commands`、`opencode_skills`、`opencode_tools`、`opencode_references`
- **命令执行**：`opencode_command` 在会话内执行远端命令（如 `init`）
- **工作区操作**：`opencode_shell`、`opencode_git_status`、`opencode_git_diff`、`opencode_read_file`、`opencode_find`
- **会话管理**：`opencode_fork`、`opencode_children`、`opencode_summarize`（mutating）、`opencode_init`（写 AGENTS.md，需 confirm=true）
- **实时进度**：`opencode_progress`（当前工具/步骤、耗时、输出 tail），由 SSE 工具事件驱动；委派完成改为 SSE idle 事件触发
- **搜索/诊断**：`opencode_search`（v2 会话搜索）、`opencode_mcp`（MCP 服务状态）
- **附件**：`opencode_delegate` 支持 `files` JSON 数组（text/base64 → data URL file part）
- **中止**：`opencode_abort` 停止远端运行中的会话；等待中的委派会返回 abort 错误而不是继续挂起。
  注意：同一轮次内 dsh 会串行执行工具调用，因此 abort 需从**另一个会话/agent** 发起，无法抢占同轮次里阻塞中的 `opencode_delegate`。
- **委派**：`opencode_delegate`（新建或 `session=` 续用；可选 `agent`、`model`、prompt 级 `schema`）
- **原生子代理**：provider `opencode-<serverId>`，配合 `@deepseek-ai/dsh-tool-subagent` 使用
- **权限 / 提问**：远端权限请求转 dsh 审批卡；提问转 dsh 用户提问 UI（无 agent 时自动拒绝/放行）
- **实时**：每台 server 常驻 SSE（`/global/event`），带重连；`/events`、`/status`、`live`/`running`
- **异步提示**：`prompt_async` + 消息轮询等待，失败回退阻塞式 prompt
- **插件页**：「OpenCode Client」分区：服务器/工作区/会话、查看消息、新建会话、打开 OpenCode UI

## 安装

```sh
# 方式一：脚本写入 profile（deps + bundles + patch）
bash scripts/install-into-profile.sh http://192.168.4.50:4096 n100

# 方式二：dsh 插件管理
dsh plugin --profile web add /path/to/dsh-opencode-client
```

手动方式（profile）：

```json
{
  "dependencies": { "dsh-opencode-client": "file:/path/to/dsh-opencode-client" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-opencode-client"] } }
}
```

## 配置

```yaml
- id: opencode-client
  name: dsh-opencode-client
  config:
    servers:
      - id: n100
        label: n100 opencode
        url: http://192.168.4.50:4096
        # password: xxx          # OPENCODE_SERVER_PASSWORD（Basic，用户名 opencode）
        # directory: /home/yhuan/workspace   # 调用方未给目录时的默认远端目录
        # agent: plan            # 委派默认 agent
        # model: deepseek/deepseek-chat      # 默认模型 "provider/model"
      - id: m65
        label: 4.65 opencode
        url: http://192.168.4.65:4096
    permission: ask              # ask（默认，审批卡）| allow | reject
    question: reject             # reject（默认）| ignore
    pathMap:                     # 本地/远端路径布局不同时
      - { from: /home/yhuan, to: /home/yhuan }
```

### 注册为原生 subagent

```yaml
- insert:
    - id: tool-opencode-n100
      name: "@deepseek-ai/dsh-tool-subagent"
      config:
        provider: opencode-n100   # "opencode-" + server id
        maxDepth: provider-managed
        toolName: subagent_n100
```

## Subagent 接缝

原生 `subagent_<server>` 工具接入 dsh 的 `ctx.subagents` provider 接缝。
契约、能力映射与已应用的优化（父 agent 归属、事件驱动等待、幂等 dispose）见
[docs/subagent-seam.md](docs/subagent-seam.md)。`opencode_delegate` 与原生 provider 复用同一条
session 运行生命周期（`lib/session-run.js`）：同一套建会话、交互跟踪、异步 prompt + SSE idle
等待与中止逻辑。原生 subagent 会话标题为 `dsh subagent: <label>`，插件页可直接识别（页面现在也
显示会话 id 和运行中服务器的当前工具）。

## 兼容性与版本

见 [COMPATIBILITY.md](COMPATIBILITY.md)。插件采用独立语义化版本，已验证 dsh `0.2.1-rc.2` 与
OpenCode `1.18.10/1.18.31/1.18.33`；暂不发布 npm（从 git 或本地路径安装）。

## 说明与限制

- 远端 OpenCode 需从 dsh 宿主可达；`opencode serve` 默认绑 `127.0.0.1`，网络访问需绑
  `0.0.0.0` 或走 SSH 隧道；建议设置 `OPENCODE_SERVER_PASSWORD`。
- 会话续用通过 OpenCode HTTP API；原生外部子代理仍是一次性执行（与 Codex/Claude Code 后端一致）。
- **结构化输出是 prompt 约束而非 `format=` 强约束**：opencode 1.18.x 使用
  `format: {type:"json_schema"}` 后会把 `retryCount` 持久化，导致 `GET /session/{id}/message`
  返回 400，会话不可读。插件因此不发送 `format`，而是追加"只返回 JSON"指令并本地校验（`schema`）。
- 权限卡需要**工具发起的委派**（有 live agent）；HTTP 直接调用回落 allow/reject。
- 多 server 由客户端聚合（OpenCode 服务端没有联邦 API）。
- v1 是基线；v2（`/api/*`）可探测后增量使用（见 TODO.md）。