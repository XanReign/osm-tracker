// ==UserScript==
// @name         OSM 5v5 Auto Collector
// @namespace    osm5v5
// @version      1.0.0
// @description  OSM lig sayfasındaki görünen verileri okur, tracker sayfasına devreder.
// @match        https://*.onlinesoccermanager.com/*
// @match        https://onlinesoccermanager.com/*
// @match        *://*/osm-tracker/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // NOT: Bu betik CSS seçicisi varsaymaz. Sekmeleri ve satırları GÖRÜNEN METNE göre bulur.
  // Gerçek OSM DOM'u üzerinde doğrulanmamıştır; bkz. README "Doğrulama durumu".

  const IS_TRACKER = location.pathname.indexOf('/osm-tracker/') !== -1;
  const TABS = [
    ['league', 'LIG TABLOSU'],
    ['managers', 'MENAJER LISTESI'],
    ['squad', 'KADRO DEGERI'],
    ['goals', 'GOL']
  ];
  const COOLDOWN_MS = 5 * 60 * 1000;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toUpperCase();
  const getQ = () => { try { return JSON.parse(GM_getValue('queue', '[]')); } catch (e) { return []; } };
  const setQ = q => GM_setValue('queue', JSON.stringify(q.slice(-60)));
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'h' + (h >>> 0).toString(36) + str.length.toString(36);
  }

  // ---------- Tracker sayfası köprüsü ----------
  if (IS_TRACKER) {
    const post = o => { o.src = 'osm-collector'; window.postMessage(JSON.stringify(o), '*'); };
    window.addEventListener('message', e => {
      if (e.source !== window || typeof e.data !== 'string') return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (!m || m.src !== 'osm-tracker') return;
      if (m.type === 'GET_QUEUE') post({ type: 'QUEUE', queue: getQ() });
      if (m.type === 'ACK') {
        const ids = new Set(m.ids || []);
        setQ(getQ().filter(s => !ids.has(s.id)));
        post({ type: 'ACKED' });
      }
    });
    post({ type: 'READY' });
    return;
  }

  // ---------- OSM sayfası ----------
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function findTab(label) {
    const want = norm(label);
    let best = null;
    const nodes = document.querySelectorAll('a,button,li,div,span,p,h2,h3,label');
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (norm(el.innerText) !== want) continue;
      if (!best || best.contains(el)) best = el; // en iç eleman
    }
    return best;
  }

  async function waitFor(fn, timeout, step) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step || 500);
    }
    return null;
  }

  function settle(quiet, max) {
    quiet = quiet || 900; max = max || 10000;
    return new Promise(res => {
      let t, m;
      const done = () => { obs.disconnect(); clearTimeout(t); clearTimeout(m); res(); };
      const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      t = setTimeout(done, quiet);
      m = setTimeout(done, max);
    });
  }

  const NUM = /^[€$£]?\s*-?\d[\d.,\s]*\s*[KkMmBb]?\s*[€$£]?$/;

  // Satır sezgisi: ilk satır sıra numarası, son satır sayısal değer, 3-10 satırlık en iç eleman.
  function extractRows() {
    const cands = [];
    for (const el of document.querySelectorAll('tr,li,div,a,section')) {
      if (!el.getClientRects().length) continue;
      const txt = el.innerText;
      if (!txt || txt.length > 400) continue;
      const lines = txt.split('\n').map(s => s.trim()).filter(Boolean);
      if (lines.length < 3 || lines.length > 10) continue;
      if (!/^\d{1,3}$/.test(lines[0])) continue;
      if (!NUM.test(lines[lines.length - 1])) continue;
      cands.push({ el, lines });
    }
    const set = new Set(cands.map(c => c.el));
    const inner = cands.filter(c => ![...c.el.querySelectorAll('*')].some(d => set.has(d)));
    const seen = new Set();
    const rows = [];
    inner.forEach(c => {
      const L = c.lines;
      const texts = [], numsRaw = [];
      L.slice(1).forEach(l => (NUM.test(l) ? numsRaw : texts).push(l));
      const row = { rank: parseInt(L[0], 10), texts, numsRaw };
      const k = JSON.stringify(row);
      if (!seen.has(k)) { seen.add(k); rows.push(row); }
    });
    return rows;
  }

  let running = false;
  let statusEl = null;
  function setStatus(t) { GM_setValue('status', t); if (statusEl) statusEl.textContent = t; }

  function pushError(code, msg) {
    const q = getQ();
    q.push({ kind: 'error', id: 'err-' + hash(code + msg + Math.floor(Date.now() / 60000)), ts: Date.now(), error: { code, msg } });
    setQ(q);
  }

  async function collect(manual) {
    if (running) return;
    running = true;
    setStatus('Toplanıyor…');
    try {
      const first = await waitFor(() => findTab(TABS[0][1]), 20000);
      if (!first) {
        setStatus('Sekme bulunamadı (giriş yapılmamış / yanlış sayfa / HTML değişmiş olabilir)');
        pushError('TAB_NOT_FOUND', 'LIG TABLOSU sekmesi bulunamadı: ' + location.href);
        return;
      }
      const snap = { ts: Date.now(), url: location.href, tabs: {} };
      let prevSig = '';
      for (const [key, label] of TABS) {
        try {
          const el = findTab(label);
          if (!el) { snap.tabs[key] = { ok: false, error: 'TAB_NOT_FOUND', rows: [] }; continue; }
          el.click();
          await settle();
          const rows = extractRows();
          const raw = (document.body.innerText || '').slice(0, 3500);
          const sig = JSON.stringify(rows);
          if (!rows.length) snap.tabs[key] = { ok: false, error: 'NO_ROWS (satır sezgisi eşleşmedi)', rows: [], raw };
          else if (key !== 'league' && sig === prevSig) snap.tabs[key] = { ok: false, error: 'CONTENT_UNCHANGED (sekme değişmedi)', rows: [], raw };
          else { snap.tabs[key] = { ok: true, rows, raw }; prevSig = sig; }
        } catch (e) {
          snap.tabs[key] = { ok: false, error: 'EXCEPTION ' + e.message, rows: [] };
        }
      }
      const okKeys = Object.keys(snap.tabs).filter(k => snap.tabs[k].ok);
      const summary = {};
      Object.keys(snap.tabs).forEach(k => summary[k] = { ok: snap.tabs[k].ok, rows: snap.tabs[k].rows.length, error: snap.tabs[k].error || null });
      GM_setValue('lastRun', JSON.stringify({ ts: snap.ts, summary, sample: Object.keys(snap.tabs).reduce((o, k) => (o[k] = (snap.tabs[k].raw || '').slice(0, 800), o), {}) }));
      if (!okKeys.length) {
        setStatus('Hiçbir sekmeden veri alınamadı');
        pushError('NO_DATA', JSON.stringify(summary));
        return;
      }
      const contentOnly = {};
      okKeys.forEach(k => contentOnly[k] = snap.tabs[k].rows);
      snap.id = hash(JSON.stringify(contentOnly));
      const q = getQ();
      if (q.some(s => s.id === snap.id)) { setStatus('Aynı veri zaten kuyrukta'); return; }
      q.push(snap);
      setQ(q);
      GM_setValue('lastAuto', Date.now());
      const failed = Object.keys(snap.tabs).filter(k => !snap.tabs[k].ok);
      setStatus('Tamamlandı ' + new Date().toLocaleTimeString('tr-TR') + ' — ' + okKeys.length + '/4 sekme' + (failed.length ? ' (eksik: ' + failed.join(',') + ')' : ''));
      const url = GM_getValue('trackerUrl', '');
      if (url && GM_getValue('autoOpen', false)) GM_openInTab(url + '#sync', { active: true });
    } finally {
      running = false;
    }
  }

  // ---------- Küçük panel ----------
  function buildUI() {
    const base = 'position:fixed;z-index:2147483647;';
    const btn = document.createElement('button');
    btn.textContent = 'OSM';
    btn.style.cssText = base + 'left:6px;bottom:70px;width:44px;height:44px;border-radius:22px;border:0;background:#1a73e8;color:#fff;font:bold 12px sans-serif;opacity:.85';
    const box = document.createElement('div');
    box.style.cssText = base + 'left:6px;bottom:120px;background:rgba(17,17,17,.92);color:#fff;font:13px sans-serif;padding:10px;border-radius:10px;display:none;max-width:80vw';
    statusEl = document.createElement('div');
    statusEl.style.cssText = 'margin-bottom:8px';
    statusEl.textContent = GM_getValue('status', 'Hazır');
    box.appendChild(statusEl);
    const mk = (text, fn) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'display:block;width:100%;margin:4px 0;padding:8px;border:0;border-radius:6px;background:#333;color:#fff;font:13px sans-serif';
      b.onclick = () => { try { fn(b); } catch (e) { setStatus('Hata: ' + e.message); } };
      box.appendChild(b);
      return b;
    };
    mk('Şimdi topla', () => collect(true));
    const autoB = mk('', b => { GM_setValue('autoOn', !GM_getValue('autoOn', true)); refresh(); });
    const openB = mk('', b => { GM_setValue('autoOpen', !GM_getValue('autoOpen', false)); refresh(); });
    mk('Tracker adresini ayarla', () => {
      const v = prompt('Tracker sayfası adresi (…/osm-tracker/tracker.html):', GM_getValue('trackerUrl', ''));
      if (v !== null) GM_setValue('trackerUrl', v.trim());
    });
    mk('Tracker\'ı aç', () => { const u = GM_getValue('trackerUrl', ''); if (u) GM_openInTab(u + '#sync', { active: true }); else setStatus('Önce tracker adresini ayarla'); });
    mk('Tanılama çıktısını kopyala', () => {
      const t = GM_getValue('lastRun', '(henüz çalışmadı)');
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => setStatus('Tanılama kopyalandı'), () => prompt('Kopyala:', t));
      else prompt('Kopyala:', t);
    });
    function refresh() {
      autoB.textContent = 'Otomatik toplama: ' + (GM_getValue('autoOn', true) ? 'AÇIK' : 'KAPALI');
      openB.textContent = 'Bitince tracker\'ı aç: ' + (GM_getValue('autoOpen', false) ? 'AÇIK' : 'KAPALI');
    }
    refresh();
    btn.onclick = () => { box.style.display = box.style.display === 'none' ? 'block' : 'none'; };
    document.body.appendChild(box);
    document.body.appendChild(btn);
  }

  buildUI();
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('OSM: şimdi topla', () => collect(true));

  // SPA olabilir: sekmeler görününce, bekleme süresi dolduysa bir kez otomatik topla.
  setInterval(() => {
    if (running || !GM_getValue('autoOn', true)) return;
    if (Date.now() - GM_getValue('lastAuto', 0) < COOLDOWN_MS) return;
    if (findTab(TABS[0][1]) && findTab(TABS[3][1])) collect(false);
  }, 3000);
})();
