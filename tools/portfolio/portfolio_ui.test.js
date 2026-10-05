#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_portfolio_ui.js rendered in Node, and its wiring in app.html.

     - the overview answers "am I up or down?" before anything else, with the
       split, the platforms and the open exposure — and an empty book shows no
       sample figure at all;
     - open positions read like the spec: "$100 @ −110 · Risk · Potential
       profit" and "contracts · average entry · cost basis · current value";
     - nothing the reader typed can become markup;
     - no account is ever called "Connected" unless the server connected it;
     - the copy carries no tout or loss-chasing language;
     - the CSV export cannot smuggle a spreadsheet formula;
     - app.html loads the six files in order, owns a #v-portfolio view, routes
       to it, lists it in More, and leaves the seven-seat bar alone.

   Run: node tools/portfolio/portfolio_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const U = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_ui.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

function pos(over, fills) {
  const p = Object.assign({ id: 'p' + Math.random().toString(16).slice(2), platform_type: 'SPORTSBOOK', platform: 'draftkings', platform_label: 'DraftKings', sport: 'NFL',
    position_type: 'SPREAD', event_name: 'Chiefs @ Bills', market_name: 'Spread', selection: 'Chiefs -2.5', stake: '100', odds_american: -110, status: 'WON',
    placed_at: '2026-09-07T17:00:00Z', settled_at: '2026-09-07T21:00:00Z', source: 'MANUAL' }, over);
  Object.assign(p, E.derive(p, fills));
  if (p.status === 'OPEN') p.settled_at = null;
  return p;
}
const BOOK = [
  pos({}),
  pos({ platform: 'fanduel', platform_label: 'FanDuel', status: 'LOST', stake: '200', odds_american: 120, selection: 'Jets ML', event_name: 'Jets @ Giants', position_type: 'MONEYLINE', settled_at: '2026-09-08T21:00:00Z' }),
  pos({ platform: 'draftkings', status: 'OPEN', selection: 'Chiefs -2.5 (open)', placed_at: '2026-10-03T17:00:00Z' }),
  pos({ platform_type: 'PREDICTION_MARKET', platform: 'kalshi', platform_label: 'Kalshi', sport: null, position_type: 'EVENT_CONTRACT', event_name: 'Will X happen?', market_name: 'Will X happen?',
    selection: 'YES', side: 'YES', status: 'OPEN', current_price: '0.68', current_price_at: '2026-10-03T12:00:00Z', placed_at: '2026-10-01T12:00:00Z' }, [{ transaction_type: 'BUY', quantity: '100', price: '0.61', fee: '0' }]),
  pos({ platform_type: 'PREDICTION_MARKET', platform: 'polymarket', platform_label: 'Polymarket', sport: null, position_type: 'EVENT_CONTRACT', event_name: 'Who wins?', market_name: 'Who wins?',
    selection: 'Chiefs', side: 'Chiefs', resolution: 'Chiefs', settled_at: '2026-09-20T12:00:00Z', placed_at: '2026-09-01T12:00:00Z' }, [{ transaction_type: 'BUY', quantity: '100', price: '0.40', fee: '0.25' }])
];
const S = Object.assign(U.defaults(), { positions: BOOK, accounts: [], tz: 'UTC', now: Date.parse('2026-10-04T12:00:00Z') });

/* ═══ OVERVIEW ══════════════════════════════════════════════════════════ */
let h = U.render.overview(S), t = strip(h);
const first = (re) => t.search(re);
chk('the overview leads with TOTAL P&L', first(/Total P&L/i) >= 0 && first(/Total P&L/i) < first(/ROI/), t.slice(0, 200));
chk('the total is settled P&L: 90.91 − 200 + 59.75 = −$49.34', /−\$49\.34/.test(t), t.slice(0, 300));
chk('and says it plainly, in words', /Down \$49\.34 across 3 settled positions on 3 platforms/.test(t), t.slice(0, 300));
chk('ROI, capital deployed, open exposure and the record are on the first card', /ROI\s*−/.test(t) && /Capital deployed\s*\$501\.00/.test(t) && /Open exposure\s*\$161\.00\s*2 open/.test(t) && /Record\s*2-1-0/.test(t), t.slice(0, 600));
chk('sportsbook and prediction-market P&L are shown separately', /Sportsbook P&L\s*−\$109\.09/.test(t) && /Prediction-market P&L\s*\+\$59\.75/.test(t));
chk('P&L by platform, every platform with a settled position', /DraftKings/.test(t) && /FanDuel/.test(t) && /Polymarket/.test(t));
chk('the cumulative chart is drawn', /<svg class="pfo-chart"/.test(h) && /<polyline/.test(h));
chk('open positions are summarized with their unrealized mark, labelled as the reader\'s', /Marked to the prices you entered: \+\$7\.00/.test(t));
const empty = strip(U.render.overview(Object.assign({}, S, { positions: [] })));
chk('an empty book shows no figure at all — no sample data', /Build your portfolio/.test(empty) && !/\$\d/.test(empty), empty);
chk('and says how to build one: connect accounts first, then import or record by hand', /Connect accounts\s+Import a CSV\s+Record a sportsbook bet/.test(empty), empty);

/* ═══ OPEN ══════════════════════════════════════════════════════════════ */
t = strip(U.render.open(S));
chk('open sportsbook bet: "$100.00 @ −110", risk and potential profit', /\$100\.00 @ −110/.test(t) && /Risk \$100\.00/.test(t) && /Potential profit \$90\.91/.test(t), t.slice(0, 500));
chk('open contract: contracts, average entry, cost basis, current value, unrealized', /Contracts 100/.test(t) && /Average entry \$0\.61/.test(t) && /Cost basis \$61\.00/.test(t) && /Current value \$68\.00/.test(t) && /Unrealized P&L \+\$7\.00/.test(t), t);
chk('settled positions are not open', !/Jets ML/.test(t));
let only = strip(U.render.open(Object.assign({}, S, { openFilter: { kind: 'PREDICTION_MARKET', platform: '', sport: '', placed: '' } })));
chk('the Sportsbook / Prediction market filter', /Will X happen/.test(only) && !/Chiefs -2\.5 \(open\)/.test(only));
only = strip(U.render.open(Object.assign({}, S, { openFilter: { kind: 'ALL', platform: 'draftkings', sport: '', placed: '' } })));
chk('the platform filter', /Chiefs -2\.5 \(open\)/.test(only) && !/Will X happen/.test(only));
chk('no live figure is shown without a live feed', !/pfo-live/.test(U.render.open(S)));
const withLive = U.render.open(Object.assign({}, S, { live: (p) => (p.selection === 'Chiefs -2.5 (open)' ? { label: 'Receiving yards', current: 25, line: 58.5 } : null) }));
chk('a live provider, once one exists, attaches to the position it names', /Receiving yards/.test(strip(withLive)) && /current 25/.test(strip(withLive)));

/* ═══ HISTORY ═══════════════════════════════════════════════════════════ */
t = strip(U.render.history(S));
chk('history: settled positions with platform, event, market, selection, stake, odds, result, P&L', /DraftKings/.test(t) && /Chiefs @ Bills/.test(t) && /Spread/.test(t) && /\$100\.00/.test(t) && /−110/.test(t) && /Win/.test(t) && /\+\$90\.91/.test(t));
const q = (f) => U.filterHistory(Object.assign({}, S, { histFilter: Object.assign(U.defaults().histFilter, f) })).map((p) => p.selection);
chk('search', JSON.stringify(q({ q: 'jets' })) === JSON.stringify(['Jets ML']));
chk('filter by result', JSON.stringify(q({ result: 'LOSS' })) === JSON.stringify(['Jets ML']));
chk('filter by platform type', JSON.stringify(q({ kind: 'PREDICTION_MARKET' })) === JSON.stringify(['Chiefs']));
chk('filter by source', q({ source: 'CSV' }).length === 0 && q({ source: 'MANUAL' }).length === 3);
chk('filter by date (settled date, inclusive)', JSON.stringify(q({ from: '2026-09-08', to: '2026-09-08' })) === JSON.stringify(['Jets ML']));
chk('"All" includes the open positions', q({ state: '' }).length === 5);

/* ═══ ANALYTICS ═════════════════════════════════════════════════════════ */
t = strip(U.render.analytics(S));
chk('analytics compares sportsbook, prediction market and combined', /Sportsbook Prediction Combined/.test(t) && /P&L −\$109\.09 \+\$59\.75 −\$49\.34/.test(t), t.slice(0, 700));
chk('win rate, average stake, average odds, average contract entry, fees', /Win rate/.test(t) && /Average stake/.test(t) && /Average odds/.test(t) && /Average contract entry \$0\.505/.test(t) && /Fees paid \$0\.25/.test(t), t.slice(600, 1400));
chk('best and worst platform', /Best platform DraftKings \+\$90\.91/.test(t) && /Worst platform FanDuel −\$200\.00/.test(t), t.slice(t.indexOf('Best and worst'), t.indexOf('Best and worst') + 300));
chk('attribution is described as recorded, never inferred', /never infers it from a matching event/.test(t));
chk('7D excludes what settled earlier', /Nothing placed or settled in this period|Settled 0 0 0/.test(strip(U.render.analytics(Object.assign({}, S, { period: '7D' })))));

/* ═══ ACCOUNTS ══════════════════════════════════════════════════════════ */
const accts = [
  { id: 'a1', platform: 'draftkings', platform_label: 'DraftKings', platform_type: 'SPORTSBOOK', connection_type: 'MANUAL', status: 'MANUAL', positions: 3, open_positions: 1, last_position_at: '2026-10-03T17:00:00Z' },
  { id: 'a2', platform: 'kalshi', platform_label: 'Kalshi', platform_type: 'PREDICTION_MARKET', connection_type: 'CSV', status: 'IMPORT_ONLY', positions: 0, open_positions: 0, last_import_at: '2026-10-02T17:00:00Z' }
];
t = strip(U.render.accounts(Object.assign({}, S, { accounts: accts })));
chk('accounts say how each platform is tracked', /DraftKings/.test(t) && /Manual tracking/.test(t) && /Kalshi/.test(t) && /CSV import/.test(t));
chk('and never say "Connected" for a manual or CSV account', !/\bConnected\b/.test(t));
chk('how each platform comes in: a sportsbook by file (no sportsbook API), never a password', /DraftKings\s*Import a file — no sportsbook offers customers an API/.test(t) && /never asks for a sportsbook password/.test(t), t);
chk('Kalshi reads as being tested, not as connectable, until the database switches it on', /Kalshi\s*Import a file \(automatic connection is built and being tested/.test(t) && !/data-act="acct-connect"/.test(U.render.accounts(Object.assign({}, S, { accounts: accts }))));
chk('remove is offered only for an account with no positions', (U.render.accounts(Object.assign({}, S, { accounts: accts })).match(/remove-account/g) || []).length === 1);
const live = strip(U.render.accounts(Object.assign({}, S, { accounts: [{ id: 'x', platform: 'kalshi', platform_label: 'Kalshi', platform_type: 'PREDICTION_MARKET', connection_type: 'API', status: 'CONNECTED', positions: 4, open_positions: 0, last_sync_at: '2026-10-04T11:57:00Z', last_success_at: '2026-10-04T11:57:00Z' }] })));
chk('a real API account shows Connected with when it last synced', /Connected/.test(live) && /Last synced/.test(live));
/* the honest statuses of an automatic account */
const autoAcct = (o) => Object.assign({ id: 'y', platform: 'kalshi', platform_label: 'Kalshi', platform_type: 'PREDICTION_MARKET', connection_type: 'API', ingestion_method: 'API_KEY',
  positions: 0, open_positions: 0, credential: { hint: '…608c', scopes: ['read'] } }, o);
const st1 = (o, extra) => strip(U.render.accounts(Object.assign({}, S, { positions: [{}], accounts: [autoAcct(o)] }, extra || {})));
chk('a first sync that has not finished reads Syncing, never Connected', /Syncing/.test(st1({ status: 'SYNCING' })) && !/\bConnected\b/.test(st1({ status: 'SYNCING' })) && /nothing has synced yet/.test(st1({ status: 'SYNCING' })));
chk('a refused key reads Action required, with the reason and no retry', /Action required/.test(st1({ status: 'ACTION_REQUIRED', last_error: 'The platform rejected the key.' })) && /rejected the key/.test(st1({ status: 'ACTION_REQUIRED', last_error: 'The platform rejected the key.' })));
chk('repeated failures read Sync failing, with the next retry', /Sync failing/.test(st1({ status: 'ERROR', last_error: 'down' }, { connections: { y: { consecutive_failures: 5, next_sync_at: '2026-10-04T13:00:00Z' } } })));
chk('a disconnected account keeps its history and says so', /Disconnected/.test(st1({ status: 'DISCONNECTED' })) && /history is kept/.test(st1({ status: 'DISCONNECTED' })));
chk('the key is shown by its hint only, with how it connects', /Read-only API key …608c/.test(st1({ status: 'CONNECTED', last_success_at: '2026-10-04T11:57:00Z' })));
const runs = [{ platform_account_id: 'y', started_at: '2026-10-04T11:57:00Z', status: 'PARTIAL', transactions_inserted: 3, rejected: 1, issues: [{ code: 'REJECTED', message: 'more contracts sold than bought' }], reconcile: { ok: false } }];
chk('the sync log shows what each run did, what it rejected and why, and a repair', (() => { const x = st1({ status: 'CONNECTED', last_success_at: '2026-10-04T11:57:00Z' }, { runs }); return /\+3 trades/.test(x) && /1 rejected/.test(x) && /more contracts sold than bought/.test(x) && /rebuilding on the next sync/.test(x); })());
const onH = U.render.accounts(Object.assign({}, S, { positions: [{}], accounts: [autoAcct({ status: 'DISCONNECTED' }), Object.assign({}, accts[1], { platform: 'polymarket' })], registry: { kalshi: { automatic_enabled: true, automatic_method: 'API_KEY' }, polymarket: { automatic_enabled: true, automatic_method: 'PUBLIC_WALLET' } } }));
chk('once switched on: Reconnect for a disconnected account, Connect automatically to upgrade a quick-import one in place', /data-act="acct-connect" data-platform="kalshi">Reconnect/.test(onH) && /data-act="acct-connect" data-platform="polymarket">Connect automatically/.test(onH));
/* setup: choose, bring in, ready — progress from the reader's own data */
const fresh = Object.assign(U.defaults(), { positions: [], accounts: [], tz: 'UTC' });
let su = strip(U.render.accounts(fresh));
chk('a new reader sees setup: where do you bet or trade, every platform to choose', U.setupVisible(fresh) && /Set up your portfolio/.test(su) && /Where do you bet or trade\?/.test(su) && /DraftKings/.test(su) && /Polymarket/.test(su) && !/Portfolio ready/.test(su));
const picked = Object.assign(U.defaults(), { positions: [], accounts: [], tz: 'UTC' }); picked.setup.selected = { draftkings: true, kalshi: true };
chk('choosing platforms offers to add them, all at once', /data-act="setup-add">Add 2 platforms/.test(U.render.accounts(picked)));
const half = Object.assign(U.defaults(), { tz: 'UTC', positions: [pos({})], accounts: [Object.assign({}, accts[0], { positions: 1 }), Object.assign({}, accts[1], { positions: 0 })] });
su = strip(U.render.accounts(half));
chk('progress: each platform says where its history stands, with a total; the rest wait for a file', /1 of 2 platforms with history/.test(su) && /DraftKings\s*Recorded ✓ · 1 position/.test(su)
  && /Kalshi\s*Waiting for import/.test(su) && /Total\s*1 position\b/.test(su), su);
chk('ready: tracked and open positions from the server\'s counts; totals wait for the server, never computed from capped rows', /Your portfolio is ready/.test(su) && /Tracked positions\s*1\b/.test(su)
  && /Open positions\s*1\b/.test(su) && /Total P&L\s*…/.test(su) && /View my portfolio/.test(su), su);
const halfLife = strip(U.render.accounts(Object.assign({}, half, { lifetime: { settled: { n: 1, pnl: '90.91', roi: 0.9091 }, process: { graded: 0 } } })));
const readyText = halfLife.slice(halfLife.indexOf('Your portfolio is ready'), halfLife.indexOf('Your portfolio is ready') + 600);
chk('ready shows only real numbers — no insight is invented before there is a price to judge', /Total P&L\s*\+\$90\.91 1 settled/.test(halfLife) && /ROI\s*\+?90\.9/.test(halfLife)
  && /Process profile\s*Building · 0 of 10 graded/.test(halfLife) && /EdgeDesk shows none until then/.test(halfLife) && !/working|leak|strength/i.test(readyText), readyText);
chk('the process profile is ready only once enough positions are graded', /Process profile\s*Ready · 24 graded/.test(strip(U.render.accounts(Object.assign({}, half, { lifetime: { settled: { n: 30, pnl: '12', roi: 0.01 }, process: { graded: 24 } } })))));
chk('when the totals cannot load, the card says so instead of guessing', /could not be loaded here/.test(strip(U.render.accounts(Object.assign({}, half, { lifetimeError: true })))));
/* step 1 is grouped by how a platform's history can arrive */
const g0 = strip(U.render.accounts(fresh));
chk('setup groups: prediction markets (import now, automatic once switched on), sportsbooks by import, and other', /Prediction markets · import now, automatic once switched on/.test(g0)
  && /Sportsbooks · import/.test(g0) && /Other/.test(g0) && /Import another platform/.test(g0) && /Add manually/.test(g0) && /never asks for a sportsbook password/.test(g0), g0);
chk('the five major sportsbooks, then BetRivers, Fanatics and theScore Bet (ESPN BET) are offered', ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'bet365', 'BetRivers', 'Fanatics', 'theScore Bet']
  .every((x) => g0.indexOf(x) >= 0) && /data-v="espnbet"/.test(U.render.accounts(fresh)));
chk('setup offers no Connect while automatic connection is off', !/data-act="acct-connect"/.test(U.render.accounts(fresh)));
const g1 = U.render.accounts(Object.assign(U.defaults(), { positions: [], accounts: [], tz: 'UTC', registry: { kalshi: { automatic_enabled: true, automatic_method: 'API_KEY' } } }));
chk('once one is switched on, setup offers Connect for it alone, and says the other is imported for now', /data-act="acct-connect" data-platform="kalshi">Connect Kalshi/.test(g1) && !/data-platform="polymarket">Connect/.test(g1)
  && /Kalshi connects automatically and read-only; the other is imported from a file for now/.test(strip(g1)));
const live2 = (o) => strip(U.render.accounts(Object.assign(U.defaults(), { tz: 'UTC', now: Date.parse('2026-10-04T12:00:00Z'), positions: [pos({})],
  accounts: [autoAcct(Object.assign({ positions: 143 }, o)), Object.assign({}, accts[1], { positions: 0 })] })));
chk('a synced account reads "Connected ✓ · 143 positions"; a first sync still running never reads Connected', /Kalshi\s*Connected ✓ · 143 positions/.test(live2({ status: 'CONNECTED', last_success_at: '2026-10-04T11:58:00Z' }))
  && /Kalshi\s*Syncing · 143 positions/.test(live2({ status: 'SYNCING' })) && !/\bConnected\b/.test(live2({ status: 'SYNCING' })));
chk('when it last synced reads in minutes', /Last synced 2 min ago/.test(live2({ status: 'CONNECTED', last_success_at: '2026-10-04T11:58:00Z' })));
const imported = strip(U.render.accounts(Object.assign({}, S, { accounts: [Object.assign({}, accts[1], { positions: 421, last_import_at: '2026-10-03T17:00:00Z' })] })));
chk('a quick-import account with history reads "Quick import", when it was last imported, and offers an import update', /Quick import/.test(imported) && /Last imported/.test(imported) && /Import update/.test(imported) && !/\bConnected\b/.test(imported), imported);
chk('"Add account" opens the grouped platform list', /data-act="setup-open">Add account/.test(U.render.accounts(Object.assign({}, S, { accounts: accts }))));
chk('a reader whose every platform has history sees no setup, only "Add platforms"', !U.setupVisible(Object.assign(U.defaults(), { positions: [pos({})], accounts: [Object.assign({}, accts[0], { positions: 1 })] })));
/* the operator's panel: only for an operator, counts only */
const adm = strip(U.render.accounts(Object.assign({}, half, { isAdmin: true, admin: { health: { platforms: [{ platform: 'kalshi', runs: 9, succeeded: 7, partial: 1, failed: 1, p95_ms: 1800, errors: { RATE_LIMITED: 1 } }], registry: [{ platform: 'kalshi', automatic_enabled: false }] },
  ttv: { onboarding_started: 12, time_to_first_position_minutes_median: 6.5, time_to_portfolio_ready_minutes_median: 11, onboarding_abandonment: 0.25, import_failure_rate: 0.1, connection_failure_rate: null } } })));
chk('operators see connector health and time to value; readers never do', /Operator · connectors/.test(adm) && /RATE_LIMITED 1/.test(adm) && /Median time to first position\s*6\.5 min/.test(adm) && /Setup abandonment \(7\+ days\)\s*25\.0%/.test(adm)
  && !/Operator/.test(strip(U.render.accounts(half))));

/* ═══ IMPORT REVIEW: what was found, what is ready, what needs a look ═══ */
const IMP = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_import.js'));
const dkCsv = ['Bet ID,Placed,Event,Selection,Odds,Stake,Status,Payout', 'DK-1,2024-08-10 13:00,A @ B,A -3,-110,110,Won,210', 'DK-2,2026-10-01 13:00,C @ D,D +3,-110,55,Lost,0'].join('\n');
const staged = IMP.stage(dkCsv, { fileName: 'draftkings_history.csv', timezone: 'UTC' });
const imp0 = (o, extra) => strip(U.render.import(Object.assign(U.defaults(), { tz: 'UTC', accounts: [], imp: Object.assign({ staged, fileName: 'draftkings_history.csv' }, o) }, extra || {})));
let iv = imp0({});
chk('a dropped file says what it detected: platform, wagers found, date range — and how it knew', /Detected: DraftKings · 2 wagers found · Aug 2024 – Oct 2026/.test(iv) && /Platform from the file's name/.test(iv), iv.slice(iv.indexOf('Detected'), iv.indexOf('Detected') + 200));
const unknownIv = strip(U.render.import(Object.assign(U.defaults(), { tz: 'UTC', imp: { staged: IMP.stage(dkCsv, { fileName: 'export.csv', timezone: 'UTC' }), fileName: 'export.csv' } })));
chk('a file it cannot place is not guessed: the reader is asked to choose', /could not tell which platform/.test(unknownIv) && !/Detected:/.test(unknownIv));
const rowsOf = (cls) => cls.map((k, i) => ({ id: 'r' + i, row_number: i + 2, classification: k, normalized: { kind: 'wager', platform_label: 'DraftKings', event_name: 'A @ B', selection: 'A', stake: '10', odds_american: -110, status: 'WON', placed_at: '2026-09-01T13:00:00Z' }, issues: [] }));
iv = imp0({ counts: { total: 5, new: 2, update: 0, duplicate: 1, review: 1, invalid: 1 }, serverRows: rowsOf(['NEW', 'NEW', 'DUPLICATE', 'NEEDS_REVIEW', 'INVALID']) });
chk('review: found / ready / duplicates / need review / cannot import, then [Import n] and [Review n]', /5 Found/.test(iv) && /2 Ready/.test(iv) && /1 Duplicates/.test(iv) && /1 Need review/.test(iv) && /1 Cannot import/.test(iv)
  && /Import 2/.test(iv) && /Review 1/.test(iv) && !/Update portfolio/.test(iv), iv.slice(iv.indexOf('Before anything'), iv.indexOf('Before anything') + 400));
const ivReview = imp0({ reviewOnly: true, counts: { total: 5, new: 2, update: 0, duplicate: 1, review: 1, invalid: 1 }, serverRows: rowsOf(['NEW', 'NEW', 'DUPLICATE', 'NEEDS_REVIEW', 'INVALID']) });
chk('[Review n] narrows the table to the rows that need a look', (ivReview.match(/NEEDS REVIEW/g) || []).length === 1 && !/\bDUPLICATE\b/.test(ivReview) && /Show all rows/.test(ivReview));
iv = imp0({ counts: { total: 26, new: 18, update: 7, duplicate: 1, review: 0, invalid: 0 }, serverRows: rowsOf(['NEW', 'UPDATE', 'DUPLICATE']) },
  { accounts: [{ id: 'a', platform: 'draftkings', platform_label: 'DraftKings', connection_type: 'CSV', positions: 241, last_import_at: '2026-10-03T12:00:00Z' }] });
chk('a newer file from a platform imported before: new, updated, already known — and [Update portfolio]', /18 new positions · 7 updated/.test(iv) && /nothing is counted twice/.test(iv) && /Update portfolio · 1 new, 1 updated/.test(iv), iv.slice(iv.indexOf('Before anything'), iv.indexOf('Before anything') + 500));

/* ═══ BEFORE YOU ENTER: what is already open on the same event ═══ */
const openDK = Object.assign(pos({ status: 'OPEN', settled_at: null, event_name: 'Chiefs at Bills', selection: 'Chiefs -2.5' }), { platform_label: 'DraftKings' });
const openK = Object.assign(pos({ platform: 'kalshi', platform_type: 'PREDICTION_MARKET', status: 'OPEN', settled_at: null, event_name: 'Chiefs @ Bills', selection: 'YES' }), { platform_label: 'Kalshi', open_cost_basis: '40' });
const settledSame = pos({ event_name: 'Chiefs @ Bills' });
const ex = U.exposureOn('chiefs vs bills', [openDK, openK, settledSame, pos({ status: 'OPEN', settled_at: null, event_name: 'Jets @ Dolphins' })]);
chk('exposure on the same event: open positions only, any platform, the event written differently', ex.n === 2 && ex.risk === E.dec.add(openDK.open_cost_basis, '40') && ex.platforms.join() === 'DraftKings,Kalshi', ex);
chk('…and none for an empty event name', U.exposureOn('', [openDK]) === null);

const adm2 = strip(U.render.accounts(Object.assign({}, half, { isAdmin: true, admin: { health: { window_hours: 24,
  platforms: [{ platform: 'kalshi', runs: 4, succeeded: 3, partial: 1, failed: 0, discovered: 812, positions_inserted: 5, transactions_inserted: 40, positions_updated: 9, duplicates_rejected: 760, settlements: 3, rejected: 1, reconciled: 3, reconcile_mismatches: 1, p95_ms: 900, errors: {} }],
  connections: [{ platform: 'kalshi', attempts: 6, connected: 4, failed: 2, disconnected: 1, failures: { WRITE_SCOPE: 1, BAD_CREDENTIAL: 1 } }],
  imports: [{ platform: 'draftkings', files: 7, committed: 5, failed: 1, not_finished: 1, parser_failures: 12, files_with_parser_failures: 2, new_layouts: 1 }] }, ttv: {} } })));
chk('operator diagnostics: discovered, inserted, updated, duplicates rejected, settlements, reconciled; connection attempts and failure codes; parser failures and format changes',
  /kalshi\s*4\s*3\s*1\s*0\s*812\s*45\s*9\s*760\s*3\s*1\s*3 \/ 1 off/.test(adm2) && /Attempts[\s\S]*kalshi\s*6\s*4\s*2\s*1\s*WRITE_SCOPE 1, BAD_CREDENTIAL 1/.test(adm2)
  && /draftkings\s*7\s*5\s*1\s*1\s*12 in 2\s*1 new layout — check the export format/.test(adm2) && /Counts only/.test(adm2), adm2.slice(adm2.indexOf('Operator'), adm2.indexOf('Operator') + 900));

/* ═══ FORMS ═════════════════════════════════════════════════════════════ */
const wf = strip(U.render.wagerForm({ status: 'WON', position_type: 'PARLAY' }, {}));
chk('the sportsbook form has every field the spec names', ['Sportsbook', 'Sport', 'League', 'Event', 'Market type', 'Selection', 'Line', 'American odds', 'Stake', 'Placed', 'Status', 'Settled', 'Amount the book paid', 'Where the idea came from']
  .every((f) => wf.indexOf(f) >= 0), wf);
chk('a parlay explains how a re-priced ticket is entered', /re-priced the ticket/.test(wf));
const pf = strip(U.render.predictionForm({ state: 'RESOLVED' }, {}));
chk('the prediction form: platform, event, market, side, contracts, entry price, fees, opened, resolution', ['Platform', 'Event or question', 'Market', 'Side', 'Contracts', 'Average entry price', 'Fees', 'Opened', 'Resolved as'].every((f) => pf.indexOf(f) >= 0), pf);
let w = U.wagerFromForm({ platform: '__other', platform_other: 'Corner Book', position_type: 'MONEYLINE', event_name: 'A @ B', selection: 'A', odds: '+150', stake: '20', placed_at: '2026-09-07T13:00', status: 'OPEN' });
chk('"Other" sportsbook becomes the reader\'s own platform', w.row.platform === 'custom_corner_book' && w.row.platform_label === 'Corner Book' && w.issues.length === 0, w);
w = U.wagerFromForm({ platform: 'draftkings', position_type: 'SPREAD', event_name: 'A @ B', selection: 'A', odds: '1.91', odds_format: 'decimal', stake: '20', placed_at: '2026-09-07T13:00', status: 'OPEN' });
chk('decimal odds from the form', w.row.odds_decimal === '1.91' && w.row.odds_american === null && w.issues.length === 0);
w = U.wagerFromForm({ platform: '', event_name: '', selection: '', odds: '50', stake: '-1', placed_at: '', status: 'CASHED_OUT' });
chk('the form refuses what the database would refuse, in words', w.issues.filter((x) => x.level === 'error').length >= 5 && w.issues.every((x) => x.message));
let pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'NO', contracts: '50', price: '0.30', placed_at: '2026-09-07T13:00', state: 'SOLD', exit_price: '0.45', settled_at: '2026-09-08T13:00' });
chk('"sold before it resolved" records a buy and a sell', pr.payload.fills.length === 2 && pr.payload.fills[1].action === 'SELL' && pr.payload.fills[1].quantity === '50' && pr.issues.length === 0, pr);
pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'YES', contracts: '10', price: '61', placed_at: '2026-09-07T13:00', state: 'OPEN' });
chk('a price of 61 is not a contract price', pr.issues.some((x) => x.code === 'BAD_PRICE'));
pr = U.predictionFromForm({ platform: 'kalshi', event_name: 'Q?', side: 'YES', contracts: '10', price: '0.6', placed_at: '2026-09-07T13:00', state: 'OPEN', edge_source: 'EDGEDESK', edge_ref: 'stake_recommendation:rec-1' },
  [{ type: 'stake_recommendation', id: 'rec-1', model_version: 'v9', model_probability: '0.62' }]);
chk('an explicit EdgeDesk link carries the record id and its model version', pr.payload.edge_ref_type === 'stake_recommendation' && pr.payload.edge_ref_id === 'rec-1' && pr.payload.model_version === 'v9');
chk('the preview uses the same arithmetic as the database', /payout <b>\$190\.91/.test(U.wagerPreview(U.wagerFromForm({ platform: 'draftkings', event_name: 'A', selection: 'B', odds: '-110', stake: '100', placed_at: '2026-09-07T13:00', status: 'OPEN' }).row)));
chk('a datetime-local value round-trips in the browser\'s own zone', U.isoToLocalInput(U.localInputToIso('2026-09-07T13:00')) === '2026-09-07T13:00');

/* ═══ SAFETY ════════════════════════════════════════════════════════════ */
const evil = '<img src=x onerror=alert(1)>"\'';
const hostile = [pos({ event_name: evil, selection: evil, platform_label: evil, notes: evil, status: 'OPEN' })];
const all = ['overview', 'open', 'history', 'analytics'].map((k) => U.render[k](Object.assign({}, S, { positions: hostile, histFilter: Object.assign(U.defaults().histFilter, { state: '' }) }))).join('')
  + U.render.accounts(Object.assign({}, S, { accounts: [{ id: evil, platform: 'x', platform_label: evil, display_name: evil, platform_type: 'SPORTSBOOK', connection_type: 'MANUAL', status: 'MANUAL', positions: 0 }] }));
chk('nothing a reader typed becomes markup', !/<img/.test(all) && /&lt;img/.test(all));
chk('nor breaks out of an attribute', !/data-id="<img/.test(all) && !/"'/.test(all.replace(/&quot;|&#39;/g, '')));
const csv = U.exportCsv([pos({ event_name: '=HYPERLINK("http://x","y")', selection: '+1 cmd', notes: '@SUM(A1)' })]);
chk('the CSV export neutralizes spreadsheet formulas', /'=HYPERLINK/.test(csv) && /'\+1 cmd/.test(csv) && /'@SUM/.test(csv) && !/,=HYPERLINK/.test(csv));
chk('and quotes what needs quoting', /"'=HYPERLINK\(""http:\/\/x"",""y""\)"/.test(csv));
chk('friendly errors: a duplicate is named as one', U.friendly({ status: 409, pg: { code: '23505', message: 'duplicate key value violates unique constraint "portfolio_positions_fingerprint_once"' } }).dup === true);
chk('friendly errors: the database\'s own sentence, without its prefix', U.friendly({ status: 400, pg: { code: '23514', message: 'portfolio: more contracts sold than bought' } }).text === 'More contracts sold than bought.');
chk('friendly errors: a missing migration says which file', /portfolio\.sql/.test(U.friendly({ status: 404, pg: null }).text));

/* ═══ COPY: factual, never a nudge ══════════════════════════════════════ */
/* the coach's own list of banned words is the one place they may appear */
const SRC = ['edgedesk_portfolio_ui.js', 'edgedesk_portfolio.js', 'edgedesk_portfolio_import.js', 'edgedesk_portfolio_connectors.js', 'edgedesk_portfolio_process.js', 'edgedesk_portfolio_journal_ui.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')).join('\n').replace(/var BANNED_WORDS = \[[\s\S]*?\];/, '');
const strings = (SRC.replace(/\/\*[\s\S]*?\*\//g, '').match(/'(?:[^'\\\n]|\\.)*'/g) || []).join('\n');
const TOUT = /\b(bet this|locks?|lock of|guaranteed?|smash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing|hammer|win it back|chase|get even|recoup|bounce back|deposit (now|more)|reload bonus|boost your|hot streak|on fire|due for|don'?t miss)\b/i;
const hit = strings.split('\n').filter((l) => TOUT.test(l));
chk('no tout, urgency or loss-chasing language anywhere in Portfolio copy', hit.length === 0, hit.slice(0, 5));
const rendered = [U.render.overview(S), U.render.open(S), U.render.history(S), U.render.analytics(S), U.render.accounts(Object.assign({}, S, { accounts: accts })), U.render.import(S),
  U.render.wagerForm({}, {}), U.render.predictionForm({}, {})].map(strip).join(' ');
chk('…nor in anything the page renders', !TOUT.test(rendered), (rendered.match(TOUT) || [])[0]);
chk('up and down are described the same way: "Up $x" / "Down $x"', /"Up"|'Up'/.test(SRC) && /'Down'/.test(SRC) && !/congrat|celebrat|🎉|🔥/i.test(SRC));
chk('nothing financial is written to browser storage', !/localStorage|sessionStorage|indexedDB/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
chk('no password or credential field exists in the page', !/type="password"|name="password"|api[_-]?secret/i.test(SRC));

/* ═══ APP WIRING ════════════════════════════════════════════════════════ */
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const order = ['edgedesk_portfolio.js', 'edgedesk_portfolio_import.js', 'edgedesk_portfolio_connectors.js', 'edgedesk_portfolio_connect_core.js', 'edgedesk_portfolio_process.js', 'edgedesk_portfolio_journal_ui.js', 'edgedesk_portfolio_ui.js']
  .map((f) => APP.indexOf('<script src="/lib/' + f + '?v='));
chk('app.html loads the engine, importer, contract, process engine, journal views and page, in that order', order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), order);
chk('and the stylesheet', /<link rel="stylesheet" href="\/lib\/edgedesk_portfolio\.css\?v=/.test(APP));
/* Since the five-destination navigation (docs/ia/NAVIGATION_AUDIT.md) Portfolio
   is a SEAT of its own, not a More row: the same page in the same host, opened by
   lib/edgedesk_workspace_ui.js pfOpen(), with the old Ledger's tracked prices as
   one section under it. */
const WS = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_workspace_ui.js'), 'utf8');
chk('a #v-portfolio view with its own host (not the Ledger\'s id="portfolio")', /<section id="v-portfolio" class="view hide">\s*<div id="pfoHost"><\/div>/.test(APP) && (APP.match(/id="portfolio"/g) || []).length === 1 && (APP.match(/id="v-portfolio"/g) || []).length === 1);
chk('the router paints it', APP.indexOf("if(v==='portfolio'){try{if(window.pfOpen)window.pfOpen();}catch(_){}}") > 0 && WS.indexOf('PFS.ctl = W.EDPortfolioUI.show(host)') > 0);
chk('its own seat reads active while it is open', /var NAV_PRIMARY=\{[^}]*portfolio:1/.test(APP) && !/NAV_OWNER=\{[^}]*portfolio:/.test(APP));
chk('#portfolio deep-links to it, and #portfolio/<tab> to a tab', /NAV_HASH_MAP=\{[^}]*portfolio:'portfolio'/.test(APP) && APP.indexOf("if(t==='portfolio'&&m[2]){try{if(window.pfSetTab)window.pfSetTab(m[2],true);}catch(_){}}") > 0);
chk('More no longer lists it: it has a seat', APP.indexOf("dest.push(moreItem(IC.portfolio,'Portfolio'") < 0);
chk('a reader can make it their landing page', APP.indexOf("['portfolio','Portfolio']") > 0);
const nav = APP.slice(APP.indexOf('<nav class="bottomnav"'), APP.indexOf('</nav>', APP.indexOf('<nav class="bottomnav"'))).replace(/<!--[\s\S]*?-->/g, '');
chk('Portfolio is one of the five seats', (nav.match(/data-v="/g) || []).length === 5 && /data-v="portfolio"/.test(nav));
chk('the CSS prefix does not collide with the Ledger\'s .pfl- panel', !/\.pfl-/.test(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_portfolio.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'portfolio UI — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
