<p align="center">
  <img src="docs/banner.jpg" alt="DSH Pocket" width="100%">
</p>

<h1 align="center">DSH Pocket</h1>

<p align="center"><a href="README.en.md">English</a> | <a href="README.md">中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="npm" src="https://img.shields.io/npm/v/dsh-pocket?color=4d6bfe&label=npm"></a>
  <a href="https://www.npmjs.com/package/dsh-pocket"><img alt="downloads" src="https://img.shields.io/npm/dm/dsh-pocket?color=4d6bfe"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-GPL--2.0-red.svg"></a>
  <a href="https://github.com/ZhangYunfang/dsh-pocket/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ZhangYunfang/dsh-pocket"></a>
  <a href="https://awesome-dsh-plugin.com/zh/"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

> 把 **DeepSeek Harness 装进你的口袋**：一个包、一个设置页，手机扫二维码就实时看到电脑上的同一个界面。公网有两条通道——**快速隧道**（零配置，随机域名，点一下就开）与**固定域名**（自配 Cloudflare Tunnel，地址不变）。

> **本仓库是融合版**：把 [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)（上游主线，GPL-2.0，含 Quick Tunnel 一键公网）与 [daha1216/dsh-pocket](https://github.com/daha1216/dsh-pocket)（fork，含 dsh-web-mobile v3.2.0 移动层镜像、会话删除、sha256 供应链校验）的各自优势合并成一个项目。移动端适配源自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT）。融合决策与逐条对照见 [`MERGE.md`](MERGE.md)。

<p align="center">
  ⭐ 顺手留颗 Star &nbsp;·&nbsp; <a href="https://github.com/ZhangYunfang/dsh-pocket">好，这就去 Star</a>
</p>

## 这是什么

**你不在电脑前，也想用电脑上的 DeepSeek Harness。**

- 下班路上，agent 在电脑上跑任务，你想掏出手机看看它干到哪了、结果如何
- 出门在外，突然想让电脑上的 agent 查点资料、写段代码，但没有远程桌面、没有 SSH
- 电脑在宿舍/办公室，你人在外面，想随时"操控你的 DeepSeek Harness"——发任务、看输出、点审批

DSH Pocket 就是干这个的：**装上它，同一 WiFi 下手机扫个码，就能实时看到并操控电脑上的 DeepSeek Harness 界面**。公网接入仅支持用户自行配置 Cloudflare 固定域名与 Tunnel Token；未配置时公网保持关闭，局域网照常可用。

实际效果——手机上的界面就是电脑上的界面，实时同步：

<p align="center">
  <img src="docs/interface.jpg" alt="手机上的 DSH 界面" width="100%">
</p>

## ✨ 特性

| 特性                    | 说明                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📶 局域网扫码           | 装好即用：设置 → 手机访问，打开就有局域网二维码，手机连同一 WiFi 扫码即开（自动识别本机局域网 IP，**WSL 环境自动取 Windows 物理网卡 IP**）                                         |
| 🚪 局域网开关           | 设置页可**一键关闭/开启局域网访问**（切换时弹窗提醒）：关闭后局域网二维码/链接立即失效，已配置并开启的公网访问不受影响 |
| 🌐 公网扫码（人在外面） | 两条通道可选：**快速隧道**（零配置，点一下就开，随机 `*.trycloudflare.com` 地址）或**固定域名**（自配 Cloudflare 命名隧道）；每次手动开启都须确认免责声明 |
| 🏷️ 公网固定域名         | 自配 **Cloudflare 命名隧道**，地址固定不变；保存配置不会自动启动公网 |
| 🔐 访问密码             | 插件公网默认使用 **8 位随机密码**，不随公网启停或 DSH 重启自动换新；局域网有独立的默认 **8 位随机密码**（默认开启，可在设置页关闭，关闭后局域网扫码直连） |
| 🔑 自定义密码           | 公网/局域网密码都可在设置页**设成自己固定的 8–64 位密码（英文字母大小写或数字）**；请主动管理、泄露后及时修改 |
| 🧘 会话保持             | 手机输一次密码后**长期免输**（登录状态绑定电脑上的 dsh web 进程：只要它不重启，手机不用再输；**dsh web 重启/更新后需重新输入一次**）                                               |
| ⚡ 实时同步             | 流式输出走 WebSocket 全透传——**电脑上在输出，手机上同步在滚**，可双向操作；内置心跳保活（防路由器 NAT/省电机制静默断链，断线自动重连）                                             |
| 📱 移动端适配           | 窄屏自动变抽屉布局（移植 dsh-web-mobile，MIT）：侧栏抽屉、会话全宽、状态栏安全区、触控优化                                                                                         |
| 🧭 可选右边栏           | 手机端显示原生右边栏入口；普通手机可在设置中关闭以保持紧凑，折叠屏展开后可更方便地同时使用终端底栏和右边栏                                                                         |
| 📏 手机端字号           | 默认「跟随桌面」，桌面改字号时手机同步变化；选择**具体字号（12–22px）**后才独立，不影响桌面「字号大小」 |
| 📁 文件浏览             | 移动端「文件浏览」入口需要宿主提供 explorer 面板（dsh-web-ui 组件）；官方 DSH 未内置时入口自动隐藏，不会出现"点了没反应"                                                           |
| 🗜️ 传输压缩             | 大 JSON 响应自动 gzip/brotli（长会话 17MB → ~1MB，brotli 质量 6：快且省流量），手机加载更快、更省流量                                                                              |
| 🔁 隧道自动恢复         | DSH 重启后自动恢复**上一次开启的那条通道**（快速隧道按标记恢复为快速隧道，命名隧道需配置仍完整） |
| 🧩 单包安装             | 一个包、一个设置页，没有核心/适配器要分开装；局域网与快速隧道**均无需任何 Cloudflare 配置**，只有固定域名模式需要自己账号与域名 |

## 🚀 怎么用

**入口在哪**：安装完成并重启 `dsh web` 后，打开 **设置**，左侧边栏就能看到 **「手机访问」** 入口（和「通用设置」「模型」同级）：

<p align="center">
  <img src="docs/entry.jpg" alt="手机访问入口" width="70%">
</p>

**前提**：电脑上已装好 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。如果终端提示 `dsh: command not found`（找不到 dsh 命令），先安装：

```sh
npm install -g @deepseek-ai/dsh     # 全局安装；验证：dsh --version
# 不想全局装？每次命令前加 npx：npx @deepseek-ai/dsh <命令>
```

```sh
# 1. 装插件（一个包全都有）
dsh plugin --profile web add github:ZhangYunfang/dsh-pocket -w

# 2. 重启 dsh web
npx @deepseek-ai/dsh web
```

> **装的是哪个包**：npm 上同名的 `dsh-pocket` 是上游作者的包（当前 2.12.0），**不是**这个融合版。请用上面带 GitHub 地址的命令安装。想锁版本就写成 `github:ZhangYunfang/dsh-pocket#v3.1.0`。
>
> **兼容性**：`engines.dsh` 声明 `>=0.1.2-alpha.2 <0.3.0`，即 **DSH 0.1.2-alpha.2 到 0.3.0 之前**。注意两点：①DSH 0.1.x 的插件管理器**还不认识 `engines.dsh` 这个字段**，所以它既不拦你也不保护你；②**0.1.2-alpha.2 与 0.2.x 均已验证可用**（宿主契约探针 7/7 + 局域网/公网真机实测），适配记录见 [`docs/DSH-0.1.2-适配计划.md`](docs/DSH-0.1.2-适配计划.md)。

### 局域网（同一 WiFi）

设置 → **手机访问** → 手机扫「📶 局域网」二维码 → 打开链接**输入局域网密码**（显示在设置页局域网区块，点「刷新」可换新，或点「自定义」设成自己固定的 8–64 位密码——英文字母大小写或数字）→ 打开的就是电脑上的 DSH，实时同步。

> 「**局域网访问**」开关默认**开**：可一键**关闭/开启**（切换时弹窗提醒）——关闭后局域网二维码/链接立即失效（手机打不开），**公网不受影响**；想恢复时再点「开」即可。
>
> 局域网密码**默认开启**（安全优先）。如果只有自己用、嫌每次输密码麻烦，可在设置页局域网区块把「局域网访问密码」切到**关**——之后局域网扫码直连、无需密码（仅同一局域网设备可访问；**公网始终要密码**，不受影响）。
>
> 手机登录一次后**长期免输**：只要电脑上的 dsh web 不重启，再次打开手机不用再输入（**dsh web 重启/更新后需重新输入一次**）。
>
> 高级选项：自动识别在 Tailscale/VPN 等场景下可能选不到可达地址。可在「局域网地址」下拉框手动选择已检测到的 IP；一般不需要修改。

### 公网（人在外面）：两条通道

设置页「公网配置」顶部有**通道选择器**，二选一。两条通道**都要**：每次手动开启时阅读并勾选安全免责声明（服务端强制校验）。

#### 通道 A：快速隧道（默认，零配置）

点「**开启公网访问**」→ Cloudflare 会分配一个随机 `https://<子域>.trycloudflare.com` 地址 → 手机扫公网二维码即可从任何网络访问。

- **不需要** Cloudflare 账号、域名或 Token。
- 地址**每次开启都会变**（旧链接自动作废，天然轮换）。
- 公网密码默认**每次开启自动换新**（自定义密码不受影响）。
- 适合：临时看一眼、出差应急、不想折腾配置。

#### 通道 B：固定域名（自配 Cloudflare 命名隧道）

适合需要**地址长期不变**的场景。需要你自己的 **Cloudflare 账号、域名和命名隧道 Tunnel Token**。

1. 在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels** 创建命名隧道，复制 **Tunnel Token**。
2. 在该隧道的 **Public Hostname** 添加域名路由（如 `pocket.example.com`），把 **Service 指向本机实际代理端口**（通常 `http://127.0.0.1:3081`）。**不要指向 DSH 原始 Web 端口（通常 3080）**，否则会绕过 Pocket 的访问控制。
3. 设置 → 手机访问 → 公网配置 → 选「固定域名」→ 点「**配置公网访问**」，填域名与 Token 后保存。**保存只保存配置，不会启动公网**；改动正在使用的配置后需关闭再开启才生效。
4. 点「开启公网访问」→ 勾选免责声明 → 等隧道建立 → 扫公网二维码。

- 地址固定为你的域名，**不随重启变化**。
- 公网密码**不自动轮换**，请用强密码并主动管理（泄露后手动改）。
- Tunnel Token 只存本机 `$DSH_HOME/dsh-pocket/settings.json`，设置页不回显。

#### 通用说明

- **密码**：默认 8 位随机，可自定义为 8–64 位英文字母或数字。快速隧道每次开启自动换新；固定域名不换新。
- **切换通道**：公网正在运行时切换，需**先关闭再开启**新通道才生效。
- **重启恢复**：DSH 重启后按上次的通道自动恢复（快速隧道会用新地址，需重新扫码；固定域名地址不变）。
- **恢复出厂**：会关闭公网并清除域名、Token 与恢复标记。

> 更新到新版本：重新执行上面的 `add` 命令即可（GitHub 地址不带 tag，装到的是默认分支最新提交）。想锁版本就写成 `github:ZhangYunfang/dsh-pocket#v3.1.0`。

### CLI 公网访问

`dsh-pocket` 不带参数时只提供局域网访问。公网有两条 CLI 通道：

- `dsh-pocket --quick`：**快速隧道**，不需要任何 Cloudflare 配置，地址随机且每次运行都变。
- `dsh-pocket --public`：**固定域名**，必须先在设置页保存自己的域名与 Tunnel Token，且 **CLI 与配置时的 DSH 必须使用同一个 `DSH_HOME`**；配置缺失时不会创建公网隧道。

Cloudflare 域名路由的 **Service 必须指向 CLI 的实际监听端口**（默认 3081；例如 `dsh-pocket --public --port 3082` 对应 `http://127.0.0.1:3082`）。不要让插件代理与 CLI 争用同一端口，也不要把路由指向 DSH 原始 Web 端口。CLI 的访问密码独立于插件设置：默认每次运行生成，可用 `--pin <值>` 或 `DSH_POCKET_PIN=<值>` 自行设定。

## ⚠️ 安全（必读）

- **DSH 能执行你电脑上的代码**。**局域网**二维码/URL 配上独立 **8 位密码**才是钥匙（密码**默认开启**，可关——关闭后局域网扫码直连，仅同一网络设备可访问），**请勿把局域网二维码、URL 或密码发给别人**
- **在设置页每次手动开启公网前必须阅读并勾选免责声明**（服务端强制校验开启请求）：公网 = 把能执行代码的 DSH 暴露到互联网，请使用强密码、用完即关、涉密网络勿用；命名隧道可在重启后自动恢复，不想恢复时请先手动关闭
- **插件公网**默认有 **8 位随机密码**保护，可自定义为 **8–64 位英文字母或数字**。无论是否自定义，**密码都不随公网启停或 DSH 重启自动换新**；若地址和密码泄露，请立即关闭公网并主动修改密码，不能靠重开让旧密码失效
- 手机登录状态与电脑上的 dsh web 进程绑定：**电脑 dsh web 一直开着就不用重复输入；重启/更新后需重新输入一次**
- **登录限速**（防暴力破解）：同一 IP 连续输错 **5 次**锁定 **60 秒**；全局失败超阈值时短暂全锁（防换 IP 分布式扫描）；输对密码后计数清零
- **快速隧道**：地址每次开启都变、旧链接立即作废，公网密码也每次换新——泄露后重开一次即可作废旧链接。**固定域名**：地址不随重启变化、密码不自动轮换，更易被长期扫描，请用强密码、妥善保管 Tunnel Token，用完即关
- **公网判定是 fail closed**（issue #66）：除本机（loopback）和局域网私网地址外，**一切陌生域名（包括你自建隧道/反向代理指向本机端口的固定域名）一律按公网处理、强制公网密码**——不存在「换域名绕过密码」的口子
- 局域网模式不暴露公网，只有同一网络内的设备能访问
- 适合个人自用；插件公网密码存本机 `$DSH_HOME/dsh-pocket/token`（快速隧道每次开启换新、固定域名不换新），局域网密码存 `$DSH_HOME/dsh-pocket/token-lan`（设置页手动刷新），开关、自定义标记、通道模式及公网配置存 `$DSH_HOME/dsh-pocket/settings.json`
- **CLI 模式（命令行直跑 `dsh-pocket`）也有密码**（issue #90 修复前这条路是无认证的）：默认随机生成 8 位密码，打印在终端、并已内嵌进二维码（**扫码体验不变**），手动敲地址时需要填写，本机访问免密。`--pin <值>` 或 `DSH_POCKET_PIN=<值>` 自定义（至少 6 位）；`--no-auth` 可关闭，**不推荐**——那等于把能执行代码的 DSH 裸暴露给任何能连上该端口的人

## 💻 DSH Desktop（桌面版）

- 桌面版里 dsh-pocket 的**扫码同屏**正常可用；**更新/重启由桌面版管理**（插件内这两项自动停用）
- ⚠️ 桌面端 **advanced 模式**暂不支持手机访问（该模式禁用网页布局、手机拿不到 layout 服务，会白屏）——请切回 **compatibility** 模式后重启；advanced 模式下手机打开会看到明确的提示层

## 🩹 常见问题（别踩的坑）

| 现象                                        | 原因与解决                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh: command not found` / 提示 DSH 未定义  | dsh CLI 没装：`npm install -g @deepseek-ai/dsh`，或命令前加 `npx @deepseek-ai/dsh`                                                                                                                                                                                                                                                                      |
| `ERR_PNPM_ADDING_TO_ROOT`                   | pnpm 9 对 workspace 根的限制：安装/更新命令**末尾加 `-w`**（`--workspace-root`）                                                                                                                                                                                                                                                                        |
| 装完/更新了但界面没变化                     | **必须重启 `dsh web`** 才生效；运行中的进程仍加载旧代码                                                                                                                                                                                                                                                                                                 |
| `listen EADDRINUSE ... :3081`               | 旧 dsh-pocket 进程还占着端口：macOS/Linux `lsof -ti :3081 \| xargs kill -9`；Windows `netstat -ano \| findstr :3081`（找 LISTENING 的 PID）→ `taskkill /PID <PID> /F`，后重试                                                                                                                                                                           |
| 想换端口（issue #70）                       | 插件模式：在 `$DSH_HOME/dsh-pocket/settings.json` 写 `"proxyPort": 3082` 后重启 `dsh web`。CLI 模式：`dsh-pocket --port 3082`。端口被占会报 `EADDRINUSE`，杀掉旧进程或换一个端口                                                                                                                                                                        |
| 想给访客一个临时密码                        | 暂不支持：issue #69 的「临时访问 PIN」功能已在 2.6.x 移除（撤销时会崩）。现在分享访问：把主密码或 `?token=<主密码>` 链接发给对方，用完在设置页点「刷新」换掉即可                                                                                                                                                                                        |
| Linux 服务器装不上 cloudflared（issue #45） | 远程 Linux 国内/企业网下所有 CDN 源（GitHub/ghproxy/gh.ddlc/gh-proxy）都连不上时：在服务器上手动装 `cloudflared`（如 `apt install cloudflared`、`dnf install cloudflared`、或下载 tgz 解压到任意目录），然后在 `$DSH_HOME/dsh-pocket/settings.json` 加 `"cloudflaredPath": "/path/to/cloudflared"`，重启 `dsh web` 后插件直接调用它，**不再走自动下载** |
| 装完提示 `incompatible-version`             | 本插件声明 DSH **>=0.1.2-alpha.2 <0.3.0**：`dsh --version` 确认版本，升级 DSH，或在支持该字段的版本上用 `dsh plugin allow-version` 加一次性豁免 |
| 公网 `error 1033`                           | 见下方「公网隧道常见问题」——多半是本机代理/VPN（Clash 等 TUN 模式）掐断了隧道                                                                                                                                                                                                                                                                           |
| 点「重启 dsh web」后页面提示进程在后台运行  | 自重启的新进程是 detached 后台进程（不挂终端），是页内更新的标准做法；停止它：macOS/Linux `lsof -ti :3080 \| xargs kill -9`；Windows `netstat -ano \| findstr :3080` → `taskkill /PID <PID> /F`（日志在 `$DSH_HOME` 下 `dsh-pocket-restart-*.log`）                                                                                                     |

## ⚠️ 公网隧道常见问题（必读）

**现象**：点「开启公网访问」后，手机上打开公网地址报 `error 1033`（Tunnel error）。

**最常见原因：本机开着代理/VPN（Clash、Surge、v2ray、sing-box 等，尤其 TUN 模式）**。
这类工具会接管全部流量，并常常把 cloudflared 的隧道边缘连接
（`*.argotunnel.com`、Cloudflare 边缘 IP）掐断，导致隧道注册成功但数据面连不上。

**另一类隐蔽根因：shell 里的 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量**（指向 `127.0.0.1` 的本地拦截代理）。
即使你关掉了 TUN 模式、系统级代理也显示关闭，只要终端启动时注入了这些 env 变量，
`dsh` 启动后 spawn 的 cloudflared 会**继承**它们，把隧道边缘连接绕进本地代理 → 同样 1033。
**本版起 pocket 在启动 cloudflared 时会主动剥离这些代理变量，从根上规避**；旧版本需手动处理（见下）。

**解决（从轻到重，按顺序试）**：

1. 先**只关闭代理的 TUN 模式**，不用退出代理软件——多数情况这一步就够：
   - Clash：设置里关掉「**TUN 模式**」开关（或右键菜单栏图标 → 取消勾选 TUN 模式）
   - Surge：关「**增强模式**」；v2ray/sing-box：关「**虚拟网卡/路由接管**」
   - 然后回设置页重新点「开启公网访问」
2. 仍不行就**彻底退出代理软件**（不只是关界面：Clash 要右键菜单栏图标 → 退出；若装有
   后台服务还要在服务管理器里停掉，`ps aux | grep clash` 确认进程消失），再重试
3. 给代理加**直连规则**，放行隧道域名与 Cloudflare 边缘（Clash 规则示例）：
   ```yaml
   - DOMAIN-SUFFIX,argotunnel.com,DIRECT
   - IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
   ```
4. 网络实在不通时，改用**局域网模式**：手机开热点 → 电脑连手机热点 → 扫局域网码，
   效果完全一样（人在外面也能用）

**其他可能**：企业防火墙/校园网拦截出站；此时请让 IT 放行或改用热点。

**首次开启时「下载 cloudflared」失败/卡住**：

- **macOS/Linux**：优先走**清华镜像**（实测 ~3MB/s，几秒下完）；失败自动回退官方 GitHub + 加速源。
- **Windows**：无清华镜像（Homebrew 不支持 Windows），走官方直连下载（约 50MB，**单线程会慢，属正常**，耐心等几分钟；也可挂代理加速）。
- 全部失败时设置页会给出提示。备选方案（任选其一）：

1. 手动装好命令行 cloudflared 后重试（装好后 dsh-pocket 直接用 PATH 里的，不再下载）：
   - macOS：`brew install cloudflared`；Linux：`sudo apt install cloudflared` 或官网下载
   - Windows：`winget install cloudflared` 或官网下载
   - 任何平台：`npm i -g cloudflared`
2. 挂代理（系统代理/Clash 等）后重新点「开启公网访问」
3. 手动下载二进制放到 `$DSH_HOME/dsh-pocket/bin/` 目录（`$DSH_HOME` 一般是 `~/.dsh`，Windows 是 `%USERPROFILE%\.dsh`；文件名用 `cloudflared`（Windows 加 `.exe`）或发布资产名均可，插件都认）

## 🗂 架构（单包）

| 文件                 | 说明                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/index.js`       | 插件入口：自动起代理 + 注册 RPC + 访问密码管理（公网 8 位：快速隧道每次开启换新、固定域名不换新；局域网独立 8 位可手动刷新/开关）+ 局域网访问总开关 + 桌面端环境适配 |
| `lib/settings.mjs`   | 设置持久化：局域网访问总开关（默认开启）+ 局域网密码开关（默认开启）存 `$DSH_HOME/dsh-pocket/settings.json`                                                                        |
| `lib/service.mjs`    | 服务：代理生命周期（端口自适应）、用户自配命名隧道（完整配置与有效标记才恢复）、状态快照（含二维码） |
| `lib/proxy.mjs`      | 改头反向代理：Host/Origin → loopback，HTTP + WebSocket 透传 + polyfill 注入 + gzip/brotli 压缩 + 按 Host 区分的访问令牌认证（公网必验；局域网按开关）+ 局域网关闭时拦截局域网 Host |
| `lib/tunnel.mjs`     | cloudflared：多镜像源下载（清华优先）/自适应多线程/用用户的 Tunnel Token 启动命名隧道（HTTP/2） |
| `lib/web-rpc.js`     | loopback RPC：`status` / `tunnel.start` / `tunnel.stop` / `lan.setEnabled` / `version` / `update` / `restart`                                                                      |
| `client/`            | 设置页「手机访问」+ 移动端适配（dsh-web-mobile 移植）                                                                                                                              |
| `bin/dsh-pocket.mjs` | CLI：局域网/公网模式，打印 URL + 二维码                                                                                                                                            |

## 🛠 开发

```sh
npm install
node client/build.mjs   # 改 client/ 后重新打包
npm test                # 代理 / 认证 / 压缩 / 隧道 / 服务 / RPC / 设置（109 测试）
```

**改完想在本机先试？** 不用发版：把插件换成指向本地仓库的软链，重启 dsh web 就是本地代码。完整步骤（含怎么换回 npm 官方版本）见 [LOCAL-DEV.md](./LOCAL-DEV.md)。

## 🤝 致谢

- 移动端适配移植自 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT）
- 公网隧道基于 [cloudflared](https://github.com/cloudflare/cloudflared)

## 📄 License

[GPL-2.0](LICENSE) —— 自由软件许可：可自由使用、修改、分发，但**修改版必须同样以 GPL 开源**并保留版权声明；商用同样适用。

> 说明：移动端适配部分移植自 [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT 许可，兼容 GPL），其版权声明保留在 `client/mobile/LICENSE.dsh-web-mobile`。

---

**有问题？欢迎反馈**：遇到 Bug、有想法、想提需求，请到 [GitHub Issues](https://github.com/shaobeichen/dsh-pocket/issues) 告诉我们 🙏
