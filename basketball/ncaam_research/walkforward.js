#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The team model's walk-forward record: selection on 2025, holdout on 2026.

     node basketball/ncaam_research/walkforward.js --tune      choose on 2025, freeze
     node basketball/ncaam_research/walkforward.js --holdout   evaluate the frozen choice
     node basketball/ncaam_research/walkforward.js --check     the committed record rebuilds

   Protocol (written before the holdout was scored; see selection_frozen.json):
     - one chronological pass per configuration; a game is predicted 30 min
       before tip from games available by then (tip + 4 h, assumed);
     - the possession FTA coefficient is fitted on earlier seasons only
       (2024 for the 2025 selection, 2024-25 for the 2026 holdout);
     - calibration (lib/calibration.js) is refitted weekly on earlier
       out-of-sample rows only;
     - hyperparameters are chosen on 2025 margin CRPS by coordinate descent; a
       new value must beat the current one by 0.002 CRPS (about 3% of the
       spread between the best and worst configurations seen) or it is not
       taken: chasing noise across ~40 evaluated configurations is the
       multiple-testing risk this guards against;
     - 2026 is scored once with the frozen choice; ablations and baselines are
       paired on the same games with day-clustered bootstrap intervals.
   Baselines: home advantage only; the pack's unadjusted prior-10-game
   efficiencies; the incumbent EdgeDesk points model (scores only,
   basketball/model.js, its own tuned parameters, my calibrator on its raw
   margins); its tuned Elo for win probability. No external rating archive
   (KenPom, Torvik, EvanMiya) is lawfully on file point in time, and no
   bookmaker archive: neither is a benchmark here.
   =========================================================================== */
const fs = require('fs');
const crypto = require('crypto');
const C = require('./config');
const U = require('./lib/util');
const I = require('./ingest');
const TM = require('./team_model');
const CAL = require('./lib/calibration');
const M = require('./lib/metrics');
const { read } = require('./lib/pack');

const flag = (n) => process.argv.includes('--' + n);
const CHALLENGER = 0.002;

async function prepare() {
  const G = await I.loadGames(); const TG = await I.loadTeamGames(); const PG = await I.loadPlayerGames();
  const rosters = new TM.Rosters(PG);
  const coef = { selection: TM.possessionCoefficient(TG, [2024]), holdout: TM.possessionCoefficient(TG, [2024, 2025]) };
  return { G, TG, PG, rosters, coef, games: { selection: TM.buildGames(G, TG, coef.selection.c), holdout: TM.buildGames(G, TG, coef.holdout.c) } };
}

function scored(rows, regime, o) {
  const rs = rows.filter((r) => r.regime === regime).map((r) => (o && o.constant_sd ? Object.assign({}, r, { var_param: 0 }) : r));
  return CAL.causal(rs, { min_rows: regime === 'D1_D1' ? 300 : 100 });
}

function runCandidate(D, params, fold) {
  const seasons = fold === 'selection' ? [2024, 2025] : [2024, 2025, 2026];
  const W = TM.walk(D.games[fold], params, D.rosters, seasons);
  return W;
}

function seasonSummary(rows, season) { return M.summarize(rows.filter((r) => r.season === season)); }

/* ---------------------------------------------------------------- baselines */
function incumbentRows(D) {
  const BW = require('../walkforward');
  const tuning = JSON.parse(fs.readFileSync(require('path').join(C.ROOT, 'basketball', 'params', 'ncaam_tuning.json'), 'utf8'));
  const { games } = BW.load('ncaam');
  const raw = BW.pass(games, tuning.chosen, tuning.elo).rows;
  const mine = new Map(D.games.holdout.map((g) => [g.game_id, g]));
  const out = [];
  for (const r of raw) {
    const g = mine.get(Number(r.id)); if (!g) continue;
    out.push({ game_id: g.game_id, season: g.season, start_ms: g.start_ms, day: g.day, regime: g.regime, neutral: g.neutral, margin: r.m, total: r.t, var_param: 0, elo: r.elo, y: { margin: g.hs - g.as, total: g.hs + g.as, hw: g.hs > g.as ? 1 : 0 } });
  }
  return { rows: out, params: tuning.chosen, elo: tuning.elo };
}

async function packRawRows(D) {
  const t = await read('team_pregame_features', { game_id: 'num', team_id: 'num', prior_10_games: 'num', prior_10_off_rating_proxy_mean: 'num', prior_10_def_rating_proxy_mean: 'num', prior_10_pace_per40_proxy_mean: 'num' });
  const c = t.cols; const by = new Map();
  for (let i = 0; i < t.n; i++) by.set(c.game_id[i] + ':' + c.team_id[i], { n: c.prior_10_games[i], off: c.prior_10_off_rating_proxy_mean[i], def: c.prior_10_def_rating_proxy_mean[i], pace: c.prior_10_pace_per40_proxy_mean[i] });
  const out = [];
  for (const g of D.games.holdout) {
    const h = by.get(g.game_id + ':' + g.home); const a = by.get(g.game_id + ':' + g.away);
    const ok = h && a && h.n > 0 && a.n > 0 && [h.off, h.def, a.off, a.def, h.pace, a.pace].every(Number.isFinite);
    const pace = ok ? (h.pace + a.pace) / 2 : 68; const ph = ok ? (h.off + a.def) / 2 : 105; const pa = ok ? (a.off + h.def) / 2 : 105;
    out.push({ game_id: g.game_id, season: g.season, start_ms: g.start_ms, day: g.day, regime: g.regime, neutral: g.neutral, margin: (pace * (ph - pa)) / 100 + (g.neutral ? 0 : 1e-9), total: (pace * (ph + pa)) / 100, var_param: 0, y: { margin: g.hs - g.as, total: g.hs + g.as, hw: g.hs > g.as ? 1 : 0 } });
  }
  return out;
}

function hcaRows(D) {
  return D.games.holdout.map((g) => ({ game_id: g.game_id, season: g.season, start_ms: g.start_ms, day: g.day, regime: g.regime, neutral: g.neutral, margin: g.neutral ? 0 : 1, total: 140, var_param: 0, y: { margin: g.hs - g.as, total: g.hs + g.as, hw: g.hs > g.as ? 1 : 0 } }));
}

/* ---------------------------------------------------------------- selection */
const SPACE = [
  ['lambda', [50, 100, 150, 300, 600]],
  ['carry', [0.6, 0.7, 0.8, 0.9, 1.0]],
  ['half_life', [null, 365, 180, 90]],
  ['continuity_slope', [0, 0.3, 0.6, 1.0]],
  ['transfer_beta', [0, 0.25, 0.5, 1.0]],
  ['blowout_weight', [1, 0.7, 0.4]],
  ['scale', ['additive', 'log']],
];
const TEMPO_SPACE = [['lambda_tempo', [2, 4, 8, 16]], ['carry_tempo', [0.5, 0.7, 0.9]]];

function selectionScore(D, params) {
  const W = runCandidate(D, params, 'selection');
  const rows = scored(W.rows, 'D1_D1');
  const s = seasonSummary(rows, 2025);
  return { margin_crps: s.margin.crps, total_crps: s.total.crps, log_loss: s.win.log_loss, n: s.n };
}

function tune(D) {
  const log = []; let cur = Object.assign({}, TM.DEFAULT_PARAMS);
  let best = selectionScore(D, cur); log.push({ params: Object.assign({}, cur), score: best, step: 'start' });
  const descend = (space, key) => {
    for (const [name, values] of space) {
      for (const v of values) {
        if (cur[name] === v) continue;
        const cand = Object.assign({}, cur, { [name]: v });
        const sc = selectionScore(D, cand); log.push({ params: { [name]: v }, score: sc });
        process.stdout.write(`  ${name}=${v}: margin CRPS ${sc.margin_crps} total CRPS ${sc.total_crps} LL ${sc.log_loss}\n`);
        if (sc[key] < best[key] - CHALLENGER) { cur = cand; best = sc; process.stdout.write(`    -> taken\n`); }
      }
    }
  };
  descend(SPACE, 'margin_crps');
  descend(SPACE.slice(0, 3), 'margin_crps');
  descend(TEMPO_SPACE, 'total_crps');
  return { chosen: cur, score: best, evaluated: log.length, log };
}

/* ---------------------------------------------------------------- holdout */
function breakdown(rows, key) {
  const g = U.groupBy(rows.filter((r) => r.cal), key); const out = {};
  for (const [k, rs] of [...g.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) { const s = M.summarize(rs); out[k] = { n: s.n, log_loss: s.win.log_loss, margin_mae: s.margin.mae, margin_crps: s.margin.crps, margin_cov80: s.margin.coverage.c80, total_mae: s.total.mae, total_cov80: s.total.coverage.c80 }; }
  return out;
}

const STAGE = (r) => { const m = new Date(r.start_ms).getUTCMonth() + 1; return m === 11 ? '1_nov' : m === 12 ? '2_dec' : m === 1 ? '3_jan' : m === 2 ? '4_feb' : '5_mar_apr'; };
const GP = (r) => { const n = Math.min(r.n_h, r.n_a); return n < 5 ? '0-4' : n < 10 ? '5-9' : n < 20 ? '10-19' : '20+'; };
const CONT = (r) => { const c = r.cont_h == null || r.cont_a == null ? null : Math.min(r.cont_h, r.cont_a); return c == null ? 'unknown_yet' : c < 0.25 ? 'lt_25pct' : c < 0.5 ? '25-50pct' : 'ge_50pct'; };

async function holdout(D, frozen) {
  const out = { candidates: {}, comparisons: {}, breakdowns: {} };
  const full = runCandidate(D, frozen.chosen, 'holdout');
  const rows = { frozen: scored(full.rows, 'D1_D1') };
  const variants = {
    no_roster_prior: { continuity_slope: 0, transfer_beta: 0 },
    no_recency: { half_life: null },
    league_average_prior: { carry: 0, continuity_slope: 0, transfer_beta: 0 },
    other_scale: { scale: frozen.chosen.scale === 'log' ? 'additive' : 'log' },
    no_blowout_damping: { blowout_weight: 1 },
  };
  for (const [k, v] of Object.entries(variants)) {
    const p = Object.assign({}, frozen.chosen, v);
    if (JSON.stringify(p) === JSON.stringify(frozen.chosen)) continue;
    rows[k] = scored(runCandidate(D, p, 'holdout').rows, 'D1_D1');
  }
  rows.constant_sd = scored(full.rows, 'D1_D1', { constant_sd: true });
  const inc = incumbentRows(D);
  rows.incumbent_points_model = scored(inc.rows, 'D1_D1');
  rows.pack_unadjusted_prior10 = scored(await packRawRows(D), 'D1_D1');
  rows.home_advantage_only = scored(hcaRows(D), 'D1_D1');
  for (const s of [2025, 2026]) {
    out.candidates[s] = {};
    for (const [k, rs] of Object.entries(rows)) out.candidates[s][k] = seasonSummary(rs, s);
    // Elo: win probability only
    const eloRows = rows.incumbent_points_model.filter((r) => r.season === s && r.cal);
    out.candidates[s].incumbent_elo_win_only = { n: eloRows.length, log_loss: U.r(U.mean(eloRows.map((r) => M.ll(r.elo, r.y.hw))), 5), brier: U.r(U.mean(eloRows.map((r) => (r.elo - r.y.hw) ** 2)), 5) };
    const pick = (k) => rows[k].filter((r) => r.season === s);
    out.comparisons[s] = {};
    for (const k of Object.keys(rows)) {
      if (k === 'frozen') continue;
      out.comparisons[s]['frozen_vs_' + k] = { margin_crps: M.compare(pick('frozen'), pick(k), 'margin_crps'), log_loss: M.compare(pick('frozen'), pick(k), 'log_loss'), total_crps: M.compare(pick('frozen'), pick(k), 'total_crps') };
    }
  }
  const h = rows.frozen.filter((r) => r.season === 2026);
  out.breakdowns = {
    season_stage: breakdown(h, STAGE), event: breakdown(h, (r) => r.event), venue: breakdown(h, (r) => (r.neutral ? 'neutral' : 'campus')),
    games_played_min: breakdown(h, GP), roster_continuity_min: breakdown(h, CONT),
    conference_game: breakdown(h, (r) => (r.conference_game ? 'conference' : 'non_conference')),
    predicted_margin: breakdown(h, (r) => { const a = Math.abs(r.cal.margin_mu); return a < 3 ? '0-3' : a < 7 ? '3-7' : a < 12 ? '7-12' : a < 20 ? '12-20' : '20+'; }),
  };
  out.reliability = { 2025: M.reliability(rows.frozen.filter((r) => r.season === 2025)), 2026: M.reliability(h) };
  // the separate regime: D1 against opponents of unknown membership
  const nd = scored(full.rows, 'D1_OTHER');
  out.non_d1_regime = { 2025: seasonSummary(nd, 2025), 2026: seasonSummary(nd, 2026), note: 'one pooled opponent per season; never mixed into D1 ratings' };
  // rest: does days-of-rest difference explain held-out residuals? (reported; not in the model unless it clears the bar)
  out.rest_check = restCheck(rows.frozen);
  return { out, rows, full, incumbent: inc };
}

function restCheck(rows) {
  const res = {};
  for (const s of [2025, 2026]) {
    const rs = rows.filter((r) => r.season === s && r.cal && r.rest_h != null && r.rest_a != null);
    const x = rs.map((r) => Math.max(-4, Math.min(4, r.rest_h - r.rest_a))); const e = rs.map((r) => r.y.margin - r.cal.margin_mu);
    const f = CAL.ols(x, e);
    const resid = rs.map((r, i) => e[i] - (f.a + f.b * x[i])); const se = Math.sqrt(U.mean(resid.map((v) => v * v)) / (U.sd(x) ** 2 * (x.length - 1)));
    res[s] = { n: rs.length, points_per_rest_day: U.r(f.b, 3), se: U.r(se, 3), note: 'rest difference capped at +-4 days; slope of held-out margin residuals' };
  }
  return res;
}

function frozenHash(f) { return crypto.createHash('sha256').update(JSON.stringify({ chosen: f.chosen, rule: f.rule })).digest('hex').slice(0, 16); }

async function main() {
  const D = await prepare();
  if (flag('tune')) {
    console.log('selection season 2025; coefficient (2024 only) c =', U.r(D.coef.selection.c, 4));
    const t = tune(D);
    const frozen = {
      schema: 'edgedesk_ncaam_selection_frozen_v1', frozen_at: new Date().toISOString(), selection_season: 2025, holdout_season: 2026,
      rule: `coordinate descent over ${SPACE.map((s) => s[0]).join(', ')} on 2025 margin CRPS (D1-v-D1, calibrated causally); tempo parameters on 2025 total CRPS; a value replaces the current one only if it improves by >= ${CHALLENGER}`,
      chosen: t.chosen, selection_score: t.score, configurations_evaluated: t.evaluated, possession_coefficient: { selection: D.coef.selection, holdout: D.coef.holdout },
      log: t.log,
    };
    frozen.hash = frozenHash(frozen);
    fs.writeFileSync(C.PATHS.frozen, JSON.stringify(frozen, null, 1) + '\n');
    console.log('frozen', frozen.hash, JSON.stringify(t.chosen), JSON.stringify(t.score));
    return;
  }
  if (flag('holdout') || flag('check')) {
    const frozen = JSON.parse(fs.readFileSync(C.PATHS.frozen, 'utf8'));
    if (frozenHash(frozen) !== frozen.hash) throw new Error('selection_frozen.json was edited after freezing');
    const H = await holdout(D, frozen);
    const rec = { schema: 'edgedesk_ncaam_team_validation_v1', frozen_hash: frozen.hash, chosen: frozen.chosen, possession_coefficient: frozen.possession_coefficient, protocol: PROTOCOL, ...H.out };
    if (flag('check')) {
      const committed = JSON.parse(fs.readFileSync(C.PATHS.outFile('validation_team.json'), 'utf8'));
      const a = JSON.stringify(committed.candidates); const b = JSON.stringify(rec.candidates);
      if (a !== b) { console.error('validation_team.json does not rebuild'); process.exit(1); }
      console.log('validation_team.json rebuilds'); return;
    }
    fs.mkdirSync(C.PATHS.out, { recursive: true });
    fs.writeFileSync(C.PATHS.outFile('validation_team.json'), JSON.stringify(rec, null, 1) + '\n');
    const s26 = rec.candidates[2026];
    for (const k of Object.keys(s26)) console.log(k.padEnd(28), JSON.stringify(s26[k].margin ? { n: s26[k].n, ll: s26[k].win.log_loss, mcrps: s26[k].margin.crps, mmae: s26[k].margin.mae, tcrps: s26[k].total.crps, cov80: s26[k].margin.coverage.c80 } : s26[k]));
  }
}

const PROTOCOL = {
  windows: C.WINDOWS, prediction_time: 'tip - 30 min', inputs: 'games with tip + 4 h before the prediction time (assumed availability; no first-publication times exist)',
  calibration: 'weekly refit on earlier out-of-sample rows only (lib/calibration.js)', selection: 'coordinate descent on 2025; challenger margin ' + CHALLENGER,
  uncertainty: 'paired differences with bootstrap 95% intervals clustered by game day', regimes: 'D1-v-D1 scored here; games against opponents of unknown membership scored separately',
};

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { prepare, runCandidate, scored, holdout, tune, incumbentRows, packRawRows, hcaRows, STAGE, GP, CONT };
