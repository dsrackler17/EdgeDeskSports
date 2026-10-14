'use strict';
/* ===========================================================================
   EdgeDesk college baseball — release gates (Phase 16). Explicit PASS/FAIL.

     node college_baseball/release_gates.js           write validation/release_gates.json
     node college_baseball/release_gates.js --check   exit 1 unless every gate passes

   Every gate is computed from a committed artifact or an executed test, never
   typed. A gate that cannot be evaluated FAILS. Release of market pricing
   (anything shown as more than research) requires ALL sixteen; provisional
   research stays available with its limitations shown either way.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const SIM = require('./lib/simulator');
const PR = require('./lib/pricing');
const D = require('./lib/distribution');
const RD = require('./lib/readiness');
const S = require('../engine/stats');
const K = require('./ingest/common');

function readJson(f) { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function gate(id, name, pass, why, evidence) { return { id, name, status: pass ? 'PASS' : 'FAIL', why, evidence: evidence || null }; }

/* G13: stress — a synthetic 400-game day with extreme inputs must price every game, coherently, quickly */
function stress(constants) {
  const rand = S.rng(424242); const t0 = Date.now(); let bad = 0; let n = 0; const errs = [];
  for (let i = 0; i < 400; i++) {
    const lh = 0.6 + rand() * 16; const la = 0.6 + rand() * 16;
    try {
      const s = SIM.simulate({ lh, la, p7: rand() < 0.2 ? 1 : 0, run_rule_p: rand(), frailty: { team_k: 8, shared_k: 30 } }, constants, { n: 1500, seed: i + 1 });
      const p = PR.price(PR.fromJoint(s.joint), { f5: s.f5_joint }); const c = PR.coherence(p);
      if (!c.ok || !(p.moneyline.p_home > 0 && p.moneyline.p_home < 1)) { bad++; if (errs.length < 3) errs.push(c.errors.join('; ')); }
      const o = D.outcomes(lh, la, { family: 'nb', r: 6 }, constants); if (!isFinite(o.p_home)) bad++;
      n++;
    } catch (e) { bad++; errs.push(String(e.message)); }
  }
  /* degenerate games must be refused, not priced */
  const blocked = RD.assess({ home_id: '', away_id: 'x', quality: 'VERIFIED', status: 'FINAL' }, {}).states.RESEARCH_BLOCKED === true;
  const ms = Date.now() - t0;
  return { games: n, failures: bad, examples: errs, seconds: Math.round(ms / 100) / 10, per_game_ms: Math.round(ms / Math.max(1, n)), degenerate_blocked: blocked, ok: bad === 0 && blocked && ms / Math.max(1, n) < 250 };
}

function build() {
  const cov = readJson(C.PATHS.coverage); const qual = readJson(C.PATHS.quality); const audit = readJson(C.PATHS.audit); const wf = readJson(C.PATHS.walkforward);
  const pw = readJson(C.PATHS.pitcherEval); const dist = readJson(C.PATHS.distEval); const tests = readJson(path.join(C.PATHS.validation, 'test_results.json'));
  const auth = readJson(path.join(C.PATHS.research, 'authorizations.json'));
  const chk = (id) => (audit ? (audit.checks.find((c) => c.id === id) || {}).status : null);
  const constants = readJson(path.join(C.PATHS.params, 'constants.json'));
  const g = [];
  g.push(gate('G1', 'Source authorisation verified', !!(auth && auth.baseballr_data && auth.baseballr_data.commercial_use === true && auth.baseballr_data.signed_by),
    auth && auth.baseballr_data && auth.baseballr_data.commercial_use === true ? 'owner sign-off recorded' : 'commercial use of NCAA-derived data is not verified; the owner has not signed research/authorizations.json (research/LICENSING.md)', auth));
  {
    const lookupConf = qual ? qual.seasons.flatMap((s) => s.problems.filter((p) => /LOOKUP_DUPLICATE_CONFLICT|SEASON_TEAM_ID_SHARED/.test(p.kind))) : null;
    const box = qual ? qual.seasons.filter((s) => s.checks.box_team_unresolved).reduce((a, s) => a + s.checks.box_team_unresolved.n, 0) : null;
    g.push(gate('G2', 'Identifier reconciliation complete', qual && lookupConf.length === 0 && box === 0, qual ? `lookup conflicts ${lookupConf.length}; box teams unresolved ${box}; unidentified opponents are non-NCAA programs and are listed, never rated` : 'no quality report', { lookup_conflicts: lookupConf, box_unresolved: box }));
  }
  g.push(gate('G3', 'Dataset coverage audited', !!cov && fs.existsSync(path.join(C.PATHS.research, 'COVERAGE.md')), cov ? `${cov.totals.scheduled} contests audited; gaps listed in research/COVERAGE.md` : 'no coverage ledger', cov && cov.totals));
  {
    const rates = qual ? qual.seasons.map((s) => ({ season: s.season, conflict: s.checks.home_away_conflict_quarantined.rate, box: s.checks.box_players_do_not_sum_to_total ? s.checks.box_players_do_not_sum_to_total.rate : 0, outs: s.checks.pitching_outs_do_not_fit_innings ? s.checks.pitching_outs_do_not_fit_innings.rate : 0 })) : [];
    const bad = rates.filter((x) => x.conflict > 0.02 || x.box > 0.01 || x.outs > 0.01);
    g.push(gate('G4', 'Critical data-quality tests pass', qual && bad.length === 0, bad.length ? 'thresholds exceeded: ' + bad.map((x) => x.season).join(', ') : 'conflict rate <= 2%, box total mismatches <= 1%, impossible pitching outs <= 1% in every season', rates));
  }
  g.push(gate('G5', 'Zero known look-ahead leakage', chk('LEAKAGE') === 'PASS' && chk('TIMESTAMPS') === 'PASS', `audit LEAKAGE ${chk('LEAKAGE')}, TIMESTAMPS ${chk('TIMESTAMPS')}`));
  g.push(gate('G6', 'Starter and bullpen handling validated', !!pw && chk('STARTERS') === 'PASS' && chk('BULLPEN_ASSUMPTIONS') === 'PASS', pw ? `starter projection, availability calibration and the hybrid test exist; audit STARTERS ${chk('STARTERS')}, BULLPEN ${chk('BULLPEN_ASSUMPTIONS')}` : 'no pitcher walk-forward', pw && { chosen: pw.selection.chosen, starter_projection: pw.starter_projection.SELECTION && pw.starter_projection.SELECTION.all }));
  g.push(gate('G7', 'Season-specific game rules tested', chk('GAME_RULES') === 'PASS' && !!(tests && tests.suites && tests.suites.college_baseball && tests.suites.college_baseball.ok), `audit GAME_RULES ${chk('GAME_RULES')}; rules unit tests ${tests && tests.suites && tests.suites.college_baseball ? (tests.suites.college_baseball.ok ? 'pass' : 'FAIL') : 'not run'}`));
  const holdout = wf && wf.windows_report && wf.windows_report.HOLDOUT && !wf.windows_report.HOLDOUT.withheld;
  g.push(gate('G8', 'Chronological evaluation complete', !!wf && !!holdout && wf.leakage.ok, holdout ? 'SELECTION, VALIDATION and HOLDOUT scored' : 'the HOLDOUT has not been evaluated for this model version'));
  {
    const v = wf && wf.comparisons && wf.comparisons.VALIDATION && wf.comparisons.VALIDATION.chosen_vs_best_baseline; const h = wf && wf.comparisons && wf.comparisons.HOLDOUT && wf.comparisons.HOLDOUT.chosen_vs_best_baseline;
    g.push(gate('G9', 'Models compared against baselines', !!(v && v.a_better && h && h.a_better), `chosen vs best baseline: VALIDATION ${v ? JSON.stringify(v.ci95) : 'n/a'}, HOLDOUT ${h ? JSON.stringify(h.ci95) : 'n/a'} (95% interval of the log-loss difference must be below 0 in both)`, { validation: v, holdout: h }));
  }
  g.push(gate('G10', 'Probability calibration verified', !!(wf && wf.status && wf.status.moneyline.status === 'OUTCOME_VALIDATED'), wf && wf.status ? `moneyline ${wf.status.moneyline.status}${wf.status.moneyline.failed.length ? ': ' + wf.status.moneyline.failed.join('; ') : ''}` : 'no holdout status'));
  {
    const cv = dist && dist.scores && dist.scores.VALIDATION[dist.chosen] && dist.scores.VALIDATION[dist.chosen].total_coverage_80;
    g.push(gate('G11', 'Scoring distribution consistency verified', chk('TAILS') === 'PASS' && cv != null && cv >= 0.77 && cv <= 0.83, `audit TAILS ${chk('TAILS')}; 80% total interval coverage ${cv}`));
  }
  {
    const profiles = Object.values(PR.SETTLEMENT_PROFILES); const verified = profiles.some((p) => p.status === 'VERIFIED');
    g.push(gate('G12', 'Market settlement verified', verified && false, 'no sportsbook settlement rules verified and no authorised baseball_ncaa feed; pushes and conditional prices are unit-tested, but settlement against a real book is unverified', { profiles: Object.keys(PR.SETTLEMENT_PROFILES) }));
  }
  const st = constants ? stress(constants) : { ok: false, error: 'no constants' };
  g.push(gate('G13', 'Stress tests', st.ok, st.ok ? `400 synthetic games priced coherently, ${st.per_game_ms} ms each; degenerate games blocked` : 'stress failures: ' + JSON.stringify(st.examples || st.error), st));
  {
    const ui = tests && tests.suites && tests.suites.ui; const api = tests && tests.suites && tests.suites.college_baseball;
    g.push(gate('G14', 'Frontend and API tests', !!(ui && ui.ok && api && api.ok), tests ? `college-baseball suite ${api ? (api.ok ? 'pass' : 'FAIL') : 'not run'}; UI ${ui ? (ui.ok ? 'pass' : 'FAIL') : 'not run'} (at ${tests.ran_at})` : 'tests have not been run (tools/college_baseball/run_tests.js)'));
  }
  {
    const ex = tests && tests.suites && tests.suites.existing_sports;
    g.push(gate('G15', 'Existing EdgeDesk sports still work', !!(ex && ex.ok), ex ? `${ex.passed}/${ex.total} existing suites pass` : 'existing suites not run', ex));
  }
  {
    const f = path.join(C.PATHS.ROOT, 'docs', 'college-baseball', 'DEPLOYMENT.md'); const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    g.push(gate('G16', 'Deployment and rollback documented', /##\s*Deploy/i.test(t) && /##\s*Rollback/i.test(t), t ? 'docs/college-baseball/DEPLOYMENT.md has Deploy and Rollback sections' : 'no deployment document'));
  }
  const failing = g.filter((x) => x.status === 'FAIL').map((x) => x.id);
  return { schema: 'edgedesk_cbase_release_gates_v1', model_version: C.MODEL_VERSION, generated_at: new Date().toISOString(), gates: g, release_allowed: failing.length === 0, failing,
    summary: failing.length ? `RELEASE BLOCKED: ${failing.length} of ${g.length} gates fail (${failing.join(', ')}). Provisional research only.` : 'All gates pass.' };
}

/* the terminal's advanced view reads board/research.json: keep it in step with the gates */
function refreshResearch() {
  const board = path.join(__dirname, 'board');
  if (fs.existsSync(path.join(board, 'index.json'))) K.writeJson(path.join(board, 'research.json'), require('./build_slate').research());
}

function main() {
  const res = build();
  K.writeJson(C.PATHS.gates, res);
  for (const x of res.gates) console.log(`${x.status} ${x.id} ${x.name}: ${x.why}`);
  console.log(res.summary);
  refreshResearch();
  if (process.argv.includes('--check') && !res.release_allowed) process.exit(1);
}

if (require.main === module) main();
module.exports = { build, stress, refreshResearch };
