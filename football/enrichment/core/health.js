/* ============================================================================
   PROVIDER HEALTH.

   Every call a provider makes is classified, and the calls roll up into one
   of seven states:

     HEALTHY         every call answered and the content is current
     DEGRADED        some calls failed; what answered is still used, and
                     certainty is reduced by the failed share
     RATE_LIMITED    the provider answered 429
     AUTH_FAILURE    the PROVIDER refused us (401/403)
     DOWN            nothing answered: network failure, 5xx, timeouts, or this
                     run's own network policy refused the connection
     STALE           it answered, but what it holds is older than its TTL
                     (ESPN's college injury endpoint returning 2020 rows)
     NOT_CONFIGURED  no URL or credential is registered, so it was never asked

   THE ONE RULE: a provider failure is never "no injuries", "no conflict" or
   "no quote". It is a provider failure, recorded here and carried into every
   evidence record the provider would have supplied.

   A 403 from this run's egress proxy (x-deny-reason: host_not_allowed) is
   not the provider refusing us: it is classified EGRESS_BLOCKED, rolls up as
   DOWN, and is attributed to the run environment, so a sandbox run never
   publishes "ESPN revoked our access".
   ========================================================================== */
'use strict';

const OUTCOMES = ['OK', 'RATE_LIMITED', 'AUTH_FAILURE', 'NOT_FOUND', 'SERVER_ERROR', 'TIMEOUT', 'NETWORK', 'EGRESS_BLOCKED', 'BAD_CONTENT'];

/* classify one call: {status, headers (object or Headers), error, content_ok} */
function classifyCall(c) {
  c = c || {};
  const h = c.headers || {};
  const get = (k) => (typeof h.get === 'function' ? h.get(k) : (h[k] || h[k.toLowerCase()] || null));
  const deny = get('x-deny-reason');
  if (deny) return { outcome: 'EGRESS_BLOCKED', status: c.status || null, detail: 'the run environment’s egress policy refused the host (' + deny + ')' };
  if (c.error) {
    const m = String(c.error.message || c.error);
    if (/timeout|aborted/i.test(m) || (c.error && c.error.name === 'TimeoutError')) return { outcome: 'TIMEOUT', status: null, detail: m.slice(0, 160) };
    return { outcome: 'NETWORK', status: null, detail: m.slice(0, 160) };
  }
  const s = c.status;
  if (s === 429) return { outcome: 'RATE_LIMITED', status: s, detail: 'HTTP 429' };
  if (s === 401 || s === 403) return { outcome: 'AUTH_FAILURE', status: s, detail: 'HTTP ' + s };
  if (s === 404 || s === 410) return { outcome: 'NOT_FOUND', status: s, detail: 'HTTP ' + s };
  if (s >= 500) return { outcome: 'SERVER_ERROR', status: s, detail: 'HTTP ' + s };
  if (s >= 200 && s < 300) {
    if (c.content_ok === false) return { outcome: 'BAD_CONTENT', status: s, detail: c.content_why || 'answered, but not with what was asked for' };
    return { outcome: 'OK', status: s, detail: null };
  }
  return { outcome: 'NETWORK', status: s || null, detail: 'HTTP ' + s };
}

/* roll calls up into a state.
   o: {configured (bool), not_configured_why, calls: [classified], data_age_hours, ttl_hours,
       content_stale_why, checked_at, source ('live'|'artifact'), artifact_at} */
function summarize(name, o) {
  o = o || {};
  const all = o.calls || [];
  /* a refusal by THIS RUN's network policy says nothing about the provider:
     when anything else reached it, the provider is judged on what reached it
     and the blocked live check is noted beside the verdict */
  const blocked = all.filter((c) => c.outcome === 'EGRESS_BLOCKED');
  const calls = blocked.length && blocked.length < all.length ? all.filter((c) => c.outcome !== 'EGRESS_BLOCKED') : all;
  const by = {};
  calls.forEach((c) => { by[c.outcome] = (by[c.outcome] || 0) + 1; });
  const n = calls.length, ok = by.OK || 0, failed = n - ok;
  let state, reason, attributable = 'provider';
  if (o.configured === false) {
    state = 'NOT_CONFIGURED'; reason = o.not_configured_why || 'no URL or credential is registered, so it was never asked'; attributable = 'configuration';
  } else if (!n && o.checked === false) {
    state = 'NOT_CHECKED'; reason = o.not_checked_why || 'not called this run'; attributable = 'run_environment';
  } else if (!n) {
    state = 'DOWN'; reason = 'no call was made or recorded this run';
  } else if (ok === n) {
    const staleAge = o.ttl_hours != null && o.data_age_hours != null && o.data_age_hours > o.ttl_hours;
    if (o.content_stale_why || staleAge) {
      state = 'STALE';
      reason = o.content_stale_why || ('it answered, but its newest content is ' + Math.round(o.data_age_hours) + 'h old, past a ' + o.ttl_hours + 'h window');
    } else { state = 'HEALTHY'; reason = n + ' of ' + n + ' calls answered'; }
  } else if ((by.RATE_LIMITED || 0) > 0 && (by.RATE_LIMITED || 0) >= failed / 2) {
    state = 'RATE_LIMITED'; reason = by.RATE_LIMITED + ' of ' + n + ' calls answered 429';
  } else if (ok === 0 && (by.AUTH_FAILURE || 0) >= failed / 2) {
    state = 'AUTH_FAILURE'; reason = by.AUTH_FAILURE + ' of ' + n + ' calls refused (401/403) by the provider';
  } else if (ok === 0) {
    state = 'DOWN';
    const eg = by.EGRESS_BLOCKED || 0;
    if (eg === n) { attributable = 'run_environment'; reason = 'this run’s network policy refused every connection to the provider — not a finding about the provider'; }
    else reason = 'no call answered: ' + Object.keys(by).map((k) => k.toLowerCase().replace(/_/g, ' ') + ' ×' + by[k]).join(', ');
  } else if (o.content_stale_why) {
    /* part of it answered, and what answered is historical: the content is
       the finding */
    state = 'STALE'; reason = o.content_stale_why + '; ' + failed + ' of ' + n + ' calls also failed';
  } else {
    state = 'DEGRADED'; reason = failed + ' of ' + n + ' calls failed (' + Object.keys(by).filter((k) => k !== 'OK')
      .map((k) => k.toLowerCase().replace(/_/g, ' ') + ' \u00d7' + by[k]).join(', ') + ')';
  }
  if (blocked.length && blocked.length < all.length) reason += '; the live check from this run was refused by the run\u2019s own network policy (not counted against the provider)';
  const lastOk = calls.filter((c) => c.outcome === 'OK' && c.at).map((c) => c.at).sort().pop() || o.last_success_at || null;
  return {
    provider: name, state, reason, attributable_to: attributable,
    calls: n, ok, failed, by_outcome: by, egress_blocked_checks: blocked.length,
    failed_share: n ? Math.round(1000 * failed / n) / 1000 : null,
    certainty: certainty(state, n ? failed / n : null),
    last_success_at: lastOk,
    checked_at: o.checked_at || null,
    observed_via: o.source || 'live',
    artifact_at: o.artifact_at || null,
    sample_errors: calls.filter((c) => c.outcome !== 'OK').slice(0, 3).map((c) => ({ outcome: c.outcome, status: c.status, detail: c.detail, url: c.url || null }))
  };
}

/* how much of a provider's evidence survives its state */
function certainty(state, failedShare) {
  const t = { HEALTHY: 1, STALE: 0.5, RATE_LIMITED: 0, AUTH_FAILURE: 0, DOWN: 0, NOT_CONFIGURED: 0, NOT_CHECKED: 0 };
  if (state === 'DEGRADED') return Math.max(0, Math.round((1 - (failedShare || 0)) * 1000) / 1000);
  return t[state] == null ? 0 : t[state];
}

/* a failure record written by an ARTIFACT (e.g. availability current.json
   failure_groups: {source, error:'HTTP 403', teams, kind, systematic}) turned
   into classified calls, so an offline enrichment run reports what the
   collector actually met, stamped with when it met it */
function callsFromFailureGroup(g, at) {
  const out = [];
  const codes = (String((g && g.error) || '').match(/HTTP (\d{3})/g) || []).map((c) => +c.slice(5));
  const n = Math.max(1, +(g && g.teams) || 1);
  /* several endpoints tried for one source (404, 403, 404): the one that
     exists and refused is the finding; the variants that do not exist are not */
  const primary = codes.find((c) => c === 401 || c === 403) || codes.find((c) => c === 429) || codes.find((c) => c >= 500) || (codes.length ? codes[codes.length - 1] : null);
  const cls = primary ? classifyCall({ status: primary }) : classifyCall({ error: (g && g.error) || 'failed' });
  for (let i = 0; i < n; i++) out.push({ outcome: cls.outcome, status: cls.status, detail: String((g && g.error) || '').slice(0, 160), at });
  return out;
}

module.exports = { OUTCOMES, classifyCall, summarize, certainty, callsFromFailureGroup };
