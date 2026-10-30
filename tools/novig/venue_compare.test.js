#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_venue_compare.js — the executable-price engine and the
   comparison metrics, against Novig's own worked examples and by hand.

     units       a price is thousandths ("0.62" = 620); one contract pays 1¢;
                 110 @ 0.665 cost $0.73150 and pay $1.10000 (money.md)
     grid        Novig's 279 prices; off-grid and malformed prices refused
     complement  the price to buy one outcome is 1 − the other outcome's bid
     fees        the fee table in fees.md to the millicent; half-up rounding;
                 pregame WHEN_LIVE charges nothing, OPEN_INGAME charges, ALWAYS
                 always; an unreadable coefficient is refused, not guessed
     walk        a stake walks the ladder; VWAP; the top price not achievable
                 at size; PARTIAL when the book runs out; NO_LIQUIDITY
     odds        American <-> decimal <-> implied, the prompt's own formulas
     hold        only a complete outcome set has a hold; no-vig sums to one
     EV          p·net − (1 − p − push); the five transition states; the model
                 gate (tier, version, freeze time, same market, age)
     compare     both fresh: stake rows with payout difference and the better
                 venue; a stale DraftKings price is never compared; a book
                 that cannot fill a stake says so; no model, no EV
     rules       RULES equal public.novig_rule() in the SQL layer

   Run: node tools/novig/venue_compare.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const V = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_venue_compare.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => a != null && b != null && Math.abs(a - b) <= (e == null ? 1e-9 : e);

/* ---------------------------------------------------------------- units and the grid */
chk('price: "0.665" is 665, "0.62" is 620, "1" is 1000, a Number 0.62 is 620', V.milli('0.665') === 665 && V.milli('0.62') === 620 && V.milli('1') === 1000 && V.milli(0.62) === 620 && V.milli('0') === 0);
chk('price: four places, a sign, an exponent, above one and text are refused', [ '0.6655', '-0.1', '1e-1', '1.001', 'x', '', null ].every((x) => V.milli(x) === null));
chk('grid: the three bands (0.001–0.050 by 0.001, 0.055–0.945 by 0.005, 0.950–0.999 by 0.001)', V.onGrid(1) && V.onGrid(50) && !V.onGrid(51) && V.onGrid(55) && V.onGrid(665) && !V.onGrid(667) && V.onGrid(945) && !V.onGrid(946) && V.onGrid(950) && V.onGrid(999) && !V.onGrid(0) && !V.onGrid(1000));
chk('grid: 279 prices, and every price\'s complement is on it', (() => { let n = 0, comp = true; for (let m = 0; m <= 1000; m++) if (V.onGrid(m)) { n++; if (!V.onGrid(1000 - m)) comp = false; } return n === 279 && comp; })());
const ex = V.fill([{ m: 665, qty: 110 }], '0.73150', { charged: false });
chk('units: 110 contracts at 0.665 cost $0.73150 and pay $1.10000 (Novig\'s own example)', ex.status === 'FILLED' && ex.contracts === 110 && ex.cost === '0.73150' && ex.payout === '1.10000' && ex.unspent === '0.00000', ex);
chk('units: 100 contracts pay $1 (a contract is 1¢, not $1 and not $100)', V.fill([{ m: 500, qty: 100 }], '0.50', { charged: false }).payout === '1.00000');
chk('money: u <-> dollars is exact (no binary float)', V.uToDollars(73150n) === '0.73150' && V.dollarsToU('0.73150') === 73150n && V.dollarsToU('100') === 10000000n && V.uToDollars(-5n) === '-0.00005' && V.dollarsToU('1.234567') === null);

/* ---------------------------------------------------------------- fees (fees.md) */
chk('fee: 10 000 @ 0.50 = $1.5000', V.uToDollars(V.takerFeeU(500, 10000, '0.06')) === '1.50000');
chk('fee: 10 000 @ 0.30 or 0.70 = $1.2600 (symmetric)', V.uToDollars(V.takerFeeU(300, 10000, '0.06')) === '1.26000' && V.uToDollars(V.takerFeeU(700, 10000, '0.06')) === '1.26000');
chk('fee: 10 000 @ 0.10 = $0.5400; 100 @ 0.50 = $0.0150; one contract @ 0.50 = $0.00015 (sub-cent, no floor)', V.uToDollars(V.takerFeeU(100, 10000, '0.06')) === '0.54000' && V.uToDollars(V.takerFeeU(500, 100, '0.06')) === '0.01500' && V.takerFeeU(500, 1, '0.06') === 15n);
chk('fee: rounds half up to the millicent (10 @ 0.050 owes 28.5 u, charged 29 u)', V.takerFeeU(50, 10, '0.06') === 29n && V.takerFeeU(505, 1, '0.06') === 15n);
chk('fee: pregame WHEN_LIVE charges nothing; OPEN_INGAME charges; ALWAYS always', V.feeCharged({ charged: 'WHEN_LIVE' }, 'OPEN_PREGAME').charged === false && V.feeCharged({ charged: 'WHEN_LIVE' }, 'OPEN_INGAME').charged === true
  && V.feeCharged({ charged: 'WHEN_LIVE' }, 'DELAYED').charged === false && V.feeCharged({ charged: 'ALWAYS' }, 'OPEN_PREGAME').charged === true && V.feeCharged(null).charged === null);
chk('fee: an unreadable coefficient on a charged market is refused, not guessed', V.fill([{ m: 500, qty: 100 }], 10, { charged: true, coefficient: 'six cents' }).status === 'FEE_UNKNOWN');

/* ---------------------------------------------------------------- the book: complement and walk (the docs' Chiefs / Bills ladders) */
const BOOK = { marketId: 'm1', seq: 48120, orders: {
  chiefs: [{ orderId: 'a', price: '0.665', qty: 110 }, { orderId: 'b', price: '0.660', qty: 250 }],
  bills: [{ orderId: 'c', price: '0.340', qty: 90 }, { orderId: 'd', price: '0.335', qty: 100 }, { orderId: 'e', price: '0.335', qty: 80 }, { orderId: 'f', price: '0.325', qty: 400 }],
} };
const IDS = ['chiefs', 'bills'];
const lc = V.askLadder(BOOK, 'chiefs', IDS), lb = V.askLadder(BOOK, 'bills', IDS);
chk('complement: Chiefs are bought against the Bills\' bids at 1 − bid (0.660, 0.665, 0.675), cheapest first', lc.ok && lc.ladder.map((l) => l.m).join(',') === '660,665,675' && lc.ladder.map((l) => l.qty).join(',') === '90,180,400');
chk('complement: equal prices aggregate but keep each order (fee rounding is per fill)', lc.ladder[1].fills.join(',') === '100,80');
chk('complement: Bills are bought at 1 − 0.665 = 0.335 first', lb.ladder[0].m === 335 && lb.ladder[0].qty === 110);
chk('complement: a market without exactly two outcomes is refused', !V.askLadder(BOOK, 'chiefs', ['chiefs', 'bills', 'draw']).ok);
const f1 = V.fill(lc.ladder, 1, { charged: false });
chk('walk: $1 buys 90 @ 0.660 then 61 @ 0.665 = 151 contracts for $0.99965 (pays $1.51)', f1.status === 'FILLED' && f1.contracts === 151 && f1.cost === '0.99965' && f1.payout === '1.51000' && f1.unspent === '0.00035'
  && f1.levels.length === 2 && f1.levels[1].contracts === 61, f1);
chk('walk: the VWAP and the effective odds are what the stake bought, not the top of book', f1.vwap === (99965 / 151 / 1000).toFixed(6) && near(f1.effective_decimal, 151000 / 99965, 1e-12) && f1.top_not_achievable === true && f1.slippage_pp > 0);
const f10 = V.fill(lc.ladder, 10, { charged: false });
chk('walk: $10 exhausts the 670 contracts on the book ($4.49100): PARTIAL, never assumed filled', f10.status === 'PARTIAL' && f10.contracts === 670 && f10.total === '4.49100' && f10.unspent === '5.50900' && /no liquidity/.test(f10.reason), f10);
chk('walk: a small stake at the top level achieves the top price', (() => { const x = V.fill(lc.ladder, 0.5, { charged: false }); return x.status === 'FILLED' && x.contracts === 75 && !x.top_not_achievable; })());
chk('walk: an empty book is NO_LIQUIDITY; a stake below one contract is NO_LIQUIDITY; a zero stake is invalid', V.fill([], 100, {}).status === 'NO_LIQUIDITY' && V.fill(lc.ladder, '0.00500', {}).status === 'NO_LIQUIDITY' && V.fill(lc.ladder, 0, {}).status === 'INVALID_STAKE');
const fLive = V.fill(lc.ladder, 1, { charged: true, coefficient: '0.06' });
chk('walk in play: the taker fee is paid per fill and the stake buys fewer contracts', fLive.status === 'FILLED' && fLive.contracts < 151 && Number(fLive.fee) > 0
  && V.dollarsToU(fLive.cost) + V.dollarsToU(fLive.fee) === V.dollarsToU(fLive.total) && V.dollarsToU(fLive.total) <= 100000n, fLive);
chk('walk in play: fee = Σ per-fill half-up fees (90 @ 0.660, then the rest @ 0.665)', (() => {
  const n2 = fLive.contracts - 90;
  return V.dollarsToU(fLive.fee) === V.takerFeeU(660, 90, '0.06') + V.takerFeeU(665, n2, '0.06');
})());
chk('decimal accuracy: three fills at 0.335 sum exactly (no 0.1 + 0.2 drift)', V.fill([{ m: 335, qty: 3, fills: [1, 1, 1] }], '0.01005', { charged: false }).cost === '0.01005');

/* ---------------------------------------------------------------- the executable quote */
const q = V.executableQuote(BOOK, 'chiefs', IDS, { fee: { coefficient: '0.06', makerCredit: '0.25', charged: 'WHEN_LIVE' }, eventStatus: 'OPEN_PREGAME' });
chk('quote: top of book 0.660 for 90 contracts, -194 American, on the grid', q.ok && q.top.price === '0.660' && q.top.contracts === 90 && V.roundAmerican(q.top.american) === -194 && q.top.on_grid);
chk('quote: depth is every contract on the ladder and what clearing it costs', q.depth.contracts === 670 && q.depth.cost_to_clear === '4.49100' && q.depth.payout_if_cleared === '6.70000');
chk('quote: pregame, the fee is named and not charged; five standard stakes', q.fee.charged === false && /pregame/.test(q.fee.why) && q.stakes.length === 5 && q.stakes.map((s) => s.stake_dollars).join(',') === '25,50,100,250,500');
chk('quote: compactDepth keeps prices as strings and each order size', JSON.stringify(V.compactDepth(BOOK).bills[1]) === JSON.stringify(['0.335', 180, [100, 80]]));

/* ---------------------------------------------------------------- odds */
chk('odds: +150 implies 0.40, −150 implies 0.60 (100/(A+100), |A|/(|A|+100))', near(V.impliedFromAmerican(150), 0.4) && near(V.impliedFromAmerican(-150), 0.6) && V.impliedFromAmerican(50) === null);
chk('odds: a contract at 0.625 is decimal 1.6, American −166.67 (shown −167)', near(V.decimalToAmerican(1000 / 625), -166.6666666, 1e-6) && V.fmtAmerican(V.decimalToAmerican(1.6)) === '-167');
chk('odds: decimal <-> American round trip; −100 displays as +100', near(V.americanToDecimal(-110), 1.9090909, 1e-6) && near(V.americanToDecimal(250), 3.5) && V.fmtAmerican(-100) === '+100' && V.fmtAmerican(null) === '—');

/* ---------------------------------------------------------------- hold and no-vig */
const h = V.hold([{ implied: V.impliedFromAmerican(-110) }, { implied: V.impliedFromAmerican(-110) }]);
chk('hold: −110 / −110 holds 4.76%', h.ok && near(h.hold, 0.0476190, 1e-6) && /not what any one bettor/.test(h.note));
chk('hold: one side, a missing price, a 2-of-3 market and two snapshots have no hold', !V.hold([{ implied: 0.5 }]).ok && !V.hold([{ implied: 0.5 }, { implied: null }]).ok
  && !V.hold([{ implied: 0.5 }, { implied: 0.52 }], { expected: 3 }).ok && !V.hold([{ implied: 0.5 }, { implied: 0.52 }], { sameSnapshot: false }).ok);
chk('hold: a three-way market generalises (sum of three minus one)', (() => { const x = V.hold([{ implied: 0.45 }, { implied: 0.30 }, { implied: 0.30 }], { expected: 3 }); return x.ok && near(x.hold, 0.05); })());
const nv = V.noVig([{ implied: V.impliedFromAmerican(-150) }, { implied: V.impliedFromAmerican(130) }]);
chk('no-vig: proportional, sums to one, labelled an estimate', nv.ok && near(nv.probabilities[0] + nv.probabilities[1], 1) && nv.method === 'proportional' && /estimate/.test(nv.note));

/* ---------------------------------------------------------------- EV */
chk('EV: p 0.55 at even money is +0.10 per $1; at −110 it is +0.05', near(V.evPerDollar(0.55, 1), 0.10) && near(V.evPerDollar(0.55, 100 / 110), 0.05));
chk('EV: a push returns the stake (p 0.45, push 0.10, even money: 0.00)', near(V.evPerDollar(0.45, 1, 0.10), 0) && V.evPerDollar(0.6, 1, 0.5) === null && V.evPerDollar(1.2, 1) === null);
chk('EV states: both, Novig only, DraftKings only, neither, insufficient', V.evState(0.01, 0.02) === 'POSITIVE_BOTH' && V.evState(-0.01, 0.02) === 'POSITIVE_NOVIG_ONLY' && V.evState(0.01, -0.02) === 'POSITIVE_BOOK_ONLY'
  && V.evState(-0.01, -0.02) === 'NEGATIVE_BOTH' && V.evState(null, 0.1) === 'INSUFFICIENT_DATA');
const NOW = Date.parse('2026-11-01T17:00:00Z');
const MKT = { kind: 'h2h', period: 'game', line: null, side: 'Kansas City Chiefs' };
const MODEL = { p_win: 0.62, model_version: 'edgedesk_football_v1.0.0', tier: 'OUTCOME_VALIDATED', frozen_at: '2026-11-01T12:00:00Z', market: MKT };
const gate = (m, qq) => V.modelGate(Object.assign({}, MODEL, m || {}), Object.assign({}, MKT, { observed_at: '2026-11-01T16:55:00Z' }, qq || {}), NOW);
chk('model gate: a versioned, validated, current model for this exact market passes', gate().ok);
chk('model gate: research tier, no version, frozen after the quote, too old, another line, the other side are each refused', !gate({ tier: 'RESEARCH' }).ok && !gate({ model_version: null }).ok
  && !gate({ frozen_at: '2026-11-01T16:58:00Z' }).ok && !gate({ frozen_at: '2026-10-30T12:00:00Z' }).ok && !gate({ market: Object.assign({}, MKT, { kind: 'spreads', line: -3.5 }) }).ok
  && !gate({ market: Object.assign({}, MKT, { side: 'Buffalo Bills' }) }).ok && /could have seen the price/.test(gate({ frozen_at: '2026-11-01T16:58:00Z' }).reasons.join(' ')));

/* ---------------------------------------------------------------- freshness */
const ago = (min) => new Date(NOW - min * 60000).toISOString();
chk('freshness: a REST snapshot is Recently updated for 10 min, never Live; a streamed book 90 s old is Live', V.freshness('novig', ago(3), NOW, { source: 'rest' }).state === 'RECENT' && V.freshness('novig', ago(1), NOW, { source: 'ws' }).state === 'LIVE'
  && V.freshness('novig', ago(11), NOW).state === 'STALE');
chk('freshness: DraftKings Live ≤ 10 min, Recent ≤ 90, then Stale and labelled historical', V.freshness('book', ago(5), NOW).state === 'LIVE' && V.freshness('book', ago(60), NOW).state === 'RECENT'
  && V.freshness('book', ago(120), NOW).state === 'STALE' && /historical/.test(V.freshness('book', ago(3000), NOW).why));
chk('freshness: no observation is Awaiting; a future stamp is not trusted; a suspension wins', V.freshness('book', null, NOW).state === 'AWAITING' && V.freshness('book', new Date(NOW + 3600e3).toISOString(), NOW).state === 'STALE'
  && V.freshness('novig', ago(1), NOW, { suspended: 'market CLOSED' }).state === 'SUSPENDED');

/* ---------------------------------------------------------------- one selection at both venues */
const NBOOK = { orders: { kc: [{ price: '0.380', qty: 50000 }, { price: '0.375', qty: 30000 }], buf: [{ price: '0.385', qty: 20000 }, { price: '0.380', qty: 20000 }, { price: '0.370', qty: 40000 }] } };
const nq = V.executableQuote(NBOOK, 'kc', ['kc', 'buf'], { fee: { coefficient: '0.06', charged: 'WHEN_LIVE' }, eventStatus: 'OPEN_PREGAME' });
const base = { now: NOW, market: MKT, novig: { quote: nq, observed_at: ago(2), source: 'rest' } };
const c1 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1.606, observed_at: ago(6) } }));
chk('compare: Novig 0.615 (−160) against DraftKings 1.606 (−165): comparable, simultaneous, Novig better at the top', c1.comparable && c1.simultaneous && c1.top.better === 'NOVIG'
  && V.roundAmerican(c1.top.novig_american) === -160 && V.roundAmerican(c1.top.book_american) === -165 && near(c1.top.implied_gap_pp, (1 / 1.606 - 0.615) * 100, 1e-9), c1.top);
const r100 = c1.rows.find((r) => r.stake === 100);
chk('compare at $100: Novig fills at the top price (16 260 @ 0.615); payout difference stated in dollars', r100.comparable && r100.novig.status === 'FILLED' && r100.novig.contracts === 16260 && !r100.novig.top_not_achievable
  && r100.book.payout === '160.60' && near(r100.payout_diff, 162.60 + Number(r100.novig.unspent) - 160.60, 1e-9) && r100.better === 'NOVIG' && r100.cost_of_worse_price === r100.payout_diff, r100);
const r250 = c1.rows.find((r) => r.stake === 250);
chk('compare at $250: the order walks to 0.620 and 0.630 (the top price is not achievable at size)', r250.comparable && r250.novig.top_not_achievable && r250.novig.levels.length === 3 && r250.novig.slippage_pp > 0, r250 && r250.novig);
const r500 = c1.rows.find((r) => r.stake === 500);
chk('compare at $500: the book holds $499 (20 000 + 20 000 + 40 000 contracts); not compared, and says why', !r500.comparable && r500.novig.status === 'PARTIAL' && r500.novig.total === '499.00000' && /cannot fill \$500/.test(r500.why), r500);
chk('compare: with no model, no row states an EV', c1.rows.every((r) => !r.ev || r.ev.state === 'INSUFFICIENT_DATA') && /not, by itself, a positive-expected-value/.test(c1.disclaimer));
const c2 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1.606, observed_at: ago(6) }, model: MODEL }));
const e100 = c2.rows.find((r) => r.stake === 100).ev;
chk('compare with a validated model (p 0.62): negative at DraftKings, positive only at Novig, the delta in $ at the stake', e100.state === 'POSITIVE_NOVIG_ONLY'
  && near(e100.book_per_dollar, 0.62 * 0.606 - 0.38, 1e-9) && near(e100.novig_per_dollar, 0.62 * (162.6 / Number(r100.novig.total) - 1) - 0.38, 1e-9) && e100.delta_dollars > 0, e100);
const c3 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1.606, observed_at: ago(3000) } }));
chk('compare: a two-day-old DraftKings price is never compared as live savings', !c3.comparable && c3.book_state === 'STALE' && c3.rows.every((r) => !r.comparable && r.payout_diff === undefined) && /historical/.test(c3.notes.join(' ')));
const c4 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1.606, observed_at: ago(40) } }));
chk('compare: both fresh but 38 min apart is comparable and says it is not simultaneous', c4.comparable && !c4.simultaneous && /not a simultaneous/.test(c4.notes.join(' ')));
const c5 = V.compareSelection(Object.assign({}, base, { book: null }));
chk('compare: one venue only (no DraftKings price) is Awaiting data, nothing compared', !c5.comparable && c5.book_state === 'AWAITING' && c5.novig_state === 'RECENT');
const c6 = V.compareSelection({ now: NOW, market: MKT, book: { decimal: 1.606, observed_at: ago(6) }, novig: { quote: V.executableQuote({ orders: { kc: [], buf: [] } }, 'kc', ['kc', 'buf'], {}), observed_at: ago(1) } });
chk('compare: an empty Novig book is No liquidity', !c6.comparable && c6.novig_state === 'NO_LIQUIDITY');
const c7 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1.65, observed_at: ago(6) } }));
chk('compare: when DraftKings is better (1.65 against Novig\'s 1.626) it says so', c7.top.better === 'DRAFTKINGS' && c7.rows.find((r) => r.stake === 25).better === 'DRAFTKINGS');
const c8 = V.compareSelection(Object.assign({}, base, { book: { decimal: 1000 / 615, observed_at: ago(6) } }));
chk('compare: an identical price is a tie', c8.top.better === 'TIE' && c8.rows.find((r) => r.stake === 25).better === 'TIE');

/* ---------------------------------------------------------------- statistics */
const w = V.wilson(60, 100);
chk('stats: Wilson 60/100 is about [0.502, 0.691]; n=0 gives nulls', near(w.low, 0.502, 0.002) && near(w.high, 0.691, 0.002) && V.wilson(0, 0).p === null);
chk('stats: median and quantiles ignore nulls', V.median([3, null, 1, 2]) === 2 && V.median([1, 2, 3, 4]) === 2.5 && V.quantile([1, 2, 3, 4, 5], 0.25) === 2 && V.median([]) === null);

/* ---------------------------------------------------------------- the rules agree with the SQL layer */
const SQLF = path.join(__dirname, '..', '..', 'supabase', 'novig_market_data.sql');
if (fs.existsSync(SQLF)) {
  const sql = fs.readFileSync(SQLF, 'utf8');
  const bad = Object.entries(V.RULES).filter(([k, v]) => { const m = new RegExp("when '" + k + "'\\s+then ([0-9.]+)").exec(sql); return !m || Number(m[1]) !== v; });
  chk('rules: every RULES value equals public.novig_rule() in supabase/novig_market_data.sql', !bad.length, bad);
} else chk('rules: supabase/novig_market_data.sql exists', false);

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' venue compare: ' + pass + ' passed, ' + fail + ' failed');
for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail, (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 900) : ''));
process.exit(fail ? 1 : 0);
