#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_bet_history.js (EDBETS) — "Why did I lose money on my recent
   bets, and were my singles or parlays more profitable?"

     - a Juice-Reel-style export with REPEATED PARLAY LEGS (a 3-leg parlay
       whose stake sits on 3 rows, a 2-leg SGP priced only by its legs,
       singles, a push, a void, a cash-out, a pending bet, an exported row
       repeated, a row with no ticket id, a ticket whose rows disagree, a
       placed-after-settled timestamp, an alt spread at -250): tickets, legs,
       risked, P&L and ROI to the cent, singles vs parlays, every breakdown,
       the worst day, the alt-line effect, closing-line value, data quality;
     - no double counting, ever: the stake of a 3-leg parlay counts once;
     - parity: a won parlay's P&L is EDPortfolio.parlay() pricing, and the
       stored-positions path (what row level security hands the page) gives
       the same figures as the CSV path;
     - 200 generated ticket sets: totals are the sum of per-ticket figures
       (checked against EDPortfolio.derive as an independent oracle), every
       breakdown sums to the total, and splitting each parlay into N leg rows
       (with duplicates and shuffling) never changes a total;
     - the answer: the right numbers, deterministic, and never chasing,
       "bet more" or forecasting language (checkLanguage is the guard);
     - the Analytics section renders it, escaped, with the caveat line.

   Run: node tools/portfolio/bet_history.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const I = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_import.js'));
const B = require(path.join(ROOT, 'lib', 'edgedesk_bet_history.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_ui.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const D = E.dec;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'juice_reel_style.csv'), 'utf8');
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const pick = (g) => g && { n: g.n, risked: g.risked, pnl: g.pnl, roi: g.roi };

/* ═══ 1. THE FIXTURE: leg rows → tickets ═════════════════════════════════ */
const src = B.fromCSV(CSV, { timezone: 'UTC', now: NOW });
const a = B.analyze(src, { tz: 'UTC' });
const T = (ref) => a.tickets.find((t) => t.ref === ref);
eq('22 rows read; 14 tickets, 21 legs (one duplicate row counted once)', [src.report.rowsRead, a.counts.tickets, a.counts.legs], [22, 14, 21]);
eq('9 singles, 5 parlays', [a.counts.singles, a.counts.parlays], [9, 5]);
eq('states kept apart: 10 settled, 1 cashed out, 1 pending, 1 void, 1 excluded', [a.counts.settled, a.counts.cashedOut, a.counts.open, a.counts.void, a.counts.excluded], [10, 1, 1, 1, 1]);
eq('the dedupe report: 7 leg rows joined into 5 multi-leg tickets, 1 duplicate row, 1 row with no id, 1 conflicting ticket',
  [a.dataQuality.dedupe.legRowsJoined, a.dataQuality.dedupe.multiLegTickets, a.dataQuality.dedupe.duplicateRows, a.dataQuality.dedupe.duplicateRowsExact, a.dataQuality.dedupe.noTicketId, a.dataQuality.dedupe.conflictedTickets],
  [7, 5, 1, 1, 1, 1]);
eq('the 3-leg parlay T1001 is ONE ticket with 3 legs and a $50.00 stake (not $150.00)', [T('T1001').kind, T('T1001').legs, T('T1001').stake, T('T1001').risked, T('T1001').pnl, T('T1001').rows], ['PARLAY', 3, '50.00', '50.00', '-50.00', [1, 2, 3]]);
const naive = I.parseCSV(CSV).rows.slice(1).filter((r) => /won|lost|push|cash/i.test(r[12])).reduce((s, r) => D.add(s, r[11]), '0');
chk('summing the stake column row by row would have said $' + naive + ' risked; EDBETS says $605.00', naive !== '605' && a.totals.risked === '605.00', naive);
eq('TOTALS to the cent: 11 counted tickets, risked $605.00, P&L −$183.55, ROI −0.303388',
  [a.totals.n, a.totals.risked, a.totals.pnl, a.totals.roi], [11, '605.00', '-183.55', '-0.303388']);
eq('record 3-6, 1 push, 1 cash-out; win rate 3 / 9', [a.totals.wins, a.totals.losses, a.totals.pushes, a.totals.cashouts, a.totals.winRate], [3, 6, 1, 1, '0.333333']);
eq('pending is open exposure ($60.00), not P&L; the void ($30.00) is left out', [a.totals.openExposure, T('T1008').pnl, T('T1008').state, a.totals.voidStake, T('T1006').state, T('T1006').pnl], ['60.00', null, 'OPEN', '30.00', 'VOID', null]);
eq('the cash-out counts at what the book paid: $25 on $40 is −$15.00', [T('T1007').state, T('T1007').pnl, T('T1007').result], ['CASHED_OUT', '-15.00', 'CASHOUT']);
eq('the push is $0.00 and in the risked total', [T('T1005').result, T('T1005').pnl, T('T1005').risked], ['PUSH', '0.00', '55.00']);
eq('the duplicated single T1003 is counted once: +$100.00 on $110.00', [T('T1003').pnl, T('T1003').risked, T('T1003').rows], ['100.00', '110.00', [6, 7]]);
eq('the parlay paid by the book: T1014 $36 back on $10 is +$26.00', T('T1014').pnl, '26.00');
eq('the row with no ticket id is its own single, flagged', [T('row 14').kind, T('row 14').pnl, a.dataQuality.issues.find((x) => x.code === 'NO_TICKET_ID').n], ['SINGLE', '-25.00', 1]);
eq('the ticket whose rows disagree on the stake ($30 / $35) is flagged and left out, never guessed',
  [T('T1011').state, T('T1011').excludedReason, T('T1011').pnl, a.dataQuality.excluded], ['EXCLUDED', 'TICKET_FIELDS_DIFFER', null, [{ ref: 'T1011', reason: 'TICKET_FIELDS_DIFFER', rows: [15, 16] }]]);
chk('…and its stake is in no total', a.totals.risked === '605.00' && !a.bySport.some((g) => g.tickets.indexOf('T1011') >= 0));

/* parity: a won parlay with no ticket price is priced by EDPortfolio.parlay */
const sgp = T('T1002'), px = E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: 150, result: 'WON' }]);
eq('the SGP priced only by its legs: −110 × +150 = 4.772728, $20 wins $75.45', [sgp.betType, sgp.legs, sgp.oddsDecimal, sgp.pnl], ['SAME_GAME_PARLAY', 2, '4.772728', '75.45']);
eq('…exactly EDPortfolio.parlay() pricing through EDPortfolio.wagerProfit()', D.fixed(E.wagerProfit('20', null, px.odds_decimal), 2), sgp.pnl);
eq('…and the same figure derive() (the database trigger\'s rule) stores', D.fixed(E.derive({ platform_type: 'SPORTSBOOK', stake: '20', odds_decimal: px.odds_decimal, status: 'WON' }).profit_loss, 2), '75.45');

/* singles vs parlays */
eq('singles: 7 tickets, risked $500.00, −$210.00, ROI −0.42, won 1 of 5', [a.singles.n, a.singles.risked, a.singles.pnl, a.singles.roi, a.singles.winRate], [7, '500.00', '-210.00', '-0.42', '0.2']);
eq('parlays: 4 tickets with 10 legs, risked $105.00, +$26.45, ROI 0.251905, won 2 of 4', [a.parlays.n, a.parlays.legs, a.parlays.risked, a.parlays.pnl, a.parlays.roi, a.parlays.winRate], [4, 10, '105.00', '26.45', '0.251905', '0.5']);
eq('singles + parlays = the total, to the cent', [D.add(a.singles.pnl, a.parlays.pnl), D.add(a.singles.risked, a.parlays.risked)], [D.str(a.totals.pnl), D.str(a.totals.risked)]);
eq('the comparison: parlays were more profitable per dollar, both samples small', [a.comparison.better, a.comparison.bothSmall], ['parlays', true]);
eq('pending and void are reported beside the singles they belong to', [a.singles.open, a.singles.openExposure, a.singles.void, a.parlays.excluded], [1, '60.00', 1, 1]);

/* breakdowns */
eq('by sport (worst first): MLB −$100.00 (1), NFL −$58.55 (9), NCAAF −$25.00 (1)', a.bySport.map((g) => [g.label, g.pnl, g.n]), [['MLB', '-100.00', 1], ['NFL', '-58.55', 9], ['NCAAF', '-25.00', 1]]);
eq('by market type: Moneyline −$185.00 (4) is the worst', pick(a.byMarketType[0]), { n: 4, risked: '210.00', pnl: '-185.00', roi: '-0.880952' });
eq('by market type, every group', a.byMarketType.map((g) => g.label + ' ' + g.pnl + ' n=' + g.n), ['Moneyline -185.00 n=4', 'Parlay -49.00 n=3', 'Spread -25.00 n=2', 'Total 0.00 n=1', 'Same-game parlay 75.45 n=1']);
eq('by price range', a.byOddsRange.map((g) => [g.key, g.n, g.risked, g.pnl]),
  [['LE_M200', 1, '125.00', '-125.00'], ['M199_M110', 3, '210.00', '55.00'], ['P101_P200', 3, '165.00', '-140.00'], ['P201_P500', 3, '55.00', '76.45'], ['GT_P500', 1, '50.00', '-50.00']]);
eq('by stake size', a.byStakeSize.map((g) => [g.label, g.n, g.pnl]), [['$10–$24.99', 2, '101.45'], ['$25–$49.99', 4, '-110.00'], ['$50–$99.99', 2, '-50.00'], ['$100–$249.99', 3, '-125.00']]);
chk('every group carries its n, and under 30 is labelled "small sample"', [a.totals, a.singles, a.parlays].concat(a.bySport, a.byMarketType, a.byOddsRange, a.byStakeSize)
  .every((g) => typeof g.n === 'number' && (g.n < 30 ? g.sample === 'small sample' && g.small === true : g.sample === null)));
['bySport', 'byMarketType', 'byOddsRange', 'byStakeSize', 'byBetType'].forEach((k) => {
  eq(k + ' sums to the total', [D.fixed(D.sum(a[k].map((g) => g.pnl)), 2), a[k].reduce((s, g) => s + g.n, 0)], [a.totals.pnl, a.totals.n]);
});

/* days */
eq('the worst day: 2026-09-20, −$100.00 on 1 ticket, 35.1% (0.350877) of $285.00 of losing-day losses',
  [a.days.worst.date, a.days.worst.pnl, a.days.worst.n, a.days.worst.share, a.days.totalLosses, a.days.losingDays], ['2026-09-20', '-100.00', 1, '0.350877', '285.00', 5]);
eq('days at or above the stated 25% share: 2026-09-20 and 2026-09-14 (26.3%)', [a.days.threshold, a.days.disproportionate.map((d) => [d.date, d.share])], ['0.25', [['2026-09-20', '0.350877'], ['2026-09-14', '0.263158']]]);
eq('the day list, in date order, sums to the total', [a.days.list.map((d) => d.date + ' ' + d.pnl), D.fixed(D.sum(a.days.list.map((d) => d.pnl)), 2)],
  [['2026-09-14 -75.00', '2026-09-20 -100.00', '2026-09-21 101.45', '2026-09-27 -25.00', '2026-09-28 0.00', '2026-10-02 -45.00', '2026-10-04 -40.00'], '-183.55']);
chk('the placed-after-settled ticket is dated by its placed day, and flagged', a.days.list.some((d) => d.date === '2026-10-02') && a.dataQuality.timestamps.settledBeforePlaced === 1
  && a.dataQuality.timestamps.tickets.SETTLED_BEFORE_PLACED[0] === 'T1012');
eq('a different stated share changes which days are named', B.analyze(src, { tz: 'UTC', lossDayShare: '0.30' }).days.disproportionate.map((d) => d.date), ['2026-09-20']);
eq('days follow the reader\'s zone: in Tokyo the 23:30 UTC settlements move to the next day', B.analyze(src, { tz: 'Asia/Tokyo' }).days.list.map((d) => d.date).slice(0, 2), ['2026-09-15', '2026-09-21']);

/* the alt-line effect */
const alt = a.altLines;
eq('alt lines: the −250 alt spread single and the parlay with two alt legs (−300 alt total, −400 alt spread)', [alt.singles.tickets, alt.parlays.tickets, alt.legs], [['T1009'], ['T1013'], 2]);
eq('…cost −$150.00 on $150.00 risked: 38.961% (0.38961) of the $385.00 lost on losing tickets', [alt.combined.n, alt.combined.risked, alt.combined.pnl, alt.losses, alt.grossLosses, alt.shareOfLosses], [2, '150.00', '-150.00', '150.00', '385.00', '0.38961']);
eq('…a −250 single needs 71.4286% to break even (0.714286); the alt legs average 77.5%', [alt.singlesBreakEven, alt.legsBreakEven], ['0.714286', '0.775']);
eq('the rule: alt spreads/totals at −200 or shorter, or a market called "alt"', [B.isAltLine('SPREAD', 'Spread', -250), B.isAltLine('TOTAL', 'Total', -200), B.isAltLine('SPREAD', 'Spread', -199),
  B.isAltLine('MONEYLINE', 'Moneyline', -400), B.isAltLine('PLAYER_PROP', 'Alternate Rushing Yards', 120), B.isAltLine('SPREAD', 'Salt Lake spread', -110), B.isAltLine('TOTAL', 'Total', null, '1.5')],
  [true, true, false, false, true, false, true]);

/* closing-line value */
eq('CLV from the closing column, singles only: 3 priced, 2 beat the close, average +2.7516%',
  [a.clv.available, a.clv.n, a.clv.beat, a.clv.worse, a.clv.average, a.clv.tickets.map((x) => x.ref + ' ' + x.clv)], [true, 3, 2, 1, '0.027516', ['T1003 0.021142', 'T1004 0.073171', 'T1009 -0.011765']]);
const noClose = B.analyze(B.fromCSV(CSV.split('\n').map((l) => l.split(',').slice(0, 14).join(',')).join('\n'), { timezone: 'UTC', now: NOW }));
chk('without a closing-price column, CLV is said to be not verifiable', noClose.clv.available === false && /not verifiable/.test(noClose.clv.note) && /not verifiable/.test(B.answer(noClose).text));
eq('…and nothing else changes', [noClose.totals.pnl, noClose.totals.risked], ['-183.55', '605.00']);

/* odds bands: American and decimal agree at every boundary */
eq('price bands at the boundaries (American)', [-200, -199, -110, -109, 100, 101, 200, 201, 500, 501].map((x) => B.oddsRangeKey(x)),
  ['LE_M200', 'M199_M110', 'M199_M110', 'M109_P100', 'M109_P100', 'P101_P200', 'P101_P200', 'P201_P500', 'P201_P500', 'GT_P500']);
eq('…and the same bands from exact decimal prices', ['1.5', '1.502513', '1.909091', '1.909090', '1.917431', '2', '2.01', '3', '3.01', '6', '6.01'].map((x) => B.oddsRangeKey(null, x)),
  ['LE_M200', 'M199_M110', 'M109_P100', 'M199_M110', 'M109_P100', 'M109_P100', 'P101_P200', 'P101_P200', 'P201_P500', 'P201_P500', 'GT_P500']);
eq('stake bands', ['9.99', '10', '24.99', '25', '100', '499.99', '500', '5000'].map(B.stakeBandKey), ['S0', 'S10', 'S10', 'S25', 'S100', 'S250', 'S500', 'S500']);

/* ═══ 2. TIMESTAMPS ══════════════════════════════════════════════════════ */
const TS = ['Bet ID,Placed,Settled,Book,Event,Selection,Odds,Stake,Status',
  'A1,,2026-09-10 20:00,DK,A @ B,A,-110,10,Lost',
  'A2,2026-12-25 12:00,2026-12-25 20:00,DK,C @ D,C,-110,10,Won',
  'A3,2026-09-12 12:00,2026-09-12 20:00,DK,E @ F,E,-110,10,Pending',
  'A4,2026-09-13 12:00,,DK,G @ H,G,+120,10,Lost',
  'A5,2026-09-14 20:00,2026-09-14 12:00,DK,I @ J,I,-110,10,Lost'].join('\n');
const ts = B.analyze(B.fromCSV(TS, { timezone: 'UTC', now: NOW })).dataQuality.timestamps;
eq('timestamps: a missing placed date, a future date, pending with a settled date, settled with no date, settled before placed',
  [ts.missingPlaced, ts.futureDates, ts.openWithSettled, ts.missingSettled, ts.settledBeforePlaced, ts.tickets.MISSING_PLACED_AT, ts.tickets.FUTURE_DATE, ts.tickets.OPEN_WITH_SETTLED_AT, ts.tickets.SETTLED_BEFORE_PLACED],
  [1, 1, 1, 1, 1, ['A1'], ['A2'], ['A3'], ['A5']]);
const tsAns = B.answer(B.analyze(B.fromCSV(TS, { timezone: 'UTC', now: NOW })));
chk('…and the answer names them', /Timestamps to check: 1 settled before it was placed; 1 with no placed date; 1 dated in the future; 1 pending with a settled date/.test(tsAns.text), tsAns.text);

/* ═══ 3. THE ANSWER ══════════════════════════════════════════════════════ */
const ans = B.answer(a);
const text = ans.text;
[['the loss and its base', /You lost \$183\.55 on 11 tickets that settled or were cashed out \(risked \$605\.00, ROI −30\.3%\)/],
  ['pending stated apart', /1 pending ticket \(\$60\.00 at risk\) is not counted until it settles/],
  ['singles, with their numbers', /Singles: −\$210\.00 on 7 tickets — risked \$500\.00, ROI −42\.0%, won 1 and lost 4 \(win rate 20\.0%\)/],
  ['parlays, with legs', /Parlays: \+\$26\.45 on 4 tickets with 10 legs — risked \$105\.00, ROI \+25\.2%/],
  ['the verdict', /Parlays were more profitable per dollar risked than singles \(ROI \+25\.2% against −42\.0%\)/],
  ['weak evidence when small', /Both samples are under 30 tickets, so this comparison is weak evidence/],
  ['the biggest drivers, from the analytics', /\(1\) Moneyline bets: −\$185\.00 on 4 tickets/],
  ['the alt lines as a driver, with their share', /Heavily juiced alternate lines: −\$150\.00 on 2 tickets \(risked \$150\.00, ROI −100\.0%\), 39\.0% of the money lost on losing tickets/],
  ['the worst day with its share', /Worst day: 2026-09-20, −\$100\.00 on 1 ticket — 35\.1% of the \$285\.00 lost across 5 losing days/],
  ['the other disproportionate day', /2026-09-14 \(−\$75\.00, 26\.3%\)/],
  ['the juice explained', /needs to win 71\.4% of the time just to break even/],
  ['the excluded ticket', /1 ticket left out[^.]*\(T1011\)/],
  ['the row with no id', /1 row had no ticket id and was counted as a single/],
  ['the duplicate', /1 duplicate row \(the same leg of the same ticket\) counted once/],
  ['the timestamp', /1 settled before it was placed/],
  ['CLV with its sample', /Closing-line value on 3 singles: beat the close on 2, average \+2\.8% \(small sample\)/],
  ['small sample overall', /under 30: a small sample/],
  ['never a forecast', /These figures describe your past results only; they do not predict future results\.$/]
].forEach((x) => chk('answer: ' + x[0], x[1].test(text), text));
chk('every money figure in the answer is one the analytics hold', (text.match(/[−+]?\$[\d,]+\.\d\d/g) || []).every((s) => {
  const v = D.str(s.replace('−', '-').replace(/[$,+]/g, ''));
  const pool = JSON.stringify(a).match(/"-?\d+\.\d\d"/g).map((q) => D.str(q.replace(/"/g, '')));
  return pool.indexOf(v) >= 0 || pool.indexOf(D.str(D.sub('0', v))) >= 0;
}), (text.match(/[−+]?\$[\d,]+\.\d\d/g) || []));
chk('the answer passes its own language guard', ans.language.ok && B.checkLanguage(text).ok, ans.language);
eq('deterministic: the same history gives the same answer, word for word', B.answer(B.analyze(B.fromCSV(CSV, { timezone: 'UTC', now: NOW }), { tz: 'UTC' })).text, text);
eq('the drivers are data, not prose: the worst three by P&L', ans.drivers.map((d) => [d.dimension, d.key, d.pnl]), [['market', 'MONEYLINE', '-185.00'], ['alt', 'ALT', '-150.00'], ['odds', 'P101_P200', '-140.00']]);
/* the guard itself */
const BAD = ['Bet bigger to win it back.', 'Raise your stakes to recover the losses.', 'You are due for a win.', 'Chase the loss tomorrow.', 'Double up next week to get even.',
  'Increase your unit size.', 'Parlays will be profitable from here.', 'You should win more if you keep going.', 'Recoup it on Sunday.', 'This is a sure thing.', 'Make it back on the late games.', 'Bigger bets on favourites.'];
eq('the guard catches chasing, stake-raising and forecasting language', BAD.map((s) => B.checkLanguage(s).ok), BAD.map(() => false));
eq('…and lets plain arithmetic through ("break even" as a price fact, "stake size" as a band)', ['At −250 a bet needs 71.4% to break even.', 'Stakes of $25–$49.99 lost $110.00.', 'They do not predict future results.'].map((s) => B.checkLanguage(s).ok), [true, true, true]);

/* an even or profitable book, and an empty one */
const WIN = ['Bet ID,Placed,Settled,Book,Event,Selection,Odds,Stake,Status', 'W1,2026-09-10 12:00,2026-09-10 20:00,DK,A @ B,A,+150,10,Won', 'W2,2026-09-11 12:00,2026-09-11 20:00,DK,C @ D,C,-110,11,Lost'].join('\n');
const wa = B.answer(B.analyze(B.fromCSV(WIN, { timezone: 'UTC', now: NOW })));
chk('a profitable book is not told it lost; its losing part is still named', /Overall you did not lose money: \+\$4\.00/.test(wa.text) && /No settled parlays to compare/.test(wa.text) && wa.language.ok, wa.text);
const ea = B.answer(B.analyze(B.fromCSV('Bet ID,Placed,Book,Event,Selection,Odds,Stake,Status\nP1,2026-10-10 12:00,DK,A @ B,A,-110,25,Pending', { timezone: 'UTC', now: NOW })));
chk('only pending tickets: nothing realized to explain, and the exposure stated', /no realized result to explain/.test(ea.text) && /\$25\.00 at risk/.test(ea.text) && ea.language.ok, ea.text);
const pe = B.analyze(B.fromCSV(CSV, { timezone: 'UTC', now: NOW }), { tz: 'UTC', from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2026-10-08T00:00:00Z') });
eq('a period keeps the tickets settled in it (and open ones, which are always now)', [pe.totals.n, pe.totals.pnl, pe.counts.open, pe.counts.excluded], [3, '-85.00', 1, 1]);

/* ═══ 4. STORED POSITIONS: the same analytics over RLS-read rows ═════════ */
/* what PostgREST hands the page: numerics as text, legs as JSON, the
   database's derived columns — built here exactly as the trigger derives them */
const staged = I.stage(CSV, { timezone: 'UTC', now: NOW });
let pid = 0;
const toRow = (n) => {
  const p = Object.assign({ id: 'pos-' + (++pid) }, n);
  delete p.closing_odds_american; delete p.closing_odds_decimal; delete p.kind;
  const d = E.derive(p);
  Object.keys(d).forEach((k) => { if (k !== 'status') p[k] = d[k] == null ? null : String(d[k]); });
  ['stake', 'reported_payout', 'odds_decimal'].forEach((k) => { if (p[k] != null) p[k] = String(p[k]); });
  return p;
};
const rows = staged.rows.filter((r) => !r.ticket.conflicts.length).map((r) => toRow(r.normalized));
const pa = B.analyze(B.fromPositions(rows), { tz: 'UTC' });
eq('positions: one row per ticket, legs from the legs jsonb', [pa.counts.tickets, pa.counts.legs, pa.counts.singles, pa.counts.parlays], [13, 19, 9, 4]);
eq('positions give the CSV path\'s figures to the cent', [pa.totals.n, pa.totals.risked, pa.totals.pnl, pa.totals.roi, pa.totals.openExposure, pick(pa.singles), pick(pa.parlays)],
  [a.totals.n, a.totals.risked, a.totals.pnl, a.totals.roi, a.totals.openExposure, pick(a.singles), pick(a.parlays)]);
eq('…and the same breakdowns, days and alt-line effect', [pa.bySport.map(pick), pa.byOddsRange.map(pick), pa.days.worst, pa.altLines.combined.pnl, pa.altLines.shareOfLosses],
  [a.bySport.map(pick), a.byOddsRange.map(pick), a.days.worst, a.altLines.combined.pnl, a.altLines.shareOfLosses]);
eq('the stored SGP and parlay types are read as parlays', ['SAME_GAME_PARLAY', 'PARLAY'].map((pt) => B.fromPositions([{ id: 'x', platform_type: 'SPORTSBOOK', position_type: pt, stake: '10', odds_american: 200, status: 'LOST', profit_loss: '-10' }]).tickets[0].kind), ['PARLAY', 'PARLAY']);
chk('stored positions have no closing price: CLV not verifiable', pa.clv.available === false);
const stored = B.fromPositions([
  { id: 's1', platform_type: 'SPORTSBOOK', position_type: 'PARLAY', stake: '10.00', odds_decimal: '6.5', status: 'SETTLED', reported_payout: '42.10', profit_loss: '32.10', legs: '[{"selection":"A","odds_american":-110},{"selection":"B","odds_american":150},{"selection":"C","market_name":"Alt Spread","position_type":"SPREAD","odds_american":-300}]' },
  { id: 's1', platform_type: 'SPORTSBOOK', position_type: 'PARLAY', stake: '10.00', odds_decimal: '6.5', status: 'SETTLED', profit_loss: '32.10' },
  { id: 'k1', platform_type: 'PREDICTION_MARKET', status: 'SETTLED', profit_loss: '5' },
  { id: 's2', platform_type: 'SPORTSBOOK', position_type: 'PARLAY', stake: '5', odds_american: 300, status: 'LOST', profit_loss: '-5', legs: null },
  { id: 's3', platform_type: 'SPORTSBOOK', position_type: 'MONEYLINE', stake: '20', odds_american: -120, status: 'WON', stake_type: 'BONUS', cost_basis: '0', profit_loss: '16.67' }]);
const sa = B.analyze(stored);
eq('stored rows: the stored P&L is used (a re-priced SETTLED parlay), a repeated id counts once, a prediction market is set apart, a parlay without legs is said to be so',
  [sa.totals.n, sa.totals.pnl, stored.report.duplicateIds, stored.report.predictionMarket, stored.report.legsUnknown, sa.counts.legsUnknown], [3, '43.77', 1, 1, 1, 1]);
eq('legs jsonb as text is read; the alt leg inside it is found', [stored.tickets[0].legCount, stored.tickets[0].altLegs], [3, 1]);
eq('a bonus bet risks no cash: risked is its cost basis ($0)', [sa.totals.risked, sa.singles.risked], ['15.00', '0.00']);

/* ═══ 5. 200 GENERATED TICKET SETS ═══════════════════════════════════════ */
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const choose = (r, list) => list[Math.floor(r() * list.length)];
const american = (r) => (r() < 0.5 ? -int(r, 100, 450) : int(r, 100, 900));
const signed = (x) => (x > 0 ? '+' + x : String(x));
const HEAD = 'Bet ID,Date Placed,Date Settled,Sportsbook,Sport,Bet Type,Event,Market,Selection,Leg Odds,Odds,Stake,Status,Payout';
const STATUS = { Won: 'WON', Lost: 'LOST', Push: 'PUSH', Void: 'VOID', 'Cashed Out': 'CASHED_OUT', Pending: 'OPEN' };
function genSet(r, set) {
  const tickets = [], n = int(r, 1, 14);
  for (let i = 0; i < n; i++) {
    /* a row with no ticket id cannot be grouped, so only a single goes without one */
    const noId = r() < 0.08, parlay = !noId && r() < 0.45, legs = parlay ? int(r, 2, 5) : 1, status = choose(r, ['Won', 'Won', 'Lost', 'Lost', 'Lost', 'Push', 'Void', 'Cashed Out', 'Pending']);
    const legOdds = Array.from({ length: legs }, () => american(r));
    const odds = parlay ? E.parlay(legOdds.map((x) => ({ odds_american: x }))).odds_american : legOdds[0];
    const stake = (int(r, 100, 50000) / 100).toFixed(2), day = String(int(r, 1, 28)).padStart(2, '0');
    let payout = '';
    if (status === 'Cashed Out') payout = (int(r, 0, Math.round(+stake * 200)) / 100).toFixed(2);
    else if (status === 'Won' && r() < 0.5) payout = D.add(stake, E.wagerProfit(stake, odds));
    else if (status === 'Lost' && r() < 0.5) payout = '0';
    else if ((status === 'Push' || status === 'Void') && r() < 0.5) payout = stake;
    const market = choose(r, ['Moneyline', 'Spread', 'Total', 'Alt Spread', 'Player Prop', 'Alt Total']);
    tickets.push({ id: noId ? '' : 'G' + set + '-' + i, parlay, legs, legOdds, odds, stake, status, payout, sport: choose(r, ['NFL', 'NBA', 'MLB', 'NHL']),
      placed: '2026-09-' + day + ' 12:00', settled: status === 'Pending' ? '' : '2026-09-' + day + ' 23:00', market });
  }
  return tickets;
}
const cellOf = (t, extra) => [t.id, t.placed, t.settled, 'DraftKings', t.sport].concat(extra, [signed(t.odds), t.stake, t.status, t.payout]).join(',');
function oneRowPerTicket(ts) {
  return [HEAD].concat(ts.map((t) => cellOf(t, t.parlay ? ['Parlay', 'Parlay ' + t.id, 'Parlay', t.legOdds.map((x, k) => 'Pick' + k).join(' + '), ''] : ['Straight', 'Game ' + t.id, t.market, 'Side ' + t.id, signed(t.legOdds[0])]))).join('\n');
}
function legRows(ts, r) {
  let lines = [];
  ts.forEach((t) => {
    if (!t.parlay) { lines.push(cellOf(t, ['Straight', 'Game ' + t.id, t.market, 'Side ' + t.id, signed(t.legOdds[0])])); return; }
    t.legOdds.forEach((x, k) => lines.push(cellOf(t, ['Parlay', 'Game ' + t.id + ' leg ' + k, k === 0 ? t.market : 'Moneyline', 'Pick' + k, signed(x)])));
  });
  /* exported twice (same ticket, same leg) — only where there is an id to say so */
  const dup = lines.filter((l) => !/^,/.test(l));
  for (let k = 0; k < int(r, 0, 3) && dup.length; k++) lines.push(choose(r, dup));
  for (let k = lines.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); const tmp = lines[k]; lines[k] = lines[j]; lines[j] = tmp; }
  return [HEAD].concat(lines).join('\n');
}
function oracle(ts) {
  let pnl = '0', risked = '0', open = '0', n = 0;
  ts.forEach((t) => {
    const st = STATUS[t.status];
    if (st === 'OPEN') { open = D.add(open, t.stake); return; }
    if (st === 'VOID') return;
    const d = E.derive({ platform_type: 'SPORTSBOOK', stake: t.stake, odds_american: t.odds, status: st, reported_payout: t.payout === '' ? null : t.payout });
    pnl = D.add(pnl, d.profit_loss); risked = D.add(risked, t.stake); n++;
  });
  return { n, pnl: D.fixed(pnl, 2), risked: D.fixed(risked, 2), open: D.fixed(open, 2) };
}
const r = rng(20261012);
let bad = { sum: [], split: [], dims: [], oracle: [], lang: [], parity: [] }, naiveWrong = 0;
for (let set = 0; set < 200; set++) {
  const ts = genSet(r, set);
  const A1 = B.analyze(B.fromCSV(oneRowPerTicket(ts), { timezone: 'UTC', now: NOW }), { tz: 'UTC' });
  const legCsv = legRows(ts, r);
  const A2 = B.analyze(B.fromCSV(legCsv, { timezone: 'UTC', now: NOW }), { tz: 'UTC' });
  const o = oracle(ts);
  /* the control: what summing the leg rows' stakes would have said */
  const naiveRisk = I.parseCSV(legCsv).rows.slice(1).filter((x) => /won|lost|push|cash/i.test(x[12])).reduce((acc, x) => D.add(acc, x[11]), '0');
  if (D.fixed(naiveRisk, 2) !== o.risked) naiveWrong++;
  [A1, A2].forEach((x) => {
    const counted = x.tickets.filter((t) => t.state === 'SETTLED' || t.state === 'CASHED_OUT');
    if (D.fixed(D.sum(counted.map((t) => t.pnl)), 2) !== x.totals.pnl || D.fixed(D.sum(counted.map((t) => t.risked)), 2) !== x.totals.risked || counted.length !== x.totals.n) bad.sum.push(set);
    ['bySport', 'byMarketType', 'byOddsRange', 'byStakeSize', 'byBetType'].forEach((k) => { if (D.fixed(D.sum(x[k].map((g) => g.pnl)), 2) !== x.totals.pnl) bad.dims.push(set + ':' + k); });
    if (D.fixed(D.sum(x.days.list.map((g) => g.pnl)), 2) !== x.totals.pnl || D.fixed(D.add(x.singles.pnl, x.parlays.pnl), 2) !== x.totals.pnl) bad.dims.push(set + ':days/kinds');
    if (x.totals.n !== o.n || x.totals.pnl !== o.pnl || x.totals.risked !== o.risked || x.totals.openExposure !== o.open) bad.oracle.push({ set, got: [x.totals.n, x.totals.pnl, x.totals.risked, x.totals.openExposure], want: o });
    const an = B.answer(x);
    if (!an.language.ok) bad.lang.push({ set, hits: an.language.hits });
  });
  const keyOf = (x) => JSON.stringify([x.counts.tickets, x.totals.n, x.totals.risked, x.totals.pnl, x.totals.roi, x.totals.openExposure, x.totals.wins, x.totals.losses, x.singles.pnl, x.parlays.pnl, x.parlays.n, x.days.worst]);
  if (keyOf(A1) !== keyOf(A2)) bad.split.push({ set, one: keyOf(A1), legs: keyOf(A2) });
  /* a won parlay priced by its legs alone */
  const legsOnly = ts.filter((t) => t.parlay && t.id);
  if (legsOnly.length) {
    const t = legsOnly[0], csvW = [HEAD].concat(t.legOdds.map((x, k) => [t.id, t.placed, '2026-09-28 23:00', 'DraftKings', t.sport, 'Parlay', 'Game ' + k, 'Moneyline', 'Pick' + k, signed(x), '', t.stake, 'Won', ''].join(','))).join('\n');
    const w = B.analyze(B.fromCSV(csvW, { timezone: 'UTC', now: NOW }));
    const want = D.fixed(E.wagerProfit(t.stake, null, E.parlay(t.legOdds.map((x) => ({ odds_american: x, result: 'WON' }))).odds_decimal), 2);
    if (w.totals.pnl !== want || w.parlays.legs !== t.legs) bad.parity.push({ set, got: w.totals.pnl, want });
  }
}
chk('200 sets: totals are exactly the sum of the per-ticket figures', bad.sum.length === 0, bad.sum.slice(0, 5));
chk('200 sets: every breakdown (sport, market, price, stake, bet type, day, singles/parlays) sums to the total', bad.dims.length === 0, bad.dims.slice(0, 5));
chk('200 sets: totals equal an independent EDPortfolio.derive() oracle, to the cent', bad.oracle.length === 0, bad.oracle.slice(0, 3));
chk('200 sets: splitting every parlay into N leg rows (duplicated, shuffled) never changes a total', bad.split.length === 0, bad.split.slice(0, 2));
chk('…where summing the leg rows naively would have been wrong in most sets (' + naiveWrong + ' of 200)', naiveWrong > 120, naiveWrong);
chk('200 sets: a won parlay priced by its legs equals EDPortfolio.parlay() pricing', bad.parity.length === 0, bad.parity.slice(0, 3));
chk('400 answers: none uses chasing, stake-raising or forecasting language', bad.lang.length === 0, bad.lang.slice(0, 3));

/* ═══ 6. THE DASHBOARD SECTION (rendered in Node) ═══════════════════════ */
const S = Object.assign(U.defaults(), { positions: rows, accounts: [], tz: 'UTC', now: NOW, period: 'ALL' });
const html = U.render.lossPatterns(S), view = strip(html);
chk('Analytics carries "What cost you money"', /What cost you money · all time/i.test(view) && /data-r="loss-patterns"/.test(html), view.slice(0, 200));
chk('…the headline from the analytics', /You lost \$183\.55 on 11 tickets/.test(view));
chk('…singles vs parlays side by side, with n and legs', /Singles Parlays Tickets 7 4 Legs 7 10 Risked \$500\.00 \$105\.00 P&L −\$210\.00 \+\$26\.45 ROI −42\.0% \+25\.2%/.test(view), view.slice(0, 900));
chk('…the worst segments with their n and the small-sample label', /Moneyline Market type · n=4 · ROI −88\.1% · small sample −\$185\.00/.test(view), view);
chk('…the worst day and its share', /Worst day: 2026-09-20, −\$100\.00 on 1 ticket — 35\.1%/.test(view));
chk('…the alt-line effect', /Together: −\$150\.00 on 2 tickets, 39\.0% of the money lost on losing tickets/.test(view));
chk('…data quality (CLV not verifiable on stored rows)', /Data quality/.test(view) && /not verifiable/.test(view));
chk('…and the caveat line', /These figures describe your past results only; they do not predict future results\. This covers the sportsbook tickets on this page/.test(view));
chk('the section passes the language guard', B.checkLanguage(view).ok, B.checkLanguage(view).hits);
chk('the full Analytics tab includes it once', (strip(U.render.analytics(S)).match(/What cost you money/g) || []).length === 1);
chk('a period with nothing settled says so, with the exposure', /nothing realized to explain yet/.test(strip(U.render.lossPatterns(Object.assign({}, S, { period: '7D', now: Date.parse('2026-12-20T12:00:00Z') })))));
chk('prediction markets only: the section says it reads sportsbook tickets', /read sportsbook tickets/.test(strip(U.render.lossPatterns(Object.assign({}, S, { platform: 'type:PREDICTION_MARKET' })))));
const evil = '<img src=x onerror=alert(1)>';
const hostile = U.render.lossPatterns(Object.assign({}, S, { positions: rows.map((p) => Object.assign({}, p, { sport: evil, market_name: evil, event_name: evil })) }));
chk('nothing a file said becomes markup', !/<img/i.test(hostile) && /&lt;img/i.test(hostile));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'bet history — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
