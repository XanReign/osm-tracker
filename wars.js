/* wars.js — çoklu savaş kaydı, kimlik eşleştirme, savaş bazlı istatistik ve GLOBAL STATS hesabı */
(function (g) {
  'use strict';
  const K = s => OSMScore.K(s);
  const GLEVELS = ['G1', 'G3', 'G5', 'G7', 'G9'];
  const CFG_KEYS = ['redManagers', 'blueManagers', 'redName', 'blueName', 'matchday'];

  // ---------- Kayıt defteri (IndexedDB 'kv') ----------
  async function listWars() { const r = await OSMDB.get('kv', 'wars'); return r ? r.value : []; }
  const saveWars = l => OSMDB.put('kv', { key: 'wars', value: l });
  async function getCurrentId() { const r = await OSMDB.get('kv', 'currentWar'); return r ? r.value : null; }
  const setCurrentId = id => OSMDB.put('kv', { key: 'currentWar', value: id });
  const newId = () => 'W-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Ayarlar: savaşa özgü anahtarlar savaş kaydında, kalanı genel ayarlarda tutulur.
  function splitSettings(st) {
    const gl = {}, cfg = {};
    Object.keys(st).forEach(k => { (CFG_KEYS.indexOf(k) !== -1 ? cfg : gl)[k] = st[k]; });
    delete gl.battleCompleted;
    return { global: gl, cfg };
  }

  // ---------- Kimlik: OSM liga kimliği (varsa URL'den) + lig adı + menajer kümesi ----------
  function urlKey(url) {
    try { const m = new URL(url).pathname.match(/\d{4,}/g); return m ? m.sort((a, b) => b.length - a.length)[0] : ''; } catch (_) { return ''; }
  }
  function fingerprint(n, snap) {
    return {
      league: n.leagueInfo && n.leagueInfo.name ? K(n.leagueInfo.name) : '',
      url: urlKey(snap && snap.url),
      mgrs: n.league.filter(r => r.manager && r.manager !== 'UNKNOWN').map(r => K(r.manager))
    };
  }
  function sameWar(war, fp) {
    const a = new Set(war.fp.mgrs);
    const ratio = fp.mgrs.filter(m => a.has(m)).length / Math.max(1, a.size, fp.mgrs.length);
    if (fp.url && war.fp.url && fp.url === war.fp.url) return ratio >= 0.5;
    if (fp.league && war.fp.league) return fp.league === war.fp.league && ratio >= 0.6;
    return ratio >= 0.8;
  }
  const findWar = (list, fp) => list.find(w => !w.deleted && sameWar(w, fp)) || null;

  function createWar(fp, n, snap, st) {
    const names = OSMScore.teamNames(n, st || {});
    return {
      id: newId(), league: n.leagueInfo && n.leagueInfo.name ? n.leagueInfo.name : '', redName: names.RED, blueName: names.BLUE,
      status: 'LIVE', deleted: null, createdAt: Date.now(), startTs: snap ? snap.ts : Date.now(), osmUrl: snap && snap.url || '',
      fp, sheetId: null, sheetTitle: '',
      cfg: { redManagers: [], blueManagers: [], redName: '', blueName: '', matchday: 1 },
      managers: {}
    };
  }
  // Menajer meta kayıtları: G-seviyesi ve BAŞLANGIÇ değeri yalnızca elle/onayla değişir.
  function ensureManagers(war, n) {
    n.league.filter(r => r.team !== 'UNKNOWN').forEach(r => {
      const k = K(r.manager);
      if (!war.managers[k]) war.managers[k] = { name: r.manager, g: null, start: null, startConfirmed: false };
      else war.managers[k].name = r.manager;
    });
  }
  function refreshWar(war, n, snap) {
    const names = OSMScore.teamNames(n, war.cfg);
    war.redName = names.RED; war.blueName = names.BLUE;
    if (n.leagueInfo && n.leagueInfo.name) war.league = n.leagueInfo.name;
    if (snap && snap.url) war.osmUrl = snap.url;
    const a = new Set(war.fp.mgrs); n.league.forEach(r => { const k = K(r.manager); if (r.manager !== 'UNKNOWN' && !a.has(k) && war.fp.mgrs.length < 14) war.fp.mgrs.push(k); });
    ensureManagers(war, n);
  }
  function setG(war, key, gl) {
    if (gl && GLEVELS.indexOf(gl) === -1) throw new Error('Geçersiz G-seviyesi: ' + gl);
    if (!war.managers[key]) throw new Error('Menajer bulunamadı');
    war.managers[key].g = gl || null;
  }
  // "115", "115M", "90,2M" -> mutlak değer; boş/okunamayan -> null (UNKNOWN)
  function parseStart(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const v = OSMScore.parseNum(t);
    if (v == null || v <= 0) return null;
    return v < 1e5 ? v * 1e6 : v;
  }
  function setStart(war, key, text) {
    if (!war.managers[key]) throw new Error('Menajer bulunamadı');
    const v = parseStart(text);
    war.managers[key].start = v; war.managers[key].startConfirmed = v != null;
    return v;
  }
  // Kullanıcı "bu değerler gerçek başlangıç" diye ONAYLADIĞINDA çağrılır; mevcut başlangıçları ezmez (force hariç).
  function confirmStartFromCurrent(war, n, force) {
    let c = 0;
    n.squad.forEach(r => {
      const m = war.managers[K(r.manager)];
      if (m && r.value != null && (force || m.start == null)) { m.start = r.value; m.startConfirmed = true; c++; }
    });
    return c;
  }

  // ---------- Savaşın menajer ve savaş satırları (Sheets'e gizli veri olarak yazılır) ----------
  function managerRows(war, n, mds) {
    const goals = new Map(n.goals.map(x => [K(x.manager), x])), squad = new Map(n.squad.map(x => [K(x.manager), x]));
    return n.league.filter(r => r.team !== 'UNKNOWN').map(r => {
      const key = K(r.manager), meta = war.managers[key] || {}, gl = goals.get(key) || null, sq = squad.get(key) || null;
      const cur = sq && sq.value != null ? sq.value : null, start = meta.start != null ? meta.start : null;
      const growth = start != null && start > 0 && cur != null ? (cur - start) / start * 100 : null;
      let m = 0, w = 0, d = 0, l = 0, pts = 0, gm = 0, tgf = 0, tga = 0;
      mds.forEach(x => {
        const y = x.rows.find(z => K(z.manager) === key);
        if (!y || [0, 1, 3].indexOf(y.diff) === -1) return;   // çoklu maç / belirsiz fark: maç sayılmaz
        m++; pts += y.diff; if (y.diff === 3) w++; else if (y.diff === 1) d++; else l++;
        if (y.gf != null && y.ga != null) { gm++; tgf += y.gf; tga += y.ga; }
      });
      return {
        warId: war.id, league: war.league, status: war.status, key, name: r.manager, club: r.club, team: r.team, g: meta.g || null,
        start, current: cur, growth, gf: gl ? gl.scored : null, ga: gl ? gl.conceded : null, yc: gl ? gl.yellow : null, rc: gl ? gl.red : null,
        pts: r.points, warPts: pts, matches: m, wins: w, draws: d, losses: l, gm, tgf, tga
      };
    });
  }
  function warRow(war, n, mds, rows, sheetTitle) {
    const sum = (t, f) => { const rs = rows.filter(r => r.team === t); return rs.length && rs.every(r => r[f] != null) ? rs.reduce((a, r) => a + r[f], 0) : null; };
    const tour = OSMScore.tournament(mds);
    return {
      warId: war.id, league: war.league, red: war.redName, blue: war.blueName, status: war.status, sheet: sheetTitle || war.sheetTitle || '', sheetId: war.sheetId,
      startTs: war.startTs, updated: Date.now(), matchdays: mds.length,
      redPts: sum('RED', 'pts'), bluePts: sum('BLUE', 'pts'), redWar: tour.redPts, blueWar: tour.bluePts,
      redGoals: sum('RED', 'gf'), blueGoals: sum('BLUE', 'gf'), redConc: sum('RED', 'ga'), blueConc: sum('BLUE', 'ga'),
      yc: rows.every(r => r.yc != null) ? rows.reduce((a, r) => a + r.yc, 0) : null, rc: rows.every(r => r.rc != null) ? rows.reduce((a, r) => a + r.rc, 0) : null,
      redWins: tour.redWins, blueWins: tour.blueWins, draws: tour.draws, managers: rows.length
    };
  }

  // ---------- GLOBAL STATS hesabı (saf fonksiyon) ----------
  function rankList(items, metric, dir) {
    const sorted = items.slice().sort((a, b) => (dir === 'asc' ? metric(a) - metric(b) : metric(b) - metric(a)) || (b.sec || 0) - (a.sec || 0));
    return sorted.map(x => {
      const better = sorted.filter(y => (dir === 'asc' ? metric(y) < metric(x) : metric(y) > metric(x))).length;
      const ties = sorted.filter(y => metric(y) === metric(x)).length > 1;
      return Object.assign({}, x, { rank: better + 1, tie: ties });
    });
  }
  function aggregate(rows) {
    const m = new Map();
    rows.forEach(r => {
      let a = m.get(r.key);
      if (!a) { a = { key: r.key, name: r.name, levels: new Set(), wars: new Set(), gf: 0, gfN: 0, ga: 0, gaN: 0, tgf: 0, tga: 0, gm: 0, matches: 0, wins: 0, warPts: 0, gr: [], inc: 0 }; m.set(r.key, a); }
      a.name = r.name; if (r.g) a.levels.add(r.g); a.wars.add(r.warId);
      if (r.gf != null) { a.gf += r.gf; a.gfN++; } if (r.ga != null) { a.ga += r.ga; a.gaN++; }
      a.tgf += r.tgf || 0; a.tga += r.tga || 0; a.gm += r.gm || 0; a.matches += r.matches || 0; a.wins += r.wins || 0; a.warPts += r.warPts || 0;
      if (r.growth != null) { a.gr.push(r.growth); a.inc += r.current - r.start; }
    });
    return Array.from(m.values()).map(a => Object.assign(a, {
      levelsText: a.levels.size ? Array.from(a.levels).sort().join('/') : 'N/A', warCount: a.wars.size,
      total: a.gfN ? a.gf : null, gpm: a.gm ? a.tgf / a.gm : null, conc: a.gaN ? a.ga : null, cpm: a.gm ? a.tga / a.gm : null,
      avgGr: a.gr.length ? a.gr.reduce((x, y) => x + y, 0) / a.gr.length : null, incr: a.gr.length ? a.inc : null,
      ppm: a.matches ? a.warPts / a.matches : null, winPct: a.matches ? a.wins / a.matches * 100 : null
    }));
  }
  function winners(rs, field, dir, minKnown) {
    const known = rs.filter(r => r[field] != null);
    if (known.length < (minKnown || 2)) return [];
    const best = dir === 'max' ? Math.max.apply(null, known.map(r => r[field])) : Math.min.apply(null, known.map(r => r[field]));
    return known.filter(r => Math.abs(r[field] - best) < 1e-9);
  }
  function computeGlobal(wars, rows, cfg) {
    cfg = Object.assign({ minMatches: 3, countLive: false, top: 10 }, cfg || {});
    const sumK = f => { const k = rows.filter(r => r[f] != null); return k.length ? k.reduce((a, r) => a + r[f], 0) : null; };
    const kpi = {
      wars: wars.length, active: wars.filter(w => w.status === 'LIVE').length, completed: wars.filter(w => w.status === 'COMPLETED').length,
      archived: wars.filter(w => w.status === 'ARCHIVED').length, managers: new Set(rows.map(r => r.key)).size,
      matches: Math.round(rows.reduce((a, r) => a + (r.matches || 0), 0) / 2), goals: sumK('gf'), yc: sumK('yc'), rc: sumK('rc')
    };
    // Ödüller: her savaşta birinci olan (beraberlikte hepsi); bir savaş en fazla 1 kez sayılır.
    const byWar = new Map(); rows.forEach(r => { if (!byWar.has(r.warId)) byWar.set(r.warId, []); byWar.get(r.warId).push(r); });
    const awards = { scorer: new Map(), defence: new Map(), squad: new Map() };
    const give = (map, rs, warId) => rs.forEach(r => { if (!map.has(r.key)) map.set(r.key, new Set()); map.get(r.key).add(warId); });
    wars.forEach(w => {
      if (w.status === 'LIVE' && !cfg.countLive) return;
      const rs = byWar.get(w.warId) || [];
      give(awards.scorer, winners(rs, 'gf', 'max'), w.warId); give(awards.defence, winners(rs, 'ga', 'min'), w.warId); give(awards.squad, winners(rs, 'growth', 'max'), w.warId);
    });
    const aw = (map, key) => (map.has(key) ? map.get(key).size : 0);
    const all = aggregate(rows).map(a => Object.assign(a, { awS: aw(awards.scorer, a.key), awD: aw(awards.defence, a.key), awB: aw(awards.squad, a.key), elig: a.matches >= cfg.minMatches, eligG: a.gm >= cfg.minMatches }));
    const top = l => l.slice(0, cfg.top);
    const scorer = rankList(all.filter(a => a.total != null), a => a.total, 'desc');
    const defRank = rankList(all.filter(a => a.cpm != null && a.eligG), a => a.cpm, 'asc');
    const defOther = all.filter(a => a.conc != null && !(a.cpm != null && a.eligG)).sort((x, y) => x.conc - y.conc).map(x => Object.assign({}, x, { rank: null, tie: false }));
    const sqRank = rankList(all.filter(a => a.avgGr != null && a.elig), a => a.avgGr, 'desc');
    const sqOther = all.filter(a => a.avgGr != null && !a.elig).sort((x, y) => y.avgGr - x.avgGr).map(x => Object.assign({}, x, { rank: null, tie: false }));
    const points = rankList(all.filter(a => a.matches > 0), a => a.warPts, 'desc');
    const wins = rankList(all.filter(a => a.matches > 0), a => a.wins * 1000 + a.winPct, 'desc');
    // G-seviyesi: yalnızca savaşa özgü seviyeye göre karşılaştırma
    const gl = {};
    GLEVELS.forEach(L => {
      const ag = aggregate(rows.filter(r => r.g === L)).map(a => Object.assign(a, { elig: a.matches >= cfg.minMatches, eligG: a.gm >= cfg.minMatches }));
      const best = (list, f, dir) => {
        if (!list.length) return { names: 'N/A', value: null };
        const v = dir === 'max' ? Math.max.apply(null, list.map(f)) : Math.min.apply(null, list.map(f));
        return { names: list.filter(x => Math.abs(f(x) - v) < 1e-9).map(x => x.name).join(' / '), value: v };
      };
      gl[L] = {
        count: ag.length,
        scorer: best(ag.filter(a => a.total != null), a => a.total, 'max'),
        defence: best(ag.filter(a => a.cpm != null && a.eligG), a => a.cpm, 'min'),
        squad: best(ag.filter(a => a.avgGr != null && a.elig), a => a.avgGr, 'max'),
        points: best(ag.filter(a => a.matches > 0), a => a.warPts, 'max'),
        wins: best(ag.filter(a => a.matches > 0), a => a.wins, 'max')
      };
    });
    return { cfg, kpi, wars, boards: { scorer: top(scorer), defence: top(defRank.concat(defOther)), squad: top(sqRank.concat(sqOther)), points: top(points), wins: top(wins) }, gl };
  }

  // ---------- Eski (tek savaşlı) verinin güvenli taşınması ----------
  async function migrate(st) {
    if (await OSMDB.get('kv', 'migratedV3')) return { migrated: false };
    const snaps = (await OSMDB.all('snapshots')).sort((a, b) => a.ts - b.ts);
    const oldMd = await OSMDB.all('matchdays');
    const list = await listWars();
    const byWar = new Map();
    for (const s of snaps) {
      if (s.warId) continue;
      const n = OSMScore.normalize(s, st);
      if (!n.tabOk.league) continue;
      const fp = fingerprint(n, s);
      let w = findWar(list, fp);
      if (!w) { w = createWar(fp, n, s, st); list.push(w); }
      refreshWar(w, n, s);
      s.warId = w.id; await OSMDB.put('snapshots', s);
      byWar.set(w.id, s);
    }
    const bl = await OSMDB.get('kv', 'baseline'), lt = await OSMDB.get('kv', 'latest');
    const blSnap = bl && snaps.find(s => s.id === bl.value);
    const mdWar = (blSnap && blSnap.warId) || (snaps.length ? snaps[snaps.length - 1].warId : null);
    for (const w of list) {
      const mine = snaps.filter(s => s.warId === w.id);
      if (!mine.length) continue;
      if (w.id === mdWar) {
        for (const m of oldMd) await OSMDB.put('md', Object.assign({}, m, { warId: w.id, k: w.id + ':' + m.matchday }));
        if (bl) await OSMDB.put('kv', { key: 'baseline:' + w.id, value: bl.value });
        w.cfg = { redManagers: st.redManagers || [], blueManagers: st.blueManagers || [], redName: st.redName || '', blueName: st.blueName || '', matchday: st.matchday || 1 };
        if (st.battleCompleted) w.status = 'COMPLETED';
      } else {
        await OSMDB.put('kv', { key: 'baseline:' + w.id, value: mine[0].id });   // kural: ilk kayıt başlangıç noktası
      }
      await OSMDB.put('kv', { key: 'latest:' + w.id, value: mine[mine.length - 1].id });
      w.startTs = mine[0].ts;
    }
    await saveWars(list);
    if (list.length) await setCurrentId(snaps.length ? snaps[snaps.length - 1].warId : list[0].id);
    await OSMDB.put('kv', { key: 'migratedV3', value: true });
    return { migrated: true, wars: list.length };
  }

  // Soft-delete / geri alma / kalıcı silme (kalıcı silme öncesi yedek önerilir)
  async function purgeWar(id) {
    for (const s of await OSMDB.all('snapshots')) if (s.warId === id) await OSMDB.del('snapshots', s.id);
    for (const m of await OSMDB.all('md')) if (m.warId === id) await OSMDB.del('md', m.k);
    await OSMDB.del('kv', 'baseline:' + id); await OSMDB.del('kv', 'latest:' + id);
    await saveWars((await listWars()).filter(w => w.id !== id));
  }

  g.OSMWars = { GLEVELS, CFG_KEYS, listWars, saveWars, getCurrentId, setCurrentId, splitSettings, fingerprint, sameWar, findWar, createWar, refreshWar, ensureManagers,
    setG, parseStart, setStart, confirmStartFromCurrent, managerRows, warRow, computeGlobal, migrate, purgeWar };
})(typeof window !== 'undefined' ? window : globalThis);
