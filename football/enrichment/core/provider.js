/* ============================================================================
   THE PROVIDER CONTRACT.

   No downstream code knows which vendor supplied a fact. A provider is an
   adapter with one shape:

     {
       name, label, kind: 'availability' | 'qb' | 'market' | 'fcs_results',
       source_type,                   config.js SOURCE_TYPES / QB_TIERS key
       configured(ctx)  -> true | 'why not'
       healthCheck(ctx) -> Promise<classified call>     one cheap request
       fetchTeam(team, ctx) -> Promise<raw>             optional
       fetchGame(game, ctx) -> Promise<raw>             optional
       normalize(raw, ctx) -> normalized records        pure
     }

   `run()` is the only way the pipeline calls one. It never throws: a
   provider that fails, times out or returns garbage yields
   {ok:false, error} and a classified call in the run's health ledger, and the
   pipeline carries on with the providers that answered.

   `http()` is the one network primitive: bounded, classified, and honest
   about an egress refusal.
   ========================================================================== */
'use strict';

const H = require('./health.js');

const UA = 'EdgeDeskSports-enrichment/1 (+https://edgedesksports.com)';

function Ledger(o) { this.calls = {}; this.meta = {}; this.live = !(o && o.live === false); }
Ledger.prototype.record = function (provider, call) {
  (this.calls[provider] = this.calls[provider] || []).push(call);
};
Ledger.prototype.note = function (provider, meta) {
  this.meta[provider] = Object.assign(this.meta[provider] || {}, meta);
};
Ledger.prototype.summary = function (providers, now) {
  const out = {};
  providers.forEach((p) => {
    const m = this.meta[p.name] || {};
    let conf = true, why = null;
    try { const c = p.configured ? p.configured(m.ctx || {}) : true; if (c !== true) { conf = false; why = c; } } catch (e) { conf = false; why = String(e.message || e); }
    if (m.configured === false) { conf = false; why = m.not_configured_why || why; }
    out[p.name] = Object.assign(H.summarize(p.name, { configured: conf, not_configured_why: why,
      checked: this.live === false && !(this.calls[p.name] || []).length ? false : true,
      not_checked_why: '--offline: not called this run',
      calls: this.calls[p.name] || [], data_age_hours: m.data_age_hours, ttl_hours: m.ttl_hours,
      content_stale_why: m.content_stale_why, checked_at: now, source: m.source || 'live',
      artifact_at: m.artifact_at || null, last_success_at: m.last_success_at || null }),
    { label: p.label, kind: p.kind, source_type: p.source_type, role: p.role || null, covers: m.covers || null, note: m.note || null });
  });
  return out;
};

/* one bounded HTTP call, classified. Never throws. */
async function http(url, o) {
  o = o || {};
  const t0 = Date.now();
  const at = new Date().toISOString();
  let res = null, text = null;
  try {
    res = await fetch(url, { method: o.method || 'GET', redirect: 'follow', headers: Object.assign({ 'user-agent': UA }, o.headers || {}),
      body: o.body, signal: AbortSignal.timeout(o.timeout_ms || 20000) });
    text = await res.text();
  } catch (e) {
    const cls = H.classifyCall({ error: e });
    return Object.assign({ ok: false, status: null, text: null, url, at, ms: Date.now() - t0 }, cls);
  }
  let contentOk = true, why = null;
  if (res.ok && typeof o.accept === 'function') {
    try { const v = o.accept(text); if (v !== true) { contentOk = false; why = v || 'unexpected content'; } } catch (e) { contentOk = false; why = String(e.message || e); }
  }
  const cls = H.classifyCall({ status: res.status, headers: res.headers, content_ok: contentOk, content_why: why });
  return Object.assign({ ok: cls.outcome === 'OK', status: res.status, text: cls.outcome === 'OK' ? text : null, url, at, ms: Date.now() - t0 }, cls,
    { body_hint: cls.outcome === 'OK' ? null : String(text || '').slice(0, 160) });
}

/* run(provider, method, args, ledger): the only call path */
async function run(p, method, args, ledger) {
  if (!p || typeof p[method] !== 'function') return { ok: false, error: 'provider ' + (p && p.name) + ' has no ' + method };
  try {
    const out = await p[method].apply(p, args || []);
    return { ok: true, data: out };
  } catch (e) {
    const cls = H.classifyCall({ error: e });
    if (ledger) ledger.record(p.name, Object.assign({ at: new Date().toISOString() }, cls));
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/* a provider must declare its shape; the pipeline refuses one that does not */
function validate(p) {
  const miss = [];
  ['name', 'label', 'kind', 'source_type'].forEach((k) => { if (!p || !p[k]) miss.push(k); });
  if (p && typeof p.normalize !== 'function') miss.push('normalize()');
  if (p && typeof p.healthCheck !== 'function') miss.push('healthCheck()');
  return miss;
}

module.exports = { Ledger, http, run, validate, UA };
