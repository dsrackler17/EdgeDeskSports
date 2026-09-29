#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — how props in the same game move together (DESIGN.md §13).

     node football/props/correlation.js [--season 2025] [--write] [--offline]

   Two props in one game are not independent: a quarterback's passing yards
   and his top receiver's receiving yards rise and fall together, and two
   running backs on the same team split carries. This measures those
   dependencies from the nflverse game logs — never assumes them — as the
   correlation of NORMAL SCORES (a Gaussian copula), so it measures co-movement
   without disturbing any prop's own distribution:

     1. each player-season with a real role (six or more played games at a
        role-level volume) turns every market's statistic into normal scores
        within that player-season: z = Φ⁻¹((rank − ½) / n), ties averaged. A
        z of +1 is "a good game for him", whatever his level.
     2. the Pearson correlation of those z's, pooled over every regular-season
        game of the two seasons, for three relations:
          same_player   one player, two markets     "QB|pass_tds|pass_yds"
          teammate      two players, one team       "QB:pass_yds|WR:rec_yds"
          opponent      two players, opposing teams "QB:pass_yds|QB:pass_yds"
     3. each estimate is shrunk toward zero by n / (n + 100) and kept only
        with n ≥ 150 and |ρ| ≥ 0.03, rounded to 0.01.

   EDProps reads the result (the board carries it) for two things: a seeded
   same-game Monte Carlo of the joint outcome of several props
   (EDProps.jointSim), and the correlated exposure cap on a game's stakes
   (EDProps.exposure). A pair it does not list is treated as independent.

   Writes football/props/nfl/correlation.json. College boards borrow it (no
   public college game-log feed has the per-player depth to fit its own).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));
const M = require('./model.js');

const SCHEMA = 'edgedesk_player_props_correlation_v1';
/* the markets each role is priced in (the board's own list) */
const MARKETS = {
  QB: ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_ints', 'rush_yds', 'rush_att', 'pass_rush_yds', 'anytime_td'],
  RB: ['rush_yds', 'rush_att', 'receptions', 'rec_yds', 'rush_rec_yds', 'anytime_td'],
  WR: ['rec_yds', 'receptions', 'targets', 'rec_long', 'anytime_td'],
  TE: ['rec_yds', 'receptions', 'targets', 'rec_long', 'anytime_td'],
  K: ['fg_made', 'kicking_pts']
};
/* a real role: the player-season's mean volume per played game */
const ROLE = { QB: (l) => l.att >= 15, RB: (l) => l.car + l.tgt >= 6, WR: (l) => l.tgt >= 3, TE: (l) => l.tgt >= 2, K: (l) => (l.fga || 0) + (l.xpm || 0) >= 1 };
const MIN_GAMES = 6, MIN_N = 150, MIN_ABS = 0.03, SHRINK = 100;

function posOf(p) { const g = p.pg || p.pos; return g === 'FB' ? 'RB' : g; }
/* Φ⁻¹ (Acklam) */
function probit(p) {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (q < 0.02425) { const t = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1); }
  if (q > 1 - 0.02425) { const t = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * t + c[1]) * t + c[2]) * t + c[3]) * t + c[4]) * t + c[5]) / ((((d[0] * t + d[1]) * t + d[2]) * t + d[3]) * t + 1); }
  const t = q - 0.5, r = t * t;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * t / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/* normal scores with ties averaged; a constant series carries no information */
function normalScores(xs) {
  const n = xs.length, idx = xs.map((v, i) => i).sort((i, j) => xs[i] - xs[j]), rank = new Array(n);
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && xs[idx[j + 1]] === xs[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rank[idx[k]] = avg; i = j + 1; }
  if (xs.every((v) => v === xs[0])) return null;
  return rank.map((r) => probit((r - 0.5) / n));
}

/* one player-season's z per game and market, when he had a real role */
function playerSeasons(ds, seasons) {
  const out = [];
  Object.keys(ds.players || {}).forEach((pid) => {
    const p = ds.players[pid], pos = posOf(p), ms = MARKETS[pos];
    if (!ms) return;
    seasons.forEach((s) => {
      const logs = (p.logs || []).filter((l) => l.s === s && (l.st || 'REG') === 'REG' && M.playedIn(l));
      if (logs.length < MIN_GAMES) return;
      const mean = (f) => logs.reduce((a, l) => a + (Number(f(l)) || 0), 0) / logs.length;
      const avg = { att: mean((l) => l.att), car: mean((l) => l.car), tgt: mean((l) => l.tgt), fga: mean((l) => l.fga), xpm: mean((l) => l.xpm) };
      if (!ROLE[pos](avg)) return;
      const z = {};
      ms.forEach((m) => {
        const xs = logs.map((l) => EDP.statOf(m, l));
        if (xs.some((v) => v == null)) return;
        const ns = normalScores(xs); if (ns) z[m] = ns;
      });
      logs.forEach((l, i) => { const zi = {}; Object.keys(z).forEach((m) => { zi[m] = z[m][i]; }); out.push({ pid, pos, gid: l.gid, tm: l.tm, z: zi }); });
    });
  });
  return out;
}

function acc(T, k, x, y) { const a = T[k] || (T[k] = [0, 0, 0, 0, 0, 0]); a[0]++; a[1] += x; a[2] += y; a[3] += x * x; a[4] += y * y; a[5] += x * y; }
function corrOf(a) { const n = a[0], cov = a[5] / n - (a[1] / n) * (a[2] / n), vx = a[3] / n - (a[1] / n) * (a[1] / n), vy = a[4] / n - (a[2] / n) * (a[2] / n); return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : null; }
function finish(T) {
  const out = {};
  Object.keys(T).sort().forEach((k) => {
    const n = T[k][0], r = corrOf(T[k]);
    if (r == null || n < MIN_N) return;
    const s = r * n / (n + SHRINK);
    if (Math.abs(s) < MIN_ABS) return;
    out[k] = [Math.round(s * 100) / 100, n];
  });
  return out;
}
function pairKey(a, b) { const x = [a, b].sort(); return x[0] + '|' + x[1]; }

function estimate(ds, seasons) {
  const rows = playerSeasons(ds, seasons), byGame = {};
  rows.forEach((r) => { (byGame[r.gid] = byGame[r.gid] || []).push(r); });
  const SP = {}, TM = {}, OP = {};
  rows.forEach((r) => {
    const ms = Object.keys(r.z).sort();
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) acc(SP, r.pos + '|' + ms[i] + '|' + ms[j], r.z[ms[i]], r.z[ms[j]]);
  });
  Object.keys(byGame).forEach((gid) => {
    const g = byGame[gid];
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j], T = a.tm === b.tm ? TM : OP;
      Object.keys(a.z).forEach((ma) => Object.keys(b.z).forEach((mb) => {
        const ka = a.pos + ':' + ma, kb = b.pos + ':' + mb;
        /* the pair key is sorted, so the z's go in the key's order */
        if (ka <= kb) acc(T, ka + '|' + kb, a.z[ma], b.z[mb]); else acc(T, kb + '|' + ka, b.z[mb], a.z[ma]);
      }));
    }
  });
  return { n_player_games: rows.length, n_games: Object.keys(byGame).length, same_player: finish(SP), teammate: finish(TM), opponent: finish(OP) };
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('season', C.seasonOf() - 1)), write = a.indexOf('--write') >= 0;
  const L = require('./sources/nfl.js');
  const log = (s) => console.log('[props correlation] ' + s);
  log('loading nfl ' + season + ' (and ' + (season - 1) + ') …');
  const ds = await L.load({ season, offline: a.indexOf('--offline') >= 0, now: Date.UTC(season + 1, 1, 20), current_feeds: ['stats', 'snaps', 'roster'] });
  if (!ds.ok) { log('dataset unavailable: ' + ds.error); return 1; }
  const est = estimate(ds, [season - 1, season]);
  const out = Object.assign({ schema: SCHEMA, league: 'nfl', seasons: [season - 1, season], generated_at: new Date().toISOString(),
    method: 'Pearson correlation of within-player-season normal scores (Gaussian copula), regular season, players with a real role; shrunk by n/(n+' + SHRINK + '); kept with n ≥ ' + MIN_N + ' and |ρ| ≥ ' + MIN_ABS },
  est);
  log(est.n_games + ' games, ' + est.n_player_games + ' player-games · same player ' + Object.keys(est.same_player).length + ', teammates ' + Object.keys(est.teammate).length + ', opponents ' + Object.keys(est.opponent).length + ' pairs');
  const show = (T, ks) => ks.forEach((k) => { if (T[k]) log('  ' + k + ' ρ ' + T[k][0] + ' (n ' + T[k][1] + ')'); });
  show(est.same_player, ['QB|pass_tds|pass_yds', 'RB|rush_att|rush_yds', 'WR|rec_yds|receptions']);
  show(est.teammate, ['QB:pass_yds|WR:rec_yds', 'QB:pass_yds|TE:rec_yds', 'QB:pass_yds|RB:rush_yds', 'RB:rush_att|RB:rush_att', 'K:kicking_pts|QB:pass_tds']);
  show(est.opponent, ['QB:pass_yds|QB:pass_yds', 'QB:pass_att|RB:rush_att']);
  if (!write) { log('dry run: nothing written (pass --write)'); return 0; }
  const file = C.leaguePaths('nfl', season).correlation;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  log('written ' + path.relative(C.ROOT, file));
  return 0;
}

module.exports = { estimate, normalScores, probit, pairKey, MARKETS, SCHEMA };
if (require.main === module) main().then((c) => process.exit(c || 0), (e) => { console.error(e); process.exit(1); });
