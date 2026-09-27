#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the refresh: rebuild the pitching dataset, then import it.

   This is the packaged updater (mlb/pitchers/build_dataset.py, Python 3
   standard library only) wired into EdgeDesk's own ingestion path. One
   command, five steps, and a rule at every one of them: the archive already on
   file is not touched until its replacement has earned the swap.

     1. build     run the updater into a STAGING directory, never over the
                  committed dataset. A build that fails leaves the committed
                  copy and the live tables exactly as they were.
     2. check     re-derive the numbers (tools/mlb/dataset.js): keys, counts,
                  innings from outs, the two grains summing, every rate, the
                  ratings under ED_PITCH_PERF_V1, the annual baselines, nulls
                  preserved, repairs intact. A refusal here stops the run with
                  the previous dataset untouched.
     3. import    stage into mlbhist.stg_*, then mlbhist.promote_import() —
                  one transaction that checks the staged counts against the
                  package's own and refuses a short, duplicated or
                  unreconciled dataset (tools/mlb/import_pitcher_history.js).
     4. record    provenance into mlbhist.import_runs, freshness into
                  mlbhist.meta (which invalidates the readers' coverage), and
                  a DATED SNAPSHOT into mlb/pitchers/snapshots so a later
                  evaluation can say what the archive held on a given day.
     5. publish   optionally refresh the committed dataset so the repository's
                  copy matches what was promoted, gzipped as it is committed.

   PROVISIONAL BY DEFAULT. A season whose regular season has not finished is
   flagged provisional on every row, so a partial year can never be read as a
   finished one and the ratings that will move are marked as ratings that will
   move. The end season is treated as provisional whenever it is the current
   calendar year, unless --final says otherwise.

     node tools/mlb/refresh_dataset.js --check          rebuild and validate only
     node tools/mlb/refresh_dataset.js --commit         rebuild, validate, import
     node tools/mlb/refresh_dataset.js --commit --through 2026
     node tools/mlb/refresh_dataset.js --commit --publish-dataset
     node tools/mlb/refresh_dataset.js --commit --from-dir <dir>   skip the build
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');

const P = require('../lib/pgrest.js');
const { SCHEMA, reportFailure } = require('./db.js');
const D = require('./dataset.js');
const IMPORT = require('./import_pitcher_history.js');

const ROOT = path.join(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'mlb', 'pitchers', 'build_dataset.py');
const COMMITTED = path.join(ROOT, 'mlb', 'pitchers', 'dataset');
const STAGING = path.join(ROOT, 'mlb', 'pitchers', '.staging');

/* The CSVs the committed copy carries gzipped, and the metadata it carries as
   it comes. `raw/` is deliberately NOT committed: 28MB of source snapshots
   whose urls, times and hashes are already in source_manifest.json. */
const GZ = ['league_seasons', 'observed_team_runs', 'pitcher_overview', 'pitcher_seasons',
  'pitcher_team_history', 'pitcher_team_seasons', 'teams'];
const PLAIN = ['validation.csv', 'build_report.json', 'data_dictionary.json', 'source_repairs.json', 'example_queries.sql'];

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
 * The honest rule is a calendar one: MLB's regular season runs inside a single
 * calendar year, so a season equal to the current year is still in progress or
 * has only just ended, and anything earlier is complete. Erring toward
 * provisional costs a label; erring the other way publishes a partial season
 * as a finished one.
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
  log(`[refresh] ${python} ${args.slice(1).join(' ')}`);
  const t0 = Date.now();
  const r = cp.spawnSync(python, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: o.timeoutMs || 55 * 60_000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  (r.stdout || '').split('\n').filter(Boolean).slice(-6).forEach(l => log('[builder] ' + l));
  if (r.status !== 0) {
    const why = r.error ? String(r.error.message) : (r.stderr || '').trim().split('\n').slice(-6).join(' | ');
    return { ok: false, seconds: Number(secs), error: `the updater exited ${r.status}: ${why}`.slice(0, 600) };
  }
  /* The updater refuses to publish tables when team splits disagree with MLB's
     own player totals, so a zero exit with no build report is a build that did
     not get that far. Checked rather than assumed. */
  const report = path.join(out, 'build_report.json');
  if (!fs.existsSync(report)) return { ok: false, seconds: Number(secs), error: 'the updater exited 0 but wrote no build_report.json' };
  return { ok: true, seconds: Number(secs), report: JSON.parse(fs.readFileSync(report, 'utf8')) };
}

/** Copy a freshly built dataset over the committed one, gzipping the CSVs. */
function publishDataset(from, log) {
  fs.mkdirSync(COMMITTED, { recursive: true });
  const written = [];
  GZ.forEach(n => {
    const src = path.join(from, n + '.csv');
    if (!fs.existsSync(src)) throw new Error(`the build produced no ${n}.csv`);
    fs.writeFileSync(path.join(COMMITTED, n + '.csv.gz'), zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
    written.push(n + '.csv.gz');
  });
  PLAIN.forEach(n => {
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
  log(`[refresh] committed dataset refreshed: ${written.length} files`);
  return written;
}

async function main() {
  const check = flag('check');
  const commit = flag('commit');
  const publish = flag('publish-dataset');
  const fromDir = arg('from-dir', null);
  const start = Number(arg('from', 2016));
  const through = Number(arg('through', etYear()));
  const final = flag('final');

  const out = fromDir || path.join(STAGING, new Date().toISOString().slice(0, 10));
  let built = null;
  if (!fromDir) {
    built = build({ start, end: through, out });
    if (!built.ok) {
      console.error(`::error::the MLB dataset rebuild failed after ${built.seconds}s — ${built.error}`);
      console.error('::error::nothing was imported. The archive already on file is unchanged, and remains the one being served.');
      /* An operator needs the failure ON THE LEDGER, not only in a log that
         expires: the readers' freshness line is how a stalled pipeline becomes
         visible on the screen rather than at the next question. */
      const cfg0 = P.config();
      if (cfg0) {
        try {
          await P.writeMeta(P.client(cfg0), SCHEMA, {
            refresh_last_run: new Date().toISOString(), refresh_last_status: 'error',
            refresh_last_message: built.error.slice(0, 300)
          });
        } catch (_) { /* best effort */ }
      }
      process.exit(1);
    }
    console.log(`[refresh] the updater finished in ${built.seconds}s`);
  } else {
    console.log(`[refresh] using the dataset already at ${out} (no rebuild)`);
  }

  const prov = provisionalSeasons(through, { final });
  if (prov.length) console.log(`[refresh] ${prov.join(', ')} marked PROVISIONAL — the regular season is not complete, so those ratings will change`);

  let ds;
  try { ds = D.loadDataset(out, { provisionalSeasons: prov }); }
  catch (e) { console.error(`::error::the rebuilt dataset could not be read: ${e.message}`); process.exit(1); }

  const verdict = D.validateDataset(ds);
  verdict.checks.forEach(c => console.log(`[check] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`));
  if (!verdict.ok) {
    console.error(`::error::the rebuilt dataset did not validate (${verdict.summary}). Nothing was imported; the archive on file is unchanged.`);
    verdict.problems.forEach(p => console.error(`  ${p.code}: ${p.detail}`));
    process.exit(1);
  }
  console.log(`[check] ALL GREEN ${verdict.summary}`);
  console.log(`[refresh] coverage ${ds.coverage.start}–${ds.coverage.end}; `
    + Object.keys(ds.counts).map(k => `${k}=${ds.counts[k]}`).join(', '));

  if (check) { console.log('[refresh] --check: built and validated, nothing imported.'); return; }

  const cfg = P.config();
  if (!cfg) {
    if (commit) { console.error('::error::EDGD_SB_SERVICE and EDGD_SB_URL are not both set — nothing can be imported.'); process.exit(1); }
    console.log('[refresh] no database credentials; the rebuild was validated and not imported.');
    if (publish) publishDataset(out, console.log);
    return;
  }
  if (!commit) {
    console.log('[refresh] credentials present but --commit was not passed. Nothing imported.');
    return;
  }

  const db = P.client(cfg);
  const ledger = P.runLedger(db, SCHEMA, 'refresh_pitcher_history', { scope: `${ds.coverage.start}-${ds.coverage.end}` });
  await ledger.start({ source: fromDir ? 'existing directory' : 'build_dataset.py', counts: ds.counts, provisional: prov });

  let result = null;
  try {
    result = await IMPORT.runImport(db, ds, verdict, { ledger });
  } catch (e) {
    reportFailure('refresh_pitcher_history', e);
    await ledger.finish('failed', String(e.message).slice(0, 500));
    try {
      await P.writeMeta(db, SCHEMA, {
        refresh_last_run: new Date().toISOString(), refresh_last_status: 'error',
        refresh_last_message: String(e.message).slice(0, 300)
      });
    } catch (_) { /* best effort */ }
    console.error(`::error::the import failed: ${e.message}`);
    console.error('::error::the previously promoted dataset is unchanged — nothing was replaced.');
    process.exit(1);
  }

  await IMPORT.invalidateCaches(db, result.import_id, console.log);
  const snap = IMPORT.writeSnapshot(ds, verdict, result);
  await P.writeMeta(db, SCHEMA, {
    refresh_last_run: new Date().toISOString(), refresh_last_status: 'ok',
    refresh_last_message: `promoted ${result.import_id}`,
    provisional_seasons: prov.join(',')
  });
  await ledger.finish('ok', `promoted ${result.import_id}`, { details: { import_id: result.import_id, rows: result.staged, provisional: prov } });

  if (publish) publishDataset(out, console.log);
  console.log(`[refresh] promoted ${result.import_id}`);
  console.log(`[refresh] snapshot ${path.relative(ROOT, snap)}`);
  console.log('[refresh] rows now live: ' + JSON.stringify(result.promote.rows));
}

module.exports = { build, publishDataset, provisionalSeasons, STAGING, COMMITTED, GZ, PLAIN };

if (require.main === module) {
  main().catch(e => { console.error(`::error::${e && e.stack ? e.stack : e}`); process.exit(1); });
}
