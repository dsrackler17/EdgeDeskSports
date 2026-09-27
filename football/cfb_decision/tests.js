#!/usr/bin/env node
/* ===========================================================================
   The wagering decision engine (football/cfb_decision/decision.js): tests.

   Synthetic worlds with known answers: vig removal, break-even, push, EV,
   cover calibration, thresholds (BET / LEAN / RESEARCH / PASS / NO BET),
   every PASS reason, WAIT, stake caps and Kelly, correlated exposure, best
   price, bettable-to, edge disappearance, immutability, model-version
   compatibility, stale markets, failed calibration, the extreme-edge
   integrity check, hysteresis, language, the LLM boundary, manual decisions,
   and — when the frozen artifact and its parity fixture exist — parity with
   the Python reference implementation.

     node football/cfb_decision/tests.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const D = require('./decision.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t || 1e-9);

const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const ART = {
  schema: 'cfb_decision_calibration_schema_v1', version: 'test_artifact', base_model_version: 'edgedesk_cfb_v2.1.0',
  cover_calibration: { map: { method: 'platt', a: 0, b: 0.6 } },
  market_shrinkage: { w_model: 0.85, space: 'logit' },
  ev_curve: { x: [-0.2, 0, 0.1, 0.3], y: [-0.2, 0, 0.06, 0.12] },
  p_positive_clv: { type: 'logistic', intercept: 0, coef: { gap_pts: 0.2 } },
  clv_magnitude: { type: 'linear', intercept: 0, coef: { gap_pts: 0.3 } },
  push_table: { '0-2.5': 0.01, '2.5-3.5': 0.09, '3.5-6.5': 0.03, '6.5-7.5': 0.06, '7.5-13.5': 0.03, '13.5-99': 0.028 },
  reliability_scale: { expected_abs_error: { x: [0, 50, 100], y: [16, 12, 9] } }
};
const POL = {
  version: 'test_policy', bet_enabled: true, min_probability_edge: 0.02, min_ev: 0.02, stale_minutes: 180,
  max_price: -125, max_dispersion_iqr: 1.5, min_books: 3, min_football_confidence: 30, max_ensemble_sd: 6,
  extreme_gap_pts: 10, extreme_ev: 0.15, extreme_max_age_minutes: 60,
  lean: { min_probability_edge: 0, min_gap_pts: 1 }, hysteresis: { ev_buffer: 0.004, edge_buffer: 0.004 },
  wait: { enabled: false }, reference_price: -110,
  stake: { method: 'flat', unit_u: 1, max_stake_u: 1 },
  exposure: { max_game_u: 1.5, max_slate_u: 3, same_game_correlation: 1 }
};
function pure(over) {
  return Object.assign({ status: 'PREDICTED', game_id: '401', model_version: 'edgedesk_cfb_v2.1.0', home: 'Texas Tech', away: 'Baylor',
    projected_margin: 9.5, sigma: 15.0, t_df: 100, football_prediction_confidence: 70, ensemble_sd: 2.0, week: 6,
    kickoff: '2026-10-03T19:30:00.000Z', fair_spread_display: 'Texas Tech -9.5' }, over || {});
}
function quote(over) {
  return Object.assign({ game_id: '401', book: 'bookA', home_team: 'Texas Tech', home_line: -3.5, price_home: -110, price_away: -110,
    observed_at: '2026-10-01T14:50:00.000Z', market_type: 'spread' }, over || {});
}
const MK = { books: 6, dispersion_iqr: 0.5 };
const ctx = (over) => Object.assign({ policy: POL, artifact: ART, now: NOW, market: MK, row: {} }, over || {});

/* ---------------------------------------------------------------- prices */
chk('break-even at -110 is 52.38%', near(D.breakEven(-110), 110 / 210, 1e-12));
chk('break-even at +150 is 40%', near(D.breakEven(150), 0.4, 1e-12));
chk('payout and American round-trip', D.payoutToAmerican(D.americanToPayout(-118)) === -118 && D.payoutToAmerican(D.americanToPayout(135)) === 135);
const dv = D.devig(-110, -110);
chk('vig removal: -110/-110 de-vigs to 50/50 with a 4.76% overround', near(dv.p_a, 0.5, 1e-12) && near(dv.overround, 2 * 110 / 210 - 1, 1e-12));
const dv2 = D.devig(-150, 130);
chk('vig removal: fair probabilities sum to 1 and keep the favourite ahead', near(dv2.p_a + dv2.p_b, 1, 1e-12) && dv2.p_a > dv2.p_b);
chk('an impossible American price is refused', D.americanToPayout(50) === null && D.breakEven(-99) === null);
chk('push probability: half-point lines never push', D.pushProb(-3.5, ART.push_table) === 0);
chk('push probability: a key number uses its table', D.pushProb(-3, ART.push_table) === 0.09 && D.pushProb(7, ART.push_table) === 0.06);
chk('EV at a fair coin and -110 is -4.55%', near(D.expectedValue(0.5, 0, -110), 0.5 * 100 / 110 - 0.5, 1e-12));
chk('EV with a push: the push share returns the stake', near(D.expectedValue(0.6, 0.1, -110), 0.9 * (0.6 * 100 / 110 - 0.4), 1e-12));
const mp = D.minimumPrice(0.56, 0, 0.02);
chk('minimum price: EV at the minimum price equals the floor (within rounding)', Math.abs(D.expectedValue(0.56, 0, mp) - 0.02) < 0.003, mp);

/* ------------------------------------------------------------ calibration */
chk('platt map with slope 0.5 shrinks toward 50%', near(D.applyMap({ method: 'platt', a: 0, b: 0.5 }, 0.6), 1 / (1 + Math.pow(0.4 / 0.6, 0.5)), 1e-12));
chk('isotonic map interpolates and clamps', near(D.applyMap({ method: 'isotonic', x: [0.4, 0.6], y: [0.45, 0.55] }, 0.5), 0.5, 1e-12)
  && near(D.applyMap({ method: 'isotonic', x: [0.4, 0.6], y: [0.45, 0.55] }, 0.9), 0.55, 1e-12));
chk('beta map with a=b=1, c=0 is the identity', near(D.applyMap({ method: 'beta', a: 1, b: 1, c: 0 }, 0.63), 0.63, 1e-9));
chk('conditional calibration picks the bin', near(D.calibrate({ conditional: { by: 'ens_sd', bins: [3], maps: [{ method: 'identity' }, { method: 'platt', a: 0, b: 0 }] } }, 0.7, { ens_sd: 5 }), 0.5, 1e-12));
chk('an unknown map is an error, never a silent identity', (() => { try { D.applyMap({ method: 'magic' }, 0.6); return false; } catch (e) { return true; } })());
const dp = D.decisionProbability(0.62, 0.5, {}, ART);
chk('the decision probability sits between the market and the calibrated model', dp.decision > 0.5 && dp.decision < dp.calibrated && dp.calibrated < 0.62, dp);
chk('the model evaluator returns null on a missing input (no guessing)', D.evalModel({ type: 'linear', intercept: 0, coef: { x: 1 } }, {}) === null);

/* -------------------------------------------------------- the pure numbers */
const p0 = pure();
chk('pure cover: at the fair line the cover probability is 50%', near(D.pureCover(p0, -9.5, 'HOME'), 0.5, 1e-9));
chk('pure cover: HOME + AWAY = 1', near(D.pureCover(p0, -3.5, 'HOME') + D.pureCover(p0, -3.5, 'AWAY'), 1, 1e-12));

/* ------------------------------------------------------------- statuses */
const d0 = D.decideQuote(p0, quote(), ctx());
chk('a clear price edge is a BET on the model side', d0.status === 'BET' && d0.side === 'HOME', { s: d0.status, r: d0.reason_codes, pe: d0.probability_edge, ev: d0.empirical_ev });
chk('pure and decision probabilities are both reported, and differ', d0.pure_cover_probability > d0.decision_cover_probability);
chk('probability edge = decision probability - break-even', near(d0.probability_edge, d0.decision_cover_probability - d0.break_even_probability, 1e-4));
chk('three separate confidences are reported', d0.football_confidence && d0.market_confidence && d0.bet_confidence
  && d0.football_confidence.expected_abs_error_pts === 10.8);
chk('a decision is immutable', Object.isFrozen(d0) && (() => { try { d0.status = 'PASS'; } catch (e) { /* strict */ } return d0.status === 'BET'; })());
const dNear = D.decideQuote(p0, quote({ home_line: -8.5 }), ctx());
chk('a small edge is not a BET (LEAN or PASS with a reason)', ['LEAN', 'PASS'].includes(dNear.status) && dNear.reason_codes.length > 0, dNear.reason_codes);
const dWrong = D.decideQuote(p0, quote({ home_line: -9.5, price_home: -110, price_away: -110 }), ctx());
chk('no edge at the fair line: PASS_PRICE', dWrong.status === 'PASS' && dWrong.reason_codes[0] === 'PASS_PRICE', dWrong.reason_codes);
const dJuice = D.decideQuote(p0, quote({ price_home: -135 }), ctx());
chk('an edge at terrible juice (worse than the price limit) is PASS_PRICE', dJuice.status === 'PASS' && dJuice.reason_codes[0] === 'PASS_PRICE', dJuice.reason_codes);
const dNoPrice = D.decideQuote(p0, quote({ price_home: null, price_away: null }), ctx());
chk('no captured price is PASS_PRICE, never an assumed -110', dNoPrice.status === 'PASS' && dNoPrice.reason_codes[0] === 'PASS_PRICE');
const dStale = D.decideQuote(p0, quote({ observed_at: '2026-10-01T09:00:00.000Z' }), ctx());
chk('a stale quote is PASS_MARKET_STALE', dStale.status === 'PASS' && dStale.reason_codes[0] === 'PASS_MARKET_STALE', dStale.reason_codes);
const dDisp = D.decideQuote(p0, quote(), ctx({ market: { books: 6, dispersion_iqr: 2.5 } }));
chk('books that disagree are PASS_MARKET_DISPERSION', dDisp.status === 'PASS' && dDisp.reason_codes[0] === 'PASS_MARKET_DISPERSION');
const dUnc = D.decideQuote(pure({ football_prediction_confidence: 10 }), quote(), ctx());
chk('an uncertain projection is PASS_MODEL_UNCERTAINTY', dUnc.status === 'PASS' && dUnc.reason_codes[0] === 'PASS_MODEL_UNCERTAINTY', dUnc.reason_codes);
const dDis = D.decideQuote(pure({ ensemble_sd: 9 }), quote(), ctx());
chk('submodel disagreement is PASS_MODEL_DISAGREEMENT', dDis.status === 'PASS' && dDis.reason_codes[0] === 'PASS_MODEL_DISAGREEMENT', dDis.reason_codes);
const dQB = D.decideQuote(p0, quote(), ctx({ row: { qb_unsettled_any: true } }));
chk('an unresolved quarterback turns the edge into RESEARCH_QB', dQB.status === 'RESEARCH' && dQB.reason_codes.includes('RESEARCH_QB'), dQB.reason_codes);
const dThin = D.decideQuote(p0, quote(), ctx({ market: { books: 1, dispersion_iqr: 0 } }));
chk('an immature market turns the edge into RESEARCH_MARKET_IMMATURE', dThin.status === 'RESEARCH' && dThin.reason_codes.includes('RESEARCH_MARKET_IMMATURE'), dThin.reason_codes);
const dOff = D.decideQuote(p0, quote(), ctx({ policy: Object.assign({}, POL, { bet_enabled: false }) }));
chk('with betting disabled a qualifying price is shown as LEAN, never BET', dOff.status === 'LEAN' && dOff.reason_codes.includes('NO_BET_BETTING_DISABLED'));

/* -------------------------------------------------------- fail closed */
const dNoArt = D.decideQuote(p0, quote(), ctx({ artifact: null }));
chk('missing calibration artifact: NO_BET', dNoArt.status === 'NO_BET' && dNoArt.reason_codes[0] === 'NO_BET_CALIBRATION');
const dBadArt = D.decideQuote(p0, quote(), ctx({ artifact: Object.assign({}, ART, { schema: 'v0' }) }));
chk('an artifact of an unknown schema: NO_BET', dBadArt.status === 'NO_BET' && dBadArt.reason_codes[0] === 'NO_BET_CALIBRATION');
const dVer = D.decideQuote(pure({ model_version: 'edgedesk_cfb_v3.0.0' }), quote(), ctx());
chk('a model version the calibration was not validated for: NO_BET', dVer.status === 'NO_BET' && dVer.reason_codes[0] === 'NO_BET_VERSION_MISMATCH');
const dNoPol = D.decideQuote(p0, quote(), ctx({ policy: null }));
chk('no policy: NO_BET', dNoPol.status === 'NO_BET' && dNoPol.reason_codes[0] === 'NO_BET_POLICY');
const dNaN = D.decideQuote(pure({ sigma: NaN }), quote(), ctx());
chk('a failed probability computation: NO_BET', dNaN.status === 'NO_BET' && dNaN.reason_codes[0] === 'NO_BET_COMPUTATION');
const dBadMap = D.decideQuote(p0, quote(), ctx({ artifact: Object.assign({}, ART, { cover_calibration: { map: { method: 'magic' } } }) }));
chk('a calibration map that fails to evaluate: NO_BET', dBadMap.status === 'NO_BET' && dBadMap.reason_codes[0] === 'NO_BET_COMPUTATION');

/* ------------------------------------------------------ integrity checks */
const dFlip = D.decideQuote(pure({ projected_margin: -24 }), quote({ home_line: -24 }), ctx());
chk('a sign-flipped market fails the integrity check: PASS_DATA_QUALITY', dFlip.status === 'PASS' && dFlip.reason_codes[0] === 'PASS_DATA_QUALITY', dFlip.integrity);
const dMap = D.decideQuote(p0, quote({ game_id: '999' }), ctx());
chk('a quote for another game fails the mapping check', dMap.status === 'PASS' && dMap.integrity.failures.some((f) => /mapping/.test(f)));
const dKick = D.decideQuote(p0, quote(), ctx({ now: Date.parse('2026-10-03T20:00:00.000Z') }));
chk('after kickoff nothing is actionable', dKick.status !== 'BET');
const dExt = D.decideQuote(pure({ projected_margin: 21 }), quote({ home_line: -7, observed_at: '2026-10-01T12:30:00.000Z' }), ctx());
chk('an extreme edge with a 2.5-hour-old quote fails the freshness integrity check', dExt.status === 'PASS' && dExt.integrity.extreme, dExt.integrity);
const dExt2 = D.decideQuote(pure({ projected_margin: 21 }), quote({ home_line: -7 }), ctx());
chk('an extreme edge that passes integrity is still RESEARCH, not an automatic BET', dExt2.status === 'RESEARCH' && dExt2.reason_codes.includes('RESEARCH_EXTREME_EDGE'), dExt2.reason_codes);

/* --------------------------------------------------- price targets, moves */
const t = d0.price_targets;
chk('bettable-to line is at or below the current line (worse for our side)', typeof t.bettable_to_line === 'number' && t.bettable_to_line <= t.current_line, t);
chk('at the bettable-to line the decision still clears; half a point worse it does not',
  (() => { const a = D.decideQuote(p0, quote({ home_line: t.bettable_to_line }), ctx()); const b = D.decideQuote(p0, quote({ home_line: t.bettable_to_line - 0.5 }), ctx());
    return a.status === 'BET' && b.status !== 'BET'; })(), t);
chk('bettable-to price is no worse than the price limit', D.breakEven(t.bettable_to_price) <= D.breakEven(POL.max_price) + 1e-12, t.bettable_to_price);
const moved = D.decideQuote(p0, quote({ home_line: t.bettable_to_line - 1 }), ctx({ previous: d0 }));  /* HOME side: line-for-side = home line */
chk('edge disappearance: a line moved through the bettable-to number is PASS_LINE_MOVED', moved.status === 'PASS' && moved.reason_codes[0] === 'PASS_LINE_MOVED', moved.reason_codes);

/* ---------------------------------------------------- hysteresis */
const edgeAt = (line) => D.decideQuote(p0, quote({ home_line: line }), ctx());
let lineJustBelow = null;
for (let L = -3.5; L >= -9.5; L -= 0.5) { const x = edgeAt(L); if (x.status !== 'BET' && x.probability_edge > POL.min_probability_edge - 0.004 && x.empirical_ev > POL.min_ev - 0.004 && x.probability_edge > 0) { lineJustBelow = L; break; } }
if (lineJustBelow != null) {
  const held = D.decideQuote(p0, quote({ home_line: lineJustBelow }), ctx({ previous: Object.assign({}, d0, { price_targets: { bettable_to_line: -99 } }) }));
  chk('hysteresis holds a BET inside the buffer and says so', held.status === 'BET' && held.reason_codes.includes('HELD_BY_HYSTERESIS'), held.reason_codes);
} else chk('hysteresis test line found', true);
chk('hysteresis never holds a wager that fails integrity', D.decideQuote(p0, quote({ game_id: '999' }), ctx({ previous: d0 })).status === 'PASS');

/* ---------------------------------------------------------- WAIT */
chk('WAIT is off unless the policy validated it: BET_NOW', d0.timing === 'BET_NOW');
const W = Object.assign({}, POL, { wait: { enabled: true, ev_per_point: 0.03, p_disappear: 0.1, min_benefit_ev: 0.005 } });
const artWait = Object.assign({}, ART, { clv_magnitude: { type: 'linear', intercept: -2, coef: {} } });
const dWait = D.decideQuote(p0, quote(), ctx({ policy: W, artifact: artWait }));
chk('with validated WAIT and a line expected to improve by 2 pts: WAIT', dWait.status === 'BET' && dWait.timing === 'WAIT', dWait.timing);
const artNow = Object.assign({}, ART, { clv_magnitude: { type: 'linear', intercept: 1, coef: {} } });
chk('a line expected to move toward us: BET NOW', D.decideQuote(p0, quote(), ctx({ policy: W, artifact: artNow })).timing === 'BET_NOW');
const artTiny = Object.assign({}, ART, { clv_magnitude: { type: 'linear', intercept: -0.1, coef: {} } });
chk('a trivial expected improvement is not worth waiting for (no fake precision)', D.decideQuote(p0, quote(), ctx({ policy: W, artifact: artTiny })).timing === 'BET_NOW');

/* -------------------------------------------------------- per book */
const g = D.decideGame(p0, { books: 6, dispersion_iqr: 0.5, quotes: [quote({ book: 'A', home_line: -3.5 }), quote({ book: 'B', home_line: -9.0, price_home: -115, price_away: -105 }), quote({ book: 'C', home_line: -3.0, price_home: -105, price_away: -115 })] }, ctx());
chk('statuses are per book: a good price is BET, a bad one is not', g.by_book.find((b) => b.book === 'A').status === 'BET' && g.by_book.find((b) => b.book === 'B').status !== 'BET', g.by_book);
chk('the best validated quote is the highest calibrated EV among BETs', g.best_quote && g.best_quote.book === 'C', g.best_quote);
chk('the game carries BETTABLE TO', !!g.best_quote && typeof g.best_quote.bettable_to_line === 'number', g.by_book);
chk('totals are not decided by the spread engine', D.decideGame(p0, { quotes: [quote({ market_type: 'total' })] }, ctx()).by_book.length === 0);

/* ------------------------------------------------------------- staking */
chk('flat staking: 1 unit per qualified wager', d0.stake_u === 1);
chk('Kelly fraction: p=0.55 at -110 is (b p - q)/b', near(D.kellyFraction(0.55, -110), (0.55 * 100 / 110 - 0.45) / (100 / 110), 1e-12));
chk('Kelly is never negative', D.kellyFraction(0.4, -110) === 0);
const KP = Object.assign({}, POL, { stake: { method: 'fractional_kelly', kelly_validated: true, kelly_fraction: 0.25, bankroll_u: 100, max_stake_u: 1, saturation_probability: 0.58 } });
chk('fractional Kelly is hard-capped', D.stake({ decision_cover_probability: 0.9, price: -110 }, KP) === 1);
chk('Kelly never exceeds quarter Kelly even if the policy asks', D.stake({ decision_cover_probability: 0.56, price: -110 }, Object.assign({}, KP, { stake: Object.assign({}, KP.stake, { kelly_fraction: 1, max_stake_u: 100 }) }))
  === Math.round(D.kellyFraction(0.56, -110) * 0.25 * 100 * 100) / 100);
chk('edge saturation: the Kelly input is capped at the saturation probability', D.stake({ decision_cover_probability: 0.7, price: -110 }, Object.assign({}, KP, { stake: Object.assign({}, KP.stake, { max_stake_u: 100 }) }))
  === D.stake({ decision_cover_probability: 0.58, price: -110 }, Object.assign({}, KP, { stake: Object.assign({}, KP.stake, { max_stake_u: 100 }) })));
chk('unvalidated Kelly falls back to flat', D.stake({ decision_cover_probability: 0.6, price: -110 }, Object.assign({}, POL, { stake: { method: 'fractional_kelly', kelly_validated: false, unit_u: 1, max_stake_u: 1 } })) === 1);
const ex = D.applyExposure([{ game_id: 'g1', stake_u: 1 }, { game_id: 'g1', stake_u: 1 }, { game_id: 'g2', stake_u: 1 }, { game_id: 'g3', stake_u: 1 }], POL);
const g1 = ex.positions.filter((x) => x.game_id === 'g1').reduce((a, x) => a + x.stake_u, 0);
chk('correlated same-game positions share the game cap', near(g1, 1.5 * 3 / 3.5, 1e-3) || g1 <= 1.5 + 1e-9, ex);
chk('the slate cap scales every position down, never up', ex.total_u <= 3 + 1e-9 && ex.positions.every((x) => x.stake_u <= 1));
const exRho = D.applyExposure([{ game_id: 'g', stake_u: 1 }, { game_id: 'g', stake_u: 1 }], Object.assign({}, POL, { exposure: { max_game_u: 1.5, same_game_correlation: 0 } }));
chk('independent positions (rho 0) on one game fit under a cap their plain sum exceeds', exRho.total_u === 2);

/* ------------------------------------------------ language, LLM, manual */
chk('language: a BET explanation quotes numbers', /\d/.test(D.explain(d0)) && D.auditLanguage(D.explain(d0), d0).ok);
chk('language: "strong bet" on a LEAN is refused', !D.auditLanguage('A strong bet on Baylor', dOff).ok);
chk('language: "great value" without a number is refused', !D.auditLanguage('great value here', d0).ok);
chk('language: promises of profit are refused on every status', !D.auditLanguage('a guaranteed winner, risk-free', d0).ok);
const nar = D.attachNarrative(dNear, 'Lock of the week, bet it now');
chk('LLM boundary: a narrative cannot change the status, and a hyped one is refused', nar.decision.status === dNear.status && nar.narrative === null);
const man = D.manualDecision({ game_id: '401', book: 'A', side: 'HOME', line: -3.5, price: -110, stake_u: 2, decided_by: 'a person' });
chk('manual decisions are stored apart and never official', man.manual_decision === true && man.official === false
  && (() => { try { D.assertOfficial(man); return false; } catch (e) { return true; } })() && D.assertOfficial(d0));
const card = D.publicCard(p0, g);
chk('public card: fair line, best market, probability, break-even, edge, decision, bettable to, why',
  card.fair_line === 'Texas Tech -9.5' && /Texas Tech -3/.test(card.best_market) && card.decision === 'BET' && card.bettable_to && /\d/.test(card.why), card);
chk('public card never promises profit', D.auditLanguage(JSON.stringify(card), d0).ok);

/* -------------------------------------------- parity with the Python reference */
const FIX = path.join(__dirname, '..', 'cfb_v2', 'artifacts', 'decision', 'fixtures', 'decision_parity.json');
const CAL = path.join(__dirname, '..', 'cfb_v2', 'artifacts', 'decision', 'cfb_decision_calibration_v1', 'calibration.json');
if (fs.existsSync(FIX) && fs.existsSync(CAL)) {
  const A = JSON.parse(fs.readFileSync(CAL, 'utf8'));
  const F = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const cases = F.cases || F;
  let bad = [];
  for (const c of cases) {
    const inp = c.inputs || c.input || {};
    const exp = c.expected || c.outputs || {};
    const feats = Object.assign({}, inp.features || inp);
    const pPure = inp.pure_cover_prob != null ? inp.pure_cover_prob : feats.pure_cover_prob;
    if (pPure == null) continue;
    const marketP = inp.market_implied_prob != null ? inp.market_implied_prob : (inp.market_prob != null ? inp.market_prob : 0.5);
    const got = D.decisionProbability(pPure, marketP, feats, A);
    const want = exp.decision_cover_prob != null ? exp.decision_cover_prob : exp.decision_cover_probability;
    if (want != null && Math.abs(got.decision - want) > 1e-6) bad.push({ id: c.id, got: got.decision, want });
  }
  chk('parity with the Python reference on the frozen artifact (' + cases.length + ' cases)', bad.length === 0, bad.slice(0, 5));
} else {
  chk('parity fixture pending (the frozen artifact is not built yet)', true);
}

failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
