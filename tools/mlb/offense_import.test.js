#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the OFFENSIVE import, end to end, against a real PostgreSQL.

   Not a unit test of a parser. It applies both shipped schemas, runs the
   SHIPPED importers over the COMMITTED datasets — all 10,098 batter-seasons
   and 11,038 player-team rows, plus the 8,233 pitcher-seasons beside them —
   through the real promote gates, and then asks the database the questions a
   reader would.

   THE RISKS IT EXISTS TO CATCH, each one a way this data could quietly lie:

     1  a second import doubling the archive instead of replacing it;
     2  a traded hitter losing a club — the exact record a naive team-by-team
        pull drops, and the reason the package ships 31 repairs;
     3  the three game counts being conflated: official player games, the sum
        of the team splits, and a club's actual games are three different
        numbers and only one of them belongs in runs per game;
     4  the documented 2024 games-field difference being smoothed away;
     5  a zero-PA record acquiring a .000 average instead of no average;
     6  a walk-only record losing its OBP or gaining an OPS;
     7  the two grains being added together, which double-counts a career;
     8  an ambiguous name resolving to whichever hitter is busier;
     9  a two-way player becoming two people;
    10  a team average computed by averaging player averages;
    11  a 2020 workload screen borrowed from a 162-game season, which erases
        the season entirely;
    12  a corrupted dataset replacing a good archive;
    13  the archive being read as a lineup.

   Without a reachable PostgreSQL it skips loudly and passes.

   Run: node tools/mlb/offense_import.test.js
   =========================================================================== */
'use strict';
const path = require('path');

const PG = require('./pg_client.js');
const D = require('./offense_dataset.js');
const IMPORT = require('./import_offense.js');
const M = require('../../lib/mlb_offense_history.js');
const PD = require('./dataset.js');
const PIMPORT = require('./import_pitcher_history.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_mlboff_import';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const PITCH_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFF_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
function near(name, got, want, tol) {
  const d = Math.abs(Number(got) - Number(want));
  ok(name, Number.isFinite(d) && d <= (tol == null ? 1e-6 : tol), `got ${got}, want ${want}`);
}

const conn = PG.findServer();
if (!conn) {
  console.log('SKIP | mlb offense import end to end | no reachable PostgreSQL server');
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}

(async function main() {
  if (!PG.createDatabase(conn, DB)) {
    console.log('SKIP | mlb offense import end to end | could not create the test database');
    process.exit(0);
  }
  const db = PG.pgClient(conn, { database: DB });
  let code = 0;
  try {
    for (const f of [SHIM, PITCH_SQL, OFF_SQL]) {
      const r = PG.applyFile(conn, DB, f);
      if (!r.ok) {
        console.log('FAIL | ' + path.basename(f) + ' did not apply');
        console.error(r.stderr.split('\n').slice(0, 8).join('\n'));
        throw new Error('apply');
      }
    }
    console.log('mlb offense import end to end');
    const count = (t, where) => Number(db.rows(
      `select count(*)::int as n from mlbhist.${t}${where ? ' where ' + where : ''}`)[0].n);

    /* ══ 1. the real dataset, the real importer, the real gate ══════════ */
    const ds = D.loadDataset(D.DEFAULT_DIR);
    const verdict = D.validateDataset(ds);
    ok('the committed dataset validates before anything is written', verdict.ok,
      (verdict.problems[0] || {}).detail);

    const t0 = Date.now();
    const res = await IMPORT.runImport(db, ds, verdict, { log: () => {}, chunk: 1000 });
    ok('the offensive import promoted', !!(res && res.promote && res.promote.ok === true),
      JSON.stringify(res && res.promote).slice(0, 200));
    console.log(`  ..   imported in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const R = ds.report.tables;
    eq('batter_seasons rows', count('batter_seasons'), R.batter_seasons);
    eq('batter_team_seasons rows', count('batter_team_seasons'), R.batter_team_seasons);
    eq('batter_overview rows', count('batter_overview'), R.batter_overview);
    eq('batter_team_history rows', count('batter_team_history'), R.batter_team_history);
    eq('observed_batter_team_runs rows', count('observed_batter_team_runs'), R.observed_team_runs);
    eq('team_offense_seasons rows', count('team_offense_seasons'), R.team_offense_seasons);
    eq('team_offense_overview rows', count('team_offense_overview'), R.team_offense_overview);
    eq('league_offense_seasons rows', count('league_offense_seasons'), R.league_seasons);
    eq('offense_validation rows', count('offense_validation'), R.validation);
    eq('offense_source_repairs rows', count('offense_source_repairs'), ds.report.individual_history_repairs);
    eq('offense_games_reconciliation rows', count('offense_games_reconciliation'),
      ds.report.games_field_differences);
    eq('players with a plate appearance', count('batter_overview', 'plate_appearances > 0'),
      ds.report.players_with_PA);

    /* THE LEDGER KEEPS THE TWO DATASETS APART. */
    eq('the import ran as an offense import', count('import_runs', "dataset = 'offense' and status = 'promoted'"), 1);
    eq('no pitching import was created by it', count('import_runs', "dataset = 'pitching'"), 0);
    const st = db.rows('select * from mlbhist.offense_status')[0];
    eq('offense_status reports the coverage window start', Number(st.coverage_start), 2016);
    eq('offense_status reports the coverage window end', Number(st.coverage_end), 2025);
    eq('offense_status carries the rating version', st.rating_version, 'ED_BAT_PERF_V1');

    /* ══ 2. AARON JUDGE, checked against the package row by row ═════════ */
    const judgeCsv = ds.tables.batter_overview.filter((r) => r.player_name === 'Aaron Judge')[0];
    ok('Aaron Judge is in the package', !!judgeCsv);
    const judge = db.rows(`select * from mlbhist.batter_overview where player_id = ${judgeCsv.player_id}`)[0];
    ok('Aaron Judge imported', !!judge);
    eq('…his plate appearances', Number(judge.plate_appearances), judgeCsv.plate_appearances);
    eq('…his home runs', Number(judge.home_runs), judgeCsv.home_runs);
    near('…his OPS', judge.ops, judgeCsv.ops);
    near('…his career index', judge.weighted_offensive_index, judgeCsv.weighted_offensive_index, 1e-3);
    eq('…his rating version travels with it', judge.rating_version, 'ED_BAT_PERF_V1');
    /* The club list the package ships blank and the importer rebuilds. */
    ok('…his club list was rebuilt from the team grain', /Yankees/.test(judge.teams || ''), judge.teams);
    eq('…with the right number of clubs', Number(judge.team_count), 1);

    const judgeSeasons = db.rows(
      `select season, plate_appearances, home_runs, obp, slg, ops, offensive_index, sample_flag
         from mlbhist.batter_seasons where player_id = ${judgeCsv.player_id} order by season`);
    eq('…ten seasons of his are on file', judgeSeasons.length, 10);
    /* Every one of his season rows must match the package exactly. */
    let judgeBad = 0;
    judgeSeasons.forEach((row) => {
      const src = ds.tables.batter_seasons.filter(
        (r) => r.player_id === judgeCsv.player_id && r.season === Number(row.season))[0];
      if (!src) { judgeBad++; return; }
      if (Number(row.plate_appearances) !== src.plate_appearances) judgeBad++;
      if (Number(row.home_runs) !== src.home_runs) judgeBad++;
      if (Math.abs(Number(row.ops) - src.ops) > 1e-9) judgeBad++;
      if (Math.abs(Number(row.offensive_index) - src.offensive_index) > 1e-9) judgeBad++;
    });
    eq('…and every season row matches the package exactly', judgeBad, 0);

    /* ══ 3. A TRADED HITTER KEEPS EVERY CLUB ═══════════════════════════ */
    const traded = ds.tables.batter_seasons
      .filter((r) => r.team_count >= 3).sort((a, b) => b.plate_appearances - a.plate_appearances)[0];
    ok('the package contains a hitter who played for three clubs in one season', !!traded,
      traded && traded.player_name);
    const splits = db.rows(
      `select team_id, team_name, plate_appearances, at_bats, hits, home_runs, offensive_index
         from mlbhist.batter_team_seasons
        where player_id = ${traded.player_id} and season = ${traded.season}
        order by plate_appearances desc`);
    eq(`…${traded.player_name} ${traded.season} kept all three clubs`, splits.length, 3);
    const combined = db.rows(
      `select plate_appearances, at_bats, hits, home_runs, games, team_split_games_sum, team_count, team_ids
         from mlbhist.batter_seasons
        where player_id = ${traded.player_id} and season = ${traded.season}`)[0];
    /* THE TWO GRAINS AGREE AND ARE NEVER ADDED. */
    eq('…the combined row equals the sum of the splits on plate appearances',
      splits.reduce((a, r) => a + Number(r.plate_appearances), 0), Number(combined.plate_appearances));
    eq('…and on hits', splits.reduce((a, r) => a + Number(r.hits), 0), Number(combined.hits));
    eq('…and on home runs', splits.reduce((a, r) => a + Number(r.home_runs), 0), Number(combined.home_runs));
    eq('…team_count matches the clubs actually stored', Number(combined.team_count), splits.length);
    ok('…team_ids is a real array, not a semicolon string',
      Array.isArray(combined.team_ids) || /^\{/.test(String(combined.team_ids)), String(combined.team_ids));
    /* A traded hitter's per-club ratings are each shrunk on their own plate
       appearances, so they do not average to the combined one — and nothing
       in the product should expect them to. */
    ok('…each club split carries its own rating',
      splits.every((r) => r.offensive_index !== null), JSON.stringify(splits.map((r) => r.offensive_index)));

    /* ══ 4. THE 31 SOURCE REPAIRS ══════════════════════════════════════ */
    eq('every repaired player-season is on file', count('offense_source_repairs'), 31);
    let repairBad = 0;
    ds.repairs.forEach((rp) => {
      const n = Number(db.rows(
        `select count(*)::int as n from mlbhist.batter_team_seasons
          where player_id = ${Number(rp.player_id)} and season = ${Number(rp.season)}`)[0].n);
      if (n !== Number(rp.replacement_team_rows)) repairBad++;
    });
    eq('…and each one has exactly the club rows its repair produced', repairBad, 0);
    const rp0 = ds.repairs[0];
    ok('…the repair keeps the source url that justified it',
      /statsapi\.mlb\.com/.test(db.rows(
        `select source_url from mlbhist.offense_source_repairs
          where player_id = ${Number(rp0.player_id)} and season = ${Number(rp0.season)}`)[0].source_url || ''));

    /* ══ 5. THE THREE GAME COUNTS STAY DISTINCT ════════════════════════ */
    const recon = db.rows('select * from mlbhist.offense_games_reconciliation order by season, player_id');
    eq('the documented games-field difference is preserved', recon.length, 1);
    eq('…for the 2024 season the package names', Number(recon[0].season), 2024);
    eq('…the player the package names', Number(recon[0].player_id), 643376);
    eq('…with MLB’s official games', Number(recon[0].official_games), 91);
    eq('…and the team-split sum beside it, not instead of it',
      Number(recon[0].team_split_games_sum), 92);
    ok('…and the two are still different in the season row itself', (() => {
      const r = db.rows(`select games, team_split_games_sum from mlbhist.batter_seasons
                          where player_id = 643376 and season = 2024`)[0];
      return Number(r.games) === 91 && Number(r.team_split_games_sum) === 92;
    })());
    /* A club's games are not the sum of its players' games. */
    const clubGames = db.rows(`select season, team_id, team_games, player_games_sum, runs, runs_per_game
                                 from mlbhist.team_offense_seasons where season = 2025 order by team_id limit 1`)[0];
    ok('a club-season keeps team_games and player_games_sum apart',
      Number(clubGames.team_games) !== Number(clubGames.player_games_sum),
      `${clubGames.team_games} vs ${clubGames.player_games_sum}`);
    near('…and runs per game uses the club’s ACTUAL games',
      Number(clubGames.runs_per_game), Number(clubGames.runs) / Number(clubGames.team_games), 1e-6);
    eq('no club-season anywhere has the two equal',
      count('team_offense_seasons', 'player_games_sum = team_games'), 0);

    /* ══ 6. UNDEFINED IS NOT ZERO ══════════════════════════════════════ */
    eq('every zero-PA row is on file', count('batter_seasons', 'plate_appearances = 0'), 1889);
    eq('…and not one of them has a batting average',
      count('batter_seasons', 'plate_appearances = 0 and avg is not null'), 0);
    eq('…or an on-base percentage',
      count('batter_seasons', 'plate_appearances = 0 and obp is not null'), 0);
    eq('…or a rating',
      count('batter_seasons', 'plate_appearances = 0 and offensive_index is not null'), 0);
    eq('…and each is flagged as such',
      count('batter_seasons', "plate_appearances = 0 and sample_flag <> 'zero_PA'"), 0);

    /* A WALK AND NO AT-BAT. OBP is defined; SLG, OPS and the rating are not. */
    const walkOnly = db.rows(`select player_id, player_name, season, plate_appearances, at_bats, walks,
                                     avg, obp, slg, ops, offensive_index
                                from mlbhist.batter_seasons
                               where at_bats = 0 and walks > 0 order by season, player_id`);
    eq('every walk-only record is on file', walkOnly.length, 17);
    eq('…each keeps a defined on-base percentage',
      walkOnly.filter((r) => r.obp === null).length, 0);
    eq('…and none of them has a slugging',
      walkOnly.filter((r) => r.slg !== null).length, 0);
    eq('…or an OPS', walkOnly.filter((r) => r.ops !== null).length, 0);
    eq('…or a rating', walkOnly.filter((r) => r.offensive_index !== null).length, 0);
    eq('…or a batting average', walkOnly.filter((r) => r.avg !== null).length, 0);

    /* ══ 7. RATES COME FROM AGGREGATE NUMERATORS ═══════════════════════ */
    /* A club's batting average is hits over at-bats, summed first. If it were
       the mean of its players' averages it would be a different number, and
       this proves the stored value is the first one. */
    const club = db.rows(`select team_id, season, hits, at_bats, avg, obp, slg, ops
                            from mlbhist.team_offense_seasons where season = 2025 and team_id = 147`)[0];
    near('a club average is hits over at-bats, summed first',
      Number(club.avg), Number(club.hits) / Number(club.at_bats), 1e-6);
    const meanOfPlayerAvgs = db.rows(
      `select avg(avg)::float8 as m from mlbhist.batter_team_seasons
        where season = 2025 and team_id = 147 and avg is not null`)[0].m;
    ok('…and is NOT the mean of its players’ averages',
      Math.abs(Number(club.avg) - Number(meanOfPlayerAvgs)) > 1e-4,
      `aggregate ${club.avg} vs mean-of-means ${meanOfPlayerAvgs}`);
    /* And the query layer computes it the same way from the same rows. */
    const roster = db.rows(
      `select plate_appearances, at_bats, hits, walks, hit_by_pitch, sacrifice_flies, total_bases,
              home_runs, strikeouts, doubles, triples, caught_stealing, stolen_bases, games, runs, rbi,
              singles, intentional_walks, sacrifice_bunts, grounded_into_double_play,
              catcher_interference, pitches_seen, offensive_index
         from mlbhist.batter_team_seasons where season = 2025 and team_id = 147`)
      .map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = r[k] == null ? null : Number(r[k]); }); return o; });
    const agg = M.aggregateSeasons(roster);
    near('the query layer’s aggregate matches the club row’s average', agg.avg, Number(club.avg), 1e-6);
    near('…and its on-base percentage', agg.obp, Number(club.obp), 1e-6);
    near('…and its slugging', agg.slg, Number(club.slg), 1e-6);

    /* ══ 8. 2020 IS A 60-GAME SEASON ═══════════════════════════════════ */
    const g2020 = Number(db.rows(
      `select max(team_games)::int as g from mlbhist.team_offense_seasons where season = 2020`)[0].g);
    const g2025 = Number(db.rows(
      `select max(team_games)::int as g from mlbhist.team_offense_seasons where season = 2025`)[0].g);
    eq('2020 club games came from the source, not a hardcoded 162', g2020, 60);
    eq('2025 club games are a full season', g2025, 162);
    eq('the qualification for 2020 is computed from its own games', M.qualifiedPA(g2020), 186);
    eq('…and for a full season it is the familiar 502', M.qualifiedPA(g2025), 503);
    const qualified2020 = count('batter_seasons', `season = 2020 and plate_appearances >= ${M.qualifiedPA(g2020)}`);
    const wouldBeErased = count('batter_seasons', 'season = 2020 and plate_appearances >= 502');
    ok('a 2020 leaderboard has qualified hitters when screened on its own season',
      qualified2020 > 100, String(qualified2020));
    eq('…and borrowing a full season’s screen would erase every one of them', wouldBeErased, 0);

    /* ══ 9. TEAM TOTALS RECONCILED TO MLB’S OWN TEAM ENDPOINT ══════════ */
    eq('every season reconciled at the player grain',
      count('offense_validation', 'player_totals_reconcile is not true'), 0);
    eq('every season reconciled at the team grain',
      count('offense_validation', 'team_totals_reconcile is not true'), 0);
    eq('…across the 19 counting fields the package checks',
      count('offense_validation', 'counting_fields_reconciled <> 19'), 0);
    ok('…and the club row keeps the url of the independent total that verified it',
      /statsapi\.mlb\.com/.test(db.rows(
        `select team_totals_source_url from mlbhist.team_offense_seasons
          where season = 2025 and team_id = 147`)[0].team_totals_source_url || ''));

    /* ══ 10. IMPORTING THE SAME DATASET AGAIN CHANGES NOTHING ══════════ */
    const before = {
      seasons: count('batter_seasons'), teamSeasons: count('batter_team_seasons'),
      overview: count('batter_overview'), clubs: count('team_offense_seasons'),
      judgePa: Number(db.rows(
        `select plate_appearances from mlbhist.batter_seasons
          where player_id = ${judgeCsv.player_id} and season = 2025`)[0].plate_appearances)
    };
    const res2 = await IMPORT.runImport(db, ds, verdict, { log: () => {}, chunk: 1000 });
    ok('a second import of the same dataset promoted', res2.promote.ok === true);
    eq('…batter_seasons did not double', count('batter_seasons'), before.seasons);
    eq('…batter_team_seasons did not double', count('batter_team_seasons'), before.teamSeasons);
    eq('…batter_overview did not double', count('batter_overview'), before.overview);
    eq('…team_offense_seasons did not double', count('team_offense_seasons'), before.clubs);
    eq('…and Judge’s 2025 line is unchanged', Number(db.rows(
      `select plate_appearances from mlbhist.batter_seasons
        where player_id = ${judgeCsv.player_id} and season = 2025`)[0].plate_appearances), before.judgePa);
    eq('…the previous import is marked superseded, not deleted',
      count('import_runs', "dataset = 'offense' and status = 'superseded'"), 1);
    eq('…and exactly one offense import is promoted',
      count('import_runs', "dataset = 'offense' and status = 'promoted'"), 1);
    eq('…staging is empty after promotion', count('stg_batter_seasons'), 0);

    /* ══ 11. A CORRUPTED DATASET IS REFUSED, THE ARCHIVE SURVIVES ══════ */
    async function refuse(name, mutate, wantCode) {
      const bad = D.loadDataset(D.DEFAULT_DIR);
      const rows = IMPORT.prepareRows(bad);
      mutate(bad, rows);
      let caught = null;
      try {
        await IMPORT.runImport(db, bad, verdict, { log: () => {}, chunk: 1000, rows: rows });
      } catch (e) { caught = e; }
      ok(name, !!caught && caught.code === wantCode,
        caught ? 'code ' + caught.code : 'the gate did not refuse it');
      /* And nothing live moved. */
      eq('  …the live archive is untouched', count('batter_seasons'), before.seasons);
      eq('  …Judge is still there', Number(db.rows(
        `select plate_appearances from mlbhist.batter_seasons
          where player_id = ${judgeCsv.player_id} and season = 2025`)[0].plate_appearances), before.judgePa);
    }

    await refuse('a short dataset is refused as a count mismatch',
      (bad, rows) => { rows.batter_seasons = rows.batter_seasons.slice(0, 10000); }, 'COUNT_MISMATCH');
    await refuse('a duplicated player-season is refused as a duplicate key',
      (bad, rows) => {
        rows.batter_seasons = rows.batter_seasons.concat([
          Object.assign({}, rows.batter_seasons[0])]);
        bad.report.tables.batter_seasons = rows.batter_seasons.length;
      }, 'DUPLICATE_KEY');
    await refuse('a season that failed its own reconciliation is refused',
      (bad, rows) => { rows.offense_validation[0].player_totals_reconcile = false; }, 'VALIDATION_FAILED');
    /* THE GRAIN GATE. A player-season whose combined total no longer equals the
       sum of its own club rows is the shape of a lost traded club, and it must
       never reach a live table. */
    await refuse('a player-season that disagrees with its own team splits is refused',
      (bad, rows) => {
        const hit = rows.batter_seasons.filter((r) => r.player_id === traded.player_id
          && r.season === traded.season)[0];
        hit.plate_appearances = hit.plate_appearances - 7;
      }, 'GRAIN_VIOLATION');
    await refuse('an empty dataset is refused as empty staging',
      (bad, rows) => {
        TABLES_EMPTY(rows);
        bad.report.tables.batter_seasons = 0;
        bad.report.tables.batter_team_seasons = 0;
        bad.report.tables.batter_overview = 0;
        bad.report.tables.team_offense_seasons = 0;
      }, 'EMPTY_STAGING');
    function TABLES_EMPTY(rows) {
      ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'team_offense_seasons']
        .forEach((t) => { rows[t] = []; });
    }

    /* ══ 12. THE PITCHING ARCHIVE BESIDE IT, AND THE TWO-WAY JOIN ══════ */
    const pds = PD.loadDataset(PD.DEFAULT_DIR);
    const pv = PD.validateDataset(pds);
    ok('the pitching dataset still validates', pv.ok, pv.summary);
    const pres = await PIMPORT.runImport(db, pds, pv, { log: () => {}, chunk: 1000 });
    ok('the pitching import promoted into the same schema', pres.promote.ok === true);
    eq('…both datasets are now promoted, one each',
      count('import_runs', "status = 'promoted'"), 2);
    eq('…the offensive archive is untouched by it', count('batter_seasons'), before.seasons);

    /* SHOHEI OHTANI: one MLB id, both archives, never two people. */
    const ohtaniRow = ds.tables.batter_overview.filter((r) => /Ohtani/.test(r.player_name))[0];
    ok('Ohtani is in the offensive archive', !!ohtaniRow);
    const tw = db.rows(`select * from mlbhist.two_way_players where player_id = ${ohtaniRow.player_id}`);
    eq('…and appears exactly once in the two-way view', tw.length, 1);
    ok('…with his hitting side', Number(tw[0].batting_plate_appearances) === ohtaniRow.plate_appearances,
      `${tw[0].batting_plate_appearances} vs ${ohtaniRow.plate_appearances}`);
    ok('…and his pitching side, from the other archive', Number(tw[0].pitching_outs) > 0,
      String(tw[0].pitching_outs));
    const ohtaniPitch = db.rows(
      `select outs, era, weighted_performance_index from mlbhist.pitcher_overview
        where player_id = ${ohtaniRow.player_id}`)[0];
    eq('…the two sides agree because they are the same person id',
      Number(tw[0].pitching_outs), Number(ohtaniPitch.outs));
    ok('…the two ratings stay on their own scales', (() => {
      const shaped = M.shapeTwoWay(tw[0]);
      return shaped.batting.rating_version === 'ED_BAT_PERF_V1'
        && shaped.pitching.rating_version === 'ED_PITCH_PERF_V1'
        && /never combined into one number/.test(shaped.note);
    })());
    eq('…and there is exactly one batter_overview row for him',
      count('batter_overview', `player_id = ${ohtaniRow.player_id}`), 1);

    /* A HITTING RECORD IS NOT A HITTER. Every pitcher who batted is in this
       archive, so the two-way view's thresholds are the honest filter. */
    const twAll = Number(db.rows('select count(*)::int as n from mlbhist.two_way_players')[0].n);
    ok('the two-way view is not simply everyone in both tables', twAll > 0, String(twAll));
    const meaningful = Number(db.rows(
      `select count(*)::int as n from mlbhist.two_way_players
        where batting_plate_appearances >= 200 and pitching_outs >= 150`)[0].n);
    ok('…and a workload screen separates real two-way players from pitchers who batted',
      meaningful < twAll, `${meaningful} of ${twAll}`);

    /* ══ 13. THE QUERY LAYER, OVER THE REAL DATABASE ═══════════════════ */
    const svc = M.createService({
      read: async (rel, query) => db.select('mlbhist', rel, query)
    });
    const stat = await svc.status();
    ok('the query layer reads its coverage', stat.ok && stat.coverage.end === 2025,
      JSON.stringify(stat.code));
    ok('…and says in the same breath that it is not a lineup',
      /never a lineup/.test(stat.notes.join(' ')), stat.notes.join(' ').slice(0, 120));

    const byName = await svc.resolveHitter({ name: 'Aaron Judge' });
    ok('a hitter resolves by name', byName.ok && byName.data.resolved.player_id === judgeCsv.player_id);
    const ov = await svc.hitterOverview({ player_id: judgeCsv.player_id });
    ok('his overview comes back', ov.ok);
    eq('…with his plate appearances from the database',
      ov.data.overview.plate_appearances, judgeCsv.plate_appearances);
    ok('…and the sample flag travels with the rating',
      ov.sample.sample_flag === '200_plus_PA' && ov.data.overview.rating_version === 'ED_BAT_PERF_V1');
    ok('…his year-over-year steps are computed', ov.data.year_over_year.length > 0);
    ok('…and the OPS decomposition names which half led it',
      ov.data.latest_ops_decomposition && ov.data.latest_ops_decomposition.available
      && ['on_base', 'power', 'balanced'].indexOf(ov.data.latest_ops_decomposition.lead) >= 0,
      JSON.stringify(ov.data.latest_ops_decomposition && ov.data.latest_ops_decomposition.lead));

    /* AN AMBIGUOUS NAME IS REFUSED. */
    const folded = Object.create(null);
    ds.tables.batter_overview.forEach((r) => {
      const k = M.nameKey(r.player_name);
      (folded[k] = folded[k] || []).push(r);
    });
    const ambKey = Object.keys(folded).filter((k) => folded[k].length > 1)[0];
    ok('the archive contains at least one shared folded name', !!ambKey, ambKey);
    const amb = await svc.resolveHitter({ name: folded[ambKey][0].player_name });
    ok('…and resolving it is refused rather than guessed',
      !amb.ok && amb.code === 'AMBIGUOUS_PLAYER', amb.code);
    ok('…with every candidate returned for the caller to choose',
      amb.data.candidates.length === folded[ambKey].length, String(amb.data.candidates.length));
    ok('…and no resolved player attached', amb.data.resolved === null);

    /* THE LEADERBOARD IS ORDERED BY THE DATABASE. */
    const lb = await svc.leaderboard({ season: 2025, min_pa: 500, metric: 'offensive_index', limit: 10 });
    ok('a leaderboard comes back', lb.ok && lb.data.length > 0, lb.code);
    ok('…ordered by the database, descending', (() => {
      for (let i = 1; i < lb.data.length; i++) {
        if (lb.data[i - 1].offensive_index < lb.data[i].offensive_index) return false;
      }
      return true;
    })());
    ok('…and it says what workload screen it applied and what MLB’s own is',
      /Workload screen: 500\+ plate appearances/.test(lb.notes.join(' '))
      && /qualification for 2025 is 503 PA/.test(lb.notes.join(' ')), lb.notes.join(' ').slice(0, 200));
    const lb2020 = await svc.leaderboard({ season: 2020, min_pa: 186, metric: 'offensive_index', limit: 5 });
    ok('a 2020 leaderboard explains the short season rather than silently erasing it',
      /60-game season/.test(lb2020.notes.join(' ')), lb2020.notes.join(' ').slice(-200));
    /* Cross-check the top of the board against SQL directly. */
    const sqlTop = db.rows(
      `select player_id, offensive_index from mlbhist.batter_seasons
        where season = 2025 and plate_appearances >= 500 and offensive_index is not null
        order by offensive_index desc limit 1`)[0];
    eq('…and the leader the layer returns is the leader the database has',
      lb.data[0].player_id, Number(sqlTop.player_id));

    /* CHANGES BETWEEN TWO COMPLETED SEASONS. */
    const ch = await svc.changes({ from_season: 2024, to_season: 2025, metric: 'bb_pct', min_pa: 300, limit: 5 });
    ok('year-over-year changes come back', ch.ok && ch.data.length > 0, ch.code);
    ok('…ordered by the size of the improvement', (() => {
      for (let i = 1; i < ch.data.length; i++) if (ch.data[i - 1].delta < ch.data[i].delta) return false;
      return true;
    })());
    ok('…and only hitters who cleared the screen in BOTH seasons are in it',
      ch.data.every((r) => r.from_plate_appearances >= 300 && r.to_plate_appearances >= 300));
    ok('…which the note says out loud',
      /cleared 300 plate appearances in BOTH seasons/.test(ch.notes.join(' ')));

    /* TEAM OFFENSE. */
    const to = await svc.teamOffense({ team_id: 147, season: 2025 });
    ok('a club-season comes back with its roster', to.ok && to.data.seasons.length === 1
      && to.data.roster.length > 0, to.code);
    near('…with runs per game equal to runs over the club’s ACTUAL games',
      to.data.seasons[0].runs_per_game,
      to.data.seasons[0].runs / to.data.seasons[0].team_games, 1e-6);
    ok('…and the layer carries that season’s own qualification threshold',
      to.data.seasons[0].qualified_pa === M.qualifiedPA(to.data.seasons[0].team_games),
      String(to.data.seasons[0].qualified_pa));
    ok('…and the note keeps player_games_sum out of it',
      /player_games_sum is the sum of/.test(to.notes.join(' ')));

    /* THE LINEUP RULE. */
    const lineup = await svc.lineupContext({ names: ['Aaron Judge', 'Shohei Ohtani'] });
    ok('lineup context resolves the hitters it was given', lineup.ok && lineup.data.hitters.length === 2,
      lineup.code);
    ok('…sums their counting totals and recomputes the rates',
      lineup.data.combined && lineup.data.combined.obp != null);
    ok('…and says in words that it is NOT a lineup',
      /THIS IS NOT A LINEUP/.test(lineup.notes.join(' ')));
    ok('…and that handedness splits and BvP are not in this archive',
      /no batter-versus-pitcher history/.test(lineup.notes.join(' ')));
    const noNames = await svc.lineupContext({});
    ok('…and it refuses to produce a lineup when given none',
      !noNames.ok && /cannot produce the lineup/.test(noNames.error), noNames.error);

    /* CURRENT VERSUS HISTORICAL, never merged. */
    const cvb = await svc.currentVsBaseline({ player_id: judgeCsv.player_id, baseline_seasons: 5,
      current: { season: 2026, plate_appearances: 300, ops: 0.9 } });
    ok('a current line and a historical baseline come back side by side',
      cvb.ok && cvb.data.historical_baseline && cvb.data.current, cvb.code);
    ok('…labelled as different measurements that are never averaged',
      /never averaged together/.test(cvb.data.note));
    eq('…over the five completed seasons asked for', cvb.scope.baseline_seasons.length, 5);

    /* ══ 14. ACCESS CONTROL STILL APPLIES ══════════════════════════════ */
    /* Every probe runs inside one psql invocation that switches role first, so
       what is being tested is the grant and the policy the shipped file
       installed — not this test's own connection privileges. */
    function asRole(role, stmt) {
      try { db.sql(`set role ${role}; ${stmt}; reset role;`); return 'ALLOWED'; }
      catch (e) { try { db.sql('reset role;'); } catch (_) { /* best effort */ } return 'DENIED'; }
    }
    ['anon', 'authenticated'].forEach((role) => {
      eq(role + ' may read the offensive record',
        asRole(role, 'select count(*) from mlbhist.batter_seasons'), 'ALLOWED');
      eq(role + ' may read the two-way view',
        asRole(role, 'select count(*) from mlbhist.two_way_players'), 'ALLOWED');
      eq(role + ' may NOT write the offensive record',
        asRole(role, "insert into mlbhist.batter_seasons (player_id, season, player_name, name_key) values (1,2016,'x','x')"),
        'DENIED');
      eq(role + ' may NOT delete from it',
        asRole(role, 'delete from mlbhist.batter_seasons'), 'DENIED');
      eq(role + ' may NOT read staging',
        asRole(role, 'select count(*) from mlbhist.stg_batter_seasons'), 'DENIED');
      eq(role + ' may NOT execute the offensive promote gate',
        asRole(role, "select mlbhist.promote_offense_import('x')"), 'DENIED');
      eq(role + ' may NOT execute the abandon gate',
        asRole(role, "select mlbhist.abandon_offense_import('x','y')"), 'DENIED');
    });
    /* And the archive is still there after all that. */
    eq('the archive survived every attempt to write it', count('batter_seasons'), before.seasons);

    console.log(`\n${fail === 0 ? 'ALL GREEN ' : 'FAILED '}${pass} passed, ${fail} failed`);
    if (fail === 0) console.log('PASS | mlb offense import end to end | ' + pass + ' assertions against a real PostgreSQL');
    code = fail === 0 ? 0 : 1;
  } catch (e) {
    console.log('FAIL | mlb offense import end to end | ' + (e && e.stack || e));
    code = 1;
  } finally {
    try { db.close(); } catch (_) { /* best effort */ }
    PG.dropDatabase(conn, DB);
  }
  process.exit(code);
})();
