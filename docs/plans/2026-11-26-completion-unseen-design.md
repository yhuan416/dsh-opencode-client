# 设计：完成未查看分区（复用 OpenCode 的 `viewed`）

> 状态：已批准实施 · 分支 `feat/opencode-v2-support` · 2026-11-26
> 关联：[TOOLS.zh.md](../TOOLS.zh.md)、[ARCHITECTURE.zh.md](../ARCHITECTURE.zh.md)、
> [opencode-v2-deeper-integration.zh.md](../opencode-v2-deeper-integration.zh.md)

## 1. 目标与边界

跑完一轮的会话不该立刻沉进「空闲」——那是一个需要人去看一眼的东西。本切片做三件事：

1. 看板新增「刚完成 · 未查看」分区，把**已跑完但还没被查看**的会话挂在那里，直到有人打开它；
2. 完成提示（toast）与卡片补上「这一轮」的信息：用时、in/out token、成本、成败；
3. 左栏图标徽标 = 待处理 + 未查看。

**不做**：未读的持久化（状态本来就在 OpenCode 侧）、跨 dsh 实例同步、卡片里展示输出全文
（只留扩展到「最后一段输出」的现成来源，见 §4）。

**判定标准**：在 dsh 里跑完一轮，不点任何东西 → 左栏数字 +1、卡片停在「刚完成 · 未查看」并带
用时/用量；点开卡片 → 5s 内回到空闲；去 OpenCode 自己的 Web UI 里看过它 → dsh 这边刷新后也
自动消失。

## 2. 准则：先找现成接口，别自己搓

用户对本插件的长期要求。这次逐项核对的结果：

| 需求 | 现成来源（已实测） | 自造？ |
|---|---|---|
| 未读判定 | session 的 `time.idle` 与 `time.viewed`（v2 服务端字段） | 否 |
| 标记已读 | `POST /session/{id}/view`，body `{idle: <number>}` | 否 |
| 本轮用时 | session 的 `time.busy` → `time.idle` | 否 |
| 成败 | session 的 `outcome`（`summarizeSession` 已归一化） | 否 |
| 本轮 tokens/cost/finish | `step.ended` 事件累加；缺失时回退会话累计 | 否（仅累加） |
| 输出首行（后续） | 消息对象的 `finish`/`tokens`/`cost`/`time.completed` | 现成，本切片不用 |
| 左栏徽标 | **无官方字段**：`sidebar.panellist` 只给 `{size, active}` + `{id, order, label}` | 自己画（唯一选择） |
| toast 座位 | `shell.overlay`（文档明示是 badge / toast stack / status pill 的座位） | 复用已有注册 |

实测记录（OpenCode 2.3.0，server-b）：

```
session.time = {created, updated, busy, idle, viewed}       // 两个样本 idle === viewed（已读）
POST /api/session/<id>/view  body {}            -> 400 Missing key at ["idle"]
POST /api/session/<id>/view  body {idle:"x"}    -> 400 Expected number at ["idle"]
POST /api/session/<id>/view  body {idle:1795…}  -> 404 SessionNotFoundError（假 id）
POST /api/session/<id>/nope                     -> 404（无此路由，对照组）
```

即：已读 = 把 `viewed` 推到该会话的 `idle` 时刻，**状态存在 OpenCode 里**，所以 dsh 重启不丢，
两边 UI 永远一致。

## 3. 数据模型

`summarizeSession` 增 `busyAt` / `idleAt` / `viewedAt`（来自 `time.*`，v1 没有则为 `undefined`）。
observation 条目增：

```js
{
  busyAt, idleAt, viewedAt,          // 来自会话快照
  outcome,                            // 'succeeded' | 'failed' | ...（会话自带）
  run: {                              // 仅正在跑或刚跑完时有意义
    startedAt,                        // run.started/快照 bustAt
    steps, tokens: {input,output,reasoning,cacheRead,cacheWrite}, cost,
    finish, endedAt,
  } | null,
  lastRun: { …同上, outcome } | null, // run.finished 时冻结
}
```

派生（不改 `statusOf` 的五档优先级）：

```js
unread = status === 'idle' && sawFinish && idleAt !== undefined && !(viewedAt >= idleAt)
```

**修正（实施中实测推翻初稿）**：初稿写的是“未读 = `idleAt > viewedAt`”，要求两个字段都在。
真机量下来 server-b 180 个会话里有 10 个、server-a 339 个里有 1 个**根本没有 `time.viewed`**——就是那些
从没在 OpenCode UI 里打开过、由 dsh 委派创建的会话；同时两台机器上 `idle > viewed` 的会话是
**0 个**。照初稿的规则，“刚跑完且确实没人看过”恰好被判成已读，功能等于永远不触发。

于是拆成两半：**候选**由我们亲眼看到的 running→idle 边沿产生（`sawFinish`，本地、天然只覆盖
“刚完成”），**清除**看 OpenCode 的 `viewed`（`viewed >= idle` 即远端已读）或 dsh 自己的 `/seen`。
这样既不会把几百条历史会话刷成未读，也不会漏掉没被人打开过的完成。

`board()` 增 `unseen`：顶层 + `unread` 的行，按 `idleAt` 倒序，上限 20，**从 `idle` 与
`idleCount` 中排除**，避免重复计数；行内带 `idleAt`、`runMs`（`idleAt - busyAt`）、`lastRun`、
`outcome`、`unread`。

## 4. 已读上报（三个调用点）

| 调用点 | 传的 `idle` | 说明 |
|---|---|---|
| 看板点开任一卡片（含未查看卡） | 该行 `idleAt` | 前端**乐观更新**：本地先移出未查看区，不等下一轮刷新 |
| 设置页「打开」/ 右栏标签页打开同一会话 | 该行 `idleAt`；拿不到则不传 | 与卡片同一路由 |
| dsh 委派拿到结果（`opencode_subagent`、`opencode_prompt wait=true`） | `Date.now()` | 跑完时刻必然 ≥ `idle`，语义安全；避免每次委派留一堆未读 |

新路由：`POST /api/opencode-client/seen {server, session, idle?}`。

- v2：调远端 `POST /session/{id}/view`，body `{idle}`；取不到 `idle` 时返回 `ok:false` 且**不调用**
  （绝不用 `Date.now()` 猜，会把还在跑的 run 提前标已读）。
- v1：返回 `{ok: true, supported: false}`，不做任何远端调用。

## 5. 界面

- 新分区「刚完成 · 未查看」，位置：「需要你」之后、「运行中」之前。
- 卡片副标题：`完成于 X 前 · 用时 3m12s · in 12k / out 3.4k · $0.12`；`lastRun` 缺失时用会话累计并标注「累计」。
- 完成 toast：`完成 · <标题>` / body `server · 用时 · in/out · cost`。
- 徽标 = `needsMe.length + unseen.length`；面板头部：`N 待处理 · M 未查看 · K 运行中 · …`。
- **watcher 必须把 `unseen` 纳入轮询行集合**：现在只收 `needsMe + running + unknown`
  （[client.js:157](../../lib/client.js)），完成的行会从集合里消失，toast 就永远不触发。

## 6. 边界与失败处理

- running 优先：正在跑就不进未查看（即使 `idle > viewed`）。pending 的进「需要你」。
- 子会话仍折进父行；父行未读才显示。
- 会话删除 → `observation.forget()` 自然清。
- 远端 `/view` 失败（404/网络）→ 只记日志，不影响打开；下一轮刷新未读会回来。
- v1：没有 `idle`/`viewed` 这对字段 → `unread` 恒 false，分区整体不出现，行为回到现状。
- dsh 重启后 `sawFinish` 清零：重启前完成的会话不再提醒（远端 `viewed` 仍在，只是“刚完成”这件事
  我们没亲眼看到）。新的 run 一结束就会重新武装。
  **这条代价是刻意接受的（2026-11-26 用户决定）**：评估过两个替代方案并否决——
  ① 启动时按 `idleAt` 时间窗补种一批（多一次启动扫描、两种武装途径，逻辑更绕）；
  ② 改成“远端未读 + 24h 时间窗”纯派生（能跨重启，但超过窗口未看的提醒会自己消失）。
  实测依据：两台机 519 个会话里远端未读候选仅 10 条、全部 ≈6 天前且都是早期委派建的无 `viewed`
  会话；2/6/12/24/48h 窗口唤醒数均为 0，7 天窗口为 9。即窄窗口当下噪声为零，两种替代方案都不划算。
  以后若再提，请先重测这张表。
- `step.ended` 缺失（dsh 重启后、SSE 断线）→ 用量回退会话累计并标注「累计」，不假装是本轮。

## 7. 测试

- `test/observation.test.js`：`unread` 派生；`unseen` 与 `idle` 互斥；running 时被排除；
  `viewed` 推到 `idle` 后回到 idle 区；`step.ended` 在 run 内累加、`run.finished` 冻结成 `lastRun`。
- `test/usage.test.js` 或新 `test/seen.test.js`：`POST /seen` 对假 v2 server 断言发出
  `POST /api/session/{id}/view` 且 body `{idle}` 等于该行 `idleAt`；无 `idle` 时不发请求；v1 返回
  `supported:false`。
- `summarizeSession`：v2 payload 解析出 `busyAt/idleAt/viewedAt`；v1 payload 无这些字段。
- `scripts/check.mjs`：静态断言「刚完成」分区与 toast 用量文本存在（防重构删掉）。

## 8. 实施计划

1. `lib/sessions.js`：`summarizeSession` 补三个时间戳（顺带把 token 归一化抽成小函数复用）；
   新增 `markSessionViewed(server, sessionId, idle)`（v1 → `{supported:false}`）。
2. `lib/observation.js`：条目新字段；`observeIdentity` 吸收时间戳/outcome；`observeEvent` 处理
   `step.ended` 累加与 `run.finished` 冻结；`view()`/`board()` 暴露 `unread`/`unseen`/`lastRun`。
3. `lib/routes.js`：`POST /api/opencode-client/seen`。
4. `lib/delegate.js`：成功拿到结果后调 `markSessionViewed(server, id, Date.now())`（fire-and-forget）。
5. `lib/client.js`：分区、徽标、头部、toast body、watcher 行集合、点击乐观更新 + 上报。
6. 测试、`scripts/check.mjs` 断言、CHANGELOG 0.7.1、TOOLS/ARCHITECTURE 文档。
7. `npm run check`（含 90+ 项）后提交为一个 `feat(board)` commit。

> 注：`writing-plans` skill 在本机未安装，故实施计划直接落在本文档 §8。
## 9. 实施记录（2026-11-26）

（含 §3 那处修正：未读候选改为本地 `sawFinish` + 远端 `viewed` 清除。）

按 §8 落地，实测到的两处与设计不完全一致：

- **顺带修掉一个既有 bug**：`lib/routes.js` 里 16 个处理器调用了一个从未定义的 `findServer`
  （`/fork`、`/abort`、`/prompt`、`/shell`、`/git/*` … 全部 `ReferenceError`）。`lib/board.js`
  早有一个同名实现，但既没被调用也没被导出——接线漏了一根。现改为在 `createRoutes` 内定义一次
  并删除孤儿副本，回归测试在 `test/board.test.js`（修复前会抛 ReferenceError）。
- **`/board` 与 `opencode_board` 工具都要暴露 `unseen`**：设计只写了看板 UI，实际上下游还有两处
  消费 `observation.board()` 的投影（宿主路由 `/board`、给模型看的 `opencode_board`）。只改 UI
  会让刚完成的会话从模型视野里消失，所以两边都加了「finished, not looked at」一块。

新增/改动测试：`test/seen.test.js`（4 项，含“缺 idle 时拒绝且不发请求”）、
`test/observation.test.js` 加 3 项（未读派生、running 排除、step 累加与冻结）、
`test/board.test.js` 加 1 项（findServer 回归）、`scripts/check.mjs` 加 4 条客户端静态断言 +
未读派生 smoke。全量 `npm run check` 98 项通过。
