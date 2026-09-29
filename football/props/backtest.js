#!/usr/bin/env node
/* ============================================================================
   PLAYER PROPS — the walk-forward distribution backtest (DESIGN.md §8).

   For every week of a completed season, every player is projected with data
   STRICTLY BEFORE that week's first kickoff, and the realised statistic is
   scored against the projected DISTRIBUTION:

     PIT            randomised probability integral transform (uniform when
                    calibrated); its variance says too narrow (> 1/12) or too
                    wide (< 1/12)
     coverage 50    share of outcomes inside the P25–P75 band (target 50 %)
     bias, MAE      of the mean
     log score      mean log-probability of the outcome (proper)
     calibration    P(over) at synthetic lines (the projection's own P25, P50
                    and P75 + 0.5) against the observed rate, folded ≥ 50 %
     baseline       the NAIVE distribution a bettor would draw from the game
                    log — the player's own last eight games before the week,
                    a Silverman-bandwidth kernel over them — scored by log
                    score on the same rows. The model must out-score it for
                    its market to leave EXPERIMENTAL (EDProps.stageOf, V003).

   It then fits two numbers per market — a mean multiplier (Σ actual / Σ
   projected, clamped ±15 %) and a variance multiplier f (maximum log score on
   a grid) — on the FIRST half of the season and reports the SECOND half out
   of sample, before and after. The live model reads the parameters fitted on
   the whole season (football/props/<league>/calibration.json).

   What this proves: whether the distributions are honest about outcomes.
   What it does NOT prove: that EdgeDesk beats a sportsbook price — no prices
   were available historically. That is the live grading's job (grade.js).

   Conditioning: a player is scored only if he played (a prop on a player who
   does not play is void), and inactive teammates are known pregame (the
   inactive list is published 90 minutes before kickoff), so they are passed
   to the model as OUT. The per-event yard shapes are league-wide fits that
   include the tested season (a small, disclosed look-ahead in shape only).

     node football/props/backtest.js [--league nfl] [--season 2025] [--write] [--offline]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./config.js');
const M = require('./model.js');
const EDP = require(path.join(C.ROOT, 'lib', 'edgedesk_props.js'));

const MARKETS = ['pass_yds', 'pass_att', 'pass_cmp', 'pass_tds', 'pass_ints', 'pass_long', 'rush_yds', 'rush_att', 'rush_long', 'rec_yds', 'receptions', 'targets', 'rec_long', 'rush_rec_yds', 'anytime_td', 'fg_made', 'kicking_pts'];
/* who is "a player a book would post": a pregame role, never the outcome */
function roleOk(pg, pr) {
  const v = pr.volume || {};
  if (pg === 'QB') return true;
  if (pg === 'RB') return (v.carries || 0) >= 4 || (v.targets || 0) >= 2.5;
  if (pg === 'WR' || pg === 'TE') return (v.targets || 0) >= 2.5;
  if (pg === 'K') return true;
  return false;
}
function marketsFor(pg) { return M.defaultMarkets(pg).concat(pg === 'RB' || pg === 'WR' || pg === 'TE' ? ['targets'] : []).filter((m, i, a) => MARKETS.indexOf(m) >= 0 && a.indexOf(m) === i); }

function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/* one season → scored rows */
function run(ds, opts) {
  opts = opts || {};
  const season = ds.season;
  const games = ds.schedule.filter((g) => g.season === season && g.game_type === 'REG' && g.status === 'final');
  const weeks = Array.from(new Set(games.map((g) => g.week))).sort((a, b) => a - b).filter((w) => w >= (opts.from_week || 2));
  const rows = [];
  const rnd = prng(20260929);
  weeks.forEach((wk) => {
    const wg = games.filter((g) => g.week === wk);
    const cutoff = wg.map((g) => g.gameday).sort()[0];
    /* the inactives of each team, by game: played for the team earlier this season, no snaps here */
    const absent = {};
    const playedHere = {};
    wg.forEach((g) => [g.home, g.away].forEach((tm) => {
      absent[tm] = [];
      Object.values(ds.players).forEach((p) => {
        const here = p.logs.find((l) => l.gid === g.game_id && l.tm === tm);
        if (here && M.playedIn(here)) { (playedHere[g.game_id] = playedHere[g.game_id] || {})[p.id] = here; return; }
        const earlier = p.logs.some((l) => l.s === season && l.tm === tm && l.date < g.gameday && M.playedIn(l));
        if (earlier && p.team === tm) absent[tm].push(p.id);
      });
    }));
    const ctx = M.prepare(ds, cutoff, { absent, calibration: opts.calibration || null });
    wg.forEach((g) => {
      const here = playedHere[g.game_id] || {};
      const starters = {};
      [g.home, g.away].forEach((tm) => {
        let best = null; Object.keys(here).forEach((id) => { const l = here[id]; if (l.tm === tm && ds.players[id].pg === 'QB' && (!best || l.att > here[best].att)) best = id; });
        if (best) starters[tm] = { id: best, confirmed: true };
      });
      const game = Object.assign({}, g, { starters });
      Object.keys(here).forEach((id) => {
        const p = ds.players[id], l = here[id];
        if (['QB', 'RB', 'WR', 'TE', 'K'].indexOf(p.pg) < 0) return;
        const pr = M.projectPlayer(ctx, id, game, marketsFor(p.pg), { team: l.tm });
        if (!pr.ok || !roleOk(p.pg, pr)) return;
        /* his played games strictly before the week, newest first: the naive baseline's sample */
        const before = p.logs.filter((x) => x.date < cutoff && M.playedIn(x)).sort((x, z) => (x.date < z.date ? 1 : x.date > z.date ? -1 : 0)).slice(0, 8);
        Object.keys(pr.markets).forEach((m) => {
          const y = M.statOf(m, l);
          if (y == null) return;
          const hist = before.map((x) => M.statOf(m, x)).filter((v) => typeof v === 'number' && isFinite(v));
          rows.push({ week: wk, gid: g.game_id, id, pg: p.pg, market: m, y, dist: pr.markets[m].dist, u: rnd(), hist: hist.length >= 3 ? hist : null });
        });
      });
    });
    if (opts.log) opts.log('  week ' + wk + ': ' + rows.length + ' scored so far');
  });
  return rows;
}

/* ------------------------------------------------------------ scoring */
function score(rows, adj) {
  adj = adj || {};
  const by = {};
  rows.forEach((r) => {
    const a = adj[r.market] || {};
    let d = r.dist;
    if (a.mean_mult && a.mean_mult !== 1) d = EDP.scaleDist(d, a.mean_mult);
    if (a.f && a.f !== 1) d = EDP.widenDist(d, a.f);
    const g = by[r.market] || (by[r.market] = { n: 0, sp: 0, sy: 0, ae: 0, ls: 0, cov: 0, pit: [], cal: [], bn: 0, bls: 0, bmls: 0 });
    const y = Math.round(r.y), mean = EDP.mean(d), pm = Math.max(1e-9, EDP.pmfInt(d, y)), lo = EDP.cdfInt(d, y - 1);
    const pit = lo + r.u * pm;
    g.n++; g.sp += mean; g.sy += r.y; g.ae += Math.abs(r.y - mean); g.ls += Math.log(pm); g.pit.push(pit);
    if (r.hist) {
      const b = baselineDist(r.hist);
      g.bn++; g.bls += Math.log(Math.max(1e-9, EDP.pmfInt(b, y))); g.bmls += Math.log(pm);
    }
    if (pit >= 0.25 && pit <= 0.75) g.cov++;
    [0.25, 0.5, 0.75].forEach((q) => {
      const L = EDP.quantile(d, q) + 0.5, pr = EDP.probLine(d, L);
      if (!pr) return;
      g.cal.push({ p_side: pr.over, result: r.y > L ? 'WIN' : 'LOSS' });
    });
  });
  const out = {};
  Object.keys(by).sort().forEach((m) => {
    const g = by[m], mp = g.pit.reduce((a, b) => a + b, 0) / g.n;
    const pv = g.pit.reduce((a, b) => a + (b - mp) * (b - mp), 0) / g.n;
    const cal = EDP.calibration(g.cal);
    out[m] = { n: g.n, mean_pred: +(g.sp / g.n).toFixed(3), mean_actual: +(g.sy / g.n).toFixed(3), bias_pct: +(100 * (g.sp - g.sy) / Math.max(1e-9, g.sy)).toFixed(2),
      mae: +(g.ae / g.n).toFixed(3), log_score: +(g.ls / g.n).toFixed(4), cover50: +(g.cov / g.n).toFixed(4), pit_mean: +mp.toFixed(4), pit_var: +pv.toFixed(5),
      calibration: { n: cal.n, brier: cal.brier, ece: cal.ece, table: cal.table },
      baseline: g.bn ? { n: g.bn, what: 'the player\'s own last 8 games (kernel), same rows', log_score_model: +(g.bmls / g.bn).toFixed(4), log_score_baseline: +(g.bls / g.bn).toFixed(4),
        beats: g.bmls > g.bls } : null };
  });
  return out;
}
/* the naive baseline: a kernel over the player's own recent values,
   Silverman's bandwidth, floored at half a unit for small counts */
function baselineDist(values) {
  const n = values.length, mu = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mu) * (b - mu), 0) / n);
  return { family: 'empirical', values, bw: Math.max(0.5, 1.06 * sd * Math.pow(n, -0.2)) };
}
/* fit mean multiplier then variance multiplier (max log score) */
function fit(rows) {
  const by = {};
  rows.forEach((r) => { (by[r.market] = by[r.market] || []).push(r); });
  const out = {};
  Object.keys(by).forEach((m) => {
    const rs = by[m];
    if (rs.length < 60) { out[m] = { mean_mult: 1, f: 1, n: rs.length, note: 'fewer than 60 scored games: not fitted' }; return; }
    const sp = rs.reduce((a, r) => a + EDP.mean(r.dist), 0), sy = rs.reduce((a, r) => a + r.y, 0);
    /* shrunk toward 1 by sample: a half season cannot move a mean far */
    const mmRaw = sy / Math.max(1e-9, sp), mm = Math.max(0.85, Math.min(1.15, 1 + (mmRaw - 1) * rs.length / (rs.length + 1500)));
    const scaled = rs.map((r) => ({ y: Math.round(r.y), d: Math.abs(mm - 1) > 1e-6 ? EDP.scaleDist(r.dist, mm) : r.dist }));
    const ls = (f) => scaled.reduce((a, x) => a + Math.log(Math.max(1e-9, EDP.pmfInt(Math.abs(f - 1) > 1e-6 ? EDP.widenDist(x.d, f) : x.d, x.y))), 0) / scaled.length;
    let best = 1, bestLs = ls(1);
    const grid = m === 'anytime_td' || m === 'pass_tds' || m === 'pass_ints' || m === 'fg_made' ? [0.6, 0.8, 1, 1.2, 1.5, 2] : [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2.1];
    grid.forEach((f) => { if (f === 1) return; const v = ls(f); if (v > bestLs) { bestLs = v; best = f; } });
    const fShrunk = Math.exp(Math.log(best) * rs.length / (rs.length + 300));
    out[m] = { mean_mult: +mm.toFixed(4), mean_mult_raw: +mmRaw.toFixed(4), f: +fShrunk.toFixed(3), f_raw: best, n: rs.length, fit_log_score: +bestLs.toFixed(4) };
  });
  return out;
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const league = arg('league', 'nfl'), season = Number(arg('season', C.seasonOf() - 1)), write = a.indexOf('--write') >= 0;
  if (league !== 'nfl') { console.log('[props backtest] ' + league + ': the walk-forward backtest runs on the NFL feeds; college distributions use the NFL multipliers until a college backtest exists.'); return 0; }
  const L = require('./sources/nfl.js');
  const log = (s) => console.log('[props backtest] ' + s);
  log('loading ' + league + ' ' + season + ' (and ' + (season - 1) + ' as prior) …');
  const ds = await L.load({ season, offline: a.indexOf('--offline') >= 0, now: Date.UTC(season + 1, 1, 20), current_feeds: ['stats', 'pbp', 'snaps', 'roster'] });
  if (!ds.ok) { log('dataset unavailable: ' + ds.error); return 1; }
  /* the season's closing depth chart and injury file would leak the future */
  ds.depth = {}; ds.injuries = { published: false, by_player: {} }; ds.slate = null;
  const rows = run(ds, { log });
  const weeks = Array.from(new Set(rows.map((r) => r.week))).sort((x, y) => x - y);
  const mid = weeks[Math.floor(weeks.length / 2)];
  const trainRows = rows.filter((r) => r.week < mid), testRows = rows.filter((r) => r.week >= mid);
  const fitTrain = fit(trainRows);
  const report = {
    schema: 'edgedesk_props_calibration_v1', league, mode: 'BACKTEST', model_version: M.MODEL_VERSION,
    season_tested: season, weeks: [weeks[0], weeks[weeks.length - 1]], split_week: mid, generated_at: new Date().toISOString(),
    what_it_proves: 'whether the projected distributions are honest about realised outcomes (walk-forward, data strictly before each week)',
    what_it_does_not: 'that EdgeDesk beats a sportsbook price: no historical prop prices were available. Live grading (grade.js) measures that.',
    disclosure: 'inactive teammates are treated as known pregame (they are); league-wide per-event yard shapes include the tested season',
    n_scored: rows.length,
    out_of_sample: { before: score(testRows), after: score(testRows, fitTrain), fitted_on: 'weeks ' + weeks[0] + '–' + (mid - 1) },
    markets: fit(rows)
  };
  /* ADOPTION: a market's fitted adjustment is used live only if it improved
     the held-out log score; otherwise the raw distribution stands */
  Object.keys(report.markets).forEach((m) => {
    const b = report.out_of_sample.before[m], af = report.out_of_sample.after[m], k = report.markets[m];
    const better = b && af && af.log_score > b.log_score;
    k.adopted = !!better;
    k.heldout_log_score = b && af ? { before: b.log_score, after: af.log_score } : null;
    if (!better) { k.fitted = { mean_mult: k.mean_mult, f: k.f }; k.mean_mult = 1; k.f = 1; k.note = 'fit not adopted: it did not improve the held-out log score'; }
  });
  const P = C.leaguePaths(league, season);
  Object.keys(report.out_of_sample.after).forEach((m) => {
    const b = report.out_of_sample.before[m], af = report.out_of_sample.after[m];
    log(m.padEnd(13) + ' n ' + String(af.n).padStart(5) + '  bias ' + String(b.bias_pct).padStart(6) + '% → ' + String(af.bias_pct).padStart(6) + '%  cover50 ' + b.cover50 + ' → ' + af.cover50 + '  pitvar ' + b.pit_var + ' → ' + af.pit_var + '  ece ' + b.calibration.ece + ' → ' + af.calibration.ece + '  (fit f ' + report.markets[m].f + ', mean ×' + report.markets[m].mean_mult + ')');
  });
  if (write) {
    fs.mkdirSync(path.dirname(P.calibration), { recursive: true });
    fs.writeFileSync(P.calibration, JSON.stringify(report, null, 1) + '\n');
    log('wrote ' + path.relative(C.ROOT, P.calibration));
  } else log('dry run: nothing written (pass --write)');
  return 0;
}

module.exports = { run, score, fit, roleOk, baselineDist, MARKETS };
if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error('[props backtest] ' + (e.stack || e.message)); process.exit(1); });
