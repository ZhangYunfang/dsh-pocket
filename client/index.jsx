// dsh-pocket 网页客户端：
//   1. 设置页签「手机访问」（局域网/公网通道卡 + 二维码 + 更新/重启提示）
//   2. 移动端适配（移植自 MIT 项目 dsh-web-mobile，见 client/mobile/LICENSE.dsh-web-mobile）
//
// 手机扫码打开的就是电脑上的 dsh web，实时同步；窄屏自动变成抽屉布局。
//
// 设置页设计（v2 重设计）：
//   - 单列三区：连接（局域网/公网两个通道小节）→ 偏好 → 尾部（恢复出厂 + 署名行）；
//   - 二维码横排卡：左 128px 码 + 右地址/提示/复制，不再整宽堆叠；
//   - 访问密码默认遮罩（••••••••，不泄露长度），「显示」按需明文；
//   - 自配公网表单、统一样式的确认弹窗与 Alert 提示条。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了。专注扫码同屏这一件事。

import { createElement as h, useEffect, useRef, useState } from 'react';
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives';

import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, MOBILE_RIGHTBAR_ATTRIBUTE, MOBILE_RIGHTBAR_EVENT, MOBILE_PINCH_ZOOM_ATTRIBUTE, MOBILE_PINCH_ZOOM_EVENT, MOBILE_FONT_ATTRIBUTE, MOBILE_FONT_EVENT, MOBILE_FONT_SIZE_VAR, MOBILE_FONT_MIN, MOBILE_FONT_MAX, redactStatus, compareVersions, isSameRepo } from './api.js';
import { mobileApply } from './mobile/mobile-apply.tsx';
import { NS as POCKET_NS, zh as POCKET_ZH, en as POCKET_EN } from './pocket-locales.js';

const name = 'dsh-pocket';
// inject 必须是 upstream（client/mobile/upstream/index.tsx）inject 的超集：
// v3.1.0 起新增 'sessions'（session-focus-guard 读 ctx.sessions.list），
// 漏声明会让宿主给 ctx.sessions 传 undefined，激活即抛错 "did not activate"。
const inject = ['slots', 'connection', 'layout', 'locale', 'sessionLogDownload', 'sessions'];

// 词典在 pocket-locales.js；这里只做「取 key → 替换 {占位符} → 字符串」。
// 不依赖 DSH t() 的插值能力，避免行为不一致。
function fmt(t, key, vars) {
  let s = t(key);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = String(s).split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/** 给 fetch 加超时：隧道半开/弱网时浏览器可能永远不 resolve，界面会卡死在「进行中」。
 * 优先用 AbortSignal.timeout（Safari 16+/Chrome 103+），不可用时退回手动 controller。 */
async function fetchWithTimeout(url, opts, ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 可被 AbortSignal 提前唤醒的 sleep：组件卸载/取消后不必再多等一个轮询间隔。 */
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

// 官方 DeepSeek Harness 设计系统（dsh-client-ui-theme design-platform.css）：
// 按钮 md=36px 胶囊形 / sm=28px；品牌色 --dsw-alias-brand-primary；
// hover 走 --dsw-alias-button-*-hover；间距 4px 栅格；正文 13px。
// v2 在此基础上收敛：区块之间用留白，行之间用发丝线；提示全部走 12px 三级文字色。
const styles = {
  card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 14, padding: '18px 20px', maxWidth: 520 },
  muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
  // 主按钮：官方 md 胶囊形（36px）
  primary: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary,#4f6ef7))', color: 'var(--dsw-alias-label-primary-foreground, #fff)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 次级按钮：官方 outline/ghost 胶囊形
  btn: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-button-ghost-active-border, var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', height: 36, padding: '0 16px', borderRadius: 999, fontSize: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  // 行内小按钮（28px）：密码行的 显示/刷新/自定义、复制链接
  mini: { font: 'inherit', cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2,#d1d5db)', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-secondary,#6b7280)', height: 26, padding: '0 10px', borderRadius: 999, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  link: { font: 'inherit', cursor: 'pointer', border: 'none', background: 'none', padding: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#8b93a1)', textDecoration: 'none' },
  warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5 },
  mono: { fontFamily: 'ui-monospace,Menlo,monospace', letterSpacing: 0.5 },
};

// 状态圆点（通道开启/关闭）：8px，成功色，关闭走灰
const Dot = (on) => h('span', {
  style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: on ? 'var(--dsw-alias-state-success-primary,#10b981)' : 'var(--dsw-alias-border-l2,#d1d5db)' },
}, null);

function applyMobileRightbarSetting(enabled) {
  const on = enabled !== false;
  document.body?.setAttribute(MOBILE_RIGHTBAR_ATTRIBUTE, on ? 'on' : 'off');
  window.dispatchEvent(new CustomEvent(MOBILE_RIGHTBAR_EVENT, { detail: { enabled: on } }));
}

function applyMobilePinchZoomSetting(enabled) {
  const on = enabled === true;
  document.body?.setAttribute(MOBILE_PINCH_ZOOM_ATTRIBUTE, on ? 'on' : 'off');
  window.dispatchEvent(new CustomEvent(MOBILE_PINCH_ZOOM_EVENT, { detail: { enabled: on } }));
}

// 手机端独立字号：0 = 跟随桌面。落 body 属性 + CSS 变量，由 POCKET_EXTRA_CSS
// 只在手机布局下覆盖宿主的内容字号轴（桌面布局选择器不命中）。
const MOBILE_FONT_OPTIONS = [0, ...Array.from({ length: MOBILE_FONT_MAX - MOBILE_FONT_MIN + 1 }, (_, i) => MOBILE_FONT_MIN + i)];

function applyMobileFontSize(size) {
  const px = Number(size);
  const valid = Number.isInteger(px) && px >= MOBILE_FONT_MIN && px <= MOBILE_FONT_MAX;
  if (valid) {
    document.body?.style.setProperty(MOBILE_FONT_SIZE_VAR, `${px}px`);
    document.body?.setAttribute(MOBILE_FONT_ATTRIBUTE, String(px));
  } else {
    document.body?.style.removeProperty(MOBILE_FONT_SIZE_VAR);
    document.body?.removeAttribute(MOBILE_FONT_ATTRIBUTE);
  }
  window.dispatchEvent(new CustomEvent(MOBILE_FONT_EVENT, { detail: { size: valid ? px : 0 } }));
}

// 剪贴板：优先 Clipboard API（需安全上下文），LAN http 场景回退 execCommand
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 回退 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok === true;
  } catch {
    return false;
  }
}

// ── 宿主图标适配（两代命名）───────────────────────────────────────────────
// 宿主 primitives 的图标有两代命名：0.1.0-rc.6 是 IconXxxOutline16，
// 0.1.7-alpha.1 起是 IconXxxOutlineRegular。运行时哪个存在用哪个，都没有则
// 返回空组件——宁可少画一个图标，也不让整页渲染抛错（同 mobile/upstream/core/icon-compat.ts）。
const pickIcon = (names) => {
  const table = (uiPrimitives ?? {});
  for (const n of names) {
    if (typeof table[n] === 'function') return table[n];
  }
  return () => null;
};

const Ico = {
  settings: pickIcon(['IconSettingsOutlineRegular', 'IconSettingsOutline16']),
  lan: pickIcon(['IconLinkOutlineRegular', 'IconLinkOutline16']),
  wan: pickIcon(['IconGlobeOutlineRegular', 'IconGlobeOutline16']),
  pin: pickIcon(['IconShieldOutlineRegular', 'IconShieldOutline16']),
  sliders: pickIcon(['IconSlidersTwoOutlineRegular', 'IconSlidersTwoOutline16']),
  trash: pickIcon(['IconTrashOutlineRegular', 'IconTrashOutline16']),
  copy: pickIcon(['IconCopyOutlineRegular', 'IconCopyOutline16']),
  refresh: pickIcon(['IconRefreshOutlineRegular', 'IconRefreshOutline16']),
  download: pickIcon(['IconDownloadOutlineRegular', 'IconDownloadOutline16']),
  warn: pickIcon(['IconWarningOutlineRegular', 'IconWarningOutline16']),
  info: pickIcon(['IconInfoOutlineRegular', 'IconInfoOutline16']),
  check: pickIcon(['IconCheckCircleOutlineRegular', 'IconCheckCircleOutline16']),
  chevron: pickIcon(['IconChevronDownOutlineRegular', 'IconChevronDownOutline16']),
};

// 设置页样式（v3）：类名统一 dshp- 前缀，一次性注入 <style>。
// 之所以不用全内联样式：hover / focus-visible / 媒体查询 / 伪元素都需要样式表，
// 内联只能靠 JS 事件模拟，既啰嗦又拿不到键盘可达性。颜色全部走宿主 token，
// 深色主题自动跟随，不在代码里写死深浅两套。
const POCKET_SETTINGS_CSS = `
.dshp-page{max-width:760px;margin:0 auto;--dshp-text:var(--dsw-alias-label-primary,#0f1115);--dshp-text-2:var(--dsw-alias-label-secondary,#61666b);--dshp-text-3:var(--dsw-alias-label-tertiary,#81858c);--dshp-line:rgba(15,17,21,.09);--dshp-line-2:rgba(15,17,21,.16);--dshp-fill:rgba(15,17,21,.04);--dshp-fill-2:rgba(15,17,21,.07);--dshp-brand:var(--dsw-alias-brand-primary,#0f1115);--dshp-on-brand:var(--dsw-alias-label-primary-foreground,#fff);--dshp-danger:var(--dsw-alias-state-error-primary,#e5484d);--dshp-warn:var(--dsw-alias-state-warn-primary,#b45309);--dshp-success:var(--dsw-alias-state-success-primary,#10b981);--dshp-shadow:0 1px 2px rgba(15,17,21,.04),0 8px 24px -16px rgba(15,17,21,.18);--dshp-line:color-mix(in srgb,var(--dshp-text) 10%,transparent);--dshp-line-2:color-mix(in srgb,var(--dshp-text) 17%,transparent);--dshp-fill:color-mix(in srgb,var(--dshp-text) 4.5%,transparent);--dshp-fill-2:color-mix(in srgb,var(--dshp-text) 8%,transparent);display:flex;flex-direction:column;gap:16px;max-width:620px;color:var(--dshp-text);font-size:13px;line-height:1.55}
body[data-ds-dark-theme] .dshp-page{--dshp-line:rgba(255,255,255,.11);--dshp-line-2:rgba(255,255,255,.2);--dshp-fill:rgba(255,255,255,.055);--dshp-fill-2:rgba(255,255,255,.09);--dshp-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px -16px rgba(0,0,0,.6);--dshp-line:color-mix(in srgb,var(--dshp-text) 13%,transparent);--dshp-line-2:color-mix(in srgb,var(--dshp-text) 22%,transparent);--dshp-fill:color-mix(in srgb,var(--dshp-text) 6%,transparent);--dshp-fill-2:color-mix(in srgb,var(--dshp-text) 10%,transparent)}
.dshp-head{display:flex;align-items:center;gap:12px}
.dshp-badge{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--dshp-fill);color:var(--dshp-brand);border:1px solid var(--dshp-line)}
.dshp-head-main{flex:1;min-width:0}
.dshp-title{font-size:17px;font-weight:650;letter-spacing:-.2px;line-height:1.3}
.dshp-sub{margin-top:3px;font-size:12px;color:var(--dshp-text-3)}
.dshp-chips{display:flex;flex-wrap:wrap;gap:6px}
.dshp-chip{display:inline-flex;align-items:center;gap:6px;height:23px;padding:0 9px;border-radius:999px;border:1px solid transparent;background:var(--dshp-fill);font-size:11.5px;font-weight:500;color:var(--dshp-text-3);white-space:nowrap}
.dshp-chip-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.dshp-chip.is-on{background:color-mix(in srgb,var(--dshp-success) 13%,transparent);border-color:color-mix(in srgb,var(--dshp-success) 24%,transparent);color:color-mix(in srgb,var(--dshp-success) 72%,var(--dshp-text))}
.dshp-chip.is-on .dshp-chip-dot{opacity:1}
.dshp-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dshp-line);border-radius:14px;box-shadow:var(--dshp-shadow);overflow:hidden}
.dshp-card.is-danger{background:color-mix(in srgb,var(--dshp-danger) 4%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dshp-danger) 20%,transparent)}
.dshp-card-head{display:flex;align-items:flex-start;gap:11px;padding:14px 16px}
.dshp-card-icon{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--dshp-fill);color:var(--dshp-text-2)}
.dshp-card-text{flex:1;min-width:0}
.dshp-card-title{font-size:13.5px;font-weight:600;letter-spacing:-.1px}
.dshp-card-sub{margin-top:2px;font-size:11.5px;line-height:1.5;color:var(--dshp-text-3)}
.dshp-card-body{padding:0 16px 14px;display:flex;flex-direction:column;gap:12px}
.dshp-card-body>.dshp-row:first-child{border-top:1px solid var(--dshp-line);padding-top:12px}
.dshp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px;border-top:1px solid var(--dshp-line)}
.dshp-row.is-stack{flex-direction:column;align-items:stretch;gap:8px}
.dshp-row-label{font-size:13px;font-weight:500}
.dshp-row-desc{margin-top:3px;font-size:11.5px;line-height:1.5;color:var(--dshp-text-3)}
.dshp-btn{font:inherit;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid transparent;font-size:12.5px;font-weight:550;white-space:nowrap;transition:background .12s ease,border-color .12s ease,color .12s ease,opacity .12s ease}
.dshp-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--dshp-brand) 40%,transparent);outline-offset:2px}
.dshp-btn:disabled{opacity:.45;cursor:default}
.dshp-btn.is-primary{background:var(--dshp-brand);color:var(--dshp-on-brand);border-color:transparent}
.dshp-btn.is-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dshp-brand) 86%,var(--dshp-text-3))}
.dshp-btn.is-ghost{background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dshp-line-2);color:var(--dshp-text)}
.dshp-btn.is-ghost:hover:not(:disabled){background:var(--dshp-fill)}
.dshp-btn.is-quiet{background:transparent;color:var(--dshp-text-2)}
.dshp-btn.is-quiet:hover:not(:disabled){background:var(--dshp-fill);color:var(--dshp-text)}
.dshp-btn.is-danger{background:transparent;border-color:color-mix(in srgb,var(--dshp-danger) 32%,transparent);color:var(--dshp-danger)}
.dshp-btn.is-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dshp-danger) 9%,transparent)}
.dshp-btn.is-mini{height:26px;padding:0 9px;font-size:11.5px;font-weight:500;border-radius:7px}
.dshp-link{font:inherit;cursor:pointer;border:0;background:none;padding:0;color:var(--dshp-text-2);font-size:12px;text-decoration:underline;text-decoration-color:var(--dshp-line-2);text-underline-offset:2px}
.dshp-link:hover{color:var(--dshp-text)}
.dshp-switch{flex:none;position:relative;width:36px;height:20px;padding:2px;border:0;border-radius:999px;cursor:pointer;background:var(--dshp-fill-2);transition:background .14s ease}
.dshp-switch[aria-checked="true"]{background:var(--dshp-brand)}
.dshp-switch:disabled{opacity:.45;cursor:default}
.dshp-switch:focus-visible{outline:2px solid color-mix(in srgb,var(--dshp-brand) 40%,transparent);outline-offset:2px}
.dshp-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dshp-on-brand);box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .14s ease}
.dshp-switch[aria-checked="true"] .dshp-switch-thumb{transform:translateX(16px)}
.dshp-qr{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--dshp-fill);border:1px solid var(--dshp-line);border-radius:12px;padding:12px}
.dshp-qr-frame{flex:none;padding:6px;background:#fff;border-radius:10px;border:1px solid rgba(15,17,21,.08);box-shadow:0 1px 2px rgba(15,17,21,.06)}
.dshp-qr-frame img{display:block;width:116px;height:116px;border-radius:2px}
.dshp-qr-main{flex:1 1 190px;min-width:180px}
.dshp-url{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6;word-break:break-all;color:var(--dshp-text);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dshp-line);border-radius:8px;padding:7px 9px}
.dshp-qr-hint{margin-top:6px;font-size:11.5px;line-height:1.5;color:var(--dshp-text-3)}
.dshp-qr-actions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
.dshp-alert{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--dshp-fill);border:1px solid var(--dshp-line);font-size:12.5px;line-height:1.6;color:var(--dshp-text-2)}
.dshp-alert-icon{flex:none;margin-top:1px;color:var(--dshp-text-3)}
.dshp-alert.is-info{background:var(--dshp-fill)}
.dshp-alert.is-warn{background:color-mix(in srgb,var(--dshp-warn) 9%,transparent);border-color:color-mix(in srgb,var(--dshp-warn) 22%,transparent);color:var(--dshp-text-2)}
.dshp-alert.is-warn .dshp-alert-icon{color:var(--dshp-warn)}
.dshp-alert.is-error{background:color-mix(in srgb,var(--dshp-danger) 8%,transparent);border-color:color-mix(in srgb,var(--dshp-danger) 20%,transparent);color:var(--dshp-text-2)}
.dshp-alert.is-error .dshp-alert-icon{color:var(--dshp-danger)}
.dshp-alert.is-success{background:color-mix(in srgb,var(--dshp-success) 9%,transparent);border-color:color-mix(in srgb,var(--dshp-success) 22%,transparent)}
.dshp-alert.is-success .dshp-alert-icon{color:var(--dshp-success)}
.dshp-alert-body{flex:1;min-width:0}
.dshp-alert-title{font-weight:600;color:var(--dshp-text);margin-bottom:2px}
.dshp-select{padding-right:28px;min-width:104px;cursor:pointer}
.dshp-panel-title{font-family:var(--dshp-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;font-weight:600;line-height:1.45;word-break:break-all}
.dshp-input,.dshp-select{font:inherit;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dshp-line-2);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dshp-text);font-size:12.5px;outline:none;min-width:0;box-sizing:border-box}
.dshp-input:focus,.dshp-select:focus{border-color:color-mix(in srgb,var(--dshp-brand) 45%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dshp-brand) 12%,transparent)}
.dshp-input.is-mono{font-family:ui-monospace,Menlo,monospace;letter-spacing:.5px}
.dshp-pinbox{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--dshp-fill);border:1px solid var(--dshp-line);border-radius:10px;padding:8px 10px}
.dshp-pin-value{font-family:ui-monospace,Menlo,monospace;font-size:13.5px;letter-spacing:2px;color:var(--dshp-text);flex:1;min-width:96px;word-break:break-all}
.dshp-pinbox .dshp-btn{flex:none}
.dshp-pin{font-family:ui-monospace,Menlo,monospace;font-size:13px;letter-spacing:.5px}
.dshp-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshp-custom{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dshp-text-2)}
.dshp-hint{margin-top:6px;font-size:11.5px;line-height:1.5;color:var(--dshp-text-3)}
.dshp-warn-text{margin-top:6px;font-size:11.5px;line-height:1.5;color:var(--dshp-warn)}
.dshp-err-text{margin-top:6px;font-size:11.5px;line-height:1.5;color:var(--dshp-danger)}
.dshp-panel{display:flex;flex-direction:column;gap:6px;background:var(--dshp-fill);border:1px solid var(--dshp-line);border-radius:10px;padding:10px 12px}
.dshp-adv{display:flex;flex-direction:column;gap:10px;width:100%}
.dshp-form{display:flex;flex-direction:column;gap:10px}
.dshp-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dshp-text-2)}
.dshp-check{display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12.5px;line-height:1.55;cursor:pointer}
.dshp-check input{flex:none;width:15px;height:15px;margin:2px 0 0;accent-color:var(--dshp-brand)}
.dshp-loading{display:flex;align-items:center;gap:8px;padding:16px 2px;font-size:12.5px;color:var(--dshp-text-3)}
.dshp-loading::before{content:"";flex:none;width:12px;height:12px;border-radius:50%;border:2px solid var(--dshp-line-2);border-top-color:var(--dshp-text-2);animation:dshp-spin .8s linear infinite}
@keyframes dshp-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dshp-loading::before{animation:none}.dshp-btn,.dshp-switch,.dshp-switch-thumb{transition:none}}
.dshp-footer{display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap;padding-top:14px;border-top:1px solid var(--dshp-line);font-size:11.5px;color:var(--dshp-text-3)}
.dshp-footer a{color:var(--dshp-text-2);text-decoration:none}
.dshp-footer a:hover{color:var(--dshp-text);text-decoration:underline;text-underline-offset:2px}
.dshp-modal-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,17,21,.42);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.dshp-modal{width:100%;max-width:420px;padding:20px;border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dshp-line);box-shadow:0 24px 64px -16px rgba(15,17,21,.4)}
.dshp-modal-title{font-size:15.5px;font-weight:600;letter-spacing:-.1px;margin-bottom:10px}
.dshp-modal-title.is-warn{color:var(--dshp-warn)}
.dshp-modal-title.is-danger{color:var(--dshp-danger)}
.dshp-modal-title.is-brand{color:var(--dshp-text)}
.dshp-modal-body{font-size:13px;line-height:1.7;white-space:pre-line;color:var(--dshp-text-2)}
.dshp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.dshp-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:10001;max-width:320px;padding:11px 18px;border-radius:10px;background:var(--dsw-alias-label-primary,#111);color:var(--dsw-alias-bg-layer-1,#fff);font-size:13px;line-height:1.5;text-align:center;box-shadow:0 12px 32px rgba(0,0,0,.3)}
@media (max-width:560px){
  .dshp-page{gap:14px}
  .dshp-badge{width:36px;height:36px;border-radius:10px}
  .dshp-title{font-size:16px}
  .dshp-card-head{padding:13px 13px}
  .dshp-card-body{padding:0 13px 13px}
  .dshp-qr{padding:11px;gap:12px}
  .dshp-qr-frame img{width:108px;height:108px}
  .dshp-qr-main{min-width:100%}
  .dshp-btn{padding:0 11px}
  .dshp-row{gap:10px}
}
`;

function PocketSettingsTab({ rpcCall, t }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [tunnelState, setTunnelState] = useState(null); // 隧道进度 {phase, detail, startedAt}
  const [restartNotice, setRestartNotice] = useState(false); // 重启后提示
  const [updateInfo, setUpdateInfo] = useState(null); // { current, latest, updating, result, startedAt } | null
  const [isDesktop, setIsDesktop] = useState(false); // DSH Desktop（Electron）环境：更新/重启由桌面版管理
  const [now, setNow] = useState(Date.now()); // 每秒 tick，驱动倒计时
  const [pinShown, setPinShown] = useState({}); // 密码明文开关 { lan?: true, public?: true }——默认遮罩
  const [autoReloadFailed, setAutoReloadFailed] = useState(false); // 重启后自动刷新失败
  const [pending, setPending] = useState({}); // 单项操作进行中标记（防连点/乱序）：refreshPin/lanAuth/lanToggle/wan/prefs/savePin/saveNamed/lanAddr/reset
  const [offline, setOffline] = useState(false); // 连续拉不到 status：宿主可能正在重启
  const failuresRef = useRef(0); // 连续失败次数（不进 state，避免每次失败都重渲染）
  const mutatedAtRef = useRef(0); // 最近一次本地修改时间：用于丢弃比本地状态更旧的 status 快照
  const loadSeqRef = useRef(0); // load 调用序号：只有最后发起的那次能提交快照（防乱序覆盖）

  // status 首帧还没回来时，setStatus((s) => ({ ...s, ... })) 会把 null 展开成 {}
  // —— 界面字段短暂变 undefined。统一走这里：没数据就丢弃这次局部更新，
  // 下一次 status 轮询会带回真实值。
  const patchStatus = (patch) => setStatus((s) => (s ? { ...s, ...patch } : s));

  // 单项操作的进行中标记：防止连点造成请求乱序（例如开关连点，先发的「开」后到，
  // 会把「关」的结果盖掉）。mutatedAtRef 同时记录本地修改时刻，供 status 轮询判断快照新旧。
  // pending 的值保持布尔（渲染层大量 `pending.x === true` 判断），计数单独放在 ref 里：
  // 三个手机端偏好开关共用 'prefs' 这个 key，若直接置 true/delete，先返回的请求会把还在
  // 飞的另一个请求的锁提前解开（连点可重复提交）。
  const pendingCountsRef = useRef({});
  const withPending = async (key, fn) => {
    mutatedAtRef.current = Date.now();
    const counts = pendingCountsRef.current;
    counts[key] = (counts[key] ?? 0) + 1;
    setPending((p) => (p[key] === true ? p : { ...p, [key]: true }));
    try {
      return await fn();
    } finally {
      counts[key] = Math.max(0, (counts[key] ?? 1) - 1);
      if (counts[key] === 0) {
        delete counts[key];
        setPending((p) => {
          if (p[key] !== true) return p;
          const next = { ...p };
          delete next[key];
          return next;
        });
      }
    }
  };

  // 设置页样式表：按 id 幂等注入；已存在时更新内容，避免插件热重载后残留旧 CSS。
  useEffect(() => {
    const id = 'dshp-settings-css';
    let el = document.getElementById(id);
    if (el && el.tagName !== 'STYLE') el = null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    if (el.textContent !== POCKET_SETTINGS_CSS) el.textContent = POCKET_SETTINGS_CSS;
    return undefined;
  }, []);

  // 进行中操作的「已等待 X 秒」倒计时——只在有活跃倒计时（更新/重启进行中、隧道
  // 连接中）时才挂每秒 tick，操作结束即卸载；空闲设置页不再无条件每秒重渲染
  useEffect(() => {
    const countdownActive =
      !!((updateInfo?.updating || updateInfo?.restarting) && updateInfo?.startedAt) ||
      !!(tunnelState?.startedAt && ['downloading', 'starting', 'registering'].includes(tunnelState?.phase ?? ''));
    if (!countdownActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [updateInfo, tunnelState]);
  const elapsed = (startedAt) => (startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0);

  const call = async (endpoint, payload) => {
    // 30s 上限：隧道半开时 rpc.call 可能永远不回来，导致按钮永久 disabled、只在重启时
    // 靠整页刷新才能恢复。超时按失败处理，让用户看到错误并重试。
    const res = await rpcCall(
      endpoint,
      payload,
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(30000)
        : undefined,
    );
    if (!res?.ok) throw new Error(res?.error?.message ?? 'RPC failed');
    return res.value;
  };

  // 重启后自动刷新：旧进程退出到新进程开始监听之间有数秒空窗（helper 还要等端口
  // 释放、dsh web 还要启动），固定 2 秒 reload 会撞上 ERR_CONNECTION_REFUSED 白屏。
  // 改成轮询本页地址直到真的能连上再刷新；30 秒还没起来就交给用户点「刷新页面」。
  const reloadAbortRef = useRef(null);
  useEffect(() => () => { reloadAbortRef.current?.abort(); }, []);
  const waitForHostThenReload = async () => {
    // 每次重试最多等 3 秒：旧实现单次 fetch 永不 resolve 时会卡在 await，
    // deadline 再也不会被检查，「刷新页面」按钮永远不出现。
    reloadAbortRef.current?.abort();
    const ctrl = new AbortController();
    reloadAbortRef.current = ctrl;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !ctrl.signal.aborted) {
      try {
        const res = await fetchWithTimeout(location.href, { method: 'GET', cache: 'no-store' }, 3000);
        if (res.ok) { if (!ctrl.signal.aborted) location.reload(); return; }
      } catch { /* 新进程还没起来 / 单次请求超时 */ }
      await sleepUnlessAborted(1000, ctrl.signal);
    }
    if (!ctrl.signal.aborted) setAutoReloadFailed(true);
  };

  const load = async () => {
    const startedAt = Date.now();
    // 并发快照的先后顺序：轮询（10s）与 visibilitychange 都会触发 load，经隧道
    // 时一次 /status 可能拖到十几秒，于是「先发的慢请求」晚于「后发的快请求」
    // 落地，用更旧的快照盖掉新状态（隧道进度条倒退、开关回弹）。只有最后发起
    // 的那次 load 允许提交结果；被判过期的这次直接丢弃。
    const seq = ++loadSeqRef.current;
    try {
      const s = await call(POCKET_ENDPOINTS.status, {});
      if (seq !== loadSeqRef.current) return;
      // 拉取期间用户刚改过设置：这份快照可能比本地状态旧，丢掉，否则会把刚切的开关弹回去
      if (mutatedAtRef.current > startedAt) { setOffline(false); failuresRef.current = 0; return; }
      failuresRef.current = 0;
      setOffline(false);
      setStatus(s);
      applyMobileRightbarSetting(s.mobileRightbarEnabled);
      applyMobilePinchZoomSetting(s.mobilePinchZoomEnabled);
      applyMobileFontSize(s.mobileFontSize);
      setTunnelState(s.tunnelState ?? null);
      if (s.desktop) setIsDesktop(true);
      if (s.restartNotice) {
        // 新进程确认起来了：显示一次「已重启」，清掉旧的更新横幅（单状态，不并存），
        // 然后自动刷新页面加载新代码——不用用户手动刷新
        setRestartNotice(true);
        setUpdateInfo(null);
        if (!sessionStorage.getItem('dshp-auto-reloaded')) {
          sessionStorage.setItem('dshp-auto-reloaded', '1');
          waitForHostThenReload();
        }
      }
    } catch {
      // 过期的失败不该计入连续失败：另一条更新的 load 已经成功的话，这里加一
      // 会让「offline」横幅在宿主明明正常时亮起来。
      if (seq !== loadSeqRef.current) return;
      // 宿主重启/网络抖动时静默重试；连续失败 2 次才提示，避免一次抖动就报错
      failuresRef.current += 1;
      if (failuresRef.current >= 2) setOffline(true);
    }
  };

  useEffect(() => {
    load();
    // 页面不可见时跳过 status 轮询，回到前台立刻补一次（不等下一拍）。
    // 10s 而非 3s：每次 status 都带两张二维码 data URL，常开设置页没必要这么频繁。
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      // 卸载后迟到的响应一律作废（否则会 setState 到已卸载组件上）
      loadSeqRef.current += 1;
    };
  }, []);

  // 每次页面加载清掉自动刷新标记——这样下次重启（更新后）才能再次触发自动刷新
  useEffect(() => {
    try { sessionStorage.removeItem('dshp-auto-reloaded'); } catch { /* 忽略 */ }
  }, []);

  // 版本检测：host 当前版本 vs npm registry latest（registry 带 CORS *）
  // 两种情况显示横幅：① 有新版可更新；② 磁盘已更新但进程还是旧代码（重启生效）
  // cache: 'no-store' —— registry 响应带缓存头，浏览器会缓存旧版本号导致「小版本不提示」
  // 周期重查（每 5 分钟）：npm registry 的 /latest 走 CDN 边缘缓存，刚发布后打开页面
  // 可能拿到旧版本号——周期性重查让更新提示在缓存刷新后自动出现，不用重开页面。
  // 桌面端（isDesktop）：更新/重启由 DSH Desktop 管理，这里不做版本检测、不显示更新横幅
  useEffect(() => {
    if (isDesktop) return;
    let alive = true;
    const check = async () => {
      // 手机端切后台时定时器本就会被节流；显式跳过，避免标签页恢复瞬间打一次外网请求。
      if (document.hidden) return;
      try {
        const v = await call(POCKET_ENDPOINTS.version, {});
        const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { cache: 'no-store' })).json();
        if (!alive) return;
        const latest = typeof meta?.version === 'string' ? meta.version : null;
        const upstreamRepo = typeof meta?.repository === 'string' ? meta.repository : meta?.repository?.url ?? null;
        // fork/分支安装（repository 与 npm 上游不同源）不比 npm 版本：版本号滞后是常态，
        // 横幅会永远挂着；且一键更新会把上游代码盖在本地修改上。只保留「已更新未重启」本地分支。
        const npmManaged = isSameRepo(v.repository ?? null, upstreamRepo);
        if (npmManaged && latest && v.current && compareVersions(latest, v.current) > 0) {
          setUpdateInfo({ current: v.current, latest, updating: false, result: null });
        } else if (v.current && v.loaded && compareVersions(v.current, v.loaded) > 0) {
          // 已更新未重启：显示「已更新，重启生效」+ 重启按钮
          setUpdateInfo({ current: v.current, latest: v.current, updating: false, result: 'ok', updated: true });
        }
      } catch { /* 网络失败静默 */ }
    };
    const onVisible = () => { if (!document.hidden) void check(); };
    document.addEventListener('visibilitychange', onVisible);
    check();
    const t = setInterval(check, 15 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isDesktop]);

  // 重启宿主（更新生效必需：刷新页面不会重载服务端代码）
  const restartPocket = async () => {
    setUpdateInfo((u) => ({ ...(u ?? {}), restarting: true, startedAt: Date.now() }));
    try {
      // 宿主 500ms 后自杀，RPC 响应可能来不及送达 → 3 秒超时兜底，别让按钮永远卡「重启中…」
      await Promise.race([
        call(POCKET_ENDPOINTS.restart, {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error('restart requested (no reply within 3s)')), 3000)),
      ]);
      setUpdateInfo((u) => ({ ...(u ?? {}), restarting: true, result: 'ok' }));
    } catch (err) {
      // 网络断连/超时同样视为「已请求重启」——旧进程即将退出，等新进程起来后刷新即可
      const msg = String(err?.message ?? '');
      if (/connection|socket|fetch|network|abort|cancelled|ECONN|disconnect|closed|timeout/i.test(msg)) {
        setUpdateInfo((u) => ({ ...(u ?? {}), restarting: true, result: 'ok' }));
        return;
      }
      setUpdateInfo((u) => ({ ...(u ?? {}), restarting: false, result: 'fail', output: err.message }));
    }
  };

  // 一键更新：调宿主 dsh plugin update（成功后宿主自动重启生效，用户只点一次）
  const runUpdate = async () => {
    setUpdateInfo((u) => ({ ...(u ?? {}), updating: true, result: null, startedAt: Date.now() }));
    try {
      const r = await call(POCKET_ENDPOINTS.update, {});
      setUpdateInfo((u) => ({
        ...(u ?? {}),
        updating: false,
        result: r.ok ? 'ok' : 'fail',
        autoRestart: r.autoRestart === true,
        output: r.output ?? r.error,
      }));
    } catch (err) {
      setUpdateInfo((u) => ({ ...(u ?? {}), updating: false, result: 'fail', output: err.message }));
    }
  };

  // 安全免责声明（issue #31）：每次开启公网都必须先弹框勾选「我已知情」。
  // 服务端同样强制（tunnel.start 需 disclaimer: true），防绕过前端直接调 RPC。

  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);

  const doStartTunnel = async () => {
    // 命名隧道模式：Token/域名没配齐就不发起（服务端同样会拒绝）
    const cfg = status?.tunnelConfig;
    if (!cfg?.hostname || !cfg?.tokenSet) {
      setTunnelCfg({ hostname: cfg?.hostname ?? '', token: '', err: t('namedNeedCfg') });
      return;
    }
    setError(null);
    setTunnelState({ phase: 'starting', detail: '正在开启…', startedAt: Date.now() });
    await withPending('wan', async () => {
      try {
        const s = await call(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
        setStatus(s);
        // 启动接口返回的就是最新状态：直接同步隧道进度，否则要等下一拍轮询才从「连接中」跳出来
        setTunnelState(s.tunnelState ?? null);
      } catch (err) {
        setError(err.message);
        setTunnelState(null);
      }
    });
  };
  const startTunnel = () => {
    const cfg = status?.tunnelConfig;
    if (!cfg?.hostname || !cfg?.tokenSet) {
      setTunnelCfg({ hostname: cfg?.hostname ?? '', token: '', err: null });
      return;
    }
    setDisclaimerChecked(false);
    setDisclaimerOpen(true);
  };
  const confirmDisclaimer = () => {
    if (!disclaimerChecked) return; // 未勾选不允许
    setDisclaimerOpen(false);
    doStartTunnel();
  };

  const stopTunnel = () => withPending('wan', async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.tunnelStop, {});
      setStatus(s);
      setTunnelState(s.tunnelState ?? null);
    } catch (err) {
      setError(err.message);
    }
  });

  // Token 输入留空时保留已有凭据；配置保存不自动开启公网。
  const [tunnelCfg, setTunnelCfg] = useState(null);
  const saveNamedTunnel = () => withPending('saveNamed', async () => {
    try {
      const s = await call(POCKET_ENDPOINTS.tunnelSetConfig, {
        mode: 'named',
        hostname: tunnelCfg?.hostname ?? '',
        token: tunnelCfg?.token || undefined, // 留空不覆盖已存 Token
      });
      setStatus(s);
      setTunnelCfg(null);
    } catch (err) {
      setTunnelCfg((c) => ({ ...(c ?? {}), err: err.message }));
    }
  });

  // 恢复出厂设置：清本机设置 + 重设随机密码（弹窗确认；RPC 端也强制校验 confirm）
  const [resetOpen, setResetOpen] = useState(false);
  const doFactoryReset = async () => {
    setResetOpen(false);
    setError(null);
    await withPending('reset', async () => {
      try {
        const next = await call(POCKET_ENDPOINTS.pocketReset, { confirm: true });
        setStatus(next);
        applyMobileRightbarSetting(next.mobileRightbarEnabled);
        applyMobilePinchZoomSetting(next.mobilePinchZoomEnabled);
        applyMobileFontSize(next.mobileFontSize);
        setTunnelCfg(null);
        setCustomPin(null);
        setAdvOpen(false);
        setPinShown({});
        // 重置可能不完整（设置文件删不掉 / 新 PIN 只落内存）：说清楚，
        // 否则用户以为回到了出厂，实际开关和密码还是旧的。
        if (Array.isArray(next?.resetWarnings) && next.resetWarnings.length > 0) {
          setError(next.resetWarnings.join('；'));
          showToast(t('resetPartial'));
        } else {
          showToast(t('resetDone'));
        }
      } catch (err) {
        setError(err.message);
        showToast(t('resetFailed'));
      }
    });
  };

  // 刷新局域网访问密码（旧密码立即作废）
  const refreshLanPin = () => withPending('refreshPin', async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanTokenRefresh, {});
      setStatus((s) => (s ? { ...s, lanToken: r.lanToken } : s));
      // 新密码默认不保持明文展示
      setPinShown((m) => ({ ...m, lan: false }));
    } catch (err) {
      setError(err.message);
    }
  });

  // 局域网访问密码开关（issue #24）：默认开启；关闭后局域网扫码直连（公网不受影响）
  const setLanAuth = (on) => withPending('lanAuth', async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.lanAuthSetEnabled, { on });
      setStatus((s) => (s ? { ...s, lanAuthEnabled: r.lanAuthEnabled } : s));
    } catch (err) {
      setError(err.message);
    }
  });

  const setMobileRightbar = (on) => withPending('prefs', async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.mobileRightbarSetEnabled, { on });
      const enabled = r.mobileRightbarEnabled === true;
      patchStatus({ mobileRightbarEnabled: enabled });
      applyMobileRightbarSetting(enabled);
    } catch (err) {
      setError(err.message);
    }
  });

  const setMobilePinchZoom = (on) => withPending('prefs', async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.mobilePinchZoomSetEnabled, { on });
      const enabled = r.mobilePinchZoomEnabled === true;
      patchStatus({ mobilePinchZoomEnabled: enabled });
      applyMobilePinchZoomSetting(enabled);
    } catch (err) {
      setError(err.message);
    }
  });

  const setMobileFontSize = (size) => withPending('prefs', async () => {
    try {
      const r = await call(POCKET_ENDPOINTS.mobileFontSetSize, { size });
      const px = Number(r.mobileFontSize) || 0;
      patchStatus({ mobileFontSize: px });
      applyMobileFontSize(px);
    } catch (err) {
      setError(err.message);
    }
  });

  // 局域网访问总开关：关闭后局域网扫码/链接直接失效（公网不受影响）。
  // 切换前弹窗确认（弹窗提醒）；服务端用 setLanEnabled 持久化，代理按 Host 实时拦截。
  const [lanToggleOpen, setLanToggleOpen] = useState(null); // null | true | false（目标 on 状态）
  const requestLanToggle = (on) => setLanToggleOpen(on);
  const confirmLanToggle = () => {
    const on = lanToggleOpen;
    setLanToggleOpen(null);
    if (on === null) return;
    return withPending('lanToggle', async () => {
      try {
        const r = await call(POCKET_ENDPOINTS.lanSetEnabled, { on });
        setStatus((s) => (s ? { ...s, lanEnabled: r.lanEnabled } : s));
      } catch (err) {
        setError(err.message);
      }
    });
  };

  // 局域网地址手动覆盖（Tailscale/VPN 等远程访问场景）：空值恢复自动选择
  const setLanAddress = (ip) => withPending('lanAddr', async () => {
    try {
      setStatus(await call(POCKET_ENDPOINTS.lanSetOverride, { ip }));
    } catch (err) {
      setError(err.message);
    }
  });

  // 自定义访问密码：公网/局域网各自设固定 8–64 位密码（英文字母大小写或数字）。
  // customPin: { which: 'public'|'lan', value, err } | null —— 正在输入自定义密码的区块
  const [customPin, setCustomPin] = useState(null);
  const saveCustomPin = (which) => withPending('savePin', async () => {
    // 先做本地长度校验，不合法就不发请求（服务端还会再校验一次）
    if (String(customPin?.value ?? '').length < 8) {
      setCustomPin((c) => ({ ...(c ?? {}), err: t('pinInvalid') }));
      return;
    }
    try {
      const r = await call(POCKET_ENDPOINTS.pinSetCustom, { which, value: customPin?.value ?? '' });
      setStatus((s) => (s ? {
        ...s,
        accessToken: which === 'public' ? r.pin : s.accessToken,
        lanToken: which === 'lan' ? r.pin : s.lanToken,
        publicPinCustom: which === 'public' ? true : s.publicPinCustom,
        lanPinCustom: which === 'lan' ? true : s.lanPinCustom,
      } : s));
      setCustomPin(null);
      // 写入磁盘失败时后端仍返回内存 PIN（本次运行有效），但重启后会失效。
      // 不提示的话用户以为改好了，重启后再也登不上。
      if (r && r.persisted === false) {
        showToast(t('pinSaveMemoryOnly'));
      }
    } catch (err) {
      setCustomPin((c) => ({ ...(c ?? {}), err: err.message }));
    }
  });

  const lanUrl = status?.lanUrl;
  const tunnelUrl = status?.tunnelUrl;
  // 公网来源（隧道）只能管理自己的密码：隧道开关/配置、局域网开关、恢复出厂
  // 都是本机主人的动作，服务端会回 forbidden，前端据此直接隐藏而不是让用户点了报错。
  const publicView = status?.origin === 'public';
  const tunnelPhase = tunnelState?.phase ?? 'idle';
  const tunnelStarting = ['downloading', 'starting', 'registering'].includes(tunnelPhase);
  const tunnelStateDetail = tunnelState?.detail ?? '';
  const tunnelStateStarted = tunnelState?.startedAt ?? null;
  const tunnelConfig = status?.tunnelConfig ?? { hostname: '', tokenSet: false };
  const publicConfigured = Boolean(tunnelConfig.hostname && tunnelConfig.tokenSet);
  const openTunnelConfig = () => setTunnelCfg({ hostname: tunnelConfig.hostname ?? '', token: '', err: null });
  const tunnelConfigChanged = Boolean(tunnelUrl && tunnelUrl !== `https://${tunnelConfig.hostname}`);
  // 后端错误消息统一为「中文 | English」混排；按当前界面语言只显示对应一半
  const errText = (msg) => {
    const s = String(msg ?? '');
    const i = s.indexOf(' | ');
    if (i < 0) return s;
    return (t('ok') === POCKET_ZH.ok ? s.slice(0, i) : s.slice(i + 3)).trim();
  };
  // 轻量 Toast：操作成功/失败后短暂提示（自动消失，不打断操作）
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // 弹窗可访问性：Esc 关闭最上层弹窗；打开时记住焦点，关闭后还回去（键盘用户不丢位置）。
  const lastFocusRef = useRef(null);
  const anyModalOpen = disclaimerOpen || lanToggleOpen !== null || resetOpen;
  useEffect(() => {
    if (!anyModalOpen) return undefined;
    lastFocusRef.current = document.activeElement;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // 弹窗自己消费掉 Esc：只 preventDefault 的话事件继续冒泡到宿主监听器，
      // 一次 Esc 会同时关掉弹窗与设置分区（用户填到一半的表单随之丢失）。
      e.preventDefault();
      e.stopPropagation();
      if (disclaimerOpen) { setDisclaimerOpen(false); return; }
      if (lanToggleOpen !== null) { setLanToggleOpen(null); return; }
      if (resetOpen) setResetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const el = lastFocusRef.current;
      lastFocusRef.current = null;
      if (el && typeof el.focus === 'function' && el.isConnected) el.focus();
    };
  }, [anyModalOpen, disclaimerOpen, lanToggleOpen, resetOpen]);

  // ── 视图件（v3：宿主 token + class 样式）───────────────────────────────────
  // 开关：跟宿主 0.2.x 对齐（36×20 轨道 / 16×16 圆钮）；disabled 用于操作进行中。
  const Switch = (on, onClick, disabled, label = null) => h('button', {
    role: 'switch', type: 'button', 'aria-checked': !!on, disabled: disabled === true,
    'aria-label': label ?? undefined,
    className: 'dshp-switch',
    onClick: disabled === true ? undefined : onClick,
  }, h('span', { className: 'dshp-switch-thumb' }));

  // 按钮：variant = primary | ghost | quiet | danger；mini = 行内小按钮。
  // 文案两种传法都支持：props.children，或 Btn({...}, '文案') 的第二参数
  // （后者是旧调用风格；只按 props 解构会静默丢掉第二参数，渲染出空白按钮）。
  const Btn = (props, ...extraChildren) => {
    const { variant = 'ghost', mini = false, icon = null, children: propChildren, ...rest } = props ?? {};
    const children = extraChildren.length > 0 ? extraChildren : propChildren;
    return h('button', {
      type: 'button',
      ...rest,
      className: `dshp-btn is-${variant}${mini ? ' is-mini' : ''}`,
    }, icon ? h(icon, { size: mini ? 12 : 14 }) : null, children);
  };

  // 状态胶囊：圆点 + 文本（用于页头汇总当前两条通道的状态）
  const Chip = ({ on, children }) => h('span', { className: `dshp-chip${on ? ' is-on' : ''}` },
    h('span', { className: 'dshp-chip-dot' }), children);

  // 分区卡：图标 + 标题 + 副题 + 右侧控件，内容在卡片体里
  const Card = ({ icon, title, sub, right, children, danger = false, key }) => h('section', {
    className: `dshp-card${danger ? ' is-danger' : ''}`,
    'data-dshp-section': key ?? '',
  },
  h('div', { className: 'dshp-card-head' },
    icon ? h('span', { className: 'dshp-card-icon' }, h(icon, { size: 16 })) : null,
    h('div', { className: 'dshp-card-text' },
      h('div', { className: 'dshp-card-title' }, title),
      sub ? h('div', { className: 'dshp-card-sub' }, sub) : null),
    right ?? null),
  children ? h('div', { className: 'dshp-card-body' }, children) : null);

  // 设置行：左标签（可带说明）+ 右控件；extra 渲染在整行下方（展开面板等）
  const Row = ({ label, desc, control, extra, stack = false }) => h('div', {
    className: `dshp-row${stack ? ' is-stack' : ''}`,
  },
  h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, rowGap: 8, flexWrap: 'wrap', minWidth: 0, width: '100%' } },
    h('div', { style: { minWidth: 0 } },
      h('div', { className: 'dshp-row-label' }, label),
      desc ? h('div', { className: 'dshp-row-desc' }, desc) : null),
    control ?? null),
  extra ?? null);

  // 提示条：kind = info | warn | error
  const Alert = ({ kind = 'info', icon = null, children, title = null, extra = null }) => h('div', { className: `dshp-alert is-${kind}` },
    icon ? h('span', { className: 'dshp-alert-icon' }, h(icon, { size: 14 })) : null,
    h('div', { className: 'dshp-alert-body' },
      title ? h('div', { className: 'dshp-alert-title' }, title) : null,
      children,
      extra ?? null));

  // 二维码横排卡：左 128px 码（白底衬 quiet zone）+ 右侧地址/提示/复制
  const QRBlock = ({ src, url, hint }) => h('div', { className: 'dshp-qr' },
    h('div', { className: 'dshp-qr-frame' }, src ? h('img', { src, alt: 'QR' }) : null),
    h('div', { className: 'dshp-qr-main' },
      h('div', { className: 'dshp-url' }, url),
      hint ? h('div', { className: 'dshp-qr-hint' }, hint) : null,
      h('div', { className: 'dshp-qr-actions' },
        Btn({ variant: 'ghost', mini: true, icon: Ico.copy, onClick: async () => showToast(await copyText(url) ? t('copied') : t('copyFailed')) }, t('copyLink')))));

  // 访问密码值行：遮罩（固定 8 个点，不泄露长度）/明文 + 显示/隐藏 + 额外按钮
  const pinValueRow = (which, value, extraBtns) => h('div', { className: 'dshp-pinbox' },
    h('span', { className: 'dshp-pin-value', 'data-dshp-pin': which }, pinShown[which] ? value : '••••••••'),
    Btn({
      variant: 'ghost', mini: true,
      onClick: () => setPinShown((m) => ({ ...m, [which]: !m[which] })),
    }, pinShown[which] ? t('pinHide') : t('pinShow')),
    ...(extraBtns ?? []));

  // 自定义密码输入行：输入框 + 保存/取消
  const customPinRow = (which) => h('div', { className: 'dshp-adv' },
    h('div', { className: 'dshp-custom' },
      h('span', null, t('customizing')),
      h('input', {
        className: 'dshp-input is-mono',
        style: { width: 150, textAlign: 'center' },
        type: 'password', minLength: 8, maxLength: 64,
        name: 'dsh-pocket-pin', autoComplete: 'new-password', spellCheck: false,
        value: customPin?.value ?? '', autoFocus: true,
        // 过滤掉字母数字以外的字符（服务端也只收 [a-zA-Z0-9]），但不能再静默吞：
        // 粘贴全角/中文时用户得知道字符被忽略了，否则只会看到「长度不够」。
        onChange: (e) => {
          const raw = e.target.value;
          const filtered = raw.replace(/[^a-zA-Z0-9]/g, '');
          setCustomPin((c) => ({
            ...c,
            value: filtered,
            err: filtered.length === raw.length ? null : t('pinCharsFiltered'),
          }));
        },
        onKeyDown: (e) => { if (e.key === 'Enter') saveCustomPin(which); if (e.key === 'Escape') setCustomPin(null); },
      }),
      Btn({ variant: 'primary', mini: true, onClick: () => saveCustomPin(which), disabled: pending.savePin === true }, t('save')),
      Btn({ variant: 'ghost', mini: true, onClick: () => setCustomPin(null), disabled: pending.savePin === true }, t('cancel'))),
    customPin?.err ? h('div', { className: 'dshp-err-text' }, errText(customPin.err)) : null);

  const customBtn = (which) => Btn({ variant: 'ghost', mini: true, onClick: () => setCustomPin({ which, value: '', err: null }) }, t('customize'));

  // 统一确认弹窗：遮罩 + 面板（标题色随语义）+ 内容 + 右对齐操作
  // 可访问性：role=dialog + aria-modal + aria-label；Esc 关闭（见下面的全局 keydown effect）；
  // 点遮罩空白处关闭。取消按钮带 autoFocus，键盘用户打开即可直接 Esc/Enter。
  const Modal = ({ title, tone = 'warn', children, actions, onClose }) => h('div', {
    className: 'dshp-modal-backdrop',
    onClick: (e) => { if (e.target === e.currentTarget) onClose?.(); },
  },
  h('div', { className: 'dshp-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: `dshp-modal-title is-${tone}` }, title),
    children,
    h('div', { className: 'dshp-modal-actions' }, actions)));

  // 高级（手动选地址）展开态
  const [advOpen, setAdvOpen] = useState(false);

  // ── 公网卡片的派生片段（拆开写，避免多层三元把 JSX 括号搞乱）─────────────
  const wanStatusView = tunnelStarting
    ? Alert({
      kind: 'info', icon: Ico.info,
      children: tunnelPhase === 'downloading'
        ? fmt(t, 'downloading', { s: elapsed(tunnelStateStarted) })
        : fmt(t, 'connecting', { s: elapsed(tunnelStateStarted), suffix: elapsed(tunnelStateStarted) > 30 ? t('slowHint') : '' }),
    })
    : tunnelPhase === 'error'
      ? Alert({ kind: 'error', icon: Ico.warn, children: fmt(t, 'error', { detail: errText(tunnelStateDetail) || t('unknownError') }) })
      : (!tunnelUrl && publicConfigured
        ? Alert({
          kind: 'info', icon: Ico.info, children: t('wanOffHint'),
          extra: h('div', { style: { marginTop: 8 } },
            Btn({ variant: 'primary', onClick: startTunnel, disabled: pending.wan === true || pending.saveNamed === true }, t('enable'))),
        })
        : null);

  const namedSummaryView = publicConfigured && !tunnelCfg
    ? h('div', { className: 'dshp-panel' },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { className: 'dshp-panel-title' }, tunnelConfig.hostname || '—'),
          h('div', { className: 'dshp-hint', style: { marginTop: 2 } },
            tunnelConfig.tokenSet ? t('namedTokenSet') : t('namedTokenMissing'))),
        Btn({ variant: 'ghost', mini: true, onClick: () => setTunnelCfg({ hostname: tunnelConfig.hostname ?? '', token: '', err: null }) }, t('namedEdit'))),
      h('div', { className: 'dshp-hint', style: { marginTop: 8, lineHeight: 1.65 } }, t('namedHow')),
      !tunnelConfig.tokenSet || !tunnelConfig.hostname ? h('div', { className: 'dshp-err-text' }, t('namedNeedCfg')) : null)
    : null;

  const namedFormView = tunnelCfg
    ? h('div', { className: 'dshp-form' },
      h('label', { className: 'dshp-field' }, t('namedHostnameLabel'),
        h('input', {
          className: 'dshp-input',
          placeholder: 'pocket.example.com',
          value: tunnelCfg.hostname ?? '',
          autoFocus: true,
          onChange: (e) => setTunnelCfg((c) => ({ ...c, hostname: e.target.value.trim(), err: null })),
          onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
        })),
      h('label', { className: 'dshp-field' }, t('namedTokenLabel'),
        h('input', {
          className: 'dshp-input is-mono',
          type: 'password',
          name: 'dsh-pocket-tunnel-token', autoComplete: 'off', spellCheck: false,
          value: tunnelCfg.token ?? '',
          onChange: (e) => setTunnelCfg((c) => ({ ...c, token: e.target.value.trim(), err: null })),
          onKeyDown: (e) => { if (e.key === 'Enter') saveNamedTunnel(); if (e.key === 'Escape') setTunnelCfg(null); },
        })),
      h('div', { className: 'dshp-inline' },
        Btn({ variant: 'primary', mini: true, onClick: saveNamedTunnel, disabled: pending.saveNamed === true }, t('save')),
        Btn({ variant: 'ghost', mini: true, onClick: () => setTunnelCfg(null), disabled: pending.saveNamed === true }, t('cancel'))),
      h('div', { className: 'dshp-hint' }, t('namedHow')),
      h('div', { className: 'dshp-warn-text' }, t('namedSecurity')),
      tunnelCfg.err ? h('div', { className: 'dshp-err-text' }, errText(tunnelCfg.err)) : null)
    : null;

  const publicConfigView = h('div', { className: 'dshp-adv' },
    tunnelConfigChanged ? h('div', { className: 'dshp-warn-text' }, t('namedTakeEffect')) : null,
    !publicConfigured && !tunnelCfg ? Alert({
      kind: 'info', icon: Ico.info, children: t('publicSetupHint'),
      extra: h('div', { style: { marginTop: 8 } },
        Btn({ variant: 'primary', onClick: openTunnelConfig }, t('publicConfigure'))),
    }) : null,
    namedSummaryView,
    namedFormView);

  const publicPinView = status?.accessToken
    ? Row({
      label: t('pinLabel'),
      stack: true,
      extra: customPin?.which === 'public'
        ? customPinRow('public')
        : h('div', null,
          pinValueRow('public', status.accessToken, [customBtn('public')]),
          h('div', { className: 'dshp-warn-text' }, t('namedSecurity'))),
    })
    : null;

  const wanBody = h('div', null,
    tunnelUrl ? QRBlock({ src: status.tunnelQr, url: tunnelUrl, hint: t('namedRunningHint') }) : null,
    Row({ label: t('publicConfig'), stack: true, extra: publicConfigView }),
    publicConfigured || tunnelUrl ? publicPinView : null);

  return h('div', { className: 'dshp-page', 'data-dshp-ui': 'v3' },
    // 页头：图标 + 标题 + 副题；下面一行状态胶囊汇总两条通道
    h('header', { className: 'dshp-head' },
      h('span', { className: 'dshp-badge' }, h(Ico.settings, { size: 19 })),
      h('div', { className: 'dshp-head-main' },
        h('div', { className: 'dshp-title' }, t('section')),
        h('div', { className: 'dshp-sub' }, t('subtitle')))),
    h('div', { className: 'dshp-chips' },
      status
        ? [
          Chip({ on: status.lanEnabled !== false, children: `${t('lanAccess')} · ${status.lanEnabled !== false ? t('statusOn') : t('statusOff')}` }),
          Chip({ on: !!tunnelUrl, children: `${t('wanAccess')} · ${tunnelUrl ? t('statusConnected') : t('statusOff')}` }),
        ]
        : h('span', { className: 'dshp-hint', style: { marginTop: 0 } }, t('loadingStatus'))),

    // 操作错误：放在页面顶部（即使操作按钮在下面也一眼看见），可手动关掉
    error ? Alert({ kind: 'error', icon: Ico.warn, children: errText(error),
      extra: h('div', { className: 'dshp-inline', style: { marginTop: 8 } },
        Btn({ variant: 'ghost', mini: true, onClick: () => setError(null) }, t('ok'))) }) : null,

    // 与宿主断开：连续两次拉不到 status 才提示（宿主重启期间正常现象，恢复后自动消失）
    offline ? Alert({ kind: 'warn', icon: Ico.warn, children: t('offlineHint') }) : null,

    // 重启后提示（进程在后台运行，停止方法）——桌面端不显示更新/重启横幅（由 DSH Desktop 管理）
    !isDesktop && restartNotice ? Alert({ kind: 'info', icon: Ico.refresh,
      title: t('restarted'),
      children: h('div', { className: 'dshp-hint', style: { wordBreak: 'break-all', marginTop: 2 } },
        fmt(t, 'bgHint', { cmd: status?.killHint ?? `lsof -ti :${status?.dshPort ?? 3080} | xargs kill -9` })),
      extra: h('div', { className: 'dshp-inline', style: { marginTop: 8 } },
        autoReloadFailed
          ? Btn({ variant: 'ghost', mini: true, icon: Ico.refresh, onClick: () => { setAutoReloadFailed(false); waitForHostThenReload(); } }, t('reloadNow'))
          : null,
        autoReloadFailed ? h('span', { className: 'dshp-hint', style: { marginTop: 0 } }, t('reloadFailed')) : null,
        Btn({ variant: 'quiet', mini: true, onClick: () => setRestartNotice(false) }, t('ok'))),
    }) : null,

    // 更新提示——琥珀色提示条（有新版本/更新中/已更新待重启，单状态不并存；桌面端不渲染）
    // 公网访客不渲染：服务端已拒绝公网走 update/restart（forbidden），露出按钮只会
    // 让用户点了报错；更新/重启属于本机能力。
    !isDesktop && !publicView && updateInfo ? Alert({ kind: 'warn', icon: Ico.download,
      title: updateInfo.updated
        ? fmt(t, 'updatedRestart', { ver: updateInfo.current })
        : updateInfo.result === 'ok'
          ? (updateInfo.autoRestart ? fmt(t, 'updateAutoRestarting', { ver: updateInfo.latest }) : fmt(t, 'updatedOk', { ver: updateInfo.latest }))
          : updateInfo.result === 'fail'
            ? t('updateFailedTitle')
            : fmt(t, 'updateAvailable', { ver: updateInfo.latest }),
      children: h('div', { className: 'dshp-hint', style: { marginTop: 2 } },
        updateInfo.updating
          ? fmt(t, 'updatingDetail', { s: elapsed(updateInfo.startedAt) })
          : updateInfo.restarting
            ? fmt(t, 'restartingDetail', { s: elapsed(updateInfo.startedAt) })
            : updateInfo.result === 'ok'
              ? (updateInfo.autoRestart ? t('updatedAutoDetail') : t('updatedRestartDetail'))
              : updateInfo.result === 'fail' ? fmt(t, 'updateFailed', { err: errText(updateInfo.output) || t('unknownError') })
                : fmt(t, 'versionRange', { cur: updateInfo.current, latest: updateInfo.latest })),
      extra: h('div', { className: 'dshp-inline', style: { marginTop: 8 } },
        updateInfo.result !== 'ok'
          ? Btn({ variant: 'primary', mini: true, icon: Ico.download, onClick: runUpdate, disabled: updateInfo.updating }, updateInfo.updating ? t('updating') : fmt(t, 'updateTo', { ver: updateInfo.latest }))
          : updateInfo.autoRestart
            ? Btn({ variant: 'ghost', mini: true, disabled: true }, t('restartingNow'))
            : Btn({ variant: 'primary', mini: true, icon: Ico.refresh, onClick: restartPocket, disabled: updateInfo.restarting }, updateInfo.restarting ? t('restarting') : t('restartNow')),
        // 「稍后」只隐藏横幅；下次版本检查（15 分钟/回到前台）会重新提示，不会漏掉更新
        !updateInfo.updating && !updateInfo.restarting
          ? Btn({ variant: 'ghost', mini: true, onClick: () => setUpdateInfo(null) }, t('later'))
          : null),
    }) : null,

    // ── 局域网 ────────────────────────────────────────────────────────────────
    // 卡片：标题 + 副题 + 总开关 → 二维码 → 访问密码 → 高级（手动选地址）
    Card({
      key: 'lan', icon: Ico.lan, title: t('lanAccess'), sub: t('lanHint'),
      right: Switch(status?.lanEnabled !== false, () => requestLanToggle(status?.lanEnabled === false), !status || pending.lanToggle === true || publicView, t('lanAccess')),
      children: publicView
        ? h('div', { className: 'dshp-hint' }, t('lanLocalOnly'))
        : !status
        ? h('div', { className: 'dshp-loading' }, t('loadingStatus'))
        : status.lanEnabled === false
          ? Alert({
            kind: 'info', icon: Ico.info, children: t('lanDisabledHint'),
            extra: h('div', { style: { marginTop: 8 } },
              Btn({ variant: 'primary', onClick: () => requestLanToggle(true), disabled: pending.lanToggle === true }, t('lanToggleTitleOn'))),
          })
          : (lanUrl
            ? h('div', null,
              QRBlock({ src: status.lanQr, url: lanUrl, hint: null }),
              Row({
                label: t('lanPin'),
                desc: status?.lanAuthEnabled === false ? t('lanPinOff') : null,
                control: Switch(status?.lanAuthEnabled !== false, () => setLanAuth(status?.lanAuthEnabled === false), pending.lanAuth === true, t('lanPin')),
              }),
              status?.lanAuthEnabled === false
                ? null
                : (customPin?.which === 'lan'
                  ? customPinRow('lan')
                  : status.lanToken
                    ? h('div', null,
                      pinValueRow('lan', status.lanToken, [
                        Btn({ variant: 'ghost', mini: true, icon: Ico.refresh, onClick: refreshLanPin, disabled: pending.refreshPin === true }, t('refresh')),
                        customBtn('lan'),
                      ]),
                      status.lanPinCustom ? h('div', { className: 'dshp-warn-text' }, t('pinCustomHint')) : null)
                    // 公网访问时后端故意不返回局域网 PIN（防止隧道访客拿到后
                    // 在同一 WiFi 下直连、绕过「关掉隧道」这种撤销手段）。
                    // 本机/局域网拿不到则是读取失败，不要误报成「远端不显示」。
                    : h('div', { className: 'dshp-hint' }, publicView ? t('lanPinRemoteHint') : t('lanPinUnavailable'))),
              Row({
                label: t('advAddress'),
                control: Btn({ variant: 'ghost', mini: true, onClick: () => setAdvOpen((v) => !v) }, (status.lanIpOverride || t('lanAddressAuto')) + (advOpen ? ' ‹' : ' ›')),
                extra: advOpen ? h('div', { className: 'dshp-adv' },
                  h('label', { className: 'dshp-field' }, t('lanAddress'),
                    h('select', {
                      className: 'dshp-select',
                      value: status.lanIpOverride || '',
                      disabled: pending.lanAddr === true,
                      onChange: (e) => setLanAddress(e.target.value),
                    },
                    h('option', { value: '' }, t('lanAddressAuto')),
                    (status.lanCandidates || []).map((ip) => h('option', { key: ip, value: ip }, ip))))) : null,
              }))
            : h('div', { className: 'dshp-hint' }, t('lanStarting'))),
    }),

    // ── 公网 ────────────────────────────────────────────────────────────────
    // 卡片：标题 + 副题 + 总开关（开=已连隧道）；开启经免责声明弹窗确认
    Card({
      key: 'wan', icon: Ico.wan, title: t('wanAccess'), sub: t('namedWanHint'),
      right: Switch(!!tunnelUrl, () => (tunnelUrl ? stopTunnel() : startTunnel()), tunnelStarting || pending.wan === true || pending.saveNamed === true || !status || publicView, t('wanAccess')),
      children: publicView
        ? h('div', null,
          tunnelUrl ? QRBlock({ src: status?.tunnelQr, url: tunnelUrl, hint: t('namedRunningHint') }) : null,
          h('div', { className: 'dshp-hint' }, t('wanLocalOnly')))
        : !status
        ? h('div', { className: 'dshp-loading' }, t('loadingStatus'))
        : h('div', null, wanStatusView, wanBody),
    }),

    // ── 手机端偏好：右边栏 / 捏合缩放 / 独立字号 ─────────────────────────────
    Card({
      key: 'prefs', icon: Ico.sliders, title: t('prefsTitle'), sub: t('prefsHint'),
      children: !status
        ? h('div', { className: 'dshp-loading' }, t('loadingStatus'))
        : h('div', null,
          Row({
            label: t('mobileRightbar'),
            desc: t('mobileRightbarHint'),
            control: Switch(status.mobileRightbarEnabled !== false, () => setMobileRightbar(status.mobileRightbarEnabled === false), pending.prefs === true, t('mobileRightbar')),
          }),
          Row({
            label: t('mobilePinchZoom'),
            desc: t('mobilePinchZoomHint'),
            control: Switch(status.mobilePinchZoomEnabled === true, () => setMobilePinchZoom(status.mobilePinchZoomEnabled !== true), pending.prefs === true, t('mobilePinchZoom')),
          }),
          Row({
            label: t('mobileFontSize'),
            desc: t('mobileFontSizeHint'),
            control: h('select', {
              className: 'dshp-select',
              value: String(Number(status.mobileFontSize) || 0),
              disabled: pending.prefs === true,
              onChange: (e) => setMobileFontSize(Number(e.target.value)),
            }, MOBILE_FONT_OPTIONS.map((px) => h('option', { key: px, value: String(px) }, px === 0 ? t('mobileFontFollow') : `${px} px`))),
          })),
    }),

    // ── 维护：恢复出厂设置（最底部，避免误触）────────────────────────────────
    Card({
      key: 'reset', icon: Ico.trash, title: t('resetFactory'), sub: t('resetIntro'), danger: true,
      right: publicView
        ? h('div', { className: 'dshp-hint' }, t('resetLocalOnly'))
        : Btn({ variant: 'danger', mini: true, onClick: () => setResetOpen(true), disabled: pending.reset === true }, t('resetGo')),
    }),

    // 页脚署名行：开发者 · Star · 反馈
    h('footer', { className: 'dshp-footer' },
      h('span', null, t('developer')),
      h('span', null, '·'),
      h('a', { href: 'https://github.com/daha1216/dsh-pocket', target: '_blank', rel: 'noreferrer', title: t('starAsk') }, t('starCta')),
      h('span', null, '·'),
      h('a', { href: 'https://github.com/daha1216/dsh-pocket/issues', target: '_blank', rel: 'noreferrer' }, t('feedback'))),

    // 恢复出厂设置确认弹框
    resetOpen ? Modal({ title: t('resetTitle'), tone: 'danger', onClose: () => setResetOpen(false),
      children: h('div', { className: 'dshp-modal-body' }, t('resetBody')),
      actions: h('div', { className: 'dshp-inline' },
        Btn({ variant: 'ghost', mini: true, autoFocus: true, onClick: () => setResetOpen(false) }, t('cancel')),
        Btn({ variant: 'danger', mini: true, onClick: doFactoryReset, disabled: pending.reset === true }, t('resetConfirm'))) }) : null,

    // 局域网访问开关确认弹框（关闭/打开时弹窗提醒）
    lanToggleOpen !== null ? Modal({ title: t(lanToggleOpen ? 'lanToggleTitleOn' : 'lanToggleTitleOff'), tone: lanToggleOpen ? 'brand' : 'warn', onClose: () => setLanToggleOpen(null),
      children: h('div', { className: 'dshp-modal-body' }, t(lanToggleOpen ? 'lanToggleBodyOn' : 'lanToggleBodyOff')),
      actions: h('div', { className: 'dshp-inline' },
        Btn({ variant: 'ghost', mini: true, autoFocus: true, onClick: () => setLanToggleOpen(null) }, t('cancel')),
        Btn({ variant: 'primary', mini: true, onClick: confirmLanToggle }, t('confirm'))) }) : null,

    // 安全免责声明弹框（issue #31）：每次开启公网访问前确认
    disclaimerOpen ? Modal({ title: t('disclaimerTitle'), tone: 'warn', onClose: () => setDisclaimerOpen(false),
      children: h('div', null,
        h('div', { className: 'dshp-modal-body' }, t('disclaimerBody')),
        h('label', { className: 'dshp-check' },
          h('input', { type: 'checkbox', checked: disclaimerChecked, onChange: (e) => setDisclaimerChecked(e.target.checked) }),
          t('disclaimerAgree')),
        !disclaimerChecked ? h('div', { className: 'dshp-err-text', style: { marginTop: 8 } }, t('disclaimerHint')) : null),
      actions: h('div', { className: 'dshp-inline' },
        Btn({ variant: 'ghost', mini: true, autoFocus: true, onClick: () => setDisclaimerOpen(false) }, t('cancel')),
        Btn({ variant: 'primary', mini: true, disabled: !disclaimerChecked, onClick: confirmDisclaimer }, t('disclaimerAgree'))) }) : null,

    // Toast：重置等操作的即时反馈（固定屏幕正中央，2.6s 自动消失；读屏通过 aria-live 播报）
    toast ? h('div', { className: 'dshp-toast', role: 'status', 'aria-live': 'polite' }, toast) : null,
  );
}

export function apply(ctx) {
  // 兜底：确保 connection.isLoopback 为 true（issue #58）。
  // 注：代理注入的 loopback 补丁（proxy.mjs LOOPBACK_ENV_PATCH）已在 #105 移除——
  // 它与 DSH Desktop 2.0.4+ 客户端运行时不兼容，会令 BootHandoff 阶段白屏。
  // #58「远程浏览器开设置页」需上游提供官方信任来源机制才能正经解决；此处仅保留兜底。
  // 0.2.0-rc.1 起真正的修复在 proxy.mjs 的 TRANSPORT_API_CLIENT_SHIM（transport.ownsHost=true）：
  // isLoopback = transport?.ownsHost === true || isLoopbackHostname(location.hostname)，
  // 且 ui-settings 在插件激活前就固化 persistence，本插件 apply 时补来不及——只能注入层抢先。
  if (ctx?.connection) {
    try {
      Object.defineProperty(ctx.connection, 'isLoopback', { value: true, writable: true, configurable: true });
    } catch {
      try { ctx.connection.isLoopback = true; } catch { /* 忽略 */ }
    }
  }

  // 设置页签接入 DSH 本地化：注册 pocket 词典（zh/en），并绑定一个随当前 locale 切换的 t()。
  // 必须先于 mobileApply(ctx)：mobile-apply 安装的 fileGuard 取词依赖 pocket 词典已
  // 注册——注册 effect 排在其后的话，理论上 fileGuard 安装期取词会早于词典就位。
  const translate = ctx.locale.bind(POCKET_NS);
  ctx.effect(() => ctx.locale.register(POCKET_NS, { zh: POCKET_ZH, en: POCKET_EN }), 'dsh-pocket: pocket locale dictionaries');

  // 移动端适配（dsh-web-mobile 移植）：抽屉布局/触控/安全区，仅窄屏生效
  mobileApply(ctx);

  const rpcCall = (endpoint, payload, signal) =>
    ctx.connection.rpc.call(POCKET_RPC_CHANNEL, endpoint, payload, signal);

  // 设置一级入口（与 通用设置/模型/插件 同级，order 1 = 通用之后、最外层）
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'pocket',
        order: 1,
        label: () => translate('section'),
        inject: () => ({ rpcCall, t: translate }),
      },
      PocketSettingsTab,
    ),
  );
}

export { name, inject, redactStatus };
