#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_props.js — the prop kernel, case by case.

   Odds (positive and negative American, fair odds, no-vig, EV at the EXACT
   price — never −110), every distribution family (mass, means, pushes on whole
   lines only, widening keeps the mean), quote hygiene (impossible prices,
   duplicates, conflicting duplicates, broken two-way holds, stale and future
   captures, one-sided markets, books that disagree on the line), price
   shopping (a worse line at a better price can win), the decision layer
   (BET / LEAN / WATCH / PASS / NO DECISION and every cap), units (source cap,
   quarter-Kelly, single book, rounded down), history kept apart from
   probability, settlement (win / loss / push / void, a player who did not
   play), CLV (only with a close), calibration buckets and promotion, and
   parity with lib/edgedesk_decision.js.

   Run: node tools/props/props_core.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
require(path.join(ROOT, 'lib', 'edgedesk_vocab.js'));
require(path.join(ROOT, 'lib', 'edgedesk_market.js'));
const D = require(path.join(ROOT, 'lib', 'edgedesk_decision.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t == null ? 1e-6 : t);
function section(t) { console.log('— ' + t); }

/* ------------------------------------------------------------------ odds */
section('odds');
chk('+150 → decimal 2.5', near(E.toDecimal(150), 2.5));
chk('−150 → decimal 1.6667', near(E.toDecimal(-150), 1 + 100 / 150));
chk('+100 and −100 are both even money', near(E.toDecimal(100), 2) && near(E.toDecimal(-100), 2));
chk('a price inside (−100, +100) is not a price', E.toDecimal(50) === null && E.toDecimal(-99) === null);
chk('implied of −110 is 52.38%', near(E.implied(-110), 0.5238095, 1e-6));
chk('fair odds of 58.7% is −142', E.fairAmerican(0.587, 0) === -142, E.fairAmerican(0.587, 0));
chk('fair odds of 40% is +150', E.fairAmerican(0.40, 0) === 150);
chk('fair odds are push-aware (win 50%, push 10% → −125)', E.fairAmerican(0.5, 0.1) === -125, E.fairAmerican(0.5, 0.1));
chk('EV: 58% at +100 is +16%', near(E.expectedValue(0.58, 100, 0), 0.16));
chk('EV at −105 differs from EV at −110 (exact price, never assumed)', !near(E.expectedValue(0.55, -105, 0), E.expectedValue(0.55, -110, 0), 1e-4));
chk('EV with a push returns the stake', near(E.expectedValue(0.5, 100, 0.2), 0.5 * 1 - 0.3));
const nv = E.noVig(-110, -110);
chk('no-vig of −110 / −110 is 50 / 50', near(nv.over, 0.5) && near(nv.under, 0.5));
chk('no-vig of −130 / +110 sums to 1 and favours the −130 side', near(E.noVig(-130, 110).over + E.noVig(-130, 110).under, 1) && E.noVig(-130, 110).over > 0.5);
chk('priceBetter: +105 beats −110, −105 beats −110', E.priceBetter(105, -110) && E.priceBetter(-105, -110) && !E.priceBetter(-115, -110));
chk('the price ladder crosses even money one cent at a time', E.stepPrice(-101, 1) === 100 && E.stepPrice(100, 1) === 101 && E.stepPrice(100, -1) === -101 && E.stepPrice(-110, 5) === -105 && E.stepPrice(105, -10) === -105);

/* --------------------------------------------------------- distributions */
section('distributions');
const fams = {
  normal: { family: 'normal', mu: 72.4, sigma: 28 },
  poisson: { family: 'poisson', lambda: 1.3 },
  negbin: { family: 'negbin', mean: 5.2, size: 14 },
  gcomp: { family: 'gcomp', n: { family: 'negbin', mean: 16, size: 20 }, a: 1.88, theta: 4.4, shift: 4 },
  maxcomp: { family: 'maxcomp', n: { family: 'poisson', lambda: 5 }, a: 1.4, theta: 8, shift: 0 },
  bernoulli: { family: 'bernoulli', p: 0.18 },
  lognormal: { family: 'lognormal', mu: 2.8, sigma: 0.45, shift: 3 }
};
E.registerShape('test.rush', { x: [-5, -2, 0, 2, 4, 6, 10, 15, 25, 40, 60], p: [0.01, 0.06, 0.15, 0.35, 0.55, 0.7, 0.86, 0.94, 0.985, 0.997, 0.9995], mean: 4.3, n: 1000 });
fams.maxemp = { family: 'maxemp', n: { family: 'negbin', mean: 15, size: 20 }, shape: 'test.rush', scale: 1.05, shift: 4 };
fams.conv = { family: 'conv', parts: [fams.gcomp, { family: 'gcomp', n: { family: 'negbin', mean: 3, size: 25 }, a: 1.2, theta: 6.5, shift: 1 }] };
Object.keys(fams).forEach((k) => {
  const d = fams[k];
  chk(k + ' is a valid distribution', E.validDist(d));
  let mass = 0; for (let y = -60; y <= 700; y++) mass += E.pmfInt(d, y);
  chk(k + ' carries all its probability mass', near(mass, 1, 2e-4), mass);
  const pr = E.probLine(d, 5.5);
  chk(k + ' over + under = 1 on a half line (no push)', near(pr.over + pr.under, 1, 1e-9) && pr.push === 0);
  const pw = E.probLine(d, 5);
  chk(k + ' over + under + push = 1 on a whole line', near(pw.over + pw.under + pw.push, 1, 1e-9));
  const s = E.summary(d);
  chk(k + ' quantiles are ordered', s.p10 <= s.p25 && s.p25 <= s.median && s.median <= s.p75 && s.p75 <= s.p90, s);
  if (k !== 'bernoulli' && k !== 'maxcomp' && k !== 'maxemp') {
    const w = E.widenDist(d, 1.4);
    chk(k + ' widening keeps the mean', near(E.mean(w), E.mean(d), Math.max(0.02, 0.003 * Math.abs(E.mean(d)))), [E.mean(w), E.mean(d)]);
    if (k !== 'poisson' || true) chk(k + ' widening by 1.4 raises the variance', E.variance(w) > E.variance(d));
  }
});
chk('gcomp mean = E[N] × per-event mean', near(E.mean(fams.gcomp), 16 * (1.88 * 4.4 - 4), 1e-9));
chk('conv mean = sum of the parts', near(E.mean(fams.conv), E.mean(fams.conv.parts[0]) + E.mean(fams.conv.parts[1]), 1e-9));
chk('a longest play rises with more chances', E.probLine(fams.maxemp, 20.5).over < E.probLine(Object.assign({}, fams.maxemp, { n: { family: 'negbin', mean: 25, size: 20 } }), 20.5).over);
chk('Poisson anytime TD: P(1+) = 1 − e^−λ', near(E.probLine(fams.poisson, 0.5).over, 1 - Math.exp(-1.3), 1e-9));
chk('scaleDist moves the mean by the factor (normal)', near(E.mean(E.scaleDist(fams.normal, 1.1)), 72.4 * 1.1));
chk('scaleDist moves the mean by the factor (gcomp)', near(E.mean(E.scaleDist(fams.gcomp, 0.9)), E.mean(fams.gcomp) * 0.9, 1e-6));
const target = 0.6, sc = E.solveScale(fams.gcomp, 60.5, target), pr0 = E.probLine(E.scaleDist(fams.gcomp, sc), 60.5);
chk('solveScale reproduces a probability over a line', near(pr0.over, target, 1e-4), pr0);
chk('a push is only possible on a whole line', E.probLine(fams.negbin, 5).push > 0.1 && E.probLine(fams.negbin, 5.5).push === 0);
chk('an invalid distribution is refused', !E.validDist({ family: 'normal', mu: 5, sigma: -1 }) && !E.validDist({ family: 'maxemp', n: { family: 'poisson', lambda: 3 }, shape: 'no.such.shape', scale: 1 }));

/* --------------------------------------------------------------- quotes */
section('quotes');
const NOW = Date.parse('2026-10-04T15:10:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const Q = (book, line, side, american, min, alt) => ({ book, line, side, american, captured_at: at(min == null ? 5 : min), quoted_at: at((min == null ? 5 : min) + 2), alt: !!alt });
let n = E.normalizeQuotes([Q('dk', 72.5, 'over', 50), Q('dk', 72.3, 'over', -110), Q('dk', 72.5, 'home', -110), Q('', 72.5, 'over', -110), Q('fd', 72.5, 'over', -110), Q('fd', 72.5, 'under', -110)], 'rush_yds', NOW);
chk('impossible prices, lines, sides and books are refused and counted', n.quotes.length === 2 && Object.keys(n.refused).length === 4, n.refused);
n = E.normalizeQuotes([Q('dk', 72.5, 'over', -110, 30), Q('dk', 72.5, 'over', -105, 5)], 'rush_yds', NOW);
chk('a duplicate keeps the latest capture', n.quotes.length === 1 && n.quotes[0].american === -105);
n = E.normalizeQuotes([Q('dk', 72.5, 'over', -110, 5), Q('dk', 72.5, 'over', -105, 5)], 'rush_yds', NOW);
chk('two different prices at one capture time are refused, never averaged', n.quotes.length === 1 && n.refused['conflicting duplicate at one capture time'] === 1, n);
n = E.normalizeQuotes([Q('dk', 72.5, 'over', 150), Q('dk', 72.5, 'under', 150)], 'rush_yds', NOW);
chk('two sides both paying above fair are a broken feed', n.quotes.length === 0 && n.refused['two-way hold out of bounds'] === 2, n.refused);
n = E.normalizeQuotes([Q('dk', 72.5, 'over', -110, 120), Q('dk', 72.5, 'under', -110, 120)], 'rush_yds', NOW);
chk('a quote 120 minutes old is EXPIRED (past the 90-minute stale band)', n.quotes.every((q) => q.fresh.state === 'EXPIRED'));
n = E.normalizeQuotes([Q('dk', 72.5, 'over', -110, -30)], 'rush_yds', NOW);
chk('a capture time in the future is flagged, not fresh', n.quotes[0].fresh.state === 'FUTURE');
n = E.normalizeQuotes([{ book: 'dk', side: 'yes', american: -135, captured_at: at(5) }], 'anytime_td', NOW);
chk('a Yes/No market reads Yes as over 0.5', n.quotes.length === 1 && n.quotes[0].side === 'over' && n.quotes[0].line === 0.5);
const cons = E.consensusOf(E.normalizeQuotes([Q('dk', 84.5, 'over', -105), Q('dk', 84.5, 'under', -115), Q('fd', 84.5, 'over', -110), Q('fd', 84.5, 'under', -110), Q('mgm', 82.5, 'over', -120), Q('mgm', 82.5, 'under', -105)], 'rush_yds', NOW).quotes, NOW);
chk('consensus is the modal line books deal', cons.line === 84.5 && cons.n_books === 3 && cons.n_at_line === 2, cons);
chk('consensus no-vig is from the books at that line', near(cons.novig_over, (E.noVig(-105, -115).over + 0.5) / 2, 1e-9));
const split = E.consensusOf(E.normalizeQuotes([Q('dk', 112.5, 'over', -110), Q('dk', 112.5, 'under', -110), Q('fd', 114.5, 'over', -114), Q('fd', 114.5, 'under', -114)], 'rush_rec_yds', NOW).quotes, NOW);
chk('two books on two numbers: the median snapped to the half point', split.line === 113.5 && split.novig_over === null, split);

/* ------------------------------------------------------------- evaluate */
section('evaluate');
const KICK = new Date(NOW + 30 * 3600e3).toISOString();
const RUSH = { family: 'gcomp', n: { family: 'negbin', mean: 20, size: 22 }, a: 1.88, theta: 4.95, shift: 4 };   /* mean ≈ 106 */
function prop(o) {
  return Object.assign({ id: 'nfl|g|p|rush_yds', market: 'rush_yds', kickoff: KICK, game_status: 'scheduled', mapped: true, player_status: { status: null }, report_on_file: true,
    projection: { dist: RUSH, sample_games: 6, prior_games: 10, role_stability: 0.85, completeness: 0.9 }, quotes: [] }, o || {});
}
const OPTS = { now: NOW };
let ev = E.evaluate(prop({ quotes: [] }), OPTS);
chk('no quotes → NO DECISION · NO_MARKET, with the projection still shown', ev.decision === 'NO_DECISION' && ev.code === 'NO_MARKET' && ev.raw && ev.raw.mean > 90, [ev.decision, ev.code]);
const two = [Q('dk', 84.5, 'over', -105), Q('dk', 84.5, 'under', -115), Q('fd', 84.5, 'over', -110), Q('fd', 84.5, 'under', -110), Q('mgm', 84.5, 'over', -112), Q('mgm', 84.5, 'under', -108)];
ev = E.evaluate(prop({ quotes: two }), OPTS);
chk('a strong projection over a soft line is a BET', ev.decision === 'BET' && ev.candidate.side === 'over', [ev.decision, ev.code, ev.candidate]);
chk('the BET takes the best price, not the consensus', ev.candidate.book === 'dk' && ev.candidate.american === -105);
chk('raw and market-informed are both reported, informed between raw and market', ev.raw.mean > ev.informed.mean && ev.informed.mean > ev.market_implied_mean, [ev.raw.mean, ev.informed.mean, ev.market_implied_mean]);
chk('the market weight is printed on the evaluation', ev.market_weight === E.CONFIG.market_weight && ev.anchored === true);
chk('model-estimated probability caps the stake at 0.25U', ev.units === 0.25 && ev.caps.some((c) => c.code === 'PROBABILITY_SOURCE'), [ev.units, ev.caps]);
chk('the probability source is printed', /MODEL-ESTIMATED/.test(ev.probability_label));
chk('edge vs break-even has EV\'s sign', ev.candidate.edge_pp > 0 && ev.candidate.ev > 0);
const evPart = E.evaluate(prop({ quotes: two }), { now: NOW, calibration: { state: 'PARTIAL', n: 600, ece: 0.02 } });
chk('a partially calibrated source allows up to 0.50U', evPart.units >= 0.25 && evPart.units <= 0.5 && evPart.probability_source === 'partially_calibrated', [evPart.units, evPart.caps]);
/* a worse line at a much better price */
const shop = [Q('dk', 104.5, 'over', -110), Q('dk', 104.5, 'under', -110), Q('fd', 104.5, 'over', -115), Q('fd', 104.5, 'under', -105), Q('br', 106.5, 'over', 130), Q('br', 106.5, 'under', -160)];
ev = E.evaluate(prop({ quotes: shop }), OPTS);
chk('price shopping: a worse line at a much better price wins on EV', ev.best_ev.over.book === 'br' && ev.best_ev.over.line === 106.5, ev.best_ev.over);
/* alternates */
const alts = two.concat([Q('dk', 69.5, 'over', -180, 5, true), Q('dk', 79.5, 'over', -125, 5, true), Q('dk', 99.5, 'over', 120, 5, true), Q('dk', 119.5, 'over', 250, 5, true), Q('dk', 150.5, 'over', 900, 5, true)]);
ev = E.evaluate(prop({ quotes: alts }), OPTS);
chk('every alternate rung is priced with fair, implied and EV', ev.ladder.length >= 7 && ev.ladder.every((r) => r.fair_american != null && r.implied != null && r.ev != null));
const bestRung = ev.ladder.reduce((a, b) => (b.ev > a.ev ? b : a));
chk('the best EV rung is found, not the main line by default', ev.best_value.line === bestRung.line && ev.best_value.side === bestRung.side, [ev.best_value, bestRung.line]);
chk('a +900 far alternate is shown but never the decision candidate', ev.candidate.american <= E.CONFIG.decision_price_window.max);
/* one-sided and single book */
ev = E.evaluate(prop({ quotes: [Q('dk', 97.5, 'over', -105)] }), OPTS);
chk('a one-sided single-book market is priced, never above LEAN, and says why', ev.decision === 'LEAN' && ev.caps.map((c) => c.code).concat(ev.warnings).some((c) => /ONE_SIDED|NO_MARKET_ANCHOR|SINGLE_BOOK/.test(c)), [ev.decision, ev.caps, ev.warnings]);
ev = E.evaluate(prop({ quotes: [Q('dk', 92.5, 'over', -105)] }), OPTS);
chk('a one-sided BET-quality price is capped to LEAN', ev.decision === 'LEAN' && ev.caps.some((c) => /ONE_SIDED|NO_MARKET_ANCHOR|SINGLE_BOOK/.test(c.code)), [ev.decision, ev.caps, ev.candidate && ev.candidate.ev]);
ev = E.evaluate(prop({ quotes: [Q('dk', 84.5, 'over', -105)] }), OPTS);
chk('an unanchored, extreme single-book EV is WATCH · PRICE_ANOMALY', ev.decision === 'WATCH' && ev.caps.some((c) => c.code === 'PRICE_ANOMALY'));
chk('with no two-sided book there is no no-vig', ev.consensus.novig_over === null);
/* availability */
ev = E.evaluate(prop({ quotes: two, player_status: { status: 'QUESTIONABLE', practice: 'Limited' } }), OPTS);
chk('a QUESTIONABLE player caps a BET at WATCH', ev.decision === 'WATCH' && ev.code === 'AVAILABILITY_PENDING' && ev.units === 0, [ev.decision, ev.code]);
ev = E.evaluate(prop({ quotes: two, player_status: { status: 'OUT' } }), OPTS);
chk('an OUT player is NO DECISION · PLAYER_OUT', ev.decision === 'NO_DECISION' && ev.code === 'PLAYER_OUT');
ev = E.evaluate(prop({ quotes: two, mapped: false, projection: null }), OPTS);
chk('an unmapped book name is NO DECISION · PLAYER_UNMAPPED', ev.decision === 'NO_DECISION' && ev.blockers.indexOf('PLAYER_UNMAPPED') >= 0);
ev = E.evaluate(prop({ quotes: two, projection: null }), OPTS);
chk('no projection is NO DECISION · NO_PROJECTION', ev.decision === 'NO_DECISION' && ev.code === 'NO_PROJECTION');
ev = E.evaluate(prop({ quotes: two, projection: { dist: { family: 'normal', mu: 5, sigma: -2 } } }), OPTS);
chk('a broken distribution is NO DECISION · INVALID_DISTRIBUTION', ev.code === 'INVALID_DISTRIBUTION');
/* game state */
ev = E.evaluate(prop({ quotes: two, kickoff: new Date(NOW - 60000).toISOString() }), OPTS);
chk('after kickoff: NO DECISION · GAME_STARTED', ev.decision === 'NO_DECISION' && ev.code === 'GAME_STARTED');
ev = E.evaluate(prop({ quotes: two, game_status: 'cancelled' }), OPTS);
chk('a cancelled game: NO DECISION · GAME_CANCELLED', ev.code === 'GAME_CANCELLED');
ev = E.evaluate(prop({ quotes: two.map((q) => Object.assign({}, q, { captured_at: at(150) })) }), OPTS);
chk('only stale quotes: NO DECISION · STALE_QUOTE, and nothing priced', ev.decision === 'NO_DECISION' && ev.code === 'STALE_QUOTE' && !ev.candidate, [ev.decision, ev.code]);
chk('the last numbers seen are kept for reference, labelled stale', ev.last_seen && ev.last_seen.stale === true && ev.last_seen.line === 84.5);
/* thin sample, role, confidence */
ev = E.evaluate(prop({ quotes: two, projection: Object.assign({}, prop().projection, { sample_games: 1 }) }), OPTS);
chk('fewer than three games caps at LEAN', ev.decision === 'LEAN' && ev.caps.some((c) => c.code === 'THIN_SAMPLE'), [ev.decision, ev.caps]);
ev = E.evaluate(prop({ quotes: two, projection: Object.assign({}, prop().projection, { role_stability: 0.3 }) }), OPTS);
chk('an unstable role caps at LEAN', ev.decision === 'LEAN' && ev.caps.some((c) => c.code === 'ROLE_UNSTABLE'));
/* extreme EV */
const HUGE = { family: 'gcomp', n: { family: 'negbin', mean: 28, size: 22 }, a: 1.88, theta: 5.5, shift: 4 };
ev = E.evaluate(prop({ quotes: [Q('dk', 84.5, 'over', 120), Q('dk', 84.5, 'under', -150), Q('fd', 84.5, 'over', -140), Q('fd', 84.5, 'under', 115)], projection: Object.assign({}, prop().projection, { dist: HUGE }) }), OPTS);
chk('an extreme EV no second book corroborates is WATCH · PRICE_ANOMALY', ev.decision === 'WATCH' && ev.caps.some((c) => c.code === 'PRICE_ANOMALY'), [ev.decision, ev.caps, ev.candidate && ev.candidate.ev]);
/* no edge */
const even = [Q('dk', 84.5, 'over', -110), Q('dk', 84.5, 'under', -110), Q('fd', 84.5, 'over', -110), Q('fd', 84.5, 'under', -110)];
ev = E.evaluate(prop({ quotes: even, projection: Object.assign({}, prop().projection, { dist: { family: 'normal', mu: 84.5, sigma: 30 } }) }), OPTS);
chk('a projection on the line at −110 / −110 is a PASS: the vig consumes it', ev.decision === 'PASS' && ev.candidate.ev < 0, [ev.decision, ev.code, ev.candidate]);
const FAIR = { family: 'gcomp', n: { family: 'negbin', mean: 20, size: 22 }, a: 1.88, theta: 4.35, shift: 4 };   /* mean ≈ 84 */
ev = E.evaluate(prop({ quotes: two, projection: Object.assign({}, prop().projection, { dist: FAIR }) }), OPTS);
chk('a small edge one price step from BET is a WATCH with its trigger', ev.decision === 'WATCH' && ev.trigger && ev.trigger.realistic && /becomes BET/.test(ev.trigger.text), [ev.decision, ev.trigger]);
chk('positive EV alone is not a BET (LEAN/WATCH exist)', ['LEAN', 'WATCH', 'PASS'].indexOf(E.evaluate(prop({ quotes: [Q('dk', 90.5, 'over', -110), Q('dk', 90.5, 'under', -110), Q('fd', 90.5, 'over', -110), Q('fd', 90.5, 'under', -110)], projection: Object.assign({}, prop().projection, { dist: { family: 'gcomp', n: { family: 'negbin', mean: 20, size: 22 }, a: 1.88, theta: 4.62, shift: 4 } }) }), OPTS).decision) >= 0);
chk('deterministic: the same input evaluates the same', JSON.stringify(E.compact(E.evaluate(prop({ quotes: two }), OPTS))) === JSON.stringify(E.compact(E.evaluate(prop({ quotes: two }), OPTS))));
/* TAIL PRICING, UNCALIBRATED (audit 2026-09-30 #7e): the same quote as an
   alternate and as a main line — only the flag differs */
{
  const altQ = two.concat([Q('dk', 82.5, 'over', -110, 5, true), Q('fd', 82.5, 'over', -110, 5, true)]);
  const mainQ = two.concat([Q('dk', 82.5, 'over', -110, 5, false), Q('fd', 82.5, 'over', -110, 5, false)]);
  const asAlt = E.evaluate(prop({ quotes: altQ }), OPTS), asMain = E.evaluate(prop({ quotes: mainQ }), OPTS);
  chk('an alternate inside the median at a BET-quality price never reaches BET: LEAN · TAIL_PRICING_UNCALIBRATED, no units', asAlt.candidate && asAlt.candidate.alt === true && asAlt.decision === 'LEAN'
    && asAlt.code === 'TAIL_PRICING_UNCALIBRATED' && asAlt.units === 0 && asAlt.caps.some((c) => c.code === 'TAIL_PRICING_UNCALIBRATED' && /tail pricing, uncalibrated/.test(c.text)), [asAlt.decision, asAlt.code, asAlt.candidate]);
  chk('…the identical quote as a main line is a BET (the flag is the only difference)', asMain.decision === 'BET' && asMain.candidate.line === 82.5 && asMain.candidate.alt === false, [asMain.decision, asMain.candidate]);
  chk('…every alternate rung on the ladder carries "tail pricing: uncalibrated"; main rungs do not', asAlt.ladder.filter((r) => !r.main).every((r) => r.tail_pricing === 'uncalibrated') && asAlt.ladder.filter((r) => r.main).every((r) => r.tail_pricing === null));
}
/* REGIME CHANGE on the player's team (audit 2026-09-30 #7d) */
{
  const rg = (g) => ({ regime_change: true, team: 'Iowa State Cyclones', reason: 'new head coach; returning production at the 4th percentile', games_played: g, min_games_for_research: 6 });
  const early = E.evaluate(prop({ quotes: two, regime: rg(4) }), OPTS), later = E.evaluate(prop({ quotes: two, regime: rg(6) }), OPTS);
  chk('a regime-change team before N games: BET capped at LEAN · REGIME_CHANGE, named, no units', early.decision === 'LEAN' && early.code === 'REGIME_CHANGE' && early.units === 0 && early.regime && early.regime.games_played === 4
    && early.caps.some((c) => c.code === 'REGIME_CHANGE' && /REGIME CHANGE: Iowa State/.test(c.text) && /4 of 6 games/.test(c.text)), [early.decision, early.code]);
  chk('…from N games the regime cap lifts (the flag stays on the record)', later.decision === 'BET' && !later.caps.some((c) => c.code === 'REGIME_CHANGE') && later.regime && later.regime.games_played === 6, [later.decision, later.caps]);
  chk('…no regime record, no cap', E.evaluate(prop({ quotes: two, regime: { regime_change: false } }), OPTS).decision === 'BET');
}
/* THE EDGE AND THE EV ARE ONE QUOTE'S (audit 2026-09-30 #7a) */
chk('edgeEvAgree: a LEAN with a negative edge is refused', E.edgeEvAgree('LEAN', { edge_pp: -0.4, ev: 0.02 }) === false && E.edgeEvAgree('BET', { edge_pp: 5, ev: -0.01 }) === false
  && E.edgeEvAgree('LEAN', { edge_pp: 2.5, ev: 0.03 }) === true && E.edgeEvAgree('WATCH', { edge_pp: -3, ev: -0.05 }) === true && E.edgeEvAgree('BET', null) === false);
chk('every BET and LEAN the kernel makes has a positive edge and EV at its own quote', [two, alts, shop, even].every((qs) => { const x = E.evaluate(prop({ quotes: qs }), OPTS); return (x.decision !== 'BET' && x.decision !== 'LEAN') || (x.candidate.edge_pp > 0 && x.candidate.ev > 0); }));
/* the opponent's defensive availability (audit 2026-09-30 #7c): a warning, never silence */
{
  const od = { out: [{ name: 'Frankie Luvu', pos: 'LB', status: 'OUT' }, { name: 'Nick Cross', pos: 'S', status: 'OUT' }], report_week: 3, report_on_file: false };
  const w = E.evaluate(prop({ quotes: two, opp_defense: od }), OPTS);
  chk('defenders OUT on the opponent\'s report: OPP_DEFENSE_UNMODELED, naming them and the report\'s week', w.warnings.indexOf('OPP_DEFENSE_UNMODELED') >= 0 && w.opp_defense && w.opp_defense.modeled === false
    && /Frankie Luvu \(LB, out\)/.test(w.opp_defense.text) && /week-3 report \(this week's is not on file\)/.test(w.opp_defense.text), w.opp_defense);
  chk('…nobody listed, no warning', E.evaluate(prop({ quotes: two, opp_defense: { out: [], report_week: 4, report_on_file: true } }), OPTS).warnings.indexOf('OPP_DEFENSE_UNMODELED') < 0);
  chk('…it is a warning, not a model input: the numbers are unchanged', JSON.stringify(w.candidate) === JSON.stringify(E.evaluate(prop({ quotes: two }), OPTS).candidate));
}
/* the player's own earlier listing, this week's report not on file (the week bug) */
{
  const pend = E.evaluate(prop({ quotes: two, player_status: { status: null, pending: { status: 'OUT', week: 3 } }, report_on_file: false }), OPTS);
  chk('listed OUT last week, this week\'s report not on file: WATCH · AVAILABILITY_PENDING, never a clean BET', pend.decision === 'WATCH' && pend.code === 'AVAILABILITY_PENDING' && pend.caps.some((c) => /week-3 report/.test(c.text)), [pend.decision, pend.code]);
}
/* compact carries what the page needs */
const cp = E.compact(E.evaluate(prop({ quotes: alts }), OPTS));
chk('compact: decision, candidate, consensus, projection summaries', cp.d && cp.cand && cp.cand.length === 12 && cp.cons && cp.inf && cp.raw);

/* ------------------------------------------------------------ parity */
section('parity with lib/edgedesk_decision.js');
const dc = D.config();
chk('BET / LEAN / STRONG thresholds are the football engine\'s', JSON.stringify(E.DECISION_FALLBACK.thresholds) === JSON.stringify({ bet: dc.thresholds.bet, strong: dc.thresholds.strong, lean: dc.thresholds.lean }), dc.thresholds);
chk('the unit ladder and source caps are the football engine\'s', JSON.stringify(E.DECISION_FALLBACK.sizing.grid) === JSON.stringify(dc.sizing.grid) && JSON.stringify(E.DECISION_FALLBACK.sizing.source_caps) === JSON.stringify(dc.sizing.source_caps) && E.DECISION_FALLBACK.sizing.kelly_fraction === dc.sizing.kelly_fraction);
chk('the kernel reads the live engine config when it is loaded', /EDDecision\.config/.test(E.decisionConfig().source));
chk('the props execution window is its own rule (FRESHNESS), and CONFIG only aliases it', E.CONFIG.max_quote_age_minutes === E.FRESHNESS.executable_max_minutes && E.CONFIG.fresh_minutes === E.FRESHNESS.quote.fresh_minutes && E.FRESHNESS.executable_max_minutes <= dc.freshness.max_quote_age_minutes);

/* ------------------------------------------------------------ sizing */
section('sizing');
const cand = { edge_pp: 9, ev: 0.12, decimal: 1.95, american: -105 };
let sz = E.sizing(cand, { score: 90 }, E.calibrationOf({ state: 'CALIBRATED' }), { disagreement_toward_pp: 8 });
chk('a calibrated, clean, strong BET can reach 1.00U', sz.units === 1, sz);
sz = E.sizing(cand, { score: 90 }, E.calibrationOf({ state: 'CALIBRATED' }), { disagreement_toward_pp: 8, single_book: true });
chk('a single book caps at 0.50U', sz.units === 0.5);
sz = E.sizing({ edge_pp: 5, ev: 0.06, decimal: 6, american: 500 }, { score: 90 }, E.calibrationOf({ state: 'CALIBRATED' }), { disagreement_toward_pp: 8 });
chk('a long price sizes smaller under the quarter-Kelly ceiling, rounded down', sz.units <= 0.25 && sz.caps.some((c) => c.code === 'KELLY'), sz);
sz = E.sizing({ edge_pp: 4.5, ev: 0.06, decimal: 1.95, american: -105 }, { score: 30 }, E.calibrationOf({ state: 'CALIBRATED' }), {});
chk('below the confidence floor no tier sizes', sz.units === 0);
chk('units never exceed 1.00U', [0.25, 0.5, 0.75, 1].indexOf(E.sizing(cand, { score: 99 }, E.calibrationOf({ state: 'CALIBRATED' }), { disagreement_toward_pp: 30 }).units) >= 0);
const st = E.stake(0.5, { bankroll_amount: 2500, unit_mode: 'percent', unit_percent: 0.01 }, -105);
chk('0.5U at a 1% unit on $2,500 is $12.50 to win $11.90', st.stake === 12.5 && near(st.to_win, 11.9, 0.01), st);
chk('EV in dollars uses the reader\'s unit', E.evDollars(0.083, 1, 25) === 2.08);

/* ------------------------------------------------------------ history */
section('history');
const logs = [5, 80, 72.5, 90, 60, 100, 71, 88, 93, 40, 77].map((v, i) => ({ season: i < 4 ? 2025 : 2026, value: v, opp: i % 2 ? 'CHI' : 'CAR', home: i % 2 === 0 }));
const hr = E.hitRates(logs, 72.5, 'over', { season: 2026, opp: 'CHI', similar: ['CHI'] });
chk('hit rates are labelled context, not probability', /context only/.test(hr.label));
chk('L5 / L10 / season counts', hr.L5.n === 5 && hr.L10.n === 10 && hr.season.n === 7, hr);
chk('a push is counted apart and excluded from the rate', hr.L10.pushes === 1 && near(hr.L10.pct, hr.L10.hits / 9, 1e-3), hr.L10);
chk('home / away / opponent / similar split', hr.home.n + hr.away.n === hr.season.n && hr.vs_opp.n === 5);

/* ------------------------------------------------------------ settlement */
section('settlement and CLV');
chk('84 over 72.5 wins', E.settle('rush_yds', 72.5, 'over', { played: true, value: 84 }).result === 'WIN');
chk('84 under 72.5 loses', E.settle('rush_yds', 72.5, 'under', { played: true, value: 84 }).result === 'LOSS');
chk('a whole line landed exactly pushes', E.settle('receptions', 5, 'over', { played: true, value: 5 }).result === 'PUSH');
chk('a player who did not play is VOID', E.settle('rush_yds', 72.5, 'over', { played: false }).result === 'VOID');
chk('a missing statistic is VOID, never a loss', E.settle('rec_long', 22.5, 'over', { played: true, value: null }).result === 'VOID');
chk('anytime TD Yes settles as over 0.5', E.settle('anytime_td', 0.5, 'yes', { played: true, value: 1 }).result === 'WIN' && E.settle('anytime_td', 0.5, 'no', { played: true, value: 0 }).result === 'WIN');
chk('overtime yards count (the official statistic is used as is)', E.settle('rush_yds', 99.5, 'over', { played: true, value: 104 }).result === 'WIN');
chk('units won at +120 for 0.5U is 0.6', E.unitsWon('WIN', 120, 0.5) === 0.6 && E.unitsWon('LOSS', 120, 0.5) === -0.5 && E.unitsWon('PUSH', 120, 0.5) === 0);
let c = E.clv({ side: 'over', line: 72.5, american: -105 }, { line: 75.5, over: -115, under: -105 });
chk('line CLV: bought over 72.5, closed 75.5 → +3', c.line_clv === 3 && c.beat_close === true);
chk('no price CLV across different numbers', c.price_clv_cents === undefined);
c = E.clv({ side: 'over', line: 72.5, american: -105 }, { line: 72.5, over: -125, under: 105 });
chk('same number: price and no-vig probability CLV', c.price_clv_cents > 0 && c.prob_clv_pp > 0 && c.beat_close === true, c);
chk('no close on file → CLV unavailable, never invented', E.clv({ side: 'over', line: 72.5, american: -105 }, null).available === false);

/* ------------------------------------------------------------ calibration */
section('calibration');
const rows = [];
for (let i = 0; i < 400; i++) { const p = 0.52 + (i % 20) / 100; rows.push({ p_side: p, result: (i * 7919 % 100) / 100 < p ? 'WIN' : 'LOSS' }); }
const cal = E.calibration(rows);
chk('calibration buckets 50–55 … 70+', cal.table.map((t) => t.bucket).join(',') === '50–55%,55–60%,60–65%,65–70%,70%+');
chk('expected vs observed per bucket with n', cal.table.every((t) => t.n > 0 && t.expected != null && t.observed != null));
chk('a probability below 50% is folded onto its complement', E.calibration([{ p_side: 0.3, result: 'LOSS' }]).table[4].n === 1);
chk('pushes and voids are excluded', E.calibration([{ p_side: 0.6, result: 'PUSH' }, { p_side: 0.6, result: 'VOID' }]).n === 0);
chk('promotion needs 500 settled and ECE ≤ 0.03', E.calibrationState({ n: 499, ece: 0.01 }) === 'EARLY' && E.calibrationState({ n: 500, ece: 0.02 }) === 'PARTIAL' && E.calibrationState({ n: 500, ece: 0.05 }) === 'EARLY' && E.calibrationState({ n: 50, ece: 0 }) === 'UNVALIDATED');
chk('CALIBRATED also needs positive CLV', E.calibrationState({ n: 1200, ece: 0.01 }, { avg_prob_clv_pp: -0.5 }) === 'PARTIAL' && E.calibrationState({ n: 1200, ece: 0.01 }, { avg_prob_clv_pp: 0.8 }) === 'CALIBRATED');
const sm = E.summarize([{ result: 'WIN', american: 100, units: 0.5, ev: 0.06 }, { result: 'LOSS', american: -110, units: 0.5, ev: 0.05 }, { result: 'PUSH', american: -110, units: 0.5 }]);
chk('summary: W-L-P, units, ROI on risked units', sm.wins === 1 && sm.losses === 1 && sm.pushes === 1 && sm.units === 0 && sm.roi === 0 && sm.sample.key === 'DESCRIPTIVE', sm);

/* ------------------------------------------------------------ explanations */
section('explanations');
ev = E.evaluate(prop({ quotes: two }), OPTS);
const f = E.factsFor({ market: 'rush_yds', player: { shares: { car: { now: 0.67, season: 0.51 } }, status: { status: null }, sample_games: 6, teammates_out: [{ name: 'RB2', pos: 'RB', status: 'OUT', delta: 0.08, label: 'carry share' }] },
  env: { margin: 6.5, implied: 27, wind: null }, lead: { name: 'Chicago Bears', metric: 'rush epa allowed', rank: 27, n_teams: 32, favorable: true }, league_implied: 22.5, line: 84.5, consensus_price: -110, hist: { hits: 7, n: 10 } });
const x = E.explain(ev, f, 'over');
chk('WHY lists the projection vs the line', x.why.some((s) => /projects .* rushing yards vs the 84\.5 line/.test(s)), x.why);
chk('WHY lists the share trend', x.why.some((s) => /Carry share has risen from 51% to 67%/.test(s)));
chk('WHY lists the matchup rank', x.why.some((s) => /ranks 27th of 32/.test(s)));
chk('WHY lists the price vs consensus', x.why.some((s) => /Best available price is −105|Best available price is -105/.test(s)), x.why);
chk('a teammate OUT is a projected adjustment', x.why.some((s) => /projected adjustment/.test(s)));
chk('history is labelled context only', x.why.concat(x.risks).some((s) => /History \(context only\)/.test(s)));
const xu = E.explain(ev, Object.assign({}, f, { spread: 7.5 }), 'over');
chk('RISKS: the team could trail early', xu.risks.some((s) => /could trail early/.test(s)), xu.risks);
chk('explanations are deterministic', JSON.stringify(E.explain(ev, f, 'over')) === JSON.stringify(x));

/* ------------------------------------------------------------ registry */
section('registry');
chk('every market has a label, a category, a stat and a distribution', Object.keys(E.MARKETS).every((k) => { const m = E.MARKETS[k]; return m.label && m.cat && m.stat && m.dist; }));
chk('NFL and CFB are registered sports', E.SPORTS.nfl && E.SPORTS.cfb && E.SPORTS.nfl.provider_sport === 'americanfootball_nfl');
chk('The Odds API keys map onto EdgeDesk markets (main and alternate)', E.providerMarket('player_rush_yds').market === 'rush_yds' && E.providerMarket('player_rush_yds_alternate').alt === true && E.providerMarket('player_anytime_td').market === 'anytime_td');
chk('an unknown provider key maps to nothing', E.providerMarket('player_hot_dogs') === null);
chk('statOf: anytime TD counts rushing, receiving and return TDs, never passing', E.statOf('anytime_td', { rtd: 1, td: 1, st_td: 1, ptd: 3 }) === 3);
chk('statOf: kicking points are 3 per FG plus PATs', E.statOf('kicking_pts', { fgm: 2, xpm: 3 }) === 9);
chk('statOf: a longest-reception market with no catch is 0', E.statOf('rec_long', { rec: 0 }) === 0);

/* ---- 'stored': the data factory's distributions (docs/player-props/FACTORY.md),
   priced here exactly as the factory's own kernel prices them */
(function stored() {
  const F = require(path.join(ROOT, 'football', 'props', 'factory', 'dist.js'));
  const table = { probs: [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99], bins: [{ mu_lo: 1, mu_hi: 200, mu_mid: 60, n: 1000, q: [0, 0.35, 0.68, 1.0, 1.32, 1.66, 2.4] }] };
  const forms = { yards: F.roundDist(F.dist.continuousFromRatio(74, table, 0, { integer: true })), counts: F.roundDist(F.dist.negBinomPmf(5.2, 9)) };
  Object.keys(forms).forEach((k) => {
    const d = forms[k], S = Object.assign({ family: 'stored' }, d);
    chk('stored (' + k + '): a valid distribution', E.validDist(S));
    let worst = 0;
    for (let L = -2.5; L <= 160; L += 0.5) { const a = F.dist.probs(d, L), b = E.probLine(S, L); worst = Math.max(worst, Math.abs(a.over - b.over), Math.abs(a.under - b.under), Math.abs(a.push - b.push)); }
    chk('stored (' + k + '): P(over/under/push) at every line equals the factory kernel\'s', worst < 1e-9, worst);
    chk('stored (' + k + '): never rescaled or widened — it is evidence, not the engine', E.scaleDist(S, 1.3) === S && JSON.stringify(E.widenDist(S, 1.5)) === JSON.stringify(S));
  });
  const T = { family: 'stored', t: 'bern', p: 0.41 };
  chk('stored (yes/no): P(yes) at the 0.5 line', Math.abs(E.probLine(T, 0.5).over - 0.41) < 1e-12);
  chk('stored: a malformed distribution is refused', !E.validDist({ family: 'stored', t: 'cdf', x: [0, 10, 5], p: [0, 0.5, 1] }) && !E.validDist({ family: 'stored', t: 'pmf', v: [0.5, -0.1] }) && !E.validDist({ family: 'stored', t: 'nope' }));
  const meta = { models: [['nfl_te_receptions_v1.2025', 'OUTCOME_VALIDATED', 0.12, 0.02, 3]], generated_at: '2026-10-01T12:00:00Z' };
  const fx = [0, { t: 'pmf', v: [0.05, 0.15, 0.25, 0.25, 0.15, 0.1, 0.05], tail: 0 }, null, '2026-10-01T12:00:00Z'];
  const v = E.factoryView(fx, meta, 2.5, 'over', -120);
  chk('factoryView: the side\'s probability, fair price and EV at the given price', v && v.p_side === 0.55 && v.fair_american === E.fairAmerican(0.55, 0) && Math.abs(v.ev - E.expectedValue(0.55, -120, 0)) < 1e-4 && v.model_version === 'nfl_te_receptions_v1.2025' && v.tier === 'OUTCOME_VALIDATED', v);
  const w = E.factoryView(fx, meta, 3, 'under', null);
  chk('factoryView: a whole line carries its push; no price, no EV', w && w.p_push === 0.25 && w.p_side === 0.45 && w.ev === null, w);
  chk('factoryView: nothing without a joined row', E.factoryView(null, meta, 2.5, 'over') === null && E.factoryView(fx, null, 2.5, 'over') === null);
})();

/* ------------------------------------------------------------ board order */
section('board order');
const UI = require('../../lib/edgedesk_props_ui.js');
{
  const T0 = Date.parse('2026-10-04T12:00:00Z');
  UI.state.clock = () => T0;
  const row = (name, pos, kick, extra) => Object.assign({ name, pos, kick: Date.parse(kick), decision: 'NO_DECISION', value: 0, conf: 50, cand: null, md: { label: 'x' }, g: { game_id: kick } }, extra || {});
  const rows = [
    row('Kicker Early', 'K', '2026-10-04T13:00:00Z'),
    row('Started QB', 'QB', '2026-10-04T11:00:00Z', { decision: 'NO_DECISION', conf: 90 }),
    row('WR Early', 'WR', '2026-10-04T13:00:00Z'),
    row('QB Early', 'QB', '2026-10-04T13:00:00Z'),
    row('QB Late', 'QB', '2026-10-04T17:00:00Z'),
    row('Lean WR', 'WR', '2026-10-04T17:00:00Z', { decision: 'LEAN', value: 40, cand: { ev: 0.05 } })
  ];
  const order = (k) => rows.slice().sort(UI._sorter(k)).map((r) => r.name);
  const bv = order('value');
  chk('best value: a decision outranks projection-only rows', bv[0] === 'Lean WR', bv);
  chk('nothing priced: kickoff, then QB → RB → WR → TE → K (a kicker never leads a game)', bv.slice(1, 5).join() === 'QB Early,WR Early,Kicker Early,QB Late', bv);
  chk('a game that has kicked off sorts last under every sort', ['value', 'ev', 'conf', 'kick', 'player', 'game', 'prob', 'price', 'diff'].every((k) => order(k)[rows.length - 1] === 'Started QB'));
  UI.state.clock = null;
}

/* --------------------------------------------------------------- stages */
section('stages (walk-forward gates, never assigned)');
{
  const oos = { n: 1400, bias_pct: 1.2, mae: 14, log_score: -4.4, cover50: 0.49, pit_mean: 0.502, pit_var: 0.0835, calibration: { n: 4200, brier: 0.24, ece: 0.012 },
    baseline: { n: 1200, log_score_model: -4.41, log_score_baseline: -4.62, beats: true } };
  const bt = (o) => ({ backtest: { mode: 'BACKTEST', disclosure: 'shapes include the tested season', oos: Object.assign({}, oos, o || {}) } });
  chk('no evidence: EXPERIMENTAL', E.stageOf({}, 'rec_yds').stage === 'EXPERIMENTAL');
  chk('every out-of-sample gate passed: TRACKING', E.stageOf(bt(), 'rec_yds').stage === 'TRACKING', E.stageOf(bt(), 'rec_yds').gates.filter((g) => !g.pass).map((g) => g.id));
  chk('losing to the naive last-8 baseline keeps it EXPERIMENTAL', E.stageOf(bt({ baseline: Object.assign({}, oos.baseline, { beats: false }) }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('no baseline measured keeps it EXPERIMENTAL (an unmeasured gate never passes)', E.stageOf(bt({ baseline: null }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('a too-narrow distribution (PIT variance) keeps it EXPERIMENTAL', E.stageOf(bt({ pit_var: 0.11 }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('50% coverage outside [0.45, 0.55] keeps it EXPERIMENTAL', E.stageOf(bt({ cover50: 0.41 }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('ECE above 0.03 keeps it EXPERIMENTAL', E.stageOf(bt({ calibration: { n: 900, ece: 0.041 } }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('a small out-of-sample n keeps it EXPERIMENTAL', E.stageOf(bt({ n: 250 }), 'rec_yds').stage === 'EXPERIMENTAL');
  chk('a tail market (longest reception) stays EXPERIMENTAL whatever its backtest', E.stageOf(bt(), 'rec_long').stage === 'EXPERIMENTAL' && E.isTailMarket('rec_long') && E.isTailMarket('first_td') && !E.isTailMarket('rec_yds'));
  const live = { n: 260, ece: 0.021, brier: 0.238, market_brier: 0.240, clv_pp: 0.4, clv_n: 80 };
  chk('RESEARCH GRADE needs 200 settled, live ECE, Brier vs the market and CLV ≥ 0', E.stageOf(Object.assign(bt(), { live }), 'rec_yds').stage === 'RESEARCH_GRADE'
    && E.stageOf(Object.assign(bt(), { live: Object.assign({}, live, { clv_pp: -0.3 }) }), 'rec_yds').stage === 'TRACKING'
    && E.stageOf(Object.assign(bt(), { live: Object.assign({}, live, { brier: 0.252 }) }), 'rec_yds').stage === 'TRACKING');
  chk('PRODUCTION needs 500 settled, ECE ≤ 0.02 and positive CLV on 100+ closes', E.stageOf(Object.assign(bt(), { live: Object.assign({}, live, { n: 640, ece: 0.015, clv_n: 150 }) }), 'rec_yds').stage === 'PRODUCTION'
    && E.stageOf(Object.assign(bt(), { live: Object.assign({}, live, { n: 640, ece: 0.025, clv_n: 150 }) }), 'rec_yds').stage === 'RESEARCH_GRADE');
  const table = E.stageTable({ mode: 'BACKTEST', disclosure: 'x', out_of_sample: { after: { rush_yds: oos, rec_long: oos } } }, null);
  chk('stageTable: a market with the evidence is TRACKING, one without is EXPERIMENTAL', table.rush_yds.stage === 'TRACKING' && table.rec_long.stage === 'EXPERIMENTAL' && table.pass_yds.stage === 'EXPERIMENTAL');
  chk('stageTable: no backtest at all (college) — every market EXPERIMENTAL', Object.values(E.stageTable(null, null)).every((x) => x.stage === 'EXPERIMENTAL'));
  const bet = E.evaluate(prop({ quotes: two }), { now: NOW, stages: { rush_yds: { stage: 'TRACKING' } } });
  chk('a TRACKING market keeps its BET (still capped by the probability source)', bet.decision === 'BET' && bet.stage === 'TRACKING' && bet.units === 0.25, [bet.decision, bet.stage]);
  const exp = E.evaluate(prop({ quotes: two }), { now: NOW, stages: { rush_yds: { stage: 'EXPERIMENTAL' } } });
  chk('an EXPERIMENTAL market caps a BET at LEAN, with no units, and says why', exp.decision === 'LEAN' && exp.code === 'STAGE_EXPERIMENTAL' && exp.units === 0 && exp.caps.some((c) => c.code === 'STAGE_EXPERIMENTAL'), [exp.decision, exp.code]);
  const missing = E.evaluate(prop({ quotes: two }), { now: NOW, stages: {} });
  chk('a market missing from the stage table is EXPERIMENTAL', missing.stage === 'EXPERIMENTAL' && missing.decision === 'LEAN');
  chk('without a stage table the kernel is unchanged (older callers)', E.evaluate(prop({ quotes: two }), OPTS).decision === 'BET' && E.evaluate(prop({ quotes: two }), OPTS).stage === null);
}

/* --------------------------------------------------- same-game correlation */
section('same-game correlation, the joint Monte Carlo and exposure caps');
{
  /* a hand-made model (test data): the shape football/props/correlation.js writes */
  const model = { same_player: { 'QB|pass_tds|pass_yds': [0.43, 1000] }, teammate: { 'QB:pass_yds|WR:rec_yds': [0.30, 2800], 'RB:rush_yds|WR:rec_yds': [-0.10, 2000] }, opponent: { 'QB:pass_yds|QB:pass_yds': [0.09, 540] } };
  const L = (o) => Object.assign({ g: 'G1', team: 'ATL', side: 'over' }, o);
  const qb = L({ p: 'qb', pos: 'QB', m: 'pass_yds' }), wr = L({ p: 'wr', pos: 'WR', m: 'rec_yds' }), rb = L({ p: 'rb', pos: 'RB', m: 'rush_yds' });
  chk('teammates read the teammate table, in either order', E.legCorr(model, qb, wr) === 0.30 && E.legCorr(model, wr, qb) === 0.30);
  chk('one player\'s two markets read the same-player table', E.legCorr(model, qb, L({ p: 'qb', pos: 'QB', m: 'pass_tds' })) === 0.43);
  chk('opponents read the opponent table', E.legCorr(model, qb, L({ p: 'qb2', pos: 'QB', m: 'pass_yds', team: 'NO' })) === 0.09);
  chk('different games, or a pair the model does not list, are independent', E.legCorr(model, qb, Object.assign({}, wr, { g: 'G2' })) === 0 && E.legCorr(model, qb, L({ p: 'k', pos: 'K', m: 'fg_made' })) === 0 && E.legCorr(null, qb, wr) === 0);
  chk('an Under flips the sign of a selection\'s correlation', E.selCorr(model, qb, Object.assign({}, wr, { side: 'under' })) === -0.30 && E.selCorr(model, Object.assign({}, qb, { side: 'under' }), Object.assign({}, wr, { side: 'under' })) === 0.30);
  const legs = [Object.assign({}, qb, { p_win: 0.55, p_push: 0 }), Object.assign({}, wr, { p_win: 0.52, p_push: 0 })];
  const j1 = E.jointSim(legs, model, { sims: 20000 }), j2 = E.jointSim(legs, model, { sims: 20000 });
  chk('jointSim is seeded: the same legs give the same answer', j1.p_all === j2.p_all && j1.seed === j2.seed);
  chk('…each leg keeps its own probability (the copula adds only the dependence)', Math.abs(j1.p_each[0] - 0.55) < 0.015 && Math.abs(j1.p_each[1] - 0.52) < 0.015, j1.p_each);
  chk('…positively correlated Overs win together more often than independence says', j1.p_all > j1.p_indep + 0.02 && j1.lift > 1, [j1.p_all, j1.p_indep]);
  const jn = E.jointSim([legs[0], Object.assign({}, legs[1], { side: 'under' })], model, { sims: 20000 });
  chk('…and an Over with a correlated Under less often', jn.p_all < jn.p_indep - 0.02, [jn.p_all, jn.p_indep]);
  const j0 = E.jointSim([legs[0], Object.assign({}, legs[1], { g: 'G2' })], model, { sims: 20000 });
  chk('…and two games are independent', Math.abs(j0.p_all - j0.p_indep) < 0.015, [j0.p_all, j0.p_indep]);
  /* an inconsistent set of pairwise estimates still factorises */
  const bad = { teammate: { 'QB:pass_yds|WR:rec_yds': [0.95, 1], 'QB:pass_yds|TE:rec_yds': [0.95, 1], 'TE:rec_yds|WR:rec_yds': [-0.95, 1] } };
  const jb = E.jointSim([Object.assign({}, qb, { p_win: 0.5 }), Object.assign({}, wr, { p_win: 0.5 }), L({ p: 'te', pos: 'TE', m: 'rec_yds', p_win: 0.5 })], bad, { sims: 2000 });
  chk('an impossible correlation matrix is shrunk until it factorises, and says by how much', jb && jb.shrink > 0 && jb.p_all >= 0, jb && jb.shrink);
  /* exposure */
  const it = (o) => Object.assign({ units: 1, value: 50 }, L(o));
  const x1 = E.exposure([it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds', value: 90 }), it({ key: 'b', p: 'qb', pos: 'QB', m: 'pass_tds', value: 80 })], model);
  chk('one player carries at most 1U across his props: the lower-value one gives way', !x1.a && x1.b && x1.b.units === 0 && x1.b.code === 'PLAYER_EXPOSURE', x1);
  /* the 2U correlated cap across a game's groups: a hand-made model where
     both offences' selections move together (test data) */
  const model2 = { teammate: { 'QB:pass_yds|RB:rush_yds': [-0.8, 1000] }, opponent: { 'QB:pass_yds|QB:pass_yds': [0.9, 540], 'QB:pass_yds|RB:rush_yds': [-0.8, 540] } };
  const x2 = E.exposure([it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds', value: 90 }), it({ key: 'b', p: 'qb2', pos: 'QB', m: 'pass_yds', team: 'NO', opp: 'ATL', value: 80 }),
    it({ key: 'c', p: 'rb', pos: 'RB', m: 'rush_yds', side: 'under', value: 70 })], model2);
  chk('a game\'s correlated stake stops at 2U across its groups: the third correlated selection is cut, rounded DOWN to the grid', !x2.a && !x2.b && x2.c && x2.c.code === 'CORRELATED_EXPOSURE' && x2.c.units < 1 && [0, 0.25, 0.5, 0.75].indexOf(x2.c.units) >= 0, x2);
  const x3 = E.exposure([it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds', value: 90 }), it({ key: 'b', p: 'wr', pos: 'WR', m: 'rec_yds', value: 80, side: 'under' }), it({ key: 'c', p: 'rb2', pos: 'RB', m: 'rush_yds', team: 'NO', opp: 'ATL', value: 70 })], model);
  chk('offsetting selections hedge each other: three 1U bets in three groups fit under the 2U correlated cap', Object.keys(x3).length === 0, x3);
  /* ONE EXPOSURE PER GAME, OFFENCE AND DIRECTION (audit 2026-09-30 #7b) */
  chk('exposureGroup: game | offence | direction; an Under is the offence\'s quiet day', E.exposureGroup(it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds' })) === 'G1|ATL|up'
    && E.exposureGroup(it({ key: 'a', p: 'wr', pos: 'WR', m: 'receptions', side: 'under' })) === 'G1|ATL|down');
  chk('…interceptions thrown and sacks are down markets: their Over is the offence\'s quiet day', E.exposureGroup(it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_ints' })) === 'G1|ATL|down');
  chk('…a defender\'s prop is grouped on the offence it plays against', E.exposureGroup(it({ key: 'a', p: 'lb', pos: 'LB', m: 'sacks', team: 'NO', opp: 'ATL' })) === 'G1|ATL|down'
    && E.exposureGroup(it({ key: 'a', p: 'lb', pos: 'LB', m: 'tackles_ast', team: 'NO', opp: 'ATL' })) === 'G1|ATL|up');
  const x5 = E.exposure([it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds', value: 90 }), it({ key: 'b', p: 'wr', pos: 'WR', m: 'rec_yds', value: 80 }), it({ key: 'c', p: 'wr2', pos: 'WR', m: 'rec_yds', value: 70 })], model);
  chk('three Overs on one offence are ONE exposure: the highest-value one keeps its stake, the others give way to the group', !x5.a && x5.b && x5.b.units === 0 && x5.b.code === 'GROUP_EXPOSURE' && x5.c && x5.c.units === 0 && x5.c.code === 'GROUP_EXPOSURE' && x5.b.group === 'G1|ATL|up', x5);
  /* the audit's Colts group: 8 BETs in IND @ WAS at 0.25U — seven on the
     Colts' offence having a quiet day, one (Taylor's carries) on a big one.
     The correlation model lists no pair among most of them, so √(uᵀRu) read
     them as independent and the 2U game cap never bound. */
  const colts = [['taylor', 'RB', 'rec_yds', 'under', 45.6], ['taylor', 'RB', 'receptions', 'under', 56.3], ['taylor', 'RB', 'rush_att', 'over', 48.8], ['downs', 'WR', 'rec_yds', 'under', 115],
    ['downs', 'WR', 'receptions', 'under', 114.8], ['allen', 'WR', 'receptions', 'under', 68.1], ['jones', 'QB', 'rush_att', 'under', 95.2], ['jones', 'QB', 'rush_yds', 'under', 121.7]]
    .map((c, i) => ({ key: 'k' + i, g: '2026_04_IND_WAS', p: c[0], team: 'IND', opp: 'WAS', pos: c[1], m: c[2], side: c[3], units: 0.25, value: c[4] }));
  const realCorr = (() => { try { return require(path.join(ROOT, 'football', 'props', 'nfl', 'correlation.json')); } catch (e) { return null; } })();
  const xc = E.exposure(colts, realCorr);
  const staked = colts.filter((c) => !xc[c.key] || xc[c.key].units > 0);
  chk('the Colts group: the seven quiet-day props are one exposure (one 0.25U stake), Taylor\'s carries Over is its own', staked.length === 2 && staked.some((c) => c.m === 'rush_att' && c.p === 'taylor')
    && colts.filter((c) => c.side === 'under' || c.m !== 'rush_att' || c.p !== 'taylor').filter((c) => xc[c.key] && xc[c.key].code === 'GROUP_EXPOSURE' && xc[c.key].units === 0).length === 6, xc);
  chk('…the one kept is the highest-value member (Jones rush yards Under)', staked.some((c) => c.p === 'jones' && c.m === 'rush_yds'));
  chk('…and the game carries 0.5U, not 2U', staked.reduce((a, c) => a + (xc[c.key] ? xc[c.key].units : c.units), 0) === 0.5);
  const x4 = E.exposure([it({ key: 'a', p: 'qb', pos: 'QB', m: 'pass_yds' }), it({ key: 'b', p: 'wr', pos: 'WR', m: 'rec_yds', g: 'G2' }), it({ key: 'c', p: 'rb', pos: 'RB', m: 'rush_yds', g: 'G3' })], model);
  chk('bets in different games never cap each other', Object.keys(x4).length === 0);
  const ev = E.evaluate(prop({ quotes: two }), OPTS);
  const capped = E.applyExposure(ev, { units: 0, from: ev.units, code: 'CORRELATED_EXPOSURE', text: 't' });
  chk('a BET cut to zero units becomes a LEAN with the exposure code, and the original is not touched', ev.decision === 'BET' && capped.decision === 'LEAN' && capped.code === 'CORRELATED_EXPOSURE' && capped.units === 0 && capped.caps.some((c) => c.code === 'CORRELATED_EXPOSURE') && ev.units > 0, [ev.decision, capped.decision]);
  const cc = E.exposeCompact(E.compact(ev), { units: 0.5, from: 1, code: 'PLAYER_EXPOSURE', text: 't' });
  chk('the compact row carries the capped units and what it was capped from', cc.u === 0.5 && cc.d === 'BET' && cc.xp[0] === 'PLAYER_EXPOSURE' && cc.xp[1] === 1);
}

console.log('\n' + (fail ? 'FAILED ' : 'ALL GREEN ') + 'player props kernel — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((m) => console.log('  ✗ ' + m)); process.exit(1); }
