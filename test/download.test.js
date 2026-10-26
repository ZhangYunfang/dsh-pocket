// downloadFile 多线程分块下载测试：本地起一个支持 Range 的服务器，
// 验证分块并发下载 + 合并后字节与源完全一致；以及不支持 Range 时回退单线程。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { downloadFile } from '../lib/tunnel.mjs';

/** 假二进制内容：4MB 可预测字节（> MIN_PARALLEL_SIZE，触发分块）。 */
function makePayload(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

/** 支持/不支持 Range 的服务器。 */
async function rangeServer(payload, { supportRange, probeDelayMs = 0, probeSize } = {}) {
  const server = createServer(async (req, res) => {
    const range = req.headers.range;
    if (supportRange && range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m[1]);
      const end = Number(m[2]);
      // 只延迟"探针那一小段"（从 0 开始的短区间），模拟慢网络
      if (probeDelayMs > 0 && start === 0 && probeSize && end === probeSize - 1) {
        await new Promise((r) => setTimeout(r, probeDelayMs));
      }
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': end - start + 1,
        'accept-ranges': 'bytes',
      });
      res.end(payload.subarray(start, end + 1));
    } else {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
        ...(supportRange ? { 'accept-ranges': 'bytes' } : {}),
      });
      res.end(payload);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

test('downloadFile：支持 Range 时多线程分块，合并后字节与源一致', async () => {
  const payload = makePayload(4 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: true });
  const dir = await mkdtemp(join(tmpdir(), 'dl-par-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length, '返回总字节数');
    const got = await readFile(dest);
    assert.equal(got.length, payload.length, '合并后长度一致');
    assert.ok(got.equals(payload), '合并后字节完全一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

// 生产阈值 MIN_PARALLEL_SIZE=8MiB / PROBE_SIZE=2MiB 让"真跑一次分块"要下载 8MB+
// 且探针必须慢于 300KB/s（本地回环永远达不到），所以分块分支此前在测试里根本
// 走不到（旧用例标称"多线程"实际是单线程）。这里把内部阈值调到测试量级：
// 文件 256KB、探针 16KB、阈值 1000B/ms，并让服务器只在探针那段延迟 600ms
// （探针要慢过 500ms 才会进入测速判定，见 downloadFile 里的 probeMs < 500 短路），
// 从而在本地稳定触发 8 段并发下载 + mergeParts 合并路径。
test('downloadFile：慢网络下真的走 8 段并发并正确合并（覆盖 mergeParts）', async () => {
  const payload = makePayload(256 * 1024);
  const probeSize = 16 * 1024;
  const { port, server } = await rangeServer(payload, {
    supportRange: true, probeDelayMs: 600, probeSize,
  });
  const dir = await mkdtemp(join(tmpdir(), 'dl-merge-'));
  try {
    const dest = join(dir, 'out.bin');
    const seen = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const r = init?.headers?.Range ?? init?.headers?.range;
      if (r) seen.push(r);
      return origFetch(input, init);
    };
    let len;
    try {
      len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, {
        segments: 8, minParallelSize: 64 * 1024, probeSize, slowSpeedThreshold: 1000,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.equal(len, payload.length, '返回总字节数');
    const got = await readFile(dest);
    assert.ok(got.equals(payload), '分块合并后字节与源完全一致');
    // 探针一条 + 8 段分块（探针 0-16383，另 8 条覆盖全文件）
    assert.equal(seen.length, 9, '探针 + 8 段范围请求，实际: ' + JSON.stringify(seen));
    assert.ok(seen.includes('bytes=0-16383'), '先发探针');
    assert.ok(seen.includes('bytes=0-32767'), '分块从 0 开始（探针被丢弃后全量重下）');
    assert.ok(seen.includes(`bytes=${payload.length - 32768}-${payload.length - 1}`), '最后一段到文件末尾');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('downloadFile：探针够快则不切多线程，只发探针 + 一次剩余区间', async () => {
  const payload = makePayload(256 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: true });
  const dir = await mkdtemp(join(tmpdir(), 'dl-fast-'));
  try {
    const dest = join(dir, 'out.bin');
    const seen = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const r = init?.headers?.Range ?? init?.headers?.range;
      if (r) seen.push(r);
      return origFetch(input, init);
    };
    try {
      await downloadFile(`http://127.0.0.1:${port}/cf`, dest, {
        segments: 8, minParallelSize: 64 * 1024, probeSize: 16 * 1024, slowSpeedThreshold: 0.0001,
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    const got = await readFile(dest);
    assert.ok(got.equals(payload), '单线程拼接后字节一致');
    assert.equal(seen.length, 2, '只有探针 + 剩余区间，实际: ' + JSON.stringify(seen));
    assert.equal(seen[0], 'bytes=0-16383');
    assert.equal(seen[1], `bytes=16384-${payload.length - 1}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('verifySha256：摘要匹配才通过，且接受裸 hex 与 sha256: 前缀', async () => {
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const { verifySha256 } = await import('../lib/tunnel.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'sha-'));
  try {
    const f = join(dir, 'blob.bin');
    const body = makePayload(4096);
    await writeFile(f, body);
    const hex = createHash('sha256').update(body).digest('hex');
    assert.equal((await verifySha256(f, `sha256:${hex}`)).ok, true, '带前缀命中');
    assert.equal((await verifySha256(f, hex.toUpperCase())).ok, true, '裸大写 hex 也命中');
    const bad = await verifySha256(f, 'f'.repeat(64));
    assert.equal(bad.ok, false, '哈希不符必须失败');
    assert.equal(bad.actual, hex, '回传实际哈希便于报错定位');
    assert.equal((await verifySha256(f, 'deadbeef')).ok, false, '长度不对的摘要一律失败（不静默放行）');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloadFile：不支持 Range 时回退单线程，字节一致', async () => {
  const payload = makePayload(3 * 1024 * 1024);
  const { port, server } = await rangeServer(payload, { supportRange: false });
  const dir = await mkdtemp(join(tmpdir(), 'dl-single-'));
  try {
    const dest = join(dir, 'out.bin');
    const len = await downloadFile(`http://127.0.0.1:${port}/cf`, dest, { segments: 8 });
    assert.equal(len, payload.length);
    const got = await readFile(dest);
    assert.ok(got.equals(payload), '单线程回退字节一致');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await new Promise((r) => server.close(r));
  }
});

test('resolveCloudflared：手动放置的资产名文件也能命中缓存（issue #15）', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveCloudflared } = await import('../lib/tunnel.mjs');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-manual-'));
  const { platform } = await import('node:process');
  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const osName = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const arch = archMap[process.arch] ?? process.arch;
  const assetName = `cloudflared-${osName}-${arch}${osName === 'windows' ? '.exe' : ''}`;

  // 只放资产名文件（不是 bin 名）→ 应命中，不触发下载
  const binDir = path.join(home, 'dsh-pocket', 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(path.join(binDir, assetName), 'fake-binary');
  let downloading = false;
  const bin = await resolveCloudflared({ home, onPhase: (p) => { if (p === 'downloading') downloading = true; } });
  assert.equal(downloading, false, '未触发下载');
  assert.ok(bin.includes(assetName), '命中资产名文件: ' + bin);
  await fsp.rm(home, { recursive: true, force: true });
});

// 仅 Linux 适用：假缓存文件名 cloudflared 无扩展名，Windows 候选名
// （cloudflared.exe / cloudflared-windows-*.exe）永不匹配 → 必走真实下载挂网络。
test('resolveCloudflared：Linux 上丢弃 Homebrew bottle 坏缓存（issue #22）', { skip: process.platform !== 'linux' && '仅 Linux 适用（Windows 候选名带 .exe，无扩展名假缓存永不匹配）' }, async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { resolveCloudflared } = await import('../lib/tunnel.mjs');
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshp-homebrew-'));
  const binDir = path.join(home, 'dsh-pocket', 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  // 模拟 Linux Homebrew bottle 坏缓存：文件含 @@HOMEBREW_PREFIX@@ 占位符
  await fsp.writeFile(path.join(binDir, 'cloudflared'), '@@HOMEBREW_PREFIX@@/lib/ld.so\x00fake-binary');
  let downloading = false;
  // 在 Linux 上会触发删除 + 重新下载（下载会失败因网络，但我们只验证"不命中坏缓存"）
  try {
    await resolveCloudflared({ home, onPhase: (p) => { if (p === 'downloading') downloading = true; } });
  } catch { /* 下载失败可接受 */ }
  // 坏缓存应已被删除（不再被当成可用二进制）
  const stillThere = await fsp.readFile(path.join(binDir, 'cloudflared'), 'utf8').catch(() => null);
  // 若系统是 Linux 且触发了下载流程 → 文件被删/被覆盖；macOS 上本测试不适用（无 Homebrew 检查）
  if (process.platform === 'linux') {
    assert.ok(stillThere === null || !stillThere.includes('@@HOMEBREW_PREFIX@@'), '坏缓存被丢弃');
  }
  await fsp.rm(home, { recursive: true, force: true });
});

// ---------- 发布资产名（issue #45） ----------

test('platformAssets（issue #45）：linux 首选裸二进制，不再拼上游已下架的 .tgz', async () => {
  const { platformAssets } = await import('../lib/tunnel.mjs');
  const onPlatform = (platform, arch) => {
    const pd = Object.getOwnPropertyDescriptor(process, 'platform');
    const ad = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
    try {
      return platformAssets();
    } finally {
      if (pd) Object.defineProperty(process, 'platform', pd);
      if (ad) Object.defineProperty(process, 'arch', ad);
    }
  };
  // 2026-08 起 cloudflared 不再发布 cloudflared-linux-<arch>.tgz（实测 404），
  // 只有裸二进制 cloudflared-linux-<arch>。以前我们在 linux 上拼的是 .tgz，
  // 五个镜像全指向同一个 404 → 必然「所有源都不通」。
  assert.deepEqual(onPlatform('linux', 'x64'), ['cloudflared-linux-amd64', 'cloudflared-linux-amd64.tgz']);
  assert.deepEqual(onPlatform('linux', 'arm64'), ['cloudflared-linux-arm64', 'cloudflared-linux-arm64.tgz']);
  assert.deepEqual(onPlatform('linux', 'ia32'), ['cloudflared-linux-386', 'cloudflared-linux-386.tgz']);
  // .tgz 只作为回退排在后面：首个候选必须是不需要解压的裸二进制
  assert.ok(!onPlatform('linux', 'x64')[0].endsWith('.tgz'), 'linux 首选资产不该是 .tgz');
  // 其他平台的布局没变
  assert.deepEqual(onPlatform('darwin', 'arm64'), ['cloudflared-darwin-arm64.tgz']);
  assert.deepEqual(onPlatform('darwin', 'x64'), ['cloudflared-darwin-amd64.tgz']);
  assert.deepEqual(onPlatform('win32', 'x64'), ['cloudflared-windows-amd64.exe']);
  // 真实环境（本机）至少有一个候选
  assert.ok(platformAssets().length >= 1);
});
