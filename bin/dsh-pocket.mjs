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
import { startNamedTunnel } from '../lib/tunnel.mjs';
import { tunnelHostname, tunnelToken } from '../lib/settings.mjs';
import { selectLanIPv4 } from '../lib/service.mjs';
import { isValidIpv4 } from '../lib/ip.mjs';

const require = createRequire(import.meta.url);

/** 自定义密码的最短长度（issue #40：别让人设 `1234`；与设置页的 8 位下限对齐）。 */
export const MIN_PIN_LENGTH = 8;

/** 启动前的一致性校验：返回错误文案（null = 通过）。
 * `--public` + `--no-auth` 是能把「公网域名」直接变成无鉴权入口的组合：
 * resolvePin 先返回 pin=null，buildAuth(null) 返回 null，代理里 `if (auth)` 整块跳过，
 * 于是任何知道固定域名的人都能操作 dsh web（= 在宿主机执行代码）。必须阻止启动。 */
export function cliArgError(args = {}, env = {}) {
  if (args.public && args.noAuth) {
    return '--public 不能与 --no-auth 同时使用：那会让你的固定域名变成无密码的公网入口。'
      + ' | --public cannot be combined with --no-auth.';
  }
  // --no-auth 曾静默压过 --pin / DSH_POCKET_PIN：用户以为设了密码，实际入口是裸的。
  const envPin = env.DSH_POCKET_PIN != null ? String(env.DSH_POCKET_PIN) : '';
  if (args.noAuth && ((args.pin != null && String(args.pin) !== '') || envPin !== '')) {
    return '--no-auth 与已提供的访问密码冲突：要么去掉 --no-auth，要么删掉 --pin / DSH_POCKET_PIN。'
      + ' | --no-auth conflicts with a configured PIN.';
  }
  return null;
}

export function parseArgs(argv) {
  const args = {
    port: 3081,
    host: '0.0.0.0',
    public: false,
    upstream: { host: '127.0.0.1', port: 3080 },
    pin: null,
    pinMissing: false,
    noAuth: false,
    launchToken: '',
    argError: null,
  };
  // 取值型参数统一走这里：缺值或以 '-' 开头都报错，不能把下一个 flag 吞成值。
  // `--host --public` 曾把字面量 "--public" 当主机名（ENOTFOUND），
  // `--port 0` / 非数字曾静默回落 3081（用户以为换了端口）。
  const takeValue = (name, i) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('-')) {
      args.argError = `${name} 后面需要一个值 | ${name} requires a value`;
      return null;
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--public') args.public = true;
    else if (a === '--port') {
      const raw = takeValue('--port', i);
      if (raw === null) break;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        args.argError = `--port 需要 1-65535 之间的整数（收到 ${JSON.stringify(raw)}）| --port expects an integer between 1 and 65535`;
        break;
      }
      args.port = n;
      i++;
    }
    else if (a === '--host') {
      const raw = takeValue('--host', i);
      if (raw === null) break;
      args.host = String(raw);
      i++;
    }
    else if (a === '--launch-token') {
      const raw = takeValue('--launch-token', i);
      if (raw === null) break;
      args.launchToken = String(raw);
      i++;
    }
    else if (a === '--pin') {
      // 缺值时要报错，不能把下一个 flag 当成密码：`--pin --public` 曾让
      // 字面量 "--public" 通过长度校验，同时把 --public 吞掉（用户以为开了公网）。
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        args.pin = '';
        args.pinMissing = true;
      } else {
        args.pin = String(next);
        i++;
      }
    }
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
export function resolvePin({ pin = null, noAuth = false, pinMissing = false } = {}, env = {}) {
  if (noAuth) return { pin: null, source: 'disabled' };
  if (pinMissing) {
    return {
      pin: null,
      source: 'flag',
      error: '--pin 后面需要一个密码值，不能直接跟别的参数。'
        + ' | --pin requires a value (did you forget the password?).',
    };
  }
  const rawFlag = pin != null ? String(pin) : '';
  const rawEnv = env.DSH_POCKET_PIN != null ? String(env.DSH_POCKET_PIN) : '';
  // 提供了密码但只有空白：不能静默回落到随机密码（用户会以为密码就是那串空格）。
  if ((rawFlag !== '' && rawFlag.trim() === '') || (rawFlag === '' && rawEnv !== '' && rawEnv.trim() === '')) {
    return {
      pin: null,
      source: rawFlag !== '' ? 'flag' : 'env',
      error: '访问密码不能只由空白字符组成 | Access password cannot be blank.',
    };
  }
  const explicit = rawFlag !== '' ? { value: rawFlag.trim(), source: 'flag' }
    : (rawEnv.trim() !== '' ? { value: rawEnv.trim(), source: 'env' } : null);
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
  dsh-pocket --port 3081 自定义代理端口（1-65535）
  dsh-pocket --host <地址> 自定义监听地址（默认 0.0.0.0；只填一个私网 IP 时二维码用它）
  dsh-pocket --launch-token <值> dsh web 的启动 token（新版 dsh 首屏 401 时用；插件模式会自动注入）
  dsh-pocket --pin <值>  自定义访问密码（至少 ${MIN_PIN_LENGTH} 位；也可用环境变量 DSH_POCKET_PIN）
  dsh-pocket --no-auth   关闭访问密码（不推荐，见下）
  dsh-pocket --help      帮助

前提：dsh web 已在 127.0.0.1:3080 运行（npx @deepseek-ai/dsh web）。
公网：先在同一 DSH_HOME 的「设置 → 手机访问」保存自己的固定域名与 Tunnel Token，
并将 Cloudflare Service 指向 CLI 的实际代理端口（默认 http://127.0.0.1:3081）。
未配置时 --public 会拒绝启动；不会分配随机域名。只用局域网无需配置公网。

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

  const argError = args.argError ?? cliArgError(args, process.env);
  if (argError) {
    console.error(`❌ ${argError}`);
    process.exit(1);
  }

  const resolved = resolvePin(args, process.env);
  if (resolved.error) {
    console.error(`❌ ${resolved.error}`);
    process.exit(1);
  }
  const pin = resolved.pin;
  const auth = buildAuth(pin);
  const publicConfig = args.public ? resolvePublicConfig() : null;

  console.log('🚀 dsh-pocket 启动中…');
  // launchToken：CLI 拿不到 `dsh web` 打印的启动 token，只能由用户显式传入；
  // 不传时新版 dsh 首屏 /api 会 401（与插件模式的差异，见 --launch-token）。
  const launchToken = args.launchToken ? () => args.launchToken : undefined;
  const { port, close } = await createPocketProxy({ ...args, auth, launchToken });

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
    if (!args.public) {
      // 用户自建的隧道/反代不经过本 CLI，--public 检查拦不到，只能明确提醒（审计 low）
      console.log('   注意：如果你另开了 Cloudflare 隧道、ngrok、frp 或路由器端口转发，');
      console.log('   它们也会把这个无密码端口暴露出去——请先确认没有任何公网入口。');
    }
  }

  // 指定了具体监听地址就别再打印一个没在监听的网卡 IP（审计 low：实测二维码指向未监听地址）
  const explicitHost = args.host && args.host !== '0.0.0.0' && args.host !== '::' && args.host !== '::0';
  const lan = explicitHost ? (isValidIpv4(args.host) ? args.host : null) : lanIPv4();
  if (lan) {
    printQr(entryUrl(`http://${lan}:${port}`, pin), '📶 局域网访问（手机连同一 WiFi）：');
  } else if (explicitHost) {
    console.log(`⚠️  --host ${args.host} 不是可打印二维码的 IPv4 地址，跳过局域网二维码`);
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
    console.log('🌐 正在建立公网隧道（cloudflared）…');
    try {
      tunnel = await startNamedTunnel({ token: publicConfig.token, signal: controller.signal });
      // 隧道进程跑着跑着挂了：CLI 没有状态轮询，只能靠这个回调提示，否则二维码一直挂着死链接
      tunnel.onExit?.((code) => {
        console.error(`\n⚠️  公网隧道已断开（code=${code}）。局域网二维码仍可用；要恢复公网请重启 dsh-pocket。`);
      });
      printQr(entryUrl(publicConfig.url, pin), '🌐 公网访问（自己的固定域名）：');
      console.log('   隧道会持续运行；Ctrl+C 退出（域名不变，访问密码由本次 CLI 参数决定）');
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
