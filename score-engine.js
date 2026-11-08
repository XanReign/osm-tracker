/* score-engine.js — saf hesaplama (DOM / IndexedDB yok) */
(function (g) {
  'use strict';
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const K = s => clean(s).toLocaleLowerCase('tr-TR');

  // "850M", "€ 1.250.000", "22" -> sayı. Okunamazsa null (sıfır DEĞİL).
  function parseNum(str) {
    const s = clean(str).replace(/[€$£\s]/g, '');
    const m = s.match(/^(-?[\d.,]+)([KkMmBb]?)$/);
    if (!m) return null;
    const n = m[1], suf = m[2].toUpperCase();
    if (suf) {
      const v = parseFloat(n.replace(',', '.'));
      return isNaN(v) ? null : v * ({ K: 1e3, M: 1e6, B: 1e9 })[suf];
    }
    if (/^-?\d{1,3}([.,]\d{3})+$/.test(n)) return parseInt(n.replace(/[.,]/g, ''), 10);
    const v = parseFloat(n.replace(',', '.'));
    return isNaN(v) ? null : v;
  }

  function teamOf(manager, club, st) {
    const m = K(manager);
    if ((st.redManagers || []).some(x => K(x) === m)) return 'RED';
    if ((st.blueManagers || []).some(x => K(x) === m)) return 'BLUE';
    const c = /\bteam\s*(red|blue)\b/i.exec(club || '');
    if (c) return c[1].toUpperCase();
    return 'UNKNOWN';
  }

  // Satır metinlerinden kulüp/menajeri lig tablosuna göre tanı.
  function identify(texts, league) {
    const byClub = new Map(league.map(r => [K(r.club), r]));
    const byMgr = new Map(league.map(r => [K(r.manager), r]));
    let club = null, manager = null;
    const rest = [];
    texts.forEach(t => {
      const k = K(t);
      if (!club && byClub.has(k)) club = byClub.get(k).club;
      else if (!manager && byMgr.has(k)) manager = byMgr.get(k).manager;
      else rest.push(t);
    });
    if (club && !manager) manager = byClub.get(K(club)).manager;
    if (manager && !club) club = byMgr.get(K(manager)).club;
    return { club: club || 'UNKNOWN', manager: manager || 'UNKNOWN', rest };
  }

  const fold = s => clean(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Sayısal sütunu başlık adına göre seç. Başlık yoksa varsayılan sıra (idx) kullanılır.
  function pick(r, header, re, idx, out, what) {
    const n = r.numsRaw.length;
    if (header && header.length >= n && n > 0) {
      const nh = header.slice(header.length - n);
      for (let i = 0; i < n; i++) if (re.test(fold(nh[i]))) return r.numsRaw[i];
      return null;
    }
    if (out && out.warnings.indexOf(what + ': başlık okunamadı, sütun sırası varsayıldı') === -1) out.warnings.push(what + ': başlık okunamadı, sütun sırası varsayıldı');
    return r.numsRaw[idx] !== undefined ? r.numsRaw[idx] : null;
  }
  const num = x => (x == null ? null : parseNum(x));

  function normalize(snap, st) {
    const out = { id: snap.id, ts: snap.ts, league: [], managers: [], squad: [], goals: [], topScorers: [], warnings: [], tabOk: {} };
    const T = snap.tabs || {};
    ['league', 'managers', 'squad', 'goals'].forEach(k => { out.tabOk[k] = !!(T[k] && T[k].ok); });
    const H = k => (T[k] && T[k].header) || null;

    if (out.tabOk.league) {
      out.league = T.league.rows.map(r => {
        const raw = pick(r, H('league'), /^pua/, 0, out, 'Lig');
        const points = num(raw);
        if (points == null) out.warnings.push('Lig satırı ' + r.rank + ': puan okunamadı (UNKNOWN)');
        const club = r.texts[0] || 'UNKNOWN';
        const manager = r.texts[1] || 'UNKNOWN';
        if (manager === 'UNKNOWN') out.warnings.push('Lig satırı ' + r.rank + ': menajer okunamadı');
        return { rank: r.rank, club, manager, points, rawNums: r.numsRaw, team: teamOf(manager, club, st) };
      });
    }
    const lg = out.league;
    if (out.tabOk.managers) {
      out.managers = T.managers.rows.map(r => {
        const id = identify(r.texts, lg);
        return { rank: r.rank, manager: id.manager, club: id.club, extra: r.numsRaw, team: teamOf(id.manager, id.club, st) };
      });
    }
    if (out.tabOk.squad) {
      out.squad = T.squad.rows.map(r => {
        const id = identify(r.texts, lg);
        const raw = pick(r, H('squad'), /^deger/, 0, out, 'Kadro');
        const players = num(pick(r, H('squad'), /^oyuncular/, 1, out, 'Kadro'));
        if (id.manager === 'UNKNOWN') out.warnings.push('Kadro satırı ' + r.rank + ': menajer eşleşmedi');
        return { rank: r.rank, manager: id.manager, club: id.club, value: num(raw), valueRaw: raw, players, team: teamOf(id.manager, id.club, st) };
      });
    }
    if (out.tabOk.goals) {
      // GOL sekmesi kulüp bazlıdır: atılan / yenilen gol, sarı / kırmızı kart
      out.goals = T.goals.rows.map(r => {
        const id = identify(r.texts, lg);
        const scored = num(pick(r, H('goals'), /at.lan gol/, 0, out, 'Gol'));
        return {
          rank: r.rank, club: id.club, manager: id.manager, team: teamOf(id.manager, id.club, st),
          scored, conceded: num(pick(r, H('goals'), /yenilen gol/, 1, out, 'Gol')),
          yellow: num(pick(r, H('goals'), /sar. kart/, 2, out, 'Gol')),
          red: num(pick(r, H('goals'), /k.rm.z. kart/, 3, out, 'Gol')),
          goals: Number.isInteger(scored) ? scored : null
        };
      });
    }
    // Sayfadaki "Gol kralları" listesi (yalnızca ilk birkaç oyuncu)
    out.topScorers = (snap.scorers || []).map(x => {
      const id = identify([x.club], lg);
      return { player: x.player, club: x.club, manager: id.manager, team: teamOf(id.manager, x.club, st), goals: x.goals };
    });
    return out;
  }

  // İki lig kaydı arasındaki fark (kümülatif puan -> maç günü puanı)
  function computeDiff(prev, curr) {
    const r = { valid: false, unchanged: false, reasons: [], warnings: [], rows: [], red: 0, blue: 0 };
    if (!prev || !curr) { r.reasons.push('BASELINE_YOK'); r.red = r.blue = null; return r; }
    if (!prev.tabOk.league || !curr.tabOk.league) { r.reasons.push('LIG_TABLOSU_EKSIK'); r.red = r.blue = null; return r; }
    const pm = new Map(prev.league.map(x => [K(x.manager), x]));
    const cm = new Map(curr.league.map(x => [K(x.manager), x]));
    const cnt = { RED: 0, BLUE: 0 };
    curr.league.forEach(c => {
      if (c.team === 'UNKNOWN') return;
      cnt[c.team]++;
      const p = pm.get(K(c.manager));
      if (!p) { r.reasons.push('ONCEKI_KAYIT_YOK:' + c.manager); return; }
      if (p.points == null || c.points == null) { r.reasons.push('PUAN_OKUNAMADI:' + c.manager); return; }
      const d = c.points - p.points;
      if (!Number.isInteger(d)) { r.reasons.push('TAMSAYI_DEGIL:' + c.manager); return; }
      if (d < 0) r.reasons.push('NEGATIF_FARK:' + c.manager + ' (' + d + ')');
      else if ([0, 1, 3].indexOf(d) === -1) r.warnings.push(c.manager + ' farkı ' + d + ' (0/1/3 dışı; birden fazla maç günü olabilir)');
      r.rows.push({ manager: c.manager, club: c.club, team: c.team, prev: p.points, curr: c.points, diff: d });
      if (c.team === 'RED') r.red += d; else r.blue += d;
    });
    prev.league.forEach(p => {
      if (p.team !== 'UNKNOWN' && !cm.has(K(p.manager))) r.reasons.push('MENAJER_KAYIP:' + p.manager);
    });
    if (cnt.RED !== 5 || cnt.BLUE !== 5) r.reasons.push('TAKIM_5V5_DEGIL:RED=' + cnt.RED + ',BLUE=' + cnt.BLUE);
    r.valid = r.reasons.length === 0;
    r.unchanged = r.valid && r.rows.every(x => x.diff === 0);
    if (!r.valid) { r.red = null; r.blue = null; }
    return r;
  }

  // Takım toplamı; okunamayanlar sıfır sayılmaz, 'unknown' olarak sayılır.
  function agg(rows, field) {
    const o = { RED: { sum: 0, n: 0, unknown: 0 }, BLUE: { sum: 0, n: 0, unknown: 0 } };
    (rows || []).forEach(r => {
      const t = o[r.team];
      if (!t) return;
      t.n++;
      if (r[field] == null) t.unknown++; else t.sum += r[field];
    });
    return o;
  }

  function goalsByManager(goals) {
    const m = new Map();
    (goals || []).forEach(r => {
      if (r.goals == null || r.manager === 'UNKNOWN') return;
      const k = K(r.manager);
      if (!m.has(k)) m.set(k, { manager: r.manager, team: r.team, goals: 0 });
      m.get(k).goals += r.goals;
    });
    return Array.from(m.values()).sort((a, b) => b.goals - a.goals);
  }

  function tournament(mds) {
    const t = { n: mds.length, redPts: 0, bluePts: 0, redWins: 0, blueWins: 0, draws: 0 };
    mds.forEach(m => {
      t.redPts += m.red; t.bluePts += m.blue;
      if (m.red > m.blue) t.redWins++; else if (m.blue > m.red) t.blueWins++; else t.draws++;
    });
    return t;
  }

  g.OSMScore = { parseNum, teamOf, identify, normalize, computeDiff, agg, goalsByManager, tournament, K };
})(typeof window !== 'undefined' ? window : globalThis);
