/* ============================================================================
   CFB production — job locks (docs/cfb-production/JOBS.md §3).

   cfb_job_lock(job, key, holder, ttl) in supabase/cfb_production.sql is a
   LEASE behind a Postgres advisory lock: the advisory lock (two-int key space)
   serialises every acquire / renew / release of one (job, key) inside one short
   transaction, and the lease row carries the lock across the many PostgREST
   requests a job makes (a session advisory lock cannot: PostgREST hands each
   request a pooled connection, and a session lock left on one would leak to a
   stranger's request).

     acquired          proceed; hold lease_id
     held by another   exit cleanly (PIPELINE_CONFLICT, INFO) — never overlap
     expired lease     taken over (the previous holder crashed or overran its
                       ttl); the takeover is logged WARNING
   The lease is fenced: renew and release need the lease_id, so a holder that
   lost its lease can neither extend nor release someone else's.

   withGameLocks() takes per-game locks in SORTED game-id order (two
   multi-game jobs never wait on each other in opposite orders), skips games
   another job is refreshing, and releases everything in `finally`.
   ========================================================================== */
'use strict';
const os = require('os');
const DB = require('./db.js');
const T = require('./taxonomy.js');

function holderId(env) {
  env = env || process.env;
  if (env.CFB_JOB_LOCK_HOLDER) return env.CFB_JOB_LOCK_HOLDER;
  const gh = env.GITHUB_RUN_ID ? 'gh-' + (env.GITHUB_WORKFLOW || 'wf').replace(/[^A-Za-z0-9_.-]+/g, '_') + '-' + env.GITHUB_RUN_ID + '-' + (env.GITHUB_RUN_ATTEMPT || '1') : null;
  return gh || ('local-' + os.hostname().replace(/[^A-Za-z0-9_.-]+/g, '_') + '-' + process.pid);
}

/* the RPC surface, with an injectable transport for tests */
function client(o) {
  const call = o.rpc || ((fn, args) => DB.rpc(o.url, o.key, fn, args, { log: o.log, fetch: o.fetch }));
  return {
    acquire: (job, key, holder, ttl, corr) => call('cfb_job_lock', { p_job: job, p_key: String(key), p_holder: holder, p_ttl_seconds: ttl || 900, p_correlation_id: corr || null }),
    renew: (job, key, lease, ttl) => call('cfb_job_lock_renew', { p_job: job, p_key: String(key), p_lease_id: lease, p_ttl_seconds: ttl || 900 }),
    release: (job, key, lease) => call('cfb_job_unlock', { p_job: job, p_key: String(key), p_lease_id: lease }),
  };
}

/* Run fn under the (job, key) lease. Returns { ran, result?, skipped?, holder? }.
   A missing migration (DATABASE_SCHEMA) is reported and, unless required, the
   job proceeds under its workflow concurrency group alone (the pre-lock state);
   any other lock failure fails closed: nothing is written. */
async function withJobLock(o, fn) {
  const c = client(o);
  const holder = o.holder || holderId();
  let got;
  try {
    got = await c.acquire(o.job, o.lockKey, holder, o.ttl, o.log ? o.log.ctx.correlation_id : null);
  } catch (e) {
    const code = T.classify(e);
    /* PostgREST answers a function it does not know with 404 (PGRST202, or 42883 on older servers) */
    const missing = code === 'DATABASE_SCHEMA' || (e && e.http && e.http.status === 404);
    if (missing && !o.required) {
      if (o.log) o.log.warn('lock', 'lock_unavailable', { error_code: code, job: o.job, lock_key: String(o.lockKey), note: 'supabase/cfb_production.sql not applied: running under the workflow concurrency group only' });
      return { ran: true, result: await fn(null), locked: false };
    }
    throw e instanceof T.CfbError ? e : new T.CfbError('job lock ' + o.job + '/' + o.lockKey + ': ' + e.message, code);
  }
  if (!got || !got.acquired) {
    if (o.log) o.log.info('lock', 'skipped_locked', { error_code: 'PIPELINE_CONFLICT', job: o.job, lock_key: String(o.lockKey), holder: got && got.holder, expires_at: got && got.expires_at });
    return { ran: false, skipped: 'PIPELINE_CONFLICT', holder: got && got.holder, expires_at: got && got.expires_at };
  }
  if (got.took_over_from && o.log) o.log.warn('lock', 'lease_takeover', { job: o.job, lock_key: String(o.lockKey), took_over_from: got.took_over_from, expired_at: got.expired_at });
  try {
    return { ran: true, result: await fn(got), locked: true, lease_id: got.lease_id };
  } finally {
    /* a re-entered lease belongs to the outer holder (the gate); only a lease taken here is released here */
    if (!got.reentrant) {
      try { await c.release(o.job, o.lockKey, got.lease_id); } catch (e) { if (o.log) o.log.warn('lock', 'release_failed', { job: o.job, lock_key: String(o.lockKey), message: e.message }); }
    }
  }
}

/* Per-game locks in deterministic (sorted) order. fn(lockedGameIds) runs once
   with the games this job holds; games held elsewhere are returned as skipped. */
async function withGameLocks(o, gameIds, fn) {
  const c = client(o);
  const holder = o.holder || holderId();
  const ids = Array.from(new Set(gameIds.map(String))).sort();
  const held = [], skipped = [];
  try {
    for (const g of ids) {
      const r = await c.acquire(o.job || 'cfb_game_refresh', g, holder, o.ttl || 600, o.log ? o.log.ctx.correlation_id : null);
      if (r && r.acquired) held.push({ game_id: g, lease_id: r.lease_id, reentrant: !!r.reentrant });
      else skipped.push({ game_id: g, holder: r && r.holder });
    }
    if (skipped.length && o.log) o.log.info('lock', 'games_skipped_locked', { error_code: 'PIPELINE_CONFLICT', games: skipped.map((s) => s.game_id) });
    const result = held.length ? await fn(held.map((h) => h.game_id)) : null;
    return { held: held.map((h) => h.game_id), skipped, result };
  } finally {
    for (const h of held.slice().reverse()) {
      if (h.reentrant) continue;
      try { await c.release(o.job || 'cfb_game_refresh', h.game_id, h.lease_id); } catch (_) { /* expires by ttl */ }
    }
  }
}

module.exports = { withJobLock, withGameLocks, holderId, client };
