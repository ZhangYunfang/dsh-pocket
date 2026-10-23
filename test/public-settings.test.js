import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { POCKET_ENDPOINTS } from '../client/api.js';
import { zh, en } from '../client/pocket-locales.js';

const result = await build({
  entryPoints: [fileURLToPath(new URL('../client/index.jsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  plugins: [{
    name: 'settings-only',
    setup(build) {
      build.onResolve({ filter: /mobile-apply\.tsx$/ }, () => ({ path: 'mobile', namespace: 'settings-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'settings-stub' }, () => ({ contents: 'export function mobileApply() {}' }));
    },
  }],
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
});

function mount({ configured = false, dictionary = zh, rpc } = {}) {
  let status = {
    lanEnabled: true, lanAuthEnabled: true,
    lanUrl: 'http://192.0.2.10:3081', lanQr: 'data:qr', lanToken: '12345678',
    accessToken: '87654321', desktop: true, tunnelUrl: null,
    tunnelState: { phase: 'idle' },
    tunnelConfig: { mode: 'named', hostname: configured ? 'pocket.example.com' : '', tokenSet: configured },
  };
  const calls = [];
  const states = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = i === 0 ? structuredClone(status) : typeof initial === 'function' ? initial() : initial;
      return [states[i], (value) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = { current: initial };
      return states[i];
    },
    useEffect() {},
  };
  const module = { exports: {} };
  const context = createContext({
    module, exports: module.exports, console,
    require: (id) => {
      if (id === 'react') return react;
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
      throw new Error(`Unexpected require: ${id}`);
    },
    setTimeout() { return 1; }, clearTimeout() {},
    document: { body: { setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } } },
    window: { dispatchEvent() {} }, CustomEvent: class {},
  });
  new Script(result.outputFiles[0].text).runInContext(context);
  let Component;
  module.exports.apply({
    connection: {},
    locale: { bind: () => (key) => dictionary[key] ?? key },
    effect() {},
    slots: { inject: (_slot, fn) => fn(), register: (_meta, component) => { Component = component; } },
  });
  const rpcCall = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (rpc) return rpc(endpoint, payload);
    if (endpoint === POCKET_ENDPOINTS.tunnelSetConfig) {
      status = { ...status, tunnelConfig: { mode: 'named', hostname: payload.hostname, tokenSet: true } };
    } else if (endpoint === POCKET_ENDPOINTS.tunnelStart) {
      status = { ...status, tunnelUrl: `https://${status.tunnelConfig.hostname}`, tunnelQr: 'data:qr', tunnelState: { phase: 'ready' } };
    } else if (endpoint === POCKET_ENDPOINTS.tunnelStop) {
      status = { ...status, tunnelUrl: null, tunnelState: { phase: 'idle' } };
    } else if (endpoint === POCKET_ENDPOINTS.pocketReset) {
      status = { ...status, tunnelUrl: null, tunnelState: { phase: 'idle' }, tunnelConfig: { mode: 'named', hostname: '', tokenSet: false } };
    } else {
      assert.fail(`Unexpected RPC: ${endpoint}`);
    }
    return { ok: true, value: structuredClone(status) };
  };
  return { calls, render() { cursor = 0; return Component({ rpcCall, t: (key) => dictionary[key] ?? key }); } };
}

function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap((child) => nodes(child, predicate))];
}

function text(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return tree.children.map(text).join('');
}

function button(tree, label) {
  const matches = nodes(tree, (node) => node.type === 'button' && text(node) === label);
  assert.equal(matches.length, 1, `Expected one button: ${label}`);
  return matches[0];
}

function wan(tree) {
  return nodes(tree, (node) => node.props['data-dshp-section'] === 'wan')[0];
}

function switchOf(tree) {
  return nodes(wan(tree), (node) => node.props.role === 'switch')[0];
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

for (const dictionary of [zh, en]) {
  test(`公网设置：${dictionary === zh ? '中文' : 'English'} 未配置只有自配入口，保存不启动`, async () => {
    const page = mount({ dictionary });
    let tree = page.render();
    assert.match(text(wan(tree)), new RegExp(dictionary.publicConfig));
    assert.ok(text(wan(tree)).includes(dictionary.publicSetupHint));
    assert.equal(nodes(wan(tree), (node) => node.type === 'img').length, 0);
    assert.equal(nodes(wan(tree), (node) => node.props['data-dshp-pin']).length, 0);
    assert.equal(nodes(wan(tree), (node) => node.type === 'button' && text(node) === dictionary.enable).length, 0);
    switchOf(tree).props.onClick();
    tree = page.render();
    assert.equal(page.calls.length, 0, 'unconfigured switch opens the form, not an RPC');
    assert.equal(nodes(tree, (node) => node.props.role === 'dialog').length, 0);
    const inputs = nodes(wan(tree), (node) => node.type === 'input');
    assert.equal(inputs.length, 2);
    inputs[0].props.onChange({ target: { value: 'pocket.example.com' } });
    inputs[1].props.onChange({ target: { value: 'fake-cloudflared-token-for-ui-tests' } });
    await button(page.render(), dictionary.save).props.onClick();
    tree = page.render();
    assert.deepEqual(page.calls.map((call) => call.endpoint), [POCKET_ENDPOINTS.tunnelSetConfig]);
    assert.equal(page.calls[0].payload.mode, 'named');
    assert.ok(text(wan(tree)).includes('pocket.example.com'));
    assert.equal(switchOf(tree).props['aria-checked'], false);
    assert.equal(nodes(wan(tree), (node) => node.type === 'input').length, 0, 'saved Token is not echoed');
    assert.ok(!text(tree).includes('fake-cloudflared-token-for-ui-tests'));
    button(tree, dictionary.enable);
  });
}

test('公网设置：已配置须再次确认免责声明，启动与停止走独立端点', async () => {
  const page = mount({ configured: true });
  button(page.render(), zh.enable).props.onClick();
  let tree = page.render();
  assert.equal(button(tree, zh.disclaimerAgree).props.disabled, true);
  assert.equal(page.calls.length, 0);
  nodes(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
  tree = page.render();
  assert.equal(button(tree, zh.disclaimerAgree).props.disabled, false);
  button(tree, zh.disclaimerAgree).props.onClick();
  await settle();
  tree = page.render();
  assert.equal(page.calls[0].endpoint, POCKET_ENDPOINTS.tunnelStart);
  assert.equal(page.calls[0].payload.disclaimer, true);
  assert.equal(switchOf(tree).props['aria-checked'], true);
  assert.equal(nodes(wan(tree), (node) => node.type === 'img').length, 1);
  await switchOf(tree).props.onClick();
  assert.equal(page.calls[1].endpoint, POCKET_ENDPOINTS.tunnelStop);
  assert.equal(switchOf(page.render()).props['aria-checked'], false);
});

test('公网设置：编辑时 Token 留空不覆盖旧值，保存中禁止公网开关', async () => {
  let finish;
  const page = mount({ configured: true, rpc: () => new Promise((resolve) => { finish = resolve; }) });
  button(page.render(), zh.namedEdit).props.onClick();
  let tree = page.render();
  assert.equal(nodes(wan(tree), (node) => node.type === 'input' && node.props.type === 'password')[0].props.value, '');
  const pending = button(tree, zh.save).props.onClick();
  tree = page.render();
  assert.equal(page.calls[0].payload.token, undefined);
  assert.equal(switchOf(tree).props.disabled, true);
  assert.equal(button(tree, zh.save).props.disabled, true);
  assert.equal(button(tree, zh.cancel).props.disabled, true);
  finish({ ok: false, error: { message: 'configuration rejected' } });
  await pending;
  tree = page.render();
  assert.ok(text(wan(tree)).includes('configuration rejected'));
  assert.equal(switchOf(tree).props.disabled, false);
  assert.equal(page.calls.length, 1);
});

test('公网设置：恢复出厂回到未配置，不留下公网入口或二维码', async () => {
  const page = mount({ configured: true });
  button(page.render(), zh.resetGo).props.onClick();
  await button(page.render(), zh.resetConfirm).props.onClick();
  const tree = page.render();
  assert.equal(page.calls[0].endpoint, POCKET_ENDPOINTS.pocketReset);
  assert.equal(page.calls[0].payload.confirm, true);
  button(tree, zh.publicConfigure);
  assert.equal(nodes(wan(tree), (node) => node.type === 'img').length, 0);
  assert.equal(switchOf(tree).props['aria-checked'], false);
});

test('源码与构建产物均不再携带随机域名功能', () => {
  for (const relative of ['../client/index.jsx', '../client/client.js', '../client/pocket-locales.js', '../lib/tunnel.mjs', '../bin/dsh-pocket.mjs']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /startQuickTunnel|QUICK_TUNNEL_URL_RE|modeQuick|modeNamed|switchToQuick|wanEphemeralWarn/, relative);
  }
});
