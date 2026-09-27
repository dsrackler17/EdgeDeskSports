#!/usr/bin/env node
/* ===========================================================================
   CFB production — the offline suite (no database, no network). Every
   safeguard of football/cfb_production/ has a check here; the real-Postgres
   half (locks, deadlocks, idempotency, disaster recovery) is sql.test.js and
   the dashboard is ui.test.js.

     1  error taxonomy (and its agreement with runlog.py and cfb_weekly.sql)
     2  bounded, jittered, classified retry; incidents; key-set grouping
     3  structured logging, correlation ids, secret redaction
     4  job-lock client semantics (skip, fail closed, release, sorted game locks)
     5  compatibility matrix enforcement
     6  the manifest (NOT_RUN, content hash, tamper detection, git recovery)
     7  model version semantics, unversioned hotfixes
     8  the workflow gate (kill switch, lock, incompatibility, finish)
     9  jobs / cron audit, collisions, the SQL seed, workflow wiring
    10  output anomaly rules
    11  the operational health report under failure scenarios
    12  migration review, workflow YAML, docs, one write path, the release check

   Run: node football/cfb_production/tests.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const T = require('./taxonomy.js');
const DB = require('./db.js');
const LOG = require('./log.js');
const LOCKS = require('./locks.js');
const C = require('./compat.js');
const MF = require('./manifest.js');
const V = require('./versioning.js');
const GATE = require('./gate.js');
const J = require('./jobs.js');
const A = require('./anomaly.js');
const H = require('./health.js');
const MR = require('./migration_review.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const hasPython = cp.spawnSync('python3', ['-c', 'import pandas'], { stdio: 'ignore' }).status === 0;

(async () => {
  /* ================================================================ 1 taxonomy */
  const runlogPy = read('football/cfb_v2/research/v2/weekly/runlog.py');
  const pyClasses = JSON.parse(/ERROR_CLASSES = \(([^)]+)\)/.exec(runlogPy)[1].replace(/'/g, '"').replace(/^/, '[').replace(/$/, ']'));
  const sqlClasses = /error_class in\s*\(([^)]+)\)/.exec(read('supabase/cfb_weekly.sql'))[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  chk('taxonomy: runlog classes are exactly runlog.py ERROR_CLASSES', JSON.stringify(T.RUNLOG_CLASSES) === JSON.stringify(pyClasses), pyClasses);
  chk('taxonomy: every code maps to a class the stage log accepts (cfb_weekly.sql)', Object.values(T.CODES).every((c) => sqlClasses.includes(c.runlog)), sqlClasses);
  chk('taxonomy: the brief\'s codes are all present', ['DATA_STALE', 'DATA_MISSING', 'PROVIDER_RATE_LIMIT', 'PROVIDER_SCHEMA', 'TEAM_MAPPING', 'PLAYER_MAPPING', 'MODEL_ARTIFACT', 'MODEL_INPUT',
    'CALIBRATION', 'MARKET_INVALID', 'DATABASE_DEADLOCK', 'DATABASE_TIMEOUT', 'PIPELINE_CONFLICT', 'UNKNOWN'].every((c) => T.CODES[c]));
  chk('taxonomy: only transient codes are retryable', Object.keys(T.CODES).filter(T.retryable).sort().join() === ['DATABASE_DEADLOCK', 'DATABASE_TIMEOUT', 'DATABASE_UNAVAILABLE', 'PROVIDER_RATE_LIMIT', 'PROVIDER_TRANSIENT'].sort().join());
  const cases = [
    [{ status: 500, body: { code: '40P01', message: 'deadlock detected' } }, 'DATABASE_DEADLOCK'],
    [{ status: 500, body: { code: '55P03' } }, 'DATABASE_TIMEOUT'], [{ status: 500, body: { code: '57014' } }, 'DATABASE_TIMEOUT'],
    [{ status: 500, body: { code: '40001' } }, 'DATABASE_DEADLOCK'], [{ status: 503, body: { code: '08006' } }, 'DATABASE_UNAVAILABLE'],
    [{ status: 409, body: { code: '23505' } }, 'DATABASE_CONSTRAINT'], [{ status: 400, body: { code: 'P0001' } }, 'DATABASE_CONSTRAINT'],
    [{ status: 404, body: { code: 'PGRST205' } }, 'DATABASE_SCHEMA'], [{ status: 404, body: { code: 'PGRST202' } }, 'DATABASE_SCHEMA'],
    [{ status: 401, body: { code: 'PGRST301' } }, 'AUTH'], [{ status: 400, body: { code: 'PGRST102' } }, 'PROVIDER_REJECTED'],
    [{ status: 500, body: { code: '25P02' } }, 'UNKNOWN'], [{ status: 502, body: '<html>bad gateway</html>' }, 'PROVIDER_TRANSIENT'],
    [{ status: 429, body: '' }, 'PROVIDER_RATE_LIMIT'], [{ status: 403, body: '' }, 'AUTH'], [{ status: 422, body: '' }, 'PROVIDER_REJECTED'],
    [new Error('psql:q.sql:3: ERROR:  40P01: deadlock detected'), 'DATABASE_DEADLOCK'], [new Error('canceling statement due to lock timeout'), 'DATABASE_TIMEOUT'],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'PROVIDER_TRANSIENT'], [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'PROVIDER_TRANSIENT'],
    [new TypeError('fetch failed'), 'PROVIDER_TRANSIENT'], [new Error('KeyError: 401628374'), 'UNKNOWN'], [new Error('team 2503 missing from mapping'), 'UNKNOWN'],
    [new T.CfbError('x', 'TEAM_MAPPING'), 'TEAM_MAPPING'], [new Error('HTTP 503 Service Unavailable'), 'PROVIDER_TRANSIENT'],
  ];
  const wrong = cases.filter(([x, want]) => T.classify(x) !== want).map(([x, want]) => [x.message || JSON.stringify(x), want, T.classify(x)]);
  chk('taxonomy: classify() on PostgREST bodies, psql errors, network failures and ids (' + cases.length + ' cases)', !wrong.length, wrong);
  chk('taxonomy: a number inside an id is never an HTTP status (ESPN game 401628374, team 2503)', T.classify(new Error('game 401628374 has no plays')) !== 'AUTH' && T.classify(new Error('team 2503')) !== 'PROVIDER_TRANSIENT');
  if (hasPython) {
    const msgs = ['HTTP 429 too many requests', 'HTTP 401 Unauthorized', 'deadlock detected', 'HTTP 503 Service Unavailable', 'connection reset by peer', 'game 401628374 has no plays', 'team 2503 missing from mapping'];
    const py = cp.spawnSync('python3', ['-c', 'import json,sys\nfrom v2.weekly import runlog as RL\nprint(json.dumps([RL.classify_error(Exception(m)) for m in json.loads(sys.argv[1])]))', JSON.stringify(msgs)],
      { cwd: path.join(ROOT, 'football', 'cfb_v2', 'research'), encoding: 'utf8' });
    const got = JSON.parse(py.stdout || '[]');
    const js = msgs.map((m) => T.runlogClass(T.classify(new Error(m))));
    const agree = msgs.map((m, i) => [m, got[i], js[i]]).filter(([, a, b]) => !(a === b || (b === 'UNKNOWN' && ['UNKNOWN', 'DATA_QUALITY', 'SCHEMA'].includes(a))));
    chk('taxonomy: runlog.py classify_error and taxonomy.js agree on the coarse class (ids fixed on both sides)', got.length === msgs.length && !agree.length, { py: got, js, disagree: agree });
  }

  /* ================================================================ 2 retry */
  const waits = [];
  const incidents = [];
  let n = 0;
  const v = await DB.withRetry(async () => { n++; if (n < 3) throw Object.assign(new Error('HTTP 500'), { http: { status: 500, code: '40P01' }, cfb_code: 'DATABASE_DEADLOCK' }); return 'ok'; },
    { sleep: async (ms) => waits.push(ms), rng: () => 0.5, onIncident: async (e) => incidents.push(e) });
  chk('retry: a deadlock is retried and succeeds; each deadlock is an incident', v === 'ok' && n === 3 && incidents.length === 2 && incidents.every((e) => e.error_code === 'DATABASE_DEADLOCK' && !e.exhausted));
  chk('retry: bounded jitter — wait n is in [d/2, d], d = min(cap, base·2^(n-1)), never zero', waits.length === 2 && waits[0] >= 100 && waits[0] <= 200 && waits[1] >= 200 && waits[1] <= 400, waits);
  const allW = [];
  for (let i = 0; i < 200; i++) for (let a = 1; a <= 8; a++) allW.push(DB.backoff('DATABASE_DEADLOCK', a, { rng: Math.random }));
  chk('retry: over 1 600 random draws the wait never exceeds the cap and is never below 100 ms', allW.every((w) => w >= 100 && w <= DB.DEFAULTS.cap.DATABASE_DEADLOCK), [Math.min(...allW), Math.max(...allW)]);
  let m = 0; const inc2 = []; let err = null;
  try { await DB.withRetry(async () => { m++; throw Object.assign(new Error('x'), { cfb_code: 'DATABASE_DEADLOCK' }); }, { sleep: async () => {}, onIncident: async (e) => inc2.push(e) }); } catch (e) { err = e; }
  chk('retry: a deadlock storm stops after 5 attempts with a classified error and a CRITICAL exhausted incident', m === 5 && err && err.cfb_code === 'DATABASE_DEADLOCK' && err.runlog_class === 'DATABASE' && inc2.filter((e) => e.exhausted && e.severity === 'CRITICAL').length === 1);
  let k = 0; err = null;
  try { await DB.withRetry(async () => { k++; throw Object.assign(new Error('dup'), { cfb_code: 'DATABASE_CONSTRAINT' }); }, { sleep: async () => {} }); } catch (e) { err = e; }
  chk('retry: a constraint refusal is never retried', k === 1 && err.cfb_code === 'DATABASE_CONSTRAINT');
  k = 0; err = null;
  try { await DB.withRetry(async () => { k++; throw Object.assign(new Error('401'), { cfb_code: 'AUTH' }); }, { sleep: async () => {} }); } catch (e) { err = e; }
  chk('retry: an auth failure is never retried', k === 1 && err.cfb_code === 'AUTH');
  chk('retry: Retry-After is honoured (capped)', DB.backoff('PROVIDER_RATE_LIMIT', 1, { rng: () => 0, retryAfterMs: 7000 }) === 7000 && DB.backoff('PROVIDER_RATE_LIMIT', 1, { rng: () => 0, retryAfterMs: 10 * 60000 }) === DB.DEFAULTS.cap.PROVIDER_RATE_LIMIT);
  const g = DB.keyGroups([{ a: 1 }, { a: 2, b: 1 }, { a: 3 }, { b: 2, a: 4 }]);
  chk('mirror: rows are grouped by key set, first appearance first, nothing lost (PGRST102)', g.length === 2 && g[0].map((r) => r.a).join() === '1,3' && g[1].map((r) => r.a).join() === '2,4');
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 201, text: async () => '', headers: { get: () => null } }; };
  const sent = await DB.postRows('http://x', 'k', 't', 'id', Array.from({ length: 1203 }, (_, i) => (i % 2 ? { id: i } : { id: i, extra: 1 })), { fetch: fakeFetch, chunk: 500 });
  chk('mirror: 1 203 rows in 500-row chunks, each split by key set, every row sent once', sent === 1203 && calls.length === 6 && calls.reduce((s, c) => s + c.length, 0) === 1203 && calls.every((c) => new Set(c.map((r) => Object.keys(r).sort().join())).size === 1));

  /* ================================================================ 3 logging */
  const lines = [];
  const lg = LOG.logger({ job: 'cfb_weekly_refresh' }, { env: { CFB_CORRELATION_ID: 'cfb-v2-shadow-123-1' }, sink: (l) => lines.push(l), now: () => '2026-10-03T12:00:00.000Z' });
  lg.warn('sync', 'retry', { game_id: '401', model_version: 'edgedesk_cfb_v2.1.0', provider: 'supabase', error_code: 'DATABASE_DEADLOCK', duration_ms: 12,
    apikey: 'sk_live_abcdefghijk', headers: { authorization: 'Bearer eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl' }, message: 'GET https://x/rest?apikey=abc123&x=1 failed with Bearer abcdefghijklmnop', lock_key: '2026' });
  const rec = JSON.parse(lines[0]);
  chk('logging: one JSON object per line with the fixed vocabulary', ['ts', 'level', 'job', 'correlation_id', 'run_id', 'stage', 'event', 'game_id', 'model_version', 'provider', 'error_code', 'duration_ms'].every((x) => x in rec) && rec.level === 'WARNING');
  chk('logging: the correlation id comes from CFB_CORRELATION_ID and doubles as run_id when none is given', rec.correlation_id === 'cfb-v2-shadow-123-1' && rec.run_id === 'cfb-v2-shadow-123-1');
  chk('logging: credential fields and tokens inside strings are redacted', rec.apikey === '[REDACTED]' && rec.headers.authorization === '[REDACTED]' && !/abc123|abcdefghijklmnop|eyJ/.test(lines[0]) && rec.lock_key === '2026');
  chk('logging: an invalid CFB_CORRELATION_ID is replaced, never trusted', /^cfb-local-/.test(LOG.correlationId({ CFB_CORRELATION_ID: 'x; rm -rf /' })));

  /* ================================================================ 4 locks */
  const rpcLog = [];
  const fake = (answers) => (fn, args) => { rpcLog.push([fn, args]); const a = answers[fn]; if (a instanceof Error) return Promise.reject(a); return Promise.resolve(typeof a === 'function' ? a(args) : a); };
  let ran = false;
  let r = await LOCKS.withJobLock({ job: 'cfb_weekly_refresh', lockKey: 2026, holder: 'h1', rpc: fake({ cfb_job_lock: { acquired: true, lease_id: 'L1' }, cfb_job_unlock: { released: true } }) }, async () => { ran = true; return 7; });
  chk('locks: acquired -> the job runs and the lease is released with its lease id', ran && r.result === 7 && rpcLog.some(([f, a]) => f === 'cfb_job_unlock' && a.p_lease_id === 'L1'));
  ran = false; rpcLog.length = 0;
  r = await LOCKS.withJobLock({ job: 'cfb_weekly_refresh', lockKey: 2026, holder: 'h2', rpc: fake({ cfb_job_lock: { acquired: false, holder: 'h1' } }) }, async () => { ran = true; });
  chk('locks: held by another run -> a clean skip (PIPELINE_CONFLICT), nothing runs, nothing released', !ran && r.skipped === 'PIPELINE_CONFLICT' && r.holder === 'h1' && !rpcLog.some(([f]) => f === 'cfb_job_unlock'));
  ran = false;
  r = await LOCKS.withJobLock({ job: 'cfb_weekly_refresh', lockKey: 2026, rpc: fake({ cfb_job_lock: Object.assign(new T.CfbError('404', 'DATABASE_SCHEMA'), { http: { status: 404 } }) }), log: LOG.logger({ job: 'x' }, { sink: () => {} }) }, async () => { ran = true; });
  chk('locks: migration not applied (404) -> runs under the workflow concurrency group, said out loud', ran && r.locked === false);
  err = null; ran = false;
  try { await LOCKS.withJobLock({ job: 'j_x', lockKey: 1, required: true, rpc: fake({ cfb_job_lock: new T.CfbError('404', 'DATABASE_SCHEMA') }) }, async () => { ran = true; }); } catch (e) { err = e; }
  chk('locks: with CFB_REQUIRE_JOB_LOCK a missing lock function fails closed', !ran && err && err.cfb_code === 'DATABASE_SCHEMA');
  err = null; ran = false;
  try { await LOCKS.withJobLock({ job: 'j_x', lockKey: 1, rpc: fake({ cfb_job_lock: new T.CfbError('500', 'DATABASE_TIMEOUT') }) }, async () => { ran = true; }); } catch (e) { err = e; }
  chk('locks: any other lock failure fails closed (nothing written)', !ran && err && err.cfb_code === 'DATABASE_TIMEOUT');
  rpcLog.length = 0;
  await LOCKS.withJobLock({ job: 'j_x', lockKey: 1, rpc: fake({ cfb_job_lock: { acquired: true, reentrant: true, lease_id: 'OUTER' } }) }, async () => 1);
  chk('locks: a re-entered lease (the gate\'s) is not released by the inner job', !rpcLog.some(([f]) => f === 'cfb_job_unlock'));
  rpcLog.length = 0; err = null;
  try { await LOCKS.withJobLock({ job: 'j_x', lockKey: 1, rpc: fake({ cfb_job_lock: { acquired: true, lease_id: 'L9' }, cfb_job_unlock: { released: true } }) }, async () => { throw new Error('boom'); }); } catch (e) { err = e; }
  chk('locks: a job that throws still releases its lease', err && rpcLog.some(([f, a]) => f === 'cfb_job_unlock' && a.p_lease_id === 'L9'));
  rpcLog.length = 0;
  const gr = await LOCKS.withGameLocks({ holder: 'h', rpc: fake({ cfb_job_lock: (a) => (a.p_key === '401000002' ? { acquired: false, holder: 'qb-news' } : { acquired: true, lease_id: 'L' + a.p_key }), cfb_job_unlock: {} }) },
    ['401000009', '401000002', '401000001', '401000009'], async (ids) => ids);
  chk('game locks: acquired in sorted order, duplicates once, the busy game skipped, released in reverse', JSON.stringify(rpcLog.filter(([f]) => f === 'cfb_job_lock').map(([, a]) => a.p_key)) === JSON.stringify(['401000001', '401000002', '401000009'])
    && JSON.stringify(gr.result) === JSON.stringify(['401000001', '401000009']) && JSON.stringify(rpcLog.filter(([f]) => f === 'cfb_job_unlock').map(([, a]) => a.p_key)) === JSON.stringify(['401000009', '401000001']));

  /* ================================================================ 5 compatibility */
  const facts0 = C.facts();
  const M = C.loadMatrix();
  /* the frozen pure-model tuple must hold on this tree; the decision side (baseline,
     calibration, policy) is reported by the release check, because concurrent
     work on the files the decision baseline pins can legitimately break it */
  const pureReal = C.check(facts0, M, { decisions: false });
  chk('compat: the repository\'s V2.1 pure-model tuple is explicitly COMPATIBLE (' + pureReal.length + ' checks)', pureReal.every((c) => c.ok), pureReal.filter((c) => !c.ok));
  const decReal = C.check(facts0, M).filter((c) => !c.ok);
  if (decReal.length) console.log('note | decision-side compatibility does not hold on this tree (the gate switches the decision step off): ' + decReal.map((c) => c.check + ' — ' + c.detail).join('; '));
  /* a consistent tree for the logic checks below: what the matrix pins */
  const facts = JSON.parse(JSON.stringify(facts0));
  if (facts.decision_baseline) { facts.decision_baseline.ok = true; Object.values(facts.decision_baseline.files).forEach((x) => { x.ok = true; }); }
  const real = C.check(facts, M);
  chk('compat: with the files the matrix pins, every check holds (' + real.length + ' checks)', real.every((c) => c.ok), real.filter((c) => !c.ok));
  const tamper = (f, fn) => { const x = JSON.parse(JSON.stringify(f)); fn(x); return C.check(x, M).filter((c) => !c.ok); };
  const byCode = (list) => list.map((c) => c.code);
  chk('compat: new feature code against the old artifact fails (MODEL_ARTIFACT)', byCode(tamper(facts, (x) => { x.feature_version = 'cfb_v2_fv3'; x.config_feature_version = 'cfb_v2_fv3'; })).includes('MODEL_ARTIFACT'));
  chk('compat: a calibration/params file other than the pinned one fails (CALIBRATION)', byCode(tamper(facts, (x) => { x.params_sha256 = '0'.repeat(64); })).includes('CALIBRATION'));
  chk('compat: an artifact that fails its MANIFEST fails', tamper(facts, (x) => { x.artifact.ok = false; x.artifact.reason = 'files differ'; }).some((c) => /MANIFEST/.test(c.check)));
  chk('compat: a decision policy the shadow engine would pick up but nobody pinned fails', tamper(facts, (x) => { x.decision_policy.dir = 'cfb_decision_policy_v2'; x.decision_policy.version = 'cfb_decision_policy_v2'; }).some((c) => /decision policy/.test(c.check)));
  chk('compat: a decision calibration for another model version fails', tamper(facts, (x) => { x.decision_calibration.base_model_version = 'edgedesk_cfb_v3.0.0'; }).some((c) => /decision calibration/.test(c.check)));
  chk('compat: a model version with no COMPATIBLE entry fails', C.check(facts, { entries: M.entries.filter((e) => e.model_version !== facts.production_model_version) }).some((c) => !c.ok && c.code === 'CALIBRATION'));
  chk('compat: betting enabled by a policy the matrix did not allow fails', tamper(facts, (x) => { x.decision_policy.bet_enabled = true; }).some((c) => /betting/.test(c.check)));
  chk('compat: candidate 001 (edgedesk_cfb_v2.0.0, feature fv1) is explicitly INCOMPATIBLE, never a fallback', M.entries.some((e) => e.model_version === 'edgedesk_cfb_v2.0.0' && e.status === 'INCOMPATIBLE') && !M.entries.some((e) => e.model_version === 'edgedesk_cfb_v2.0.0' && e.role === 'FALLBACK'));
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbpol-'));
  ['cfb_decision_policy_v0', 'cfb_decision_policy_v2', 'cfb_decision_policy_v10'].forEach((d) => { fs.mkdirSync(path.join(td, d)); fs.writeFileSync(path.join(td, d, 'policy.json'), '{}'); });
  chk('compat: the shadow engine\'s "newest policy directory" is LEXICAL (v2 beats v10) — why the pin exists', C.newestDir(td, 'cfb_decision_policy_', 'policy.json') === 'cfb_decision_policy_v2');
  const auditLab = fs.readFileSync(path.join(ROOT, 'football', 'cfb_lab', 'governance', 'audit_log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.event_type === 'MODEL_REGISTERED' && e.subject === 'edgedesk_cfb_v2.1.0');
  chk('compat: the calibration version equals the one the Model Lab registered for V2.1', auditLab && auditLab.after.facts.calibration_version === facts.calibration_version, auditLab && auditLab.after.facts.calibration_version);
  chk('compat: the Model Lab records the ensemble the manifest pins (its artifact\'s stack weights, no longer the hash of {})', facts.lab_ensemble_version === facts.ensemble_version && facts.lab_ensemble_version !== facts.production_model_version + ':44136fa355b3');

  /* ================================================================ 6 manifest */
  const m1 = MF.build({ deployedAt: '2026-10-03T12:00:00.000Z' }), m2 = MF.build({ deployedAt: '2026-10-10T12:00:00.000Z' });
  chk('manifest: champion_selection NOT_RUN, the governance champion V1, V2.1 as the production pathway', m1.champion_selection === 'NOT_RUN' && m1.champion_model_version === 'edgedesk_cfb_p4_v1.0.0'
    && m1.production_model_version === 'edgedesk_cfb_v2.1.0' && /ELIGIBLE_FOR_PROMOTION/.test(m1.production_model_status) && /governance\.js promote/.test(m1.champion_selection_note));
  const inGit = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'ignore' }).status === 0;
  chk('manifest: the git commit is recorded (when this is a git checkout)', !inGit || /^[0-9a-f]{40}$/.test(m1.git_commit || ''));
  chk('manifest: every version the brief names is present', ['migration_version', 'feature_version', 'training_data_version', 'team_rating_version', 'player_model_version', 'matchup_model_version',
    'ensemble_version', 'calibration_version', 'uncertainty_version', 'market_engine_version', 'decision_policy_version', 'decision_engine_version', 'deployed_at'].every((x) => m1[x]) && Object.keys(m1.artifact_hashes).length >= 10);
  chk('manifest: same system, another deployment -> same content hash, different manifest id', m1.content_sha256 === m2.content_sha256 && m1.manifest_id !== m2.manifest_id);
  const onlyCompat = (probs) => probs.filter((p) => !/generated with failing compatibility checks/.test(p));
  chk('manifest: a fresh build verifies (its files, its content hash)', onlyCompat(MF.verify(m1)).length === 0, MF.verify(m1));
  chk('manifest: a manifest generated while compatibility failed is flagged', MF.verify(Object.assign({}, m1, { compatibility: { ok: false, checks: [{ check: 'x', ok: false }] } })).some((p) => /failing compatibility/.test(p)));
  chk('manifest: an edited field is detected (content hash)', MF.verify(Object.assign({}, m1, { calibration_version: 'edgedesk_cfb_v2.1.0:000000000000' })).some((p) => /content_sha256/.test(p)));
  chk('manifest: SELECTED without championship evidence is refused', MF.verify(Object.assign({}, m1, { champion_selection: 'SELECTED' })).some((p) => /championship evidence/.test(p)));
  const trepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbman-'));
  Object.keys(m1.artifact_hashes).forEach((p) => { fs.mkdirSync(path.dirname(path.join(trepo, p)), { recursive: true }); fs.copyFileSync(path.join(ROOT, p), path.join(trepo, p)); });
  chk('manifest: verify() over an exact copy of the artifacts passes', onlyCompat(MF.verify(m1, { repo: trepo })).length === 0, MF.verify(m1, { repo: trepo }));
  fs.appendFileSync(path.join(trepo, 'football/cfb_v2/artifacts/edgedesk_cfb_v2.1.0/gbm_D.txt'), '\n');
  fs.rmSync(path.join(trepo, 'football/cfb_v2/engine.js'));
  const vp = MF.verify(m1, { repo: trepo });
  chk('manifest: one changed byte and one missing artifact are both named', vp.some((p) => /hash differs: football\/cfb_v2\/artifacts\/edgedesk_cfb_v2\.1\.0\/gbm_D\.txt/.test(p)) && vp.some((p) => /artifact missing: football\/cfb_v2\/engine\.js/.test(p)), vp);
  const gitP = MF.verifyFromGit(m1);
  chk('manifest: every pinned artifact is recoverable byte-for-byte from git (disaster recovery), or the gap is named', gitP.every((p) => /git has no blob/.test(p)), gitP.slice(0, 3));
  chk('manifest: the fallback hierarchy is explicit: V2.1 FULL, V2.1 degraded, V1, UNAVAILABLE — never the candidate', m1.fallback_hierarchy.map((l) => l.mode).join() === 'FULL,DEGRADED,FALLBACK_MODEL,UNAVAILABLE'
    && m1.fallback_hierarchy[2].model_version === 'edgedesk_cfb_p4_v1.0.0' && m1.fallback_hierarchy[3].model_version === null && !JSON.stringify(m1.fallback_hierarchy).includes('edgedesk_cfb_v2.0.0'));
  const sqlCols = (() => { const t = /create table if not exists public\.cfb_production_model_manifest \(([\s\S]*?)\n\);/.exec(read('supabase/cfb_production.sql'))[1];
    return t.split('\n').map((l) => /^\s+([a-z0-9_]+)\s+(text|boolean|jsonb|timestamptz)/.exec(l)).filter(Boolean).map((x) => x[1]); })();
  chk('manifest: the Postgres row carries exactly the table\'s columns (the push cannot be refused for a key)', JSON.stringify(Object.keys(MF.row(m1)).sort()) === JSON.stringify(sqlCols.filter((c) => c !== 'recorded_at').sort()), [Object.keys(MF.row(m1)).length, sqlCols.length]);
  const committed = JSON.parse(read('football/cfb_production/manifest.json'));
  chk('manifest: the committed manifest.json says NOT_RUN and names the production system', committed.champion_selection === 'NOT_RUN' && committed.production_model_version === 'edgedesk_cfb_v2.1.0' && /^cfbm_[0-9a-f]{24}$/.test(committed.manifest_id));

  /* ================================================================ 7 versioning */
  chk('versioning: parse edgedesk_cfb_v2.1.0', JSON.stringify(V.parse('edgedesk_cfb_v2.1.0')) === JSON.stringify({ major: 2, minor: 1, patch: 0 }) && JSON.stringify(V.parse('edgedesk_cfb_p4_v1.0.0')) === JSON.stringify({ major: 1, minor: 0, patch: 0 }));
  chk('versioning: MAJOR / MINOR / PATCH by kind of change', V.requiredBump(['bug_fix']) === 'PATCH' && V.requiredBump(['retrain', 'bug_fix']) === 'MINOR' && V.requiredBump(['feature_schema']) === 'MAJOR' && V.requiredBump([]) === 'NONE');
  chk('versioning: a recalibration shipped as a patch is insufficient; as a minor it is fine', !V.sufficient('edgedesk_cfb_v2.1.0', 'edgedesk_cfb_v2.1.1', ['calibration']).ok && V.sufficient('edgedesk_cfb_v2.1.0', 'edgedesk_cfb_v2.2.0', ['calibration']).ok);
  chk('versioning: a downgrade is never sufficient', !V.sufficient('edgedesk_cfb_v2.1.0', 'edgedesk_cfb_v2.0.9', ['bug_fix']).ok);
  const shaReal = (p) => C.shaFile(path.join(ROOT, p));
  chk('versioning: no unversioned change in the repository now', V.unversionedChanges(m1, facts, shaReal).length === 0);
  chk('versioning: engine.js edited under the same model version is an unversioned hotfix', V.unversionedChanges(m1, facts, (p) => (p === 'football/cfb_v2/engine.js' ? 'f'.repeat(64) : shaReal(p))).some((u) => u.file === 'football/cfb_v2/engine.js'));

  /* ================================================================ 8 gate */
  const outFile = path.join(os.tmpdir(), 'gate-out-' + process.pid), envFile = path.join(os.tmpdir(), 'gate-env-' + process.pid);
  const genv = (extra) => { fs.writeFileSync(outFile, ''); fs.writeFileSync(envFile, ''); return Object.assign({ GITHUB_OUTPUT: outFile, GITHUB_ENV: envFile, CFB_CORRELATION_ID: 'cfb-test-1' }, extra || {}); };
  const outputs = () => Object.fromEntries(fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
  const silent = () => {};
  let gs = await GATE.start({ job: 'cfb_lab_hourly', key: 'auto' }, genv(), { sink: silent, now: '2026-10-03T12:00:00Z', facts });
  chk('gate: no database -> proceed, lock "none", decisions on', gs.code === 0 && outputs().proceed === 'true' && outputs().decisions === 'true' && /none/.test(outputs().lock));
  const badFacts = JSON.parse(JSON.stringify(facts)); badFacts.params_sha256 = '1'.repeat(64);
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(), { sink: silent, facts: badFacts });
  chk('gate: an incompatible tuple fails the job (exit 2), proceed=false', gs.code === 2 && outputs().proceed === 'false' && /incompatible/.test(outputs().reason));
  const decFacts = JSON.parse(JSON.stringify(facts)); decFacts.decision_policy.sha256 = '2'.repeat(64);
  const liveGate = await GATE.start({ job: 'cfb_lab_hourly' }, genv(), { sink: silent });
  chk('gate: on this tree the lab proceeds (the pure-model tuple holds)', liveGate.code === 0 && outputs().proceed === 'true');
  gs = await GATE.start({ job: 'cfb_lab_hourly' }, genv(), { sink: silent, facts: decFacts });
  chk('gate: a decision-side mismatch keeps the lab running but switches the decision step off', gs.code === 0 && outputs().proceed === 'true' && outputs().decisions === 'false');
  const net = (routes) => { const seen = []; const f = async (url, init) => { const u = new URL(url); const key = u.pathname.replace('/rest/v1/', ''); seen.push(key); const r = routes[key];
    const v2 = typeof r === 'function' ? r(JSON.parse((init && init.body) || '{}')) : r; const st = v2 && v2.__status || 200;
    return { ok: st < 300, status: st, text: async () => JSON.stringify(v2 && v2.__body !== undefined ? v2.__body : v2), json: async () => (v2 && v2.__body !== undefined ? v2.__body : v2), headers: { get: () => null } }; }; f.seen = seen; return f; };
  const dbEnv = { SB_URL: 'http://db.test', SB_SERVICE_ROLE: 'k' };
  let f1 = net({ cfb_feature_flags: [{ enabled: false }], 'rpc/cfb_heartbeat': 1 });
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(dbEnv), { sink: silent, fetch: f1, facts });
  chk('gate: kill switch off -> proceed=false, heartbeat SKIPPED_DISABLED, exit 0', gs.code === 0 && outputs().proceed === 'false' && /kill switch/.test(outputs().reason) && f1.seen.includes('rpc/cfb_heartbeat'));
  /* a Supabase outage: the flag and the lock cannot be read (network / 5xx after retries) */
  const down = (url) => { const u = new URL(url).pathname; if (/cfb_feature_flags|cfb_job_lock|cfb_heartbeat|cfb_record_incident/.test(u)) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })); };
  const outage = async (url) => down(url);
  const fastRetry = { base: { PROVIDER_TRANSIENT: 1, DATABASE_UNAVAILABLE: 1 }, cap: { PROVIDER_TRANSIENT: 2, DATABASE_UNAVAILABLE: 2 } };
  const saveBase = Object.assign({}, DB.DEFAULTS.base), saveCap = Object.assign({}, DB.DEFAULTS.cap);
  Object.assign(DB.DEFAULTS.base, fastRetry.base); Object.assign(DB.DEFAULTS.cap, fastRetry.cap);
  gs = await GATE.start({ job: 'cfb_lab_hourly' }, genv(dbEnv), { sink: silent, fetch: outage, facts });
  chk('gate: Supabase unreachable -> open for capture (proceed=true), closed for decisions (decisions=false), exit 0', gs.code === 0 && outputs().proceed === 'true' && outputs().decisions === 'false' && /unavailable: PROVIDER_TRANSIENT/.test(outputs().lock) && /degraded/.test(outputs().reason), outputs());
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(dbEnv), { sink: silent, fetch: outage, facts });
  chk('gate: the weekly freeze is not stopped by a Supabase outage', gs.code === 0 && outputs().proceed === 'true');
  gs = await GATE.start({ job: 'cfb_lab_hourly' }, genv(Object.assign({ CFB_REQUIRE_JOB_LOCK: '1' }, dbEnv)), { sink: silent, fetch: outage, facts });
  chk('gate: strict mode (CFB_REQUIRE_JOB_LOCK=1) fails closed when the flag cannot be read', outputs().proceed === 'false');
  f1 = net({ cfb_feature_flags: [{ enabled: true }], 'rpc/cfb_job_lock': { __status: 503, __body: 'upstream' }, 'rpc/cfb_heartbeat': 1, 'rpc/cfb_record_incident': {} });
  gs = await GATE.start({ job: 'cfb_lab_hourly' }, genv(dbEnv), { sink: silent, fetch: f1, facts });
  chk('gate: a lock RPC that keeps failing (not a schema answer) -> proceed under the concurrency group, decisions off', gs.code === 0 && outputs().proceed === 'true' && outputs().decisions === 'false' && /none \(unavailable: PROVIDER_TRANSIENT\)/.test(outputs().lock) && f1.seen.includes('rpc/cfb_record_incident'), outputs());
  gs = await GATE.start({ job: 'cfb_lab_hourly' }, genv(Object.assign({ CFB_REQUIRE_JOB_LOCK: '1' }, dbEnv)), { sink: silent, fetch: f1, facts });
  chk('gate: ... and in strict mode it fails closed (exit 3, proceed=false)', gs.code === 3 && outputs().proceed === 'false');
  Object.assign(DB.DEFAULTS.base, saveBase); Object.assign(DB.DEFAULTS.cap, saveCap);
  f1 = net({ cfb_feature_flags: [{ enabled: true }], 'rpc/cfb_job_lock': { acquired: false, holder: 'gh-other-9-1', expires_at: 'x' }, 'rpc/cfb_heartbeat': 1 });
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(dbEnv), { sink: silent, fetch: f1, facts });
  chk('gate: another run holds the lock -> proceed=false (PIPELINE_CONFLICT), exit 0, heartbeat SKIPPED_LOCKED', gs.code === 0 && outputs().proceed === 'false' && /PIPELINE_CONFLICT/.test(outputs().reason));
  f1 = net({ cfb_feature_flags: [{ enabled: true }], 'rpc/cfb_job_lock': { acquired: true, lease_id: 'lease_abc' }, 'rpc/cfb_heartbeat': 1 });
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(Object.assign({ GITHUB_RUN_ID: '42', GITHUB_WORKFLOW: 'CFB V2 shadow' }, dbEnv)), { sink: silent, fetch: f1, facts });
  const exported = fs.readFileSync(envFile, 'utf8');
  chk('gate: lock acquired -> proceed, the lease exported for the job\'s own mirror to re-enter', outputs().proceed === 'true' && /CFB_JOB_LOCK_LEASE=lease_abc/.test(exported) && /CFB_JOB_LOCK_HOLDER=gh-CFB_V2_shadow-42-1/.test(exported));
  f1 = net({ cfb_feature_flags: [{ enabled: true }], 'rpc/cfb_job_lock': { __status: 404, __body: { code: 'PGRST202' } }, 'rpc/cfb_heartbeat': { __status: 404, __body: { code: 'PGRST202' } } });
  gs = await GATE.start({ job: 'cfb_weekly_refresh' }, genv(dbEnv), { sink: silent, fetch: f1, facts });
  chk('gate: before cfb_production.sql is applied the job still runs (proceed=true, lock "none (not applied)")', outputs().proceed === 'true' && /not applied/.test(outputs().lock));
  const bodies = [];
  f1 = net({ 'rpc/cfb_job_unlock': (b) => { bodies.push(['unlock', b]); return { released: true }; }, 'rpc/cfb_heartbeat': (b) => { bodies.push(['hb', b]); return 1; }, 'rpc/cfb_record_incident': (b) => { bodies.push(['inc', b]); return {}; } });
  const gf = await GATE.finish({ job: 'cfb_weekly_refresh', status: 'failure' }, genv(Object.assign({ CFB_JOB_LOCK_LEASE: 'lease_abc', CFB_JOB_LOCK_KEY: '2026' }, dbEnv)), { sink: silent, fetch: f1 });
  chk('gate finish: failure -> lease released, FAILED heartbeat, a CRITICAL incident (MONDAY REFRESH FAILED)', gf.code === 0 && bodies.some(([k, b]) => k === 'unlock' && b.p_lease_id === 'lease_abc')
    && bodies.some(([k, b]) => k === 'hb' && b.p_status === 'FAILED') && bodies.some(([k, b]) => k === 'inc' && b.p_severity === 'CRITICAL' && /JOB_FAILED:cfb_weekly_refresh/.test(b.p_incident_key)));
  const gf2 = await GATE.finish({ job: 'cfb_lab_hourly', status: 'success' }, genv(dbEnv), { sink: silent, fetch: async () => { throw new TypeError('fetch failed'); } });
  chk('gate finish: never throws, even when the database is down (it must not mask the job result)', gf2.code === 0);
  chk('gate: seasons roll over in February (Jan games belong to the prior season)', GATE.seasonFor(new Date('2027-01-10T00:00:00Z')) === 2026 && GATE.seasonFor(new Date('2026-09-27T00:00:00Z')) === 2026);

  /* ================================================================ 9 jobs */
  chk('jobs: every registry cron is the cron in its workflow / pg_cron file (no drift)', J.drift().length === 0, J.drift());
  chk('jobs: the SQL seed of cfb_job_registry is generated from jobs.json', J.seedInSql(read('supabase/cfb_production.sql')) === J.seedSql());
  const reg = J.registry();
  chk('jobs: every job documents frequency, purpose, dependencies, duration, lock, retry and failure alert', reg.jobs.every((j) => (j.github_crons.length || j.pg_cron.length) && j.purpose && j.dependencies && j.expected_minutes && j.lock_scope && j.retry && j.failure_alert && j.expected_basis));
  chk('jobs: timeouts in the registry are the workflows\' timeout-minutes', reg.jobs.filter((j) => j.workflow.endsWith('.yml')).every((j) => { const mm = /timeout-minutes:\s*(\d+)/.exec(read(j.workflow)); return (mm ? +mm[1] : 360) === j.timeout_minutes; }));
  chk('cron: parser expands Sun+Mon 10:05 in Aug-Jan only', J.occurrences('5 10 * 8-12,1 0,1', Date.parse('2026-10-04T00:00:00Z'), Date.parse('2026-10-11T00:00:00Z')).map((t) => new Date(t).toISOString()).join() === '2026-10-04T10:05:00.000Z,2026-10-05T10:05:00.000Z'
    && J.occurrences('5 10 * 8-12,1 0,1', Date.parse('2026-03-01T00:00:00Z'), Date.parse('2026-03-08T00:00:00Z')).length === 0);
  chk('cron: */10 and ranges', J.occurrences('*/10 * * * *', 0, 3600000).length === 6 && J.occurrences('25 0-5 * 9-12,1 0', Date.parse('2026-10-04T00:00:00Z'), Date.parse('2026-10-05T00:00:00Z')).length === 6);
  const col = J.collisions();
  const find = (a, b) => col.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  chk('collisions: the lab\'s two clocks are serialized by its concurrency group', find('cfb_lab_hourly', 'cfb_lab_hourly').class === 'SERIALIZED');
  chk('collisions: board build and enrichment share football/fbs/slate.json and one concurrency group (serialized)', find('cfb_v1_board_build', 'cfb_enrichment').class === 'SERIALIZED');
  chk('collisions: the known cross-group writer of football/fbs (starter-context) is found', find('cfb_v1_board_build', 'cfb_starter_context').class === 'WRITE_COLLISION');
  chk('collisions: capture and the lab mirror share only append-only tables (DB_CONCURRENT)', find('cfb_lab_hourly', 'cfb_odds_capture').class === 'DB_CONCURRENT');
  const labYml = read('.github/workflows/cfb-lab.yml'), v2Yml = read('.github/workflows/cfb-v2-shadow.yml');
  chk('workflow: cfb-lab.yml publishes football/cfb_lab/reports (provider_health.json, the circuit-breaker state)', /push_generated\.sh main[^\n]*\\\n\s*football\/cfb_lab\/ledger football\/cfb_lab\/governance football\/cfb_lab\/reports/.test(labYml)
    && fs.existsSync(path.join(ROOT, 'football/cfb_lab/reports/2026/provider_health.json')));
  chk('workflow: both scheduled CFB jobs pass the gate first and always finish it', /gate\.js start --job cfb_lab_hourly/.test(labYml) && /gate\.js finish --job cfb_lab_hourly/.test(labYml) && /gate\.js start --job cfb_weekly_refresh/.test(v2Yml) && /gate\.js finish --job cfb_weekly_refresh/.test(v2Yml)
    && /if: \$\{\{ always\(\)/.test(labYml) && /CFB_CORRELATION_ID/.test(labYml) && /CFB_CORRELATION_ID/.test(v2Yml));
  chk('workflow: the lab job writes the operations report and publishes it', /health\.js/.test(labYml) && /football\/cfb_production\/reports/.test(labYml));

  /* ================================================================ 10 anomaly */
  const slate = (fn) => Array.from({ length: 40 }, (_, i) => Object.assign({ game_id: 'g' + i, home_id: 'h' + i, away_id: 'a' + i, margin: (i % 21) - 10, fair_home_line: -((i % 21) - 10),
    p_home: 0.5 + ((i % 21) - 10) / 40, market_home_line: -((i % 21) - 10) + ((i % 5) - 2), status: i % 9 ? 'PASS' : 'LEAN', home_conference: ['SEC', 'ACC', 'Big Ten', 'Big 12'][i % 4], away_conference: 'MAC' }, fn ? fn(i) : {}));
  const base = { mean_abs_margin: [5.2, 5.1, 5.0], bets_per_week: [0, 1, 0], conferences: ['SEC', 'ACC', 'Big Ten', 'Big 12', 'MAC'] };
  chk('anomaly: a normal slate raises nothing', A.detect(slate(), base).alerts.length === 0, A.detect(slate(), base).alerts);
  const rules = (rows, b) => A.detect(rows, b || base).alerts.map((x) => x.rule);
  chk('anomaly: average spread doubles -> AVG_SPREAD_SHIFT CRITICAL', rules(slate((i) => ({ margin: ((i % 21) - 10) * 2.5, fair_home_line: -((i % 21) - 10) * 2.5 }))).includes('AVG_SPREAD_SHIFT'));
  chk('anomaly: half the games >10 pts off the market -> MARKET_GAP_WIDESPREAD', rules(slate((i) => ({ market_home_line: i % 2 ? 15 : null }))).includes('MARKET_GAP_WIDESPREAD'));
  chk('anomaly: BET count triples -> BET_SPIKE (a review, never a cancellation)', rules(slate((i) => ({ status: i < 5 ? 'BET' : 'PASS' }))).includes('BET_SPIKE') && /never cancelled|nothing is cancelled/.test(A.detect(slate((i) => ({ status: i < 5 ? 'BET' : 'PASS' })), base).alerts[0].message));
  chk('anomaly: all probabilities near 50% -> PROB_NEAR_50', rules(slate(() => ({ p_home: 0.51 }))).includes('PROB_NEAR_50'));
  chk('anomaly: all probabilities near 90% -> PROB_NEAR_90', rules(slate((i) => ({ p_home: i % 2 ? 0.93 : 0.08 }))).includes('PROB_NEAR_90'));
  chk('anomaly: one conference missing -> CONFERENCE_MISSING', rules(slate(), Object.assign({}, base, { conferences: base.conferences.concat(['Pac-12']) })).includes('CONFERENCE_MISSING'));
  chk('anomaly: a sign flip -> SIGN_CONVENTION CRITICAL', rules(slate((i) => (i === 3 ? { fair_home_line: 7, margin: 7 } : {}))).includes('SIGN_CONVENTION'));
  chk('anomaly: home = away -> HOME_EQUALS_AWAY; p = 1 -> OUT_OF_BOUNDS', rules(slate((i) => (i === 1 ? { away_id: 'h1' } : i === 2 ? { p_home: 1 } : {}))).join().includes('HOME_EQUALS_AWAY') && rules(slate((i) => (i === 2 ? { p_home: 1 } : {}))).includes('OUT_OF_BOUNDS'));
  chk('anomaly: distribution rules stay quiet below 10 games', A.detect(slate().slice(0, 5).map((r) => Object.assign(r, { p_home: 0.5 })), base).alerts.length === 0);

  /* ================================================================ 11 health */
  const now = '2026-10-03T15:00:00.000Z';
  const realOps = H.build({ now, season: 2026 });
  chk('health: the repository report names V1 champion, NOT_RUN, the production model and every section', realOps.sections.model_version.champion === 'edgedesk_cfb_p4_v1.0.0' && realOps.sections.model_version.champion_selection === 'NOT_RUN'
    && ['model_version', 'last_weekly_run', 'source_health', 'odds_age', 'pbp_age', 'failed_jobs', 'degraded_games', 'predictions', 'bet_decisions', 'warnings', 'incidents'].every((s) => realOps.sections[s] && realOps.sections[s].status));
  chk('health: incidents without a database are UNKNOWN, and UNKNOWN never makes the system OK', realOps.sections.incidents.status === 'UNKNOWN' && realOps.system.status !== 'OK');
  const hrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbops-'));
  const copy = (rel) => { const s = path.join(ROOT, rel), d = path.join(hrepo, rel); if (!fs.existsSync(s)) return; fs.mkdirSync(path.dirname(d), { recursive: true }); fs.cpSync(s, d, { recursive: true }); };
  ['football/cfb_v2/params.js', 'football/cfb_v2/engine.js', 'football/cfb_v2/current.json', 'football/cfb_v2/research/v2/config.py', 'football/cfb_v2/research/v2/market.py', 'football/cfb_v2/research/v2/weekly/team_state.py',
    'football/cfb_v2/research/v2/weekly/qb_state.py', 'football/cfb_v2/research/v2/matchup/__init__.py', 'football/cfb_v2/research/v2/personnel/__init__.py', 'football/cfb_v2/artifacts', 'football/cfb_v2/shadow',
    'football/cfb_decision/decision.js', 'football/cfb_p4/params.js', 'football/cfb_lab/governance', 'football/cfb_lab/reports/2026', 'football/cfb_lab/ledger/2026/quotes', 'football/fbs/slate.json',
    'football/cfb_production/manifest.json', 'football/cfb_production/compatibility.json', 'supabase'].forEach(copy);
  const tw = JSON.parse(fs.readFileSync(path.join(hrepo, 'football/cfb_lab/reports/2026/lab.json'), 'utf8'));
  const newestQ = (() => { let t = 0; fs.readdirSync(path.join(hrepo, 'football/cfb_lab/ledger/2026/quotes')).forEach((f) => fs.readFileSync(path.join(hrepo, 'football/cfb_lab/ledger/2026/quotes', f), 'utf8').split('\n').filter(Boolean)
    .forEach((l) => { const x = Date.parse(JSON.parse(l).observed_at); if (x > t) t = x; })); return t; })();
  /* one game kicks off 24 h after the newest captured quote */
  tw.this_week[0].kickoff = new Date(newestQ + 24 * 3600000).toISOString();
  fs.writeFileSync(path.join(hrepo, 'football/cfb_lab/reports/2026/lab.json'), JSON.stringify(tw));
  const soonKick = newestQ + 24 * 3600000;
  const at = (mins) => new Date(newestQ + mins * 60000).toISOString();
  if (soonKick) {
    const within = (mins) => soonKick - (newestQ + mins * 60000) <= 48 * 3600000 && soonKick > newestQ + mins * 60000;
    const okAt = [60, 200, 400].filter(within);
    chk('health: odds 60 min old with a game inside 48 h is OK; 200 min WARNING (MARKET_STALE for decisions); 400 min CRITICAL', okAt.length === 3
      && H.build({ now: at(60), repo: hrepo, season: 2026 }).sections.odds_age.status === 'OK' && H.build({ now: at(200), repo: hrepo, season: 2026 }).sections.odds_age.status === 'WARNING'
      && H.build({ now: at(400), repo: hrepo, season: 2026 }).sections.odds_age.status === 'CRITICAL', { newest: new Date(newestQ).toISOString(), kick: new Date(soonKick).toISOString() });
  }
  const sdPath = path.join(hrepo, 'football/cfb_v2/shadow/2026/decisions.json');
  const sd = JSON.parse(fs.readFileSync(sdPath, 'utf8')); sd.counts.BET = 2; fs.writeFileSync(sdPath, JSON.stringify(sd));
  chk('health: a BET while betting is disabled is CRITICAL (fail-safe breach)', H.build({ now, repo: hrepo, season: 2026 }).sections.bet_decisions.status === 'CRITICAL');
  chk('health: in season with no weekly run recorded -> CRITICAL; off season -> UNKNOWN (never OK)', H.build({ now, repo: hrepo, season: 2026 }).sections.last_weekly_run.status === 'CRITICAL'
    && H.build({ now: '2026-05-01T12:00:00Z', repo: hrepo, season: 2026 }).sections.last_weekly_run.status === 'UNKNOWN');
  fs.mkdirSync(path.join(hrepo, 'football/cfb_weekly/2026'), { recursive: true });
  fs.writeFileSync(path.join(hrepo, 'football/cfb_weekly/2026/runs.jsonl'), JSON.stringify({ run_id: 'cfbw_x', mode: 'weekly', status: 'FAILED', started_at: '2026-10-03T10:05:00Z', errors: [{ stage: 'VALIDATE_PBP', class: 'TRANSIENT', message: 'cfbfastR 503' }] }) + '\n');
  const failedRun = H.build({ now, repo: hrepo, season: 2026 });
  chk('health: a FAILED Monday refresh is CRITICAL in two places (last run, failed jobs)', failedRun.sections.last_weekly_run.status === 'CRITICAL' && failedRun.sections.failed_jobs.status === 'CRITICAL' && failedRun.sections.failed_jobs.failed.some((x) => x.job === 'cfb_weekly_refresh'));
  const mp = path.join(hrepo, 'football/cfb_production/manifest.json');
  const mj = JSON.parse(fs.readFileSync(mp, 'utf8')); mj.feature_version = 'tampered'; fs.writeFileSync(mp, JSON.stringify(mj));
  chk('health: an edited manifest is reported', H.build({ now, repo: hrepo, season: 2026 }).sections.model_version.manifest_problems.some((p) => /content_sha256/.test(p)));
  fs.appendFileSync(path.join(hrepo, 'football/cfb_v2/params.js'), '\n// hotfix\n');
  chk('health: params.js changed without a new compatible tuple -> model version CRITICAL', H.build({ now, repo: hrepo, season: 2026 }).sections.model_version.status === 'CRITICAL');
  fs.rmSync(hrepo, { recursive: true, force: true });

  /* ================================================================ 12 migrations, YAML, docs, one write path, release check */
  const own = MR.review('cfb_production');
  chk('migration review: cfb_production.sql has no destructive statement, no DROP TRIGGER / POLICY, no unguarded RLS, and bounds its lock wait', own.destructive.length === 0 && own.recreate === 0 && own.rls_enable.unguarded === 0 && own.lock_timeout, own);
  const allRev = MR.files().map(MR.review);
  chk('migration review: no CFB migration contains a destructive statement', allRev.every((r) => !r.destructive.length), allRev.filter((r) => r.destructive.length).map((r) => [r.file, r.destructive]));
  const mrep = JSON.parse(read('football/cfb_production/reports/migration_review.json'));
  chk('migration review: the measured report shows cfb_production.sql re-applies without ACCESS EXCLUSIVE on any table', mrep.measured && mrep.measured.cfb_production && Array.isArray(mrep.measured.cfb_production.reapply_access_exclusive_tables) && mrep.measured.cfb_production.reapply_access_exclusive_tables.length === 0);
  if (hasPython) {
    const ymls = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /^cfb-.*\.yml$/.test(f)).concat(['deploy-intelligence.yml']);
    const y = cp.spawnSync('python3', ['-c', 'import sys,yaml\nfor f in sys.argv[1:]: yaml.safe_load(open(f))\nprint("ok")'].concat(ymls.map((f) => path.join(ROOT, '.github/workflows', f))), { encoding: 'utf8' });
    chk('workflows: every cfb-*.yml and deploy-intelligence.yml is valid YAML', /ok/.test(y.stdout), y.stderr.slice(0, 300));
  }
  chk('deploy: cfb_production.sql is applied after cfb_decision.sql, then the manifest is recorded', (() => { const d = read('.github/workflows/deploy-intelligence.yml'); const a = d.indexOf('-f supabase/cfb_decision.sql'), b = d.indexOf('-f supabase/cfb_production.sql'), c = d.indexOf('manifest.js --push'); return a > 0 && b > a && c > b; })());
  const RB = fs.existsSync(path.join(ROOT, 'docs/cfb-production/RUNBOOK.md')) ? read('docs/cfb-production/RUNBOOK.md') : '';
  chk('docs: the seven production documents exist', ['ARCHITECTURE', 'DEPLOYMENT', 'ROLLBACK', 'JOBS', 'VERSIONING', 'OPERATIONS', 'RUNBOOK'].every((d) => fs.existsSync(path.join(ROOT, 'docs/cfb-production', d + '.md'))));
  const scen = ['MONDAY REFRESH FAILED', 'ODDS STALE', 'MODEL UNAVAILABLE', 'DATABASE ERROR', 'DEADLOCK STORM', 'MODEL ARTIFACT MISSING', 'TEAM MAPPING ERROR', 'QB SOURCE STALE'];
  chk('docs: the runbook has every scenario, each with symptom / automatic behavior / investigation / recovery', scen.every((s) => { const i = RB.indexOf('## ' + s); if (i < 0) return false; const j = RB.indexOf('\n## ', i + 3); const sec = RB.slice(i, j < 0 ? undefined : j);
    return /\*\*Symptom/.test(sec) && /\*\*Automatic behavior/.test(sec) && /\*\*Investigation/.test(sec) && /\*\*Recovery/.test(sec); }), scen.filter((s) => RB.indexOf('## ' + s) < 0));
  const syncs = ['cfb_lab', 'cfb_v2', 'cfb_weekly', 'cfb_personnel', 'cfb_decision'].map((d) => [d, read('football/' + d + '/sync_supabase.js')]);
  chk('one write path: every CFB mirror writes through cfb_production/db.js, none keeps its own POST loop', syncs.every(([, s]) => /cfb_production', 'db\.js'\)|cfb_production\/db\.js|'cfb_production', 'db\.js'/.test(s) && /DB\.postRows/.test(s) && !/fetch\(url \+ '\/rest\/v1\/' \+ table/.test(s) && !/fetch\(URL_ \+ '\/rest\/v1\/'/.test(s)), syncs.filter(([, s]) => !/DB\.postRows/.test(s)).map(([d]) => d));
  const wroot = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbw-'));
  fs.mkdirSync(path.join(wroot, '2026', 'upcoming_game_features'), { recursive: true });
  fs.writeFileSync(path.join(wroot, '2026', 'runs.jsonl'), JSON.stringify({ run_id: 'cfbw_' + 'a'.repeat(24), mode: 'weekly', status: 'PUBLISHED' }) + '\n');
  fs.writeFileSync(path.join(wroot, '2026', 'upcoming_game_features', 'week_05.jsonl'), JSON.stringify({ feature_snapshot_id: 'cfbf_' + 'b'.repeat(24), inputs: { a: 1 } }) + '\n');
  const wp = require('../cfb_weekly/sync_supabase.js').plan(2026, wroot);
  chk('weekly mirror: the run row (commit marker) goes last; the feature snapshots are mirrored, before the projections', wp[wp.length - 1].table === 'cfb_pipeline_runs'
    && wp.find((x) => x.table === 'cfb_upcoming_game_features').rows.length === 1 && wp.findIndex((x) => x.table === 'cfb_upcoming_game_features') < wp.findIndex((x) => x.table === 'cfb_weekly_projections'));
  const rc = require('../../tools/cfb/release_check.js').check({ skipTests: true });
  chk('release check: twelve items, each PASS / WARN / FAIL with evidence', rc.items.length === 12 && rc.items.every((i) => ['PASS', 'WARN', 'FAIL'].includes(i.status) && i.detail != null), rc.items.map((i) => i.status));
  chk('release check: migration safety and no-unversioned-hotfix pass on this tree', [3, 7].every((nn) => rc.items.find((i) => i.n === nn).status === 'PASS'), rc.items.filter((i) => [3, 7].includes(i.n)));
  chk('release check: a compatibility failure is a FAIL, never a WARN', rc.items.find((i) => i.n === 6).status === (C.check(facts0, M).every((c) => c.ok) ? 'PASS' : 'FAIL'));

  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 600) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
