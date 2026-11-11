/* tracker.js — köprü, kayıt işleme, arayüz, dışa aktarma (bridge fix) */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ts => (ts ? new Date(ts).toLocaleString('tr-TR') : '—');
  const val = v => (v == null ? 'UNKNOWN' : v);
  const mil = v => (v == null ? 'UNKNOWN' : Math.round(v / 1e5) / 10 + 'M');

  let ST, WARS = [], WAR = null, ALLMD = [], SNAPS = [], MDS = [], CUR = null, BASE = null, curN = null, baseN = null, diff = null, tour = null;
  let busy = false, bridgeSeen = false, appReady = false, requestSeq = 0;
  const pendingRequests = new Map();

  function toast(message) {
    const t = $('toast');
    if (!t) return;
    t.textContent = message;
    t.className = 'show';
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.className = ''; }, 4000);
  }
  const fail = async (code, error) => {
    const message = error && error.message ? error.message : String(error);
    try { await OSMDB.log('ERROR', code, message); } catch (_) { /* DB henüz açılmamış olabilir */ }
    toast(code + ': ' + message);
  };

  // ---------- Veri yükleme ----------
  async function kv(key) { const record = await OSMDB.get('kv', key); return record ? record.value : null; }

  // ---------- Savaş kaydı / kapsam ----------
  async function loadST() {
    const g = await OSMSettings.load();
    ST = Object.assign({}, g, WAR ? Object.assign({}, WAR.cfg, { battleCompleted: WAR.status === 'COMPLETED' }) : {});
  }
  async function saveST() {
    const sp = OSMWars.splitSettings(ST);
    await OSMSettings.save(sp.global);
    if (WAR) {
      WAR.cfg = Object.assign(WAR.cfg || {}, sp.cfg);
      if (WAR.status !== 'ARCHIVED') WAR.status = ST.battleCompleted ? 'COMPLETED' : 'LIVE';
      await OSMWars.saveWars(WARS);
    }
  }
  async function loadWars() {
    WARS = await OSMWars.listWars();
    const id = await OSMWars.getCurrentId();
    WAR = WARS.find(w => w.id === id && !w.deleted) || WARS.find(w => !w.deleted) || null;
  }
  async function selectWar(id) {
    WAR = WARS.find(w => w.id === id) || null;
    if (WAR) await OSMWars.setCurrentId(WAR.id);
    await loadST();
    OSMSettings.toForm(ST);
    await refresh();
  }

  async function load() {
    const wid = WAR ? WAR.id : null;
    SNAPS = (await OSMDB.all('snapshots')).filter(s => s.warId === wid).sort((a, b) => a.ts - b.ts);
    ALLMD = await OSMDB.all('md');
    MDS = ALLMD.filter(m => m.warId === wid).sort((a, b) => a.matchday - b.matchday);
    const byId = id => SNAPS.find(s => s.id === id) || null;
    CUR = byId(await kv('latest:' + wid)) || SNAPS[SNAPS.length - 1] || null;
    BASE = byId(await kv('baseline:' + wid));
    curN = CUR ? OSMScore.normalize(CUR, ST) : null;
    baseN = BASE ? OSMScore.normalize(BASE, ST) : null;
    diff = curN && baseN && CUR.id !== BASE.id ? OSMScore.computeDiff(baseN, curN) : null;
    tour = OSMScore.tournament(MDS);
  }
  async function processQueue(queue) {
    const ids = [];
    let added = 0, newWars = 0, lastWarId = null;
    queue.sort((a, b) => a.ts - b.ts);
    for (const item of queue) {
      if (item && item.id) ids.push(item.id);
      if (!item || item.kind !== 'error' && (!item.v || item.v < 2)) {
        if (item && item.id) await OSMDB.log('WARN', 'OLD_FORMAT', 'Eski biçimli kayıt atlandı (yeniden toplayın): ' + item.id);
        continue;
      }
      if (item.kind === 'error') {
        await OSMDB.log('ERROR', item.error && item.error.code || 'COLLECTOR_ERROR', item.error && item.error.msg || 'Collector hatası');
        continue;
      }
      if (await OSMDB.get('snapshots', item.id)) {
        await OSMDB.log('INFO', 'DUPLICATE', 'Aynı kayıt ikinci kez geldi: ' + item.id);
        continue;
      }
      // Kuyruk nesnesini değiştirmeden raw metinleri ayrı al.
      const stored = JSON.parse(JSON.stringify(item));
      const raw = {};
      Object.keys(stored.tabs || {}).forEach(key => {
        raw[key] = stored.tabs[key].raw || '';
        delete stored.tabs[key].raw;
      });
      // Savaş kimliği: OSM lig adı/URL'si + menajer kümesi. Eşleşme yoksa yeni savaş kaydı açılır.
      const nn = OSMScore.normalize(stored, ST);
      let war = null;
      if (nn.tabOk.league) {
        const fp = OSMWars.fingerprint(nn, stored);
        war = OSMWars.findWar(WARS, fp);
        if (!war) {
          war = OSMWars.createWar(fp, nn, stored, {});
          WARS.push(war);
          newWars++;
          await OSMDB.log('INFO', 'WAR_CREATED', 'Yeni savaş: ' + (war.league || 'UNKNOWN LEAGUE') + ' · ' + war.id);
        }
        OSMWars.refreshWar(war, nn, stored);
      } else if (WAR) {
        war = WAR;
        await OSMDB.log('WARN', 'WAR_UNIDENTIFIED', 'Lig tablosu okunamadı; kayıt seçili savaşa bağlandı: ' + WAR.id);
      }
      stored.warId = war ? war.id : null;
      await OSMDB.put('snapshots', stored);
      await OSMDB.put('kv', { key: 'lastRaw', value: raw });
      if (war) { await OSMDB.put('kv', { key: 'latest:' + war.id, value: stored.id }); lastWarId = war.id; }
      added++;
      for (const key of Object.keys(stored.tabs || {})) {
        if (!stored.tabs[key].ok) await OSMDB.log('WARN', 'TAB_' + key.toUpperCase(), stored.tabs[key].error || 'okunamadı');
      }
      if (war && !(await kv('baseline:' + war.id)) && stored.tabs.league && stored.tabs.league.ok) {
        await OSMDB.put('kv', { key: 'baseline:' + war.id, value: stored.id });
        await OSMDB.log('INFO', 'BASELINE_SET', 'İlk kayıt başlangıç noktası yapıldı; skor üretilmedi.');
      }
    }
    await OSMWars.saveWars(WARS);
    if (lastWarId && (!WAR || WAR.id !== lastWarId)) {           // yeni veri hangi savaşa aitse ona geç
      WAR = WARS.find(w => w.id === lastWarId);
      await OSMWars.setCurrentId(WAR.id);
      await loadST();
      OSMSettings.toForm(ST);
    }
    await load();
    if (ST.autoCommit && diff && diff.valid && !diff.unchanged && !diff.warnings.length) await commit(true);
    return { ids, added, newWars, war: WAR };
  }

  async function commit(auto) {
    if (!WAR) throw new Error('Seçili savaş yok');
    if (!diff || !diff.valid || diff.unchanged) throw new Error('Onaylanabilir geçerli fark yok' + (diff && diff.reasons.length ? ': ' + diff.reasons.join('; ') : ''));
    let number = ST.matchday;
    if (MDS.some(match => match.matchday === number)) number = Math.max.apply(null, MDS.map(match => match.matchday)) + 1;
    if (!auto) {
      // Maç günü numarası ASLA tarihten/güncelleme zamanından türetilmez; kullanıcı onaylar.
      const note = diff.warnings.length ? '\n\nUYARI: ' + diff.warnings.join(' | ') + '\n(Birden fazla maç günü birleşmiş olabilir. Emin değilseniz iptal edin.)' : '';
      const answer = prompt('Bu fark OSM sıralamasına göre kaçıncı maç günü? Tracker\'ı geç açmak numarayı değiştirmez.' + note, String(number));
      if (answer === null) return false;
      number = parseInt(answer, 10);
      if (!Number.isInteger(number) || number < 1) throw new Error('Geçersiz maç günü numarası');
      if (MDS.some(match => match.matchday === number)) throw new Error('Maç günü ' + number + ' bu savaşta zaten kayıtlı (çift kayıt engellendi)');
    }
    const squad = OSMScore.agg(curN.squad, 'value');
    const goals = OSMScore.agg(curN.goals, 'goals');
    const baseGoals = OSMScore.agg(baseN.goals, 'goals');
    const hasGoals = curN.goals.length && baseN.goals.length;
    // Menajer bazlı gol/kart/kadro değişimi (iki kayıt arasındaki fark). Okunamazsa null (0 değil).
    const K = OSMScore.K;
    const gm = list => new Map((list || []).map(x => [K(x.manager), x]));
    const g0 = gm(baseN.goals), g1 = gm(curN.goals), s1 = gm(curN.squad);
    const dl = (a, b, f) => (a && b && a[f] != null && b[f] != null ? b[f] - a[f] : null);
    const rowsFull = diff.rows.map(r => {
      const a = g0.get(K(r.manager)), b = g1.get(K(r.manager)), q = s1.get(K(r.manager));
      return Object.assign({}, r, { gf: dl(a, b, 'scored'), ga: dl(a, b, 'conceded'), yc: dl(a, b, 'yellow'), rc: dl(a, b, 'red'), squad: q && q.value != null ? q.value : null });
    });
    const record = {
      warId: WAR.id, k: WAR.id + ':' + number, matchday: number, ts: Date.now(), baselineId: BASE.id, snapshotId: CUR.id,
      red: diff.red, blue: diff.blue, rows: rowsFull,
      squad: { RED: squad.RED.sum, BLUE: squad.BLUE.sum },
      goals: { RED: curN.goals.length ? goals.RED.sum : null, BLUE: curN.goals.length ? goals.BLUE.sum : null },
      goalDelta: hasGoals ? { RED: goals.RED.sum - baseGoals.RED.sum, BLUE: goals.BLUE.sum - baseGoals.BLUE.sum } : null
    };
    await OSMDB.put('md', record);
    await OSMDB.put('kv', { key: 'baseline:' + WAR.id, value: CUR.id });
    ST.matchday = number + 1;
    await saveST();
    await OSMDB.log('INFO', 'MATCHDAY_COMMIT', 'MD' + number + ': RED ' + record.red + ' - ' + record.blue + ' BLUE');
    await refresh();
    return true;
  }

  // ---------- Sheets ----------
  async function buildModel() {
    return { war: WAR, now: Date.now(), st: ST, curN, baseN, diff, mds: MDS, tour, logs: await OSMDB.all('logs'), snaps: SNAPS, startTs: SNAPS.length ? SNAPS[0].ts : null, names: OSMScore.teamNames(curN, ST) };
  }
  async function pushSheets(interactive) {
    if (!ST.spreadsheetId) throw new Error('Google Sheets ID ayarlı değil');
    if (!OSMSheets.hasToken()) {
      if (!interactive) throw new Error('Google bağlantısı gerekli (token yok / süresi dolmuş)');
      await OSMSheets.requestToken(ST.clientId);
    }
    if (!WAR || !curN) throw new Error('Önce veri toplanmalı (seçili savaş yok)');
    const result = await OSMSheets.pushWar(ST.spreadsheetId, { war: WAR, model: await buildModel(), cfg: { minMatches: Number(ST.minMatches) >= 0 ? Number(ST.minMatches) : 3, countLive: !!ST.countLive } });
    WAR.sheetId = result.sheetId; WAR.sheetTitle = result.title;
    await OSMWars.saveWars(WARS);
    await OSMDB.log('INFO', 'SHEETS_PUSH', '"' + result.title + '" sayfası ' + (result.created ? 'oluşturuldu' : 'güncellendi') + ' (' + result.matchdays + ' maç günü) · ' + result.wars + ' savaş GLOBAL STATS\'ta');
  }

  // ---------- Userscript köprüsü ----------
  function post(message) {
    message.src = 'osm-tracker';
    message.protocol = 2;
    window.postMessage(JSON.stringify(message), '*');
  }

  function askQueue(showFeedback) {
    // READY paketi sayfa yüklenmeden önce kaçmış olsa bile GET_QUEUE gönderilir.
    const requestId = 'tracker-' + Date.now() + '-' + (++requestSeq);
    const timer = setTimeout(() => {
      if (!pendingRequests.has(requestId)) return;
      pendingRequests.delete(requestId);
      toast('Userscript yanıt vermedi. Tracker sekmesini yenileyip tekrar deneyin.');
      OSMDB.log('WARN', 'BRIDGE_TIMEOUT', 'GET_QUEUE yanıtı alınamadı.');
    }, 6000);
    pendingRequests.set(requestId, timer);
    post({ type: 'GET_QUEUE', requestId });
    if (showFeedback) toast('Userscript kuyruğu isteniyor…');
  }

  async function onQueue(queue, requestId) {
    if (!appReady) {
      window.__osm5v5DeferredQueue = { queue, requestId };
      return;
    }
    if (!Array.isArray(queue)) {
      await fail('BRIDGE_QUEUE', new Error('Userscript geçersiz kuyruk verisi gönderdi'));
      return;
    }
    if (!queue.length) {
      toast('Userscript bağlantısı çalışıyor; kuyruk boş. OSM sayfasında “Şimdi topla” çalıştırın.');
      return;
    }
    if (busy) {
      toast('Veri zaten işleniyor; birkaç saniye sonra yeniden deneyin.');
      return;
    }
    busy = true;
    try {
      const result = await processQueue(queue);
      post({ type: 'ACK', ids: result.ids, requestId });
      await refresh();
      toast(result.added + ' yeni kayıt işlendi (' + result.ids.length + ' kuyruk kaydı)');
      if (ST.autoSync && ST.spreadsheetId && OSMSheets.hasToken()) {
        try { await pushSheets(false); toast('Google Sheets güncellendi'); }
        catch (error) { await fail('SHEETS_API', error); }
      }
    } catch (error) {
      await fail('QUEUE', error);
    } finally {
      busy = false;
    }
  }

  window.addEventListener('message', async event => {
    // Firefox + Violentmonkey sandbox'ında event.source kimlik kontrolü
    // izole dünya sarmalayıcıları yüzünden hatalı negatif verebilir.
    if (typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message || message.src !== 'osm-collector') return;

    bridgeSeen = true;
    const bridge = $('bridge');
    if (bridge) bridge.textContent = 'Userscript: bağlı';

    if (message.type === 'READY' || message.type === 'PONG') {
      if (appReady && message.type === 'READY') askQueue(false);
      return;
    }
    if (message.type === 'QUEUE') {
      const timer = pendingRequests.get(message.requestId);
      if (timer) { clearTimeout(timer); pendingRequests.delete(message.requestId); }
      await onQueue(message.queue || [], message.requestId || null);
      return;
    }
    if (message.type === 'ACKED') {
      const bridgeText = $('bridge');
      if (bridgeText) bridgeText.textContent = 'Userscript: bağlı · kuyruk ' + (message.queueSize == null ? '?' : message.queueSize);
    }
  });

  // ---------- Çizim ----------
  const star = aggregate => (aggregate && aggregate.n ? aggregate.sum + (aggregate.unknown ? '*' : '') : 'UNKNOWN');
  const table = (head, rows, teamColumn) => '<table><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    rows.map(row => '<tr>' + row.map((cell, index) => '<td' + (index === teamColumn ? ' class="' + esc(cell) + '"' : '') + '>' + esc(cell) + '</td>').join('') + '</tr>').join('') + '</table>';

  function render() {
    const last = MDS[MDS.length - 1];
    $('status').innerHTML = CUR
      ? 'Son kayıt: ' + esc(fmt(CUR.ts)) + ' · Başlangıç noktası: ' + esc(BASE ? fmt(BASE.ts) : 'YOK') + ' · Kayıtlı maç günü: ' + MDS.length +
        (curN && curN.warnings.length ? '<br><span class="warn">Uyarı: ' + esc(curN.warnings.slice(0, 3).join(' | ')) + '</span>' : '') +
        '<br>* = bazı değerler UNKNOWN, toplam eksik olabilir.'
      : 'Henüz kayıt yok. OSM lig sayfasında userscript’i çalıştırın, sonra “Userscript’ten veri al”a basın.';

    const league = curN && OSMScore.agg(curN.league, 'points');
    const squad = curN && OSMScore.agg(curN.squad, 'value');
    const goals = curN && OSMScore.agg(curN.goals, 'goals');
    const info = curN && curN.leagueInfo;
    if ($('warbar')) $('warbar').textContent = WAR ? 'Seçili savaş: ' + (WAR.league || 'UNKNOWN LEAGUE') + ' · ' + WAR.redName + ' vs ' + WAR.blueName + ' · ' + (ST_TR[WAR.status] || WAR.status) : 'Seçili savaş yok';
    $('leagueName').textContent = info && info.name
      ? 'Lig: ' + info.name + (info.type ? ' · ' + info.type : '') + (info.season ? ' · Sezon ' + info.season : '') + (info.moderator ? ' · Moderatör: ' + info.moderator : '')
      : 'Lig: UNKNOWN (yeni toplamada okunur)';
    const rp = league ? league.RED : null, bp = league ? league.BLUE : null;
    if (rp && bp) {
      const gap = rp.sum - bp.sum;
      $('score').innerHTML = '<span class="tagRED">RED ' + rp.sum + '</span> – <span class="tagBLUE">' + bp.sum + ' BLUE</span>' +
        (rp.unknown || bp.unknown ? '*' : '') +
        '<div class="small">' + (gap === 0 ? 'Berabere' : (gap > 0 ? 'RED' : 'BLUE') + ' ' + Math.abs(gap) + ' puan önde') + ' · toplam lig puanı</div>';
    } else $('score').textContent = '—';
    $('teams').innerHTML = ['RED', 'BLUE'].map(team => {
      const pending = diff && diff.valid ? diff[team.toLowerCase()] : null;
      const mdInfo = pending != null ? 'Bekleyen maç günü: +' + pending : (last ? 'Son maç günü: +' + last[team.toLowerCase()] : 'Maç günü: —');
      return '<div class="team ' + team + '"><div class="t">TEAM ' + team + '</div>' +
        '<div class="big">' + esc(star(league && league[team])) + '</div>' +
        '<div class="m">toplam puan</div>' +
        '<div class="m">' + esc(mdInfo) + '</div>' +
        '<div class="m">Kadro: ' + esc(squad && squad[team].n ? mil(squad[team].sum) + (squad[team].unknown ? '*' : '') : 'UNKNOWN') + '</div>' +
        '<div class="m">Gol: ' + esc(star(goals && goals[team])) + '</div>' +
        '<div class="m">Menajer: ' + (league ? league[team].n : 'UNKNOWN') + '</div></div>';
    }).join('');

    if (!BASE) $('preview').textContent = 'Başlangıç noktası yok; skor üretilmedi.';
    else if (!diff) $('preview').textContent = 'Başlangıç noktasından sonra yeni kayıt yok.';
    else {
      let html = diff.valid
        ? (diff.unchanged ? '<p>Puan değişmedi.</p>' : '<p class="ok"><b>RED ' + diff.red + ' - ' + diff.blue + ' BLUE</b> (geçerli)</p>')
        : '<p class="bad">Geçersiz: ' + esc(diff.reasons.join('; ')) + '</p>';
      if (diff.warnings.length) html += '<p class="warn">' + esc(diff.warnings.join(' | ')) + '</p>';
      html += table(['Menajer', 'Takım', 'Önceki', 'Şimdi', 'Fark'], diff.rows.map(row => [row.manager, row.team, row.prev, row.curr, row.diff]), 1);
      $('preview').innerHTML = html;
    }

    $('standings').innerHTML = curN && curN.league.length
      ? table(['#', 'Kulüp', 'Menajer', 'Takım', 'Puan'], curN.league.map(row => [row.rank, row.club, row.manager, row.team, val(row.points)]), 3)
      : 'Veri yok (UNKNOWN)';
    $('squad').innerHTML = curN && curN.squad.length
      ? table(['#', 'Menajer', 'Takım', 'Değer', 'Ham'], curN.squad.map(row => [row.rank, row.manager, row.team, mil(row.value), val(row.valueRaw)]), 2)
      : 'Kadro değeri okunamadı (UNKNOWN)';
    $('goals').innerHTML = curN && curN.goals.length
      ? table(['#', 'Kulüp', 'Menajer', 'Takım', 'Atılan', 'Yenilen'], curN.goals.map(row => [row.rank, row.club, row.manager, row.team, val(row.scored), val(row.conceded)]), 3) +
        (curN.topScorers.length ? '<p class="small">Gol kralları: ' + esc(curN.topScorers.map(row => row.player + ' (' + row.team + ') ' + row.goals).join(' · ')) + '</p>' : '')
      : 'Gol bilgisi okunamadı (UNKNOWN)';

    $('history').innerHTML = MDS.length
      ? table(['MD', 'Tarih', 'RED', 'BLUE', 'Kadro R', 'Kadro B'], MDS.slice().reverse().map(match => [match.matchday, fmt(match.ts), match.red, match.blue, mil(match.squad.RED), mil(match.squad.BLUE)]))
      : 'Kayıtlı maç günü yok.';
  }

  async function renderLogs() {
    const logs = (await OSMDB.all('logs')).slice(-100).reverse();
    $('logs').innerHTML = logs.length ? table(['Tarih', 'Seviye', 'Kod', 'Mesaj'], logs.map(log => [fmt(log.ts), log.level, log.code, log.msg])) : 'Log yok.';
    const raw = await kv('lastRaw');
    $('raw').textContent = raw ? Object.keys(raw).map(key => '=== ' + key + ' ===\n' + (raw[key] || '').slice(0, 1200)).join('\n\n') : '(yok)';
  }

  async function refresh() { await load(); render(); await renderLogs(); }

  // ---------- Dışa aktarma ----------
  function download(name, text, mime) {
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(new Blob([text], { type: mime }));
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
  }
  const csvCell = value => '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  function toCsv() {
    const rows = [['matchday', 'tarih', 'menajer', 'kulup', 'takim', 'onceki', 'yeni', 'fark']];
    MDS.forEach(match => match.rows.forEach(row => rows.push([match.matchday, fmt(match.ts), row.manager, row.club, row.team, row.prev, row.curr, row.diff])));
    return rows.map(row => row.map(csvCell).join(',')).join('\n');
  }


  // ---------- Savaş Yöneticisi (MY WARS) ----------
  const ST_TR = { LIVE: 'CANLI', COMPLETED: 'TAMAMLANDI', ARCHIVED: 'ARŞİV' };
  function renderWars() {
    const live = WARS.filter(w => !w.deleted), trash = WARS.filter(w => w.deleted);
    const mdN = id => ALLMD.filter(m => m.warId === id).length;
    $('wars').innerHTML = live.length ? live.map(w =>
      '<div class="war' + (WAR && WAR.id === w.id ? ' sel' : '') + '"><b>' + esc(w.league || 'UNKNOWN LEAGUE') + '</b><br>' +
      '<span class="tagRED">' + esc(w.redName) + '</span> vs <span class="tagBLUE">' + esc(w.blueName) + '</span>' +
      '<div class="small">' + esc(w.id) + ' · ' + esc(ST_TR[w.status] || w.status) + ' · ' + mdN(w.id) + ' maç günü · sayfa: ' + esc(w.sheetTitle || 'henüz yok') + (WAR && WAR.id === w.id ? ' · SEÇİLİ' : '') + '</div>' +
      '<div class="btns"><button data-act="open" data-id="' + esc(w.id) + '">AÇ</button><button data-act="update" data-id="' + esc(w.id) + '">GÜNCELLE</button>' +
      '<button data-act="archive" data-id="' + esc(w.id) + '">' + (w.status === 'ARCHIVED' ? 'AKTİF ET' : 'ARŞİVLE') + '</button><button data-act="delete" data-id="' + esc(w.id) + '">SİL</button></div></div>'
    ).join('') : 'Henüz savaş yok. OSM lig sayfasından veri toplayınca savaş otomatik oluşur.';
    $('trash').innerHTML = trash.length ? trash.map(w =>
      '<div class="war"><b>' + esc(w.league || 'UNKNOWN LEAGUE') + '</b> · ' + esc(w.redName) + ' vs ' + esc(w.blueName) + '<div class="small">silindi: ' + esc(fmt(w.deleted)) + '</div>' +
      '<div class="btns"><button data-act="restore" data-id="' + esc(w.id) + '">GERİ AL</button><button data-act="purge" data-id="' + esc(w.id) + '">KALICI SİL</button></div></div>'
    ).join('') : 'Çöp kutusu boş.';
  }
  function renderWarMeta() {
    if (!WAR || !curN) { $('warmeta').textContent = 'Seçili savaşta veri yok.'; return; }
    const K = OSMScore.K, sq = new Map(curN.squad.map(x => [K(x.manager), x]));
    const rows = curN.league.filter(r => r.team !== 'UNKNOWN').map(r => {
      const key = K(r.manager), m = WAR.managers[key] || {}, cur = sq.get(key);
      const g = '<select data-g="' + esc(key) + '"><option value="">—</option>' + OSMWars.GLEVELS.map(l => '<option' + (m.g === l ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>';
      const orig = m.start != null ? (Math.round(m.start / 1e5) / 10) + 'M' : '';
      const inp = '<input data-s="' + esc(key) + '" data-orig="' + esc(orig) + '" value="' + esc(orig) + '" placeholder="UNKNOWN" size="7">';
      return [r.manager, r.team, g, inp, cur && cur.value != null ? mil(cur.value) : 'UNKNOWN'];
    });
    $('warmeta').innerHTML = '<table><tr><th>Menajer</th><th>Takım</th><th>G</th><th>Başlangıç</th><th>Şimdi</th></tr>' +
      rows.map(x => '<tr><td>' + esc(x[0]) + '</td><td class="' + esc(x[1]) + '">' + esc(x[1]) + '</td><td>' + x[2] + '</td><td>' + x[3] + '</td><td>' + esc(x[4]) + '</td></tr>').join('') + '</table>' +
      '<div class="small">Başlangıç değerleri her savaş için ayrıdır ve güncellemelerde ASLA ezilmez. Girilmemiş = UNKNOWN. Örnek giriş: 115 veya 90,2M.</div>';
  }
  async function backupBeforeDelete(tag) {
    download('osm5v5-yedek-' + tag + '-' + Date.now() + '.json', JSON.stringify(await OSMDB.exportAll()), 'application/json');
  }
  async function warAction(action, id) {
    const w = WARS.find(x => x.id === id);
    if (!w) throw new Error('Savaş bulunamadı');
    if (action === 'open') { await selectWar(id); showTab('panel'); return; }
    if (action === 'update') {
      await selectWar(id);
      await pushSheets(true);
      toast('“' + (WAR.sheetTitle || WAR.league) + '” sayfası ve GLOBAL STATS güncellendi');
      renderWars();
      return;
    }
    if (action === 'archive') {
      w.status = w.status === 'ARCHIVED' ? 'LIVE' : 'ARCHIVED';
      await OSMWars.saveWars(WARS);
      if (WAR && WAR.id === w.id) { await loadST(); OSMSettings.toForm(ST); }
      toast(w.status === 'ARCHIVED' ? 'Arşivlendi: geçmiş istatistikler GLOBAL STATS\'ta kalır, aktif sayılmaz. Sheets’e “GÜNCELLE” ile yansıtın.' : 'Aktif edildi');
      renderWars();
      return;
    }
    if (action === 'delete') {
      if (!confirm('“' + (w.league || w.id) + '” savaşı Tracker’dan silinsin mi?\n(Çöp kutusuna taşınır; GERİ AL ile kurtarılabilir. Diğer savaşlar etkilenmez.)')) return;
      const withSheets = ST.spreadsheetId && confirm('Bu savaşın Google Sheets sayfası da silinsin mi?\nTamam = Tracker + Google Sheets\nİptal = yalnızca Tracker');
      await backupBeforeDelete('silme-oncesi');
      if (withSheets) {
        if (!OSMSheets.hasToken()) await OSMSheets.requestToken(ST.clientId);
        const r = await OSMSheets.deleteWarSheet(ST.spreadsheetId, w.id, { minMatches: Number(ST.minMatches) >= 0 ? Number(ST.minMatches) : 3, countLive: !!ST.countLive });
        await OSMDB.log('INFO', 'WAR_SHEET_DELETED', w.id + ' · kalan savaş: ' + r.wars);
        w.sheetId = null; w.sheetTitle = '';
      }
      w.deleted = Date.now();
      await OSMWars.saveWars(WARS);
      await OSMDB.log('INFO', 'WAR_DELETED', w.id + (withSheets ? ' (Tracker + Sheets)' : ' (yalnızca Tracker)'));
      if (WAR && WAR.id === w.id) { await loadWars(); await loadST(); OSMSettings.toForm(ST); await refresh(); }
      toast('Silindi' + (withSheets ? ' (Tracker + Google Sheets)' : ' (yalnızca Tracker)') + ' · yedek indirildi');
      renderWars();
      return;
    }
    if (action === 'restore') { w.deleted = null; await OSMWars.saveWars(WARS); toast('Geri alındı'); renderWars(); return; }
    if (action === 'purge') {
      if (!confirm('KALICI silme: bu savaşın tüm kayıtları Tracker’dan silinir (geri alınamaz). Devam?')) return;
      await backupBeforeDelete('kalici-silme-oncesi');
      await OSMWars.purgeWar(id);
      WARS = await OSMWars.listWars();
      toast('Kalıcı olarak silindi (yedek indirildi)');
      renderWars();
    }
  }

  // ---------- Olaylar ----------
  function showTab(name) {
    ['panel', 'wars', 'settings', 'history', 'logs'].forEach(tab => { $('tab-' + tab).hidden = tab !== name; });
    if (name === 'wars') { renderWars(); renderWarMeta(); }
    document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  }
  const act = (id, fn) => $(id).addEventListener('click', async () => {
    try { await fn(); } catch (error) { await fail(id.toUpperCase(), error); }
  });

  async function saveForm() {
    ST = OSMSettings.fromForm(ST);
    ST.spreadsheetId = OSMSettings.cleanSheetId(ST.spreadsheetId);
    await saveST();
    OSMSettings.toForm(ST);
    await refresh();
  }

  async function init() {
    await OSMDB.open();
    await OSMWars.migrate(await OSMSettings.load());      // eski tek savaşlı veriyi güvenle savaş kaydına taşır (yedek depo silinmez)
    await loadWars();
    await loadST();
    OSMSettings.toForm(ST);
    document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => showTab(button.dataset.tab)));

    $('wars').addEventListener('click', async event => {
      const button = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
      if (!button) return;
      try { await warAction(button.dataset.act, button.dataset.id); } catch (error) { await fail('WAR_' + String(button.dataset.act).toUpperCase(), error); }
    });
    $('trash').addEventListener('click', async event => {
      const button = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
      if (!button) return;
      try { await warAction(button.dataset.act, button.dataset.id); } catch (error) { await fail('WAR_' + String(button.dataset.act).toUpperCase(), error); }
    });
    act('b-savemeta', async () => {
      if (!WAR) throw new Error('Seçili savaş yok');
      document.querySelectorAll('#warmeta [data-g]').forEach(el => OSMWars.setG(WAR, el.dataset.g, el.value || null));
      let changed = 0;
      document.querySelectorAll('#warmeta [data-s]').forEach(el => {
        if (el.value.trim() !== (el.dataset.orig || '')) { OSMWars.setStart(WAR, el.dataset.s, el.value); changed++; }   // yalnızca elle değiştirilenler
      });
      await OSMWars.saveWars(WARS);
      renderWarMeta();
      toast('G-seviyeleri kaydedildi · ' + changed + ' başlangıç değeri güncellendi');
    });
    act('b-confirmstart', async () => {
      if (!WAR || !curN) throw new Error('Seçili savaşta veri yok');
      if (!confirm('Şimdiki kadro değerleri bu savaşın GERÇEK başlangıç değeri mi?\nYalnızca boş (UNKNOWN) olanlar doldurulur; girilmiş değerler ezilmez. Emin değilseniz iptal edin.')) return;
      const n = OSMWars.confirmStartFromCurrent(WAR, curN, false);
      await OSMWars.saveWars(WARS);
      renderWarMeta();
      toast(n + ' menajerin başlangıç değeri onaylandı');
    });
    act('b-fetch', async () => { askQueue(true); });
    act('b-commit', async () => { await commit(); toast('Maç günü kaydedildi'); });
    act('b-push', async () => { await pushSheets(true); toast('Google Sheets güncellendi'); });
    act('b-save', async () => { await saveForm(); toast('Kaydedildi'); });
    act('b-autofill', async () => {
      if (!curN) throw new Error('Önce veri toplanmalı');
      ST.redManagers = curN.league.filter(row => row.team === 'RED').map(row => row.manager);
      ST.blueManagers = curN.league.filter(row => row.team === 'BLUE').map(row => row.manager);
      await saveST();
      OSMSettings.toForm(ST);
      await refresh();
      toast('RED ' + ST.redManagers.length + ' / BLUE ' + ST.blueManagers.length + ' menajer. Listeyi kontrol edin.');
    });
    act('b-google', async () => { await saveForm(); await OSMSheets.requestToken(ST.clientId); toast('Google bağlandı (yaklaşık 1 saat geçerli)'); });
    act('b-create', async () => {
      await saveForm();
      if (!OSMSheets.hasToken()) await OSMSheets.requestToken(ST.clientId);
      ST.spreadsheetId = await OSMSheets.create('OSM 5v5 — ' + ((curN && curN.leagueInfo && curN.leagueInfo.name) || 'Tracker'), curN ? OSMScore.teamNames(curN, ST) : null);
      await OSMSettings.save(ST);
      OSMSettings.toForm(ST);
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
      await OSMDB.put('kv', { key: 'baseline:' + WAR.id, value: CUR.id });
      await OSMDB.log('INFO', 'BASELINE_RESET', CUR.id);
      await refresh();
    });
    act('b-backup', async () => { download('osm5v5-yedek-' + Date.now() + '.json', JSON.stringify(await OSMDB.exportAll()), 'application/json'); });
    act('b-restore', async () => { $('f-restore').click(); });
    $('f-restore').addEventListener('change', async event => {
      try {
        const file = event.target.files[0];
        if (!file) return;
        const data = JSON.parse(await file.text());
        const count = await OSMDB.importAll(data);
        if (!(data.kv || []).some(x => x.key === 'wars')) await OSMDB.del('kv', 'migratedV3');   // eski (tek savaşlı) yedek: yeniden taşı
        await OSMWars.migrate(await OSMSettings.load());
        await loadWars();
        await loadST();
        OSMSettings.toForm(ST);
        await refresh();
        toast(count + ' kayıt geri yüklendi');
      } catch (error) { await fail('RESTORE', error); }
      event.target.value = '';
    });
    act('b-xlsx', async () => {
      if (!curN) throw new Error('Önce veri toplanmalı');
      const blob = OSMSheets.toXlsx(await buildModel());
      download('OSM-5v5-' + new Date().toISOString().slice(0, 10) + '.xlsx', blob, blob.type);
      toast('İndirildi. Google Drive’a yükleyip Sheets ile açın.');
    });
    act('b-csv', async () => { download('osm5v5-maclar.csv', toCsv(), 'text/csv'); });

    await refresh();
    appReady = true;
    const deferred = window.__osm5v5DeferredQueue;
    if (deferred) {
      delete window.__osm5v5DeferredQueue;
      await onQueue(deferred.queue, deferred.requestId);
    } else {
      askQueue(false);
    }
    setTimeout(() => {
      if (!bridgeSeen) {
        const bridge = $('bridge');
        if (bridge) bridge.textContent = 'Userscript: yanıt yok (Violentmonkey betiğini Tracker sekmesinde etkinleştirin)';
      }
    }, 5000);
  }

  window.addEventListener('error', event => {
    if (typeof OSMDB !== 'undefined' && OSMDB && typeof OSMDB.log === 'function') OSMDB.log('ERROR', 'JS_ERROR', event.message || 'Bilinmeyen JavaScript hatası');
  });
  init().catch(error => {
    document.body.insertAdjacentHTML('afterbegin', '<p class="bad">Başlatma hatası: ' + esc(error.message) + '</p>');
  });
})();
