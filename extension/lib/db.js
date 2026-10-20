// IndexedDB の薄いラッパー。資料・作業中セッション・生成履歴をブラウザ内にだけ保存する。
// サイドパネル、オプション画面、バックグラウンド（Service Worker）から共通で使う。

const DB_NAME = 'harness-builder';
const DB_VERSION = 1;
export const STORES = {
  materials: 'materials', // 取り込んだ資料
  session: 'session',     // 作業中の状態（1件: id='current'）
  history: 'history',     // 生成履歴（再生成・再ダウンロード用）
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.materials)) {
        const s = db.createObjectStore(STORES.materials, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORES.session)) {
        db.createObjectStore(STORES.session, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.history)) {
        const h = db.createObjectStore(STORES.history, { keyPath: 'id' });
        h.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  return tx(store, 'readwrite', s => reqToPromise(s.put(value)));
}

export async function get(store, id) {
  return tx(store, 'readonly', s => reqToPromise(s.get(id)));
}

export async function getAll(store) {
  const all = await tx(store, 'readonly', s => reqToPromise(s.getAll()));
  return (all || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function remove(store, id) {
  return tx(store, 'readwrite', s => reqToPromise(s.delete(id)));
}

export async function clear(store) {
  return tx(store, 'readwrite', s => reqToPromise(s.clear()));
}

export function newId(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
