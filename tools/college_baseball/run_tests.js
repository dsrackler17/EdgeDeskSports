#!/usr/bin/env node
/* ===========================================================================
   Run every suite the college baseball release gates read, and record the
   result (validation/test_results.json) with the commit it ran on.

     college_baseball   the engine's own tests (offline + committed artifacts)
     ui                 the NCAA engine segment in Chromium (skips if no browser)
     existing_sports    the suites that prove the rest of EdgeDesk still works

   Gates G7, G14 and G15 read this file; they fail if it is missing or if a
   suite failed. A suite that SKIPS (no browser here) is recorded as skipped,
   not passed.

   Run: node tools/college_baseball/run_tests.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const EXISTING = [
  'tools/lab/lab.test.js', 'tools/engine/engine.test.js', 'tools/hockey/hockey.test.js', 'mlb/tests.js',
  'tools/cbb/ingest.test.js', 'tools/cbb/stats.test.js', 'tools/cbb/ncaa_archive.test.js', 'tools/cbb/team_aliases.test.js', 'tools/cbb/refresh.test.js',
  'tools/app/sports_config.test.js', 'tools/site/nav.test.js', 'tools/odds/no_bypass.test.js', 'tools/intelligence/support_boundary.test.js',
  'tools/engine/engine_ui.e2e.js',
];

function run(file) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /(\d+) passed, (\d+) failed/.exec(out) || /(\d+) passed/.exec(out);
  const skipped = /^SKIP/m.test(out) || /SKIPPED/.test(out);
  return { file, ok: r.status === 0 && !skipped, skipped, status: r.status, passed: m ? Number(m[1]) : null, failed: m && m[2] ? Number(m[2]) : null, seconds: Math.round((Date.now() - t0) / 1000), tail: out.trim().split('\n').slice(-4).join('\n').slice(0, 600) };
}

function main() {
  const res = { schema: 'edgedesk_cbase_test_results_v1', ran_at: new Date().toISOString(), commit: (() => { try { return execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch (_) { return null; } })(), suites: {} };
  const cb = run('tools/college_baseball/college_baseball.test.js');
  res.suites.college_baseball = cb;
  console.log((cb.ok ? 'PASS ' : 'FAIL ') + cb.file + '  ' + cb.tail.split('\n').pop());
  const ui = run('tools/college_baseball/cbase_ui.e2e.js');
  res.suites.ui = ui;
  console.log((ui.ok ? 'PASS ' : ui.skipped ? 'SKIP ' : 'FAIL ') + ui.file + '  ' + ui.tail.split('\n').pop());
  const ex = EXISTING.map((f) => { const r = run(f); console.log((r.ok ? 'PASS ' : r.skipped ? 'SKIP ' : 'FAIL ') + f + '  ' + r.tail.split('\n').pop()); return r; });
  res.suites.existing_sports = { ok: ex.every((r) => r.ok), total: ex.length, passed: ex.filter((r) => r.ok).length, skipped: ex.filter((r) => r.skipped).length, results: ex };
  fs.writeFileSync(path.join(ROOT, 'college_baseball', 'validation', 'test_results.json'), JSON.stringify(res, null, 1) + '\n');
  const allOk = cb.ok && ui.ok && res.suites.existing_sports.ok;
  console.log(allOk ? 'ALL SUITES PASS' : 'SOME SUITES FAILED OR SKIPPED');
  process.exit(cb.ok ? 0 : 1);
}

main();
