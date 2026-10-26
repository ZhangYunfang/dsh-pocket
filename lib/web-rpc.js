// dsh-pocket Web RPC（loopback-only）：设置页 ⇄ Host 的手机访问通道
//
// 兼容两条路径：
//   1. dsh v0.1.5-alpha.1+（client-connection inject 收缩为 ['credentials']，
//      rpc.handle 内部访问 owner.webServer 必抛 "cannot get property without inject"）
//      → 直接挂到本插件 inject 的 webServer 上，逐分支复刻 Connection /api 传输语义。
//   2. 旧版 dsh / 无 webServer 服务（headless）→ 回退 ctx.connection.rpc.handle(...)。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS, redactStatus, isSameRepo } from '../client/api.js';

/** 单次读取上限：4 MB，避免把大文件塞进剪贴板 / 内存。 */
const FILE_READ_MAX = 4 * 1024 * 1024;

/** RPC 请求体上限：8 MB。dsh-pocket 的所有 endpoint 都是小控制 JSON（status / 隧道开关 /
 *  自定义密码等），不存在大载荷；413 直接拒绝避免无界缓冲。 */
const POCKET_RPC_BODY_MAX = 8 * 1024 * 1024;

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** client-request 信封校验失败时使用的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

// ---------- fileRead 权限边界（issue #17 审计修正） ----------
// 手机「复制文件内容」能读主机任意文件，一旦聊天内容里出现一段「像路径」的文字，
// 用户点一下复制就把它读进手机剪贴板——提示注入 → 任意文件读取的通路是通的。
// 两道闸：
//   1) 凭据/密钥类路径一律拒绝（不依赖环境，永远生效）；
//   2) 能枚举出工作区时，只允许读工作区内的文件。
// 枚举不到工作区服务（旧版 dsh / headless）时退化为「仅凭据拒绝」，
// 避免因为服务形状差异把功能整体打死。
const SENSITIVE_DIR_NAMES = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.dsh', '.password-store']);
const SENSITIVE_FILE_NAMES = new Set([
  '.git-credentials', '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.htpasswd',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'token', 'token-lan', 'credentials',
]);
const SENSITIVE_FILE_RE = /^(?:\.env(?:\..+)?|.+\.(?:pem|key|pfx|p12|jks|keystore))$/i;

/** 路径是否落在凭据/密钥类位置（只看路径形状，不访问文件系统）。 */
function isSensitivePath(abs) {
  const parts = String(abs).split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  if (parts.some((p) => SENSITIVE_DIR_NAMES.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  return SENSITIVE_FILE_NAMES.has(base) || SENSITIVE_FILE_RE.test(base);
}

/** 收集工作区根目录。ctx.get 对未 inject 的服务可能抛错，全部吞掉。 */
async function workspaceRoots(ctx) {
  const roots = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) roots.add(path.resolve(value));
  };
  for (const key of ['workspaces', 'workspaceRegistry']) {
    try {
      const svc = ctx?.get?.(key);
      const list = typeof svc?.list === 'function' ? await svc.list() : svc?.list;
      const arr = Array.isArray(list) ? list : (Array.isArray(list?.value) ? list.value : []);
      for (const workspace of arr) add(workspace?.cwd ?? workspace?.root ?? workspace?.path);
    } catch { /* 该服务不存在或未 inject */ }
  }
  return [...roots];
}

/** 是否在某个根目录内（path.relative 判前缀，避免 C:\foo 误匹配 C:\foobar）。 */
function isInsideRoot(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 会话自己记录的工作目录（header.cwd，主机侧权威值）。
 *
 * 客户端传上来的 cwd 只是「手机猜的」：多工作区下 mobile-apply 的
 * getWorkspaceCwd 取的是 workspaces.list 的第一项，跟当前会话没有关系，
 * 于是 B 会话里点 A 项目的相对路径会被解析到别处（读错文件或直接报找不到）。
 * 会话 id 是客户端确实知道的，cwd 由主机按 id 查回来，来源才对得上。
 * 查不到（旧会话/已删除/服务缺失）返回 null，调用方再退回客户端传值。
 */
async function sessionCwdOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const pick = (candidate) => (typeof candidate === 'string' && path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : null);
  for (const key of ['sessions', 'sessionRegistry']) {
    let svc;
    try { svc = ctx?.get?.(key); } catch { continue; }
    if (!svc) continue;
    try {
      const live = typeof svc.get === 'function' ? await svc.get(sessionId) : undefined;
      const cwd = pick(live?.header?.cwd ?? live?.cwd);
      if (cwd !== null) return cwd;
    } catch { /* 该会话不在本进程 / 服务形状不同 */ }
    try {
      const stored = typeof svc.stat === 'function' ? await svc.stat(sessionId) : undefined;
      const cwd = pick(stored?.header?.cwd ?? stored?.cwd);
      if (cwd !== null) return cwd;
    } catch { /* 持久化层不可用 */ }
  }
  return null;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 从 Host 头取主机名。IPv6 必须先去方括号：`[::1]:3080`.split(':')[0] 得到的是 `[`。 */
function hostNameOf(host) {
  const raw = String(host ?? '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  return raw.replace(/:\d+$/, '');
}

/** 127.0.0.0/8 整段都算 loopback（与 proxy.mjs 的 isLoopbackHost / classifyHost 保持一致）。 */
function isLoopbackHostName(name) {
  return LOOPBACK_HOSTNAMES.has(name) || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * 从 `${channel}/<endpoint>` 路径里取出 endpoint，段非法时返回 undefined。
 * 与 dsh-client-connection 的 endpointFromPath 字段对字段一致。
 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** 构造 server-response JSON 串（与 dsh-client-connection 的 fullResponse 字段对齐）。 */
function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result });
}

/**
 * 旧版 dsh / 无 connection.requestRejection 时的最小信任栅栏：仅放行 loopback Host，
 * 拒 cross-site fetch 与 Origin 不匹配（与 isTrustedApiRequest 的 loopback 分支对齐）。
 * 新版 dsh 走 ctx.connection.requestRejection(req)（401/403 都在那里），本函数只是兜底。
 */
export function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  if (!isLoopbackHostName(hostNameOf(host))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

/**
 * 把 RPC handler 包装成 fetch-shaped handler，逐分支复刻 dsh-client-connection 的
 * rpcFetchHandler：404（非 POST / 无 endpoint）、415（content-type）、400（非 JSON）、
 * gateway/bad-request（信封非法 / method 与 endpoint 不匹配）、500（handler 抛错），
 * 成功返回 server-response JSON（200）。wire 协议与原 /api 通道逐字节一致。
 */
function pocketFetchHandler(channel, handler, log) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      // 最小信封校验（不依赖 @deepseek-ai/dsh-host-apiproxy 的 clientRequestSchema，
      // 形状稳定：{ rpcId: string, method: string, payload?: any }）。
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return new Response(
          serverResponseJson(INVALID_REQUEST_RPC_ID, {
            ok: false,
            error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method !== endpoint) {
        return new Response(
          serverResponseJson(rpcId, {
            ok: false,
            error: {
              code: 'bad-request',
              message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return new Response(serverResponseJson(rpcId, result), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (err) {
        log.error?.('dsh-pocket: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
        return new Response(`handler failure: ${String(err)}`, { status: 500 });
      }
    },
  };
}

/**
 * node:http 请求 → fetch-shaped handler → node:http 响应的桥接。
 * 与 dsh-client-connection 的 bridge 行为一致：
 *   - res.close 时若响应未结束 → abort（client 主动断开不再等 handler）；
 *   - 声明 content-length 超 maxBodyBytes → 413 + 销毁 socket；
 *   - 流式读取超 maxBodyBytes → 413 + 销毁 socket（防无界缓冲）；
 *   - 把请求头里 string 值原样传给 fetch handler（数组头被丢弃，与原实现一致）；
 *   - 响应 body 流式回写，遇背压等 drain / close。
 */
async function pocketHttpBridge(req, res, fetchHandler, maxBodyBytes) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const declaredLen = req.headers['content-length'];
  if (declaredLen !== undefined && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) { tooLarge = true; break; }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }

  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const init = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    ),
    signal: abort.signal,
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  // 畸形请求目标（端口越界、非法绝对形式）会让 Request 构造抛错——回 bad-request
  // 信封，别让异常穿透桥接函数崩掉宿主请求回调。
  let request;
  try {
    request = new Request(url, init);
  } catch (err) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(serverResponseJson(INVALID_REQUEST_RPC_ID, {
      ok: false,
      error: { code: 'bad-request', message: `invalid request target: ${err?.message ?? err}`, details: { issues: [] } },
    }));
    return;
  }

  let response;
  try {
    response = await fetchHandler.fetch(request);
  } catch (err) {
    // handler 抛错不能穿出路由回调：那会变成未处理拒绝，宿主请求回调里没人接。
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`bridge failure: ${err?.message ?? err}`);
    } else {
      try { res.destroy(); } catch { /* 已断开 */ }
    }
    return;
  }
  try {
    const headers = Object.fromEntries(response.headers.entries());
    // 不写 content-length（流式响应长度未知），交由 Node 自动分块。
    res.writeHead(response.status, headers);
    if (response.body === null) { res.end(); return; }
    for await (const chunk of response.body) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
      }
      if (res.writableEnded) break;
    }
    res.end();
  } catch (err) {
    // 流式回写中途失败（上游中断 / 客户端断开）：能补状态码就补，已发头则直接断开。
    if (!res.headersSent) {
      try {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`bridge failure: ${err?.message ?? err}`);
      } catch { /* 忽略 */ }
    } else {
      try { res.destroy(); } catch { /* 忽略 */ }
    }
  }
}

/**
 * 直接把 /dsh-pocket 通道挂到插件自己 inject 的 webServer 上。
 * 返回 disposer（同步或异步均可调用），返回 null 表示环境无 webServer（调用方应回退 rpc.handle）。
 *
 * 行为分支与 dsh-client-connection 的 register() /api 路由 1:1 对齐：
 *   - connection.requestRejection(req) 可用时（dsh v0.1.5-alpha.1+）→ 走它，
 *     401 unauthorized / 403 forbidden 都在那里判定（浏览器 cookie + Host/Origin 栅栏）；
 *   - 不可用时（旧版 dsh）→ 用 isTrustedLoopbackRequest 兜底，仅做 loopback 信任栅栏，
 *     浏览器 cookie 认证旧版本就没有，行为与原 rpc.handle({authority:'loopback'}) 一致；
 *   - 之后交给 pocketHttpBridge + pocketFetchHandler，复刻 /api 的 4xx/5xx/200 分支。
 */
function mountPocketWebRoute(ctx, { channel, handler, log }) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;
  // 必须持有 connection 本体并以**方法形式**调用 requestRejection（issue #117）：
  // dsh 的 HostConnectionService.requestRejection 是类方法，内部读 this.trustedHosts /
  // this.browserAuth。先把方法抽成裸函数（`const fn = ctx.connection.requestRejection`）
  // 再调用会丢失 this → TypeError → 被下面的 catch 兜底成 403，于是**任何**请求
  // （本机、带会话 cookie 的浏览器、移动端）都被判 forbidden，设置页 status RPC 全挂
  // （用户可见症状：局域网区块一直显示「代理未就绪…」，公网隧道开启报 403）。
  // dsh 自己的 /api 路由也是以方法形式调用的（见 client-connection 的 register()）；
  // 本仓库 lib/index.js 处理 authenticatedUrl 时同样用 fn.call(ctx.connection, ...) 绑定。
  // 等价写法：requestRejection.call(ctx.connection, req)（issue #117 报告者的建议）。
  const connection = ctx?.connection;
  const fetchHandler = pocketFetchHandler(channel, handler, log);
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        try { rejection = connection.requestRejection(req); } catch { rejection = 403; }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      await pocketHttpBridge(req, res, fetchHandler, POCKET_RPC_BODY_MAX);
    },
  };
  const registered = webServer.register(route);
  // register 可能返回 disposer、Promise<disposer> 或 undefined（仅写入路由表）。
  // 统一规整成「可幂等调用的清理函数」。
  const cleanup = typeof registered === 'function'
    ? () => { try { registered(); } catch { /* 已清理 */ } }
    : (registered && typeof registered.then === 'function')
      ? (() => { let done = false; return async () => { if (done) return; done = true; try { const d = await registered; if (typeof d === 'function') d(); } catch { /* 已清理 */ } }; })()
      : () => {};
  return cleanup;
}

function ok(value) {
  return { ok: true, value };
}

/**
 * 构造符合 DSH rpcErrorSchema 的错误（按 code 的 discriminated union，
 * details 必填且分分支定形；'internal' 不在合法 code 集合里）。
 */
function fail(code, message) {
  if (code === 'cancelled') return { ok: false, error: { code: 'cancelled', message, details: {} } };
  // 其余一律归入 bad-request（issues 是自由数组）
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } };
}

/** 各平台停止 dsh web 进程的命令（Windows 没有 lsof/kill）。 */
export function killHint(port) {
  if (process.platform === 'win32') {
    return `netstat -ano | findstr :${port}（找 LISTENING 的 PID）→ taskkill /PID <PID> /F`;
  }
  return `lsof -ti :${port} | xargs kill -9`;
}

/** npm registry 探测结果缓存时长（fork 守卫用）：每次点「更新」都阻塞 5 秒没必要。 */
const REGISTRY_PROBE_TTL_MS = 10 * 60 * 1000;

/** 注册 /dsh-pocket 逻辑通道（仅本机 loopback 可调）。
 * 优先直接挂到本插件 inject 的 webServer 上（dsh v0.1.5-alpha.1+ 兼容路径），
 * 不可用时回退 ctx.connection.rpc.handle（旧版 dsh 兼容路径）。
 * wire 协议两条路径完全一致：client-request → handler → server-response。 */
export function installPocketRpc(ctx, { service, log = console, desktop = false, runUpdate = null, restart = null, restartNotice = null, getToken = null, getLanToken = null, refreshLanToken = null, getLanAuthEnabled = null, setLanAuthEnabled = null, getLanEnabled = null, setLanEnabled = null, getMobileRightbarEnabled = null, setMobileRightbarEnabled = null, getMobilePinchZoomEnabled = null, setMobilePinchZoomEnabled = null, getMobileFontSize = null, setMobileFontSize = null, getLanIpOverride = null, setLanIpOverride = null, getPinCustom = null, setCustomPin = null, pinWriteWarning = null, getTunnelConfig = null, setTunnelConfig = null, resetPocket = null }) {
  // 探测缓存放在注册作用域内：生产只注册一次（缓存跨请求生效），测试每个用例
  // 重新 install 会拿到干净缓存，不会被上一个用例 stub 的 fetch 结果污染。
  let registryProbeCache = null; // { at:number, repo:string|null }
  const probeUpstreamRepository = async () => {
    const now = Date.now();
    if (registryProbeCache && now - registryProbeCache.at < REGISTRY_PROBE_TTL_MS) {
      return registryProbeCache.repo;
    }
    const ctrl = AbortSignal.timeout(5000);
    const meta = await (await fetch('https://registry.npmjs.org/dsh-pocket/latest', { signal: ctrl })).json();
    const repo = typeof meta?.repository === 'string' ? meta.repository : meta?.repository?.url ?? null;
    registryProbeCache = { at: now, repo: repo ?? null };
    return registryProbeCache.repo;
  };

  const pocketRpcHandler = async (endpoint, payload = {}, signal) => {
    if (signal?.aborted) return fail('cancelled', 'The request was cancelled.');

    // status 响应：服务状态 + 重启提示 + 停止命令 + 桌面端标志 + 公网/局域网访问密码 + 局域网密码开关
    const statusPayload = async () => {
      let notice = null;
      try { notice = (await restartNotice?.()) ?? null; } catch { notice = null; }
      const s = await service.status();
      return ok({
        ...redactStatus(s),
        desktop,
        restartNotice: notice,
        killHint: killHint(s.dshPort ?? 3080),
        accessToken: getToken?.() ?? null,
        lanToken: getLanToken?.() ?? null,
        lanAuthEnabled: getLanAuthEnabled?.() ?? true,
        lanEnabled: getLanEnabled?.() ?? true,
        mobileRightbarEnabled: getMobileRightbarEnabled?.() ?? true,
        mobilePinchZoomEnabled: getMobilePinchZoomEnabled?.() ?? false,
        mobileFontSize: getMobileFontSize?.() ?? 0,
        publicPinCustom: getPinCustom?.('public') ?? false,
        lanPinCustom: getPinCustom?.('lan') ?? false,
        tunnelConfig: getTunnelConfig?.() ?? { mode: 'named', hostname: '', tokenSet: false },
      });
    };

    try {
      if (endpoint === POCKET_ENDPOINTS.status) {
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.lanTokenRefresh) {
        const fresh = refreshLanToken?.() ?? null;
        if (!fresh) return fail('bad-request', '局域网密码刷新不可用 | LAN PIN refresh unavailable');
        return ok({ lanToken: fresh });
      }
      if (endpoint === POCKET_ENDPOINTS.lanAuthSetEnabled) {
        const enabled = setLanAuthEnabled?.(payload?.on === true);
        if (enabled === undefined) return fail('bad-request', '局域网密码开关不可用 | LAN PIN switch unavailable');
        return ok({ lanAuthEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetEnabled) {
        const enabled = setLanEnabled?.(payload?.on === true);
        if (enabled === undefined) return fail('bad-request', '局域网访问开关不可用 | LAN access switch unavailable');
        return ok({ lanEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.mobileRightbarSetEnabled) {
        const enabled = setMobileRightbarEnabled?.(payload?.on === true);
        if (enabled === undefined) return fail('bad-request', '手机端右边栏开关不可用 | mobile right sidebar switch unavailable');
        return ok({ mobileRightbarEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.mobilePinchZoomSetEnabled) {
        const enabled = setMobilePinchZoomEnabled?.(payload?.on === true);
        if (enabled === undefined) return fail('bad-request', '手机端捏合缩放开关不可用 | mobile pinch-zoom switch unavailable');
        return ok({ mobilePinchZoomEnabled: enabled });
      }
      if (endpoint === POCKET_ENDPOINTS.mobileFontSetSize) {
        try {
          const size = setMobileFontSize?.(payload?.size ?? 0);
          if (size === undefined) return fail('bad-request', '手机端字号设置不可用 | mobile font-size setting unavailable');
          return ok({ mobileFontSize: size });
        } catch (err) {
          return fail('bad-request', err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.lanSetOverride) {
        // 返回完整 status：前端 setStatus(await call(...)) 直接替换 status 对象，
        // 若只返回 { lanIpOverride } 会丢掉 accessToken/lanToken/tunnelUrl 等字段，
        // 且 lanUrl/二维码不会随新 IP 刷新（PR #47 的客户端写法依赖完整 status）。
        try {
          const ip = setLanIpOverride?.(payload?.ip ?? '');
          if (ip === undefined) return fail('bad-request', '局域网地址设置不可用 | LAN address setting unavailable');
          return await statusPayload();
        } catch (err) {
          return fail('bad-request', err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pinSetCustom) {
        const which = payload?.which === 'public' || payload?.which === 'lan' ? payload.which : null;
        if (!which) return fail('bad-request', '未知密码类型 | unknown PIN kind');
        try {
          const pin = setCustomPin?.(which, payload?.value);
          if (pin === undefined) return fail('bad-request', '自定义密码不可用 | custom PIN unavailable');
          // 写盘失败仍会用内存值继续服务，但必须让设置页知道「重启后会变」，
          // 否则用户以为改成功了，重启后再也登不上。
          const warning = pinWriteWarning?.(which) ?? null;
          return ok({ which, pin, custom: true, persisted: warning === null, ...(warning === null ? {} : { warning }) });
        } catch (err) {
          return fail('bad-request', err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelSetConfig) {
        // 命名隧道配置（issue #66）：{ mode, hostname, token }——token 只写不读，
        // 留空表示保持不变（undefined 不覆盖）；返回完整 status 供前端直接替换。
        if (!setTunnelConfig) return fail('bad-request', '隧道配置不可用 | tunnel config unavailable');
        try {
          setTunnelConfig({ mode: payload?.mode, hostname: payload?.hostname, token: payload?.token });
          return await statusPayload();
        } catch (err) {
          return fail('bad-request', err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.pocketReset) {
        // 恢复出厂设置：必须显式确认（payload.confirm === true），先停隧道再清空设置与密码，
        // 返回完整 status 供前端直接替换（旧密码立即作废，手机需重新输入）。
        if (payload?.confirm !== true) {
          return fail('bad-request', '恢复出厂设置需要确认 | factory reset requires confirmation');
        }
        if (!resetPocket) return fail('bad-request', '恢复出厂设置不可用 | factory reset unavailable');
        try {
          service.stopTunnel();
          const result = resetPocket() ?? {};
          const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
          const out = await statusPayload();
          // 设置文件删不掉 / PIN 只落内存时，前端必须能提示「重置不完整」，
          // 否则用户以为回到出厂了，实际开关和密码还是旧的。
          if (warnings.length > 0 && out?.ok) out.value.resetWarnings = warnings;
          return out;
        } catch (err) {
          return fail('bad-request', err?.message ?? String(err));
        }
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStart) {
        // 安全免责声明（issue #31）：每次开启公网都必须先确认（前端弹框勾选）。
        // 服务端强制校验，防止绕过前端直接调 RPC。
        if (payload?.disclaimer !== true) {
          return fail('bad-request', '开启公网前请先阅读并勾选安全免责声明 | please accept the security disclaimer before enabling public access');
        }
        await service.startTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.tunnelStop) {
        service.stopTunnel();
        return await statusPayload();
      }
      if (endpoint === POCKET_ENDPOINTS.version) {
        return ok({ current: runUpdate?.currentVersion?.() ?? null, loaded: runUpdate?.loadedVersion?.() ?? null, repository: runUpdate?.currentRepository?.() ?? null });
      }
      if (endpoint === POCKET_ENDPOINTS.fileRead) {
        // 移动端「复制文件内容」（issue #17）：手机点复制按钮 → 主机读文件正文返回。
        // 路径三种形态：
        //   - 绝对路径：直接用；
        //   - ~/ 开头：展开为用户 HOME；
        //   - 相对路径：相对「该会话自己的工作目录」优先，其次「客户端传入的
        //     cwd」，最后「DSH 主机进程 cwd = 工作目录」。会话 cwd 由主机按
        //     payload.sessionId 查回（header.cwd），是唯一与「这条消息属于哪个
        //     项目」有因果关系的来源；客户端那个 cwd 在多工作区下可能整个是
        //     别的项目。安全边界同既有 RPC：仅本机/隧道经 PIN 可达，
        //     等同于你自己操作这台机器。
        const raw = String(payload?.path ?? '').trim();
        if (!raw) return fail('bad-request', '缺少文件路径 | missing path');
        const roots = await workspaceRoots(ctx);
        const isInsideAny = (p) => roots.some((root) => isInsideRoot(root, p));
        let abs;
        try {
          if (/^~[/\\]?/.test(raw)) {
            // 去掉 ~ 及其后的可选斜杠，再相对 HOME 解析
            abs = path.resolve(os.homedir(), raw.replace(/^~[/\\]?/, ''));
          } else if (path.isAbsolute(raw)) {
            abs = path.resolve(raw);
          } else {
            const sessionCwd = await sessionCwdOf(ctx, payload?.sessionId);
            const base = sessionCwd
              ?? (typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd());
            abs = path.resolve(base, raw);
            // 客户端 cwd 可能为空、也可能不是当前工作区（多工作区/手机端缓存）：
            // 相对路径再按各工作区根解析一次，这是「复制文件内容」最常见的失败场景。
            // 但只在没有会话 cwd 时才做——有权威来源时按目录名撞运气只会读错文件。
            if (sessionCwd === null && roots.length > 0 && !isInsideAny(abs)) {
              const hit = roots.map((root) => path.resolve(root, raw)).find((candidate) => isInsideAny(candidate));
              if (hit) abs = hit;
            }
          }
        } catch {
          return fail('bad-request', '路径非法 | invalid path');
        }
        // 权限边界必须先于存在性检查：否则错误信息（文件不存在/是目录）本身
        // 就成了「这个路径存不存在」的探测器。
        if (isSensitivePath(abs)) {
          return fail('bad-request', '该路径属于凭据/密钥类文件，已拒绝读取 | refusing to read a credential file');
        }
        if (roots.length > 0 && !isInsideAny(abs)) {
          return fail('bad-request', `仅允许读取工作区内的文件：${abs} | only files inside a workspace can be copied`);
        }
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          return fail('bad-request', `文件不存在：${abs} | file not found`);
        }
        if (stat.isDirectory()) return fail('bad-request', '这是目录，不是文件 | it is a directory');
        if (stat.size > FILE_READ_MAX) {
          return fail('bad-request', `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），无法复制 | file too large`);
        }
        // 上面的词法边界只作用于用户写的路径；文件本身可能是符号链接/目录联接，
        // 指向工作区外的机密。判定与打开都要沿着真实路径走一遍。
        let real;
        try {
          real = await fs.realpath(abs);
        } catch {
          return fail('bad-request', `文件不存在：${abs} | file not found`);
        }
        if (isSensitivePath(real)) {
          return fail('bad-request', '该路径属于凭据/密钥类文件，已拒绝读取 | refusing to read a credential file');
        }
        if (roots.length > 0) {
          let realRoots = [];
          try {
            realRoots = (await Promise.all(roots.map((root) => fs.realpath(root).catch(() => null))))
              .filter((root) => typeof root === 'string' && root !== '');
          } catch { realRoots = []; }
          const insideReal = realRoots.some((root) => isInsideRoot(root, real));
          if (!insideReal) {
            return fail('bad-request', `仅允许读取工作区内的文件：${abs} | only files inside a workspace can be copied`);
          }
        }
        let buf;
        try {
          // 用真实路径打开，避免检查后路径被换成指向别处的链接
          buf = await fs.readFile(real);
        } catch (err) {
          return fail('bad-request', `读取失败：${err?.message ?? String(err)} | read failed`);
        }
        // 二进制检测：前 8KB 含 NUL 字节即视为二进制，文本复制无意义。
        if (buf.subarray(0, 8192).includes(0)) {
          return fail('bad-request', '二进制文件，无法复制文本 | binary file');
        }
        return ok({ content: buf.toString('utf8'), path: real, size: stat.size });
      }
      if (endpoint === POCKET_ENDPOINTS.update) {
        // 桌面端：更新由 DSH Desktop 管理，这里关闭（不删除，仅禁用）
        if (desktop) return fail('bad-request', '桌面版更新由 DSH Desktop 管理，已在此环境停用 | updates are managed by DSH Desktop here');
        if (!runUpdate) return fail('bad-request', '更新不可用 | update unavailable');
        // fork/分支安装守卫：本地 repository 与 npm 上游不一致时，`dsh plugin update --latest`
        // 会把上游代码盖在本地修改上（键盘修复、慢加载修复等都会没）。registry 不可达时放行——
        // 一键更新本身需要联网，离线场景按钮也不会出现。
        const localRepo = runUpdate?.currentRepository?.() ?? null;
        if (localRepo) {
          try {
            const upstreamRepo = await probeUpstreamRepository();
            if (upstreamRepo && !isSameRepo(localRepo, upstreamRepo)) {
              return fail('bad-request', `本地为 fork/分支安装（repository 与 npm 上游不一致），一键更新会覆盖本地修改，已拦截。请用 git 合并上游更新 | fork install: npm update would overwrite local changes (blocked); merge upstream via git`);
            }
          } catch { /* registry 不可达：放行 */ }
        }
        const result = await runUpdate.perform(payload?.profile ?? 'web');
        // 更新成功 → 自动重启生效（用户只点一次；helper 拉起失败则保持现状，可手动重启）
        if (result?.ok && restart) {
          const rr = restart();
          result.autoRestart = rr?.helperPid != null;
        }
        return ok(result);
      }
      if (endpoint === POCKET_ENDPOINTS.restart) {
        // 桌面端：重启由 DSH Desktop 管理，这里关闭（不删除，仅禁用）
        if (desktop) return fail('bad-request', '桌面版重启由 DSH Desktop 管理，已在此环境停用 | restart is managed by DSH Desktop here');
        if (!restart) return fail('bad-request', '重启不可用 | restart unavailable');
        const result = restart();
        // 重启拉起失败（helper 都没 spawn 出来）→ 如实报错，别让 UI 误报成功
        if (!result || result.helperPid == null) {
          return fail('bad-request', `重启失败：${result?.error ?? '未知'} | restart failed`);
        }
        const dshPort = service.dshPort ?? 3080;
        return ok({ ...result, hint: `重启后进程在后台运行；如需停止：${killHint(dshPort)}` });
      }
      return fail('bad-request', `Unknown endpoint: ${endpoint}`);
    } catch (err) {
      log.error?.('dsh-pocket: rpc %s failed | RPC 失败: %s', endpoint, err?.message ?? err);
      return fail('bad-request', err?.message ?? String(err));
    }
  };

  // 优先路径：直接挂到本插件 inject 的 webServer 上（dsh v0.1.5-alpha.1+）。
  // 该路径下 ctx.connection 仅用于 requestRejection（401/403 完整栅栏），即使
  // client-connection 已不再 inject webServer，本插件自己 inject 的 webServer 也照常工作。
  const directMount = mountPocketWebRoute(ctx, { channel: POCKET_RPC_CHANNEL, handler: pocketRpcHandler, log });
  if (directMount) return directMount;

  // 回退路径：旧版 dsh（无 webServer 服务，如 headless / 测试 fixture）走 rpc.handle。
  // { authority: 'loopback' } 旧版用、新版 Connection 从未消费，保留向后兼容。
  if (!ctx?.connection?.rpc?.handle) {
    log.warn?.('dsh-pocket: DSH Host Connection RPC unavailable — settings tab disabled | 无 Connection RPC，设置页不可用');
    return () => {};
  }
  return ctx.connection.rpc.handle(POCKET_RPC_CHANNEL, pocketRpcHandler, { authority: 'loopback' });
}
