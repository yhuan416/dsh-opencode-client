# OpenCode 观测台 —— 性能与数据流优化（2026-11-28）

> 需求：观测台（看板页 + 洞察区）冷加载「卡卡的」、控件刷新节奏不一致、30 天活动表有延迟感。
> 用户方向：数据**渐进填充**（骨架先出、各卡片到位就填），而不是整页统一刷。
> 本文是设计依据；实施清单同步登记在 [TODO.md](../../TODO.md) §11。

## 1. 现状实测（本机 dsh-web，2 台 OpenCode 2.4.2）

| 端点 | 缓存暖 | 冷 | 说明 |
|---|---|---|---|
| `GET /board?idleLimit=60` | 4–80ms | — | 2 server：list(500)+status+jobs+pending |
| `GET /insights?days=7` | 5ms | **~0.6s** | 每 server 一次 `stats(detail)` 历史扫描 |
| `GET /insights/activity?days=30` | 1–15ms | **~60ms**（模拟） | 30 天 × 2 server 的 per-day `stats`，实测 60 次共 60ms |
| `GET /insights/skills?days=7` | 3ms | **~3.5s** | 遍历消息（唯一能拿到 skill 名的地方） |
| `GET /usage?from=now-7d` | 0.4–0.6s | ~0.6s | 另一次 `stats(summary)` 扫描；`from=0` 全历史曾达 20s |
| `GET /about` | 命中内存 | 可能 >1s | 冷启动查 GitHub（可超时） |
| `GET /upgrade` | 命中缓存 | 网络 | OpenCode 官方更新服务 |

结论：**后端单点不慢**；30 天热力图本身只有几十毫秒。真正拖慢首屏的是客户端请求编排与渲染方式。

## 2. 根因（按影响排序）

1. **洞察区被整体 gate**：`insights === null ? null : insightSection(...)`。`/insights` 回来之前
   整块不渲染、没有骨架；回来时一次性挂载 7 张卡 + 热力图，skills（3.5s）随后才填充 →
   布局二次跳动，观感「冷加载节奏不一致」。
2. **冷启动请求风暴**：`BoardPage` 挂载即同时发 `/board`、`/about`、`/upgrade`、`/usage`、
   `/insights`、`/insights/activity`、`/insights/skills` 7+ 个请求；常驻 toast watcher 另有
   `/board` 轮询 → 首屏互相抢带宽/远端扫描并发，且重复 `refresh=1`。
3. **多套独立定时器 + 各自 visibilitychange**：board 5s、toast 8s、insights 120s、
   activity/skills 600s、settings 15s/60s/240s；切回页面时每个 effect 各触发一次 = 「统一刷」。
4. **无请求去重/取消**：board 页与 toast 都打 `/board`；切 7/30 天或 server 时旧请求不取消，
   回来覆盖新状态；usage 与 insights 各扫一次同样的 7 天 stats。
5. **全页重渲染**：board 每 5s 更新 → 洞察区跟着重算；洞察数据到达 → 整个 BoardPage 重渲染。
   board 一次渲染 60 行 + 分组，无 memo 边界。
6. **服务端无 SWR/预热**：冷启动后第一次访问必须等历史扫描；历史天（已过去的日子）的 stats
   其实不会变，却被 5 分钟 bucket 缓存反复重算；insights/usage 无 in-flight 合并。

## 3. 目标与非目标

**目标（可量化，真机验收）**

- 首屏：骨架 **≤100ms** 可见；看板可交互 **暖 <300ms / 冷 <1s**；7 天卡片 **<800ms**；
  30 天热力图 **<1s**；skills **不阻塞**（后台填充，≤4s）
- 切 7/30 天或 server：只刷新受影响卡片，保留旧数据 + 局部 loading，无整页闪烁/清空
- 切回标签页：一次「到期补刷」，不再并发 7 个请求
- 服务端：同一 `(server, 窗口)` 的 stats 扫描 5s 内最多一次；历史天 stats 不再重复扫描
- 无布局跳动（CLS≈0）：骨架高度与最终卡片一致

**非目标**

- 不改信息架构与视觉设计（只加骨架/局部 loading/更新时间）
- 不做磁盘持久化缓存（本次内存预热；跨重启缓存列为后续可选项）
- 不改用 SSE 驱动 board（列为 v1.2 候选，见 §7）
- 不引入新依赖

## 4. 设计

### 4.1 客户端单一调度器

在 `lib/client.js` 内新增单例 `scheduler`（不新增 npm 依赖）：

- 统一时钟（1s tick），任务注册：`{ key, intervalMs, priority, visibleOnly, run }`；同 `key`
  的 in-flight 请求共享（去重），完成后按 `interval` 排下一次
- 并发上限：普通 3、重任务（skills、全历史 usage）1；优先级 P0 board > P1 insights/activity
  > P2 usage/about/upgrade > P3 skills
- `visibilitychange`：记录 hidden 时刻，恢复时只对「已到期」任务各补刷一次，追加 300ms
  抖动 + 串行；不再由每个 effect 各自监听
- 首屏：`tick()` 立即排 P0；P1 同时排；P2 延迟到首个 idle（`requestIdleCallback`，300–500ms）；
  P3 在 insights 首次到达后再排
- 替换现有 6+ 个 `setInterval`（board 页、toast、settings 页也接入同一调度器，见 4.4）

### 4.2 渐进填充（UI）

- `insightSection` 不再 gate：布局与骨架**立即渲染**，每个数据源独立 slice：
  `insightsCore`（7/30 天数字/模型/工具/项目）| `activity`（30 天热力）| `skills`
- 每张卡 `min-height` 与最终内容一致；数据到达后直接替换骨架，不做淡入动画（避免额外重排）
- 局部刷新指示：卡片右上角小 spinner/「更新于 hh:mm」，数据不清空
- 筛选（7/30、server）变化：保留旧数据 + loading 标记；`AbortController` 取消在途请求；
  仅刷新受影响卡片（activity 只随 server；insights/skills 随 days+server）
- 占位符审计（全页）：见 4.2.1

### 4.2.1 占位符审计（所有异步块首帧占好尺寸）

原则：**异步块在数据到达前就按最终布局渲染**（loading / empty / error 三态同高），
数据只替换内容、不改变盒子尺寸。为此收敛出两个原语：

- `asyncSlot({ state, lines, lineHeight, loadingText, emptyText, errorText, children })`：
  行列表 / 文本类块统一走它，三态占用同样的「行数 × 行高」；失败也不再静默塌缩。
- `boardSkeleton(insightBlock)`：看板首帧。分组结构来自 `localStorage` 里缓存的**形状**
  （`{sections, servers, idle}`，只有计数没有数据），因此首帧高度与 `/board` 到达后一致；
  首次访问无缓存时退回默认形状。

已覆盖：看板首帧（头部/机器筛选/洞察骨架/远端条/五类分组/空闲）、远端条每张卡片、
设置页远端列表 / 今日用量 / 近 7 天归因、头部插件版本 chip。

验收：把 `/board`、`/usage`、`/about` 人为延迟 2s，首帧与加载完成后同一元素的
`getBoundingClientRect().height` 一致（专项断言见 `scripts/check.mjs` 占位符审计段）。

### 4.3 渲染拆分（memo 边界）

拆组件并用 `React.memo` + 稳定 props（`useMemo` 构造，避免每 render 新对象）：

| 组件 | 依赖 | 说明 |
|---|---|---|
| `BoardStatusBar` | board 计数 | 5s 更新只影响它 + `BoardList` |
| `BoardList` | board 分组/筛选 | 60 行 + 分组，memo 后不受洞察数据影响 |
| `InsightCards` | insightsCore | 7 天数字/模型/MCP/项目 |
| `ActivityHeatmap` | activity/activityMetric | 30 天热力图 |
| `SkillsPanel` | skills/skillsLoading | 最慢数据，独立填充 |

board 5s tick → 只重渲染 board 两组件；insights/activity/skills 各自到达 → 只重渲染对应组件。

### 4.4 Board 数据流（用户特别指出的「数据流没优化」）

新增客户端 **board store**（仿现有 about store，单例）：

- `{ value, at, inflight, listeners, timer }`；`BoardPage`、常驻 toast watcher、设置页共享同一份
- 轮询分级：页面可见且在看板 → 5s `refresh=1`；仅 toast（页面不可见）→ 15s `refresh=1`；
  中间 tick 用 `refresh=0` 读服务端缓存，减少远程 collect
- 设置页只读同一 store（15s `refresh=0`），不再自己起一套 15s 轮询
- 后续（v1.2 候选）：SSE 事件驱动 + 兜底轮询，彻底去掉固定 5s 全量刷新

### 4.5 服务端 SWR + 预热 + single-flight

新增 `lib/swr.js`（内存缓存，无依赖）：

```js
// serve(key, ttlMs, loader) → { value, at, stale } | 等待首次加载
// 命中未过期：直接返回；
// 过期但有旧值：立即返回旧值 + stale=true，并后台刷新（去重）；
// 无值：等待 loader，记录 at。
```

应用：

| 数据 | TTL | 说明 |
|---|---|---|
| `/insights`（key: days+server） | 60s | 冷扫描 ~0.6s，SWR 后首屏直接命中 |
| `/insights/activity`（key: days+server） | 今天 60s / 历史天进程内永久 | 历史天 stats 不会变；今天仍会涨 |
| `/insights/skills`（key: days+server） | 600s | 已有缓存，补 SWR + in-flight |
| `/usage`（key: from bucket+group+server） | 60s | 全历史 `from=0` 不进 SWR（成本太高，单独短缓存即可） |

- **single-flight**：`collectStats` 增加 `server.statsInflight`（key→promise），多消费者共享
- **启动预热**：插件 start + 首个 server probe 成功后，延迟 5–10s 在 idle 窗口串行预热
  `board` → `insights(7d, all)` → `activity(30d, all)`；失败静默、退避重试一次；不阻塞首屏
- 响应带 `at`/`stale`；客户端据此显示「更新于 …」，不因刷新阻塞交互

### 4.6 观测与验收

- 客户端 `performance.mark`：`oc:first-paint`、`oc:board-ready`、`oc:insights-core`、
  `oc:activity`、`oc:skills`、`oc:idle`（可在 DevTools Performance 里对照）
- 服务端 debug：`/api/opencode-client/insights?timing=1` 返回 `{ ms, cache: 'hit|stale|miss' }`
- 回归：`npm run check`（node 单测：swr、single-flight、调度器纯函数、board store）；
  `scripts/e2e-live.mjs` 补「预热后冷加载命中缓存」断言；真机手动清单见 §6

## 5. 分阶段实施（同步 TODO.md §11）

**Phase 1 — 客户端骨架与调度（P0，最高性价比）**
1. `scheduler` 单例 + 并发/去重/优先级 + 统一 visibilitychange
2. 洞察区去 gate，卡片骨架 + 独立 loading/局部刷新/`更新于`
3. 首屏请求分层：P0/P1 立即，P2 idle 延迟，P3 延后
4. toast watcher 与 BoardPage 的 `/board` 轮询合并（先共享 in-flight，再做 4.4 全量 store）

**Phase 2 — 渲染拆分（P0）**
5. 拆 5 个组件 + `React.memo`/`useMemo` 稳定 props
6. 骨架高度对齐，CLS≈0；筛选切换保留旧数据 + AbortController

**Phase 3 — 服务端 SWR/预热/单飞（P1）**
7. `lib/swr.js` + 单元测试；insights/activity/skills/usage 接入
8. 历史天 activity 永久缓存（按天 key）；今天短 TTL
9. `collectStats` single-flight；`?timing=1` 调试字段
10. 启动预热（idle、串行、失败静默）

**Phase 4 — Board 数据流合并（P1）**
11. 客户端 board store；BoardPage / toast / settings 三处共享
12. 轮询分级（5s 可见全量 / 15s 后台 / 中间 tick refresh=0）

**Phase 5 — 度量与回归（贯穿）**
13. performance.mark + 真机验收数值（§3）
14. `npm run check` 补 swr/scheduler/store 单测；e2e 预热断言

## 6. 真机验收清单

- [ ] 清浏览器缓存后首次进入：骨架立刻出现，无整块空白期
- [ ] 看板 <300ms 可交互（暖），洞察 7 天卡 <800ms，30 天热力 <1s
- [ ] skills 最后填充，且不引起布局跳动（记录 CLS）
- [ ] 切 7/30 天：旧数据保留 + 局部 loading，不闪白、不重排
- [ ] 切 server：只刷新洞察相关卡片，看板不闪
- [ ] 切走再切回：控制台网络面板只有 1 轮到期补刷（不是 7 个并发）
- [ ] DevTools Performance：首屏无 >50ms 长任务（除 bundle parse）
- [ ] 服务端日志：同一窗口 stats 5s 内只扫描一次；重启后 10s 内预热完成

## 7. 风险与后续

- **SWR 陈旧**：`stale` 标记 + `更新于 hh:mm` + 手动「重新检查」兜底；TTL 默认 60s
- **预热增加远端负载**：仅 idle、串行、2 台 server、失败退避；`from=0` 全历史不预热
- **memo 失效**：稳定 props 用 `useMemo`；状态按 slice 存放，避免一个对象承载所有数据
- **React 版本限制**：客户端 bundle 只用 `require("react")` + hooks，`memo`/`useMemo` 均可
- **后续（v1.2 候选）**：board 改 SSE 驱动 + 兜底轮询；跨重启磁盘缓存（activity 历史天可持久化）