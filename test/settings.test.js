// 局域网访问密码开关（issue #24）：默认开启、持久化、可关可开
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个测试用独立 DSH_HOME，互不干扰（settings.mjs 每次调用都读磁盘/环境变量）
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'dshp-settings-'));
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

test('局域网访问总开关默认开启（无配置文件）', () => withHome(async () => {
  const { lanEnabled } = await import('../lib/settings.mjs');
  assert.equal(lanEnabled(), true, '默认开启');
}));

test('局域网访问总开关：关闭 → 持久化到 settings.json，重新读取仍为关闭；可再开', () => withHome(async () => {
  const { lanEnabled, setLanEnabled, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(setLanEnabled(false), false, '返回关闭状态');
  assert.equal(lanEnabled(), false, '立即生效（每次读磁盘）');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.lanEnabled, false, 'settings.json 内容正确');
  assert.equal(setLanEnabled(true), true, '重新开启');
  assert.equal(lanEnabled(), true, '开启生效');
}));

test('局域网密码开关默认开启（无配置文件）', () => withHome(async () => {
  const { lanAuthEnabled } = await import('../lib/settings.mjs');
  assert.equal(lanAuthEnabled(), true, '默认开启');
}));

test('关闭 → 持久化到 settings.json，重新读取仍为关闭', () => withHome(async () => {
  const { lanAuthEnabled, setLanAuthEnabled, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(setLanAuthEnabled(false), false, '返回关闭状态');
  assert.equal(lanAuthEnabled(), false, '立即生效（每次读磁盘）');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.lanAuthEnabled, false, 'settings.json 内容正确');
}));

test('再开 → true；settings.json 权限 0600', () => withHome(async () => {
  const { lanAuthEnabled, setLanAuthEnabled, settingsPath } = await import('../lib/settings.mjs');
  setLanAuthEnabled(false);
  assert.equal(setLanAuthEnabled(true), true, '重新开启');
  assert.equal(lanAuthEnabled(), true, '开启生效');
  assert.ok(existsSync(settingsPath()), '配置文件已创建');
  if (process.platform !== 'win32') {
    assert.equal(statSync(settingsPath()).mode & 0o777, 0o600, '权限 0600');
  }
}));

test('手机端右边栏默认开启，可关闭并持久化', () => withHome(async () => {
  const { mobileRightbarEnabled, setMobileRightbarEnabled, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(mobileRightbarEnabled(), true, '默认开启');
  assert.equal(setMobileRightbarEnabled(false), false, '返回关闭状态');
  assert.equal(mobileRightbarEnabled(), false, '关闭后立即生效');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.mobileRightbarEnabled, false, 'settings.json 内容正确');
  assert.equal(setMobileRightbarEnabled(true), true, '可再次开启');
}));

test('局域网地址覆盖：默认自动，设置/清除持久化，非法 IPv4 拒绝', () => withHome(async () => {
  const { lanIpOverride, setLanIpOverride, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(lanIpOverride(), '', '默认自动');
  assert.equal(setLanIpOverride('100.119.24.44'), '100.119.24.44', '设置成功');
  assert.equal(lanIpOverride(), '100.119.24.44', '立即生效');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.lanIpOverride, '100.119.24.44', 'settings.json 内容正确');
  assert.throws(() => setLanIpOverride('999.1.1.1'), /IPv4/, '非法地址拒绝');
  assert.equal(setLanIpOverride(''), '', '清除覆盖');
  assert.equal(lanIpOverride(), '', '恢复自动');
}));

test('PIN 自定义标记（issue #33）：默认 false，设置/清除持久化，未知类型 false', () => withHome(async () => {
  const { pinCustom, setPinCustom } = await import('../lib/settings.mjs');
  assert.equal(pinCustom('public'), false, '默认未自定义');
  assert.equal(pinCustom('lan'), false, '默认未自定义');
  assert.equal(pinCustom('other'), false, '未知类型 false');
  setPinCustom('public', true);
  assert.equal(pinCustom('public'), true, '持久化生效');
  setPinCustom('public', false);
  assert.equal(pinCustom('public'), false, '可清除');
  assert.equal(pinCustom('lan'), false, '互不影响');
}));

test('setCustomPin / rotateAccessToken（issue #33）：8–64 位字母数字自定义 + 自定义后公网不轮换；非法输入抛错', () => withHome(async () => {
  const { setCustomPin, rotateAccessToken, getAccessToken } = await import('../lib/index.js');
  const { pinCustom } = await import('../lib/settings.mjs');
  // 非法输入
  assert.throws(() => setCustomPin('public', '1234567'), /8–64 位英文字母或数字/, '少于 8 位拒绝');
  assert.throws(() => setCustomPin('public', 'abc$ef12'), /8–64 位英文字母或数字/, '特殊符号拒绝');
  assert.throws(() => setCustomPin('public', 'a'.repeat(65)), /8–64 位英文字母或数字/, '超过 64 位拒绝');
  assert.throws(() => setCustomPin('other', '12345678'), /未知/, '未知类型拒绝');
  // 合法自定义：公网（纯数字）
  assert.equal(setCustomPin('public', '88886666'), '88886666', '公网自定义成功（纯数字）');
  assert.equal(pinCustom('public'), true, '公网标记自定义');
  assert.equal(getAccessToken(), '88886666', '值已写入');
  // 自定义后 rotateAccessToken 不轮换（值保持）
  assert.equal(rotateAccessToken(), '88886666', '自定义后开启公网不换新');
  assert.equal(getAccessToken(), '88886666', '值未被覆盖');
  // 合法自定义：公网（字母 + 数字混合，大小写均可）
  assert.equal(setCustomPin('public', 'aB3xY9k2'), 'aB3xY9k2', '公网自定义成功（字母数字混合）');
  assert.equal(getAccessToken(), 'aB3xY9k2', '混合密码已写入');
  const longPin = 'Ab3'.repeat(21) + 'Z';
  assert.equal(longPin.length, 64, '测试密码为 64 位');
  assert.equal(setCustomPin('public', longPin), longPin, '64 位自定义密码成功');
  assert.equal(getAccessToken(), longPin, '64 位密码已写入');
  // 合法自定义：局域网
  assert.equal(setCustomPin('lan', '77775555'), '77775555', '局域网自定义成功');
  assert.equal(pinCustom('lan'), true, '局域网标记自定义');
  // 清除自定义 PIN → 回退随机轮换（issue #166）
  const cleared = setCustomPin('public', '');
  assert.equal(pinCustom('public'), false, '清除公网自定义标记');
  assert.ok(cleared.length === 8 && /^\d+$/.test(cleared), '重置为随机 8 位 PIN');
  assert.equal(getAccessToken(), cleared, '新随机 PIN 已落盘');
  const clearedLan = setCustomPin('lan', '   ');
  assert.equal(pinCustom('lan'), false, '清除局域网自定义标记');
  assert.ok(clearedLan.length === 8 && /^\d+$/.test(clearedLan), '局域网也重置为随机 8 位 PIN');
}));

// ---------- 命名隧道配置（issue #66：固定公网域名） ----------

test('隧道模式（融合版）：默认 quick，quick/named 双向可切，非法模式拒绝', () => withHome(async () => {
  const { tunnelMode, tunnelAutoRestoreEnabled, setTunnelMode, tunnelToken, tunnelHostname, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(tunnelMode(), 'quick', '默认走零配置的快速隧道');
  assert.equal(tunnelToken(), '', '默认未配置 Token');
  assert.equal(tunnelHostname(), '', '默认未配置域名');
  assert.equal(tunnelAutoRestoreEnabled(), false, '无存盘模式不能恢复旧标记');
  assert.equal(existsSync(settingsPath()), false, '读取默认值不创建配置');
  assert.equal(setTunnelMode('quick'), 'quick', '可显式保存快速隧道模式');
  assert.equal(tunnelMode(), 'quick', '快速模式持久化');
  assert.equal(tunnelAutoRestoreEnabled(), true, '显式保存 quick 也允许恢复（issue #11）');
  assert.equal(setTunnelMode('named'), 'named', '可显式保存命名模式');
  assert.equal(tunnelMode(), 'named', '命名模式持久化');
  assert.equal(tunnelAutoRestoreEnabled(), true, '显式保存 named 才能沿用旧恢复意图');
  const before = readFileSync(settingsPath(), 'utf8');
  for (const mode of ['other', 'QUICK', undefined, null, '']) {
    assert.throws(() => setTunnelMode(mode), /未知的隧道模式/, '非法模式拒绝');
    assert.equal(readFileSync(settingsPath(), 'utf8'), before, '拒绝模式时配置不变');
  }
}));

test('隧道模式：无存盘模式但有完整命名配置时推断为 named（不把老 setup 切成随机域名）', () => withHome(async (home) => {
  const { tunnelMode, settingsPath } = await import('../lib/settings.mjs');
  mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ tunnelToken: 'fake-cloudflared-token-for-tests', tunnelHostname: 'pocket.example.com' }));
  assert.equal(tunnelMode(), 'named', '完整命名配置 → named');
}));

test('隧道模式：无存盘模式且命名配置不完整时退回 quick', () => withHome(async (home) => {
  // settings 有进程内缓存，同一 HOME 内连写会读到旧值，所以这条用独立 HOME。
  const { tunnelMode, settingsPath } = await import('../lib/settings.mjs');
  mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ tunnelToken: 'fake-cloudflared-token-for-tests' }));
  assert.equal(tunnelMode(), 'quick', '只有 Token 没域名 → quick（配置不完整）');
}));

for (const [mode, expectMode, expectRestore, note] of [
  [undefined, 'named', false, '无存盘模式但有完整命名配置 → 推断 named，恢复资格仍需显式保存'],
  ['quick', 'quick', true, '显式 quick → 快速隧道，允许恢复'],
  ['other', 'named', false, '未知模式 → 按完整命名配置推断 named，不授予恢复资格'],
  ['named', 'named', true, '显式 named → 命名隧道，允许恢复'],
]) {
  test(`隧道模式：旧存盘模式 ${String(mode)} → ${expectMode}（${note}）`, () => withHome(async (home) => {
    const { tunnelMode, tunnelAutoRestoreEnabled, tunnelToken, tunnelHostname, settingsPath } = await import('../lib/settings.mjs');
    mkdirSync(join(home, 'dsh-pocket'), { recursive: true });
    const legacy = { tunnelMode: mode, tunnelToken: 'fake-cloudflared-token-for-tests', tunnelHostname: 'pocket.example.com' };
    writeFileSync(settingsPath(), JSON.stringify(legacy));
    const before = readFileSync(settingsPath(), 'utf8');
    assert.equal(tunnelMode(), expectMode, note);
    assert.equal(tunnelAutoRestoreEnabled(), expectRestore, '恢复资格取决于原存盘模式');
    assert.equal(tunnelToken(), legacy.tunnelToken, '读取保留旧 Token');
    assert.equal(tunnelHostname(), legacy.tunnelHostname, '读取保留旧域名');
    assert.equal(readFileSync(settingsPath(), 'utf8'), before, '读取不会悄悄改写旧配置');
  }));
}

test('Tunnel Token（issue #66）：设置/清除持久化；过短/非法字符拒绝', () => withHome(async () => {
  const { tunnelToken, setTunnelToken, settingsPath } = await import('../lib/settings.mjs');
  const tok = 'fake-cloudflared-token-for-tests';
  assert.equal(tunnelToken(), '', '默认未配置');
  assert.equal(setTunnelToken(tok), tok, '设置成功');
  assert.equal(tunnelToken(), tok, '持久化生效');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.tunnelToken, tok, 'settings.json 内容正确');
  assert.throws(() => setTunnelToken('short'), /Token/, '过短拒绝');
  assert.throws(() => setTunnelToken('has space in it and that is bad!!'), /Token/, '非法字符拒绝');
  assert.equal(setTunnelToken(''), '', '空字符串清除');
  assert.equal(tunnelToken(), '', '清除生效');
}));

test('固定域名（issue #66）：URL 粘贴归一化、设置/清除持久化、非法域名拒绝', () => withHome(async () => {
  const { tunnelHostname, setTunnelHostname } = await import('../lib/settings.mjs');
  assert.equal(tunnelHostname(), '', '默认未配置');
  // 粘贴完整 URL → 归一化为裸域名
  assert.equal(setTunnelHostname('https://Pocket.Example.com/'), 'pocket.example.com', 'URL 归一化（含大小写）');
  assert.equal(tunnelHostname(), 'pocket.example.com', '持久化生效');
  assert.equal(setTunnelHostname(' sub.example.com:443 '), 'sub.example.com', '带端口/空白归一化');
  assert.throws(() => setTunnelHostname('localhost'), /域名/, '无点主机名拒绝（那是局域网域）');
  assert.throws(() => setTunnelHostname('192.168.1.5'), /域名/, '裸 IP 拒绝');
  assert.throws(() => setTunnelHostname('bad host name'), /域名/, '含空格拒绝');
  assert.equal(setTunnelHostname(''), '', '空字符串清除');
  assert.equal(tunnelHostname(), '', '清除生效');
}));

test('Named 配置：一次保存完整配置，归一化域名，未传 Token 保留已有值', () => withHome(async () => {
  const { setNamedTunnelConfig, tunnelMode, tunnelAutoRestoreEnabled, tunnelToken, tunnelHostname, setLanEnabled, lanEnabled, settingsPath } = await import('../lib/settings.mjs');
  const token = 'fake-cloudflared-token-for-tests';
  setLanEnabled(false);
  assert.deepEqual(setNamedTunnelConfig({ token: ` ${token} `, hostname: 'https://Pocket.Example.com/' }), {
    mode: 'named', hostname: 'pocket.example.com', tokenSet: true,
  }, '保存结果不回显 Token');
  assert.equal(tunnelMode(), 'named');
  assert.equal(tunnelAutoRestoreEnabled(), true, '完整配置允许自动恢复');
  assert.equal(tunnelToken(), token);
  assert.equal(tunnelHostname(), 'pocket.example.com');
  assert.equal(lanEnabled(), false, '保留其他设置');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf8')), {
    lanEnabled: false, tunnelMode: 'named', tunnelHostname: 'pocket.example.com', tunnelToken: token,
  }, '完整配置一起落盘');
  if (process.platform !== 'win32') assert.equal(statSync(settingsPath()).mode & 0o777, 0o600, 'Token 文件权限 0600');

  assert.deepEqual(setNamedTunnelConfig({ mode: 'named', hostname: 'other.example.com' }), {
    mode: 'named', hostname: 'other.example.com', tokenSet: true,
  });
  assert.equal(tunnelToken(), token, '未传 Token 时保留现有值');
  assert.equal(tunnelHostname(), 'other.example.com', '域名更新生效');
  assert.equal(JSON.parse(readFileSync(settingsPath(), 'utf8')).tunnelToken, token, '保留的 Token 同步落盘');
}));

test('Named 配置：首次保存缺 Token 或域名时拒绝，且不创建半份配置', () => withHome(async () => {
  const { setNamedTunnelConfig, tunnelToken, tunnelHostname, tunnelAutoRestoreEnabled, settingsPath } = await import('../lib/settings.mjs');
  for (const cfg of [{}, { hostname: 'pocket.example.com' }, { token: 'fake-cloudflared-token-for-tests' }, { token: '', hostname: 'pocket.example.com' }, { token: 'fake-cloudflared-token-for-tests', hostname: '' }]) {
    assert.throws(() => setNamedTunnelConfig(cfg), /固定域名.*Tunnel Token/, '缺任一必填项均拒绝');
    assert.equal(existsSync(settingsPath()), false, '失败时不创建配置文件');
    assert.equal(tunnelToken(), '', '不保留半份 Token');
    assert.equal(tunnelHostname(), '', '不保留半份域名');
    assert.equal(tunnelAutoRestoreEnabled(), false, '失败时不会开启旧标记恢复');
  }
}));

test('Named 配置：校验失败原子保留现有模式、Token、域名及其他设置', () => withHome(async () => {
  const { setNamedTunnelConfig, tunnelMode, tunnelToken, tunnelHostname, setLanEnabled, settingsPath } = await import('../lib/settings.mjs');
  const token = 'fake-cloudflared-token-for-tests';
  const replacement = 'fake-replacement-token-for-tests';
  setNamedTunnelConfig({ token, hostname: 'pocket.example.com' });
  setLanEnabled(false);
  const before = readFileSync(settingsPath(), 'utf8');
  const invalid = [
    { mode: 'quick', token: replacement, hostname: 'other.example.com' },
    { mode: 'other', token: replacement, hostname: 'other.example.com' },
    { token: replacement, hostname: 'localhost' },
    { token: replacement, hostname: '192.168.1.5' },
    { token: replacement, hostname: 'bad host name' },
    { token: 'short', hostname: 'other.example.com' },
    { token: 'invalid token with whitespace', hostname: 'other.example.com' },
    { token: '', hostname: 'other.example.com' },
    { token: replacement, hostname: '' },
  ];
  for (const cfg of invalid) {
    assert.throws(() => setNamedTunnelConfig(cfg), (err) => err instanceof Error);
    assert.equal(readFileSync(settingsPath(), 'utf8'), before, '失败时存盘内容逐字节不变');
    assert.equal(tunnelMode(), 'named', '模式不变');
    assert.equal(tunnelToken(), token, '内存缓存与存盘 Token 均不变');
    assert.equal(tunnelHostname(), 'pocket.example.com', '内存缓存与存盘域名均不变');
  }
}));

// ---------- 恢复出厂设置 ----------

test('恢复出厂设置：清空全部设置 + 重设随机密码（开关回到默认）', () => withHome(async () => {
  const settings = await import('../lib/settings.mjs');
  const { setCustomPin, getAccessToken, resetPocketState } = await import('../lib/index.js');
  // 先把设置搞成非默认：关掉开关、配置命名隧道、自定义密码
  settings.setLanEnabled(false);
  settings.setLanAuthEnabled(false);
  settings.setMobileRightbarEnabled(true);
  settings.setLanIpOverride('10.0.0.7');
  settings.setNamedTunnelConfig({ token: 'fake-cloudflared-token-for-tests', hostname: 'pocket.example.com' });
  const customPublic = setCustomPin('public', 'aB3xY9k2');
  const customLan = setCustomPin('lan', '77775555');
  assert.equal(existsSync(settings.settingsPath()), true, '设置文件已写入');

  const after = resetPocketState();
  assert.notEqual(after.accessToken, customPublic, '公网密码已换新（旧密码作废）');
  assert.notEqual(after.lanToken, customLan, '局域网密码已换新');
  assert.match(after.accessToken, /^\d{8}$/, '新公网密码是 8 位随机');
  assert.match(after.lanToken, /^\d{8}$/, '新局域网密码是 8 位随机');

  // 全部开关回到出厂默认
  assert.equal(settings.lanEnabled(), true, '局域网访问恢复默认开');
  assert.equal(settings.lanAuthEnabled(), true, '访问密码恢复默认开');
  assert.equal(settings.mobileRightbarEnabled(), true, '手机端右边栏恢复默认开');
  assert.equal(settings.lanIpOverride(), '', '局域网地址恢复自动');
  assert.equal(settings.tunnelMode(), 'quick', '重置后回到默认的快速隧道通道');
  assert.equal(settings.tunnelAutoRestoreEnabled(), false, '重置后不能沿用旧自动恢复标记');
  assert.equal(settings.tunnelToken(), '', 'Tunnel Token 已清空');
  assert.equal(settings.tunnelHostname(), '', '固定域名已清空');
  assert.equal(settings.pinCustom('public'), false, '公网自定义标记已清除');
  assert.equal(settings.pinCustom('lan'), false, '局域网自定义标记已清除');
  assert.equal(getAccessToken(), after.accessToken, '读到的公网密码与返回一致');
}));

test('代理端口（issue #70）：默认 0（用 3081）；持久化、清除', async () => withHome(async () => {
  const { proxyPort, setProxyPort, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(proxyPort(), 0, '无配置 = 0（让 lib/index.js 用 3081）');
  assert.equal(setProxyPort(3082), 3082, '设置后立即返回新值');
  assert.equal(proxyPort(), 3082, '重新读取仍生效');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.proxyPort, 3082, 'settings.json 字段正确');
  // 清除
  assert.equal(setProxyPort(0), 0, '传 0 清除');
  assert.equal(proxyPort(), 0, '清除后回到默认');
  // 非法值容忍
  assert.equal(setProxyPort('garbage'), 0, '字符串非法值清除');
  assert.equal(setProxyPort(70000), 0, '超出 65535 清除');
  assert.equal(setProxyPort(-1), 0, '负数清除');
  assert.equal(setProxyPort(1.5), 0, '小数清除');
  assert.equal(setProxyPort(80), 80, '合法端口生效');
}));

test('cloudflared 路径（issue #45）：默认空、可设可清', async () => withHome(async () => {
  const { cloudflaredPath, setCloudflaredPath, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(cloudflaredPath(), '', '默认空');
  assert.equal(setCloudflaredPath('/usr/local/bin/cloudflared'), '/usr/local/bin/cloudflared', '设置后立即返回');
  assert.equal(cloudflaredPath(), '/usr/local/bin/cloudflared', '重新读取生效');
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  assert.equal(raw.cloudflaredPath, '/usr/local/bin/cloudflared', 'settings.json 字段正确');
  // 清除
  assert.equal(setCloudflaredPath(''), '', '空字符串清除');
  assert.equal(cloudflaredPath(), '', '清除后回到默认');
  // 空格 trim
  assert.equal(setCloudflaredPath('  /opt/cf/cloudflared  '), '/opt/cf/cloudflared', '自动 trim');
}));

test('写失败不再被吞：settings 目录建不起来时 setter 抛错（P1-1）', async () => withHome(async (home) => {
  // 用同名普通文件占住 <home>/dsh-pocket 的目录位置，mkdir 必失败
  // （Windows ENOTDIR/EEXIST、POSIX EEXIST）——只读目录在不同平台/权限下不可靠。
  writeFileSync(join(home, 'dsh-pocket'), 'not a dir');
  const { setLanEnabled } = await import('../lib/settings.mjs');
  // 旧实现 catch 吞错返回原值，调用方以为已保存；现在必须抛错让 RPC 回 ok:false
  assert.throws(() => setLanEnabled(false), (err) => err instanceof Error);
}));

test('手机端独立字号：默认跟随桌面（0）、可设可清、非法值抛错', async () => withHome(async () => {
  const { mobileFontSize, setMobileFontSize, settingsPath } = await import('../lib/settings.mjs');
  assert.equal(mobileFontSize(), 0, '默认 0 = 跟随桌面');
  assert.equal(setMobileFontSize(16), 16, '设置后立即返回');
  assert.equal(mobileFontSize(), 16, '重新读取生效');
  assert.equal(JSON.parse(readFileSync(settingsPath(), 'utf8')).mobileFontSize, 16, 'settings.json 字段正确');
  assert.equal(setMobileFontSize(0), 0, '传 0 恢复跟随桌面');
  assert.equal(mobileFontSize(), 0, '清除后回到默认');
  assert.equal(JSON.parse(readFileSync(settingsPath(), 'utf8')).mobileFontSize, undefined, '清除后字段被删除');
  // 非法值（越界/小数/非数字）一律拒绝，不静默落盘
  assert.throws(() => setMobileFontSize(11), (err) => err instanceof Error, '小于下限抛错');
  assert.throws(() => setMobileFontSize(23), (err) => err instanceof Error, '大于上限抛错');
  assert.throws(() => setMobileFontSize(15.5), (err) => err instanceof Error, '小数抛错');
  assert.throws(() => setMobileFontSize('garbage'), (err) => err instanceof Error, '非数字抛错');
}));

test('PIN 落盘失败：内存值仍可用，但 pinWriteWarning 必须暴露「重启会变」', () => withHome(async (home) => {
  // 回归背景：writePinToFile 的写盘异常只打 warn，setCustomPin 照旧返回成功，
  // 设置页据此显示「已保存」。用户重启后 PIN 变回旧值（甚至随机新值）→ 登不上。
  const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const { pinWriteWarning, setCustomPin, getAccessToken } = await import('../lib/index.js');
  // 让 PIN 文件路径变成目录：writeFileSync 必失败（EISDIR/EPERM）
  const pinDir = join(home, 'dsh-pocket');
  mk(pinDir, { recursive: true });
  // 先用正常写入建立基线
  assert.equal(setCustomPin('public', 'firstPin1'), 'firstPin1');
  assert.equal(pinWriteWarning('public'), null, '正常写入没有告警');

  // 把 token 文件换成同名目录，模拟「磁盘写不进去」
  // 路径与 lib/index.js 的 tokenPath() 一致：<DSH_HOME>/dsh-pocket/token
  const p = join(pinDir, 'token');
  const { rmSync: rm } = await import('node:fs');
  rm(p, { force: true });
  mk(p, { recursive: true });

  const memoryPin = setCustomPin('public', 'secondPin2');
  assert.equal(memoryPin, 'secondPin2', '内存值仍然立刻生效');
  assert.equal(getAccessToken(), 'secondPin2', '读取走内存');
  const warning = pinWriteWarning('public');
  assert.ok(typeof warning === 'string' && warning.length > 0, '必须报告落盘失败原因');
}));

test('恢复出厂：设置文件删不掉时 resetPocketState 报 settingsCleared=false 并带告警', () => withHome(async (home) => {
  const { resetPocketState } = await import('../lib/index.js');
  const { settingsPath } = await import('../lib/settings.mjs');
  const { mkdirSync: mk, rmSync: rm } = await import('node:fs');
  // 让 settings.json 变成非空目录：rmSync(force) 删文件成功、删非空目录失败
  const sp = settingsPath();
  rm(sp, { force: true });
  mk(join(sp, 'blocker'), { recursive: true });
  const out = resetPocketState();
  assert.equal(out.settingsCleared, false, '删除失败必须如实上报，不能吞掉');
  assert.ok(out.warnings.some((w) => w.includes('settings.json')), '告警里要说明是设置文件没删掉');
  assert.ok(out.accessToken.length >= 8, 'PIN 仍然换成新的（内存可用）');
}));
