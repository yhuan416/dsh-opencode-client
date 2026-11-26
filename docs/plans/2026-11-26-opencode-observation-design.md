# 设计：OpenCode 会话状态观测层（观测台 v0，仅采集）

> 状态：已批准实施 · 分支 `feat/opencode-v2-support` · 2026-11-26
> 关联：[opencode-v2-migration.zh.md](../opencode-v2-migration.zh.md)、[ARCHITECTURE.zh.md](../ARCHITECTURE.zh.md)

## 1. 目标与边界

本切片**只做采集**：把「哪些会话在跑、哪些会话在等我、哪些挂了」变成一份可查询的事实，
并用最丑的方式展示（纯文本区块 + JSON 端点）。卡片式 UI、就地批准、通知、持久化都不在本切片。

**判定标准**：不打开面板，用 `scripts/probe-observation.mjs` 一条命令就能看到真实状态。

## 2. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 状态存放 | 进程内 `Map`，不持久化 | 一切可由快照重建；两套真相必然漂移 |
| 会话键 | `serverId + '\0' + sessionId` | v2 的 `ses_*` 跨 server 不保证唯一 |
| 子会话 | 默认不进看板，父行带子会话计数 | 一次扇出 20 个子会话会淹没看板 |
| 无 run 的权限请求 | **不再自动答复**，登记为 pending | 替用户做决定是这个插件失去信任的根源 |
| 逃生门 | `permission: auto` 恢复旧行为 | 无人值守场景需要一个开关 |
| 陈旧 | 90s 无事件且 running → `stale`，状态不变 | 翻成 idle 会骗人 |
| 来源优先级 | pending 快照 > SSE 增量 > running 快照 | 待办最不能错 |

## 3. 状态模型

```js
status = waiting-permission | waiting-question | error | running | idle | unknown
```

优先级：`waiting-*` > `error` > `running` > `idle` > `unknown`。

记录：

```js
{
  serverId, sessionId, parentID, title, directory,
  running: true | false | undefined,   // undefined = 未知
  error: boolean,
  pending: { kind: 'permission' | 'form', requestId, detail, at } | null,
  progress: { status, tool, tail },    // 来自 SSE
  lastEventAt, since
}
```

## 4. 数据源

| 源 | 端点 | 频率 | 作用 |
|---|---|---|---|
| 会话表 | `GET /session` | 30s（既有缓存 10s） | 身份、标题、`parentID` |
| 存活快照 | v2 `/session/active`、v1 `/session/status` | 5s（既有缓存） | 播种 running、断线对账 |
| 事件流 | v2 `/api/event`、v1 `/global/event` | 常连 | 进度 + pending 增删 |
| 待办快照 | v1 `GET /permission` + `GET /question`；<br>v2 逐会话 `GET /session/{id}/permission` / `/form` | 请求时（仅 running 集合） | 补“启动前就在等我”的 |

v2 的逐会话待办查询只在 **running 集合**上做，避免 N 倍放大。

## 5. 改动面

| 文件 | 改动 |
|---|---|
| `lib/observation.js` （新） | 登记表 + 派生状态 + board 分组（纯函数，可单测） |
| `lib/sessions.js` | 新增 `collectPending(server, sessionIds)`，v1/v2 归一化 |
| `lib/sse.js` | `handleEvent` 末尾回调 `options.onEvent(server, event)` |
| `lib/interactions.js` | 无 run 时不答复，改 `markPending`；`permission: auto` 保留旧行为 |
| `lib/routes.js` | 新增 `GET /api/opencode-client/board`；`/list` 行补 `status` |
| `lib/index.js` | 装配 observation，注入 route 与 sse |
| `lib/client.js` | 面板顶部纯文本区块（轮询 board） |
| `scripts/probe-observation.mjs` （新） | 独立探针，不依赖 dsh |
| `test/observation.test.js` （新） | 状态机与分组 |

## 6. 验收

1. 探针在 v1 / v2 各一台 server 上输出正确（含正在跑的会话）；
2. TUI 触发权限 → `/board` 出现 `waiting-permission`，且 TUI 仍停着（证明没自动批）；
3. 在 TUI 批掉 → SSE 在线则 3s 内、否则 30s 内消失；
4. 重启 dsh → `/board` 靠快照仍有 running，不是 `unknown`；
5. `npm run check` 通过（离线）。

## 7. 明确不做

卡片样式、徽标、轮询分频、就地答复、transcript、持久化、跨机聚合、本机会话。