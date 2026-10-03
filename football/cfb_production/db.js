/* ============================================================================
   CFB production — the one way a CFB job talks to Postgres over PostgREST
   (docs/cfb-production/OPERATIONS.md §1-2, the transaction audit).

   Every CFB mirror (football/{cfb_lab,cfb_v2,cfb_weekly,cfb_personnel,
   cfb_decision}/sync_supabase.js) writes through postRows(): chunked
   insert-only POSTs (`resolution=ignore-duplicates`), each chunk ONE short
   transaction on the server (PostgREST wraps a request in a transaction and
   rolls it back on any error, so a failed chunk leaves nothing behind).

   RETRY ONLY WHAT IS TRANSIENT (taxonomy.js):
     DATABASE_DEADLOCK    40P01 / 40001   5 attempts
     DATABASE_TIMEOUT     55P03 / 57014   3 attempts
     DATABASE_UNAVAILABLE 08 / 53 / 57P0x 8 attempts (about 1.5-3 min: PostgREST answers
                          503 PGRST002 until Postgres is back, and a few seconds
                          did not outlast it — 2026-10-03 20:24 UTC, the hourly
                          Model Lab mirror failed ~50 s before the database returned)
     PROVIDER_TRANSIENT   5xx without a SQLSTATE, 408, network, timeout
     PROVIDER_RATE_LIMIT  429 (Retry-After honoured, capped)
   Anything else — AUTH, a schema error, a constraint refusal, a permanent
   4xx, and a 500 whose body names a non-transient SQLSTATE — is raised at
   once. The old mirrors retried every 500; PostgREST answers 40P01, 55P03,
   57014, 25P02 and P0-class errors all with 500, so the body decides.

   BOUNDED JITTER: attempt n waits d/2 + U(0, d/2) with d = min(cap, base·2^(n-1))
   — never zero (the deadlock partner needs time to finish) and never more
   than the cap. Two jobs that deadlocked do not retry in lock-step.

   INCIDENTS: every deadlock or lock timeout is reported to onIncident (one
   structured event; the sink dedupes by incident key), and a retry budget
   that runs out is reported again as CRITICAL before the error is raised as
   a CfbError carrying its code — the caller's stage is then FAILED, never
   half-written (the chunk that failed was rolled back; the ones before it are
   write-once and idempotent, so the next run completes the mirror).
   ========================================================================== */
'use strict';
const T = require('./taxonomy.js');

const DEFAULTS = {
  chunk: 500,
  timeoutMs: 60000,
  base: { DATABASE_DEADLOCK: 200, DATABASE_TIMEOUT: 500, DATABASE_UNAVAILABLE: 2000, PROVIDER_TRANSIENT: 1000, PROVIDER_RATE_LIMIT: 2000 },
  cap: { DATABASE_DEADLOCK: 4000, DATABASE_TIMEOUT: 8000, DATABASE_UNAVAILABLE: 60000, PROVIDER_TRANSIENT: 15000, PROVIDER_RATE_LIMIT: 60000 },
};
const INCIDENT_CODES = new Set(['DATABASE_DEADLOCK', 'DATABASE_TIMEOUT']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* the wait before attempt `attempt + 1` (attempt counts from 1) */
function backoff(code, attempt, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const base = (opts.base && opts.base[code]) || DEFAULTS.base[code] || 1000;
  const cap = (opts.cap && opts.cap[code]) || DEFAULTS.cap[code] || 15000;
  const d = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  let wait = d / 2 + rng() * (d / 2);
  if (code === 'PROVIDER_RATE_LIMIT' && Number.isFinite(opts.retryAfterMs)) wait = Math.min(cap, Math.max(wait, opts.retryAfterMs));
  return Math.round(Math.min(cap, wait));
}

/* withRetry(fn, opts): fn(attempt) -> value; throws a CfbError when the budget is spent or the error is permanent.
   opts: { label, log, sleep, rng, attempts: {CODE: n}, onIncident(evt), base, cap } */
async function withRetry(fn, opts) {
  opts = opts || {};
  const wait = opts.sleep || sleep;
  const log = opts.log || null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      const code = T.classify(e);
      const budget = (opts.attempts && opts.attempts[code]) || T.attempts(code);
      const detail = { label: opts.label || null, error_code: code, runlog_class: T.runlogClass(code), attempt, budget,
        message: String((e && e.message) || e).slice(0, 400), http_status: e && e.http ? e.http.status : null, sqlstate: e && e.http ? e.http.code : (e && e.code) || null };
      if (INCIDENT_CODES.has(code) && opts.onIncident) await safe(() => opts.onIncident(Object.assign({ severity: 'WARNING', exhausted: false }, detail)));
      if (attempt >= budget) {
        if (T.retryable(code)) {
          if (opts.onIncident) await safe(() => opts.onIncident(Object.assign({}, detail, { severity: 'CRITICAL', exhausted: true })));
          if (log) log.critical(opts.label, 'retries_exhausted', detail);
        } else if (log) log.event(T.info(code).severity, opts.label, 'permanent_error', detail);
        if (e instanceof T.CfbError && e.cfb_code === code) { e.attempts = attempt; throw e; }
        throw new T.CfbError((opts.label ? opts.label + ': ' : '') + detail.message, code, { attempts: attempt, cause: e, http: e && e.http });
      }
      const ms = backoff(code, attempt, { rng: opts.rng, base: opts.base, cap: opts.cap, retryAfterMs: e && e.retryAfterMs });
      if (log) log.warn(opts.label, 'retry', Object.assign({}, detail, { wait_ms: ms }));
      await wait(ms);
    }
  }
}
async function safe(fn) { try { await fn(); } catch (_) { /* reporting must never mask the error being reported */ } }

/* one HTTP call with a hard timeout; a non-2xx answer becomes an Error carrying { status, code, message } */
async function request(url, init, opts) {
  opts = opts || {};
  const f = opts.fetch || globalThis.fetch;
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), opts.timeoutMs || DEFAULTS.timeoutMs) : null;
  let res;
  try {
    res = await f(url, Object.assign({}, init, ac ? { signal: ac.signal } : {}));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  const code = T.classify({ status: res.status, body });
  const e = new T.CfbError('HTTP ' + res.status + ' ' + String(text).slice(0, 300), code, {
    http: { status: res.status, code: body && typeof body === 'object' ? body.code || null : null, message: body && typeof body === 'object' ? body.message || null : null } });
  const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (ra && /^\d+$/.test(String(ra).trim())) e.retryAfterMs = Number(ra) * 1000;
  throw e;
}

function headers(key, extra) {
  return Object.assign({ apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' }, extra || {});
}

/* PostgREST refuses a bulk body whose objects do not all carry the same keys
   (PGRST102 "All object keys must match"). A ledger row legitimately omits a
   key it has no value for (the column then takes its default), so a chunk is
   split into runs of identical key sets, first appearance first — each row is
   inserted exactly as it would be alone. (This failure stopped the hourly Model
   Lab mirror on 2026-09-27: cfb_lab_evaluations rows with and without
   tie_vs_open / tie_vs_close.) */
function keyGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    const sig = Object.keys(r).sort().join('\u0001');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  }
  return Array.from(groups.values());
}

/* Insert-only mirror: chunked POSTs, ignore-duplicates, classified bounded retry per chunk. Returns rows sent. */
async function postRows(url, key, table, onConflict, rows, opts) {
  opts = opts || {};
  const size = opts.chunk || DEFAULTS.chunk;
  let sent = 0;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    for (const chunk of keyGroups(slice)) {
      await withRetry(() => request(url + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
        method: 'POST', headers: headers(key, { prefer: 'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(chunk) }, opts),
      Object.assign({ label: table + ' rows ' + i + '-' + (i + slice.length - 1) }, opts));
      sent += chunk.length;
    }
  }
  return sent;
}

/* A PostgREST RPC (POST /rest/v1/rpc/<fn>). Retries only transient failures. */
async function rpc(url, key, fn, args, opts) {
  opts = opts || {};
  const res = await withRetry(() => request(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers(key), body: JSON.stringify(args || {}) }, opts),
    Object.assign({ label: 'rpc ' + fn }, opts));
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text; }
}

/* The incident sink every job shares: a structured log line always; a line in
   $CFB_OPS_EVENTS_FILE when set; and, best effort, cfb_record_incident() in
   Postgres (supabase/cfb_production.sql) — one attempt, short timeout, never
   retried and never allowed to mask the error it reports. */
function incidentSink(o) {
  o = o || {};
  const fs = require('fs');
  return async function (evt) {
    const job = o.job || (o.log && o.log.ctx.job) || 'cfb';
    const day = new Date().toISOString().slice(0, 10);
    const key = [evt.error_code, job, String(evt.label || '').split(' ')[0] || '-', day].join(':');
    const rec = Object.assign({ incident_key: key }, evt);
    if (o.log) o.log.event(evt.severity || 'WARNING', evt.label, evt.exhausted ? 'incident_retries_exhausted' : 'incident', rec);
    const file = o.file || process.env.CFB_OPS_EVENTS_FILE;
    if (file) { try { fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: new Date().toISOString(), kind: 'incident', job, correlation_id: o.log ? o.log.ctx.correlation_id : null }, rec)) + '\n'); } catch (_) { /* best effort */ } }
    if (o.url && o.key) {
      try {
        await request(o.url + '/rest/v1/rpc/cfb_record_incident', { method: 'POST', headers: headers(o.key), body: JSON.stringify({
          p_incident_key: key, p_error_code: evt.error_code, p_severity: evt.severity || 'WARNING', p_job: job,
          p_correlation_id: o.log ? o.log.ctx.correlation_id : null, p_message: String(evt.message || '').slice(0, 500),
          p_detail: { attempt: evt.attempt, budget: evt.budget, exhausted: !!evt.exhausted, label: evt.label, sqlstate: evt.sqlstate } }) }, { timeoutMs: 5000, fetch: o.fetch });
      } catch (_) { /* the migration may not be applied yet; the log line above is the record */ }
    }
    return rec;
  };
}

module.exports = { withRetry, backoff, request, postRows, keyGroups, rpc, headers, incidentSink, DEFAULTS, sleep };
