#!/usr/bin/env node
/* ============================================================================
   tools/football/cfb_board_audit.js — the rules the read-only audit measures
   the board against, on fixed inputs (the committed board changes every hour,
   so nothing here depends on it except a structural smoke run).

   Run: node tools/football/cfb_board_audit.test.js
   ========================================================================== */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, 'cfb_board_audit.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
const ms = (s) => Date.parse(s);
const iso = (t) => new Date(t).toISOString();

/* ── the week window: Tue 00:00 -> Tue 00:00, America/Chicago ───────────── */
let w = A.weekWindow(ms('2026-09-30T19:36:54Z'));                 /* a Wednesday */
chk('a Wednesday sits in the Tue 09/29 -> Tue 10/06 window (CDT, UTC-5)', iso(w.from) === '2026-09-29T05:00:00.000Z' && iso(w.to) === '2026-10-06T05:00:00.000Z', [iso(w.from), iso(w.to)]);
w = A.weekWindow(ms('2026-10-04T04:30:00Z'));                     /* Sat 11:30pm CT, the late Hawai'i kickoff */
chk('a late Saturday game that is Sunday in UTC stays in its week', iso(w.from) === '2026-09-29T05:00:00.000Z', iso(w.from));
w = A.weekWindow(ms('2026-09-29T04:59:59Z'));                     /* Mon 11:59:59pm CT */
chk('Monday 23:59:59 CT belongs to the previous week', iso(w.from) === '2026-09-22T05:00:00.000Z', iso(w.from));
w = A.weekWindow(ms('2026-09-29T05:00:00Z'));                     /* Tue 00:00 CT */
chk('Tuesday 00:00 CT opens the week', iso(w.from) === '2026-09-29T05:00:00.000Z');
w = A.weekWindow(ms('2026-11-05T18:00:00Z'));                     /* across the DST change (Sun 11/01) */
chk('the week after the DST change opens at 06:00Z (CST)', iso(w.from) === '2026-11-03T06:00:00.000Z' && iso(w.to) === '2026-11-10T06:00:00.000Z', [iso(w.from), iso(w.to)]);
w = A.weekWindow(ms('2026-10-30T18:00:00Z'));
chk('the week spanning the DST change is 7 days + 1 hour long in UTC', iso(w.from) === '2026-10-27T05:00:00.000Z' && iso(w.to) === '2026-11-03T06:00:00.000Z', [iso(w.from), iso(w.to)]);
chk('the TBD placeholder 04:00Z renders as Friday 11:00p CT', A.chiLabel(ms('2026-10-10T04:00:00Z')) === 'FRI 10/09 11:00p CT', A.chiLabel(ms('2026-10-10T04:00:00Z')));

/* ── the reference market ─────────────────────────────────────────────── */
const NOW = ms('2026-09-30T19:36:54Z'), KICK = ms('2026-10-02T00:00:00Z');
const q = (o) => Object.assign({ source: 'espn', book: 'draftkings', market_type: 'spread', is_pregame: true, is_heartbeat: false,
  is_provider_open: false, is_provider_close: false, quote_id: 'q' + Math.random() }, o);
const WKU = [
  q({ home_line: -2.5, observed_at: '2026-09-29T18:07:26Z' }),                       /* the last CHANGE, 25.5 h ago */
  q({ home_line: -2.5, observed_at: '2026-09-30T19:07:32Z', is_heartbeat: true }),   /* re-confirmed 29 min ago */
  q({ home_line: 1.5, observed_at: '2026-09-27T15:07:15Z', is_provider_open: true }),/* the provider's opener */
  q({ source: 'cfbd', book: 'consensus', home_line: -1.25, observed_at: '2026-09-28T10:09:19Z' })
];
let r = A.referenceMarket(WKU, KICK, NOW, 360);
chk('a heartbeat is an observation: the line is current (29 min)', r.books_fresh === 1 && r.newest_age_min === 29 && r.consensus_home_line === -2.5, r);
chk('the provider average is left out when a real book quotes', r.books_seen === 1, r.books_seen);
chk('the provider-declared opener never becomes the market', !r.books.some((b) => b.home_line === 1.5));
let b = A.boardRuleMarket(WKU, KICK, NOW);
chk('the build\'s rule today (heartbeats dropped, 180 min) calls it stale', b.books_fresh === 0 && b.newest_change_age_min === 1529, b);
r = A.referenceMarket(WKU, KICK, NOW, 20);
chk('outside the window nothing is current, and the age is still reported', r.books_fresh === 0 && r.consensus_home_line === null && r.newest_age_min === 29, r);
r = A.referenceMarket([q({ home_line: -3, observed_at: '2026-10-02T00:10:00Z' })], KICK, ms('2026-10-02T01:00:00Z'), 360);
chk('a quote at or after kickoff is never a pregame market', r.books_seen === 0);
r = A.referenceMarket([q({ home_line: -3, observed_at: '2026-09-30T19:00:00Z' }), q({ book: 'fanduel', home_line: -4, observed_at: '2026-09-30T19:10:00Z' }),
  q({ book: 'betmgm', home_line: -3.5, observed_at: '2026-09-30T18:00:00Z' })], KICK, NOW, 360);
chk('consensus is the median of the books\' latest quotes; age from the newest', r.consensus_home_line === -3.5 && r.fresh_age_min === 27, r);

/* ── a structural smoke run over the committed artifacts ─────────────── */
try {
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..', '..');
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), 'utf8'));
  const slate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const sched = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cfb_schedule_2026_wk05_06.json'), 'utf8')).rows;
  const out = A.audit({ season: 2026, board, slate, lastRun: {}, now: ms(board.generated_at), freshMin: 360, scheduleRows: sched });
  chk('the audit runs over the committed artifacts and reports every section',
    out.counts && Array.isArray(out.funnel) && Array.isArray(out.unmatched) && Array.isArray(out.market_vs_consensus)
      && out.false_stale && Array.isArray(out.outside_week) && Array.isArray(out.duplicates) && Array.isArray(out.spot), Object.keys(out));
} catch (e) { chk('the smoke run did not throw', false, e.message); }

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
