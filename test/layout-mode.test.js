// 布局模式判定（issue #74）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLayout, persistLayoutFromUrl, readStoredLayout } from '../client/mobile/layout-mode.mjs';

test('resolveLayout: URL desktop 优先于一切', () => {
  assert.equal(resolveLayout({ urlValue: 'desktop', stored: 'mobile', narrowMatch: true }), 'desktop');
  assert.equal(resolveLayout({ urlValue: 'desktop', stored: 'desktop', narrowMatch: false }), 'desktop');
});

test('resolveLayout: URL mobile 优先于一切（含宽屏）', () => {
  // 用户在 1920px 宽屏设备上显式选 mobile → 强制 mobile（即使 matchMedia 判 wide）
  assert.equal(resolveLayout({ urlValue: 'mobile', stored: 'desktop', narrowMatch: false }), 'mobile');
});

test('resolveLayout: 无 URL 参数 → 退到 localStorage', () => {
  // issue #74 的持久化承诺：URL 上没有 dsh-layout 时，用户上次的显式选择生效。
  assert.equal(resolveLayout({ urlValue: '', stored: 'desktop', narrowMatch: true }), 'desktop');
  assert.equal(resolveLayout({ urlValue: '', stored: 'mobile', narrowMatch: false }), 'mobile');
  assert.equal(resolveLayout({ urlValue: 'garbage', stored: 'mobile', narrowMatch: false }), 'mobile');
});

test('resolveLayout: 显式 auto 是权威，不被残留 localStorage 覆盖', () => {
  // persistLayoutFromUrl('auto') 的本意就是清掉强制值；但 removeItem 会失败
  // （隐私模式/配额/getter 抛错），此时读回来仍是旧的 desktop/mobile。
  // 若判定再退回存储值，用户显式要求的 auto 会静默变成"出不来"的强制布局。
  assert.equal(resolveLayout({ urlValue: 'auto', stored: 'desktop', narrowMatch: true }), 'mobile');
  assert.equal(resolveLayout({ urlValue: 'auto', stored: 'mobile', narrowMatch: false }), 'desktop');
  assert.equal(resolveLayout({ urlValue: 'AUTO', stored: 'desktop', narrowMatch: true }), 'mobile');
});

test('resolveLayout: 都无 → 按 matchMedia 决定', () => {
  assert.equal(resolveLayout({ urlValue: '', stored: '', narrowMatch: true }), 'mobile');
  assert.equal(resolveLayout({ urlValue: '', stored: '', narrowMatch: false }), 'desktop');
  assert.equal(resolveLayout({ urlValue: 'garbage', stored: '', narrowMatch: true }), 'mobile');
});

test('resolveLayout: URL auto 显式清掉 localStorage 后 → 走 matchMedia', () => {
  assert.equal(resolveLayout({ urlValue: 'auto', stored: '', narrowMatch: false }), 'desktop');
  assert.equal(resolveLayout({ urlValue: 'auto', stored: '', narrowMatch: true }), 'mobile');
});

test('persistLayoutFromUrl: 显式 desktop/mobile 写入 localStorage', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  assert.equal(persistLayoutFromUrl('desktop'), 'desktop');
  assert.equal(store.get('dsh-pocket.layout'), 'desktop');
  assert.equal(persistLayoutFromUrl('mobile'), 'mobile');
  assert.equal(persistLayoutFromUrl('auto'), '');
  assert.equal(store.has('dsh-pocket.layout'), false);
  assert.equal(persistLayoutFromUrl(''), '');
  assert.equal(persistLayoutFromUrl('garbage'), '');
});

test('打包产物里带上布局模式判定的关键字', () => {
  const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  for (const needle of ['dsh-layout', 'dsh-pocket.layout', 'data-dsh-pocket-layout']) {
    assert.ok(bundle.includes(needle), `打包产物缺少 "${needle}" —— 先跑 npm run build:client`);
  }
});
