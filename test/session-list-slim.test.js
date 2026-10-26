// session/list 响应瘦身（issue：公网加载慢 / 对话加载不出来）回归测试。
//
// 覆盖两个容易写坏的点：
//   1) 缓存键必须带请求体摘要——不同 payload 的列表请求（切工作区、不同 cursor）
//      在短 TTL 内不能互相串台，否则会把 A 工作区的会话树渲染进 B 工作区；
//   2) 瘦身只剥约定的胖投影字段，其余字段原样保留；改写失败必须原样透传。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { createPocketProxy } from '../lib/proxy.mjs';

const FAT_KEYS = ['contextHeaders', 'retrace/forkmap', 'retrace/versions', 'watcherInsights', 'turnOutline'];

/** 假上游：按请求体里的 marker 造一份带胖投影的 session/list 响应，并统计命中次数。 */
async function fakeSessionListUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let marker = '';
      try { marker = JSON.parse(raw).payload?.marker ?? ''; } catch { marker = ''; }
      hits.push({ path: req.url, marker });
      const values = { keepMe: `keep:${marker}`, contextTimeline: { bytes: 1 } };
      for (const key of FAT_KEYS) values[key] = { pad: 'x'.repeat(2048), marker };
      const body = JSON.stringify({ result: { value: { items: [{ id: `s-${marker}`, title: `t-${marker}`, projections: { values } }] } } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, server };
}

/** 假上游：返回非 JSON 体（验证「改写失败一律原样透传」）。 */
async function fakeBrokenUpstream() {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json-at-all');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

/** 假上游：按真实 RPC 信封回包，把请求里的 rpcId 原样带回（模拟 DSH 宿主）。 */
async function fakeEnvelopeUpstream() {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let rpcId = null;
      let marker = '';
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        rpcId = parsed.rpcId ?? null;
        marker = parsed.payload?.marker ?? '';
      } catch { /* 忽略 */ }
      hits.push({ rpcId, marker });
      const values = { keepMe: `keep:${marker}` };
      for (const key of FAT_KEYS) values[key] = { pad: 'x'.repeat(2048) };
      const body = JSON.stringify({
        rpcId,
        type: 'server-response',
        result: { value: { items: [{ id: 's-envelope', title: 't', projections: { values } }] } },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, server };
}

/** POST /api/session/list，返回解析后的 JSON 与响应头。 */
function postSessionList(port, payload, acceptEncoding = 'br') {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/session/list',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.length),
        'accept-encoding': acceptEncoding,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] ?? '');
        let plain = raw;
        if (enc === 'br') plain = brotliDecompressSync(raw);
        else if (enc === 'gzip') plain = gunzipSync(raw);
        let json = null;
        try { json = JSON.parse(plain.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: plain.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('session/list 瘦身：剥掉约定的胖投影字段，保留其余字段', async () => {
  const up = await fakeSessionListUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await postSessionList(proxy.port, { payload: { marker: 'a' } });
    assert.equal(res.status, 200);
    const values = res.json.result.value.items[0].projections.values;
    for (const key of FAT_KEYS) assert.equal(values[key], undefined, `胖字段 ${key} 应被剥掉`);
    assert.equal(values.keepMe, 'keep:a');
    assert.deepEqual(values.contextTimeline, { bytes: 1 });
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.headers['cache-control'], 'no-store');
    // content-length 是重压缩后的字节数，比解码后的正文小（q6 br）
    assert.ok(Number(res.headers['content-length']) > 0);
    assert.ok(Number(res.headers['content-length']) < Buffer.byteLength(res.text));
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('session/list 瘦身：不同请求体在 TTL 内不串台（各拿各的列表）', async () => {
  const up = await fakeSessionListUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const first = await postSessionList(proxy.port, { payload: { marker: 'a' } });
    const second = await postSessionList(proxy.port, { payload: { marker: 'b' } });
    assert.equal(first.json.result.value.items[0].id, 's-a');
    assert.equal(second.json.result.value.items[0].id, 's-b', '第二个请求拿到了第一个请求的缓存 → 串台');
    assert.equal(second.headers['x-dsh-pocket-slim-cache'], undefined);
    assert.equal(up.hits.length, 2, '不同 payload 必须各打一次上游');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('session/list 瘦身：同一请求体命中缓存（省掉重复的解压/解析/重压缩）', async () => {
  const up = await fakeSessionListUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const payload = { payload: { marker: 'same' } };
    const first = await postSessionList(proxy.port, payload);
    const second = await postSessionList(proxy.port, payload);
    assert.equal(first.headers['x-dsh-pocket-slim-cache'], undefined);
    assert.equal(second.headers['x-dsh-pocket-slim-cache'], 'hit');
    assert.equal(second.json.result.value.items[0].id, 's-same');
    // 缓存命中点在响应阶段（上游响应头决定要不要瘦身），所以上游仍被打一次；
    // 省下的是 40MB 的解压 + JSON.parse/stringify + br 重压缩，不是上游往返。
    assert.equal(up.hits.length, 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('session/list 瘦身：响应不是可解析 JSON 时原样透传（不丢数据）', async () => {
  const up = await fakeBrokenUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await postSessionList(proxy.port, { payload: { marker: 'x' } }, 'identity');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'not-json-at-all');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('session/list 瘦身：rpcId 不同的同一次调用仍命中缓存，且回当前 rpcId', async () => {
  // 真实客户端每次调用都生成新的 rpcId。缓存键若是含 rpcId 的请求体摘要，
  // 缓存就永远命不中；命中时若回上一次的 rpcId，客户端对不上号会丢弃整包。
  const up = await fakeEnvelopeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const first = await postSessionList(proxy.port, { rpcId: 'rpc-1', method: 'session/list', payload: { cursor: null } });
    const second = await postSessionList(proxy.port, { rpcId: 'rpc-2', method: 'session/list', payload: { cursor: null } });
    assert.equal(first.json.rpcId, 'rpc-1');
    assert.equal(second.json.rpcId, 'rpc-2', '命中缓存必须回当前请求的 rpcId');
    assert.equal(second.headers['x-dsh-pocket-slim-cache'], 'hit', 'rpcId 不同不应导致缓存失效');
    assert.equal(second.json.result.value.items[0].id, 's-envelope');
    // 命中在响应阶段（要等上游响应头才决定瘦身），所以上游各打一次；
    // 省下的是整包解压 + 40MB JSON 解析/重序列化。
    assert.equal(up.hits.length, 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});
