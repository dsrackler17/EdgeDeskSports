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

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio import — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
