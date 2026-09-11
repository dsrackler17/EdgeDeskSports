#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — the database door the GitHub jobs write through.

   PostgREST with the service role, nothing else: no Edge Function in the
   path, no token lifted from a browser. The credential is the repository
   secret the other jobs already hold (SB_SERVICE_ROLE / SB_URL, passed in as
   EDGD_SB_SERVICE / EDGD_SB_URL), with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
   accepted as the same thing under the names Supabase's own docs use.

   Every writer here is idempotent by construction: upsert on the table's own
   key, insert-ignore on a content hash. Running a job twice writes the same
   rows twice, which is the point.

   Schema is a parameter on every call because the jobs read `public.signals`
   and write into a sport's own schema, and PostgREST addresses a schema
   through the Accept-Profile / Content-Profile headers.

   WHY THIS LIVES IN tools/lib. tools/ufc/db.js is the same client, written
   first for the UFC pipeline. This is the shared home for it; the UFC copy is
   deliberately left alone for now because its transport is exercised only in
   production (its own suites substitute a fake database), so moving a live
   pipeline onto new transport belongs in its own change with its own
   verification rather than riding along with tennis.
   =========================================================================== */
'use strict';

const DEFAULT_URL = 'https://iattxbkbufslbauoumga.supabase.co';

function config(env) {
  env = env || process.env;
  const key = String(env.EDGD_SB_SERVICE || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const url = String(env.EDGD_SB_URL || env.SUPABASE_URL || env.EDGEDESK_SUPABASE_URL || DEFAULT_URL).trim().replace(/\/$/, '');
  if (!key) return null;
  return { url, key };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* A client over fetch. fetchImpl is injectable so the jobs can be driven end
   to end with no network. */
function client(cfg, fetchImpl, opts) {
  opts = opts || {};
  const f = fetchImpl || ((...a) => fetch(...a));
  const retries = opts.retries != null ? opts.retries : 3;
  const timeoutMs = opts.timeoutMs || 20000;
  const stats = { requests: 0, failures: 0, writes: 0, lastLatencyMs: null };

  function headers(schema, extra) {
    return Object.assign({ apikey: cfg.key, authorization: `Bearer ${cfg.key}`,
      'accept-profile': schema, 'content-profile': schema }, extra || {});
  }
  async function call(method, schema, path, body, extra, what) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      const t0 = Date.now();
      stats.requests++;
      try {
        const res = await f(`${cfg.url}/rest/v1/${path}`, {
          method, headers: headers(schema, Object.assign({ 'content-type': 'application/json' }, extra || {})),
          body: body == null ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined
        });
        stats.lastLatencyMs = Date.now() - t0;
        const text = await res.text();
        if (res.ok) {
          if (method !== 'GET') stats.writes++;
          return text ? JSON.parse(text) : [];
        }
        const err = new Error(`${what || method + ' ' + path} -> ${res.status}: ${String(text).slice(0, 400)}`);
        err.status = res.status;
        /* a 4xx is a fact about the request, not the network: no retry */
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) { stats.failures++; throw err; }
        lastErr = err;
      } catch (e) {
        lastErr = e;
        if (e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      } finally { if (timer) clearTimeout(timer); }
      stats.failures++;
      if (attempt < retries) await sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
    }
    throw lastErr;
  }

  return {
    stats,
    cfg,
    async select(schema, rel, query) {
      return call('GET', schema, `${rel}?${query}`, null, null, `GET ${schema}.${rel}`);
    },
    async selectAll(schema, rel, query, pageSize, maxPages) {
      pageSize = pageSize || 1000; maxPages = maxPages || 60;
      const out = [];
      for (let p = 0; p < maxPages; p++) {
        const rows = await call('GET', schema, `${rel}?${query}&limit=${pageSize}&offset=${p * pageSize}`, null, null, `GET ${schema}.${rel}`);
        if (!rows || !rows.length) break;
        out.push(...rows);
        if (rows.length < pageSize) break;
      }
      return out;
    },
    async upsert(schema, rel, rows, onConflict, o) {
      o = o || {};
      if (!rows || !rows.length) return [];
      const out = [];
      const size = o.chunk || 400;
      /* PostgREST requires every object in one bulk write to carry the SAME
         keys, and answers a mixed array with PGRST102 "All object keys must
         match". Callers legitimately build rows of different shapes — a
         finished match carries a winner and a scheduled one does not — so the
         batch is split by shape rather than padded.

         Padding would be the wrong fix: an omitted key is often deliberate.
         sync_events drops `status` from a row precisely so a merge cannot
         reopen a finished match, and writing null there would both wipe the
         status and violate its not-null constraint. Omission has to survive. */
      for (const group of byKeyShape(rows)) {
        for (let i = 0; i < group.length; i += size) {
          const q = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
          const prefer = (o.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates') + ',' + (o.returning === false ? 'return=minimal' : 'return=representation');
          const r = await call('POST', schema, `${rel}${q}`, group.slice(i, i + size), { prefer }, `UPSERT ${schema}.${rel}`);
          if (Array.isArray(r)) out.push(...r);
        }
      }
      return out;
    },
    async insert(schema, rel, rows, o) {
      o = o || {};
      if (!rows || !rows.length) return [];
      return call('POST', schema, rel, rows, { prefer: o.returning === false ? 'return=minimal' : 'return=representation' }, `INSERT ${schema}.${rel}`);
    },
    async patch(schema, rel, query, patch) {
      return call('PATCH', schema, `${rel}?${query}`, patch, { prefer: 'return=representation' }, `PATCH ${schema}.${rel}`);
    },
    async del(schema, rel, query) {
      return call('DELETE', schema, `${rel}?${query}`, null, { prefer: 'return=minimal' }, `DELETE ${schema}.${rel}`);
    },
    async rpc(schema, fn, args) {
      return call('POST', schema, `rpc/${fn}`, args || {}, null, `RPC ${schema}.${fn}`);
    }
  };
}

/* PostgREST `in.(...)` lists: every value quoted, so a name with a comma or a
   space cannot split the list. */
function inList(values) {
  return '(' + (values || []).map(v => '"' + String(v).replace(/"/g, '') + '"').join(',') + ')';
}

/* ---- the run ledger ------------------------------------------------------
   One row per job run in <schema>.pipeline_runs, heartbeated while it lives.
   The UI's health read derives from these stamps; an unheartbeated run is a
   dead one, whatever its status column says. */
function runLedger(db, schema, job, o) {
  o = o || {};
  const env = o.env || process.env;
  const ghId = env.GITHUB_RUN_ID || null;
  const runId = o.runId || `${job}:${ghId || 'local'}:${env.GITHUB_RUN_ATTEMPT || '1'}:${Date.now()}`;
  const base = {
    run_id: runId, job, scope: o.scope || null, status: 'running',
    github_run_id: ghId, workflow: env.GITHUB_WORKFLOW || null,
    github_run_url: (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && ghId) ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${ghId}` : null
  };
  let started = false;
  return {
    runId,
    async start(details) {
      try { await db.upsert(schema, 'pipeline_runs', [Object.assign({}, base, { details: details || {} })], 'run_id', { returning: false }); started = true; }
      catch (e) { console.error(`[${job}] could not open the run ledger: ${e.message}`); }
      return runId;
    },
    async beat(patch) {
      if (!started) return;
      try { await db.patch(schema, 'pipeline_runs', `run_id=eq.${encodeURIComponent(runId)}`, Object.assign({ heartbeat_at: new Date().toISOString() }, patch || {})); }
      catch (e) { console.error(`[${job}] heartbeat failed: ${e.message}`); }
    },
    async finish(status, message, patch) {
      if (!started) return;
      try { await db.patch(schema, 'pipeline_runs', `run_id=eq.${encodeURIComponent(runId)}`,
        Object.assign({ status, message: message || null, finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() }, patch || {})); }
      catch (e) { console.error(`[${job}] could not close the run ledger: ${e.message}`); }
    }
  };
}

/* The shell's pipeline ledger reads <schema>.meta rows shaped {job}_last_run /
   {job}_last_status. Best effort: a schema's meta table predates these
   contracts and its grants may not include the service role, which is a
   warning and never a reason to fail a run that has already written its work. */
async function writeMeta(db, schema, entries) {
  try {
    const rows = Object.keys(entries).map(k => ({ key: k, value: entries[k] == null ? null : String(entries[k]) }));
    await db.upsert(schema, 'meta', rows, 'key', { returning: false });
    return true;
  } catch (e) {
    console.error(`[meta] could not write ${schema}.meta: ${e.message}`);
    return false;
  }
}

/* WHEN THE CONTRACT IS NOT INSTALLED.

   PostgREST answers a missing table with a schema-cache error, and a missing
   schema with a different one. Both mean the same thing to an operator —
   the migration has not been run — and neither says so. The UFC pipeline
   already paid for this once: a production run stopped on "permission denied
   for table meta" and the log said nothing about which file to run.

   This distinguishes "the contract is not there" from "the read failed", so a
   job can name the one file that fixes it instead of printing a symptom. */
var NOT_INSTALLED = /PGRST205|PGRST106|PGRST202|42P01|3F000|schema cache|could not find the (table|relation)|does not exist|unknown schema/i;

function notInstalled(err) {
  if (!err) return false;
  var s = String(err.message || err);
  return NOT_INSTALLED.test(s);
}

/* One line an operator can act on, or null when this is not that failure. */
function contractHint(err, sqlFile) {
  if (!notInstalled(err)) return null;
  return 'the ' + sqlFile + ' contract is not installed in this database — run supabase/' + sqlFile +
         ' once in the Supabase SQL editor and check that every row of its report reads ok';
}

/* Rows grouped so that every row in a group carries exactly the same keys.
   Insertion order is preserved within a group, and the groups come back in the
   order their shapes were first seen, so a write stays deterministic. */
function byKeyShape(rows) {
  const groups = new Map();
  (rows || []).forEach(function (r) {
    const sig = Object.keys(r).sort().join('\u0000');
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  });
  return Array.from(groups.values());
}

module.exports = {
  notInstalled, contractHint, byKeyShape, config, client, inList, runLedger, writeMeta, sleep, DEFAULT_URL };
