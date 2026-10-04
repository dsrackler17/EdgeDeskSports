#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio.js — the Portfolio's arithmetic, case by case.

   Sportsbook wagers (every result, every price shape, parlays), prediction-
   market positions (YES / NO, fees, several buys, partial and full sells,
   resolution, voids), whole-book aggregation (platform, type, sport, ROI,
   exposure, record, win rate, periods), exact decimals at the edges, and the
   fingerprint material. The database's own copy of these rules is checked
   against this file by tools/portfolio/portfolio_sql.test.js.

   Run: node tools/portfolio/portfolio_calc.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_portfolio.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const d = E.dec;
const money = (x) => (x == null ? null : d.str(x));

/* ═══ 1. EXACT DECIMALS ══════════════════════════════════════════════════ */
eq('0.1 + 0.2 is exactly 0.3 (no floating point anywhere)', d.add('0.1', '0.2'), '0.3');
eq('100 × 100 / 110 rounds half away from zero to 90.91', d.divRound('10000', '110', 2), '90.91');
eq('2.005 → 2.01 (half away from zero, not banker\'s, not float-truncated)', d.fixed('2.005', 2), '2.01');
eq('−2.005 → −2.01', d.fixed('-2.005', 2), '-2.01');
eq('−5 / 2 → −3 at 0 places', d.divRound('-5', '2', 0), '-3');
eq('1 / 3 at six places', d.divRound('1', '3', 6), '0.333333');
eq('trailing zeros are canonicalised', d.str('100.0500'), '100.05');
eq('exponent input is read exactly', d.str('1.5e2'), '150');
eq('a number input is read through its shortest decimal form', d.str(90.91), '90.91');
eq('a long sum stays exact', d.sum(new Array(1000).fill('0.01')), '10');
chk('garbage is not a number', !d.valid('12abc') && !d.valid('') && !d.valid(null) && !d.valid(NaN));
eq('division by zero is null, never Infinity', E.dec.divRound('1', '0', 2), null);

/* ═══ 2. SPORTSBOOK ══════════════════════════════════════════════════════ */
function wager(o) { return E.derive(Object.assign({ platform_type: 'SPORTSBOOK', stake: '100' }, o)); }
let w = wager({ odds_american: 100, status: 'WON' });
eq('+100 winner: profit $100, payout $200', [w.profit_loss, w.gross_payout, w.result], ['100', '200', 'WIN']);
w = wager({ odds_american: 200, status: 'WON' });
eq('+200 winner: profit $200, payout $300', [w.profit_loss, w.gross_payout], ['200', '300']);
w = wager({ odds_american: 150, status: 'WON' });
eq('+150 winner: profit $150, payout $250', [w.profit_loss, w.gross_payout], ['150', '250']);
w = wager({ odds_american: -110, status: 'WON' });
eq('-110 winner: profit $90.91, payout $190.91 — payout is not profit', [w.profit_loss, w.gross_payout, w.odds_decimal], ['90.91', '190.91', '1.909091']);
w = wager({ odds_american: -200, status: 'WON' });
eq('-200 winner: profit $50, payout $150', [w.profit_loss, w.gross_payout], ['50', '150']);
w = wager({ odds_american: -110, status: 'LOST' });
eq('a loss: −$100, returned $0', [w.profit_loss, w.gross_payout, w.result], ['-100', '0', 'LOSS']);
w = wager({ odds_american: -110, status: 'PUSH' });
eq('a push: $0, stake returned', [w.profit_loss, w.gross_payout, w.result], ['0', '100', 'PUSH']);
w = wager({ odds_american: 150, status: 'VOID' });
eq('a void: $0, stake returned', [w.profit_loss, w.gross_payout, w.result], ['0', '100', 'VOID']);
w = wager({ odds_american: 300, status: 'CASHED_OUT', reported_payout: '60' });
eq('a cash-out pays what the book paid: −$40', [w.profit_loss, w.result], ['-40', 'CASHOUT']);
w = wager({ odds_american: 300, status: 'CASHED_OUT', reported_payout: '175' });
eq('a profitable cash-out: +$75, still a cash-out, not a win', [w.profit_loss, w.result], ['75', 'CASHOUT']);
w = wager({ odds_decimal: '1.91', status: 'WON' });
eq('decimal odds 1.91: profit $91 (the price as the source gave it, not re-rounded through American)', w.profit_loss, '91');
w = wager({ odds_american: -110, status: 'WON', fees: '2.50' });
eq('fees reduce the profit', w.profit_loss, '88.41');
w = wager({ odds_american: -110, status: 'WON', reported_payout: '190.90' });
eq('the book\'s reported payout wins over the computed one', w.profit_loss, '90.9');
w = wager({ odds_american: -110, status: 'OPEN' });
eq('an open bet: risk, to-win and payout; no P&L', [w.open_cost_basis, w.potential_profit, w.potential_payout, w.profit_loss, w.result], ['100', '90.91', '190.91', null, null]);
eq('$0.01 at -110 → $0.01 (0.00909 rounds up)', wager({ stake: '0.01', odds_american: -110, status: 'WON' }).profit_loss, '0.01');
eq('$10 at -115 → $8.70', wager({ stake: '10', odds_american: -115, status: 'WON' }).profit_loss, '8.7');
eq('$33.33 at +333 → $110.99', wager({ stake: '33.33', odds_american: 333, status: 'WON' }).profit_loss, '110.99');
eq('$7 at -10000 → $0.07', wager({ stake: '7', odds_american: -10000, status: 'WON' }).profit_loss, '0.07');
chk('odds between -100 and +100 are not odds', E.intAmerican(-99) === null && E.intAmerican(50) === null && E.intAmerican(0) === null && E.intAmerican(-100) === -100);
chk('a fractional American price is refused', E.intAmerican('-110.5') === null);
eq('American ↔ decimal for display', [E.americanToDecimal(-110), E.americanToDecimal(150), E.decimalToAmerican('1.909091'), E.decimalToAmerican('2.5'), E.decimalToAmerican('2')], ['1.909091', '2.5', -110, 150, 100]);

/* parlays */
let p = E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: -110, result: 'WON' }]);
eq('two -110 legs both won: +264 (decimal 3.644628)', [p.status, p.odds_decimal, p.odds_american], ['WON', '3.644628', 264]);
eq('and $100 on it wins $264.46 at the exact decimal', E.wagerProfit('100', null, p.odds_decimal), '264.46');
p = E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: 150, result: 'PUSH' }, { odds_american: -110, result: 'WON' }]);
eq('a pushed leg drops out: priced on the other two', [p.status, p.odds_american], ['WON', 264]);
p = E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: 150, result: 'LOST' }]);
eq('one lost leg loses the ticket', p.status, 'LOST');
p = E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: 150, result: 'OPEN' }]);
eq('a leg still open keeps it open', p.status, 'OPEN');
p = E.parlay([{ odds_american: -110, result: 'VOID' }, { odds_american: 150, result: 'PUSH' }]);
eq('every leg pushed or voided: the ticket is a push', [p.status, p.odds_decimal], ['PUSH', null]);
w = wager({ odds_american: 264, status: 'SETTLED', reported_payout: '190.91', position_type: 'PARLAY' });
eq('a re-priced parlay settles at what the book paid', [w.profit_loss, w.result], ['90.91', 'WIN']);

/* ═══ 3. PREDICTION MARKETS ══════════════════════════════════════════════ */
function contract(pos, fills) {
  return E.derive(Object.assign({ platform_type: 'PREDICTION_MARKET', side: 'YES' }, pos),
    fills.map((f) => ({ transaction_type: f[0], quantity: f[1], price: f[2], fee: f[3] || '0' })));
}
let c = contract({ resolution: 'YES' }, [['BUY', '100', '0.61']]);
eq('YES wins: 100 @ $0.61 → cost $61, settles $100, profit $39', [c.cost_basis, c.gross_payout, c.profit_loss, c.result, c.status], ['61', '100', '39', 'WIN', 'SETTLED']);
c = contract({ resolution: 'NO' }, [['BUY', '100', '0.61']]);
eq('YES loses: −$61', [c.gross_payout, c.profit_loss, c.result], ['0', '-61', 'LOSS']);
c = contract({ side: 'NO', resolution: 'NO' }, [['BUY', '100', '0.39']]);
eq('NO wins: 100 @ $0.39 → profit $61', [c.profit_loss, c.result], ['61', 'WIN']);
c = contract({ side: 'NO', resolution: 'YES' }, [['BUY', '100', '0.39']]);
eq('NO loses: −$39', c.profit_loss, '-39');
c = contract({ resolution: 'YES' }, [['BUY', '100', '0.61', '1.25']]);
eq('fees come out of a contract profit: $39 − $1.25', [c.profit_loss, c.fees], ['37.75', '1.25']);
c = contract({}, [['BUY', '100', '0.40'], ['BUY', '50', '0.70']]);
eq('multiple buys: average entry $0.50 on 150 contracts, cost $75', [c.average_entry_price, c.contracts, c.cost_basis, c.open_cost_basis, c.status], ['0.5', '150', '75', '75', 'OPEN']);
c = contract({ current_price: '0.66' }, [['BUY', '100', '0.40'], ['BUY', '50', '0.70'], ['SELL', '60', '0.65', '0.10']]);
eq('partial sell: 60 sold at $0.65 against a $0.50 average realizes $8.90 after fees; 90 stay open',
  [c.contracts, c.open_cost_basis, c.realized_profit_loss, c.profit_loss, c.status], ['90', '45', '8.9', null, 'OPEN']);
eq('…and the rest is marked at the reader\'s price: worth $59.40, unrealized +$14.40', [c.current_value, c.unrealized_profit_loss], ['59.4', '14.4']);
c = contract({}, [['BUY', '100', '0.61'], ['SELL', '100', '0.70']]);
eq('full sell closes it: +$9', [c.status, c.profit_loss, c.contracts, c.average_exit_price], ['SETTLED', '9', '0', '0.7']);
c = contract({ resolution: 'YES' }, [['BUY', '30', '0.52', '0.02'], ['BUY', '70', '0.58', '0.04'], ['SELL', '25', '0.75', '0.01']]);
eq('several fills, a partial sell, then resolution: $18.75 + $75 − $56.20 − $0.07 = $37.48', [c.profit_loss, c.gross_payout], ['37.48', '93.75']);
c = contract({ resolution: 'VOID' }, [['BUY', '100', '0.61']]);
eq('a voided market refunds at cost: $0', [c.status, c.profit_loss, c.result], ['VOID', '0', 'VOID']);
c = contract({ resolution: 'YES', settlement_price: '0.37' }, [['BUY', '100', '0.25']]);
eq('a scalar settlement price: 100 × $0.37 − $25 = $12', c.profit_loss, '12');
c = contract({ side: 'Chiefs', resolution: 'chiefs' }, [['BUY', '12.5', '0.444']]);
eq('an outcome-named market (case-insensitive): 12.5 × $1 − $5.55 = $6.95', [c.profit_loss, c.cost_basis], ['6.95', '5.55']);
c = contract({ resolution: 'YES', reported_payout: '99.5' }, [['BUY', '100', '0.61']]);
eq('a platform-reported settlement amount wins', c.profit_loss, '38.5');
c = contract({}, [['BUY', '3', '0.333333']]);
eq('sub-cent prices stay exact: 3 × $0.333333 = $0.999999', [c.cost_basis, c.average_entry_price], ['0.999999', '0.333333']);
c = contract({}, [['BUY', '100', '0.61']]);
eq('an open contract: if it resolves your way, $100 back, $39 profit', [c.potential_payout, c.potential_profit, c.current_value], ['100', '39', null]);
chk('a contract is never run through an odds formula', c.odds_decimal === null && c.potential_profit === '39');

/* ═══ 4. THE WHOLE BOOK ══════════════════════════════════════════════════ */
function row(over) {
  const base = Object.assign({ platform_type: 'SPORTSBOOK', platform: 'draftkings', platform_label: 'DraftKings', sport: 'NFL', position_type: 'SPREAD',
    placed_at: '2026-09-01T12:00:00Z', settled_at: '2026-09-01T20:00:00Z', status: 'WON', stake: '100', odds_american: -110 }, over);
  const fills = base._fills; delete base._fills;
  const out = Object.assign({}, base, E.derive(base, fills));
  if (out.status === 'OPEN') out.settled_at = null;
  return out;
}
const book = [
  row({}),                                                                                           /* DK  +90.91 */
  row({ status: 'LOST', settled_at: '2026-09-02T20:00:00Z' }),                                       /* DK  −100   */
  row({ platform: 'fanduel', platform_label: 'FanDuel', odds_american: 150, stake: '50', sport: 'NBA', position_type: 'MONEYLINE', settled_at: '2026-09-03T20:00:00Z' }), /* FD +75 */
  row({ platform: 'fanduel', platform_label: 'FanDuel', status: 'PUSH', sport: 'NBA', settled_at: '2026-09-03T21:00:00Z' }),  /* FD 0 */
  row({ status: 'OPEN', stake: '40', odds_american: 120 }),                                          /* DK open, 40 at risk */
  row({ platform_type: 'PREDICTION_MARKET', platform: 'kalshi', platform_label: 'Kalshi', sport: null, position_type: 'EVENT_CONTRACT', side: 'YES', resolution: 'YES',
    settled_at: '2026-09-04T12:00:00Z', _fills: [{ transaction_type: 'BUY', quantity: '100', price: '0.61', fee: '0.5' }] }),       /* Kalshi +38.50 */
  row({ platform_type: 'PREDICTION_MARKET', platform: 'kalshi', platform_label: 'Kalshi', sport: null, position_type: 'EVENT_CONTRACT', side: 'NO', status: 'OPEN', current_price: '0.30',
    _fills: [{ transaction_type: 'BUY', quantity: '50', price: '0.20' }, { transaction_type: 'SELL', quantity: '10', price: '0.35' }] })   /* open: 40 held, $8 cost, realized $1.50 */
];
const s = E.summarize(book, {});
eq('combined P&L = settled positions only: 90.91 − 100 + 75 + 0 + 38.50', s.pnl, '104.41');
eq('settled capital: 100 + 100 + 50 + 100 + 61', s.settledCapital, '411');
eq('ROI = P&L / settled capital', s.roi, '0.254039');
eq('capital deployed counts every position placed', s.capital, '461');
eq('open exposure: the open bet\'s stake plus the open contracts at cost', s.openExposure, '48');
eq('unrealized: 40 contracts marked at $0.30 against $8 cost', [s.unrealized, s.openMarked], ['4', 1]);
eq('a partial exit shows as realized-so-far, not in the total', s.openRealized, '1.5');
eq('record W-L-P (the push counts as a push)', E.recordText(s.record), '3-1-1');
eq('win rate = wins / (wins + losses)', s.winRate, '0.75');
eq('sportsbook P&L apart', [s.byType.SPORTSBOOK.pnl, s.byType.SPORTSBOOK.settled], ['65.91', 4]);
eq('prediction-market P&L apart', [s.byType.PREDICTION_MARKET.pnl, s.byType.PREDICTION_MARKET.settled, s.byType.PREDICTION_MARKET.open], ['38.5', 1, 1]);
eq('combined = sportsbook + prediction market', d.add(s.byType.SPORTSBOOK.pnl, s.byType.PREDICTION_MARKET.pnl), s.pnl);
eq('P&L by platform, best first', s.byPlatform.map((g) => [g.label, g.pnl]), [['FanDuel', '75'], ['Kalshi', '38.5'], ['DraftKings', '-9.09']]);
eq('best and worst platform', [s.platform.best.label, s.platform.worst.label], ['FanDuel', 'DraftKings']);
eq('P&L by sport keeps "no sport" apart and out of best/worst', [s.bySport.map((g) => g.key), s.sport.best.key, s.sport.worst.key], [['NBA', 'UNSPECIFIED', 'NFL'], 'NBA', 'NFL']);
eq('average stake over the sportsbook bets placed', s.averageStake, '78');
/* (3 × $100 × 1.909091 + $50 × 2.5 + $40 × 2.2) / $390 = 2.014685 → +101 */
eq('average odds: stake-weighted decimal, shown as American', [s.averageOddsDecimal, s.averageOddsAmerican], ['2.014685', 101]);
eq('average contract entry: total cost over contracts bought', s.averageEntryPrice, '0.473333');
eq('fees on settled positions', s.fees, '0.5');
eq('the cumulative series, one point per settled day', s.series.map((x) => [x.date, x.cumulative]), [['2026-09-01', '90.91'], ['2026-09-02', '-9.09'], ['2026-09-03', '65.91'], ['2026-09-04', '104.41']]);
const s7 = E.summarize(book, { from: Date.parse('2026-09-03T00:00:00Z') });
eq('a period counts the positions SETTLED in it', [s7.pnl, s7.settled], ['113.5', 3]);
eq('open exposure is always now, whatever the period', s7.openExposure, '48');
eq('an empty book', [E.summarize([], {}).pnl, E.summarize([], {}).roi, E.summarize([], {}).winRate], ['0', null, null]);
eq('timezones: an 11pm-Eastern settlement is that day in New York, the next in UTC',
  [E.series([row({ settled_at: '2026-09-02T03:00:00Z' })], { tz: 'America/New_York' })[0].date, E.series([row({ settled_at: '2026-09-02T03:00:00Z' })], { tz: 'UTC' })[0].date], ['2026-09-01', '2026-09-02']);
/* the calendar: settled, event and placed days kept apart */
const calBook = book.map((p, i) => Object.assign({ id: 'p' + i }, p));
calBook[4].event_start_at = '2026-09-05T00:30:00Z';             /* the open DK bet: 8:30pm Sep 4 in New York */
calBook[1].event_start_at = '2026-09-02T17:00:00Z';             /* the lost DK bet's game */
const cal = E.calendar(calBook, { tz: 'UTC' });
eq('calendar: one day per local date with any activity', cal.days.map((x) => x.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
eq('calendar: each day\'s settled P&L sums to the cumulative line', cal.days.filter((x) => x.settled).map((x) => [x.date, x.pnl]), s.series.map((x) => [x.date, x.pnl]));
eq('calendar: the month total is the book\'s settled P&L', [cal.pnl, cal.settled, E.recordText(cal.record)], [s.pnl, 5, '3-1-1']);
eq('calendar: placements land on the day placed, with their cost', [cal.days[0].placed, cal.days[0].staked], [7, '461']);
eq('calendar: an event day carries what is still open on it', [cal.days[4].events, cal.days[4].open, cal.days[4].exposure, cal.days[4].settled], [1, 1, '40', 0]);
eq('calendar: a settled position\'s event day is an event, not exposure', [cal.days[1].events, cal.days[1].open, cal.days[1].exposure], [1, 0, '0']);
eq('calendar: up, down and even days', [cal.up, cal.down, cal.even], [3, 1, 0]);
eq('calendar: best and worst day', [cal.best.date, cal.best.pnl, cal.worst.date, cal.worst.pnl], ['2026-09-01', '90.91', '2026-09-02', '-100']);
const calNY = E.calendar(calBook, { tz: 'America/New_York', month: '2026-09' });
chk('calendar: days are local — the 00:30Z event is Sep 4 in New York', calNY.days.some((x) => x.date === '2026-09-04' && x.open === 1) && !calNY.days.some((x) => x.date === '2026-09-05'));
eq('calendar: a month holds only its own days', E.calendar(calBook, { tz: 'UTC', month: '2026-08' }).days, []);
eq('calendar: every month with activity is listed, whatever month is asked for', E.calendar(calBook, { tz: 'UTC', month: '2026-01' }).months, ['2026-09']);
const calPM = E.calendar(calBook, { tz: 'UTC', kind: 'PREDICTION_MARKET' });
eq('calendar: by kind', [calPM.pnl, calPM.settled, calPM.days.filter((x) => x.settled).map((x) => x.date)], ['38.5', 1, ['2026-09-04']]);
eq('calendar: by platform', E.calendar(calBook, { tz: 'UTC', platform: 'fanduel' }).pnl, '75');
eq('calendar: one settled day has no best or worst to compare', [calPM.best, calPM.worst], [null, null]);
const sep = { from: E.zonedToUtc(2026, 9, 1, 0, 0, 0, 'America/New_York'), to: E.zonedToUtc(2026, 10, 1, 0, 0, 0, 'America/New_York'), tz: 'America/New_York' };
eq('calendar: a month\'s total is the same as a period summary over that month', calNY.pnl, E.summarize(calBook, sep).pnl);
eq('calendar: an empty book', [E.calendar([], { month: '2026-09' }).pnl, E.calendar([], {}).days, E.calendar([], {}).best], ['0', [], null]);
const ytd = E.periodRange('YTD', Date.parse('2026-10-04T12:00:00Z'), 'America/Chicago');
eq('YTD starts at midnight on 1 January in the reader\'s zone', new Date(ytd.from).toISOString(), '2026-01-01T06:00:00.000Z');
eq('7D and 30D are rolling', [E.periodRange('7D', 1e12).from, E.periodRange('30D', 1e12).from, E.periodRange('ALL', 1e12).from], [1e12 - 7 * 864e5, 1e12 - 30 * 864e5, null]);
eq('zonedToUtc across a DST change (Nov 1 2026, New York)', [new Date(E.zonedToUtc(2026, 11, 1, 0, 30, 0, 'America/New_York')).toISOString(), new Date(E.zonedToUtc(2026, 11, 2, 12, 0, 0, 'America/New_York')).toISOString()],
  ['2026-11-01T04:30:00.000Z', '2026-11-02T17:00:00.000Z']);

/* ═══ 5. VALIDATION ══════════════════════════════════════════════════════ */
const okW = { platform: 'draftkings', event_name: 'A @ B', market_name: 'Spread', selection: 'A -3', stake: '10', odds_american: '-110', placed_at: '2026-09-01T12:00:00Z', status: 'OPEN' };
eq('a valid wager has no issues', E.validateWager(okW), []);
const codes = (list) => list.map((x) => x.code).sort();
eq('missing pieces are named', codes(E.validateWager({ platform: 'Draft Kings', stake: '-1', odds_american: '50', status: 'NOPE' })),
  ['BAD_ODDS', 'BAD_ODDS', 'BAD_PLACED_AT', 'BAD_PLATFORM', 'BAD_STAKE', 'BAD_STATUS', 'MISSING_EVENT_NAME', 'MISSING_MARKET_NAME', 'MISSING_SELECTION']);
eq('a cash-out needs the amount paid', codes(E.validateWager(Object.assign({}, okW, { status: 'CASHED_OUT' }))), ['PAYOUT_NEEDED']);
eq('fractions of a cent are not a stake', codes(E.validateWager(Object.assign({}, okW, { stake: '10.005' }))), ['BAD_STAKE']);
eq('a future placement is refused', codes(E.validateWager(Object.assign({}, okW, { placed_at: '2099-01-01T00:00:00Z' }))), ['FUTURE_PLACED_AT']);
const okF = { platform: 'kalshi', event_name: 'Q?', market_name: 'Q?', side: 'YES', action: 'BUY', quantity: '10', price: '0.5', executed_at: '2026-09-01T12:00:00Z' };
eq('a valid fill has no issues', E.validateFill(okF), []);
eq('a price above $1 is not a contract price', codes(E.validateFill(Object.assign({}, okF, { price: '61' }))), ['BAD_PRICE']);
eq('a fill is a buy or a sell', codes(E.validateFill(Object.assign({}, okF, { action: 'HOLD' }))), ['BAD_ACTION']);

/* ═══ 6. FINGERPRINT MATERIAL ═══════════════════════════════════════════ */
eq('event text is normalized: case, spacing, "vs." / "at" / "@", accents, apostrophes',
  ['Chiefs vs. Bills', 'chiefs AT bills', 'Chiefs@Bills', 'Mbappé', "Ja'Marr Chase"].map(E.normText), ['chiefs @ bills', 'chiefs @ bills', 'chiefs @ bills', 'mbappe', 'jamarr chase']);
const m1 = E.wagerMaterial({ platform: 'draftkings', event_name: 'Chiefs vs. Bills', market_name: 'Spread', selection: 'Chiefs', line: '-2.5', odds_american: -110, stake: '100.00', placed_at: '2026-09-07T13:00:59-04:00' });
const m2 = E.wagerMaterial({ platform: 'DraftKings', event_name: 'chiefs @ bills', market_name: 'spread', selection: 'Chiefs -2.5', odds_american: '-110', stake: '100', placed_at: '2026-09-07T17:00:00Z' });
eq('the same bet from a form and from an export has one fingerprint', m1, m2);
chk('a different stake is a different bet', m1 !== E.wagerMaterial({ platform: 'draftkings', event_name: 'Chiefs vs. Bills', market_name: 'Spread', selection: 'Chiefs -2.5', odds_american: -110, stake: '101', placed_at: '2026-09-07T17:00:00Z' }));
chk('a different minute is a different bet', m1 !== E.wagerMaterial({ platform: 'draftkings', event_name: 'Chiefs vs. Bills', market_name: 'Spread', selection: 'Chiefs -2.5', odds_american: -110, stake: '100', placed_at: '2026-09-07T17:01:00Z' }));
eq('the material is stated in full', m1, 'pf1|wager|draftkings|chiefs @ bills|spread|chiefs -2.5|a-110|100|2026-09-07T17:00');
eq('a fill\'s material', E.fillMaterial({ platform: 'kalshi', event_name: 'Will X?', market_name: 'Will X?', side: 'yes', action: 'buy', quantity: '100.0', price: '0.610', executed_at: '2026-09-01T12:00:30Z' }),
  'pf1|fill|kalshi|will x?|will x?|yes|BUY|100|0.61|2026-09-01T12:00'.replace('will x?|will x?', 'will x|will x'));

/* ═══ 7. WORDS ON THE PAGE ══════════════════════════════════════════════ */
eq('money', [E.money('1284.22', { sign: true }), E.money('-482.13'), E.money('0'), E.money('1234567.5'), E.money(null)], ['+$1,284.22', '−$482.13', '$0.00', '$1,234,567.50', '—']);
eq('percentages', [E.pct('0.074'), E.pct('-0.084'), E.pct('0'), E.pct('0.75', 1, { plain: true })], ['+7.4%', '−8.4%', '0.0%', '75.0%']);
eq('prices and odds', [E.priceText('0.61'), E.priceText('0.555'), E.americanText(-110), E.americanText(150)], ['$0.61', '$0.555', '−110', '+150']);
eq('platform catalog keys reuse EdgeDesk\'s book keys', ['draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'betrivers', 'espnbet', 'fanatics'].map((k) => !!E.platform(k)), [true, true, true, true, true, true, true]);
eq('free text resolves to a key', ['DK', 'Caesars Sportsbook', 'kalshi.com', 'theScore Bet', 'Poly Market', 'Nowhere Book'].map(E.resolvePlatform), ['draftkings', 'williamhill_us', 'kalshi', 'espnbet', 'polymarket', null]);
eq('an "Other" platform gets a stable key', [E.customPlatformKey('My Local Book!'), E.customPlatformKey('Café Bets'), E.customPlatformKey('  ')], ['custom_my_local_book', 'custom_cafe_bets', null]);
chk('nothing in the catalog claims an automatic sync', E.PLATFORMS.every((p) => p.autoSync === false && p.methods.join() === 'MANUAL,CSV'));
chk('"Connected" is only the label of a CONNECTED status', E.ACCOUNT_STATUS_LABEL.MANUAL === 'Manual tracking' && E.ACCOUNT_STATUS_LABEL.IMPORT_ONLY === 'CSV import');

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio calc — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
