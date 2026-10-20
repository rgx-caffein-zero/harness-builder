// 接続プロファイル（LiteLLM）とチーム設定ファイルの管理。
// APIキーは chrome.storage.local（このブラウザ内）にだけ保存し、エクスポート時は既定で除外する。

const KEY = 'hb.settings';

export const TEAM_SETTINGS_KIND = 'harness-builder-team-settings';

export function defaultProfile() {
  return {
    id: `p_${Date.now().toString(36)}`,
    name: '既定のLiteLLM',
    baseUrl: '',
    apiKey: '',
    models: { generate: '', classify: '', vision: '' },
    maxInputChars: 24000,      // 1回のLLM呼び出しに入れる資料の最大文字数（超えた分は分割して要約）
    maxOutputTokens: 16000,    // 生成時の最大出力トークン
    priceInputPer1M: null,     // 概算コスト表示用（任意。通貨はチームで決める）
    priceOutputPer1M: null,
    useJsonMode: true,         // response_format: json_object を送るか
  };
}

export function defaultSettings() {
  const p = defaultProfile();
  return {
    profiles: [p],
    activeProfileId: p.id,
    team: null, // チーム設定ファイルの中身（読み込み後）
  };
}

export async function loadSettings() {
  const data = await chrome.storage.local.get(KEY);
  const s = data[KEY];
  if (!s || !Array.isArray(s.profiles) || s.profiles.length === 0) return defaultSettings();
  return s;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ [KEY]: settings });
}

export function activeProfile(settings) {
  return settings.profiles.find(p => p.id === settings.activeProfileId) || settings.profiles[0];
}

// チーム設定ファイルの検証と正規化
export function parseTeamSettings(json) {
  const errors = [];
  let obj = json;
  if (typeof json === 'string') {
    try { obj = JSON.parse(json); } catch (e) { return { errors: [`JSONとして読み込めません: ${e.message}`] }; }
  }
  if (!obj || typeof obj !== 'object') return { errors: ['設定ファイルの形式が正しくありません'] };
  if (obj.kind && obj.kind !== TEAM_SETTINGS_KIND) errors.push(`kind が "${TEAM_SETTINGS_KIND}" ではありません`);
  const arr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
  const team = {
    kind: TEAM_SETTINGS_KIND,
    version: Number(obj.version) || 1,
    teamName: String(obj.teamName || ''),
    litellm: {
      baseUrl: String(obj.litellm?.baseUrl || ''),
      models: {
        generate: String(obj.litellm?.models?.generate || ''),
        classify: String(obj.litellm?.models?.classify || ''),
        vision: String(obj.litellm?.models?.vision || ''),
      },
    },
    allowedDomains: arr(obj.allowedDomains),
    commonRules: arr(obj.commonRules),
    forbiddenPaths: arr(obj.forbiddenPaths),
    defaultTargets: arr(obj.defaultTargets).filter(t => ['claude', 'codex'].includes(t)),
    outputLanguage: obj.outputLanguage === 'en' ? 'en' : 'ja',
  };
  if (team.litellm.baseUrl && !/^https?:\/\//.test(team.litellm.baseUrl)) {
    errors.push('litellm.baseUrl は http:// または https:// で始めてください');
  }
  return { team, errors };
}

// チーム設定をプロファイルへ反映（キーは上書きしない）
export function applyTeamToProfile(profile, team) {
  const p = { ...profile, models: { ...profile.models } };
  if (team.litellm.baseUrl) p.baseUrl = team.litellm.baseUrl;
  for (const k of ['generate', 'classify', 'vision']) {
    if (team.litellm.models[k]) p.models[k] = team.litellm.models[k];
  }
  return p;
}

// 設定のエクスポート（再インストール前のバックアップ用）
export function exportSettings(settings, { includeKeys = false } = {}) {
  const copy = JSON.parse(JSON.stringify(settings));
  if (!includeKeys) copy.profiles.forEach(p => { p.apiKey = ''; });
  return {
    kind: 'harness-builder-settings-backup',
    exportedAt: new Date().toISOString(),
    includeKeys,
    settings: copy,
  };
}

export function importSettingsBackup(obj, current) {
  if (!obj || obj.kind !== 'harness-builder-settings-backup' || !obj.settings) {
    throw new Error('Harness Builder の設定バックアップファイルではありません');
  }
  const incoming = obj.settings;
  // キーが空のプロファイルは、同じIDの既存キーを引き継ぐ
  const byId = new Map((current?.profiles || []).map(p => [p.id, p]));
  incoming.profiles = (incoming.profiles || []).map(p => ({
    ...defaultProfile(),
    ...p,
    apiKey: p.apiKey || byId.get(p.id)?.apiKey || '',
  }));
  if (!incoming.profiles.length) return defaultSettings();
  if (!incoming.profiles.some(p => p.id === incoming.activeProfileId)) {
    incoming.activeProfileId = incoming.profiles[0].id;
  }
  return incoming;
}

// URL が許可リストのドメインに含まれるか。許可リストが空なら制限なし。
export function isAllowedUrl(url, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) return true;
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return allowedDomains.some(d => {
    const dom = d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (dom.startsWith('*.')) {
      const base = dom.slice(2);
      return host === base || host.endsWith('.' + base);
    }
    return host === dom;
  });
}

// 許可リストから、権限リクエスト用の origin パターンを作る
export function originPatterns(urls) {
  const out = new Set();
  for (const u of urls) {
    if (!u) continue;
    const raw = /^https?:\/\//.test(u) ? u : `https://${u}`;
    try {
      const url = new URL(raw.replace('*.', 'wildcard-placeholder.'));
      const host = url.hostname.replace('wildcard-placeholder.', '*.');
      if (/^https?:\/\//.test(u)) {
        out.add(`${url.protocol}//${host}/*`);
      } else {
        out.add(`https://${host}/*`);
        out.add(`http://${host}/*`);
      }
    } catch { /* 無視 */ }
  }
  return [...out];
}
