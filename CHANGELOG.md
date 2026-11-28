## 1.3.0 (unreleased) — [delegate] 委派台账与失败原因

### Added

- **委派台账**（`lib/ledger.js`）：进程内有界环形缓冲（默认 200 行），两条委派路径
  （原生 `opencode-<id>` provider 与 `opencode_subagent` 工具）各记一行——server、任务、目录、模型、
  开始/结束时间、耗时、状态（ok / failed / aborted / running）与失败原因；**建会话就失败**也留痕。
  读取入口：`GET /api/opencode-client/delegations`（`?limit=&server=&status=`，`DELETE` 清空）、
  只读工具 `opencode_delegations`、设置页「委派台账」卡片（汇总 + 最近 5 条）。
- **失败原因带身份**：`session.execution.failed` 的 `{name,message,data}` 不再被压成一句
  "remote session failed"，而是透出为错误对象的 `opencodeName` / `code` / `data`；台账行新增
  `errorName` / `errorCode`，`opencode_delegations` 输出 `[Name · code]` 前缀。

- **单次委派的花费**：`session.step.ended` 的 `{tokens, cost}` 由 SSE 累加到 server 计数器
  （`lib/run-usage.js`），台账按「run 开始到结算的差值」记 `steps` / `tokens`（input/output/reasoning/
  cacheRead/cacheWrite）/ `cost`；`opencode_delegations` 输出 `$x` 或 `unpriced`，设置页行尾附成本。
- **父子委派关系**：台账行新增 `parent`（原生 provider 取 `request.parent.sessionId`，
  工具路径取 `exec.agent.sessionId`），能看出「谁派给谁」。
- **`outputSchema` 能力**：provider 现在广告 `outputSchema: true`——请求带 schema 时把约束追加到
  任务文本、用 `lib/structured.js` 本地校验，成功返回 `SubagentResult.structured`；不符合则结算为
  `error` 并带诊断，而不是把散文当结果交回去。

### Changed

- **结构化输出校验补齐**：`opencode_subagent` 的 `schema` 从「只查 required」扩展到
  `type`（含类型数组）/ `required` / `properties` / `items` / `enum`（递归）；未建模的关键字放行，
  避免因 caller 用了新关键字而误杀合法结果。
- abort 与 `finish=length|content-filter` 在台账里分别记成 `aborted` / `max-tokens` / `refusal`，
  与原生 provider 的 `stopReason` 口径一致。

## 1.2.0 (2026-11-28) — [packaging] npm 成为主安装通道

这一版没有改插件行为，改的是「怎么装、怎么发、仓库里写了什么」。走 minor 而不是 patch 的理由：
安装通道从 git 换成 npm，对使用者是可见的能力变化——`dsh plugin --profile web add dsh-opencode-client`
就能装，插件页的版本/更新区（只在 registry 安装时渲染）开始对普通用户生效。

### Changed

- **安装与更新统一走 npm**：包发布在 npm（`1.1.3` 起）、由 `v*` tag 触发 trusted publishing（OIDC）
  发布、tarball 带 provenance；git / 本地 checkout 仍作为开发通道保留。README 两版与
  `docs/INSTALL.zh.md` 的安装命令改为 npm 优先，`CONTRIBUTING.md` / `COMPATIBILITY.md` 里
  「git-only、`private`、永不发布 npm」的旧说法一并改正。

### Security

- **清掉仓库里的环境私有信息**：文档、脚本、测试里的内网地址、机器名与本机绝对路径统一替换成
  `server-a` / `server-b` / `/home/user`；`scripts/install-into-profile.sh`
  不再内置某台机器的默认地址（URL 参数改为必填）。`.gitignore` 补上 `.npmrc` / `*.pem` / `*.key` /
  `credentials*.yaml` / `*.tgz`。封面图里写死的 `v1.0.0` 去掉，避免版本号过期。
  说明：本次只清理当前树，**历史提交没有重写**（旧地址仍留在 git 历史里）。

### Docs

- **改正过期的发布说明**：`CONTRIBUTING.md` 与 `COMPATIBILITY.md` 还写着「git-only、`private`、永不发布 npm」，
  与实际（npm 主通道 + `v*` tag 触发 OIDC 发布）相反；`docs/INSTALL.zh.md` 头部停在 `v0.6.0` /
  `feat/opencode-v2-support` 分支，clone 示例与排障里的版本门槛同样过期。
- **`SECURITY.md` 支持版本**更新到 `1.2.x`；README 两版补 npm / publish 徽章，并在「更新」段落
  点明 npm 安装等同 registry 安装（走 DSH 原生更新流程）。
- **`package.json` 的 `description` 改为中英双语**：npm 包页与市场卡片在目录条目缺失时都读这个字段。
- **市场条目描述按上游规则重写**（`market/yhuan416__dsh-opencode-client.yml`）：单行、句号结尾、只说功能，
  补上「远端会话读取 / 委派」；含 `: ` 的英文描述加引号（否则 YAML 会把它当成嵌套键）。
  `market/README.md` 记录条目必须满足的形式规则，以及 npm 探测的最新状态。
- `check.yml` 注明检查用 Node 22、发布用 Node 24 的原因（最低支持版本 vs trusted publishing 需要 npm ≥ 11.5.1）。

## 1.1.4 (2026-11-28) — [ci] 发布改走 OIDC（Provenance）

### Changed

- **发布不再依赖长期 token**：包上配好 trusted publisher（GitHub Actions / `yhuan416/dsh-opencode-client` /
  `publish.yml`）之后，`v*` tag 触发的发布由 npm 用 OIDC 短令牌完成；工作流里的 `NODE_AUTH_TOKEN`
  只作为「包还没有 trusted publisher」时的兜底。从这一版起 npm 包页面带 **Provenance** 徽标，
  tarball 与 tag 的对应关系可由签名验证，仓库里不再需要长期写权限的 npm token。
- 这一版同时是整条 OIDC 链路的首次真机验证：推 tag → 门禁 → `npm publish --provenance` → 注册表；
  插件行为与 `1.1.3` 完全一致。

## 1.1.3 (2026-11-28) — [packaging] npm 发布成为主安装通道

### Changed

- **发布渠道从「git-only」改为 npm 优先**：1.0.0 定稿时写的是「git-only + annotated tag，不发布 npm」
  （`private: true`）。代价是每次安装都要 clone 仓库——大陆网络得走 gh-proxy，慢且容易失败；DSH 插件页
  的版本/更新区只在 `package.update === 'registry'` 时渲染，git / file: 安装永远看不到；市场目录里的
  `npm` / `version` / `downloads` 也一直是 `null`，卡片只能给 `github:` 安装命令。现在去掉 `private`，
  补 `publishConfig.access: public` 与 `keywords`，并把 `npm run check` 挂到 `prepublishOnly` ——
  即使有人手工 `npm publish`，四道门禁也会先跑。git / 本地 checkout 保留为开发与兜底通道。
- **新增 `.github/workflows/publish.yml`**：推 `v*` tag 时全量 checkout（门禁会用
  `git describe --exact-match --tags HEAD` 校验 tag 与版本一致）→ `npm ci` → `npm run check` →
  `npm pack --dry-run` → `npm publish --provenance --access public`；`workflow_dispatch` 默认只跑
  dry-run，要真发布得显式勾选。
- **清单门禁改口**：`scripts/check-manifest.mjs` 里那条「a plugin installed from git must not be
  npm-publishable」换成发布形态断言 —— 非 `private`、`publishConfig.access` 为 `public`、
  `prepublishOnly` 必须跑 `check`。

### Docs

- README 两版、`docs/INSTALL.zh.md`、`COMPATIBILITY.md` 的安装命令改为 npm 优先（本地 checkout /
  显式 git spec 作为第二通道），`TODO.md` 里「不发布 npm」的决策记录同步更正。

## 1.1.2 (2026-11-28) — [observe] 卡片系统统一、远端可编辑、权限诊断

### Added

- **权限请求可观测（[#57](https://github.com/yhuan416/dsh-opencode-client/issues/57)）**：权限桥接以前会自己答复
  大部分请求（宿主审批卡 / 配置的 mode / 无主会话挂起），从外部完全看不出「远端没问」还是「问了被静默批准」。
  新增 `lib/permissions.js`：按 server 记录请求次数与答复方式（用户批准 / 自动放行 / 拒绝 / 挂起，附最近
  20 条 action + resources），`/board` 的 server 对象新增 `permissions` 字段，看板远端卡在健康行显示
  「权限 N · 自动 M」（有自动放行时用告警色）；`ask` 模式下无审批卡可用而自动放行时会打 warn 日志。
- **已有远端可以在界面上修改**：设置区每行新增「编辑」——可改显示名（label）、地址（url）与新密码，
  留空的字段保持不变（尤其是密码：它从不回传到客户端，`POST /servers` 是整条替换，直接用它改名会把
  密码丢掉）。新增 `POST /api/opencode-client/servers/update`（按 id 合并 patch，url 强制 http(s)），
  客户端编辑卡片与「保存修改 / 取消」；保存后沿用原有重启 + 重新加载流程。

### Fixed

- **委派 prompt 失败时不再报 `promptFailureMessage is not defined`**（[#56](https://github.com/yhuan416/dsh-opencode-client/issues/56)）：
  `lib/run.js` 调用了 `delegate.js` 的 `promptFailureMessage` 却没导入，任何 prompt 阶段的失败
  （例如远端不存在的 `directory` 触发 `LocationNotFoundError`）都会被这个 `ReferenceError` 顶掉，
  看不到真实原因。现在正常抛出可诊断文案（提示 pathMap / 目录问题），并加静态断言防止再漏导入。

- **插件设置区整块消失（远端增删改查没了）**：卡片系统把「今日用量 / 近 7 天归因」包进 `asyncSlot`
  时用了即时求值的 `children`，`/usage` 还没回来时字符串拼接就解引用 `null` 的字段，渲染抛错 →
  宿主把整个设置 section 卸载，底部的「添加远端」与远端列表一起消失。`asyncSlot` 现在支持惰性
  `render()`，两个数据块改为惰性构造；并新增 `test/client-render.test.js`：用 stub React 渲染插件
  注册的 5 个界面（含数据仍在加载的状态），设置区必须仍有「添加远端 / 测试连接 / 保存」，看板必须
  有首帧骨架 —— 这类"渲染抛错导致区块消失"的回归以后会被测试拦住。

### Changed

- **一套卡片 token 覆盖所有面板**：会话卡、远端条、KPI 卡、洞察面板、30 天热力图、设置页的远端列表 /
  用量归因块 / 关于块，统一走 `cardSurface()`——圆角 12、1px `border-l1`、`bg-layer-1` 背景、
  12px 内边距、标题 13/600、元信息 12 次级色。此前是 10/12 圆角、9/10/12 内边距、透明与 layer-1
  背景混用，同一屏里能看出三种卡片气质。
- **可点卡片有统一的 hover / focus 反馈**：新增 `.dsh-oc-card` 样式（一次注入，观测台与设置页共用），
  背景在 `bg-layer-1 → bg-layer-2` 之间过渡，键盘聚焦显示 `focus-visible` 描边；未读 / 等待中卡片
  的 Tint 改为叠在 `bg-layer-1` 上而不是透明底。
- **会话卡固定高度 100 → 104px**（内边距统一到 12px 后按行高重算），网格等距、滚动不跳动；
  骨架卡同步为 104px，首帧与真实卡片同高。
- **设置页信息块收进卡片**：远端列表变成一个带分隔线的卡片，今日用量 / 近 7 天归因合到同一张信息卡，
  关于块也放进卡片（去掉它自己的顶部分隔线），页面标题与元信息字号对齐卡片系统。

### Verification

- `npm run check`：**179 项测试** + manifest gate（语法、manifest、单元、路由、客户端渲染冒烟）全绿。
- 客户端：新增 `test/client-render.test.js` —— 用 stub React/DOM 在 vm 里加载真实 client bundle，渲染插件
  注册的 5 个界面（数据仍在加载的初始状态），设置区必须含「添加远端 / 测试连接 / 保存」、看板必须是首帧骨架。
- 服务端：`POST /servers/update` 覆盖改名 + url 规范化、只改密码、空 patch 拒绝、`ftp://` 拒绝；
  `lib/permissions.js` 计数器/环形明细与 `/board.permissions` 字段均有单测。
- 运行时（本机 dsh-web，两台 OpenCode 2.4.2）：暖后 `/board` 2–4ms；卡片系统、设置区 CRUD、远端编辑、
  权限 chip 均在线上 bundle 校验通过（`cardSurface` / `startEdit` / `servers/update` / `lib/permissions.js`）。

## 1.1.1 (2026-11-28) — [observe] 观测台渐进填充、统一轮询、占位与滚动优化

> 主题：看板不再"整页等数据再挂载"，轮询收敛到一个调度器，所有异步块首帧占好尺寸；
> 服务端加 SWR + 启动预热，冷加载不再吃历史扫描。

### Changed

- **洞察区不再整块等待 `/insights`**：以前 `insights === null` 时整块洞察区不渲染、也没有骨架，
  数据回来才一次性挂载，skills（~3.5s）随后填充造成布局二次跳动。现在布局与骨架从首帧就渲染，
  卡片 / 柱状 / 30 天热力 / 技能各自独立填充（固定高度，CLS≈0），并带局部「载入中…」。
- **活跃度骨架按真实日历尺寸预留**：热力图骨架原先是一个灰色占位块，比真实 7 行日历矮，
  `/insights/activity` 到达时会把整个 top 行撑开；现在骨架直接画同样的 7×N 单元格网格
  （18px 格 + 3px 间距 + 月份表头 + 图例），数据替换时高度不变。下方 4 个列表面板也用
  8 行占位对齐 `insightRows` 的 186px 上限。
- **所有轮询收敛到一个调度器**：新增客户端 keyed 调度器（1s tick、优先级、并发上限 3、重任务串行、
  同 key in-flight 合并）；board 页、toast watcher、设置页的 `/board` 轮询合并为同一个 board store
  （5s 可见 / 15s 后台），insights / activity / skills / usage / upgrade 改为 keyed task；
  `visibilitychange` 只保留一个监听，回到页面时按到期 + 120ms 抖动补刷，不再 7 个请求一起打。
- **首屏请求分层**：board 与 insights/activity 立即发；usage / upgrade 延迟到首帧后（idle），
  skills 等 insights 到达后再以 heavy 任务启动；筛选变化通过 `AbortController` 取消在途请求。
- **看板中段 tick 不再全量采集**：`/board` 每 3 个 tick（15s）才 `refresh=1` 让远端重新采集，
  其余两跳 `refresh=0` 直接读宿主已有的 observation 快照（内存读）；配置变更 / 手动刷新仍强制全量。
- **快照去重，内容没变就不重渲染**：board store 按 payload 序列化结果判重，内容相同的轮询不再
  notify —— 空转的 5s tick 不再重渲染整页（"页面一直在动"的忙感来源之一）。
- **会话卡固定 100px 高度**：卡片内容本来就是单行/两行截断，高度实际恒定；固定后网格等距，
  滚动不会因为卡片高度自适应而抖动。曾用 `content-visibility` 跳过离屏卡的布局绘制，
  实测在滚动帧里反而逐帧触发布局，已改回普通渲染（见下条）。
- **滚动合成优化**：看板页滚动容器加 `will-change: scroll-position`、`overscroll-behavior: contain`、
  `contain: paint`，把滚动绘制限制在面板内、不扩散到宿主布局。

### Added

- **空闲会话折叠上限 12 张**：原来按「目录分组 × 每组 6 张」渲染，最多能出 50–70 张卡；现在折叠态
  全局最多 12 张，标题旁显示「展开更多（还有 N 个）」，点开后仍是完整列表。
- **离屏区块延迟建 DOM**：洞察区底部 4 个列表面板、空闲会话列表由 `LazyRender`
  （`IntersectionObserver`，提前 400px 预热）在接近视口时才真正创建；占位高度按真实面板高度预留
  （面板 235px、空闲每组 280px），挂载时不顶动上方内容。
- **头部「更新于 hh:mm · 刷新中…」**：独立的 1s 小组件按最近一次成功轮询的年龄推导刷新状态，
  只重渲染这一小段文字，不引入第二个 store。
- **可选的性能埋点**：`localStorage.setItem("dsh-oc-perf", "1")` + 刷新后记录
  `board-skeleton / board-ready / board-idle / insights-core / activity / skills` 时间点，
  用 `PerformanceObserver("longtask")` 收 >50ms 主线程阻塞、并在滚动期间采样 >20ms 帧间隔；
  控制台 `__dshOcPerf.dump()` 出表。默认关闭，正常访问零开销。
- **服务端 SWR + 启动预热 + single-flight**：`/insights`（60s）、`/insights/activity`（60s）、
  `/insights/skills`（600s）、`/usage`（60s）改为 stale-while-revalidate——过期后立即返回上一份
  数据（`stale: true` + `at`），后台只刷新一次；插件启动 8s 后在空闲窗口串行预热
  board / 7 天 insights / 30 天 activity，首个页面不再吃冷扫描。`collectStats` 增加 per-server
  in-flight 合并，insights / usage / 预热不会重复扫同一窗口。
- **历史天的活跃度永久缓存**：30 天热力按「server + 日期」缓存每日聚合，过去的日子在进程内不再
  重扫（只有今天 60s 短 TTL），per-day 并发从 4 提到 8。

### Fixed

- **占位符审计：所有异步块首帧即占好最终尺寸**：看板首帧不再只渲染一行「正在采集会话状态…」，
  而是按上次快照的结构（`localStorage` 只存分组/卡片数，不存数据）直接画出头部、洞察骨架、
  远端条与各分组占位；设置页的远端列表 / 今日用量 / 近 7 天归因、头部插件版本 chip 同样先占位
  （统一走 `asyncSlot`：loading / empty / error 三种状态等高），数据到达后不再撑开所在行或卡片。
- **远端卡片用量 / 健康 / top 模型拆成固定行高**：用量 chip（`25.1M in / 2.4M out · cache 2.20B`
  + 费用）在常规卡片宽度下会换行，和「重连 / API v1」提示、`top: 模型 $xx` 挤在同一个
  `flex-wrap` 行里，`/usage` 到达后整卡多一行。现在用量行预留两行（34px）、健康提示与 top 模型
  各占一行 16px，卡片首帧与数据到达后同高。
- **冷加载同时发 7+ 个请求、toast 与看板各自轮询 `/board`** 造成的首屏卡顿与刷新节奏不一致。

### Verification

- `npm run check`：173 项测试 + manifest gate（语法、manifest、单元、路由断言）全绿。
- 服务端（本机 dsh-web，两台 OpenCode 2.4.2，暖后）：`/board` 2–8ms、`/insights?days=7` 2–4ms、
  `/insights/activity?days=30` 2ms、`/usage` 2ms（冷 `/insights` 原 ~9s，预热后首个页面 ~0.6s）。
- 客户端埋点（`dsh-oc-perf=1`）：看板首帧从一行式 gate 变为骨架；挂载长任务 **95ms → 55ms**；
  看板空转 23s 内 **0 条 >50ms 长任务**；滚动期间原本 321ms 的尖峰消失。剩余 20–60ms 帧间隔经
  trace 归因为 GPU/合成侧（渲染主线程 15s 内 JS 仅 231ms），插件侧不再继续优化。

## 1.1.0 (2026-11-27) — [observe] 插件自身的版本 / 仓库 / 更新检查 + 看板与洞察修复

### Added

- **看板页与插件设置页显示插件自己的版本 / 仓库 / 更新状态**：DSH 内置的「版本」区只在 registry
  安装（`pkg.update === 'registry'`）时渲染，本插件是路径安装，详情页永远不会出现版本检查。
  现在宿主新增 `GET /api/opencode-client/about`：版本与仓库链接从本包 `package.json` 读，
  最新版本查 GitHub Releases（`/releases/latest`，没有 release 时回退 tags），成功缓存 24 小时、
  失败 1 小时；离线 / 限流只把检查区降级成「无法检查更新」，版本与仓库链接照常显示。
- 看板页头部新增 `vX.Y.Z` chip（点击打开 GitHub 仓库）；有新版本时变成「可更新 vY」并带提示点。
- 插件设置区底部新增「关于」块：版本、仓库、`已是最新版本` / `可更新到 vY` / `无法检查更新`、
  上次检查时间与「重新检查」。有新版本时提供「更新」——registry 安装交给 DSH 原生更新流程，
  路径安装打开 GitHub 发布页并显示本机 `git pull --ff-only` 命令。
- `plugins.detail.badge`：插件详情页标题旁显示「可更新 vY」标签（仅本插件页面）。

### Changed

- **无主会话的提问默认改为「挂起等待」**：没有 dsh run 的会话（例如你在 OpenCode TUI / Web 里
  自己开的）提问，以前默认被 dismiss（`question: reject`），远端 agent 收到的是 "The user
  dismissed this question"，看板「需要你」/ 通知 / 侧栏 badge 永远看不到它——这与通知功能的
  目的相反。现在默认 `question: ignore`：请求保持挂起，进入看板「需要你」并触发通知，你到
  会话里回答后由 SSE `form.replied` / pending 快照自动清卡；无人值守部署仍可显式配
  `question: reject` 恢复自动 dismiss。委派运行（有 owning run）转发 dsh 提问/审批卡的路径不变，
  权限审批默认 `ask` 也不变。

### Fixed

- **洞察三列溢出面板：右列被裁 + 整页横向滚动条**：`.dsh-oc-top` 三条轨道写死
  `minmax(360px/420px/300px)`，合计 1100px。插件页挂在宿主的 main slot 里，宽度由侧栏
  决定（窗口约 1400px 时面板只有 ~1000px），而旧断点 `@media(max-width:1100px)` 看的是
  视口，永远不触发 → 活跃度列被裁掉 133/300，日历只剩 3 个半周列，页面底部多出一条
  横向滚动条。现在改为容器查询（`.dsh-oc-insight{container-type:inline-size}`）+
  `minmax(0,fr)` 轨道：≥840px 三列、720–839 两列（活跃度跨满行）、<720 单列；卡片组
  1249px 以下切成 2×3，四宫格 1099px 以下 2×2，不再出现「3+1」孤儿（项目分布单独一行、
  右边两大块空）。
- **月份表头「10月11月」叠字**：表头按「月跨度 × 18px」算宽度，但 18px 装不下「10月」
  （≈24px），`overflow:visible` 直接压到下一个月。改成按周列逐格渲染，只有跨度 ≥2 周的
  月份才出标签（单周残月不再标），`paddingLeft` 18 → 19 与周列对齐；页脚补上日历自己的
  区间（`10/29 – 11/27`），因为卡片可能是 7 天而日历固定 30 天。
- **列表 184px 把第 9 行切成两半**：行高 18 + 间距 6，改取 8 行的整数倍 186px。
- **指标卡底部死白**：`grid-auto-rows:1fr` 把卡片拉到与图表同高后内容顶对齐，下面空
  ~30px；改成垂直居中。
- **模型名三行一模一样的省略号**：区分位在尾部（`#high` / `#max`），末尾省略正好吃掉；
  改成保留尾部 20 字符并挂 `title`。MCP / 技能的空态也改成垂直居中，不再顶着卡片上沿。
- **活跃度配色不跟主题**：热力格与柱状图原来是硬编码的四个深蓝 + `#4dabf7`，浅色主题下
  与周围 token 不一致；改为 `--dsw-alias-state-business-primary` + `color-mix` 分档。

- **删除会话后看板残留行**：远端会话被删除（或在插件未连着 SSE 时被删）后，行仍留在看板
  「空闲」里、`idleCount` 不降，直到插件重载。根因两条：SSE `session.deleted` 先 forget、下一轮
  刷新又用 10s 的旧快照把行 observe 回来；以及插件没连着 SSE 时根本收不到删除事件。
  现在：`session.deleted` 会让该 server 的会话快照失效（含 epoch，防止在途旧请求把快照写回）；
  `collectServer` 对同一 server 做 single-flight，避免并发刷新里「慢的旧列表后到」覆盖新状态；
  每次权威列表快照都会 `retain` 一次，把列表里已不存在的行清掉——只要还有 pending/running/后台任务证据
  的行就保留，列表请求开始后由 SSE 证明还活着的新会话受保护；会话数超过单页上限（500）时，
  只有「缺失且 `updatedAt` 晚于本页最旧一条」才允许裁剪（这种行若存在必然在本页，缺失即已删除），
  更旧的行可能只是翻到第 2 页，保留。一次可疑的空列表（此前有行、突然返回空）也不会立刻清空看板。
- **「等待回答」卡只显示 `form: Questions`**：v2 form 的问题正文在 `fields[].description`，
  以前只取 `title`（dock 头，固定是 "Questions"），卡片上看不出在问什么。根因是同一段文案在
  三个地方各写了一份（observation / interactions / pending 快照），后写的覆盖先写的；现在抽成
  `lib/pending-text.js` 单一实现，三处都调它，并过滤隐藏字段、优先真正的 question 文本。
  权限卡的文案也接了同一个 helper（不再是 interactions 独有的 `OpenCode bash (…)` 前缀）。
- **看板卡片行尾的 OpenCode `finish` 原始英文**：以前除 `stop` 外会原样拼上 `error` /
  `tool-calls` / `length` / `aborted`（用户在「未查看」卡上看到「… · error」不知所以）。现在收敛为
  中文 `出错` / `中断` / `超出长度` / `被拦截`，`stop` 与 `tool-calls` 不显示；真正的失败 outcome
  仍显示「失败」，且与 `出错` 不重复。
- **「读取中」吞掉失败**：`/about` 404/500/断网时卡片永远停在「正在读取版本信息…」；现在
  加载中 / 已加载 / 失败三态分开，失败显示「无法读取版本信息」，「重新检查」失败也在块内回写一行提示。
- **同一数据两套状态**：看板 chip、设置区块、详情页「可更新」标签各自 fetch，详情页冷加载打两次
  `/about`，点「重新检查」只刷新当前块；改为客户端单 store（一次加载、共享刷新）。
- **冷启动重复消耗 GitHub 匿名配额**：宿主没有 in-flight 合并，并发的两次 `/about` 会打两次 GitHub；
  现在并发请求共享同一个 Promise，`refresh=1` 跳过缓存但仍并入在途请求（实测并发 1 次请求）。
- **断网丢掉「可更新」提示**：失败现在保留上次成功检查的 `version`/`url` 并标 `stale`，
  页面显示「无法检查更新 · 上次已知 vX」而不是把提示区清空。
- **浅色主题 warn 文字对比度 ~2:1**：chip 与「可更新到 vY」改用 `color-mix` 加深（与看板「需要你」
  同一处理），色点继续用填充色。
- **更新入口与文案**：registry 安装在设置区不再放一个点了没反应的「更新」按钮（DSH 自己的「版本」区
  就在页面上方），路径安装显示可选中复制的 `git -C … pull --ff-only`，chip/按钮 title 与实际行为一致。
- **错误文案与边角**：限流（403/429）、网络错误、不可解析响应都转成中文原因；仓库 URL 用 `URL` 归一化
  （`.git`、`#fragment`、尾斜杠）；build metadata（`+sha`）在版本比较前剥掉，避免漏更新；
  「上次检查于」跨天时显示日期。
- **顺手修掉既有 bug**：设置页（`OpenCodePanel`）里 `setLatestOpenCode` 未定义，
  `/api/opencode-client/upgrade` 请求每轮抛 ReferenceError 并被 `.catch` 吞掉——是死代码，已删除。

### Notes

- **共享 OpenCode server 是共享状态**：同一 server 上的其它 dsh/OpenCode 客户端也能抢答
  form/权限请求；`question` 策略在各客户端保持一致，否则旧 `question: reject` 客户端会把
  本机挂起的问题先 dismiss 掉（README 已补充说明）。
- 检查是只读的：不写配置、不替用户执行 git 命令、不下载插件。
- 没有 `pluginManager` 服务（无 profile 启动）时省略安装来源，「更新」退化为发布页链接。
- 文档：设计文档、`COMPATIBILITY.md` 路由清单（补 `/about`）、`ARCHITECTURE.md` 模块树（补
  `lib/about.js`）、README 双语同步。

### Verification

- **门禁**：`npm run check` 168 tests 全绿（含 `scripts/check.mjs` 防回退断言与 `manifest` gate），CI 绿。
- **洞察布局**：无头 Firefox（geckodriver 0.37.1）驱动真实 CSS 的结构 fixture，1004 / 1100 / 1280 /
  1400 / 960 / 840 / 800 / 720 / 700 九个宽度实测——`scrollWidth == clientWidth`（无横向溢出）、
  活跃度面板始终在 section 内、卡片副标题 0 处截断、技能列表 0 个半行、四宫格 2×2（≥1100 时 4 连排）；
  截图确认三档布局。
- **看板修复（真机）**：重启 dsh-web 后，删除会话 **1s** 内从看板消失（`stale_present=0`，无需重载插件）；
  触发 question → 等待回答卡的 detail 为「state-test：是否继续？」（不再是 `form: Questions`）；
  在会话里回答后 **1s** 自动清卡。日志：`/tmp/verify-board-fixes.log`。
- **About / 更新检查**：`GET /api/opencode-client/about` 返回 200；路径安装下只展示版本 / 仓库 / 发布页，
  GitHub Releases 检查在离线、限流、404 时降级为「无法检查更新」。

## 1.0.1 (2026-11-27) — [observe] 看板状态色

### Fixed

- **「刚完成 · 未查看」的卡片和「空闲」一模一样**：未查看的行本身 `status: idle`，而卡片颜色全部来自
  `STATUS_META[status]`，于是它被画成灰条 + 灰点 + 灰字，卡片上还写着「空闲 · 完成于 3 分钟前」——
  状态与语义自相矛盾，混在几百张空闲卡里根本看不出来。现在颜色挂在 `row.unread` 上：DSH 的
  `--dsw-alias-state-done-primary`（浅色 violet-600 / 深色 violet-400）+ `color-mix` 的 9% 淡底、
  45% 描边、3px 实心左条，第三行文案改成紫色加粗的「未查看」。**不能**改 `STATUS_META.idle`——
  那会把整片空闲区一起染色。
- **「需要你」只有一根 3px 琥珀条**：补琥珀 10% 淡底 + 45% 描边 + 琥珀加粗状态词，让它在块面上
  仍是最高优先级（此前「未查看」有底有框，扫视时反而更抢眼）。
- **浅色主题**：未查看描边/底色降到 28%/7%（45% 会被读成焦点框），琥珀状态词压暗到 60%
  （4.56:1；DSH 的 amber-500 压在白系底上只有 2.15:1）。两处都走 CSS 变量，深色主题保持原比例。

### Changed

- **状态色不再硬编码 hex**：等待 / 运行中 / 后台 / 出错 / 未查看 / 空闲统一走
  `--dsw-alias-state-{warn,success,business,error,done}-primary` 与 `--dsw-alias-label-tertiary`
  （空闲用 label-tertiary 而不是 `state-idle-primary`——后者是填充色，浅色下当 3px 线条会消失）。
  蓝 / 红 / 紫 / 灰随主题切换；amber / green 在 DSH 里两主题同值，浅色沿用宿主取值。左栏徽标、
  完成 toast、服务器概览的运行/后台/待办/升级提示、机器 chip、空闲分组头、洞察「部分数据不可用」
  同步收敛。图表色阶（steps 柱状、活跃度热力图）保持原样：那是数据可视化 ramp，不是状态语义色。
- **`muted` 语义**：卡片详情行的降级灰改由 `meta.muted` 决定，不再靠 `meta.color === "#8a8a8a"`
  这种字符串比较（换成 token 后它必然失效）。
- **命名与比例归一**：卡片主题变量统一 `--dsh-oc-*` 前缀（与面板既有的 `.dsh-oc-*` 类名一致）；
  「需要你」的描边/底色也从硬编码比例改走变量，与未查看同构——以后按主题调档只改 CSS，不必动 JS。

### Docs

- **仓库展示与市场投稿**：补齐 GitHub 社区健康文件（Code of Conduct / Security / Contributing）、
  180px 插件市场图标；增加 dshmarket 投稿条目与说明，市场分类改为 tools（对齐 OpenCode
  工具/子代理类插件）。

### Verification

- **真机**（无头 Firefox + WebDriver BiDi 驱动真实 dsh-web，未重启服务）：深 / 浅两主题截图，
  未查看卡 computed `borderTop` / `background` 为 `0.45/0.09`（深）与 `0.28/0.07`（浅），
  `color-mix` 落到像素、console 0 error；「需要你」卡底色为琥珀 10%、状态词 `rgb(245,158,11)`、
  字重 600。
- **门禁**：`scripts/check.mjs` 新增五条防回退断言（四正一负）——状态色必须全部在 token 上
  （负向：不允许出现 `color: "#hex"`）、未查看比例必须走 `--dsh-oc-unread-*` 变量且带浅色覆盖、
  琥珀文字必须走 `--dsh-oc-wait-ink`；131 测试全绿。

## 1.0.0 (2026-11-27) — [core] v1 下线 + client 迁移（breaking）

> 本版本包含未单独发版的 0.8.0（观测可信度）与 0.9.0（洞察/活跃度）变更，见下方章节。

### Changed

- **入口收敛**：去掉会话头的「OpenCode」按钮和右侧栏 `opencode` 标签页；统一从左侧栏
  `OpenCode` 入口进看板，服务器行/看板卡片仍可打开内嵌 UI。插件注入的客户端包从 5 个减到 3 个
  （`chat` / `sidebar` / `plugin-manager`）。
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
- **测试**：v1 用例删除或改为 v2 only；131 个测试全绿（+ SSE 补种/activity）。
- **仓库展示**：README 增加封面与真实看板/洞察截图（`docs/assets/`）。

### Verification

- 真机 server-b / server-a（OpenCode 2.4.2）：目录归因与 stats **delta=0、partial=false**；技能 7 天
  72 次 / 30 天 151 次；部署自检 usage / board / insights / MCP+skills / upgrade 全 **PASS**。

### Migration

- 将 OpenCode 升级到 2.4.x；把 1.x server 从插件配置中移除。
- `apiVersion: 1` 配置会被当作 auto 并拒绝；改成 `auto` 或 `2`。
- 发布方式：git-only + annotated tag `v1.0.0`，不发布 npm。

## 0.9.0 (included in 1.0.0) — [observe] 洞察

### Added

- **看板页顶部洞察区**：看板页（`main` 槽，全宽）最上方直接展示近 7 天洞察，不做 tab；
  空闲会话列表压到页面底部（每组默认 6 个 + 展开更多）。0.9.0 初版为 8 张概览卡；
  1.0.0 收敛为 6 张（会话、Tokens、费用、缓存命中率、工具调用、活跃天数），与
  steps 柱状图、30 天活跃度同排。近 7 天 steps 柱状（缺日补 0）、模型 Top5、工具 Top8、
  项目 Top8，以及口径脚注。
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
- **独立活跃度热力图**：固定 **30 天**、与 7/30 天洞察窗口解耦；与 6 张卡和 steps 柱状图同排
  （参考 context-insight 布局），GitHub 风格周列 + 月份标签，可切换 **会话 / Token消耗** 两种口径。数据来自新增 `GET /api/opencode-client/insights/activity`
  （每台 server 每天一次 `session/stats`，并发 4、10 分钟缓存；30 天首算约 1.9s，缓存后即时）。
  热力图按所选指标分 4 档色阶，tooltip 同时给会话/Tokens/steps；默认 Token消耗。
- **7 / 30 天切换**：洞察区时间窗可切换（默认 7 天，选择记入 localStorage）；
  MCP 在 7 天窗口为 0，切 30 天即可看到分布。
- **可升级提示**：server 卡片版本旁显示 `→ v2.4.2`。本地 API 没有「查最新版本」端点——
  `/api/info` 只有当前版本，`installation.update-available` 是易失 SSE（断线即丢），
  因此查官方更新服务 `https://opencode.ai/update/api/latest/cli/npm`（`opencode upgrade` 同源），
  **启动时查一次、之后每天一次**（服务端成功缓存 24 小时、失败 1 小时后重试），
  失败静默无徽标；`GET /api/opencode-client/upgrade`。
- **测试**：`test/insights.test.js` 5 项 + `test/skills.test.js` 5 项（窗口汇总/activity 补 0/
  项目计数、单台失败隔离、summary/detail 缓存不串、MCP 拆分、days 窗口、技能名聚合、
  旧 `input.name` 兼容、页数上限 truncation、缓存、v1 不支持、路由）；合计 119 → 133（另加 `test/version.test.js` 4 项）；1.0.0 删除 v1 用例后当前为 131。

### Notes

- 明确不做（数据不可得，不伪造）：逐日 token/费用、token 构成、耗时拆解、活跃时长、
  技能/命令明细。脚注已写明「费用仅含报价模型 · 日图仅 steps」。
- **OpenCode 2.4.2 验收（2026-11-27）**：server-b / server-a 两台 server 从 2.3.0 升到 2.4.2，
  `npm run e2e` 两台各 10/10 通过；`/openapi.json` 对比为纯增量，本插件读取的
  endpoint / event / payload 无删除（详见 `COMPATIBILITY.md`「2.4.x deltas」）。
  升级中踩到并已修掉：2.4.0 把 MCP `protocol` 默认值从 `legacy` 改成 `auto`，只提供
  `2026-07-28` 的 stdio server（server-a `dev-tools`）会因探测超时回退 legacy 而连接失败，
  需在 **v2 形态** `mcp.servers.<name>` 里写 `"protocol": "2026-07-28"`（v1 形态
  `mcp.<name>` 会静默丢掉该字段）；另注意重启后首次读取 model/skill/mcp 清单可能为空。

## 0.8.0 (included in 1.0.0) — [observe] 可信度

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
  都带命令与已跑时长。实测 server-a/server-b：一条 `jira_weekly_report.py` 后台跑了 9+ 分钟，期间会话所有
  常规信号都说空闲——这是唯一能看见它的信号。只有 OpenCode 的后台 job 机制可见；agent 里
  `nohup … &` 直接脱离 job 的进程仍然看不见。v1 明确不支持（接口缺失时静默降级，不影响看板）。
- **成本归因**：
  - `summarizeStats` 透出服务端权威的 per-model 归因（`models[]`：`model`/`steps`/`tokens`/`cost`，
    按成本降序、上限 10）；`opencode_usage` 工具每台 server 追加 `models:` 前三条。
  - 新 `collectCostByDirectory()`：按目录汇总**窗口内**成本。OpenCode 没有按目录聚合的端点，
    而 `session.cost` 是**终生累计**，所以改为累加窗口内 `assistant` 消息的 `cost`（与 `/experimental/session/stats` 同一数据源；
    compaction 消息也带成本，但 stats 与 `session.cost` 都不计它，计入会让目录与总成本对不上——
    server-b 上一条 $0.444 的 compaction 就会让偏差到 0.45%）；活跃判定用 `time.busy`（只有真跑过的会话才有），
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
    **为什么不只用远端标记**（实测修正）：server-b 180 个会话里 10 个、server-a 339 个里 1 个根本没
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
- 空闲会话数量大（server-a+server-b 约 480，含大量 `dsh delegate` / `dsh subagent:` 机器会话），
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

- Live on server-a (OpenCode 2.3.0): session rows show
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

- Live on server-a (OpenCode 2.3.0): a session created with
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

- Live on server-a (OpenCode 2.3.0): delegating with
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

- Live on server-a (OpenCode 2.3.0): content search returned `./a.txt:1: alpha needle here` (2 hits);
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

- Live routed provider across server-a + server-b (OpenCode 2.3.0): directory routing (`/tmp` → server-a,
  `/home/user` → server-b), round-robin alternating (`server-a → server-b → server-a → server-b`), failover from a dead
  endpoint to server-a, and the missing-directory diagnostic.

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
