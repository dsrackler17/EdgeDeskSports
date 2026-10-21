#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The production NFL model (edgedesk_nfl_v2.1.0, football/nfl_params_v2.js)
   replayed walk-forward with OPENER-TIME inputs only, for the CLV programme.

   football/research/nfl_v2/backtest.js prices each game with the quarterback
   who actually started it and the game-day temperature and wind (nflverse
   games.csv). Neither is known when the opener is posted, so this replay
   changes exactly two inputs of M.features(), in training rows and predicted
   rows alike (the walk-forward ridge is refitted on the same inputs):
     * each side's QB = the QB who started that franchise's previous game;
     * temp and wind = missing (the model's own defaults: 68 F, 0 mph).
   Everything after the game (absorbing the result, the regular-starter
   bookkeeping in afterGame) still uses what actually happened, as the live
   board does. The engine, params and backtest code are read, never changed.

     node research/clv/nfl_v2_opener.js <out.csv> [actual]
   "actual" reproduces the committed results/oos_v2.csv.gz instead (check).
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'backtest.js'));
const D = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'data.js'));
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const L = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'weekly_loop.js'));

function vec(obj, names) { const v = new Array(names.length); for (let i = 0; i < names.length; i++) { const x = obj[names[i]]; v[i] = Number.isFinite(x) ? x : 0; } return v; }

function replayOpener(cfg, opener) {
  const names = M.featureNames(cfg);
  const st = M.newState(cfg);
  if (cfg.personnel.on) st.personnel = D.personnel();
  const rows = D.teamRows(cfg.source), qb = D.qbRows(), out = [];
  const last = {};
  let changed = 0;
  for (const g of D.games()) {
    if (!g.done) continue;
    if (st.season !== g.season) M.seasonBreak(st, g.season);
    if (g.season >= 2002) {
      const go = B.gameObj(g);
      if (opener) {
        go.home_qb_id = last[g.home] || null;
        go.away_qb_id = last[g.away] || null;
        if (go.home_qb_id !== g.home_qb_id || go.away_qb_id !== g.away_qb_id) changed++;
        go.temp = null;
        go.wind = null;
      }
      const F = M.features(st, go);
      out.push({ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa,
        prior: vec(F.prior, names.spread) });
    }
    const gg = { home_team: g.home_raw, away_team: g.away_raw, home_score: g.home_score, away_score: g.away_score };
    M.absorbCompleted(st, gg, rows[g.id] || [], qb[g.id] || []);
    M.afterGame(st, B.gameObj(g));
    if (g.home_qb_id) last[g.home] = g.home_qb_id;
    if (g.away_qb_id) last[g.away] = g.away_qb_id;
  }
  return { rep: { cfg, names, rows: out, state: st }, changed };
}

function main() {
  const OUT = process.argv[2];
  const opener = process.argv[3] !== 'actual';
  const PV = L.loadParams();
  const { rep, changed } = replayOpener(PV.cfg, opener);
  const wf = B.walkForward(rep);
  const lines = ['game_id,season,week,type,model_margin,model_total,p_home,close_margin,close_total,margin,total_pts'];
  wf.preds.forEach((p) => lines.push([p.id, p.season, p.week, p.type || '', p.model.toFixed(4), p.total.toFixed(4), p.p.toFixed(4),
    p.close == null ? '' : p.close, p.close_total == null ? '' : p.close_total, p.margin, p.actual_total].join(',')));
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`${PV.model_version} ${opener ? 'opener-time inputs' : 'as backtested'}: ${wf.preds.length} games; ` +
    `${changed} rows whose QB input differs from the actual starters`);
}
if (require.main === module) main();
