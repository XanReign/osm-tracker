/* tracker.js — köprü, kayıt işleme, arayüz, dışa aktarma (bridge fix) */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ts => (ts ? new Date(ts).toLocaleString('tr-TR') : '—');
  const val = v => (v == null ? 'UNKNOWN' : v);
  const mil = v => (v == null ? 'UNKNOWN' : Math.round(v / 1e5) / 10 + 'M');

  let ST, WARS = [], WAR = null, ALLM = [], SNAPS = [], MATCHES = [], CUR = null, curN = null;
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
    SNAPS = (await OSMDB.all('snapshots')).filter(x => x.warId === wid).sort((a, b) => a.ts - b.ts);
    ALLM = await OSMDB.all('matches');
    MATCHES = ALLM.filter(x => x.warId === wid && x.status !== 'DISMISSED').sort((a, b) => b.ts - a.ts);
    const byId = id => SNAPS.find(x => x.id === id) || null;
    CUR = byId(await kv('latest:' + wid)) || SNAPS[SNAPS.length - 1] || null;
    curN = CUR ? OSMScore.normalize(CUR, ST) : null;
  }

  async function processQueue(queue) {
    const ids = [];
    let added = 0, newWars = 0, lastWarId = null;
    const mc = { added: 0, updated: 0, duplicate: 0, review: 0 };
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
      added++;
      for (const key of Object.keys(stored.tabs || {})) {
        if (!stored.tabs[key].ok) await OSMDB.log('WARN', 'TAB_' + key.toUpperCase(), stored.tabs[key].error || 'okunamadı');
      }
      if (war) {
        lastWarId = war.id;
        // Bireysel maç algılama: aynı savaşın bir önceki görüntüsüyle karşılaştır (gruplama yok)
        const prevId = await kv('latest:' + war.id);
        const prevSnap = prevId ? await OSMDB.get('snapshots', prevId) : null;
        if (prevSnap && prevSnap.ts > stored.ts) {
          await OSMDB.log('WARN', 'OUT_OF_ORDER', 'Daha eski bir kayıt geldi; maç algılanmadı, son durum değişmedi: ' + stored.id);
        } else {
          await OSMDB.put('kv', { key: 'latest:' + war.id, value: stored.id });
          if (!prevSnap) await OSMDB.log('INFO', 'WAR_FIRST_SNAPSHOT', 'İlk kayıt: başlangıç durumu olarak saklandı, maç üretilmedi (' + (war.league || war.id) + ')');
          else if (prevSnap.tabs.league && prevSnap.tabs.league.ok && stored.tabs.league && stored.tabs.league.ok) {
            const pn = OSMScore.normalize(prevSnap, war.cfg), cn = OSMScore.normalize(stored, war.cfg);
            const found = OSMMatches.detect(pn, cn, { warId: war.id, ts: stored.ts, snapshotId: stored.id, prevSnapshotId: prevSnap.id });
            for (const m of found.matches.concat(found.review)) {
              const outcome = await OSMMatches.upsert(m);
              if (m.status === 'REVIEW' && outcome === 'added') mc.review++;
              if (outcome === 'added' && m.status === 'OK') mc.added++; else if (outcome === 'updated') mc.updated++; else if (outcome === 'duplicate') mc.duplicate++;
            }
            if (found.matches.length || found.review.length) await OSMDB.log('INFO', 'MATCHES_RECORDED', (war.league || war.id) + ': ' + found.matches.length + ' maç, ' + found.review.length + ' inceleme');
            if (found.ambiguous) await OSMDB.log('WARN', 'NO_GOAL_DATA', found.ambiguous + ' menajerde puan sabit ve gol verisi yok: oynanıp oynanmadığı doğrulanamadı');
          }
        }
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
    return { ids, added, newWars, war: WAR, matches: mc };
  }

  // ---------- Sheets ----------
  async function buildModel() {
    return { war: WAR, now: Date.now(), st: ST, curN, matches: ALLM.filter(x => x.warId === WAR.id), logs: await OSMDB.all('logs'), snaps: SNAPS, startTs: SNAPS.length ? SNAPS[0].ts : null, names: OSMScore.teamNames(curN, WAR.cfg) };
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
    await OSMDB.log('INFO', 'SHEETS_PUSH', '"' + result.title + '" sayfası ' + (result.created ? 'oluşturuldu' : 'güncellendi') + ' (' + result.matches + ' maç) · ' + result.wars + ' savaş GLOBAL STATS\'ta');
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
      toast(result.added + ' kayıt · ' + result.matches.added + ' yeni maç' + (result.matches.updated ? ' · ' + result.matches.updated + ' güncelleme' : '') + (result.matches.review ? ' · ' + result.matches.review + ' inceleme' : ''));
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
    const okM = MATCHES.filter(x => x.status === 'OK'), nRev = MATCHES.filter(x => x.status === 'REVIEW').length;
    const wins = t => okM.filter(x => x.team === t && x.result === 'W').length;
    $('status').innerHTML = CUR
      ? 'Son kayıt: ' + esc(fmt(CUR.ts)) + ' · Kayıtlı maç: ' + okM.length + (nRev ? ' · <span class="warn">İncelenecek: ' + nRev + '</span>' : '') +
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
      return '<div class="team ' + team + '"><div class="t">TEAM ' + team + '</div>' +
        '<div class="big">' + esc(star(league && league[team])) + '</div>' +
        '<div class="m">toplam puan</div>' +
        '<div class="m">Maç galibiyeti: ' + wins(team) + '</div>' +
        '<div class="m">Kadro: ' + esc(squad && squad[team].n ? mil(squad[team].sum) + (squad[team].unknown ? '*' : '') : 'UNKNOWN') + '</div>' +
        '<div class="m">Gol: ' + esc(star(goals && goals[team])) + '</div>' +
        '<div class="m">Menajer: ' + (league ? league[team].n : 'UNKNOWN') + '</div></div>';
    }).join('');

    $('recent').innerHTML = okM.length
      ? table(['Tarih', 'Menajer', 'Takım', 'Sonuç', 'Puan', 'Gol'], okM.slice(0, 10).map(x => [fmt(x.ts), x.manager, x.team, x.result, x.points, (x.gf == null ? '—' : x.gf) + '-' + (x.ga == null ? '—' : x.ga)]), 2)
      : 'Henüz maç kaydı yok. Bir menajerin puanı/golü iki kayıt arasında değişince maç kendiliğinden kaydedilir.';

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

    $('history').innerHTML = MATCHES.length
      ? table(['Tarih', 'Menajer', 'Kulüp', 'Takım', 'Sonuç', 'Puan', 'GF', 'GA', 'SK', 'KK', 'Durum'], MATCHES.map(x => [fmt(x.ts), x.manager, x.club, x.team, x.result || '?', x.points == null ? '—' : x.points, val(x.gf), val(x.ga), val(x.yc), val(x.rc), x.status]), 3)
      : 'Kayıtlı maç yok.';
    renderReview();
  }
  function renderReview() {
    const rv = MATCHES.filter(x => x.status === 'REVIEW');
    $('review').innerHTML = rv.length ? rv.map(x =>
      '<div class="war"><b>' + esc(x.manager) + '</b> · ' + esc(x.team) + ' · ' + esc(fmt(x.ts)) + '<div class="small">' + esc(x.reason || '') + ' · ' + esc(String(x.points == null ? '—' : x.points)) + ' puan · ' + esc(x.source) + '</div>' +
      '<div class="btns"><button data-act="dismiss" data-id="' + esc(x.id) + '">YOKSAY</button></div></div>'
    ).join('') : 'İnceleme bekleyen kayıt yok.';
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
    const rows = [['tarih', 'menajer', 'kulup', 'takim', 'sonuc', 'puan', 'atilan', 'yenilen', 'sari', 'kirmizi', 'durum', 'not', 'kaynak', 'id']];
    MATCHES.forEach(x => rows.push([fmt(x.ts), x.manager, x.club, x.team, x.result || '', x.points, x.gf, x.ga, x.yc, x.rc, x.status, x.reason || '', x.source, x.id]));
    return rows.map(row => row.map(csvCell).join(',')).join('\n');
  }

  // ---------- Savaş Yöneticisi (MY WARS) ----------
  const ST_TR = { LIVE: 'CANLI', COMPLETED: 'TAMAMLANDI', ARCHIVED: 'ARŞİV' };
  function renderWars() {
    const live = WARS.filter(w => !w.deleted), trash = WARS.filter(w => w.deleted);
    const mdN = id => ALLM.filter(m => m.warId === id && m.status === 'OK').length;
    $('wars').innerHTML = live.length ? live.map(w =>
      '<div class="war' + (WAR && WAR.id === w.id ? ' sel' : '') + '"><b>' + esc(w.league || 'UNKNOWN LEAGUE') + '</b><br>' +
      '<span class="tagRED">' + esc(w.redName) + '</span> vs <span class="tagBLUE">' + esc(w.blueName) + '</span>' +
      '<div class="small">' + esc(w.id) + ' · ' + esc(ST_TR[w.status] || w.status) + ' · ' + mdN(w.id) + ' maç · sayfa: ' + esc(w.sheetTitle || 'henüz yok') + (WAR && WAR.id === w.id ? ' · SEÇİLİ' : '') + '</div>' +
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
    $('review').addEventListener('click', async event => {
      const button = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
      if (!button) return;
      try { await OSMMatches.dismiss(button.dataset.id); await refresh(); toast('İnceleme kaydı yok sayıldı (istatistiğe girmez)'); } catch (error) { await fail('REVIEW_DISMISS', error); }
    });
    act('b-fetch', async () => { askQueue(true); });
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
