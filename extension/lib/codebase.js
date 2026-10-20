// フォルダ（ソースコード一式）の取り込み。
// .gitignore・バイナリ・生成物・機密ファイルを除外し、構成ファイルと代表的なソースを優先して選ぶ。
// 件数・サイズの上限は設けない（ユーザーが確認画面で「すべて選択」もできる）。

import { isSecretFile } from './secrets.js';
import { kindOf, extOf, IMAGE_EXTS } from './extract.js';

export const DEFAULT_IGNORED_DIRS = [
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  'dist', 'build', 'out', 'target', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache',
  'coverage', '.gradle', '.idea', '.vscode', '.terraform', 'vendor', 'Pods', '.dart_tool', 'DerivedData',
];

const BINARY_EXTS = new Set([
  'zip', 'gz', 'tgz', 'bz2', '7z', 'rar', 'jar', 'war', 'ear', 'class', 'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'pyc', 'pyo', 'wasm', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mdb', 'accdb', 'iso', 'dmg', 'mp3', 'mp4',
  'mov', 'avi', 'wav', 'ogg', 'flac', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'ico', 'svgz', 'psd', 'ai', 'sketch',
  'fig', 'parquet', 'avro', 'pkl', 'pickle', 'npy', 'npz', 'h5', 'onnx', 'pt', 'ckpt', 'lock',
]);

const GENERATED_RES = [/\.min\.(js|css)$/i, /\.map$/i, /(^|\/)package-lock\.json$/i, /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i, /(^|\/)poetry\.lock$/i, /(^|\/)Cargo\.lock$/i, /(^|\/)composer\.lock$/i,
  /(^|\/)Gemfile\.lock$/i, /\.generated\./i, /_pb2\.py$/i, /\.pb\.go$/i];

// 優先して取り込む構成ファイル・文書
const PRIORITY_RES = [
  /(^|\/)README(\.[a-z]+)?$/i, /(^|\/)CONTRIBUTING(\.[a-z]+)?$/i, /(^|\/)ARCHITECTURE(\.[a-z]+)?$/i,
  /(^|\/)CLAUDE\.md$/i, /(^|\/)AGENTS\.md$/i, /(^|\/)docs?\/.+\.(md|txt|rst|adoc)$/i,
  /(^|\/)package\.json$/i, /(^|\/)tsconfig(\..+)?\.json$/i, /(^|\/)pyproject\.toml$/i, /(^|\/)requirements[^/]*\.txt$/i,
  /(^|\/)setup\.(py|cfg)$/i, /(^|\/)Pipfile$/i, /(^|\/)pom\.xml$/i, /(^|\/)build\.gradle(\.kts)?$/i,
  /(^|\/)settings\.gradle(\.kts)?$/i, /(^|\/)go\.mod$/i, /(^|\/)Cargo\.toml$/i, /(^|\/)Gemfile$/i,
  /(^|\/)composer\.json$/i, /\.csproj$/i, /\.sln$/i, /(^|\/)Makefile$/i, /(^|\/)Dockerfile[^/]*$/i,
  /(^|\/)docker-compose[^/]*\.ya?ml$/i, /(^|\/)compose\.ya?ml$/i, /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i, /(^|\/)Jenkinsfile$/i, /(^|\/)\.editorconfig$/i,
  /(^|\/)\.eslintrc[^/]*$/i, /(^|\/)eslint\.config\.[a-z]+$/i, /(^|\/)\.prettierrc[^/]*$/i, /(^|\/)ruff\.toml$/i,
  /(^|\/)\.flake8$/i, /(^|\/)\.pre-commit-config\.yaml$/i, /(^|\/)\.env\.(example|sample|template)$/i,
  /(^|\/)schema\.sql$/i, /(^|\/)(migrations?|ddl)\/[^/]+\.sql$/i, /\.gitignore$/i,
];

// ---------- .gitignore ----------
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i);
      if (j > i) { re += glob.slice(i, j + 1); i = j; } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return re;
}

export function parseGitignore(content, baseDir = '') {
  const rules = [];
  for (let line of String(content).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = globToRegExp(line);
    const prefix = baseDir ? baseDir.replace(/\/$/, '') + '/' : '';
    const pre = prefix.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // 判定対象はファイルのパスだけなので、ディレクトリ指定は「その配下にある」ことを必須にする
    const tail = dirOnly ? '/.*' : '(?:/.*)?';
    const re = anchored
      ? new RegExp(`^${pre}${body}${tail}$`)
      : new RegExp(`^${pre}(?:.*/)?${body}${tail}$`);
    rules.push({ re, negate, dirOnly });
  }
  return rules;
}

export function isIgnored(path, rules) {
  let ignored = false;
  for (const r of rules) {
    if (r.re.test(path)) ignored = !r.negate;
  }
  return ignored;
}

/**
 * フォルダ内のファイル一覧（File の配列、webkitRelativePath 付き）を分類する。
 * 戻り値: { root, candidates: [{ path, file, size, reason, selected, priority }], excluded: [{ path, reason }] }
 */
export async function scanFolder(files) {
  const list = Array.from(files).map(f => ({ file: f, path: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  const root = list.length ? list[0].path.split('/')[0] : '';
  const rel = p => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);

  // .gitignore を集める（ルート以下すべて）
  let rules = [];
  for (const { file, path } of list) {
    const r = rel(path);
    if (/(^|\/)\.gitignore$/.test(r)) {
      const dir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '';
      rules = rules.concat(parseGitignore(await file.text(), dir));
    }
  }

  const candidates = [];
  const excluded = [];
  for (const { file, path } of list) {
    const r = rel(path);
    const segs = r.split('/');
    const ext = extOf(r);
    let reason = null;
    if (segs.slice(0, -1).some(s => DEFAULT_IGNORED_DIRS.includes(s))) reason = '依存・生成物のフォルダ';
    else if (isSecretFile(r)) reason = '機密情報を含む可能性があるファイル（自動除外）';
    else if (isIgnored(r, rules)) reason = '.gitignore の対象';
    else if (BINARY_EXTS.has(ext)) reason = 'バイナリ';
    else if (GENERATED_RES.some(re => re.test(r))) reason = '生成物・ロックファイル';
    else if (IMAGE_EXTS.includes(ext)) reason = '画像（必要なら画像として個別に取り込み）';
    else if (kindOf(r) === 'unknown' && !PRIORITY_RES.some(re => re.test(r)) && segs[segs.length - 1].includes('.')) reason = '対応していない形式';
    if (reason) { excluded.push({ path: r, reason }); continue; }
    const priority = PRIORITY_RES.some(re => re.test(r));
    candidates.push({ path: r, file, size: file.size, priority, selected: false });
  }

  selectDefault(candidates);
  return { root, candidates, excluded };
}

// 既定の選択: 構成ファイル・文書はすべて、ソースはディレクトリごとに代表的なものを数件
export function selectDefault(candidates, perDir = 3) {
  const byDir = new Map();
  for (const c of candidates) {
    if (c.priority) { c.selected = true; continue; }
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(c);
  }
  for (const group of byDir.values()) {
    // テストファイルを1件は含める。残りは中程度のサイズを優先（極端に小さい・大きいものは代表になりにくい）
    const tests = group.filter(c => /(^|\/)(tests?|spec|__tests__)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]*$/i.test(c.path));
    const others = group.filter(c => !tests.includes(c));
    const ideal = 6000;
    others.sort((a, b) => Math.abs(Math.log((a.size + 1) / ideal)) - Math.abs(Math.log((b.size + 1) / ideal)));
    const pick = [...tests.slice(0, 1), ...others].slice(0, perDir);
    pick.forEach(c => { c.selected = true; });
  }
  return candidates;
}

// ディレクトリ構成のテキスト（深さ制限つき、除外したものは含めない）
export function treeText(root, paths, maxDepth = 4) {
  const tree = new Map(); // name -> Map（ディレクトリ） | null（ファイル）
  for (const p of paths) {
    const segs = p.split('/');
    let node = tree;
    for (let i = 0; i < segs.length; i++) {
      const isFile = i === segs.length - 1;
      if (i === maxDepth) {
        if (!node.has('…')) node.set('…', null);
        break;
      }
      if (isFile) {
        if (!node.has(segs[i])) node.set(segs[i], null);
      } else {
        if (!(node.get(segs[i]) instanceof Map)) node.set(segs[i], new Map());
        node = node.get(segs[i]);
      }
    }
  }
  const lines = [`${root || '.'}/`];
  const walk = (node, prefix) => {
    const keys = [...node.keys()].sort((a, b) => {
      const da = node.get(a) instanceof Map, db = node.get(b) instanceof Map;
      return da === db ? a.localeCompare(b) : (da ? -1 : 1);
    });
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      const child = node.get(k);
      const isDir = child instanceof Map;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${k}${isDir ? '/' : ''}`);
      if (isDir) walk(child, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(tree, '');
  return lines.join('\n');
}
