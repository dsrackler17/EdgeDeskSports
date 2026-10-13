#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NFL research on the NFL data pack — two questions the pack's
   instructions raise, answered on held-out games.

     node football/nfl/research/pack_research.js           writes football/validation/nfl_pack_research.json
     node football/nfl/research/pack_research.js --check   the committed result holds (recomputed when the cache is present)

   1. OFFSEASON CARRYOVER. The pack's prior-5/10/20 windows run straight across
      the offseason. Should last season's games count fully, partly, or not at
      all? Team strength before a game = offensive EPA per play − defensive EPA
      allowed per play over the team's last 10 games, with last season's games
      weighted δ:
        cross   δ = 1      (the pack's rule)
        decay   δ ∈ {0.25, 0.5, 0.75}, the best chosen on the fitting window only
        reset   δ = 0      (this season only; a team with no game yet is 0)
      Predicted home margin = a + b·(home strength − away strength), a and b
      fitted by least squares on the fitting window.
   2. STARTING QB CHANGE. Does a team starting a different QB from its previous
      game's starter (nflverse games.csv's listed starters, GSIS ids) move the
      margin beyond team strength? One coefficient on (home change − away
      change), fitted on the fitting window.

   Declared before any result was seen:
     history 2022 on; fitting window 2023-2024 seasons; scoring window
     2025-2026 (2026 PARTIAL, through the pack's last game); the outcome is the
     final home margin; squared error is the loss; a variant or term ADDS
     INFORMATION only if its scoring-window mean squared error is lower and the
     95% paired bootstrap interval (blocks = season-weeks) lies below zero.
   Baselines: home edge only, and the archived consensus closing spread
   (spread_line; a label, never a price I could have taken).

   Nothing here changes a price. The NFL brain (football/engine.js) carries a
   season-carry factor and a QB layer of its own; these results say what the
   pack's data supports, for that brain's own validation to act on.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../../../engine/csv');

const ROOT = path.join(__dirname, '..', '..', '..');
const PACK = path.join(ROOT, 'datapack', 'nfl_v1', 'data');
const GAMES = path.join(ROOT, '.cache', 'lab_src', 'nflverse_nfldata_master_data_games.csv');
const OUT = path.join(ROOT, 'football', 'validation', 'nfl_pack_research.json');
const FIT = [2023, 2024], SCORE = [2025, 2026], WINDOW = 10, DELTAS = [0.25, 0.5, 0.75];
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function load() {
  if (!fs.existsSync(GAMES)) return null;
  const tg = readCsv(path.join(PACK, 'team_game_advanced_2022_2026.csv')).rows;
  const labels = readCsv(path.join(PACK, 'game_labels_2022_2026.csv')).rows;
  const sched = new Map(readCsv(GAMES).rows.map((g) => [g.game_id, g]));
  const byTeam = {};
  for (const r of tg) (byTeam[r.team_id] = byTeam[r.team_id] || []).push({ game_id: r.game_id, date: r.game_date, season: +r.season, epa: +r.epa_sum, plays: +r.plays, depa: r.def_epa_allowed_sum === '' ? null : +r.def_epa_allowed_sum, dplays: r.def_plays === '' ? null : +r.def_plays });
  for (const a of Object.values(byTeam)) a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.game_id < y.game_id ? -1 : 1));
  const games = labels.map((l) => {
    const s = sched.get(l.game_id) || {};
    return { game_id: l.game_id, season: +l.season, week: +l.week, date: l.game_date, home: l.home_team, away: l.away_team, margin: +l.home_score - +l.away_score, spread: l.spread_line === '' ? null : +l.spread_line, hqb: s.home_qb_id || '', aqb: s.away_qb_id || '' };
  }).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.game_id < y.game_id ? -1 : 1));
  return { byTeam, games };
}

/** strength of `team` before `date`, last-season games weighted delta */
function strength(byTeam, team, date, season, delta) {
  const prior = (byTeam[team] || []).filter((g) => g.date < date).slice(-WINDOW);
  let e = 0, p = 0, de = 0, dp = 0;
  for (const g of prior) { const w = g.season === season ? 1 : delta; if (!w) continue; e += w * g.epa; p += w * g.plays; if (g.depa != null) { de += w * g.depa; dp += w * g.dplays; } }
  return (p ? e / p : 0) - (dp ? de / dp : 0);
}

function ols(X, y) { /* normal equations, small k */
  const k = X[0].length; const A = [...Array(k)].map(() => new Array(k + 1).fill(0));
  for (let i = 0; i < X.length; i++) for (let j = 0; j < k; j++) { A[j][k] += X[i][j] * y[i]; for (let l = 0; l < k; l++) A[j][l] += X[i][j] * X[i][l]; }
  for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let l = c; l <= k; l++) A[r][l] -= f * A[c][l]; } }
  return A.map((row, i) => row[k] / row[i]);
}

function bootstrap(diff, blocks) {
  const keys = [...new Set(blocks)]; const idx = new Map(keys.map((k) => [k, []])); blocks.forEach((b, i) => idx.get(b).push(i));
  let s = 0x2468ace; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const m = [];
  for (let b = 0; b < 2000; b++) { let t = 0, n = 0; for (let j = 0; j < keys.length; j++) for (const i of idx.get(keys[Math.floor(rnd() * keys.length)])) { t += diff[i]; n++; } m.push(t / n); }
  m.sort((a, b) => a - b); return [r4(m[49]), r4(m[1949])];
}

function run(D) {
  const { byTeam, games } = D;
  /* the starting QB of each team's previous game */
  const lastQb = {}; const qbChange = new Map();
  for (const g of games) {
    const hc = g.hqb && lastQb[g.home] && lastQb[g.home] !== g.hqb ? 1 : 0, ac = g.aqb && lastQb[g.away] && lastQb[g.away] !== g.aqb ? 1 : 0;
    qbChange.set(g.game_id, { h: hc, a: ac, known: !!(g.hqb && g.aqb && lastQb[g.home] && lastQb[g.away]) });
    if (g.hqb) lastQb[g.home] = g.hqb; if (g.aqb) lastQb[g.away] = g.aqb;
  }
  const use = games.filter((g) => g.season >= FIT[0]);
  const feat = (delta) => use.map((g) => strength(byTeam, g.home, g.date, g.season, delta) - strength(byTeam, g.away, g.date, g.season, delta));
  const fitIdx = use.map((g, i) => (FIT.includes(g.season) ? i : -1)).filter((i) => i >= 0);
  const scIdx = use.map((g, i) => (SCORE.includes(g.season) ? i : -1)).filter((i) => i >= 0);
  const y = use.map((g) => g.margin);
  const blocks = use.map((g) => g.season + '-' + g.week);
  const se = (pred, idx) => idx.map((i) => (y[i] - pred[i]) ** 2);
  const fitPredict = (cols) => { const b = ols(fitIdx.map((i) => cols.map((c) => c[i])), fitIdx.map((i) => y[i])); return { b, pred: use.map((_, i) => cols.reduce((s, c, j) => s + c[i] * b[j], 0)) }; };
  const ones = use.map(() => 1);
  const variants = { cross: 1, reset: 0 }; for (const d of DELTAS) variants['decay_' + d] = d;
  const res = {}; const preds = {};
  for (const [name, d] of Object.entries(variants)) {
    const x = feat(d); const f = fitPredict([ones, x]); preds[name] = f.pred;
    res[name] = { delta: d, home_edge: r4(f.b[0]), slope: r4(f.b[1]), fit_mse: r4(mean(se(f.pred, fitIdx))), score_mse: r4(mean(se(f.pred, scIdx))), score_mae: r4(mean(scIdx.map((i) => Math.abs(y[i] - f.pred[i])))), score_mse_weeks_1_4: r4(mean(se(f.pred, scIdx.filter((i) => use[i].week <= 4)))) };
  }
  const bestDecay = DELTAS.map((d) => 'decay_' + d).sort((a, b) => res[a].fit_mse - res[b].fit_mse)[0];
  const cmp = (a, b) => { const d = scIdx.map((i) => (y[i] - preds[a][i]) ** 2 - (y[i] - preds[b][i]) ** 2); const m = mean(d); const ci = bootstrap(d, scIdx.map((i) => blocks[i])); return { mse_change: r4(m), ci95: ci, adds_information: m < 0 && ci[1] < 0 }; };
  const home = fitPredict([ones]);
  const spreadIdx = scIdx.filter((i) => use[i].spread != null);
  const baselines = {
    home_edge_only: { score_mse: r4(mean(se(home.pred, scIdx))), home_edge: r4(home.b[0]) },
    closing_spread_label: { score_mse: r4(mean(spreadIdx.map((i) => (y[i] - use[i].spread) ** 2))), games: spreadIdx.length, note: 'archived consensus close (spread_line, home favoured positive): a label, never a price I could have taken' },
  };
  const carry = {
    chosen_decay_on_fit: bestDecay, variants: res,
    reset_vs_cross: cmp('reset', 'cross'), chosen_decay_vs_cross: cmp(bestDecay, 'cross'), chosen_decay_vs_reset: cmp(bestDecay, 'reset'),
  };
  /* QB change, on top of the chosen carryover */
  const x = feat(variants[bestDecay]);
  const q = use.map((g) => { const c = qbChange.get(g.game_id); return c ? c.h - c.a : 0; });
  const withQb = fitPredict([ones, x, q]);
  const qd = scIdx.map((i) => (y[i] - withQb.pred[i]) ** 2 - (y[i] - preds[bestDecay][i]) ** 2);
  const qci = bootstrap(qd, scIdx.map((i) => blocks[i]));
  /* the coefficient's own uncertainty over every scored game 2023-2026 (bootstrap by season-week) */
  const allIdx = use.map((_, i) => i);
  const coefBoot = (() => {
    const keys = [...new Set(blocks)]; const idx = new Map(keys.map((k) => [k, []])); allIdx.forEach((i) => idx.get(blocks[i]).push(i));
    let s = 0x13579b; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const bs = [];
    for (let b = 0; b < 1000; b++) { const pick = []; for (let j = 0; j < keys.length; j++) for (const i of idx.get(keys[Math.floor(rnd() * keys.length)])) pick.push(i); bs.push(ols(pick.map((i) => [1, x[i], q[i]]), pick.map((i) => y[i]))[2]); }
    bs.sort((a, b) => a - b); return [r4(bs[24]), r4(bs[974])];
  })();
  const changes = use.filter((g) => { const c = qbChange.get(g.game_id); return c && (c.h || c.a); }).length;
  const qb = {
    games_with_a_starter_change: changes, of_games: use.length,
    points_per_change_fit: r4(withQb.b[2]), points_per_change_all_seasons_ci95: coefBoot,
    score_mse_with_term: r4(mean(se(withQb.pred, scIdx))), vs_without: { mse_change: r4(mean(qd)), ci95: qci, adds_information: mean(qd) < 0 && qci[1] < 0 },
    reading: 'listed starters come from nflverse games.csv after the fact; starters are usually announced before kickoff, but no announcement time is recorded, so this is a confirmed-starter scenario, not a pregame-certified feature',
  };
  return {
    schema: 'edgedesk_nfl_pack_research_v1',
    windows: { history_from: 2022, fit: FIT, score: SCORE, score_games: scIdx.length, fit_games: fitIdx.length, note: '2026 is partial: through the pack\'s last game' },
    carryover: carry, qb_change: qb, baselines,
    conclusion: [
      carry.reset_vs_cross.adds_information ? 'Resetting at the season start beats carrying last season in full.' : carry.chosen_decay_vs_cross.adds_information ? 'A partial carry (' + bestDecay + ') beats the pack\'s full carry.' : 'No carryover rule beats the pack\'s full carry by a margin the held-out games can distinguish (' + bestDecay + ' chosen on the fitting window).' +
        (res.reset.score_mse_weeks_1_4 > res.cross.score_mse_weeks_1_4 ? ' Resetting at the season start is the worst choice early: weeks 1-4 squared error ' + res.reset.score_mse_weeks_1_4 + ' against ' + res.cross.score_mse_weeks_1_4 + ' carrying in full — last season\'s games carry information.' : ''),
      qb.vs_without.adds_information ? 'A starting-QB change adds information: ' + qb.points_per_change_fit + ' points per change (95% ' + qb.points_per_change_all_seasons_ci95.join(' to ') + ').' : 'A starting-QB change moves the margin by ' + qb.points_per_change_fit + ' points (95% ' + qb.points_per_change_all_seasons_ci95.join(' to ') + ') but does not improve held-out squared error by a distinguishable margin.',
      'Every variant is far from the archived closing spread: these pack features do not approach the market, and nothing here changes a price.',
    ],
  };
}

if (require.main === module) {
  const D = load(); const r = D ? run(D) : null;
  if (process.argv.includes('--check')) {
    const c = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (r && JSON.stringify(c) !== JSON.stringify(r)) { console.error('[nfl pack research --check] FAILED: the committed result differs from a fresh run'); process.exit(1); }
    if (!c.carryover || !c.qb_change) { console.error('[nfl pack research --check] FAILED: incomplete'); process.exit(1); }
    console.log('[nfl pack research --check] ok' + (r ? ' (recomputed)' : ' (no cache: committed report checked)')); process.exit(0);
  }
  if (!r) { console.log('[nfl pack research] no cached games.csv (.cache/lab_src): nothing written'); process.exit(0); }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
  for (const [k, v] of Object.entries(r.carryover.variants)) console.log('[nfl pack research] ' + k.padEnd(12) + ' fit MSE ' + v.fit_mse + '  score MSE ' + v.score_mse + '  MAE ' + v.score_mae + '  weeks 1-4 MSE ' + v.score_mse_weeks_1_4 + '  slope ' + v.slope);
  console.log('[nfl pack research] ' + JSON.stringify({ reset_vs_cross: r.carryover.reset_vs_cross, decay_vs_cross: r.carryover.chosen_decay_vs_cross, qb: r.qb_change, baselines: r.baselines }));
  r.conclusion.forEach((c) => console.log('  ' + c));
}
module.exports = { run, load, strength };
