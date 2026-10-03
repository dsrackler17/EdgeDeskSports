#!/usr/bin/env node
/* ===========================================================================
   VERIFIED P&L — the accounting rules, the price lock and the backfill.
   docs/pnl/DESIGN.md § Verified P&L

   Proves, on the kernel (lib/edgedesk_pnl.js), the price lock
   (tools/record/price_lock.js), the model record's lock step
   (tools/record/football_record_core.js lockPrice) and the ledger build
   (tools/record/pnl_ledger.js) in a throwaway repository root:

     - the unit arithmetic, case by case (−110, +150, −200, 0.5u, push, a
       player prop at −115 and 0.5u) and the spec's three-bet example;
     - NO PRICE = NO VERIFIED P&L: no stored price, a price captured after the
       decision, a stale price, a price for another number — each is record
       only, with its reason, and never a profit figure;
     - the lock: the latest stored quote AT OR BEFORE the decision, frozen;
       a later market move never changes it; a backfill run twice locks once
       and duplicates nothing;
     - graded = verified priced + record only; the row audit catches every
       fault it names.

   Run: node tools/record/verified_pnl.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));
const PL = require('./price_lock.js');
const FR = require('./football_record_core.js');
const L = require('./pnl_ledger.js');
const core = require('./pnl_core.js');

let pass = 0, fail = 0;
function chk(label, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const near = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) < (eps || 1e-6);

/* ================================================== 1–6, 10: the arithmetic */
chk('1. −110, 1u, WIN → +0.9090909u', near(P.profit(-110, 1, 'win'), 0.9090909, 1e-7));
chk('2. −110, 1u, LOSS → −1u', P.profit(-110, 1, 'loss') === -1);
chk('3. +150, 1u, WIN → +1.5u', near(P.profit(150, 1, 'win'), 1.5));
chk('4. +150, 0.5u, WIN → +0.75u', near(P.profit(150, 0.5, 'win'), 0.75));
chk('5. −200, 1u, WIN → +0.5u', near(P.profit(-200, 1, 'win'), 0.5));
chk('6. PUSH → 0u', P.profit(-110, 1, 'push') === 0 && P.profit(150, 0.5, 'push') === 0);
chk('10. player prop −115, 0.5u, WIN → +0.4347826u', near(P.profit(-115, 0.5, 'win'), 0.4347826, 1e-7));
chk('void → 0u, and it risks nothing', P.profit(-110, 1, 'void') === 0);
const stored = P.settle({ recommendation_id: 'x', event_id: 'g', side: 'home', selection: 'X -3', game_date: '2026-09-20T17:00:00Z', recommended_at: '2026-09-19T12:00:00Z',
  odds_captured_at: '2026-09-19T11:59:00Z', rec_class: 'BET', stake_units: 1, entry_odds: -110, result: 'win' });
chk('stored to 6 places: a −110 winner is +0.909091u', stored.flat_profit_units === 0.909091 && stored.profit_units === 0.909091, stored);

/* the spec's example: net +1.9091u, risked 2.5u, ROI 76.36% */
{
  let i = 0;
  const bet = (odds, stake, result) => P.settle({ recommendation_id: 'ex' + (++i), event_id: 'g' + i, side: 'home', selection: 'Ex ' + i, game_date: '2026-09-2' + i + 'T17:00:00Z',
    recommended_at: '2026-09-1' + i + 'T12:00:00Z', odds_captured_at: '2026-09-1' + i + 'T11:00:00Z', rec_class: 'BET', stake_units: stake, entry_odds: odds, result: result });
  const rows = [bet(-110, 1, 'win'), bet(150, 1, 'win'), bet(-110, 0.5, 'loss')];
  const c = P.verifiedCard(rows, 'staked');
  chk('example: net +1.9091u', c.net_units === 1.91 && near(rows.reduce((a, x) => a + x.profit_units, 0), 1.909091, 1e-6), c);
  chk('example: total risked 2.5u', c.risked_units === 2.5, c.risked_units);
  chk('example: ROI 76.36% (net ÷ risked × 100, never per bet)', c.roi_pct === 76.36, c.roi_pct);
  const withPush = rows.concat([bet(-110, 1, 'push')]);
  chk('a push creates no profit and adds nothing to risked', P.verifiedCard(withPush, 'staked').risked_units === 2.5 && P.verifiedCard(withPush, 'staked').net_units === 1.91);
}

/* ================================================== 7: no historical odds */
{
  const mr = P.settle({ recommendation_id: 'mr:cfb:g:spread', source: 'model_record', event_id: 'g', side: 'home', selection: 'UTAH -13.5', game_date: '2026-09-13T02:15:00Z',
    recommended_at: '2026-09-12T22:00:00Z', rec_class: 'MODEL', stake_units: 0, entry_odds: null, result: 'win',
    price_lookup: { status: 'historical_price_unavailable', why: 'no_snapshot', detail: 'nothing stored' } });
  chk('7. no historical odds → pnl_verified = false, with the reason, and no units', mr.pnl_verified === false && mr.pnl_exclusion_reason === 'historical_price_unavailable'
    && mr.flat_profit_units === null && mr.profit_units === null && mr.record_state === 'RECORD_ONLY', mr);
  chk('7. … and it still counts in the record: graded = priced + record only', (() => { const g = P.gradedRecord([mr]); return g.graded === 1 && g.verified === 0 && g.record_only === 1; })());
  const bet = P.settle({ recommendation_id: 'pp:x', event_id: 'g', side: 'over', selection: 'Over 1.5', game_date: '2026-09-13T02:15:00Z', recommended_at: '2026-09-12T22:00:00Z', rec_class: 'BET', stake_units: 0.5, entry_odds: null, result: 'win' });
  chk('a decision whose source never captured a price is missing_price', bet.pnl_exclusion_reason === 'missing_price' && !bet.pnl_verified);
  chk('pending → missing_settlement, invalid odds → invalid_odds, simulated → simulated_price, void → void',
    P.settle(Object.assign({}, bet, { entry_odds: -110, result: 'pending' })).pnl_exclusion_reason === 'missing_settlement'
    && P.settle(Object.assign({}, bet, { entry_odds: 50 })).pnl_exclusion_reason === 'invalid_odds'
    && P.settle(Object.assign({}, bet, { entry_odds: -110, price_assumed: true })).pnl_exclusion_reason === 'simulated_price'
    && P.settle(Object.assign({}, bet, { entry_odds: -110, result: 'void' })).pnl_exclusion_reason === 'void');
  chk('odds of 0 are never a price', P.settle(Object.assign({}, bet, { entry_odds: 0 })).pnl_verified === false);
}

/* ================================================== 8: a price after the decision */
{
  const late = P.settle({ recommendation_id: 'bd:late', event_id: 'g', side: 'home', selection: 'X -3', game_date: '2026-09-20T17:00:00Z', recommended_at: '2026-09-19T12:00:00Z',
    odds_captured_at: '2026-09-19T12:30:00Z', rec_class: 'BET', stake_units: 1, entry_odds: -110, result: 'win' });
  chk('8. a price captured after the decision is not the decision\'s price: record only, no units', late.pnl_status === 'PRICE_AFTER_DECISION' && late.record_state === 'RECORD_ONLY'
    && late.pnl_exclusion_reason === 'price_after_decision' && late.flat_profit_units === null, late);
  const q = PL.index([quote('g8', 'spread', '2026-09-19T13:07:00Z', { home_line: -3, price_home: -110, price_away: -110 })]).g8;
  const r = PL.marketAt(q, 'spread', { decided_at: '2026-09-19T12:00:00Z', kickoff: '2026-09-20T17:00:00Z' });
  chk('8. a stored snapshot newer than the decision is not eligible for the backfill', r.status === 'price_after_decision' && r.why === 'after_decision', r);
}

/* ================================================== the as-of lookup */
function quote(game, mt, at, o) {
  return Object.assign({ game_id: game, season: 2026, source: 'espn', book: 'draftkings', market_type: mt, home_line: null, total_points: null, price_home: null, price_away: null,
    price_over: null, price_under: null, observed_at: at, kickoff_ts: '2026-09-20T17:00:00.000Z', is_pregame: true, is_provider_open: false, is_provider_close: false,
    quote_id: 'cfbq_' + Buffer.from(game + mt + at).toString('hex').slice(0, 24) }, o);
}
{
  const ko = '2026-09-20T17:00:00.000Z', T = '2026-09-19T12:00:00.000Z';
  const Q = PL.index([
    quote('g', 'spread', '2026-09-19T05:07:00Z', { home_line: -3.5, price_home: -115, price_away: -105 }),
    quote('g', 'spread', '2026-09-19T11:07:00Z', { home_line: -3.5, price_home: -108, price_away: -112 }),
    quote('g', 'spread', '2026-09-19T12:07:00Z', { home_line: -3, price_home: -110, price_away: -110 }),
    quote('g', 'total', '2026-09-18T12:07:00Z', { total_points: 51.5, price_over: -110, price_under: -110 }),
    quote('g', 'moneyline', '2026-09-19T09:07:00Z', { price_home: -165, price_away: 140 }),
    quote('g', 'moneyline', '2026-09-19T09:07:00Z', { book: 'consensus', price_home: -150, price_away: 130 }),
    quote('g', 'spread', '2026-09-20T17:30:00Z', { home_line: -6, price_home: -110, price_away: -110, is_pregame: false, is_provider_close: true })
  ]).g;
  const sp = PL.marketAt(Q, 'spread', { decided_at: T, kickoff: ko });
  chk('as of the decision: the latest stored quote at or before it (11:07, not 12:07)', sp.status === 'locked' && sp.quote.observed_at === '2026-09-19T11:07:00.000Z' && sp.quote.prices.home === -108, sp);
  chk('a close or a provider average is never a decision price', Q.every((q) => q.book !== 'consensus' && q.observed_at < ko));
  const tot = PL.marketAt(Q, 'total', { decided_at: T, kickoff: ko });
  chk('a quote older than the 6-hour heartbeat is stale: no price', tot.status === 'historical_price_unavailable' && tot.why === 'stale', tot);
  const near90 = PL.marketAt(Q, 'spread', { decided_at: '2026-09-20T15:00:00.000Z', kickoff: ko });
  chk('inside 3 h of kickoff the limit is the decision engine\'s 90 minutes', near90.status === 'historical_price_unavailable' && near90.why === 'stale' && /90-minute/.test(near90.detail), near90);
  const lock = PL.lockPick(Q, { decided_at: T, kickoff: ko, prefer_book: 'DraftKings', now: '2026-10-03T00:00:00.000Z' }).lock;
  chk('the lock holds each market as stored at the decision', lock.spread.status === 'locked' && lock.moneyline.status === 'locked' && lock.total.status === 'historical_price_unavailable');
  chk('the graded number at the stored price: home −3.5 at −108', PL.priceFor(lock.spread, { market_type: 'spread', side: 'home', line: -3.5 }).odds === -108);
  chk('the other side of the same number: away +3.5 at −112', PL.priceFor(lock.spread, { market_type: 'spread', side: 'away', line: 3.5 }).odds === -112);
  const moved = PL.priceFor(lock.spread, { market_type: 'spread', side: 'home', line: -3 });
  chk('a selection graded at another number has no price (the line moved): never interpolated', moved.status === 'historical_price_unavailable' && moved.why === 'line_moved' && /−3\.5|-3\.5/.test(moved.detail), moved);
  chk('a moneyline has no number: its side\'s stored price', PL.priceFor(lock.moneyline, { market_type: 'moneyline', side: 'away', line: null }).odds === 140);
  /* THE LOCK IS IMMUTABLE: the market moves after the decision, the lock does not */
  const later = Q.concat(PL.index([quote('g', 'spread', '2026-09-19T11:30:00Z', { home_line: -4, price_home: 100, price_away: -120 }),
    quote('g', 'moneyline', '2026-09-19T11:50:00Z', { price_home: -200, price_away: 170 })]).g);
  const again = PL.lockPick(later, { decided_at: T, kickoff: ko, prefer_book: 'DraftKings', now: '2026-10-04T00:00:00.000Z' }, lock);
  chk('a locked market is never rewritten, even by a quote that would have been the as-of price', !again.changed || (again.lock.spread.observed_at === lock.spread.observed_at && again.lock.moneyline.prices.away_ml === 140));
  chk('… and its lock time stays the first one', again.lock.spread.locked_at === '2026-10-03T00:00:00.000Z');
  const late = PL.lockPick(Q.concat(PL.index([quote('g', 'total', '2026-09-19T10:07:00Z', { total_points: 50.5, price_over: -105, price_under: -115 })]).g),
    { decided_at: T, kickoff: ko, now: '2026-10-04T00:00:00.000Z' }, lock);
  chk('a miss is looked up again: a quote committed late but observed before the decision fills it', late.changed && late.lock.total.status === 'locked' && late.lock.total.prices.under === -115);
  const twice = PL.lockPick(Q, { decided_at: T, kickoff: ko, prefer_book: 'DraftKings', now: '2026-10-05T00:00:00.000Z' }, lock);
  chk('9. the lookup run twice changes nothing', twice.changed === false);
  const oneSided = PL.index([quote('h', 'moneyline', '2026-09-19T11:07:00Z', { price_home: -150, price_away: null })]).h;
  const os1 = PL.lockPick(oneSided, { decided_at: T, kickoff: ko }).lock;
  chk('a quote with no price for this side gives no price', PL.priceFor(os1.moneyline, { market_type: 'moneyline', side: 'away' }).why === 'no_side_price');
  chk('nothing stored: no_snapshot', PL.marketAt([], 'spread', { decided_at: T, kickoff: ko }).why === 'no_snapshot');
}

/* ================================================== end to end, with a backfill */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vpnl-'));
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true }); fs.writeFileSync(path.join(TMP, rel), text); };
const jsonl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
try {
  const KO = '2026-09-20T17:00:00.000Z', PUB = '2026-09-19T12:00:00.000Z';
  /* a CFB model record: one graded game. The model published UTAH −6.2 at
     12:00; the close was UTAH −3.5 (the model's side: home); final 31–24. */
  const C = FR.emptyLedger('cfb', 2026);
  const proj = FR.projectionFromSlate('cfb', { model_status: 'PREDICTED', game_id: '401999001', season: 2026, week: 3, kickoff: KO, home_team: 'Utah', away_team: 'Arkansas',
    model_home_line: -6.2, model_fair_total: 52.1, model_home_win_prob: 0.68, model_version: 'edgedesk_cfb_p4_v1.0.0', home_division: 'fbs', away_division: 'fbs' }, { season: 2026 });
  FR.recordProjection(C, proj, { published_at: PUB });
  const e = C.games['401999001'];
  FR.setClose(e, { home_line: -3.5, total: 50.5, source: 'espn', book: 'DraftKings', prices: { home: -115, away: -105, over: -110, under: -110, home_ml: -170, away_ml: 145 } }, '2026-09-20T17:30:00.000Z');
  FR.setFinal(e, { home_score: 31, away_score: 24, source: 'espn' }, '2026-09-21T02:00:00.000Z');
  FR.gradeLedger(C, '2026-09-22T00:00:00.000Z');
  put('record/football/cfb_2026.json', JSON.stringify(C));
  /* a player prop: −115, 0.5u, WIN */
  put('football/props/nfl/2026/evaluations.jsonl', jsonl([{ kind: 'qualified', evaluation_id: 'ppe_m', league: 'nfl', season: 2026, week: 3, game_id: '2026_03_KC_DEN', kickoff: KO,
    player_id: '00-0033873', player_name: 'Patrick Mahomes', team: 'KC', opp: 'DEN', position: 'QB', market: 'pass_yds', evaluated_at: '2026-09-19T12:00:00.000Z',
    quote_captured_at: '2026-09-19T11:58:00.000Z', decision: 'BET', units: 0.5, side: 'over', line: 274.5, american: -115, book: 'draftkings', p_side: 0.58, ev: 0.08, edge_pp: 4, model_mean: 290, model_version: 'edgedesk_props_model_v1' }]));
  put('football/props/nfl/2026/results.jsonl', jsonl([{ evaluation_id: 'ppe_m', kind: 'qualified', result: 'WIN', value: 301, graded_at: '2026-09-21T09:00:00.000Z' }]));
  const build = (now) => L.build({ root: TMP, out: 'record/pnl', season: 2026, now });
  const write = (B) => { fs.mkdirSync(path.dirname(B.files.ledger), { recursive: true }); fs.writeFileSync(B.files.ledger, JSON.stringify(B.ledger)); };
  const byId = (B) => { const o = {}; B.ledger.rows.forEach((x) => { o[x.recommendation_id] = x; }); return o; };

  /* the ledger as it stands today: the model record never priced */
  const B0 = build('2026-09-30T00:00:00.000Z'); write(B0);
  const R0 = byId(B0);
  chk('before the backfill: every model-record decision is record only', ['spread', 'total', 'moneyline'].every((m) => R0['mr:cfb:401999001:' + m].record_state === 'RECORD_ONLY'
    && R0['mr:cfb:401999001:' + m].pnl_exclusion_reason === 'historical_price_unavailable'));
  chk('10. the prop: −115 at 0.5u won +0.434783u (stored), an explicit stake', near(R0['pp:ppe_m'].profit_units, 0.434783) && R0['pp:ppe_m'].stake_source === 'explicit' && R0['pp:ppe_m'].pnl_verified);

  /* EdgeDesk's stored quotes for that game: before and after the number */
  put('football/cfb_lab/ledger/2026/quotes/week_03.jsonl', jsonl([
    quote('401999001', 'spread', '2026-09-19T11:07:00Z', { home_line: -3.5, price_home: -108, price_away: -112 }),
    quote('401999001', 'total', '2026-09-19T11:07:00Z', { total_points: 52.5, price_over: -110, price_under: -110 }),
    quote('401999001', 'moneyline', '2026-09-19T11:07:00Z', { price_home: -165, price_away: 140 }),
    quote('401999001', 'spread', '2026-09-19T14:07:00Z', { home_line: -3.5, price_home: -125, price_away: 105 })
  ]));
  /* THE BACKFILL: the record's lock step, then the ledger */
  const quotes = PL.readQuotes(TMP, 2026, 'CFB');
  chk('the lock step reads the stored quotes from disk', (quotes['401999001'] || []).length === 4);
  chk('it locks the pick', FR.lockPrice(e, quotes['401999001'], '2026-10-03T00:00:00.000Z') === true && e.pick.price_lock.spread.status === 'locked');
  chk('9. run again it changes nothing', FR.lockPrice(e, quotes['401999001'], '2026-10-04T00:00:00.000Z') === false);
  put('record/football/cfb_2026.json', JSON.stringify(C));
  const B1 = build('2026-10-03T01:00:00.000Z'); write(B1);
  const R1 = byId(B1);
  const sp = R1['mr:cfb:401999001:spread'], tot = R1['mr:cfb:401999001:total'], ml = R1['mr:cfb:401999001:moneyline'];
  chk('the spread decision (UTAH −3.5, graded at the close) is priced at the quote stored BEFORE the number: −108, not the later −125',
    sp.pnl_verified && sp.entry_odds === -108 && sp.odds_captured_at === '2026-09-19T11:07:00.000Z' && sp.price_source === 'snapshot', sp);
  chk('… at the default stake, stored as defaulted', sp.stake_units === 1 && sp.stake_source === 'default' && sp.profit_units === 0.925926, [sp.stake_units, sp.stake_source, sp.profit_units]);
  chk('… with its provenance: the quote, its game and its number', sp.price_ref.event_id === '401999001' && sp.price_ref.line === -3.5 && sp.price_ref.decided_at === PUB.replace('Z', '').replace(/\.000$/, '') + '.000Z');
  chk('the total stood at 52.5 when the number was published; graded at 50.5 it has no price', !tot.pnl_verified && tot.pnl_exclusion_reason === 'historical_price_unavailable'
    && tot.price_lookup.why === 'line_moved' && tot.entry_odds == null, tot.price_lookup);
  chk('the moneyline is priced: UTAH −165 won +0.606061u', ml.pnl_verified && ml.entry_odds === -165 && ml.profit_units === 0.606061, [ml.entry_odds, ml.profit_units]);
  chk('the lock happened once, and was counted', B1.report.price_locked === 2, B1.report);
  chk('a price lock on a record-only row is not an integrity alert', B1.report.integrity_alerts.length === 0, B1.report.integrity_alerts);
  const V1 = B1.summary.verified;
  chk('graded = verified priced + record only (4 = 3 + 1)', V1.reconcile.ok && V1.reconcile.graded === 4 && V1.reconcile.priced === 3 && V1.reconcile.record_only === 1, V1.reconcile);
  chk('the row audit is clean', V1.audit.errors === 0, V1.audit);
  const card = V1.views.all.staked;
  chk('the card: net = 0.925926 + 0.606061 + 0.434783 = +1.97u over 2.5u risked, ROI 78.67%', card.n === 3 && card.net_units === 1.97 && card.risked_units === 2.5 && card.roi_pct === 78.67, card);
  chk('the card by market: spread 1, total 0 (record only 1), moneyline 1, props 1', card.markets.map((m) => m.type + ':' + m.n + ':' + m.record_only).join() === 'spread:1:0,total:0:1,moneyline:1:0,player_prop:1:0');
  chk('a market with no settled priced decision shows no units and no ROI, never 0.00u / 0%', card.markets[1].net_units === null && card.markets[1].roi_pct === null);

  /* 9. the backfill again, and the market moving after it: nothing duplicates, nothing moves */
  put('football/cfb_lab/ledger/2026/quotes/week_04.jsonl', jsonl([quote('401999001', 'spread', '2026-09-19T11:30:00Z', { home_line: -3.5, price_home: 110, price_away: -130 })]));
  const q2 = PL.readQuotes(TMP, 2026, 'CFB');
  FR.lockPrice(e, q2['401999001'], '2026-10-05T00:00:00.000Z');
  put('record/football/cfb_2026.json', JSON.stringify(C));
  const B2 = build('2026-10-05T01:00:00.000Z'); write(B2);
  const R2 = byId(B2);
  chk('9. a repeated backfill duplicates nothing', B2.ledger.rows.length === B1.ledger.rows.length && new Set(B2.ledger.rows.map((x) => x.recommendation_id)).size === B2.ledger.rows.length);
  chk('9. … and changes no locked price, even when a quote that would have been the as-of price lands later', R2['mr:cfb:401999001:spread'].entry_odds === -108 && B2.report.price_locked === 0);
  chk('9. … and the P&L is identical', B2.summary.verified.views.all.staked.net_units === card.net_units);
  /* a source that later tries to re-price a locked row is refused and reported */
  const forged = JSON.parse(JSON.stringify(C));
  forged.games['401999001'].pick.price_lock.spread.prices.home = -200;
  put('record/football/cfb_2026.json', JSON.stringify(forged));
  const B3 = build('2026-10-06T01:00:00.000Z');
  chk('a source that re-prices a locked decision is refused: the ledger keeps the locked price and raises an alert',
    byId(B3)['mr:cfb:401999001:spread'].entry_odds === -108 && B3.report.integrity_alerts.some((a) => a.field === 'entry_odds'), B3.report.integrity_alerts);

  /* THE EVIDENCE the sync copies to model_pnl_quotes: every quote a locked price cites, from the committed ledger it lives in */
  const SY = require('./pnl_sync.js');
  const cited = B1.ledger.rows.filter((x) => x.price_source === 'snapshot');
  const ev = SY.citedQuotes(B1.ledger, TMP, 2026);
  chk('the sync finds every quote a locked price cites, in its committed ledger', cited.length > 0 && ev.missing.length === 0
    && ev.rows.length === new Set(cited.map((x) => x.price_ref.quote_id)).size, [cited.length, ev.rows.length, ev.missing]);
  chk('… each one the same game, time and price the lock recorded', cited.every((x) => { const q = ev.rows.find((r) => r.quote_id === x.price_ref.quote_id);
    const px = x.market_type === 'total' ? (x.side === 'over' ? q.price_over : q.price_under) : (x.side === 'home' ? q.price_home : q.price_away);
    return q && q.game_id === x.event_id && q.observed_at === x.odds_captured_at && px === x.entry_odds && q.source === x.price_ref.source && Date.parse(q.observed_at) <= Date.parse(x.recommended_at); }));
  const ghost = { rows: [Object.assign({}, cited[0], { price_ref: Object.assign({}, cited[0].price_ref, { quote_id: 'nope' }) })] };
  chk('… and a cited quote that is in no committed ledger is named, not skipped', SY.citedQuotes(ghost, TMP, 2026).missing.some((m) => m.quote_id === 'nope'));

  /* where stored prices begin: a decision published before its league's
     every-game quote ledger began is record only, and says so */
  const nfl = core.modelPricing({ game_id: 'x', pick: { at: PUB } }, 'NFL', 'spread', 'home', -3, (b) => b, { NFL: null });
  chk('an NFL model decision with no stored quote, before the NFL quote ledger began: record only, before_capture', nfl.price_lookup.why === 'before_capture'
    && nfl.price_lookup.status === 'historical_price_unavailable' && /not started yet/.test(nfl.price_lookup.detail) && nfl.entry_odds === undefined, nfl.price_lookup);
  const early = core.modelPricing({ game_id: 'x', pick: { at: '2026-09-20T12:00:00Z' } }, 'CFB', 'total', 'over', 50, (b) => b, { CFB: '2026-10-03T15:47:00.000Z' });
  chk('… a college decision published before the first stored quote names when the prices begin', early.price_lookup.why === 'before_capture' && /2026-10-03T15:47:00.000Z/.test(early.price_lookup.detail));
  const late = core.modelPricing({ game_id: 'x', pick: { at: '2026-10-04T12:00:00Z' } }, 'CFB', 'total', 'over', 50, (b) => b, { CFB: '2026-10-03T15:47:00.000Z' });
  chk('… one published after it with nothing stored is a plain no_snapshot (never blamed on the start date)', late.price_lookup.why === 'no_snapshot');
  const missLock = core.modelPricing({ game_id: 'x', pick: { at: '2026-09-20T12:00:00Z', price_lock: { total: { status: 'historical_price_unavailable', why: 'stale', detail: 'old' } } } }, 'CFB', 'total', 'over', 50, (b) => b, { CFB: '2026-10-03T15:47:00.000Z' });
  chk('… a lookup that found a quote keeps its own reason (stale stays stale)', missLock.price_lookup.why === 'stale', missLock.price_lookup);
  const noSrc = core.modelPricing({ game_id: 'x', pick: { at: PUB } }, 'UFL', 'spread', 'home', -3, (b) => b, {});
  chk('… a league with no stored-quote source at all: no_snapshot_source', noSrc.price_lookup.why === 'no_snapshot_source');
  const evf = PL.everyGameFrom([{ key: 'cfb_lab_quotes', league: 'CFB', covers: 'lab_games', first_capture: '2026-09-27T15:07:15.000Z' },
    { key: 'record_quotes', league: 'CFB', covers: 'every_model_game', first_capture: '2026-10-03T15:47:00.000Z' }, { key: 'record_quotes', league: 'NFL', covers: 'every_model_game', first_capture: null }]);
  chk('the earliest every-game point per league: the lab\'s 71 games do not count as every game; a league with nothing stored yet is null', evf.CFB === '2026-10-03T15:47:00.000Z' && evf.NFL === null, evf);
  chk('the summary says where the stored prices begin', B1.summary.verified.price_sources && 'CFB' in B1.summary.verified.price_sources.every_game_from
    && B1.summary.verified.price_sources.sources.some((x) => x.key === 'record_quotes' && x.league === 'NFL'), B1.summary.verified.price_sources);

  /* ============================================ the row audit names every fault */
  const good = R1['mr:cfb:401999001:spread'];
  const audit = (o) => P.auditRows([Object.assign({}, good, o)]).map((x) => x.check);
  chk('audit: a verified row with null odds', audit({ entry_odds: null }).indexOf('verified_without_odds') >= 0);
  chk('audit: odds of 0', audit({ entry_odds: 0, record_state: 'RECORD_ONLY' }).indexOf('odds_zero') >= 0);
  chk('audit: a price later than the decision', audit({ odds_captured_at: '2026-09-19T13:00:00.000Z' }).indexOf('price_after_decision') >= 0);
  chk('audit: a verified row with no result', audit({ result: null }).indexOf('verified_without_result') >= 0);
  chk('audit: profit that does not match stake × odds × result', audit({ profit_units: 1.5 }).indexOf('profit_mismatch') >= 0);
  chk('audit: a stored-quote price for another game', audit({ price_ref: Object.assign({}, good.price_ref, { event_id: 'other' }) }).indexOf('snapshot_event_mismatch') >= 0);
  chk('audit: a stored-quote price for another number', audit({ price_ref: Object.assign({}, good.price_ref, { line: -4 }) }).indexOf('snapshot_line_mismatch') >= 0);
  chk('audit: a verified prop with no player', P.auditRows([Object.assign({}, R1['pp:ppe_m'], { player_id: null, player_name: null })]).some((x) => x.check === 'prop_without_player'));
  chk('audit: one decision twice', P.auditRows([good, good]).some((x) => x.check === 'duplicate_id'));
  chk('audit: a clean ledger has no fault', P.auditRows(B1.ledger.rows).length === 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' Verified P&L — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
