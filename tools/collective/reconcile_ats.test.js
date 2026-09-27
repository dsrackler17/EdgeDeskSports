#!/usr/bin/env node
/* Tests for the ATS reconciliation tool.

   The tool's whole claim is that it reads the PAGE's arithmetic rather than a
   second copy of it, and that the cumulative record equals the sum of the
   rows it prints. Both are asserted here against a record file and a games
   export this suite writes itself, so it runs offline.

   Run: node tools/collective/reconcile_ats.test.js                        */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const R = require('./reconcile_ats.js');

let pass = 0, fail = 0; const fails = [];
const chk = (name, ok, detail) => { if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = String(e && e.message || e); } } ok ? pass++ : (fail++, fails.push({ name, detail })); };

const TOOL = path.join(__dirname, 'reconcile_ats.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));

/* Home convention throughout: cover = home margin + closing spread.
   g1  home wins by 7 into a close of -3   -> cover +4, home covers
   g2  home wins by 2 into a close of -6.5 -> cover -4.5, away covers
   g3  home wins by 3 into a close of -3   -> cover 0, push
   g4  home wins by 9, NO captured close   -> no ATS result
   g5  the model's line sits exactly on the close -> it named no side
   g6  posted after the lock                -> excluded by rule           */
const row = o => Object.assign({ creator_slug: 'c', model_slug: 'm' }, o);
const game = (id, hs, as, close, models, week) => ({
  game_id: id, label: `AWAY @ HOME ${id}`, home: 'HOME' + id, away: 'AWAY' + id,
  week: week == null ? 1 : week, kickoff_at: '2026-09-05T16:00:00Z',
  result: { home_score: hs, away_score: as, closing_spread: close, closing_total: null },
  models: models,
});
const EXPORT = { games: [
  game('g1', 28, 21, -3, [row({ pick_side: 'home', projected_spread: -7, home_win_probability: 0.7 })]),
  game('g2', 23, 21, -6.5, [row({ pick_side: 'away', projected_spread: -2, home_win_probability: 0.55 })]),
  game('g3', 24, 21, -3, [row({ pick_side: 'home', projected_spread: -4 })]),
  game('g4', 30, 21, null, [row({ pick_side: 'home', projected_spread: -8, home_win_probability: 0.8 })]),
  game('g5', 20, 17, -5, [row({ projected_spread: -5 })]),
  game('g6', 31, 10, -9, [row({ pick_side: 'home', projected_spread: -10, late: true })]),
] };
const file = path.join(dir, 'export.json');
fs.writeFileSync(file, JSON.stringify(EXPORT));

const out = JSON.parse(execFileSync(process.execPath,
  [TOOL, '--model', 'c/m', '--sport', 'CFB', '--season', 2026, '--games', file, '--json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

chk('every game the model posted is reconciled, one row each',
  out.games.length === 6 && new Set(out.games.map(g => g.game_id)).size === 6,
  out.games.length);
const by = {}; out.games.forEach(g => { by[g.game_id] = g; });

chk('a home pick covering the number is a win, and the arithmetic is shown',
  by.g1.grade === 'win' && by.g1.home_margin === 7 && by.g1.cover === 4);
chk('an away pick covering the number is a win',
  by.g2.grade === 'win' && by.g2.home_margin === 2 && by.g2.cover === -4.5);
chk('landing exactly on the close is a push, not a win and not a loss',
  by.g3.grade === 'push' && by.g3.cover === 0);
chk('a finished game with no captured close has no ATS result and says why',
  by.g4.grade === null && by.g4.excluded === 'no_close' && by.g4.cover === null);
chk('a model whose line sits on the close named no side, which is a different reason',
  by.g5.grade === null && by.g5.excluded === 'no_side' && by.g5.side === null);
chk('a late submission is excluded by the published rule, and named',
  by.g6.grade === null && by.g6.excluded === 'excluded_late');
chk('a side the model never stated is labelled as implied, not as a stated pick',
  by.g1.side_from === 'stated' &&
  (by.g5.side_from === null || /implied/.test(by.g5.side_from || '')));

chk('the cumulative record is 2-0-1 over three graded games',
  out.record.wins === 2 && out.record.losses === 0 && out.record.pushes === 1 &&
  out.record.ats_n === 3, out.record);
chk('and the three ungraded games are counted and attributed',
  out.record.ats_missing_n === 3 && out.record.ats_missing.no_close === 1 &&
  out.record.ats_missing.no_side === 1 && out.record.ats_missing.excluded_late === 1,
  out.record.ats_missing);
chk('the margin and Brier samples are their own, and are not the ATS one',
  out.record.margin_n === 5 && out.record.brier_n === 3,
  { margin: out.record.margin_n, brier: out.record.brier_n, ats: out.record.ats_n });
chk('THE RECONCILIATION: the record equals the sum of the rows printed above it',
  out.agrees === true && out.tally.w === out.record.wins &&
  out.tally.l === out.record.losses && out.tally.p === out.record.pushes,
  { rows: out.tally, record: out.record });

/* ---- the committed record fills what the games payload left blank ------- */
chk('a blank close in the payload is filled from the settlement record, and only when it is blank',
  (() => {
    const games = [
      { game_id: 'x1', home: 'H', away: 'A', kickoff_at: '2026-09-05T16:00:00Z',
        result: { home_score: 28, away_score: 21, closing_spread: null } },
      { game_id: 'x2', home: 'H', away: 'A', kickoff_at: '2026-09-05T16:00:00Z',
        result: { home_score: 28, away_score: 21, closing_spread: -6 } },
      { game_id: 'x3', home: 'H', away: 'A', kickoff_at: '2026-09-05T16:00:00Z', result: null },
    ];
    const n = R.fillFromRecord(games, { games: {
      x1: { closing_spread: -3, close_source: 'collective_odds', home_score: 28, away_score: 21 },
      x2: { closing_spread: -9, close_source: 'collective_odds', home_score: 28, away_score: 21 },
      x3: { closing_spread: -1, close_source: 'collective_odds', home_score: 31, away_score: 10 },
    } });
    return n === 2 && games[0].result.closing_spread === -3 &&
      games[1].result.closing_spread === -6 &&      /* the payload's own number stands */
      games[2].result.home_score === 31 && games[2].result.closing_spread === -1;
  })());
chk('a 0-0 in the record is never carried into a reconciliation',
  (() => {
    const games = [{ game_id: 'z', home: 'H', away: 'A', kickoff_at: '2026-09-05T16:00:00Z', result: null }];
    R.fillFromRecord(games, { games: { z: { home_score: 0, away_score: 0, closing_spread: -3 } } });
    return games[0].result === null;
  })());

chk('the tool refuses to run without a model',
  (() => {
    try {
      execFileSync(process.execPath, [TOOL, '--games', file], { encoding: 'utf8', stdio: 'pipe' });
      return false;
    } catch (e) { return /--model/.test(String(e.stderr || '')); }
  })());

fs.rmSync(dir, { recursive: true, force: true });
fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
