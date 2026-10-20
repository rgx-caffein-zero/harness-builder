// 中間表現（IR）: ツールに依存しないハーネスの内容。
// LLM はこの形式で出力し、アダプタが Claude Code / Codex の各ファイルに変換する。

export const IR_VERSION = 1;

// LLM に渡す説明（プロンプト用）
export const IR_SCHEMA_TEXT = `{
  "meta": { "name": "プロジェクト・業務の名前", "summary": "1〜2文の概要", "language": "ja" },
  "overview": { "purpose": "目的", "deliverables": ["成果物"], "audience": "成果物の受け手・利用者" },
  "context": {
    "techStack": ["使用技術・使用ツール"],
    "structure": "ディレクトリ構成や資料の置き場所の説明（短く）",
    "commands": [{ "name": "テスト", "command": "npm test", "description": "いつ使うか" }],
    "glossary": [{ "term": "用語", "meaning": "意味" }]
  },
  "rules": [{ "category": "分類", "rule": "守るべきルール（命令形で具体的に）", "reason": "理由" }],
  "prohibitions": [{ "rule": "してはいけないこと", "reason": "理由" }],
  "workflows": [{
    "id": "kebab-case の英数字ID（例: create-report）",
    "name": "手順の名前",
    "description": "いつこの手順を使うか（スキルの発動条件になる。具体的に）",
    "inputs": ["必要な入力"],
    "steps": ["手順1", "手順2"],
    "outputs": ["成果物"],
    "checks": ["完了前の確認事項"],
    "examples": ["良い例の要点（資料の見本から）"]
  }],
  "roles": [{
    "id": "kebab-case の英数字ID（例: code-reviewer）",
    "name": "役割名",
    "description": "いつこの役割に任せるか",
    "responsibilities": ["やること"],
    "checklist": ["確認観点"],
    "readOnly": true
  }],
  "verification": [{ "name": "検証名", "how": "確認方法・コマンド" }],
  "cautions": [{ "pitfall": "よくある失敗", "avoid": "避け方" }],
  "permissions": {
    "level": "strict | standard | autonomous",
    "denyPaths": ["読み書きさせないパス（例: .env, secrets/）"],
    "denyCommands": ["実行させないコマンドの先頭部分（例: git push）"],
    "allowCommands": ["確認なしで実行してよい安全なコマンド（例: npm test）"]
  }
}`;

const arr = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const str = v => (v == null ? '' : typeof v === 'string' ? v.trim() : JSON.stringify(v));
const strList = v => arr(v).map(str).filter(Boolean);

export function slugify(s, fallback) {
  const slug = String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug && /^[a-z0-9]/.test(slug) ? slug : fallback;
}

function uniqueIds(items, prefix) {
  const seen = new Set();
  return items.map((it, i) => {
    let id = slugify(it.id, '') || slugify(it.name, '') || `${prefix}-${i + 1}`;
    let n = 2;
    const base = id;
    while (seen.has(id)) id = `${base}-${n++}`.slice(0, 64);
    seen.add(id);
    return { ...it, id };
  });
}

function dedupeBy(list, keyFn) {
  const seen = new Set();
  return list.filter(x => {
    const k = keyFn(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

/**
 * LLM の出力（多少崩れていてもよい）を正規化し、チーム共通ルールを必ず含める。
 */
export function normalizeIr(raw, { team, hearing = {}, mode, workType, targets } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const meta = r.meta || {};
  const ov = r.overview || {};
  const ctx = r.context || {};
  const perm = r.permissions || {};

  let rules = arr(r.rules).map(x => (typeof x === 'string' ? { category: '', rule: x, reason: '' } : {
    category: str(x.category), rule: str(x.rule), reason: str(x.reason),
  })).filter(x => x.rule);

  // チーム共通ルール（チーム設定ファイル）を必ず先頭に入れる
  const teamRules = (team?.commonRules || []).map(rule => ({ category: 'チーム共通', rule, reason: 'チーム共通ルール', team: true }));
  rules = dedupeBy([...teamRules, ...rules], x => norm(x.rule));

  const prohibitions = dedupeBy(arr(r.prohibitions).map(x => (typeof x === 'string' ? { rule: x, reason: '' } : {
    rule: str(x.rule), reason: str(x.reason),
  })).filter(x => x.rule), x => norm(x.rule));

  const workflows = uniqueIds(arr(r.workflows).map(w => ({
    id: str(w.id),
    name: str(w.name) || str(w.id),
    description: str(w.description),
    inputs: strList(w.inputs),
    steps: strList(w.steps),
    outputs: strList(w.outputs),
    checks: strList(w.checks),
    examples: strList(w.examples),
  })).filter(w => w.name && w.steps.length), 'workflow');

  const roles = uniqueIds(arr(r.roles).map(x => ({
    id: str(x.id),
    name: str(x.name) || str(x.id),
    description: str(x.description),
    responsibilities: strList(x.responsibilities),
    checklist: strList(x.checklist),
    readOnly: x.readOnly !== false,
  })).filter(x => x.name), 'role');

  const level = ['strict', 'standard', 'autonomous'].includes(perm.level) ? perm.level : (hearing.caution || 'standard');
  const denyPaths = dedupeBy([...strList(perm.denyPaths), ...(team?.forbiddenPaths || [])], x => x);
  const denyCommands = dedupeBy(strList(perm.denyCommands), x => x);
  const allowCommands = dedupeBy(strList(perm.allowCommands), x => x).filter(c => !denyCommands.some(d => c.startsWith(d)));

  return {
    irVersion: IR_VERSION,
    meta: {
      name: str(meta.name) || hearing.projectName || 'プロジェクト',
      summary: str(meta.summary),
      language: meta.language === 'en' || team?.outputLanguage === 'en' ? 'en' : 'ja',
      workType: workType || meta.workType || 'dev',
      mode: mode || meta.mode || 'general',
      targets: targets || ['claude', 'codex'],
    },
    overview: {
      purpose: str(ov.purpose),
      deliverables: strList(ov.deliverables),
      audience: str(ov.audience),
    },
    context: {
      techStack: strList(ctx.techStack),
      structure: str(ctx.structure),
      commands: arr(ctx.commands).map(c => (typeof c === 'string' ? { name: c, command: c, description: '' } : {
        name: str(c.name), command: str(c.command), description: str(c.description),
      })).filter(c => c.command),
      glossary: arr(ctx.glossary).map(g => ({ term: str(g.term), meaning: str(g.meaning) })).filter(g => g.term),
    },
    rules,
    prohibitions,
    workflows,
    roles,
    verification: arr(r.verification).map(v => (typeof v === 'string' ? { name: v, how: '' } : { name: str(v.name), how: str(v.how) })).filter(v => v.name || v.how),
    cautions: arr(r.cautions).map(c => (typeof c === 'string' ? { pitfall: c, avoid: '' } : { pitfall: str(c.pitfall), avoid: str(c.avoid) })).filter(c => c.pitfall),
    permissions: { level, denyPaths, denyCommands, allowCommands },
  };
}
