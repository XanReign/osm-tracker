/* google-sheets-api.js — Apps Script YOK. Doğrudan Sheets REST API + Google Identity Services. */
(function (g) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets';

  let _tok = null, _exp = 0;
  try {
    const s = JSON.parse(sessionStorage.getItem('osm_tok') || 'null');
    if (s && s.e > Date.now()) { _tok = s.t; _exp = s.e; }
  } catch (_) { /* yok say */ }

  const hasToken = () => !!_tok && Date.now() < _exp;

  function loadGIS() {
    if (g.google && g.google.accounts && g.google.accounts.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = () => res();
      s.onerror = () => rej(new Error('Google Identity Services yüklenemedi (ağ / engelleyici?)'));
      document.head.appendChild(s);
    });
  }

  // Kullanıcı hareketi (buton tıklaması) içinden çağrılmalı.
  function requestToken(clientId, prompt) {
    if (!clientId) return Promise.reject(new Error('OAuth Client ID ayarlanmamış'));
    return loadGIS().then(() => new Promise((res, rej) => {
      const c = g.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: r => {
          if (r.error) return rej(new Error('OAuth: ' + r.error));
          _tok = r.access_token;
          _exp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          try { sessionStorage.setItem('osm_tok', JSON.stringify({ t: _tok, e: _exp })); } catch (_) { /* yok say */ }
          res(_tok);
        },
        error_callback: e => rej(new Error('OAuth: ' + (e && e.type ? e.type : 'bilinmeyen hata')))
      });
      c.requestAccessToken({ prompt: prompt || '' });
    }));
  }

  async function api(method, url, body) {
    if (!hasToken()) throw new Error('Google token yok veya süresi doldu');
    const r = await fetch(url, {
      method,
      headers: { 'Authorization': 'Bearer ' + _tok, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) { /* yok say */ }
    if (!r.ok) throw new Error('Sheets API ' + r.status + ': ' + ((j && j.error && j.error.message) || txt.slice(0, 200)));
    return j;
  }

  async function create(title, names) {
    const j = await api('POST', API, { properties: { title, locale: 'en_US' }, sheets: [{ properties: { title: GLOBAL } }] });
    return j.spreadsheetId;
  }


  async function test(id) {
    const j = await api('GET', API + '/' + id + '?fields=properties.title,sheets.properties.title');
    return j.properties.title + ' (' + j.sheets.length + ' sayfa)';
  }

  const q = t => "'" + t + "'";

  // ================= Geniş yatay panel (savaş sayfası + GLOBAL STATS) =================
  const NC = 43, COLW = 34, GUT = 21, GUTW = 16;           // 21 + boşluk + 21 sütun: iki yarı yan yana
  const P = {
    bg: [0.06, 0.07, 0.09], card: [0.1, 0.12, 0.15], card2: [0.15, 0.17, 0.21], fg: [0.95, 0.96, 0.97], mut: [0.55, 0.59, 0.66],
    red: [0.93, 0.31, 0.33], blue: [0.28, 0.55, 0.98], redT: [0.19, 0.1, 0.11], blueT: [0.09, 0.14, 0.25],
    gold: [0.96, 0.77, 0.32], grn: [0.25, 0.73, 0.31], amb: [0.96, 0.65, 0.14], teal: [0.12, 0.33, 0.3]
  };
  const colr = t => ({ red: t[0], green: t[1], blue: t[2] });
  function fmtOf(s) {
    const f = {
      backgroundColor: colr(s.bg || P.bg), verticalAlignment: 'MIDDLE', horizontalAlignment: s.ha || 'CENTER',
      textFormat: { foregroundColor: colr(s.fg || P.fg), bold: !!s.b, italic: !!s.i, fontSize: s.sz || 9, fontFamily: 'Montserrat' },
      wrapStrategy: s.wrap ? 'WRAP' : 'CLIP'
    };
    if (s.nf) f.numberFormat = { type: 'NUMBER', pattern: s.nf };
    return f;
  }
  function Layout(sid) { this.sid = sid; this.rows = []; this.h = []; this.reqs = []; this.teamR = []; this.resR = []; this.growR = []; this.statR = []; this.gradR = []; this.zebraR = []; }
  Layout.prototype.add = function (h) { this.rows.push(new Array(NC).fill('')); this.h.push(h); return this.rows.length - 1; };
  Layout.prototype.rg = function (r0, r1, c0, c1) { return { sheetId: this.sid, startRowIndex: r0, endRowIndex: r1 + 1, startColumnIndex: c0, endColumnIndex: c1 + 1 }; };
  Layout.prototype.put = function (r, c, v) { this.rows[r][c] = v == null ? '' : v; };
  Layout.prototype.blk = function (r0, r1, c0, c1, style, merge) {
    const range = this.rg(r0, r1, c0, c1);
    if (merge && c1 > c0) this.reqs.push({ mergeCells: { range, mergeType: 'MERGE_ROWS' } });
    this.reqs.push({ repeatCell: { range, cell: { userEnteredFormat: fmtOf(style) }, fields: 'userEnteredFormat' } });
  };

  const DASH = '—', U = s => String(s).toUpperCase();
  const fd = d => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const fdt = d => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const M1 = v => (v == null ? null : Math.round(v / 1e5) / 10);
  const R2 = v => (v == null ? null : Math.round(v * 100) / 100);
  const nz = v => (v == null ? DASH : v);
  const colName = i => { let s = ''; i++; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  const NF_M = '#,##0.0"M"', NF_PCT = '+0.00"%";-0.00"%";0.00"%"', NF_SGN = '+0;-0;0';

  // Panel çizimi: bir bant içinde yan yana panellerin satırları ortaktır
  function band(L, panels, h) {
    const n = Math.max.apply(null, panels.map(p => p.n)), r0 = L.rows.length;
    for (let i = 0; i < n; i++) L.add(h);
    panels.forEach(p => p.draw(r0));
    return r0;
  }
  const gap = (L, h) => { L.add(h || 12); };
  function bar(L, r, c0, c1, text) { L.put(r, c0, '▌ ' + text); L.blk(r, r, c0, c1, { bg: P.card2, fg: P.gold, b: 1, sz: 8, ha: 'LEFT' }, 1); }

  // Gerçek sütunlu tablo: cols=[{w,label,ha,nf,b,fg,sz,wrap}]; yalnızca çok sütunlu alanlar birleştirilir
  function table(L, r0, c0, cols, rows) {
    const starts = []; let c = c0;
    cols.forEach(col => { starts.push(c); c += col.w; });
    cols.forEach((col, i) => L.put(r0, starts[i], col.label));
    L.blk(r0, r0, c0, c - 1, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
    const last = r0 + rows.length;
    cols.forEach((col, i) => { if (col.w > 1) L.reqs.push({ mergeCells: { range: L.rg(r0, last, starts[i], starts[i] + col.w - 1), mergeType: 'MERGE_ROWS' } }); });
    rows.forEach((row, ri) => row.forEach((v, i) => L.put(r0 + 1 + ri, starts[i], v)));
    if (rows.length) cols.forEach((col, i) => L.blk(r0 + 1, last, starts[i], starts[i] + col.w - 1, { bg: P.card, ha: col.ha || 'CENTER', b: col.b, fg: col.fg, sz: col.sz || 8, nf: col.nf, wrap: col.wrap }, 0));
    return { b0: r0 + 1, b1: last, starts, c1: c - 1 };
  }
  function note(L, r, c0, c1, text) { L.put(r, c0, text); L.blk(r, r, c0, c1, { bg: P.bg, fg: P.mut, i: 1, sz: 7, ha: 'LEFT', wrap: 1 }, 1); }

  // Yan yana karşılaştırma satırları: [KIRMIZI değer 6][etiket 9][MAVİ değer 6]
  function comparePanel(c0, title, redName, blueName, items, L0) {
    const p = { n: 2 + items.length };
    p.draw = r0 => {
      const L = L0, c1 = c0 + 20;
      bar(L, r0, c0, c1, title);
      L.put(r0 + 1, c0, redName); L.put(r0 + 1, c0 + 15, blueName);
      L.blk(r0 + 1, r0 + 1, c0, c0 + 5, { bg: P.redT, fg: P.red, b: 1, sz: 8 }, 1); L.blk(r0 + 1, r0 + 1, c0 + 6, c0 + 14, { bg: P.card2 }, 1); L.blk(r0 + 1, r0 + 1, c0 + 15, c1, { bg: P.blueT, fg: P.blue, b: 1, sz: 8 }, 1);
      items.forEach((it, i) => {
        const r = r0 + 2 + i;
        L.put(r, c0, nz(it.rv)); L.put(r, c0 + 6, it.label); L.put(r, c0 + 15, nz(it.bv));
        L.blk(r, r, c0, c0 + 5, { bg: P.redT, fg: P.red, b: 1, sz: 11, nf: it.nf }, 1);
        L.blk(r, r, c0 + 6, c0 + 14, { bg: P.card, fg: P.mut, b: 1, sz: 7 }, 1);
        L.blk(r, r, c0 + 15, c1, { bg: P.blueT, fg: P.blue, b: 1, sz: 11, nf: it.nf }, 1);
      });
    };
    return p;
  }
  // KPI bloğu (10 sütun): başlık, RED/BLUE başlığı, satırlar [etiket 4][RED 3][BLUE 3]; item.full = tek değer
  function kpiPanel(L0, c0, title, redName, blueName, items) {
    const p = { n: 2 + items.length };
    p.draw = r0 => {
      const L = L0, c1 = c0 + 9;
      L.put(r0, c0, title); L.blk(r0, r0, c0, c1, { bg: P.card2, fg: P.gold, b: 1, sz: 8, ha: 'LEFT' }, 1);
      L.put(r0 + 1, c0 + 4, redName); L.put(r0 + 1, c0 + 7, blueName);
      L.blk(r0 + 1, r0 + 1, c0, c0 + 3, { bg: P.card }, 1); L.blk(r0 + 1, r0 + 1, c0 + 4, c0 + 6, { bg: P.redT, fg: P.red, b: 1, sz: 7 }, 1); L.blk(r0 + 1, r0 + 1, c0 + 7, c1, { bg: P.blueT, fg: P.blue, b: 1, sz: 7 }, 1);
      items.forEach((it, i) => {
        const r = r0 + 2 + i;
        L.put(r, c0, it.label);
        L.blk(r, r, c0, c0 + 3, { bg: P.card, fg: P.mut, b: 1, sz: 7, ha: 'LEFT', wrap: 1 }, 1);
        if (it.full !== undefined) { L.put(r, c0 + 4, nz(it.full)); L.blk(r, r, c0 + 4, c1, { bg: P.card, fg: it.fg || P.fg, b: 1, sz: 10 }, 1); }
        else {
          L.put(r, c0 + 4, nz(it.rv)); L.put(r, c0 + 7, nz(it.bv));
          L.blk(r, r, c0 + 4, c0 + 6, { bg: P.redT, fg: P.red, b: 1, sz: 12, nf: it.nf }, 1); L.blk(r, r, c0 + 7, c1, { bg: P.blueT, fg: P.blue, b: 1, sz: 12, nf: it.nf }, 1);
        }
      });
    };
    return p;
  }
  // Liderlik / liste paneli (GLOBAL STATS): 21 sütun: # 1 | menajer 4 | G 2 | 5 metrik (3,3,3,3,2)
  function boardPanel(L0, c0, title, heads, rows, nfs, noteText) {
    const p = { n: 2 + Math.max(rows.length, 1) + (noteText ? 1 : 0) };
    p.draw = r0 => {
      const L = L0, c1 = c0 + 20;
      bar(L, r0, c0, c1, title);
      if (!rows.length) { L.put(r0 + 1, c0, 'No data yet.'); L.blk(r0 + 1, r0 + 1, c0, c1, { bg: P.card, fg: P.mut, sz: 8, ha: 'LEFT' }, 1); return; }
      const cols = [{ w: 1, label: '#', fg: P.gold, b: 1 }, { w: 4, label: 'MANAGER', ha: 'LEFT', b: 1, wrap: 1 }, { w: 2, label: 'G-LEVEL', fg: P.mut },
        { w: 3, label: heads[0], b: 1, sz: 9, nf: nfs[0] }, { w: 3, label: heads[1], nf: nfs[1] }, { w: 3, label: heads[2], nf: nfs[2] }, { w: 3, label: heads[3], nf: nfs[3] }, { w: 2, label: heads[4], nf: nfs[4] }];
      const t = table(L, r0 + 1, c0, cols, rows);
      L.zebraR.push(L.rg(t.b0, t.b1, c0, c1));
      if (noteText) note(L, r0 + 2 + rows.length, c0, c1, noteText);
    };
    return p;
  }

  // ---------------------------------------------------------------- SAVAŞ SAYFASI
  function buildWar(m, sid) {
    const L = new Layout(sid), war = m.war, curN = m.curN, nm = m.names, now = m.now;
    const matches = m.matches || [];
    const rows = OSMWars.managerRows(war, curN, matches);
    const okM = matches.filter(x => x.status === 'OK'), shown = matches.filter(x => x.status !== 'DISMISSED').sort((a, b) => b.ts - a.ts || (a.manager < b.manager ? -1 : 1));
    const nReview = matches.filter(x => x.status === 'REVIEW').length;
    const status = war.status || 'LIVE', stCol = status === 'COMPLETED' ? P.gold : status === 'ARCHIVED' ? P.mut : P.grn;
    const T = t => rows.filter(r => r.team === t);
    const sumT = (t, f) => { const rs = T(t); return rs.length && rs.every(r => r[f] != null) ? rs.reduce((a, r) => a + r[f], 0) : null; };
    const totT = (t, f) => T(t).reduce((a, r) => a + (r[f] || 0), 0);
    const pts = { R: sumT('RED', 'pts'), B: sumT('BLUE', 'pts') };
    const gf = { R: sumT('RED', 'gf'), B: sumT('BLUE', 'gf') }, ga = { R: sumT('RED', 'ga'), B: sumT('BLUE', 'ga') };
    const yc = { R: sumT('RED', 'yc'), B: sumT('BLUE', 'yc') }, rc = { R: sumT('RED', 'rc'), B: sumT('BLUE', 'rc') };
    const sqv = { R: sumT('RED', 'current'), B: sumT('BLUE', 'current') }, sq0 = { R: sumT('RED', 'start'), B: sumT('BLUE', 'start') };
    const sub = (a, b) => (a == null || b == null ? null : a - b);
    const add = (a, b) => (a == null || b == null ? null : a + b);
    const growth = t => (sq0[t] != null && sq0[t] > 0 && sqv[t] != null ? R2((sqv[t] - sq0[t]) / sq0[t] * 100) : null);
    const avgSq = t => (T(t === 'R' ? 'RED' : 'BLUE').length && sqv[t] != null ? M1(sqv[t] / T(t === 'R' ? 'RED' : 'BLUE').length) : null);
    const wins = { R: totT('RED', 'wins'), B: totT('BLUE', 'wins') };
    const gap2 = pts.R == null || pts.B == null ? null : pts.R - pts.B;
    const R = nm.RED, B = nm.BLUE;

    // ---- A) Geniş başlık (3 satır, sabitlenir)
    let r = L.add(26);
    L.put(r, 0, 'OSM 5v5 · WAR DASHBOARD'); L.put(r, 22, '● ' + status);
    L.blk(r, r, 0, 20, { sz: 7, fg: P.mut, ha: 'LEFT', b: 1 }, 1); L.blk(r, r, 21, 21, { bg: P.bg }, 0); L.blk(r, r, 22, 42, { sz: 9, b: 1, fg: stCol, ha: 'RIGHT' }, 1);
    r = L.add(54);
    L.put(r, 0, U(war.league || 'UNKNOWN LEAGUE')); L.put(r, 22, U(R)); L.put(r, 32, 'vs'); L.put(r, 34, U(B));
    L.blk(r, r, 0, 20, { sz: 17, b: 1, ha: 'LEFT', wrap: 1 }, 1); L.blk(r, r, 21, 21, { bg: P.bg }, 0);
    L.blk(r, r, 22, 31, { sz: 15, b: 1, fg: P.red, ha: 'RIGHT' }, 1); L.blk(r, r, 32, 33, { sz: 9, fg: P.mut }, 1); L.blk(r, r, 34, 42, { sz: 15, b: 1, fg: P.blue, ha: 'LEFT' }, 1);
    r = L.add(26);
    const chips = [[0, 9, 'WAR ID  ' + war.id], [10, 17, 'STARTED  ' + (m.startTs ? fd(m.startTs) : DASH)], [18, 28, 'UPDATED  ' + fd(now) + ', ' + new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })], [29, 35, 'MANAGERS  ' + rows.length], [36, 42, 'MATCHES  ' + okM.length]];
    chips.forEach(([a, b, t]) => { L.put(r, a, t); L.blk(r, r, a, b, { bg: P.card, fg: P.mut, sz: 7, b: 1, ha: 'LEFT' }, 1); });
    gap(L, 10);

    // ---- B) Yatay KPI blokları
    const lead = gap2 == null ? DASH : gap2 === 0 ? 'LEVEL' : U(gap2 > 0 ? R : B) + ' +' + Math.abs(gap2);
    band(L, [
      kpiPanel(L, 0, 'TEAM SCORE', U(R), U(B), [{ label: 'POINTS', rv: pts.R, bv: pts.B }, { label: 'DIFFERENCE', rv: gap2, bv: gap2 == null ? null : -gap2, nf: NF_SGN }, { label: 'LEADING', full: lead, fg: P.gold }]),
      kpiPanel(L, 11, 'GOALS', U(R), U(B), [{ label: 'SCORED', rv: gf.R, bv: gf.B }, { label: 'GOAL DIFF', rv: sub(gf.R, ga.R), bv: sub(gf.B, ga.B), nf: NF_SGN }, { label: 'TOTAL GOALS', full: add(gf.R, gf.B) }]),
      kpiPanel(L, 22, 'SQUAD VALUE', U(R), U(B), [{ label: 'TOTAL', rv: M1(sqv.R), bv: M1(sqv.B), nf: NF_M }, { label: 'AVG / MANAGER', rv: avgSq('R'), bv: avgSq('B'), nf: NF_M }, { label: 'GROWTH %', rv: growth('R'), bv: growth('B'), nf: NF_PCT }]),
      kpiPanel(L, 33, 'CARDS', U(R), U(B), [{ label: 'YELLOW', rv: yc.R, bv: yc.B }, { label: 'RED', rv: rc.R, bv: rc.B }, { label: 'TOTAL', rv: add(yc.R, rc.R), bv: add(yc.B, rc.B) }])
    ], 30);
    gap(L, 12);

    // ---- C) Takım karşılaştırması | D) Son maç sonuçları (yan yana)
    const recent = shown.slice(0, 9);
    const matchCols = [{ w: 3, label: 'DATE', fg: P.mut }, { w: 4, label: 'MANAGER', ha: 'LEFT', b: 1, wrap: 1 }, { w: 3, label: 'CLUB', ha: 'LEFT', fg: P.mut }, { w: 2, label: 'TEAM', b: 1 }, { w: 1, label: 'RES', b: 1 }, { w: 1, label: 'PTS', b: 1 }, { w: 1, label: 'GF' }, { w: 1, label: 'GA' }, { w: 1, label: 'YC' }, { w: 1, label: 'RC' }, { w: 3, label: 'SQUAD', nf: NF_M }];
    const mrow = x => [fdt(x.ts), x.manager, x.club, x.team, x.status === 'REVIEW' ? '?' : x.result, x.points == null ? DASH : x.points, nz(x.gf), nz(x.ga), nz(x.yc), nz(x.rc), x.squad == null ? DASH : M1(x.squad)];
    const matchPanel = { n: 2 + Math.max(recent.length, 1) };
    matchPanel.draw = r0 => {
      bar(L, r0, 22, 42, 'MATCH RESULTS  ·  LATEST ' + recent.length);
      if (!recent.length) { L.put(r0 + 1, 22, 'No match recorded yet. A match is saved as soon as a manager\'s points / goals change between two snapshots.'); L.blk(r0 + 1, r0 + 1, 22, 42, { bg: P.card, fg: P.mut, sz: 8, ha: 'LEFT', wrap: 1 }, 1); return; }
      const t = table(L, r0 + 1, 22, matchCols, recent.map(mrow));
      L.teamR.push(L.rg(t.b0, t.b1, t.starts[3], t.starts[3] + 1)); L.resR.push(L.rg(t.b0, t.b1, t.starts[4], t.starts[4])); L.zebraR.push(L.rg(t.b0, t.b1, 22, 42));
    };
    band(L, [comparePanel(0, 'TEAM COMPARISON', U(R), U(B), [
      { label: 'TOTAL POINTS', rv: pts.R, bv: pts.B }, { label: 'MATCH WINS', rv: wins.R, bv: wins.B }, { label: 'GOALS SCORED', rv: gf.R, bv: gf.B }, { label: 'GOALS CONCEDED', rv: ga.R, bv: ga.B },
      { label: 'GOAL DIFFERENCE', rv: sub(gf.R, ga.R), bv: sub(gf.B, ga.B), nf: NF_SGN }, { label: 'SQUAD VALUE', rv: M1(sqv.R), bv: M1(sqv.B), nf: NF_M }, { label: 'SQUAD GROWTH', rv: growth('R'), bv: growth('B'), nf: NF_PCT },
      { label: 'YELLOW CARDS', rv: yc.R, bv: yc.B }, { label: 'RED CARDS', rv: rc.R, bv: rc.B }], L), matchPanel], 28);
    gap(L, 12);

    // ---- E) Menajer performans tablosu | Savaş liderleri (yan yana)
    const mCols = [{ w: 1, label: '#', fg: P.mut }, { w: 3, label: 'MANAGER', ha: 'LEFT', b: 1, wrap: 1 }, { w: 2, label: 'TEAM', b: 1 }, { w: 1, label: 'G', fg: P.mut }, { w: 1, label: 'PTS', b: 1, sz: 10, fg: P.gold },
      { w: 1, label: 'P' }, { w: 1, label: 'W' }, { w: 1, label: 'D' }, { w: 1, label: 'L' }, { w: 1, label: 'GF' }, { w: 1, label: 'GA' }, { w: 1, label: 'GD', b: 1, nf: NF_SGN },
      { w: 2, label: 'START', fg: P.mut, nf: NF_M }, { w: 2, label: 'NOW', nf: NF_M }, { w: 2, label: 'GROWTH', b: 1, nf: NF_PCT }];
    const order = new Map(curN.league.map(x => [OSMScore.K(x.manager), x.rank]));
    const srt = rows.slice().sort((a, b) => order.get(a.key) - order.get(b.key));
    const mTable = srt.map(x => [order.get(x.key), x.name, x.team, x.g || 'N/A', nz(x.pts), x.matches, x.wins, x.draws, x.losses, nz(x.gf), nz(x.ga), x.gf != null && x.ga != null ? x.gf - x.ga : DASH,
      x.start != null ? M1(x.start) : 'UNKNOWN', x.current != null ? M1(x.current) : DASH, x.growth != null ? R2(x.growth) : 'UNKNOWN']);
    const mgrPanel = { n: 3 + Math.max(mTable.length, 1) };
    mgrPanel.draw = r0 => {
      bar(L, r0, 0, 20, 'MANAGER PERFORMANCE');
      const t = table(L, r0 + 1, 0, mCols, mTable);
      L.teamR.push(L.rg(t.b0, t.b1, t.starts[2], t.starts[2] + 1)); L.growR.push(L.rg(t.b0, t.b1, t.starts[11], t.starts[11]), L.rg(t.b0, t.b1, t.starts[14], t.starts[14] + 1));
      L.gradR.push({ range: L.rg(t.b0, t.b1, t.starts[9], t.starts[9]), color: P.teal }); L.zebraR.push(L.rg(t.b0, t.b1, 0, 20));
      note(L, r0 + 2 + mTable.length, 0, 20, 'PTS = OSM league points. P / W / D / L count the individual matches recorded by the tracker since tracking started. GF / GA = season goals scored / conceded.');
    };
    const lead3 = (title, list, vf) => list.slice(0, 3).map((x, i) => [i + 1, x.name + ' (' + (x.team === 'RED' ? R : B) + ')', vf(x)]);
    const known = f => rows.filter(x => x[f] != null);
    const boards = [
      ['TOP SCORER', lead3('', known('gf').sort((a, b) => b.gf - a.gf), x => x.gf + ' goals')],
      ['BEST DEFENCE', lead3('', known('ga').sort((a, b) => a.ga - b.ga), x => x.ga + ' conceded')],
      ['BEST SQUAD BUILDER', lead3('', known('growth').sort((a, b) => b.growth - a.growth), x => (x.growth > 0 ? '+' : '') + R2(x.growth) + '%')]
    ];
    const ldPanel = { n: 14 };
    ldPanel.draw = r0 => {
      bar(L, r0, 22, 42, 'WAR LEADERS');
      boards.forEach((bd, bi) => {
        const rh = r0 + 1 + bi * 4;
        L.put(rh, 22, bd[0]); L.blk(rh, rh, 22, 42, { bg: P.card2, fg: P.fg, b: 1, sz: 7, ha: 'LEFT' }, 1);
        for (let k = 0; k < 3; k++) {
          const rr = rh + 1 + k, it = bd[1][k];
          L.put(rr, 22, it ? it[0] : ''); L.put(rr, 24, it ? it[1] : (k === 0 ? 'UNKNOWN / no data yet' : '')); L.put(rr, 34, it ? it[2] : '');
          L.blk(rr, rr, 22, 23, { bg: P.card, fg: P.gold, b: 1, sz: 8 }, 1); L.blk(rr, rr, 24, 33, { bg: P.card, b: 1, sz: 8, ha: 'LEFT' }, 1); L.blk(rr, rr, 34, 42, { bg: P.card, fg: P.mut, sz: 8 }, 1);
        }
      });
      if (nReview) note(L, r0 + 13, 22, 42, nReview + ' record(s) need review (multi-match change or inconsistent data). They are listed in the historical table and NOT counted in statistics.');
    };
    band(L, [mgrPanel, ldPanel], 28);
    gap(L, 14);

    // ---- F) Geçmiş maç verisi (tam genişlik, ayrı bölüm)
    r = L.add(28); bar(L, r, 0, 42, 'HISTORICAL MATCH DATA  ·  ' + shown.length + ' RECORDS');
    const hCols = [{ w: 3, label: 'DATE', fg: P.mut }, { w: 3, label: 'MANAGER', ha: 'LEFT', b: 1, wrap: 1 }, { w: 3, label: 'CLUB', ha: 'LEFT', fg: P.mut }, { w: 2, label: 'TEAM', b: 1 }, { w: 1, label: 'G', fg: P.mut }, { w: 2, label: 'RESULT', b: 1 },
      { w: 1, label: 'PTS', b: 1 }, { w: 1, label: 'GF' }, { w: 1, label: 'GA' }, { w: 1, label: 'GD', nf: NF_SGN }, { w: 1, label: 'YC' }, { w: 1, label: 'RC' }, { w: 3, label: 'SQUAD', nf: NF_M }, { w: 2, label: 'STATUS' }, { w: 2, label: 'SOURCE', fg: P.mut }, { w: 4, label: 'NOTE', ha: 'LEFT', fg: P.amb, wrap: 1 }, { w: 12, label: 'MATCH ID', ha: 'LEFT', fg: P.mut, sz: 7 }];
    const gOf = new Map(rows.map(x => [x.key, x.g || 'N/A']));
    const hRows = shown.map(x => [fdt(x.ts), x.manager, x.club, x.team, gOf.get(x.key) || 'N/A', x.status === 'REVIEW' ? '?' : x.result, x.points == null ? DASH : x.points, nz(x.gf), nz(x.ga), x.gf != null && x.ga != null ? x.gf - x.ga : DASH, nz(x.yc), nz(x.rc), x.squad == null ? DASH : M1(x.squad), x.status, x.source, x.reason || '', x.id]);
    const hr = L.add(26);
    if (!hRows.length) { L.put(hr, 0, 'No matches recorded yet.'); L.blk(hr, hr, 0, 42, { bg: P.card, fg: P.mut, sz: 8, ha: 'LEFT' }, 1); }
    else {
      for (let i = 0; i < hRows.length; i++) L.add(26);
      const ht = table(L, hr, 0, hCols, hRows);
      L.teamR.push(L.rg(ht.b0, ht.b1, ht.starts[3], ht.starts[3] + 1)); L.resR.push(L.rg(ht.b0, ht.b1, ht.starts[5], ht.starts[5] + 1)); L.zebraR.push(L.rg(ht.b0, ht.b1, 0, 42)); L.growR.push(L.rg(ht.b0, ht.b1, ht.starts[9], ht.starts[9]));
    }
    gap(L, 10);
    r = L.add(24); note(L, r, 0, 42, 'WAR ID ' + war.id + '  ·  Generated by OSM 5v5 Auto Score Tracker  ·  source: OSM league page (visible data only)  ·  missing values are shown as ' + DASH + ' / UNKNOWN and never counted as zero  ·  every match is recorded individually.');
    return L;
  }

  // ---------------------------------------------------------------- GLOBAL STATS
  function buildGlobal(G, now, sid) {
    const L = new Layout(sid), k = G.kpi, minM = G.cfg.minMatches, B0 = G.boards;
    const nzG = v => (v == null ? 'N/A' : v);
    const hhmm = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    let r = L.add(26);
    L.put(r, 0, 'OSM 5v5 · WAR TRACKER'); L.put(r, 22, '● ' + k.active + ' LIVE');
    L.blk(r, r, 0, 20, { sz: 7, fg: P.mut, ha: 'LEFT', b: 1 }, 1); L.blk(r, r, 21, 21, { bg: P.bg }, 0); L.blk(r, r, 22, 42, { sz: 9, b: 1, fg: P.grn, ha: 'RIGHT' }, 1);
    r = L.add(54);
    L.put(r, 0, 'GLOBAL STATS'); L.put(r, 22, k.wars + ' WARS  ·  ' + k.managers + ' MANAGERS');
    L.blk(r, r, 0, 20, { sz: 20, b: 1, ha: 'LEFT' }, 1); L.blk(r, r, 21, 21, { bg: P.bg }, 0); L.blk(r, r, 22, 42, { sz: 12, b: 1, fg: P.gold, ha: 'RIGHT' }, 1);
    r = L.add(26);
    [[0, 13, 'UPDATED  ' + fd(now) + ', ' + hhmm(now)], [14, 27, 'MIN. TRACKED MATCHES FOR AVERAGES  ' + minM], [28, 42, 'AWARDS FROM ' + (G.cfg.countLive ? 'ALL WARS' : 'COMPLETED / ARCHIVED WARS')]].forEach(([a, b, t]) => { L.put(r, a, t); L.blk(r, r, a, b, { bg: P.card, fg: P.mut, sz: 7, b: 1, ha: 'LEFT' }, 1); });
    gap(L, 10);

    // KPI kartları: tek yatay sırada 9 kart
    const cards = [['TOTAL WARS', k.wars], ['ACTIVE WARS', k.active], ['COMPLETED WARS', k.completed], ['TOTAL MANAGERS', k.managers], ['TOTAL MATCHES', k.matches], ['TOTAL GOALS', k.goals], ['YELLOW CARDS', k.yc], ['RED CARDS', k.rc], ['ARCHIVED WARS', k.archived]];
    const ws = [5, 5, 5, 5, 5, 5, 5, 4, 4], a = L.add(24), b = L.add(50);
    let c = 0;
    cards.forEach(([lab, v], i) => {
      const w = ws[i], bg = i % 2 ? P.card : P.card2;
      L.put(a, c, lab); L.put(b, c, nzG(v));
      L.blk(a, a, c, c + w - 1, { bg, fg: P.mut, sz: 7, b: 1 }, 1);
      L.blk(b, b, c, c + w - 1, { bg, fg: i === 6 ? P.amb : i === 7 ? P.red : P.fg, sz: 20, b: 1 }, 1);
      c += w;
    });
    gap(L, 12);

    // Savaş özeti | G-seviyesi matrisi (yan yana)
    const sumCols = [{ w: 7, label: 'LEAGUE', ha: 'LEFT', b: 1, wrap: 1 }, { w: 5, label: 'TOURNAMENT', fg: P.mut, wrap: 1 }, { w: 3, label: 'WAR SCORE', b: 1 }, { w: 3, label: 'GOALS' }, { w: 3, label: 'STATUS', b: 1 }];
    const pair = (x, y) => (x == null || y == null ? DASH : x + '-' + y);
    const sumRows = G.wars.map(w => [w.league || 'UNKNOWN LEAGUE', (w.red || 'Team Red').replace(/^Team /, '') + ' vs ' + (w.blue || 'Team Blue').replace(/^Team /, ''), pair(w.redPts, w.bluePts), pair(w.redGoals, w.blueGoals), w.status]);
    const sumPanel = { n: 2 + Math.max(sumRows.length, 1) };
    sumPanel.draw = r0 => {
      bar(L, r0, 0, 20, 'GLOBAL WAR SUMMARY');
      if (!sumRows.length) { L.put(r0 + 1, 0, 'No wars registered yet.'); L.blk(r0 + 1, r0 + 1, 0, 20, { bg: P.card, fg: P.mut, sz: 8, ha: 'LEFT' }, 1); return; }
      const t = table(L, r0 + 1, 0, sumCols, sumRows);
      L.statR.push(L.rg(t.b0, t.b1, t.starts[4], t.starts[4] + 2)); L.zebraR.push(L.rg(t.b0, t.b1, 0, 20));
    };
    const cats = [['BEST GOAL SCORER', 'scorer', v => v + ' goals'], ['BEST DEFENSIVE MANAGER', 'defence', v => R2(v) + ' / match'], ['BEST SQUAD BUILDER', 'squad', v => (v > 0 ? '+' : '') + R2(v) + '%'], ['MOST WAR POINTS', 'points', v => v + ' pts'], ['MOST MATCH WINS', 'wins', v => v + ' wins']];
    const gCols = [{ w: 5, label: 'CATEGORY', ha: 'LEFT', b: 1, fg: P.mut, sz: 7, wrap: 1 }, { w: 3, label: 'G1', wrap: 1 }, { w: 3, label: 'G3', wrap: 1 }, { w: 3, label: 'G5', wrap: 1 }, { w: 3, label: 'G7', wrap: 1 }, { w: 4, label: 'G9', wrap: 1 }];
    const gRows = cats.map(([lab, key, f]) => [lab].concat(['G1', 'G3', 'G5', 'G7', 'G9'].map(lv => { const x = G.gl[lv][key]; return x.value == null ? 'N/A' : x.names + '\n' + f(x.value); })));
    const glPanel = { n: 2 + gRows.length };
    glPanel.draw = r0 => {
      bar(L, r0, 22, 42, 'G-LEVEL PERFORMANCE  ·  compared within the same level only');
      const t = table(L, r0 + 1, 22, gCols, gRows); L.zebraR.push(L.rg(t.b0, t.b1, 22, 42));
    };
    band(L, [sumPanel, glPanel], 40);
    gap(L, 12);

    // Liderlik tabloları (2 yan yana)
    const rk = x => (x.rank == null ? DASH : (x.tie ? 'T' : '') + x.rank);
    const per = (v, okk) => (v == null ? 'N/A' : R2(v) + (okk ? '' : '*'));
    const belowNote = 'Rank "—" or * = fewer than ' + minM + ' tracked matches. Totals stay visible; the manager is not ranked on this average.';
    const rowsOf = (list, f) => list.map(f);
    band(L, [
      boardPanel(L, 0, 'TOP GOAL SCORER', ['TOTAL GOALS', 'GOALS / MATCH', 'MATCHES', 'WARS', 'AWARDS'], rowsOf(B0.scorer, x => [rk(x), x.name, x.levelsText, x.total, per(x.gpm, x.eligG), x.matches, x.warCount, x.awS]), ['0', '@', '0', '0', '0'], 'Goals / match = goals scored in tracked matches ÷ tracked matches. * = below the minimum.'),
      boardPanel(L, 22, 'BEST DEFENSIVE MANAGER', ['CONCEDED', 'CONC. / MATCH', 'MATCHES', 'WARS', 'AWARDS'], rowsOf(B0.defence, x => [rk(x), x.name, x.levelsText, x.conc, per(x.cpm, x.eligG), x.matches, x.warCount, x.awD]), ['0', '@', '0', '0', '0'], belowNote)
    ], 28);
    gap(L, 12);
    band(L, [
      boardPanel(L, 0, 'BEST SQUAD BUILDER  ·  SQUAD DEVELOPMENT', ['AVG GROWTH %', 'VALUE INCREASE', 'MATCHES', 'WARS', 'AWARDS'], rowsOf(B0.squad, x => [rk(x), x.name, x.levelsText, R2(x.avgGr), M1(x.incr), x.matches, x.warCount, x.awB]), [NF_PCT, '+#,##0.0"M";-#,##0.0"M";0.0"M"', '0', '0', '0'], 'Average of each war\'s own growth (starting values are war-specific). ' + belowNote),
      boardPanel(L, 22, 'MOST WAR POINTS', ['WAR POINTS', 'MATCHES', 'PTS / MATCH', 'WARS', ''], rowsOf(B0.points, x => [rk(x), x.name, x.levelsText, x.warPts, x.matches, R2(x.ppm), x.warCount, '']), ['0', '0', '0.00', '0', '@'])
    ], 28);
    gap(L, 12);
    const rules = ['Every statistic comes from individual match records.', 'Awards = number of DIFFERENT wars a manager ranked first in; ties are shared and repeated uploads are never counted twice.',
      'Average-based boards need at least ' + minM + ' tracked matches (setting). Totals stay visible below the minimum.', 'A manager\'s G-level is war-specific; managers are compared only against the same level.', 'Manager identity = manager name. Missing values are N/A, never zero.'];
    const rulesPanel = { n: 1 + rules.length };
    rulesPanel.draw = r0 => {
      bar(L, r0, 22, 42, 'RULES & NOTES');
      rules.forEach((t, i) => { L.put(r0 + 1 + i, 22, t); L.blk(r0 + 1 + i, r0 + 1 + i, 22, 42, { bg: P.card, fg: P.mut, sz: 7, ha: 'LEFT', wrap: 1 }, 1); });
    };
    band(L, [
      boardPanel(L, 0, 'MOST MATCH WINS', ['MATCH WINS', 'MATCHES', 'WIN %', 'WARS', ''], rowsOf(B0.wins, x => [rk(x), x.name, x.levelsText, x.wins, x.matches, x.winPct == null ? 'N/A' : Math.round(x.winPct * 10) / 10 + '%', x.warCount, '']), ['0', '0', '@', '0', '@'], 'Individual match wins only. Not the same as team war victories.'),
      rulesPanel
    ], 30);
    gap(L, 10);
    return L;
  }

  // ---------------------------------------------------------------- İstek üretimi
  function battleRequests(L, existingCf, tab) {
    const sid = L.sid, nRows = L.rows.length + 6, q = [];
    q.push({ unmergeCells: { range: { sheetId: sid } } });
    q.push({ repeatCell: { range: { sheetId: sid }, cell: {}, fields: 'userEnteredValue,userEnteredFormat' } });
    for (let i = 0; i < existingCf; i++) q.push({ deleteConditionalFormatRule: { sheetId: sid, index: 0 } });
    q.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { rowCount: nRows, columnCount: NC, frozenRowCount: 3, frozenColumnCount: 0, hideGridlines: true }, tabColorStyle: { rgbColor: colr(tab || P.red) } }, fields: 'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount,gridProperties.hideGridlines,tabColorStyle' } });
    q.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: NC }, properties: { pixelSize: COLW }, fields: 'pixelSize' } });
    q.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: GUT, endIndex: GUT + 1 }, properties: { pixelSize: GUTW }, fields: 'pixelSize' } });
    q.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: nRows, startColumnIndex: 0, endColumnIndex: NC }, cell: { userEnteredFormat: fmtOf({ bg: P.bg }) }, fields: 'userEnteredFormat' } });
    let a = 0;
    for (let i = 1; i <= L.h.length; i++) {
      if (i === L.h.length || L.h[i] !== L.h[a]) { q.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: a, endIndex: i }, properties: { pixelSize: L.h[a] }, fields: 'pixelSize' } }); a = i; }
    }
    L.reqs.forEach(r => q.push(r));
    const rule = (ranges, cond, fmt) => ({ addConditionalFormatRule: { index: 0, rule: { ranges, booleanRule: { condition: cond, format: fmt } } } });
    const eq = t => ({ type: 'TEXT_EQ', values: [{ userEnteredValue: t }] });
    const W = [1, 1, 1];
    if (L.zebraR.length) q.push(rule(L.zebraR, { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=ISEVEN(ROW())' }] }, { backgroundColor: colr(P.card2) }));
    L.gradR.forEach(x => q.push({ addConditionalFormatRule: { index: 0, rule: { ranges: [x.range], gradientRule: { minpoint: { color: colr(P.card), type: 'MIN' }, maxpoint: { color: colr(x.color), type: 'MAX' } } } } }));
    if (L.teamR.length) {
      q.push(rule(L.teamR, eq('RED'), { backgroundColor: colr(P.red), textFormat: { foregroundColor: colr(W), bold: true } }));
      q.push(rule(L.teamR, eq('BLUE'), { backgroundColor: colr(P.blue), textFormat: { foregroundColor: colr(W), bold: true } }));
    }
    if (L.growR.length) {
      const num = (t, c) => rule(L.growR, { type: t, values: [{ userEnteredValue: '0' }] }, { textFormat: { foregroundColor: colr(c), bold: true } });
      q.push(num('NUMBER_GREATER', P.grn)); q.push(num('NUMBER_LESS', P.red));
    }
    if (L.statR.length) {
      q.push(rule(L.statR, eq('LIVE'), { backgroundColor: colr(P.grn), textFormat: { foregroundColor: colr(W), bold: true } }));
      q.push(rule(L.statR, eq('COMPLETED'), { backgroundColor: colr(P.gold), textFormat: { foregroundColor: colr([0.1, 0.1, 0.1]), bold: true } }));
      q.push(rule(L.statR, eq('ARCHIVED'), { backgroundColor: colr([0.4, 0.43, 0.5]), textFormat: { foregroundColor: colr(W), bold: true } }));
    }
    if (L.resR.length) {
      q.push(rule(L.resR, eq('W'), { textFormat: { foregroundColor: colr(P.grn), bold: true } }));
      q.push(rule(L.resR, eq('D'), { textFormat: { foregroundColor: colr(P.amb), bold: true } }));
      q.push(rule(L.resR, eq('L'), { textFormat: { foregroundColor: colr(P.red), bold: true } }));
    }
    return q;
  }

  // ---------------------------------------------------------------- Gizli senkron veri + gönderim
  const WAR_COLS = ['warId', 'league', 'red', 'blue', 'status', 'sheet', 'sheetId', 'startTs', 'updated', 'matches', 'redPts', 'bluePts', 'redWarPts', 'blueWarPts', 'redGoals', 'blueGoals', 'redConc', 'blueConc', 'yc', 'rc', 'redWins', 'blueWins', 'draws', 'managers'];
  const MGR_COLS = ['warId', 'key', 'name', 'club', 'team', 'g', 'start', 'current', 'growth', 'gf', 'ga', 'yc', 'rc', 'pts', 'warPts', 'matches', 'wins', 'draws', 'losses', 'gm', 'tgf', 'tga'];
  const GLOBAL = 'GLOBAL STATS', HID_W = '_WARS', HID_M = '_MANAGERS', MD_KEY = 'osm_war_id', HIST_ID_COL = 31;   // geçmiş tablosundaki MATCH ID sütunu
  const asTable = (cols, objs) => [cols].concat(objs.map(o => cols.map(c => (o[c] == null ? '' : o[c]))));
  function fromTable(vals, cols) {
    if (!vals || vals.length < 2) return [];
    const head = vals[0];
    return vals.slice(1).filter(r => r[0] !== '' && r[0] != null).map(r => { const o = {}; cols.forEach(c => { const i = head.indexOf(c), v = i >= 0 ? r[i] : ''; o[c] = v === '' || v === undefined ? null : v; }); return o; });
  }
  const cleanTitle = t => String(t || '').replace(/[\[\]*?:\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'UNKNOWN LEAGUE';
  const newSheetId = metaSheets => Math.max.apply(null, [1000, Date.now() % 2000000000].concat(metaSheets.map(s => s.properties.sheetId + 1)));
  const warMeta = sh => (sh.developerMetadata || []).find(d => d.metadataKey === MD_KEY);

  async function readHidden(id, title) {
    const r = await api('GET', API + '/' + id + '/values/' + encodeURIComponent(q(title) + '!A:Z') + '?valueRenderOption=UNFORMATTED_VALUE');
    return r.values || [];
  }
  async function writeHidden(id, title, table, oldLen) {
    const pad = Math.max(0, oldLen - table.length);
    const vals = table.concat(new Array(pad).fill(null).map(() => new Array(table[0].length).fill('')));
    await api('POST', API + '/' + id + '/values:batchUpdate', { valueInputOption: 'RAW', data: [{ range: q(title) + '!A1', values: vals }] });
  }
  async function applyLayout(id, L, cfCount, tab) {
    await api('POST', API + '/' + id + ':batchUpdate', { requests: battleRequests(L, cfCount, tab) });
    await api('POST', API + '/' + id + '/values:batchUpdate', { valueInputOption: 'RAW', data: [{ range: q(L.title) + '!A1', values: L.rows }] });
  }
  async function writeGlobal(id, warsRows, mgrRows, cfg) {
    const meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats)');
    const sh = meta.sheets.find(s => s.properties.title === GLOBAL);
    const G = OSMWars.computeGlobal(warsRows, mgrRows, cfg);
    const L = buildGlobal(G, Date.now(), sh.properties.sheetId); L.title = GLOBAL;
    await applyLayout(id, L, (sh.conditionalFormats || []).length, P.gold);
    return G;
  }

  // ctx: { war, model:{now,curN,matches,names,startTs}, cfg } -> savaşın sayfasını günceller, gizli veriyi ve GLOBAL STATS'ı senkronlar
  async function pushWar(id, ctx) {
    const war = ctx.war, model = ctx.model;
    let meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats,developerMetadata)');
    const reqs = [];
    let nextId = newSheetId(meta.sheets);
    const has = t => meta.sheets.some(s => s.properties.title === t);
    if (!has(GLOBAL)) reqs.push({ addSheet: { properties: { sheetId: nextId++, title: GLOBAL, index: 0 } } });
    [HID_W, HID_M].forEach(t => { if (!has(t)) reqs.push({ addSheet: { properties: { sheetId: nextId++, title: t, hidden: true } } }); });
    // Savaş sayfası kalıcı War ID (geliştirici üst verisi) ile bulunur — ad değişse de kırılmaz
    let sh = meta.sheets.find(s => { const d = warMeta(s); return d && d.metadataValue === war.id; });
    if (!sh && war.sheetId != null) sh = meta.sheets.find(s => s.properties.sheetId === war.sheetId && !warMeta(s) && ![GLOBAL, HID_W, HID_M].includes(s.properties.title));
    let created = false, sheetId, title;
    if (!sh) {
      const taken = new Set(meta.sheets.map(s => s.properties.title.toLowerCase()).concat([GLOBAL.toLowerCase(), HID_W, HID_M]));
      const base = cleanTitle(war.league);
      title = base; for (let n = 2; taken.has(title.toLowerCase()); n++) title = base + ' (' + n + ')';
      sheetId = nextId++;
      reqs.push({ addSheet: { properties: { sheetId, title } } });
      reqs.push({ createDeveloperMetadata: { developerMetadata: { metadataKey: MD_KEY, metadataValue: war.id, location: { sheetId }, visibility: 'DOCUMENT' } } });
      created = true;
    } else { sheetId = sh.properties.sheetId; title = sh.properties.title; }
    if (reqs.length) await api('POST', API + '/' + id + ':batchUpdate', { requests: reqs });
    // Geçmiş koruması: sayfadaki maç kimlikleri yerelde yoksa üzerine yazma
    if (!created) {
      const col = await api('GET', API + '/' + id + '/values/' + encodeURIComponent(q(title) + '!' + colName(HIST_ID_COL) + ':' + colName(HIST_ID_COL)));
      const onSheet = (col.values || []).map(x => String(x[0] || '')).filter(x => x.indexOf(war.id + ':') === 0);
      const mine = new Set((model.matches || []).map(x => x.id));
      const missing = onSheet.filter(x => !mine.has(x));
      if (missing.length) throw new Error('HISTORY_GUARD: Sayfada yerel kayıtta olmayan ' + missing.length + ' maç kaydı var. Eski veriler silinmesin diye güncelleme durduruldu; önce JSON yedeğini geri yükleyin.');
    }
    meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats,developerMetadata)');
    const cur = meta.sheets.find(s => s.properties.sheetId === sheetId);
    const rowsM = OSMWars.managerRows(war, model.curN, model.matches || []);
    const L = buildWar(Object.assign({}, model, { war }), sheetId); L.title = title;
    await applyLayout(id, L, (cur.conditionalFormats || []).length, war.status === 'ARCHIVED' ? [0.4, 0.43, 0.5] : P.red);
    const wv = await readHidden(id, HID_W), mv = await readHidden(id, HID_M);
    const wars = fromTable(wv, WAR_COLS).filter(w => w.warId !== war.id);
    const mgrs = fromTable(mv, MGR_COLS).filter(r => r.warId !== war.id);
    wars.push(OSMWars.warRow(war, model.curN, model.matches || [], rowsM, title)); rowsM.forEach(r => mgrs.push(r));
    await writeHidden(id, HID_W, asTable(WAR_COLS, wars), wv.length);
    await writeHidden(id, HID_M, asTable(MGR_COLS, mgrs), mv.length);
    await writeGlobal(id, wars, mgrs, ctx.cfg);
    return { title, created, sheetId, matches: (model.matches || []).filter(x => x.status === 'OK').length, wars: wars.length };
  }

  // Savaşı Sheets'ten sil: yalnızca o savaşın sayfası ve gizli satırları; diğer savaşlar etkilenmez.
  async function deleteWarSheet(id, warId, cfg) {
    const meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats,developerMetadata)');
    const sh = meta.sheets.find(s => { const d = warMeta(s); return d && d.metadataValue === warId; });
    if (sh) await api('POST', API + '/' + id + ':batchUpdate', { requests: [{ deleteSheet: { sheetId: sh.properties.sheetId } }] });
    const wv = await readHidden(id, HID_W), mv = await readHidden(id, HID_M);
    const wars = fromTable(wv, WAR_COLS).filter(w => w.warId !== warId), mgrs = fromTable(mv, MGR_COLS).filter(r => r.warId !== warId);
    await writeHidden(id, HID_W, asTable(WAR_COLS, wars), wv.length);
    await writeHidden(id, HID_M, asTable(MGR_COLS, mgrs), mv.length);
    await writeGlobal(id, wars, mgrs, cfg);
    return { deleted: !!sh, wars: wars.length };
  }

  g.OSMSheets = { hasToken, requestToken, create, test, pushWar, deleteWarSheet, buildWar, buildGlobal, battleRequests };
})(window);
