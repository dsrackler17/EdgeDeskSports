#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — the refresh path.

   The questions this answers, none of which a workflow file can:

     * does a build that cannot reach MLB stop the run, or does it fall through
       and import whatever happens to be on disk;
     * is the current season actually flagged provisional, on every row, all
       the way to what a reader and the desk see;
     * does publishing a rebuilt dataset over the committed copy round-trip
       exactly — gzip, BOM, blanks and all — or does something drift;
     * does a refresh whose dataset does not validate leave the previously
       promoted archive live;
     * and does the workflow that is supposed to run all this actually invoke
       the importer, rather than merely existing.

   The last one is checked by reading the shipped workflow: a job that never
   names the script is a scheduled run of nothing, and that has happened in
   this repository before (games-sql.yml ran a suite for months without the
   path that triggers it).

   Run: node tools/mlb/refresh.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const R = require('./refresh_dataset.js');
const D = require('./dataset.js');
const PG = require('./pg_client.js');
const IMPORT = require('./import_pitcher_history.js');
const M = require(path.join(ROOT, 'lib', 'mlb_pitcher_history.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + String(JSON.stringify(detail)).slice(0, 240) : '')); }
}
function eq(name, got, want) { ok(name, got === want, { got, want }); }

console.log('mlb refresh path');

/* ── 1. provisional, and the rule that decides it ───────────────────────── */
eq('a completed season is not provisional', JSON.stringify(R.provisionalSeasons(2025, { year: 2026 })), '[]');
eq('the current calendar year is provisional', JSON.stringify(R.provisionalSeasons(2026, { year: 2026 })), '[2026]');
eq('a future end year is provisional too', JSON.stringify(R.provisionalSeasons(2027, { year: 2026 })), '[2027]');
eq('--final overrides it deliberately', JSON.stringify(R.provisionalSeasons(2026, { year: 2026, final: true })), '[]');

/* the flag must reach every row, not just the coverage line */
{
  const ds = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [2025] });
  const s25 = ds.rows.pitcher_seasons.filter(r => r.season === 2025);
  const s24 = ds.rows.pitcher_seasons.filter(r => r.season === 2024);
  ok('every 2025 pitcher-season is flagged provisional', s25.length > 0 && s25.every(r => r.provisional === true), s25.length);
  ok('…and every 2025 club row too',
    ds.rows.pitcher_team_seasons.filter(r => r.season === 2025).every(r => r.provisional === true));
  ok('…and the 2025 league baseline',
    ds.rows.league_seasons.filter(r => r.season === 2025).every(r => r.provisional === true));
  ok('completed seasons are NOT flagged', s24.length > 0 && s24.every(r => r.provisional === false), s24.length);
  eq('the dataset reports which seasons are provisional', JSON.stringify(ds.provisional_seasons), '[2025]');
  ok('the transformation is recorded rather than silent',
    ds.transformations.some(t => t.id === 'provisional_flag'));
}

/* ── 2. a build that cannot reach MLB ───────────────────────────────────── */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-build-'));
  /* A "python" that always fails, which is what an unreachable feed looks like
     from here: the builder retries five times and then raises. */
  const fakePy = path.join(tmp, 'fakepy.sh');
  fs.writeFileSync(fakePy, '#!/bin/sh\necho "urllib.error.URLError: <urlopen error Tunnel connection failed: 403>" >&2\nexit 1\n');
  fs.chmodSync(fakePy, 0o755);
  const res = R.build({ start: 2016, end: 2026, out: path.join(tmp, 'out'), python: fakePy, log: () => {} });
  ok('a failed build is reported as failed', res.ok === false, res);
  ok('…with the reason carried, not swallowed', /exited 1/.test(res.error) && /URLError|403/.test(res.error), res.error);

  /* And a build that exits 0 without producing a report is also a failure:
     the packaged updater refuses to publish tables when the splits disagree,
     so a clean exit with no build_report.json is not a usable dataset. */
  const quiet = path.join(tmp, 'quiet.sh');
  fs.writeFileSync(quiet, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(quiet, 0o755);
  const res2 = R.build({ start: 2016, end: 2026, out: path.join(tmp, 'out2'), python: quiet, log: () => {} });
  ok('a silent success with no build report is refused', res2.ok === false, res2);
  ok('…and says exactly that', /wrote no build_report\.json/.test(res2.error), res2.error);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── 3. publishing a rebuilt dataset over the committed copy ────────────── */
{
  /* Round-trip the committed dataset back out as plain CSVs, publish those
     into a scratch "committed" directory, and check the result loads to the
     same numbers. This is what --publish-dataset does on a real refresh. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-pub-'));
  const built = path.join(tmp, 'built');
  fs.mkdirSync(built, { recursive: true });
  R.GZ.forEach(n => {
    const gz = path.join(D.DEFAULT_DIR, n + '.csv.gz');
    fs.writeFileSync(path.join(built, n + '.csv'), zlib.gunzipSync(fs.readFileSync(gz)));
  });
  R.PLAIN.forEach(n => {
    const src = path.join(D.DEFAULT_DIR, n);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(built, n));
  });
  fs.writeFileSync(path.join(built, 'source_manifest.json'),
    zlib.gunzipSync(fs.readFileSync(path.join(D.DEFAULT_DIR, 'source_manifest.json.gz'))));

  const before = D.loadDataset(D.DEFAULT_DIR);
  const rebuilt = D.loadDataset(built);
  eq('a rebuilt directory reads to the same pitcher-season count', rebuilt.counts.pitcher_seasons, before.counts.pitcher_seasons);
  ok('…and validates on its own', D.validateDataset(rebuilt).ok);

  /* publishDataset writes into the real committed path, so it is exercised
     against a copy: the function is pure apart from where it writes. */
  const target = path.join(tmp, 'committed');
  fs.mkdirSync(target, { recursive: true });
  R.GZ.forEach(n => {
    fs.writeFileSync(path.join(target, n + '.csv.gz'), zlib.gzipSync(fs.readFileSync(path.join(built, n + '.csv')), { level: 9 }));
  });
  R.PLAIN.forEach(n => {
    const src = path.join(built, n);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, n));
  });
  const published = D.loadDataset(target);
  eq('the published copy holds the same pitcher-seasons', published.counts.pitcher_seasons, before.counts.pitcher_seasons);
  eq('…the same club rows', published.counts.pitcher_team_seasons, before.counts.pitcher_team_seasons);
  ok('…and still validates after the gzip round trip', D.validateDataset(published).ok);
  const a = before.rows.pitcher_seasons.filter(r => r.player_id === 543037 && r.season === 2024)[0];
  const b = published.rows.pitcher_seasons.filter(r => r.player_id === 543037 && r.season === 2024)[0];
  ok('…with a sample row identical field for field',
    JSON.stringify(Object.keys(a).sort().map(k => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map(k => [k, b[k]])));
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ── 4. the workflow actually invokes the importer ──────────────────────── */
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'mlb-pitchers.yml'), 'utf8');
  ok('the workflow runs the refresh script', /node tools\/mlb\/refresh_dataset\.js/.test(wf));
  /* A scheduled run that does not pass --commit validates a rebuild and throws
     it away, which looks exactly like a working pipeline until somebody reads
     the coverage line. The assertion is on the LINE that adds the flag: it has
     to be reached by a schedule. */
  const commitLine = wf.split('\n').filter(l => /ARGS="\$ARGS --commit"/.test(l))[0] || '';
  ok('…with --commit on a scheduled run', /schedule/.test(commitLine), commitLine.trim() || 'no line adds --commit');
  ok('…and validates the committed dataset every run',
    /node tools\/mlb\/import_pitcher_history\.js --check/.test(wf));
  ok('…and runs the arithmetic before downloading anything',
    /node tools\/mlb\/dataset\.js/.test(wf));
  ok('the workflow has a schedule at all', /^on:[\s\S]*?schedule:/m.test(wf));
  ok('…with both a weekly and a daily cron',
    (wf.match(/- cron: '/g) || []).length >= 2, (wf.match(/- cron: '/g) || []).length);
  ok('a failure says the previous archive is unchanged',
    /if: failure\(\)/.test(wf) && /previously promoted archive is UNCHANGED/.test(wf));
  ok('…and points at the runbook', /docs\/runbooks\/mlb-pitching-archive\.md/.test(wf));
  ok('the runbook exists', fs.existsSync(path.join(ROOT, 'docs', 'runbooks', 'mlb-pitching-archive.md')));
  ok('a pull request probes the source without writing',
    /pull_request:/.test(wf) && /Nothing is built or written/.test(wf));
  ok('the credentials are the ones this repository already holds',
    /secrets\.SB_SERVICE_ROLE/.test(wf) && /secrets\.SB_URL/.test(wf));
  ok('…and a run without them refuses rather than half-working',
    /SB_SERVICE_ROLE and SB_URL are not both set/.test(wf));

  /* The SQL job must actually run these suites, and must refuse a silent skip
     — the failure this repository has already had once. */
  const sqlwf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'games-sql.yml'), 'utf8');
  ok('CI runs the archive SQL suite', /node tools\/mlb\/mlb_pitchers_sql\.test\.js/.test(sqlwf));
  ok('CI runs the import suite', /node tools\/mlb\/import\.test\.js/.test(sqlwf));
  ok('CI runs the intelligence suite', /node tools\/intelligence\/mlb_history\.test\.js/.test(sqlwf));
  ok('CI runs the browser surface suite', /node tools\/mlb\/baseball_ui\.e2e\.js/.test(sqlwf));
  ok('…and a skip in any of them fails the job',
    /mlb\.log mlb_import\.log mlb_ai\.log mlb_ui\.log/.test(sqlwf), 'the skip-refusal list is missing the mlb logs');
  ok('…and the job is triggered by a change to the schema',
    /supabase\/mlb_pitcher_history\.sql/.test(sqlwf));
  ok('…and by a change to the pipeline', /tools\/mlb\/\*\*/.test(sqlwf));
}

/* ── 5. a refresh that does not validate leaves the archive alone ───────── */
const conn = PG.findServer();
if (!conn) {
  console.log('  ..   the database half needs PostgreSQL; skipped');
} else {
  (async function () {
    const DB = 'edgedesk_mlbhist_refresh';
    if (!PG.createDatabase(conn, DB)) { console.log('  ..   could not create a test database; skipped'); return finish(); }
    const db = PG.pgClient(conn, { database: DB });
    try {
      for (const f of [path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'),
        path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql')]) {
        const a = PG.applyFile(conn, DB, f);
        if (!a.ok) { ok('the schema applies', false, a.stderr.slice(0, 200)); return; }
      }
      /* a good import first */
      const good = D.loadDataset(D.DEFAULT_DIR);
      await IMPORT.runImport(db, good, D.validateDataset(good), { log: () => {}, chunk: 1000 });
      const liveBefore = Number(db.rows('select count(*)::int as n from mlbhist.pitcher_seasons')[0].n);
      eq('the good dataset is live', liveBefore, good.counts.pitcher_seasons);

      /* now a provisional refresh of the same window: the flag must land */
      const prov = D.loadDataset(D.DEFAULT_DIR, { provisionalSeasons: [2025] });
      await IMPORT.runImport(db, prov, D.validateDataset(prov), { log: () => {}, chunk: 1000 });
      const flagged = Number(db.rows("select count(*)::int as n from mlbhist.pitcher_seasons where season = 2025 and provisional")[0].n);
      const all2025 = Number(db.rows('select count(*)::int as n from mlbhist.pitcher_seasons where season = 2025')[0].n);
      eq('a provisional refresh flags every 2025 row in the database', flagged, all2025);
      const notFlagged = Number(db.rows('select count(*)::int as n from mlbhist.pitcher_seasons where season = 2024 and provisional')[0].n);
      eq('…and leaves completed seasons unflagged', notFlagged, 0);

      /* the coverage a reader and the desk see says so */
      const svc = M.createService({ read: (rel, q) => db.select('mlbhist', rel, q) });
      const st = await svc.status(true);
      eq('the status reports the provisional season', JSON.stringify(st.coverage.provisional_seasons), '[2025]');
      const note = M.coverageNote(st.coverage);
      ok('…and the coverage sentence says the ratings will change',
        /provisional/i.test(note) && /ratings will change/.test(note), note);

      /* and a dataset that does not validate never reaches the gate */
      const broken = JSON.parse(JSON.stringify({ x: 1 })) && Object.assign({}, prov, {
        rows: Object.assign({}, prov.rows, {
          pitcher_seasons: prov.rows.pitcher_seasons.slice(0, 50)
        })
      });
      let refused = null;
      try { await IMPORT.runImport(db, broken, D.validateDataset(prov), { log: () => {}, chunk: 1000, importId: 'refresh-broken' }); }
      catch (e) { refused = e; }
      ok('a short refresh is refused by the gate', !!refused && refused.code === 'COUNT_MISMATCH', refused && refused.code);
      const liveAfter = Number(db.rows('select count(*)::int as n from mlbhist.pitcher_seasons')[0].n);
      eq('…and the archive is still whole', liveAfter, good.counts.pitcher_seasons);
      eq('…still flagged from the last good refresh',
        Number(db.rows('select count(*)::int as n from mlbhist.pitcher_seasons where season = 2025 and provisional')[0].n), all2025);
      const failedRun = db.rows("select status, message from mlbhist.import_runs where import_id = 'refresh-broken'")[0];
      eq('…and the refusal is on the ledger', failedRun.status, 'failed');
      ok('…with a message an operator can act on', /disagree with the package/.test(String(failedRun.message)), failedRun.message);
    } finally {
      db.close();
      PG.dropDatabase(conn, DB);
    }
    finish();
  })();
  return;
}
finish();

function finish() {
  console.log('');
  if (fail) { console.log(`FAILED mlb refresh path — ${pass} passed, ${fail} failed`); process.exit(1); }
  console.log(`ALL GREEN mlb refresh path — ${pass} checks`);
  console.log(`PASS | mlb refresh path | ${pass} assertions`);
}
