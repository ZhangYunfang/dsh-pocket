// dsh-pocket 移动端适配层：pocket 专属逻辑 + 整目录同步的 dsh-web-mobile 上游移植。
//
// 结构（详见 client/mobile/PORTING.md）：
//   upstream/          ← dsh-web-mobile src/client/** 原样镜像（sync 脚本整目录覆盖，勿手改）
//   mobile-apply.tsx   ← 本文件：pocket 适配器（布局门控 → 调上游 apply → pocket 附加层）
//   fileGuard.ts       ← pocket 专属（issue #17 文件链接守卫 + 复制）
//   layout-mode.mjs    ← pocket 专属（issue #74 ?dsh-layout= 强制布局）
//
// 上游负责：样式、词典、phone-chrome、reconciler 基建 + 7 任务（overlay backdrop+FAB、
// stats-line、git-chip、settings-toolbar、preview、sheet-rise）、侧栏滑动手势（v2.3 #16/#37）、
// 子代理芯片触控（v2.2）、抽屉点会话自动收起（v2.2 #32）、aionui 兼容、debug 徽章、
// 两个 slots（会话头 toggle + 抽屉底部 footer）。
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as upstreamApply } from './upstream/index.tsx'
import { startFileGuard } from './fileGuard.ts'
import { resolveLayout, persistLayoutFromUrl } from './layout-mode.mjs'
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, MOBILE_RIGHTBAR_ATTRIBUTE, MOBILE_RIGHTBAR_EVENT, MOBILE_PINCH_ZOOM_ATTRIBUTE, MOBILE_PINCH_ZOOM_EVENT, MOBILE_FONT_ATTRIBUTE, MOBILE_FONT_EVENT, MOBILE_FONT_SIZE_VAR, MOBILE_FONT_MIN, MOBILE_FONT_MAX } from '../api.js'
// H4：fileGuard 的用户可见文案迁入词典（client/pocket-locales.js，NS='pocket'）。
// 这里只导入命名空间 id；词典本体由 client/index.jsx 统一注册（bind 是惰性取词，
// 注册顺序在 mobileApply 之后也不影响）。
import { NS as POCKET_NS } from '../pocket-locales.js'

/** Pocket 专属样式补充——上游样式表无法携带的宿主事实（官方 DSH 无 aionui 套件等）。
 * issue #17 / #48 段落从 v1.0.0 时代移植件继承。 */
const POCKET_EXTRA_CSS = `/* pocket 控件/门控样式：刻意不加媒体查询——mobileApply 启动时写入的
     body[data-dsh-pocket-layout] 就是门（desktop 布局在写入之后才早退，选择器
     天然不命中；?dsh-layout=mobile 强制移动的宽桌面也依赖这些规则，宽度媒体
     反而会漏掉它）。 */
  /* ---------- iOS 双击智能缩放治理（2026-10-14 真机反馈：双击/轻点页面自己放大） ----------
     根规则 html,body{touch-action:pan-y pinch-zoom} 的交集止于第一个滚动容器
     （上游 layout.css 注释自述），消息/会话/文件等纵向滚动区内部的双击缩放
     一直没被覆盖。对 frame 内的纵向滚动容器补同值：不带 pan-x，左缘抽屉
     手势照旧不被浏览器抢走；pinch-zoom 保留 #45 捏合逃生口；代码块等横向
     滚动内容是更内层的 scroll container，由最内层规则接管，不受影响。 */
  body[data-dsh-pocket-layout="mobile"] [data-mobile-nav="frame"] [class*="scrollBody"] {
    touch-action: pan-y pinch-zoom !important;
  }

  /* ---------- 两指捏合缩放开关（2026-10-14）：默认关，全拦 ----------
     设置层写 body[data-dsh-pocket-pinch-zoom]（默认 off）；off 时去掉
     pinch-zoom 令牌（Android 侧 touch-action 即生效），iOS 侧由下方 H3
     手势锁双向全拦兜底。注意：关闭期间若浏览器自行放大视口（#45 场景）
     将无法捏合还原，只能重开页面——提示文案已写在设置页开关下方。 */
  body[data-dsh-pocket-pinch-zoom="off"],
  body[data-dsh-pocket-pinch-zoom="off"] [data-mobile-nav="frame"] [class*="scrollBody"] {
    touch-action: pan-y !important;
  }

  /* ---------- 宿主没有 aionui explorer 列时隐藏「文件浏览」入口（issue #48） ----------
     官方 DeepSeek Harness 不带 dsh-web-ui；explorer 列存在与否由下方探测 effect
     标到 frame 上（data-mobile-nav-explorer）。没有列时这两个入口点了没反应。 */
  body[data-dsh-pocket-layout="mobile"] [data-mobile-nav-explorer="0"] [data-mobile-nav="files"],
  body[data-dsh-pocket-layout="mobile"] [data-mobile-nav-explorer="0"] [data-mobile-nav="explorer"] {
    display: none !important;
  }

  /* ---------- 隐藏「添加工作区」入口（issue #17 修正：手机上配工作区无意义） ----------
     图标按钮的 aria-label 随语言变化，两种都覆盖；下拉菜单里的文本项由
     fileGuard.ts 的 MutationObserver 按文案兜底隐藏。由布局属性门控：
     桌面窄窗（auto→desktop）不隐藏，强制 mobile 的宽桌面要隐藏。 */
  body[data-dsh-pocket-layout="mobile"] button[aria-label="添加工作区"],
  body[data-dsh-pocket-layout="mobile"] button[aria-label="添加工作区…"],
  body[data-dsh-pocket-layout="mobile"] button[aria-label="Add workspace"],
  body[data-dsh-pocket-layout="mobile"] button[aria-label="Add workspace…"] {
    display: none !important;
  }

  /* ---------- 文件链接旁的「复制」按钮（issue #17：复制文件内容） ----------
     由 fileGuard.ts 注入，这里兜底样式。M10：实体 22→30px 高、字号 11→12px
     （原尺寸在手指下太抠，30px 仍保持行内紧凑视觉）；剩余触距用 ::after 向外
     扩 6px 补足（Apple HIG 44pt 触控标准的折中：实体紧凑、点区达标，与上游
     扩点伪元素同款手法），自身 position:relative 提供扩区的定位上下文。 */
  [data-mobile-nav="copy-file"] {
    display: inline-flex !important;
    align-items: center;
    justify-content: center;
    margin-left: 6px !important;
    vertical-align: baseline !important;
    position: relative;
    height: 30px !important;
    padding: 0 8px !important;
    border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, .14)) !important;
    border-radius: 6px !important;
    background: var(--dsw-alias-bg-layer-1, #fff) !important;
    color: var(--dsw-alias-label-primary, inherit) !important;
    font-family: inherit !important;
    font-size: 12px !important;
    line-height: 1 !important;
    cursor: pointer !important;
    -webkit-tap-highlight-color: transparent !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .12) !important;
  }
  [data-mobile-nav="copy-file"]::after {
    content: "";
    position: absolute;
    inset: -6px;
  }
  [data-mobile-nav="copy-file"]:active {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06)) !important;
  }
  [data-mobile-nav="copy-file"][disabled] {
    opacity: .55 !important;
    cursor: default !important;
  }
@media (max-width: 1023px) and (pointer: coarse) {
  /* ---------- 右上角双入口冲突治理（0.1.7-rc.2 实测，2026-09-28 合并时发现） ----------
     rc.2 宿主把「右侧栏展开」经 dsh-client-ui-sidebar-right 注入
     conversation.session.header.corner 槽 → header 顶层 div[data-conversation-
     header-corner]（稳定属性，代际安全）。上游 dsh-web-mobile v3.0.3 的两条 corner
     规则分别锚 0.1.6-alpha.2（titleRow 内 + wSkVaW_ 哈希前缀）与 0.1.5（:first-child
     > :last-child）——rc.2 上结构与哈希都已变（D_tfqW_、corner 移到 header 顶层），
     两条全不命中 → 原生 corner 与插件绝对定位的 files 按钮（right:8px）叠在右上角。
     解法取自 dsh-pocket 上游（其 mobile.css.ts 用同一稳定属性 + 本开关）：
     - mobileRightbarEnabled=off → 藏原生 corner，files 独占右上角（web-mobile 的
       设计几何）；
     - 开关默认 on → corner 可见，files 左移 44px 让位（数值同上游实测）。
     特异性：本组覆盖选择器 (0,3,x) 均高于被覆盖的 (0,1,0)/(0,5,1 旧结构规则在
     rc.2 本就不命中)，不赌标签顺序。两态都带 body[data-dsh-pocket-layout] 门：
     桌面布局不藏宿主原生入口。 */
  html body[data-dsh-pocket-layout="mobile"][data-dsh-pocket-mobile-rightbar="off"] [data-conversation-header-corner] {
    display: none !important;
  }
  body[data-dsh-pocket-layout="mobile"]:not([data-dsh-pocket-mobile-rightbar="off"]) [data-conversation-header-corner] {
    display: flex !important;
    flex: 0 0 auto !important;
    margin-left: 4px !important;
    margin-right: 0 !important;
  }
  body[data-dsh-pocket-layout="mobile"]:not([data-dsh-pocket-mobile-rightbar="off"]) [data-conversation-header-corner] button {
    width: 36px !important;
    height: 36px !important;
    min-width: 36px !important;
    min-height: 36px !important;
  }
  body[data-dsh-pocket-layout="mobile"]:not([data-dsh-pocket-mobile-rightbar="off"]) [data-mobile-nav="files"] {
    right: 44px !important;
  }

  /* ---------- 移动端独立字号（2026-10-18 用户要求：手机调字号不影响桌面） ----------
     宿主把「字号大小」写在 body 的 --dsh-content-font-size 上，delta / secondary /
     markdown 字号 token 等派生值全部由它 calc。这里只在「手机布局 + 用户选了独立
     字号」两个条件同时成立时替换这一个轴；!important 用于压过宿主写在 body 上的
     内联值，桌面布局选择器不命中，桌面字号保持原样。 */
  body[data-dsh-pocket-layout="mobile"][data-dsh-pocket-mobile-font] {
    --dsh-content-font-size: var(--dsh-pocket-mobile-font-size) !important;
  }

  /* ---------- 会话行悬停卡片 ----------
     宿主把它挂在 body 下（不在 [data-phase] 内，上游的 tooltip 抑制规则够不着）。
     触屏点一下会话行会模拟 hover，卡片残留在抽屉右侧并溢出屏幕。
     选择器刻意不用「body >」直接子匹配：宿主经 portal 容器挂载时会隔一层 div，
     直接子匹配会漏（卡片类名 _card/_copyable + role=button 组合只属于这类悬停
     卡，去掉大于号不会误伤消息卡）。 */
  body [role="button"][class*="_card"][class*="_copyable"] {
    display: none !important;
  }

  /* ---------- 新会话页多余的右边栏开关 ----------
     宿主 headerBlank 的 titleRow 把「打开右侧边栏」塞在左上角（会话页在右上角
     是对的），紧贴 pocket 的 FAB，看着像多出来的按钮。新会话阶段没有右栏内容，
     直接隐藏；会话页（phase=active）不受影响。 */
  [data-phase="hero"] button[data-sidebar-right-expand] {
    display: none !important;
  }

  /* ---------- 小触点扩大点击区（粗指针） ----------
     宿主按钮普遍只有 22–28px：输入栏（加号/访问模式/模型）、会话头部
     （智能体团队 22×24/更多操作/Watcher/侧边栏开关）、抽屉（搜索/视图选项/
     收起侧边栏/新建会话/展开其余）、hero 的工作区与模式选择器。
     用伪元素把可点区向外扩，不改布局；相邻按钮的实体盒在自己的层绘制，
     不会被邻位的扩区抢走核心点击。分两档（实测间距定值）：
     - 紧凑档 -5px -2px：hero 工作区行 gap:2、会话头部工具组 gap:4、抽屉图标/
       列表行紧邻——横向最多 -2px，恰好吃满 2px 缝隙、绝不越界进邻盒；
     - 输入卡档 -8px：卡内行 gap:12/8，四向扩张都只落在空隙里。
     两档都加 :not(:disabled)：禁用按钮不派发 click，扩区若越到邻位会变成
     按不着的死条。三条边界（均实测核对过 computed ::after）：① 会话头部 tabs
     （对话/轨迹/版本/分叉）自带装饰性 ::after（选中下划线 inset:27px 0 -1），
     套我们的 inset 会把下划线撑成大色块——绝不扩它们；② 消息流内密集小操作簇
     （复制/编辑/反馈，间距仅几像素）不扩——互相抢点反而更难点；③ 抽屉整棵树
     挂在 [data-phase] 之外（实测 inPhase=false），抽屉控件的选择器必须不带
     [data-phase] 前缀，否则永远匹配不到（这些 aria-label 只属于抽屉，去掉
     前缀无误伤）。④ v3.0.3 起设置 sheet/快捷键弹层 portal 到 body，无 [data-phase]
     前缀的 aria-label 选择器一律加 :not([aria-modal] *)，弹层内同文案按钮不扩点
     （弹层自带足够密度的布局，误扩会盖邻位）。 */
  [data-phase] [data-composer-card] button:not(:disabled),
  [data-phase="hero"] button:not([data-mobile-nav]):not(:disabled),
  button[aria-label*="侧边栏"]:not(:disabled):not([aria-modal] *),
  button[aria-label*="right sidebar" i]:not(:disabled):not([aria-modal] *),
  button[aria-label*="搜索会话"]:not(:disabled):not([aria-modal] *),
  button[aria-label*="视图选项"]:not(:disabled):not([aria-modal] *),
  button[aria-label*="新建会话"]:not(:disabled):not([aria-modal] *),
  button[aria-label*="展开其余"]:not(:disabled):not([aria-modal] *),
  [data-phase] button[aria-label*="智能体团队"]:not(:disabled),
  [data-phase] button[aria-label*="更多操作"]:not(:disabled),
  [data-phase] button[aria-label^="Watcher"]:not(:disabled) {
    position: relative;
  }
  /* 紧凑档：横向 -2px 吃满最小缝（gap:2/4），纵向 -5px。 */
  [data-phase="hero"] button:not([data-mobile-nav]):not(:disabled)::after,
  button[aria-label*="侧边栏"]:not(:disabled):not([aria-modal] *)::after,
  button[aria-label*="right sidebar" i]:not(:disabled):not([aria-modal] *)::after,
  button[aria-label*="搜索会话"]:not(:disabled):not([aria-modal] *)::after,
  button[aria-label*="视图选项"]:not(:disabled):not([aria-modal] *)::after,
  button[aria-label*="新建会话"]:not(:disabled):not([aria-modal] *)::after,
  button[aria-label*="展开其余"]:not(:disabled):not([aria-modal] *)::after,
  [data-phase] button[aria-label*="智能体团队"]:not(:disabled)::after,
  [data-phase] button[aria-label*="更多操作"]:not(:disabled)::after,
  [data-phase] button[aria-label^="Watcher"]:not(:disabled)::after {
    content: "";
    position: absolute;
    inset: -5px -2px;
  }
  /* 输入卡档（放最后：与 hero 规则同等特异性，靠后声明让卡内按钮拿到 -8px）。 */
  [data-phase] [data-composer-card] button:not(:disabled)::after {
    content: "";
    position: absolute;
    inset: -8px;
  }

  /* ---------- H5 横屏刘海 safe-area 左右缘 ----------
     全项目（上游 + 本层）此前零处 safe-area-inset-left/right：上游只处理了竖屏的
     top（状态栏）与 bottom（home indicator）。iPhone 横屏（宽 844-932px，仍
     <1024，移动布局激活）时刘海落在屏幕左右缘，FAB（上游 base.css.ts left:10px）、
     抽屉内容、底部 sheet（上游一律 left/right:8px）会被刘海压住。
     为何放 POCKET_EXTRA_CSS：upstream/ 是整目录同步的上游镜像（sync 脚本覆盖，
     手改必丢——零手改原则），只能在 pocket 层以同特异性 + 后加载 + !important 压过。
     为何这一段（与本文件其它段不同）套媒体查询：被覆盖的上游规则本身全部住在
     (max-width:1023px) and (pointer:coarse) 臂内，覆盖必须与被覆盖同臂——否则
     断点翻宽后上游已回退桌面布局（aionui 列恢复网格列、delete-dialog 卸载），
     这里的 left/right !important 却残留，会把桌面网格列拽离原位。竖屏/无刘海
     设备 env() 恒 0，全部零位移。 */
  @media (max-width: 1023px) and (pointer: coarse) {
    /* a) frame 容器：上游同选择器已写 padding-top（layout.css.ts，竖屏让出状态
       栏），这里补左右两缘——中列（会话头/消息流/输入卡）是 in-flow 子元素，
       吃 frame 的 padding，直接让出刘海。 */
    [data-mobile-nav="frame"],
    div[class*="_frame"]:has(> div[class*="_centerCol"]) {
      padding-left: env(safe-area-inset-left, 0px) !important;
      padding-right: env(safe-area-inset-right, 0px) !important;
    }
    /* 抽屉：绝对定位子元素（containing block = frame 的 padding box），上一条的
       frame padding 挪不动它（padding 不影响绝对定位后代的偏移基准），需要自带
       padding-left 把内容让出左侧刘海；抽屉宽 ≤92vw，右侧到不了屏幕右缘，不需要。 */
    [data-mobile-nav="frame"] > :first-child,
    div[class*="_frame"]:has(> div[class*="_centerCol"]) > :first-child {
      padding-left: env(safe-area-inset-left, 0px) !important;
    }
    /* b) FAB（上游 base.css.ts left:10px）：max() 保证无刘海时仍是 10px。 */
    [data-mobile-nav="fab"] {
      left: max(10px, env(safe-area-inset-left, 0px)) !important;
    }
    /* c) 底部 sheet/面板：上游 base.css.ts 的 delete-dialog 与 compat.css.ts 的
       explorer/preview 两列 sheet 全是 left/right:8px。全屏预览态（compat.css.ts
       的三标记 + full 选择器，特异性更高）不受影响。fileGuard 的长按 fallback
       面板是内联样式，在 fileGuard.ts 里直接写同款 max()。 */
    /* 回归修复：aionui 两列选择器单独加 html 前缀提特异性——上游 compat.css 对
       同名选择器写有同特异性 left/right:8px !important，且其 style 标签用
       setTimeout(0) 把自己重排到 head 末尾（同特异性 + !important 对拼时后加载
       者胜，纯赌顺序），赌输则本覆盖整条失效。html 前缀加一档特异性后无论谁
       排在后都稳赢。delete-dialog 不加前缀：上游 base.css 对它没有同值竞争，
       !important 已稳赢，无需陪绑。 */
    [data-aionui-explorer-col],
    html [data-aionui-explorer-col],
    html [data-aionui-preview-col] {
      left: max(8px, env(safe-area-inset-left, 0px)) !important;
      right: max(8px, env(safe-area-inset-right, 0px)) !important;
    }

    /* ---------- M3 键盘期 overlay 协调 ----------
       iOS 软键盘弹起只收缩 visual viewport，fixed 元素仍锚 layout viewport。
       --dshp-kb 由 mobile-apply.tsx 的 effect 监听 visualViewport resize/scroll
       按帧写入 documentElement；键盘收起或 Android（resize 整个视口，差值 ≈0）时
       恒 0px，规则退化为无位移。fileGuard 的 toast/fallback 是内联样式，直接在
       fileGuard.ts 用该变量。FAB 无需处理：它是 frame 内绝对定位、top 锚定，
       永远在屏幕上部，键盘盖不到。
       删除确认卡（2026-09-28 v3.0.3 同步后重写）：上游把卡改成 backdrop
       （fixed inset:0 flex 居中）的 position:static 子元素，bottom/left/right 对它
       全部无效（旧覆盖已死）。改用 translateY 抬升半键盘高——卡原居屏幕中线，
       键盘占掉下半屏后抬一半正好让按钮带留在可视区；0px 时零位移。 */
    [data-mobile-nav="delete-dialog"] {
      transform: translateY(calc(-0.5 * var(--dshp-kb, 0px))) !important;
    }

    /* ---------- M3b 键盘期 composer 座位抬升（2026-09-29 真机反馈：键盘挡住输入内容） ----------
       宿主只在 [data-phase=active]（有内容的会话）给座位 position:sticky;bottom:0，
       钉在滚动视口底=布局视口底；iOS 与 Android(resizes-visual) 的软键盘只收缩
       visual viewport、布局视口不动 → 座位连同输入行整排沉到键盘底下。hero 态
       （空会话）座位更是静态居中，同样被键盘盖。键盘开态统一补 sticky + 把偏移
       改为键盘高度（html[data-dshp-kb="open"] 由 --dshp-kb 写入方同点维护）：
       sticky 只上推不下压——active 态座位钉到可视视口底；hero 态自然位在阈值之上
       时零位移、被键盘压到时同样自动上抬，一条规则通吃两形态。kb 公式已减
       vv.offsetTop，浏览器为露出焦点而滚动页面时偏移自洽。收起态（属性缺席）
       规则不命中，宿主原定位逐字节保留。刻意不用 translateY：座位子树里的
       fixed 弹层（plus 菜单等）会被 transform 变成 containing block，锚定全乱。
       html 前缀与三锚点选择器族同上游座位 padding 规则（防类名哈希代际漂移），
       特异性手法同 M2。
       键盘开态同时置 transform:none（10-14 键盘案）：上游 composer-keyboard-lift
       会给座位内联 translateY 抬升——与本规则双抬叠加、且让座位子树 fixed 弹层
       （plus 菜单）失去锚点。统一到 sticky 单机制：!important 压过上游内联样式，
       通道校验 fail-open 时也绝不再漏抬。 */
    html[data-dshp-kb="open"] [data-mobile-nav="frame"] [class*="_composerSeat"],
    html[data-dshp-kb="open"] div[class*="_frame"] [class*="_composerSeat"],
    html[data-dshp-kb="open"] [data-mobile-nav="frame"] [data-phase] [class*="_composerSeat"] {
      position: sticky !important;
      bottom: var(--dshp-kb, 0px) !important;
      transform: none !important;
    }

    /* ---------- iOS standalone 布局视口偏矮兜底（2026-09-28 真机反馈：A2HS 底部留白） ----------
       部分 iOS 版本的 standalone（添加到主屏幕）模式下，100%/dvh 参照的布局视口
       不含底部一段真实窗口（innerHeight < visualViewport.height，键盘收起且未缩放
       时仍成立）。视口守卫 effect（本文件下方）检测到该态持续 600ms 后：写
       --dshp-frame-h（= 可视高度）并给 html 标 data-dsh-pocket-full-height；此处把
       html/body 高度链顶满真实窗口（frame 是 100% 高度链的后代，自然跟着顶满）。
       标记与变量任一缺席时规则不命中，行为与旧版逐字节一致——不赌宿主原始
       html 高度写法是什么。 */
    html[data-dsh-pocket-full-height],
    html[data-dsh-pocket-full-height] body {
      height: var(--dshp-frame-h, 100%) !important;
    }

    /* 10-14 空白案补注：html/body 顶满只对「frame 是纯 100% 高度链后代」成立——
       中间任何一层被 100vh（B 态下 = 矮布局视口，如 660）截断时顶满传导不到
       frame，底部仍空出等于差值的一条带。给 frame 本体（reconciler 的
       data-mobile-nav="frame" 标记；健康态高度本就等值）直接补一跳，双保险。
       max-height 同值：单写 height 会被中间层的 max-height:100vh 压回。 */
    html[data-dsh-pocket-full-height] [data-mobile-nav="frame"] {
      height: var(--dshp-frame-h, 100%) !important;
      max-height: var(--dshp-frame-h, 100%) !important;
    }

    /* ---------- M10 上游小控件触控达标（44pt 触控标准：Apple HIG / WCAG 2.2） ----------
       上游控件以桌面视觉密度定尺寸（28-38px），手指按压容易 miss。upstream 零手改
       原则 → 在本层用 min-* 覆盖（min-height/width 会压过上游的固定 height/width）。 */
    /* 删除确认弹窗两按钮（base.css.ts [data-mobile-nav="delete-confirm-actions"]>button
       height:30px）→ 44px：破坏性操作的确认键不容 miss。 */
    [data-mobile-nav="delete-confirm-actions"] > button {
      min-height: 44px !important;
    }
    /* 抽屉品牌行「导出会话」图标（v3.2.0 起 28×28，issue #225）：不再给 min-height，
       否则会把品牌行撑高；触控目标由 wrapper 的 28px 图标 + 行内 padding 保证。 */
    /* FAB（base.css.ts 38×38）→ 44×44。 */
    [data-mobile-nav="fab"] {
      min-width: 44px !important;
      min-height: 44px !important;
    }
  }
}`

/**
 * Mobile-adaptive shell, pocket adapter half.
 * @param ctx - client root context.
 */
export function mobileApply(ctx: ClientContext): void {
  // 布局模式（issue #74）：URL 参数 > localStorage > auto(=matchMedia)。
  // desktop 模式（宽屏手机/平板强制电脑布局）下整段 mobile 效果都不挂——
  // 不加 styles、不挂 slots、不跑 effects，直接走 DSH 原生桌面 UI。
  // 注：上游 JS 效果（phone-chrome MOBILE_QUERY）与样式主 gate 均为
  // (max-width: 1023px) and (pointer: coarse)——上游样式原有的裸 (max-width:768px)
  // 宽度臂已在本地补丁中收窄（见 PORTING.md 补丁清单）。pocket 的 narrowMQ 必须
  // 与它们同口径：只看宽度会让桌面窄窗误判成 mobile（fileGuard 拦文件链接、
  // 隐藏「添加工作区」等在桌面浏览器上全数误触发）。
  const urlRaw = new URL(window.location.href).searchParams.get('dsh-layout')
  const urlValue = urlRaw ?? ''
  const narrowMQ = window.matchMedia('(max-width: 1023px) and (pointer: coarse)');
  // 传原始值（含 null=URL 无此参数）：persistLayoutFromUrl 需要区分「无参数」
  // （不动 localStorage，issue #74 的持久化承诺）与「显式 dsh-layout=auto」（清除）。
  const stored = persistLayoutFromUrl(urlRaw);
  const layout = resolveLayout({ urlValue, stored, narrowMatch: narrowMQ.matches });
  document.body?.setAttribute('data-dsh-pocket-layout', layout);
  if (layout === 'desktop') return;
  // 强制 mobile：pocket 附加层（fileGuard、explorer 探测）永远挂；auto 模式
  // 挂载时按真实窄屏判断。M8：附加层效果统一走下方 armOnNarrow（随 narrowMQ
  // change 动态装卸）；强制态的假 narrow 恒 true 且 change 监听为 no-op，行为不变。
  let narrow: MediaQueryList = narrowMQ
  if (layout === 'mobile') {
    narrow = { matches: true, addEventListener: () => {}, removeEventListener: () => {} } as MediaQueryList
  }

  // ---- 回归修复（低）：auto 模式下布局属性随窄屏断点动态同步 ----
  // data-dsh-pocket-layout 此前只在启动写一次：auto（无 URL 强制值、无 localStorage
  // 强制值）下旋转跨 1024px 后，下方 armOnNarrow 会按 narrowMQ 卸载全部附加效果，
  // 但属性仍是启动时的 mobile——POCKET_EXTRA_CSS 里以
  // body[data-dsh-pocket-layout="mobile"] 门控的规则（隐藏「添加工作区」等）在
  // 桌面布局下继续命中，入口被无端藏掉。强制 mobile（假 narrow 恒 true、无 change
  // 事件）与强制 desktop（上方已早退）都不存在断点翻转，无需同步；语义与
  // layout-mode.mjs 的 resolveLayout 一致（auto 分支 = 跟随 narrowMatch）。
  const urlNorm = urlValue.trim().toLowerCase()
  // 显式 ?dsh-layout=auto 是「跟随断点」的权威表达：此时即使 localStorage 里还留着
  // 旧的强制值（persistLayoutFromUrl 的 removeItem 可能因隐私模式/配额失败），
  // 生效布局仍是 auto，断点同步必须照挂——否则旋转屏幕后门控 CSS 会失准。
  const layoutForced = urlNorm === 'desktop' || urlNorm === 'mobile'
    || (urlNorm !== 'auto' && (stored === 'desktop' || stored === 'mobile'))
  if (!layoutForced) {
    ctx.effect(() => {
      const syncLayoutAttr = (): void => {
        document.body?.setAttribute('data-dsh-pocket-layout', narrowMQ.matches ? 'mobile' : 'desktop')
      }
      narrowMQ.addEventListener('change', syncLayoutAttr)
      return () => {
        narrowMQ.removeEventListener('change', syncLayoutAttr)
        // 刻意不清属性：门控 CSS 以它为锚，清掉会让卸载/重载间隙的样式失锚；
        // 下次 mobileApply 启动会按当次断点重写。
      }
    }, 'dsh-pocket: auto layout attribute sync on breakpoint change')
  }

  // ---- M8：pocket 附加层随断点装卸 ----
  // 此前 narrow 只在启动求值一次，三个附加效果（zoom lock、explorer 标记、
  // fileGuard）一锤定音——iPad 旋转跨 1024px 后 fileGuard/zoom-lock/explorer
  // 标记全部残留（旧注释自嘲「旋转后需刷新生效」）。上游 installMobileEffect
  // （phone-chrome.ts）用 matchMedia change 动态装卸，pocket 对齐同款模式：
  // change 回调里按 matches 挂/卸子资源（子清理函数保存好，复用各 effect 的
  // 既有 dispose 逻辑，不留任何监听/注入物/标记残留）。
  const armOnNarrow = (label: string, install: () => (() => void)): void => {
    ctx.effect(() => {
      let dispose: (() => void) | undefined
      const sync = (): void => {
        dispose?.()
        dispose = narrow.matches ? install() : undefined
      }
      sync()
      // 强制 mobile 的假 narrow 没有 change 事件（恒 true、永不翻转）——?. 判空
      // 让真 MediaQueryList 与假对象共用同一路径（假对象自带的 no-op 监听也安全）。
      narrow.addEventListener?.('change', sync)
      return () => {
        narrow.removeEventListener?.('change', sync)
        dispose?.()
      }
    }, label)
  }

  // ---- dsh-web-mobile 上游部分（整目录同步，勿手改 upstream/）----
  upstreamApply(ctx)

  // ---- pocket 附加层 ----

  ctx.effect(() => {
    let active = true
    const applyEnabled = (enabled: boolean): void => {
      document.body?.setAttribute(MOBILE_RIGHTBAR_ATTRIBUTE, enabled ? 'on' : 'off')
    }
    const onChange = (event: Event): void => {
      applyEnabled((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled === true)
    }
    const load = async (): Promise<void> => {
      try {
        const result = await ctx.connection.rpc.call(POCKET_RPC_CHANNEL, POCKET_ENDPOINTS.status, {}) as {
          ok?: boolean
          value?: { mobileRightbarEnabled?: boolean }
        }
        if (active) applyEnabled(result?.ok === true ? result.value?.mobileRightbarEnabled !== false : true)
      } catch {
        if (active) applyEnabled(true)
      }
    }
    window.addEventListener(MOBILE_RIGHTBAR_EVENT, onChange)
    void load()
    return () => {
      active = false
      window.removeEventListener(MOBILE_RIGHTBAR_EVENT, onChange)
      document.body?.removeAttribute(MOBILE_RIGHTBAR_ATTRIBUTE)
    }
  }, 'dsh-mobile-nav: optional right sidebar')

  // 两指捏合缩放开关（2026-10-14）：设置页持久化在宿主侧，手机壳层自己拉
  // status 落 body 属性（不依赖设置页被打开过），并监听设置页广播的事件实时
  // 翻转。属性本身即手势锁与 POCKET_EXTRA_CSS 的执行信号。
  ctx.effect(() => {
    let active = true
    const applyEnabled = (enabled: boolean): void => {
      document.body?.setAttribute(MOBILE_PINCH_ZOOM_ATTRIBUTE, enabled ? 'on' : 'off')
    }
    const onChange = (event: Event): void => {
      applyEnabled((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled === true)
    }
    const load = async (): Promise<void> => {
      try {
        const result = await ctx.connection.rpc.call(POCKET_RPC_CHANNEL, POCKET_ENDPOINTS.status, {}) as {
          ok?: boolean
          value?: { mobilePinchZoomEnabled?: boolean }
        }
        if (active) applyEnabled(result?.ok === true ? result.value?.mobilePinchZoomEnabled === true : false)
      } catch {
        if (active) applyEnabled(false)
      }
    }
    window.addEventListener(MOBILE_PINCH_ZOOM_EVENT, onChange)
    void load()
    return () => {
      active = false
      window.removeEventListener(MOBILE_PINCH_ZOOM_EVENT, onChange)
      document.body?.removeAttribute(MOBILE_PINCH_ZOOM_ATTRIBUTE)
    }
  }, 'dsh-pocket: pinch-zoom setting')

  // 移动端独立字号（2026-10-18）：与上面两个开关同一套模式——手机壳层自己拉
  // status 落 body 标记（不依赖设置页被打开过），并监听设置页广播的事件实时更新。
  // 具体覆盖规则在 POCKET_EXTRA_CSS（只在手机布局命中）。
  ctx.effect(() => {
    let active = true
    const applySize = (size: number): void => {
      const body = document.body
      if (!body) return
      const px = Number(size)
      if (Number.isInteger(px) && px >= MOBILE_FONT_MIN && px <= MOBILE_FONT_MAX) {
        body.style.setProperty(MOBILE_FONT_SIZE_VAR, `${px}px`)
        body.setAttribute(MOBILE_FONT_ATTRIBUTE, String(px))
      } else {
        body.style.removeProperty(MOBILE_FONT_SIZE_VAR)
        body.removeAttribute(MOBILE_FONT_ATTRIBUTE)
      }
    }
    const onChange = (event: Event): void => {
      applySize(Number((event as CustomEvent<{ size?: number }>).detail?.size) || 0)
    }
    const load = async (): Promise<void> => {
      try {
        const result = await ctx.connection.rpc.call(POCKET_RPC_CHANNEL, POCKET_ENDPOINTS.status, {}) as {
          ok?: boolean
          value?: { mobileFontSize?: number }
        }
        if (active) applySize(result?.ok === true ? Number(result.value?.mobileFontSize) || 0 : 0)
      } catch {
        if (active) applySize(0)
      }
    }
    window.addEventListener(MOBILE_FONT_EVENT, onChange)
    void load()
    return () => {
      active = false
      window.removeEventListener(MOBILE_FONT_EVENT, onChange)
      document.body?.style.removeProperty(MOBILE_FONT_SIZE_VAR)
      document.body?.removeAttribute(MOBILE_FONT_ATTRIBUTE)
    }
  }, 'dsh-pocket: mobile font size')

  // 缩放控制（2026-09-14 用户要求：禁双击放大与捏合缩放），手段分工：
  //  - 双击放大：上游根样式 html,body{touch-action:pan-y pinch-zoom!important}
  //    已覆盖（其媒体与 MOBILE_QUERY 同口径），pocket 再注入非 important 的
  //    touch-action 只会被压死——不再注入，避免认知噪音。
  //  - **刻意不追加 maximum-scale/user-scalable**：上游 phone-chrome 把 viewport
  //    meta 视为己有，用 MutationObserver 把 content 锁死为 VIEWPORT_CONTENT
  //    （phone-chrome.ts assertViewport），任何追加都会在下一拍被还原——追加是
  //    死代码；且 iOS 10+ 本就忽略 user-scalable，生效手段只有手势事件。
  //  - 捏合缩放（iOS Safari——本口袋的实际用户端）：H3 改为条件拦截。原实现对
  //    gesturestart/gesturechange 一律 preventDefault，等于焊死了上游 #45 刻意
  //    留下的逃生口——iOS 对 <16px 输入框聚焦会自动放大 viewport，放大之后唯一
  //    的用户侧还原手段就是捏合缩小；standalone（添加到主屏幕）模式没有地址栏、
  //    没有刷新按钮，放大锁死即死锁。语义：**只拦放大，缩小永远放行**。
  //    gesturestart 记 startScale = visualViewport.scale（手势起点的页面缩放级别），
  //    gesturechange 里 event.scale 是相对手势起点的比例，乘积即本次手势的落点缩放；
  //    <= 起点即缩小方向 → 不 preventDefault。开关打开时从任何级别出发的放大都放行；
  //    开关关闭（默认）时 1x 起点的放大仍全拦（2026-09-14 诉求的本体），但页面
  //    一旦已被浏览器放大（>1x），缩小方向仍然放行——那是逃生口，不是「放大」。
  //    gestureend 清起点。visualViewport 缺失（罕见）→ startScale 记 0 → 全拦
  //    退回旧行为：宁可过严，也不制造还原不了的放大。
  //  - Android 端上游刻意保留捏合（VIEWPORT_CONTENT 不写 zoom 令牌），遵循其
  //    决定，不与其 observer 对打。
  //  M8：随 narrowMQ change 动态装卸，旋转跨断点即时生效。
  armOnNarrow('dsh-pocket: mobile zoom lock', () => {
    let startScale = 0
    const onStart = (): void => {
      // visualViewport 罕见缺失（极端老 WebKit / 无 UI 环境探针）→ 记 0，走全拦
      startScale = window.visualViewport?.scale ?? 0
    }
    const onChange = (event: Event): void => {
      const gestureScale = (event as Event & { scale: number }).scale
      // 手势相对起点的比例 <1 即缩小方向；非数（异常事件）一律不当缩小处理。
      const shrinking = typeof gestureScale === 'number' && Number.isFinite(gestureScale) && gestureScale < 1
      // 关键：把「还原」和「放大」分开处理。
      // 关闭捏合（默认）时原实现是双向全拦，页面锁死——但 iOS 对 <16px 输入框
      // 聚焦会自动放大 viewport，这条放大不经手势、拦不到；standalone（添加到
      // 主屏幕）又没有地址栏和刷新按钮，于是用户被锁在一个放大且不可用的页面上。
      // 现在无论开关状态，只要手势起点已经大于 1x，缩小方向一律放行：
      // 禁的始终是「放大」，从不没收唯一的还原手段。
      if (document.body?.getAttribute(MOBILE_PINCH_ZOOM_ATTRIBUTE) !== 'on') {
        if (startScale > 1.0001 && shrinking) return
        event.preventDefault()
        return
      }
      // startScale<=0（vv 缺失）或 scale 为非数（异常事件，NaN 比较为 false）都
      // 落入 preventDefault——fail closed，等价旧的全拦行为。
      if (startScale > 0 && startScale * gestureScale <= startScale) return
      event.preventDefault()
    }
    const onEnd = (): void => { startScale = 0 }
    document.addEventListener('gesturestart', onStart, { passive: false })
    document.addEventListener('gesturechange', onChange, { passive: false })
    document.addEventListener('gestureend', onEnd, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', onStart)
      document.removeEventListener('gesturechange', onChange)
      document.removeEventListener('gestureend', onEnd)
    }
  })

  // 弹层键盘可达性（a11y，pocket 侧补丁）：上游自建的弹层（删除确认、错误卡、
  // 附件选择 sheet）都带 role="dialog" aria-modal="true"，但只做了 Escape 关闭，
  // 没有焦点约束——手机外接键盘/桌面强制 mobile 布局时，Tab 会走到弹层背后的
  // 会话列表上，"模态"对键盘用户不成立；关闭后焦点也不会回到触发按钮。
  // 只接管 pocket 自己注入的弹层（data-mobile-nav 标记），宿主自己的 dialog 不动。
  armOnNarrow('dsh-pocket: dialog focus containment', () => {
    const DIALOG = '[role="dialog"][aria-modal="true"]'
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const triggerStack: HTMLElement[] = []
    const isOurs = (el: Element): boolean =>
      el.hasAttribute('data-mobile-nav') || el.parentElement?.hasAttribute('data-mobile-nav') === true
    const focusables = (node: Element): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.getClientRects().length > 0)
    // 只看「真的可见且在栈顶」的弹层：上游可能用 aria-hidden/inert/display:none 隐藏
    // 旧弹层而不卸载，直接取第一个会把焦点陷阱迁到隐藏节点上（Tab 完全失效）。
    const isShown = (el: Element): boolean =>
      !el.closest('[aria-hidden="true"], [inert]') && el.getClientRects().length > 0
    const topDialog = (): HTMLElement | null => {
      const list = Array.from(document.querySelectorAll<HTMLElement>(DIALOG))
        .filter((el) => isOurs(el) && isShown(el))
      return list.length > 0 ? list[list.length - 1] : null
    }
    let active: HTMLElement | null = null

    const onKeyDown = (event: KeyboardEvent): void => {
      if (active === null || !active.isConnected) return
      if (event.key !== 'Tab') return
      const list = focusables(active)
      if (list.length === 0) {
        // 没有可聚焦子元素：把焦点钉在弹层本身，Tab 不再逃逸到背景。
        event.preventDefault()
        if (document.activeElement !== active) active.focus({ preventScroll: true })
        return
      }
      const first = list[0]
      const last = list[list.length - 1]
      const current = document.activeElement as HTMLElement | null
      if (event.shiftKey && (current === first || !active.contains(current))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (current === last || !active.contains(current))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKeyDown, true)

    // 弹层出现/消失都从 DOM 突变看：上游用 innerHTML + append 建卡片，没有可挂的
    // 生命周期回调。只在真正换了弹层对象时才动焦点，避免每次突变都抢焦点。
    const sync = (): void => {
      const dialog = topDialog()
      if (dialog === active) return
      if (active !== null && dialog !== null) {
        // 弹层被**替换**（菜单 → 删除确认 / 错误卡）：这不是关闭，不能把焦点
        // 还给背后的触发按钮——直接把陷阱移到新弹层。
        // 旧实现走 close 分支后 active=null 且 return，新弹层要等下一次 DOM
        // 突变才会重新拿到焦点；上游用 innerHTML 重建卡片时可能很久没有下一次
        // 突变，期间 Tab 可以穿回背景列表，"模态"短暂失效（审计 F1）。
        // 保留 triggerStack：替换后的弹层关闭时仍要回到最初的触发按钮（close 分支有
        // isConnected 守卫，opener 被卸载时不会乱聚焦）。审计反向验证：在这里 pop 会
        // 让关闭弹层后焦点落回 body，对键盘/读屏用户是倒退。
        active = dialog
        if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
        const list = focusables(dialog)
        ;(list[0] ?? dialog).focus({ preventScroll: true })
        return
      }
      if (active !== null) {
        // 弹层关闭：焦点还给触发它的那个按钮（它可能也已经被卸载）。
        const back = triggerStack.pop()
        active = null
        if (back !== undefined && back.isConnected) back.focus({ preventScroll: true })
        return
      }
      active = dialog
      if (dialog === null) return
      const opener = document.activeElement as HTMLElement | null
      if (opener !== null && opener !== document.body && !dialog.contains(opener)) triggerStack.push(opener)
      // 弹层自身需要 tabindex 才能成为无子元素时的焦点锚。
      if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
      const list = focusables(dialog)
      ;(list[0] ?? dialog).focus({ preventScroll: true })
    }
    let raf = 0
    const schedule = (): void => { if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; sync() }) }
    sync()
    const observer = new MutationObserver((mutations) => {
      // 输入法/流式输出会持续改 characterData 与文本节点，那些与弹层无关。
      for (const m of mutations) {
        if (m.type !== 'childList') continue
        for (const n of m.addedNodes) { if (n.nodeType === 1) { schedule(); return } }
        for (const n of m.removedNodes) { if (n.nodeType === 1) { schedule(); return } }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
      // 卸载时弹层还在（切布局）：移除我们加的 tabindex，别留 pocket 痕迹。
      active?.removeAttribute('tabindex')
      active = null
      triggerStack.length = 0
    }
  })

  // explorer 可用性标记（issue #48）：上游假定宿主装了 dsh-web-ui（aionui 列），
  // 官方 DSH 没有。探测列存在与否标到 frame 上，配 POCKET_EXTRA_CSS 隐藏死按钮。
  // M8：随 narrowMQ change 动态装卸（断点翻宽即撤标记，不再残留）。
  armOnNarrow('dsh-pocket: explorer availability (issue #48)', () => {
    const frame = (): HTMLElement | null => document.querySelector('[data-mobile-nav="frame"]')
    let raf = 0
    const check = () => {
      raf = 0
      const has = document.querySelector('[data-aionui-explorer-col]') !== null ? '1' : '0'
      const el = frame()
      if (el !== null && el.getAttribute('data-mobile-nav-explorer') !== has) el.setAttribute('data-mobile-nav-explorer', has)
    }
    check()
    const timer = window.setTimeout(check, 1500) // 宿主懒渲染：稍后再查一次
    const schedule = (): void => { if (raf === 0) raf = requestAnimationFrame(check) }
    const observer = new MutationObserver((mutations) => {
      // 只关心结构变化（explorer 列的出现/消失）。流式输出期间每个 token 都是
      // 文本节点增删，若不区分，流式全程每帧都要为这个几乎不变的标记跑两次
      // 全文档 querySelector——纯文本突变直接跳过。
      for (const m of mutations) {
        for (const n of m.addedNodes) { if (n.nodeType !== 3) { schedule(); return } }
        for (const n of m.removedNodes) { if (n.nodeType !== 3) { schedule(); return } }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      window.clearTimeout(timer)
      if (raf !== 0) cancelAnimationFrame(raf)
      observer.disconnect()
      // 标记属性随 frame 存活跨插件重载，卸载时不留 pocket 专属残留
      frame()?.removeAttribute('data-mobile-nav-explorer')
    }
  })

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-pocket'
    tag.dataset.pluginCss = 'dsh-pocket/mobile-extras.css'
    tag.textContent = POCKET_EXTRA_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-pocket: mobile extra styles (issue #17/#48)')

  // M3：键盘高度 CSS 变量。iOS 软键盘弹起只收缩 visual viewport（layout viewport
  // 不动），底部锚定的 fixed 弹层（fileGuard 的 toast/长按 fallback 面板、上游
  // session-menu 的删除确认弹窗）仍按 layout viewport 定位，全部沉到键盘底下。
  // 这里把键盘高度写进 documentElement 的 --dshp-kb = max(0px, innerHeight -
  // visualViewport.height - visualViewport.offsetTop)，供上述弹层的 bottom calc()
  // 消费（POCKET_EXTRA_CSS 覆盖上游 delete-dialog；fileGuard 内联样式直接用；
  // M3b composer 座位抬升同吃此变量，见 POCKET_EXTRA_CSS）。
  // Android 不需要也不受影响：其键盘弹出 resize 整个视口，innerHeight 与
  // vv.height 同步收缩，差值恒 ≈0。resize/scroll 在键盘动画期间每帧触发，rAF
  // 合并 + 同值短路，避免每帧写 style 强制重排。visualViewport 缺失（罕见）不挂。
  armOnNarrow('dsh-pocket: keyboard height css var (--dshp-kb)', () => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return () => {}
    const root = document.documentElement
    let raf = 0
    let last = ''
    let lastKb = 0
    let liftActive = false
    // B5：座位元素缓存（isConnected 短路，模式同 installed-list 的 resolveRoot）。
    // 多会话并存时取「有 rect 的可见实例」语义不变——缓存命中也要仍可见（rects
    // 非空），失联/转隐藏才回到全量 querySelectorAll 重查。
    let seatEl: HTMLElement | null = null
    const findSeat = (): HTMLElement | null => {
      if (seatEl !== null && seatEl.isConnected && seatEl.matches('[data-composer-seat]') && seatEl.getClientRects().length > 0) return seatEl
      seatEl = Array.from(document.querySelectorAll<HTMLElement>('[data-composer-seat]')).find(el => el.getClientRects().length > 0) ?? null
      return seatEl
    }
    const write = (): void => {
      raf = 0
      const raw = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      // 遮挡地板（10-14 键盘抬升案）：raw 公式在「iOS 平移露出焦点」模型下恒为 0
      //（offsetTop 恰好抵消内高差），叠加座位 rect 与 vv.height 直比的上游 transform
      // 抬升又被其 scrollY/offsetTop 通道校验 fail-open 清零——输入框真被键盘盖住
      // 时三条路全哑（真机症状：点击输入框不跟随上移）。改取 raw 与「座位实际低于
      // 可视带」的较大者：occl = 静止底边 − vv.height（同为布局 px）。静止底边 =
      // rect.bottom + 上次写入的抬升量——sticky 已把座位抬离流位时加回，否则下一帧
      // occl 读到抬升后的底边会自我取消、来回振荡。scale≠1（捏合）时 rect 与
      // vv.height 换算混乱，occl 不采信（raw 路径维持原行为）。
      let occl = 0
      if (Math.abs(vv.scale - 1) < 0.01) {
        const seat = findSeat()
        if (seat !== null) {
          const restBottom = seat.getBoundingClientRect().bottom + (liftActive ? lastKb : 0)
          occl = Math.max(0, restBottom - vv.height)
        }
      }
      // 回归修复（低）：强制 mobile + 桌面浏览器缩放 ≠100% 时，innerHeight 与
      // vv.height 的换算会出现正值（并无键盘），toast/fallback 被无端抬升。真实
      // 软键盘高度物理上不会超过视口六成，超出即判为缩放伪差，钳到 60% innerHeight。
      const kb = Math.min(Math.max(raw, occl), Math.round(window.innerHeight * 0.6))
      lastKb = kb
      liftActive = kb > 0
      const value = `${Math.round(kb)}px`
      if (value === last) return
      last = value
      root.style.setProperty('--dshp-kb', value)
      // 键盘开合标记：POCKET_EXTRA_CSS 的 composer 座位抬升（M3b）只在开态命中，
      // 收起态完全不覆盖宿主原 bottom 值。与 setProperty 同点同短路，两态不漂移。
      if (kb > 0) root.setAttribute('data-dshp-kb', 'open')
      else root.removeAttribute('data-dshp-kb')
    }
    const schedule = (): void => { if (raf === 0) raf = requestAnimationFrame(write) }
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    write()
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (raf !== 0) cancelAnimationFrame(raf)
      seatEl = null
      root.style.removeProperty('--dshp-kb')
      root.removeAttribute('data-dshp-kb')
    }
  })

  // iOS standalone 视口守卫（2026-09-28 真机反馈：A2HS 打开底部留白 ~65pt、
  // composer 抬离底边）。桌面/浏览器不受影响，仅窄屏挂载。病源分三态治理：
  //  A. 键盘收起后文档残留滚动——iOS standalone 经典陷阱：frame 设计上恰好一
  //     视口高、文档本不可滚，任何 scrollY>0（或 vv.offsetTop>0）都是键盘交互
  //     的残留 → scrollTo(0,0) 归位（症状与 layout.css.ts border-box 注释描述的
  //     「整个 UI 可上滑、composer 抬离底部留空带」一致，但成因不同）。
  //  B. 布局视口矮于真实窗口——部分 iOS 版本 standalone 下 100%/dvh 参照的布局
  //     视口不含底部一段（innerHeight < vv.height 且 scale=1、键盘收起）→ 把
  //     可视高度写进 --dshp-frame-h 并标 data-dsh-pocket-full-height，由
  //     POCKET_EXTRA_CSS 把 html/body 高度链顶满。600ms 去抖双向生效/解除，
  //     避开键盘动画与转场瞬态。
  //  C. 诊断探针：URL 带 ?dshp-diag=1 常显；B 态触发时自动显示 8 秒。顶部小字
  //     实时输出 ih|vv|off|sc|sy 五元组，真机再截图即可精确定位剩余问题。
  // 互斥保护：B 生效时文档可能因 frame 变高而可滚，跳过 A 的归位（否则打架）。
  armOnNarrow('dsh-pocket: standalone viewport guard (scroll residue / short layout viewport)', () => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return () => {}
    const root = document.documentElement
    let raf = 0
    let shortSince = 0
    let applied = false
    let diagEl: HTMLDivElement | null = null
    let diagTimer = 0
    const wantDiag = new URLSearchParams(window.location.search).has('dshp-diag')
    const showDiag = (auto: boolean): void => {
      if (diagEl === null) {
        diagEl = document.createElement('div')
        diagEl.dataset.dshPocketDiag = '1'
        // 三轮升级：nowrap 在 390pt 宽屏把行尾字段截出屏外（真机「结尾只到
        // seatB=」实为右缘裁切而非旧代码）——改换行铺满视口宽，行尾信息必须
        // 全部可见。
        diagEl.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 2px);left:2px;z-index:2147483647;font:10px/1.4 ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.65);color:#4ade80;padding:2px 6px;border-radius:4px;pointer-events:none;white-space:normal;width:calc(100vw - 8px);word-break:break-all'
        document.body.appendChild(diagEl)
      }
      // 10-14 空白案：追加滚动区/座位几何（宿主稳定标记 data-conversation-scroll /
      // data-composer-seat）——B 态补注定失败时，一张截图即可点名断在哪一层。
      // 二轮升级：滚动区限定为座位自己的那个（querySelector 全局首个在多会话实例
      // 下会探到隐藏实例）；加 va/col/nz 三元组量化宿主虚拟列状态——WebKit 上
      // 虚拟化保留高塌缩（列高≈已挂载窗口高）正是 643 悬空的另一半病因。
      // 座位取「可见实例」：多会话并存时全局首个可能是隐藏实例（无 rect，
      // seatB 量到 0 或别的会话）。三轮：va/col/nz 无条件输出（- 占位）——
      // 条件输出下「字段缺失=旧代码」与「字段缺失=没找到列」无法判别。
      const seatEl =
        Array.from(document.querySelectorAll<HTMLElement>('[data-composer-seat]')).find(
          el => el.getClientRects().length > 0,
        ) ?? null
      const sbEl = seatEl?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
      const vaEl = sbEl?.querySelector<HTMLElement>('[class*="_viewArea"]') ?? null
      let colNote = ' va=-/col=-/nz=-'
      if (vaEl !== null) {
        colNote = ` va=${Math.round(vaEl.getBoundingClientRect().height)}/col=-/nz=-`
        // 列 = viewArea 向下首个「子元素 >10 个」的容器（宿主虚拟列的稳定形状）
        let n: HTMLElement | null = vaEl
        for (let i = 0; i < 6 && n !== null; i += 1) {
          if (n.children.length > 10) {
            const nz = Array.from(n.children).filter(c => (c as HTMLElement).offsetHeight > 0).length
            colNote = ` va=${Math.round(vaEl.getBoundingClientRect().height)} col=${Math.round(n.getBoundingClientRect().height)} nz=${nz}/${n.children.length}`
            break
          }
          n = n.firstElementChild as HTMLElement | null
        }
      }
      const sbNote = sbEl === null ? '' : ` sb=${sbEl.clientHeight}/${sbEl.scrollHeight}@${Math.round(sbEl.scrollTop)}`
      const seatNote = seatEl === null ? '' : ` seatB=${Math.round(seatEl.getBoundingClientRect().bottom)}`
      // kb 态（10-14 键盘案）：kbc=--dshp-kb 实际写入值 / f=data-dshp-kb 开态标记。
      // 键盘展开截图看这两个字段：kbc=0px/f=0 = 写入方判定无键盘（公式哑了），
      // kbc=NNpx/f=1 且 seatB 还在键盘下 = CSS 抬升规则没命中。
      const kbc = getComputedStyle(root).getPropertyValue('--dshp-kb').trim() || '0px'
      const kbf = root.hasAttribute('data-dshp-kb') ? 1 : 0
      // tag=探针构建号：一眼判别真机跑的是不是新包（缺 tag=即旧包/旧文档）
      diagEl.textContent = `tag=1014.3 ih=${window.innerHeight} vv=${Math.round(vv.height)} off=${Math.round(vv.offsetTop)} sc=${vv.scale.toFixed(2)} sy=${window.scrollY}${sbNote}${seatNote}${colNote} kbc=${kbc}/f=${kbf}`
      if (auto) {
        window.clearTimeout(diagTimer)
        diagTimer = window.setTimeout(() => { diagEl?.remove(); diagEl = null }, 8000)
      }
    }
    const check = (): void => {
      raf = 0
      const kbClosed = vv.height >= window.innerHeight - 8
      // B：布局视口持续偏矮（scale=1 且非键盘，差值 >8px）→ 高度链顶满真实窗口
      const short = Math.abs(vv.scale - 1) < 0.01 && vv.height - window.innerHeight > 8
      if (short) {
        if (shortSince === 0) shortSince = performance.now()
        if (!applied && performance.now() - shortSince > 600) {
          applied = true
          root.style.setProperty('--dshp-frame-h', `${Math.round(vv.height)}px`)
          // 差值单独发布（B 态=可视高−布局视口高，如 758−660=98px）：CSS 侧补偿
          // 与诊断用；解除时随 --dshp-frame-h 一并撤除
          root.style.setProperty('--dshp-vh-diff', `${Math.round(vv.height - window.innerHeight)}px`)
          root.setAttribute('data-dsh-pocket-full-height', '')
          // 10-14 空白案补注：视口从 660 顶到 758 后宿主的 at-bottom 跟随不会重跑
          //（它的 scrollTop 目标按旧视口算过、已「到底」）——对话滚动区若原本就贴
          // 底（余量 ≤8px），下一帧再推一次到底，消除内容与钉底座位之间等于差值
          // 的空带；不贴底则不动，不与用户的手动滚动打架。
          // 补推同样限定可见实例：全局首个若是隐藏会话，补推就打在死实例上
          const sb =
            Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-scroll]')).find(
              el => el.getClientRects().length > 0,
            ) ?? null
          if (sb !== null && sb.scrollHeight - sb.scrollTop - sb.clientHeight <= 8) {
            requestAnimationFrame(() => { if (applied && sb.isConnected) sb.scrollTop = sb.scrollHeight })
          }
          showDiag(true)
        }
      } else {
        shortSince = 0
        if (applied) {
          applied = false
          root.style.removeProperty('--dshp-frame-h')
          root.style.removeProperty('--dshp-vh-diff')
          root.removeAttribute('data-dsh-pocket-full-height')
        }
      }
      // A：文档滚动残留归位（仅 B 未生效时——B 生效后文档因 frame 变高可滚）
      if (!applied && kbClosed && (window.scrollY > 1 || vv.offsetTop > 1)) window.scrollTo(0, 0)
      if (wantDiag) showDiag(false)
    }
    const schedule = (): void => { if (raf === 0) raf = requestAnimationFrame(check) }
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    window.addEventListener('focusout', schedule)
    window.addEventListener('pageshow', schedule)
    check()
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      window.removeEventListener('focusout', schedule)
      window.removeEventListener('pageshow', schedule)
      if (raf !== 0) cancelAnimationFrame(raf)
      window.clearTimeout(diagTimer)
      diagEl?.remove()
      root.style.removeProperty('--dshp-frame-h')
      root.style.removeProperty('--dshp-vh-diff')
      root.removeAttribute('data-dsh-pocket-full-height')
    }
  })

  // 移动端文件守卫（issue #17 修正）：手机上点 dsh-web 渲染的文件链接会触发桌面
  // 端 workspaces.openPath(open ...) —— 既打不开（路径在电脑上），又会抛
  // "path open failed"。这里在捕获阶段拦截这类点击 / 键盘激活，改为弹一个提示，
  // 并隐藏「添加工作区」入口（手机上配工作区无意义）；同时在文件链接旁注入
  // 「复制」按钮，点它经主机 RPC 读取文件正文再写入剪贴板。M8：随 narrowMQ
  // change 动态装卸。H4：fileGuard 是非 React 的 DOM 注入层，拿不到设置页 slot
  // 的 t()——词典键在 pocket-locales.js（NS='pocket'），从 ctx.locale 绑定后经
  // startFileGuard 入参传入（bind 惰性取词，注册顺序在后也不影响）。
  armOnNarrow('dsh-pocket: file open guard + copy button + hide add-workspace (issue #17)', () => {
    // 当前会话 id：主机侧优先用它把相对路径解析到「这条消息所属项目」的目录。
    // 客户端只知道会话 id，不知道会话的 cwd；因此 cwd 由主机按 id 查，客户端
    // 传的 cwd 只作最后兜底（多工作区下它永远是第一个工作区，是错的来源）。
    const currentSessionId = (): string | undefined => {
      try {
        const list = (ctx as unknown as {
          sessions?: { list?: { getSnapshot?: () => unknown } }
        }).sessions?.list?.getSnapshot?.() as {
          current?: unknown
          byId?: Record<string, { id?: unknown; retainedBy?: { mainView?: unknown } }>
        } | undefined
        if (list === null || typeof list !== 'object') return undefined
        if (typeof list.current === 'string') return list.current
        for (const key in list.byId) {
          const summary = list.byId[key]
          if (summary === undefined) continue
          const mainView = summary.retainedBy?.mainView
          if (typeof mainView === 'number' && mainView > 0 && typeof summary.id === 'string') return summary.id
        }
      } catch { /* 服务形状不同（a2/rc 代际差异）→ 不给 sessionId，主机退回旧逻辑 */ }
      return undefined
    }
    // 尽量拿到当前工作区 cwd（文件链接文案是相对它的），传给主机 RPC 做精确解析；
    // 拿不到就回退到主机 process.cwd()。dsh-web 的 workspaces 服务暴露当前工作区。
    // 注意这只是兜底：真正权威的来源是 sessionId → header.cwd（主机侧解析）。
    const getWorkspaceCwd = (): string => {
      try {
        const ws = (ctx as unknown as { get?: (k: string) => unknown }).get?.('workspaces')
          ?? (ctx as unknown as { workspaces?: unknown }).workspaces
        const list = (ws as { list?: unknown })?.list
        const arr: unknown[] | null = Array.isArray(list)
          ? list
          : (list && typeof list === 'object' && 'value' in (list as object)
            ? (list as { value: unknown[] }).value
            : null)
        if (Array.isArray(arr)) {
          for (const w of arr) {
            const c = (w as { cwd?: string; root?: string })?.cwd
              ?? (w as { cwd?: string; root?: string })?.root
            if (typeof c === 'string' && c) return c
          }
        }
      } catch { /* 忽略，回退 process.cwd() */ }
      return ''
    }
    // 手机侧读文件回调：走 dsh-pocket 的 RPC 通道，由主机侧 fileRead 端点处理。
    const readFile = (filePath: string) => {
      const sessionId = currentSessionId()
      return ctx.connection.rpc.call(
        POCKET_RPC_CHANNEL,
        POCKET_ENDPOINTS.fileRead,
        {
          path: filePath,
          cwd: getWorkspaceCwd(),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
      ) as Promise<{ ok: boolean; value?: { content: string; path: string; size: number }; error?: { message: string } }>
    }
    // H4：词典取词——上游 session-menu.ts 同款 ctx.locale.bind 用法；cast 成
    // 简单签名后交给 startFileGuard。
    const fileGuardT = ctx.locale.bind(POCKET_NS) as (key: string) => string
    return startFileGuard(readFile, fileGuardT)
  })
}

// Type-only augmentation imports: pull the layout / conversation / sidebar /
// settings SlotMap merges and the sessionLogDownload service typing into this
// program without any runtime import.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-session-log-export/client'
