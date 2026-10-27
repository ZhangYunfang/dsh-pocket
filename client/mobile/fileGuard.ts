// 移动端文件守卫（issue #17）：dsh-web 在手机上点「文件链接」会触发桌面端
// workspaces.openPath(open <path>)，既打不开（文件在电脑上），又会抛
// "path open failed". 这里做两件事：
//   1) 捕获阶段拦截这类激活（点击 / 键盘），改为弹一个提示；
//   2) 在每个文件链接旁注入一个「复制」按钮，点它经主机 RPC 读文件正文再写剪贴板。
// 另外隐藏「添加工作区」入口（手机上配工作区无意义）。
// 移植自 dsh-web-mobile（MIT）。
//
// 识别方式：不依赖 dsh-web 的 hash 类名（每次构建都变），只认「文本像文件路径的
// <button>/<a>」——文件链接按钮的文案就是路径（如 lib/proxy.mjs / /Users/.../x.ts）。
//
// H4 误伤收敛（三层，修复全文档捕获时代的误伤）：
//   a. 带 scheme 的文本（如以 /x.pdf 结尾的 https://… 链接）不算路径——file://
//      例外：手机上 file:// 同样指向电脑上的文件，继续走后续路径判断；
//   b. 拦截与注入只处理消息流容器（[data-phase] 内）的目标：抽屉/头部/tab 栏/
//      菜单不在 data-phase 内，天然豁免（此前文件查看器 tab、以路径命名的会话行
//      /菜单项全被误伤）；
//   c. 明确 ARIA 角色（tab/treeitem/menuitem/menu）不拦不注入——tab 文案就是
//      路径（文件查看器），会话行是 treeitem，菜单项是 menuitem。
//
// H4 文案 i18n：本模块是非 React 环境的 DOM 注入层，拿不到设置页 slot 的 t()；
// 词典键注册在 client/pocket-locales.js（NS='pocket'，zh 为源真 / en 同键），
// 由 mobile-apply.tsx 从 ctx.locale.bind 取好后经 startFileGuard 入参传入（与
// 上游 session-menu.ts 的 ctx.locale.bind 用法同源）。{占位符} 手工替换，与
// client/index.jsx 的 fmt 同款，不依赖宿主 t() 的插值行为。

/** 「添加工作区」入口的文案（随语言变化），两种都覆盖。
 *  这是**匹配宿主渲染文案**用的探针（非本层显示的文案），双语文案字面量
 *  必须保留，不进词典。 */
const WS_LABELS = ['添加工作区', '添加工作区…', 'Add workspace', 'Add workspace…']

/** H4c：明确角色豁免——tab（文件查看器等，文案就是路径）、会话行（treeitem）、
 *  菜单项/菜单容器。命中即不拦、不注入「复制」按钮。 */
const ROLE_EXEMPT = '[role="tab"], [role="treeitem"], [role="menuitem"], [role="menu"]'

/** L5：>2MB 不写剪贴板——手机浏览器写超大文本常超时/直接崩页面，直接提示跳过。 */
const MAX_COPY_BYTES = 2 * 1024 * 1024
/** L5：长按 fallback 面板只展示前 64KB + 尾注「…已截断」——64KB 的 <pre> 已经
 *  很重，全量渲染 MB 级文本会卡死面板滚动。按 UTF-16 码元近似，够用。 */
const FALLBACK_PREVIEW_CHARS = 64 * 1024

/** 主机 fileRead 回调返回结构（与 client/api.js 的 FileReadResult 对齐）。 */
interface ReadFileResponse {
  ok: boolean;
  value?: { content: string; path: string; size: number };
  error?: { message: string };
}

/** 文本是否像文件路径：绝对路径 / 结尾为「目录/文件.扩展名」的相对路径。
 *  刻意不做「文本中段内嵌 x/y.z」的匹配——按钮文案里出现
 *  「fix: client/api.js 崩溃」这类片段就整段拦截是误伤（原文第三条正则两端
 *  不锚定，且锚定后又完全被「结尾匹配」那条覆盖，故直接删除）。
 *  H4a：开头是 scheme:// 的文本直接放行——正常网址（https://…/x.pdf 等）
 *  常以 /文件.ext 结尾，会命中下面的「结尾匹配」造成误拦；file:// 例外，
 *  让它继续走后面的路径判断（手机上它同样指向电脑文件）。 */
function looksLikeFilePath(text: string | null): boolean {
  const t = (text ?? '').trim()
  if (t.length < 3 || t.length > 320) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t) && !/^file:\/\//i.test(t)) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(t)) return true
  if (/\/[\w.\-]+\.\w{1,12}$/.test(t)) return true
  return false
}

/** 写剪贴板：优先 navigator.clipboard，非安全上下文（局域网 http）回退 execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 回退 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '-9999px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const okCopy = document.execCommand('copy')
    ta.remove()
    return okCopy
  } catch {
    return false
  }
}

export function startFileGuard(
  readFile: (path: string) => Promise<ReadFileResponse>,
  t: (key: string) => string,
): () => void {
  // 卸载标记：复制是「RPC + 写剪贴板」两段 await，回来后可能已经热重载/切布局，
  // 此时 toast 容器和按钮都已被上一个实例回收。继续往 document 上写会留下
  // 无主节点（悬空 toast 永不消失）并把旧实例的文案盖到新实例上。
  let disposed = false
  /** {占位符} 手工插值（与 client/index.jsx 的 fmt 同款）：不依赖宿主 t() 的
   *  插值能力，避免行为不一致。 */
  const fmt = (key: string, vars?: Record<string, string | number>): string => {
    let s = t(key)
    if (vars !== undefined) {
      for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    }
    return s
  }

  // 轻量 toast：自包含，不依赖 dsh-pocket 面板的 React 状态。
  // M3：bottom 叠加 --dshp-kb（mobile-apply.tsx 按 visualViewport 写入的键盘
  // 高度）——iOS 键盘弹着时 fixed 底部锚定的 toast 会沉到键盘底下；键盘收起
  // 或 Android 上变量恒 0px，退化为原值。
  let toastEl: HTMLElement | null = null
  let toastTimer: number | null = null
  const showToast = (text: string): void => {
    if (toastEl === null) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('data-mobile-nav', 'file-guard-toast')
      Object.assign(toastEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: 'calc(64px + var(--dshp-kb, 0px))',
        transform: 'translateX(-50%)',
        maxWidth: '84vw',
        zIndex: '9999',
        padding: '10px 14px',
        borderRadius: '10px',
        background: 'rgba(20,22,28,.92)',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.4',
        textAlign: 'center',
        fontFamily: 'inherit',
        boxShadow: '0 4px 16px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity .18s ease',
      } as CSSStyleDeclaration)
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    requestAnimationFrame(() => {
      if (toastEl !== null) toastEl.style.opacity = '1'
    })
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      if (toastEl !== null) toastEl.style.opacity = '0'
    }, 2600)
  }

  // 剪贴板写入失败（iOS Safari + http 局域网等非安全上下文，execCommand 也失效）
  // 时的下文：提示文案说「请手动选择」，就必须给出一段真正可长按选中的文本，
  // 否则用户无从复制，是个死胡同。
  // M3：面板是 fixed 底部锚定，iOS 键盘弹着时会被压在键盘底下——显示前先收键盘
  // （activeElement.blur），bottom 再叠加 --dshp-kb 兜底（键盘未收干净的情况）。
  // H5c：左右用 max(8px, env(safe-area-inset-*)) 让出横屏刘海。
  // L5：>64KB 截断 + 尾注（全量渲染 MB 级文本会卡死面板滚动）。
  let fallbackEl: HTMLElement | null = null
  const showTextFallback = (text: string): void => {
    // M3：先收键盘——面板要从键盘底下升上来，留着焦点键盘不会退。
    ;(document.activeElement as HTMLElement | null)?.blur()
    fallbackEl?.remove()
    const truncated = text.length > FALLBACK_PREVIEW_CHARS
    const preview = truncated
      ? `${text.slice(0, FALLBACK_PREVIEW_CHARS)}\n${t('fileTruncated')}`
      : text
    const panel = document.createElement('div')
    panel.setAttribute('data-mobile-nav', 'file-guard-fallback')
    Object.assign(panel.style, {
      position: 'fixed',
      left: 'max(8px, env(safe-area-inset-left, 0px))',
      right: 'max(8px, env(safe-area-inset-right, 0px))',
      bottom: 'calc(16px + env(safe-area-inset-bottom, 0px) + var(--dshp-kb, 0px))',
      maxHeight: '45vh',
      overflow: 'auto',
      zIndex: '10000',
      padding: '10px 12px',
      borderRadius: '10px',
      background: 'rgba(20,22,28,.96)',
      color: '#eee',
      boxShadow: '0 6px 24px rgba(0,0,0,.4)',
      WebkitOverflowScrolling: 'touch',
    } as CSSStyleDeclaration)
    const head = document.createElement('div')
    Object.assign(head.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: '12px', color: '#9aa0a8', marginBottom: '6px',
    } as CSSStyleDeclaration)
    const title = document.createElement('span')
    title.textContent = t('fileFallbackTitle')
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = t('fileFallbackClose')
    Object.assign(close.style, {
      border: '1px solid #444a52', background: 'transparent', color: '#eee',
      borderRadius: '6px', padding: '2px 10px', fontSize: '12px', cursor: 'pointer',
    } as CSSStyleDeclaration)
    close.addEventListener('click', () => { panel.remove() })
    const pre = document.createElement('pre')
    pre.textContent = preview // L5：截断后的预览（>64KB 时尾部带「…已截断」尾注）
    Object.assign(pre.style, {
      margin: '0', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      userSelect: 'text', WebkitUserSelect: 'text', fontSize: '12px',
      lineHeight: '1.5', fontFamily: 'inherit',
    } as CSSStyleDeclaration)
    head.append(title, close)
    panel.append(head, pre)
    document.body.appendChild(panel)
    fallbackEl = panel
  }

  // 捕获阶段拦截文件链接的激活。按钮的键盘激活（Enter/Space）会派发 click，
  // 因此只拦 click 即可同时覆盖鼠标与键盘，避免重复处理。
  // H4b/c：只处理消息流容器（[data-phase]）内的目标，且 tab/treeitem/menuitem/
  // menu 等明确角色豁免——文件查看器 tab（文案就是路径）、以路径命名的会话行、
  // 菜单项都不再被误伤。
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    if (target === null) return
    const el = target.closest('button, a') as HTMLElement | null
    if (el === null) return
    if (el.closest('[data-phase]') === null) return
    if (el.closest(ROLE_EXEMPT) !== null) return
    if (!looksLikeFilePath(el.textContent)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showToast(t('fileGuardMsg'))
  }
  document.addEventListener('click', onClick, true)

  // 在文件链接旁注入「复制」按钮：点它经主机 RPC 读文件正文再写剪贴板。
  // 用 data-mobile-nav-copy 标记已处理的链接，避免重复注入；React 重渲染会
  // 产生新元素（无标记），MutationObserver 重新补上按钮。
  // H4b/c：与 onClick 拦截同款的两层豁免——消息流之外的、明确角色的目标不注入
  // （否则会在文件查看器 tab、会话行、菜单项旁边长出无关按钮）。
  let copySeq = 0;
  const injectCopyButtons = (root: ParentNode = document): void => {
    const links = root.querySelectorAll('button, a')
    const own = root instanceof Element && root.matches('button, a') ? [root, ...links] : links
    own.forEach((el) => {
      if (el.getAttribute('data-mobile-nav-copy') === '1') return
      if (el.closest('[data-phase]') === null) return
      if (el.closest(ROLE_EXEMPT) !== null) return
      const txt = (el.textContent ?? '').trim()
      if (!looksLikeFilePath(txt)) return
      el.setAttribute('data-mobile-nav-copy', '1')
      // 按钮与它所属的链接用同一个 id 绑定：React 重建行时旧链接被换掉，我们
      // 插入的按钮却还留在同一个父节点里（它不在 React 的虚拟 DOM 中，不会
      // 被回收）。没有反查关系就只能看到「同一条文件后面长出两个复制按钮」，
      // 长会话里持续堆积（审计 F3）。注入新按钮前先清掉父节点里已失配的旧按钮。
      const copyId = String(++copySeq)
      el.setAttribute('data-mobile-nav-copy-id', copyId)
      const parentEl = el.parentElement
      if (parentEl !== null) {
        for (const stale of Array.from(parentEl.querySelectorAll(':scope > [data-mobile-nav="copy-file"]'))) {
          if (stale.previousElementSibling?.getAttribute('data-mobile-nav-copy-id') !== stale.getAttribute('data-mobile-nav-copy-for')) {
            stale.remove()
          }
        }
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-mobile-nav', 'copy-file')
      btn.setAttribute('data-mobile-nav-copy-for', copyId)
      btn.textContent = t('fileCopy')
      btn.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 回归修复（低）：file:// 链接先剥掉 ^file:// 前缀再走 RPC——宿主 fileRead
        // 按工作区根校验路径，整串 file:///docs/x.md 传入必失败；剥后
        // file:///docs/x.md → /docs/x.md、file://C:/x → C:/x。（looksLikeFilePath
        // 的 H4a 例外特意放行 file:// 文案，所以这里一定会收到带前缀的路径。）
        const filePath = (el.textContent ?? '').trim().replace(/^file:\/\//i, '')
        btn.disabled = true
        btn.textContent = '…'
        try {
          const res = await readFile(filePath)
          if (disposed) return
          if (!res?.ok) {
            showToast(res?.error?.message ?? t('fileCopyFailed'))
            return
          }
          const content = res.value?.content ?? ''
          const size = res.value?.size ?? content.length
          // L5：>2MB 不写剪贴板——手机浏览器写超大文本常超时/崩页面，直接提示
          // 跳过（≤2MB 的正常路径全量复制不变）。
          if (size > MAX_COPY_BYTES) {
            showToast(fmt('fileTooLarge', { size: (size / (1024 * 1024)).toFixed(1) }))
            return
          }
          const copied = await copyText(content)
          if (disposed) return
          if (copied) {
            const kb = Math.max(1, Math.round(size / 1024))
            showToast(fmt('fileCopyDone', { kb }))
          } else {
            showToast(t('fileCopyFailedFallback'))
            showTextFallback(content) // 光提示「手动选择」没有下文：给出可选中文本
          }
        } catch (err) {
          if (!disposed) showToast(err instanceof Error ? err.message : t('fileCopyFailed'))
        } finally {
          // 按钮可能已被卸载（React 重渲染换掉了整行）：写回的是脱离文档的
          // 死节点，不报错但也没意义；判一下，语义更清楚。
          if (btn.isConnected) {
            btn.disabled = false
            btn.textContent = t('fileCopy')
          }
        }
      })
      el.parentElement?.insertBefore(btn, el.nextSibling)
    })
  }
  // 隐藏「添加工作区」入口：图标按钮由 mobile-apply.tsx 的 POCKET_EXTRA_CSS 按 aria-label 隐藏；
  // 下拉菜单里的文本项 CSS 选不到，这里按文案兜底。
  // 记录被改前的 inline display，卸载时原样恢复（无脑 removeProperty 会连
  // 宿主自己写的 inline 值一起抹掉）。
  const hiddenDisplayBackup = new Map<Element, string>()
  const wsSel = '[role="menuitem"],[role="option"],li,button,a'
  const hideWsOne = (el: Element): void => {
    // `||` 而非 `??`：aria-label 存在但为空串时也要回退到文本
    const txt = ((el.getAttribute('aria-label') || '') || el.textContent || '').trim()
    if (WS_LABELS.includes(txt)) {
      const h = el as HTMLElement
      if (!hiddenDisplayBackup.has(el)) hiddenDisplayBackup.set(el, h.style.display)
      h.style.display = 'none'
      el.setAttribute('data-mobile-nav-hide', 'add-workspace')
    }
  }
  const hideWsEntries = (root: ParentNode): void => {
    if (root instanceof Element && root.matches(wsSel)) hideWsOne(root)
    root.querySelectorAll(wsSel).forEach(hideWsOne)
  }

  // 流式输出每个 token 都会触发突变：只扫新增子树，并按帧合并，
  // 不能每条突变都全文档 querySelectorAll + 读 textContent。
  const pending = new Set<Element>()
  let raf = 0
  const flush = (): void => {
    raf = 0
    for (const el of pending) {
      if (!el.isConnected) continue
      injectCopyButtons(el)
      hideWsEntries(el)
    }
    pending.clear()
    // 被 React 卸载的入口还留在 backup 里（Map 强引用 DOM），卸载回调又只会
    // 扫仍连接的节点：这里顺手回收，否则长会话反复开合菜单会持续堆积。
    for (const el of hiddenDisplayBackup.keys()) {
      if (!el.isConnected) hiddenDisplayBackup.delete(el)
    }
  }
  injectCopyButtons()
  hideWsEntries(document)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        // 文本节点原地改写（React 更新文案时改的是 node.data，不产生 childList 记录）。
        // 纯文本容器里没有任何 button/a，流式 token 刷新时不必每帧重扫——长回答的主要开销。
        const parent = m.target.parentElement
        if (parent !== null && parent.childElementCount > 0) pending.add(parent)
        continue
      }
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) pending.add(n as Element)
        // 新增文本节点（React 替换文案）：重查它所在的元素
        else if (n.nodeType === 3 && n.parentElement !== null) pending.add(n.parentElement)
      })
    }
    if (pending.size > 0 && raf === 0) raf = requestAnimationFrame(flush)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  return () => {
    disposed = true
    document.removeEventListener('click', onClick, true)
    observer.disconnect()
    if (raf !== 0) cancelAnimationFrame(raf)
    pending.clear()
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastEl?.remove()
    toastEl = null
    fallbackEl?.remove()
    fallbackEl = null
    // 回收注入物：复制按钮、已处理标记、被隐藏的工作区入口（恢复原 inline
    // display）——否则同文档热重载后残留裸样式按钮、原 bug 在本会话复发。
    document.querySelectorAll('[data-mobile-nav="copy-file"]').forEach((b) => b.remove())
    document.querySelectorAll('[data-mobile-nav-copy="1"]').forEach((el) => el.removeAttribute('data-mobile-nav-copy'))
    document.querySelectorAll('[data-mobile-nav-hide="add-workspace"]').forEach((el) => {
      const h = el as HTMLElement
      const original = hiddenDisplayBackup.get(el)
      if (original !== undefined) h.style.display = original
      else h.style.removeProperty('display')
      hiddenDisplayBackup.delete(el)
      el.removeAttribute('data-mobile-nav-hide')
    })
    hiddenDisplayBackup.clear()
  }
}
