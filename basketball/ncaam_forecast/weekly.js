#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The WEEKLY challenger run: retrain, evaluate against the champion, promote
   only through the predefined gates.

     node basketball/ncaam_forecast/weekly.js [--max 4] [--only id,id] [--dry-run]

   Kept apart (CBB_MODEL_NOTES.md §9):
     daily     refresh.js: the CHAMPION's ratings refitted on the newest games
               (routine update; no parameter changes, no promotion)
     weekly    this file: challengers refitted walk-forward; calibration fitted
               weekly on earlier games inside each walk (a separate,
               chronological partition); evaluation; gates; promotion
     promote   registry.js promote(), reachable only with a PROMOTE decision
   Steps:
     1 validate the data (manifest hashes; season-in-progress box coverage)
     2 the training snapshot (sha256 of every row a fit may read)
     3 the champion's rows (the incumbent served model, or the champion config)
     4 the challengers: the first run evaluates the frozen development
       selection (config/selection_v1.json) against the incumbent; later runs
       evaluate changes from a fixed catalogue to the champion
     5 gates (config/promotion_v1.json via evaluate.js), an immutable report
       (reports/weekly/<date>-<candidate>.json, sha256) and a history line
       for EVERY candidate, pass or fail
     6 at most one PROMOTE; its artifact must rebuild to the same sha256
   The model's own predictions are never used as outcome labels: every
   evaluation row is scored against the observed final score.
   Failure injection (tests/ops.test.js): NCAAM_FAIL_AT=ingest|train|evaluate|
   store|promote makes that boundary throw; every one is recorded FAILED in
   the history and the champion pointer is unchanged afterwards.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const EV = require('./evaluate');
const RG = require('./registry');

const REPORTS = C.PATHS.weeklyReports;
const failAt = (stage) => { if (process.env.NCAAM_FAIL_AT === stage) throw Object.assign(new Error('injected failure at ' + stage), { injected: true, stage }); };

/* the catalogue: [id, path, change]. path 'params.x' or 'calibration.x' */
const CATALOGUE = [
  ['lambda_weaker_prior', 'params.lambda', ['mul', 0.5]],
  ['lambda_stronger_prior', 'params.lambda', ['mul', 2]],
  ['carry_lower', 'params.carry', ['add', -0.1]],
  ['carry_higher', 'params.carry', ['add', 0.1]],
  ['recency_365', 'params.half_life', ['set', 365]],
  ['calibration_window_2', 'calibration.window_seasons', ['set', 2]],
  ['calibration_window_4', 'calibration.window_seasons', ['set', 4]],
  ['margin_variance_v2', 'calibration.variance', ['set', { margin: 'v2', total: 'v2' }]],
  ['no_endgame_tie_factor', 'calibration.kappa', ['set', 1]],
  ['tempo_prior_weaker', 'params.lambda_tempo', ['mul', 0.5]],
  ['tie_consistent_fit', 'calibration.location_fit', ['set', 'tie_consistent']],
];

function applyChange(cfg, p, how) {
  const out = JSON.parse(JSON.stringify(cfg)); const [sect, key] = p.split('.');
  const cur = out[sect][key]; let nv;
  if (how[0] === 'mul') { if (cur == null) return null; nv = +(cur * how[1]).toFixed(6); }
  else if (how[0] === 'add') nv = +Math.min(1, Math.max(0, (cur || 0) + how[1])).toFixed(4);
  else nv = how[1];
  if (JSON.stringify(nv) === JSON.stringify(cur)) return null;
  out[sect][key] = nv; return out;
}
function bumpMinor(v) { const [a, b] = String(v).split('.').map(Number); return a + '.' + (b + 1) + '.0'; }

function selectionConfig() {
  const sel = JSON.parse(fs.readFileSync(path.join(C.PATHS.configDir, 'selection_v1.json'), 'utf8'));
  return { model_id: 'ncaam_adjeff', version: '1.0.0', engine: 'research_team_model', params: sel.chosen, calibration: sel.calibration, selection_hash: sel.hash };
}

function rowsFor(model, eg) {
  if (model.engine === 'points_ratings') return MD.incumbentRows(eg).asServed;
  const R = MD.researchRows(eg, model.config || model);
  MD.calibrateCausal(R.rows, (model.config || model).calibration);
  return R.rows;
}

function writeReport(rep) {
  fs.mkdirSync(REPORTS(), { recursive: true });
  const text = JSON.stringify(rep, null, 1) + '\n';
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  let f = path.join(REPORTS(), rep.date + '-' + rep.candidate + '.json'); let k = 1;
  while (fs.existsSync(f)) { if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === sha) break; f = path.join(REPORTS(), rep.date + '-' + rep.candidate + '-' + (++k) + '.json'); }
  if (!fs.existsSync(f)) RG.atomicWrite(f, text);
  return { file: path.relative(C.ROOT, f).split(path.sep).join('/'), report_sha256: sha };
}

async function weekly(o) {
  o = o || {};
  const t0 = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const policy = JSON.parse(fs.readFileSync(C.PATHS.promotion, 'utf8'));
  let games, snap;
  try {
    failAt('ingest');
    games = DS.load();                                   // throws on any hash mismatch
    snap = DS.snapshot(games, Date.now());
  } catch (e) {
    RG.recordDecision({ decision: 'FAILED', stage: 'data', error: String(e.message).slice(0, 400), champion: (RG.readPointer() || {}).current && RG.readPointer().current.key });
    throw e;
  }
  const cov = DS.coverage(games); const cur = C.currentSeason(); const cs = cov[cur];
  const dataGate = !cs || cs.final < 200 || cs.box_coverage >= 0.97;
  const ptr = RG.readPointer() || RG.init();
  const rv = RG.verify();
  if (!rv.ok) {
    RG.recordDecision({ decision: 'FAILED', stage: 'registry', error: rv.reasons.join('; ').slice(0, 400), champion: ptr.current.key });
    throw new Error('the registry disagrees with itself (' + rv.reasons.join('; ') + '): reconcile it before any evaluation');
  }
  const champModel = RG.readModel(ptr.current.key);
  if (!champModel) throw new Error('champion record missing: ' + ptr.current.key);
  const eg = DS.engineGames(games);
  const complete = Object.keys(cov).map(Number).filter((s) => s < cur && cov[s].final > 1000);
  const recent = Math.max(...complete);
  const window = { from: 2020, to: cur };
  let champRows, candidates;
  try {
    failAt('train');
    champRows = rowsFor(champModel, eg);
    if (champModel.engine === 'points_ratings') candidates = [{ id: 'selection_v1', model: selectionConfig() }];
    else {
      const weekIndex = Math.floor(Date.now() / (7 * 864e5));
      const all = CATALOGUE.map(([id, p, how]) => ({ id, cfg: applyChange(champModel.config, p, how) })).filter((c) => c.cfg);
      const rot = all.slice(weekIndex % all.length).concat(all.slice(0, weekIndex % all.length));
      const pick = o.only ? all.filter((c) => o.only.includes(c.id)) : rot.slice(0, o.max || 4);
      candidates = pick.map((c) => ({ id: c.id, model: Object.assign({}, c.cfg, { model_id: champModel.model_id, version: bumpMinor(champModel.version) }) }));
    }
  } catch (e) {
    RG.recordDecision({ decision: 'FAILED', stage: 'train', error: String(e.message).slice(0, 400), champion: ptr.current.key });
    throw e;
  }
  const results = [];
  for (const c of candidates) {
    let rep;
    try {
      failAt('evaluate');
      const rows = rowsFor({ engine: c.model.engine, config: c.model }, eg);
      const leak = EV.leakage(rows.filter((r) => r.season >= window.from));
      const ctx = { window, recent_season: recent, integrity: { dataset_hashes_ok: true, leakage_violations: leak.violations, snapshot_sha256: snap.sha256, artifact_reproducible: true },
        operations: { runtime_min: +((Date.now() - t0) / 60000).toFixed(2) } };
      const g = EV.gate(champRows, rows, policy, ctx);
      if (!dataGate) { g.gates.push({ id: 'G0_data', pass: false, detail: 'season-in-progress box coverage ' + cs.box_coverage + ' < 0.97' }); if (g.decision === 'PROMOTE') g.decision = 'RETAIN'; }
      if (g.decision === 'PROMOTE') {
        /* G7: the artifact must rebuild identically (cached walk: same arithmetic) */
        const at = Date.now();
        const cache = MD.researchRows(DS.engineGames(games.filter((x) => x.season < cur)), c.model);
        const a1 = MD.buildArtifact(games, c.model, at, { season: cur, cache }), a2 = MD.buildArtifact(games, c.model, at, { season: cur, cache });
        if (a1.artifact_sha256 !== a2.artifact_sha256) { g.decision = 'RETAIN'; const gi = g.gates.find((x) => x.id === 'G7_integrity'); gi.pass = false; gi.detail = 'artifact rebuild differs'; }
        g.artifact_sha256 = a1.artifact_sha256;
      }
      rep = { schema: 'edgedesk_ncaam_fc_weekly_report_v1', date: today, generated_at: new Date().toISOString(), candidate: c.id, champion: ptr.current.key,
        challenger: { model_id: c.model.model_id, version: c.model.version, engine: c.model.engine, config: c.model, config_sha256: MD.configHash(c.model) },
        policy_version: policy.version, snapshot: snap, leakage: leak, data: { season_in_progress: cur, coverage: cs || null }, result: g };
    } catch (e) {
      RG.recordDecision({ decision: 'FAILED', stage: 'evaluate', candidate: c.id, error: String(e.message).slice(0, 400), champion: ptr.current.key });
      throw e;
    }
    let w;
    try { failAt('store'); w = writeReport(rep); }
    catch (e) {
      RG.recordDecision({ decision: 'FAILED', stage: 'store', candidate: c.id, error: String(e.message).slice(0, 400), champion: ptr.current.key });
      throw e;
    }
    RG.recordDecision({ decision: rep.result.decision, candidate: c.id, challenger: c.model.model_id + '@' + c.model.version, champion: ptr.current.key, report: w.file, report_sha256: w.report_sha256,
      gates_failed: rep.result.gates.filter((x) => !x.pass).map((x) => x.id) });
    results.push(Object.assign({ id: c.id, model: c.model, decision: rep.result.decision, ll_diff: (rep.result.gates.find((x) => x.id === 'G2_log_loss').evidence || {}).mean_diff }, w));
    console.error('[ncaam weekly] ' + c.id + ': ' + rep.result.decision + ' (' + rep.result.gates.filter((x) => !x.pass).map((x) => x.id + ' ' + x.detail).join(' | ') + ')');
  }
  const passed = results.filter((r) => r.decision === 'PROMOTE').sort((a, b) => a.ll_diff - b.ll_diff);
  let promoted = null;
  if (passed.length && !o.dryRun) {
    const best = passed[0];
    const m = { schema: 'edgedesk_ncaam_fc_model_v1', model_id: best.model.model_id, version: best.model.version, engine: best.model.engine, config: best.model, config_sha256: MD.configHash(best.model),
      code_sha256: MD.codeHash(), training_snapshot: snap, recorded_at: new Date().toISOString() };
    try { failAt('promote'); promoted = RG.promote(m, { decision: 'PROMOTE', file: best.file, report_sha256: best.report_sha256 }); }
    catch (e) {
      RG.recordDecision({ decision: 'FAILED', stage: 'promote', candidate: best.id, error: String(e.message).slice(0, 400), champion: ptr.current.key });
      throw e;
    }
  }
  const summary = { date: today, champion_before: ptr.current.key, champion_after: (RG.readPointer() || ptr).current.key, promoted: promoted ? promoted.current.key : null,
    candidates: results.map((r) => ({ id: r.id, decision: r.decision, report: r.file })), runtime_min: +((Date.now() - t0) / 60000).toFixed(2) };
  console.log(JSON.stringify(summary));
  return summary;
}

module.exports = { CATALOGUE, applyChange, bumpMinor, selectionConfig, weekly, writeReport };

if (require.main === module) {
  const a = process.argv; const val = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null; };
  weekly({ max: val('max') ? +val('max') : 4, only: val('only') ? val('only').split(',') : null, dryRun: a.includes('--dry-run') })
    .catch((e) => { console.error('[ncaam weekly] failed: ' + e.message + ' — the champion is unchanged'); process.exit(1); });
}
