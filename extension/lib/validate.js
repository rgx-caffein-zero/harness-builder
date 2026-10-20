// 生成物の検証（出力前チェック）。
// level: error（出力前に直すべき） / warning（確認推奨） / info

import { findSecrets } from './secrets.js';

function parseFrontmatter(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) return { error: `frontmatter の行を読み取れません: ${line}` };
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { return { error: `${kv[1]} の値（"〜"）の書き方が正しくありません` }; }
    } else if (/^['|>]/.test(v)) {
      // 単引用符やブロック表記は簡易的に受け付ける
      v = v.replace(/^'|'$/g, '');
    } else if (/:\s/.test(v)) {
      return { error: `${kv[1]} の値に「: 」が含まれています。引用符で囲んでください` };
    }
    fields[kv[1]] = v;
  }
  return { fields };
}

// 生成器が出す範囲の TOML を簡易検証する
export function checkToml(text) {
  const errors = [];
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (/^\[[A-Za-z0-9_.\-" ]+\]$/.test(line)) return;
    const m = line.match(/^([A-Za-z0-9_\-."]+)\s*=\s*(.+)$/);
    if (!m) { errors.push(`${i + 1}行目: 「キー = 値」の形式ではありません`); return; }
    const v = m[2].replace(/\s+#.*$/, '').trim();
    const ok = /^"(?:[^"\\]|\\.)*"$/.test(v) || /^'[^']*'$/.test(v) || /^(true|false)$/.test(v)
      || /^[+-]?\d+(\.\d+)?$/.test(v) || /^\[.*\]$/.test(v) || /^\{.*\}$/.test(v);
    if (!ok) errors.push(`${i + 1}行目: 値「${v}」の書き方が正しくありません（文字列は "〜" で囲む）`);
  });
  return errors;
}

export function validateFiles(files, ir, targetsDef) {
  const issues = [];
  const add = (level, path, message) => issues.push({ level, path, message });
  const lim = targetsDef.limits || {};

  for (const f of files) {
    const text = f.content;
    if (f.kind === 'instructions') {
      const lines = text.split('\n').length;
      if (lim.instructionFileWarnLines && lines > lim.instructionFileWarnLines) {
        add('warning', f.path, `${lines}行あります。指示ファイルは毎回読み込まれるため、長すぎると効きにくくなります。詳細な手順はスキルへ移すことを検討してください。`);
      }
      if (lim.instructionFileWarnChars && text.length > lim.instructionFileWarnChars) {
        add('warning', f.path, `${text.length.toLocaleString()}文字あります。内容を絞ることを検討してください。`);
      }
    }
    if (f.kind === 'skill' || f.kind === 'agent') {
      const fm = parseFrontmatter(text);
      if (!fm) add('error', f.path, '先頭の frontmatter（--- で囲んだ name / description）がありません');
      else if (fm.error) add('error', f.path, fm.error);
      else {
        const { name, description } = fm.fields;
        if (!name) add('error', f.path, 'name がありません');
        else if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) add('error', f.path, `name「${name}」は英小文字・数字・ハイフンのみにしてください`);
        else if (lim.skillNameMax && name.length > lim.skillNameMax) add('error', f.path, `name が${lim.skillNameMax}文字を超えています`);
        if (f.kind === 'skill' && name) {
          const dir = f.path.split('/').slice(-2, -1)[0];
          if (dir !== name) add('error', f.path, `フォルダ名「${dir}」と name「${name}」が一致していません`);
        }
        if (!description) add('error', f.path, 'description がありません');
        else if (lim.skillDescriptionMax && description.length > lim.skillDescriptionMax) add('error', f.path, `description が${lim.skillDescriptionMax}文字を超えています`);
        else if (description.length < 20) add('warning', f.path, 'description が短すぎます。「いつ使うか」を具体的に書くと、エージェントが正しく使い分けられます。');
      }
    }
    if (f.path.endsWith('.json')) {
      try { JSON.parse(text); } catch (e) { add('error', f.path, `JSONとして正しくありません: ${e.message}`); }
    }
    if (f.path.endsWith('.toml')) {
      for (const e of checkToml(text)) add('error', f.path, e);
    }
    const secrets = findSecrets(text);
    if (secrets.length) add('error', f.path, `認証情報らしき文字列が含まれています（${[...new Set(secrets.map(s => s.label))].join('、')}）。削除してから出力してください。`);
  }

  // 内容の矛盾・不足
  const allow = ir.permissions.allowCommands || [];
  for (const d of ir.permissions.denyCommands || []) {
    const hit = allow.filter(a => a.startsWith(d));
    if (hit.length) add('warning', '(権限)', `「${d}」が禁止と許可の両方に含まれています: ${hit.join(', ')}`);
  }
  const ruleTexts = ir.rules.map(r => r.rule);
  for (const p of ir.prohibitions) {
    const same = ruleTexts.find(r => r.replace(/\s/g, '') === p.rule.replace(/\s/g, ''));
    if (same) add('warning', '(ルール)', `同じ内容がルールと禁止事項の両方にあります: ${p.rule}`);
  }
  if (!ir.overview.purpose) add('warning', '(内容)', '目的が空です。ヒアリングで目的を入力すると、指示の精度が上がります。');
  if (!ir.workflows.length) add('info', '(内容)', '作業手順（スキル）がありません。繰り返し行う作業があれば追加を検討してください。');
  if (ir.meta.workType !== 'biz' && !ir.context.commands.length) add('info', '(内容)', 'テスト・ビルドなどのコマンドがありません。分かっていればヒアリングで入力してください。');
  if (ir.rules.length > 30) add('warning', '(内容)', `ルールが${ir.rules.length}件あります。重要なものに絞ると守られやすくなります。`);

  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.level] - order[b.level]);
}
