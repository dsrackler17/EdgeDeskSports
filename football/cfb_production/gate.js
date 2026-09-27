#!/usr/bin/env node
/* ============================================================================
   CFB production — the gate every scheduled CFB job passes first, and the
   finish it always runs (docs/cfb-production/JOBS.md §2-3).

     node football/cfb_production/gate.js start  --job <registry job> [--key auto|<key>]
                                                  [--flag <kill switch>] [--ttl <s>]
     node football/cfb_production/gate.js finish --job <registry job> [--key ...]
                                                  --status success|failure|cancelled [--proceeded true|false]

   START, in this order:
     1. COMPATIBILITY (compat.js): the V2.1 artifact verifies against its
        MANIFEST and the tuple model x feature schema x calibration x engine is
        the one compatibility.json pins. A failure FAILS THE JOB (exit 2):
        nothing is inferred, snapshotted or mirrored with an unpinned artifact.
        The decision-side checks (policy, baseline, calibration, engine version)
        only switch the decision step off (output decisions=false).
     2. KILL SWITCH: the job's flag in cfb_feature_flags. Off -> proceed=false,
        heartbeat SKIPPED_DISABLED, exit 0.
     3. JOB LOCK: cfb_job_lock(job, key). Held by another run -> proceed=false,
        heartbeat SKIPPED_LOCKED, exit 0 (a clean exit, never an overlap). The
        lease is exported (CFB_JOB_LOCK_HOLDER / CFB_JOB_LOCK_LEASE via
        $GITHUB_ENV) so the job's own mirror re-enters it instead of competing.
     4. HEARTBEAT STARTED.

   A SUPABASE OUTAGE NEVER STOPS CAPTURE OR THE FREEZE. Market capture and the
   weekly freeze are append-only observations that can never be re-taken, and
   skipping them is not a false-BET risk; decisions are. So when the flag or the
   lock cannot be READ (network, DATABASE_UNAVAILABLE, a 5xx after retries — not
   a 404 / schema answer, not a flag that says off), the job proceeds under its
   workflow concurrency group with decisions=false (fail closed for decisions,
   open for capture), logs a WARNING and reports a best-effort incident. With
   CFB_REQUIRE_JOB_LOCK=1 (strict: the owner's opt-in once the SQL is applied)
   an unreadable flag or lock does not proceed.
   Outputs ($GITHUB_OUTPUT): proceed, decisions, lock, reason.

   FINISH (run with `if: always()`): releases the lease, sends the OK / FAILED
   heartbeat and, on failure, opens an incident (CRITICAL for the jobs the
   registry marks CRITICAL: "MONDAY REFRESH FAILED" is one). Always exits 0:
   it must never mask the job's own result.

   Without SB_URL / SB_SERVICE_ROLE, or before supabase/cfb_production.sql is
   applied, steps 2-4 report "not available" and the job runs under its
   workflow concurrency group alone — the state before this gate existed.
   Step 1 needs no database and is always enforced.
   ========================================================================== */
'use strict';
const fs = require('fs');
const C = require('./compat.js');
const DB = require('./db.js');
const T = require('./taxonomy.js');
const LOG = require('./log.js');
const LOCKS = require('./locks.js');

const JOBS = { cfb_weekly_refresh: { flag: 'cfb_weekly_engine_enabled', ttl: 6000, decisions: false, severity: 'CRITICAL' },
  cfb_lab_hourly: { flag: 'cfb_model_lab_enabled', ttl: 1800, decisions: true, severity: 'CRITICAL' } };

function seasonFor(d) { d = d || new Date(); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }

function output(env, kv) {
  const lines = Object.entries(kv).map(([k, v]) => k + '=' + String(v).replace(/\n/g, ' '));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  return kv;
}
function exportEnv(env, kv) {
  if (env.GITHUB_ENV) fs.appendFileSync(env.GITHUB_ENV, Object.entries(kv).map(([k, v]) => k + '=' + v).join('\n') + '\n');
}

/* the compatibility verdict for a job: { fatal: [...], decisionProblems: [...] } */
function compatibility(job, opts) {
  const f = (opts && opts.facts) || C.facts();
  const M = (opts && opts.matrix) || C.loadMatrix();
  const pure = C.check(f, M, { decisions: false });
  const all = C.check(f, M);
  const pureNames = new Set(pure.map((c) => c.check));
  return { fatal: pure.filter((c) => !c.ok), decisionProblems: all.filter((c) => !pureNames.has(c.check) && !c.ok), facts: f };
}

async function flagEnabled(o, flag) {
  if (!o.url || !o.key || !flag) return { enabled: true, source: 'no database' };
  try {
    const res = await DB.withRetry(() => DB.request(o.url + '/rest/v1/cfb_feature_flags?select=enabled&flag=eq.' + encodeURIComponent(flag),
      { headers: DB.headers(o.key) }, { fetch: o.fetch, timeoutMs: 15000 }), { label: 'flag ' + flag, log: o.log });
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return { enabled: true, source: 'flag not seeded' };
    return { enabled: rows[0].enabled !== false, source: 'cfb_feature_flags' };
  } catch (e) {
    const code = T.classify(e);
    if (code === 'DATABASE_SCHEMA' || (e.http && e.http.status === 404)) return { enabled: true, source: 'cfb_feature_flags not applied' };
    /* unreadable: open for capture, closed for decisions (strict mode: closed) */
    return { enabled: !o.strict, unreadable: true, code, source: 'unreadable (' + code + '): ' + String(e.message).slice(0, 200) };
  }
}

async function rpcSoft(o, fn, args) {
  if (!o.url || !o.key) return { skipped: 'no database' };
  try { return await DB.rpc(o.url, o.key, fn, args, { fetch: o.fetch, log: o.log, timeoutMs: 15000 }); } catch (e) {
    const code = T.classify(e);
    if (o.log) o.log.warn('gate', 'rpc_unavailable', { fn, error_code: code, message: e.message });
    return { skipped: code };
  }
}

async function start(args, env, io) {
  env = env || process.env; io = io || {};
  const job = args.job;
  const spec = JOBS[job] || { flag: args.flag || null, ttl: 1800, decisions: false };
  const key = !args.key || args.key === 'auto' ? String(seasonFor(io.now ? new Date(io.now) : new Date())) : String(args.key);
  const o = { url: env.SB_URL, key: env.SB_SERVICE_ROLE, fetch: io.fetch, log: io.log || LOG.logger({ job }, { env, sink: io.sink }),
    strict: env.CFB_REQUIRE_JOB_LOCK === '1' };
  const t0 = Date.now();
  const comp = compatibility(job, io);
  if (comp.fatal.length) {
    const why = comp.fatal.map((c) => c.check + ' [' + c.code + ']: ' + c.detail).join(' | ');
    o.log.critical('gate', 'incompatible', { error_code: comp.fatal[0].code, problems: comp.fatal });
    await rpcSoft(o, 'cfb_record_incident', { p_incident_key: comp.fatal[0].code + ':' + job + ':' + new Date().toISOString().slice(0, 10),
      p_error_code: comp.fatal[0].code, p_severity: 'CRITICAL', p_job: job, p_correlation_id: o.log.ctx.correlation_id, p_message: why.slice(0, 1800), p_detail: {} });
    await rpcSoft(o, 'cfb_heartbeat', { p_job: job, p_status: 'FAILED', p_correlation_id: o.log.ctx.correlation_id, p_detail: { gate: 'incompatible' } });
    output(env, { proceed: 'false', decisions: 'false', lock: 'none', reason: 'incompatible: ' + why.slice(0, 400) });
    return { code: 2, proceed: false, reason: why };
  }
  let decisions = spec.decisions && comp.decisionProblems.length === 0;
  const degraded = [];
  if (spec.decisions && comp.decisionProblems.length) o.log.critical('gate', 'decisions_disabled', { error_code: 'CALIBRATION', problems: comp.decisionProblems });

  const flag = await flagEnabled(o, args.flag || spec.flag);
  if (flag.unreadable && !o.strict) {
    decisions = false;
    degraded.push('flag ' + flag.code);
    o.log.warn('gate', 'flag_unreadable', { error_code: flag.code, flag: args.flag || spec.flag, note: 'proceeding for capture; decisions off' });
    await rpcSoft(o, 'cfb_record_incident', { p_incident_key: flag.code + ':' + job + ':gate:' + new Date().toISOString().slice(0, 10), p_error_code: flag.code,
      p_severity: 'WARNING', p_job: job, p_correlation_id: o.log.ctx.correlation_id, p_message: 'kill switch unreadable: ' + flag.source, p_detail: {} });
  }
  if (!flag.enabled) {
    await rpcSoft(o, 'cfb_heartbeat', { p_job: job, p_status: 'SKIPPED_DISABLED', p_correlation_id: o.log.ctx.correlation_id, p_detail: { flag: args.flag || spec.flag, source: flag.source } });
    o.log.warn('gate', 'skipped_disabled', { flag: args.flag || spec.flag, source: flag.source });
    output(env, { proceed: 'false', decisions: 'false', lock: 'none', reason: 'kill switch ' + (args.flag || spec.flag) + ' is off (' + flag.source + ')' });
    return { code: 0, proceed: false, reason: 'disabled' };
  }

  let lock = 'none (no database: workflow concurrency group only)';
  if (o.url && o.key) {
    const holder = LOCKS.holderId(env);
    let got = null;
    try {
      got = await LOCKS.client(o).acquire(job, key, holder, Number(args.ttl) || spec.ttl, o.log.ctx.correlation_id);
    } catch (e) {
      const code = T.classify(e);
      if (code === 'DATABASE_SCHEMA' || (e.http && e.http.status === 404)) { got = null; lock = 'none (cfb_production.sql not applied)'; }
      else if (o.strict) {
        o.log.critical('gate', 'lock_error', { error_code: code, message: e.message, strict: true });
        output(env, { proceed: 'false', decisions: 'false', lock: 'error', reason: 'job lock unavailable (strict mode): ' + code });
        return { code: 3, proceed: false, reason: 'lock error ' + code };
      } else {
        /* the database is unreachable: the concurrency group still serialises runs (pg_cron dispatches the same
           workflow), capture and the freeze go on, decisions do not */
        got = null; decisions = false; degraded.push('lock ' + code);
        lock = 'none (unavailable: ' + code + ')';
        o.log.warn('gate', 'lock_unavailable', { error_code: code, message: String(e.message).slice(0, 200), note: 'proceeding under the concurrency group; decisions off' });
        await rpcSoft(o, 'cfb_record_incident', { p_incident_key: code + ':' + job + ':gate:' + new Date().toISOString().slice(0, 10), p_error_code: code,
          p_severity: 'WARNING', p_job: job, p_correlation_id: o.log.ctx.correlation_id, p_message: 'job lock unavailable: ' + String(e.message).slice(0, 300), p_detail: {} });
      }
    }
    if (got && !got.acquired) {
      await rpcSoft(o, 'cfb_heartbeat', { p_job: job, p_status: 'SKIPPED_LOCKED', p_correlation_id: o.log.ctx.correlation_id, p_detail: { holder: got.holder, expires_at: got.expires_at } });
      o.log.info('gate', 'skipped_locked', { error_code: 'PIPELINE_CONFLICT', holder: got.holder, expires_at: got.expires_at });
      output(env, { proceed: 'false', decisions: 'false', lock: 'held by ' + got.holder, reason: 'another run holds ' + job + '/' + key + ' (PIPELINE_CONFLICT)' });
      return { code: 0, proceed: false, reason: 'locked' };
    }
    if (got) {
      lock = 'acquired ' + got.lease_id + (got.took_over_from ? ' (took over an expired lease of ' + got.took_over_from + ')' : '');
      exportEnv(env, { CFB_JOB_LOCK_HOLDER: holder, CFB_JOB_LOCK_LEASE: got.lease_id, CFB_JOB_LOCK_KEY: key });
      if (got.took_over_from) o.log.warn('gate', 'lease_takeover', { took_over_from: got.took_over_from, expired_at: got.expired_at });
    }
    await rpcSoft(o, 'cfb_heartbeat', { p_job: job, p_status: 'STARTED', p_correlation_id: o.log.ctx.correlation_id, p_detail: { lock_key: key, lock } });
  }
  o.log.info('gate', 'proceed', { lock_key: key, lock, decisions, degraded, duration_ms: Date.now() - t0 });
  output(env, { proceed: 'true', decisions: String(decisions), lock, reason: degraded.length ? 'degraded: ' + degraded.join(', ') + ' (decisions off)' : 'ok' });
  return { code: 0, proceed: true, decisions, lock, degraded };
}

async function finish(args, env, io) {
  env = env || process.env; io = io || {};
  const job = args.job;
  const spec = JOBS[job] || { severity: 'WARNING' };
  const o = { url: env.SB_URL, key: env.SB_SERVICE_ROLE, fetch: io.fetch, log: io.log || LOG.logger({ job }, { env, sink: io.sink }) };
  const status = String(args.status || 'unknown').toLowerCase();
  const ok = status === 'success';
  const key = env.CFB_JOB_LOCK_KEY || (!args.key || args.key === 'auto' ? String(seasonFor()) : String(args.key));
  const out = { released: null, heartbeat: null, incident: null };
  if (env.CFB_JOB_LOCK_LEASE) out.released = await rpcSoft(o, 'cfb_job_unlock', { p_job: job, p_key: key, p_lease_id: env.CFB_JOB_LOCK_LEASE });
  /* a run the gate did not let through already sent its SKIPPED_* heartbeat: an OK now would hide that nothing ran */
  const skipped = String(args.proceeded || '') === 'false';
  if (!(skipped && ok)) out.heartbeat = await rpcSoft(o, 'cfb_heartbeat', { p_job: job, p_status: ok ? 'OK' : 'FAILED', p_correlation_id: o.log.ctx.correlation_id, p_detail: { status } });
  if (!ok) {
    out.incident = await rpcSoft(o, 'cfb_record_incident', { p_incident_key: 'JOB_FAILED:' + job + ':' + new Date().toISOString().slice(0, 10),
      p_error_code: 'UNKNOWN', p_severity: spec.severity || 'WARNING', p_job: job, p_correlation_id: o.log.ctx.correlation_id,
      p_message: job + ' finished with status ' + status + ' — see the run log for correlation id ' + o.log.ctx.correlation_id, p_detail: { status } });
  }
  o.log.event(ok ? 'INFO' : (spec.severity || 'WARNING'), 'gate', 'finish', { status, released: out.released, lock_key: key });
  return Object.assign({ code: 0 }, out);
}

module.exports = { start, finish, compatibility, seasonFor, JOBS };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
  const args = { job: arg('job'), key: arg('key', 'auto'), flag: arg('flag', null), ttl: arg('ttl', null), status: arg('status', null), proceeded: arg('proceeded', null) };
  if (!args.job || !/^[a-z][a-z0-9_]{2,63}$/.test(args.job)) { console.error('usage: gate.js start|finish --job <registry job> [...]'); process.exit(64); }
  const fn = a[0] === 'start' ? start : a[0] === 'finish' ? finish : null;
  if (!fn) { console.error('usage: gate.js start|finish --job <registry job> [...]'); process.exit(64); }
  fn(args).then((r) => process.exit(r.code || 0)).catch((e) => {
    console.error('gate ' + a[0] + ': ' + e.message);
    /* finish never masks the job's result; a start that cannot decide does not proceed */
    if (a[0] === 'finish') process.exit(0);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'proceed=false\ndecisions=false\nreason=gate error\n');
    process.exit(3);
  });
}
