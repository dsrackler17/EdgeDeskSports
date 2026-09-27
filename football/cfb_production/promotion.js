#!/usr/bin/env node
/* ============================================================================
   CFB production — the promotion guard (brief §76; docs/cfb-production/VERSIONING.md §4).

   `node football/cfb_lab/governance.js promote --model <version> ...` runs this
   first and refuses unless every check passes. Latest never means production:

     1 explicit version     a full edgedesk_cfb_* semantic version, never
                            "latest", a label or a prefix
     2 registered           a governance role exists; not already champion;
                            never straight from retired
     3 compatible           a COMPATIBLE entry in compatibility.json for this
                            version (PRODUCTION_PATHWAY; FALLBACK only with
                            --rollback, the documented return to V1)
     4 artifact             the artifact exists and verifies against its
                            MANIFEST and the pinned manifest hash (pathway), or
                            the pinned params (fallback)
     5 schema + calibration every compatibility check of the tuple holds
                            (feature schema, calibration, ensemble, market
                            engine, decision policy / calibration / engine)
     6 tests                the release checklist's test item is PASS (run
                            here, or a recorded result passed in)
     7 shadow complete      the Model Lab's promotion evaluation for this
                            version is ELIGIBLE on a sufficient live sample
                            (skipped only for --rollback to the previous champion)

     node football/cfb_production/promotion.js --model <version> [--rollback] [--skip-tests-with <release_check.json>]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./compat.js');

const REPO = C.REPO;
const VERSION_RE = /^edgedesk_cfb_(p4_)?v\d+\.\d+\.\d+$/;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function seasonFor(d) { d = d || new Date(); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

/* opts: { roles (governance currentRoles), rollback, matrix, facts, lab (lab.json), tests: { ok, detail } | 'run', repo } */
function guard(model, opts) {
  opts = opts || {};
  const repo = opts.repo || REPO;
  const out = [];
  const add = (n, check, ok, detail) => out.push({ n, check, ok: !!ok, detail: detail || null });
  add(1, 'explicit version', typeof model === 'string' && VERSION_RE.test(model), 'got ' + JSON.stringify(model) + '; want edgedesk_cfb_[p4_]vMAJOR.MINOR.PATCH');
  const roles = opts.roles || {};
  const r = roles[model];
  add(2, 'registered, not champion, not retired', r && r.role !== 'champion' && r.role !== 'retired', r ? 'role ' + r.role : 'not registered');
  const matrix = opts.matrix || C.loadMatrix();
  const ents = ((matrix && matrix.entries) || []).filter((e) => e.model_version === model && e.status === 'COMPATIBLE');
  const e = ents.find((x) => x.role === 'PRODUCTION_PATHWAY') || (opts.rollback ? ents.find((x) => x.role === 'FALLBACK') : null) || null;
  add(3, 'a COMPATIBLE compatibility entry' + (opts.rollback ? ' (rollback: FALLBACK allowed)' : ''), !!e,
    e ? e.role : (ents.length ? 'only ' + ents.map((x) => x.role).join(', ') + (opts.rollback ? '' : ' (FALLBACK needs --rollback)') : 'no COMPATIBLE entry'));
  const f = opts.facts || C.facts({ repo });
  if (e && e.role === 'PRODUCTION_PATHWAY') {
    const artDir = path.join(repo, 'football', 'cfb_v2', 'artifacts', model);
    const v = C.verifyArtifactDir(artDir);
    add(4, 'artifact exists and verifies (MANIFEST and the pinned hash)', v.ok && v.manifest_sha256 === e.artifact_manifest_sha256 && f.production_model_version === model,
      !v.ok ? v.reason : (v.manifest_sha256 !== e.artifact_manifest_sha256 ? 'MANIFEST is not the pinned one' : (f.production_model_version !== model ? 'the production pathway runs ' + f.production_model_version + ', not ' + model : 'verifies')));
    const bad = f.production_model_version === model ? C.check(f, matrix).filter((c) => !c.ok) : [{ check: 'the pathway runs another model', code: 'MODEL_ARTIFACT' }];
    add(5, 'schema, calibration, ensemble, market and decision compatibility', !bad.length, bad.map((c) => c.check + ' [' + c.code + ']').join('; ') || 'every check holds');
  } else if (e && e.role === 'FALLBACK') {
    add(4, 'fallback artifact present and pinned', f.v1.present && f.v1.model_version === model && f.v1.params_sha256 === e.params_sha256, 'V1 params ' + String(f.v1.params_sha256).slice(0, 12));
    add(5, 'fallback feature schema pinned', f.v1.feature_version === e.feature_version, f.v1.feature_version + ' vs ' + e.feature_version);
  } else {
    add(4, 'artifact exists and verifies', false, 'no compatible entry to verify against');
    add(5, 'schema and calibration compatibility', false, 'no compatible entry');
  }
  let t = opts.tests;
  if (t === 'run') {
    const RC = require(path.join(repo, 'tools', 'cfb', 'release_check.js'));
    const it = RC.check({ skipTests: false }).items.find((x) => x.n === 1);
    t = { ok: it && it.status === 'PASS', detail: it ? it.detail : 'no test item' };
  }
  add(6, 'tests pass (release checklist item 1)', !!(t && t.ok), t ? String(t.detail || '').split('\n').filter((l) => !/^ok /.test(l)).slice(0, 5).join('; ') || 'PASS' : 'no test result (run with tests: "run")');
  if (opts.rollback && e && e.role === 'FALLBACK') add(7, 'shadow evaluation (not required to return to the previous champion)', true, 'rollback');
  else {
    const lab = opts.lab || readJson(path.join(repo, 'football', 'cfb_lab', 'reports', String(opts.season || seasonFor()), 'lab.json'));
    const ev = lab && lab.comparison && lab.comparison.promotion && (lab.comparison.promotion.evaluations || []).find((x) => x.challenger === model);
    add(7, 'shadow evaluation complete (Model Lab promotion evaluation ELIGIBLE)', !!(ev && ev.decision === 'ELIGIBLE' && ev.ready),
      ev ? ev.decision + ' (n ' + ev.n + ' of ' + ev.min_n + ')' : 'no promotion evaluation for ' + model + ' in lab.json');
  }
  return { model, ok: out.every((c) => c.ok), rollback: !!opts.rollback, checks: out, rule: 'cfb_promotion_guard_v1' };
}

module.exports = { guard, VERSION_RE };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const G = require(path.join(REPO, 'football', 'cfb_lab', 'ledger.js'));
  const GOV = require(path.join(REPO, 'football', 'cfb_lab', 'governance.js'));
  const cfg = readJson(path.join(REPO, 'football', 'cfb_lab', 'config.json')) || {};
  const store = new G.Store(Number(arg('--season', cfg.season || seasonFor())));
  const recorded = arg('--skip-tests-with', null);
  const res = guard(arg('--model'), { roles: GOV.currentRoles(store.gov('model_roles')), rollback: a.includes('--rollback'),
    tests: recorded ? (() => { const j = readJson(recorded); const it = j && (j.items || []).find((x) => x.n === 1); return { ok: !!(it && it.status === 'PASS'), detail: 'recorded ' + recorded }; })() : 'run' });
  res.checks.forEach((c) => console.log((c.ok ? 'PASS ' : 'FAIL ') + c.n + '. ' + c.check + ' — ' + (c.detail || '')));
  console.log(res.ok ? 'promotion guard: PASS' : 'promotion guard: REFUSED');
  process.exit(res.ok ? 0 : 1);
}
