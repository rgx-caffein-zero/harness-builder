// LiteLLM（OpenAI互換API）の呼び出し。Azure OpenAI / Bedrock の違いは LiteLLM のモデル名で吸収する。

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

export function chatUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new LlmError('LiteLLM のエンドポイントが設定されていません。オプション画面で設定してください。');
  if (/\/chat\/completions$/.test(b)) return b;
  if (!/\/v1$/.test(b)) b += '/v1';
  return `${b}/chat/completions`;
}

export function modelsUrl(baseUrl) {
  return chatUrl(baseUrl).replace(/\/chat\/completions$/, '/models');
}

// 文字数からトークン数をざっくり見積もる（日本語は1文字≒1トークン、英数字は4文字≒1トークン）
export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0, other = 0;
  for (const ch of String(text)) {
    if (ch.charCodeAt(0) < 128) ascii++; else other++;
  }
  return Math.ceil(ascii / 4 + other * 1.0);
}

// 画像1枚あたりの概算トークン（高解像度で約1,000前後）
export const IMAGE_TOKENS = 1100;

// LLMの応答からJSONを取り出す（```json ブロックや前後の説明文に対応）
export function extractJson(text) {
  if (text == null) throw new LlmError('LLMの応答が空です');
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* 続行 */ }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  throw new LlmError('LLMの応答をJSONとして読み取れませんでした', { body: String(text).slice(0, 2000) });
}

/**
 * LLM クライアントを作る。
 * profile: { baseUrl, apiKey, models, maxOutputTokens, useJsonMode }
 * fetchImpl: テスト用に差し替え可能
 */
export function createLlmClient(profile, { fetchImpl, onUsage } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const url = () => chatUrl(profile.baseUrl);

  async function rawChat({ model, messages, json = false, maxTokens, temperature = 0.2, signal }) {
    if (!model) throw new LlmError('使用するモデル名が設定されていません。オプション画面で設定してください。');
    const body = { model, messages, temperature };
    const mt = maxTokens || profile.maxOutputTokens;
    if (mt) body.max_tokens = mt;
    if (json && profile.useJsonMode !== false) body.response_format = { type: 'json_object' };
    const headers = { 'Content-Type': 'application/json' };
    if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;

    let res;
    try {
      res = await doFetch(url(), { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new LlmError(`LiteLLM に接続できません（${e.message}）。エンドポイントのURLと、オプション画面での接続許可を確認してください。`);
    }
    const text = await res.text();
    if (!res.ok) {
      // response_format 非対応のモデルなら、外して再試行
      if (json && body.response_format && res.status === 400 && /response_format|json_object|not supported/i.test(text)) {
        return rawChat({ model, messages, json: false, maxTokens, temperature, signal, _retried: true });
      }
      let msg = text;
      try { msg = JSON.parse(text)?.error?.message || text; } catch { /* そのまま */ }
      throw new LlmError(`LLM呼び出しに失敗しました（HTTP ${res.status}）: ${String(msg).slice(0, 500)}`, { status: res.status, body: text });
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new LlmError('LLMの応答がJSONではありません', { body: text.slice(0, 2000) }); }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const out = Array.isArray(content) ? content.map(c => c.text || '').join('') : (content ?? '');
    if (onUsage && data.usage) onUsage(data.usage);
    return { text: out, finishReason: choice?.finish_reason, usage: data.usage };
  }

  return {
    profile,
    async chatText(opts) {
      return (await rawChat(opts)).text;
    },
    async chatJson(opts) {
      const r = await rawChat({ ...opts, json: true });
      if (r.finishReason === 'length') {
        throw new LlmError('LLMの出力が上限で途中終了しました。オプション画面の「最大出力トークン」を増やすか、資料を減らしてください。');
      }
      return extractJson(r.text);
    },
    async listModels({ signal } = {}) {
      const headers = {};
      if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
      const res = await doFetch(modelsUrl(profile.baseUrl), { headers, signal });
      const text = await res.text();
      if (!res.ok) throw new LlmError(`モデル一覧の取得に失敗しました（HTTP ${res.status}）: ${text.slice(0, 300)}`, { status: res.status });
      const data = JSON.parse(text);
      return (data.data || []).map(m => m.id).filter(Boolean);
    },
  };
}

// 画像付きメッセージ（OpenAI互換のマルチモーダル形式）
export function imageMessage(text, dataUrls) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...dataUrls.map(u => ({ type: 'image_url', image_url: { url: u } })),
    ],
  };
}
