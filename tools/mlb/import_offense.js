#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — import the historical OFFENSIVE record.

   The same six-step shape as the pitching importer, against its own gate:

     1. read      the packaged dataset from disk (mlb/batters/dataset, or --dir)
     2. check     re-derive every rate and rating from the raw counts and refuse
                  to go further if anything disagrees (tools/mlb/offense_dataset.js).
                  A refusal here costs nothing: nothing live has been touched.
     3. open      a row in mlbhist.import_runs with dataset='offense', carrying
                  coverage, the rating version, the source fingerprint, the
                  package's own counts and the transformations this import applies
     4. stage     every row into mlbhist.stg_*, keyed by that import id
     5. promote   mlbhist.promote_offense_import(), one transaction, which checks
                  the staged counts against the package's own, refuses duplicate
                  keys, an unreconciled season at either grain, and a
                  player-season that disagrees with the sum of its own team splits
     6. record    freshness into mlbhist.meta and a dated snapshot of what was
                  published

   RUNNING IT TWICE WRITES THE SAME ROWS, and the pitching archive is never
   touched: the two datasets share one ledger and one schema but have separate
   gates, separate tables and separate meta keys.

     node tools/mlb/import_offense.js --check      read and validate only
     node tools/mlb/import_offense.js --dry-run    everything but the write
     node tools/mlb/import_offense.js --commit     stage and promote
     node tools/mlb/import_offense.js --commit --provisional 2026
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const P = require('../lib/pgrest.js');
const { SCHEMA, reportFailure } = require('./db.js');
const D = require('./offense_dataset.js');
const M = require('../../lib/mlb_offense_history.js');

const ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_DIR = path.join(ROOT, 'mlb', 'batters', 'snapshots');

/* The staging tables, in the order they are written. Nothing depends on the
   order — staging has no foreign keys — but a stable one makes a partial run
   readable in the ledger. */
const TABLES = ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
  'observed_batter_team_runs', 'team_offense_seasons', 'team_offense_overview',
  'league_offense_seasons', 'offense_validation', 'offense_source_repairs',
  'offense_games_reconciliation'];

/* The build_report key each staged table's count is checked against by the
   gate. The names differ because the package's table names and the schema's
   are not identical, and the gate compares what the package CLAIMED with what
   actually landed. */
const EXPECTED_KEYS = {
  batter_seasons: 'batter_seasons',
  batter_team_seasons: 'batter_team_seasons',
  batter_overview: 'batter_overview',
  batter_team_history: 'batter_team_history',
  observed_batter_team_runs: 'observed_team_runs',
  team_offense_seasons: 'team_offense_seasons',
  team_offense_overview: 'team_offense_overview',
  league_offense_seasons: 'league_seasons'
};

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }

function makeImportId(coverage) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  return `mlboff-${coverage.start}-${coverage.end}-${stamp}`;
}

/* ---- shaping the package's rows into the schema's rows ------------------ */

const COUNT_COLS = ['games', 'plate_appearances', 'at_bats', 'runs', 'hits', 'singles', 'doubles',
  'triples', 'home_runs', 'rbi', 'walks', 'intentional_walks', 'strikeouts', 'hit_by_pitch',
  'stolen_bases', 'caught_stealing', 'total_bases', 'sacrifice_bunts', 'sacrifice_flies',
  'grounded_into_double_play', 'catcher_interference', 'pitches_seen'];
const RATE_COLS = ['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'k_pct', 'bb_pct', 'hr_pct',
  'sb_success_pct', 'sample_flag'];
const WINDOW_COLS = ['first_observed_season', 'last_observed_season', 'seasons_with_records',
  'observed_seasons', 'boundary_start', 'boundary_end', 'rated_plate_appearances',
  'weighted_offensive_index'];

function pick(src, cols) {
  const o = {};
  cols.forEach((c) => { o[c] = src[c] === undefined ? null : src[c]; });
  return o;
}
/* seasons_with_PA in the package, seasons_with_pa in PostgreSQL. Renamed at
   exactly one place so no query has to remember. */
function withWindow(src) {
  const o = pick(src, WINDOW_COLS);
  o.seasons_with_pa = src.seasons_with_PA === undefined ? null : src.seasons_with_PA;
  return o;
}
function isProvisional(season, provisional) {
  return (provisional || []).indexOf(Number(season)) >= 0;
}

/**
 * Turn the loaded package into the rows the schema takes.
 *
 * THE ONE PLACE THE IMPORTER ADDS ANYTHING. Every addition is listed in
 * offense_dataset.TRANSFORMATIONS and written onto the import run, so an
 * auditor can see every field where the live table and the shipped file differ
 * and check the reasoning.
 */
function prepareRows(ds) {
  const T = ds.tables;
  const prov = ds.provisional_seasons || [];
  const rows = {};

  /* The club list for the overview grain, rebuilt from the team grain IN THE
     SAME PACKAGE. batter_overview ships teams blank and team_count zero on all
     3,097 rows; batter_team_history carries the clubs correctly. Ordered by
     plate appearances so the club a hitter actually played for leads. */
  const clubsBy = Object.create(null);
  T.batter_team_history.forEach((r) => {
    (clubsBy[r.player_id] = clubsBy[r.player_id] || []).push({
      team_id: r.team_id,
      name: r.team_names_observed || '',
      pa: r.plate_appearances == null ? 0 : r.plate_appearances
    });
  });
  Object.keys(clubsBy).forEach((k) => { clubsBy[k].sort((a, b) => b.pa - a.pa); });

  rows.batter_seasons = T.batter_seasons.map((r) => Object.assign({
    player_id: r.player_id, season: r.season,
    player_name: r.player_name, name_key: M.nameKey(r.player_name),
    age: r.age, position_reported: r.position_reported,
    team_count: r.team_count, team_ids: M.parseIdList(r.team_ids), teams: r.teams,
    team_split_games_sum: r.team_split_games_sum
  }, pick(r, COUNT_COLS), pick(r, RATE_COLS), {
    league_obp: r.league_obp, league_slg: r.league_slg,
    rating_sample_weight: r.rating_sample_weight,
    rating_version: r.rating_version || M.RATING_VERSION,
    offensive_index: r.offensive_index,
    provisional: isProvisional(r.season, prov)
  }));

  rows.batter_team_seasons = T.batter_team_seasons.map((r) => Object.assign({
    player_id: r.player_id, season: r.season, team_id: r.team_id,
    player_name: r.player_name, name_key: M.nameKey(r.player_name),
    team_name: r.team_name, position_reported: r.position_reported, age: r.age
  }, pick(r, COUNT_COLS), pick(r, RATE_COLS), {
    league_obp: r.league_obp, league_slg: r.league_slg,
    rating_sample_weight: r.rating_sample_weight,
    rating_version: r.rating_version || M.RATING_VERSION,
    offensive_index: r.offensive_index,
    provisional: isProvisional(r.season, prov)
  }));

  rows.batter_overview = T.batter_overview.map((r) => {
    const clubs = clubsBy[r.player_id] || [];
    return Object.assign({
      player_id: r.player_id, player_name: r.player_name, name_key: M.nameKey(r.player_name)
    }, pick(r, COUNT_COLS), pick(r, RATE_COLS), withWindow(r), {
      /* DERIVED — see TRANSFORMATIONS. The package ships both blank. */
      team_count: clubs.length,
      teams: clubs.map((c) => c.name).filter(Boolean).join('; '),
      latest_observed_offensive_index: r.latest_observed_offensive_index,
      best_season_by_index: r.best_season_by_index,
      rating_version: M.RATING_VERSION
    });
  });

  rows.batter_team_history = T.batter_team_history.map((r) => Object.assign({
    player_id: r.player_id, team_id: r.team_id,
    player_name: r.player_name, name_key: M.nameKey(r.player_name)
  }, pick(r, COUNT_COLS), pick(r, RATE_COLS), withWindow(r), {
    team_names_observed: r.team_names_observed,
    rating_version: M.RATING_VERSION
  }));

  rows.observed_batter_team_runs = T.observed_team_runs.map((r) => Object.assign({
    player_id: r.player_id, team_id: r.team_id, observed_run_number: r.observed_run_number,
    player_name: r.player_name, name_key: M.nameKey(r.player_name)
  }, pick(r, COUNT_COLS), pick(r, RATE_COLS), withWindow(r), {
    team_names_observed: r.team_names_observed
  }));

  /* A club-season has no `games` column of its own: it has team_games (the
     club's actual games) and player_games_sum (which is not that). Dropping
     `games` here is what keeps the two from ever being confused downstream. */
  rows.team_offense_seasons = T.team_offense_seasons.map((r) => {
    const c = pick(r, COUNT_COLS); delete c.games;
    return Object.assign({ season: r.season, team_id: r.team_id, team_name: r.team_name },
      c, pick(r, RATE_COLS), {
        league_obp: r.league_obp, league_slg: r.league_slg,
        rating_sample_weight: r.rating_sample_weight,
        rating_version: r.rating_version || M.RATING_VERSION,
        offensive_index: r.offensive_index,
        player_games_sum: r.player_games_sum, players_with_records: r.players_with_records,
        team_games: r.team_games, runs_per_game: r.runs_per_game,
        team_totals_source_url: r.team_totals_source_url,
        provisional: isProvisional(r.season, prov)
      });
  });

  rows.team_offense_overview = T.team_offense_overview.map((r) => {
    const c = pick(r, COUNT_COLS); delete c.games;
    return Object.assign({ team_id: r.team_id }, c, pick(r, RATE_COLS), withWindow(r), {
      team_names_observed: r.team_names_observed,
      player_games_sum: r.player_games_sum, team_games: r.team_games,
      runs_per_game: r.runs_per_game, rating_version: M.RATING_VERSION
    });
  });

  rows.league_offense_seasons = T.league_seasons.map((r) => {
    const c = pick(r, COUNT_COLS); delete c.games;
    return Object.assign({ season: r.season }, c, pick(r, RATE_COLS), {
      player_games_sum: r.player_games_sum,
      provisional: isProvisional(r.season, prov)
    });
  });

  rows.offense_validation = ds.validation.map((v) => ({
    season: v.season, teams: v.teams, players: v.players,
    player_team_rows: v.player_team_rows,
    counting_fields_reconciled: v.counting_fields_reconciled,
    player_totals_reconcile: v.player_totals_reconcile === true,
    team_totals_reconcile: v.team_totals_reconcile === true
  }));

  rows.offense_source_repairs = (ds.repairs || []).map((r) => ({
    season: Number(r.season), player_id: Number(r.player_id),
    previous_team_rows: r.previous_team_rows == null ? null : Number(r.previous_team_rows),
    replacement_team_rows: r.replacement_team_rows == null ? null : Number(r.replacement_team_rows),
    source_url: r.source_url || null
  }));

  rows.offense_games_reconciliation = (ds.games_reconciliation || []).map((r) => ({
    season: Number(r.season), player_id: Number(r.player_id),
    official_games: r.official_games == null ? null : Number(r.official_games),
    team_split_games_sum: r.team_split_games_sum == null ? null : Number(r.team_split_games_sum)
  }));

  return rows;
}

/* ---- the import --------------------------------------------------------- */

async function runImport(db, ds, verdict, o) {
  o = o || {};
  const log = o.log || console.log;
  const importId = o.importId || makeImportId(ds.coverage);
  const ledger = o.ledger || null;
  const rows = o.rows || prepareRows(ds);

  const expected = {};
  Object.keys(EXPECTED_KEYS).forEach((t) => {
    const key = EXPECTED_KEYS[t];
    const want = ds.report && ds.report.tables ? ds.report.tables[key] : null;
    if (want != null) expected[key] = Number(want);
  });

  const runRow = {
    import_id: importId,
    dataset: 'offense',
    status: 'staging',
    coverage_start: ds.coverage.start,
    coverage_end: ds.coverage.end,
    provisional_seasons: ds.provisional_seasons || [],
    rating_version: ds.rating_version,
    dataset_built_at: (ds.report && ds.report.built_at_utc) || null,
    source: M.SOURCE,
    source_manifest_sha: D.manifestFingerprint(ds.manifest),
    expected_counts: expected,
    validation: {
      package: (ds.report && ds.report.validation) || null,
      independent: {
        ok: verdict.ok,
        checks: verdict.checks,
        problems: verdict.problems
      },
      per_season: (ds.validation || []).map((v) => ({
        season: v.season, teams: v.teams, players: v.players,
        player_team_rows: v.player_team_rows,
        players_reconciled: v.player_totals_reconcile === true,
        teams_reconciled: v.team_totals_reconcile === true
      }))
    },
    source_repairs: (ds.repairs || []).length,
    transformations: ds.transformations,
    github_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
  };

  await db.upsert(SCHEMA, 'import_runs', [runRow], 'import_id', { returning: false });
  log(`[offense] opened ${importId}`);
  if (ledger) await ledger.beat({ details: { import_id: importId, stage: 'staging' } });

  /* THE IMPORT ID IS STAMPED HERE, at the point of the write, not by whoever
     built the rows. Every staged row and every promote/cleanup query is keyed
     on it, so a row that reached staging without one would be invisible to its
     own promotion — the gate would read an empty import and refuse it,
     correctly, for entirely the wrong reason. */
  const staged = {};
  for (const t of TABLES) {
    const list = (rows[t] || []).map((r) => (r.import_id === importId ? r : Object.assign({}, r, { import_id: importId })));
    if (!list.length) { staged[t] = 0; continue; }
    await db.del(SCHEMA, 'stg_' + t, `import_id=eq.${encodeURIComponent(importId)}`);
    const chunk = o.chunk || 500;
    for (let i = 0; i < list.length; i += chunk) {
      await db.insert(SCHEMA, 'stg_' + t, list.slice(i, i + chunk), { returning: false });
    }
    staged[t] = list.length;
    log(`[offense]   staged ${t}: ${list.length}`);
    if (ledger) await ledger.beat({ details: { import_id: importId, stage: 'staging', table: t, rows: list.length } });
  }

  await db.patch(SCHEMA, 'import_runs', `import_id=eq.${encodeURIComponent(importId)}`,
    { status: 'validated', staged_counts: staged });

  log('[offense] promoting…');
  const res = await db.rpc(SCHEMA, 'promote_offense_import', { p_import_id: importId });
  const out = Array.isArray(res) ? res[0] : res;
  if (!out || out.ok !== true) {
    const code = (out && out.code) || 'PROMOTE_REFUSED';
    const detail = out ? JSON.stringify(out) : 'the promote gate returned nothing';
    throw Object.assign(new Error(`the offensive promote gate refused this import (${code}): ${detail}`),
      { promote: out, code });
  }

  await P.writeMeta(db, SCHEMA, {
    import_offense_last_run: new Date().toISOString(),
    import_offense_last_status: 'ok',
    import_offense_last_id: importId,
    offense_coverage_start: String(ds.coverage.start),
    offense_coverage_end: String(ds.coverage.end),
    offense_provisional_seasons: (ds.provisional_seasons || []).join(',')
  });

  return { import_id: importId, staged, promote: out };
}

/* A dated record of what was published. This is what makes an honest backtest
   possible later: "what did EdgeDesk hold on this date" has an answer that is
   not "whatever the current table says". */
function writeSnapshot(ds, verdict, result) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(SNAPSHOT_DIR, `${day}.json`);
  const body = {
    snapshot_date: day,
    dataset: 'offense',
    import_id: result.import_id,
    coverage: ds.coverage,
    provisional_seasons: ds.provisional_seasons || [],
    rating_version: ds.rating_version,
    dataset_built_at: (ds.report && ds.report.built_at_utc) || null,
    source: M.SOURCE,
    source_manifest_sha: D.manifestFingerprint(ds.manifest),
    rows: result.staged,
    package_validation: (ds.report && ds.report.validation) || null,
    independent_validation: { ok: verdict.ok, checks: verdict.checks, problems: verdict.problems },
    transformations: ds.transformations,
    note: 'A manifest of what was promoted, not a copy of the data. The data is the dataset directory, '
      + 'whose own build time and source fingerprint are recorded here.'
  };
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

/* The browser caches the coverage status for five minutes of its own accord
   and the edge function caches per isolate, so this bumps a version key the
   readers include in their cache key rather than pretending to reach into
   either. */
async function invalidateCaches(db, importId, log) {
  try {
    await P.writeMeta(db, SCHEMA, {
      offense_cache_version: String(Date.now()),
      offense_cache_reason: 'promoted ' + importId
    });
    if (log) log('[offense] cache version bumped');
  } catch (e) {
    if (log) log('[offense] could not bump the cache version: ' + e.message);
  }
}

async function main() {
  const dir = arg('dir', D.DEFAULT_DIR);
  const provisional = String(arg('provisional', '') || '').split(',')
    .map((s) => Number(String(s).trim())).filter((n) => isFinite(n) && n > 1900);
  const commit = flag('commit');
  const dryRun = flag('dry-run');
  const checkOnly = flag('check') || (!commit && !dryRun);

  let ds;
  try {
    ds = D.loadDataset(dir, { provisionalSeasons: provisional });
  } catch (e) {
    console.log('FAIL | offense import | could not read the dataset: ' + e.message);
    process.exit(1);
  }

  const verdict = D.validateDataset(ds);
  const c = verdict.checks;
  console.log(`MLB offensive dataset ${ds.coverage.start}–${ds.coverage.end} (${ds.rating_version})`);
  console.log(`  ${c.count_batter_seasons} batter-seasons · ${c.count_batter_team_seasons} player-team-seasons `
    + `· ${c.batters} batters (${c.batters_with_pa} with a PA) · ${c.club_seasons} club-seasons`);
  if (provisional.length) console.log(`  provisional: ${provisional.join(', ')}`);
  if (!verdict.ok) {
    console.log(`\nFAIL | offense import | the dataset did not validate (${verdict.problems.length} problem(s))`);
    verdict.problems.slice(0, 20).forEach((p) => console.log('  ✗ ' + p.code + ' — ' + p.detail));
    console.log('\nNothing was written. The live archive is exactly as it was.');
    process.exit(1);
  }
  console.log('  validation: every rate and rating re-derived, both grains agree, package reconciliation passed');

  const rows = prepareRows(ds);
  const total = TABLES.reduce((a, t) => a + (rows[t] || []).length, 0);
  console.log(`  prepared ${total} rows across ${TABLES.length} tables`);

  if (checkOnly) {
    console.log('\nPASS | offense import | --check only, nothing was written');
    return;
  }
  if (dryRun) {
    TABLES.forEach((t) => console.log(`  would stage ${t}: ${(rows[t] || []).length}`));
    console.log('\nPASS | offense import | --dry-run, nothing was written');
    return;
  }

  let db;
  try { db = P.client(); }
  catch (e) {
    console.log('FAIL | offense import | ' + e.message);
    console.log('Set EDGD_SB_URL and EDGD_SB_SERVICE to the project url and its service role key.');
    process.exit(1);
  }

  const ledger = P.runLedger ? P.runLedger(db, SCHEMA, 'import_offense') : null;
  try {
    if (ledger) await ledger.start();
    const result = await runImport(db, ds, verdict, { rows, ledger });
    const snap = writeSnapshot(ds, verdict, result);
    await invalidateCaches(db, result.import_id, console.log);
    if (ledger) await ledger.finish({ ok: true, details: { import_id: result.import_id, rows: result.staged } });
    console.log(`\nPASS | offense import | promoted ${result.import_id}`);
    console.log('  snapshot ' + path.relative(ROOT, snap));
  } catch (e) {
    try {
      await db.rpc(SCHEMA, 'abandon_offense_import',
        { p_import_id: e.import_id || 'unknown', p_reason: String(e.message).slice(0, 400) });
    } catch (_) { /* the abandon is best effort; nothing live was touched either way */ }
    try {
      await P.writeMeta(db, SCHEMA, {
        import_offense_last_run: new Date().toISOString(),
        import_offense_last_status: 'FAILED'
      });
    } catch (_) { /* the ledger write is best effort */ }
    if (ledger) { try { await ledger.finish({ ok: false, error: e.message }); } catch (_) { /* best effort */ } }
    reportFailure('offense import', e);
    console.log('\nThe previously promoted offensive dataset is still live and being served.');
    process.exit(1);
  }
}

module.exports = { runImport, prepareRows, writeSnapshot, invalidateCaches, makeImportId,
  TABLES, EXPECTED_KEYS, SNAPSHOT_DIR };

if (require.main === module) {
  main().catch((e) => { reportFailure('offense import', e); process.exit(1); });
}
