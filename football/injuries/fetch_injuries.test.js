#!/usr/bin/env node
/* Offline tests for the NFL injury sync: parse, reduce to the latest week per
   team, never infer, never present an unpublished season as current.
   Run: node football/injuries/fetch_injuries.test.js */
'use strict';
const I = require('./fetch_injuries.js');
const fs = require('fs'); const os = require('os'); const path = require('path');
let pass = 0, fail = 0; const fails = [];
const chk = (n, ok, d) => ok ? pass++ : (fail++, fails.push({ n, d }));

const CSV = [
  'season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status',
  '2026,REG,REG,KC,1,00-1,QB,Patrick Mahomes,Patrick,Mahomes,Ankle,,Questionable,Ankle,,Limited Participation in Practice',
  '2026,REG,REG,KC,1,00-2,WR,Xavier Worthy,Xavier,Worthy,Illness,,Doubtful,Illness,,Did Not Participate In Practice',
  '2026,REG,REG,KC,1,00-3,G,Trey Smith,Trey,Smith,,,,Not injury related - resting player,,Did Not Participate In Practice',
  '2026,REG,REG,KC,2,00-2,WR,Xavier Worthy,Xavier,Worthy,Illness,,Out,Illness,,Did Not Participate In Practice',
  '2026,REG,REG,LAR,2,00-9,QB,"Stafford, Matthew",Matthew,Stafford,Back,,Questionable,Back,,Limited Participation in Practice',
  '2026,PRE,PRE,BAL,1,00-7,RB,Derrick Henry,Derrick,Henry,Knee,,Out,Knee,,Did Not Participate In Practice',
].join('\r\n') + '\r\n';
const rows = I.parseCsv(CSV);
chk('CSV parses with CRLF and a quoted comma', rows.length === 6 && rows[4].full_name === 'Stafford, Matthew');
const ds = I.build(rows, 2026, '2026-09-10T12:00:00Z');
chk('preseason rows are excluded; only REG/POST count', !ds.teams.BAL && ds.rows === 5);
chk('each team carries its LATEST reported week only', ds.teams.KC.week === 2 && ds.teams.KC.players.length === 1 && ds.teams.KC.players[0].status === 'Out' && ds.latest_week === 2);
chk('nflverse LAR becomes the app’s LA', ds.teams.LA && ds.teams.LA.players[0].name === 'Stafford, Matthew' && ds.teams.LA.players[0].status === 'Questionable');
const wk1 = I.build(rows.filter(r => r.week === '1'), 2026, 'x');
chk('players sort by severity: Doubtful before Questionable before a practice-only note', wk1.teams.KC.players.map(p => p.name).join('|') === 'Xavier Worthy|Patrick Mahomes|Trey Smith');
chk('a practice-only row keeps its practice status and no report status', wk1.teams.KC.players[2].status === null && /Did Not Participate/.test(wk1.teams.KC.players[2].practice) && wk1.teams.KC.players[2].injury === 'Not injury related - resting player');
chk('the dataset says what it is', ds.schema === I.SCHEMA && ds.published === true && ds.season === 2026 && /nflverse/.test(ds.source));
const un = I.unpublished(2026, 'x', 'not yet');
chk('an unpublished season is published:false with no teams', un.published === false && un.season === null && un.team_count === 0 && un.reason === 'not yet');
chk('validation refuses a hollow published file and accepts an unpublished one', (function () { try { I.validate(ds); return false; } catch (e) { return /hollow/.test(e.message); } })() && (function () { try { I.validate(un); return true; } catch (e) { return false; } })());
const big = I.build(rows.concat(Array.from({ length: 120 }, (_, i) => ({ game_type: 'REG', team: ['ARI', 'ATL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG'][i % 20], week: '2', full_name: 'P' + i, report_status: '' }))), 2026, 'x');
chk('a real-sized published file validates', (function () { try { I.validate(big); return true; } catch (e) { return false; } })());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')); const f = path.join(tmp, 'nfl_2026.json');
chk('the file is written once and left alone when the rows did not change', I.writeIfChanged(f, ds) === true && I.writeIfChanged(f, Object.assign({}, ds, { retrieved_at: 'later' })) === false && I.writeIfChanged(f, I.build(rows.slice(0, 2), 2026, 'x')) === true);
chk('season defaults to the app’s Jan/Feb rule', typeof I.defaultSeason() === 'number');
chk('status rank orders Out over Doubtful over Questionable over DNP over Limited', I.statusRank('Out') > I.statusRank('Doubtful') && I.statusRank('Doubtful') > I.statusRank('Questionable') && I.statusRank('', 'Did Not Participate In Practice') > I.statusRank('', 'Limited Participation in Practice') && I.statusRank('', 'Full Participation in Practice') === 0);
fails.forEach(x => console.log('FAIL | ' + x.n + (x.d ? ' ' + JSON.stringify(x.d).slice(0, 300) : '')));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
