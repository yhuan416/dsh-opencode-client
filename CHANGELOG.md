## 1.0.0 (unreleased) — [core] v1 下线 + client 迁移（breaking）

### Changed

- **OpenCode 1.x 不再支持**：探测为 v1（含 `/api/info` 缺失）时，所有请求以
  `opencode.v1_unsupported` 失败，并提示「requires OpenCode 2.x」；`apiVersion: 1` 视为 auto
  并被拒绝。
- **v1 死分支全部清理**：sessions / jobs / skills / catalog / workspace / delegate / manage /
  interactions / session-run / events / sse / routes / tools 的 v1 映射与回退删除；`apiPath`
  始终指向 `/api/*`。
- **传输迁移到 `@opencode/client@2.4.2`（精确锁定）**：新增 `lib/oc-client.js`，每台 server
  缓存一个 client；sessions / catalog / workspace / delegate / session-run / interactions /
  manage / skills 全部走 client。CI 禁止 `^`/`~`/`*`。
- **错误映射**：client 的 5xx 结构化错误会带上 `reason`/`status`，不再出现空错误文案；
  分页请求修正为「首页 `order=desc`，后续页只传 `cursor`」（`Cursor cannot be combined with
  order` 会让目录归因 partial、技能计数归零）。
- **测试**：v1 用例删除或改为 v2 only；129 个测试全绿。

### Verification

- 真机 e5 / n100（OpenCode 2.4.2）：目录归因与 stats **delta=0、partial=false**；技能 7 天
  72 次 / 30 天 151 次；部署自检 usage / board / insights / MCP+skills / upgrade 全 **PASS**。

### Migration

- 将 OpenCode 升级到 2.4.x；把 1.x server 从插件配置中移除。
- `apiVersion: 1` 配置会被当作 auto 并拒绝；改成 `auto` 或 `2`。
- 未发 tag：`1.0.0` 这个号留给正式发布时再打。

## 0.9.0 (unreleased) — [observe] 洞察

### Added

- **看板页顶部洞察区**：看板页（`main` 槽，全宽）最上方直接展示近 7 天洞察，不做 tab；
  空闲会话列表压到页面底部（每组默认 6 个 + 展开更多）。区块含 8 张概览卡
  （会话/子代理、已归档、轮次/步数、Tokens、缓存命中率、费用、工具调用、活跃天数）、
  近 7 天 steps 柱状（缺日补 0）、模型 Top5、工具 Top8、项目 Top8，以及口径脚注。
- **新路由** `GET /api/opencode-client/insights?from=&server=`：`lib/insights.js` 在服务端聚合，
  单台失败只让该台显示不可用（`supported:false`），整页仍 200；缓存沿用 stats（5 分钟）。
- **数据口径**（全部窗口内，不用会话终生值）：会话/子代理 = `stats.sessions/subagents`；
  Tokens = `stats.tokens` 四类；缓存命中率 = `cache.read/(input+read)`；费用 = `stats.cost`
  并附「有报价会话数」；日图只能画 **steps**（OpenCode 无逐日 token/cost）；项目分布 =
  窗口内 `time.busy` 会话按项目 worktree 计数（`/` 归「未归属」）。
- **stats 扩展**：`collectStats` 支持 `tools: 'summary'|'detail'`，**缓存键并入模式**
  （此前只有时间桶，summary 会污染 detail）；`tools=detail` 的 `usage[]` 归一化（calls/P50，
  跨 server 合并时 P50 不一致就给区间）；`activity[]` 进入 `summarizeStats`；
  新增 `collectArchivedCount`（`archived=true` 翻页计数，5 分钟缓存）。
- **MCP / 自定义工具**：`tools=detail` 已包含 MCP 工具名，按「内置白名单之外」拆分并按前缀归组
  （gitlab / jira / serial-hub / mining-* …），内置工具（shell/read/write…）不再占版面；
  7 天窗口内两台 server 实测 0 次 MCP 调用，30 天为 3854 次（占比 3854/33267+3854）。
- **技能加载明细**：新增 `GET /api/opencode-client/insights/skills`，扫消息取 `skill` 工具的
  `state.input.id`（兼容旧数据的 `input.name`）按技能名计数；独立懒加载 + 10 分钟缓存，
  扫描上限（250 会话 / 60 页每会话 / 1200 请求）并用 `truncated` 标记；实测 7 天 1.5s、
  30 天 3.7s，与 stats 的 `skill` 总数一致（7 天 71、30 天 150）。
- **7 / 30 天切换**：洞察区时间窗可切换（默认 7 天，选择记入 localStorage）；
  MCP 在 7 天窗口为 0，切 30 天即可看到分布。
- **可升级提示**：server 卡片版本旁显示 `→ v2.4.2`。本地 API 没有「查最新版本」端点——
  `/api/info` 只有当前版本，`installation.update-available` 是易失 SSE（断线即丢），
  因此查官方更新服务 `https://opencode.ai/update/api/latest/cli/npm`（`opencode upgrade` 同源），
  **启动时查一次、之后每天一次**（服务端成功缓存 24 小时、失败 1 小时后重试），
  失败静默无徽标；`GET /api/opencode-client/upgrade`。
- **测试**：`test/insights.test.js` 5 项 + `test/skills.test.js` 5 项（窗口汇总/activity 补 0/
  项目计数、单台失败隔离、summary/detail 缓存不串、MCP 拆分、days 窗口、技能名聚合、
  旧 `input.name` 兼容、页数上限 truncation、缓存、v1 不支持、路由）；合计 119 → 133（另加 `test/version.test.js` 4 项：版本比较、失败降级、缓存、路由）。

### Notes

- 明确不做（数据不可得，不伪造）：逐日 token/费用、token 构成、耗时拆解、活跃时长、
  技能/命令明细。脚注已写明「费用仅含报价模型 · 日图仅 steps」。
- **OpenCode 2.4.2 验收（2026-11-27）**：e5 / n100 两台 server 从 2.3.0 升到 2.4.2，
  `npm run e2e` 两台各 10/10 通过；`/openapi.json` 对比为纯增量，本插件读取的
  endpoint / event / payload 无删除（详见 `COMPATIBILITY.md`「2.4.x deltas」）。
  升级中踩到并已修掉：2.4.0 把 MCP `protocol` 默认值从 `legacy` 改成 `auto`，只提供
  `2026-07-28` 的 stdio server（n100 `dev-tools`）会因探测超时回退 legacy 而连接失败，
  需在 **v2 形态** `mcp.servers.<name>` 里写 `"protocol": "2026-07-28"`（v1 形态
  `mcp.<name>` 会静默丢掉该字段）；另注意重启后首次读取 model/skill/mcp 清单可能为空。

## 0.8.0 (unreleased) — [observe] 可信度

按「一核两轨」的第一轨推进：先让看板说的事**对、全、能追到钱**。本切片只读、复用现有数据。

### Added

- **空闲会话按目录分组**：看板「空闲」区从「按机器」改为「按（机器, directory）」分组，组头
  显示目录 + 机器 + 条数；机器 chip 过滤继续生效，折叠/展开按目录各自保留 6 条上限。
- **SSE 进度补种**：SSE 没有回放，连上前就在跑的会话现在会在 stream 打开后读取 `session/active`
  与最近消息，补一次当前 tool（tool/name/callID/since），不会再一直空到下一次工具事件。
- **回收小项**：`opencode_git_diff` 增 `untracked`（`files`/`folders`）与 `base`；
  `opencode_find` 增 `kind=dir`（映射 `type=directory`）；`opencode_sessions` 增 `archived`
  与 `cursor` 翻页（返回 `nextCursor`，不再受 500 条快照截断）。
- **机群健康**：`/board` 的 `servers[]` 增 `probe`（版本探测结论与原因：`reason`/`at`/`detail`）与
  `sse`（`state`/`attempts`/`connects`/`openedAt`；`connects > 1` 即重连过）。设置页每行显示
  「API v1 · 已冻结」、探测失败原因、重连次数；看板 server 卡对 v1 实例与重连显示提示。
  `opencode_board` 工具输出多一行 `health:`，模型也能看到哪台在漂移/重连。
- **后台任务可见**：`lib/jobs.js` 读 v2 的 `GET /experimental/job?status=running`，按 `sessionID`
  合并进登记表；会话已经 `idle`（`time.idle` 已写、`/session/active` 为空）但 job 仍在跑的，
  状态为新的 **`background`**（优先级 `running` 之下、`idle` 之上）。看板新增「后台运行」分区、
  server 卡计数、`opencode_board` 的 `background (N)` 段与 `opencode_progress` 的 background 行，
  都带命令与已跑时长。实测 n100/e5：一条 `jira_weekly_report.py` 后台跑了 9+ 分钟，期间会话所有
  常规信号都说空闲——这是唯一能看见它的信号。只有 OpenCode 的后台 job 机制可见；agent 里
  `nohup … &` 直接脱离 job 的进程仍然看不见。v1 明确不支持（接口缺失时静默降级，不影响看板）。
- **成本归因**：
  - `summarizeStats` 透出服务端权威的 per-model 归因（`models[]`：`model`/`steps`/`tokens`/`cost`，
    按成本降序、上限 10）；`opencode_usage` 工具每台 server 追加 `models:` 前三条。
  - 新 `collectCostByDirectory()`：按目录汇总**窗口内**成本。OpenCode 没有按目录聚合的端点，
    而 `session.cost` 是**终生累计**，所以改为累加窗口内 `assistant` 消息的 `cost`（与 `/experimental/session/stats` 同一数据源；
    compaction 消息也带成本，但 stats 与 `session.cost` 都不计它，计入会让目录与总成本对不上——
    e5 上一条 $0.444 的 compaction 就会让偏差到 0.45%）；活跃判定用 `time.busy`（只有真跑过的会话才有），
    不再用会被「查看/改名」刷新的 `time.updated`。目录取会话自身的，空或 `/` 时回退项目
    worktree（`global` 的 worktree 就是 `/`，把总账挂在 `/` 比标「未归属」更糟）。
    候选会话 = 活跃且有价成本；只为它们翻消息（每会话通常 1 页），并发 4、单次上限 50 个会话 /
    单会话 20 页 / **200 请求总预算**（`from: 0` 全量历史时兜底），触顶时返回 `partial: true` 而不是静默少算。
    目录缓存 600 秒（设置页 240 秒轮询；stats 仍 300 秒）。
  - `/api/opencode-client/usage` 增 `total.byModel`（跨 server 聚合）；`?group=directory` 时再返回
    `total.byDirectory`（展示用，top 10）、`total.byDirectoryCount`、`total.byDirectoryKind`、
    `total.byDirectoryPartial`、`total.byDirectoryDelta` 与 `total.reconciled`（目录总和与 stats 总成本差
    >max($0.01, 1%) 即为 false），以及每台的 `directories`。**对账用未截断的目录总额**，展示列表的
    top-10 截断不会让机群误报“不一致”。v1 没有 stats/per-message cost，直接跳过目录拉取，不发无用请求。
  - 设置页新增「近 7 天归因」：模型与目录各取前三，`byDirectoryPartial` / `reconciled=false` 时追加
    「（部分 · N 个会话未读到）」「（与总成本不一致）」提示；看板 server 卡显示 `top: <模型> $x.xx`。
  - **抗抖动**：单会话读取失败自动**重试一次**（`total.retried`）；仍失败则在
    `total.byDirectoryFailures` 记录 `{server,session,reason}`（最多 5 条，`/usage` 每台也有
    `directoryFailures`）。**不完整结果不进缓存**：各一次瞬时失败曾让 $27.39 缺失、且被 600 s
    缓存挂在设置页约 10 分钟；现在下一次 240 s 轮询就会自愈。
- **测试**：`test/usage.test.js` 加 6 项（窗口内消息成本与目录回退、上限 `partial`、compaction 排除、
  请求预算、v1 拒绝近似、未截断对账），并把 `/usage` 用例改为断言 `kind`/`reconciled`；
  `test/board.test.js` 加 1 项（`probe`/`sse` 健康字段）；合计 104 → 110。

### Fixed

- **目录归因口径错误（初稿）**：第一版用「`time.updated` 在窗内的会话 + 终生 `session.cost`」，
  实测 OpenCode 2.3.0 七天窗口 **$72.52 / 90 会话**，而权威 stats 是 **$14.08 / 59 会话**（虚高 5.1 倍）；
  `/` 桶还吃掉了 $58（那是一笔创建于窗口之前、本周没跑过的会话，只被查看过）。改为窗口内消息成本 +
  `time.busy` 后，同机实测目录合计 **$14.08414**，与 stats 分毫不差，`/` 桶消失。

### Still to do in this version

空闲会话过滤/分组、SSE 补 progress、以及回收小项
（`git_diff` untracked/base、`find kind=dir`、`sessions` archived、`read_file` 截断提示）。

> 2026-11-27 决策：**预算/成本护栏不做**——订阅/未报价模型 `cost=0` 会让阈值失真，
> 7/30 天洞察已覆盖成本可见，且「只提醒不阻断」收益低；已移入 TODO §10.6。

## 0.7.2 (2026-11-26) — 清单与门禁

### Fixed

- **`exports` 缺 `./locale/*.json` 与 `./icon`**：插件管理页读不到 `meta.title` / `meta.description`，
  双语标题描述等于白写（实测 `import.meta.resolve("dsh-opencode-client/locale/en.json")` 报
  `ERR_PACKAGE_PATH_NOT_EXPORTED`）。已补齐导出。
- **客户端注册只包了一个 try**：`ctx.sidebarRightTabs.register` 与后面的 `main` 看板、
  `sidebar.panellist` 图标、`shell.overlay` 提醒、会话头按钮共用同一个 try，该服务一旦缺席就整块
  注册失败、面板消失，catch 只打一行警告。改为逐条 `guard()`，并补 `dsh.client.inject`
  声明 5 个 client 包（`ui-chat` / `ui-conversation` / `ui-sidebar` / `ui-sidebar-right` /
  `ui-plugin-manager`）让激活顺序有据可依。

### Added

- **`scripts/check-manifest.mjs`**：清单门禁——identity/`engines`、bundle 与 `inject` 声明、
  `exports` 子路径**经 Node 自引用解析**（locale 静默失效就是在这里被抓的）、多语言 `meta` 键一致、
  图标格式/大小（≤256 KiB、SVG 可渲染）、`files` 覆盖、以及
  `package.json` / CHANGELOG 最新已发布节 / 精确匹配 git tag 三方版本一致（支持 `(unreleased)` 过渡）。
- **`scripts/check.mjs` 增加语法门禁**：对 `lib/`、`scripts/`、`test/` 全量 `node --check`。
  此前 `lib/client.js` 只做正则断言、从没被解析过，一个多余的花括号也能让 CI 全绿通过。
- 四个门禁都做了负向验证（删导出 / 改版本 / 撑大图标 / 注入语法错误）——全部按预期变红。
- `npm run check` 现在是：语法门禁 → 客户端/观测断言 → 清单门禁 → 100 项测试；CI 跑同一条命令。

### Changed

- **v1（OpenCode 1.18.x）冻结**：代码保留、离线用例仍覆盖，但不再新增 v1 能力、不再对 1.18.x 做实机
  验证（项目里已没有 v1 服务器）；v2 是支持目标。README 双语、`COMPATIBILITY.md`（新增 v1 policy
  一节）、`docs/TOOLS.zh.md` 的承诺口径统一；删除 v1 若发生，会作为 breaking 版本另行公告。
- `COMPATIBILITY.md`：验证版本更新到实测的 dsh `0.2.2-rc.5`；seam 表补齐
  `dsh.client.inject`、`sidebarRightTabs` / `sidebarRight.openTab`、`pluginNavigation.openBundle`、
  `configEditor.edit` 与六个槽位；新增 Gates 一节说明三道门禁各自拦什么，并写明
  `engines.dsh` 由 `plugin_manager` 在安装/激活时强制、基础 loader 只作声明。

## 0.7.1 (2026-11-26) — 用量与成本 + 完成未查看

### Added

- **用量 / 成本**（此前只有会话级的 `cost`，没有任何聚合视图）：数据源是 v2 的
  `GET /api/experimental/session/stats`（实测 2.3.0 返回
  `{sessions, subagents, prompts, steps, tokens{input,output,reasoning,cache{read,write}},
  cost, tools{mode,totals{calls,succeeded,failed,unfinished}}, activeDays, streak, activity[], models}`）。
  - 新工具 `opencode_usage`（`server`、`days`，默认 7 天，`0` = 全部历史）：逐台报会话数、步数、
    in/out/reasoning/cache token、成本、工具成功率，并跨 server 汇总；**v1 明确报
    “v1 server or stats unavailable” 而不是返回一堆 0**。
  - 新路由 `GET /api/opencode-client/usage?from=&server=`：返回每台明细 + 跨 server 的 `total`，
    给 Web 面板用。
  - 看板新增 **per-server 概览卡**：状态点、版本、会话/运行/待办数、token 行、成本，点卡片即
    按该台过滤（与 chip 同一路径，所以会记住选择）；会话卡副标题补 `in / out · cache` 一行，
    卡片说明改为最多两行（`-webkit-line-clamp`）。
  - 设置页显示「今日用量」（会话 / 步 / token / 成本），60 秒刷新。
  - `observation` 的会话条目开始携带 `tokens` / `cost` / `model`，看板行带着暴露出去。

- **刚完成 · 未查看**（跑完的会话在被人看过之前不沉进空闲）：
  - **未读拆成「本地候选 + 远端清除」**：候选 = 我们亲眼看到 running→idle（`sawFinish`），清除 =
    OpenCode 的 `viewed >= idle`（在它自己的 UI 里看过）或 dsh 的 `/seen`。标记已读复用
    `POST /session/{id}/view {idle}`。
    **为什么不只用远端标记**（实测修正）：e5 180 个会话里 10 个、n100 339 个里 1 个根本没
    `time.viewed`——从没在 OpenCode UI 打开过的、dsh 委派建的会话；而两台机器上 `idle > viewed`
    的是 0 个。只按标记判会把“刚跑完且确实没人看过”判成已读，功能永不触发；只按本地判又会在
    dsh 重启后把几百条历史刷成未读。所以候选走本地、清除走远端。
    代价：dsh 重启前完成的会话不再提醒（新 run 结束会重新武装）。
  - 看板新增分区「刚完成 · 未查看」（在「需要你」与「运行中」之间），卡片显示
    `完成于 X 前 · 用时 3m12s · in/out · $0.12`；左栏图标徽标 = 待处理 + 未查看；面板头部多一格
    「N 未查看」。行**从空闲区与其计数里排除**，不会两处重复。
  - 完成 toast 的正文从「server · 目录」升级为「server · 用时 · in/out · 成本」（数据来自
    `step.ended` 在 run 内累加，缺失时回退会话累计并标注）。watcher 现在也轮询 `unseen` ——
    否则刚完成的行会在同一拍离开轮询集合，toast 永不触发。
  - 新路由 `POST /api/opencode-client/seen {server, session, idle?}`：`idle` 必须来自看板行，
    取不到就拒绝（400）而不是拿时钟去猜，避免把还在跑的 run 标成已读。
  - 点开卡片（或被设置页/标签页打开）即上报已读；dsh 委派（`opencode_subagent`、
    `opencode_prompt wait=true`）拿到结果也算已读——一轮委派不再留下未读点。
  - 用时复用 `time.busy → time.idle`，成败复用会话 `outcome`，都不新增状态。
  - v1 没有 `viewed`：未读恒为 false、分区不出现、`/seen` 返回 `supported: false`，行为回到现状。

### Changed

- `/api/opencode-client/board` 的 `servers[]` 增 `sessions`（该台会话数），概览卡不必为了计数
  再拉一次会话列表；顶层增 `unseen` / `unseenCount`，`idleCount` 不再包含未查看的会话。
- `opencode_board` 工具输出多一块「finished, not looked at (N)」，模型也能看到刚跑完还没人看的会话。

### Fixed

- 看板 server 筛选**只能单向粘滞**：初始值读 `localStorage`，但写盘只发生在 `choose()` 里，
  「全部」chip 直接 `setSelected("all")` 只改内存 —— 刷新后又被上次选中的那台覆盖，表现为
  “选了某台就回不到全部”。现在抽出 `setFilter()` 统一 `setSelected` + 落盘，两条路径共用；
  `scripts/check.mjs` 加静态断言盯着「全部」chip 必须走 `setFilter`，回退会立刻失败。
- 用量缓存原本等于没有：键取自 `from` 精确值，而调用方（看板的 7 天窗口）每次都按
  `Date.now()` 现算 `from`，加上 TTL 恰好等于看板 120 秒轮询间隔，于是**每次轮询都落空**、重新
  触发一次服务端历史扫描（实测 7 天窗口 0.2–0.6 秒，全部历史在繁忙 server 上约 15 秒）。
  现在键按 range 起点**分桶**（300 秒）且不含随请求漂移的 `to`，TTL 提到 300 秒（大于轮询间隔），
  `from: 0`（全部历史）单独用一个键避免与近窗口撞车，缓存 Map 上限 32 条。
- 新增 `test/usage.test.js`（4 项）：归一化真实 payload 形状、分桶缓存命中/全部历史单独键、
  v1 报 unsupported、字段缺失兜底。
- **`lib/routes.js` 里 16 个处理器调用了一个从未定义的 `findServer`**（`/fork`、`/abort`、
  `/prompt`、`/session`、`/shell`、`/git/*`、`/file`、`/find` …），每次调用都是
  `ReferenceError`。`lib/board.js` 里早就有一个同名实现，但既没被使用也没被导出——典型的接线
  漏了一根线。现在在 `createRoutes` 内定义一次（未知 id 回落默认 server，与原有注释语义一致），
  删掉 `board.js` 的孤儿副本，并加回归测试（修复前该测试抛 ReferenceError）。
- 新增 `test/seen.test.js`（4 项）：`/seen` 用行的 `idle` 打远端 `POST /view`、缺 `idle` 时拒绝
  且不发请求、v1 报 unsupported、`summarizeSession` 的 `busy/idle/viewed/outcome` 与 v1 缺省。

## 0.7.0 (2026-11-26) — 界面可配置 + 注意力提示

### Added

- **在界面上加/删远端**：设置页新增「添加远端」表单（id / url / password / label / directory）
  与每行的「移除」。保存与移除都走 dsh 官方的 `configEditor.edit()`——写回本插件在 profile 里的
  那一行配置，由编辑器负责校验、原子写与 HMR 串行化；普通字段改动让插件自动重启，
  **新 server 无需手动重启 dsh 即可出现**。插件不再自己读写 `cordis.patch.yml`。
- **测试连接**：`POST /api/opencode-client/probe` 在保存前探测目标（`/api/info`），
  返回 API 代次与 OpenCode 版本；密码不对会明确回落到 v1，避免“存进去才发现是 offline”。
- **注意力提示**（此前完全静默）：
  - 左栏 OpenCode 图标上的待办徽标（数字，0 时不显示）；
  - 右下角 toast，只在**状态跨越**时提醒（`running→idle` 完成、`→waiting-permission/​question`
    需要你、`running→error` 失败），首次加载不提醒；
  - watcher 注册在 `shell.overlay`（应用框架级），不依赖看板页面是否打开；
    页面可见 8s、隐藏 15s 轮询。
- **设置入口**：看板顶栏「⚙ 插件设置」胶囊，调用 dsh 的
  `pluginNavigation.openBundle('dsh-opencode-client')` 直达插件配置页；样式与 dsh-context
  的同名按钮逐条对齐（同一套 token：`bg-layer-2` 底、`.5px border-l4`、`999px` 圆角）。

### Fixed

- 路由注册按 **path** 去重（不含 method）：`/servers` 的 POST 与 DELETE 撞名会让那条 effect
  抛错，导致**整个插件路由表全部消失**（`/board` 也 404）。移除改用独立路径
  `/servers/remove`；单条路由注册失败不再拖垮其余路由；新增“路由 path 唯一”回归测试。
- 设置页不再渲染工作区与几百条会话（那是看板的职责），轮询改为 15s 且只读缓存。

### Changed

- `npm test`：86 项（新增服务器 CRUD、探测、路由唯一性、/board 字段等用例）。

## 0.6.1 (2026-11-26)

### Fixed

- `/api/opencode-client/board` 的 `servers[]` 新增 `version` / `state` / `groups`。修复过程中
  发现并修正一处变量遮蔽：处理函数里的 `const board = observation.board(...)` 盖掉了外层的
  刷新器服务，导致 `serverInfo()` 恒为 undefined、所有 server 都显示 offline 且没有版本号。
  已改名 `snapshot` 并补回归测试（修复前该测试会失败）。
- 桌面端（`html[data-platform]` 存在时）点卡片改为打开**右侧栏标签页**而不是全屏浮层：
  跨域 iframe 会吞掉 Esc 和父页面控件，全屏浮层在桌面端可能“回不去”。标签页可携带会话深链
  （`openSidebar(serverId, sessionUrl)`），用 dsh 自己的关闭控件退出。

### Changed

- 设置页（设置 → 插件 → OpenCode Client）精简为**只放配置与状态**：每台 server 一行
  （状态点 / 版本 / live / 目录数 / 运行数 / 待办数）+「打开」「新标签」，不再渲染工作区与
  会话列表——那是观测台（左栏）的职责。轮询 15 秒且只读缓存（`?refresh=0`），不给远端加流量。
- 全屏浮层加固：iframe 四周留 8px 父页面边距、点击边距即关闭、iframe load 后把焦点交回
  返回按钮，让 Esc 重新可用。
- 会话页面改为**在面板内打开**（替换看板区域），不再使用全屏浮层：不与 dsh 抢层级、
  不锁页面滚动，返回是普通状态变化，与跨域 iframe 的焦点无关；Web 与 Desktop 走同一条路径。
- 面板内顶栏：`← 返回` 在左；中间显示**远端实例名 + 实例 URL**（会话标题已由 OpenCode 页面
  自己展示，重复无益），完整会话深链放悬停提示；右侧只留 `↗`。去掉重复的「Esc 返回」提示，
  Esc 仍然生效。
- 字号统一为两档：标题 13px、其余 12px（原来是 11/11.5/12/13/14 五种混用，对齐 dsh 宿主
  列表的字号）。
- 全屏浮层同样收敛：去掉重复的退出提示，按钮与标题统一 12px。

## 0.6.0 (2026-11-26) — 观测台（observation console）

**定位调整**：从「另一个 OpenCode 客户端」转为 **OpenCode 机群的观测台**——会话访问是手段，
不是目的。与 OpenCode 自己的 TUI/Web 正面竞争的部分（会话内聊天）明确不做，只做它做不到的
三件事：多 server 一张表、跨会话的注意力聚合、把 opencode 暴露成 dsh 的 agent 后端。

先把会话状态采集上来，再谈展示：一个进程内登记表回答「谁在跑 / 谁在等我 / 谁挂了」，
且不引入第二套真相。

### Added

- 观测台页面：`main` 插槽改为**卡片看板**（不再是「状态条 + 内嵌 OpenCode」）。紧急组
  （需要你 / 运行中 / 异常）跨远端平铺置顶，空闲会话按远端分组；远端筛选胶囊记住选择；
  点卡片在浮层内打开该会话（`/server/<base64url(origin)>/session/<id>`），Esc 或顶栏关闭。
- `lib/board.js`：`/board`、`/list` 行内状态与 `opencode_board` 工具共用的刷新器，
  避免页面与模型对「谁在跑」给出不同答案。
- `lib/observation.js`: `(server, session)` registry merging running snapshots
  (`/session/active` v2, `/session/status` v1), SSE increments, and pending
  snapshots. Status precedence `waiting-permission > waiting-question > error >
  running > idle > unknown`; child sessions fold into their parent; `stale` is a
  flag (a running row whose snapshots and events both stop never becomes `idle`).
- `collectPending()` (lib/sessions.js): normalized pending permission/form list —
  global `/permission` + `/question` on v1; on v2 the location-scoped
  `/api/permission/request` + `/api/form` (measured on 2.x: one query instead of
  one per session), falling back to per-session `/permission` + `/form` only on
  builds that lack them.
- `GET /api/opencode-client/board`: needs-me / running / idle / unknown projection
  plus per-server liveness; `/api/opencode-client/list` rows now carry `status`.
- `scripts/probe-observation.mjs`: standalone probe that prints the board from one
  real server without dsh (`OPC_PROBE_URL=... node scripts/probe-observation.mjs`).
- 新增工具 `opencode_board`：跨 server 汇报 needs-you / running / idle，先于面板即可用
  （手机端的远程客户端也能通过它拿到同一份状态）。
- `lib/client.js` 增加静态冒烟：`boardSessionUrl` / `openOverlay` / `BoardPage` 必须存在
  （一次布局重构误删了深链函数，导致点击静默失效）。

### Changed

- A permission request from a session **no dsh run owns** (e.g. you drive it from
  the OpenCode TUI) is no longer auto-answered: with `permission: ask` (default)
  it is recorded as pending and left waiting. `permission: auto` restores the old
  auto-answer behaviour.
- Forms/questions with `question: ignore` are recorded as pending as well;
  `question: reject` keeps dismissing them (unchanged).
- `npm test`: 82 cases (adds the registry unit tests, the fake-server collection
  test, and the SSE → registry wiring test).

### Known limitations

- `/board` 在第一次快照回来前一律 `unknown`；待办快照失败时保留上次已知集合而不是清空。
- 不持久化：重启后从快照重建。
- iframe 里的会话页跨域：焦点进入后 Esc 归 OpenCode（父页面收不到键盘事件），
  只能用顶栏「关闭」；首次嵌入需在 OpenCode 里登录一次。彻底解决要同源代理。
- 空闲会话数量大（n100+e5 约 480，含大量 `dsh delegate` / `dsh subagent:` 机器会话），
  目前每台最多取 60 条；是否需要默认过滤机器会话待定。

## 0.5.1 (2026-11-20)

Report non-zero exit codes from a cleanly-exited shell.

### Fixed

- `opencode_shell` only printed `exit N` for non-`exited` states, so a command that
  ran and failed (`exit 3`, status `exited`) looked successful with empty output.
  A non-zero exit (and `signal` when present) is now reported as `(shell exited, exit 3)`.

### Changed

- `npm test`: 68 cases (adds the failed-command case).
- `package.json`: version `0.5.1`.

### Verified

- Found during a live 0.5.0 check: `opencode_shell` with `echo hello-050; exit 3` showed no exit
  code; the fix is covered by the fake server and awaits the next dsh restart to show in the tool.

## 0.5.0 (2026-11-20)

Read-side detail improvements: see what a remote session actually did, and stop
silently losing shell output.

### Added

- `opencode_messages`: tool lines now carry the call input summary and the first
  output line (`[tool] bash: completed · npm test → all green`); new `type=` filter
  (`user|assistant|shell|system|synthetic|idle|...`, server-side on OpenCode 2, local on v1).
  Bookkeeping message kinds are hidden by default and rendered only when explicitly filtered.
- `opencode_shell`: follows the v2 output cursor across pages (up to 1 MiB), and reports
  truncation explicitly (`[output truncated at N bytes; cursor=M]`), plus exit code and
  `signal` when the shell did not exit cleanly.
- `opencode_sessions`: rows carry the model (with `#variant`), agent, outcome and non-zero
  cost when the server reports them.
- `opencode_session_info`: `model: (server default)` when the session has no model, plus
  parent-session/fork source and created/updated timestamps.
- `opencode_models`: OpenCode 2 token limits are listed (`[ctx 1M, out 384k]`).
- `opencode_abort`: an idle session now reports `nothing to interrupt (interrupted=false)`
  instead of a generic failure.

### Changed

- `npm test`: 67 cases (new detail tests for session rows, tool lines + type filter, shell
  truncation/pagination, session/model metadata and idle abort).
- `package.json`: version `0.5.0`.

### Verified

- Live on n100 (OpenCode 2.3.0): session rows show
  `alibaba-token-plan-cn/deepseek-v4.1-flash#high · agent=build · succeeded`; message tool
  lines show `bash: completed · cd … && git add … → M CHANGELOG.md …`; `type=user` filters
  server-side; `seq 1 200000` returns 1 MiB with
  `[output truncated at 1288895 bytes; cursor=1048576]`; model listing shows `[ctx 1M, …]`;
  aborting an idle session returns false.

## 0.4.2 (2026-11-20)

Session info shows the reasoning variant.

### Fixed

- `opencode_session_info` printed `model: provider/model` even when the session used a variant;
  it now renders `provider/model#variant` (the server's default variant is omitted as noise).

### Changed

- `npm test`: 62 cases (adds the model-label test).
- `package.json`: version `0.4.2`.

### Verified

- Live on n100 (OpenCode 2.3.0): a session created with
  `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high` reports `variant:"high"` over the API and
  now renders as `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high`.

## 0.4.1 (2026-11-20)

OpenCode 2 model variants are selectable, not just listable.

### Added

- `model` accepts `"providerID/modelID#variant"` (e.g.
  `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high`). The variant rides the v2
  `Model.Ref.variant` field when the session is created or the model is switched, and shows up on
  the remote session (`session.model.variant`). Plain `"provider/model"` still means the model
  default; `opencode_models` lists the variant ids per model.
- v1 stays strict: prompt bodies only send `{providerID, modelID}` (the `variant` field is
  v2-only), while v2 session creation carries the full `Model.Ref`.

### Changed

- `npm test`: 61 cases (adds the variant parse/ref shape test).
- `package.json`: version `0.4.1`.

### Verified

- Live on n100 (OpenCode 2.3.0): delegating with
  `alibaba-token-plan-cn/deepseek-v4.1-flash-1017#high` created a session whose
  `model.variant` is `high`; omitting the variant yields the server default.

## 0.4.0 (2026-11-20)

OpenCode 2 compatibility backfill: three v1 capabilities that v2 removed or degraded are restored
through v2-native fallbacks, and message pagination is now correct for long sessions.

### Added

- `opencode_find kind=text` works on OpenCode 2 again. v2 removed `/find?pattern=`, so the plugin
  runs a workspace `grep -rIn -F` through the async shell (`lib/workspace.js::runShellCommand`) and
  returns the same `path:line: text` shape (first 100 matches, literal substring, `.git` skipped).
- `opencode_session_info` todo list works on OpenCode 2 again, derived from the last `todowrite`
  tool call in the session (`state.input.todos`); output marks it `[derived from the last todowrite
  call]`. v1 keeps using `/session/{id}/todo`.
- `opencode_models` surfaces OpenCode 2 model `variants` (reasoning-effort ids) as
  `model{none|low|high}` so a variant can be picked without guessing.

### Fixed

- `opencode_messages` follows the v2 cursor (`cursor.next`) instead of silently truncating at the
  server page size: requesting N messages now pages until N entries are collected (bounded to 20
  pages / 4000 raw entries) and keeps exactly the newest N.
- `opencode_find kind=text` no longer answers "not available on OpenCode 2".

### Changed

- `npm test` covers 60 cases (4 new v2-compat tests: shell-grep search, cursor pagination, derived
  todos, model variants).
- `package.json`: version `0.4.0`.

### Verified

- Live on n100 (OpenCode 2.3.0): content search returned `./a.txt:1: alpha needle here` (2 hits);
  a session that used `todowrite` reported all 6 todos with priorities; a 199-message session
  returned 149 of 150 requested messages (one raw entry is not a text message); model listing
  showed `qwen4-max-preview{none|low|medium|xhigh}` and `deepseek-v4.1-flash-1017{none|low|high}`.

## 0.3.0 (2026-11-20)

Multi-server subagent routing, accurate stop reasons, and a crash fix in the shared prompt path.

### Added

- `opencode-auto` routed provider. Per-server providers are pinned to one machine; when more than
  one server is configured the plugin also registers `opencode-auto`, which orders candidates per
  start (`directory` → `sticky` → `least-busy` → `round-robin`) and falls back to the next server
  when a start fails before the run is published. The chosen server is appended to the child
  session title (`dsh subagent: <label> @<server>`) and logged.
- `routing` config block: `providerName` (default `opencode-auto`), `policy`, `sticky`,
  `failover`, `stickyTtlMs`. Enabled by default when `servers.length > 1`; set
  `routing.enabled: false` to opt out.
- `opencode_subagent_auto` tool row example (add `tool-opencode-auto` with
  `provider: opencode-auto`).
- `stopReason` fidelity: OpenCode's `finish=length` now maps to dsh `max-tokens` and
  `content-filter` to `refusal` (was always `completed`), so the parent's settlement notice says
  "ran out of room before it finished" / "declined the task". `finish=error`/`error` map to
  `error`; cancellation still wins with `aborted`.
- Actionable `LocationNotFoundError` diagnostics: a child cwd the remote cannot see now reports
  "server <id> cannot see directory <dir>; configure pathMap …" instead of a bare HTTP 404
  (OpenCode creates the session first and rejects the prompt).

### Fixed

- Refused/failed prompts leaked a pending completion waiter: disposing or aborting afterwards
  produced an unhandled rejection (`opencode: aborted`) that could crash the host process after
  the run had already settled as an error. Every early-exit path now settles the waiter and marks
  the abandoned promises handled (`lib/delegate.js`).

### Changed

- `npm test` covers 56 cases (adds `test/provider.test.js` for finish/stopReason mapping and
  `test/routing.test.js` for routing policies, directory scoping, tie rotation and failover).
- `package.json`: version `0.3.0`.

### Verified

- Live routed provider across n100 + m65 (OpenCode 2.3.0): directory routing (`/tmp` → n100,
  `/home/yhuan` → m65), round-robin alternating (`n100 → m65 → n100 → m65`), failover from a dead
  endpoint to n100, and the missing-directory diagnostic.

## 0.2.0 (2026-11-20)

OpenCode 2 support, end to end. The plugin now speaks both OpenCode 1.18.x (v1 API) and
OpenCode 2.x (v2 API) from the same install; the 26 `opencode_*` tool names are unchanged and
v1 behaviour is preserved. Completes the phased plan in `docs/opencode-v2-migration.zh.md`
(phases 1–2 shipped earlier as transport + SSE/completion; this release adds the read-only
surface, prompts/delegation, permissions/forms, workspace/manage calls and tool semantics).

### Added

- OpenCode 2 read-only surface: `/api/info` health, `/api/project` (`canonical`), `/api/session`
  (`{data,cursor}`, `location.directory`, `?directory=` filtering), `/api/session/{id}/message`
  (`order=desc` fetched then presented oldest-first, `content[]` text/reasoning/tool parts),
  `/api/agent` (`id`/`name`/`mode`/`hidden`), `/api/session/active` and `/api/session/{id}/diff`;
  session info reports `outcome`/`cost`/`tokens` and no longer claims a todo list on v2.
- OpenCode 2 catalogs: providers and models from `/api/provider` + `/api/model` +
  `/api/model/default` (credentials never surfaced, disabled models hidden), commands (name and
  description only), skills (`path` instead of `location`), references, MCP status objects and
  session search through the list endpoint; `/experimental/tool/ids` is reported as unavailable.
- OpenCode 2 prompts and delegation: `{text,files:[{uri,name}]}` prompt bodies, directory in the
  create body (`location.directory`), agent/model applied as session state
  (`POST /api/session/{id}/agent|model`), completion from `session.execution.*` with the `idle`
  message outcome as the polling safety net, and `/api/session/{id}/interrupt` for aborts.
- OpenCode 2 workspace and session management: asynchronous shells (`POST /api/shell`, poll
  `/api/shell/{id}`, read `/api/shell/{id}/output`), `{location,data}` VCS status/diff with
  `mode=working|branch|committed` (`git`→`working`), raw `/api/fs/read/*` file reads,
  `/api/fs/find` path search, fork (`before`), compact in place of summarize, `init` as the
  built-in command and children through `GET /api/session?parentID=`.
- OpenCode 2 interactions: session-scoped permissions replied with `once|always|reject` and
  questions bridged as forms with typed fields (string/number/integer/boolean/multiselect),
  `{answer:{key:value}}` replies and `DELETE` dismissal; `form.created|replied|cancelled` map to
  the canonical question events so the SSE fast path and the polling fallback both work.
- `lib/http.js` helpers shared by the v2 branches: `apiVersionOf`, `unwrap`, `unwrapList`,
  `withLocation`, `opencodeValue` and `opencodeRaw` (raw `/api/fs/read/*` bodies).
- `test/v2-surface.test.js`: 8 offline tests over a fake v2 server (sessions/messages/agents,
  catalogs and secret redaction, workspace and async shell, manage calls, prompt bodies and
  agent/model session state, permission/form bridging, explicit unsupported paths).
- `scripts/e2e-live.mjs` (`npm run e2e`): live acceptance run against a real `opencode serve`,
  for v1 and v2, covering probe, read surface, delegation, follow-up, shell, workspace calls,
  fork/children/compact, abort and the version-specific unsupported paths; optional
  `OPC_LIVE_INTERACTIONS=1` exercises the approval/question bridges.
- CI: `.github/workflows/check.yml` runs `npm run check` on push to the main branches and on every
  pull request, with Node 22.
- `.gitattributes` (LF normalization, PNG/JPG binary, SVG text/eol=lf) and `.editorconfig`
  (UTF-8, LF, final newline, 2 spaces; Markdown keeps trailing whitespace).
- README facelift in both languages: centered shields badges (release, license, Node, dsh, CI),
  a positioning tagline, a quick start (install → configure → restart → verify), a table of
  contents, a Mermaid architecture diagram (browser → dsh origin → plugin → `opencode serve` plus
  the SSE `/global/event` direction), an ecosystem table, and a thematic grouping of the feature
  list.
- `docs/TOOLS.zh.md`: tool-by-tool reference for the 26 `opencode_*` tools — purpose, key
  parameters, read-only vs mutating, and the remote HTTP API each one uses.
- `docs/ARCHITECTURE.zh.md`: Chinese architecture companion (module map, data flows, design
  decisions, feature checklist) mirroring `ARCHITECTURE.md`.
- `test/http.test.js` (18 `node:test` cases) and `npm test`; `npm run check` now runs the offline
  smoke checks plus the transport tests.
- `lib/events.js`: one canonical event model for both wire formats, with version-split completion
  classification.
- `test/events.test.js`, `test/sse.test.js`, `test/completion.test.js`: v1/v2 event sequences,
  succeed/fail/interrupt endings, unknown-event forward compatibility, and version-aware SSE
  endpoints/auth (37 test cases in total).

### Changed

- `lib/sessions.js`, `lib/catalog.js`, `lib/delegate.js`, `lib/session-run.js`,
  `lib/interactions.js`, `lib/workspace.js`, `lib/manage.js`, `lib/routes.js` and `lib/tools.js`
  now branch on the detected API version and expose one normalized shape to routes/tools, so a
  single install aggregates v1 and v2 servers. Every version probe runs before a version-specific
  path is chosen (a fresh server is never assumed to be v1).
- Unsupported-on-v2 features fail loudly instead of returning empty data: `opencode_share`,
  `opencode_tools`, `opencode_find(kind=text)` and the `opencode_session_info` todo list return
  explicit "not available on OpenCode 2" messages; v1 keeps the old behaviour.
- `opencode_summarize` maps to v2 `compact` (the session's own model is used, so its `model`
  argument is optional on v2); `opencode_init` runs the built-in `init` command; `opencode_shell`
  runs asynchronously in the session workspace; `opencode_git_diff` accepts `committed` and maps
  `git` to v2's `working`.
- `package.json`: version `0.2.0`; the plugin is still not published to npm.
- `lib/http.js`: transport-level OpenCode API version support (Phase 1 of
  `docs/opencode-v2-migration.zh.md`). Servers default to `apiVersion: auto`, which probes
  `GET /api/info` with HTTP Basic auth and switches to `/api`-prefixed requests for OpenCode 2; a
  failed probe, missing password or 401 falls back to v1 with one recorded reason. 401, HTML/SPA
  bodies, non-JSON bodies, other non-2xx responses and network/timeout errors now raise
  `OpenCodeError` instead of returning `undefined`/empty data. The 26 `opencode_*` tool names are
  unchanged; event streaming, permissions/forms, directory scoping and the tool surface remain
  v1-only.
- `lib/config.js`: per-server `apiVersion` option (`auto` | `1` | `2`).
- `lib/sse.js`: subscribes to v1 `/global/event` or v2 `/api/event` (prefix + Basic auth) per
  detected version, consumes canonical events, and reports v2 completion from
  `session.execution.*` instead of `session.idle`. Interaction fallback polling is skipped on v2
  (session-scoped permission/form replies are Phase 3) and no longer leaves transport rejections
  unhandled.
- `lib/delegate.js`: completion kinds `failed`/`interrupted` now reject immediately instead of
  falling through to polling.
- `README.md` / `README.zh.md`: features regrouped by theme (subagent delegation, sessions and
  messages, catalogs and discovery, workspace and git, permissions and events, UI) without
  dropping any documented tool or capability; the documentation index points at the new Chinese
  docs.

## 0.1.0 (2026-11-06)

First milestone release (not published to npm).

### Added

- Multi-server OpenCode configuration (`servers` array) with aggregated discovery.
- Tools: `opencode_sessions`, `opencode_messages`, `opencode_agents`, `opencode_subagent`
  (agent/model/prompt-enforced `schema`, session continuation), `opencode_session_info`,
  `opencode_share`, `opencode_models`, `opencode_commands`, `opencode_skills`, `opencode_tools`,
  `opencode_references`, `opencode_command`, `opencode_shell`, `opencode_git_status`,
  `opencode_git_diff`, `opencode_read_file`, `opencode_find`, `opencode_fork`, `opencode_children`,
  `opencode_summarize`, `opencode_init`, `opencode_progress`, `opencode_search`, `opencode_mcp`,
  `opencode_abort`, `opencode_prompt`.
- Turn-by-turn remote session continuation (`opencode_prompt`, fire-and-forget or wait), so one
  remote worker session can be driven across dsh turns; both entry points share `lib/session-run.js`.
- Attachments via `opencode_subagent` `files` (data-URL file parts; text/* content is also inlined as a
  text part so the model actually sees it); session search (v2 + v1 fallback); MCP server status.
- Live run progress from SSE tool/step events (current tool, elapsed, output tail) exposed via
  `opencode_progress`, `GET /status` and `activeTool` in `GET /list`.
- Delegation completion is now event-driven (SSE `session.idle`) with a slow polling fallback.
- Native dsh subagent provider `opencode-<serverId>` (external out-of-process seam):
  parent-agent attribution for approval/question bridging, `prompt_async` + SSE idle wait,
  idempotent `dispose`, bounded diagnostics; see `docs/subagent-seam.md`.
- Shared session-run lifecycle (`lib/session-run.js`) used by both `opencode_subagent` and the
  native provider: same session creation, interaction tracking, async wait and abort handling.
- Permission requests bridged to dsh approval cards (`permission: ask|allow|reject`), question
  requests bridged to the dsh user-question UI, with polling fallback.
- Per-server SSE (`/global/event`) with reconnect; `/events`, `/status`, `live`/`running` state.
- `prompt_async` + message polling completion wait, falling back to the blocking prompt endpoint.
- Plugin page section "OpenCode Client" (servers, sessions, messages, create session, open UI).
- Embedded OpenCode Web UI as a right-sidebar tab type (`kind: opencode`): per-server selector + iframe of
  the real OpenCode client inside the current session page; opened from a server's "侧边栏打开" button or the
  sidebar add-tab guide. Full-screen overlay and new-tab remain as fallbacks.
- dsh plugin manifest compliance: `engines.dsh`, `dsh.manifestVersion`, bundle patch, client
  declaration, locale metadata, icon, LICENSE, README.zh.
- Offline smoke check: `npm run check` (`scripts/check.mjs`).

### Documentation

- `ARCHITECTURE.md` (module map, data flows, design decisions, feature checklist).
- `docs/subagent-seam.md` (dsh subagent provider contract and optimizations).
- `docs/chat-ui-proposal.md` (in-page remote-session chat proposal).
- README / README.zh documentation index, TODO refresh, compatibility matrix.

### Compatibility

- dsh `0.2.1-rc.2` (declared `>=0.2.1-rc.2`).
- OpenCode `1.18.10`, `1.18.31`, `1.18.33` (v1 HTTP API).

### Known limitations

- Structured output via `format=` is disabled (upstream message-read bug); prompt-enforced JSON only.
- Permission card / question forwarding need a tool-initiated run (a live dsh agent).
- OpenCode 2 and the v2 API are not integrated yet.
