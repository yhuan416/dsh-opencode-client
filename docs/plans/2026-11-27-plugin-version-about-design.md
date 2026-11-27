# 插件自身版本 / 仓库 / 更新检查 —— 设计（2026-11-27）

> 需求：OpenCode 看板页和插件设置页直接展示**插件自己的版本号 + GitHub 仓库链接 + 版本更新检查**，
> 交互参考 dsh-context 在 DSH 插件详情页里的「版本」区（已是最新版本 / 可更新 / 重新检查）。
> 结论：DSH 内置版本区不适用于本插件，必须插件自己实现；本文是实现依据。

## 1. 根因（为什么不能复用 DSH 内置能力）

DSH 插件详情页的「版本 / 来源信息」由 `@deepseek-ai/dsh-client-ui-plugin-manager` 渲染，
版本区是否出现只取决于安装源：

```
listsVersions = pkg.update === 'registry'          // versions.tsx
```

本插件在本机是 profile 依赖 `file:/home/yhuan/workspace/gitlab/dsh-opencode-client`
（`plugin_manager list_bundles` 实测：`version: 1.0.0`，无 `update` 字段），
因此详情页只有 DSH 自己生成的「来源信息（代码来源 file:… / 当前版本 1.0.0）」，
**没有版本检查，也无法通过配置开启**。要显示 GitHub 链接与更新状态，只能插件自己画。

## 2. 目标与非目标

**目标（v1）**

- 看板页（`main` 槽，左栏 OpenCode 页）头部：紧凑的 `v1.0.0` 版本 chip，点击打开 GitHub 仓库
- 插件设置区（`plugins.detail.section` 里已有的 OpenCode 设置页）底部：「关于」块
  —— 版本、仓库链接、版本检查状态、上次检查时间、重新检查
- 检测到新版本时出现**可更新到 vX** 的提示与「更新」入口（动作见 §6）
- 检查失败/断网只降级检查区，不影响版本号与仓库链接

**非目标**

- 不把插件发布到 npm、不切换安装源（那只解决 DSH 详情页的内置区，不解决看板页）
- 不做自更新（不替用户 `git pull`、不改运行中的插件文件）
- 不做 i18n 重构（本插件客户端 UI 现有文案均为中文，本次保持一致）
- 不做「本机检出落后 origin N 个提交」这类开发态信息（后续可加，见 §9）

## 3. 事实与可复用件

| 事实 | 值 |
|---|---|
| 插件版本 | [package.json](../../package.json) `version: 1.0.0`（唯一事实源） |
| 仓库 | `https://github.com/yhuan416/dsh-opencode-client`（公开） |
| 发布方式 | GitHub Releases（最新 `v1.0.0`，`published_at: 2026-11-27T11:18:37Z`） |
| 版本接口 | GitHub REST `/repos/{owner}/{repo}/releases/latest`，匿名 60 次/小时/IP，实测可达 |
| 安装源 | `file:/…/dsh-opencode-client`（path 安装，DSH 侧无 update 能力） |

复用：

- [lib/version.js](../../lib/version.js)：`compareVersions()`（pre-release 语义）、
  `latestVersion()` 的「成功缓存 24h / 失败缓存 1h」模式
- [lib/routes.js](../../lib/routes.js)：`GET /api/opencode-client/upgrade` 的「宿主代取 + 缓存 + 降级」模板
- [lib/client.js](../../lib/client.js)：`TONE` / `styles` 主题 token、`fetch('/api/opencode-client/…')` 模式、
  已注册的 `plugins.detail.section`（`RemoteSection`，order 60，仅本包页面渲染）

## 4. 宿主：`lib/about.js` + 一条路由

`GET /api/opencode-client/about`（`?refresh=1` 绕过缓存强制重查）

```jsonc
{
  "ok": true,
  "plugin": {
    "name": "dsh-opencode-client",
    "version": "1.0.0",
    "repository": "https://github.com/yhuan416/dsh-opencode-client",
    "license": "MIT"
  },
  "install": { "source": "file:/home/yhuan/workspace/gitlab/dsh-opencode-client", "update": null },
  "latest": {
    "status": "latest",            // latest | update-available | unavailable
    "version": "1.0.0",
    "url": "https://github.com/yhuan416/dsh-opencode-client/releases/tag/v1.0.0",
    "publishedAt": "2026-11-27T11:18:37Z",
    "checkedAt": 1764260000000,
    "error": "…"                   // 仅 status=unavailable
  }
}
```

实现要点：

- **版本/仓库**：`new URL('../package.json', import.meta.url)` 读取本包 package.json（ESM 下可用，
  兼容 pnpm 软链到工作区真实路径）；仓库 URL 归一化 `git+https://…git` / `git@github.com:…` → https。
- **安装信息**：`ctx.get('pluginManager')?.listBundles()` 找自己 → `{ source, update }`；
  服务不存在时省略 `install`，不阻塞其余字段。
- **最新版本**：`GET …/releases/latest`（`accept: application/vnd.github+json`、
  `user-agent: dsh-opencode-client`）；无 release（404）回退 `/tags?per_page=1`；
  用 `compareVersions(latest, current)` 判定 `update-available`；成功缓存 24h、失败 1h。
- **降级**：网络/解析失败 → `status: 'unavailable'` + `error`，HTTP 仍 200（前端好渲染）。
- 依赖注入与 `versionSource` 同款：`createRoutes({ aboutSource })`，测试可注入 fake fetch。

## 5. 客户端：两块 UI

**看板页头部**（`OpenCode 会话` 行，右侧「更新于 HH:MM」旁）

- 常态：`v1.0.0` chip（`title` 显示仓库 URL，点击新标签打开仓库）
- 可更新：`v1.0.0 · 可更新 v1.1.0`（warn/info 色点，点击触发 §6 动作）
- 检查失败/未检查：只显示 `v1.0.0`，不报错、不加红点

**插件设置区底部「关于」块**（语言与 dsh-context 截图的版本区对齐）

```
关于 dsh-opencode-client
版本      v1.0.0
仓库      https://github.com/yhuan416/dsh-opencode-client ↗
版本检查  ✓ 已是最新版本 · 上次检查于 20:47          [重新检查]
          ⬆ 可更新到 v1.1.0（发布于 2026-11-27）      [重新检查] [更新]
          ⚠ 无法连接 GitHub · 重试                    [重新检查]
```

- 数据获取：挂载时 `GET /about` 一次；「重新检查」→ `GET /about?refresh=1`；
  不接看板的 15s 轮询，避免额外流量。
- 样式只用 `--dsw-alias-*` 主题 token，手写控件（不引 `dsh-client-ui-primitives`，遵循 DSH practices）；
  配色沿用现有 `TONE`（成功/警告/错误）。
- 可选低成本增强（建议同批）：`plugins.detail.badge` 在插件标题旁加「可更新」标签。

## 6. 「更新」动作（已定：引导式 A）

- 若 `install.update === 'registry'`（或 DSH 侧确有更新目标）：按钮 → `pluginNavigation.openBundle('dsh-opencode-client')`，
  跳到 DSH 插件页用原生更新流程（本插件已用该服务实现「插件设置」跳转）。
- 否则（含当前 `file:` 安装）：按钮 → 新标签打开发布页；
  并在设置区显示本机更新命令（`git -C <插件目录> pull --ff-only`，只展示/可复制，不执行）。
- 不实现宿主 `git pull`、不调用插件管理器 `updateBundle` 远程方法（权限与失败面都不可控）。

## 7. 错误与边界

- GitHub 限流/网络失败：`unavailable` 降级 + 保留上次成功的 `version/url`（有缓存时），页面不空。
- 仓库 URL 解析失败：隐藏仓库行，其余正常。
- pre-release：`releases/latest` 天然排除预发布；当前版本是预发布时用 `compareVersions` 正确排序（预发布 < 正式）。
- 宿主无 `pluginManager` 服务（无 profile 启动）：省略 `install`，「更新」退化为发布页链接。
- 插件停用/卸载：无持久化写入，无副作用。

## 8. 影响文件与测试

| 文件 | 改动 |
|---|---|
| `lib/about.js`（新） | 读包信息、URL 归一化、GitHub release 探测、缓存 |
| `lib/routes.js` | 新增 `GET /api/opencode-client/about`（约 25 行） |
| `lib/index.js` | 组装 about 依赖并传入 `createRoutes` |
| `lib/client.js` | `useAbout()` + 看板 chip + 「关于」块 + 可选 badge（约 150 行） |
| `test/about.test.js`（新） | fake fetch：release 解析、tag 回退、预发布排序、缓存 TTL、失败降级、路由 payload |
| `scripts/check.mjs` | 客户端字符串断言（版本 chip / 关于块 / 仓库链接存在） |
| `README.md`、`README.zh.md`、`CHANGELOG.md` | 功能说明与变更记录 |

验证：

1. `npm run check`（语法 + 单元 + manifest）
2. `curl 'http://127.0.0.1:3080/api/opencode-client/about'` 与 `?refresh=1`
3. 刷新 DSH 页面：看板 chip、设置区「关于」块、浅/深主题、窄宽、断网降级、重新检查

## 9. 后续可选

- 开发态信息：宿主读 git（`git describe` / `HEAD..@{u}`），在「关于」块显示分支/commit/落后提交数
- 当插件改为 npm 发布后，`install.update === 'registry'` 分支自动变成真正的一键更新（DSH 原生）
## 10. 实现状态（2026-11-27）

已实现，分支/工作区：`feat/plugin-about`（`git worktree` 于 `.worktrees/plugin-about`，从 `master` 迁出并 rebase 到 449e7f4，含 PR #50）。

- [lib/about.js](../../lib/about.js)：包信息、仓库 URL 归一化、GitHub Releases 检查（tags 回退）、24h/1h 缓存
- [lib/routes.js](../../lib/routes.js)：`GET /api/opencode-client/about`（`refresh=1` 绕过缓存）
- [lib/index.js](../../lib/index.js)：组装 `createAbout`（`pluginManager.listBundles` 取安装来源）
- [lib/client.js](../../lib/client.js)：`useAbout()`、看板 header chip、设置区「关于」块、`plugins.detail.badge`
- [test/about.test.js](../../test/about.test.js)：14 条离线测试；`scripts/check.mjs` 增加客户端接线断言
- `npm run check` 全绿（145 条测试）；`createAbout()` 对本机真实 GitHub 实测返回 v1.0.1 / status=latest
- 未做：浏览器内视觉验证（运行中的 dsh 从主 checkout 加载插件，工作区未接入 profile），见 §8 验证清单
