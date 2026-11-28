# 安装到另一台机器（含 Windows / Desktop）

> 面向「想在第二台机器（比如 PC）上装这个插件」的场景。目标：左栏出现 **OpenCode**
> 卡片看板，并且会话里能用 `opencode_board` 工具。
>
> 版本：1.1.x · 分支 `master`（每个 npm 版本对应一个 `v*` tag；只想要现成插件的话，
> 走 [3a npm 安装](#3a-npm推荐无需-clone)，不需要 clone）

## 0. 前置条件

| 项 | 要求 |
|---|---|
| dsh | ≥ 0.2.1-rc.2（本机验证 0.2.2-rc.5） |
| Node | ≥ 22（dsh 自带，不需要单独装） |
| 网络 | 能直连目标 `opencode serve`，如 `http://192.168.4.50:4096`、`http://192.168.4.65:4096` |
| 凭据 | OpenCode 2.x 需要 `OPENCODE_SERVER_PASSWORD`；在该机器的 `~/.config/opencode/server.env` 里 |

先验证网络（**401 = 通了**，`000` 才是没通）：

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.4.50:4096/api/info
```

## 1. 拿代码

> 只想用、不改代码：**跳过本节**，直接看 [3a npm 安装](#3a-npm推荐无需-clone)。clone 只在你需要
> 改代码、或用脚本软链进 profile 时才需要。

```sh
git clone https://github.com/yhuan416/dsh-opencode-client
# 想固定在某个版本上就加 tag（把 v1.1.4 换成你要的）：git clone --branch v1.1.4 --depth 1 <同一地址>
```

插件是纯 JS、无构建步骤，clone 下来就能用。

## 2. 确认要装进哪个 profile

| 你的 dsh 是怎么跑的 | profile |
|---|---|
| Desktop 应用 | `desktop`（保留 profile，用官方启动器管理） |
| 自己跑 `dsh web` | `web` |

```sh
dsh plugin --profile web list      # 看现有插件
```

## 3. 安装

### 3a. npm（推荐，无需 clone）

```sh
dsh plugin --profile web add dsh-opencode-client
```

`add` 只加依赖，**bundle 仍然要自己选上**（见 3c 的 `bundles` 片段）。npm 安装还有一个好处：
插件设置区「关于」里的版本/更新走 DSH 原生 registry 流程（git / 本地路径安装只能打开 release 页）。

### 3b. Linux / macOS（脚本）

```sh
cd dsh-opencode-client
OPENCODE_SERVER_PASSWORD='<密码>' bash scripts/install-into-profile.sh http://192.168.4.50:4096 n100
```

脚本会：软链到 profile、写 dependency、**把插件选为 bundle**、追加一段 `opencode-client`
配置（带密码、`permission: ask`），并在写文件前备份 `package.json` / `cordis.patch.yml`。

### 3c. Windows / 手动

```powershell
# npm 安装（推荐，不用 clone）
dsh plugin --profile web add dsh-opencode-client

# 或者指向本地 checkout
dsh plugin --profile web add D:\dev\dsh-opencode-client
```

`add` 只加依赖，**bundle 必须自己选上**。编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-opencode-client"
] } }
```

保留原有条目，只追加 `dsh-opencode-client`。

## 4. 配置 server

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`（Linux：`~/.dsh/profiles/web/`），
把下面这段追加到末尾：

```yaml
- id: opencode-client
  name: dsh-opencode-client
  config:
    servers:
      - id: n100
        label: n100 opencode
        url: http://192.168.4.50:4096
        password: <OPENCODE_SERVER_PASSWORD>
      - id: e5
        label: e5 opencode
        url: http://192.168.4.65:4096
        password: <同一个密码>
    # ask：无 dsh run 归属的权限请求只登记为「需要你」，不替你批准
    # 想恢复旧的自动批准行为，改成 auto
    permission: ask
```

要点：

- **缩进只能是空格**，不能是 Tab；
- `password` 在 OpenCode 2.x 上是**必须的**，缺了会以 401 提示失败并显示 offline；
- 想自动批准所有权限（旧行为）就写 `permission: auto`；
- 想让 OpenCode 的表单/提问也进「需要你」，加一行 `question: ignore`（默认 `reject` 会自动取消表单）。

## 5. 重启

插件的 **bundle 组合在启动时求值**，所以装完必须重启：

```sh
# Linux
systemctl --user restart dsh-web.service

# Windows / Desktop
# 退出并重新打开 Desktop 应用；或重启你跑的 dsh web
```

> 之后只改 `cordis.patch.yml` 里的配置（加 server、改密码）**不需要重启**，dsh 会热重载；
> 但改插件前端代码（`lib/client.js`）必须重启。

## 6. 验收

1. **左栏出现 OpenCode**，点开是卡片看板（不是内嵌网页），顶部有「需要你 / 运行中 / 空闲」统计；
2. 点一张卡片 → 浮层里打开该会话，顶栏「关闭 (Esc)」可用；
3. 新开一个会话，问：「**用 opencode_board 看现在谁在跑**」→ 应返回 needs you / running / idle 三段文本；
4. 命令行核对（把 token 换成日志里那个）：

```sh
curl -s "http://<host>:3080/api/opencode-client/board" | head -c 300
```

`servers[].apiVersion` 应该是 `"2"`，`live` 应该是 `true`。

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡片页一直「正在采集会话状态…」 | 路由没注册（bundle 没选上） | 检查 `package.json` 的 `dsh.profile.bundles` |
| `apiVersion: "1"` + `state: offline` | 没配 `password` | 补上密码；`curl -u "opencode:<密码>" http://host:4096/api/info` 自测 |
| 点卡片没反应 | 深链算不出来 | 打开浏览器控制台看 `opencode board: no deep link` 警告 |
| 浮层里报 `Unrecognised route!` | 深链格式旧 | 必须 `/server/<base64url(origin)>/session/<id>`；该格式自 v0.6.0 固定，升级到当前版本即可 |
| 改了 `client.js` 但页面没变 | 前端不走热重载 | 重启 dsh |
| 浮层里要登录 / Esc 无效 | iframe 跨域 | 已知限制，见 CHANGELOG「已知限制」 |
| YAML 解析失败 | 用了 Tab 或缩进不齐 | 全部改成空格，缩进层级对齐上面的示例 |

## 8. 卸载 / 回滚

```sh
dsh plugin --profile web remove dsh-opencode-client
```

再从 `package.json` 的 `bundles` 里删掉 `dsh-opencode-client`，并删掉 `cordis.patch.yml` 里
那段 `- id: opencode-client`。或者直接用安装脚本生成的备份还原：

```
~/.dsh/profiles/web/package.json.bak-<时间戳>
~/.dsh/profiles/web/cordis.patch.yml.bak-<时间戳>
```

重启 dsh 即恢复原状。