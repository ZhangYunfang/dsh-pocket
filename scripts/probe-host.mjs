#!/usr/bin/env node
/**
 * 宿主契约探针（P0）——回答一个问题：**这个插件能否在本机 DSH 上加载并跑通？**
 *
 * 不启动 dsh web、不碰现网进程、不读写主力配置：只在独立进程里用**真实的宿主服务**
 * （真实 cordis Context + 真实 WebServer）挂载插件，配一个假上游，逐项断言，然后退出。
 *
 * 用法：
 *   node scripts/probe-host.mjs
 *   node scripts/probe-host.mjs --dsh-home /tmp/probe-home   # 指定隔离设置目录
 *
 * 断言（全部为真才算通过）：
 *   A1 真实宿主 WebServer 能在 loopback + 端口 0 上监听
 *   A2 插件 apply() 不抛异常（清理走 ctx.effect，返回值为 void 属预期）
 *   A3 代理真的监听起来（status.proxyRunning && proxyPort > 0）
 *   A4 RPC 前缀路由 `/dsh-pocket` 已注册到宿主 webServer
 *   A5 会话删除 exact 路由 `/api/mobile-nav.session.delete` 已注册
 *   A6 代理端到端转发到假上游，并注入 randomUUID polyfill（证明代理链路可用）
 *   A7 status() 报出公网通道默认 quick（融合版回补的默认值）
 *
 * 真实 WebServer 会保持事件循环，末尾必须 process.exit()。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 宿主包从 profile 的 node_modules 取（与 dsh web 实际加载的是同一批）
const HOST_MODULES = process.env.DSH_PROBE_NODE_MODULES
  ?? join(process.env.HOME ?? tmpdir(), '.dsh', 'profiles', 'node_modules');
const hostRequire = (spec) => require(require.resolve(spec, { paths: [HOST_MODULES] }));

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${id} ${detail}`);
};

/** 假上游：模拟 dsh web 的首页，用来验证代理转发与注入。 */
function fakeUpstream() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // 必须带 <head>：代理只在 <head> 后注入 polyfill（真实 dsh web 首页同样有 head）
    res.end('<!doctype html><html><head><title>fake-dsh-upstream</title></head>'
      + '<body><div id="probe-marker">fake-dsh-upstream</div></body></html>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function main() {
  // ── 隔离设置目录：绝不读写主力 ~/.dsh/dsh-pocket ────────────────────────
  const argHome = process.argv.includes('--dsh-home')
    ? process.argv[process.argv.indexOf('--dsh-home') + 1]
    : null;
  const dshHome = argHome ?? mkdtempSync(join(tmpdir(), 'dsh-pocket-probe-'));
  process.env.DSH_HOME = dshHome;
  const cleanupHome = argHome === null;

  const dshVersion = (() => {
    try { return hostRequire('@deepseek-ai/dsh-host-webserver/package.json').version; } catch { return 'unknown'; }
  })();
  console.log(`\n宿主模块目录: ${HOST_MODULES}`);
  console.log(`宿主版本:     ${dshVersion}`);
  console.log(`隔离 DSH_HOME: ${dshHome}\n`);

  const { Context } = hostRequire('@deepseek-ai/cordis');
  const { WebServer } = hostRequire('@deepseek-ai/dsh-host-webserver');

  const ctx = new Context();

  // ── A1：真实宿主 WebServer（loopback + OS 分配端口）─────────────────────
  ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' });
  await new Promise((r) => setTimeout(r, 400));
  const webServerPort = ctx.webServer?.port ?? 0;
  record('A1', webServerPort > 0, `真实 WebServer 已监听 127.0.0.1:${webServerPort}`);

  // 桩 connection：插件用它做 loopback 信任判定（真实实现需要 credentials 服务）
  ctx.provide('connection', {
    requestRejection: () => undefined, // 放行；真实宿主在这里做 Host/Origin 校验
    rpc: { handle: () => async () => {} },
    authenticatedUrl: (u) => u,
  });

  const upstream = await fakeUpstream();
  const upstreamPort = upstream.address().port;

  // 自己建 service 并注入，这样能直接读 status（插件本身不是 Service 子类）
  const { createPocketService } = await import(pathToFileURL(join(repoRoot, 'lib', 'service.mjs')).href);
  const service = createPocketService({ dshPort: upstreamPort, port: 0, home: dshHome });
  const plugin = await import(pathToFileURL(join(repoRoot, 'lib', 'index.js')).href);

  // ── A2：apply() 不抛异常 ───────────────────────────────────────────────
  try {
    plugin.apply(ctx, {}, { dshPort: upstreamPort, service, isDesktop: false });
    record('A2', true, 'apply() 加载成功（清理由 ctx.effect 持有，返回 void 属预期）');
  } catch (err) {
    record('A2', false, `apply() 抛错：${err?.message ?? err}`);
  }

  // ── A3：代理监听起来 ───────────────────────────────────────────────────
  let status = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { status = await service.status(); } catch { status = null; }
    if (status?.proxyRunning === true && (status.proxyPort ?? 0) > 0) break;
  }
  const proxyPort = status?.proxyPort ?? 0;
  record('A3', status?.proxyRunning === true && proxyPort > 0, `代理已监听 127.0.0.1:${proxyPort}`);

  // ── A4 / A5：路由注册到宿主 webServer ──────────────────────────────────
  // WebServer 路由表是私有的：重复注册同一 (kind,path) 会抛 "duplicate"，借此反推已注册。
  const routeExists = (kind, path) => {
    try {
      ctx.webServer.register({ kind, path, handler: () => {} });
      return false;
    } catch (err) {
      return /duplicate/.test(String(err?.message ?? err));
    }
  };
  record('A4', routeExists('prefix', '/dsh-pocket'), 'RPC 前缀路由 /dsh-pocket 已注册');
  record('A5', routeExists('exact', '/api/mobile-nav.session.delete'), '会话删除 exact 路由已注册');

  // ── A6：端到端转发 + polyfill 注入 ────────────────────────────────────
  let fwdOk = false;
  let fwdDetail = '代理端口不可用';
  if (proxyPort > 0) {
    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/`, { signal: AbortSignal.timeout(3000) });
      const html = await res.text();
      fwdOk = res.status === 200
        && html.includes('fake-dsh-upstream')
        && html.includes('randomUUID');
      fwdDetail = `HTTP ${res.status}，上游命中=${html.includes('fake-dsh-upstream')}，polyfill 注入=${html.includes('randomUUID')}`;
    } catch (err) {
      fwdDetail = `请求失败：${err?.message ?? err}`;
    }
  }
  record('A6', fwdOk, fwdDetail);

  // ── A7：公网通道默认 quick（融合版回补的默认值）───────────────────────
  const mode = status?.tunnelConfig?.mode ?? null;
  record('A7', mode === 'quick', `status().tunnelConfig.mode = ${JSON.stringify(mode)}`);

  // ── 收尾 ───────────────────────────────────────────────────────────────
  try { await service.dispose(); } catch { /* 忽略 */ }
  try { await ctx.webServer?.dispose?.(); } catch { /* 忽略 */ }
  await new Promise((r) => upstream.close(r));
  if (cleanupHome) { try { rmSync(dshHome, { recursive: true, force: true }); } catch { /* 忽略 */ } }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n———— 结果：${results.length - failed.length}/${results.length} 通过 ————`);
  if (failed.length > 0) console.log('未通过：' + failed.map((r) => `${r.id}(${r.detail})`).join(', '));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('探针自身异常：', err);
  process.exit(2);
});
