// dsh-pocket 服务 + RPC 测试（stub 隧道/代理，无网络）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPocketService, selectLanIPv4 } from '../lib/service.mjs';
import { installPocketRpc } from '../lib/web-rpc.js';
import { POCKET_RPC_CHANNEL, POCKET_ENDPOINTS } from '../client/api.js';
import { isValidIpv4 } from '../lib/ip.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeCtxConnection() {
  let handler = null;
  const handle = (channel, fn, opts) => {
    assert.equal(channel, POCKET_RPC_CHANNEL);
    assert.deepEqual(opts, { authority: 'loopback' });
    handler = fn;
    return () => { handler = null; };
  };
  return { rpc: { handle }, get handler() { return handler; } };
}

const FAKE_TUNNEL_TOKEN = 'fake-cloudflared-token-for-tests';

function namedTunnelConfig(overrides = {}) {
  return { mode: 'named', token: FAKE_TUNNEL_TOKEN, hostname: 'pocket.example.com', ...overrides };
}

function stubInternals() {
  const started = [];
  return {
    started,
    lanIPv4: () => '192.168.1.50',
    lanCandidates: async () => ['192.168.1.50', '100.119.24.44'],
    encodeQr: async (text) => `data:qr;${text}`,
    createProxy: async ({ port }) => ({
      port,
      close: async () => { started.push('closed'); },
    }),
    startNamedTunnel: async ({ token }) => {
      started.push(`named:${token}`);
      return { url: null, kill: () => {} };
    },
    startQuickTunnel: async ({ port }) => {
      started.push(`quick:${port}`);
      return { url: `https://fake-${port}.trycloudflare.com`, kill: () => {} };
    },
  };
}

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshp-service-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

/** 构造 networkInterfaces() 形状的最小接口表。 */
function ifaces(entries) {
  return Object.fromEntries(entries.map(([name, ip]) => [name, [{ address: ip, family: 'IPv4', internal: false }]]));
}

test('selectLanIPv4：排在前面的 Radmin VPN 不遮蔽 WLAN 私网地址', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['Radmin VPN', '198.51.100.10'],
      ['WLAN', '192.168.1.50'],
    ])),
    '192.168.1.50',
  );
});

test('selectLanIPv4：两张私网网卡时优先名称像物理网卡的接口', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['vEthernet (WSL)', '172.25.0.1'],
      ['以太网', '10.0.0.8'],
    ])),
    '10.0.0.8',
    '同为 RFC1918 私网时，物理网卡优先于虚拟网卡',
  );
});

test('selectLanIPv4（issue #43）：Easytier 网卡不遮蔽改名后的物理网卡', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['et_15_x3sw', '10.126.126.1'], // Easytier P2P VPN 网卡
      ['有线连接', '192.168.1.1'],    // 改过名的物理网卡（中文名）
    ])),
    '192.168.1.1',
    'Easytier（et_ 前缀）被识别为 VPN 减分，中文物理网卡名（有线）加分',
  );
  // 物理网卡排在前时也不变（"无线网络连接"中文名）
  assert.equal(
    selectLanIPv4(ifaces([
      ['无线网络连接', '192.168.31.8'],
      ['et_aaa01', '10.126.126.1'],
    ])),
    '192.168.31.8',
    '无线网络连接（中文物理名）优先',
  );
});

test('selectLanIPv4：没有私网地址时回退到非回环地址（纯 VPN 环境仍可用）', () => {
  assert.equal(
    selectLanIPv4(ifaces([
      ['Radmin VPN', '198.51.100.10'],
      ['Loopback Pseudo-Interface 1', '127.0.0.1'],
      ['WLAN', '169.254.12.34'],
    ])),
    '198.51.100.10',
  );
});

test('selectLanIPv4：空接口表返回 null', () => {
  assert.equal(selectLanIPv4({}), null);
});

test('selectLanIPv4（issue #176）：Windows 移动热点/ICS 虚拟网卡不遮蔽真实 Wi-Fi', () => {
  // 手机连真实 Wi-Fi 时与 192.168.137.1（ICS 共享网段）不同网段，扫码不可达
  assert.equal(
    selectLanIPv4(ifaces([
      ['本地连接* 12', '192.168.137.1'],
      ['WLAN', '192.168.1.50'],
    ])),
    '192.168.1.50',
    '本地连接*（ICS）被识别为虚拟网卡，物理 WLAN 优先',
  );
  // 只有 ICS 网卡时仍返回它（总比没有地址可用强），但同分排序时排后
  assert.equal(
    selectLanIPv4(ifaces([
      ['本地连接* 12', '192.168.137.1'],
      ['以太网 2', '192.168.137.20'],
    ])),
    '192.168.137.20',
    '同为 ICS 网段时仍优先名称像物理网卡的接口',
  );
  // hostednetwork / Wi-Fi Direct 也按虚拟网卡处理
  assert.equal(
    selectLanIPv4(ifaces([
      ['Microsoft Wi-Fi Direct Virtual Adapter', '192.168.137.1'],
      ['Wi-Fi', '10.0.0.8'],
    ])),
    '10.0.0.8',
    'Wi-Fi Direct 虚拟适配器不遮蔽真实 Wi-Fi',
  );
});

test('service：lanIpOverride 优先于自动选择，status 返回候选地址', async () => {
  const internals = stubInternals();
  let override = '';
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanIpOverride: () => override });
  await service.startProxy();

  let st = await service.status();
  assert.equal(st.lanUrl, 'http://192.168.1.50:3081', '默认自动选择');
  assert.deepEqual(st.lanCandidates, ['192.168.1.50', '100.119.24.44'], '候选包含 Tailscale IP');
  assert.equal(st.lanIpOverride, '', '未设置覆盖');

  override = '100.119.24.44';
  st = await service.status();
  assert.equal(st.lanUrl, 'http://100.119.24.44:3081', '手动覆盖优先');
  assert.equal(st.lanIpOverride, '100.119.24.44', '状态返回当前覆盖');

  override = 'not-an-ip';
  st = await service.status();
  assert.equal(st.lanUrl, 'http://192.168.1.50:3081', '非法覆盖被忽略，回退自动选择');
  assert.equal(st.lanIpOverride, '', '非法覆盖不进入状态');

  await service.dispose();
});


test('service：startProxy → 局域网状态（含二维码）；startTunnel → 公网状态', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });

  const before = await service.status();
  assert.equal(before.proxyRunning, false);

  const proxy = await service.startProxy();
  assert.equal(proxy.port, 3081);
  const lan = await service.status();
  assert.equal(lan.lanUrl, 'http://192.168.1.50:3081');
  assert.equal(lan.lanQr, 'data:qr;http://192.168.1.50:3081');
  assert.equal(lan.tunnelRunning, false);

  const url = await service.startTunnel();
  assert.equal(url, 'https://pocket.example.com');
  const pub = await service.status();
  assert.equal(pub.tunnelRunning, true);
  assert.equal(pub.tunnelQr, 'data:qr;https://pocket.example.com');
  assert.deepEqual(internals.started, [`named:${FAKE_TUNNEL_TOKEN}`], 'Named 隧道使用已配置 Token');
  assert.equal(pub.proxyPort, 3081, '局域网代理端口保持不变');
  assert.equal(pub.tunnelUrl, 'https://pocket.example.com', '公网 URL 使用已配置域名');
  assert.deepEqual(pub.tunnelConfig, { mode: 'named', hostname: 'pocket.example.com', tokenSet: true }, '状态仅返回脱敏配置');

  service.stopTunnel();
  const stopped = await service.status();
  assert.equal(stopped.tunnelRunning, false);
  assert.equal(stopped.lanUrl, 'http://192.168.1.50:3081', '停隧道不影响局域网代理');

  await service.dispose();
});

// 融合版：只有 named 配置不完整才拒绝；不带 mode / 非 named 一律按 quick（零配置）启动。
for (const [label, cfg] of [
  ['named 缺少 Token', { mode: 'named', hostname: 'pocket.example.com' }],
  ['named 缺少域名', { mode: 'named', token: FAKE_TUNNEL_TOKEN }],
]) {
  test(`service：${label} 拒绝公网启动，不下载或拉起隧道`, () => withHome(async (home) => {
    const internals = stubInternals();
    const service = createPocketService({
      dshPort: 3080, port: 3081, home, internals,
      ...(cfg === undefined ? {} : { getTunnelConfig: () => cfg }),
    });
    try {
      await assert.rejects(() => service.startTunnel(), /固定域名.*Tunnel Token/);
      await assert.rejects(() => service.startTunnel(), /固定域名.*Tunnel Token/, '失败后再次调用仍正常拒绝，无残留 in-flight');
      assert.deepEqual(internals.started, [], '不得进入负责下载和启动的 Named 路径');
      const status = await service.status();
      assert.equal(status.proxyRunning, true, '未配置公网不影响 LAN 代理');
      assert.equal(status.tunnelRunning, false);
      assert.equal(status.tunnelUrl, null);
      assert.equal(status.tunnelQr, null);
      assert.equal(status.tunnelState.phase, 'error');
      assert.equal(status.tunnelState.startedAt, null);
      assert.equal(status.tunnelConfig.mode, 'named');
      assert.equal(existsSync(join(home, 'dsh-pocket', 'tunnel-auto.json')), false, '失败不创建恢复标记');
      assert.equal(existsSync(join(home, 'dsh-pocket', 'bin')), false, '失败不创建下载缓存');
    } finally {
      await service.dispose();
    }
  }));
}

test('service：并发开启 Named 单飞，重复开启复用，主动关闭杀一次', async () => {
  let startCount = 0;
  let killCount = 0;
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const readyModes = [];
  const service = createPocketService({
    dshPort: 3080, port: 3081, getTunnelConfig: namedTunnelConfig,
    onTunnelReady: (mode) => readyModes.push(mode),
    internals: {
      ...stubInternals(),
      startNamedTunnel: async ({ token }) => {
        assert.equal(token, FAKE_TUNNEL_TOKEN);
        startCount += 1;
        entered();
        await gate;
        return { url: null, kill: () => { killCount += 1; } };
      },
    },
  });
  try {
    const requests = [service.startTunnel(), service.startTunnel(), service.startTunnel()];
    await started;
    assert.equal(startCount, 1, '并发调用只进入一次 Named 启动');
    release();
    assert.deepEqual(await Promise.all(requests), Array(3).fill('https://pocket.example.com'));
    assert.equal(await service.startTunnel(), 'https://pocket.example.com', '已启动时复用 URL');
    assert.equal(startCount, 1, '重复开启不创建额外进程');
    assert.deepEqual(readyModes, ['named'], '就绪回调仅一次且只报告 named');
    service.stopTunnel();
    service.stopTunnel();
    assert.equal(killCount, 1, '重复停止不会重复 kill');
    assert.equal((await service.status()).tunnelRunning, false);
  } finally {
    release();
    await service.dispose();
  }
});

test('service：Named 进程异常退出清理公网状态，可再次开启', async () => {
  let onExit;
  let startCount = 0;
  const service = createPocketService({
    dshPort: 3080, port: 3081, getTunnelConfig: namedTunnelConfig,
    internals: {
      ...stubInternals(),
      startNamedTunnel: async () => {
        startCount += 1;
        return { url: null, kill: () => {}, onExit: (cb) => { onExit = cb; } };
      },
    },
  });
  try {
    await service.startTunnel();
    onExit(17);
    const dead = await service.status();
    assert.equal(dead.tunnelRunning, false);
    assert.equal(dead.tunnelUrl, null);
    assert.equal(dead.tunnelQr, null);
    assert.equal(dead.tunnelState.phase, 'error');
    assert.match(dead.tunnelState.detail, /code=17/);
    assert.equal(dead.tunnelState.startedAt, null);
    assert.equal(await service.startTunnel(), 'https://pocket.example.com');
    assert.equal(startCount, 2, '退出后可重新启动，而非复用死 URL');
    service.stopTunnel();
    onExit(0);
    assert.equal((await service.status()).tunnelState.phase, 'idle', '主动停止后的退出通知不误报故障');
  } finally {
    await service.dispose();
  }
});

test('RPC：默认 quick 可直接开启；保存 Named 仅落盘不启动；显式启动和 reset 均按配置生效', () => withHome(async () => {
  const settings = await import('../lib/settings.mjs');
  const { resetPocketState } = await import('../lib/index.js');
  const internals = stubInternals();
  const service = createPocketService({
    dshPort: 3080, port: 3081, internals,
    getTunnelConfig: () => ({ mode: settings.tunnelMode(), token: settings.tunnelToken(), hostname: settings.tunnelHostname() }),
  });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getTunnelConfig: () => ({ mode: settings.tunnelMode(), hostname: settings.tunnelHostname(), tokenSet: Boolean(settings.tunnelToken()) }),
    setTunnelConfig: settings.setNamedTunnelConfig,
    resetPocket: resetPocketState,
    log: { error() {}, warn() {} },
  });
  try {
    // 融合版：默认 quick 通道零配置，勾了免责声明就能开
    const quickStart = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
    assert.equal(quickStart.ok, true, '默认 quick 通道无需任何 Cloudflare 配置');
    assert.deepEqual(quickStart.value.tunnelConfig, { mode: 'quick', hostname: '', tokenSet: false });
    assert.equal(quickStart.value.tunnelConfig.mode, 'quick');
    assert.deepEqual(internals.started, ['quick:3081'], '走快速隧道并带上代理端口');
    assert.match(String(quickStart.value.tunnelUrl), /trycloudflare\.com$/, 'quick 用随机域名');
    service.stopTunnel();
    internals.started.length = 0;

    const saved = await conn.handler(POCKET_ENDPOINTS.tunnelSetConfig, namedTunnelConfig());
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.value.tunnelConfig, { mode: 'named', hostname: 'pocket.example.com', tokenSet: true });
    assert.equal(saved.value.tunnelRunning, false, '保存不等于启动');
    assert.equal(saved.value.tunnelUrl, null);
    assert.deepEqual(internals.started, [], '保存不下载或启动 cloudflared');
    assert.ok(!JSON.stringify(saved).includes(FAKE_TUNNEL_TOKEN), '保存响应不回显 Token');
    const before = readFileSync(settings.settingsPath(), 'utf8');

    const quick = await conn.handler(POCKET_ENDPOINTS.tunnelSetConfig, namedTunnelConfig({ mode: 'quick', hostname: 'other.example.com', token: 'fake-replacement-token-for-tests' }));
    assert.equal(quick.ok, false, 'named 保存通道不接受 quick 模式（切模式走 setTunnelMode）');
    assert.equal(quick.error.code, 'bad-request');
    assert.equal(readFileSync(settings.settingsPath(), 'utf8'), before, '拒绝 quick 不改 Token 或域名');
    assert.deepEqual(internals.started, []);

    const denied = await conn.handler(POCKET_ENDPOINTS.tunnelStart, {});
    assert.equal(denied.ok, false, '保存后显式开启仍须免责声明');
    assert.deepEqual(internals.started, []);
    const started = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
    assert.equal(started.ok, true);
    assert.equal(started.value.tunnelUrl, 'https://pocket.example.com');
    assert.deepEqual(internals.started, [`named:${FAKE_TUNNEL_TOKEN}`]);

    const unconfirmed = await conn.handler(POCKET_ENDPOINTS.pocketReset, {});
    assert.equal(unconfirmed.ok, false, 'reset 必须显式确认');
    assert.equal((await service.status()).tunnelRunning, true, '未确认不停止隧道');
    const reset = await conn.handler(POCKET_ENDPOINTS.pocketReset, { confirm: true });
    assert.equal(reset.ok, true);
    assert.equal(reset.value.tunnelRunning, false, 'reset 先停止隧道');
    assert.deepEqual(reset.value.tunnelConfig, { mode: 'quick', hostname: '', tokenSet: false }, 'reset 回到未配置状态（默认 quick）');
    assert.equal(settings.tunnelAutoRestoreEnabled(), false, 'reset 关闭旧标记恢复资格');
    // 融合版：reset 回到默认 quick，因此再次开启会走快速隧道（随机域名）
    const afterReset = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
    assert.equal(afterReset.ok, true, 'reset 后回到默认 quick，零配置可再开启');
    assert.equal(afterReset.value.tunnelConfig.mode, 'quick');
    assert.deepEqual(internals.started, [`named:${FAKE_TUNNEL_TOKEN}`, 'quick:3081'], '仅新增一次快速隧道启动');
    service.stopTunnel();
  } finally {
    await service.dispose();
  }
}));

test('RPC：status / tunnel.start / tunnel.stop / 未知端点', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, { service, log: { error() {}, warn() {} } });

  // 先让代理跑起来（插件 apply 里会自动启动）
  await service.startProxy();

  const s1 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s1.ok, true);
  assert.equal(s1.value.lanUrl, 'http://192.168.1.50:3081');
  assert.ok(s1.value.lanQr.startsWith('data:qr;'), '局域网二维码 data URL');
  assert.equal(s1.value.restartNotice, null, '无重启标记时 restartNotice 为 null');

  const denied = await conn.handler(POCKET_ENDPOINTS.tunnelStart, {});
  assert.equal(denied.ok, false, '未勾选免责声明 → 拒绝开启');
  assert.equal(denied.error.code, 'bad-request');
  assert.ok(denied.error.message.includes('免责声明'), '提示勾选免责声明');

  const started = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
  assert.equal(started.ok, true);
  assert.equal(started.value.tunnelRunning, true);
  assert.equal(started.value.tunnelUrl, 'https://pocket.example.com');

  const stopped = await conn.handler(POCKET_ENDPOINTS.tunnelStop, {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.tunnelRunning, false);

  const unknown = await conn.handler('nope', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'bad-request');

  await service.dispose();
});

test('RPC：lan.setOverride 设置/清除覆盖地址，非法 IP 被拒绝', async () => {
  const internals = stubInternals();
  let stored = '';
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanIpOverride: () => stored });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getLanIpOverride: () => stored,
    setLanIpOverride: (ip) => {
      if (ip && !isValidIpv4(ip)) throw new Error('局域网地址必须是 IPv4 地址 | LAN address must be an IPv4 address');
      stored = ip;
      return ip;
    },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const set = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '100.119.24.44' });
  assert.equal(set.ok, true);
  assert.equal(set.value.lanIpOverride, '100.119.24.44', '覆盖地址已保存');
  const st = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(st.value.lanUrl, 'http://100.119.24.44:3081', '二维码使用覆盖地址');

  const bad = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '999.1.1.1' });
  assert.equal(bad.ok, false, '非法地址拒绝');
  assert.equal(bad.error.code, 'bad-request');

  const clear = await conn.handler(POCKET_ENDPOINTS.lanSetOverride, { ip: '' });
  assert.equal(clear.ok, true);
  assert.equal(clear.value.lanIpOverride, '', '清除覆盖');
  const restored = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(restored.value.lanUrl, 'http://192.168.1.50:3081', '恢复自动选择');

  await service.dispose();
});

test('RPC：lan.setEnabled 设置局域网访问总开关并回写到 status', async () => {
  const internals = stubInternals();
  let lanOn = true;
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getLanEnabled: () => lanOn });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getLanEnabled: () => lanOn,
    setLanEnabled: (on) => { lanOn = on === true; return lanOn; },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const s1 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s1.ok, true);
  assert.equal(s1.value.lanEnabled, true, '默认开启');

  const off = await conn.handler(POCKET_ENDPOINTS.lanSetEnabled, { on: false });
  assert.equal(off.ok, true);
  assert.equal(off.value.lanEnabled, false, '关闭成功');
  assert.equal((await conn.handler(POCKET_ENDPOINTS.status, {})).value.lanEnabled, false, 'status 反映关闭');

  const on = await conn.handler(POCKET_ENDPOINTS.lanSetEnabled, { on: true });
  assert.equal(on.ok, true);
  assert.equal(on.value.lanEnabled, true, '重新开启');

  await service.dispose();
});

test('RPC：settings 写失败 → lan.setEnabled 回 ok:false（P1-1）', async () => {
  // 真实 setter 走真实写盘：用同名文件占住 <DSH_HOME>/dsh-pocket，writeSettings
  // 必失败并抛错（旧实现吞错返回原值，设置页显示已保存而实际没落盘）。
  const home = mkdtempSync(join(tmpdir(), 'dshp-svc-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    writeFileSync(join(home, 'dsh-pocket'), 'not a dir');
    const { setLanEnabled } = await import('../lib/settings.mjs');
    const internals = stubInternals();
    const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
    const conn = fakeCtxConnection();
    installPocketRpc({ connection: conn }, {
      service,
      setLanEnabled, // 真实 setter：写盘失败会抛
      log: { error() {}, warn() {} },
    });
    const res = await conn.handler(POCKET_ENDPOINTS.lanSetEnabled, { on: false });
    assert.equal(res.ok, false, '写失败回 ok:false');
    assert.equal(res.error?.code, 'bad-request', '错误信封带 bad-request');
    await service.dispose();
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('RPC：mobile.rightbar.setEnabled 默认开启并回写到 status', async () => {
  const internals = stubInternals();
  let enabled = true;
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getMobileRightbarEnabled: () => enabled,
    setMobileRightbarEnabled: (on) => { enabled = on === true; return enabled; },
    log: { error() {}, warn() {} },
  });

  const initial = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(initial.ok, true);
  assert.equal(initial.value.mobileRightbarEnabled, true, '默认开启');

  const off = await conn.handler(POCKET_ENDPOINTS.mobileRightbarSetEnabled, { on: false });
  assert.equal(off.ok, true);
  assert.equal(off.value.mobileRightbarEnabled, false, '关闭成功');
  assert.equal((await conn.handler(POCKET_ENDPOINTS.status, {})).value.mobileRightbarEnabled, false, 'status 反映关闭');

  const on = await conn.handler(POCKET_ENDPOINTS.mobileRightbarSetEnabled, { on: true });
  assert.equal(on.ok, true);
  assert.equal(on.value.mobileRightbarEnabled, true, '可再次开启');

  await service.dispose();
});

test('RPC：mobile.font.setSize 持久化并回写到 status', async () => {
  const internals = stubInternals();
  let size = 0;
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    getMobileFontSize: () => size,
    setMobileFontSize: (next) => {
      if (!Number.isInteger(next) || (next !== 0 && (next < 12 || next > 22))) throw new Error('invalid size');
      size = next;
      return size;
    },
    log: { error() {}, warn() {} },
  });

  const initial = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(initial.ok, true);
  assert.equal(initial.value.mobileFontSize, 0, '默认 0 = 跟随桌面');

  const set = await conn.handler(POCKET_ENDPOINTS.mobileFontSetSize, { size: 18 });
  assert.equal(set.ok, true);
  assert.equal(set.value.mobileFontSize, 18, '设置成功并回传');
  assert.equal((await conn.handler(POCKET_ENDPOINTS.status, {})).value.mobileFontSize, 18, 'status 反映新字号');

  const bad = await conn.handler(POCKET_ENDPOINTS.mobileFontSetSize, { size: 99 });
  assert.equal(bad.ok, false, '越界值回 ok:false');
  assert.equal(bad.error?.code, 'bad-request', '错误信封带 bad-request');

  const back = await conn.handler(POCKET_ENDPOINTS.mobileFontSetSize, { size: 0 });
  assert.equal(back.ok, true);
  assert.equal(back.value.mobileFontSize, 0, '0 恢复跟随桌面');

  await service.dispose();
});

test('RPC：status 携带重启提示（restartNotice）', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    restartNotice: () => ({ at: Date.now(), pid: 12345 }),
    log: { error() {}, warn() {} },
  });

  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.ok, true);
  assert.equal(s.value.restartNotice.pid, 12345, '重启标记随 status 返回');

  await service.dispose();
});

test('隧道进度：startTunnel 阶段透出到 status.tunnelState', async () => {
  const internals = {
    ...stubInternals(),
    startNamedTunnel: async ({ onPhase }) => {
      onPhase('downloading');
      onPhase('registering');
      onPhase('ready');
      return { url: null, kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  await service.startProxy();
  await service.startTunnel();
  const s = await service.status();
  assert.equal(s.tunnelState.phase, 'ready');
  assert.ok(s.tunnelState.startedAt > 0, '开始时间已记录');
  assert.ok(s.tunnelState.detail.length > 0);
  service.stopTunnel();
  const after = await service.status();
  assert.equal(after.tunnelState.phase, 'idle');
});

test('自重启：restartHost 用 detached 辅助进程交接，旧进程随后退出', async () => {
  const { restartHost } = await import('../lib/restart.js');
  const calls = [];
  const result = restartHost({
    internals: {
      spawn: (file, args, opts) => { calls.push({ file, args, detached: opts?.detached }); return { pid: 4242, unref: () => {} }; },
      kill: (pid) => calls.push('kill:' + pid),
    },
  });
  assert.equal(result.helperPid, 4242, '返回辅助进程 pid');
  assert.ok(result.logOut.endsWith('.out.log'), '输出日志路径');
  assert.ok(result.logErr.endsWith('.err.log'), '错误日志路径');
  // 辅助进程：node -e <helperCode>，detached，代码内含新 dsh 的启动命令
  assert.equal(calls.length, 1, '只拉起一个辅助进程');
  const helper = calls[0];
  assert.equal(helper.file, process.execPath, '用 node 拉起辅助进程');
  assert.equal(helper.args[0], '-e');
  assert.equal(helper.detached, true, '辅助进程 detached');
  const code = helper.args[1];
  assert.ok(code.includes(JSON.stringify(process.argv[0])), '辅助代码含 node 路径');
  assert.ok(code.includes('waitPort'), '辅助代码含端口释放探测（替代固定延时）');
  assert.ok(code.includes('setTimeout'), '辅助代码含轮询延时');
  // helper 代码必须是可执行的有效 JS（防拼接语法错误 → 重启静默失败）
  const vm = await import('node:vm');
  try {
    vm.compileFunction(code, [], { filename: 'restart-helper.js' });
  } catch (e) {
    assert.fail('helper 代码语法错误: ' + e.message);
  }
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(calls.some((c) => typeof c === 'string' && c.startsWith('kill:')), '短暂等待后旧进程退出');
});

test('dshPortFromArgs：--port / -p / --port= 三种形式', async () => {
  const { dshPortFromArgs } = await import('../lib/restart.js');
  assert.equal(dshPortFromArgs(['web']), 3080, '默认 3080');
  assert.equal(dshPortFromArgs(['web', '--port', '3099']), 3099);
  assert.equal(dshPortFromArgs(['web', '-p', '3100']), 3100);
  assert.equal(dshPortFromArgs(['web', '--port=3111']), 3111, '--port= 形式');
  assert.equal(dshPortFromArgs(['web', '--port', 'abc']), 3080, '非法值回退默认');
});

test('自重启失败：spawn 抛错 → 返回 helperPid:null 和错误', async () => {
  const { restartHost } = await import('../lib/restart.js');
  const result = restartHost({
    internals: {
      spawn: () => { throw new Error('boom'); },
      kill: () => {},
    },
  });
  assert.equal(result.helperPid, null);
  assert.match(result.error, /boom/);
});

test('readRestartNotice：真实文件系统（无文件/坏 JSON/过期/有效）', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { readRestartNotice } = await import('../lib/index.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pocket-test-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    // 1. 无文件（ENOENT）→ null，且不得产生未处理的 promise rejection（曾导致启动崩溃）
    assert.equal(await readRestartNotice(), null, '无标记文件返回 null');

    // 2. 坏 JSON → null
    await fsp.mkdir(path.join(dir, 'dsh-pocket'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'dsh-pocket', 'restarted.json'), 'not-json');
    assert.equal(await readRestartNotice(), null, '坏 JSON 返回 null');

    // 3. 过期标记（31 分钟前）→ null
    await fsp.writeFile(path.join(dir, 'dsh-pocket', 'restarted.json'), JSON.stringify({ at: Date.now() - 31 * 60 * 1000, pid: 1 }));
    assert.equal(await readRestartNotice(), null, '过期标记返回 null');

    // 4. 有效标记 → 返回内容
    await fsp.writeFile(path.join(dir, 'dsh-pocket', 'restarted.json'), JSON.stringify({ at: Date.now(), pid: 4242 }));
    const n = await readRestartNotice();
    assert.equal(n.pid, 4242, '有效标记返回 pid');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('consumeRestartNotice：读后即删（横幅只显示一次，不会一直出现）', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const { consumeRestartNotice } = await import('../lib/index.js');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pocket-consume-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const noticePath = path.join(dir, 'dsh-pocket', 'restarted.json');
    await fsp.mkdir(path.dirname(noticePath), { recursive: true });
    await fsp.writeFile(noticePath, JSON.stringify({ at: Date.now(), pid: 4242 }));

    // 第一次消费：返回标记，且文件被删除
    const n1 = await consumeRestartNotice();
    assert.equal(n1.pid, 4242, '第一次消费返回标记');
    await assert.rejects(fsp.access(noticePath), '文件已删除');

    // 第二次消费：文件没了 → null（横幅不会一直显示）
    const n2 = await consumeRestartNotice();
    assert.equal(n2, null, '消费后不再返回');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('RPC：restartNotice 读取抛错时 status 优雅降级为 null', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    restartNotice: async () => { throw new Error('ENOENT'); },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();
  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.ok, true);
  assert.equal(s.value.restartNotice, null, '读取失败不阻塞 status');
  await service.dispose();
});

test('RPC：version 返回磁盘版本 current 与启动版本 loaded', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    runUpdate: { currentVersion: () => '1.0.15', loadedVersion: () => '1.0.14', perform: async () => ({ ok: true }) },
    log: { error() {}, warn() {} },
  });

  const v = await conn.handler(POCKET_ENDPOINTS.version, {});
  assert.equal(v.ok, true);
  assert.equal(v.value.current, '1.0.15', 'current 是磁盘实时版本');
  assert.equal(v.value.loaded, '1.0.14', 'loaded 是进程启动版本');

  await service.dispose();
});

test('RPC：version 返回 repository（安装来源仓库），旧 runUpdate 形状降级为 null', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    runUpdate: {
      currentVersion: () => '2.10.6',
      loadedVersion: () => '2.10.6',
      currentRepository: () => 'git+https://github.com/daha1216/dsh-pocket.git',
      perform: async () => ({ ok: true }),
    },
    log: { error() {}, warn() {} },
  });
  const v = await conn.handler(POCKET_ENDPOINTS.version, {});
  assert.equal(v.value.repository, 'git+https://github.com/daha1216/dsh-pocket.git');

  const conn2 = fakeCtxConnection();
  installPocketRpc({ connection: conn2 }, {
    service,
    runUpdate: { currentVersion: () => '1.0.0', loadedVersion: () => '1.0.0', perform: async () => ({ ok: true }) },
    log: { error() {}, warn() {} },
  });
  const v2 = await conn2.handler(POCKET_ENDPOINTS.version, {});
  assert.equal(v2.value.repository, null);

  await service.dispose();
});

test('RPC：update 对 fork/分支安装拦截一键更新，registry 不可达时放行', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const realFetch = globalThis.fetch;
  const makeRunUpdate = () => {
    const calls = [];
    return {
      calls,
      currentVersion: () => '2.10.6',
      loadedVersion: () => '2.10.6',
      currentRepository: () => 'git+https://github.com/daha1216/dsh-pocket.git',
      perform: async (profile) => { calls.push(profile); return { ok: true }; },
    };
  };
  try {
    // ① npm 上游 repository 与本地不同源 → 拦截，perform 不得执行
    globalThis.fetch = async () => ({ json: async () => ({ version: '2.11.0', repository: { url: 'git+https://github.com/shaobeichen/dsh-pocket.git' } }) });
    {
      const runUpdate = makeRunUpdate();
      const conn = fakeCtxConnection();
      installPocketRpc({ connection: conn }, { service, runUpdate, log: { error() {}, warn() {} } });
      const r = await conn.handler(POCKET_ENDPOINTS.update, { profile: 'web' });
      assert.equal(r.ok, false);
      assert.match(r.error.message, /fork\/分支安装/);
      assert.deepEqual(runUpdate.calls, [], 'fork 不得执行一键更新');
    }
    // ② 同源（归一化后一致）→ 放行
    globalThis.fetch = async () => ({ json: async () => ({ version: '2.11.0', repository: { url: 'https://github.com/daha1216/dsh-pocket' } }) });
    {
      const runUpdate = makeRunUpdate();
      const conn = fakeCtxConnection();
      installPocketRpc({ connection: conn }, { service, runUpdate, log: { error() {}, warn() {} } });
      const r = await conn.handler(POCKET_ENDPOINTS.update, { profile: 'web' });
      assert.equal(r.ok, true);
      assert.deepEqual(runUpdate.calls, ['web']);
    }
    // ③ registry 不可达 → 放行（一键更新需要联网，离线时按钮也不出现）
    globalThis.fetch = async () => { throw new Error('ENOTFOUND'); };
    {
      const runUpdate = makeRunUpdate();
      const conn = fakeCtxConnection();
      installPocketRpc({ connection: conn }, { service, runUpdate, log: { error() {}, warn() {} } });
      const r = await conn.handler(POCKET_ENDPOINTS.update, { profile: 'web' });
      assert.equal(r.ok, true);
      assert.deepEqual(runUpdate.calls, ['web']);
    }
  } finally {
    globalThis.fetch = realFetch;
    await service.dispose();
  }
});

test('isSameRepo/normalizeRepoUrl：fork 判定（更新横幅常显案）', async () => {
  const { isSameRepo, normalizeRepoUrl } = await import('../client/api.js');
  assert.equal(normalizeRepoUrl('git+https://github.com/Shaobeichen/DSH-POCKET.git/'), 'https://github.com/shaobeichen/dsh-pocket');
  assert.equal(isSameRepo('git+https://github.com/daha1216/dsh-pocket.git', 'git+https://github.com/shaobeichen/dsh-pocket.git'), false);
  assert.equal(isSameRepo('git+https://github.com/daha1216/dsh-pocket.git', 'https://github.com/daha1216/dsh-pocket'), true);
  assert.equal(isSameRepo(null, 'https://github.com/shaobeichen/dsh-pocket'), false);
  assert.equal(isSameRepo('https://github.com/x/y', ''), false);
});

test('lib/index.js 模块可加载，apply 可调用（防模块级 ReferenceError 回归）', () => withHome(async () => {
  // 回归：pocketRestart 曾引用 apply 参数里的 internals，点「重启」抛 ReferenceError
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.readRestartNotice, 'function');
  assert.equal(typeof mod.name, 'string');

  // apply 用最小 fake ctx 调用不应抛错（不启动真实代理：注入 stub service）
  const ctx = {
    logger: () => ({ error() {}, info() {}, warn() {} }),
    webServer: { port: 3080 },
    on: () => () => {},
    effect: () => {},
  };
  const stubService = {
    startProxy: async () => ({}), dispose: async () => {}, status: async () => ({}),
    startTunnel: async () => 'https://pocket.example.com', stopTunnel: () => {},
  };
  // apply 内部用 ctx.effect 注册清理，返回值不是契约；这里只验证不抛错
  mod.apply(ctx, {}, {
    service: stubService,
    runUpdate: { currentVersion: () => '1.0.20', loadedVersion: () => '1.0.20', perform: async () => ({ ok: true }) },
    restart: () => ({ helperPid: 1, logOut: '', logErr: '' }),
    restartNotice: async () => null,
  });
  assert.ok(true, 'apply 正常路径不抛错');
}));

test('compareVersions：语义化版本比较', async () => {
  const { compareVersions } = await import('../client/api.js');
  assert.ok(compareVersions('1.0.5', '1.0.4') > 0);
  assert.ok(compareVersions('1.0.4', '1.0.5') < 0);
  assert.equal(compareVersions('1.0.4', '1.0.4'), 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0, '两位数字正确比较');
  assert.ok(compareVersions('1.0.4', '1.0.4-rc.1') > 0, '预发布视为更旧');
  assert.ok(compareVersions('1.0.4-rc.1', '1.0.4') < 0, '反过来更旧');
  assert.ok(compareVersions('1.0.4-alpha', '1.0.4-beta') < 0, '预发布后缀按字典序');
  assert.ok(compareVersions('1.0.4-beta.2', '1.0.4-beta.1') > 0, '预发布后缀比较');
  assert.equal(compareVersions('V1.0.4', '1.0.4'), 0, '大写 V 也剥掉');
  assert.ok(compareVersions('1.0.4-rc.10', '1.0.4-rc.9') > 0, '预发布数字段按数值（rc.10 > rc.9）');
  assert.ok(compareVersions('1.0.4-rc.9', '1.0.4-rc.10') < 0, '反过来');
  assert.ok(compareVersions('1.0.4-alpha.1', '1.0.4-alpha.10') < 0, 'alpha.1 < alpha.10（数值比较）');
});

test('stop 竞态：stop 打断 in-flight 后立即 start，不会并发 spawn cloudflared', async () => {
  let spawnCount = 0;
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const internals = {
    ...stubInternals(),
    startNamedTunnel: async ({ signal }) => {
      spawnCount += 1;
      await gateA; // 挂起直到 releaseA
      if (signal.aborted) throw new Error('cancelled');
      return { url: null, kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  await service.startProxy();

  const pA = service.startTunnel().catch(() => null); // A in-flight
  await new Promise((r) => setTimeout(r, 20));
  service.stopTunnel(); // abort A、清 tunnelPromise
  const pB = service.startTunnel().catch(() => null); // B 新起（gate 尚未释放，B 也挂起）
  await new Promise((r) => setTimeout(r, 20));
  releaseA(); // 释放 A：其 finally 不得清掉 B 的引用
  await pA;
  await new Promise((r) => setTimeout(r, 20));
  await service.startTunnel().catch(() => null); // C：应复用 B 或等 B 完成，不再 spawn

  assert.equal(spawnCount, 2, 'A、B 各 spawn 一次，C 不产生第三个 cloudflared');

  service.stopTunnel();
  await service.dispose();
});

test('killHint：按平台返回停止命令（Windows 无 lsof）', async () => {
  const { killHint } = await import('../lib/web-rpc.js');
  const hint = killHint(3080);
  if (process.platform === 'win32') {
    assert.ok(hint.includes('netstat') && hint.includes('taskkill'), 'Windows 用 netstat/taskkill');
  } else {
    assert.ok(hint.includes('lsof -ti :3080'), 'macOS/Linux 用 lsof');
  }
  assert.ok(!hint.includes('undefined'), '端口正确插入');
});

test('tsinghuaBottleUrl：按平台/架构匹配清华 bottle（Windows 无匹配；mock 目录，不依赖外网）', async () => {
  const { tsinghuaBottleUrl } = await import('../lib/tunnel.mjs');
  const origFetch = globalThis.fetch;
  // mock 清华目录页（CI 在境外，真实访问清华会超时导致测试抖动）
  globalThis.fetch = async (url) => {
    if (String(url).includes('mirrors.tuna.tsinghua.edu.cn')) {
      return {
        ok: true,
        status: 200,
        text: async () => `
          <a href="cloudflared-2026.8.2.arm64_sequoia.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_sonoma.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_tahoe.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.arm64_linux.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.sonoma.bottle.tar.gz">
          <a href="cloudflared-2026.8.2.x86_64_linux.bottle.tar.gz">
        `,
      };
    }
    throw new Error(`Unexpected test fetch: ${url}`);
  };
  try {
    // Windows：无 Homebrew bottle → null
    assert.equal(await tsinghuaBottleUrl({ os: 'windows', a: 'amd64' }), null, 'Windows 不走清华');
    // macOS arm64 → 清华 arm64_ 开头的 bottle URL
    const macUrl = await tsinghuaBottleUrl({ os: 'darwin', a: 'arm64' });
    assert.ok(macUrl && macUrl.includes('mirrors.tuna.tsinghua.edu.cn'), 'macOS 有清华 URL: ' + macUrl);
    assert.ok(/arm64_(sequoia|sonoma|tahoe)\.bottle\.tar\.gz$/.test(macUrl), '匹配 arm64 macOS bottle: ' + macUrl);
    // macOS Intel → 无 arm64 前缀的 bottle
    const intelUrl = await tsinghuaBottleUrl({ os: 'darwin', a: 'amd64' });
    assert.ok(intelUrl && !/arm64_/.test(intelUrl), 'Intel 用无前缀 bottle: ' + intelUrl);
    // Linux：Homebrew bottle 的 ELF 解释器是占位符，不能直接用 → 跳过清华（issue #22）
    assert.equal(await tsinghuaBottleUrl({ os: 'linux', a: 'arm64' }), null, 'Linux 不走清华（Homebrew bottle 不可用）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('桌面端（desktop=true）：update/restart 关闭，status 带标志，正常功能不受影响', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  installPocketRpc({ connection: conn }, {
    service,
    desktop: true,
    runUpdate: { currentVersion: () => '1.4.0', loadedVersion: () => '1.4.0', perform: async () => ({ ok: true }) },
    restart: () => ({ helperPid: 1, logOut: '', logErr: '' }),
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  // status 带 desktop 标志
  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.ok, true);
  assert.equal(s.value.desktop, true, 'status 标记桌面端');

  // 更新被关闭
  const u = await conn.handler(POCKET_ENDPOINTS.update, {});
  assert.equal(u.ok, false, '桌面端更新不可用');
  assert.match(u.error.message, /DSH Desktop/, '提示由桌面版管理');

  // 重启被关闭
  const r = await conn.handler(POCKET_ENDPOINTS.restart, {});
  assert.equal(r.ok, false, '桌面端重启不可用');
  assert.match(r.error.message, /DSH Desktop/, '提示由桌面版管理');

  // 正常功能（隧道）不受影响（同样需要免责声明确认）
  const t = await conn.handler(POCKET_ENDPOINTS.tunnelStart, { disclaimer: true });
  assert.equal(t.ok, true, '隧道功能照常');

  await service.dispose();
});

test('startProxy：端口被占（EADDRINUSE）时自动尝试下一个端口', async () => {
  let attempts = 0;
  const internals = {
    ...stubInternals(),
    createProxy: async ({ port: p }) => {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error('address in use');
        e.code = 'EADDRINUSE';
        throw e;
      }
      return { port: p, close: async () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const proxy = await service.startProxy();
  assert.equal(attempts, 2, '第一个端口失败后重试');
  assert.equal(proxy.port, 3082, '自动换到下一个端口');
  const st = await service.status();
  assert.equal(st.proxyRunning, true);
  assert.ok(st.lanUrl.includes(':3082'), 'URL 使用实际端口');
  await service.dispose();
});

// 融合版恢复规则：marker 模式（无标记/quick 视为 quick）必须与当前模式一致，
// 且 named 还需 Token+域名齐全；quick 只需标记一致（零配置）。
for (const [label, mode, cfg, shouldRestore] of [
  ['旧无 mode 标记 + 无配置（视为 quick）', undefined, undefined, true],
  ['旧无 mode 标记 + 显式 quick 配置', undefined, namedTunnelConfig({ mode: 'quick' }), true],
  ['旧无 mode 标记 + Named 缺 Token（模式不一致）', undefined, namedTunnelConfig({ token: '' }), false],
  ['旧无 mode 标记 + Named 缺域名（模式不一致）', undefined, namedTunnelConfig({ hostname: '' }), false],
  ['旧无 mode 标记 + 完整 Named 配置（模式不一致）', undefined, namedTunnelConfig(), false],
  ['显式 quick 标记 + 完整 Named 配置（模式不一致）', 'quick', namedTunnelConfig(), false],
  ['显式 quick 标记 + 显式 quick 配置', 'quick', namedTunnelConfig({ mode: 'quick' }), true],
  ['显式未知模式标记 + 完整 Named 配置（按 quick 处理）', 'other', namedTunnelConfig(), false],
  ['显式 Named 标记 + 无配置（模式不一致）', 'named', undefined, false],
  ['显式 Named 标记 + 缺 Token', 'named', namedTunnelConfig({ token: '' }), false],
  ['显式 Named 标记 + 缺域名', 'named', namedTunnelConfig({ hostname: '' }), false],
  ['显式 Named 标记 + 完整配置', 'named', namedTunnelConfig(), true],
  ['显式 Named 标记不依赖旧模式恢复资格', 'named', namedTunnelConfig({ autoRestore: false }), true],
]) {
  test(`公网隧道自动恢复：${label}`, () => withHome(async (home) => {
    const statePath = join(home, 'dsh-pocket', 'tunnel-auto.json');
    mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ at: 1, mode }));
    const internals = stubInternals();
    const service = createPocketService({
      dshPort: 3080, port: 3081, home, internals,
      ...(cfg === undefined ? {} : { getTunnelConfig: () => cfg }),
      log: { info() {}, warn() {} },
    });
    try {
      await service.restoreTunnelIfNeeded();
      const status = await service.status();
      // 恢复走哪条通道取决于 cfg.mode（缺省 quick）
      const expectedMode = cfg?.mode === 'named' ? 'named' : 'quick';
      const expectedStarted = expectedMode === 'named' ? [`named:${FAKE_TUNNEL_TOKEN}`] : ['quick:3081'];
      const expectedUrl = expectedMode === 'named' ? 'https://pocket.example.com' : 'https://fake-3081.trycloudflare.com';
      assert.equal(status.tunnelRunning, shouldRestore);
      assert.equal(status.tunnelUrl, shouldRestore ? expectedUrl : null);
      assert.deepEqual(internals.started, shouldRestore ? expectedStarted : [], '仅模式一致且配置合格才允许下载和启动');
      if (shouldRestore) {
        let marker;
        for (let i = 0; i < 50; i++) {
          try { marker = JSON.parse(readFileSync(statePath, 'utf8')); } catch { marker = null; }
          if (marker?.mode === expectedMode && marker.at > 1) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(marker?.mode, expectedMode, '恢复后标记写明当前通道');
        assert.ok(marker.at > 1, '恢复后重新写入当前开始时间');
        assert.equal(marker.token, undefined, '恢复标记不记录 Token');
      } else {
        assert.equal(existsSync(statePath), false, '不合格或 quick 恢复标记必须清除');
        assert.equal(existsSync(join(home, 'dsh-pocket', 'bin')), false, '拒绝恢复不创建下载缓存');
        assert.equal(status.proxyRunning, false, '拒绝恢复不启动代理');
        await service.restoreTunnelIfNeeded();
        assert.deepEqual(internals.started, [], '清除后重复检查不会启动');
      }
    } finally {
      await service.dispose();
    }
  }));
}

test('公网隧道自动恢复：开启时持久化标记，重启后 restoreTunnelIfNeeded 自动拉起（issue #11）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-auto-'));

  let startCount = 0;
  const internals = {
    ...stubInternals(),
    startNamedTunnel: async () => {
      startCount += 1;
      return { url: null, kill: () => {} };
    },
  };
  const service = createPocketService({ dshPort: 3080, port: 3081, home, internals, getTunnelConfig: namedTunnelConfig });
  await service.startProxy();

  // 开启隧道 → 持久化标记（persistAutoTunnel 是异步 fire-and-forget，等它落盘）
  await service.startTunnel();
  await new Promise((r) => setTimeout(r, 60));
  const statePath = path.join(home, 'dsh-pocket', 'tunnel-auto.json');
  const marker = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  assert.ok(marker.at > 0, '开启后写入时间');
  assert.equal(marker.mode, 'named', '开启后写入 Named 恢复标记');
  assert.equal(marker.token, undefined, '恢复标记不含 Token');

  // 模拟重启：新 service 实例（相同 home）→ 自动恢复
  const service2 = createPocketService({ dshPort: 3080, port: 3081, home, internals, getTunnelConfig: namedTunnelConfig });
  await service2.startProxy();
  await service2.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, '重启后自动拉起隧道');

  // 手动关闭 → 标记清除 → 下次不自动恢复
  service2.stopTunnel();
  // Windows 上 rm 可能与实时扫描竞态偶发失败（clearAutoTunnel 内部吞错），轮询等待落盘
  let afterClose = null;
  for (let i = 0; i < 50; i++) {
    afterClose = await fsp.readFile(statePath, 'utf8').catch(() => null);
    if (afterClose === null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(afterClose, null, '关闭后删除标记');
  const service3 = createPocketService({ dshPort: 3080, port: 3081, home, internals, getTunnelConfig: namedTunnelConfig });
  await service3.startProxy();
  await service3.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, '无标记不自动恢复');

  await fsp.rm(home, { recursive: true, force: true });
});

test('公网隧道自动恢复：dispose（进程退出/重启）保留标记，下次启动仍自动拉起；手动 stopTunnel 仍删标记（issue #11 语义澄清）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-dispose-'));

  let startCount = 0;
  const internals = {
    ...stubInternals(),
    startNamedTunnel: async () => {
      startCount += 1;
      return { url: null, kill: () => {} };
    },
  };
  const statePath = path.join(home, 'dsh-pocket', 'tunnel-auto.json');

  const service1 = createPocketService({ dshPort: 3080, port: 3081, home, internals, getTunnelConfig: namedTunnelConfig });
  await service1.startProxy();
  await service1.startTunnel();
  await new Promise((r) => setTimeout(r, 60));
  const marker = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  assert.ok(marker.at > 0, '开启后写入时间');
  assert.equal(marker.mode, 'named', '开启后写入 Named 恢复标记');
  assert.equal(marker.token, undefined, '恢复标记不含 Token');

  // 模拟 DSH 正常重启：dispose（插件卸载）→ 隧道随进程被动消失，不是用户主动关闭 → 标记必须保留。
  // 回归背景：dispose 曾无条件 clearAutoTunnel，导致每次正常重启后隧道永远不会自动恢复
  // （只有进程被强杀、dispose 未跑完时才侥幸可用）。
  await service1.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok((await fsp.readFile(statePath, 'utf8')).includes('"at"'), 'dispose 保留自动恢复标记');

  const service2 = createPocketService({ dshPort: 3080, port: 3081, home, internals, getTunnelConfig: namedTunnelConfig });
  await service2.startProxy();
  await service2.restoreTunnelIfNeeded();
  assert.equal(startCount, 2, 'dispose 后重启仍自动恢复');

  // 对照：手动 stopTunnel()（设置页关闭）仍然删除标记
  service2.stopTunnel();
  let afterClose = null;
  for (let i = 0; i < 50; i++) {
    afterClose = await fsp.readFile(statePath, 'utf8').catch(() => null);
    if (afterClose === null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(afterClose, null, '手动关闭仍删除标记');

  await fsp.rm(home, { recursive: true, force: true });
});

test('RPC：局域网密码独立于公网；lanTokenRefresh 刷新并返回新密码（issue #18）', async () => {
  const internals = stubInternals();
  const service = createPocketService({ dshPort: 3080, port: 3081, internals, getTunnelConfig: namedTunnelConfig });
  const conn = fakeCtxConnection();
  let lan = '11111111';
  installPocketRpc({ connection: conn }, {
    service,
    getToken: () => '99999999',
    getLanToken: () => lan,
    refreshLanToken: () => { lan = '22222222'; return lan; },
    log: { error() {}, warn() {} },
  });
  await service.startProxy();

  const s = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s.value.accessToken, '99999999', '公网密码');
  assert.equal(s.value.lanToken, '11111111', '局域网密码独立');

  const r = await conn.handler(POCKET_ENDPOINTS.lanTokenRefresh, {});
  assert.equal(r.ok, true);
  assert.equal(r.value.lanToken, '22222222', '刷新返回新密码');
  const s2 = await conn.handler(POCKET_ENDPOINTS.status, {});
  assert.equal(s2.value.lanToken, '22222222', 'status 反映新密码');

  await service.dispose();
});

test('WSL 局域网 IP（issue #39）：parseIpconfig 取物理网卡 IP、排除虚拟网卡；detectWsl 识别环境', async () => {
  const { parseIpconfig, detectWsl } = await import('../lib/service.mjs');

  // 中文 ipconfig 输出：物理网卡在前、虚拟网卡（vEthernet (WSL)）在后
  const zhSample = `\u4ee5\u592a\u7f51\u9002\u914d\u5668 WLAN:
\n\n   连接特定的 DNS 后缀 . . . . . . . :
   本地链接 IPv6 地址. . . . . . . . : fe80::1%12
   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.1.1

\u4ee5\u592a\u7f51\u9002\u914d\u5668 vEthernet (WSL (Hyper-V firewall)):
\n\n   连接特定的 DNS 后缀 . . . . . . . :
   IPv4 地址 . . . . . . . . . . . . : 172.26.96.1
   子网掩码  . . . . . . . . . . . . : 255.255.255.240

\u4ee5\u592a\u7f51\u9002\u914d\u5668 vEthernet (Docker NAT):
\n\n   IPv4 地址 . . . . . . . . . . . . : 10.0.75.1
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
`;
  const zh = parseIpconfig(zhSample);
  assert.deepEqual(zh, ['192.168.1.100'], '中文输出：只取物理网卡 WLAN 的 IP，排除 vEthernet(WSL/Docker)');

  // 英文 ipconfig 输出
  const enSample = `Ethernet adapter Ethernet:
\n\n   Connection-specific DNS Suffix  . :
   Link-local IPv6 Address . . . . . : fe80::2%4
   IPv4 Address. . . . . . . . . . . : 192.168.50.10
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.50.1

Ethernet adapter vEthernet (WSL):
\n\n   IPv4 Address. . . . . . . . . . . : 172.20.0.1
   Subnet Mask . . . . . . . . . . . : 255.255.255.240
`;
  const en = parseIpconfig(enSample);
  assert.deepEqual(en, ['192.168.50.10'], '英文输出：只取物理网卡 IP');

  // 虚拟网卡在前也跳过（vEthernet 块被排除）
  const vpnFirst = `Ethernet adapter vEthernet (WSL):
\n\n   IPv4 Address. . . . . . . . . . . : 172.20.0.1

Ethernet adapter Wi-Fi:
\n\n   IPv4 Address. . . . . . . . . . . : 192.168.31.8
`;
  assert.deepEqual(parseIpconfig(vpnFirst), ['192.168.31.8'], '虚拟网卡在前也正确跳过');

  // 手动覆盖候选：保留 Tailscale/VPN 地址供设置页选择
  const tailscaleFirst = `Unknown adapter Tailscale:

   IPv4 Address. . . . . . . . . . . : 100.119.24.44

Ethernet adapter WLAN:

   IPv4 Address. . . . . . . . . . . : 10.179.45.172
`;
  assert.deepEqual(parseIpconfig(tailscaleFirst), ['10.179.45.172'], '自动模式仍排除 Tailscale');
  assert.deepEqual(
    parseIpconfig(tailscaleFirst, { includeVpn: true }),
    ['100.119.24.44', '10.179.45.172'],
    '候选模式保留 Tailscale/VPN 地址',
  );

  // detectWsl：环境变量触发（本机 macOS 无 /proc/version，走 env 分支）
  const prev = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = 'Ubuntu';
  try {
    assert.equal(detectWsl(), true, 'WSL_DISTRO_NAME 存在 → 判定 WSL');
  } finally {
    if (prev === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = prev;
  }
  assert.equal(detectWsl(), false, '非 WSL 环境返回 false（macOS 无 /proc/version microsoft 标记）');

  // WSLENV 由 Windows Terminal 在**原生 Windows** 上也会设置（WT_SESSION 等），
  // 不能作为 WSL 判据——回归：仅设 WSLENV 不得误判为 WSL（issue #39 误报）。
  const prevWslEnv = process.env.WSLENV;
  process.env.WSLENV = 'WT_SESSION:WT_PROFILE_ID:';
  try {
    assert.equal(detectWsl(), false, '仅 WSLENV 不判定为 WSL（Windows Terminal 误报）');
  } finally {
    if (prevWslEnv === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = prevWslEnv;
  }
});

test('startTunnel 同步抛错后不残留 rejected 的 in-flight（TDZ 回归）：修好配置后可再次启动', async () => {
  // 回归背景：启动流程里 `const p = tunnelPromise` 声明在 async IIFE 之后，
  // 而 IIFE 体内没有 await 之前的挂起点——getTunnelConfig 之类同步抛错时，
  // finally 会引用尚未初始化的 `p` 触发 TDZ 报错，tunnelPromise 永远停在
  // rejected，后续 startTunnel 一直复用这个失败态，隧道再也起不来。
  const internals = stubInternals();
  let broken = true;
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    internals,
    getTunnelConfig: () => {
      if (broken) throw new Error('config boom');
      return namedTunnelConfig();
    },
  });
  await service.startProxy();
  await assert.rejects(() => service.startTunnel(), /config boom/, '第一次因配置读取失败而拒绝');

  broken = false;
  const url = await service.startTunnel();
  assert.equal(url, 'https://pocket.example.com', '修好后能正常启动，没有残留失败态');
  assert.equal((await service.status()).tunnelRunning, true, '隧道确实起来了');
  await service.dispose();
});

test('生命周期：startProxy 在途时 dispose → 建好的代理立即关闭，端口不留孤儿', async () => {
  // 回归背景：createProxy 是 await 的，dispose() 只看得到当时的 `proxy === null`，
  // 于是那次在途启动落地后仍会被赋给 proxy，闭包里的 server 已随插件卸载无人关闭
  // → 端口一直被占，直到进程退出。修法是卸载世代号 + 落地后二次校验。
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  const created = [];
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    internals: {
      ...stubInternals(),
      createProxy: async ({ port }) => {
        await gate;
        const server = { port, closed: 0, close: async () => { server.closed += 1; } };
        created.push(server);
        return server;
      },
    },
  });

  const pending = service.startProxy();
  const disposing = service.dispose();
  releaseCreate();

  await assert.rejects(() => pending, /disposed/, '在途启动应拒绝，不返回过期代理');
  await disposing;
  assert.equal(created.length, 1, '代理确实被创建过（证明走了 await 之后的落地路径）');
  assert.equal(created[0].closed, 1, '过期落地必须自行关闭 server');
  assert.equal((await service.status()).proxyRunning, false, '状态不应把过期代理念成运行中');
});

test('生命周期：dispose 之后再 startProxy / startTunnel 都拒绝', async () => {
  const service = createPocketService({ dshPort: 3080, port: 3081, internals: stubInternals() });
  await service.dispose();
  await assert.rejects(() => service.startProxy(), /disposed/);
  await assert.rejects(() => service.startTunnel(), /disposed/);
  assert.equal((await service.status()).proxyRunning, false);
  assert.equal((await service.status()).tunnelRunning, false);
});

test('生命周期：startProxy 在途时 stopTunnel → 隧道不再 spawn cloudflared', async () => {
  // 回归背景：startTunnel 原来是 `await this.startProxy()` 之后才建 AbortController，
  // 所以代理启动窗口内调用 stopTunnel 看不到这次在途启动，等它拿到代理后照样
  // spawn 出 cloudflared，用户以为已关闭的公网仍在运行。
  let releaseCreate;
  const gate = new Promise((resolve) => { releaseCreate = resolve; });
  let startNamedCount = 0;
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    getTunnelConfig: namedTunnelConfig,
    internals: {
      ...stubInternals(),
      createProxy: async ({ port }) => {
        await gate;
        return { port, close: async () => {} };
      },
      startNamedTunnel: async () => {
        startNamedCount += 1;
        return { url: null, kill: () => {} };
      },
    },
  });

  const pending = service.startTunnel();
  service.stopTunnel();
  releaseCreate();

  await assert.rejects(() => pending, /aborted/);
  assert.equal(startNamedCount, 0, '已取消的启动不得 spawn cloudflared');
  assert.equal((await service.status()).tunnelRunning, false);
  await service.dispose();
});

test('生命周期：旧隧道 onExit 迟到触发不抹掉新隧道状态', async () => {
  let exitA;
  let startNamedCount = 0;
  const service = createPocketService({
    dshPort: 3080,
    port: 3081,
    getTunnelConfig: namedTunnelConfig,
    internals: {
      ...stubInternals(),
      startNamedTunnel: async () => {
        startNamedCount += 1;
        const mine = startNamedCount;
        return {
          url: null,
          kill: () => {},
          onExit: mine === 1 ? (cb) => { exitA = cb; } : () => {},
        };
      },
    },
  });
  await service.startTunnel();
  service.stopTunnel();
  await service.startTunnel();
  assert.equal((await service.status()).tunnelRunning, true, '新隧道已就绪');

  exitA?.(1); // 上一代进程的退出通知迟到
  const after = await service.status();
  assert.equal(after.tunnelRunning, true, '迟到回调不得清掉当前隧道引用');
  assert.equal(after.tunnelState.phase, 'ready', '状态也不该被打成 error');
  await service.dispose();
});
