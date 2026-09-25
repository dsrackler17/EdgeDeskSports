#!/usr/bin/env node
/* ============================================================================
   THE DISPLAY FAIR LINE IS A FLOOR, NOT A PROJECTION.

   A near pick'em (|projected margin| < 1, an exact tie included) is shown as
   the favoured side -1 / the other side +1, never "PK" or "-0.5". What this
   file pins is everything that must NOT follow the display line:

     * model.fair_spread stays the raw, full-precision projection
     * win probability, confidence, cover, EV, the market gap and the edge tier
       are computed from the raw margin — the floor manufactures no points
     * the favoured side is read off the unrounded number and never flips
     * an exact tie is broken by measured inputs the engine already has, in a
       fixed order, and never by adding a point to the projection
     * grading reads the raw number, so evaluation does not move

   Run: node football/cfb_p4/fair_line.test.js   (exit 0 = green)
   ========================================================================== */
'use strict';

global.window = global.window || global;
require('./params.js');
const E = require('./engine.js');
const G = require('../../tools/editorial/grading.js');
const P = global.EDCfbP4Params;
const F = E.fairLine;

let pass = 0, fail = 0;
function chk(name, fn, detail) {
  let ok = false, why = detail;
  try { ok = !!fn(); } catch (e) { why = String(e && e.stack || e); }
  if (ok) pass++;
  else { fail++; console.error('FAIL | ' + name + (why ? ' | ' + (typeof why === 'string' ? why : JSON.stringify(why)) : '')); }
}
/* the formatter every CFB surface uses on the line: sign + one decimal */
function shown(v) { return (v > 0 ? '+' : '') + v.toFixed(1); }

/* ======================================================================== */
/* 1. THE NORMALISATION TABLE                                               */
/* ======================================================================== */
[[-0.01, -1], [-0.49, -1], [-0.99, -1], [0.01, 1], [0.49, 1], [0.99, 1], [-0.74, -1], [-0.12, -1], [0.61, 1]]
  .forEach(([raw, want]) => {
    const o = F.normalize(raw, {});
    chk('raw ' + (raw > 0 ? '+' : '') + raw.toFixed(2) + ' -> display ' + shown(want),
      () => o.display_fair_spread === want && o.is_near_pickem === true && shown(o.display_fair_spread) === shown(want), o);
  });
/* |raw| >= 1: the display value IS the raw value, bit for bit, so every
   existing renderer prints exactly what it printed before */
[-1, 1, -1.00, -3.24, 7.61, -6.27, 3.18, 1.0000001, -24.9].forEach(raw => {
  const o = F.normalize(raw, {});
  chk('raw ' + raw + ' keeps the existing spread behaviour (' + shown(raw) + ')',
    () => o.display_fair_spread === raw && o.is_near_pickem === false && o.basis.rule === 'projection'
      && shown(o.display_fair_spread) === shown(raw), o);
});

/* ======================================================================== */
/* 2. EXACT TIES AND FLOATING-POINT NEAR-ZEROES                             */
/* ======================================================================== */
[0, -0].forEach(z => {
  const o = F.normalize(z, {});
  chk('an exact raw tie (' + (Object.is(z, -0) ? '-0' : '0') + ') is never returned as PK',
    () => Math.abs(o.display_fair_spread) === 1 && o.is_near_pickem === true && o.basis.rule === 'tiebreak', o);
});
const ieee = 0.1 + 0.2 - 0.3;          /*  5.55e-17 */
const ieeeNeg = 0.3 - 0.1 - 0.2;       /* -2.78e-17 */
[[ieee, 1], [ieeeNeg, -1], [1e-12, 1], [-1e-12, -1], [Number.MIN_VALUE, 1], [-Number.MIN_VALUE, -1],
 [1 - 1e-15, 1], [-(1 - 1e-15), -1]].forEach(([raw, want]) => {
  const o = F.normalize(raw, { weighted_components: -want * 5, team_strength: -want * 5 });
  chk('a nearly-zero raw margin ' + raw + ' keeps its own side (' + shown(want) + '), whatever the tiebreak inputs say',
    () => o.display_fair_spread === want && o.basis.rule === 'near_pickem_floor' && o.basis.step === 'projection_precision', o);
});
chk('1 + 1e-15 is already outside the floor and displays as itself',
  () => F.normalize(1 + 1e-15, {}).display_fair_spread === 1 + 1e-15);

/* ======================================================================== */
/* 3. THE FAVOURED SIDE NEVER FLIPS, AND 0 / ±0.5 ARE NEVER SHOWN            */
/* ======================================================================== */
(function sweep() {
  let flips = [], banned = [], small = [], moved = [];
  const BANNED = { '0.0': 1, '+0.0': 1, '-0.0': 1, '+0.5': 1, '-0.5': 1, '0.5': 1 };
  let seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  const xs = [];
  for (let i = -2000; i <= 2000; i++) xs.push(i / 1000);
  for (let i = 0; i < 4000; i++) xs.push((rnd() - 0.5) * 60);
  for (let i = 0; i < 500; i++) xs.push((rnd() - 0.5) * 1e-6);
  xs.forEach(raw => {
    const o = F.normalize(raw, { weighted_components: rnd() - 0.5 });
    const d = o.display_fair_spread;
    if (raw !== 0 && Math.sign(d) !== Math.sign(raw)) flips.push(raw);
    if (BANNED[shown(d)] || d === 0 || Math.abs(d) === 0.5) banned.push(raw);
    if (Math.abs(d) < 1) small.push(raw);
    if (Math.abs(raw) >= 1 && d !== raw) moved.push(raw);
  });
  chk('the displayed favourite is the raw favourite on every one of ' + xs.length + ' margins', () => !flips.length, flips.slice(0, 5));
  chk('no display line is ever 0, -0.5 or +0.5', () => !banned.length, banned.slice(0, 5));
  chk('no display line is ever smaller than one point', () => !small.length, small.slice(0, 5));
  chk('no display line at or beyond one point differs from the raw margin', () => !moved.length, moved.slice(0, 5));
  chk('the layer is symmetric: -raw displays as -display',
    () => xs.filter(x => x !== 0).every(x => F.normalize(-x, {}).display_fair_spread === -F.normalize(x, {}).display_fair_spread));
})();

/* ======================================================================== */
/* 4. THE CLOSE-GAME TIEBREAKER, IN ITS ORDER                               */
/* ======================================================================== */
const order = ['win_probability', 'weighted_components', 'team_strength', 'efficiency', 'coaching_program'];
chk('the hierarchy is the specified one', () => JSON.stringify(F.TIEBREAK_ORDER) === JSON.stringify(order), F.TIEBREAK_ORDER);
order.forEach((step, i) => {
  const inputs = {};
  order.forEach((k, j) => { inputs[k] = j < i ? 0 : (j === i ? -0.3 : 5); });
  const o = F.normalize(0, inputs);
  chk('with every earlier step level, ' + step + ' decides — and a later step pointing the other way does not',
    () => o.basis.step === step && o.display_side === 'away' && o.display_fair_spread === -1, o);
});
chk('an earlier step beats a larger later one',
  () => F.normalize(0, { weighted_components: 0.01, team_strength: -30, efficiency: -1 }).display_side === 'home');
chk('a missing step is skipped, not read as zero-for-home',
  () => F.normalize(0, { win_probability: null, weighted_components: undefined, team_strength: -2 }).basis.step === 'team_strength');
chk('win-probability residue from the erf approximation is not a measurable edge',
  () => {
    const noise = E.dist.winProb(0, 14) - 0.5;
    const o = F.normalize(0, { win_probability: noise, weighted_components: -0.2 });
    return noise !== 0 && Math.abs(noise) < F.MEASURABLE && o.basis.step === 'weighted_components' && o.display_side === 'away';
  });
chk('with nothing measurable the home side is shown by convention, and says so',
  () => { const o = F.normalize(0, { win_probability: 0, weighted_components: 0 }); return o.display_side === 'home' && o.basis.step === 'none' && /convention/.test(o.basis.why); });
chk('the tiebreak only ever produces a one-point display, never a bigger one',
  () => F.normalize(0, { team_strength: 25 }).display_fair_spread === 1);
chk('efficiency: net EPA per play, home minus away',
  () => {
    const M = (v) => ({ value: v, available: true });
    const h = { efficiency: { epa_per_play: M(0.15), def_epa_per_play: M(-0.15) } };
    const a = { efficiency: { epa_per_play: M(0.05), def_epa_per_play: M(0.05) } };
    return Math.abs(F.efficiencyGap(h, a) - 0.3) < 1e-12;
  });
chk('efficiency: success rate when EPA is not observed on both sides, null when neither is',
  () => {
    const M = (v) => ({ value: v, available: true }), X = { value: null, available: false };
    const h = { efficiency: { epa_per_play: X, def_epa_per_play: M(0), success_rate: M(0.1), def_success_rate: M(0) } };
    const a = { efficiency: { epa_per_play: M(0), def_epa_per_play: M(0), success_rate: M(0), def_success_rate: M(0.1) } };
    return Math.abs(F.efficiencyGap(h, a) - 0.2) < 1e-12 && F.efficiencyGap({ efficiency: {} }, a) === null;
  });
chk('coaching / program edge counts only when both sides carry positive reliability',
  () => F.coachingGap({ rating: 60, reliability: 0.4 }, { rating: 55, reliability: 0.3 }) === 5
    && F.coachingGap({ rating: 60, reliability: 0 }, { rating: 55, reliability: 0.3 }) === null
    && F.coachingGap({ rating: 60, reliability: 0.4 }, null) === null);

/* ======================================================================== */
/* 5. THROUGH THE REAL ENGINE: NOTHING THAT MEASURES THE GAME MOVES          */
/* ======================================================================== */
const HOME = 'Alabama', AWAY = 'Georgia';
function req(st, o) {
  o = o || {};
  return { season: P.trained_through_season, week: 6, state: st,
    game: { home: HOME, away: AWAY, neutral_site: !!o.neutral, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: Object.assign({ conference: 'SEC' }, o.th || {}), away: Object.assign({ conference: 'SEC' }, o.ta || {}) },
    market: o.market || {} };
}
/* steer a real projection to a chosen raw margin through the rating term
   alone: every other term is independent of the two canonical ratings */
function stateAt(target, o) {
  const st = E.newState();
  st.canonicalRatings = { alabama: { value: 0 }, georgia: { value: 0 } };
  if (o && o.noEff) { delete st.eff.alabama; delete st.eff.georgia; }
  const rest = E.projectGame(req(st, o)).model.fair_spread;
  st.canonicalRatings.alabama.value = target - rest;
  return st;
}
/* the same projection with the display layer switched off — the control */
function without(fn) {
  const keep = F.normalize;
  F.normalize = () => null;
  try { return fn(); } finally { F.normalize = keep; }
}
const DISPLAY_KEYS = ['display_fair_spread', 'display_side', 'is_near_pickem', 'display_basis'];
function strip(p, keepExplain) {
  const c = JSON.parse(JSON.stringify(p));
  DISPLAY_KEYS.forEach(k => { delete c.model[k]; });
  delete c.prediction_timestamp;
  if (!keepExplain) delete c.explanation;
  return c;
}
const MKT = { spread_line: -2.5, total_line: 48.5 };   /* engine convention: home is a 2.5-point dog */
const AM = -110, DEC = E.odds.amToDec(AM);

[-0.99, -0.49, -0.37, -0.01, 0.01, 0.18, 0.34, 0.49, 0.99, -1, 1, -3.24, 7.61].forEach(target => {
  /* at ±1 a neutral site with no matchup term makes the raw margin exactly
     the rating gap, so the boundary is hit exactly rather than a
     floating-point hair either side of it */
  const o = Math.abs(target) === 1 ? { neutral: true, noEff: true } : {};
  const st = stateAt(target, o);
  const p = E.projectGame(req(st, Object.assign({ market: MKT }, o)));
  const c = without(() => E.projectGame(req(st, Object.assign({ market: MKT }, o))));
  const raw = p.model.fair_spread, sigma = p.model.sigma_margin;
  const label = 'raw ' + raw.toFixed(2) + ': ';
  const near = Math.abs(raw) < 1;
  chk(label + 'steered to the intended margin', () => (Math.abs(target) === 1 ? raw === target : Math.abs(raw - target) < 1e-9), raw);
  chk(label + 'the raw projection is the sum of its priced terms, not the display line',
    () => p.contributions.reduce((s, t) => s + t.points, 0) === raw);
  chk(label + 'display is ' + (near ? 'the one-point floor on the raw side' : 'the raw margin itself'),
    () => near
      ? (p.model.display_fair_spread === Math.sign(raw) && p.model.is_near_pickem === true)
      : (p.model.display_fair_spread === raw && p.model.is_near_pickem === false));
  chk(label + 'raw projection, win probability, confidence, cover, market gap, edge and fingerprint are identical with the layer off',
    () => JSON.stringify(strip(p, !near || raw !== 0)) === JSON.stringify(strip(c, !near || raw !== 0)));
  chk(label + 'win probability is the raw margin’s, not the display line’s',
    () => p.model.home_win_prob === E.dist.winProb(raw, sigma)
      && (!near || p.model.home_win_prob !== E.dist.winProb(p.model.display_fair_spread, sigma)));
  chk(label + 'confidence is untouched', () => p.scores.confidence === c.scores.confidence
    && p.scores.confidence_priced === c.scores.confidence_priced);
  chk(label + 'the market gap is raw minus market — the floor adds no points of edge',
    () => p.market.spread_gap === E.market.gap(raw, MKT.spread_line)
      && (!near || p.market.spread_gap !== E.market.gap(p.model.display_fair_spread, MKT.spread_line)));
  chk(label + 'the edge tier is classified on the raw gap',
    () => JSON.stringify(p.edge.spread) === JSON.stringify(E.market.classifyEdge('spread', E.market.gap(raw, MKT.spread_line), p.scores.confidence)));
  const ev = E.odds.evPct(p.cover.win, DEC), evC = E.odds.evPct(c.cover.win, DEC);
  const evDisplay = E.odds.evPct(E.dist.coverProbSpread(p.model.display_fair_spread, MKT.spread_line, sigma, p.layers.uncertainty.sigma_base).win, DEC);
  chk(label + 'EV at -110 is computed from the raw cover probability (' + (100 * ev).toFixed(2) + '%)',
    () => ev === evC && p.cover.win === E.dist.coverProbSpread(raw, MKT.spread_line, sigma, p.layers.uncertainty.sigma_base).win
      && (!near || evDisplay !== ev));
});

/* the example in the brief: raw Team A -0.34, market Team A +2.5 */
(function () {
  const st = stateAt(0.34);
  const p = E.projectGame(req(st, { market: MKT }));
  chk('raw Alabama -0.34 vs market Alabama +2.5: the gap is 2.84 points, not the 3.5 the display line would imply',
    () => Math.abs(p.market.spread_gap - 2.84) < 1e-9 && p.model.display_fair_spread === 1, p.market.spread_gap);
})();

/* an exact tie in the real engine: rating gap exactly offsets home field */
(function () {
  const st = E.newState();
  delete st.eff.alabama; delete st.eff.georgia;             /* no matchup term */
  st.canonicalRatings = { alabama: { value: 0 }, georgia: { value: 0 } };
  const hfa = E.projectGame(req(st)).contributions.filter(t => t.key === 'hfa')[0].points;
  st.canonicalRatings.georgia.value = hfa;                  /* rating gap = -hfa */
  const p = E.projectGame(req(st, { market: MKT }));
  const c = without(() => E.projectGame(req(st, { market: MKT })));
  const w = p.contributions.filter(t => t.available).reduce((s, t) => s + t.points * t.confidence, 0);
  chk('real exact tie: the raw margin is exactly zero and stays zero', () => p.model.fair_spread === 0 && hfa !== 0, p.model.fair_spread);
  chk('real exact tie: shown as a side at one point, flagged near pick’em',
    () => Math.abs(p.model.display_fair_spread) === 1 && p.model.is_near_pickem === true && p.model.display_basis.rule === 'tiebreak');
  chk('real exact tie: win probability (0.5 up to erf residue) cannot separate them, the reliability-weighted components do',
    () => p.model.display_basis.step === 'weighted_components' && p.model.display_side === (w > 0 ? 'home' : 'away'), [p.model.display_basis, w]);
  chk('real exact tie: every measuring field is identical with the layer off',
    () => JSON.stringify(strip(p)) === JSON.stringify(strip(c)));
  chk('real exact tie: the explanation names the side the line names',
    () => p.explanation.summary.indexOf(p.model.display_side === 'home' ? HOME : AWAY) === 0, p.explanation.summary);
})();

/* neutral site, equal ratings, no efficiency: only a supplied coaching /
   program edge can separate them, and without one the home side is shown by
   convention */
(function () {
  const st = E.newState();
  delete st.eff.alabama; delete st.eff.georgia;
  st.canonicalRatings = { alabama: { value: 12 }, georgia: { value: 12 } };
  const bare = E.projectGame(req(st, { neutral: true }));
  chk('real dead heat: raw margin zero', () => bare.model.fair_spread === 0, bare.model.fair_spread);
  chk('real dead heat with nothing measurable: home by convention, and the basis says so',
    () => bare.model.display_side === 'home' && bare.model.display_basis.step === 'none');
  const cp = E.projectGame(req(st, { neutral: true,
    th: { coaching_program: { rating: 52, reliability: 0.5 } }, ta: { coaching_program: { rating: 61, reliability: 0.6 } } }));
  chk('real dead heat with a reliable coaching / program edge: that edge names the side',
    () => cp.model.display_side === 'away' && cp.model.display_basis.step === 'coaching_program' && cp.model.display_fair_spread === -1);
  chk('and the coaching edge adds nothing to the projection or its win probability',
    () => cp.model.fair_spread === 0 && cp.model.home_win_prob === bare.model.home_win_prob);
  const unrel = E.projectGame(req(st, { neutral: true,
    th: { coaching_program: { rating: 52, reliability: 0 } }, ta: { coaching_program: { rating: 61, reliability: 0.6 } } }));
  chk('an unreliable coaching / program score is not used', () => unrel.model.display_basis.step === 'none');
})();

/* ======================================================================== */
/* 6. GRADING READS THE RAW NUMBER, SO EVALUATION DOES NOT MOVE              */
/* ======================================================================== */
(function () {
  const game = { home: 'Florida', away: 'LSU' };
  const result = { home_score: 24, away_score: 21 };
  const now = { game, model: { priced: true, fair_spread: 0.37, fair_spread_text: 'Florida -1.0', fair_spread_raw_text: 'Florida -0.4' } };
  const old = { game, model: { priced: true, fair_spread: 0.37, fair_spread_text: 'Florida -0.4' } };
  const a = G.modelAccuracy(now, result), b = G.modelAccuracy(old, result);
  chk('model accuracy grades the raw margin (0.4), not the one-point floor',
    () => a.projected_home_margin === 0.4 && a.margin_error === 2.6, a);
  chk('a snapshot stored before the display line existed grades exactly as it did',
    () => JSON.stringify(a) === JSON.stringify(b), [a, b]);
  const snap = { game, model: { priced: true },
    market: { available: true, market: 'Florida -0.5', model: 'Florida -1.0', model_raw: 'Florida -0.3', book: 'Book' } };
  const lean = G.impliedSide(snap);
  chk('the implied side comes from the raw line: Florida -0.3 against -0.5 leans LSU (the floor would have said Florida)',
    () => lean.available && lean.side === 'away' && lean.model_home_margin === -0.3 && lean.gap === 0.2, lean);
  const legacy = G.impliedSide({ game, model: { priced: true },
    market: { available: true, market: 'Florida -0.5', model: 'Florida -0.3', book: 'Book' } });
  chk('an older snapshot with only `model` grades the same', () => JSON.stringify(legacy) === JSON.stringify(lean));
})();

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
