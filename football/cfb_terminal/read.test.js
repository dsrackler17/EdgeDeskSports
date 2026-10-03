#!/usr/bin/env node
/* ============================================================================
   THE EDGEDESK READ — the rules (lib/edgedesk_read.js).

     node football/cfb_terminal/read.test.js

   Synthetic cases pin every rule; the real slate (football/cfb_terminal/
   games.json, built from the committed production artifacts) pins that the
   published reads obey them; the page and the explanation boundary are
   checked for what they may and may not do.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
const DEC = require(path.join(ROOT, 'football', 'cfb_decision', 'decision.js'));
const INTEG = require(path.join(ROOT, 'football', 'cfb_lab', 'integrity.js'));
const RD = require(path.join(ROOT, 'lib', 'edgedesk_read.js'));
const T = require(path.join(ROOT, 'lib', 'cfb_terminal.js'));
const B = require(path.join(__dirname, 'build.js'));
const ALT = require(path.join(__dirname, 'alternates.js'));
const X = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_cfb_explain.js'));
const MI = (() => { try { return require(path.join(ROOT, 'football', 'cfb_market', 'market_intel.js')); } catch (e) { return null; } })();

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
function near(a, b, tol) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function section(t) { console.log('\n' + t); }

/* a discretised normal on integer margins: the synthetic distribution the rules are tested on */
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
function normalCover(mu, sd) {
  const pmf = {}; let tot = 0;
  for (let k = -90; k <= 90; k++) { const p = Phi((k + 0.5 - mu) / sd) - Phi((k - 0.5 - mu) / sd); pmf[k] = p; tot += p; }
  Object.keys(pmf).forEach((k) => { pmf[k] /= tot; });
  return (t) => { let win = 0, push = 0; for (let k = -90; k <= 90; k++) { if (Math.abs(k - t) < 1e-9) push += pmf[k]; else if (k > t) win += pmf[k]; } return { win, push, lose: 1 - win - push }; };
}
const NOW = Date.parse('2026-10-01T15:00:00Z');
const FRESH = '2026-10-01T14:30:00Z', OLD = '2026-10-01T05:00:00Z';
const QB_OK = { home: { player: 'A', confirmed: true }, away: { player: 'B', confirmed: true } };
const PEND = { status: 'PENDING', reason: 'no decision calibration is validated for this test model' };
/* a synthetic VALIDATED calibration: identity map, a strong model weight (only for rule tests) */
const VAL = { status: 'VALIDATED', version: 'test_cal', base_model_version: 'test', cover_calibration: { map: { method: 'identity' } },
  market_shrinkage: { w_model: 0.8, space: 'logit', w_ci95: [0.7, 0.9] } };
function input(o) {
  o = o || {};
  const fair = o.fair != null ? o.fair : 0, mkt = o.center != null ? o.center : fair;
  const cover = o.cover || normalCover(fair, o.sd || 14);
  return {
    now: o.now || NOW, game: { game_id: o.id || 'g1', home: o.home || 'Michigan', away: o.away || 'Minnesota', kickoff: '2026-10-03T19:30:00Z' },
    model: { available: o.model !== false, model_version: 'test', home_margin: fair, fair_total: 44, home_win_prob: 0.55 },
    curve: o.curve === null ? null : RD.buildCurve(cover, mkt, 30, { basis: 'test normal' }),
    calibration: o.cal || PEND, policy: { version: 'test_policy', bet_enabled: !!o.bet_enabled },
    market: { quotes: o.quotes || [], open: o.open || null, stored: o.stored || [], moneyline: o.ml || null },
    governed: o.governed || null, config: Object.assign({ typical_move_pts: 1.9 }, o.config || {}),
    research: o.research || { status_key: 'RESEARCH', disagreement: { class: 'MODERATE', points: 5 } },
    context: Object.assign({ qb: QB_OK, key_mass: { 3: 0.0926, 7: 0.0851, 10: 0.0461, 14: 0.0461 } }, o.context || {}),
    view: o.view || { mode: 'best' }, user_quotes: o.user_quotes || [], integrity: o.integrity === undefined ? INTEG : o.integrity
  };
}
const q = (id, book, hl, ph, pa, t, extra) => Object.assign({ quote_id: id, book, source: 'espn', home_line: hl, price_home: ph, price_away: pa, observed_at: t || FRESH }, extra || {});

/* =================================================================== 1 */
section('1. odds math: every price is line AND juice; break-even at the exact price');
{
  const a = RD.normalizePrice(-110), b = RD.normalizePrice(150), c = RD.normalizePrice(100), d = RD.normalizePrice(-113);
  chk('negative odds: break-even = |o| / (|o| + 100)', near(a.break_even, 110 / 210, 1e-12) && near(d.break_even, 113 / 213, 1e-12), [a.break_even, d.break_even]);
  chk('positive odds: break-even = 100 / (o + 100)', near(b.break_even, 100 / 250, 1e-12), b.break_even);
  chk('even money: +100 breaks even at 50%', near(c.break_even, 0.5, 1e-12) && near(c.payout, 1, 1e-12));
  chk('decimal odds from American (−110 → 1.909091)', near(a.decimal, 1.909091, 1e-6) && near(b.decimal, 2.5, 1e-9));
  const i53 = RD.normalizePrice({ implied: 0.53 }), i64 = RD.normalizePrice({ implied: 0.64 });
  chk('a DraftKings-style 53% is about −113 (approximate American, flagged)', i53.american === -113 && i53.approximate_american === true && i53.precision === 'IMPLIED_PERCENT', i53);
  chk('64% is about −178', i64.american === -178, i64.american);
  chk('an implied percentage keeps the SOURCE precision for break-even (not the rounded −113)', near(i53.break_even, 0.53, 1e-12) && !near(i53.break_even, 113 / 213, 1e-6));
  chk('"53%" and "53" parse as implied probability', near(RD.parsePrice('53%').break_even, 0.53, 1e-12) && near(RD.normalizePrice({ implied: 53 }).break_even, 0.53, 1e-12));
  chk('"(−113)", "+145", "1.91" all parse', RD.parsePrice('(−113)').american === -113 && RD.parsePrice('+145').american === 145 && near(RD.parsePrice('1.91').payout, 0.91, 1e-9));
  chk('impossible prices are not prices: 0, +50, −99, 1.0, 101%', [RD.normalizePrice(0), RD.normalizePrice(50), RD.normalizePrice(-99), RD.normalizePrice({ decimal: 1 }), RD.normalizePrice({ implied: 101 })].every((x) => !x.valid));
  /* ONE EV formula, in parity with decision.js and the terminal */
  let worst = 0;
  [-250, -178, -130, -113, -110, -105, 100, 120, 145, 210].forEach((am) => [0.3, 0.45, 0.5, 0.53, 0.61, 0.72].forEach((p) => [0, 0.02, 0.065, 0.109].forEach((pp) => {
    const pay = DEC.americanToPayout(am);
    const e1 = RD.evFromCover(p, pp, pay), e2 = DEC.expectedValue(p, pp, am), e3 = T.odds.ev(p * (1 - pp), pp, am);
    worst = Math.max(worst, Math.abs(e1 - e2), Math.abs(e1 - e3));
  })));
  chk('EV parity: edgedesk_read = decision.js expectedValue = terminal T.odds.ev (240 cases)', worst < 1e-12, worst);
  chk('EV = P(win)·profit − P(loss)·1 + P(push)·0: 50% at −110 is −4.545%', near(RD.evOf(0.5, 0, DEC.americanToPayout(-110)), -0.0454545, 1e-6));
  chk('a push returns the stake (never counted as a loss)', near(RD.evOf(0.45, 0.1, 1), 0.45 - 0.45, 1e-12));
  chk('+EV is never "above 50%": 52% at −130 is negative', RD.evOf(0.52, 0, DEC.americanToPayout(-130)) < 0);
}

/* =================================================================== 2 */
section('2. the curve: side orientation, home/away signs, integer pushes, half points');
{
  const cov = normalCover(7, 14), C = RD.buildCurve(cov, 7, 30, {});
  chk('the curve spans ±30 points in half points (121 thresholds)', C.n === 121 && C.lo === -23 && C.step === 0.5, [C.n, C.lo]);
  const h35 = RD.sideProb(C, 'home', -3.5), a35 = RD.sideProb(C, 'away', 3.5);
  chk('home favoured by 7: home −3.5 covers more often than not', h35.cover > 0.55, h35);
  chk('the other side of the same number is the complement (half point: no push)', near(h35.win + a35.win, 1, 1e-6) && h35.push === 0 && a35.push === 0);
  const h7 = RD.sideProb(C, 'home', -7), a7 = RD.sideProb(C, 'away', 7);
  chk('an integer line carries push probability, the same for both sides', h7.push > 0.02 && near(h7.push, a7.push, 1e-9) && near(h7.win + a7.win + h7.push, 1, 1e-6));
  chk('+7 is not +7.5: the half point converts the push into a win', near(RD.sideProb(C, 'away', 7.5).win - a7.win, a7.push, 1e-6));
  chk('home line −7 means home lays 7 (covers only by 8+)', near(h7.win, cov(7).win, 1e-6));
  /* mirror: swap home and away, negate the margin */
  const M = RD.buildCurve(normalCover(-7, 14), -7, 30, {});
  chk('mirror symmetry: the away favourite at −3.5 equals the home favourite at −3.5', near(RD.sideProb(M, 'away', -3.5).cover, h35.cover, 1e-6));
  chk('a quarter line is refused, not rounded', RD.sideProb(C, 'home', -3.25) === null);
  chk('a line outside the stored curve is refused', RD.sideProb(C, 'home', -45) === null);
  chk('key-number mass: the game PMF on exactly 7 is P(margin = 7)', near(RD.massAt(C, 'home', 7), cov(7).push, 1e-6) && near(RD.massAt(C, 'away', -7), cov(7).push, 1e-6));
}

/* =================================================================== 2b */
section('2b. the champion’s curve is ONE distribution, wherever the market is (football/cfb_terminal/build.js v1Dist)');
{
  const QEV = require(path.join(ROOT, 'lib', 'edgedesk_quote_ev.js'));
  const P = window.EDCfbP4Params, D = P.distributions, base = P.volatility.sigma_base, rng = D.pmf_spread_range;
  /* the curve exactly as the build stores it (readBase: centred on the market, or the fair margin with none) */
  const curveOf = (fair, sigma, mkt) => { const d = B.v1Dist(fair, sigma, mkt), c = mkt != null ? mkt : fair;
    return { d, C: RD.buildCurve(d.cover, c, Math.min(60, Math.max(30, Math.ceil(Math.abs(fair - c)) + 24)), { conditioned_on: d.conditioned_on_market_margin }) }; };
  /* a coherent curve on integer margins: P(M > t) never rises with t; it does
     not move across a half point (P(M > 18) = P(M > 18.5)); it falls across a
     whole number by exactly that number's mass (P(M > 17.5) − P(M > 18) = P(M = 18)) */
  const incoherence = (C) => { for (let i = 0; i < C.n; i++) {
    const t = C.lo + i * C.step, w = C.win[i], p = C.push[i];
    if (i > 0 && w > C.win[i - 1] + 1e-9) return 'P(M > ' + t + ') rises to ' + w + ' from ' + C.win[i - 1];
    if (Number.isInteger(t)) { if (i > 0 && Math.abs(C.win[i - 1] - w - p) > 2e-6) return 'mass at ' + t + ' is not the fall across it'; if (i + 1 < C.n && Math.abs(C.win[i + 1] - w) > 2e-6) return 'P(M > ' + t + ') ≠ P(M > ' + (t + 0.5) + ')'; }
    else if (p !== 0) return 'push at the half point ' + t;
  } return null; };
  /* McNeese @ LSU, 2026-10-02: LSU −52.5, fair home margin 41.42 — the market past the table's +45 edge */
  chk('the table covers ±45 (the case below sits outside it)', rng[0] === -45 && rng[1] === 45, rng);
  const L = curveOf(41.42, 14.9, 52.5);
  chk('a market OUTSIDE the table gives a coherent curve (McNeese @ LSU, LSU −52.5)', L.C && incoherence(L.C) === null, L.C && incoherence(L.C));
  const gt = (C, t) => C.win[Math.round((t - C.lo) / C.step)];
  chk('… whose P(M > 18) equals P(M > 18.5) and is below P(M > 17.5) (the stored curve broke both: 0.9270, 0.9309, 0.9457)',
    near(gt(L.C, 18), gt(L.C, 18.5), 1e-9) && gt(L.C, 18) < gt(L.C, 17.5), [gt(L.C, 17.5), gt(L.C, 18), gt(L.C, 18.5)]);
  chk('… conditioned on the table’s nearest edge (+45), re-centred and stretched as an in-range market is', L.d.pmf_row === 45 && [17.5, 18, 41.5, 52, 52.5, 60].every((t) => { const a = L.d.cover(t), b = QEV.cfbConditionedCover(D, 41.42, 45, 14.9, base)(t); return near(a.win, b.win) && near(a.push, b.push); }));
  chk('… still recorded as conditioned on the market it was asked about, and saying where it read the table', L.C.conditioned_on_market_margin === 52.5 && /table’s edge \(home margin \+45\.0, the row nearest the current market at \+52\.5\)/.test(L.d.basis), L.d.basis);
  chk('… continuous across the edge: a market at +45.5 reads the same shape as one at +45', [40, 44.5, 45, 45.5, 51].every((t) => near(B.v1Dist(40, 14.9, 45.5).cover(t).win, B.v1Dist(40, 14.9, 45).cover(t).win)));
  const Lm = curveOf(-41.42, 14.9, -52.5);
  chk('the mirror (an away favourite past −45) is coherent and reads the −45 edge', Lm.C && incoherence(Lm.C) === null && Lm.d.pmf_row === -45, Lm.C && incoherence(Lm.C));
  chk('a market INSIDE the table is untouched: the shape is conditioned on the market itself', (() => { const d = B.v1Dist(1.3, 14.9, 6.5); return d.pmf_row === 6.5 && d.conditioned_on_market_margin === 6.5 && [-3, 0.5, 6.5, 7, 20].every((t) => near(d.cover(t).win, QEV.cfbConditionedCover(D, 1.3, 6.5, 14.9, base)(t).win)); })());
  /* no market at all: the engine's per-line call stitched one shape per threshold here too */
  const N0 = curveOf(41.42, 14.9, null), N1 = curveOf(55.2, 15.4, null), N2 = curveOf(-3.1, 14.7, null);
  chk('with NO market the curve is coherent too (fair +41.4, +55.2 past the edge, −3.1)', [N0, N1, N2].every((x) => x.C && incoherence(x.C) === null), [N0, N1, N2].map((x) => x.C && incoherence(x.C)));
  chk('… conditioned on EdgeDesk’s own fair margin, clamped to the table, and never labelled as a market', N0.d.pmf_row === 41.42 && N1.d.pmf_row === 45 && N2.d.pmf_row === -3.1
    && [N0, N1, N2].every((x) => x.C.conditioned_on_market_margin === null && /no market spread/.test(x.d.basis)) && /table’s edge, home margin \+45\.0/.test(N1.d.basis), N1.d.basis);
}

/* =================================================================== 3 */
section('3. no second calculation path: the Read prices exactly what the terminal prices');
const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'games.json'), 'utf8'));
const GAMES = Object.values(G.games);
{
  /* the slate thins as the week's games kick off, so the bar is "every priced
     game and every curve row", never a fixed count the Saturday slate happens to clear */
  let priced = 0, n = 0, worst = 0, where = null;
  GAMES.forEach((o) => {
    const F = o.price;
    if (F.available && F.current) priced++;
    if (!o.read_inputs || !o.read_inputs.curve || !F.available || !F.current) return;
    const opt = RD.evaluateQuote(Object.assign(RD.fromTerminal(o, o.read_inputs, { now: Date.parse(G.generated_at) })), { side: F.side, line: F.current.line, price: F.current.price });
    n++;
    const d = Math.max(Math.abs(opt.raw_cover - F.current.cover), Math.abs(opt.raw_ev - F.current.ev), Math.abs(opt.break_even - F.current.break_even));
    if (d > worst) { worst = d; where = o.game_id; }
  });
  chk('cover, break-even and EV at the terminal’s current quote match the terminal to 1e-4 on every priced game (' + n + ' of ' + priced + ')', n === priced && worst < 1.5e-4, { worst, where });
  let rows = 0, m = 0, w2 = 0;
  GAMES.forEach((o) => { (o.price.curve || []).forEach((r) => {
    if (!o.read_inputs || !o.read_inputs.curve) return;
    rows++;
    const p = RD.sideProb(o.read_inputs.curve, o.price.side, r.line);
    if (!p) return; m++; w2 = Math.max(w2, Math.abs(p.cover - r.cover));
  }); });
  chk('the stored curve reproduces the terminal’s price curve at every half point (' + m + ' of ' + rows + ' rows)', m === rows && w2 < 1.5e-4, w2);
}

/* =================================================================== 4 */
section('4. CASE A (Minnesota): favourite −1 by EdgeDesk, −6.5 by the market; +1 alternate near 64%');
const V1 = B.v1Dist(1.3, 14.9, 6.5);
const mnQuotes = [q('dk_main', 'draftkings', -6.5, -107, -113), q('dk_alt75', 'draftkings', -7.5, 145, -178, FRESH, { alternate: true }), q('dk_alt105', 'draftkings', -10.5, 210, -260, FRESH, { alternate: true })];
{
  const R = RD.read(input({ fair: 1.3, center: 6.5, cover: V1.cover, quotes: mnQuotes, open: { home_line: -7.5, observed_at: '2026-09-28T12:00:00Z' } }));
  const main = R.alternates.rows.map((x) => x.vs_main).filter(Boolean)[0];
  const alt = R.alternates.rows.find((x) => x.option.line === 7.5);
  chk('the side is Minnesota (EdgeDesk likes the underdog more than the market)', R.side === 'away' && R.side_team === 'Minnesota');
  chk('main +6.5 −113: break-even 53.1% at the exact price', near(R.line_shopping[0].break_even, 0.5305, 1e-4) && R.line_shopping[0].label === 'Minnesota +6.5 -113', R.line_shopping[0].label);
  chk('model cushion: +6.5 against a fair +1.3 is +5.2 points', near(R.line_shopping[0].cushion, 5.2, 1e-9));
  chk('the +7.5 alternate has the higher cover probability …', alt.option.probability.win > R.line_shopping[0].probability.win);
  chk('… and a break-even about 11 pp higher (53.1% → 64.0%)', near(alt.vs_main.break_even_change, 0.1098, 5e-4), alt.vs_main.break_even_change);
  chk('… so buying the point is TOO EXPENSIVE: the alternate is a PASS, never preferred for being safer', alt.verdict === 'TOO_EXPENSIVE' && /protection costs too much/.test(alt.text));
  chk('best value is not the alternate', R.best_value_market.type !== 'ALTERNATE_SPREAD' && R.main_vs_alt_summary.best_value !== 'Minnesota +7.5 -178');
  chk('the safest alternate is named — and labelled never preferred', R.main_vs_alt_summary.safest_alt === 'Minnesota +10.5 -260' && /never/.test(R.main_vs_alt_summary.note));
  chk('KEY NUMBER CROSSED: 7 is named for +6.5 → +7.5', alt.vs_main.key_numbers_crossed.some((k) => k.key === 7));
  chk('the incremental read: cover gain vs break-even rise, both in pp', typeof alt.vs_main.cover_probability_change === 'number' && typeof alt.vs_main.incremental_value_pp === 'number');
  /* the same case on a calibrated probability */
  const RC = RD.read(input({ fair: 1.3, center: 6.5, cover: V1.cover, quotes: mnQuotes, cal: Object.assign({}, VAL, { market_shrinkage: { w_model: 0.228, space: 'logit', w_ci95: [0.073, 0.383] } }) }));
  const altC = RC.alternates.rows.find((x) => x.option.line === 7.5);
  chk('calibrated: the decision probability shrinks toward the de-vigged market (65% raw → about 54%)', RC.selected.calibrated && RC.selected.calibrated.decision_cover < 0.56 && RC.selected.raw_cover > 0.64, RC.selected.calibrated);
  chk('calibrated: EV after the buffer uses the weight interval’s conservative end', RC.selected.buffered_ev < RC.selected.decision_ev);
  chk('calibrated: the +7.5 −178 alternate is still TOO EXPENSIVE', altC.verdict === 'TOO_EXPENSIVE');
  chk('calibrated: a small positive EV at +6.5 is not a clear (the buffer makes it PASS)', RC.selected.decision_ev > 0 && !RC.selected.clears && RC.timing_read === 'PASS', [RC.selected.decision_ev, RC.timing_read]);
  /* a cheap alternate CAN be better value */
  const cheap = RD.read(input({ fair: 1.3, center: 6.5, cover: V1.cover, quotes: [q('m', 'draftkings', -6.5, -107, -113), q('a', 'draftkings', -7.5, -105, -115, FRESH, { alternate: true })] }));
  const ca = cheap.alternates.rows[0];
  chk('an alternate priced below its worth is BETTER VALUE (EV decides, not safety or juice alone)', ca.verdict === 'BETTER_VALUE' && cheap.best_value_market.type === 'ALTERNATE_SPREAD', ca.verdict);
  const cmp = RD.compare(input({ fair: 1.3, center: 6.5, cover: V1.cover }), [{ side: 'away', line: 6.5, price: -113 }, { side: 'away', line: 7.5, price: -178 }]);
  chk('COMPARE LINES: +6.5 −113 vs +7.5 −178 → the main line offers better value', cmp.ok && /Minnesota \+6\.5 -113 OFFERS BETTER VALUE/.test(cmp.result) && cmp.comparisons[0].line_change === 1, cmp.result);
  chk('COMPARE LINES: additional break-even about +10.9 pp', near(cmp.comparisons[0].break_even_change, 0.1098, 5e-4));
  chk('juice cost is positive when the alternative costs more (−113 → −178 = 65 cents)', cmp.comparisons[0].juice_cost_cents === 65, cmp.comparisons[0].juice_cost_cents);
}

/* =================================================================== 5 */
section('5. line shopping and the views: best for you, one book, the consensus');
{
  const qs = [q('a', 'bookA', -6.5, -115, -105), q('b', 'bookB', -7, -105, -115), q('c', 'bookC', -6.5, -110, -110)];
  const R = RD.read(input({ fair: 1, center: 6.5, sd: 14, quotes: qs }));
  const byEv = R.line_shopping.slice().sort((x, y) => y.ev_threshold - x.ev_threshold);
  chk('line shopping ranks by EdgeDesk EV at each book’s own line and price', R.line_shopping.map((x) => x.book).join() === byEv.map((x) => x.book).join());
  chk('+6.5 −105 vs +7 −115: the winner is whichever EV is higher, not the biggest number or the lowest juice alone', R.line_shopping[0].ev_threshold >= R.line_shopping[1].ev_threshold);
  const bk = RD.read(input({ fair: 1, center: 6.5, sd: 14, quotes: qs, view: { mode: 'book', book: 'bookC' } }));
  chk('SELECTED BOOK: every number on the card is bookC’s', bk.selected_book === 'bookC' && bk.selected_book_price === -110 && bk.selected.book === 'bookC');
  const mine = RD.read(input({ fair: 1, center: 6.5, sd: 14, quotes: qs, view: { mode: 'mine', books: ['bookB'] } }));
  chk('MY BOOKS: the best price for you comes only from your books', mine.selected.book === 'bookB');
  chk('… while best available still names the best anywhere', mine.best_available.book === R.line_shopping[0].book);
  const cons = RD.read(input({ fair: 1, center: 6.5, sd: 14, quotes: qs, view: { mode: 'consensus' } }));
  chk('CONSENSUS: compared against the consensus number, not one book', cons.selected.origin === 'CONSENSUS' && cons.selected.book === 'consensus');
  chk('consensus is the median of the books (−6.5)', cons.market_consensus_spread.home_line === -6.5 && cons.consensus.n_books === 3);
}

/* =================================================================== 6 */
section('6. consensus built correctly: duplicate feeds, stale quotes, outliers, provider consensus, user quotes');
{
  const qs = [q('d1', 'draftkings', -6.5, -110, -110, '2026-10-01T13:00:00Z', { source: 'record' }), q('d2', 'draftkings', -7, -110, -110, FRESH, { source: 'espn' }),
    q('f', 'fanduel', -7, -112, -108), q('m', 'betmgm', -7, -110, -110), q('o', 'outlierbook', -14, -110, -110), q('s', 'staleb', -3, -110, -110, OLD),
    q('c', 'consensus', -6, null, null, FRESH, { source: 'cfbd' })];
  const R = RD.read(input({ fair: 1, center: 7, quotes: qs, user_quotes: [{ book: 'draftkings', home_line: -2, price_home: -110, price_away: -110, observed_at: FRESH }] }));
  const C = R.consensus;
  chk('duplicate feeds of one book count once (the freshest)', C.duplicate_feeds_merged.length === 1 && C.books.filter((b) => b.book === 'draftkings').length === 1);
  chk('a stale book is excluded from the current consensus', C.excluded.some((x) => x.book === 'staleb' && /stale/.test(x.reason)));
  chk('a robust outlier is excluded (integrity MAD rule)', C.excluded.some((x) => x.book === 'outlierbook' && /outlier/.test(x.reason)), C.excluded);
  chk('a provider’s own consensus is a reference, not a book', C.excluded.some((x) => x.book === 'consensus'));
  chk('a USER QUOTE never enters the consensus', !C.books.some((b) => b.home_line === -2) && C.home_line === -7, C);
  chk('equal weights are stated (no validated book-quality weights)', /equal weights/.test(C.weighting));
}

/* =================================================================== 7 */
section('7. CASE B (Arkansas): fair about +11; a stored +16; a fresh book at +13.5');
{
  const qs = [q('dk_old', 'draftkings', -16, -110, -110, '2026-10-01T02:00:00Z'), q('dk_new', 'draftkings', -13.5, -108, -112, FRESH)];
  const stored = [{ label: 'an EdgeDesk artifact that displayed +16', origin: 'STORED', book: 'draftkings', home_line: -16, observed_at: '2026-10-01T02:00:00Z' }];
  const R = RD.read(input({ id: 'ark', home: 'Tennessee', away: 'Arkansas', fair: 11, center: 13.5, quotes: qs, stored }));
  chk('the mismatch is identified: MARKET QUOTE CHECK (2.5 pts)', R.market_quote_check.length === 1 && near(R.market_quote_check[0].difference_pts, 2.5) && R.market_quote_check[0].current_home_line === -13.5, R.market_quote_check);
  chk('the current quote is used: Arkansas +13.5, never +16', R.selected.line === 13.5 && R.selected_book_spread === 13.5 && !/\+16/.test(R.headline.current), R.headline.current);
  chk('EV is recomputed at +13.5 (the fresh price)', near(R.selected.break_even, 112 / 212, 1e-6) && R.selected.quote_id === 'dk_new');
  chk('a stale stored number replaced by a newer capture does not block the read', R.market_quote_check[0].blocks_action === false && R.timing_read !== 'INVESTIGATE');
  /* two CURRENT numbers that disagree block action */
  const both = RD.read(input({ home: 'Tennessee', away: 'Arkansas', fair: 11, center: 13.5, quotes: [q('dk_new', 'draftkings', -13.5, -108, -112, FRESH)],
    stored: [{ label: 'a newer direct quote', origin: 'STORED', book: 'draftkings', home_line: -16, observed_at: '2026-10-01T14:50:00Z' }] }));
  chk('two current numbers that disagree → INVESTIGATE (nothing actionable until one is confirmed)', both.timing_read === 'INVESTIGATE' && both.timing_code === 'MARKET_QUOTE_CHECK');
  /* only stale quotes: never a price */
  const st = RD.read(input({ home: 'Tennessee', away: 'Arkansas', fair: 11, center: 16, quotes: [q('old', 'draftkings', -16, -110, -110, OLD)] }));
  chk('only stale quotes → NO DECISION (STALE MARKET), never EV off +16 as current', st.timing_read === 'NO_DECISION' && st.timing_code === 'STALE_MARKET' && st.selected === null && st.stale_market.stale, [st.timing_read, st.timing_code]);
  chk('quote freshness: every quote carries book, source, capture time, age, line and price', st.quote_freshness.quotes.every((x) => 'book' in x && 'source' in x && 'captured_at' in x && 'age_minutes' in x && 'home_line' in x && 'price_home' in x) && st.quote_freshness.quotes[0].status === 'STALE');
  /* a user who sees +13.5 while EdgeDesk's capture is stale */
  const man = RD.manual(input({ home: 'Tennessee', away: 'Arkansas', fair: 11, center: 16, quotes: [q('old', 'draftkings', -16, -110, -110, OLD)] }), 'Arkansas +13.5 -110 draftkings');
  chk('a typed quote that differs from a stale capture raises the check and names the stale side', man.ok && man.quote_check && /stale/.test(man.quote_check.text) && man.option.origin === 'USER', man.quote_check);
}

/* =================================================================== 8 */
section('8. PRICE GONE: the first number cleared, the current does not');
{
  /* find a fair margin whose bettable-to (at −110) is exactly +5.5 for the away side */
  let fair = null;
  for (let f = -2; f <= 8; f += 0.05) {
    const I = input({ fair: f, center: 4, sd: 14 });
    const w = RD.whatIf(I, { side: 'away', line: 4, price: -110 });
    if (w.bettable_to.line === 5.5) { fair = f; break; }
  }
  chk('a fixture exists whose bettable-to is +5.5', fair !== null, fair);
  const R = RD.read(input({ fair, center: 4, sd: 14, quotes: [q('dk', 'draftkings', -4, -110, -110)], open: { home_line: -7, observed_at: '2026-09-28T12:00:00Z' } }));
  chk('initial +7, current +4, bettable to +5.5 → PRICE GONE', R.timing_read === 'PRICE_GONE' && R.price_is_gone.state === 'GONE' && R.bettable_to.line === 5.5, [R.timing_read, R.price_is_gone.state, R.bettable_to.line]);
  chk('the opportunity is not presented as actionable', !R.actionable && R.decision_status === 'PASS' && R.price_status.key === 'PRICE_GONE');
  chk('the football opinion is kept: the fair line is unchanged', near(R.projected_margin, fair, 1e-9) && /football opinion is unchanged/.test(R.price_is_gone.text));
  const intact = RD.read(input({ fair, center: 6.5, sd: 14, quotes: [q('dk', 'draftkings', -6.5, -110, -110)], open: { home_line: -7, observed_at: '2026-09-28T12:00:00Z' } }));
  chk('initial +7, current +6.5 (still clears) → not gone', intact.price_is_gone.state !== 'GONE' && intact.timing_read !== 'PRICE_GONE');
}

/* =================================================================== 9 */
section('9. WAIT always carries a named reason or a target — never "maybe wait"');
{
  const contested = RD.read(input({ fair: -1, center: 4.5, quotes: [q('dk', 'draftkings', -4.5, -110, -110)], context: { qb: { home: { player: 'A', confirmed: true }, away: { player: 'B', contested: true, label: 'two-man race' } } } }));
  chk('a contested quarterback on a clearing price → WAIT with the QB named', contested.timing_read === 'WAIT' && contested.timing_code === 'QB_UNRESOLVED' && /contested/.test(contested.timing_reason));
  /* a price just short of the threshold, the first clearing number inside ordinary movement */
  /* a stricter edge threshold (a rule test, not a policy): the current number misses it, a better one inside ordinary movement makes it */
  let tgt = null;
  for (let f = 1; f <= 4; f += 0.1) {
    const R = RD.read(input({ fair: -f, center: 4.5, sd: 14, quotes: [q('dk', 'draftkings', 4.5, -110, -110)], config: { min_probability_edge: 0.06, ideal_probability_edge: 0.08 } }));
    if (R.timing_read === 'PRICE_TARGET' && R.target_price && R.target_price.distance_pts > 0) { tgt = R; break; }
  }
  chk('a target within typical movement → PRICE TARGET (decision WAIT) with the target number', tgt && tgt.decision_status === 'WAIT' && tgt.target_price && tgt.target_price.line > tgt.selected.line && tgt.target_price.distance_pts <= 1.9, tgt && tgt.target_price);
  chk('WHY WAIT: current, target, model fair, market, why', tgt && tgt.why_wait.map((x) => x.k).join() === 'CURRENT,TARGET,MODEL FAIR,MARKET,WHY,URGENCY', tgt && tgt.why_wait);
  /* the number is good, the juice is not → a price target at this number */
  let pt = null;
  for (let f = 6.5; f <= 9; f += 0.1) {
    const R = RD.read(input({ fair: -f, center: -4.5, sd: 14, quotes: [q('dk', 'draftkings', 4.5, 120, -150)] }));
    if (R.timing_read === 'PRICE_TARGET') { pt = R; break; }
  }
  chk('juice, not the number: PRICE TARGET at this line at the price that clears', pt && pt.timing_code === 'TARGET_PRICE' && pt.target_price.line === pt.selected.line && DEC.americanToPayout(pt.target_price.price) > DEC.americanToPayout(-150), pt && [pt.timing_code, pt.target_price]);
  const far = RD.read(input({ fair: -1, center: 8.5, sd: 14, quotes: [q('dk', 'draftkings', -8.5, -135, 115)], config: { typical_move_pts: 0.5 } }));
  chk('a target beyond ordinary movement is a PASS, not a wait', far.timing_read !== 'PRICE_TARGET');
  const real = GAMES.map((o) => o.read).filter((r) => r && (r.timing_read === 'WAIT' || r.timing_read === 'PRICE_TARGET'));
  chk('real slate: every WAIT names a reason and every PRICE TARGET a target (' + real.length + ')', real.every((r) => r.timing_reason && r.timing_reason.length > 30 && (r.timing_read !== 'PRICE_TARGET' || r.target_price)) , real.map((r) => r.timing_code));
}

/* =================================================================== 10 */
section('10. INVESTIGATE overrides action; research status is not decision status');
{
  const qs = [q('dk', 'draftkings', -2.5, -110, -110)];
  const gov = { by_quote: { dk: { status: 'BET', reason_codes: ['BET_VALIDATED'] } } };
  const R = RD.read(input({ fair: -9.5, center: 2.5, quotes: qs, cal: VAL, bet_enabled: true, governed: gov,
    research: { status_key: 'INVESTIGATE', reason: 'a 12-point gap that has not passed the integrity checks', disagreement: { class: 'MAJOR', points: 12, verified: false, verification: 'UNVERIFIED' } } }));
  chk('a 12-point unverified gap can never be BET EARLY — even with a governed BET, a validated calibration and betting on', R.timing_read === 'INVESTIGATE' && R.decision_status === 'NO_DECISION' && !R.actionable, [R.timing_read, R.decision_status]);
  chk('the price is shown as NOT PRICED UNTIL VERIFIED', R.price_status.key === 'NOT_PRICED');
  ['DATA_FAULT', 'MARKET_FAULT'].forEach((k) => {
    const x = RD.read(input({ fair: -9.5, center: 2.5, quotes: qs, cal: VAL, bet_enabled: true, governed: gov,
      research: { status_key: k === 'DATA_FAULT' ? 'DATA_FAULT' : 'INVESTIGATE', fault: k === 'DATA_FAULT' ? 'mis-joined line' : null, disagreement: { class: 'MAJOR', points: 12, verification: k } } }));
    chk(k + ' overrides action', x.timing_read === 'INVESTIGATE' && !x.actionable && x.research_status.status === k, x.research_status.status);
  });
  const lim = RD.read(input({ fair: -9, center: 2.5, quotes: qs, cal: VAL, bet_enabled: true, governed: gov, research: { status_key: 'PASS', limited: 'reliability 45 is under 60', disagreement: { class: 'MODERATE', points: 6.5 } } }));
  chk('LIMITED DATA caps at RESEARCH ONLY (never BET)', lim.timing_read === 'RESEARCH' && lim.timing_code === 'LIMITED_DATA' && !lim.actionable, [lim.timing_read, lim.timing_code]);
  const ver = RD.read(input({ fair: 9, center: 1.5, quotes: [q('dk', 'draftkings', -1.5, -110, -110)], research: { status_key: 'RESEARCH', disagreement: { class: 'MAJOR', points: 7.5, verified: true, verification: 'VERIFIED' } } }));
  chk('VERIFIED MAJOR DISAGREEMENT is a research status, not a bet (calibration pending → RESEARCH ONLY)', ver.research_status.status === 'VERIFIED_MAJOR_DISAGREEMENT' && ver.decision_status !== 'BET' && ver.decision_status !== 'BET_EARLY');
  const verPass = RD.read(input({ fair: 9, center: 1.5, quotes: [q('dk', 'draftkings', -1.5, -300, 240)], research: { status_key: 'RESEARCH', disagreement: { class: 'MAJOR', points: 7.5, verified: true, verification: 'VERIFIED' } } }));
  chk('a VERIFIED MAJOR DISAGREEMENT can still be a PASS at a bad price', verPass.research_status.verified && (verPass.decision_status === 'PASS' || verPass.decision_status === 'WAIT'), verPass.timing_read);
}

/* =================================================================== 11 */
section('11. BET and BET EARLY exist only on the governed engine’s BET for that exact quote');
{
  const gov = (id) => ({ by_quote: { [id]: { status: 'BET', reason_codes: ['BET_VALIDATED'] } } });
  const base = { fair: -4, center: 4.5, sd: 14, cal: VAL, bet_enabled: true };
  const plain = RD.read(input(Object.assign({}, base, { quotes: [q('dk', 'draftkings', -4.5, -110, -110)], governed: gov('dk'), open: { home_line: -4.5, observed_at: '2026-09-28T12:00:00Z' } })));
  chk('certified, no measured urgency → BET', plain.timing_read === 'BET' && plain.actionable && plain.decision_status === 'BET', [plain.timing_read, plain.timing_reason]);
  const toward = RD.read(input(Object.assign({}, base, { quotes: [q('dk', 'draftkings', -4.5, -110, -110)], governed: gov('dk'), open: { home_line: -6, observed_at: '2026-09-28T12:00:00Z' } })));
  chk('certified + the market moving toward EdgeDesk → BET EARLY with the move named', toward.timing_read === 'BET_EARLY' && toward.urgency.reasons.some((x) => x.code === 'MARKET_TOWARD'), toward.timing_reason);
  chk('WHY BET EARLY: current, bettable, market trend, why', toward.why_bet_early && toward.why_bet_early[0].k === 'CURRENT' && toward.why_bet_early.some((x) => x.k === 'MARKET TREND'));
  const key = RD.read(input(Object.assign({}, base, { fair: -2, center: 3.5, quotes: [q('dk', 'draftkings', -3.5, -110, -110)], governed: gov('dk') })));
  chk('certified at +3.5 → BET EARLY: losing the hook crosses 3', key.timing_read === 'BET_EARLY' && key.urgency.reasons.some((x) => x.code === 'KEY_NUMBER_AT_RISK' && /crosses 3/.test(x.text)), key.timing_reason);
  const noGov = RD.read(input(Object.assign({}, base, { quotes: [q('dk', 'draftkings', -4.5, -110, -110)], governed: { by_quote: { dk: { status: 'LEAN', reason_codes: ['NO_BET_BETTING_DISABLED'] } } } })));
  chk('a clearing price the governed engine did not certify → RESEARCH ONLY with its reason', noGov.timing_read === 'RESEARCH' && /LEAN/.test(noGov.timing_reason));
  const pend = RD.read(input(Object.assign({}, base, { cal: PEND, quotes: [q('dk', 'draftkings', -4.5, -110, -110)], governed: gov('dk') })));
  chk('calibration pending → never BET, whatever the governed map says (fail closed)', pend.timing_read === 'RESEARCH' && /CALIBRATION PENDING/.test(pend.timing_reason) && pend.probability_basis === 'RAW');
  const user = RD.read(input(Object.assign({}, base, { quotes: [], user_quotes: [{ book: 'mybook', home_line: -4.5, price_home: -110, price_away: -110, observed_at: FRESH }], governed: gov('u0') })));
  chk('a USER QUOTE is never a bet and never a market (priced on both sides, off the consensus)', !user.actionable && user.user_quotes.length === 2 && !user.consensus.available && user.timing_read === 'NO_DECISION', user.timing_read);
  const stale = RD.read(input(Object.assign({}, base, { quotes: [q('dk', 'draftkings', -4.5, -110, -110, OLD)], governed: gov('dk') })));
  chk('a certified quote that has gone stale → NO DECISION (the quote must still exist)', stale.timing_read === 'NO_DECISION' && !stale.actionable);
  const qb = RD.read(input(Object.assign({}, base, { quotes: [q('dk', 'draftkings', -4.5, -110, -110)], governed: gov('dk'), context: { qb: { home: { player: 'A', contested: true }, away: { player: 'B', confirmed: true } } } })));
  chk('certified but a quarterback unresolved → WAIT (information pending)', qb.timing_read === 'WAIT' && !qb.actionable);
  const dear = RD.read(input(Object.assign({}, base, { fair: -9, quotes: [q('dk', 'draftkings', -4.5, 140, -170)], governed: gov('dk') })));
  chk('certified but outside the policy price limit → RESEARCH ONLY', dear.timing_read === 'RESEARCH' && dear.timing_code === 'PRICE_LIMIT', [dear.timing_read, dear.timing_code]);
  chk('BET EARLY needs a clearing price: bettable-to exists and the current number is at or better than it', toward.bettable_to.line <= toward.selected.line);
}

/* =================================================================== 12 */
section('12. fail closed: missing, malformed or unsupported → NO DECISION, never a guess');
{
  chk('no model → NO DECISION', RD.read(input({ model: false, quotes: [q('dk', 'draftkings', -3.5, -110, -110)] })).timing_read === 'NO_DECISION');
  chk('no probability curve → NO DECISION', RD.read(input({ curve: null, fair: 3, quotes: [q('dk', 'draftkings', -3.5, -110, -110)] })).timing_code === 'NO_CURVE');
  const bad = RD.read(input({ fair: -5, center: 3.5, quotes: [q('dk', 'draftkings', -3.5, 5, 0)] }));
  chk('malformed odds are excluded → NO DECISION (no price)', bad.timing_read === 'NO_DECISION' && bad.selected === null, bad.timing_code);
  const nop = RD.read(input({ fair: -5, center: 3.5, quotes: [q('c', 'draftkings', -3.5, null, null)] }));
  chk('a line with no juice is not a price → NO DECISION', nop.timing_read === 'NO_DECISION' && nop.timing_code === 'NO_PRICE');
  chk('no market at all → NO DECISION', RD.read(input({ fair: -5, quotes: [] })).timing_code === 'NO_MARKET');
  const qtr = RD.evaluateQuote(input({ fair: -5, center: 3.5 }), { side: 'away', line: 3.25, price: -110 });
  chk('a quarter line is refused with the reason', /half point/.test(qtr.problem));
  const man = RD.manual(input({ fair: -5, center: 3.5 }), 'Minnesota +6.5');
  chk('a typed line without a price is refused: a line is not a complete price', !man.ok && /not a complete price/.test(man.problem));
  const who = RD.manual(input({ fair: -5, center: 3.5 }), 'Ohio State +6.5 -110');
  chk('a typed team that is not in the game is refused', !who.ok && /neither/.test(who.problem));
}

/* =================================================================== 13 */
section('13. market movement, edge kind, key numbers, price curve, frontier — factual words only');
{
  const toward = RD.read(input({ fair: -1.3, center: 6.5, quotes: [q('dk', 'draftkings', -6.5, -110, -110)], open: { home_line: -7.5, observed_at: '2026-09-28T12:00:00Z' } }));
  chk('MARKET MOVED 1.0 POINT TOWARD EDGEDESK', toward.market_movement_summary.direction === 'TOWARD' && /MARKET MOVED 1\.0 POINT TOWARD EDGEDESK/.test(toward.market_movement_summary.text));
  const away = RD.read(input({ fair: -1.3, center: 7.5, quotes: [q('dk', 'draftkings', -7.5, -110, -110)], open: { home_line: -6.5, observed_at: '2026-09-28T12:00:00Z' } }));
  chk('… and AWAY FROM EDGEDESK', away.market_movement_summary.direction === 'AWAY' && /AWAY FROM EDGEDESK/.test(away.market_movement_summary.text));
  const flat = RD.read(input({ fair: -1.3, center: 6.5, quotes: [q('dk', 'draftkings', -6.5, -110, -110)], open: { home_line: -6.5, observed_at: '2026-09-28T12:00:00Z' } }));
  chk('… and STABLE', flat.market_movement_summary.direction === 'STABLE');
  chk('movement is never called sharp and never proof', [toward, away, flat].every((r) => !/sharp|steam|smart money/i.test(JSON.stringify(r.market_movement_summary)) && /not proof/.test(toward.market_movement_summary.text)));
  const book = RD.read(input({ fair: 7, center: 6.5, quotes: [q('a', 'bookA', -6.5, -110, -110), q('b', 'bookB', -6.5, -110, -110), q('c', 'bookC', -4.5, -110, -110)] }));
  chk('model ~ consensus, one book 2 pts off → BOOK-SPECIFIC PRICE EDGE', book.edge_kind.kind === 'BOOK_PRICE_EDGE' && book.edge_kind.book === 'bookC', book.edge_kind);
  const model = RD.read(input({ fair: 12, center: 6.5, quotes: [q('a', 'bookA', -6.5, -110, -110)] }));
  chk('EdgeDesk far from the whole market → FOOTBALL-MODEL EDGE', model.edge_kind.kind === 'MODEL_EDGE');
  const cmp4 = RD.compare(input({ fair: -1, center: 3.5 }), [{ side: 'away', line: 3.5, price: -110 }, { side: 'away', line: 4.5, price: -125 }]);
  chk('crossing 4 is not a key number', cmp4.comparisons[0].key_numbers_crossed.length === 0);
  const cmp3 = RD.compare(input({ fair: -1, center: 3.5 }), [{ side: 'away', line: 2.5, price: -110 }, { side: 'away', line: 3.5, price: -125 }]);
  chk('crossing 3 is KEY NUMBER CROSSED, with the game mass and the historical share', cmp3.comparisons[0].key_numbers_crossed[0].key === 3 && cmp3.comparisons[0].key_numbers_crossed[0].historical_share === 0.0926);
  chk('price curve: offered prices at their own juice + a reference ladder, labelled a reference', toward.price_curve.offered.length === 1 && toward.price_curve.ladder.length === 13 && /reference, not an offer/.test(toward.price_curve.note));
  const small = RD.read(input({ fair: 4.5, center: 6, quotes: [q('dk', 'draftkings', -6, -130, 110)] }));
  chk('a raw read on a gap under 2 pts claims no value (PASS, no best value, price status says why)', small.timing_code === 'SMALL_GAP_RAW' && small.best_value_market.type === 'NONE' && small.price_status.key === 'NO_VALUE_CLAIMED' && !RD.FILTERS.best_value.test(small), [small.timing_code, small.price_status]);
  const nolive = RD.read(input({ fair: 9, center: 7.5, quotes: [q('dk', 'draftkings', -7.5, -110, -110, OLD)] }));
  chk('with no live price the threshold reads CLEARS AT, never "the current number does not clear"', nolive.bettable_to.label === 'CLEARS AT' && !/current number/.test(nolive.bettable_to.text), nolive.bettable_to);
  chk('the frontier carries protection vs probability and marks where value peaks', toward.frontier.points.length >= 13 && toward.frontier.efficient_to);
}

/* =================================================================== 14 */
section('14. what if, manual entry, the parser');
{
  const I = input({ fair: -1.3, center: 6.5, cover: V1.cover });
  const w = RD.whatIf(I, { side: 'away', line: 5.5, price: -110 });
  chk('WHAT IF: +5.5 recalculates cover, EV, status and the bettable threshold', w.option.line === 5.5 && typeof w.option.cover_used === 'number' && typeof w.option.ev === 'number' && w.status && w.bettable_to);
  chk('… and is never a certified bet', /never a certified bet/.test(w.note));
  const p1 = RD.parseQuoteText('Minnesota +6.5 -115', I.game), p2 = RD.parseQuoteText('MIN +6.5 (53%) draftkings', I.game), p3 = RD.parseQuoteText('+6.5 1.91', I.game), p4 = RD.parseQuoteText('Michigan PK -110', I.game);
  chk('parses "Minnesota +6.5 -115"', p1.ok && p1.side === 'away' && p1.line === 6.5 && p1.price.american === -115);
  chk('parses "MIN +6.5 (53%) draftkings" (implied, with a book)', p2.ok && p2.side === 'away' && near(p2.price.break_even, 0.53, 1e-12) && p2.book === 'draftkings', p2);
  chk('parses "+6.5 1.91" (decimal, side from context)', p3.ok && p3.line === 6.5 && near(p3.price.payout, 0.91, 1e-9));
  chk('parses "Michigan PK -110"', p4.ok && p4.side === 'home' && p4.line === 0);
  const m = RD.manual(I, 'Minnesota +6.5 -115 fanduel');
  chk('MANUAL: an instant read of a USER QUOTE, never consensus, never certified', m.ok && m.option.origin === 'USER' && m.option.book === 'fanduel' && /never stored as consensus/.test(m.note));
}

/* =================================================================== 15 */
section('15. the record: frozen, immutable, graded at the recorded number; validation earns its label');
{
  const R = RD.read(input({ fair: -1.3, center: 6.5, cover: V1.cover, quotes: mnQuotes }));
  const s = RD.snapshot(R), s2 = RD.snapshot(R);
  chk('a snapshot freezes book, line, odds, time, fair, probability, EV and status', ['book', 'line', 'price', 'quote_observed_at', 'fair_home_margin', 'cover_probability', 'estimated_ev', 'timing_read', 'decision_status', 'research_status'].every((k) => k in s));
  chk('snapshots are immutable', Object.isFrozen(s) && (() => { try { s.line = 99; } catch (e) { /* strict */ } return s.line !== 99; })());
  chk('the read id is deterministic', s.read_id === s2.read_id);
  const g = RD.grade(s, { close_home_line: -8, final_margin: 10, later_quotes: [{ home_line: -10.5, observed_at: '2026-10-02T12:00:00Z' }] });
  chk('graded at the RECORDED line, never a better later one (CLV +6.5 vs close +8 = −1.5)', g.clv_pts === -1.5 && g.result === 'L', g);
  chk('a non-BET grade is hypothetical', g.hypothetical === true);
  const wait = Object.assign({}, s, { timing_read: 'PRICE_TARGET', target_line: 7.5, read_id: 'w1' });
  const gw = RD.grade(wait, { close_home_line: -7.5, final_margin: 3, later_quotes: [{ home_line: -7.5, observed_at: '2026-10-02T12:00:00Z' }] });
  chk('a WAIT is graded on the price later available: target reached, improvement, wait success', gw.target_reached === true && gw.wait_improvement_pts === 1 && gw.wait_success === true, gw);
  const v = RD.validation([s, wait], [g, gw]);
  chk('the validation dashboard counts but prints no rate under n = 30', v.pass.n + v.research.n + v.wait.n >= 1 && v.wait.rates_shown === false && /never because BET EARLY reads happened to win/.test(v.rule));
  chk('shouldRecord: INVESTIGATE and NO DECISION are not frozen; a PASS only with an apparent disagreement', !RD.shouldRecord({ timing_read: 'INVESTIGATE' }) && !RD.shouldRecord({ timing_read: 'NO_DECISION' }) && !RD.shouldRecord({ timing_read: 'PASS', model_market_gap: { points: 0.5 }, selected: {} }));
}

/* =================================================================== 16 */
section('16. the assistant reads the Read — it never redoes the math');
{
  const o = GAMES.find((x) => x.read && x.read.timing_read === 'RESEARCH') || GAMES.find((x) => x.read && x.read.selected);
  const Qs = { 'Would you take Minnesota +6.5 or +7.5?': 'main_or_alt', 'Is the extra juice worth it?': 'juice', 'Should I bet this now?': 'bet_now', 'Would you wait?': 'wait',
    "What's the worst number you'd take?": 'worst_number', 'What price would make this a pass?': 'pass_price', 'Which book has the best price?': 'best_book',
    'Has the value disappeared?': 'value_gone', 'Is this model edge or stale-book edge?': 'edge_kind', "Why isn't this a bet?": 'why_not' };
  Object.keys(Qs).forEach((qq) => {
    const a = T.ask(qq, o);
    chk('"' + qq + '" → ' + Qs[qq] + ' from the stored read', a.intent === 'read_' + Qs[qq] && a.facts.length >= 1 && a.text.length > 20, [a.intent, a.text.slice(0, 120)]);
  });
  const bn = T.ask('Should I bet this now?', o);
  chk('"Should I bet this now?" answers with the read’s own timing word', bn.text.indexOf(o.read.timing_read.replace(/_/g, ' ')) === 0);
  chk('"Are the sharps on this?" is still UNKNOWN (the guard wins)', T.ask('Are the sharps on this?', o).intent === 'invent_guard');
  chk('game context loads automatically: the answer names this game’s side', !o.read.side_team || T.ask('What price would make this a pass?', o).text.indexOf(o.read.side_team) >= 0 || /No nearby number/.test(T.ask('What price would make this a pass?', o).text));
}

/* =================================================================== 17 */
section('17. the real slate (football/cfb_terminal/games.json)');
{
  const withRead = GAMES.filter((o) => o.read);
  chk('every game on the slate carries an EdgeDesk Read and its stored inputs', withRead.length === GAMES.length && GAMES.every((o) => o.read_inputs), [withRead.length, GAMES.length]);
  chk('one fair line: the Read’s fair is the research object’s fair', withRead.every((o) => !o.edgedesk.available || near(o.read.projected_margin, o.edgedesk.home_margin, 0.006)));
  chk('the fair line never moves with the market (curve centre ≠ fair; fair unchanged)', withRead.every((o) => !o.read_inputs.curve || near(o.read_inputs.model.home_margin, o.edgedesk.home_margin, 1e-9)));
  const pol = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'artifacts', 'decision', 'cfb_decision_policy_v1', 'policy.json'), 'utf8'));
  chk('betting is disabled, so no read is actionable', pol.bet_enabled === false && withRead.every((o) => !o.read.actionable));
  chk('the champion has no validated calibration: every read is CALIBRATION PENDING, basis RAW', withRead.every((o) => o.read.calibration.status === 'PENDING' && o.read.probability_basis === 'RAW'));
  chk('no read is actionable on a stale quote or an unverified gap', withRead.every((o) => !o.read.actionable || (o.read.selected.fresh && !o.read.research_status.blocks_action)));
  chk('every terminal INVESTIGATE / DATA FAULT game is INVESTIGATE in the Read', withRead.filter((o) => o.status.key === 'INVESTIGATE' || o.status.key === 'DATA_FAULT').every((o) => o.read.timing_read === 'INVESTIGATE'));
  chk('every read passes the language audit (no lock, hammer, max bet, sharp money)', withRead.every((o) => o.read.language.ok));
  const banned = /\b(lock|hammer|max bet|smart money|sharp money|sharps are|steam move)\b|🔥/i;
  chk('no banned word anywhere in any published read', withRead.every((o) => !banned.test(JSON.stringify(o.read))));
  /* the page re-prices with the SAME function: a rebuild at the build clock is byte-identical */
  let same = 0;
  withRead.forEach((o) => { const r2 = RD.read(RD.fromTerminal(o, o.read_inputs, { now: Date.parse(o.read.generated_at), integrity: INTEG })); if (JSON.stringify(r2) === JSON.stringify(o.read)) same++; });
  chk('the page’s recomputation at the build clock reproduces every published read exactly (' + same + '/' + withRead.length + ')', same === withRead.length);
  const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'board.json'), 'utf8'));
  chk('the board carries the read summary and the Read filters', board.rows.every((r) => 'read' in r) && board.read_filters.length === Object.keys(RD.FILTERS).length);
  chk('board read counts add up to the slate', Object.values(board.read_counts).reduce((a, b) => a + b, 0) === board.rows.length);
  const csv = path.join(__dirname, 'read.csv');
  chk('the export file exists with fair, price, cover, break-even, EV, bettable-to, timing, research, model, time', fs.existsSync(csv) && /fair_home_line.*price.*cover_probability.*break_even.*estimated_ev.*bettable_to_line.*timing_read.*research_status/.test(fs.readFileSync(csv, 'utf8').split('\n')[0]) && /model_version.*generated_at/.test(fs.readFileSync(csv, 'utf8').split('\n')[0]));
  chk('totals and team totals are NOT ACTIVATED; the moneyline is shown, never decided', withRead.every((o) => o.read.markets.total.status === 'NOT_ACTIVATED' && o.read.markets.moneyline.status === 'NOT_ACTIVATED'));
  const cleanRank = RD.rankReads(withRead.map((o) => o.read));
  chk('research quality is ranked on its own: no INVESTIGATE read outranks a clearing clean one', (() => { const iInv = cleanRank.findIndex((r) => r.timing_read === 'INVESTIGATE'), iRes = cleanRank.findIndex((r) => r.selected && r.selected.clears && !r.research_status.blocks_action); return iInv < 0 || iRes < 0 || iRes < iInv; })());
  const reads = path.join(__dirname, 'read', String(G.season), 'reads.jsonl');
  const rows = fs.existsSync(reads) ? fs.readFileSync(reads, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  chk('the read record exists, is append-only JSONL with unique ids', rows.length > 0 && new Set(rows.map((r) => r.read_id)).size === rows.length);
}

/* =================================================================== 18 */
section('18. the page and its boundaries');
{
  const page = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'terminal.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'research', 'cfb', 'index.html'), 'utf8');
  chk('the page runs no model: no engine, no PMF, no t-distribution', !/projectGame|coverProbSpread|marginDistribution|tCdf|EDCfbP4|EDCfbV2|decideQuote|decideGame/.test(page));
  chk('the page re-prices only through lib/edgedesk_read.js (fromTerminal → read)', /RD\.read\(readInput\(o\)\)/.test(page) && /RD\.fromTerminal\(/.test(page));
  chk('decision.js loads before edgedesk_read.js, and both before the page', html.indexOf('cfb_decision/decision.js') < html.indexOf('lib/edgedesk_read.js') && html.indexOf('lib/edgedesk_read.js') < html.indexOf('research/cfb/terminal.js'));
  chk('the Read card is the first card on the game page', page.indexOf("readCard(o, S.read)") > 0 && page.indexOf("readCard(o, S.read)") < page.indexOf("'<div class=\"sum'"));
  chk('no sportsbook-gimmick words in the page', !/\b(LOCK|HAMMER|MAX BET)\b|🔥/.test(page));
  chk('the reader’s clock re-prices every read (a quote past the freshness rule stops being a price)', /nowMs\(\)/.test(page) && /now: nowMs\(\)/.test(page));
  chk('the page can never write a BET: no timing assignment to BET in the page', !/timing_read\s*=\s*['"]BET/.test(page) && !/decision_status\s*=\s*['"]BET/.test(page));
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_read.js'), 'utf8');
  chk('the Read never computes a football number (no engine, no sigma, no normal CDF)', !/projectGame|coverProbSpread|marginDistribution|\btCdf\b|normCdf|erf\(/.test(lib));
}

/* =================================================================== 19 */
section('19. alternate spreads: the opt-in capture parses only real prices');
{
  const ev = { id: 'ev1', commence_time: '2026-10-03T19:30:00Z', home_team: 'Michigan Wolverines', away_team: 'Minnesota Golden Gophers',
    bookmakers: [{ key: 'draftkings', last_update: '2026-10-01T14:20:00Z', markets: [{ key: 'alternate_spreads', last_update: '2026-10-01T14:21:00Z', outcomes: [
      { name: 'Michigan Wolverines', price: -145, point: -5.5 }, { name: 'Minnesota Golden Gophers', price: 120, point: 5.5 },
      { name: 'Michigan Wolverines', price: 145, point: -7.5 }, { name: 'Minnesota Golden Gophers', price: -178, point: 7.5 },
      { name: 'Minnesota Golden Gophers', price: -260, point: 10.5 },
      { name: 'Michigan Wolverines', price: -110, point: -3.25 }, { name: 'Ohio State', price: -110, point: 3 },
      { name: 'Michigan Wolverines', price: 50, point: -2.5 }] }] }] };
  const p = ALT.parseEventOdds(ev, 'g1', '2026-10-01T14:30:00Z');
  const by = {}; p.quotes.forEach((x) => { by[x.home_line] = x; });
  chk('both sides of one number pair into one quote (home −7.5: +145 / −178)', by['-7.5'] && by['-7.5'].price_home === 145 && by['-7.5'].price_away === -178 && by['-7.5'].alternate === true);
  chk('a number only one side of was captured stays one-sided (+10.5 −260)', by['-10.5'] && by['-10.5'].price_home === null && by['-10.5'].price_away === -260);
  chk('quarter lines, strangers and impossible prices are refused and counted', !by['-3.25'] && !by['-2.5'] && p.refused['not a half-point line'] === 1 && p.refused['outcome names neither team'] === 1 && p.refused['price not a valid American price'] === 1, p.refused);
  chk('provider last_update is kept as the true quote age', by['-7.5'].provider_updated_at === '2026-10-01T14:21:00.000Z');
  chk('an unchanged alternate is not re-written (append only what changed)', ALT.selectNew(p.quotes, p.quotes).length === 0 && ALT.selectNew([], p.quotes).length === p.quotes.length);
  const R = RD.read(input({ fair: 1.3, center: 6.5, cover: V1.cover, quotes: [q('dk', 'draftkings', -6.5, -107, -113)].concat(p.quotes.map((x) => Object.assign({}, x, { source: 'odds_api' }))) }));
  chk('captured alternates reach the Read and never the consensus', R.alternates.rows.length === 3 && R.consensus.home_line === -6.5 && R.consensus.n_books === 1, [R.alternates.rows.length, R.consensus.home_line]);
  const one = R.alternates.rows.find((x) => x.option.line === 10.5);
  chk('a one-sided alternate is de-vigged with the same book’s main-line overround and marked lower confidence', one.option.market_probability.method === 'MAIN_LINE_OVERROUND' && one.liquidity.level === 'LOWER');
}

/* =================================================================== 20 */
section('20. the explanation boundary carries the Read and refuses to contradict it');
{
  /* a published read with a selection that nothing blocks; when this week's
     slate has none (Pitt @ Virginia Tech, the only selected read, is held at
     INVESTIGATE by Virginia Tech's regime change — audit 2026-09-30 #1), the
     boundary is exercised on a copy of that read with the block lifted: what
     is under test here is the explanation boundary, not the slate */
  const o = GAMES.find((x) => x.read && x.read.selected && !x.read.research_status.blocks_action) || (() => {
    const b = GAMES.find((x) => x.read && x.read.selected);
    if (!b) return null;
    const c = JSON.parse(JSON.stringify(b));
    c.read.research_status = Object.assign({}, c.read.research_status, { blocks_action: false });
    return c;
  })();
  chk('the slate carries a selected read to explain', !!o);
  const f = X.cfbFacts(T.explainSource(o));
  chk('the facts carry the read: timing, decision, side, line, price, cover (basis), break-even', f.read && f.read.timing && f.read.line === o.read.selected.line && f.read.probability_basis === 'RAW');
  const txt = X.render(f);
  chk('the deterministic explanation names the read and passes its own audit', /EdgeDesk Read:/.test(txt) && X.auditExplanation(txt, f).ok, X.auditExplanation(txt, f).issues);
  const bad = X.auditExplanation('The EdgeDesk Read is certified: bet ' + o.read.side_team + ' now. It is uncertain.', f);
  chk('an LLM calling the read certified or a bet is refused', !bad.ok && bad.issues.some((i) => i.code === 'READ_CERTIFIED_CLAIM' || i.code === 'BET_CLAIM_NOT_OFFICIAL'));
  /* a percentage the facts do not hold: a fixed one can collide with the live
     slate (71.3% did, once a selected read carried a 71.4% win probability) */
  let fake = 71.3;
  while ((f.numbers || []).some((a) => Math.abs(a - fake) <= 0.5)) fake = Math.round((fake + 1.1) * 10) / 10;
  const inv = X.auditExplanation('EdgeDesk makes it a big edge; the number is ' + fake + '% to cover. It is uncertain.', f);
  chk('an LLM inventing a probability not in the facts is refused', fake < 100 && !inv.ok && inv.issues.some((i) => i.code === 'NUMBER_NOT_IN_FACTS'), [fake, inv.issues]);
  if (MI) chk('the market-language audit finds nothing to refuse in any read reason', GAMES.filter((x) => x.read).every((x) => MI.auditMarketLanguage(x.read.market_movement_summary.text || '', null).problems.filter((p) => /not measurable/.test(p)).length === 0));
}

failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
