#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — import the historical pitching record.

   THE SHAPE OF ONE IMPORT, and why it is this shape:

     1. read      the packaged dataset from disk (mlb/pitchers/dataset, or
                  --dir for a freshly built one)
     2. check     re-derive what can be re-derived and refuse to go further if
                  anything disagrees (tools/mlb/dataset.js). A refusal here
                  costs nothing: the live tables have not been touched.
     3. open      a row in mlbhist.import_runs carrying coverage, the rating
                  version, the source snapshot, the package's own counts and
                  the transformations this import applies
     4. stage     every row into mlbhist.stg_*, keyed by that import id
     5. promote   mlbhist.promote_import(), one transaction, which checks the
                  staged counts against the package's own, refuses duplicate
                  keys and an unreconciled season, and only then replaces the
                  live tables
     6. record    freshness into mlbhist.meta and a dated snapshot of what was
                  published, so a future backtest can ask what EdgeDesk knew

   RUNNING IT TWICE WRITES THE SAME ROWS. Staging is keyed by import id and
   cleared on promotion; the live tables are replaced for the seasons the
   dataset covers, by natural key, inside the promote transaction. A second run
   of the same dataset produces an identical database — including for a record
   MLB has since removed, which disappears instead of lingering.

   A FAILED IMPORT CANNOT DAMAGE A GOOD ONE. Nothing before step 5 writes to a
   live table, and step 5 is all-or-nothing. If the process dies at step 4 the
   staged rows are orphaned and the archive is exactly as it was.

     node tools/mlb/import_pitcher_history.js --check      read and validate only
     node tools/mlb/import_pitcher_history.js --dry-run    everything but the write
     node tools/mlb/import_pitcher_history.js --commit     stage and promote
     node tools/mlb/import_pitcher_history.js --commit --provisional 2026
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const P = require('../lib/pgrest.js');
const { SCHEMA, CONTRACT, reportFailure } = require('./db.js');
const D = require('./dataset.js');
const M = require('../../lib/mlb_pitcher_history.js');

const ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_DIR = path.join(ROOT, 'mlb', 'pitchers', 'snapshots');

/* The order rows are staged in. Nothing depends on it — staging has no foreign
   keys — but a stable order makes a partial run readable in the ledger. */
const TABLES = ['pitcher_seasons', 'pitcher_team_seasons', 'pitcher_overview', 'pitcher_team_history',
  'observed_team_runs', 'league_seasons', 'teams', 'validation', 'source_repairs'];

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }

function makeImportId(coverage) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  return `mlbhist-${coverage.start}-${coverage.end}-${stamp}`;
}

/**
 * Stage and promote a validated dataset.
 *
 * db        a tools/lib/pgrest.js client (or the fake one, in tests)
 * ds        the loaded dataset
 * verdict   its validation result
 */
async function runImport(db, ds, verdict, o) {
  o = o || {};
  const log = o.log || console.log;
  const importId = o.importId || makeImportId(ds.coverage);
  const ledger = o.ledger || null;

  const expected = {};
  TABLES.forEach(t => { if (ds.counts[t] != null) expected[t] = ds.counts[t]; });

  const runRow = {
    import_id: importId,
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
        summary: verdict.summary,
        checks: verdict.checks.map(c => ({ name: c.name, ok: c.ok, detail: c.detail })),
        problems: verdict.problems
      },
      per_season: ds.rows.validation.map(v => ({
        season: v.season, teams: v.teams, pitchers: v.pitchers,
        pitcher_team_rows: v.pitcher_team_rows, reconciled: v.player_totals_reconcile === true
      }))
    },
    source_repairs: (ds.repairs || []).length,
    transformations: ds.transformations,
    github_run_url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null
  };

  await db.upsert(SCHEMA, 'import_runs', [runRow], 'import_id', { returning: false });
  log(`[import] opened ${importId}`);
  if (ledger) await ledger.beat({ details: { import_id: importId, stage: 'staging' } });

  /* Staging, table by table, in chunks. A chunk that fails throws and the
     import stops where it is: nothing live has moved, so stopping is safe.

     THE IMPORT ID IS STAMPED HERE, not by whoever loaded the dataset. Every
     staged row and every promote/cleanup query is keyed on it, so a row that
     reached staging without one is invisible to its own promotion — the gate
     reads an empty import and refuses it, correctly, for the wrong reason.
     Stamping at the point of the write is the only place it cannot be
     forgotten. */
  const staged = {};
  for (const t of TABLES) {
    const rows = (ds.rows[t] || []).map(r => (r.import_id === importId ? r : Object.assign({}, r, { import_id: importId })));
    if (!rows.length) { staged[t] = 0; continue; }
    /* The staging tables are cleared for this import first, so a retry of the
       same import id cannot double-stage. */
    await db.del(SCHEMA, 'stg_' + t, `import_id=eq.${encodeURIComponent(importId)}`);
    const chunk = o.chunk || 500;
    for (let i = 0; i < rows.length; i += chunk) {
      await db.insert(SCHEMA, 'stg_' + t, rows.slice(i, i + chunk), { returning: false });
    }
    staged[t] = rows.length;
    log(`[import]   staged ${t}: ${rows.length}`);
    if (ledger) await ledger.beat({ details: { import_id: importId, stage: 'staging', table: t, rows: rows.length } });
  }

  await db.patch(SCHEMA, 'import_runs', `import_id=eq.${encodeURIComponent(importId)}`,
    { status: 'validated', staged_counts: staged });

  log('[import] promoting…');
  const res = await db.rpc(SCHEMA, 'promote_import', { p_import_id: importId });
  const out = Array.isArray(res) ? res[0] : res;
  if (!out || out.ok !== true) {
    const code = (out && out.code) || 'PROMOTE_REFUSED';
    const detail = out ? JSON.stringify(out) : 'the promote gate returned nothing';
    throw Object.assign(new Error(`the promote gate refused this import (${code}): ${detail}`), { promote: out, code });
  }

  await P.writeMeta(db, SCHEMA, {
    import_last_run: new Date().toISOString(),
    import_last_status: 'ok',
    import_last_id: importId,
    coverage_start: String(ds.coverage.start),
    coverage_end: String(ds.coverage.end),
    provisional_seasons: (ds.provisional_seasons || []).join(',')
  });

  return { import_id: importId, staged, promote: out };
}

/* A dated record of what was published, kept in the repository. This is what
   makes an honest backtest possible later: "what did EdgeDesk hold on this
   date" has an answer that is not "whatever the current table says". It is a
   manifest, not a copy of the data — the data is the dataset directory, whose
   own build time and source fingerprint are recorded here. */
function writeSnapshot(ds, verdict, result) {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(SNAPSHOT_DIR, `${day}.json`);
  const body = {
    snapshot_date: day,
    import_id: result ? result.import_id : null,
    imported_at: new Date().toISOString(),
    coverage: ds.coverage,
    provisional_seasons: ds.provisional_seasons || [],
    rating_version: ds.rating_version,
    dataset_built_at: (ds.report && ds.report.built_at_utc) || null,
    source: M.SOURCE,
    source_manifest_sha: D.manifestFingerprint(ds.manifest),
    counts: ds.counts,
    source_repairs: (ds.repairs || []).length,
    validation: {
      package: (ds.report && ds.report.validation) || null,
      independent_summary: verdict.summary,
      independent_ok: verdict.ok,
      per_season: ds.rows.validation.map(v => ({ season: v.season, pitchers: v.pitchers,
        pitcher_team_rows: v.pitcher_team_rows, reconciled: v.player_totals_reconcile === true }))
    },
    transformations: ds.transformations.map(t => t.id),
    note: 'A manifest of one promoted import, kept dated so a later evaluation can state what the archive held on '
      + 'this date rather than assuming it always held what it holds now. It is not a copy of the rows.'
  };
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

/* Caches that must not outlive an import. The browser caches coverage for five
   minutes of its own accord and the edge function caches per isolate, so the
   only cache with a lifetime long enough to matter is the one keyed on the
   dataset status — which is invalidated by the meta write above (it carries
   the import id every reader compares against). This bumps a cache-busting
   token the app reads, so a reader on a stale coverage line refreshes it on
   their next navigation rather than at the end of a TTL. */
async function invalidateCaches(db, importId, log) {
  try {
    await P.writeMeta(db, SCHEMA, { cache_token: importId, cache_token_at: new Date().toISOString() });
    log('[import] cache token bumped — readers pick up the new coverage on their next status read');
    return true;
  } catch (e) {
    log(`[import] could not bump the cache token: ${e.message}`);
    return false;
  }
}

async function main() {
  const dir = arg('dir', D.DEFAULT_DIR);
  const check = flag('check');
  const dry = flag('dry-run');
  const commit = flag('commit');
  const provisional = String(arg('provisional', '') || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);

  console.log(`[import] reading ${dir}`);
  let ds;
  try {
    ds = D.loadDataset(dir, { provisionalSeasons: provisional });
  } catch (e) {
    console.error(`::error::the dataset could not be read: ${e.message}`);
    process.exit(1);
  }
  console.log(`[import] coverage ${ds.coverage.start}–${ds.coverage.end}, rating ${ds.rating_version}`
    + (ds.provisional_seasons.length ? `, provisional ${ds.provisional_seasons.join(', ')}` : ''));
  Object.keys(ds.counts).forEach(k => console.log(`[import]   ${k}: ${ds.counts[k]}`));

  const verdict = D.validateDataset(ds);
  verdict.checks.forEach(c => console.log(`[check] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`));
  if (!verdict.ok) {
    console.error(`::error::the dataset did not validate (${verdict.summary}). Nothing was written; the archive on file is unchanged.`);
    verdict.problems.forEach(p => console.error(`  ${p.code}: ${p.detail}`));
    process.exit(1);
  }
  console.log(`[check] ALL GREEN ${verdict.summary}`);

  if (check) { console.log('[import] --check: validation only, nothing staged.'); return; }

  const cfg = P.config();
  if (!cfg) {
    if (commit) {
      console.error('::error::EDGD_SB_SERVICE and EDGD_SB_URL are not both set — nothing can be written.');
      process.exit(1);
    }
    console.log('[import] no database credentials; this was a read-and-validate run.');
    return;
  }
  const db = P.client(cfg);

  if (dry && !commit) {
    console.log('[import] --dry-run: the dataset is valid and would stage '
      + TABLES.map(t => `${t}=${ds.counts[t] || 0}`).join(', ') + '. Nothing written.');
    return;
  }

  const ledger = P.runLedger(db, SCHEMA, 'import_pitcher_history', { scope: `${ds.coverage.start}-${ds.coverage.end}` });
  await ledger.start({ dir, counts: ds.counts, provisional: ds.provisional_seasons });

  let result = null;
  try {
    result = await runImport(db, ds, verdict, { ledger });
  } catch (e) {
    reportFailure('import_pitcher_history', e);
    await ledger.finish('failed', String(e.message).slice(0, 500));
    try { await P.writeMeta(db, SCHEMA, { import_last_run: new Date().toISOString(), import_last_status: 'failed' }); } catch (_) { /* best effort */ }
    console.error(`::error::the import failed: ${e.message}`);
    console.error('::error::the previously promoted dataset is unchanged — nothing was replaced.');
    process.exit(1);
  }

  await invalidateCaches(db, result.import_id, console.log);
  const snap = writeSnapshot(ds, verdict, result);
  await ledger.finish('ok', `promoted ${result.import_id}`, { details: { import_id: result.import_id, rows: result.staged } });

  console.log(`[import] promoted ${result.import_id}`);
  console.log(`[import] snapshot written to ${path.relative(ROOT, snap)}`);
  console.log('[import] rows now live: ' + JSON.stringify(result.promote.rows));
}

module.exports = { runImport, writeSnapshot, invalidateCaches, makeImportId, TABLES, SNAPSHOT_DIR };

if (require.main === module) {
  main().catch(e => { console.error(`::error::${e && e.stack ? e.stack : e}`); process.exit(1); });
}
