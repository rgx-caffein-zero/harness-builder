// オプション画面とバックグラウンド（ページ取り込み）のテスト
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const EXT = new URL('../../extension', import.meta.url).pathname.replace(/\/$/, '');
const html = fs.readFileSync(`${EXT}/options.html`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'chrome-extension://test/options.html', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'navigator']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}
w.confirm = () => true;
globalThis.confirm = () => true;
globalThis.JSZip = require('jszip');
const downloads = [];
w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};

const store = {};
const listeners = { menu: null, install: null, msg: null };
const permRequests = [];
const executed = [];
globalThis.chrome = {
  runtime: {
    getURL: p => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '0.1.0' }),
    onInstalled: { addListener: f => { listeners.install = f; } },
    onStartup: { addListener() {} },
    onMessage: { addListener: f => { listeners.msg = f; } },
    sendMessage: async () => {},
  },
  storage: { local: { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o) }, onChanged: { addListener() {} } },
  permissions: { request: async o => { permRequests.push(o.origins); return true; }, contains: async () => true },
  sidePanel: { setPanelBehavior: async () => {} },
  contextMenus: { removeAll: f => f(), create() {}, onClicked: { addListener: f => { listeners.menu = f; } } },
  notifications: { create: async () => {} },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  scripting: { executeScript: async ({ func, args }) => { executed.push(args); return [{ result: { title: '社内Wiki 手順', url: 'https://wiki.example.jp/p/1', text: '# 手順\n1. 申請する\napi_key = "abcdef1234567890xyz"' } }]; } },
  tabs: { query: async () => [{ id: 1, url: 'https://wiki.example.jp/p/1', title: '社内Wiki' }] },
};
globalThis.fetch = async url => new Response(fs.readFileSync(`${EXT}/${String(url).slice('chrome-extension://test/'.length)}`));

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
let passed = 0;
const step = async (name, fn) => { try { await fn(); passed++; console.log('  ok', name); } catch (e) { console.log('  NG', name, e); process.exit(1); } };

await import(`${EXT}/ui/options.js`);
await tick(200);

console.log('# オプション画面');
await step('初期表示', async () => {
  assert.match($('#ver').textContent, /0\.1\.0.*2026-10/);
  assert.match($('#team-view').innerHTML, /読み込まれていません/);
  assert.ok($('#profile-form').elements.baseUrl);
});
await step('チーム設定ファイルの読み込み', async () => {
  const input = $('#team-file');
  const team = { kind: 'harness-builder-team-settings', teamName: '〇〇課', litellm: { baseUrl: 'http://10.1.2.3:4000', models: { generate: 'gpt-x', vision: 'gpt-v' } }, allowedDomains: ['wiki.example.jp'], commonRules: ['ルール1'] };
  input.click = () => {
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(team)], 'team.json')], configurable: true });
    input.onchange();
  };
  $('#team-import').click();
  await tick(200);
  assert.match($('#team-view').innerHTML, /〇〇課/);
  assert.equal($('#profile-form').elements.baseUrl.value, 'http://10.1.2.3:4000');
  assert.equal($('#profile-form').elements['models.generate'].value, 'gpt-x');
});
await step('接続先の保存（アクセス許可の要求）', async () => {
  $('#profile-form').elements.apiKey.value = 'sk-test';
  $('#profile-save').click();
  await tick(100);
  assert.deepEqual(permRequests.at(-1), ['http://10.1.2.3/*']);
  assert.equal(store['hb.settings'].profiles[0].apiKey, 'sk-test');
  assert.match($('#profile-msg').textContent, /保存しました/);
});
await step('接続先の追加', async () => {
  $('#profile-add').click();
  await tick(100);
  assert.equal(store['hb.settings'].profiles.length, 2);
  assert.equal(store['hb.settings'].profiles[1].baseUrl, 'http://10.1.2.3:4000', 'チーム設定の接続先を引き継ぐ');
});
await step('バックアップのエクスポート（キーを含めない）', async () => {
  $('#backup-export').click();
  assert.match(downloads.at(-1), /harness-builder-settings-/);
});
await step('ひな形のダウンロード', async () => {
  $('#team-sample').click();
  assert.equal(downloads.at(-1), 'team-settings.json');
});

console.log('# バックグラウンド（右クリック取り込み）');
await import(`${EXT}/background.js`);
listeners.install();
const db = await import(`${EXT}/lib/db.js`);
await step('許可リスト内のページを取り込み、認証情報をマスク', async () => {
  await listeners.menu({ menuItemId: 'hb-page' }, { id: 1, url: 'https://wiki.example.jp/p/1', title: '社内Wiki' });
  const mats = await db.getAll(db.STORES.materials);
  assert.equal(mats.length, 1);
  assert.equal(mats[0].kind, 'page');
  assert.ok(!mats[0].text.includes('abcdef1234567890xyz'));
  assert.equal(mats[0].sourceUrl, 'https://wiki.example.jp/p/1');
});
await step('許可リスト外のページは取り込まない', async () => {
  await listeners.menu({ menuItemId: 'hb-page' }, { id: 2, url: 'https://other.example.com/', title: '外部' });
  assert.equal((await db.getAll(db.STORES.materials)).length, 1);
});
await step('サイドパネルからの取り込み要求', async () => {
  const res = await new Promise(r => listeners.msg({ type: 'capture-active-tab', mode: 'page' }, {}, r));
  assert.equal(res.ok, true);
  assert.equal((await db.getAll(db.STORES.materials)).length, 2);
});
console.log(`\n${passed} 件成功`);
process.exit(0);
