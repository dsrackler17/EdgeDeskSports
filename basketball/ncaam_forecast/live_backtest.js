#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Live-model backtest at FIXED game-state checkpoints, not chosen games.

     node basketball/ncaam_forecast/live_backtest.js     writes validation/live_backtest.json

   States: the 2025-26 matchup stints of the college data pack
   (datapack/ncaam_v1, ncaa_mbb_matchup_stints_2026; hash-verified through
   basketball/ncaam_research/lib/pack.js). Each stint has its period, its
   start/end in CUMULATIVE game seconds (period 2 runs 1200-2400, overtime
   periods 300 s each after 2400) and the score at both ends. The state at a
   checkpoint is the score at the LAST stint boundary at or before it, with the
   remaining time measured from that boundary (median gap a few seconds):
   no score is interpolated.
   QA, per game, before any checkpoint is used: the last stint's score must
   equal the official final score and its period count must match the final's
   (overtime included). A game that fails is EXCLUDED and counted by reason.

   Checkpoints (elapsed regulation minutes): 10, 20 (half time), 30, 35, 38, 39.
   Every checkpoint of a game falls in the same split, so no game is on both
   sides: DEVELOPMENT = games before 1 February 2026 (variants and constants
   are chosen here), TEST = 1 February onward (scored once with the choice).
   Pregame inputs: each game's causal walk-forward forecast (the champion
   configuration, calibration fitted on earlier games only).
   Uncertainty: bootstrap over GAMES (checkpoints of one game are dependent).
   Baselines: pregame only (ignores the score) and score-only (ignores pregame
   strength: mean 0). The live model must beat both to be enabled.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const M = require('./metrics');
const L = require('./live');
const U = require('../ncaam_research/lib/util');
const { read } = require('../ncaam_research/lib/pack');

const OUT = path.join(C.PATHS.validation, 'live_backtest.json');
const CHECKPOINTS = [10, 20, 30, 35, 38, 39];
const SPLIT_MS = Date.parse('2026-02-01T00:00:00Z');
const VARIANTS = {
  score_time: { model: 'score_time', v_pos: 1, kappa_window_s: 2400 },
  score_time_vpos0: { model: 'score_time', v_pos: 0, kappa_window_s: 2400 },
  score_time_vpos2: { model: 'score_time', v_pos: 2, kappa_window_s: 2400 },
  score_time_kappa_late: { model: 'score_time', v_pos: 1, kappa_window_s: 120 },
  shrunk_update_k20: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 20 },
  shrunk_update_k40: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 40 },
  shrunk_update_k80: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 80 },
  /* added to the grid on 2026-10-23 before the rerun: the normal-normal scale of
     k (live.js) is several hundred minutes and the first grid stopped at 80 */
  shrunk_update_k160: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 160 },
  shrunk_update_k320: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 320 },
  shrunk_update_k640: { model: 'shrunk_update', v_pos: 1, kappa_window_s: 2400, k_update_min: 640 },
};

async function states(gamesById) {
  const t = await read('ncaa_mbb_matchup_stints_2026', { contest_id: 'str', period: 'num', start_seconds: 'num', end_seconds: 'num', start_home_score: 'num', start_away_score: 'num', end_home_score: 'num', end_away_score: 'num' });
  const x = await read('ncaa_mbb_possessions_2026', { contest_id: 'str', espn_game_id: 'str', home_espn_team_id: 'str', away_espn_team_id: 'str' });
  const espn = new Map();
  for (let i = 0; i < x.n; i++) if (x.cols.espn_game_id[i] && !espn.has(x.cols.contest_id[i])) espn.set(x.cols.contest_id[i], { id: x.cols.espn_game_id[i], home: x.cols.home_espn_team_id[i], away: x.cols.away_espn_team_id[i] });
  const byC = new Map(); const c = t.cols;
  for (let i = 0; i < t.n; i++) { const k = c.contest_id[i]; if (!byC.has(k)) byC.set(k, []); byC.get(k).push({ period: c.period[i], s: c.start_seconds[i], e: c.end_seconds[i], sh: c.start_home_score[i], sa: c.start_away_score[i], eh: c.end_home_score[i], ea: c.end_away_score[i] }); }
  const excluded = {}; const ex = (r) => { excluded[r] = (excluded[r] || 0) + 1; };
  const out = [];
  for (const [cid, st] of byC) {
    const m = espn.get(cid); if (!m) { ex('NO_ESPN_CROSSWALK'); continue; }
    const g = gamesById.get(m.id); if (!g) { ex('GAME_NOT_IN_DATASET'); continue; }
    if (!(g.home_d1 && g.away_d1)) { ex('NOT_D1_V_D1'); continue; }
    /* the publisher's home side must be the dataset's (else scores would be flipped) */
    const flip = m.home === g.away_id && m.away === g.home_id;
    if (!flip && !(m.home === g.home_id && m.away === g.away_id)) { ex('TEAM_MISMATCH'); continue; }
    st.sort((a, b) => a.period - b.period || a.s - b.s);
    const last = st[st.length - 1];
    const fh = flip ? last.ea : last.eh, fa = flip ? last.eh : last.ea;
    if (fh !== g.hs || fa !== g.as) { ex('LAST_STINT_SCORE_NE_FINAL'); continue; }
    if (last.period !== 2 + (g.n_ot || 0)) { ex('PERIODS_NE_FINAL'); continue; }
    const cps = [];
    for (const cpm of CHECKPOINTS) {
      /* elapsed regulation seconds of the checkpoint, and of each boundary */
      const target = cpm * 60;
      let best = null;
      /* the stint clock is CUMULATIVE game seconds (period 2 runs 1200-2400, the first overtime 2400-2700): verified on the table */
      for (const s of st) { if (s.period > 2) break; if (s.e <= target) best = s; else break; }
      if (!best) { cps.push(null); continue; }
      const hs = flip ? best.ea : best.eh, as = flip ? best.eh : best.ea;
      cps.push({ checkpoint_min: cpm, period: best.period, clock_s: Math.max(0, best.period * 1200 - best.e), home_score: hs, away_score: as, gap_s: target - best.e });
    }
    out.push({ game_id: g.game_id, start_ms: g.start_ms, cps, y: { hw: g.hs > g.as ? 1 : 0 } });
  }
  return { games: out, excluded };
}

function evaluate(G, pre, variant) {
  const rows = [];
  for (const g of G) {
    const p = pre.get(g.game_id); if (!p) continue;
    for (const st of g.cps) {
      if (!st) continue;
      const r = variant === 'pregame_only' ? { p_home: p.p_home } : variant === 'score_only'
        ? L.liveProb({ mu: 0, sd: p.reg_sd }, p.cal, st, VARIANTS.score_time) : L.liveProb({ mu: p.reg_mu, sd: p.reg_sd }, p.cal, st, VARIANTS[variant]);
      rows.push({ game_id: g.game_id, cp: st.checkpoint_min, p: r.p_home, y: g.y.hw, gap: st.gap_s });
    }
  }
  return rows;
}
function summ(rows) {
  const by = {}; let ll = 0, br = 0;
  for (const r of rows) { const l = M.ll(r.p, r.y); ll += l; br += (r.p - r.y) ** 2; (by[r.cp] = by[r.cp] || { n: 0, ll: 0, br: 0 }); by[r.cp].n++; by[r.cp].ll += l; by[r.cp].br += (r.p - r.y) ** 2; }
  const per = {}; for (const [k, v] of Object.entries(by)) per[k] = { n: v.n, log_loss: U.r(v.ll / v.n, 5), brier: U.r(v.br / v.n, 5) };
  return { n: rows.length, games: new Set(rows.map((r) => r.game_id)).size, log_loss: U.r(ll / rows.length, 5), brier: U.r(br / rows.length, 5), by_checkpoint: per };
}
function pairedByGame(a, b) {
  const key = (r) => r.game_id + ':' + r.cp; const bm = new Map(b.map((r) => [key(r), r]));
  const pairs = a.filter((r) => bm.has(key(r))).map((r) => ({ g: r.game_id, d: M.ll(r.p, r.y) - M.ll(bm.get(key(r)).p, r.y) }));
  return U.clusteredDiffCI(pairs, (p) => p.g, (p) => p.d, { B: 1000, seed: 11 });
}

async function run() {
  const sel = JSON.parse(fs.readFileSync(path.join(C.PATHS.configDir, 'selection_v1.json'), 'utf8'));
  const cfg = { engine: 'research_team_model', params: sel.chosen, calibration: sel.calibration };
  const all = DS.load(); const eg = DS.engineGames(all);
  const R = MD.researchRows(eg, cfg); MD.calibrateCausal(R.rows, cfg.calibration);
  const pre = new Map();
  for (const r of R.rows) if (r.season === 2026 && r.regime === 'D1_D1' && r.s) pre.set(String(r.game_id), { p_home: r.s.p_home, reg_mu: r.s.reg_mu, reg_sd: r.s.reg_sd, cal: { kappa: r.cal.kappa, ot: r.cal.ot } });
  const byId = new Map(all.filter((g) => g.season === 2026 && g.status === 'FINAL').map((g) => [g.game_id, g]));
  const S = await states(byId);
  const dev = S.games.filter((g) => g.start_ms < SPLIT_MS), test = S.games.filter((g) => g.start_ms >= SPLIT_MS);
  const res = { development: {}, test: {} };
  const names = Object.keys(VARIANTS).concat(['pregame_only', 'score_only']);
  const rowsDev = {}, rowsTest = {};
  for (const v of names) { rowsDev[v] = evaluate(dev, pre, v); rowsTest[v] = evaluate(test, pre, v); res.development[v] = summ(rowsDev[v]); res.test[v] = summ(rowsTest[v]); }
  const live = Object.keys(VARIANTS);
  const chosen = live.reduce((a, b) => (res.development[b].log_loss < res.development[a].log_loss ? b : a), 'score_time');
  const cmp = (rows, a, b) => pairedByGame(rows[a], rows[b]);
  const doc = {
    schema: 'edgedesk_ncaam_fc_live_backtest_v1', generated_at: new Date().toISOString(), selection_hash: sel.hash,
    data: { source: 'datapack/ncaam_v1 ncaa_mbb_matchup_stints_2026 (hash-verified)', games_with_states: S.games.length, excluded: S.excluded, development_games: dev.length, test_games: test.length, split: 'development before 2026-02-01, test from 2026-02-01 (whole games)', checkpoints_elapsed_min: CHECKPOINTS,
      state_rule: 'score at the last stint boundary at or before the checkpoint; remaining time from that boundary' },
    variants: VARIANTS, chosen_on_development: chosen, results: res,
    comparisons_test: { [chosen + '_vs_pregame_only']: cmp(rowsTest, chosen, 'pregame_only'), [chosen + '_vs_score_only']: cmp(rowsTest, chosen, 'score_only'), [chosen + '_vs_score_time']: chosen === 'score_time' ? null : cmp(rowsTest, chosen, 'score_time') },
    note: 'log loss clipped to [1e-6, 1 - 1e-6]; intervals: bootstrap over games (all checkpoints of a game move together)',
  };
  fs.mkdirSync(C.PATHS.validation, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log('[live] games ' + S.games.length + ' excluded ' + JSON.stringify(S.excluded) + ' chosen ' + chosen);
  for (const v of names) console.log('  ' + v.padEnd(22) + ' dev LL ' + res.development[v].log_loss + ' test LL ' + res.test[v].log_loss);
  console.log('  test comparisons ' + JSON.stringify(doc.comparisons_test));
  return doc;
}

module.exports = { CHECKPOINTS, VARIANTS, SPLIT_MS, states, evaluate };
if (require.main === module) run().catch((e) => { console.error(e); process.exit(1); });
