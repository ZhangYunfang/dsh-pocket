// issue #79 回归：Tailscale/CGNAT（100.64/10）及用户手动「局域网地址」覆盖，应走局域网密码。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenForHost, credentialKindForHost, isLanOverrideHost, rotateAccessToken } from '../lib/index.js';
import { setLanIpOverride, setLanAuthEnabled, lanIpOverride, setPinCustom, setTunnelMode } from '../lib/settings.mjs';

let tmpHome = null;
let savedHome = null;

function withTempHome(fn) {
  return (async () => {
    savedHome = process.env.DSH_HOME;
    tmpHome = await mkdtemp(join(tmpdir(), 'dsh-pocket-auth-'));
    process.env.DSH_HOME = tmpHome;
    try {
      return await fn();
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
      if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
    }
  })();
}

test('issue #79：手动「局域网地址」覆盖（公网段 IP）走局域网密码，而非公网密码', () => withTempHome(async () => {
  setLanAuthEnabled(true);
  setLanIpOverride('203.0.113.5'); // 故意用公网段 IP，证明覆盖优先级高于 classifyHost
  assert.equal(lanIpOverride(), '203.0.113.5');

  // 覆盖地址（带端口）→ 局域网 token
  const lanToken = tokenForHost('203.0.113.5:3081');
  // 普通公网域名（无覆盖命中）→ 公网 token
  const publicToken = tokenForHost('pocket.example.com');

  assert.notEqual(lanToken, publicToken, '覆盖地址必须比对局域网密码，而非公网密码');
  // 其它内网地址也走局域网 token（与覆盖地址一致）
  assert.equal(tokenForHost('192.168.1.5:3081'), lanToken, 'RFC1918 与覆盖地址共用局域网密码');
  // 公网路径不被覆盖误伤
  assert.equal(tokenForHost('8.8.8.8:3081'), publicToken, '普通公网 Host 仍走公网密码');

  // isLanOverrideHost 判定（带/不带端口）
  assert.equal(isLanOverrideHost('203.0.113.5:3081'), true);
  assert.equal(isLanOverrideHost('203.0.113.5'), true);
  assert.equal(isLanOverrideHost('192.168.1.5:3081'), false, '非覆盖地址不应命中');

  // 清空覆盖后恢复 classifyHost 语义（公网段 IP → 公网密码）
  setLanIpOverride('');
  assert.equal(isLanOverrideHost('203.0.113.5:3081'), false);
  assert.equal(tokenForHost('203.0.113.5:3081'), publicToken, '覆盖清空后回到公网判定');
}));

test('issue #79：CGNAT 100.64/10 无需覆盖即走局域网密码', () => withTempHome(async () => {
  setLanIpOverride(''); // 自动模式
  const lanToken = tokenForHost('100.64.0.1:3081');
  const publicToken = tokenForHost('pocket.example.com');
  assert.notEqual(lanToken, publicToken);
  assert.equal(tokenForHost('100.127.255.254:3081'), lanToken, '100.127 仍属 100.64/10');
  assert.equal(tokenForHost('100.63.0.1:3081'), publicToken, '100.63 超出范围 → 公网密码');
  assert.equal(tokenForHost('100.128.0.1:3081'), publicToken, '100.128 超出范围 → 公网密码');
}));

test('issue #90：访问 PIN 必须用 CSPRNG 生成，不得回退到 Math.random', () => withTempHome(async () => {
  // 源码守卫：Math.random 是 V8 的 xorshift128+，可由少量输出还原内部状态并推算后续值。
  // 用它生成访问密码等于把 9×10⁷ 的搜索空间进一步压缩，因此整个 lib/index.js 都不许出现。
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('Math.random'), '访问密码生成不得使用 Math.random');

  // 行为守卫：格式仍是 8 位数字（不破坏手机输入体验与 PIN_RE），且取值铺满首位 1-9。
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const pin = rotateAccessToken();
    assert.match(pin, /^[1-9]\d{7}$/, `第 ${i + 1} 次生成的 PIN 应为 8 位数字且无前导零：${pin}`);
    seen.add(pin);
  }
  // 200 次采样在 9×10⁷ 空间里几乎不可能撞车；若大量重复说明随机源退化了。
  assert.ok(seen.size >= 199, `200 次采样应基本互不相同，实际 ${seen.size} 个不同值`);
}));

test('登录页凭据语义：LAN、Named 和自定义公网 PIN 均可保存', () => withTempHome(async () => {
  setLanIpOverride('');
  setPinCustom('public', false);

  assert.equal(credentialKindForHost('192.168.1.5:3081'), 'persistent', 'LAN 自动 PIN 持久到手动刷新');
  assert.equal(credentialKindForHost('pocket.example.com'), 'persistent', '未配置公网时凭据也不标记为临时');

  setPinCustom('public', true);
  assert.equal(credentialKindForHost('pocket.example.com'), 'persistent', '自定义公网 PIN 长期复用');

  setPinCustom('public', false);
  setTunnelMode('named');
  assert.equal(credentialKindForHost('pocket.example.com'), 'persistent', 'Named Tunnel PIN 不自动轮换');

  setLanIpOverride('203.0.113.5');
  assert.equal(credentialKindForHost('203.0.113.5:3081'), 'persistent', '手动 LAN 地址覆盖仍按 LAN 持久 PIN 处理');
}));

for (const custom of [false, true]) {
  test(`登录页凭据语义：旧 quick 配置的公网 PIN 仍持久（自定义=${custom}）`, () => withTempHome(async () => {
    const dir = join(tmpHome, 'dsh-pocket');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'settings.json');
    const legacy = JSON.stringify({ tunnelMode: 'quick', publicPinCustom: custom });
    writeFileSync(file, legacy);
    for (const host of ['pocket.example.com', '192.168.1.5:3081', '100.64.0.1:3081', '127.0.0.1:3081']) {
      assert.equal(credentialKindForHost(host), 'persistent', '旧模式不再产生临时凭据');
    }
    assert.equal(readFileSync(file, 'utf8'), legacy, '凭据分类不改写旧配置');
  }));
}
