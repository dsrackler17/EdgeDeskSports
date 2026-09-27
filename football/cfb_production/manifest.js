#!/usr/bin/env node
/* ============================================================================
   CFB production — the immutable production manifest
   (docs/cfb-production/VERSIONING.md §1).

   Answers "what exact system produced this prediction?" from what is on disk,
   hashed, never from what someone typed:

     champion_model_version   the governance champion (football/cfb_lab/
                              governance/model_roles.jsonl): V1
     champion_selection       NOT_RUN — no Model Championship has been run in
                              this project; the champion is the one governance
                              records, and V2.1 is ELIGIBLE_FOR_PROMOTION until a
                              person runs `node football/cfb_lab/governance.js promote`
     production_model_version the production pathway's pure model (V2.1 frozen
                              artifact) and its status
     git_commit / git_dirty   HEAD and whether the tree differed from it
     migration_version        one hash over every supabase/cfb_*.sql (+ each file)
     feature / training-data / team-rating / player-model / matchup-model /
     ensemble / calibration / uncertainty / market-engine / decision-policy /
     decision-engine versions
     artifact_hashes          sha256 + git blob of every artifact file
     compatibility            the matrix entry and the result of checking it
     fallback_hierarchy       the explicit champion fallback order
     deployed_at              when this manifest was deployed

   content_sha256 hashes everything except the deployment time and the git
   fields, so --check can tell "artifacts changed without a new manifest"
   apart from "same system, new commit".

     node football/cfb_production/manifest.js                 print it
     node football/cfb_production/manifest.js --write         write manifest.json
     node football/cfb_production/manifest.js --check         exit 1 if manifest.json is stale
     node football/cfb_production/manifest.js --push          record it in Postgres (write-once)
     node football/cfb_production/manifest.js --write-compat  (re)write compatibility.json
          [--deployed-at ISO] [--reason "..."] [--supersedes cfbm_...]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./compat.js');

const REPO = C.REPO;
const OUT = path.join(__dirname, 'manifest.json');
const CONTENT_EXCLUDE = ['deployed_at', 'git_commit', 'git_dirty', 'git_dirty_paths', 'manifest_id', 'content_sha256', 'recorded_by', 'supersedes', 'reason'];

function git(args, repo) {
  try { return cp.execFileSync('git', args, { cwd: repo || REPO, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(); } catch (e) { return null; }
}
function gitBlob(file) {
  return git(['hash-object', file]);
}
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function regex(file, re) { try { return (re.exec(fs.readFileSync(file, 'utf8')) || [])[1] || null; } catch (e) { return null; } }

/* governance roles, the Model Lab's rule: sorted by effective_at, the last event per model wins */
function roles(repo) {
  const ev = readJsonl(path.join(repo || REPO, 'football', 'cfb_lab', 'governance', 'model_roles.jsonl'))
    .sort((a, b) => Date.parse(a.effective_at) - Date.parse(b.effective_at));
  const out = {};
  ev.forEach((e) => { out[e.model_version] = { role: e.role, label: e.model_label, effective_at: e.effective_at, actor: e.actor }; });
  return out;
}

function fileEntry(abs) {
  const st = fs.statSync(abs);
  return { sha256: C.shaFile(abs), git_blob: gitBlob(abs), bytes: st.size };
}

/* every file whose bytes decide a prediction or a decision on the production pathway */
function artifactFiles(f, repo) {
  repo = repo || REPO;
  const list = [];
  const add = (p) => { if (fs.existsSync(path.join(repo, p))) list.push(p); };
  const art = f.artifact.dir;
  fs.readdirSync(path.join(repo, art)).sort().forEach((x) => add(art + '/' + x));
  add('football/cfb_v2/params.js');
  add('football/cfb_v2/engine.js');
  add('football/cfb_v2/artifacts/weekly/expected_margin_v1.json');
  if (f.decision_policy) add('football/cfb_v2/artifacts/decision/' + f.decision_policy.dir + '/policy.json');
  if (f.decision_baseline) add('football/cfb_v2/artifacts/decision/' + f.decision_baseline.dir + '/MANIFEST.json');
  add('football/cfb_decision/decision.js');
  add('football/cfb_p4/params.js');                     // V1: the champion and fallback
  add('football/cfb_production/compatibility.json');
  const out = {};
  list.forEach((p) => { out[p] = fileEntry(path.join(repo, p)); });
  return out;
}

function migrations(repo) {
  const dir = path.join(repo || REPO, 'supabase');
  const files = fs.readdirSync(dir).filter((x) => /^cfb_[a-z0-9_]+\.sql$/.test(x)).sort();
  const out = {};
  files.forEach((x) => { out['supabase/' + x] = fileEntry(path.join(dir, x)); });
  const version = 'cfbmig_' + C.sha(files.map((x) => x + ':' + out['supabase/' + x].sha256).join('\n')).slice(0, 16);
  return { version, files: out };
}

function build(opts) {
  opts = opts || {};
  const repo = opts.repo || REPO;
  const f = C.facts({ repo });
  const matrix = opts.matrix || C.loadMatrix();
  const checks = C.check(f, matrix);
  const R = roles(repo);
  const champs = Object.keys(R).filter((k) => R[k].role === 'champion');
  if (champs.length !== 1) throw new Error('governance must name exactly one champion; found ' + JSON.stringify(champs));
  const champion = champs[0];
  const mv = f.production_model_version;
  const P = C.readParams(path.join(repo, 'football', 'cfb_v2', 'params.js'));
  const artDir = path.join(repo, f.artifact.dir);
  const meta = readJson(path.join(artDir, 'meta.json')) || {};
  const models = readJson(path.join(artDir, 'models.json')) || {};
  const baseline = f.decision_baseline ? readJson(path.join(repo, 'football/cfb_v2/artifacts/decision', f.decision_baseline.dir, 'MANIFEST.json')) : null;
  const teamRule = regex(path.join(repo, 'football/cfb_v2/research/v2/weekly/team_state.py'), /STATE_RULE_VERSION = '([^']+)'/);
  const qbRule = regex(path.join(repo, 'football/cfb_v2/research/v2/weekly/qb_state.py'), /RULE_VERSION = '([^']+)'/);
  const matchupResid = regex(path.join(repo, 'football/cfb_v2/research/v2/matchup/__init__.py'), /RESIDUAL_MODEL_VERSION = '([^']+)'/);
  const personnelRule = regex(path.join(repo, 'football/cfb_v2/research/v2/personnel/__init__.py'), /RULE_VERSION = '([^']+)'/);
  const gbm = f.artifact.files['gbm_D.txt'] || null;
  const H = (o) => C.hashObj(o).slice(0, 12);
  const trainData = baseline && baseline.data ? Object.fromEntries(Object.entries(baseline.data).map(([k, v]) => [k, v.content_sha256])) : {};
  const w = meta.windows || {};
  const span = (a) => (Array.isArray(a) && a.length ? a[0] + '-' + a[a.length - 1] : 'none');

  const m = {
    manifest_schema: 'cfb_production_manifest_v1',
    champion_model_version: champion,
    champion_label: R[champion].label || null,
    champion_selection: 'NOT_RUN',
    champion_selection_note: 'No Model Championship has been run in this project. The champion is the governance record ('
      + 'football/cfb_lab/governance/model_roles.jsonl); ' + mv + ' is ' + (f.promotion_decision || 'unknown')
      + ' and becomes champion only when a person runs: node football/cfb_lab/governance.js promote --model ' + mv + ' --reason "..." --actor <name>',
    production_model_version: mv,
    production_model_status: (f.promotion_decision || 'UNKNOWN') + '; governance role ' + ((R[mv] && R[mv].role) || 'unregistered'),
    production_pathway: {
      pure_model: mv, engine: P && P.engine, artifact_dir: f.artifact.dir, weekly_engine: 'football/cfb_v2/research/v2/weekly (run.py)',
      model_lab: 'football/cfb_lab (hourly checkpoints, settlement, governance)',
      decision_engine: 'football/cfb_decision/decision.js ' + f.decision_engine_version + ' (shadow)',
      betting: (f.decision_policy && f.decision_policy.bet_enabled) ? 'ENABLED by the decision policy' : 'DISABLED (fail-safe policy ' + (f.decision_policy && f.decision_policy.version) + ')',
    },
    feature_version: f.feature_version,
    training_data_version: 'trained_through_' + (models.trained_through || (P && P.trained_through)) + '/dev' + span(w.dev) + '/holdout' + span(w.holdout)
      + '/seed' + meta.seed + ':' + H({ windows: w, trained_through: models.trained_through, seed: meta.seed, garbage: meta.garbage, data: trainData }),
    team_rating_version: (teamRule || 'cfb_team_state_?') + '+ratings:' + H({ prior_scale: meta.prior_scale, recent_halflife_weeks: meta.recent_halflife_weeks, garbage: meta.garbage }),
    player_model_version: 'qb_level:' + H({ qb: P && P.qb, qb_common: P && P.qb_common, injury: P && P.injury, qb_shrinkage: meta.qb_shrinkage })
      + (qbRule ? '+' + qbRule : '') + ' (personnel units ' + (personnelRule || '?') + ': research, not an input)',
    matchup_model_version: 'D_gbm:' + String(gbm).slice(0, 12) + ' (matchup residual ' + (matchupResid || '?') + ': research, not an input)',
    ensemble_version: f.ensemble_version,
    ensemble_weights: f.stack_weights,
    calibration_version: f.calibration_version,
    uncertainty_version: mv + ':' + H({ distribution: P && P.distribution, reliability: P && P.reliability, sigma_model: models.sigma_model,
      abs_z_quantiles: models.abs_z_quantiles, injury_var: P && P.injury && P.injury.var_pts_per_unit, weather: P && P.weather }),
    market_engine_version: f.market_engine_version,
    decision_policy_version: f.decision_policy && f.decision_policy.version,
    decision_policy: f.decision_policy,
    decision_engine_version: f.decision_engine_version,
    decision_baseline: f.decision_baseline ? { version: f.decision_baseline.version, base_model_version: f.decision_baseline.base_model_version, ok: f.decision_baseline.ok } : null,
    model_lab_versions: { ensemble_version_recorded_by_lab: f.lab_ensemble_version,
      note: f.lab_ensemble_version !== f.ensemble_version ? 'the Model Lab derives ensemble_version from params.js, which carries no stack weights: its value is the hash of {} and identifies no ensemble (VERSIONING.md §5); this manifest hashes models.json stack_weights' : null },
    v1_fallback: f.v1,
    artifact_hashes: artifactFiles(f, repo),
    migration_version: null,
    migrations: null,
    compatibility: { entry: ((matrix && matrix.entries) || []).find((e) => e.model_version === mv && e.status === 'COMPATIBLE') || null,
      checks: checks.map((c) => ({ check: c.check, ok: c.ok, code: c.code })), ok: checks.every((c) => c.ok) },
    fallback_hierarchy: [
      { level: 1, mode: 'FULL', model_version: mv, when: 'V2.1 artifact verifies, inputs pass the contract, every source fresh', display: 'FULL' },
      { level: 2, mode: 'DEGRADED', model_version: mv, when: 'a validated degraded mode of the weekly engine (DEGRADED_PBP / DEGRADED_AVAILABILITY / DEGRADED_MARKET): reliability capped, BET never issued', display: 'the mode, always shown' },
      { level: 3, mode: 'FALLBACK_MODEL', model_version: champion, when: 'V2.1 inference unavailable (artifact / compatibility / input contract failure): the previous stable champion (governance champion V1, football/fbs/slate.json)', display: 'FALLBACK_MODEL — V1' },
      { level: 4, mode: 'UNAVAILABLE', model_version: null, when: 'neither model can produce a trustworthy projection', display: 'Prediction unavailable (never a substitute number)' },
    ],
    fallback_rules: ['No level substitutes a model that is not listed here (candidate edgedesk_cfb_v2.0.0 is never a fallback).',
      'Every level below FULL displays its mode; decisions at levels 2-4 are PASS / UNAVAILABLE with the reason, never BET.'],
    deployed_at: opts.deployedAt || new Date().toISOString(),
    recorded_by: opts.recordedBy || 'football/cfb_production/manifest.js',
  };
  const mig = migrations(repo);
  m.migration_version = mig.version;
  m.migrations = mig.files;
  const head = git(['rev-parse', 'HEAD'], repo);
  const dirty = (git(['status', '--porcelain'], repo) || '').split('\n').filter(Boolean);
  m.git_commit = head;
  m.git_dirty = dirty.length > 0;
  m.git_dirty_paths = dirty.slice(0, 50).map((l) => l.slice(3));
  if (opts.supersedes) { m.supersedes = opts.supersedes; m.reason = opts.reason || null; }
  m.content_sha256 = contentHash(m);
  m.manifest_id = 'cfbm_' + C.sha(m.content_sha256 + '|' + m.deployed_at).slice(0, 24);
  return m;
}

function contentHash(m) {
  const o = {};
  Object.keys(m).filter((k) => !CONTENT_EXCLUDE.includes(k)).forEach((k) => { o[k] = m[k]; });
  return C.sha(C.canonical(o));
}

/* Is this manifest true of the files on disk? (content hash, every artifact, the compatibility checks) */
function verify(m, opts) {
  opts = opts || {};
  const repo = opts.repo || REPO;
  const problems = [];
  if (!m || m.manifest_schema !== 'cfb_production_manifest_v1') return ['not a cfb_production_manifest_v1'];
  if (contentHash(m) !== m.content_sha256) problems.push('content_sha256 does not match the manifest body (edited after it was generated)');
  if ('cfbm_' + C.sha(m.content_sha256 + '|' + m.deployed_at).slice(0, 24) !== m.manifest_id) problems.push('manifest_id does not match content and deployment time');
  if (m.champion_selection !== 'NOT_RUN' && !m.championship_evidence) problems.push('champion_selection ' + m.champion_selection + ' without championship evidence');
  for (const [p, e] of Object.entries(m.artifact_hashes || {})) {
    const abs = path.join(repo, p);
    if (!fs.existsSync(abs)) { problems.push('artifact missing: ' + p); continue; }
    if (p === 'football/cfb_production/compatibility.json' && opts.ignoreCompat) continue;
    const h = C.shaFile(abs);
    if (h !== e.sha256) problems.push('artifact hash differs: ' + p + ' (manifest ' + e.sha256.slice(0, 12) + ', disk ' + h.slice(0, 12) + ')');
  }
  if (m.compatibility && m.compatibility.ok === false) problems.push('the manifest was generated with failing compatibility checks: ' + m.compatibility.checks.filter((c) => !c.ok).map((c) => c.check).join('; '));
  return problems;
}

/* Disaster recovery: can the artifacts be restored from git, byte for byte? (the manifest pins git blobs) */
function verifyFromGit(m, opts) {
  opts = opts || {};
  const problems = [];
  for (const [p, e] of Object.entries(m.artifact_hashes || {})) {
    if (!e.git_blob) { problems.push('no git blob recorded for ' + p); continue; }
    let buf = null;
    try { buf = cp.execFileSync('git', ['cat-file', 'blob', e.git_blob], { cwd: opts.repo || REPO, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch (err) { buf = null; }
    if (!buf) { problems.push('git has no blob ' + e.git_blob + ' for ' + p + ' (commit it, or restore from a clone that has it)'); continue; }
    if (C.sha(buf) !== e.sha256) problems.push('git blob ' + e.git_blob + ' does not hash to the manifest sha256 for ' + p);
  }
  return problems;
}

/* the Postgres row (supabase/cfb_production.sql cfb_production_model_manifest) */
function row(m) {
  return {
    manifest_id: m.manifest_id, content_sha256: m.content_sha256, champion_model_version: m.champion_model_version,
    champion_selection: m.champion_selection, production_model_version: m.production_model_version,
    production_model_status: m.production_model_status, git_commit: m.git_commit, git_dirty: m.git_dirty,
    migration_version: m.migration_version, migrations: m.migrations, feature_version: m.feature_version,
    training_data_version: m.training_data_version, team_rating_version: m.team_rating_version,
    player_model_version: m.player_model_version, matchup_model_version: m.matchup_model_version,
    ensemble_version: m.ensemble_version, calibration_version: m.calibration_version, uncertainty_version: m.uncertainty_version,
    market_engine_version: m.market_engine_version, decision_policy_version: m.decision_policy_version,
    decision_engine_version: m.decision_engine_version, artifact_hashes: m.artifact_hashes, compatibility: m.compatibility,
    fallback_hierarchy: m.fallback_hierarchy, deployed_at: m.deployed_at, supersedes: m.supersedes || null, reason: m.reason || null,
    payload: m,
  };
}

/* matrix rows for Postgres (cfb_compatibility_matrix) */
function matrixRows(matrix) {
  return ((matrix && matrix.entries) || []).map((e) => ({
    row_id: 'cfbcm_' + C.sha([e.model_version, e.feature_version, e.calibration_version || '-', e.decision_policy_version || '-',
      e.decision_engine_version || '-', e.market_engine_version || '-', e.status, e.decided_at].join('|')).slice(0, 24),
    model_version: e.model_version, feature_version: e.feature_version, calibration_version: e.calibration_version || '-',
    decision_policy_version: e.decision_policy_version || '-', decision_engine_version: e.decision_engine_version || '-',
    market_engine_version: e.market_engine_version || '-', status: e.status, evidence: e.evidence, decided_by: e.decided_by,
    decided_at: e.decided_at, payload: e,
  }));
}

async function push(m, opts) {
  opts = opts || {};
  const DB = require('./db.js');
  const url = opts.url || process.env.SB_URL, key = opts.key || process.env.SB_SERVICE_ROLE;
  if (!url || !key) return { skipped: 'no SB_URL / SB_SERVICE_ROLE' };
  const io = { fetch: opts.fetch, log: opts.log };
  const n1 = await DB.postRows(url, key, 'cfb_compatibility_matrix', 'row_id', matrixRows(opts.matrix || C.loadMatrix()), io);
  const n2 = await DB.postRows(url, key, 'cfb_production_model_manifest', 'manifest_id', [row(m)], io);
  return { matrix_rows: n1, manifest_rows: n2, manifest_id: m.manifest_id };
}

/* a fresh compatibility.json from the verified state on disk (a governed act: VERSIONING.md §3) */
function compatFile(opts) {
  opts = opts || {};
  const f = C.facts({ repo: opts.repo });
  const at = opts.decidedAt || new Date().toISOString();
  const main = C.entryFor(f, {
    evidence: 'artifact ' + f.artifact.dir + ' verifies against its MANIFEST.json; params.promotion ' + f.promotion_decision
      + ' (backtest gates G1-G7 passed, report in params.js); decision baseline ' + (f.decision_baseline && f.decision_baseline.version)
      + ' was frozen on this model (base_model_version) with policy ' + (f.decision_policy && f.decision_policy.version)
      + ' (' + (f.decision_policy && f.decision_policy.status) + ', betting disabled). No Model Championship was run.',
    decided_by: opts.decidedBy || 'cfb production hardening (football/cfb_production/manifest.js --write-compat)',
    decided_at: at });
  if (!f.artifact.ok) throw new Error('refusing to pin an artifact that does not verify: ' + f.artifact.reason);
  if (f.decision_baseline && !f.decision_baseline.ok) throw new Error('refusing to pin a decision baseline whose files do not verify');
  return {
    schema: 'cfb_compatibility_matrix_v1',
    rule: 'An inference, a calibration, a decision policy or a market engine runs only as an explicitly COMPATIBLE tuple pinned here. Anything else fails (football/cfb_production/compat.js check()).',
    entries: [
      main,
      { model_version: f.v1.model_version, role: 'FALLBACK', status: 'COMPATIBLE', feature_version: f.v1.feature_version,
        params_sha256: f.v1.params_sha256, calibration_version: f.v1.model_version, decision_policy_version: null, decision_engine_version: null,
        market_engine_version: 'lab_rule:v1_gap_v1', evidence: 'the governance champion (football/cfb_lab/governance/model_roles.jsonl); its board football/fbs/slate.json is the fallback level',
        decided_by: main.decided_by, decided_at: at },
      { model_version: 'edgedesk_cfb_v2.0.0', role: 'CANDIDATE', status: 'INCOMPATIBLE', feature_version: 'cfb_v2_fv1',
        calibration_version: null, decision_policy_version: null, decision_engine_version: null, market_engine_version: null,
        evidence: 'candidate 001 is tracked in shadow only; its artifact reads feature schema cfb_v2_fv1, the production features are ' + f.feature_version + '; never a fallback',
        decided_by: main.decided_by, decided_at: at },
    ],
  };
}

module.exports = { build, verify, verifyFromGit, contentHash, row, matrixRows, push, compatFile, roles, migrations, OUT };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  (async () => {
    if (a.includes('--write-compat')) {
      fs.writeFileSync(C.MATRIX, JSON.stringify(compatFile({ decidedAt: arg('--decided-at', null) }), null, 1) + '\n');
      console.log('wrote ' + C.rel(C.MATRIX));
      return;
    }
    if (a.includes('--check')) {
      const have = readJson(OUT);
      if (!have) { console.error('no ' + C.rel(OUT) + ': run with --write'); process.exit(1); }
      const probs = verify(have);
      const fresh = build({ deployedAt: have.deployed_at });
      if (fresh.content_sha256 !== have.content_sha256) probs.push('the system on disk differs from the committed manifest (regenerate with --write, and bump the version if model logic changed)');
      probs.forEach((p) => console.error('STALE | ' + p));
      console.log(probs.length ? 'manifest STALE' : 'manifest ok ' + have.manifest_id + ' (' + have.production_model_version + ', champion ' + have.champion_model_version + ', champion_selection ' + have.champion_selection + ')');
      process.exit(probs.length ? 1 : 0);
    }
    const m = build({ deployedAt: arg('--deployed-at', null), supersedes: arg('--supersedes', null), reason: arg('--reason', null) });
    if (!m.compatibility.ok) console.error('WARNING | compatibility checks fail: ' + m.compatibility.checks.filter((c) => !c.ok).map((c) => c.check).join('; '));
    if (a.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(m, null, 1) + '\n'); console.log('wrote ' + C.rel(OUT) + ' ' + m.manifest_id); }
    if (a.includes('--push')) console.log(JSON.stringify(await push(m)));
    if (!a.includes('--write') && !a.includes('--push')) console.log(JSON.stringify(m, null, 1));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
