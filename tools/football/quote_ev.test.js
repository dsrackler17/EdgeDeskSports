#!/usr/bin/env node
/* ============================================================================
   QUOTE-LEVEL EV — the rules (lib/edgedesk_quote_ev.js).

     node tools/football/quote_ev.test.js

   1  odds math: every price the spec names, break-even, EV at −110
   2  pushes: integer lines, the no-push basis, push-aware fair odds
   3  fail closed: missing odds, stale, unknown time, data fault, orientation
   4  sides: home/away signs, opposite-side orientation, two-sided checks
   5  the exact quote: line, price and book from one object; book mismatch
   6  independence: a price never moves a probability or the pure projection
   7  best line / best price / best EV are separate answers
   8  the alternate ladder: best price per spread, frontier, dominated,
      MAX EV, SAFEST +EV, adjacent steps, key numbers, tails
   9  sanity guards
   10 decisions are per quote, never inherited
   11 history: freeze, grading, EV buckets
   12 parity with the other odds implementations and the champion's curve
   13 totals and moneylines stay unavailable until validated
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
const DEC = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E1 = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
require(path.join(ROOT, 'football', 'params.js'));
const EF = require(path.join(ROOT, 'football', 'engine.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function section(t) { console.log('\n' + t); }

/* a discretised normal on integer home margins */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normalCover(mu, sd) {
  const pmf = {}; let tot = 0;
  for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
  Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
  return (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; };
}
const NOW = Date.parse('2026-09-28T12:00:00Z'), FRESH = '2026-09-28T11:52:00Z';
function model(o) {
  o = o || {};
  return Object.assign({ sport: 'CFB', available: true, model_version: 'edgedesk_test_v1', projection_timestamp: '2026-09-28T10:00:00Z', fair_home_margin: o.fair != null ? o.fair : 1.3,
    home_cover: normalCover(o.fair != null ? o.fair : 1.3, o.sd || 14), tail: { validated_within_pts: o.within != null ? o.within : 3 }, key_mass: { 3: 0.0926, 7: 0.0851, 10: 0.0461, 14: 0.0461 } }, o.extra || {});
}
const GAME = { game_id: 'g1', home: 'Michigan', away: 'Minnesota', kickoff: '2026-09-28T19:30:00Z' };
function ctx(o) { return Object.assign({ now: NOW, game: GAME }, o || {}); }
function q(side, line, american, extra) { return Object.assign({ game_id: 'g1', side: side, line: line, american: american, book: 'DraftKings', captured_at: FRESH, fresh: true, n_books: 1 }, extra || {}); }

/* ======================================================================== */
section('1. odds math');
const TABLE = [[-105, 1.952381, 0.512195], [-110, 1.909091, 0.523810], [-115, 1.869565, 0.534884], [-120, 1.833333, 0.545455], [100, 2, 0.5], [120, 2.2, 0.454545], [150, 2.5, 0.4]];
TABLE.forEach(([a, d, be]) => {
  chk('decimal ' + a, near(Q.americanToDecimal(a), d, 1e-6), Q.americanToDecimal(a));
  chk('break-even ' + a, near(Q.breakEven(Q.americanToDecimal(a)), be, 1e-6), Q.breakEven(Q.americanToDecimal(a)));
});
chk('positive American: 1 + a/100', Q.americanToDecimal(135) === 2.35);
chk('negative American: 1 + 100/|a|', near(Q.americanToDecimal(-250), 1.4, 1e-12));
chk('−110 break-even 52.38%', (100 * Q.breakEven(Q.americanToDecimal(-110))).toFixed(2) === '52.38');
chk('−105 break-even 51.22%', (100 * Q.breakEven(Q.americanToDecimal(-105))).toFixed(2) === '51.22');
chk('+100 break-even 50.00%', (100 * Q.breakEven(Q.americanToDecimal(100))).toFixed(2) === '50.00');
[-50, 0, 99, -99, null, undefined, 'x', NaN].forEach((a) => chk('invalid American ' + a, Q.americanToDecimal(a) === null));
const D110 = Q.americanToDecimal(-110);
chk('50% at −110 is negative EV (−4.55%)', near(Q.expectedValue(0.5, 0, 0.5, D110), -0.0454545, 1e-6));
chk('52.38% at −110 is ~0 EV', near(Q.expectedValue(1 / D110, 0, 1 - 1 / D110, D110), 0, 1e-12));
chk('52.38% (rounded) at −110 is within 0.01% of zero', Math.abs(Q.expectedValue(0.5238, 0, 0.4762, D110)) < 1e-4);
chk('55% at −110 is positive EV (+5.00%)', near(Q.expectedValue(0.55, 0, 0.45, D110), 0.05, 1e-9));
chk('56% at −110 is +6.91% (spec example)', (100 * Q.expectedValue(0.56, 0, 0.44, D110)).toFixed(2) === '6.91');
chk('60% at −110 is strongly positive (+14.55%)', near(Q.expectedValue(0.6, 0, 0.4, D110), 0.1454545, 1e-6));
chk('EV = 0 at the break-even for every price', TABLE.every(([a]) => { const d = Q.americanToDecimal(a); return near(Q.expectedValue(1 / d, 0, 1 - 1 / d, d), 0, 1e-12); }));
chk('EV increases with the probability at a fixed price', [0.4, 0.45, 0.5, 0.55, 0.6].map((p) => Q.expectedValue(p, 0, 1 - p, D110)).every((x, i, a) => i === 0 || x > a[i - 1]));
chk('EV increases with the payout at a fixed probability', TABLE.map(([a]) => Q.americanToDecimal(a)).sort((x, y) => x - y).map((d) => Q.expectedValue(0.5, 0, 0.5, d)).every((x, i, a) => i === 0 || x > a[i - 1]));
chk('fair price for 57.8% is −137 (spec example)', Q.fairAmerican(0.578, 0) === -137);
chk('fair price for 50% is +100/−100', Math.abs(Q.fairAmerican(0.5, 0)) === 100);
chk('fair price for 40% is +150', Q.fairAmerican(0.4, 0) === 150);
chk('cents between −137 and −110 is 27', Q.centsBetter(-137, -110) === 27);
chk('cents between −105 and +105 is 10', Q.centsBetter(-105, 105) === 10);

section('2. pushes on whole-number lines');
{
  const d = D110, w = 0.55, pu = 0.03, l = 0.42;
  const ev = Q.expectedValue(w, pu, l, d);
  chk('push contributes zero: EV = win·(d−1) − loss', near(ev, 0.55 * (d - 1) - 0.42, 1e-12));
  chk('push is not a win', !near(ev, Q.expectedValue(w + pu, 0, l, d), 1e-6));
  chk('push is not a loss', !near(ev, Q.expectedValue(w, 0, l + pu, d), 1e-6));
  chk('fair decimal is (1 − push)/win', near(Q.fairDecimal(w, pu), 0.97 / 0.55, 1e-12));
  chk('EV is exactly 0 at the push-aware fair price', near(Q.expectedValue(w, pu, l, Q.fairDecimal(w, pu)), 0, 1e-12));
  chk('unconditional break-even (1 − push)/d', near(Q.breakEvenUnconditional(d, pu), 0.97 / d, 1e-12));
  chk('probabilities that do not sum to 1 fail closed', Q.expectedValue(0.55, 0.03, 0.5, d) === null);
  chk('negative probability fails closed', Q.expectedValue(-0.1, 0, 1.1, d) === null);
  /* through a real quote on an integer line */
  const M = model({ fair: 1.3 });
  const o = Q.priceQuote(M, q('away', 7, -110), ctx({ main_line_for_side: 7 }));
  chk('integer line carries push probability', o.model_push_probability > 0, o.model_push_probability);
  chk('win + push + loss = 1', near(o.model_win_probability + o.model_push_probability + o.model_loss_probability, 1, 1e-5));
  chk('cover is the no-push basis', near(o.model_cover_probability, o.model_win_probability / (1 - o.model_push_probability), 1e-5));
  chk('edge sign equals EV sign on an integer line', (o.probability_edge > 0) === (o.expected_value > 0));
  chk('EV uses win, push, loss separately', near(o.expected_value, o.model_win_probability * (o.decimal_odds - 1) - o.model_loss_probability, 1e-5));
  const h = Q.priceQuote(M, q('away', 6.5, -110), ctx({ main_line_for_side: 7 }));
  chk('half-point line has zero push', h.model_push_probability === 0);
  chk('half-point cover equals win', near(h.model_cover_probability, h.model_win_probability, 1e-9));
  /* research_core's priceAssessment now agrees on the basis */
  const pa = R.priceAssessment(-110, 0.55, 0.03);
  chk('research_core edge on the no-push basis', near(pa.prob_edge, 0.55 / 0.97 - 1 / d, 1e-12));
  chk('research_core edge sign equals its ROI sign', (pa.prob_edge > 0) === (pa.expected_roi > 0));
  const pa2 = R.priceAssessment(-110, 0.5220, 0.02);      /* win 52.2%, push 2%: EV > 0 while win < 52.38% */
  chk('a push can make EV positive below the headline break-even', pa2.expected_roi > 0 && pa2.prob_edge > 0 && 0.522 < 1 / d, pa2);
}

section('3. fail closed');
{
  const M = model();
  const miss = Q.priceQuote(M, q('away', 7, null), ctx());
  chk('missing odds: EV unavailable', miss.ev_available === false && miss.ev_unavailable_code === 'NO_PRICE');
  chk('missing odds: EV is null, never 0', miss.expected_value === null && miss.expected_value_pct === null);
  chk('missing odds: reason printed', /no price/.test(miss.ev_unavailable_reason));
  const bad = Q.priceQuote(M, q('away', 7, -50), ctx());
  chk('invalid price rejected', bad.ev_unavailable_code === 'INVALID_PRICE');
  const stale = Q.priceQuote(M, q('away', 7, -110, { fresh: false, freshness_state: 'STALE', captured_at: '2026-09-28T01:00:00Z' }), ctx());
  chk('stale quote: EV unavailable · quote stale', stale.ev_unavailable_code === 'STALE' && /quote stale/.test(stale.ev_unavailable_reason));
  chk('stale quote: still reports its age', stale.quote_age_minutes === 660);
  chk('stale quote: the age reads as the age column prints it (11h, never "660 min")', /captured 11h ago/.test(stale.ev_unavailable_reason), stale.ev_unavailable_reason);
  chk('ages: minutes, then hours, then days', Q.ageText(41) === '41m' && Q.ageText(998) === '17h' && Q.ageText(37440) === '26d' && Q.ageText(null) === '—');
  const unk = Q.priceQuote(M, q('away', 7, -110, { captured_at: null, fresh: null }), ctx());
  chk('unknown capture time: unavailable', unk.ev_unavailable_code === 'QUOTE_TIME_UNKNOWN');
  const maxAge = Q.priceQuote(M, q('away', 7, -110, { fresh: null, captured_at: '2026-09-28T09:00:00Z' }), ctx({ max_age_minutes: 90 }));
  chk('a max age judges freshness when the page gave no verdict', maxAge.ev_unavailable_code === 'STALE');
  chk('DATA FAULT: unavailable', Q.priceQuote(M, q('away', 7, -110), ctx({ research_status: 'DATA_FAULT' })).ev_unavailable_reason === 'DATA FAULT');
  chk('no model: unavailable', Q.priceQuote({ available: false }, q('away', 7, -110), ctx()).ev_unavailable_code === 'NO_MODEL');
  chk('no model version: unavailable', Q.priceQuote(Object.assign(model(), { model_version: null }), q('away', 7, -110), ctx()).ev_unavailable_code === 'MODEL_VERSION');
  chk('orientation failure: unavailable', Q.priceQuote(M, q('away', 7, -110), ctx({ orientation: { ok: false, reason: 'flipped' } })).ev_unavailable_code === 'ORIENTATION');
  chk('market check failure: unavailable', /market integrity check failed/.test(Q.priceQuote(M, q('away', 7, -110), ctx({ market_check_failed: true })).ev_unavailable_reason));
  chk('quarter line: unsupported', Q.priceQuote(M, q('away', 7.25, -110), ctx()).ev_unavailable_code === 'LINE_UNSUPPORTED');
  chk('no game id: invalid game', Q.priceQuote(M, q('away', 7, -110, { game_id: null }), { now: NOW }).ev_unavailable_code === 'INVALID_GAME');
  const inv = Q.priceQuote(M, q('away', 7, -110), ctx({ research_status: 'INVESTIGATE' }));
  chk('INVESTIGATE keeps the raw EV with a loud warning', inv.ev_available && inv.ev_state === 'RAW_UNVERIFIED' && /INTEGRITY CHECK NOT CLEARED/.test(inv.actionable_context));
  const mf = Q.priceQuote(M, q('away', 7, -110), ctx({ research_status: 'MARKET_FAULT' }));
  chk('MARKET FAULT keeps the EV for audit only', mf.ev_state === 'AUDIT_ONLY' && /not currently actionable/.test(mf.actionable_context));
  const g0 = Q.evaluateGame(M, [], ctx());
  chk('a game with no quotes: EV unavailable · no priced quote', !g0.ev_available && g0.ev_unavailable_reason === 'no priced quote' && g0.best_ev_pct === null);
  const g1 = Q.evaluateGame(M, [q('away', 7, -110, { fresh: false, freshness_state: 'STALE' })], ctx());
  chk('a game with only stale quotes says so', /^quote stale/.test(g1.ev_unavailable_reason), g1.ev_unavailable_reason);
  const distBad = Object.assign(model(), { home_cover: () => ({ win: 0.7, push: 0, lose: 0.7 }) });
  chk('a distribution that does not sum to 1 is a fault', Q.priceQuote(distBad, q('away', 7.5, -110), ctx()).ev_unavailable_code === 'DISTRIBUTION_FAULT');
}

section('4. sides and orientation');
{
  const M = model({ fair: 10 });                          /* home favoured by 10 */
  const hm = Q.priceQuote(M, q('home', -7, -110), ctx()), aw = Q.priceQuote(M, q('away', 7, -110), ctx());
  chk('home −7 when the model says home by 10 covers more often than not', hm.model_cover_probability > 0.5);
  chk('away +7 is the mirror', near(hm.model_win_probability, aw.model_loss_probability, 1e-12) && near(hm.model_push_probability, aw.model_push_probability, 1e-12));
  chk('opposite sides of one number: covers sum to 1', near(hm.model_cover_probability + aw.model_cover_probability, 1, 1e-9));
  chk('both sides priced independently', hm.expected_value > 0 && aw.expected_value < 0);
  const dog = Q.priceQuote(M, q('home', 3, -110), ctx());
  chk('a home underdog line (+3) covers more often than home −7', dog.model_cover_probability > hm.model_cover_probability);
  const M2 = model({ fair: -6 });                         /* away favoured by 6 */
  chk('away −3 covers more often than not when away is favoured by 6', Q.priceQuote(M2, q('away', -3, -110), ctx()).model_cover_probability > 0.5);
  chk('home +3 is under 50% then', Q.priceQuote(M2, q('home', 3, -110), ctx()).model_cover_probability < 0.5);
  /* the sign of a side line: away +7 against fair home −1.3 needs the away side to lose by fewer than 7 */
  const M3 = model({ fair: 1.3 });
  const a7 = Q.priceQuote(M3, q('away', 7, -110), ctx());
  const direct = normalCover(1.3, 14)(7);                  /* P(home margin > 7) is the away LOSS */
  chk('away +7 loss = P(home margin > 7)', near(a7.model_loss_probability, direct.win, 1e-6));
  /* two-sided checks */
  const G = Q.evaluateGame(M3, [q('home', -7, -110, { n_books: 5 }), q('away', 7, -110, { n_books: 5 })], ctx());
  chk('both sides evaluated even when one is the lean', G.sides.home.best_ev && G.sides.away.best_ev);
  chk('no both-positive flag on a coherent distribution', !G.flags.some((f) => f.code === 'BOTH_SIDES_POSITIVE'));
  /* two sides priced off two different distributions (the bug the guard exists for): each call answers differently */
  let calls = 0;
  const incoherent = Object.assign(model(), { home_cover: () => (calls++ % 2 === 0 ? { win: 0.6, push: 0, lose: 0.4 } : { win: 0.4, push: 0, lose: 0.6 }) });
  const GB = Q.evaluateGame(incoherent, [q('home', -7.5, -110, { n_books: 3 }), q('away', 7.5, -110, { n_books: 3, book: 'X' })], ctx());
  chk('both sides of one number showing positive EV is flagged', GB.flags.some((f) => f.code === 'BOTH_SIDES_POSITIVE'), GB.flags);
  const ARB = Q.evaluateGame(model({ fair: 0 }), [q('home', -0.5, 110, { book: 'A', n_books: 1 }), q('away', 0.5, 110, { book: 'B', n_books: 1 })], ctx());
  chk('both sides at +110 at two books is an arbitrage condition, not a model edge', ARB.flags.some((f) => f.code === 'ARBITRAGE_CONDITION'), ARB.flags);
  const MIS = Q.evaluateGame(M3, [q('home', -7, -110, { n_books: 4 }), q('away', -7, -110, { n_books: 4 })], ctx());
  chk('main lines that do not mirror raise an orientation flag', MIS.flags.some((f) => f.code === 'ORIENTATION_MISMATCH'));
}

section('5. the exact quote');
{
  const M = model();
  const a = Q.priceQuote(M, q('away', 7, -110, { book: 'FanDuel', captured_at: '2026-09-28T11:52:00Z' }), ctx());
  chk('line, price and book travel together', a.spread === 7 && a.american_odds === -110 && a.sportsbook === 'FanDuel' && a.captured_at === '2026-09-28T11:52:00.000Z');
  chk('label names the exact wager', a.label === 'Minnesota +7 (-110)');
  chk('quote age in minutes', a.quote_age_minutes === 8);
  const b = Q.priceQuote(M, q('away', 7, -105, { book: 'BetMGM' }), ctx());
  chk('same line, different price: same probability', a.model_cover_probability === b.model_cover_probability);
  chk('same line, better price: higher EV', b.expected_value > a.expected_value);
  const mm = Q.priceQuote(M, q('away', 7, -110, { line_book: 'DraftKings', price_book: 'FanDuel' }), ctx());
  chk('a line from one book and a price from another is flagged', mm.flags.some((f) => f.code === 'BOOK_MISMATCH'));
  const dOnly = Q.priceQuote(M, q('away', 7, null, { decimal: 1.91 }), ctx());
  chk('a decimal-only price keeps its own precision', near(dOnly.break_even_probability, 1 / 1.91, 1e-6) && dOnly.approximate_american === false && dOnly.american_odds === -110 && dOnly.price_source === 'DECIMAL');
  chk('a decimal displays as its whole American price but is priced at its own value', Q.priceOf(null, 1.905).american_display === -110 && Q.priceOf(null, 1.905).decimal === 1.905 && Q.priceOf(null, 1.0).valid === false);
  const mismatch = Q.priceOf(-110, 2.1);
  chk('an American price and a contradicting decimal are flagged', mismatch.valid && mismatch.mismatch === true);
  chk('the required fields exist', ['game_id', 'team', 'side', 'market_type', 'spread', 'american_odds', 'decimal_odds', 'sportsbook', 'captured_at', 'quote_age_minutes', 'model_cover_probability', 'model_push_probability', 'model_loss_probability',
    'break_even_probability', 'probability_edge', 'expected_value', 'expected_value_pct', 'model_version', 'projection_timestamp', 'quote_status', 'calibration_status', 'decision_status'].every((k) => Object.prototype.hasOwnProperty.call(a, k)));
}

section('6. a price never moves a probability or the pure projection');
{
  const M = model();
  Object.freeze(M);
  const snap = JSON.stringify({ f: M.fair_home_margin, v: M.model_version });
  const probs = [-300, -150, -110, 100, 150, 400].map((p) => Q.priceQuote(M, q('away', 7, p), ctx()).model_cover_probability);
  chk('cover identical at every price', probs.every((x) => x === probs[0]));
  chk('the model object is not mutated', JSON.stringify({ f: M.fair_home_margin, v: M.model_version }) === snap);
  const G1 = Q.evaluateGame(M, [q('away', 7, -110)], ctx()), G2 = Q.evaluateGame(M, [q('away', 7, 250), q('home', -7, -400)], ctx());
  chk('quotes do not change the model the game reports', G1.model_version === G2.model_version);
  /* the champion's own projection: the fair margin does not depend on the market it is joined to */
  const P = window.EDCfbP4Params;
  const st = E1.newState();
  st.canonicalRatings = { alabama: { value: 4 }, georgia: { value: 0 } };
  const reqOf = (market) => ({ season: P.trained_through_season, week: 6, state: st,
    game: { home: 'Alabama', away: 'Georgia', neutral_site: false, kickoff: '2025-10-11T19:00:00Z' },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } }, market: market });
  const fairs = [{}, { spread_line: 7 }, { spread_line: -14, total_line: 61 }, { spread_line: 3, quotes_h2h: [[1.5, 2.8]] }].map((mk) => E1.projectGame(reqOf(mk)).model.fair_spread);
  chk('the champion’s fair spread is identical with no market, any market line, any price', fairs.every((x) => typeof x === 'number' && x === fairs[0]), fairs);
  /* the conditioned shape: the market chooses the shape table, never the centre */
  const D = P.distributions;
  const c1 = Q.cfbConditionedCover(D, 3.2, 7, 14.9, 14.633), c2 = Q.cfbConditionedCover(D, 3.2, -2, 14.9, 14.633);
  const mean = (f) => { let m = 0; for (let t = -80; t <= 80; t++) { const a = f(t - 1), b = f(t); m += t * (a.win - b.win - b.push + a.push) * 0 + t * (f(t - 0.5).win - f(t + 0.5).win); } return m; };
  chk('conditioning on another market keeps the distribution centred on the pure fair margin', Math.abs(mean(c1) - mean(c2)) < 1.0, [mean(c1), mean(c2)]);
  /* NFL: the PMF is keyed by EdgeDesk's own fair spread — the market is not an input at all */
  const nfl = (t) => EF.dist.coverProbSpread('nfl', 3, t);
  chk('NFL cover depends only on the fair spread and the line', JSON.stringify(nfl(-2.5)) === JSON.stringify(EF.dist.coverProbSpread('nfl', 3, -2.5)));
}

section('7. best line, best price, best EV');
{
  const M = model({ fair: 1.3 });
  const quotes = [
    q('away', 7, -110, { book: 'A', n_books: 4 }),
    q('away', 6.5, -102, { book: 'B', n_books: 2 }),
    q('away', 7, -105, { book: 'C', n_books: 1 }),
    q('away', 7.5, -125, { book: 'D', n_books: 1 }),
    q('home', -7, -110, { book: 'A', n_books: 4 }), q('home', -6.5, -118, { book: 'B', n_books: 2 })
  ];
  const G = Q.evaluateGame(M, quotes, ctx());
  const S = G.sides.away;
  chk('main line is the number most books deal', S.main_line === 7);
  chk('best line is the most points (Book D +7.5)', S.best_line.sportsbook === 'D');
  chk('best price is the best odds at the main line (Book C −105)', S.best_price.sportsbook === 'C');
  chk('best EV is chosen by EV, not by the biggest number', S.best_ev.expected_value === Math.max(...S.quotes.filter((o) => o.ev_available && o.is_main_line).map((o) => o.expected_value)));
  chk('the game headline carries book, spread and odds of the best EV', G.best_ev_book === G.best_ev_quote.sportsbook && G.best_ev_spread === G.best_ev_quote.line && G.best_ev_odds === G.best_ev_quote.american_odds && near(G.best_ev_pct, G.best_ev_quote.expected_value_pct, 1e-9));
  const C = S.quotes.find((o) => o.sportsbook === 'C'), A = S.quotes.find((o) => o.sportsbook === 'A');
  chk('Book C beats Book A at the same number because the price is better', C.expected_value > A.expected_value);
  chk('headline is the best EV across BOTH sides', G.best_ev_quote === (G.sides.home.best_ev.expected_value > S.best_ev.expected_value ? G.sides.home.best_ev : S.best_ev));
}

section('8. the alternate ladder');
{
  const M = model({ fair: 1.3 });
  const alt = (line, price, book) => q('away', line, price, { market_type: 'alternate_spread', book: book || 'DK', n_books: 1 });
  const quotes = [q('away', 7, -110, { book: 'DK', n_books: 5 }), q('away', 7, -105, { book: 'MGM', n_books: 1 }), q('home', -7, -110, { n_books: 5 }),
    alt(10.5, -190), alt(9.5, -160), alt(8.5, -135), alt(7.5, -115), alt(6.5, 100), alt(5.5, 110), alt(4.5, 120), alt(3.5, 140), alt(7, -120, 'FD')];
  const G = Q.evaluateGame(M, quotes, ctx());
  const L = G.sides.away.ladder;
  chk('one ladder row per spread', L.rows.length === 9, L.rows.map((x) => x.spread));
  chk('rows ordered safest (most points) → most aggressive', L.rows.every((x, i, a) => i === 0 || x.spread < a[i - 1].spread));
  const r7 = L.rows.find((x) => x.spread === 7);
  chk('best price per spread (+7 at −105, MGM)', r7.best.sportsbook === 'MGM' && r7.best.american_odds === -105);
  chk('every other quote at the spread kept for audit', r7.quotes.length === 3);
  chk('a worse price at the same spread is dominated', r7.quotes.filter((o) => o !== r7.best).every((o) => o.dominated));
  chk('the frontier holds no dominated quote', L.frontier.every((o) => !o.dominated));
  chk('no frontier quote is beaten on both cover and EV', L.frontier.every((a) => !L.frontier.some((b) => b !== a && b.model_cover_probability >= a.model_cover_probability && b.expected_value > a.expected_value + 1e-9)));
  chk('MAX EV is the largest EV', L.max_ev.expected_value === Math.max(...G.sides.away.quotes.filter((o) => o.ev_available).map((o) => o.expected_value)));
  chk('SAFEST +EV has positive EV and the top cover among validated positive-EV quotes', !L.safest_positive_ev || (L.safest_positive_ev.expected_value > 0 && G.sides.away.quotes.filter((o) => o.ev_available && o.expected_value > 0 && o.tail.status !== 'NOT_VALIDATED' && !o.flags.some((f) => f.severity === 'HIGH')).every((o) => o.model_cover_probability <= L.safest_positive_ev.model_cover_probability + 1e-12)));
  chk('the main line is the best price at the consensus number', L.main && L.main.line === 7 && L.main.sportsbook === 'MGM');
  chk('no BEST BALANCE score is invented', L.best_balance === null && /No validated rule/.test(L.best_balance_note));
  chk('cover rises with every extra point on the ladder', L.rows.every((x, i, a) => i === 0 || x.best.model_cover_probability < a[i - 1].best.model_cover_probability));
  const st = L.steps.find((s) => /\+7 → \+7\.5/.test(s.text));
  chk('buying the half point: cover gain, juice cents, EV change', st && st.cover_gain_pp > 0 && st.juice_cents === 10 && typeof st.ev_change_pct === 'number', st);
  chk('the half point onto 7 names the key number with the model mass and the league share', st && st.key_numbers.length === 1 && st.key_numbers[0].abs_margin === 7 && st.key_numbers[0].key === 'primary' && st.key_numbers[0].historical_share === 0.0851 && st.key_numbers[0].model_mass > 0, st && st.key_numbers);
  {
    /* past ±1000 a cent is no unit of cost: −5000 → −10000 is 5000 cents for 1.0 pp of break-even */
    const Gx = Q.evaluateGame(model(), [q('away', 7, -110, { n_books: 5 }), q('away', 27.5, -5000, { market_type: 'alternate_spread' }), q('away', 28.5, -10000, { market_type: 'alternate_spread' })], ctx());
    const sx = Gx.sides.away.ladder.steps.find((s) => s.from_line === 28.5);
    chk('no juice cents between prices past ±1000, and the step text quotes none', sx && sx.juice_cents === null && !/cents/.test(sx.text) && sx.break_even_cost_pp > 0, sx);
    chk('cents stay quoted inside ±1000', Q.centsComparable(-110, -1000) && Q.centsComparable(865, 335) && !Q.centsComparable(-5000, -10000) && !Q.centsComparable(-110, null));
    const far = Gx.sides.away.quotes.find((o) => o.line === 28.5);
    chk('price advantage is not quoted in cents past ±1000', far.price_advantage_cents === null);
  }
  chk('protection value = extra cover − extra break-even', L.steps.every((s) => near(s.protection_value_pp, s.cover_gain_pp - s.break_even_cost_pp, 0.02)));
  chk('each step\'s verdict follows its EV change (EV counts the push; cover alone does not)', L.steps.length > 0 && L.steps.every((s) => s.protection_worth_it === (s.ev_change_pct > 0)
    && (s.ev_change_pct > 0 ? /priced below its model value/ : (s.ev_change_pct < 0 ? /costs more than the model says/ : /at its model value/)).test(s.text)), L.steps.map((s) => [s.ev_change_pct, s.text]));
  {
    /* a push-driven step: −23.5 +200 → −23 +178 where 5% of games land on 23 */
    const pmf = {}; for (let k = -40; k <= 22; k++) pmf[k] = 0.81 / 63; pmf[23] = 0.05; for (let k = 24; k <= 30; k++) pmf[k] = 0.14 / 7;
    const hc = (t) => { let win = 0, push = 0; Object.keys(pmf).forEach((kk) => { const k = +kk; if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; }); return { win, push, lose: 1 - win - push }; };
    const G2 = Q.evaluateGame(model({ extra: { home_cover: hc } }), [q('home', -23.5, 200, { n_books: 5 }), q('home', -23, 178, { market_type: 'alternate_spread' })], ctx());
    const s2 = G2.sides.home.ladder.steps[0];
    chk('a push-driven step reads by EV: cover alone says it costs more, the push makes EV rise', s2 && s2.protection_value_pp < 0 && s2.ev_change_pct > 0 && near(s2.push_change_pp, 5, 0.01)
      && s2.protection_worth_it === true && /plus 5\.0 pp push/.test(s2.text) && /priced below its model value/.test(s2.text), s2);
  }
  const t105 = G.sides.away.quotes.find((o) => o.line === 10.5);
  chk('a line 3.5 pts from the main line is outside a 3-pt validated tail', t105.tail.status === 'NOT_VALIDATED' && /TAIL CALIBRATION NOT VALIDATED/.test(t105.tail.label));
  const t85 = G.sides.away.quotes.find((o) => o.line === 8.5);
  chk('a line 1.5 pts away is inside it', t85.tail.status === 'VALIDATED');
  chk('the main line is the main line', G.sides.away.quotes.find((o) => o.line === 7 && o.sportsbook === 'MGM').tail.status === 'MAIN_LINE');
  const Mn = model({ fair: 1.3, within: 0 });
  const Gn = Q.evaluateGame(Mn, quotes, ctx());
  chk('with no alternate-line audit every alternate is LOW CONFIDENCE', Gn.sides.away.quotes.filter((o) => o.ev_available && o.line !== 7).every((o) => o.tail.status === 'NOT_VALIDATED'));
  /* the real tournament audit */
  const tour = require(path.join(ROOT, 'football', 'cfb_ev', 'artifacts', 'cfb_ev_calibration_v1', 'tournament.json'));
  const td = Q.tailDomain(tour.alternate_line_domain);
  chk('tail domain from the CFB alternate-line audit is ±3 pts (±7 fails the slope band)', td.validated_within_pts === 3, td);
  chk('no audit, no validated domain', Q.tailDomain(null).validated_within_pts === 0);
  /* a non-monotone distribution is caught */
  const bad = Object.assign(model(), { home_cover: (t) => (Math.abs(t - 5.5) < 1e-9 ? { win: 0.3, push: 0, lose: 0.7 } : normalCover(1.3, 14)(t)) });
  const GB = Q.evaluateGame(bad, [q('away', 5.5, 110, { market_type: 'alternate_spread' }), q('away', 6.5, 100, { market_type: 'alternate_spread' }), q('away', 7, -110, { n_books: 3 })], ctx());
  chk('cover that rises as the line worsens is flagged', GB.sides.away.ladder.flags.some((f) => f.code === 'COVER_NON_MONOTONE'), GB.sides.away.ladder.flags);
  const better = Q.evaluateGame(M, [q('away', 7, -115, { book: 'A', n_books: 3 }), q('away', 7.5, -110, { book: 'B', n_books: 1 })], ctx());
  chk('a better spread AND better odds at another book is flagged', better.sides.away.ladder.flags.some((f) => f.code === 'BETTER_LINE_AND_PRICE_ELSEWHERE'));
  const jump = Q.evaluateGame(M, [q('away', 7, -110, { n_books: 3 }), q('away', 7.5, 170, { market_type: 'alternate_spread' })], ctx());
  chk('a sharp EV discontinuity between adjacent half points is flagged', jump.sides.away.ladder.flags.some((f) => f.code === 'ALT_DISCONTINUITY'));
  const staleB = Q.evaluateGame(M, [q('away', 7, -110, { n_books: 3 }), q('away', 7, -102, { book: 'Z', fresh: false, freshness_state: 'STALE' })], ctx());
  chk('a better price that has gone stale is named, not used', staleB.sides.away.ladder.flags.some((f) => f.code === 'STALE_BETTER_PRICE') && staleB.sides.away.best_price.american_odds === -110);
  const far = Q.evaluateGame(M, [q('away', 7, -110, { n_books: 3 }), q('away', 30.5, -2000, { market_type: 'alternate_spread' })], ctx());
  chk('an implausible alternate is flagged', far.sides.away.ladder.flags.some((f) => f.code === 'ALT_IMPLAUSIBLE'));
}

section('9. sanity guards');
{
  const M = model({ fair: 1.3 });
  const hi = Q.priceQuote(M, q('away', 14.5, 300, { market_type: 'alternate_spread' }), ctx({ main_line_for_side: 7 }));
  chk('EV > +25% is flagged', hi.flags.some((f) => f.code === 'EV_OVER_25'));
  chk('an ordinary alternate over +35% is flagged', hi.flags.some((f) => f.code === 'ALT_EV_OVER_35'));
  const lo = Q.priceQuote(M, q('home', -14.5, -300), ctx({ main_line_for_side: -7 }));
  chk('EV < −50% is flagged', lo.flags.some((f) => f.code === 'EV_UNDER_NEG_50'), lo.expected_value);
  const big = Q.priceQuote(model({ fair: 20 }), q('home', -7, -110), ctx({ main_line_for_side: -7 }));
  chk('cover > 75% on a main spread is flagged', big.flags.some((f) => f.code === 'COVER_OVER_75'));
  const ctxRisk = ctx({ reliability: 40, qb_unresolved: true, market_stale: true, main_line_for_side: -7 });
  const rk = Q.priceQuote(model({ fair: 5 }), q('home', -1.5, -110), ctxRisk);
  chk('large EV with low reliability', rk.flags.some((f) => f.code === 'LARGE_EV_LOW_RELIABILITY'));
  chk('large EV with an unresolved QB', rk.flags.some((f) => f.code === 'LARGE_EV_QB_UNRESOLVED'));
  chk('large EV with a stale market', rk.flags.some((f) => f.code === 'LARGE_EV_STALE_MARKET'));
  const mf = Q.priceQuote(model({ fair: 5 }), q('home', -1.5, -110), ctx({ research_status: 'MARKET_FAULT' }));
  chk('large EV on a MARKET FAULT game', mf.flags.some((f) => f.code === 'LARGE_EV_MARKET_FAULT'));
  const pushHalf = Object.assign(model(), { home_cover: (t) => ({ win: 0.45, push: 0.05, lose: 0.5 }) });
  chk('a push on a half point is flagged', Q.priceQuote(pushHalf, q('away', 6.5, -110), ctx()).flags.some((f) => f.code === 'UNEXPECTED_PUSH'));
  const noPush = Object.assign(model(), { home_cover: (t) => ({ win: 0.45, push: 0, lose: 0.55 }) });
  chk('a whole-number line with no push is flagged', Q.priceQuote(noPush, q('away', 7, -110), ctx()).flags.some((f) => f.code === 'INTEGER_PUSH_MISSING'));
  const clean = Q.priceQuote(M, q('away', 7, -110), ctx({ main_line_for_side: 7 }));
  chk('a coherent quote raises no arithmetic flag', !clean.flags.some((f) => /MISMATCH|INCONSISTENT|SIGN/.test(f.code)), clean.flags);
}

section('10. decisions are per quote');
{
  const M = model();
  const main = Q.priceQuote(M, q('away', 7, -110, { book: 'DraftKings' }), ctx());
  const alt = Q.priceQuote(M, q('away', 10.5, -190, { book: 'DraftKings', market_type: 'alternate_spread' }), ctx());
  const eng = { status: 'PASS', reason: 'calibrated EV negative', evaluated_quote: { side: 'away', line: 7, book: 'DraftKings', team: 'Minnesota' } };
  chk('the evaluated quote carries the engine decision', Q.decisionFor(main, eng).status === 'PASS' && Q.decisionFor(main, eng).evaluated);
  chk('an alternate never inherits it', Q.decisionFor(alt, eng).status === 'NOT_EVALUATED' && /does not inherit/.test(Q.decisionFor(alt, eng).reason));
  const nd = Q.decisionFor(main, { status: 'NO_DECISION', requires: 'a fresh two-sided priced quote' });
  chk('NO DECISION from a missing market state is explained apart from the quote EV', nd.status === 'NOT_EVALUATED' && /quote-level EV above is arithmetic/.test(nd.reason) && main.ev_available);
  const un = Q.decisionFor(Q.priceQuote(M, q('away', 7, null), ctx()), eng);
  chk('no EV, no decision', un.status === 'NO_DECISION');
  /* the CFB decision engine states sides in capitals and carries the price it decided on */
  const engCaps = { status: 'PASS', reason: 'x', evaluated_quote: { side: 'AWAY', line: 7, book: 'draftkings', price: -110 } };
  chk('the engine\'s HOME / AWAY and a book in any case still name the same exact quote', Q.decisionFor(main, engCaps).status === 'PASS' && Q.decisionFor(main, engCaps).evaluated);
  const repriced = Q.priceQuote(M, q('away', 7, -105, { book: 'DraftKings' }), ctx());
  chk('the same number re-priced is another quote and inherits nothing', Q.decisionFor(repriced, engCaps).status === 'NOT_EVALUATED');
}

section('11. history');
{
  const M = model();
  const o = Q.priceQuote(M, q('away', 7, -110), ctx());
  const s = Q.freeze(o, { now: NOW, decision_status: 'PASS' });
  chk('the frozen snapshot is immutable', Object.isFrozen(s));
  chk('it carries line, price, book, probability, break-even, EV, fair odds and times', ['line', 'american_odds', 'sportsbook', 'model_cover_probability', 'break_even_probability', 'expected_value', 'model_fair_odds', 'projection_timestamp', 'model_version', 'captured_at'].every((k) => s[k] !== undefined && s[k] !== null));
  chk('snapshot id is stable', Q.freeze(o, { now: NOW, decision_status: 'PASS' }).snapshot_id === s.snapshot_id);
  chk('realized return: win at −110', near(Q.realizedReturn('win', D110), 0.9090909, 1e-6));
  chk('realized return: loss −1, push 0', Q.realizedReturn('loss', D110) === -1 && Q.realizedReturn('push', D110) === 0);
  chk('spread result: away +7, lose by 7 → push', Q.spreadResult('away', 7, 7) === 'push');
  chk('spread result: away +7, lose by 6 → win', Q.spreadResult('away', 7, 6) === 'win');
  chk('spread result: home −3.5, win by 3 → loss', Q.spreadResult('home', -3.5, 3) === 'loss');
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ expected_value: 0.12, model_cover_probability: 0.6, result: i % 2 ? 'win' : 'loss', decimal_odds: D110, clv_points: i % 4 ? 0.5 : -0.5 });
  rows.push({ expected_value: -0.03, model_cover_probability: 0.5, result: 'push', decimal_odds: D110, clv_points: 0 });
  const B = Q.evBuckets(rows);
  chk('the six spec buckets', B.map((b) => b.bucket).join('|') === 'EV < 0|0–2%|2–5%|5–10%|10–15%|15%+');
  const b10 = B.find((b) => b.key === '10_15');
  chk('bucket n, win rate, predicted, calibration error', b10.n === 40 && b10.win_rate === 0.5 && b10.avg_predicted_probability === 0.6 && near(b10.calibration_error, -0.1, 1e-9));
  chk('bucket ROI and realized return at the recorded price', near(b10.roi, (20 * (D110 - 1) - 20) / 40, 1e-4));
  chk('bucket CLV and positive-CLV rate', b10.avg_clv_points === 0.25 && b10.positive_clv_rate === 0.75);
  chk('a push counts as settled, not decided', B.find((b) => b.key === 'lt0').n_settled === 1 && B.find((b) => b.key === 'lt0').n_decided === 0);
  chk('small buckets are marked, not hidden', B.find((b) => b.key === 'lt0').sufficient_n === false);
}

section('12. parity with the other implementations');
{
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const w = 0.05 + 0.85 * ((i * 7919) % 1000) / 1000, pu = (i % 5 === 0) ? 0.03 : 0, l = Math.max(0, 1 - w - pu);
    const a = [-300, -180, -125, -110, -105, 100, 110, 145, 220, 400][i % 10];
    if (w + pu > 1) continue;
    const d = Q.americanToDecimal(a);
    const mine = Q.expectedValue(w, pu, l, d);
    if (!near(mine, R.expectedRoi(w, a, pu), 1e-12)) bad++;
    if (!near(mine, EV.twoWayEv(w, pu, EV.americanToDecimal(a)), 1e-9)) bad++;
    if (!near(d, 1 + DEC.americanToPayout(a), 1e-12)) bad++;
  }
  chk('EV matches research_core, edgedesk_ev and decision.js on 200 cases', bad === 0, bad);
  /* the champion's conditioned curve: the shared function is the one build.js used */
  const P = window.EDCfbP4Params, D = P.distributions, base = (P.volatility && P.volatility.sigma_base) || D.sigma_margin;
  function original(fair, condMargin, sigma, sigmaBase) {              /* the pre-move build.js v1CoverConditioned, verbatim */
    const tab = D.margin_pmf_by_spread, rng = D.pmf_spread_range;
    if (condMargin == null || !tab || !rng || condMargin < rng[0] || condMargin > rng[1]) return null;
    let key = (Math.round(condMargin * 2) / 2).toFixed(1); if (key === '-0.0') key = '0.0';
    const pmf = tab[key] || tab[Math.round(condMargin).toFixed(1)]; if (!pmf) return null;
    const es = Object.keys(pmf).map((k) => [parseInt(k, 10), pmf[k]]).sort((a, b) => a[0] - b[0]);
    let em = 0, ew = 0; es.forEach((e) => { em += e[0] * e[1]; ew += e[1]; });
    const shift = ew > 0 ? Math.round(fair - em / ew) : 0, stretch = (sigma && sigmaBase && sigmaBase > 0) ? sigma / sigmaBase : 1;
    const pts = es.map((e) => { const m = e[0] + shift; let w = e[1]; if (Math.abs(stretch - 1) >= 0.02) { const z0 = (m - fair) / (sigmaBase || 1), z1 = (m - fair) / (sigma || 1); w = e[1] * Math.exp(-0.5 * (z1 * z1 - z0 * z0)) / stretch; } return [m, w]; });
    const tot = pts.reduce((s, x) => s + x[1], 0); if (!(tot > 0)) return null;
    return (t) => { let win = 0, push = 0; pts.forEach((x) => { if (Math.abs(x[0] - t) < 1e-9) push += x[1]; else if (x[0] > t) win += x[1]; }); return { win: win / tot, push: push / tot, lose: 1 - (win + push) / tot }; };
  }
  let diff = 0, n = 0;
  [[1.3, 6.5, 14.9], [-8.2, -10, 17], [21, 17.5, 12], [0.4, 0, base], [-3, 3, 20]].forEach(([f, c, s]) => {
    const A = Q.cfbConditionedCover(D, f, c, s, base), B = original(f, c, s, base);
    for (let t = -40; t <= 40; t += 0.5) { const a = A(t), b = B(t); n++; if (a.win !== b.win || a.push !== b.push || a.lose !== b.lose) diff++; }
  });
  chk('cfbConditionedCover is byte-identical to the pre-move build.js function (' + n + ' thresholds)', diff === 0, diff);
  const c = Q.cfbConditionedCover(D, 1.3, 6.5, 14.9, base)(6.5), e = E1.dist.coverProbSpread(1.3, 6.5, 14.9, base);
  chk('at the market margin it reproduces the engine’s own cover probability', near(c.win, e.win, 1e-12) && near(c.push, e.push, 1e-12));
  /* the Read's curve lookup and this module agree on a side's probabilities */
  const cov = normalCover(2, 15), curve = RD.buildCurve(cov, -3, 30);
  let rdBad = 0;
  [[-3.5, 'home'], [3.5, 'away'], [-7, 'home'], [7, 'away'], [2.5, 'home'], [-10.5, 'away']].forEach(([L, s]) => {
    const a = RD.sideProb(curve, s, L), b = Q.sideProb(cov, s, L);
    if (!near(a.win, b.win, 2e-6) || !near(a.push, b.push, 2e-6) || !near(a.cover, b.cover, 5e-6)) rdBad++;
  });
  chk('side probabilities match lib/edgedesk_read.js sideProb', rdBad === 0, rdBad);
}

section('13. totals and moneylines wait for validation');
{
  const M = Object.assign(model(), { total_cover: (t) => ({ win: t < 50 ? 0.55 : 0.45, push: 0, lose: t < 50 ? 0.45 : 0.55 }), total_calibration: { validated: false, reason: 'pricing tier RESEARCH' },
    moneyline: { home_win_prob: 0.61, calibration: { validated: false, reason: 'no validated win-probability calibration' } } });
  const t = Q.priceQuote(M, q('over', 48.5, -110, { market_type: 'total' }), ctx());
  chk('TOTAL EV unavailable · probability calibration not validated', !t.ev_available && t.ev_unavailable_code === 'CALIBRATION' && /probability calibration not validated/.test(t.ev_unavailable_reason));
  const m = Q.priceQuote(M, q('home', null, -125, { market_type: 'moneyline' }), ctx());
  chk('moneyline EV unavailable until the win probability is calibrated', !m.ev_available && m.ev_unavailable_code === 'CALIBRATION');
  const MV = Object.assign({}, M, { total_calibration: { validated: true }, moneyline: { home_win_prob: 0.61, calibration: { validated: true } } });
  const tv = Q.priceQuote(MV, q('over', 48.5, -110, { market_type: 'total' }), ctx());
  chk('a validated totals distribution prices Over/Under at the exact total', tv.ev_available && near(tv.model_win_probability, 0.55, 1e-9));
  const mv = Q.priceQuote(MV, q('home', null, -125, { market_type: 'moneyline' }), ctx());
  chk('moneyline EV at 61% vs −125 is +9.8% (spec example)', mv.ev_available && (100 * mv.expected_value).toFixed(1) === '9.8' && (100 * mv.break_even_probability).toFixed(1) === '55.6', mv);
}

section('14. audit 2026-09-30: the EV is priced from the displayed projection, and an implausible EV is data to check');
{
  /* #4 root cause: the NFL margin pmf is keyed by spread and its centre sits
     inside its key (key 9.0: median 6.94), so a model at SEA -9.2 was priced
     from a distribution centred at SEA -6.9 and LAC +7 came out +EV. The
     table is now read BY its median, so the distribution's median IS the
     displayed fair margin. */
  const medOf = (fair) => Q.distributionCentre((t) => EF.dist.coverProbSpread('nfl', fair, t)).median;
  const fairs = [-11.5, -9.24, 9.24, 7.97, 3, 0.8, -13.9, 6.25, 13, -2];
  chk('NFL: the priced distribution\'s median is the fair margin exactly (inside, mirrored and past the table)', fairs.every((f) => near(medOf(f), f, 1e-3)), fairs.map((f) => [f, medOf(f)]));
  const sides = [[-11.5, 10], [9.24, -7], [-9.24, 7], [2.2, -1.5], [-2.9, 2.5], [6.9, -6.5], [12.6, -12]];
  chk('NFL: a projection 0.4+ pts past the line on one side covers it more than half the time (the side rule holds by construction)',
    sides.every(([f, hl]) => { const X = f > -hl ? 'home' : 'away'; const p = Q.sideProb((t) => EF.dist.coverProbSpread('nfl', f, t), X, X === 'home' ? hl : -hl); return p.cover > 0.5; }), sides);
  chk('NFL: the spikes stay on the numbers games end on — an away favourite by 9.2 keeps its mass at -3 and -7 (mirrored table)', EF.dist.coverProbSpread('nfl', -9.24, -3).push > 0.06 && EF.dist.coverProbSpread('nfl', -9.24, -7).push > 0.05 && /mirrored/.test(EF.dist.coverProbSpread('nfl', -9.24, 3).method));
  chk('NFL: integer margins stay integral — a half-point line never pushes', fairs.every((f) => EF.dist.coverProbSpread('nfl', f, 6.5).push === 0 && EF.dist.coverProbSpread('nfl', f, 2.5).push === 0));
  const c9 = EF.dist.coverProbSpread('nfl', 9.24, 7);
  chk('NFL: the key-number shape is kept (a push at 7 keeps real mass) and the basis still names the table', c9.push > 0.05 && c9.basis === 'margin_pmf_by_spread' && near(c9.centred_on, 9.24) && c9.method === 'median_matched', c9);
  /* the audit game: LAC @ SEA, model SEA -9.24, market SEA -7 at -110 both sides */
  const nflM = (fair, cover) => ({ sport: 'NFL', available: true, model_version: 'edgedesk_football_v1.0.0', fair_home_margin: fair, home_cover: cover || ((t) => EF.dist.coverProbSpread('nfl', fair, t)), tail: { validated_within_pts: 0 } });
  const SEA = { game_id: 's1', home: 'Seattle Seahawks', away: 'Los Angeles Chargers' };
  const sq = (side, line, am, extra) => Object.assign({ game_id: 's1', side, line, american: am, book: 'DraftKings', captured_at: FRESH, fresh: true, n_books: 3 }, extra || {});
  const G = Q.evaluateGame(nflM(9.24), [sq('home', -7, -110), sq('away', 7, -110)], ctx({ game: SEA }));
  const lac = G.sides.away.quotes[0], sea = G.sides.home.quotes[0];
  chk('LAC @ SEA: the side the model is against (LAC +7) no longer prices +EV; SEA -7 does', lac.expected_value < 0 && sea.expected_value > 0, [lac.expected_value_pct, sea.expected_value_pct]);
  chk('…and the side invariant is checked and holds', G.side_invariant && G.side_invariant.checked && G.side_invariant.ok && G.side_invariant.model_side === 'home', G.side_invariant);
  /* the invariant fails LOUDLY when the projection feeding EV is not the displayed one */
  const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' '));
  let Gx; try { Gx = Q.evaluateGame(nflM(9.24, (t) => EF.dist.coverProbSpread('nfl', 5, t)), [sq('home', -7, -110), sq('away', 7, -110)], ctx({ game: SEA })); } finally { console.error = ce; }
  chk('a displayed SEA -9.2 priced from a SEA -5 distribution fails the invariant (the projection feeding EV is not the displayed one)', Gx.side_invariant && Gx.side_invariant.ok === false && Gx.side_invariant.kind === 'PROJECTION_MISMATCH' && /EV SIDE CONTRADICTION/.test(Gx.side_invariant.reason), Gx.side_invariant);
  /* the pre-fix engine, reproduced: the table keyed 9.0 read as-is (mean 7.97) under a displayed SEA -9.24 */
  const tab = window.EDFootballParams.nfl.margin_pmf_by_spread['9.0'];
  const oldCover = (t) => { let w = 0, p = 0, tot = 0; Object.keys(tab).forEach((k) => { const m = parseInt(k, 10), v = tab[k]; tot += v; if (m === t) p += v; else if (m > t) w += v; }); return { win: w / tot, push: p / tot, lose: 1 - (w + p) / tot }; };
  let Gold; console.error = () => {};
  try { Gold = Q.evaluateGame(nflM(9.24, oldCover), [sq('home', -7, -110), sq('away', 7, -110)], ctx({ game: SEA })); } finally { console.error = ce; }
  chk('the self-check would have caught the audit: the pre-fix table under SEA -9.24 is centred 2.3 pts off the displayed projection', Gold.side_invariant.ok === false && Gold.side_invariant.kind === 'PROJECTION_MISMATCH' && Gold.side_invariant.mean_check.off_pts > 2, Gold.side_invariant.mean_check);
  /* a raw side violation with the distribution centred right: a plus-money price on the side the model is against */
  let Gp; console.error = () => {};
  try { Gp = Q.evaluateGame(nflM(9.24), [sq('home', -7, -110), sq('away', 7, 150)], ctx({ game: SEA })); } finally { console.error = ce; }
  chk('the side rule itself: SEA -9.2 displayed, yet LAC +7 (+150) is +EV at the same number — flagged (kind SIDE)', Gp.side_invariant.ok === false && Gp.side_invariant.kind === 'SIDE' && Gp.side_invariant.model_side === 'home', Gp.side_invariant);
  /* a key number: model 0.6 past a +2.5 dog — with the median-centred table the dog now covers, so the rule applies (no abstention) */
  const PIT = { game_id: 's1', home: 'Cleveland Browns', away: 'Pittsburgh Steelers' };
  const Gk = Q.evaluateGame(nflM(-1.9), [sq('home', 2.5, -110), sq('away', -2.5, -105)], ctx({ game: PIT }));
  chk('at a key number the side rule applies and holds (the median-centred table has the dog covering)', Gk.side_invariant.ok && !Gk.side_invariant.ambiguous && Gk.side_invariant.model_side === 'home' && Gk.side_invariant.mean_check.off_pts < 1e-3, Gk.side_invariant);
  /* a curve whose median is off the displayed number but whose sport is not checked by centre (college): the side rule abstains where ambiguous */
  const Gc2 = Q.evaluateGame(Object.assign(model({ fair: 7.3 }), { home_cover: normalCover(5.5, 14) }), [q('home', -6.5, -110), q('away', 6.5, -110)], ctx());
  chk('a college curve off its displayed number is not centre-checked; the side rule abstains where the curve itself disagrees, and says so', Gc2.side_invariant.ok && Gc2.side_invariant.ambiguous === true && Gc2.side_invariant.mean_check.checked === false, Gc2.side_invariant);
  chk('…raises a HIGH flag and logs an error (fail loudly)', Gx.flags.some((f) => f.code === 'EV_SIDE_CONTRADICTION' && f.severity === 'HIGH') && errs.length > 0, [Gx.flags.map((f) => f.code), errs.length]);
  let Gc; console.error = (...a) => errs.push(a.join(' '));
  try { Gc = Q.evaluateGame(Object.assign(nflM(9.24), { adjusted: { available: true, label: 'BLENDED', version: 't', maturity: 'SHADOW', side_prob: (sd, l) => Q.sideProb((t) => EF.dist.coverProbSpread('nfl', 5, t), sd, l) } }), [sq('home', -7, -110), sq('away', 7, -110)], ctx({ game: SEA })); } finally { console.error = ce; }
  chk('…a CALIBRATED probability on the other side of the line fails it too (kind SIDE)', Gc.side_invariant && Gc.side_invariant.ok === false && Gc.side_invariant.kind === 'SIDE' && /calibrated/.test(Gc.side_invariant.reason), Gc.side_invariant);
  const Gin = Q.evaluateGame(nflM(7.3), [sq('home', -7, -110), sq('away', 7, 120)], ctx({ game: SEA }));
  chk('inside half a point the check does not apply (the shape at a key number decides)', Gin.side_invariant && Gin.side_invariant.ok && Gin.side_invariant.model_side == null, Gin.side_invariant);
  const Galt = Q.evaluateGame(nflM(9.24), [sq('home', -7, -110), sq('away', 7, -110), sq('away', 10.5, -250, { market_type: 'alternate_spread', n_books: 1 })], ctx({ game: SEA }));
  chk('a better number on the other side (LAC +10.5) may price +EV without breaking the invariant', Galt.side_invariant.ok, Galt.side_invariant);

  /* #8, σ-scaled in the follow-up: a main-line spread is implausible when it
     sits more than PLAUSIBLE_Z widths of the game's own distribution from the
     model; a large EV at a plausible gap is a LARGE EV (the decision layer's
     stake brake), never "check data" */
  const sd14 = Q.distributionSpread(normalCover(-2, 14));
  chk('the width the bound is measured in is the distribution\'s own (σ 14 reads 14.0)', near(sd14, 14, 0.05), sd14);
  const big = Q.evaluateGame(model({ fair: -8 }), [q('away', 6.5, -102), q('home', -6.5, -118)], ctx());
  chk('a main line 14.5 pts from the model (1.04 σ, past the 0.96 bound) is IMPLAUSIBLE: "implausible EV, check data", flagged, σ-scaled',
    big.implausible_ev && big.implausible_ev.basis === 'sigma_scaled' && big.implausible_ev.z > Q.PLAUSIBLE_Z.CFB && /^implausible EV, check data/.test(big.implausible_ev.reason)
      && big.flags.some((f) => f.code === 'IMPLAUSIBLE_EV'), big.implausible_ev);
  const wide = Q.evaluateGame(model({ fair: -2 }), [q('away', 6.5, -102), q('home', -6.5, -118)], ctx());
  chk('+30% raw EV at an 8.5-pt gap (0.61 σ) is NOT implausible — the flat 25% bound called it a data error — but it is a LARGE EV',
    wide.implausible_ev === null && wide.sides.away.quotes[0].expected_value > 0.25 && wide.large_ev && wide.large_ev.raw_ev > 0.25, [wide.implausible_ev, wide.large_ev]);
  const ok = Q.evaluateGame(model({ fair: 2.5 }), [q('away', 6.5, -102), q('home', -6.5, -118)], ctx());
  chk('+21% raw is neither implausible nor large', ok.implausible_ev === null && ok.large_ev === null && ok.sides.away.quotes[0].expected_value > 0.2, [ok.implausible_ev, ok.sides.away.quotes[0].expected_value]);
  const alt = Q.evaluateGame(model({ fair: -8 }), [q('away', 6.5, -102), q('home', -6.5, -118), q('away', 20.5, 150, { market_type: 'alternate_spread' })], ctx());
  chk('an ALTERNATE is not the main-line check\'s business (the tail rules own it)', alt.implausible_ev && alt.implausible_ev.line !== 20.5, alt.implausible_ev);
  const other = Q.evaluateGame(Object.assign(model({ fair: -2 }), { sport: 'XFL' }), [q('away', 6.5, -102), q('home', -6.5, -118)], ctx());
  chk('a sport with no fitted bound falls back to the flat 25% raw EV, and says so', other.implausible_ev && other.implausible_ev.basis === 'flat_fallback' && /fallback bound/.test(other.implausible_ev.reason));
  const EVP = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'ev_plausibility.json'), 'utf8'));
  chk('the bounds are the fitted ones (football/validation/ev_plausibility.json z*, q 0.995, fit 2021-2023)',
    Q.PLAUSIBLE_Z.CFB === EVP.cfb.z_star && Q.PLAUSIBLE_Z.NFL === EVP.nfl.z_star && EVP.rules.q === 0.995 && EVP.cfb.fit_seasons === '2021-2023' && EVP.market_is_an_input === false, [Q.PLAUSIBLE_Z, EVP.cfb.z_star, EVP.nfl.z_star]);
  chk('…and on its 2024-2025 holdout the bound flags under 1% of real games and leaves VERIFIED MAJOR reachable on 90%+ of real 7+ gaps, where the flat bound flagged ~20% and left almost none',
    EVP.cfb.holdout.new_bound.false_positive_rate < 0.01 && EVP.cfb.holdout.new_bound.major_gaps_reachable > 0.9 && EVP.cfb.holdout.old_flat_25pct.false_positive_rate > 0.15
      && EVP.cfb.holdout.old_flat_25pct.major_gaps_reachable < 0.1 && EVP.nfl.holdout.new_bound.major_gaps_reachable > 0.9);
  chk('the fallback constant is still exported (25%)', Q.IMPLAUSIBLE_RAW_EV === 0.25);

  /* VERIFIED MAJOR IS REACHABLE: a game that passes every gate with a 7+ gap on
     a stable roster, priced from the shipped college distribution at −110 */
  const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
  const PP = global.window.EDCfbP4Params;
  [7, 7.5, 9, 11].forEach((gap) => {
    const fair = 10 + gap, hc = Q.cfbConditionedCover(PP.distributions, fair, 10, 14.84, 14.633);
    const Gm = Q.evaluateGame({ sport: 'CFB', available: true, model_version: 't', projection_timestamp: FRESH, fair_home_margin: fair, home_cover: hc, tail: { validated_within_pts: 0 } },
      [q('home', -10, -110, { n_books: 6 }), q('away', 10, -110, { n_books: 6 })], ctx());
    const stv = C.researchStatus({ projected: true, market: 'FRESH', gap, verification: 'VERIFIED', confidence: 75, reliability: 85,
      fair_margin: fair, market_margin: 10, regime: null, implausible_ev: Gm.implausible_ev });
    chk('a verified ' + gap + '-pt gap on a stable roster, every gate passed, at −110 (+' + (100 * Gm.best_ev_quote.expected_value).toFixed(0) + '% raw EV) reads VERIFIED MAJOR',
      stv.key === 'VERIFIED_MAJOR' && Gm.implausible_ev === null && Gm.large_ev !== null, [stv.key, stv.rule, Gm.implausible_ev]);
  });
  const G16 = Q.evaluateGame({ sport: 'CFB', available: true, model_version: 't', projection_timestamp: FRESH, fair_home_margin: 26, home_cover: Q.cfbConditionedCover(PP.distributions, 26, 10, 14.84, 14.633), tail: { validated_within_pts: 0 } },
    [q('home', -10, -110, { n_books: 6 }), q('away', 10, -110, { n_books: 6 })], ctx());
  const s16 = C.researchStatus({ projected: true, market: 'FRESH', gap: 16, verification: 'VERIFIED', confidence: 75, reliability: 85, fair_margin: 26, market_margin: 10, implausible_ev: G16.implausible_ev });
  chk('…and a 16-pt gap (past z* at this σ) is still INVESTIGATE "implausible EV, check data", even verified', s16.key === 'INVESTIGATE' && s16.rule === 'implausible_ev', [s16.key, s16.rule]);
  const nflFair = 10, G7 = Q.evaluateGame(nflM(nflFair), [sq('home', -3, -110), sq('away', 3, -110)], ctx({ game: SEA }));
  const s7 = C.researchStatus({ projected: true, market: 'FRESH', gap: 7, verification: 'VERIFIED', confidence: 75, reliability: 85, fair_margin: nflFair, market_margin: 3, implausible_ev: G7.implausible_ev });
  chk('NFL too: a verified 7-pt gap at −110 reads VERIFIED MAJOR', s7.key === 'VERIFIED_MAJOR' && G7.implausible_ev === null, [s7.key, G7.implausible_ev]);
}

section('15. one CFB distribution: the app’s ladder is the terminal’s curve, whatever the market');
{
  /* app.html fbQevModelCfb, lifted VERBATIM (brace-matched by name, never
     re-typed) and run beside football/cfb_terminal/build.js v1Dist. Its two
     neighbours only feed the calibrated layer and the moneyline, never
     home_cover, so they are stubbed. */
  const vm = require('vm');
  const B = require(path.join(ROOT, 'football', 'cfb_terminal', 'build.js'));
  const EVP_T = require(path.join(ROOT, 'tools', 'football', 'ev_plausibility.js'));
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const extract = (name) => {
    const i = APP.indexOf('function ' + name + '('); if (i < 0) throw new Error('app.html has no function ' + name);
    for (let k = APP.indexOf('{', i), d = 0; k < APP.length; k++) { if (APP[k] === '{') d++; else if (APP[k] === '}' && --d === 0) return APP.slice(i, k + 1); }
    throw new Error('unbalanced ' + name);
  };
  const P = window.EDCfbP4Params, D = P.distributions, base = (P.volatility && P.volatility.sigma_base) || D.sigma_margin;
  const sb = { Math, isFinite, FBQEV: {}, window: { EDQuoteEV: Q, EDCfbP4Params: P, EDCfbP4: E1 },
    fbQevCalReason: () => ({ validated: false, reason: 'stub' }), fbQevAdjustedCfb: () => ({ available: false, reason: 'stub' }) };
  vm.createContext(sb);
  vm.runInContext(extract('fbQevModelCfb'), sb);
  /* mk.spread_line is a HOME MARGIN (fbMarketFromEvent: home −52.5 → +52.5), the terminal's _consMargin */
  const app = (fair, sigma, mk) => sb.fbQevModelCfb({}, { status: 'PREDICTED', model: { fair_spread: fair, fair_total: null, home_win_prob: 0.5 }, layers: { uncertainty: { sigma: sigma, sigma_base: base } } }, mk, null);
  const TS = []; for (let t = -70; t <= 100; t += 0.5) TS.push(t);
  const same = (a, b) => TS.every((t) => { const x = a(t), y = b(t); return x.win === y.win && x.push === y.push && x.lose === y.lose; });
  const firstRise = (c) => { for (let i = 1; i < TS.length; i++) { const p = c(TS[i - 1]), n = c(TS[i]); if (n.win > p.win + 1e-12 || n.win + n.push > p.win + p.push + 1e-12) return TS[i]; } return null; };
  /* McNeese @ LSU, 2026-10-02: LSU −52.5 (home margin +52.5), fair +41.42 — the market past the table's +45 edge */
  const L = app(41.42, 14.9, { spread_line: 52.5 }), T = B.v1Dist(41.42, 14.9, 52.5);
  chk('McNeese @ LSU (LSU −52.5, outside the ±45 table): the app’s distribution IS the terminal’s v1Dist curve, at every half point −70…+100', L.available && T.pmf_row === 45 && same(L.home_cover, T.cover));
  chk('… and it is monotone: P(M > t) and P(M ≥ t) never rise with t', firstRise(L.home_cover) === null, firstRise(L.home_cover));
  const old = (t) => E1.dist.coverProbSpread(41.42, t, 14.9, base);
  chk('… where the per-line engine call it replaces was not (P(M > 18.5) ' + old(18.5).win.toFixed(4) + ' > P(M > 18) ' + old(18).win.toFixed(4) + ')', old(18.5).win > old(18).win && firstRise(old) !== null);
  chk('… priced on the ladder the same: both sides at every alternate the terminal would price', [-60.5, -52.5, -45, -41.5, -28, -17.5].every((hl) => ['home', 'away'].every((s) => {
    const a = Q.sideProb(L.home_cover, s, s === 'home' ? hl : -hl), b = Q.sideProb(T.cover, s, s === 'home' ? hl : -hl); return a.win === b.win && a.push === b.push && a.loss === b.loss; })));
  chk('… and says it read the table’s edge, not the market', /table’s edge \(home margin \+45\.0, the row nearest the market at \+52\.5\)/.test(L.basis), L.basis);
  const M = app(-41.42, 14.9, { spread_line: -52.5 }), Tm = B.v1Dist(-41.42, 14.9, -52.5);
  chk('the mirror (an away favourite past −45) reads the −45 edge in both, and is monotone', Tm.pmf_row === -45 && same(M.home_cover, Tm.cover) && firstRise(M.home_cover) === null);
  chk('a market at +45.5 reads the same shape as one at +45 (continuous across the edge)', same(app(40, 14.9, { spread_line: 45.5 }).home_cover, app(40, 14.9, { spread_line: 45 }).home_cover));
  chk('a market INSIDE the table is untouched: the shape is conditioned on the market itself, as before', same(app(1.3, 14.9, { spread_line: 6.5 }).home_cover, B.v1Dist(1.3, 14.9, 6.5).cover)
    && same(app(1.3, 14.9, { spread_line: 6.5 }).home_cover, Q.cfbConditionedCover(D, 1.3, 6.5, 14.9, base)) && /as the engine conditions it/.test(app(1.3, 14.9, { spread_line: 6.5 }).basis));
  /* no market, or one the orientation check dropped: the fair margin, clamped the same way */
  const N = [[41.42, 14.9], [55.2, 15.4], [-3.1, 14.7]].map(([f, s]) => ({ f, s, a: app(f, s, {}), t: B.v1Dist(f, s, null), x: app(f, s, { spread_line: 52.5, spread_fault: 'opposite convention' }) }));
  chk('with NO market (or a faulted one) the app conditions on the fair margin clamped to the table, as the terminal does (+41.4, +55.2 past the edge, −3.1)',
    N.every((n) => same(n.a.home_cover, n.t.cover) && same(n.x.home_cover, n.t.cover) && firstRise(n.a.home_cover) === null) && N[1].t.pmf_row === 45, N.map((n) => n.t.pmf_row));
  chk('… and never calls that a market', N.every((n) => /no market spread to condition it on/.test(n.a.basis)) && /table’s edge, home margin \+45\.0/.test(N[1].a.basis), N[1].a.basis);
  chk('the shared row is the terminal’s: cfbPmfRow clamps the market (or the fair margin) to pmf_spread_range',
    Q.cfbPmfRow(D, 41.42, 52.5) === 45 && Q.cfbPmfRow(D, -41.42, -52.5) === -45 && Q.cfbPmfRow(D, 1.3, 6.5) === 6.5 && Q.cfbPmfRow(D, 55.2, null) === 45 && Q.cfbPmfRow(D, -3.1, null) === -3.1 && Q.cfbPmfRow(D, null, null) === null);
  /* the EV plausibility bound measures z in the width of the SAME distribution */
  const ms = EVP_T.measure('CFB', { fair: 41.42, sigma: 14.9, sigma_base: base }, 52.5);
  chk('tools/football/ev_plausibility.js measures an out-of-table market in the width of the terminal’s curve', ms && ms.sd === Q.distributionSpread(T.cover), [ms && ms.sd, Q.distributionSpread(T.cover)]);
  chk('app.html fetches the quote-EV module under one cache-busting version everywhere it loads it',
    (() => { const v = APP.match(/fbScript\('lib\/edgedesk_quote_ev\.js[^']*'\)/g) || []; return v.length >= 2 && v.every((s) => s === v[0]) && /\?v=\d{8}[a-z]*'/.test(v[0]); })());
}

console.log('\n' + (fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
