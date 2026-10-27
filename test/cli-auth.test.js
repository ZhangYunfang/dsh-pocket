// issue #90 第 8 条回归：CLI 模式此前完全不构造 auth，且默认监听 0.0.0.0——
// 任何能连到该端口的人都能直接操作 dsh web，而 dsh web 能在宿主机执行任意代码。
// 插件版一直有 PIN，只有 CLI 这条路是裸的。
//
// 这里验证：默认必有密码、密码内嵌进二维码 URL（扫码体验不退化）、本机免密、
// 弱口令被拒、--no-auth 是显式 opt-out，以及「CLI 仍然能被直接执行」——
// 因为为了可测性给入口加了 isDirectRun 守卫，守卫写错会让装好的 CLI 变成哑巴。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseArgs,
  resolvePin,
  buildAuth,
  entryUrl,
  resolvePublicConfig,
  cliArgError,
  MIN_PIN_LENGTH,
} from '../bin/dsh-pocket.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'bin', 'dsh-pocket.mjs');

test('issue #90：CLI 默认必须有访问密码，且是 CSPRNG 生成的 8 位数字', () => {
  const { pin, source, error } = resolvePin(parseArgs([]), {});
  assert.equal(error, undefined);
  assert.equal(source, 'generated');
  assert.match(pin, /^[1-9]\d{7}$/, '默认密码应为 8 位数字、无前导零');

  // 随机源必须是 CSPRNG：采样若干次应互不相同（Math.random 也能过这条，
  // 所以再加源码守卫——bin 里不允许出现非加密随机数调用）
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(resolvePin({}, {}).pin);
  assert.ok(seen.size > 90, `100 次采样只得到 ${seen.size} 个不同值，随机性可疑`);

  const src = readFileSync(cliPath, 'utf8');
  assert.ok(!src.includes('Math.random'), 'CLI 的访问密码不得用非加密随机数生成');
});

test('issue #90：--pin / DSH_POCKET_PIN 可自定义，优先级 flag > env > 随机', () => {
  assert.equal(resolvePin(parseArgs(['--pin', 'hunter2!']), {}).pin, 'hunter2!');
  assert.equal(resolvePin(parseArgs(['--pin', 'hunter2!']), { DSH_POCKET_PIN: 'from-env-x' }).source, 'flag');
  assert.equal(resolvePin(parseArgs([]), { DSH_POCKET_PIN: 'from-env-x' }).pin, 'from-env-x');
  assert.equal(resolvePin(parseArgs([]), { DSH_POCKET_PIN: 'from-env-x' }).source, 'env');
  // 空字符串不算显式指定，回落到随机生成（而不是变成「无密码」）
  assert.equal(resolvePin(parseArgs(['--pin', '']), {}).source, 'generated');
});

test(`issue #90：自定义密码短于 ${MIN_PIN_LENGTH} 位必须被拒，不能静默接受弱口令`, () => {
  for (const weak of ['1', '12', '1234', '123456', '1234567']) {
    const r = resolvePin(parseArgs(['--pin', weak]), {});
    assert.equal(r.pin, null, `${weak} 应被拒绝`);
    assert.ok(r.error, `${weak} 应给出错误说明`);
    assert.match(r.error, new RegExp(String(MIN_PIN_LENGTH)));
  }
  // 刚好达到下限则接受
  assert.equal(resolvePin(parseArgs(['--pin', '12345678']), {}).pin, '12345678');
  // 前后空白不该被当作密码的一部分（否则用户永远敲不进去）
  assert.equal(resolvePin(parseArgs(['--pin', '  12345678  ']), {}).pin, '12345678');
  // 纯空白不是密码
  assert.ok(resolvePin(parseArgs(['--pin', '        ']), {}).error);
});

test('issue #90 回归：--pin 缺值时必须报错，不能把下一个 flag 当成密码', () => {
  // 旧实现 `--pin --public` 会把字面量 "--public"（8 字符）当密码，同时吞掉 --public，
  // 用户以为开了公网、实际没开。
  const swallowed = parseArgs(['--pin', '--public']);
  assert.equal(swallowed.pin, '');
  assert.equal(swallowed.pinMissing, true);
  assert.equal(swallowed.public, true, '--public 仍要被解析（不能被当作 --pin 的值吞掉）');
  const r = resolvePin(swallowed, {});
  assert.equal(r.pin, null);
  assert.match(String(r.error), /--pin/);
});

test('CLI：--public 与 --no-auth 同时出现必须拒绝启动（公网 + 无鉴权 = 裸奔）', () => {
  assert.match(String(cliArgError(parseArgs(['--public', '--no-auth']))), /--no-auth/);
  // 单独用任何一个都不该被这条规则拦下
  assert.equal(cliArgError(parseArgs(['--public'])), null);
  assert.equal(cliArgError(parseArgs(['--no-auth'])), null);
  assert.equal(cliArgError(parseArgs([])), null);
});

test('issue #90：--no-auth 是显式 opt-out —— 只有它能让 auth 为空', () => {
  const off = resolvePin(parseArgs(['--no-auth']), { DSH_POCKET_PIN: 'from-env-x' });
  assert.equal(off.pin, null);
  assert.equal(off.source, 'disabled');
  assert.equal(buildAuth(off.pin), null, '无密码时不应构造 auth');

  // 反过来：不传 --no-auth 的任何组合都必须产出 auth
  for (const argv of [[], ['--public'], ['--host', '0.0.0.0'], ['--pin', 'hunter2!']]) {
    const { pin } = resolvePin(parseArgs(argv), {});
    assert.ok(buildAuth(pin), `argv=${JSON.stringify(argv)} 必须启用认证`);
  }
});

test('issue #90：CLI 的 auth 语义 —— 局域网/公网要密码，本机免密', () => {
  const auth = buildAuth('12345678');
  assert.ok(auth.sessionKey && auth.sessionKey.length >= 32, 'sessionKey 必须存在且够长');
  assert.equal(auth.getToken(), '12345678');

  for (const host of ['192.168.1.20:3081', '10.0.0.5:3081', 'foo.trycloudflare.com', 'pocket.example.com']) {
    assert.equal(auth.isProtected(host), true, `${host} 必须要密码`);
  }
  for (const host of ['127.0.0.1:3081', 'localhost:3081', '[::1]:3081']) {
    assert.equal(auth.isProtected(host), false, `${host} 应免密（本机直连本来就说明已上机）`);
  }
});

test('issue #90：密码要内嵌进入口 URL —— 加了认证不能让扫码体验退化', () => {
  assert.equal(entryUrl('http://192.168.1.20:3081', '12345678'), 'http://192.168.1.20:3081/?token=12345678');
  assert.equal(
    entryUrl('https://foo.trycloudflare.com', '12345678'),
    'https://foo.trycloudflare.com/?token=12345678',
  );
  // 需要转义的密码不能把 URL 弄坏
  assert.equal(entryUrl('http://1.2.3.4:3081', 'a b&c=d'), 'http://1.2.3.4:3081/?token=a+b%26c%3Dd');
  // 无密码时原样返回
  assert.equal(entryUrl('http://192.168.1.20:3081', null), 'http://192.168.1.20:3081');
});

test('CLI 公网只接受已配置的固定域名，入口 URL 不依赖隧道输出', () => {
  const token = 'example-token-for-offline-tests';
  for (const config of [{ hostname: '', token }, { hostname: 'pocket.example.com', token: '' }]) {
    assert.throws(() => resolvePublicConfig(config), /固定域名.*Tunnel Token/);
  }
  const config = resolvePublicConfig({ hostname: 'pocket.example.com', token });
  assert.equal(config.url, 'https://pocket.example.com');
  assert.equal(entryUrl(config.url, '12345678'), 'https://pocket.example.com/?token=12345678');
  const src = readFileSync(cliPath, 'utf8');
  assert.ok(src.includes('entryUrl(publicConfig.url, pin)'));
  assert.ok(!src.includes('startQuickTunnel'));
});

test('CLI --public 未配置时在监听端口或下载隧道程序前退出', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pocket-cli-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, '--public'], {
      env: { ...process.env, DSH_HOME: home, DSH_POCKET_PIN: '', DSH_POCKET_CLOUDFLARED: join(home, 'must-not-run') },
      timeout: 10000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(String(err.stderr), /固定域名.*Tunnel Token/);
      assert.ok(!String(err.stdout).includes('启动中'));
      return true;
    },
  );
});

test('issue #90：为可测性加的 isDirectRun 守卫不能把 CLI 变成哑巴', async () => {
  // --help 必须仍然打印用法并 exit 0（守卫写错时这里会静默无输出）
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help']);
  assert.match(stdout, /dsh-pocket/);
  assert.match(stdout, /--no-auth/);
  assert.match(stdout, /--pin/);

  // 弱口令必须在启动前就被拦下（exit 1），而不是带着弱口令跑起来
  await assert.rejects(
    () => execFileAsync(process.execPath, [cliPath, '--pin', '123']),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(String(err.stderr), new RegExp(String(MIN_PIN_LENGTH)));
      return true;
    },
  );

  // 而 import 本文件（测试就是这么做的）不能顺带把服务跑起来 —— 上面几条测试
  // 能跑到这里本身就是证据：如果 import 触发了 main()，进程会挂在 await 上不退出。
});
