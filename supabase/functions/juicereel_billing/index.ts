// ============================================================
//  FILE:    supabase/functions/juicereel_billing/index.ts
//  TYPE:    Edge Function (deployed) - EdgeDesk sold through Juice Reel
//  DEPLOY:  supabase functions deploy juicereel_billing --no-verify-jwt
//           The reader's token is verified HERE, against Supabase Auth, on
//           every reader action. The webhook is verified by its signature, and
//           the scheduled reconcile takes no identity (debounced in the
//           database), so the gateway setting decides nothing.
//  IMPORTS: NONE. One file (the dashboard deploy bundles one folder).
//  DOCS:    docs/juicereel-billing.md
//
//  SECRETS:
//    JUICE_REEL_CLIENT_ID       the OAuth application's client id (jr_…)
//    JUICE_REEL_CLIENT_SECRET   its client secret (jrs_…). Sent only in the
//                               HTTP Basic header to Juice Reel's server API
//    JUICE_REEL_WEBHOOK_SECRET  the signing secret of the SUBSCRIPTION_EVENTS
//                               webhook (X-Juice-Reel-Signature: sha256=<hex>)
//    JUICE_REEL_CHECKOUT        off (default) | operators | on
//                               off: nobody can start a Juice Reel checkout
//                               operators: only billing operators (the live test)
//                               on: every signed-in reader
//    JUICE_REEL_PRODUCT_IDS     optional: comma-separated Juice Reel subscription
//                               product ids that open EdgeDesk. Empty: every
//                               product the application's owner sells does
//    JUICE_REEL_BILLING_SCOPES  optional, default subscribers.read
//    JUICE_REEL_BILLING_REDIRECT_URI  optional, default
//                               <SITE_URL>/oauth/juicereel-subscribe.html
//    JUICE_REEL_API_URL         optional, default https://external-api.juicereel.com
//    SITE_URL                   optional, default https://edgedesksports.com
//    SB_URL / SB_SERVICE_ROLE (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
//    SUPABASE_ANON_KEY          to ask Auth who a reader's token belongs to
// ============================================================
//
// THE FLOW (Juice Reel's documented hosted checkout, and its example server,
// github.com/juiceintegration/oauth-setup-example):
//
//   reader ── start {kind:'checkout'} ──▶ here: state + PKCE (S256), the state's
//       SHA-256 stored against THIS reader (supabase/juicereel_billing.sql)
//   here ── POST /checkout/sessions (Basic id:secret, X-OAuth-Client-Id,
//       {successUrl, cancelUrl, scopes, state, codeChallenge}) ──▶ checkoutUrl
//   reader ──▶ Juice Reel: picks the plan, pays, then Juice Reel's consent screen
//   Juice Reel ──▶ oauth/juicereel-subscribe.html?status=success&code&state
//       (or ?status=cancelled&state — a cancelled checkout OR declined consent)
//   that page ── code, state → this tab's sessionStorage ──▶ the app
//   app ── complete {state, code} (the reader's token) ──▶ here:
//       the state must be THIS reader's, unused, unexpired;
//       POST /oauth2/token with the code, the SUCCESS URL as redirect_uri and
//       the verifier; GET /oauth2/me → the buyer's Juice Reel id; link it to
//       this reader; ask Juice Reel whether they are subscribed; write access.
//
//   start {kind:'link'} is the same without the purchase, for a reader who
//   bought EdgeDesk on Juice Reel's marketplace: Juice Reel's consent page,
//   then the same completion.
//
//   POST …/juicereel_billing/webhook — SUBSCRIPTION_PURCHASED, _RENEWED,
//   _CANCELLED, _EXPIRED, verified by HMAC-SHA256 over the raw body. Juice Reel
//   does not retry, so the scheduled reconcile (owner access to
//   /oauth2/subscribers/current) catches what a lost delivery missed.
//
// NOTHING SECRET IS KEPT. The PKCE verifier is derived here from the state and
// the client secret, so no verifier is stored; the buyer's access and refresh
// tokens are used for two reads and dropped. No token, code, verifier or
// secret is ever logged or returned.

const BUILD = 'juicereel_billing-2026-10-28-1';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function json(body, status) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-edgedesk-build': BUILD }, CORS),
  });
}

const AUTHORIZE_URL = 'https://www.juicereel.com/oauth2/authorize';
// where Juice Reel's checkout may send a buyer; anything else is refused
const CHECKOUT_HOST_RE = /^https:\/\/(www\.)?juicereel\.com\//;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ['off', 'operators', 'on'];
// Juice Reel said "subscribed" without saying until when: access for this
// long, renewed by every later confirmation (webhook, reconcile, recheck)
const PROVISIONAL_MS = 3 * 86400 * 1000;

function config() {
  const env = (k) => (typeof Deno !== 'undefined' && Deno.env.get(k)) || '';
  const site = (env('SITE_URL') || 'https://edgedesksports.com').replace(/\/+$/, '');
  const mode = (env('JUICE_REEL_CHECKOUT') || 'off').trim().toLowerCase();
  const list = (v) => String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return {
    url: env('SB_URL') || env('SUPABASE_URL'),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: env('SUPABASE_ANON_KEY') || env('SB_ANON_KEY'),
    clientId: env('JUICE_REEL_CLIENT_ID').trim(),
    clientSecret: env('JUICE_REEL_CLIENT_SECRET').trim(),
    webhookSecret: env('JUICE_REEL_WEBHOOK_SECRET').trim(),
    api: (env('JUICE_REEL_API_URL') || 'https://external-api.juicereel.com').replace(/\/+$/, ''),
    redirectUri: env('JUICE_REEL_BILLING_REDIRECT_URI') || site + '/oauth/juicereel-subscribe.html',
    scopes: (function () { const s = list(env('JUICE_REEL_BILLING_SCOPES') || 'subscribers.read'); return s.filter((x, i) => s.indexOf(x) === i); })(),
    productIds: list(env('JUICE_REEL_PRODUCT_IDS')),
    mode: MODES.indexOf(mode) >= 0 ? mode : 'off',
    modeRaw: mode,
    site,
  };
}
function missing(c) {
  const m = [];
  if (!c.url || !c.serviceKey) m.push('SB_URL / SB_SERVICE_ROLE');
  if (!c.anonKey) m.push('SUPABASE_ANON_KEY');
  if (!c.clientId) m.push('JUICE_REEL_CLIENT_ID');
  if (!c.clientSecret) m.push('JUICE_REEL_CLIENT_SECRET');
  if (!c.webhookSecret) m.push('JUICE_REEL_WEBHOOK_SECRET');
  if (!/^https:\/\//.test(c.redirectUri) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(c.redirectUri)) m.push('JUICE_REEL_BILLING_REDIRECT_URI (must be https)');
  if (MODES.indexOf(c.modeRaw) < 0) m.push('JUICE_REEL_CHECKOUT (off | operators | on; read as off)');
  return m;
}

// ── small pieces ────────────────────────────────────────────────────────────
const enc = new TextEncoder();
function b64url(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '', i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    s += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '');
  }
  return s;
}
function hex(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
async function sha256(text) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}
function sameText(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
// THE VERIFIER IS DERIVED, NEVER STORED: it is a function of the state (random,
// 32 bytes, held only in the browser and Juice Reel's redirect) and the client
// secret (held only here). 43 base64url characters, as RFC 7636 requires.
async function pkceFor(c, state) {
  const verifier = b64url(await hmac(c.clientSecret, 'edgedesk-juicereel-billing-pkce-v1:' + state));
  const challenge = b64url(await sha256(verifier));
  return { verifier, challenge };
}
function makeRef() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = randomBytes(6);
  let s = 'EDJ-';
  for (let i = 0; i < b.length; i++) s += A.charAt(b[i] % A.length);
  return s;
}
function iso(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function idText(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
  return null;
}
function shortText(v, n) { return typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null; }
function log(level, msg, extra) {
  // fixed words and codes only: no token, code, verifier, secret or email
  try { console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[juicereel_billing] ' + msg + (extra ? ' ' + JSON.stringify(extra) : '')); } catch (_) { /* never fail on a log */ }
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 10000) : null;
  try { return await fetch(url, Object.assign({}, init || {}, ctrl ? { signal: ctrl.signal } : {})); }
  finally { if (timer) clearTimeout(timer); }
}

// ── the database, over PostgREST with the service role ──────────────────────
function makeDb(c) {
  const base = String(c.url || '').replace(/\/+$/, '') + '/rest/v1/';
  const H = { apikey: c.serviceKey, authorization: 'Bearer ' + c.serviceKey, 'content-type': 'application/json' };
  return {
    rpc: async function (fn, args) {
      const r = await fetchWithTimeout(base + 'rpc/' + fn, { method: 'POST', headers: H, body: JSON.stringify(args || {}) }, 8000);
      const text = await r.text();
      if (!r.ok) { const e = new Error('db rpc ' + fn + ' ' + r.status + ' ' + text.slice(0, 200)); e.status = r.status; throw e; }
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) { return text; }
    },
  };
}

// The caller, verified by Supabase Auth; never decoded here.
async function getUser(c, req) {
  const authz = req.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  try {
    const r = await fetchWithTimeout(c.url.replace(/\/+$/, '') + '/auth/v1/user',
      { headers: { apikey: c.anonKey, authorization: authz } }, 6000);
    if (!r.ok) return null;
    const u = await r.json().catch(() => null);
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) return null;
    return { id: u.id.toLowerCase(), authz };
  } catch (_) { return null; }
}
// An operator, by the database's own rule (billing_is_admin), asked AS the reader.
async function isOperator(c, user) {
  if (!user) return false;
  try {
    const r = await fetchWithTimeout(c.url.replace(/\/+$/, '') + '/rest/v1/rpc/billing_is_admin',
      { method: 'POST', headers: { apikey: c.anonKey, authorization: user.authz, 'content-type': 'application/json' }, body: '{}' }, 6000);
    if (!r.ok) return false;
    return (await r.json().catch(() => false)) === true;
  } catch (_) { return false; }
}
function isServiceCaller(c, req) {
  const authz = req.headers.get('authorization') || '';
  const tok = authz.replace(/^Bearer\s+/i, '');
  return !!c.serviceKey && !!tok && sameText(tok, c.serviceKey);
}

// ── Juice Reel ──────────────────────────────────────────────────────────────
function basic(c) { return 'Basic ' + btoaText(c.clientId + ':' + c.clientSecret); }
function btoaText(s) {
  const bytes = enc.encode(s), A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '', i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}
async function jr(c, method, path, opts) {
  const o = opts || {};
  const h = { 'x-oauth-client-id': c.clientId, accept: 'application/json' };
  let body;
  if (o.bearer) h.authorization = 'Bearer ' + o.bearer; else h.authorization = basic(c);
  if (o.form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(o.form).toString(); }
  if (o.json) { h['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
  let url = c.api + path;
  if (o.query) { const q = new URLSearchParams(o.query).toString(); if (q) url += '?' + q; }
  let r;
  try { r = await fetchWithTimeout(url, { method, headers: h, body }, o.timeoutMs || 12000); }
  catch (_) { return { status: 0, body: null }; }
  const text = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  return { status: r.status, body: parsed };
}
function errWord(b) { return b && typeof b === 'object' && typeof b.error === 'string' ? b.error.toLowerCase().slice(0, 60) : ''; }

// WHAT JUICE REEL SAYS ABOUT A SUBSCRIPTION, from any of the places it says it:
// the subscriber-status answer, an entry of the current-subscriber list, or a
// webhook's data. The field names the docs give (subscriberUserId,
// subscriptionProductId, expiresDate) are read first; the shapes around them
// are not all confirmed (docs/juicereel-billing.md § 9), so this reads the
// plausible ones and FAILS CLOSED: access only on a positive "subscribed".
const ACTIVE_WORDS = ['active', 'subscribed', 'trialing', 'trial', 'current', 'paid', 'renewing'];
const CANCELLED_WORDS = ['cancelled', 'canceled', 'cancelling', 'canceling'];
const ENDED_WORDS = ['expired', 'ended', 'inactive', 'refunded', 'unsubscribed', 'none', 'lapsed', 'revoked'];
function first(o, keys) { for (const k of keys) { if (o[k] !== undefined && o[k] !== null) return o[k]; } return undefined; }
function subscriptionOf(raw, nowMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const nested = (k) => (raw[k] && typeof raw[k] === 'object' ? raw[k].id : undefined);
  const user = idText(first(raw, ['subscriberUserId', 'subscriber_user_id', 'userId', 'user_id']) ?? nested('subscriber') ?? nested('user'));
  const product = idText(first(raw, ['subscriptionProductId', 'subscription_product_id', 'productId', 'product_id']) ?? nested('subscriptionProduct') ?? nested('product'));
  const expires = iso(first(raw, ['expiresDate', 'expiresAt', 'expires_at', 'expirationDate', 'currentPeriodEnd', 'current_period_end', 'endDate']));
  const word = String(first(raw, ['status', 'subscriptionStatus', 'state']) || '').toLowerCase();
  const flag = first(raw, ['isSubscribed', 'subscribed', 'isActive', 'active']);
  let cancelled = CANCELLED_WORDS.indexOf(word) >= 0;
  const cflag = first(raw, ['cancelled', 'canceled', 'isCancelled', 'isCanceled', 'cancelAtPeriodEnd', 'cancel_at_period_end']);
  if (typeof cflag === 'boolean') cancelled = cancelled || cflag;
  if (raw.autoRenew === false || raw.auto_renew === false) cancelled = true;
  let active = null;
  if (typeof flag === 'boolean') active = flag;
  else if (ACTIVE_WORDS.indexOf(word) >= 0) active = true;
  else if (cancelled) active = expires ? Date.parse(expires) > nowMs : null;
  else if (ENDED_WORDS.indexOf(word) >= 0) active = false;
  else if (!word && expires && (user || product)) active = Date.parse(expires) > nowMs;   // a list entry: paid until its expiry
  if (user == null && product == null && expires == null && active == null) return null;
  return { jr_user_id: user, product_id: product, expires_at: expires, active, cancelled };
}
// Every subscription a status answer holds, best first (paid, latest expiry).
function subscriptionsIn(body, nowMs) {
  const out = [];
  const add = (x) => { const s = subscriptionOf(x, nowMs); if (s) out.push(s); };
  if (Array.isArray(body)) body.forEach(add);
  else if (body && typeof body === 'object') {
    ['subscription', 'data'].forEach((k) => { if (body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) add(body[k]); });
    ['subscriptions', 'data', 'items', 'results', 'subscribers'].forEach((k) => { if (Array.isArray(body[k])) body[k].forEach(add); });
    if (!out.length) add(body);
    // a top-level yes/no speaks for entries that do not say: "no" overrides
    // every entry (fail closed), "yes" fills in an entry that only has a date
    const top = first(body, ['isSubscribed', 'subscribed']);
    if (typeof top === 'boolean') out.forEach((s) => { if (!top) s.active = false; else if (s.active === null) s.active = true; });
  }
  return out.sort((a, b) => (b.active === true) - (a.active === true) || String(b.expires_at || '').localeCompare(String(a.expires_at || '')));
}
function productAllowed(c, s) {
  if (!c.productIds.length) return true;
  return !!(s && s.product_id && c.productIds.indexOf(s.product_id) >= 0);
}
// the state to record for a positive answer, or null (nothing positive to say)
function grantFrom(c, s, nowMs) {
  if (!s || s.active !== true || !productAllowed(c, s)) return null;
  if (s.expires_at && Date.parse(s.expires_at) <= nowMs) return null;
  return {
    active: true,
    expires_at: s.expires_at || new Date(nowMs + PROVISIONAL_MS).toISOString(),
    provisional: !s.expires_at,
    cancelled: !!s.cancelled,
    product_id: s.product_id,
  };
}
async function recordState(db, jrUser, g, source, asOf, eventId) {
  return db.rpc('billing_jr_record_state', {
    p_jr_user: jrUser, p_active: g.active, p_expires_at: g.expires_at, p_cancelled: !!g.cancelled,
    p_product: g.product_id || null, p_as_of: asOf || null, p_source: source, p_event_id: eventId || null,
    p_provisional: !!g.provisional,
  });
}

// The application owner's current subscribers, every page (owner access).
async function ownerSubscribers(c, nowMs, stopAt) {
  const out = [];
  let cursor = null;
  const seen = {};
  for (let page = 0; page < 50; page++) {
    const r = await jr(c, 'GET', '/oauth2/subscribers/current', { query: cursor ? { cursor } : {} });
    if (r.status === 401 || r.status === 403) return { ok: false, code: 'OWNER_ACCESS_REFUSED', status: r.status, list: out };
    if (r.status === 429) return { ok: false, code: 'RATE_LIMITED', status: 429, list: out };
    if (r.status < 200 || r.status >= 300 || !r.body) return { ok: false, code: r.status ? 'PLATFORM_DOWN' : 'UNREACHABLE', status: r.status, list: out };
    const items = Array.isArray(r.body) ? r.body
      : ['subscribers', 'data', 'items', 'results'].map((k) => r.body[k]).find(Array.isArray);
    if (!items) return { ok: false, code: 'JR_CONTRACT', status: r.status, list: out };
    for (const x of items) {
      const s = subscriptionOf(x, nowMs);
      if (s && s.jr_user_id) out.push(s);
      if (stopAt && s && s.jr_user_id === stopAt) return { ok: true, done: false, list: out };
    }
    const next = !Array.isArray(r.body) && typeof r.body.nextCursor === 'string' && r.body.nextCursor && r.body.hasMore !== false ? r.body.nextCursor : null;
    if (!next) return { ok: true, done: true, list: out };
    if (seen[next] || next.length > 2000) return { ok: false, code: 'JR_CONTRACT', list: out };
    seen[next] = true; cursor = next;
  }
  return { ok: true, done: false, list: out };
}

// ── reader actions ──────────────────────────────────────────────────────────
const MESSAGES = {
  off: 'Subscribing through Juice Reel is not open yet.',
  operators_only: 'Subscribing through Juice Reel is being tested and is not open to every account yet.',
  not_configured: 'Juice Reel checkout is not available right now. Nothing was charged.',
  already_entitled: 'This account already has full access. There is nothing to pay for.',
  rate_limited: 'Too many attempts in a few minutes. Wait a moment and try again.',
  JR_CLIENT_REFUSED: 'Juice Reel did not accept EdgeDesk\'s connection just now. Nothing was charged. Please try again later.',
  JR_CHECKOUT_REFUSED: 'Juice Reel could not open a checkout just now. Nothing was charged.',
  PLATFORM_DOWN: 'Juice Reel did not answer. Nothing was charged. Please try again in a moment.',
  JR_STATE_INVALID: 'This Juice Reel return could not be matched to a checkout started from this account. If you paid, use "I bought EdgeDesk on Juice Reel" to link your Juice Reel account. Do not pay again.',
  JR_CODE_INVALID: 'Juice Reel\'s sign-in code had expired or was already used. If you paid, use "I bought EdgeDesk on Juice Reel" to link your Juice Reel account. Do not pay again.',
  JR_ACCOUNT_IN_USE: 'That Juice Reel account already opens a different EdgeDesk account. Sign in to that account, or email support@edgedesksports.com to move it.',
  JR_CONTRACT: 'Juice Reel answered in a way EdgeDesk did not expect. Your payment is safe. Email support@edgedesksports.com with the reference below.',
};
function refuse(code, status, extra) {
  return json(Object.assign({ ok: false, reason: code, message: MESSAGES[code] || 'Something went wrong.' }, extra || {}), status);
}
async function availableTo(c, user) {
  if (c.mode === 'on') return true;
  if (c.mode === 'operators') return isOperator(c, user);
  return false;
}

async function actStatus(c, db, user) {
  const s = await db.rpc('billing_jr_status', { p_user: user.id });
  const ready = !missing(c).filter((m) => m.indexOf('WEBHOOK') < 0).length;
  const available = ready && await availableTo(c, user);
  return json(Object.assign({ ok: true, mode: c.mode, available }, s || {}));
}

async function actStart(c, db, user, body) {
  if (!(await availableTo(c, user))) return refuse(c.mode === 'operators' ? 'operators_only' : 'off', 403);
  if (!c.clientId || !c.clientSecret || !c.redirectUri) return refuse('not_configured', 503);
  const kind = body.kind === 'link' ? 'link' : 'checkout';
  if (kind === 'checkout') {
    const acc = await db.rpc('billing_access_for', { p_user: user.id, p_at: new Date().toISOString() });
    if (acc && acc.has_access) return refuse('already_entitled', 409);
  }
  const state = b64url(randomBytes(32));
  const stateHash = hex(await sha256(state));
  const p = await pkceFor(c, state);
  const opened = await db.rpc('billing_jr_session_open', { p_user: user.id, p_state_hash: stateHash, p_kind: kind, p_redirect_uri: c.redirectUri });
  if (!opened || !opened.ok) return refuse(opened && opened.reason === 'rate_limited' ? 'rate_limited' : 'not_configured', opened && opened.reason === 'rate_limited' ? 429 : 500);

  if (kind === 'link') {
    const u = new URL(AUTHORIZE_URL);
    u.search = new URLSearchParams({ client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code',
      response_mode: 'query', scope: c.scopes.join(' '), state, code_challenge: p.challenge, code_challenge_method: 'S256' }).toString();
    log('info', 'link started', { user: user.id });
    return json({ ok: true, kind, url: u.toString() });
  }

  // never retried: a POST that reached Juice Reel may have made a session
  const r = await jr(c, 'POST', '/checkout/sessions', { json: { successUrl: c.redirectUri, cancelUrl: c.redirectUri,
    scopes: c.scopes, state, codeChallenge: p.challenge } });
  const ref = makeRef();
  if (r.status === 401 || errWord(r.body) === 'invalid_client') { log('warn', 'checkout refused the client', { ref, status: r.status }); return refuse('JR_CLIENT_REFUSED', 502, { ref }); }
  if (r.status === 0 || r.status >= 500 || r.status === 429) { log('warn', 'checkout unreachable', { ref, status: r.status }); return refuse('PLATFORM_DOWN', 503, { ref, retryable: true }); }
  const b = r.body || {};
  if (r.status < 200 || r.status >= 300 || typeof b.checkoutUrl !== 'string') {
    // e.g. a success/cancel URL not registered, or a scope not approved
    log('warn', 'checkout not created', { ref, status: r.status, error: errWord(b) || shortText(b.message, 120) });
    return refuse('JR_CHECKOUT_REFUSED', 502, { ref });
  }
  if (!CHECKOUT_HOST_RE.test(b.checkoutUrl)) {
    log('error', 'checkout URL is not on juicereel.com; refused', { ref });
    return refuse('JR_CONTRACT', 502, { ref });
  }
  if (typeof b.checkoutSessionId === 'string') await db.rpc('billing_jr_session_attach', { p_state_hash: stateHash, p_checkout_session_id: b.checkoutSessionId });
  log('info', 'checkout started', { user: user.id });
  return json({ ok: true, kind, url: b.checkoutUrl, expires_at: iso(b.expiresAt) });
}

async function actComplete(c, db, user, body) {
  const state = typeof body.state === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(body.state) ? body.state : null;
  const code = typeof body.code === 'string' && body.code.length <= 2048 && !/\s/.test(body.code) ? body.code : null;
  const ref = makeRef();
  if (!state) return refuse('JR_STATE_INVALID', 400, { ref });
  const stateHash = hex(await sha256(state));
  const s = await db.rpc('billing_jr_session_consume', { p_user: user.id, p_state_hash: stateHash });
  if (!s || !s.ok) {
    log('warn', 'return refused', { ref, user: user.id, why: s && s.reason });
    const st = await db.rpc('billing_jr_status', { p_user: user.id }).catch(() => null);
    return refuse('JR_STATE_INVALID', 400, { ref, why: s && s.reason, access: st && st.access });
  }
  const kind = s.kind;
  // status=cancelled is BOTH a cancelled checkout and consent declined after
  // paying (Juice Reel's docs give one form for the two), so a cancelled
  // checkout is never told it was not charged
  if (!code || body.error) {
    await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: 'cancelled' });
    return json({ ok: true, kind, outcome: 'cancelled' });
  }

  const p = await pkceFor(c, state);
  const t = await jr(c, 'POST', '/oauth2/token', { form: { grant_type: 'authorization_code', code,
    redirect_uri: s.redirect_uri, code_verifier: p.verifier } });
  const word = errWord(t.body);
  if (t.status === 0 || t.status >= 500 || t.status === 429) {
    // the code may still be unused at Juice Reel: the same return may be tried again
    await db.rpc('billing_jr_session_release', { p_user: user.id, p_state_hash: stateHash });
    log('warn', 'token exchange unreachable', { ref, status: t.status });
    return refuse('PLATFORM_DOWN', 503, { ref, retryable: true });
  }
  if (t.status === 401 || word === 'invalid_client' || word === 'unauthorized_client') {
    await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: 'client_refused' });
    log('error', 'token exchange refused the client', { ref, status: t.status });
    return refuse('JR_CLIENT_REFUSED', 502, { ref });
  }
  const tb = t.body || {};
  if (t.status < 200 || t.status >= 300 || typeof tb.access_token !== 'string' || !tb.access_token) {
    await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: 'code_invalid' });
    log('warn', 'code refused', { ref, status: t.status, error: word });
    return refuse('JR_CODE_INVALID', 400, { ref });
  }
  const access = tb.access_token;

  const me = await jr(c, 'GET', '/oauth2/me', { bearer: access });
  const jrId = me.status >= 200 && me.status < 300 && me.body ? idText(me.body.id) : null;
  if (!jrId) {
    await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: 'me_failed' });
    log('error', 'GET /oauth2/me gave no id', { ref, status: me.status });
    return refuse(me.status === 0 || me.status >= 500 ? 'PLATFORM_DOWN' : 'JR_CONTRACT', 502, { ref });
  }
  const display = shortText(me.body.displayName, 60);
  const linked = await db.rpc('billing_jr_link', { p_user: user.id, p_jr_user: jrId, p_display: display });
  if (!linked || !linked.ok) {
    await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: 'account_in_use' });
    log('warn', 'Juice Reel account already linked elsewhere', { ref, user: user.id });
    return refuse('JR_ACCOUNT_IN_USE', 409, { ref });
  }

  // Is this buyer subscribed? Their own answer first (subscriber status, with
  // the token Juice Reel just issued), then the owner's list, then whatever a
  // webhook already said. Only a POSITIVE answer is written here: a "not yet"
  // a second after paying must not outrank the purchase event on its way.
  const nowMs = Date.now();
  let grant = null, how = null;
  if (c.scopes.indexOf('subscribers.read') >= 0) {
    const st = await jr(c, 'GET', '/oauth2/subscribers/status', { bearer: access });
    if (st.status >= 200 && st.status < 300 && st.body) {
      const best = subscriptionsIn(st.body, nowMs).find((x) => (!x.jr_user_id || x.jr_user_id === jrId) && grantFrom(c, x, nowMs));
      grant = best ? grantFrom(c, best, nowMs) : null;
      how = 'status';
    } else {
      log('info', 'subscriber status unavailable', { ref, status: st.status });
    }
  }
  if (!grant) {
    const o = await ownerSubscribers(c, nowMs, jrId);
    const mine = o.list.filter((x) => x.jr_user_id === jrId).map((x) => grantFrom(c, x, nowMs)).filter(Boolean)
      .sort((a, b) => String(b.expires_at).localeCompare(String(a.expires_at)))[0];
    if (mine) { grant = mine; how = 'owner_list'; }
    else if (!o.ok) log('info', 'owner list unavailable', { ref, code: o.code, status: o.status });
  }
  let rec = null;
  if (grant) rec = await recordState(db, jrId, grant, kind, null, null);
  else await db.rpc('billing_jr_project', { p_user: user.id });   // a webhook may already have said
  const after = await db.rpc('billing_jr_status', { p_user: user.id });
  const has = !!(after && after.access && after.access.has_access);
  const outcome = has ? 'active' : (grant ? 'other' : (kind === 'checkout' ? 'pending' : 'not_subscribed'));
  await db.rpc('billing_jr_session_finish', { p_state_hash: stateHash, p_outcome: outcome });
  log('info', 'return completed', { ref, user: user.id, kind, outcome, how, linked: linked.linked,
    projection: rec && rec.projection && rec.projection.reason });
  return json({ ok: true, kind, outcome, ref, display_name: display, linked: linked.linked,
    projection: rec && rec.projection ? rec.projection.reason : null, access: after && after.access });
}

// ── the webhook ─────────────────────────────────────────────────────────────
async function webhook(c, db, req) {
  const raw = await req.text();
  if (!c.webhookSecret) { log('error', 'webhook received but JUICE_REEL_WEBHOOK_SECRET is not set'); return json({ ok: false, reason: 'not_configured' }, 503); }
  const sig = String(req.headers.get('x-juice-reel-signature') || '').trim();
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(sig);
  const want = hex(await hmac(c.webhookSecret, raw));
  if (!m || !sameText(m[1].toLowerCase(), want)) { log('warn', 'webhook signature refused'); return json({ ok: false, reason: 'bad_signature' }, 401); }
  let ev;
  try { ev = JSON.parse(raw); } catch (_) { return json({ ok: false, reason: 'not_json' }, 400); }
  if (!ev || typeof ev !== 'object') return json({ ok: false, reason: 'not_json' }, 400);
  const type = String(first(ev, ['type', 'eventType', 'event', 'name']) || '').toUpperCase().slice(0, 80);
  const data = (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data)) ? ev.data
    : (ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload)) ? ev.payload : ev;
  const nowMs = Date.now();
  const s = subscriptionOf(data, nowMs) || {};
  const id = shortText(String(first(ev, ['id', 'eventId', 'event_id']) ?? ''), 200) || ('body:' + hex(await sha256(raw)));
  const at = iso(first(ev, ['createdAt', 'created_at', 'created', 'timestamp', 'occurredAt']) ?? first(data, ['eventDate', 'createdAt']));
  const rec = await db.rpc('billing_jr_record_event', { p_id: id, p_type: type, p_jr_user: s.jr_user_id || null, p_event_at: at, p_payload: ev });
  if (!rec || !rec.first) return json({ ok: true, duplicate: true });

  let outcome;
  if (['SUBSCRIPTION_PURCHASED', 'SUBSCRIPTION_RENEWED', 'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_EXPIRED'].indexOf(type) < 0) outcome = 'ignored_type';
  else if (!s.jr_user_id) outcome = 'no_subscriber';
  else if (!productAllowed(c, s)) outcome = 'product_not_sold_here';
  else {
    let g;
    if (type === 'SUBSCRIPTION_EXPIRED') g = { active: false, expires_at: s.expires_at || new Date(nowMs).toISOString(), cancelled: false, product_id: s.product_id };
    else if (type === 'SUBSCRIPTION_CANCELLED') g = { active: true, expires_at: s.expires_at, cancelled: true, product_id: s.product_id };
    else g = { active: true, expires_at: s.expires_at || new Date(nowMs + PROVISIONAL_MS).toISOString(), provisional: !s.expires_at, cancelled: false, product_id: s.product_id };
    const r = await recordState(db, s.jr_user_id, g, 'webhook', at, id);
    outcome = !r || !r.recorded ? 'not_recorded:' + (r && r.reason) : r.linked ? 'applied:' + ((r.projection && r.projection.reason) || '') : 'waiting_for_link';
  }
  await db.rpc('billing_jr_event_outcome', { p_id: id, p_outcome: outcome });
  log('info', 'webhook', { type, outcome });
  return json({ ok: true, outcome });
}

// ── the reconcile ───────────────────────────────────────────────────────────
async function reconcile(c, db, forced) {
  if (!c.clientId || !c.clientSecret) return json({ ok: false, reason: 'not_configured' });
  if (!forced) {
    const admitted = await db.rpc('billing_jr_reconcile_admit', { p_min_interval_s: 3000 });
    if (admitted !== true) return json({ ok: true, skipped: 'ran_recently' });
  }
  const nowMs = Date.now();
  const o = await ownerSubscribers(c, nowMs, null);
  let recorded = 0, granted = 0, absent = null;
  const seen = [];
  for (const s of o.list) {
    seen.push(s.jr_user_id);
    const g = grantFrom(c, s, nowMs);
    if (!g) continue;
    const r = await recordState(db, s.jr_user_id, g, 'reconcile', null, null);
    if (r && r.recorded) { recorded++; if (r.projection && r.projection.applied) granted++; }
  }
  if (o.ok && o.done) absent = await db.rpc('billing_jr_reconcile_absent', { p_seen: seen });
  const result = { ok: o.ok, code: o.code || null, read_to_end: !!(o.ok && o.done), listed: o.list.length, recorded, granted, absent_alerts: absent, at: new Date(nowMs).toISOString() };
  await db.rpc('billing_jr_reconcile_done', { p_result: result });
  log(o.ok ? 'info' : 'warn', 'reconcile', result);
  return json(result);
}

// The credentials, checked the way the code exchange will use them: a revoke
// of a random token EdgeDesk made (200 for any token with good client
// credentials, 401 invalid_client otherwise), then one page of the owner's
// subscriber list (does owner access reach it?). Nothing is stored.
async function check(c) {
  const out = { ok: true, mode: c.mode, missing: missing(c), redirect_uri: c.redirectUri, scopes: c.scopes,
    products: c.productIds.length || 'every product' };
  if (!c.clientId || !c.clientSecret) return json(Object.assign(out, { accepted: false, code: 'not_configured' }));
  const rv = await jr(c, 'POST', '/oauth2/revoke', { form: { token: b64url(randomBytes(32)), token_type_hint: 'access_token' } });
  out.accepted = rv.status >= 200 && rv.status < 300;
  out.revoke_status = rv.status;
  if (!out.accepted) out.code = rv.status === 0 || rv.status >= 500 ? 'PLATFORM_DOWN' : 'JR_CLIENT_REFUSED';
  const l = await jr(c, 'GET', '/oauth2/subscribers/current', {});
  out.owner_list = l.status >= 200 && l.status < 300 ? 'yes' : (l.status === 401 || l.status === 403 ? 'refused' : 'unavailable');
  out.owner_list_status = l.status;
  return json(out);
}

// ── the door ────────────────────────────────────────────────────────────────
async function handle(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const c = config();
  const url = new URL(req.url);
  if (req.method === 'GET') {
    // what a deploy probe and the setup workflow read: names and booleans only
    return json({ ok: true, mode: c.mode, configured: { client_id: !!c.clientId, client_secret: !!c.clientSecret,
      webhook_secret: !!c.webhookSecret, redirect_uri: c.redirectUri, scopes: c.scopes,
      products: c.productIds.length || 'every product' }, missing: missing(c), ready: missing(c).length === 0 });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);
  if (!c.url || !c.serviceKey) return refuse('not_configured', 503);
  const db = makeDb(c);
  try {
    if (/\/webhook\/?$/.test(url.pathname)) return await webhook(c, db, req);
    let body = {};
    try { body = await req.json(); } catch (_) { body = {}; }
    const action = body && typeof body.action === 'string' ? body.action : '';
    if (action === 'reconcile') {
      const svc = isServiceCaller(c, req);
      const forced = svc || (await isOperator(c, await getUser(c, req)));
      return await reconcile(c, db, forced);
    }
    if (action === 'check') {
      const allowed = isServiceCaller(c, req) || (await isOperator(c, await getUser(c, req)));
      if (!allowed) return json({ ok: false, reason: 'operators_only' }, 403);
      return await check(c);
    }
    const user = await getUser(c, req);
    if (!user) return json({ ok: false, reason: 'signed_out', message: 'Sign in to EdgeDesk first.' }, 401);
    if (action === 'status') return await actStatus(c, db, user);
    if (action === 'start') return await actStart(c, db, user, body);
    if (action === 'complete') return await actComplete(c, db, user, body);
    return json({ ok: false, reason: 'unknown_action' }, 400);
  } catch (e) {
    const ref = makeRef();
    log('error', 'failed', { ref, error: String(e && e.message || e).slice(0, 200) });
    return json({ ok: false, reason: 'error', ref, message: 'Something went wrong on EdgeDesk\'s side. Nothing was charged by this step. Reference ' + ref + '.' }, 500);
  }
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);
