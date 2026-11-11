/* google-sheets-api.js — Apps Script YOK. Doğrudan Sheets REST API + Google Identity Services. */
(function (g) {
  'use strict';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const SHEETS = ['DASHBOARD', 'LIVE STANDINGS', 'RED VS BLUE', 'MATCHDAY RESULTS', 'MANAGER STATS',
    'SQUAD VALUES', 'GOAL STATISTICS', 'MATCH HISTORY', 'RAW DATA', 'SETTINGS', 'SYSTEM LOGS'];
  const HISTORY_SHEETS = ['MATCHDAY RESULTS', 'MATCH HISTORY']; // yerel kayıt boşsa üzerine yazılmaz

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

  async function ensure(id) {
    const j = await api('GET', API + '/' + id + '?fields=sheets.properties');
    const have = new Map(j.sheets.map(s => [s.properties.title, s.properties.sheetId]));
    const missing = SHEETS.filter(t => !have.has(t));
    if (missing.length) {
      const r = await api('POST', API + '/' + id + ':batchUpdate', { requests: missing.map(t => ({ addSheet: { properties: { title: t } } })) });
      r.replies.forEach(x => have.set(x.addSheet.properties.title, x.addSheet.properties.sheetId));
    }
    return have;
  }

  async function test(id) {
    const j = await api('GET', API + '/' + id + '?fields=properties.title,sheets.properties.title');
    return j.properties.title + ' (' + j.sheets.length + ' sayfa)';
  }

  const q = t => "'" + t + "'";
  const fmt = ts => ts ? new Date(ts).toLocaleString('tr-TR') : '';
  const val = v => (v == null ? 'UNKNOWN' : v);
  const mil = v => (v == null ? 'UNKNOWN' : Math.round(v / 1e5) / 10 + 'M');

  // ---------- Tablo üretimi ----------
  function buildTables(m) {
    const { st, curN, baseN, diff, mds, tour, logs, snaps } = m;
    const S = {};
    const last = mds[mds.length - 1];
    const lg = curN ? OSMScore.agg(curN.league, 'points') : null;
    const sq = curN ? OSMScore.agg(curN.squad, 'value') : null;
    const gl = curN ? OSMScore.agg(curN.goals, 'goals') : null;
    const star = a => (a && a.n ? (a.unknown ? a.sum + ' (+' + a.unknown + ' UNKNOWN)' : a.sum) : 'UNKNOWN');
    const sqs = a => (a && a.n ? mil(a.sum) + (a.unknown ? ' (+' + a.unknown + ' UNKNOWN)' : '') : 'UNKNOWN');
    const gm = curN ? OSMScore.goalsByManager(curN.goals) : [];
    let bestMgr = 'UNKNOWN';
    if (mds.length) {
      const tot = new Map();
      mds.forEach(x => x.rows.forEach(r => tot.set(r.manager, (tot.get(r.manager) || 0) + r.diff)));
      const arr = Array.from(tot.entries()).sort((a, b) => b[1] - a[1]);
      if (arr.length) bestMgr = arr[0][0] + ' (' + arr[0][1] + ' puan)';
    }

    const li = curN && curN.leagueInfo;
    const leagueText = li && li.name ? li.name + (li.type ? ' · ' + li.type : '') + (li.season ? ' · Sezon ' + li.season : '') + (li.moderator ? ' · Moderatör: ' + li.moderator : '') : 'UNKNOWN';
    const gap = lg ? lg.RED.sum - lg.BLUE.sum : null;
    const lead = gap == null ? 'UNKNOWN' : gap === 0 ? 'Berabere' : (gap > 0 ? 'RED ' : 'BLUE ') + Math.abs(gap) + ' puan önde';
    S['DASHBOARD'] = [
      ['OSM 5v5 — TEAM RED vs TEAM BLUE'],
      ['Lig', leagueText],
      ['Son güncelleme', fmt(m.now)],
      [],
      ['', 'TEAM RED', 'TEAM BLUE'],
      ['TOPLAM PUAN (lig, kümülatif)', star(lg && lg.RED), star(lg && lg.BLUE)],
      ['Genel skor', lg ? 'RED ' + lg.RED.sum + ' - ' + lg.BLUE.sum + ' BLUE' : 'UNKNOWN', lead],
      ['Kadro değeri', sqs(sq && sq.RED), sqs(sq && sq.BLUE)],
      ['Atılan gol', star(gl && gl.RED), star(gl && gl.BLUE)],
      ['Menajer', lg ? lg.RED.n : 'UNKNOWN', lg ? lg.BLUE.n : 'UNKNOWN'],
      [],
      ['Bekleyen maç günü puanı', diff && diff.valid ? diff.red : 'UNKNOWN', diff && diff.valid ? diff.blue : 'UNKNOWN'],
      ['Son kayıtlı maç günü puanı', last ? last.red : 'UNKNOWN', last ? last.blue : 'UNKNOWN'],
      ['Kayıtlı maç günlerinden toplam', tour.redPts, tour.bluePts],
      ['Maç günü galibiyeti', tour.redWins, tour.blueWins],
      [],
      ['Son maç günü', last ? 'MD' + last.matchday + ': RED ' + last.red + ' - ' + last.blue + ' BLUE' : 'UNKNOWN'],
      ['Kadro değeri farkı (RED-BLUE)', sq && sq.RED.unknown + sq.BLUE.unknown === 0 ? mil(sq.RED.sum - sq.BLUE.sum) : 'UNKNOWN'],
      ['Gol farkı (RED-BLUE)', gl && gl.RED.unknown + gl.BLUE.unknown === 0 ? gl.RED.sum - gl.BLUE.sum : 'UNKNOWN'],
      ['En başarılı menajer', bestMgr],
      [],
      ['LİG SIRALAMASI'],
      ['#', 'Kulüp', 'Menajer', 'Takım', 'Puan']
    ].concat(curN ? curN.league.map(r => [r.rank, r.club, r.manager, r.team, val(r.points)]) : []);

    S['LIVE STANDINGS'] = [['#', 'Kulüp', 'Menajer', 'Takım', 'Puan', 'Ham sayısal sütunlar']]
      .concat(curN ? curN.league.map(r => [r.rank, r.club, r.manager, r.team, val(r.points), r.rawNums.join(' | ')]) : []);

    const rv = [['Menajer', 'Kulüp', 'Takım', 'Başlangıç puanı', 'Güncel puan', 'Fark']];
    if (diff && diff.rows.length) diff.rows.forEach(r => rv.push([r.manager, r.club, r.team, r.prev, r.curr, r.diff]));
    rv.push([], ['Durum', diff ? (diff.valid ? 'GEÇERLİ' : 'GEÇERSİZ') : 'Başlangıç noktası bekleniyor'], ['RED', diff && diff.valid ? diff.red : 'UNKNOWN'], ['BLUE', diff && diff.valid ? diff.blue : 'UNKNOWN']);
    if (diff) { diff.reasons.forEach(x => rv.push(['Neden', x])); diff.warnings.forEach(x => rv.push(['Uyarı', x])); }
    S['RED VS BLUE'] = rv;

    S['MATCHDAY RESULTS'] = [['Maç günü', 'Tarih', 'RED', 'BLUE', 'Sonuç', 'RED kadro', 'BLUE kadro', 'RED gol', 'BLUE gol']]
      .concat(mds.map(x => [x.matchday, fmt(x.ts), x.red, x.blue, x.red > x.blue ? 'RED' : x.blue > x.red ? 'BLUE' : 'BERABERE', mil(x.squad.RED), mil(x.squad.BLUE), val(x.goals.RED), val(x.goals.BLUE)]));

    const mh = [['Maç günü', 'Tarih', 'Menajer', 'Kulüp', 'Takım', 'Önceki puan', 'Yeni puan', 'Fark']];
    mds.forEach(x => x.rows.forEach(r => mh.push([x.matchday, fmt(x.ts), r.manager, r.club, r.team, r.prev, r.curr, r.diff])));
    S['MATCH HISTORY'] = mh;

    const ms = [['Menajer', 'Kulüp', 'Takım', 'Lig sırası', 'Lig puanı', 'Savaş puanı toplamı', 'Maç günü sayısı', 'Kadro değeri', 'Gol']];
    if (curN) curN.league.forEach(r => {
      const tot = mds.reduce((a, x) => a + (x.rows.find(y => OSMScore.K(y.manager) === OSMScore.K(r.manager)) || { diff: 0 }).diff, 0);
      const sv = curN.squad.find(y => OSMScore.K(y.manager) === OSMScore.K(r.manager));
      const gg = gm.find(y => OSMScore.K(y.manager) === OSMScore.K(r.manager));
      ms.push([r.manager, r.club, r.team, r.rank, val(r.points), tot, mds.length, sv ? mil(sv.value) : 'UNKNOWN', gg ? gg.goals : 'UNKNOWN']);
    });
    S['MANAGER STATS'] = ms;

    const sv = [['Sıra', 'Menajer', 'Kulüp', 'Takım', 'Kadro değeri', 'Ham metin']];
    if (curN) curN.squad.forEach(r => sv.push([r.rank, r.manager, r.club, r.team, mil(r.value), val(r.valueRaw)]));
    sv.push([], ['', 'TEAM RED', 'TEAM BLUE'], ['Toplam', sqs(sq && sq.RED), sqs(sq && sq.BLUE)],
      ['Ortalama', sq && sq.RED.n - sq.RED.unknown ? mil(sq.RED.sum / (sq.RED.n - sq.RED.unknown)) : 'UNKNOWN', sq && sq.BLUE.n - sq.BLUE.unknown ? mil(sq.BLUE.sum / (sq.BLUE.n - sq.BLUE.unknown)) : 'UNKNOWN'],
      [], ['DEĞİŞİM GEÇMİŞİ (maç günü)', 'RED', 'BLUE']);
    mds.forEach(x => sv.push(['MD' + x.matchday, mil(x.squad.RED), mil(x.squad.BLUE)]));
    S['SQUAD VALUES'] = sv;

    const gs = [['', 'TEAM RED', 'TEAM BLUE'], ['Atılan gol', star(gl && gl.RED), star(gl && gl.BLUE)]];
    if (last && last.goalDelta) gs.push(['Son maç günü gol farkı', last.goalDelta.RED, last.goalDelta.BLUE]);
    gs.push([], ['KULÜP GOLLERİ (Gol sekmesi)'], ['Sıra', 'Kulüp', 'Menajer', 'Takım', 'Atılan', 'Yenilen', 'Sarı kart', 'Kırmızı kart']);
    if (curN) curN.goals.forEach(r => gs.push([r.rank, r.club, r.manager, r.team, val(r.scored), val(r.conceded), val(r.yellow), val(r.red)]));
    gs.push([], ['GOL KRALLARI (sayfadaki liste; yalnızca ilk birkaç oyuncu)'], ['Oyuncu', 'Kulüp', 'Menajer', 'Takım', 'Gol']);
    if (curN) curN.topScorers.forEach(r => gs.push([r.player, r.club, r.manager, r.team, r.goals]));
    gs.push([], ['EN ÇOK GOL ATAN MENAJERLER'], ['Menajer', 'Takım', 'Gol']);
    gm.slice(0, 10).forEach(r => gs.push([r.manager, r.team, r.goals]));
    S['GOAL STATISTICS'] = gs;

    S['RAW DATA'] = [['Kayıt ID', 'Tarih', 'Sekme durumu', 'Ham satırlar (JSON, kısaltılmış)']]
      .concat(snaps.slice(-40).map(s => [s.id, fmt(s.ts),
        Object.keys(s.tabs).map(k => k + ':' + (s.tabs[k].ok ? 'OK' : 'HATA')).join(' '),
        JSON.stringify(Object.keys(s.tabs).reduce((o, k) => (o[k] = s.tabs[k].rows, o), {})).slice(0, 45000)]));

    S['SETTINGS'] = [['Anahtar', 'Değer'], ['Lig bağlantısı', st.leagueUrl], ['RED menajerleri', st.redManagers.join(', ')],
      ['BLUE menajerleri', st.blueManagers.join(', ')], ['Sıradaki maç günü', st.matchday], ['Otomatik Sheets gönderimi', String(st.autoSync)],
      ['Otomatik maç günü onayı', String(st.autoCommit)]];

    S['SYSTEM LOGS'] = [['Tarih', 'Seviye', 'Kod', 'Mesaj']]
      .concat(logs.slice(-200).reverse().map(l => [fmt(l.ts), l.level, l.code, l.msg]));
    return S;
  }

  async function push(id, model) {
    const ids = await ensure(id);
    const S = buildTables(model);
    const names = SHEETS.filter(n => {
      if (HISTORY_SHEETS.indexOf(n) !== -1 && S[n].length <= 1) return false; // geçmişi koru
      return true;
    });
    await api('POST', API + '/' + id + '/values:batchClear', { ranges: names.map(n => q(n) + '!A:Z') });
    await api('POST', API + '/' + id + '/values:batchUpdate', {
      valueInputOption: 'RAW',
      data: names.map(n => ({ range: q(n) + '!A1', values: S[n] }))
    });
    // Basit biçimlendirme: başlık satırı kalın, DASHBOARD başlığı büyük
    const reqs = SHEETS.map(n => ({
      repeatCell: {
        range: { sheetId: ids.get(n), startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: n === 'DASHBOARD' ? 20 : 11 } } },
        fields: 'userEnteredFormat.textFormat'
      }
    }));
    reqs.push({
      repeatCell: {
        range: { sheetId: ids.get('DASHBOARD'), startRowIndex: 4, endRowIndex: 5 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }, fields: 'userEnteredFormat.textFormat'
      }
    });
    await api('POST', API + '/' + id + ':batchUpdate', { requests: reqs });
    return names.length;
  }

  // ---------- .xlsx dışa aktarma (kütüphanesiz; ZIP 'store') ----------
  const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const enc = s => new TextEncoder().encode(s);
  const u16 = n => [n & 255, (n >>> 8) & 255];
  const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function zipStore(files) {
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const name = enc(f.name), data = enc(f.text), crc = crc32(data);
      const lh = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(33), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      parts.push(new Uint8Array(lh), name, data);
      const ch = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(33), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(ch), name);
      offset += lh.length + name.length + data.length;
    });
    let csize = 0;
    central.forEach(c => { csize += c.length; });
    const end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(csize), u32(offset), u16(0)));
    return new Blob(parts.concat(central, [end]), { type: XLSX_MIME });
  }

  const xe = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  function sheetXml(rows) {
    let x = XML + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="12" width="26" customWidth="1"/></cols><sheetData>';
    rows.forEach((r, ri) => {
      x += '<row r="' + (ri + 1) + '">';
      r.forEach((v, ci) => {
        if (v === '' || v == null) return;
        const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && isFinite(v)) x += '<c r="' + ref + '"' + st + '><v>' + v + '</v></c>';
        else x += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
      });
      x += '</row>';
    });
    return x + '</sheetData></worksheet>';
  }

  // Tüm 11 sayfayı tek .xlsx dosyası olarak üretir (Google Drive'a yükleyip Sheets ile açılır).
  function toXlsx(model) {
    const S = buildTables(model);
    const files = [];
    const NS = 'http://schemas.openxmlformats.org/';
    files.push({ name: '[Content_Types].xml', text: XML + '<Types xmlns="' + NS + 'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      SHEETS.map((n, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' });
    files.push({ name: '_rels/.rels', text: XML + '<Relationships xmlns="' + NS + 'package/2006/relationships"><Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: 'xl/workbook.xml', text: XML + '<workbook xmlns="' + NS + 'spreadsheetml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships"><sheets>' +
      SHEETS.map((n, i) => '<sheet name="' + xe(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', text: XML + '<Relationships xmlns="' + NS + 'package/2006/relationships">' +
      SHEETS.map((n, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + NS + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
      '<Relationship Id="rId' + (SHEETS.length + 1) + '" Type="' + NS + 'officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' });
    files.push({ name: 'xl/styles.xml', text: XML + '<styleSheet xmlns="' + NS + 'spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' });
    SHEETS.forEach((n, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', text: sheetXml(S[n] || []) }));
    return zipStore(files);
  }

  // ================= Tek sayfalı savaş paneli (her savaş = 1 sayfa) =================
  const NC = 18, COLW = 22;
  const P = {
    bg: [0.06, 0.07, 0.09], card: [0.1, 0.12, 0.15], card2: [0.15, 0.17, 0.21], fg: [0.95, 0.96, 0.97], mut: [0.55, 0.59, 0.66],
    red: [0.93, 0.31, 0.33], blue: [0.28, 0.55, 0.98], redT: [0.19, 0.1, 0.11], blueT: [0.09, 0.14, 0.25],
    gold: [0.96, 0.77, 0.32], grn: [0.25, 0.73, 0.31], amb: [0.96, 0.65, 0.14]
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

  function Layout(sid) { this.sid = sid; this.rows = []; this.h = []; this.reqs = []; this.teamR = []; this.resR = []; this.growR = []; this.statR = []; this.zebra = null; }
  Layout.prototype.add = function (h) { this.rows.push(new Array(NC).fill('')); this.h.push(h); return this.rows.length - 1; };
  Layout.prototype.rg = function (r0, r1, c0, c1) { return { sheetId: this.sid, startRowIndex: r0, endRowIndex: r1 + 1, startColumnIndex: c0, endColumnIndex: c1 + 1 }; };
  Layout.prototype.put = function (r, c, v) { this.rows[r][c] = v == null ? '' : v; };
  Layout.prototype.blk = function (r0, r1, c0, c1, style, merge) {
    const range = this.rg(r0, r1, c0, c1);
    if (merge && c1 > c0) this.reqs.push({ mergeCells: { range, mergeType: 'MERGE_ROWS' } });
    this.reqs.push({ repeatCell: { range, cell: { userEnteredFormat: fmtOf(style) }, fields: 'userEnteredFormat' } });
  };

  // Ortak bölüm/kart yardımcıları (savaş sayfası ve GLOBAL STATS paylaşır)
  function helpers(L, nz) {
    const sec = title => { const r = L.add(28); L.put(r, 0, '▌ ' + title); L.blk(r, r, 0, 17, { bg: P.card2, fg: P.gold, b: 1, sz: 8, ha: 'LEFT' }, 1); return r; };
    const gap = h => { const r = L.add(h || 10); L.blk(r, r, 0, 17, { bg: P.bg }, 1); };
    const info = (text, o) => { o = o || {}; const r = L.add(o.h || 24); L.put(r, 0, text); L.blk(r, r, 0, 17, { bg: P.card, fg: o.fg || P.mut, sz: o.sz || 8, b: o.b ? 1 : 0, wrap: 1 }, 1); };
    const cmp = (items, o) => {
      o = o || {};
      const r0 = L.rows.length;
      items.forEach(it => { const r = L.add(o.h || 30); L.put(r, 0, nz(it.rv)); L.put(r, 6, it.label); L.put(r, 12, nz(it.bv)); });
      const r1 = L.rows.length - 1;
      L.blk(r0, r1, 0, 5, { bg: P.redT, fg: P.red, b: 1, sz: o.sz || 13, nf: o.nf }, 1);
      L.blk(r0, r1, 6, 11, { bg: P.card, fg: P.mut, sz: 7, b: 1, wrap: 1 }, 1);
      L.blk(r0, r1, 12, 17, { bg: P.blueT, fg: P.blue, b: 1, sz: o.sz || 13, nf: o.nf }, 1);
    };
    return { sec, gap, info, cmp };
  }

  function battleIdOf(m) {
    const li = m.curN && m.curN.leagueInfo;
    return (li && li.name ? li.name + ' · ' : '') + m.names.RED + ' vs ' + m.names.BLUE;
  }

  // Sayfa içeriğini ve biçimini üretir (ağ çağrısı yok; test edilebilir).
  function buildWar(m, sid) {
    const { st, curN, mds, tour, diff, names: nm, war } = m;
    const K = OSMScore.K, DASH = '—';
    const L = new Layout(sid);
    const fd = d => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const ft = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const nz = v => (v == null ? DASH : v);
    const tot = (a, t) => (a && a[t].n && !a[t].unknown ? a[t].sum : null);       // eksik varsa toplam gösterilmez
    const sub = (a, b) => (a == null || b == null ? null : a - b);
    const M1 = v => (v == null ? null : Math.round(v / 1e5) / 10);                 // milyon, 1 ondalık
    const U = s => String(s).toUpperCase();

    const lgA = OSMScore.agg(curN.league, 'points'), sqA = OSMScore.agg(curN.squad, 'value');
    const gfA = OSMScore.agg(curN.goals, 'goals'), gaA = OSMScore.agg(curN.goals, 'conceded');
    const ycA = OSMScore.agg(curN.goals, 'yellow'), rcA = OSMScore.agg(curN.goals, 'red');
    const pts = { R: tot(lgA, 'RED'), B: tot(lgA, 'BLUE') };
    const gf = { R: tot(gfA, 'RED'), B: tot(gfA, 'BLUE') }, ga = { R: tot(gaA, 'RED'), B: tot(gaA, 'BLUE') };
    const yc = { R: tot(ycA, 'RED'), B: tot(ycA, 'BLUE') }, rc = { R: tot(rcA, 'RED'), B: tot(rcA, 'BLUE') };
    const sq = { R: M1(tot(sqA, 'RED')), B: M1(tot(sqA, 'BLUE')) };
    const nMgr = curN.league.filter(r => r.team !== 'UNKNOWN').length;
    const last = mds[mds.length - 1] || null;
    const who = (r, b, unit) => (r == null || b == null ? DASH : r === b ? 'LEVEL' : U(r > b ? nm.RED : nm.BLUE) + (unit ? ' +' + Math.round(Math.abs(r - b) * 10) / 10 + unit : ''));

    const { sec, gap, info, cmp } = helpers(L, nz);

    // ---- A) Başlık + WAR OVERVIEW ----
    const status = war.status || 'LIVE';
    const stCol = status === 'COMPLETED' ? P.gold : status === 'ARCHIVED' ? P.mut : P.grn;
    let r = L.add(24);
    L.put(r, 0, 'OSM 5v5 · WAR SHEET'); L.put(r, 12, '● ' + status);
    L.blk(r, r, 0, 11, { sz: 7, fg: P.mut, ha: 'LEFT', b: 1 }, 1);
    L.blk(r, r, 12, 17, { sz: 8, b: 1, fg: stCol, ha: 'RIGHT' }, 1);
    r = L.add(40);
    L.put(r, 0, U(war.league || 'UNKNOWN LEAGUE'));
    L.blk(r, r, 0, 17, { sz: 14, b: 1, fg: P.fg, wrap: 1 }, 1);
    r = L.add(34);
    L.put(r, 0, U(nm.RED)); L.put(r, 8, 'vs'); L.put(r, 10, U(nm.BLUE));
    L.blk(r, r, 0, 7, { sz: 13, b: 1, fg: P.red }, 1); L.blk(r, r, 8, 9, { sz: 9, fg: P.mut }, 1); L.blk(r, r, 10, 17, { sz: 13, b: 1, fg: P.blue }, 1);
    gap(8);
    sec('WAR OVERVIEW');
    const ov = [['LEAGUE', war.league || DASH], ['TOURNAMENT', nm.RED + ' vs ' + nm.BLUE], ['TEAM RED', nm.RED], ['TEAM BLUE', nm.BLUE], ['WAR ID', war.id],
      ['STARTING DATE', m.startTs ? fd(m.startTs) : DASH], ['LAST UPDATED', fd(m.now) + ', ' + ft(m.now)], ['COMPLETED MATCHDAYS', mds.length], ['TOTAL MANAGERS', nMgr], ['WAR STATUS', status]];
    for (let i = 0; i < 5; i++) {
      const rr = L.add(28);
      L.put(rr, 0, ov[i * 2][0]); L.put(rr, 3, ov[i * 2][1]); L.put(rr, 9, ov[i * 2 + 1][0]); L.put(rr, 12, ov[i * 2 + 1][1]);
      L.blk(rr, rr, 0, 2, { bg: P.card, fg: P.mut, sz: 7, b: 1, ha: 'LEFT' }, 1); L.blk(rr, rr, 3, 8, { bg: P.card, sz: 8, b: 1, ha: 'LEFT', wrap: 1 }, 1);
      L.blk(rr, rr, 9, 11, { bg: P.card, fg: P.mut, sz: 7, b: 1, ha: 'LEFT' }, 1); L.blk(rr, rr, 12, 17, { bg: P.card, sz: 8, b: 1, ha: 'LEFT', wrap: 1 }, 1);
    }
    gap(8);

    // ---- B) Genel savaş skoru ----
    sec('TOTAL WAR SCORE  ·  OSM LEAGUE POINTS');
    r = L.add(80);
    L.put(r, 0, nz(pts.R)); L.put(r, 8, '–'); L.put(r, 10, nz(pts.B));
    L.blk(r, r, 0, 7, { bg: P.redT, fg: P.red, b: 1, sz: 40 }, 1); L.blk(r, r, 8, 9, { bg: P.card, fg: P.mut, sz: 20 }, 1); L.blk(r, r, 10, 17, { bg: P.blueT, fg: P.blue, b: 1, sz: 40 }, 1);
    info(pts.R == null || pts.B == null ? DASH : pts.R === pts.B ? 'LEVEL ON POINTS' : U(pts.R > pts.B ? nm.RED : nm.BLUE) + ' LEADS BY ' + Math.abs(pts.R - pts.B) + (Math.abs(pts.R - pts.B) === 1 ? ' POINT' : ' POINTS'), { fg: P.gold, b: 1, sz: 9 });
    if (diff && diff.valid && !diff.unchanged) info('PENDING MATCHDAY (not confirmed yet): ' + U(nm.RED) + ' ' + diff.red + ' – ' + diff.blue + ' ' + U(nm.BLUE), { fg: P.amb });
    gap(6);
    cmp([
      { label: 'LAST MATCHDAY' + (last ? ' (MD' + last.matchday + ')' : ''), rv: last ? last.red : null, bv: last ? last.blue : null },
      { label: 'MATCHDAY WINS', rv: tour.redWins, bv: tour.blueWins },
      { label: 'DRAWS', rv: tour.draws, bv: tour.draws },
      { label: 'LOSSES', rv: tour.blueWins, bv: tour.redWins },
      { label: 'POINTS SINCE BASELINE', rv: tour.redPts, bv: tour.bluePts }
    ], { h: 30 });
    info(last ? 'LAST WINNER: ' + (last.red > last.blue ? U(nm.RED) : last.blue > last.red ? U(nm.BLUE) : 'DRAW') + '   ·   MATCHDAYS CONFIRMED: ' + mds.length : 'NO MATCHDAY CONFIRMED YET   ·   MATCHDAYS CONFIRMED: 0');
    // En başarılı menajer: onaylı maç günü puanı toplamı; yoksa lig puanı
    let top = null;
    if (mds.length) {
      const sum = new Map();
      mds.forEach(x => x.rows.forEach(y => { const o = sum.get(K(y.manager)) || { manager: y.manager, team: y.team, p: 0 }; o.p += y.diff; sum.set(K(y.manager), o); }));
      top = Array.from(sum.values()).sort((a, b) => b.p - a.p)[0];
    } else {
      const c = curN.league.filter(x => x.points != null && x.team !== 'UNKNOWN').sort((a, b) => b.points - a.points)[0];
      if (c) top = { manager: c.manager, team: c.team, p: c.points };
    }
    info('TOP MANAGER: ' + (top ? top.manager + ' (' + (top.team === 'RED' ? nm.RED : nm.BLUE) + ') · ' + top.p + ' pts' + (mds.length ? '' : ' (league points)') : DASH), { fg: P.fg, b: 1 });
    gap(10);

    // ---- C) Toplam gol ----
    sec('TOTAL GOALS SCORED');
    cmp([{ label: 'GOALS SCORED', rv: gf.R, bv: gf.B }], { h: 64, sz: 30 });
    cmp([{ label: 'GOALS CONCEDED', rv: ga.R, bv: ga.B }], { h: 28 });
    cmp([{ label: 'GOAL DIFFERENCE', rv: sub(gf.R, ga.R), bv: sub(gf.B, ga.B) }], { h: 28, nf: '+0;-0;0' });
    const mdAvg = t => { let s = 0, n = 0; mds.forEach(x => { const rs = x.rows.filter(y => y.team === t); if (rs.length && rs.every(y => y.gf != null)) { s += rs.reduce((a, y) => a + y.gf, 0); n++; } }); return n ? Math.round(s / n * 10) / 10 : null; };
    cmp([{ label: 'AVG GOALS / MATCHDAY (tracked)', rv: mdAvg('RED'), bv: mdAvg('BLUE') }], { h: 28, nf: '0.0' });
    info('GOAL GAP (RED − BLUE): ' + (gf.R == null || gf.B == null ? DASH : (gf.R - gf.B > 0 ? '+' : '') + (gf.R - gf.B)) + '   ·   MOST GOALS: ' + who(gf.R, gf.B, ' goals'));
    gap(10);

    // ---- D) Kadro değeri ----
    sec('SQUAD VALUE');
    cmp([{ label: 'TOTAL SQUAD VALUE', rv: sq.R, bv: sq.B }], { h: 56, sz: 24, nf: '#,##0.0"M"' });
    const avg = (a, t) => (a[t].n && !a[t].unknown ? M1(a[t].sum / a[t].n) : null);
    cmp([{ label: 'AVG PER MANAGER', rv: avg(sqA, 'RED'), bv: avg(sqA, 'BLUE') }], { h: 28, nf: '#,##0.0"M"' });
    info('DIFFERENCE (RED − BLUE): ' + (sq.R == null || sq.B == null ? DASH : (sq.R - sq.B > 0 ? '+' : '') + (Math.round((sq.R - sq.B) * 10) / 10) + 'M') + '   ·   HIGHEST: ' + who(sq.R, sq.B, 'M'));
    gap(6);
    const sqMap = new Map(curN.squad.map(x => [K(x.manager), x]));
    const sorted = curN.league.filter(x => x.team !== 'UNKNOWN').slice().sort((a, b) => (a.team === b.team ? 0 : a.team === 'RED' ? -1 : 1));
    const dh = L.add(24);
    [[0, 'TEAM'], [2, 'MANAGER'], [7, 'G-LEVEL'], [9, 'STARTING VALUE'], [12, 'CURRENT VALUE'], [15, 'GROWTH %']].forEach(([c, t]) => L.put(dh, c, t));
    L.blk(dh, dh, 0, 17, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
    [[0, 1], [2, 6], [7, 8], [9, 11], [12, 14], [15, 17]].forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(dh, dh, a, b), mergeType: 'MERGE_ROWS' } }));
    const d0 = L.rows.length;
    const tStart = { RED: 0, BLUE: 0 }, tCur = { RED: 0, BLUE: 0 }, tOk = { RED: true, BLUE: true };
    sorted.forEach(x => {
      const meta = (war.managers || {})[K(x.manager)] || {}, sv = sqMap.get(K(x.manager));
      const start = meta.start != null ? meta.start : null, cur = sv && sv.value != null ? sv.value : null;
      const gr = start != null && start > 0 && cur != null ? Math.round((cur - start) / start * 1e4) / 100 : null;
      if (start == null || cur == null) tOk[x.team] = false; else { tStart[x.team] += start; tCur[x.team] += cur; }
      const q = L.add(26);
      [x.team, x.manager, meta.g || 'N/A', start != null ? M1(start) : 'UNKNOWN', cur != null ? M1(cur) : DASH, gr != null ? gr : 'UNKNOWN'].forEach((v, i) => L.put(q, [0, 2, 7, 9, 12, 15][i], v));
    });
    const d1 = L.rows.length - 1;
    if (d1 >= d0) {
      L.blk(d0, d1, 0, 1, { bg: P.card, b: 1, sz: 8 }, 1);
      L.blk(d0, d1, 2, 6, { bg: P.card, ha: 'LEFT', b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(d0, d1, 7, 8, { bg: P.card, fg: P.mut, sz: 8 }, 1);
      L.blk(d0, d1, 9, 11, { bg: P.card, fg: P.mut, sz: 8, nf: '#,##0.0"M"' }, 1);
      L.blk(d0, d1, 12, 14, { bg: P.card, sz: 8, nf: '#,##0.0"M"' }, 1);
      L.blk(d0, d1, 15, 17, { bg: P.card, b: 1, sz: 9, nf: '+0.00"%";-0.00"%";0.00"%"' }, 1);
      L.teamR.push(L.rg(d0, d1, 0, 1)); L.growR.push(L.rg(d0, d1, 15, 17));
    }
    const tg = t => (tOk[t] && tStart[t] > 0 ? Math.round((tCur[t] - tStart[t]) / tStart[t] * 1e4) / 100 : null);
    cmp([{ label: 'TEAM SQUAD GROWTH %', rv: tg('RED'), bv: tg('BLUE') }], { h: 28, nf: '+0.00"%";-0.00"%";0.00"%"' });
    info('Starting values and G-levels are entered per war (never assumed from the first snapshot). UNKNOWN = not entered yet.', { sz: 7 });
    gap(10);

    // ---- E) Kartlar ----
    sec('YELLOW & RED CARDS');
    cmp([{ label: 'YELLOW CARDS', rv: yc.R, bv: yc.B }, { label: 'RED CARDS', rv: rc.R, bv: rc.B }, { label: 'TOTAL CARDS', rv: yc.R == null || rc.R == null ? null : yc.R + rc.R, bv: yc.B == null || rc.B == null ? null : yc.B + rc.B }], { h: 30 });
    const cr = yc.R == null || rc.R == null ? null : yc.R + rc.R, cb = yc.B == null || rc.B == null ? null : yc.B + rc.B;
    info('MOST CARDS: ' + (cr == null || cb == null ? DASH : cr === cb ? 'LEVEL' : U(cr > cb ? nm.RED : nm.BLUE)) + '   ·   TOTAL: ' + (cr == null || cb == null ? DASH : cr + cb));
    gap(10);

    // ---- F) Menajer sıralaması ----
    sec('MANAGER RANKING  ·  OSM LEAGUE ORDER');
    const heads = [[0, '#'], [1, 'MANAGER'], [4, 'CLUB'], [7, 'TEAM'], [9, 'PTS'], [10, 'MD'], [11, 'SQUAD'], [13, 'GF'], [14, 'GA'], [15, 'GD'], [16, 'YC'], [17, 'RC']];
    const hr = L.add(24);
    heads.forEach(([c, t]) => L.put(hr, c, t));
    L.blk(hr, hr, 0, 17, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
    const mg = [[1, 3], [4, 6], [7, 8], [11, 12]];
    mg.forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(hr, hr, a, b), mergeType: 'MERGE_ROWS' } }));
    const byM = list => new Map((list || []).map(x => [K(x.manager), x]));
    const goalM = byM(curN.goals), squadM = byM(curN.squad);
    const b0 = L.rows.length;
    curN.league.forEach(x => {
      const g = goalM.get(K(x.manager)), s = squadM.get(K(x.manager));
      const lm = last ? last.rows.find(y => K(y.manager) === K(x.manager)) : null;
      const rr = L.add(34);
      [x.rank, x.manager, x.club, x.team, nz(x.points), lm ? lm.diff : DASH, s && s.value != null ? M1(s.value) : DASH,
        g ? nz(g.scored) : DASH, g ? nz(g.conceded) : DASH, g && g.scored != null && g.conceded != null ? g.scored - g.conceded : DASH,
        g ? nz(g.yellow) : DASH, g ? nz(g.red) : DASH].forEach((v, i) => L.put(rr, heads[i][0], v));
    });
    const b1 = L.rows.length - 1;
    if (b1 >= b0) {
      L.blk(b0, b1, 0, 0, { bg: P.card, fg: P.mut, sz: 8 }, 0);
      L.blk(b0, b1, 1, 3, { bg: P.card, ha: 'LEFT', b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(b0, b1, 4, 6, { bg: P.card, ha: 'LEFT', fg: P.mut, sz: 8, wrap: 1 }, 1);
      L.blk(b0, b1, 7, 8, { bg: P.card, b: 1, sz: 8 }, 1);
      L.blk(b0, b1, 9, 9, { bg: P.card, b: 1, sz: 11, fg: P.gold }, 0);
      L.blk(b0, b1, 10, 10, { bg: P.card, sz: 8 }, 0);
      L.blk(b0, b1, 11, 12, { bg: P.card, sz: 8, nf: '0.0"M"' }, 1);
      L.blk(b0, b1, 13, 14, { bg: P.card, sz: 8 }, 0);
      L.blk(b0, b1, 15, 15, { bg: P.card, sz: 8, nf: '+0;-0;0' }, 0);
      L.blk(b0, b1, 16, 17, { bg: P.card, sz: 8 }, 0);
      L.zebra = L.rg(b0, b1, 0, 17); L.teamR.push(L.rg(b0, b1, 7, 8));
    }
    gap(10);

    // ---- G) Maç günü sonuçları (en yeni üstte) ----
    sec('MATCHDAY RESULTS');
    if (!mds.length) info('No matchday confirmed yet. The first result appears after the next matchday is collected and confirmed.', { sz: 8, h: 30 });
    else {
      const gh = L.add(24);
      [[0, 'MD'], [2, 'DATE'], [6, 'RED'], [9, 'BLUE'], [12, 'WINNER'], [16, 'GOALS']].forEach(([c, t]) => L.put(gh, c, t));
      L.blk(gh, gh, 0, 17, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
      [[0, 1], [2, 5], [6, 8], [9, 11], [12, 15], [16, 17]].forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(gh, gh, a, b), mergeType: 'MERGE_ROWS' } }));
      const g0 = L.rows.length;
      mds.slice().reverse().forEach(x => {
        const q = L.add(28);
        [x.matchday, fd(x.ts), x.red, x.blue, x.red > x.blue ? U(nm.RED) : x.blue > x.red ? U(nm.BLUE) : 'DRAW', x.goalDelta ? x.goalDelta.RED + '-' + x.goalDelta.BLUE : DASH].forEach((v, i) => L.put(q, [0, 2, 6, 9, 12, 16][i], v));
      });
      const g1 = L.rows.length - 1;
      L.blk(g0, g1, 0, 1, { bg: P.card, fg: P.gold, b: 1, sz: 9 }, 1);
      L.blk(g0, g1, 2, 5, { bg: P.card, fg: P.mut, sz: 8 }, 1);
      L.blk(g0, g1, 6, 8, { bg: P.card, fg: P.red, b: 1, sz: 11 }, 1);
      L.blk(g0, g1, 9, 11, { bg: P.card, fg: P.blue, b: 1, sz: 11 }, 1);
      L.blk(g0, g1, 12, 15, { bg: P.card, b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(g0, g1, 16, 17, { bg: P.card, fg: P.mut, sz: 8 }, 1);
    }
    gap(10);
    sec('HISTORICAL MATCH DATA');
    info('Per-manager changes between two snapshots. Pairings and match scores are not provided by the OSM league lists, so they are shown as ' + DASH + '. W/D/L is derived from points earned (3 / 1 / 0).', { sz: 7, h: 34 });
    mds.slice().reverse().forEach(x => {
      const sr = L.add(28);
      L.put(sr, 0, 'MATCHDAY ' + x.matchday + '  ·  ' + fd(x.ts) + '  ·  ' + U(nm.RED) + ' ' + x.red + ' – ' + x.blue + ' ' + U(nm.BLUE) + '  ·  ' + (x.red > x.blue ? U(nm.RED) + ' WIN' : x.blue > x.red ? U(nm.BLUE) + ' WIN' : 'DRAW'));
      L.blk(sr, sr, 0, 17, { bg: P.card2, fg: P.fg, b: 1, sz: 8, ha: 'LEFT' }, 1);
      const hh = L.add(22);
      [[0, 'MANAGER'], [4, 'CLUB'], [7, 'TEAM'], [9, 'PTS'], [10, 'RES'], [11, 'GF'], [12, 'GA'], [13, 'YC'], [14, 'RC'], [15, 'OPPONENT']].forEach(([c, t]) => L.put(hh, c, t));
      L.blk(hh, hh, 0, 17, { bg: P.card, fg: P.mut, b: 1, sz: 7 }, 0);
      [[0, 3], [4, 6], [7, 8], [15, 17]].forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(hh, hh, a, b), mergeType: 'MERGE_ROWS' } }));
      const rows = x.rows.slice().sort((a, b) => (a.team === b.team ? 0 : a.team === 'RED' ? -1 : 1));
      const m0 = L.rows.length;
      rows.forEach(y => {
        const q = L.add(26);
        const res = y.diff === 3 ? 'W' : y.diff === 1 ? 'D' : y.diff === 0 ? 'L' : DASH;
        [y.manager, y.club, y.team, y.diff, res, nz(y.gf), nz(y.ga), nz(y.yc), nz(y.rc), DASH].forEach((v, i) => L.put(q, [0, 4, 7, 9, 10, 11, 12, 13, 14, 15][i], v));
      });
      const m1 = L.rows.length - 1;
      L.blk(m0, m1, 0, 3, { bg: P.card, ha: 'LEFT', b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(m0, m1, 4, 6, { bg: P.card, ha: 'LEFT', fg: P.mut, sz: 8, wrap: 1 }, 1);
      L.blk(m0, m1, 7, 8, { bg: P.card, b: 1, sz: 8 }, 1);
      L.blk(m0, m1, 9, 9, { bg: P.card, b: 1, sz: 10 }, 0);
      L.blk(m0, m1, 10, 10, { bg: P.card, b: 1, sz: 8 }, 0);
      L.blk(m0, m1, 11, 14, { bg: P.card, sz: 8 }, 0);
      L.blk(m0, m1, 15, 17, { bg: P.card, fg: P.mut, sz: 8 }, 1);
      L.teamR.push(L.rg(m0, m1, 7, 8)); L.resR.push(L.rg(m0, m1, 10, 10));
      gap(8);
    });

    // ---- Alt bilgi ----
    gap(6);
    info('WAR ID · ' + war.id, { sz: 6, h: 18 });
    info('Generated by OSM 5v5 Auto Score Tracker  ·  source: OSM league page (visible data only)  ·  missing values are shown as ' + DASH + ', never counted as zero', { sz: 6, h: 26 });
    return L;
  }

  // Tek bir batchUpdate isteğinde: temizle + biçimle (değerler ayrı yazılır)
  function battleRequests(L, existingCf, tab) {
    const sid = L.sid, nRows = L.rows.length + 6, q = [];
    q.push({ unmergeCells: { range: { sheetId: sid } } });
    q.push({ repeatCell: { range: { sheetId: sid }, cell: {}, fields: 'userEnteredValue,userEnteredFormat' } });
    for (let i = 0; i < existingCf; i++) q.push({ deleteConditionalFormatRule: { sheetId: sid, index: 0 } });
    q.push({ updateSheetProperties: { properties: { sheetId: sid, gridProperties: { rowCount: nRows, columnCount: NC, frozenRowCount: 2, hideGridlines: true }, tabColorStyle: { rgbColor: colr(tab || P.red) } }, fields: 'gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.hideGridlines,tabColorStyle' } });
    q.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: NC }, properties: { pixelSize: COLW }, fields: 'pixelSize' } });
    q.push({ repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: nRows, startColumnIndex: 0, endColumnIndex: NC }, cell: { userEnteredFormat: fmtOf({ bg: P.bg }) }, fields: 'userEnteredFormat' } });
    let a = 0;
    for (let i = 1; i <= L.h.length; i++) {
      if (i === L.h.length || L.h[i] !== L.h[a]) { q.push({ updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: a, endIndex: i }, properties: { pixelSize: L.h[a] }, fields: 'pixelSize' } }); a = i; }
    }
    L.reqs.forEach(r => q.push(r));
    const rule = (ranges, cond, fmt) => ({ addConditionalFormatRule: { index: 0, rule: { ranges, booleanRule: { condition: cond, format: fmt } } } });
    const eq = t => ({ type: 'TEXT_EQ', values: [{ userEnteredValue: t }] });
    if (L.zebra) q.push(rule([L.zebra], { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=ISEVEN(ROW())' }] }, { backgroundColor: colr(P.card2) }));
    if (L.teamR.length) {
      q.push(rule(L.teamR, eq('RED'), { backgroundColor: colr(P.red), textFormat: { foregroundColor: colr([1, 1, 1]), bold: true } }));
      q.push(rule(L.teamR, eq('BLUE'), { backgroundColor: colr(P.blue), textFormat: { foregroundColor: colr([1, 1, 1]), bold: true } }));
    }
    if (L.growR.length) {
      const num = (t, c) => rule(L.growR, { type: t, values: [{ userEnteredValue: '0' }] }, { textFormat: { foregroundColor: colr(c), bold: true } });
      q.push(num('NUMBER_GREATER', P.grn)); q.push(num('NUMBER_LESS', P.red));
    }
    if (L.statR.length) {
      q.push(rule(L.statR, eq('LIVE'), { backgroundColor: colr(P.grn), textFormat: { foregroundColor: colr([1, 1, 1]), bold: true } }));
      q.push(rule(L.statR, eq('COMPLETED'), { backgroundColor: colr(P.gold), textFormat: { foregroundColor: colr([0.1, 0.1, 0.1]), bold: true } }));
      q.push(rule(L.statR, eq('ARCHIVED'), { backgroundColor: colr([0.4, 0.43, 0.5]), textFormat: { foregroundColor: colr([1, 1, 1]), bold: true } }));
    }
    if (L.resR.length) {
      q.push(rule(L.resR, eq('W'), { textFormat: { foregroundColor: colr(P.grn), bold: true } }));
      q.push(rule(L.resR, eq('D'), { textFormat: { foregroundColor: colr(P.amb), bold: true } }));
      q.push(rule(L.resR, eq('L'), { textFormat: { foregroundColor: colr(P.red), bold: true } }));
    }
    return q;
  }

  // ================= GLOBAL STATS sayfası =================
  function buildGlobal(G, now, sid) {
    const L = new Layout(sid), DASH = '—', nz = v => (v == null ? 'N/A' : v);
    const { sec, gap, info } = helpers(L, nz);
    const fd = d => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const ft = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const R2 = v => (v == null ? null : Math.round(v * 100) / 100), M1 = v => (v == null ? null : Math.round(v / 1e5) / 10);
    const k = G.kpi, minM = G.cfg.minMatches;
    let r = L.add(24);
    L.put(r, 0, 'OSM 5v5 · WAR TRACKER'); L.put(r, 12, '● ' + k.active + ' LIVE');
    L.blk(r, r, 0, 11, { sz: 7, fg: P.mut, ha: 'LEFT', b: 1 }, 1); L.blk(r, r, 12, 17, { sz: 8, b: 1, fg: P.grn, ha: 'RIGHT' }, 1);
    r = L.add(48); L.put(r, 0, 'GLOBAL STATS'); L.blk(r, r, 0, 17, { sz: 18, b: 1 }, 1);
    r = L.add(20); L.put(r, 0, 'All wars · synchronized from every war sheet · updated ' + fd(now) + ', ' + ft(now)); L.blk(r, r, 0, 17, { sz: 7, fg: P.mut }, 1);
    gap(8);

    sec('GLOBAL WAR OVERVIEW');
    const cards = [['TOTAL WARS', k.wars], ['ACTIVE WARS', k.active], ['COMPLETED WARS', k.completed], ['TOTAL MANAGERS', k.managers], ['TOTAL MATCHES', k.matches], ['TOTAL GOALS', k.goals], ['TOTAL YELLOW CARDS', k.yc], ['TOTAL RED CARDS', k.rc], ['ARCHIVED WARS', k.archived]];
    for (let i = 0; i < 9; i += 3) {
      const a = L.add(22), b = L.add(46);
      for (let j = 0; j < 3; j++) { L.put(a, j * 6, cards[i + j][0]); L.put(b, j * 6, nz(cards[i + j][1])); }
      for (let j = 0; j < 3; j++) {
        L.blk(a, a, j * 6, j * 6 + 5, { bg: P.card2, fg: P.mut, sz: 7, b: 1 }, 1);
        L.blk(b, b, j * 6, j * 6 + 5, { bg: P.card, fg: i + j === 7 ? P.red : i + j === 6 ? P.amb : P.fg, sz: 22, b: 1 }, 1);
      }
    }
    gap(8);
    sec('GLOBAL WAR SUMMARY');
    if (!G.wars.length) info('No wars registered yet.');
    else {
      const h = L.add(24);
      [[0, 'LEAGUE'], [6, 'TOURNAMENT'], [10, 'WAR SCORE'], [12, 'GOALS'], [15, 'STATUS']].forEach(([c, t]) => L.put(h, c, t));
      L.blk(h, h, 0, 17, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
      [[0, 5], [6, 9], [10, 11], [12, 14], [15, 17]].forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(h, h, a, b), mergeType: 'MERGE_ROWS' } }));
      const w0 = L.rows.length;
      G.wars.forEach(w => {
        const q = L.add(30), pair = (a, b) => (a == null || b == null ? DASH : a + '-' + b);
        [w.league || 'UNKNOWN LEAGUE', (w.red || 'Team Red').replace(/^Team /, '') + ' vs ' + (w.blue || 'Team Blue').replace(/^Team /, ''), pair(w.redPts, w.bluePts), pair(w.redGoals, w.blueGoals), w.status].forEach((v, i) => L.put(q, [0, 6, 10, 12, 15][i], v));
      });
      const w1 = L.rows.length - 1;
      L.blk(w0, w1, 0, 5, { bg: P.card, ha: 'LEFT', b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(w0, w1, 6, 9, { bg: P.card, fg: P.mut, sz: 8, wrap: 1 }, 1);
      L.blk(w0, w1, 10, 11, { bg: P.card, b: 1, sz: 9 }, 1);
      L.blk(w0, w1, 12, 14, { bg: P.card, sz: 9 }, 1);
      L.blk(w0, w1, 15, 17, { bg: P.card, b: 1, sz: 8 }, 1);
      L.statR.push(L.rg(w0, w1, 15, 17));
    }
    gap(10);

    // Liderlik tabloları: rank | menajer | G | 4 metrik
    const rk = x => (x.rank == null ? DASH : (x.tie ? 'T' : '') + x.rank);
    const board = (title, heads, rows, nfs, note) => {
      sec(title);
      if (!rows.length) { info('No data yet.'); gap(8); return; }
      const h = L.add(24);
      L.put(h, 0, '#'); L.put(h, 1, 'MANAGER'); L.put(h, 6, 'G-LEVEL');
      [8, 11, 14, 16].forEach((c, i) => L.put(h, c, heads[i] || ''));
      L.blk(h, h, 0, 17, { bg: P.card2, fg: P.mut, b: 1, sz: 7 }, 0);
      [[1, 5], [6, 7], [8, 10], [11, 13], [14, 15], [16, 17]].forEach(([a, b]) => L.reqs.push({ mergeCells: { range: L.rg(h, h, a, b), mergeType: 'MERGE_ROWS' } }));
      const b0 = L.rows.length;
      rows.forEach(x => { const q = L.add(28); [x[0], x[1], x[2], x[3], x[4], x[5], x[6]].forEach((v, i) => L.put(q, [0, 1, 6, 8, 11, 14, 16][i], v)); });
      const b1 = L.rows.length - 1;
      L.blk(b0, b1, 0, 0, { bg: P.card, fg: P.gold, b: 1, sz: 8 }, 0);
      L.blk(b0, b1, 1, 5, { bg: P.card, ha: 'LEFT', b: 1, sz: 8, wrap: 1 }, 1);
      L.blk(b0, b1, 6, 7, { bg: P.card, fg: P.mut, sz: 8 }, 1);
      L.blk(b0, b1, 8, 10, { bg: P.card, b: 1, sz: 10, nf: nfs[0] }, 1);
      L.blk(b0, b1, 11, 13, { bg: P.card, sz: 9, nf: nfs[1] }, 1);
      L.blk(b0, b1, 14, 15, { bg: P.card, sz: 9, nf: nfs[2] }, 1);
      L.blk(b0, b1, 16, 17, { bg: P.card, sz: 9, nf: nfs[3] }, 1);
      if (note) info(note, { sz: 7 });
      gap(8);
    };
    const per = (v, ok) => (v == null ? 'N/A' : R2(v) + (ok ? '' : '*'));
    const below = 'Rank "—" or * = fewer than ' + minM + ' tracked matches (minimum is configurable). Totals stay visible; the manager is not ranked on this average.';
    sec('MANAGER LEADERBOARDS');
    gap(4);
    const B = G.boards;
    board('TOP GOAL SCORER', ['TOTAL GOALS', 'GOALS / MATCH', 'WARS', 'AWARDS'], B.scorer.map(x => [rk(x), x.name, x.levelsText, x.total, per(x.gpm, x.eligG), x.warCount, x.awS]), ['0', '@', '0', '0'], 'Goals / match = goals scored during tracked matchdays ÷ tracked matches. * = below the minimum.');
    board('BEST DEFENSIVE MANAGER', ['GOALS CONCEDED', 'CONCEDED / MATCH', 'WARS', 'AWARDS'], B.defence.map(x => [rk(x), x.name, x.levelsText, x.conc, per(x.cpm, x.eligG), x.warCount, x.awD]), ['0', '@', '0', '0'], below);
    board('BEST SQUAD BUILDER  ·  SQUAD DEVELOPMENT', ['AVG GROWTH %', 'VALUE INCREASE', 'WARS', 'AWARDS'], B.squad.map(x => [rk(x), x.name, x.levelsText, R2(x.avgGr), M1(x.incr), x.warCount, x.awB]), ['+0.00"%";-0.00"%";0.00"%"', '+#,##0.0"M";-#,##0.0"M";0.0"M"', '0', '0'], 'Average of each war\'s own growth (starting values are war-specific). ' + below);
    board('MOST WAR POINTS', ['WAR POINTS', 'WARS', 'AVG PTS / MATCH', ''], B.points.map(x => [rk(x), x.name, x.levelsText, x.warPts, x.warCount, R2(x.ppm), '']), ['0', '0', '0.00', '@']);
    board('MOST MATCH WINS', ['MATCH WINS', 'MATCHES', 'WIN %', ''], B.wins.map(x => [rk(x), x.name, x.levelsText, x.wins, x.matches, x.winPct == null ? 'N/A' : Math.round(x.winPct * 10) / 10 + '%', '']), ['0', '0', '@', '@'], 'Individual match wins only (3 points in a matchday). Not the same as team war victories.');

    sec('G-LEVEL PERFORMANCE');
    const cats = [['BEST GOAL SCORER', 'scorer', v => v + ' goals'], ['BEST DEFENSIVE MANAGER', 'defence', v => R2(v) + ' / match'], ['BEST SQUAD BUILDER', 'squad', v => (v > 0 ? '+' : '') + R2(v) + '%'], ['MOST WAR POINTS', 'points', v => v + ' pts'], ['MOST MATCH WINS', 'wins', v => v + ' wins']];
    G.gl && ['G1', 'G3', 'G5', 'G7', 'G9'].forEach(lv => {
      const t = L.add(26); L.put(t, 0, lv + ' PERFORMANCE' + (G.gl[lv].count ? '  ·  ' + G.gl[lv].count + ' managers' : '  ·  no data')); L.blk(t, t, 0, 17, { bg: P.card2, fg: P.fg, b: 1, sz: 8, ha: 'LEFT' }, 1);
      const c0 = L.rows.length;
      cats.forEach(([lab, key, f]) => { const q = L.add(26), x = G.gl[lv][key]; L.put(q, 0, lab); L.put(q, 6, x.value == null ? 'N/A' : x.names); L.put(q, 14, x.value == null ? 'N/A' : f(x.value)); });
      const c1 = L.rows.length - 1;
      L.blk(c0, c1, 0, 5, { bg: P.card, fg: P.mut, b: 1, sz: 7, ha: 'LEFT' }, 1);
      L.blk(c0, c1, 6, 13, { bg: P.card, b: 1, sz: 8, ha: 'LEFT', wrap: 1 }, 1);
      L.blk(c0, c1, 14, 17, { bg: P.card, fg: P.gold, b: 1, sz: 8 }, 1);
      gap(6);
    });
    info('Managers are compared only against managers of the same G-level; a manager\'s G-level is war-specific and historical records are kept. N/A = not enough information.', { sz: 7, h: 30 });
    gap(6);
    info('Rules: awards = number of DIFFERENT wars a manager ranked first in (ties shared, repeated uploads never counted); only COMPLETED / ARCHIVED wars award titles' + (G.cfg.countLive ? ' (LIVE wars included by setting)' : '') + '. Manager identity = manager name. Missing values are N/A, never zero.', { sz: 6, h: 36 });
    return L;
  }

  // ================= Savaş sayfasını bul / oluştur / güncelle =================
  const WAR_COLS = ['warId', 'league', 'red', 'blue', 'status', 'sheet', 'sheetId', 'startTs', 'updated', 'matchdays', 'redPts', 'bluePts', 'redWar', 'blueWar', 'redGoals', 'blueGoals', 'redConc', 'blueConc', 'yc', 'rc', 'redWins', 'blueWins', 'draws', 'managers'];
  const MGR_COLS = ['warId', 'key', 'name', 'club', 'team', 'g', 'start', 'current', 'growth', 'gf', 'ga', 'yc', 'rc', 'pts', 'warPts', 'matches', 'wins', 'draws', 'losses', 'gm', 'tgf', 'tga'];
  const GLOBAL = 'GLOBAL STATS', HID_W = '_WARS', HID_M = '_MANAGERS', MD_KEY = 'osm_war_id';
  const asTable = (cols, objs) => [cols].concat(objs.map(o => cols.map(c => (o[c] == null ? '' : o[c]))));
  function fromTable(vals, cols) {
    if (!vals || vals.length < 2) return [];
    const head = vals[0];
    return vals.slice(1).filter(r => r[0] !== '' && r[0] != null).map(r => { const o = {}; cols.forEach(c => { const i = head.indexOf(c), v = i >= 0 ? r[i] : ''; o[c] = v === '' || v === undefined ? null : v; }); return o; });
  }
  const cleanTitle = t => String(t || '').replace(/[\[\]*?:\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'UNKNOWN LEAGUE';
  const newSheetId = metaSheets => Math.max(1000, Date.now() % 2000000000, ...metaSheets.map(s => s.properties.sheetId + 1));
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

  // ctx: { war, model, cfg:{minMatches,countLive} } -> savaşın sayfasını günceller, gizli veriyi ve GLOBAL STATS'ı senkronlar
  async function pushWar(id, ctx) {
    const war = ctx.war, model = ctx.model;
    let meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats,developerMetadata)');
    // 1) yapı: GLOBAL STATS (ilk sıra) + gizli veri sayfaları
    const reqs = [];
    let nextId = newSheetId(meta.sheets);
    const has = t => meta.sheets.some(s => s.properties.title === t);
    if (!has(GLOBAL)) reqs.push({ addSheet: { properties: { sheetId: nextId++, title: GLOBAL, index: 0 } } });
    [HID_W, HID_M].forEach(t => { if (!has(t)) reqs.push({ addSheet: { properties: { sheetId: nextId++, title: t, hidden: true } } }); });
    // 2) savaş sayfası: kalıcı War ID (geliştirici üst verisi) ile bul — ad değişse de kırılmaz
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
    // geçmiş koruması (yalnızca mevcut sayfa için)
    if (!created) {
      const col = await api('GET', API + '/' + id + '/values/' + encodeURIComponent(q(title) + '!A:A'));
      const have = (col.values || []).map(x => /^MATCHDAY (\d+)/.exec(String(x[0] || ''))).filter(Boolean).map(x => Number(x[1]));
      const mine = new Set(model.mds.map(x => x.matchday));
      const missing = have.filter(n => !mine.has(n));
      if (missing.length) throw new Error('HISTORY_GUARD: Sayfada yerel kayıtta olmayan maç günleri var (' + missing.join(', ') + '). Eski veriler silinmesin diye güncelleme durduruldu; önce JSON yedeğini geri yükleyin.');
    }
    meta = await api('GET', API + '/' + id + '?fields=sheets(properties,conditionalFormats,developerMetadata)');
    const cur = meta.sheets.find(s => s.properties.sheetId === sheetId);
    // 3) savaş sayfasını çiz
    const rowsM = OSMWars.managerRows(war, model.curN, model.mds);
    const L = buildWar(Object.assign({}, model, { war }), sheetId); L.title = title;
    await applyLayout(id, L, (cur.conditionalFormats || []).length, war.status === 'ARCHIVED' ? [0.4, 0.43, 0.5] : P.red);
    // 4) gizli senkron veri: bu savaşın satırlarını değiştir, diğer savaşlara dokunma
    const wv = await readHidden(id, HID_W), mv = await readHidden(id, HID_M);
    const wars = fromTable(wv, WAR_COLS).filter(w => w.warId !== war.id);
    const mgrs = fromTable(mv, MGR_COLS).filter(r => r.warId !== war.id);
    wars.push(OSMWars.warRow(war, model.curN, model.mds, rowsM, title)); rowsM.forEach(r => mgrs.push(r));
    await writeHidden(id, HID_W, asTable(WAR_COLS, wars), wv.length);
    await writeHidden(id, HID_M, asTable(MGR_COLS, mgrs), mv.length);
    // 5) GLOBAL STATS
    await writeGlobal(id, wars, mgrs, ctx.cfg);
    return { title, created, sheetId, matchdays: model.mds.length, wars: wars.length };
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

  g.OSMSheets = { SHEETS, hasToken, requestToken, create, ensure, test, push, pushWar, deleteWarSheet, buildWar, buildGlobal, battleRequests, buildTables, toXlsx };
})(window);
