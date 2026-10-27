// dsh-pocket 服务：在 dsh web 进程内跑改头代理 + 公网隧道
//
// - 代理：监听 0.0.0.0:<port>（默认 3081），把入站 Host/Origin 改写成
//   127.0.0.1:<dshPort>（dsh web 实际端口），HTTP + WebSocket 全透传。
//   这样 DSH 的 /api 浏览器信任栅栏永远看到 loopback，局域网/公网都能进，
//   且不需要改 dsh 的任何配置（0.0.0.0 绑定被 dsh 官方禁用）。
// - 隧道：用户自行配置 cloudflared 命名隧道与域名后，才可开启公网访问。

import { homedir, networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createPocketProxy } from './proxy.mjs';
import { startNamedTunnel } from './tunnel.mjs';
import { isValidIpv4 } from './ip.mjs';

const require = createRequire(import.meta.url);

/** URL → 二维码 data URL（浏览器 <img> 直接显示，全本地不依赖第三方）。 */
export async function qrDataUrl(text, { width = 220, margin = 1 } = {}) {
  const QRCode = require('qrcode');
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

// RFC1918 私网地址：手机与电脑连同一局域网时通常可直连。
// 另含 CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，公网不可路由），保持一致（issue #79）。
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1(?:0\d|1\d|2[0-7]))\.)/;

/** 名称像真实物理网卡的接口（WLAN / Wi-Fi / Ethernet / 以太网 / 有线 / 无线 / en / eth）。
 *  注意：`本地连接` 用负前瞻 `(?!\*)` 排除 Windows 的「移动热点 / Internet 连接共享（ICS）」
 *  虚拟适配器 `本地连接* N`（IP 固定 192.168.137.1，手机连真实 Wi-Fi 时与它不在同一网段，
 *  扫码不可达）——issue #176。 */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接(?!\*))/i;

/** 常见的 VPN / 虚拟网卡名称：手机通常无法通过它们直连电脑。
 *  含 Windows ICS / 移动热点（`本地连接*`）与承载网络 / Wi-Fi Direct 虚拟适配器——issue #176。 */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge|本地连接\*|hostednetwork|wifidirect)/i;

/**
 * 从 networkInterfaces() 返回的接口表里选出手机最可能可达的 IPv4。
 *
 * `os.networkInterfaces()` 的枚举顺序不可靠：Windows 上 Radmin VPN / Tailscale /
 * vEthernet 等虚拟网卡常排在 WLAN 前面，旧实现直接取第一张非回环网卡，会生成
 * 手机打不开的二维码。这里按以下规则打分排序：
 *   - RFC1918 私网地址优先（10/8、172.16/12、192.168/16）；
 *   - 名称像物理网卡再加分；
 *   - 名称像 VPN/虚拟网卡减分；
 *   - 同分保持原枚举顺序。
 * 没有任何私网地址时回退到最高分地址（例如纯 VPN 环境仍可用）。
 *
 * @param {ReturnType<typeof networkInterfaces>} interfaces
 * @returns {string|null}
 */
export function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      // 排除 loopback 与 link-local；其余地址即使不是私网（如 Radmin 的 26.x）也保留兜底
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;

      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;

      candidates.push({ ip, score, order: candidates.length });
    }
  }

  // 兜底：同分时不选 ICS 保留段 192.168.137.x（移动热点 / 共享虚拟网卡），避免误指向不可达地址。
  const isIcsSubnet = (ip) => ip.startsWith('192.168.137.');
  candidates.sort((a, b) =>
    b.score - a.score ||
    (isIcsSubnet(a.ip) === isIcsSubnet(b.ip) ? a.order - b.order : isIcsSubnet(a.ip) ? 1 : -1),
  );
  return candidates[0]?.ip ?? null;
}

// ---------- WSL 局域网 IP（issue #39） ----------
// WSL2 是 NAT 模式：WSL 内部 os.networkInterfaces() 只能看到自己的虚拟网卡
// （172.x.x.x），看不到 Windows 宿主机的物理网卡 IP（192.168.x.x）——手机在
// 同一 WiFi 下访问的是 Windows 宿主机，拿 WSL 的 IP 生成的二维码必然打不开。
// 解法：检测到 WSL 时，通过 WSL interop 直接执行 Windows 的 ipconfig.exe，
// 解析出 Windows 侧非虚拟网卡的 IPv4 作为局域网地址；失败回退本机探测。

/** WSL 检测：/proc/version 含 microsoft/wsl，或 WSL 专属环境变量存在。 */
export function detectWsl() {
  try {
    const v = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) return true;
  } catch { /* 非 Linux：无 /proc/version */ }
  // 注意：**不能**用 WSLENV 判据——Windows Terminal 在原生 Windows 上也会设置
  // WSLENV（如 WT_SESSION:WT_PROFILE_ID:），会误判成 WSL。只认 WSL 内部才有的变量。
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * 解析 ipconfig.exe 输出，默认取非虚拟网卡块的 IPv4 地址（保持输出顺序）。
 * 支持中文（`IPv4 地址 . . . :`）与英文（`IPv4 Address. . . :`）两种格式。
 * @param {string} text ipconfig.exe 的完整输出
 * @param {{ includeVpn?: boolean }} [opts] 传 includeVpn 时保留 Tailscale/VPN 等候选
 * @returns {string[]} 候选 IPv4 列表
 */
export function parseIpconfig(text, { includeVpn = false } = {}) {
  const out = [];
  // 网卡块：块标题行顶格（行首无缩进），其后内容行带缩进
  const blocks = String(text).split(/\r?\n(?=\S)/);
  const ipRe = /IPv4[^0-9]{0,40}((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/;
  for (const block of blocks) {
    const title = String(block.split(/\r?\n/)[0] ?? '');
    // 跳过虚拟网卡块（vEthernet (WSL)、Docker、VirtualBox、VPN 等）
    if (!includeVpn && VPN_IFACE_RE.test(title)) continue;
    const m = block.match(ipRe);
    if (m) out.push(m[0].replace(/^IPv4[^0-9]*/i, ''));
  }
  return out;
}

function runIpconfig() {
  // WSL 内 PATH 可能不含 Windows System32；用绝对路径兜底
  const candidates = ['ipconfig.exe', '/mnt/c/Windows/System32/ipconfig.exe'];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i], [], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return tryNext(i + 1);
        resolve(String(stdout));
      });
    };
    tryNext(0);
  });
}

async function lanIPv4() {
  // WSL：优先 Windows 物理网卡 IP（手机可达）；超时/失败回退本机探测
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const candidates = parseIpconfig(out ?? '');
      const ip = candidates.find((c) => PRIVATE_IPV4_RE.test(c)) ?? candidates[0];
      if (ip) return ip;
    } catch { /* 回退 */ }
  }
  return selectLanIPv4(networkInterfaces());
}

/** 收集所有可手动选择的局域网/Tailnet 候选 IP（WSL 下以 Windows ipconfig 为准）。 */
async function listLanCandidates() {
  if (detectWsl()) {
    try {
      const out = await runIpconfig();
      const ips = parseIpconfig(out ?? '', { includeVpn: true });
      if (ips.length) return [...new Set(ips)];
    } catch { /* 回退 */ }
  }
  const ips = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!ips.includes(ip)) ips.push(ip);
    }
  }
  return ips;
}

/**
 * 创建 Pocket 服务。
 * @param {object} opts
 * @param {number} opts.dshPort   dsh web 实际端口（从 ctx.webServer.port 取）
 * @param {number} [opts.port]    代理端口（默认 3081）
 * @param {object} [opts.internals] 测试注入：createProxy / startNamedTunnel / lanIPv4
 * @returns {PocketService}
 */
export function createPocketService({
  dshPort,
  port = 3081,
  home,
  internals = {},
  /** 局域网地址手动覆盖：返回 IPv4 字符串；空值表示自动选择 */
  getLanIpOverride,
  /** 局域网访问总开关：返回 boolean；默认开启。关闭后代理拒绝局域网 Host 请求 */
  getLanEnabled = () => true,
  /** 代理注入 HTML 的内容（桌面端补丁等由 lib/index.js 传入；默认 randomUUID polyfill） */
  injectHtml,
  /** 访问令牌认证配置（issue #13）：{ getToken, isProtected }，传给代理 */
  auth,
  /** @type {() => string} dsh web 浏览器会话启动 token（issue #77；老版本返回空字符串） */
  launchToken = () => '',
  /** 用户自配隧道：() => ({ mode:'named', token, hostname, autoRestore? }) */
  getTunnelConfig,
  /** 隧道就绪回调；参数为 'named'，访问密码不随启停轮换。 */
  onTunnelReady,
  /** 日志（DSH 宿主 ctx.logger 有 info/warn/error；默认 console 无 info，自动退回 log）。
   *  隧道自动恢复的成败必须走这里：console 输出在 DSH Desktop 里不进日志文件，
   *  出问题时无法排查（2026-09-07 实测教训）。 */
  log = console,
} = {}) {
  // ctx.logger 形状是 info/warn/error；console 只有 log/warn/error——info 做兜底兼容
  const logInfo = (...args) => (log.info ?? log.log).call(log, ...args);
  const logWarn = (...args) => log.warn(...args);
  const createProxy = internals.createProxy ?? createPocketProxy;
  const startNamed = internals.startNamedTunnel ?? startNamedTunnel;
  const isProcessAliveImpl = (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
  };
  const isProcessAlive = internals.isProcessAlive ?? isProcessAliveImpl;
  const orphanCheck = internals.isOrphanCloudflared ?? ((pid) => isOrphanCloudflared(pid));
  const orphanKill = internals.killPid ?? ((pid) => killPid(pid));
  const getLanOverride = () => {
    const value = String(getLanIpOverride?.() ?? '').trim();
    return isValidIpv4(value) ? value : '';
  };
  /** lanIPv4() 结果缓存（WSL 下每次探测都要 spawn ipconfig.exe，status() 轮询很频繁）。 */
  const LAN_IP_CACHE_MS = 30_000;
  let lanCache = null;
  const getLan = async () => {
    const override = getLanOverride();
    if (override) return override;
    // 测试注入必须每次真调（用例要覆盖「值变了」的场景），缓存只包真实探测。
    if (internals.lanIPv4) return internals.lanIPv4();
    // status() 会被设置页每几秒轮询一次；WSL 下每次都要 spawn 一次 ipconfig.exe，
    // 不缓存等于让用户开着设置页就每分钟起二十个子进程。网卡变化不需要秒级感知。
    const now = Date.now();
    if (!lanCache || now - lanCache.at > LAN_IP_CACHE_MS) {
      lanCache = { at: now, ip: await lanIPv4() };
    }
    return lanCache.ip;
  };
  let lanCandidateCache = null;
  const getLanCandidates = async () => {
    if (internals.lanCandidates) return internals.lanCandidates();
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15000) {
      lanCandidateCache = { at: now, ips: await listLanCandidates() };
    }
    return lanCandidateCache.ips;
  };

  let proxy = null;
  /** in-flight 代理启动（单飞）：并发调用复用同一次，防各自 EADDRINUSE 跳端口 */
  let proxyPromise = null;
  /** 卸载门（sticky）：置位后任何在途启动都不能把结果落进全局引用。 */
  let disposed = false;
  /** 代理世代：每次卸载 +1，在途启动靠它判断「我落地时还算不算数」。 */
  let proxyGeneration = 0;
  let tunnel = null;
  let tunnelAbort = null;
  /** in-flight 隧道启动（单飞）：并发调用复用同一次，避免 spawn 多个 cloudflared 孤儿进程 */
  let tunnelPromise = null;
  /** 隧道进度：{ phase: idle|downloading|starting|registering|ready|error, detail, startedAt } */
  const tunnelState = { phase: 'idle', detail: '', startedAt: null };
  /** 二维码缓存：URL → data URL promise。status() 每 3 秒轮询一次，不能每次都重新生成（CPU 密集）。 */
  const qrCache = new Map();
  const encodeQr = internals.encodeQr ?? qrDataUrl;
  async function qrCached(text) {
    if (!text) return null;
    if (qrCache.has(text)) {
      // LRU：命中即把该 key 挪到队尾。否则按 FIFO 淘汰时，最先插入的稳定 LAN 二维码
      // 会被不断轮换的隧道 URL 反复挤掉、反复重算。
      const hit = qrCache.get(text);
      qrCache.delete(text);
      qrCache.set(text, hit);
      return hit;
    }
    if (qrCache.size >= 8) {
      // 淘汰最久未使用的一条（Map 迭代顺序 = 插入/刷新顺序，队首即 LRU）
      const oldest = qrCache.keys().next().value;
      qrCache.delete(oldest);
    }
    qrCache.set(text, encodeQr(text).catch(() => null));
    return qrCache.get(text);
  }

  // 公网隧道自动恢复（issue #11）：DSH 重启后 cloudflared 子进程被杀、隧道消失，
  // 插件无从知晓。启动时检查持久化的「隧道开启中」标记，自动重新拉起。
  const autoStatePath = home ? join(home, 'dsh-pocket', 'tunnel-auto.json') : null;
  // 写入与删除必须串行：隧道刚就绪就立即关闭时，异步写不能晚于删除重新落盘，
  // 否则标记被晚到的写操作复活，下次启动误恢复（writeFile 与 rm 的完成顺序不保证）。
  let autoStateQueue = Promise.resolve();
  function persistAutoTunnel(pid) {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try {
        await mkdir(dirname(autoStatePath), { recursive: true });
        // pid 供下次启动前清扫孤儿 cloudflared；hostPid 是拉起隧道的 DSH 宿主进程：
        // 桌面版与 web 版常常共用同一个 $DSH_HOME，只凭 cloudflared 的 pid + 映像名
        // 会误杀另一实例正在用的活隧道（审计：两实例互相杀隧道）。
        await writeFile(autoStatePath, JSON.stringify({
          at: Date.now(),
          mode: 'named',
          hostPid: process.pid,
          ...(Number.isInteger(pid) ? { pid } : {}),
        }), 'utf8');
      } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }
  function clearAutoTunnel() {
    if (!autoStatePath) return;
    autoStateQueue = autoStateQueue.then(async () => {
      try { await rm(autoStatePath, { force: true }); } catch { /* 忽略 */ }
    });
    return autoStateQueue;
  }

  // 孤儿 cloudflared 清扫（宿主崩溃遗留）：marker 里记着拉起隧道的进程 pid；
  // 起新隧道前若该 pid 仍存活且映像名确实是 cloudflared，且不是本进程自己 spawn
  // 的子进程，就先杀掉再起新的。PID 会被无关进程复用，名字校验是杀错防护；
  // 全部 best-effort：任何校验失败（tasklist/proc 不可用、名字对不上、权限不足）
  // 都跳过不杀，不影响新隧道启动。
  const spawnedPids = new Set();
  function probeWindowsImage(pid) {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV'], { cwd: homedir() }, (err, stdout) => {
        if (err) return resolve(null);
        // CSV 首行是标题；数据行形如 "cloudflared.exe","1234",…。无匹配时只有标题行。
        const line = String(stdout).split('\n').find((l) => l.includes(`"${pid}"`));
        if (!line) return resolve(null);
        resolve(line.split(',')[0]?.replace(/"/g, '').toLowerCase() ?? null);
      });
    });
  }
  async function isOrphanCloudflared(pid) {
    if (process.platform === 'win32') {
      const image = await probeWindowsImage(pid);
      return image !== null && image.startsWith('cloudflared');
    }
    // POSIX：先探活，再读 /proc 校验进程名（macOS 无 /proc，校验失败按约定跳过不杀）
    try { process.kill(pid, 0); } catch { return false; }
    try {
      const comm = await readFile(`/proc/${pid}/comm`, 'utf8');
      return comm.trim().startsWith('cloudflared');
    } catch { return false; }
  }
  function killPid(pid) {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/F'], { cwd: homedir() }, (err) => (err ? reject(err) : resolve()));
      } else {
        try { process.kill(pid, 'SIGKILL'); resolve(); } catch (err) { reject(err); }
      }
    });
  }
  async function killOrphanCloudflared() {
    if (!autoStatePath) return;
    let marker = null;
    try {
      marker = JSON.parse(await readFile(autoStatePath, 'utf8'));
    } catch { return; } // 无 marker / 旧格式无 pid / 读失败 → 跳过
    // 桌面版 + web 版共用 $DSH_HOME 时，后启动的实例会看到另一实例写的 marker。
    // 只要 marker 的宿主进程还活着，它就不是孤儿，绝不能杀（否则互踢隧道）。
    // hostPid 用 Number() 归一：旧版本/手工编辑/JSON 数字被写成字符串时，
    // `Number.isInteger('1234')` 为 false，会绕过存活守卫把对方正在用的隧道杀掉。
    const markerHostPid = Number(marker?.hostPid);
    if (Number.isInteger(markerHostPid) && markerHostPid > 0 && markerHostPid !== process.pid
      && isProcessAlive(markerHostPid)) {
      logInfo('dsh-pocket: orphan sweep skipped — tunnel owned by live host pid=%s | 隧道属于另一个存活实例，跳过清扫 pid=%s', markerHostPid, markerHostPid);
      return;
    }
    const pid = marker?.pid;
    if (!Number.isInteger(pid) || pid <= 0 || spawnedPids.has(pid)) return;
    try {
      if (!(await orphanCheck(pid))) return;
      await orphanKill(pid);
      logInfo('dsh-pocket: killed orphan cloudflared pid=%s | 已清理孤儿 cloudflared 进程 pid=%s', pid, pid);
    } catch (err) {
      logWarn('dsh-pocket: orphan cloudflared sweep skipped | 孤儿清扫跳过: %s', err?.message ?? err);
    }
  }

  const service = {
    dshPort,
    /** 启动局域网代理（幂等）。端口被占（EADDRINUSE，如桌面版与普通环境同时运行）时自动尝试下一个端口。
     *  in-flight 单飞（同 startTunnel 的 tunnelPromise）：并发调用复用同一次，
     *  否则两个并发会各自撞 EADDRINUSE 往后跳端口，最终各起一个代理。 */
    async startProxy() {
      if (disposed) throw new Error('dsh-pocket service disposed | 服务已卸载，无法启动代理');
      if (proxy) return proxy;
      if (proxyPromise) return proxyPromise; // 复用 in-flight，防并发跳端口
      const generation = proxyGeneration;
      const p = (async () => {
        let lastErr = null;
        for (let candidate = port; candidate < port + 10; candidate++) {
          // 卸载已发生：别再往端口上绑新 server（否则 close 之后又冒出一个监听者）
          if (disposed || generation !== proxyGeneration) {
            throw new Error('dsh-pocket service disposed | 服务已卸载，无法启动代理');
          }
          let created = null;
          try {
            created = await createProxy({
              port: candidate,
              host: '0.0.0.0',
              upstream: { host: '127.0.0.1', port: dshPort },
              ...(injectHtml ? { injectHtml } : {}),
              ...(auth ? { auth } : {}),
              // 每次请求实时读开关：设置页切换后立即生效，无需重启代理
              lanAccessEnabled: () => getLanEnabled(),
              // dsh web 浏览器会话启动 token（issue #77）：实时取，新版 dsh 才有
              ...(launchToken ? { launchToken } : {}),
            });
          } catch (err) {
            if (err?.code !== 'EADDRINUSE') throw err; // 非端口冲突直接失败
            lastErr = err;
            continue;
          }
          // 关键：createProxy 是 await 的，期间 dispose 可能已经跑完（它只看得到
          // 当时的 proxy === null）。此处必须再判一次世代，否则这个 server 会
          // 逃过 close，成为插件卸载后仍在监听的孤儿端口。
          if (disposed || generation !== proxyGeneration) {
            try { await created.close(); } catch { /* 已关闭 */ }
            throw new Error('dsh-pocket service disposed | 服务已卸载，无法启动代理');
          }
          proxy = created;
          if (candidate !== port) {
            logInfo(`dsh-pocket: port ${port} busy, proxy on ${candidate} | 端口 ${port} 被占用，代理改用 ${candidate}`);
          }
          break;
        }
        if (!proxy) throw lastErr ?? new Error('proxy start failed | 代理启动失败');
        return proxy;
      })();
      proxyPromise = p;
      try {
        return await p;
      } finally {
        // 只清自己的引用：失败后立刻重试可能已建了新的 in-flight
        if (proxyPromise === p) proxyPromise = null;
      }
    },

    /** 启动公网隧道（幂等；返回公网 URL）。进度写进 tunnelState。并发调用单飞。 */
    async startTunnel() {
      if (disposed) throw new Error('dsh-pocket service disposed | 服务已卸载，无法启动隧道');
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise; // 复用 in-flight，防孤儿 cloudflared
      // 先建 controller 再 await 代理：否则 startProxy 期间 stopTunnel 看不到这个
      // in-flight 启动（tunnelAbort 还是 null），等它拿到代理后才建 controller，
      // 那次停止永远传不进来 → dispose 之后仍会 spawn 出 cloudflared。
      const controller = new AbortController();
      tunnelAbort = controller;
      // 先 `await null` 让函数体从微任务开始执行：否则在 `p` 初始化之前（getTunnelConfig
      // 之类的同步抛错）就会走到 finally，引用未初始化的 const 触发 TDZ 报错，
      // tunnelPromise 会永久停在 rejected —— 此后 startTunnel 一直复用这个失败的
      // promise，隧道再也起不来。
      // tunnelPromise 必须在任何 await 之前赋值：单飞靠的就是这个同步窗口。
      const p = (async () => {
        await null;
        try {
          await this.startProxy();
          if (controller.signal.aborted) {
            throw new Error('dsh-pocket tunnel start aborted | 隧道启动已取消');
          }
          // 代理端口被占时会顺延（3082…），但 Cloudflare 命名隧道的 ingress 固定
          // 指向 127.0.0.1:<port>。此时开公网只会 502，或更糟：命中 3081 上另一个
          // 实例，把别人的 DSH 暴露成你的域名。必须在启动隧道前拦住。
          if (proxy && proxy.port !== port) {
            throw new Error(
              `端口 ${port} 被占用，局域网代理实际运行在 ${proxy.port}；`
              + `已配置的固定域名隧道 ingress 指向 ${port}，现在开启公网会 502 或命中另一个实例。`
              + '请释放该端口，或把 proxyPort 与 Cloudflare ingress 一起改成同一个端口 | '
              + `proxy is on ${proxy.port} but the tunnel ingress points at ${port}`,
            );
          }
          tunnelState.startedAt = Date.now();
          const onPhase = (phase) => {
            tunnelState.phase = phase;
            if (phase === 'downloading') tunnelState.detail = '首次下载 cloudflared（约 20MB）| first run downloads cloudflared (~20MB)';
            else if (phase === 'starting') tunnelState.detail = '启动隧道进程… | starting tunnel…';
            else if (phase === 'registering') tunnelState.detail = '连接 Cloudflare 边缘（通常 5-30 秒）| connecting to Cloudflare edge (usually 5-30s)';
            else if (phase === 'ready') tunnelState.detail = '隧道就绪 | ready';
          };
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          if (cfg.mode !== 'named' || !cfg.token || !cfg.hostname) {
            throw new Error(
              '公网访问需要自行配置固定域名与 Tunnel Token（设置 → 手机访问 → 公网配置） | '
              + 'public access requires your own fixed hostname and Tunnel Token in Settings',
            );
          }
          // 未配置时不能下载或启动 cloudflared，也不能借旧配置回退到随机隧道。
          await killOrphanCloudflared();
          controller.signal.throwIfAborted();
          const result = await startNamed({ token: cfg.token, home, signal: controller.signal, onPhase });
          if (controller.signal.aborted || disposed) {
            result.kill();
            controller.signal.throwIfAborted();
            if (disposed) throw new Error('dsh-pocket tunnel start aborted | 隧道启动已取消');
          }
          /** 本世代隧道对象：onExit 只能按身份判断自己是否还是当前那一个。 */
          const mine = { url: `https://${cfg.hostname}`, pid: result.pid ?? null, kill: result.kill, onExit: result.onExit };
          tunnel = mine;
          tunnelState.phase = 'ready';
          // M1：隧道进程运行中死亡（崩溃/被杀）→ 状态打回并清引用。只改 phase 不够：
          // status() 仍报 tunnelRunning:true + 死链接二维码，再点「开启公网」会被入口的
          // `if (tunnel) return tunnel.url` 挡回去，用户必须先手动关一次再开。
          mine.onExit?.((code) => {
            // pid 先不管退出原因一律摘掉：主动停止（stopTunnel）也会走到这里，
            // 旧实现把它放在 aborted 早退之后，pid 就永远留在 spawnedPids 里，
            // 成为「孤儿清扫」名单上的死条目。
            if (Number.isInteger(mine.pid)) spawnedPids.delete(mine.pid);
            if (controller.signal.aborted) return; // 主动停止（stopTunnel）不算故障
            // 身份校验：这个回调可能在一个已停止的旧隧道上迟到触发，那时 tunnel
            // 已经是下一代的对象——无条件置 null 会把刚起来的隧道从状态里抹掉。
            if (tunnel !== mine) return;
            tunnel = null;
            if (tunnelAbort === controller) tunnelAbort = null;
            tunnelState.phase = 'error';
            tunnelState.detail = `隧道进程退出（code=${code}） | tunnel process exited (code=${code})`;
            tunnelState.startedAt = null;
          });
          // 记录「隧道开启中」，供重启后自动恢复（issue #11）；pid 供孤儿清扫
          if (Number.isInteger(mine.pid)) spawnedPids.add(mine.pid);
          void persistAutoTunnel(mine.pid);
          try { onTunnelReady?.('named'); } catch { /* 忽略 */ }
          return mine.url;
        } catch (err) {
          // stopTunnel 触发的 abort 不算错误：保持 idle，别把状态刷成 error
          if (!controller.signal.aborted) {
            tunnelState.phase = 'error';
            tunnelState.detail = err?.message ?? String(err);
          }
          tunnelState.startedAt = null; // 失败后清掉计时，避免 UI 误显"启动中"
          throw err;
        } finally {
          // 只清自己的引用：stopTunnel 后立即 startTunnel 可能已建了新的 in-flight
          // （tunnelPromise=B），A 的 finally 不能把 B 清掉，否则第三次调用会并发 spawn
          if (tunnelPromise === p) tunnelPromise = null;
        }
      })();
      tunnelPromise = p;
      return p;
    },

    /**
     * 停止公网隧道（代理保持）。
     * @param {{ keepAutoMarker?: boolean }} [opts] - keepAutoMarker=true 用于进程退出/
     *   自重启（dispose / pocketRestart）：隧道是随进程被动消失的，不是用户主动关闭，
     *   必须保留 tunnel-auto.json，下次启动才能自动恢复（issue #11 的本意）。
     *   默认（设置页手动关闭、恢复出厂）删除标记。
     */
    stopTunnel({ keepAutoMarker = false } = {}) {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null; // 丢弃已 abort 的 in-flight（其 finally 会再清一次，无害）
      if (tunnel) {
        // 不等 onExit 回调：kill 是异步的，进程可能已经死了、回调却还没来；
        // 立刻摘掉 pid，避免 spawnedPids 里堆积已停止隧道的条目。
        if (Number.isInteger(tunnel.pid)) spawnedPids.delete(tunnel.pid);
        tunnel.kill();
      }
      tunnel = null;
      tunnelState.phase = 'idle';
      tunnelState.detail = '';
      tunnelState.startedAt = null;
      if (!keepAutoMarker) void clearAutoTunnel(); // 手动关闭后不再自动恢复
    },

    /** 启动时自动恢复上次开启的公网隧道（DSH 重启后 cloudflared 子进程被杀，issue #11）。 */
    async restoreTunnelIfNeeded() {
      logInfo('dsh-pocket: auto-restore check | 自动恢复检查：读取上次隧道状态');
      if (!autoStatePath || tunnel || tunnelPromise) return;
      let marker;
      try {
        marker = JSON.parse(await readFile(autoStatePath, 'utf8'));
      } catch { return; }
      if (!marker?.at) return;
      try {
        const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
        // 老标记没有 mode；只有旧设置明确启用了 named，才可沿用其恢复意图。
        if (cfg.mode !== 'named' || !cfg.token || !cfg.hostname || (cfg.autoRestore === false && marker.mode !== 'named')
          || (marker.mode !== undefined && marker.mode !== 'named')) {
          await killOrphanCloudflared();
          await clearAutoTunnel();
          logInfo('dsh-pocket: auto-restore skipped — configure public access first | 旧公网恢复标记已清除，请先自行配置固定域名');
          return;
        }
        logInfo('dsh-pocket: auto-restore: marker found, starting tunnel | 发现上次开启标记，尝试自动恢复');
        await service.startTunnel();
        logInfo('dsh-pocket: public tunnel auto-restored | 已自动恢复公网隧道');
      } catch (err) {
        // 恢复失败保留标记（下次启动再试）；网络问题见 README 排障
        logWarn('dsh-pocket: tunnel auto-restore failed | 自动恢复隧道失败: %s', err?.message ?? err);
      }
    },

    /** 状态快照（RPC 返回，不含敏感信息；二维码 data URL 本地生成 + 缓存）。 */
    async status() {
      const lan = await getLan();
      const proxyPort = proxy?.port ?? null;
      const lanUrl = lan && proxyPort ? `http://${lan}:${proxyPort}` : null;
      const lanIpOverride = getLanOverride();
      const lanCandidates = [...new Set(await getLanCandidates())];
      if (lanIpOverride && !lanCandidates.includes(lanIpOverride)) lanCandidates.push(lanIpOverride);
      return {
        proxyRunning: proxy !== null,
        proxyPort,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates,
        lanIpOverride,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnel?.url ?? null,
        tunnelQr: await qrCached(tunnel?.url ?? null),
        tunnelState: { ...tunnelState },
        // 隧道配置脱敏视图（issue #66）：token 永不回显，只有 tokenSet 布尔值
        tunnelConfig: (() => {
          const cfg = typeof getTunnelConfig === 'function' ? (getTunnelConfig() ?? {}) : {};
          return {
            mode: 'named',
            hostname: typeof cfg?.hostname === 'string' ? cfg.hostname : '',
            tokenSet: Boolean(cfg?.token),
          };
        })(),
        dshPort,
        // 端口被占后代理会顺延，但固定域名隧道的 ingress 仍指向 port：
        // UI 据此提示「公网会 502」，而不是等用户看到 Cloudflare 522。
        portShifted: Boolean(proxy && proxy.port !== port),
      };
    },

    /** 停止一切（插件卸载时）。进程退出不是用户手动关闭：保留自动恢复标记。 */
    async dispose() {
      // 卸载门先置位、世代先自增：在途的 startProxy/createProxy 落地时会看到
      // 自己已过期，把刚绑上的 server 关掉而不是交给下面的 close 之后再冒出来。
      disposed = true;
      proxyGeneration += 1;
      // 用 service.stopTunnel 而非 this.stopTunnel：dispose 常被解构后调用
      // （const { dispose } = service），那时 this 是 undefined 会直接抛。
      service.stopTunnel({ keepAutoMarker: true });
      // 停掉在途的代理启动：它可能正卡在 createProxy 里，等它自己发现过期
      // 会把 server 关掉；这里再等一次，保证 dispose 返回后端口确实已释放。
      const inflight = proxyPromise;
      if (inflight) {
        try { await inflight; } catch { /* 过期启动自行关闭 */ }
      }
      if (proxy) {
        const p = proxy;
        proxy = null;
        try { await p.close(); } catch { /* server 已关闭等边缘情况 */ }
      }
    },
  };
  return service;
}
