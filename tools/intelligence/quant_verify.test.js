#!/usr/bin/env node
/* ===========================================================================
   EDQVERIFY — the calculation ledger and the number verifier
   (lib/edgedesk_quant_verify.js), over real EDFAIR evaluations.
   Checks hand-computed values, the independent recomputation (and that a
   tampered engine value is caught), every record's version, formula, inputs
   and assumptions, the market comparison marked UNAVAILABLE without a
   verified price (nothing substituted), the line discrepancy and its cover
   probability, calibration from the real NFL validation artifact, and the
   number verifier on labelled, unlabelled and invented numbers.
   Run: node tools/intelligence/quant_verify.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'lib', 'edgedesk_fairodds.js'));
const Q = require(path.join(ROOT, 'lib', 'edgedesk_quant_verify.js'));
const A = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_agents.js'));
const VAL = require(path.join(ROOT, 'football', 'validation', 'pricing_nfl.json'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : '')); }
const NOW = Date.parse('2026-10-12T15:00:00Z');
const ago = (m) => new Date(NOW - m * 60000).toISOString();
const near = (a, b, t) => a != null && b != null && Math.abs(a - b) <= (t || 1e-9);
const rec = (L, n) => Q.byName(L, n);

/* ---------------- a sportsbook wager: -110 against a 55% de-vigged fair ---------------- */
const ev1 = F.evaluateWager({ book: 'draftkings', american: -110, fair_probability: '0.55', fair_source: { kind: 'SHARP_NO_VIG', label: 'Pinnacle de-vig', observed_at: ago(10) }, quote_observed_at: ago(20), now: NOW, ttl_min: 90 });
const q1 = { american: -110, book: 'draftkings', captured_at: ago(20), source: 'edgedesk://supabase/signals/ev-x' };
const L1 = Q.forCandidate(ev1, { quote: q1, fair: { method: 'MARKET_DEVIG', label: 'Pinnacle de-vig fair' }, now: NOW });
ok('ledger: schema, market comparison AVAILABLE, every engine value agrees with the recomputation', L1.schema === Q.VERSION && L1.market_comparison.status === 'AVAILABLE' && L1.verification.verdict === 'VERIFIED' && L1.verification.mismatches.length === 0 && L1.verification.checked >= 6, L1.verification);
ok('implied: -110 → 52.38% (hand: 110/210)', near(rec(L1, 'IMPLIED_PROBABILITY').output.value, 110 / 210, 1e-6) && rec(L1, 'IMPLIED_PROBABILITY').output.display === '52.4%');
ok('break-even: 52.38% with no push', near(rec(L1, 'BREAK_EVEN').output.value, 0.52381, 1e-9));
ok('EV: 0.55 × (210/110 − 1) − 0.45 = +$0.05 per $1 (hand)', near(rec(L1, 'EXPECTED_VALUE').output.value, 0.55 * (100 / 110) - 0.45, 1e-6) && rec(L1, 'EXPECTED_VALUE').output.net === true);
ok('fair odds: 55% → -122 (hand: -100·0.55/0.45 = -122.2)', rec(L1, 'FAIR_ODDS').output.value === -122);
ok('edge: 0.55 − 0.52381 = 2.62 pp', near(rec(L1, 'PROBABILITY_EDGE').output.value, 0.02619, 1e-9) && rec(L1, 'PROBABILITY_EDGE').output.display === '2.62%');
ok('maximum entry price: -120, the worst whole price still clearing the 0.5% floor (hand: D ≥ 1.005/0.55 = 1.8273 → -120.9 → -120)', rec(L1, 'MAXIMUM_ENTRY_PRICE').output.value === -120 && rec(L1, 'MAXIMUM_ENTRY_PRICE').inputs.some((i) => i.name === 'EV floor' && i.value === 0.005));
ok('freshness: 20 min old, the engine\'s status (LIVE) kept', rec(L1, 'MARKET_FRESHNESS').output.value === 20 && rec(L1, 'MARKET_FRESHNESS').output.status === 'LIVE');
ok('every record names its version, formula and status; every computed one its inputs and assumptions', L1.records.every((x) => /^[a-z_]+@\d+\.\d+\.\d+$/.test(x.version) && x.formula && ['COMPUTED', 'UNAVAILABLE'].includes(x.status)) && L1.records.filter((x) => x.status === 'COMPUTED').every((x) => x.inputs.length && x.assumptions.length), L1.records.map((x) => [x.name, x.version, x.inputs.length, x.assumptions.length]));
ok('inputs carry their sources: the price names its signal dataset id; the fair names its kind', rec(L1, 'EXPECTED_VALUE').inputs.find((i) => i.name === 'decimal odds').source === q1.source && /SHARP_NO_VIG/.test(rec(L1, 'EXPECTED_VALUE').inputs.find((i) => i.name === 'fair probability').source));
ok('the de-vigged fair is labelled as such in the assumptions (no interval)', rec(L1, 'EXPECTED_VALUE').assumptions.some((a) => /de-vigged market price/.test(a)));
ok('NO_VIG: unavailable without the other side, and says which fair is used instead', rec(L1, 'NO_VIG').status === 'UNAVAILABLE' && /other side/.test(rec(L1, 'NO_VIG').why) && /Pinnacle de-vig fair/.test(rec(L1, 'NO_VIG').why));
ok('no projection → LINE_DISCREPANCY unavailable; no validation → CALIBRATION unavailable and says the probabilities are not betting probabilities', rec(L1, 'LINE_DISCREPANCY').status === 'UNAVAILABLE' && rec(L1, 'CALIBRATION').status === 'UNAVAILABLE' && /not betting probabilities/.test(rec(L1, 'CALIBRATION').why));

/* ---------------- no-vig with both sides at one book ---------------- */
const L2 = Q.forCandidate(ev1, { quote: q1, other_side: { american: -110 }, now: NOW });
ok('NO_VIG: -110 / -110 → 50.0% each, overround 4.76% (hand: 2·110/210 − 1)', rec(L2, 'NO_VIG').status === 'COMPUTED' && near(rec(L2, 'NO_VIG').output.value, 0.5, 1e-9) && near(rec(L2, 'NO_VIG').output.overround, 2 * 110 / 210 - 1, 1e-6) && rec(L2, 'NO_VIG').check.agrees, rec(L2, 'NO_VIG'));
const nv = Q.noVig({ prices: [{ american: -150, label: 'fav' }, { american: 130, label: 'dog' }], index: 1 });
ok('NO_VIG: -150 / +130 → the dog at 41.1% (hand: (100/230)/((150/250)+(100/230)))', near(nv.output.value, (100 / 230) / (150 / 250 + 100 / 230), 1e-6) && nv.check.agrees);
ok('NO_VIG: one side only is refused, never assumed', Q.noVig({ prices: [{ american: -110 }] }).status === 'UNAVAILABLE');

/* ---------------- a decimal quote, a plus price with a push, a key-number push ---------------- */
const cases = [[null, '1.95', '0.53', null], [125, null, '0.47', '0.03'], [-105, null, '0.5', '0.08'], [-250, null, '0.74', null], [340, null, '0.25', null]];
cases.forEach(([am, dec, p, push]) => {
  const ev = F.evaluateWager({ book: 'fanduel', american: am, decimal: dec, fair_probability: p, push_probability: push, fair_source: { kind: 'MODEL', tier: 'LEAN', label: 'model', observed_at: ago(30) }, quote_observed_at: ago(5), now: NOW, ttl_min: 90 });
  const L = Q.forCandidate(ev, { quote: { american: am, decimal: dec, captured_at: ago(5) }, now: NOW });
  const D = dec ? Number(dec) : am > 0 ? 1 + am / 100 : 1 + 100 / -am, pp = Number(p), pu = Number(push || 0);
  ok('recomputation agrees for ' + (am != null ? am : dec) + ' at ' + p + (push ? ' push ' + push : ''), L.verification.verdict === 'VERIFIED' && near(rec(L, 'EXPECTED_VALUE').output.value, pp * (D - 1) - (1 - pp - pu), 1e-5) && near(rec(L, 'BREAK_EVEN').output.value, (1 - pu) / D, 1e-5), [L.verification.mismatches, rec(L, 'EXPECTED_VALUE').output]);
  ok('a model fair is labelled with its tier and points at CALIBRATION (' + (am != null ? am : dec) + ')', rec(L, 'EXPECTED_VALUE').assumptions.some((a) => /LEAN-tier model/.test(a) && /CALIBRATION/.test(a)));
});

/* ---------------- a tampered engine value is caught ---------------- */
const evBad = Object.assign({}, ev1, { net_ev_per_dollar: '0.09', break_even_probability: '0.50' });
const LB = Q.forCandidate(evBad, { quote: q1, now: NOW });
ok('tamper: a wrong EV and a wrong break-even are MISMATCHes, named with both values', LB.verification.verdict === 'MISMATCH' && LB.verification.mismatches.some((m) => m.name === 'EXPECTED_VALUE' && m.engine === 0.09) && LB.verification.mismatches.some((m) => m.name === 'BREAK_EVEN'), LB.verification);
const evBadP = Object.assign({}, ev1, { maximum_entry_price: -140 });
ok('tamper: a wrong maximum price is caught', Q.forCandidate(evBadP, { quote: q1, now: NOW }).verification.mismatches.some((m) => m.name === 'MAXIMUM_ENTRY_PRICE'));

/* ---------------- no verified price: the research continues, nothing is substituted ---------------- */
const L0 = Q.forCandidate(null, { quote: {}, model_line: { market: 'spreads', side: 'home', selection: 'Buffalo Bills', model_line: -5.2, market_line: -2.5, sigma: 13.4, sigma_basis: 'held-out residual sigma', source: 'edgedesk://football/nfl/slate.json#games/g1', market_source: 'reference line (no price)', tier: 'LEAN' }, now: NOW });
ok('no price: the market comparison is UNAVAILABLE with the reason; the research continues', L0.market_comparison.status === 'UNAVAILABLE' && /research continues/.test(L0.market_comparison.why));
ok('no price: implied, EV, fair odds, break-even, edge and max price are UNAVAILABLE — no number substituted', ['IMPLIED_PROBABILITY', 'EXPECTED_VALUE', 'FAIR_ODDS', 'BREAK_EVEN', 'PROBABILITY_EDGE', 'MAXIMUM_ENTRY_PRICE'].every((n) => rec(L0, n).status === 'UNAVAILABLE' && rec(L0, n).output === null), L0.records.map((x) => [x.name, x.status, x.output && x.output.value]));
ok('no price: the line discrepancy is still computed (the projection against the reference line)', rec(L0, 'LINE_DISCREPANCY').status === 'COMPUTED');
const ld = rec(L0, 'LINE_DISCREPANCY');
ok('line discrepancy: model -5.2 vs market -2.5 → -2.7 points; Φ(2.7/13.4) ≈ 57.98% cover (hand)', near(ld.output.value, -2.7, 1e-9) && near(ld.output.cover_probability, 0.5798, 1e-4) && ld.output.cover_display === '58.0%', ld.output);
ok('line discrepancy: never called edge evidence, and says so', ld.output.is_edge_evidence === false && /not proof of positive expected value/.test(ld.output.note) && ld.assumptions.some((a) => /raw projection, not the blend/.test(a)));
const ldA = Q.lineDiscrepancy({ market: 'spreads', side: 'away', model_line: 5.2, market_line: 2.5, sigma: 13.4 });
ok('line discrepancy: the away side at +2.5 against a +5.2 projection covers 42.0% (1 − 0.5798)', near(ldA.output.cover_probability, 1 - 0.5798, 1e-4), ldA.output);
const ldO = Q.lineDiscrepancy({ market: 'totals', side: 'over', model_line: 47.5, market_line: 44.5, sigma: 13.4 }), ldU = Q.lineDiscrepancy({ market: 'totals', side: 'under', model_line: 47.5, market_line: 44.5, sigma: 13.4 });
ok('line discrepancy: totals — over Φ(3/13.4), under its complement', near(ldO.output.cover_probability, 0.5886, 1e-4) && near(ldO.output.cover_probability + ldU.output.cover_probability, 1, 1e-4) && ldO.output.value === 3, [ldO.output, ldU.output]);
ok('line discrepancy: no sigma → the gap only, no invented probability', Q.lineDiscrepancy({ market: 'spreads', model_line: -3, market_line: -1 }).output.cover_probability === null);

/* ---------------- calibration from the real NFL validation artifact ---------------- */
const m = VAL.markets.spread;
const valN = { loaded: true, tier: m.tier, basis: m.tier_basis, generated_at: VAL.generated_at, frame: VAL.frame, calibration: m.calibration, ats: m.ats_vs_close.raw_model_oos };
const Lc = Q.forCandidate(ev1, { quote: q1, validation: valN, model_line: { market: 'spreads', side: 'home', model_line: -5.2, market_line: -2.5, sigma: 13.4 }, now: NOW });
const cal = rec(Lc, 'CALIBRATION');
ok('calibration: held-out Brier and base rate from the artifact, with the sample size', cal.status === 'COMPUTED' && cal.output.value === m.calibration.blend_held_out.brier && cal.output.base_rate_brier === m.calibration.blend_held_out.brier_base_rate && cal.output.held_out_n === m.calibration.blend_held_out.n, cal.output);
ok('calibration: says plainly when the model does not beat the base rate (0.2502 vs 0.25)', cal.output.beats_base_rate === false && /no better than the base rate/.test(cal.output.display), cal.output.display);
ok('calibration: the record against the close at the gap\'s threshold (2.7 points → the 2-point row)', cal.output.record_vs_close && cal.output.record_vs_close.threshold_points === 2 && cal.output.record_vs_close.n === m.ats_vs_close.raw_model_oos['2'].n && cal.output.record_vs_close.win_pct === m.ats_vs_close.raw_model_oos['2'].win_pct, cal.output.record_vs_close);
ok('calibration: names the no-look-ahead replay it comes from', /no look-ahead/.test(cal.engine));

/* ---------------- sensitivity from the researcher, recomputed ---------------- */
const sens = A.sensitivity({ evaluation: ev1, fair_probability: 0.55, price_input: { american: -110 } });
const Ls = Q.forCandidate(ev1, { quote: q1, sensitivity: sens, now: NOW });
ok('sensitivity: every perturbed row\'s EV recomputes; the cushion and robustness are carried', rec(Ls, 'SENSITIVITY').status === 'COMPUTED' && rec(Ls, 'SENSITIVITY').check.agrees === true && rec(Ls, 'SENSITIVITY').output.rows.length === sens.rows.length && rec(Ls, 'SENSITIVITY').output.robust === sens.robust, rec(Ls, 'SENSITIVITY'));
const sensBad = Object.assign({}, sens, { rows: sens.rows.map((x) => x.shift_pp === -1 ? Object.assign({}, x, { net_ev_per_dollar: 0.2 }) : x) });
ok('sensitivity: a wrong row is caught', rec(Q.forCandidate(ev1, { quote: q1, sensitivity: sensBad, now: NOW }), 'SENSITIVITY').check.agrees === false);

/* ---------------- a game ---------------- */
const Lg = Q.forGame({ market_line: -2.5 }, { model_line: { market: 'spreads', side: 'home', model_line: -5.2, market_line: -2.5, sigma: 13.4 }, validation: valN, now: NOW });
ok('game with a reference line only: market comparison UNAVAILABLE (says why), the line compared, the record shown', Lg.market_comparison.status === 'UNAVAILABLE' && /reference line/.test(Lg.market_comparison.why) && rec(Lg, 'LINE_DISCREPANCY').status === 'COMPUTED' && rec(Lg, 'CALIBRATION').status === 'COMPUTED' && !rec(Lg, 'IMPLIED_PROBABILITY'), Lg.records.map((x) => [x.name, x.status]));
const Lgp = Q.forGame({ market_line: -2.5 }, { quote: { american: -105, captured_at: ago(30) }, model_line: { market: 'spreads', model_line: -5.2, market_line: -2.5, sigma: 13.4 }, ttl_min: 90, now: NOW });
ok('game with a captured price: implied and freshness added', Lgp.market_comparison.status === 'AVAILABLE' && near(rec(Lgp, 'IMPLIED_PROBABILITY').output.value, 105 / 205, 1e-6) && rec(Lgp, 'MARKET_FRESHNESS').output.status === 'FRESH');

/* ---------------- the number verifier ---------------- */
const tk = Q.tokens('Break-even probability: 52.4%. Estimated net EV: +$0.0500 per $1. Price -110 at DraftKings; 8 games, 2026-10-12, week 6, line -2.5.');
ok('tokens: percentages, dollar EVs and signed American prices — not dates, counts or point lines', tk.map((t) => t.kind + ':' + t.token).join(',') === 'pct:52.4%,usd:+$0.0500,american:-110', tk);
const good = 'Verified market price: -110 (DraftKings). Implied probability 52.4%. Break-even probability: 52.4%. Independent fair probability: 55.0%. Estimated net EV: +$0.0500 per $1. Maximum acceptable price: -120. Fair odds -122.';
const c1 = Q.checkNumbers(good, [L1]);
ok('verifier: an answer whose every number is a calculation passes', c1.verdict === 'PASS' && c1.checked === 7 && c1.supported === 7, c1);
const c2 = Q.checkNumbers('Break-even probability: 55.0%. Maximum acceptable price: -140.', [L1]);
ok('verifier: a labelled number that is not its calculation is MISMATCHED, with the expected value', c2.verdict === 'FAIL' && c2.mismatched.length === 2 && c2.mismatched[0].label === 'BREAK_EVEN' && c2.mismatched[0].expected[0] === '52.4%' && c2.mismatched[1].label === 'MAXIMUM_ENTRY_PRICE', c2);
const c3 = Q.checkNumbers('The Bills have a 61.3% chance and the line should be -180.', [L1]);
ok('verifier: an invented probability and price are UNSUPPORTED', c3.verdict === 'FAIL' && c3.unsupported.map((u) => u.token).join() === '61.3%,-180', c3);
ok('verifier: a number the caller names as known is supported (e.g. a record from the payload)', Q.checkNumbers('Season win rate 57.1%.', [L1], { pct: [57.14] }).verdict === 'PASS');
ok('verifier: text with no quantitative tokens passes trivially', Q.checkNumbers('Nothing on this slate cleared the audit.', [L1]).verdict === 'PASS');
ok('verifier: a unicode minus is read as a sign', Q.tokens('EV −$0.0120 per $1')[0].value === -0.012);
ok('verifier: a probability shown to two decimals must match to two decimals', Q.checkNumbers('Edge 2.62%.', [L1]).verdict === 'PASS' && Q.checkNumbers('Edge 2.71%.', [L1]).verdict === 'FAIL');

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
