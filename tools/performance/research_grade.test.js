#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk Research Grade — the kernel, the ledger steps and the whole
   lifecycle, offline. docs/research-grade/METHODOLOGY.md

     T  thresholds: the A–F boundaries, rounding at the edges, configurable
        and versioned weights
     M  missing features: nothing missing earns credit; the two excluded-and-
        capped kinds (live track record, pregame market line); every gate
     D  model–market disagreement lowers the grade and is flagged, never
        called an edge
     F  stale data: expired builds, builds near their limit, old lines
     A  sport adapters: every supported sport, the NHL's missing margin, the
        CFB reliability score and stability, the NFL slate's warnings, the lab
        sports' unmodelled availability, an unsupported sport
     O  odds-provider failures: no feed, a stale feed, a game not on it, a line
        captured after the start or after the grade
     R  reproducibility: a snapshot re-scores from its own inputs and version,
        byte for byte; a tampered input does not
     X  leakage: the track record as of the grade's moment; the pregame gate
     S  settlement: designation, Brier, spread direction from the side saved
        pregame (never the final), pushes, ties, overtime, void games, CLV only
        from a same-source close
     P  performance: the dashboard's numbers equal their underlying records;
        sample states and minimums; intervals; no ordering claimed without one
     L  lifecycle on a throwaway repository: snapshot immutability, duplicate
        runs, the kickoff cutoff, missing odds, postponed and canceled games,
        overtime, a corrected final, grade-version and model-version changes,
        no backfill, upcoming grades carry no model number
   Run: node tools/performance/research_grade.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const G = require('../../lib/edgedesk_research_grade.js');
const P = require('../../lib/edgedesk_performance.js');
const L = require('./ledger.js');
const PL = require('./pipeline.js');
const RG = require('./research_grades.js');
const F = require('./grade_fixture.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); } }
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= (eps || 1e-6); }

/* ------------------------------------------------------------ fixtures */
const START = '2026-10-20T00:00:00.000Z';
const AS_OF = '2026-10-19T12:00:00.000Z';
const QUOTE = { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: '2026-10-19T11:00:00.000Z', moneyline: { home: -160, away: 135 },
  spread: { home_point: -3.5, home_price: -110, away_point: 3.5, away_price: -110 }, total: { point: 44, over: -110, under: -110 } };
/** A projection with every input a grade can use, all strong. */
function strong(o) {
  o = o || {};
  const p = F.proj({ id: 'K1', start: START, pred: '2026-10-19T10:00:00.000Z', p: 0.6, line: -3.5, total: 44, certainty: 'CONFIRMED' });
  p.uncertainty = { model_sd: 0.008, calibration_sd: 0.012, lineup_sd: 0, early_season: false, basis: 'model_sd: spread across validated variants' };
  p.validation.markets.moneyline.state = 'MARKET_VALIDATED';
  p.provenance = [{ what: 'schedule', authority: 'OFFICIAL' }];
  p.sensitivity = [{ what: 'x', delta_p_home: 0.005 }];
  return Object.assign(p, o);
}
function track(n, brier, eceExcess) { return { n, brier: brier == null ? 0.18 : brier, ece: 0.02, ece_excess: eceExcess == null ? 0 : eceExcess, sample_state: P.sampleState(n), family: 'edgedesk_football_v1.0.0', verified_n: n, recorded_n: 0 }; }
function ctx(o) { return Object.assign({ as_of: AS_OF, quote: QUOTE, quote_status: 'CAPTURED', time_tbd: false, track: track(600), extra: { week: 7, data_quality: { warnings: [], missing: [] } } }, o || {}); }
function grade(p, c, cfg) { return G.gradeProjection(p, c, cfg); }
function sub(g, dim, id) { return g.dimensions[dim].items.filter((x) => x.id === id)[0]; }

/* ------------------------------------------------------------ T thresholds */
(function thresholds() {
  const cases = [[100, 'A'], [90, 'A'], [89, 'B'], [80, 'B'], [79, 'C'], [70, 'C'], [69, 'D'], [60, 'D'], [59, 'F'], [0, 'F']];
  cases.forEach(([s, l]) => chk('T score ' + s + ' is ' + l, G.letterOf(s) === l, G.letterOf(s)));
  chk('T 89.5 rounds to 90 (A); 89.49 to 89 (B)', G.letterOf(G.roundScore(89.5)) === 'A' && G.letterOf(G.roundScore(89.49)) === 'B');
  chk('T 59.5 rounds to 60 (D); 59.4 to 59 (F)', G.letterOf(G.roundScore(59.5)) === 'D' && G.letterOf(G.roundScore(59.4)) === 'F');
  chk('T 79.5 rounds to 80 (B); its floating-point drift 79.4999999999 too; 79.49 to 79 (C)', G.roundScore(79.5) === 80 && G.roundScore(79.4999999999) === 80 && G.roundScore(79.49) === 79);
  chk('T no score, no letter', G.letterOf(null) === null && G.roundScore(undefined) === null);
  const cfg = G.configFor('rg_v1');
  const wsum = Object.keys(cfg.weights).reduce((s, k) => s + cfg.weights[k], 0);
  chk('T the provisional weights are 30/25/20/15/10 and sum to 100', wsum === 100 && cfg.weights.reliability === 30 && cfg.weights.completeness === 25 && cfg.weights.market === 20 && cfg.weights.clarity === 15 && cfg.weights.uncertainty === 10);
  chk('T every dimension\'s sub-weights sum to 1', Object.keys(cfg.sub).every((d) => near(Object.keys(cfg.sub[d]).reduce((s, k) => s + cfg.sub[d][k], 0), 1, 1e-9)));
  chk('T the weights are labelled provisional and versioned', /provisional/.test(cfg.weights_version) && cfg.grade_version === 'rg_v1');
  const best = grade(strong(), ctx());
  chk('T a game with every input strong, a validated record and a close market is an A', best.grade.letter === 'A' && best.grade.score >= 90 && !best.grade.cap, { s: best.grade.score, raw: best.grade.raw_score, caps: best.grade.caps.map((c) => c.id), e: best.grade.explanation });
  const alt = JSON.parse(JSON.stringify(cfg)); alt.grade_version = 'rg_test_weights'; alt.weights = { reliability: 10, completeness: 10, market: 10, clarity: 60, uncertainty: 10 };
  const w = grade(strong({ availability: { key_role: 'QB', certainty: 'PROJECTED_UNCERTAIN' } }), ctx(), alt);
  const w0 = grade(strong({ availability: { key_role: 'QB', certainty: 'PROJECTED_UNCERTAIN' } }), ctx());
  chk('T weights are configuration: a different config scores differently and says which it used', w.grade.raw_score !== w0.grade.raw_score && w.grade.grade_version === 'rg_test_weights');
  const pts = G.DIMENSIONS.reduce((s, d) => s + best.grade.dimensions[d.id].points, 0);
  chk('T the dimension points add up to the raw score', near(pts, best.grade.raw_score, 0.06), { pts, raw: best.grade.raw_score });
  const subPts = G.DIMENSIONS.reduce((s, d) => s + best.grade.dimensions[d.id].items.reduce((t, x) => t + x.points, 0), 0);
  chk('T the sub-factor points add up to the raw score', near(subPts, best.grade.raw_score, 0.06), { subPts, raw: best.grade.raw_score });
})();

/* ------------------------------------------------------- M missing features */
(function missingFeatures() {
  const full = grade(strong(), ctx()).grade;
  /* removing any ordinary input never raises the grade, and the input is listed as missing */
  const removals = [
    ['input_data', (p, c) => { c.extra = null; p.invalidators = []; delete p.freshness.data_completeness; }, 'completeness'],
    ['sensitivity', (p) => { p.sensitivity = []; }, 'clarity'],
    ['explanation', (p) => { p.matchup = { factors: [], metrics: {} }; }, 'clarity'],
    ['start_time', (p, c) => { c.time_tbd = null; }, 'clarity'],
    ['model_spread', (p) => { p.uncertainty.basis = 'model_sd: the board default'; }, 'uncertainty'],
    ['calibration_band', (p) => { delete p.uncertainty.calibration_sd; }, 'uncertainty'],
    ['season_stage', (p, c) => { delete p.uncertainty.early_season; c.extra = { data_quality: { warnings: [], missing: [] } }; p.event_id = 'K1'; }, 'uncertainty'],
    ['provenance', (p) => { p.provenance = []; }, 'completeness'],
    ['walk_forward', (p) => { p.validation = { markets: {} }; }, 'reliability']
  ];
  removals.forEach(([id, fn, dim]) => {
    const p = strong(), c = ctx();
    fn(p, c);
    const g = grade(p, c).grade;
    const it = sub(g, dim, id);
    if (id === 'input_data') { chk('M input_data: the NFL reads its slate warnings even without the slate row (from the projection)', it.status === 'ok'); return; }
    chk('M ' + id + ' missing: scored 0, listed with its reason, never full credit', it.status === 'unavailable' && it.score === null && it.points === 0 && g.missing.some((m) => m.factor === id) && it.detail.length > 10, it);
    chk('M ' + id + ' missing: the raw score falls', g.raw_score < full.raw_score, { with: full.raw_score, without: g.raw_score });
  });
  /* a lab sport (no input-quality measure at all) */
  const lab = strong({ sport: 'wnba', event_key: 'WNBA|1', league: 'WNBA' });
  const gl = grade(lab, ctx({ extra: null })).grade;
  chk('M an engine with no input-quality measure earns nothing for it', sub(gl, 'completeness', 'input_data').status === 'unavailable');

  /* EXCLUDED AND CAPPED: the live track record */
  const tooFew = grade(strong(), ctx({ track: track(29) })).grade;
  const li = sub(tooFew, 'reliability', 'live_skill');
  chk('M an unvalidated live record (29 < 50) is excluded, not credited: 0 points, status unvalidated', li.status === 'unvalidated' && li.points === 0 && li.score === null);
  chk('M …and caps the grade at C', tooFew.score <= 79 && tooFew.caps.some((c) => c.id === 'CALIBRATION_UNVALIDATED') && tooFew.letter === 'C', { s: tooFew.score, caps: tooFew.caps });
  chk('M …and the explanation says why it is capped', /Capped at C/.test(tooFew.explanation) && /29 of 50/.test(tooFew.explanation), tooFew.explanation);
  const none = grade(strong(), ctx({ track: null })).grade;
  chk('M no live record at all: the same cap, and "no graded pregame forecasts" in the reasons', none.caps.some((c) => c.id === 'CALIBRATION_UNVALIDATED') && /no graded pregame forecasts/.test(sub(none, 'reliability', 'live_skill').detail));
  const early = grade(strong(), ctx({ track: track(120) })).grade;
  chk('M an early-signal record (50–199) counts and caps at B', sub(early, 'reliability', 'live_skill').status === 'ok' && early.caps.some((c) => c.id === 'CALIBRATION_EARLY_SIGNAL') && early.score <= 89);
  const enough = grade(strong(), ctx({ track: track(200) })).grade;
  chk('M from 200 graded games the record caps nothing', !enough.caps.some((c) => /^CALIBRATION/.test(c.id)));

  /* EXCLUDED AND CAPPED: the market line */
  const noMkt = grade(strong(), ctx({ quote: null, quote_status: 'NO_QUOTE' })).grade;
  chk('M no pregame line: the market dimension is excluded (no points), status excluded', noMkt.dimensions.market.status === 'excluded' && noMkt.dimensions.market.points === 0 && noMkt.dimensions.market.score === null);
  chk('M …the total stands on the other 80 weight points', noMkt.included_weight === 80);
  chk('M …and the grade is capped at B, however strong the rest', noMkt.score <= 89 && noMkt.letter === 'B' && noMkt.caps.some((c) => c.id === 'NO_PREGAME_MARKET'), { s: noMkt.score, raw: noMkt.raw_score });
  chk('M …listed as missing with the reason', noMkt.missing.filter((m) => m.dimension === 'market').length >= 3 && noMkt.flags.indexOf('NO_PREGAME_MARKET') >= 0);
  chk('M a game with no line never outranks the same game with a close line', noMkt.score <= full.score);

  /* key-role availability unknown */
  const unk = grade(strong({ availability: { key_role: 'QB', certainty: 'UNKNOWN' } }), ctx()).grade;
  chk('M unknown key-role availability scores 0 and caps at C', sub(unk, 'clarity', 'key_role').score === 0 && unk.caps.some((c) => c.id === 'KEY_ROLE_UNKNOWN') && unk.score <= 79);

  /* GATES → INSUFFICIENT DATA */
  const gate = (name, p, c, id) => { const g = grade(p, c).grade; chk('M gate ' + id + ': ' + name + ' → Insufficient Data, no letter, no score', g.state === 'INSUFFICIENT' && g.letter === null && g.score === null && g.failed_gates.indexOf(id) >= 0 && /^Not graded/.test(g.explanation), { st: g.state, f: g.failed_gates }); };
  gate('no win probability', strong({ outcome: {} }), ctx(), 'MODEL_OUTPUT');
  gate('an invalidated projection (a starter conflict)', strong({ integrity: { invalidated: true, conflicts: [{}] } }), ctx(), 'INTEGRITY');
  gate('research DATA_INSUFFICIENT', strong({ research: { outcome: 'DATA_INSUFFICIENT', reasons: ['x'] } }), ctx(), 'RESEARCH_STATE');
  gate('a market-fed model', strong({ model: Object.assign({}, strong().model, { market_inputs: ['consensus'] }) }), ctx(), 'INDEPENDENT_MODEL');
  gate('an expired build', strong({ freshness: { state: 'EXPIRED', age_hours: 40, max_age_hours: 30 } }), ctx(), 'FRESH_BUILD');
  gate('an unsupported sport', strong({ sport: 'mlb', event_key: 'MLB|1' }), ctx(), 'SPORT_SUPPORTED');
  const thin = strong({ outcome: { p_home: 0.6 }, fair: {}, projected_score: null, provenance: [], freshness: { state: 'FRESH', age_hours: null, max_age_hours: null }, invalidators: [] });
  gate('a completeness below the floor', thin, ctx({ extra: { data_quality: { warnings: ['a', 'b', 'c', 'd', 'e'] } } }), 'COMPLETENESS_FLOOR');
  const ins = grade(strong({ outcome: {} }), ctx()).grade;
  chk('M an ungraded game still shows its breakdown (every dimension computed)', G.DIMENSIONS.every((d) => ins.dimensions[d.id] && Array.isArray(ins.dimensions[d.id].items)));
})();

/* ----------------------------------------------- D model–market disagreement */
(function disagreement() {
  const agree = grade(strong(), ctx()).grade;
  const q = JSON.parse(JSON.stringify(QUOTE)); q.spread.home_point = 6.5; q.spread.away_point = -6.5; q.moneyline = { home: 220, away: -270 };
  const dis = grade(strong(), ctx({ quote: q })).grade;
  chk('D a 10-point spread disagreement earns nothing on the spread and flags LARGE_MODEL_MARKET_GAP', sub(dis, 'market', 'spread_agreement').score === 0 && dis.flags.indexOf('LARGE_MODEL_MARKET_GAP') >= 0);
  chk('D …and the grade falls (a big unexplained gap is a research risk, not an edge)', dis.score < agree.score && dis.dimensions.market.score < agree.dimensions.market.score);
  const q2 = JSON.parse(JSON.stringify(QUOTE)); q2.spread.home_point = -4; q2.spread.away_point = 4;
  const small = grade(strong(), ctx({ quote: q2 })).grade;
  chk('D a half-point gap is agreement (within tolerance): full spread credit', sub(small, 'market', 'spread_agreement').score === 100);
  const words = [agree, dis, small].map((g) => g.explanation).join(' ');
  chk('D no explanation ever recommends a side, a bet or an edge', !/\b(bet|wager|take the|lock|play the|value on|edge on)\b/i.test(words), words);
  const ev = G.evaluatedSides(G.normalize(strong(), ctx({ quote: q })));
  chk('D the evaluated side is the side EdgeDesk\'s number sat on (home −3.5 fair vs +6.5 market → home)', ev.spread.side === 'home' && ev.spread.line === 6.5 && ev.spread.gap === 10);
})();

/* ------------------------------------------------------------ F stale data */
(function stale() {
  const near0 = grade(strong({ freshness: { state: 'FRESH', age_hours: 26, max_age_hours: 30 } }), ctx()).grade;
  chk('F a build at 87% of its age limit scores 30 on freshness and is flagged', sub(near0, 'completeness', 'build_freshness').score === 30 && near0.flags.indexOf('BUILD_NEAR_AGE_LIMIT') >= 0);
  const q = Object.assign({}, QUOTE, { captured_at: '2026-10-18T06:00:00.000Z' });
  const old = grade(strong(), ctx({ quote: q })).grade;
  chk('F a 30-hour-old line scores 20 on its age and is flagged STALE_MARKET_LINE', sub(old, 'market', 'quote_age').score === 20 && old.flags.indexOf('STALE_MARKET_LINE') >= 0);
  const nhl = strong({ sport: 'nhl', event_key: 'NHL|1', freshness: { state: 'FRESH', age_hours: 1, max_age_hours: 8, data_state: 'STALE' } });
  chk('F a lagging NHL results feed costs input-quality credit', sub(grade(nhl, ctx({ extra: null })).grade, 'completeness', 'input_data').score === 30);
})();

/* --------------------------------------------------------- A sport adapters */
(function adapters() {
  ['nfl', 'cfb', 'nba', 'nhl', 'wnba', 'ncaab_m', 'ncaab_w'].forEach((s) => chk('A ' + s + ' has an adapter', !!G.SPORTS[s]));
  const nhl = strong({ sport: 'nhl', event_key: 'NHL|1', fair: { moneyline: {}, spread: { home_line: null }, total: { line: 6.5, expected: 6.4 } }, projected_score: { home: 3.4, away: 3.0, total: 6.4 } });
  const gn = grade(nhl, ctx({ extra: { data_quality: { early_season: false } }, quote: Object.assign({}, QUOTE, { spread: { home_point: -1.5, home_price: 150, away_point: 1.5, away_price: -170 }, total: { point: 6.5, over: -110, under: -110 } }) })).grade;
  chk('A NHL: the puck line is not a margin — the spread comparison does not arise (n/a), never penalised', sub(gn, 'market', 'spread_agreement').status === 'n/a' && sub(gn, 'market', 'spread_agreement').points === 0 && gn.dimensions.market.score > 80);
  chk('A NHL: a missing margin is not an expected output', sub(gn, 'completeness', 'model_outputs').score === 100);
  chk('A NHL: early season from the slate', sub(gn, 'uncertainty', 'season_stage').score === 100);
  const cfb = strong({ sport: 'cfb', event_key: 'CFB|1', matchup: { factors: [], metrics: { reliability_score: 72, reliability_grade: 'ADEQUATE', a: 1 } },
    uncertainty: { model_sd: 0.03, calibration_sd: 0.05, lineup_sd: 0.012, basis: 'board defaults; calibration from the moneyline\'s measured offset' } });
  const gc = grade(cfb, ctx({ extra: { week: 2, kickoff_tbd: true, projection_stability: { projection_stability_sd: 3.75, tier: 'MODERATE', favorite_flip_rate: 0.1 } } })).grade;
  chk('A CFB: input quality is lib/cfb_reliability.js\'s own score, not a recount', sub(gc, 'completeness', 'input_data').score === 72 && /CFB reliability 72/.test(sub(gc, 'completeness', 'input_data').detail));
  chk('A CFB: the slate\'s projection stability measures model spread (sd 3.75 → 50)', near(sub(gc, 'uncertainty', 'model_spread').score, 50, 0.1));
  chk('A CFB: week 2 is early season; a TBA kickoff scores 0 and is flagged', sub(gc, 'uncertainty', 'season_stage').score === 40 && sub(gc, 'clarity', 'start_time').score === 0 && gc.flags.indexOf('START_TIME_TBA') >= 0);
  const nflW = grade(strong(), ctx({ extra: { week: 7, data_quality: { warnings: ['home QB starter unknown'], missing: ['forecast'] } } })).grade;
  chk('A NFL: the slate\'s two data-quality items cost 40 points of input quality', sub(nflW, 'completeness', 'input_data').score === 60);
  const lab = grade(strong({ sport: 'ncaab_m', event_key: 'NCAAM|1', availability: { key_role: 'STAR', certainty: 'UNKNOWN' }, matchup: { factors: [], metrics: { games_this_season: { home: 3, away: 12 } } } }), ctx({ extra: null })).grade;
  chk('A lab sports: availability is not modelled — missing, and capped at C', sub(lab, 'clarity', 'key_role').status === 'unavailable' && lab.caps.some((c) => c.id === 'KEY_ROLE_UNKNOWN'));
  chk('A lab sports: fewer than 10 games for a side is early season', sub(lab, 'uncertainty', 'season_stage').score === 40);
  const nba = grade(strong({ sport: 'nba', event_key: 'NBA|1', uncertainty: { model_sd: 0.03, calibration_sd: 0.015, margin_sd: 14.6, early_season: true, rotation_stale: true, basis: 'model_sd: 12 candidate models' }, fair: { moneyline: {}, spread: { home_line: -2.5 }, total: { line: 218.5, expected: 218.75 } } }), ctx({ extra: null })).grade;
  chk('A NBA: a stale rotation costs input quality; the 12-model disagreement is a measurement', sub(nba, 'completeness', 'input_data').score === 55 && sub(nba, 'uncertainty', 'model_spread').status === 'ok');
})();

/* ------------------------------------------------- O odds-provider failures */
(function odds() {
  [['NO_SLATE', 'ODDS_PROVIDER_UNAVAILABLE'], ['SLATE_STALE', 'ODDS_PROVIDER_UNAVAILABLE'], ['NOT_ON_SLATE', 'NO_PREGAME_MARKET'], ['AMBIGUOUS', 'NO_PREGAME_MARKET'], ['NO_QUOTE', 'NO_PREGAME_MARKET']].forEach(([st, flag]) => {
    const g = grade(strong(), ctx({ quote: null, quote_status: st })).grade;
    chk('O ' + st + ': market excluded, capped at B, flagged ' + flag + ', the reason said', g.dimensions.market.status === 'excluded' && g.score <= 89 && g.flags.indexOf(flag) >= 0 && g.missing.some((m) => m.why === G.quoteWhy(st)), { flags: g.flags });
  });
  const late = Object.assign({}, QUOTE, { captured_at: START });
  const gl = grade(strong(), ctx({ quote: late })).grade;
  chk('O a line captured at the start is dropped (never graded on), flagged LEAKAGE_GUARD', gl.dimensions.market.status === 'excluded' && gl.flags.indexOf('LEAKAGE_GUARD_QUOTE_DROPPED') >= 0);
  const after = Object.assign({}, QUOTE, { captured_at: '2026-10-19T13:00:00.000Z' });
  const ga = grade(strong(), ctx({ quote: after })).grade;
  chk('O a line captured after the grade\'s own moment is dropped too', ga.dimensions.market.status === 'excluded');
  const partial = grade(strong(), ctx({ quote: Object.assign({}, QUOTE, { total: null, moneyline: null }) })).grade;
  chk('O a line with no total or moneyline: those comparisons are missing (0), the spread still counts', sub(partial, 'market', 'total_agreement').status === 'unavailable' && sub(partial, 'market', 'moneyline_agreement').status === 'unavailable' && sub(partial, 'market', 'spread_agreement').status === 'ok');
})();

/* ------------------------------------------------------- R reproducibility */
(function reproducibility() {
  const r = grade(strong(), ctx());
  const row = G.snapshotRow(strong(), r.inputs, r.grade, { forecast_hash: 'f'.repeat(64) });
  const rt = JSON.parse(JSON.stringify(row));
  chk('R a snapshot re-scores from its own stored inputs, unchanged (after a JSON round trip)', G.reproduce(rt).ok, G.reproduce(rt).diffs);
  chk('R the same inputs give the same grade, every time', JSON.stringify(G.score(rt.inputs, 'rg_v1')) === JSON.stringify(G.score(rt.inputs, 'rg_v1')));
  const t = JSON.parse(JSON.stringify(row)); t.inputs.availability.certainty = 'UNKNOWN';
  chk('R a tampered input no longer reproduces the stored grade', !G.reproduce(t).ok);
  const v = JSON.parse(JSON.stringify(row)); v.versions.grade = 'rg_v99';
  chk('R an unknown grade version is refused, never re-scored under another', !G.reproduce(v).ok && /unknown grade version/.test(G.reproduce(v).why));
  chk('R the snapshot carries the versions, the forecast and the line it saw', row.versions.grade === 'rg_v1' && /provisional/.test(row.versions.weights) && row.versions.model_id === 'edgedesk_football_v1.0.0' && row.forecast.hash === 'f'.repeat(64)
    && row.market.book === 'Draft Kings' && row.market.provider === 'espn_scoreboard' && row.market.captured_at === QUOTE.captured_at && row.captured_at === AS_OF);
  const q2 = JSON.parse(JSON.stringify(QUOTE)); q2.spread.home_price = -112; q2.spread.away_price = -108;
  const r2 = grade(strong(), ctx({ quote: q2 }));
  const row2 = G.snapshotRow(strong(), r2.inputs, r2.grade, { forecast_hash: 'f'.repeat(64) });
  chk('R a price move that changes nothing in the grade is not a new revision (same signature)', row2.signature === row.signature && /^rgs1:[0-9a-f]{16}$/.test(row.signature));
  const q3 = JSON.parse(JSON.stringify(QUOTE)); q3.spread.home_point = 3.5; q3.spread.away_point = -3.5;
  const r3 = grade(strong(), ctx({ quote: q3 }));
  chk('R a line move that changes the grade\'s parts is a new revision', G.snapshotRow(strong(), r3.inputs, r3.grade, { forecast_hash: 'f'.repeat(64) }).signature !== row.signature);
  chk('R …the component scores, flags and calculation inputs', G.DIMENSIONS.every((d) => row.grade.dimensions[d.id] && row.grade.dimensions[d.id].sub) && Array.isArray(row.grade.flags) && row.inputs.v === 1);
})();

/* ---------------------------------------------------------------- X leakage */
(function leakage() {
  const rows = [
    { event_key: 'A', sport: 'nfl', family: 'f1', start_utc: '2026-10-10T00:00:00Z', graded_at: '2026-10-10T04:00:00Z', p_home: 0.7, outcome: 1, revision: 1 },
    { event_key: 'B', sport: 'nfl', family: 'f1', start_utc: '2026-10-19T00:00:00Z', graded_at: '2026-10-19T13:00:00Z', p_home: 0.7, outcome: 0, revision: 1 }, /* graded AFTER as-of */
    { event_key: 'C', sport: 'nfl', family: 'f1', start_utc: '2026-10-19T18:00:00Z', graded_at: '2026-10-19T11:00:00Z', p_home: 0.7, outcome: 0, revision: 1 }, /* starts after as-of (impossible, but refused) */
    { event_key: 'D', sport: 'nfl', family: 'f2', start_utc: '2026-10-10T00:00:00Z', graded_at: '2026-10-10T04:00:00Z', p_home: 0.7, outcome: 0, revision: 1 }, /* another model family */
    { event_key: 'A', sport: 'nfl', family: 'f1', start_utc: '2026-10-10T00:00:00Z', graded_at: '2026-10-11T04:00:00Z', p_home: 0.7, outcome: 1, revision: 2 }, /* a regrade of A */
    { event_key: 'E', sport: 'nfl', family: 'f1', start_utc: '2026-10-11T00:00:00Z', graded_at: '2026-10-11T04:00:00Z', p_home: 0.6, outcome: 'push', revision: 1 }
  ];
  const voided = G.trackRecord(rows.concat([{ event_key: 'A', sport: 'nfl', family: 'f1', start_utc: '2026-10-10T00:00:00Z', graded_at: '2026-10-12T04:00:00Z', revision: 3, eligible: false, p_home: null, outcome: null }]), { sport: 'nfl', family: 'f1', as_of: AS_OF });
  chk('X a game regraded void later counts as its latest revision (void): it leaves the record', voided.n === 0, voided);
  const RGm = require('./research_grades.js');
  const tr = RGm.trackRows({ forecasts: [{ hash: 'fh', model: { id: 'f1:x' } }], grades: [{ event_key: 'A', sport: 'nfl', forecast_hash: 'fh', start_utc: 'x', graded_at: 'y', eligible: false, why: 'VOID_CANCELED', revision: 2 }] });
  chk('X the job hands the track record every revision, a void one included', tr.length === 1 && tr[0].eligible === false && tr[0].family === 'f1');
  const t = G.trackRecord(rows, { sport: 'nfl', family: 'f1', as_of: AS_OF });
  chk('X the track record reads only games started and graded before the grade, once each, its own model family', t.n === 1 && near(t.brier, 0.09), t);
  const t2 = G.trackRecord(rows, { sport: 'nfl', family: 'f1', as_of: '2026-10-20T00:00:00Z' });
  chk('X …and games graded later join only later grades', t2.n === 3, t2);
  const g = grade(strong(), ctx({ as_of: START })).grade;
  chk('X a grade at the start is refused (PREGAME gate)', g.state === 'INSUFFICIENT' && g.failed_gates.indexOf('PREGAME') >= 0);
  const p = strong(); p.model.predicted_at = START;
  chk('X a model number produced at the start is refused', grade(p, ctx()).grade.failed_gates.indexOf('PREGAME') >= 0);
})();

/* ------------------------------------------------------------- S settlement */
function snapFor(o) {
  o = o || {};
  const r = grade(strong(), ctx({ quote: o.quote || QUOTE, as_of: o.as_of || AS_OF }));
  const row = G.snapshotRow(strong(), r.inputs, r.grade, { forecast_hash: 'f'.repeat(64) });
  row.hash = o.hash || 'h' + Math.random().toString(16).slice(2);
  return row;
}
(function settlement() {
  const s1 = snapFor({ as_of: '2026-10-19T08:00:00.000Z', hash: 'a' }), s2 = snapFor({ hash: 'b' });
  const late = snapFor({ hash: 'c' }); late.captured_at = START;
  let d = G.designate([s1, s2, late], START);
  chk('S the designated grade is the latest captured before the actual start', d.snapshot.hash === 'b' && d.revisions === 2 && d.ineligible.some((x) => x.why === 'CAPTURED_AFTER_START'));
  d = G.designate([s1, s2], '2026-10-23T00:00:00.000Z');
  chk('S a start moved by more than 36 hours voids the earlier grades (graded a different date)', !d.snapshot && d.ineligible.every((x) => x.why === 'RESCHEDULED'));
  chk('S no snapshot, no designated grade (and none is made up)', G.designate([], START).snapshot === null);

  const s = snapFor({ hash: 'x' });
  const fin = (h, a, dec) => ({ state: 'FINAL', home_score: h, away_score: a, start_utc: START, hash: 'r', decided: dec || null, verified_at: '2026-10-20T04:00:00.000Z' });
  let o = G.settle(s, fin(24, 20));
  chk('S Brier is (p − outcome)²: 0.6 and a home win → 0.16', o.winner.brier === 0.16 && o.winner.correct === true);
  chk('S margin error is actual − projected (4 − 3.5 = 0.5); total 44 vs 44 → 0', o.spread.error === 0.5 && o.total.abs_error === 0);
  /* model fair −3.5 vs market −3.5: no gap → no evaluated side, no ATS row */
  chk('S no gap between EdgeDesk and the line → no evaluated side, no ATS record', !s.evaluated.spread && !o.market.spread.pick);
  const q = JSON.parse(JSON.stringify(QUOTE)); q.spread.home_point = -1.5; q.spread.away_point = 1.5;
  const sh = snapFor({ quote: q, hash: 'y' });
  chk('S spread direction: fair −3.5 vs market −1.5 → home is the side saved pregame', sh.evaluated.spread.side === 'home' && sh.evaluated.spread.home_line === -1.5);
  o = G.settle(sh, fin(24, 20)); chk('S home −1.5, won by 4: a win at the saved line', o.market.spread.pick.result === 'win' && near(o.market.spread.pick.units, 0.9091, 1e-4));
  o = G.settle(sh, fin(21, 20)); chk('S home −1.5, won by 1: a loss, though the home side won the game', o.market.spread.pick.result === 'loss' && o.winner.correct === true);
  const q2 = JSON.parse(JSON.stringify(QUOTE)); q2.spread.home_point = -5; q2.spread.away_point = 5;
  const sa = snapFor({ quote: q2, hash: 'z' });
  o = G.settle(sa, fin(24, 20));
  chk('S fair −3.5 vs market −5 → away +5 saved pregame; home by 4 → away covers', sa.evaluated.spread.side === 'away' && sa.evaluated.spread.line === 5 && o.market.spread.pick.result === 'win');
  o = G.settle(sa, fin(25, 20)); chk('S home by exactly 5 → a push at +5', o.market.spread.pick.result === 'push' && o.market.spread.pick.units === 0);
  const sideBefore = JSON.stringify(sa.evaluated);
  G.settle(sa, fin(40, 0)); G.settle(sa, fin(0, 40));
  chk('S the final never chooses or changes the side: the saved side is the same after any result', JSON.stringify(sa.evaluated) === sideBefore);
  chk('S over/under from the saved side only: no total gap (44 vs 44) → no O/U row', !sa.evaluated.total);
  o = G.settle(s, fin(20, 20)); chk('S a tie (NFL) is not scored for Brier, still scored for margin', o.winner.outcome === 'push' && o.winner.brier === null && o.spread.actual_margin === 0);
  o = G.settle(s, fin(27, 24, 'OT')); chk('S overtime counts, and is recorded', o.final.margin === 3 && o.settlement.overtime === true && o.settlement.decided === 'OT');
  ['CANCELED', 'FORFEIT', 'POSTPONED_UNRESOLVED'].forEach((why) => {
    const v = G.settle(s, { state: 'VOID', void_reason: why, start_utc: START, hash: 'v' });
    chk('S a ' + why.toLowerCase() + ' game is void: ineligible, never a win or a loss', v.eligible === false && v.why === 'VOID_' + why && !v.winner && v.settlement.state === 'VOID');
  });
  const qe = JSON.parse(JSON.stringify(q)); qe.source = 'espn_scoreboard';
  const se = snapFor({ quote: qe, hash: 'w' });
  o = G.settle(se, fin(24, 20), { close: { home_line: -2.5, total: 45, source: 'nflverse' } });
  chk('S CLV only against a same-source close: nflverse vs ESPN → none, but the close is noted', !o.market.clv && o.closing_line.available === true);
  o = G.settle(se, fin(24, 20), { close: { home_line: -2.5, total: 45, source: 'ESPN close' } });
  chk('S same source family: CLV in points from the saved side (home −1.5 → close −2.5 = +1)', o.market.clv && o.market.clv.spread_pts === 1);
  o = G.settle(snapFor({ hash: 'n' }), fin(24, 20));
  chk('S no captured line → no market comparison and no CLV at all', o.market !== null && snapFor().market.status === 'CAPTURED');
  const nomk = snapFor({ hash: 'nm' }); nomk.market = { status: 'NO_QUOTE' }; nomk.evaluated = { spread: null, total: null };
  o = G.settle(nomk, fin(24, 20));
  chk('S a grade with no line settles winner/margin/total and nothing at a line', o.market === null && o.winner && o.spread);
})();

/* ------------------------------------------------------------ P performance */
(function performance() {
  /* synthetic settled rows: A games well forecast, B games badly, one void, one ungraded */
  const mk = (letter, p, y, mErr, i, extra) => G.compact(Object.assign({ event_key: letter + i, sport: i % 2 ? 'nfl' : 'cfb', league: i % 2 ? 'NFL' : 'FBS', season: 2026, start_utc: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 3600e3).toISOString(),
    letter, score: letter === 'A' ? 92 : letter === 'B' ? 84 : letter === 'INSUFFICIENT' ? null : 65, grade_state: letter === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'GRADED', grade_version: 'rg_v1', model_id: 'm',
    dims: { reliability: 80, completeness: 90, market: 70, clarity: 60, uncertainty: 50 }, market_status: 'CAPTURED', evaluated: { spread: true, total: false },
    outcome: { eligible: true, settlement: { state: 'SETTLED' }, winner: { p_home: p, outcome: y, brier: +((p - y) * (p - y)).toFixed(6), correct: (p > 0.5) === (y === 1) },
      spread: { error: mErr, abs_error: Math.abs(mErr) }, total: { error: 2, abs_error: 2 },
      market: { spread: { line: -3, market_margin: 3, market_abs_error: 5, pick: { side: 'home', gap: 2, result: i % 3 ? 'win' : 'loss', price: -110, units: i % 3 ? 0.9091 : -1 } } } } }, extra || {}));
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(mk('A', 0.8, i % 10 < 8 ? 1 : 0, (i % 5) - 2, i));
  for (let i = 0; i < 60; i++) rows.push(mk('B', 0.8, i % 10 < 4 ? 1 : 0, (i % 7) * 3 - 9, 100 + i));
  for (let i = 0; i < 5; i++) rows.push(mk('C', 0.55, 1, 3, 200 + i));
  rows.push(mk('D', 0.6, 1, 1, 300, { outcome: { eligible: false, why: 'VOID_CANCELED', settlement: { state: 'VOID' } } }));
  rows.push(mk('INSUFFICIENT', 0.6, 1, 1, 301));
  const perf = G.performance(rows);
  chk('P the distribution counts every row once', perf.distribution.A === 60 && perf.distribution.B === 60 && perf.distribution.C === 5 && perf.distribution.D === 1 && perf.distribution.INSUFFICIENT === 1
    && Object.keys(perf.distribution).reduce((s, k) => s + perf.distribution[k], 0) === rows.length);
  chk('P totals: graded, ungraded, settled, void', perf.totals.games === 127 && perf.totals.graded === 126 && perf.totals.ungraded === 1 && perf.totals.settled_graded === 125 && perf.totals.void === 1);
  const aB = rows.filter((x) => x.letter === 'A').map((x) => x.outcome.winner.brier);
  const bB = rows.filter((x) => x.letter === 'B').map((x) => x.outcome.winner.brier);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  chk('P the A Brier equals the mean of its records', near(perf.by_letter.A.metrics.winner.brier, +mean(aB).toFixed(4), 1e-4) && near(perf.by_letter.A.brier_ci.mean, mean(aB), 1e-4));
  const aM = rows.filter((x) => x.letter === 'A').map((x) => x.outcome.spread.error);
  chk('P the A margin MAE and RMSE equal their records', near(perf.by_letter.A.metrics.margin.mae, +mean(aM.map(Math.abs)).toFixed(2), 0.006) && near(perf.by_letter.A.metrics.margin.rmse, +Math.sqrt(mean(aM.map((x) => x * x))).toFixed(2), 0.006));
  chk('P every by-letter game count adds up to the total', G.LETTER_IDS.concat(['INSUFFICIENT']).reduce((s, k) => s + perf.by_letter[k].games, 0) === perf.totals.games);
  chk('P the C group (5 games) prints no rate, only its counts', perf.by_letter.C.metrics.winner.brier === null && perf.by_letter.C.settled === 5 && perf.by_letter.C.sample_state === 'TOO_EARLY');
  chk('P an interval only from 50: A (60) has one, C (5) none', perf.by_letter.A.brier_ci.low != null && perf.by_letter.C.brier_ci.low === null);
  chk('P the ATS record counts only sides saved pregame', perf.by_letter.A.metrics.picks.spread[0].n === 60);
  const ab = perf.ordering.pairs.filter((x) => x.higher === 'A' && x.lower === 'B')[0];
  chk('P with 60 each and a large gap, A vs B shows evidence (interval excludes zero)', ab.brier.evidence === true && ab.brier.diff > 0 && perf.ordering.any_evidence === true);
  const bc = perf.ordering.pairs.filter((x) => x.higher === 'B' && x.lower === 'C')[0];
  chk('P B vs C (5 games) claims nothing', bc.brier.evidence === false && /50 settled games/.test(bc.brier.why));
  /* the same letters with identical outcomes: no evidence, and the statement says so */
  const same = [];
  for (let i = 0; i < 60; i++) { same.push(mk('A', 0.7, i % 10 < 7 ? 1 : 0, 1, i)); same.push(mk('B', 0.7, i % 10 < 7 ? 1 : 0, 1, 500 + i)); }
  const ps = G.performance(same);
  chk('P never assume A beats B: equal records → "no evidence yet"', ps.ordering.any_evidence === false && /No evidence yet/.test(ps.ordering.statement));
  chk('P filters: sport, league, season, model, grade version, market type, dates', G.filterRows(rows, { sport: 'nfl' }).every((x) => x.sport === 'nfl') && G.filterRows(rows, { league: 'FBS' }).every((x) => x.league === 'FBS')
    && G.filterRows(rows, { season: '2026' }).length === rows.length && G.filterRows(rows, { model: 'zzz' }).length === 0 && G.filterRows(rows, { grade_version: 'rg_v1' }).length === rows.length
    && G.filterRows(rows, { market: 'ou' }).length === 0 && G.filterRows(rows, { market: 'ats' }).length === rows.length && G.filterRows(rows, { from: '2026-09-01T10:00:00Z', to: '2026-09-01T12:00:00Z' }).length === 2);
  const tr = G.trend(rows);
  chk('P the trend counts every game once, by week and letter', tr.reduce((s, w) => s + w.games, 0) === rows.length && tr.every((w) => Object.keys(w.counts).reduce((s, k) => s + w.counts[k], 0) === w.games));
})();

/* ---------------------------------------------------------- L lifecycle */
(async function lifecycle() {
  const { root, runs, START: S0 } = await F.lifecycle();
  const st = runs[2].state;
  chk('L two pregame grade revisions are locked (the line moved), each with its forecast hash', st.research_grades.length === 2 && st.research_grades.every((s) => s.forecast && s.forecast.hash && s.capture.method === 'ledger_capture'));
  chk('L the second names the first it supersedes; history is kept', st.research_grades[1].revision === 2 && st.research_grades[1].supersedes === st.research_grades[0].hash);
  chk('L every grade was captured before kickoff', st.research_grades.every((s) => Date.parse(s.captured_at) < Date.parse(S0)));
  const o = st.grade_outcomes[0];
  chk('L the outcome judges the LATEST valid pregame grade, with its letter', st.grade_outcomes.length === 1 && o.snapshot_hash === st.research_grades[1].hash && o.letter === st.research_grades[1].grade.letter);
  chk('L the saved side (away +4.5) settles against the final (27-24 OT): away covers', o.market.spread.pick.side === 'away' && o.market.spread.pick.result === 'win' && o.settlement.overtime === true);
  chk('L the close is noted (nflverse); no CLV against an ESPN line', o.closing_line.available === true && !o.market.clv);

  /* immutability: a duplicate run adds nothing, the files only grow */
  const RUN = require('./run.js');
  const before = L.listFiles(root, 'research_grades').concat(L.listFiles(root, 'grade_outcomes')).map((f) => [f, fs.readFileSync(f, 'utf8')]);
  let r = await RUN.runAll({ root, now: Date.parse('2026-10-02T05:00:00Z'), write: true, network: false, projections: [], log: () => {} });
  chk('L a duplicate run appends no grade and no outcome', r.report.steps.grade_outcomes.appended === 0 && r.state.research_grades.length === 2 && r.state.grade_outcomes.length === 1);
  chk('L the ledger files are byte-identical prefixes after the run', before.every(([f, t]) => L.verifyPrefix(t, fs.readFileSync(f, 'utf8')).ok));
  /* kickoff cutoff: a projection run at the start is refused */
  r = await RUN.runAll({ root, now: Date.parse(S0), write: true, network: false, projections: [F.proj({ id: 'G1', start: S0, pred: '2026-10-01T23:00:00.000Z', p: 0.9, line: -10, total: 50 })], log: () => {} });
  chk('L at kickoff no grade is made (STARTED), the locked ones stand', r.report.steps.research_grades.appended === 0 && (r.report.steps.research_grades.refused.STARTED || 0) === 1 && r.state.research_grades.length === 2);
  /* a corrected final: a new outcome revision, the old one kept */
  F.writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: S0, home: 'Green Bay Packers', away: 'Atlanta Falcons', final: { home_score: 27, away_score: 21, source: 'nflverse' } } } });
  F.writeJson(root, 'today/slate.json', F.slateFile([], {}, '2026-10-05T00:00:00.000Z'));
  r = await RUN.runAll({ root, now: Date.parse('2026-10-05T00:00:00Z'), write: true, network: false, projections: [], log: () => {} });
  const o2 = PL.latest(r.state.grade_outcomes);
  chk('L a corrected final (27-21) is a new outcome revision that supersedes the first: away +4.5 now loses', r.state.grade_outcomes.length === 2 && o2.revision === 2 && o2.supersedes === o.hash && o2.reason === 'result_revision' && o2.market.spread.pick.result === 'loss');
  chk('L the snapshot it judges is unchanged by the correction', o2.snapshot_hash === o.snapshot_hash && r.state.research_grades.length === 2);
  /* tamper detection */
  const gf = L.listFiles(root, 'research_grades')[0];
  const text = fs.readFileSync(gf, 'utf8');
  fs.writeFileSync(gf, text.replace('"letter":"C"', '"letter":"A"'));
  chk('L a rewritten grade breaks the chain (and the job refuses to run on it)', !L.verifyAll(root).ok);
  const blocked = await RUN.runAll({ root, now: Date.parse('2026-10-05T01:00:00Z'), write: true, network: false, projections: [], log: () => {} });
  chk('L …the next run writes nothing', !!blocked.report.blocked);
  fs.writeFileSync(gf, text);
  const rows = L.readRows(gf);
  const forged = JSON.parse(JSON.stringify(rows[0])); forged.inputs.availability.certainty = 'CONFIRMED';
  chk('L a snapshot whose inputs were edited no longer reproduces its stored grade', !G.reproduce(forged).ok);
  chk('L --check reproduces every committed grade in the lifecycle', RUN.check(root, null).ok);

  /* the public files */
  const live = F.readJson(root, 'performance/data/grades/live.json');
  chk('L no started game is in live.json', Object.keys(live.games).length === 0);
  const sum = F.readJson(root, 'performance/data/grades/summary.json');
  const gfile = F.readJson(root, sum.games[0].path.slice(1));
  chk('L the summary totals equal the game rows they were built from', sum.overall.totals.games === gfile.rows.length && sum.overall.totals.settled_graded === gfile.rows.filter((x) => x.outcome && x.outcome.eligible && x.letter !== 'INSUFFICIENT').length);
  chk('L the dashboard stays in its insufficient-data state with one settled game', sum.insufficient === true && sum.overall.by_letter.C.metrics.winner.brier === null);
  chk('L the page recomputes the same numbers from the rows (one kernel)', JSON.stringify(G.performance(gfile.rows).totals) === JSON.stringify(sum.overall.totals));
  fs.rmSync(root, { recursive: true, force: true });

  /* a second repository: missing odds, postponement, a model-version change, a grade-version change, no backfill */
  const r2 = F.makeRoot();
  const S2 = '2026-10-09T00:15:00.000Z';
  const run2 = (now, pj) => RUN.runAll({ root: r2, now, write: true, network: false, projections: pj || [], log: () => {} });
  F.writeJson(r2, 'record/football/nfl_2026.json', { games: {} });
  /* the odds feed is down: no slate at all */
  let x = await run2(Date.parse('2026-10-08T12:00:00Z'), [F.proj({ id: 'G2', start: S2, pred: '2026-10-08T10:00:00.000Z', p: 0.55, line: -1, total: 41 })]);
  const g2 = PL.latest(x.state.research_grades);
  chk('L the odds feed down: graded without a line, market excluded, capped at B, flagged', g2.market.status === 'NO_SLATE' && g2.grade.caps.indexOf('NO_PREGAME_MARKET') >= 0 && g2.grade.flags.indexOf('ODDS_PROVIDER_UNAVAILABLE') >= 0);
  const hl = F.readJson(r2, 'performance/data/health.json');
  chk('L …and health says the odds feed failed', hl.items.some((i) => i.check === 'odds_feed'));
  chk('L an upcoming grade in live.json carries no model number', !/"p_home"|"fair_home_line"|"projected_margin"|"projected_total"/.test(JSON.stringify(F.readJson(r2, 'performance/data/grades/live.json'))));
  /* the feed returns with a line: a new revision */
  F.writeJson(r2, 'today/slate.json', F.slateFile([F.ev({ espn: 9002, start: S2, at: '2026-10-08T13:00:00.000Z' })], { 'nfl:espn:9002': F.market('2026-10-08T13:00:00.000Z', -1, 41) }, '2026-10-08T13:00:00.000Z'));
  x = await run2(Date.parse('2026-10-08T14:00:00Z'), [F.proj({ id: 'G2', start: S2, pred: '2026-10-08T10:00:00.000Z', p: 0.55, line: -1, total: 41 })]);
  chk('L the line arrives: a new grade revision, the earlier one kept', x.state.research_grades.length === 2 && PL.latest(x.state.research_grades).market.status === 'CAPTURED');
  /* a model-version change: a new family, its track record starts again */
  x = await run2(Date.parse('2026-10-08T15:00:00Z'), [F.proj({ id: 'G2', start: S2, pred: '2026-10-08T10:00:00.000Z', p: 0.55, line: -1, total: 41, model: 'edgedesk_football_v2.0.0' })]);
  const mv = PL.latest(x.state.research_grades);
  chk('L a model-version change is a new grade revision naming the new model', x.state.research_grades.length === 3 && mv.versions.model_id === 'edgedesk_football_v2.0.0' && mv.inputs.track.family === 'edgedesk_football_v2.0.0' && mv.inputs.track.n === 0);
  /* a grade-version change: a new revision; the old ones still reproduce under their own version */
  G.CONFIGS.rg_v1_test = JSON.parse(JSON.stringify(G.CONFIGS.rg_v1)); G.CONFIGS.rg_v1_test.grade_version = 'rg_v1_test'; G.CONFIGS.rg_v1_test.weights = { reliability: 20, completeness: 35, market: 20, clarity: 15, uncertainty: 10 };
  const realGrade = G.gradeProjection;
  G.gradeProjection = function (p, c) { return realGrade(p, c, G.CONFIGS.rg_v1_test); };
  x = await run2(Date.parse('2026-10-08T16:00:00Z'), [F.proj({ id: 'G2', start: S2, pred: '2026-10-08T10:00:00.000Z', p: 0.55, line: -1, total: 41, model: 'edgedesk_football_v2.0.0' })]);
  G.gradeProjection = realGrade;
  const gv = PL.latest(x.state.research_grades);
  chk('L a grade-version change is a new revision stamped with the new version', x.state.research_grades.length === 4 && gv.versions.grade === 'rg_v1_test');
  chk('L every earlier grade still reproduces under its own version', x.state.research_grades.every((s) => G.reproduce(s).ok));
  /* postponed, then void after 14 days: an ineligible outcome, never a loss */
  F.writeJson(r2, 'today/slate.json', F.slateFile([F.ev({ espn: 9002, start: S2, status: 'POSTPONED', at: '2026-10-08T20:00:00.000Z' })], {}, '2026-10-09T12:00:00.000Z'));
  x = await run2(Date.parse('2026-10-09T12:00:00Z'), []);
  chk('L a postponed game settles nothing while it waits', x.state.grade_outcomes.length === 0);
  x = await run2(Date.parse('2026-10-24T12:00:00Z'), []);
  const vo = PL.latest(x.state.grade_outcomes);
  chk('L postponed 14+ days: void, an ineligible outcome', vo && vo.eligible === false && vo.why === 'VOID_POSTPONED_UNRESOLVED' && vo.settlement.state === 'VOID');
  /* no backfill: a finished game the ledger never graded */
  const S3 = '2026-10-10T00:15:00.000Z';
  const L2 = require('./ledger.js');
  const fsnap = P.snapshotFromProjection(F.proj({ id: 'G3', start: S3, pred: '2026-10-09T10:00:00.000Z', p: 0.6, line: -3, total: 44 }), { captured_at: '2026-10-09T11:00:00.000Z', method: 'ledger_capture' });
  L2.appendMany(r2, 'forecasts', [fsnap]);
  F.writeJson(r2, 'record/football/nfl_2026.json', { games: { G3: { kickoff: S3, home: 'Green Bay Packers', away: 'Atlanta Falcons', final: { home_score: 30, away_score: 10, source: 'nflverse' } } } });
  F.writeJson(r2, 'today/slate.json', F.slateFile([F.ev({ espn: 9003, start: S3, status: 'FINAL', detail: 'Final', hs: 30, as: 10, at: '2026-10-10T04:00:00.000Z' })], {}, '2026-10-24T13:00:00.000Z'));
  x = await run2(Date.parse('2026-10-24T13:00:00Z'), []);
  chk('L a finished game with no pregame grade is never given one: counted and excluded', !x.state.research_grades.some((s) => s.event_key === 'NFL|G3') && !x.state.grade_outcomes.some((s) => s.event_key === 'NFL|G3')
    && x.report.steps.grade_outcomes.no_pregame_grade >= 1 && F.readJson(r2, 'performance/data/grades/summary.json').exclusions.no_pregame_grade >= 1);
  chk('L every chain in the second repository verifies, every grade reproduces', RUN.check(r2, null).ok);
  const kept = G.CONFIGS.rg_v1_test;
  delete G.CONFIGS.rg_v1_test;
  const gone = RUN.check(r2, null);
  chk('L a grade version is never deleted: without its config the check fails, naming the grade', !gone.ok && gone.reproduce.length === 1 && /unknown grade version rg_v1_test/.test(gone.reproduce[0].diffs[0]), gone.reproduce);
  void kept;
  fs.rmSync(r2, { recursive: true, force: true });

  /* the committed repository */
  const ROOT = F.ROOT;
  const chkRepo = RUN.check(ROOT, null);
  chk('L the committed ledger verifies and every committed research grade reproduces', chkRepo.ok, chkRepo.reproduce);
  const sumPath = path.join(ROOT, 'performance', 'data', 'grades', 'summary.json');
  if (fs.existsSync(sumPath)) {
    const cs = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
    const cRows = [].concat.apply([], (cs.games || []).map((gx) => JSON.parse(fs.readFileSync(path.join(ROOT, gx.path.slice(1)), 'utf8')).rows));
    chk('L the committed dashboard equals a recomputation from its committed rows', JSON.stringify(G.performance(cRows).totals) === JSON.stringify(cs.overall.totals));
    chk('L every committed dashboard row had started when it was built', (cs.games || []).every((gx) => { const f = JSON.parse(fs.readFileSync(path.join(ROOT, gx.path.slice(1)), 'utf8')); return f.rows.every((y) => Date.parse(y.start_utc) <= Date.parse(f.generated_at)); }));
    const lv = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance', 'data', 'grades', 'live.json'), 'utf8'));
    chk('L the committed live grades are upcoming games only, with no model number', Object.keys(lv.games).every((k) => Date.parse(lv.games[k].start_utc) > Date.parse(lv.generated_at)) && !/"p_home"|"fair_home_line"/.test(JSON.stringify(lv)));
  }
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'research grade — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | the lifecycle threw  ' + (e && e.stack || e)); process.exit(1); });
