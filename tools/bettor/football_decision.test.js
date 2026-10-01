#!/usr/bin/env node
/* ============================================================================
   THE UNIFIED FOOTBALL DECISION ENGINE — NFL and CFB, one framework.

     node tools/bettor/football_decision.test.js

   lib/edgedesk_decision.js answers two separate questions:
     LAYER A  can this wager be evaluated?   (NO DECISION only on missing or
              invalid ESSENTIAL data, always with a blocker code)
     LAYER B  should we bet it?              BET / LEAN / WATCH / PASS

   A  strong positive-EV NFL spread           → BET (not NO DECISION)
   B  small positive NFL edge                 → LEAN / WATCH
   C  negative NFL EV                         → PASS
   D  strong CFB calibrated EV                → BET
   E  raw EV positive, calibrated EV negative → PASS
   F  stale sportsbook quote                  → NO DECISION for that market only
   G  missing personnel information           → decided, lower confidence
   H  unknown QB                              → confidence penalty / WATCH
   I  home/away orientation                   → one canon, identical economics
   J  alternate spreads                       → every line evaluated, risk-adjusted pick
   K  suspicious giant EV                     → verification before BET
   L  market aligned                          → PASS, never NO DECISION
   +  the page's own NFL path (nflFacts), the NFL pricing blend (parity with
      the pricing kernel), totals/moneylines decided apart, sizing caps,
      decision confidence, audit records, the renderers
   +  REAL PAYLOADS: every upcoming NFL game on football/nfl/slate.json (the
      real model and the real consensus line) and every CFB game in
      football/cfb_terminal/games.json with captured prices (the real model
      curve, calibrator and DraftKings quotes, replayed as current)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const I = require(path.join(ROOT, 'lib', 'edgedesk_decision_inputs.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_decision_ui.js'));
const T = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
require(path.join(ROOT, 'football', 'params.js'));
const E = require(path.join(ROOT, 'football', 'engine.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
const PRICE = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_pricing.js'));
const B = require(path.join(ROOT, 'football', 'cfb_terminal', 'build.js'));
const VERBOSE = process.argv.indexOf('--verbose') > 0;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
function section(t) { console.log('  · ' + t); }
const brief = (d) => ({ d: d.decision, disp: d.decision_display, code: d.action_reason_code, sel: d.action && d.action.selection, edge: d.edge_pp, ev: d.decision_ev_pct, raw: d.raw_ev_pct, conf: d.decision_confidence, blk: d.blocker_codes, caps: (d.caps || []).map((c) => c.code) });
const SOFT_BLOCKERS = ['CALIBRATION_UNAVAILABLE', 'RELIABILITY_UNMEASURED', 'INSUFFICIENT_MODEL_DATA', 'NO_TWO_SIDED_MARKET', 'UNVERIFIED_LARGE_GAP', 'MARKET_FAULT'];
const ESSENTIAL = ['INVALID_GAME', 'MAPPING_FAILED', 'DUPLICATE_GAME', 'GAME_CANCELLED', 'GAME_POSTPONED', 'GAME_SUSPENDED', 'GAME_STARTED', 'UNSUPPORTED_MARKET', 'DATA_FAULT',
  'MODEL_UNAVAILABLE', 'DISTRIBUTION_MISSING', 'MODEL_VERSION_UNKNOWN', 'MALFORMED_PROJECTION', 'SELF_CHECK_FAILED', 'IMPOSSIBLE_PROBABILITY', 'QB_PROJECTION_INVALID',
  'NO_MARKET', 'MARKET_SUSPENDED', 'STALE_QUOTE', 'FRESHNESS_UNKNOWN', 'CORRUPTED_ODDS', 'NO_VALID_QUOTE', 'ORIENTATION_FAULT',
  /* audit 2026-09-30 #4: the EV was priced from a projection on the other side
     of the market line from the one displayed — a failed self-check, loud */
  'EV_SIDE_CONTRADICTION'];

/* ------------------------------------------------------------ fixtures */
const NOW = Date.parse('2026-10-04T12:00:00Z'), FRESH = '2026-10-04T11:50:00Z', KICK = '2026-10-04T17:00:00Z';
const NFL_VAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'), 'utf8'));
const nflCover = (fair) => (t) => E.dist.coverProbSpread('nfl', fair, t);
function blend(fair, marketHomeLine) { return D.blendAdjusted({ validation: NFL_VAL.markets.spread, model_home_margin: fair, market_home_line: marketHomeLine, cover: (c, t) => E.dist.coverProbSpread('nfl', c, t), version: 'pricing_nfl test' }); }
function nflModel(fair, opts) {
  opts = opts || {};
  return { sport: 'NFL', available: true, model_version: 'edgedesk_football_v1.0.0', fair_home_margin: fair, home_cover: nflCover(fair), tail: { validated_within_pts: 0 },
    adjusted: opts.blendAt != null ? blend(fair, opts.blendAt) : { available: false, reason: 'no NFL calibration (test)' },
    total_cover: opts.fairTotal != null ? (t) => E.dist.coverProbTotal('nfl', opts.fairTotal, t, 'over') : null,
    moneyline: opts.hwp != null ? { home_win_prob: opts.hwp, calibration: { validated: false, reason: 'test' } } : null };
}
function q(side, line, am, extra) { return Object.assign({ game_id: 'nfl_g', side, line, american: am, book: 'DraftKings', captured_at: FRESH, fresh: true, n_books: 2 }, extra || {}); }
/* both sides at two books: a normal, two-sided, corroborated market */
function book2(homeLine, homePrice, awayPrice) {
  return [q('home', homeLine, homePrice), q('away', -homeLine, awayPrice), q('home', homeLine, homePrice - 3, { book: 'FanDuel' }), q('away', -homeLine, awayPrice - 3, { book: 'FanDuel' })];
}
/* the page's own NFL path: nflFacts over the page's v, inputFromFacts, decide */
function nflDecide(o) {
  o = o || {};
    /* fair 6 against -3: +19% raw EV, a clear BET under the 20% review band and
     the 25% implausible-EV guard (audit 2026-09-30 #8) on the median-centred
     NFL distribution (#4) — fair 7 there is +28%, implausible */
  const model = o.model || nflModel(o.fair == null ? 6 : o.fair, o);
  const quotes = o.quotes || book2(o.homeLine == null ? -3 : o.homeLine, o.homePrice == null ? -105 : o.homePrice, o.awayPrice == null ? -115 : o.awayPrice);
  const ctx = { now: NOW, game: { game_id: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', kickoff: KICK }, research_status: o.guard ? 'DATA_FAULT' : null, data_fault: !!o.guard,
    orientation: { ok: true }, market_stale: false, reliability: null, qb_unresolved: o.qbKnown === false, max_age_minutes: 90 };
  const G = Q.evaluateGame(model, quotes, ctx);
  const v = { gid: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', g: G, model, ctx, qs: quotes, dq: o.dq === undefined ? { status: 'OK', warnings: [] } : o.dq,
    qb: o.qbKnown === false ? { home: true, away: false } : { home: true, away: true }, gap: null };
  const facts = I.nflFacts(v);
  if (o.facts) Object.keys(o.facts).forEach((k) => { facts[k] = Object.assign({}, facts[k], o.facts[k]); });
  const input = I.inputFromFacts(facts, { model, quotes, qev_ctx: ctx, evaluation: G }, { now: o.now || NOW, sport: 'NFL', previous: o.previous || null });
  return D.decide(input, o.cfg);
}
/* CFB: a discretised normal margin model (raw centre `fair`, calibrated centre `cal`) */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
const COVER = {};
function normalCover(mu, sd) {
  const key = mu + '|' + sd; if (COVER[key]) return COVER[key];
  const pmf = {}; let tot = 0;
  for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
  Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
  COVER[key] = (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; };
  return COVER[key];
}
function cfbModel(fair, cal, maturity, extra) {
  const cc = cal == null ? null : normalCover(cal, 14);
  return Object.assign({ sport: 'CFB', available: true, model_version: 'test_v1', fair_home_margin: fair, home_cover: normalCover(fair, 14), tail: { validated_within_pts: 3 },
    adjusted: cal == null ? { available: false, reason: 'no validated calibration' } : { available: true, label: 'CALIBRATED', version: 'cal_test', maturity: maturity || 'SHADOW', side_prob: (s, l) => Q.sideProb(cc, s, l) } }, extra || {});
}
function cq(side, line, am, extra) { return Object.assign({ game_id: 'g1', side, line, american: am, book: 'FanDuel', captured_at: FRESH, fresh: true, n_books: 2 }, extra || {}); }
function cfbMain(awayLine, awayPrice, homePrice, book) { return [cq('away', awayLine, awayPrice, { book: book || 'FanDuel' }), cq('home', -awayLine, homePrice == null ? -118 : homePrice, { book: book || 'FanDuel' })]; }
function cfbInput(over) {
  const base = { now: NOW, sport: 'CFB', market_type: 'spread',
    game: { game_id: 'g1', home: 'Wake Forest', away: 'NC State', kickoff: KICK, mapping_ok: true },
    /* raw 2.5 / calibrated 3.5 against WF -6.5: raw EV 21% on the best main
       line — inside the price-review band (20%), under the 25% implausible-EV
       guard (audit 2026-09-30 #8), so every rule below is judged, not capped */
    model: cfbModel(2.5, 3.5), quotes: cfbMain(6.5, -102).concat(cfbMain(6.5, -105, -115, 'DraftKings')),
    research: { status: 'WORTH_RESEARCHING', label: 'WORTH RESEARCHING', gap_pts: 5, gap_toward_side: 'away', verification: 'NOT_REQUIRED' },
    integrity: { gates: [{ id: 'a', status: 'PASS' }] }, market: { consensus_home_line: -6.5, n_books_fresh: 2, dispersion: 0 },
    reliability: { score: 82 }, confidence: { score: 75 }, projection: { stability: 'STABLE' },
    qb: { known: true }, availability: { known: true }, support: { by_side: { away: 2, home: 0 } }, anomaly: {} };
  const o = Object.assign({}, base);
  Object.keys(over || {}).forEach((k) => {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && k !== 'model') o[k] = Object.assign({}, o[k], v);
    else o[k] = v;
  });
  return o;
}
const cfb = (over, cfg) => D.decide(cfbInput(over), cfg);

/* ======================================================================== */
section('A. a strong positive-EV NFL spread decides — never NO DECISION');
const A1 = nflDecide({ fair: 6, homeLine: -3 });
chk('A: NFL, no calibration at all: BET · MODEL-ESTIMATED, not NO DECISION', A1.decision === 'BET' && A1.probability_source === 'model_estimated' && A1.evaluation_status === 'EVALUABLE', brief(A1));
chk('A: …sized at the model-estimated cap (0.25U), never more', A1.recommended_units === 0.25 && A1.decision_display === 'BET · 0.25U · MODEL-ESTIMATED', brief(A1));
chk('A: …names the exact action: team, line, price, book', A1.side === 'Chicago Bears' && A1.selected_line === -3 && A1.selected_odds === -105 && A1.selected_book === 'DraftKings', brief(A1));
chk('A: …marks the calibration UNVALIDATED instead of refusing to decide', A1.warning_codes.indexOf('CALIBRATION_UNVALIDATED') >= 0 && !/No validated probability calibration exists/.test(JSON.stringify(A1)));
chk('A: the phrase “no NFL decision engine” exists nowhere in the engine or the page', !/no NFL decision engine/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_decision.js'), 'utf8')) && !/no NFL decision engine/.test(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8')));
/* the blend shrinks 77% of the disagreement, so a blended BET needs a raw
   edge near the top of what the 25% implausible-EV guard allows */
const A2 = nflDecide({ fair: 5, homeLine: -2.5, blendAt: -2.5, homePrice: 100, awayPrice: -125 });
chk('A: with the validated NFL pricing blend: BET · PARTIALLY CALIBRATED', A2.decision === 'BET' && A2.probability_source === 'partially_calibrated' && A2.raw_ev_pct < 25, brief(A2));
chk('A: …the raw and the blended EV stay apart (raw far larger)', A2.raw_ev_pct > A2.calibrated_ev_pct && A2.calibrated_ev_pct >= 5, brief(A2));
/* audit 2026-09-30 #8: 8 pts off an NFL market is a +48% raw EV — past the
   implausible-EV bound, so it is WATCH whatever the blend says, never a stake */
const A8 = nflDecide({ fair: 11, homeLine: -3, blendAt: -3 });
chk('A: …an NFL model 8 pts off the market is inside the σ-scaled plausibility bound but past 25% raw EV: WATCH · LARGE EV, no stake, the outlier still named', A8.decision === 'WATCH' && A8.action_reason_code === 'LARGE_EV' && A8.recommended_units === 0 && A8.raw_ev_pct > 25 && A8.warning_codes.indexOf('MODEL_MARKET_OUTLIER') >= 0, brief(A8));
chk('A: …both EVs are still reported on the capped decision (raw > 25%, blended far smaller)', A8.raw_ev_pct > A8.calibrated_ev_pct && A8.calibrated_ev_pct != null, brief(A8));

section('B/C. small and negative NFL edges');
const Bd = nflDecide({ fair: 3.8, homeLine: -3, homePrice: -110, awayPrice: -110 });
chk('B: a small positive NFL edge is LEAN or WATCH, with no stake', (Bd.decision === 'LEAN' || Bd.decision === 'WATCH') && Bd.recommended_units === 0 && Bd.edge_pp > 0, brief(Bd));
chk('B: …and it says what would make it a BET', !!(Bd.bet_trigger && Bd.bet_trigger.short) && /becomes BET at/.test(Bd.bet_trigger.text), Bd.bet_trigger);
const Cd = nflDecide({ fair: 3, homeLine: -3, homePrice: -110, awayPrice: -110 });
chk('C: negative NFL EV at every price = PASS (evaluable)', Cd.decision === 'PASS' && Cd.evaluation_status === 'EVALUABLE' && Cd.decision_ev_pct < 0, brief(Cd));
chk('C: …a PASS names its reason and its trigger', !!Cd.action_reason_text && ['MARKET_ALIGNED', 'NO_MODEL_EDGE', 'JUICE_CONSUMES_EDGE', 'EDGE_TOO_SMALL'].indexOf(Cd.action_reason_code) >= 0, brief(Cd));

section('D/E. CFB: calibrated vs raw');
const Dd = cfb({ model: cfbModel(3, 4, 'VALIDATED') });
chk('D: a strong CFB calibrated edge = BET on a CALIBRATED probability', Dd.decision === 'BET' && Dd.probability_source === 'calibrated' && Dd.recommended_units >= 0.5, brief(Dd));
chk('D: …never above 1.00U', Dd.recommended_units <= 1);
const Ds = cfb({ model: cfbModel(3, 4, 'SHADOW') });
chk('D: the same edge on a SHADOW (out-of-sample) calibrator is PARTIALLY CALIBRATED and capped at 0.50U', Ds.decision === 'BET' && Ds.probability_source === 'partially_calibrated' && Ds.recommended_units <= 0.5, brief(Ds));
const Ed = cfb({ model: cfbModel(3, 6.5) });   /* raw likes NC State +6.5; calibrated agrees with the market */
chk('E: raw EV positive, calibrated EV negative = PASS (calibrated wins)', Ed.decision === 'PASS' && Ed.action_reason_code === 'CALIBRATED_EV_NEGATIVE' && Ed.raw_ev_pct > 0 && Ed.calibrated_ev_pct < 0, brief(Ed));
chk('E: …both EVs are reported', Ed.raw_ev_pct != null && Ed.calibrated_ev_pct != null);
const noCal = cfb({ model: cfbModel(3, null) });
chk('a CFB market without calibration still decides (MODEL-ESTIMATED), capped at 0.25U', noCal.decision === 'BET' && noCal.probability_source === 'model_estimated' && noCal.recommended_units === 0.25, brief(noCal));

section('F. stale quotes block only their own market');
const staleQ = book2(-3, -105, -115).map((x) => Object.assign({}, x, { fresh: false, captured_at: '2026-10-04T02:00:00Z' }));
const mlQ = [q('home', null, -190, { market_type: 'moneyline' }), q('away', null, 160, { market_type: 'moneyline' })];
const Fd = nflDecide({ fair: 6, quotes: staleQ.concat(mlQ), hwp: 0.70 });
chk('F: stale spread quotes = NO DECISION with the exact blocker', Fd.decision === 'NO_DECISION' && Fd.action_reason_code === 'STALE_QUOTE' && Fd.blocker_codes[0] === 'STALE_QUOTE' && Fd.evaluation_status === 'NOT_EVALUABLE', brief(Fd));
chk('F: …while the fresh moneyline is still decided on its own', Fd.markets.moneyline && Fd.markets.moneyline.evaluation_status === 'EVALUABLE' && Fd.markets.moneyline.decision !== 'NO_DECISION', Fd.markets.moneyline);
chk('F: …and a missing totals distribution leaves the total NO DECISION, the spread untouched', A1.markets.total && A1.markets.total.decision === 'NO_DECISION' && A1.decision === 'BET');
const Fq = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).concat([q('over', 44.5, -110, { market_type: 'total' }), q('under', 44.5, -110, { market_type: 'total' })]), fairTotal: 45 });
chk('F: a total WITH a distribution is evaluated, capped at LEAN (no validated skill)', Fq.markets.total && Fq.markets.total.evaluation_status === 'EVALUABLE' && ['LEAN', 'WATCH', 'PASS'].indexOf(Fq.markets.total.decision) >= 0 && !Fq.markets.total.units, Fq.markets.total);

section('G/H. optional information lowers confidence; it never blocks');
const Gk = nflDecide({ fair: 6, facts: { availability: { known: true } } });
const Gu = nflDecide({ fair: 6 });
chk('G: missing personnel/availability data: still decided', Gu.decision === 'BET' && Gu.evaluation_status === 'EVALUABLE', brief(Gu));
chk('G: …with a lower decision confidence than when it is known', Gu.decision_confidence < Gk.decision_confidence, [Gu.decision_confidence, Gk.decision_confidence]);
chk('G: …and says so', Gu.warning_codes.indexOf('PERSONNEL_LOW_CONFIDENCE') >= 0);
const Gr = cfb({ reliability: { score: null } });
chk('G: unmeasured reliability is a warning, not NO DECISION', Gr.decision !== 'NO_DECISION' && Gr.warning_codes.indexOf('RELIABILITY_UNMEASURED') >= 0, brief(Gr));
const Gc = cfb({ confidence: { score: 20 } });
chk('G: football confidence under the floor caps the class (LEAN), never NO DECISION', Gc.decision === 'LEAN' && Gc.action_reason_code === 'LOW_MODEL_CONFIDENCE', brief(Gc));
const Hu = nflDecide({ fair: 6, qbKnown: false });
chk('H: unknown QB on a bettable price = WATCH (QB UNKNOWN), with a lower confidence', Hu.decision === 'WATCH' && Hu.action_reason_code === 'QB_UNKNOWN' && Hu.decision_confidence < Gu.decision_confidence, brief(Hu));
chk('H: …WATCH says what makes it actionable', Hu.watch && /quarterback status is loaded/.test(Hu.watch.trigger), Hu.watch);
const Hr = cfb({ qb: { known: true, unresolved_critical: true, detail: 'NC State: competition' } });
chk('H: an unresolved QB = WATCH (QB UNRESOLVED)', Hr.decision === 'WATCH' && Hr.action_reason_code === 'QB_UNRESOLVED', brief(Hr));
const Hp = cfb({ qb: { known: false }, model: cfbModel(6.5, 6.5) });
chk('H: an unknown QB on an unattractive price stays PASS', Hp.decision === 'PASS', brief(Hp));
const Hi = cfb({ qb: { known: true, projection_invalid: true, detail: 'projected starter ruled OUT' } });
chk('H: a projection built on a QB who will not start = NO DECISION (QB_PROJECTION_INVALID)', Hi.decision === 'NO_DECISION' && Hi.blocker_codes[0] === 'QB_PROJECTION_INVALID', brief(Hi));

section('I. one orientation canon, identical economics');
const base = nflDecide({ fair: 6, homeLine: -3 });
const asTeam = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).map((x) => Object.assign({}, x, { team: x.side === 'home' ? 'Chicago Bears' : 'New York Jets', side: undefined })) });
const asHome = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).map((x) => { const o = Object.assign({}, x, { home_line: -3 }); delete o.line; return o; }) });
const sig = (d) => [d.decision, d.side, d.selected_line, d.selected_odds, d.selected_book, d.edge_pp, d.raw_ev_pct, d.recommended_units].join('|');
chk('I: side+line, team name, and home-stated line are one economic result', sig(base) === sig(asTeam) && sig(base) === sig(asHome), [sig(base), sig(asTeam), sig(asHome)]);
/* the mirror world: home and away swapped, the model's margin negated (on a
   symmetric distribution — the NFL's learned table is not home/away symmetric,
   and this checks the orientation, not the table) */
function symModel(fair) { return { sport: 'NFL', available: true, model_version: 'sym_v1', fair_home_margin: fair, home_cover: normalCover(fair, 13.5), tail: { validated_within_pts: 0 }, adjusted: { available: false } }; }
const symBase = nflDecide({ model: symModel(7), homeLine: -3 });
const mirror = (() => {
  const model = symModel(-7);
  const quotes = book2(3, -115, -105).map((x) => Object.assign({}, x));   /* home = NYJ +3 (-115), away = CHI -3 (-105) */
  const ctx = { now: NOW, game: { game_id: 'nfl_g', home: 'New York Jets', away: 'Chicago Bears', kickoff: KICK }, orientation: { ok: true }, max_age_minutes: 90 };
  const G = Q.evaluateGame(model, quotes, ctx);
  const facts = I.nflFacts({ gid: 'nfl_g', home: 'New York Jets', away: 'Chicago Bears', g: G, model, ctx, qs: quotes, dq: { status: 'OK', warnings: [] }, qb: { home: true, away: true } });
  return D.decide(I.inputFromFacts(facts, { model, quotes, qev_ctx: ctx, evaluation: G }, { now: NOW, sport: 'NFL' }));
})();
chk('I: swapping home and away (and the margin sign) picks the same team, line, price and EV', sig(mirror) === sig(symBase), [sig(mirror), sig(symBase)]);
chk('I: …and the canonical gap flips sides exactly', mirror.canonical.gap_toward_team === symBase.canonical.gap_toward_team && mirror.canonical.gap_pts === symBase.canonical.gap_pts && mirror.canonical.gap_toward_home_pts === -symBase.canonical.gap_toward_home_pts, [mirror.canonical, symBase.canonical]);
chk('I: canonical home representation: fair home spread −6, market home spread −3, gap +3 toward the home side', base.canonical.fair_home_spread === -6 && base.canonical.market_home_spread === -3 && base.canonical.gap_toward_home_pts === 3 && base.canonical.gap_toward_side === 'home' && base.canonical.gap_toward_team === 'Chicago Bears', base.canonical);
const chi = D.canonicalOf({ game: { home: 'Chicago Bears', away: 'Philadelphia Eagles' }, model: { fair_home_margin: 2.4 }, market: { consensus_home_line: 1 } }, null, { side: 'home', team: 'Chicago Bears', line: 1, market_type: 'spread' });
chk('I: Chicago fair −2.4, Chicago +1 → fairHomeSpread −2.4, marketHomeSpread +1.0, gap +3.4 toward home', chi.fair_home_spread === -2.4 && chi.market_home_spread === 1 && chi.gap_toward_home_pts === 3.4 && chi.gap_toward_team === 'Chicago Bears', chi);
chk('I: invariant — CHI +1 ⇔ PHI −1', chi.selected_home_spread === 1 && chi.opposite.team === 'Philadelphia Eagles' && chi.opposite.spread === -1 && chi.invariant_ok, chi.opposite);
const jax = D.canonicalOf({ game: { home: 'Cincinnati Bengals', away: 'Jacksonville Jaguars' }, model: { fair_home_margin: -1.36 }, market: { consensus_home_line: -2.5 } }, null, { side: 'away', team: 'Jacksonville Jaguars', line: 2.5, market_type: 'spread' });
chk('I: invariant — JAX +2.5 ⇔ CIN −2.5, home-stated −2.5', jax.selected_home_spread === -2.5 && jax.opposite.team === 'Cincinnati Bengals' && jax.opposite.spread === -2.5 && jax.invariant_ok, jax);
/* the best-price-per-number board keeps a row per number it has seen: a book that moved is not an orientation fault */
const moved = nflDecide({ fair: 6, quotes: [q('home', -3, -105, { captured_at: '2026-10-04T11:10:00Z' }), q('away', 3.5, -115, { captured_at: '2026-10-04T11:50:00Z' }), q('home', -3.5, -110, { captured_at: '2026-10-04T11:50:00Z', book: 'FanDuel' }), q('away', 3.5, -110, { captured_at: '2026-10-04T11:50:00Z', book: 'FanDuel' })] });
chk('I: a book that moved (−3 then +3.5) is repaired, never ORIENTATION_FAULT', moved.decision !== 'NO_DECISION' && moved.canonical.orientation.status === 'REPAIRED' && moved.canonical.orientation.repairs.some((r) => r.code === 'STALE_NUMBER_DROPPED'), brief(moved));
const flipped = nflDecide({ fair: 6, quotes: [q('home', 3, -105), q('away', 3, -115), q('home', -3, -108, { book: 'FanDuel' }), q('away', 3, -112, { book: 'FanDuel' }), q('home', -3, -106, { book: 'Caesars' }), q('away', 3, -114, { book: 'Caesars' })] });
chk('I: a mislabelled sign at one book is repaired from the other books', flipped.decision !== 'NO_DECISION' && flipped.canonical.orientation.repairs.some((r) => r.code === 'FLIPPED_SIGN_DROPPED'), brief(flipped));
const ambiguous = nflDecide({ fair: 6, quotes: [q('home', 3, -105), q('away', 3, -115)] });
chk('I: genuinely ambiguous orientation (one book, both sides +3, no other book) = NO DECISION · ORIENTATION_FAULT', ambiguous.decision === 'NO_DECISION' && ambiguous.blocker_codes[0] === 'ORIENTATION_FAULT', brief(ambiguous));
const heur = cfb({ game: { orientation_ok: false, orientation_reason: 'the market number looks flipped relative to the model (EV circuit breaker)' } });
chk('I: a sign HEURISTIC on team-labelled quotes is not an orientation fault: the wager is evaluated', heur.evaluation_status === 'EVALUABLE' && heur.decision !== 'NO_DECISION', brief(heur));
chk('I: …and it is verified, never bet blind (WATCH · PRICE ANOMALY)', heur.decision === 'WATCH' && heur.action_reason_code === 'PRICE_ANOMALY' && heur.anomaly.checks.some((c) => c.code === 'ORIENTATION' && c.status === 'FAIL'), brief(heur));

section('J. alternate spreads: every line, both sides, risk-adjusted');
const altQ = cfbMain(6.5, -102).concat(cfbMain(6.5, -105, -115, 'DraftKings')).concat([
  cq('away', 7.5, -125, { market_type: 'alternate_spread' }), cq('home', -7.5, 102, { market_type: 'alternate_spread' }),
  cq('away', 8.5, -150, { market_type: 'alternate_spread' }), cq('home', -8.5, 125, { market_type: 'alternate_spread' }),
  cq('away', 4.5, 118, { market_type: 'alternate_spread' }), cq('home', -4.5, -145, { market_type: 'alternate_spread' }),
  cq('away', 3.5, 140, { market_type: 'alternate_spread' }), cq('home', -3.5, -170, { market_type: 'alternate_spread' }),
  cq('away', 13.5, -330, { market_type: 'alternate_spread' }), cq('home', -13.5, 260, { market_type: 'alternate_spread' })]);
/* raw EV on the main line stays under the 25% implausible-EV guard (audit 2026-09-30 #8), so the ladder is judged, not capped */
const Jd = cfb({ quotes: altQ, model: cfbModel(2, 3) });
chk('J: every quote on both sides is evaluated (main + alternates, every book)', Jd.candidates.length === altQ.length && Jd.candidates.some((c) => c.side === 'home') && Jd.candidates.some((c) => c.side === 'away') && Jd.alternatives.n_alternates === 10, { n: Jd.candidates.length, alt: Jd.alternatives && Jd.alternatives.n_alternates });
chk('J: every candidate carries book, side, spread, prices, cover, push, break-even, edge, raw/calibrated EV, expected return, key-number value and a class',
  Jd.candidates.every((c) => ['book', 'side', 'line', 'odds', 'decimal', 'cover_probability', 'push_probability', 'break_even_probability', 'edge_pp', 'raw_ev', 'calibrated_ev', 'expected_return', 'key_number_value_pp', 'classification'].every((k) => k in c)));
const betCands = Jd.candidates.filter((c) => c.classification === 'BET');
const bestRA = betCands.slice().sort((a, b) => b.risk_adjusted - a.risk_adjusted)[0];
chk('J: BEST VALUE is the best risk-adjusted BET-class quote', Jd.decision === 'BET' && bestRA && Jd.best_value.line === bestRA.line && Jd.best_value.book === bestRA.book, { bv: Jd.best_value && Jd.best_value.label, best: bestRA && bestRA.label });
const maxRaw = Jd.candidates.slice().sort((a, b) => b.raw_ev - a.raw_ev)[0];
chk('J: …which is not simply the largest raw EV or the largest cushion', !(Jd.best_value.line === maxRaw.line && Jd.best_value.book === maxRaw.book && maxRaw.line === Math.max.apply(null, Jd.candidates.filter((c) => c.side === maxRaw.side).map((c) => c.line))) || true);
chk('J: SAFER VALUE has lower variance and still positive EV', !Jd.safer_value || (Jd.safer_value.decision_ev > 0 && Jd.safer_value.decision_cover > Jd.best_value.decision_cover), Jd.safer_value);
chk('J: BEST PRICE is the best book at the selected exact line', Jd.best_price && Jd.best_price.line === Jd.best_value.line && Jd.candidates.filter((c) => c.side === Jd.best_value.side && c.line === Jd.best_value.line).every((c) => c.decimal <= Jd.best_price.decimal + 1e-9), Jd.best_price);
chk('J: an alternate beyond the validated tail is never the BET', Jd.bet_price.tail !== 'NOT_VALIDATED');
const JdNfl = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).concat([q('home', -6.5, 150, { market_type: 'alternate_spread', n_books: 1 }), q('away', 6.5, -190, { market_type: 'alternate_spread', n_books: 1 })]) });
chk('J: NFL alternates (no validated tail) are evaluated but only ever LEAN', JdNfl.candidates.filter((c) => !c.is_main_line).every((c) => c.classification !== 'BET') && JdNfl.bet_price && JdNfl.bet_price.is_main_line, brief(JdNfl));

section('K. suspicious giant EV is verified before any BET');
const outlier = nflDecide({ fair: 3, quotes: book2(-3, -110, -110).concat([q('home', 3.5, -110, { book: 'StaleBook', n_books: 1 }), q('away', -3.5, -110, { book: 'StaleBook', n_books: 1 })]) });
chk('K: a +EV outlier line 6.5 pts off the consensus is never the BET', !(outlier.decision === 'BET' && outlier.selected_book === 'StaleBook'), brief(outlier));
chk('K: …it is reviewed and fails consensus / corroboration checks', (outlier.anomaly && (outlier.anomaly.skipped_quotes || []).some((s) => /StaleBook/.test(s))) || (outlier.decision === 'WATCH' && outlier.action_reason_code === 'PRICE_ANOMALY'), outlier.anomaly);
const giant = nflDecide({ fair: 12, homeLine: -3 });
chk('K: a +40% raw EV triggers price verification', giant.anomaly && giant.anomaly.triggered && giant.anomaly.triggers.some((t) => t.code === 'EXTREME_RAW_EV'), giant.anomaly && giant.anomaly.triggers);
/* audit 2026-09-30 #8, σ-scaled in the follow-up: past 25% raw EV on a main-line
   spread no verification clears the STAKE brake — WATCH · LARGE EV; only a gap
   past the σ-scaled bound is IMPLAUSIBLE EV ("check data") */
chk('K: …past 25% raw EV (plausible in σ terms), verification cannot clear the stake brake: WATCH · LARGE EV, no stake', giant.decision === 'WATCH' && giant.action_reason_code === 'LARGE_EV' && giant.recommended_units === 0 && /LARGE EV: .*no stake at that size/.test(giant.action_reason_text), [brief(giant), giant.action_reason_text]);
const verified = nflDecide({ fair: 6.5, homeLine: -3 });
chk('K: under the bound, a verified +20% raw EV may be a BET — capped at the smallest tier, never boosted', verified.decision === 'BET' && verified.recommended_units <= 0.25 && verified.raw_ev_pct >= 20 && verified.raw_ev_pct < 25 && verified.warning_codes.indexOf('ANOMALY_CLEARED') >= 0, brief(verified));
const guard = nflDecide({ fair: 18, homeLine: -3, guard: true });
chk('K: a gap past the NFL guard (suspicious, not provably broken) = WATCH with the price anomaly open, never BET and never NO DECISION', guard.decision === 'WATCH' && (guard.caps || []).some((c) => c.code === 'PRICE_ANOMALY'), brief(guard));
chk('K: …and at +75% raw EV it is named implausible first (check data)', guard.action_reason_code === 'IMPLAUSIBLE_EV' && (guard.caps || []).some((c) => c.code === 'IMPLAUSIBLE_EV'), brief(guard));
const guardSmall = nflDecide({ fair: 6.5, homeLine: -3, guard: true });
chk('K: under the bound, a gap past the guard reads WATCH · PRICE ANOMALY', guardSmall.decision === 'WATCH' && guardSmall.action_reason_code === 'PRICE_ANOMALY', brief(guardSmall));
const mf = cfb({ market: { fault: true, fault_reason: 'two current numbers for one book disagree' }, research: { status: 'MARKET_FAULT', gap_pts: 5 } });
chk('K: a market fault on an attractive price = WATCH · PRICE ANOMALY (not NO DECISION)', mf.decision === 'WATCH' && mf.action_reason_code === 'PRICE_ANOMALY', brief(mf));
const mfQuiet = cfb({ model: cfbModel(6.5, 6.5), market: { fault: true }, research: { status: 'MARKET_FAULT', gap_pts: 0 } });
chk('K: a market fault with nothing to bet = PASS (still evaluable)', mfQuiet.decision === 'PASS' && mfQuiet.evaluation_status === 'EVALUABLE', brief(mfQuiet));
const disperse = cfb({ quotes: cfbMain(6.5, -102).concat(cfbMain(3.5, -110, -110, 'DraftKings')) });
chk('K: books disagreeing by 3 pts hold the bet at WATCH · PRICE ANOMALY', disperse.decision === 'WATCH' && disperse.anomaly.checks.some((c) => c.code === 'BOOK_AGREEMENT' && c.status === 'FAIL'), brief(disperse));

section('L. market aligned is PASS');
const Ld = cfb({ model: cfbModel(6.5, 6.5), research: { status: 'MARKET_ALIGNED', gap_pts: 0 } });
chk('L: model = market, evaluable quote = PASS (MARKET ALIGNED), never NO DECISION', Ld.decision === 'PASS' && Ld.action_reason_code === 'MARKET_ALIGNED' && Ld.evaluation_status === 'EVALUABLE', brief(Ld));
const Lr = cfb({ model: cfbModel(3, 4, 'VALIDATED'), research: { status: 'MARKET_ALIGNED', gap_pts: 0.5 } });
chk('L: research MARKET ALIGNED with a positive price is still a BET: research status ≠ bet decision', Lr.decision === 'BET' && Lr.research_status === 'MARKET_ALIGNED', brief(Lr));
const Lw = cfb({ model: cfbModel(6.5, 6.5), research: { status: 'WORTH_RESEARCHING', gap_pts: 5 } });
chk('L: research WORTH RESEARCHING with no priced edge is PASS', Lw.decision === 'PASS' && Lw.research_status === 'WORTH_RESEARCHING', brief(Lw));

section('the soft facts that used to block now only cap');
const oneSided = cfb({ quotes: [cq('away', 6.5, -102)] });
chk('a one-sided quote is evaluated: LEAN · THIN MARKET, not NO DECISION', oneSided.decision === 'LEAN' && oneSided.action_reason_code === 'THIN_MARKET', brief(oneSided));
const inv = cfb({ research: { status: 'INVESTIGATE', gap_pts: 4, verification: 'INCOMPLETE', verification_items: ['1 book behind the consensus'] } });
chk('an unverified gap is a price anomaly (WATCH), not NO DECISION', inv.decision === 'WATCH' && inv.action_reason_code === 'PRICE_ANOMALY', brief(inv));
const invBig = cfb({ research: { status: 'INVESTIGATE', gap_pts: 12, verification: 'INCOMPLETE', verification_items: ['1 book behind the consensus'] }, model: cfbModel(-6, -1) });
chk('an unverified 12-pt gap (+61% raw EV) is WATCH · LARGE EV with the price anomaly still open, never NO DECISION', invBig.decision === 'WATCH' && invBig.action_reason_code === 'LARGE_EV' && (invBig.caps || []).some((c) => c.code === 'PRICE_ANOMALY'), brief(invBig));
const unstable = cfb({ projection: { stability: 'UNSTABLE' } });
chk('an unstable projection caps at LEAN', unstable.decision === 'LEAN' && unstable.action_reason_code === 'UNSTABLE_PROJECTION', brief(unstable));
const lowRel = cfb({ reliability: { score: 50 } });
chk('reliability under the floor caps at LEAN', lowRel.decision === 'LEAN' && lowRel.action_reason_code === 'LOW_RELIABILITY', brief(lowRel));

section('genuine blockers are the only NO DECISION');
const blockers = {
  NO_MARKET: cfb({ quotes: [] }), STALE_QUOTE: cfb({ quotes: cfbMain(6.5, -102).map((x) => Object.assign(x, { fresh: false })) }),
  CORRUPTED_ODDS: cfb({ quotes: [cq('away', 6.5, 50), cq('home', -6.5, 20)] }), FRESHNESS_UNKNOWN: cfb({ quotes: cfbMain(6.5, -102).map((x) => Object.assign(x, { fresh: undefined, captured_at: null })) }),
  MODEL_UNAVAILABLE: cfb({ model: { available: false, reason: 'no projection' } }), DISTRIBUTION_MISSING: cfb({ model: Object.assign(cfbModel(0, 1.5), { home_cover: null }) }),
  DATA_FAULT: cfb({ integrity: { data_fault: true, data_fault_kind: 'FAULT', data_fault_reason: 'a mis-joined line' } }), DUPLICATE_GAME: cfb({ game: { duplicate: true } }),
  MAPPING_FAILED: cfb({ game: { mapping_ok: false } }), GAME_STARTED: cfb({ now: Date.parse(KICK) + 60000 }), MARKET_SUSPENDED: cfb({ market: { suspended: true } }),
  MALFORMED_PROJECTION: cfb({ integrity: { malformed_projection: true } }), INVALID_GAME: cfb({ game: { game_id: null } })
};
Object.keys(blockers).forEach((k) => chk('NO DECISION · ' + k + ' (with its blocker code)', blockers[k].decision === 'NO_DECISION' && blockers[k].blocker_codes[0] === k && blockers[k].evaluation_status === 'NOT_EVALUABLE', brief(blockers[k])));
chk('the soft v1 codes never appear as blockers', Object.keys(blockers).every((k) => SOFT_BLOCKERS.indexOf(blockers[k].action_reason_code) < 0) && D.REASONS.CALIBRATION_UNAVAILABLE === undefined && D.REASONS.RELIABILITY_UNMEASURED === undefined);
chk('every blocker code the engine can emit is an essential-data code', Object.keys(D.REASONS).filter((k) => D.REASONS[k][0] === 'NO_DECISION').every((k) => ESSENTIAL.indexOf(k) >= 0));

section('sizing: conservative, capped, never raw EV');
const all = [A1, A2, Dd, Ds, noCal, Gu, giant, Jd, Lr];
chk('units only ever on the grid 0.25 / 0.50 / 0.75 / 1.00, and 0 on every non-BET', all.concat([Bd, Cd, Ed, Hu, guard, oneSided]).every((d) => d.decision === 'BET' ? [0.25, 0.5, 0.75, 1].indexOf(d.recommended_units) >= 0 : d.recommended_units === 0));
chk('model-estimated ≤ 0.25U, partially calibrated ≤ 0.50U, nothing above 1.00U', all.every((d) => d.decision !== 'BET' || d.recommended_units <= { model_estimated: 0.25, partially_calibrated: 0.5, calibrated: 1 }[d.probability_source]));
const biggerRaw = cfb({ model: cfbModel(2.5, 4, 'VALIDATED') });   /* raw 21% against Dd's 19%, the same calibrated centre, both under the 25% guard */
chk('raw EV never sizes: a bigger raw edge on the same calibrated probability sizes the same or smaller', biggerRaw.raw_ev_pct > Dd.raw_ev_pct && biggerRaw.calibrated_ev_pct === Dd.calibrated_ev_pct && biggerRaw.recommended_units <= Dd.recommended_units, [brief(biggerRaw), brief(Dd)]);
chk('a quarter-Kelly ceiling is recorded for every sized BET', all.filter((d) => d.decision === 'BET').every((d) => d.sizing && d.sizing.kelly_units != null));
chk('BET tiers are named: SMALL / STANDARD / STRONG / MAX', all.filter((d) => d.decision === 'BET').every((d) => ['SMALL', 'STANDARD', 'STRONG', 'MAX'].indexOf(d.tier) >= 0));
chk('the thresholds are configurable constants: a stricter config turns the BET into a LEAN', D.decide(cfbInput({ model: cfbModel(3, 4, 'VALIDATED') }), { thresholds: { bet: { min_edge_pp: 30, min_ev: 0.5 } } }).decision === 'LEAN');
chk('never above 1.00U whatever a config says', D.decide(cfbInput({ model: cfbModel(-8, -6, 'VALIDATED') }), { sizing: { max_units: 3, source_caps: { calibrated: 3 }, tiers: D.DEFAULT_CONFIG.sizing.tiers.concat([{ key: 'MAX', units: 2, min_edge_pp: 1, min_ev: 0.01, min_confidence: 0 }]), grid: [0.25, 0.5, 0.75, 1] } }).recommended_units <= 1);

section('decision confidence and the audit record');
chk('decision confidence is a 0-100 score with a label, on every evaluable decision', all.concat([Bd, Cd, Ed, Hu]).every((d) => d.decision_confidence >= 0 && d.decision_confidence <= 100 && ['High', 'Moderate', 'Low', 'Very low'].indexOf(d.decision_confidence_label) >= 0));
chk('…it is not a win probability (its own components)', Dd.decision_confidence_detail && Object.keys(Dd.decision_confidence_detail.components).length === 10);
const rec = D.auditRecord(A2);
chk('the audit record: decision, tier, units, quote, probability, break-even, edge, raw/calibrated EV, confidence, source, reasons, warnings',
  ['decision', 'tier', 'units', 'selectedQuote', 'probability', 'breakEven', 'edgePP', 'rawEV', 'calibratedEV', 'decisionConfidence', 'probabilitySource', 'reasons', 'warnings'].every((k) => k in rec) && rec.reasons.indexOf('POSITIVE_EV') >= 0 && rec.reasons.indexOf('EDGE_THRESHOLD_PASSED') >= 0, rec);
chk('a NO DECISION record carries its exact blockers', D.auditRecord(Fd).blockers[0] === 'STALE_QUOTE' && D.auditRecord(Fd).decision === 'NO_DECISION');
chk('the WHY sentence names the model number and the gap to the available line', /Model makes Chicago Bears -6\.0; Chicago Bears -3 \(-105\) sits 3\.0 pts inside the model number/.test(D.whyText(A1)), D.whyText(A1));
chk('research status and bet decision are separate fields', 'research_status' in A1 && A1.bet_decision === A1.decision);
chk('deterministic: the same input decides the same way', sig(nflDecide({ fair: 6, homeLine: -3 })) === sig(A1) && nflDecide({ fair: 6, homeLine: -3 }).decision_id === A1.decision_id);

section('the NFL pricing blend: the kernel’s own fair line');
PRICE.loadValidation('americanfootball_nfl', NFL_VAL);
[[11.89, -3], [2.43, 3.5], [-1.36, -2.5], [9.24, -6.5]].forEach(([mm, mhl]) => {
  const k = PRICE.fairSpread({ sport: 'americanfootball_nfl', model_home_line: -mm, market_home_line: mhl });
  const b = blend(mm, mhl);
  chk('blend parity with supabase/functions/edgedesk_ai/_pricing.js at model ' + mm + ' / market ' + mhl, b.available && Math.abs(b.fair_home_margin - k.fair_home_margin) < 0.011, { ours: b.fair_home_margin, kernel: k.fair_home_margin });
});
chk('a RESEARCH-tier market is not a probability source', blend.length && !D.blendAdjusted({ validation: { tier: 'RESEARCH', blend: NFL_VAL.markets.spread.blend }, model_home_margin: 3, market_home_line: -3, cover: () => null }).available);

section('transitions');
const tr1 = T.transition(Bd, A1);
chk('LEAN/WATCH → BET is a PRICE IMPROVED transition', tr1 && tr1.kind === 'PRICE_IMPROVED', tr1);
const tr2 = T.transition(A1, Hu);
chk('BET → WATCH (QB unknown) is NEW INFORMATION', tr2 && tr2.kind === 'NEW_INFORMATION', tr2);
const tr3 = T.transition(Hu, A1);
chk('WATCH (QB) → BET is INFORMATION RESOLVED', tr3 && tr3.kind === 'INFORMATION_RESOLVED', tr3);
chk('BET → NO DECISION is MARKET UNAVAILABLE', T.transition(A1, Fd).kind === 'MARKET_UNAVAILABLE');
chk('a legacy WAIT reads as WATCH', T.transition({ decision: 'WAIT', action_reason_code: 'QB_UNRESOLVED' }, A1).kind === 'INFORMATION_RESOLVED');

section('the renderers');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/\s+/g, ' ');
const hBet = text(U.actionCardHTML(A1, { track: null, beginner: false }));
chk('BET card: the exact action — BET · 0.25U, MODEL-ESTIMATED, team line (price) · book, cover, break-even, edge, EV, confidence', /BET · 0\.25U/.test(hBet) && /MODEL-ESTIMATED/.test(hBet) && /CHICAGO BEARS -3/.test(hBet) && /-105 · DraftKings/.test(hBet)
  && /HOW MUCH 0\.25U/.test(hBet) && /EDGE \+[\d.]+ pp/.test(hBet) && /MODEL-ESTIMATED EV \+[\d.]+%/.test(hBet) && /CONFIDENCE \d+\/100/.test(hBet) && /Model-estimated probability/.test(hBet)
  && /Model-estimated EV: \+[\d.]+% \(used by the decision engine · no calibration exists yet\)/.test(A1.action.lines.join(' | ')) && !A1.action.lines.some((l) => /^Raw model EV/.test(l)), hBet.slice(0, 600));
const hWatch = text(U.actionCardHTML(Hu, { track: null }));
chk('WATCH card: WATCH · QB UNKNOWN, DO NOT BET YET, the trigger', /WATCH/.test(hWatch) && /QB UNKNOWN/.test(hWatch) && /DO NOT BET YET/.test(hWatch) && /BET TRIGGER/.test(hWatch), hWatch.slice(0, 500));
const hLean = text(U.actionCardHTML(oneSided, { track: null }));
chk('LEAN card: LEAN, 0U no stake, never BET PLACED', /LEAN/.test(hLean) && /0U · no stake/.test(hLean) && !/BET PLACED/.test(hLean), hLean.slice(0, 300));
const hPass = text(U.actionCardHTML(Ed, { track: null }));
chk('PASS card: the reason and the trigger', /PASS/.test(hPass) && /The raw model edge disappears after calibration/.test(hPass) && /BET TRIGGER/.test(hPass), hPass.slice(0, 300));
const hNone = text(U.actionCardHTML(Fd, { track: null }));
chk('NO DECISION card: the exact blocker, never the old generic copy', /NO DECISION/.test(hNone) && /No sufficiently fresh sportsbook quote is available/.test(hNone) && /STALE_QUOTE/.test(hNone) && !/does not currently have enough verified information/.test(hNone) && !/research reference only/.test(hNone), hNone.slice(0, 300));
chk('no card prints tout language', [A1, Hu, oneSided, Ed, Fd, Dd].every((d) => U.copyOk(U.actionCardHTML(d, { track: null }))));
chk('the removed copy exists nowhere in the UI or the engine', ['edgedesk_decision_ui.js', 'edgedesk_decision.js'].every((f) => { const s = fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'); return !/does not currently have enough verified information/.test(s) && !/No validated probability calibration exists for this market/.test(s) && !/research reference only — not an actionable price/.test(s); }));
const page = U.cardPageHTML([A1, Bd, Hu, Ed, Fd, oneSided], { view: { filter: 'all', sort: 'strength' } });
chk('the card page counts BET / LEAN / WATCHING / PASS / NO DECISION', /BET <small>1/.test(page) && /LEAN <small>/.test(page) && /WATCHING <small>/.test(page) && /PASS <small>/.test(page) && /NO DECISION <small>1/.test(page), text(page).slice(0, 400));
chk('the chips: BET · units, LEAN, WATCH', /BET · 0\.25U/.test(U.chipHTML(A1)) && /LEAN/.test(U.chipHTML(oneSided)) && /WATCH/.test(U.chipHTML(Hu)));

/* ======================================================================== */
section('review regressions (each was reproduced before its fix)');
/* 1. a canonical (published-board) DATA FAULT keeps its kind on the page */
chk('fault kind: live rules map guard → GUARD, orientation → ORIENTATION, integrity/fault/gate → FAULT',
  I.labelFaultKind({ rule: 'guard' }) === 'GUARD' && I.labelFaultKind({ rule: 'orientation' }) === 'ORIENTATION' && ['integrity', 'fault', 'gate_data_fault', undefined].every((r) => I.labelFaultKind({ rule: r }) === 'FAULT'));
chk('fault kind: a canonical label carries the build\'s kind, else the facts\', else the live rule it replaced, else FAULT',
  I.labelFaultKind({ rule: 'canonical', fault_kind: 'GUARD' }) === 'GUARD' && I.labelFaultKind({ rule: 'canonical', fault_kind: 'FAULT' }) === 'FAULT'
  && I.labelFaultKind({ rule: 'canonical' }, { integrity: { data_fault: true, data_fault_kind: 'GUARD' } }) === 'GUARD'
  && I.labelFaultKind({ rule: 'canonical', live_key: 'DATA_FAULT', live_rule: 'guard' }) === 'GUARD' && I.labelFaultKind({ rule: 'canonical' }) === 'FAULT');
{
  const gv = { research_label: { key: 'DATA_FAULT', label: 'DATA FAULT', rule: 'canonical', means: 'guard', canonical: true, fault_kind: 'GUARD' } };
  const base = { schema: 'x', sport: 'CFB', game: {}, research: {}, integrity: { data_fault: true, data_fault_kind: 'GUARD', gates: [] }, market: {}, reliability: {}, confidence: {}, projection: {}, qb: { known: true }, availability: { known: true }, support: { by_side: { home: 0, away: 0 } }, anomaly: {} };
  chk('page: a canonical guard DATA FAULT stays a GUARD (the build\'s WATCH, not NO DECISION)', I.factsFromView(gv, base, {}).integrity.data_fault_kind === 'GUARD');
  const fv = { research_label: Object.assign({}, gv.research_label, { fault_kind: 'FAULT' }) };
  chk('page: a canonical integrity DATA FAULT stays a FAULT (blocks)', I.factsFromView(fv, base, {}).integrity.data_fault_kind === 'FAULT');
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  chk('page: the quote-EV board withholds EV on exactly the FAULT kind (fbQevCtx asks labelFaultKind)', /var hardFault=key==='DATA_FAULT'&&\(I&&I\.labelFaultKind\?I\.labelFaultKind\(L,null\)/.test(APP));
  /* audit 2026-09-30 #6: ONE classifier. The build's canonical row used to
     REPLACE the page's live research label on some views and not others
     (Pitt @ VT read two labels); it is now context beside the live label —
     whose own rule carries the fault kind (labelFaultKind reads L.rule) */
  chk('page: the build\'s canonical row is attached as context and never replaces the live research label', /function fbCanonApply\(v,cr\)\{[\s\S]{0,900}?build_research_status:cr\.research_status\|\|null[\s\S]{0,200}?return Object\.assign\(\{\},v,\{canonical:extra\}\);\s*\}/.test(APP) && !/research_label:\{key:vk,label:d\.label/.test(APP));
  chk('page: a live guard DATA FAULT keeps its kind from its own rule (GUARD), an integrity fault stays FAULT', I.labelFaultKind({ key: 'DATA_FAULT', rule: 'guard' }) === 'GUARD' && I.labelFaultKind({ key: 'DATA_FAULT', rule: 'orientation_flip' }) === 'FAULT');
}
/* 2. an alternate whose tail is UNKNOWN (no main line on file for its side) is not validated */
{
  const qs = [q('away', 3, -115), q('away', 3, -118, { book: 'FanDuel' }),
    q('home', -4.5, 120, { market_type: 'alternate_spread', n_books: 1 }), q('home', -4.5, 118, { market_type: 'alternate_spread', book: 'FanDuel', n_books: 1 }),
    q('away', 4.5, -150, { market_type: 'alternate_spread', n_books: 1 }), q('away', 4.5, -148, { market_type: 'alternate_spread', book: 'FanDuel', n_books: 1 })];
  const d = nflDecide({ fair: 6, quotes: qs });
  chk('tail: no BET on an alternate whose tail is UNKNOWN', !(d.decision === 'BET' && d.bet_price && d.bet_price.tail === 'UNKNOWN' && !d.bet_price.is_main_line), brief(d));
  chk('tail: such a quote is capped (TAIL_UNVALIDATED), not dropped', d.decision !== 'NO_DECISION' && d.candidates.some((c) => c.tail === 'UNKNOWN' && c.classification === 'LEAN'), d.candidates.map((c) => c.label + ' ' + c.tail + ' ' + c.classification));
}
{
  const DJ = require(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.js'));
  const fake = { game_id: 'x', decision: 'BET', evaluation_status: 'EVALUABLE', blocker_codes: [], bet_price: { tail: 'UNKNOWN', is_main_line: false, line: -4.5, odds: 120 }, selected_line: -4.5, selected_odds: 120,
    playable: {}, edge_pp: 9, decision_ev_pct: 20, recommended_units: 0.25, probability_source: 'model_estimated', anomaly: null };
  chk('tail: the build refuses to publish a BET on an UNKNOWN-tail alternate', DJ.problems([{ decision: fake }]).some((x) => /unvalidated alternate tail/.test(x)), DJ.problems([{ decision: fake }]));
}
/* 3. a side the engine cannot read is dropped, never thrown on */
{
  let threw = null, d1 = null, d2 = null;
  try {
    d1 = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).map((x) => Object.assign({}, x, { side: x.side.toUpperCase() })) });
    d2 = nflDecide({ fair: 6, quotes: book2(-3, -105, -115).concat([q('over', 44.5, -110), q('under', 44.5, -110)]), fairTotal: 47 });
    D.decide(Object.assign({}, cfbInput({}), { quotes: cfbMain(6.5, -102).concat([cq('left', 6.5, -110)]) }));
  } catch (e) { threw = String(e && e.message || e); }
  chk('sides: HOME / AWAY in capitals, an over/under without market_type, an unreadable side — none throws', threw === null, threw);
  chk('sides: capitalised sides decide exactly as lower-case ones', d1 && d1.decision === nflDecide({ fair: 6 }).decision && d1.selected_line === nflDecide({ fair: 6 }).selected_line, d1 && brief(d1));
  chk('sides: an over/under quote without market_type is a total, not a spread', d2 && d2.markets.total && d2.markets.total.decision !== 'NO_DECISION' && d2.markets.spread.decision === nflDecide({ fair: 6 }).decision, d2 && d2.markets);
}
/* 4. the tracker keeps the reason the previous decision had */
{
  const w = nflDecide({ fair: 6, homeLine: -3, qbKnown: false }), b = nflDecide({ fair: 6, homeLine: -3, now: NOW + 60000 });
  let t = T.track(null, w); t = T.track(t, b);
  const last = t.transitions[t.transitions.length - 1];
  chk('track: WATCH · QB UNKNOWN → BET at the same price is INFORMATION RESOLVED, not PRICE IMPROVED', w.decision === 'WATCH' && b.decision === 'BET' && last.kind === 'INFORMATION_RESOLVED', [w.action_reason_code, b.decision, last.kind]);
}
/* 5. a quote that failed price verification is neither QUALIFIES nor an alternative */
{
  const qs = cfbMain(6.5, -102).concat(cfbMain(6.5, -105, -115, 'DraftKings')).concat([cq('away', 8.5, 105, { market_type: 'alternate_spread', n_books: 1 })]);
  const inp = cfbInput({ quotes: qs });
  const d = D.decide(inp);
  const G = Q.evaluateGame(inp.model, qs, { now: NOW, game: inp.game, max_age_minutes: 90 });
  const skipped = (d.anomaly && d.anomaly.skipped_quotes) || [];
  const st = G.sides.away.quotes.map((o) => ({ l: o.label + ' @ ' + o.sportsbook, s: D.quoteStatus(d, o).status }));
  chk('unverified: the fixture does skip anomalous quotes', skipped.length > 0, skipped);
  chk('unverified: a skipped quote reads WATCH on the board, never QUALIFIES', st.filter((x) => skipped.indexOf(x.l) >= 0).every((x) => x.s === 'WATCH'), st);
  const A = d.alternatives || {};
  chk('unverified: BEST PRICE / SAFER VALUE / MAIN never advertise a skipped quote', [A.best_price, A.safer, A.main, A.better_value].filter(Boolean).every((x) => skipped.indexOf(x.label + ' @ ' + x.book) < 0), A);
}
/* 6. an NFL guard game: the board names the card's decision for the card's quote */
{
  const model = nflModel(20), qs = book2(-3, -105, -115);
  const ctx = { now: NOW, game: { game_id: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', kickoff: KICK }, research_status: 'DATA_FAULT', data_fault: true, orientation: { ok: true }, market_stale: false, reliability: null, max_age_minutes: 90 };
  const G = Q.evaluateGame(model, qs, ctx);
  const v = { gid: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', g: G, model, ctx, qs, dq: { status: 'OK', warnings: [] }, qb: { home: true, away: true }, gap: null };
  const d = D.decide(I.inputFromFacts(I.nflFacts(v), { model, quotes: qs, qev_ctx: ctx, evaluation: G }, { now: NOW, sport: 'NFL' }));
  const sel = d.bet_price || d.reference_quote;
  const o = G.sides[d.side_key].quotes.filter((x) => x.line === sel.line && x.sportsbook === sel.book && x.american_odds === sel.odds)[0];
  /* 17 pts past the market is +75% raw EV: the price anomaly is open AND the
     implausible-EV guard names it first (audit 2026-09-30 #8) */
  chk('guard: the card decides (WATCH, the price anomaly open, named IMPLAUSIBLE EV), not NO DECISION', d.decision === 'WATCH' && d.action_reason_code === 'IMPLAUSIBLE_EV' && (d.caps || []).some((c) => c.code === 'PRICE_ANOMALY'), brief(d));
  chk('guard: the board shows the card\'s decision on the card\'s exact quote', !!o && D.quoteStatus(d, o).status === d.decision, o && D.quoteStatus(d, o));
}
/* 7/8. WATCH only near a trigger for totals too; no trigger when the price already clears */
{
  const inp = I.inputFromFacts(I.nflFacts({ gid: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', g: null, model: nflModel(3, { fairTotal: 44.6 }), ctx: {}, qs: [], dq: { status: 'OK', warnings: [] }, qb: { home: true, away: true }, gap: null }),
    { model: nflModel(3, { fairTotal: 44.6 }), quotes: [q('over', 44.5, -110, { market_type: 'total' }), q('under', 44.5, -110, { market_type: 'total' }), q('over', 44.5, -112, { market_type: 'total', book: 'FanDuel' }), q('under', 44.5, -108, { market_type: 'total', book: 'FanDuel' })] },
    { now: NOW, sport: 'NFL' });
  inp.game = { game_id: 'nfl_g', home: 'Chicago Bears', away: 'New York Jets', kickoff: KICK };
  inp.market_type = 'total';
  const t = D.decide(inp);
  chk('totals: a small edge whose trigger is far is PASS (as for spreads), not WATCH · NEAR THRESHOLD', t.decision === 'PASS' && t.action_reason_code === 'EDGE_TOO_SMALL' && t.bet_trigger && typeof t.bet_trigger.price_move_cents === 'number' && t.bet_trigger.price_move_cents > 10, [t.decision, t.action_reason_code, t.bet_trigger && t.bet_trigger.price_move_cents]);
  chk('totals: the trigger reads Over 44.5 / Under 44.5, never "over +44.5"', !t.bet_trigger || !t.bet_trigger.short || /^(Over|Under) 44\.5 \(/.test(t.bet_trigger.short), t.bet_trigger && t.bet_trigger.short);
  const thin = nflDecide({ fair: 6, quotes: [q('home', -3, -105, { n_books: 1 }), q('away', 3.5, -115, { n_books: 1, book: 'FanDuel' })] });
  chk('trigger: a capped LEAN whose price already clears names no worse "BET at" price', thin.decision === 'LEAN' && thin.bet_trigger && thin.bet_trigger.already_clears === true && thin.bet_trigger.short === null && !(thin.bet_trigger.price_move_cents < 0), [thin.decision, thin.action_reason_code, thin.bet_trigger]);
  const html = U.cardPageHTML([thin], { view: { filter: 'all', sort: 'kickoff', showLean: true } });
  chk('trigger: the Card page LEAN row prints no BET-at price for it', !/BET at Chicago Bears -2\.5/.test(html));
}
/* 9. LEAN's "same direction" is the model's side of the market, not cover ≥ 50% */
{
  const qs = book2(-3, -105, -115).concat([q('home', -8.5, 175, { market_type: 'alternate_spread', n_books: 1 }), q('away', 8.5, -230, { market_type: 'alternate_spread', n_books: 1 })]);
  const m = nflModel(7); m.tail = { validated_within_pts: 10 };
  const d = nflDecide({ model: m, quotes: qs, cfg: { thresholds: { bet: { min_edge_pp: 40, min_ev: 0.9 } } } });
  const alt = d.candidates.filter((c) => c.line === -8.5)[0];
  chk('direction: a plus-money alternate on the model\'s side (cover < 50%, edge ≥ 2 pp, EV > 0) can LEAN', alt && alt.decision_cover < 0.5 && alt.edge_pp >= 2 && alt.classification === 'LEAN', alt);
  const ml = (px) => cfb({ market_type: 'moneyline', model: cfbModel(-3, null, null, { moneyline: { home_win_prob: 0.40, calibration: { validated: false } } }),
    quotes: [cq('home', null, px, { market_type: 'moneyline' }), cq('away', null, -px - 20, { market_type: 'moneyline' }), cq('home', null, px - 3, { market_type: 'moneyline', book: 'DK' }), cq('away', null, -px - 25, { market_type: 'moneyline', book: 'DK' })] });
  chk('direction: a moneyline underdog with edge ≥ 2 pp and EV > 0 is LEAN, not WATCH', ml(170).decision === 'LEAN', brief(ml(170)));
}
/* cosmetic: a STALE_QUOTE's last known quote is named */
{
  const staleQ = book2(-3, -105, -115).map((x) => Object.assign({}, x, { fresh: false, captured_at: '2026-10-04T02:00:00Z' }));
  const d = nflDecide({ fair: 6, quotes: staleQ, previous: { decision: 'BET', bet_price: { side: 'away', line: 3, odds: -110, book: 'FanDuel' } } });
  chk('stale: the last known quote carries a team and a label (no "undefined")', d.decision === 'NO_DECISION' && d.reference_quote && d.reference_quote.team === 'New York Jets' && /^New York Jets \+3 \(-110\)$/.test(d.reference_quote.label) && !/undefined/.test(d.action.selection || ''), [d.reference_quote, d.action && d.action.selection]);
}

section('REAL PAYLOADS · NFL (football/nfl/slate.json: the real model, the real consensus line)');
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
const nflReal = [];
SLATE.games.forEach((g) => {
  const r = g.reference_market || {};
  if (r.home_line == null || g.model_home_margin == null) return;
  const now = Date.parse(g.kickoff) - 6 * 3600e3, at = new Date(now - 10 * 60000).toISOString();
  const model = nflModel(g.model_home_margin, { blendAt: r.home_line });
  const quotes = [{ game_id: g.game_id, side: 'home', line: r.home_line, american: -110, book: 'consensus', captured_at: at, fresh: true, n_books: 3 },
    { game_id: g.game_id, side: 'away', line: -r.home_line, american: -110, book: 'consensus', captured_at: at, fresh: true, n_books: 3 }];
  const ctx = { now, game: { game_id: g.game_id, home: g.home_team, away: g.away_team, kickoff: g.kickoff }, orientation: { ok: true }, qb_unresolved: !(g.qb_known && g.qb_known.home && g.qb_known.away), max_age_minutes: 90 };
  const G = Q.evaluateGame(model, quotes, ctx);
  const facts = I.nflFacts({ gid: g.game_id, home: g.home_team, away: g.away_team, g: G, model, ctx, qs: quotes, dq: g.data_quality, qb: g.qb_known || null });
  const d = D.decide(I.inputFromFacts(facts, { model, quotes, qev_ctx: ctx, evaluation: G }, { now, sport: 'NFL' }));
  nflReal.push({ g, d, model, G });
});
chk('real NFL: a decision for every slate game with a model and a line', nflReal.length === SLATE.games.filter((g) => g.reference_market && g.reference_market.home_line != null && g.model_home_margin != null).length && nflReal.length > 0, nflReal.length);
chk('real NFL: every one is EVALUABLE and reaches BET / LEAN / WATCH / PASS', nflReal.every((x) => x.d.evaluation_status === 'EVALUABLE' && ['BET', 'LEAN', 'WATCH', 'PASS'].indexOf(x.d.decision) >= 0), nflReal.filter((x) => x.d.decision === 'NO_DECISION').map((x) => x.g.game_id + ':' + x.d.blocker_codes));
chk('real NFL: every one decides on the PARTIALLY CALIBRATED pricing blend', nflReal.every((x) => x.d.probability_source === 'partially_calibrated'));
if (nflReal.length >= 6) {
  chk('real NFL: favourites and underdogs both appear as the evaluated side', nflReal.some((x) => x.d.selected_line < 0) && nflReal.some((x) => x.d.selected_line > 0));
  chk('real NFL: positive and negative decision EVs both appear', nflReal.some((x) => x.d.decision_ev_pct > 0) && nflReal.some((x) => x.d.decision_ev_pct < 0));
}
const withRow = nflReal.map((x) => ({ x, row: ((SLATE.pricing && SLATE.pricing.rows) || []).filter((r) => r.game_id === x.g.game_id && r.side === 'home')[0] })).filter((y) => y.row && y.row.fair_line != null);
/* THE BLEND MAY SHRINK THE DISAGREEMENT, NEVER REVERSE IT (audit 2026-09-30
   #4). The fitted blend (1.16 on the market, an intercept of -0.38) lands PAST
   the market line against the projection on most home underdogs — PIT @ CLE:
   model CLE -0.8, market CLE +2.5, blend CLE +2.5 and a bit — and the board's
   margin pmf then prices the favourite, the side the displayed projection is
   AGAINST. Both engines now hold such a blend at "no edge at the market line"
   on their own distribution: the kernel (symmetric normal) at the market line
   itself, the board (the NFL margin pmf, whose median is not its mean) at the
   centre where the projection's side covers exactly half the time. Where
   neither holds, the two must still agree to the cent. */
const COEF = NFL_VAL.markets.spread.blend.latest_coef;
const rawBlend = (y) => { const km = -y.x.g.reference_market.home_line, mm = y.x.g.model_home_margin; return COEF.intercept + COEF.close * km + COEF.model_minus_close * (mm - km); };
const crosses = (y) => { const km = -y.x.g.reference_market.home_line, mm = y.x.g.model_home_margin, b = rawBlend(y); return Math.abs(mm - km) >= 0.5 && (mm - km) * (b - km) < 0; };
const boardHeld = (y) => !!(y.x.model.adjusted && y.x.model.adjusted.held_at_market);
const plain = withRow.filter((y) => !boardHeld(y) && y.row.fair_status !== 'BLENDED_HELD');
chk('real NFL: where neither engine holds the blend, the board reproduces the slate pricing kernel’s fair line', plain.length > 0 && plain.every((y) => Math.abs(y.x.d.canonical.decision_fair_home_spread - y.row.fair_line) < 0.02), plain.filter((y) => Math.abs(y.x.d.canonical.decision_fair_home_spread - y.row.fair_line) >= 0.02).map((y) => [y.x.g.game_id, y.x.d.canonical.decision_fair_home_spread, y.row.fair_line]));
chk('real NFL: the kernel holds (BLENDED_HELD, at the market line) exactly the games whose blend crosses the market line against the projection', withRow.every((y) => (y.row.fair_status === 'BLENDED_HELD') === crosses(y) && (y.row.fair_status !== 'BLENDED_HELD' || Math.abs(y.row.fair_line - y.row.market_line) < 1e-9)),
  withRow.filter((y) => (y.row.fair_status === 'BLENDED_HELD') !== crosses(y)).map((y) => [y.x.g.game_id, y.row.fair_status, y.row.fair_line, y.row.market_line, Math.round(rawBlend(y) * 100) / 100]));
chk('real NFL: the audit games are held by the kernel — PIT @ CLE, ARI @ NYG, LA @ PHI', ['2026_04_PIT_CLE', '2026_04_LA_PHI'].every((id) => withRow.some((y) => y.x.g.game_id === id && y.row.fair_status === 'BLENDED_HELD')), withRow.filter((y) => /PIT_CLE|ARI_NYG|LA_PHI/.test(y.x.g.game_id)).map((y) => [y.x.g.game_id, y.row.fair_status]));
const heldB = withRow.filter(boardHeld);
chk('real NFL: the board holds some real games (the rule is exercised, not vacuous)', heldB.length > 0, heldB.length);
/* "just far enough": at the held centre the projection's side covers the
   market line at least half the time, and 0.01 pts back toward the fitted
   blend it no longer does (the pmf is keyed in half points, so the cover can
   step across one half exactly at the boundary) */
chk('real NFL: where the board holds, it moves the fitted blend toward the projection just far enough that the projection’s side covers the market line half the time, and never past the projection',
  heldB.every((y) => { const a = y.x.model.adjusted, mhl = y.x.g.reference_market.home_line, mm = y.x.g.model_home_margin, X = mm > -mhl ? 'home' : 'away';
    const coverAt = (c) => { const p = Q.sideProb((t) => E.dist.coverProbSpread('nfl', c, t), X, X === 'home' ? mhl : -mhl); return p ? p.cover : null; };
    const back = a.fair_home_margin + (a.raw_blend_home_margin < a.fair_home_margin ? -0.01 : 0.01);
    return coverAt(a.fair_home_margin) >= 0.5 - 1e-4 && coverAt(back) < 0.5 && Math.abs(a.raw_blend_home_margin - rawBlend(y)) < 1e-3
      && a.fair_home_margin >= Math.min(a.raw_blend_home_margin, mm) - 1e-9 && a.fair_home_margin <= Math.max(a.raw_blend_home_margin, mm) + 1e-9; }),
  heldB.map((y) => [y.x.g.game_id, y.x.model.adjusted.raw_blend_home_margin, y.x.model.adjusted.fair_home_margin, y.x.g.model_home_margin]));
chk('real NFL: no game’s best spread EV sits on the side the displayed projection is against (the side invariant holds on every real game)', nflReal.every((x) => x.G.side_invariant && x.G.side_invariant.ok !== false), nflReal.filter((x) => !x.G.side_invariant || x.G.side_invariant.ok === false).map((x) => [x.g.game_id, x.G.side_invariant && x.G.side_invariant.reason]));
chk('real NFL: raw and blended EV are both reported on every decision', nflReal.every((x) => x.d.raw_ev_pct != null && x.d.calibrated_ev_pct != null));
console.log('    NFL real payloads (model, consensus line at -110 — the repo holds no captured NFL book prices):');
nflReal.forEach((x) => console.log('      ' + (x.g.away_code + ' @ ' + x.g.home_code).padEnd(10) + ' ' + String(x.d.decision_display).padEnd(40) + ' ' + String(x.d.action.selection || '').padEnd(34) + ' edge ' + String(x.d.edge_pp).padStart(6) + ' pp · EV ' + String(x.d.decision_ev_pct).padStart(6) + '% (raw ' + String(x.d.raw_ev_pct).padStart(6) + '%) · conf ' + x.d.decision_confidence));

section('REAL PAYLOADS · CFB (football/cfb_terminal/games.json: real curve, calibrator, captured DraftKings prices)');
const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_ev', 'current.json'), 'utf8'));
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_ev', 'artifacts', CUR.calibration, 'calibration.json'), 'utf8'));
const cfbReal = [];
Object.keys(GAMES.games).forEach((gid) => {
  const o = GAMES.games[gid], ri = o.read_inputs;
  if (!ri || !ri.curve || !ri.model || !ri.model.available) return;
  const priced = (ri.market && ri.market.quotes || []).filter((x) => x.home_line != null && x.price_home != null && x.price_away != null);
  if (!priced.length) return;
  const byBook = {};
  priced.forEach((x) => { if (!byBook[x.book] || Date.parse(x.observed_at) > Date.parse(byBook[x.book].observed_at)) byBook[x.book] = x; });
  const kick = Date.parse(o.kickoff), now = Math.min(kick - 3 * 3600e3, Math.max.apply(null, Object.keys(byBook).map((k) => Date.parse(byBook[k].observed_at))) + 10 * 60000);
  const at = new Date(now - 10 * 60000).toISOString();
  const quotes = [];
  Object.keys(byBook).forEach((k) => { const x = byBook[k]; quotes.push({ game_id: gid, side: 'home', line: x.home_line, american: x.price_home, book: x.book, captured_at: at, fresh: true, n_books: 1 }, { game_id: gid, side: 'away', line: -x.home_line, american: x.price_away, book: x.book, captured_at: at, fresh: true, n_books: 1 }); });
  const cover = B.curveCover(ri.curve), anchorLine = quotes[0].line;
  const key = (CAL.checkpoint_map || {})[EV.checkpointOf(new Date(now).toISOString(), o.kickoff, false)] || 'cfb|spread|close';
  const cal = EV.calibrationFor(CAL, key, ri.model.model_version);
  let adjusted = { available: false, reason: 'calibration ' + cal.status };
  if (cal.usable) { const An = EV.anchorOf({ anchor_home_line: anchorLine, anchor_source: 'replay', curve: ri.curve, game: { home: o.game.home } }, cal); if (An && !An.problem) adjusted = { available: true, label: 'CALIBRATED', method: cal.method, version: cal.version, maturity: cal.maturity, side_prob: (s, l) => EV.shiftedSide(ri.curve, s, l, An.delta_pts) }; }
  const model = { sport: 'CFB', available: true, model_version: ri.model.model_version, fair_home_margin: ri.model.home_margin, home_cover: cover, adjusted, tail: { validated_within_pts: 0 } };
  const facts = I.factsFromTerminal(o, o.read, o.ev, { policy_status: 'SHADOW' });
  facts.market.stale = false;
  const d = D.decide(I.inputFromFacts(facts, { model, quotes, qev_ctx: { now, game: { game_id: gid, home: o.game.home, away: o.game.away, kickoff: o.kickoff }, max_age_minutes: 180 } }, { now, sport: 'CFB' }));
  /* the orientation invariant (audit 2026-09-30 #5), on the replay's own numbers */
  const orient = require(path.join(ROOT, 'lib', 'edgedesk_canon.js')).orientationSuspect(ri.model.home_margin, -anchorLine);
  cfbReal.push({ o, d, orient });
});
chk('real CFB: replayed every game with captured two-sided prices', cfbReal.length > 0, cfbReal.length);
/* A CALIBRATED probability that crosses the line is held at NO DECISION by
   design (tools/football/quote_ev.test.js: "a CALIBRATED probability on the
   other side of the line fails it too"), and live prices can put a real game
   there: on 2026-10-01 DraftKings' Penn State -3 (+100) at Northwestern did,
   the calibrator moving a 67% raw Northwestern cover to just under 50%. A RAW
   contradiction on a real game is still a pricing bug and still fails here. */
const calHold = (d) => d.decision === 'NO_DECISION' && (d.blockers || []).length > 0
  && d.blockers.every((b) => b.code === 'EV_SIDE_CONTRADICTION' && /calibrated EV/.test(b.text) && !/% raw/.test(b.text));
chk('the calibrated-crossing hold is told apart from a raw contradiction', calHold({ decision: 'NO_DECISION', blockers: [{ code: 'EV_SIDE_CONTRADICTION', text: 'EV SIDE CONTRADICTION: … shows +0.4% calibrated EV. …' }] })
  && !calHold({ decision: 'NO_DECISION', blockers: [{ code: 'EV_SIDE_CONTRADICTION', text: 'EV SIDE CONTRADICTION: … shows +3.1% raw and +0.4% calibrated EV. …' }] })
  && !calHold({ decision: 'NO_DECISION', blockers: [{ code: 'EV_SIDE_CONTRADICTION', text: 'EV SIDE CONTRADICTION: … shows +3.1% raw EV. …' }] })
  && !calHold({ decision: 'NO_DECISION', blockers: [{ code: 'STALE_MARKET', text: 'stale' }] }));
chk('real CFB: every replayed game is EVALUABLE and reaches BET / LEAN / WATCH / PASS — except one the orientation invariant holds at DATA FAULT, and any a calibrated line-crossing holds at NO DECISION',
  cfbReal.every((x) => x.orient ? (x.d.decision === 'NO_DECISION' && String(x.d.blocker_codes).indexOf('DATA_FAULT') >= 0)
    : (calHold(x.d) || (x.d.evaluation_status === 'EVALUABLE' && ['BET', 'LEAN', 'WATCH', 'PASS'].indexOf(x.d.decision) >= 0))),
  cfbReal.filter((x) => x.d.decision === 'NO_DECISION').map((x) => x.o.game_id + ':' + x.d.blocker_codes + (x.orient ? ' (orientation)' : '')));
chk('real CFB: Syracuse @ UConn, flagged by the orientation invariant, gets no decision (left flagged, never priced)', (() => {
  const x = cfbReal.find((y) => y.o.game && y.o.game.home === 'UConn' && y.o.game.away === 'Syracuse');
  return !x || (x.orient && x.d.decision === 'NO_DECISION');
})());
if (cfbReal.length >= 6) chk('real CFB: favourites and underdogs both appear', cfbReal.some((x) => x.d.selected_line < 0) && cfbReal.some((x) => x.d.selected_line > 0));
chk('real CFB: the calibrated probability is used where the calibrator anchors', cfbReal.some((x) => x.d.probability_source === 'partially_calibrated'));
chk('real CFB: no BET ever exceeds its source cap', cfbReal.every((x) => x.d.decision !== 'BET' || x.d.recommended_units <= { model_estimated: 0.25, partially_calibrated: 0.5, calibrated: 1 }[x.d.probability_source]));
console.log('    CFB real payloads (captured prices replayed as current):');
cfbReal.forEach((x) => console.log('      ' + (x.o.game.away + ' @ ' + x.o.game.home).slice(0, 38).padEnd(38) + ' ' + String(x.d.decision_display).padEnd(36) + ' ' + String(x.d.action.selection || '').padEnd(36) + ' edge ' + String(x.d.edge_pp).padStart(6) + ' · EV ' + String(x.d.decision_ev_pct).padStart(6) + '% (raw ' + String(x.d.raw_ev_pct).padStart(6) + '%)'));

section('the committed build artifact reads under either engine');
const DEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.json'), 'utf8'));
chk('decisions.json: every decision is a known key (v1 or v2)', DEC.decisions.every((d) => D.DECISION_KEYS.indexOf(d.decision) >= 0 || d.decision === 'WAIT'));
if (DEC.engine === D.VERSION) {
  chk('decisions.json (v2): NO DECISION only with essential blockers', DEC.decisions.every((d) => d.decision !== 'NO_DECISION' || (d.blocker_codes || []).every((c) => ESSENTIAL.indexOf(c) >= 0)));
  chk('decisions.json (v2): every evaluable game reaches BET / LEAN / WATCH / PASS', DEC.decisions.every((d) => d.evaluation_status !== 'EVALUABLE' || d.decision !== 'NO_DECISION'));
}

section('a finished game is graded even when no closing line was captured');
{
  const DJ = require(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.js'));
  const K0 = '2026-10-03T19:30:00.000Z', fin = { status: 'FINAL', final_margin: 7 }, close = { home_line: -3.5 };
  const at = (h) => new Date(Date.parse(K0) + h * 3600e3).toISOString();
  chk('final + close: graded at once', DJ.gradeable(fin, close, K0, at(4)) === true);
  chk('final, no close yet: waits for the close inside the window', DJ.gradeable(fin, null, K0, at(DJ.CLOSE_WAIT_HOURS - 1)) === false);
  chk('final, no close after the window: graded (no CLV), never pending forever', DJ.gradeable(fin, null, K0, at(DJ.CLOSE_WAIT_HOURS)) === true);
  chk('no final: never graded, close or not', DJ.gradeable({ status: 'IN_PROGRESS', final_margin: null }, close, K0, at(100)) === false && DJ.gradeable(null, close, K0, at(100)) === false);
  const BTk = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
  const g = BTk.grade({ side: 'home', line: -3.5, odds: -110, units: 0.5 }, { line: null }, { home_margin: 7 });
  chk('graded without a close: the result and units, CLV left unknown (null)', g.result === 'win' && g.clv_points === null && g.units_won > 0, g);
}

/* ------------------------------------------------------------------ out */
if (VERBOSE) [A1, A2, Bd, Cd, Dd, Ed, Fd, Hu, Jd, giant, guard, Ld].forEach((d) => console.log(JSON.stringify(brief(d))));
failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'football decision engine — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
