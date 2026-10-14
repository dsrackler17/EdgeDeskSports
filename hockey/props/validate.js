#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL PROPS — the walk-forward record of the player markets.

     node hockey/props/validate.js           write hockey/validation/nhl_props.json
     node hockey/props/validate.js --check   the committed record passes its rules

   PROTOCOL (the game model's, applied to players):
     - one chronological pass; every player-game on date D is predicted from
       games on earlier dates only, then D is absorbed
     - each statistic's mean recalibration μ' = c·μ^b (model.js fitMeanCal)
       and then the shot and shots-against dispersions for season S are fitted
       by likelihood on the three seasons before S
     - windows: SELECTION 2013-14 to 2019-20 · CONFIRMATION 2020-21 to
       2025-26 · LIVE 2026-27; 2010-11 to 2012-13 are burn-in
     - participation: a prop settles only if the player plays, so every skater
       who dressed (and every starting goalie) is priced and scored; nobody
       who did not play is
   A market is OUTCOME_VALIDATED on CONFIRMATION when n ≥ 1000, |mean p −
   mean y| ≤ 0.02, calibration slope 0.85–1.15, AND it beats the naive
   baseline (the player's season-to-date average, shrunk by 10 games of his
   position's average, as a Poisson mean) with a
   block-bootstrap 95% interval wholly below zero. Market status is
   NOT_TESTED for every prop (no NHL prop prices are captured) and value
   claims stay DISABLED.

   The model's settings (hockey/props/model.js DEFAULTS) were set before this
   record was first run and were not tuned on it. The first run (2026-10-13)
   found the projections over-shrunk (calibration slopes 1.1-1.4) and goalie
   saves too high; the nested mean recalibration was added in response, after
   that run had been read on both windows (disclosed in docs/engine/NHL_PROPS.md).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const V = require('../../engine/validation');
const D = require('./data');
const M = require('./model');

const OUT = path.join(C.PATHS.validation, 'nhl_props.json');
const SCHEMA = 'edgedesk_nhl_props_walkforward_v1';
const SELECTION = [2014, 2020], CONFIRMATION = [2021, C.CURRENT_SEASON - 1], LIVE = [C.CURRENT_SEASON, C.CURRENT_SEASON];
const R_GRID = [2, 3, 4, 6, 8, 12, 20, 40, Infinity];
const SA_GRID = [10, 15, 20, 30, 45, 70, 120, Infinity];
const SKATER_LINES = { sog: [0.5, 1.5, 2.5, 3.5, 4.5], points: [0.5, 1.5], assists: [0.5] };
const SAVES_LINES = [22.5, 25.5, 28.5, 31.5]; /* each must be a line goalieMarkets prices */
function win(s) { return s >= SELECTION[0] && s <= SELECTION[1] ? 'selection' : s >= CONFIRMATION[0] && s <= CONFIRMATION[1] ? 'confirmation' : s === LIVE[0] ? 'live' : null; }
const poisGE = (mu, k) => { let c = 0, p = Math.exp(-mu); for (let i = 0; i < k; i++) { c += p; p *= mu / (i + 1); } return Math.max(0, Math.min(1, 1 - c)); };

/** likelihood-fitted NB size on earlier predictions: rows [{mu, y}] */
function fitSize(rows, grid) {
  if (rows.length < 2000) return { r: grid[Math.floor(grid.length / 2)], n: rows.length, basis: 'default: fewer than 2000 earlier predictions' };
  let best = null;
  /* K = y + 1: nbPmf folds the tail into its last cell, so the observed count must never be that cell */
  for (const r of grid) { let ll = 0; for (const x of rows) { const pmf = M.nbPmf(x.mu, r, x.y + 1); ll += Math.log(Math.max(1e-300, pmf[x.y])); } if (!best || ll > best.ll) best = { r, ll }; }
  return { r: best.r, n: rows.length, basis: 'maximum likelihood on the three seasons before' };
}

/* season-to-date baseline per player */
class Baseline {
  constructor() { this.s = new Map(); }
  /* shrunk by 10 games of the position average: an unshrunk average would price a scoreless
     start at exactly 0 and lose without limit on the first goal — a straw man, not a baseline */
  mean(id, season, k, posMean) {
    if (posMean == null) return null;
    const x = this.s.get(id); const K = 10;
    if (x && x.season === season && x.n > 0) return (x[k] + posMean * K) / (x.n + K);
    if (x && x.prev && x.prev.n > 0) return (x.prev[k] + posMean * K) / (x.prev.n + K);
    return posMean;
  }
  add(id, season, vals) {
    let x = this.s.get(id);
    if (!x || x.season !== season) { const prev = x && x.season === season - 1 ? { n: x.n, sog: x.sog, g: x.g, a: x.a, pts: x.pts, sv: x.sv } : null; x = { season, n: 0, sog: 0, g: 0, a: 0, pts: 0, sv: 0, prev }; this.s.set(id, x); }
    x.n++; for (const k of Object.keys(vals)) x[k] += vals[k] || 0;
  }
}

function main() {
  const t0 = Date.now();
  const seasons = []; for (let s = C.FIRST_SEASON; s <= C.CURRENT_SEASON; s++) seasons.push(s);
  const st = new M.PropState(); const base = new Baseline();
  const markets = {}; const add = (k, w, p, b, y, date) => { const m = markets[k] || (markets[k] = {}); const a = m[w] || (m[w] = { p: [], b: [], y: [], d: [] }); a.p.push(p); a.b.push(b); a.y.push(y); a.d.push(date); };
  const muHist = { sog: [], sa: [], g: [], a: [] }; const sizes = {}; const cals = {};
  const posAvg = { F: { sog: 0, g: 0, a: 0, pts: 0, n: 0 }, D: { sog: 0, g: 0, a: 0, pts: 0, n: 0 } }; const gAvg = { sv: 0, n: 0 };
  let scored = 0, coverage = { seasons: {} };
  for (const S of seasons) {
    const data = D.loadSeason(S);
    if (!data) { coverage.seasons[S] = 'no box-score cache'; continue; }
    const fitRows = (k) => muHist[k].filter((x) => x.season >= S - 3 && x.season < S);
    /* the mean recalibration first, then the dispersion on the recalibrated means */
    const cal = { sog: M.fitMeanCal(fitRows('sog')), g: M.fitMeanCal(fitRows('g')), a: M.fitMeanCal(fitRows('a')), sa: M.fitMeanCal(fitRows('sa')) };
    cals[S] = cal;
    const recal = (k) => fitRows(k).map((x) => ({ mu: M.applyMeanCal(x.mu, cal[k]), y: x.y }));
    const rS = fitSize(recal('sog'), R_GRID), rSA = fitSize(recal('sa'), SA_GRID);
    sizes[S] = { sog: rS, shots_against: rSA };
    coverage.seasons[S] = { skater_games: data.skaters.length, goalie_games: data.goalies.length, ixg_available: data.skaters.some((x) => x.ixg != null) };
    /* date batches */
    const byDate = new Map();
    for (const r of data.skaters) { if (!byDate.has(r.date)) byDate.set(r.date, { sk: [], gk: [], teams: {} }); byDate.get(r.date).sk.push(r); }
    for (const r of data.goalies) { if (!byDate.has(r.date)) byDate.set(r.date, { sk: [], gk: [], teams: {} }); byDate.get(r.date).gk.push(r); }
    for (const [id, t] of Object.entries(data.teams)) { const r = data.skaters.find((x) => x.game_id === Number(id)); if (r) byDate.get(r.date).teams[id] = t; }
    for (const date of [...byDate.keys()].sort()) {
      const b = byDate.get(date); const w = win(S);
      for (const r of b.sk) {
        if (r.toi == null || r.sog == null) continue;
        const pr0 = st.skater(r.player, r.pos, r.opp, r.team); if (!pr0) continue;
        muHist.sog.push({ season: S, mu: pr0.mu_sog, y: r.sog });
        if (r.g != null) muHist.g.push({ season: S, mu: pr0.mu_goals, y: r.g });
        if (r.a != null) muHist.a.push({ season: S, mu: pr0.mu_assists, y: r.a });
        const pr = Object.assign({}, pr0, { mu_sog: M.applyMeanCal(pr0.mu_sog, cal.sog), mu_goals: M.applyMeanCal(pr0.mu_goals, cal.g), mu_assists: M.applyMeanCal(pr0.mu_assists, cal.a) });
        if (w) {
          const mk = M.skaterMarkets(pr, rS.r);
          const pa = posAvg[r.pos]; const pm = (k) => (pa.n ? pa[k] / pa.n : null);
          const bm = (k) => base.mean(r.player, S, k, pm(k));
          for (const L of SKATER_LINES.sog) { const bmu = bm('sog'); if (bmu != null) add('sog_over_' + L, w, mk.sog.over[L], poisGE(bmu, Math.ceil(L)), r.sog > L ? 1 : 0, date); }
          { const bmu = bm('g'); if (bmu != null) add('goal_anytime', w, mk.goals.anytime, poisGE(bmu, 1), r.g >= 1 ? 1 : 0, date); }
          { const bmu = bm('a'); if (bmu != null) add('assists_over_0.5', w, mk.assists.over[0.5], poisGE(bmu, 1), r.a >= 1 ? 1 : 0, date); }
          for (const L of SKATER_LINES.points) { const bmu = bm('pts'); if (bmu != null) add('points_over_' + L, w, mk.points.over[L], poisGE(bmu, Math.ceil(L)), r.pts > L ? 1 : 0, date); }
          scored++;
        }
      }
      for (const r of b.gk) {
        if (!r.starter || r.sa == null || r.sv == null) continue;
        const pr0 = st.goalie(r.goalie, r.team, r.opp);
        muHist.sa.push({ season: S, mu: pr0.mu_sa, y: r.sa });
        const pr = Object.assign({}, pr0, { mu_sa: M.applyMeanCal(pr0.mu_sa, cal.sa) });
        if (w) {
          const mk = M.goalieMarkets(pr, rSA.r);
          const bmu = base.mean('g' + r.goalie, S, 'sv', gAvg.n ? gAvg.sv / gAvg.n : null);
          for (const L of SAVES_LINES) if (bmu != null) add('saves_over_' + L, w, mk.saves.over[L], poisGE(bmu, Math.ceil(L)), r.sv > L ? 1 : 0, date);
        }
      }
      /* absorb the date */
      st.absorb(b.sk, b.gk, b.teams);
      for (const r of b.sk) { if (r.toi == null) continue; base.add(r.player, S, { sog: r.sog, g: r.g, a: r.a, pts: r.pts }); const pa = posAvg[r.pos]; pa.sog += r.sog || 0; pa.g += r.g || 0; pa.a += r.a || 0; pa.pts += r.pts || 0; pa.n++; }
      for (const r of b.gk) if (r.starter && r.sv != null) { base.add('g' + r.goalie, S, { sv: r.sv }); gAvg.sv += r.sv; gAvg.n++; }
    }
    console.log('[nhl props] ' + S + ': ' + data.skaters.length + ' skater-games, ' + data.goalies.length + ' goalie-games; SOG size ' + rS.r + ', shots-against size ' + rSA.r + '; mean recal b sog ' + cal.sog.b + ' g ' + cal.g.b + ' a ' + cal.a.b + ' sa ' + cal.sa.b + '/' + cal.sa.c + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  }
  /* score */
  const out = { schema: SCHEMA, generated_at: new Date().toISOString(), protocol: { selection: SELECTION, confirmation: CONFIRMATION, live: LIVE, participation: 'priced and scored only for skaters who dressed and goalies who started (a prop is void otherwise)', baseline: 'the player\'s season-to-date average per game shrunk by 10 games of his position\'s league average (else last season\'s, shrunk the same way; else the position average), as a Poisson mean', model: 'hockey/props/model.js (settings fixed before the first run, not tuned on this record)' }, sizes, coverage, markets: {} };
  for (const [k, m] of Object.entries(markets)) {
    out.markets[k] = {};
    for (const w of ['selection', 'confirmation', 'live']) {
      const a = m[w]; if (!a) continue;
      const rows = a.p.map((p, i) => ({ p, y: a.y[i] })); const brow = a.b.map((p, i) => ({ p, y: a.y[i] }));
      const bm = V.binary(rows), bb = V.binary(brow);
      const cmp = V.pairedBootstrap(a.p.map((p, i) => ({ date: a.d[i], a: V.logLoss(p, a.y[i]), b: V.logLoss(a.b[i], a.y[i]) })), { B: 400 });
      out.markets[k][w] = { n: bm.n, log_loss: bm.log_loss, brier: bm.brier, mean_p: bm.mean_p, mean_y: bm.mean_y, calibration_in_the_large: bm.calibration_in_the_large, calibration_slope: bm.calibration_slope, baseline: { log_loss: bb.log_loss, mean_p: bb.mean_p, calibration_slope: bb.calibration_slope, brier: bb.brier }, baseline_log_loss: bb.log_loss, vs_baseline: cmp, bins: w === 'confirmation' ? bm.bins : undefined };
    }
    const c = out.markets[k].confirmation; const fails = [];
    if (!c || c.n < 1000) fails.push('n < 1000');
    else {
      if (Math.abs(c.calibration_in_the_large) > 0.02) fails.push('mean p off by ' + c.calibration_in_the_large);
      if (c.calibration_slope == null || c.calibration_slope < 0.85 || c.calibration_slope > 1.15) fails.push('calibration slope ' + c.calibration_slope);
      if (!(c.vs_baseline.ci95[1] < 0)) fails.push('does not beat the season-to-date baseline (95% ' + c.vs_baseline.ci95.join(' to ') + ')');
    }
    out.markets[k].status = fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED';
    out.markets[k].failed = fails; out.markets[k].market_status = 'NOT_TESTED';
  }
  out.value_claims = { state: 'DISABLED', reasons: ['no NHL player-prop prices are captured', 'no prop market has been tested against closing prices'] };
  out.scored_skater_games = scored;
  out.mean_recalibration_by_season = cals;
  out.live_params = { for_season: C.CURRENT_SEASON, sizes: sizes[C.CURRENT_SEASON] || null, mean_recalibration: cals[C.CURRENT_SEASON] || null, defaults: M.DEFAULTS };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  for (const [k, m] of Object.entries(out.markets)) { const c = m.confirmation || {}; console.log('  ' + k.padEnd(18) + ' ' + m.status.padEnd(18) + ' n ' + c.n + ' LL ' + c.log_loss + ' (baseline ' + c.baseline_log_loss + ', Δ ' + (c.vs_baseline && c.vs_baseline.mean_diff) + ') citl ' + c.calibration_in_the_large + ' slope ' + c.calibration_slope); }
}

function check() {
  const r = JSON.parse(fs.readFileSync(OUT, 'utf8')); const fails = [];
  if (r.schema !== SCHEMA) fails.push('schema');
  if (!r.value_claims || r.value_claims.state !== 'DISABLED') fails.push('prop value claims must stay disabled without captured prices and a market test');
  for (const [k, m] of Object.entries(r.markets || {})) { if (m.market_status !== 'NOT_TESTED') fails.push(k + ' claims a market test'); if (!/^(OUTCOME_VALIDATED|PROVISIONAL)$/.test(m.status)) fails.push(k + ' status'); }
  if (fails.length) { console.error('[nhl props --check] FAILED: ' + fails.join('; ')); process.exit(1); }
  console.log('[nhl props --check] ok: ' + Object.keys(r.markets).length + ' markets; validated: ' + Object.entries(r.markets).filter(([, m]) => m.status === 'OUTCOME_VALIDATED').map(([k]) => k).join(', '));
}

if (require.main === module) { if (process.argv.includes('--check')) check(); else main(); }
module.exports = { fitSize, Baseline, SKATER_LINES, SAVES_LINES };
