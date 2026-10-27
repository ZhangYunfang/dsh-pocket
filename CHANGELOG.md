## [3.0.7](https://github.com/daha1216/dsh-pocket/compare/v3.0.6...v3.0.7) (2026-10-27)

> 第五轮对抗验证（proxy 安全回归，48b5ea9 → 9af15ca）后的补丁，完整记录见 [docs/security-audit-2026-10-27.md](./docs/security-audit-2026-10-27.md)。

### Security

* **proxy:** 已配置密码但当前 Host 不受保护（本机入口 / 关掉局域网密码）时，分享链接里的 `?token=<PIN>` 现在也会在转发前剥离——旧实现只在受保护 Host 上构造剥离列表，明文密码会进上游访问日志与地址栏；HTTP 与 WS 两条通道都补了 `__pocketTokenScrubbed` 标记
* **proxy:** issue #91 的 303 握手过渡页也注入地址栏清理脚本，PIN 不再留在浏览器历史；同时删除上游 303 的 `content-encoding`，避免明文过渡页被按 gzip 解码成白屏
* **proxy:** HTML 注入跳过 204/304（无正文响应），不再写出与实际不符的 `content-length`、不再清掉 304 的 `etag`/`last-modified` 缓存验证器
* **proxy:** `?token` / `?token=` 空值不再计为一次密码尝试——扫描器或截断的分享链接不能把共享出口 IP 锁 60 秒

### Bug Fixes

* **proxy:** `::ffff:127.0.0.1` 这类 IPv4-mapped IPv6 字面量按嵌入的 IPv4 分类，protected 模式下本机访问不再被要求公网 PIN
* **proxy:** WS 上游握手补 `x-dsh-pocket-origin`，与 HTTP 侧来源分级保持一致
* **test:** 新增未保护 Host 的 PIN 剥离、303 过渡页清理脚本、304 不改写、空 token 不计数、IPv4-mapped 分类 5 条回归

## [3.0.6](https://github.com/daha1216/dsh-pocket/compare/v3.0.5...v3.0.6) (2026-10-27)

> 第四轮对抗验证（settings 生命周期 / PIN 缓存 / pnpm 安装布局）后的补丁，完整记录见 [docs/security-audit-2026-10-27.md](./docs/security-audit-2026-10-27.md)。

### Security

* **settings:** 恢复出厂改为「持锁 + 墓碑回滚」：先把 `settings.json` 改名成墓碑、删完全部派生文件后才丢弃；任一派生文件（`.bak`/`.tmp`，可能含 `tunnelToken`）删不掉就回滚主文件并返回失败。旧实现吞掉删除错误仍报成功，主文件缺失时新加的 `.bak` 回退会让旧配置整份复活，恢复出厂形同虚设
* **settings:** 恢复出厂拿不到锁（另一进程正在写）时直接返回失败，不再等 750ms 后无锁执行——否则另一进程随后整份写回，同样变成「提示成功、实际撤销」

### Bug Fixes

* **index:** PIN 写盘失败后障碍解除会自动补写（每秒最多试一次），不再出现「设置页显示 PIN-A、重启后变 PIN-B、用户按页面上的值登录被拒」；Windows 同 tick 改写按内容判定，不再因 mtime 相同而认旧值
* **index:** `inferProfile` 支持 pnpm 的 `.pnpm/<pkg>@<ver>/node_modules` 布局，一键更新不再错误地打到 `web` profile
* **settings:** 主文件是数组（`[]`）时视为损坏并回退 `.bak`（旧实现把数组当有效配置，整份落默认值）；stale 锁删掉后仍会检查等待截止时间，避免对手反复重建过期锁时无限循环
* **rpc:** 回退 `rpc.handle` 的降级告警在完全缺 `webServer` 时也会打印，排障时能看到公网语义为何降级
* **mobile:** 弹层「替换」时保留 opener，关闭后焦点仍回到最初的触发按钮（上一版 pop 掉 opener 会让焦点落回 body）
* **docs:** README 中英文补充「手工删配置前先删 `.bak`，恢复出厂请用设置页按钮」

## [3.0.5](https://github.com/daha1216/dsh-pocket/compare/v3.0.4...v3.0.5) (2026-10-27)

> 第二轮/第三轮对抗审查（认证隐私、settings 生命周期、客户端/移动端三路只读审计）后的补丁，完整记录见 [docs/security-audit-2026-10-27.md](./docs/security-audit-2026-10-27.md)。

### Security

* **proxy:** `?TOKEN=` 大写、`?token=<PIN>;foo=1` 这类变体现在同样能认证、同样在转发前剥离；地址栏清理脚本按键名小写匹配，同名参数只摘 PIN、不误删 dsh 启动 token
* **proxy:** 源为 loopback 且带 `cf-ray`/`cf-connecting-ip`/`X-Forwarded-For`/`X-Real-IP`/`Forwarded` 的请求强制按公网判定——命名隧道或本地反代把 Host 改写成 `127.0.0.1` 不再能把公网入口降级成免密本机
* **proxy:** `classifyHost`/`isLoopbackHost` 共用同一套归一化（`127.evil.com`、`127.0.0.1.`、IPv6 字面量不再误判）；全局锁期间错误猜测要消耗比较预算，分布式穷举失去无限比对
* **rpc:** 公网来源禁止 `update`/`restart`（会拉 npm 包并重启宿主），设置页更新横幅在公网来源下不渲染；回退 `rpc.handle` 通道对无请求上下文的宿主显式告警降级原因
* **settings:** 恢复出厂改为持锁 + 白名单删除（不再误删 `settings.json.mybackup` 或别人持有的 `.lock`）；stale 锁删不掉时不再无限忙等；主文件损坏/丢失时回退读 `.bak`
* **tunnel:** Homebrew bottle 拿不到 Homebrew digest 时不再回退 GitHub digest（两份构建哈希不同，会把正品误报「投毒」）；bottle 版本按数字段比较

### Bug Fixes

* **settings:** 锁等待从 2s 降到 750ms，减少设置写入阻塞主线程
* **service:** 字符串形式的 `hostPid` 也能被孤儿清扫识别，不再误杀共用 `$DSH_HOME` 的活实例
* **index:** PIN 文件被删后会重新生成（不再被缓存永久挡住）；`inferProfile` 锚定到插件安装路径，避免 `DSH_HOME` 路径含 `profiles` 时更新错目标
* **mobile:** 焦点陷阱过滤隐藏/inert 弹层并取最上层，弹层替换时 pop 旧 opener；文件复制按钮与链接按 id 清理失配项
* **client:** 公网来源不显示更新/重启按钮；LAN PIN 读取失败与「公网不显示」分开提示；bridge 500 文案不再带内部错误细节

## [3.0.4](https://github.com/daha1216/dsh-pocket/compare/v3.0.3...v3.0.4) (2026-10-27)

> 完整记录见 [docs/security-audit-2026-10-27.md](./docs/security-audit-2026-10-27.md)。

### Security

* **proxy:** `?token=` 认证通过后从上游请求行 / 子资源 `Referer` / 访问日志中剥离明文 PIN，并在首屏 HTML 注入 `history.replaceState` 清掉地址栏里的密码
* **proxy:** 限速器区分单 IP 锁与全局锁——全局锁期间正确密码仍可登录，未认证请求不能再靠打满失败次数把主人永久锁在门外；WS 认证与 HTTP 对齐 fail-closed
* **proxy:** 认证后按不可伪造来源（loopback/lan/public）写入 `x-dsh-pocket-origin`；`status` 只向 loopback 回传公网 PIN、不向公网回传局域网 PIN
* **rpc:** 公网来源禁止刷新/开关局域网、禁止改隧道配置与启停隧道、禁止恢复出厂（服务端 `forbidden`，设置页同步隐藏）
* **rpc:** fileRead 工作区边界改为 fail-closed（枚举失败/为空/形状异常一律拒绝），扩充凭据黑名单，非字符串路径 400，错误文案不再回显绝对路径
* **delete:** 删除路由改用宿主 `connection.requestRejection`（含浏览器认证），无该方法才回退 Host/Origin 检查
* **bin:** CLI 与插件统一 8 位 PIN 下限；拒绝 `--public` + `--no-auth`；`--pin` 缺值不再吞掉下一个 flag；纯空白 PIN 报错
* **tunnel:** macOS 清华 bottle 源改为用 Homebrew API 的 sha256 校验，拿不到 digest 时显式告警（此前该源完全跳过校验）

### Bug Fixes

* **proxy:** 给 `session/list` 请求体与响应、HTML 注入分支加缓冲上限/解压上限，避免单请求让宿主涨 150MB 级内存或被解压炸弹打爆
* **settings:** 恢复出厂清掉 `.bak/.tmp/.lock`，不再残留含 `tunnelToken` 的临时文件
* **service:** `tunnel-auto.json` 记录宿主 pid，孤儿清扫不再误杀共用 `$DSH_HOME` 的另一个实例正在用的 cloudflared；端口顺延后拒绝开公网；主动停止隧道时同步摘掉 spawnedPids
* **index:** PIN 原子写 + 按 mtime 失效缓存；更新超时用 `taskkill /T` 杀整棵进程树；fork 守卫校验 registry 响应状态，探测失败不再放行覆盖本地 fork
* **restart:** 交接辅助进程使用宿主实际端口，不再因 argv 缺 `--port` 回退 3080 白等 20s
* **client:** `withPending` 引用计数、fetch 超时、`waitForHostThenReload` 可中断、Esc 不冒泡；PIN 输入框补 autocomplete 并对被过滤字符提示
* **mobile:** 弹层被替换时焦点陷阱直接迁移而不是当成关闭；文件复制按钮与链接绑定 id，React 重建后清理失配按钮

## [3.0.3](https://github.com/daha1216/dsh-pocket/compare/v3.0.2...v3.0.3) (2026-10-27)

> 3.0.0–3.0.2 是 named-only 安全加固线（关闭 semantic-release 的 npm 发布后未再生成条目），本版起恢复手写记录。

### Bug Fixes

* **service:** 引入卸载门与代理世代号，消除启停竞态——dispose 后在途的 createProxy 落地会自行关闭，不再留下插件卸载后仍在监听的端口；startTunnel 提前建 AbortController，代理启动窗口内 stopTunnel 能真正取消
* **service:** 隧道 onExit 按对象身份比对，上一代进程的迟到退出不再把刚起来的隧道从状态里抹掉
* **delete:** 删除会话在 payload 改名或目录搬迁半途失败时逆序回滚，"删除失败"不再等于会话凭空消失（既扫不到也恢复不了）
* **tunnel:** cloudflared 下载改为比对 GitHub Release 资产的 sha256 digest，镜像投毒/中间人可被识别并丢弃；API 不可达时降级为尺寸校验但显式告警，不再只验"大于 1MB"
* **proxy:** WebSocket 心跳只在帧边界插入 Ping，控制帧不再落进大消息 payload 触发浏览器 1002 断开
* **proxy:** 206 分片响应不再套 Content-Encoding；带失效 cookie 走 `?token=` 时正确换发，不必手清 cookie
* **proxy:** session/list 瘦身缓存加条目与字节预算，缓存键去掉 rpcId（命中时回填当前 rpcId），真实客户端能命中
* **rpc:** fileRead 相对路径按会话 `header.cwd` 解析，多工作区下不再读错项目；realpath 之后再判敏感路径与工作区边界
* **settings:** 设置文件 rename 退路不再先删目标文件（失败可恢复）；PIN 写盘失败、恢复出厂不完整都会在设置页告警，不再宣称已保存
* **mobile:** `?dsh-layout=auto` 成为权威不被残留 localStorage 覆盖；复制文件改用会话 provenance；fileGuard 在两个 await 后复查 active；设置页轮询丢弃乱序旧快照；捏合只拦放大、缩小永远放行；上游弹层补焦点约束与焦点归还

## [2.10.6](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.5...v2.10.6) (2026-09-10)


### Bug Fixes

* **mobile:** 替换手机端模型设置加载失败提示为引导信息，增加本地真机冒烟测试 ([5ab2ad4](https://github.com/shaobeichen/dsh-pocket/commit/5ab2ad444ba276c5df2bf87fa104c4b16b2081f9))

## [2.10.5](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.4...v2.10.5) (2026-09-10)


### Bug Fixes

* **rpc:** 以方法形式调用 requestRejection 保留 this 绑定，修复 /dsh-pocket/* 全部 403（issue [#117](https://github.com/shaobeichen/dsh-pocket/issues/117)） ([282f71c](https://github.com/shaobeichen/dsh-pocket/commit/282f71c1d844b0e6123b9c976ad0401c3c4a84e7))

## [2.10.4](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.3...v2.10.4) (2026-09-10)


### Bug Fixes

* **client:** prevent iOS Safari input auto-zoom on mobile ([8d5b3fa](https://github.com/shaobeichen/dsh-pocket/commit/8d5b3fa1a14385816e61f92bd83fb239f7d8e74f)), closes [#114](https://github.com/shaobeichen/dsh-pocket/issues/114)
* **mobile:** 侧边栏先开后弹出 aria-modal 弹窗时自动收起，修复卡死 ([#99](https://github.com/shaobeichen/dsh-pocket/issues/99)) ([f2e60b0](https://github.com/shaobeichen/dsh-pocket/commit/f2e60b0eb03ac1b065788e231590a56316a7cfcf))
* **proxy:** shim transport.createApiClient for dsh 0.1.1-rc.2 (issue [#96](https://github.com/shaobeichen/dsh-pocket/issues/96)) ([61cadf8](https://github.com/shaobeichen/dsh-pocket/commit/61cadf871ec817f51135277b7fb3085d9492959e))
* **proxy:** 移除与 DSH Desktop 2.0.4+ 不兼容的 LOOPBACK_ENV_PATCH，修复远程/手机访问白屏 ([#105](https://github.com/shaobeichen/dsh-pocket/issues/105)) ([a1b813d](https://github.com/shaobeichen/dsh-pocket/commit/a1b813d854da5900b55c5893f3190a272cd4a0fc)), closes [#100](https://github.com/shaobeichen/dsh-pocket/issues/100) [#58](https://github.com/shaobeichen/dsh-pocket/issues/58)
* **rpc:** 适配 dsh v0.1.5-alpha.1 的 webServer inject 收缩，堵住启动崩溃 ([#112](https://github.com/shaobeichen/dsh-pocket/issues/112)) ([2ac8efd](https://github.com/shaobeichen/dsh-pocket/commit/2ac8efdb46de19959c1fc59eeddf2f12b42cb909)), closes [#109](https://github.com/shaobeichen/dsh-pocket/issues/109) [#113](https://github.com/shaobeichen/dsh-pocket/issues/113) [#111](https://github.com/shaobeichen/dsh-pocket/issues/111)
* **security:** 收紧限速身份键与登录比较，修隧道失败态残留，移除已删功能的 README 残留 ([517eb00](https://github.com/shaobeichen/dsh-pocket/commit/517eb004ce869f5e140159dfa118ab833a37fd6c)), closes [#69](https://github.com/shaobeichen/dsh-pocket/issues/69)
* **tunnel:** 进程退出不再清除自动恢复标记，修复重启后公网隧道不自动恢复 ([#107](https://github.com/shaobeichen/dsh-pocket/issues/107)) ([db1e5c4](https://github.com/shaobeichen/dsh-pocket/commit/db1e5c418cae91ae1e56f4d6c5c05413ddea02c2)), closes [#11](https://github.com/shaobeichen/dsh-pocket/issues/11) [#106](https://github.com/shaobeichen/dsh-pocket/issues/106)

## [2.10.3](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.2...v2.10.3) (2026-09-03)


### Bug Fixes

* **security:** CLI 模式默认开启访问密码，堵住 0.0.0.0 上的无认证访问（issue [#90](https://github.com/shaobeichen/dsh-pocket/issues/90) [#8](https://github.com/shaobeichen/dsh-pocket/issues/8)） ([5d3a6d0](https://github.com/shaobeichen/dsh-pocket/commit/5d3a6d03e4e1c4fe84626fd3dfd7a4fec28641cc))

## [2.10.2](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.1...v2.10.2) (2026-09-03)


### Bug Fixes

* **mobile:** restore compact usable composer ([#89](https://github.com/shaobeichen/dsh-pocket/issues/89)) ([#93](https://github.com/shaobeichen/dsh-pocket/issues/93)) ([5c56d24](https://github.com/shaobeichen/dsh-pocket/commit/5c56d24c2953022c4300973627dae4d3aebcfbb2))
* **mobile:** snap composer popups to viewport sheet; scroll containers clipped them half-visible on phones ([#88](https://github.com/shaobeichen/dsh-pocket/issues/88)) ([7209de8](https://github.com/shaobeichen/dsh-pocket/commit/7209de8540cf324dd578b18f10bec6b1ff8ea3c4))
* **mobile:** 触摸切换会话等宿主完成导航后再关抽屉 ([#85](https://github.com/shaobeichen/dsh-pocket/issues/85)) ([80b9d16](https://github.com/shaobeichen/dsh-pocket/commit/80b9d16369e3e33457afe8d9c1a48dfa42dc4397)), closes [#84](https://github.com/shaobeichen/dsh-pocket/issues/84)
* **proxy:** loopback trust patch so remote browsers can load settings (issue [#58](https://github.com/shaobeichen/dsh-pocket/issues/58)) ([#87](https://github.com/shaobeichen/dsh-pocket/issues/87)) ([1d67152](https://github.com/shaobeichen/dsh-pocket/commit/1d67152a8a1808d36743162ff24abe3a061cedcd))
* **security:** 堵住 ?token=/WS 的限速旁路，PIN 改 CSPRNG，Host 头伪造按源地址收紧（issue [#90](https://github.com/shaobeichen/dsh-pocket/issues/90)） ([0bfe15a](https://github.com/shaobeichen/dsh-pocket/commit/0bfe15a56c2063e14f1eea5de2ef0cd4e1e54b0d))

## [2.10.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.10.0...v2.10.1) (2026-09-03)


### Bug Fixes

* **proxy:** 打断 Safari 局域网入口的 303 无限重定向（issue [#91](https://github.com/shaobeichen/dsh-pocket/issues/91)） ([4dd4c01](https://github.com/shaobeichen/dsh-pocket/commit/4dd4c017d5ad4b11ac003058dbda1d8d6507f079))

# [2.10.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.9.1...v2.10.0) (2026-08-30)


### Features

* **security:** 移除会话指纹防钓鱼机制（issue [#82](https://github.com/shaobeichen/dsh-pocket/issues/82)/[#83](https://github.com/shaobeichen/dsh-pocket/issues/83) 后续） ([8f91960](https://github.com/shaobeichen/dsh-pocket/commit/8f91960a8379ac7ec16a7c3577ff0134cb2f6204))

## [2.9.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.9.0...v2.9.1) (2026-08-30)


### Bug Fixes

* **security:** 防钓鱼校验只在公网启用，局域网不再误报（issue [#83](https://github.com/shaobeichen/dsh-pocket/issues/83)） ([059163e](https://github.com/shaobeichen/dsh-pocket/commit/059163e26457a15a9f9ce1b21aea539db9ecb803))

# [2.9.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.8.0...v2.9.0) (2026-08-30)


### Bug Fixes

* **auth:** Tailscale/CGNAT(100.64/10) 与手动局域网地址覆盖走局域网密码（issue [#79](https://github.com/shaobeichen/dsh-pocket/issues/79)） ([e3c2e7b](https://github.com/shaobeichen/dsh-pocket/commit/e3c2e7b97700b375bdc17a68ed3523588796ba21)), closes [#66](https://github.com/shaobeichen/dsh-pocket/issues/66)
* **tunnel:** 把 --no-autoupdate 移到全局位置，兼容 cloudflared 2026.x（issue [#78](https://github.com/shaobeichen/dsh-pocket/issues/78)） ([4abc6b9](https://github.com/shaobeichen/dsh-pocket/commit/4abc6b9f9400443bc691d52e7e13c2f7b93aee58))


### Features

* **proxy:** 上游桌面门禁 403 forbidden 对导航请求返回可操作提示页（issue [#81](https://github.com/shaobeichen/dsh-pocket/issues/81)） ([ff003b6](https://github.com/shaobeichen/dsh-pocket/commit/ff003b66a63f55eebc10b4b96f06b2b1984fdc8c))
* **security:** 公网会话指纹 + 链接 ephemeral 提示，防快速隧道子域复用跳陌生站点（issue [#82](https://github.com/shaobeichen/dsh-pocket/issues/82)） ([5bfc039](https://github.com/shaobeichen/dsh-pocket/commit/5bfc0399a1c4d6765fdc815043b6861b08ad5267))

# [2.8.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.7.1...v2.8.0) (2026-08-29)


### Bug Fixes

* **mobile:** 去掉 isInsidePocket 误杀，让对话文件链接在手机上弹提示并注入复制按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)） ([5fca020](https://github.com/shaobeichen/dsh-pocket/commit/5fca0202623df513e11b4654868210f287ea6ffd))


### Features

* **mobile:** 文件链接旁「复制」按钮经主机 RPC 读取正文（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17) 内容复制） ([06f69fd](https://github.com/shaobeichen/dsh-pocket/commit/06f69fdef5fd1706846d433ece8bc10944549563))

## [2.7.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.7.0...v2.7.1) (2026-08-29)


### Bug Fixes

* **mobile:** 移动端拦截文件链接点击改提示、隐藏添加工作区，移除冗余复制按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)） ([96ed896](https://github.com/shaobeichen/dsh-pocket/commit/96ed896201045b009068b198e6f5f444a43cfb23))

# [2.7.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.3...v2.7.0) (2026-08-29)


### Features

* **mobile:** 文件块支持「复制内容」按钮（issue [#17](https://github.com/shaobeichen/dsh-pocket/issues/17)），移除放大输入 ([c7351ac](https://github.com/shaobeichen/dsh-pocket/commit/c7351acefb8f78b2c26218d812d59a648cd22c7d))

## [2.6.3](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.2...v2.6.3) (2026-08-29)


### Bug Fixes

* 移除临时访问 PIN 功能并修复撤销时的崩溃 ([238864c](https://github.com/shaobeichen/dsh-pocket/commit/238864c92999f73b2a42c103163180053fd10c49)), closes [#69](https://github.com/shaobeichen/dsh-pocket/issues/69)

## [2.6.2](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.1...v2.6.2) (2026-08-29)


### Bug Fixes

* **client:** 补上 MobileComposerFullscreen 缺的 import（P0） ([a71319d](https://github.com/shaobeichen/dsh-pocket/commit/a71319dd66f6b3e70a8f904ce3dca236e6615dbd))

## [2.6.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.6.0...v2.6.1) (2026-08-29)


### Bug Fixes

* **tunnel:** linux 改用裸二进制，不再下载上游已下架的 .tgz (issue [#45](https://github.com/shaobeichen/dsh-pocket/issues/45)) ([26bdb69](https://github.com/shaobeichen/dsh-pocket/commit/26bdb69a9dc8480c67d99bc4dba76fcdc79052e0))

# [2.6.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.5.1...v2.6.0) (2026-08-29)


### Features

* **mobile:** 'expand composer' button on phone (issue [#23](https://github.com/shaobeichen/dsh-pocket/issues/23)) ([ec6f115](https://github.com/shaobeichen/dsh-pocket/commit/ec6f115655964fca882df1e99171cbb5fc59efab))

## [2.5.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.5.0...v2.5.1) (2026-08-29)


### Bug Fixes

* **proxy:** support `?token=<raw pin>` and seed the auth cookie (issue [#35](https://github.com/shaobeichen/dsh-pocket/issues/35)) ([734afbd](https://github.com/shaobeichen/dsh-pocket/commit/734afbdb800ed4b2a1d4dff085cdf2ef074917db))

# [2.5.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.4.0...v2.5.0) (2026-08-29)


### Bug Fixes

* **proxy:** 转发前清掉历史遗留的 dsh-desktop-* 参数 (issue [#75](https://github.com/shaobeichen/dsh-pocket/issues/75)) ([8979594](https://github.com/shaobeichen/dsh-pocket/commit/89795940e2aeb28675b79a1541862331fe3aef5f))


### Features

* **tunnel:** honor a custom cloudflared path (issue [#45](https://github.com/shaobeichen/dsh-pocket/issues/45)) ([b9c0c9f](https://github.com/shaobeichen/dsh-pocket/commit/b9c0c9f0ea37aecdcf004fccfb9e0f5bfc1fd381)), closes [#proxy](https://github.com/shaobeichen/dsh-pocket/issues/proxy)

# [2.4.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.3.0...v2.4.0) (2026-08-29)


### Features

* **auth:** temporary access PINs with auto-expiry (issue [#69](https://github.com/shaobeichen/dsh-pocket/issues/69)) ([965195e](https://github.com/shaobeichen/dsh-pocket/commit/965195e21841e3cfba719e6d6bf6424036e149ad))

# [2.3.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.2.0...v2.3.0) (2026-08-29)


### Features

* **proxy:** make the proxy port configurable from settings.json (issue [#70](https://github.com/shaobeichen/dsh-pocket/issues/70)) ([20bb1b5](https://github.com/shaobeichen/dsh-pocket/commit/20bb1b50eaa06a0d7070e97f516cc44d3cdc475b))

# [2.2.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.4...v2.2.0) (2026-08-29)


### Features

* **mobile:** add layout mode switch for wide-screen phones (issue [#74](https://github.com/shaobeichen/dsh-pocket/issues/74)) ([018aef0](https://github.com/shaobeichen/dsh-pocket/commit/018aef0db644093a13d6cb1db427655138c86799))

## [2.1.4](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.3...v2.1.4) (2026-08-29)


### Bug Fixes

* **mobile:** 抽屉层级压过 dsh-web-ui-all 的全屏遮罩 (issue [#67](https://github.com/shaobeichen/dsh-pocket/issues/67)) ([88605d9](https://github.com/shaobeichen/dsh-pocket/commit/88605d93a145af61e345f91b96db2850bb8f1e56))

## [2.1.3](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.2...v2.1.3) (2026-08-29)


### Bug Fixes

* **mobile:** 抽屉里的工作区菜单点不动，并给 iOS 触摸加自愈 (issue [#72](https://github.com/shaobeichen/dsh-pocket/issues/72)) ([9f7c427](https://github.com/shaobeichen/dsh-pocket/commit/9f7c4279049c499f2f33b6ded45f2bd92625b476))

## [2.1.2](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.1...v2.1.2) (2026-08-29)


### Bug Fixes

* **desktop:** stop injecting dsh-desktop-* markers into proxied pages ([17c2d97](https://github.com/shaobeichen/dsh-pocket/commit/17c2d97e6c2da5951a11e171efdd1e436184b04c)), closes [3/#4](https://github.com/shaobeichen/dsh-pocket/issues/4)

## [2.1.1](https://github.com/shaobeichen/dsh-pocket/compare/v2.1.0...v2.1.1) (2026-08-29)


### Bug Fixes

* **proxy:** complete the dsh web browser-session handshake (issue [#77](https://github.com/shaobeichen/dsh-pocket/issues/77)) ([ffc12dd](https://github.com/shaobeichen/dsh-pocket/commit/ffc12ddfcd2113ee4ba80424b2346efee85c0c0f))

# [2.1.0](https://github.com/shaobeichen/dsh-pocket/compare/v2.0.0...v2.1.0) (2026-08-29)


### Bug Fixes

* **ui:** center the toast and narrow it to 280px ([2bcaff0](https://github.com/shaobeichen/dsh-pocket/commit/2bcaff0a3db7847f4cc9941293026ab78b1398c4))
* **ui:** show only the current language half of backend error messages ([bd79283](https://github.com/shaobeichen/dsh-pocket/commit/bd79283d5bad1888933a9fceda886204f59d450c))


### Features

* **pocket:** factory reset entry at the bottom of the settings page ([672b31b](https://github.com/shaobeichen/dsh-pocket/commit/672b31ba04083e4223c15ef1f326fab9a6e5faf7))
* **ui:** toast feedback after factory reset ([074744d](https://github.com/shaobeichen/dsh-pocket/commit/074744d2524584e48de19fdc1b301e85cbd7623e))

# [2.0.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.16.1...v2.0.0) (2026-08-29)


* feat!: redesign settings page layout into structured cards ([1b7d494](https://github.com/shaobeichen/dsh-pocket/commit/1b7d494554ed80eadd701c1e2574760ff130580c))


### BREAKING CHANGES

* the settings page DOM structure and locale keys changed
(lanAddressHint removed; wanAccess/pinLabel/modeLabel/advAddress/
wanOffHint added). Custom styles or scripts targeting the old settings
DOM/keys need updating.

## [1.16.1](https://github.com/shaobeichen/dsh-pocket/compare/v1.16.0...v1.16.1) (2026-08-29)


### Bug Fixes

* **ui:** mode selector only after public access enabled; selected-state highlight; drop lan address hint ([cf6abc0](https://github.com/shaobeichen/dsh-pocket/commit/cf6abc091ac398158e9e8213d9bddcf554b8f87a)), closes [#66](https://github.com/shaobeichen/dsh-pocket/issues/66)

# [1.16.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.15.0...v1.16.0) (2026-08-29)


### Features

* **tunnel:** named tunnel mode (fixed public hostname) + fail-closed host trust boundary ([a7bf98e](https://github.com/shaobeichen/dsh-pocket/commit/a7bf98e54b25e59d03c6dc03c08bc2b4a74d84f5))

# [1.15.0](https://github.com/shaobeichen/dsh-pocket/compare/v1.14.5...v1.15.0) (2026-08-29)


### Bug Fixes

* **ci:** drop setup-node registry-url to avoid .npmrc conflict with semantic-release ([bb41482](https://github.com/shaobeichen/dsh-pocket/commit/bb41482cf499533741cd22a28b5004be253d4f4f))


### Features

* **pin:** allow 8-char alphanumeric custom PINs (letters + digits) ([527abba](https://github.com/shaobeichen/dsh-pocket/commit/527abbac7097a4b7748180ec093f6d5f48a8ce39)), closes [#33](https://github.com/shaobeichen/dsh-pocket/issues/33)
