// 機密情報・個人情報らしき文字列の検出とマスク。
// 認証情報（キー、トークン、パスワード、接続文字列）は送信前に自動でマスクする。
// 個人情報（メールアドレス、電話番号）は警告を出し、ユーザーがマスクするか選べる。

export const SECRET_PATTERNS = [
  { id: 'private-key', label: '秘密鍵', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: 'aws-access-key', label: 'AWSアクセスキー', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', label: 'GitHubトークン', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { id: 'gitlab-token', label: 'GitLabトークン', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', label: 'Slackトークン', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'openai-key', label: 'APIキー（sk-形式）', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'jwt', label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'bearer', label: 'Bearerトークン', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { id: 'url-credentials', label: '認証情報付きURL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s/]+/gi },
  {
    id: 'assignment',
    label: 'パスワード・キーの代入',
    // password = "xxx" / api_key: xxx / SECRET=xxx など。値の部分だけをマスクする
    re: /\b((?:[A-Za-z0-9_]*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|credential)[A-Za-z0-9_]*)\s*[:=]\s*)(["']?)([^\s"'`,;()[\]{}]{6,})\2(?![\w(.[])/gi,
    valueGroup: 3,
  },
];

const PLACEHOLDER_RE = /^(x+|\*+|<.*>|\$\{.*\}|your[-_ ]?.*|changeme|dummy.*|example.*|sample.*|placeholder.*|\[MASKED.*)$/i;

export const PII_PATTERNS = [
  { id: 'email', label: 'メールアドレス', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { id: 'phone-jp', label: '電話番号', re: /(?<!\d)0\d{1,4}-\d{1,4}-\d{3,4}(?!\d)/g },
  { id: 'mynumber', label: 'マイナンバーらしき12桁', re: /(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/g },
];

// 取り込まない（自動除外する）ファイル名
const SECRET_FILE_RES = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\.[a-z]+)?$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)secrets?(\.[a-z]+)?$/i,
  /\.tfstate(\.backup)?$/i,
];

export function isSecretFile(path) {
  const p = String(path || '').replace(/\\/g, '/');
  if (/(^|\/)\.env\.(example|sample|template)$/i.test(p)) return false;
  return SECRET_FILE_RES.some(re => re.test(p));
}

function scan(text, patterns) {
  const found = [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const value = m[p.valueGroup || 0] || m[0];
      found.push({ id: p.id, label: p.label, index: m.index, value, sample: preview(value) });
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  return found;
}

function preview(s) {
  const t = String(s);
  if (t.length <= 6) return '***';
  return `${t.slice(0, 3)}…${t.slice(-2)}`;
}

export function findSecrets(text) {
  // プレースホルダー（xxx、<your-key>、${VAR} など）は除外
  return scan(String(text || ''), SECRET_PATTERNS)
    .filter(f => !PLACEHOLDER_RE.test(f.value))
    .map(({ value, ...rest }) => rest);
}

export function findPii(text) {
  return scan(String(text || ''), PII_PATTERNS);
}

export function maskSecrets(text) {
  let out = String(text || '');
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...args) => {
      const m = args[0];
      if (p.valueGroup) {
        const prefix = args[1];
        const quote = args[2] || '';
        const value = args[3];
        if (PLACEHOLDER_RE.test(value)) return m;
        return `${prefix}${quote}[MASKED]${quote}`;
      }
      return `[MASKED:${p.label}]`;
    });
  }
  return out;
}

export function maskPii(text) {
  let out = String(text || '');
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, `[MASKED:${p.label}]`);
  }
  return out;
}

// 資料1件を検査し、認証情報はマスク済みのテキストと警告を返す
export function sanitizeMaterialText(text) {
  const secrets = findSecrets(text);
  const pii = findPii(text);
  return {
    text: secrets.length ? maskSecrets(text) : text,
    warnings: [
      ...summarize(secrets, '自動でマスクしました'),
      ...summarize(pii, '含まれています。必要なら「個人情報をマスク」を押してください'),
    ],
    secretCount: secrets.length,
    piiCount: pii.length,
  };
}

function summarize(found, suffix) {
  const byLabel = new Map();
  for (const f of found) byLabel.set(f.label, (byLabel.get(f.label) || 0) + 1);
  return [...byLabel].map(([label, n]) => `${label}が${n}件${suffix}`);
}
