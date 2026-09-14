#!/usr/bin/env node
/* ============================================================================
   THE NEWSLETTER RUNTIME CLIENT — settings, editions, recipients, deliveries.

   THE SAME PRECEDENCE tools/editorial/runtime.js states and enforces, because
   two runtimes with two different ideas of where configuration comes from is
   how an operator ends up looking at a switch that controls nothing:

     1  the database (public.newsletter_settings) — PRODUCTION TRUTH.
     2  the committed defaults (articles/data/newsletter/settings.json) —
        bootstrap and offline fallback.
     3  EDGD_NL_* environment variables — deployment override, highest, because
        an operator setting one has said something more specific.

   Every resolved value carries where it came from, so the operator console
   shows what the pipeline is actually reading rather than a committed file it
   may not be.

   WRITES NEED THE SERVICE ROLE and it is never defaulted. A missing
   credential means "cannot write", never "write as somebody else": with no
   service key the pipeline still builds, validates, renders and stores an
   edition in the repository, and refuses to send.
   ========================================================================== */
'use strict';

const STORE = require('./store.js');

const SB_URL = process.env.EDGD_NL_SB_URL || process.env.EDART_SB_URL || process.env.SB_URL
  || 'https://iattxbkbufslbauoumga.supabase.co';
const SB_ANON = process.env.EDGD_NL_SB_KEY || process.env.EDART_SB_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
const SB_SERVICE = process.env.SB_SERVICE_ROLE || process.env.EDGD_SB_SERVICE
  || process.env.SUPABASE_SERVICE_ROLE_KEY || null;

/* Which stored setting each environment variable overrides. Only the ones a
   deployment genuinely needs to differ on. */
const ENV_FIELDS = {
  sending_enabled: { type: 'boolean', env: 'EDGD_NL_SENDING_ENABLED' },
  cfb_enabled: { type: 'boolean', env: 'EDGD_NL_CFB_ENABLED' },
  nfl_enabled: { type: 'boolean', env: 'EDGD_NL_NFL_ENABLED' },
  dispatcher_enabled: { type: 'boolean', env: 'EDGD_NL_DISPATCHER_ENABLED' },
  from_email: { type: 'text', env: 'EDGD_NL_FROM_EMAIL' },
  from_name: { type: 'text', env: 'EDGD_NL_FROM_NAME' },
  reply_to_email: { type: 'text', env: 'EDGD_NL_REPLY_TO' },
  mailing_address: { type: 'text', env: 'EDGD_NL_MAILING_ADDRESS' },
  site_url: { type: 'text', env: 'EDGD_NL_SITE_URL' },
  retry_window_minutes: { type: 'integer', env: 'EDGD_NL_RETRY_WINDOW' },
  target_games: { type: 'integer', env: 'EDGD_NL_TARGET_GAMES' },
  max_games: { type: 'integer', env: 'EDGD_NL_MAX_GAMES' },
  batch_size: { type: 'integer', env: 'EDGD_NL_BATCH_SIZE' },
};

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].indexOf(s) >= 0) return true;
  if (['false', '0', 'no', 'off'].indexOf(s) >= 0) return false;
  return null;
}
function asInt(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
function coerce(type, v) { return type === 'boolean' ? asBool(v) : type === 'integer' ? asInt(v) : (v == null || v === '' ? null : String(v)); }

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
      headers: headers(useService, Object.assign({ 'content-type': 'application/json' }, (init && init.headers) || {})),
    }));
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(path + ' -> ' + res.status + (text ? ': ' + text.slice(0, 300) : ''));
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }
  async function rpc(name, body) {
    if (!service) throw new Error('no service credential: ' + name + ' is a server-side call');
    const res = await f(url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers(true, { 'content-type': 'application/json' }),
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error('rpc ' + name + ' -> ' + res.status + (text ? ': ' + text.slice(0, 300) : ''));
      e.status = res.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    enabled, hasService: !!service, url,

    async readSettings() {
      if (!enabled || !service) return null;
      const rows = await call('newsletter_settings?select=*&id=eq.1', { method: 'GET' }, true);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    /* ---------------------------------------------------------- editions */
    async findEdition(key) {
      if (!enabled || !service) return null;
      const rows = await call('newsletter_editions?select=*&edition_key=eq.' + encodeURIComponent(key), { method: 'GET' }, true);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },
    /* UPSERT ON THE IDENTITY, which is the unique index the schema owns. Two
       dispatchers racing here produce one row, not an error and not two. */
    async upsertEdition(row) {
      if (!enabled || !service) return null;
      const rows = await call('newsletter_editions?on_conflict=sport,season,slate_week,edition_date', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([row]),
      }, true);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },
    async patchEdition(key, patch) {
      if (!enabled || !service) return null;
      const rows = await call('newsletter_editions?edition_key=eq.' + encodeURIComponent(key), {
        method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify(patch),
      }, true);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },
    async claimEdition(key, owner, ttlSeconds) {
      return rpc('newsletter_claim_edition', { p_edition_key: key, p_owner: owner, p_ttl_seconds: ttlSeconds || 1800 });
    },
    async releaseEdition(key, owner) {
      return rpc('newsletter_release_edition', { p_edition_key: key, p_owner: owner });
    },

    /* -------------------------------------------------------- recipients */
    /* ELIGIBILITY IS RECOMPUTED, NEVER CACHED. The brief asks for a recheck
       immediately before sending and this is it: the function joins
       suppressions live, so an address that bounced a minute ago is already
       gone from the list this returns. */
    async eligible(sport) {
      return rpc('newsletter_eligible', { p_sport: String(sport).toUpperCase() });
    },
    async eligibleCount(sport) {
      return rpc('newsletter_eligible_count', { p_sport: String(sport).toUpperCase() });
    },

    /* -------------------------------------------------------- deliveries */
    /* Insert the roster ONCE per edition, ignoring anything already there.
       The unique index on (edition_id, email) is what makes this safe to run
       again: a row that exists is left exactly as it is, which is how a retry
       cannot resend to somebody already accepted. */
    async seedDeliveries(rows) {
      if (!enabled || !service || !rows.length) return [];
      return call('newsletter_deliveries?on_conflict=edition_id,email', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify(rows),
      }, true);
    },
    async pendingDeliveries(editionId) {
      if (!enabled || !service) return [];
      return call('newsletter_deliveries?select=*&edition_id=eq.' + editionId
        + '&status=in.(queued,failed)&order=email.asc', { method: 'GET' }, true);
    },
    async deliveryCounts(editionId) {
      if (!enabled || !service) return {};
      const rows = await call('newsletter_deliveries?select=status&edition_id=eq.' + editionId, { method: 'GET' }, true);
      const out = {};
      (rows || []).forEach(r => { out[r.status] = (out[r.status] || 0) + 1; });
      return out;
    },
    async recordOutcome(editionId, outcome) {
      if (!enabled || !service) return null;
      const patch = {
        status: outcome.status,
        provider_message_id: outcome.provider_message_id || null,
        idempotency_key: outcome.idempotency_key,
        ambiguous: !!outcome.ambiguous,
        last_error: outcome.error || null,
      };
      return call('newsletter_deliveries?edition_id=eq.' + editionId
        + '&email=eq.' + encodeURIComponent(String(outcome.email).toLowerCase()), {
        method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(patch),
      }, true);
    },
    /* attempts is incremented server-side-ish: read, add one, write. A race
       here costs an inaccurate counter and nothing else, which is why it is
       not worth a function. */
    async bumpAttempts(ids) {
      if (!enabled || !service || !ids.length) return null;
      const rows = await call('newsletter_deliveries?select=id,attempts&id=in.(' + ids.join(',') + ')', { method: 'GET' }, true);
      const body = (rows || []).map(r => ({ id: r.id, attempts: (r.attempts || 0) + 1 }));
      if (!body.length) return null;
      return call('newsletter_deliveries?on_conflict=id', {
        method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body),
      }, true);
    },

    /* ------------------------------------------------------------- runs */
    async logRun(rows) {
      if (!enabled || !service || !rows.length) return null;
      return call('newsletter_runs', {
        method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rows),
      }, true);
    },

    /* ------------------------------------------------------ suppressions */
    async suppress(email, reason, detail, eventId) {
      return rpc('newsletter_suppress', { p_email: email, p_reason: reason, p_detail: detail || null, p_event_id: eventId || null });
    },
    call, rpc,
  };
}

/* ------------------------------------------------------------- resolve() */
/* The one place the pipeline asks "what am I configured to do?". Returns the
   merged settings and, beside them, where each value came from. */
async function resolve(opts) {
  opts = opts || {};
  const committed = STORE.settings();
  const c = opts.client || client(opts);
  const sources = {};
  const out = Object.assign({}, committed);
  Object.keys(committed).forEach(k => { sources[k] = 'committed'; });

  let db = null, dbError = null;
  if (opts.offline !== true) {
    try { db = await c.readSettings(); } catch (e) { dbError = (e && e.message) || String(e); }
  }
  if (db) {
    Object.keys(db).forEach(k => {
      if (db[k] == null) return;
      if (k === 'id' || k === 'updated_at' || k === 'updated_by') return;
      out[k] = db[k];
      sources[k] = 'database';
    });
    /* the two threshold pairs are stored flat in the database and nested in
       the committed file; the pipeline reads the nested shape */
    out.thresholds = { NFL: Number(db.nfl_threshold), CFB: Number(db.cfb_threshold) };
    out.expansion_thresholds = { NFL: Number(db.nfl_expansion_threshold), CFB: Number(db.cfb_expansion_threshold) };
    sources.thresholds = 'database';
    sources.expansion_thresholds = 'database';
  }
  Object.keys(ENV_FIELDS).forEach(k => {
    const spec = ENV_FIELDS[k];
    const raw = process.env[spec.env];
    const v = coerce(spec.type, raw);
    if (v == null) return;
    out[k] = v;
    sources[k] = 'env:' + spec.env;
  });

  return {
    settings: out,
    sources,
    database_reachable: !!db,
    database_error: dbError,
    has_service_credential: c.hasService,
    /* THE TWO SWITCHES THE PIPELINE CHECKS BEFORE IT SENDS ANYTHING, resolved
       once so nothing downstream re-derives them. */
    sending_enabled: out.sending_enabled === true,
    sportEnabled(sport) {
      return String(sport).toUpperCase() === 'CFB' ? out.cfb_enabled !== false : out.nfl_enabled !== false;
    },
    client: c,
  };
}

module.exports = { SB_URL, SB_ANON, ENV_FIELDS, asBool, asInt, coerce, client, resolve };
