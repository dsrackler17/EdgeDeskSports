#!/usr/bin/env node
/* ===========================================================================
   COLLEGE BASEBALL STATS — SHAPING TESTS

   No network. Every fixture below is a real payload shape, copied from what a
   runner actually returned, including the awkward parts: statistics groups
   whose name is undefined, a name with a position spliced into it, an innings
   figure in thirds, and a game whose groups exist but carry no athletes.

   The tests that matter most are the ones that would pass if the code were
   wrong in a plausible way — reading innings as a decimal, averaging a
   season-to-date column, trusting a group name.
   =========================================================================== */
'use strict';

const S = require('./stats.js');

let pass = 0, fail = 0;
const eq = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
};
const truthy = (what, got) => eq(what, !!got, true);

/* ── innings, the one that silently corrupts a season ───────────────────── */
console.log('innings pitched is thirds, not a decimal');
eq('a whole innings', S.toOuts('7.0'), 21);
eq('one out into the eighth', S.toOuts('7.1'), 22);
eq('two outs into the eighth', S.toOuts('7.2'), 23);
eq('a bare integer', S.toOuts('6'), 18);
eq('zero innings is zero outs, not unknown', S.toOuts('0.0'), 0);
/* THE TEST THAT CATCHES THE BUG: 6.2 + 6.2 as decimals is 12.4, which is not
   a possible innings figure. As outs it is 20 + 20 = 40, which is 13.1. */
eq('two starts of 6.2 add to 13.1, not 12.4', S.outsToIp(S.toOuts('6.2') + S.toOuts('6.2')), '13.1');
eq('.3 is not a third of an inning and is refused', S.toOuts('6.3'), null);
eq('nonsense is refused rather than guessed', S.toOuts('abc'), null);
eq('an absent figure stays unknown', S.toOuts(''), null);
eq('outs round-trip to innings', S.outsToIp(22), '7.1');

/* ── the group name is not to be trusted ─────────────────────────────────── */
console.log('the kind of line comes from the labels, never the group name');
eq('batting is recognised by AB and RBI',
  S.lineTypeOf(['H-AB', 'AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', '#P', 'AVG', 'OBP', 'SLG']), 'batting');
eq('pitching is recognised by IP and ER',
  S.lineTypeOf(['IP', 'H', 'R', 'ER', 'BB', 'K', 'HR', 'PC-ST', 'ERA', 'PC']), 'pitching');
eq('a group matching neither is not guessed at', S.lineTypeOf(['FOO', 'BAR']), null);
eq('no labels at all is not a line', S.lineTypeOf(undefined), null);

/* ── a batting line, read off a live payload ─────────────────────────────── */
console.log('a batting line');
const BAT_LABELS = ['H-AB', 'AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', '#P', 'AVG', 'OBP', 'SLG'];
const ctx = {
  game_id: '401847464', season: 2026, game_date: '2026-05-09',
  team_id: '238', team_name: 'Vanderbilt Commodores', opponent_team_id: '142',
};
/* Ryker Waite, as the source returned him */
const bat = S.shapeLine(ctx, 'batting', BAT_LABELS, {
  athlete: { id: '5100', displayName: 'Ryker Waite' },
  position: { abbreviation: 'SS' },
  stats: ['1-3', '3', '0', '1', '0', '0', '0', '0', '0', '.120', '.233', '.240'],
});
eq('at-bats', bat.ab, 3);
eq('hits', bat.hits, 1);
eq('runs', bat.runs, 0);
eq('the position comes through', bat.position, 'SS');
eq('the pitching columns stay null on a batting line', [bat.outs, bat.earned_runs], [null, null]);
/* THE POINT: .120 is his SEASON average after this game, not 1-for-3 = .333 */
eq('the AVG column is stored as a season-to-date figure', bat.season_avg_at_game, 0.12);
eq('…and OBP likewise', bat.season_obp_at_game, 0.233);
eq('…and SLG likewise', bat.season_slg_at_game, 0.24);
truthy('nothing on the line claims to be a game rate',
  bat.avg === undefined && bat.obp === undefined);

console.log('a batting line whose explicit columns are missing');
const sparse = S.shapeLine(ctx, 'batting', BAT_LABELS, {
  athlete: { id: '5101', displayName: 'Nobody Here' },
  stats: ['2-5', '', '1', '', '0', '0', '1', '2', '0', '-', '-', '-'],
});
eq('H-AB fills in at-bats when the column is blank', sparse.ab, 5);
eq('…and hits', sparse.hits, 2);
eq('a dash is unknown, not zero', sparse.season_avg_at_game, null);

/* ── a pitching line ─────────────────────────────────────────────────────── */
console.log('a pitching line');
const PIT_LABELS = ['IP', 'H', 'R', 'ER', 'BB', 'K', 'HR', 'PC-ST', 'ERA', 'PC'];
const pit = S.shapeLine(ctx, 'pitching', PIT_LABELS, {
  athlete: { id: '6001', displayName: 'Connor Fennell' },
  stats: ['7.0', '5', '1', '1', '2', '8', '0', '109-71', '5.40', '109'],
});
eq('innings become outs', pit.outs, 21);
eq('hits allowed', pit.p_hits, 5);
eq('earned runs', pit.earned_runs, 1);
eq('strikeouts', pit.p_so, 8);
eq('the pitch count comes out of PC-ST', pit.pitch_count, 109);
eq('…and the strikes with it', pit.strikes, 71);
eq('ERA is a season-to-date figure', pit.season_era_at_game, 5.4);
eq('the batting columns stay null on a pitching line', [pit.ab, pit.hits], [null, null]);

console.log('a pitching line with a partial innings figure');
const partial = S.shapeLine(ctx, 'pitching', PIT_LABELS, {
  athlete: { id: '6002', displayName: 'Xander - P Mercurius' },
  stats: ['7.1', '6', '3', '3', '2', '9', '3', '104-72', '5.51', '104'],
});
eq('7.1 is 22 outs', partial.outs, 22);
/* a name is how a reader finds a player; "Xander - P Mercurius" is not a name */
eq('a position spliced into the name is stripped', partial.athlete_name, 'Xander Mercurius');

/* ── the whole box score ─────────────────────────────────────────────────── */
console.log('the whole box score of one game');
const game = {
  game_id: '401847464', season: 2026, game_date: '2026-05-09',
  home_team_id: '142', away_team_id: '238',
  home_name: 'Missouri Tigers', away_name: 'Vanderbilt Commodores',
};
/* NOTE: name is deliberately undefined on every group, which is exactly how
   the source returns the games that actually have data in them. */
const summary = {
  boxscore: {
    teams: [{ team: { id: '238', displayName: 'Vanderbilt Commodores' } },
            { team: { id: '142', displayName: 'Missouri Tigers' } }],
    players: [
      { team: { id: '238', displayName: 'Vanderbilt Commodores', abbreviation: 'VAN' },
        statistics: [
          { labels: BAT_LABELS, athletes: [
            { athlete: { id: '5100', displayName: 'Ryker Waite' }, position: { abbreviation: 'SS' },
              stats: ['1-3', '3', '0', '1', '0', '0', '0', '0', '0', '.120', '.233', '.240'] }] },
          { labels: PIT_LABELS, athletes: [
            { athlete: { id: '6001', displayName: 'Connor Fennell' },
              stats: ['7.0', '5', '1', '1', '2', '8', '0', '109-71', '5.40', '109'] }] }] },
      { team: { id: '142', displayName: 'Missouri Tigers', abbreviation: 'MIZ' },
        statistics: [
          { labels: BAT_LABELS, athletes: [
            { athlete: { id: '5200', displayName: 'Jase Woita' }, position: { abbreviation: '1B' },
              stats: ['0-4', '4', '0', '0', '0', '0', '1', '1', '0', '.324', '.390', '.649'] }] }] },
    ],
  },
  /* stolen bases live only here — see the schema's TRAP 3 */
  rosters: [
    { team: { abbreviation: 'VAN' }, roster: [
      { athlete: { id: '5100', displayName: 'Ryker Waite' },
        stats: [{ name: 'atBats', value: 3 }, { name: 'stolenBases', value: 2 }] }] },
    { team: { abbreviation: 'MIZ' }, roster: [
      { athlete: { id: '9999', displayName: 'Never Played' },
        stats: [{ name: 'stolenBases', value: 1 }] }] },
  ],
};
const box = S.shapeBoxScore(summary, game);
eq('every line is collected', box.lines.length, 3);
truthy('the game is marked as having players', box.had_players);
const waite = box.lines.find((r) => r.athlete_id === '5100' && r.line_type === 'batting');
eq('the visiting club is attributed correctly', waite.team_id, '238');
eq('…and so is its opponent', waite.opponent_team_id, '142');
eq('stolen bases are merged from the rosters branch', waite.stolen_bases, 2);
const woita = box.lines.find((r) => r.athlete_id === '5200');
eq('the home club is attributed correctly', woita.team_id, '142');
eq('…with the visitor as its opponent', woita.opponent_team_id, '238');
/* A player who appears only in rosters has no box-score line to attach to, and
   inventing one would invent at-bats he never had. */
eq('a rosters-only player is not given a line', box.lines.filter((r) => r.athlete_id === '9999').length, 0);
eq('a two-way club still yields one row per role',
  box.lines.filter((r) => r.team_id === '238').map((r) => r.line_type).sort(), ['batting', 'pitching']);

console.log('a game whose groups exist but carry nobody');
/* This is the 15 April game, verbatim in shape: named groups, zero athletes.
   It must come back empty AND say so, because "no lines" and "not read" have
   to stay distinguishable in the coverage figure. */
const empty = S.shapeBoxScore({
  boxscore: { teams: [], players: [
    { team: { id: '277', displayName: 'West Virginia Mountaineers' },
      statistics: [{ name: 'batting', labels: BAT_LABELS, athletes: [] },
                   { name: 'pitching', labels: PIT_LABELS, athletes: [] }] }] },
}, game);
eq('no lines are produced', empty.lines.length, 0);
eq('…and the game is reported as carrying no players', empty.had_players, false);

console.log('a summary that is missing entirely');
eq('no summary yields nothing rather than throwing', S.shapeBoxScore(null, game).lines.length, 0);

/* ── the implausibility check ────────────────────────────────────────────── */
console.log('a line that cannot be true is caught, not stored');
truthy('more hits than at-bats is refused',
  S.implausible({ line_type: 'batting', ab: 3, hits: 4 }));
eq('a legitimate line is not', S.implausible({ line_type: 'batting', ab: 4, hits: 4 }), null);
truthy('earned runs above total runs is refused',
  S.implausible({ line_type: 'pitching', p_runs: 2, earned_runs: 3, outs: 9 }));
eq('unearned runs are perfectly legal',
  S.implausible({ line_type: 'pitching', p_runs: 5, earned_runs: 2, outs: 9 }), null);
eq('a line with unknowns is not accused', S.implausible({ line_type: 'batting', ab: null, hits: null }), null);

/* ── the pair splitter ───────────────────────────────────────────────────── */
console.log('paired columns');
eq('pitches and strikes', S.splitPair('109-71'), [109, 71]);
eq('hits and at-bats', S.splitPair('1-3'), [1, 3]);
eq('an unparseable pair is two unknowns', S.splitPair('--'), [null, null]);
eq('an absent pair likewise', S.splitPair(null), [null, null]);

console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
console.log(fail ? `FAIL | cbb stats shaping | ${fail} failed`
  : `PASS | cbb stats shaping | ${pass} assertions`);
process.exit(fail ? 1 : 0);
