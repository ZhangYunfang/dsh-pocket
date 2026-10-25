// cloudflared 下载源完整性校验（供应链）：
// 镜像只当传输通道——字节必须与 GitHub API 公布的 sha256 一致；
// 摘要拿不到时只允许官方 github.com 直链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  normalizeDigest,
  fetchExpectedDigest,
  sha256File,
  sourceAllowedWithoutDigest,
  OFFICIAL_ASSET_URL,
} from '../lib/tunnel.mjs';

const HEX64 = 'a'.repeat(64);

test('normalizeDigest: 只认 sha256:<64hex>', () => {
  assert.equal(normalizeDigest(`sha256:${HEX64}`), HEX64);
  assert.equal(normalizeDigest(HEX64), HEX64); // 无前缀也接受（已是规范 hex）
  assert.equal(normalizeDigest(`sha256:${HEX64.toUpperCase()}`), HEX64, '大写归一');
  assert.equal(normalizeDigest('sha256:abc'), null, '长度不足');
  assert.equal(normalizeDigest('sha512:'.padEnd(74, '0')), null, '非 sha256 算法');
  assert.equal(normalizeDigest(''), null);
  assert.equal(normalizeDigest(null), null);
  assert.equal(normalizeDigest(undefined), null);
});

test('fetchExpectedDigest: 从 latest release 资产里按名匹配', async () => {
  const mk = (assets, ok = true) => async () => ({ ok, json: async () => ({ assets }) });
  const digest = `sha256:${'b'.repeat(64)}`;
  const hit = await fetchExpectedDigest('cloudflared-windows-amd64.exe', {
    fetchImpl: mk([{ name: 'other.tgz', digest: 'sha256:zz' }, { name: 'cloudflared-windows-amd64.exe', digest }]),
  });
  assert.equal(hit, 'b'.repeat(64));
  // 资产不在列表 / API 失败 / JSON 坏 / 网络异常 → null（不猜）
  assert.equal(await fetchExpectedDigest('missing.exe', { fetchImpl: mk([]) }), null);
  assert.equal(await fetchExpectedDigest('x', { fetchImpl: mk([], false) }), null);
  assert.equal(await fetchExpectedDigest('x', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad'); } }) }), null);
  assert.equal(await fetchExpectedDigest('x', { fetchImpl: async () => { throw new Error('offline'); } }), null);
  // 资产没有 digest 字段（旧版 API）→ null
  assert.equal(await fetchExpectedDigest('x', { fetchImpl: mk([{ name: 'x' }]) }), null);
});

test('sourceAllowedWithoutDigest: 摘要不可用时只放行官方直链', () => {
  const asset = 'cloudflared-windows-amd64.exe';
  assert.equal(sourceAllowedWithoutDigest(OFFICIAL_ASSET_URL(asset)), true);
  assert.equal(sourceAllowedWithoutDigest('https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset), false);
  assert.equal(sourceAllowedWithoutDigest('https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset), false);
  assert.equal(sourceAllowedWithoutDigest('https://evil.example.com/cloudflared.exe'), false);
  // 伪装前缀（官方域名出现在 host 之前）不得放行
  assert.equal(sourceAllowedWithoutDigest('https://github.com.evil.example.com/cloudflare/cloudflared/x'), false);
});

test('sha256File: 流式摘要与 node:crypto 一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshp-digest-'));
  try {
    const bytes = Buffer.from('cloudflared-ish payload for hashing\n'.repeat(100));
    await writeFile(join(dir, 'bin'), bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(await sha256File(join(dir, 'bin')), expected);
    await assert.rejects(sha256File(join(dir, 'nope')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
