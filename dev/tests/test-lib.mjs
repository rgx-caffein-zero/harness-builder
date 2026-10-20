// ライブラリ部分の単体テスト（Node で実行）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const EXT = new URL('../../extension', import.meta.url).pathname.replace(/\/$/, '');
const FX = new URL('../fixtures/', import.meta.url).pathname;
const { extractPptx, extractDocx, extractSheet, kindOf, drawingMlText } = await import(`${EXT}/lib/extract.js`);
const { findSecrets, maskSecrets, sanitizeMaterialText, isSecretFile, findPii } = await import(`${EXT}/lib/secrets.js`);
const { parseGitignore, isIgnored, scanFolder, treeText } = await import(`${EXT}/lib/codebase.js`);
const { computeCoverage } = await import(`${EXT}/lib/checklist.js`);
const { normalizeIr, slugify } = await import(`${EXT}/lib/ir.js`);
const { buildFiles } = await import(`${EXT}/lib/adapters.js`);
const { validateFiles, checkToml } = await import(`${EXT}/lib/validate.js`);
const { irFromTemplate, splitText, renderHarness, digestMaterial, generateQuestions, generateIr, estimate } = await import(`${EXT}/lib/pipeline.js`);
const { USE_CASES } = await import(`${EXT}/lib/templates.js`);
const { createLlmClient, extractJson, chatUrl } = await import(`${EXT}/lib/llm.js`);
const { parseTeamSettings, isAllowedUrl, originPatterns, exportSettings, importSettingsBackup, defaultSettings } = await import(`${EXT}/lib/settings.js`);
const targetsDef = JSON.parse(fs.readFileSync(`${EXT}/templates/targets.json`, 'utf8'));

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok', name); } catch (e) { console.log('  NG', name); console.log(e); process.exitCode = 1; }
};
const buf = p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

console.log('# 資料の解析');
await test('PowerPoint: スライド本文・ノート・図', async () => {
  const r = await extractPptx(buf(FX + 'sample.pptx'), JSZip);
  assert.equal(r.slides.length, 2);
  assert.match(r.text, /月次報告の作成手順/);
  assert.match(r.text, /前月比を計算する & 確認/);
  assert.match(r.text, /経理の確定値と照合/);
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.images[0].slides, [2]);
});
await test('Word', async () => {
  const nodeMammoth = { extractRawText: o => mammoth.extractRawText({ buffer: Buffer.from(o.arrayBuffer) }) };
  const r = await extractDocx(buf(FX + 'sample.docx'), nodeMammoth);
  assert.match(r.text, /スネークケース/);
});
await test('Excel', () => {
  const r = extractSheet(buf(FX + 'sample.xlsx'), 'sample.xlsx', XLSX);
  assert.match(r.text, /シート「チェック」/);
  assert.match(r.text, /金額,税込で記載/);
});
await test('CSV', () => {
  const r = extractSheet(new TextEncoder().encode('a,b\n1,2').buffer, 'x.csv', XLSX);
  assert.match(r.text, /1,2/);
});
await test('形式の判定', () => {
  assert.equal(kindOf('a/b/query.sql'), 'code');
  assert.equal(kindOf('main.py'), 'code');
  assert.equal(kindOf('Dockerfile'), 'code');
  assert.equal(kindOf('x.PPTX'), 'pptx');
  assert.equal(kindOf('shot.PNG'), 'image');
  assert.equal(kindOf('readme.md'), 'text');
});
await test('DrawingML の実体参照', () => {
  assert.equal(drawingMlText('<a:p><a:r><a:t>A &amp; B &lt;C&gt;</a:t></a:r></a:p>'), 'A & B <C>');
});

console.log('# 機密情報');
await test('認証情報を検出してマスク', () => {
  const t = 'password = "Sup3rS3cret!x"\nkey=AKIAABCDEFGHIJKLMNOP\nurl=postgres://user:pw12345@db.local/app\ntoken: glpat-abcdefghijklmnopqrstu';
  assert.ok(findSecrets(t).length >= 4);
  const m = maskSecrets(t);
  assert.ok(!m.includes('Sup3rS3cret'));
  assert.ok(!m.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!m.includes('pw12345'));
  assert.ok(!m.includes('glpat-'));
});
await test('コードの関数呼び出しは誤検出しない', () => {
  const code = 'token = get_token()\npassword = os.environ["DB_PASSWORD"]\napi_key = settings.API_KEY_NAME()';
  assert.equal(findSecrets(code).length, 0, JSON.stringify(findSecrets(code)));
});
await test('プレースホルダーは誤検出しない', () => {
  assert.equal(findSecrets('API_KEY=your-api-key-here\npassword=changeme').length, 0);
});
await test('個人情報の警告', () => {
  const s = sanitizeMaterialText('連絡先: taro@example.co.jp / 03-1234-5678');
  assert.equal(findPii('taro@example.co.jp').length, 1);
  assert.ok(s.warnings.some(w => /メールアドレス/.test(w)));
});
await test('機密ファイルの判定', () => {
  assert.ok(isSecretFile('.env'));
  assert.ok(isSecretFile('config/.env.production'));
  assert.ok(isSecretFile('keys/server.pem'));
  assert.ok(!isSecretFile('.env.example'));
  assert.ok(!isSecretFile('src/env.py'));
});

console.log('# フォルダ取り込み');
await test('.gitignore', () => {
  const rules = parseGitignore('dist/\n*.log\n!keep.log\n/local.txt\nbuild/**/tmp');
  assert.ok(isIgnored('dist/a.js', rules));
  assert.ok(!isIgnored('src/dist.js', rules));
  assert.ok(isIgnored('logs/x.log', rules));
  assert.ok(!isIgnored('keep.log', rules));
  assert.ok(isIgnored('local.txt', rules));
  assert.ok(!isIgnored('src/local.txt', rules));
});
await test('フォルダのスキャンと既定の選択', async () => {
  const mk = (path, content = 'x') => { const f = new File([content], path.split('/').pop()); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f; };
  const files = [
    mk('proj/.gitignore', 'out/\n*.tmp'),
    mk('proj/README.md', '# app'),
    mk('proj/package.json', '{}'),
    mk('proj/.env', 'SECRET=1'),
    mk('proj/node_modules/x/index.js'),
    mk('proj/out/a.js'),
    mk('proj/a.tmp'),
    mk('proj/src/app.py', 'print(1)'.repeat(500)),
    mk('proj/src/util.py', 'x'),
    mk('proj/src/models.py', 'x'.repeat(5000)),
    mk('proj/src/views.py', 'x'.repeat(7000)),
    mk('proj/src/test_app.py', 'x'),
    mk('proj/sql/report.sql', 'select 1'),
    mk('proj/logo.png'),
  ];
  const r = await scanFolder(files);
  const paths = r.candidates.map(c => c.path);
  assert.equal(r.root, 'proj');
  for (const p of ['.env', 'node_modules/x/index.js', 'out/a.js', 'a.tmp', 'logo.png']) assert.ok(!paths.includes(p), p);
  assert.ok(r.excluded.some(e => e.path === '.env' && /機密/.test(e.reason)));
  const sel = r.candidates.filter(c => c.selected).map(c => c.path);
  assert.ok(sel.includes('README.md') && sel.includes('package.json'));
  assert.equal(sel.filter(p => p.startsWith('src/')).length, 3);
  assert.ok(sel.includes('src/test_app.py'));
  const tree = treeText('proj', paths);
  assert.match(tree, /└── |├── /);
  assert.match(tree, /src\//);
});

console.log('# 設定');
await test('チーム設定ファイル', () => {
  const { team, errors } = parseTeamSettings({ kind: 'harness-builder-team-settings', teamName: 'T', litellm: { baseUrl: 'http://10.0.0.5:4000', models: { generate: 'g' } }, allowedDomains: ['wiki.example.jp', '*.sharepoint.com'], commonRules: ['ルールA'], defaultTargets: ['claude', 'x'] });
  assert.deepEqual(errors, []);
  assert.deepEqual(team.defaultTargets, ['claude']);
  assert.ok(isAllowedUrl('https://wiki.example.jp/page', team.allowedDomains));
  assert.ok(isAllowedUrl('https://abc.sharepoint.com/x', team.allowedDomains));
  assert.ok(!isAllowedUrl('https://evil.example.com', team.allowedDomains));
  assert.ok(isAllowedUrl('https://anything', []));
  assert.ok(originPatterns(['http://10.0.0.5:4000']).includes('http://10.0.0.5/*'));
  assert.ok(originPatterns(['*.sharepoint.com']).includes('https://*.sharepoint.com/*'));
});
await test('設定のバックアップ（キー除外と引き継ぎ）', () => {
  const s = defaultSettings();
  s.profiles[0].apiKey = 'sk-secret';
  const out = exportSettings(s);
  assert.equal(out.settings.profiles[0].apiKey, '');
  const back = importSettingsBackup(out, s);
  assert.equal(back.profiles[0].apiKey, 'sk-secret');
});
await test('エンドポイントURL', () => {
  assert.equal(chatUrl('https://x/'), 'https://x/v1/chat/completions');
  assert.equal(chatUrl('https://x/v1'), 'https://x/v1/chat/completions');
});
await test('JSON の取り出し', () => {
  assert.deepEqual(extractJson('説明です\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('結果: {"a":{"b":"}"}} 以上'), { a: { b: '}' } });
});

console.log('# 生成（テンプレートのみ）');
const team = parseTeamSettings({ commonRules: ['顧客情報を出力しない'], forbiddenPaths: ['config/prod/'] }).team;
for (const workType of ['dev', 'biz']) {
  for (const uc of USE_CASES[workType]) {
    await test(`テンプレート ${workType}/${uc.id}`, () => {
      const state = { mode: 'general', workType, useCase: uc.id, targets: ['claude', 'codex'], hearing: { projectName: 'テスト', purpose: 'テスト用の目的です。十分な長さ', caution: 'standard', commands: 'テスト: npm test' }, answers: [], materials: [] };
      const ir = irFromTemplate({ state, team });
      assert.ok(ir.rules[0].team, 'チーム共通ルールが先頭');
      assert.ok(ir.permissions.denyPaths.includes('config/prod/'));
      const { files, issues } = renderHarness({ ir, targetsDef, state, team, profile: null });
      checkFiles(files);
      const errors = issues.filter(i => i.level === 'error');
      assert.deepEqual(errors, []);
    });
  }
}

function checkFiles(files) {
  const paths = files.map(f => f.path);
  assert.ok(paths.includes('CLAUDE.md') && paths.includes('AGENTS.md'));
  assert.ok(paths.includes('.claude/settings.json') && paths.includes('.codex/config.toml'));
  for (const f of files) {
    if (f.path.endsWith('SKILL.md') || f.path.startsWith('.claude/agents/')) {
      const m = f.content.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(m, `frontmatter: ${f.path}`);
      const fm = yaml.load(m[1]);
      assert.match(fm.name, /^[a-z0-9-]+$/);
      assert.ok(fm.description.length > 10);
      if (f.path.endsWith('SKILL.md')) assert.equal(f.path.split('/').slice(-2, -1)[0], fm.name);
    }
    if (f.path.endsWith('.json')) JSON.parse(f.content);
    if (f.path.endsWith('.toml')) parseToml(f.content);
  }
  const settings = JSON.parse(files.find(f => f.path === '.claude/settings.json').content);
  assert.ok(settings.permissions.deny.includes('Read(./.env)'));
  assert.ok(settings.permissions.deny.includes('Read(./config/prod/**)'));
  const toml = parseToml(files.find(f => f.path === '.codex/config.toml').content);
  assert.ok(['on-request', 'untrusted'].includes(toml.approval_policy));
}

await test('権限レベルの反映', () => {
  for (const [level, ap, sm] of [['strict', 'untrusted', 'read-only'], ['autonomous', 'on-request', 'workspace-write']]) {
    const state = { mode: 'general', workType: 'dev', useCase: 'web', targets: ['claude', 'codex'], hearing: { caution: level, commands: 'テスト: npm test' } };
    const ir = irFromTemplate({ state, team: null });
    ir.permissions.allowCommands = ['npm test'];
    const files = buildFiles(ir, targetsDef, { targets: state.targets });
    const cs = JSON.parse(files.find(f => f.path === '.claude/settings.json').content);
    const toml = parseToml(files.find(f => f.path === '.codex/config.toml').content);
    assert.equal(toml.approval_policy, ap);
    assert.equal(toml.sandbox_mode, sm);
    if (level === 'strict') { assert.deepEqual(cs.permissions.ask, ['Bash', 'WebFetch']); assert.deepEqual(cs.permissions.allow, []); }
    else { assert.equal(cs.permissions.defaultMode, 'acceptEdits'); assert.ok(cs.permissions.allow.includes('Bash(npm test)')); }
  }
});
await test('出力先を1つだけ選んだとき', () => {
  const state = { mode: 'general', workType: 'biz', useCase: 'docs', targets: ['codex'], hearing: {} };
  const files = buildFiles(irFromTemplate({ state, team: null }), targetsDef, { targets: ['codex'] });
  assert.ok(!files.some(f => f.target === 'claude'));
  assert.ok(files.some(f => f.path.startsWith('.agents/skills/')));
  const agents = files.find(f => f.path === 'AGENTS.md').content;
  assert.match(agents, /## 役割/);
  assert.match(agents, /提出前チェック担当/);
});

console.log('# 正規化');
await test('崩れた LLM 出力の正規化', () => {
  const ir = normalizeIr({
    meta: { name: 'X' },
    rules: ['文字列のルール', { rule: '文字列のルール' }, { category: 'A', rule: 'B' }],
    workflows: [{ name: '月次報告', steps: ['a'] }, { id: 'Monthly Report!', name: 'x', steps: ['b'] }, { name: '空', steps: [] }],
    roles: [{ name: 'レビュー担当' }],
    permissions: { level: 'invalid', allowCommands: ['git push origin', 'npm test'], denyCommands: ['git push'] },
  }, { team: null });
  assert.equal(ir.rules.length, 2);
  assert.equal(ir.workflows.length, 2);
  assert.equal(ir.workflows[0].id, 'workflow-1');
  assert.equal(ir.workflows[1].id, 'monthly-report');
  assert.equal(ir.roles[0].id, 'role-1');
  assert.equal(ir.permissions.level, 'standard');
  assert.deepEqual(ir.permissions.allowCommands, ['npm test']);
  assert.equal(slugify('Code Reviewer', 'x'), 'code-reviewer');
});
await test('検証: 不正な frontmatter と TOML を検出', () => {
  const files = [
    { path: '.claude/skills/a/SKILL.md', kind: 'skill', content: '---\nname: B\ndescription: x\n---\n' },
    { path: 'x.toml', kind: 'settings', content: 'a = b\n' },
  ];
  const ir = normalizeIr({}, {});
  const issues = validateFiles(files, ir, targetsDef);
  assert.ok(issues.some(i => /英小文字/.test(i.message)));
  assert.ok(issues.some(i => /一致していません/.test(i.message)));
  assert.ok(issues.some(i => i.path === 'x.toml'));
  assert.deepEqual(checkToml('a = "b"\n[t]\nc = true'), []);
});
await test('長い資料の分割', () => {
  const t = Array.from({ length: 50 }, (_, i) => `段落${i}\n` + 'あ'.repeat(300)).join('\n\n');
  const chunks = splitText(t, 2000);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every(c => c.length <= 2000));
  assert.equal(chunks.join('').replace(/\n/g, '').length, t.replace(/\n/g, '').length);
});

console.log('# 生成（モックLLM）');
const calls = [];
function mockFetch(url, opts) {
  const body = JSON.parse(opts.body);
  calls.push(body);
  const prompt = JSON.stringify(body.messages);
  let out;
  if (prompt.includes('要点を抜き出すアナリスト')) {
    out = { summary: '月次報告の手順書', notes: { procedure: ['売上データを抽出する', '前月比を計算する'], examples: ['表は税込で記載'], unknownId: ['捨てられる'] }, coverage: { procedure: 'full', examples: 'partial', unknownId: 'full' } };
  } else if (prompt.includes('業務ヒアリングの担当者')) {
    out = { questions: [{ itemId: 'criteria', question: '承認の基準は？', placeholder: '例: 10万円以上は課長承認' }, { itemId: 'nope', question: '他には？' }] };
  } else if (prompt.includes('workflows（手順スキル）と roles')) {
    out = { workflows: [{ id: 'monthly-report', name: '月次報告の作成', description: '毎月の売上報告を作るときに使う', steps: ['売上データを抽出する', '前月比を計算する', '経理の確定値と照合する'], checks: ['税込で記載'] }], roles: [{ id: 'report-checker', name: '報告書チェック担当', description: '提出前に数値と表記を確認する', checklist: ['数値の照合'], readOnly: true }] };
  } else if (prompt.includes('meta / overview / context')) {
    out = { meta: { name: '月次売上報告', summary: '月次の売上報告を作る' }, overview: { purpose: '正確な月次報告', deliverables: ['月次報告書'] }, rules: [{ category: '数値', rule: '数値は経理の確定値と照合する', reason: '誤記防止' }], prohibitions: [{ rule: '個人名を記載しない' }], permissions: { level: 'standard', denyPaths: ['data/raw/'] } };
  } else {
    out = { error: 'unexpected' };
  }
  return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } }), { status: 200 }));
}
const profile = { baseUrl: 'https://litellm.test', apiKey: 'k', models: { generate: 'gen', classify: 'cls', vision: 'vis' }, maxInputChars: 3000, maxOutputTokens: 8000, useJsonMode: true };
const llm = createLlmClient(profile, { fetchImpl: mockFetch });

await test('資料の要点抽出・充足度・質問・IR・ファイル', async () => {
  const material = { id: 'm1', name: '手順書.pptx', kind: 'pptx', text: 'スライド\n'.repeat(1000), included: true };
  material.digest = await digestMaterial({ llm, material, workType: 'biz', lang: 'ja' });
  assert.ok(calls.length >= 2, '長い資料は分割される');
  assert.equal(calls[0].model, 'cls');
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.ok(!('unknownId' in material.digest.notes));
  const img = { id: 'm2', name: '画面.png', kind: 'image', imageDataUrl: 'data:image/jpeg;base64,AAAA', included: true };
  img.digest = await digestMaterial({ llm, material: img, workType: 'biz' });
  assert.equal(calls.at(-1).model, 'vis');
  assert.equal(calls.at(-1).messages[1].content[1].type, 'image_url');

  const state = { mode: 'specific', workType: 'biz', targets: ['claude', 'codex'], lang: 'ja', hearing: { projectName: '月次売上報告', purpose: '毎月の売上報告を正確に早く作る', caution: 'standard' }, answers: [], materials: [material, img] };
  const cov = computeCoverage('biz', state.materials, [], state.hearing);
  assert.equal(cov.items.find(i => i.id === 'procedure').status, 'full');
  assert.equal(cov.items.find(i => i.id === 'purpose').status, 'partial');
  assert.ok(cov.missingRequired.length === 0);

  const qs = await generateQuestions({ llm, state });
  assert.equal(qs.length, 2);
  assert.equal(qs[1].itemId === 'nope', false);
  qs[0].answer = '10万円以上は課長承認';
  state.answers = qs;
  const cov2 = computeCoverage('biz', state.materials, state.answers, state.hearing);
  assert.equal(cov2.items.find(i => i.id === 'criteria').status, 'partial');

  const progress = [];
  const ir = await generateIr({ llm, state, team, onProgress: p => progress.push(p) });
  assert.equal(ir.meta.name, '月次売上報告');
  assert.equal(ir.rules[0].rule, '顧客情報を出力しない');
  assert.ok(ir.permissions.denyPaths.includes('data/raw/') && ir.permissions.denyPaths.includes('config/prod/'));
  assert.equal(ir.workflows[0].id, 'monthly-report');
  const irPrompt = JSON.stringify(calls.at(-2).messages);
  assert.match(irPrompt, /売上データを抽出する/, '資料の要点がIR生成に渡る');
  assert.match(irPrompt, /10万円以上は課長承認/, '補完ヒアリングの回答がIR生成に渡る');
  assert.match(irPrompt, /顧客情報を出力しない/, 'チーム共通ルールがIR生成に渡る');
  assert.equal(calls.at(-1).max_tokens, 8000);

  const { files, issues } = renderHarness({ ir, targetsDef, state, team, profile });
  checkFiles(files);
  assert.deepEqual(issues.filter(i => i.level === 'error'), []);
  const claude = files.find(f => f.path === 'CLAUDE.md').content;
  assert.match(claude, /顧客情報を出力しない/);
  assert.match(claude, /monthly-report/);
  const skill = files.find(f => f.path === '.claude/skills/monthly-report/SKILL.md').content;
  assert.match(skill, /1\. 売上データを抽出する/);
  const agent = files.find(f => f.path === '.claude/agents/report-checker.md').content;
  assert.match(agent, /tools: Read, Grep, Glob/);
  const info = JSON.parse(files.find(f => f.path === '.harness/build-info.json').content);
  assert.equal(info.materials.length, 2);
  assert.ok(!JSON.stringify(info).includes('"apiKey"'));
  const zip = new JSZip();
  files.forEach(f => zip.file(f.path, f.content));
  const out = await zip.generateAsync({ type: 'nodebuffer' });
  assert.ok(out.length > 1000);
  fs.writeFileSync(new URL('../sample-output.zip', import.meta.url), out);
  const est = estimate({ state, profile });
  assert.ok(est.input > 0 && est.output > 0);
});

await test('response_format 非対応なら外して再試行', async () => {
  let n = 0;
  const f = (url, opts) => {
    n++;
    const b = JSON.parse(opts.body);
    if (b.response_format) return Promise.resolve(new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 }));
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }));
  };
  const r = await createLlmClient(profile, { fetchImpl: f }).chatJson({ model: 'm', messages: [] });
  assert.deepEqual(r, { ok: true });
  assert.equal(n, 2);
});
await test('出力の途中切れを知らせる', async () => {
  const f = () => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }), { status: 200 }));
  await assert.rejects(createLlmClient(profile, { fetchImpl: f }).chatJson({ model: 'm', messages: [] }), /上限/);
});
await test('HTTPエラーのメッセージ', async () => {
  const f = () => Promise.resolve(new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }));
  await assert.rejects(createLlmClient(profile, { fetchImpl: f }).chatText({ model: 'm', messages: [] }), /401.*Invalid API key/);
});

console.log(`\n${passed} 件成功${process.exitCode ? '（失敗あり）' : ''}`);
