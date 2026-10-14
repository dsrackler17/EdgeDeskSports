'use strict';
/* ===========================================================================
   Lineups: which fives work, and whether that survives adjustment.

   Built from the possession table's ten ids (the publisher's separate lineup
   table is quarantined: its opening fives match ESPN starters in about 1% of
   team-games). For every five a team used:

     raw            points scored and allowed per 100 of its possessions
     adjusted       the same against the opponents it actually faced: each
                    possession's residual against an average five facing those
                    opponents (from the player fit), averaged
     player sum     what its five players' impacts imply
     pooled         player sum + the lineup's own residual shrunk by
                    tau2 / (tau2 + sampling variance), tau2 the between-lineup
                    variance of residuals estimated by moments

   A ten-possession lineup therefore sits almost exactly on its player sum,
   and only a big sample can move it. Whether residuals persist at all is
   tested chronologically (first half of the season vs second); roles
   (creation, shooting, rim pressure, rebounding, ball security, rim
   protection) are tested as explanations of residuals and reported as model-
   supported only if they hold up.

   Minutes per lineup come from the matchup stints (names), mapped to ids
   through the possession table's own name-beside-id pairs within the team.
   =========================================================================== */
const U = require('./lib/util');
const PM = require('./player_model');

/** team lineups from units B with player fit f */
function lineupTable(B, f) {
  const P = B.players.length; const Ut = B.units; const x = f.x; const mu = f.mu; const eta = f.eta;
  const L = new Map();
  const keyOf = (u, s) => { const a = []; for (let k = 0; k < 5; k++) a.push(Ut.ids[u * 10 + s + k]); return a.sort((p, q) => p - q).join(','); };
  for (let u = 0; u < Ut.n; u++) {
    const c = Ut.cnt[u]; const y = Ut.pts[u];
    let sO = 0; let sD = 0; for (let k = 0; k < 5; k++) { sO += x[Ut.ids[u * 10 + k]]; sD += x[P + Ut.ids[u * 10 + 5 + k]]; }
    // offense five: residual vs average five against this defense
    const kOff = Ut.offTeam[u] + '|' + keyOf(u, 0);
    const exOff = mu + eta * Ut.v[u] - sD;
    let a = L.get(kOff); if (!a) { a = blank(Ut.offTeam[u], keyOf(u, 0)); L.set(kOff, a); }
    a.off_poss += c; a.off_pts += y; a.off_res += y - c * exOff; a.games.add(Ut.game[u]);
    // defense five: residual vs average five against this offense
    const kDef = Ut.defTeam[u] + '|' + keyOf(u, 5);
    const exDef = mu + eta * Ut.v[u] + sO;
    let b = L.get(kDef); if (!b) { b = blank(Ut.defTeam[u], keyOf(u, 5)); L.set(kDef, b); }
    b.def_poss += c; b.def_pts += y; b.def_res += c * exDef - y; b.games.add(Ut.game[u]);
  }
  const rows = [];
  for (const a of L.values()) {
    const idx = a.key.split(',').map(Number);
    let ps = 0; for (const i of idx) ps += x[i] + x[P + i];
    const adjO = a.off_poss ? a.off_res / a.off_poss : null; const adjD = a.def_poss ? a.def_res / a.def_poss : null;
    rows.push({ team: a.team, players: idx.map((i) => B.players[i]), idx, off_poss: a.off_poss, def_poss: a.def_poss, games: a.games.size,
      raw_off: a.off_poss ? a.off_pts / a.off_poss : null, raw_def: a.def_poss ? a.def_pts / a.def_poss : null,
      adj_off: adjO, adj_def: adjD, adj_net: adjO != null && adjD != null ? adjO + adjD : null, player_sum: ps });
  }
  return rows;
}
function blank(team, key) { return { team, key, off_poss: 0, off_pts: 0, off_res: 0, def_poss: 0, def_pts: 0, def_res: 0, games: new Set() }; }

/** partial pooling of lineup residuals; s2 = residual variance per possession */
function pool(rows, s2, minPoss) {
  const usable = rows.filter((r) => r.off_poss >= (minPoss || 40) && r.def_poss >= (minPoss || 40));
  const mom = usable.map((r) => { const res = r.adj_net - r.player_sum; const v = s2 / r.off_poss + s2 / r.def_poss; return { res, v }; });
  const tau2 = Math.max(0, U.mean(mom.map((m) => m.res * m.res - m.v)));
  for (const r of rows) {
    if (r.adj_net == null) { r.pooled = r.player_sum; r.shrink = 0; r.sd = null; continue; }
    const v = s2 / Math.max(1, r.off_poss) + s2 / Math.max(1, r.def_poss);
    const w = tau2 > 0 ? tau2 / (tau2 + v) : 0;
    r.shrink = w; r.pooled = r.player_sum + w * (r.adj_net - r.player_sum); r.sd_residual = Math.sqrt(w * v);
  }
  return { tau2, tau: Math.sqrt(tau2), lineups_used: usable.length };
}

/** do lineup residuals persist? fit on the first half of games, compare residuals in both halves for lineups with >= minPoss in each */
function persistence(B, fitFn, gameStart, splitMs, minPoss) {
  const first = PM.subset(B, (u) => gameStart(B.units.game[u]) < splitMs);
  const second = PM.subset(B, (u) => gameStart(B.units.game[u]) >= splitMs);
  const f1 = fitFn(first);
  const r1 = lineupTable(first, f1); const r2 = lineupTable(second, f1);
  const m2 = new Map(r2.map((r) => [r.team + '|' + r.players.join(','), r]));
  const a = []; const b = []; const w = [];
  for (const r of r1) {
    const o = m2.get(r.team + '|' + r.players.join(',')); if (!o) continue;
    if (r.off_poss + r.def_poss < minPoss || o.off_poss + o.def_poss < minPoss) continue;
    a.push(r.adj_net - r.player_sum); b.push(o.adj_net - o.player_sum); w.push(Math.min(r.off_poss + r.def_poss, o.off_poss + o.def_poss));
  }
  return { lineups: a.length, corr_residual_first_vs_second_half: U.r(U.corr(a, b), 3), note: 'a correlation near zero means a lineup\'s result beyond its players\' impacts did not repeat' };
}

/* ---------------------------------------------------------------- roles */
/** role tags from season box rates (per 100 possessions on the floor) relative to all D1 rotation players */
function roleTags(box) {
  const list = [...box.values()].filter((b) => b.poss >= 300);
  const pctile = (f) => { const v = list.map(f).sort((a, b) => a - b); return (x) => { let lo = 0; let hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < x) lo = m + 1; else hi = m; } return lo / v.length; }; };
  const cre = pctile((b) => b.rates.unast + b.rates.ast * 0.5); const sho = pctile((b) => b.rates.three_a);
  const rim = pctile((b) => b.rates.rim_a + b.rates.fta * 0.5); const reb = pctile((b) => b.rates.orb + b.rates.drb);
  const sec = pctile((b) => -b.rates.tov / Math.max(1, b.rates.usage)); const pro = pctile((b) => b.rates.blk + b.rates.stl);
  const tpct = (b) => (b.tpa >= 40 ? b.tpm / b.tpa : null);
  const out = new Map();
  for (const b of box.values()) {
    if (b.poss < 100) { out.set(b.pid, { tags: [], sample: 'small' }); continue; }
    const tags = [];
    if (cre(b.rates.unast + b.rates.ast * 0.5) >= 0.8) tags.push('creator');
    if (sho(b.rates.three_a) >= 0.7 && (tpct(b) == null || tpct(b) >= 0.33)) tags.push('shooter');
    if (rim(b.rates.rim_a + b.rates.fta * 0.5) >= 0.75) tags.push('rim_pressure');
    if (reb(b.rates.orb + b.rates.drb) >= 0.8) tags.push('rebounder');
    if (sec(-b.rates.tov / Math.max(1, b.rates.usage)) >= 0.75 && b.rates.usage >= 15) tags.push('ball_secure');
    if (pro(b.rates.blk + b.rates.stl) >= 0.8) tags.push('disruptor');
    out.set(b.pid, { tags, sample: b.poss >= 300 ? 'adequate' : 'limited' });
  }
  return out;
}

/** weighted regression of lineup residuals on role-composition indicators; is any coefficient distinguishable from zero? */
function roleTest(rows, tags, minPoss) {
  const feats = ['no_creator', 'two_plus_shooters', 'no_rebounder', 'no_disruptor'];
  const X = []; const y = []; const w = [];
  for (const r of rows) {
    if (r.off_poss + r.def_poss < (minPoss || 80) || r.adj_net == null) continue;
    const t = r.players.map((p) => (tags.get(p) || { tags: [] }).tags);
    const has = (k) => t.filter((x) => x.includes(k)).length;
    X.push([1, has('creator') === 0 ? 1 : 0, has('shooter') >= 2 ? 1 : 0, has('rebounder') === 0 ? 1 : 0, has('disruptor') === 0 ? 1 : 0]);
    y.push(r.adj_net - r.player_sum); w.push(r.off_poss + r.def_poss);
  }
  const k = 5; const A = new Float64Array(k * k); const b = new Float64Array(k);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { b[a] += w[i] * X[i][a] * y[i]; for (let c = 0; c < k; c++) A[a * k + c] += w[i] * X[i][a] * X[i][c]; }
  for (let a = 0; a < k; a++) A[a * k + a] += 1e-6;
  const L = U.cholesky(A, k); const beta = U.cholSolve(L, k, b); const inv = U.cholInverse(L, k);
  let rss = 0; let sw = 0; for (let i = 0; i < X.length; i++) { let p = 0; for (let a = 0; a < k; a++) p += beta[a] * X[i][a]; rss += w[i] * (y[i] - p) ** 2; sw += w[i]; }
  const s2 = rss / Math.max(1, X.length - k); // per unit weight
  const out = { lineups: X.length, coefficients: {} };
  // four role tests at once: Bonferroni, two-sided 5% family-wise -> |z| > 2.50
  feats.forEach((f, j) => { const se = Math.sqrt(s2 * inv[(j + 1) * k + j + 1]); const est = beta[j + 1]; out.coefficients[f] = { points_per_100: U.r(est, 2), se: U.r(se, 2), z: U.r(est / se, 2), supported: Math.abs(est / se) > 2.5 }; });
  out.multiple_testing = 'four role tests: supported requires |z| > 2.50 (Bonferroni, 5% family-wise); in-sample only, so even a supported effect would remain a hypothesis until it holds on later games';
  out.note = 'residual = adjusted lineup net minus its players\' impact sum; a supported role effect would mean lineups play better or worse than their players add up to';
  void sw;
  return out;
}

/* ---------------------------------------------------------------- minutes from stints */
function stintMinutes(S, P, G, teamOfName) {
  // raw names beside ids in the possession table, per team: team|RAWNAME -> id (unique only)
  const byTeamName = new Map(); const clash = new Set();
  for (let i = 0; i < P.n; i++) for (let k = 0; k < 10; k++) {
    const id = P.ids[i * 10 + k]; if (!Number.isFinite(id)) continue;
    const team = k < 5 ? P.home[i] : P.away[i]; const nm = P.names.get(id); if (!nm || !nm.raw) continue;
    const key = team + '|' + nm.raw; const cur = byTeamName.get(key);
    if (cur != null && cur !== id) clash.add(key); else byTeamName.set(key, id);
  }
  const c = S.cols; const contestTeams = new Map();
  for (let i = 0; i < P.n; i++) if (!contestTeams.has(P.contest[i])) contestTeams.set(P.contest[i], { home: P.home[i], away: P.away[i], game: P.game[i] });
  const out = new Map(); let mapped = 0; let unmapped = 0;
  for (let i = 0; i < S.n; i++) {
    const ct = contestTeams.get(c.contest_id[i]); if (!ct) { unmapped++; continue; }
    for (const [side, team] of [['home_lineup', ct.home], ['away_lineup', ct.away]]) {
      const names = String(c[side][i] || '').split('|'); if (names.length !== 5) { unmapped++; continue; }
      const ids = names.map((n) => { const k = team + '|' + n; return clash.has(k) ? null : byTeamName.get(k); });
      if (ids.some((x) => x == null)) { unmapped++; continue; }
      const key = team + '|' + ids.sort((a, b) => a - b).join(',');
      out.set(key, (out.get(key) || 0) + (c.duration_seconds[i] || 0) / 60); mapped++;
    }
  }
  void G; void teamOfName;
  return { minutes: out, mapped_lineup_stints: mapped, unmapped_lineup_stints: unmapped, ambiguous_name_keys: clash.size };
}

module.exports = { lineupTable, pool, persistence, roleTags, roleTest, stintMinutes };
