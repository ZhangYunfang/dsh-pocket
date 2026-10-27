// dsh-pocket 核心：Host/Origin 改写反向代理
//
// 为什么需要它：DSH 的 /api 浏览器信任栅栏只认 loopback（127.0.0.1）或
// `--trusted-host` 白名单（且官方禁了 0.0.0.0 绑定，防止把远程执行代码暴露给网络）。
// 本代理把入站请求的 Host / Origin 统一改写成 loopback 权威（127.0.0.1:3080），
// 转发给本机 dsh web——栅栏永远看到 loopback，于是：
//   - 局域网：手机直接访问 http://<电脑IP>:端口
//   - 公网：cloudflared 隧道指到本代理，任意域名都能进
// 都不需要改 dsh 的任何配置。
//
// 同步保证：普通请求与 WebSocket upgrade（/api/events.host 流式推送）都原样透传，
// 手机看到的界面与电脑完全一致、实时。

import { createServer } from 'node:http';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { isIP } from 'node:net';
import { createGzip, createGunzip, createBrotliCompress, constants as zlibConstants, gunzipSync, brotliDecompressSync, inflateSync, brotliCompressSync, gzipSync } from 'node:zlib';
import { createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };

/**
 * 非安全上下文（http://<LAN-IP>:端口）里浏览器缺两个 API，由代理注入 polyfill
 * （只在缺少时生效，不覆盖原生实现）：
 *   1. crypto.randomUUID——DSH 连接层 mint RPC id 用，缺失直接抛错；
 *   2. AbortSignal.any（issue #53）——Android 厂商浏览器/WebView（Chrome < 116）
 *      无原生实现，DSH 连接层发送消息会调 AbortSignal.any([...])，缺失则消息发不出。
 * 带 data-dsh-pocket-polyfill 标记：注入判重用它，而不是搜索 "crypto.randomUUID"
 * 字样（dsh 页面源码里可能恰好出现该字符串，导致误判为已注入而跳过）。
 */
export const RANDOM_UUID_POLYFILL = `<script data-dsh-pocket-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();
/* 注：曾用「全局 let location + Proxy」伪装 location.hostname 修 DSH isLoopback 判定
（issue #58：局域网访问模型设置页报 settings unavailable）——但 let location 全局
词法绑定会让任何恰好顶层声明 location 的脚本（DSH 插件经典 script）SyntaxError 崩溃，
导致会话列表不显示（实测 PAGEERROR: Identifier 'location' has already been declared）。
已回退；该问题属 DSH 客户端限制（location.hostname 是 unforgeable 属性）无法安全绕过。*/</script>`;

/**
 * issue #96：dsh 0.1.1-rc.2 起，`@deepseek-ai/dsh-client-connection` 的连接层改成
 *   const api = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
 * 其中 transport = globalThis.__DSH_TRANSPORT__（由 DSH 宿主 web shell 注入，本仓库
 * 全程不创建、不引用这个全局）。桌面直连 127.0.0.1:3080 时宿主给的 transport 带
 * createApiClient；经本代理（局域网 / 隧道域名）访问时宿主给的 transport 不带该方法
 * → 手机上一执行就 TypeError: transport?.createApiClient is not a function，整页崩。
 *
 * 兜底策略：只在该方法缺失时补一个返回 null 的实现。null 会触发宿主自己那条
 * `?? new WebApiClient()` 兜底分支，等于让连接层回到旧版本（0.1.1-rc.2 之前）的
 * 行为。宿主自己有实现时一律不覆盖。
 *
 * issue #58（0.2.0-rc.1 复发，2026-09-28）：连接层判定宿主可达性的表达式是
 *   isLoopback = transport?.ownsHost === true || pageLocation === void 0
 *                || isLoopbackHostname(pageLocation.hostname)
 * 手机经本代理访问时 location.hostname 是局域网 IP / 隧道域名 → isLoopback=false →
 * `dsh-client-ui-settings` 在插件激活期以 `ctx.remote.$host.isLoopback` 一次性固化
 * settings mirror 的 persistence="memory" → 设置页「模型」页签永远报
 * 「加载提供商目录失败: settings are unavailable in this browser」（dsh-pocket 的
 * client apply 里那个 isLoopback 兜底补丁来不及——ui-settings 已经先固化了）。
 * location.hostname 是 unforgeable 属性伪装不了，但**第一分支给我们留了正门**：
 * 让连接层在构造 handle 时读到 transport.ownsHost===true，早于一切插件激活 →
 * settings/模型页在手机上恢复。
 *
 * 时机细节：浏览器页面里宿主 web shell **从不赋值** __DSH_TRANSPORT__（它是 Electron
 * 渲染进程的东西），只拦截「宿主赋值」的话普通浏览器永远等不到。所以 shim 在
 * 「当前没有 transport」时主动创建一个 { ownsHost:true, createApiClient:()=>null }
 * 占位（createApiClient 必须带上：连接层那行 `transport?.createApiClient()` 只对
 * transport 本身做可选链，方法缺失会 TypeError 整页崩——issue #96）。
 *
 * 属性用 configurable:false 安装：宿主 web shell 会在消费后 `delete
 * globalThis.__DSH_TRANSPORT__`（消费即焚），configurable:true 时一删就没了，
 * connection 包稍后的 apply()（`globals.__DSH_TRANSPORT__`）读到 undefined →
 * isLoopback 回落到 hostname 分支 → 修复失效。configurable:false 下非严格模式的
 * delete 静默失败、属性保留；accessor 的 set 不受影响——宿主真赋值（Electron
 * 渲染进程）仍会被拦截 patch，原生实现/原生 true 一律不覆盖。
 *
 * 安全边界：只在「宿主没说 ownsHost」时才声明（true 不覆盖）；本代理的所有入口
 * 本就要求 PIN/cookie 认证，等同用户显式信任该浏览器。桌面 Electron 渲染进程
 * 原生 ownsHost=true，不受影响。
 */
export const TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-pocket-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'){if(typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}if(t.ownsHost!==true){try{Object.defineProperty(t,'ownsHost',{value:true,writable:true,configurable:true});}catch(e){try{t.ownsHost=true;}catch(e2){}}}}}catch(e){}return t;}if(cur)patch(cur);else cur=patch({ownsHost:true,createApiClient:function(){return null;}});Object.defineProperty(globalThis,K,{configurable:false,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;

const INJECT_MARK = 'data-dsh-pocket-polyfill="1"';

// HTML 注入分支的内存上限：页面本体几十 KB，正常远小于此值。超过就放弃注入、原样
// 流式回传——否则一个超大 HTML（或被劫持成解压炸弹的响应）会把整个报文攒进内存，
// 同步 gunzip/brotliDecompress 还会卡住事件循环（所有 WS/请求一起停摆）。
const HTML_INJECT_MAX = 4 * 1024 * 1024;

// 分享链接（CLI 二维码 / `?token=<PIN>`）的地址栏清理：代理已经把明文 PIN 从转发给
// 上游的请求行/Referer/日志里摘掉，但浏览器自己的地址栏与历史仍留着它。用
// history.replaceState 就地抹掉 query 里的 token——不跳转（Safari 在 http://纯IP
// 源上会丢 3xx 下发的 Set-Cookie，重定向会破坏扫码登录，见 issue #91）。
// 只在本次请求确实带过口袋 PIN 时注入（req.__pocketTokenScrubbed）。
const TOKEN_SCRUB_MARK = 'data-dsh-pocket-token-scrub="1"';
const TOKEN_SCRUB_SCRIPT = `<script ${TOKEN_SCRUB_MARK}>(function(){try{var u=new URL(location.href);var keys=[];u.searchParams.forEach(function(v,k){if(String(k).toLowerCase()==='token')keys.push(k);});if(!keys.length)return;keys.forEach(function(k){u.searchParams.delete(k);});history.replaceState(null,'',u.pathname+(u.search||'')+u.hash);}catch(e){}})();</script>`;

// 代理→上游 RPC 的来源分级头（loopback / lan / public）。入站同名头在
// loopbackAuthority 里被丢弃，值只由不可伪造的源地址 + policyHost 决定，
// 上游据此决定「公网 PIN 是否回显给这个客户端」之类的授权。
const POCKET_ORIGIN_HEADER = 'x-dsh-pocket-origin';

/**
 * DSH Desktop（桌面版）渲染进程兼容补丁（issue #3/#4，已于 issue #76 停用）。
 *
 * 历史：旧版 dsh-plugin-desktop 的 client 在页面加载时从 URL query 读
 * `dsh-desktop-mode` 与 `dsh-desktop-platform`，缺失即抛
 * "invalid or missing dsh-desktop-mode null" → 页面崩（手机扫码访问桌面版时正是如此）。
 * 本脚本用 history.replaceState 补上这两个参数（无跳转、不重载），取最轻的
 * `compatibility` 模式——不激活桌面布局，避免与移动端适配叠加。
 *
 * @deprecated 不要再注入（issue #76，DSH Desktop 2.0.3 起）：
 *   ① mode 与 platform **同时缺失**时，parseDesktopClientEnvironment 直接返回 undefined
 *      （视作非桌面外壳，跳过全部桌面逻辑），正是手机/浏览器页面需要的效果；
 *   ② 只要 URL 上出现任一 dsh-desktop-* 标记，客户端就强制校验整组（material +
 *      semver version + mica），只补两个必然抛 "invalid or missing
 *      dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
 *   ③ 更糟：decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
 *      普通浏览器判为 denied（403），刷新后直接打不开。
 * lib/index.js 已不再注入本脚本；保留导出仅为兼容旧版本桌面端与既有测试。
 */
export function desktopEnvPatchScript(platform) {
  const p = ['darwin', 'win32', 'linux'].includes(platform) ? platform : 'linux';
  return `<script data-dsh-pocket-desktop-patch="1">!function(){try{var s=new URLSearchParams(location.search);if(!s.has('dsh-desktop-mode')||!s.has('dsh-desktop-platform')){s.set('dsh-desktop-mode','compatibility');s.set('dsh-desktop-platform','${p}');var u=new URL(location.href);u.search=s.toString();history.replaceState(null,'',u);}}catch(e){}}();</script>`;
}

/** 上游响应是否压缩过（压缩流不能做文本注入，会损坏页面）。 */
function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/**
 * 内容哈希资产（/assets/<name>-<hash>.<ext>）：文件名带内容哈希，内容变则文件名变，
 * 可安全长缓存。上游只发 max-age=14400（4h），手机端每过几小时就重新协商/重下。
 */
export const HASHED_ASSET_RE = /^\/assets\/[^/]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** Service Worker 脚本路由（issue 慢加载）——独立直发，不进上游代理。 */
export const SW_SCRIPT_PATH = '/dsh-pocket-sw.js';

/**
 * 静态资源 Service Worker（issue 慢加载）：只缓存「内容寻址」的不可变资源——
 * combo（/plugins/??…&rev=<hash>）与哈希资产（/assets/<name>-<hash>.<ext>）。
 * 其余请求（HTML/API/WebSocket）一律不拦截；命中缓存即免网络，重复打开秒开。
 * 改动缓存语义时递增 CACHE 版本号以丢弃旧条目。
 */
export const SW_SCRIPT = `// dsh-pocket static cache worker (issue: slow mobile load)
var CACHE = 'dshp-static-v1';
var MAX_ENTRIES = 18;
function isImmutable(u) {
  try {
    var x = new URL(u);
    if (x.origin !== self.location.origin) return false;
    if (x.pathname.indexOf('/assets/') === 0 && /-[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9]+$/.test(x.pathname)) return true;
    return x.pathname.indexOf('/plugins/') === 0 && /[?&]rev=[0-9a-f]{6,}/.test(x.search);
  } catch (e) { return false; }
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || !isImmutable(req.url)) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        // Fetch 规范不向脚本暴露 set-cookie，此守卫为防御性保留；
        // 真正的缓存边界是上面的 isImmutable URL 白名单。
        if (!res || !res.ok || res.headers.get('set-cookie')) return res;
        // fetch() 已解码 body，但 headers 仍带 content-encoding——入库前必须摘掉
        // （并摘 content-length），否则缓存命中时浏览器会拿解码后的字节再解一次。
        var clean = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
        clean.headers.delete('content-encoding');
        clean.headers.delete('content-length');
        return cache.put(req, clean.clone()).catch(function () {}).then(function () {
          return cache.keys();
        }).then(function (keys) {
          // 按插入序 FIFO 淘汰最旧的条目——match 不会提升条目位置，不是 LRU
          var stale = keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES));
          return Promise.all(stale.map(function (k) { return cache.delete(k); }));
        }).catch(function () {}).then(function () { return clean; });
      }).catch(function () {
        // 网络错误也给子资源一个明确状态（504），别让 respondWith 整体 reject
        return new Response('dsh-pocket: upstream unreachable', { status: 504, statusText: 'Gateway Timeout' });
      });
    });
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { return n === CACHE ? null : caches.delete(n); }));
  }));
});
`;

/** SW 注册片段（随 DEFAULT_INJECT 注入；非安全上下文无 navigator.serviceWorker 自动跳过）。 */
export const SW_REGISTER_SCRIPT = `<script data-dsh-pocket-sw-register="1">!function(){try{if('serviceWorker' in navigator){navigator.serviceWorker.register('${SW_SCRIPT_PATH}').catch(function(){})}}catch(e){}}();</script>`;

/**
 * 不可变资源 URL（与 SW_SCRIPT 的 isImmutable 同一白名单）：内容哈希资产
 * /assets/<name>-<hash>.<ext>，以及带 rev=<hash> 的插件组合包 /plugins/??…。
 * 内容变则 URL 变，所以这类响应可以放心长期缓存。
 */
function isImmutableUrl(rawUrl) {
  try {
    const x = new URL(String(rawUrl), 'http://dsh-pocket.invalid');
    if (x.pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(x.pathname)) return true;
    return x.pathname.startsWith('/plugins/') && /[?&]rev=[0-9a-f]{6,}/i.test(x.search);
  } catch {
    return false;
  }
}

/** RFC 7231 accept-encoding 的 q 值解析：缺省 q=1，q>0 才算支持（`br;q=0` 是明确排除）。 */
function acceptedCodings(header) {
  const q = new Map();
  for (const part of String(header ?? '').split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const [coding, ...params] = seg.split(';');
    let quality = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*(\d+(?:\.\d+)?)/i.exec(p);
      if (m) quality = Number(m[1]);
    }
    q.set(coding.trim().toLowerCase(), quality);
  }
  return { gzip: (q.get('gzip') ?? 0) > 0, br: (q.get('br') ?? 0) > 0 };
}

/**
 * 不可变资源的 brotli 转码结果缓存：每次冷加载都要重新 gunzip + brotli
 * （940KB 资产约 157ms 宿主 CPU，3.6MB 组合包约 0.5s），而内容变则 URL 变，
 * 缓存永不失效。缓存的是最终发给浏览器的字节（含 content-encoding）。
 * 上限 16 条 / 32MB，按最近使用淘汰（Map 插入序，命中后重插到队尾）。
 */
const IMMUTABLE_CACHE_MAX_ENTRIES = 16;
const IMMUTABLE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const immutableCache = new Map();
let immutableCacheBytes = 0;

function immutableCacheGet(url) {
  const hit = immutableCache.get(url);
  if (hit === undefined) return null;
  immutableCache.delete(url);
  immutableCache.set(url, hit);
  return hit;
}

function immutableCachePut(url, headers, body) {
  // 单条最多占四分之一池子，避免一个超大组合包把其余资源挤出去。
  if (body.length === 0 || body.length > IMMUTABLE_CACHE_MAX_BYTES / 4) return;
  const keep = { 'content-length': String(body.length) };
  for (const name of ['content-type', 'content-encoding', 'cache-control', 'vary', 'last-modified']) {
    const value = headers[name];
    if (value !== undefined) keep[name] = value;
  }
  const previous = immutableCache.get(url);
  if (previous !== undefined) {
    immutableCacheBytes -= previous.body.length;
    immutableCache.delete(url);
  }
  immutableCache.set(url, { headers: keep, body });
  immutableCacheBytes += body.length;
  while (immutableCache.size > IMMUTABLE_CACHE_MAX_ENTRIES || immutableCacheBytes > IMMUTABLE_CACHE_MAX_BYTES) {
    const oldestKey = immutableCache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = immutableCache.get(oldestKey);
    immutableCache.delete(oldestKey);
    immutableCacheBytes -= evicted.body.length;
  }
}

/**
 * 默认注入到经代理的 HTML 文档里：crypto.randomUUID / AbortSignal.any polyfill
 * （非安全上下文必需）+ issue #96 的 transport.createApiClient 兜底
 * + 静态资源 SW 注册（issue 慢加载，重复打开免重下 combo）。
 */
// session/list 瘦身（issue：公网加载慢 / 对话加载不出来）：
// 会话列表一次返回全部会话的全部投影值——1826 个会话实测 40.5MB JSON（压缩后
// 7MB），手机隧道单次要 2 分钟，页面加载期还被反复调用，会话树全程为空。
// 体积集中在少数胖投影（实测占比）：contextHeaders 12MB、retrace/forkmap 8.7MB、
// turnOutline 6.6MB、retrace/versions 3.5MB、watcherInsights 2MB，合计 ≈33MB。
// 这些字段的读取方都在面板类 UI（上下文面板 / retrace 面板 / watcher 面板），
// 主会话树只读 title/goal/tokenUsage 等小字段；turnOutline 的轨道导航有空值
// 降级（stable empty array），已开会话可经 session/projections 取精确值。
// 所以在代理层剥掉它们（只影响 pocket 公网通道，桌面 Electron 直连不动）。
// 短 TTL 缓存：页面加载期同一列表被连打 7+ 次，缓存把 7 次 40MB 解析坍缩成 1 次。
const SESSION_LIST_SLIM_RE = /\/api\/session\/list$/;
const SESSION_LIST_SLIM_KEYS = ['contextHeaders', 'retrace/forkmap', 'retrace/versions', 'watcherInsights', 'turnOutline'];
const SESSION_LIST_CACHE_TTL_MS = 2_000;
// 缓存键带请求体摘要（见 handleClientRequest 里的 wantsSlimBody）：不同 payload 的
// 列表请求必须各走各的缓存。超过这个体积（正常几百字节）只透传不缓存，避免为了
// 算摘要把异常大的请求体整块攒在内存里。
const SESSION_LIST_BODY_MAX = 1 << 20;
// 会话列表响应同样有上限：瘦身要先把整包读进内存、解压、JSON.parse，再重新压缩。
// 没有上限时一个异常胖的列表（或恶意放大的响应）能把代理内存顶到几百 MB，
// 且 parse 是同步的、会卡住所有 WS 心跳。超过上限就放弃瘦身，交给下面的
// 流式压缩分支原样转发——宁可慢一点，也不能让一个请求拖垮整个宿主。
const SESSION_LIST_SLIM_MAX = 64 * 1024 * 1024;

/**
 * 瘦身并返回可缓存的响应对象。命中缓存时会把 `rpcId` 就地改成当前请求的，
 * 所以键序与原响应一致，客户端按对象解析不受影响。
 */
function slimSessionListValue(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const items = obj?.result?.value?.items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const values = item?.projections?.values;
    if (values && typeof values === 'object') {
      for (const key of SESSION_LIST_SLIM_KEYS) delete values[key];
    }
  }
  return obj;
}

// 缓存（只服务 session/list）：键是「路径 + 请求体去 rpcId 后的摘要 + 编码族」。
// 条目里存的是剥离 rpcId 的对象，命中时按当前请求的 rpcId 重新出包。
// 有预算上限：列表瘦身后仍有数 MB，无限堆会把宿主内存吃掉。
const sessionListCache = new Map();
const SESSION_LIST_CACHE_ENTRIES = 8;
const SESSION_LIST_CACHE_BYTES = 24 * 1024 * 1024;

function sessionListCacheBytes() {
  let total = 0;
  for (const entry of sessionListCache.values()) total += entry.bytes ?? 0;
  return total;
}

function sessionListCacheGet(key) {
  const hit = sessionListCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { sessionListCache.delete(key); return null; }
  return hit;
}

/** 写入前先淘汰：过期条目 → 超出条数/字节预算的最旧条目。 */
function sessionListCacheSet(key, entry) {
  sessionListCache.delete(key);
  sessionListCache.set(key, entry);
  for (const [k, v] of sessionListCache) {
    if (Date.now() > v.expiresAt) sessionListCache.delete(k);
  }
  while (sessionListCache.size > SESSION_LIST_CACHE_ENTRIES) {
    sessionListCache.delete(sessionListCache.keys().next().value);
  }
  while (sessionListCacheBytes() > SESSION_LIST_CACHE_BYTES && sessionListCache.size > 1) {
    sessionListCache.delete(sessionListCache.keys().next().value);
  }
}

export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM + SW_REGISTER_SCRIPT;

/**
 * DSH Desktop advanced 模式不支持的提示覆盖层（issue #19）。
 * advanced 组合会禁用网页版 ui-layout，而桌面 layout 只在 advanced client 提供——
 * 手机页面被注入 compatibility 后无任何 layout 服务 → 启动白屏（Failed to load plugins）。
 * 该脚本在页面上叠加一个固定警告层，让用户明确知道原因（而不是无解白屏）。
 */
export function advancedNoticeScript() {
  return `<script data-dsh-pocket-advanced-notice="1">!function(){try{var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);color:#fff;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px';d.textContent='DSH 桌面端处于 advanced 模式，手机访问暂不支持。请在桌面端设置中切回 compatibility 模式后重启。| DSH Desktop is in advanced mode — phone access is not supported yet. Switch back to compatibility in the desktop app and restart.';document.documentElement.appendChild(d);}catch(e){}}();</script>`;
}

// ---------- 可选访问令牌认证（issue #13 + #33） ----------
// 只对受保护 Host（公网隧道 + 局域网按开关）强制。
// 登录成功后种 HttpOnly 持久 cookie（Max-Age 30 天）→ SPA 内部 API/WS 自动携带。
// 会话保持（issue #33）：cookie 值 = sha256(PIN:sessionKey)——sessionKey 是 dsh web
// 进程级随机密钥（lib/index.js 每次启动生成）。于是：
//   - 电脑 dsh web 一直开着 → 手机输一次密码后长期免输（持久 cookie）
//   - dsh web 重启/更新 → sessionKey 变化 → 旧 cookie 失效 → 手机重新输入
const TOKEN_COOKIE = 'dsh_pocket_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

/** cookie 校验值：有 sessionKey 时派生，无则退化为 PIN 本身（向后兼容）。 */
function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash('sha256').update(`${token}:${sessionKey}`).digest('hex');
}

// ---------- 登录速率限制（issue #40，改进版方案 A） ----------
// 8 位数字密码（10^8 组合）本身可接受，真正风险是「无限制重试」让穷举可行。
// 这里做三层防护（内存态，随进程生命周期，与 sessionKey 一致）：
//   1) 单 IP 滑动窗口：60 秒内失败 ≥5 次 → 锁 60 秒（429）
//   2) 全局滑动窗口：1 分钟全局失败 > 50 次 → 全局锁 30 秒（防分布式扫描换 IP 绕过）
//   3) 成功登录清空该 IP 计数
// IP 识别：优先 cf-connecting-ip（Cloudflare 在隧道入口设置的**真实**客户端 IP，
// 可信）；无则回退 socket remoteAddress。**不信任客户端 x-forwarded-for**（可伪造）。
export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,      // 失败计数滑动窗口
  maxFailures: 5,        // 窗口内失败阈值 → 触发单 IP 锁
  lockMs: 60_000,        // 单 IP 锁定时长
  globalMaxFailures: 50, // 全局失败阈值（同窗口）→ 触发全局锁
  globalLockMs: 30_000,  // 全局锁定时长
};
function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = new Map(); // ip -> { count, windowStart }
  const ipLocks = new Map();    // ip -> lockedUntil
  const trustedIps = new Map(); // ip -> 最近一次成功登录时间（全局锁的豁免名单）
  const TRUST_TTL_MS = 24 * 60 * 60 * 1000;
  const isTrusted = (ip, now) => {
    const at = trustedIps.get(ip) ?? 0;
    if (at === 0) return false;
    if (now - at > TRUST_TTL_MS) { trustedIps.delete(ip); return false; }
    return true;
  };
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  // 全局锁期间的比对预算（见 allowCompare）；与锁无关地放在闭包里，跨调用复用。
  const COMPARE_BURST = 10;
  const COMPARE_REFILL_MS = 100;
  let compareTokens = COMPARE_BURST;
  let compareRefillAt = Date.now();
  return {
    /** 该 IP 当前是否被锁；返回 { locked, retryAfter, scope }。
     *  scope='ip'：本 IP 自己失败太多次，严格拒绝（连正确密码也不收，否则单 IP 可无限猜）；
     *  scope='global'：全局阈值被分布式流量打满。**只拦「继续猜」**——调用方仍应校验密码，
     *  正确凭据必须放行。否则任何人 22ms 刷 50 次坏 PIN 就能把所有没 cookie 的设备
     *  （新手机、清过缓存的浏览器、机主自己）永久锁在 429 外面，防穷举变成拒绝服务。 */
    status(ip) {
      const now = Date.now();
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000), scope: 'ip' };
      if (global.lockedUntil > now && !isTrusted(ip, now)) {
        // 全局锁豁免「成功登录过的来源」：已登录设备不再被连坐。
        return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000), scope: 'global' };
      }
      return { locked: false, retryAfter: 0, scope: null };
    },
    /** 全局锁期间的密码比对预算（全局限速桶）。
     * 只返回 429 不阻止比对的话，攻击者一旦触发全局锁就能以网络速度无限猜——
     * 每次猜测仍被 safeEqual 比较，猜中即 200。给比对加一个全局限速（突发 10 次、
     * 每 100ms 回 1 个）既保留「正确的密码仍能登录」（机主重试几次即可），又把
     * 猜测吞吐压到 ~10 次/秒（8 位 PIN 的期望穷举时间从小时级拉到百天级）。
     * 非全局锁（正常使用）时永远放行，不引入任何额外延迟或失败。 */
    allowCompare(ip) {
      const now = Date.now();
      const locked = global.lockedUntil > now && !isTrusted(ip, now);
      if (!locked) return true;
      if (now - compareRefillAt >= COMPARE_REFILL_MS) {
        const periods = Math.floor((now - compareRefillAt) / COMPARE_REFILL_MS);
        compareTokens = Math.min(COMPARE_BURST, compareTokens + periods);
        compareRefillAt += periods * COMPARE_REFILL_MS;
      }
      if (compareTokens <= 0) return false;
      compareTokens--;
      return true;
    },
    /** 记一次失败：固定窗口计数（窗口起点不随请求滑动，窗口内累计达阈值才触发），达阈值触发单 IP / 全局锁。 */
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) { global.count = 0; global.windowStart = now; }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      // 防内存膨胀：超过 2000 条记录时清掉已过窗口期的条目
      if (failCounts.size > 2000) {
        for (const [k, v] of failCounts) {
          if (now - v.windowStart > c.windowMs) failCounts.delete(k);
        }
      }
      // 同上：锁表也要防膨胀，超过 2000 条时清掉已过期的锁
      if (ipLocks.size > 2000) {
        for (const [k, v] of ipLocks) {
          if (v <= now) ipLocks.delete(k);
        }
      }
    },
    /** 成功登录：清空该 IP 计数与锁，并记为可信来源（全局锁豁免）。 */
    clear(ip) {
      failCounts.delete(ip);
      ipLocks.delete(ip);
      trustedIps.set(ip, Date.now());
      if (trustedIps.size > 500) {
        const now = Date.now();
        for (const [k, v] of trustedIps) if (now - v > TRUST_TTL_MS) trustedIps.delete(k);
        while (trustedIps.size > 500) trustedIps.delete(trustedIps.keys().next().value);
      }
    },
  };
}
/**
 * 客户端真实 IP（限速与握手计数的身份键）：
 *   - 来自本机（cloudflared 隧道回连，源地址 loopback）→ 认 cf-connecting-ip（Cloudflare 边缘写的真实客户端 IP）；
 *   - 其余一律用 socket 源地址。
 *
 * 为什么不能无条件信任 cf-connecting-ip：那是**请求头**，能直连代理端口的人可以随手
 * 伪造。隧道流量必经本机 cloudflared（源地址必为 loopback），所以把它限定在 loopback
 * 来源既不影响隧道场景，又让「换头即换身份」的限速绕过失效。XFF 同理，始终不认。
 */
export function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  if (classifySource(addr) === 'loopback') {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (cf) return cf;
  }
  return addr || 'unknown';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 登录页：按访问来源显示提示（局域网 / 公网）。
 * credentialKind: 'persistent'（可长期复用）|'ephemeral'（短期轮换，不建议保存）。
 * error: false|true|'locked'（locked 带剩余秒数）。
 */
function loginPageHtml(error, isPublic, retryAfter = 0, credentialKind = 'ephemeral') {
  const where = isPublic ? '此公网地址' : '此局域网地址';
  const whereEn = isPublic ? 'This public address' : 'This LAN address';
  const autocomplete = credentialKind === 'persistent' ? 'current-password' : 'off';
  const usernameField = credentialKind === 'persistent'
    ? '<input class="implicit-username" id="pocket-username" name="username" type="text" autocomplete="username" value="dsh-pocket" tabindex="-1" aria-hidden="true" readonly>'
    : '';
  const errMsg = error === 'locked'
    ? `尝试次数过多，请 ${retryAfter} 秒后再试 | Too many attempts — try again in ${retryAfter}s`
    : error ? '密码错误，请重试 | Wrong PIN, try again' : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 访问验证</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
label.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.implicit-username{display:none}
.pin-field{position:relative;margin-bottom:12px}
input{width:100%;box-sizing:border-box;padding:10px 50px;font-size:18px;line-height:24px;letter-spacing:6px;text-align:center;caret-color:#4f6ef7;border:1px solid #d1d5db;border-radius:8px;outline:none}
input::-ms-reveal,input::-ms-clear{display:none}
input:focus{border-color:#4f6ef7;box-shadow:0 0 0 1px #4f6ef7}
.pin-toggle{position:absolute;right:2px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;background:transparent;color:#6b7280;border:0;border-radius:6px;cursor:pointer}
.pin-toggle:hover{color:#374151;background:#f3f4f6}
.pin-toggle:focus-visible{outline:2px solid #4f6ef7;outline-offset:1px}
.pin-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.pin-toggle .is-hidden{display:none}
.enter-button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>🔐 DSH Pocket</h1>
<p>${where}受访问密码保护，请输入访问密码 | ${whereEn} is password-protected — enter the access PIN</p>
<div class="err">${errMsg}</div>
<form method="post" action="/pocket-login">
${usernameField}
<label class="sr-only" for="current-password">访问密码 | Access PIN</label>
<div class="pin-field">
<input id="current-password" name="token" type="password" minlength="8" maxlength="64" autocomplete="${autocomplete}" autocapitalize="none" spellcheck="false" autofocus required>
<button id="toggle-password" class="pin-toggle" type="button" aria-controls="current-password" aria-pressed="false" aria-label="显示访问密码 | Show access PIN" title="显示密码 | Show password">
<svg id="eye-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path id="eye-slash" d="M3 3l18 18"/></svg>
</button>
</div>
<button class="enter-button" type="submit">进入 | Enter</button>
</form>
<script>
const pinInput=document.getElementById('current-password');
const pinToggle=document.getElementById('toggle-password');
const eyeSlash=document.getElementById('eye-slash');
// 指针点击眼睛时不抢走输入框焦点；键盘 Tab 到按钮时仍保留原生按钮行为。
pinToggle.addEventListener('pointerdown',(event)=>event.preventDefault());
pinToggle.addEventListener('click',()=>{
  const show=pinInput.type==='password';
  const hadFocus=document.activeElement===pinInput;
  const start=pinInput.selectionStart;
  const end=pinInput.selectionEnd;
  pinInput.type=show?'text':'password';
  // 图标表达当前状态：有斜线 = 密码隐藏；无斜线 = 密码可见。
  eyeSlash.classList.toggle('is-hidden',show);
  pinToggle.setAttribute('aria-pressed',String(show));
  pinToggle.setAttribute('aria-label',show?'隐藏访问密码 | Hide access PIN':'显示访问密码 | Show access PIN');
  pinToggle.title=show?'隐藏密码 | Hide password':'显示密码 | Show password';
  if(hadFocus&&start!==null&&end!==null) pinInput.setSelectionRange(start,end);
});
</script>
</div></body></html>`;
}

/**
 * 取出 Host 里的主机名：去端口、去 IPv6 方括号、去 FQDN 尾点、小写。
 * classifyHost / isLoopbackHost 必须用同一套归一化，否则会出现「一个说是本机、
 * 另一个说不是」的分裂判定（审计实测 `127.0.0.1.`、`127.evil.com`、`[2001:db8::1]`
 * 两种函数给出相反结论）。
 */
function hostNameOnly(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end); // [::1]:3081 → ::1
  } else {
    // 只有「恰好一个冒号且后面是纯数字」才是 host:port。裸 IPv6（≥2 个冒号）
    // 不能按端口切——`::1` 会被切出一个孤零零的 ':'，再被当成非 IP 主机名。
    const parts = name.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) name = parts[0];
  }
  return name.replace(/\.+$/, ''); // 127.0.0.1. / localhost. → 去尾点
}

/**
 * Host 信任边界分类（issue #66：fail closed）。
 *
 * 旧逻辑只认 `*.trycloudflare.com` 后缀为公网，其余一律当局域网——用户自建
 * 命名隧道/反向代理指向本机端口时，固定域名被误判成局域网；若局域网密码又
 * 关着，公网入口就无密码裸奔。现在反转为 fail closed：
 *   - loopback：localhost / 127.x / ::1 / 0.0.0.0（本机与 cloudflared 回连）
 *   - lan：RFC1918 私网 IPv4、CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，
 *     公网不可路由）、IPv6 ULA/link-local、`.local`（mDNS）、无点单标签名（NetBIOS 计算机名等）
 *   - public：其余一切 Host（trycloudflare 或任何陌生域名）→ 强制公网密码
 *
 * @returns {'loopback'|'lan'|'public'}
 */
export function classifyHost(host) {
  let name = hostNameOnly(host);
  // IPv4-mapped IPv6（`::ffff:127.0.0.1`）是双栈环境下可能出现的本机字面量：按嵌入的
  // IPv4 规则分类，否则会被当成陌生域名、要求公网密码（审计 F6）。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(name);
  if (mapped) name = mapped[1];
  if (name === '') return 'loopback'; // 无 Host（HTTP/1.0/畸形）→ 历史行为，当本机
  if (name === 'localhost' || name === '0.0.0.0') return 'loopback';
  const ipVersion = isIP(name);
  if (ipVersion === 4) {
    if (/^127\./.test(name)) return 'loopback';
    // RFC1918 私网 + CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，公网不可路由）
    if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(name)) return 'lan';
    return 'public';
  }
  if (ipVersion === 6) {
    if (name === '::1') return 'loopback';
    if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(name)) return 'lan'; // IPv6 link-local / ULA
    return 'public';
  }
  // 非 IP 字面量：只有 localhost / 单标签名 / .local 是局域网；带点的域名一律 public。
  // 旧实现用 `/^127\./` 直接匹配字符串，`127.evil.com` 这种可注册域名会被判成本机
  // （配合 DNS rebinding 等于零认证入口）；`127.0.0.1.` 带尾点也与字面量不一致。
  if (name.endsWith('.local') || !name.includes('.')) return 'lan';
  return 'public';
}

/** 该 Host 是否受访问密码保护（公网一律要密码；局域网/本机按设置页开关）。 */
function isProtectedHost(host, isProtected) {
  return isProtected ? isProtected(host) : classifyHost(host) === 'public';
}

/** 保护强度序：本机最弱（可免密）→ 局域网（按开关）→ 公网（永远要密码）。 */
const HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };

/**
 * 按 TCP 源地址给出来源类别（issue #90）。
 * 与 classifyHost 的区别在**兜底方向**：Host 头里认不出的形态按 loopback 处理
 * （历史行为，避免裸 IPv6 之类把本机访问判成公网）；而源地址认不出时必须按
 * public 处理——源地址是我们唯一不可伪造的信息，兜底方向错了整条防线就白搭。
 * @returns {'loopback'|'lan'|'public'|null} null 表示拿不到源地址（不做任何收紧）
 */
export function classifySource(addr) {
  let a = String(addr ?? '').trim().toLowerCase();
  if (!a) return null;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6（Node 双栈监听时常见）
  if (a === '::1' || /^127\./.test(a)) return 'loopback';
  // RFC1918 私网 + CGNAT 100.64/10（与 classifyHost 保持同一套网段判定）
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/.test(a)) return 'lan';
  if (/^169\.254\./.test(a)) return 'lan';            // IPv4 link-local
  if (/^(?:fe80:|f[cd][0-9a-f]{2}:)/.test(a)) return 'lan'; // IPv6 link-local / ULA
  return 'public';
}

/**
 * 请求是否经隧道 / 本地反代进来（源是 loopback 但实际来自外部）。
 *
 * cloudflared 以 `http://127.0.0.1:<port>` 回连本机代理，所以「TCP 源是 loopback」
 * 对隧道流量同样成立；可靠区分是边缘/反代注入、客户端直连时伪造无收益的头：
 * - `cf-connecting-ip` / `cf-ray`：Cloudflare 边缘注入；
 * - `x-forwarded-for` / `x-real-ip` / `forwarded`：nginx/traefik/Caddy 等反代默认注入。
 * 命名隧道的 ingress 若配了 httpHostHeader（或前面还有一层把 Host 改写成
 * 127.0.0.1 的反代），Host 会被判成 loopback/lan，从而把公网入口降级成免密本机。
 * 直接连代理的 LAN/公网客户端即使自带这些头也不会被当成隧道——这一判定还要求
 * TCP 源是 loopback，只有本机进程才满足。
 */
function isCloudflareTunnelRequest(req) {
  if (classifySource(req?.socket?.remoteAddress) !== 'loopback') return false;
  const h = req?.headers ?? {};
  return Boolean(h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['x-real-ip'] || h.forwarded);
}

/** 隧道流量在策略判定里统一用这个不可路由的占位域名（classifyHost → public）。 */
const TUNNEL_POLICY_HOST = 'cloudflare-tunnel.invalid';

/**
 * 用于策略判定的 Host（issue #90 第 7 条）。
 *
 * Host 头完全由客户端控制：能直连代理端口的人只要写 `Host: 127.0.0.1:3081`
 * 就会被 classifyHost 判成本机，从而绕过局域网开关和局域网密码——用户若按
 * README 关掉了局域网密码，这就是一条零认证通道。TCP 源地址无法伪造，用它给
 * Host 声明设一个下限。
 *
 * **只收紧、绝不放松**：经 cloudflared 隧道进来的公网请求源地址正是 127.0.0.1，
 * 若按源地址覆盖就会把公网访问降级成本机免密，比原来的问题更严重。所以仅当
 * 声明的保护级别**低于**来源真实级别时，才改用源地址参与判定。
 */
export function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  // 用真实源地址替代被伪造的 Host 参与后续全部策略判定（密码归属、局域网开关、
  // 局域网地址覆盖），保证各处判定看到的是同一个来源。
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  return addr;
}

/**
 * 该 Host 是否 loopback（本机 / cloudflared 回环）。
 * 「关闭局域网」只拦截经局域网 IP/主机名访问的请求，loopback 与公网（trycloudflare）放行：
 *   - cloudflared 隧道以 `http://127.0.0.1:<port>` 回连本机代理，必须放行；
 *   - 电脑自己访问 127.0.0.1/localhost 也应放行（仅当用户手动浏览本代理时）。
 */
function isLoopbackHost(host) {
  const name = hostNameOnly(host);
  if (name === 'localhost' || name === '::1' || name === '0.0.0.0') return true;
  // 127.0.0.0/8 整段都是 loopback。必须与 classifyHost 的判定一致（那边也认整段），
  // 否则关掉局域网访问后，经 127.0.0.2 这类地址访问本机代理会被误判成「局域网」而 403。
  return isIP(name) === 4 && /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** 局域网访问已关闭时的提示页（浏览器导航时显示；API/WS 返回 403 JSON/拒绝握手）。 */
function lanDisabledPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 局域网访问已关闭</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:360px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0;line-height:1.6}
</style></head><body><div class="card">
<h1>🔒 DSH Pocket</h1>
<p>局域网访问已关闭，扫码/链接均不可用。<br>请在电脑上重新开启后再试。<br><br>LAN access is disabled — the QR code and link are unavailable.<br>Re-enable it on the computer to continue.</p>
</div></body></html>`;
}

/** 桌面端浏览器访问门禁提示页（issue #81）：DSH Desktop 未开启「浏览器访问」时，
 * 上游 desktop-browser-access 门禁对普通浏览器（含经本代理转发的手机）返回 403
 * `forbidden`，且本代理无法携带 Electron renderer secret 绕过。对符合该特征的
 * 浏览器导航请求返回此可操作提示页；API/WS 与其余 403 原样透传。 */
function desktopAccessBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 桌面端未开启浏览器访问</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:392px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 8px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 12px;line-height:1.6}
code{background:#f3f4f6;padding:2px 6px;border-radius:6px;font-size:12px;color:#374151}
.step{text-align:left;background:#f9fafb;border:1px solid #eef2f7;border-radius:10px;padding:12px 14px;margin-top:8px;font-size:12px;color:#4b5563;line-height:1.8}
</style></head><body><div class="card">
<h1>🖥️ DSH Pocket</h1>
<p>你已通过访问密码，但页面仍被拦截。<br>因为本机 DSH Desktop 未开启「浏览器访问」，桌面门禁拒绝了普通浏览器（含手机）的页面请求。</p>
<div class="step">
<strong>解决方法（任选其一）：</strong><br>
1. DSH Desktop → 设置 → 窗口 / 模式 → 开启「浏览器访问」（自动切到 compatibility 模式）→ <strong>重启 DSH Desktop</strong>。<br>
2. 或在配置文件中设置：<br>
<code>dsh-desktop: { mode: compatibility, openBrowser: true }</code><br>
然后重启 DSH Desktop，再刷新本页。
</div>
<p style="margin-top:14px">注意：访问密码登录成功 ≠ 已获得桌面 Web 访问授权。门禁由 DSH Desktop 控制，pocket 无法代为绕过。</p>
<p style="color:#9ca3af">The host DSH Desktop has "browser access" disabled. Enable it (Settings → window/mode → browser access → restart), or set <code>dsh-desktop.mode: compatibility, openBrowser: true</code>, then refresh.</p>
</div></body></html>`;
}

/** 请求是否期望 HTML（浏览器导航 → 返回登录页；API/WS → 401）。 */
function isHtmlRequest(req) {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('text/html')) return true;
  const url = String(req.url ?? '');
  // 按 pathname 判断，别用 `url === '/'` 严格比 —— 根路径常带 query
  // （`/?dsh-pocket-auth=1`、`/?dsh-pocket-retry=1`、`/?token=…`），
  // 那些同样是浏览器导航，漏判会让它们拿到 401/303 而不是该给的页面。
  let pathname = url;
  try { pathname = new URL(url || '/', 'http://dsh.invalid').pathname; } catch { /* 用原值兜底 */ }
  return pathname === '/' || /\.html?$/i.test(pathname);
}

/**
 * 常量时间的密码比较（issue #90）：普通 `===` 会在首个不同字节处提前返回，
 * 理论上可被计时侧信道逐字节还原 PIN。长度不同直接判否（PIN 长度固定，
 * 长度本身不是秘密），等长则走 timingSafeEqual。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 参数名是否是访问密码参数。HTTP 查询参数名按规范大小写敏感，但 `?TOKEN=` 这种
 * 写法会绕过「只认小写 token」的清理逻辑（上游请求行/Referer 仍带明文 PIN），
 * 所以访问密码相关的判定统一按小写比较。
 */
function isTokenParamName(name) {
  return String(name ?? '').toLowerCase() === 'token';
}

/**
 * 值是否命中某个访问密码。除精确相等外，还容忍 `;` 后缀：`?token=<PIN>;foo=1`
 * 这类写法在部分客户端/中间件里会被当成一个带 `;` 的值，不认就等于明文 PIN 继续转发。
 * PIN 只含字母数字（PIN_RE），所以 `;` 之后不可能是 PIN 本身的一部分。
 */
function tokenValueMatches(value, acceptedTokens) {
  const v = String(value ?? '');
  return acceptedTokens.some((token) => {
    if (!token) return false;
    if (safeEqual(v, token)) return true;
    return v.length > token.length && v.startsWith(token) && v[token.length] === ';';
  });
}

/** 删掉 URLSearchParams 里所有大小写形式的 `token` 参数（用于 Referer 清理）。 */
function deleteTokenParams(params) {
  for (const key of [...params.keys()]) {
    if (isTokenParamName(key)) params.delete(key);
  }
}

/**
 * 请求是否携带 `?token=` —— 用于区分「一次密码尝试」与「普通未认证访问」（issue #90）。
 * 只有前者计入限速失败：普通未认证访问（无 cookie 无 token）本来就该看到登录页，
 * 若也计数，正常用户第一次打开页面就会把自己锁死（子资源还会放大）。
 * cookie 不匹配同样不计数——cookie 值是 sha256(PIN:sessionKey)，攻击者不知道
 * 进程级 sessionKey，这条通道本身不可穷举；而 dsh web 重启后旧 cookie 必然失配，
 * 计数只会误锁老用户。
 */
function hasQueryToken(req) {
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    for (const [key, value] of u.searchParams) {
      // 空值（`?token` / `?token=`）不算一次密码尝试：扫描器、被截断的分享链接、
      // 浏览器预取都可能产生它，按失败计数会把共享出口 IP 白白锁 60s（审计实测）。
      if (isTokenParamName(key) && value.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 校验请求是否已认证。返回 { ok, rawQueryToken }：
 *  - ok=true：已认证；rawQueryToken 是 URL `?token=<PIN>` 命中的那条原始密码（用于种 cookie）；
 *  - 已有 cookie 命中 → rawQueryToken=null（不要重复种）。 */
function authCheck(req, tokens, sessionKey) {
  const list = (Array.isArray(tokens) ? tokens : tokens ? [tokens] : []).filter(Boolean);
  if (list.length === 0) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok) {
    for (const token of list) {
      if (safeEqual(cookieTok, cookieFor(token, sessionKey))) return { ok: true, rawQueryToken: null };
    }
  }
  // 畸形请求目标（端口越界、非法绝对形式）会让 URL 解析直接抛错——按无 query
  // token 处理：cookie / 未认证路径照常走，不为畸形输入改变行为面。
  try {
    const u = new URL(req.url ?? '/', 'http://x');
    for (const [key, value] of u.searchParams) {
      if (!isTokenParamName(key)) continue;
      for (const token of list) {
        if (safeEqual(value, token) || (value.length > token.length && value.startsWith(token) && value[token.length] === ';')) {
          // URL `?token=<原始 PIN>` 用于分享/扫码直达：用户拿到 URL 就能直输明文 PIN，
          // 不需要把 sha256 哈希也告诉他们。匹配上后由调用方通过 maybeSeedAuthCookie
          // 种 HttpOnly 哈希 cookie，让浏览器后续子资源（assets/*.js 等）也走 cookie
          // 路径——避免「主页 200 但子资源 401」白屏（issue #35）。
          // rawQueryToken 固定回报 PIN 本身（而非 `PIN;...`），cookie 要对得上。
          return { ok: true, rawQueryToken: token };
        }
      }
    }
  } catch { /* 视为无 token */ }
  return { ok: false, rawQueryToken: null };
}

/** 当请求通过 `?token=<原始 PIN>` 进入时，在响应里种 HttpOnly cookie。
 *  monkey-patch res.writeHead 把 set-cookie 头注入到第一个响应里——同 POST /pocket-login
 *  路径（lib/proxy.mjs 显式 res.writeHead 加 set-cookie）效果一致。 */
function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  const expected = cookieFor(rawToken, sessionKey);
  if (!expected) return;
  // 只在「现有 cookie 与本次应得的值一致」时跳过。老实现看到有 cookie 就返回：
  // dsh web 重启后 sessionKey 变了，浏览器留着上一进程的失效 cookie，于是每次
  // 带 ?token= 进来都不换发 → 页面壳能过、子资源全 401，用户只能手清 cookie。
  const existing = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
  if (existing !== undefined && safeEqual(existing, expected)) return;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, statusMessage, headers) {
    // writeHead 有两种签名：(code, headers) 与 (code, statusMessage, headers)。
    // 只按两参处理会把状态文本当 headers 展开，弄丢状态行并注入一串单字符键。
    const hasMessage = typeof statusMessage === 'string';
    const h = { ...((hasMessage ? headers : statusMessage) ?? {}) };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    // 已有 set-cookie 头（数组/字符串都支持）则追加
    const prev = h['set-cookie'];
    if (Array.isArray(prev)) h['set-cookie'] = [...prev, cookie];
    else if (typeof prev === 'string') h['set-cookie'] = [prev, cookie];
    else h['set-cookie'] = cookie;
    return hasMessage ? origWriteHead(statusCode, statusMessage, h) : origWriteHead(statusCode, h);
  };
}

/**
 * 把浏览器可见的权威改写成 loopback 权威。
 * 除 Host/Origin 外，还必须规范化 Referer 与 Sec-Fetch-Site：DSH 宿主的特权方法
 * 栅栏（settings.describe/credentials.* 等 PRIVILEGED_METHODS）会拒绝
 * sec-fetch-site === 'cross-site'，并校验 Origin 与 Host 匹配；远程访问的这两个头
 * 若不改写，设置/凭据平面会在宿主侧被 403（issue #58 的另一半）。
 * 统一小写化键名，避免 Node 原样转发时大小写键并存导致重复头。
 */
function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    // x-dsh-pocket-origin 由本代理按不可伪造的源地址重新写入（见 handleClientRequest），
    // 客户端自带的同名头一律丢弃，否则 LAN 客户端可以自称 loopback 拿到公网 PIN。
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'sec-fetch-site' || lk === POCKET_ORIGIN_HEADER) continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = 'http:';
      ref.host = authority;
      // 分享链接首屏地址是 `/?token=<PIN>`，浏览器给每个子资源都带这个 Referer。
      // 原样转发等于把明文 PIN 交给上游（dsh 日志/错误上报都会带上 Referer）。
      // 上游只校验 Origin/Host/sec-fetch-site，不读 Referer 里的 token，删掉无副作用。
      // 参数名大小写不敏感（`?TOKEN=` 同样要删）。
      deleteTokenParams(ref.searchParams);
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ---------- dsh web 浏览器会话 token（issue #77） ----------
// 新版 dsh web（>= 0.1.2-alpha.1）给浏览器会话加了启动 token：根路径 `GET /` 必须带一次
// `?token=<启动 token>` 换一个绑定 authority 的 cookie，之后 /api 与 WebSocket 才放行；
// 否则一律 401（"dsh web authentication required"）。手机扫码进来的 URL 天然没有这个
// token，所以代理要在转发时补一次。
//
// 只在 `GET /` 且请求还没带 dsh-auth-* cookie 时注入：上游拿到 token 会 303 回干净的根
// 路径，若每次都注入就会 303 循环（浏览器很快报"重定向次数过多"）。
const DSH_AUTH_COOKIE = 'dsh-auth-';
/**
 * 去掉 URL 上所有 `dsh-desktop-*` query 参数（issue #75）。
 *
 * dsh-pocket 在 ≤ 2.1.1 会用 `history.replaceState` 往页面 URL 上写
 * `dsh-desktop-mode=compatibility` 和 `dsh-desktop-platform=<系统>`
 * （desktopEnvPatchScript，已在 2.1.2 删除）。副作用是：用户当时收藏/保存过
 * 的那个地址**一直带着这两个参数**。升级之后我们不再注入了，但用户打开旧
 * 收藏时 URL 里仍然有 —— 上游 `decideDesktopBrowserAccess` 只要见到
 * `dsh-desktop-` 前缀就认定是渲染器请求，普通浏览器没有渲染器 token，直接
 * 403 forbidden。表现就是「我已经升到最新版了，还是 forbidden」。
 *
 * 脏参数是我们写进去的，就得由我们清掉。所有方法、所有路径都清理（不只是
 * `GET /`）——API 与 WebSocket 握手带上这些参数同样会被拦。
 *
 * @param {string} reqUrl - 原始请求路径（含 query）。
 * @returns {string} 清理后的路径；无该前缀参数或解析失败时原样返回。
 */
export function stripDesktopMarkers(reqUrl) {
  let u;
  try {
    u = new URL(reqUrl ?? '/', 'http://dsh.invalid');
  } catch {
    return reqUrl;
  }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith('dsh-desktop-'));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}

export function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  // 登录成功后跳回的 `/?dsh-pocket-auth=1`：强制重做一次握手（旧 cookie 可能已过期/被撤销）
  const force = u.searchParams.has('dsh-pocket-auth');
  if (!force && String(cookieHeader ?? '').includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set('token', launchToken);
  return `${u.pathname}${u.search}`;
}

// ---------- 会话握手重试计数（issue #91） ----------
// Safari（iOS/macOS）不持久化「http:// + 纯 IP 源」上由 3xx 响应下发的 cookie，
// 于是 dsh web 的 launch-token→cookie 握手永远收敛不了：代理每次 `GET /`
// 都补 `?token=`，上游每次 303 回 `/`，浏览器每次都不带 cookie → 无限重定向
// （Safari 报「发生了太多重定位」）。
//
// 两道防线：
//   1) 代理把这次 303 改写成 200 过渡页（Set-Cookie 照发 + meta refresh 跳回 `/`），
//      200 响应上的 cookie 不会被 Safari 的重定向 cookie 策略丢掉；
//   2) 万一 1) 也不管用，用下面的计数器在若干次尝试后停止注入 token 并给出
//      可操作提示页——宁可给用户一句人话，也不要无限转圈。
//
// 只按客户端 IP 计数（无需 cookie 支持，正适合「cookie 用不了」的这个场景）。
export const DEFAULT_HANDSHAKE_LIMIT = 3;
export const HANDSHAKE_WINDOW_MS = 60_000;
/** 提示页「重试」按钮用的查询参数：命中即清空该 IP 的失败计数，且不往上游透传。 */
export const HANDSHAKE_RETRY_PARAM = 'dsh-pocket-retry';

/** 摘掉某个查询参数后重新拼路径；解析失败或本来就没有则原样返回。 */
export function stripQueryParam(reqUrl, name) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (!u.searchParams.has(name)) return reqUrl;
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

/**
 * 从请求目标上摘掉「值等于某个已接受密码」的 `token` 参数。
 *
 * `?token=<PIN>` 是分享链接/扫码直达通道：匹配成功后 PIN 的唯一用途就是换 cookie，
 * 不该再出现在任何下游位置——转发给上游的请求行、代理访问日志、session/list 缓存
 * 键，乃至 dsh 自己的访问日志。旧实现种完 cookie 就原样转发，于是明文 PIN 会以
 * `GET /?token=1234abcd -> 200` 的形式落进日志（日志又常被贴进 issue/工单）。
 *
 * 只摘「值与 acceptedTokens 之一相同」的那一个，绝不盲删：`token` 同时也是 dsh web
 * 自己的浏览器会话启动参数名（issue #77），盲删会把上游握手打坏。
 */
function stripPocketToken(reqUrl, acceptedTokens) {
  if (!Array.isArray(acceptedTokens) || acceptedTokens.length === 0) return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  const entries = [...u.searchParams.entries()];
  if (!entries.some(([key]) => isTokenParamName(key))) return reqUrl;
  // 同名参数可能出现多次（`?token=<PIN>&token=<dsh 启动 token>`）。只摘掉「值命中访问
  // 密码」的那几个，其余原样保留：旧实现只看第一个值，若 PIN 在前会把启动 token 一起
  // 删掉（把上游握手打坏），若 PIN 在后则明文 PIN 继续原样转发（泄漏仍在）。
  // 参数名用大小写不敏感匹配：`?TOKEN=<PIN>` 同样要摘（审计实测大写形式会漏）。
  let changed = false;
  const kept = [];
  for (const [key, value] of entries) {
    if (isTokenParamName(key) && tokenValueMatches(value, acceptedTokens)) {
      changed = true;
      continue;
    }
    kept.push([key, value]);
  }
  if (!changed) return reqUrl;
  const params = new URLSearchParams();
  for (const [key, value] of kept) params.append(key, value);
  u.search = params.toString();
  return `${u.pathname}${u.search}`;
}

/** 日志用：抹掉 `?token=` 的值（保险绳——上游错误日志里仍可能带原始请求目标）。 */
function maskTokenForLog(reqUrl) {
  return String(reqUrl ?? '').replace(/([?&]token=)[^&#\s]*/gi, '$1***');
}

export function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  /** ip -> { count, start } */
  const hits = new Map();
  return {
    /** 记一次握手注入，返回窗口内的累计次数。 */
    record(ip, now = Date.now()) {
      const rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) {
        hits.set(ip, { count: 1, start: now });
        return 1;
      }
      rec.count += 1;
      return rec.count;
    },
    /** 握手成功（拿到会话 cookie 的请求）→ 清零。 */
    clear(ip) {
      hits.delete(ip);
    },
    /** 该 IP 是否已达重试上限。 */
    exhausted(ip) {
      const rec = hits.get(ip);
      return !!rec && rec.count >= max;
    },
    /** 清理过期条目，防长期运行内存膨胀。 */
    prune(now = Date.now()) {
      for (const [ip, rec] of hits) {
        if (now - rec.start > windowMs) hits.delete(ip);
      }
    },
  };
}

/** 握手过渡页：200 + Set-Cookie（由调用方带上）+ meta refresh 跳回干净根路径。 */
export function handshakePageHtml(extraHead = '') {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
${extraHead}
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/">
<title>DSH Pocket · 正在进入 | opening…</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation}
p{font-size:13px;color:#6b7280;margin:0}
</style></head><body><p>正在进入… | opening…</p></body></html>`;
}

/** 握手反复失败时的提示页（issue #91）：说清原因并给出可操作的规避办法。 */
export function handshakeBlockedPageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Pocket · 无法完成登录握手</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;touch-action:manipulation}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 22px;max-width:380px;width:calc(100% - 40px)}
h1{font-size:15px;margin:0 0 10px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 10px;line-height:1.7}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
a{color:#4f6ef7}
</style></head><body><div class="card">
<h1>🔁 无法完成登录握手</h1>
<p>浏览器没有保存 DSH 下发的会话 cookie，代理反复重试后仍未成功，因此停在这里而不是无限跳转。</p>
<p><strong>Safari（iOS/macOS）</strong> 在 <code>http://</code> 纯 IP 地址上不会保存这类 cookie，局域网入口因此进不去。</p>
<p>可以试试：<br>
① 换 Chromium 系浏览器（Chrome / Edge）打开局域网地址；<br>
② 如需公网访问，请先在设置页配置<strong>自己的 Cloudflare 固定域名与 Tunnel Token</strong>，再开启对应的 HTTPS 入口；插件不提供现成公网地址。</p>
<p style="margin-top:14px"><a href="/?${HANDSHAKE_RETRY_PARAM}=1" style="display:inline-block;padding:8px 14px;background:#4f6ef7;color:#fff;border-radius:8px;text-decoration:none;font-size:13px">重试一次 | Retry</a></p>
<p style="color:#9ca3af;font-size:12px">Browser did not keep the session cookie, so the login handshake could not complete (issue #91). Safari over plain <code>http://</code> + IP is the known case — try Chrome, or use the public HTTPS entry.</p>
</div></body></html>`;
}

// ---------- WebSocket 心跳注入（PR #41，issue #29） ----------
// DSH 客户端与宿主的 WebSocket downlink 都不发 ping/pong（客户端只读流、
// 宿主只推帧），空闲连接会被路由器 NAT 空闲超时或手机系统省电机制**静默**
// 丢弃：没有 FIN/RST，浏览器收不到 close 事件，dsh-client-connection 也就
// 永远不会重连——手机页面看起来还开着，实则实时通道已死（消息不同步、
// 点击会话卡在加载）。
//
// 代理在每个透传的 WS 连接上定期向浏览器侧发送协议层 Ping（0x89 0x00，
// server→client 不掩码）：
//   - 浏览器网络栈按 RFC 6455 自动回 Pong（不经过任何 JS），一来一回让
//     双向都有流量，NAT/防火墙空闲超时不再触发；
//   - 连续 missLimit 个周期没有任何入站字节（浏览器已死或链路被静默丢弃）
//     → 主动 destroy 连接：浏览器拿到 close 后 dsh-client-connection 会
//     按指数退避自动重连，实时通道随即恢复。
// 只 Ping 浏览器侧：上游是本机 loopback，不会过期；浏览器回的 Pong 原样
// 透传给上游 ws 服务（未请求的 Pong 对 ws 库无害，只触发无害的 pong 事件）。
const WS_PING_FRAME = Buffer.from([0x89, 0x00]); // FIN + opcode 9、长度 0、不掩码

/**
 * 追踪「上游 → 浏览器」这一向的 WebSocket 帧边界。
 *
 * 心跳的 Ping 是直接往浏览器 socket 上写的裸帧。pipe 不以帧为单位搬运数据：
 * 一条大消息（或受到背压时）会被拆成多次 write，如果这时在中间插一个 0x89 0x00，
 * 这 2 字节就落在某条消息的 payload 里——浏览器按 RFC 6455 收到非法帧，直接以
 * 1002 协议错误关闭连接，实时通道反而更频繁地断。
 *
 * 所以注入前必须知道「现在是不是帧边界」。这里只做最小解析：帧头（含 126/127
 * 扩展长度与掩码键）和 payload 剩余字节数，不碰 payload 内容。
 */
function createWebSocketFrameTracker() {
  let head = Buffer.alloc(0); // 已收但未解析完的帧头（长度/掩码可能跨块）
  let payloadLeft = 0; // 当前帧还没消费掉的 payload 字节数

  const consume = (chunk) => {
    let rest = chunk;
    if (payloadLeft > 0) {
      const take = Math.min(payloadLeft, rest.length);
      payloadLeft -= take;
      rest = rest.subarray(take);
      if (payloadLeft > 0) return;
    }
    for (;;) {
      const bytes = head.length === 0 ? rest : Buffer.concat([head, rest]);
      if (bytes.length < 2) { head = bytes; return; }
      const masked = (bytes[1] & 0x80) !== 0;
      const len7 = bytes[1] & 0x7f;
      let off = 2;
      let len;
      if (len7 === 126) {
        if (bytes.length < off + 2) { head = bytes; return; }
        len = bytes.readUInt16BE(off);
        off += 2;
      } else if (len7 === 127) {
        if (bytes.length < off + 8) { head = bytes; return; }
        const big = bytes.readBigUInt64BE(off);
        len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
        off += 8;
      } else {
        len = len7;
      }
      if (masked) {
        if (bytes.length < off + 4) { head = bytes; return; }
        off += 4;
      }
      head = Buffer.alloc(0);
      rest = bytes.subarray(off);
      payloadLeft = len;
      if (payloadLeft > 0) {
        const take = Math.min(payloadLeft, rest.length);
        payloadLeft -= take;
        rest = rest.subarray(take);
        if (payloadLeft > 0) return;
      }
      if (rest.length === 0) return;
    }
  };

  return {
    feed: consume,
    /** true 表示此刻正好在一个帧的边界上，可以安全插入控制帧。 */
    atFrameBoundary() { return payloadLeft === 0 && head.length === 0; },
  };
}

/**
 * 在透传的浏览器侧 socket 上挂载心跳：定期 Ping 保活 + 静默断链检测。
 * 任一路由方向只要有字节流动（Pong 响应）就把静默计数归零；连续 missLimit
 * 个周期零入站流量则判定链路已死，销毁 socket 触发浏览器端重连。
 * @param {import('node:net').Socket} socket 浏览器侧的透传 socket
 * @param {{intervalMs?:number, missLimit?:number, atFrameBoundary?:() => boolean}} [opts]
 *   心跳周期、容忍的静默周期数，以及「现在能否安全插入控制帧」的判定
 */
function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2, atFrameBoundary = null } = {}) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    // 正处于某一帧的 payload 中间：这一拍不插帧（下一拍再试）。不算 miss——
    // 数据还在流，说明链路活着，此刻的静默只是「凑巧在帧中间」。
    if (atFrameBoundary !== null && !atFrameBoundary()) return;
    misses += 1;
    if (misses >= missLimit) {
      // 连续多个周期没有任何入站流量（连 Pong 都没有）→ 静默断链，断开让客户端重连
      socket.destroy();
      return;
    }
    // write 到已销毁的 socket 会抛错（destroy 竞态），写前检查并兜底
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/**
 * 启动 dsh-pocket 代理。
 * @param {object} opts
 * @param {number} [opts.port]      监听端口（默认 3081；dsh web 保持 3080）
 * @param {string} [opts.host]      监听地址（默认 0.0.0.0：LAN 与隧道都能到）
 * @param {{host:string,port:number}} [opts.upstream] 上游 dsh web（默认 127.0.0.1:3080）
 * @param {string} [opts.injectHtml] 注入 HTML 的内容（默认 polyfill + 移动端适配；传 '' 关闭）
 * @param {object} [opts.auth]       可选访问令牌认证（issue #13）：{ getToken, getAltTokens?, isProtected, sessionKey }
 *   - getToken(host) → 主 PIN（公网/局域网各一个，按 host 分类）
 *   - getAltTokens?(host) → 替代令牌列表（可选），校验时与主 PIN 任一命中即放行
 * @param {object|false} [opts.rateLimit] 登录速率限制参数覆盖（issue #40；测试用短窗口）
 * @param {object|false} [opts.heartbeat] WebSocket 心跳注入（PR #41）：{ intervalMs, missLimit }；false 关闭（默认开：30s/容忍 2 个静默周期）
 * @param {() => boolean} [opts.lanAccessEnabled] 局域网访问是否开启（默认开启）。关闭时拦截经局域网 Host 的请求（公网/loopback 不受影响）。
 * @returns {Promise<{server:import('node:http').Server, close:()=>Promise<void>}>}
 */
export function createPocketProxy({ port = 3081, host = '0.0.0.0', upstream = DEFAULT_UPSTREAM, log = null, injectHtml = DEFAULT_INJECT, auth = null, rateLimit = null, heartbeat = {}, lanAccessEnabled = () => true, launchToken = () => '', handshakeLimit } = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  // 到上游（本机 dsh web）的 keep-alive 连接池：手机首屏几十个静态资源若每个都新建
  // TCP，loopback 三次握手 + TIME_WAIT 会实打实叠进首屏时间。
  // WebSocket upgrade 不走这个池（见 handleClientUpgrade 的 agent:false）：WS 本身就是
  // 一条长连接，没有复用价值，反而会长期占用池内 socket 槽。
  const upstreamAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  // 会话握手重试计数（issue #91）：Safari 在 http://IP 源上丢 3xx 的 cookie → 死循环
  const handshake = createHandshakeTracker(
    typeof handshakeLimit === 'number' ? { max: handshakeLimit } : {},
  );
  function handleClientRequest(req, res) {
    // 策略判定一律用 policyHost（issue #90）：Host 头可伪造，用不可伪造的 TCP 源地址
    // 给它设下限。转发给上游的 Host 由 loopbackAuthority 单独改写，不受这里影响。
    let host = policyHost(req, String(req.headers.host ?? ''));
    // 隧道流量强制按公网判定：cloudflared 从 loopback 回连，ingress 若配了
    // httpHostHeader（或前面还有反代改写 Host），Host 会把请求伪装成本机/局域网。
    if (isCloudflareTunnelRequest(req) && classifyHost(host) !== 'public') host = TUNNEL_POLICY_HOST;
    const isPublic = classifyHost(host) === 'public';
    // 来源分级：只由不可伪造的源地址 + 规范化 Host 决定，随请求头传给上游 RPC。
    // 上游用它把「公网 PIN」「恢复出厂」等只在本机可见的能力挡在门外。
    const originClass = isPublic ? 'public' : isLoopbackHost(host) ? 'loopback' : 'lan';
    // 局域网访问关闭（issue #54）：拦截经局域网 IP/主机名访问的请求；
    // 公网（含任意非内网 Host——issue #66 fail closed）与 loopback（本机/cloudflared 回连）放行，
    // 公网流量随后照常走访问密码认证。
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      if (isHtmlRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lanDisabledPageHtml());
      } else {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"lan-disabled"}');
      }
      return;
    }
    // 访问令牌认证（issue #13 + #18 + #33 + #40 + #69）：局域网与公网按开关/来源要求密码
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      // 临时 PIN（issue #69）：按 host 同源分发（公网临时 PIN 只在公网入口放行，局域网同理）
      const altTokens = protectedHost && token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const sessionKey = auth.sessionKey ?? null;
      const acceptedTokens = token ? [token, ...altTokens] : [];
      // 长期 PIN 允许密码管理器保存；调用方未声明时保守地按临时凭据处理。
      const credentialKind = protectedHost && typeof auth.getCredentialKind === 'function'
        ? (auth.getCredentialKind(host) ?? 'ephemeral')
        : 'ephemeral';
      if (protectedHost && token) {
        const ip = clientIp(req);
        // 登录提交：速率限制（issue #40）→ 校验密码 → 种持久 HttpOnly cookie（30 天，绑定进程会话密钥）→ 回首页
        // 路径精确匹配：startsWith 会把 /pocket-loginXYZ 也吃进登录分支。
        let loginPath = null;
        try { loginPath = new URL(req.url, 'http://x').pathname; } catch { loginPath = null; }
        if (req.method === 'POST' && loginPath === '/pocket-login') {
          const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0, scope: null };
          // 单 IP 锁直接拒绝（否则这个 IP 可以无限猜）；全局锁只拦「继续猜」，
          // 正确密码必须能进来 —— 详见 createRateLimiter status() 的注释。
          if (rl.locked && rl.scope === 'ip') {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(rl.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, rl.retryAfter, credentialKind));
            return;
          }
          let body = '';
          let tooLarge = false;
          req.on('data', (c) => {
            if (tooLarge) return;
            body += c;
            if (body.length > 1024) {
              // 超长请求体不再静默 req.destroy()（浏览器只看到连接被重置、错误不可读）：
              // 明确回 413，刷出响应后再断开，避免继续接收。
              tooLarge = true;
              body = '';
              res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
              res.end('请求体过大 | payload too large');
              res.once('finish', () => req.destroy());
            }
          });
          req.on('end', () => {
            if (tooLarge) return;
            // 请求体读取期间其他并发请求可能已触发锁定，比较密码前必须再次检查。
            // 否则攻击者可预先挂起大量 POST，再同时结束请求体，批量穿透限速。
            const finalRl = limiter?.status(ip) ?? { locked: false, retryAfter: 0, scope: null };
            if (finalRl.locked && finalRl.scope === 'ip') {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(finalRl.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, finalRl.retryAfter, credentialKind));
              return;
            }
            const submitted = String(new URLSearchParams(body).get('token') ?? '');
            // 全局锁期间比对也限速（见 allowCompare）：否则触发一次全局锁后攻击者
            // 可以以网络速度持续猜，锁只改变了错误响应的形状，不改变猜测吞吐。
            // 正确的密码在预算内仍能登录；超出预算的短时间内会拿到锁定页。
            if (limiter && !limiter.allowCompare(ip)) {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(finalRl.retryAfter || 1),
              });
              res.end(loginPageHtml('locked', isPublic, finalRl.retryAfter || 1, credentialKind));
              return;
            }
            // 与 cookie / ?token= 两条通道保持一致：常量时间比较 + 主 PIN 与替代令牌
            // （临时 PIN，issue #69 钩子）任一命中即放行。原先这里是 `submitted === token`
            // ——既会提前返回（计时侧信道可逐字节还原 PIN），又把替代令牌挡在门外。
            const matched = acceptedTokens.find((candidate) => safeEqual(submitted, candidate));
            if (matched !== undefined) {
              limiter?.clear(ip);
              res.writeHead(302, {
                // 带上 dsh-pocket-auth=1：登录成功后强制重做一次浏览器会话握手，
                // 换掉可能已过期/被撤销的 dsh web 会话 cookie（issue #77）
                location: '/?dsh-pocket-auth=1',
                'set-cookie': `${TOKEN_COOKIE}=${cookieFor(matched, sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
                'cache-control': 'no-store',
              });
              res.end();
            } else {
              limiter?.record(ip);
              log?.(`dsh-pocket: login failed from ${ip} | 登录失败 IP: ${ip}`);
              // 全局锁期间密码错误：429 + 锁定页，别回 200 让人以为只是密码错。
              if (finalRl.locked) {
                res.writeHead(429, {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': 'no-store',
                  'retry-after': String(finalRl.retryAfter),
                });
                res.end(loginPageHtml('locked', isPublic, finalRl.retryAfter, credentialKind));
                return;
              }
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml(true, isPublic, 0, credentialKind));
            }
          });
          return;
        }
        // `?token=<PIN>` 是与 POST 登录等价的一次密码尝试（issue #90）：此前只有 POST
        // 分支调用 limiter.record()，这条通道既不计数也不受锁定约束，等于给攻击者留了
        // 一个可全速穷举 8 位 PIN 的旁路。下面把它并入同一套限速。
        const isGuess = hasQueryToken(req);
        let guessLock = { locked: false, retryAfter: 0, scope: null };
        if (isGuess) {
          guessLock = limiter?.status(ip) ?? guessLock;
          // 单 IP 锁：直接拒绝、不做比对（否则锁定窗口就是免费穷举窗口）。
          // 全局锁：仍然比对——正确密码放行，错误密码等下走 429/锁定页。
          if (guessLock.locked && guessLock.scope === 'ip') {
            if (isHtmlRequest(req)) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
              res.end(loginPageHtml('locked', isPublic, guessLock.retryAfter, credentialKind));
            } else {
              res.writeHead(429, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'retry-after': String(guessLock.retryAfter),
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
        }
        // 全局锁期间比对也要限速（见 allowCompare）：只回 429 不做节流等于给攻击者
        // 一次「解锁即无限猜」的机会。超预算直接拒绝，不做 safeEqual。
        if (isGuess && limiter && !limiter.allowCompare(ip)) {
          if (isHtmlRequest(req)) {
            res.writeHead(429, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'retry-after': String(guessLock.retryAfter || 1),
            });
            res.end(loginPageHtml('locked', isPublic, guessLock.retryAfter || 1, credentialKind));
          } else {
            res.writeHead(429, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              'retry-after': String(guessLock.retryAfter || 1),
            });
            res.end('{"error":"too-many-attempts"}');
          }
          return;
        }
        const authResult = authCheck(req, acceptedTokens, sessionKey);
        if (!authResult.ok) {
          if (isGuess) {
            limiter?.record(ip);
            log?.(`dsh-pocket: bad ?token= from ${ip} | URL 密码错误 IP: ${ip}`);
          }
          if (isGuess && guessLock.locked) {
            // 全局锁期间错误尝试：明确 429，不再进入普通登录页（避免被当成可继续猜）。
            if (isHtmlRequest(req)) {
              res.writeHead(429, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'retry-after': String(guessLock.retryAfter),
              });
              res.end(loginPageHtml('locked', isPublic, guessLock.retryAfter, credentialKind));
            } else {
              res.writeHead(429, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'retry-after': String(guessLock.retryAfter),
              });
              res.end('{"error":"too-many-attempts"}');
            }
            return;
          }
          if (isHtmlRequest(req)) {
            // 锁定期间打开登录页也给提示（HTTP 200 + 锁定文案；429 语义留给 POST 拒绝）
            const rl = limiter?.status(ip) ?? { locked: false, retryAfter: 0 };
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPageHtml(rl.locked ? 'locked' : false, isPublic, rl.retryAfter, credentialKind));
          } else {
            res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end('{"error":"unauthorized"}');
          }
          return;
        }
        // ?token=<原始 PIN> 直达时种 HttpOnly cookie，让浏览器后续子资源也走 cookie 路径（issue #35）
        if (authResult.rawQueryToken) {
          limiter?.clear(ip); // 与 POST 登录成功一致：正确的分享链接不该逐步累积到锁定
          maybeSeedAuthCookie(req, res, authResult.rawQueryToken, sessionKey);
        }
        // 认证已通过：把明文 PIN 从请求目标上摘掉再往下走（隐私审计）。
        // 不论这次是靠 cookie 还是靠 `?token=` 通过都要摘——用户收藏了带 PIN 的
        // 分享链接后每次打开都还带它，只摘「首次种 cookie」那一次等于没修。
        // 记录「确实摘过」：HTML 页面据此注入 history.replaceState 清掉地址栏里的 PIN。
        const scrubbedUrl = stripPocketToken(req.url, acceptedTokens);
        if (scrubbedUrl !== req.url) req.__pocketTokenScrubbed = true;
        req.url = scrubbedUrl;
      } else if (protectedHost) {
        // fail closed（issue #66 的边界）：protectedHost 为真但取不到 PIN 时，
        // 旧逻辑 `if (protectedHost && token)` 会整段跳过认证、请求直接透传到上游——
        // token 文件权限异常/磁盘错误就会变成静默的公网裸奔。宁可 503。
        log?.('dsh-pocket: access PIN unavailable — refusing protected request | 访问密码读取失败，已拒绝受保护请求');
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('dsh-pocket: access PIN unavailable | 访问密码不可用，请重启 dsh');
        return;
      } else {
        // auth 已配置但这台 Host 不受保护（本机入口 / 关掉了局域网密码）：不需要认证，
        // 但分享链接里的 PIN 仍然不能进上游请求行、日志或地址栏——不认证不等于可以
        // 把密码当普通参数转发（审计 F1：旧实现只在受保护 Host 上剥离）。
        const loose = [];
        try {
          const t = auth.getToken?.(host) ?? null;
          if (t) loose.push(t);
          const alt = typeof auth.getAltTokens === 'function' ? auth.getAltTokens(host) : null;
          if (Array.isArray(alt)) loose.push(...alt);
        } catch { /* 取不到 PIN 就没有可摘的值 */ }
        if (loose.length > 0) {
          const scrubbed = stripPocketToken(req.url, loose);
          if (scrubbed !== req.url) req.__pocketTokenScrubbed = true;
          req.url = scrubbed;
        }
      }
    }
    // 静态资源 SW 脚本直出（issue 慢加载）：放在鉴权之后——注册只发生在已登录 HTML 页，
    // 浏览器取脚本自带同源凭证，走这里不会再被 401 拦下；no-cache 让每次注册都重新
    // 校验（浏览器对 SW 主脚本本来也绕过 HTTP 缓存），脚本更新能及时生效。
    let swPath = null;
    try { swPath = new URL(req.url, 'http://x').pathname; } catch { /* 畸形请求目标 */ }
    if (swPath === null) {
      // 解析必抛错的请求目标（非法端口等）直接 400 拒绝，别让异常穿出 request 回调
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('dsh-pocket: malformed request target');
      return;
    }
    if (req.method === 'GET' && swPath === SW_SCRIPT_PATH) {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      });
      res.end(SW_SCRIPT);
      return;
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    headers[POCKET_ORIGIN_HEADER] = originClass;
    // dsh web 浏览器会话 token（issue #77）：首屏根路径补一次，换回绑定 authority 的 cookie
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    // 先清掉历史遗留的 dsh-desktop-* 参数（issue #75），再补 launch token
    // 握手重试上限（issue #91）：Safari 不保存 http://IP 源上 3xx 下发的 cookie →
    // 补 token → 上游 303 → 浏览器仍无 cookie → 无限循环。达到上限就别再补了，
    // 让请求落到提示页，而不是继续转圈。
    const handshakeIp = clientIp(req);
    // `/?dsh-pocket-retry=1`：提示页上的「重试」入口——清掉这一轮的失败计数，让握手
    // 重新走一遍（否则用户得干等窗口过期）。这参数是我们自己加的，不往上游透传。
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const handshakeOver = launchTok !== '' && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver
      ? cleanPath
      : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) {
      handshake.record(handshakeIp);
      handshake.prune();
    }
    // 请求带上了会话 cookie → 这一轮的握手计数可以清掉了（说明 cookie 通路是好的）
    if (!didInjectToken && String(req.headers.cookie ?? '').includes(DSH_AUTH_COOKIE)) {
      handshake.clear(handshakeIp);
    }
    if (handshakeOver && isHtmlRequest(req)) {
      // 已判定握不上手 → 停在这里给人话，别再转圈。API/WS 不走这里（上游会 401）。
      res.writeHead(503, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-dsh-pocket-handshake': 'blocked',
      });
      res.end(handshakeBlockedPageHtml());
      return;
    }
    // 不可变资源命中缓存：连上游都不用打（本地回环往返与重压都省掉）。
    // 必须在认证之后：缓存里是完整资源，未认证的请求不能拿到。
    if (req.method === 'GET' && isImmutableUrl(upstreamPath) && acceptedCodings(req.headers['accept-encoding']).br) {
      const cached = immutableCacheGet(upstreamPath);
      if (cached !== null) {
        res.writeHead(200, cached.headers);
        res.end(cached.body);
        return;
      }
    }
    // session/list 瘦身缓存的请求体摘要。缓存键必须区分不同 payload（切工作区、
    // 不同 cwd / cursor 的列表请求），否则短 TTL 内第二次请求会拿到第一次的响应——
    // 不是「稍旧」，而是把 A 工作区的会话树渲染进 B 工作区，且客户端认为加载完成、
    // 不会自我纠正。摘要为 null 时该请求只透传、不读也不写缓存。
    const slimReqPath = String(req.url ?? '').split('?')[0] ?? '';
    const wantsSlimBody = req.method === 'POST' && SESSION_LIST_SLIM_RE.test(slimReqPath);
    let slimBodyDigest = null;
    let slimRpcId = null;
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: upstreamAgent },
      (proxyRes) => {
        log?.(`${req.method} ${maskTokenForLog(req.url)} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        const codings = acceptedCodings(req.headers['accept-encoding']);
        // 不可变资源（内容哈希资产 / 带 rev 的插件组合包）：转码结果可无限期复用，
        // 内容变则 URL 变。命中缓存在建上游请求前就已返回，这里只负责回填。
        const immutableUrl = req.method === 'GET' && proxyRes.statusCode === 200 && isImmutableUrl(upstreamPath)
          ? upstreamPath
          : null;
        // issue #91：我们刚注入了 launch token，上游回 303（换 cookie 后回干净根路径）。
        // Safari 不保存 http://IP 源上 3xx 响应下发的 cookie，于是浏览器下次仍无 cookie
        // → 代理再注入 → 再 303 → 死循环。这里把这次 303 改成 200 过渡页：Set-Cookie
        // 照发（200 上的 cookie 不会被那条重定向策略丢掉），页面用 meta refresh 跳回 `/`。
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out['content-length'];
          delete out['transfer-encoding'];
          // 过渡页是我们自己写的明文 HTML：上游 303 若带 content-encoding，原样保留会让
          // 浏览器按 gzip 解码明文 → ERR_CONTENT_DECODING_FAILED 白屏（审计 F8）。
          delete out['content-encoding'];
          delete out.location; // 自己跳，不留给浏览器去重做一次 303
          const page = Buffer.from(handshakePageHtml(req.__pocketTokenScrubbed ? TOKEN_SCRUB_SCRIPT : ''), 'utf8');
          out['content-type'] = 'text/html; charset=utf-8';
          out['content-length'] = String(page.length);
          out['cache-control'] = 'no-store';
          out['x-dsh-pocket-handshake'] = 'transition';
          proxyRes.resume(); // 消费掉上游响应体，释放连接
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        // issue #81：上游 desktop-browser-access 门禁（DSH Desktop 未开启「浏览器访问」时）
        // 对普通浏览器（含经本代理转发的手机）返回 403 text/plain "forbidden"，且本代理无法
        // 携带 Electron renderer secret 绕过。对符合该特征的**浏览器导航**请求改写为可操作
        // 提示页；API/WS 与其余 403 原样透传（不猜 secret、不把任意 403 都判为桌面门禁）。
        if (proxyRes.statusCode === 403 && contentType.includes('text/plain')) {
          const navReq = isHtmlRequest(req);
          const gateChunks = [];
          let gateBytes = 0;
          let gateOverflow = false;
          proxyRes.on('data', (c) => {
            if (gateOverflow) return;
            gateChunks.push(c);
            // 累加长度，别每个 chunk 都 Buffer.concat 一遍：64KB 上限下小包可能几十个，
            // 每次复制已缓冲的全部字节是 O(n²)。
            gateBytes += c.length;
            if (gateBytes > 65536) {
              // 超过判定阈值：已缓冲的字节必须原样写出再从下一 chunk 起 pipe。
              // 之前这里直接 gateChunks.length = 0 清空，等于把已收到的 64KB 全丢了
              // （passRaw403 里的 if (gateChunks.length) 已空），响应体缺开头。
              gateOverflow = true;
              const buffered = Buffer.concat(gateChunks);
              gateChunks.length = 0;
              if (res.headersSent) return;
              res.writeHead(403, { ...proxyRes.headers });
              if (buffered.length) res.write(buffered);
              proxyRes.pipe(res);
            }
          });
          proxyRes.on('end', () => {
            if (gateOverflow || res.headersSent) return;
            const body = Buffer.concat(gateChunks).toString('utf8').trim();
            if (navReq && body === 'forbidden') {
              res.writeHead(403, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'x-dsh-pocket-gate': 'desktop-browser-access',
              });
              res.end(desktopAccessBlockedPageHtml());
            } else {
              res.writeHead(403, { ...proxyRes.headers });
              res.end(Buffer.concat(gateChunks));
            }
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // HTML 文档注入（SSE/WS/JS/CSS 原样透传）。宿主对声明了 accept-encoding 的浏览器
        // （Chrome/Edge/Safari 全都声明）会回 gzip/br 压缩 HTML——早期实现直接跳过压缩响应，
        // 结果**真实浏览器永远拿不到注入**（curl 不发 accept-encoding 才看得到注入版）：
        // randomUUID/AbortSignal.any polyfill 与 transport shim（issue #58/#96）全部静默失效，
        // 手机上表现为模型设置页「settings are unavailable in this browser」。现在先解压
        // 再注入；页面本体几十 KB，注入后以未压缩回传（删掉 content-encoding），不值得重压。
        // 超过 HTML_INJECT_MAX（含未知长度的 chunked 响应）则放弃注入、原样流式回传。
        const htmlDeclared = Number(proxyRes.headers['content-length'] || 0);
        // 206（Range）响应是片段：注入 <head> 里的脚本会被截断/重复，直接透传。
        // 204/304 没有正文：注入分支会写出与实际不符的 content-length、并清掉 304 的
        // 缓存验证器（审计实测），同样直接透传。
        const bodyless = proxyRes.statusCode === 204 || proxyRes.statusCode === 304;
        if (injectHtml && !bodyless && proxyRes.statusCode !== 206 && contentType.includes('text/html') && htmlDeclared <= HTML_INJECT_MAX) {
          const chunks = [];
          let htmlBytes = 0;
          let htmlOverflow = false;
          proxyRes.on('data', (c) => {
            if (htmlOverflow) return;
            chunks.push(c);
            htmlBytes += c.length;
            if (htmlBytes > HTML_INJECT_MAX) {
              // 超大/未知长度响应：放弃注入，已收字节 + 后续数据直接流式回传，
              // 不再把整段 body 攒在内存里（同步解压炸弹会直接打死宿主进程）。
              htmlOverflow = true;
              const buffered = Buffer.concat(chunks);
              chunks.length = 0;
              if (!res.headersSent) res.writeHead(proxyRes.statusCode ?? 200, { ...proxyRes.headers });
              res.write(buffered);
              proxyRes.pipe(res);
            }
          });
          proxyRes.on('end', () => {
            if (htmlOverflow) return;
            const raw = Buffer.concat(chunks);
            const enc = String(proxyRes.headers['content-encoding'] ?? '').trim().toLowerCase();
            // 解压成功才注入：解压失败或白名单外编码（空/gzip/x-gzip/br/deflate
            // 之外）一律按原始头 + 原始体纯透传——继续注入只会得到有损 utf8 往返
            // 加损坏的 body，还要删上游的 content-encoding 头。
            // maxOutputLength：压缩比异常（解压炸弹）时让 zlib 直接抛错而不是先分配
            // GB 级内存；抛错走「原样透传」分支，客户端拿到的仍是可用的压缩体。
            let body = null;
            const maxOut = { maxOutputLength: HTML_INJECT_MAX };
            if (enc === '') body = raw;
            else if (enc === 'gzip' || enc === 'x-gzip') { try { body = gunzipSync(raw, maxOut); } catch { /* 见上 */ } }
            else if (enc === 'br') { try { body = brotliDecompressSync(raw, maxOut); } catch { /* 见上 */ } }
            else if (enc === 'deflate') { try { body = inflateSync(raw, maxOut); } catch { /* 见上 */ } }
            if (body === null) {
              res.writeHead(proxyRes.statusCode ?? 502, { ...proxyRes.headers });
              res.end(raw);
              return;
            }
            let html = body.toString('utf8');
            const scrub = req.__pocketTokenScrubbed && !html.includes(TOKEN_SCRUB_MARK) ? TOKEN_SCRUB_SCRIPT : '';
            let injected = false;
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => { injected = true; return `${m}${injectHtml}${scrub}`; });
            } else if (scrub !== '') {
              html = html.replace(/<head[^>]*>/i, (m) => { injected = true; return `${m}${scrub}`; });
            }
            // 没有 <head> 的文档（片段、极简页）不能悄悄跳过注入：先退到 <body> 之后，
            // 再不行就直接前置（脚本在浏览器解析到前执行即可，位置不影响 replaceState）。
            if (!injected && scrub + injectHtml !== '') {
              if (/<body[^>]*>/i.test(html)) html = html.replace(/<body[^>]*>/i, (m) => `${m}${injectHtml}${scrub}`);
              else html = `${injectHtml}${scrub}${html}`;
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-encoding'];
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            // 注入后的 HTML 携带本代理的动态补丁（含注入标记判重），
            // 必须禁用缓存——否则手机/中间层（nginx 等）拿到没有补丁的旧
            // 文档后，isLoopback 修复不生效且难以排查（表现为"改了没效果"）。
            outHeaders['cache-control'] = 'no-store';
            delete outHeaders['etag'];
            delete outHeaders['last-modified'];
            delete outHeaders['expires'];
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // session/list 瘦身（issue：公网加载慢 / 对话加载不出来）：缓冲整个响应体，
        // 剥掉胖投影后重压缩回写。只认 POST + /api/session/list + 200 JSON；
        // 解压/改写失败一律原样透传（宁可胖也不能错）。
        const slimPath = String(req.url ?? '').split('?')[0] ?? '';
        const slimDeclared = Number(proxyRes.headers['content-length'] || 0);
        if (req.method === 'POST' && SESSION_LIST_SLIM_RE.test(slimPath)
          && proxyRes.statusCode === 200 && contentType.includes('application/json')
          && slimDeclared <= SESSION_LIST_SLIM_MAX) {
          // 请求体摘要进键（见上方 wantsSlimBody）：不同 payload 各走各的缓存；
          // 摘要拿不到（体积超限/非预期请求）就不缓存，宁可慢也不能串台。
          // 摘要已经剔掉 rpcId：同一个列表请求每次调用的 rpcId 都不同，拿它算摘要
          // 会让缓存永远不命中；而回包里的 rpcId 必须换成当前这次请求的，
          // 否则客户端对不上号，会把整包响应丢掉（点会话一直转圈）。
          const cacheKey = slimBodyDigest === null
            ? null
            : `${slimPath}|${codings.br ? 'br' : codings.gzip ? 'gzip' : 'raw'}|${slimBodyDigest}`;
          const cached = cacheKey === null ? null : sessionListCacheGet(cacheKey);
          if (cached !== null) {
            proxyRes.resume(); // 消费掉上游响应体，释放连接
            const outValue = cached.value;
            if (slimRpcId !== null) outValue.rpcId = slimRpcId;
            let hitBody = Buffer.from(JSON.stringify(outValue), 'utf8');
            const hitHeaders = { ...cached.headers };
            if (hitHeaders['content-encoding'] === 'br') hitBody = brotliCompressSync(hitBody, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });
            else if (hitHeaders['content-encoding'] === 'gzip') hitBody = gzipSync(hitBody);
            hitHeaders['content-length'] = String(hitBody.length);
            res.writeHead(proxyRes.statusCode ?? 200, { ...hitHeaders, 'x-dsh-pocket-slim-cache': 'hit' });
            res.end(hitBody);
            return;
          }
          const chunks = [];
          let rawBytes = 0;
          let slimOverflow = false;
          proxyRes.on('data', (c) => {
            if (slimOverflow) return;
            chunks.push(c);
            rawBytes += c.length;
            if (rawBytes > SESSION_LIST_SLIM_MAX) {
              // 声明长度不可信（chunked）或上游实际超限：放弃瘦身，已收字节 + 后续
              // 数据按原始编码流式回传。此时还没发头，可以直接切。
              slimOverflow = true;
              const buffered = Buffer.concat(chunks);
              chunks.length = 0;
              if (!res.headersSent) res.writeHead(proxyRes.statusCode ?? 200, { ...proxyRes.headers });
              res.write(buffered);
              proxyRes.pipe(res);
            }
          });
          proxyRes.on('end', () => {
            if (slimOverflow) return;
            const raw = Buffer.concat(chunks);
            const enc = String(proxyRes.headers['content-encoding'] ?? '').trim().toLowerCase();
            let plain = null;
            // maxOutputLength 与原始上限一致：压缩比异常时让 zlib 抛错走原样透传，
            // 而不是先分配出 GB 级缓冲再把进程打死。
            const maxOut = { maxOutputLength: SESSION_LIST_SLIM_MAX };
            if (enc === '') plain = raw;
            else if (enc === 'gzip' || enc === 'x-gzip') { try { plain = gunzipSync(raw, maxOut); } catch { plain = null; } }
            else if (enc === 'br') { try { plain = brotliDecompressSync(raw, maxOut); } catch { plain = null; } }
            else if (enc === 'deflate') { try { plain = inflateSync(raw, maxOut); } catch { plain = null; } }
            let slimmed = null;
            let slimValue = null;
            if (plain !== null) {
              slimValue = slimSessionListValue(plain.toString('utf8'));
              if (slimValue !== null) slimmed = Buffer.from(JSON.stringify(slimValue), 'utf8');
            }
            if (slimmed === null) {
              // 解压或改写失败：原始头 + 原始体纯透传（保留原 content-encoding）
              if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode ?? 200, { ...proxyRes.headers });
                res.end(raw);
              }
              return;
            }
            log?.(`dsh-pocket: session/list slimmed | 会话列表瘦身 ${rawBytes}B -> ${slimmed.length}B`);
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            delete outHeaders['etag'];
            delete outHeaders['content-encoding'];
            let send = slimmed;
            if (codings.br) {
              send = brotliCompressSync(slimmed, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });
              outHeaders['content-encoding'] = 'br';
            } else if (codings.gzip) {
              send = gzipSync(slimmed);
              outHeaders['content-encoding'] = 'gzip';
            }
            if (!/accept-encoding/i.test(String(outHeaders['vary'] ?? ''))) {
              outHeaders['vary'] = outHeaders['vary'] ? `${outHeaders['vary']}, Accept-Encoding` : 'Accept-Encoding';
            }
            outHeaders['content-length'] = String(send.length);
            outHeaders['cache-control'] = 'no-store';
            if (cacheKey !== null && slimValue !== null) {
              // 存对象而不是压缩后的字节：命中时必须把 rpcId 换成当前请求的，
              // 存字节就只能原样吐出上一次的 rpcId（客户端丢弃 → 一直加载中）。
              sessionListCacheSet(cacheKey, {
                value: slimValue,
                headers: outHeaders,
                bytes: slimmed.length,
                expiresAt: Date.now() + SESSION_LIST_CACHE_TTL_MS,
              });
            }
            if (!res.headersSent) {
              res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
              res.end(send);
            }
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 大 JSON/text 响应**流式压缩**（issue #12）：长会话历史一次返回 17MB+，
        // 局域网直连与隧道段都吃满带宽；压缩到 ~1MB。跳过已压缩、SSE 流
        // （/api/events.* 原样透传）、HTML（走上面的注入分支）。
        // brotli 质量选 6（issue #25）：zlib 默认 q11 压 17MB 要 40s+，手机直接超时；
        // q6 实测 128ms（比 gzip 的 88ms 略慢但同档）且输出更小（1.00MB vs 1.20MB）。
        // accept-encoding 要按 q 值解析（RFC 7231）：`br;q=0` 是明确排除，
        // 词边界正则会把它误判成支持。编码 → q 映射，缺省 q=1，q>0 才算支持。
        const canGzip = codings.gzip;
        const canBr = codings.br;
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        // 范围请求（音频/视频拖动进度、断点续传、大文件分段下载）绝对不能碰：
        // 上游回 206 时 body 只是整文件的一段，套上 Content-Encoding 后浏览器
        // 会拿这一段当独立压缩流去解，直接 ERR_CONTENT_DECODING_FAILED；
        // 而且 Content-Range 描述的是未压缩字节，编码一改就自相矛盾。
        // 同理 304（无 body）也不该被打上编码头。
        const isRangeResponse = proxyRes.statusCode === 206
          || proxyRes.headers['content-range'] !== undefined
          || req.headers.range !== undefined;
        const shouldCompress = (canGzip || canBr)
          && proxyRes.statusCode === 200
          && !isRangeResponse
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          // 内容因请求的 accept-encoding 而异，必须声明 Vary（同转码分支的写法）
          if (!/accept-encoding/i.test(String(outHeaders['vary'] ?? ''))) {
            outHeaders['vary'] = outHeaders['vary'] ? `${outHeaders['vary']}, Accept-Encoding` : 'Accept-Encoding';
          }
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          // 不可变资源：边发边收，结束（未中断）时把转码结果存进缓存。
          const cacheChunks = immutableUrl !== null && enc === 'br' ? [] : null;
          if (cacheChunks !== null) z.on('data', (chunk) => cacheChunks.push(chunk));
          proxyRes.pipe(z).pipe(res);
          if (cacheChunks !== null) {
            z.on('end', () => immutableCachePut(immutableUrl, outHeaders, Buffer.concat(cacheChunks)));
          }
          // 任一端断开都要清理（含压缩流）。注意：不能用 proxyRes 的 'close'
          // 来掐 res——正常结束后 close 也会触发，此时压缩流可能还没写完，
          // 会误杀连接；异常中止用 'aborted'。
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', (err) => { log?.(`dsh-pocket: upstream stream error | 上游流错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`); z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { log?.(`dsh-pocket: upstream aborted | 上游中断: ${req.method} ${maskTokenForLog(req.url)}`); z.destroy(); res.destroy(); });
          z.on('error', (err) => { log?.(`dsh-pocket: compress stream error | 压缩流错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`); res.destroy(); });
          return;
        }
        // 慢加载优化（issue 慢加载）：
        // (1) 内容哈希资产改写缓存头为一年 immutable——文件名带内容哈希，内容变即新 URL，
        //     原来的 max-age=14400 让手机每隔几小时就把 0.5MB JS 重下一遍；
        // (2) 上游已 gzip 的 JS/CSS/JSON 在客户端支持 brotli 时转码——公网链路瓶颈在隧道段
        //     （实测 0.24-0.94MB/s，CF 边缘能跑 1.9MB/s），combo 5.32MB→4.83MB（q5 转码 91ms），
        //     combo2 更省 ~30%。只碰「200 + GET + 纯 gzip 源」，br 源/多编码/非文本一律原样。
        const passthroughPath = String(req.url ?? '').split('?')[0] ?? '';
        const outHeaders = { ...proxyRes.headers };
        if (HASHED_ASSET_RE.test(passthroughPath) && proxyRes.statusCode === 200) {
          outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        }
        const srcEnc = String(proxyRes.headers['content-encoding'] ?? '');
        const transcodable = req.method === 'GET'
          && proxyRes.statusCode === 200
          && canBr
          && /^gzip$/i.test(srcEnc)
          && (contentType.includes('javascript') || contentType.includes('text/css') || contentType.includes('application/json'))
          && (knownLen === 0 || knownLen >= 4096);
        if (transcodable) {
          // 转码后字节变了：etag/accept-ranges/content-length 都失真，必须摘掉
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          delete outHeaders['etag'];
          delete outHeaders['accept-ranges'];
          outHeaders['content-encoding'] = 'br';
          if (!/accept-encoding/i.test(String(outHeaders['vary'] ?? ''))) {
            outHeaders['vary'] = outHeaders['vary'] ? `${outHeaders['vary']}, Accept-Encoding` : 'Accept-Encoding';
          }
          res.writeHead(200, outHeaders);
          const gunzip = createGunzip();
          const brStream = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
          // 不可变资源：边转码边收，结束（未中断）时把结果存进缓存。
          const cacheChunks = immutableUrl !== null ? [] : null;
          if (cacheChunks !== null) brStream.on('data', (chunk) => cacheChunks.push(chunk));
          proxyRes.pipe(gunzip).pipe(brStream).pipe(res);
          if (cacheChunks !== null) {
            brStream.on('end', () => immutableCachePut(immutableUrl, outHeaders, Buffer.concat(cacheChunks)));
          }
          // 清理同上：异常中止用 'aborted'，正常结束不能掐压缩链
          res.on('close', () => { proxyRes.destroy(); gunzip.destroy(); brStream.destroy(); });
          proxyRes.on('error', (err) => { log?.(`dsh-pocket: upstream stream error | 上游流错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`); gunzip.destroy(); brStream.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { log?.(`dsh-pocket: upstream aborted | 上游中断: ${req.method} ${maskTokenForLog(req.url)}`); gunzip.destroy(); brStream.destroy(); res.destroy(); });
          gunzip.on('error', (err) => { log?.(`dsh-pocket: gunzip stream error | 解压流错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`); res.destroy(); });
          brStream.on('error', (err) => { log?.(`dsh-pocket: brotli stream error | 转码流错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`); res.destroy(); });
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
        // 不可变资源且上游已回 br：原样透传的同时把 body 收进缓存，下次直接本地回。
        // 生产里 JS/CSS 多走这条（上游按 accept-encoding 已压好），不缓存的话命中率接近 0。
        const passthroughCache = immutableUrl !== null && /^br$/i.test(srcEnc) ? [] : null;
        if (passthroughCache !== null) proxyRes.on('data', (chunk) => passthroughCache.push(chunk));
        proxyRes.pipe(res);
        if (passthroughCache !== null) {
          proxyRes.on('end', () => immutableCachePut(immutableUrl, outHeaders, Buffer.concat(passthroughCache)));
        }
        // 任一端断开都要清理另一端：客户端断连销毁上游流（不留僵尸），
        // 上游流中途断开也要掐断客户端（否则响应头已发、体没发完 → 悬挂）
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    // 上游空闲超时：ClientRequest.setTimeout 是 socket 空闲语义（任一方向有数据
    // 就重置），流式/SSE 响应不会误伤；60s 无进展按错误销毁，走下面的 502 分支。
    proxyReq.setTimeout(60_000, () => {
      log?.(`dsh-pocket: upstream idle timeout | 上游空闲超时: ${req.method} ${maskTokenForLog(req.url)}`);
      proxyReq.destroy(new Error('upstream idle timeout'));
    });
    // 取消要一路传上游（issue：下游取消不传播）。用户关页/切网/切后台时浏览器直接
    // 断开，而下面几个分支都是「先把上游响应收集完再决定怎么写」：403 门禁、HTML
    // 注入、session/list 瘦身、不可变资源缓存回填。这些分支此前都不听 res 的 close，
    // 于是上游继续生成整段响应、cloudflared 出站通道和 dsh 连接槽被白占到写完为止。
    // 统一在这里绑一次，不再依赖每个分支自己记得加。
    let clientGone = false;
    res.on('close', () => {
      if (res.writableEnded || clientGone) return;
      clientGone = true;
      proxyReq.destroy(new Error('client closed connection | 客户端已断开'));
    });
    proxyReq.on('error', (err) => {
      // 客户端已经走了：连接本身没了，别再把 502 文本写进死 socket
      if (clientGone) return;
      log?.(`dsh-pocket: upstream error | 上游错误: ${req.method} ${maskTokenForLog(req.url)} | ${err?.message ?? err}`);
      // 已发头（流式响应中途断开）：再 end 错误文本会把说明拼进 HTML/JSON 正文，
      // 客户端拿到「半截内容 + 一段错误文字」；只能断开，让传输中断本身暴露失败。
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`dsh-pocket: 无法连接上游 dsh web（${upstream.host}:${upstream.port}）——先启动 dsh web | ${err.message}`);
    });
    if (wantsSlimBody) {
      // 只给 session/list 缓冲请求体（几百字节）：缓存键要它的摘要，边读边转会让
      // 摘要晚于响应到达。其余请求维持直通，不引入任何缓冲延迟。
      // 上限外的请求体不能再攒：之前只看 `bodyBytes <= MAX` 决定是否算摘要，
      // 但 data 回调照样把每个 chunk push 进数组——声明长度 1GB 的请求仍会
      // 整块吃进内存（审计实测 +150MB/请求）。超限即切流式直通。
      const bodyChunks = [];
      let bodyBytes = 0;
      let bodyOverflow = Number(req.headers['content-length'] || 0) > SESSION_LIST_BODY_MAX;
      if (bodyOverflow) req.pipe(proxyReq);
      req.on('data', (c) => {
        if (bodyOverflow) return;
        bodyChunks.push(c);
        bodyBytes += c.length;
        if (bodyBytes > SESSION_LIST_BODY_MAX) {
          bodyOverflow = true;
          for (const chunk of bodyChunks) proxyReq.write(chunk);
          bodyChunks.length = 0;
          req.pipe(proxyReq); // 剩余字节直接流过去，pipe 会在 end 时收尾
        }
      });
      req.on('end', () => {
        if (bodyOverflow) return;
        const body = Buffer.concat(bodyChunks);
        if (bodyBytes <= SESSION_LIST_BODY_MAX) {
          // 摘要必须剔除 rpcId：客户端每次调用用新的 rpcId，含它的摘要永远不同，
          // 缓存就永远命不中。回包时再把这个 id 原样填回当前响应。
          let parsed = null;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (typeof parsed.rpcId === 'string') slimRpcId = parsed.rpcId;
            const stripped = { ...parsed };
            delete stripped.rpcId;
            slimBodyDigest = createHash('sha256').update(JSON.stringify(stripped)).digest('hex').slice(0, 16);
          } else {
            slimBodyDigest = createHash('sha256').update(body).digest('hex').slice(0, 16);
          }
        }
        proxyReq.end(body);
      });
      req.on('error', () => proxyReq.destroy());
    } else {
      req.pipe(proxyReq);
    }
  }

  // 兜底：请求处理内的同步异常（如畸形请求目标的 URL 解析）不能穿出 request
  // 回调——那会变成 uncaughtException 崩掉宿主。已发头的连接只能断开。
  const server = createServer((req, res) => {
    try {
      handleClientRequest(req, res);
    } catch (err) {
      log?.(`dsh-pocket: request handler error | 请求处理异常: ${err?.message ?? err}`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('dsh-pocket: internal error');
        } else {
          res.destroy();
        }
      } catch { /* 连接已断 */ }
    }
  });

  // WebSocket upgrade（DSH 的 /api/events.mux + events.host 流式通道）原样透传
  function handleClientUpgrade(req, socket, head) {
    // 与 HTTP 侧同一套判定（issue #90）：否则伪造 Host 的 WS 握手仍可绕过局域网开关
    let host = policyHost(req, String(req.headers.host ?? ''));
    // 与 HTTP 侧一致：隧道流量（loopback 源 + Cloudflare 边缘头）一律按公网处理，
    // 防止 Host 被 ingress/前置反代改写成 127.0.0.1 后 WS 也拿到免密入口。
    if (isCloudflareTunnelRequest(req) && classifyHost(host) !== 'public') host = TUNNEL_POLICY_HOST;
    const isPublic = classifyHost(host) === 'public';
    // WS 上游握手也带来源分级头（与 HTTP 侧一致）；当前只有 HTTP 挂载的 RPC 消费它，
    // 但保持两条通道一致，避免将来 WS 侧加能力时拿到缺失/默认值（审计 F5）。
    const originClass = isPublic ? 'public' : isLoopbackHost(host) ? 'loopback' : 'lan';
    // 局域网访问关闭：拦截经局域网 Host 的 WS 握手（公网/loopback 放行——issue #66 fail closed）
    if (!isPublic && !isLoopbackHost(host) && !lanAccessEnabled()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // WebSocket 同样校验（防止绕过 HTTP 认证从 WS 进入；含临时 PIN，issue #69）
    if (auth) {
      const protectedHost = isProtectedHost(host, auth.isProtected);
      const token = protectedHost ? (auth.getToken?.(host) ?? null) : null;
      // 与 HTTP 侧对齐的 fail-closed（issue #66 的 WS 版）：取不到 PIN 时不能因为
      // 「token 为 null」把整段认证短路掉直接 101——HTTP 侧同场景是 503。
      if (protectedHost && !token) {
        log?.('dsh-pocket: access PIN unavailable — refusing protected ws | 访问密码读取失败，已拒绝受保护 WS');
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const altTokens = token && typeof auth.getAltTokens === 'function' ? (auth.getAltTokens(host) ?? []) : [];
      const acceptedTokens = token ? [token, ...altTokens] : [];
      // WS 握手上的 ?token= 与 HTTP 侧同权（issue #90）：不并入限速的话，攻击者
      // 只要把穷举换到 upgrade 请求上就照样不受限。
      const wsIp = clientIp(req);
      const wsGuess = hasQueryToken(req);
      let wsLock = { locked: false, retryAfter: 0, scope: null };
      if (token && wsGuess) {
        wsLock = limiter?.status(wsIp) ?? wsLock;
        // 单 IP 锁严格拒绝；全局锁只拦错误尝试，正确 PIN 仍放行（与 HTTP 侧一致）。
        if (wsLock.locked && wsLock.scope === 'ip') {
          socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wsLock.retryAfter}\r\nConnection: close\r\n\r\n`);
          socket.destroy();
          return;
        }
      }
      // 全局锁期间比对照样限速（与 HTTP 侧一致，见 allowCompare）。
      if (token && wsGuess && limiter && !limiter.allowCompare(wsIp)) {
        socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${wsLock.retryAfter || 1}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      const wsAuth = authCheck(req, acceptedTokens, auth.sessionKey ?? null);
      if (protectedHost && !wsAuth.ok) {
        if (wsGuess) {
          limiter?.record(wsIp);
          log?.(`dsh-pocket: bad ws ?token= from ${wsIp} | WS 密码错误 IP: ${wsIp}`);
        }
        // 全局锁期间错误尝试回 429（提示退避），其余 401。
        const statusLine = wsLock.locked ? '429 Too Many Requests' : '401 Unauthorized';
        if (wsLock.locked) socket.write(`HTTP/1.1 ${statusLine}\r\nRetry-After: ${wsLock.retryAfter}\r\nConnection: close\r\n\r\n`);
        else socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      if (token && wsAuth.ok && wsGuess) limiter?.clear(wsIp);
      // 与 HTTP 侧一致：WS 握手 URL 上命中口袋密码的明文 PIN 不再转发给上游
      if (wsAuth.ok) req.url = stripPocketToken(req.url, acceptedTokens);
      if (!protectedHost) {
        // 不受保护的 Host（本机 / 关闭局域网密码）：不认证，但仍然摘掉分享链接里的 PIN。
        const loose = [];
        try {
          const t = auth.getToken?.(host) ?? null;
          if (t) loose.push(t);
          const alt = typeof auth.getAltTokens === 'function' ? auth.getAltTokens(host) : null;
          if (Array.isArray(alt)) loose.push(...alt);
        } catch { /* 取不到 PIN 就没有可摘的值 */ }
        if (loose.length > 0) req.url = stripPocketToken(req.url, loose);
      }
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    headers[POCKET_ORIGIN_HEADER] = originClass;
    const proxyReq = httpRequest({
      // 同样清掉历史遗留的 dsh-desktop-* 参数（issue #75）
      // upgrade 用独立连接（agent:false）：WS 是长连接，进 keep-alive 池只会白占 socket 槽。
      host: upstream.host, port: upstream.port, method: req.method, path: stripDesktopMarkers(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      upgraded = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      // 原样回传上游的 upgrade 头（Sec-WebSocket-Accept 等）
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      // pipe 必须 end:false：默认 end:true 会在对端 FIN 时抢先 end() 对端 socket
      // （优雅 FIN），此时 teardown 的 destroy() 已无法强制关闭对方——上游只收
      // 到 FIN 进入 half-open 永不关闭（PR #56）。半关闭统一交给下面的 'end'
      // 监听 → teardown destroy（RST 强制关闭双方）。
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      // 心跳注入（PR #41）：保活 + 静默断链检测（见 attachWebSocketHeartbeat）。
      // 上游→浏览器这一向经过 tracker，只有在帧边界上才允许插入 Ping 帧，
      // 否则 2 字节控制帧会落进某条消息的 payload，浏览器按协议错误直接断开。
      const frames = createWebSocketFrameTracker();
      proxySocket.on('data', (chunk) => frames.feed(chunk));
      if (heartbeat !== false) attachWebSocketHeartbeat(socket, { ...(heartbeat ?? {}), atFrameBoundary: () => frames.atFrameBoundary() });
      // 任一端断开都要清理另一端（避免上游残留僵尸连接占用 dsh 连接槽）。
      // 上游侧必须 resetAndDestroy（发 RST）：destroy() 只发干净 FIN，而上游
      // http server 默认 allowHalfOpen=true，收到 FIN 不自动关闭 → 上游仍悬挂
      // （PR #56 实测）。RST 强制对端立即关闭。
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch {} }
        try { socket.destroy(); } catch {}
      };
      // 上游侧透传 socket 的读错误（如 dsh web 重启/断开时的 ECONNRESET）必须
      // 吞掉并清理对端，否则未处理的 'error' 事件会让整个 dsh web 进程崩溃退出。
      proxySocket.on('error', () => { try { socket.destroy(); } catch {} });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
      // 半关闭（收到对端 FIN 的 'end'）对双向转发同样意味着这一端要走了：http server
      // 默认 allowHalfOpen=true，收到 FIN 只触发 'end' 不自动关——若不在 'end' 时销毁，
      // 浏览器/App 直接关页（不发 WS close 帧就 FIN）留下的连接会永久挂在 half-open
      // 状态，上游连接槽被占（且 server.close() 永远等不完）。双向流里半关闭无意义。
      socket.on('end', teardown);
      proxySocket.on('end', teardown);
    });
    // 上游返回普通 HTTP 响应（非 101）：把状态码/头回写后断开，别让客户端永久挂起
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return; // 理论上 101 走 upgrade 事件
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        // end 会 flush 响应头再 FIN——不要紧跟 destroy()，否则排队的头会被丢弃
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume(); // 消费掉上游响应体，释放连接
      } catch { socket.destroy(); }
    });
    // 同 HTTP 侧：upgrade 请求 60s 空闲超时，destroy 后由下面的 'error' 收尾断开
    proxyReq.setTimeout(60_000, () => {
      log?.(`dsh-pocket: upstream idle timeout (ws) | 上游空闲超时(ws): ${req.method} ${maskTokenForLog(req.url)}`);
      proxyReq.destroy(new Error('upstream idle timeout'));
    });
    // 握手阶段（101 之前）客户端断开：此时还没绑定 teardown，proxyReq 会一直等到
    // 上游回完 101 或 60s 超时才结束，期间握着一条上游连接。取消要传到上游。
    // 注意这里必须同时听 'end' 和 'close'：客户端 destroy() 发送的是 FIN，服务端
    // socket 默认 allowHalfOpen=true，此时只触发 'end'，'close' 要等写方向也结束
    // ——只挂 'close' 等于什么都没做（实测上游连接一直挂着）。
    // 一旦升级成功，管道与 teardown 接管清理，这里就不再插手。
    let upgraded = false;
    const dropBeforeUpgrade = () => {
      if (upgraded) return;
      try { proxyReq.destroy(); } catch { /* 已销毁 */ }
    };
    socket.on('end', dropBeforeUpgrade);
    socket.on('close', dropBeforeUpgrade);
    proxyReq.on('error', () => socket.destroy());
    // 关键：浏览器在握手请求后可能立即发出首帧（如 mux 流的初始 RPC），
    // node 把它放在 upgrade 事件的 head 里。必须先于 end() 写入 proxyReq，
    // 让上游在 upgrade 事件里就拿到它（与直连行为一致）；等 101 之后再写
    // 会变成迟到的 socket 数据，DSH 的 mux 协议可能错过这个窗口。
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  }

  // 兜底同 HTTP 侧：upgrade 回调内的同步异常以 500 握手拒绝，别崩宿主
  server.on('upgrade', (req, socket, head) => {
    try {
      handleClientUpgrade(req, socket, head);
    } catch (err) {
      log?.(`dsh-pocket: upgrade handler error | upgrade 处理异常: ${err?.message ?? err}`);
      try { socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n'); } catch { /* 已断开 */ }
      socket.destroy();
    }
  });

  // 跟踪所有 TCP 连接（含 WebSocket upgrade 后的 socket——Node 的
  // closeAllConnections 不包含它们，不手动销毁 close() 会永远等）
  const clientSockets = new Set();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // 防未处理 error 崩进程
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          try { upstreamAgent.destroy(); } catch { /* 忽略 */ }
          server.close(() => r());
        }),
      });
    });
  });
}
