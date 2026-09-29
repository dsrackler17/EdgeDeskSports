#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS — the walk-forward validation (Validation_Eval as gates).
   docs/player-props/VALIDATION.md

     node football/props/backtest.js [--from 2025-3] [--to 2026-3]
                                     [--sims 2000] [--write]

   For every week in range, every game is projected AS OF KICKOFF − 3 HOURS
   by the exact functions the live build uses (football/props/project.js),
   from rows strictly earlier than that moment: box scores, snaps, play-by-
   play, the pregame injury report, depth-chart snapshots published before
   it, priors and gain pools fitted on earlier games only. Nothing is ever
   shuffled; each week is its own fold (V001 rolling origin).

   What the live build has that the backtest does not, stated rather than
   hidden: the game environment comes from EdgeDesk's leak-free points
   history instead of the EdgeDesk game model (no archive of the model's
   pregame numbers exists for these games), and there is no archived
   weather forecast (the observed wind is postgame information, so it is
   NOT used). Both make the backtest a conservative estimate of the live
   player layer.

   SCORES (per prop type, per position)
     V010 CRPS of the full distribution vs two baselines: the player's own
          last-8 empirical distribution ("hit rate") and a Marcel mean
     V011/V012 MAE / RMSE of the mean vs Marcel and vs the last-3 average
     V009 randomized PIT histogram (deciles) and its largest deviation
     V022 central-interval coverage at 50 / 80 / 90%
     V005/V006/V007/V008 Brier, log loss, reliability bins and the
          calibration slope at a SYNTHETIC line (the Marcel mean on the half
          point — the kind of number a book posts; no historical prop lines
          exist in any archive, so market benchmarking waits for captures)
     V002 leakage audit: every input's timestamp checked against the cutoff
     Phase-5 acceptance: redistribution — recipients of an absent teammate's
          targets/carries, model error vs the naive pre-absence share
   =========================================================================== */
'use strict';
const path = require('path');
const P = require('../../lib/edgedesk_props.js');
const D = require('./nfl_data.js');
const M = require('./model.js');
const PR = require('./priors.js');
const PJ = require('./project.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');
const C = require('./calibrate.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const r = (x, k) => (typeof x === 'number' && isFinite(x) ? Math.round(x * Math.pow(10, k == null ? 4 : k)) / Math.pow(10, k == null ? 4 : k) : null);
const mean = (a) => (a.length ? a.reduce((t, v) => t + v, 0) / a.length : null);

function pitIn(u, level) { const a = (1 - level) / 2; return u >= a && u <= 1 - a; }
/* the empirical last-8 distribution of a player's own stat (the naive
   bettor's "hit rate" view), recency-weighted, as a stored distribution */
function empiricalDist(values, weights) {
  if (values.length < 3) return null;
  const counts = {}; let n = 0;
  values.forEach((v, i) => { const w = Math.round((weights ? weights[i] : 1) * 1000); counts[Math.round(v)] = (counts[Math.round(v)] || 0) + w; n += w; });
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const lo = keys[0], hi = keys[keys.length - 1], pmf = [];
  for (let k = lo; k <= hi; k++) pmf.push(counts[k] || 0);
  return { lo, n, pmf };
}

async function run() {
  const from = (arg('from', '2025-3')).split('-').map(Number), to = (arg('to', '2026-3')).split('-').map(Number);
  const sims = Number(arg('sims', 2000));
  const data = await D.load({ seasons: [2024, 2025, 2026] });
  const games = [...data.games.values()].filter((g) => g.game_type === 'REG' && isFinite(Date.parse(g.kickoff)) && g.home_score != null &&
    (g.season > from[0] || (g.season === from[0] && g.week >= from[1])) && (g.season < to[0] || (g.season === to[0] && g.week <= to[1])))
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  const weeks = [...new Set(games.map((g) => g.season + '-' + g.week))];
  const ix = M.index(data);
  const rows = [];
  let leak = 0;
  const leakNotes = [];
  const redis = { tgt: { n: 0, model: [], naive: [] }, car: { n: 0, model: [], naive: [] } };
  const t0 = Date.now();
  for (const wk of weeks) {
    const [season, week] = wk.split('-').map(Number);
    const wg = games.filter((g) => g.season === season && g.week === week);
    const weekCut = Math.min.apply(null, wg.map((g) => Date.parse(g.kickoff))) - 3 * 3600e3;
    const lg = PR.priorsAsOf(data, weekCut, season, D.poolsAsOf);
    if (Date.parse(lg.as_of) > weekCut) { leak++; leakNotes.push('priors after cutoff ' + wk); }
    for (const g of wg) {
      const asOf = Date.parse(g.kickoff) - 3 * 3600e3;
      const envRaw = M.leakFreeEnv(data, g, asOf, season, lg.hfa);
      const env = { source: 'points_history', margin: envRaw.margin, total: envRaw.total, home_points: envRaw.home_points, away_points: envRaw.away_points, margin_sd: lg.env.margin_sd, total_sd: lg.env.total_sd };
      let out;
      try { out = PJ.projectGame(data, { league: 'NFL', game: g, asOfMs: asOf, season, lg, env, weather: { known: false, outdoor: g.roof === 'outdoors' }, starters: {}, qb_unresolved: {}, sims }); }
      catch (e) { console.error('  ' + g.game_id + ': ' + e.message); continue; }
      /* V002: every timestamped input used must precede the cutoff */
      ['home', 'away'].forEach((s) => { const t = out.teams[s]; if (t.depth_snapshot_at && Date.parse(t.depth_snapshot_at) >= asOf) { leak++; leakNotes.push('depth chart after cutoff ' + g.game_id); } });
      const box = new Map((ix.pgByGame.get(g.game_id) || []).map((x) => [x.gsis, x]));
      out.records.forEach((p) => {
        if (p.status !== 'PROJECTED' || !p.dist) return;
        const gsis = p.provider_ids.gsis;
        const act = box.get(gsis);
        if (!act) return; /* did not play: a book voids the prop; not scored */
        const y = PJ.ACTUAL[p.prop_type](act);
        if (y == null || !isFinite(y)) return;
        const hist = M.before(ix.byPlayer.get(gsis) || [], asOf);
        if (hist.some((x) => Date.parse(x.kickoff) >= asOf)) { leak++; leakNotes.push('history row after cutoff ' + gsis); }
        const vals = hist.slice(0, 8).map(PJ.ACTUAL[p.prop_type]).filter((v) => v != null && isFinite(v));
        const w = vals.map((_, i) => Math.pow(0.5, i / 4));
        const emp = empiricalDist(vals, w);
        const marcel = p.baseline ? p.baseline.mean : null;
        const l3 = vals.length >= 3 ? mean(vals.slice(0, 3)) : null;
        const line = marcel != null ? Math.floor(marcel) + 0.5 : null;
        const u = P.rng(P.hash(p.projection_id).split('').reduce((t, c) => t * 31 + c.charCodeAt(0) >>> 0, 7))();
        const pOver = line != null ? P.probAt(p.dist, line).over : null;
        const pEmp = line != null && emp ? P.probAt(emp, line).over : null;
        rows.push({ dist: p.dist, u, season, week, game_id: g.game_id, prop: p.prop_type, pos: p.position, tier: p.tier, y, mean: p.summary.mean, median: p.summary.median,
          crps: P.crps(p.dist, y), crps_emp: emp ? P.crps(emp, y) : null, pit: P.pit(p.dist, y, u),
          /* central-interval coverage on the randomized PIT: the discrete
             equivalent of "inside the 80% interval" (a whole-number atom can
             never be split by an interval of integers) */
          in50: pitIn(P.pit(p.dist, y, u), 0.5), in80: pitIn(P.pit(p.dist, y, u), 0.8), in90: pitIn(P.pit(p.dist, y, u), 0.9),
          marcel, l3, line, p_over: pOver, p_emp: pEmp, over: line != null ? (y > line ? 1 : 0) : null, rel_n: p.reliability_inputs ? p.reliability_inputs.sample_n : null });
      });
      /* phase 5: the teammates who inherited an absent player's share */
      ['home', 'away'].forEach((s) => (out.teams[s].redistribution || []).filter((d) => d.status === 'OUT' && d.share >= 0.06).forEach((d) => {
        d.recipients.forEach((q) => {
          const rec = out.records.find((x) => x.provider_ids.gsis === q.player_id && (d.kind === 'tgt' ? x.prop_type === 'targets' || x.prop_type === 'receptions' : x.prop_type === 'rush_att'));
          const act = box.get(q.player_id);
          if (!rec || !act || !rec.opportunity) return;
          const team = out.teams[s];
          const tgActual = data.teamGames.get(g.game_id + '|' + team.team);
          if (!tgActual) return;
          const denom = d.kind === 'tgt' ? tgActual.targets : tgActual.designed;
          const actualShare = denom ? (d.kind === 'tgt' ? act.tgt : (act.des != null ? act.des : act.car)) / denom : null;
          const modelShare = d.kind === 'tgt' ? rec.opportunity.target_share : rec.opportunity.carry_share;
          const naive = modelShare - d.share * q.fraction;
          if (actualShare == null) return;
          const R0 = redis[d.kind];
          R0.n++; R0.model.push(Math.abs(modelShare - actualShare)); R0.naive.push(Math.abs(naive - actualShare));
        });
      }));
    }
    console.log('  fold ' + wk + ': ' + wg.length + ' games · ' + rows.length + ' scored so far · ' + Math.round((Date.now() - t0) / 1000) + 's');
  }
  return calibrateAndSummarize(rows, weeks, leak, leakNotes, redis, sims, from, to);
}

/* V021: fit the per-prop calibration on the TUNING fold only, then score the
   untouched later HOLDOUT fold both raw and calibrated. The stage gates read
   the calibrated holdout — never a number measured on the games it was fitted on. */
const TUNE_END = { season: 2025, week: 12 };
function inTuning(x) { return x.season < TUNE_END.season || (x.season === TUNE_END.season && x.week <= TUNE_END.week); }
function rescore(x, dist) {
  const d = dist;
  const pOver = x.line != null ? P.probAt(d, x.line).over : null;
  const mo = P.moments(d);
  return Object.assign({}, x, { dist: d, mean: mo.mean, crps: P.crps(d, x.y), pit: P.pit(d, x.y, x.u),
    in50: pitIn(P.pit(d, x.y, x.u), 0.5), in80: pitIn(P.pit(d, x.y, x.u), 0.8), in90: pitIn(P.pit(d, x.y, x.u), 0.9), p_over: pOver });
}
function calibrateAndSummarize(rows, weeks, leak, leakNotes, redis, sims, from, to) {
  const tune = rows.filter(inTuning), hold = rows.filter((x) => !inTuning(x));
  const calib = { schema: 'edgedesk_props_calibration_v1', league: 'NFL', version: 'props_nfl_calibration_v1', model_version: PJ.MODEL_VERSION.NFL, generated_at: new Date().toISOString(),
    tuning_range: from.join('-') + ' to ' + TUNE_END.season + '-' + TUNE_END.week, holdout_range: 'after ' + TUNE_END.season + '-' + TUNE_END.week + ' to ' + to.join('-'), method: 'grid search of (λ, κ) minimising mean CRPS on the tuning fold (football/props/calibrate.js)', by_prop: {} };
  P.PROP_ORDER.forEach((k) => {
    const t = tune.filter((x) => x.prop === k && x.marcel != null);
    const f = C.fit(t.map((x) => ({ dist: x.dist, baseline: x.marcel, y: x.y })), P.propType(k).kind === 'binary');
    if (f) calib.by_prop[k] = f;
  });
  const holdCal = hold.map((x) => { const c = calib.by_prop[x.prop]; return c && x.marcel != null ? rescore(x, C.transform(x.dist, c.lambda, c.kappa, x.marcel, P.propType(x.prop).kind === 'binary')) : x; });
  const all = summarize(rows, weeks, leak, leakNotes, redis, sims, from, to);
  const rawHold = summarize(hold, weeks, leak, leakNotes, redis, sims, from, to);
  const calHold = summarize(holdCal, weeks, leak, leakNotes, redis, sims, from, to);
  const out = Object.assign({}, calHold, { method: all.method + '; per-prop calibration fitted on ' + calib.tuning_range + ' and scored on the untouched holdout (' + calib.holdout_range + ')',
    n_all: all.n, n_holdout: calHold.n, folds_all: all.folds,
    by_prop: calHold.by_prop, by_prop_holdout_raw: rawHold.by_prop, by_prop_all_raw: all.by_prop, calibration: calib.by_prop, redistribution: all.redistribution });
  out.leakage_violations = leak;
  Object.keys(out.by_prop).forEach((k) => { const b = out.by_prop[k]; b.synthetic_slope = b.synthetic_line && b.synthetic_line.calibration_fit ? b.synthetic_line.calibration_fit.slope : null; });
  out._calibration_file = calib;
  rows.forEach((x) => { delete x.dist; });
  return out;
}

function summarize(rows, weeks, leak, leakNotes, redis, sims, from, to) {
  function block(list) {
    const n = list.length;
    if (!n) return null;
    const crps = mean(list.map((x) => x.crps)), withEmp = list.filter((x) => x.crps_emp != null);
    const pit = new Array(10).fill(0); list.forEach((x) => { pit[Math.min(9, Math.floor(x.pit * 10))]++; });
    const pitDev = Math.max.apply(null, pit.map((c) => Math.abs(c / n - 0.1)));
    const mae = mean(list.map((x) => Math.abs(x.mean - x.y))), withM = list.filter((x) => x.marcel != null), withL3 = list.filter((x) => x.l3 != null);
    const synth = list.filter((x) => x.p_over != null && x.over != null);
    const pairs = synth.map((x) => ({ p: x.p_over, y: x.over }));
    const brier = mean(synth.map((x) => (x.p_over - x.over) * (x.p_over - x.over)));
    const synthE = synth.filter((x) => x.p_emp != null);
    return { n, folds: new Set(list.map((x) => x.season + '-' + x.week)).size,
      crps: r(crps, 4), crps_baseline: withEmp.length ? r(mean(withEmp.map((x) => x.crps_emp)), 4) : null, crps_model_same_n: withEmp.length ? r(mean(withEmp.map((x) => x.crps)), 4) : null, crps_baseline_n: withEmp.length,
      mae: r(mae, 3), rmse: r(Math.sqrt(mean(list.map((x) => (x.mean - x.y) * (x.mean - x.y)))), 3), bias: r(mean(list.map((x) => x.mean - x.y)), 3),
      mae_marcel: withM.length ? r(mean(withM.map((x) => Math.abs(x.marcel - x.y))), 3) : null, mae_model_marcel_n: withM.length ? r(mean(withM.map((x) => Math.abs(x.mean - x.y))), 3) : null,
      mae_last3: withL3.length ? r(mean(withL3.map((x) => Math.abs(x.l3 - x.y))), 3) : null, mae_model_last3_n: withL3.length ? r(mean(withL3.map((x) => Math.abs(x.mean - x.y))), 3) : null,
      pit_hist: pit.map((c) => r(c / n, 4)), pit_max_dev: r(pitDev, 4),
      coverage50: r(mean(list.map((x) => (x.in50 ? 1 : 0))), 4), coverage80: r(mean(list.map((x) => (x.in80 ? 1 : 0))), 4), coverage90: r(mean(list.map((x) => (x.in90 ? 1 : 0))), 4),
      synthetic_line: synth.length ? { n: synth.length, brier: r(brier, 5), log_loss: r(mean(synth.map((x) => -(x.over * Math.log(Math.max(1e-6, x.p_over)) + (1 - x.over) * Math.log(Math.max(1e-6, 1 - x.p_over))))), 5),
        brier_coinflip: 0.25, brier_hit_rate: synthE.length ? r(mean(synthE.map((x) => (x.p_emp - x.over) * (x.p_emp - x.over))), 5) : null, brier_model_hit_rate_n: synthE.length ? r(mean(synthE.map((x) => (x.p_over - x.over) * (x.p_over - x.over))), 5) : null,
        over_rate: r(mean(synth.map((x) => x.over)), 4), mean_p_over: r(mean(synth.map((x) => x.p_over)), 4), calibration: P.calibrationBins(pairs, 10), calibration_fit: P.calibrationFit(pairs) } : null };
  }
  const by_prop = {}, by_pos = {};
  P.PROP_ORDER.forEach((k) => { const b = block(rows.filter((x) => x.prop === k)); if (b) by_prop[k] = b; });
  ['QB', 'RB', 'WR', 'TE'].forEach((p) => { const b = block(rows.filter((x) => x.pos === p)); if (b) by_pos[p] = b; });
  const byPropPos = {};
  rows.forEach((x) => { const k = x.prop + '|' + x.pos; (byPropPos[k] = byPropPos[k] || []).push(x); });
  const prop_pos = {};
  Object.keys(byPropPos).forEach((k) => { if (byPropPos[k].length >= 100) { const b = block(byPropPos[k]); prop_pos[k] = { n: b.n, crps: b.crps, crps_baseline: b.crps_baseline, mae: b.mae, mae_marcel: b.mae_marcel, coverage80: b.coverage80, pit_max_dev: b.pit_max_dev, bias: b.bias }; } });
  const red = {};
  Object.keys(redis).forEach((k) => { const R0 = redis[k]; red[k] = { n: R0.n, model_mae: r(mean(R0.model), 4), naive_mae: r(mean(R0.naive), 4), basis: 'absolute error of the projected share for teammates of an absent player (share ≥ 6%), vs the naive pre-absence share' }; });
  return { schema: 'edgedesk_props_validation_v1', league: 'NFL', model_version: PJ.MODEL_VERSION.NFL, generated_at: new Date().toISOString(), method: 'walk-forward, one fold per week, projected at kickoff − 3h from rows strictly earlier (football/props/backtest.js)',
    range: { from: from.join('-'), to: to.join('-') }, folds: weeks.length, sims_per_game: sims, n: rows.length, leakage_violations: leak, leakage_notes: leakNotes.slice(0, 20),
    caveats: ['Game environment from EdgeDesk’s leak-free points history, not the EdgeDesk game model (no archive of its pregame numbers for these games).', 'No archived weather forecast: observed wind is postgame information and is not used.', 'No historical sportsbook prop lines exist in any archive: probability quality is scored at a synthetic line (the Marcel mean on the half point). Market benchmarking (V004), CLV (V013) and ROI (V015) start with live captures.', 'Players who did not play are not scored (a book voids the prop).'],
    by_prop, by_position: by_pos, by_prop_position: prop_pos, redistribution: red };
}

if (require.main === module) {
  run().then((v) => {
    const out = path.join(__dirname, 'nfl', 'validation.json');
    const calib = v._calibration_file; delete v._calibration_file;
    if (process.argv.includes('--write')) {
      console.log(writeIfChanged(out, v, { pretty: true }) + ' ' + path.relative(path.join(__dirname, '..', '..'), out));
      const cf = path.join(__dirname, 'nfl', 'calibration.json');
      console.log(writeIfChanged(cf, calib, { pretty: true }) + ' ' + path.relative(path.join(__dirname, '..', '..'), cf));
    }
    console.log('calibration (tuning fold):', JSON.stringify(calib.by_prop));
    console.log('HOLDOUT, calibrated — n=' + v.n_holdout);
    Object.keys(v.by_prop).forEach((k) => { const b = v.by_prop[k]; console.log(k.padEnd(14) + ' n=' + String(b.n).padEnd(6) + ' CRPS ' + b.crps + ' vs last-8 ' + b.crps_baseline + ' (model on same n ' + b.crps_model_same_n + ') · MAE ' + b.mae + ' vs Marcel ' + b.mae_marcel + ' · cov80 ' + b.coverage80 + ' · PITdev ' + b.pit_max_dev + (b.synthetic_line ? ' · Brier ' + b.synthetic_line.brier + ' vs hit-rate ' + b.synthetic_line.brier_hit_rate + ' slope ' + b.synthetic_line.calibration_fit.slope : '')); });
    console.log('leakage violations: ' + v.leakage_violations, JSON.stringify(v.redistribution));
  }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
module.exports = { run, summarize, empiricalDist };
