#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — the ONE way a GitHub job asks for The Odds API data.

   Every Node job that used to hold ODDS_API_KEY and build provider URLs
   (football/props/capture.js, football/cfb_terminal/alternates.js,
   football/props/factory/odds.js) now asks supabase/functions/odds_gateway
   instead. The gateway is the only holder of the provider key; it decides
   whether a request is served from the stored snapshot, collapsed into one
   already in flight, refused by the budget, or bought — and it records every
   decision in public.odds_api_requests (supabase/odds_api_gateway.sql).

   CREDENTIALS. The same repository secrets the jobs already hold for the
   database: SB_URL / SB_SERVICE_ROLE (passed as EDGD_SB_URL / EDGD_SB_SERVICE),
   or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. ODDS_GATEWAY_SECRET is accepted
   instead of the service role. No provider key is read here, ever.

   NO RETRIES HERE. The gateway already retries temporary provider failures
   (bounded, and each retry re-checks the budget); a second loop here would
   multiply them. A transport failure reaching the gateway is reported, and the
   job's next scheduled run is the retry.

   fetchImpl is injectable so every job's suite runs with no network.
   =========================================================================== */
'use strict';

const DEFAULT_URL = 'https://iattxbkbufslbauoumga.supabase.co';

function config(env) {
  env = env || process.env;
  const url = String(env.EDGD_SB_URL || env.SUPABASE_URL || env.SB_URL || DEFAULT_URL).trim().replace(/\/$/, '');
  const service = String(env.EDGD_SB_SERVICE || env.SUPABASE_SERVICE_ROLE_KEY || env.SB_SERVICE_ROLE || '').trim();
  const secret = String(env.ODDS_GATEWAY_SECRET || '').trim();
  if (!service && !secret) return null;
  return { url, service, secret };
}

/** A gateway client. `request()` resolves to the gateway's envelope:
    { ok, decision, source: provider|cache|stale_cache|none, fresh,
      new_for_consumer, fetched_at, data, quota, cost, ... }. */
function client(cfg, fetchImpl, opts) {
  opts = opts || {};
  const f = fetchImpl || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs || 90000;
  const stats = { requests: 0, provider: 0, cache: 0, stale: 0, refused: 0, credits: 0, decisions: {} };
  async function call(body) {
    stats.requests++;
    const headers = { 'content-type': 'application/json' };
    if (cfg.service) { headers.apikey = cfg.service; headers.authorization = 'Bearer ' + cfg.service; }
    if (cfg.secret) headers['x-odds-gateway-secret'] = cfg.secret;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let env;
    try {
      const r = await f(cfg.url + '/functions/v1/odds_gateway', {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined,
      });
      const text = await r.text();
      try { env = JSON.parse(text); } catch (_) { env = null; }
      if (!env || typeof env !== 'object') {
        env = { ok: false, decision: 'gateway_unreachable', reason: 'HTTP ' + r.status + ': ' + String(text).slice(0, 160), source: 'none', fresh: false, data: null };
      }
    } catch (e) {
      env = { ok: false, decision: 'gateway_unreachable', reason: String((e && e.message) || e).slice(0, 160), source: 'none', fresh: false, data: null };
    } finally { if (timer) clearTimeout(timer); }
    stats.decisions[env.decision] = (stats.decisions[env.decision] || 0) + 1;
    if (env.source === 'provider') { stats.provider++; stats.credits += Number(env.cost) || 0; }
    else if (env.source === 'cache') stats.cache++;
    else if (env.source === 'stale_cache') stats.stale++;
    if (!env.ok && env.source === 'none') stats.refused++;
    return env;
  }
  return {
    stats,
    request: (q) => call(Object.assign({ action: 'odds' }, q || {})),
    status: () => call({ action: 'status' }),
  };
}

/** True when an envelope carries data this consumer has not processed yet. */
function isNew(env) {
  if (!env || !env.ok || env.data == null) return false;
  if (env.new_for_consumer === false) return false;
  return env.source === 'provider' || env.source === 'cache' || env.new_for_consumer === true;
}

module.exports = { config, client, isNew, DEFAULT_URL };
