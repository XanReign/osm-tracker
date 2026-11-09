/* tracker.js — köprü, kayıt işleme, arayüz, dışa aktarma + günlük skor sıfırlama */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ts => (ts ? new Date(ts).toLocaleString('tr-TR') : '—');
  const val = v => (v == null ? 'UNKNOWN' : v);
  const mil = v => (v == null ? 'UNKNOWN' : Math.round(v / 1e5) / 10 + 'M');

  let ST, SNAPS = [], MDS = [], CUR = null, BASE = null, curN = null, baseN = null, diff = null, tour = null;
  let busy = false, bridgeSeen = false, dailyCleared = false;

  function toast(m) {
    const t = $('toast');
    t.textContent = m; t.className = 'show';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = ''; }, 3500);
  }
  const fail = async (code, e) => { await OSMDB.log('ERROR', code, e && e.message ? e.message : e); toast(code + ': ' + (e && e.message ? e.message : e)); };

  // ---------- Veri yükleme ----------
  async function kv(k) { const r = await OSMDB.get('kv', k); return r ? r.value : null; }

  async function load() {
    SNAPS = (await OSMDB.all('snapshots')).sort((a, b) => a.ts - b.ts);
    MDS = (await OSMDB.all('matchdays')).sort((a, b) => a.matchday - b.matchday);
    const byId = id => SNAPS.find(s => s.id === id) || null;
    CUR = byId(await kv('latest')) || SNAPS[SNAPS.length - 1] || null;
    BASE = byId(await kv('baseline'));
    dailyCleared = (await kv('dailyCleared')) === true;
    curN = CUR ? OSMScore.normalize(CUR, ST) : null;
    baseN = BASE ? OSMScore.normalize(BASE, ST) : null;
    diff = curN && baseN && CUR.id !== BASE.id ? OSMScore.computeDiff(baseN, curN) : null;
    tour = OSMScore.tournament(MDS);
  }

  // ---------- Kayıt işleme ----------
  async function processQueue(queue) {
    const ids = [];
    let added = 0;
    queue.sort((a, b) => a.ts - b.ts);
    for (const it of queue) {
      ids.push(it.id);
      if (it.kind !== 'error' && (!it.v || it.v < 2)) { await OSMDB.log('WARN', 'OLD_FORMAT', 'Eski biçimli kayıt atlandı (yeniden toplayın): ' + it.id); continue; }
      if (it.kind === 'error') { await OSMDB.log('ERROR', it.error.code, it.error.msg); continue; }
      if (await OSMDB.get('snapshots', it.id)) { await OSMDB.log('INFO', 'DUPLICATE', 'Aynı kayıt ikinci kez geldi: ' + it.id); continue; }
      const raw = {};
      Object.keys(it.tabs).forEach(k => { raw[k] = it.tabs[k].raw; delete it.tabs[k].raw; });
      await OSMDB.put('snapshots', it);
      await OSMDB.put('kv', { key: 'lastRaw', value: raw });
      await OSMDB.put('kv', { key: 'latest', value: it.id });
      added++;
      for (const k of Object.keys(it.tabs)) {
        if (!it.tabs[k].ok) await OSMDB.log('WARN', 'TAB_' + k.toUpperCase(), it.tabs[k].error || 'okunamadı');
      }
      if (!(await kv('baseline')) && it.tabs.league && it.tabs.league.ok) {
        await OSMDB.put('kv', { key: 'baseline', value: it.id });
        await OSMDB.log('INFO', 'BASELINE_SET', 'İlk kayıt başlangıç noktası yapıldı; skor üretilmedi.');
      }
    }
    await load();
    if (ST.autoCommit && diff && diff.valid && !diff.unchanged && !diff.warnings.length) await commit();
    return { ids, added };
  }

  async function commit() {
    if (!diff || !diff.valid || diff.unchanged) throw new Error('Onaylanabilir geçerli fark yok' + (diff && diff.reasons.length ? ': ' + diff.reasons.join('; ') : ''));
    let n = ST.matchday;
    if (MDS.some(m => m.matchday === n)) n = Math.max.apply(null, MDS.map(m => m.matchday)) + 1;
    const sq = OSMScore.agg(curN.squad, 'value'), gl = OSMScore.agg(curN.goals, 'goals'), gb = OSMScore.agg(baseN.goals, 'goals');
    const hasGoals = curN.goals.length && baseN.goals.length;
    const rec = {
      matchday: n, ts: Date.now(), baselineId: BASE.id, snapshotId: CUR.id,
      red: diff.red, blue: diff.blue, rows: diff.rows,
      squad: { RED: sq.RED.sum, BLUE: sq.BLUE.sum },
      goals: { RED: curN.goals.length ? gl.RED.sum : null, BLUE: curN.goals.length ? gl.BLUE.sum : null },
      goalDelta: hasGoals ? { RED: gl.RED.sum - gb.RED.sum, BLUE: gl.BLUE.sum - gb.BLUE.sum } : null
    };
    await OSMDB.put('matchdays', rec);
    await OSMDB.put('kv', { key: 'baseline', value: CUR.id });
    await OSMDB.put('kv', { key: 'dailyCleared', value: false });
    ST.matchday = n + 1;
    await OSMSettings.save(ST);
    await OSMDB.log('INFO', 'MATCHDAY_COMMIT', 'MD' + n + ': RED ' + rec.red + ' - ' + rec.blue + ' BLUE');
    await refresh();
  }

  // ---------- Sheets ----------
  async function buildModel() {
    return { now: Date.now(), st: ST, curN, baseN, diff, mds: MDS, tour, logs: await OSMDB.all('logs'), snaps: SNAPS };
  }
  async function pushSheets(interactive) {
    if (!ST.spreadsheetId) throw new Error('Google Sheets ID ayarlı değil');
    if (!OSMSheets.hasToken()) {
      if (!interactive) throw new Error('Google bağlantısı gerekli (token yok / süresi dolmuş)');
      await OSMSheets.requestToken(ST.clientId);
    }
    const n = await OSMSheets.push(ST.spreadsheetId, await buildModel());
    await OSMDB.log('INFO', 'SHEETS_PUSH', n + ' sayfa güncellendi');
  }

  // ---------- Köprü (userscript) ----------
  const post = o => { o.src = 'osm-tracker'; window.postMessage(JSON.stringify(o), '*'); };
  const ask = () => post({ type: 'GET_QUEUE' });

  window.addEventListener('message', async e => {
    if (e.source !== window || typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (!m || m.src !== 'osm-collector') return;
    bridgeSeen = true;
    $('bridge').textContent = 'Userscript: bağlı';
    if (m.type === 'READY') ask();
    if (m.type === 'QUEUE') await onQueue(m.queue || []);
  });

  async function onQueue(q) {
    if (busy) return;
    if (!q.length) { toast('Kuyrukta yeni kayıt yok'); return; }
    busy = true;
    try {
      const r = await processQueue(q);
      post({ type: 'ACK', ids: r.ids });
      await refresh();
      toast(r.added + ' yeni kayıt işlendi');
      if (ST.autoSync && ST.spreadsheetId && OSMSheets.hasToken()) {
        try { await pushSheets(false); toast('Google Sheets güncellendi'); } catch (err) { await fail('SHEETS_API', err); }
      }
    } catch (err) { await fail('QUEUE', err); } finally { busy = false; }
  }

  // ---------- Çizim ----------
  const star = a => (a ? a.sum + (a.unknown ? '*' : '') : 'UNKNOWN');
  const table = (head, rows, teamCol) => '<table><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map((c, i) => '<td' + (i === teamCol ? ' class="' + esc(c) + '"' : '') + '>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';

  function render() {
    const last = MDS[MDS.length - 1];
    $('status').innerHTML = CUR
      ? 'Son kayıt: ' + esc(fmt(CUR.ts)) + ' · Başlangıç noktası: ' + esc(BASE ? fmt(BASE.ts) : 'YOK') + ' · Kayıtlı maç günü: ' + MDS.length +
        (curN && curN.warnings.length ? '<br><span class="warn">Uyarı: ' + esc(curN.warnings.slice(0, 3).join(' | ')) + '</span>' : '') +
        '<br>* = bazı değerler UNKNOWN, toplam eksik olabilir.'
      : 'Henüz kayıt yok. OSM lig sayfasında userscript\'i çalıştırın, sonra "Userscript\'ten veri al"a basın.';

    const lg = curN && OSMScore.agg(curN.league, 'points'), sq = curN && OSMScore.agg(curN.squad, 'value'), gl = curN && OSMScore.agg(curN.goals, 'goals');
    $('teams').innerHTML = ['RED', 'BLUE'].map(t => {
      const pending = diff && diff.valid ? diff[t.toLowerCase()] : null;
      const dailyValue = pending != null ? pending : (dailyCleared ? '—' : (last ? last[t.toLowerCase()] : '—'));
      const dailyLabel = pending != null
        ? 'bekleyen maç günü puanı'
        : (dailyCleared ? (diff && !diff.valid ? 'günlük fark doğrulanamadı' : 'yeni maç günü bekleniyor') : 'son maç günü puanı');
      return '<div class="team ' + t + '"><div class="t">TEAM ' + t + '</div>' +
        '<div class="big">' + esc(dailyValue) + '</div>' +
        '<div class="m">' + esc(dailyLabel) + '</div>' +
        '<div class="m">Savaş toplamı: ' + (t === 'RED' ? tour.redPts : tour.bluePts) + ' · MD galibiyeti: ' + (t === 'RED' ? tour.redWins : tour.blueWins) + '</div>' +
        '<div class="m">Lig puanı: ' + esc(star(lg && lg[t])) + '</div>' +
        '<div class="m">Kadro: ' + esc(sq ? mil(sq[t].sum) + (sq[t].unknown ? '*' : '') : 'UNKNOWN') + '</div>' +
        '<div class="m">Gol: ' + esc(star(gl && gl[t])) + '</div>' +
        '<div class="m">Menajer: ' + (lg ? lg[t].n : 'UNKNOWN') + '</div></div>';
    }).join('');

    if (!BASE) $('preview').textContent = 'Başlangıç noktası yok; skor üretilmedi.';
    else if (!diff && dailyCleared) $('preview').textContent = 'Günlük skor temizlendi. Yeni maç gününün puan farkı bekleniyor. Genel RED vs BLUE savaş skoru ve önceki maç günleri korundu.';
    else if (!diff) $('preview').textContent = 'Başlangıç noktasından sonra yeni kayıt yok.';
    else {
      let h = diff.valid ? (diff.unchanged ? '<p>Puan değişmedi.</p>' : '<p class="ok"><b>RED ' + diff.red + ' - ' + diff.blue + ' BLUE</b> (geçerli)</p>') : '<p class="bad">Geçersiz: ' + esc(diff.reasons.join('; ')) + '</p>';
      if (diff.warnings.length) h += '<p class="warn">' + esc(diff.warnings.join(' | ')) + '</p>';
      h += table(['Menajer', 'Takım', 'Önceki', 'Şimdi', 'Fark'], diff.rows.map(r => [r.manager, r.team, r.prev, r.curr, r.diff]), 1);
      $('preview').innerHTML = h;
    }

    $('standings').innerHTML = curN && curN.league.length ? table(['#', 'Kulüp', 'Menajer', 'Takım', 'Puan'], curN.league.map(r => [r.rank, r.club, r.manager, r.team, val(r.points)]), 3) : 'Veri yok (UNKNOWN)';
    $('squad').innerHTML = curN && curN.squad.length ? table(['#', 'Menajer', 'Takım', 'Değer', 'Ham'], curN.squad.map(r => [r.rank, r.manager, r.team, mil(r.value), val(r.valueRaw)]), 2) : 'Kadro değeri okunamadı (UNKNOWN)';
    $('goals').innerHTML = curN && curN.goals.length
      ? table(['#', 'Kulüp', 'Menajer', 'Takım', 'Atılan', 'Yenilen'], curN.goals.map(r => [r.rank, r.club, r.manager, r.team, val(r.scored), val(r.conceded)]), 3) +
        (curN.topScorers.length ? '<p class="small">Gol kralları: ' + esc(curN.topScorers.map(x => x.player + ' (' + x.team + ') ' + x.goals).join(' · ')) + '</p>' : '')
      : 'Gol bilgisi okunamadı (UNKNOWN)';

    $('history').innerHTML = MDS.length
      ? table(['MD', 'Tarih', 'RED', 'BLUE', 'Kadro R', 'Kadro B'], MDS.slice().reverse().map(m => [m.matchday, fmt(m.ts), m.red, m.blue, mil(m.squad.RED), mil(m.squad.BLUE)]))
      : 'Kayıtlı maç günü yok.';
  }

  async function renderLogs() {
    const logs = (await OSMDB.all('logs')).slice(-100).reverse();
    $('logs').innerHTML = logs.length ? table(['Tarih', 'Seviye', 'Kod', 'Mesaj'], logs.map(l => [fmt(l.ts), l.level, l.code, l.msg])) : 'Log yok.';
    const raw = await kv('lastRaw');
    $('raw').textContent = raw ? Object.keys(raw).map(k => '=== ' + k + ' ===\n' + (raw[k] || '').slice(0, 1200)).join('\n\n') : '(yok)';
  }

  async function refresh() { await load(); render(); await renderLogs(); }

  // ---------- Dışa aktarma ----------
  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  function toCsv() {
    const rows = [['matchday', 'tarih', 'menajer', 'kulup', 'takim', 'onceki', 'yeni', 'fark']];
    MDS.forEach(m => m.rows.forEach(r => rows.push([m.matchday, fmt(m.ts), r.manager, r.club, r.team, r.prev, r.curr, r.diff])));
    return rows.map(r => r.map(csvCell).join(',')).join('\n');
  }

  // ---------- Olaylar ----------
  function showTab(name) {
    ['panel', 'settings', 'history', 'logs'].forEach(t => { $('tab-' + t).hidden = t !== name; });
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  }
  const act = (id, fn) => $(id).addEventListener('click', async () => { try { await fn(); } catch (e) { await fail(id.toUpperCase(), e); } });

  async function saveForm() {
    ST = OSMSettings.fromForm(ST);
    ST.spreadsheetId = OSMSettings.cleanSheetId(ST.spreadsheetId);
    await OSMSettings.save(ST);
    OSMSettings.toForm(ST);
    await refresh();
  }

  async function init() {
    await OSMDB.open();
    ST = await OSMSettings.load();
    OSMSettings.toForm(ST);
    document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

    act('b-fetch', async () => {
      ask();
      setTimeout(() => { if (!bridgeSeen) toast('Userscript yanıt vermedi: bu sayfada çalışıyor mu? (@match yolu /osm-tracker/ olmalı)'); }, 2000);
    });
    act('b-commit', async () => { await commit(); toast('Maç günü kaydedildi'); });
    act('b-push', async () => { await pushSheets(true); toast('Google Sheets güncellendi'); });
    act('b-save', async () => { await saveForm(); toast('Kaydedildi'); });
    act('b-autofill', async () => {
      if (!curN) throw new Error('Önce veri toplanmalı');
      ST.redManagers = curN.league.filter(r => r.team === 'RED').map(r => r.manager);
      ST.blueManagers = curN.league.filter(r => r.team === 'BLUE').map(r => r.manager);
      await OSMSettings.save(ST); OSMSettings.toForm(ST); await refresh();
      toast('RED ' + ST.redManagers.length + ' / BLUE ' + ST.blueManagers.length + ' menajer (kulüp adlarındaki "Team Red/Blue" ifadesinden). Kontrol edin.');
    });
    act('b-google', async () => { await saveForm(); await OSMSheets.requestToken(ST.clientId); toast('Google bağlandı (yaklaşık 1 saat geçerli)'); });
    act('b-create', async () => {
      await saveForm();
      if (!OSMSheets.hasToken()) await OSMSheets.requestToken(ST.clientId);
      ST.spreadsheetId = await OSMSheets.create('OSM 5v5 Tracker');
      await OSMSettings.save(ST); OSMSettings.toForm(ST);
      await OSMDB.log('INFO', 'SHEET_CREATED', ST.spreadsheetId);
      toast('Tablo oluşturuldu');
    });
    act('b-test', async () => {
      await saveForm();
      if (!OSMSheets.hasToken()) await OSMSheets.requestToken(ST.clientId);
      toast('Bağlantı OK: ' + await OSMSheets.test(ST.spreadsheetId));
    });
    act('b-baseline', async () => {
      if (!CUR) throw new Error('Kayıt yok');
      if (!confirm('Başlangıç noktası şimdiki kayıt olarak değiştirilsin? Bekleyen fark sıfırlanır.')) return;
      await OSMDB.put('kv', { key: 'baseline', value: CUR.id });
      await OSMDB.put('kv', { key: 'dailyCleared', value: true });
      await OSMDB.log('INFO', 'BASELINE_RESET', CUR.id);
      await refresh();
    });

    // Yeni lig için yalnızca günlük farkı temizle. Geçmiş maç günleri ve genel savaş skoru korunur.
    act('b-new-war', async () => {
      if (!CUR || !curN || !curN.league || !curN.league.length) {
        throw new Error("Önce yeni ligden veri toplayıp Tracker'a aktarın.");
      }
      const redManagers = [];
      const blueManagers = [];
      curN.league.forEach(row => {
        const match = /\bteam\s*(red|blue)\b/i.exec(String(row.club || ''));
        if (!match || !row.manager || row.manager === 'UNKNOWN') return;
        (match[1].toUpperCase() === 'RED' ? redManagers : blueManagers).push(row.manager);
      });
      if (redManagers.length !== 5 || blueManagers.length !== 5) {
        throw new Error('Kulüp adlarından tam 5 RED ve 5 BLUE menajer tanınamadı. Günlük skor temizlenmedi; menajer listelerini kontrol edin.');
      }
      const confirmed = confirm(
        'YENİ SAVAŞ BAŞLAT / GÜNLÜK SKORU TEMİZLE\n\n' +
        'Günlük bekleyen puan farkı sıfırlanacak ve mevcut lig kaydı yeni başlangıç noktası olacak.\n\n' +
        'KORUNACAK: Genel RED vs BLUE savaş toplamı, onaylanmış maç günleri, lig/kadro/gol/kart verileri ve Google Sheets kayıtları.\n\n' +
        'Devam edilsin mi?'
      );
      if (!confirmed) return;

      ST.redManagers = redManagers;
      ST.blueManagers = blueManagers;
      if (CUR.url) ST.leagueUrl = CUR.url;
      const lastMatchday = MDS.reduce((max, item) => Math.max(max, Number(item.matchday) || 0), 0);
      ST.matchday = Math.max(Number(ST.matchday) || 1, lastMatchday + 1, 1);
      await OSMSettings.save(ST);
      await OSMDB.put('kv', { key: 'baseline', value: CUR.id });
      await OSMDB.put('kv', { key: 'dailyCleared', value: true });
      await OSMDB.log('INFO', 'NEW_WAR_DAILY_RESET',
        'Günlük skor temizlendi; genel savaş skoru ve maç günü geçmişi korundu. RED=' + redManagers.length + ', BLUE=' + blueManagers.length);
      OSMSettings.toForm(ST);
      await refresh();
      toast('Günlük skor temizlendi. Genel savaş skoru ve diğer istatistikler korundu.');
    });

    act('b-backup', async () => { download('osm5v5-yedek-' + Date.now() + '.json', JSON.stringify(await OSMDB.exportAll()), 'application/json'); });
    act('b-restore', async () => { $('f-restore').click(); });
    $('f-restore').addEventListener('change', async e => {
      try {
        const f = e.target.files[0];
        if (!f) return;
        const n = await OSMDB.importAll(JSON.parse(await f.text()));
        ST = await OSMSettings.load(); OSMSettings.toForm(ST);
        await refresh(); toast(n + ' kayıt geri yüklendi');
      } catch (err) { await fail('RESTORE', err); }
      e.target.value = '';
    });
    act('b-csv', async () => { download('osm5v5-maclar.csv', toCsv(), 'text/csv'); });

    await refresh();
    // Köprü: userscript READY göndermediyse (önce yüklendiyse) biz isteyelim
    [300, 1500, 4000].forEach(ms => setTimeout(() => { if (!bridgeSeen) ask(); }, ms));
    setTimeout(() => { if (!bridgeSeen) $('bridge').textContent = 'Userscript: yanıt yok (kurulu ve @match doğru mu?)'; }, 5000);
  }

  window.addEventListener('error', e => { OSMDB.log('ERROR', 'JS_ERROR', e.message); });
  init().catch(e => { document.body.insertAdjacentHTML('afterbegin', '<p class="bad">Başlatma hatası: ' + esc(e.message) + '</p>'); });
})();
