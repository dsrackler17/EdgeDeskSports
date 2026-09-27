#!/usr/bin/env node
/* ============================================================================
   CFB production — the release checklist (docs/cfb-production/DEPLOYMENT.md §2).

   One command answers "may this tree be released?". Each item is PASS, WARN
   or FAIL with the evidence; any FAIL exits 1.

     1  tests green              the production, engine, lab and decision suites
                                 (+ every SQL suite with --with-sql, + the weekly
                                 engine's python fast suites with --with-python)
     2  migrations present       every supabase/cfb_*.sql: a suite that applies it,
                                 an apply path (Deploy intelligence), split parts
     3  migration safety         no destructive statement in any CFB migration
     4  manifest valid           manifest.json verifies, is not stale, says NOT_RUN
                                 unless a championship's evidence is on record
     5  artifacts hash-verified  the V2.1 artifact, decision baseline and
                                 calibration verify; every pinned file is in git
     6  compatibility            the pinned tuple (compat.js check) holds
     7  no unversioned hotfix    a model file changed without a version bump fails
     8  shadow checks            V2.1 is projecting and being snapshotted in shadow;
                                 betting stays disabled unless the policy allows it
     9  rollback ready           V1 (the champion) is present and pinned as the
                                 fallback; ROLLBACK.md exists; a previous manifest
    10  jobs                     the registry matches every workflow / pg_cron file;
                                 the gates are wired
    11  sources healthy          the operational report (health.js) now
    12  clean tree               the manifest names a commit, not a working tree

     node tools/cfb/release_check.js [--with-sql] [--with-python] [--skip-tests] [--strict] [--json]
   --strict turns the operational WARNs (dirty tree, unhealthy sources) into FAILs:
   CI on a release candidate runs it that way.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const P = path.join(REPO, 'football', 'cfb_production');
const C = require(path.join(P, 'compat.js'));
const MF = require(path.join(P, 'manifest.js'));
const V = require(path.join(P, 'versioning.js'));
const J = require(path.join(P, 'jobs.js'));
const H = require(path.join(P, 'health.js'));
const MR = require(path.join(P, 'migration_review.js'));

const PATHWAY_SQL = ['cfb_lab', 'cfb_lab_cron', 'cfb_weekly', 'cfb_personnel', 'cfb_decision', 'cfb_production'];
const DOCS = ['ARCHITECTURE', 'DEPLOYMENT', 'ROLLBACK', 'JOBS', 'VERSIONING', 'OPERATIONS', 'RUNBOOK'];

function run(cmd, args, opts) {
  const t0 = Date.now();
  const r = cp.spawnSync(cmd, args, Object.assign({ cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { SB_URL: '', SB_SERVICE_ROLE: '' }) }, opts || {}));
  const tail = String((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0] || '';
  return { ok: r.status === 0, ms: Date.now() - t0, tail: tail.slice(0, 160) };
}

function check(opts) {
  opts = opts || {};
  const items = [];
  const add = (n, name, status, detail) => items.push({ n, name, status, detail });
  const warnOr = (b) => (b ? 'PASS' : opts.strict ? 'FAIL' : 'WARN');

  /* 1 tests */
  if (opts.skipTests) add(1, 'tests green', 'WARN', 'skipped (--skip-tests)');
  else {
    const suites = ['football/cfb_production/tests.js', 'football/cfb_production/ui.test.js', 'football/cfb_v2/tests.js', 'football/cfb_decision/tests.js', 'football/cfb_lab/tests.js', 'tools/sql/split_sql.test.js'];
    if (opts.withSql) suites.push('football/cfb_production/sql.test.js', 'football/cfb_weekly/sql.test.js', 'football/cfb_personnel/sql.test.js', 'football/cfb_decision/sql.test.js', 'football/cfb_lab/sql.test.js');
    const res = suites.map((s) => Object.assign({ suite: s }, run(process.execPath, [s])));
    if (opts.withPython) {
      for (const m of ['v2.weekly.tests_weekly', 'v2.weekly.tests_games']) {
        const r = run('python3', ['-m', m, '--fast'], { cwd: path.join(REPO, 'football', 'cfb_v2', 'research'), env: Object.assign({}, process.env, { CFB_WEEKLY_QUIET: '1',
          CFB_V2_DATA: path.join(require('os').tmpdir(), 'cfb_v2_data'), CFB_V2_OUT: path.join(require('os').tmpdir(), 'cfb_v2_out') }) });
        res.push(Object.assign({ suite: 'python -m ' + m + ' --fast' }, r));
      }
    }
    const bad = res.filter((r) => !r.ok);
    add(1, 'tests green (' + res.length + ' suites' + (opts.withSql ? ', SQL included' : ', no SQL: --with-sql') + ')', bad.length ? 'FAIL' : 'PASS',
      res.map((r) => (r.ok ? 'ok ' : 'FAILED ') + r.suite + ' — ' + r.tail).join('\n'));
  }

  /* 2 migrations present */
  const deploy = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-intelligence.yml'), 'utf8');
  const splitTest = fs.readFileSync(path.join(REPO, 'tools', 'sql', 'split_sql.test.js'), 'utf8');
  const parts = fs.readdirSync(path.join(REPO, 'supabase', 'parts'));
  const testsText = cp.spawnSync('grep', ['-rl', '--include=*.test.js', '--include=tests_sql.py', 'supabase', 'football', 'tools'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .map((f) => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
  const mig = MR.files().map((n) => {
    const bytes = fs.statSync(path.join(REPO, 'supabase', n + '.sql')).size;
    const applied = new RegExp('psql[^\\n]*supabase/' + n + '\\.sql').test(deploy);
    const tested = new RegExp("(" + n + "\\.sql|'" + n + "'|SQL\\('" + n + "'\\))").test(testsText);
    const split = bytes <= 18000 + 4096 || (new RegExp("'" + n + "'").test(splitTest) && parts.some((p) => p.startsWith(n + '.part')));
    return { n, bytes, applied, tested, split, pathway: PATHWAY_SQL.includes(n) };
  });
  const migBad = mig.filter((m) => m.pathway && !(m.applied && m.tested && m.split));
  const migWarn = mig.filter((m) => !m.pathway && !(m.applied && m.tested && m.split));
  add(2, 'migrations present (apply path, test, editor parts)', migBad.length ? 'FAIL' : migWarn.length ? 'WARN' : 'PASS',
    mig.map((m) => m.n + ': ' + (m.applied ? 'apply ok' : 'NO apply step') + ', ' + (m.tested ? 'tested' : 'NO test') + ', ' + (m.split ? 'parts ok' : 'NO parts') + (m.pathway ? '' : ' (outside the production pathway)')).join('\n'));

  /* 3 migration safety */
  const rev = MR.files().map(MR.review);
  const destr = rev.filter((r) => r.destructive.length);
  add(3, 'migration safety (no destructive statement)', destr.length ? 'FAIL' : 'PASS',
    destr.length ? destr.map((r) => r.file + ': ' + r.destructive.join(' | ')).join('\n') : rev.length + ' CFB migrations scanned; re-apply lock levels: reports/migration_review.json');

  /* 4 manifest */
  const man = (() => { try { return JSON.parse(fs.readFileSync(MF.OUT, 'utf8')); } catch (e) { return null; } })();
  let mprob = man ? MF.verify(man) : ['no football/cfb_production/manifest.json'];
  let fresh = null;
  try { fresh = MF.build({ deployedAt: man && man.deployed_at }); } catch (e) { mprob.push('manifest build failed: ' + e.message); }
  if (man && fresh && fresh.content_sha256 !== man.content_sha256) mprob.push('stale: the system on disk differs from manifest.json (node football/cfb_production/manifest.js --write)');
  if (man && man.champion_selection === 'SELECTED' && !man.championship_evidence) mprob.push('champion_selection SELECTED without championship evidence');
  add(4, 'manifest valid (' + (man ? man.manifest_id + ', champion_selection ' + man.champion_selection : 'none') + ')', mprob.length ? 'FAIL' : 'PASS', mprob.join('\n') || 'verifies; content hash current');

  /* 5 artifacts */
  const f = C.facts();
  const ap = [];
  if (!f.artifact.ok) ap.push(f.artifact.reason);
  if (!f.decision_baseline || !f.decision_baseline.ok) ap.push('decision baseline does not verify');
  if (f.decision_calibration && !f.decision_calibration.ok) ap.push('decision calibration does not verify: ' + f.decision_calibration.mismatched.join(', '));
  const gitp = man ? MF.verifyFromGit(man) : [];
  add(5, 'artifacts hash-verified (and recoverable from git)', ap.length ? 'FAIL' : gitp.length ? (opts.strict ? 'FAIL' : 'WARN') : 'PASS',
    ap.concat(gitp).join('\n') || f.artifact.dir + ' + decision baseline + calibration verify; every pinned blob is in git');

  /* 6 compatibility */
  const comp = C.check(f, C.loadMatrix());
  const cbad = comp.filter((c) => !c.ok);
  add(6, 'compatibility (feature schema x model x calibration x decision policy)', cbad.length ? 'FAIL' : 'PASS', cbad.map((c) => c.check + ' [' + c.code + ']: ' + c.detail).join('\n') || comp.length + ' checks hold');

  /* 7 no unversioned hotfix */
  const unv = V.unversionedChanges(man, f, (p) => C.shaFile(path.join(REPO, p)));
  add(7, 'no unversioned hotfix (model files vs the manifest, same version)', unv.length ? 'FAIL' : 'PASS',
    unv.map((u) => u.file + ' changed under ' + f.production_model_version + ': bump the version (VERSIONING.md)').join('\n') || 'every model file matches the manifest for ' + f.production_model_version);

  /* 8 shadow */
  const season = H.build ? require(path.join(P, 'health.js')) && new Date().getUTCMonth() <= 1 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear() : null;
  const lab = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'cfb_lab', 'reports', String(season), 'lab.json'), 'utf8')); } catch (e) { return null; } })();
  const v21 = lab && lab.health && (lab.health.models || []).find((m) => m.model_version === f.production_model_version);
  const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'cfb_v2', 'current.json'), 'utf8')); } catch (e) { return null; } })();
  const sh = [];
  if (!v21 || !v21.snapshots) sh.push('the Model Lab has no ' + f.production_model_version + ' snapshot this season');
  if (!cur || cur.model_version !== f.production_model_version) sh.push('football/cfb_v2/current.json is not ' + f.production_model_version);
  if (f.decision_policy && f.decision_policy.bet_enabled) sh.push('the decision policy enables betting: needs the promotion gate and cfb_bet_actionable_enabled');
  add(8, 'shadow checks (V2.1 projecting and snapshotted; betting disabled)', sh.length ? 'FAIL' : 'PASS',
    sh.join('\n') || (v21 ? v21.snapshots + ' lab snapshots of ' + f.production_model_version + '; ' : '') + (cur ? cur.rows.length + ' rows in current.json (' + cur.generated_at + '); ' : '') + 'policy ' + (f.decision_policy && f.decision_policy.version) + ' bet_enabled=false');

  /* 9 rollback */
  const rb = [];
  const fb = ((C.loadMatrix() || {}).entries || []).find((e) => e.role === 'FALLBACK');
  if (!fb || !f.v1.present || fb.params_sha256 !== f.v1.params_sha256) rb.push('the V1 fallback is not present and pinned');
  if (!fs.existsSync(path.join(REPO, 'docs', 'cfb-production', 'ROLLBACK.md'))) rb.push('docs/cfb-production/ROLLBACK.md missing');
  if (!man || !(man.fallback_hierarchy || []).length) rb.push('the manifest carries no fallback hierarchy');
  const prevManifests = (cp.spawnSync('git', ['log', '--format=%H', '--', 'football/cfb_production/manifest.json'], { cwd: REPO, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).length;
  add(9, 'rollback ready (V1 fallback pinned, ROLLBACK.md, a previous manifest)', rb.length ? 'FAIL' : prevManifests >= 1 ? 'PASS' : 'WARN',
    rb.join('\n') || 'V1 ' + f.v1.model_version + ' pinned; ' + prevManifests + ' committed manifest version(s) to roll back to' + (prevManifests ? '' : ' (first release: the rollback target is the V1 champion itself)'));

  /* 10 jobs */
  const drift = J.drift();
  const lab_yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'cfb-lab.yml'), 'utf8');
  const v2_yml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'cfb-v2-shadow.yml'), 'utf8');
  const wired = /gate\.js start --job cfb_lab_hourly/.test(lab_yml) && /gate\.js finish --job cfb_lab_hourly/.test(lab_yml) && /gate\.js start --job cfb_weekly_refresh/.test(v2_yml) && /gate\.js finish --job cfb_weekly_refresh/.test(v2_yml);
  add(10, 'jobs (registry = workflows / pg_cron; gates wired)', drift.length ? 'FAIL' : wired ? 'PASS' : 'FAIL', drift.length ? JSON.stringify(drift) : wired ? 'no drift; both scheduled CFB jobs pass the gate' : 'the gate steps are not wired into cfb-lab.yml / cfb-v2-shadow.yml');

  /* 11 sources */
  const ops = H.build({ now: new Date().toISOString() });
  const opsBad = Object.entries(ops.system.by_section).filter(([, s]) => s === 'CRITICAL').map(([k]) => k);
  add(11, 'sources healthy now (health.js: ' + ops.system.status + ')', warnOr(!opsBad.length), opsBad.length ? 'CRITICAL: ' + opsBad.join(', ') : 'no CRITICAL section');

  /* 12 clean tree + docs */
  const missingDocs = DOCS.filter((d) => !fs.existsSync(path.join(REPO, 'docs', 'cfb-production', d + '.md')));
  const dirty = man ? man.git_dirty : true;
  add(12, 'clean tree and production docs', missingDocs.length ? 'FAIL' : warnOr(!dirty),
    (missingDocs.length ? 'missing docs: ' + missingDocs.join(', ') + '\n' : '') + (dirty ? 'the manifest was generated from a dirty working tree (commit, then --write the manifest)' : 'manifest generated at a clean commit'));

  return { items, ok: !items.some((i) => i.status === 'FAIL'), release: items.every((i) => i.status === 'PASS') ? 'RELEASABLE' : items.some((i) => i.status === 'FAIL') ? 'BLOCKED' : 'RELEASABLE_WITH_WARNINGS' };
}

module.exports = { check };

if (require.main === module) {
  const a = process.argv.slice(2);
  const r = check({ withSql: a.includes('--with-sql'), withPython: a.includes('--with-python'), skipTests: a.includes('--skip-tests'), strict: a.includes('--strict') });
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 1));
  else {
    r.items.forEach((i) => { console.log(i.status.padEnd(5) + ' ' + String(i.n).padStart(2) + '. ' + i.name); if (i.status !== 'PASS' || a.includes('--verbose')) String(i.detail || '').split('\n').forEach((l) => console.log('         ' + l)); });
    console.log('release: ' + r.release);
  }
  process.exit(r.ok ? 0 : 1);
}
