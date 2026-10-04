#!/usr/bin/env node
/* ============================================================================
   THE MARKET A GAP IS MEASURED AGAINST (audit 2026-09-30 #2, #3).

   The board showed SEA -3.0 and BUF -3.0 while every book was at -6.5/-7.
   Root cause (app.html fbMarketFromEvent): the "market" was whichever home
   `spreads` row PostgREST returned first, with its time set to the newest
   capture of ANY row. `signals` keeps a row per point for good, and the
   capture files alternate spreads under market='spreads', so an August
   look-ahead, a stale opener or an alternate could stand as the market and
   look minutes old. The college board had the same fault one layer up: when
   the captured quote was not fresh it fell back to cfb.lines — an untimed
   reference — and priced the gap, the label and the ranking off it as if it
   were current, while the price line priced captured quotes.

   Now the market is the consensus of the captured quotes that are CURRENT
   (the snapshot the price line prices): the books-weighted mode among the
   capture's modal rows, checked against the books-weighted median (more than
   1.5 pts apart = MARKET FAULT, and the NFL board self-check fails); with no
   current quote the consensus of every row is marked STALE; a bare reference
   is never current.

   This boots the real football module (tools/football/_module.js) and feeds
   the join the rows in the order PostgREST returned them in the audit.

     node tools/football/market_join.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./_module.js');
const ROOT = M.ROOT;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 500); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function section(t) { console.log('  · ' + t); }

const BOOT = M.boot({ probe: ['fbMarketFromEvent', 'fbBooksBehind', 'fbWMedian', 'fbNflMarketFor', 'fbNflMarketSelfCheck', 'fbNflSelfCheckHTML', 'fbNflResearchState', 'FB_CODE_NAMES',
  'fbLatestCapture', 'fbPriceRefresh', 'FB_PRICE_REFRESH_MS', 'fbPricesDown', 'fbPricesDownHTML', 'FB_SIG_ERR'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
['function _escHtml(', 'function edEsc('].forEach((sig) => {
  const at = BOOT.app.indexOf(sig);
  if (at >= 0) vm.runInContext(BOOT.app.slice(at, BOOT.app.indexOf('\n', at)), win);
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_canon.js'), 'utf8'), win, { filename: 'lib/edgedesk_canon.js' });
chk('the one classifier is loaded, as the page loads it', !!win.EDCanon);

const NOW = Date.now(), ago = (min) => new Date(NOW - min * 60000).toISOString();
const KICK = new Date(NOW + 4 * 86400e3).toISOString();
const SEA = T.FB_CODE_NAMES.SEA || 'Seattle Seahawks', LAC = T.FB_CODE_NAMES.LAC || 'Los Angeles Chargers';
const row = (sel, point, books, seenMin, o) => Object.assign({ market: 'spreads', selection: sel, point, n_books: books, best_book: 'book' + books,
  last_seen_at: ago(seenMin), first_seen_at: ago(seenMin + 60), point_is_modal: false }, o || {});
/* the audit's event, in the order PostgREST returned it: an August look-ahead
   first (SEA -3, one book, six weeks old), an alternate SEA -3 still dealt
   today, then the main line every book deals */
const AUDIT = { home: SEA, away: LAC, t: KICK, rows: [
  row(SEA, -3, 1, 60 * 24 * 42),
  row(SEA, -3, 1, 4),
  row(SEA, -7, 6, 6, { point_is_modal: true }),
  row(LAC, 7, 6, 6, { point_is_modal: true }),
  row(SEA, -6.5, 2, 9),
  row(LAC, 6.5, 2, 9)
] };

/* ---------------------------------------------------------------------- */
section('1. the audit case: the main line, not the first row');
{
  const first = AUDIT.rows.find((r) => r.market === 'spreads' && r.selection === SEA);
  chk('the old rule\'s answer, reproduced: the first home spreads row is SEA -3 (the look-ahead)', first.point === -3);
  const m = T.fbMarketFromEvent(AUDIT, SEA);
  chk('the market is SEA -7: the books-weighted mode of the capture\'s modal rows (engine convention: home must win by 7)', m.spread_line === 7 && m.spread_consensus.home_line === -7, m.spread_consensus);
  chk('…read from the current quotes only, and says so', m.stale === false && m.spread_consensus.current === true && /modal point/.test(m.spread_consensus.main_by), m.spread_consensus);
  chk('…timestamped by the main line\'s own capture, never by the newest row of any kind (the alternate is 4 min old, the main 6)', m.at === AUDIT.rows[2].last_seen_at, [m.at, AUDIT.rows[1].last_seen_at]);
  chk('…and it sits inside 1.5 pts of the books-weighted median: no market fault', m.consensus_fault === null && Math.abs(m.spread_consensus.home_line - m.spread_consensus.home_line_median) <= 1.5, m.spread_consensus);
  chk('the books-weighted median of the current rows', T.fbWMedian([{ v: -7, w: 6 }, { v: -6.5, w: 2 }, { v: -3, w: 1 }]) === -7 && T.fbWMedian([{ v: 1, w: 1 }, { v: 3, w: 1 }]) === 2);
}

/* ---------------------------------------------------------------------- */
section('2. without the modal flag, the books-weighted mode of the current quotes');
{
  const rows = AUDIT.rows.map((r) => Object.assign({}, r, { point_is_modal: false }));
  const m = T.fbMarketFromEvent({ home: SEA, away: LAC, t: KICK, rows }, SEA);
  chk('SEA -7 still wins on books (six books against one), whatever order the rows arrive in', m.spread_line === 7 && T.fbMarketFromEvent({ home: SEA, away: LAC, t: KICK, rows: rows.slice().reverse() }, SEA).spread_line === 7);
}

/* ---------------------------------------------------------------------- */
section('3. THE SELF-CHECK: a main line off its own books fails the board');
{
  /* the capture marks SEA -3 modal, but every other book is at -7: the main
     line the capture chose is not the consensus of its own quotes */
  const rows = [row(SEA, -3, 2, 5, { point_is_modal: true }), row(SEA, -7, 6, 5), row(LAC, 7, 6, 5)];
  const m = T.fbMarketFromEvent({ home: SEA, away: LAC, t: KICK, rows }, SEA);
  chk('the main line (SEA -3) is 4 pts from the books-weighted median (-7): MARKET FAULT, with the reason', m.consensus_fault && m.consensus_fault.difference === 4 && /MARKET FAULT/.test(m.consensus_fault.reason), m.consensus_fault);
  /* the board: one NFL game with that event */
  const S = win.FB.nfl;
  const g = { game_id: 'MJ1', season: 2026, week: 4, home_team: 'SEA', away_team: 'LAC', gameday: KICK.slice(0, 10), spread_line: -7, total_line: 42.5 };
  S.up = [{ g, t: Date.parse(KICK), week: 4, done: false }];
  S.sig = { 't:MJ1': { home: SEA, away: LAC, t: KICK, rows } };
  const c = T.fbNflMarketSelfCheck();
  chk('fbNflMarketSelfCheck fails the board and names the game', c.ok === false && c.checked === 1 && c.faults.length === 1 && c.faults[0].market === -3 && c.faults[0].consensus === -7, c);
  chk('…and the board says so above the rows', /NFL MARKET SELF-CHECK FAILED/.test(T.fbNflSelfCheckHTML()) && /MARKET FAULT/.test(T.fbNflSelfCheckHTML()));
  const M1 = T.fbNflMarketFor(g, Date.parse(KICK));
  const st = T.fbNflResearchState({ status: 'PREDICTED', model: { fair_spread: 9.24 }, market: { spread_gap: 9.24 - M1.mkt.spread_line } }, M1.mkt, null);
  chk('…and the game reads MARKET FAULT, excluded from ranking', st.label === 'MARKET FAULT' && st.rule === 'market_fault_consensus', st);
  /* the audit event itself passes */
  S.sig = { 't:MJ1': AUDIT };
  chk('the audit event, joined right, passes the self-check', T.fbNflMarketSelfCheck().ok === true);
}

/* ---------------------------------------------------------------------- */
section('4. no current quote: STALE, never current');
{
  const old = AUDIT.rows.map((r) => Object.assign({}, r, { last_seen_at: ago(60 * 30) }));
  const m = T.fbMarketFromEvent({ home: SEA, away: LAC, t: KICK, rows: old }, SEA);
  chk('every row older than the freshness window: the consensus of the last capture, marked stale', m.stale === true && m.spread_line === 7 && m.spread_consensus.current === false, m.spread_consensus);
  const S = win.FB.nfl;
  const g = { game_id: 'MJ2', season: 2026, week: 4, home_team: 'SEA', away_team: 'LAC', gameday: KICK.slice(0, 10), spread_line: -7, total_line: 42.5 };
  S.up = [{ g, t: Date.parse(KICK), week: 4, done: false }]; S.sig = {};
  const M2 = T.fbNflMarketFor(g, Date.parse(KICK));
  chk('no captured event at all: the nflverse line is a reference only, marked stale', M2.mkt.reference_only === true && M2.mkt.stale === true && M2.src === 'nflverse reference');
  const st = T.fbNflResearchState({ status: 'PREDICTED', model: { fair_spread: 9.24 }, market: { spread_gap: 9.24 - M2.mkt.spread_line } }, M2.mkt, null);
  chk('…and the game reads STALE MARKET, out of the research ranking', st.label === 'STALE MARKET' && st.rule === 'stale_market', st);
}

/* ---------------------------------------------------------------------- */
section('5. the college board reads the same market');
{
  const APP = BOOT.module;
  const src = APP.slice(APP.indexOf('function fbP4Market('), APP.indexOf('function fbP4SchedCtx('));
  chk('fbP4Market prices the captured consensus (fbMarketFromEvent), not the first row', /fbMarketFromEvent\(ev,ev\.home\)/.test(src) && /m\.spread_consensus/.test(src));
  chk('…and cfb.lines is a reference: used alone it is STALE (never the current market)', /out\.spread_line=out\.reference\.spread_line;out\.stale=true/.test(src.replace(/\s+/g, '')) && /untimed reference, not a current price/.test(src));
  chk('…and carries the consensus fault to the one classifier', /out\.consensus_fault=m\.consensus_fault/.test(src.replace(/\s+/g, '')));
  const C = win.EDCanon;
  const s = C.researchStatusFromProjection({ status: 'PREDICTED', model: { fair_spread: 6 }, scores: { confidence: 80 } }, { spread_line: 3, stale: true }, { reliability: 80 });
  chk('a college game whose only number is stale reads STALE MARKET and is not rankable', s.key === 'NO_MARKET' && s.rule === 'stale_market' && s.label === 'STALE MARKET' && s.rankable === false, s);
  const f = C.researchStatusFromProjection({ status: 'PREDICTED', model: { fair_spread: 6 }, scores: { confidence: 80 } }, { spread_line: 3, consensus_fault: { reason: 'MARKET FAULT: x' } }, { reliability: 80 });
  chk('a market off its own quotes reads MARKET FAULT with its reason, not rankable', f.key === 'MARKET_FAULT' && f.rule === 'market_fault_consensus' && f.rankable === false, f);
}

/* ---------------------------------------------------------------------- */
section('6. how many books: distinct books, never the sum of every row');
{
  /* the 2026-10-01 board: seven books quoting both sides at eight points read
     "112 books" (n_books summed over all sixteen rows) */
  const H = 'New Mexico State Aggies', A = 'Western Kentucky Hilltoppers', K2 = new Date(NOW + 30 * 3600e3).toISOString();
  const BK = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'ESPN BET', 'Fanatics', 'BetRivers'], rows = [];
  [-4.5, -4, -3.5, -3, -2.5, -2, -1.5, -1].forEach((pt, i) => {
    rows.push(row(H, pt, 7, 5, { best_book: BK[i % 7], point_is_modal: pt === -2.5 }));
    rows.push(row(A, -pt, 7, 5, { best_book: BK[(i + 3) % 7], point_is_modal: pt === -2.5 }));
  });
  const m = T.fbMarketFromEvent({ home: H, away: A, t: K2, rows }, H);
  chk('seven books on sixteen current rows count as 7 books, not 112', m.stale === false && m.spread_consensus.books === 7, m.spread_consensus);
  chk('…and the row sum is kept only under its honest name (quotes)', m.spread_consensus.quotes === 112, m.spread_consensus);
  const busy = T.fbMarketFromEvent({ home: H, away: A, t: K2, rows: [row(H, -3, 9, 5, { best_book: 'X', point_is_modal: true }),
    row(A, 3, 9, 5, { best_book: 'Y', point_is_modal: true }), row(H, -3.5, 2, 5, { best_book: 'Z' })] }, H);
  chk('nine books on one line, three ever named best: 9 books (the busiest line is distinct books)', busy.spread_consensus.books === 9, busy.spread_consensus);
  chk('the rule: the larger of the distinct books named and the busiest row', () => T.fbBooksBehind([]) === null
    && T.fbBooksBehind([{ book: 'a', n_books: 1 }, { book: 'b', n_books: 1 }, { book: 'a', n_books: 1 }]) === 2 && T.fbBooksBehind([{ best_book: 'a', n_books: 5 }]) === 5);
  const APP = BOOT.module.replace(/\s+/g, '');
  const p4 = APP.slice(APP.indexOf('functionfbP4Market('), APP.indexOf('functionfbP4SchedCtx('));
  chk('the board label prints that count (spread_consensus.books), never the quote sum', /\(c\.books\|\|0\)\+'book'/.test(p4) && !/c\.quotes/.test(p4));
  const rs = APP.slice(APP.indexOf('functionfbResearchStateOf('), APP.indexOf('window.fbResearchStates='));
  chk('the research state (card and drivers) counts its books by the same rule', /books=fbBooksBehind\(\(fbP4QuotesFor\(/.test(rs));
}

/* ---------------------------------------------------------------------- */
section('7. stale quotes: the LAST capture, never every row on file (audit 2026-10-01)');
{
  /* Thursday night, PIT @ CLE, ten hours out: the morning's quotes have aged
     past the 90-minute rung. `signals` still holds every point the line has
     passed through — the opener at CLE -1 and a stop at PK, each dealt by
     six books — beside the last capture at PIT -3 (eight books) and -2.5
     (two). The old fallback took the books-weighted median of ALL of it:
     +1 against a main line of +3, and the game read MARKET FAULT. */
  const CLE = T.FB_CODE_NAMES.CLE || 'Cleveland Browns', PIT = T.FB_CODE_NAMES.PIT || 'Pittsburgh Steelers';
  const K3 = new Date(NOW + 10 * 3600e3).toISOString();
  const rows = [
    row(CLE, -1, 6, 60 * 30, { point_is_modal: true }), row(PIT, 1, 6, 60 * 30, { point_is_modal: true }),
    row(CLE, 1, 6, 60 * 20, { point_is_modal: true }), row(PIT, -1, 6, 60 * 20, { point_is_modal: true }),
    row(CLE, 3, 8, 180, { point_is_modal: true }), row(PIT, -3, 8, 180, { point_is_modal: true }),
    row(CLE, 2.5, 2, 180), row(PIT, -2.5, 2, 180),
    { market: 'h2h', selection: CLE, best_dec: 1.95, first_best_dec: 1.95, last_seen_at: ago(60 * 30), first_seen_at: ago(60 * 31) },
    { market: 'h2h', selection: PIT, best_dec: 1.95, first_best_dec: 1.95, last_seen_at: ago(60 * 30), first_seen_at: ago(60 * 31) },
    { market: 'h2h', selection: CLE, best_dec: 2.3, first_best_dec: 1.95, last_seen_at: ago(180), first_seen_at: ago(60 * 31) },
    { market: 'h2h', selection: PIT, best_dec: 1.65, first_best_dec: 1.95, last_seen_at: ago(180), first_seen_at: ago(60 * 31) }
  ];
  const all = [{ v: -1, w: 12 }, { v: 1, w: 12 }, { v: 3, w: 16 }, { v: 2.5, w: 4 }];
  chk('the old rule\'s answer, reproduced: the median of every row on file is +1, two points off the +3 main line', T.fbWMedian(all) === 1);
  const m = T.fbMarketFromEvent({ home: CLE, away: PIT, t: K3, rows }, CLE);
  chk('the market is the last capture: PIT -3 (home +3), marked stale', m.stale === true && m.spread_line === -3 && m.spread_consensus.home_line === 3 && m.spread_consensus.current === false, m.spread_consensus);
  chk('…checked against the median of that same capture: no MARKET FAULT', m.consensus_fault === null && m.spread_consensus.home_line_median === 3, [m.consensus_fault, m.spread_consensus]);
  chk('…timestamped by that capture', m.at === rows[4].last_seen_at, m.at);
  chk('…and the moneyline is that capture\'s price on BOTH sides, not the best price ever seen', JSON.stringify(m.quotes_h2h) === JSON.stringify([[2.3, 1.65]]), m.quotes_h2h);
  const S = win.FB.nfl;
  const g = { game_id: 'MJ7', season: 2026, week: 4, home_team: 'CLE', away_team: 'PIT', gameday: K3.slice(0, 10), spread_line: 3, total_line: 38.5 };
  S.up = [{ g, t: Date.parse(K3), week: 4, done: false }];
  S.sig = { 't:MJ7': { home: CLE, away: PIT, t: K3, rows } };
  chk('the NFL self-check passes: aged quotes are STALE, not a MARKET FAULT', T.fbNflMarketSelfCheck().ok === true && T.fbNflSelfCheckHTML() === '', T.fbNflMarketSelfCheck());
  const M7 = T.fbNflMarketFor(g, Date.parse(K3));
  const st = T.fbNflResearchState({ status: 'PREDICTED', model: { fair_spread: 0.8 }, market: { spread_gap: 0.8 - M7.mkt.spread_line } }, M7.mkt, null);
  chk('…and the game reads STALE MARKET, not MARKET FAULT', st.label === 'STALE MARKET' && st.rule === 'stale_market', st);
  /* the snapshot rule itself */
  const L = T.fbLatestCapture;
  chk('one run\'s rows share a stamp; rows within five minutes of the newest are that run', L([{ at: ago(60) }, { at: ago(62) }, { at: ago(70) }, { at: null }]).length === 2
    && L([{ at: ago(60) }, { at: ago(65) }]).length === 2 && L([{ at: ago(60) }, { at: ago(65.1) }]).length === 1);
  chk('…and with no stamp anywhere, every row stands (nothing to order them by)', L([{ at: null }, {}]).length === 2 && L([]).length === 0);
}

/* ---------------------------------------------------------------------- */
section('8. the alternate ladder: the median is of main lines (audit 2026-10-01 #2)');
{
  /* Thursday night, PIT @ CLE, three hours out, every quote current. Inside
     30 h of kickoff the capture also buys each book's alternate ladder and
     files it under 'spreads': beside the main line (CLE +3, eight books,
     near even) sits a row per number from -10.5 to +10.5 on both sides, five
     books each, priced off even the further it runs. The median of all of
     it is +0.5, 2.5 pts off the main line, and the board read MARKET FAULT. */
  const CLE = T.FB_CODE_NAMES.CLE || 'Cleveland Browns', PIT = T.FB_CODE_NAMES.PIT || 'Pittsburgh Steelers';
  const K9 = new Date(NOW + 3 * 3600e3).toISOString();
  const Phi = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    const q = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - q : q; };
  /* a book's price at a home line v when the market is centred at `centre`: 4.5% margin, sd 13.5 */
  const dec = (p) => Math.max(1.01, Math.round(100 / (p * 1.045)) / 100);
  const ladder = (centre, books, seen) => {
    const out = [];
    for (let v = -10.5; v <= 10.5; v += 1) {
      const pHome = Phi((v - centre) / 13.5);
      out.push(row(CLE, v, books, seen, { best_dec: dec(pHome) }), row(PIT, -v, books, seen, { best_dec: dec(1 - pHome) }));
    }
    return out;
  };
  const rows = [row(CLE, 3, 8, 5, { point_is_modal: true, best_dec: 1.95 }), row(PIT, -3, 8, 5, { point_is_modal: true, best_dec: 1.91 })].concat(ladder(3, 5, 5));
  const all = rows.map((r) => ({ v: r.selection === CLE ? r.point : -r.point, w: r.n_books }));
  chk('the old rule\'s answer, reproduced: the median of every current row is +0.5, 2.5 pts off the +3 main line', T.fbWMedian(all) === 0.5, T.fbWMedian(all));
  const m = T.fbMarketFromEvent({ home: CLE, away: PIT, t: K9, rows }, CLE);
  chk('the market is the main line: PIT -3 (home +3), current', m.stale === false && m.spread_line === -3 && m.spread_consensus.home_line === 3, m.spread_consensus);
  chk('…checked against the median of the rows dealt near even: +3, no MARKET FAULT', m.consensus_fault === null && m.spread_consensus.home_line_median === 3, [m.consensus_fault, m.spread_consensus]);
  const S = win.FB.nfl;
  const g = { game_id: 'MJ9', season: 2026, week: 4, home_team: 'CLE', away_team: 'PIT', gameday: K9.slice(0, 10), spread_line: 3, total_line: 38.5 };
  S.up = [{ g, t: Date.parse(K9), week: 4, done: false }];
  S.sig = { 't:MJ9': { home: CLE, away: PIT, t: K9, rows } };
  chk('the NFL self-check passes with a ladder on file, and the board shows no banner', T.fbNflMarketSelfCheck().ok === true && T.fbNflMarketSelfCheck().checked === 1 && T.fbNflSelfCheckHTML() === '', T.fbNflMarketSelfCheck());
  const M9 = T.fbNflMarketFor(g, Date.parse(K9));
  const st = T.fbNflResearchState({ status: 'PREDICTED', model: { fair_spread: 0.8 }, market: { spread_gap: 0.8 - M9.mkt.spread_line } }, M9.mkt, null);
  chk('…and the game does not read MARKET FAULT', st.label !== 'MARKET FAULT' && st.rule !== 'market_fault_consensus', st);
  /* a ladder does not hide a real fault: the capture marks CLE +3 modal on
     two books while six deal CLE +7 at even money, the ladder centred there */
  const off = [row(CLE, 3, 2, 5, { point_is_modal: true, best_dec: 1.91 }), row(CLE, 7, 6, 5, { best_dec: 1.91 }), row(PIT, -7, 6, 5, { best_dec: 1.91 })].concat(ladder(7, 5, 5));
  const mf = T.fbMarketFromEvent({ home: CLE, away: PIT, t: K9, rows: off }, CLE);
  chk('…a main line 4 pts off the books\' even-money lines still reads MARKET FAULT', mf.consensus_fault && mf.consensus_fault.market === 3 && mf.consensus_fault.consensus === 7, mf.consensus_fault);
  S.sig = { 't:MJ9': { home: CLE, away: PIT, t: K9, rows: off } };
  chk('…and still fails the board', T.fbNflMarketSelfCheck().ok === false && /NFL MARKET SELF-CHECK FAILED/.test(T.fbNflSelfCheckHTML()), T.fbNflMarketSelfCheck());
}

/* ---------------------------------------------------------------------- */
section('9. an open tab re-reads the prices on its own (audit 2026-10-01)');
(async () => {
  /* the tab loaded at breakfast: its quotes are three hours old, the
     re-learn waits six, and capture re-priced the game half an hour ago */
  const CLE = T.FB_CODE_NAMES.CLE || 'Cleveland Browns', PIT = T.FB_CODE_NAMES.PIT || 'Pittsburgh Steelers';
  const K8 = new Date(NOW + 10 * 3600e3).toISOString();
  const S = win.FB.nfl, F = win.FB;
  const g = { game_id: 'MJ8', season: 2026, week: 4, home_team: 'CLE', away_team: 'PIT', gameday: K8.slice(0, 10), spread_line: 3, total_line: 38.5 };
  const evRow = (sel, point, books, seenMin, o) => Object.assign(row(sel, point, books, seenMin, o), { event_id: 'ev8', home_team: CLE, away_team: PIT, commence_time: K8 });
  const morning = [evRow(CLE, 3, 8, 180, { point_is_modal: true }), evRow(PIT, -3, 8, 180, { point_is_modal: true })];
  const now = [evRow(CLE, 3, 8, 30, { point_is_modal: true }), evRow(PIT, -3, 8, 30, { point_is_modal: true })];
  function stage() {
    S.up = [{ g, t: Date.parse(K8), week: 4, done: false }];
    S.sig = { ev8: { home: CLE, away: PIT, t: K8, rows: morning } };
    S.state = S.state || {}; S.notes = [];
    S.pricesAt = Date.now() - 3 * 3600e3; F.at = Date.now() - 3 * 3600e3; F.loading = null; F._priceP = null;
    F._pred = { cached: true };
  }
  let reads = 0, answer = () => Promise.resolve(now);
  win.sbGet = (q) => { reads++; return /sport_key=eq\.americanfootball_nfl/.test(q) ? answer() : Promise.resolve([]); };
  win.RESEARCH_SUB = 'football';

  stage();
  chk('before: every quote the tab holds is past its limit, so the market reads STALE', T.fbNflMarketFor(g, Date.parse(K8)).mkt.stale === true);
  const ok = await T.fbPriceRefresh();
  chk('the five-minute cadence', T.FB_PRICE_REFRESH_MS === 5 * 60e3);
  chk('the refresh re-reads the captured quotes and swaps them in', ok === true && reads >= 1 && S.sig.ev8 && S.sig.ev8.rows[0].last_seen_at === now[0].last_seen_at, S.sig);
  chk('…the market is current again: no STALE_QUOTE on a game capture re-priced thirty minutes ago', T.fbNflMarketFor(g, Date.parse(K8)).mkt.stale === false);
  chk('…the projection cache is dropped (it carries the odds stamp)', !F._pred.cached);
  chk('…and the price stamp moves, so the next read waits its five minutes', Date.now() - S.pricesAt < 5000);
  reads = 0;
  chk('not due yet: no read', (await T.fbPriceRefresh()) === false && reads === 0);

  stage(); answer = () => Promise.reject(Object.assign(new Error('db 503'), { status: 503 }));
  const bad = await T.fbPriceRefresh();
  chk('a failed read keeps the quotes the tab holds (they age into STALE on their own stamps)', S.sig.ev8.rows === morning && F._pred.cached === true);
  chk('…and the next tick tries again', F._priceP === null && Date.now() - S.pricesAt > 3600e3);
  /* A FAILED READ IS NOT AN EMPTY MARKET (audit 2026-10-03): a 503 used to
     leave the board reading NO MARKET on every game with nothing saying the
     read had failed */
  chk('…the failure is recorded for that sport, with the reader\'s sentence', !!T.fbPricesDown('americanfootball_nfl')
    && /did not answer \(HTTP 503\)/.test(T.fbPricesDown('americanfootball_nfl').why), T.fbPricesDown('americanfootball_nfl'));
  chk('…the board repaints once to say so', bad === true);
  chk('…and says so above the rows, naming the quotes it still holds', /Live prices could not be loaded/.test(T.fbPricesDownHTML('americanfootball_nfl', S.sig, S.pricesAt))
    && /last ones read/.test(T.fbPricesDownHTML('americanfootball_nfl', S.sig, S.pricesAt)));
  chk('…holding nothing, it says NO MARKET means unread, not unpriced', /could not read its price, not that no book has a line/.test(T.fbPricesDownHTML('americanfootball_nfl', {}, null)));
  stage(); reads = 0;
  chk('a read still failing does not repaint again', (await T.fbPriceRefresh()) === false && reads >= 1);
  stage(); reads = 0; S.pricesAt = Date.now() - 61e3;
  chk('while failing, the retry is the next one-minute tick, not five minutes', (await T.fbPriceRefresh()) === false && reads >= 1);
  stage(); answer = () => Promise.resolve(now);
  chk('a read that succeeds clears the failure, and the banner with it', (await T.fbPriceRefresh()) === true && !T.fbPricesDown('americanfootball_nfl')
    && T.fbPricesDownHTML('americanfootball_nfl', S.sig, S.pricesAt) === '');

  stage(); answer = () => Promise.resolve(now); reads = 0;
  F.loading = Promise.resolve();
  chk('a full reload in flight brings its own read: the refresh stands aside', (await T.fbPriceRefresh()) === false && reads === 0);
  F.loading = null;

  stage(); reads = 0; win.RESEARCH_SUB = 'tennis';
  chk('another module on screen: nothing is read', (await T.fbPriceRefresh()) === false && reads === 0);
  win.RESEARCH_SUB = 'football';

  stage(); reads = 0;
  const slow = new Promise((res) => setTimeout(() => res(now), 20));
  answer = () => slow;
  const pend = T.fbPriceRefresh();
  F.at = Date.now();  /* a full reload landed while the read was in flight */
  chk('a read overtaken by a full reload is dropped, never written over the newer one', (await pend) === false && S.sig.ev8.rows === morning);

  const APP = BOOT.module.replace(/\s+/g, '');
  chk('the refresh runs on its own clock and when the tab comes back', /setInterval\(fbPriceRefresh,60e3\)/.test(APP) && /if\(!document\.hidden\)fbPriceRefresh\(\)/.test(APP));
  chk('the college board re-reads its quotes too, and drops the projection caches that took the old market', /fbSignalsRead\('americanfootball_ncaaf'\)/.test(APP) && /P\._pc=null;P\._pcm=null;P\._proj=null;P\._mkt=null;/.test(APP));
})().catch((e) => chk('the price refresh ran', false, String(e && e.stack || e))).then(() => {
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'market join — ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
});
