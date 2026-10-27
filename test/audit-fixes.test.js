// 审计修复回归测试（2026-10）：
//  1) fileRead 权限边界：凭据/密钥类路径一律拒绝；能枚举工作区时只允许工作区内；
//  2) isTrustedLoopbackRequest 的 IPv6 / 127.0.0.0/8 判定；
//  3) 登录限速的全局锁不连坐「成功登录过的来源」（防被攻击者刷成 DoS）；
//  4) 第二轮审计修复：取不到 PIN 时 fail-closed（503）、超长登录体 413、
//     fileRead 相对路径按工作区根回退、设置缓存不跨 DSH_HOME 串味。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gzipSync, brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, unlinkSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { installPocketRpc, isTrustedLoopbackRequest } from '../lib/web-rpc.js';
import { createPocketProxy } from '../lib/proxy.mjs';
import { purgeSessionTrash } from '../lib/delete-session.mjs';
import { POCKET_ENDPOINTS } from '../client/api.js';
import { lanEnabled, setLanEnabled } from '../lib/settings.mjs';

/** mock ctx：抓 RPC 处理函数，并可按需提供工作区服务。 */
function makeCtx(services = {}) {
  let handler = null;
  const ctx = {
    connection: { rpc: { handle: (_channel, fn) => { handler = fn; return () => {}; } } },
    get: (name) => services[name],
  };
  return { ctx, call: (endpoint, payload, signal) => handler(endpoint, payload, signal) };
}

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-audit-'));
  const file = join(dir, name);
  writeFileSync(file, content);
  return { dir, file };
}

test('fileRead：凭据/密钥类路径一律拒绝（先于存在性检查）', async () => {
  const { ctx, call } = makeCtx();
  installPocketRpc(ctx, { service: { status: async () => ({}) } });
  const cases = [
    ['~/.ssh/id_rsa', '私钥目录'],
    ['~/.dsh/.env', '隐藏配置目录 + .env'],
    ['/srv/app/.env.local', '.env 变体'],
    ['/srv/app/certs/server.pem', '.pem 证书'],
    ['/srv/app/tls/client.key', '.key 私钥'],
    ['/home/u/.aws/credentials', 'AWS 凭据'],
    ['/home/u/.git-credentials', 'git 凭据'],
  ];
  for (const [path, label] of cases) {
    const res = await call(POCKET_ENDPOINTS.fileRead, { path });
    assert.equal(res.ok, false, `${label} 应被拒绝：${path}`);
    assert.match(String(res.error?.message ?? ''), /凭据|credential/, `${label} 应给出凭据类拒绝文案`);
  }
});

test('fileRead：能枚举工作区时只允许读工作区内的文件', async () => {
  const inside = tmpFile('inside.txt', 'inside-content\n');
  const outside = tmpFile('outside.txt', 'outside-content\n');
  const { ctx, call } = makeCtx({ workspaceRegistry: { list: [{ cwd: inside.dir }] } });
  installPocketRpc(ctx, { service: { status: async () => ({}) } });
  try {
    const ok = await call(POCKET_ENDPOINTS.fileRead, { path: inside.file });
    assert.equal(ok.ok, true, '工作区内文件应可读');
    assert.equal(ok.value.content, 'inside-content\n');
    const denied = await call(POCKET_ENDPOINTS.fileRead, { path: outside.file });
    assert.equal(denied.ok, false, '工作区外文件应被拒绝');
    assert.match(String(denied.error?.message ?? ''), /工作区/, '应给出工作区限制文案');
  } finally {
    for (const f of [inside.file, outside.file]) { try { unlinkSync(f); } catch { /* ignore */ } }
  }
});

test('fileRead：工作区枚举失败/形状异常/没有工作区时 fail-closed（不再退化成任意可读）', async () => {
  const target = tmpFile('secret.txt', 'secret-content\n');
  try {
    // 旧实现把所有异常吞成空数组，然后 `roots.length > 0 && ...` 直接跳过边界，
    // 于是 list() 抛错、返回非数组、或插件 fiber 未激活时任意文件都可读。
    const broken = [
      { list: () => { throw new Error('boom'); } },
      { list: 'not-an-array' },
      { list: { weird: true } },
    ];
    for (const svc of broken) {
      const { ctx, call } = makeCtx({ workspaceRegistry: svc });
      installPocketRpc(ctx, { service: { status: async () => ({}) } });
      const res = await call(POCKET_ENDPOINTS.fileRead, { path: target.file });
      assert.equal(res.ok, false, '枚举失败时不得读取工作区外文件');
      assert.match(String(res.error?.message ?? ''), /工作区边界|boundary/, '应说明边界不可用');
    }
    // 服务在但一个工作区都没开：同样不能当成「没有限制」。
    const empty = makeCtx({ workspaceRegistry: { list: [] } });
    installPocketRpc(empty.ctx, { service: { status: async () => ({}) } });
    const res2 = await empty.call(POCKET_ENDPOINTS.fileRead, { path: target.file });
    assert.equal(res2.ok, false, '没有工作区时应拒绝读取');
  } finally {
    try { unlinkSync(target.file); } catch { /* ignore */ }
  }
});

test('isTrustedLoopbackRequest：IPv6 方括号与 127.0.0.0/8 都算 loopback', () => {
  const req = (headers) => ({ headers });
  assert.equal(isTrustedLoopbackRequest(req({ host: '[::1]:3080' })), true, '[::1]:3080 应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: '127.0.0.2:3081' })), true, '127.0.0.2 应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: 'localhost:3080' })), true, 'localhost 应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: '192.168.1.5:3081' })), false, '局域网地址不应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: '[::1]:3080', 'sec-fetch-site': 'cross-site' })), false, '跨站请求不应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: '[::1]:3080', origin: 'http://evil.example' })), false, 'Origin 与 Host 不一致不应受信');
  assert.equal(isTrustedLoopbackRequest(req({ host: '[::1]:3080', origin: 'http://[::1]:3080' })), true, 'Origin 与 Host 一致应受信');
});

test('登录限速：全局锁豁免已成功登录过的来源，仍拦没成功过的来源', async () => {
  const TOKEN = '12345678';
  const up = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => TOKEN, isProtected: () => true },
    rateLimit: { windowMs: 60_000, maxFailures: 99, lockMs: 5_000, globalMaxFailures: 2, globalLockMs: 30_000 },
  });
  const login = (ip, pin) => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/pocket-login',
      headers: { Host: 'abc.trycloudflare.com', 'Content-Type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write('token=' + pin);
    req.end();
  });
  try {
    // IP-A 成功登录 → 记为可信来源
    assert.equal((await login('10.9.0.1', TOKEN)).status, 302, '正确密码登录成功');
    // 两个陌生 IP 各失败一次 → 达到全局阈值，全局锁生效
    assert.equal((await login('10.9.0.2', '00000000')).status, 200);
    assert.equal((await login('10.9.0.3', '00000000')).status, 200);
    // 没成功过的新 IP → 被全局锁拦
    assert.equal((await login('10.9.0.4', '00000000')).status, 429, '陌生来源应被全局锁拦');
    // 成功过的 IP 不被连坐：仍能正常拿到登录页（而不是 429）
    assert.equal((await login('10.9.0.1', '00000000')).status, 200, '已登录过的来源不应被全局锁连坐');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

/** 简单 GET，返回状态码与正文。 */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('认证：protectedHost 取不到 PIN 时 fail-closed（503，不透传到上游）', async () => {
  let upstreamHits = 0;
  const up = createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>dsh</body></html>');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => null, isProtected: () => true },
  });
  try {
    const res = await get(proxy.port, '/', { Host: 'abc.trycloudflare.com' });
    assert.equal(res.status, 503, '取不到 PIN 必须拒绝，不能静默裸奔到上游');
    assert.equal(upstreamHits, 0, '上游不应收到任何请求');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('登录：超长请求体返回 413（此前直接断连，浏览器只看到连接被重置）', async () => {
  const up = createServer((_req, res) => { res.writeHead(200); res.end('x'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    auth: { getToken: () => '12345678', isProtected: () => true },
  });
  try {
    const body = 'token=' + 'a'.repeat(4000);
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/pocket-login',
        headers: {
          Host: 'abc.trycloudflare.com',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', (err) => { if (err?.code !== 'ECONNRESET') reject(err); });
      req.end(body);
    });
    assert.equal(status, 413, '超长登录体应回 413');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('fileRead：客户端 cwd 不匹配时相对路径按工作区根回退', async () => {
  const inside = tmpFile('rel.txt', 'relative-content\n');
  const { ctx, call } = makeCtx({ workspaceRegistry: { list: [{ cwd: inside.dir }] } });
  installPocketRpc(ctx, { service: { status: async () => ({}) } });
  try {
    const res = await call(POCKET_ENDPOINTS.fileRead, { path: 'rel.txt', cwd: tmpdir() });
    assert.equal(res.ok, true, '应回退到工作区根解析，而不是直接拒绝');
    assert.equal(res.value.content, 'relative-content\n');
  } finally {
    try { unlinkSync(inside.file); } catch { /* ignore */ }
  }
});

test('设置缓存：切换 DSH_HOME 后不串味（测试隔离依赖路径键）', () => {
  const homeA = mkdtempSync(join(tmpdir(), 'pocket-home-a-'));
  const homeB = mkdtempSync(join(tmpdir(), 'pocket-home-b-'));
  const prev = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = homeA;
    assert.equal(lanEnabled(), true, '默认开启');
    setLanEnabled(false);
    assert.equal(lanEnabled(), false, 'A 已关闭');
    process.env.DSH_HOME = homeB;
    assert.equal(lanEnabled(), true, 'B 必须回到默认，不能读到 A 的缓存');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  }
});

test('上游中途断开：错误文案不得拼进已发出的响应正文', async () => {
  const up = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<html><body>partial-content');
    setTimeout(() => res.destroy(), 10);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
  });
  try {
    const { body, failed } = await new Promise((resolve) => {
      // 失败/超时也必须可区分：旧写法超时直接 resolve('')，断言永远成立——
      // 代理根本没转发内容时这个用例也是绿的（审计指出）。
      const timer = setTimeout(() => resolve({ body: '', failed: 'timeout' }), 3_000);
      let received = '';
      const req = httpRequest({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: '/' }, (res) => {
        res.on('data', (c) => { received += c; });
        res.on('end', () => { clearTimeout(timer); resolve({ body: received }); });
        res.on('aborted', () => { clearTimeout(timer); resolve({ body: received }); });
        res.on('error', (err) => { clearTimeout(timer); resolve({ body: received, failed: err.message }); });
      });
      req.on('error', (err) => { clearTimeout(timer); resolve({ body: received, failed: err.message }); });
      req.end();
    });
    assert.notEqual(failed, 'timeout', '必须真的收到上游响应（否则断言等于没测）');
    // 代理对上游中断的处理是「终止连接」：要么已经转发过部分正文，要么
    // socket 被销毁（socket hang up / aborted）。两者都算正确；挂着不响应才是 bug。
    if (!body.includes('partial-content')) {
      assert.match(String(failed), /socket hang up|aborted|ECONNRESET/i,
        `上游中断后应终止连接，实际: ${body.slice(-120)} / ${failed}`);
    }
    assert.ok(!body.includes('无法连接上游'), `响应正文混入了上游错误说明: ${body.slice(-120)}`);
    assert.ok(!body.includes('upstream unreachable'), '英文错误文案同样不应出现');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('回收站：启动清理只删过期条目，保留新条目', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-trash-'));
  const trash = join(root, '.sessions-trash');
  const oldDir = join(trash, 'old-entry');
  const newDir = join(trash, 'new-entry');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(oldDir, stale, stale);
  const ctx = { get: (name) => (name === 'sessionPersistence' ? { config: { root } } : undefined) };
  await purgeSessionTrash(ctx);
  assert.equal(existsSync(oldDir), false, '超过 24h 的回收站条目应被清理');
  assert.equal(existsSync(newDir), true, '未过期条目必须保留');
  await purgeSessionTrash({ get: () => undefined });
});

test('转码缓存：不可变资产第二次请求不再回源，普通路径不受影响', async () => {
  // 十六进制随机串压不动，保证 gzip 后长度仍 ≥4096（转码分支要求）
  const payload = randomBytes(8192).toString('hex');
  const gz = gzipSync(payload);
  const br = brotliCompressSync(payload);
  let hits = 0;
  const up = createServer((req, res) => {
    hits += 1;
    // gzip 源走「转码成 br」分支；br 源走「原样透传」分支，两条都要能缓存
    const encoding = req.url.includes('gzip') ? 'gzip' : 'br';
    res.writeHead(200, { 'content-type': 'application/javascript', 'content-encoding': encoding });
    res.end(encoding === 'gzip' ? gz : br);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
  });
  const fetchPath = (path) => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port: proxy.port, method: 'GET', path, headers: { 'accept-encoding': 'br' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const first = await fetchPath('/assets/app-abcdefgh1234-gzip.js');
    assert.equal(first.status, 200);
    assert.equal(first.encoding, 'br', '首次应被转码成 br');
    assert.equal(brotliDecompressSync(first.body).toString('utf8'), payload);
    assert.equal(hits, 1);

    const second = await fetchPath('/assets/app-abcdefgh1234-gzip.js');
    assert.equal(second.encoding, 'br');
    assert.equal(brotliDecompressSync(second.body).toString('utf8'), payload);
    assert.equal(hits, 1, '第二次应命中缓存，不再回源');

    // 上游本来就是 br：原样透传分支也要回填缓存
    const passthroughFirst = await fetchPath('/assets/vendor-ijklmnop5678.js');
    assert.equal(passthroughFirst.encoding, 'br');
    assert.equal(brotliDecompressSync(passthroughFirst.body).toString('utf8'), payload);
    assert.equal(hits, 2);
    const passthroughSecond = await fetchPath('/assets/vendor-ijklmnop5678.js');
    assert.equal(passthroughSecond.encoding, 'br');
    assert.equal(hits, 2, '透传分支第二次也应命中缓存');

    await fetchPath('/api/data.js');
    await fetchPath('/api/data.js');
    assert.equal(hits, 4, '非不可变路径每次都回源');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('删除事务：payload 改名中途失败 → 已改名的回滚，会话重新对宿主可见', async () => {
  // 回归背景：老实现先逐个把 session*.jsonl 改成 .trash（宿主扫描立刻看不到），
  // 再整体 rename 目录进回收站。中途失败（权限/占用/ENAMETOOLONG）时没有回滚，
  // 结果会话既不在原位可见、也没进回收站 —— 删除报错却说"没删成功"。
  const root = mkdtempSync(join(tmpdir(), 'pocket-del-'));
  const cwd = join(root, 'proj');
  const id = 'sess-midway-fail';
  // 目录布局与后端一致：<root>/<projectKey>/<sessionId>/
  const { deleteSession } = await import('../lib/delete-session.mjs');
  const persistence = {
    config: { root },
    list: async () => [{ id, cwd: 'C:\work\proj' }],
  };
  // 用 persistence.list 给出的 cwd 反推真实目录，再把它造出来
  const snapshotCwd = 'C:\work\proj';
  const dirs = await import('node:fs');
  const path = await import('node:path');
  const projectDir = path.join(root, (() => {
    // 与 lib 的 projectKey 同规则：分隔符折叠成 '-'，前缀/后缀 '--'
    const slug = snapshotCwd.replace(/[/\:]+/g, '-').replace(/^-+/, '');
    return `--${slug.slice(0, 251)}--`;
  })());
  const sessionPath = path.join(projectDir, id);
  dirs.mkdirSync(sessionPath, { recursive: true });
  dirs.writeFileSync(path.join(sessionPath, 'session.jsonl'), '{"type":"session"}\n');
  dirs.writeFileSync(path.join(sessionPath, 'session.v2.jsonl'), '{"type":"session"}\n');
  // 第二个 payload 的 .trash 目标先占成目录 → 那次 rename 必然失败（模拟半途出错）
  dirs.mkdirSync(path.join(sessionPath, 'session.v2.jsonl.trash'));

  const res = await deleteSession({ persistence }, id);
  assert.equal(res.ok, false, '应当报删除失败');
  assert.equal(dirs.existsSync(path.join(sessionPath, 'session.jsonl')), true,
    '已改名的 payload 必须回滚成原名，会话重新可见');
  assert.equal(dirs.existsSync(path.join(sessionPath, 'session.v2.jsonl')), true,
    '失败的那一项原名也不动，两个 payload 都还在原位');
  assert.equal(dirs.existsSync(path.join(sessionPath, 'session.jsonl.trash')), false,
    '已改名的 payload 不得留下 .trash 残骸');
  assert.equal(dirs.existsSync(path.join(root, '.sessions-trash')), false,
    '失败时不得留下空的回收站目录');
  dirs.rmSync(root, { recursive: true, force: true });
});

test('删除事务：目录整体搬迁失败 → payload 名字复原，且不进回收站', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pocket-del2-'));
  const { deleteSession } = await import('../lib/delete-session.mjs');
  const id = 'sess-stash-fail';
  const snapshotCwd = 'C:\work\proj2';
  const dirs = await import('node:fs');
  const path = await import('node:path');
  const slug = snapshotCwd.replace(/[/\:]+/g, '-').replace(/^-+/, '');
  const sessionPath = path.join(root, `--${slug.slice(0, 251)}--`, id);
  dirs.mkdirSync(sessionPath, { recursive: true });
  dirs.writeFileSync(path.join(sessionPath, 'session.jsonl'), '{"type":"session"}\n');
  // 让 .sessions-trash 变成一个普通文件：mkdir/rename 都会失败
  dirs.writeFileSync(path.join(root, '.sessions-trash'), 'not-a-directory');

  const res = await deleteSession({
    persistence: { config: { root }, list: async () => [{ id, cwd: snapshotCwd }] },
  }, id);
  assert.equal(res.ok, false, '搬迁失败应报错');
  assert.equal(dirs.existsSync(path.join(sessionPath, 'session.jsonl')), true,
    'payload 必须复原：报错之后会话不能凭空消失');
  assert.equal(dirs.existsSync(path.join(sessionPath, 'session.jsonl.trash')), false,
    '不得留下 .trash 残骸');
  dirs.rmSync(root, { recursive: true, force: true });
});

test('删除路由：优先走宿主 connection.requestRejection（方法调用），未认证不得删除', async () => {
  // 回归背景：路由只做 Host/Origin 静态检查、完全不看浏览器认证。dsh web 按官方
  // 方式绑局域网时，任何 LAN 主机伪造 Host: 127.0.0.1:3080 即可无 PIN 删会话。
  const { mountSessionDeleteRoute } = await import('../lib/delete-session.mjs');
  const { Readable } = await import('node:stream');
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; } };
  const mkReq = (body) => {
    const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
    stream.method = 'POST';
    stream.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' };
    return stream;
  };
  const mkRes = () => ({
    status: 0, body: '',
    writeHead(status) { this.status = status; },
    end(payload) { this.body = String(payload ?? ''); },
  });

  // ① 宿主判 401：必须以方法形式调用（this 绑定）并原样返回 401
  let touched = 0;
  mountSessionDeleteRoute({
    webServer,
    connection: {
      marker: 42,
      requestRejection() { return this.marker === 42 ? 401 : 403; },
    },
    get: () => { touched += 1; return {}; },
  }, { warn() {} });
  const res1 = mkRes();
  await routes.at(-1).handler(mkReq({ sessionId: 's1' }), res1);
  assert.equal(res1.status, 401, '未认证的 LAN 请求应 401');
  assert.equal(touched, 0, '被拒请求不得触碰 persistence');

  // ② 没有 requestRejection（旧宿主）时回退静态栅栏：非 loopback Host → 403
  routes.length = 0;
  mountSessionDeleteRoute({ webServer, get: () => ({}) }, { warn() {} });
  const res2 = mkRes();
  const req2 = mkReq({ sessionId: 's1' });
  req2.headers = { host: '192.168.1.50:3080', 'content-type': 'application/json' };
  await routes.at(-1).handler(req2, res2);
  assert.equal(res2.status, 403, '非 loopback Host 应 403');

  // ③ 放行后 persistence 缺失 → 503（不是 400 空体/挂起）
  routes.length = 0;
  mountSessionDeleteRoute({ webServer, connection: { requestRejection: () => undefined }, get: () => undefined }, { warn() {} });
  const res3 = mkRes();
  await routes.at(-1).handler(mkReq({ sessionId: 's1' }), res3);
  assert.equal(res3.status, 503, 'persistence 缺失应 503');
});
