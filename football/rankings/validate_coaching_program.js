#!/usr/bin/env node
/* ============================================================================
   COACHING / PROGRAM EDGE — CFB WALK-FORWARD CAP SELECTION

   This experiment answers one narrow question:
     does the measured Coaching / Program component improve COLLEGE FOOTBALL
     ETSR out of sample enough to deserve a point adjustment, and if so how
     large should the cap be?

   It does not borrow an answer from the NFL or any other sport. The tested CFB
   caps are 0, ±0.5, ±1.0, ±1.5 and ±2.0 points.

   MODEL A: ETSR with Coaching / Program cap = 0.
   MODEL B: the identical ETSR replay with one candidate cap.

   Every game is priced from a layer rebuilt using only games BEFORE its week.
   Each cap owns its own prior-season ETSR chain, so a promoted coaching effect
   is allowed to carry into the following season exactly as production would.

   Selection rule:
     1. the TUNE window chooses one cap by MAE, with an RMSE and residual guard
     2. that cap is frozen before the HOLDOUT is opened
     3. the frozen cap must clear football/validation/promote.js on at least
        two holdout seasons
     4. holdout RMSE may not worsen by more than 0.01 and the coaching
        adjustment must still point positively into Model A's residual

   ATS-versus-close, market disagreement and reliability buckets are reported
   but NOT optimized. Optimizing five caps and six betting thresholds on the
   same holdout would be a charming way to manufacture an "edge."

   Usage:
     node football/rankings/validate_coaching_program.js
       [--first 2021] [--last 2025]
       [--tune 2021,2022,2023] [--hold 2024,2025]
       [--cache DIR] [--week-step 1] [--write]
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VF = require(path.join(ROOT, 'validation', 'validate_features.js'));
const PROMOTE = require(path.join(ROOT, 'validation', 'promote.js'));
const B = require(path.join(ROOT, 'players', 'build_players.js'));
const UNITS = require(path.join(ROOT, 'players', 'units.js'));
const TAL = require('./talent.js');
const ETSR = require('./etsr.js');
const COACHING = require('./coaching_program.js');
require(path.join(ROOT, 'cfb_p4', 'params.js'));
const P4 = require(path.join(ROOT, 'cfb_p4', 'engine.js'));

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const FIRST = +(arg('first', 2021));
const LAST = +(arg('last', 2025));
const TUNE = String(arg('tune', '')).split(',').filter(Boolean).map(Number);
const HOLD = String(arg('hold', '')).split(',').filter(Boolean).map(Number);
const CACHE = arg('cache', process.env.EDP_CACHE || '') || null;
const WEEK_STEP = Math.max(1, +(arg('week-step', 1)));
const WRITE = !!arg('write', false);

const CAPS = Object.freeze([0, 0.5, 1.0, 1.5, 2.0]);
const EDGE_THRESHOLDS = Object.freeze([0.5, 1, 1.5, 2, 3, 5]);
const isNum = x => typeof x === 'number' && isFinite(x);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const r3 = x => isNum(x) ? Math.round(x * 1000) / 1000 : null;
const r4 = x => isNum(x) ? Math.round(x * 10000) / 10000 : null;
const capKey = c => String(c);
function log(...x) { console.log(...x); }

function attachRosterContext(layer, prevLayer, season) {
  if (!layer || !layer.unitsV2 || !layer.byTeamV2) return layer;
  const curKeys = {};
  for (const key of Object.keys(layer.byTeamV2)) {
    for (const p of layer.byTeamV2[key] || []) if (p.key) curKeys[p.key] = key;
  }
  for (const key of Object.keys(layer.unitsV2)) {
    const prev = prevLayer && prevLayer.byTeamV2 ? (prevLayer.byTeamV2[key] || []) : [];
    const back = {};
    for (const p of layer.byTeamV2[key] || []) if (p.key) back[p.key] = 1;
    layer.unitsV2[key].returning = UNITS.returningValue(prev, back, { prior_season: season - 1 });

    const incoming = (layer.byTeamV2[key] || []).filter(p => p.status === 'transfer');
    const outgoing = prev.filter(p => p.key && curKeys[p.key] && curKeys[p.key] !== key);
    layer.unitsV2[key].transfers = UNITS.transferValue(incoming, outgoing, {});
  }
  return layer;
}

function coachingSeason(layer) {
  if (!layer) return null;
  const talent = TAL.build(layer.unitsV2 || {}, {});
  return {
    talent: talent.teams,
    performance: layer.perf && layer.perf.teams ? layer.perf.teams : {},
    roster: layer.unitsV2 || {},
    players: layer.byTeamV2 || {}
  };
}

function coachingAt(season, currentLayer, fullLayers) {
  const seasons = {};
  for (let off = COACHING.DECAY.length - 1; off >= 1; off--) {
    const y = season - off;
    if (fullLayers[y]) seasons[y] = coachingSeason(fullLayers[y]);
  }
  seasons[season] = coachingSeason(currentLayer);
  const keys = Object.keys((seasons[season] && seasons[season].talent) || {});
  return COACHING.build(keys, {
    season,
    seasons,
    staff: null,
    roster_last_updated: null,
    development_last_updated: null,
    allow_current: true
  });
}

function candidatePoints(team, cap) {
  if (!team || !isNum(team.coaching_program_rating) || !isNum(team.coaching_program_reliability)) return 0;
  return Math.max(-cap, Math.min(cap,
    ((team.coaching_program_rating - 50) / 50) * cap * team.coaching_program_reliability
  ));
}

function rateLayer(layer, prevSeasonRatings, slope, coaching, cap) {
  const talent = TAL.build(layer.unitsV2 || {}, {});
  const out = {};
  for (const key of Object.keys(talent.teams)) {
    const t = talent.teams[key];
    const p = layer.perf.teams[key] || null;
    const ctx = {
      talent: t,
      performance: p,
      continuity: TAL.continuityRating(t, layer.unitsV2[key]),
      sample: p ? p.sample : { games: 0, fbs_equivalent_games: 0, distinct_opponents: 0 },
      scheme_confidence: null,
      prev_etsr: prevSeasonRatings ? prevSeasonRatings[key] : null,
      league_slope: slope
    };
    const base = ETSR.rateTeam(key, ctx, null);
    if (!base.available) continue;
    const cp = coaching && coaching.teams ? coaching.teams[key] : null;
    let adj = candidatePoints(cp, cap);
    if (!isNum(base.prior && base.prior.points)) adj = 0;
    const weighted = (1 - base.weights.performance) * adj;
    out[key] = {
      rating: base.etsr_raw + weighted,
      base_rating: base.etsr_raw,
      coaching_adjustment: adj,
      weighted_adjustment: weighted,
      coaching_rating: cp ? cp.coaching_program_rating : null,
      coaching_reliability: cp ? cp.coaching_program_reliability : 0
    };
  }
  return out;
}

function gamePrediction(rated, home, away, hfa, neutral) {
  const h = rated && rated[home], a = rated && rated[away];
  if (!h || !a || !isNum(h.rating) || !isNum(a.rating)) return null;
  return h.rating - a.rating + (neutral ? 0 : hfa);
}

function pairReliability(rated, home, away) {
  const vals = [];
  const h = rated && rated[home], a = rated && rated[away];
  if (h && isNum(h.coaching_reliability)) vals.push(h.coaching_reliability);
  if (a && isNum(a.coaching_reliability)) vals.push(a.coaching_reliability);
  return vals.length ? mean(vals) : 0;
}

function paired(rows, fA, fB) {
  const d = [];
  for (const r of rows) {
    const a = fA(r), b = fB(r);
    if (!isNum(a) || !isNum(b)) continue;
    d.push(Math.abs(r.margin - a) - Math.abs(r.margin - b));
  }
  if (d.length < 30) return { n: d.length, p: null, reason: 'fewer than thirty paired games' };
  const m = mean(d);
  let v = 0;
  for (const x of d) v += (x - m) * (x - m);
  const sd = Math.sqrt(v / (d.length - 1));
  if (!(sd > 0)) return { n: d.length, p: null, reason: 'zero variance' };
  const t = m / (sd / Math.sqrt(d.length));
  return { n: d.length, mean_diff: r4(m), t: r4(t), p: r4(twoSidedP(t)) };
}

function twoSidedP(t) {
  const x = Math.abs(t) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, pp = 0.3275911;
  const tt = 1 / (1 + pp * x);
  const erf = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
  return 1 - erf;
}

function oneSidedBinomialP(wins, n, p0) {
  if (!(n > 0)) return null;
  p0 = p0 == null ? 0.5 : p0;
  const mu = n * p0, sd = Math.sqrt(n * p0 * (1 - p0));
  if (!(sd > 0)) return null;
  const z = (wins - 0.5 - mu) / sd;
  return r4(0.5 * erfc(z / Math.SQRT2));
}
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  const e = x >= 0 ? erf : -erf;
  return 1 - e;
}

function atsVsClose(rows, predict) {
  const out = {};
  for (const threshold of EDGE_THRESHOLDS) {
    let n = 0, wins = 0, pushes = 0;
    for (const r of rows) {
      const p = predict(r);
      if (!isNum(p) || !isNum(r.market)) continue;
      const edge = p - r.market;
      if (Math.abs(edge) < threshold) continue;
      const ats = Math.sign(edge) * (r.margin - r.market);
      if (Math.abs(ats) < 1e-9) { pushes++; continue; }
      n++;
      if (ats > 0) wins++;
    }
    out[String(threshold)] = {
      n, wins, losses: n - wins, pushes,
      win_pct: n ? r4(wins / n) : null,
      p_one_sided_vs_50: n ? oneSidedBinomialP(wins, n, 0.5) : null,
      clears_110_break_even: n ? wins / n > 0.5238095238 : false
    };
  }
  return out;
}

function predictiveResidual(rows, baseF, armF) {
  const x = [], y = [];
  for (const r of rows) {
    const a = baseF(r), b = armF(r);
    if (!isNum(a) || !isNum(b)) continue;
    const dx = b - a;
    if (Math.abs(dx) < 1e-9) continue;
    x.push(dx);
    y.push(r.margin - a);
  }
  if (x.length < 20) return { n: x.length, correlation: null, slope: null };
  const mx = mean(x), my = mean(y);
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return {
    n: x.length,
    correlation: sxx > 0 && syy > 0 ? r4(sxy / Math.sqrt(sxx * syy)) : null,
    slope: sxx > 0 ? r4(sxy / sxx) : null,
    mean_adjustment: r4(mx),
    mean_base_residual: r4(my)
  };
}

function reliabilityBuckets(rows, baseF, armF) {
  const defs = [
    { id: 'lt_035', lo: 0, hi: 0.35 },
    { id: '035_055', lo: 0.35, hi: 0.55 },
    { id: '055_070', lo: 0.55, hi: 0.70 },
    { id: 'ge_070', lo: 0.70, hi: Infinity }
  ];
  const out = {};
  for (const d of defs) {
    const sub = rows.filter(r => isNum(r.coaching_reliability)
      && r.coaching_reliability >= d.lo && r.coaching_reliability < d.hi);
    const a = VF.score(sub, baseF), b = VF.score(sub, armF);
    out[d.id] = {
      n: b.n,
      reliability_range: [d.lo, isFinite(d.hi) ? d.hi : null],
      mae_before: a.spread_mae,
      mae_after: b.spread_mae,
      improvement: isNum(a.spread_mae) && isNum(b.spread_mae) ? r3(a.spread_mae - b.spread_mae) : null
    };
  }
  return out;
}

function marketBenchmark(rows) {
  const sub = rows.filter(r => isNum(r.market));
  return VF.score(sub, r => r.market);
}

function selectTuneCap(arms, baseline) {
  const eligible = (arms || []).filter(a =>
    a.cap > 0
    && isNum(a.metrics && a.metrics.spread_mae)
    && isNum(a.metrics && a.metrics.rmse)
    && isNum(baseline && baseline.spread_mae)
    && isNum(baseline && baseline.rmse)
    && (baseline.spread_mae - a.metrics.spread_mae) >= PROMOTE.RULES.min_pooled_improvement
    && a.metrics.rmse <= baseline.rmse + 0.01
    && a.predictive_residual && isNum(a.predictive_residual.slope)
    && a.predictive_residual.slope > 0
  );
  eligible.sort((a, b) => {
    const d = a.metrics.spread_mae - b.metrics.spread_mae;
    if (Math.abs(d) > 0.01) return d;
    return a.cap - b.cap;
  });
  if (!eligible.length) {
    return {
      selected_cap: 0,
      reason: 'no non-zero cap improved tune MAE by the minimum effect while passing the RMSE and residual-direction guards'
    };
  }
  return {
    selected_cap: eligible[0].cap,
    tune_spread_mae: eligible[0].metrics.spread_mae,
    tune_rmse: eligible[0].metrics.rmse,
    tune_improvement: r3(baseline.spread_mae - eligible[0].metrics.spread_mae),
    reason: 'lowest tune-window MAE among caps passing the predeclared guards; ties within 0.01 go to the smaller cap'
  };
}

function promotionDecision(tuned, holdArms, holdBaseline) {
  if (!tuned || !(tuned.selected_cap > 0)) {
    return {
      selected_cap: 0,
      tuned_cap: 0,
      affects_etsr: false,
      status: 'RESEARCH_ONLY',
      reason: tuned && tuned.reason ? tuned.reason : 'the tune window selected no non-zero cap'
    };
  }
  const arm = (holdArms || []).find(a => a.cap === tuned.selected_cap);
  if (!arm) {
    return {
      selected_cap: 0,
      tuned_cap: tuned.selected_cap,
      affects_etsr: false,
      status: 'RESEARCH_ONLY',
      reason: 'the frozen tune-selected cap has no holdout result'
    };
  }
  const rmseOk = isNum(arm.metrics.rmse) && isNum(holdBaseline.rmse)
    && arm.metrics.rmse <= holdBaseline.rmse + 0.01;
  const residualOk = arm.predictive_residual && isNum(arm.predictive_residual.slope)
    && arm.predictive_residual.slope > 0;
  const validated = arm.verdict && arm.verdict.status === 'VALIDATED' && rmseOk && residualOk;
  return {
    selected_cap: validated ? tuned.selected_cap : 0,
    tuned_cap: tuned.selected_cap,
    affects_etsr: validated,
    status: validated ? 'VALIDATED' : (arm.verdict ? arm.verdict.status : 'RESEARCH_ONLY'),
    holdout_spread_mae: arm.metrics.spread_mae,
    holdout_rmse: arm.metrics.rmse,
    effect_size: arm.verdict ? arm.verdict.effect_size : null,
    conditions: {
      promotion_gate: arm.verdict ? arm.verdict.status : null,
      rmse_guard: rmseOk,
      positive_residual_direction: residualOk
    },
    reason: validated
      ? 'the cap was selected on tune data only and then cleared every holdout promotion condition'
      : 'the tune-selected cap was frozen before holdout and did not clear every holdout promotion condition'
  };
}

async function main() {
  const seasons = [];
  for (let y = FIRST; y <= LAST; y++) seasons.push(y);
  const tune = TUNE.length ? TUNE : seasons.slice(0, Math.max(1, seasons.length - 2));
  const hold = HOLD.length ? HOLD : seasons.slice(Math.max(1, seasons.length - 2));
  if (tune.some(y => hold.includes(y))) {
    console.error('tune and holdout overlap — refusing to run');
    return 1;
  }
  if (hold.length < 2) log('WARNING: fewer than two holdout seasons; promote.js will refuse VALIDATED status.');

  log(`CFB Coaching / Program walk-forward ${FIRST}..${LAST} tune=[${tune}] hold=[${hold}]`);
  log('caps: ' + CAPS.join(', ') + ' points');

  const sched = {}, roster = {}, play = {}, box = {}, coverage = {};
  for (const y of seasons) {
    sched[y] = await B.loadSchedule(y);
    roster[y] = await B.loadRoster(y);
    play[y] = await B.loadPlays(y, sched[y], { byWeek: true });
    box[y] = B.loadBox(y);
    coverage[y] = Object.assign(B.coverageGates(play[y].counts, play[y].teamGameCount), box[y].coverage || {});
    log(`  ${y}: ${play[y].counts.plays} plays`);
  }
  roster[FIRST - 1] = await B.loadRoster(FIRST - 1);
  const market = await require(path.join(ROOT, 'players', 'validate.js')).loadMarket(CACHE);
  log(`  market archive: ${market.rows || 0} rows`);

  /* Build the career indices once. buildLayer itself only reads rows from
     seasons before the season it is rebuilding. */
  const EPIR = require(path.join(ROOT, 'players', 'epir.js'));
  const careerV1 = {}, careerV2 = {};
  for (const y of seasons) {
    const teamAgg = B.teamSeasonAggregates(play[y].teamGames, sched[y].fbs);
    const metrics = {};
    for (const met of B.ADJ_METRICS) {
      const a = B.opponentAdjust(play[y].teamGames, sched[y].fbs, met);
      if (a) metrics[met.id] = a;
    }
    const norm = B.normaliseSeason(y, play[y], roster[y], roster[y - 1] || null, sched[y],
      { metrics, teamAgg, box: box[y] });
    function before(idx) {
      const out = {};
      for (const k of Object.keys(idx)) {
        const rows = idx[k].filter(r => r.season < y);
        if (rows.length) out[k] = rows;
      }
      return out;
    }
    for (const pair of [[careerV1, 'v1'], [careerV2, 'v2']]) {
      const idx = pair[0], variant = pair[1];
      const rated = EPIR.rateSeason(norm.players, {
        coverage: coverage[y], leagueAllowed: norm.leagueAllowed, season: y,
        careerIndex: before(idx), params: null, variant
      });
      for (const p of rated.ratings) {
        if (!p.key) continue;
        (idx[p.key] = idx[p.key] || []).push({
          season: y, z: p.components.quality.z_raw, n: p.sample_size, dc: p.data_completeness
        });
      }
    }
  }

  const P4P = global.window.EDCfbP4Params;
  const hfa = P4P.rating.hyperparams.hfa;
  const slope = 0.73; /* same frozen replay assumption validate_features.js uses */
  const fullLayers = {};
  const chains = {};
  for (const cap of CAPS) chains[capKey(cap)] = {};

  const rows = [];
  for (const y of seasons) {
    const weeks = [...new Set(sched[y].games.filter(g => g.week != null).map(g => g.week))].sort((a, b) => a - b);
    let layer = null, coaching = null, ratedByCap = null;

    for (let wi = 0; wi < weeks.length; wi++) {
      const w = weeks[wi];
      const games = sched[y].games.filter(g => g.week === w && g.completed
        && g.home_points != null && g.away_points != null && g.home_fbs && g.away_fbs);
      if (games.length && (wi % WEEK_STEP === 0 || layer == null)) {
        layer = VF.buildLayer(y, w, play, sched, roster, careerV1, careerV2, box, coverage);
        attachRosterContext(layer, fullLayers[y - 1] || null, y);
        coaching = coachingAt(y, layer, fullLayers);
        ratedByCap = {};
        for (const cap of CAPS) {
          const prev = chains[capKey(cap)][y - 1] || null;
          ratedByCap[capKey(cap)] = rateLayer(layer, prev, slope, coaching, cap);
        }
      }

      for (const g of games) {
        const predictions = {};
        for (const cap of CAPS) {
          predictions[capKey(cap)] = gamePrediction(ratedByCap[capKey(cap)], g.home, g.away, hfa, !!g.neutral);
        }
        const mkt = market.byGame ? market.byGame[String(g.game_id)] : null;
        rows.push({
          season: y, week: w, game_id: String(g.game_id),
          margin: g.home_points - g.away_points,
          market: mkt ? -mkt.home_handicap : null,
          predictions,
          coaching_reliability: pairReliability(ratedByCap['0'], g.home, g.away)
        });
      }
    }

    /* Close the season using the full finished layer. This is used ONLY as
       next season's prior, never to price a game from the season it just saw. */
    const finalWeek = weeks.length ? Math.max(...weeks) + 1 : 99;
    const full = VF.buildLayer(y, finalWeek, play, sched, roster, careerV1, careerV2, box, coverage);
    attachRosterContext(full, fullLayers[y - 1] || null, y);
    const cpFull = coachingAt(y, full, fullLayers);
    for (const cap of CAPS) {
      const prev = chains[capKey(cap)][y - 1] || null;
      const rated = rateLayer(full, prev, slope, cpFull, cap);
      const end = {};
      for (const key of Object.keys(rated)) end[key] = rated[key].rating;
      chains[capKey(cap)][y] = end;
    }
    fullLayers[y] = full;
    log(`  replayed ${y}: ${rows.filter(r => r.season === y).length} FBS-vs-FBS games`);
  }

  const tuneRows = rows.filter(r => tune.includes(r.season) && isNum(r.predictions['0']));
  const holdRows = rows.filter(r => hold.includes(r.season) && isNum(r.predictions['0']));
  const baseF = r => r.predictions['0'];

  const tuneBaseline = VF.score(tuneRows, baseF);
  const tuneArms = CAPS.filter(x => x > 0).map(cap => {
    const f = r => r.predictions[capKey(cap)];
    return {
      cap,
      metrics: VF.score(tuneRows, f),
      predictive_residual: predictiveResidual(tuneRows, baseF, f)
    };
  });
  const tuned = selectTuneCap(tuneArms, tuneBaseline);
  log('  tune selected cap: ±' + tuned.selected_cap);

  const baseline = VF.score(holdRows, baseF);
  baseline.feature = 'coaching_program_cap_0';
  baseline.market = marketBenchmark(holdRows);
  baseline.ats_vs_close = atsVsClose(holdRows, baseF);

  const arms = [];
  for (const cap of CAPS.filter(x => x > 0)) {
    const key = capKey(cap), f = r => r.predictions[key];
    const metrics = VF.score(holdRows, f);
    const armForGate = Object.assign({}, metrics, {
      feature: 'coaching_program_cap_' + key.replace('.', '_'),
      label: 'Coaching / Program ±' + cap + ' prior-side points',
      coefficient: cap,
      paired: paired(holdRows, baseF, f),
      per_season: hold.map(season => {
        const sub = holdRows.filter(r => r.season === season);
        const a = VF.score(sub, baseF), b = VF.score(sub, f);
        return { season, n: b.n, mae_before: a.spread_mae, mae_after: b.spread_mae,
          rmse_before: a.rmse, rmse_after: b.rmse };
      }),
      leakage_clean: true,
      version: 'coaching_program_v1'
    });
    const verdict = PROMOTE.evaluate(armForGate, baseline);
    const marketScore = marketBenchmark(holdRows);
    const marketRows = holdRows.filter(r => isNum(r.market));
    const modelOnMarket = VF.score(marketRows, f);
    arms.push({
      cap,
      metrics,
      verdict,
      selected_on_tune: cap === tuned.selected_cap,
      predictive_residual: predictiveResidual(holdRows, baseF, f),
      reliability_buckets: reliabilityBuckets(holdRows, baseF, f),
      ats_vs_close: atsVsClose(holdRows, f),
      market_comparison: {
        n: marketRows.length,
        model_mae: modelOnMarket.spread_mae,
        close_mae: marketScore.spread_mae,
        model_minus_close_mae: isNum(modelOnMarket.spread_mae) && isNum(marketScore.spread_mae)
          ? r3(modelOnMarket.spread_mae - marketScore.spread_mae) : null
      }
    });
    log(`  holdout cap ±${cap}: MAE ${metrics.spread_mae} RMSE ${metrics.rmse} ${verdict.status}`
      + (cap === tuned.selected_cap ? '  [FROZEN TUNE CHOICE]' : ''));
  }

  const selection = promotionDecision(tuned, arms, baseline);
  const doc = {
    schema: 'edgedesk_coaching_program_validation_v1',
    sport: 'americanfootball_ncaaf',
    generated_at: new Date().toISOString(),
    policy: {
      sport_specific: true,
      statement: 'CFB selects its own Coaching / Program cap. No result in this artifact is transferable to NFL, tennis, baseball, UFC or another sport without that sport running its own holdout.',
      caps_tested: CAPS,
      primary_selection_metric: 'tune-window spread MAE after RMSE and residual-direction guards',
      holdout_role: 'certification only; the holdout cannot change the tune-selected cap',
      tie_break: 'if tune MAE differs by <= 0.01, choose the smaller cap',
      ats_policy: 'ATS-versus-close is reported at fixed thresholds and never optimized to choose the cap'
    },
    frame: {
      first: FIRST, last: LAST, tune_seasons: tune, holdout_seasons: hold,
      week_step: WEEK_STEP,
      leakage: 'each week is rebuilt from games strictly before that week; prior-season chains are cap-specific',
      market: 'closing spread is benchmark-only and is never an input to a rating'
    },
    tune: { baseline: tuneBaseline, arms: tuneArms, selection: tuned },
    baseline,
    arms,
    selection
  };

  if (WRITE) {
    const out = path.join(__dirname, 'coaching_program_validation.json');
    fs.writeFileSync(out, JSON.stringify(doc, null, 1));
    log('wrote ' + path.relative(process.cwd(), out));
  } else {
    log('selection: ' + JSON.stringify(selection));
    log('(dry — pass --write to publish the validation artifact)');
  }
  return 0;
}

module.exports = {
  CAPS,
  EDGE_THRESHOLDS,
  attachRosterContext,
  coachingSeason,
  candidatePoints,
  rateLayer,
  atsVsClose,
  predictiveResidual,
  reliabilityBuckets,
  selectTuneCap,
  promotionDecision,
  main
};

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => {
    console.error('COACHING PROGRAM VALIDATION FAILED:', err && err.stack || err);
    process.exit(1);
  });
}
