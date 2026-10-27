// dsh-pocket 设置持久化（$DSH_HOME/dsh-pocket/settings.json）
//
// 当前项：
//   - lanEnabled        局域网访问总开关（默认开启）：关闭后局域网扫码/链接直接失效（代理拒绝局域网 Host）
//   - lanAuthEnabled    局域网访问密码开关（issue #24），默认开启
//   - mobileRightbarEnabled 手机端右边栏入口（默认开启）
//   - mobilePinchZoomEnabled 手机端两指捏合缩放（默认关闭：页面锁 1x）
//   - publicPinCustom   公网密码是否用户自定义（issue #33）
//   - lanPinCustom      局域网密码是否用户自定义（issue #33）
//   - tunnelMode        公网仅支持用户自配的命名隧道；旧 quick 配置不再用于启动
//   - tunnelToken       Cloudflare 命名隧道 Token（issue #66，秘密；文件 0o600，RPC 不回显）
//   - tunnelHostname    命名隧道绑定的固定域名（issue #66，如 pocket.example.com）
// 默认**开启**（安全优先）：局域网扫码也要输 8 位密码；
// 用户可关闭——关闭后局域网扫码直连（仅同一网络内的设备能访问），公网不受影响（永远要密码）。

import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, openSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isValidIpv4 } from './ip.mjs';

const settingsRel = join('dsh-pocket', 'settings.json');
export function settingsPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), settingsRel);
}

// 进程内缓存：代理热路径每个请求会读 3~4 次设置（getToken/isProtected），此前每次都
// readFileSync + JSON.parse。键里带 settingsPath()——测试每个用例切 DSH_HOME，路径一变
// 即失效；2 秒 TTL 兜住外部手工编辑（README 里确有让人直接改 settings.json 的项）。
const CACHE_TTL_MS = 2_000;
let settingsCache = null;

function readSettings() {
  const file = settingsPath();
  if (settingsCache && settingsCache.path === file && Date.now() - settingsCache.at < CACHE_TTL_MS) {
    return settingsCache.data;
  }
  const data = readSettingsFromDisk(file);
  settingsCache = { path: file, at: Date.now(), data };
  return data;
}

/** 绕过进程内缓存，直接读磁盘上的最新内容（跨进程读-改-写用）。 */
function readSettingsFromDisk(file = settingsPath()) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch { /* 无文件/损坏 → 默认 */ }
  return {};
}

// 锁等待/超时：设置写入都是毫秒级，2 秒拿不到锁说明另一进程卡死或崩在临界区里，
// 这时宁可无锁续写（用户点保存不能因此报错），也不要让设置页永久报失败。
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * 跨进程串行化设置写入（桌面版与 dsh web 可能同时跑、共用 $DSH_HOME）。
 * 用一个 O_EXCL 的 .lock 文件做互斥；持锁进程崩溃留下的旧锁按 mtime 判定过期。
 */
function withSettingsLock(fn) {
  const dest = settingsPath();
  const lock = `${dest}.lock`;
  try { mkdirSync(dirname(dest), { recursive: true }); } catch { /* 交给写文件时报错 */ }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      // 锁目录不可写等非「已被占用」错误：无锁执行，让真正的写错误照常抛出
      if (err?.code !== 'EEXIST') return fn();
      try {
        const { mtimeMs } = statSync(lock);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          // 持锁进程已崩溃：删掉过期锁后重试
          try { rmSync(lock, { force: true }); } catch { /* 别人抢先删了 */ }
          continue;
        }
      } catch { /* 锁刚被释放，回到循环重试 */ }
      if (Date.now() >= deadline) {
        console.warn('dsh-pocket: settings lock timeout, writing without lock | 设置锁等待超时');
        return fn();
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* 忽略 */ }
    try { rmSync(lock, { force: true }); } catch { /* 忽略 */ }
  }
}

// 原子写：先写同目录临时文件再 rename 顶替，宿主中途被杀不会留下半截 JSON
// （半截文件会随 readSettings 容错回落默认值，丢掉用户全部设置）。写失败必须
// 抛错让 RPC 层回 ok:false，静默吞错会让设置页显示已保存而实际没落盘。
// 临时文件名带进程号 + 随机串：两个进程同时写时不能共用同一个 .tmp。
function writeSettingsUnlocked(s) {
  const dest = settingsPath();
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const backup = `${dest}.bak`;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    try {
      renameSync(tmp, dest);
    } catch (err) {
      // Windows 上 rename 到已存在目标一般直接覆盖，个别环境报 EEXIST/EPERM
      // （杀软/索引器正持有目标）。此时不能直接删旧文件再改名：第二次 rename
      // 若也失败，用户原有设置就彻底没了。先把旧文件挪成 .bak，改名成功才丢弃。
      if (err?.code !== 'EEXIST' && err?.code !== 'EPERM') throw err;
      let stashed = false;
      try {
        renameSync(dest, backup);
        stashed = true;
      } catch { /* 目标本不存在，直接改名 */ }
      try {
        renameSync(tmp, dest);
      } catch (err2) {
        if (stashed) {
          try { renameSync(backup, dest); } catch { /* 旧文件仍在 .bak，下次读取可回退 */ }
        }
        throw err2;
      }
      if (stashed) { try { rmSync(backup, { force: true }); } catch { /* 忽略 */ } }
    }
    settingsCache = { path: dest, at: Date.now(), data: s };
    return true;
  } catch (err) {
    console.warn(`dsh-pocket: settings write failed | 设置写入失败: ${err?.message ?? err}`);
    settingsCache = null; // 写失败 → 下次读盘拿真实内容，别把内存里的半成品当真
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw err;
  }
}

/**
 * 跨进程读-改-写：以磁盘最新内容为基准合并本次改动。
 * 旧实现是「读缓存/磁盘 → 改 → 整份覆盖」，两个进程先后改不同键时后写者会把
 * 先写者的改动擦掉（审计实测 lanEnabled=false 被另一个进程的写入覆盖回 true）。
 */
function updateSettings(mutator) {
  return withSettingsLock(() => {
    const data = readSettingsFromDisk();
    const next = mutator(data) ?? data;
    writeSettingsUnlocked(next);
    return next;
  });
}

/** 局域网访问总开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanEnabled() {
  return readSettings().lanEnabled !== false;
}

/** 设置局域网访问总开关，返回新状态（持久化）。 */
export function setLanEnabled(on) {
  const s = updateSettings((d) => { d.lanEnabled = !!on; });
  return s.lanEnabled;
}

/** 局域网访问密码开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanAuthEnabled() {
  return readSettings().lanAuthEnabled !== false;
}

/** 设置局域网访问密码开关，返回新状态（持久化）。 */
export function setLanAuthEnabled(on) {
  const s = updateSettings((d) => { d.lanAuthEnabled = !!on; });
  return s.lanAuthEnabled;
}

/** 手机端右边栏入口：默认开启，可按需关闭以保持更紧凑的标题栏。 */
export function mobileRightbarEnabled() {
  return readSettings().mobileRightbarEnabled !== false;
}

/** 设置手机端右边栏入口，返回新状态（持久化）。 */
export function setMobileRightbarEnabled(on) {
  const s = updateSettings((d) => { d.mobileRightbarEnabled = !!on; });
  return s.mobileRightbarEnabled;
}

/** 手机端捏合缩放：默认关闭（页面锁 1x，双击已另行治理），开启恢复捏合。 */
export function mobilePinchZoomEnabled() {
  return readSettings().mobilePinchZoomEnabled === true;
}

/** 设置手机端捏合缩放，返回新状态（持久化）。 */
export function setMobilePinchZoomEnabled(on) {
  const s = updateSettings((d) => { d.mobilePinchZoomEnabled = !!on; });
  return s.mobilePinchZoomEnabled;
}

/** 手机端独立字号（px）：0 = 跟随桌面「字号大小」，12–22 = 手机布局下的覆盖值。 */
export const MOBILE_FONT_MIN = 12;
export const MOBILE_FONT_MAX = 22;

function normalizeMobileFontSize(size) {
  const n = Number(size);
  if (n === 0) return 0;
  if (!Number.isInteger(n) || n < MOBILE_FONT_MIN || n > MOBILE_FONT_MAX) return NaN;
  return n;
}

export function mobileFontSize() {
  return normalizeMobileFontSize(readSettings().mobileFontSize) || 0;
}

/** 设置手机端独立字号（0 恢复跟随桌面），返回生效值（持久化）。 */
export function setMobileFontSize(size) {
  const next = normalizeMobileFontSize(size);
  if (Number.isNaN(next)) {
    throw new Error(`手机端字号必须是 0 或 ${MOBILE_FONT_MIN}–${MOBILE_FONT_MAX} 的整数 | mobile font size must be 0 or an integer in ${MOBILE_FONT_MIN}–${MOBILE_FONT_MAX}`);
  }
  updateSettings((d) => {
    if (next === 0) delete d.mobileFontSize;
    else d.mobileFontSize = next;
  });
  return next;
}

/** 局域网地址手动覆盖：默认空字符串 = 自动选择。 */
export function lanIpOverride() {
  return readSettings().lanIpOverride ?? '';
}

/** 设置局域网地址覆盖；空字符串清除覆盖，恢复自动选择。非法 IPv4 抛错。 */
export function setLanIpOverride(value) {
  const ip = String(value ?? '').trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
  }
  updateSettings((d) => {
    if (ip) d.lanIpOverride = ip;
    else delete d.lanIpOverride;
  });
  return ip;
}

// ---------- 访问密码「自定义」标记（issue #33） ----------
// 用户可把公网/局域网密码设成自己固定的 8–64 位密码（英文字母大小写或数字）。
// 标记存 settings.json：publicPinCustom / lanPinCustom。
const PIN_CUSTOM_KEYS = { public: 'publicPinCustom', lan: 'lanPinCustom' };

/** 该 PIN（public | lan）是否用户自定义过。 */
export function pinCustom(which) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  return readSettings()[key] === true;
}

/** 设置自定义标记，返回新状态。 */
export function setPinCustom(which, on) {
  const key = PIN_CUSTOM_KEYS[which];
  if (!key) return false;
  updateSettings((d) => { d[key] = !!on; });
  return !!on;
}

// ---------- 恢复出厂设置 ----------
// 设置出问题时的临时兜底：删掉 settings.json 即回到出厂默认（文件缺失 = 默认开启，
// 于是局域网访问开、访问密码开、手机端右边栏开、局域网地址自动、公网待配置）。
// DSH 自身的会话、模型、插件配置都在 $DSH_HOME 的其他目录，不受影响。

/** 删除本机设置文件（不存在也算成功）；返回 true 表示已清空。 */
export function resetSettings() {
  settingsCache = null;
  const dest = settingsPath();
  try {
    rmSync(dest, { force: true });
    // 恢复出厂必须把同目录的派生文件一并清掉，否则"已出厂"之后仍可能：
    //  - .bak：下次读取/回滚时看到旧配置；
    //  - .tmp（写失败残留，可能含 tunnelToken）：既不进 git 也不会被宿主清理；
    //  - .lock：持锁进程已死的过期锁（10s 后会被当成 stale，但没必要留）。
    // 用前缀匹配只动本文件的派生名，不碰同目录其它插件文件。
    const dir = dirname(dest);
    const base = dest.slice(dir.length + 1);
    try {
      for (const name of readdirSync(dir)) {
        if (name === base || name.startsWith(`${base}.`)) {
          try { rmSync(join(dir, name), { force: true }); } catch { /* 忽略 */ }
        }
      }
    } catch { /* 目录不存在 */ }
    return true;
  } catch {
    return false;
  }
}

// ---------- 命名隧道配置（issue #66：固定公网域名） ----------
// 用户在 Cloudflare Zero Trust（Networks → Tunnels）创建命名隧道并复制 Tunnel Token，
// 把自己域名的 ingress Service 指向 http://127.0.0.1:<代理端口>；填到这里后，
// 开启公网改用 `cloudflared tunnel run`，公网地址固定为该域名（重启不再变化）。
// token 是长期凭据：只存本机 0o600 文件，RPC 只写不读（回显仅 tokenSet 布尔值）。

/** 旧配置中的 quick 不再启用随机隧道，公网统一使用用户自配的固定域名。 */
export function tunnelMode() {
  return 'named';
}

/** 只有曾显式保存命名隧道配置的用户，才能沿用旧的自动恢复标记。 */
export function tunnelAutoRestoreEnabled() {
  return readSettings().tunnelMode === 'named';
}

function validateTunnelMode(mode) {
  if (mode !== 'named') {
    throw new Error('仅支持自行配置固定域名，随机隧道已移除 | only user-configured named tunnels are supported');
  }
}

export function setTunnelMode(mode) {
  validateTunnelMode(mode);
  updateSettings((d) => { d.tunnelMode = 'named'; });
  return 'named';
}

/** 命名隧道 Token（未配置返回空字符串）。 */
export function tunnelToken() {
  const v = readSettings().tunnelToken;
  return typeof v === 'string' ? v : '';
}

/**
 * 设置命名隧道 Token（持久化）。空字符串清除；非空要求至少 20 个
 * base64url 字符（Cloudflare Token 是长 base64 串，过短/含空白视为无效）。
 */
function normalizeTunnelToken(value) {
  const v = String(value ?? '').trim();
  if (v) {
    if (v.length < 20 || !/^[A-Za-z0-9+/_=-]+$/.test(v)) {
      throw new Error('Tunnel Token 格式不对（应为 Cloudflare 后台复制的完整 Token） | invalid tunnel token');
    }
  }
  return v;
}

export function setTunnelToken(value) {
  const v = normalizeTunnelToken(value);
  updateSettings((d) => {
    if (v) d.tunnelToken = v;
    else delete d.tunnelToken;
  });
  return v;
}

/** 命名隧道绑定的固定域名（未配置返回空字符串）。 */
export function tunnelHostname() {
  const v = readSettings().tunnelHostname;
  return typeof v === 'string' ? v : '';
}

/**
 * 设置固定域名（持久化）。接受 `https://host/path` 粘贴并归一化为裸域名；
 * 空字符串清除。要求是带点的合法公网域名（局域网主机名/裸 IP 不允许——
 * 那不该走公网密码边界之外的东西）。
 */
function normalizeTunnelHostname(value) {
  let v = String(value ?? '').trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (v) {
    const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
    const IS_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
    if (IS_IPV4.test(v) || !v.includes('.') || !HOSTNAME_RE.test(v)) {
      throw new Error('固定域名格式不对（如 pocket.example.com） | invalid tunnel hostname');
    }
  }
  return v;
}

export function setTunnelHostname(value) {
  const v = normalizeTunnelHostname(value);
  updateSettings((d) => {
    if (v) d.tunnelHostname = v;
    else delete d.tunnelHostname;
  });
  return v;
}

/** 先校验完整配置再一次写入，失败时保留原来的域名和 Token。 */
export function setNamedTunnelConfig({ mode = 'named', hostname, token } = {}) {
  validateTunnelMode(mode);
  const written = updateSettings((d) => {
    const nextHostname = normalizeTunnelHostname(hostname === undefined ? d.tunnelHostname : hostname);
    const nextToken = normalizeTunnelToken(token === undefined ? d.tunnelToken : token);
    // 校验在锁内、以磁盘最新值为基准做：抛错时 updateSettings 不会写盘，
    // 原来的域名和 Token 原样保留。
    if (!nextHostname || !nextToken) {
      throw new Error('请先配置自己的固定域名与 Tunnel Token | configure your own fixed hostname and Tunnel Token first');
    }
    d.tunnelMode = 'named';
    d.tunnelHostname = nextHostname;
    d.tunnelToken = nextToken;
  });
  return { mode: 'named', hostname: written.tunnelHostname, tokenSet: true };
}

// ---------- 代理端口（issue #70） ----------
// 局域网代理的监听端口（默认 3081）。插件模式下唯一改法就是写 settings.json 的
// proxyPort 字段（CLI 模式可用 dsh-pocket --port）。允许范围 1-65535；
// 端口已被占用时 dsh web 启动会直接抛 EADDRINUSE（保持原行为），不必在 setter 校验。
/** 当前代理端口（0 = 用默认 3081）。 */
export function proxyPort() {
  const v = Number(readSettings().proxyPort);
  return Number.isInteger(v) && v >= 1 && v <= 65535 ? v : 0;
}

/** 设置代理端口（持久化）。空/0/非法值清除，回退默认 3081。 */
export function setProxyPort(value) {
  const n = Number(value);
  updateSettings((d) => {
    if (Number.isInteger(n) && n >= 1 && n <= 65535) d.proxyPort = n;
    else delete d.proxyPort;
  });
  return proxyPort();
}

// ---------- cloudflared 路径（issue #45：远程 Linux 服务器下载源不可达时手动指定） ----------
// Linux 服务器在国内/部分企业网下，所有 CDN 源（GitHub / ghproxy / gh.ddlc / gh-proxy）
// 都连不上时，下载 cloudflared 二进制始终失败。允许用户在 settings.json 里**写死
// 一个已经存在 / 自己上传的 cloudflared 路径**，跳过下载。`lib/tunnel.mjs` 的
// `resolveCloudflared` 启动时会优先读 `process.env.DSH_POCKET_CLOUDFLARED`，
// 找不到再回退到 PATH 探测和下载。`lib/index.js` 在插件 apply 时把 settings
// 的这个值写入 env，确保 service 走自定义路径。
// 空字符串 = 清除，回退到默认行为（PATH 探测 + 下载）。
/** 当前 cloudflared 自定义路径（空 = 用默认）。 */
export function cloudflaredPath() {
  return readSettings().cloudflaredPath ?? '';
}

/** 设置 cloudflared 自定义路径。空字符串清除（回退到 PATH 探测 + 下载）。 */
export function setCloudflaredPath(value) {
  const v = String(value ?? '').trim();
  updateSettings((d) => {
    if (v) d.cloudflaredPath = v;
    else delete d.cloudflaredPath;
  });
  return v;
}
