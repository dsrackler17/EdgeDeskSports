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

const BOOT = M.boot({ probe: ['fbMarketFromEvent', 'fbWMedian', 'fbNflMarketFor', 'fbNflMarketSelfCheck', 'fbNflSelfCheckHTML', 'fbNflResearchState', 'FB_CODE_NAMES'] });
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
  chk('every row older than the freshness window: the consensus of all rows, marked stale', m.stale === true && m.spread_line === 7 && m.spread_consensus.current === false, m.spread_consensus);
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

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'market join — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
