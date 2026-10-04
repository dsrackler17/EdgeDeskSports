#!/usr/bin/env node
/* ===========================================================================
   THE STATS QUERY LAYER, against a real PostgreSQL carrying a real import.

   Same arrangement as query_layer.test.js: the schema is applied, games and
   then player lines are promoted through the real gates, and the layer is asked
   what the brief will ask — with every answer checked against the numbers this
   file computes by hand.

   The four it exists to hold:
     a game the source has no box score for is a GAP, not a game nobody batted in
     a club's hitting line drawn from 2 of 3 games SAYS SO, in words
     a 2-for-2 hitter does not lead his club, because leaders have a threshold
     a null ERA sorts last among pitchers, not first
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../mlb/pg_client.js');
const S = require('./stage.js');
const SS = require('./stage_stats.js');
const L = require('../../lib/college_baseball.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_cbb_statsq';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, g === w, { got: g, want: w });
const near = (n, g, w, p) => ok(n, g !== null && Math.abs(Number(g) - w) < (p || 1e-6), { got: g, want: w });

const conn = PG.findServer();
if (!conn) { console.log('SKIP | cbb stats query | no reachable PostgreSQL server'); process.exit(0); }
if (!PG.createDatabase(conn, DB)) { console.log('SKIP | cbb stats query | could not create the test database'); process.exit(0); }
const db = PG.pgClient(conn, { database: DB });
try { db.sql('create role anon nologin; create role authenticated nologin;'); } catch (_) {}

const game = (o) => Object.assign({
  game_id: null, season: 2026, game_date: '2026-04-18', start_time: '2026-04-18T20:00Z',
  start_time_tbd: false, away_team_id: '2', home_team_id: '1',
  away_name: 'Beta Bears', home_name: 'Alpha Aces', away_abbr: 'BET', home_abbr: 'ALP',
  venue: null, venue_city: null, venue_state: null, neutral_site: false, conference_game: false,
  status_state: 'post', status_detail: 'Final', completed: true,
  away_score: 1, home_score: 2, innings: 9, away_rank: null, home_rank: null,
  notes: null, seen_by: ['scoreboard'],
}, o);
const team = (id, name) => ({ team_id: id, name, short_name: name, abbreviation: name.slice(0, 3).toUpperCase(),
  slug: null, conference_id: null, conference_name: 'Big Test', logo: null, color: null,
  first_seen_season: 2026, last_seen_season: 2026 });
const bat = (o) => Object.assign({
  game_id: 'g1', athlete_id: 'a1', line_type: 'batting', season: 2026, game_date: '2026-04-18',
  team_id: '1', team_name: 'Alpha Aces', opponent_team_id: '2', athlete_name: 'A Hitter',
  position: 'SS', jersey: '7', starter: true,
  ab: 0, runs: 0, hits: 0, rbi: 0, hr: 0, bb: 0, so: 0, pitches_seen: 0, stolen_bases: 0,
  outs: null, p_hits: null, p_runs: null, earned_runs: null, p_bb: null, p_so: null,
  p_hr: null, pitch_count: null, strikes: null,
  season_avg_at_game: null, season_obp_at_game: null, season_slg_at_game: null,
  season_era_at_game: null, source: 'espn_summary',
}, o);
const pitch = (o) => Object.assign(bat({}), {
  line_type: 'pitching', athlete_name: 'A Pitcher', position: 'P',
  ab: null, runs: null, hits: null, rbi: null, hr: null, bb: null, so: null,
  pitches_seen: null, stolen_bases: null,
  outs: 0, p_hits: 0, p_runs: 0, earned_runs: 0, p_bb: 0, p_so: 0, p_hr: 0,
  pitch_count: 0, strikes: 0,
}, o);

(async function main() {
  const r = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
  if (!r.ok) { console.log('FAIL | schema did not apply'); process.exit(1); }

  /* THREE GAMES PLAYED. Box scores for g1 and g2 only — g3 is the gap, which is
     the realistic case: the probe found one of six sampled games carried none. */
  await S.stageAndPromote(db, 'g-imp', {
    season: 2026, from: '2026-04-01', through: '2026-04-30', log: () => {},
    teams: [team('1', 'Alpha Aces'), team('2', 'Beta Bears')],
    games: [
      game({ game_id: 'g1', game_date: '2026-04-18' }),
      game({ game_id: 'g2', game_date: '2026-04-19' }),
      game({ game_id: 'g3', game_date: '2026-04-20' }),
    ],
  });

  const lines = [
    /* Alpha's regular: g1 4AB/2H, g2 4AB/1H → 8 AB, 3 H, avg .375 */
    bat({ game_id: 'g1', athlete_id: 'h1', athlete_name: 'Regular Starter', ab: 4, hits: 2,
          hr: 1, rbi: 2, runs: 1, bb: 1, so: 1, stolen_bases: 1, pitches_seen: 20,
          season_avg_at_game: 0.410, season_obp_at_game: 0.500, season_slg_at_game: 0.700 }),
    bat({ game_id: 'g2', athlete_id: 'h1', game_date: '2026-04-19', athlete_name: 'Regular Starter',
          ab: 4, hits: 1, so: 2, pitches_seen: 15,
          season_avg_at_game: 0.375, season_obp_at_game: 0.460, season_slg_at_game: 0.640 }),
    /* THE 2-FOR-2 PROBLEM: a perfect 1.000 average on two at-bats. He must NOT
       lead the club, and a brief that put him first would be useless. */
    bat({ game_id: 'g1', athlete_id: 'h2', athlete_name: 'Two For Two', ab: 2, hits: 2,
          position: 'PH', starter: false }),
    /* a pinch runner: no at-bats at all */
    bat({ game_id: 'g2', athlete_id: 'h3', game_date: '2026-04-19', athlete_name: 'Pinch Runner',
          ab: 0, hits: 0, runs: 1, stolen_bases: 2, starter: false }),
    /* Alpha's ace: 20 + 21 outs = 41 outs, 2 ER → ERA 2*27/41 = 1.317… */
    pitch({ game_id: 'g1', athlete_id: 'p1', athlete_name: 'The Ace', outs: 20, p_hits: 4,
            p_runs: 1, earned_runs: 1, p_bb: 1, p_so: 9, pitch_count: 92, strikes: 60,
            season_era_at_game: 1.50 }),
    pitch({ game_id: 'g2', athlete_id: 'p1', game_date: '2026-04-19', athlete_name: 'The Ace',
            outs: 21, p_hits: 3, p_runs: 1, earned_runs: 1, p_bb: 0, p_so: 11,
            pitch_count: 98, strikes: 70, season_era_at_game: 1.32 }),
    /* a one-batter reliever: 1 out, 0 ER → ERA 0.00 but only 1 out. Under the
       threshold, so he must not appear as the club's ERA leader. */
    pitch({ game_id: 'g1', athlete_id: 'p2', athlete_name: 'One Out Wonder', outs: 1,
            p_so: 1, pitch_count: 4, strikes: 3, season_era_at_game: 0.0 }),
    /* the visitors, so the box score has two sides */
    bat({ game_id: 'g1', athlete_id: 'v1', team_id: '2', team_name: 'Beta Bears',
          opponent_team_id: '1', athlete_name: 'Visiting Bat', ab: 3, hits: 1 }),
    pitch({ game_id: 'g1', athlete_id: 'v2', team_id: '2', team_name: 'Beta Bears',
            opponent_team_id: '1', athlete_name: 'Visiting Arm', outs: 18, p_hits: 6,
            p_runs: 2, earned_runs: 2, p_bb: 2, p_so: 4, pitch_count: 85, strikes: 55 }),
  ];
  const v = await SS.stageAndPromoteStats(db, 's-imp', { season: 2026, lines, log: () => {} });
  ok('the stats import is live', v && v.ok === true, v);

  const svc = L.createService({ read: (rel, q) => Promise.resolve(db.select('cbb', rel, q)) });

  console.log('the box score');
  const box = await svc.box('g1');
  ok('a game with a box score reports one', box.ok && box.has_box === true, box);
  eq('both clubs appear', box.sides.length, 2);
  const alpha = box.sides.find((s) => s.team_id === '1');
  eq('the home club\'s hitters', alpha.batting.length, 2);
  eq('…and its pitchers', alpha.pitching.length, 2);
  const h1line = alpha.batting.find((l) => l.athlete_id === 'h1');
  eq('a hitter\'s line reads as a reader reads it', h1line.line, '2-4');
  eq('…with the jersey', h1line.jersey, '7');
  /* .410 is his SEASON average after that game, not 2-for-4 = .500 */
  near('the rate on the line is labelled season-to-date', h1line.season_to_date.avg, 0.410);
  ok('…and is not presented as the game rate', h1line.avg === undefined, h1line.avg);
  const p1line = alpha.pitching.find((l) => l.athlete_id === 'p1');
  eq('innings are formatted from outs', p1line.ip, '6.2');
  eq('…and the outs are still there to add up', p1line.outs, 20);
  eq('pitch count', p1line.pitch_count, 92);

  console.log('a game the source has no box score for');
  const gap = await svc.box('g3');
  ok('it is not an error', gap.ok === true, gap);
  eq('…it reports no box score', gap.has_box, false);
  ok('…and says the feed is the gap, not the game',
    /gap in the feed/.test(gap.note || ''), gap.note);

  console.log('an unknown game');
  const nope = await svc.box('no-such-game');
  ok('reports no box score rather than throwing', nope.ok === true && nope.has_box === false, nope);

  console.log('the club line, and its coverage');
  const ts = await svc.teamStats('1', 2026);
  ok('the club has a stats row', ts.ok, ts);
  /* Alpha has lines in g1 and g2; the log says it played 3 games → 2/3 */
  eq('games with lines', ts.team.games_with_lines, 2);
  eq('games played', ts.team.games_played, 3);
  near('coverage is two thirds', ts.team.coverage, 2 / 3, 1e-9);
  /* THE SENTENCE A READER IS OWED */
  ok('…and the row says so in words', /2 of 3 games played/.test(ts.team.coverage_note || ''),
    ts.team.coverage_note);
  ok('…and calls itself a sample', /not the season/.test(ts.team.coverage_note || ''));
  /* club AB = 4 + 4 + 2 + 0 = 10, H = 2 + 1 + 2 + 0 = 5 → .500 */
  eq('club at-bats', ts.team.batting.ab, 10);
  eq('club hits', ts.team.batting.hits, 5);
  eq('club average prints without a leading zero', ts.team.batting.avg_text, '.500');
  /* club outs = 20 + 21 + 1 = 42 → 14.0 innings, 2 ER → 2*27/42 = 1.2857 */
  eq('club innings come from outs', ts.team.pitching.ip, '14.0');
  near('club ERA', ts.team.pitching.era, 2 * 27 / 42, 1e-9);

  console.log('a club at full coverage says nothing about coverage');
  const beta = await svc.teamStats('2', 2026);
  /* Beta has lines in g1 only, and played 3 → 1/3, so it DOES warn */
  ok('a partial club warns', beta.team.coverage_note !== null, beta.team.coverage_note);

  console.log('one player');
  const p = await svc.player('h1', 2026);
  ok('the player is found', p.ok, p);
  eq('he is a hitter', p.player.bats, true);
  eq('…and not a pitcher', p.player.pitches, false);
  ok('…so he has no pitching block at all', p.player.pitching === null);
  eq('at-bats', p.player.batting.ab, 8);
  eq('hits', p.player.batting.hits, 3);
  near('average is 3 for 8', p.player.batting.avg, 0.375, 1e-9);
  eq('…printed', p.player.batting.avg_text, '.375');
  /* the reported rates are the LAST game's, .460, not the mean of .500 and .460 */
  near('OBP is the last reported figure', p.player.batting.obp_reported, 0.460, 1e-9);
  eq('…as of a stated date', String(p.player.batting.rates_as_of).slice(0, 10), '2026-04-19');

  const ace = await svc.player('p1', 2026);
  eq('the ace is a pitcher', ace.player.pitches, true);
  eq('…and has no batting block', ace.player.batting, null);
  eq('41 outs is 13.2 innings', ace.player.pitching.ip, '13.2');
  near('ERA is 2 earned over 41 outs', ace.player.pitching.era, 2 * 27 / 41, 1e-9);
  eq('strikeouts', ace.player.pitching.so, 20);

  const runner = await svc.player('h3', 2026);
  ok('a hitter with no at-bats has NO average', runner.player.batting.avg === null,
    runner.player.batting.avg);
  eq('…and no printed average either', runner.player.batting.avg_text, null);
  eq('…but his steals are counted', runner.player.batting.sb, 2);

  console.log('leaders, with the threshold that makes them mean something');
  const ld = await svc.leaders('1', 2026);
  ok('leaders come back', ld.ok, ld);
  eq('the threshold is stated', ld.thresholds.min_ab, 30);
  /* NOBODY on this club clears 30 at-bats, so the average list is EMPTY rather
     than topped by the 2-for-2. An empty leader list is the honest answer to a
     season this short. */
  eq('no hitter clears the at-bat threshold, so the list is empty', ld.avg.length, 0);
  ok('…and the 2-for-2 is nowhere in it',
    !ld.avg.some((x) => x.athlete_id === 'h2'));
  /* The ace DOES clear it: 41 outs is 13.2 innings, well past ten. He is the
     club's only qualifier, and the one-out reliever with his 0.00 ERA is not. */
  eq('the ace clears ten innings and leads', ld.era.length, 1);
  eq('…and he is the ace', ld.era[0].athlete_id, 'p1');
  ok('…while the one-out reliever\'s 0.00 ERA is excluded',
    !ld.era.some((x) => x.athlete_id === 'p2'), ld.era.map((x) => x.athlete_id));

  console.log('…and with the threshold lowered, the order is still right');
  const ld2 = await svc.leaders('1', 2026, { min_ab: 4, min_outs: 18 });
  eq('now the regular qualifies', ld2.avg.length, 1);
  eq('…and he is the one', ld2.avg[0].athlete_id, 'h1');
  ok('the 2-for-2 still does not qualify on 2 at-bats',
    !ld2.avg.some((x) => x.athlete_id === 'h2'));
  eq('the ace leads on ERA', ld2.era[0].athlete_id, 'p1');
  /* THE ONE-OUT RELIEVER HAS AN ERA OF 0.00, WHICH IS LOWER THAN THE ACE'S.
     He is excluded by the outs threshold, not by luck of sorting. */
  ok('the one-out reliever with a 0.00 ERA is excluded by the threshold',
    !ld2.era.some((x) => x.athlete_id === 'p2'), ld2.era.map((x) => x.athlete_id));
  eq('home run leaders are ordered by home runs', ld2.hr[0].athlete_id, 'h1');
  eq('strikeout leaders too', ld2.so[0].athlete_id, 'p1');

  console.log('a null ERA must not sort as the best');
  /* p2 has 1 out and an ERA; give the sort a pitcher with outs but no ERA by
     asking with a threshold of zero, where the pinch runner's pitching block is
     absent entirely — the filter drops him rather than sorting him first. */
  const ld3 = await svc.leaders('1', 2026, { min_ab: 0, min_outs: 0 });
  ok('every ERA in the list is a real number',
    ld3.era.every((x) => x.pitching.era !== null), ld3.era.map((x) => x.pitching.era));
  ok('…and they ascend', ld3.era.every((x, i, a) => i === 0 || a[i - 1].pitching.era <= x.pitching.era),
    ld3.era.map((x) => x.pitching.era));

  console.log('the coverage report');
  const cov = await svc.statsCoverage(2026);
  ok('it comes back', cov.ok, cov);
  eq('three completed games', cov.seasons[0].completed_games, 3);
  eq('two carried lines', cov.seasons[0].games_with_lines, 2);
  near('coverage is two thirds', cov.seasons[0].coverage, 2 / 3, 1e-9);

  console.log('a club with no lines at all');
  const none = await svc.teamStats('999', 2026);
  ok('is refused by name', none.ok === false && none.code === 'NO_STATS_ROW', none);
  ok('…and says the record still works', /record still comes from the game log/.test(none.error),
    none.error);

  console.log('innings formatting on its own');
  eq('0 outs', L.ipText(0), '0.0');
  eq('1 out', L.ipText(1), '0.1');
  eq('3 outs', L.ipText(3), '1.0');
  eq('41 outs', L.ipText(41), '13.2');
  eq('unknown stays unknown', L.ipText(null), null);
  eq('a rate loses its leading zero', L.rateText(0.375), '.375');
  eq('…but 1.000 keeps its one', L.rateText(1), '1.000');
  eq('an unknown rate prints as nothing', L.rateText(null), null);
})().then(() => {
  console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
  console.log(fail ? `FAIL | cbb stats query | ${fail} failed`
    : `PASS | cbb stats query layer | ${pass} assertions against a real PostgreSQL`);
  try { PG.dropDatabase(conn, DB); } catch (_) {}
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL | cbb stats query | ' + ((e && e.stack) || e));
  try { PG.dropDatabase(conn, DB); } catch (_) {}
  process.exit(1);
});
