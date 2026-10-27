# 2026-10-27 全面安全/稳定性审计记录

本轮审计目标：找出 dsh-pocket 既有功能里的**内存泄露、隐私泄露、边界 bug、网络安全漏洞、联动 bug**，用「多子代理并行审查 + 对抗验证 + 回归测试」的方式修复确认项。

## 方法

1. 6 个只读子代理按模块并行审查（proxy / web-rpc + delete-session / 生命周期与供应链 / 客户端设置页 / 移动端 / 跨模块契约与测试假阳性），输出「严重度 / 位置 / 证据 / 触发 / 影响 / 现有测试为何没发现 / 最小修法」。
2. 对高危项再派对抗验证代理逐条复核（能否复现、是否已有测试覆盖、修法是否破坏契约），只修「确认」项；被驳回的写入下方「明确不修」并给出理由。
3. 每项修复补回归测试，最后跑全量测试。

## 已修复（按风险）

### 认证 / 授权

- **`?token=` 明文 PIN 泄漏**：分享链接里的 PIN 会进入上游请求行、子资源 `Referer`、代理访问日志。现在认证通过后按值（只删等于访问 PIN 的 `token` 参数，绝不误删 dsh 启动 token）从请求行剥离；`Referer` 改写时去掉 `token`；所有错误/访问日志统一走 `maskTokenForLog`；HTML 注入点加 `history.replaceState` 清掉手机地址栏的 query（Safari 在 `http://` 源上不能靠 3xx 保 cookie，所以不用重定向）。
- **全局登录锁把主人也锁在门外**（未认证即可 DoS）：限速器区分「单 IP 锁」与「全局锁」；全局锁只拦继续猜密码的请求，**正确密码始终放行**，登录页/`?token=`/WS 三条路径一致。
- **WS fail-open**：受保护主机上 `getToken()` 为空时，HTTP 503 而 WS 仍 101。现在 WS 与 HTTP 对齐 fail-closed，并复用单 IP 锁。
- **公网 PIN 跨通道回显**：`status` 曾把公网 PIN 返回给任何已认证客户端（含 LAN/公网），等于给出「离网可用、不随启停更换」的持久凭据。现在代理写入 `x-dsh-pocket-origin`（客户端伪造会被丢弃），仅 `loopback` 返回公网 PIN；**局域网 PIN 也不回传公网来源**。
- **公网访客可操作本机/局域网通道**：通过隧道访问时，`lan.refresh` / `lanAuth.setEnabled` / `lan.setEnabled` / `lan.setOverride` / `pin.setCustom('lan')` / `pocket.reset` / `tunnel.start|stop|setConfig` 一律 `forbidden`；设置页按 `status.origin` 隐藏对应控件，服务端仍强制校验。
- **CLI 参数**：`MIN_PIN_LENGTH` 与插件统一为 8；`--public` + `--no-auth` 直接拒绝启动；`--pin` 缺值/下一个参数是 flag 时不再吞掉它；纯空白 PIN 报错。
- **删除会话路由信任栅栏**：改用宿主 `connection.requestRejection`（含浏览器认证），没有该方法才回退 Host/Origin 检查；权限/跨源头分别回 401/403。

### 内存 / 解压炸弹

- **`POST /api/session/list` 请求体无上限**（单请求可涨 ~150MB）：`content-length` 预检 + 边收边计数，超 1MB 直接改成流式转发，不在代理里攒整包。
- **session/list 响应全量缓冲/解压/重压**：`content-length` 预检 + 64MB 上限，超限流式透传；解压一律带 `maxOutputLength`。
- **HTML 注入分支可被解压炸弹打爆**：4MB 预检、边收边计数超限即 `pipe` 直通、`gunzip/brotli/inflate` 全部 `maxOutputLength`。

### 路径 / 文件

- **fileRead 工作区边界 fail-open**：工作区枚举失败/返回空/形状异常时旧代码把 `roots=[]` 当「无边界」放行。现在无法确定边界就拒绝（fail-closed），并扩充凭据黑名单（`deploy_key`、`gcp-service-account.json`、`*.ppk`、`*.kdbx`、`hosts.yml`、`.docker/config.json` 等）；非字符串 path 直接 400；错误文案不再回显绝对路径/用户名。
- **delete-session**：`cwd === ''` 抛异常变成空 400 已修成明确的 400；失败文案不再与回滚事实相反；错误/日志里的会话 id 截断（防 900KB 的 id 放大成 900KB 响应、防换行注入）；`isInside` 补 `!isAbsolute(rel)`。

### 生命周期 / 配置

- **settings 跨进程读-改-写互相覆盖**：加 `settings.json.lock`（10s 视为陈旧）、每次写入前重读磁盘再合并、临时文件名加 pid+随机串；`resetSettings` 清掉 `.bak/.tmp/.lock`，不再把含 `tunnelToken` 的 `.tmp` 留在盘上。PIN 写盘改为原子 rename，`pinCache` 按 mtime 失效。
- **两实例共用 `$DSH_HOME` 时互杀隧道**：`tunnel-auto.json` 记录 `hostPid`；宿主仍存活时孤儿清扫直接跳过，只清理真正遗留的 cloudflared。
- **代理端口被占静默顺延**：`status.portShifted` 暴露事实；命名隧道 ingress 指向原端口时 `startTunnel` 直接拒绝并提示改端口或改 ingress，不再公网 502/命中别的实例。
- **隧道运行中改配置不重启**：保存后若隧道在跑则用新配置重启一次，`status` 不再同时给「旧 tunnelUrl + 新 hostname」。
- **更新超时只杀 cmd.exe**：Windows 改用 `taskkill /T /F` 杀整棵进程树；profile 缺省按安装路径推断，不再写死 `'web'`。
- **停止隧道后 pid 永久留在 `spawnedPids`**：主动停止也先摘 pid；重启辅助进程改用宿主实际端口。

### 供应链

- cloudflared 的 macOS 清华 bottle 源从 `verifyDigest:false` 改为「Homebrew API 取 sha256 后校验」；拿不到 digest 时显式告警只做尺寸校验（此前完全跳过）。

### 客户端 / 移动端

- 设置页：`withPending` 改引用计数（共用 `'prefs'` 时不再提前解锁）、所有 fetch 加超时、`waitForHostThenReload` 可中断（卸载/超时不再永久卡死或迟到 reload）、Esc 不冒泡一次关两层、PIN 输入框补 `autoComplete/name` 并对被过滤字符给出提示、错误文案走 locale。
- 移动端：焦点陷阱遇到「弹层对象替换」不再当成关闭（否则新弹层要等下一次 DOM 突变才有焦点约束）；注入的「复制文件」按钮与链接用 id 绑定，React 重建行时清理失配旧按钮，避免长会话里越积越多。

### 第二轮 / 第三轮追加（同日，三路对抗审查）

第二轮派了三路只读子代理逐行对抗审查（认证/隐私、settings 生命周期、客户端/移动端），第三轮按报告修复：

- **token 参数归一**：`?TOKEN=` 大写、`?token=<PIN>;foo=1` 这类值现在同样能认证、同样被剥离；地址栏清理脚本按键名小写匹配；同名参数逐个比对，只摘 PIN 不误删 dsh 启动 token。
- **隧道流量强制公网**：源地址 loopback 且带 `cf-ray`/`cf-connecting-ip` 时，即使 Host 被 ingress/反代写成 `127.0.0.1` 也按公网要求密码（此前可被伪装成本机绕过）。
- **来源分级头不可伪造**：代理先丢弃客户端自带的 `x-dsh-pocket-origin`，再按不可伪造来源重写；`classifyHost`/`isLoopbackHost` 共用 `hostNameOnly`，`127.evil.com`、尾点域名、IPv6 字面量不再被判成本机。
- **公网来源禁止更新/重启**：`pocket.update` / `pocket.restart` 增加 `forbidden`；设置页更新横幅在公网来源下不渲染。
- **回退 RPC 路径显式降级并告警**：宿主没有 `webServer.register` 时回退的 `rpc.handle` 通道拿不到请求上下文，只能按本机来源处理（与「PIN 持有者等同本机操作者」的既有承诺一致），日志会明确告警，便于确认加固为何未生效。
- **全局锁节流**：全局锁期间错误猜测要消耗 `allowCompare` 预算（每 100ms 补 1、上限 10），分布式穷举不能再无限比对。
- **settings 锁与恢复出厂**：stale 锁删不掉时不再无限忙等（会落到 deadline + sleep，实测不再 100% CPU 挂死）；恢复出厂只在持锁时删白名单派生文件，不误删 `settings.json.mybackup`、不动别人持有的 `.lock`；锁等待从 2s 降到 750ms，减少设置写入阻塞主线程。
- **恢复出厂/`.bak` 回退**：主设置文件丢失或读坏时回退读 `.bak`（此前 `.bak` 是死代码，主文件丢一次就恢复出厂、隧道 Token 也一起丢）。
- **供应链**：Homebrew bottle 拿不到 Homebrew digest 时不再回退 GitHub digest（两份构建哈希不同，回退会把正品误报「投毒」）；bottle 版本按数字段比较（`2025.10.0 > 2025.9.1`）。
- **其它**：`hostPid` 字符串形式也能被孤儿清扫识别；PIN 文件被删后会重新生成（不再被缓存永久挡住）；`inferProfile` 正则锚定到插件安装路径；移动端焦点陷阱过滤隐藏弹层、取最上层、迁移时 pop 旧 opener；LAN PIN 读取失败与「公网不显示」分开提示；bridge 500 文案不再带内部错误。

### 第四轮追加（同日，settings 生命周期对抗验证）

第四轮只读子代理针对「恢复出厂 / PIN 缓存 / 安装布局」做了双进程与真实文件系统复现，确认并修复：

- **恢复出厂不再「报成功实为撤销」**（high）：先把 `settings.json` 改名成墓碑，再删白名单派生文件；任一 `.bak`/`.tmp`（可能含 `tunnelToken`）删不掉就把墓碑改回主文件并返回失败。旧实现吞掉删除错误仍报 `settingsCleared:true`，而新加的 `.bak` 回退会在下次启动把旧配置整份复活。
- **恢复出厂拿不到锁时直接失败**（high）：另一进程正在写设置时，`resetSettings()` 返回 `false`，不再等 750ms 后无锁执行——否则对方随后整份写回，结果同样是「提示成功、实际撤销」。
- **PIN 写盘失败可自愈**：障碍（目录占用磁盘满/ACL）解除后，下一次读取会在 1s 节流内补写文件；不再出现「设置页显示 PIN-A、重启变 PIN-B、用户按页面值登录被拒」。
- **同 tick 改写**：Windows mtime 粒度内另一实例改写 PIN 时按内容比较，不再因 mtime 相同而继续用旧值。
- **pnpm 布局**：`inferProfile` 支持 `.pnpm/<pkg>@<ver>/node_modules`，一键更新不再错误地打到 `web` profile。
- **边界**：主文件为 `[]` 时视为损坏并回退 `.bak`；stale 锁删掉后仍检查等待截止时间；完全缺 `webServer` 时也打印回退告警；移动端弹层替换不再丢弃 opener（关闭后焦点回到触发按钮）；README 中英补充「手工删配置前先删 `.bak`」。

### 第五轮追加（同日，proxy 安全回归验证）

第五轮只读子代理从 48b5ea9 起逐项证伪第三轮 proxy 加固（22 种 token 变体、隧道/反代强制公网、源地址下限、`allowCompare` 接线、注入 206/4MB/压缩/无 `<head>`），确认无 high、无认证绕过、无 XSS；同时找出 4 个 low（其中 2 个是「修复未闭合的分支」）与 5 条信息，已修：

- **未保护 Host 的 PIN 剥离**（low）：`auth` 已配置但 `isProtected()=false`（本机入口、或关掉局域网密码）时，旧实现只在 protected 分支构造剥离列表 → `GET /?token=<PIN>` 的明文密码进入上游请求行/日志；HTTP 与 WS 都补齐，不认证不等于可以转发密码。
- **303 过渡页的地址栏清理**（low）：issue #91 的握手过渡页直接发 `handshakePageHtml()`，没有 scrub 脚本，PIN 留在浏览器历史；现在按 `__pocketTokenScrubbed` 注入。
- **303 分支的 `content-encoding`**（信息，pre-existing）：上游 303 带 gzip 时，明文过渡页被浏览器按 gzip 解码 → `ERR_CONTENT_DECODING_FAILED` 白屏；现在删除该头。
- **注入分支跳过 204/304**（low）：无正文响应不再被注入，避免不实 `content-length` 与丢失 `etag`/`last-modified`。
- **空 `?token` 不计数**（low）：`?token` / `?token=` 空值不再计为一次密码尝试，扫描器/截断链接不能把共享出口 IP 锁 60 秒。
- **IPv4-mapped IPv6**（信息）：`::ffff:127.0.0.1` 按嵌入的 IPv4 分类，protected 模式下本机访问不再要公网 PIN；WS 上游补 `x-dsh-pocket-origin` 与 HTTP 对齐。

## 明确不修（附理由）

- **`isLoopback` 被硬编码为 true**：真正机制是代理注入的 transport shim 把 `ownsHost` 置 true；该字段只是旧宿主兜底、项目文档自认是 UI 开关，PIN 持有者等同本机操作者是设计承诺（README 安全章节已写明）。
- **局域网 HTTP 无法给 cookie 加 `Secure`**：`http://IP` 源上加了 `Secure` 浏览器不回传，登录直接坏；改成 HTTPS 需要证书/域名，超出插件范围。已在 README 提示「不可信 WiFi 改用 HTTPS 隧道」。
- **公网访客改自己的公网 PIN**：它本来就有 DSH 全权（可执行代码读 PIN 文件），加门禁属安全剧场；局域网 PIN 的跨通道操作已封。
- **Windows `mode:0o600` 是空操作**：Node 在 Windows 不支持 POSIX 权限位，实际取决于 `$DSH_HOME` 的 NTFS ACL；已在 README 说明。
- **移动端上游 vendored 代码的 4 条 low/medium**（`style` scope 每帧唤醒、swipe disposer 结算、drawer Escape 全局判定、focus shadow 单例）：均来自 dsh-web-mobile 的上游实现，改动会在下次同步时冲突；本轮只修了 pocket 自己写的两处（F1/F3），其余记入待上游同步。
- **命名隧道把 HTTP Host Header 配成 `127.0.0.1:3081` 时公网会被判成本机**：带 Cloudflare 边缘头（`cf-ray`/`cf-connecting-ip`）的隧道流量已强制按公网处理；但如果前面还套了一层本地反代、把 `Host` 改写成 loopback 同时又没保留任何转发头（例如 `ssh -R`/`socat`/`netsh portproxy` 直转），代理无法区分来源，此时请自行确保反代层要求认证，或让反代保留 `X-Forwarded-For`（本轮已把 `x-forwarded-for`/`x-real-ip`/`forwarded` 也纳入隧道识别）。nginx 默认的 `proxy_set_header Host $proxy_host` + `X-Real-IP` 组合已按公网处理。

## 已知限制

- 来源分级依赖代理写入的 `x-dsh-pocket-origin`，而该头只在 dsh 提供 `webServer`（0.1.5+）走 HTTP 挂载时才能带到宿主。更老的 dsh 会回退到 `connection.rpc.handle` 通道，此时 handler 拿不到请求上下文，一律按 loopback 处理——这类宿主上「公网访客看不到局域网/公网 PIN」的加固不生效（但公网入口的 PIN 校验本身仍由代理负责）。回退时会打 warn 指明降级原因。能过公网 PIN 校验的人本来就可以让 DSH 执行本机代码，「设置页权限 = 本机」与 README 的既有承诺一致，因此不再用「无法区分的来源」去猜。
- 上游中断（origin 半路断开）时，代理会选择销毁客户端连接而不是转发半截正文：这是有意的（避免把不完整内容当成正常响应），代价是浏览器看到 `socket hang up`；移动端会重试。
- **限速的取舍**：单 IP 锁（60s）期间连正确 PIN 也拒绝——否则锁定窗口就是一次免费穷举窗口；全局锁期间正确 PIN 仍可登录，但比较本身受 `allowCompare` 预算（突发 10、每 100ms 补 1）约束，持续 ≥10 次/秒的攻击下合法无 cookie 用户可能间歇拿到 429（≤30s）。空 `?token` 已不计数，减少共享出口 IP 被误锁的概率。

## 验证

- `node --test --test-timeout=30000 "test/*.test.js"`：**305 tests / 303 pass / 0 fail / 2 skipped**（2 个 skip 为跨平台占位用例）。
- `npm run test:local`（真机 + 真实 Cloudflare 隧道）未执行：需要专用的 `DSH_POCKET_TEST_HOSTNAME/TOKEN/PORT` 并显式打开公网，跟本轮审计的本地回归无关；改动涉及的 LAN/公网来源分级由 `test/proxy.test.js` 与 `test/webserver-mount.test.js` 的端到端用例覆盖。
- 关键回归用例：`?token=` 三处脱敏（含同名参数只摘 PIN、保留 dsh 启动 token、大写 `?TOKEN=`、`;` 后缀）、HTML 地址栏清理脚本、WS 认证 fail-closed、全局锁期间正确密码可登录、来源分级头不可伪造（含真实 HTTP 路由端到端）、status 的 accessToken/lanToken 按来源返回、公网来源 forbidden 矩阵（含 update/restart）、fileRead 边界 fail-closed 与 4MB 上限、删除路由信任栅栏、settings 跨进程合并/恢复出厂清派生文件与保留用户备份、恢复出厂删不掉派生文件时回滚并报失败、活锁下恢复出厂直接失败、主文件为数组时回退 `.bak`、PIN 写盘失败自愈与同 tick 内容比较、`profileFromPath` 的 npm/pnpm/desktop 布局、孤儿 cloudflared 不误杀活实例（含字符串 hostPid）、端口顺延拒绝开公网、compareVersions 预发布段 semver 顺序、隧道流量（cf 头与 X-Forwarded-For）强制公网、classifyHost 边界表、Homebrew digest 不回退 GitHub、未保护 Host 的 PIN 剥离、303 过渡页清理脚本、304 不改写、空 token 不计数、IPv4-mapped 分类。

## 复现脚本

审计期的探针脚本在 `%TEMP%`（未入库）：`probe-token-leak*.mjs`（PIN 泄漏）、`probe-ads.mjs`（NTFS ADS）、`probe-abort2.mjs`（上游中断行为）；代理审计的 `a1..a4.mjs`、fileRead/删除路由的 `fr2.mjs`/`droute.mjs` 等在 `C:\Users\Public\dsh-pocket-audit\`。
