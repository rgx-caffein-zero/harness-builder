// サイドパネル（メイン画面）
// 手順: 1.種類 → 2.ヒアリング → 3.資料 → 4.不足の確認 → 5.生成 → 6.確認・出力
// （汎用ハーネスでは 3 と 4 を省略）

import * as db from '../lib/db.js';
import { loadSettings, activeProfile, originPatterns } from '../lib/settings.js';
import { createLlmClient } from '../lib/llm.js';
import { extractFile, KIND_LABEL, extOf, kindOf, CODE_EXTS } from '../lib/extract.js';
import { scanFolder, selectDefault, treeText } from '../lib/codebase.js';
import { sanitizeMaterialText, maskPii, findPii } from '../lib/secrets.js';
import { checklistFor, computeCoverage, PRIORITY_LABEL } from '../lib/checklist.js';
import { USE_CASES } from '../lib/templates.js';
import { digestMaterial, generateQuestions, generateIr, irFromTemplate, renderHarness, estimate } from '../lib/pipeline.js';
import { normalizeIr } from '../lib/ir.js';
import { validateFiles } from '../lib/validate.js';
import { buildZip, downloadBlob, safeFileName, folderWriteSupported, pickProjectFolder, findExisting, writeFiles } from '../lib/output.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = n => Number(n || 0).toLocaleString('ja-JP');

let settings, profile, targetsDef;
let state;
let materials = [];
const busy = new Set();
let generating = null;
let genLog = [];
let selectedFile = null;
let previewTab = 'files';
const openPreview = new Set();

const STEPS = [
  { id: 'type', label: '種類' },
  { id: 'hearing', label: 'ヒアリング' },
  { id: 'materials', label: '資料', specificOnly: true },
  { id: 'gaps', label: '不足の確認', specificOnly: true },
  { id: 'generate', label: '生成' },
  { id: 'preview', label: '確認・出力' },
];

// ---------------------------------------------------------------- 状態
function newState() {
  const team = settings?.team;
  return {
    id: 'current',
    step: 'type',
    mode: 'specific',
    workType: 'dev',
    useCase: 'web',
    targets: team?.defaultTargets?.length ? [...team.defaultTargets] : ['claude', 'codex'],
    scope: 'project',
    lang: team?.outputLanguage || 'ja',
    hearing: { caution: 'standard', aiLevel: '' },
    answers: [],
    ir: null,
    files: null,
    issues: null,
    createdAt: Date.now(),
  };
}

let saveTimer = null;
function saveState(delay = 0) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { state.updatedAt = Date.now(); db.put(db.STORES.session, state); }, delay);
}

async function saveMaterial(m) {
  await db.put(db.STORES.materials, m);
  const i = materials.findIndex(x => x.id === m.id);
  if (i >= 0) materials[i] = m; else materials.push(m);
}

const llmReady = () => Boolean(profile?.baseUrl && profile?.models?.generate);
const llm = () => createLlmClient(profile);

// LiteLLM への接続許可。クリック直後（ユーザー操作中）に呼ぶ必要がある
function llmOrigins() {
  try {
    const proto = new URL(profile.baseUrl).protocol;
    return originPatterns([profile.baseUrl]).filter(o => o.startsWith(proto));
  } catch {
    return [];
  }
}

function requestLlmPermission() {
  const origins = llmOrigins();
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins }).catch(() => false);
}

function visibleSteps() {
  return STEPS.filter(s => !(s.specificOnly && state.mode === 'general'));
}

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function confirmDialog(title, bodyHtml, okLabel = 'OK', { danger = false } = {}) {
  return new Promise(resolve => {
    const d = $('#dlg');
    d.innerHTML = `<h2>${esc(title)}</h2><div>${bodyHtml}</div>
      <div class="dlg-actions"><button class="btn" data-r="0">キャンセル</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button></div>`;
    d.onclick = e => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      d.close();
      resolve(b.dataset.r === '1');
    };
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

// ---------------------------------------------------------------- 描画
function renderConn() {
  const el = $('#conn');
  const team = settings.team?.teamName ? ` ・チーム設定: ${settings.team.teamName}` : '';
  if (!llmReady()) {
    el.className = 'conn bad';
    el.innerHTML = `LiteLLM の接続先が未設定です。<a href="#" id="conn-set">設定を開く</a>${esc(team)}`;
    el.querySelector('#conn-set').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  } else {
    el.className = 'conn';
    el.textContent = `接続: ${profile.name}（生成: ${profile.models.generate}）${team}`;
  }
}

function renderStepper() {
  const steps = visibleSteps();
  const cur = steps.findIndex(s => s.id === state.step);
  $('#stepper').innerHTML = steps.map((s, i) => {
    const reachable = i <= cur || (s.id === 'preview' && state.files) || i === cur + 1;
    return `<button data-step="${s.id}" class="${i === cur ? 'current' : i < cur ? 'done' : ''}" ${reachable ? '' : 'disabled'}><span class="n">${i + 1}</span>${esc(s.label)}</button>`;
  }).join('');
  $('#stepper').onclick = e => {
    const b = e.target.closest('button[data-step]');
    if (b && !b.disabled) go(b.dataset.step);
  };
}

function renderFooter() {
  const steps = visibleSteps();
  const i = steps.findIndex(s => s.id === state.step);
  $('#btn-back').style.visibility = i > 0 ? 'visible' : 'hidden';
  const next = $('#btn-next');
  const hint = $('#footer-hint');
  hint.textContent = '';
  next.style.visibility = 'visible';
  next.disabled = false;
  next.textContent = '次へ';
  if (state.step === 'type' && !state.targets.length) { next.disabled = true; hint.textContent = '出力先ツールを1つ以上選んでください'; }
  if (state.step === 'generate') {
    next.textContent = '確認・出力へ';
    next.disabled = !state.files;
  }
  if (state.step === 'preview') next.style.visibility = 'hidden';
}

function render() {
  if (!visibleSteps().some(s => s.id === state.step)) state.step = 'hearing';
  renderConn();
  renderStepper();
  renderFooter();
  const main = $('#main');
  const scroll = main.scrollTop;
  ({ type: renderType, hearing: renderHearing, materials: renderMaterials, gaps: renderGaps, generate: renderGenerate, preview: renderPreview }[state.step])(main);
  main.scrollTop = scroll;
}

function go(stepId) {
  state.step = stepId;
  saveState();
  $('#main').scrollTop = 0;
  render();
}

// ---------------------------------------------------------------- 1. 種類
function renderType(main) {
  const uc = USE_CASES[state.workType === 'biz' ? 'biz' : 'dev'];
  main.innerHTML = `
    <h2>どんなハーネスを作りますか</h2>
    <div class="group-title">種類</div>
    <div class="choices">
      <label class="choice"><input type="radio" name="mode" value="specific" ${state.mode === 'specific' ? 'checked' : ''}><strong>業務特化ハーネス</strong>
        <span class="desc">社内資料（手順書・規約・スライド・ソースコード・画面のスクリーンショットなど）を取り込んで作ります。</span></label>
      <label class="choice"><input type="radio" name="mode" value="general" ${state.mode === 'general' ? 'checked' : ''}><strong>汎用ハーネス</strong>
        <span class="desc">資料なしで、用途と質問への回答から作ります。後から資料を足して業務特化に育てられます。</span></label>
    </div>
    <div class="group-title">業務の種類</div>
    <div class="choices">
      <label class="choice"><input type="radio" name="workType" value="dev" ${state.workType === 'dev' ? 'checked' : ''}><strong>開発業務</strong>
        <span class="desc">プログラム開発、SQL、スクリプトなど</span></label>
      <label class="choice"><input type="radio" name="workType" value="biz" ${state.workType === 'biz' ? 'checked' : ''}><strong>非開発業務</strong>
        <span class="desc">文書作成、事務、企画、集計など</span></label>
    </div>
    ${state.mode === 'general' ? `
    <label class="field"><span>用途</span>
      <select id="useCase">${uc.map(u => `<option value="${u.id}" ${u.id === state.useCase ? 'selected' : ''}>${esc(u.label)}</option>`).join('')}</select>
      <span class="hint">用途に合ったベストプラクティスを出発点にします。</span></label>` : ''}
    <div class="group-title">出力先ツール</div>
    <div class="choices">
      <label class="choice"><input type="checkbox" name="targets" value="claude" ${state.targets.includes('claude') ? 'checked' : ''}><strong>Claude Code</strong>
        <span class="desc">CLAUDE.md、スキル、サブエージェント、権限設定</span></label>
      <label class="choice"><input type="checkbox" name="targets" value="codex" ${state.targets.includes('codex') ? 'checked' : ''}><strong>Codex</strong>
        <span class="desc">AGENTS.md、スキル、config.toml</span></label>
    </div>
    <div class="group-title">出力範囲</div>
    <div class="choices">
      <label class="choice"><input type="radio" name="scope" value="project" checked><strong>プロジェクト単位</strong>
        <span class="desc">リポジトリや作業フォルダに置くファイル一式</span></label>
      <label class="choice"><input type="radio" name="scope" value="user" disabled><strong>ユーザー全体</strong>
        <span class="desc">~/.claude、~/.codex の共通設定（次期対応）</span></label>
    </div>`;

  main.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => { state.mode = r.value; saveState(); render(); });
  main.querySelectorAll('input[name=workType]').forEach(r => r.onchange = async () => {
    const digested = materials.filter(m => m.digest);
    if (digested.length && !(await confirmDialog('業務の種類を変更', `<p>資料の解析結果（${digested.length}件）は業務の種類ごとの分類なので、変更すると解析をやり直す必要があります。変更しますか？</p>`, '変更する'))) {
      render();
      return;
    }
    state.workType = r.value;
    const list = USE_CASES[state.workType === 'biz' ? 'biz' : 'dev'];
    if (!list.some(u => u.id === state.useCase)) state.useCase = list[0].id;
    for (const m of digested) { delete m.digest; await saveMaterial(m); }
    state.answers = [];
    saveState();
    render();
  });
  main.querySelector('#useCase')?.addEventListener('change', e => { state.useCase = e.target.value; saveState(); });
  main.querySelectorAll('input[name=targets]').forEach(c => c.onchange = () => {
    state.targets = [...main.querySelectorAll('input[name=targets]:checked')].map(x => x.value);
    saveState();
    renderFooter();
  });
}

// ---------------------------------------------------------------- 2. ヒアリング
const HEARING_FIELDS = [
  { key: 'projectName', label: 'プロジェクト・業務の名前', type: 'text', placeholder: '例: 受発注システム改修 / 月次売上報告' },
  { key: 'purpose', label: '目的', type: 'textarea', placeholder: '例: 受発注システムの保守・機能追加を、AIと一緒に安全に進めたい', hint: '何のためにAIを使うのか、何ができたら成功か' },
  { key: 'deliverables', label: '主な成果物', type: 'textarea', placeholder: '例: Pythonのバッチ処理、SQL、設計書の更新', hint: '1行に1つ' },
  { key: 'audience', label: '成果物の受け手・利用者', type: 'text', placeholder: '例: 営業部、運用チーム' },
  { key: 'techStack', label: '使用技術・ツール', type: 'textarea', placeholder: '例: Python 3.11, FastAPI, PostgreSQL, pytest', devOnly: true },
  { key: 'commands', label: 'よく使うコマンド', type: 'textarea', placeholder: '例:\nテスト: pytest\nリント: ruff check .\n起動: uvicorn app.main:app', hint: '「用途: コマンド」の形で1行に1つ', devOnly: true },
  { key: 'teamSize', label: 'チーム規模', type: 'text', placeholder: '例: 5名' },
  { key: 'aiLevel', label: '利用者のAI習熟度', type: 'select', options: [['', '選択してください'], ['初心者', '初心者（ほぼ使ったことがない）'], ['中級', '中級（日常的に使っている）'], ['上級', '上級（エージェントを使いこなしている）']] },
  { key: 'caution', label: '慎重さのレベル（権限の厳しさ）', type: 'select', options: [['strict', '慎重: 読み取り中心。コマンド実行は毎回確認'], ['standard', '標準: ファイル編集は可。危険な操作は禁止・確認'], ['autonomous', '積極的: 編集を自動承認。安全なコマンドは確認なし']] },
  { key: 'language', label: '出力する言語', type: 'select', options: [['ja', '日本語'], ['en', '英語']] },
  { key: 'notes', label: '補足（自由記述）', type: 'textarea', placeholder: '例: 本番DBには絶対に接続させたくない。レビューは2名で行っている。' },
];

function renderHearing(main) {
  const h = state.hearing;
  h.language = h.language || state.lang || 'ja';
  const fields = HEARING_FIELDS.filter(f => !(f.devOnly && state.workType === 'biz'));
  main.innerHTML = `<h2>ヒアリング</h2>
    <p class="muted small">分かる範囲で入力してください。空欄でも生成できます。${state.mode === 'specific' ? '資料で足りない部分は、後で追加の質問が出ます。' : ''}</p>
    ${fields.map(f => {
      const v = h[f.key] ?? '';
      let input;
      if (f.type === 'textarea') input = `<textarea data-k="${f.key}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
      else if (f.type === 'select') input = `<select data-k="${f.key}">${f.options.map(([val, lab]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
      else input = `<input type="text" data-k="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
      return `<label class="field"><span>${esc(f.label)}</span>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
    }).join('')}`;
  main.querySelectorAll('[data-k]').forEach(el => {
    el.addEventListener('input', () => {
      h[el.dataset.k] = el.value;
      if (el.dataset.k === 'language') state.lang = el.value;
      saveState(400);
    });
  });
}

// ---------------------------------------------------------------- 3. 資料
function coverageHtml(compact = true) {
  const cov = computeCoverage(state.workType, materials, state.answers, state.hearing);
  const pct = Math.round(cov.score * 100);
  const label = { full: '充足', partial: '一部', missing: '不足' };
  if (compact) {
    return `<div class="coverage">
      <div class="row"><strong>充足度 ${pct}%</strong><span class="spacer"></span>
      ${cov.missingRequired.length ? `<span class="chip error">必須の不足 ${cov.missingRequired.length}件</span>` : '<span class="chip full">必須項目あり</span>'}</div>
      <div class="meter"><div style="width:${pct}%"></div></div>
      <div class="cov-items">${cov.items.map(i => `<span class="chip ${i.status}" title="${esc(i.examples)}">${esc(i.label)}: ${label[i.status]}</span>`).join('')}</div>
    </div>`;
  }
  return `<div class="card"><div class="row"><strong>充足度 ${pct}%</strong></div><div class="meter"><div style="width:${pct}%"></div></div>
    <ul class="cov-list">${cov.items.map(i => `<li><span class="st"><span class="chip ${i.status}">${label[i.status]}</span></span>
      <div><strong>${esc(i.label)}</strong> <span class="muted small">（${PRIORITY_LABEL[i.priority]}）</span>
      <div class="small muted">例: ${esc(i.examples)} → 反映先: ${esc(i.target)}</div>
      ${i.sources.length ? `<div class="small">根拠: ${esc(i.sources.join('、'))}</div>` : ''}</div></li>`).join('')}</ul></div>`;
}

function materialStatus(m) {
  if (busy.has(m.id)) return '<span class="status busy">解析中…</span>';
  if (m.error) return '<span class="status err">エラー</span>';
  if (m.digest) return '<span class="status done">解析済み</span>';
  return '<span class="status">未解析</span>';
}

function materialHtml(m) {
  const cov = m.digest?.coverage ? Object.entries(m.digest.coverage).filter(([, v]) => v === 'full' || v === 'partial') : [];
  const items = checklistFor(state.workType);
  const labelOf = id => items.find(i => i.id === id)?.label || id;
  const size = m.imageDataUrl ? '画像' : `${fmtNum((m.text || '').length)}文字`;
  const pii = m.text && !m.piiMasked ? findPii(m.text).length : 0;
  return `<li class="mat ${m.included === false ? 'excluded' : ''}" data-id="${m.id}">
    <div class="mat-head">
      <span class="mat-kind">${esc(KIND_LABEL[m.kind] || m.kind)}</span>
      <div class="mat-name">${esc(m.name)}
        <div class="mat-meta">${size}${m.sourceUrl ? ` ・ <a href="${esc(m.sourceUrl)}" target="_blank" rel="noopener">元のページ</a>` : ''}</div>
        ${m.digest?.summary ? `<div class="mat-meta">${esc(m.digest.summary)}</div>` : ''}
        ${cov.length ? `<div>${cov.map(([id, v]) => `<span class="chip ${v}">${esc(labelOf(id))}</span>`).join('')}</div>` : ''}
        ${(m.warnings || []).map(w => `<div class="mat-warn">⚠ ${esc(w)}</div>`).join('')}
        ${(m.notes || []).map(w => `<div class="mat-meta">${esc(w)}</div>`).join('')}
        ${m.error ? `<div class="mat-err">${esc(m.error)}</div>` : ''}
      </div>
      ${materialStatus(m)}
    </div>
    <div class="mat-actions">
      <button class="btn ghost small" data-act="toggle">${m.included === false ? '含める' : '除外する'}</button>
      <button class="btn ghost small" data-act="preview">${openPreview.has(m.id) ? '中身を閉じる' : '中身を見る'}</button>
      ${pii ? `<button class="btn ghost small" data-act="mask">個人情報をマスク（${pii}件）</button>` : ''}
      ${m.digest || m.error ? '<button class="btn ghost small" data-act="redo">解析し直す</button>' : ''}
      <button class="btn ghost small danger" data-act="delete">削除</button>
    </div>
    ${openPreview.has(m.id) ? `<div class="mat-preview">${m.imageDataUrl ? `<img src="${m.imageDataUrl}" alt="">` : esc((m.text || '').slice(0, 20000))}${(m.text || '').length > 20000 ? '\n…（以下省略）' : ''}</div>` : ''}
  </li>`;
}

function renderMaterials(main) {
  const pending = materials.filter(m => m.included !== false && !m.digest && !busy.has(m.id));
  main.innerHTML = `
    ${coverageHtml(true)}
    <h2>資料を取り込む</h2>
    <div class="notice warn">個人情報・認証情報（パスワード、APIキー）・顧客データを含む資料は取り込まないでください。認証情報らしき文字列は自動でマスクします。取り込んだ資料は社内のLiteLLMにだけ送られます。</div>
    <div class="drop" id="drop">
      <div>ここにファイルをドロップ</div>
      <div class="muted small">PDF・Word・Excel・PowerPoint・テキスト・Markdown・ソースコード・画像</div>
      <div class="row">
        <button class="btn" id="pick-files">ファイルを選ぶ</button>
        <button class="btn" id="pick-folder">フォルダ（ソースコード）を選ぶ</button>
        <button class="btn" id="capture">このページを取り込む</button>
      </div>
      <input type="file" id="file-input" multiple hidden>
      <input type="file" id="folder-input" webkitdirectory hidden>
    </div>
    <details class="card"><summary>テキストを貼り付けて追加</summary>
      <label class="field" style="margin-top:8px"><span>名前</span><input type="text" id="paste-name" placeholder="例: レビューでよく指摘されること"></label>
      <textarea id="paste-text" rows="5" placeholder="メモ、メール、チャットの内容などを貼り付け"></textarea>
      <div class="row" style="margin-top:6px"><span class="spacer"></span><button class="btn" id="paste-add">追加</button></div>
    </details>
    <p class="muted small">閲覧中の社内ページは、右クリックメニュー「このページをハーネス資料に追加」でも取り込めます。</p>
    <div class="row" style="margin:8px 0">
      <h3 style="margin:0">取り込んだ資料（${materials.length}件）</h3><span class="spacer"></span>
      <button class="btn primary small" id="analyze" ${pending.length && !busy.size ? '' : 'disabled'}>未解析の資料を解析（${pending.length}件）</button>
    </div>
    ${!llmReady() && pending.length ? '<div class="notice error">解析にはLiteLLMの接続設定が必要です。</div>' : ''}
    <ul class="mat-list">${materials.slice().reverse().map(materialHtml).join('') || '<li class="muted small">まだ資料がありません。</li>'}</ul>`;

  const drop = main.querySelector('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
  main.querySelector('#pick-files').onclick = () => main.querySelector('#file-input').click();
  main.querySelector('#file-input').onchange = e => addFiles([...e.target.files]);
  main.querySelector('#pick-folder').onclick = () => main.querySelector('#folder-input').click();
  main.querySelector('#folder-input').onchange = e => addFolder([...e.target.files]);
  main.querySelector('#capture').onclick = captureCurrentPage;
  main.querySelector('#paste-add').onclick = async () => {
    const text = main.querySelector('#paste-text').value.trim();
    if (!text) return;
    const name = main.querySelector('#paste-name').value.trim() || '貼り付けたテキスト';
    await addMaterial({ name, kind: 'paste', text });
    render();
  };
  main.querySelector('#analyze').onclick = () => {
    const p = llmReady() ? requestLlmPermission() : Promise.resolve(true);
    p.then(() => analyzePending());
  };
  main.querySelector('.mat-list').onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const m = materials.find(x => x.id === b.closest('[data-id]').dataset.id);
    if (!m) return;
    const act = b.dataset.act;
    if (act === 'toggle') { m.included = m.included === false; await saveMaterial(m); }
    if (act === 'preview') { openPreview.has(m.id) ? openPreview.delete(m.id) : openPreview.add(m.id); }
    if (act === 'mask') { m.text = maskPii(m.text); m.piiMasked = true; m.warnings = (m.warnings || []).filter(w => !/含まれています/.test(w)); delete m.digest; await saveMaterial(m); }
    if (act === 'redo') { delete m.digest; delete m.error; await saveMaterial(m); requestLlmPermission().then(() => analyzePending()); }
    if (act === 'delete') {
      if (!(await confirmDialog('資料を削除', `<p>「${esc(m.name)}」を削除しますか？</p>`, '削除する', { danger: true }))) return;
      await db.remove(db.STORES.materials, m.id);
      materials = materials.filter(x => x.id !== m.id);
    }
    render();
  };
}

async function addMaterial(draft) {
  const m = { id: db.newId('m'), included: true, createdAt: Date.now(), warnings: [], ...draft };
  if (m.text != null) {
    const s = sanitizeMaterialText(m.text);
    m.text = s.text;
    m.warnings = [...(m.warnings || []), ...s.warnings];
  }
  if (m.kind === 'image') m.warnings = [...(m.warnings || []), '画像に個人情報が写り込んでいないか確認してください'];
  await saveMaterial(m);
  return m;
}

async function addFiles(files) {
  if (!files.length) return;
  let added = 0;
  for (const f of files) {
    toast(`読み込み中: ${f.name}`, 10000);
    try {
      if (kindOf(f.name) === 'unknown' && f.size > 5e6) throw new Error('対応していない形式です');
      const drafts = await extractFile(f);
      for (const d of drafts) { await addMaterial(d); added++; }
    } catch (e) {
      toast(`${f.name}: 読み込めませんでした（${e.message}）`, 6000);
    }
  }
  if (added) toast(`${added}件の資料を追加しました`);
  render();
  autoAnalyze();
}

async function addFolder(fileList) {
  if (!fileList.length) return;
  toast('フォルダを確認しています…', 10000);
  const scan = await scanFolder(fileList);
  const cands = scan.candidates.sort((a, b) => (b.priority - a.priority) || a.path.localeCompare(b.path));
  const d = $('#dlg');
  const renderList = () => cands.map((c, i) => `<label><input type="checkbox" data-i="${i}" ${c.selected ? 'checked' : ''}>
    ${c.priority ? '<span class="pri">構成</span>' : ''}<span>${esc(c.path)}</span><span class="muted small" style="margin-left:auto">${fmtNum(Math.ceil(c.size / 1024))}KB</span></label>`).join('');
  const reasons = {};
  scan.excluded.forEach(x => { reasons[x.reason] = (reasons[x.reason] || 0) + 1; });
  const summary = () => {
    const sel = cands.filter(c => c.selected);
    const bytes = sel.reduce((s, c) => s + c.size, 0);
    return `${sel.length}件を選択中（約${fmtNum(Math.ceil(bytes / 1024))}KB、目安 ${fmtNum(Math.ceil(bytes / 3.5))} トークン）`;
  };
  d.innerHTML = `<h2>取り込むファイルを選ぶ: ${esc(scan.root)}</h2>
    <p class="small muted">構成ファイル・README・ドキュメントと、フォルダごとの代表的なソースを選んでいます。必要に応じて追加・解除してください。</p>
    <div class="row"><button class="btn small" data-a="default">おすすめに戻す</button><button class="btn small" data-a="all">すべて選択</button><button class="btn small" data-a="none">すべて解除</button></div>
    <div class="file-pick" id="fp">${renderList()}</div>
    <div class="small" id="fp-sum">${summary()}</div>
    <details style="margin-top:6px"><summary>自動で除外したファイル（${scan.excluded.length}件）</summary>
      <ul class="small">${Object.entries(reasons).map(([r, n]) => `<li>${esc(r)}: ${n}件</li>`).join('')}</ul></details>
    <div class="dlg-actions"><button class="btn" data-a="cancel">キャンセル</button><button class="btn primary" data-a="ok">取り込む</button></div>`;
  const refresh = () => { d.querySelector('#fp').innerHTML = renderList(); d.querySelector('#fp-sum').textContent = summary(); };
  d.onchange = e => {
    const cb = e.target.closest('input[data-i]');
    if (cb) { cands[Number(cb.dataset.i)].selected = cb.checked; d.querySelector('#fp-sum').textContent = summary(); }
  };
  const result = await new Promise(resolve => {
    d.onclick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'all') { cands.forEach(c => { c.selected = true; }); refresh(); }
      if (a === 'none') { cands.forEach(c => { c.selected = false; }); refresh(); }
      if (a === 'default') { cands.forEach(c => { c.selected = false; }); selectDefault(cands); refresh(); }
      if (a === 'cancel') { d.close(); resolve(false); }
      if (a === 'ok') { d.close(); resolve(true); }
    };
    d.oncancel = () => resolve(false);
    d.showModal();
  });
  if (!result) return;

  const selected = cands.filter(c => c.selected);
  const codeParts = [];
  let docs = 0;
  for (const c of selected) {
    try {
      const k = kindOf(c.path);
      if (['pdf', 'docx', 'sheet', 'pptx', 'image'].includes(k)) {
        for (const dft of await extractFile(c.file, `${scan.root}/${c.path}`)) { await addMaterial(dft); docs++; }
        continue;
      }
      const drafts = await extractFile(c.file, c.path);
      for (const dft of drafts) {
        const lang = CODE_EXTS[extOf(c.path)] || '';
        codeParts.push(`### ${c.path}\n\`\`\`${lang.toLowerCase()}\n${dft.text}\n\`\`\``);
      }
    } catch { /* 読めないファイルは飛ばす */ }
  }
  await addMaterial({ name: `${scan.root} のディレクトリ構成`, kind: 'tree', text: treeText(scan.root, scan.candidates.map(c => c.path)) });
  if (codeParts.length) {
    await addMaterial({ name: `${scan.root} のソースコード・構成ファイル（${codeParts.length}件）`, kind: 'code', text: codeParts.join('\n\n') });
  }
  toast(`取り込みました（ソース・構成 ${codeParts.length}件、文書 ${docs}件）`);
  render();
  autoAnalyze();
}

async function captureCurrentPage() {
  const allowed = settings.team?.allowedDomains || [];
  if (allowed.length) {
    // 許可リストのサイトへのアクセス権をこのクリックの中で求める
    await chrome.permissions.request({ origins: originPatterns(allowed) }).catch(() => false);
  }
  const res = await chrome.runtime.sendMessage({ type: 'capture-active-tab', mode: 'page' });
  if (res?.ok) {
    materials = await db.getAll(db.STORES.materials);
    toast('ページを取り込みました');
    render();
    autoAnalyze();
  } else {
    toast(`${res?.error || '取り込めませんでした'}　右クリックメニュー「このページをハーネス資料に追加」も試してください。`, 7000);
  }
}

function autoAnalyze() {
  if (!llmReady()) return;
  const origins = llmOrigins();
  if (!origins.length) return;
  chrome.permissions.contains({ origins })
    .then(ok => { if (ok) analyzePending(); })
    .catch(() => {});
}

async function analyzePending({ signal } = {}) {
  if (!llmReady()) { toast('LiteLLMの接続先を設定してください'); return; }
  const targets = materials.filter(m => m.included !== false && !m.digest && !busy.has(m.id));
  if (!targets.length) return;
  const client = llm();
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const m = queue.shift();
      busy.add(m.id);
      if (state.step === 'materials') render();
      try {
        m.digest = await digestMaterial({ llm: client, material: m, workType: state.workType, lang: state.lang, signal });
        delete m.error;
      } catch (e) {
        if (e.name === 'AbortError') { busy.delete(m.id); return; }
        m.error = e.message || String(e);
      }
      busy.delete(m.id);
      await saveMaterial(m);
      if (state.step === 'materials' || state.step === 'gaps') render();
    }
  };
  await Promise.all([worker(), worker()]);
}

// ---------------------------------------------------------------- 4. 不足の確認
function renderGaps(main) {
  const cov = computeCoverage(state.workType, materials, state.answers, state.hearing);
  const pending = materials.filter(m => m.included !== false && !m.digest).length;
  main.innerHTML = `<h2>不足の確認</h2>
    ${pending ? `<div class="notice warn">未解析の資料が${pending}件あります。「資料」の画面で解析すると、充足度に反映されます。</div>` : ''}
    ${cov.missingRequired.length ? `<div class="notice error">必須項目「${esc(cov.missingRequired.map(i => i.label).join('」「'))}」の情報がありません。資料を追加するか、下の質問に答えてください。</div>` : ''}
    <div id="cov">${coverageHtml(false)}</div>
    <div class="card">
      <div class="row"><h3 style="margin:0">補完ヒアリング</h3><span class="spacer"></span>
        <button class="btn small ${state.answers.length ? '' : 'primary'}" id="make-q" ${llmReady() ? '' : 'disabled'}>${state.answers.length ? '質問を作り直す' : '足りない情報の質問を作る'}</button></div>
      <p class="small muted">資料で足りない部分を、3〜5問の質問で補います。答えられる範囲で入力してください。</p>
      <div id="questions">${state.answers.map(q => `<div class="question"><div class="q">${esc(q.question)}</div>
        <textarea data-q="${q.id}" rows="2" placeholder="${esc(q.placeholder)}">${esc(q.answer)}</textarea></div>`).join('') || '<p class="small muted">まだ質問はありません。</p>'}</div>
    </div>`;
  main.querySelectorAll('textarea[data-q]').forEach(t => t.addEventListener('input', () => {
    const q = state.answers.find(x => x.id === t.dataset.q);
    q.answer = t.value;
    saveState(400);
  }));
  main.querySelectorAll('textarea[data-q]').forEach(t => t.addEventListener('change', () => {
    main.querySelector('#cov').innerHTML = coverageHtml(false);
  }));
  main.querySelector('#make-q').onclick = async () => {
    const b = main.querySelector('#make-q');
    const perm = requestLlmPermission();
    b.disabled = true;
    b.textContent = '質問を作っています…';
    try {
      await perm;
      const answered = state.answers.filter(a => a.answer?.trim());
      const qs = await generateQuestions({ llm: llm(), state: { ...state, materials, answers: answered } });
      state.answers = [...answered, ...qs];
      saveState();
    } catch (e) {
      toast(e.message, 7000);
    }
    render();
  };
}

// ---------------------------------------------------------------- 5. 生成
function renderGenerate(main) {
  const inc = materials.filter(m => m.included !== false);
  const est = estimate({ state: { ...state, materials: state.mode === 'specific' ? inc : [] }, profile });
  const cov = state.mode === 'specific' ? computeCoverage(state.workType, materials, state.answers, state.hearing) : null;
  const ucLabel = USE_CASES[state.workType === 'biz' ? 'biz' : 'dev'].find(u => u.id === state.useCase)?.label;
  const tl = { claude: 'Claude Code', codex: 'Codex' };
  main.innerHTML = `<h2>生成</h2>
    <div class="card estimate">
      <span class="muted">種類</span><span>${state.mode === 'specific' ? '業務特化ハーネス' : '汎用ハーネス'}（${state.workType === 'biz' ? '非開発業務' : '開発業務'}）</span>
      ${state.mode === 'general' ? `<span class="muted">用途</span><span>${esc(ucLabel)}</span>` : ''}
      <span class="muted">出力先</span><span>${state.targets.map(t => tl[t]).join('、')}（プロジェクト単位）</span>
      ${state.mode === 'specific' ? `<span class="muted">資料</span><span>${inc.length}件（解析済み ${inc.filter(m => m.digest).length}件）・充足度 ${Math.round(cov.score * 100)}%</span>` : ''}
      <span class="muted">補完ヒアリング</span><span>${state.answers.filter(a => a.answer?.trim()).length}件の回答</span>
      ${settings.team?.commonRules?.length ? `<span class="muted">チーム共通ルール</span><span>${settings.team.commonRules.length}件を必ず含めます</span>` : ''}
      <span class="muted">概算トークン</span><span>入力 約${fmtNum(est.input)} / 出力 約${fmtNum(est.output)}${est.cost != null ? `（概算コスト ${est.cost.toFixed(2)}）` : ''}</span>
    </div>
    ${est.pendingCount ? `<div class="notice info">未解析の資料${est.pendingCount}件は、生成の前に解析します。</div>` : ''}
    ${cov?.missingRequired.length ? `<div class="notice warn">必須項目「${esc(cov.missingRequired.map(i => i.label).join('」「'))}」が不足しています。このまま生成もできますが、精度が下がります。</div>` : ''}
    ${state.files ? '<div class="notice ok">生成済みです。もう一度生成すると、確認画面での手直しは失われます。</div>' : ''}
    <div class="row">
      ${generating ? '<button class="btn danger" id="cancel">中止</button>' : `<button class="btn primary" id="gen" ${llmReady() ? '' : 'disabled'}>生成する</button>`}
      ${state.mode === 'general' && !generating ? '<button class="btn" id="gen-tpl" title="LLMを使わずにテンプレートだけで作ります">テンプレートだけで作る</button>' : ''}
    </div>
    ${!llmReady() ? '<p class="small muted">LLMでの生成には接続設定が必要です。</p>' : ''}
    ${genLog.length ? `<h3 style="margin-top:12px">進行状況</h3><div class="log" id="log">${esc(genLog.join('\n'))}</div>` : ''}`;
  main.querySelector('#gen')?.addEventListener('click', () => { const p = requestLlmPermission(); runGenerate(p); });
  main.querySelector('#gen-tpl')?.addEventListener('click', () => {
    const ir = irFromTemplate({ state, team: settings.team });
    finishGeneration(ir, 'テンプレートから生成しました');
  });
  main.querySelector('#cancel')?.addEventListener('click', () => generating?.abort());
  const log = main.querySelector('#log');
  if (log) log.scrollTop = log.scrollHeight;
}

function logLine(s) {
  genLog.push(`${new Date().toLocaleTimeString('ja-JP')} ${s}`);
  if (state.step === 'generate') render();
}

async function runGenerate(permPromise) {
  if (state.files && !(await confirmDialog('もう一度生成しますか', '<p>確認画面での手直しは失われます。</p>', '生成する'))) return;
  await permPromise;
  generating = new AbortController();
  genLog = [];
  const signal = generating.signal;
  render();
  try {
    if (state.mode === 'specific') {
      const pending = materials.filter(m => m.included !== false && !m.digest);
      if (pending.length) {
        logLine(`未解析の資料を解析しています（${pending.length}件）`);
        await analyzePending({ signal });
        const failed = materials.filter(m => m.included !== false && !m.digest);
        if (failed.length) logLine(`解析できなかった資料が${failed.length}件あります（除外して続行）`);
      }
    }
    const ir = await generateIr({
      llm: llm(),
      state: { ...state, materials: materials.filter(m => m.included !== false && m.digest) },
      team: settings.team,
      signal,
      onProgress: logLine,
    });
    generating = null;
    finishGeneration(ir, '生成しました');
  } catch (e) {
    const aborted = e.name === 'AbortError';
    generating = null;
    logLine(aborted ? '中止しました' : `エラー: ${e.message}`);
    if (!aborted) toast(e.message, 8000);
    render();
  }
}

async function finishGeneration(ir, message) {
  const { files, issues } = renderHarness({ ir, targetsDef, state: { ...state, materials }, team: settings.team, profile });
  state.ir = ir;
  state.files = files;
  state.issues = issues;
  selectedFile = files[0]?.path || null;
  previewTab = 'files';
  logLine(`${message}（${files.length}ファイル）`);
  await db.put(db.STORES.history, {
    id: db.newId('h'),
    createdAt: Date.now(),
    name: ir.meta.name,
    mode: state.mode,
    workType: state.workType,
    targets: state.targets,
    ir,
    files,
  });
  go('preview');
}

// ---------------------------------------------------------------- 6. 確認・出力
function revalidate() {
  state.issues = validateFiles(state.files, state.ir, targetsDef);
}

function renderPreview(main) {
  if (!state.files) { main.innerHTML = '<p>まだ生成していません。</p>'; return; }
  const issuesBy = path => (state.issues || []).filter(i => i.path === path);
  const groups = [
    ['Claude Code', state.files.filter(f => f.target === 'claude')],
    ['Codex', state.files.filter(f => f.target === 'codex')],
    ['生成情報（.harness）', state.files.filter(f => f.target === 'meta')],
  ].filter(([, fs]) => fs.length);
  const errs = (state.issues || []).filter(i => i.level === 'error').length;
  const warns = (state.issues || []).filter(i => i.level === 'warning').length;
  if (!state.files.some(f => f.path === selectedFile)) selectedFile = state.files[0]?.path;
  const cur = state.files.find(f => f.path === selectedFile);

  let body = '';
  if (previewTab === 'files') {
    body = `<div class="preview-layout">
      <ul class="file-tree">${groups.map(([g, fs]) => `<li class="grp">${esc(g)}</li>${fs.map(f => {
        const is = issuesBy(f.path);
        const badge = is.some(i => i.level === 'error') ? '<span class="badge chip error">要修正</span>' : is.some(i => i.level === 'warning') ? '<span class="badge chip partial">確認</span>' : f.edited ? '<span class="badge chip">編集済</span>' : '';
        return `<li><button data-f="${esc(f.path)}" class="${f.path === selectedFile ? 'on' : ''}">${esc(f.path)}${badge}</button></li>`;
      }).join('')}`).join('')}</ul>
      <div>
        ${issuesBy(selectedFile).length ? `<ul class="issues">${issuesBy(selectedFile).map(i => `<li class="${i.level}">${esc(i.message)}</li>`).join('')}</ul>` : ''}
        <textarea class="editor" id="editor" spellcheck="false">${esc(cur?.content || '')}</textarea>
        <div class="row" style="margin-top:4px"><span class="small muted">直接編集できます。編集内容は出力に反映されます。</span><span class="spacer"></span><button class="btn small" id="recheck">再検証</button></div>
      </div></div>`;
  } else if (previewTab === 'issues') {
    body = (state.issues || []).length
      ? `<ul class="issues">${state.issues.map(i => `<li class="${i.level}"><span class="path">${esc(i.path)}</span>${esc(i.message)}</li>`).join('')}</ul>`
      : '<div class="notice ok">問題は見つかりませんでした。</div>';
  } else {
    body = `<p class="small muted">ツールに依存しない中間表現です。ここを直して「作り直す」と、全ファイルに反映されます（ファイルの手直しは失われます）。</p>
      <textarea class="editor" id="ir-editor" spellcheck="false">${esc(JSON.stringify(state.ir, null, 2))}</textarea>
      <div class="row" style="margin-top:4px"><span class="spacer"></span><button class="btn" id="rebuild">中間表現からファイルを作り直す</button></div>`;
  }

  main.innerHTML = `<h2>確認・出力</h2>
    <div class="tabs">
      <button data-tab="files" class="${previewTab === 'files' ? 'on' : ''}">ファイル（${state.files.length}）</button>
      <button data-tab="issues" class="${previewTab === 'issues' ? 'on' : ''}">検証結果（${errs ? `要修正${errs}・` : ''}確認${warns}）</button>
      <button data-tab="ir" class="${previewTab === 'ir' ? 'on' : ''}">中間表現</button>
    </div>
    ${body}
    <div class="output-actions">
      <button class="btn primary" id="dl-zip">zipでダウンロード</button>
      ${folderWriteSupported() ? '<button class="btn" id="write-folder">プロジェクトフォルダに書き込む</button>' : ''}
      <span class="small muted" style="align-self:center">出力後は Git にコミットするか Box で共有してください。</span>
    </div>`;

  main.querySelector('.tabs').onclick = e => {
    const b = e.target.closest('[data-tab]');
    if (b) { previewTab = b.dataset.tab; render(); }
  };
  main.querySelector('.file-tree')?.addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (b) { selectedFile = b.dataset.f; render(); }
  });
  main.querySelector('#editor')?.addEventListener('input', e => {
    cur.content = e.target.value;
    cur.edited = true;
    saveState(500);
  });
  main.querySelector('#recheck')?.addEventListener('click', () => { revalidate(); saveState(); render(); toast('検証しました'); });
  main.querySelector('#rebuild')?.addEventListener('click', async () => {
    let raw;
    try { raw = JSON.parse(main.querySelector('#ir-editor').value); } catch (e) { toast(`JSONとして読み取れません: ${e.message}`, 6000); return; }
    if (!(await confirmDialog('ファイルを作り直す', '<p>ファイルへの手直しは失われます。続けますか？</p>', '作り直す'))) return;
    const ir = normalizeIr(raw, { team: settings.team, hearing: state.hearing, mode: state.mode, workType: state.workType, targets: state.targets });
    const { files, issues } = renderHarness({ ir, targetsDef, state: { ...state, materials }, team: settings.team, profile });
    Object.assign(state, { ir, files, issues });
    previewTab = 'files';
    saveState();
    render();
    toast('作り直しました');
  });
  main.querySelector('#dl-zip').onclick = async () => {
    if (!(await checkErrorsBeforeOutput())) return;
    const name = safeFileName(state.ir.meta.name);
    const blob = await buildZip(state.files, '');
    downloadBlob(blob, `${name}-harness.zip`);
    toast('ダウンロードしました。展開して、中身をプロジェクトのルートに置いてください。', 5000);
  };
  main.querySelector('#write-folder')?.addEventListener('click', writeToFolder);
}

async function checkErrorsBeforeOutput() {
  revalidate();
  const errs = state.issues.filter(i => i.level === 'error');
  if (!errs.length) return true;
  return confirmDialog('要修正の項目があります', `<ul class="issues">${errs.map(i => `<li class="error"><span class="path">${esc(i.path)}</span>${esc(i.message)}</li>`).join('')}</ul><p>このまま出力しますか？</p>`, 'このまま出力');
}

async function writeToFolder() {
  if (!(await checkErrorsBeforeOutput())) return;
  let dir;
  try { dir = await pickProjectFolder(); } catch (e) { if (e.name !== 'AbortError') toast(`フォルダを開けませんでした: ${e.message}。zipでのダウンロードをお使いください。`, 7000); return; }
  const existing = (await findExisting(dir, state.files)).filter(x => !x.same);
  if (existing.length) {
    const ok = await confirmDialog('既存のファイルを上書きします',
      `<p>次のファイルは既にあります。元のファイルは「.bak-日時」を付けて残します。</p><ul class="small">${existing.map(x => `<li><code>${esc(x.path)}</code></li>`).join('')}</ul>`, '上書きする');
    if (!ok) return;
  }
  try {
    const written = await writeFiles(dir, state.files, { backup: true });
    toast(`${dir.name} に${written.length}ファイルを書き込みました`, 5000);
  } catch (e) {
    toast(`書き込めませんでした: ${e.message}`, 7000);
  }
}

// ---------------------------------------------------------------- 起動
async function reloadSettings() {
  settings = await loadSettings();
  profile = activeProfile(settings);
}

async function init() {
  await reloadSettings();
  targetsDef = await (await fetch(chrome.runtime.getURL('templates/targets.json'))).json();
  state = (await db.get(db.STORES.session, 'current')) || newState();
  materials = await db.getAll(db.STORES.materials);

  $('#btn-options').onclick = () => chrome.runtime.openOptionsPage();
  $('#btn-open-tab').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  // 既に広い画面（タブ）で開いているときは「タブで開く」を隠す
  $('#btn-open-tab').hidden = window.innerWidth > 700;
  $('#btn-new').onclick = async () => {
    const ok = await confirmDialog('最初からやり直す', `<p>作業中の内容${materials.length ? `と取り込んだ資料（${materials.length}件）` : ''}を消去します。生成履歴は残ります。</p>`, '消去して始める', { danger: true });
    if (!ok) return;
    await db.clear(db.STORES.materials);
    materials = [];
    state = newState();
    genLog = [];
    saveState();
    render();
  };
  $('#btn-back').onclick = () => {
    const steps = visibleSteps();
    const i = steps.findIndex(s => s.id === state.step);
    if (i > 0) go(steps[i - 1].id);
  };
  $('#btn-next').onclick = () => {
    const steps = visibleSteps();
    const i = steps.findIndex(s => s.id === state.step);
    if (i < steps.length - 1) go(steps[i + 1].id);
  };

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'materials-updated') {
      db.getAll(db.STORES.materials).then(list => {
        materials = list;
        if (state.step === 'materials' || state.step === 'gaps') render();
        autoAnalyze();
      });
    }
  });
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes['hb.settings']) { await reloadSettings(); render(); }
  });
  render();
}

init().catch(e => {
  document.body.innerHTML = `<div class="notice error" style="margin:12px">起動に失敗しました: ${esc(e.message)}</div>`;
});
