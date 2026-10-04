#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK EV INTELLIGENCE ENGINE — the rules (lib/edgedesk_ev.js).

     node football/cfb_ev/ev.test.js

   1  odds normalisation (F01-F05, every format, precision)
   2  settlement states and EV (F06-F13, W01-W07, the universal formula)
   3  market de-vig benchmark (F14-F18)
   4  staking arithmetic (F21-F23) — downstream, disabled
   5  CLV, edge decay, the juice panel (F24-F28)
   6  the frozen curve: signs, pushes, the location move
   7  calibration: maps, the artifact contract, the market-line anchor
   8  uncertainty: Pr(EV>0) and the conservative quantile (F29-F30)
   9  the EV read: the §68 fixtures and the §77 demonstrations
   10 fail closed
   11 snapshot, grading, validation, the assistant
   12 property tests (§69)
   13 the tournament artifact and its governance
   14 the real slate
   15 the page, the explanation boundary, the freeze
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const DEC = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
const INTEG = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));
const C = require('./calibrators.js');
const X = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function section(t) { console.log('\n' + t); }

/* a discretised normal on integer margins (the same synthetic distribution the Read's tests use) */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normalCover(mu, sd) {
  const pmf = {}; let tot = 0;
  for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
  Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
  return (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; };
}
const NOW = Date.parse('2026-10-01T15:00:00Z'), FRESH = '2026-10-01T14:30:00Z', OLD = '2026-10-01T05:00:00Z', KICK = '2026-10-03T19:30:00Z';
const QB_OK = { home: { player: 'A', confirmed: true }, away: { player: 'B', confirmed: true } };
/* a synthetic artifact in the tournament's schema */
function artifact(method, status, extra) {
  const map = method === 'identity' ? { method: 'identity' } : (method === 'temperature' ? { method: 'temperature', T: 1e6 } : Object.assign({ method: method }, extra || {}));
  const cal = { status: status || 'PROMOTED', method: method, map: map, maturity: 'SHADOW', training_window: '2022-2025', n: 3120, domain: { p01: 0.2, p99: 0.8 },
    oof: { n: 2339, log_loss: 0.6931, identity_log_loss: 0.7334 },
    uncertainty: { sd_ref: 2.15, platt_center: [0, 1], platt_draws: Array.from({ length: 40 }, (_, i) => [0.004 * (i - 20) / 20, 1 + 0.05 * Math.sin(i)]) } };
  return { schema: EV.CAL_SCHEMA, version: 'test_ev_cal', base_model_version: 'test', calibrators: { 'cfb|spread|close': cal, 'cfb|spread|open': cal },
    checkpoint_map: { OPEN: 'cfb|spread|open', EARLY_WEEK: 'cfb|spread|open', MIDWEEK: 'cfb|spread|close', T24: 'cfb|spread|close', T6: 'cfb|spread|close', FINAL: 'cfb|spread|close', HYPOTHETICAL: 'cfb|spread|close', UNKNOWN: 'cfb|spread|close' },
    extremes: { prob_p95: 0.24, prob_p99: 0.31, gap_p95: 10.2, gap_p99: 14.7 }, key_numbers: { validated: true, primary: [3, 7] } };
}
const IDENTITY = artifact('identity', 'IDENTITY_VALIDATED'), MARKETCAL = artifact('temperature', 'PROMOTED');
const PROD = { maturity: 'PRODUCTION', betting_enabled: true };
function q(id, book, hl, ph, pa, t, extra) { return Object.assign({ quote_id: id, book: book, source: 'test', home_line: hl, price_home: ph, price_away: pa, observed_at: t || FRESH }, extra || {}); }
function input(o) {
  o = o || {};
  const fair = o.fair != null ? o.fair : 0, mkt = o.center != null ? o.center : fair;
  const cover = o.cover || normalCover(fair, o.sd || 14);
  return {
    now: o.now || NOW, game: { game_id: o.id || 'g1', home: o.home || 'Michigan', away: o.away || 'Minnesota', kickoff: o.kickoff || KICK },
    model: { available: o.model !== false, model_version: 'test', home_margin: fair, fair_total: 44, home_win_prob: o.hwp != null ? o.hwp : 0.55 },
    curve: o.curve === null ? null : (o.curveObj || RD.buildCurve(cover, mkt, 30, { basis: 'test normal' })),
    calibration: { status: 'PENDING', reason: 'the Read’s own calibration is not under test here' }, policy: { version: 'test_policy', bet_enabled: false },
    market: { quotes: o.quotes || [], open: o.open || null, stored: o.stored || [], moneyline: o.ml || null },
    governed: null, config: Object.assign({ typical_move_pts: 1.9 }, o.config || {}),
    research: o.research || { status_key: 'RESEARCH', disagreement: { class: 'MODERATE', points: 5 } },
    context: Object.assign({ qb: QB_OK, key_mass: { 3: 0.0926, 7: 0.0851, 10: 0.0461, 14: 0.0461 }, agreement: o.agreement || null, reliability: o.reliability != null ? o.reliability : 85 }, o.context || {}),
    view: o.view || { mode: 'best' }, user_quotes: o.user_quotes || [], integrity: INTEG
  };
}
function evr(o, evo) { const inp = input(o); return EV.evRead(inp, RD.read(inp), Object.assign({ artifact: o.artifact === undefined ? IDENTITY : o.artifact, policy: o.policy || null, now: o.now || NOW, history: o.history || [], prediction_ts: '2026-10-01T12:00:00Z' }, evo || {})); }

/* ======================================================================= 1 */
section('1. odds normalisation');
chk('F01 −110 → 1.90909', near(EV.americanToDecimal(-110), 1 + 100 / 110, 1e-12));
chk('F02 +145 → 2.45', near(EV.americanToDecimal(145), 2.45, 1e-12));
chk('even money +100 → 2.0; −100 → 2.0', near(EV.americanToDecimal(100), 2) && near(EV.americanToDecimal(-100), 2));
chk('F03 raw implied 1/d', near(EV.impliedProbability(2.45), 1 / 2.45));
chk('F04 −113 implied = 113/213', near(1 / EV.americanToDecimal(-113), 113 / 213, 1e-12));
chk('F05 +150 implied = 100/250', near(1 / EV.americanToDecimal(150), 0.4, 1e-12));
chk('decimal → American exact: 1.91 → −109.89…', near(EV.decimalToAmerican(1.91), -100 / 0.91, 1e-9));
chk('decimal → American exact: 3.5 → +250', near(EV.decimalToAmerican(3.5), 250, 1e-9));
chk('decimal → American rounded display', EV.decimalToAmericanRounded(1.91) === -110 && EV.decimalToAmericanRounded(2.0) === 100);
chk('fractional 5/2 → 3.5; 10/11 → 1.909; evens → 2', near(EV.fractionalToDecimal('5/2'), 3.5) && near(EV.fractionalToDecimal('10/11'), 1 + 10 / 11) && EV.fractionalToDecimal('evens') === 2);
chk('Hong Kong 0.91 → 1.91; Malay −0.8 → 2.25; Indonesian −1.25 → 1.8', near(EV.hongKongToDecimal(0.91), 1.91) && near(EV.malayToDecimal(-0.8), 2.25) && near(EV.indonesianToDecimal(-1.25), 1.8));
[-10000, -500, -250, -120, -113, -110, -105, -101, 100, 101, 105, 110, 145, 250, 500, 1200].forEach((a) => {
  const n = EV.normalizeOdds(a);
  chk('parity with decision.js at ' + a, n.valid && near(n.net_payout, DEC.americanToPayout(a), 1e-12) && near(n.implied_raw, DEC.breakEven(a), 1e-12) && n.american === a);
});
const both = EV.normalizeOdds({ american: -113, implied: 0.53 });
chk('raw odds win over a rounded implied %: −113 with "53%"', both.format === 'AMERICAN' && near(both.implied_raw, 113 / 213, 1e-12) && !near(both.implied_raw, 0.53, 1e-4));
const pctOnly = EV.normalizeOdds({ implied: 53 });
chk('an implied % alone is kept at source precision and marked approximate', pctOnly.valid && near(pctOnly.implied_raw, 0.53, 1e-12) && pctOnly.approximate_american);
const decSrc = EV.normalizeOdds({ decimal: 1.87 });
chk('a decimal source keeps its decimal (no American round trip)', decSrc.decimal === 1.87 && decSrc.format === 'DECIMAL');
['-50', '+99', '0', 'abc', null].forEach((s) => chk('refuses an impossible price ' + s, !EV.normalizeOdds(s).valid));
chk('parse: "-113", "+145", "1.91", "5/2", "53%", "hk0.91"', EV.parseOdds('-113').american === -113 && EV.parseOdds('+145').american === 145 && near(EV.parseOdds('1.91').decimal, 1.91) && near(EV.parseOdds('5/2').decimal, 3.5) && near(EV.parseOdds('53%').implied_raw, 0.53) && near(EV.parseOdds('hk0.91').decimal, 1.91));

/* ======================================================================= 2 */
section('2. settlement states and EV');
chk('F06 binary EV = p·d − 1', near(EV.twoWayEv(0.55, 0, 1.9), 0.55 * 1.9 - 1, 1e-12));
chk('F07 EV with push = win·(d−1) − loss', near(EV.twoWayEv(0.54, 0.04, 1 + 100 / 110), 0.54 * (100 / 110) - 0.42, 1e-12));
const st = EV.twoWayStates(0.54, 0.04, 1.9, { allow_push: true });
chk('states sum to one and carry explicit payoffs', near(st.reduce((s, x) => s + x.p, 0), 1) && st.map((x) => x.state).join() === 'FULL_WIN,PUSH,FULL_LOSS' && st[1].payoff === 0);
chk('a half point has no PUSH state', EV.twoWayStates(0.55, 0, 1.9).map((x) => x.state).join() === 'FULL_WIN,FULL_LOSS');
chk('a moneyline void is its own state (payoff 0)', EV.twoWayStates(0.6, 0.01, 1.7, { allow_push: true, void: true })[1].state === 'VOID');
chk('expectedValue refuses probabilities that are not a distribution', EV.expectedValue([{ state: 'FULL_WIN', p: 0.7, payoff: 1 }, { state: 'FULL_LOSS', p: 0.4, payoff: -1 }]) === null);
chk('expectedValue refuses a negative probability', EV.expectedValue([{ state: 'FULL_WIN', p: 1.1, payoff: 1 }, { state: 'FULL_LOSS', p: -0.1, payoff: -1 }]) === null);
let parityOk = true;
for (let i = 0; i < 240; i++) {
  const p = 0.3 + 0.4 * ((i * 37) % 100) / 100, pu = (i % 3) * 0.03, a = [-150, -120, -110, -105, 100, 110, 140][i % 7];
  const d = EV.americanToDecimal(a), e1 = EV.twoWayEv(p * (1 - pu), pu, d), e2 = RD.evOf(p * (1 - pu), pu, DEC.americanToPayout(a)), e3 = DEC.expectedValue(p, pu, a);
  if (!near(e1, e2, 1e-12) || !near(e1, e3, 1e-12)) { parityOk = false; break; }
}
chk('one EV: parity with EDRead.evOf and decision.js expectedValue over 240 cases', parityOk);
const be = EV.breakEven(1 + 100 / 110, 0.04);
chk('F08 unconditional break-even (1 − push)/d', near(be.unconditional, 0.96 / (1 + 100 / 110), 1e-12));
chk('F09 conditional break-even 1/d', near(be.conditional_nonpush, 110 / 210, 1e-12));
chk('F10 fair decimal (1 − push)/win', near(EV.fairDecimal(0.54, 0.04), 0.96 / 0.54, 1e-12) && near(EV.fairDecimal(0.5, 0), 2));
chk('fair decimal gives exactly zero EV', near(EV.twoWayEv(0.54, 0.04, EV.fairDecimal(0.54, 0.04)), 0, 1e-12));
/* the pack's worked examples */
const d113 = EV.americanToDecimal(-113);
chk('W01 +6.5 −113 at p .58: BE 53.05%, EV +9.33%', near(1 / d113, 0.5305, 1e-4) && near(EV.twoWayEv(0.58, 0, d113), 0.0933, 1e-4));
chk('W02 alt +7.5 −178 at p .61: BE 64.03%, EV −4.73%', near(1 / EV.americanToDecimal(-178), 0.6403, 1e-4) && near(EV.twoWayEv(0.61, 0, EV.americanToDecimal(-178)), -0.0473, 1e-4));
chk('W03 +7 −110 win .54 push .04: EV +7.09%, BE 50.29%', near(EV.twoWayEv(0.54, 0.04, EV.americanToDecimal(-110)), 0.0709, 1e-4) && near(EV.breakEven(EV.americanToDecimal(-110), 0.04).unconditional, 0.5029, 1e-4));
chk('W04 same +6.5 at −105 vs −120 (p .56): 9.33% vs 2.67%', near(EV.twoWayEv(0.56, 0, EV.americanToDecimal(-105)), 0.0933, 1e-4) && near(EV.twoWayEv(0.56, 0, EV.americanToDecimal(-120)), 0.0267, 1e-4));
chk('W06 quarter handicap F19: +8.45%', near(EV.asianQuarterEv(0.46, 0.10, 0.08, 0.36, 1.95), 0.0845, 1e-4));
chk('W07 exchange back 2.10, p .5, 5% commission F20: +2.25% (not +5%)', near(EV.expectedValue(EV.exchangeBackStates(0.5, 2.10, 0.05)), 0.0225, 1e-9));
const lay = EV.exchangeLayStates(0.4, 2.5, 0.05);
chk('exchange LAY per unit of liability: (1−c)/(d−1) on a win, −1 on a loss', near(lay[0].payoff, 0.95 / 1.5) && lay[1].payoff === -1 && lay[0].basis === 'LIABILITY' && near(EV.expectedValue(lay), 0.6 * 0.95 / 1.5 - 0.4, 1e-12));
/* Asian quarter settlement from a margin pmf */
const pmf = (k) => ({ '-1': 0.3, '0': 0.25, '1': 0.2, '2': 0.25 })[String(k)] || 0;
const aq = EV.asianQuarterStates(-0.25, pmf, 1.9, [-5, 5]), aqm = {}; aq.forEach((x) => { aqm[x.state] = x.p; });
chk('AH −0.25: a draw is HALF LOSS, a win is FULL WIN', near(aqm.HALF_LOSS, 0.25) && near(aqm.FULL_WIN, 0.45) && near(aqm.FULL_LOSS, 0.3) && near(aqm.HALF_WIN, 0));
const aq2 = EV.asianQuarterStates(-0.75, pmf, 1.9, [-5, 5]), aqm2 = {}; aq2.forEach((x) => { aqm2[x.state] = x.p; });
chk('AH −0.75: winning by one is HALF WIN', near(aqm2.HALF_WIN, 0.2) && near(aqm2.FULL_WIN, 0.25) && near(aqm2.FULL_LOSS, 0.55));
chk('AH quarter EV equals the settlement-state sum', near(EV.expectedValue(aq), 0.45 * 0.9 - 0.5 * 0.25 - 0.3, 1e-12));
chk('F12/F13: ROI % and dollars per $100 are the same EV, labelled', (function () { const r = evr({ fair: -3, center: -3, quotes: [q('a', 'bk', 3, -110, -110)] }); const s = r.selected; return s && near(s.ev_roi_pct, 100 * s.calibrated_ev, 1e-3) && near(s.ev_dollars_per_100, 100 * s.calibrated_ev, 0.01); })());
chk('market registry: spread ACTIVE, moneyline RESEARCH, quarter AH CONTRACT_ONLY, pari-mutuel / live / SGP BLOCKED',
  EV.marketSupport('spread').decides && !EV.marketSupport('moneyline').decides && EV.marketSupport('asian_quarter').status === 'CONTRACT_ONLY'
  && ['pari_mutuel', 'live', 'sgp', 'futures', 'promo'].every((k) => EV.marketSupport(k).status === 'BLOCKED') && EV.marketSupport('nope').status === 'UNSUPPORTED');

/* ======================================================================= 3 */
section('3. market de-vig benchmark');
const d2 = [EV.americanToDecimal(-150), EV.americanToDecimal(130)];
const prop = EV.devig(d2, 'proportional'), pow = EV.devig(d2, 'power'), add = EV.devig(d2, 'additive'), shin = EV.devig(d2, 'shin');
chk('F14 proportional sums to one', prop.ok && near(prop.p[0] + prop.p[1], 1, 1e-12) && near(prop.p[0], prop.raw[0] / (prop.raw[0] + prop.raw[1]), 1e-12));
chk('F15 power: Σ q^k = 1', pow.ok && near(Math.pow(pow.raw[0], pow.power_k) + Math.pow(pow.raw[1], pow.power_k), 1, 1e-9));
chk('F16 additive: q − overround/N', add.ok && near(add.p[0], add.raw[0] - add.overround / 2, 1e-12));
chk('Shin equals additive for a two-way market', shin.ok && near(shin.p[0], add.p[0], 1e-6));
chk('F17 two-way overround', near(prop.overround, 1 / d2[0] + 1 / d2[1] - 1, 1e-12));
const three = [2.2, 3.4, 3.6], d3 = EV.devig(three, 'proportional');
chk('F18 three-way (1X2) overround and a distribution', d3.ok && near(d3.overround, 1 / 2.2 + 1 / 3.4 + 1 / 3.6 - 1, 1e-12) && near(d3.p.reduce((a, b) => a + b, 0), 1, 1e-12));
const longshot = EV.devig([1.02, 30], 'additive');
chk('the additive guard trips on an extreme longshot, never returning a negative probability', !longshot.ok || longshot.p.every((x) => x > 0));
chk('power and Shin favour the favourite relative to proportional (longshot bias shape)', pow.p[0] > prop.p[0] - 1e-9 && shin.p[0] > prop.p[0] - 1e-9);
chk('a de-vig of an impossible book is refused', !EV.devig([1.2, 1.2], 'proportional').ok && !EV.devig([2.2, 2.2], 'proportional').ok);
chk('the moneyline benchmark is labelled a benchmark, never EdgeDesk’s probability', (function () { const r = evr({ fair: 3, center: 3, quotes: [q('a', 'bk', -3, -110, -110)], ml: { book: 'bk', price_home: -150, price_away: 130, observed_at: FRESH } }); return r.moneyline.available && r.moneyline.decides === false && r.moneyline.market_benchmark_home && near(r.moneyline.market_benchmark_home.proportional, prop.p[0], 1e-5); })());

/* ======================================================================= 4 */
section('4. staking arithmetic (downstream, disabled)');
chk('F21 full Kelly (p·b − q)/b', near(EV.kellyFraction(0.55, 0, 2.0), (0.55 - 0.45) / 1, 1e-12));
chk('F22 Kelly with push', near(EV.kellyFraction(0.5, 0.05, 2.1), (0.5 * 1.1 - 0.45) / (1.1 * 0.95), 1e-12));
chk('a negative-EV price stakes zero', EV.kellyFraction(0.45, 0, 1.9) === 0);
chk('F23 robust quarter Kelly ≤ quarter Kelly and capped', EV.robustKelly([0.52, 0.53, 0.54, 0.55, 0.56], 0, 2.0, 0.25, 0.01) <= 0.25 * EV.kellyFraction(0.54, 0, 2.0) + 1e-12);
chk('the policy never enables staking by default', EV.POLICY.staking.enabled === false && JSON.parse(fs.readFileSync(path.join(__dirname, 'policy', 'cfb_ev_policy_v1.json'), 'utf8')).staking.enabled === false);

/* ======================================================================= 5 */
section('5. CLV, edge decay, the juice panel');
const snapX = { snapshot_id: 's1', game_id: 'g', side: 'away', line_value: 6.5, decimal_odds: EV.americanToDecimal(-110), decision_ts: '2026-10-01T12:00:00Z', kickoff_ts: KICK, decision_status: 'PASS', policy_decision: 'PASS', actionable: false };
const gX = EV.grade(snapX, { close_home_line: -5.5, final_margin: 3 });
chk('F24 line CLV: entry +6.5, close +5.5 → +1.0 (positive = the bettor got the better line)', gX.clv_points === 1 && gX.beat_close === true);
const gY = EV.grade(Object.assign({}, snapX, { line_value: 5.5 }), { close_home_line: -5.5, close_price_home: -120, close_price_away: 100, final_margin: 3 });
chk('F25 price CLV at the same line: −110 entry, +100 close → negative (the price got better after entry)', gY.clv_probability < 0 && near(gY.clv_probability, 0.5 - 110 / 210, 1e-6));
chk('grading: away +6.5 with the home side winning by 3 is a FULL WIN at the recorded price', gX.bet_result_state === 'FULL_WIN' && near(gX.realized_net_units, 100 / 110, 1e-6));
chk('grading: an integer line landing exactly is a PUSH (0 units)', EV.grade(Object.assign({}, snapX, { line_value: 3 }), { close_home_line: -3, final_margin: 3 }).bet_result_state === 'PUSH');
const dd1 = EV.edgeDecay({ edge: 0.04, ev: 0.06, label: 'A +7 -110' }, { edge: 0.01, ev: 0.01, label: 'A +6 -110' });
chk('F26 edge decay 75% with same sign', dd1.state === 'MOSTLY_GONE' && near(dd1.decay_pct, 0.75, 1e-9));
const dd2 = EV.edgeDecay({ edge: 0.04, ev: 0.06, label: 'A +7' }, { edge: -0.02, ev: -0.04, label: 'A +4' });
chk('F26 a sign flip is EDGE REVERSED, never a naive >100% ratio', dd2.state === 'REVERSED' && dd2.decay_pct === null);
chk('edge decay: no initial edge, no ratio', EV.edgeDecay({ edge: -0.01, label: 'x' }, { edge: 0.02, label: 'y' }).state === 'NO_INITIAL_EDGE');
const J = evr({ fair: -3, center: -3, quotes: [q('m', 'bk', 6.5, -113, -107), q('a', 'bk', 7.5, -178, 150, FRESH, { alternate: true })], artifact: IDENTITY });
const altRow = J.main_vs_alt.rows[0];
chk('F27/F28: the juice panel states Δcover, Δbreak-even and ΔEV', altRow && altRow.vs_main && near(altRow.vs_main.delta_break_even, 1 / EV.americanToDecimal(-178) - 1 / EV.americanToDecimal(-113), 1e-5) && altRow.vs_main.explanation[0] === 'EXTRA 1.0 POINT');
chk('the explanation reads "EXTRA 1.0 POINT / +x pp model … / +y pp required break-even / EV falls from … to …"', /pp model/.test(altRow.vs_main.explanation[1]) && /required break-even/.test(altRow.vs_main.explanation[2]) && /^EV falls from/.test(altRow.vs_main.explanation[3]));
chk('juice cents: −113 → −178 is +65 cents more', altRow.vs_main.juice_cost_cents === 65);

/* ======================================================================= 6 */
section('6. the frozen curve: signs, pushes, the location move');
const cv = RD.buildCurve(normalCover(3, 14), 3, 30, {});
const h7 = EV.probabilityAt(cv, 'home', -7), h75 = EV.probabilityAt(cv, 'home', -7.5), a7 = EV.probabilityAt(cv, 'away', 7);
chk('probabilities sum to one', near(h7.win + h7.push + h7.loss, 1, 1e-9));
chk('home −7 and away +7 are the same event, mirrored (sign reversal)', near(h7.win, a7.loss, 1e-9) && near(h7.loss, a7.win, 1e-9) && near(h7.push, a7.push, 1e-9));
chk('+7 vs +7.5 differ by exactly P(margin = 7)', near(EV.probabilityAt(cv, 'away', 7.5).win - a7.win, a7.push, 1e-6));
chk('a half point has no push mass', EV.probabilityAt(cv, 'home', -7.5).push === 0);
chk('a quarter line is not priced from the curve', EV.probabilityAt(cv, 'home', -7.25) === null);
chk('a line outside the curve is not priced (never extrapolated, never 50%)', EV.probabilityAt(cv, 'home', -60) === null);
const s0 = EV.shiftedHome(cv, -7, 0), s1 = EV.shiftedHome(cv, -7, 1), s05 = EV.shiftedHome(cv, -7, 0.5);
chk('an integer move reproduces a lookup at the moved line', near(s1.win, EV.probabilityAt(cv, 'home', -6).win, 1e-9) && near(s0.win, h7.win, 1e-9));
chk('a fractional move is the mixture of the two integer moves (push kept on integers)', near(s05.win, 0.5 * (s0.win + s1.win), 1e-9) && near(s05.push, 0.5 * (s0.push + s1.push), 1e-9) && near(s05.win + s05.push + s05.loss, 1, 1e-9));
const target = 0.5, ds = EV.solveShift(cv, -7, target);
chk('solveShift finds the move that gives the target conditional cover', near(EV.shiftedHome(cv, -7, ds).cover, target, 1e-6));
chk('curveSane accepts a coherent curve and refuses one whose P(margin > t) rises', EV.curveSane(cv).ok && !EV.curveSane(Object.assign({}, cv, { win: cv.win.map((w, i) => i === 10 ? cv.win[9] + 0.01 : w) })).ok);

/* ======================================================================= 7 */
section('7. calibration: maps, the artifact contract, the market-line anchor');
chk('identity map', EV.applyCalibrator({ method: 'identity' }, 0.63) === 0.63);
chk('Platt σ(a + b·logit p)', near(EV.applyCalibrator({ method: 'platt', a: 0.1, b: 0.5 }, 0.7), 1 / (1 + Math.exp(-(0.1 + 0.5 * Math.log(0.7 / 0.3)))), 1e-9));
chk('temperature: T → ∞ collapses to 0.5', near(EV.applyCalibrator({ method: 'temperature', T: 1e6 }, 0.8), 0.5, 1e-5));
chk('beta and isotonic go through decision.js applyMap (one implementation)', near(EV.applyCalibrator({ method: 'beta', a: 1, b: 1, c: 0 }, 0.3), DEC.applyMap({ method: 'beta', a: 1, b: 1, c: 0 }, 0.3), 1e-12) && near(EV.applyCalibrator({ method: 'isotonic', x: [0.2, 0.8], y: [0.3, 0.7] }, 0.5), 0.5, 1e-12));
const va = EV.vennAbers({ scores: [0.1, 0.3, 0.5, 0.7, 0.9], labels: [0, 0, 1, 1, 1] }, 0.6);
chk('Venn-Abers returns an interval p0 ≤ p1 and a merged probability', va.p0 <= va.p1 && va.p > 0 && va.p < 1);
/* fit → apply round trips */
const rng = (s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; }, rr = rng(7);
const ps = [], ys = [];
for (let i = 0; i < 3000; i++) { const p = 0.2 + 0.6 * rr(); ps.push(p); ys.push(rr() < 0.5 + 0.3 * (p - 0.5) ? 1 : 0); }
const pl = C.fitPlatt(ps, ys);
chk('fit Platt recovers an overconfident slope (< 1) on overconfident data', pl.b < 0.6 && pl.b > 0.05, pl);
const tp = C.fitTemperature(ps, ys);
chk('fitted temperature applies through lib/edgedesk_ev.js', near(EV.applyCalibrator(tp, 0.7), 1 / (1 + Math.exp(-Math.log(0.7 / 0.3) / tp.T)), 1e-9));
const iso = C.fitIsotonic(ps, ys);
chk('isotonic fit is monotone', iso.y.every((v, i) => i === 0 || v >= iso.y[i - 1] - 1e-12));
chk('calibrationFor: no artifact → MISSING, unusable', EV.calibrationFor(null, 'cfb|spread|close', 'test').status === 'MISSING');
chk('calibrationFor: another model version → VERSION_MISMATCH', EV.calibrationFor(IDENTITY, 'cfb|spread|close', 'edgedesk_cfb_v2.1.0').status === 'VERSION_MISMATCH');
chk('calibrationFor: NOT_VALIDATED is never usable', !EV.calibrationFor(artifact('platt', 'NOT_VALIDATED', { a: 0, b: 0.5 }), 'cfb|spread|close', 'test').usable);
chk('calibrationFor: PROMOTED and IDENTITY_VALIDATED are usable', EV.calibrationFor(MARKETCAL, 'cfb|spread|close', 'test').usable && EV.calibrationFor(IDENTITY, 'cfb|spread|close', 'test').usable);
/* identity baseline: calibrated == raw everywhere */
const idr = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -113, -107), q('a', 'bk', 7.5, -150, 125, FRESH, { alternate: true })], artifact: IDENTITY });
chk('identity baseline: calibrated cover equals raw at the main line and at an alternate', idr.price_curve.offered.every((x) => near(x.cover_calibrated, x.cover_raw, 1e-9)));
/* the anchor: a map that discards the model's view centres the distribution on the market line */
const mk = evr({ fair: -1, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)], artifact: MARKETCAL });
chk('the anchor: at the market line the calibrated cover is the map’s value (50% for T → ∞)', near(mk.selected.p_cover_calibrated, 0.5, 1e-3), mk.selected.p_cover_calibrated);
chk('the calibrator’s inputs are football-only: the artifact has no market field; the market line only locates the map', mk.calibration_anchor && mk.calibration_anchor.home_line === 6.5 && !('market_shrinkage' in MARKETCAL.calibrators['cfb|spread|close']));
const mkAlt = EV.whatIf(input({ fair: -1, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)] }), { side: 'away', line: 9.5, price: -110 }, { artifact: MARKETCAL, now: NOW });
chk('carried to an alternate, the calibrated cover rises with the extra points (not a coin flip everywhere)', mkAlt.option.p_cover_calibrated > 0.55, mkAlt.option.p_cover_calibrated);
chk('no market line to anchor → calibrated EV unavailable (fail closed)', (function () { const r = evr({ fair: -1, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110, OLD)], artifact: MARKETCAL }); return r.decision_status === 'NO_DECISION'; })());

/* ======================================================================= 8 */
section('8. uncertainty: Pr(EV>0) and the conservative quantile');
const U = evr({ fair: -3, center: -3, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY });
const us = U.selected;
chk('F29 Pr(EV>0) is a share of samples in [0,1]', us.prob_ev_positive >= 0 && us.prob_ev_positive <= 1 && us.robust.n === 500);
chk('F30 the conservative EV is the pre-registered 10th percentile, below the median', us.robust.conservative_quantile === 0.10 && us.conservative_ev <= us.robust.median + 1e-12);
chk('the interval is 5th–95th and brackets the median', us.ev_ci_low <= us.robust.median && us.robust.median <= us.ev_ci_high && us.robust.interval[0] === 0.05);
const U2 = evr({ fair: -3, center: -3, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY });
chk('EV recomputes deterministically (seeded samples)', JSON.stringify(U.selected) === JSON.stringify(U2.selected));
const Uw = evr({ fair: -3, center: -3, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY, agreement: { sd: 8 } });
chk('excess model disagreement widens the interval (identity keeps the model’s view)', (Uw.selected.ev_ci_high - Uw.selected.ev_ci_low) > (us.ev_ci_high - us.ev_ci_low), [Uw.selected.ev_ci_low, Uw.selected.ev_ci_high, us.ev_ci_low, us.ev_ci_high]);
const Um = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: MARKETCAL, agreement: { sd: 8 } });
chk('a map that discards the model’s view does not sample its location noise', Um.uncertainty.tau_pts === 0 || Um.uncertainty.tau_pts < 0.01);

/* ======================================================================= 9 */
section('9. the EV read: fixtures and demonstrations');
/* positive main-line EV (identity, the model at −3, the book at +6.5 −105) */
const pos = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY });
chk('[1] positive main-line EV: calibrated EV > 0 and the policy clears', pos.selected.calibrated_ev > 0 && pos.selected.policy_clears, pos.selected);
chk('[1] …in SHADOW the reader sees RESEARCH ONLY; the policy’s BET is recorded', pos.decision_status === 'RESEARCH_ONLY' && /^BET/.test(pos.policy_decision) && pos.blockers.some((b) => /^EV_POLICY_SHADOW/.test(b.code)));
const posP = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY, policy: PROD });
chk('[9] with a PRODUCTION policy and betting on, the same quote is actionable', posP.actionable && (posP.decision_status === 'BET' || posP.decision_status === 'BET_EARLY'));
/* negative main-line EV */
const neg = evr({ fair: -6.5, center: -6.5, quotes: [q('m', 'bk', 6.5, -115, -105)], artifact: IDENTITY });
chk('[2] negative main-line EV → PASS with a structured blocker', neg.decision_status === 'PASS' && neg.selected.calibrated_ev < 0 && neg.blockers.some((b) => b.code === 'PRICE'));
/* main beats the safer alternate */
const alt = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -113, -107), q('a', 'bk', 7.5, -178, 150, FRESH, { alternate: true })], artifact: IDENTITY });
const altV = alt.main_vs_alt.rows[0].vs_main;
chk('[3] main beats the safer alt: +7.5 −178 is WORSE VALUE though it covers more', altV.verdict === 'WORSE_VALUE' && altV.delta_win > 0 && alt.labels.best_ev === alt.labels.best_main_line && alt.labels.safest_line !== alt.labels.best_ev, altV);
chk('[3] SAFEST is never the default preference', alt.labels.safest_line === alt.main_vs_alt.rows[0].option.label && /never the preferred/.test(alt.labels.note));
/* an alternate that is legitimately better value */
const alt2 = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -113, -107), q('a', 'bk', 7.5, -118, 100, FRESH, { alternate: true })], artifact: IDENTITY });
chk('[4] a cheap alternate is BETTER VALUE and becomes BEST EV', alt2.main_vs_alt.rows[0].vs_main.verdict === 'BETTER_VALUE' && alt2.labels.best_ev === alt2.labels.best_alt_value);
/* integer line with push */
const int = evr({ fair: -3, center: -7, quotes: [q('m', 'bk', 7, -110, -110)], artifact: IDENTITY });
chk('[5] integer line: three settlement states, push mass, unconditional break-even below 1/d', int.selected.settlement.states.join() === 'FULL_WIN,PUSH,FULL_LOSS' && int.selected.p_push_raw > 0.01 && int.selected.break_even_unconditional < int.selected.break_even_probability);
/* stale quote suppressed */
const stale = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115, OLD)], artifact: IDENTITY });
chk('[6] a stale quote is never priced as actionable: NO DECISION · STALE QUOTE', stale.decision_status === 'NO_DECISION' && stale.decision_reason_code === 'STALE_QUOTE' && !stale.selected);
/* the stale line changed by 2.5 points (W05): EV at the fresh number, never the stored one */
const w05 = evr({ fair: -9, center: -13.5, quotes: [q('old', 'bk', 16, -110, -110, OLD), q('new', 'bk', 13.5, -110, -110)], stored: [{ label: 'app panel', origin: 'STORED', book: 'bk', home_line: 16, observed_at: OLD }], artifact: IDENTITY, home: 'Texas A&M', away: 'Arkansas' });
chk('W05 stale +16 vs fresh +13.5: the EV read prices +13.5 only', w05.selected && w05.selected.line === 13.5 && w05.price_curve.offered.every((x) => x.line !== 16));
/* INVESTIGATE with attractive raw EV */
const inv = evr({ fair: 5, center: -7, quotes: [q('m', 'bk', 7, -110, -110)], artifact: IDENTITY, research: { status_key: 'INVESTIGATE', reason: 'unverified 12-point gap', disagreement: { class: 'MAJOR', points: 12, verified: false } } });
chk('[7] INVESTIGATE with attractive raw EV: NO DECISION, EV shown as research context', inv.decision_status === 'NO_DECISION' && inv.selected && inv.selected.raw_model_ev > 0.1 && inv.blockers.some((b) => b.code === 'INVESTIGATE'));
/* VERIFIED MAJOR that still returns PASS */
const vm = evr({ fair: -14, center: -7, quotes: [q('m', 'bk', 7, -110, -110)], artifact: MARKETCAL, research: { status_key: 'RESEARCH', disagreement: { class: 'MAJOR', points: 7, verified: true } } });
chk('[8] VERIFIED MAJOR still PASSes when the calibrated price fails', vm.research_status === 'VERIFIED_MAJOR_DISAGREEMENT' && vm.decision_status === 'PASS' && vm.blockers.some((b) => b.code === 'VERIFIED_MAJOR_IS_NOT_A_BET'), [vm.decision_status, vm.research_status]);
/* BET EARLY: market moving toward EdgeDesk, production policy */
const be1 = evr({ fair: -2, center: -5.5, quotes: [q('m', 'bk', 5.5, -105, -115)], open: { home_line: 7, observed_at: OLD }, artifact: IDENTITY, policy: PROD });
chk('[9] BET EARLY: the market moved toward EdgeDesk, the price clears, fresh, production', be1.decision_status === 'BET_EARLY' && be1.actionable, [be1.decision_status, be1.decision_reason]);
const be2 = evr({ fair: -2, center: -5.5, quotes: [q('m', 'bk', 5.5, -105, -115)], open: { home_line: 7, observed_at: OLD }, artifact: IDENTITY });
chk('[9] …the same read in SHADOW is RESEARCH ONLY with timing BET EARLY recorded', be2.decision_status === 'RESEARCH_ONLY' && be2.policy_decision === 'BET_EARLY' && be2.timing === 'BET_EARLY');
/* WAIT with a target price (identity: the model's view survives a market move) */
const wt = evr({ fair: -3.5, center: -5.5, quotes: [q('m', 'bk', 5.5, -130, 110)], artifact: IDENTITY });
chk('[10] WAIT with a target: a better number within ordinary movement would clear', wt.decision_status === 'WAIT' && wt.target_price && /TARGET/.test(wt.target_price.text), [wt.decision_status, wt.decision_reason]);
chk('[10] …the target is stated as a line OR a price ("CURRENT … → TARGET … OR …")', wt.target_price && /^CURRENT .* → TARGET /.test(wt.target_price.text));
const wtM = evr({ fair: -3.5, center: -5.5, quotes: [q('m', 'bk', 5.5, -120, 100)], artifact: MARKETCAL });
chk('[10] …under a map that discards the model’s view, a market move carries the probability: no WAIT, a SHOPPING target', wtM.decision_status === 'PASS' && (wtM.blockers.some((b) => b.code === 'TARGET_MOVES_WITH_MARKET') || !wtM.target_price || /SHOPPING/.test(wtM.decision_reason)), [wtM.decision_status, wtM.decision_reason]);
/* PRICE GONE: an earlier frozen snapshot cleared, the current price does not */
const hist = [{ snapshot_id: 'e1', side: 'home', selection_market: 'spread', policy_clears: true, probability_edge: 0.05, calibrated_ev: 0.08, label: 'Michigan +8.5 -110', decision_ts: '2026-09-30T12:00:00Z' }];
const pg = evr({ fair: -4, center: -6.5, quotes: [q('m', 'bk', 6.5, -140, 120)], artifact: IDENTITY, history: hist });
chk('[11] PRICE GONE: the earlier read cleared, today’s price does not; the earlier read stays frozen', pg.decision_status === 'PRICE_GONE' && pg.price_gone && pg.edge_decay.initial_probability_edge === 0.05 && Object.isFrozen(hist[0]) === false);
/* market aligned PASS */
const al = evr({ fair: -6.5, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)], artifact: IDENTITY, research: { status_key: 'MARKET_ALIGNED', disagreement: { class: 'NONE', points: 0 } } });
chk('market aligned: PASS on negative EV at standard juice', al.decision_status === 'PASS' && al.selected.calibrated_ev < 0);
/* favorite flip */
const ff = evr({ fair: 3, center: -2.5, quotes: [q('m', 'bk', 2.5, -110, -110)], artifact: IDENTITY });
chk('favorite flip is flagged on the read and on the snapshot', ff.favorite_flip.flag && EV.snapshot(ff).favorite_flip === true);
/* quote outlier: three books, one far off — excluded from the consensus that anchors the calibrator */
const out3 = evr({ fair: -3, center: -6.5, quotes: [q('b1', 'b1', 6.5, -110, -110), q('b2', 'b2', 6.5, -110, -110), q('b3', 'b3', 6.5, -108, -112), q('b4', 'b4', 13.5, -110, -110)], artifact: MARKETCAL });
chk('a quote outlier is excluded from the consensus (the anchor stays at the market)', out3.market_consensus && out3.market_consensus.home_line === 6.5);
chk('…and the off-market book shows as a BOOK-SPECIFIC price, not as the football model’s edge', out3.edge_kind && out3.selected.book === 'b4' && out3.edge_kind.kind === 'BOOK_SPECIFIC_PRICE_EDGE', out3.edge_kind);
/* model edge vs book edge (§22): EdgeDesk −7, consensus −6.5, one book −4.5 */
const mb = evr({ fair: 7, center: 6.5, home: 'Michigan', away: 'Minnesota', quotes: [q('c1', 'c1', -6.5, -110, -110), q('c2', 'c2', -6.5, -110, -110), q('x', 'x', -4.5, -110, -110)], artifact: IDENTITY });
chk('EdgeDesk −7, consensus −6.5, book −4.5: the model edge is small, the book-specific edge is large', mb.edge_kind.book_specific_ev > 0.03 && mb.selected.book === 'x', mb.edge_kind);
/* best available price by EV, not by the biggest number or the lowest juice */
const shop = evr({ fair: -3, center: -6.5, quotes: [q('a', 'A', 6.5, -105, -115), q('b', 'B', 7, -125, 105), q('c', 'C', 6, 100, -120)], artifact: IDENTITY });
const byEv = shop.line_shopping.map((x) => x.book);
chk('best available price is ranked by EV at each book’s own line and price', shop.selected.book === byEv[0] && shop.line_shopping.every((x, i, a) => i === 0 || (a[i - 1].conservative_ev || -9) >= (x.conservative_ev || -9) - 1e-12));
/* user books: the primary read uses accessible books only; the broader market is context */
const mine = evr({ fair: -3, center: -6.5, quotes: [q('a', 'A', 6.5, -105, -115), q('b', 'B', 6.5, -125, 105)], artifact: IDENTITY }, { books: ['B'] });
chk('user book set: the selected price is at one of the reader’s books; others are context', mine.selected.book === 'B' && mine.broader_market.some((x) => x.book === 'A'));
/* manual quote entry */
const man = EV.manual(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)] }), 'Minnesota +6.5 -115', { artifact: IDENTITY, now: NOW });
chk('manual entry: tagged USER QUOTE, priced, never certified, never in the consensus', man.ok && man.source_tag === 'USER QUOTE' && man.option.origin === 'USER' && /never certified/.test(man.note));
chk('manual entry without a price is refused (no assumed −110)', !EV.manual(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)] }), 'Minnesota +6.5', { artifact: IDENTITY, now: NOW }).ok);
/* what-if: only the quote changes */
const wi = EV.whatIf(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)] }), { side: 'away', line: 5.5, price: -110 }, { artifact: IDENTITY, now: NOW });
chk('what-if +5.5 −110: cover, push, break-even, EV and robust EV recomputed, no model run', wi.ok && wi.option.line === 5.5 && typeof wi.option.p_push_raw === 'number' && /not re-run/.test(wi.note));
/* bettable-to and the EV-zero price */
chk('bettable to: the worst line at the current price and the worst price at the current line both clear', (function () { const B = pos.bettable_to.bettable_to; if (!B) return false; const L = B.line_at_current_price, Pw = B.price_at_current_line;
  const a = EV.whatIf(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)] }), { side: 'home', line: L, price: -105 }, { artifact: IDENTITY, now: NOW });
  const b = EV.whatIf(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)] }), { side: 'home', line: 6.5, price: Pw }, { artifact: IDENTITY, now: NOW });
  const c = EV.whatIf(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)] }), { side: 'home', line: 6.5, price: Pw < 0 ? Pw - 3 : (Pw - 3 < 100 ? -100 - (103 - Pw) : Pw - 3) }, { artifact: IDENTITY, now: NOW });
  return a.option.policy_clears && b.option.policy_clears && !c.option.policy_clears; })());
chk('the EV-zero price is the calibrated fair price', pos.bettable_to.ev_zero && pos.selected.fair_american === pos.bettable_to.ev_zero.price_at_current_line);
/* extreme EV circuit breaker */
const ex = evr({ fair: -2, center: -16.5, quotes: [q('m', 'bk', 16.5, -110, -110)], artifact: IDENTITY, policy: PROD });
chk('the extreme-EV circuit breaker triggers, the EV is not capped, and nothing is actionable before verification', ex.circuit_breaker.triggered && ex.selected.calibrated_ev > 0.2 && !ex.actionable && ex.blockers.some((b) => b.code === 'EXTREME_EV_REVIEW'), [ex.circuit_breaker.level, ex.decision_status]);
/* LIMITED DATA */
const lim = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY, policy: PROD, reliability: 40, research: { status_key: 'RESEARCH', limited: 'reliability 40 is under 60', disagreement: { class: 'MODERATE', points: 3.5 } } });
chk('LIMITED DATA / low reliability caps at RESEARCH ONLY', lim.decision_status === 'RESEARCH_ONLY' && !lim.actionable);
/* the key-number verdict */
const kn = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -140, 120), q('a', 'bk', 7.5, -115, -105, FRESH, { alternate: true })], artifact: Object.assign({}, IDENTITY, { key_numbers: { validated: false, primary: [3, 7], finding: 'test finding. Cause: x' } }), policy: PROD });
chk('an alternate crossing 7 is never actionable while key-number mass is NOT VALIDATED', kn.selected.key_number_unvalidated && kn.decision_status === 'RESEARCH_ONLY' && kn.blockers.some((b) => b.code === 'KEY_NUMBER_MASS_UNVALIDATED'), [kn.selected.label, kn.decision_status]);
/* the recheck */
const rq = EV.recheck(EV.contextOf(input({ fair: -3, center: -6.5 }), { artifact: IDENTITY, anchor_home_line: -6.5 }), Object.assign({}, pos.selected, { quote_id: 'gone' }), [RD.normalizeQuote(q('m2', 'bk', 5, -110, -110), 0)]);
chk('fresh-quote recheck: a changed price is REQUOTED and re-priced at the new line', rq.status === 'REQUOTED' && rq.option.line === 5);
chk('fresh-quote recheck: a vanished price is UNAVAILABLE', EV.recheck(EV.contextOf(input({}), { artifact: IDENTITY }), pos.selected, []).status === 'UNAVAILABLE');
/* home/away sign reversal: mirror the game and the EV is identical */
const hA = evr({ fair: -3, center: -6.5, home: 'H', away: 'A', quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: IDENTITY });
const hB = evr({ fair: 3, center: 6.5, home: 'A', away: 'H', quotes: [q('m', 'bk', -6.5, -115, -105)], artifact: IDENTITY });
chk('home/away sign reversal: the mirrored game prices the same team at the same EV', hA.selected.team === hB.selected.team && near(hA.selected.calibrated_ev, hB.selected.calibrated_ev, 1e-9) && near(hA.selected.p_cover_raw, hB.selected.p_cover_raw, 1e-9));
/* words */
chk('research words only: every fixture passes the language audit', [pos, neg, alt, int, stale, inv, vm, be1, wt, pg, ex, kn].every((r) => r.language.ok));
chk('the audit refuses lock / hammer / free money / max bet / guaranteed', ['LOCK of the week', 'hammer it', 'free money', 'MAX BET', 'guaranteed winner'].every((t) => !EV.auditText(t).ok));
chk('the tooltip says what EV is and is not', /long-run return of this exact price/.test(EV.TOOLTIP) && /not a guarantee/.test(EV.TOOLTIP));

/* ====================================================================== 10 */
section('10. fail closed');
chk('no model → NO DECISION', evr({ model: false, quotes: [q('m', 'bk', 6.5, -110, -110)] }).decision_status === 'NO_DECISION');
chk('no curve → NO DECISION · MODEL_ARTIFACT_MISSING', evr({ curve: null, quotes: [q('m', 'bk', 6.5, -110, -110)] }).decision_reason_code === 'MODEL_ARTIFACT_MISSING');
const badCurve = RD.buildCurve(normalCover(0, 14), 0, 30, {}); badCurve.win[20] = badCurve.win[19] + 0.02;
chk('an incoherent curve → NO DECISION · DISTRIBUTION_FAULT', evr({ curveObj: badCurve, quotes: [q('m', 'bk', 6.5, -110, -110)] }).decision_reason_code === 'DISTRIBUTION_FAULT');
chk('no calibration artifact → NO DECISION · CALIBRATION_UNAVAILABLE, raw EV labelled experimental', (function () { const r = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: null }); return r.decision_status === 'NO_DECISION' && r.decision_reason_code === 'CALIBRATION_UNAVAILABLE' && r.selected.probability_basis === 'RAW' && r.selected.calibrated_ev === null && /experimental/.test(r.decision_reason); })());
chk('no quotes → NO DECISION · NO_PRICE', evr({ quotes: [] }).decision_reason_code === 'NO_PRICE');
chk('a line without a price is not an option (no fallback to −110)', (function () { const r = evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, null, null)] }); return r.decision_status === 'NO_DECISION' && !r.selected; })());
chk('an unsupported settlement structure (a quarter line) is refused', (function () { const r = EV.whatIf(input({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -110, -110)] }), { side: 'away', line: 6.25, price: -110 }, { artifact: IDENTITY, now: NOW }); return !r.ok || /quarter/.test(r.option.problem || ''); })());
chk('a DATA FAULT → NO DECISION', evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], research: { status_key: 'DATA_FAULT', reason: 'broken join', disagreement: {} } }).decision_status === 'NO_DECISION');
chk('two current numbers for one book → NO DECISION · MARKET_CHECK', evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], stored: [{ label: 'x', origin: 'STORED', book: 'bk', home_line: 9.5, observed_at: '2026-10-01T14:55:00Z' }] }).decision_reason_code === 'MARKET_CHECK');
chk('a moneyline is research only: never decided on', evr({ fair: 3, center: 3, quotes: [q('m', 'bk', -3, -110, -110)], ml: { book: 'bk', price_home: -150, price_away: 130, observed_at: FRESH } }).moneyline.status === 'RESEARCH');

/* ====================================================================== 11 */
section('11. snapshot, grading, validation, the assistant');
const sn = EV.snapshot(pos, { season: 2026, week_id: '2026-w05' });
chk('snapshot carries every P0 identifier', EV.P0_REQUIRED.every((k) => sn[k] !== null && sn[k] !== undefined), EV.P0_REQUIRED.filter((k) => sn[k] == null));
chk('snapshot is immutable', Object.isFrozen(sn) && (function () { try { sn.decision_status = 'BET'; } catch (e) { /* strict */ } return sn.decision_status !== 'BET' || sn.decision_status === pos.decision_status; })());
chk('snapshot id is deterministic', EV.snapshot(pos, { season: 2026, week_id: '2026-w05' }).snapshot_id === sn.snapshot_id && /^edev_/.test(sn.snapshot_id));
chk('a calibration-pending snapshot is never production-grade', EV.snapshot(evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: null })).production_grade === false);
chk('the snapshot keeps raw, calibrated and robust EV separately', sn.raw_model_ev !== sn.calibrated_ev || sn.raw_model_ev === sn.calibrated_ev && 'conservative_ev' in sn && 'prob_ev_positive' in sn);
const gr = EV.grade(sn, { close_home_line: -5.5, final_margin: -2 });
chk('grading at the recorded number: the away +6.5 with the away side winning by 2 covers', gr.bet_result_state === 'FULL_WIN' && gr.graded);
chk('grading is hypothetical for a non-actionable read', gr.hypothetical === true);
chk('process and outcome are kept apart (the four quadrants)', /^(POSITIVE|NON_POSITIVE)_CLV_(WON|LOST|PUSHED)$/.test(gr.quadrant));
const snaps = [], grades = [];
for (let i = 0; i < 40; i++) { const r2 = evr({ id: 'v' + i, fair: -3 - (i % 5) * 0.5, center: -6.5, quotes: [q('m' + i, 'bk', 6.5, -105 - (i % 4) * 5, -115)], artifact: IDENTITY }); const s2 = EV.snapshot(r2, { season: 2026 }); snaps.push(s2); grades.push(EV.grade(s2, { close_home_line: -6, final_margin: (i % 3) - 5 })); }
const V = EV.validation(snaps, grades, { season: 2026 });
chk('validation: version groups, never blended', V.groups.current_ev_version && V.groups.legacy && V.groups.current_season && V.groups.last_n && V.groups.legacy.n_reads === 0);
chk('validation: probability quality and CLV first; EV buckets carry n and intervals', V.groups.current_ev_version.probability.calibrated.n > 0 && V.groups.current_ev_version.ev_buckets.every((b) => 'n' in b && 'roi_ci95' in b));
chk('validation: rates are withheld under the minimum n', EV.validation(snaps.slice(0, 5), grades.slice(0, 5)).groups.current_ev_version.clv.mean_pts === null);
chk('research triggers are candidates only — never a production change', V.research_triggers.every((t) => /no production change/.test(t.action)));
const a1 = EV.ask('Is the alt worth the juice?', alt), a2 = EV.ask('Why isn’t this a bet despite positive raw EV?', inv), a3 = EV.ask('What is the worst price you would take?', pos), a4 = EV.ask('Did we miss the number?', pg), a5 = EV.ask('Bet now or wait?', wt), a6 = EV.ask('Why is the EV positive?', pos);
chk('the assistant answers the six EV questions from the EV object', [a1, a2, a3, a4, a5, a6].every((a) => a && a.text && a.facts.length));
chk('every answer cites its provenance (model, calibrator, policy, quote)', a1.provenance.model_version === 'test' && a1.provenance.policy_version && a1.provenance.quote_book);
chk('a missing fact is UNKNOWN', /UNKNOWN/.test(EV.ask('Is the alt worth the juice?', pos).text) && EV.ask('why is the ev positive', null).text.indexOf('UNKNOWN') === 0);
chk('the assistant never recomputes: the juice answer quotes the juice panel verbatim', a1.text.indexOf(altV.explanation[0]) >= 0);

/* ====================================================================== 12 */
section('12. property tests');
let props = { sum: true, monotone: true, decimal: true, be: true, range: true, det: true, coherent: true, priceMono: true };
for (let t = 0; t < 60; t++) {
  const mu = -20 + (t * 7) % 40, sd = 11 + (t % 7), mkt = Math.round((mu + ((t % 5) - 2) * 2) * 2) / 2;
  const curve = RD.buildCurve(normalCover(mu, sd), mkt, 40, {});
  ['home', 'away'].forEach((side) => {
    let prevWin = -1;
    for (let L = -20; L <= 20; L += 0.5) {
      const p = EV.probabilityAt(curve, side, L); if (!p) continue;
      if (!near(p.win + p.push + p.loss, 1, 1e-9)) props.sum = false;
      if ([p.win, p.push, p.loss].some((x) => x < -1e-12 || x > 1 + 1e-12)) props.range = false;
      /* the curve is stored at 1e-6 precision, so a complement can step back by one unit */
      if (p.win < prevWin - 2.5e-6) props.monotone = false;
      prevWin = p.win;
    }
  });
  const price = [-160, -125, -110, -102, 105, 130][t % 6], od = EV.normalizeOdds(price);
  if (!(od.decimal > 1)) props.decimal = false;
  if (!(od.implied_raw >= 0 && od.implied_raw <= 1)) props.be = false;
  const iA = input({ fair: mu, center: mkt, sd: sd, quotes: [q('m', 'bk', mkt, price, -110)] });
  const e1 = EV.evRead(iA, RD.read(iA), { artifact: IDENTITY, now: NOW }), e2 = EV.evRead(iA, RD.read(iA), { artifact: IDENTITY, now: NOW });
  if (JSON.stringify(e1) !== JSON.stringify(e2)) props.det = false;
  if (e1.price_curve && e1.price_curve.coherent === false) props.coherent = false;
  const lo = EV.whatIf(iA, { side: 'home', line: mkt, price: -120 }, { artifact: IDENTITY, now: NOW }), hi = EV.whatIf(iA, { side: 'home', line: mkt, price: -105 }, { artifact: IDENTITY, now: NOW });
  if (lo.ok && hi.ok && !(hi.option.calibrated_ev > lo.option.calibrated_ev)) props.priceMono = false;
}
chk('probabilities sum to one', props.sum); chk('no probability below 0 or above 1', props.range);
chk('P(win) is monotone as the line improves for the same side', props.monotone);
chk('decimal odds > 1', props.decimal); chk('break-even in [0,1]', props.be);
chk('EV recomputes deterministically', props.det); chk('the same frozen distribution gives a coherent price curve', props.coherent);
chk('a better price at the same line never lowers EV', props.priceMono);

/* ====================================================================== 13 */
section('13. the tournament artifact and its governance');
const AD = path.join(__dirname, 'artifacts', 'cfb_ev_calibration_v1');
const CAL = JSON.parse(fs.readFileSync(path.join(AD, 'calibration.json'), 'utf8')), TN = JSON.parse(fs.readFileSync(path.join(AD, 'tournament.json'), 'utf8'));
const MAN = JSON.parse(fs.readFileSync(path.join(AD, 'MANIFEST.json'), 'utf8')), DMAN = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.manifest.json'), 'utf8'));
const dsSha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'data', 'cfb_ev_calibration_rows_v1.csv.gz'))).digest('hex');
chk('the dataset on disk is the one the artifact was built from', CAL.dataset.sha256 === dsSha && MAN.dataset_sha256 === dsSha);
chk('the artifact is football-only and in the engine’s schema', CAL.schema === EV.CAL_SCHEMA && CAL.football_only === true && CAL.base_model_version === 'edgedesk_cfb_p4_v1.0.0');
chk('identity competes in every tournament', TN.tasks.every((t) => t.results.identity && t.results.identity.pooled.n > 0));
chk('no calibrator is evaluated on its own training seasons (walk-forward folds)', TN.tasks.every((t) => t.folds.every((f) => Number(f.train.split('-')[1]) < f.evaluate)));
chk('every candidate reports Brier, log loss, slope, CITL, ECE, reliability and sample size', TN.tasks.every((t) => Object.keys(t.results).every((m) => { const p = t.results[m].pooled; return ['brier', 'log_loss', 'slope', 'citl', 'ece', 'n'].every((k) => k in p) && p.reliability_curve.length; })));
const sp = TN.tasks.filter((t) => t.key === 'cfb|spread|close')[0];
chk('the promoted spread calibrator met the pre-registered rule (Δ log loss CI below 0, 2+ seasons)', sp.status === 'PROMOTED' && sp.results[sp.chosen].eligible && sp.results[sp.chosen].vs_identity.delta_log_loss_ci95[1] < 0);
chk('simple wins ties: the chosen method is no more complex than the best-scoring eligible one', C.ORDER.indexOf(sp.chosen) <= C.ORDER.indexOf(sp.eligible.slice().sort((a, b) => sp.results[a].pooled.log_loss - sp.results[b].pooled.log_loss)[0]));
chk('the moneyline calibrator is NOT validated (nothing beat identity; identity is not calibrated)', CAL.calibrators['cfb|moneyline|close'].status === 'NOT_VALIDATED');
const HA = fs.readFileSync(path.join(AD, 'holdout_access.jsonl'), 'utf8').split('\n').filter(Boolean);
chk('the 2026 holdout was read exactly once', HA.length === 1 && JSON.parse(HA[0]).version === 'cfb_ev_calibration_v1');
chk('the holdout confirms or revokes, never selects', TN.holdout && /^(CONFIRMED|REVOKED|nothing)/.test(TN.holdout['cfb|spread|close'].verdict));
chk('the key-number verdict is recorded (NOT VALIDATED on this data)', CAL.key_numbers && CAL.key_numbers.validated === false && /re-centres/.test(CAL.key_numbers.finding));
chk('the extreme-EV thresholds are out-of-sample percentiles', CAL.extremes.prob_p99 > CAL.extremes.prob_p95 && CAL.extremes.gap_p99 > CAL.extremes.gap_p95 && CAL.extremes.n >= 3000);
chk('the uncertainty layer carries bootstrap draws for every calibrator', Object.values(CAL.calibrators).every((c) => c.uncertainty && c.uncertainty.platt_draws.length >= 100));
chk('the dataset excludes in-sample seasons from every fit', DMAN.windows.IN_SAMPLE && TN.tasks.every((t) => t.n_oos < DMAN.rows));
const POL = JSON.parse(fs.readFileSync(path.join(__dirname, 'policy', 'cfb_ev_policy_v1.json'), 'utf8'));
chk('the policy file matches the engine defaults and names a provenance for every threshold', ['min_probability_edge', 'min_calibrated_ev', 'min_conservative_ev', 'conservative_quantile', 'max_price'].every((k) => POL[k] === EV.POLICY[k] && POL.provenance[k]) && POL.maturity === 'SHADOW' && POL.betting_enabled === false);
chk('PREREG exists and discloses post-registration changes', /Post-registration changes/.test(fs.readFileSync(path.join(ROOT, 'docs', 'edgedesk-ev', 'PREREG.md'), 'utf8')));

/* ====================================================================== 14 */
section('14. the real slate');
const G = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const games = Object.values(G.games);
chk('games.json carries the pinned EV artifact and policy', G.ev && G.ev.artifact && G.ev.artifact.version === 'cfb_ev_calibration_v1' && G.ev.policy && G.ev.policy.version === 'cfb_ev_policy_v1');
chk('every game has an EV read', games.length > 0 && games.every((o) => o.ev && o.ev.schema === 'edgedesk_ev_read_v1'));
chk('nothing is actionable while the EV policy is in SHADOW', games.every((o) => !o.ev.actionable && o.ev.decision_status !== 'BET' && o.ev.decision_status !== 'BET_EARLY'));
chk('every EV read passes the language audit', games.every((o) => o.ev.language.ok));
chk('one fair line: the EV read’s fair equals the research object’s', games.every((o) => !o.ev.fair_spread || !o.edgedesk.available || near(o.ev.fair_spread.home_margin, o.edgedesk.home_margin, 0.005)));
chk('every fresh priced selection has a calibrated probability (the spread calibrator is promoted)', games.every((o) => !o.ev.selected || o.ev.decision_reason_code === 'CALIBRATION_UNAVAILABLE' || o.ev.selected.p_cover_calibrated != null || o.ev.decision_status === 'NO_DECISION'));
let parity = 0, parityOk2 = true;
games.forEach((o) => {
  const R = o.read, E = o.ev;
  if (!R || !E || !R.selected || !E.selected || R.selected.book !== E.selected.book || R.selected.line !== E.selected.line || R.selected.side !== E.selected.side || !R.selected.price || R.selected.price.american !== E.selected.odds.american_display) return;
  parity++;
  if (!near(R.selected.raw_cover, E.selected.p_cover_raw, 1e-4) || !near(R.selected.break_even, E.selected.break_even_probability, 1e-6) || !near(R.selected.raw_ev, E.selected.raw_model_ev, 1e-4)) parityOk2 = false;
});
chk('no second calculation path: where the Read and the EV card price the same quote, raw cover, break-even and raw EV agree (' + parity + ' games)', parityOk2);
const genAt = Date.parse(G.generated_at);
let rebuilt = 0, same = 0;
games.slice(0, 20).forEach((o) => {
  if (!o.read_inputs) return;
  const inp = RD.fromTerminal(o, o.read_inputs, { now: genAt, integrity: INTEG });
  const e = EV.evRead(inp, RD.read(inp), { artifact: G.ev.artifact, policy: G.ev.policy, now: genAt, history: o.ev_history || [], typical_move_pts: o.read_inputs.config ? o.read_inputs.config.typical_move_pts : null });
  rebuilt++; if (JSON.stringify(e) === JSON.stringify(o.ev)) same++;
});
chk('the page recomputation equals the build byte for byte (' + same + '/' + rebuilt + ')', rebuilt > 0 && same === rebuilt);
chk('the EV decision statuses are the documented vocabulary', games.every((o) => Object.keys(EV.DECISION).indexOf(o.ev.decision_status) >= 0));
chk('incoherent production curves never produce a decision', games.every((o) => !o.ev.price_curve || o.ev.price_curve.coherent !== false || o.ev.decision_status === 'NO_DECISION'));
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), 'utf8'));
chk('board rows carry the compact EV row and the counts sum to the slate', board.rows.every((r) => 'ev' in r) && Object.values(board.ev_counts).reduce((a, b) => a + b, 0) === board.rows.length);
chk('ev.csv and ev_validation.json are written', fs.existsSync(path.join(ROOT, 'football', 'cfb_terminal', 'ev.csv')) && JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'ev_validation.json'), 'utf8')).schema === 'edgedesk_ev_validation_file_v1');
const ledger = path.join(ROOT, 'football', 'cfb_terminal', 'ev', '2026', 'ev_snapshots.jsonl');
if (fs.existsSync(ledger)) {
  const rows = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  chk('the EV record is append-only with unique deterministic ids', new Set(rows.map((r) => r.snapshot_id)).size === rows.length && rows.every((r) => /^edev_/.test(r.snapshot_id)));
  chk('every frozen EV snapshot names its model, calibrator and policy', rows.every((r) => r.model_version && r.decision_policy_version && 'calibrator_version' in r));
}

/* ====================================================================== 15 */
section('15. the page, the explanation boundary, the freeze');
const page = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'terminal.js'), 'utf8'), html = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'index.html'), 'utf8');
const lib = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_ev.js'), 'utf8');
chk('script order: decision.js, then edgedesk_read.js, then edgedesk_ev.js, then the page', html.indexOf('decision.js') < html.indexOf('edgedesk_read.js') && html.indexOf('edgedesk_read.js') < html.indexOf('edgedesk_ev.js') && html.indexOf('edgedesk_ev.js') < html.indexOf('research/cfb/terminal.js'));
chk('the EV lib computes no football number', !/projectGame|coverProbSpread|marginDistribution|\btCdf\b|normCdf|erf\(/.test(lib));
chk('the page never assigns a BET decision', !/decision_status\s*=\s*['"]BET/.test(page) && !/policy_decision\s*=\s*['"]BET/.test(page));
chk('the page re-prices only through EDEV.evRead / whatIf / manual / compareLines', /EVX\.evRead\(/.test(page) && /EVX\.whatIf\(/.test(page) && /EVX\.manual\(/.test(page) && /EVX\.compareLines\(/.test(page));
chk('the EV card carries the tooltip and the four value labels, never defaulting to SAFEST', /E\.tooltip/.test(page) && /BEST EV/.test(page) && /EVSORT_K, 'BEST_EV'/.test(page));
chk('the EV lab page is routed', /r === 'ev'/.test(page) && /data-r="ev"/.test(html));
const factsSrc = { pure: { home: 'Michigan', away: 'Minnesota', projected_margin: 3, model_version: 'test' }, market: { home_line: -6.5, books: 1 }, qb: {}, data_quality: { status: 'GREEN', issues: [] }, ev: pos };
const F = X.cfbFacts(factsSrc);
chk('the explanation boundary carries the EV read as facts with provenance', F.ev && F.ev.decision === 'RESEARCH ONLY' && F.ev.quote_id && F.ev.policy_version && F.ev.calibrator_version);
chk('EV numbers are allowed numbers; an invented one is refused', F.numbers.some((n) => near(n, Math.round(1000 * pos.selected.calibrated_ev) / 10, 0.2)) && X.auditExplanation('EdgeDesk makes this 71.3% to cover.', F).issues.some((i) => i.code === 'NUMBER_NOT_IN_FACTS'));
chk('the boundary refuses a "validated edge" claim on a non-actionable EV', X.auditExplanation('This is a validated edge at this price. Quarterback not confirmed.', F).issues.some((i) => i.code === 'EV_VALIDATED_CLAIM'));
const Fr = X.cfbFacts(Object.assign({}, factsSrc, { ev: evr({ fair: -3, center: -6.5, quotes: [q('m', 'bk', 6.5, -105, -115)], artifact: null }) }));
chk('the boundary refuses calling a RAW EV calibrated', X.auditExplanation('The calibrated EV is positive here. Quarterback not confirmed.', Fr).issues.some((i) => i.code === 'EV_BASIS_MISMATCH'));
const FZ = require('./freeze.js');
const dz = FZ.drift();
chk('the next-100 freeze: every frozen file is unchanged or recorded as a PATCH', dz.ok, dz.drift);

console.log('\n' + (fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
if (failures.length) console.log(failures.map((f) => '  ✗ ' + f).join('\n'));
process.exit(fail ? 1 : 0);
