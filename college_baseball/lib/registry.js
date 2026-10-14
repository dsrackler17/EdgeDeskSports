'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the experiment registry.

   research/experiments.jsonl is APPEND-ONLY and HASH-CHAINED: each record
   carries the sha256 of the previous line, so a deleted or edited record
   breaks the chain and `verify()` (run by the auditor and the tests) fails.
   A failed hypothesis is recorded exactly like an accepted one; nothing is
   silently dropped.

   Re-running a script that registers the same experiment id with identical
   content is a no-op. Different content appends a new REVISION that names
   the record it supersedes, so the history of a number is always visible.

   Every record carries: hypothesis, dataset snapshot, training / validation /
   holdout windows, feature set, algorithm and configuration, random seeds,
   metrics, uncertainty, decision, justification and the code commit.

   HOLDOUT DISCIPLINE. A record with `holdout_evaluated: true` counts against
   its model family. `holdoutLooks(family)` is read by the auditor: more than
   MAX_HOLDOUT_LOOKS distinct holdout looks for one family means the holdout
   has been used for selection and is no longer untouched (audit check 11).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SCHEMA = 'edgedesk_cbase_experiment_v1';
const DECISIONS = ['ACCEPT', 'REJECT', 'INCONCLUSIVE', 'PENDING', 'BLOCKED'];
const MAX_HOLDOUT_LOOKS = 3;
const DEFAULT_FILE = path.join(__dirname, '..', 'research', 'experiments.jsonl');

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o === undefined ? null : o);
}
function gitCommit() {
  try {
    const head = execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    let dirty = false;
    try { dirty = execSync('git status --porcelain college_baseball', { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; } catch (_) {}
    return { commit: head, dirty };
  } catch (_) { return { commit: null, dirty: null }; }
}

function readAll(file) {
  file = file || DEFAULT_FILE;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/* the content that identifies a result: everything except bookkeeping */
function contentOf(rec) {
  const o = Object.assign({}, rec);
  for (const k of ['created_at', 'code', 'prev_hash', 'record_hash', 'revision', 'supersedes', 'schema']) delete o[k];
  return o;
}

function validate(rec) {
  const errs = [];
  for (const k of ['id', 'title', 'hypothesis', 'dataset', 'windows', 'features', 'algorithm', 'seeds', 'metrics', 'decision', 'justification']) {
    if (rec[k] === undefined) errs.push('missing ' + k);
  }
  if (rec.decision && !DECISIONS.includes(rec.decision)) errs.push('decision must be one of ' + DECISIONS.join('/'));
  if (rec.windows && typeof rec.windows !== 'object') errs.push('windows must be an object');
  if (rec.seeds && !Array.isArray(rec.seeds)) errs.push('seeds must be an array');
  return errs;
}

/** register (or revise) an experiment; returns {action: 'appended'|'unchanged'|'revised', record} */
function register(rec, o) {
  o = o || {};
  const file = o.file || DEFAULT_FILE;
  const errs = validate(rec);
  if (errs.length) throw new Error('registry: ' + rec.id + ': ' + errs.join('; '));
  const all = readAll(file);
  const prior = all.filter((r) => r.id === rec.id);
  const latest = prior[prior.length - 1];
  const body = contentOf(rec);
  if (latest && canonical(contentOf(latest)) === canonical(body)) return { action: 'unchanged', record: latest };
  const last = all[all.length - 1];
  const out = Object.assign({ schema: SCHEMA }, body, {
    revision: prior.length + 1,
    supersedes: latest ? latest.record_hash : null,
    created_at: o.now || new Date().toISOString(),
    code: o.code || gitCommit(),
    prev_hash: last ? last.record_hash : null,
  });
  out.record_hash = sha(canonical(Object.assign({}, out, { record_hash: undefined })));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(out) + '\n');
  return { action: latest ? 'revised' : 'appended', record: out };
}

/** the chain must be intact: each prev_hash is the previous record's hash, each hash recomputes */
function verify(o) {
  o = o || {};
  const all = readAll(o.file);
  const errs = [];
  let prev = null;
  all.forEach((r, i) => {
    if (r.prev_hash !== prev) errs.push('line ' + (i + 1) + ' (' + r.id + '): prev_hash does not match the previous record');
    const recomputed = sha(canonical(Object.assign({}, r, { record_hash: undefined })));
    if (recomputed !== r.record_hash) errs.push('line ' + (i + 1) + ' (' + r.id + '): record was edited after it was written');
    prev = r.record_hash;
  });
  return { ok: errs.length === 0, records: all.length, errors: errs };
}

/** latest revision of every experiment */
function latest(o) {
  const by = new Map();
  for (const r of readAll(o && o.file)) by.set(r.id, r);
  return [...by.values()];
}

/** distinct holdout looks per model family (each revision that touched the holdout counts) */
function holdoutLooks(family, o) {
  return readAll(o && o.file).filter((r) => r.holdout_evaluated && (r.family === family)).length;
}

module.exports = { SCHEMA, DECISIONS, MAX_HOLDOUT_LOOKS, register, verify, latest, readAll, holdoutLooks, canonical, sha, gitCommit, DEFAULT_FILE };
