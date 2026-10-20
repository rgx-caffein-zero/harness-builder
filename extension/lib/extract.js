// 資料ファイルからテキスト・画像を取り出す。
// ブラウザ内で解析し、外部サーバーには送らない（LLMへ送るのは解析後のテキスト・画像のみ）。
// pdf.js / mammoth / SheetJS / JSZip はサイドパネルで読み込んだものを globalThis から使う。

export const CODE_EXTS = {
  py: 'Python', sql: 'SQL', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', vb: 'VB.NET', c: 'C', h: 'C', cpp: 'C++',
  cc: 'C++', hpp: 'C++', swift: 'Swift', m: 'Objective-C', r: 'R', pl: 'Perl', lua: 'Lua', dart: 'Dart',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
  vue: 'Vue', svelte: 'Svelte', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'Config', conf: 'Config',
  xml: 'XML', gradle: 'Gradle', tf: 'Terraform', hcl: 'HCL', proto: 'Protocol Buffers', graphql: 'GraphQL',
  ipynb: 'Jupyter Notebook', bas: 'VBA', vbs: 'VBScript', dockerfile: 'Dockerfile', makefile: 'Makefile',
};

export const TEXT_EXTS = ['md', 'markdown', 'txt', 'text', 'rst', 'adoc', 'log'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
export const DOC_EXTS = ['pdf', 'docx', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'pptx'];

export function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1) : '';
}

export function kindOf(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['xlsx', 'xlsm', 'xls', 'csv', 'tsv'].includes(ext)) return 'sheet';
  if (ext === 'pptx') return 'pptx';
  if (TEXT_EXTS.includes(ext)) return 'text';
  if (CODE_EXTS[ext]) return 'code';
  return 'unknown';
}

export const KIND_LABEL = {
  pdf: 'PDF', docx: 'Word', sheet: 'Excel/CSV', pptx: 'PowerPoint', text: 'テキスト', code: 'ソースコード',
  image: '画像', page: 'Webページ', selection: 'ページの選択範囲', paste: '貼り付けテキスト', tree: 'ディレクトリ構成',
};

// ---------- XML ユーティリティ（DOMParser に依存しない） ----------
export function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

// DrawingML の段落（<a:p>）ごとに <a:t> を連結する
export function drawingMlText(xml) {
  const paras = [];
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    const runs = [];
    const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>|<a:t\s*\/>|<a:br\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(m[1])) !== null) {
      if (t[0].startsWith('<a:br')) runs.push('\n');
      else if (t[1] != null) runs.push(decodeXmlEntities(t[1]));
    }
    const line = runs.join('').trim();
    if (line) paras.push(line);
  }
  return paras.join('\n');
}

function relsMap(xml) {
  const map = {};
  const re = /<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?\/?>/g;
  const re2 = /<Relationship\b[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"[^>]*?\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) map[m[1]] = m[2];
  while ((m = re2.exec(xml)) !== null) map[m[2]] = m[1];
  return map;
}

function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };

/**
 * PowerPoint（.pptx）を解析する。
 * 戻り値: { text, slides: [{ no, text, notes }], images: [{ name, slides:[no], mime, bytes }] }
 */
export async function extractPptx(arrayBuffer, JSZipImpl = globalThis.JSZip) {
  const zip = await JSZipImpl.loadAsync(arrayBuffer);
  const read = async p => (zip.file(p) ? zip.file(p).async('string') : null);

  // スライド順: presentation.xml の sldIdLst → rels
  let order = [];
  const pres = await read('ppt/presentation.xml');
  const presRels = await read('ppt/_rels/presentation.xml.rels');
  if (pres && presRels) {
    const rels = relsMap(presRels);
    const idRe = /<p:sldId\b[^>]*r:id="([^"]+)"/g;
    let m;
    while ((m = idRe.exec(pres)) !== null) {
      if (rels[m[1]]) order.push(resolvePath('ppt', rels[m[1]]));
    }
  }
  if (!order.length) {
    order = Object.keys(zip.files)
      .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  }

  const slides = [];
  const imageSlides = new Map();
  for (let i = 0; i < order.length; i++) {
    const path = order[i];
    const xml = await read(path);
    if (!xml) continue;
    const no = i + 1;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const relPath = `${dir}/_rels/${path.split('/').pop()}.rels`;
    const relXml = await read(relPath);
    let notes = '';
    if (relXml) {
      const rels = relsMap(relXml);
      for (const target of Object.values(rels)) {
        const full = resolvePath(dir, target);
        if (/notesSlides\/notesSlide\d+\.xml$/.test(full)) {
          const nx = await read(full);
          if (nx) notes = drawingMlText(nx).replace(/^\d+$/m, '').trim();
        } else if (/^ppt\/media\//.test(full)) {
          if (!imageSlides.has(full)) imageSlides.set(full, []);
          imageSlides.get(full).push(no);
        }
      }
    }
    slides.push({ no, text: drawingMlText(xml), notes });
  }

  const images = [];
  for (const [path, nos] of imageSlides) {
    const ext = extOf(path);
    if (!MIME[ext]) continue; // emf/wmf などは対象外
    const bytes = await zip.file(path).async('uint8array');
    images.push({ name: path.split('/').pop(), slides: nos, mime: MIME[ext], bytes });
  }

  const text = slides.map(s => {
    let t = `## スライド ${s.no}\n${s.text || '（テキストなし）'}`;
    if (s.notes) t += `\n\n[発表者ノート]\n${s.notes}`;
    return t;
  }).join('\n\n');
  return { text, slides, images };
}

export async function extractPdf(arrayBuffer) {
  const pdfjs = await import(chrome.runtime.getURL('vendor/pdfjs/pdf.min.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  // 拡張機能のCSPでは eval が使えないため、pdf.js の eval 経路を明示的に止める
  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const lines = [];
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ''; }
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(`## ページ ${i}\n${lines.map(l => l.trim()).filter(Boolean).join('\n')}`);
  }
  const text = pages.join('\n\n');
  const textChars = text.replace(/## ページ \d+/g, '').replace(/\s/g, '').length;
  return { text, pageCount: doc.numPages, scanned: textChars < doc.numPages * 20 };
}

export async function extractDocx(arrayBuffer, mammothImpl = globalThis.mammoth) {
  const r = await mammothImpl.extractRawText({ arrayBuffer });
  return { text: r.value.replace(/\n{3,}/g, '\n\n').trim() };
}

export function extractSheet(arrayBuffer, name, XLSXImpl = globalThis.XLSX) {
  const ext = extOf(name);
  let wb;
  if (ext === 'csv' || ext === 'tsv') {
    const text = new TextDecoder().decode(arrayBuffer);
    wb = XLSXImpl.read(text, { type: 'string', FS: ext === 'tsv' ? '\t' : ',' });
  } else {
    wb = XLSXImpl.read(new Uint8Array(arrayBuffer), { type: 'array' });
  }
  const parts = wb.SheetNames.map(sn => {
    const csv = XLSXImpl.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false }).replace(/^,+$/gm, '').trim();
    return `## シート「${sn}」\n${csv}`;
  });
  return { text: parts.join('\n\n') };
}

export function decodeText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // UTF-8 で読めなければ Shift_JIS として読む（社内の古いファイル対策）
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('shift_jis').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
  }
}

export function looksBinary(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer.slice(0, 8000));
  let zero = 0;
  for (const b of bytes) if (b === 0) zero++;
  return zero > 0;
}

export function notebookToText(json) {
  try {
    const nb = JSON.parse(json);
    return (nb.cells || []).map(c => {
      const src = Array.isArray(c.source) ? c.source.join('') : String(c.source || '');
      return c.cell_type === 'markdown' ? src : '```\n' + src + '\n```';
    }).join('\n\n');
  } catch {
    return json;
  }
}

// ---------- 画像（ブラウザ専用） ----------
export function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${mime};base64,${btoa(bin)}`;
}

// 長辺 maxSide px に縮小し JPEG/PNG の dataURL にする（トークン削減）
export async function normalizeImage(blob, maxSide = 1600) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const buf = new Uint8Array(await out.arrayBuffer());
  return { dataUrl: bytesToDataUrl(buf, 'image/jpeg'), width: w, height: h, bytes: buf.length };
}

/**
 * ファイル1つを解析して、資料（1件以上）を返す。PowerPoint は図を別の画像資料として切り出す。
 */
export async function extractFile(file, relPath) {
  const name = relPath || file.name;
  const kind = kindOf(name);
  const buf = await file.arrayBuffer();
  const base = { name, kind, size: file.size };
  switch (kind) {
    case 'pdf': {
      const r = await extractPdf(buf);
      const notes = r.scanned ? ['文字がほとんど取れませんでした（スキャンPDFの可能性）。ページを画像として取り込むと読み取れます。'] : [];
      return [{ ...base, text: r.text, notes }];
    }
    case 'docx':
      return [{ ...base, text: (await extractDocx(buf)).text }];
    case 'sheet':
      return [{ ...base, text: extractSheet(buf, name).text }];
    case 'pptx': {
      const r = await extractPptx(buf);
      const out = [{ ...base, text: r.text, notes: [`スライド${r.slides.length}枚`] }];
      for (const img of r.images) {
        const blob = new Blob([img.bytes], { type: img.mime });
        let norm;
        try { norm = await normalizeImage(blob); } catch { continue; }
        out.push({
          name: `${name} / ${img.name}（スライド${img.slides.join(',')}）`,
          kind: 'image',
          size: img.bytes.length,
          imageDataUrl: norm.dataUrl,
          parentName: name,
          // 小さい画像（アイコン・ロゴ）は既定で除外
          included: img.bytes.length >= 20000,
        });
      }
      return out;
    }
    case 'image': {
      const norm = await normalizeImage(file);
      return [{ ...base, imageDataUrl: norm.dataUrl }];
    }
    case 'text':
      return [{ ...base, text: decodeText(buf) }];
    case 'code': {
      if (looksBinary(buf)) return [];
      let text = decodeText(buf);
      if (extOf(name) === 'ipynb') text = notebookToText(text);
      return [{ ...base, text, language: CODE_EXTS[extOf(name)] }];
    }
    default: {
      if (looksBinary(buf)) throw new Error(`${name}: この形式には対応していません`);
      return [{ ...base, kind: 'text', text: decodeText(buf) }];
    }
  }
}
