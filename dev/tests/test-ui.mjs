// サイドパネルの画面を jsdom 上で操作する結合テスト（モックの LiteLLM を使用）
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const EXT = new URL('../../extension', import.meta.url).pathname.replace(/\/$/, '');
const FX = new URL('../fixtures/', import.meta.url).pathname;

const html = fs.readFileSync(`${EXT}/sidepanel.html`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'chrome-extension://test/sidepanel.html', pretendToBeVisual: true });
const w = dom.window;
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'navigator', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
}
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
w.URL.createObjectURL = () => 'blob:test';
w.URL.revokeObjectURL = () => {};
globalThis.URL.createObjectURL = () => 'blob:test';
globalThis.URL.revokeObjectURL = () => {};
const downloads = [];
w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };

globalThis.JSZip = require('jszip');
globalThis.XLSX = require('xlsx');
const mammoth = require('mammoth');
globalThis.mammoth = { extractRawText: o => mammoth.extractRawText({ buffer: Buffer.from(o.arrayBuffer) }) };

// ---- chrome API のモック
const store = {
  'hb.settings': {
    profiles: [{ id: 'p1', name: 'テスト', baseUrl: 'https://litellm.test', apiKey: 'k', models: { generate: 'gen', classify: 'cls', vision: 'vis' }, maxInputChars: 24000, maxOutputTokens: 16000, useJsonMode: true }],
    activeProfileId: 'p1',
    team: { kind: 'harness-builder-team-settings', version: 1, teamName: 'テストチーム', litellm: { baseUrl: '', models: {} }, allowedDomains: [], commonRules: ['顧客情報を出力しない'], forbiddenPaths: ['secrets/'], defaultTargets: [], outputLanguage: 'ja' },
  },
};
const opened = [];
globalThis.chrome = {
  runtime: {
    getURL: p => `chrome-extension://test/${p}`,
    onMessage: { addListener() {} },
    sendMessage: async () => ({ ok: false, error: 'テストでは未対応' }),
    openOptionsPage: () => opened.push('options'),
    getManifest: () => ({ version: '0.1.0' }),
  },
  storage: {
    local: { get: async k => ({ [k]: store[k] }), set: async o => Object.assign(store, o) },
    onChanged: { addListener() {} },
  },
  permissions: { request: async () => true, contains: async () => true },
  tabs: { create: o => opened.push(o.url) },
  sidePanel: {},
};

// ---- fetch のモック（拡張機能内ファイルと LiteLLM）
const llmCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('chrome-extension://test/')) {
    return new Response(fs.readFileSync(`${EXT}/${String(url).slice('chrome-extension://test/'.length)}`));
  }
  const body = JSON.parse(opts.body);
  llmCalls.push(body);
  const prompt = JSON.stringify(body.messages);
  let out;
  if (prompt.includes('要点を抜き出すアナリスト')) out = { summary: '手順と規約', notes: { procedure: ['データを抽出する'], purpose: ['月次報告を作る'], style: ['税込で記載'] }, coverage: { procedure: 'full', purpose: 'full', style: 'partial' } };
  else if (prompt.includes('業務ヒアリングの担当者')) out = { questions: [{ itemId: 'examples', question: '良い報告書の例は？', placeholder: '例: 先月の報告書' }] };
  else if (prompt.includes('workflows（手順スキル）と roles')) out = { workflows: [{ id: 'monthly-report', name: '月次報告', description: '毎月の報告書を作るときに使う手順', steps: ['抽出する', '照合する'] }], roles: [{ id: 'checker', name: 'チェック担当', description: '提出前に内容を確認する担当', checklist: ['数値'] }] };
  else if (prompt.includes('meta / overview / context')) out = { meta: { name: '月次報告' }, overview: { purpose: '正確な月次報告を作る' }, rules: [{ rule: '数値を照合する' }], permissions: { level: 'standard' } };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) }, finish_reason: 'stop' }] }));
};

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await tick(20); }
  throw new Error(`タイムアウト: ${label}`);
}
const $ = s => document.querySelector(s);
const main = () => $('#main');
const click = el => { assert.ok(el, 'クリック対象がありません'); el.click(); };
const change = (el, v) => { if (v !== undefined) { if (el.type === 'radio' || el.type === 'checkbox') el.checked = v; else el.value = v; } el.dispatchEvent(new w.Event(el.tagName === 'TEXTAREA' || el.type === 'text' ? 'input' : 'change', { bubbles: true })); };
const nodeFile = (path, name = path.split('/').pop()) => new File([fs.readFileSync(path)], name);

let passed = 0;
const step = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok', name); } catch (e) { console.log('  NG', name); console.log(e); console.log(main().innerHTML.slice(0, 1500)); process.exit(1); }
};

await import(`${EXT}/ui/sidepanel.js`);
await until(() => main().innerHTML.includes('どんなハーネスを作りますか'), '起動');

console.log('# 業務特化（非開発）の一連の流れ');
await step('1. 種類', async () => {
  assert.match($('#conn').textContent, /テストチーム/);
  change(main().querySelector('input[name=workType][value=biz]'), true);
  await tick();
  assert.ok(main().querySelector('input[name=workType][value=biz]').checked);
  click($('#btn-next'));
  await tick();
});
await step('2. ヒアリング', async () => {
  assert.match(main().innerHTML, /ヒアリング/);
  assert.ok(!main().innerHTML.includes('よく使うコマンド'), '非開発では開発用の項目を出さない');
  change(main().querySelector('[data-k=projectName]'), '月次報告');
  change(main().querySelector('[data-k=purpose]'), '毎月の売上報告を正確に作る');
  click($('#btn-next'));
  await tick(500);
});
await step('3. 資料の取り込みと自動解析', async () => {
  assert.match(main().innerHTML, /資料を取り込む/);
  const drop = main().querySelector('#drop');
  const ev = new w.Event('drop', { bubbles: true });
  ev.dataTransfer = { files: [nodeFile(FX + 'sample.pptx'), nodeFile(FX + 'sample.docx'), nodeFile(FX + 'sample.xlsx')] };
  drop.dispatchEvent(ev);
  await until(() => main().querySelectorAll('.mat').length >= 3 && main().querySelectorAll('.status.done').length >= 3, '解析完了');
  const htmlNow = main().innerHTML;
  assert.match(htmlNow, /自動でマスク/, 'Word内のパスワードがマスクされる');
  assert.match(htmlNow, /充足度/);
  assert.match(htmlNow, /手順書・業務フロー: 充足/);
});
await step('3b. フォルダの取り込み', async () => {
  const mk = (path, content) => { const f = new File([content], path.split('/').pop()); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f; };
  const input = main().querySelector('#folder-input');
  Object.defineProperty(input, 'files', { value: [mk('app/README.md', '# app'), mk('app/.env', 'X=1'), mk('app/src/main.py', 'print(1)'), mk('app/sql/q.sql', 'select 1')], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await until(() => $('#dlg').open, 'ファイル選択ダイアログ');
  assert.match($('#dlg').innerHTML, /自動で除外したファイル（1件）/);
  click($('#dlg').querySelector('[data-a=all]'));
  click($('#dlg').querySelector('[data-a=ok]'));
  await until(() => /ソースコード・構成ファイル（3件）/.test(main().innerHTML), 'ソース取り込み');
  assert.match(main().innerHTML, /app のディレクトリ構成/);
  await until(() => !main().querySelector('.status.busy'), '解析待ち');
});
await step('3c. 資料の除外・削除', async () => {
  const mat = [...main().querySelectorAll('.mat')].find(m => m.textContent.includes('ディレクトリ構成'));
  click(mat.querySelector('[data-act=toggle]'));
  await tick();
  assert.ok([...main().querySelectorAll('.mat.excluded')].some(m => m.textContent.includes('ディレクトリ構成')));
  const del = [...main().querySelectorAll('.mat')].find(m => m.textContent.includes('ディレクトリ構成'));
  click(del.querySelector('[data-act=delete]'));
  await until(() => $('#dlg').open, '削除確認');
  click($('#dlg').querySelector('[data-r="1"]'));
  await until(() => !main().innerHTML.includes('app のディレクトリ構成'), '削除');
  click($('#btn-next'));
  await tick();
});
await step('4. 不足の確認と補完ヒアリング', async () => {
  assert.match(main().innerHTML, /不足の確認/);
  click(main().querySelector('#make-q'));
  await until(() => main().querySelector('textarea[data-q]'), '質問');
  change(main().querySelector('textarea[data-q]'), '先月の報告書が良い例');
  click($('#btn-next'));
  await tick();
});
await step('5. 生成', async () => {
  assert.match(main().innerHTML, /チーム共通ルール/);
  assert.match(main().innerHTML, /概算トークン/);
  assert.ok($('#btn-next').disabled, '生成前は次へ進めない');
  click(main().querySelector('#gen'));
  await until(() => main().innerHTML.includes('確認・出力'), '生成完了');
  const irCall = llmCalls.find(c => JSON.stringify(c.messages).includes('meta / overview / context'));
  assert.match(JSON.stringify(irCall.messages), /先月の報告書が良い例/);
});
await step('6. 確認・編集・出力', async () => {
  const files = [...main().querySelectorAll('.file-tree [data-f]')].map(b => b.dataset.f);
  for (const p of ['CLAUDE.md', 'AGENTS.md', '.claude/skills/monthly-report/SKILL.md', '.agents/skills/monthly-report/SKILL.md', '.claude/agents/checker.md', '.claude/settings.json', '.codex/config.toml', '.harness/harness.ir.json']) {
    assert.ok(files.includes(p), p);
  }
  const editor = main().querySelector('#editor');
  assert.match(editor.value, /顧客情報を出力しない/);
  change(editor, editor.value + '\n- 手で追加したルール\n');
  click(main().querySelector('#recheck'));
  await tick();
  assert.match(main().innerHTML, /編集済/);
  click(main().querySelector('[data-tab=ir]'));
  await tick();
  assert.match(main().querySelector('#ir-editor').value, /"irVersion"/);
  click(main().querySelector('[data-tab=issues]'));
  await tick();
  click(main().querySelector('#dl-zip'));
  await until(() => downloads.length, 'ダウンロード');
  assert.equal(downloads[0], '月次報告-harness.zip');
});
await step('状態の保存（パネルを開き直しても残る）', async () => {
  const db = await import(`${EXT}/lib/db.js`);
  const s = await db.get(db.STORES.session, 'current');
  assert.equal(s.step, 'preview');
  assert.ok(s.files.find(f => f.path === 'CLAUDE.md').content.includes('手で追加したルール'));
  const hist = await db.getAll(db.STORES.history);
  assert.equal(hist.length, 1);
});

console.log('# 汎用ハーネス（テンプレートのみ）');
await step('新規 → 汎用 → テンプレートで生成', async () => {
  click($('#btn-new'));
  await until(() => $('#dlg').open, '確認');
  click($('#dlg').querySelector('[data-r="1"]'));
  await until(() => main().innerHTML.includes('どんなハーネスを作りますか'), 'リセット');
  change(main().querySelector('input[name=mode][value=general]'), true);
  await tick();
  assert.ok(main().querySelector('#useCase'));
  change(main().querySelector('#useCase'), 'data');
  change(main().querySelector('input[name=targets][value=codex]'), false);
  await tick();
  const steps = [...$('#stepper').querySelectorAll('button')].map(b => b.textContent);
  assert.ok(!steps.some(s => s.includes('資料')), '汎用では資料の手順を出さない');
  click($('#btn-next'));
  await tick();
  change(main().querySelector('[data-k=commands]'), 'テスト: pytest');
  click($('#btn-next'));
  await tick();
  click(main().querySelector('#gen-tpl'));
  await until(() => main().innerHTML.includes('確認・出力'), 'テンプレート生成');
  const files = [...main().querySelectorAll('.file-tree [data-f]')].map(b => b.dataset.f);
  assert.ok(!files.includes('AGENTS.md'), 'Codex を外したら出力しない');
  assert.ok(files.includes('.claude/skills/write-query/SKILL.md'));
});
await step('タブ・設定ボタン', async () => {
  click($('#btn-options'));
  assert.ok(opened.includes('options'));
});

console.log(`\n${passed} 件成功`);
process.exit(0);
