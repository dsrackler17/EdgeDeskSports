'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the chronological walk-forward (team window).

     node college_baseball/walkforward.js              SELECTION + VALIDATION report
     node college_baseball/walkforward.js --holdout    + HOLDOUT (registered as a holdout look)
     node college_baseball/walkforward.js --tune hier  grid search on SELECTION only
     node college_baseball/walkforward.js --check      re-validate the committed report

   Protocol: research/PROTOCOL.md (written before scoring). Every game is
   predicted at 14:00 UTC on its date from games of earlier dates only; the
   leakage audit runs on every scored row and a single violation fails.

   CALIBRATION. A model's raw probabilities can be systematically off (all of
   them under-predicted home wins in the first look). The calibrated variant of
   a model maps season S with a logistic recalibration
        logit p' = a + b logit p + c [non-neutral]
   fitted ONLY on that model's out-of-sample rows from seasons S-3..S-1. Both
   raw and calibrated variants are scored; the calibrated one is a candidate
   only if it wins on SELECTION like any other.

   POINT IN TIME: RETROSPECTIVE. Final, possibly revised data reconstructed as
   of each date; not a verified live record.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('./config');
const W = require('./lib/warehouse');
const M = require('./lib/models');
const KS = require('./lib/constants');
const D = require('./lib/distribution');
const S = require('../engine/stats');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const REG = require('./lib/registry');
const K = require('./ingest/common');
const CAL = require('./lib/calibration');
const ENS = require('./lib/ensemble');

const WIN = C.WINDOWS.team;
const TUNING_FILE = path.join(C.PATHS.params, 'team_tuning.json');
const CONST_FILE = path.join(C.PATHS.params, 'constants.json');
const ROWS_FILE = path.join(C.PATHS.cacheWork, 'wf_rows.json');
const OOS_FILE = path.join(C.PATHS.validation, 'oos_team_predictions.csv.gz');
const SCHEMA = 'edgedesk_cbase_walkforward_v1';
const CONSTANTS_WINDOW = [2017, 2022];   // inning-data seasons inside SELECTION

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.includes('--' + n); }
const r = V.r;
const windowOf = (s) => (P.inWin(s, WIN.selection) ? 'SELECTION' : P.inWin(s, WIN.validation) ? 'VALIDATION' : P.inWin(s, WIN.holdout) ? 'HOLDOUT' : 'BURN_IN');

function constants() {
  if (fs.existsSync(CONST_FILE)) { const c = JSON.parse(fs.readFileSync(CONST_FILE, 'utf8')); if (c.window[0] === CONSTANTS_WINDOW[0] && c.window[1] === CONSTANTS_WINDOW[1]) return c; }
  const c = KS.measure(CONSTANTS_WINDOW[0], CONSTANTS_WINDOW[1]);
  K.writeJson(CONST_FILE, c);
  return c;
}

/* the doubleheader seven-inning share, measured on the first box season (2024) only */
function p7Context() {
  let n = 0; let seven = 0;
  const RULES = require('./lib/rules');
  for (const g of W.games(2024)) {
    if (!W.usable(g) || !g.dh || !g.away_line) continue;
    const inf = RULES.inferScheduled(g); if (inf.scheduled !== 7 && inf.scheduled !== 9) continue;
    n++; if (inf.scheduled === 7) seven++;
  }
  const share = n ? seven / n : 0;
  return { fn: (g) => (g.dh ? share : 0), share, n, measured_on: 2024 };
}

function tuning() { return fs.existsSync(TUNING_FILE) ? JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8')) : { models: {} }; }

/* ---------------------------------------------------------------- calibration */
function fitCalibration(rows) {
  if (rows.length < 500) return null;
  const X = rows.map((x) => [1, S.logit(x.p), x.neutral ? 0 : 1]); const y = rows.map((x) => x.y);
  try { const f = S.logistic(X, y, { l2: 1e-6 }); return f.beta; } catch (_) { return null; }
}
function applyCalibration(beta, p, neutral) { return beta ? S.sigmoid(beta[0] + beta[1] * S.logit(p) + beta[2] * (neutral ? 0 : 1)) : p; }

/* ---------------------------------------------------------------- run */
function runAll(names, cfgs, o) {
  o = o || {};
  const games = W.results(C.SEASONS.first, o.until || C.SEASONS.last);
  const ctx = { meta: M.meta({ until: o.until }), constants: constants(), dist: tuning().dist };
  const p7 = p7Context(); ctx.p7 = p7.fn;
  const preds = {}; const timing = {};
  for (const n of names) {
    const t0 = Date.now();
    preds[n] = M.runModel(n, cfgs[n] || {}, games, ctx, { score: (g) => g.season >= WIN.selection[0], until: o.until }).preds;
    timing[n] = (Date.now() - t0) / 1000;
    if (!o.quiet) console.error(`  ${n}: ${timing[n].toFixed(1)}s`);
  }
  const rows = [];
  /* rest flags as of each game: did each side play on the previous date? (earlier dates only) */
  const lastPlayed = new Map(); const restOf = new Map();
  { let i = 0; while (i < games.length) { const d = games[i].date; let j = i; while (j < games.length && games[j].date === d) j++;
    const yday = K.addDays(d, -1);
    for (let q = i; q < j; q++) { const g = games[q]; restOf.set(g.game_id, { home_yday: lastPlayed.get(g.home_id) === yday ? 1 : 0, away_yday: lastPlayed.get(g.away_id) === yday ? 1 : 0, dh2: g.dh === 2 ? 1 : 0 }); }
    for (let q = i; q < j; q++) { lastPlayed.set(games[q].home_id, d); lastPlayed.set(games[q].away_id, d); }
    i = j; } }
  for (const g of games) {
    if (g.season < WIN.selection[0]) continue;
    const row = {
      game_id: g.game_id, season: g.season, date: g.date, window: windowOf(g.season), y: g.home_runs > g.away_runs ? 1 : 0,
      home_runs: g.home_runs, away_runs: g.away_runs, neutral: g.neutral, conf_game: g.conf_game, home_conf: g.home_conf, away_conf: g.away_conf,
      d1_both: g.home_div === 1 && g.away_div === 1 ? 1 : 0, weekday: g.weekday, dh: g.dh, tourney: g.ncaa_tourney_inferred, scheduled: g.scheduled_innings,
      predicted_at: K.predictAt(g.date), event_start: `${g.date}T${String(C.TIME.earliest_start_hour_utc).padStart(2, '0')}:00:00Z`, p: {},
    };
    Object.assign(row, restOf.get(g.game_id));
    for (const n of names) {
      const pr = preds[n].get(g.game_id); if (!pr) continue;
      row.p[n] = pr.p;
      if (pr.lh != null) { row[n + '_lh'] = pr.lh; row[n + '_la'] = pr.la; row[n + '_sd'] = pr.sd; row[n + '_p7'] = pr.p7 || 0; row[n + '_net'] = pr.net_home - pr.net_away; row[n + '_info'] = Math.min(pr.info_home, pr.info_away); }
    }
    rows.push(row);
  }
  /* calibrated variants: season S mapped with rows of S-3..S-1 only.
     Run models are calibrated in RUN SPACE (lib/calibration.js), so the moneyline,
     run lines and totals priced from the adjusted runs stay coherent; the other
     models get a logistic map on P(home). */
  const calMaps = {};
  const bySeason = new Map(); for (const x of rows) { if (!bySeason.has(x.season)) bySeason.set(x.season, []); bySeason.get(x.season).push(x); }
  for (const n of names) {
    const cn = n + '_cal'; calMaps[n] = {};
    const isRun = M.RUN_MODELS.includes(n);
    const table = isRun ? D.pHomeTable((cfgs[n] && cfgs[n].dist) || ctx.dist || { family: 'nb', r: 4 }, ctx.constants) : null;
    const f7 = ctx.constants.seven_inning_factor;
    for (const [s, xs] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      if (isRun) {
        const fitRows = []; for (let t = s - 3; t < s; t++) for (const x of (bySeason.get(t) || [])) if (x[n + '_lh'] != null) fitRows.push({ lh: x[n + '_lh'], la: x[n + '_la'], sd: x[n + '_sd'], y: x.y, neutral: x.neutral, p7: x[n + '_p7'] });
        const cal = CAL.fit(fitRows, table, f7); calMaps[n][s] = cal;
        for (const x of xs) {
          if (x[n + '_lh'] == null) continue;
          const [lh, la] = CAL.apply(x[n + '_lh'], x[n + '_la'], cal, x.neutral);
          x[n + '_cal_lh'] = lh; x[n + '_cal_la'] = la;
          x.p[cn] = CAL.pOf({ lh: x[n + '_lh'], la: x[n + '_la'], sd: x[n + '_sd'], neutral: x.neutral, p7: x[n + '_p7'] }, cal, table, f7);
        }
      } else {
        const fitRows = []; for (let t = s - 3; t < s; t++) for (const x of (bySeason.get(t) || [])) if (x.p[n] != null) fitRows.push({ p: x.p[n], y: x.y, neutral: x.neutral });
        const beta = fitCalibration(fitRows); calMaps[n][s] = beta ? beta.map((v) => Math.round(v * 1e5) / 1e5) : null;
        for (const x of xs) if (x.p[n] != null) x.p[cn] = applyCalibration(beta, x.p[n], x.neutral);
      }
    }
  }
  /* CHALLENGER hier_rest_cal: the rest layer (fitted on S-3..S-1) then the run-space calibration (fitted on
     the rest-adjusted expectations of S-3..S-1) */
  if (names.includes('hier')) {
    const table = D.pHomeTable((cfgs.hier && cfgs.hier.dist) || ctx.dist || { family: 'nb', r: 4 }, ctx.constants); const f7 = ctx.constants.seven_inning_factor;
    calMaps.hier_rest = {};
    for (const [s, xs] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
      const prior = []; for (let t = s - 3; t < s; t++) for (const x of (bySeason.get(t) || [])) if (x.hier_lh != null) prior.push(x);
      const layer = CAL.restFit(prior.map((x) => ({ lh: x.hier_lh, la: x.hier_la, home_runs: x.home_runs, away_runs: x.away_runs, home_yday: x.home_yday, away_yday: x.away_yday, dh2: x.dh2 })));
      const cal = CAL.fit(prior.filter((x) => x.hier_rest_lh != null).map((x) => ({ lh: x.hier_rest_lh, la: x.hier_rest_la, sd: x.hier_sd, y: x.y, neutral: x.neutral, p7: x.hier_p7 })), table, f7);
      calMaps.hier_rest[s] = { rest: layer, cal };
      for (const x of xs) {
        if (x.hier_lh == null) continue;
        const [lh, la] = CAL.restApply(x.hier_lh, x.hier_la, x, layer);
        x.hier_rest_lh = lh; x.hier_rest_la = la;
        x.p.hier_rest_cal = CAL.pOf({ lh, la, sd: x.hier_sd, neutral: x.neutral, p7: x.hier_p7 }, cal, table, f7);
        const [lh2, la2] = CAL.apply(lh, la, cal, x.neutral); x.hier_rest_cal_lh = lh2; x.hier_rest_cal_la = la2;
      }
    }
  }
  /* the ensemble (Model 8): weights fitted on SELECTION rows only, applied unchanged everywhere */
  /* (the learning loop scores one model at a time and asks for no ensemble: college_baseball/loop.js) */
  const ensModel = o.noEnsemble ? null : ENS.fit(rows.filter((x) => x.window === 'SELECTION'));
  if (ensModel) for (const x of rows) { const pe = ENS.predict(ensModel, x.p); if (pe != null) x.p.ens = pe; }
  return { rows, timing, p7, ctx, calMaps, ensModel };
}

/* ---------------------------------------------------------------- metrics */
function metrics(rows, model) {
  const rs = rows.filter((x) => x.p[model] != null).map((x) => ({ p: x.p[model], y: x.y, date: x.date }));
  const b = V.binary(rs);
  return { n: b.n, log_loss: b.log_loss, brier: b.brier, brier_skill: b.brier_skill, calibration_in_the_large: b.calibration_in_the_large, calibration_slope: b.calibration_slope, calibration_intercept: b.calibration_intercept, bins: b.bins };
}
function slices(rows, model) {
  const defs = {
    season: (x) => String(x.season),
    venue: (x) => (x.neutral ? 'neutral' : 'home'),
    conference_game: (x) => (x.conf_game ? 'conference' : 'non_conference'),
    day: (x) => (x.weekday === 5 || x.weekday === 6 || x.weekday === 0 ? 'weekend' : 'midweek'),
    opponent_division: (x) => (x.d1_both ? 'd1_vs_d1' : 'vs_non_d1'),
    ncaa_tourney: (x) => (x.tourney ? 'tourney_inferred' : 'regular'),
    season_phase: (x) => { const d = K.daysBetween(x.season + '-02-10', x.date); return d < 21 ? 'first_3_weeks' : d < 60 ? 'weeks_4_8' : 'later'; },
    favourite: (x) => { const p = x.p[model]; const f = Math.max(p, 1 - p); return f >= 0.75 ? 'heavy_fav' : f >= 0.6 ? 'moderate_fav' : 'tossup'; },
    home_conference: (x) => x.home_conf || 'none',
  };
  const out = {};
  for (const [name, fn] of Object.entries(defs)) {
    const groups = new Map(); for (const x of rows) { if (x.p[model] == null) continue; const k = fn(x); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    out[name] = {};
    for (const [k, xs] of groups) {
      if (name === 'home_conference' && xs.length < 300) continue;
      const m = V.binary(xs.map((x) => ({ p: x.p[model], y: x.y })));
      out[name][k] = { n: m.n, log_loss: m.log_loss, brier: m.brier, mean_p: m.mean_p, mean_y: m.mean_y, citl: m.calibration_in_the_large, sample_state: m.sample_state };
    }
  }
  return out;
}
function compare(rows, a, b) {
  const rs = rows.filter((x) => x.p[a] != null && x.p[b] != null);
  return P.compare(rs, (x) => V.logLoss(x.p[a], x.y), (x) => V.logLoss(x.p[b], x.y));
}

/* ---------------------------------------------------------------- report */
function report(run, names, o) {
  const rows = run.rows;
  const W2 = { SELECTION: rows.filter((x) => x.window === 'SELECTION'), VALIDATION: rows.filter((x) => x.window === 'VALIDATION'), HOLDOUT: rows.filter((x) => x.window === 'HOLDOUT') };
  const allNames = names.flatMap((n) => (n === 'hier' ? [n, n + '_cal', 'hier_rest_cal'] : [n, n + '_cal'])).concat(['ens']);
  const leak = V.leakageAudit(rows.map((x) => ({ id: x.game_id, predicted_at: x.predicted_at, event_start: x.event_start, inputs_known_at: K.availableAt(K.addDays(x.date, -1)) })));
  const sel = {}; for (const n of allNames) sel[n] = metrics(W2.SELECTION, n).log_loss;
  /* the incumbent is the simplest; a challenger must beat it by the protocol margin */
  /* the ensemble is fitted on SELECTION, so it is never chosen on SELECTION: it is adopted on VALIDATION (§3) */
  const chosen = P.choose(sel, selectionOrder(sel));
  const bestBaseline = M.BASELINES.flatMap((n) => [n, n + '_cal']).filter((n) => sel[n] != null).sort((a, b) => sel[a] - sel[b])[0];
  const out = {
    schema: SCHEMA, model_version: C.MODEL_VERSION, generated_at: o.now || null,
    protocol: 'college_baseball/research/PROTOCOL.md', windows: WIN,
    data: { point_in_time: 'RETROSPECTIVE', source: C.SOURCE.name, games_scored: rows.length, constants_window: CONSTANTS_WINDOW, seven_inning_dh_share: { share: r(run.p7.share), n: run.p7.n, measured_on: run.p7.measured_on } },
    leakage: leak,
    candidates: M.CANDIDATES, baselines: M.BASELINES,
    selection: { log_loss: sel, chosen, best_baseline: bestBaseline, rule: 'lowest SELECTION log loss; a challenger replaces the incumbent only if better by >= ' + P.RULES.challenger_margin },
    windows_report: {},
    comparisons: {},
    calibration_maps: run.calMaps,
    timing_seconds: run.timing,
    market: P.MARKET_NOT_TESTED,
  };
  for (const w of ['SELECTION', 'VALIDATION'].concat(o.holdout ? ['HOLDOUT'] : [])) {
    const rs = W2[w];
    out.windows_report[w] = { n: rs.length, seasons: [...new Set(rs.map((x) => x.season))], models: {} };
    for (const n of allNames) out.windows_report[w].models[n] = metrics(rs, n);
    out.windows_report[w].chosen_slices = slices(rs, chosen);
    out.comparisons[w] = {
      chosen_vs_best_baseline: compare(rs, chosen, bestBaseline),
      hier_vs_poisson_flat: compare(rs, 'hier', 'poisson_flat'),
      hier_vs_elo: compare(rs, 'hier', 'elo'),
      chosen_vs_raw: chosen.endsWith('_cal') ? compare(rs, chosen, chosen.replace(/_cal$/, '').replace(/_rest$/, '')) : null,
      ens_vs_chosen: compare(rs, 'ens', chosen),
      rest_vs_cal: compare(rs, 'hier_rest_cal', 'hier_cal'),
    };
  }
  /* the PRICING model: the ensemble if it beat the chosen model on VALIDATION with a 95% interval below zero */
  const ensAdopted = !!(out.comparisons.VALIDATION && out.comparisons.VALIDATION.ens_vs_chosen.a_better);
  const pricing = ensAdopted ? 'ens' : chosen;
  out.pricing = { model: pricing, ensemble_adopted: ensAdopted, ensemble: run.ensModel, coherent_runs: ensAdopted ? 'the run model\'s calibrated expectations shifted along their ratio until P(home) equals the ensemble (lib/ensemble.js)' : 'the chosen run model\'s run-space calibrated expectations',
    rule: 'the ensemble prices only if its VALIDATION log loss beats the chosen single model with a block-bootstrap 95% interval below zero' };
  if (!o.holdout) out.windows_report.HOLDOUT = { withheld: true, reason: 'reported only by --holdout (research/PROTOCOL.md §5)', n: W2.HOLDOUT.length };
  else {
    const h = out.windows_report.HOLDOUT;
    const seasons = h.seasons.length;
    out.comparisons.HOLDOUT.pricing_vs_best_baseline = compare(W2.HOLDOUT, pricing, bestBaseline);
    out.status = { moneyline: P.binaryStatus(h.models[pricing], seasons, out.comparisons.HOLDOUT.pricing_vs_best_baseline.a_better), model: pricing };
  }
  /* the shape the cross-sport readiness registry reads (engine/build_registry.js) */
  const mlWin = o.holdout ? out.windows_report.HOLDOUT : out.windows_report.VALIDATION;
  out.markets = {
    moneyline: Object.assign({ market: 'moneyline', model: pricing, n: mlWin.models[pricing].n, log_loss: mlWin.models[pricing].log_loss, window: o.holdout ? 'HOLDOUT' : 'VALIDATION' },
      out.status ? out.status.moneyline : { status: 'PROVISIONAL', failed: ['the HOLDOUT has not been evaluated for this model version'] }, P.MARKET_NOT_TESTED),
  };
  return out;
}

/* ---------------------------------------------------------------- tuning */
const GRIDS = {
  /* round 3 (2026-10-14, time-boxed: the last round): round 2 left hier carry 0.95, sigma_conf 0.07 and
     halflife 120 on edges and Elo k 16 on its lower edge, so those grids were extended once more. Rounds 1-2
     stay in the registry as earlier revisions. Elo carry 1.0 is the natural ceiling (no regression). */
  hier: { sigma_team: [0.10, 0.12, 0.14], sigma_conf: [0.05, 0.07, 0.09], carry_team: [0.9, 0.95, 1.0], phi: [1.25, 1.5, 1.75], halflife_days: [90, 120, 180] },
  poisson_flat: { sigma_team: [0.15, 0.18, 0.22], carry_team: [0.9, 0.95, 1.0], phi: [1.8, 2.2, 2.6] },
  elo: { k: [10, 12, 16, 20], home: [35, 40, 45], carry: [0.95, 1.0] },
  massey: { sigma: [1.0, 1.2, 1.5], carry: [0.8, 0.85, 0.9, 0.95] },
  bt: { sigma: [0.45, 0.6, 0.75], carry: [0.7, 0.75, 0.85, 0.95] },
  pythag: { prior_games: [15, 20, 30], carry: [0.5, 0.6, 0.7], home_logit: [0.25, 0.3, 0.35] },
};
function expand(grid) { let out = [{}]; for (const [k, vs] of Object.entries(grid)) { const nx = []; for (const o of out) for (const v of vs) nx.push(Object.assign({}, o, { [k]: v })); out = nx; } return out; }

/* cheap models: the full grid. Run models: a cached coordinate search (two passes
   over each axis from the middle of the grid), because one fit is ~1 minute. */
function tune(name) {
  const grid = GRIDS[name];
  const games = W.results(C.SEASONS.first, WIN.selection[1]);
  const ctx = { meta: M.meta(), constants: constants() }; ctx.p7 = p7Context().fn;
  const t = tuning(); if (t.dist && M.RUN_MODELS.includes(name)) ctx.dist = t.dist;
  const seen = new Map(); const results = [];
  const evalCfg = (g) => {
    const key = JSON.stringify(g); if (seen.has(key)) return seen.get(key);
    const cfg = M.RUN_MODELS.includes(name) ? { tq: g, dist: t.dist } : g;
    const t0 = Date.now();
    const { preds } = M.runModel(name, cfg, games, ctx, { score: (x) => P.inWin(x.season, WIN.selection) });
    const rs = []; for (const x of games) { const p = preds.get(x.game_id); if (p) rs.push({ p: p.p, y: x.home_runs > x.away_runs ? 1 : 0 }); }
    const b = V.binary(rs);
    const res = { cfg: g, log_loss: b.log_loss, n: b.n }; seen.set(key, res); results.push(res);
    console.error(`  ${name} ${key} -> ${b.log_loss} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return res;
  };
  const coordinate = M.RUN_MODELS.includes(name) || name === 'massey' || name === 'bt';
  if (!coordinate) for (const g of expand(grid)) evalCfg(g);
  else {
    let cur = {}; for (const [k, vs] of Object.entries(grid)) cur[k] = vs[Math.floor(vs.length / 2)];
    for (let pass = 0; pass < 2; pass++) {
      for (const [k, vs] of Object.entries(grid)) {
        let best = null;
        for (const v of vs) { const r2 = evalCfg(Object.assign({}, cur, { [k]: v })); if (!best || r2.log_loss < best.log_loss) best = r2; }
        cur = Object.assign({}, best.cfg);
      }
    }
  }
  results.sort((a, b) => a.log_loss - b.log_loss);
  const best = results[0];
  const t2 = tuning(); t2.models[name] = { cfg: best.cfg, selection_log_loss: best.log_loss, n: best.n, evaluated: results.length, window: WIN.selection };
  K.writeJson(TUNING_FILE, t2);
  REG.register({
    id: 'CBX-TUNE-' + name.toUpperCase(), family: 'team_' + name, title: `Tune ${name} on SELECTION`,
    hypothesis: `Hyperparameters of ${name} chosen by SELECTION log loss generalise to VALIDATION`,
    dataset: { warehouse: 'college_baseball/data', seasons: [C.SEASONS.first, WIN.selection[1]] },
    windows: { training: [C.SEASONS.first, WIN.selection[1]], validation: null, holdout: null, scored: WIN.selection },
    features: ['results'].concat(M.RUN_MODELS.includes(name) ? ['runs', 'home/neutral', name === 'hier' ? 'conference/division hierarchy, parks' : 'flat'] : []),
    algorithm: { name, grid: GRIDS[name], search: coordinate ? 'coordinate, 2 passes' : 'full grid', evaluated: results.length }, seeds: [], metrics: { best: best.log_loss, worst: results[results.length - 1].log_loss, top5: results.slice(0, 5) },
    uncertainty: null, decision: 'ACCEPT', justification: 'grid search on SELECTION only; the chosen configuration is used unchanged on VALIDATION and HOLDOUT',
    holdout_evaluated: false,
  });
  return best;
}

/* ---------------------------------------------------------------- main */
/* the learning loop's served version (docs/model-loop/college_baseball/versions.json), when one has been
   released through its holdout look (college_baseball/loop.js); a STAGED version is never served */
const LOOP_VERSIONS = path.join(__dirname, '..', 'docs', 'model-loop', 'college_baseball', 'versions.json');
function servedLoopVersion() {
  try {
    const d = JSON.parse(fs.readFileSync(LOOP_VERSIONS, 'utf8'));
    const v = d.versions.find((x) => x.version === d.current);
    return v && String(v.status).startsWith('SERVED') && v.config && v.config.tq ? v : null;
  } catch (_) { return null; }
}
function stableJson(o) { return Array.isArray(o) ? '[' + o.map(stableJson).join(',') + ']' : o && typeof o === 'object' ? '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}' : JSON.stringify(o); }
/** the identity of the served run model's configuration: a holdout look belongs to exactly one */
function configHash(c) { return crypto.createHash('sha256').update(stableJson({ tq: (c && c.tq) || {}, dist: (c && c.dist) || null })).digest('hex'); }

function cfgsFromTuning() {
  const t = tuning(); const out = {};
  for (const n of M.CANDIDATES) { const c = t.models[n] && t.models[n].cfg; if (!c) continue; out[n] = M.RUN_MODELS.includes(n) ? { tq: c } : c; }
  const dist = t.dist; if (dist) for (const n of M.RUN_MODELS) out[n] = Object.assign(out[n] || { tq: {} }, { dist });
  const lv = servedLoopVersion();
  if (lv) out.hier = { tq: Object.assign({}, lv.config.tq), dist: lv.config.dist || dist, loop_version: lv.version };
  /* the home-rate baseline uses the burn-in + selection home win rate */
  let hw = 0; let hn = 0; for (const g of W.results(C.SEASONS.first, WIN.selection[1])) if (!g.neutral) { hn++; if (g.home_runs > g.away_runs) hw++; }
  out.home_rate = { rate: hw / hn };
  return out;
}

function writeOutputs(rep, run) {
  K.writeJson(C.PATHS.walkforward, rep);
  fs.mkdirSync(path.dirname(ROWS_FILE), { recursive: true });
  fs.writeFileSync(ROWS_FILE, JSON.stringify(run.rows));
  /* the committed out-of-sample record: every scored game, every model, raw and calibrated */
  const names = [...new Set(run.rows.flatMap((x) => Object.keys(x.p)))];
  const header = ['game_id', 'season', 'date', 'window', 'y', 'home_runs', 'away_runs', 'neutral', 'home_yday', 'away_yday', 'dh2', 'hier_lh', 'hier_la', 'hier_sd', 'hier_p7', 'hier_cal_lh', 'hier_cal_la', 'hier_rest_lh', 'hier_rest_la', 'hier_rest_cal_lh', 'hier_rest_cal_la'].concat(names.map((n) => 'p_' + n));
  const lines = [header.join(',')];
  for (const x of run.rows) lines.push([x.game_id, x.season, x.date, x.window, x.y, x.home_runs, x.away_runs, x.neutral, x.home_yday, x.away_yday, x.dh2, r(x.hier_lh, 4), r(x.hier_la, 4), r(x.hier_sd, 4), r(x.hier_p7, 4), r(x.hier_cal_lh, 4), r(x.hier_cal_la, 4), r(x.hier_rest_lh, 4), r(x.hier_rest_la, 4), r(x.hier_rest_cal_lh, 4), r(x.hier_rest_cal_la, 4)].concat(names.map((n) => (x.p[n] == null ? '' : r(x.p[n], 5)))).join(','));
  K.writeIfChanged(OOS_FILE, lines.join('\n') + '\n');
}

function check() {
  const rep = JSON.parse(fs.readFileSync(C.PATHS.walkforward, 'utf8'));
  const errs = [];
  if (rep.schema !== SCHEMA) errs.push('schema');
  if (!rep.leakage || !rep.leakage.ok) errs.push('leakage violations: ' + (rep.leakage && rep.leakage.violations));
  if (rep.data.point_in_time !== 'RETROSPECTIVE') errs.push('point_in_time label');
  if (rep.market.market_status !== 'NOT_TESTED') errs.push('market status must be NOT_TESTED');
  if (!rep.selection.chosen) errs.push('no chosen model');
  if (errs.length) { console.error('walkforward check FAILED: ' + errs.join('; ')); process.exit(1); }
  console.log('walkforward check ok: chosen ' + rep.selection.chosen);
}

/* A run without --holdout (the weekly refit) must not erase the holdout record of the version it refits.
   The registered look for THIS model version and THIS pricing model is carried forward unchanged and
   labelled; it is a restatement, not a new look (nothing is chosen from it). Any other change — a new
   version, a different pricing model — leaves the holdout withheld until --holdout is run. */
/* every holdout look, kept by the configuration it measured (validation/holdout_looks.json): a look is
   carried forward only to a report of that same configuration, so a changed configuration never wears an
   old look, and a rollback finds its own look again without spending a new one */
const LOOKS_FILE = path.join(C.PATHS.validation, 'holdout_looks.json');
function loadLooks() { try { return JSON.parse(fs.readFileSync(LOOKS_FILE, 'utf8')); } catch (_) { return { schema: 'edgedesk_cbase_holdout_looks_v1', looks: {} }; } }
function lookOf(rep) {
  return { model_version: rep.model_version, pricing: rep.pricing, status: rep.status, holdout_evaluated_at: rep.holdout_evaluated_at || rep.generated_at,
    windows_report: { HOLDOUT: rep.windows_report.HOLDOUT }, comparisons: { HOLDOUT: rep.comparisons.HOLDOUT }, markets: rep.markets, config_sha256: rep.config_sha256 };
}
function saveLook(rep) {
  const L = loadLooks(); L.looks[rep.config_sha256] = lookOf(rep);
  K.writeJson(LOOKS_FILE, L);
}
/** the look this report may carry: its configuration's stored look, else (before looks were stored) the
    previous report's, when that report was made with the same configuration */
function lookFor(rep, prev, looks) {
  const stored = looks && looks.looks && looks.looks[rep.config_sha256];
  if (stored) return stored;
  if (!prev) return null;
  if (prev.config_sha256) return prev.config_sha256 === rep.config_sha256 ? prev : null;
  return rep.legacy_config ? prev : null;
}

function carryHoldout(rep, prev) {
  const h = prev && prev.windows_report && prev.windows_report.HOLDOUT;
  if (!h || h.withheld || !prev.status || prev.model_version !== rep.model_version || !prev.pricing || prev.pricing.model !== rep.pricing.model) return false;
  const at = prev.holdout_evaluated_at || prev.generated_at;
  rep.windows_report.HOLDOUT = Object.assign({}, h, { carried_from: at, note: 'the registered holdout look for this model version, carried forward unchanged; a new look needs --holdout' });
  rep.comparisons.HOLDOUT = prev.comparisons.HOLDOUT; rep.status = prev.status; rep.holdout_evaluated_at = at;
  if (prev.markets && prev.markets.moneyline) rep.markets.moneyline = prev.markets.moneyline;
  return true;
}
/** the selection order: simplest first, each model before its calibrated form, the rest challenger after hier_cal */
function selectionOrder(sel) { return M.CANDIDATES.flatMap((n) => (n === 'hier' ? [n, n + '_cal', 'hier_rest_cal'] : [n, n + '_cal'])).filter((n) => sel[n] != null); }

function main() {
  if (flag('check')) return check();
  if (flag('tune')) { const n = arg('tune', 'hier'); const best = tune(n); console.log(n, JSON.stringify(best)); return; }
  const names = M.CANDIDATES;
  const cfgs = cfgsFromTuning();
  const run = runAll(names, cfgs, {});
  const rep = report(run, names, { holdout: flag('holdout'), now: new Date().toISOString() });
  rep.config_sha256 = configHash(cfgs.hier);
  rep.loop_version = (cfgs.hier && cfgs.hier.loop_version) || null;
  /* the configuration team_tuning.json names (reports made before config_sha256 existed were made with it) */
  const t0 = tuning(); rep.legacy_config = !rep.loop_version && configHash({ tq: t0.models.hier && t0.models.hier.cfg, dist: t0.dist }) === rep.config_sha256;
  if (flag('holdout')) { rep.holdout_evaluated_at = rep.generated_at; saveLook(rep); }
  else {
    let prev = null; try { prev = JSON.parse(fs.readFileSync(C.PATHS.walkforward, 'utf8')); } catch (_) { /* first run */ }
    const look = lookFor(rep, prev, loadLooks());
    if (carryHoldout(rep, look) && !(loadLooks().looks[rep.config_sha256])) saveLook(rep);
  }
  delete rep.legacy_config;
  writeOutputs(rep, run);
  const v = rep.windows_report.VALIDATION.models; const s = rep.windows_report.SELECTION.models;
  console.log('model'.padEnd(18) + 'SELECTION ll'.padStart(14) + 'VALIDATION ll'.padStart(15) + '  citl   slope');
  for (const n of Object.keys(v)) console.log(n.padEnd(18) + String(s[n].log_loss).padStart(14) + String(v[n].log_loss).padStart(15) + '  ' + v[n].calibration_in_the_large + '  ' + v[n].calibration_slope);
  console.log('pricing model:', rep.pricing.model, 'ensemble adopted:', rep.pricing.ensemble_adopted);
  console.log('chosen:', rep.selection.chosen, 'best baseline:', rep.selection.best_baseline, 'leakage ok:', rep.leakage.ok);
  for (const [w, c] of Object.entries(rep.comparisons)) console.log(w, 'chosen vs best baseline', JSON.stringify(c.chosen_vs_best_baseline));
  const vw = rep.windows_report.VALIDATION; const pm = rep.pricing.model;
  REG.register({ id: 'CBX-TEAM-WALKFORWARD', family: 'team_pricing', title: 'Team models, chronological walk-forward (SELECTION choice, VALIDATION report)',
    hypothesis: 'An opponent-adjusted, partially pooled run model beats results-only baselines out of sample and is calibrated',
    dataset: { warehouse: 'college_baseball/data', games_scored: rep.data.games_scored }, windows: { training: [C.SEASONS.first, WIN.selection[1]], validation: WIN.validation, holdout: null },
    features: ['results', 'runs', 'home/neutral', 'conference/division hierarchy', 'parks', 'carryover priors', 'run-space calibration', 'rest layer (challenger)', 'ensemble (challenger)'],
    algorithm: { candidates: Object.keys(rep.selection.log_loss), chosen: rep.selection.chosen, pricing: pm, tuning: tuning().models }, seeds: [20261013],
    metrics: { selection: rep.selection.log_loss, validation: Object.fromEntries(Object.entries(vw.models).map(([k, v]) => [k, v.log_loss])) },
    uncertainty: rep.comparisons.VALIDATION, decision: rep.comparisons.VALIDATION.chosen_vs_best_baseline.a_better ? 'ACCEPT' : 'REJECT',
    justification: `chosen ${rep.selection.chosen} by the SELECTION rule; pricing ${pm}; VALIDATION vs best baseline ${JSON.stringify(rep.comparisons.VALIDATION.chosen_vs_best_baseline.ci95)}`, holdout_evaluated: false });
  if (flag('holdout')) {
    const hp = rep.windows_report.HOLDOUT.models[pm];
    REG.register({ id: 'CBX-TEAM-HOLDOUT', family: 'team_pricing', title: 'Pricing model on the untouched HOLDOUT (2025-2026)', hypothesis: 'The VALIDATION result holds on the HOLDOUT',
      dataset: { warehouse: 'college_baseball/data' }, windows: { training: [C.SEASONS.first, WIN.validation[1]], validation: WIN.validation, holdout: WIN.holdout }, features: ['as CBX-TEAM-WALKFORWARD'],
      algorithm: { pricing: pm }, seeds: [20261013], metrics: { holdout: { n: hp.n, log_loss: hp.log_loss, brier: hp.brier, citl: hp.calibration_in_the_large, slope: hp.calibration_slope } },
      uncertainty: rep.comparisons.HOLDOUT, decision: rep.status.moneyline.status === 'OUTCOME_VALIDATED' ? 'ACCEPT' : 'INCONCLUSIVE', justification: rep.status.moneyline.status + (rep.status.moneyline.failed.length ? ': ' + rep.status.moneyline.failed.join('; ') : ''), holdout_evaluated: true });
  }
  if (flag('holdout')) {
    const h = rep.windows_report.HOLDOUT.models[rep.selection.chosen];
    console.log('HOLDOUT', rep.selection.chosen, JSON.stringify({ n: h.n, ll: h.log_loss, brier: h.brier, citl: h.calibration_in_the_large, slope: h.calibration_slope }), JSON.stringify(rep.status));
  }
  return { rep, run };
}

if (require.main === module) main();
module.exports = { CAL, runAll, report, carryHoldout, lookFor, loadLooks, configHash, servedLoopVersion, LOOP_VERSIONS, selectionOrder, metrics, slices, compare, constants, p7Context, cfgsFromTuning, tuning, GRIDS, windowOf, fitCalibration, applyCalibration, ROWS_FILE, WIN };
