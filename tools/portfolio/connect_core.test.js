#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_connect_core.js — the connector core, in Node.

     - the registry claims no automatic connection a platform does not offer,
       and the UI offer reads CONNECT only when the database switched it on;
     - an adapter must implement all 13 contract methods and may never trade;
     - Kalshi signatures verify against the key's public half (RSA-PSS with a
       PKCS#1 or PKCS#8 key, and Ed25519), over timestamp + METHOD + path
       without the query; a key that can trade is refused;
     - the net-position replay turns Kalshi fills into YES / NO buys and sells
       whose P&L, through EDPortfolio.derive (the same arithmetic the
       database runs), equals Kalshi's own netting;
     - Polymarket: trades, partial and full sells, fees, resolution, a
       redeemed winner, a re-sent page (no duplicate ids);
     - a seed phrase or private key pasted as a "wallet" is refused;
     - the vault opens only for the account it was sealed for;
     - nothing secret survives redaction.

   Run: node tools/portfolio/connect_core.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const K = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

/* the P&L of a normalized contract position, by the engine the database mirrors */
function pnl(p) {
  const fills = p.fills.map((f) => ({ transaction_type: f.action, quantity: f.quantity, price: f.price, fee: f.fee }))
    .concat((p.fees || []).map((f) => ({ transaction_type: 'FEE', fee: f.fee })));
  return E.derive({ platform_type: 'PREDICTION_MARKET', side: p.side, resolution: p.resolution, settlement_price: p.settlement_price, current_price: p.current_price }, fills);
}

(async function main() {
  /* ═══ exact arithmetic ═══════════════════════════════════════════════ */
  chk('fixed-point: 0.1 + 0.2 is 0.3, exactly', K.dec.add('0.1', '0.2') === '0.3');
  chk('fixed-point: cents → dollars, 1 − p, half-away rounding at the 7th place', K.dec.cents('55') === '0.55' && K.dec.sub('1', '0.37') === '0.63'
    && K.dec.str(K.dec.micro('0.1234565')) === '0.123457' && K.dec.str(K.dec.micro('-0.1234565')) === '-0.123457');

  /* ═══ the registry and the offer ═════════════════════════════════════ */
  const books = K.REGISTRY.filter((p) => p.source_type === 'SPORTSBOOK');
  chk('no sportsbook claims an automatic connection', books.length === 5 && books.every((p) => p.automatic === null));
  chk('…and every sportsbook import profile is marked unverified until checked against a real export', books.every((p) => p.import && p.import.verified === false));
  chk('Kalshi: API key, read-only, with how and when it was verified and what needs terms review', (() => {
    const k = K.platformInfo('kalshi').automatic;
    return k.method === 'API_KEY' && k.read_only && k.verified.on === '2026-10-04' && k.tos_review.length >= 2 && /read access only/.test(k.what_the_reader_gives);
  })());
  chk('Polymarket: a public wallet — never a seed phrase, private key or password', (() => {
    const k = K.platformInfo('polymarket').automatic;
    return k.method === 'PUBLIC_WALLET' && /Never a seed phrase, private key or password/.test(k.what_the_reader_gives);
  })());
  chk('tiers: OAuth 1, key or wallet 2, file import 3, manual 4', K.TIER.OAUTH === 1 && K.TIER.API_KEY === 2 && K.TIER.PUBLIC_WALLET === 2 && K.TIER.FILE_IMPORT === 3 && K.TIER.MANUAL === 4);
  chk('a sportsbook is offered as IMPORT, with the honest reason', K.connectionOffer('draftkings', { automatic_enabled: true }).kind === 'IMPORT' && /never asks for your sportsbook password/.test(K.connectionOffer('fanduel').note));
  chk('Kalshi reads IMPORT until the database switches it on after a live test', K.connectionOffer('kalshi').kind === 'IMPORT' && K.connectionOffer('kalshi').automatic_pending
    && K.connectionOffer('kalshi', { automatic_enabled: false }).kind === 'IMPORT' && K.connectionOffer('kalshi', { automatic_enabled: true }).kind === 'AUTOMATIC');
  chk('an unknown platform is manual', K.connectionOffer('custom_x').kind === 'MANUAL');
  chk('the live smoke test has ten stages, in order', K.SMOKE_STAGES.join() === 'CONNECT,IMPORT,VERIFY,INCREMENTAL,NEW_ACTIVITY,SETTLEMENT,RECONCILE,DISCONNECT,RECONNECT,NO_DUPLICATES');

  /* ═══ the contract ═══════════════════════════════════════════════════ */
  const full = {}; K.CONTRACT.forEach((m) => { full[m] = () => null; });
  chk('the contract is 13 methods', K.CONTRACT.length === 13);
  let threw = null;
  try { K.defineAdapter(Object.assign({ key: 'kalshi', method: 'API_KEY' }, full, { fetchSettlements: undefined })); } catch (e) { threw = e.message; }
  chk('an adapter missing a method is refused, by name', /fetchSettlements/.test(threw || ''), threw);
  threw = null;
  try { K.defineAdapter(Object.assign({ key: 'kalshi', method: 'API_KEY', places_orders: true }, full)); } catch (e) { threw = e.message; }
  chk('an adapter that would place orders is refused', /read-only/.test(threw || ''), threw);
  chk('a complete, read-only adapter on a registered platform is accepted', !!K.defineAdapter(Object.assign({ key: 'polymarket', method: 'PUBLIC_WALLET' }, full)));

  /* ═══ Kalshi: signing ════════════════════════════════════════════════ */
  chk('the signed string is ms + METHOD + /trade-api/v2 path, without the query',
    K.kalshiSigningString(1700000000123, 'get', '/portfolio/fills?limit=500&cursor=abc') === '1700000000123GET/trade-api/v2/portfolio/fills');
  const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifyPss = (pub, msg, sigB64) => nodeCrypto.verify('sha256', Buffer.from(msg), { key: pub, padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sigB64, 'base64'));
  for (const type of ['pkcs1', 'pkcs8']) {
    const pem = rsa.privateKey.export({ type, format: 'pem' });
    const signer = await K.kalshiSigner('a952bcbe-ec3b-4b5b-b8f9-11dae589608c', pem);
    const h = await signer.headers('GET', '/trade-api/v2/portfolio/fills?limit=500', 1700000000123);
    chk('RSA-PSS SHA-256, salt 32, from a ' + type.toUpperCase() + ' key: the signature verifies', h['KALSHI-ACCESS-TIMESTAMP'] === '1700000000123'
      && h['KALSHI-ACCESS-KEY'] === 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c' && verifyPss(rsa.publicKey, '1700000000123GET/trade-api/v2/portfolio/fills', h['KALSHI-ACCESS-SIGNATURE']));
  }
  const ed = nodeCrypto.generateKeyPairSync('ed25519');
  try {
    const signer = await K.kalshiSigner('a952bcbe-ec3b-4b5b-b8f9-11dae589608c', ed.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const h = await signer.headers('GET', '/portfolio/positions', 1700000000999);
    chk('Ed25519: the signature verifies', nodeCrypto.verify(null, Buffer.from('1700000000999GET/trade-api/v2/portfolio/positions'), ed.publicKey, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')));
  } catch (e) { chk('Ed25519: the signature verifies', false, e.message); }
  let code = null;
  try { await K.kalshiSigner('a952bcbe-ec3b-4b5b-b8f9-11dae589608c', 'not a key'); } catch (e) { code = e.code; }
  chk('something that is not a private key is BAD_CREDENTIAL, with no detail of what was pasted', code === 'BAD_CREDENTIAL');
  chk('a read-only key passes', K.kalshiScopeVerdict({ api_keys: [{ api_key_id: 'k1', scopes: ['read'] }] }, 'k1').ok);
  chk('a key that can trade is refused (WRITE_SCOPE)', K.kalshiScopeVerdict({ api_keys: [{ api_key_id: 'k1', scopes: ['read', 'write::trade'] }] }, 'k1').code === 'WRITE_SCOPE'
    && K.kalshiScopeVerdict({ api_keys: [{ api_key_id: 'k1', scopes: ['write'] }] }, 'k1').code === 'WRITE_SCOPE');
  chk('a key whose scopes cannot be read is refused, not assumed safe', K.kalshiScopeVerdict({ api_keys: [{ api_key_id: 'other', scopes: ['read'] }] }, 'k1').code === 'SCOPE_UNKNOWN'
    && K.kalshiScopeVerdict({ api_keys: [{ api_key_id: 'k1' }] }, 'k1').code === 'SCOPE_UNKNOWN' && K.kalshiScopeVerdict(null, 'k1').code === 'SCOPE_UNKNOWN');
  chk('the query builder encodes and drops empties', K.kalshiQuery('/portfolio/fills', { limit: 500, cursor: 'a b', min_ts: null }) === '/portfolio/fills?limit=500&cursor=a%20b');

  /* ═══ Kalshi: the net-position replay ════════════════════════════════ */
  const T = (m) => '2026-09-1' + m + 'T15:00:00Z';
  /* new schema: outcome_side is the side whose exposure the fill adds */
  const fills = [
    { fill_id: 'f1', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '10.00', yes_price_dollars: '0.4000', no_price_dollars: '0.6000', fee_cost: '0.07', created_time: T(1) },
    { fill_id: 'f2', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '5.50', yes_price_dollars: '0.4200', no_price_dollars: '0.5800', fee_cost: '0.04', created_time: T(2) },
    { fill_id: 'f3', ticker: 'NFL-KC', outcome_side: 'no', count_fp: '20.00', yes_price_dollars: '0.3000', no_price_dollars: '0.7000', fee_cost: '0.12', created_time: T(3) }
  ];
  let r = K.kalshiReplay(fills);
  const sum = (xs, k) => xs.reduce((s, x) => K.dec.add(s, x[k]), '0');
  chk('YES built from two fills (multiple fills, a fractional count)', r.fills.filter((f) => f.side === 'YES' && f.action === 'BUY').map((f) => f.quantity).join() === '10,5.5');
  chk('a NO fill against a YES holding closes YES first (a SELL of YES at the YES price), then opens NO with the rest',
    r.fills.some((f) => f.side === 'YES' && f.action === 'SELL' && f.quantity === '15.5' && f.price === '0.3' && f.external_transaction_id === 'kalshi:f3:c')
    && r.fills.some((f) => f.side === 'NO' && f.action === 'BUY' && f.quantity === '4.5' && f.price === '0.7' && f.external_transaction_id === 'kalshi:f3:o'), r.fills);
  chk('the fee is shared in proportion and adds back to the fill\'s fee exactly', sum(r.fills.filter((f) => /f3/.test(f.external_transaction_id)), 'fee') === '0.12'
    && r.fills.find((f) => f.external_transaction_id === 'kalshi:f3:c').fee === '0.093');
  chk('the net holding after the replay is 4.5 NO (−4.5 YES)', r.net['NFL-KC'] === '-4.5');
  const legacy = [{ trade_id: 'f1', ticker: 'NFL-KC', side: 'yes', action: 'buy', count: 10, yes_price: 40, no_price: 60, fee_cost: '0.07', created_time: T(1) },
    { trade_id: 'f2', ticker: 'NFL-KC', side: 'no', action: 'sell', count: 5.5, yes_price: 42, fee_cost: '0.04', created_time: T(2) },
    { trade_id: 'f3', ticker: 'NFL-KC', side: 'no', action: 'buy', count: 20, yes_price: 30, no_price: 70, fee_cost: '0.12', created_time: T(3) }];
  chk('the legacy schema (side + action, prices in cents) replays identically: selling NO adds YES', JSON.stringify(K.kalshiReplay(legacy).fills) === JSON.stringify(r.fills), K.kalshiReplay(legacy).fills);
  chk('fills arriving out of order are replayed by time', JSON.stringify(K.kalshiReplay(fills.slice().reverse()).fills) === JSON.stringify(r.fills));
  chk('a re-sent fill (same id) is not counted twice', K.kalshiReplay(fills.concat([fills[0]])).fills.length === r.fills.length);
  const inc = K.kalshiReplay([{ fill_id: 'f4', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '10', yes_price_dollars: '0.5', fee_cost: '0', created_time: T(4) }], { 'NFL-KC': '-4.5' });
  chk('an incremental sync starts from the stored holding: +10 YES against 4.5 NO closes NO, then buys 5.5 YES',
    inc.fills.map((f) => f.side + ' ' + f.action + ' ' + f.quantity + ' @ ' + f.price).join(' | ') === 'NO SELL 4.5 @ 0.5 | YES BUY 5.5 @ 0.5' && inc.net['NFL-KC'] === '5.5', inc.fills);
  const broken = K.kalshiReplay([{ fill_id: 'x', ticker: 'NFL-KC', count_fp: '3', yes_price_dollars: '0.5', created_time: T(1) }, { fill_id: 'y', ticker: 'NFL-KC', outcome_side: 'yes', count_fp: '3', yes_price_dollars: '1.5', created_time: T(1) }]);
  chk('a fill with no direction or an impossible price is reported, never guessed', broken.fills.length === 0 && broken.issues.length === 2 && broken.issues.every((i) => i.code === 'MALFORMED_FILL'));

  /* settlement and the money, through the engine */
  let n = K.kalshiNormalize({ fills, settlements: [{ ticker: 'NFL-KC', market_result: 'no', revenue: 450, fee_cost: '0.02', settled_time: '2026-09-20T03:00:00Z' }],
    markets: { 'NFL-KC': { event_ticker: 'NFL-25W3', title: 'Will the Chiefs win?', yes_sub_title: 'Chiefs' } }, events: { 'NFL-25W3': { title: 'Chiefs at Bills' } } });
  const yes = n.positions.find((p) => p.side === 'YES'), no = n.positions.find((p) => p.side === 'NO');
  chk('positions are keyed by market and side, named from the market and event', yes.external_position_id === 'kalshi:NFL-KC:YES' && no.external_position_id === 'kalshi:NFL-KC:NO'
    && yes.event_name === 'Chiefs at Bills' && yes.market_name === 'Chiefs' && yes.event_id === 'NFL-25W3' && yes.position_type === 'EVENT_CONTRACT');
  chk('a NO result resolves both sides: YES settles at $0, NO at $1', yes.resolution === 'NO' && yes.settlement_price === '0' && no.settlement_price === '1' && no.settled_at === '2026-09-20T03:00:00.000Z');
  const py = pnl(yes), pn = pnl(no);
  /* YES: bought 10 @ .40 + 5.5 @ .42 = 6.31, sold 15.5 @ .30 = 4.65; fees .07 + .04 + .093 → −1.863 */
  chk('YES P&L through the engine: −1.66 on the trades, −0.203 fees = −1.863', py.profit_loss === '-1.863' && py.contracts === '0' && py.status === 'SETTLED', py);
  /* NO: 4.5 @ .70 = 3.15 → pays 4.50; fees .027 + .02 settlement → +1.303 */
  chk('NO P&L through the engine: +1.35 at settlement, −0.047 fees (incl. the settlement fee on the side held) = +1.303', pn.profit_loss === '1.303' && pn.result === 'WIN', pn);
  const kalshiTruth = K.dec.add(K.dec.sub(K.dec.sub('4.5', K.dec.add('6.31', '3.15')), '0'), K.dec.sub('4.65', K.dec.add('0.07', K.dec.add('0.04', K.dec.add('0.12', '0.02')))));
  chk('the two sides together equal Kalshi\'s own netted result: −0.56', K.dec.add(py.profit_loss, pn.profit_loss) === kalshiTruth && kalshiTruth === '-0.56', kalshiTruth);
  n = K.kalshiNormalize({ fills: fills.slice(0, 1), settlements: [{ ticker: 'NFL-KC', market_result: 'scalar', value: 37, settled_time: '2026-09-20T03:00:00Z' }] });
  chk('a scalar settlement: YES at the value, NO at 1 − value', n.positions[0].settlement_price === '0.37' && n.positions[0].resolution === 'SCALAR');
  n = K.kalshiNormalize({ fills: fills.slice(0, 1), settlements: [{ ticker: 'NFL-KC', market_result: 'void', settled_time: '2026-09-20T03:00:00Z' }] });
  chk('a voided market: status VOID, cost refunded, no profit or loss', pnl(n.positions[0]).status === 'VOID' && pnl(n.positions[0]).profit_loss === '-0.07', pnl(n.positions[0]));
  n = K.kalshiNormalize({ settlements: [{ ticker: 'NFL-KC', market_result: 'yes', settled_time: '2026-09-21T03:00:00Z' }], known: { 'NFL-KC:YES': true } });
  chk('an updated settlement for a position stored by an earlier sync still lands on it', n.positions.length === 1 && n.positions[0].external_position_id === 'kalshi:NFL-KC:YES' && n.positions[0].resolution === 'YES' && n.positions[0].fills.length === 0);
  chk('a result EdgeDesk does not know is reported, not guessed', K.kalshiNormalize({ settlements: [{ ticker: 'X', market_result: 'all_no', settled_time: T(1) }] }).issues[0].code === 'UNKNOWN_SETTLEMENT');
  chk('times arrive as UTC ISO whatever the platform\'s zone', K.iso('2026-09-12T10:00:00-07:00') === '2026-09-12T17:00:00.000Z' && K.iso(1757692800) === '2025-09-12T16:00:00.000Z' && K.iso(1757692800000) === '2025-09-12T16:00:00.000Z');

  /* reconciliation */
  const reported = K.kalshiReportedNet({ market_positions: [{ ticker: 'NFL-KC', position_fp: '-4.50' }, { ticker: 'NBA-X', position_fp: '3.00' }] });
  chk('reconcile: our −4.5 matches Kalshi\'s −4.50; a market we never saw is a mismatch to re-fetch', (() => {
    const rc = K.reconcile({ 'NFL-KC': r.net['NFL-KC'] }, reported);
    return !rc.ok && rc.mismatches.length === 1 && rc.mismatches[0].key === 'NBA-X' && rc.mismatches[0].difference === '-3';
  })());
  chk('reconcile within a cent is agreement', K.reconcile({ a: '1.004' }, { a: '1' }).ok && !K.reconcile({ a: '1.02' }, { a: '1' }).ok);

  /* ═══ Polymarket ═════════════════════════════════════════════════════ */
  chk('a public address is accepted, lower-cased', K.walletVerdict(' 0xAbC0000000000000000000000000000000000001 ').address === '0xabc0000000000000000000000000000000000001');
  chk('a private key is refused as a secret, not as a bad address', K.walletVerdict('0x' + 'ab'.repeat(32)).code === 'SECRET_PASTED' && K.walletVerdict('ab'.repeat(32)).code === 'SECRET_PASTED');
  chk('a seed phrase is refused as a secret', K.walletVerdict('apple banana cherry delta eagle falcon garden harbor island jungle kettle lemon').code === 'SECRET_PASTED');
  chk('anything else is a bad address', K.walletVerdict('0x123').code === 'BAD_WALLET' && K.walletVerdict('').code === 'BAD_WALLET');
  const tok = '7132', tok2 = '9911', cond = '0xc0nd';
  const activity = [
    { type: 'TRADE', timestamp: 1757692800, condition_id: cond, token_id: tok, side: 'BUY', size: 100, usdc_size: 40, price: 0.4, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', transaction_hash: '0xh1' },
    { type: 'TRADE', timestamp: 1757779200, condition_id: cond, token_id: tok, side: 'BUY', size: 50, usdc_size: 25, price: 0.5, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', transaction_hash: '0xh2' },
    { type: 'TRADE', timestamp: 1757865600, condition_id: cond, token_id: tok, side: 'SELL', size: 60, usdc_size: 36, price: 0.6, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', transaction_hash: '0xh3' },
    { type: 'TRADE', timestamp: 1757865600, condition_id: '0xother', token_id: tok2, side: 'BUY', size: 10, usdc_size: 3, price: 0.3, outcome: 'Bills', title: 'AFC East winner', transaction_hash: '0xh4' },
    { type: 'TRADE', timestamp: 1757952000, condition_id: '0xother', token_id: tok2, side: 'SELL', size: 10, usdc_size: 5, price: 0.5, outcome: 'Bills', title: 'AFC East winner', transaction_hash: '0xh5' },
    { type: 'REDEEM', timestamp: 1758038400, condition_id: cond, usdc_size: 90 }
  ];
  const positions = [{ token_id: tok, condition_id: cond, outcome: 'Yes', title: 'Will the Chiefs win the AFC?', event_slug: 'afc-champion', status: 'CLOSED', current_size: 0, entry_fees_usdc: '0.35', realized_pnl: '45.65', last_event_at: 1758038400 },
    { token_id: tok2, condition_id: '0xother', outcome: 'Bills', title: 'AFC East winner', status: 'CLOSED', current_size: 0 }];
  let pm = K.polymarketNormalize({ activity, positions });
  const won = pm.positions.find((p) => p.external_position_id === 'polymarket:' + tok), flat = pm.positions.find((p) => p.external_position_id === 'polymarket:' + tok2);
  chk('a token is a position: its outcome is the side, its question the event', won.side === 'Yes' && won.event_name === 'Will the Chiefs win the AFC?' && won.event_id === 'afc-champion' && won.fills.length === 3);
  chk('a partial sell leaves 90 held; the redemption marks the closed position won', won.resolution === 'Yes' && won.settlement_price === '1' && won.settled_at === '2025-09-16T16:00:00.000Z');
  const pw = pnl(won);
  /* bought 100 @ .40 + 50 @ .50 = 65; sold 60 @ .60 = 36; 90 redeemed at $1; entry fees .35 → 126 − 65 − .35 = 60.65 */
  chk('P&L: 36 sold + 90 redeemed − 65 cost − 0.35 entry fees = +60.65', pw.profit_loss === '60.65' && pw.fees === '0.35', pw);
  const pf = pnl(flat);
  chk('a full sell needs no resolution: bought 3.00, sold 5.00 → +2.00, settled', pf.profit_loss === '2' && pf.status === 'SETTLED' && flat.resolution === null, pf);
  chk('trade ids are stable across a re-sent page: the same activity twice gives the same ids', (() => {
    const again = K.polymarketNormalize({ activity: activity.concat(activity.slice(0, 1)), positions });
    const ids = again.positions.find((p) => p.side === 'Yes').fills.map((f) => f.external_transaction_id);
    return ids.length === 4 && new Set(ids).size === 4 && ids.slice(0, 3).join() === won.fills.map((f) => f.external_transaction_id).join();
  })());
  pm = K.polymarketNormalize({ activity: activity.slice(0, 1), positions: [{ token_id: tok, outcome: 'Yes', title: 'Q', status: 'REDEEMABLE_LOST', last_event_at: 1758038400 }] });
  chk('a lost market settles at $0 without inventing the winner\'s name', pm.positions[0].settlement_price === '0' && pnl(pm.positions[0]).profit_loss === '-40');
  pm = K.polymarketNormalize({ activity: activity.slice(0, 1), positions: [{ token_id: tok, outcome: 'Yes', title: 'Q', status: 'OPEN', current_price: 0.55 }], asOf: '2026-10-04T12:00:00Z' });
  chk('an open position carries the platform\'s current price as its mark', pm.positions[0].current_price === '0.55' && pnl(pm.positions[0]).unrealized_profit_loss === '15');
  pm = K.polymarketNormalize({ activity: [{ type: 'TRADE', timestamp: 1, token_id: tok, side: 'SELL', size: 5, price: 0.5, transaction_hash: '0xz' }] });
  chk('a history that sells more than it bought is flagged for re-fetch, not trusted', pm.issues.some((i) => i.code === 'SOLD_MORE_THAN_BOUGHT'));
  chk('a malformed trade is reported, not dropped silently', K.polymarketNormalize({ activity: [{ type: 'TRADE', token_id: tok, side: 'BUY', size: 5, price: 2, timestamp: 1, transaction_hash: '0x1' }] }).issues[0].code === 'MALFORMED_TRADE');

  /* ═══ the vault and redaction ════════════════════════════════════════ */
  const key = Buffer.from(nodeCrypto.randomBytes(32)).toString('base64');
  const secret = { key_id: 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c', private_key: 'PRIVATE-MATERIAL-' + 'x'.repeat(40) };
  const sealed = await K.sealCredential(secret, { keyB64: key, keyVersion: 1, userId: 'u1', accountId: 'acct1', kind: 'API_KEY' });
  chk('a sealed credential carries no plaintext', !/PRIVATE-MATERIAL|a952bcbe/.test(JSON.stringify(sealed)) && sealed.key_version === 1 && K.unb64(sealed.nonce_b64).length === 12);
  const opened = await K.openCredential(sealed, { keyB64: key, userId: 'u1', accountId: 'acct1' });
  chk('it opens for the account it was sealed for', opened.private_key === secret.private_key);
  let refused = 0;
  for (const o of [{ keyB64: key, userId: 'u2', accountId: 'acct1' }, { keyB64: key, userId: 'u1', accountId: 'acct2' }, { keyB64: Buffer.from(nodeCrypto.randomBytes(32)).toString('base64'), userId: 'u1', accountId: 'acct1' }]) {
    try { await K.openCredential(sealed, o); } catch (_) { refused++; }
  }
  chk('…and for no other reader, no other account, and no other key', refused === 3);
  chk('two seals of the same secret differ (a fresh nonce each time)', (await K.sealCredential(secret, { keyB64: key, keyVersion: 1, userId: 'u1', accountId: 'acct1', kind: 'API_KEY' })).ciphertext_b64 !== sealed.ciphertext_b64);
  chk('a key hint shows the last four characters of the id, never the secret', K.keyHint(secret.key_id) === '…608c' && K.keyHint('abc') === null);
  const pemLike = rsa.privateKey.export({ type: 'pkcs1', format: 'pem' });
  const red = JSON.stringify(K.redact({ private_key: 'x', nested: { authorization: 'Bearer abc.def.ghi', note: 'key was ' + pemLike }, wallet: '0x' + 'ab'.repeat(32), msg: 'Bearer abcdefghijkl', ok: 'Chiefs at Bills' }));
  chk('redaction: secret fields, PEM blocks, 32-byte hex keys and bearer tokens never reach a log', !/PRIVATE KEY|abc\.def|abababab|abcdefghijkl/.test(red) && /Chiefs at Bills/.test(red) && /\[redacted\]/.test(red), red);
  chk('reader errors are a code and a plain sentence', K.readerError('WRITE_SCOPE').message.indexOf('read-only') >= 0 && K.readerError('nope').code === 'UNKNOWN');

  /* ═══ the ingest payload ═════════════════════════════════════════════ */
  const payload = K.ingestPayload(K.kalshiNormalize({ fills }), { cursor: 'c1' });
  chk('the ingest payload carries only the normalized fields, the fills and fees, and the cursor',
    payload.positions.length === 2 && payload.cursor === 'c1' && payload.positions.every((p) => !('reported' in p) && Array.isArray(p.fills) && Array.isArray(p.fees)) && payload.version === K.VERSION);

  /* ═══ the edge function carries this exact core ═════════════════════ */
  chk('supabase/functions/portfolio_connect/index.ts carries the current core, verbatim (node tools/portfolio/inline_connect_core.js)',
    require(path.join(ROOT, 'tools', 'portfolio', 'inline_connect_core.js')).inSync());

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio connect core — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}());
