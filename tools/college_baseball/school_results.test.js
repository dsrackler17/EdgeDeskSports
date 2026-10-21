#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Results from the schools' own sites (college_baseball/ingest/
   school_results.js) on a synthetic season: both schools agreeing fills a
   contest, one school's word fills it when the other is silent, schools that
   disagree leave it empty, a doubleheader pairs in listed order, home and
   away are our record's, and an audit counts agreement with what we hold.

   Run: node tools/college_baseball/school_results.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SR = require(path.join(ROOT, 'college_baseball/ingest/school_results.js'));
const { readCsv } = require(path.join(ROOT, 'engine/csv.js'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolres-'));
const coll = path.join(tmp, 'collegiate');
const put = (rel, obj) => { const p = path.join(coll, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); };
put('schools.json', { schools: [
  { id: 'alpha', name: 'Alpha', host: 'alpha.edu', baseball_team_id: 1 },
  { id: 'beta', name: 'Beta St.', host: 'beta.edu', baseball_team_id: 2 },
  { id: 'gamma', name: 'Gamma', host: 'gamma.edu', baseball_team_id: 3 },
  { id: 'delta', name: 'Delta', host: 'delta.edu', baseball_team_id: 4 }, { id: 'eps', name: 'Epsilon College', host: 'eps.edu', baseball_team_id: 5 }] });
const g = (date, site, opponent, us, them, extra) => Object.assign({ date, site, opponent, opponent_host: null, status: us == null ? 'scheduled' : 'final', us, them, innings: null, time: '' }, extra || {});
/* alpha (home) and beta agree on 04-01; a doubleheader on 04-02 (beta lists by host); alpha vs gamma 04-03: they disagree;
   alpha at delta 04-04: only alpha read (delta's page not collected); gamma says cancelled on 04-05 */
put('schedules/baseball/2023/alpha.json', { school: 'alpha', games: [
  g('2023-04-01', 'H', 'Beta State', 5, 3), g('2023-04-02', 'H', 'Beta St.', 2, 1, { time: '12:00' }), g('2023-04-02', 'H', 'Beta St.', 0, 4, { time: '16:00' }),
  g('2023-04-03', 'A', 'Gamma', 6, 2), g('2023-04-04', 'A', 'Delta', 7, 7), g('2023-04-05', 'H', 'Gamma', null, null, { status: 'cancelled' }), g('2023-04-06', 'H', 'Nowhere Tech', 1, 0),
  g('2023-04-07', 'H', 'Eps U', 3, 2), g('2023-04-08', 'H', 'Twin', 1, 0)] });
put('schedules/baseball/2023/beta.json', { school: 'beta', games: [
  g('2023-04-01', 'A', 'Alpha', 3, 5), g('2023-04-02', 'A', null, 1, 2, { opponent_host: 'alpha.edu', opponent: 'Alpha', time: '12:00' }),
  g('2023-03-10', 'H', 'Eps U', 1, 1, { opponent_host: 'eps.edu' }), g('2023-03-11', 'H', 'Twin', 1, 1, { opponent_host: 'gamma.edu' }), g('2023-03-12', 'H', 'Twin', 1, 1, { opponent_host: 'delta.edu' }), g('2023-04-02', 'A', null, 4, 0, { opponent_host: 'alpha.edu', opponent: 'Alpha', time: '16:00' })] });
put('schedules/baseball/2023/gamma.json', { school: 'gamma', games: [g('2023-04-03', 'H', 'Alpha', 3, 6), g('2023-04-05', 'A', 'Alpha', null, null, { status: 'cancelled' })] });
const H = 'game_id,season,date,start_time_local,home_id,away_id,status,home_runs,away_runs,innings_played,sources,quality_notes';
const row = (id, date, h, a, st, hr, ar) => [id, 2023, date, '', h, a, st, hr, ar, '', 'season_file', ''].join(',');
const gamesFile = path.join(tmp, '2023.csv');
fs.writeFileSync(gamesFile, [H, row('g1', '2023-04-01', 1, 2, 'NO_RESULT', '', ''), row('g2_1', '2023-04-02', 1, 2, 'NO_RESULT', '', ''), row('g2_2', '2023-04-02', 1, 2, 'NO_RESULT', '', ''),
  row('g3', '2023-04-03', 3, 1, 'NO_RESULT', '', ''), row('g4', '2023-04-04', 4, 1, 'NO_RESULT', '', ''), row('g5', '2023-04-05', 1, 3, 'NO_RESULT', '', ''), row('g6', '2023-03-01', 1, 2, 'FINAL', 9, 1), row('g7', '2023-04-07', 1, 5, 'NO_RESULT', '', ''), row('g8', '2023-04-08', 1, 3, 'NO_RESULT', '', '')].join('\n') + '\n');
const teamSeasons = [{ season: 2023, team_id: 1, name: 'Alpha' }, { season: 2023, team_id: 2, name: 'Beta St.' }, { season: 2023, team_id: 3, name: 'Gamma' }, { season: 2023, team_id: 4, name: 'Delta' }, { season: 2023, team_id: 5, name: 'Epsilon' }];

const out = SR.run('fill', 2023, { collegiate: coll, gamesFile, teamSeasons, apply: true, reportsDir: path.join(tmp, 'reports') });
const by = Object.fromEntries(readCsv(gamesFile).rows.map((r) => [r.game_id, r]));
ok('both schools agreeing fill a contest, home and away as our record has them', by.g1.status === 'FINAL' && by.g1.home_runs === '5' && by.g1.away_runs === '3' && /school_sites/.test(by.g1.sources) && /SCHOOL_SITES_BOTH/.test(by.g1.quality_notes));
ok('a doubleheader pairs in the order the schools list it', by.g2_1.home_runs === '2' && by.g2_1.away_runs === '1' && by.g2_2.home_runs === '0' && by.g2_2.away_runs === '4');
ok('a name in another style ("Beta State") and an opponent website both join', by.g1.status === 'FINAL' && by.g2_1.status === 'FINAL');
ok('schools that disagree leave the contest without a result, both readings kept', by.g3.status === 'NO_RESULT' && out.disagreements.some((d) => d.game_id === 'g3' && d.schools.length === 2));
ok('one school\'s word fills a contest when the other was not read', by.g4.status === 'FINAL' && by.g4.home_runs === '7' && by.g4.away_runs === '7' && /SCHOOL_SITE_ONE/.test(by.g4.quality_notes));
ok('a contest the schools call cancelled stays without a result', by.g5.status === 'NO_RESULT' && out.counts.schools_say_cancelled === 1);
ok('a final we already hold is never touched; an opponent we cannot place is counted, not guessed', by.g6.home_runs === '9' && out.unmatched_opponents.some(([n]) => n === 'Nowhere Tech'));
ok('a name a school ties to a website elsewhere joins a page that lists no website', by.g7.status === 'FINAL' && by.g7.home_runs === '3');
ok('a name two schools tie to different teams is never used', by.g8.status === 'NO_RESULT' && out.unmatched_opponents.some(([n]) => n === 'Twin'));
ok('the report says what was filled and from whom', out.changed === 5 && out.filled.length === 5 && out.filled.find((f) => f.game_id === 'g1').from.length === 2);
const au = SR.run('audit', 2023, { collegiate: coll, gamesFile, teamSeasons, write: false });
ok('audit: a held final the schools read the same counts as agreement', au.counts.audit_agree >= 1 && au.agreement === 1, au.counts);

fs.rmSync(tmp, { recursive: true, force: true });
console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' school results — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
