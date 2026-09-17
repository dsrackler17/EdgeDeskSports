#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the refresh: rebuild the OFFENSIVE dataset, then import it.

   The packaged updater (mlb/batters/build_dataset.py, Python 3 standard
   library only) wired into EdgeDesk's own ingestion path. One command, five
   steps, and the same rule at every one of them: the archive already on file
   is not touched until its replacement has earned the swap.

     1. build     run the updater into a STAGING directory, never over the
                  committed dataset. A build that fails leaves the committed
                  copy and the live tables exactly as they were.
     2. check     re-derive the numbers (tools/mlb/offense_dataset.js): keys,
                  counts, every rate from its own counting fields, the ratings
                  under ED_BAT_PERF_V1, the total-base identities, the annual
                  baselines, the two player grains against each other, the club
                  rows against their own games, nulls preserved, repairs
                  intact. A refusal here stops the run with the previous
                  dataset untouched.
     3. import    stage into mlbhist.stg_*, then
                  mlbhist.promote_offense_import() — one transaction that
                  checks the staged counts against the package's own and
                  refuses a short, duplicated, unreconciled or grain-violating
                  dataset (tools/mlb/import_offense.js).
     4. record    provenance into mlbhist.import_runs, freshness into
                  mlbhist.meta (which invalidates the readers' coverage), and a
                  DATED SNAPSHOT into mlb/batters/snapshots so a later
                  evaluation can say what the archive held on a given day.
     5. publish   optionally refresh the committed dataset so the repository's
                  copy matches what was promoted, gzipped as it is committed.

   PROVISIONAL BY DEFAULT. A season whose regular season has not finished is
   flagged provisional on every row it writes, so a partial year can never be
   read as a finished one — and here that matters more than it does for
   pitching, because the LEAGUE BASELINE moves too, and every rating in the
   archive is computed against it.

     node tools/mlb/refresh_offense.js --check          rebuild and validate only
     node tools/mlb/refresh_offense.js --commit         rebuild, validate, import
     node tools/mlb/refresh_offense.js --commit --through 2026
     node tools/mlb/refresh_offense.js --commit --publish-dataset
     node tools/mlb/refresh_offense.js --commit --from-dir <dir>   skip the build
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const P = require('../lib/pgrest.js');
const { SCHEMA, reportFailure } = require('./db.js');
const D = require('./offense_dataset.js');
const IMPORT = require('./import_offense.js');
const M = require('../../lib/mlb_offense_history.js');

const ROOT = path.join(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'mlb', 'batters', 'build_dataset.py');
const COMMITTED = path.join(ROOT, 'mlb', 'batters', 'dataset');
const STAGING = path.join(ROOT, 'mlb', 'batters', '.staging');

/* The CSVs the committed copy carries gzipped, and the metadata it carries as
   it comes. `raw/` is deliberately NOT committed: source snapshots whose urls,
   times and hashes are already in source_manifest.json. teams.csv is not
   committed either — it is identical to the pitching archive's and one
   identity table serves both. */
const GZ = ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
  'observed_team_runs', 'team_offense_seasons', 'team_offense_overview', 'league_seasons'];
const PLAIN = ['validation.csv', 'build_report.json', 'data_dictionary.json', 'source_repairs.json',
  'games_reconciliation_notes.json', 'example_queries.sql'];

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }
function etYear() {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric' }).format(new Date()));
}

/**
 * Which seasons in this dataset are not finished.
 *
 * MLB's regular season runs inside one calendar year, so a season equal to the
 * current year is still in progress or has only just ended. Erring toward
 * provisional costs a label; erring the other way publishes a partial season
 * as a finished one — and for this archive that would also publish a moving
 * league baseline as a settled one.
 */
function provisionalSeasons(coverageEnd, opts) {
  opts = opts || {};
  if (opts.final) return [];
  const now = opts.year != null ? Number(opts.year) : etYear();
  return Number(coverageEnd) >= now ? [Number(coverageEnd)] : [];
}

/** Run the packaged updater into a staging directory. Never over the committed copy. */
function build(o) {
  o = o || {};
  const out = o.out;
  fs.mkdirSync(out, { recursive: true });
  const python = o.python || process.env.PYTHON || 'python3';
  const args = [BUILDER, '--start', String(o.start), '--end', String(o.end), '--output', out];
  if (o.refresh !== false) args.push('--refresh');
  const log = o.log || console.log;
  log(`[offense-refresh] ${python} ${args.slice(1).join(' ')}`);
  const t0 = Date.now();
  const r = cp.spawnSync(python, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: o.timeoutMs || 55 * 60_000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  (r.stdout || '').split('\n').filter(Boolean).slice(-6).forEach((l) => log('[builder] ' + l));
  if (r.status !== 0) {
    const why = r.error ? String(r.error.message) : (r.stderr || '').trim().split('\n').slice(-6).join(' | ');
    return { ok: false, seconds: Number(secs), error: `the updater exited ${r.status}: ${why}`.slice(0, 600) };
  }
  /* The updater refuses to export tables when a season fails its own
     reconciliation, so a zero exit with no build report is a build that did not
     get that far. Checked rather than assumed. */
  const report = path.join(out, 'build_report.json');
  if (!fs.existsSync(report)) {
    return { ok: false, seconds: Number(secs), error: 'the updater exited 0 but wrote no build_report.json' };
  }
  return { ok: true, seconds: Number(secs), report: JSON.parse(fs.readFileSync(report, 'utf8')) };
}

/** Copy a freshly built dataset over the committed one, gzipping the CSVs. */
function publishDataset(from, log) {
  fs.mkdirSync(COMMITTED, { recursive: true });
  const written = [];
  GZ.forEach((n) => {
    const src = path.join(from, n + '.csv');
    if (!fs.existsSync(src)) throw new Error(`the build produced no ${n}.csv`);
    fs.writeFileSync(path.join(COMMITTED, n + '.csv.gz'), zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
    written.push(n + '.csv.gz');
  });
  PLAIN.forEach((n) => {
    const src = path.join(from, n);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(COMMITTED, n)); written.push(n); }
  });
  const man = path.join(from, 'source_manifest.json');
  if (fs.existsSync(man)) {
    fs.writeFileSync(path.join(COMMITTED, 'source_manifest.json.gz'), zlib.gzipSync(fs.readFileSync(man), { level: 9 }));
    written.push('source_manifest.json.gz');
  }
  const rm = path.join(from, 'README.md');
  if (fs.existsSync(rm)) { fs.copyFileSync(rm, path.join(COMMITTED, 'DATASET_README.md')); written.push('DATASET_README.md'); }
  /* teams.csv is NOT published here on purpose: the two archives share one
     identity table and the pitching refresh owns it. Publishing a second copy
     would be the first step toward them disagreeing. */
  log(`[offense-refresh] committed dataset refreshed: ${written.length} files`);
  return written;
}

async function main() {
  const check = flag('check');
  const commit = flag('commit');
  const publish = flag('publish-dataset');
  const final = flag('final');
  const fromDir = arg('from-dir', null);
  const start = Number(arg('from', 2016));
  const end = Number(arg('through', etYear()));
  const day = new Date().toISOString().slice(0, 10);
  const out = fromDir || path.join(STAGING, day);
  const log = console.log;

  if (!check && !commit) {
    console.log('Nothing to do. Pass --check (rebuild and validate) or --commit (rebuild, validate, import).');
    process.exit(0);
  }

  let db = null, ledger = null;
  if (commit) {
    try { db = P.client(); } catch (e) {
      console.log('FAIL | offense refresh | ' + e.message);
      console.log('Set EDGD_SB_URL and EDGD_SB_SERVICE to the project url and its service role key.');
      process.exit(1);
    }
    ledger = P.runLedger ? P.runLedger(db, SCHEMA, 'refresh_offense') : null;
    if (ledger) { try { await ledger.start(); } catch (_) { /* the heartbeat is best effort */ } }
  }

  /* A helper so every exit path writes the same operator-visible ledger. The
     freshness line on the panel reads these keys, so a run that failed shows
     as failed rather than leaving rows on screen that still look fine. */
  async function fail(stage, message) {
    console.log(`FAIL | offense refresh | ${stage}: ${message}`);
    if (db) {
      try {
        await P.writeMeta(db, SCHEMA, {
          refresh_offense_last_run: new Date().toISOString(),
          refresh_offense_last_status: 'FAILED',
          refresh_offense_last_error: String(message).slice(0, 400),
          refresh_offense_last_stage: stage
        });
      } catch (_) { /* best effort */ }
      if (ledger) { try { await ledger.finish({ ok: false, error: `${stage}: ${message}`.slice(0, 400) }); } catch (_) { /* best effort */ } }
    }
    console.log('The previously promoted offensive dataset is still live and being served.');
    process.exit(1);
  }

  /* ---- 1. build ---------------------------------------------------------- */
  if (!fromDir) {
    if (!fs.existsSync(BUILDER)) await fail('build', `the packaged updater is missing at ${path.relative(ROOT, BUILDER)}`);
    const b = build({ start, end, out, log });
    if (!b.ok) await fail('build', b.error);
    log(`[offense-refresh] built ${start}–${end} in ${b.seconds}s`);
  } else {
    log(`[offense-refresh] using an existing build at ${path.relative(ROOT, out)}`);
  }

  /* ---- 2. check ---------------------------------------------------------- */
  let ds, verdict;
  try {
    const prov = provisionalSeasons(end, { final });
    ds = D.loadDataset(out, { provisionalSeasons: prov });
    verdict = D.validateDataset(ds);
  } catch (e) {
    await fail('check', `the built dataset could not be read — ${e.message}`);
  }
  const c = verdict.checks;
  log(`[offense-refresh] ${c.count_batter_seasons} batter-seasons, ${c.count_batter_team_seasons} player-team rows, `
    + `${c.batters} hitters (${c.batters_with_pa} with a PA), ${c.club_seasons} club-seasons`);
  if (ds.provisional_seasons.length) {
    log(`[offense-refresh] PROVISIONAL: ${ds.provisional_seasons.join(', ')} — the regular season has not `
      + 'finished, so the league baseline and every rating computed against it will still move');
  }
  if (!verdict.ok) {
    await fail('check', `${verdict.problems.length} problem(s): `
      + verdict.problems.slice(0, 4).map((p) => p.code + ' ' + p.detail).join('; '));
  }
  log('[offense-refresh] validation: every rate and rating re-derived, both grains agree, package reconciliation passed');

  if (check && !commit) {
    console.log('\nPASS | offense refresh | --check only, nothing was written');
    return;
  }

  /* ---- 3. import --------------------------------------------------------- */
  let result;
  try {
    result = await IMPORT.runImport(db, ds, verdict, { log, chunk: 1000, ledger });
  } catch (e) {
    await fail('import', e.message);
  }

  /* ---- 4. record --------------------------------------------------------- */
  let snap = null;
  try { snap = IMPORT.writeSnapshot(ds, verdict, result); } catch (e) { log('[offense-refresh] snapshot failed: ' + e.message); }
  try { await IMPORT.invalidateCaches(db, result.import_id, log); } catch (_) { /* best effort */ }
  try {
    await P.writeMeta(db, SCHEMA, {
      refresh_offense_last_run: new Date().toISOString(),
      refresh_offense_last_status: 'ok',
      refresh_offense_last_id: result.import_id,
      refresh_offense_last_error: '',
      refresh_offense_last_stage: 'done'
    });
  } catch (_) { /* best effort */ }
  if (ledger) { try { await ledger.finish({ ok: true, details: { import_id: result.import_id, rows: result.staged } }); } catch (_) { /* best effort */ } }

  /* ---- 5. publish -------------------------------------------------------- */
  if (publish && !fromDir) {
    try { publishDataset(out, log); }
    catch (e) { log('[offense-refresh] the committed dataset was NOT refreshed: ' + e.message); }
  }

  console.log(`\nPASS | offense refresh | promoted ${result.import_id}`);
  if (snap) console.log('  snapshot ' + path.relative(ROOT, snap));
}

module.exports = { build, publishDataset, provisionalSeasons, STAGING, COMMITTED, GZ, PLAIN, BUILDER };

if (require.main === module) {
  main().catch((e) => { reportFailure('offense refresh', e); process.exit(1); });
}
