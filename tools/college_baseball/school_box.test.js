#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Starters, lineups and weather from the schools' own box scores
   (college_baseball/ingest/school_box.js), on a real box score the probe read
   (Texas v Michigan State, 2026-02-21) joined to our own record: the contest
   is found by the NCAA codes, the starters are ours, and a box that matches
   no contest or disagrees with our score is left out.

   Run: node tools/college_baseball/school_box.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'collegiate/boxscores.js'));
const SB = require(path.join(ROOT, 'college_baseball/ingest/school_box.js'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } };

const x = B.parseBoxscore(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'collegiate/probe/fixtures/texassports.com/sports_baseball_stats_2026_michigan_state_boxscore_17827.gz'))).toString('utf8'));
const line = Object.assign({ game_key: '17827', school: 'texas', url: 'https://texassports.com/sports/baseball/stats/2026/michigan-state/boxscore/17827' }, B.compact(x));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbox-'));
const put = (rows) => { fs.mkdirSync(path.join(dir, '2026'), { recursive: true }); fs.writeFileSync(path.join(dir, '2026', 'texas.jsonl.gz'), zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')); };

/* the same game held twice (both schools' sites), a box of a game we do not hold, and one whose score is not ours */
const ghost = JSON.parse(JSON.stringify(line)); ghost.date = '2026-01-01';
const wrong = JSON.parse(JSON.stringify(line)); wrong.date = '2026-02-22'; wrong.home.code = '703'; wrong.away.code = '416'; wrong.home.runs = 99;
put([line, line, ghost, wrong]);
const b = SB.build(2026, { boxDir: dir, write: false });
const H = b.rows.find((r) => r.side === 'H'); const A = b.rows.find((r) => r.side === 'A');
ok('a box joins our contest by date and NCAA codes, once however many sites hold it', b.counts.joined === 1 && b.rows.length === 2 && H.game_id === A.game_id && /^ncaa_/.test(H.game_id), b.counts);
ok('each side: its starter with hand and line, and the opposing nine\'s bats', H.team_id === '703' && H.starter === 'Luke Harrison' && H.starter_throws === 'L' && H.starter_outs === 13 && H.opp_lineup_bats === 'RLRRRRRRL' && H.opp_lefty_bats === 2 && A.starter === 'Carter Monke' && A.opp_lefty_bats === 4);
ok('weather and attendance ride along', H.temp_f === 69 && H.wind_mph === 24 && H.attendance === 7397);
ok('a box with no contest of ours, or another score, is left out and counted', b.counts.no_contest === 1 && b.counts.score_differs === 1);
const au = SB.audit(2026, { boxDir: dir });
ok('audit: the schools\' starters are our record\'s, with the same outs', au.compared === 2 && au.starter_agreement === 1 && au.outs_agreement === 1, au);

/* an older SIDEARM site's box (Dayton at Lipscomb, 2026-02-13): the teams by the schedule's join, the hands by the roster slug */
{
  const lx = B.legacyCodes(B.parseBoxscore(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'collegiate/probe/fixtures/daytonflyers.com/sports_baseball_stats_2026_lipscomb_boxscore_17441.gz'))).toString('utf8')),
    { school: 'dayton', opponent: 'lipscomb', site: 'A', conference: false, dh_n: 0 }, new Map([['dayton', { baseball_team_id: '175' }], ['lipscomb', { baseball_team_id: '28600' }]]));
  const row = Object.assign({ game_key: '17441', school: 'dayton', url: 'https://daytonflyers.com/sports/baseball/stats/2026/lipscomb/boxscore/17441' }, B.compact(lx));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'schoolbox-legacy-'));
  fs.mkdirSync(path.join(d2, 'box', '2026'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'box', '2026', 'dayton.jsonl.gz'), zlib.gzipSync(JSON.stringify(row) + '\n'));
  fs.mkdirSync(path.join(d2, 'rosters', '2026'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'rosters', '2026', 'dayton.json'), JSON.stringify({ players: [{ pid: 'slug:sawyer-jensen', name: 'Sawyer Jensen', throws: 'R', bats: 'R' }, { pid: 'slug:jason-bello', name: 'Jason Bello', bats: 'L', throws: 'R' }] }));
  const lb = SB.build(2026, { boxDir: path.join(d2, 'box'), rostersDir: path.join(d2, 'rosters'), write: false });
  const DA = lb.rows.find((r) => r.team_id === '175'); const LH = lb.rows.find((r) => r.team_id === '28600');
  ok('older SIDEARM: the box joins our contest by the codes the schedule gave it, and the score is ours', lb.counts.joined === 1 && DA && DA.game_id === 'ncaa_6503550' && DA.side === 'A' && LH.side === 'H', lb.counts);
  ok('older SIDEARM: the school\'s starter takes his hand from the school\'s roster by slug; the opponent\'s none', DA.starter === 'Sawyer Jensen' && DA.starter_throws === 'R' && DA.starter_outs === 13 && DA.starter_bf === 22 && LH.starter === 'Alexander Llinas' && LH.starter_throws === '');
  ok('older SIDEARM: the school\'s nine take their bats from the roster where it lists them, the rest unknown ("?")', LH.opp_lineup_bats === 'L????????' && LH.opp_lefty_bats === 1 && DA.opp_lineup_bats === '?????????');
  const au2 = SB.audit(2026, { boxDir: path.join(d2, 'box'), rostersDir: path.join(d2, 'rosters') });
  ok('older SIDEARM audit: both starters are our record\'s, with the same outs', au2.compared === 2 && au2.starter_agreement === 1 && au2.outs_agreement === 1, au2);
  fs.rmSync(d2, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' school box scores — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
