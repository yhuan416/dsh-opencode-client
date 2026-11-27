# OpenCode 洞察看板 —— 数据可行性分析（2026-11-27）

> 需求来源：参考 dsh 的「上下文洞察」插件，在插件设置页（方案 A，全宽区块）做一个
> OpenCode 版会话洞察：主要是过去 7 天的会话数、用量等统计。
> 本文只回答「OpenCode 现在能支持什么、口径是什么、代价多大」，不做实现。
>
> 实测环境：OpenCode **2.3.0**，两台 server（e5 192.168.4.65、n100 192.168.4.50），
> 2026-11-27 访问；所有数字来自 `GET /api/*`（只读）。

## 1. 可用数据源

| 端点 | 关键字段 | 窗口性 | 实测代价 |
|---|---|---|---|
| `GET /api/experimental/session/stats?from&to&tools=summary\|detail&project` | `sessions` / `subagents` / `prompts` / `steps` / `tokens{input,output,reasoning,cache{read,write}}` / `cost` / `tools{totals,usage[]}` / `activeDays` / `streak` / `activity[{date,steps}]` / `models[]` | **窗口内**（`from`/`to`；`project` 可再按项目切） | 7 天 0.25–0.72s/台；30 天 0.6–1.2s/台；全量历史 20s+ 会超时 |
| `GET /api/session?limit&archived=true\|false&cursor` | `id` / `projectID` / `model` / `cost` / `tokens` / `time{created,updated,busy,idle,viewed,archived}` / `location.directory` | 列表本身无窗口；按 `time.busy` 自行过滤 | 500 条/页，cursor 翻页 |
| `GET /api/session/{id}` | 同上（单会话） | — | 单条 |
| `GET /api/project` | `id` / `canonical`（worktree） | — | 一次 |
| `GET /api/session/{id}/message` | assistant `time{created,firstToken,streamed,completed}`、tool part `state`、shell 消息 `status` | 按消息时间 | **逐会话翻页，贵** |

补充：`tools=detail` 会返回**每个工具**的 `calls/succeeded/failed/unfinished/durationP50`；
`archived=true` 只返回已归档会话（默认/`false` 只返回未归档）。

## 2. 实测样本（7 天窗口）

| 指标 | e5 | n100 |
|---|---|---|
| 会话 / 子代理 | 61 / 0 | 59 / 1 |
| prompt（轮次）/ steps | 606 / 8634 | 341 / 4409 |
| tokens | in 25.3M · out 2.34M · reasoning 3.16M · cache read 2.20B | in 11.8M · out 1.27M · reasoning 1.73M · cache read 1.07B |
| 缓存命中率（`cache.read/(input+cache.read)`） | **98.86%** | **98.91%** |
| 费用 | $99.69 | $14.08 |
| 工具调用 | 9045（成功 9009 / 失败 36） | — |
| 活跃天数 / streak | 7 / 6 | 6 / 5 |
| 30 天窗口 | 95 会话 / 1439 prompts / $584.15（1.2s） | 121 会话 / 1018 prompts / $74.27（0.6s） |

按工具（e5，7 天，`tools=detail`）：
`shell 5356（P50 92ms）· execute 2562（1227ms）· edit 504（21ms）· read 241 · grep 166 ·
write 128 · skill 53 · question 17 · glob 7 · webfetch 6 · websearch 3 · search 1`。

`activity[]` 是**按日 steps**，只包含有活动的日期（e5 7 天里 11-21 缺项），画图需补 0。

## 3. 面板 → 数据映射

| 面板（参考截图） | 可用的数据 | 口径 / 公式 | 结论 |
|---|---|---|---|
| 全部会话 / 已归档 | `stats.sessions`；`/session?archived=true` | 窗口内活跃会话；归档为全量计数 | ✅ |
| Token 消耗 | `stats.tokens` | 4 类相加，缓存单列 | ✅ |
| 轮次 / 模型调用 | `stats.prompts` / `stats.steps` | 直接取 | ✅ |
| 预估费用 | `stats.cost`；`models[].cost` | 仅「有报价映射」的模型计费 | ✅（需注明覆盖） |
| 缓存命中率 | `stats.tokens.cache.read` | `read/(input+read)` | ✅ 与截图口径一致 |
| 工具调用 / 失败 | `tools.totals`、`tools.usage[]`（detail） | 调用数、成功/失败、P50 | ✅ |
| 近 7 天用量柱状 | `activity[]` | **只有 steps**；无逐日 token/cost | ⚠️ 降级为 steps 柱状 + 7 天合计卡 |
| 模型分布 | `stats.models[]` | token/cost/steps（窗口内） | ✅ |
| 项目分布 | `/session` + `/project`；或 `stats?project=<id>` 逐项目 | 会话数（1 请求）或窗口 token/cost（N 请求） | ⚠️ 口径二选一（见 §5） |
| 技能加载明细 | 只有 `skill` 工具**调用总数** | 按技能名需扫消息 | ❌ v1 不做 |
| 命令执行明细 | `shell`/`execute` **调用数** | 按命令名需扫 shell 消息 | ❌ v1 不做 |
| 活跃时长 | 仅 `time.busy→idle`（**最后一次运行**） | e5 全量相加仅 2.3h，明显低估 | ❌ 或标注「最后一次运行」 |
| Token 构成（系统提示词/工具定义/…） | 无 | OpenCode 不暴露 | ❌ |
| 耗时拆解（模型等待/思考/回复/工具） | 工具 P50 有；整体拆分需逐消息 | assistant `time.firstToken/streamed/completed` 可近似，但需扫消息 | ❌ v1 |

## 4. 关键限制（决定版式）

1. **没有逐日 token/费用**：`activity` 只给 steps。日图只能画 steps；token/cost 只能给窗口合计。
2. **没有 token 构成**：无法复刻截图的「系统提示词/工具定义/注入内容」环图，最多画 in/out/reasoning/cache 四段。
3. **没有耗时拆解**：只有每个工具的 P50，没有「模型等待/思考/回复/工具执行」的总时长分布。
4. **窗口口径 vs 终生值**：会话列表里的 `tokens/cost` 是**终生累计**，不能当 7 天值用；窗口值只能来自 stats。
5. **按项目窗口值要 N 次请求**：项目数 e5 15 / n100 40，全部逐项目 stats 约 55 次 × 0.3–1s；需 top-N + 缓存。
6. **统计接口是历史扫描**：7 天 0.25–0.72s/台，30 天 0.6–1.2s/台，全量会超时（20s 上限，已记为 0.8.0 待修）。
7. **费用为 0 是常态**：两台 server 的 7 天费用主要来自 grok；订阅制模型 `cost=0`，费用维度对「用得多不多」解释力弱，必须同时给 token。

## 5. 建议的 v1（方案 A：插件设置页「洞察」区块）

**版式**：顶部筛选（server：全部/单台；时间窗：7 天默认，预留 30 天）→ 概览卡 → 三栏图表 →
口径脚注。

- **概览卡（6–7 个）**：会话（含子代理）/ 已归档 · 轮次与步数 · Token（4 类，缓存单列）·
  费用（注明「仅报价模型」+ 覆盖会话数）· 缓存命中率 · 工具调用（成功/失败）· 活跃天数与 streak
- **近 7 天活动**：按日 steps 柱状（缺日补 0），顶部标 7 天 token/cost 合计
- **模型分布**：token + 费用（按 `models[]`）
- **工具调用 Top 8**：调用数 + P50（`tools=detail`）
- **项目分布**：先按「窗口内活跃会话数」排序取 top 8，再只对这 8 个跑 `stats?project=` 拿窗口
  token/cost（并发 4、缓存 5 分钟）；拿不到的项目只显示会话数
- **不做的**：token 构成、耗时拆解、逐日 token/cost、技能/命令明细、活跃时长
- **缓存与刷新**：stats/项目 stats 缓存 5 分钟；面板 60–120s 刷新；多 server 串行聚合，
  失败的单台显示「不可用」而不是整页空

### 待定（下一步要定的）

1. 时间范围：固定 7 天，还是提供 今天 / 7 天 / 30 天 切换？（30 天每台 ~1s，可缓存）
2. 项目分布口径：只要「会话数」（快），还是要「窗口 token/cost」（准，但需 top-N 多次请求）？
3. 日图：接受「steps-only 柱状」，还是改成「7 天汇总 + 每日 steps 迷你图」？
4. 费用为 0 的模型：费用卡是否改成「token 主、费用辅」的双指标（推荐）？

## 6. 不在本需求内

- 归因/预算护栏（0.8.0 剩余项，另行推进）
- 会话内容分析（消息级 token 归类、技能/命令明细）
- 跨 server 的「会话合并」——仍是客户端聚合