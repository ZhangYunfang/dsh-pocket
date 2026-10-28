#!/usr/bin/env node
// dsh-pocket — 把 DeepSeek Harness 装进你的口袋
//
// 用法：
//   dsh-pocket                 # 局域网模式：手机同一 WiFi 扫码访问
//   dsh-pocket --public        # 公网模式：使用已配置的固定域名与 Tunnel Token
//   dsh-pocket --port 3081     # 自定义代理端口（默认 3081；dsh web 保持 3080）
//
// 前提：dsh web 已在 127.0.0.1:3080 运行。
// 手机看到的界面 = 电脑上的界面，实时同步（WebSocket 流式透传）。

import { networkInterfaces } from 'node:os';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomInt } from 'node:crypto';
import { createPocketProxy, classifyHost } from '../lib/proxy.mjs';
import { startNamedTunnel, startQuickTunnel } from '../lib/tunnel.mjs';
import { tunnelHostname, tunnelToken } from '../lib/settings.mjs';
import { selectLanIPv4 } from '../lib/service.mjs';

const require = createRequire(import.meta.url);

/** 自定义密码的最短长度（issue #40：别让人设 `1234`）。 */
export const MIN_PIN_LENGTH = 6;

export function parseArgs(argv) {
  const args = {
    port: 3081,
    host: '0.0.0.0',
    public: false,
    // --quick：公网改用 Quick Tunnel（随机 trycloudflare.com 地址，零配置）。
    // --public 保持「自配固定域名」语义；两者互斥，同时给时 --quick 优先并在下面提示。
    quick: false,
    upstream: { host: '127.0.0.1', port: 3080 },
    pin: null,
    noAuth: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public') args.public = true;
    else if (a === '--quick') { args.public = true; args.quick = true; }
    else if (a === '--port') args.port = Number(argv[++i]) || 3081;
    else if (a === '--host') args.host = argv[++i] ?? '0.0.0.0';
    else if (a === '--pin') args.pin = String(argv[++i] ?? '');
    else if (a === '--no-auth') args.noAuth = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return args;
}

/**
 * 决定本次运行用哪个访问密码（issue #90 第 8 条）。
 *
 * CLI 此前**完全不构造 auth**，且默认监听 `0.0.0.0`——任何能连到这个端口的人都能
 * 直接操作 dsh web，而 dsh web 能在宿主机上执行任意代码。插件版一直有 PIN，
 * 只有 CLI 这条路是裸的，属实是缺陷而非取舍。
 *
 * 修法上刻意**不改默认监听地址**：CLI 的主用法就是「手机连同一 WiFi 扫码」，
 * 默认绑 loopback 等于把这个功能废掉。改成默认生成 PIN，并把它内嵌进二维码的
 * `?token=` —— 扫码体验完全不变，手动敲地址的人才会看到登录页。
 *
 * 优先级：`--pin` > `DSH_POCKET_PIN` > CSPRNG 随机生成。
 * @returns {{ pin: string|null, source: 'flag'|'env'|'generated'|'disabled', error?: string }}
 */
export function resolvePin({ pin = null, noAuth = false } = {}, env = {}) {
  if (noAuth) return { pin: null, source: 'disabled' };
  const explicit = pin != null && pin !== '' ? { value: String(pin), source: 'flag' }
    : (env.DSH_POCKET_PIN ? { value: String(env.DSH_POCKET_PIN), source: 'env' } : null);
  if (explicit) {
    if (explicit.value.length < MIN_PIN_LENGTH) {
      return {
        pin: null,
        source: explicit.source,
        error: `访问密码至少 ${MIN_PIN_LENGTH} 位（当前 ${explicit.value.length} 位）。`
          + `弱口令在公网上撑不过几分钟 | Access password must be at least ${MIN_PIN_LENGTH} characters.`,
      };
    }
    return { pin: explicit.value, source: explicit.source };
  }
  return { pin: String(randomInt(10_000_000, 100_000_000)), source: 'generated' };
}

/**
 * 构造给 createPocketProxy 的 auth（issue #90 第 8 条）。
 * `isProtected` 与插件版语义保持一致：本机免密（能在本机直连本来就说明已经上了机器），
 * 局域网与公网一律要密码。返回 null 表示不启用认证（`--no-auth`）。
 */
export function buildAuth(pin) {
  if (!pin) return null;
  return {
    sessionKey: randomBytes(32).toString('hex'),
    isProtected: (host) => classifyHost(host) !== 'loopback',
    getToken: () => pin,
  };
}

/** 把访问密码拼进入口 URL，让二维码扫了就能直达（与插件版一致）。 */
export function entryUrl(base, pin) {
  if (!pin) return base;
  const u = new URL(base);
  u.searchParams.set('token', pin);
  return u.toString();
}

export function resolvePublicConfig({ hostname = tunnelHostname(), token = tunnelToken() } = {}) {
  if (!hostname || !token) {
    throw new Error('公网访问需要先在设置 → 手机访问中配置自己的固定域名和 Tunnel Token | configure your own fixed hostname and Tunnel Token in Settings before using --public');
  }
  return { hostname, token, url: `https://${hostname}` };
}

function printHelp() {
  console.log(`dsh-pocket — 手机访问电脑上的 DeepSeek Harness

用法：
  dsh-pocket             局域网模式（手机同一 WiFi）
  dsh-pocket --public    公网模式（使用已配置的固定域名与 Tunnel Token）
  dsh-pocket --quick     公网模式（Quick Tunnel，随机 trycloudflare.com 地址，零配置）
  dsh-pocket --port 3081 自定义代理端口
  dsh-pocket --host      自定义监听地址（默认 0.0.0.0）
  dsh-pocket --pin <值>  自定义访问密码（至少 ${MIN_PIN_LENGTH} 位；也可用环境变量 DSH_POCKET_PIN）
  dsh-pocket --no-auth   关闭访问密码（不推荐，见下）
  dsh-pocket --help      帮助

前提：dsh web 已在 127.0.0.1:3080 运行（npx @deepseek-ai/dsh web）。
公网：先在同一 DSH_HOME 的「设置 → 手机访问」保存自己的固定域名与 Tunnel Token，
并将 Cloudflare Service 指向 CLI 的实际代理端口（默认 http://127.0.0.1:3081）。
未配置时 --public 会拒绝启动；不会分配随机域名。
--quick 不需要任何 Cloudflare 配置，地址由 Cloudflare 随机分配（每次运行都变）。
只用局域网无需配置公网。

安全提醒：dsh web 能在这台机器上执行代码。默认会随机生成一个 8 位访问密码，
二维码里已内嵌该密码（扫码直达），手动输入地址时需要填写。本机访问免密。
--no-auth 会让任何能连到监听端口的人直接控制 dsh web，仅在完全可信的网络里用。
`);
}

function lanIPv4() {
  // 与插件模式共用同一套网卡打分（私网优先、物理网卡优先、VPN 降权），
  // 此前这里取第一个非 internal IPv4，装了 Tailscale/VMware 时会选到 100.x 或虚拟网卡。
  return selectLanIPv4(networkInterfaces());
}

function printQr(url, label) {
  const qrcodeTerminal = require('qrcode-terminal');
  console.log(`\n${label}\n  ${url}`);
  qrcodeTerminal.generate(url, { small: true }, (qr) => console.log(qr));
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const resolved = resolvePin(args, process.env);
  if (resolved.error) {
    console.error(`❌ ${resolved.error}`);
    process.exit(1);
  }
  const pin = resolved.pin;
  const auth = buildAuth(pin);
  // quick 模式不需要任何 Cloudflare 配置；public（named）模式要求先配好域名与 Token
  const publicConfig = args.public && !args.quick ? resolvePublicConfig() : null;

  console.log('🚀 dsh-pocket 启动中…');
  const { port, close } = await createPocketProxy({ ...args, auth });

  if (pin) {
    console.log(`\n🔐 访问密码：${pin}${resolved.source === 'generated' ? '（本次随机生成）' : ''}`);
    console.log('   二维码已内嵌密码，扫码直达；手动输入地址时需要填写。本机访问免密。');
    if (resolved.source === 'generated') {
      console.log(`   固定密码：--pin <值> 或 DSH_POCKET_PIN=<值>`);
    }
  } else {
    console.log('\n⚠️  已用 --no-auth 关闭访问密码。');
    console.log('   dsh web 能在这台机器上执行任意代码——现在任何能连到');
    console.log(`   ${args.host}:${args.port} 的人都可以直接控制它。请仅在完全可信的网络里这样用。`);
  }

  const lan = lanIPv4();
  if (lan) {
    printQr(entryUrl(`http://${lan}:${port}`, pin), '📶 局域网访问（手机连同一 WiFi）：');
  } else {
    console.log('⚠️  未检测到局域网 IP，跳过局域网二维码');
  }

  // Ctrl+C / kill：停隧道 → 关代理 → 真正退出（修复：之前只停隧道不退出进程）
  const controller = new AbortController();
  let tunnel = null;
  const shutdown = async () => {
    console.log('\n👋 dsh-pocket 已退出 | bye');
    controller.abort();
    tunnel?.kill();
    await close().catch(() => {});
    process.exit(130);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (args.public) {
    console.log(`🌐 正在建立公网隧道（cloudflared，${args.quick ? 'Quick Tunnel 随机地址' : '自配固定域名'}）…`);
    try {
      tunnel = args.quick
        ? await startQuickTunnel({ port, signal: controller.signal })
        : await startNamedTunnel({ token: publicConfig.token, signal: controller.signal });
      // 隧道进程跑着跑着挂了：CLI 没有状态轮询，只能靠这个回调提示，否则二维码一直挂着死链接
      tunnel.onExit?.((code) => {
        console.error(`\n⚠️  公网隧道已断开（code=${code}）。局域网二维码仍可用；要恢复公网请重启 dsh-pocket。`);
      });
      printQr(entryUrl(tunnel.url, pin), args.quick ? '🌐 公网访问（随机 trycloudflare 地址）：' : '🌐 公网访问（自己的固定域名）：');
      console.log(
        args.quick
          ? '   隧道会持续运行；Ctrl+C 退出（地址每次运行都变，访问密码由本次 CLI 参数决定）'
          : '   隧道会持续运行；Ctrl+C 退出（域名不变，访问密码由本次 CLI 参数决定）',
      );
    } catch (err) {
      console.error(`❌ 公网隧道失败：${err.message}（局域网二维码仍可用）`);
    }
  } else {
    console.log(`   （加 --public 开启公网隧道）`);
  }

  console.log(`✅ dsh-pocket 已就绪：手机扫码上面的二维码，看到的界面与电脑完全一致、实时同步。\n   按 Ctrl+C 停止。`);
  await new Promise(() => {});
}

// 只有被直接执行时才启动（测试里 import 本文件拿纯函数时不能把服务跑起来）。
// npm 会把 bin 装成 symlink，argv[1] 是 symlink 路径而 import.meta.url 是真实路径，
// 所以必须先 realpath 再比较，否则装完的 CLI 会变成什么都不做。
const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error(`❌ dsh-pocket: ${err?.message ?? err}`);
    process.exit(1);
  });
}
