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

  async function create(title) {
    const j = await api('POST', API, { properties: { title }, sheets: SHEETS.map(t => ({ properties: { title: t } })) });
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
    const star = a => (a ? a.sum + (a.unknown ? ' (+' + a.unknown + ' UNKNOWN)' : '') : 'UNKNOWN');
    const sqs = a => (a ? mil(a.sum) + (a.unknown ? ' (+' + a.unknown + ' UNKNOWN)' : '') : 'UNKNOWN');
    const gm = curN ? OSMScore.goalsByManager(curN.goals) : [];
    let bestMgr = 'UNKNOWN';
    if (mds.length) {
      const tot = new Map();
      mds.forEach(x => x.rows.forEach(r => tot.set(r.manager, (tot.get(r.manager) || 0) + r.diff)));
      const arr = Array.from(tot.entries()).sort((a, b) => b[1] - a[1]);
      if (arr.length) bestMgr = arr[0][0] + ' (' + arr[0][1] + ' puan)';
    }

    S['DASHBOARD'] = [
      ['OSM 5v5 — TEAM RED vs TEAM BLUE'],
      ['Son güncelleme', fmt(m.now)],
      [],
      ['', 'TEAM RED', 'TEAM BLUE'],
      ['Bekleyen maç günü puanı', diff && diff.valid ? diff.red : 'UNKNOWN', diff && diff.valid ? diff.blue : 'UNKNOWN'],
      ['Son kayıtlı maç günü puanı', last ? last.red : 'UNKNOWN', last ? last.blue : 'UNKNOWN'],
      ['Toplam savaş puanı', tour.redPts, tour.bluePts],
      ['Maç günü galibiyeti', tour.redWins, tour.blueWins],
      ['Lig puanı (kümülatif)', star(lg && lg.RED), star(lg && lg.BLUE)],
      ['Kadro değeri', sqs(sq && sq.RED), sqs(sq && sq.BLUE)],
      ['Atılan gol', star(gl && gl.RED), star(gl && gl.BLUE)],
      ['Menajer', lg ? lg.RED.n : 'UNKNOWN', lg ? lg.BLUE.n : 'UNKNOWN'],
      [],
      ['Genel savaş skoru', 'RED ' + tour.redPts + ' - ' + tour.bluePts + ' BLUE  (galibiyet ' + tour.redWins + '-' + tour.blueWins + ', ' + tour.draws + ' berabere)'],
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
        range: { sheetId: ids.get('DASHBOARD'), startRowIndex: 3, endRowIndex: 4 },
        cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }, fields: 'userEnteredFormat.textFormat'
      }
    });
    await api('POST', API + '/' + id + ':batchUpdate', { requests: reqs });
    return names.length;
  }

  g.OSMSheets = { SHEETS, hasToken, requestToken, create, ensure, test, push, buildTables };
})(window);
