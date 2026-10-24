#!/usr/bin/env node
/* ===========================================================================
   THE FBS-vs-FCS EXPERIMENT (H-014) and its forward tests (H-015, H-016):
   no fold reads a later season, the committed evidence is what the script
   produces, the shadow map is never priced, and the forward tests sign an
   FBS side correctly whether it is home or away.
   football/cfb_p4/research/fcs_uncapped.js · docs/market-intelligence/FCS_UNCAPPED.md

   Run: node tools/market_intel/fcs_experiment.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const X = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'fcs_uncapped.js'));
const L = require(path.join(ROOT, 'lib', 'edgedesk_validation_lab.js'));
const VR = require(path.join(ROOT, 'tools', 'market_intel', 'validation_report.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function section(t) { console.log('· ' + t); }

section('the walk-forward');
const rep = X.run();
{
  chk('the folds pass the separation check', rep.folds.separated === true && rep.folds.problems === 0, rep.folds);
  const D = X.load();
  chk('each test season is fitted on exactly the games of earlier seasons (2012 onward)', rep.seasons.every((s) => s.n_train === D.rows.filter((r) => r.season < s.season).length), rep.seasons.map((s) => [s.season, s.n_train]));
  chk('the test seasons are 2016-2025, ten of them', rep.seasons.length === 10 && rep.seasons[0].season === 2016 && rep.seasons[9].season === 2025);
  chk('every game is an FBS-vs-FCS game in FBS-team points with a final and a replay margin', D.rows.every((r) => Number.isFinite(r.raw) && Number.isFinite(r.final)), D.rows.length);
  const F = X.fit([{ raw: 10, final: 15 }, { raw: 20, final: 23 }, { raw: 30, final: 31 }]);
  chk('the shift candidate is the mean residual; the affine one is ordinary least squares', Math.abs(F.C1_shift.a - 3) < 1e-9 && F.C1_shift.b === 1 && Math.abs(F.C2_affine.b - 0.8) < 1e-9 && Math.abs(F.C2_affine.a - 7) < 1e-9, F);
  for (const p of [0.6, 0.9, 0.99, 0.999]) chk('the inverse normal round-trips at ' + p, Math.abs(L.normalCdf(X.qnorm(p)) - p) < 1e-6);
}

section('the judgement and the committed evidence');
{
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'fcs_uncapped_cfb.json'), 'utf8'));
  /* the parts that decide H-014 read 2012-2025 only; the 2026 checks move with every graded game, so they are
     regenerated, not compared. A mismatch here means the historical inputs changed: re-run the experiment. */
  const fixed = (x) => JSON.stringify({ folds: x.folds, seasons: x.seasons, pooled: x.pooled, chosen: x.chosen, hypotheses: x.hypotheses, final_map: x.final_map });
  chk('the committed evidence for H-014 is what the script produces from the committed 2012-2025 data (else re-run fcs_uncapped.js --write)', fixed(committed) === fixed(rep));
  const h = rep.hypotheses['H-014'];
  chk('H-014 is judged on its registered rule: an interval above -0.5 is not accepted', !(h.status === 'ACCEPTED' && !(h.result.ci[1] < -0.5)), h);
  chk('the reported repo bar is the v12 rule (>= 0.05 pts and a majority of years)', Object.values(rep.pooled).every((p) => p.repo_bar.met === (p.mae_candidate - p.mae_raw <= -0.05 && p.seasons_better > p.seasons / 2)));
  global.window = global.window || global;
  const M = require(path.join(ROOT, 'football', 'cfb_p4', 'fcs_margin_map.js'));
  chk('the shadow map records the judgement: survived only if ACCEPTED, never promoted', M.survived === (rep.status === 'ACCEPTED') && M.promoted === false && M.status === rep.status, M);
  chk('the shadow map carries the final fit and names its evidence', M.map.a === rep.final_map.a && M.map.b === rep.final_map.b && M.evidence === 'football/validation/fcs_uncapped_cfb.json');
  const readers = cp.execFileSync('git', ['grep', '-l', 'fcs_margin_map', '--', '*.js', '*.ts', '*.html', '*.py'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    .filter((f) => !/^(football\/cfb_p4\/research\/fcs_uncapped\.js|tools\/market_intel\/(validation_report|fcs_experiment\.test)\.js|football\/cfb_p4\/fcs_margin_map\.js)$/.test(f));
  chk('nothing outside the experiment and the report reads the map: it never reaches a price', readers.length === 0, readers);
}

section('the forward tests sign the FBS side correctly');
{
  const row = (fbsHome, model, final, week) => ({ group: 'fbs_fcs', fbs_home: fbsHome, model_margin: fbsHome ? model : -model, margin: fbsHome ? final : -final, cluster: 'w' + week });
  const rows = [];
  for (let w = 1; w <= 6; w++) for (let i = 0; i < 6; i++) rows.push(row(i % 2 === 0, 20, 25, w));
  const r16 = VR.TESTS.fcs_fixed_shift_mae_vs_raw(rows, { data: { shift: 5 } });
  chk('H-016: a 5-point shift on a 5-point shortfall removes the error, home or away FBS side', r16.n === 36 && Math.abs(r16.a_mean) < 1e-9 && Math.abs(r16.b_mean - 5) < 1e-9 && r16.verdict === 'A_LOWER', r16);
  const none = VR.TESTS.fcs_fixed_shift_mae_vs_raw(rows, { data: {} });
  chk('H-016 without a frozen shift is INSUFFICIENT_EVIDENCE, never a default', none.verdict === 'INSUFFICIENT_EVIDENCE');
  const fbsfbs = VR.TESTS.fcs_fixed_shift_mae_vs_raw(rows.map((r) => Object.assign({}, r, { group: 'p4' })), { data: { shift: 5 } });
  chk('H-016 reads FBS-vs-FCS games only', fbsfbs.n === 0);
  const r15 = VR.TESTS.fcs_map_mae_vs_raw(rows);
  chk('H-015 waits for a surviving map: with none, INSUFFICIENT_EVIDENCE', rep.status === 'ACCEPTED' ? r15.n === 36 : r15.verdict === 'INSUFFICIENT_EVIDENCE', r15.verdict);
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'FBS-vs-FCS experiment — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
