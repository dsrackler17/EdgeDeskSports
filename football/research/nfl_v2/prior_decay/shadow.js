#!/usr/bin/env node
/* ===========================================================================
   THE PRIOR-DECAY SHADOW: what the experimental variants would have said on
   this week's games not yet played. Illustration only. It never reaches a
   card, a slate or a record.

   Both models are fitted on 2002-2024 with backtest.js fit(), the fold that
   would predict 2025. No 2025 game is predicted or scored, and the holdout
   stays untouched. The rating state is then carried through every completed
   game to date (2025 and 2026 results move ratings exactly as they do on the
   board), and each Week-N game is priced from that state. Win probabilities
   read the margin PMF fitted on seasons before 2025.

   Usage: node football/research/nfl_v2/prior_decay/shadow.js [--week 7]
   Writes prior_decay/shadow_week<N>.json.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../backtest.js');
const ROOT = path.join(__dirname, '..', '..', '..', '..');
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const PV = require(path.join(ROOT, 'football', 'nfl_params_v2.js'));
const D = require('../data.js');
const R = require('./run.js');

const a = process.argv.slice(2), WEEK = Number(a[a.indexOf('--week') + 1]) || 7, SEASON = 2026;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null), r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);

function price(label, cfg) {
  const rep = B.replay(cfg);
  const model = B.fit(cfg, rep.rows.filter((r) => r.g.season >= B.FIRST_TRAIN && r.g.season <= 2024));
  const names = M.featureNames(cfg), st = rep.state;
  /* games not yet played only: the state holds every completed game, so a played game would see its own result */
  const games = D.games().filter((g) => g.season === SEASON && g.week === WEEK && !g.done);
  return games.map((g) => {
    const F = M.features(st, B.gameObj(g));
    const row = { g, s: names.spread.map((n) => (Number.isFinite(F.spread[n]) ? F.spread[n] : 0)), c: names.ctx.map((n) => (Number.isFinite(F.ctx[n]) ? F.ctx[n] : 0)), t: names.total.map((n) => (Number.isFinite(F.total[n]) ? F.total[n] : 0)), hfa: F.hfa };
    const p = B.predictRows(model, [row])[0];
    const wp = B.withTable(2025, () => E.dist.winProb('nfl', p.margin));
    const term = (k) => { const i = names.spread.indexOf(k); return i >= 0 ? r2(model.spread.w[i] * row.s[i]) : null; };
    return { game_id: g.id, matchup: g.away + ' @ ' + g.home, model: label, home_margin: r2(p.margin), home_win_prob: r4(wp),
      qb_adj_points: term('qb_adj_diff'), qb_prior_gap_points: term('qb_prior_gap'), close_home_margin: g.close_home_margin, close_no_vig_home: r4(B.marketProb(g)) };
  });
}

function main() {
  const P = R.loadPre(), S = P.studies[0];
  const res = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
  const inc = price('v1 refit on 2002-2024', M.config(PV.cfg));
  const sel = S.variants.find((v) => v.id === res.selected);
  const pd = price(sel.id + ' (' + (res.verdict.finalist ? 'finalist' : 'rejected') + ')', M.config(Object.assign({}, PV.cfg, { pd: { on: true, k_db: sel.k_db } })));
  const rows = inc.map((x, i) => ({ game_id: x.game_id, matchup: x.matchup, close_no_vig_home: x.close_no_vig_home, close_home_margin: x.close_home_margin,
    v1: { home_margin: x.home_margin, home_win_prob: x.home_win_prob, qb_adj_points: x.qb_adj_points },
    variant: { id: sel.id, home_margin: pd[i].home_margin, home_win_prob: pd[i].home_win_prob, qb_adj_points: pd[i].qb_adj_points, qb_prior_gap_points: pd[i].qb_prior_gap_points } }));
  const doc = { schema: 'edgedesk_nfl_prior_decay_shadow_v1', generated_at: new Date().toISOString(), season: SEASON, week: WEEK, selected: sel.id, verdict: res.verdict.finalist ? 'FINALIST' : 'REJECTED',
    note: 'Illustration only: fitted on 2002-2024; never on a card. The served card is football/nfl/slate.json (edgedesk_nfl_v2.1.0).', games: rows };
  fs.writeFileSync(path.join(__dirname, 'shadow_week' + WEEK + '.json'), JSON.stringify(doc, null, 1) + '\n');
  rows.forEach((r) => console.log(`${r.matchup.padEnd(10)} v1 ${r.v1.home_margin} / ${r.v1.home_win_prob}  ${r.variant.id} ${r.variant.home_margin} / ${r.variant.home_win_prob} (QB adj ${r.variant.qb_adj_points}, prior gap ${r.variant.qb_prior_gap_points})  close ${r.close_home_margin} / ${r.close_no_vig_home}`));
}
if (require.main === module) main();
