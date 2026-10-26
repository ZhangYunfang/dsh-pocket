// dsh-pocket 会话删除（宿主侧半边）——移植自 dsh-web-mobile v3.0.3 src/delete-session.ts
// + src/index.ts 的 /api/mobile-nav.session.delete 路由（MIT，见 NOTICE.md）。
//
// 为什么 pocket 需要它：移动端 session-menu（上游移植层）的删除按钮 fetch 的就是
// 这个端点；官方 dsh 没有此路由，宿主侧不挂 → 手机端删除永远 404。上游把它做成
// 「回收站式删除」（payload 先改名 .trash 再整目录搬进 <root>/.sessions-trash/），
// 逻辑原样保留，包括跨代宿主兼容（0.1.1/0.1.2/0.1.3 三代 persistence/agent 形状）。
//
// 与上游的两处刻意差异：
// 1. sameOrigin 放宽为「Origin 与 Host 同名，或 Origin 是本机 loopback 形态」——
//    手机访问走 dsh-pocket 代理（3081），代理虽然会把 Host/Origin 改写成 loopback
//    权威后转发，但保留对直连 3080 / 未来代理策略变化时的宽容性：Origin 主机名
//    与请求主机名一致（端口号差异忽略）即视为同源。非浏览器客户端（无 Origin）照旧放行。
// 2. 不做响应压缩（pocket 的 lib/proxy.mjs 已在代理层做大 JSON 压缩，此处响应都是小 JSON）。

import { rm, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isTrustedLoopbackRequest } from './web-rpc.js';

/** How long to wait for a live agent to converge to idle before refusing. */
const IDLE_TIMEOUT_MS = 20_000;

/** Trash entries older than this are purged (best effort) after a successful move. */
const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

/** Canonical payload names the host list() scan recognizes. */
const PAYLOAD_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;

/** Maximum accepted request body size (1 MiB — the delete body is one id). */
const MAX_BODY_BYTES = 1_048_576;

class PayloadTooLargeError extends Error {}

/** Failure stage of a trash move, carried on the thrown error. */
class TrashMoveError extends Error {
  constructor(stage, cause) {
    super(errorMessage(cause));
    this.stage = stage;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Escape one raw session id into one filesystem-safe path segment (backend layout). */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

/** Build the readable directory key for a project path (backend layout). */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

/** The directory owned by one session under the backend root. */
function sessionDir(root, cwd, id) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
  return join(root, project, encodeSegment(id));
}

/** Whether `target` resolves to a path inside `root` (defense against escapes). */
function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + sep) && rel !== '';
}

/** Bound a promise with a rejection deadline so a stuck agent never hangs the endpoint. */
function withTimeout(promise, ms, message) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Normalize one `persistence.list()` entry across host generations. */
function entryHeader(entry) {
  const header = entry?.header ?? entry;
  if (typeof header?.id !== 'string' || header.id === '') return undefined;
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
  };
}

/** Unregister a live agent via runtime-visible store internals, if present. */
function detachLiveAgent(agents, id) {
  const registry = agents;
  const entry = registry?.store?.get(id);
  if (entry !== undefined) registry?.detachEntered?.(entry);
}

/** Unregister a live session via runtime-visible store internals, if present. */
function detachLiveSession(sessions, id) {
  sessions?.store?.get(id)?.detach?.();
}

/** Remove the session from every workspace account (idempotent, optional faces). */
async function detachFromWorkspaces(deps, sessionId) {
  if (deps.workspaceRegistry === undefined) return;
  // 各 workspace 的 detachSession 互不依赖，串行 await 会让多工作区用户的删除多等几倍
  await Promise.allSettled(deps.workspaceRegistry.list().map((workspace) => workspace.detachSession?.(sessionId)));
}

/** 回收站目录名：ISO 时间 + 项目键 + 编码后的会话 id。
 * 项目键最长 255 字符（--<slug>--），拼起来会超过 NTFS 单段 255 字符上限，
 * rename 报 ENAMETOOLONG → 删除失败；这里按总长预算裁剪（时间戳+id 已足够区分）。 */
const TRASH_NAME_MAX = 200;
function trashDirName(project, sessionId) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const idPart = encodeSegment(sessionId);
  const room = TRASH_NAME_MAX - stamp.length - 2;
  let p = project;
  let id = idPart;
  if (p.length + id.length > room) {
    id = id.length > room / 2 ? id.slice(0, Math.max(16, Math.floor(room / 2))) : id;
    p = p.slice(0, Math.max(8, room - id.length));
  }
  return `${stamp}-${p}-${id}`;
}

/** Move one session's stored directory into the trash instead of removing it.
 * Order is load-bearing: payloads renamed FIRST (host scan no longer sees the
 * session), then the directory rename, manifest best-effort, stale purge. */
async function moveToTrash(root, dir, cwd, sessionId) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new TrashMoveError('rename-payloads', error);
  }
  const renamed = [];
  /** 把已改名的 payload 改回去：失败时要让会话重新对宿主可见。 */
  const rollbackRenames = async () => {
    for (let i = renamed.length - 1; i >= 0; i--) {
      const item = renamed[i];
      try { await rename(join(dir, item.to), join(dir, item.from)); } catch { /* 尽力而为 */ }
    }
    renamed.length = 0;
  };
  for (const entry of entries) {
    if (!entry.isFile() || !PAYLOAD_NAME.test(entry.name)) continue;
    const to = `${entry.name}.trash`;
    try {
      await rename(join(dir, entry.name), join(dir, to));
    } catch (error) {
      // 半途失败必须回滚：否则宿主扫描已看不到这份会话，而回收站里也没有它，
      // 用户既删不掉也恢复不了（删除接口 500 却说"没删成功"）。
      await rollbackRenames();
      throw new TrashMoveError('rename-payloads', error);
    }
    renamed.push({ from: entry.name, to });
  }
  const trashRoot = join(root, '.sessions-trash');
  const trashDir = join(trashRoot, trashDirName(project, sessionId));
  try {
    await mkdir(trashRoot, { recursive: true });
    await rename(dir, trashDir);
  } catch (error) {
    // 目录没能整体搬走 → 会话还留在原处，payload 名字必须复原，否则"删除失败"
    // 的报错和实际状态不一致（会话凭空消失，且没有 manifest 可恢复）。
    await rollbackRenames();
    throw new TrashMoveError('stash', error);
  }
  try {
    const manifest = { id: sessionId, cwd, deletedAt: new Date().toISOString(), files: renamed };
    await writeFile(join(trashDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch { /* restore info degrades to the deterministic from→to rule */ }
  await purgeStaleTrash(trashRoot);
}

/** Remove trash entries older than TRASH_TTL_MS; every failure is swallowed. */
async function purgeStaleTrash(trashRoot) {
  try {
    const cutoff = Date.now() - TRASH_TTL_MS;
    for (const name of await readdir(trashRoot)) {
      try {
        const stats = await stat(join(trashRoot, name));
        if (stats.mtimeMs < cutoff) await rm(join(trashRoot, name), { recursive: true, force: true });
      } catch { /* skip an entry that vanished */ }
    }
  } catch { /* trash root unreadable: best effort */ }
}

/** Read the persistence root once and purge the stale trash; skip silently when
 * the service (or its root) is not registered yet. */
export async function purgeSessionTrash(ctx) {
  const root = ctx?.get?.('sessionPersistence')?.config?.root;
  if (typeof root !== 'string' || root === '') return;
  await purgeStaleTrash(join(root, '.sessions-trash'));
}

/** Purge once after the host has finished loading services (persistence may
 * register after this plugin), and hand back the timer cancel for the disposer.
 * Without this, a host that never deletes a session keeps stale trash forever. */
export function scheduleTrashPurge(ctx, { delayMs = 5_000 } = {}) {
  const timer = setTimeout(() => { void purgeSessionTrash(ctx); }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Delete one session: stop it if live, trash its persisted directory, and
 * detach it from every workspace account. Services are read per request.
 * @returns A structured result the caller maps to an HTTP response.
 */
export async function deleteSession(deps, sessionId) {
  const root = deps.persistence?.config?.root;
  if (root === undefined || root === '') {
    return { status: 503, ok: false, error: { code: 'persistence-unavailable', message: 'session persistence is not configured with a storage root' } };
  }

  let snapshot;
  try {
    snapshot = (await deps.persistence.list())
      .map(entryHeader)
      .find((header) => header !== undefined && header.id === sessionId);
  } catch (error) {
    return { status: 500, ok: false, error: { code: 'delete-lookup-failed', message: `failed to look up the session: ${errorMessage(error)}` } };
  }
  if (snapshot === undefined) {
    return { status: 404, ok: false, error: { code: 'session-not-found', message: `no such session '${sessionId}'` } };
  }

  // Live sessions: only delete when the host exposes the agent disposal face
  // (callable cancel + whenIdle); otherwise refuse with 409.
  const live = deps.sessions?.get?.(sessionId);
  if (live !== undefined && deps.sessions !== undefined) {
    const agent = deps.agents?.get?.(sessionId);
    const handle = agent !== undefined
      && typeof agent.cancel === 'function'
      && typeof agent.whenIdle === 'function'
      ? agent
      : undefined;
    if (agent !== undefined && handle === undefined) {
      return { status: 409, ok: false, error: { code: 'session-busy', message: `session '${sessionId}' is live on a host generation that exposes no agent disposal face; stop it first, then retry` } };
    }
    try {
      if (handle !== undefined) {
        handle.cancel({ kind: 'disposed' });
        await withTimeout(handle.whenIdle(), IDLE_TIMEOUT_MS, `agent for session '${sessionId}' did not converge to idle within ${IDLE_TIMEOUT_MS}ms`);
      }
      await deps.sessions.flush(live);
      detachLiveAgent(deps.agents, sessionId);
      detachLiveSession(deps.sessions, sessionId);
    } catch (error) {
      return { status: 409, ok: false, error: { code: 'session-busy', message: `cannot delete session '${sessionId}': it is running and could not be stopped: ${errorMessage(error)}` } };
    }
  }

  const resolvedRoot = resolve(root);
  const dir = sessionDir(resolvedRoot, snapshot.cwd, sessionId);
  if (!isInside(resolvedRoot, dir)) {
    return { status: 500, ok: false, error: { code: 'delete-failed', message: `refusing to remove '${dir}': it resolves outside the session storage root` } };
  }
  try {
    await moveToTrash(resolvedRoot, dir, snapshot.cwd, sessionId);
  } catch (error) {
    const stage = error instanceof TrashMoveError ? error.stage : 'stash';
    if (live !== undefined) {
      try { await detachFromWorkspaces(deps, sessionId); } catch { /* stale id reconciles later */ }
      return {
        status: 500,
        ok: false,
        deletedLiveSession: true,
        error: {
          code: 'cleanup-failed',
          message: stage === 'rename-payloads'
            ? `session '${sessionId}' was stopped and unregistered, but its log directory could not be moved to the trash and remains untouched in place: ${errorMessage(error)}; the session will not resume — retry the delete to clean up the leftover files`
            : `session '${sessionId}' was stopped and unregistered, but its log directory could only be partially stashed (payloads renamed, directory still in place): ${errorMessage(error)}; the session will not resume — its payloads were renamed with a ".trash" suffix and the session is hidden from the list: restore the original file names (strip the suffix) and delete again to finish the move, or remove the directory manually`,
        },
      };
    }
    return {
      status: 500,
      ok: false,
      error: {
        code: 'delete-failed',
        message: stage === 'rename-payloads'
          ? `failed to move the session log to the trash: ${errorMessage(error)} (the directory is untouched)`
          : `failed to stash the session log directory: ${errorMessage(error)} (payloads were renamed, so the session is hidden from the list until restored)`,
      },
    };
  }

  try { await detachFromWorkspaces(deps, sessionId); } catch { /* stale id reconciles later */ }
  return { status: 200, ok: true, deleted: sessionId };
}

/** Write one JSON response with a fixed content type. */
function respond(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Drain a request body as UTF-8 text with a size cap (see upstream note: past
 * the limit the data is released but the socket drains so the 413 delivers). */
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        data = '';
        return;
      }
      if (!tooLarge) data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) reject(new PayloadTooLargeError());
      else resolvePromise(data);
    });
    req.on('error', reject);
  });
}

/**
 * 把 /api/mobile-nav.session.delete 挂到宿主 webServer（exact 路由）。
 * 与 mountPocketAssetRoute 同一套幂等 disposer 归一化模式。
 *
 * 信任栅栏 = web-rpc.js 的 isTrustedLoopbackRequest（与本插件 RPC 路由同一标准）：
 * TCP 源地址必须 loopback + Host 必须 loopback 主机名（IPv6 方括号已处理）+
 * sec-fetch-site 拒 cross-site + Origin 与 Host 严格相等。合法流量的 Host 恒为
 * loopback 权威（dsh-pocket 代理转发前会把 Host/Origin 统一改写为 loopback 权威；
 * 桌面直连 3080 也是 loopback），DNS rebinding（公网域名解析到 127.0.0.1，Host 带
 * 攻击者域名）在 Host 判定上即被拒。另要求 Content-Type: application/json——
 * 表单式 text/plain 简单请求（无预检的跨源 POST 面）直接 415。
 * @param {object} ctx 插件根 context（ctx.get 按请求读服务）。
 * @param {{ warn?: (m: string) => void }} logger 宿主 logger 面。
 * @returns {(() => void) | null} 幂等 disposer；null 表示环境无 webServer。
 */
export function mountSessionDeleteRoute(ctx, logger = console) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;
  const route = {
    kind: 'exact',
    path: '/api/mobile-nav.session.delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST required' } });
        return;
      }
      if (!isTrustedLoopbackRequest(req)) {
        respond(res, 403, { error: { code: 'cross-origin', message: 'cross-origin request rejected: Origin host does not match the request host' } });
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        respond(res, 415, { error: { code: 'unsupported-media-type', message: 'Content-Type: application/json is required' } });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          respond(res, 413, { error: { code: 'payload-too-large', message: `request body exceeds the ${MAX_BODY_BYTES}-byte limit` } });
          return;
        }
        respond(res, 400, { error: { code: 'invalid-body', message: 'expected a JSON body of the form { "sessionId": string }' } });
        return;
      }
      const { sessionId } = body ?? {};
      if (typeof sessionId !== 'string' || sessionId === '') {
        respond(res, 400, { error: { code: 'invalid-session-id', message: 'sessionId must be a non-empty string' } });
        return;
      }
      const persistence = ctx.get?.('sessionPersistence');
      if (persistence === undefined) {
        respond(res, 503, { error: { code: 'persistence-unavailable', message: 'session persistence is not configured' } });
        return;
      }
      const result = await deleteSession({
        persistence,
        sessions: ctx.get?.('sessions'),
        agents: ctx.get?.('agents'),
        workspaceRegistry: ctx.get?.('workspaceRegistry'),
      }, sessionId);
      if (result.ok) {
        respond(res, 200, { ok: true, deleted: result.deleted });
        return;
      }
      logger.warn?.(`dsh-pocket: session-delete failed for '${sessionId}' (${result.error.code}): ${result.error.message}`);
      respond(res, result.status, { error: result.error });
    },
  };
  const registered = webServer.register(route);
  const cleanup = typeof registered === 'function'
    ? () => { try { registered(); } catch { /* 已清理 */ } }
    : (registered && typeof registered.then === 'function')
      ? (() => { let done = false; return async () => { if (done) return; done = true; try { const d = await registered; if (typeof d === 'function') d(); } catch { /* 已清理 */ } }; })()
      : () => {};
  return cleanup;
}
