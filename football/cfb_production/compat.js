/* ============================================================================
   CFB production — artifact facts and the explicit compatibility matrix
   (docs/cfb-production/VERSIONING.md §3).

   facts() reads what is actually on disk and hashes it:
     - the frozen V2.1 artifact, verified file by file against its MANIFEST.json
       (the same rule as v2/weekly/project.py verify_artifact);
     - params.js / engine.js (the JS inference the Model Lab and the decision
       engine run), models.json's feature_version, config.py's versions;
     - the calibration and ensemble identities, derived the way the Model Lab
       derives calibration_version (football/cfb_lab/models.js) — and the
       ensemble from models.json's stack_weights, which is where the weights
       live (params.js has none; see VERSIONING.md §5);
     - the decision policy the shadow engine WOULD load (football/cfb_decision/
       shadow.js takes the lexically newest cfb_decision_policy_* directory),
       and the decision baseline's own pinned file hashes;
     - V1 (the governance champion and fallback): football/cfb_p4/params.js.

   compatibility.json is the matrix: each entry binds ONE model version to its
   feature schema, calibration, decision policy, decision engine and market
   engine, and pins the exact file hashes those were validated with. check()
   refuses anything not explicitly COMPATIBLE — never a warning, never a
   silent continue: a new feature file against an old artifact, a V3
   calibrator on V4 probabilities, a policy nobody pinned.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const V2 = path.join(REPO, 'football', 'cfb_v2');
const MATRIX = path.join(__dirname, 'compatibility.json');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shaFile(p) { try { return sha(fs.readFileSync(p)); } catch (e) { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function rel(p) { return path.relative(REPO, p).split(path.sep).join('/'); }

/* the Model Lab's canonical form (football/cfb_lab/ledger.js), so a version derived here equals the lab's */
let CANON = null;
function canonical(o) {
  if (!CANON) {
    try { CANON = require(path.join(REPO, 'football', 'cfb_lab', 'ledger.js')).canonical; } catch (e) { CANON = null; }
    if (!CANON) CANON = (v) => JSON.stringify(sortDeep(v));
  }
  return CANON(o);
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach((k) => { o[k] = sortDeep(v[k]); }); return o; }
  return v;
}
function hashObj(o) { return sha(canonical(o)); }

function readParams(file) {
  const ctx = { Math, JSON, Number, Object, Array, String, isFinite, parseFloat };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  return JSON.parse(JSON.stringify(ctx.EDCfbV2Params || null));
}

/* every file of an artifact directory against its MANIFEST.json, both directions */
function verifyArtifactDir(dir) {
  const mpath = path.join(dir, 'MANIFEST.json');
  if (!fs.existsSync(dir)) return { ok: false, reason: 'artifact directory missing: ' + rel(dir), files: {} };
  if (!fs.existsSync(mpath)) return { ok: false, reason: 'no MANIFEST.json in ' + rel(dir), files: {} };
  const want = (readJson(mpath) || {}).files || {};
  const have = {};
  fs.readdirSync(dir).filter((f) => f !== 'MANIFEST.json' && fs.statSync(path.join(dir, f)).isFile()).sort().forEach((f) => { have[f] = shaFile(path.join(dir, f)); });
  const bad = Array.from(new Set(Object.keys(want).concat(Object.keys(have)))).sort().filter((k) => want[k] !== have[k]);
  return { ok: bad.length === 0, reason: bad.length ? 'files differ from MANIFEST.json: ' + bad.join(', ') : null, files: have, manifest_sha256: shaFile(mpath), mismatched: bad };
}

/* what football/cfb_decision/shadow.js newest() would load: the lexically last directory */
function newestDir(artDir, prefix, file) {
  if (!fs.existsSync(artDir)) return null;
  const dirs = fs.readdirSync(artDir).filter((d) => d.startsWith(prefix) && fs.existsSync(path.join(artDir, d, file))).sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

function regex(file, re) { try { return (re.exec(fs.readFileSync(file, 'utf8')) || [])[1] || null; } catch (e) { return null; } }

function facts(opts) {
  opts = opts || {};
  const repo = opts.repo || REPO;
  const v2 = path.join(repo, 'football', 'cfb_v2');
  const cfgPy = path.join(v2, 'research', 'v2', 'config.py');
  const prodVersion = regex(cfgPy, /PRODUCTION_MODEL_VERSION\s*=\s*'([^']+)'/);
  const cfgFeature = regex(cfgPy, /FEATURE_VERSION\s*=\s*'([^']+)'/);
  const paramsFile = path.join(v2, 'params.js');
  const engineFile = path.join(v2, 'engine.js');
  let P = null;
  try { P = readParams(paramsFile); } catch (e) { P = null; }
  const mv = (P && P.model_version) || prodVersion;
  const artDir = path.join(v2, 'artifacts', mv || 'missing');
  const art = verifyArtifactDir(artDir);
  const models = readJson(path.join(artDir, 'models.json')) || {};
  const decArt = path.join(v2, 'artifacts', 'decision');
  const policyDir = newestDir(decArt, 'cfb_decision_policy_', 'policy.json');
  const policy = policyDir ? readJson(path.join(decArt, policyDir, 'policy.json')) : null;
  const baselineDir = newestDir(decArt, 'cfb_decision_baseline_', 'MANIFEST.json');
  const baseline = baselineDir ? readJson(path.join(decArt, baselineDir, 'MANIFEST.json')) : null;
  const baselineFiles = {};
  let baselineOk = !!baseline;
  if (baseline) {
    for (const [p, want] of Object.entries(baseline.files_sha256 || {})) {
      const have = shaFile(path.join(repo, p));
      baselineFiles[p] = { want, have, ok: have === want };
      if (have !== want) baselineOk = false;
    }
  }
  const decisionJs = path.join(repo, 'football', 'cfb_decision', 'decision.js');
  const v1Params = path.join(repo, 'football', 'cfb_p4', 'params.js');
  return {
    production_model_version: mv,
    config_production_model_version: prodVersion,
    params_model_version: P && P.model_version,
    models_model_version: models.model_version || null,
    feature_version: P && P.feature_version,
    models_feature_version: models.feature_version || null,
    config_feature_version: cfgFeature,
    promotion_decision: P && P.promotion && P.promotion.decision,
    artifact: { dir: rel(artDir), ok: art.ok, reason: art.reason, files: art.files, manifest_sha256: art.manifest_sha256 || null },
    params_sha256: shaFile(paramsFile),
    engine_sha256: shaFile(engineFile),
    calibration_version: P ? mv + ':' + hashObj({ win: P.calibration && P.calibration.win, cover: P.cover }).slice(0, 12) : null,
    ensemble_version: models.stack_weights ? mv + ':' + hashObj(models.stack_weights).slice(0, 12) : null,
    lab_ensemble_version: P ? mv + ':' + hashObj(P.stack_weights || P.ensemble || {}).slice(0, 12) : null,
    stack_weights: models.stack_weights || null,
    market_engine_version: P ? mv + ':market:' + hashObj(P.market || {}).slice(0, 12) : null,
    bet_enabled_params: !!(P && P.market && P.market.bet_enabled),
    decision_policy: policy ? { version: policy.version, dir: policyDir, status: policy.status, bet_enabled: !!policy.bet_enabled,
      sha256: shaFile(path.join(decArt, policyDir, 'policy.json')) } : null,
    decision_baseline: baseline ? { version: baseline.baseline_id, dir: baselineDir, base_model_version: baseline.base_model_version,
      ok: baselineOk, files: baselineFiles, sha256: shaFile(path.join(decArt, baselineDir, 'MANIFEST.json')) } : null,
    decision_engine_version: regex(decisionJs, /var ENGINE_VERSION = '([^']+)'/),
    decision_engine_sha256: shaFile(decisionJs),
    v1: { model_version: regex(v1Params, /"model_version":"([^"]+)"/), feature_version: regex(v1Params, /"feature_version":"([^"]+)"/),
      params_sha256: shaFile(v1Params), present: fs.existsSync(v1Params) },
  };
}

function loadMatrix(p) { return readJson(p || MATRIX); }

/* A check list for one job. Every item: { check, ok, code, detail }. Nothing here warns-and-continues. */
function check(f, matrix, opts) {
  opts = opts || {};
  const out = [];
  const add = (check, ok, code, detail) => out.push({ check, ok: !!ok, code: ok ? null : code, detail: detail || null });
  const mv = f.production_model_version;
  add('versions agree (config.py, params.js, models.json)', mv && f.config_production_model_version === mv && f.params_model_version === mv && f.models_model_version === mv,
    'MODEL_ARTIFACT', [f.config_production_model_version, f.params_model_version, f.models_model_version].join(' / '));
  add('feature schema agrees (config.py, params.js, models.json)', f.feature_version && f.config_feature_version === f.feature_version && f.models_feature_version === f.feature_version,
    'MODEL_ARTIFACT', [f.config_feature_version, f.feature_version, f.models_feature_version].join(' / '));
  add('artifact files verify against MANIFEST.json', f.artifact.ok, 'MODEL_ARTIFACT', f.artifact.reason || f.artifact.dir);
  const entries = ((matrix && matrix.entries) || []).filter((e) => e.model_version === mv);
  const e = entries.find((x) => x.status === 'COMPATIBLE') || null;
  add('the compatibility matrix has a COMPATIBLE entry for ' + mv, !!e, 'CALIBRATION', entries.length ? 'entries: ' + entries.map((x) => x.status).join(', ') : 'no entry');
  if (e) {
    add('feature schema is the one the entry names', e.feature_version === f.feature_version, 'MODEL_ARTIFACT', e.feature_version + ' vs ' + f.feature_version);
    add('artifact MANIFEST is the one the entry pins', e.artifact_manifest_sha256 === f.artifact.manifest_sha256, 'MODEL_ARTIFACT', 'pinned ' + String(e.artifact_manifest_sha256).slice(0, 12) + ', on disk ' + String(f.artifact.manifest_sha256).slice(0, 12));
    add('params.js is the one the entry pins (calibration, market rule, gates)', e.params_sha256 === f.params_sha256, 'CALIBRATION', 'pinned ' + String(e.params_sha256).slice(0, 12) + ', on disk ' + String(f.params_sha256).slice(0, 12));
    add('engine.js is the one the entry pins', e.engine_sha256 === f.engine_sha256, 'MODEL_ARTIFACT', 'pinned ' + String(e.engine_sha256).slice(0, 12) + ', on disk ' + String(f.engine_sha256).slice(0, 12));
    add('calibration version matches the entry', e.calibration_version === f.calibration_version, 'CALIBRATION', e.calibration_version + ' vs ' + f.calibration_version);
    add('ensemble version matches the entry', e.ensemble_version === f.ensemble_version, 'MODEL_ARTIFACT', e.ensemble_version + ' vs ' + f.ensemble_version);
    add('market engine version matches the entry', e.market_engine_version === f.market_engine_version, 'CALIBRATION', e.market_engine_version + ' vs ' + f.market_engine_version);
    if (opts.decisions !== false) {
      const dp = f.decision_policy;
      add('the decision policy the engine would load is the pinned one', dp && dp.version === e.decision_policy_version && dp.dir === e.decision_policy_version,
        'CALIBRATION', dp ? 'would load ' + dp.dir + ' (version ' + dp.version + '); pinned ' + e.decision_policy_version : 'no policy directory');
      add('decision policy content is the pinned content', dp && dp.sha256 === e.decision_policy_sha256, 'CALIBRATION', dp ? String(dp.sha256).slice(0, 12) + ' vs ' + String(e.decision_policy_sha256).slice(0, 12) : 'none');
      const db = f.decision_baseline;
      add('decision baseline belongs to this model and its pinned files verify', db && db.version === e.decision_baseline_version && db.base_model_version === mv && db.ok,
        'CALIBRATION', db ? db.version + ' base ' + db.base_model_version + (db.ok ? '' : '; files differ: ' + Object.keys(db.files).filter((k) => !db.files[k].ok).join(', ')) : 'no baseline');
      add('decision engine version is the pinned one', f.decision_engine_version === e.decision_engine_version, 'CALIBRATION', f.decision_engine_version + ' vs ' + e.decision_engine_version);
      add('betting stays disabled unless the pinned policy enables it', !(dp && dp.bet_enabled) || (e.bet_enabled_allowed === true), 'CALIBRATION', dp ? 'policy bet_enabled ' + dp.bet_enabled : 'none');
    }
  }
  const fb = ((matrix && matrix.entries) || []).find((x) => x.role === 'FALLBACK' && x.status === 'COMPATIBLE');
  add('the fallback (V1 champion) is present and pinned', fb && f.v1.present && fb.model_version === f.v1.model_version && fb.params_sha256 === f.v1.params_sha256,
    'MODEL_ARTIFACT', fb ? fb.model_version + ' pinned ' + String(fb.params_sha256).slice(0, 12) + ', on disk ' + String(f.v1.params_sha256).slice(0, 12) : 'no FALLBACK entry');
  return out;
}

/* the current state as a matrix entry (used once to write compatibility.json, and by tests) */
function entryFor(f, meta) {
  meta = meta || {};
  return {
    model_version: f.production_model_version, role: 'PRODUCTION_PATHWAY', status: 'COMPATIBLE',
    feature_version: f.feature_version, artifact_manifest_sha256: f.artifact.manifest_sha256, params_sha256: f.params_sha256,
    engine_sha256: f.engine_sha256, calibration_version: f.calibration_version, ensemble_version: f.ensemble_version,
    market_engine_version: f.market_engine_version, decision_policy_version: f.decision_policy && f.decision_policy.version,
    decision_policy_sha256: f.decision_policy && f.decision_policy.sha256, decision_baseline_version: f.decision_baseline && f.decision_baseline.version,
    decision_engine_version: f.decision_engine_version, bet_enabled_allowed: false,
    evidence: meta.evidence || null, decided_by: meta.decided_by || null, decided_at: meta.decided_at || null,
  };
}

module.exports = { facts, check, loadMatrix, entryFor, verifyArtifactDir, newestDir, readParams, hashObj, canonical, sha, shaFile, REPO, MATRIX, rel };
