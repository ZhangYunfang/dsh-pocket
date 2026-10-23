# dsh-pocket 移动端移植层（dsh-web-mobile 同步机制）

pocket 的移动端适配移植自 [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile)（MIT，LICENSE.dsh-web-mobile）。
本目录的结构让「上游更新 → 同步进 pocket」成为一条命令的事。

## 目录结构

```
client/mobile/
  upstream/            ← dsh-web-mobile src/client/** 原样镜像（勿手改！）
  mobile-apply.tsx     ← pocket 适配器：布局门控 → 调 upstream apply → pocket 附加层
  fileGuard.ts         ← pocket 专属：issue #17 文件链接守卫 + 「复制」按钮
  layout-mode.mjs      ← pocket 专属：issue #74 ?dsh-layout= 强制布局
  LICENSE.dsh-web-mobile
  PORTING.md           ← 本文件
```

**原则：`upstream/` 里零手改。** 所有 pocket 特有逻辑都住在适配器和 pocket 专属文件里。
上游的一切（样式、手势、reconciler、slots 组件）都从 upstream/ 原样打包。

## 同步步骤（上游发新版后）

```powershell
node %USERPROFILE%\.dsh\dsh-pocket\sync-dsh-web-mobile.mjs          # 跟 origin/main
node %USERPROFILE%\.dsh\dsh-pocket\sync-dsh-web-mobile.mjs v2.4.0   # 或指定 tag
```

脚本会：fetch → 镜像 src/client → **镜像期变换（见下）** → esbuild 重建 client.js →
node --check。产物 `client/client.js` 由 esbuild 打包 upstream/ + 适配器 + fileGuard
为一个 `window.__ModuleLoader__.load` 包装的 CJS bundle（react 与
`@deepseek-ai/dsh-client-ui-primitives` 保持 external）。

**镜像期变换（sync 脚本 step 2.5，自动施加，无需手工）**——v3.1.0 起上游 NS 家族
改为 `dshWebMobileNav` 前缀，vendored 副本注册同名人会与独立安装的 dsh-web-mobile
插件撞车（上游 locales.ts 注释：register 重名 throw 且整条插件 fiber 死亡）：
1. `dshWebMobileNav` → `pocketMobileNav`（全字符串，含 `.attachments` 子 NS 与
   `…FileShare` 变体；对历史 `'mobileNav'` 字面量同改，`dataset.mobileNav`/`data-mobile-nav`
   是 data 属性**不在其列**）；
2. `[data-mobile-nav="stats"]` 选择器 → `body:not([data-pocket-stats="off"]) [data-mobile-nav="stats"]`
   （让位机制：其它插件设 `document.body.dataset.pocketStats='off'` 即可整组回收
   stats 条，纯 CSS、无 JS 拦截；幂等：已前缀的选择器不会二次加前缀）。
   变换后脚本断言镜像目录零 `dshWebMobileNav` 残留——**上游新增未跟踪文件**（如
   v3.1.0 的 file-share-locale.ts）git grep 搜不到，断言必须走文件系统遍历。

构建依赖 esbuild：vendored 于 `%USERPROFILE%\.dsh\dsh-pocket\vendor\node_modules\`
（esbuild@0.28.1 + @esbuild/win32-x64），sync 脚本自动 junction 进包内 node_modules。
`dsh plugin update dsh-pocket` 重装包后 junction 会丢——重跑 sync 脚本即可恢复。

**同步后必做：**
1. 重启 dsh web（`node %USERPROFILE%\.dsh\dsh-pocket\detached-restart.cjs`，注意会断当前会话）。
   combo URL 的 rev 启动时重分配，无缓存问题。
2. WebKit（JSC/同 iPhone 引擎）回归：登录 PIN → 开历史会话（对话渲染）→ 抽屉开合 → 左缘右滑。
3. **对表 inject 硬依赖**：upstream/index.tsx 的 `export const inject` 若增删服务名，
   `client/index.jsx` 的适配器 inject 数组必须同步改成它的超集（v3.1.0 起 upstream
   新增 `'sessions'`，漏声明 → 宿主给 `ctx.sessions` 传 undefined → 激活即抛
   "1 entry did not activate"，2026-10-14 实测翻车一次）。upstream 动态依赖
   （`ctx.inject([...], cb)` 懒加载，如 inputTriggers/remote.workspaceFiles）不进
   静态表，宿主 0.2.0-rc.1 原生支持。
4. **激活冒烟**：`node client\repro-activate.mjs`（桩环境直跑 bundle 的 apply()，
   应打印 `apply() completed` + 42 effects + locale NS 清单；NS 重名/漏 inject
   一律当场炸）。比「重启后拿手机试」快得多。
5. **重打下方「upstream/ 内的 pocket 手工补丁」清单**——sync 会整目录覆盖，丢了会静默回归。

## upstream/ 内的 pocket 手工补丁（sync 覆盖后必须重打）

「upstream/ 零手改」有例外：下列修复必须落在镜像文件内部（适配器层够不着
组件闭包/reconciler 回调/slot 组件），每次 `sync-dsh-web-mobile.mjs` 会把它们
整目录冲掉。按序号逐个施加，施加完用 `git diff client/mobile/upstream` 复核。

**2026-10-19 对账基线：v3.2.0 (473a78b)。** 相对 v3.1.0 的 14 条补丁：#12
`effects/reasoning-defaults.ts` 随上游 v3.2.0 退休整份删除、补丁作废；#13 的
stats-line 部分已按上游新 `locateRing` 代码重放；其余 12 条原样重打。v3.2.0
还吸收了本仓此前的两个真机修复点（viewport `interactive-widget=resizes-content`、
swipe `if (!tracking) return`），并新增 `effects/drawer-session-log.ts`（抽屉品牌行
图标，替代旧 `sidebar.footer.action` 胶囊）——本仓 POCKET_EXTRA_CSS 里对应的
`[data-mobile-nav="session-log"]` 触控高度规则已删除。

**历史（2026-10-14 对账基线 v3.1.0 (ab3a85b)）：** v3.0.3 清单 13 条的去向：#1 脏键豁免
（上游 reconciler 拆分——adapter 过滤 [data-chat-flow] 内全部记录 + core 的
characterData 脏键取代）、#4③ dispose 清注入（上游 injected Set）、#5 gesture-guard
清扫（上游 consumed 改 WeakMap，detached 节点天然可回收）**已被上游吸收**；NS 改名
与 stats 让位升级为脚本镜像期变换（见「同步步骤」节）。存活 11 条重编号如下
（⚠ 2026-10-14 审查更正：#2「frame 缓存 isConnected 检查」v3.1.0 上游**没有**吸收
——upstream/effects/phone-chrome.ts 上游仍是裸 `frame = findFrame()`，isConnected
短路是我们镜像里的本地补丁，回归存活清单，勿再误记）：

1. `effects/overlay-backdrop-fab.ts` — frame 缺失分支：清 backdropRemoveTimer、
   backdrop/FAB 引用后 early return（挂起的 stale 引用会让 frame 恢复后永不重挂）。
2. `effects/session-menu.ts` — ① capture 阶段 contextmenu 也更新 anchor（captureRow
   共用，长按/右键开菜单）；② 菜单卸载且再无会话菜单时 anchor 清空（removedMenu
   检测，防程序化开菜单命中过期 anchor）。③ dispose 清注入项上游已做（injected Set）。
3. `debug.ts` — observer 回调里的 `paint()` 改 rAF 合并（schedulePaint + dispose
   取消）；`?mobile-nav-debug=1` 下流式每批强制 reflow 的豁免。
4. `effects/sidebar-swipe.ts` — ① follow 合成层：armOpenFollow 设
   `style.willChange='transform'`，releaseFollowStyles 与 finishPendingCommit 两个
   内联出口同步 removeProperty（漏清理=抽屉常驻占一个合成层）；② 起手守卫：目标在
   `_composerSeat`/`[data-composer-card]`/`_dock` 内直接 false（输入区起手不开抽屉）。
5. `effects/file-viewer-compat.ts` — 备忘上次 panel 存在性 + frame 引用，同值同帧
   直接 return；dispose 清缓存。
6. `components/MobileNavToggle.tsx` — 抽屉开关 a11y：`useState`+`useEffect` 订阅
   `data-sidebar-collapsed`（documentElement 级 MutationObserver + attributeFilter，
   口径同 phone-chrome drawerOpen()），渲染 `aria-expanded`，开/关态 aria-label/title
   在 `t('open')`/`t('close')` 间切换。观察者回调必须：纯文本 childList 批次跳过 +
   其余 rAF 合并——attributeFilter 不挡 childList，流式每 token 都会进回调，裸跑
   readOpen = 每帧两次全文档 querySelector。（图标兜底已上游化：core/icon-compat.ts。）
7. `styles/layout.css.ts` — `html,body` 加 `-webkit-text-size-adjust/text-size-adjust:
   100%`（iOS 竖屏防文字自动放大）；`[class*="_scrollBody"]` 加
   `overscroll-behavior: contain`；composer 座底部安全区
   `padding-bottom: 2px !important`（`_composerSeat` 三选择器组）+ 输入卡外层
   root `:has(> [class*="_card"])` 底垫同收 2px。注意：v3.1.0 起 frame 自身
   已垫 `env(safe-area-inset-bottom)`（#193），座位不得再叠 inset——旧值
   `calc(5px + env(...))` 是 v3.0.3 时代 frame 不垫底部的补偿，照叠会把
   inset 计两遍（哈希代际变化时静默 no-op）。
8. `styles/compat.css.ts` — opPanel 补 `z-index: 60 !important`；cardShots 横滚容器补
   `overscroll-behavior-x: contain !important`；preview-full-toggle 的 :hover 包入
   `@media (hover: hover)`。
9. `styles/base.css.ts` — 三处 :hover（toggle/files、session-log、fab）包入
   `@media (hover: hover)`（:active 拆出保留），触屏点后不再粘滞灰底。
10. dvh 全量补 vh 回退双行（vh 行在前、dvh 行在后；iOS<15.4 无 dvh 引擎整条丢弃 dvh
    声明）：`compat.css.ts` explorer sheet（height/max-height）、preview sheet
    （height/max-height）、preview 全屏（height）、agent-preset 菜单（max-height）；
    `layout.css.ts` header `_menu`（max-height）、`_panel` 族（max-height calc-96px）、
    team-action 面板（max-height calc-200px）。
 11. `effects/phone-chrome.ts` — frame 引用缓存加 isConnected 短路：
     if (frame === null || !frame.isConnected) frame = findFrame()`。宿主 SPA 换页/
     重挂会把旧 frame 从文档摘除，裸缓存会让后续轮询一直对着游离节点打标。上游
     v3.1.0 仍是裸缓存（audit 2026-10-14 复核），勿信「已吸收」旧说。

2026-10-15 性能批新增 12–14（流式每-flush 固定税 + 轮询退避；#12 已于 v3.2.0 作废）：

12. ~~`effects/reasoning-defaults.ts`~~（**已作废**：v3.2.0 上游退休该文件） — 固定 10s describe 轮询改自调度退避：10s→60s→
    300s 封顶，describe 回合成功（ok=true）步进、失败（超时/拒绝/无 remote/上轮
    未完）回 10s。settings/document-updated 订阅已即时 fill，稳态每 10s 一次全量
    settings describe RPC 属重复劳动。fill 加可选 onDone(ok) 回调上报结果；2s
    retry 与事件路径不动。找点：`setInterval(fill, 10_000)` 处 + fill 尾部
    finally（onDone 调用）。
13. 每-flush 查询缓存批（四处，模式同 #11 phone-chrome frame 缓存 / installed-list
    resolveRoot 的 isConnected 短路；凡命中属性可能在保持连接的节点间移动的选择器
    （aria-current、data-phase、自有标记），缓存命中一律加 matches() 复验；缺席
    （null）不缓存负结果、照旧查询——负结果无法安全失效）：
    - `effects/stats-line.ts` — mark() 每趟的 `[data-mobile-nav="stats"]` 锚查询，
      闭包 cachedAnchor，dispose 清空；
    - `effects/panel-exit.ts` — panelOwnsMainArea() 的
      `[class*="panelRow"][aria-current="page"]`，模块级缓存（aria-current 随面板
      选中换宿主，matches 复验兜住）；
    - `effects/overlay-backdrop-fab.ts` — heroPhase() 的 `[data-phase="active"]`
      （ensure 每趟最多调两次），闭包缓存 + dispose 清空；注意别覆盖 #1 的
      frame-null 清理补丁；
    - `effects/aionui-compat.ts` — sheet-rise-replay ensure 的两列
      `[data-aionui-explorer-col]`/`[data-aionui-preview-col]`，闭包 colCache +
      dispose 清空。
14. `effects/session-menu.ts` — body 全树 MutationObserver 补 chat-flow 整批早退
    （照抄 installed-list 的过滤形态）：整批 records 全在 `[data-chat-flow]` 内
    直接 return，不跑 scheduleInject 也不跑 removedMenu 判定——会话菜单是 body 级
    portal，正文内 mutation 不可能含菜单开合。此前它是唯一缺这层过滤的观察者，
    流式期间每条记录都白跑一次 closest('[role="menu"]')。

### 适配器层的宿主侧配套（不在 upstream/ 内，但同一次合并引入）

- `lib/delete-session.mjs` + `lib/index.js` 挂 `/api/mobile-nav.session.delete`（移植
  上游 v3.0.3 宿主侧 delete-session）：上游 session-menu 的删除按钮 fetch 此端点，
  官方宿主没有——不挂则手机端删除永远 404。sameOrigin 放宽为「Origin 与 Host 同
  主机名（端口忽略）或均为 loopback」（dsh-pocket 代理会改写 Host/Origin 为 loopback
  权威后转发，宽式的直连 3080 调试也放行）。
- `mobile-apply.tsx` POCKET_EXTRA_CSS：rc.2 右上角双入口治理。原生 corner
  （`[data-conversation-header-corner]`，dsh-client-ui-sidebar-right 注入）与插件
  files 按钮叠位；上游 v3.0.3 的两条 corner 规则锚的旧结构/旧哈希（wSkVaW_→D_tfqW_）
  在 rc.2 全不命中。按 dsh-pocket 上游方案：`mobileRightbarEnabled=off` 藏 corner；
  默认 on 时 corner 36px seat + files 左移 right:44px 让位。
  **代际护栏**：off 态规则特意加 html 前缀提到 (0,4,1)——它赢的前提是上游旧结构
  corner 规则在当前宿主不命中；若未来宿主把 corner 移回 wrapper 末子节点且上游
  重锚出 `(0,5,x)` 的 `display:flex`，需同步提权本规则。每次 sync 后用
  `git grep -n 'headerCorner' upstream/styles/` 对账。

## 移植历史

- pocket 原移植基线 ≈ 上游 **v1.0.0**（MobileNavToggle/MobileDrawerFooter 逐字相同）。
- **2026-09-06 同步到 main @75d2311（v2.3.0 + PR #47）**：补齐 v1.5.0→v2.3.0 五个版本——
  - v1.5.0/v2.0.0：哈希类选择器改子串匹配 + `:not` 守卫（CSS 稳定性）、phase 2-4 代码重组
  - v2.1.1：大 JSON 压缩（宿主侧，pocket 未采用，见下）、子代理弹卡、抽屉点会话收起、输入区钉位
  - v2.2.0：抽屉「收起但不打开」修复 (#32)、子代理芯片一闪即退、iOS 点搜索框强制放大修复（PR#35 字号≥16px）、刘海屏输入框下方露白
  - v2.3.0：左缘 45% 右滑手势 (#16/PR#37)、流式每帧开销优化（raf-scheduler）、抽屉屏外跳渲染、手势后点按无响应、Android 左缘滑触发返回（overscroll-behavior-x）、起指让位横滚容器、减弱动态效果禁动画、debug 徽章重接线（?mobile-nav-debug=1）、隐形热区改纯几何判定
- **2026-09-28 同步到 main @a094288（v3.0.3 + PR #137，跨 v2.4.1 共 293 提交）**：
  - v2.4.1：浮球拖拽让位手势、session-delete 触屏全宽武装
  - v3.0.0（0.1.6-alpha.2 适配大版本）：core/icon-compat（图标两代命名运行时取）、
    core/sessions-compat（a2 双代会话形状）、输入区常驻文件入口（ComposerFileButton，
    0.1.6 删回形针后放回工具行）、侧栏面板退出路径（panel-exit）、workspace/team/
    composer-plus 三 chip 开关、model-menu-anchor、shortcut-modal-keyboard-guard、
    drawer⇄files 共存契约、#104 stats-line 脱离 React 卸载路径
  - v3.0.1–v3.0.3（0.1.7-alpha.2→rc.2 适配线）：settings/market 弹层 rc.2 portal 迁移
    重锚（#105 CSS 替代 reparent）、session-delete 0.1.7 冷启动（归档行/磨砂弹窗/
    same-origin/1MiB/trash 阶段）、stats-line/git-chip 纯 CSS 锚定、快捷键弹层手机端
    五轮修复（#120–#128 后 #137 回滚 #129–#136 为 pre-loop 树）
  - 合并时 pocket 补做：宿主侧 delete-session 路由移植（手机删除 404 断链）、
    rc.2 右上角双入口治理（见上「适配器层的宿主侧配套」）、老清单 20 条补丁对账
    重打（8 条已被上游吸收、2 条随文件删除作废、13 条存活重编号）
- **2026-10-14 同步到 v3.1.0 @ab3a85b（基于上游 v3.0.6 b78babc 的基线重放版）**：
  - 上游要点：C08 stats-line TPS 宽度不刷新（characterData scope）、panel-exit
    try/finally、disposer 按 ownership 删除、@patch 注册门禁、reasoning-effort
    自动档位（compat 不支持不写 tier）、顶栏座位重做（后台任务点进标题行、
    subagent chip 钉右、标题省略+展开）、性能第一批（header-metrics 几何重绑拆分、
    installed-list 容器缓存、model-menu-anchor 每帧 rect 缓存、composer-file-picker
    先比后写）、断点收敛 767px、!important 941→922
  - 架构变化：reconciler 拆 `core/reconciler-core.ts`（DOM-free）+
    `effects/reconciler-adapter.ts`（唯一全树 observer，characterData:true，
    **过滤 [data-chat-flow] 内全部记录**）；getFrame/findFrame 迁至
    `platform/frame.ts`；NS 家族改 `dshWebMobileNav` 前缀（与 dsh-pocket 撞车的
    #162 由上游在上游侧同时解决：pocket 应注册 pocketMobileNav——本仓由 sync
    脚本镜像期变换保证）
  - pocket 侧配套：sync 脚本新增镜像期变换 + 残留断言（见「同步步骤」节）；
    13 条补丁对账重打（4 条被上游吸收、存活 10 条重编号）；gesture-guard 的
    WeakMap 化使清扫补丁作废；session-menu ③ 上游 injected Set 化
- **2026-10-19 同步到 v3.2.0 @473a78b**（三方合并：变换后 v3.1.0 → 本仓补丁 diff →
  cherry-pick 到变换后 v3.2.0；唯一冲突 `styles/base.css.ts` 的 hover 规则按补丁形态解）：
  - 上游要点：#226 viewport 补 `interactive-widget=resizes-content`（Android 键盘
    不再把整页 pan 上去）、#223 iOS 首个 preventDefault 的 touchmove 取消整笔滚动
    导致左右死区、#227 抽屉「导出会话日志」从 footer 胶囊迁到品牌行 28×28 图标
    （新增 `effects/drawer-session-log.ts`，删 `components/MobileDrawerFooter.tsx`
    引用；镜像里该组件文件上游仍保留但已无引用）、#229 壁纸插件把侧栏底色置
    transparent 的补回、#216 宿主 0.2.1 stats 双档锚 + `locateRing`、#217 后台任务
    chip 形状锚、#214/#221 第三方卡顿与 z-index、#218 退休 reasoning-defaults、
    #219 退休 model-capabilities 面板适配
  - pocket 侧配套：14 条补丁三方合并（#12 作废、13 条存活）；POCKET_EXTRA_CSS
    删除旧 `[data-mobile-nav="session-log"]` 触控高度规则；`client/repro-activate.mjs`
    的 DOM 桩补 `querySelector` 等形状（新任务会查 frame 品牌行）

## pocket 附加层（适配器 mobile-apply.tsx 负责，上游没有的）

1. **布局门控（issue #74）**：`?dsh-layout=` > localStorage > auto。desktop → 整段 mobile 不挂。
2. **explorer 可用性标记（issue #48）**：官方 DSH 无 dsh-web-ui/aionui 列；探测
   `[data-aionui-explorer-col]` 存在与否 → `data-mobile-nav-explorer="0|1"`，
   配 POCKET_EXTRA_CSS 隐藏死掉的「文件浏览」入口。
3. **fileGuard（issue #17）**：拦文件链接点击、注入「复制」按钮（走 pocket RPC fileRead）、
   隐藏「添加工作区」。依赖的 CSS 规则（copy-file 按钮样式、aria-label 隐藏）也搬进了
   POCKET_EXTRA_CSS（上游样式表没有这些）。

## 故意不移植的部分

- **src/index.ts + src/compress.ts（宿主侧响应压缩）**：pocket 的 lib/proxy.mjs 已在代理层
  做大 JSON/文本的 gzip/br 流式压缩（跳过 SSE），上游的 ServerResponse 补丁与之重复且可能
  双重压缩，不采用。
- **上游 MobileNavOverlay → 已被上游自己的 reconciler 任务取代**：v2.3.0 的
  overlay-backdrop-fab 任务（createOverlayTask）就是 backdrop + FAB 的实现，pocket 旧
  MobileNavOverlay.tsx + nav-targets.mjs 已退役删除。

## 已知行为差异（相对 pocket v1.0.0 时代移植）

1. **断点三处统一为上游 MOBILE_QUERY**：`(max-width: 1023px) and (pointer: coarse)`——
   上游 JS 效果（phone-chrome MOBILE_QUERY）、上游样式主 gate（原有裸 `(max-width:768px)`
   宽度臂已按下方补丁清单收窄）、pocket 的 narrowMQ（mobile-apply.tsx，驱动 auto 判定 /
   fileGuard / explorer 探测 / zoom-lock）现在同口径。此前 pocket 只看宽度：桌面浏览器
   窄窗会误判成 mobile（fileGuard 拦文件链接弹「手机上无法打开」、隐藏「添加工作区」）。
   真机 iPhone/安卓不受影响。
2. **`?dsh-layout=mobile` 强制模式部分降级**：pocket 附加层（fileGuard、explorer 探测）仍会
   强制挂载（resolveLayout 走 narrow mock 恒真）；但上游的样式与效果按 MOBILE_QUERY 门控，
   在鼠标指针的桌面浏览器上不会强制出移动布局（旧移植可以）。真机上强制 mobile 不受影响
   （本来就是 coarse pointer）。`?dsh-layout=desktop`（主要用法：宽屏手机/平板强制电脑布局）
   不受影响。
