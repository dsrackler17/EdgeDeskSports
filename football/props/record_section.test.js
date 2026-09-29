#!/usr/bin/env node
/* ===========================================================================
   The player-prop record as WIRED INTO record.html (the EDPROPS_REC block,
   cut out between its markers and run in a sandbox) over summaries written by
   the real football/props/record.js:

     - no file at all, and a summary with no entry (the state today: no prop
       quote has been captured, so nothing can be frozen)
     - a populated record: entries FROZEN from a board priced with the TEST
       FIXTURE quotes of fixture_quotes.js, SETTLED against box scores (one
       player recorded no game → VOID), then summarised

     node football/props/record_section.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EDP = require('../../lib/player_props.js');
const REC = require('./record.js');
const FX = require('./fixture_quotes.js');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String(e && e.message) }; } }
  if (ok) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'record.html'), 'utf8');
const a = PAGE.indexOf('/*__EDPROPS_REC_START__*/'), b = PAGE.indexOf('/*__EDPROPS_REC_END__*/');
chk('record.html carries the player-prop block and its host element', a > 0 && b > a && /id="propsRec"/.test(PAGE) && /id="player-props"/.test(PAGE));
const sandbox = { window: {}, fetch: () => Promise.reject(new Error('offline')) };
vm.runInNewContext(PAGE.slice(a, b), sandbox);
const R = sandbox.window.EDPROPSREC;
const text = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/* 1. nothing to show */
chk('no file: the empty state, and it says nothing was made up', /No player-prop entry has been frozen yet/.test(R.sectionHTML(null)) && /rather than something made up/.test(R.sectionHTML(null)));
const empty = REC.summarize([]);
chk('an empty summary (no quote captured yet): the empty state, no KPI tiles', /No player-prop entry has been frozen yet/.test(R.sectionHTML(empty)) && !/class="kpi"/.test(R.sectionHTML(empty)));
const committed = path.join(ROOT, 'record', 'props', 'summary.json');
if (fs.existsSync(committed)) chk('the committed record/props/summary.json renders', () => { const h = R.sectionHTML(JSON.parse(fs.readFileSync(committed, 'utf8'))); return /player-prop|units/.test(text(h)); });

/* 2. a populated record through the real freeze / settle / summarize */
if (fs.existsSync(path.join(__dirname, 'published', 'board_nfl.json'))) {
  const f = FX.build('nfl');
  const card = JSON.parse(fs.readFileSync(path.join(__dirname, 'published', 'nfl', f.game_id + '.json'), 'utf8'));
  const props = EDP.wire.expandCard(card, f.markets[f.game_id]);
  const g = card.game;
  const before = Date.parse(g.kickoff_utc) - 6 * 3600e3;
  props.forEach((p) => { if (p.player === props[0].player) p.player = '<img src=x onerror=alert(1)> ' + p.player; });
  const rec = { schema: REC.SCHEMA, league: 'NFL', season: 2026, entries: {} };
  const fr = REC.freeze({ league: 'NFL', season: 2026, props }, { record: rec, now: before });
  const frozenN = Object.keys(rec.entries).length;
  chk('freeze: every LEAN/BET prop with an observed quote is frozen once, before kickoff', frozenN > 0 && frozenN === props.filter((p) => p.focus && (p.decision.decision === 'LEAN' || p.decision.decision === 'BET')).length, frozenN);
  const again = REC.freeze({ league: 'NFL', season: 2026, props: props.map((p) => Object.assign({}, p, { focus: p.focus && Object.assign({}, p.focus, { american: 999 }) })) }, { record: rec, now: before + 3600e3 });
  chk('freeze: a later run never rewrites a frozen entry', again.added.length === 0 && Object.values(rec.entries).every((e) => e.american !== 999));
  chk('freeze: nothing freezes at or after kickoff', REC.freeze({ league: 'NFL', season: 2026, props }, { record: { entries: {} }, now: Date.parse(g.kickoff_utc) }).added.length === 0);
  /* the box scores: every frozen player but one played */
  const players = Array.from(new Set(Object.values(rec.entries).map((e) => e.player_id)));
  const dnp = players[players.length - 1];
  const facts = players.filter((pid) => pid !== dnp).map((pid, i) => ({ game_id: g.game_id, player_id: pid, season: 2026, receiving_yards: 20 + 7 * i, receptions: 2 + (i % 5), targets: 4 + (i % 6),
    receiving_tds: i % 3 === 0 ? 1 : 0, rushing_yards: 5 + 9 * (i % 7), carries: 2 + (i % 9), rushing_tds: i % 4 === 0 ? 1 : 0, passing_yards: 210 + 5 * i, attempts: 33, completions: 21,
    passing_tds: 2, interceptions: i % 2, longest_reception: 12 + i, longest_rush: 4 + i, longest_completion: 30 + i, source_quality: 1 }));
  const wh = { leagues: { NFL: { games: [{ game_id: g.game_id, status: 'final', kickoff_utc: g.kickoff_utc }], playerGames: facts } } };
  const n = REC.settle(rec, wh, [], { now: Date.parse(g.kickoff_utc) + 8 * 3600e3 });
  const es = Object.values(rec.entries);
  chk('settle: every entry is graded once; the player who did not play is VOID', n === es.length && es.filter((e) => e.player_id === dnp).every((e) => e.grade.result === 'VOID') && es.filter((e) => e.player_id !== dnp).every((e) => /WIN|LOSS|PUSH/.test(e.grade.result)));
  chk('settle: a graded entry is never re-graded', REC.settle(rec, wh, [], { now: Date.now() }) === 0);
  const sum = REC.summarize([rec]);
  const h = R.sectionHTML(JSON.parse(JSON.stringify(sum))), t = text(h);
  const w = es.filter((e) => e.grade.result === 'WIN').length, l = es.filter((e) => e.grade.result === 'LOSS').length, p = es.filter((e) => e.grade.result === 'PUSH').length;
  chk('populated: the tiles copy the summary (entries, graded, won-lost-push)', t.indexOf(String(sum.total.n) + ' entries frozen') >= 0 && t.indexOf(w + '-' + l + '-' + p) >= 0, t.slice(0, 400));
  chk('populated: every segment family is listed, bad segments included', ['League', 'Market', 'Position', 'Edge at entry', 'Confidence', 'Price', 'Sportsbook', 'Decision', 'Model version'].every((s) => t.indexOf(s) >= 0));
  chk('populated: a small record says it is too small to judge', /fewer than 100 graded entries/.test(t) && /under 100 graded/.test(t));
  chk('populated: a hostile name is escaped, never executed', !/<img src=x/.test(h));
}

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props record section — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
