#!/usr/bin/env node
/* ===========================================================================
   Tests for the football model record (tools/record/football_record_core.js,
   football_record_sources.js, football_record.js).

   What must hold, and is asserted here with labelled games:
     · only numbers published before kickoff are recorded; the pick is the
       last pregame number, the first is kept, a late number is refused
     · the entry is the first model–market pair, set once
     · a market quote after kickoff is never used
     · ATS / O-U side is the model against the CLOSE, graded on the final
     · CLV is points toward the side the model leaned, same source only
     · a final is set once and never overwritten; 0-0 is not a final
     · the ESPN reader never grades against the wrong team
     · every graded pick is priced: its closing price when captured (only
       for the line and book the close holds), else the marked standard -110
       on a spread or total; a moneyline only at a real price
     · the CLI records a slate end to end, offline, and writes nothing
       unless asked

   Run: node tools/record/football_record.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./football_record_core.js');
const S = require('./football_record_sources.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const KICK = '2026-09-27T17:00:00.000Z';
function slateGame(over) {
  return Object.assign({ game_id: 'G1', season: 2026, week: 3, kickoff: KICK, home_team: 'Home', away_team: 'Away',
    home_code: 'HOM', away_code: 'AWY', model_status: 'PREDICTED', model_home_line: -6, model_fair_total: 44,
    model_home_win_prob: 0.68, model_version: 'v1',
    reference_market: { home_line: -3, total: 45 } }, over || {});
}
function ledgerWith(over, ctx) {
  const L = C.emptyLedger('nfl', 2026);
  const p = C.projectionFromSlate('nfl', slateGame(over), { season: 2026 });
  const r = C.recordProjection(L, p, Object.assign({ published_at: '2026-09-24T12:00:00Z', now: '2026-09-24T12:05:00Z',
    market: Object.assign({}, p.reference_market, { at: '2026-09-24T12:00:00Z' }) }, ctx || {}));
  return { L, e: L.games.G1, r };
}

/* ------------------------------------------------------------- intake */
chk('a PREDICTED slate game becomes a projection', () => {
  const p = C.projectionFromSlate('nfl', slateGame(), { season: 2026 });
  return p.home_line === -6 && p.total === 44 && p.home_win_prob === 0.68 && p.reference_market.home_line === -3;
});
chk('an unpriced game is not recorded', () => C.projectionFromSlate('nfl', slateGame({ model_status: 'BLOCKED' }), {}) === null);
chk('an impossible total is dropped, the line kept', () => {
  const p = C.projectionFromSlate('cfb', slateGame({ model_fair_total: 0 }), { season: 2026 });
  return p && p.home_line === -6 && p.total === null;
});
chk('an impossible line refuses the game', () => C.projectionFromSlate('cfb', slateGame({ model_home_line: -140 }), {}) === null);
chk('college groups follow the board split', () =>
  C.groupOf({ home_division: 'fbs', away_division: 'fcs' }) === 'fbs_fcs'
  && C.groupOf({ home_division: 'fbs', away_division: 'fbs', home_fbs_group: 'p4' }) === 'p4'
  && C.groupOf({ home_division: 'fbs', away_division: 'fbs', home_fbs_group: 'other', away_fbs_group: 'other' }) === 'other_fbs');

/* ------------------------------------------------------ pregame only */
chk('a new pregame number is recorded with its entry', () => {
  const { e, r } = ledgerWith();
  return r === 'new' && e.first.home_line === -6 && e.pick.home_line === -6 && e.entry.market.home_line === -3 && e.entry.home_line === -6;
});
chk('a number published after kickoff is refused', () => {
  const { r, L } = ledgerWith({}, { published_at: '2026-09-27T17:30:00Z', now: '2026-09-27T18:00:00Z' });
  return r === 'refused:published after kickoff' && !L.games.G1;
});
chk('a number committed after kickoff is refused on replay', () => {
  const { r } = ledgerWith({}, { published_at: '2026-09-27T16:00:00Z', commit_at: '2026-09-27T17:10:00Z', replay: true });
  return r === 'refused:committed after kickoff';
});
chk('a later pregame revision replaces the pick, keeps first and entry', () => {
  const { L, e } = ledgerWith();
  const p2 = C.projectionFromSlate('nfl', slateGame({ model_home_line: -7.5 }), { season: 2026 });
  const r = C.recordProjection(L, p2, { published_at: '2026-09-26T12:00:00Z', now: '2026-09-26T12:05:00Z',
    market: { home_line: -4.5, total: 45, source: 'nflverse', at: '2026-09-26T12:00:00Z' } });
  return r === 'revised' && e.pick.home_line === -7.5 && e.first.home_line === -6 && e.revisions === 1
    && e.entry.home_line === -6 && e.entry.market.home_line === -3 && e.market_pick.home_line === -4.5;
});
chk('a pregame revision seen only after kickoff still counts (publication time decides)', () => {
  const { L, e } = ledgerWith();
  const p2 = C.projectionFromSlate('nfl', slateGame({ model_home_line: -8 }), { season: 2026 });
  const r = C.recordProjection(L, p2, { published_at: '2026-09-27T16:00:00Z', now: '2026-09-27T19:00:00Z', market: null });
  return r === 'revised' && e.pick.home_line === -8 && e.market_pick === null;
});
chk('an identical number is unchanged and does not count as a revision', () => {
  const { L, e } = ledgerWith();
  const p2 = C.projectionFromSlate('nfl', slateGame(), { season: 2026 });
  const r = C.recordProjection(L, p2, { published_at: '2026-09-25T12:00:00Z', now: '2026-09-25T12:00:00Z' });
  return r === 'unchanged' && e.revisions === 0 && e.pick.at === '2026-09-24T12:00:00.000Z';
});
chk('an older version never replaces a newer pick', () => {
  const { L, e } = ledgerWith();
  const p2 = C.projectionFromSlate('nfl', slateGame({ model_home_line: -1 }), { season: 2026 });
  const r = C.recordProjection(L, p2, { published_at: '2026-09-23T12:00:00Z', now: '2026-09-25T12:00:00Z' });
  return r === 'unchanged' && e.pick.home_line === -6;
});
chk('a replayed older number becomes the first read and the entry', () => {
  const { L, e } = ledgerWith();
  const p0 = C.projectionFromSlate('nfl', slateGame({ model_home_line: -5 }), { season: 2026 });
  C.recordProjection(L, p0, { published_at: '2026-09-22T12:00:00Z', replay: true,
    market: { home_line: -2.5, total: 44, source: 'nflverse', at: '2026-09-22T12:00:00Z' } });
  return e.first.home_line === -5 && e.entry.market.home_line === -2.5 && e.pick.home_line === -6;
});
chk('a market quote stamped after kickoff is ignored', () => {
  const { e } = ledgerWith({}, { market: { home_line: -3, source: 'nflverse', at: '2026-09-27T17:05:00Z' } });
  return e.entry === null && e.market_pick === null;
});

/* ------------------------------------------------------------- market */
chk('fillMarket gives a quote-less game its entry, pregame only', () => {
  const L = C.emptyLedger('cfb', 2026);
  const p = C.projectionFromSlate('cfb', slateGame({ reference_market: null }), { season: 2026 });
  C.recordProjection(L, p, { published_at: '2026-09-24T12:00:00Z', now: '2026-09-24T12:00:00Z' });
  const e = L.games.G1;
  const late = C.fillMarket(e, { home_line: -4, total: 50, source: 'espn', book: 'ESPN BET' }, '2026-09-27T18:00:00Z');
  const ok = C.fillMarket(e, { home_line: -4, total: 50, source: 'espn', book: 'ESPN BET' }, '2026-09-25T09:00:00Z');
  const again = C.fillMarket(e, { home_line: -9, total: 50, source: 'espn' }, '2026-09-26T09:00:00Z');
  return !late && ok && !again && e.entry.market.home_line === -4 && e.entry.market.at === '2026-09-25T09:00:00Z' && e.market_pick.home_line === -4;
});

/* ------------------------------------------- the last pregame quote */
function espnGameLedger() {
  const L = C.emptyLedger('cfb', 2026);
  const p = C.projectionFromSlate('cfb', slateGame({ reference_market: null }), { season: 2026 });
  C.recordProjection(L, p, { published_at: '2026-09-24T12:00:00Z', now: '2026-09-24T12:00:00Z' });
  return L.games.G1;
}
chk('a quote is kept only inside the pre-close window, and only when it moves', () => {
  const e = espnGameLedger();
  const early = C.noteQuote(e, { home_line: -3, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-25T12:00:00Z');   // 53h out
  const a = C.noteQuote(e, { home_line: -3, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-26T20:00:00Z');       // 21h out
  const same = C.noteQuote(e, { home_line: -3, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-27T10:00:00Z');
  const moved = C.noteQuote(e, { home_line: -4, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-27T16:00:00Z');
  const late = C.noteQuote(e, { home_line: -9, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-27T17:30:00Z');
  return !early && a && !same && moved && !late && e.last_quote.home_line === -4 && e.last_quote.at === '2026-09-27T16:00:00Z';
});
chk('a finished game the source kept no close for is closed at its last pregame quote', () => {
  const e = espnGameLedger();
  C.fillMarket(e, { home_line: -2, total: 45, source: 'espn', book: 'ESPN BET' }, '2026-09-25T09:00:00Z');
  C.noteQuote(e, { home_line: -4, total: 46, source: 'espn', book: 'ESPN BET' }, '2026-09-27T16:00:00Z');
  const before = C.closeFromLastQuote(e, '2026-09-27T20:00:00Z');          // no final yet: waits for the source
  C.setFinal(e, { home_score: 24, away_score: 17 }, '2026-09-27T21:00:00Z');
  const after = C.closeFromLastQuote(e, '2026-09-27T21:00:00Z');
  const g = C.gradeGame(e, 'cfb', '2026-09-28T00:00:00Z');
  return !before && after && e.close.home_line === -4 && e.close.basis === 'last pregame capture'
    && g.status === 'GRADED' && g.clv_entry.spread.pts === 2 && g.spread.result === 'win';
});
chk('a close the source did give is never replaced by the last quote', () => {
  const e = espnGameLedger();
  C.noteQuote(e, { home_line: -4, total: 46, source: 'espn' }, '2026-09-27T16:00:00Z');
  C.setClose(e, { home_line: -5, total: 47, source: 'espn', book: 'ESPN BET' }, '2026-09-27T18:00:00Z');
  C.setFinal(e, { home_score: 24, away_score: 17 }, '2026-09-27T21:00:00Z');
  return !C.closeFromLastQuote(e, '2026-09-27T21:00:00Z') && e.close.home_line === -5 && !e.close.basis;
});

/* ------------------------------------------------------------ settle */
chk('a close is set only after kickoff', () => {
  const { e } = ledgerWith();
  const before = C.setClose(e, { home_line: -4, total: 46, source: 'nflverse' }, '2026-09-27T12:00:00Z');
  const after = C.setClose(e, { home_line: -4, total: 46, source: 'nflverse' }, '2026-09-27T21:00:00Z');
  return !before && after && e.close.home_line === -4;
});
chk('a final is set once, never overwritten, and a conflict is noted', () => {
  const { e } = ledgerWith();
  const a = C.setFinal(e, { home_score: 24, away_score: 17, source: 'nflverse' }, '2026-09-27T21:00:00Z');
  const b = C.setFinal(e, { home_score: 21, away_score: 17, source: 'espn' }, '2026-09-27T22:00:00Z');
  return a && !b && e.final.home_score === 24 && e.final_conflict.home_score === 21;
});
chk('0-0 is not a final', () => { const { e } = ledgerWith(); return !C.setFinal(e, { home_score: 0, away_score: 0 }, KICK) && e.final === null; });

/* ------------------------------------------------------------ grading */
function graded(pickLine, pickTotal, entryMkt, close, final, over) {
  const { e } = ledgerWith(Object.assign({ model_home_line: pickLine, model_fair_total: pickTotal }, over || {}),
    { market: Object.assign({ source: 'nflverse', at: '2026-09-24T12:00:00Z' }, entryMkt) });
  C.setClose(e, Object.assign({ source: 'nflverse' }, close), '2026-09-27T21:00:00Z');
  if (final) C.setFinal(e, final, '2026-09-27T21:00:00Z');
  return { e, g: C.gradeGame(e, 'nfl', '2026-09-28T00:00:00Z') };
}
chk('model below the close → home side; home covers → win', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, { home_score: 24, away_score: 17 });
  return g.status === 'GRADED' && g.spread.side === 'home' && g.spread.result === 'win' && g.spread.gap === 2;
});
chk('model above the close → away side; home covers → loss', () => {
  const { g } = graded(-2, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, { home_score: 24, away_score: 17 });
  return g.spread.side === 'away' && g.spread.result === 'loss';
});
chk('home wins by 3 laying 7.5 at the close: home side loses, away side wins', () => {
  const h = graded(-10, 44, { home_line: -7, total: 45 }, { home_line: -7.5, total: 46 }, { home_score: 20, away_score: 17 }).g;
  const a = graded(-5, 44, { home_line: -7, total: 45 }, { home_line: -7.5, total: 46 }, { home_score: 20, away_score: 17 }).g;
  return h.spread.side === 'home' && h.spread.result === 'loss' && a.spread.side === 'away' && a.spread.result === 'win';
});
chk('landing exactly on the close is a push', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -7, total: 46 }, { home_score: 24, away_score: 17 });
  return g.spread.result === 'push';
});
chk('model equal to the close takes no side and grades nothing', () => {
  const { g } = graded(-4, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 44 }, { home_score: 24, away_score: 17 });
  return g.spread.side === null && g.spread.result === null && g.total.side === null;
});
chk('totals: model under the close → under; 41 points under 46 → win', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, { home_score: 24, away_score: 17 });
  return g.total.side === 'under' && g.total.result === 'win';
});
chk('CLV: model leaned home at -3, closed -4 → +1 point', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, { home_score: 24, away_score: 17 });
  return g.clv_entry.spread.side === 'home' && g.clv_entry.spread.pts === 1;
});
chk('CLV: model leaned away at -7.5, closed -8.5 → -1 point', () => {
  const { g } = graded(-5.4, 44, { home_line: -7.5, total: 45 }, { home_line: -8.5, total: 45 }, { home_score: 17, away_score: 24 });
  return g.clv_entry.spread.side === 'away' && g.clv_entry.spread.pts === -1;
});
chk('CLV on totals: leaned over at 45, closed 46 → +1', () => {
  const { g } = graded(-6, 48, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, null);
  return g.clv_entry.total.side === 'over' && g.clv_entry.total.pts === 1 && g.status === 'AWAITING_FINAL';
});
chk('CLV needs the same source family: an ESPN close does not grade an nflverse quote', () => {
  const { e } = ledgerWith();
  C.setClose(e, { home_line: -4, total: 46, source: 'espn', book: 'DraftKings' }, '2026-09-27T21:00:00Z');
  const g = C.gradeGame(e, 'nfl', '2026-09-28T00:00:00Z');
  return g.clv_entry.spread === null && g.spread && g.spread.side === 'home';
});
chk('straight up, error and Brier from the final', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46 }, { home_score: 24, away_score: 17 });
  return g.su.side === 'home' && g.su.result === 'win' && g.error.model_margin_err === 1 && g.error.close_margin_err === 3
    && g.error.model_total_err === 3 && g.brier === C.num((0.32 * 0.32).toFixed(4));
});
chk('a model–close gap past the guard is flagged, still graded', () => {
  const { g } = graded(-4.1, 44, { home_line: 10.5, total: 45 }, { home_line: 10.5, total: 45 }, { home_score: 30, away_score: 10 });
  return g.beyond_guard === true && g.spread.result === 'win';
});
chk('pregame and no-close states', () => {
  const { e } = ledgerWith();
  const pre = C.gradeGame(e, 'nfl', '2026-09-25T00:00:00Z');
  C.setFinal(e, { home_score: 20, away_score: 10 }, '2026-09-27T21:00:00Z');
  const nc = C.gradeGame(e, 'nfl', '2026-09-28T00:00:00Z');
  return pre.status === 'PREGAME' && nc.status === 'FINAL_NO_CLOSE' && nc.su.result === 'win' && nc.spread === null;
});

/* ------------------------------------------------------------ summary */
chk('summary tallies records, CLV and break-even', () => {
  const L = C.emptyLedger('nfl', 2026);
  const add = (id, line, mkt, close, fin) => {
    const p = C.projectionFromSlate('nfl', slateGame({ game_id: id, model_home_line: line }), { season: 2026 });
    C.recordProjection(L, p, { published_at: '2026-09-24T12:00:00Z', now: '2026-09-24T12:00:00Z', market: { home_line: mkt, total: 45, source: 'nflverse', at: '2026-09-24T12:00:00Z' } });
    C.setClose(L.games[id], { home_line: close, total: 45, source: 'nflverse' }, '2026-09-28T00:00:00Z');
    C.setFinal(L.games[id], fin, '2026-09-28T00:00:00Z');
  };
  add('A', -6, -3, -4, { home_score: 24, away_score: 17 });    // home, covers: win; CLV +1
  add('B', -1, -3, -4, { home_score: 24, away_score: 17 });    // away, home covers: loss; CLV (away at -3 → -4) -1
  add('C', -9, -3, -3, { home_score: 20, away_score: 17 });    // home, 3 on -3: push; CLV 0
  const s = C.gradeLedger(L, '2026-09-29T00:00:00Z');
  return s.counts.graded === 3 && eq([s.ats.all.w, s.ats.all.l, s.ats.all.p], [1, 1, 1]) && s.ats.all.pct === 50
    && s.clv.spread_entry.n === 3 && s.clv.spread_entry.avg === 0 && s.clv.spread_entry.beat === 1 && s.clv.spread_entry.lost === 1
    && s.break_even_pct === 52.38 && s.weeks.length === 1 && L.games.A.grade.status === 'GRADED';
});

/* ------------------------------------------------------------ P&L
   1u on every side the record takes, at the closing price of that side;
   a spread or total with no captured price at the standard -110; a
   moneyline only at a real price. */
const near = (a, b) => a != null && Math.abs(a - b) < 1e-4;
function priced(prices, final, over) {
  const r = graded(-6, 44, { home_line: -3, total: 45 }, Object.assign({ home_line: -4, total: 46 }, prices ? { prices } : {}), final || { home_score: 24, away_score: 17 }, over);
  return r;
}
chk('P&L: a winning side at its closing price of -105 pays +0.9524u', () => {
  const { g } = priced({ home: -105, away: -115, over: -110, under: -110, home_ml: -200, away_ml: 170 });
  return g.pnl.spread.side === 'home' && g.pnl.spread.odds === -105 && g.pnl.spread.basis === 'close' && near(g.pnl.spread.units, 0.9524);
});
chk('P&L: a losing side costs exactly 1u, whatever the price', () => {
  const { g } = priced({ home: -105, away: -115, over: 120, under: -140 }, { home_score: 17, away_score: 24 });
  return g.pnl.spread.result === 'loss' && g.pnl.spread.units === -1;
});
chk('P&L: a plus-money winner pays the price (+120 → +1.20u)', () => {
  const { g } = priced({ home: -105, away: -115, over: -140, under: 120 });       // under 46: 41 points → win
  return g.pnl.total.side === 'under' && g.pnl.total.odds === 120 && near(g.pnl.total.units, 1.2);
});
chk('P&L: no captured price → the standard -110, marked standard, never "close"', () => {
  const { g } = priced(null);
  return g.pnl.spread.odds === -110 && g.pnl.spread.basis === 'standard' && near(g.pnl.spread.units, 0.9091)
    && g.pnl.total.basis === 'standard';
});
chk('P&L: a moneyline with no captured price carries no P&L (no standard moneyline exists)', () => {
  const { g } = priced({ home: -105, away: -115 });
  return g.su.result === 'win' && g.pnl.ml === null && g.pnl.bets === 2;
});
chk('P&L: the moneyline is the straight-up pick at its closing price (-200 win → +0.50u)', () => {
  const { g } = priced({ home: -105, away: -115, home_ml: -200, away_ml: 170 });
  return g.pnl.ml.side === 'home' && g.pnl.ml.odds === -200 && near(g.pnl.ml.units, 0.5);
});
chk('P&L: a push returns the stake (0u) and risks nothing', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -7, total: 46, prices: { home: -110, away: -110 } }, { home_score: 24, away_score: 17 });
  return g.spread.result === 'push' && g.pnl.spread.units === 0;
});
chk('P&L: the game total is the sum of its picks', () => {
  const { g } = priced({ home: -105, away: -115, over: -110, under: -110, home_ml: -200, away_ml: 170 });
  return near(g.pnl.units, g.pnl.spread.units + g.pnl.total.units + g.pnl.ml.units) && g.pnl.bets === 3;
});
chk('P&L: nothing before the final', () => {
  const { g } = graded(-6, 44, { home_line: -3, total: 45 }, { home_line: -4, total: 46, prices: { home: -110 } }, null);
  return g.pnl === null;
});
chk('P&L: a price that is not an American price is dropped, never used', () => {
  const { e, g } = priced({ home: 50, away: 'abc', over: 0, under: null });
  return !e.close.prices && g.pnl.spread.basis === 'standard';
});

chk('closing prices fill a held close only for the same line and the same book', () => {
  const { e } = ledgerWith();
  C.setClose(e, { home_line: -4, total: 46, source: 'espn', book: 'Draft Kings' }, '2026-09-27T21:00:00Z');
  const otherLine = C.setClose(e, { home_line: -4.5, total: 47, source: 'espn', book: 'DraftKings', prices: { home: -105, away: -115, over: -110, under: -110, home_ml: -190 } }, '2026-09-28T00:00:00Z');
  const otherBook = C.setClose(e, { home_line: -4, total: 46, source: 'espn', book: 'FanDuel', prices: { home: -105, away: -115 } }, '2026-09-28T00:00:00Z');
  const ok = C.setClose(e, { home_line: -4, total: 46, source: 'espn', book: 'DraftKings', prices: { home: -105, away: -115, over: -108, under: -112, home_ml: -190, away_ml: 160 } }, '2026-09-28T00:00:00Z');
  return !otherLine && !otherBook && ok && e.close.home_line === -4 && eq(e.close.prices, { home: -105, away: -115, over: -108, under: -112, home_ml: -190, away_ml: 160 });
});
chk('a held closing price is never replaced', () => {
  const { e } = ledgerWith();
  C.setClose(e, { home_line: -4, total: 46, source: 'nflverse', book: 'consensus', prices: { home: -105, away: -115 } }, '2026-09-27T21:00:00Z');
  const again = C.setClose(e, { home_line: -4, total: 46, source: 'nflverse', book: 'consensus', prices: { home: -120, away: 100, over: -110, under: -110 } }, '2026-09-28T00:00:00Z');
  return again && e.close.prices.home === -105 && e.close.prices.away === -115 && e.close.prices.over === -110;
});
chk('a total price is taken only when the total matches', () => {
  const { e } = ledgerWith();
  C.setClose(e, { home_line: -4, total: 46, source: 'nflverse', book: 'consensus' }, '2026-09-27T21:00:00Z');
  C.setClose(e, { home_line: -4, total: 47, source: 'nflverse', book: 'consensus', prices: { home: -105, away: -115, over: -110, under: -110 } }, '2026-09-28T00:00:00Z');
  return e.close.prices.home === -105 && e.close.prices.over === undefined && C.lacksClosePrice(e);
});
chk('the last pregame quote carries its prices into the close, and a price move refreshes it', () => {
  const e = espnGameLedger();
  const a = C.noteQuote(e, { home_line: -4, total: 46, source: 'espn', book: 'DK', prices: { home: -110, away: -110 } }, '2026-09-27T10:00:00Z');
  const moved = C.noteQuote(e, { home_line: -4, total: 46, source: 'espn', book: 'DK', prices: { home: -120, away: 100 } }, '2026-09-27T16:00:00Z');
  C.setFinal(e, { home_score: 24, away_score: 17 }, '2026-09-27T21:00:00Z');
  C.closeFromLastQuote(e, '2026-09-27T21:00:00Z');
  const g = C.gradeGame(e, 'cfb', '2026-09-28T00:00:00Z');
  return a && moved && e.close.prices.home === -120 && g.pnl.spread.odds === -120 && g.pnl.spread.basis === 'close';
});

chk('summary: units, risked, ROI and the price basis', () => {
  const L = C.emptyLedger('nfl', 2026);
  const add = (id, line, close, fin, prices, week) => {
    const p = C.projectionFromSlate('nfl', slateGame({ game_id: id, model_home_line: line, week: week || 3 }), { season: 2026 });
    C.recordProjection(L, p, { published_at: '2026-09-24T12:00:00Z', now: '2026-09-24T12:00:00Z', market: { home_line: close, total: 45, source: 'nflverse', at: '2026-09-24T12:00:00Z' } });
    C.setClose(L.games[id], Object.assign({ home_line: close, total: 45, source: 'nflverse' }, prices ? { prices } : {}), '2026-09-28T00:00:00Z');
    C.setFinal(L.games[id], fin, '2026-09-28T00:00:00Z');
  };
  add('A', -6, -4, { home_score: 24, away_score: 17 }, { home: -105, away: -115, over: -110, under: -110, home_ml: -200, away_ml: 170 }, 2);  // home covers (win -105), total 41 vs 45 under? model 44 → under: win; ML home win
  add('B', -1, -4, { home_score: 24, away_score: 17 }, null);                         // away loses at std; under wins at std; no ML price
  add('C', -9, -3, { home_score: 20, away_score: 17 }, { home: -110, away: -110 });   // push; under wins at std (no total price)
  const s = C.gradeLedger(L, '2026-09-29T00:00:00Z');
  const A = L.games.A.grade.pnl, B = L.games.B.grade.pnl, Cc = L.games.C.grade.pnl;
  const sum = A.units + B.units + Cc.units;
  return near(s.ats.all.units, A.spread.units + B.spread.units + Cc.spread.units)
    && s.ats.all.risked === 2 && s.ats.all.at_close === 2 && s.ats.all.at_standard === 1
    && near(s.net.units, sum) && s.net.n === A.bets + B.bets + Cc.bets
    && s.ml.n === 1 && s.su.n === 3 && s.counts.ml_unpriced === 2 && s.su.units === undefined
    && s.net.roi === Math.round(1000 * s.net.units / s.net.risked) / 10
    && s.splits.home.n === 2 && s.splits.away.n === 1 && s.splits.favorite.n === 2 && s.splits.underdog.n === 1
    && s.by_gap.spread.filter((b) => b.n).length >= 1 && s.by_gap.spread.reduce((a, b) => a + b.n, 0) === 3
    && s.weeks.length === 2 && near(s.weeks[0].cum_units, s.weeks[0].net.units) && near(s.weeks[1].cum_units, sum);
});

/* ------------------------------------------------------------- sources */
const CSV = 'game_id,season,week,away_team,away_score,home_team,home_score,espn,spread_line,total_line\n'
  + '2026_03_AWY_HOM,2026,3,AWY,17,HOM,24,401,3.5,44.5\n'
  + '2026_04_AWY_HOM,2026,4,AWY,,HOM,,402,-2,41\n'
  + '2025_04_AWY_HOM,2025,4,AWY,,HOM,,403,-2,41\n';
chk('nflverse: the closing prices travel with the closing line', () => {
  const t = 'game_id,season,week,away_team,away_score,home_team,home_score,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds\n'
    + '2026_02_DET_BUF,2026,2,DET,31,BUF,41,195,-238,5.5,-115,-105,54.5,-102,-118\n'
    + '2026_02_X_Y,2026,2,X,10,Y,20,NA,NA,3,NA,NA,40,NA,NA\n';
  const r = S.parseNflverse(t, 2026);
  return r['2026_02_DET_BUF'].close.home_line === -5.5
    && eq(r['2026_02_DET_BUF'].close.prices, { home: -105, away: -115, over: -118, under: -102, home_ml: -238, away_ml: 195 })
    && r['2026_02_X_Y'].close.prices === undefined;
});
chk('espn: the flat prices go with the details line; the nested close only with its own line', () => {
  const flat = S.espnLine({ details: 'UGA -7.5', spread: -7.5, overUnder: 51.5, overOdds: -105, underOdds: -115,
    homeTeamOdds: { favorite: true, spreadOdds: -112, moneyLine: -300 }, awayTeamOdds: { favorite: false, spreadOdds: -108, moneyLine: 240 } }, 'UGA', 'BAMA');
  const nested = S.espnLine({ pointSpread: { home: { close: { line: '-7', odds: '-110' } }, away: { close: { line: '+7', odds: 'EVEN' } } },
    total: { over: { close: { line: 'o50', odds: '-120' } }, under: { close: { line: 'u50', odds: '+100' } } }, moneyline: { home: { close: { odds: '-280' } }, away: { close: { odds: '+225' } } } }, 'UGA', 'BAMA');
  const mismatch = S.espnLine({ details: 'UGA -7.5', overUnder: 51.5, homeTeamOdds: {}, awayTeamOdds: {},
    pointSpread: { home: { close: { line: '-7', odds: '-110' } }, away: { close: { line: '+7', odds: '-110' } } } }, 'UGA', 'BAMA');
  return eq(flat.prices, { home: -112, away: -108, over: -105, under: -115, home_ml: -300, away_ml: 240 })
    && eq(nested.prices, { home: -110, away: 100, over: -120, under: 100, home_ml: -280, away_ml: 225 }) && nested.home_line === -7
    && mismatch.home_line === -7.5 && mismatch.prices === undefined;
});
chk('espn: a finished game read from the summary closes with its prices', () => {
  const ev = espnEvent();
  Object.assign(ev.competitions[0].odds[0], { overOdds: -110, underOdds: -110 });
  ev.competitions[0].odds[0].homeTeamOdds = { favorite: true, spreadOdds: -105, moneyLine: -320 };
  ev.competitions[0].odds[0].awayTeamOdds = { favorite: false, spreadOdds: -115, moneyLine: 250 };
  const g = S.parseEspnSummary({ header: { id: '401', competitions: ev.competitions }, pickcenter: ev.competitions[0].odds }, '401');
  return g.close.home_line === -7.5 && eq(g.close.prices, { home: -105, away: -115, over: -110, under: -110, home_ml: -320, away_ml: 250 });
});
chk('nflverse: a final row carries the close, home line negated', () => {
  const r = S.parseNflverse(CSV, 2026)['2026_03_AWY_HOM'];
  return r.close.home_line === -3.5 && r.close.total === 44.5 && r.final.home_score === 24 && r.market === null && r.close.source === 'nflverse';
});
chk('nflverse: an unplayed row carries the market and no final', () => {
  const r = S.parseNflverse(CSV, 2026)['2026_04_AWY_HOM'];
  return r.market.home_line === 2 && r.final === null && r.close === null;
});
chk('nflverse: other seasons are ignored', () => !S.parseNflverse(CSV, 2026)['2025_04_AWY_HOM']);
chk('cfbfastR: only a completed game with two integer scores is a final', () => {
  const t = 'game_id,season,completed,home_team,home_points,away_team,away_points\n1,2026,TRUE,A,31,B,24\n2,2026,FALSE,C,,D,\n3,2026,TRUE,E,NA,F,10\n';
  const r = S.parseCfbSchedule(t, 2026);
  return r['1'].final.home_score === 31 && r['2'].final === null && r['3'].final === null;
});

function espnEvent(over) {
  const o = Object.assign({ state: 'post', completed: true, hs: '31', as: '24', details: 'UGA -7.5', spread: -7.5, hf: true, af: false, ou: 51.5 }, over || {});
  return { id: '401', competitions: [{
    status: { type: { state: o.state, completed: o.completed, name: o.completed ? 'STATUS_FINAL' : 'STATUS_SCHEDULED' } },
    competitors: [
      { homeAway: 'home', score: o.hs, team: { abbreviation: 'UGA', displayName: 'Georgia' } },
      { homeAway: 'away', score: o.as, team: { abbreviation: 'BAMA', displayName: 'Alabama' } }],
    odds: o.noOdds ? [] : [{ provider: { name: 'ESPN BET' }, details: o.details, spread: o.spread, overUnder: o.ou,
      homeTeamOdds: { favorite: o.hf }, awayTeamOdds: { favorite: o.af }, pointSpread: o.ps }] }] };
}
chk('espn: a completed game with the home favourite closes at -7.5', () => {
  const g = S.parseEspnScoreboard({ events: [espnEvent()] })['401'];
  return g.close.home_line === -7.5 && g.close.total === 51.5 && g.close.book === 'ESPN BET' && g.final.home_score === 31 && g.market === null;
});
chk('espn: the away favourite reads as a positive home line', () => {
  const g = S.parseEspnScoreboard({ events: [espnEvent({ details: 'BAMA -3', spread: 3, hf: false, af: true })] })['401'];
  return g.close.home_line === 3;
});
chk('espn: a scheduled game gives a market, not a close or a final', () => {
  const g = S.parseEspnScoreboard({ events: [espnEvent({ state: 'pre', completed: false, hs: '0', as: '0' })] })['401'];
  return g.market.home_line === -7.5 && g.close === null && g.final === null;
});
chk('espn: readings that disagree on the favourite drop the line (never the wrong team)', () => {
  const g = S.parseEspnScoreboard({ events: [espnEvent({ details: 'UGA -7.5', spread: 7.5, hf: false, af: true })] })['401'];
  return g.close.home_line === null && g.close.total === 51.5;
});
chk('espn: EVEN is a pick\'em, pointSpread alone is read', () => {
  const a = S.espnLine({ details: 'EVEN', overUnder: 40 }, 'UGA', 'BAMA');
  const b = S.espnLine({ pointSpread: { home: { close: { line: '+2.5' } } }, total: { over: { close: { line: 'o47' } } } }, 'UGA', 'BAMA');
  return a.home_line === 0 && b.home_line === 2.5 && b.total === 47;
});
chk('espn: a postponed game is not a final', () => {
  const ev = espnEvent();
  ev.competitions[0].status.type.name = 'STATUS_POSTPONED';
  return S.parseEspnScoreboard({ events: [ev] })['401'].final === null;
});
chk('espn: the summary shape reads the same way', () => {
  const ev = espnEvent();
  const g = S.parseEspnSummary({ header: { id: '401', competitions: ev.competitions }, pickcenter: ev.competitions[0].odds }, '401');
  return g.close.home_line === -7.5 && g.final.away_score === 24;
});
chk('espn: the count of odds objects is carried for the run log', () =>
  S.parseEspnScoreboard({ events: [espnEvent()] })['401'].odds_n === 1
  && S.parseEspnScoreboard({ events: [espnEvent({ noOdds: true })] })['401'].odds_n === 0);
chk('espn: scoreboard dates are Eastern calendar dates', () => S.etDate('2026-09-27T03:30:00Z') === '20260926' && S.etDate('2026-09-26T16:00:00Z') === '20260926');

/* --------------------------------------------------------- end to end */
(async function () {
  const R = require('./football_record.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbrec-'));
  try {
    const dry = await R.run({ offline: true, write: false, out: tmp, now: '2026-09-20T00:00:00Z' });
    chk('CLI dry run records the committed slates and writes nothing', dry.summary.sports.nfl.counts.recorded + dry.summary.sports.cfb.counts.recorded > 0
      && fs.readdirSync(tmp).length === 0, dry.summary.sports.nfl.counts);
    const w = await R.run({ offline: true, write: true, out: tmp, now: '2026-09-20T00:00:00Z' });
    const files = fs.readdirSync(tmp).sort();
    chk('CLI --write writes both ledgers and the summary', eq(files, ['cfb_' + w.season + '.json', 'nfl_' + w.season + '.json', 'summary.json']), files);
    const again = await R.run({ offline: true, write: true, out: tmp, now: '2026-09-20T00:00:00Z' });
    chk('a second identical run changes nothing on disk', again.written.nfl === 'unchanged' && again.written.cfb === 'unchanged' && again.written.summary === 'unchanged', again.written);
    const L = JSON.parse(fs.readFileSync(path.join(tmp, 'nfl_' + w.season + '.json'), 'utf8'));
    chk('every recorded NFL number was published before its kickoff', Object.values(L.games).every((e) => Date.parse(e.pick.at) < Date.parse(e.kickoff) && Date.parse(e.first.at) < Date.parse(e.kickoff)));
    chk('the ledger is not the edges record: no signals fields', Object.values(L.games).every((e) => !('sig_key' in e) && !('flagged_at' in e)));
    const now = Date.parse('2026-09-26T10:00:00Z'), k = (h) => new Date(now + h * 3600000).toISOString();
    chk('ESPN is asked about a quoted game again only inside the pre-close window',
      R.needsEspn({ kickoff: k(20), market_pick: {}, entry: {} }, now) === true
      && R.needsEspn({ kickoff: k(80), market_pick: {}, entry: {} }, now) === false
      && R.needsEspn({ kickoff: k(80), market_pick: null, entry: null }, now) === true
      && R.needsEspn({ kickoff: k(-30), final: {}, close: { home_line: -3 } }, now) === false
      && R.needsEspn({ kickoff: k(-30), final: {}, close: null }, now) === true);
    const fin = { home_score: 1, away_score: 0 };
    chk('a graded game without a closing price is asked for one, at most three times',
      R.needsPrice({ kickoff: k(-30), final: fin, close: { home_line: -3, total: 45 } }, now) === true
      && R.needsPrice({ kickoff: k(-30), final: fin, close: { home_line: -3, total: 45 }, close_price_asks: 3 }, now) === false
      && R.needsPrice({ kickoff: k(-30), final: fin, close: { home_line: -3, total: 45, prices: { home: -110, away: -110, over: -110, under: -110 } } }, now) === false
      && R.needsPrice({ kickoff: k(-30), final: null, close: { home_line: -3 } }, now) === false
      && R.needsPrice({ kickoff: k(20), final: null, close: null }, now) === false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  /* the committed record itself, when present, must obey the same rules */
  const dir = path.join(__dirname, '..', '..', 'record', 'football');
  if (fs.existsSync(path.join(dir, 'summary.json'))) {
    ['nfl', 'cfb'].forEach((sp) => {
      /* the season ledgers only (<sport>_<season>.json, football_record.js): the CFB Model
         Lab publishes its own record, cfb_model_lab.json, beside them under another schema */
      fs.readdirSync(dir).filter((f) => new RegExp('^' + sp + '_\\d{4}\\.json$').test(f)).forEach((f) => {
        const L = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const bad = Object.values(L.games).filter((e) => !(Date.parse(e.pick.at) < Date.parse(e.kickoff)) || (e.entry && e.entry.market && e.entry.market.at && !(Date.parse(e.entry.market.at) < Date.parse(e.kickoff))));
        chk('committed ' + f + ': every pick and entry is pregame', bad.length === 0, bad.slice(0, 3).map((e) => e.game_id));
        chk('committed ' + f + ': schema', L.schema === C.SCHEMA && L.sport === sp);
      });
    });
    const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    chk('committed summary: schema and both sports', sum.schema === C.SUMMARY_SCHEMA && sum.sports.nfl && sum.sports.cfb);
    /* once the record is priced, its units are the sum of its games', and
       every pick says how it was priced */
    ['nfl', 'cfb'].forEach((sp) => {
      const S = sum.sports[sp];
      if (!S || !S.net) return;
      const L = JSON.parse(fs.readFileSync(path.join(dir, sp + '_' + sum.season + '.json'), 'utf8'));
      const picks = [];
      Object.values(L.games).forEach((e) => { const p = e.grade && e.grade.pnl; if (p) ['spread', 'total', 'ml'].forEach((k) => { if (p[k]) picks.push(p[k]); }); });
      chk('committed ' + sp + ': net units are the sum of every graded pick', Math.abs(picks.reduce((a, x) => a + x.units, 0) - S.net.units) < 1e-3 && picks.length === S.net.n, [S.net.units, picks.length, S.net.n]);
      chk('committed ' + sp + ': every pick is priced at its close or the marked standard -110', picks.every((x) => (x.basis === 'close' && x.odds != null) || (x.basis === 'standard' && x.odds === C.STANDARD_PRICE)));
    });
  }

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
