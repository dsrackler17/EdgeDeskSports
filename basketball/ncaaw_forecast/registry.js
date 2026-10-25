#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The NCAAW champion: which model version serves, its history, and rollback.

     node basketball/ncaaw_forecast/registry.js status               (exit 1 if the registry disagrees with itself)
     node basketball/ncaaw_forecast/registry.js verify
     node basketball/ncaaw_forecast/registry.js rollback [--to <model_id>@<version>] --reason "..."
     node basketball/ncaaw_forecast/registry.js init                 (once: the incumbent as champion)

   registry/champion.json   THE POINTER: { current, previous[] } — swapped
                            atomically (written to a temporary file in the same
                            directory, fsync'd, then renamed over the pointer;
                            a crash leaves either the old or the new pointer,
                            never half of one).
   registry/models/*.json   every model version ever evaluated (config, its
                            sha256, code hash, training snapshot, evaluation
                            report): kept forever, never edited after writing.
   registry/history.jsonl   append-only log of every decision: PROMOTE, RETAIN,
                            INSUFFICIENT_EVIDENCE, FAILED, ROLLBACK, INIT.

   A model version is a CONFIGURATION (engine, parameters, calibration law)
   plus the evidence that admitted it. The daily refresh rebuilds that
   champion's ratings from the newest data; rolling back points the refresh
   at the previous configuration, whose record and report are still here.
   Promotion is only reachable through promote(), which refuses anything but
   a PROMOTE decision. The research-registry tier is NOT touched here.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const MD = require('./model');

const DIR = () => process.env.NCAAW_REGISTRY_DIR || C.PATHS.registry;
const P = {
  pointer: () => path.join(DIR(), 'champion.json'),
  models: () => path.join(DIR(), 'models'),
  history: () => path.join(DIR(), 'history.jsonl'),
};
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function appendHistory(rec) {
  fs.mkdirSync(DIR(), { recursive: true });
  const line = JSON.stringify(Object.assign({ at: nowIso() }, rec));
  const fd = fs.openSync(P.history(), 'a');
  try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readPointer() { return fs.existsSync(P.pointer()) ? JSON.parse(fs.readFileSync(P.pointer(), 'utf8')) : null; }
const modelKey = (m) => m.model_id + '@' + m.version;
function modelFile(key) { return path.join(P.models(), key.replace(/[^A-Za-z0-9@._-]/g, '_') + '.json'); }
function readModel(key) { const f = modelFile(key); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }

/** record a model version (immutable: an existing record with other content is refused) */
function recordModel(m) {
  fs.mkdirSync(P.models(), { recursive: true });
  const f = modelFile(modelKey(m)); const text = JSON.stringify(m, null, 1) + '\n';
  if (fs.existsSync(f)) {
    const old = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (old.config_sha256 !== m.config_sha256) throw new Error('model ' + modelKey(m) + ' already exists with a different configuration: bump the version');
    return f;
  }
  atomicWrite(f, text);
  return f;
}

/** the incumbent served points model as the first champion (no new evidence is claimed) */
function init() {
  if (readPointer()) return readPointer();
  const ver = MD.currentIncumbentVersion();
  const m = { schema: 'edgedesk_ncaaw_fc_model_v1', model_id: 'ncaaw_points', version: ver.split('@')[1] || '1.1.0', engine: 'points_ratings',
    config: { engine: 'points_ratings', served_by: 'basketball/walkforward.js + docs/model-loop/ncaaw/versions.json', note: 'the existing served scores-only model; its probabilities come from its own logistic curve' },
    status: 'CHAMPION', recorded_at: nowIso(), evidence: 'basketball/validation/ncaaw_walkforward.json (OUTCOME_VALIDATED by the existing protocol)' };
  m.config_sha256 = MD.hash(m.config);
  recordModel(m);
  const ptr = { schema: 'edgedesk_ncaaw_fc_champion_v1', current: { key: modelKey(m), model_id: m.model_id, version: m.version, engine: m.engine, config_sha256: m.config_sha256, since: nowIso(), decision: 'INIT' }, previous: [] };
  atomicWrite(P.pointer(), JSON.stringify(ptr, null, 1) + '\n');
  appendHistory({ decision: 'INIT', champion: ptr.current.key, note: 'the incumbent served model is the starting champion; no challenger has been evaluated yet' });
  return ptr;
}

/** swap the pointer to a challenger that PASSED every gate */
function promote(model, report) {
  if (!report || report.decision !== 'PROMOTE') throw new Error('promote() refused: the decision is ' + (report && report.decision) + ', not PROMOTE');
  if (!report.report_sha256) throw new Error('promote() refused: no immutable report');
  const ptr = readPointer() || init();
  recordModel(Object.assign({}, model, { status: 'CHAMPION', promoted_at: nowIso(), evaluation_report: report.file, evaluation_report_sha256: report.report_sha256 }));
  const next = { schema: ptr.schema, current: { key: modelKey(model), model_id: model.model_id, version: model.version, engine: model.engine, config_sha256: model.config_sha256, since: nowIso(), decision: 'PROMOTE', report: report.file },
    previous: [ptr.current].concat(ptr.previous || []).slice(0, 20) };
  atomicWrite(P.pointer(), JSON.stringify(next, null, 1) + '\n');
  appendHistory({ decision: 'PROMOTE', champion: next.current.key, replaced: ptr.current.key, report: report.file, report_sha256: report.report_sha256 });
  return next;
}

/** point back at a previous champion (default: the most recent one) */
function rollback(o) {
  o = o || {};
  const ptr = readPointer(); if (!ptr) throw new Error('no champion pointer');
  if (!o.reason || !String(o.reason).trim()) throw new Error('a rollback needs a reason');
  const prev = ptr.previous || [];
  const target = o.to ? prev.find((p) => p.key === o.to) : prev[0];
  if (!target) throw new Error('no previous champion ' + (o.to || '') + ' to roll back to');
  if (!readModel(target.key)) throw new Error('the record of ' + target.key + ' is missing: cannot roll back to a model without its record');
  const next = { schema: ptr.schema, current: Object.assign({}, target, { since: nowIso(), decision: 'ROLLBACK' }), previous: [ptr.current].concat(prev.filter((p) => p.key !== target.key)).slice(0, 20) };
  atomicWrite(P.pointer(), JSON.stringify(next, null, 1) + '\n');
  appendHistory({ decision: 'ROLLBACK', champion: target.key, replaced: ptr.current.key, reason: String(o.reason).slice(0, 500) });
  return next;
}

function recordDecision(rec) { appendHistory(rec); }

/** a history line that moved the pointer: INIT, ROLLBACK, or a PROMOTE written by promote() (it names `replaced`).
    weekly.js's own decision record for a winning candidate is also a PROMOTE, but it names the champion it was scored
    against and moves nothing */
function movesPointer(x) { return !!x && (x.decision === 'INIT' || x.decision === 'ROLLBACK' || (x.decision === 'PROMOTE' && !!x.replaced)); }

/** The registry agrees with itself: the pointer's model record exists with the
    pointer's configuration, and the last pointer-moving history line (INIT,
    PROMOTE with `replaced`, ROLLBACK) names the current champion. A crash
    between the pointer rename and the history append fails this check, and
    weekly.js / refresh.js then refuse to run until an operator reconciles. */
function verify() {
  const r = [];
  const ptr = readPointer();
  if (!ptr) return { ok: false, reasons: ['no champion pointer'], champion: null };
  const m = readModel(ptr.current.key);
  if (!m) r.push('the record of ' + ptr.current.key + ' is missing');
  else if (m.config_sha256 !== ptr.current.config_sha256) r.push('the record of ' + ptr.current.key + ' has another configuration than the pointer');
  const lines = fs.existsSync(P.history()) ? fs.readFileSync(P.history(), 'utf8').split('\n').filter(Boolean) : [];
  let last = null;
  for (const l of lines) {
    let x; try { x = JSON.parse(l); } catch (_) { r.push('an unreadable history line'); continue; }
    if (movesPointer(x)) last = x;
  }
  if (!last) r.push('the history has no INIT, PROMOTE or ROLLBACK line');
  else if (last.champion !== ptr.current.key) r.push('the history says the champion is ' + last.champion + ', the pointer says ' + ptr.current.key);
  return { ok: !r.length, reasons: r, champion: ptr.current.key };
}

module.exports = { DIR, P, atomicWrite, appendHistory, readPointer, readModel, recordModel, modelKey, init, promote, rollback, recordDecision, movesPointer, verify };

if (require.main === module) {
  const cmd = process.argv[2]; const arg = (k) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : null; };
  try {
    if (cmd === 'status') { const p = readPointer() || init(); const v = verify(); console.log(JSON.stringify(Object.assign({}, p, { consistent: v.ok, problems: v.reasons }), null, 1)); if (!v.ok) process.exit(1); }
    else if (cmd === 'verify') { const v = verify(); console.log(JSON.stringify(v)); if (!v.ok) process.exit(1); }
    else if (cmd === 'init') console.log(JSON.stringify(init(), null, 1));
    else if (cmd === 'rollback') console.log(JSON.stringify(rollback({ to: arg('to'), reason: arg('reason') }), null, 1));
    else { console.error('usage: node basketball/ncaaw_forecast/registry.js status|verify|init|rollback [--to model@version] --reason "..."'); process.exit(2); }
  } catch (e) { console.error('error: ' + e.message); process.exit(1); }
}
