// dsh-pocket 插件入口（单包单插件：手机扫码访问 DSH，全在这一个包里）
//
// 设置一级入口「手机访问」：
//   - 局域网二维码：自动显示（代理随插件启动）
//   - 公网二维码：点「开启公网」→ cloudflared 隧道 → 扫码即用，人在外面也能访问
//   - 更新提示：有新版本时显示一键更新按钮（dsh plugin update --latest）
// 手机看到的界面 = 电脑上的 dsh web，实时同步（WebSocket 透传）。
//
// 注：Web Push 已移除——浏览器推送依赖 Google FCM（Chrome）等境外服务，
// 国内直连被墙，普通用户用不了，且排障成本高。专注扫码同屏这一件事。

import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';

import { createPocketService } from './service.mjs';
import { installPocketRpc } from './web-rpc.js';
import { restartHost } from './restart.js';
import { mountSessionDeleteRoute, scheduleTrashPurge } from './delete-session.mjs';
import { advancedNoticeScript, DEFAULT_INJECT, classifyHost } from './proxy.mjs';
import { lanEnabled, setLanEnabled, lanAuthEnabled, setLanAuthEnabled, mobileRightbarEnabled, setMobileRightbarEnabled, mobilePinchZoomEnabled, setMobilePinchZoomEnabled, mobileFontSize, setMobileFontSize, lanIpOverride, setLanIpOverride, pinCustom, setPinCustom, tunnelMode, tunnelAutoRestoreEnabled, setNamedTunnelConfig, tunnelToken, tunnelHostname, resetSettings, proxyPort, cloudflaredPath } from './settings.mjs';

const name = 'dsh-pocket';
const inject = ['connection', 'webServer'];

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));

/**
 * 本插件磁盘上的已安装版本。注意：**不能用 require 缓存**（进程内永远不变），
 * 必须实时读文件——一键更新会改写 package.json，「已更新未重启」靠它识别。
 */
function currentVersion() {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** 进程启动时加载的版本（模块加载瞬间固化；用于识别「磁盘已更新但进程还是旧代码」）。 */
const loadedVersion = currentVersion();

/**
 * 本插件 package.json 的 repository.url（安装来源仓库）。
 * fork/分支安装（如 github.com/daha1216/dsh-pocket）与 npm 上游
 * （shaobeichen/dsh-pocket）不同源——版本号滞后是常态，据此抑制
 * 「npm 有新版」横幅并拦截一键更新（否则上游代码会盖掉本地修改）。
 */
function currentRepository() {
  try {
    const repo = JSON.parse(readFileSync(pkgPath, 'utf8')).repository;
    return typeof repo === 'string' ? repo : (repo?.url ?? null);
  } catch {
    return null;
  }
}

// ---------- 访问密码（issue #13 + #18 + #33） ----------
// 公网与局域网**分开**：各自 8 位，存本机 $DSH_HOME/dsh-pocket/。
// 公网密码（token）：默认每次开启公网时轮换（旧链接作废）；**用户自定义后不再轮换**；
// 局域网密码（token-lan）：默认手动刷新（设置页按钮）；自定义后刷新会换回随机值。
// 会话保持（issue #33）：登录 cookie 绑定进程级 sessionKey（见 apply）——
// dsh web 重启/更新后 sessionKey 变化 → 手机需重新输入。
// 默认 PIN 为 8 位数字；自定义 PIN 可使用 8–64 位英文字母（大小写）或数字。
const PIN_RE = /^[a-zA-Z0-9]{8,64}$/;
// 进程内 PIN 缓存：代理每个请求都会按 Host 取一次 PIN（tokenForHost），此前每次都
// readFileSync；更要紧的是写盘失败时的兜底——此前吞掉写错误仍返回新 PIN，下次调用
// 读不到文件又生成一个不同的 PIN，登录页显示的和实际比对的不是同一个值。
// 键带路径：测试每个用例切 DSH_HOME，路径一变即失效。
const pinCache = new Map();
/** 每个 PIN 文件最近一次落盘失败原因（成功后清除）：让设置页能区分"已持久化"和"仅内存"。 */
const pinWriteError = new Map();
/** 写盘失败后的重试节流：每个文件最多每秒试一次，避免每个请求都撞一次磁盘/日志。 */
const pinRetryAfter = new Map();
const PIN_RETRY_INTERVAL_MS = 1_000;
function writePinToFile(p, fresh) {
  try {
    mkdirSync(dirname(p), { recursive: true });
    // 原子写：先写同目录唯一临时文件再 rename 顶替。直接覆盖原文件时，宿主在
    // 写入中途被杀会留下半截 PIN（readPin 判为非法 → 下次启动重新生成），
    // 手机端保存的密码就莫名失效了。临时名带进程号 + 随机串，避免两个实例互踩。
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, fresh, { mode: 0o600 });
    try {
      renameSync(tmp, p);
    } catch (err) {
      try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      throw err;
    }
    pinCacheEntry(p, fresh);
  } catch (err) {
    // 写盘失败：内存值仍然有效（本次运行可用），但必须让调用方知道「重启后会变」，
    // 否则设置页会宣称密码已保存而磁盘上还是旧值。pinWriteError 记录失败原因。
    pinCacheEntry(p, fresh);
    pinWriteError.set(p, err?.message ?? String(err));
    console.warn(`dsh-pocket: access PIN write failed | 访问密码写入失败，本次运行使用内存值: ${err?.message ?? err}`);
    return fresh;
  }
  pinWriteError.delete(p);
  pinRetryAfter.delete(p);
  return fresh;
}

/** 记录 PIN 缓存值 + 记录当时文件的 mtime，用于发现「另一个实例换了密码」。 */
function pinCacheEntry(p, pin) {
  let mtimeMs = 0;
  try { mtimeMs = statSync(p).mtimeMs; } catch { /* 文件不存在（写盘失败时） */ }
  pinCache.set(p, { pin, mtimeMs });
}

/** 读最近一次 PIN 落盘失败原因；仅供 RPC 层判定「是否真的持久化」。 */
export function pinWriteWarning(which) {
  const p = which === 'lan' ? lanTokenPath() : tokenPath();
  return pinWriteError.get(p) ?? null;
}
function readPin(p) {
  const cached = pinCache.get(p);
  if (cached !== undefined) {
    let current = 0;
    let gone = false;
    try {
      current = statSync(p).mtimeMs;
    } catch (err) {
      gone = err?.code === 'ENOENT';
    }
    if (gone) {
      // 写盘失败（pinWriteError 有记录）→ 内存值仍然有效，不能因为读不到文件就轮换密码。
      if (pinWriteError.has(p)) {
        // 障碍可能已经消失（磁盘满解除/ACL 修好/杀软放行）：补一次落盘，否则设置页
        // 显示的 PIN 只能用到下次重启——重启后会生成新 PIN，用户按页面上的值登录被拒。
        if (Date.now() >= (pinRetryAfter.get(p) ?? 0)) {
          pinRetryAfter.set(p, Date.now() + PIN_RETRY_INTERVAL_MS);
          writePinToFile(p, cached.pin); // 成功会自己清 pinWriteError 并刷新缓存
        }
        return cached.pin;
      }
      // 文件被删除：缓存必须一起失效，让调用方重新生成并落盘。旧实现把「文件不存在」
      // 也当成 current <= cached.mtimeMs 直接返回缓存，于是 PIN 文件再也不重建——
      // 设置页显示旧密码，重启后变成新密码，用户完全对不上。
      pinCache.delete(p);
      pinRetryAfter.delete(p);
      return null;
    }
    // 文件没被别的实例动过 → 直接用缓存（含「写盘失败、仅内存可用」的值）。
    // Windows 的 mtime 粒度较粗（同一 tick 改写时甚至完全相同），只比时间会把
    // 「已改写」当「没变」，两个实例各用一个 PIN。差不到 1ms 就按同 tick 处理、比内容。
    if (Math.abs(current - cached.mtimeMs) < 1) {
      try {
        const existing = readFileSync(p, 'utf8').trim();
        if (PIN_RE.test(existing) && existing !== cached.pin) {
          pinCache.set(p, { pin: existing, mtimeMs: current });
          return existing;
        }
      } catch { /* 读失败按缓存走 */ }
      return cached.pin;
    }
    if (current < cached.mtimeMs) return cached.pin;
    // 文件比缓存新：另一个实例（桌面版 / dsh web）刷新过密码，跟随磁盘。
    try {
      const existing = readFileSync(p, 'utf8').trim();
      if (PIN_RE.test(existing)) {
        pinCache.set(p, { pin: existing, mtimeMs: current });
        return existing;
      }
    } catch { /* 读失败按缓存走 */ }
    return cached.pin;
  }
  try {
    const existing = readFileSync(p, 'utf8').trim();
    if (PIN_RE.test(existing)) {
      pinCacheEntry(p, existing);
      return existing;
    }
  } catch { /* 无文件 */ }
  return null;
}
/**
 * 生成 8 位访问 PIN（issue #90）。
 * 必须用 CSPRNG。语言内置的非加密随机数（V8 的 xorshift128+）是可预测的：拿到少量
 * 输出即可还原内部状态并推算后续值——用它生成访问密码，等于把 9×10⁷ 的搜索空间
 * 进一步压缩。`randomInt(min, max)` 上界开区间，取值 10000000..99999999。
 * test/auth-routing.test.js 有源码守卫，禁止这里再出现非加密随机数调用。
 */
function newPin() {
  return String(randomInt(10_000_000, 100_000_000));
}

// --- 公网密码 ---
const tokenRel = join('dsh-pocket', 'token');
function tokenPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), tokenRel);
}
/** 当前公网访问密码；文件不存在时生成一个。 */
export function getAccessToken() {
  return readPin(tokenPath()) ?? writePinToFile(tokenPath(), newPin());
}
/** 轮换公网密码（开启公网时调用）。用户自定义后不再轮换（尊重自定义值）。 */
export function rotateAccessToken() {
  if (pinCustom('public')) return getAccessToken();
  return writePinToFile(tokenPath(), newPin());
}

// --- 局域网密码（issue #18：局域网与公网分开，手动刷新） ---
const lanTokenRel = join('dsh-pocket', 'token-lan');
function lanTokenPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), lanTokenRel);
}
/** 当前局域网访问密码；文件不存在时生成一个。 */
function getLanToken() {
  return readPin(lanTokenPath()) ?? writePinToFile(lanTokenPath(), newPin());
}
/** 刷新局域网密码（设置页按钮触发，旧密码立即作废）；换新后清除自定义标记。 */
function refreshLanToken() {
  setPinCustom('lan', false);
  return writePinToFile(lanTokenPath(), newPin());
}
/**
 * 按 Host 分发的访问密码（issue #66：fail closed）。
 * 公网 = classifyHost 判为 public 的 Host（用户配置的固定域名或其他陌生域名），
 * 一律校验公网密码；loopback/局域网（私网 IP、.local 等）才走局域网密码——
 * 自建隧道 + 关闭局域网密码不再出现公网裸奔。
 */
export function tokenForHost(host) {
  if (isLanOverrideHost(host)) return getLanToken();
  return classifyHost(host) === 'public' ? getAccessToken() : getLanToken();
}

/** 局域网和固定域名的 PIN 都长期有效，允许密码管理器保存。 */
export function credentialKindForHost(_host) {
  return 'persistent';
}
/** 去掉 Host 的端口（与 classifyHost 一致），用于和手动设置的局域网地址比较。 */
function hostNameOnly(host) {
  let name = String(host ?? '').trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end >= 0) name = name.slice(1, end);
  } else {
    name = name.replace(/:\d+$/, '');
  }
  return name;
}
/**
 * 用户手动指定的「局域网地址」覆盖（issue #79）：无论什么网段（含 Radmin 26.x 等任意 overlay），
 * 一律按局域网密码/开关裁决。优先级高于 classifyHost——避免某 overlay 地址落在公网判定里、
 * 导致局域网入口被错判成公网、比对成公网密码而永远「密码错误」。
 */
export function isLanOverrideHost(host) {
  const override = lanIpOverride().trim().toLowerCase();
  return override.length > 0 && hostNameOnly(host) === override;
}
/**
 * 用户自定义访问密码（issue #33）：公网/局域网各自设置固定的 8–64 位密码（英文字母大小写或数字）。
 * 自定义后公网开启时不再自动轮换（rotateAccessToken 见上）。
 * 非法输入（少于 8 位、超过 64 位或含字母数字以外字符）抛错，由 RPC 层转成错误响应。
 */
export function setCustomPin(which, value) {
  const v = String(value ?? '').trim();
  if (v === '') {
    setPinCustom(which, false);
    if (which === 'public') return writePinToFile(tokenPath(), newPin());
    if (which === 'lan') return writePinToFile(lanTokenPath(), newPin());
  }
  if (!PIN_RE.test(v)) throw new Error('密码必须是 8–64 位英文字母或数字 | PIN must be 8–64 characters (letters and digits only)');
  if (which === 'public') {
    writePinToFile(tokenPath(), v);
    setPinCustom('public', true);
    return v;
  }
  if (which === 'lan') {
    writePinToFile(lanTokenPath(), v);
    setPinCustom('lan', true);
    return v;
  }
  throw new Error('未知密码类型 | unknown PIN kind');
}

/**
 * 恢复出厂设置（设置页底部按钮）：清空本机设置 + 重设随机访问密码。
 *
 * 删除 settings.json → 所有开关回到默认（局域网访问开、访问密码开、局域网地址自动、
 * 公网模式随机、固定域名/Tunnel Token 清空）；公网与局域网密码都换新随机 8 位值
 * （旧密码立即作废，手机需重新输入）。只动 $DSH_HOME/dsh-pocket/ 下的文件，
 * DSH 自身的会话、模型、插件配置不受影响。
 *
 * 注意：调用方应先停掉正在运行的公网隧道（RPC 层已处理），避免重置后仍按旧模式连接。
 * @returns {{accessToken:string, lanToken:string}} 重置后的新密码
 */
export function resetPocketState() {
  const settingsCleared = resetSettings();
  writePinToFile(tokenPath(), newPin());
  writePinToFile(lanTokenPath(), newPin());
  return {
    accessToken: getAccessToken(),
    lanToken: getLanToken(),
    settingsCleared,
    warnings: [
      ...(settingsCleared ? [] : ['settings.json 未能清空（可能被另一个进程占用或无法删除），开关仍是旧值 | settings.json not cleared (locked or undeletable)']),
      ...(pinWriteError.has(tokenPath()) ? [`公网密码仅存在于内存：${pinWriteError.get(tokenPath())}`] : []),
      ...(pinWriteError.has(lanTokenPath()) ? [`局域网密码仅存在于内存：${pinWriteError.get(lanTokenPath())}`] : []),
    ],
  };
}

const restartNoticeRel = join('dsh-pocket', 'restarted.json');
function restartNoticePath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), restartNoticeRel);
}
async function readRestartNotice() {
  try {
    const raw = JSON.parse(await readFile(restartNoticePath(), 'utf8'));
    if (!raw?.at) return null;
    if (Date.now() - raw.at > 30 * 60 * 1000) return null; // 30 分钟后过期
    return raw;
  } catch { return null; }
}
function writeRestartNotice() {
  return mkdir(dirname(restartNoticePath()), { recursive: true })
    .then(() => writeFile(restartNoticePath(), JSON.stringify({ at: Date.now(), pid: process.pid }), 'utf8'));
}
/**
 * 读重启标记并**删除**（一次性消费）：重启后首次打开设置页显示一次「已重启」横幅，
 * 之后不再出现——否则残留文件会让「已重启」一直显示（用户没点重启也误报）。
 */
async function consumeRestartNotice() {
  const notice = await readRestartNotice();
  if (notice) {
    await rm(restartNoticePath(), { force: true }).catch(() => {});
  }
  return notice;
}
/**
 * 自重启。
 * 顺序很重要：先拉起 helper（失败就如实返回，不写标记、不停隧道）→ 停公网隧道
 * （否则孤儿 cloudflared 让旧公网 URL 永活，与「重启即换 URL 作废」的宣传矛盾）→
 * 写重启标记（新进程据此显示一次「已重启」横幅）。
 */
function pocketRestart(service) {
  // 传宿主实际端口：argv 里没有 --port 时 restart.js 会回退 3080，
  // 与真实监听端口不一致会让交接辅助进程白等 20 秒。
  const result = restartHost({ dshPort: service?.dshPort });
  if (!result || result.helperPid == null) return result; // helper 都没 spawn 出来 → 失败
  // 停隧道是为了杀孤儿 cloudflared；保留自动恢复标记——重启后隧道要自动拉起（issue #11）
  try { service?.stopTunnel({ keepAutoMarker: true }); } catch { /* 忽略 */ }
  writeRestartNotice().catch(() => {});
  return result;
}

/** 执行更新：dsh plugin --profile <p> update dsh-pocket --latest -w（超时保护）。 */
const UPDATE_PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 推断本插件装在哪个 dsh profile 下：插件路径形如
 * `$DSH_HOME/profiles/<profile>/node_modules/dsh-pocket/lib/index.js`。
 * 客户端从不传 profile，旧代码写死 'web' —— 只装在 desktop profile 的机器
 * 会去更新 web profile（不存在/是另一份），点一键更新也不会真的升级。
 */
export function profileFromPath(here) {
  // 兼容 pnpm 的 junction 布局：node 会把 `node_modules/dsh-pocket` 解析成
  // `<profile>/node_modules/.pnpm/dsh-pocket@<ver>/node_modules/dsh-pocket` →
  // 中间多一层 `.pnpm/...`。旧正则不认，直接退回 'web'，一键更新打到错误 profile。
  const normalized = String(here ?? '').replace(/\\/g, '/');
  const m = /\/profiles\/([^/]+)\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?dsh-pocket\//.exec(normalized);
  if (m && UPDATE_PROFILE_RE.test(m[1])) return m[1];
  return 'web';
}

function inferProfile() {
  try {
    return profileFromPath(fileURLToPath(new URL('..', import.meta.url)));
  } catch { /* 非标准安装路径 */ }
  return 'web';
}

function performUpdate(profile, { timeoutMs = 180_000 } = {}) {
  const target = profile === undefined || profile === null || profile === '' ? inferProfile() : String(profile);
  // profile 来自 RPC 请求体，而 win32 下必须 shell:true 才能 spawn dsh.cmd——
  // 不校验就等于把命令行交给已认证客户端拼（纵深防御；正常值是 desktop/web 这类短名）。
  if (!UPDATE_PROFILE_RE.test(target)) {
    return Promise.resolve({ ok: false, error: '非法的 profile 名称 | invalid profile name' });
  }
  return new Promise((resolve) => {
    const child = spawn('dsh', ['plugin', '--profile', target, 'update', 'dsh-pocket', '--latest', '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上裸 spawn('dsh') 解析到无扩展名 POSIX shim → ENOENT；
      // Node 22+ 直接 spawn .cmd 会 EINVAL（CVE-2024-27980），必须走 shell（PR #54）
      shell: process.platform === 'win32',
    });
    let out = '';
    const onData = (c) => { out += String(c); if (out.length > 4000) out = out.slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Windows 下 shell:true 的 child 是 cmd.exe，kill 它不会带走下面的
      // node/pnpm 孙进程——它们会继续改写 node_modules，把一次"超时取消"
      // 变成仍在后台进行的半截更新（审计实测）。必须按进程树整棵杀。
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            .once('error', () => {});
        } catch { /* 回退到 child.kill() */ }
      }
      try { child.kill(); } catch { /* 已退出 */ }
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, output: out.slice(-800) });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

export function apply(ctx, config = {}, internals = {}) {
  const logger = ctx.logger?.(name) ?? console;
  const dshPort = internals.dshPort ?? ctx.webServer?.port;
  if (!dshPort) {
    logger.error('dsh-pocket: webServer port unavailable — cannot start proxy | 拿不到 dsh web 端口，无法启动代理');
    return () => {};
  }

  // cloudflared 自定义路径（issue #45）：远程 Linux 服务器下载源全失败时，
  // 让用户能在 settings.json 写死一个已经存在的二进制路径，绕过自动下载。
  // 同步到 env 让 lib/tunnel.mjs 的 resolveCloudflared 第一时间读到。
  const cfPath = cloudflaredPath();
  if (cfPath) {
    process.env.DSH_POCKET_CLOUDFLARED = cfPath;
    logger.info(`dsh-pocket: using custom cloudflared at ${cfPath} (skipping auto-download) | 使用自定义 cloudflared 路径（跳过自动下载）`);
  }

  // 桌面端环境识别（官方兼容模式，见 desktop 的 plugin-development.md）：
  // 旧判定只认 desktopProfiles / desktopPnpm 两个 ctx 服务，但 dsh-desktop-host
  // 0.2.0-rc.2 起不再提供（改名/移除），导致桌面版被误判为非桌面 → 重启/更新拦截失效
  // （issue #177 / #167：pocketRestart 杀宿主、拉孤儿进程抢端口 EADDRINUSE）。
  // 现改为优先用 Electron 运行时特征（process.versions.electron / ELECTRON_RUN_AS_NODE），
  // 再回退到旧的 ctx 服务名；宿主仍可用 internals.isDesktop 显式下发。
  const isDesktop = internals.isDesktop !== undefined
    ? internals.isDesktop === true
    : Boolean(process.versions.electron)
      || process.env.ELECTRON_RUN_AS_NODE !== undefined
      || ctx.get?.('desktopProfiles') !== undefined
      || ctx.get?.('desktopPnpm') !== undefined;
  if (isDesktop) {
    logger.info('dsh-pocket: DSH Desktop detected — update/restart disabled here | 检测到桌面端环境，更新/重启已关闭');
  }

  // 桌面端 advanced 模式检测（issue #19）：dsh-plugin-desktop 的 mode 配置存在
  // $DSH_HOME/settings.yaml 的 dsh-plugin-desktop 命名空间下。advanced 组合禁用网页版
  // ui-layout、手机页面又拿不到桌面 layout → 手机访问白屏，这里注入覆盖层提示用户切回。
  const desktopAdvanced = isDesktop && (() => {
    try {
      const raw = readFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'settings.yaml'), 'utf8');
      // 取 dsh-plugin-desktop 命名空间的整块（到下一个顶层键为止）再看 mode。
      // 旧实现用 [\s\S]{0,300} 窗口：块里先出现别的键、或中间注释变长，就会漏判。
      const start = raw.search(/^dsh-plugin-desktop\s*:/m);
      if (start < 0) return false;
      const block = raw.slice(start);
      const afterKey = block.indexOf(':') + 1;
      const nextKey = block.slice(afterKey).search(/^\S/m);
      const scope = nextKey < 0 ? block : block.slice(0, afterKey + nextKey);
      return /mode\s*:\s*advanced/i.test(scope);
    } catch { return false; }
  })();
  if (desktopAdvanced) {
    logger.warn('dsh-pocket: DSH Desktop advanced mode — phone access unsupported, injecting notice | 桌面端 advanced 模式：手机访问暂不支持，已注入提示');
  }

  const service = internals.service ?? createPocketService({
    dshPort,
    // 端口（issue #70）：插件模式优先级 settings.proxyPort > cordis patch config.port > 3081。
    // 3081 被占时 createPocketService 内部 EADDRINUSE 抛错，按 DSH 插件启动失败处理（用户改端口重启即可）。
    port: internals.port ?? config.port ?? (proxyPort() || 3081),
    home: internals.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    internals,
    getLanIpOverride: () => lanIpOverride(),
    getLanEnabled: () => lanEnabled(),
    // 桌面端**不再**注入 dsh-desktop-* 标记（issue #76）：
    //   - 旧版 dsh-plugin-desktop 缺 mode/platform 会抛错，当初正是为此加了补丁（issue #3/#4）；
    //   - 但 2.0.3 起，mode 与 platform **同时缺失**时 parseDesktopClientEnvironment 直接返回
    //     undefined（视作非桌面外壳，跳过全部桌面逻辑），正是手机页需要的效果；
    //   - 反之只要 URL 上出现任一 dsh-desktop-* 标记，客户端就会强制校验整组
    //     （material + semver version + mica），只补两个必然抛 "invalid or missing
    //     dsh-desktop-material" → 插件树加载失败 → 页面变成「打开恢复模式」；
    //   - 更糟的是 decideDesktopBrowserAccess 见到 dsh-desktop-* 前缀就把没有渲染器 token 的
    //     普通浏览器判为 denied（403），刷新后直接打不开。
    // 结论：手机/浏览器访问一律不带这些标记，advanced 模式另加警告覆盖层（issue #19）。
    injectHtml: isDesktop
      ? DEFAULT_INJECT + (desktopAdvanced ? advancedNoticeScript() : '')
      : undefined,
    // 公网始终校验持久密码；局域网按开关（默认开启，关闭后局域网扫码直连）。
    // 公网的判定是 fail closed：除了 loopback/私网 Host，一切陌生域名（含自建
    // 命名隧道的固定域名）都按公网处理、强制公网密码。
    auth: {
      // sessionKey：进程级随机密钥——登录 cookie 绑定它（会话保持，issue #33）：
      // dsh web 重启/更新后 sessionKey 变化 → 手机需重新输入
      sessionKey: randomBytes(16).toString('hex'),
      getToken: (host) => tokenForHost(host),
      getCredentialKind: (host) => credentialKindForHost(host),
      isProtected: (host) => {
        if (isLanOverrideHost(host)) return lanAuthEnabled();
        return classifyHost(host) === 'public' ? true : lanAuthEnabled();
      },
    },
    // dsh web 浏览器会话启动 token（issue #77）：新版 dsh（>= 0.1.2-alpha.1）要求根路径
    // 带一次 `?token=` 换 cookie，否则 /api 与 WebSocket 全 401。token 每次进程启动都变，
    // 所以每次请求实时从 connection 服务取；老版本没有这个方法 → 返回空，行为不变。
    launchToken: () => {
      try {
        const fn = ctx.connection?.authenticatedUrl;
        if (typeof fn !== 'function') return '';
        const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
        return url.searchParams.get('token') ?? '';
      } catch {
        return '';
      }
    },
    getTunnelConfig: () => ({
      mode: tunnelMode(), token: tunnelToken(), hostname: tunnelHostname(),
      autoRestore: tunnelAutoRestoreEnabled(),
    }),
    onTunnelReady: () => {
      logger.info('dsh-pocket: named tunnel ready — PIN not rotated | 命名隧道就绪（公网密码不自动轮换）');
      return getAccessToken();
    },
  });

  const disposers = [];
  const disposeRpc = installPocketRpc(ctx, {
    service,
    desktop: isDesktop,
    getToken: () => getAccessToken(),
    getLanToken: () => getLanToken(),
    refreshLanToken: () => refreshLanToken(),
    getLanAuthEnabled: () => lanAuthEnabled(),
    setLanAuthEnabled: (on) => setLanAuthEnabled(on),
    getLanEnabled: () => lanEnabled(),
    setLanEnabled: (on) => setLanEnabled(on),
    getMobileRightbarEnabled: () => mobileRightbarEnabled(),
    setMobileRightbarEnabled: (on) => setMobileRightbarEnabled(on),
    getMobilePinchZoomEnabled: () => mobilePinchZoomEnabled(),
    setMobilePinchZoomEnabled: (on) => setMobilePinchZoomEnabled(on),
    getMobileFontSize: () => mobileFontSize(),
    setMobileFontSize: (size) => setMobileFontSize(size),
    getLanIpOverride: () => lanIpOverride(),
    setLanIpOverride: (ip) => setLanIpOverride(ip),
    getPinCustom: (which) => pinCustom(which),
    setCustomPin: (which, value) => setCustomPin(which, value),
    pinWriteWarning: (which) => pinWriteWarning(which),
    // 命名隧道配置（issue #66）：RPC 只回显脱敏视图（token 只写不读）
    getTunnelConfig: () => ({ mode: tunnelMode(), hostname: tunnelHostname(), tokenSet: tunnelToken().length > 0 }),
    // 恢复出厂设置：清空设置文件 + 重设随机密码（RPC 层已先停掉公网隧道）
    resetPocket: () => resetPocketState(),
    setTunnelConfig: (cfg) => setNamedTunnelConfig(cfg),
    runUpdate: internals.runUpdate ?? { currentVersion, perform: performUpdate, loadedVersion: () => loadedVersion, currentRepository },
    restart: internals.restart ?? (() => pocketRestart(service)),
    restartNotice: internals.restartNotice ?? consumeRestartNotice,
    log: logger,
  });
  disposers.push(disposeRpc);

  // 会话删除端点（移植 dsh-web-mobile v3.0.3 宿主侧）：移动端抽屉里 session-menu
  // 的「删除会话」fetch /api/mobile-nav.session.delete，官方宿主没有这条路由——
  // 不挂它，手机端删除永远 404。服务按请求经 ctx.get 读取，缺服务时结构化 503。
  const disposeSessionDelete = mountSessionDeleteRoute(ctx, logger);
  if (disposeSessionDelete) disposers.push(disposeSessionDelete);

  // 回收站只在「下一次删除」时才清理过期条目：长期不删会话的宿主会一直占盘。
  // 持久化服务可能晚于本插件注册，所以挂载后延迟再试一次。
  disposers.push(scheduleTrashPurge(ctx));

  // 代理随插件自动启动（局域网二维码开箱即用，零配置）
  void service.startProxy().then((proxy) => {
    logger.info('dsh-pocket: proxy ready on :%d | 局域网代理已就绪', proxy.port);
    // 自动恢复上次开启的公网隧道（DSH 重启后 cloudflared 子进程被杀，issue #11）
    void service.restoreTunnelIfNeeded?.().catch(() => {});
  }).catch((err) => {
    logger.error('dsh-pocket: proxy start failed | 代理启动失败: %s', err?.message ?? err);
  });

  ctx.effect(() => async () => {
    for (const d of disposers.reverse()) { try { d(); } catch { /* 忽略 */ } }
    await service.dispose();
  }, 'dsh-pocket: stop proxy and tunnel');
}

export { name, inject, readRestartNotice, consumeRestartNotice };
