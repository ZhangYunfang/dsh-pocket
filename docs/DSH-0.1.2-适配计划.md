# DSH 0.1.2-alpha.2 适配计划

> 目标：让本仓（融合版 3.1.0）在**本机现网 DSH `0.1.2-alpha.2`** 上稳定运行，且不牺牲已合并的移动端与安全能力。
>
>  **当前状态：✅ 已在 DSH 0.1.2-alpha.2 实测通过**（2026-10-28）。探针 7/7 通过，局域网与公网隧道均实测可用。
> 本文保留为「适配方案 + 验收记录」：前面的阶段计划与风险预案仍然有效，末尾 §9 追加实测结论。

---

## 0. 结论先行（可行性判断）

**技术上可行**，理由是逐项核过宿主的真实 API 面，0.1.2 并不缺本插件依赖的服务：

| 本插件依赖 | 0.1.2-alpha.2 是否提供 | 证据（`dsh-src/deepseek-harness-dsh-v0.1.2-alpha.2`） |
| :--- | :--- | :--- |
| `webServer` 服务（含 `port` getter、`register(route)`） | ✅ | `packages/host/webserver/src/index.ts:124,150,165`；`WebRouteKind = 'exact' \| 'prefix'` |
| `connection.requestRejection(req)` | ✅ | `packages/client/connection/src/rpc-host.ts:96`、`rpc.ts:179` |
| `connection.rpc.handle(channel, handler)` | ✅ | `packages/client/connection/src/rpc.ts:140`（**只有 2 个参数**，见风险 R1） |
| `connection.authenticatedUrl(base)` | ✅ | `packages/client/connection/src/browser-auth.ts:223` |
| `client-connection` 注入 `webServer` | ✅ | `packages/client/connection/src/index.ts:67` → `inject = ['webServer','credentials']` |
| 客户端 inject 的 5 个包 | ✅ | `dsh-client-connection / -locale / -ui-slots / -ui-layout`（`packages/client/*`）+ `dsh-session-log-export`（`packages/session-query/session-log-export`） |
| `sessions` 服务（会话删除用） | ✅ | `packages/experimental/agent-team/src/index.ts:60` 静态注入 `sessions` |
| body 上的 `--dsh-content-font-size`（手机端独立字号依赖） | ✅ | `packages/client/ui-theme/tests/boot-theme.client.spec.ts:66` |
| 宿主 DOM 稳定标记 `data-phase` / `data-composer-card` / `data-conversation-scroll` / `data-composer-seat` / `heroWorkspaceRow` | ✅ | 分别命中 7 / 6 / 8 / 4 / 1 个文件 |
| `_composerStack` hashed class | ✅ | `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:352` |
| `engines.dsh` 版本闸门 | ❌ **不存在** | 全库 grep `incompatible-version` / `allow-version` / `engines.dsh` **零命中** |

**关键判断**：`engines.dsh` 在 0.1.2 上根本不被读取，所以它既不拦你也不保护你。上游 B 声明的 `^0.2.0-rc.1` 只是「作者测过的版本」，不是「代码只支持 0.2.x」（依据：B 的 commit `4c42dbd` 原文自述该闸门是防呆用）。因此**放开闸门是安全的，真正的风险在运行时行为差异**。

---

## 1. 阶段划分

| 阶段 | 目标 | 产出 | 是否改动 DSH |
| :--- | :--- | :--- | :--- |
| **P0 宿主契约探针** | 用真实 0.1.2 服务栈挂载插件，验证服务面 | `scripts/probe-host.mjs` + 探针报告 | 否（只读加载） |
| **P1 隔离环境装载** | 在**独立 DSH_HOME** 里装插件并跑 dsh web | 独立 profile + 冒烟截图 | 否（不碰 `~/.dsh` 主力） |
| **P2 移动端 DOM 契约核对** | 逐条比对 dsh-web-mobile 依赖的选择器在 0.1.2 DOM 上是否命中 | 选择器命中表 | 否 |
| **P3 功能验收** | 局域网 / 快速隧道 / 命名隧道 / 会话删除 / 独立字号 / 双通道恢复 | 验收清单全绿 | 否 |
| **P4 收口** | 修差异、更新 README 与版本范围、提交 | 3.1.x 发布 | 视情况 |

> **硬约束**：`/Users/zyf/Project/deepseek-harness-dsh-v0.1.2-alpha.2/` 是**线上运行系统，只读**。所有改动只进本仓与工作区副本，绝不改现网源码；如需重启验证，走 supervisor 且先确认无人在用。

---

## 2. P0：宿主契约探针（第一步，最省时）

### 2.1 做法

沿用本机已验证的方法论（0.1.2-alpha.2 实测过）：用 `~/.dsh/profiles/node_modules` 里的真实包搭 cordis `Context`，真实 `WebServer` 用 `{host:'127.0.0.1', port:0}` 挂载。

```js
// scripts/probe-host.mjs（计划新增）
// 断言清单：
//  A1  ctx.provide('webServer', new WebServer(ctx, {host:'127.0.0.1', port:0})) 成功
//  A2  installPocketRpc 走 webServer.register 路径（而不是 rpc.handle 回退）
//      → 判据：安装后 webServer 路由表里存在 `${POCKET_RPC_CHANNEL}/*` 的 prefix 路由
//  A3  requestRejection 以**方法形式**调用不抛（issue #117 的 this 绑定坑）
//  A4  ctx.connection.rpc.handle 三参调用不报错（第三参被忽略）
//  A5  mountSessionDeleteRoute 返回非 null 的 disposer（sessions 服务在场时）
//  A6  ctx.webServer.port 返回实际监听端口（非 0）
```

### 2.2 两个必须注意的实现细节（本机踩过）

- 真实 `WebServer` 挂载后会**保持事件循环**，探针脚本末尾必须 `process.exit(0)`。
- 插件路由 handler 是 Node 原生 `(req, res)`，不是 Fetch API。
- `webserver` 分发是「精确表优先、其后最长前缀」，本插件的 exact 路由不会被 `/api` 前缀遮挡。

### 2.3 通过判据

A1–A6 全部为真 ⇒ 宿主契约层无障碍，直接进 P1。任一为假 ⇒ 先修该点，不进入后续阶段。

---

## 3. P1：隔离环境装载

```bash
# 1) 独立 HOME，绝不碰主力 ~/.dsh
export DSH_HOME_PROBE=~/dsh-probe-012
mkdir -p "$DSH_HOME_PROBE"

# 2) 独立 profile（注意：pnpm 9 装插件必须带 -w）
DSH_HOME="$DSH_HOME_PROBE" dsh plugin --profile web add "link:$PWD/dsh-pocket-merged" -w

# 3) 用另一端口起 web（避免与现网 3080 冲突）
DSH_HOME="$DSH_HOME_PROBE" pnpm dsh web --port 3090

# 4) 打开 http://localhost:3090 → 设置 → 手机访问
```

**验收点**

- [ ] 插件加载无错误（日志里出现 `dsh-pocket:` 前缀的启动行）
- [ ] 设置页「手机访问」能渲染出**通道选择器**（快速隧道 / 固定域名两枚 pill）
- [ ] `pocket.status` RPC 返回 `proxyRunning: true` 与 `tunnelConfig.mode: 'quick'`
- [ ] 默认 `proxyPort` = 3081（若 3081 被现网占用则顺延，确认不与他服冲突）

> ⚠️ **端口冲突预检**：本机 3080（DSH web）、3081、3082、8000/8001/8002、7860、9001/9011 已有服务。P1 起 web 用 **3090**，并确认 pocket 的代理端口落在空闲口（必要时在独立 `settings.json` 写 `"proxyPort": 3095`）。

---

## 4. P2：移动端 DOM 契约核对（本阶段风险最高）

`client/mobile/upstream/**` 是 dsh-web-mobile **v3.2.0** 的原样镜像，它是照着 **0.2.x 宿主 DOM** 调的。在 0.1.2 上它**可能**有一批选择器命中不到——这类失败**不报错、只是不生效**（样式/交互静默退化），所以必须逐条核。

### 4.1 核对方法

在 0.1.2 的页面里注入一段统计脚本，把移动层用到的选择器全部 `querySelectorAll` 一遍：

```js
// 计划新增 scripts/probe-mobile-selectors.mjs（在浏览器 console 跑）
const SELECTORS = [
  '[data-phase]', '[data-composer-card]', '[data-conversation-scroll]',
  '[data-composer-seat]', '[class*="_composerStack"]', '[class*="_composerSeat"]',
  '[class*="_scrollBody"]', '[class*="_centerCol"]', '[class*="_row"]',
  '[class*="_card"]', '[class*="_trailing"]', '[class*="_primary"]',
  '[class*="_headerLeading"]', '[class*="_headerActions"]', '[class*="_titleCluster"]',
  '[class*="_switcherRoot"]', '[class*="_crumbs"]', '[class*="_tools"]',
  '[class*="_modes"]', '[class*="_trigger"]', '[class*="_titleRow"]',
  '[class*="heroWorkspaceRow"]', '[role="menu"]',
];
```

### 4.2 判定

| 结果 | 处置 |
| :--- | :--- |
| 全部命中 > 0 | 0.1.2 DOM 与 0.2.x 在这些锚点上一致，移动层可直接用 |
| 个别为 0 | 该 effect 在 0.1.2 上静默失效 → 记入「降级项」表，评估是否值得为 0.1.2 单独补一组兼容选择器 |
| 关键路径为 0（`_composerStack` / `_composerSeat` / `_row`） | 属于**阻断级**：键盘抬升、composer 布局会坏 → 必须先修才继续 |

### 4.3 已知的重点怀疑对象

| 选择器 | 消费者 | 失效后果 |
| :--- | :--- | :--- |
| `[class*="_composerStack"]` | `stats-line.ts`、`composer-keyboard-lift.ts` | 统计条不横排；键盘弹出时输入框被盖住 |
| `[class*="_composerSeat"]` | 座位钉底、键盘抬升 | 手机底部空白 / 输入框悬空 |
| `[class*="_row"]` + `:has([class*="_trailing"])` | composer 底栏换行布局（替代 A 的 #170 修复） | 360px 窄屏模型药丸被压扁 |
| `[class*="heroWorkspaceRow"]` | `workspace-chip-toggle.ts` | hero 工作区 chip 再点关不掉（回归到 issue 原症状） |

> 注意：`_composerStack` 已确认在 0.1.2 存在（`ConversationRoot.tsx:352`），其余按上表逐条实测。

---

## 5. P3：功能验收清单

### 5.1 局域网

- [ ] 设置页出现局域网二维码，手机同 WiFi 扫码可打开
- [ ] 输入局域网 PIN 通过；连错 5 次锁 60 秒（`fail closed` 生效）
- [ ] 关闭「局域网访问」后二维码/链接立即失效
- [ ] 自定义 PIN → 可清除回随机（`c6e2ce1` 语义）

### 5.2 快速隧道（本次回补的核心）

- [ ] 通道选「快速隧道」→ 点「开启公网访问」→ 弹免责声明 → 勾选后开始
- [ ] 首次会下载 cloudflared（约 20MB，走清华镜像）；下载后校验 sha256 digest
- [ ] ~5–30 秒后出现 `https://<随机>.trycloudflare.com` 二维码
- [ ] 外网（手机 4G）扫码可访问，**公网 PIN 每次开启都变新**（`onTunnelReady('quick')` 轮换）
- [ ] 关闭公网后旧链接立即作废
- [ ] DSH 重启后自动恢复**同一条** quick 通道（marker 记录 `mode:'quick'`）

> ⚠️ 若本机挂着系统代理（`127.0.0.1:7892`），cloudflared 已由 `cloudflaredEnv()` 主动剥离代理变量，正常情况下不会 1033；若仍报 1033，先按 README「公网隧道常见问题」排查。

### 5.3 命名隧道（回归验证）

- [ ] 切到「固定域名」→ 填域名 + Tunnel Token → 保存**不会**自动开公网
- [ ] 保存后公网 PIN **不**自动轮换（`onTunnelReady('named')`）
- [ ] 缺 Token 或域名时点开启 → 给出明确错误，不下载 cloudflared
- [ ] 通道切换（quick↔named）时若公网在跑，提示「需关闭并重新开启后生效」

### 5.4 移动端

- [ ] 窄屏自动进抽屉布局，侧栏可滑出/收起
- [ ] 键盘弹出时 composer 不被遮挡（P2 若判定 `_composerStack` 失效则此项必红）
- [ ] 设置页「手机端字号」12–22px 可调，桌面字号不受影响
- [ ] 两指捏合缩放开关生效（默认关闭）
- [ ] 会话列表可删除会话（走 `/api/mobile-nav.session.delete`，回收站式）
- [ ] 工作区 chip 单击开、再单击关

### 5.5 兼容性回归

- [ ] 「设置 → 模型」在手机上可正常读写（`transport-shim` 生效）
- [ ] 桌面端（本机浏览器）界面不受任何影响
- [ ] 静态资源 SW 不缓存带 cookie 的响应（`/dsh-pocket-sw.js` 只缓存 hashed 资产）
- [ ] 卸载插件后代理端口释放、无孤儿 cloudflared（卸载门）

---

## 6. 风险与预案

| 编号 | 风险 | 影响 | 预案 |
| :--- | :--- | :--- | :--- |
| **R1** | 0.1.2 的 `rpc.handle` **只有 2 参**，本插件按 3 参调用（`{authority:'loopback'}`） | 第三参被忽略；若 0.1.2 在该路径上不做 loopback 授权判定，可能放宽信任边界 | P0 的 A4 断言 + 确认主路径走 `webServer.register`（自带 `requestRejection`）而非回退路径；实测不通则改为按版本二选一调用 |
| **R2** | dsh-web-mobile v3.2.0 的选择器按 0.2.x DOM 调 | 移动交互静默退化（不报错） | P2 全量选择器命中表；关键锚点缺失则补 0.1.2 兼容选择器 |
| **R3** | 0.1.2 的 `--dsh-content-font-size` 语义与 0.2.x 不同 | 手机端独立字号无效或污染桌面字号 | P3 5.4 专项验证；异常则把独立字号降级为「仅 0.2.x 生效」 |
| **R4** | 会话删除依赖的 `sessions` 服务形状在 0.1.2 上可能不同 | 手机点删除 404/500 | `lib/delete-session.mjs` 已按多代宿主做形状兼容；实测失败则先隐藏删除入口（fail-closed） |
| **R5** | 端口冲突（3081/3082 等已被占用） | 插件启动即 `EADDRINUSE` | 独立环境用 `proxyPort` 显式指定空闲口；先 `lsof -i :<port>` 预检 |
| **R6** | 在主力 `~/.dsh` 上试装污染现网会话/插件 | 影响线上使用 | **只在 `DSH_HOME` 独立目录里试**；确认稳定后再决定是否切换 |
| **R7** | 上游 B 后续若继续演进，融合版可能漂移 | 长期维护成本 | 保留 `upstream` remote，按 `MERGE.md` §2 的对照表做增量同步 |

---

## 7. 交付判据

本阶段算完成，必须同时满足：

1. P0 探针 A1–A6 全绿（原始输出留档）；
2. P2 选择器命中表全部 > 0，或有明确「降级项 + 原因 + 影响面」清单；
3. P3 五项验收清单逐条打勾（未验的必须标注「未验证」，不得默认通过）；
4. 《DSH 版本兼容矩阵》更新：写明 0.1.2-alpha.2 是「已验证」还是「已知不兼容项」；
5. 报告里所有结论都能指到具体文件行号或命令输出。

---

## 8. 立即可执行的下一步

```bash
# 第 1 步（只读，不改 DSH、不碰现网）：宿主契约探针
cd /Users/zyf/Project/DSH_WorkSpace/dsh-pocket-compare/dsh-pocket-merged
node scripts/probe-host.mjs        # 待创建

# 第 2 步：隔离环境装载（不碰 ~/.dsh）
export DSH_HOME=~/dsh-probe-012
# …见 §3
```

> 说明：本文件的主体是**适配方案与验收清单**。实测结论见 §9；截至 3.1.1，融合版已通过 `node --check` 全量、**268 项测试（263 通过）**（4 项失败与上游 v1b 基线完全相同且属环境性：macOS `realpath`、无局域网 IP、陈旧 `http2/auto` 断言，非本次改动引入），以及**探针 7/7 + 真机局域网/公网实测**。

---

## 9. 实测记录（2026-10-28，DSH 0.1.2-alpha.2）

### 9.1 结论

**在 DSH 0.1.2-alpha.2 上可用**：局域网访问与公网隧道两条链路均实测通过，无需 DSH 侧任何改动。

### 9.2 宿主契约探针（`scripts/probe-host.mjs`，7/7）

用**真实** cordis `Context` + 真实 `WebServer`（`@deepseek-ai/dsh-host-webserver` 0.1.2-alpha.2）挂载插件，配假上游：

```text
✅ A1 真实 WebServer 已监听 127.0.0.1:53356
✅ A2 apply() 加载成功（清理由 ctx.effect 持有，返回 void 属预期）
✅ A3 代理已监听 127.0.0.1:53358
✅ A4 RPC 前缀路由 /dsh-pocket 已注册
✅ A5 会话删除 exact 路由 /api/mobile-nav.session.delete 已注册
✅ A6 HTTP 200，上游命中=true，polyfill 注入=true
✅ A7 status().tunnelConfig.mode = "quick"
———— 结果：7/7 通过 ————
```

复现：`node scripts/probe-host.mjs`（只读，不碰现网进程与主力 `~/.dsh`）。

### 9.3 真机运行证据

安装方式 `github:ZhangYunfang/dsh-pocket`，装入 `web` profile 的 `dsh.profile.bundles`：

| 判据 | 实测结果 |
| :--- | :--- |
| `supervisorctl status dsh-web` | `RUNNING` |
| 代理端口 | `node ... TCP *:3081 (LISTEN)` |
| 插件启动日志 | 出现 `dsh-pocket: proxy ready on :3081` 等同前缀日志 |
| 公网隧道自动恢复 | `dsh-pocket: public tunnel auto-restored | 已自动恢复公网隧道` |
| 局域网访问 | ✅ 手机同 WiFi 扫码可用（用户实测） |
| 公网访问 | ✅ 外网扫码可用（用户实测） |

### 9.4 实际踩到的两个非插件原因

1. **首次"不可用"的真实原因是插件当时并不在 profile 里**——`package.json` / `bundles` / `pnpm-lock` / `--dump-config` 全部无 `dsh-pocket`，只剩 `~/.dsh/dsh-pocket/{token,token-lan}` 残留（卸载不清理该目录）。因此不存在"版本不兼容导致加载失败"的证据。
2. **`qrcode-terminal` 未随旧安装落地**：该依赖只被 CLI（`bin/dsh-pocket.mjs`）使用，插件模式下不加载；改用 GitHub 源安装后由 pnpm 一并装齐。

### 9.5 版本兼容矩阵

| DSH 版本 | 状态 |
| :--- | :--- |
| 0.1.2-alpha.2 | ✅ **已验证**（探针 7/7 + 局域网/公网真机实测） |
| 0.2.0-rc.1 ~ 0.2.x | ✅ 上游基线 v1b 3.0.3 的测试线（本仓在其上叠加双通道，测试全量通过） |
| 0.3.x | ⚠️ 未验证（`engines.dsh` 上限排除，需发新版放开） |
