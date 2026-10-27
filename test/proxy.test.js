// dsh-pocket 代理测试（假上游，验证 Host/Origin 改写 + WebSocket 透传）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { gzipSync, brotliDecompressSync } from 'node:zlib';
import { WebSocket, WebSocketServer } from 'ws';

import { createPocketProxy, createHandshakeTracker, DEFAULT_INJECT, SW_SCRIPT, SW_SCRIPT_PATH, SW_REGISTER_SCRIPT, HASHED_ASSET_RE } from '../lib/proxy.mjs';

/** 构造一个带掩码的 WS 文本帧（浏览器在握手后立即发的首帧，会进 upgrade 的 head）。 */
function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + text
  header[1] = 0x80 | payload.length; // MASK + len
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * 以指定 Host 头取回响应文本。
 *
 * 必须用原始 http.request：fetch() 遵循 Fetch 规范，Host 属于 forbidden header name，
 * 会被静默丢弃，代理看到的永远是 `127.0.0.1:<port>`（→ loopback），写出来的
 * 「公网 Host」测试其实一直在测局域网分支。
 */
function getWithHost(port, hostHeader, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: hostHeader, accept: 'text/html', ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 假上游：记录收到的 Host/Origin，回显请求路径。 */
async function fakeUpstream() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, path: req.url });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`path=${req.url}`);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (m) => ws.send(`echo:${m}`));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, server };
}

/** 假上游：对所有请求返回 403 text/plain，body 可配置（模拟 DSH Desktop 的
 *  desktop-browser-access 门禁，或任意其他 403）。 */
async function fakeUpstream403(body = 'forbidden') {
  const server = createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

test('issue #81: 导航请求遇上游 403 forbidden → 改写为可操作提示页（保留 403）', async () => {
  const up = await fakeUpstream403('forbidden');
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 403, '状态码保持 403（未授权访问未授予）');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/, '提示页是 HTML');
    assert.equal(res.headers.get('x-dsh-pocket-gate'), 'desktop-browser-access', '标记门禁来源');
    const html = await res.text();
    assert.match(html, /浏览器访问/, '提示页说明需开启浏览器访问');
    assert.match(html, /compatibility/, '提示页给出 compatibility 模式配置');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('issue #81: API 请求遇上游 403 forbidden → 原样透传（不改写为提示页）', async () => {
  const up = await fakeUpstream403('forbidden');
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/events`, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/, '原样透传 text/plain');
    assert.equal(await res.text(), 'forbidden', '原样透传 body');
    assert.equal(res.headers.get('x-dsh-pocket-gate'), null, 'API 不标门禁');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('issue #81: 其他 403 文本（非 forbidden）不误判为桌面门禁', async () => {
  const up = await fakeUpstream403('denied');
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/, '原样透传（非提示页）');
    assert.equal(await res.text(), 'denied', '原样透传 body');
    assert.equal(res.headers.get('x-dsh-pocket-gate'), null, '不标门禁');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('HTTP：Host/Origin 被改写成 loopback 权威，响应原样返回', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/hello`, {
      headers: { Host: 'my-lan-ip:3081', Origin: 'http://my-lan-ip:3081' },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'path=/api/hello');
    assert.equal(up.seen[0].host, `127.0.0.1:${up.port}`, 'Host 已改写为 loopback 权威');
    assert.equal(up.seen[0].origin, `http://127.0.0.1:${up.port}`, 'Origin 已改写');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('WS 上游 socket 发 RST（ECONNRESET）不崩进程（PR #49）：error 监听兜底', async () => {
  const { createServer: createUp } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const upSockets = [];
  const up = createUp((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  up.on('upgrade', (req, socket) => {
    upSockets.push(socket);
    // 正常 101 握手（用标准 Sec-WebSocket-Accept 计算）
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key'] ?? '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    heartbeat: false, // 排除心跳变量，专注 error 兜底
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

    // 上游发 RST（resetAndDestroy 触发 ECONNRESET）——修复前 proxySocket 无 error 监听，
    // 未处理的 error 事件会让整个 dsh web 进程崩溃退出（uncaught exception）
    for (const s of upSockets) { try { s.resetAndDestroy?.(); } catch { s.destroy(); } }
    await new Promise((r) => setTimeout(r, 250)); // 等 RST 传播

    // 进程未崩：代理仍能服务新请求
    const res = await fetch(`http://127.0.0.1:${proxy.port}/after`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok', '上游 RST 后代理进程仍存活');
  } finally {
    try { await proxy.close(); } catch { /* 已关 */ }
    await new Promise((r) => up.close(r));
  }
});

test('WS 半开连接（PR #56）：客户端直接 FIN（不发 close 帧）→ 两端被销毁，连接槽不泄漏', async () => {
  const { createServer: createUp } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { connect: netConnect } = await import('node:net');
  const upSockets = [];
  const up = createUp((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  up.on('upgrade', (req, socket) => {
    upSockets.push(socket);
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key'] ?? '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    heartbeat: false,
  });
  try {
    // 客户端：net 裸连接完成 WS 握手（不用 ws 库，方便直接发 FIN 而不发 close 帧）
    const client = await new Promise((resolve, reject) => {
      const sock = netConnect(proxy.port, '127.0.0.1', () => {
        sock.write(
          'GET /api/events.host HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('握手超时')); }, 3000);
      sock.on('data', (c) => {
        buf += c.toString('latin1');
        if (buf.includes('101')) { clearTimeout(timer); resolve(sock); }
      });
      sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.ok(upSockets.length >= 1, '上游已建立 WS 连接');

    // 浏览器直接关页：发 FIN（end），不发 WS close 帧
    const upstreamClosed = new Promise((resolve) => {
      upSockets[0].once('close', resolve);
      upSockets[0].once('error', () => resolve('error'));
    });
    client.end();
    const result = await Promise.race([upstreamClosed, new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
    assert.notEqual(result, 'timeout', '客户端 FIN 后上游连接被销毁（不再 half-open 悬挂）');

    // 代理仍可服务新请求（连接槽未泄漏）
    const res = await fetch(`http://127.0.0.1:${proxy.port}/after`);
    assert.equal(res.status, 200);
  } finally {
    try { await proxy.close(); } catch { /* 已关 */ }
    await new Promise((r) => up.close(r));
  }
});

test('WebSocket upgrade：原样透传（DSH 流式通道的前提）', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`, [], {
      headers: { Origin: 'http://whatever.trycloudflare.com' },
    });
    const reply = await new Promise((resolve, reject) => {
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
      ws.on('open', () => ws.send('ping'));
      setTimeout(() => reject(new Error('ws timeout')), 3000);
    });
    assert.equal(reply, 'echo:ping');
    ws.close();
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('WS 心跳（PR #41 / issue #29）：定期 Ping 保活；死链路（不回 Pong）missLimit 周期后被断开触发重连', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.port },
    heartbeat: { intervalMs: 100, missLimit: 3 },
  });
  try {
    // 1) 正常客户端（ws 库默认 autoPong 自动回 Pong）：持续收到协议层 Ping，连接保持可用
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`, [], { headers: { Origin: 'http://x' } });
    const pings = await new Promise((resolve, reject) => {
      let count = 0;
      ws.on('ping', () => count++);
      ws.on('open', () => setTimeout(() => resolve(count), 400)); // 等 4 个心跳周期
      ws.on('error', reject);
    });
    assert.ok(pings >= 2, `正常连接收到 Ping 帧（${pings}）`);
    // 心跳不影响透传：echo 仍正常
    const reply = await new Promise((resolve, reject) => {
      ws.on('message', (m) => resolve(String(m)));
      ws.on('error', reject);
      ws.send('hello');
      setTimeout(() => reject(new Error('echo timeout')), 2000);
    });
    assert.equal(reply, 'echo:hello', '心跳不影响透传');
    ws.close();

    // 2) 死链路（autoPong: false 不回 Pong、不发任何数据）→ missLimit 周期后被代理主动断开
    const dead = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`, [], { headers: { Origin: 'http://x' }, autoPong: false });
    const closed = await new Promise((resolve) => {
      dead.on('close', (code) => resolve(code));
      setTimeout(() => resolve('timeout'), 2000);
    });
    assert.notEqual(closed, 'timeout', '死链路被代理断开（触发浏览器端重连）');
    assert.equal(closed, 1006, 'close code 1006（异常关闭 → dsh-client-connection 重连）');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('上游未启动：返回 502 且给出提示', async () => {
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: 1 } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /无法连接上游 dsh web/);
  } finally {
    await proxy.close();
  }
});

test('WS 首帧（握手后立即发出，进 upgrade head）必须送达上游——回归：connection lost 根因', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const received = await new Promise((resolve, reject) => {
      const sock = connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          `GET /api/events.host HTTP/1.1\r\n` +
          `Host: whatever:3081\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` + // 规范 16 字节 key
          `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
        // 不等 101，立即发出首帧（浏览器就是这么干的）
        sock.write(maskedTextFrame('hello-head'));
      });
      let buf = '';
      const timer = setTimeout(() => reject(new Error('timeout waiting for echo')), 4000);
      sock.on('data', (chunk) => {
        buf += chunk.toString('latin1');
        // 上游把帧回显成 echo:hello-head（文本帧 payload 直接可读）
        if (buf.includes('hello-head')) {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        }
      });
      sock.on('error', reject);
    });
    assert.equal(received, true, '上游必须收到握手后立即发出的首帧');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('HTML 注入：非安全上下文 polyfill 只注入 HTML 文档，不碰 JS/CSS', async () => {
  // 假上游：HTML 文档 + JS 资源
  const up = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><head><title>x</title></head><body>app</body>');
    } else {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('console.log("asset");');
    }
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    const html = await (await fetch(`http://127.0.0.1:${proxy.port}/`)).text();
    assert.ok(html.includes('randomUUID'), 'HTML 注入 polyfill');
    assert.ok(html.indexOf('randomUUID') < html.indexOf('</head>'), '注入在 head 内、app 脚本之前');
    const js = await (await fetch(`http://127.0.0.1:${proxy.port}/app.js`)).text();
    assert.ok(!js.includes('randomUUID'), 'JS 资源不注入');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('会话指纹已移除（2.10.0）：页面与登录页不再注入指纹/access 标记（issue #82/#83 后续）', async () => {
  // 2.9.0 引入会话指纹防钓鱼、2.9.1 限制为仅公网生效；2.10.0 整体移除——
  // 钓鱼站不经本代理、跑不到我们的校验代码，自动拦截层是死代码；人工比对不现实。
  // 真正的防线仍是：公网强制密码（fail closed）+ PIN 每次开启轮换 + 登录限速 + 链接勿收藏提示。
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><head><title>x</title></head><body>app</body>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const TOKEN = 'ABCDE123';
  const SK = 'session-key';
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: SK },
  });
  try {
    const pub = (await getWithHost(proxy.port, 'abc.trycloudflare.com')).body;
    assert.ok(pub.includes('此公网地址'), '公网登录页正常');
    assert.ok(!pub.includes('dsh-pocket-session'), '不再注入会话指纹 meta');
    assert.ok(!pub.includes('dsh-pocket-access'), '不再注入访问类型标记');
    assert.ok(!pub.includes('会话指纹'), '登录页不再展示指纹');

    const lan = (await getWithHost(proxy.port, '192.168.1.100:3081')).body;
    assert.ok(lan.includes('此局域网地址'), '局域网登录页提示为局域网文案');
    assert.ok(!lan.includes('dsh-pocket-session'), '局域网也不含指纹 meta');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('压缩 HTML（gzip）解压后注入 polyfill——真实浏览器必经路径', async () => {
  // 宿主对声明 accept-encoding 的浏览器（Chrome 等）回 gzip HTML。旧实现跳过压缩响应不注入，
  // polyfill 与 transport shim 在真实浏览器上全部静默失效（curl 不发 accept-encoding 才注入）。
  // 现在先解压再注入、以未压缩回传（content-encoding 删除）。
  const zlib = await import('node:zlib');
  const http = await import('node:http');
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('<!doctype html><head></head><body>compressed-page</body>'));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    // 用原始 http.request（不带 accept-encoding，避免 undici 自动解压）拿真实字节
    const raw = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/', headers: { accept: 'text/html' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw.headers['content-encoding'], undefined, '压缩头已删除（以未压缩回传）');
    const text = raw.body.toString('utf8');
    assert.ok(text.includes('compressed-page'), '解压后内容完整');
    assert.ok(text.includes('data-dsh-pocket-polyfill'), 'polyfill 已注入解压后的 HTML');
    assert.ok(text.includes('data-dsh-pocket-transport-shim'), 'transport shim 已注入');
    assert.equal(raw.headers['cache-control'], 'no-store', '注入文档禁缓存');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('活动 WS 连接存在时 close 不挂起（closeAllConnections）', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  try {
    // 保持 WS 连接打开直接 close 代理——必须在 3s 内完成（server.close 本身会等连接，会挂）
    await Promise.race([
      proxy.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('proxy.close hung on active WS')), 3000)),
    ]);
  } finally {
    ws.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('WS upgrade 遇非 101 响应：客户端拿到状态行，不悬挂', async () => {
  const up = createServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    const got403 = await new Promise((resolve, reject) => {
      const sock = connect(proxy.port, '127.0.0.1', () => {
        sock.write(
          `GET /api/events.host HTTP/1.1\r\nHost: x:3081\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new Error('hang: upgrade 客户端没收到任何字节')); }, 3000);
      sock.on('data', (c) => {
        buf += c.toString('latin1');
        if (buf.includes('403')) {
          clearTimeout(timer);
          sock.destroy();
          resolve(true);
        }
      });
      sock.on('error', reject);
    });
    assert.equal(got403, true, '客户端收到 403 状态行而不是永久挂起');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('issue #76 回归：插件不再注入 dsh-desktop-* 标记（否则桌面端 2.0.3 会报「打开恢复模式」/403）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  // lib/index.js 组装 injectHtml 的地方不能再出现 desktopEnvPatchScript
  assert.ok(!/desktopEnvPatchScript\s*\(/.test(src), 'index.js 已不再注入桌面参数补丁');
  // 注入内容本身也不允许带 dsh-desktop- 前缀的标记
  const { DEFAULT_INJECT, advancedNoticeScript, desktopEnvPatchScript } = await import('../lib/proxy.mjs');
  const injected = DEFAULT_INJECT + advancedNoticeScript();
  assert.ok(!injected.includes('dsh-desktop-'), '默认注入内容不含桌面标记');
  assert.ok(desktopEnvPatchScript('win32').includes('dsh-desktop-mode'), '废弃的补丁函数本身仍保留（仅供旧版兼容）');
});

test('desktopEnvPatchScript：注入 dsh-desktop-mode/platform 参数补丁（issue #3/#4，已废弃见 issue #76）', async () => {
  const { desktopEnvPatchScript, DEFAULT_INJECT } = await import('../lib/proxy.mjs');
  const patch = desktopEnvPatchScript('darwin');
  assert.ok(patch.includes("dsh-desktop-mode"), '补 mode 参数');
  assert.ok(patch.includes("'compatibility'"), '用最轻的 compatibility 模式（不套桌面布局）');
  assert.ok(patch.includes("dsh-desktop-platform"), '补 platform 参数');
  assert.ok(patch.includes("'darwin'"), '平台来自宿主');
  assert.ok(patch.includes('history.replaceState'), '无跳转 replaceState');
  assert.ok(DEFAULT_INJECT.includes('randomUUID'), '默认 polyfill 保留');
  // 非法平台回退 linux
  const fallback = desktopEnvPatchScript('weirdos');
  assert.ok(fallback.includes("'linux'"), '非法平台回退 linux');
});

test('压缩：大 JSON 响应流式 gzip（客户端解压内容一致）；SSE 与已压缩不重复压', async () => {
  const zlib = await import('node:zlib');
  const big = JSON.stringify({ items: Array.from({ length: 20000 }, (_, i) => ({ id: i, text: 'x'.repeat(50) })) });
  const up = createServer((req, res) => {
    if (req.url === '/api/session.history') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(big);
    } else if (req.url === '/api/events.host') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: hello\n\n');
    } else if (req.url === '/precompressed') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(big));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain');
    }
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    // 1) 大 JSON + Accept-Encoding: gzip → 被压缩且内容一致（用原始 http 请求，
    //    避免 undici 自动解压干扰对 gzip 字节的断言）
    const http = await import('node:http');
    const raw1 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/api/session.history', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw1.headers['content-encoding'], 'gzip', '响应被 gzip');
    assert.ok(raw1.body[0] === 0x1f && raw1.body[1] === 0x8b, 'gzip 魔数');
    assert.equal(zlib.gunzipSync(raw1.body).toString('utf8'), big, '解压后内容一致');

    // 2) SSE 不压缩
    const r2 = await fetch(`http://127.0.0.1:${proxy.port}/api/events.host`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r2.headers.get('content-encoding'), null, 'SSE 原样透传');
    assert.ok((await r2.text()).includes('data: hello'), 'SSE 内容完整');

    // 3) 上游已压缩 → 不重复压（原始请求避免 undici 自动解压）
    const raw3 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/precompressed', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw3.headers['content-encoding'], 'gzip', '已压缩不重复压');
    assert.equal(zlib.gunzipSync(raw3.body).toString('utf8'), big, '上游 gzip 内容一致');

    // 4) 无 Accept-Encoding → 不压缩（原始请求，undici fetch 会自动加 gzip）
    const raw4 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/api/session.history' }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw4.headers['content-encoding'], undefined, '无 Accept-Encoding 不压缩');
    assert.equal(raw4.body.toString('utf8'), big, '明文透传');

    // 5) Accept-Encoding: gzip, br → 优先 brotli（quality 6），可解压且内容一致
    const raw5 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/api/session.history', headers: { 'Accept-Encoding': 'gzip, br' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(raw5.headers['content-encoding'], 'br', 'br 优先于 gzip');
    assert.ok(!(raw5.body[0] === 0x1f && raw5.body[1] === 0x8b), '不是 gzip 字节');
    assert.equal(zlib.brotliDecompressSync(raw5.body).toString('utf8'), big, 'brotli 解压后内容一致');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('访问令牌认证（issue #13）：公网需登录、cookie 放行、局域网免密码、WS 校验', async () => {
  // fetch 不能设置 Host 头（forbidden header）→ 全部用原始 http.request
  const http = await import('node:http');
  const TOKEN = '12345678';
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: {
      getToken: () => TOKEN,
      getCredentialKind: (host) => String(host).includes('trycloudflare') ? 'ephemeral' : 'persistent',
      isProtected: () => true,
    },
  });
  const raw = (headers, method = 'GET', body, path = '/') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const publicH = { Host: 'abc.trycloudflare.com', Accept: 'text/html' };
  const lanH = { Host: '192.168.1.50:3081', Accept: 'text/html' };

  // 1) 公网无 cookie → 登录页
  const r1 = await raw(publicH);
  assert.equal(r1.status, 200);
  assert.ok(r1.body.includes('访问密码'), '返回登录页');
  assert.match(r1.body, /minlength="8" maxlength="64"/, '登录页允许输入 8–64 位自定义 PIN');
  // 短期轮换 PIN（Quick Tunnel 自动 PIN）不请求密码管理器保存
  assert.match(r1.body, /id="current-password"[^>]+autocomplete="off"/, '短期轮换 PIN 不请求密码管理器保存');
  assert.doesNotMatch(r1.body, /autocomplete="username"/, '短期轮换 PIN 不伪装成可保存的完整登录项');
  assert.match(r1.body, /for="current-password"/, '登录页为密码输入框提供关联 label');
  assert.match(r1.body, /type="button"[^>]+aria-controls="current-password"/, '显示密码按钮不会误提交表单且具备可访问语义');
  assert.match(r1.body, /id="eye-icon"[^>]+aria-hidden="true"/, '显示密码按钮使用装饰性眼睛图标');
  assert.match(r1.body, /id="eye-slash"/, '密码默认隐藏时眼睛带斜线');
  assert.match(r1.body, /eyeSlash\.classList\.toggle\('is-hidden',show\)/, '切换时用 SVG 支持的 classList 改变斜线状态');
  assert.match(r1.body, /padding:10px 50px;font-size:18px;line-height:24px;letter-spacing:6px;text-align:center;caret-color:/, '保留社区 PIN 字距与居中风格，同时为眼睛图标对称留位');
  assert.match(r1.body, /setSelectionRange\(start,end\)/, '显示与隐藏切换时保留光标选区');
  assert.match(r1.body, /pointerdown[^\n]+preventDefault/, '指针切换显示状态时不抢走输入框焦点');

  // 2) 公网 API 无 cookie → 401（非 HTML 路径）
  const r2 = await raw({ ...publicH, Accept: 'application/json' }, 'GET', undefined, '/api/hello');
  assert.equal(r2.status, 401, 'API 未认证 401');

  // 3) 错误密码 → 登录页带错误提示
  const r3 = await raw({ ...publicH, 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 'token=00000000', '/pocket-login');
  assert.ok(r3.body.includes('密码错误'), '错误密码提示');

  // 4) 正确密码 → Set-Cookie + 302
  const r4 = await raw({ ...publicH, 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 'token=' + TOKEN, '/pocket-login');
  assert.equal(r4.status, 302, '正确密码重定向');
  const sc = (r4.headers['set-cookie'] || []).join(';');
  assert.ok(sc.includes('dsh_pocket_token=' + TOKEN), '种 HttpOnly cookie');
  assert.ok(sc.includes('HttpOnly'), 'HttpOnly');

  // 5) 带 cookie → 放行
  const r5 = await raw({ Host: 'abc.trycloudflare.com', Accept: 'application/json', Cookie: 'dsh_pocket_token=' + TOKEN });
  assert.equal(r5.status, 200, '带 cookie 放行');
  assert.ok(r5.body.includes('dsh'), '内容正常');

  // 6) 局域网 Host → 也要密码（issue #18：局域网统一密码保护）
  const r6 = await raw(lanH);
  assert.equal(r6.status, 200);
  assert.ok(r6.body.includes('访问密码'), '局域网也需要密码（登录页）');
  // 长期有效 PIN（LAN / Named / 自定义公网）允许密码管理器保存与填充
  assert.match(r6.body, /id="current-password"[^>]+autocomplete="current-password"/, '长期有效的 LAN PIN 允许密码管理器填充');
  assert.match(r6.body, /id="pocket-username"[^>]+autocomplete="username"[^>]+value="dsh-pocket"/, '固定 PIN 提供稳定的隐式账号供密码管理器关联');
  // 局域网带 cookie → 放行
  const r6b = await raw({ ...lanH, Cookie: 'dsh_pocket_token=' + TOKEN });
  assert.equal(r6b.status, 200, '局域网带 cookie 放行');

  // 7) WS：未认证 → 拒绝
  const wsOk = await new Promise((resolve) => {
    const sock = connect(proxy.port, '127.0.0.1', () => {
      sock.write(
        'GET /api/events.host HTTP/1.1\r\nHost: abc.trycloudflare.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve('timeout'); }, 2000);
    sock.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('101') || buf.includes('401')) { clearTimeout(timer); sock.destroy(); resolve(buf.includes('101') ? 'ok' : 'denied'); }
    });
    sock.on('error', () => { clearTimeout(timer); resolve('denied'); });
  });
  assert.equal(wsOk, 'denied', 'WS 未认证被拒');

  await proxy.close();
  await new Promise((r) => up.close(r));
});

test('WS 认证 fail-closed（issue #66 的 WS 版）：取不到 PIN 时受保护 Host 必须 5xx，不能 101', async () => {
  const up = createServer((_req, res) => res.end('upstream'));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  // getToken 返回 null 模拟「PIN 文件读失败」：HTTP 侧 503 fail-closed，
  // WS 侧旧实现 `token && !wsAuth.ok` 会整段跳过鉴权直接 101 放行。
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => null, isProtected: () => true },
  });
  try {
    const line = await new Promise((resolve) => {
      const sock = connect(proxy.port, '127.0.0.1', () => {
        sock.write('GET /api/events.mux HTTP/1.1\r\nHost: abc.trycloudflare.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); resolve('timeout'); }, 2000);
      sock.on('data', (c) => {
        buf += c.toString('latin1');
        if (buf.includes('\r\n')) { clearTimeout(timer); sock.destroy(); resolve(buf.split('\r\n')[0]); }
      });
      sock.on('error', () => { clearTimeout(timer); resolve('error'); });
    });
    assert.doesNotMatch(line, /101/, 'WS 不得在缺少 PIN 时放行');
    assert.match(line, /50[0-9]/, `WS 应 fail-closed（实得 ${line}）`);
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('来源分级头由代理重写（客户端伪造无效）；带 ?token= 的 HTML 注入地址栏清理脚本', async () => {
  const TOKEN = '12345678';
  const seen = [];
  const up = createServer((req, res) => {
    seen.push({ url: req.url, origin: req.headers['x-dsh-pocket-origin'] });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head></head><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true },
  });
  try {
    // 公网 Host + 客户端自称 loopback：代理必须按源地址判成 public。
    const r = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path: `/?token=${TOKEN}`, headers: { Host: 'abc.trycloudflare.com', Accept: 'text/html', 'x-dsh-pocket-origin': 'loopback' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.status, 200);
    assert.equal(seen[0].origin, 'public', '入站伪造的 x-dsh-pocket-origin 被丢弃，按源地址重写');
    assert.doesNotMatch(seen[0].url, new RegExp(TOKEN), '明文 PIN 不进入上游请求行');
    assert.match(r.body, /data-dsh-pocket-token-scrub="1"/, 'HTML 注入地址栏清理脚本');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('会话保持（issue #33）：登录 cookie 绑定进程 sessionKey，持久 30 天；重启后旧 cookie 失效需重新输入', async () => {
  const http = await import('node:http');
  const { createHash } = await import('node:crypto');
  const TOKEN = '12345678';
  const SK1 = 'session-key-one';
  const SK2 = 'session-key-two';
  const cookieOf = (pin, sk) => createHash('sha256').update(`${pin}:${sk}`).digest('hex');
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: SK1 },
  });
  const makeRaw = (p) => (headers, method = 'GET', body, path = '/') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  try {
    const raw = makeRaw(proxy.port);
    // 1) 登录 → cookie 派生绑定 sessionKey，且带 Max-Age（持久 30 天）
    const r1 = await raw({ Host: 'abc.trycloudflare.com', 'Content-Type': 'application/x-www-form-urlencoded' }, 'POST', 'token=' + TOKEN, '/pocket-login');
    assert.equal(r1.status, 302, '登录成功');
    const sc = (r1.headers['set-cookie'] || []).join(';');
    assert.ok(sc.includes('dsh_pocket_token=' + cookieOf(TOKEN, SK1)), 'cookie 绑定 sessionKey 派生');
    assert.ok(sc.includes('Max-Age=2592000'), '持久 cookie（30 天）');
    assert.ok(sc.includes('HttpOnly'), 'HttpOnly');

    // 2) 带派生 cookie → 放行
    const r2 = await raw({ Host: 'abc.trycloudflare.com', Accept: 'application/json', Cookie: 'dsh_pocket_token=' + cookieOf(TOKEN, SK1) }, 'GET', undefined, '/api/hello');
    assert.equal(r2.status, 200, '正确 cookie 放行');

    // 3) 旧格式 cookie（= PIN 本身）不再放行（升级后旧登录失效，需重新输入）
    const r3 = await raw({ Host: 'abc.trycloudflare.com', Accept: 'application/json', Cookie: 'dsh_pocket_token=' + TOKEN }, 'GET', undefined, '/api/hello');
    assert.equal(r3.status, 401, '裸 PIN cookie 已失效');

    // 4) 模拟 dsh web 重启（新 sessionKey）→ 旧 cookie 失效，需重新登录；新会话 cookie 放行
    await proxy.close();
    const proxy2 = await createPocketProxy({
      port: 0, host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: up.address().port },
      auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: SK2 },
    });
    try {
      const raw2 = makeRaw(proxy2.port);
      const r4 = await raw2({ Host: 'abc.trycloudflare.com', Accept: 'application/json', Cookie: 'dsh_pocket_token=' + cookieOf(TOKEN, SK1) }, 'GET', undefined, '/api/hello');
      assert.equal(r4.status, 401, '重启后旧 cookie 失效（需重新输入）');
      const r5 = await raw2({ Host: 'abc.trycloudflare.com', Accept: 'application/json', Cookie: 'dsh_pocket_token=' + cookieOf(TOKEN, SK2) }, 'GET', undefined, '/api/hello');
      assert.equal(r5.status, 200, '新会话 cookie 放行');
    } finally {
      await proxy2.close();
    }
  } finally {
    await proxy.close().catch(() => {});
    await new Promise((r) => up.close(r));
  }
});

test('访问令牌按 Host 区分（issue #24）：局域网开关关闭 → 免密直连；公网始终要密码', async () => {
  const http = await import('node:http');
  const TOKEN = '12345678';
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  // 模拟 lanAuthEnabled=false 时的 isProtected：公网永远保护，局域网不保护
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: (host) => /trycloudflare\.com$/i.test(String(host ?? '')) },
  });
  const raw = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    // 1) 局域网（非公网域名）无 cookie → 直接放行（免密直连）
    const lan = await raw({ Host: '192.168.1.50:3081', Accept: 'text/html' });
    assert.equal(lan.status, 200);
    assert.ok(lan.body.includes('<html>'), '局域网内容直达，无登录页');

    // 2) 公网域名无 cookie → 仍要登录页（公网不受开关影响）
    const pub = await raw({ Host: 'abc.trycloudflare.com', Accept: 'text/html' });
    assert.equal(pub.status, 200);
    assert.ok(pub.body.includes('访问密码'), '公网仍返回登录页');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('局域网访问总开关：关闭后拦截局域网 Host（403 提示页），loopback 与公网放行', async () => {
  const http = await import('node:http');
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));

  let lanOn = true;
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    lanAccessEnabled: () => lanOn,
  });
  const raw = (host, accept = 'text/html', path = '/') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, path, headers: { Host: host, Accept: accept } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    // 1) 开启：局域网 Host 正常放行
    const on = await raw('192.168.1.50:3081');
    assert.equal(on.status, 200, '开启时局域网放行');
    assert.ok(on.body.includes('dsh'), '内容正常');

    // 2) 关闭：局域网 Host 被拦截（浏览器导航 → 403 提示页）
    lanOn = false;
    const off = await raw('192.168.1.50:3081');
    assert.equal(off.status, 403, '关闭时局域网拒绝');
    assert.ok(off.body.includes('局域网访问已关闭'), '返回提示页');

    // 3) 关闭：局域网 API 路径 → 403 JSON
    const offApi = await raw('192.168.1.50:3081', 'application/json', '/api/hello');
    assert.equal(offApi.status, 403, 'API 返回 403');
    assert.equal(offApi.body, '{"error":"lan-disabled"}', 'JSON 错误体');

    // 4) 关闭：loopback 与公网（trycloudflare）不受影响
    const loop = await raw('127.0.0.1:3081');
    assert.equal(loop.status, 200, 'loopback 放行');
    const pub = await raw('abc.trycloudflare.com');
    assert.equal(pub.status, 200, '公网放行');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('登录速率限制（issue #40 改进版 A）：单 IP 失败达阈值锁、429 + 提示；cf-connecting-ip 独立计数；成功清空；全局锁', async () => {
  const http = await import('node:http');
  const TOKEN = '12345678';
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const makeProxy = (rateLimit) => createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true },
    rateLimit,
  });
  const makeLogin = (p) => (ip, pin) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: p, method: 'POST', path: '/pocket-login',
      headers: { Host: 'abc.trycloudflare.com', 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write('token=' + pin);
    req.end();
  });

  // --- 实例 1：单 IP 锁（3 次/5 秒），全局阈值拉高避免干扰 ---
  const proxy = await makeProxy({ windowMs: 60_000, maxFailures: 3, lockMs: 5_000, globalMaxFailures: 100, globalLockMs: 3_000 });
  const login = makeLogin(proxy.port);
  try {
    // 1) IP-A 连续失败 3 次 → 锁定：第 4 次 429 + retry-after + 锁定文案
    for (let i = 0; i < 3; i++) {
      const r = await login('10.0.0.1', '00000000');
      assert.equal(r.status, 200, `第 ${i + 1} 次失败返回登录页`);
      assert.ok(r.body.includes('密码错误'), '错误提示');
    }
    const r4 = await login('10.0.0.1', '00000000');
    assert.equal(r4.status, 429, '超过阈值被锁 429');
    assert.ok(String(r4.headers['retry-after'] ?? '').length > 0, '带 retry-after');
    assert.ok(r4.body.includes('尝试次数过多'), '锁定提示文案');

    // 2) 不同 cf-connecting-ip 独立计数：IP-B 不受 IP-A 锁影响，可正常尝试
    const rb1 = await login('10.0.0.2', '00000000');
    assert.equal(rb1.status, 200, 'IP-B 未被连坐');

    // 3) 成功登录清空该 IP 计数：IP-C 失败 2 次 → 正确密码成功 → 再失败 3 次才锁
    await login('10.0.0.3', '00000000');
    await login('10.0.0.3', '00000000');
    const rcOk = await login('10.0.0.3', TOKEN);
    assert.equal(rcOk.status, 302, '正确密码登录成功');
    for (let i = 0; i < 2; i++) {
      const r = await login('10.0.0.3', '00000000');
      assert.equal(r.status, 200, '清空后重新计数（前 2 次失败不锁）');
    }
    const rc3 = await login('10.0.0.3', '00000000');
    assert.equal(rc3.status, 200, '第 3 次失败触发锁（本次响应仍为错误提示）');
    const rc4 = await login('10.0.0.3', '00000000');
    assert.equal(rc4.status, 429, '清空后累计 3 次失败，下次请求被锁');
  } finally {
    await proxy.close();
  }

  // --- 实例 2：全局锁（3 次/3 秒）——分布式扫描（换 IP）也会被全局阈值拦下 ---
  const proxy2 = await makeProxy({ windowMs: 60_000, maxFailures: 99, lockMs: 5_000, globalMaxFailures: 3, globalLockMs: 3_000 });
  const login2 = makeLogin(proxy2.port);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await login2(`10.1.0.${i + 1}`, '00000000');
      assert.equal(r.status, 200, `全局第 ${i + 1} 次失败正常`);
    }
    const r3 = await login2('10.1.0.99', '00000000'); // 第 3 个不同 IP → 触发全局锁（本次响应仍为错误提示）
    assert.equal(r3.status, 200, '全局第 3 次失败触发锁');
    const r4 = await login2('10.1.0.100', '00000000'); // 新 IP → 被全局锁拦下
    assert.equal(r4.status, 429, '新 IP 也被全局锁拦截（防换 IP 绕过）');
    assert.ok(r4.body.includes('尝试次数过多'), '全局锁提示');
    // 全局锁不能变成永久 DoS：攻击者 50 次坏 PIN 后，持有正确密码的机主/新设备
    // 仍然必须能登录（旧实现连正确密码也一起 429，只有 trustedIps 例外）。
    const r5 = await login2('10.1.0.101', TOKEN);
    assert.equal(r5.status, 302, '全局锁期间正确密码仍可登录');
  } finally {
    await proxy2.close();
    await new Promise((r) => up.close(r));
  }
});

test('并发登录请求在读取 body 后重新检查限速，不能批量穿透失败阈值', async () => {
  const up = createServer((_req, res) => res.end('ok'));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => '87654321', isProtected: () => true, sessionKey: 'test-session-key' },
    rateLimit: { windowMs: 60_000, maxFailures: 3, lockMs: 60_000, globalMaxFailures: 3, globalLockMs: 60_000 },
  });
  try {
    const pending = Array.from({ length: 20 }, (_, index) => {
      let submit;
      const response = new Promise((resolve, reject) => {
        const body = `token=${String(index).padStart(8, '0')}`;
        const req = httpRequest({
          host: '127.0.0.1',
          port: proxy.port,
          path: '/pocket-login',
          method: 'POST',
          headers: {
            host: 'abc.trycloudflare.com',
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
            'cf-connecting-ip': '10.2.0.1',
          },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.flushHeaders();
        submit = () => req.end(body);
      });
      return { response, submit: () => submit() };
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const request of pending) request.submit();
    const statuses = await Promise.all(pending.map((request) => request.response));

    assert.equal(statuses.filter((status) => status === 200).length, 3, '只有阈值内的请求执行密码比较');
    assert.equal(statuses.filter((status) => status === 429).length, 17, '其余并发请求在比较前被锁定');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('issue #90：?token= 与 WS 的密码尝试同样计入限速（堵掉可绕开登录限速的无限穷举通道）', async () => {
  const TOKEN = '12345678';
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: 'k' },
    rateLimit: { windowMs: 60_000, maxFailures: 3, lockMs: 5_000, globalMaxFailures: 100, globalLockMs: 3_000 },
  });

  /** 以 ?token= 猜一次密码（模拟扫码/分享链接直达的那条通道）。 */
  const guess = (ip, pin, path = null) => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxy.port, method: 'GET',
      path: path ?? `/?token=${pin}`,
      headers: { Host: 'abc.trycloudflare.com', 'cf-connecting-ip': ip },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });

  /** 发起一次 WS upgrade，返回状态行。 */
  const wsGuess = (ip, pin) => new Promise((resolve, reject) => {
    const sock = connect(proxy.port, '127.0.0.1', () => {
      sock.write(
        `GET /api/events.mux?token=${pin} HTTP/1.1\r\nHost: abc.trycloudflare.com\r\n`
        + `cf-connecting-ip: ${ip}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = '';
    sock.on('data', (c) => { buf += c.toString('utf8'); });
    sock.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
    sock.on('error', reject);
    setTimeout(() => sock.destroy(), 500);
  });

  try {
    // 1) 无凭据的普通访问不算密码尝试——否则正常用户第一次打开就会把自己锁死
    for (let i = 0; i < 6; i++) {
      const r = await guess('10.9.0.1', '', '/');
      assert.equal(r.status, 200, '未带凭据只是看到登录页');
      assert.ok(!r.body.includes('尝试次数过多'), `第 ${i + 1} 次无凭据访问不应计入失败`);
    }

    // 2) ?token= 猜错要计数：3 次后锁定（此前这条通道完全不计数，可全速穷举）
    for (let i = 0; i < 3; i++) {
      const r = await guess('10.9.0.2', '00000000');
      assert.equal(r.status, 200, `第 ${i + 1} 次猜错返回登录页`);
    }
    const locked = await guess('10.9.0.2', '00000000');
    assert.ok(locked.body.includes('尝试次数过多'), '?token= 猜错达阈值后被锁');

    // 3) 锁定期内即使给对了密码也不放行——否则锁定窗口本身就是免费穷举窗口
    const lockedButRight = await guess('10.9.0.2', TOKEN);
    assert.ok(lockedButRight.body.includes('尝试次数过多'), '锁定期内不再比对密码');
    assert.ok(
      !(lockedButRight.headers['set-cookie'] ?? []).toString().includes('dsh_pocket_token'),
      '锁定期内不得种认证 cookie',
    );

    // 4) 非 HTML 请求（API 子资源）在锁定期给 429 + retry-after，便于客户端退避
    const apiLocked = await guess('10.9.0.2', '00000000', `/api/x?token=00000000`);
    assert.equal(apiLocked.status, 429, '锁定期 API 请求 429');
    assert.ok(String(apiLocked.headers['retry-after'] ?? '').length > 0, '带 retry-after');

    // 5) 正确的 ?token= 直达要清空计数（分享链接的正常用法不应逐步累积到锁定）
    await guess('10.9.0.3', '00000000');
    await guess('10.9.0.3', '00000000');
    const ok = await guess('10.9.0.3', TOKEN);
    assert.ok(
      (ok.headers['set-cookie'] ?? []).toString().includes('dsh_pocket_token'),
      '正确 ?token= 放行并种 cookie',
    );
    // 清空的证据：又要重新累计 3 次才锁（前 2 次仍是普通错误提示）
    for (let i = 0; i < 2; i++) {
      const r = await guess('10.9.0.3', '00000000');
      assert.ok(!r.body.includes('尝试次数过多'), `成功后计数已清空，第 ${i + 1} 次失败不锁`);
    }
    const relocked = await guess('10.9.0.3', '00000000');
    assert.ok(relocked.body.includes('尝试次数过多'), '重新累计到阈值才锁');

    // 6) WS 通道的 token 猜测同样计数（否则换到 WS 上继续无限穷举）
    for (let i = 0; i < 3; i++) {
      const line = await wsGuess('10.9.0.4', '00000000');
      assert.ok(line.includes('401'), `WS 第 ${i + 1} 次猜错 401`);
    }
    const wsLocked = await wsGuess('10.9.0.4', '00000000');
    assert.ok(wsLocked.includes('429'), 'WS 猜错达阈值后被锁 429');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('issue #90：Host 头不可再伪造成本机——用 TCP 源地址给声明设下限（只收紧不放松）', async () => {
  const { policyHost, classifySource } = await import('../lib/proxy.mjs');
  const reqFrom = (addr) => ({ socket: { remoteAddress: addr } });

  // --- 源地址分类：认不出的形态一律按公网兜底（fail closed） ---
  assert.equal(classifySource('127.0.0.1'), 'loopback');
  assert.equal(classifySource('::1'), 'loopback');
  assert.equal(classifySource('::ffff:127.0.0.1'), 'loopback', 'IPv4-mapped IPv6 要先归一化');
  assert.equal(classifySource('192.168.1.9'), 'lan');
  assert.equal(classifySource('::ffff:192.168.1.9'), 'lan');
  assert.equal(classifySource('100.101.1.2'), 'lan', 'CGNAT/Tailscale 段算局域网');
  assert.equal(classifySource('169.254.1.2'), 'lan', 'IPv4 link-local');
  assert.equal(classifySource('fe80::1'), 'lan');
  assert.equal(classifySource('203.0.113.9'), 'public');
  assert.equal(classifySource('2001:db8::1'), 'public', '全局 IPv6 源不能被当成本机');
  assert.equal(classifySource(''), null, '拿不到源地址 → 不做收紧');
  assert.equal(classifySource(undefined), null);

  // --- 攻击面：伪造 Host 冒充本机，被源地址拆穿 ---
  assert.equal(
    policyHost(reqFrom('192.168.1.9'), '127.0.0.1:3081'), '192.168.1.9',
    '局域网直连伪造 Host: 127.0.0.1 → 按局域网判定（此前会被当成本机免密）',
  );
  assert.equal(
    policyHost(reqFrom('192.168.1.9'), 'localhost:3081'), '192.168.1.9',
    'Host: localhost 同样不可信',
  );
  assert.equal(
    policyHost(reqFrom('203.0.113.9'), '127.0.0.1:3081'), '203.0.113.9',
    '公网直连伪造本机 Host → 按公网判定（强制公网密码）',
  );
  assert.equal(
    policyHost(reqFrom('203.0.113.9'), '192.168.1.5:3081'), '203.0.113.9',
    '公网直连伪造私网 Host → 收紧到公网',
  );

  // --- 只收紧不放松：cloudflared 从 127.0.0.1 回连，不能把公网降级成本机免密 ---
  assert.equal(
    policyHost(reqFrom('127.0.0.1'), 'abc.trycloudflare.com'), 'abc.trycloudflare.com',
    '经隧道进来的公网请求源地址就是 127.0.0.1，绝不能因此降级',
  );
  assert.equal(
    policyHost(reqFrom('127.0.0.1'), 'pocket.example.com'), 'pocket.example.com',
    '自建命名隧道同理',
  );
  assert.equal(
    policyHost(reqFrom('192.168.1.9'), 'pocket.example.com'), 'pocket.example.com',
    '局域网源 + 公网 Host（前置反代场景）保持公网判定，不放松',
  );

  // --- 声明与来源一致时原样透传（含用户手动设置的「局域网地址」覆盖不受影响） ---
  assert.equal(policyHost(reqFrom('127.0.0.1'), '127.0.0.1:3081'), '127.0.0.1:3081');
  assert.equal(policyHost(reqFrom('192.168.1.9'), '192.168.1.5:3081'), '192.168.1.5:3081');
  assert.equal(
    policyHost(reqFrom(''), '127.0.0.1:3081'), '127.0.0.1:3081',
    '拿不到源地址时保持原有行为，不误伤',
  );
});

test('issue #90：HTTP 与 WS 两条入口都必须走 policyHost，不能只改一边', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/proxy.mjs', import.meta.url), 'utf8');
  const wired = src.match(/policyHost\(req, String\(req\.headers\.host \?\? ''\)\)/g) ?? [];
  assert.equal(wired.length, 2, 'createServer 与 server.on("upgrade") 各一处');
  assert.ok(
    !/const host = String\(req\.headers\.host \?\? ''\);/.test(src),
    '不得再有直接把原始 Host 头当策略依据的入口',
  );
});

test('advancedNoticeScript：注入 advanced 模式提示覆盖层（issue #19）', async () => {
  const { advancedNoticeScript } = await import('../lib/proxy.mjs');
  const s = advancedNoticeScript();
  assert.ok(s.includes('dsh-pocket-advanced-notice'), '有标记');
  assert.ok(s.includes('advanced'), '提示 advanced');
  assert.ok(s.includes('compatibility'), '提示切回 compatibility');
  assert.ok(s.includes('position:fixed'), '固定覆盖层（白屏也能看到）');
});

// ---------- Host 信任边界（issue #66：fail closed） ----------

test('classifyHost（issue #66）：loopback/私网归类，陌生域名一律 public（fail closed）', async () => {
  const { classifyHost } = await import('../lib/proxy.mjs');
  // loopback：本机与 cloudflared 回连
  assert.equal(classifyHost('localhost'), 'loopback');
  assert.equal(classifyHost('localhost:3081'), 'loopback');
  assert.equal(classifyHost('127.0.0.1'), 'loopback');
  assert.equal(classifyHost('127.0.0.1:3081'), 'loopback');
  assert.equal(classifyHost('[::1]:3081'), 'loopback');
  assert.equal(classifyHost('0.0.0.0'), 'loopback');
  assert.equal(classifyHost(''), 'loopback');
  // lan：RFC1918 私网 / IPv6 ULA / mDNS / NetBIOS 单标签名
  assert.equal(classifyHost('192.168.1.5:3081'), 'lan');
  assert.equal(classifyHost('10.0.0.2'), 'lan');
  assert.equal(classifyHost('172.16.3.4'), 'lan');
  assert.equal(classifyHost('172.32.1.1'), 'public', '172.32 不在 RFC1918 范围');
  // lan：CGNAT 100.64/10（RFC 6598，Tailscale/ZeroTier 默认网段，issue #79）
  assert.equal(classifyHost('100.64.0.1'), 'lan');
  assert.equal(classifyHost('100.127.255.254:3081'), 'lan');
  assert.equal(classifyHost('100.63.0.1'), 'public', '100.63 不在 100.64/10 范围');
  assert.equal(classifyHost('100.128.0.1'), 'public', '100.128 不在 100.64/10 范围');
  assert.equal(classifyHost('fd00::5'), 'lan');
  assert.equal(classifyHost('fe80::1%en0'), 'lan');
  assert.equal(classifyHost('mypc.local'), 'lan');
  assert.equal(classifyHost('DESKTOP-ABC123'), 'lan');
  // public：trycloudflare 及一切陌生域名（自建命名隧道固定域名）→ 强制公网密码
  assert.equal(classifyHost('abc-def-hij.trycloudflare.com'), 'public');
  assert.equal(classifyHost('pocket.example.com'), 'public');
  assert.equal(classifyHost('random.host.org'), 'public');
});

// ---------- dsh web 浏览器会话 token（issue #77） ----------

test('upstreamPathWithLaunchToken（issue #77）：首屏根路径补 token，已有 cookie / 非根路径不补（防 303 循环）', async () => {
  const { upstreamPathWithLaunchToken } = await import('../lib/proxy.mjs');
  const TOK = 'abcDEF123-_launch-token';
  // 首屏：GET / 且没有 dsh-auth cookie → 补 token
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', undefined, TOK), `/?token=${TOK}`, '根路径补 token');
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', 'other=1', TOK), `/?token=${TOK}`, '无会话 cookie 也补');
  assert.equal(upstreamPathWithLaunchToken('/?x=1', 'GET', undefined, TOK), `/?x=1&token=${TOK}`, '保留原有 query');
  // 已有会话 cookie → 不补（否则上游 303 会死循环）
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', 'dsh-auth-abc=xyz', TOK), '/', '有会话 cookie 不补');
  // 非根路径 / 非 GET → 不补
  assert.equal(upstreamPathWithLaunchToken('/api/events.mux', 'GET', undefined, TOK), '/api/events.mux', 'API 路径不补');
  assert.equal(upstreamPathWithLaunchToken('/', 'POST', undefined, TOK), '/', '非 GET 不补');
  // 老版本 dsh（无 token）→ 原样转发
  assert.equal(upstreamPathWithLaunchToken('/', 'GET', undefined, ''), '/', '无 token 时原样');
  // 登录成功后的强制握手标记：即使带着旧 cookie 也重做一次（cookie 可能已过期/被撤销）
  assert.equal(upstreamPathWithLaunchToken('/?dsh-pocket-auth=1', 'GET', 'dsh-auth-abc=1', TOK),
    `/?dsh-pocket-auth=1&token=${TOK}`, '带强制标记时无视旧 cookie');
});

// ---------- 清理历史遗留的 dsh-desktop-* 参数（issue #75） ----------

test('stripDesktopMarkers（issue #75）：URL 上的 dsh-desktop-* 参数全部清掉，其余原样', async () => {
  const { stripDesktopMarkers } = await import('../lib/proxy.mjs');
  // 2.1.1 及更早注入、被 history.replaceState 写进 URL 的那两个
  assert.equal(
    stripDesktopMarkers('/?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32'),
    '/',
    '清掉注入的 mode/platform',
  );
  // 只清 dsh-desktop- 前缀，别的参数一个都不能动
  assert.equal(
    stripDesktopMarkers('/?a=1&dsh-desktop-mode=compatibility&b=2'),
    '/?a=1&b=2',
    '保留其他 query 参数',
  );
  assert.equal(
    stripDesktopMarkers('/api/events.mux?dsh-desktop-material=mica&x=9'),
    '/api/events.mux?x=9',
    'API / WS 握手路径同样清理（不只对 GET / 生效）',
  );
  // 五个标记齐备也要清——上游 decideDesktopBrowserAccess 见到前缀就 403
  assert.equal(
    stripDesktopMarkers(
      '/?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-material=mica&dsh-desktop-version=2.0.3&dsh-desktop-mica=1',
    ),
    '/',
    '整组标记一律清掉',
  );
  // 无该前缀参数时原样返回（不重写 URL，避免把 %20 之类改写得不一样）
  assert.equal(stripDesktopMarkers('/?x=1'), '/?x=1', '无目标参数时原样返回');
  assert.equal(stripDesktopMarkers('/'), '/', '无 query 时原样返回');
  assert.equal(stripDesktopMarkers(undefined), undefined, '非法输入不抛错');
});

test('端到端（issue #75）：代理转发前清掉 dsh-desktop-*，上游拿到的是干净路径', async () => {
  const http = await import('node:http');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head></head><body>ok</body></html>');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { createPocketProxy } = await import('../lib/proxy.mjs');
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
  });
  try {
    for (const p of [
      '/?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32',
      '/api/events.mux?dsh-desktop-material=mica',
    ]) {
      const res = await fetch(`http://127.0.0.1:${proxy.port}${p}`);
      await res.text();
    }
    assert.deepEqual(
      seen.map((s) => s.url),
      ['/', '/api/events.mux'],
      '上游收到的路径里不应再有 dsh-desktop-* 参数',
    );
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('端到端（issue #77 + #91）：代理自动补 token 完成会话握手——首屏过渡页下发 cookie，之后正常返回首页', async () => {
  const http = await import('node:http');
  const TOK = 'launch-token-abc123';
  const seen = [];
  // 模拟新版 dsh web 的浏览器会话认证：/?token= → 303 + Set-Cookie；有 cookie → 首页；否则 401
  const upstream = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/' && u.searchParams.get('token') === TOK) {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-abc=1; Path=/; HttpOnly; SameSite=Strict' });
      res.end();
      return;
    }
    if (String(req.headers.cookie ?? '').includes('dsh-auth-')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>index</body></html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upstream.address().port },
    injectHtml: '', launchToken: () => TOK,
  });
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    // 第一次访问（手机扫码进来的 URL 没有 token）：代理补 token → 上游 303 + 下发 cookie。
    // issue #91：这里不再是 303（Safari 会丢 3xx 上的 cookie → 死循环），而是 200 过渡页，
    // Set-Cookie 照发、meta refresh 跳回 `/`。
    const first = await fetch(`${base}/`, { redirect: 'manual', headers: { host: 'abc.trycloudflare.com' } });
    assert.equal(first.status, 200, '首屏返回 200 过渡页（不是 303）');
    assert.equal(first.headers.get('x-dsh-pocket-handshake'), 'transition', '标记为握手过渡页');
    const setCookie = first.headers.get('set-cookie') ?? '';
    assert.ok(setCookie.includes('dsh-auth-'), '过渡页照常下发会话 cookie');
    const page = await first.text();
    assert.match(page, /http-equiv="refresh"/, '过渡页用 meta refresh 跳回根路径');
    assert.match(page, /url=\//, '跳转目标是干净的 /');
    assert.ok(seen.some((u) => u.includes(`token=${TOK}`)), '上游确实收到了启动 token');

    // 浏览器带着 cookie 再访问：不再补 token → 直接拿到首页（不会循环）
    const second = await fetch(`${base}/`, { redirect: 'manual', headers: { host: 'abc.trycloudflare.com', cookie: 'dsh-auth-abc=1' } });
    assert.equal(second.status, 200, '带 cookie 直接返回首页');
    assert.match(await second.text(), /index/, '首页内容正确');
    assert.ok(!seen[seen.length - 1].includes('token='), '带 cookie 的请求不再补 token（防循环）');
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('issue #91：cookie 回不来时握手不会无限循环——达到上限后给可操作提示页', async () => {
  const http = await import('node:http');
  const TOK = 'launch-token-abc123';
  let upstreamHits = 0;
  const seen = [];
  // 上游永远 303（模拟 Safari 场景：cookie 下发了但浏览器不回传）
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    seen.push(req.url);
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-abc=1; Path=/; HttpOnly; SameSite=Strict' });
    res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: upstream.address().port },
    injectHtml: '', launchToken: () => TOK, handshakeLimit: 3,
  });
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    // 前 3 次：代理补 token → 上游 303 → 过渡页 200（每次都是新的一次握手尝试）
    for (let i = 1; i <= 3; i++) {
      const r = await fetch(`${base}/`, { redirect: 'manual', headers: { host: '192.168.1.50:3081' } });
      assert.equal(r.status, 200, `第 ${i} 次仍是过渡页`);
      assert.equal(r.headers.get('x-dsh-pocket-handshake'), 'transition', `第 ${i} 次标记为过渡页`);
    }
    // 第 4 次：已达上限 → 不再注入 token，直接给提示页（不再转发给上游）
    const hitsBefore = upstreamHits;
    const blocked = await fetch(`${base}/`, { redirect: 'manual', headers: { host: '192.168.1.50:3081' } });
    assert.equal(blocked.status, 503, '达到上限后返回 503 提示页');
    assert.equal(blocked.headers.get('x-dsh-pocket-handshake'), 'blocked', '标记为握手被阻断');
    const body = await blocked.text();
    assert.match(body, /太多|Safari|cookie/, '提示页说明了原因与规避办法');
    assert.equal(upstreamHits, hitsBefore, '已达上限后不再打上游（不无限循环）');
    assert.match(body, /dsh-pocket-retry=1/, '提示页给了「重试」出口，用户不会被锁死');

    // 点「重试」：清零计数 → 握手重新走一遍；且这个自家参数不能透传给上游
    const retried = await fetch(`${base}/?dsh-pocket-retry=1`, { redirect: 'manual', headers: { host: '192.168.1.50:3081' } });
    assert.equal(retried.status, 200, '重试后重新进入握手（过渡页）');
    assert.equal(retried.headers.get('x-dsh-pocket-handshake'), 'transition', '重试后回到过渡页');
    assert.ok(seen.every((u) => !u.includes('dsh-pocket-retry')), '重试参数不往上游透传');
    assert.ok(seen[seen.length - 1].includes(`token=${TOK}`), '重试请求仍带上启动 token');
  } finally {
    await proxy.close();
    await new Promise((r) => upstream.close(r));
  }
});

test('createHandshakeTracker：窗口内累计、clear 清零、过期重新计数', () => {
  const t = createHandshakeTracker({ max: 3, windowMs: 1000 });
  const now = Date.now();
  assert.equal(t.record('1.2.3.4', now), 1);
  assert.equal(t.record('1.2.3.4', now + 10), 2);
  assert.equal(t.record('1.2.3.4', now + 20), 3);
  assert.equal(t.exhausted('1.2.3.4'), true, '达到上限');
  assert.equal(t.exhausted('5.6.7.8'), false, '别的 IP 不受影响');
  t.clear('1.2.3.4');
  assert.equal(t.exhausted('1.2.3.4'), false, 'clear 后清零');
  // 窗口过期重新计数
  assert.equal(t.record('9.9.9.9', now), 1);
  assert.equal(t.record('9.9.9.9', now + 2000), 1, '超过窗口 → 重新从第 1 次开始');
  // prune 清理过期条目
  t.record('8.8.8.8', now);
  t.prune(now + 5000);
  assert.equal(t.exhausted('8.8.8.8'), false, '过期条目被清掉');
});

test('?token=<原始 PIN> 直达种 HttpOnly cookie，issue #35', async () => {
  // 背景：从公网 URL 首次进入带 ?token=<密码> 时，浏览器需要把 cookie 种下，
  // 否则后续子资源（assets/*.js 等）不带 token 也不带 cookie → 401 → 白屏。
  const http = await import('node:http');
  const TOKEN = 'pin12345';
  const SK = 'sess-key';
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><script src="/assets/x.js"></script></head><body>hi</body></html>`);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: SK },
  });
  const crypto = await import('node:crypto');
  const hashed = crypto.createHash('sha256').update(`${TOKEN}:${SK}`).digest('hex');
  try {
    // 1) 首次带 ?token=<原始 PIN>：200 + set-cookie（哈希值）
    const r1 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: `/?token=${TOKEN}`, headers: { Host: 'x:3081', Accept: 'text/html' } }, (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r1.status, 200, '主页 200');
    const sc = Array.isArray(r1.setCookie) ? r1.setCookie.join(';') : String(r1.setCookie ?? '');
    assert.ok(sc.includes(`dsh_pocket_token=${hashed}`), `种 cookie 含哈希值（实得：${sc.slice(0, 200)}）`);
    assert.ok(sc.includes('HttpOnly'), 'HttpOnly 标记');
    assert.ok(sc.includes('Max-Age=2592000'), '30 天持久');

    // 2) 用刚种的 cookie 访问子资源：200（不再依赖 ?token=）
    const r2 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/assets/x.js', headers: { Host: 'x:3081', Cookie: `dsh_pocket_token=${hashed}` } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r2, 200, '子资源 200');

    // 3) 没 cookie 也没 ?token=：401
    const r3 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/assets/x.js', headers: { Host: 'x:3081' } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r3, 401, '无认证 → 401');

    // 4) 错误 PIN：401 + 不种 cookie
    const r4 = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path: '/?token=wrongpin', headers: { Host: 'x:3081', Accept: 'text/html' } }, (res) => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r4.status, 200, '错误密码走登录页（200）');
    assert.ok(!String(r4.setCookie ?? '').includes('dsh_pocket_token'), '错误密码不种 cookie');

    // 5) 浏览器带着上一进程的失效 cookie（sessionKey 已换）再走 ?token=：
    //    必须换发新 cookie，否则壳能过、子资源全 401，用户只能手清 cookie。
    const staleReq = () => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.port, path: `/?token=${TOKEN}`,
        headers: { Host: 'x:3081', Accept: 'text/html', Cookie: 'dsh_pocket_token=deadbeefdeadbeef' },
      }, (res) => {
        res.resume();
        res.on('end', () => {
          const raw = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join(';') : String(res.headers['set-cookie'] ?? '');
          resolve({ status: res.statusCode, setCookie: raw });
        });
      });
      req.on('error', reject); req.end();
    });
    const r5 = await staleReq();
    assert.ok(r5.setCookie.includes(`dsh_pocket_token=${hashed}`),
      `失效 cookie 必须被换发（实得：${r5.setCookie.slice(0, 200)}）`);
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

// —— 慢加载修复：SW 直出 + 哈希资产 immutable + gzip→brotli 转码 ——

/** 原始 GET：返回未解码的字节（断言 content-encoding 必须用它，fetch 会代理解码）。 */
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// —— 隐私：分享链接里的明文 PIN 不留在下游任何地方 ——

test('隐私：?token=<PIN> 命中后明文 PIN 不再进上游请求行 / Referer / 访问日志', async () => {
  // 背景：扫码/分享链接形如 `http://ip:3081/?token=<明文 PIN>`。旧实现种完 cookie 就
  // 原样转发——PIN 会出现在代理访问日志（`GET /?token=… -> 200`）、上游请求行，以及
  // 首屏之后每个子资源的 Referer 里（`Referer: http://ip:3081/?token=…`）。日志常被
  // 贴进 issue，等于把访问密码公开。
  const PIN = 'pin12345';
  const SK = 'sess-key';
  const seen = [];
  const logs = [];
  const up = createServer((req, res) => {
    seen.push({ url: req.url, referer: req.headers.referer });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>hi</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => PIN, isProtected: () => true, sessionKey: SK },
    log: (line) => logs.push(line),
  });
  const hashed = createHash('sha256').update(`${PIN}:${SK}`).digest('hex');
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxy.port, path, headers: { Host: 'x:3081', Accept: 'text/html', ...headers } }, (res) => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
  try {
    // 1) 首次扫码直达（顺带种 cookie），其他 query 参数要保留
    const r1 = await get(`/?token=${PIN}&keep=1`);
    assert.equal(r1.status, 200, '分享链接直达 200');
    const sc = Array.isArray(r1.headers['set-cookie']) ? r1.headers['set-cookie'].join(';') : String(r1.headers['set-cookie'] ?? '');
    assert.ok(sc.includes(`dsh_pocket_token=${hashed}`), '仍然照常种认证 cookie');

    // 2) 已种 cookie 后再次打开「收藏的分享链接」——用户每次打开都还带着 PIN
    const r2 = await get(`/?token=${PIN}`, { Cookie: `dsh_pocket_token=${hashed}` });
    assert.equal(r2.status, 200, '收藏的分享链接仍可直达');

    // 3) 子资源：浏览器会自动带首屏地址当 Referer
    const r3 = await get('/assets/a.js', {
      Referer: `http://192.168.1.5:3081/?token=${PIN}&x=1`,
      Cookie: `dsh_pocket_token=${hashed}`,
      Accept: 'text/javascript',
    });
    assert.equal(r3.status, 200, '子资源 200');

    // 4) 同名参数并存：`token=<PIN>` 与 dsh 自己的启动 token 同名，只摘 PIN，
    //    不能把启动 token 一起删掉（否则上游握手被打破），也不能漏摘排在后面的 PIN
    const r4 = await get(`/?token=${PIN}&token=DSHLAUNCH&keep=1`, { Cookie: `dsh_pocket_token=${hashed}` });
    assert.equal(r4.status, 200, '同名参数请求 200');

    for (const hit of seen) {
      assert.ok(!String(hit.url).includes(PIN), `上游请求行不得出现明文 PIN（实得：${hit.url}）`);
    }
    assert.ok(seen.some((h) => h.url === '/?keep=1'), '非 token 的 query 参数必须保留');
    const launchKept = seen.find((h) => String(h.url).includes('token=DSHLAUNCH'));
    assert.ok(launchKept, '与 PIN 同名的 dsh 启动 token 必须保留');
    assert.ok(!String(launchKept.url).includes(PIN), '保留启动 token 时 PIN 仍要摘掉');
    assert.match(String(launchKept.url), /keep=1/, '其余参数一并保留');
    const asset = seen.find((h) => String(h.url).startsWith('/assets/a.js'));
    assert.ok(asset, '子资源请求到达上游');
    assert.ok(!String(asset.referer ?? '').includes(PIN), `Referer 不得带明文 PIN（实得：${asset.referer}）`);

    assert.ok(logs.length > 0, '访问日志有记录');
    for (const line of logs) {
      assert.ok(!line.includes(PIN), `访问日志不得出现明文 PIN（实得：${line}）`);
    }
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('慢加载：SW 脚本由代理直出，注册脚本随 DEFAULT_INJECT 注入', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    const res = await fetch(`http://127.0.0.1:${proxy.port}${SW_SCRIPT_PATH}`);
    assert.equal(res.status, 200, 'SW 脚本 200 直出');
    assert.match(res.headers.get('content-type') ?? '', /javascript/, 'JS 类型');
    assert.equal(res.headers.get('cache-control'), 'no-cache', 'SW 主脚本要能更新');
    const js = await res.text();
    assert.equal(js, SW_SCRIPT, '返回导出的 SW 脚本本体');
    assert.match(js, /headers\.delete\('content-encoding'\)/, '入库前摘 content-encoding（防缓存命中双重解码）');
    assert.ok(SW_REGISTER_SCRIPT.includes(SW_SCRIPT_PATH), '注册脚本指向 SW_SCRIPT_PATH');
    assert.ok(DEFAULT_INJECT.includes('data-dsh-pocket-sw-register="1"'), 'DEFAULT_INJECT 带 SW 注册');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('慢加载：内容哈希资产改写一年 immutable，非哈希路径原样透传', async () => {
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'max-age=14400' });
    res.end('x');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    const hashed = await fetch(`http://127.0.0.1:${proxy.port}/assets/index-5SrrfWpU.js`);
    assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable', '哈希资产一年 immutable');
    const combo = await fetch(`http://127.0.0.1:${proxy.port}/plugins/??a/client.js&rev=12e24962dfd7`);
    assert.equal(combo.headers.get('cache-control'), 'max-age=14400', '非哈希路径不代改上游头');
    assert.ok(HASHED_ASSET_RE.test('/assets/vendor-CCJJTK99.js'), '命中典型 vendor');
    assert.ok(!HASHED_ASSET_RE.test('/assets/app.js'), '无哈希后缀不命中');
    assert.ok(!HASHED_ASSET_RE.test('/plugins/'), 'combo 路径不命中');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('慢加载：gzip JS 在客户端接受 br 时转码 brotli，条件不满足原样透传', async () => {
  // 高熵内容：重复文本 gzip 后 <4096 会踩到 size floor，测试就没意义了
  const raw = Array.from({ length: 3000 }, (_, i) => `const v${i} = 0x${(i * 2654435761 >>> 0).toString(16)};`).join('\n');
  const gz = gzipSync(Buffer.from(raw));
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(gz.length), etag: '"abc123"' });
    res.end(gz);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    // 客户端接受 br → 转码
    const brRes = await rawGet(proxy.port, '/plugins/??a/client.js&rev=12e24962dfd7', { 'accept-encoding': 'br, gzip' });
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers['content-encoding'], 'br', '转码为 brotli');
    assert.equal(brotliDecompressSync(brRes.body).toString('utf8'), raw, '解压后内容一致');
    assert.equal(brRes.headers.etag, undefined, '转码后字节变了，etag 必须摘掉');

    // 客户端只收 gzip → 原样透传
    const gzRes = await rawGet(proxy.port, '/plugins/??a/client.js&rev=12e24962dfd7', { 'accept-encoding': 'gzip' });
    assert.equal(gzRes.headers['content-encoding'], 'gzip', '不支持 br 时不动');
    assert.equal(gzRes.body.length, gz.length, '字节原样');

    // 小响应（<4096）不折腾转码
    const up2 = createServer((req, res) => {
      const small = gzipSync(Buffer.from('tiny'));
      res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': 'gzip', 'content-length': String(small.length) });
      res.end(small);
    });
    await new Promise((r) => up2.listen(0, '127.0.0.1', r));
    const proxy2 = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up2.address().port } });
    try {
      const smallRes = await rawGet(proxy2.port, '/x.js', { 'accept-encoding': 'br, gzip' });
      assert.equal(smallRes.headers['content-encoding'], 'gzip', '小响应不转码');
    } finally {
      await proxy2.close();
      await new Promise((r) => up2.close(r));
    }
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

/** 用原始 socket 发一条任意请求行，收完整响应文本（Node http 客户端构造不出畸形目标）。 */
function rawExchange(port, requestLine) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`${requestLine}\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

test('畸形请求目标（端口越界）不崩代理：未鉴权走 SW 路由前被 400 拒绝（P0）', async () => {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    // `new URL('//x:99999', base)` 解析为协议相对目标、端口 99999 越界必抛 TypeError；
    // 修复前 SW 路由的裸 new URL 直接穿出 request 回调崩掉宿主（已两次独立复现）。
    const res1 = await rawExchange(proxy.port, 'GET //x:99999 HTTP/1.1');
    assert.match(res1, /^HTTP\/1\.1 400/, '畸形请求目标被 400 拒绝');
    // 后续正常请求仍可用 = 回调没崩、进程存活
    const ok1 = await getWithHost(proxy.port, '127.0.0.1');
    assert.equal(ok1.status, 200, '后续正常请求仍可用（进程未崩）');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('畸形绝对形式请求行（http://x:99999/）不崩代理：按未认证 401 处理（P0）', async () => {
  const up = await fakeUpstream();
  const TOKEN = 'ABCDE123';
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port },
    auth: { getToken: () => TOKEN, isProtected: () => true, sessionKey: 'session-key' },
  });
  try {
    // 绝对形式 + 端口越界：authCheck 里解析 query token 的 new URL 必抛——
    // 修复前穿出回调崩进程；现在按「无 query token」继续走，落在 401。
    const res1 = await rawExchange(proxy.port, 'GET http://x:99999/ HTTP/1.1');
    assert.match(res1, /^HTTP\/1\.1 401/, '按未认证处理（401），不崩');
    const ok1 = await getWithHost(proxy.port, 'abc.trycloudflare.com');
    assert.equal(ok1.status, 200, '登录页照常可取（进程未崩）');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('accept-encoding 的 q 值被尊重：br;q=0 视为不支持 brotli（P1-3）', async () => {
  // 高熵内容：重复文本 gzip 后 <4096 会踩到转码分支的 size floor，测试就没意义了
  const raw = Array.from({ length: 3000 }, (_, i) => `const v${i} = 0x${(i * 2654435761 >>> 0).toString(16)};`).join('\n');
  const gz = gzipSync(Buffer.from(raw));
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
    res.end(gz);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    // `br;q=0` 是明确排除；词边界正则会误判成支持 br 而转码出客户端解不开的响应
    const res = await rawGet(proxy.port, '/plugins/??a/client.js&rev=12e24962dfd7', { 'accept-encoding': 'br;q=0, gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip', 'q=0 不选 br，原样透传 gzip');
    assert.equal(res.body.length, gz.length, '字节原样');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

// ---------- 取消传播（下游断开必须传到上游） ----------

/**
 * 「响应头已发、body 永远不结束」的上游，记录上游连接何时被关。
 *
 * 这是审查里复现「取消不传播」的形状：代理的 403 门禁改写、HTML 注入、session/list
 * 瘦身、不可变资源缓存回填都要先把上游 body 收完才写响应，客户端在此期间离开时
 * 上游必须跟着停，否则 cloudflared 出站通道被白占到写完。
 */
async function hangingUpstream(status, headers, firstChunk) {
  const state = { reqClosed: false };
  const server = createServer((req, res) => {
    req.socket.on('close', () => { state.reqClosed = true; });
    res.writeHead(status, headers);
    if (firstChunk) res.write(firstChunk);
    // 不 end()：模拟上游持续生成
  });
  server.on('connection', (s) => { s.on('close', () => { state.reqClosed = true; }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server, state };
}

/**
 * 发请求、等 200ms 让代理把上游请求建立起来，然后直接销毁客户端 socket。
 * 不能用 http.request 的响应事件：注入/门禁分支在收到上游 body 结束前一个字节都不写，
 * 等 data 会一直挂到超时。裸 socket 才能表达「用户就这么把页面关了」。
 */
function disconnectAfterMs(port, path, headers, ms = 200) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const head = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1'];
      for (const [k, v] of Object.entries(headers)) head.push(`${k}: ${v}`);
      sock.write(head.join('\r\n') + '\r\n\r\n');
      setTimeout(() => { sock.destroy(); resolve(); }, ms);
    });
    sock.on('error', () => resolve()); // 主动销毁后可能 ECONNRESET
    setTimeout(() => reject(new Error('连接没有建立')), 3000);
  });
}

test('取消传播：客户端断开 → 上游请求被销毁（HTML 注入缓冲分支）', async () => {
  const up = await hangingUpstream(200, { 'content-type': 'text/html; charset=utf-8' }, '<html><head></head>');
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port },
    injectHtml: DEFAULT_INJECT,
  });
  try {
    await disconnectAfterMs(proxy.port, '/', { accept: 'text/html' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(up.state.reqClosed, true, '客户端断开后上游连接必须被销毁，不能继续等整段 body');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('取消传播：客户端断开 → 上游请求被销毁（403 门禁缓冲分支）', async () => {
  const up = await hangingUpstream(403, { 'content-type': 'text/plain; charset=utf-8' }, 'forbid');
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port } });
  try {
    await disconnectAfterMs(proxy.port, '/', { accept: 'text/html' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(up.state.reqClosed, true, '403 缓冲分支同样要传递取消');
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
});

test('取消传播：客户端断开 → 上游请求被销毁（WS 握手阶段，101 之前）', async () => {
  // 上游只回 101 的头但不接管——太麻烦；这里用「上游对 upgrade 不响应」的形状：
  // 代理的 proxyReq 会一直等，客户端断开后必须销毁它。
  let upReqClosed = false;
  const up = createServer(() => { /* 普通请求不回，模拟卡住 */ });
  up.on('connection', (s) => { s.on('close', () => { upReqClosed = true; }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    await disconnectAfterMs(proxy.port, '/api/events', {
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13',
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(upReqClosed, true, '握手未完成时客户端断开，上游连接不能一直挂着');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('Range 请求：206 分片响应不得被代理压缩（否则浏览器解码失败）', async () => {
  // 回归背景：代理对所有 text/* 与 JSON 统一套 Content-Encoding。上游回 206
  // 时 body 只是整文件的一段，加了编码头浏览器会拿这一段当独立压缩流解，
  // 直接 ERR_CONTENT_DECODING_FAILED；且 Content-Range 描述的是未压缩字节。
  const full = Buffer.from('0123456789'.repeat(2000), 'utf8'); // 20KB 可压缩文本
  const up = createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
    if (m) {
      const start = Number(m[1]);
      const end = Number(m[2]);
      const slice = full.subarray(start, end + 1);
      res.writeHead(206, {
        'content-type': 'text/plain; charset=utf-8',
        'content-range': `bytes ${start}-${end}/${full.length}`,
        'content-length': String(slice.length),
        'accept-ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(full.length) });
    res.end(full);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.address().port } });
  try {
    const part = await rawGet(proxy.port, '/big.txt', { Range: 'bytes=100-199', 'accept-encoding': 'gzip, br' });
    assert.equal(part.status, 206, '状态码保持 206');
    assert.equal(part.headers['content-encoding'], undefined, '206 不得被压缩');
    assert.equal(part.headers['content-range'], `bytes 100-199/${full.length}`, 'Content-Range 原样透传');
    assert.ok(part.body.equals(full.subarray(100, 200)), '分片字节必须原样');

    // 普通 200 仍需压缩（不能被这条规则误伤）
    const whole = await rawGet(proxy.port, '/big.txt', { 'accept-encoding': 'gzip' });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers['content-encoding'], 'gzip', '200 仍照常压缩');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});
