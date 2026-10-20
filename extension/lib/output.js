// 出力: zip ダウンロード、またはプロジェクトフォルダへの直接書き込み（File System Access API）。

export async function buildZip(files, rootName = '', JSZipImpl = globalThis.JSZip) {
  const zip = new JSZipImpl();
  const prefix = rootName ? `${rootName}/` : '';
  for (const f of files) zip.file(prefix + f.path, f.content);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function safeFileName(s) {
  return String(s || 'harness').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'harness';
}

export function folderWriteSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export async function pickProjectFolder() {
  return window.showDirectoryPicker({ mode: 'readwrite', id: 'harness-project' });
}

async function getFileHandle(dir, path, create) {
  const segs = path.split('/').filter(Boolean);
  let d = dir;
  for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create });
  return d.getFileHandle(segs[segs.length - 1], { create });
}

// 上書きになるファイルを調べる
export async function findExisting(dir, files) {
  const existing = [];
  for (const f of files) {
    try {
      const h = await getFileHandle(dir, f.path, false);
      const cur = await (await h.getFile()).text();
      existing.push({ path: f.path, same: cur === f.content });
    } catch { /* 存在しない */ }
  }
  return existing;
}

export async function writeFiles(dir, files, { backup = true } = {}) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const written = [];
  for (const f of files) {
    if (backup) {
      try {
        const h = await getFileHandle(dir, f.path, false);
        const cur = await (await h.getFile()).text();
        if (cur !== f.content) {
          const bh = await getFileHandle(dir, `${f.path}.bak-${stamp}`, true);
          const bw = await bh.createWritable();
          await bw.write(cur);
          await bw.close();
        }
      } catch { /* 新規ファイル */ }
    }
    const h = await getFileHandle(dir, f.path, true);
    const w = await h.createWritable();
    await w.write(f.content);
    await w.close();
    written.push(f.path);
  }
  return written;
}
