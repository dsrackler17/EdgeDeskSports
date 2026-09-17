#!/usr/bin/env node
/* ===========================================================================
   THE OFFENSIVE REFRESH PATH.

   The refresh is the part of this system that runs unattended, which makes it
   the part where a quiet failure costs the most: a job that half-succeeds and
   leaves a partial season on screen labelled as a finished one is worse than a
   job that simply goes red.

   So these hold the properties that make an unattended run safe:

     1  A SEASON IN PROGRESS IS FLAGGED. The current calendar year is
        provisional on every row it writes — and for this archive that matters
        more than for pitching, because the LEAGUE BASELINE moves too and every
        rating is computed against it.
     2  A FAILED REFRESH KEEPS THE GOOD ARCHIVE. Nothing before the promote
        step touches a live table, and the promote is one transaction.
     3  THE FAILURE IS VISIBLE. A run that dies writes FAILED to the ledger the
        panel reads, so an operator sees an aged, failed pipeline rather than
        rows that still look fine.
     4  STAGING IS PER-IMPORT. A second run cannot double-stage, and one run's
        staged rows are not another's to delete.
     5  THE COMMITTED COPY IS ONLY REFRESHED ON PURPOSE, and never carries a
        second copy of the shared team identity table.

   Run: node tools/mlb/offense_refresh.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const R = require('./refresh_offense.js');
const D = require('./offense_dataset.js');
const IMPORT = require('./import_offense.js');
const PG = require('./pg_client.js');

const DB = 'edgedesk_mlboff_refresh';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const PITCH_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFF_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

console.log('mlb offense refresh path');

/* ── 1. PROVISIONAL IS A CALENDAR RULE, not a guess ───────────────────────── */
eq('a completed season is not provisional', JSON.stringify(R.provisionalSeasons(2025, { year: 2026 })), '[]');
eq('the current year IS provisional', JSON.stringify(R.provisionalSeasons(2026, { year: 2026 })), '[2026]');
eq('a future end year is provisional too', JSON.stringify(R.provisionalSeasons(2027, { year: 2026 })), '[2027]');
eq('--final says the season is over', JSON.stringify(R.provisionalSeasons(2026, { year: 2026, final: true })), '[]');

/* ── 2. THE PACKAGED UPDATER IS PRESENT AND IS THE ONE WE SHIP ────────────── */
ok('the packaged updater is committed', fs.existsSync(R.BUILDER), R.BUILDER);
{
  const src = fs.readFileSync(R.BUILDER, 'utf8');
  ok('…it is the offensive builder, not the pitching one',
    /hitting|batting|offens/i.test(src), src.slice(0, 120));
  ok('…and it needs no third-party packages',
    !/^\s*import\s+(requests|pandas|numpy|httpx)/m.test(src));
}

/* ── 3. THE COMMITTED COPY carries what the loader needs, and no more ─────── */
{
  const files = fs.readdirSync(R.COMMITTED);
  R.GZ.forEach((n) => ok('the committed dataset carries ' + n, files.indexOf(n + '.csv.gz') >= 0));
  ['validation.csv', 'build_report.json', 'data_dictionary.json', 'source_repairs.json',
    'games_reconciliation_notes.json'].forEach((n) => {
    ok('…and ' + n, files.indexOf(n) >= 0);
  });
  /* THE SHARED IDENTITY TABLE IS NOT DUPLICATED. Two copies is the first step
     toward the two archives disagreeing about what a club is called. */
  ok('teams.csv is NOT committed a second time', files.indexOf('teams.csv.gz') < 0 && files.indexOf('teams.csv') < 0,
    files.filter((f) => /teams/.test(f)).join(', '));
  ok('…and the publish list does not contain it', R.GZ.indexOf('teams') < 0 && R.PLAIN.indexOf('teams.csv') < 0);
  /* raw/ is deliberately absent: its urls, times and hashes are in the manifest. */
  ok('the raw source snapshots are not committed', files.indexOf('raw') < 0);
  ok('…but their manifest is', files.indexOf('source_manifest.json.gz') >= 0);
}

/* ── 4. A BUILD THAT FAILS IS REPORTED, NOT SWALLOWED ─────────────────────── */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edg-offrefresh-'));
  const b = R.build({ start: 2016, end: 2016, out: path.join(tmp, 'a'), python: '/nonexistent/python',
    log: () => {}, timeoutMs: 5000 });
  eq('a missing interpreter is a failed build', b.ok, false);
  ok('…with the reason carried', /exited|ENOENT|not found|spawn/i.test(b.error || ''), b.error);
  /* AND A BUILD THAT EXITS ZERO WITHOUT A REPORT IS STILL A FAILURE. This is
     the case that matters: the updater refuses to export tables when a season
     fails its own reconciliation, so a clean exit with nothing written is
     exactly what a refused build looks like from out here. `/bin/true` exits 0
     and writes nothing, which is precisely that shape. */
  const dir = path.join(tmp, 'b');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync('/bin/true')) {
    const b2 = R.build({ start: 2016, end: 2016, out: dir, python: '/bin/true', log: () => {}, timeoutMs: 5000 });
    eq('an updater that exits 0 and writes no build report is a failed build', b2.ok, false);
    ok('…and says so plainly', /build_report/.test(b2.error || ''), b2.error);
  } else {
    ok('(no /bin/true on this platform to test the clean-exit-no-report case)', true);
    ok('(…skipped)', true);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── 4b. THE SCHEDULER HAS TO NAME A MODE ─────────────────────────
   This CLI does nothing when given neither --check nor --commit, and exits 0
   saying so. That is fine at a prompt and dangerous in a job: the first
   dispatched run of the workflow rebuilt the pitching archive, reported
   success for the offensive step, and had in fact rebuilt nothing and imported
   nothing, because the step passed a season range and no mode. A green job
   that did no work is the exact failure the refresh exists to make impossible,
   so the workflow's own text is checked here. */
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'mlb-pitchers.yml'), 'utf8');
  const at = wf.indexOf('Rebuild the OFFENSIVE dataset');
  ok('the workflow has an offensive rebuild step', at > 0);
  const step = wf.slice(at, wf.indexOf('- name:', wf.indexOf('refresh_offense.js', at)));
  ok('\u2026which runs the offensive refresh', /node tools\/mlb\/refresh_offense\.js/.test(step));
  ok('\u2026and commits on a scheduled run', /ARGS="\$ARGS --commit"/.test(step));
  ok('\u2026and asks for a rebuild-and-validate when it is not committing',
    /ARGS="\$ARGS --check"/.test(step));
  const cli = fs.readFileSync(path.join(ROOT, 'tools', 'mlb', 'refresh_offense.js'), 'utf8');
  ok('the CLI still refuses to guess a mode',
    /Nothing to do\. Pass --check .* or --commit/.test(cli));
}

/* ── 5. THE DATABASE HALF ─────────────────────────────────────────────────── */
const conn = PG.findServer();
if (!conn) {
  console.log('  (skipping the database half — no reachable PostgreSQL)');
  report();
} else {
  (async function () {
    if (!PG.createDatabase(conn, DB)) { console.log('  (could not create the test database)'); report(); return; }
    const db = PG.pgClient(conn, { database: DB });
    try {
      for (const f of [SHIM, PITCH_SQL, OFF_SQL]) {
        const r = PG.applyFile(conn, DB, f);
        if (!r.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); throw new Error('apply'); }
      }
      const count = (t, w) => Number(db.rows(`select count(*)::int as n from mlbhist.${t}${w ? ' where ' + w : ''}`)[0].n);

      /* A PROVISIONAL IMPORT flags every row it writes for that season. */
      const ds = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [2025] });
      const verdict = D.validateDataset(ds);
      const res = await IMPORT.runImport(db, ds, verdict, { log: () => {}, chunk: 1000 });
      ok('a provisional import promoted', res.promote.ok === true);
      eq('every 2025 player-season is flagged provisional',
        count('batter_seasons', 'season = 2025 and provisional is not true'), 0);
      eq('…and every 2025 club-season',
        count('team_offense_seasons', 'season = 2025 and provisional is not true'), 0);
      /* THE LEAGUE BASELINE TOO. Every rating in the archive is computed
         against it, so a provisional baseline is the thing most worth
         flagging. */
      eq('…and the league baseline the ratings are computed against',
        count('league_offense_seasons', 'season = 2025 and provisional is not true'), 0);
      eq('a completed season is NOT flagged',
        count('batter_seasons', 'season = 2024 and provisional is true'), 0);
      const st = db.rows('select provisional_seasons from mlbhist.offense_status')[0];
      ok('…and the status view publishes which seasons are provisional',
        /2025/.test(String(st.provisional_seasons)), String(st.provisional_seasons));

      /* A SECOND RUN AS FINAL clears the flag rather than leaving it. */
      const ds2 = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [] });
      const res2 = await IMPORT.runImport(db, ds2, D.validateDataset(ds2), { log: () => {}, chunk: 1000 });
      ok('a final import promoted over the provisional one', res2.promote.ok === true);
      eq('…and no row is flagged provisional any more',
        count('batter_seasons', 'provisional is true'), 0);

      /* STAGING IS PER-IMPORT and is cleared on promotion. */
      eq('staging is empty after a promotion', count('stg_batter_seasons'), 0);
      /* A staged import from another run is not this run's to delete. */
      db.sql(`insert into mlbhist.import_runs (import_id, dataset, status) values ('other-1','offense','staging');`);
      db.sql(`insert into mlbhist.stg_batter_seasons (player_id, season, player_name, name_key, import_id)
              values (1, 2016, 'x', 'x', 'other-1');`);
      const ds3 = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [] });
      await IMPORT.runImport(db, ds3, D.validateDataset(ds3), { log: () => {}, chunk: 1000 });
      eq('another run’s staged rows survive this run’s promotion',
        count('stg_batter_seasons', "import_id = 'other-1'"), 1);
      db.sql(`select mlbhist.abandon_offense_import('other-1','test cleanup');`);
      eq('…and abandoning it clears exactly that import',
        count('stg_batter_seasons', "import_id = 'other-1'"), 0);

      /* A FAILED REFRESH LEAVES THE ARCHIVE AND SAYS SO. */
      const before = count('batter_seasons');
      const bad = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [] });
      const rows = IMPORT.prepareRows(bad);
      rows.batter_seasons = rows.batter_seasons.slice(0, 500);
      let caught = null;
      try { await IMPORT.runImport(db, bad, verdict, { log: () => {}, chunk: 1000, rows }); }
      catch (e) { caught = e; }
      ok('a short dataset is refused', !!caught && caught.code === 'COUNT_MISMATCH',
        caught ? caught.code : 'not refused');
      eq('…and the archive is untouched', count('batter_seasons'), before);
      eq('…and the previously promoted import is still promoted',
        count('import_runs', "dataset = 'offense' and status = 'promoted'"), 1);

      /* THE OPERATOR LEDGER. The panel's freshness line reads these keys. */
      const meta = {};
      db.rows('select key, value from mlbhist.meta').forEach((r) => { meta[r.key] = r.value; });
      ok('the import writes its own last-run key', !!meta.import_offense_last_run, JSON.stringify(Object.keys(meta)));
      eq('…with a status', meta.import_offense_last_status, 'ok');
      ok('…and an import id', !!meta.import_offense_last_id);
      ok('the coverage window is published for the readers',
        meta.offense_coverage_start === '2016' && meta.offense_coverage_end === '2025',
        `${meta.offense_coverage_start}-${meta.offense_coverage_end}`);
      ok('…and the offensive keys do not collide with the pitching ones',
        Object.keys(meta).filter((k) => /^import_pitcher_history/.test(k)).length === 0,
        Object.keys(meta).join(','));

      /* THE CACHE VERSION the readers include in their key. */
      await IMPORT.invalidateCaches(db, 'test-import', () => {});
      const meta2 = {};
      db.rows('select key, value from mlbhist.meta').forEach((r) => { meta2[r.key] = r.value; });
      ok('a promotion bumps a cache version the readers can see', !!meta2.offense_cache_version);
      ok('…with the reason attached', /test-import/.test(meta2.offense_cache_reason || ''), meta2.offense_cache_reason);

      /* THE SNAPSHOT: what was published, on a date, so a later evaluation can
         ask what EdgeDesk held rather than what it holds now. */
      const snapDir = IMPORT.SNAPSHOT_DIR;
      const snap = IMPORT.writeSnapshot(ds3, verdict, res2);
      ok('a dated snapshot is written', fs.existsSync(snap), snap);
      const body = JSON.parse(fs.readFileSync(snap, 'utf8'));
      eq('…naming the dataset', body.dataset, 'offense');
      eq('…the rating version', body.rating_version, 'ED_BAT_PERF_V1');
      ok('…the coverage window', body.coverage.start === 2016 && body.coverage.end === 2025);
      ok('…and the row counts that were promoted', body.rows.batter_seasons === 10098,
        JSON.stringify(body.rows && body.rows.batter_seasons));
      ok('…and it is a manifest, not a copy of the data',
        /manifest of what was promoted, not a copy/.test(body.note || ''), body.note);
      /* clean up the snapshot this test wrote */
      try { fs.rmSync(snap); if (!fs.readdirSync(snapDir).length) fs.rmdirSync(snapDir); } catch (_) { /* best effort */ }
    } catch (e) {
      console.log('FAIL | mlb offense refresh | ' + (e && e.stack || e));
      fail++;
    } finally {
      try { db.close(); } catch (_) { /* best effort */ }
      PG.dropDatabase(conn, DB);
    }
    report();
  })();
}

function report() {
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  if (fail === 0) console.log('PASS | mlb offense refresh path | ' + pass + ' assertions');
  process.exit(fail === 0 ? 0 : 1);
}
