# OpenCode 洞察区 —— 设计（2026-11-27）

> 需求：参考 dsh 的「上下文洞察」插件，在看板页顶部展示 OpenCode 过去 7 天的会话数与用量。
> 数据可行性见 [2026-11-27-opencode-insights-analysis.md](2026-11-27-opencode-insights-analysis.md)。
> 本文是实现依据：口径、接口、模块、UI、错误与测试。

## 1. 目标与非目标

**目标**

- 看板页（`main` 槽，全宽）顶部直接展示洞察区，不做 tab；空闲会话列表压到页面底部
- 7/30 天窗口内：会话/子代理、轮次/步数、Tokens、费用、缓存命中率、工具调用、活跃天数
- 近 7/30 天 **steps** 柱状（缺日补 0）；模型分布；**MCP/自定义工具**（内置工具不占版面）；
  **技能加载**按名计数；项目分布（会话数）
- 单台 server 失败不影响整页；服务端聚合 + 缓存，页面只渲染

**非目标（v1 明确不做）**

- 逐日 token/费用（OpenCode 只有 steps）、token 构成、耗时拆解、活跃时长、命令明细
- 技能明细的实时性：走懒加载消息扫描（10 分钟缓存），不进入 `/insights` 快路径
- 时间范围切换（v1 固定 7 天，API 预留 `from`）
- 新模型工具（模型侧继续用 `opencode_usage`）

## 2. 口径（全部窗口内，禁止用会话终生值）

| 指标 | 口径 |
|---|---|
| 会话 / 子代理 | Σ `stats.sessions` / `stats.subagents` |
| 轮次 / 步数 | Σ `stats.prompts` / `stats.steps` |
| Tokens | Σ `input`、`output`、`reasoning`、`cache.read`（分开返回） |
| 缓存命中率 | `Σcache.read / (Σinput + Σcache.read)`，无 input 时为 null |
| 费用 | Σ `stats.cost`；`quotedSessions` = 窗口内 `cost>0` 的会话数（近似） |
| 活跃天数 | 多台取 `activity` 日期并集；单位「天」 |
| 按日 steps | `activity[]` 按 `from..今天` 补 0；返回 `[{date, steps}]` |
| 工具 | `tools.totals` + `tools.usage[]`（name/calls/succeeded/failed/durationP50），按 calls 降序 |
| 模型 | `stats.models[]`（已归一化），按 token 总量降序 |
| 项目分布 | `collectServer` 的 `projects[].worktree` 分组，窗口内活跃会话（`busyAt >= from`）计数；空/`/` 归「未归属」；Top 10 |
| 归档 | `/session?archived=true` 翻页计数（最多 5 页，超限 `truncated`） |

多台聚合：数值相加；工具按 name 合并；模型按 label 合并；项目条目保留 `server`，不跨机器合并同名目录。

## 3. 接口

`GET /api/opencode-client/insights?days=&server=`（`days` 1–30，默认 7；`from` 仍兼容）

`GET /api/opencode-client/insights/skills?days=&server=`（懒加载；返回按技能名计数与 `truncated`）

- `from`：毫秒时间戳，缺省 = 7 天前；最小 1 小时前；上限 30 天（超出按 30 天）
- `server`：只统计单台，缺省全部

```json
{
  "ok": true,
  "from": 0, "to": 0,
  "total": {
    "sessions": 0, "subagents": 0, "prompts": 0, "steps": 0,
    "tokens": { "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0 },
    "cost": 0, "cacheHitRate": 0.988, "activeDays": 7,
    "quotedSessions": 0, "archived": 0,
    "tools": { "totals": {…}, "usage": [{…}] },
    "models": [{ "model": "…", "steps": 0, "tokens": {…}, "cost": 0 }],
    "activity": [{ "date": "2026-11-27", "steps": 0 }],
    "projects": [{ "server": "e5", "directory": "/path", "sessions": 0 }]
  },
  "servers": [
    { "id": "e5", "label": "e5", "supported": true, "…同上各字段…", "truncated": false }
  ]
}
```

单台失败：`{ id, label, supported: false, error }`；整页仍 200。

## 4. 模块

- `lib/sessions.js`
  - `collectStats(server, { from, to, tools: 'summary'|'detail' })`：新增 `tools`；**缓存键 = `tools 模式 + from 桶`**（否则 summary/detail 互串）
  - `summarizeStats`：`tools.usage[]` 归一化（name/calls/succeeded/failed/unfinished/durationP50，按 calls 降序）
  - `collectArchivedCount(server)`：`/session?archived=true` 翻页计数，缓存 5 分钟
- `lib/skills.js`（新）：扫窗口内会话消息的 `skill` 工具 `input.id`（兼容旧 `input.name`），
  250 会话 / 60 页每会话 / 1200 请求上限，10 分钟缓存，`truncated` 标记
- `lib/insights.js`（新）
  - `collectInsights(servers, { from, serverId, now })`：并行每台；派生指标；聚合 total；5 分钟缓存（`server.insightsCache`）
  - 纯函数：`computeCacheHitRate`、`fillActivity`、`groupProjects`（便于单测）
- `lib/routes.js`：新增 `/api/opencode-client/insights`
- `lib/client.js`：BoardPage 顶部「洞察」区（概览卡/柱状/三栏列表），120s 轮询、页面不可见暂停；空闲列表每组默认 6 个 + 展开更多

不新增模型工具。

## 5. UI

看板页自上而下：

1. 标题行（OpenCode 会话、设置 pill、汇总行、更新时间）
2. server 筛选 chips（与看板共用选择）
3. **洞察区**：概览卡 2×4 → 近 7 天 steps 柱状 + 7 天合计 → 三栏（模型 Top5 / 工具 Top8 / 项目 Top8）→ 脚注
4. 需要你 / 刚完成未查看 / 运行中 / 后台运行 / 异常
5. 空闲会话（按 server 分组，默认每组 6 个，「展开更多」）

柱状图用 div 宽度实现（无图表库）；文字沿用现有排版变量，深色主题下用 label/border 变量。

## 6. 错误、性能、缓存

- 单台 `supported:false` + error 文案；total 只统计成功台
- stats 7 天 0.25–0.72s/台、30 天 0.6–1.2s/台；insights 缓存 300s，面板 120s 刷新
- 归档计数缓存 300s；会话列表来自 `collectServer`（10s 缓存），超 500 条时 `truncated:true` 并在脚注标注
- v1 server：stats 不支持 → 该台 `supported:false`，不发额外请求

## 7. 附：可升级提示

本地 API 没有「最新版本」查询端点：`/api/info` 只给当前版本，`installation.update-available`
是易失 SSE（断线即丢，无回放）。因此 server 卡片的 `→ vX.Y.Z` 徽标由官方更新服务驱动
（`https://opencode.ai/update/api/latest/cli/npm`，与 `opencode upgrade` 同源）：
`lib/version.js` 1 小时缓存、5 秒超时、失败静默（不显示徽标）；
`GET /api/opencode-client/upgrade` 只返回 `{ok, latest, checkedAt}`，客户端与各 server 版本比较。

## 8. 测试

`test/insights.test.js`（fake v2 server）：

1. 汇总与缓存命中率公式；`quotedSessions`
2. `activity` 缺日补 0（从 from 到今天）
3. 工具 usage 归一化/排序/P50
4. 项目窗口计数（busyAt 过滤、`/`→未归属、带 server）
5. 归档计数（翻页/截断）
6. 单台失败隔离（total 不含失败台）
7. **stats summary/detail 缓存不串**（同 from 桶各取一次）
8. MCP 拆分（内置白名单之外、按前缀归组）与 `days` 窗口
9. 技能名聚合、旧 `input.name` 兼容、页数上限 `truncated`、缓存、v1 无请求

## 9. 发布

归入 **0.9.0 (unreleased) — [observe] 洞察**；CHANGELOG 新增一节，TODO §10.2 加一项，README 双语 UI 段、ARCHITECTURE 模块图同步。不阻塞 0.8.0 的预算护栏。