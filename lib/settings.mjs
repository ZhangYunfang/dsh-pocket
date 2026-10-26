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

import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
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
  let data = {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') data = raw;
  } catch { /* 无文件/损坏 → 默认 */ }
  settingsCache = { path: file, at: Date.now(), data };
  return data;
}

// 原子写：先写同目录临时文件再 rename 顶替，宿主中途被杀不会留下半截 JSON
// （半截文件会随 readSettings 容错回落默认值，丢掉用户全部设置）。写失败必须
// 抛错让 RPC 层回 ok:false，静默吞错会让设置页显示已保存而实际没落盘。
function writeSettings(s) {
  const dest = settingsPath();
  const tmp = `${dest}.tmp`;
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

/** 局域网访问总开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanEnabled() {
  return readSettings().lanEnabled !== false;
}

/** 设置局域网访问总开关，返回新状态（持久化）。 */
export function setLanEnabled(on) {
  const s = readSettings();
  s.lanEnabled = !!on;
  writeSettings(s);
  return s.lanEnabled;
}

/** 局域网访问密码开关：默认开启（文件缺失/损坏都视为开启）。 */
export function lanAuthEnabled() {
  return readSettings().lanAuthEnabled !== false;
}

/** 设置局域网访问密码开关，返回新状态（持久化）。 */
export function setLanAuthEnabled(on) {
  const s = readSettings();
  s.lanAuthEnabled = !!on;
  writeSettings(s);
  return s.lanAuthEnabled;
}

/** 手机端右边栏入口：默认开启，可按需关闭以保持更紧凑的标题栏。 */
export function mobileRightbarEnabled() {
  return readSettings().mobileRightbarEnabled !== false;
}

/** 设置手机端右边栏入口，返回新状态（持久化）。 */
export function setMobileRightbarEnabled(on) {
  const s = readSettings();
  s.mobileRightbarEnabled = !!on;
  writeSettings(s);
  return s.mobileRightbarEnabled;
}

/** 手机端捏合缩放：默认关闭（页面锁 1x，双击已另行治理），开启恢复捏合。 */
export function mobilePinchZoomEnabled() {
  return readSettings().mobilePinchZoomEnabled === true;
}

/** 设置手机端捏合缩放，返回新状态（持久化）。 */
export function setMobilePinchZoomEnabled(on) {
  const s = readSettings();
  s.mobilePinchZoomEnabled = !!on;
  writeSettings(s);
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
  const s = readSettings();
  if (next === 0) delete s.mobileFontSize;
  else s.mobileFontSize = next;
  writeSettings(s);
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
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
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
  const s = readSettings();
  s[key] = !!on;
  writeSettings(s);
  return !!on;
}

// ---------- 恢复出厂设置 ----------
// 设置出问题时的临时兜底：删掉 settings.json 即回到出厂默认（文件缺失 = 默认开启，
// 于是局域网访问开、访问密码开、手机端右边栏开、局域网地址自动、公网待配置）。
// DSH 自身的会话、模型、插件配置都在 $DSH_HOME 的其他目录，不受影响。

/** 删除本机设置文件（不存在也算成功）；返回 true 表示已清空。 */
export function resetSettings() {
  settingsCache = null;
  try {
    rmSync(settingsPath(), { force: true });
    // 写失败时 writeSettings 可能留下 .bak，恢复出厂必须一并清掉，
    // 否则下次读盘会看到"已出厂"但实际上备份里还有旧配置。
    try { rmSync(`${settingsPath()}.bak`, { force: true }); } catch { /* 忽略 */ }
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
  writeSettings({ ...readSettings(), tunnelMode: 'named' });
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
  const s = { ...readSettings() };
  if (v) s.tunnelToken = v;
  else delete s.tunnelToken;
  writeSettings(s);
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
  const s = { ...readSettings() };
  if (v) s.tunnelHostname = v;
  else delete s.tunnelHostname;
  writeSettings(s);
  return v;
}

/** 先校验完整配置再一次写入，失败时保留原来的域名和 Token。 */
export function setNamedTunnelConfig({ mode = 'named', hostname, token } = {}) {
  validateTunnelMode(mode);
  const current = readSettings();
  const nextHostname = normalizeTunnelHostname(hostname === undefined ? current.tunnelHostname : hostname);
  const nextToken = normalizeTunnelToken(token === undefined ? current.tunnelToken : token);
  if (!nextHostname || !nextToken) {
    throw new Error('请先配置自己的固定域名与 Tunnel Token | configure your own fixed hostname and Tunnel Token first');
  }
  writeSettings({ ...current, tunnelMode: 'named', tunnelHostname: nextHostname, tunnelToken: nextToken });
  return { mode: 'named', hostname: nextHostname, tokenSet: true };
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
  const s = readSettings();
  if (Number.isInteger(n) && n >= 1 && n <= 65535) s.proxyPort = n;
  else delete s.proxyPort;
  writeSettings(s);
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
  const s = readSettings();
  if (v) s.cloudflaredPath = v;
  else delete s.cloudflaredPath;
  writeSettings(s);
  return v;
}
