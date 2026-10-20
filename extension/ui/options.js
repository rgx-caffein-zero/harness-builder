// オプション画面: チーム設定ファイル、LiteLLM接続先、設定のバックアップ、生成履歴

import * as db from '../lib/db.js';
import {
  loadSettings, saveSettings, activeProfile, defaultProfile, parseTeamSettings, applyTeamToProfile,
  exportSettings, importSettingsBackup, originPatterns, TEAM_SETTINGS_KIND,
} from '../lib/settings.js';
import { createLlmClient } from '../lib/llm.js';
import { buildZip, downloadBlob, safeFileName } from '../lib/output.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let settings;
let editingId;

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function downloadJson(obj, name) {
  downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), name);
}

function readFileJson(input) {
  return new Promise((resolve, reject) => {
    input.onchange = async () => {
      const f = input.files[0];
      input.value = '';
      if (!f) return;
      try { resolve(JSON.parse(await f.text())); } catch (e) { reject(new Error(`JSONとして読み込めません: ${e.message}`)); }
    };
    input.click();
  });
}

// ------------------------------------------------ チーム設定
function renderTeam() {
  const t = settings.team;
  const el = $('#team-view');
  if (!t) {
    el.innerHTML = '<div class="notice info">チーム設定ファイルは読み込まれていません。許可リストがないため、どのサイトからも資料を取り込めます。</div>';
    return;
  }
  el.innerHTML = `<table class="team-table">
    <tr><th>チーム名</th><td>${esc(t.teamName || '（なし）')}</td></tr>
    <tr><th>LiteLLM</th><td>${esc(t.litellm.baseUrl || '（指定なし）')}</td></tr>
    <tr><th>モデル</th><td>生成: ${esc(t.litellm.models.generate || '-')} ／ 分類: ${esc(t.litellm.models.classify || '-')} ／ 画像: ${esc(t.litellm.models.vision || '-')}</td></tr>
    <tr><th>取り込みを許可するサイト</th><td>${t.allowedDomains.length ? t.allowedDomains.map(esc).join('<br>') : '（制限なし）'}</td></tr>
    <tr><th>チーム共通ルール</th><td>${t.commonRules.length ? `<ol>${t.commonRules.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : '（なし）'}</td></tr>
    <tr><th>禁止パス</th><td>${t.forbiddenPaths.map(esc).join(', ') || '（なし）'}</td></tr>
    <tr><th>既定の出力先</th><td>${t.defaultTargets.map(x => (x === 'claude' ? 'Claude Code' : 'Codex')).join('、') || '両方'}</td></tr>
    <tr><th>出力言語</th><td>${t.outputLanguage === 'en' ? '英語' : '日本語'}</td></tr>
  </table>`;
}

const SAMPLE_TEAM = {
  kind: TEAM_SETTINGS_KIND,
  version: 1,
  teamName: '〇〇課 開発チーム',
  litellm: {
    baseUrl: 'https://litellm.example.internal',
    models: { generate: 'azure-gpt-4.1', classify: 'azure-gpt-4.1-mini', vision: 'azure-gpt-4.1' },
  },
  allowedDomains: ['confluence.example.co.jp', '*.sharepoint.com', 'backlog.example.co.jp'],
  commonRules: [
    '顧客の個人情報（氏名・連絡先・住所）を成果物やログに出力しない',
    '本番環境への接続・デプロイは行わず、手順の提示にとどめる',
  ],
  forbiddenPaths: ['.env', 'secrets/', 'config/production/'],
  defaultTargets: ['claude', 'codex'],
  outputLanguage: 'ja',
};

// ------------------------------------------------ 接続先
const PROFILE_FIELDS = [
  { k: 'name', label: '名前', type: 'text', placeholder: '例: 〇〇課 共通キー / 案件A 専用キー' },
  { k: 'baseUrl', label: 'エンドポイント', type: 'url', placeholder: 'https://litellm.example.internal', hint: 'LiteLLMプロキシのURL（/v1 は省略可）' },
  { k: 'apiKey', label: 'APIキー', type: 'password', placeholder: 'sk-...' },
  { k: 'models.generate', label: '生成用モデル', type: 'text', list: true, hint: 'ハーネス本体を作るモデル（高性能なもの）' },
  { k: 'models.classify', label: '分類・要約用モデル', type: 'text', list: true, hint: '資料の要点抽出用。空なら生成用モデルを使います' },
  { k: 'models.vision', label: '画像解析用モデル', type: 'text', list: true, hint: '画像を読めるモデル。空なら生成用モデルを使います' },
  { k: 'maxInputChars', label: '1回に送る資料の最大文字数', type: 'number', hint: '超える資料は分割して要約します' },
  { k: 'maxOutputTokens', label: '最大出力トークン', type: 'number', hint: '生成が途中で切れる場合は増やしてください' },
  { k: 'priceInputPer1M', label: '入力の単価（100万トークンあたり、任意）', type: 'number', hint: '概算コストの表示に使います' },
  { k: 'priceOutputPer1M', label: '出力の単価（100万トークンあたり、任意）', type: 'number' },
];

const getK = (obj, k) => k.split('.').reduce((o, x) => (o == null ? o : o[x]), obj);
function setK(obj, k, v) {
  const ks = k.split('.');
  let o = obj;
  ks.slice(0, -1).forEach(x => { o[x] = o[x] || {}; o = o[x]; });
  o[ks[ks.length - 1]] = v;
}

function renderProfiles() {
  const sel = $('#profile-select');
  sel.innerHTML = settings.profiles.map(p => `<option value="${p.id}" ${p.id === editingId ? 'selected' : ''}>${esc(p.name || '(名前なし)')}${p.id === settings.activeProfileId ? '（使用中）' : ''}</option>`).join('');
  const p = settings.profiles.find(x => x.id === editingId) || settings.profiles[0];
  editingId = p.id;
  $('#profile-form').innerHTML = `<div class="grid2">${PROFILE_FIELDS.map(f => {
    const v = getK(p, f.k);
    return `<label class="field"><span>${esc(f.label)}</span>
      <input type="${f.type}" name="${f.k}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.list ? 'list="model-list"' : ''} ${f.type === 'number' ? 'step="any"' : ''}>
      ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
  }).join('')}</div>
    <label class="small"><input type="checkbox" name="useJsonMode" ${p.useJsonMode !== false ? 'checked' : ''}> JSONモード（response_format）を使う（対応していないモデルでは自動で外します）</label>
    <datalist id="model-list"></datalist>`;
}

function readProfileForm() {
  const p = { ...(settings.profiles.find(x => x.id === editingId)) };
  p.models = { ...p.models };
  const form = $('#profile-form');
  for (const f of PROFILE_FIELDS) {
    const raw = form.elements[f.k].value.trim();
    let v = raw;
    if (f.type === 'number') v = raw === '' ? null : Number(raw);
    setK(p, f.k, v);
  }
  p.useJsonMode = form.elements.useJsonMode.checked;
  if (p.maxInputChars == null || p.maxInputChars < 2000) p.maxInputChars = 24000;
  if (p.maxOutputTokens == null || p.maxOutputTokens < 1000) p.maxOutputTokens = 16000;
  return p;
}

function originsFor(url) {
  try {
    const proto = new URL(url).protocol;
    return originPatterns([url]).filter(o => o.startsWith(proto));
  } catch {
    return [];
  }
}

// ------------------------------------------------ 履歴
async function renderHistory() {
  const list = (await db.getAll(db.STORES.history)).reverse();
  const el = $('#history');
  if (!list.length) { el.innerHTML = '<li class="muted small">まだ生成していません。</li>'; return; }
  el.innerHTML = list.map(h => `<li data-id="${h.id}">
    <div class="name"><strong>${esc(h.name)}</strong><div class="muted small">${new Date(h.createdAt).toLocaleString('ja-JP')} ・ ${h.mode === 'specific' ? '業務特化' : '汎用'} ・ ${(h.targets || []).map(t => (t === 'claude' ? 'Claude Code' : 'Codex')).join('、')} ・ ${h.files.length}ファイル</div></div>
    <button class="btn small" data-act="zip">zip</button>
    <button class="btn small danger" data-act="del">削除</button></li>`).join('');
  el.onclick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('[data-id]').dataset.id;
    const h = list.find(x => x.id === id);
    if (b.dataset.act === 'zip') downloadBlob(await buildZip(h.files), `${safeFileName(h.name)}-harness.zip`);
    if (b.dataset.act === 'del' && confirm(`「${h.name}」の履歴を削除しますか？`)) { await db.remove(db.STORES.history, id); renderHistory(); }
  };
}

// ------------------------------------------------ 起動
async function init() {
  settings = await loadSettings();
  editingId = settings.activeProfileId;
  const manifest = chrome.runtime.getManifest();
  let tdv = '';
  try { tdv = (await (await fetch(chrome.runtime.getURL('templates/targets.json'))).json()).version; } catch { /* 無視 */ }
  $('#ver').textContent = `バージョン ${manifest.version} ・ 出力形式の定義 ${tdv}`;
  renderTeam();
  renderProfiles();
  renderHistory();

  $('#team-import').onclick = async () => {
    try {
      const json = await readFileJson($('#team-file'));
      const { team, errors } = parseTeamSettings(json);
      if (!team) throw new Error(errors.join('\n'));
      if (errors.length) toast(`注意: ${errors.join(' / ')}`, 6000);
      settings.team = team;
      // 接続先に反映（キーは各自のものを残す）
      const idx = settings.profiles.findIndex(p => p.id === settings.activeProfileId);
      settings.profiles[idx] = applyTeamToProfile(settings.profiles[idx], team);
      await saveSettings(settings);
      renderTeam();
      renderProfiles();
      // アクセス許可はボタン操作の直後にしか求められないため、案内だけ出す
      toast('チーム設定を読み込みました。APIキーを入力して「保存」を押し、「許可リストのサイトへのアクセスを許可」も押してください。', 7000);
    } catch (e) {
      toast(e.message, 6000);
    }
  };
  $('#team-grant').onclick = async () => {
    const d = settings.team?.allowedDomains || [];
    if (!d.length) { toast('許可リストがありません（チーム設定ファイルで設定します）'); return; }
    const ok = await chrome.permissions.request({ origins: originPatterns(d) }).catch(() => false);
    toast(ok ? 'アクセスを許可しました' : '許可されませんでした');
  };
  $('#team-sample').onclick = () => downloadJson(SAMPLE_TEAM, 'team-settings.json');
  $('#team-clear').onclick = async () => {
    if (!settings.team || !confirm('チーム設定を外しますか？（接続先の設定は残ります）')) return;
    settings.team = null;
    await saveSettings(settings);
    renderTeam();
  };

  $('#profile-select').onchange = e => { editingId = e.target.value; renderProfiles(); };
  $('#profile-add').onclick = async () => {
    const p = defaultProfile();
    p.name = `接続先 ${settings.profiles.length + 1}`;
    if (settings.team) Object.assign(p, applyTeamToProfile(p, settings.team));
    settings.profiles.push(p);
    editingId = p.id;
    await saveSettings(settings);
    renderProfiles();
  };
  $('#profile-del').onclick = async () => {
    if (settings.profiles.length <= 1) { toast('最後の接続先は削除できません'); return; }
    const p = settings.profiles.find(x => x.id === editingId);
    if (!confirm(`「${p.name}」を削除しますか？`)) return;
    settings.profiles = settings.profiles.filter(x => x.id !== editingId);
    if (settings.activeProfileId === editingId) settings.activeProfileId = settings.profiles[0].id;
    editingId = settings.activeProfileId;
    await saveSettings(settings);
    renderProfiles();
  };
  $('#profile-save').onclick = async () => {
    const p = readProfileForm();
    // ユーザー操作の直後に接続先へのアクセス許可を求める
    const perm = originsFor(p.baseUrl).length ? chrome.permissions.request({ origins: originsFor(p.baseUrl) }).catch(() => false) : Promise.resolve(true);
    if (p.baseUrl && !/^https?:\/\//.test(p.baseUrl)) { toast('エンドポイントは http:// または https:// で始めてください'); return; }
    settings.profiles = settings.profiles.map(x => (x.id === p.id ? p : x));
    settings.activeProfileId = p.id;
    await saveSettings(settings);
    const granted = await perm;
    renderProfiles();
    $('#profile-msg').textContent = granted ? '保存しました（この接続先を使用中）' : '保存しました。接続先へのアクセスが許可されていないため、接続できない可能性があります。';
  };
  $('#profile-test').onclick = async () => {
    const p = readProfileForm();
    const origins = originsFor(p.baseUrl);
    const perm = origins.length ? chrome.permissions.request({ origins }).catch(() => false) : Promise.resolve(true);
    const msg = $('#profile-msg');
    msg.textContent = '接続を確認しています…';
    await perm;
    const client = createLlmClient(p);
    try {
      let models = [];
      try { models = await client.listModels(); } catch { /* 一覧が取れない環境もある */ }
      if (models.length) $('#model-list').innerHTML = models.map(m => `<option value="${esc(m)}">`).join('');
      if (p.models.generate) {
        const text = await client.chatText({ model: p.models.generate, messages: [{ role: 'user', content: 'OK とだけ返してください' }], maxTokens: 20 });
        msg.textContent = `接続できました（${p.models.generate} の応答: ${text.trim().slice(0, 20)}）${models.length ? ` ・ 利用できるモデル ${models.length}件` : ''}`;
      } else {
        msg.textContent = models.length ? `接続できました。利用できるモデル: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ' …' : ''}` : '生成用モデルを入力してください';
      }
    } catch (e) {
      msg.textContent = e.message;
    }
  };

  $('#backup-export').onclick = () => {
    const obj = exportSettings(settings, { includeKeys: $('#backup-keys').checked });
    downloadJson(obj, `harness-builder-settings-${new Date().toISOString().slice(0, 10)}.json`);
  };
  $('#backup-import').onclick = async () => {
    try {
      const obj = await readFileJson($('#backup-file'));
      settings = importSettingsBackup(obj, settings);
      await saveSettings(settings);
      editingId = settings.activeProfileId;
      renderTeam();
      renderProfiles();
      toast('設定をインポートしました。接続先の「保存」を押してアクセスを許可してください。', 5000);
    } catch (e) {
      toast(e.message, 6000);
    }
  };
}

init();
