#!/usr/bin/env node
/* ===========================================================================
   THE QUERY LAYER, against a real PostgreSQL carrying a real import.

   Not a mock. The schema is applied, games are staged and promoted through
   the real gate, and then the layer is asked the questions the board and the
   brief will ask — with every answer checked back against SQL.

   The three it exists to hold:
     a club with no completed games has NO runs per game, not 0.00
     a finished game with no score is abandoned, not a nil-nil draw
     out of season is a fact the board states, not an empty list
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../mlb/pg_client.js');
const S = require('./stage.js');
const L = require('../../lib/college_baseball.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_cbb_layer';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, g === w, { got: g, want: w });

const conn = PG.findServer();
if (!conn) { console.log('SKIP | cbb query layer | no reachable PostgreSQL server'); process.exit(0); }
if (!PG.createDatabase(conn, DB)) { console.log('SKIP | cbb query layer | could not create the test database'); process.exit(0); }
const db = PG.pgClient(conn, { database: DB });
try { db.sql('create role anon nologin; create role authenticated nologin;'); } catch (_) {}

const game = (o) => Object.assign({
  game_id: null, season: 2026, game_date: '2026-04-18', start_time: '2026-04-18T20:00Z',
  start_time_tbd: false, away_team_id: null, home_team_id: null,
  away_name: 'Away', home_name: 'Home', away_abbr: null, home_abbr: null,
  venue: null, venue_city: null, venue_state: null, neutral_site: false, conference_game: false,
  status_state: 'post', status_detail: 'Final', completed: true,
  away_score: 1, home_score: 2, innings: 9, away_rank: null, home_rank: null,
  notes: null, seen_by: ['scoreboard'],
}, o);

(async function main() {
  try {
    const r = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
    if (!r.ok) { console.log('FAIL | schema did not apply'); throw new Error('apply'); }

    const teams = [
      { team_id: '1', name: 'Alpha Aces', short_name: 'Alpha', abbreviation: 'ALP', slug: 'alpha',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null,
        first_seen_season: 2026, last_seen_season: 2026 },
      { team_id: '2', name: 'Beta Bears', short_name: 'Beta', abbreviation: 'BET', slug: 'beta',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null,
        first_seen_season: 2026, last_seen_season: 2026 },
      { team_id: '3', name: 'Gamma Gulls', short_name: 'Gamma', abbreviation: 'GAM', slug: 'gamma',
        conference_id: null, conference_name: 'Other', logo: null, color: null,
        first_seen_season: 2026, last_seen_season: 2026 },
    ];
    const games = [
      game({ game_id: 'g1', game_date: '2026-04-01', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha Aces', away_name: 'Beta Bears', home_score: 5, away_score: 1,
             conference_game: true, venue: 'Alpha Field', away_rank: 8 }),
      game({ game_id: 'g2', game_date: '2026-04-02', home_team_id: '2', away_team_id: '1',
             home_name: 'Beta Bears', away_name: 'Alpha Aces', home_score: 3, away_score: 2, conference_game: true }),
      game({ game_id: 'g3', game_date: '2026-04-18', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha Aces', away_name: 'Beta Bears', home_score: 7, away_score: 0,
             neutral_site: true, seen_by: ['scoreboard', 'team_schedule'] }),
      /* scheduled — no score, not a result */
      game({ game_id: 'g4', game_date: '2026-04-18', home_team_id: '1', away_team_id: '3',
             home_name: 'Alpha Aces', away_name: 'Gamma Gulls', home_score: null, away_score: null,
             completed: false, status_state: 'pre', status_detail: 'Scheduled',
             start_time: null, start_time_tbd: true, seen_by: ['team_schedule'] }),
      /* rained off — finished with no score, which is abandoned, not 0-0 */
      game({ game_id: 'g5', game_date: '2026-04-18', home_team_id: '3', away_team_id: '2',
             home_name: 'Gamma Gulls', away_name: 'Beta Bears', home_score: null, away_score: null,
             completed: true, status_detail: 'Postponed' }),
    ];
    const v = await S.stageAndPromote(db, 'q-1', { season: 2026, from: '2026-04-01', through: '2026-04-30', games, teams, log: () => {} });
    ok('the fixture promoted through the real gate', v && v.ok === true, v);

    /* the layer reads through PostgREST-shaped queries, same as the browser */
    const svc = L.createService({ read: (rel, q) => Promise.resolve(db.select(L.COLS ? 'cbb' : 'cbb', rel, q)) });

    console.log('status');
    const st = await svc.status(true);
    ok('the archive reports itself installed and promoted', st.ok === true, st);
    eq('…counting every game', st.counts.games, 5);
    eq('…and the clubs', st.counts.teams, 3);

    console.log('the board');
    const b = await svc.board({ from: '2026-04-18', through: '2026-04-18' });
    ok('a board comes back', b.ok === true, b);
    eq('…with every game that day', b.games.length, 3);
    eq('…counting the finished one', b.counts.final, 1);
    eq('…the scheduled one', b.counts.scheduled, 1);
    /* THE ABANDONED GAME IS NOT A 0-0 RESULT. It is marked complete with no
       score, and a board that drew it as a draw would be inventing one. */
    eq('…and the rained-off one as abandoned', b.counts.abandoned, 1);
    const g5 = b.games.find((x) => x.game_id === 'g5');
    eq('the abandoned game has no winner', g5.winner, null);
    ok('…and says it was abandoned', g5.abandoned === true);
    const g4 = b.games.find((x) => x.game_id === 'g4');
    ok('a game with no settled first pitch says so', g4.start_time_tbd === true);
    eq('…and carries no invented time', g4.start_time, null);
    const g3 = b.games.find((x) => x.game_id === 'g3');
    eq('a game both sources saw records both', g3.seen_by.join(','), 'scoreboard,team_schedule');
    eq('in-season is reported for an April window', b.in_season, true);

    /* OUT OF SEASON IS A FACT, NOT AN OUTAGE. College baseball does not play
       in September, and a board that returned an empty list with no
       explanation would read exactly like a broken pipeline. */
    const off = await svc.board({ from: '2026-09-18', through: '2026-09-18' });
    ok('an out-of-season window still answers', off.ok === true);
    eq('…with no games', off.games.length, 0);
    eq('…and says it is out of season', off.in_season, false);

    console.log('the derived record, read back through the layer');
    const a = await svc.teamSeason('1', 2026);
    ok('a club season comes back', a.ok === true, a);
    eq('…with the record the games imply', L.recordOf(a.team), '2-1');
    eq('…home wins exclude the neutral-site game', a.team.home.wins, 1);
    eq('…which is counted as neutral', a.team.neutral.wins, 1);
    eq('…conference record counts only conference games', a.team.conference.wins, 1);
    ok('…runs per game is real', Math.abs(a.team.runs_per_game - 14 / 3) < 1e-9, a.team.runs_per_game);
    /* checked back against SQL rather than against my own arithmetic twice */
    const sqlA = db.rows("select runs_for, runs_against, wins, losses from cbb.team_seasons where team_id='1'")[0];
    eq('…and matches what the database holds for runs scored', a.team.runs_for, Number(sqlA.runs_for));
    eq('…and runs allowed', a.team.runs_against, Number(sqlA.runs_against));

    /* A CLUB WITH NO COMPLETED GAMES HAS NO RATE, NOT A ZERO ONE. Gamma's
       only two games are a scheduled one and a postponement. */
    const gm = await svc.teamSeason('3', 2026);
    ok('a club with no completed games has no season row', gm.ok === false, gm);
    eq('…and says why rather than returning zeros', gm.code, 'NO_SEASON_ROW');
    const shaped = L.shapeTeamSeason({ season: 2026, team_id: '3', team_name: 'Gamma Gulls',
      games: 0, wins: 0, losses: 0, runs_per_game: 0, runs_allowed_per_game: 0 });
    eq('…and a zero-game row still refuses to claim a rate', shaped.runs_per_game, null);
    eq('…on both sides', shaped.runs_allowed_per_game, null);

    console.log('head to head and form, from the same game log');
    const h = await svc.headToHead('1', '2');
    ok('prior meetings come back', h.ok === true, h);
    eq('…counting only completed, unabandoned games', h.meetings, 3);
    eq('…with the wins on the right side', h.a_wins, 2);
    eq('…and the other', h.b_wins, 1);
    const f = await svc.form('1', 2026, 10);
    ok('recent form comes back', f.ok === true);
    eq('…most recent first', f.results[0].date, '2026-04-18');
    eq('…with the result from that club\'s point of view', f.results[0].result, 'W');
    eq('…and what it scored', f.results[0].scored, 7);
    eq('…and allowed', f.results[0].allowed, 0);
    eq('…and the record over the window', f.wins + '-' + f.losses, '2-1');

    console.log('refusals');
    const nb = await svc.board({});
    eq('a board with no window is refused', nb.code, 'NO_WINDOW');
    const ng = await svc.game('nope');
    eq('an unknown game is refused by name', ng.code, 'NOT_FOUND');
  } catch (e) {
    console.log('FAIL | cbb query layer | ' + (e && e.stack || e)); fail++;
  } finally {
    try { db.close(); } catch (_) {}
    PG.dropDatabase(conn, DB);
  }
  console.log(fail === 0 ? `ALL GREEN ${pass} passed, 0 failed` : `FAILED ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log(`PASS | cbb query layer | ${pass} assertions against a real PostgreSQL`);
  process.exit(fail === 0 ? 0 : 1);
})();
