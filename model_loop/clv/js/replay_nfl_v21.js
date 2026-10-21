#!/usr/bin/env node
/* ============================================================================
   NFL v2.1.0 (football/nfl_model.js + football/nfl_params_v2.js cfg) priced at
   the EARLY-WEEK checkpoint, walk-forward. EXPERIMENTS.md E-001.

   Training is the production backtest's, unchanged (football/research/nfl_v2/
   backtest.js): features in kickoff order with the starters who actually played
   and the observed weather, ridge weights refitted on 2002..S-1 for season S.

   Prediction rows are what was knowable on the Tuesday before the game:
     * every game of week W is priced from the rating state at the START of
       week W (no Thursday result inside a Sunday game's features);
     * each team's quarterback is the starter of ITS PREVIOUS GAME this season
       (null for a team's first game: such games are not eligible to bet);
     * weather neutral (the model's own defaults: 68F, no wind; roof is known).

   Read-only use of the model: nothing in football/ is modified.
     node model_loop/clv/js/replay_nfl_v21.js <out.csv>
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const B = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'backtest.js'));
const D = require(path.join(ROOT, 'football', 'research', 'nfl_v2', 'data.js'));
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
require(path.join(ROOT, 'football', 'nfl_params_v2.js'));
const P = globalThis.EDNflParamsV2;

const OUT = process.argv[2] || path.join(ROOT, '.cache', 'clv', 'pred_nfl_v21.csv');
const cfg = JSON.parse(JSON.stringify(P.cfg));

function vec(obj, names) { const v = new Array(names.length); for (let i = 0; i < names.length; i++) { const x = obj[names[i]]; v[i] = Number.isFinite(x) ? x : 0; } return v; }

/* each team's previous-game starter, same season, in kickoff order */
function laggedStarters(games) {
  const last = {}, out = {};
  for (const g of games) {
    const k = (t) => g.season + '|' + t;
    out[g.id] = { home: last[k(g.home)] || null, away: last[k(g.away)] || null };
    if (g.done) { last[k(g.home)] = g.home_qb_id || null; last[k(g.away)] = g.away_qb_id || null; }
  }
  return out;
}

function main() {
  const names = M.featureNames(cfg);
  const st = M.newState(cfg);
  const rows = D.teamRows(cfg.source), qb = D.qbRows();
  const games = D.games();
  const lag = laggedStarters(games);
  const byWeek = {};
  for (const g of games) (byWeek[g.season + '|' + g.week] = byWeek[g.season + '|' + g.week] || []).push(g);
  const opened = {};
  const train = [], early = {};
  for (const g of games) {
    if (!g.done) continue;
    if (st.season !== g.season) M.seasonBreak(st, g.season);
    const wk = g.season + '|' + g.week;
    if (!opened[wk] && g.season >= B.FIRST_TRAIN) {
      opened[wk] = true;
      for (const h of byWeek[wk]) {
        const go = B.gameObj(h);
        go.home_qb_id = lag[h.id].home; go.away_qb_id = lag[h.id].away;
        go.temp = null; go.wind = null;
        const F = M.features(st, go);
        early[h.id] = { g: h, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa };
      }
    }
    if (g.season >= B.FIRST_TRAIN) {
      const F = M.features(st, B.gameObj(g));
      train.push({ g, s: vec(F.spread, names.spread), c: vec(F.ctx, names.ctx), t: vec(F.total, names.total), hfa: F.hfa });
    }
    M.absorbCompleted(st, { home_team: g.home_raw, away_team: g.away_raw, home_score: g.home_score, away_score: g.away_score }, rows[g.id] || [], qb[g.id] || []);
    M.afterGame(st, B.gameObj(g));
  }
  const seasons = [...new Set(Object.values(early).map((r) => r.g.season))].filter((s) => s >= B.FIRST_PRED).sort((a, b) => a - b);
  const lines = ['game_id,season,week,home,away,model_spread,model_total,prod_spread,home_qb_lag,away_qb_lag,home_qb_actual,away_qb_actual'];
  const prodById = {};
  for (const S of seasons) {
    const model = B.fit(cfg, train.filter((r) => r.g.season >= B.FIRST_TRAIN && r.g.season < S));
    const test = Object.values(early).filter((r) => r.g.season === S);
    const pe = B.predictRows(model, test);
    const tp = train.filter((r) => r.g.season === S);
    B.predictRows(model, tp).forEach((p, i) => { prodById[tp[i].g.id] = p.margin; });
    test.forEach((r, i) => {
      const g = r.g, l = lag[g.id];
      lines.push([g.id, g.season, g.week, g.home, g.away, pe[i].margin.toFixed(4), pe[i].total.toFixed(4),
        prodById[g.id] != null ? prodById[g.id].toFixed(4) : '', l.home || '', l.away || '', g.home_qb_id || '', g.away_qb_id || ''].join(','));
    });
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.error(`[replay_nfl_v21] ${lines.length - 1} early-week predictions (${cfg && P.model_version}) -> ${OUT}`);
}
main();
