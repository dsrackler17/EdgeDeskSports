#!/usr/bin/env node
/* ===========================================================================
   THE FAIR-ODDS ENGINE (lib/edgedesk_fairodds.js, EDFAIR) — typed units,
   exact decimals, venue fees, contract and wager expected value, the maximum
   entry price, the cross-venue comparison and the verdict caps.

   Every assertion is about a mistake a customer would pay for: a percent read
   as a probability, cents read as dollars, one venue's fee applied to
   another, a fee rounded the wrong way, a maximum price that does not clear
   its own floor, a negative-EV contract called an edge, an unverified fee
   schedule or a research-tier model passed off as a verified edge.

   Run: node tools/intelligence/fairodds.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'research_core.js'));
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function near(name, a, b, tol) { chk(name, a != null && Math.abs(Number(a) - Number(b)) <= (tol == null ? 1e-9 : tol), { got: a, want: b }); }
function throwsCode(name, fn, code) { try { fn(); chk(name, false, 'did not throw'); } catch (e) { chk(name, e.code === code, { got: e.code, want: code, msg: e.message }); } }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 500)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const NOW = Date.parse('2026-10-11T22:00:00Z');
const FRESH = '2026-10-11T21:55:00Z';      /* 5 minutes old */
const STALE = '2026-10-11T17:00:00Z';      /* 300 minutes old */
const SHARP = { kind: 'SHARP_NO_VIG', label: 'Pinnacle no-vig', observed_at: FRESH };
const AUDIT_OK = { status: 'CONFIRMED' };

/* ═══ 1. AMERICAN ODDS CONVERSION ═══════════════════════════════════════ */
{
  eq('+150 → 2.5 exactly', F.americanToDecimal(150), '2.5');
  eq('"+150" string → 2.5', F.americanToDecimal('+150'), '2.5');
  eq('-110 → 1.909090909091 (12 places)', F.americanToDecimal(-110), '1.909090909091');
  eq('-200 → 1.5', F.americanToDecimal(-200), '1.5');
  eq('+100 → 2', F.americanToDecimal(100), '2');
  eq('-100 → 2', F.americanToDecimal(-100), '2');
  eq('2.5 → +150', F.decimalToAmerican(2.5), '150');
  eq('1.5 → -200', F.decimalToAmerican('1.5'), '-200');
  eq('2.0 → +100 (the even-money point prints positive)', F.decimalToAmerican(2), '100');
  throwsCode('-50 is not an American price', () => F.T.american(-50), 'AMERICAN_RANGE');
  throwsCode('+50 is not an American price', () => F.T.american(50), 'AMERICAN_RANGE');
  throwsCode('0 is not an American price', () => F.T.american(0), 'AMERICAN_RANGE');
  throwsCode('junk is not a number', () => F.T.american('abc'), 'NOT_A_NUMBER');
  throwsCode('1.91 passed as American is refused with a decimal hint', () => F.T.american('1.91'), 'AMERICAN_RANGE');
  throwsCode('150 passed as decimal odds is refused as American-looking', () => F.T.decimalOdds(150), 'DECIMAL_LOOKS_AMERICAN');
  throwsCode('decimal odds of 1.0 are refused', () => F.T.decimalOdds(1), 'DECIMAL_RANGE');
  /* parity with the canonical strict helper (float) across a grid */
  [-10000, -1000, -500, -250, -150, -125, -115, -110, -105, -101, -100, 100, 101, 105, 110, 120, 150, 200, 240, 300, 1000, 5000].forEach((a) => {
    near('parity with R.americanToDecimal(' + a + ')', F.americanToDecimal(a), R.americanToDecimal(a), 1e-11);
    near('parity with R.impliedProb(' + a + ')', F.impliedFromAmerican(a), R.impliedProb(a), 1e-11);
  });
  [1.01, 1.5, 1.8, 1.909, 1.95, 2, 2.1, 2.5, 3, 11].forEach((d) => near('parity with R.decimalToAmerican(' + d + ')', F.decimalToAmerican(d), R.decimalToAmerican(d), 1e-8));
  /* round trip */
  [-400, -175, -110, 100, 135, 260].forEach((a) => near('round trip ' + a, F.decimalToAmerican(F.americanToDecimal(a)), a, 1e-8));
  eq('probability 0.5 → +100 fair', F.wholeAmerican(F.probToAmerican(0.5)), 100);
  eq('probability 0.6 → -150 fair', F.wholeAmerican(F.probToAmerican(0.6)), -150);
  eq('probability 0.4 → +150 fair', F.wholeAmerican(F.probToAmerican(0.4)), 150);
  eq('probability 0 and 1 have no fair price', [F.probToAmerican(0), F.probToAmerican(1)], [null, null]);
}

/* ═══ 2. TYPED UNITS — the wrong unit is refused, never guessed ═════════ */
{
  throwsCode('61 as a probability is refused (a percent)', () => F.T.probability(61), 'PROBABILITY_RANGE');
  try { F.T.probability(61); } catch (e) { chk('…and the error names the percent', /percent/.test(e.message), e.message); }
  throwsCode('-0.1 as a probability is refused', () => F.T.probability(-0.1), 'PROBABILITY_RANGE');
  eq('percent 61 → probability 0.61', F.T.probability(F.T.percent(61)).value, '0.61');
  throwsCode('0.61 as cents is refused (dollars)', () => F.T.cents(0.61), 'CENTS_LOOKS_LIKE_DOLLARS');
  throwsCode('61 as a dollar contract price is refused (cents)', () => F.T.contractPrice(61), 'CONTRACT_PRICE_RANGE');
  try { F.T.contractPrice(61); } catch (e) { chk('…and the error names cents', /cents/.test(e.message), e.message); }
  throwsCode('100 cents is not a contract price', () => F.T.cents(100), 'CENTS_RANGE');
  throwsCode('0 cents is not a contract price', () => F.T.cents(0), 'CENTS_RANGE');
  eq('61 cents → $0.61', F.T.contractPrice(F.T.cents(61)).value, '0.61');
  eq('a binary float reads through its shortest string: 0.1 + 0.2 is not smuggled in', F.S(F.D(0.1 + 0.2)), '0.30000000000000004');
  eq('exact decimal: 0.1 + 0.2 = 0.3', F.S(F.dec.add(F.D('0.1'), F.D('0.2'))), '0.3');
  eq('ceil to cent: 0.016653 → 0.02', F.S(F.dec.ceilTo(F.D('0.016653'), 2)), '0.02');
  eq('ceil to cent: an exact cent stays: 1.75 → 1.75', F.S(F.dec.ceilTo(F.D('1.75'), 2)), '1.75');
  eq('floor to cent: -0.011 → -0.02', F.S(F.dec.floorTo(F.D('-0.011'), 2)), '-0.02');
  const r = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 65, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  chk('a contract evaluated with a percent fair is an error, not a guess', !r.ok && r.error.code === 'PROBABILITY_RANGE' && r.classification === 'UNVERIFIED_DATA' && r.decision === 'PASS', r.error);
  const r2 = F.evaluateContract({ venue: 'kalshi', side: 'YES', price: 61, fair_probability: 0.65, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  chk('a contract priced at "61 dollars" is an error naming cents', !r2.ok && r2.error.code === 'CONTRACT_PRICE_RANGE' && /cents/.test(r2.error.message), r2.error);
}

/* ═══ 3. NO-VIG PROBABILITIES ═══════════════════════════════════════════ */
{
  const a = F.noVig([{ american: -110 }, { american: -110 }]);
  chk('-110/-110 → 50/50', a.ok && a.probabilities[0] === '0.5' && a.probabilities[1] === '0.5', a);
  near('-110/-110 overround 4.7619%', a.overround, 0.047619, 1e-6);
  const b = F.noVig([{ american: -150 }, { american: 130 }]);
  const rb = R.noVigTwoWay(-150, 130);
  near('-150/+130 multiplicative matches R.noVigTwoWay', b.probabilities[0], rb.a, 1e-11);
  near('…and sums to 1', Number(b.probabilities[0]) + Number(b.probabilities[1]), 1, 1e-11);
  const s = F.noVig([{ decimal: 2.4 }, { decimal: 3.4 }, { decimal: 3.1 }]);
  near('a three-way soccer market sums to 1', s.probabilities.reduce((x, y) => x + Number(y), 0), 1, 1e-11);
  ['additive', 'power'].forEach((m) => { const x = F.noVig([{ american: -150 }, { american: 130 }], m); near(m + ' sums to 1', Number(x.probabilities[0]) + Number(x.probabilities[1]), 1, 1e-9); });
  const pw = F.noVig([{ american: -400 }, { american: 300 }], 'power');
  const mu = F.noVig([{ american: -400 }, { american: 300 }], 'multiplicative');
  chk('power gives the favourite more than multiplicative (favourite-longshot)', Number(pw.probabilities[0]) > Number(mu.probabilities[0]), [pw.probabilities, mu.probabilities]);
  const one = F.noVig([{ american: -150 }]);
  chk('a single side is refused: its margin is unknown', !one.ok && one.code === 'ONE_SIDED', one);
  const kc = F.noVig([{ contract_price: 0.61 }, { contract_price: 0.41 }]);
  near('contract YES 61¢ / NO 41¢ → no-vig 0.598', kc.probabilities[0], 0.61 / 1.02, 1e-11);
}

/* ═══ 4. VENUE FEES AND ROUNDING ════════════════════════════════════════ */
{
  const f1 = F.contractFee('kalshi', '0.61', 1, 'taker');
  eq('Kalshi taker, 1 @ 61¢: 0.07×0.61×0.39 = 0.016653 → rounds UP to 2¢', [f1.total, f1.per_contract], ['0.02', '0.02']);
  eq('…its schedule is UNVERIFIED (not checked against Kalshi itself)', f1.status, 'UNVERIFIED');
  const f2 = F.contractFee('kalshi', '0.55', 100, 'taker');
  eq('Kalshi taker, 100 @ 55¢: 1.7325 → $1.74 (the published worked example)', f2.total, '1.74');
  const f3 = F.contractFee('kalshi', '0.50', 100, 'taker');
  eq('Kalshi taker, 100 @ 50¢: exactly 1.75 is not rounded up', f3.total, '1.75');
  eq('Kalshi fee is symmetric in price and 1 − price', F.contractFee('kalshi', '0.30', 10, 'taker').total, F.contractFee('kalshi', '0.70', 10, 'taker').total);
  eq('Kalshi maker on a market without maker fees pays nothing', F.contractFee('kalshi', '0.50', 100, 'maker').total, '0');
  eq('Kalshi maker on a maker-fee market: 0.0175×100×0.25 = 0.4375 → 0.44', F.contractFee('kalshi', '0.50', 100, 'maker', { market_maker_fees: true }).total, '0.44');
  const pm = F.contractFee('polymarket', '0.61', 1, 'taker');
  eq('Polymarket sports fee parameters are unknown: no fee is assumed', [pm.status, pm.total], ['UNKNOWN', null]);
  const pmo = F.contractFee('polymarket', '0.50', 100, 'taker', { override: { rate: '0.03', exponent: 1, source: 'operator' } });
  eq('Polymarket with operator parameters: 100×0.5×0.03×0.25 = 0.375', [pmo.status, pmo.total], ['OVERRIDE', '0.375']);
  const ov = F.contractFee('kalshi', '0.61', 3, 'taker', { override: { per_contract_dollars: '0.01', verified: true, source: 'reader' } });
  eq('a verified per-contract override replaces the schedule and says so', [ov.status, ov.total], ['VERIFIED', '0.03']);
  eq('a sportsbook has no explicit fee', F.contractFee('draftkings', '0.5', 1, 'taker').total, '0');
  eq('an unknown venue gets no fee model at all', F.contractFee('acme_exchange', '0.5', 1), null);
  const r = F.evaluateContract({ venue: 'acme_exchange', side: 'YES', price_cents: 50, fair_probability: 0.6 });
  chk('an unknown venue is refused, not priced with Kalshi\'s formula', !r.ok && r.error.code === 'UNKNOWN_VENUE', r.error);
}

/* ═══ 5. PREDICTION-CONTRACT PRICING — positive and negative EV ═════════ */
{
  /* Rays YES at 61¢ on Kalshi; sharp no-vig 65% */
  const r = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, opposite_price_cents: 41, fair_probability: 0.65, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, settlement: { verified: true } });
  chk('evaluated', r.ok, r.error);
  eq('market probability = the price', r.market_probability, '0.61');
  near('no-vig from YES 61 / NO 41', r.no_vig_market_probability, 0.61 / 1.02, 1e-11);
  eq('gross EV = fair − price, exactly', r.gross_expected_value, '0.04');
  eq('fee per contract 2¢', r.expected_fees.per_contract, '0.02');
  eq('net EV = fair − price − fee − slippage = 2¢', r.net_expected_value, '0.02');
  eq('break-even = all-in cost 63¢', r.break_even_probability, '0.63');
  eq('probability edge = fair − break-even', r.probability_edge, '0.02');
  near('net EV per dollar = 0.02 / 0.63', r.net_ev_per_dollar, 0.02 / 0.63, 1e-8);
  eq('fair price 65% → -186', r.fair_american_odds, -186);
  eq('maximum entry (0.5% floor, after fees) = 62¢', r.maximum_entry_price, '0.62');
  eq('maximum entry for the 2% edge bar = 61¢', r.maximum_edge_entry_price, '0.61');
  eq('break-even entry = 63¢', r.break_even_entry_price, '0.63');
  eq('market-derived fair is not called independent', r.independent_fair_probability, null);
  eq('…and its calibration is MARKET_DERIVED', r.calibration_status, 'MARKET_DERIVED');
  eq('a clean 3.2% net edge with an UNVERIFIED fee schedule, no book depth and no audit is a POTENTIAL EDGE, not a buy', [r.classification, r.decision], ['POTENTIAL_EDGE', 'WATCH']);
  chk('…and every cap is named', r.caps.some((c) => /fee schedule/.test(c.reason)) && r.caps.some((c) => /order-book/.test(c.reason)) && r.caps.some((c) => /audit/.test(c.reason)), r.caps);
  chk('research confidence is a category with its basis, not a score', ['HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT'].includes(r.research_confidence.level) && /not a fitted score/.test(r.research_confidence.basis), r.research_confidence);

  const neg = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 0.6, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('fair 60% at 61¢: gross −1¢, net −3¢', [neg.gross_expected_value, neg.net_expected_value], ['-0.01', '-0.03']);
  eq('…is a PASS', [neg.classification, neg.decision], ['PASS', 'PASS']);
  chk('…and the reason says the price is worse than the fair supports', /worse than the fair/.test(neg.reasons[0]), neg.reasons);
  eq('…the most it is worth paying is 57¢ (at 58¢ the all-in cost is 60¢: zero EV)', neg.maximum_entry_price, '0.57');

  /* NO side: fair YES 0.30 → NO fair 0.70 */
  const no = F.evaluateContract({ venue: 'kalshi', side: 'NO', price_cents: 64, fair_probability_yes: 0.3, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('NO side reads the complement of the YES fair', no.fair_probability, '0.7');
  eq('NO at 64¢: gross 6¢', no.gross_expected_value, '0.06');

  /* thin: positive but under the floor */
  const thin = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 0.632, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('net +0.2¢ (0.32% per $) is under the 0.5% floor: PASS', thin.classification, 'PASS');
  const lean = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 0.637, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('net +0.7¢ (1.1% per $) clears the floor, not the edge bar: WATCH', lean.classification, 'WATCH');
}

/* ═══ 6. SPORTSBOOK EV, PUSHES AND THE MAXIMUM ENTRY PRICE ══════════════ */
{
  const even = F.evaluateWager({ book: 'draftkings', american: 100, fair_probability: 0.55, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('+100 with a 55% fair: EV = 0.55×1 − 0.45 = +0.10', even.net_expected_value, '0.1');
  const vig = F.evaluateWager({ book: 'fanduel', american: -110, fair_probability: 0.5, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  near('-110 with a 50% fair: EV = −4.545%', vig.net_expected_value, -0.045455, 1e-6);
  eq('…PASS', vig.classification, 'PASS');
  const push = F.evaluateWager({ book: 'betmgm', american: -110, fair_probability: 0.48, push_probability: 0.04, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  near('push refunded: break-even = 0.96 / 1.90909', push.break_even_probability, 0.502857, 1e-6);
  near('push-aware EV = 0.48×0.90909 − 0.48', push.net_expected_value, 0.48 * (100 / 110) - 0.48, 1e-6);
  throwsCode('win + push above 1 is refused', () => { const x = F.evaluateWager({ american: -110, fair_probability: 0.7, push_probability: 0.4 }); if (!x.ok) { const e = new Error(x.error.message); e.code = x.error.code; throw e; } }, 'PROBABILITY_SUM');
  const m = F.evaluateWager({ book: 'draftkings', american: -105, fair_probability: 0.55, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('max entry for a 55% fair at the 0.5% floor is -120', m.maximum_entry_price, -120);
  const at120 = F.evaluateWager({ american: -120, fair_probability: 0.55, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  const at121 = F.evaluateWager({ american: -121, fair_probability: 0.55, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  chk('…-120 clears the floor', Number(at120.net_ev_per_dollar) >= 0.005, at120.net_ev_per_dollar);
  chk('…-121 does not', Number(at121.net_ev_per_dollar) < 0.005, at121.net_ev_per_dollar);
  const dog = F.evaluateWager({ american: 160, fair_probability: 0.4, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, thresholds: { ev_floor: 0 } });
  eq('a 40% fair breaks even at +150', dog.maximum_entry_price, 150);
  const coin = F.evaluateWager({ american: 105, fair_probability: 0.5, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, thresholds: { ev_floor: 0 } });
  eq('a 50% fair breaks even at +100 (never -100)', coin.maximum_entry_price, 100);
  const stake = F.evaluateWager({ american: 100, fair_probability: 0.55, fair_source: SHARP, stake_dollars: 20, quote_observed_at: FRESH, now: NOW });
  eq('$20 at +100 with a 55% fair: expected profit $2', stake.net_expected_profit, '2');
  near('at the fair price itself EV is zero', F.evaluateWager({ american: Number(F.probToAmerican(0.6)), fair_probability: 0.6 }).net_expected_value, 0, 1e-9);
}

/* ═══ 7. STALE MARKETS, MISSING DATA AND THE VERDICT CAPS ═══════════════ */
{
  const base = { book: 'pinnacle', american: 120, fair_probability: 0.5, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, confirmation: { pass: true, books: 4 }, audit: AUDIT_OK };
  const ok = F.evaluateWager(base);
  eq('fresh, sharp-referenced, confirmed, audited, +10% EV: VERIFIED EDGE / BUY', [ok.classification, ok.label, ok.decision], ['VERIFIED_EDGE', 'VERIFIED EDGE', 'BUY']);
  const stale = F.evaluateWager(Object.assign({}, base, { quote_observed_at: STALE }));
  eq('the same price 300 minutes old: UNVERIFIED DATA / PASS', [stale.classification, stale.decision], ['UNVERIFIED_DATA', 'PASS']);
  eq('…and the freshness reads STALE', stale.data_freshness.quote.status, 'STALE');
  const noTime = F.evaluateWager(Object.assign({}, base, { quote_observed_at: null }));
  eq('a quote with no capture time is never actionable', noTime.classification, 'UNVERIFIED_DATA');
  const future = F.evaluateWager(Object.assign({}, base, { quote_observed_at: '2026-10-11T23:30:00Z' }));
  eq('a quote timestamped in the future is UNKNOWN', future.data_freshness.quote.status, 'UNKNOWN');
  const aging = F.evaluateWager(Object.assign({}, base, { quote_observed_at: '2026-10-11T20:00:00Z' }));
  eq('an aging quote caps at POTENTIAL EDGE', aging.classification, 'POTENTIAL_EDGE');
  const noFair = F.evaluateWager(Object.assign({}, base, { fair_probability: null }));
  eq('no fair probability: UNVERIFIED DATA, never an invented one', [noFair.classification, noFair.net_expected_value], ['UNVERIFIED_DATA', null]);
  const research = F.evaluateWager(Object.assign({}, base, { fair_source: { kind: 'MODEL', tier: 'RESEARCH', label: 'edgedesk_baseball_v1.0.0', observed_at: FRESH } }));
  eq('a RESEARCH-tier model at +10% EV is capped at WATCH', research.classification, 'WATCH');
  chk('…and the cap says research only', research.caps.some((c) => /research/.test(c.reason)), research.caps);
  eq('…with no calibration claim', research.calibration_status, 'UNCALIBRATED');
  const validated = F.evaluateWager(Object.assign({}, base, { fair_source: { kind: 'MODEL', tier: 'VALIDATED', label: 'm', observed_at: FRESH } }));
  eq('a VALIDATED model may price, and is independent', [validated.classification, validated.independent_fair_probability, validated.calibration_status], ['VERIFIED_EDGE', '0.5', 'CALIBRATED']);
  const outlier = F.evaluateWager(Object.assign({}, base, { american: 200 }));
  eq('+50% EV is past the sanity ceiling: WATCH, a data check', outlier.classification, 'WATCH');
  const single = F.evaluateWager(Object.assign({}, base, { confirmation: { pass: false, books: 1 } }));
  eq('one book with no confirmation caps at POTENTIAL EDGE', single.classification, 'POTENTIAL_EDGE');
  const rejected = F.evaluateWager(Object.assign({}, base, { audit: { status: 'REJECTED', reason: 'starting pitcher changed' } }));
  eq('an audit rejection is a PASS whatever the EV', [rejected.classification, rejected.decision], ['PASS', 'PASS']);
  const noAudit = F.evaluateWager(Object.assign({}, base, { audit: null }));
  eq('no audit yet caps at POTENTIAL EDGE', noAudit.classification, 'POTENTIAL_EDGE');
  const wide = F.evaluateWager(Object.assign({}, base, { fair_interval: { low: 0.44, high: 0.56 } }));
  eq('negative EV at the low end of the interval caps at POTENTIAL EDGE', wide.classification, 'POTENTIAL_EDGE');
  const settle = F.evaluateWager(Object.assign({}, base, { settlement: { verified: false, mismatch: 'regulation-only vs including overtime', mismatch_severity: 'MATERIAL' } }));
  eq('a material settlement mismatch caps at WATCH', settle.classification, 'WATCH');
  const unk = F.evaluateContract({ venue: 'polymarket', side: 'YES', price_cents: 55, fair_probability: 0.62, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('unknown Polymarket fees: net EV not computed, WATCH', [unk.net_expected_value, unk.classification], [null, 'WATCH']);
  eq('…but the fee headroom is stated: 7¢', unk.fee_headroom, '0.07');
  chk('…in words', /absorb up to 7.00¢/.test(unk.reasons[0]), unk.reasons);
  const neg2 = F.evaluateContract({ venue: 'polymarket', side: 'YES', price_cents: 66, fair_probability: 0.62, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('unknown fees but already negative before fees: PASS, not WATCH', [neg2.classification, neg2.net_expected_value], ['PASS', null]);
  const un = F.evaluateContract({ venue: 'unspecified', side: 'YES', price_cents: 55, fair_probability: 0.62, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('a contract with no venue named gets no fee model: fees UNKNOWN, net EV not computed', [un.expected_fees.status, un.net_expected_value, un.venue.label], ['UNKNOWN', null, 'an unnamed exchange']);
}

/* ═══ 8. SIZE, ORDER BOOK AND SLIPPAGE ══════════════════════════════════ */
{
  const r = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, stake_dollars: 20, fair_probability: 0.65, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('$20 buys 31 contracts at 61¢ once fees are counted (32 would cost $20.06)', r.contracts, 31);
  eq('…order fee ceil(0.07×31×0.61×0.39) = $0.52', r.expected_fees.total, '0.52');
  const tooSmall = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, stake_dollars: '0.5', fair_probability: 0.65 });
  chk('a stake that buys nothing is said so', !tooSmall.ok && tooSmall.error.code === 'STAKE_TOO_SMALL', tooSmall.error);
  const book = { asks: [[0.61, 10], [0.62, 10], [0.64, 100]] };
  const w = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, contracts: 25, orderbook: book, fair_probability: 0.7, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('walking the book for 25: average fill 62¢, slippage 1¢', [w.execution_price, w.estimated_slippage.per_contract], ['0.62', '0.01']);
  eq('…and the book fills it', w.market_liquidity.status, 'ADEQUATE');
  const big = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, contracts: 200, orderbook: book, fair_probability: 0.8, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
  eq('200 contracts against 120 on the book: INSUFFICIENT liquidity caps at WATCH', [big.market_liquidity.status, big.classification], ['INSUFFICIENT', 'WATCH']);
  const est = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, slippage_cents: 0.5, fair_probability: 0.65, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('an explicit half-cent slippage estimate is used', est.estimated_slippage.per_contract, '0.005');
}

/* ═══ 9. CROSS-VENUE COMPARISON AND SETTLEMENT ═══════════════════════════ */
{
  eq('-150 costs 60¢ per $1 of payout', F.equivalentCents(-150), '60.00');
  eq('+150 costs 40¢ per $1', F.equivalentCents(150), '40.00');
  eq('61¢ pays like -156', F.contractToAmerican(61), -156);
  const c = F.compareVenues([
    { venue: 'kalshi', side: 'YES', price_cents: 61 },
    { book: 'draftkings', american: -150 },
    { book: 'fanduel', american: -145 },
    { venue: 'polymarket', side: 'YES', price_cents: 58 }
  ], { fair_probability: 0.62, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  eq('ranked by all-in cost: FanDuel -145, DraftKings -150, Kalshi 61¢ + fee', c.ranked.map((x) => x.venue), ['fanduel', 'draftkings', 'Kalshi']);
  eq('…Kalshi all-in is 63¢', c.ranked[2].all_in_cost_cents, '63.00');
  chk('…and Polymarket is listed as not priced (fees unknown), not silently dropped', c.not_priced.length === 1 && /fee schedule unknown/.test(c.not_priced[0].why), c.not_priced);
}

/* ═══ 10. PARSING A PRICE OUT OF A QUESTION ═════════════════════════════ */
{
  const a = F.parsePrice('Analyze Rays vs. Guardians and tell me whether Rays at 61¢ is positive EV.');
  eq('"Rays at 61¢" → 61 cents, no venue named', [a.contract && a.contract.price_cents, a.venue], ['61', null]);
  chk('…and no venue is assumed', /without a venue/.test(a.venue_note || ''), a);
  const b = F.parsePrice('Is Cleveland +1.5 at 61 cents a good price on Kalshi?');
  eq('"+1.5 at 61 cents on Kalshi" → kalshi, 61, the spread is not read as odds', [b.venue, b.contract.price_cents, b.american], ['kalshi', '61', null]);
  eq('"Guardians -150" → American -150', F.parsePrice('Guardians -150 tonight').american, -150);
  eq('"YES at $0.61" → 61¢, side YES', [F.parsePrice('buy YES at $0.61?').contract.price_cents, F.parsePrice('YES at $0.61').side], ['61', 'YES']);
  eq('"61c" → 61', F.parsePrice('Rays 61c').contract.price_cents, '61');
  eq('a year is not a price', F.parsePrice('the 2026 season').american, null);
  eq('"+1500" is a price', F.parsePrice('Dodgers +1500').american, 1500);
}

/* ═══ 11. INVARIANTS — a sweep the arithmetic must survive ══════════════ */
{
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let invBad = 0, maxBad = 0, clsBad = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const fair = Math.round((0.05 + rnd() * 0.9) * 1000) / 1000;
    const cents = 1 + Math.floor(rnd() * 98);
    const k = 1 + Math.floor(rnd() * 60);
    const r = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: cents, contracts: k, fair_probability: fair, fair_source: SHARP, quote_observed_at: FRESH, now: NOW, audit: AUDIT_OK, settlement: { verified: true } });
    if (!r.ok) { invBad++; continue; }
    n++;
    const net = Number(r.gross_expected_value) - Number(r.expected_fees.per_contract) - Number(r.estimated_slippage.per_contract);
    if (Math.abs(net - Number(r.net_expected_value)) > 1e-6) invBad++;
    if (Math.sign(Number(r.net_expected_value)) !== Math.sign(Number(r.net_ev_per_dollar))) invBad++;
    if (r.break_even_probability !== String(Number(r.all_in_cost))) { if (Math.abs(Number(r.break_even_probability) - Number(r.all_in_cost)) > 1e-6) invBad++; }
    if (r.maximum_entry_price != null) {
      if (Number(r.maximum_entry_price) >= fair) maxBad++;
      const at = F.evaluateContract({ venue: 'kalshi', side: 'YES', price: r.maximum_entry_price, contracts: k, fair_probability: fair, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
      if (Number(at.net_ev_per_dollar) < 0.005 - 1e-9) maxBad++;
      const nextC = Math.round(Number(r.maximum_entry_price) * 100) + 1;
      if (nextC < 100) { const nx = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: nextC, contracts: k, fair_probability: fair, fair_source: SHARP, quote_observed_at: FRESH, now: NOW }); if (Number(nx.net_ev_per_dollar) >= 0.005) maxBad++; }
    }
    if ((r.classification === 'VERIFIED_EDGE' || r.classification === 'POTENTIAL_EDGE') && Number(r.net_ev_per_dollar) < 0.02) clsBad++;
    if (r.classification === 'VERIFIED_EDGE' && Number(r.net_ev_per_dollar) <= 0) clsBad++;
  }
  eq('400 random contracts: net EV = gross − fee − slippage, signs agree, break-even = all-in cost', invBad, 0);
  eq('the maximum entry price clears its floor, sits below the fair, and the next tick does not clear', maxBad, 0);
  eq('nothing under the edge bar is ever called an edge', clsBad, 0);
  chk('the sweep evaluated every case', n === 400, n);
  let wBad = 0;
  for (let i = 0; i < 300; i++) {
    const fair = Math.round((0.05 + rnd() * 0.9) * 1000) / 1000;
    const am = rnd() < 0.5 ? -(100 + Math.floor(rnd() * 900)) : 100 + Math.floor(rnd() * 900);
    const r = F.evaluateWager({ american: am, fair_probability: fair, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
    const d = R.americanToDecimal(am);
    if (Math.abs(Number(r.net_expected_value) - (fair * (d - 1) - (1 - fair))) > 1e-6) wBad++;
    if (Math.abs(Number(r.break_even_probability) - 1 / d) > 1e-6) wBad++;
    if (r.maximum_entry_price != null) {
      const at = F.evaluateWager({ american: r.maximum_entry_price, fair_probability: fair });
      if (Number(at.net_ev_per_dollar) < 0.005 - 1e-9) wBad++;
    }
  }
  eq('300 random wagers: EV matches p(D−1) − (1−p), break-even = 1/D, max entry clears the floor', wBad, 0);
}

/* ═══ 12. THRESHOLDS ARE THE DECISION LAYER'S OWN ═══════════════════════ */
{
  const before = F.thresholds();
  eq('without EDINTEL loaded the documented defaults apply', [before.ev_floor, before.candidate_ev, before.source], ['0.005', '0.02', 'EDFAIR defaults (EDINTEL not loaded)']);
  require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));
  const after = F.thresholds();
  const I = globalThis.EDINTEL;
  const cfg = I.CONFIG || (typeof I.config === 'function' ? I.config() : null);
  chk('EDINTEL exposes its config', !!cfg, Object.keys(I).slice(0, 20));
  eq('with EDINTEL loaded the floors are read from it', [after.ev_floor, after.candidate_ev, after.source], [String(cfg.ev_floor), String(cfg.candidate_ev), 'EDINTEL.CONFIG']);
}

/* ═══ 13. THE PLAIN-LANGUAGE ANSWER ═════════════════════════════════════ */
{
  const r = F.evaluateContract({ venue: 'kalshi', side: 'YES', price_cents: 61, fair_probability: 0.6, fair_source: SHARP, quote_observed_at: FRESH, now: NOW });
  const x = F.explain(r, { selection: 'Rays YES' });
  chk('the verdict leads', /^PASS: Rays YES at 61¢ on Kalshi\./.test(x.headline), x.headline);
  chk('every required line is present', ['Available price', 'Fair probability', 'Fees', 'Break-even', 'Net EV', 'Maximum entry', 'Calibration', 'Decision'].every((k) => x.lines.some((l) => l[0] === k)), x.lines.map((l) => l[0]));
  chk('no certainty words', !/guarantee|lock|sure thing|can't lose/i.test(JSON.stringify(x)), x);
}

done();
