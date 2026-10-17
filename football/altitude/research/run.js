#!/usr/bin/env node
/* ============================================================================
   THE ALTITUDE RESEARCH HARNESS — does accounting for altitude make
   EdgeDesk's CFB number better than it already is?

   NOT "DOES ALTITUDE MATTER". The research package answered a different
   question: with team-season fixed effects fitted on whole seasons (results
   from after each game included), visitors climbing 3,000+ ft did 1.19 points
   worse (SE 0.77). That is an ex-post association, and an association is not
   a correction to a pregame number that already prices team strength and home
   field. So this file asks the only question that can move a line:

     conditional on what V1 (football/cfb_p4/engine.js) published before
     kickoff, does a pre-registered altitude term reduce the error on games it
     never saw?

   THE DATA, AND WHERE EACH PIECE COMES FROM.
     baseline   the SHIPPED V1 engine replayed cold, game by game in kickoff
                order, from state containing only earlier games
                (football/cfb_p4/research/replay_rows.js — reused, not copied)
     market     football/cfb_p4/research/build_market.py over the public
                cfbfastR betting archive: opening and closing consensus home
                lines, 2006-2025
     altitude   football/altitude/engine.js on the schedule feed and the venue
                registry (football/altitude/venues.json) — the SAME function
                the live page calls
     play load  optional: the research package's play-by-play aggregates
                (visitor defence plays faced), turned into a season-to-date
                average of PRIOR games only. Exists 2004-2021.

   NOTHING POSTGAME ENTERS A FEATURE. Elevation, distance, time zones and
   rest are schedule facts. The pace proxy is V1's own pregame total. The play
   load is a lagged average of earlier games. Every fit uses seasons strictly
   before the season it predicts, and the harness asserts it.

     node football/altitude/research/run.js --data DIR [--panel FILE] [--write]
          [--perm 200] [--boot 2000]
     node football/altitude/research/run.js --render-only   (re-render the report)

   DIR holds sched/sched_<y>.csv (cfbfastR schedules) and out/market.csv
   (build_market.py). --write regenerates football/altitude/params.js,
   football/validation/altitude_cfb.json and docs/cfb-altitude/BACKTEST.md.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..', '..');
const A = require(path.join(ROOT, 'football', 'altitude', 'engine.js'));
const RR = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'replay_rows.js'));
const PROMOTE = require(path.join(ROOT, 'football', 'validation', 'promote.js'));
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const G = require(path.join(__dirname, 'gates.js'));
const REGISTRY = require(path.join(ROOT, 'football', 'altitude', 'venues.json'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
const DATA = path.resolve(String(arg('data', process.env.CFB_P4_DATA || path.join(ROOT, 'football', 'altitude', '.cache', 'data'))));
const PANEL = arg('panel', null);
const WRITE = !!arg('write', false);
const NPERM = +arg('perm', 200);
const NBOOT = +arg('boot', 2000);
const NWILD = +arg('wild', 999);
const REPLAY_FROM = +arg('replay-from', 2001);
const FROM = G.WINDOWS.train_from, TO = G.WINDOWS.confirm[1];
const SEL = G.WINDOWS.select, CONF = G.WINDOWS.confirm;
const CAP = 3;
const LAMBDAS = [0, 2, 5, 10, 20, 50, 100, 200, 500];
const MAIN = { linear_gain: 'gain_pos_k', piecewise: 'spline_3000_plus', cat_3000: 'high_gain', buckets: 'high_gain',
  cat_3000_acclim: 'high_gain', cat_3000_recent: 'high_gain', cat_3000_pace: 'high_gain', cat_3000_load: 'high_gain',
  cat_3000_opp_pace: 'high_gain', cat_3000_travel: 'high_gain',
  ratio6: 'ratio_ge6', placebo_descent: 'descent_1000' };
const log = (...a) => console.error(...a);

/* --------------------------------------------------------- deterministic RNG */
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/* ------------------------------------------------------------------ io */
function readMaybeGz(f) {
  const b = fs.readFileSync(f);
  return /\.gz$/.test(f) ? zlib.gunzipSync(b).toString('utf8') : b.toString('utf8');
}
const num = v => { if (v == null || v === '' || v === 'NA' || v === 'nan' || v === 'NaN') return null; const x = +v; return isFinite(x) ? x : null; };
const truthy = v => /^(true|1|t)$/i.test(String(v == null ? '' : v).trim());

function loadSchedules() {
  const bySeason = {};
  for (let y = REPLAY_FROM; y <= TO; y++) {
    const f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
    if (!fs.existsSync(f)) continue;
    bySeason[y] = RR.readCsv(f).map(r => ({
      game_id: String(r.game_id), season: num(r.season), start_date: r.start_date,
      neutral_site: truthy(r.neutral_site), venue_id: num(r.venue_id),
      home_team: r.home_team, away_team: r.away_team, home_id: num(r.home_id), away_id: num(r.away_id),
      home_division: r.home_division, away_division: r.away_division
    }));
  }
  return bySeason;
}

/* the research package's lagged play load, keyed by game id: the VISITOR's
   defensive plays faced per game, averaged over its EARLIER games that season */
function parseCsvText(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length === head.length).map(r => { const o = {}; head.forEach((h, j) => { o[h] = r[j]; }); return o; });
}

function playLoad(file) {
  if (!file || !fs.existsSync(String(file))) return null;
  const rows = parseCsvText(readMaybeGz(String(file)));
  if (!rows.length || !('vd_plays' in rows[0]) || !('date' in rows[0])) { log('[altitude] panel lacks play-load columns; skipped'); return null; }
  const games = rows.filter(r => truthy(r.pbp_ok)).map(r => ({ game_id: String(r.game_id), season: num(r.season),
    day: String(r.date).slice(0, 10), home: num(r.home_id), away: num(r.away_id), vd: num(r.vd_plays), hd: num(r.hd_plays) }));
  const byTeam = {}, byOff = {};
  games.forEach(g => {
    /* vd = plays the visitor's defence faced = the home offence's plays */
    if (g.vd != null) (byOff[g.season + '|' + g.home] = byOff[g.season + '|' + g.home] || []).push({ day: g.day, plays: g.vd, game_id: g.game_id });
    if (g.hd != null) (byOff[g.season + '|' + g.away] = byOff[g.season + '|' + g.away] || []).push({ day: g.day, plays: g.hd, game_id: g.game_id });
    if (g.vd != null) (byTeam[g.season + '|' + g.away] = byTeam[g.season + '|' + g.away] || []).push({ day: g.day, plays: g.vd, game_id: g.game_id });
    if (g.hd != null) (byTeam[g.season + '|' + g.home] = byTeam[g.season + '|' + g.home] || []).push({ day: g.day, plays: g.hd, game_id: g.game_id });
  });
  return {
    seasons: [Math.min.apply(null, games.map(g => g.season)), Math.max.apply(null, games.map(g => g.season))],
    /* strictly EARLIER calendar days (the panel's dates are America/Chicago
       days) and never the game itself: a same-day game is not prior */
    visitorLoad(season, teamId, gameId, kickMs) {
      const list = byTeam[season + '|' + teamId];
      if (!list) return null;
      const day = new Date(kickMs - 6 * 3600e3).toISOString().slice(0, 10);
      const prior = list.filter(x => x.day < day && x.game_id !== String(gameId));
      if (prior.length < 2) return null;
      return prior.reduce((s, x) => s + x.plays, 0) / prior.length;
    },
    /* the HOME team's offensive plays per game, season to date: what an
       opposing defence faces from it (its pace) */
    offencePace(season, teamId, gameId, kickMs) {
      const list = byOff[season + '|' + teamId];
      if (!list) return null;
      const day = new Date(kickMs - 6 * 3600e3).toISOString().slice(0, 10);
      const prior = list.filter(x => x.day < day && x.game_id !== String(gameId));
      if (prior.length < 2) return null;
      return prior.reduce((s, x) => s + x.plays, 0) / prior.length;
    }
  };
}

/* ------------------------------------------------------------ the panel */
function buildPanel() {
  log('[altitude] replaying the shipped V1 engine ' + REPLAY_FROM + '-' + TO + ' (cold, kickoff order)…');
  const rep = RR.replayRows({ data: DATA, from: FROM, to: TO, replayFrom: REPLAY_FROM });
  log('[altitude] ' + rep.rows.length + ' projected games; refused ' + rep.refused + '; model ' + rep.model_version);
  const sched = loadSchedules();
  const byId = {};
  Object.keys(sched).forEach(y => sched[y].forEach(r => { byId[r.game_id] = r; }));
  const indexBySeason = {};
  const indexFor = s => indexBySeason[s] || (indexBySeason[s] = A.teamIndex((sched[s - 1] || []).concat(sched[s] || []), FBS.normKey));
  const PL = playLoad(PANEL);
  const panel = [];
  let noSched = 0;
  rep.rows.forEach(r => {
    const g = byId[String(r.game_id)];
    if (!g) { noSched++; return; }
    const ctx = A.context({ game_id: g.game_id, season: g.season, start_date: g.start_date, neutral_site: g.neutral_site,
      venue_id: g.venue_id, home_team: g.home_team, away_team: g.away_team },
    { registry: REGISTRY, index: indexFor(g.season), normKey: FBS.normKey });
    const load = PL ? PL.visitorLoad(g.season, g.away_id, g.game_id, Date.parse(g.start_date)) : null;
    const pace = PL ? PL.offencePace(g.season, g.home_id, g.game_id, Date.parse(g.start_date)) : null;
    const extra = {                                                   /* fixed centring constants, declared before any fit */
      total_c: r.total != null ? (r.total - 55) / 10 : null,
      def_load_c: load != null ? (load - 70) / 10 : null,
      opp_pace_c: pace != null ? (pace - 70) / 10 : null
    };
    const x = A.features(ctx, extra);
    panel.push({
      game_id: String(r.game_id), season: r.season, week: r.week, kick: r.kick, home: r.home, away: r.away,
      neutral: !!g.neutral_site, venue_id: g.venue_id,
      fair: r.fair, sigma: r.sigma, total: r.total, p_home: r.p_home,
      open: r.open, close: r.close, margin: r.margin, resid: r.margin - r.fair,
      usable: !!(ctx.quality && ctx.quality.usable), x: x,
      gain: ctx.away.gain_ft, home_gain: ctx.home.gain_ft, bucket: ctx.away.bucket,
      ratio_ge6: ctx.away.ratio_ge6, venue_elev: ctx.venue ? ctx.venue.elev_ft : null,
      venue_conf: ctx.venue ? ctx.venue.confidence : null,
      resident_high: ctx.away.acclimatization.resident_high, recent_high: ctx.away.acclimatization.recent_high_exposure,
      distance: ctx.away.distance_mi, tz: ctx.away.tz_change_h, rest_diff: ctx.rest_diff,
      host_high: !g.neutral_site && ctx.venue && ctx.venue.elev_ft >= 3000 ? 1 : 0,
      missing: ctx.missing
    });
  });
  return { panel, replay: { n: rep.rows.length, refused: rep.refused, model_version: rep.model_version, replay_from: REPLAY_FROM, no_schedule: noSched }, playLoad: PL ? PL.seasons : null };
}

/* ------------------------------------------------------- linear algebra */
function solve(M, v) {                          /* Gaussian elimination with partial pivoting */
  const n = v.length, a = M.map((row, i) => row.slice().concat([v[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}
function inverse(M) {
  const n = M.length, cols = [];
  for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; const c = solve(M, e); if (!c) return null; cols.push(c); }
  return M.map((_, i) => cols.map(c => c[i]));
}
function design(rows, feats) {
  const X = [], y = [], cl = [], kept = [];
  rows.forEach(r => {
    if (!r.x) return;
    const v = [1];
    for (const f of feats) { const z = r.x[f]; if (z == null || !isFinite(z)) return; v.push(z); }
    X.push(v); y.push(r.resid); cl.push(String(r.venue_id)); kept.push(r);
  });
  return { X, y, cl, rows: kept };
}
function fit(D, lambda) {
  const k = D.X[0] ? D.X[0].length : 0;
  if (!k || D.X.length <= k) return null;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0)), Xty = new Array(k).fill(0);
  for (let i = 0; i < D.X.length; i++) {
    const x = D.X[i];
    for (let a = 0; a < k; a++) { Xty[a] += x[a] * D.y[i]; for (let b = 0; b < k; b++) XtX[a][b] += x[a] * x[b]; }
  }
  const pen = XtX.map((row, a) => row.map((v, b) => (a === b && a > 0 ? v + (lambda || 0) : v)));
  const beta = solve(pen, Xty);
  if (!beta) return null;
  return { beta, XtX, pen };
}
/* cluster-robust (CR1) covariance by host venue */
function clusterSE(D, beta, XtX) {
  const k = beta.length, inv = inverse(XtX);
  if (!inv) return null;
  const meat = Array.from({ length: k }, () => new Array(k).fill(0)), byC = {};
  for (let i = 0; i < D.X.length; i++) {
    const u = D.y[i] - D.X[i].reduce((s, v, j) => s + v * beta[j], 0);
    const s = byC[D.cl[i]] || (byC[D.cl[i]] = new Array(k).fill(0));
    for (let j = 0; j < k; j++) s[j] += D.X[i][j] * u;
  }
  const Gc = Object.keys(byC).length, n = D.X.length;
  Object.values(byC).forEach(s => { for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) meat[a][b] += s[a] * s[b]; });
  const adj = Gc / Math.max(Gc - 1, 1) * (n - 1) / Math.max(n - k, 1);
  const V = inv.map((row, a) => row.map((_, b) => { let t = 0; for (let c = 0; c < k; c++) for (let d = 0; d < k; d++) t += inv[a][c] * meat[c][d] * inv[d][b]; return adj * t; }));
  return { se: V.map((row, i) => Math.sqrt(Math.max(row[i], 0))), clusters: Gc };
}
/* wild cluster bootstrap-t (Rademacher, null imposed) p-value for coefficient j */
function wildP(D, j, B, seed) {
  const R = rng(seed), clusters = Array.from(new Set(D.cl)), ci = D.cl.map(c => clusters.indexOf(c));
  const tstat = (y) => {
    const f = fit({ X: D.X, y, cl: D.cl }, 0); if (!f) return null;
    const s = clusterSE({ X: D.X, y, cl: D.cl }, f.beta, f.XtX); return s ? f.beta[j] / s.se[j] : null;
  };
  const t0 = tstat(D.y);
  const Xr = D.X.map(r => r.filter((_, c) => c !== j));
  const fr = fit({ X: Xr, y: D.y, cl: D.cl }, 0);
  if (!fr || t0 == null) return null;
  const fitted = Xr.map(r => r.reduce((s, v, c) => s + v * fr.beta[c], 0));
  const ur = D.y.map((v, i) => v - fitted[i]);
  let ext = 0, done = 0;
  for (let b = 0; b < B; b++) {
    const w = clusters.map(() => (R() < 0.5 ? -1 : 1));
    const t = tstat(fitted.map((v, i) => v + ur[i] * w[ci[i]]));
    if (t == null) continue;
    done++; if (Math.abs(t) >= Math.abs(t0)) ext++;
  }
  return done ? ext / done : null;
}

/* ------------------------------------------------------------ one candidate fit */
function seasonsOf(rows) { return Array.from(new Set(rows.map(r => r.season))).sort(); }
function predictAdj(r, feats, coef) {
  if (!r.x) return 0;
  let s = 0;
  for (let i = 0; i < feats.length; i++) { const z = r.x[feats[i]]; if (z == null || !isFinite(z)) return 0; s += coef[i] * z; }
  return Math.max(-CAP, Math.min(CAP, s));
}
/* the ridge penalty, chosen INSIDE the training seasons by forward chaining:
   each of the last three training seasons is predicted from the ones before it */
function chooseLambda(train, feats) {
  const ss = seasonsOf(train);
  const folds = ss.slice(-3);
  let best = null;
  LAMBDAS.forEach(lam => {
    let sse = 0, n = 0;
    folds.forEach(fs => {
      const tr = train.filter(r => r.season < fs), te = train.filter(r => r.season === fs);
      const f = fit(design(tr, feats), lam); if (!f) return;
      te.forEach(r => { if (!r.x) return; const e = r.resid - predictAdj(r, feats, f.beta.slice(1)); sse += e * e; n++; });
    });
    if (n && (best == null || sse / n < best.mse - 1e-12)) best = { lambda: lam, mse: sse / n };
  });
  return best ? best.lambda : 0;
}
/* OLS for inference, ridge for the estimate, then an uncertainty shrink of
   t^2 / (1 + t^2) per coefficient: an effect measured at one standard error
   keeps half its size, at three keeps 90%. */
function support(rows, f) {
  const nz = rows.filter(r => r.x && r.x[f] != null && r.x[f] !== 0);
  return { games: nz.length, clusters: new Set(nz.map(r => r.venue_id)).size };
}
function fitCandidate(train, feats, opts) {
  opts = opts || {};
  const pool = train.filter(r => !r.neutral && r.usable && feats.every(f => r.x && r.x[f] != null));
  /* THE MINIMUM-SUPPORT RULE (gates.js MIN_SUPPORT): an unsupported term is
     held at zero and reported, never fitted on a handful of games */
  const sup = feats.map(f => support(pool, f));
  const ok = feats.map((f, i) => sup[i].games >= G.MIN_SUPPORT.games && sup[i].clusters >= G.MIN_SUPPORT.clusters);
  const use = feats.filter((_, i) => ok[i]);
  if (!use.length) return null;
  const D = design(pool, use);
  const o = fit(D, 0); if (!o) return null;
  const se = clusterSE(D, o.beta, o.XtX);
  const lam = opts.lambda != null ? opts.lambda : chooseLambda(pool, use);
  const rf = fit(D, lam) || o;
  const expand = (arr) => { let j = 0; return feats.map((_, i) => (ok[i] ? arr[j++] : 0)); };
  const olsU = o.beta.slice(1), seU = se ? se.se.slice(1) : use.map(() => null);
  const tU = use.map((_, i) => (seU[i] > 0 ? olsU[i] / seU[i] : 0));
  const shrinkU = tU.map(z => (z * z) / (1 + z * z));
  const finalU = rf.beta.slice(1).map((b, i) => b * shrinkU[i]);
  return {
    n: D.X.length, clusters: se ? se.clusters : null, lambda: lam,
    intercept: o.beta[0], intercept_se: se ? se.se[0] : null,
    ols: expand(olsU), se: expand(seU).map((v, i) => (ok[i] ? v : null)), t: expand(tU),
    ridge: expand(rf.beta.slice(1)), shrink: expand(shrinkU), final: expand(finalU),
    support: feats.map((f, i) => ({ feature: f, games: sup[i].games, clusters: sup[i].clusters, fitted: ok[i] })),
    treated: D.rows.filter(r => use.some(f => r.x[f] !== 0)).length,
    design: D, used: use
  };
}

/* ------------------------------------------------------------ metrics */
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r3 = x => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r4 = x => (x == null || !isFinite(x) ? null : Math.round(x * 10000) / 10000);
function errorStats(rows, key) {
  const e = rows.map(r => r.margin - r[key]);
  return { n: e.length, mae: r3(mean(e.map(Math.abs))), rmse: r3(Math.sqrt(mean(e.map(v => v * v)) || 0)), bias: r3(mean(e)) };
}
function probStats(rows, key) {
  const w = rows.filter(r => r.margin !== 0 && r.sigma > 0);
  if (!w.length) return { n: 0 };
  const ps = w.map(r => Math.min(1 - 1e-6, Math.max(1e-6, normCdf(r[key] / r.sigma))));
  const ys = w.map(r => (r.margin > 0 ? 1 : 0));
  const brier = mean(ps.map((p, i) => (p - ys[i]) * (p - ys[i])));
  const ll = mean(ps.map((p, i) => -(ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p))));
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  ps.forEach((p, i) => { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += ys[i]; });
  const ece = bins.reduce((s, b) => s + (b.n ? b.n * Math.abs(b.p / b.n - b.y / b.n) : 0), 0) / ps.length;
  return { n: w.length, brier: r4(brier), log_loss: r4(ll), ece: r4(ece), mean_p: r4(mean(ps)), mean_y: r4(mean(ys)) };
}
/* paired test and a host-venue cluster bootstrap for the difference in MAE */
function paired(rows, aKey, bKey, R, B) {
  const d = rows.map(r => Math.abs(r.margin - r[bKey]) - Math.abs(r.margin - r[aKey]));     /* + = arm better */
  const n = d.length; if (n < 3) return { n, delta_mae: null };
  const m = mean(d), sd = Math.sqrt(d.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1));
  const z = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const byV = {};
  rows.forEach((r, i) => { (byV[r.venue_id] = byV[r.venue_id] || []).push(d[i]); });
  const vs = Object.keys(byV), boots = [];
  for (let b = 0; b < B; b++) {
    let s = 0, c = 0;
    for (let i = 0; i < vs.length; i++) { const v = byV[vs[Math.floor(R() * vs.length)]]; for (const x of v) { s += x; c++; } }
    boots.push(c ? s / c : 0);
  }
  boots.sort((a, b) => a - b);
  return { n, mae_improvement: r4(m), p: r4(p), ci95: [r4(boots[Math.floor(0.025 * B)]), r4(boots[Math.floor(0.975 * B) - 1])], clusters: vs.length };
}
/* against the close: the side a projection prefers, graded on the number */
function ats(rows, key) {
  const w = rows.filter(r => r.close != null && r.margin !== r.close && Math.abs(r[key] - r.close) > 1e-9);
  const wins = w.filter(r => Math.sign(r.margin - r.close) === Math.sign(r[key] - r.close)).length;
  return { n: w.length, wins, win_pct: w.length ? r3(100 * wins / w.length) : null };
}
/* THE CLOSING-LINE QUESTION, asked of the adjustment itself: between the
   opener and the close, did the market move the way the altitude term
   leans? A term that anticipates the move carries information the opener
   lacked; one that does not is, at best, already in the price. */
function lineMove(rows) {
  const w = rows.filter(r => r.open != null && r.close != null && Math.abs(r.adj) > 1e-9);
  if (!w.length) return { n: 0 };
  const toward = w.map(r => (r.close - r.open) * Math.sign(r.adj));
  const moved = w.filter(r => r.close !== r.open);
  return { n: w.length, moved: moved.length,
    toward_pct: moved.length ? r3(100 * moved.filter(r => (r.close - r.open) * Math.sign(r.adj) > 0).length / moved.length) : null,
    mean_points_toward: r3(mean(toward)) };
}
function meanCI(vals, clusters, R, B) {
  const n = vals.length; if (!n) return { n: 0 };
  const m = mean(vals), byC = {};
  vals.forEach((v, i) => { (byC[clusters[i]] = byC[clusters[i]] || []).push(v); });
  const cs = Object.keys(byC), boots = [];
  for (let b = 0; b < B; b++) { let s = 0, c = 0; for (let i = 0; i < cs.length; i++) { for (const x of byC[cs[Math.floor(R() * cs.length)]]) { s += x; c++; } } boots.push(c ? s / c : 0); }
  boots.sort((a, b) => a - b);
  return { n, mean: r3(m), ci95: [r3(boots[Math.floor(0.025 * B)]), r3(boots[Math.floor(0.975 * B) - 1])], clusters: cs.length };
}

/* ------------------------------------------------------------- walk-forward */
function walkForward(panel, cid, seasons, opts) {
  opts = opts || {};
  const feats = A.CANDIDATES[cid].features;
  const out = [], fits = [];
  for (const S of seasons) {
    const train = panel.filter(r => r.season >= FROM && r.season < S);
    const test = panel.filter(r => r.season === S && !r.neutral);
    if (!train.length || !test.length) continue;
    /* THE LEAKAGE ASSERTION: every training game kicked off before every test game's season */
    const lastTrain = Math.max.apply(null, train.map(r => r.kick)), firstTest = Math.min.apply(null, test.map(r => r.kick));
    if (!(lastTrain < firstTest)) throw new Error('leakage: a training game kicks off after the test season starts (' + S + ')');
    const f = fitCandidate(train, feats, opts);
    if (!f) continue;
    fits.push({ season: S, final: f.final, ols: f.ols, se: f.se, lambda: f.lambda, n: f.n });
    test.forEach(r => {
      const adj = r.usable ? predictAdj(r, feats, f.final) : 0;
      out.push(Object.assign({}, r, { adj, arm: r.fair + adj, affected: Math.abs(adj) > 1e-9 }));
    });
  }
  return { rows: out, fits };
}

function evaluateWindow(rows, R) {
  const aff = rows.filter(r => r.affected);
  const perSeason = seasonsOf(rows).map(s => {
    const a = aff.filter(r => r.season === s);
    const eb = errorStats(a, 'fair'), ea = errorStats(a, 'arm');
    return { season: s, n: a.length, mae_before: eb.mae, mae_after: ea.mae };
  });
  return {
    all: { n: rows.length, baseline: errorStats(rows, 'fair'), arm: errorStats(rows, 'arm'),
      prob_baseline: probStats(rows, 'fair'), prob_arm: probStats(rows, 'arm'),
      paired: paired(rows, 'arm', 'fair', R, NBOOT) },
    affected: { n: aff.length, baseline: errorStats(aff, 'fair'), arm: errorStats(aff, 'arm'),
      prob_baseline: probStats(aff, 'fair'), prob_arm: probStats(aff, 'arm'),
      paired: paired(aff, 'arm', 'fair', R, NBOOT), per_season: perSeason,
      ats_baseline: ats(aff, 'fair'), ats_arm: ats(aff, 'arm'),
      line_move: lineMove(aff),
      mean_adj: r3(mean(aff.map(r => r.adj))) }
  };
}

/* ------------------------------------------------------------- subgroups */
function subgroups(panel, R) {
  const base = panel.filter(r => !r.neutral && r.usable);
  const defs = [
    ['all non-neutral', r => true],
    ['gain >= 3,000 ft', r => r.bucket === 'high_gain'],
    ['gain 1,000-2,999 ft', r => r.bucket === 'moderate_gain'],
    ['level (within 1,000 ft)', r => r.bucket === 'level'],
    ['descent 1,000-2,999 ft', r => r.bucket === 'descent'],
    ['descent >= 3,000 ft', r => r.bucket === 'large_descent'],
    ['ratio >= 6x (any gain)', r => r.ratio_ge6 === true],
    ['ratio >= 6x and gain < 1,000 ft', r => r.ratio_ge6 === true && r.gain < 1000],
    ['ratio >= 6x and gain >= 3,000 ft', r => r.ratio_ge6 === true && r.gain >= 3000],
    ['gain >= 3,000 ft, ratio < 6x', r => r.bucket === 'high_gain' && r.ratio_ge6 === false],
    ['gain >= 3,000 ft, visitor lives >= 3,000 ft', r => r.bucket === 'high_gain' && r.resident_high === true],
    ['host venue >= 3,000 ft (any visitor)', r => r.host_high === 1],
    ['host >= 3,000 ft, visitor gain < 1,000 ft', r => r.host_high === 1 && r.gain < 1000]
  ];
  return defs.map(([label, fn]) => {
    const s = base.filter(fn);
    const withClose = s.filter(r => r.close != null);
    const mkt = withClose.map(r => r.margin - r.close);
    const covers = withClose.filter(r => r.margin !== r.close);
    const vc = covers.filter(r => r.margin < r.close).length;
    const z = covers.length ? (vc - covers.length / 2) / Math.sqrt(covers.length / 4) : null;
    return {
      group: label, n: s.length, seasons: s.length ? [Math.min(...s.map(r => r.season)), Math.max(...s.map(r => r.season))] : null,
      host_venues: new Set(s.map(r => r.venue_id)).size,
      v1_residual: meanCI(s.map(r => r.resid), s.map(r => r.venue_id), R, NBOOT),
      v1_mae: errorStats(s, 'fair').mae,
      close_n: withClose.length,
      close_residual: meanCI(mkt, withClose.map(r => r.venue_id), R, NBOOT),
      close_mae: withClose.length ? errorStats(withClose, 'close').mae : null,
      visitor_cover_pct: covers.length ? r3(100 * vc / covers.length) : null,
      visitor_cover_n: covers.length,
      /* two-sided, against 50%, games treated as independent (no clustering) */
      visitor_cover_p: z == null ? null : r4(2 * (1 - normCdf(Math.abs(z))))
    };
  });
}

/* ------------------------------------------------------------- the run */
function main() {
  const t0 = Date.now();
  const R = rng(7);
  const built = buildPanel();
  const panel = built.panel;
  const nn = panel.filter(r => !r.neutral);
  const coverage = {
    games: panel.length, non_neutral: nn.length, neutral: panel.length - nn.length,
    usable_non_neutral: nn.filter(r => r.usable).length,
    usable_share_confirm: r4(nn.filter(r => r.season >= CONF[0] && r.usable).length / Math.max(1, nn.filter(r => r.season >= CONF[0]).length)),
    with_close: panel.filter(r => r.close != null).length,
    with_open: panel.filter(r => r.open != null).length,
    high_gain_games: nn.filter(r => r.usable && r.bucket === 'high_gain').length,
    high_gain_hosts: Array.from(new Set(nn.filter(r => r.usable && r.bucket === 'high_gain').map(r => r.venue_id))).length,
    unusable_reasons: (() => { const c = {}; nn.filter(r => !r.usable).forEach(r => (r.missing.length ? r.missing : ['unknown']).forEach(m => { const k = m.replace(/\d+/g, '#'); c[k] = (c[k] || 0) + 1; })); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12); })(),
    by_season: seasonsOf(nn).map(s => ({ season: s, games: nn.filter(r => r.season === s).length,
      usable: nn.filter(r => r.season === s && r.usable).length, high_gain: nn.filter(r => r.season === s && r.usable && r.bucket === 'high_gain').length,
      with_close: nn.filter(r => r.season === s && r.close != null).length }))
  };
  log('[altitude] panel ' + panel.length + ' games, ' + coverage.usable_non_neutral + ' usable non-neutral, ' + coverage.high_gain_games + ' with 3,000+ ft gain');

  /* -------- full-sample inference, every candidate (2006-2025) -------- */
  const full = {};
  Object.keys(A.CANDIDATES).forEach(cid => {
    const feats = A.CANDIDATES[cid].features;
    const sample = panel.filter(r => r.season >= FROM && !r.neutral && r.usable && feats.every(f => r.x && r.x[f] != null));
    const f = fitCandidate(sample, feats);
    if (!f) { full[cid] = { fitted: false }; return; }
    const j = 1 + f.used.indexOf(MAIN[cid]);
    const wp = j > 0 && (A.CANDIDATES[cid].eligible || ['ratio6', 'placebo_descent', 'cat_3000_travel'].indexOf(cid) >= 0) ? wildP(f.design, j, NWILD, 11) : null;
    full[cid] = {
      fitted: true, label: A.CANDIDATES[cid].label, eligible: A.CANDIDATES[cid].eligible,
      why_ineligible: A.CANDIDATES[cid].why_ineligible || null,
      n: f.n, clusters: f.clusters, treated: f.treated,
      seasons: [Math.min(...sample.map(r => r.season)), Math.max(...sample.map(r => r.season))],
      intercept: r3(f.intercept), intercept_se: r3(f.intercept_se),
      coefficients: feats.map((ft, i) => ({ feature: ft, fitted: f.support[i].fitted, support_games: f.support[i].games, support_venues: f.support[i].clusters,
        ols: f.support[i].fitted ? r3(f.ols[i]) : null, se: f.support[i].fitted ? r3(f.se[i]) : null,
        ci95: f.support[i].fitted && f.se[i] != null ? [r3(f.ols[i] - 1.96 * f.se[i]), r3(f.ols[i] + 1.96 * f.se[i])] : null,
        t: r3(f.t[i]), ridge: r3(f.ridge[i]), shrink: r3(f.shrink[i]), final: r3(f.final[i]) })),
      lambda: f.lambda, main: MAIN[cid], wild_p_main: wp == null ? null : r4(wp)
    };
    log('[altitude] full ' + cid + ' ' + JSON.stringify(full[cid].coefficients.map(c => [c.feature, c.ols, c.se, c.support_games])) + ' wild p ' + full[cid].wild_p_main);
  });

  /* double counting: is the "altitude" residual just mountain hosts' generic home edge? */
  const dc = (() => {
    const s = panel.filter(r => r.season >= FROM && !r.neutral && r.usable).map(r => Object.assign({}, r, { x: Object.assign({}, r.x, { host_high: r.host_high }) }));
    const a = fitCandidate(s, ['host_high'], { lambda: 0 });
    const b = fitCandidate(s, ['host_high', 'high_gain'], { lambda: 0 });
    const c = fitCandidate(s, ['host_high', 'high_gain', 'log_distance', 'abs_tz'], { lambda: 0 });
    const out = (f, feats) => feats.map((ft, i) => ({ feature: ft, ols: r3(f.ols[i]), se: r3(f.se[i]),
      ci95: f.se[i] != null ? [r3(f.ols[i] - 1.96 * f.se[i]), r3(f.ols[i] + 1.96 * f.se[i])] : null }));
    return { host_only: out(a, ['host_high']), host_plus_gain: out(b, ['host_high', 'high_gain']),
      host_gain_travel: out(c, ['host_high', 'high_gain', 'log_distance', 'abs_tz']),
      reading: 'host_high is every non-neutral game at a 3,000+ ft venue, whoever visits: a positive value would mean V1 under-prices mountain home teams generally (double counting risk for any altitude term). With both terms, high_gain is identified only by visitors to the same mountain venues who live low against those who live high. The third fit asks whether that contrast survives travel distance and time-zone controls.' };
  })();

  /* -------- walk-forward, every candidate: select on 2014-2021 -------- */
  const selSeasons = [], confSeasons = [];
  for (let s = SEL[0]; s <= SEL[1]; s++) selSeasons.push(s);
  for (let s = CONF[0]; s <= CONF[1]; s++) confSeasons.push(s);
  const wf = {};
  /* the travel-controlled specification is a full-sample DIAGNOSTIC: its
     controls are non-zero on every game, so dropping the intercept to form an
     adjustment would price the average trip, which is not what it asks */
  Object.keys(A.CANDIDATES).filter(cid => cid !== 'cat_3000_travel').forEach(cid => {
    const all = walkForward(panel, cid, selSeasons.concat(confSeasons));
    const sel = all.rows.filter(r => r.season <= SEL[1]), conf = all.rows.filter(r => r.season >= CONF[0]);
    wf[cid] = { fits: all.fits.map(f => ({ season: f.season, lambda: f.lambda, final: f.final.map(r3), ols: f.ols.map(r3), se: f.se ? f.se.map(r3) : null, n: f.n })),
      select: evaluateWindow(sel, R), confirm: evaluateWindow(conf, R), pooled: evaluateWindow(all.rows, R), _rows: all.rows };
    log('[altitude] wf ' + cid + ' select dMAE(aff) ' + wf[cid].select.affected.paired.mae_improvement + ' n=' + wf[cid].select.affected.n
      + ' | confirm ' + wf[cid].confirm.affected.paired.mae_improvement + ' n=' + wf[cid].confirm.affected.n);
  });

  /* -------- selection: the eligible candidate with the best 2014-2021 affected-game improvement -------- */
  /* eligible, measured in the selection window, and every term supported in
     the full sample (a candidate whose interaction is unsupported collapses to
     a simpler one already in the field) */
  const eligible = Object.keys(A.CANDIDATES).filter(c => A.CANDIDATES[c].eligible && wf[c] && wf[c].select.affected.n > 0
    && full[c].fitted && full[c].coefficients.every(k => k.fitted));
  eligible.sort((a, b) => (wf[b].select.all.paired.mae_improvement || -1e9) - (wf[a].select.all.paired.mae_improvement || -1e9));
  const chosen = eligible[0];
  log('[altitude] selected on 2014-2021: ' + chosen);

  /* -------- placebo: permutation within season -------- */
  const feats = A.CANDIDATES[chosen].features;
  const observed = wf[chosen].pooled.all.paired.mae_improvement;
  const Rp = rng(1234), perm = [];
  for (let p = 0; p < NPERM; p++) {
    const shuffled = panel.map(r => Object.assign({}, r));
    seasonsOf(shuffled).forEach(s => {
      const idx = shuffled.map((r, i) => i).filter(i => shuffled[i].season === s && !shuffled[i].neutral && shuffled[i].usable);
      const xs = idx.map(i => shuffled[i].x);
      for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Rp() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
      idx.forEach((i, k) => { shuffled[i].x = xs[k]; });
    });
    const res = walkForward(shuffled, chosen, selSeasons.concat(confSeasons), { lambda: wf[chosen].fits.length ? wf[chosen].fits[wf[chosen].fits.length - 1].lambda : 0 });
    const d = res.rows.map(r => Math.abs(r.margin - r.fair) - Math.abs(r.margin - r.arm));
    perm.push(mean(d));
  }
  const permP = perm.length ? (perm.filter(v => v >= observed).length + 1) / (perm.length + 1) : null;
  log('[altitude] permutation p ' + permP + ' (observed ' + observed + ')');

  /* -------- venue holdouts: leave one mountain host out -------- */
  const sampleFull = panel.filter(r => r.season >= FROM && !r.neutral && r.usable);
  const hosts = {};
  sampleFull.filter(r => r.bucket === 'high_gain').forEach(r => { hosts[r.venue_id] = (hosts[r.venue_id] || 0) + 1; });
  const mainIdx = feats.indexOf(MAIN[chosen]);
  const fullFit = fitCandidate(sampleFull, feats);
  const loo = Object.keys(hosts).filter(v => hosts[v] >= 10).map(v => {
    const f = fitCandidate(sampleFull.filter(r => String(r.venue_id) !== v), feats, { lambda: fullFit.lambda });
    const held = sampleFull.filter(r => String(r.venue_id) === v).map(r => Object.assign({}, r, { adj: predictAdj(r, feats, f.final) }));
    held.forEach(r => { r.arm = r.fair + r.adj; });
    const aff = held.filter(r => Math.abs(r.adj) > 1e-9);
    const vv = REGISTRY.venues[v] || {};
    return { venue_id: +v, venue: vv.name || null, elev_ft: vv.elev_ft != null ? Math.round(vv.elev_ft) : null, high_gain_games: hosts[v],
      coef_without: r3(f.ols[mainIdx]), final_without: r3(f.final[mainIdx]),
      holdout_affected: aff.length, holdout_mae_before: errorStats(aff, 'fair').mae, holdout_mae_after: errorStats(aff, 'arm').mae };
  });
  const pooledHold = (() => {
    let sb = 0, sa = 0, n = 0;
    loo.forEach(l => { if (l.holdout_affected) { sb += l.holdout_mae_before * l.holdout_affected; sa += l.holdout_mae_after * l.holdout_affected; n += l.holdout_affected; } });
    return n ? { n, mae_before: r3(sb / n), mae_after: r3(sa / n), improvement: r3((sb - sa) / n) } : null;
  })();

  /* -------- the gates -------- */
  const cw = wf[chosen].confirm;
  const promote = PROMOTE.evaluate(
    { feature: 'cfb_altitude_' + chosen, per_season: cw.affected.per_season, spread_mae: cw.affected.arm.mae,
      paired: { p: cw.affected.paired.p }, brier: cw.affected.prob_arm.brier, leakage_clean: true, coefficient: null },
    { spread_mae: cw.affected.baseline.mae, brier: cw.affected.prob_baseline.brier });
  const signs = wf[chosen].fits.map(f => Math.sign(f.final[mainIdx] || f.ols[mainIdx]));
  const fullSign = Math.sign(fullFit.ols[mainIdx]);
  const descent = full.placebo_descent && full.placebo_descent.coefficients ? full.placebo_descent.coefficients[0] : null;
  const gates = [
    { id: 'G1_promotion_rules_on_affected_games', pass: promote.status === 'VALIDATED',
      evidence: { status: promote.status, failed: promote.conditions_failed, reasons: promote.reasons, effect: promote.effect_size, p: promote.p_value, brier_delta: promote.brier_delta } },
    { id: 'G2_confirmation_sample', pass: cw.affected.n >= G.GATES[1].min_games, evidence: { affected_games: cw.affected.n } },
    { id: 'G3_global_no_harm', pass: (cw.all.arm.mae - cw.all.baseline.mae) <= G.GATES[2].max_mae_harm && (cw.all.prob_arm.brier - cw.all.prob_baseline.brier) <= G.GATES[2].max_brier_harm,
      evidence: { mae_delta: r4(cw.all.arm.mae - cw.all.baseline.mae), brier_delta: r4(cw.all.prob_arm.brier - cw.all.prob_baseline.brier) } },
    { id: 'G4_permutation_placebo', pass: permP != null && permP < G.GATES[3].p_max, evidence: { p: r4(permP), observed_improvement: observed, shuffles: perm.length } },
    { id: 'G5_descent_placebo', pass: !!descent && descent.ci95 && descent.ci95[0] <= 0 && descent.ci95[1] >= 0, evidence: descent },
    { id: 'G6_venue_robustness', pass: loo.length > 0 && loo.every(l => Math.sign(l.coef_without) === fullSign) && !!pooledHold && pooledHold.improvement > 0,
      evidence: { venues: loo.length, sign_flips: loo.filter(l => Math.sign(l.coef_without) !== fullSign).map(l => l.venue), pooled_holdout: pooledHold } },
    { id: 'G7_coefficient_stability', pass: signs.length > 0 && signs.filter(s => s === fullSign).length / signs.length >= G.GATES[6].min_share,
      evidence: { same_sign_share: r3(signs.filter(s => s === fullSign).length / Math.max(1, signs.length)), refits: signs.length } },
    { id: 'G8_data_coverage', pass: coverage.usable_share_confirm >= G.GATES[7].min_share, evidence: { usable_share: coverage.usable_share_confirm } }
  ];
  const allPass = gates.every(g => g.pass);
  const status = allPass ? 'VALIDATED' : (promote.status === 'REJECTED' ? 'REJECTED' : (promote.status === 'CANDIDATE' ? 'CANDIDATE' : 'RESEARCH_ONLY'));
  const mainFull = full[chosen].coefficients[mainIdx];
  const catFull = full.cat_3000.coefficients[0];
  const supportState = allPass ? 'SUPPORTED' : ((full.cat_3000.wild_p_main != null && full.cat_3000.wild_p_main < 0.10 && catFull.ols > 0) ? 'SUGGESTIVE' : 'NOT_ESTABLISHED');
  const fmt = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
  const supportText = (supportState === 'SUPPORTED' ? 'Supported: ' : (supportState === 'SUGGESTIVE' ? 'Suggestive, not established: ' : 'Not established: '))
    + 'in ' + full.cat_3000.n.toLocaleString('en-US') + ' FBS home games ' + full.cat_3000.seasons.join('–')
    + ', home teams hosting a visitor that climbed 3,000+ ft beat EdgeDesk’s pregame number by ' + fmt(catFull.ols)
    + ' pts more than other home teams (95% CI ' + fmt(catFull.ci95[0]) + ' to ' + fmt(catFull.ci95[1]) + '; '
    + full.cat_3000.treated + ' games at ' + coverage.high_gain_hosts + ' venues). '
    + (allPass ? 'The adjustment improved out-of-sample predictions and passed every gate.'
      : 'Out of sample the adjustment did not pass its validation gates, so it moves 0 points.');

  const validation = {
    schema: 'edgedesk_cfb_altitude_validation_v1',
    generated_at: new Date().toISOString(),
    declared_gates: G.DECLARED, windows: G.WINDOWS,
    baseline: { engine: 'football/cfb_p4/engine.js (V1, shipped) replayed cold by football/cfb_p4/research/replay_rows.js', replay: built.replay,
      note: 'the replay passes no venue geometry, so V1’s home field is its 4.082-pt league constant and travel is 0 — exactly the shipped behaviour for the components that move the number' },
    market: { source: 'sportsdataverse/cfbfastR-data betting/csv/cfb_line_odds.csv.gz via football/cfb_p4/research/build_market.py (cfb_market_orientation_v2)',
      lines: 'consensus median across books; opening and closing as the archive labels them. No per-quote timestamps exist in the archive, so "closing" is the archive’s final number, not a verified kickoff-minute quote.',
      licence: 'a public archive this repository already uses; the underlying sportsbook data’s licence terms are not stated by the archive and were not independently verified', coverage: { with_close: coverage.with_close, with_open: coverage.with_open } },
    coverage, play_load_seasons: built.playLoad,
    full_sample: full, double_counting: dc,
    walk_forward: Object.fromEntries(Object.keys(wf).map(c => [c, { fits: wf[c].fits, select: wf[c].select, confirm: wf[c].confirm, pooled: wf[c].pooled }])),
    selected: chosen,
    selection_rule: 'the eligible candidate with the largest pooled MAE improvement over ALL non-neutral games in the 2014-2021 walk-forward; 2022-2025 was not consulted',
    placebo: { permutation: { p: r4(permP), observed: observed, shuffles: perm.length,
      null_q: perm.length ? [0.05, 0.5, 0.95].map(q => r4(perm.slice().sort((a, b) => a - b)[Math.floor(q * (perm.length - 1))])) : null },
      descent: descent },
    venue_holdouts: { leave_one_out: loo, pooled: pooledHold },
    subgroups: subgroups(panel, R),
    gates, status, points_applied: status === 'VALIDATED',
    support_state: supportState, support_text: supportText,
    runtime_s: Math.round((Date.now() - t0) / 1000)
  };

  /* the live shadow uses the selected candidate fitted on every season */
  const liveFit = fitCandidate(sampleFull, feats);
  const params = {
    engine: 'edgedesk_cfb_altitude', model_version: 'cfb_altitude_v1.0.0', built_at: validation.generated_at,
    status, points_applied: status === 'VALIDATED', cap_points: CAP,
    shadow_candidate: { id: chosen, label: A.CANDIDATES[chosen].label,
      coefficients: Object.fromEntries(feats.map((f, i) => [f, r4(liveFit.final[i])])),
      ols: Object.fromEntries(feats.map((f, i) => [f, r4(liveFit.ols[i])])),
      se: Object.fromEntries(feats.map((f, i) => [f, r4(liveFit.se[i])])),
      shrink: Object.fromEntries(feats.map((f, i) => [f, r4(liveFit.shrink[i])])),
      lambda: liveFit.lambda, fitted_on: FROM + '-' + TO + ', ' + liveFit.n + ' non-neutral FBS home games',
      units: 'home-margin points; + favours the home team' },
    validation: { support_state: supportState, support_text: supportText,
      selected: chosen, gates: gates.map(g => ({ id: g.id, pass: g.pass })),
      confirm_affected: { n: cw.affected.n, mae_before: cw.affected.baseline.mae, mae_after: cw.affected.arm.mae, p: cw.affected.paired.p },
      confirm_all: { n: cw.all.n, mae_before: cw.all.baseline.mae, mae_after: cw.all.arm.mae },
      cat_3000_full_sample: { coef: catFull.ols, se: catFull.se, ci95: catFull.ci95, wild_p: full.cat_3000.wild_p_main, n: full.cat_3000.n, treated: full.cat_3000.treated },
      ratio6_full_sample: full.ratio6 && full.ratio6.coefficients ? { coef: full.ratio6.coefficients[0].ols, se: full.ratio6.coefficients[0].se, ci95: full.ratio6.coefficients[0].ci95 } : null,
      report: 'football/validation/altitude_cfb.json' },
    data_provenance: { venues: 'football/altitude/venues.json', baseline: validation.baseline.engine, market: validation.market.source },
    declared_gates: G.DECLARED
  };

  if (WRITE) {
    const P = path.join(ROOT, 'football', 'altitude', 'params.js');
    fs.writeFileSync(P, '/* GENERATED by football/altitude/research/run.js — never edit by hand. */\n'
      + '(function (root) {\n  var P = ' + JSON.stringify(params, null, 1).replace(/\n/g, '\n  ') + ';\n'
      + '  root.EDCfbAltitudeParams = P;\n  if (typeof module === \'object\' && module && module.exports) module.exports = P;\n'
      + '})(typeof window !== \'undefined\' ? window : globalThis);\n');
    fs.writeFileSync(path.join(ROOT, 'football', 'validation', 'altitude_cfb.json'), JSON.stringify(validation, null, 1) + '\n');
    fs.mkdirSync(path.join(ROOT, 'docs', 'cfb-altitude'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'cfb-altitude', 'BACKTEST.md'), require('./report.js').render(validation, params));
    log('[altitude] wrote params.js, football/validation/altitude_cfb.json and docs/cfb-altitude/BACKTEST.md');
  }
  console.log(JSON.stringify({ status, selected: chosen, support: supportState, gates: gates.map(g => [g.id, g.pass]),
    confirm_affected: params.validation.confirm_affected, cat_3000: params.validation.cat_3000_full_sample, runtime_s: validation.runtime_s }, null, 1));
}

/* --render-only: re-render docs/cfb-altitude/BACKTEST.md from the committed
   validation record, without refitting anything */
if (require.main === module && arg('render-only', false)) {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'altitude_cfb.json'), 'utf8'));
  fs.writeFileSync(path.join(ROOT, 'docs', 'cfb-altitude', 'BACKTEST.md'), require('./report.js').render(v, require(path.join(ROOT, 'football', 'altitude', 'params.js'))));
  log('[altitude] re-rendered docs/cfb-altitude/BACKTEST.md from football/validation/altitude_cfb.json');
} else if (require.main === module) main();
module.exports = { fitCandidate, design, fit, clusterSE, paired, errorStats, probStats };
