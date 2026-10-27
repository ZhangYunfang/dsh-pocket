// dsh-pocket 自重启：重新拉起启动本宿主的确切 dsh 调用（detached 交接），
// 让更新后的插件代码生效——用户无需离开界面手动重启。
//
// 方案借鉴 dshmarket 的 self-restart（lib/restart.js，MIT）：不直接拉起新
// 进程，而是先拉一个 detached 的 node 辅助进程，等旧进程退出、端口释放
// 后再拉起新 dsh，并把新进程输出写入临时日志——避免端口竞争
// （EADDRINUSE）导致新进程静默崩溃。
//
// 与 dshmarket 的差异：不赌固定 1.5s 延时，而是轮询探测端口真正释放
// （ECONNREFUSED）再拉起，旧进程退出慢也不会撞端口。
//
// 注意：新进程 detached，不挂终端——停止方式：lsof -ti :3080 | xargs kill -9。

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';

/** 清理 %TEMP% 里超过 7 天的自重启日志（目录或旧版单文件；best-effort，失败静默）。 */
function pruneRestartLogs() {
  try {
    const dir = tmpdir();
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('dsh-pocket-restart-')) continue;
      const full = join(dir, name);
      const isLegacyLog = name.endsWith('.log');
      // 新实现每次重启建一个 0700 私有目录（防本地用户预建符号链接），旧版是裸 .log。
      try {
        if (statSync(full).mtimeMs >= cutoff) continue;
        if (isLegacyLog) unlinkSync(full);
        else rmSync(full, { recursive: true, force: true });
      } catch { /* 单个失败跳过 */ }
    }
  } catch { /* 目录不可读等：静默 */ }
}

/** 从启动参数里解析 dsh web 端口（--port/-p，含 --port=3080 形式），默认 3080。 */
export function dshPortFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') {
      const n = Number(args[i + 1]);
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    } else if (a.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length));
      if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    }
  }
  return 3080;
}

/** 重建启动调用（与当前宿主相同的命令，含 node 运行参数）。 */
export function restartLaunch() {
  return {
    file: process.argv[0], // node
    args: [...process.execArgv, process.argv[1], ...process.argv.slice(2)], // [flags] <bin.js> + web [flags]
    cwd: process.cwd(),
  };
}

/** 辅助进程代码：等 dsh 端口真正释放（最多 20s）→ 拉起新 dsh → 输出写日志。 */
function helperCode(launch, logOut, logErr, port) {
  const spawn = "const { spawn } = require('node:child_process')";
  const fs = "const fs = require('node:fs')";
  const net = "const net = require('node:net')";
  const file = `const file = ${JSON.stringify(launch.file)}`;
  const args = `const args = ${JSON.stringify(launch.args)}`;
  const cwd = `const cwd = ${JSON.stringify(launch.cwd)}`;
  const o = `const logOut = ${JSON.stringify(logOut)}`;
  const e = `const logErr = ${JSON.stringify(logErr)}`;
  const body = [
    'function portFree(p, cb) {',
    '  const s = net.connect(p, "127.0.0.1")',
    '  s.once("connect", () => { s.destroy(); cb(false) })', // 还能连上 = 端口仍被占用
    '  s.once("error", () => cb(true))',                      // 连接被拒 = 已释放
    '}',
    'function waitPort(p, tries, cb) {',
    '  portFree(p, (free) => {',
    '    if (free || tries <= 0) cb(free)',
    '    else setTimeout(() => waitPort(p, tries - 1, cb), 200)',
    '  })',
    '}',
    `waitPort(${port}, 100, (free) => {`, // 最多 100×200ms = 20s；超时也照常拉起（宁可试拉、日志留痕，也不让 dsh 起不来）
    '  setTimeout(() => {',
    '    try {',
    // 日志目录是 mkdtemp 出来的 0700 私有目录，文件再显式 0600：
    // 旧实现把可预测文件名的日志直接放共享 tmpdir（0644、跟随符号链接），
    // 同机其他用户可预建链接读走 dsh web 打印的启动 token（审计 F4）。
    '      const out = fs.openSync(logOut, "a", 0o600)',
    '      const err = fs.openSync(logErr, "a", 0o600)',
    '      const child = spawn(file, args, { cwd, detached: true, stdio: ["ignore", out, err], env: process.env })',
    '      child.unref()',
    '    } catch (ex) {',
    '      try { fs.appendFileSync(logErr, "restart helper failed: " + (ex && ex.message) + "\\n") } catch {}',
    '    }',
    '  }, 300)',
    '})',
  ].join('\n');
  return [spawn, fs, net, file, args, cwd, o, e, body].join('\n');
}

/**
 * 拉起替代宿主（detached 辅助进程交接），随后结束当前进程。
 * @param {object} opts
 * @param {number} [opts.handoffMs] 保留参数（兼容旧调用；现由端口探测接管）
 * @param {object} [opts.internals] 测试注入：spawn / kill
 * @returns {{helperPid:number|null, logOut:string, logErr:string}}
 */
export function restartHost({ handoffMs = 1500, internals = {}, dshPort = null } = {}) {
  const spawnFn = internals.spawn ?? spawn;
  const killFn = internals.kill ?? ((pid) => process.kill(pid, 'SIGTERM'));
  // Electron 桌面宿主里 pocket 跑在 Electron 的 node 上下文：杀 process.pid 会杀掉宿主，
  // 并由 detached 孤儿进程抢宿主端口（19387）→ EADDRINUSE 崩溃循环（issue #177 / #167）。
  // 桌面端应由 DSH Desktop 自己管理重启，这里直接拒绝，交还控制权。
  if (Boolean(process.versions.electron) && internals.spawn === undefined) {
    return { helperPid: null, logOut: '', logErr: '', error: 'desktop-host-restart-not-supported' };
  }
  const launch = restartLaunch();
  // 优先用宿主实际监听的端口：它可能来自配置/环境变量而不是 argv（argv 里没有
  // --port 时旧代码回退 3080，与真实端口不一致 → 辅助进程白等 20s 才拉起）。
  const port = Number.isInteger(dshPort) && dshPort > 0 && dshPort < 65536
    ? dshPort
    : dshPortFromArgs(launch.args);
  pruneRestartLogs(); // 每次自重启都会留一组日志，先清掉一周前的旧账
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 每次重启一个 0700 私有目录：旧实现把日志写成共享 tmpdir 里可预测名字的 0644 文件，
  // 同机用户可预建同名符号链接，等 helper 追加写入时读走宿主日志（可能含启动 token）。
  const logDir = mkdtempSync(join(tmpdir(), `dsh-pocket-restart-${stamp}-`));
  const logOut = join(logDir, 'out.log');
  const logErr = join(logDir, 'err.log');

  let helperPid = null;
  let killTimer = null;
  try {
    const helper = spawnFn(process.execPath, ['-e', helperCode(launch, logOut, logErr, port)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    helper.unref?.();
    helperPid = helper.pid ?? null;
    if (helperPid === null) {
      // 没拿到 pid 就绝不能再排自杀：旧实现无条件 setTimeout(kill)，helper 异步失败
      // 时宿主被杀、新进程又没起来，直接停摆（审计 F3）。
      return { helperPid: null, logOut, logErr, error: 'restart helper did not spawn' };
    }
    // 异步 spawn 失败（EMFILE/EAGAIN/EDR 拦截）：取消自杀，把错误留给调用方提示。
    helper.once?.('error', () => {
      if (killTimer !== null) clearTimeout(killTimer);
      killTimer = null;
    });
    // 短暂等待后结束当前进程（释放端口）；由辅助进程探测到端口释放后拉起新宿主
    killTimer = setTimeout(() => { try { killFn(process.pid); } catch { /* 忽略 */ } }, 500);
  } catch (err) {
    return { helperPid: null, logOut, logErr, error: err?.message ?? String(err) };
  }
  return { helperPid, logOut, logErr };
}
