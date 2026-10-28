# MERGE.md — 融合说明（v1a + v1b → 本仓）

> 本仓库是**融合版**：把两个同源 fork 的能力合并成一个可维护的项目。
> 上游两个来源与融合决策记录在此，便于后续同步上游与回溯。

## 1. 三个仓库的关系

| 角色 | 仓库 | 版本 | 最新提交 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **上游 A** | [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket) | 2.12.0 | `aee3ae7` (2026-10-17) | 原始项目。2474★ / 106 fork / 116 tag，`Quick Tunnel` 一键公网、精简手写移动层 |
| **上游 B** | [daha1216/dsh-pocket](https://github.com/daha1216/dsh-pocket) | 3.0.3 | `be056de` (2026-10-27) | A 的 fork。镜像 dsh-web-mobile v3.2.0（15,823 行）、会话删除、sha256 供应链校验、静态 SW；**删除了 Quick Tunnel** |
| **本仓** | ZhangYunfang/dsh-pocket | **3.1.0** | 本文所在提交 | **以 B 为基线**，回补 A 的 Quick Tunnel，并放开 DSH 版本闸门 |

三者同源：首个 commit 均为 `d6dc160`（2026-08-15）；A↔B 的 merge-base 为 `d2e0b46`（2026-09-17）。

```
d6dc160 (2026-08-15, 三者共同首 commit)
   │
 d2e0b46 (2026-09-17)  ← A/B merge-base
   │
   ├── A 继续 14 个 commit ──→ aee3ae7 (2.12.0, 2026-10-17)
   │
   └── B 分叉 44 个 commit ──→ be056de (3.0.3, 2026-10-27)
                                 │
                                 └── 本仓 3.1.0（融合）
```

## 2. 为什么以 B 为基线

对 A 独占的 14 个 commit 逐条核实后确认：**B 是一个「除 Quick Tunnel 外的功能超集」**。

| A 独占 commit | 在 B 中的状态 | 证据 |
| :--- | :--- | :--- |
| `41245a9` 用 Electron 运行时特征判定 isDesktop | ✅ 已含（代码逐字一致） | `lib/index.js:334-339` |
| `41245a9` 桌面宿主自重启守卫 | ✅ 已含（逐字一致） | `lib/restart.js:104-107` |
| `8b9c27a` PIN 自动填充 + 密码可见性 | ✅ 已含 | `lib/proxy.mjs`：`pin-toggle` 6 处 / `implicit-username` 2 处 / `sr-only` 2 处 |
| `c6e2ce1` 允许清除自定义 PIN | ✅ 已含（逐字一致） | `lib/index.js:190-196` |
| `8e60d4e` stats band opt-out 让位 | ✅ 已含（迁移到 upstream 样式层） | `client/mobile/upstream/styles/{compat,misc,layout}.css.ts` |
| `dc9d5dc` 手机工作区图标兼容层 | ✅ 已含（迁移） | `client/mobile/upstream/core/icon-compat.ts` |
| `9f91e54` 隧道剥离本机代理 env | ✅ 已含 | `lib/proxy.mjs:265` + `lib/tunnel.mjs` `cloudflaredEnv()` |
| `48297a7` 远程访问可用「设置→模型」 | ✅ 已含 | `transport-shim` 注入 |
| `a80c5d3` 排除 Windows ICS 虚拟网卡 | ✅ 已含 | `lib/service.mjs` `selectLanIPv4` 与 A 逐字节相同 |
| `d917a77` locale 命名冲突 + stats 作用域 | ✅ 已含（重构后） | `upstream/i18n/locales.ts` + `upstream/effects/stats-line.ts` |
| `f24c6de` 设置页开关圆钮硬编码 `#fff` | ✅ 问题形态不存在（B 已换成 token 化的 `.dshp-switch`） | `client/index.jsx:187-192` |
| `db1ddaf` 360px composer 底栏允许换行 | ⚠️ 架构不同（B 用 `:has()` 选择器，无 `nowrap` + `:last-child{flex:1 1 0}` 的挤压规则） | `upstream/styles/layout.css.ts:589+`；**建议真机验证 360px 下模型药丸不被压扁** |
| `e6424c3` / `aee3ae7` / `fa0c746` | — 版本发布 / 重建产物，无需移植 | — |

结论：只需要回补 **Quick Tunnel** 一条通道，其余不必重做。

## 3. 本仓相对 B 的改动（3.0.3 → 3.1.0）

### 3.1 回补 Quick Tunnel（核心改动）

| 文件 | 改动 |
| :--- | :--- |
| `lib/tunnel.mjs` | 新增 `QUICK_TUNNEL_URL_RE` 导出与 `startQuickTunnel()`（+132 行）；`--protocol auto`（与 named 统一，`auto` 会预检后自选 quic/http2，绕开两个方向的封锁） |
| `lib/service.mjs` | `startTunnel` 按 `mode` 分派 quick/named；quick 分支要求代理已启动并传 `proxy.port`；`persistAutoTunnel(pid, mode)` 写入真实通道；`onTunnelReady(mode)`；自动恢复改为「marker 模式与当前模式一致才恢复」；`status().tunnelConfig.mode` 回真实值 |
| `lib/settings.mjs` | `tunnelMode()` 默认 `quick`，并对「无存盘模式但已有完整命名配置」推断为 `named`（避免把老 setup 静默切成随机域名）；`setTunnelMode()` 接受 `quick\|named`；`tunnelAutoRestoreEnabled()` 两条通道都允许；`setNamedTunnelConfig()` 收紧为 **named-only**（切模式走 `setTunnelMode`，防止两条路径混淆） |
| `lib/index.js` | `onTunnelReady(mode)`：quick 每次开启轮换公网 PIN，named 不轮换（上游 A 语义）；`setTunnelConfig` 支持 `{mode:'quick'}` 与 `{mode:'named',hostname,token}` 两条路径；named 先完整校验再落盘（失败不留半配状态） |
| `bin/dsh-pocket.mjs` | 新增 `--quick`；`--public` 仍是自配固定域名；两者都进二维码（`entryUrl(tunnel.url, pin)`）；帮助文本同步 |
| `client/index.jsx` | 设置页公网区块新增**通道选择器**（`.dshp-modes` / `.dshp-mode-opt`）；`doStartTunnel`/`startTunnel` 前置条件按通道区分；quick 显示专属说明与运行提示；补充 `pending.saveMode` 防连点 |
| `client/pocket-locales.js` | 中文/英文各新增 8 条：`modeQuick/modeQuickDesc/modeNamed/modeNamedDesc/quickHow/quickOffHint/quickWanHint/quickRunningHint` |
| `client/api.js` | `redactStatus` 的 `tunnelConfig` 默认值 `named` → `quick` |
| `client/client.js` | 用 esbuild 0.25.12 重新构建（源码与产物必须同源） |

### 3.2 放开 DSH 版本闸门

```diff
   "engines": {
-    "node": ">=22",
-    "dsh": "^0.2.0-rc.1"
+    "node": ">=22",
+    "dsh": ">=0.1.2-alpha.2 <0.3.0"
   }
```

> B 声明 `^0.2.0-rc.1` 的依据见其 commit `4c42dbd`：原文是「此前两者都没有，等于对宿主版本零要求：装在 0.1.x 上照样『安装成功』，再在运行时才炸」——**那是一条防呆闸门，不是代码真的只支持 0.2.x**。
> 本仓把范围放宽到 `>=0.1.2-alpha.2 <0.3.0`。是否真的能在 0.1.2 上跑通仍需实测，见 `docs/DSH-0.1.2-适配计划.md`。

### 3.3 测试契约同步（v1b 的 17 个红全部转绿）

B 的测试把「quick 已移除」写死成契约，融合后必然失败。已按新契约改写：

| 文件 | 改动 |
| :--- | :--- |
| `test/settings.test.js` | 默认模式断言 `named`→`quick`；`setTunnelMode` 双向可切；新增「无存盘模式 + 完整命名配置 → 推断 named」与「配置不完整 → 退回 quick」两条 |
| `test/service.test.js` | `stubInternals` 增加 `startQuickTunnel`；拒绝用例收敛为 named 配置不完整两种；自动恢复参数表改为「模式一致 + 配置合格」矩阵；RPC 用例改为「默认 quick 可直接开启」 |
| `test/public-settings.test.js` | 「不再携带随机域名」反转为「重新携带」 |
| `test/cli-auth.test.js` | 断言改为 `--public`/`--quick` 双路径 |

**已知预存失败（非本次改动引入，v1b 基线同样红）**：

1. `test/file-read.test.js` — macOS `realpath` 把 `/var/...` 解析成 `/private/var/...`
2. `test/smoke.test.js` ×2 — 该环境无局域网 IP，`status.lanUrl` 为 `null`
3. `test/tunnel-args.test.js` — 断言 `--protocol http2`，而 B 自 `763e94b` 起已改用 `auto`（陈旧用例）

## 4. 合并后的功能清单

| 能力 | 来源 | 状态 |
| :--- | :--- | :--- |
| 局域网扫码 + 独立 PIN + 限速 | A/B 共有 | ✅ |
| **Quick Tunnel 一键公网（随机域名）** | **A（回补）** | ✅ 新增 |
| 命名隧道固定域名 | A/B 共有 | ✅ |
| 公网 PIN：quick 每次轮换 / named 不轮换 | A（回补） | ✅ 新增 |
| dsh-web-mobile v3.2.0 移动层镜像 | B | ✅ |
| 会话删除（回收站式 + 失败回滚） | B | ✅ |
| 手机端独立字号 12–22px / 捏合缩放 | B | ✅ |
| 静态资源 Service Worker 缓存 | B | ✅ |
| cloudflared sha256 digest 校验 | B | ✅ |
| 卸载门 / 代理世代号 / 删除回滚 | B | ✅ |
| 远程浏览器可用「设置→模型」 | A/B 共有 | ✅ |
| 双通道自动恢复 | A/B 合并 | ✅ |

**两版都没有的**（勿误解）：远程桌面 / 屏幕镜像 / 鼠标键盘控制、可安装 PWA（无 manifest）、文件上传、信息密度模式（单帧/聊天/完整）。

## 5. 许可证与来源声明

- 主体 [shaobeichen/dsh-pocket](https://github.com/shaobeichen/dsh-pocket)：**GPL-2.0**，`LICENSE` 原样保留。
- 移动端适配 [mexiaosqwq/dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)：**MIT**，声明见 `client/mobile/LICENSE.dsh-web-mobile` 与 `NOTICE.md`。
- 本仓同样以 **GPL-2.0** 发布，上游版权与许可全文保留；相对上游的改动即本仓的 git 差异。
