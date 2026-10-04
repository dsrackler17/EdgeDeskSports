#!/usr/bin/env node
/* ============================================================================
   THE EDITORIAL RUNTIME CLIENT — settings, heartbeats and leases.

   THREE JOBS, one connection:

     settings()   where the pipeline's configuration actually comes from
     heartbeat()  proof that something invoked the dispatcher
     lease()      one worker at a time on the expensive work

   PRECEDENCE, stated once and enforced here so nothing else has to decide:

     1  the database (public.editorial_settings) — PRODUCTION TRUTH.
        What the admin console writes and what the dispatcher obeys.
     2  the committed defaults (articles/data/editorial/featured.json) —
        BOOTSTRAP AND FALLBACK ONLY. Used before the migration is applied, and
        on a machine with no network so the offline suites still run.
     3  EDGD_* environment variables — DEPLOYMENT OVERRIDE, and only where a
        deployment genuinely needs to differ. Highest precedence because an
        operator setting one has said something more specific than a stored
        default.

   Every resolved value carries WHERE IT CAME FROM, so the health panel shows
   the truth rather than a committed file the runtime is not reading. The
   previous version of this system displayed repository settings while the
   pipeline read something else; that is the bug this ordering exists to
   prevent.

   OFFLINE IS NOT AN ERROR. With no database reachable the resolver falls back
   and says so. The editorial pipeline has always been runnable on a laptop
   with no credentials and that does not change — what changes is that in
   production the database wins.
   ========================================================================== */
'use strict';

const STORE = require('./store.js');

/* The same project and public key every page ships; overridable so a test can
   point at a stub, never so a secret can be supplied. */
const SB_URL = process.env.EDART_SB_URL || process.env.SB_URL
  || 'https://iattxbkbufslbauoumga.supabase.co';
const SB_ANON = process.env.EDART_SB_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
/* WRITES NEED THE SERVICE ROLE, and it is never defaulted — a missing
   credential means "cannot write", never "write as somebody else". */
const SB_SERVICE = process.env.SB_SERVICE_ROLE || process.env.EDGD_SB_SERVICE || null;

/* The settings the database owns, and the env var that may override each. */
const FIELDS = {
  editorial_enabled: { type: 'boolean', env: 'EDGD_EDITORIAL_ENABLED' },
  dispatcher_enabled: { type: 'boolean', env: 'EDGD_DISPATCHER_ENABLED' },
  auto_publish_pregame: { type: 'boolean', env: 'EDGD_AUTO_PUBLISH_PREGAME' },
  auto_publish_postgame: { type: 'boolean', env: 'EDGD_AUTO_PUBLISH_POSTGAME' },
  retry_enabled: { type: 'boolean', env: 'EDGD_RETRY_ENABLED' },
  pregame_normal_lead_minutes: { type: 'integer', env: 'EDGD_PREGAME_NORMAL_LEAD' },
  pregame_minimum_publish_lead_minutes: { type: 'integer', env: 'EDGD_PREGAME_MIN_LEAD' },
  postgame_settle_minutes: { type: 'integer', env: 'EDGD_POSTGAME_SETTLE' },
  quality_floor: { type: 'integer', env: 'EDGD_QUALITY_FLOOR' },
};

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].indexOf(s) >= 0) return true;
  if (['false', '0', 'no', 'off'].indexOf(s) >= 0) return false;
  return null;
}
function asInt(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function coerce(type, v) { return type === 'boolean' ? asBool(v) : asInt(v); }

/* ------------------------------------------------------------- the client */
function client(opts) {
  opts = opts || {};
  const url = opts.url || SB_URL;
  const anon = opts.anon || SB_ANON;
  const service = opts.service !== undefined ? opts.service : SB_SERVICE;
  const f = opts.fetch || ((...a) => fetch(...a));
  const enabled = opts.enabled !== false && !!url;

  function headers(useService, extra) {
    const key = useService && service ? service : anon;
    return Object.assign({ apikey: key, authorization: 'Bearer ' + key }, extra || {});
  }
  async function call(path, init, useService) {
    const res = await f(url + '/rest/v1/' + path, Object.assign({}, init, {
      headers: headers(useService, Object.assign({ 'content-type': 'application/json' },
        (init && init.headers) || {})),
    }));
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(path + ' -> ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }
  async function rpc(name, body) {
    if (!service) throw new Error('no service credential: ' + name + ' is a server-side call');
    const res = await f(url + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: headers(true, { 'content-type': 'application/json' }),
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error('rpc ' + name + ' -> ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    enabled, hasService: !!service, url,

    /* ---------------------------------------------------------- settings */
    async readSettings() {
      if (!enabled) return null;
      const rows = await call('editorial_settings?select=*&id=eq.1', { method: 'GET' }, false);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    /* -------------------------------------------------------- heartbeats */
    async heartbeatStart(source, detail) {
      if (!enabled || !service) return null;
      const rows = await call('editorial_heartbeats', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify([{ scheduler_source: source, detail: detail || null }]),
      }, true);
      return Array.isArray(rows) && rows.length ? rows[0].id : null;
    },
    async heartbeatFinish(id, out) {
      if (!enabled || !service || id == null) return false;
      out = out || {};
      await call('editorial_heartbeats?id=eq.' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({
          completed_at: new Date().toISOString(),
          duration_ms: out.duration_ms == null ? null : Math.round(out.duration_ms),
          ok: out.ok !== false,
          actions_considered: out.considered || 0,
          actions_executed: out.executed || 0,
          error: out.error ? String(out.error).slice(0, 500) : null,
        }),
      }, true);
      return true;
    },
    async recentHeartbeats(limit) {
      if (!enabled) return [];
      return await call('editorial_heartbeats?select=*&order=started_at.desc&limit='
        + (limit || 40), { method: 'GET' }, false) || [];
    },

    /* ------------------------------------------------------------ leases */
    async claim(key, owner, ttlSeconds, meta) {
      return !!(await rpc('editorial_claim', {
        p_key: key, p_owner: owner,
        p_ttl_seconds: ttlSeconds || 600, p_meta: meta || null,
      }));
    },
    async release(key, owner) {
      return !!(await rpc('editorial_release', { p_key: key, p_owner: owner }));
    },
  };
}

/* ------------------------------------------------------- the resolver */
/* Returns the settings the pipeline should obey, plus a `sources` map saying
   where each value came from. Never throws: a database that cannot be reached
   degrades to the committed defaults and says so. */
async function resolve(opts) {
  opts = opts || {};
  const c = opts.client || client(opts);
  const local = opts.local || STORE.settings();
  const sources = {};
  const notes = [];
  let row = null, reachable = false;

  if (opts.offline) {
    notes.push('offline: the committed defaults are in force');
  } else {
    try {
      row = await c.readSettings();
      reachable = true;
      if (!row) notes.push('the settings table is reachable but holds no row; the committed defaults are in force');
    } catch (e) {
      notes.push('editorial_settings not read (' + (e && e.message ? String(e.message).slice(0, 120) : e)
        + '); the committed defaults are in force');
    }
  }

  const out = Object.assign({}, local);
  Object.keys(FIELDS).forEach(k => {
    const spec = FIELDS[k];
    let value = null, from = null;

    /* 2 — committed default */
    const localValue = coerce(spec.type, local[k]);
    if (localValue !== null) { value = localValue; from = 'repository'; }

    /* 1 — the database wins over it */
    if (row && row[k] !== undefined && row[k] !== null) {
      const dbValue = coerce(spec.type, row[k]);
      if (dbValue !== null) { value = dbValue; from = 'database'; }
    }

    /* 3 — an explicit deployment override wins over both */
    const envRaw = spec.env ? process.env[spec.env] : undefined;
    if (envRaw !== undefined && envRaw !== '') {
      const envValue = coerce(spec.type, envRaw);
      if (envValue !== null) { value = envValue; from = 'environment (' + spec.env + ')'; }
      else notes.push(spec.env + '=' + envRaw + ' is not a valid ' + spec.type + ' and was ignored');
    }

    if (value !== null) { out[k] = value; sources[k] = from; }
    else sources[k] = 'default';
  });

  /* The legacy key stays readable so windows.js keeps its backward-compatible
     path, but it never wins over an explicit new value. */
  return { settings: out, sources, reachable, row, notes,
    has_service: c.hasService, url: c.url };
}

module.exports = { FIELDS, SB_URL, client, resolve, asBool, asInt, coerce };
