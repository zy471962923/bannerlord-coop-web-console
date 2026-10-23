# Bannerlord Coop 服务器 Web 控制台

![version](https://img.shields.io/badge/version-1.0.0-blue)
![platform](https://img.shields.io/badge/platform-Windows%2064--bit-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

[Bannerlord Coop](https://github.com/Bannerlord-Coop-Team/BannerlordCoop) 专用服务器的浏览器运维面板：
实时日志、TUI 镜像、玩家档案（装备 / 部队 / 技能）、全图玩家位置、起停服务器、存档备份、命令台、更新日志。

零前端框架、零构建步骤，唯一外部依赖是 `node-pty`。

![玩家档案](docs/shots/03-players.png)

![全图玩家位置](docs/shots/04-map.png)

## 快速开始

**用现成的包**：下载 [Releases](../../releases) 里的 zip，解压 → 双击 `start-console.bat` → 浏览器打开
**http://127.0.0.1:7788**。zip 里已经带了 Node 运行时，不需要安装任何东西。

**从源码跑**（需要 Node 18+）：

```bat
npm install
node server.js                :: 监听 0.0.0.0:7788（所有网卡）
node server.js --port 7790    :: 换个端口
node server.js --local        :: 只本机 127.0.0.1
```

默认就是 `0.0.0.0`，**谁连得上这台机器谁就能打开面板**，不按来源 IP 过滤。

首次启动后到「配置」标签填两个路径（服务端安装目录 / 存档目录），保存并重启控制台。
路径填错卡片下面会标红，不用猜。

> ⚠️ **服务端跑在控制台的伪终端里 —— 关掉控制台窗口，服务器会一起停。**
> 想长期挂机不占浏览器，就照旧双击 `start-server.bat`，控制台仍可打开当只读面板
> （顶栏会标"外部实例"，能看日志、能强制结束，但下发不了命令）。

## 界面

| | |
|---|---|
| ![实时日志](docs/shots/01-log.png) | ![TUI 镜像](docs/shots/02-tui.png) |
| 实时日志（等级/关键字过滤、一键下载） | TUI 镜像（方块界面原样还原） |
| ![玩家档案](docs/shots/03-players.png) | ![全图玩家位置](docs/shots/04-map.png) |
| 玩家档案 | 全图玩家位置 |
| ![命令台](docs/shots/05-cmd.png) | ![配置页](docs/shots/08-config.png) |
| 命令台（136 条命令全集） | 配置页（可编辑 + 路径校验） |

完整使用手册：[`docs/manual.html`](docs/manual.html)（12 章，A4 排版，可直接打印成 PDF）。

---

## 一、功能对照

| 标签页 | 能干什么 |
|---|---|
| 实时日志 | 跟随最新 `coop-server-*.log`，按等级/关键字过滤（支持 `-排除词`），一键下载日志文件 |
| TUI 镜像 | 把服务端那个方块界面的原始 ANSI 输出原样画在浏览器里（含颜色、边框、光标重绘） |
| 玩家档案 | 每个玩家一张卡（魔兽世界 Armory 那种）：头像块、家族、Steam 主页、等级、锻造总熟练、技能进度条（与详情页技能树同源）、当前位置行（坐标 + 附近地标）、交易与社交数据；顶栏是游戏内时间/时间流逝/全图部队数 |
| 地图 | 独立菜单，整屏 Calradia：**真实游戏地图做底图（图上英文已全部抹除，地名由页面用中文标注，悬停看中英文，城堡名放大后才显示）**，可滚轮缩放、拖动平移、双击/按钮复位视野 + **所有玩家**的彩色位置标记（在线亮色/离线灰色，悬停看坐标/兵力/附近地标，点名字跳玩家档案）。30 秒自动刷新，手动「刷新位置」立即重拉 |
| 玩家详情 | 点卡片进去：等级/金币/生命、**战斗与平民两套装备（含头盔、马、马具）**、身份与家族、**部队编制（总兵力/兵种/伤员/俘虏/士气 + 按等级构成条 + 兵种明细）**、**技能加点（熟练度条 + 专注点）与属性点**。刻意不含家族成员 |
| 命令台 | 内置命令按钮（status/players/save/help）、`say` 公告、`kick` 踢人、`stop` 关服、136 条命令全集搜索；底部可直接敲命令，↑↓ 翻历史 |
| 存档备份 | 一键备份（可选"先让服务器 save 再打包"）、恢复、删除；恢复前自动把当前存档另存一份 |
| 更新日志 | 从 GitHub Releases 抓取并渲染 Markdown，自动标记"当前运行版本" |
| 配置 | 只读展示 `server-config.json`、`mod-config.json` 的关键项与所有路径 |

顶栏常驻：运行状态、阶段（启动中/载入存档/对外服务中）、在线人数、运行时长、模组版本，以及启动 / 停止 / 强制结束。

---

## 二、目录结构

```
web-console/
├─ server.js                  HTTP + SSE + 路由（零框架）
├─ start-console.bat          启动控制台（默认 0.0.0.0:7788，所有网卡都能进）
├─ open-firewall.bat          管理员放行 TCP 7788 / UDP 4200（换机才需要）
├─ node.exe                   仅发布包里有（绿色版运行时，源码库里没有）
├─ INSTALL.txt                仅发布包里有（给玩家的安装说明）
├─ QUICKSTART.txt             仅发布包里有（一页速查）
├─ config.json                本机配置（自己生成，可不存在；node lib/config.js --init）
├─ config.example.json        配置示例（带注释，分发给别人时看这个）
├─ lib/
│  ├─ config.js               路径/端口解析：环境变量 > config.json > 自动探测，含自检
│  ├─ console-config.js       配置页的后端：可编辑字段表、校验、安全写入 config.json
│  ├─ server-process.js       PTY 里的服务端进程：起停、状态、命令下发
│  ├─ log-tailer.js           日志文件增量读取（UTF-8/GBK 自适应、噪音分级）
│  ├─ saves.js                备份 / 恢复 / 列表 / 删除
│  ├─ players.js              玩家档案：解析存档配对文件，聚合每个 hero 的锻造/交易/社交
│  ├─ playercards.js          玩家详情：读服务端模块导出的 playercards.json，整理成装备/部队/技能
│  ├─ l10n.js                 官方中文包解码（UTF-16BE/LE/UTF-8），按字符串 id 查译文
│  ├─ map.js                  解析 settlements.xml 出 Calradia 底图（城镇/城堡坐标 + 中文名）
│  ├─ procs.js                端口占用与 PID 侦测、进程树强杀
│  └─ jsonc.js                带注释 JSON 解析
├─ public/
│  ├─ index.html              单页八个标签
│  ├─ app.js                  全部前端逻辑
│  ├─ term.js                 ANSI 屏幕缓冲区（TUI 镜像核心）
│  ├─ style.css               深色 dashboard
│  └─ img/
│     └─ calradia.jpg         真实底图（Map by Vesper「Calradia 1084」，已标定）
├─ data/
│  ├─ commands.json           7 条内置 + 136 条游戏命令（服务端启动时会自动刷新）
│  └─ changelog.json          GitHub Releases 缓存
├─ preview/                   本地调试用的静态快照（生成物，不入库）
│  ├─ players-preview.html         玩家档案名册的静态快照（单文件，双击就能看，不用起服务）
│  ├─ players-detail-preview.html  玩家详情页的静态快照（同上）
│  └─ map-preview.html             「地图」菜单的静态快照（同上）
└─ tools/
   ├─ fetch-changelog.js      抓更新日志
   ├─ build-release.js        打包：生成发布目录 + 内置 node.exe + 打 zip；也生成可推送的源码目录
   ├─ test-*.js               回归测试（`npm test` 一次跑完）
   ├─ calibrate-step1~4.js    底图标定工具（裁图目检 / 白圆检测 / 投影迭代 / 最小二乘，产出 calibration.json）
   ├─ erase-labels.js         抹掉底图上的英文标注（白掩膜+连通域+矩形补刀+BFS 修复）
   ├─ crop.js                 裁图目检小工具（erase-labels 调参用）
   ├─ make-players-preview.js 生成上面那份静态快照
   ├─ lib/fake-dom.js         极简假 DOM，让 Node 能跑前端渲染函数
   └─ ptyprobe.js             PTY 探针，换机时先跑它
```

---

## 三、配置与分发（换机 / 给别人用）

路径、端口全部可配，**代码里没有写死盘符**：控制台自己算位置，服务端目录自动往上找。
优先级：**环境变量 > `config.json` > 命令行参数（`--host` / `--port`）> 默认值**
（`--port` / `--host` 因为点了具体值，优先级比文件高）。

> `start-console.bat` 只用命令行传端口，**不要 `set COOP_CONSOLE_HOST` / `set COOP_CONSOLE_PORT`**：
> 环境变量在优先级链最顶端，一旦 set 就把端口和监听地址钉死了，配置页里填什么都不生效。

### 三个动作

```bat
node lib/config.js            :: 打印解析结果：每一项路径 + 存在与否 + 该怎么改
node lib/config.js --init     :: 按当前探测结果生成 config.json（已存在不覆盖）
```

启动控制台时也会做同样的自检，路径不对会直接打在启动日志里（带修改建议），
不用等点「启动」才报错。页面的 `/api/config` 接口同样返回 `configFile` / `issues`。

### 在页面上直接改（不用碰文件）

「配置」标签页最上面那张卡片就是可编辑表单，8 个键一人一行，改完点「校验并保存」：

- **只校验**：`POST /api/console-config` 带 `dryRun: true`，只回校验结果，不落盘
- **校验并保存**：校验通过才写 `config.json`（带注释头），校验不过**一个字都不写**
- **还原当前值**：把输入框恢复成磁盘上正在生效的值
- 字段留空 = 从文件里删掉这一项，回退到默认/自动探测（不是写空字符串）
- 文件里**不属于这 8 个键的其他键原样保留**，所以手写的注释性配置不会被吞
- 某项被环境变量锁住时，输入框置灰打标，并提示「改了也不生效」；强行保存仍会写文件，
  但返回里带 `lockedIgnored` 告诉你是哪几项被环境变量压住了

> 存完必须**重启控制台**才生效 —— `lib/config.js` 在 `require` 的瞬间就把值固化成常量了。
> 重启会连带停掉 PTY 里的游戏服务端，起来后记得再点一次「启动」。

校验规则：端口 `1~65535` 整数；`root`/`serverDir` 指向的 `BannerlordCoopServer.exe` 不存在算**致命**；
`coopData` 不存在也算致命；`savesDir`/`backupDir` 不存在只算警告（服务端跑一次/第一次备份就会出现）。

### config.json 字段

| 字段 | 说明 | 默认 |
|---|---|---|
| `root` | 服务端安装目录（含 `DedicatedServer` 子目录的那层） | 从控制台目录往上找 5 层 |
| `serverDir` | 服务端目录本身；给了就不用 `root` | `root\DedicatedServer`（若 `root` 本身就是服务端目录则不拼） |
| `coopData` | 存档/配置根目录（`server-config.json`、`Game Saves` 都在这下面） | `%USERPROFILE%\Documents\Mount and Blade II Bannerlord\CoopData` |
| `savesDir` / `dsLogsDir` / `backupDir` | 单独覆盖存档、日志、备份目录 | 都从 `coopData` / 控制台目录推算 |
| `port` / `host` | 监听端口与地址（`0.0.0.0` / `127.0.0.1` / `auto`） | `7788` / `0.0.0.0` |
| `gamePort` | 游戏端口（防火墙要放行 UDP） | `4200` |

示例见 `config.example.json`（带注释，`lib/jsonc` 解析，允许 `//` 和尾逗号）。

### 分发给别人的最短路径

1. 把整个 `web-console` 目录拷过去（`node_modules` 要带上，`node-pty` 是原生的，换机最好重装）
2. `node lib/config.js` —— 看哪一项 ✗，照着提示改
3. 大概率只需要改 `coopData`（对方 Windows 用户名不同）
4. 双击 `start-console.bat` —— 默认全网卡监听，本机和别的机器都能开

> 备份目录默认放控制台自己的 `backups\`；若检测到老布局
> `root\backups\web-console` 存在则沿用，避免升级后找不到历史备份。

---

## 四、HTTP 接口

下行用 SSE，上行用 fetch。没有 WebSocket。
对外监听时接口默认不校验口令。若启动前设了 `COOP_CONSOLE_TOKEN`，则所有接口都要求：
`?token=`、`Cookie: coop_console_token=…` 或 `X-Console-Token` 头，三者任一即可。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 状态快照 |
| POST | `/api/start` | 启动（端口被占会 409） |
| POST | `/api/stop` | 优雅停止：发 `stop`，最多等 45 秒后强杀 |
| POST | `/api/kill` | 强杀进程树（含外部实例） |
| POST | `/api/command` | `{cmd}` 或 `{cmds:[...], delay}` 下发控制台命令 |
| GET | `/api/events` | SSE：`hello` / `state` / `log` / `console` / `logfile` / `notice` / `commands` |
| GET | `/api/tui` | SSE：`seed`（最近 200KB 屏幕）+ `tui`（base64 原始块，120ms 合并） |
| GET | `/api/logs/history?lines=N` | 内存里最近 N 行 |
| GET | `/api/logs/files` | 日志文件列表 |
| GET | `/api/logs/download?file=` | 下载日志 |
| GET | `/api/saves` | 当前存档 + 备份列表 + 占用 |
| POST | `/api/saves/backup` | `{note, triggerSave}` |
| POST | `/api/saves/restore` | `{id}`，运行中会 409 |
| DELETE | `/api/saves/:id` | 删除备份 |
| GET | `/api/commands` | 命令表 |
| GET | `/api/players` | 玩家档案：存档配对文件 + 在线列表 + 世界心跳；每个玩家带 `detail`（装备/坐骑/部队/技能） |
| GET | `/api/perks` | 技能树目录：全部 perk 按技能分组、按需求熟练度分档，说明已中文化并带上具体数值。数据在 `lib/playercards.js`，与 `/api/players` 的 `detail` 同源 |
| GET | `/api/map` | Calradia 底图：城镇/城堡坐标（120 个，含中文名），来自 `settlements.xml`（mtime 缓存）。「地图」菜单画整屏态势图、名册卡片算「附近地标」都用它 |
| GET | `/api/changelog` | 更新日志缓存 |
| POST | `/api/changelog/refresh` | 重新抓取 GitHub Releases |
| GET | `/api/config` | 两份配置 + 路径（只读，游戏侧 + 控制台自身路径） |
| GET | `/api/console-config` | 控制台配置的可编辑视图：8 个字段定义 + 当前生效值 + `envLocked` + `issues` + `requiresRestart` |
| POST | `/api/console-config` | `{values}` 校验并写 `config.json`；`{dryRun:true, values}` 只校验不落盘。校验不过返回 **400** + `issues` + `error` 摘要 |

默认监听 `0.0.0.0`，也就是**这块机器上的每一张网卡都听**——回环、局域网、ZeroTier、公网网卡一视同仁，
不做任何来源 IP 过滤。谁能连上这台机器的 7788 端口，谁就能打开面板。双击 `start-console.bat`
就是这个行为，没有第二个开关要开。

启动窗口会打印几行可直接复制的地址，形如：

```
本机     : http://127.0.0.1:7788/
局域网   : http://<本机IP>:7788/
ZeroTier : http://<本机IP>:7788/
```

> `0.0.0.0` 是**监听地址**，不是你能在浏览器里敲的地址——浏览器要敲具体那张网卡的 IP，
> 启动窗口已经替你列好了。`http://0.0.0.0:7788` 只有部分系统能打开，别拿它发给别人。

**默认无口令**，这套东西跑在 ZeroTier / 内网里，都是自己人，直接敲地址就能进。
要精确指定只听哪几张网卡（比如只放 ZeroTier、不放公网那张），**推荐直接在「配置」页改**
（写进 `config.json`，重启生效）；临时试一次也可以用环境变量：

```bat
set COOP_CONSOLE_HOST=127.0.0.1,192.168.1.10
node server.js
```

`host` 的三种写法：

| 值 | 含义 |
|---|---|
| `0.0.0.0`（默认） | 全网卡，不做来源过滤 |
| `127.0.0.1` | 只本机 |
| `auto` | 只监听回环 + 私有网段（`10.x` / `172.16–31.x` / `192.168.x` / `100.64–127.x`），公网网卡不放 |
| `127.0.0.1,192.168.1.10` | 逗号分隔，精确指定只听这几个地址 |

**换端口**（`start-console.bat` 的唯一参数就是端口）：

```bat
start-console.bat 7790
```

> 端口只是**兜底默认**：`config.json` 里写了 `port` 就以文件为准。
> 想让端口固定下来，去「配置」页填一次保存，之后双击 bat 都用那个端口。

用途很具体：主控制台正在跑游戏服务端时，要开第二个面板看日志/玩家档案又不能动它，
就用另一个端口起一个**只读实例**——它不持有游戏进程，顶栏会标"外部实例"，
**别在那个窗口点「强制结束」，那会把真正在跑的服务端杀掉**。

> ⚠️ 无口令 + 全网卡监听意味着**任何能连上这台机器的人打开地址就能起停服务器、恢复存档、删备份**。
> 自己人的网络无所谓；哪天要放到不受信任的环境，启动前设一个口令即可：`set COOP_CONSOLE_TOKEN=你的口令`。
> 开启后支持 `?token=` / `Cookie: coop_console_token=…` / `X-Console-Token` 头三种带法，
> 地址栏带一次 token 会写入一年期 Cookie，之后不用再拼。更稳妥的做法是把 `host` 收成 `auto`
> 或写死内网地址，别让公网网卡暴露出去。

> 若换一台**开着防火墙**的机器，还要放行 TCP 7788：以管理员身份运行 `open-firewall.bat`
> （它同时会放行游戏用的 UDP 4200）。

---

## 五、备份策略

- 位置：控制台目录下 `backups\<时间戳>_<类型>\`（可在「配置」页用 `backupDir` 改）
- 内容：`Game Saves` 下所有 `.sav` / `.json` + `manifest.json`（含文件清单、备注、来源目录）
- 单份约 **22 MB**（含 `saveauto1.backup1/2` 与"副本"文件），恢复时按文件名覆盖回 `Game Saves`
- 三类型：`manual`（手动）、`pre-restore`（恢复前自动留的现场）、`auto`（预留）
- 恢复时**要求服务器已停止**——运行中覆盖存档文件会把世界写坏

没有自动清理。备份页会显示总占用，自己按需删。

---

## 许可与致谢

本项目 **MIT** 许可（见 [LICENSE](LICENSE)），可自由转载、修改、二次分发，请保留致谢。

### 这不是一个独立的游戏

它只是 Bannerlord Coop 专用服务器的一个外挂式控制台，**不含任何游戏本体资源**，
不修改游戏内存、不注入进程。它确实能下发作弊 / 踢人 / 关服命令 —— 那是因为服务端允许，
权限给多大请自己把关。

### 第三方

| 项目 | 说明 |
|---|---|
| [Bannerlord Coop](https://github.com/Bannerlord-Coop-Team/BannerlordCoop) | 联机模组与专用服务器本体，本工具针对 v0.1.6（配对提交 `5f4d63c`）适配 |
| TaleWorlds | 《骑马与砍杀 2：霸主》及其专用服务器 |
| [node-pty](https://github.com/microsoft/node-pty) | 伪终端（ConPTY）绑定，MIT |
| 卡拉迪亚底图 | Map by **Vesper** — "Calradia 1084"，来自 TaleWorlds 官方论坛，作者允许署名使用 |
| 中文译名 | 取自官方简体中文语言包 |

底图是别人做的，用之前请先看一眼原作者的授权说明。

### 反馈

提 [Issue](../../issues) 请带上三样：① 控制台窗口里的报错截图；②「TUI 镜像」最后 20 行；
③ `node lib\config.js` 的输出。有这三样，绝大多数问题一眼能定位。
