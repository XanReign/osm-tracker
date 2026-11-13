/* matches.js — bireysel maç motoru (maç günü / MD kavramı YOK)
   Kaynak veri birikimli tablolardır; bir menajerin iki ardışık görüntü arasındaki değişimi tek bir maç kaydına çevrilir.
   Kimlik: savaş + menajer + maç SONRASI birikimli durum (puan-atılan-yenilen). Aynı veri tekrar gelse aynı kimliği üretir.
   Belirsiz durumlar (birden fazla maç birleşmiş, tutarsız gol/puan) tahmin edilmez, REVIEW olarak ayrılır. */
(function (g) {
  'use strict';
  const K = s => OSMScore.K(s);
  const RES = { 3: 'W', 1: 'D', 0: 'L' };
  const maps = n => ({ lg: new Map(n.league.map(r => [K(r.manager), r])), gl: new Map(n.goals.map(r => [K(r.manager), r])), sq: new Map(n.squad.map(r => [K(r.manager), r])) });
  const gk = x => !!(x && x.scored != null && x.conceded != null);

  // Tutarlılık: W => atılan > yenilen, D => eşit, L => atılan < yenilen (gol biliniyorsa)
  function consistent(res, dgf, dga) {
    if (dgf == null || dga == null) return true;
    return res === 'W' ? dgf > dga : res === 'D' ? dgf === dga : dgf < dga;
  }

  function detect(prev, cur, ctx) {
    const out = { matches: [], review: [], idle: 0, ambiguous: 0 };
    const P = maps(prev), C = maps(cur);
    cur.league.forEach(r => {
      if (r.team === 'UNKNOWN') return;
      const key = K(r.manager), p = P.lg.get(key);
      if (!p) return;                                                   // yeni menajer: karşılaştırma yok
      const base = { warId: ctx.warId, key, manager: r.manager, club: r.club, team: r.team, ts: ctx.ts, snapshotId: ctx.snapshotId, prevSnapshotId: ctx.prevSnapshotId, source: 'live', rev: 1 };
      if (p.points == null || r.points == null) { out.review.push(Object.assign(base, { id: ctx.warId + ':' + key + ':u-' + ctx.snapshotId, status: 'REVIEW', reason: 'POINTS_UNKNOWN', points: null, gf: null, ga: null, yc: null, rc: null, squad: null, result: null })); return; }
      const g0 = P.gl.get(key), g1 = C.gl.get(key), known = gk(g0) && gk(g1);
      const dp = r.points - p.points;
      const dgf = known ? g1.scored - g0.scored : null, dga = known ? g1.conceded - g0.conceded : null;
      const dyc = g0 && g1 && g0.yellow != null && g1.yellow != null ? g1.yellow - g0.yellow : null;
      const drc = g0 && g1 && g0.red != null && g1.red != null ? g1.red - g0.red : null;
      const s1 = C.sq.get(key);
      const fp = known ? r.points + '-' + g1.scored + '-' + g1.conceded : 'p' + r.points + '~' + ctx.snapshotId;
      const rec = Object.assign(base, { id: ctx.warId + ':' + key + ':' + fp, points: dp, gf: dgf, ga: dga, yc: dyc, rc: drc, squad: s1 && s1.value != null ? s1.value : null, afterPts: r.points, afterGf: known ? g1.scored : null, afterGa: known ? g1.conceded : null });
      if (dp < 0 || (known && (dgf < 0 || dga < 0))) { out.review.push(Object.assign(rec, { status: 'REVIEW', reason: 'NEGATIVE_DELTA', result: null })); return; }
      const played = dp > 0 || (known && (dgf > 0 || dga > 0));
      if (!played) { if (!known && dp === 0) out.ambiguous++; else out.idle++; return; }   // değişim yok: maç oynanmadı
      if (RES[dp] === undefined) { out.review.push(Object.assign(rec, { status: 'REVIEW', reason: 'MULTI_MATCH(' + dp + ' pts)', result: null })); return; }
      const res = RES[dp];
      if (!consistent(res, dgf, dga)) { out.review.push(Object.assign(rec, { status: 'REVIEW', reason: 'INCONSISTENT(' + res + ' ' + dgf + '-' + dga + ')', result: null })); return; }
      out.matches.push(Object.assign(rec, { status: 'OK', result: res }));
    });
    return out;
  }

  // Maçı kaydet / bağımsız güncelle. Aynı kimlik + aynı veri = 'duplicate'. DISMISSED kayıtlar geri gelmez.
  async function upsert(rec) {
    const old = await OSMDB.get('matches', rec.id);
    if (!old) { await OSMDB.put('matches', rec); return 'added'; }
    if (old.status === 'DISMISSED') return 'dismissed';
    const f = ['result', 'points', 'gf', 'ga', 'yc', 'rc', 'squad', 'status', 'reason'];
    if (f.every(k => old[k] === rec[k])) return 'duplicate';
    await OSMDB.put('matches', Object.assign({}, old, rec, { ts: old.ts, rev: (old.rev || 1) + 1, updatedAt: Date.now() }));
    return 'updated';
  }
  async function forWar(warId, status) {
    return (await OSMDB.all('matches')).filter(m => m.warId === warId && (!status || m.status === status)).sort((a, b) => a.ts - b.ts || (a.manager < b.manager ? -1 : 1));
  }
  async function dismiss(id) {
    const m = await OSMDB.get('matches', id);
    if (m) { m.status = 'DISMISSED'; m.updatedAt = Date.now(); await OSMDB.put('matches', m); }
  }

  // Yalnızca status 'OK' maçlar istatistiğe girer
  function summarize(matches) {
    const m = new Map();
    matches.filter(x => x.status === 'OK').forEach(x => {
      let a = m.get(x.key);
      if (!a) { a = { played: 0, w: 0, d: 0, l: 0, pts: 0, gm: 0, tgf: 0, tga: 0, yc: 0, rc: 0 }; m.set(x.key, a); }
      a.played++; a.pts += x.points;
      if (x.result === 'W') a.w++; else if (x.result === 'D') a.d++; else a.l++;
      if (x.gf != null && x.ga != null) { a.gm++; a.tgf += x.gf; a.tga += x.ga; }
    });
    return m;
  }

  // Eski "maç günü" kaydı -> bireysel maç kayıtları. Hiçbir veri silinmez; doğrulanamayanlar REVIEW olur.
  function fromLegacy(rec, warId) {
    const out = [];
    (rec.rows || []).forEach(r => {
      const key = K(r.manager), has = r.gf != null && r.ga != null;
      const base = { warId, key, manager: r.manager, club: r.club, team: r.team, ts: rec.ts, snapshotId: rec.snapshotId || null, prevSnapshotId: rec.baselineId || null, source: 'migrated', rev: 1,
        id: warId + ':' + key + ':' + (rec.snapshotId || 'ts' + rec.ts), points: r.diff, gf: r.gf == null ? null : r.gf, ga: r.ga == null ? null : r.ga, yc: r.yc == null ? null : r.yc, rc: r.rc == null ? null : r.rc, squad: r.squad == null ? null : r.squad, afterPts: r.curr, afterGf: null, afterGa: null };
      let st = 'OK', reason = null, res = RES[r.diff] || null;
      if (r.diff == null || res === null || r.diff < 0) { st = 'REVIEW'; reason = 'LEGACY_MULTI_MATCH(' + r.diff + ' pts)'; res = null; }
      else if (r.diff === 0 && !has) { st = 'REVIEW'; reason = 'LEGACY_UNVERIFIED (0 pts, no goal data: played or not?)'; res = null; }
      else if (r.diff === 0 && has && r.gf === 0 && r.ga === 0) { st = 'REVIEW'; reason = 'LEGACY_NO_ACTIVITY (no points, no goals)'; res = null; }
      else if (!consistent(res, has ? r.gf : null, has ? r.ga : null)) { st = 'REVIEW'; reason = 'LEGACY_INCONSISTENT'; res = null; }
      out.push(Object.assign(base, { status: st, reason, result: res }));
    });
    return out;
  }

  g.OSMMatches = { detect, upsert, forWar, dismiss, summarize, fromLegacy, consistent };
})(typeof window !== 'undefined' ? window : globalThis);
