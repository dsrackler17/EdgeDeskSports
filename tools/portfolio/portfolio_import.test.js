#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_import.js and lib/edgedesk_portfolio_connectors.js.

   The CSV reader (quotes, delimiters, line endings, a BOM), every cell reader
   (money, odds, contract prices, dates in a chosen zone, statuses, sides),
   both generic adapters end to end, format detection, the refusals that must
   never become guesses, and the connector contract every future integration
   has to satisfy. What the DATABASE then does with the staged rows —
   duplicates, review, commit — is tools/portfolio/portfolio_sql.test.js.

   Run: node tools/portfolio/portfolio_import.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', '..', 'lib');
const E = require(path.join(LIB, 'edgedesk_portfolio.js'));
const I = require(path.join(LIB, 'edgedesk_portfolio_import.js'));
const C = require(path.join(LIB, 'edgedesk_portfolio_connectors.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function eq(name, got, want) { chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }
const codes = (r) => r.issues.map((x) => x.level + ':' + x.code);

/* ═══ 1. CSV ═════════════════════════════════════════════════════════════ */
eq('quoted commas, doubled quotes, CRLF, a BOM and a trailing newline',
  I.parseCSV('﻿a,b,c\r\n"x, y","say ""hi""",3\r\n').rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', '3']]);
eq('a newline inside quotes stays in the cell', I.parseCSV('a,b\n"line 1\nline 2",x\n').rows, [['a', 'b'], ['line 1\nline 2', 'x']]);
eq('semicolon-delimited files are detected', I.parseCSV('a;b\n1;2').delimiter, ';');
eq('tab-delimited files are detected', I.parseCSV('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
eq('blank lines are dropped', I.parseCSV('a\n\n1\n,\n').rows, [['a'], ['1']]);

/* ═══ 2. CELLS ═══════════════════════════════════════════════════════════ */
eq('money', ['$1,234.56', '(12.00)', '-12', 'USD 40', '100'].map((x) => I.readMoney(x).value), ['1234.56', '-12', '-12', '40', '100']);
eq('a decimal comma is refused, never guessed', I.readMoney('12,50').error, 'AMBIGUOUS_DECIMAL');
eq('odds: American with or without a sign, EVEN, decimal, fractional',
  ['-110', '+150', '150', 'EVEN', '1.91', '2', '5/2'].map((x) => { const r = I.readOdds(x); return r.american != null ? 'a' + r.american : 'd' + r.decimal; }),
  ['a-110', 'a150', 'a150', 'a100', 'd1.91', 'd2', 'd3.5']);
eq('odds that are not odds', ['-50', '+50', '1', 'abc', '0.5'].map((x) => I.readOdds(x).error || 'ok'), ['BAD_ODDS', 'BAD_ODDS', 'BAD_ODDS', 'BAD_ODDS', 'BAD_ODDS']);
eq('an unsigned "50" is decimal 50.00 (a longshot) …', I.readOdds('50').decimal, '50');
eq('… and the adapter sends that row to review rather than trusting it', codes(I.stage('Date,Book,Event,Selection,Odds,Stake\n2026-09-07 13:00,DK,A @ B,A,50,10\n', {}).rows[0]).filter((c) => /^warning/.test(c)), ['warning:ODDS_AMBIGUOUS']);
eq('contract prices: dollars, cents with ¢ or c, cents by column', ['0.61', '$0.61', '61¢', '61c'].map((x) => I.readPrice(x).value).concat([I.readPrice('61', true).value]), ['0.61', '0.61', '0.61', '0.61', '0.61']);
eq('a price above $1 is refused', I.readPrice('61').error, 'BAD_PRICE');
eq('statuses', ['W', 'won', 'Loss', 'push', 'Cancelled', 'cash out', 'pending', '', 'graded'].map((x) => I.readStatus(x).value),
  ['WON', 'WON', 'LOST', 'PUSH', 'VOID', 'CASHED_OUT', 'OPEN', 'OPEN', 'SETTLED']);
eq('an unknown status is reported, not guessed', I.readStatus('half-won').error, 'BAD_STATUS');
eq('sides', ['y', 'Yes', 'NO', 'Chiefs'].map(I.readSide), ['YES', 'YES', 'NO', 'Chiefs']);
eq('market types from text', ['Moneyline', 'Point Spread', 'Total Points', 'Player Passing Yards Over', '3-leg Parlay', 'SGP', 'Super Bowl winner — futures', 'Something else'].map(I.inferType),
  ['MONEYLINE', 'SPREAD', 'TOTAL', 'PLAYER_PROP', 'PARLAY', 'SAME_GAME_PARLAY', 'FUTURE', 'OTHER']);

/* dates and zones */
const at = (x, tz, o) => I.readDate(x, tz, o).value;
eq('an explicit offset is read exactly, whatever zone is chosen', [at('2026-09-07T13:00:00-04:00', 'Asia/Tokyo'), at('2026-09-07 17:00Z', 'America/Chicago')],
  ['2026-09-07T17:00:00.000Z', '2026-09-07T17:00:00.000Z']);
eq('a naive time is read in the chosen zone', [at('2026-09-07 13:00', 'America/New_York'), at('2026-09-07 13:00', 'America/Chicago'), at('2026-09-07 13:00', 'UTC')],
  ['2026-09-07T17:00:00.000Z', '2026-09-07T18:00:00.000Z', '2026-09-07T13:00:00.000Z']);
eq('the same instant written in three zones is one instant', new Set([at('2026-09-07T13:00:00-04:00'), at('2026-09-07 12:00', 'America/Chicago'), at('2026-09-07 17:00', 'UTC')]).size, 1);
eq('US dates with 12-hour times', at('09/08/2026 8:15 PM', 'America/New_York'), '2026-09-09T00:15:00.000Z');
eq('day-first when chosen', at('08/09/2026 20:15', 'UTC', 'DMY'), '2026-09-08T20:15:00.000Z');
eq('a date that only reads day-first is refused under month-first, with the reason', I.readDate('13/02/2026', 'UTC', 'MDY').error, 'BAD_DATE_ORDER');
eq('month names', at('Sep 7, 2026 1:00 PM', 'UTC'), '2026-09-07T13:00:00.000Z');
eq('a date with no time is midday, so no zone moves it to another day', [I.readDate('2026-09-07', 'America/Los_Angeles').value, I.readDate('2026-09-07', 'UTC').dateOnly], ['2026-09-07T19:00:00.000Z', true]);
eq('impossible dates are refused', ['2026-02-30', '2026-13-01', '31/04/2026'].map((x) => I.readDate(x, 'UTC', 'DMY').error || 'ok'), ['BAD_DATE', 'BAD_DATE', 'BAD_DATE']);
eq('across the November DST change', at('2026-11-01 01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');

/* ═══ 3. THE SPORTSBOOK ADAPTER ═════════════════════════════════════════ */
const SB = [
  'Date Placed,Sportsbook,Sport,Event,Market,Selection,Odds,Stake,Result,Payout,Bet ID',
  '2026-09-07 13:00,DraftKings,NFL,Chiefs @ Bills,Spread,Chiefs -2.5,-110,100,Won,190.91,DK1',
  '09/08/2026 8:15 PM,FD,NFL,"Jets, Giants",Moneyline,Jets,+150,"$1,000.00",Lost,,FD2',
  '2026-09-09,Caesars,NBA,Lakers vs Celtics,Total,Over 220.5,1.91,50,pending,,',
  '2026-09-10 10:00,DraftKings,NFL,Chiefs @ Bills,Spread,Chiefs -2.5,-110,"12,50",Won,,',
  '2026-09-11 10:00,BetMGM,MLB,Mets @ Braves,Run line,Mets +1.5,-150,30,Won,99,',
  '2026-09-12 10:00,Corner Book,NFL,A @ B,Moneyline,A,-110,20,Cashed out,,'
].join('\n');
let st = I.stage(SB, { timezone: 'America/New_York' });
eq('detected as sportsbook bets', [st.adapter, st.platformType], ['generic_sportsbook_v1', 'SPORTSBOOK']);
eq('columns mapped by name', [st.map.placed_at, st.map.platform, st.map.event_name, st.map.selection, st.map.odds, st.map.stake, st.map.status, st.map.payout, st.map.external_id],
  ['Date Placed', 'Sportsbook', 'Event', 'Selection', 'Odds', 'Stake', 'Result', 'Payout', 'Bet ID']);
let n = st.rows[0].normalized;
eq('row 1 normalized', [n.kind, n.platform, n.placed_at, n.odds_american, n.stake, n.status, n.reported_payout, n.external_position_id, n.position_type, n.line],
  ['wager', 'draftkings', '2026-09-07T17:00:00.000Z', -110, '100', 'WON', '190.91', 'DK1', 'SPREAD', '-2.5']);
eq('a settled row with no settled time is recorded at its placed time, never "today"', [n.settled_at, codes(st.rows[0]).indexOf('info:SETTLED_AT_PLACED') >= 0], ['2026-09-07T17:00:00.000Z', true]);
n = st.rows[1].normalized;
eq('row 2: abbreviation, US date, quoted comma, $1,000.00', [n.platform, n.placed_at, n.event_name, n.stake, n.status], ['fanduel', '2026-09-09T00:15:00.000Z', 'Jets, Giants', '1000', 'LOST']);
n = st.rows[2].normalized;
eq('row 3: decimal odds, open, date only', [n.platform, n.odds_decimal, n.status, n.settled_at, codes(st.rows[2]).indexOf('info:DATE_ONLY') >= 0], ['williamhill_us', '1.91', 'OPEN', undefined, true]);
eq('row 4: a decimal comma makes the row invalid', codes(st.rows[3]).filter((c) => /^error/.test(c)), ['error:AMBIGUOUS_DECIMAL']);
eq('row 5: a payout that disagrees with the price is flagged for review, and the book\'s figure is kept', [codes(st.rows[4]).filter((c) => /^warning/.test(c)), st.rows[4].normalized.reported_payout], [['warning:PAYOUT_MISMATCH'], '99']);
eq('row 6: an unknown book becomes the reader\'s own platform; a cash-out with no amount is invalid', [st.rows[5].normalized.platform, st.rows[5].normalized.platform_label, codes(st.rows[5]).filter((c) => /^error/.test(c))],
  ['custom_corner_book', 'Corner Book', ['error:PAYOUT_NEEDED']]);
eq('local counts before the server sees anything', I.localCounts(st.rows), { total: 6, ok: 3, review: 1, invalid: 2 });
chk('every row carries its raw cells for review', st.rows.every((r) => r.raw && r.raw['Bet ID'] !== undefined));
st = I.stage('Date,Event,Selection,Odds,Stake\n2026-09-07 13:00,A @ B,A,-110,10\n', { platform: 'betmgm' });
eq('a file without a platform column takes the one the reader chose', [st.rows[0].normalized.platform, st.rows[0].normalized.platform_label, st.rows[0].issues.filter((x) => x.level === 'error').length], ['betmgm', 'BetMGM', 0]);
st = I.stage('Date,Event,Selection,Odds,Stake\n2026-09-07 13:00,A @ B,A,-110,10\n', {});
chk('…and without either, the file says so and the row is invalid', st.fileIssues.some((x) => x.code === 'NO_PLATFORM') && codes(st.rows[0]).indexOf('error:BAD_PLATFORM') >= 0);
st = I.stage(SB, { timezone: 'America/New_York', map: Object.assign({}, I.stage(SB, {}).map, { stake: undefined }) });
chk('re-mapping a column changes what is read (unmapped stake → every row invalid)', st.rows.every((r) => codes(r).indexOf('error:BAD_STAKE') >= 0) && st.fileIssues.some((x) => x.code === 'UNMAPPED_STAKE'));
eq('a header-only file is refused', I.stage('a,b,c\n', {}).fileIssues[0].code, 'NO_ROWS');
const big = 'Date,Event,Selection,Odds,Stake\n' + new Array(5002).fill('2026-09-07 13:00,A @ B,A,-110,10').join('\n');
chk('more than 5000 rows is refused with the limit stated', I.stage(big, { platform: 'betmgm' }).fileIssues.some((x) => x.code === 'TOO_MANY_ROWS'));
const dup = I.stage('Date,Book,Event,Selection,Odds,Stake\n2026-09-07 13:00,DK,A @ B,A,-110,10\n2026-09-07 13:00,DK,A @ B,A,-110,10\n', {});
eq('duplicate CSV rows produce identical fingerprint material (the server marks the second DUPLICATE_IN_FILE)',
  E.wagerMaterial(dup.rows[0].normalized), E.wagerMaterial(dup.rows[1].normalized));

/* ═══ 4. THE PREDICTION-MARKET ADAPTER ══════════════════════════════════ */
const PM = [
  'Date,Platform,Question,Side,Action,Contracts,Price,Fee,Resolution,Trade ID',
  '2026-09-01T12:00:00Z,Kalshi,Will X happen?,Yes,Buy,100,61,0.07,,T1',
  '2026-09-02T12:00:00Z,Kalshi,Will X happen?,Yes,Sell,40,70,0.03,,T2',
  '2026-09-03T12:00:00Z,Kalshi,Will X happen?,Yes,Buy,10,55,0,YES,T3'
].join('\n');
st = I.stage(PM, {});
eq('detected as prediction-market trades', [st.adapter, st.platformType], ['generic_prediction_market_v1', 'PREDICTION_MARKET']);
chk('prices that are all whole numbers 1-99 are read as cents, and the file says so', st.priceCents && st.fileIssues.some((x) => x.code === 'PRICES_IN_CENTS'));
eq('every trade normalized', st.rows.map((r) => [r.normalized.action, r.normalized.quantity, r.normalized.price, r.normalized.side, r.normalized.external_transaction_id]),
  [['BUY', '100', '0.61', 'YES', 'T1'], ['SELL', '40', '0.7', 'YES', 'T2'], ['BUY', '10', '0.55', 'YES', 'T3']]);
eq('the resolution, with its time taken from the trade that carries it', [st.rows[2].normalized.resolution, st.rows[2].normalized.settled_at], ['YES', '2026-09-03T12:00:00.000Z']);
eq('one market and side: one group key', new Set(st.rows.map((r) => E.contractKey(r.normalized))).size, 1);
const fills = st.rows.map((r) => ({ transaction_type: r.normalized.action, quantity: r.normalized.quantity, price: r.normalized.price, fee: r.normalized.fee }));
const pos = E.derive({ platform_type: 'PREDICTION_MARKET', side: 'YES', resolution: 'YES' }, fills);
eq('and the position those trades build: 70 × $1 + $28 − $66.50 − $0.10', [pos.profit_loss, pos.contracts, pos.average_entry_price], ['31.4', '70', '0.604545']);
st = I.stage('Date,Platform,Question,Side,Contracts,Price\n2026-09-01T12:00:00Z,Polymarket,Who wins?,Chiefs,12.5,0.444\n2026-09-01T13:00:00Z,Polymarket,Who wins?,Chiefs,1,61\n', {});
chk('a mixed price column is not cents: the $61 row is refused', !st.priceCents && codes(st.rows[1]).indexOf('error:BAD_PRICE') >= 0 && st.rows[0].normalized.price === '0.444');
eq('no action column means a buy; an outcome name is a side', [st.rows[0].normalized.action, st.rows[0].normalized.side], ['BUY', 'Chiefs']);

/* ═══ 5. THE CONNECTOR CONTRACT ═════════════════════════════════════════ */
eq('the seven methods', C.METHODS, ['connect', 'disconnect', 'healthCheck', 'sync', 'fetchPositions', 'fetchTransactions', 'normalize']);
eq('only the connectors that exist are registered', C.list().map((c) => c.key), ['manual', 'csv']);
chk('neither claims automatic sync', C.list().every((c) => c.capabilities.autoSync === false));
chk('both implement the whole contract', C.list().every((c) => C.METHODS.every((m) => typeof c[m] === 'function')));
eq('manual and CSV say what they are', [C.get('manual').connect().status, C.get('csv').connect().status, C.get('manual').sync().code], ['MANUAL', 'IMPORT_ONLY', 'NOT_SUPPORTED']);
let threw = null;
try { C.defineConnector({ key: 'half', label: 'Half', connectionType: 'API', integrationClass: 'OFFICIAL_API', runsOn: 'server', connect() {} }); } catch (e) { threw = e.message; }
chk('a connector missing methods is refused at definition', /incomplete/.test(threw || '') && /sync/.test(threw || ''), threw);
threw = null;
const full = {}; C.METHODS.forEach((m) => { full[m] = () => null; });
try { C.defineConnector(Object.assign({ key: 'browser_api', label: 'X', connectionType: 'API', integrationClass: 'USER_API_CREDENTIAL', runsOn: 'browser' }, full)); } catch (e) { threw = e.message; }
chk('a credential-bearing connector can never run in the browser', /runsOn:server/.test(threw || ''), threw);
chk('a complete server connector is accepted', !!C.defineConnector(Object.assign({ key: 'example_api', label: 'X', connectionType: 'API', integrationClass: 'USER_API_CREDENTIAL', runsOn: 'server' }, full)));
eq('every source is validated by the same rules', [C.validateNormalized({ kind: 'wager' }).length > 0, C.validateNormalized({ kind: 'nope' })[0].code,
  C.get('csv').normalize({ 'Date': '2026-09-07 13:00', 'Book': 'DK', 'Event': 'A @ B', 'Selection': 'A', 'Odds': '-110', 'Stake': '10' }, { adapter: 'generic_sportsbook_v1', map: { placed_at: 'Date', platform: 'Book', event_name: 'Event', selection: 'Selection', odds: 'Odds', stake: 'Stake' }, timezone: 'UTC' }).record.platform],
  [true, 'BAD_KIND', 'draftkings']);
eq('backoff doubles to a cap', [1, 2, 3, 10, 20].map((a) => C.backoffMs(a, { baseMs: 1000, capMs: 60000 })), [1000, 2000, 4000, 60000, 60000]);
eq('backoff with full jitter stays inside the window', C.backoffMs(3, { baseMs: 1000, random: () => 0.5 }), 2000);
eq('a rejected credential needs the reader; a rate limit and an outage retry', [C.classifyFailure(401), C.classifyFailure(429, { retryAfterMs: 30000 }), C.classifyFailure(503)].map((x) => [x.code, x.accountStatus, x.retry]),
  [['CREDENTIAL_REJECTED', 'ACTION_REQUIRED', false], ['RATE_LIMITED', null, true], ['UPSTREAM_UNAVAILABLE', null, true]]);
const leak = C.safeLogMessage('request failed: Authorization: Bearer abc.def-ghi token=sk_live_123 apiKey: 9f9f eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig ' + '-----BEGIN RSA ' + 'PRIVATE KEY-----');
/* the private-key header is split so tools/cfb/secret_audit.js does not read
   this fixture as a key (the convention football/cfb_production/security.test.js uses) */
chk('a log line never carries a token, key or private key', !/abc\.def|sk_live_123|9f9f|eyJhbGci|BEGIN RSA/.test(leak) && /\[redacted\]/.test(leak), leak);

/* ═══ SPORTSBOOK IMPORT: platform, bonus bets, parlay legs, estimate ═══ */
chk('every platform profile is marked unverified, and none asserts a column layout', I.PROFILES.length === 10 && I.PROFILES.every((p) => p.verified === false && !p.columns && !p.headers));
chk('a bonus bet is read from its own column, or named in the status or bet type — never guessed from a small stake',
  [I.readStakeType('Yes'), I.readStakeType('Free Bet'), I.readStakeType('cash'), I.readStakeType(null, 'Won (Free Bet)'), I.readStakeType(null, 'Moneyline'), I.readStakeType('maybe')].join()
  === 'BONUS,BONUS,CASH,BONUS,,UNKNOWN');
const BOOK = ['Bet ID,Placed,Event,Selection,Odds,Stake,Status,Payout,Free Bet',
  'D1,2026-09-07 13:00,Chiefs @ Bills,Chiefs ML,+150,40,Won,100,',
  'D2,2026-09-07 14:00,Jets @ Giants,Jets ML,-110,22,Lost,0,',
  'D3,2026-09-08 13:00,Rams @ 49ers,Over 44.5,-110,50,Push,50,',
  'D4,2026-09-08 14:00,Bears @ Packers,Bears +3.5,-105,20,Void,20,',
  'D5,2026-09-09 13:00,Lions @ Vikings,Lions ML,+120,30,Cashed Out,41.10,',
  'D6,2026-09-09 15:00,Bucs @ Saints,Saints ML,+200,25,Won,50,Yes',
  'D7,2026-09-10 13:00,Colts @ Titans,Colts ML,+130,10,Won,23,',
  'D7,2026-09-10 13:00,Colts @ Titans,Colts ML,+130,10,Won,23,',
  'P1,2026-09-11 13:00,Chiefs @ Bills,Chiefs ML,+260,10,Won,36,',
  'P1,2026-09-11 13:00,Lakers @ Celtics,Lakers +4.5,,,,,'].join('\n');
let st2 = I.stage(BOOK, { fileName: 'draftkings_history_2026.csv', timezone: 'America/New_York' });
const byId = (id) => st2.rows.find((r) => r.normalized.external_position_id === id);
chk('the platform is detected from the file\'s name, and the format is flagged as unchecked', st2.platform === 'draftkings' && st2.platformHow === 'FILE_NAME'
  && st2.rows.every((r) => r.normalized.platform === 'draftkings') && st2.fileIssues.some((x) => x.code === 'PROFILE_UNVERIFIED' && /real DraftKings export/.test(x.message)), [st2.platform, st2.platformHow, st2.fileIssues]);
chk('win, loss, push, void and cash-out read as such', ['D1', 'D2', 'D3', 'D4', 'D5'].map((id) => byId(id).normalized.status).join() === 'WON,LOST,PUSH,VOID,CASHED_OUT');
const bonus = byId('D6');
chk('a bonus bet: BONUS, and its payout of winnings only is NOT flagged as a mismatch', bonus.normalized.stake_type === 'BONUS' && codes(bonus).includes('info:BONUS_BET') && !codes(bonus).includes('warning:PAYOUT_MISMATCH'), codes(bonus));
chk('a bonus bet\'s P&L is its winnings: +$50 on a $25 free bet at +200', E.derive(bonus.normalized).profit_loss === '50');
chk('the same bet listed twice stays two rows (a duplicate for the server to call), not a parlay', st2.rows.filter((r) => r.normalized.external_position_id === 'D7').length === 2);
const par = byId('P1');
chk('a parlay exported one leg per row becomes ONE position with its legs', par.normalized.position_type === 'PARLAY' && par.normalized.legs.length === 2
  && par.normalized.selection === 'Chiefs ML + Lakers +4.5' && par.normalized.stake === '10' && par.normalized.status === 'WON' && par.legRows.length === 1
  && codes(par).includes('info:LEGS_GROUPED') && st2.mergedRows === 1, par.normalized);
chk('times without a zone are read in the zone chosen: 13:00 New York is 17:00 UTC', byId('D1').normalized.placed_at === '2026-09-07T17:00:00.000Z');
const est = I.estimate(st2.rows.filter((r) => !r.issues.some((x) => x.level === 'error')));
/* D1 +60, D2 −22, D3 0, D4 0, D5 +11.10, D6 +50 (bonus), D7 +13 ×2, P1 +26 */
chk('the estimate before import: P&L over the settled rows, by the engine\'s own arithmetic', est.settled === 9 && est.pnl === '151.1' && est.bonus === 1, est);
chk('the review names the file\'s date range', st2.range && st2.range.text === 'Sep 2026');
chk('the totals check: the file\'s own payouts agree with EdgeDesk\'s calculation — said so', st2.totals && st2.totals.agrees === true && st2.fileIssues.some((x) => x.code === 'TOTALS_AGREE'), st2.totals);
const off = I.stage(BOOK.replace('D2,2026-09-07 14:00,Jets @ Giants,Jets ML,-110,22,Lost,0,', 'D2,2026-09-07 14:00,Jets @ Giants,Jets ML,-110,22,Lost,5,'), { platform: 'draftkings' });
chk('…and a file whose payouts disagree is flagged with both totals, never silently reconciled', off.totals && off.totals.agrees === false && off.totals.difference === '-5'
  && off.fileIssues.some((x) => x.code === 'TOTALS_DIFFER' && /odds and stakes pay/.test(x.message)), off.totals);
chk('the header signature is the sorted, normalized column names — and no cell of data', I.headerSignature(['Stake', 'Bet ID', 'Free Bet']) === 'betid|freebet|stake'
  && I.headerSignature(['Free Bet', 'Stake', 'Bet ID']) === I.headerSignature(['Stake', 'Bet ID', 'Free Bet']) && st2.signature.indexOf('chiefs') < 0);
st2 = I.stage(BOOK.replace('Bet ID,', 'Book,Bet ID,').split('\n').map((l, i) => (i ? 'FanDuel,' : '') + l).join('\n').replace('Book,Bet ID', 'Book,Bet ID'), { fileName: 'draftkings.csv' });
chk('a platform column every row agrees on outranks the file name', st2.platform === 'fanduel' && st2.platformHow === 'COLUMN', [st2.platform, st2.platformHow]);
chk('the reader\'s choice outranks both', I.stage(BOOK, { fileName: 'draftkings.csv', platform: 'betmgm' }).platform === 'betmgm');
st2 = I.stage(BOOK, { fileName: 'export (3).csv' });
chk('a file EdgeDesk cannot place asks the reader, and names no platform it guessed', st2.platform === null && st2.platformHow === 'ASK' && st2.rows.every((r) => codes(r).includes('error:BAD_PLATFORM')));
chk('the same event on two platforms is two positions (each row keeps its own platform)', (() => {
  const two = I.stage('Book,Bet ID,Placed,Event,Selection,Odds,Stake,Status\nDraftKings,A1,2026-09-07 13:00,Chiefs @ Bills,Chiefs ML,+150,10,Open\nFanDuel,B1,2026-09-07 13:05,Chiefs @ Bills,Chiefs ML,+145,10,Open', {});
  return two.platformHow === 'MIXED' && two.rows.map((r) => r.normalized.platform).join() === 'draftkings,fanduel';
})());

/* ═══ LEG ROWS: one row per parlay leg (bet trackers, Juice Reel style) ═══ */
const fs = require('fs');
const LEGS = fs.readFileSync(path.join(__dirname, 'fixtures', 'juice_reel_style.csv'), 'utf8');
const NOW = Date.parse('2026-10-12T12:00:00Z');
const lr = I.stage(LEGS, { timezone: 'UTC', now: NOW });
const tk = (id) => lr.rows.find((r) => r.ticket.id === id);
eq('a file with a leg column is detected as leg rows', [lr.adapter, lr.platformType], ['leg_rows_sportsbook_v1', 'SPORTSBOOK']);
eq('22 rows become 14 staged tickets (8 rows joined or merged), with the grouping report', [lr.rows.length, lr.mergedRows, lr.tickets],
  [14, 8, { rowsRead: 22, tickets: 14, multiLegTickets: 5, legRowsJoined: 7, duplicateRows: 1, duplicateRowsExact: 1, noTicketId: 1, conflictedTickets: 1 }]);
let w1 = tk('T1001').normalized;
eq('T1001: one PARLAY wager with 3 legs; the stake, price, status and payout are the ticket\'s, once',
  [w1.position_type, w1.legs.length, w1.stake, w1.odds_american, w1.status, w1.reported_payout, w1.market_name, w1.selection, w1.external_position_id, tk('T1001').legRows],
  ['PARLAY', 3, '50', 507, 'LOST', '0', 'Parlay (3 legs)', 'Chiefs + Bills -3.5 + Over 47.5', 'T1001', [2, 3]]);
eq('…each leg keeps its own event, market, type and price', w1.legs.map((l) => [l.event_name, l.market_name, l.position_type, l.odds_american]),
  [['Chiefs @ Bengals', 'Moneyline', 'MONEYLINE', -150], ['Bills @ Dolphins', 'Spread', 'SPREAD', -110], ['Lions @ Bears', 'Total', 'TOTAL', -110]]);
chk('…and the joined ticket says so, without the first leg\'s own line or type notes', codes(tk('T1001')).includes('info:LEGS_GROUPED') && !codes(tk('T1001')).some((c) => /LINE_FROM_SELECTION|TYPE_INFERRED/.test(c)), codes(tk('T1001')));
w1 = tk('T1002').normalized;
eq('T1002: a same-game parlay with no ticket price is priced by its legs (EDPortfolio.parlay)', [w1.position_type, w1.event_name, w1.odds_decimal, w1.odds_american, codes(tk('T1002')).includes('info:ODDS_FROM_LEGS')],
  ['SAME_GAME_PARLAY', 'Eagles @ Cowboys', E.parlay([{ odds_american: -110 }, { odds_american: 150 }]).odds_decimal, undefined, true]);
eq('…and the database will store $75.45 for it', E.derive(w1).profit_loss, '75.45');
eq('T1003, exported twice: one ticket, the repeat merged and reported', [lr.rows.filter((r) => r.ticket.id === 'T1003').length, tk('T1003').legRows, tk('T1003').normalized.legs, codes(tk('T1003')).includes('info:DUPLICATE_ROW_MERGED')], [1, [7], undefined, true]);
eq('a single carries its closing price for later analysis, and no legs array', [tk('T1009').normalized.closing_odds_american, tk('T1009').normalized.legs, tk('T1009').normalized.position_type], [-240, undefined, 'SPREAD']);
const noId = lr.rows.find((r) => !r.ticket.id);
eq('a row with no ticket id is its own single, flagged for review', [noId.normalized.position_type, noId.normalized.stake, codes(noId).includes('warning:NO_TICKET_ID')], ['MONEYLINE', '25', true]);
const tf = tk('T1011');
eq('T1011, whose rows say $30 and $35: flagged with the field, the first row kept for the reader to check', [tf.ticket.conflicts, codes(tf).includes('warning:TICKET_FIELDS_DIFFER'), tf.issues.find((x) => x.code === 'TICKET_FIELDS_DIFFER').fields, tf.normalized.stake], [['stake'], true, ['stake'], '30']);
chk('T1012, placed after it settled, is flagged (the settled time dropped)', codes(tk('T1012')).includes('warning:SETTLED_BEFORE_PLACED') && tk('T1012').normalized.settled_at === tk('T1012').normalized.placed_at);
eq('the file says what was joined, merged and flagged', lr.fileIssues.map((x) => x.code).filter((c) => /LEG|DUPLICATE|TICKET/.test(c)), ['LEG_ROWS_JOINED', 'DUPLICATE_ROWS_MERGED', 'NO_TICKET_ID_ROWS', 'TICKET_FIELDS_DIFFER']);
eq('local counts: 14 tickets, 11 ready, 3 to review, none invalid', I.localCounts(lr.rows), { total: 14, ok: 11, review: 3, invalid: 0 });
chk('every staged ticket carries the cells of its first row (no synthetic columns)', lr.rows.every((r) => r.raw && !Object.keys(r.raw).some((k) => /^__/.test(k))));
/* (the estimate's own convention: a void is settled at $0, its stake in "staked") */
eq('the estimate before import counts each ticket once', (() => { const e = I.estimate(lr.rows.filter((r) => !r.issues.some((x) => x.level !== 'info'))); return [e.rows, e.settled, e.pnl, e.staked, e.open, e.exposure]; })(),
  [11, 10, '-113.55', '565', 1, '60']);
/* detection: the generic one-row-per-bet reading is unchanged */
eq('the one-row-per-bet files above are still read by the generic adapter', [I.stage(SB, {}).adapter, I.stage(BOOK, {}).adapter, I.stage(SB, {}).mergedRows], ['generic_sportsbook_v1', 'generic_sportsbook_v1', 0]);
eq('…including one where a bet id repeats on a duplicate row, or on a parlay leg with no stake', I.detect(BOOK.split('\n')[0].split(','), I.parseCSV(BOOK).rows.slice(1).map((r) => {
  const o = {}; BOOK.split('\n')[0].split(',').forEach((h, k) => { o[h] = r[k]; }); return o; })).adapter.key, 'generic_sportsbook_v1');
const repeated = 'Ticket,Placed,Book,Event,Selection,Odds,Stake,Status\nR1,2026-09-07 13:00,DK,A @ B,A,+260,10,Won\nR1,2026-09-07 13:00,DK,C @ D,C,+260,10,Won\nR2,2026-09-08 13:00,DK,E @ F,E,-110,11,Lost\n';
eq('no leg column, but a ticket id repeated on different legs with the stake repeated: leg rows', [I.stage(repeated, { timezone: 'UTC' }).adapter, I.stage(repeated, { timezone: 'UTC' }).rows.length], ['leg_rows_sportsbook_v1', 2]);
eq('the reader can still choose the generic reading', I.stage(repeated, { adapter: 'generic_sportsbook_v1', timezone: 'UTC' }).adapter, 'generic_sportsbook_v1');
/* leg numbers, leg results, leg counts */
const LN = ['Bet ID,Leg,Legs,Placed,Book,Sport,Bet Type,Event,Selection,Leg Odds,Leg Result,Stake,Status',
  'L1,1,3,2026-09-07 13:00,DK,NFL,Parlay,A @ B,A,-110,Won,10,',
  'L1,2,3,2026-09-07 13:00,DK,NBA,Parlay,C @ D,C,+120,Won,10,',
  'L1,2,3,2026-09-07 13:00,DK,NBA,Parlay,C @ D,C,+120,Won,10,',
  'L1,3,3,2026-09-07 13:00,DK,NFL,Parlay,E @ F,E,-105,Push,10,',
  'L2,1,3,2026-09-08 13:00,DK,NFL,Parlay,G @ H,G,-110,Lost,20,Won',
  'L2,2,3,2026-09-08 13:00,DK,NFL,Parlay,I @ J,I,-110,Won,20,Won',
  'L3,1,,2026-09-09 13:00,DK,NFL,Straight,K @ L,K,-110,,15,Lost',
  'L3,2,,2026-09-09 13:00,DK,NFL,Straight,M @ N,M,-110,,15,Lost',
  'L4,1,,2026-09-10 13:00,DK,NFL,Teaser,O @ P,O +8.5,-120,,12,Lost',
  'L4,2,,2026-09-10 13:00,DK,NFL,Teaser,Q @ R,Q +7.5,-120,,12,Lost'].join('\n');
const ln = I.stage(LN, { timezone: 'UTC', now: NOW }), lt = (id) => ln.rows.find((r) => r.ticket.id === id);
eq('a leg-number column decides what a duplicate is; leg results decide a ticket with no status', [lt('L1').normalized.legs.length, lt('L1').normalized.status, codes(lt('L1')).includes('info:STATUS_FROM_LEGS'), codes(lt('L1')).includes('info:DUPLICATE_ROW_MERGED')],
  [3, 'WON', true, true]);
eq('…its price is the legs\' with the pushed leg dropped (the book re-prices without it), and legs on two sports make it multi-sport', [lt('L1').normalized.odds_decimal, lt('L1').normalized.sport, lt('L1').normalized.legs.map((l) => l.result)],
  [E.parlay([{ odds_american: -110, result: 'WON' }, { odds_american: 120, result: 'WON' }, { odds_american: -105, result: 'PUSH' }]).odds_decimal, 'MULTI', ['WON', 'WON', 'PUSH']]);
eq('…so $10 wins what EDPortfolio.parlay() says: −110 × +120 = 4.2, +$32.00', E.derive(lt('L1').normalized).profit_loss, '32');
chk('a ticket the book graded WON with a lost leg is flagged', codes(lt('L2')).includes('warning:LEG_STATUS_DISAGREES') && lt('L2').normalized.status === 'WON');
chk('"Straight" with two different legs under one id is flagged, and read as the parlay the rows show', codes(lt('L3')).includes('warning:BET_TYPE_DISAGREES') && lt('L3').normalized.position_type === 'PARLAY');
eq('a teaser is a parlay-family ticket, and says so', [lt('L4').normalized.position_type, lt('L4').normalized.bet_type, lt('L4').normalized.market_name], ['PARLAY', 'TEASER', 'Teaser (2 legs)']);
const LC = 'Bet ID,Legs,Placed,Book,Event,Selection,Leg Odds,Odds,Stake,Status\nC1,3,2026-09-07 13:00,DK,A @ B,A,-110,+260,10,Lost\nC1,3,2026-09-07 13:00,DK,C @ D,C,+120,+260,10,Lost\n';
chk('a leg count that disagrees with the rows found is flagged', codes(I.stage(LC, { timezone: 'UTC' }).rows[0]).includes('warning:LEG_COUNT_MISMATCH'));
const SINGLES = 'Bet ID,Placed,Book,Event,Selection,Leg Odds,Stake,Status,Payout\nX1,2026-09-07 13:00,DK,A @ B,A,-110,10,Won,19.09\n';
eq('a single whose price is only in the leg column is priced from it', [I.stage(SINGLES, { timezone: 'UTC' }).rows[0].normalized.odds_american, I.stage(SINGLES, { timezone: 'UTC' }).rows[0].issues.filter((x) => x.level === 'error').length], [-110, 0]);
eq('a leg row that leaves the book blank stays with its ticket', I.stage('Bet ID,Placed,Book,Event,Selection,Leg Odds,Odds,Stake,Status\n8,2026-09-07 13:00,,A @ B,A,-110,+260,10,Lost\n8,2026-09-07 13:00,DK,C @ D,C,+120,+260,10,Lost\n8,,,E @ F,E,+100,,,\n', { timezone: 'UTC' }).rows.map((r) => [r.ticket.rows, r.normalized.legs.length, r.normalized.platform]),
  [[[1, 2, 3], 3, 'draftkings']]);
eq('the same ticket id on two books is two tickets', I.stage('Bet ID,Placed,Book,Event,Selection,Leg Odds,Odds,Stake,Status\n9,2026-09-07 13:00,DK,A @ B,A,-110,+260,10,Lost\n9,2026-09-07 13:00,FanDuel,C @ D,C,+120,+260,10,Lost\n', { timezone: 'UTC' }).rows.length, 2);
eq('the connector contract still normalizes one record through the leg adapter', C.get('csv').normalize({ 'Date': '2026-09-07 13:00', 'Book': 'DK', 'Event': 'A @ B', 'Selection': 'A', 'Odds': '-110', 'Stake': '10' },
  { adapter: 'leg_rows_sportsbook_v1', map: { placed_at: 'Date', platform: 'Book', event_name: 'Event', selection: 'Selection', odds: 'Odds', stake: 'Stake' }, timezone: 'UTC' }).record.platform, 'draftkings');

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio import — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
