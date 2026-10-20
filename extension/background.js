// バックグラウンド（Service Worker）
// - ツールバーのアイコンでサイドパネルを開く
// - 右クリックメニューから、閲覧中のページ・選択範囲・画像を資料として取り込む（7.1）

import { put, newId, STORES } from './lib/db.js';
import { loadSettings, isAllowedUrl } from './lib/settings.js';
import { sanitizeMaterialText } from './lib/secrets.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'hb-page', title: 'このページをハーネス資料に追加', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'hb-selection', title: '選択範囲をハーネス資料に追加', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'hb-image', title: 'この画像をハーネス資料に追加', contexts: ['image'] });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message }).catch?.(() => {});
}

// ページに注入して本文を取り出す関数（ページ側で実行される）
function pageExtractor(mode) {
  if (mode === 'selection') {
    return { title: document.title, url: location.href, text: String(window.getSelection() || '') };
  }
  const pick = document.querySelector('main, article, [role="main"], #main-content, #content, .wiki-content') || document.body;
  const clone = pick.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, nav, footer, header, aside, iframe, svg, form, [aria-hidden="true"]').forEach(n => n.remove());
  // 見出しと表を簡易的に Markdown 風にする
  clone.querySelectorAll('h1,h2,h3,h4').forEach(h => { h.textContent = `\n${'#'.repeat(Number(h.tagName[1]))} ${h.textContent.trim()}\n`; });
  clone.querySelectorAll('li').forEach(li => { li.textContent = `- ${li.textContent.trim()}`; });
  clone.querySelectorAll('tr').forEach(tr => {
    tr.textContent = '| ' + [...tr.children].map(c => c.textContent.trim().replace(/\s+/g, ' ')).join(' | ') + ' |\n';
  });
  const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: document.title, url: location.href, text };
}

// 画像を dataURL にする関数（ページ側で実行される）
async function imageExtractor(src) {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(out); });
  } catch (e) {
    return { error: String(e) };
  }
}

export async function captureFromTab(tab, mode, extra = {}) {
  const settings = await loadSettings();
  const allowed = settings.team?.allowedDomains || [];
  if (!isAllowedUrl(tab.url, allowed)) {
    throw new Error('このサイトは取り込み対象の許可リストに含まれていません（チーム設定ファイルで設定）。');
  }
  if (mode === 'image') {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: imageExtractor, args: [extra.srcUrl] });
    if (!result || result.error) throw new Error(`画像を取得できませんでした${result?.error ? `: ${result.error}` : ''}`);
    const name = `${tab.title || 'ページ'} の画像`;
    const material = { id: newId('m'), name, kind: 'image', imageDataUrl: result, sourceUrl: extra.srcUrl || tab.url, included: true, createdAt: Date.now(), warnings: ['画像に個人情報が写り込んでいないか確認してください'] };
    await put(STORES.materials, material);
    return material;
  }
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtractor, args: [mode] });
  if (!result?.text?.trim()) throw new Error('取り込めるテキストがありませんでした');
  const s = sanitizeMaterialText(result.text);
  const material = {
    id: newId('m'),
    name: mode === 'selection' ? `${result.title}（選択範囲）` : result.title || result.url,
    kind: mode === 'selection' ? 'selection' : 'page',
    text: s.text,
    sourceUrl: result.url,
    warnings: s.warnings,
    included: true,
    createdAt: Date.now(),
  };
  await put(STORES.materials, material);
  return material;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const mode = info.menuItemId === 'hb-selection' ? 'selection' : info.menuItemId === 'hb-image' ? 'image' : 'page';
  try {
    const m = await captureFromTab(tab, mode, { srcUrl: info.srcUrl });
    chrome.runtime.sendMessage({ type: 'materials-updated', id: m.id }).catch(() => {});
    chrome.action.setBadgeText({ text: '+1' });
    chrome.action.setBadgeBackgroundColor({ color: '#2f6f5e' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
    notify('資料に追加しました', `${m.name}${m.warnings?.length ? `\n${m.warnings.join('\n')}` : ''}`);
  } catch (e) {
    notify('取り込めませんでした', e.message || String(e));
  }
});

// サイドパネルからの「このページを取り込む」
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'capture-active-tab') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) throw new Error('対象のタブが見つかりません');
        const m = await captureFromTab(tab, msg.mode || 'page');
        sendResponse({ ok: true, id: m.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
  return false;
});
