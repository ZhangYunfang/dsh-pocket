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
    // 数组也是 object：`[]` 不能当有效配置（否则会拦掉 .bak 回退，全部落默认值）。
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* 无文件/损坏 → 默认 */ }
  // 主文件缺失但上次「rename 覆盖失败」留下了 .bak 时，回退读 .bak：旧实现把 .bak
  // 当作「下次读取可回退」，实际没有任何读取方，主文件一丢就等于恢复出厂（连
  // tunnelToken 一起丢）。只在主文件读不出来时才回退，避免旧备份盖掉新配置。
  try {
    const raw = JSON.parse(readFileSync(`${file}.bak`, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch { /* 没有备份 */ }
  return {};
}

// 锁等待/超时：设置写入都是毫秒级，健康持锁进程几毫秒内就会释放。等待预算不能
// 太长——锁等待是同步 sleep（Atomics.wait），等多久主线程就卡多久，期间整个 Web
// GUI 无响应（审计实测 2 秒预算会让每次设置写都卡 2s）。750ms 足够覆盖正常竞争。
// 超时后仍然无锁续写（用户点保存不能因此报错），但 stale 分支必须保证一定能退出。
const LOCK_WAIT_MS = 750;
const LOCK_STALE_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * 跨进程串行化设置写入（桌面版与 dsh web 可能同时跑、共用 $DSH_HOME）。
 * 用一个 O_EXCL 的 .lock 文件做互斥；持锁进程崩溃留下的旧锁按 mtime 判定过期。
 *
 * 默认超时后「无锁续写」：普通设置保存不能让用户因为一时竞争就点不动。但恢复出厂
 * （reset）必须例外——它要确认自己真的把文件删干净了，超时无锁执行会被另一进程
 * 随后整份写回，变成「提示成功、实际撤销」，所以 reset 传 mustLock。
 */
function withSettingsLock(fn, { mustLock = false } = {}) {
  const dest = settingsPath();
  const lock = `${dest}.lock`;
  const lockTimeout = () => {
    if (mustLock) throw new Error('设置文件正被另一个进程写入，请稍后重试 | settings file is locked by another process');
    console.warn('dsh-pocket: settings lock timeout, writing without lock | 设置锁等待超时');
    return fn();
  };
  try { mkdirSync(dirname(dest), { recursive: true }); } catch { /* 交给写文件时报错 */ }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      // 锁目录不可写等非「已被占用」错误：无锁执行，让真正的写错误照常抛出
      if (err?.code !== 'EEXIST') {
        if (mustLock) throw err;
        return fn();
      }
      // 过期锁：如果删得掉就立即重试；删不掉（同名目录、EBUSY/杀软持有、ACL 拒绝）
      // 不能再 `continue`——旧实现从 stale 分支直接回到循环顶部，跳过了 deadline 与
      // sleep，锁删不掉时变成 100% CPU 的无限忙等（设置写入永久挂死）。
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch { /* 锁刚被释放，回到循环重试 */ }
      if (stale) {
        try {
          rmSync(lock, { force: true });
        } catch { /* 删不掉：下面按「再等一会儿/超时兜底」处理 */ }
        let gone = false;
        try { statSync(lock); } catch { gone = true; }
        if (gone) {
          // 已删掉过期锁，立刻重试抢锁（不 sleep）。但截止时间仍要判：否则对手
          // 每轮抢在我们前面重建一个过期锁时，会无限循环。
          if (Date.now() >= deadline) return lockTimeout();
          continue;
        }
        // 删不掉：不要空转，推进到 deadline 判定
      }
      if (Date.now() >= deadline) return lockTimeout();
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    // 只清理「本次真正持有了」的锁：超时后无锁执行时 fd 仍为 null，此时锁文件属于
    // 另一个进程（或崩溃残留），删掉它会破坏别人的互斥。
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 忽略 */ }
      try { rmSync(lock, { force: true }); } catch { /* 忽略 */ }
    }
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
  const dir = dirname(dest);
  const base = dest.slice(dir.length + 1);
  // 只删本文件与它自己的派生文件：`.bak`、`.lock` 之外的 `.tmp`（旧版本的固定临时名，
  // 可能含 tunnelToken）、`<pid>.<hex>.tmp`，以及崩溃/被占用时留下的 reset 墓碑。
  // 旧实现按 `name.startsWith(`${base}.`)` 扫全目录，会误删用户自己起名的
  // `settings.json.mybackup`，还会删掉另一个进程正持有的 `.lock`（把互斥破坏掉）。
  // 锁文件由 withSettingsLock 在持锁期间/释放时处理。
  const suffix = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const derived = new RegExp(`^${suffix}(?:\\.bak|\\.tmp|\\.\\d+\\.[0-9a-f]+\\.tmp|\\.reset-[0-9a-zA-Z-]+\\.tmp)$`);
  // 先把主文件改名成墓碑、删干净派生文件后再丢墓碑：任何一步失败都能把墓碑改回
  // 原文件，保证「报失败时用户配置还在」。旧实现先删主文件、再逐个吞掉派生文件的
  // 删除错误，于是 `.bak` 删不掉也返回 true——新加的 .bak 回退会在下次启动时把
  // 旧配置（含 tunnelToken）整份复活，恢复出厂形同虚设。
  const tomb = `${dest}.reset-${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.tmp`;
  const tombName = tomb.slice(dir.length + 1);
  let ok = false;
  try {
    withSettingsLock(() => {
      let moved = false;
      try {
        renameSync(dest, tomb);
        moved = true;
      } catch (err) {
        // ENOENT = 本来就没有配置文件，继续删派生文件；其它错误（被占用/是目录/ACL）
        // 一律如实报失败，别把「没清掉」说成「已恢复出厂」。
        if (err?.code !== 'ENOENT') return;
      }
      const failures = [];
      let names = [];
      try { names = readdirSync(dir); } catch { names = []; }
      for (const name of names) {
        if (!derived.test(name)) continue;
        // 本次的墓碑要留到确认全部删成功后再丢（失败时还要拿它回滚）；其它历史墓碑清掉。
        if (name === tombName) continue;
        try { rmSync(join(dir, name), { force: true }); } catch { failures.push(name); }
      }
      if (failures.length > 0) {
        console.warn(`dsh-pocket: reset failed to remove ${failures.join(', ')}; rolling back | 恢复出厂未能删除派生文件，已回滚`);
        if (moved) {
          try { renameSync(tomb, dest); } catch { /* 墓碑仍在，用户可手动改回 */ }
        }
        return;
      }
      if (moved) {
        try { rmSync(tomb, { force: true }); } catch {
          // 主文件删不掉：回滚，避免出现「主文件没了、墓碑又留着」的半清空状态。
          try { renameSync(tomb, dest); } catch { /* 尽力 */ }
          return;
        }
      }
      settingsCache = null;
      ok = true;
    }, { mustLock: true });
  } catch {
    ok = false;
  }
  return ok;
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
