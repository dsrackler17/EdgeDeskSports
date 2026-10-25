#!/usr/bin/env node
/* ===========================================================================
   football/data/play_offence.js, and the two readers of player_stats that use
   it: the player/team build (football/players/build_players.js loadPlays) and
   the starter build (football/starters/build_starters.js cfbDropbackRows).

   The case is the 2026-10-24 rebuild of player_stats_2026.csv, which files
   some incomplete passes under the defence (play_offence.js says how many).

   Run: node football/data/play_offence.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const PO = require(path.join(__dirname, 'play_offence.js'));

/* ---- the rule ---- */
{
  const O = PO.create();
  /* game 1: Akron's QB 11 completes on drive d1; Wake Forest's QB 22 runs on d2 */
  O.observe('1', 'd1', 'Akron', '11', null);
  O.observe('1', 'd1', 'Akron', null, '33');
  O.observe('1', 'd2', 'Wake Forest', null, '22');
  chk('an incompletion filed under the defence goes to the team its passer completed for',
    O.offence('1', 'd1', 'Wake Forest', 'Akron', '11') === 'Akron');
  chk('…or ran for', O.offence('1', 'd2', 'Akron', 'Wake Forest', '22') === 'Wake Forest');
  chk('an incompletion already filed under the offence stays there', O.offence('1', 'd1', 'Akron', 'Wake Forest', '11') === 'Akron');
  chk('a passer with no completion or run in the game: the drive\'s offence decides', O.offence('1', 'd1', 'Wake Forest', 'Akron', '99') === 'Akron');
  chk('nothing known about the passer or the drive: the row stays as the feed has it', O.offence('1', 'd9', 'Wake Forest', 'Akron', '99') === 'Wake Forest');
  chk('a passer known only in another game says nothing about this one', O.offence('2', null, 'Wake Forest', 'Akron', '11') === 'Wake Forest');
  O.observe('3', 'd3', 'Ohio', '44', null);
  chk('the answer is only ever the row\'s team or its opponent, never a third team', O.offence('3', 'd3', 'Toledo', 'Kent State', '44') === 'Toledo');
}

/* ---- the readers, on one synthetic game ---- */
const HEAD = ['game_id', 'season', 'week', 'team', 'conference', 'opponent', 'team_score', 'opponent_score', 'drive_id', 'play_id',
  'period', 'down', 'distance', 'yards_to_goal', 'rush_player_id', 'rush_player', 'rush_yds',
  'completion_player_id', 'completion_player', 'completion_yds', 'incompletion_player_id', 'incompletion_player',
  'reception_player_id', 'reception_player', 'reception_yds', 'target_player_id', 'target_player',
  'interception_thrown_player_id', 'interception_thrown_player', 'interception_player_id', 'interception_player',
  'sack_player_id', 'sack_player', 'sack_taken_player_id', 'sack_taken_player', 'sack_taken_stat',
  'pass_breakup_player_id', 'pass_breakup_player'];
function row(o) { return HEAD.map((k) => (o[k] == null ? 'NA' : String(o[k]))).join(','); }
const base = { game_id: '9001', season: 2015, week: 3, team_score: 7, opponent_score: 3, period: 1, down: 1, distance: 10, yards_to_goal: 75 };
const ak = { team: 'Akron', conference: 'Mid-American', opponent: 'Wake Forest', drive_id: '90011' };
const wf = { team: 'Wake Forest', conference: 'ACC', opponent: 'Akron', drive_id: '90012' };
const lines = [
  /* Akron's drive: two completions, a run, an incompletion filed correctly and two the feed filed under Wake Forest */
  row({ ...base, ...ak, play_id: 1, completion_player_id: 11, completion_player: 'A QB', completion_yds: 12, reception_player_id: 12, reception_player: 'A WR', reception_yds: 12 }),
  row({ ...base, ...ak, play_id: 2, rush_player_id: 13, rush_player: 'A RB', rush_yds: 4 }),
  row({ ...base, ...ak, play_id: 3, incompletion_player_id: 11, incompletion_player: 'A QB', target_player_id: 12, target_player: 'A WR' }),
  row({ ...base, ...ak, team: 'Wake Forest', conference: 'ACC', opponent: 'Akron', play_id: 4, incompletion_player_id: 11, incompletion_player: 'A QB', target_player_id: 12, target_player: 'A WR', pass_breakup_player_id: 21, pass_breakup_player: 'W CB' }),
  row({ ...base, ...ak, team: 'Wake Forest', conference: 'ACC', opponent: 'Akron', play_id: 5, incompletion_player_id: 11, incompletion_player: 'A QB' }),
  row({ ...base, ...ak, play_id: 6, completion_player_id: 11, completion_player: 'A QB', completion_yds: 6, reception_player_id: 12, reception_player: 'A WR', reception_yds: 6 }),
  /* Wake Forest's drive: one completion and one incompletion, both filed correctly */
  row({ ...base, ...wf, play_id: 7, completion_player_id: 22, completion_player: 'W QB', completion_yds: 8, reception_player_id: 23, reception_player: 'W WR', reception_yds: 8 }),
  row({ ...base, ...wf, play_id: 8, incompletion_player_id: 22, incompletion_player: 'W QB' })
];
const csv = HEAD.join(',') + '\n' + lines.join('\n') + '\n';

/* build_players.loadPlays reads through its cache; 2015 is a finished season, so the cache is used as is */
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'play-offence-'));
fs.writeFileSync(path.join(cache, 'pstats_2015.csv'), csv);
process.env.EDP_CACHE = cache;
const BP = require(path.join(__dirname, '..', 'players', 'build_players.js'));
(async () => {
  const P = await BP.loadPlays(2015, null);
  const tgOf = (team) => [...P.teamGames.values()].find((t) => t.team_name === team);
  const A = tgOf('Akron'), W = tgOf('Wake Forest');
  chk('loadPlays: the two incompletions filed under the defence are refiled, and counted', P.counts.incompletions_refiled === 2, P.counts);
  chk('loadPlays: Akron threw 5 passes (2 completions, 3 incompletions) on 5 dropbacks', A && A.off.pass_att === 5 && A.off.pass_cmp === 2 && A.off.dropbacks === 5, A && A.off);
  chk('loadPlays: Wake Forest threw 2, not 4', W && W.off.pass_att === 2 && W.off.dropbacks === 2, W && W.off);
  chk('loadPlays: Akron\'s team-game keeps its own conference and opponent', A && A.conference === 'Mid-American' && A.opp_name === 'Wake Forest', A && [A.conference, A.opp_name]);
  const qb = P.players.get('11');
  chk('loadPlays: Akron\'s quarterback stays on Akron with 5 attempts', qb && qb.team === 'akron' && qb.teams.size === 1 && qb.stat.pass_att === 5, qb && [qb.team, [...qb.teams], qb.stat]);
  chk('loadPlays: the receiver\'s targets follow the passer', P.players.get('12').team === 'akron' && P.players.get('12').stat.targets === 4);
  chk('loadPlays: the defender who broke it up is still credited to the defence', P.players.get('21') && P.players.get('21').team === 'wakeforest' && P.players.get('21').stat.def_pbu === 1);

  /* build_starters.cfbDropbackRows reads objects (recovery.js parseCsv) */
  const R = require(path.join(__dirname, 'recovery.js'));
  const BS = require(path.join(__dirname, '..', 'starters', 'build_starters.js'));
  const drops = BS.cfbDropbackRows(R.parseCsv(csv, { columns: HEAD }));
  const qbRows = drops.filter((d) => d.player_id === '11');
  chk('cfbDropbackRows: every one of Akron\'s quarterback\'s dropbacks is Akron\'s, against Wake Forest', qbRows.length === 5 && qbRows.every((d) => d.team === 'Akron' && d.opponent === 'Wake Forest'), qbRows.map((d) => d.team));
  chk('cfbDropbackRows: Wake Forest\'s dropbacks are its own quarterback\'s only', drops.filter((d) => d.team === 'Wake Forest').every((d) => d.player_id === '22'));

  fs.rmSync(cache, { recursive: true, force: true });
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'play offence — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
