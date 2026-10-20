// 生成パイプライン: 資料の要点抽出 → 充足度 → 補完ヒアリング → 中間表現 → ファイル。
// ブラウザAPIに依存しないので、モックのLLMで単体テストできる。

import { digestMessages, consolidateMessages, questionMessages, irCoreMessages, irWorkflowMessages } from './prompts.js';
import { checklistFor, computeCoverage } from './checklist.js';
import { normalizeIr } from './ir.js';
import { templateIr, USE_CASES } from './templates.js';
import { buildFiles } from './adapters.js';
import { validateFiles } from './validate.js';
import { estimateTokens, IMAGE_TOKENS } from './llm.js';
import { KIND_LABEL } from './extract.js';

export function splitText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

const RANK = { none: 0, partial: 1, full: 2 };

function mergeDigests(parts) {
  const notes = {};
  const coverage = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.notes || {})) {
      const list = Array.isArray(v) ? v : [v];
      notes[k] = [...(notes[k] || []), ...list.map(String).filter(Boolean)];
    }
    for (const [k, v] of Object.entries(p.coverage || {})) {
      if (!(k in coverage) || (RANK[v] ?? 0) > (RANK[coverage[k]] ?? 0)) coverage[k] = v;
    }
  }
  return { summary: parts.map(p => p.summary).filter(Boolean).join(' / ').slice(0, 600), notes, coverage };
}

/** 資料1件の要点を抽出する */
export async function digestMaterial({ llm, material, workType, lang = 'ja', signal }) {
  const profile = llm.profile;
  const checklist = checklistFor(workType);
  const m = { ...material, kindLabel: KIND_LABEL[material.kind] || material.kind };
  let parts;
  if (m.imageDataUrl) {
    const model = profile.models.vision || profile.models.generate;
    if (!model) throw new Error('画像を読むモデル（ビジョン対応モデル）が設定されていません');
    parts = [await llm.chatJson({ model, messages: digestMessages({ material: m, checklist, workType, lang }), signal, maxTokens: 4000 })];
  } else {
    const model = profile.models.classify || profile.models.generate;
    const chunks = splitText(m.text, profile.maxInputChars || 24000);
    parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks.length > 1 ? { index: i + 1, total: chunks.length, text: chunks[i] } : null;
      parts.push(await llm.chatJson({ model, messages: digestMessages({ material: m, chunk, checklist, workType, lang }), signal, maxTokens: 4000 }));
    }
  }
  const merged = mergeDigests(parts);
  // チェックリストにない項目IDは捨てる
  const ids = new Set(checklist.map(c => c.id));
  for (const k of Object.keys(merged.notes)) if (!ids.has(k)) delete merged.notes[k];
  for (const k of Object.keys(merged.coverage)) if (!ids.has(k)) delete merged.coverage[k];
  return { ...merged, model: m.imageDataUrl ? (profile.models.vision || profile.models.generate) : (profile.models.classify || profile.models.generate), at: Date.now() };
}

/** 項目別の要点を集める */
export function collectNotes(materials, workType) {
  const checklist = checklistFor(workType);
  const byItem = {};
  for (const item of checklist) byItem[item.id] = [];
  for (const m of materials || []) {
    if (m.included === false || !m.digest?.notes) continue;
    for (const [id, points] of Object.entries(m.digest.notes)) {
      if (byItem[id] && points?.length) byItem[id].push({ source: m.name, points });
    }
  }
  return byItem;
}

function notesToText(byItem, checklist) {
  return checklist.map(item => {
    const entries = byItem[item.id] || [];
    if (!entries.length) return '';
    const body = entries.map(e => `[${e.source}]\n${e.points.map(p => `- ${p}`).join('\n')}`).join('\n');
    return `### ${item.label}（${item.id}）\n${body}`;
  }).filter(Boolean).join('\n\n');
}

/** 要点のテキストを作る。長すぎる場合はLLMで項目ごとに統合する */
export async function buildNotesText({ llm, materials, workType, lang = 'ja', budgetChars, signal, onProgress }) {
  const checklist = checklistFor(workType);
  const byItem = collectNotes(materials, workType);
  let text = notesToText(byItem, checklist);
  if (!budgetChars || text.length <= budgetChars || !llm) return text;
  const model = llm.profile.models.classify || llm.profile.models.generate;
  for (const item of checklist) {
    const entries = byItem[item.id];
    if (!entries || entries.length < 2) continue;
    onProgress?.(`要点を統合しています: ${item.label}`);
    const r = await llm.chatJson({ model, messages: consolidateMessages({ item, entries, lang }), signal, maxTokens: 6000 });
    byItem[item.id] = [{ source: '複数の資料を統合', points: (r.points || []).map(String) }];
    text = notesToText(byItem, checklist);
    if (text.length <= budgetChars) break;
  }
  return text;
}

/** 補完ヒアリングの質問を作る */
export async function generateQuestions({ llm, state, signal }) {
  const coverage = computeCoverage(state.workType, state.materials, state.answers, state.hearing);
  const notesText = (await buildNotesText({ materials: state.materials, workType: state.workType })).slice(0, 8000);
  const model = llm.profile.models.classify || llm.profile.models.generate;
  const r = await llm.chatJson({ model, messages: questionMessages({ coverage, hearing: state.hearing, workType: state.workType, lang: state.lang, notesText }), signal, maxTokens: 3000 });
  const ids = new Set(coverage.items.map(i => i.id));
  return (r.questions || []).filter(q => q.question).slice(0, 5).map((q, i) => ({
    id: `q${Date.now().toString(36)}${i}`,
    itemId: ids.has(q.itemId) ? q.itemId : coverage.items.find(x => x.status !== 'full')?.id,
    question: String(q.question),
    placeholder: String(q.placeholder || ''),
    answer: '',
  }));
}

function useCaseLabel(state) {
  const list = USE_CASES[state.workType === 'biz' ? 'biz' : 'dev'];
  return list.find(u => u.id === state.useCase)?.label || '';
}

function ctxFor(state, team, notesText) {
  return {
    mode: state.mode,
    workType: state.workType,
    useCaseLabel: useCaseLabel(state),
    hearing: state.hearing,
    answers: state.answers,
    team,
    notesText,
    lang: team?.outputLanguage || state.lang || 'ja',
    template: state.mode === 'general' ? templateIr({ workType: state.workType, useCase: state.useCase, hearing: state.hearing }) : null,
  };
}

/** 中間表現（IR）を生成する（2回に分けて呼ぶことで出力の途中切れを防ぐ） */
export async function generateIr({ llm, state, team, signal, onProgress }) {
  const profile = llm.profile;
  const model = profile.models.generate;
  if (!model) throw new Error('生成用のモデルが設定されていません');
  let notesText = '';
  if (state.mode === 'specific') {
    onProgress?.('資料の要点をまとめています');
    notesText = await buildNotesText({ llm, materials: state.materials, workType: state.workType, lang: state.lang, budgetChars: (profile.maxInputChars || 24000) * 2, signal, onProgress });
  }
  const ctx = ctxFor(state, team, notesText);
  onProgress?.('指示ファイルとルールを作っています（1/2）');
  const core = await llm.chatJson({ model, messages: irCoreMessages(ctx), signal });
  onProgress?.('作業手順と役割を作っています（2/2）');
  const wf = await llm.chatJson({ model, messages: irWorkflowMessages(ctx, core), signal });
  return normalizeIr({ ...core, workflows: wf.workflows, roles: wf.roles }, {
    team, hearing: state.hearing, mode: state.mode, workType: state.workType, targets: state.targets,
  });
}

/** LLMを使わずテンプレートだけで中間表現を作る（汎用ハーネス用） */
export function irFromTemplate({ state, team }) {
  const raw = templateIr({ workType: state.workType, useCase: state.useCase, hearing: state.hearing });
  return normalizeIr(raw, { team, hearing: state.hearing, mode: 'general', workType: state.workType, targets: state.targets });
}

/** IR → ファイル一式 + 検証結果 */
export function renderHarness({ ir, targetsDef, state, team, profile }) {
  const buildInfo = {
    generator: 'Harness Builder',
    generatedAt: new Date().toISOString(),
    mode: state.mode,
    workType: state.workType,
    useCase: state.useCase || null,
    targets: state.targets,
    scope: 'project',
    models: profile ? { ...profile.models } : null,
    targetsDefinitionVersion: targetsDef.version,
    hearing: state.hearing,
    answers: (state.answers || []).filter(a => a.answer).map(a => ({ question: a.question, answer: a.answer })),
    materials: (state.materials || []).filter(m => m.included !== false).map(m => ({ name: m.name, kind: m.kind, source: m.sourceUrl || null })),
  };
  const files = buildFiles(ir, targetsDef, { targets: state.targets, buildInfo, team });
  const issues = validateFiles(files, ir, targetsDef);
  return { files, issues };
}

/** トークン数とコストの概算 */
export function estimate({ state, profile }) {
  const included = (state.materials || []).filter(m => m.included !== false);
  const pending = included.filter(m => !m.digest);
  let digestIn = 0;
  for (const m of pending) digestIn += m.imageDataUrl ? IMAGE_TOKENS + 800 : estimateTokens(m.text) + 800;
  const digestOut = pending.length * 800;
  const notesChars = included.reduce((s, m) => s + JSON.stringify(m.digest?.notes || {}).length, 0) + pending.length * 1500;
  const ctxTokens = estimateTokens(JSON.stringify(state.hearing || {})) + Math.min(notesChars, (profile.maxInputChars || 24000) * 2) + 2500;
  const genIn = ctxTokens * 2 + 1500;
  const genOut = 7000;
  const input = digestIn + genIn;
  const output = digestOut + genOut;
  let cost = null;
  if (profile.priceInputPer1M != null && profile.priceOutputPer1M != null) {
    cost = (input / 1e6) * Number(profile.priceInputPer1M) + (output / 1e6) * Number(profile.priceOutputPer1M);
  }
  return { input, output, cost, pendingCount: pending.length };
}
