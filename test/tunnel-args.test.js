// issue #78 回归：cloudflared 2026.x 把 `tunnel run` 子命令层级的 `--no-autoupdate` 删了，
// 但该 flag 在全局位置（子命令之前）仍有效。这里用假 cloudflared 记录 argv，断言顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNamedTunnel, firstMeaningfulErrorLine, cloudflaredEnv } from '../lib/tunnel.mjs';

async function makeFakeCloudflared() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-fake-cf-'));
  const bin = join(dir, 'cloudflared');
  const record = join(dir, 'argv.json');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.TUNNEL_TOKEN }));
process.stdout.write('INF Registered tunnel connection\\n');
`;
  await writeFile(bin, script, { mode: 0o755 });
  return { bin, record, dir };
}

function withFakeBin(bin, fn) {
  const prev = process.env.DSH_POCKET_CLOUDFLARED;
  process.env.DSH_POCKET_CLOUDFLARED = bin;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.DSH_POCKET_CLOUDFLARED;
    else process.env.DSH_POCKET_CLOUDFLARED = prev;
  });
}

// 假 cloudflared 是 `#!/usr/bin/env node` 的无扩展名脚本，Windows 的 spawn 无法直接
// 执行（需要 .exe/.cmd，或 shell:true）；生产路径也不依赖它，CI 在 ubuntu 上覆盖。
const POSIX_ONLY = process.platform === 'win32'
  ? '需要 POSIX shebang 假二进制；Windows spawn 无扩展名脚本会 ENOENT'
  : false;

test('issue #78: 命名隧道 --no-autoupdate 在全局位置（argv[0]，含 run）', { skip: POSIX_ONLY }, async () => {
  const { bin, record, dir } = await makeFakeCloudflared();
  try {
    await withFakeBin(bin, async () => {
      const ac = new AbortController();
      const token = 'fake-cloudflared-token-for-tests';
      const res = await startNamedTunnel({ token, signal: ac.signal });
      res.kill();
      const recorded = JSON.parse(await readFile(record, 'utf8'));
      const { argv } = recorded;
      assert.equal(res.url, null, '命名隧道 url 应为 null（由调用方拼固定域名）');
      assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须是 argv 第一个（全局位置）');
      assert.ok(argv.indexOf('tunnel') > argv.indexOf('--no-autoupdate'), '--no-autoupdate 必须在 tunnel 子命令之前');
      assert.ok(argv.includes('run'), '命名隧道应含 run 子命令');
      assert.deepEqual(argv, ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2']);
      assert.equal(recorded.token, token, 'Token 只通过环境变量传递');
      assert.ok(!argv.includes(token) && !argv.includes('--token'), 'Token 不得进入命令行');
      assert.ok(!argv.includes('--url'), '不得启动随机 URL 隧道');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('firstMeaningfulErrorLine: 参数错误取开头首行', () => {
  const buf = 'Incorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run - Proxy a local web server\n--bastion Runs as jump host ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 版本横幅在前后仍能取到参数错误行', () => {
  const buf = 'cloudflared version 2026.4.0\nIncorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 运行期错误（403）仍取尾部', () => {
  const buf = 'INF Starting tunnel\nERR Failed to connect to origin: 403 Forbidden\nERR retrying';
  const r = firstMeaningfulErrorLine(buf);
  assert.ok(r.includes('403'), '应保留尾部含 403 的报错信息');
});

test('cloudflaredEnv：剥离所有代理变量，强制 cloudflared 直连边缘（防 error 1033）', () => {
  const saved = {};
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
  for (const k of keys) saved[k] = process.env[k];
  const other = process.env.DSH_POCKET_TEST_KEEP;
  try {
    for (const k of keys) process.env[k] = 'http://127.0.0.1:7890';
    process.env.DSH_POCKET_TEST_KEEP = 'kept';
    const env = cloudflaredEnv({ TUNNEL_TOKEN: 'tok' });
    for (const k of keys) assert.equal(env[k], undefined, `代理变量 ${k} 必须被剥离`);
    assert.equal(env.DSH_POCKET_TEST_KEEP, 'kept', '非代理变量保持原样');
    assert.equal(env.TUNNEL_TOKEN, 'tok', '显式 extra 生效');
    // 不污染 process.env（只影响子进程副本）
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890', '不得修改当前进程环境');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (other === undefined) delete process.env.DSH_POCKET_TEST_KEEP;
    else process.env.DSH_POCKET_TEST_KEEP = other;
  }
});
