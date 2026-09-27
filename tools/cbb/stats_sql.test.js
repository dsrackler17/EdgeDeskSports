#!/usr/bin/env node
/* ===========================================================================
   THE STATS GATE AND THE FOLD, against a real PostgreSQL.

   The schema's own report checks that each refusal EXISTS. This checks that
   each one FIRES, and — more importantly — that the fold produces the numbers
   a person would get with a pencil.

   That last part carries the weight here, because a season archive folded out
   of box scores has NO SECOND SOURCE to disagree with. If the fold is wrong,
   nothing anywhere notices. So every expected figure below is computed by hand
   from lines this test writes, in the comment next to it.

   Run: node tools/cbb/stats_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../mlb/pg_client.js');
const S = require('./stage.js');
const SS = require('./stage_stats.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_cbb_stats_test';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, g === w, { got: g, want: w });
/* floating point: a rate is right if it rounds the same way a person would read it */
const near = (n, g, w, p) => ok(n, g !== null && g !== undefined && Math.abs(Number(g) - w) < (p || 1e-6), { got: g, want: w });

const conn = PG.findServer();
if (!conn) { console.log('SKIP | cbb stats sql | no reachable PostgreSQL server'); process.exit(0); }
if (!PG.createDatabase(conn, DB)) { console.log('SKIP | cbb stats sql | could not create the test database'); process.exit(0); }
const db = PG.pgClient(conn, { database: DB });
let code = 0;
try { db.sql('create role anon nologin; create role authenticated nologin;'); } catch (_) {}

function game(o) {
  return Object.assign({
    game_id: null, season: 2026, game_date: '2026-04-18', start_time: '2026-04-18T20:00Z',
    start_time_tbd: false, away_team_id: '2', home_team_id: '1',
    away_name: 'Away', home_name: 'Home', away_abbr: null, home_abbr: null,
    venue: null, venue_city: null, venue_state: null,
    neutral_site: false, conference_game: false,
    status_state: 'post', status_detail: 'Final', completed: true,
    away_score: 1, home_score: 2, innings: 9, away_rank: null, home_rank: null,
    notes: null, seen_by: ['scoreboard'],
  }, o);
}
function team(id, name) {
  return { team_id: id, name, short_name: name, abbreviation: name.slice(0, 3).toUpperCase(),
    slug: null, conference_id: null, conference_name: null, logo: null, color: null,
    first_seen_season: 2026, last_seen_season: 2026 };
}
/* a batting line with everything unset unless stated */
function bat(o) {
  return Object.assign({
    game_id: 'g1', athlete_id: 'a1', line_type: 'batting', season: 2026,
    game_date: '2026-04-18', team_id: '1', team_name: 'Home', opponent_team_id: '2',
    athlete_name: 'A Hitter', position: 'SS', jersey: null, starter: true,
    ab: 0, runs: 0, hits: 0, rbi: 0, hr: 0, bb: 0, so: 0, pitches_seen: 0, stolen_bases: 0,
    outs: null, p_hits: null, p_runs: null, earned_runs: null, p_bb: null, p_so: null,
    p_hr: null, pitch_count: null, strikes: null,
    season_avg_at_game: null, season_obp_at_game: null, season_slg_at_game: null,
    season_era_at_game: null, source: 'espn_summary',
  }, o);
}
function pitch(o) {
  return Object.assign(bat({}), {
    line_type: 'pitching', athlete_name: 'A Pitcher', position: 'P',
    ab: null, runs: null, hits: null, rbi: null, hr: null, bb: null, so: null,
    pitches_seen: null, stolen_bases: null,
    outs: 0, p_hits: 0, p_runs: 0, earned_runs: 0, p_bb: 0, p_so: 0, p_hr: 0,
    pitch_count: 0, strikes: 0,
  }, o);
}

async function main() {
  console.log('the schema');
  const r = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
  ok('the schema with the stats half applies', r.ok !== false, r && r.error);

  /* the game log first: the stats gate refuses lines for games it has never
     heard of, which is only testable if some games exist */
  await S.stageAndPromote(db, 'g-imp', {
    season: 2026, from: '2026-04-01', through: '2026-04-30', log: () => {},
    teams: [team('1', 'Home'), team('2', 'Away')],
    games: [
      game({ game_id: 'g1', game_date: '2026-04-18', home_score: 5, away_score: 3 }),
      game({ game_id: 'g2', game_date: '2026-04-19', home_score: 2, away_score: 7 }),
      game({ game_id: 'g3', game_date: '2026-04-20', home_score: 4, away_score: 1 }),
    ],
  });
  eq('three games are in the log', Number(db.rows('select count(*) n from cbb.games')[0].n), 3);

  console.log('the fold, checked against a pencil');
  /* ONE HITTER, TWO GAMES.
       g1: 4 AB, 2 H, 1 HR, 1 BB, 1 SO, 1 SB, season avg reported .250
       g2: 3 AB, 1 H, 0 HR, 0 BB, 2 SO, 0 SB, season avg reported .300
     By hand: AB 7, H 3, HR 1, BB 1, SO 3, SB 1, average 3/7 = .428571…
     The reported .300 is his SEASON figure after g2 and must NOT be averaged
     with .250 into .275 — that number would mean nothing at all. */
  const lines = [
    bat({ game_id: 'g1', athlete_id: 'h1', ab: 4, hits: 2, hr: 1, bb: 1, so: 1,
          runs: 2, rbi: 3, stolen_bases: 1, pitches_seen: 18,
          season_avg_at_game: 0.250, season_obp_at_game: 0.400, season_slg_at_game: 0.500 }),
    bat({ game_id: 'g2', athlete_id: 'h1', game_date: '2026-04-19', ab: 3, hits: 1, so: 2,
          runs: 1, rbi: 0, pitches_seen: 12,
          season_avg_at_game: 0.300, season_obp_at_game: 0.380, season_slg_at_game: 0.470 }),
    /* ONE PITCHER, TWO GAMES, BOTH PARTIAL INNINGS.
         g1: 6.2 = 20 outs, 5 H, 2 ER, 1 BB, 7 K
         g3: 6.2 = 20 outs, 4 H, 1 ER, 2 BB, 5 K
       By hand: 40 outs = 13.1 innings. ERA = 3 * 27 / 40 = 2.025.
       A decimal reading would give 6.2 + 6.2 = 12.4 innings and an ERA of
       3 * 9 / 12.4 = 2.177, which is the bug this asserts against.
       WHIP = (9 hits + 3 walks) * 3 / 40 = 0.9. K/9 = 12 * 27 / 40 = 8.1. */
    pitch({ game_id: 'g1', athlete_id: 'p1', outs: 20, p_hits: 5, p_runs: 3, earned_runs: 2,
            p_bb: 1, p_so: 7, pitch_count: 95, strikes: 60, season_era_at_game: 3.10 }),
    pitch({ game_id: 'g3', athlete_id: 'p1', game_date: '2026-04-20', outs: 20, p_hits: 4,
            p_runs: 1, earned_runs: 1, p_bb: 2, p_so: 5, pitch_count: 88, strikes: 55,
            season_era_at_game: 2.03 }),
    /* a hitter with no at-bats at all: a pinch runner. He has NO average. */
    bat({ game_id: 'g1', athlete_id: 'h2', athlete_name: 'A Runner', ab: 0, hits: 0,
          runs: 1, stolen_bases: 1 }),
  ];
  let v = await SS.stageAndPromoteStats(db, 's-imp-1', { season: 2026, lines, log: () => {} });
  ok('the stats import is accepted', v && v.ok === true, v);
  eq('every line is live', Number(db.rows('select count(*) n from cbb.player_games')[0].n), 5);

  const h1 = db.rows("select * from cbb.player_seasons where athlete_id='h1'")[0];
  eq('games batting', Number(h1.games_batting), 2);
  eq('at-bats add up', Number(h1.ab), 7);
  eq('hits add up', Number(h1.hits), 3);
  eq('home runs add up', Number(h1.hr), 1);
  eq('walks add up', Number(h1.bb), 1);
  eq('strikeouts add up', Number(h1.so), 3);
  eq('stolen bases add up', Number(h1.stolen_bases), 1);
  near('the average is hits over at-bats, 3/7', h1.batting_avg, 3 / 7, 1e-9);
  /* the whole point of TRAP 1 */
  near('OBP is the source\'s LAST reported figure, not an average of them',
    h1.obp_reported, 0.380, 1e-9);
  ok('…and it is not the mean of .400 and .380',
    Math.abs(Number(h1.obp_reported) - 0.390) > 1e-6, h1.obp_reported);
  near('SLG likewise comes from the last game', h1.slg_reported, 0.470, 1e-9);
  eq('the archive says which day those rates are as of', String(h1.rates_as_of).slice(0, 10), '2026-04-19');
  ok('a hitter has no ERA', h1.era === null, h1.era);

  const p1 = db.rows("select * from cbb.player_seasons where athlete_id='p1'")[0];
  eq('outs add up, and 20 + 20 is 40', Number(p1.outs), 40);
  /* THE ASSERTION THAT CATCHES THE DECIMAL BUG */
  near('ERA is 3 earned runs over 40 outs = 2.025', p1.era, 2.025, 1e-9);
  ok('…and NOT the 2.177 a decimal innings reading would give',
    Math.abs(Number(p1.era) - 2.177) > 0.01, p1.era);
  near('WHIP is (9 + 3) * 3 / 40 = 0.900', p1.whip, 0.9, 1e-9);
  near('K/9 is 12 * 27 / 40 = 8.1', p1.k_per_9, 8.1, 1e-9);
  near('BB/9 is 3 * 27 / 40 = 2.025', p1.bb_per_9, 2.025, 1e-9);
  near('the reported ERA is carried separately', p1.era_reported, 2.03, 1e-9);
  eq('games pitching', Number(p1.games_pitching), 2);

  const h2 = db.rows("select * from cbb.player_seasons where athlete_id='h2'")[0];
  ok('a hitter with no at-bats has NO average, not .000', h2.batting_avg === null, h2.batting_avg);
  eq('…but his stolen base is still counted', Number(h2.stolen_bases), 1);

  console.log('the club line, and the gap it admits to');
  const t1 = db.rows("select * from cbb.team_stat_seasons where team_id='1'")[0];
  /* Home batted in g1 and g2, pitched in g1 and g3 → 3 distinct games with
     lines. The log says Home played 3 games. So coverage is 3/3 = 1.0.
     Club AB = 4 + 3 + 0 = 7, H = 3. */
  eq('games with lines', Number(t1.games_with_lines), 3);
  eq('games played comes from the game log', Number(t1.games_played), 3);
  near('coverage is the ratio of the two', t1.line_coverage, 1.0, 1e-9);
  eq('club at-bats', Number(t1.ab), 7);
  eq('club hits', Number(t1.hits), 3);
  near('club average', t1.batting_avg, 3 / 7, 1e-9);
  near('club ERA over 40 outs', t1.era, 2.025, 1e-9);
  eq('batters used counts distinct hitters', Number(t1.batters_used), 2);
  eq('pitchers used counts distinct pitchers', Number(t1.pitchers_used), 1);

  console.log('the coverage view');
  const cov = db.rows('select * from cbb.stats_coverage where season=2026')[0];
  eq('completed games', Number(cov.completed_games), 3);
  eq('games with lines', Number(cov.games_with_lines), 3);
  near('coverage', cov.coverage, 1.0, 1e-9);

  console.log('the refusals');
  const refuse = async (name, o) => {
    const before = Number(db.rows('select count(*) n from cbb.player_games')[0].n);
    const res = await SS.stageAndPromoteStats(db, 's-' + name, Object.assign({ season: 2026, log: () => {} }, o));
    const after = Number(db.rows('select count(*) n from cbb.player_games')[0].n);
    ok(name + ' is refused', res && res.ok !== true, res);
    eq('…and the archive is untouched', after, before);
    return res;
  };
  process.exitCode = 0;   /* the stager sets a failure code on a refusal; that is expected here */

  let res = await refuse('EMPTY_IMPORT', { lines: [] });
  eq('…by name', res.refusals[0].refusal, 'EMPTY_IMPORT');
  process.exitCode = 0;

  res = await refuse('DUPLICATE_LINES', { lines: [
    bat({ game_id: 'g1', athlete_id: 'dup' }), bat({ game_id: 'g1', athlete_id: 'dup' })] });
  eq('…by name', res.refusals[0].refusal, 'DUPLICATE_LINES');
  process.exitCode = 0;

  res = await refuse('ORPHAN_GAME', { lines: [bat({ game_id: 'not-a-game', athlete_id: 'x' })] });
  eq('…by name', res.refusals[0].refusal, 'ORPHAN_GAME');
  process.exitCode = 0;

  /* the labelled-array failure mode: an off-by-one in the column mapping */
  res = await refuse('HITS_EXCEED_AB', { lines: [bat({ athlete_id: 'x', ab: 3, hits: 4 })] });
  ok('…by name', res.refusals.some((x) => x.refusal === 'HITS_EXCEED_AB'), res.refusals);
  process.exitCode = 0;

  res = await refuse('SEASON_MISMATCH', { lines: [
    bat({ athlete_id: 'x', season: 2025, game_date: '2026-04-18' })] });
  ok('…by name', res.refusals.some((x) => x.refusal === 'SEASON_MISMATCH'), res.refusals);
  process.exitCode = 0;

  /* THE SHRINK REFUSAL, judged against the season the import MEANT to cover.
     Five lines are live. One line is a 80% loss and must be refused. */
  res = await refuse('IMPORT_SHRANK', { lines: [bat({ athlete_id: 'h1' })] });
  ok('…by name', res.refusals.some((x) => x.refusal === 'IMPORT_SHRANK'), res.refusals);
  process.exitCode = 0;

  const before = Number(db.rows('select count(*) n from cbb.player_games')[0].n);
  const forced = await SS.stageAndPromoteStats(db, 's-forced', {
    season: 2026, allowShrink: true, log: () => {},
    lines: [bat({ athlete_id: 'h1' })] });
  ok('…unless a human says in as many words that the loss is real', forced.ok === true, forced);
  eq('…and only then does the archive shrink',
    Number(db.rows('select count(*) n from cbb.player_games')[0].n), 1);
  ok('…which is fewer than it was', 1 < before, before);
  process.exitCode = 0;

  console.log('access');
  const denied = (sql) => {
    try { db.sql(`set role anon; ${sql}; reset role;`); db.sql('reset role'); return false; }
    catch (_) { try { db.sql('reset role'); } catch (__) {} return true; }
  };
  ok('anon may read the player archive', !denied('select 1 from cbb.player_seasons limit 1'));
  ok('anon may read the club lines', !denied('select 1 from cbb.team_stat_seasons limit 1'));
  ok('anon may NOT read stats staging', denied('select 1 from cbb.stg_player_games limit 1'));
  ok('anon may NOT write a player line',
    denied("insert into cbb.player_games (game_id,athlete_id,line_type,season,game_date,team_name,athlete_name) values ('g1','z','batting',2026,'2026-04-18','x','y')"));
  ok('anon may NOT promote a stats import', denied("select cbb.promote_cbb_stats('x')"));
  ok('anon may NOT rebuild the archive', denied('select cbb.rebuild_player_seasons(2026)'));
}

main().then(() => {
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
  console.log(fail ? `FAIL | cbb stats sql | ${fail} failed`
    : `PASS | cbb stats gate and fold | ${pass} assertions against a real PostgreSQL`);
  try { PG.dropDatabase(conn, DB); } catch (_) {}
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL | cbb stats sql | ' + ((e && e.stack) || e));
  try { PG.dropDatabase(conn, DB); } catch (_) {}
  process.exit(1);
});
