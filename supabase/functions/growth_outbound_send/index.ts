// ============================================================
//  FILE:    supabase/functions/growth_outbound_send/index.ts
//  TYPE:    Edge Function (deployed) — sends APPROVED outbound drafts
//  DEPLOY:  supabase functions deploy growth_outbound_send --no-verify-jwt
//           (the owner's token is verified inside, by requireOutboundOwner;
//           with platform verification on, the browser's CORS preflight —
//           which carries no token — would be refused before it got here)
// ============================================================
// THE ONLY CODE THAT SENDS OUTBOUND EMAIL, and it sends only what the
// database hands it for a draft the OWNER approved, when the OWNER asks.
//
//   POST { draft_ids: [uuid, …] }   (or { draft_id }), 1 to 25 at a time
//   Authorization: Bearer <the owner's own session token>
//
// FOR EACH DRAFT, IN ORDER, STOPPING AT THE FIRST PROBLEM
//   1  requireOutboundOwner (once per request): GoTrue must accept the token
//      and growth_outbound_is_owner(), asked AS THE CALLER, must answer
//      exactly true. Otherwise 401 / 403 / 503 and nothing else happens.
//   2  growth_outbound_send_claim(draft), AS THE CALLER. The database writes
//      the send row first — its trigger re-checks approval, the unchanged
//      content, the current owner, the recipient (only the test inbox in test
//      mode), suppressions, once per draft and per address per step, the daily
//      cap and the compliance configuration — and returns the message exactly
//      as it must go out, with ONE idempotency key per draft.
//   3  Resend, with that Idempotency-Key. A retry of the same draft reuses the
//      key, so it can never send twice; the database abandons (never retries)
//      a claim whose outcome is unknown after 23 hours.
//   4  growth_outbound_send_result(send), AS THE CALLER: sent (with Resend's
//      id), failed (a permanent refusal), or still claimed (try again).
//
//   POST { action: 'domain_check' }   (Phase 12; sends nothing)
//      reads the sending domain's SPF, DKIM and DMARC over DNS-over-HTTPS
//      (and Resend's own status for it, when the key may read it) and
//      records the result (growth_outbound_domain_auth_record, as the
//      caller). A record found missing blocks live sending until fixed.
//      (Phase 13) Resend's own status counts too: a domain Resend has not
//      verified fails the check.
//
//   POST { action: 'optout_check' }   (Phase 13; sends nothing, changes nothing)
//      asks the opt-out endpoint itself, at the configured base (or this
//      project's own functions address when none is set yet): a GET with a
//      token no send carries must 303 to the stop page with the token in the
//      fragment; a one-click POST with it must answer "not valid", which
//      proves the endpoint reaches the database. The result is recorded
//      (growth_outbound_optout_check_record, as the caller); live sending
//      needs it to pass at the current base.
//   POST { action: 'health' }   (Phase 13; sends nothing)
//      whether Resend accepts the key (a sending-only key is said to be one)
//      and is recorded as the provider's state.
//
// WHAT IT HOLDS. The project URL, the PUBLIC anon key (to reach the API as
// the caller) and RESEND_API_KEY. NO service-role key: every database call
// is made with the owner's own token, so the database checks the owner again
// on every step. Nothing it logs or returns contains a key or a token.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the platform
//   RESEND_API_KEY                     already set for the newsletter (Supabase
//                                      secrets are shared by every function)
//   OUTBOUND_ALLOWED_ORIGINS           optional, comma-separated; defaults to
//                                      https://edgedesksports.com and
//                                      https://www.edgedesksports.com
// ============================================================

// ── BEGIN OUTBOUND AUTH ──────────────────────────────────────────────────
// Canonical source: tools/growth/outbound_auth.js, copied VERBATIM by
// tools/growth/inline_outbound_auth.js. Edit the canonical file, then run it.
/* ===========================================================================
   requireOutboundOwner — the server-side owner check every privileged
   outbound Edge Function runs before it does anything.

   Written once, here, with its tests (tools/growth/outbound_auth.test.js),
   and copied byte-for-byte into each Edge Function that needs it (the repo's
   functions are single files with no imports; a test holds the copies equal,
   as tools/billing/billing_core.test.js does for the billing core).

   THE RULE: the caller is somebody only because GoTrue says so, and an owner
   only because the DATABASE says so, asked as that caller. Nothing in the
   request body names the user; nothing is cached; every failure is a refusal.

     1  Authorization must be `Bearer <jwt>`, and not the public anon key
        (which names nobody)                                   → else 401
     2  GoTrue /auth/v1/user must accept the token (it also rejects a revoked
        or expired session)                                    → else 401;
        unreachable or 5xx                                     → 503
     3  public.growth_outbound_is_owner() called AS THE CALLER must answer
        exactly `true`                                         → else 403;
        not installed                                          → 503;
        unreachable or 5xx                                     → 503

   It needs only the project URL and the anon key: no service-role secret is
   involved in deciding who the caller is. Every door the function then calls
   is called AS THE CALLER too (rpcAsCaller), so the database checks the owner
   again on every action.
   =========================================================================== */
(function (root) {
  'use strict';

  var TIMEOUT_MS = 8000;

  function refuse(status, reason) { return { ok: false, status: status, reason: reason }; }

  function withTimeout(fetchImpl, url, init, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (_) {} }, ms || TIMEOUT_MS) : null;
    return Promise.resolve()
      .then(function () { return fetchImpl(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init); })
      .then(function (r) { if (t) clearTimeout(t); return r; }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  function readJson(r) {
    return Promise.resolve(r.text ? r.text() : '').then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (_) { return undefined; }
    }, function () { return undefined; });
  }

  function headerOf(req, name) {
    try {
      if (req && req.headers && typeof req.headers.get === 'function') return req.headers.get(name) || '';
      if (req && req.headers) return req.headers[name] || req.headers[name.toLowerCase()] || '';
    } catch (_) {}
    return '';
  }

  /* cfg: { url, anonKey, fetch, timeoutMs } */
  function requireOutboundOwner(req, cfg) {
    cfg = cfg || {};
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var anon = String(cfg.anonKey || '');
    var f = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!base || !anon || !f) return Promise.resolve(refuse(500, 'misconfigured'));

    var authz = String(headerOf(req, 'authorization') || '');
    var m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
    if (!m) return Promise.resolve(refuse(401, 'sign_in_required'));
    var token = m[1];
    if (token === anon) return Promise.resolve(refuse(401, 'sign_in_required'));
    if (token.split('.').length !== 3) return Promise.resolve(refuse(401, 'sign_in_required'));
    var callerAuthz = 'Bearer ' + token;

    return withTimeout(f, base + '/auth/v1/user', { method: 'GET', headers: { apikey: anon, authorization: callerAuthz } }, cfg.timeoutMs)
      .then(function (r) {
        if (r.status >= 500) return refuse(503, 'auth_unavailable');
        if (!r.ok) return refuse(401, 'session_invalid');
        return readJson(r).then(function (u) {
          if (!u || typeof u.id !== 'string' || !u.id) return refuse(401, 'session_invalid');
          return withTimeout(f, base + '/rest/v1/rpc/growth_outbound_is_owner', {
            method: 'POST', headers: { apikey: anon, authorization: callerAuthz, 'content-type': 'application/json' }, body: '{}'
          }, cfg.timeoutMs).then(function (o) {
            return readJson(o).then(function (b) {
              if (o.status >= 500) return refuse(503, 'owner_check_unavailable');
              if (o.status === 404 || (b && (b.code === 'PGRST202' || b.code === '42883'))) return refuse(503, 'outbound_not_installed');
              if (o.status === 401) return refuse(401, 'session_invalid');
              if (o.ok && b === true) return { ok: true, status: 200, user: { id: u.id, email: u.email || null }, authz: callerAuthz };
              return refuse(403, 'not_an_owner');
            });
          }, function () { return refuse(503, 'owner_check_unavailable'); });
        });
      }, function () { return refuse(503, 'auth_unavailable'); });
  }

  /* Every door afterwards, called as the caller: the database checks again. */
  function rpcAsCaller(cfg, callerAuthz, name, args) {
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var f = cfg.fetch || fetch;
    return withTimeout(f, base + '/rest/v1/rpc/' + encodeURIComponent(name), {
      method: 'POST', headers: { apikey: cfg.anonKey, authorization: callerAuthz, 'content-type': 'application/json' },
      body: JSON.stringify(args || {})
    }, cfg.timeoutMs).then(function (r) {
      return readJson(r).then(function (b) { return { status: r.status, ok: r.ok, body: b }; });
    });
  }

  var API = { requireOutboundOwner: requireOutboundOwner, rpcAsCaller: rpcAsCaller };
  root.EDOutboundAuth = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
// ── END OUTBOUND AUTH ────────────────────────────────────────────────────

// @ts-ignore the block above defines it on globalThis
const AUTH = (globalThis as any).EDOutboundAuth;

const RESEND_URL = 'https://api.resend.com/emails';
const MAX_DRAFTS = 25;
const RESEND_TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

type Cfg = { url: string; anonKey: string; resendKey: string; origins: string[]; fetch: typeof fetch; timeoutMs?: number };

// Read PER CALL: a rotated key takes effect on the next request.
function config(): Cfg {
  // @ts-ignore Deno exists in the edge runtime
  const env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';
  const origins = (env('OUTBOUND_ALLOWED_ORIGINS') || 'https://edgedesksports.com,https://www.edgedesksports.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return { url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'), resendKey: env('RESEND_API_KEY'), origins, fetch: globalThis.fetch.bind(globalThis) };
}

function cors(req: Request, c: Cfg): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const h: Record<string, string> = {
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
  // Only EdgeDesk's own pages may read the answer. The token is the security;
  // this keeps any other site from even seeing a refusal.
  if (c.origins.indexOf(origin) >= 0) h['access-control-allow-origin'] = origin;
  return h;
}
function json(req: Request, c: Cfg, body: any, status = 200): Response {
  // a refusal carries its reason as `code` too, which the console reads
  if (body && body.ok === false && body.reason && body.code == null) body = { ...body, code: body.reason };
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req, c) },
  });
}

// The database composed the message; it is sent only if it still looks like
// exactly one EdgeDesk email to exactly one person. Anything else is a bug or
// tampering, and nothing goes out.
export function checkMessage(m: any): string | null {
  if (!m || typeof m !== 'object') return 'no message';
  const one = (v: unknown) => typeof v === 'string' && !/[\r\n]/.test(v);
  if (!one(m.from) || !/^[^<>@]{1,60} <[a-z0-9._%+-]+@edgedesksports\.com>$/.test(m.from)) return 'the sender is not an edgedesksports.com address';
  if (!one(m.to) || !EMAIL.test(m.to) || m.to.length > 254) return 'the recipient is not one email address';
  if (!one(m.reply_to) || !/@edgedesksports\.com$/.test(m.reply_to)) return 'the reply-to is not an edgedesksports.com address';
  if (!one(m.subject) || !m.subject.trim() || m.subject.length > 150) return 'the subject is missing, too long or spans lines';
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 20000) return 'the body is missing or too long';
  if (m.headers != null) {
    if (typeof m.headers !== 'object') return 'bad headers';
    for (const k of Object.keys(m.headers)) {
      if (k !== 'List-Unsubscribe' && k !== 'List-Unsubscribe-Post') return 'an unexpected header';
      if (!one(m.headers[k])) return 'a header spans lines';
    }
  }
  return null;
}

async function resendSend(c: Cfg, key: string, sendId: string, m: any): Promise<{ status: number; id?: string; message?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? RESEND_TIMEOUT_MS);
  try {
    const r = await c.fetch(RESEND_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + c.resendKey, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({
        from: m.from, to: [m.to], reply_to: m.reply_to, subject: m.subject, text: m.text,
        headers: m.headers || undefined,
        tags: [{ name: 'edgedesk', value: 'outbound' }, { name: 'send', value: sendId }],
      }),
      signal: ctl.signal,
    });
    let b: any = null;
    try { b = await r.json(); } catch (_) { b = null; }
    return { status: r.status, id: b && typeof b.id === 'string' ? b.id : undefined, message: b && (b.message || b.name) ? String(b.message || b.name).slice(0, 300) : undefined };
  } catch (_) {
    return { status: 0 };
  } finally {
    clearTimeout(t);
  }
}

// One approved draft: claim, send, record. Never throws.
export async function sendOne(c: Cfg, authz: string, draftId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { draft_id: draftId };
  let claim;
  try { claim = await AUTH.rpcAsCaller(c, authz, 'growth_outbound_send_claim', { p_draft_id: draftId }); }
  catch (_) { return { ...out, ok: false, reason: 'database_unreachable' }; }
  if (claim.status === 401 || claim.status === 403) return { ...out, ok: false, reason: 'not_an_owner', stop: true };
  if (!claim.ok || !claim.body) return { ...out, ok: false, reason: 'claim_failed', status: claim.status };
  const b = claim.body;
  if (b.ok !== true) return { ...out, ok: false, reason: b.reason || 'refused', detail: b.detail, problems: b.problems };
  if (b.already) return { ...out, ok: true, state: b.state, already: true };

  const record = async (resendId: string | null, error: string | null, permanent: boolean) => {
    try {
      const r = await AUTH.rpcAsCaller(c, authz, 'growth_outbound_send_result',
        { p_send_id: b.send_id, p_resend_id: resendId, p_error: error, p_permanent: permanent });
      return !!(r.ok && r.body && r.body.ok === true);
    } catch (_) { return false; }
  };

  const bad = checkMessage(b.message);
  if (bad) {
    await record(null, 'not sent: ' + bad, false);
    return { ...out, ok: false, reason: 'message_check_failed', detail: bad, send_id: b.send_id };
  }
  const r = await resendSend(c, String(b.idempotency_key), String(b.send_id), b.message);
  if (r.status >= 200 && r.status < 300 && r.id) {
    const ok = await record(r.id, null, false);
    return { ...out, ok: true, state: 'sent', send_id: b.send_id, test: !!b.test, to: b.message.to, retry: !!b.retry,
      recorded: ok, ...(ok ? {} : { warning: 'sent, but not yet recorded: press Send again to record it (the same key cannot send twice)' }) };
  }
  if (r.status === 400 || r.status === 422) {
    await record(null, 'refused by Resend (' + r.status + '): ' + (r.message || 'invalid'), true);
    return { ...out, ok: false, state: 'failed', reason: 'resend_rejected', detail: r.message, send_id: b.send_id };
  }
  if (r.status === 401 || r.status === 403) {
    await record(null, 'Resend refused the API key (' + r.status + ')', false);
    return { ...out, ok: false, state: 'claimed', reason: 'resend_key_refused', send_id: b.send_id, stop: true };
  }
  await record(null, r.status === 0 ? 'Resend unreachable' : 'Resend answered ' + r.status + (r.message ? ': ' + r.message : ''), false);
  return { ...out, ok: false, state: 'claimed', reason: r.status === 0 ? 'resend_unreachable' : 'resend_' + r.status, retry: true, send_id: b.send_id };
}

// ── the sending domain's authentication (Phase 12) ──────────────────────────
// POST { action: 'domain_check' } — the owner asks; nothing is sent. SPF (the
// TXT record Resend's return path needs, at send.<domain>), DKIM (Resend's
// key, at resend._domainkey.<domain>) and DMARC (_dmarc.<domain>) are read
// over DNS-over-HTTPS; Resend is asked for the domain's own status when the
// API key may read it. A record that DNS says is not there is a failure; a
// lookup that did not answer is "could not tell", never a failure.
const DOH = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
type Lookup = { answered: boolean; records: string[] };
export async function dnsTxt(c: Cfg, name: string, type = 'TXT'): Promise<Lookup> {
  for (const base of DOH) {
    const ctl = new AbortController();
    const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, 8000);
    try {
      const r = await c.fetch(base + '?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { accept: 'application/dns-json' }, signal: ctl.signal });
      if (!r.ok) continue;
      const b: any = await r.json().catch(() => null);
      if (!b || (b.Status !== 0 && b.Status !== 3)) continue;   // NOERROR, or NXDOMAIN (no such name: answered, nothing there)
      const want = type === 'MX' ? 15 : 16;
      const recs = (Array.isArray(b.Answer) ? b.Answer : []).filter((a: any) => a && a.type === want && typeof a.data === 'string')
        .map((a: any) => String(a.data).replace(/"\s+"/g, '').replace(/^"|"$/g, '').trim());
      return { answered: true, records: recs };
    } catch (_) { /* the next resolver */ } finally { clearTimeout(t); }
  }
  return { answered: false, records: [] };
}
export async function domainCheck(c: Cfg, domain: string): Promise<any> {
  const [spf, mx, root, dkim, dmarc] = await Promise.all([
    dnsTxt(c, 'send.' + domain), dnsTxt(c, 'send.' + domain, 'MX'), dnsTxt(c, domain), dnsTxt(c, 'resend._domainkey.' + domain), dnsTxt(c, '_dmarc.' + domain)]);
  const verdict = (l: Lookup, found: boolean) => (found ? true : l.answered ? false : null);
  const spfRec = spf.records.find((x) => /^v=spf1\b/i.test(x)) || null;
  const rootSpf = root.records.find((x) => /^v=spf1\b/i.test(x)) || null;
  const dkimRec = dkim.records.find((x) => /(^|;)\s*p=[A-Za-z0-9+/=]{20,}/.test(x)) || null;
  const dmarcRec = dmarc.records.find((x) => /^v=DMARC1\b/i.test(x)) || null;
  const policy = dmarcRec ? ((/(^|;)\s*p=(none|quarantine|reject)\b/i.exec(dmarcRec) || [])[2] || '').toLowerCase() || null : null;
  const out: any = {
    domain,
    spf: { ok: verdict(spf, !!spfRec && /amazonses\.com/i.test(spfRec)),
           detail: spfRec ? 'send.' + domain + ': ' + spfRec.slice(0, 200) : (spf.answered ? 'no SPF record at send.' + domain + ' (Resend\'s return path)' : 'DNS did not answer')
             + (mx.answered ? (mx.records.length ? '; MX present' : '; no MX at send.' + domain) : '') + (rootSpf ? '; root: ' + rootSpf.slice(0, 120) : '') },
    dkim: { ok: verdict(dkim, !!dkimRec), detail: dkimRec ? 'resend._domainkey.' + domain + ' holds a key' : (dkim.answered ? 'no DKIM key at resend._domainkey.' + domain : 'DNS did not answer') },
    dmarc: { ok: verdict(dmarc, !!dmarcRec && !!policy), policy,
             detail: dmarcRec ? dmarcRec.slice(0, 200) + (policy === 'none' ? ' (monitoring only: fine to start, then move to quarantine)' : '')
               : (dmarc.answered ? 'no DMARC record at _dmarc.' + domain : 'DNS did not answer') },
    via: 'dns-over-https',
  };
  const parts = [out.spf.ok, out.dkim.ok, out.dmarc.ok];
  out.ok = parts.every((v) => v === true) ? true : parts.some((v) => v === false) ? false : null;
  // Resend's own word on the domain, when the key may read it (a sending-only key may not)
  if (c.resendKey) {
    const ctl = new AbortController();
    const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, 8000);
    try {
      const r = await c.fetch('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + c.resendKey }, signal: ctl.signal });
      if (r.status === 401 || r.status === 403) out.provider = { ok: null, detail: 'the Resend key can send but not read domains' };
      else if (r.ok) {
        const b: any = await r.json().catch(() => null);
        const d = (Array.isArray(b?.data) ? b.data : []).find((x: any) => x && String(x.name || '').toLowerCase() === domain);
        out.provider = d ? { ok: d.status === 'verified', detail: 'Resend: ' + String(d.status || 'unknown').slice(0, 40) } : { ok: false, detail: 'Resend has no domain ' + domain };
      } else out.provider = { ok: null, detail: 'Resend answered ' + r.status };
    } catch (_) { out.provider = { ok: null, detail: 'Resend did not answer' }; } finally { clearTimeout(t); }
    // (Phase 13) Resend saying the domain is not verified fails the check:
    // Resend would refuse to send from it whatever DNS says
    if (out.provider && out.provider.ok === false) out.ok = false;
  }
  return out;
}

// ── the opt-out endpoint, checked (Phase 13) ────────────────────────────────
// Nothing about any real send is touched: the token is 64 zeros, which no
// send carries, so the endpoint's only possible answers are the redirect (a
// GET changes nothing) and "not valid" (a POST that reached the database).
const NO_SEND_TOKEN = '0'.repeat(64);
export async function optoutCheck(c: Cfg, base: string): Promise<Record<string, unknown>> {
  const b = base.endsWith('/') ? base : base + '/';
  const fn = b + 'growth_outbound_optout?t=' + NO_SEND_TOKEN;
  const out: Record<string, unknown> = { base: b };
  const timed = async (init: RequestInit) => {
    const ctl = new AbortController();
    const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? 10000);
    try { return await c.fetch(fn, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  };
  try {
    const r = await timed({ method: 'GET', redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    out.get_status = r.status;
    out.redirect_ok = r.status === 303 && /^https:\/\/(www\.)?edgedesksports\.com\/[^#\s]*#t=0{64}$/.test(loc);
  } catch (_) { out.get_status = 0; out.redirect_ok = false; }
  try {
    const r = await timed({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    const t = (await r.text().catch(() => '')).slice(0, 300);
    out.post_status = r.status;
    out.post_ok = r.status === 400 && /not valid/i.test(t);
  } catch (_) { out.post_status = 0; out.post_ok = false; }
  out.ok = out.redirect_ok === true && out.post_ok === true;
  out.detail = out.ok ? 'the link redirects to the stop page, and the one-click POST reaches the database'
    : !out.get_status ? 'the opt-out endpoint did not answer: deploy growth_outbound_optout (--no-verify-jwt)'
    : out.get_status === 404 ? 'growth_outbound_optout is not deployed at this address'
    : out.get_status === 401 ? 'the endpoint asks for a token: deploy it with --no-verify-jwt'
    : !out.redirect_ok ? 'a GET did not redirect to the stop page (' + out.get_status + ')'
    : 'the one-click POST answered ' + out.post_status + ' instead of "not valid": is supabase/growth_outbound.sql applied?';
  return out;
}

// ── Resend's key (Phase 13) ─────────────────────────────────────────────────
// GET /domains sends nothing. A full-access key reads them; a sending-only
// key is refused with "restricted_api_key", which still proves the key is a
// real Resend key; any other refusal means the key is wrong.
export async function resendHealth(c: Cfg): Promise<{ state: string; detail: string }> {
  if (!c.resendKey) return { state: 'credential_missing', detail: 'RESEND_API_KEY is not set: nothing can be sent' };
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, 8000);
  try {
    const r = await c.fetch('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + c.resendKey }, signal: ctl.signal });
    const b: any = await r.json().catch(() => null);
    if (r.ok) return { state: 'connected', detail: 'Resend accepted the key (it may read domains)' };
    if ((r.status === 401 || r.status === 403) && b && /restricted/.test(String(b.name || b.message || '')))
      return { state: 'connected', detail: 'Resend accepted the key: a sending-only key (the domain\'s status cannot be read with it)' };
    if (r.status === 401 || r.status === 403) return { state: 'unauthorized', detail: 'Resend refused the key (' + r.status + ')' };
    if (r.status === 429) return { state: 'unavailable', detail: 'Resend is rate-limiting (429): try again in a minute' };
    return { state: 'unavailable', detail: 'Resend answered ' + r.status };
  } catch (_) { return { state: 'unavailable', detail: 'Resend did not answer' }; } finally { clearTimeout(t); }
}

export async function handle(req: Request, cfg?: Cfg): Promise<Response> {
  const c = cfg ?? config();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, c) });
  if (req.method !== 'POST') return json(req, c, { ok: false, reason: 'method_not_allowed' }, 405);
  if (!c.url || !c.anonKey) return json(req, c, { ok: false, reason: 'not_configured' }, 503);

  const who = await AUTH.requireOutboundOwner(req, { url: c.url, anonKey: c.anonKey, fetch: c.fetch, timeoutMs: c.timeoutMs });
  if (!who.ok) return json(req, c, { ok: false, reason: who.reason }, who.status);

  let body: any = null;
  try { body = await req.json(); } catch (_) { body = null; }
  if (body && body.action === 'optout_check') {
    // the configured base, or this project's own functions address when none is set yet
    let st;
    try { st = await AUTH.rpcAsCaller(c, who.authz, 'growth_outbound_settings', {}); }
    catch (_) { return json(req, c, { ok: false, reason: 'database_unreachable' }, 503); }
    const configured = st && st.ok && st.body && typeof st.body.unsubscribe_url_base === 'string' ? st.body.unsubscribe_url_base : '';
    const base = configured || (c.url.replace(/\/+$/, '') + '/functions/v1/');
    const check = await optoutCheck(c, base);
    let rec;
    try { rec = await AUTH.rpcAsCaller(c, who.authz, 'growth_outbound_optout_check_record', { p: check }); }
    catch (_) { return json(req, c, { ok: false, reason: 'database_unreachable', check }, 503); }
    if (rec.status === 404) return json(req, c, { ok: false, reason: 'not_installed', check }, 503);
    if (!rec.ok || !rec.body || rec.body.ok !== true) return json(req, c, { ok: false, reason: (rec.body && rec.body.reason) || 'not_recorded', detail: rec.body && rec.body.detail, check }, 409);
    return json(req, c, { ok: true, check, unsubscribe_url_base: rec.body.unsubscribe_url_base, live_send_blockers: rec.body.live_send_blockers });
  }
  if (body && body.action === 'health') {
    const h = await resendHealth(c);
    try { await AUTH.rpcAsCaller(c, who.authz, 'growth_outbound_provider_health_record', { p_run: null, p: { provider: 'resend', state: h.state, detail: h.detail } }); }
    catch (_) { /* the answer still stands */ }
    return json(req, c, { ok: true, health: { resend: h } });
  }
  if (body && body.action === 'domain_check') {
    // the sending domain is the database's (the sender in the settings), never the request's
    let st;
    try { st = await AUTH.rpcAsCaller(c, who.authz, 'growth_outbound_settings', {}); }
    catch (_) { return json(req, c, { ok: false, reason: 'database_unreachable' }, 503); }
    const sender = st && st.ok && st.body && typeof st.body.sender_email === 'string' ? st.body.sender_email : '';
    const domain = /^[^@\s]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i.exec(sender)?.[1]?.toLowerCase();
    if (!domain) return json(req, c, { ok: false, reason: 'no_sender' }, 409);
    const check = await domainCheck(c, domain);
    let rec;
    try { rec = await AUTH.rpcAsCaller(c, who.authz, 'growth_outbound_domain_auth_record', { p: check }); }
    catch (_) { return json(req, c, { ok: false, reason: 'database_unreachable', check }, 503); }
    if (rec.status === 404) return json(req, c, { ok: false, reason: 'not_installed', check }, 503);
    if (!rec.ok || !rec.body || rec.body.ok !== true) return json(req, c, { ok: false, reason: (rec.body && rec.body.reason) || 'not_recorded', check }, 409);
    return json(req, c, { ok: true, check, live_send_blockers: rec.body.live_send_blockers });
  }
  const raw = body && Array.isArray(body.draft_ids) ? body.draft_ids : body && body.draft_id ? [body.draft_id] : null;
  if (!raw || raw.length < 1 || raw.length > MAX_DRAFTS) return json(req, c, { ok: false, reason: 'bad_request', detail: '1 to ' + MAX_DRAFTS + ' draft ids' }, 400);
  const ids: string[] = [];
  for (const x of raw) {
    if (typeof x !== 'string' || !UUID.test(x)) return json(req, c, { ok: false, reason: 'bad_request', detail: 'not a draft id' }, 400);
    if (ids.indexOf(x.toLowerCase()) < 0) ids.push(x.toLowerCase());
  }
  // Without the provider key nothing is claimed: a claim that cannot be sent
  // would only sit and wait.
  if (!c.resendKey) return json(req, c, { ok: false, reason: 'resend_not_configured' }, 503);

  const results: Record<string, unknown>[] = [];
  for (const id of ids) {
    const r = await sendOne(c, who.authz, id);
    results.push(r);
    if (r.stop) break;
  }
  return json(req, c, {
    ok: true,
    sent: results.filter((r) => r.state === 'sent' && !r.already).length,
    results,
  });
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req));
}
