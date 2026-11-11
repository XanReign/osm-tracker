/* database.js — IndexedDB katmanı (tracker sayfası kökeni) */
(function (g) {
  'use strict';
  const DB_NAME = 'osm5v5', VER = 2;
  const STORES = ['snapshots', 'matchdays', 'md', 'kv', 'logs'];
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, VER);
      r.onupgradeneeded = () => {
        // Sürüm 2: 'md' deposu (anahtar: savaşId:maçGünü). Mevcut veriler silinmez.
        const d = r.result, has = n => d.objectStoreNames.contains(n);
        if (!has('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id' });
        if (!has('matchdays')) d.createObjectStore('matchdays', { keyPath: 'matchday' });
        if (!has('kv')) d.createObjectStore('kv', { keyPath: 'key' });
        if (!has('logs')) d.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
        if (!has('md')) d.createObjectStore('md', { keyPath: 'k' });
      };
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const rq = fn(s);
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }

  const put = (store, val) => tx(store, 'readwrite', s => s.put(val));
  const get = (store, key) => tx(store, 'readonly', s => s.get(key));
  const all = store => tx(store, 'readonly', s => s.getAll());
  const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
  const clear = store => tx(store, 'readwrite', s => s.clear());

  function log(level, code, msg, extra) {
    return put('logs', { ts: Date.now(), level, code, msg: String(msg || ''), extra: extra || null }).catch(() => {});
  }

  async function exportAll() {
    const out = { app: 'osm5v5', version: 1, exportedAt: new Date().toISOString() };
    for (const s of STORES) out[s] = await all(s);
    return out;
  }

  async function importAll(data) {
    if (!data || data.app !== 'osm5v5') throw new Error('Geçersiz yedek dosyası');
    let n = 0;
    for (const s of STORES) {
      for (const item of (data[s] || [])) { await put(s, item); n++; }
    }
    return n;
  }

  g.OSMDB = { open, put, get, all, del, clear, log, exportAll, importAll };
})(window);
