// @ts-nocheck — plain JavaScript in a .ts file, as the billing functions are.
// ============================================================
//  FILE:    supabase/functions/sharpsports-webhook/index.ts
//  TYPE:    Edge Function - SharpSports BetSync webhook receiver
//  URL:     https://iattxbkbufslbauoumga.supabase.co/functions/v1/sharpsports-webhook
//           — the URL the five SharpSports subscriptions are registered at.
//           The function's NAME must stay exactly "sharpsports-webhook"
//           (hyphen): a different name is a different URL, and Supabase
//           answers an undeployed name with 404.
//  DEPLOY:  supabase functions deploy sharpsports-webhook --no-verify-jwt
//           SharpSports sends no Supabase JWT. With JWT verification on, the
//           gateway would answer 401 before this code runs.
//  IMPORTS: NONE. The connector core is copied in between its markers by
//           tools/portfolio/inline_connect_core.js (drift fails
//           tools/portfolio/connect_core.test.js).
//
//  RETIRED 2026-10-14 (cost; docs/sportsbook-sync-providers.md). While
//  SPORTSBOOK_SYNC_PROVIDER is not 'sharpsports' (unset is the default) every
//  POST is answered 200 {ignored:'sync_off'} at once: nothing is read,
//  recorded or synced. The function stays deployed so the five registered
//  subscriptions get a clean 200 until they are deleted in the SharpSports
//  dashboard; after that it can be left or undeployed.
//
//  SECRETS:
//    SB_URL / SB_SERVICE_ROLE (or SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
//    SPORTSBOOK_SYNC_PROVIDER         must be exactly 'sharpsports' for any
//                                     delivery to be read (shared with
//                                     portfolio_connect)
//    SHARPSPORTS_ENV                  'sandbox' (default) or 'production' —
//                                     which environment's deliveries these are
//    SHARPSPORTS_WEBHOOK_SECRETS      JSON {"<subscription id>": "<hmac_secret>"}
//                                     — each subscription's own secret, from the
//                                     SharpSports dashboard (Settings → Webhooks)
//                                     or the subscription object (hmac_secret)
//    SHARPSPORTS_WEBHOOK_VERIFY       'observe' (default) or 'required'
//    SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER  optional: the one header to read
//                                     the signature from, once it is known
// ============================================================
//
// THE TRUST RULE. A delivery is a HINT, never data. It names what changed
// (a linked account, a bettor); this function records it once and makes
// those accounts due, and portfolio_connect re-reads them from SharpSports'
// API with EdgeDesk's own key. Nothing in a payload is ever written onto an
// account or a position. So a forged delivery can at most cause EdgeDesk to
// re-read an account it already holds (at most once a minute per account).
//
// SIGNATURES. SharpSports signs every post with HMAC-SHA256 under the
// subscription's hmac_secret and names the subscription in the
// Hook-Subscription header (documented). The documentation page giving the
// signature's header name and exact signed string could not be read from the
// build environment, so a post counts as signed when any header carries the
// HMAC of the raw body (hex or base64, "sha256=" allowed) under the
// subscription's secret. The header found is recorded with the delivery.
//   observe   unsigned posts are still applied as hints (never as data) and
//             recorded as FETCH_BACK; signed ones as SIGNATURE. Use it until
//             a genuine sandbox delivery shows SIGNATURE in the operator panel.
//   required  a post without a valid signature is refused with 401 and only
//             counted. Switch to it once that has been seen; pin the header.
//
// RESPONSES (SharpSports expects 200 within 10 seconds):
//   200  recorded (applied, a duplicate, or naming nothing EdgeDesk holds);
//        or ignored, unread, while SharpSports is not the active provider
//   400  not JSON          401  signature required and missing or wrong
//   405  not POST          413  body over 256 KB
//   500  recorded but could not be applied (SharpSports' retry re-applies it)
//   503  the database could not be reached (nothing recorded; retry)
//   GET  health: build and what is configured, never a value

const BUILD = 'sharpsports-webhook-2026-10-14-2';
const MAX_BODY = 262144;

function json(body, status) {
  return new Response(JSON.stringify(Object.assign({ build: BUILD }, body)), {
    status: status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-edgedesk-build': BUILD } });
}
function config() {
  const env = (k) => Deno.env.get(k) || '';
  let secrets = {};
  try {
    const raw = JSON.parse(env('SHARPSPORTS_WEBHOOK_SECRETS') || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      Object.keys(raw).forEach((k) => { if (typeof raw[k] === 'string' && raw[k].length >= 8) secrets[String(k).toLowerCase()] = raw[k]; });
    }
  } catch (_) { secrets = {}; }
  return {
    url: (env('SB_URL') || env('SUPABASE_URL')).replace(/\/+$/, ''),
    serviceKey: env('SB_SERVICE_ROLE') || env('SUPABASE_SERVICE_ROLE_KEY'),
    active: env('SPORTSBOOK_SYNC_PROVIDER').trim().toLowerCase() === 'sharpsports',
    env: env('SHARPSPORTS_ENV').trim().toLowerCase() === 'production' ? 'production' : 'sandbox',
    secrets,
    verify: env('SHARPSPORTS_WEBHOOK_VERIFY').trim().toLowerCase() === 'required' ? 'required' : 'observe',
    pinned: env('SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER').trim().toLowerCase() || null,
  };
}

// ── BEGIN CONNECT CORE ──────────────────────────────────────────────────
// Canonical source: lib/edgedesk_portfolio_connect_core.js, copied VERBATIM by
// tools/portfolio/inline_connect_core.js. Edit the canonical file, then run it.
/* ===========================================================================
   EDGEDESK PORTFOLIO — the connector core.
   docs/platform-connections.md · docs/portfolio-architecture.md § Connectors

   SOURCE → SOURCE ADAPTER → NORMALIZER → accounts / positions / transactions
   → reconciliation → Portfolio. This file is the adapter and normalizer half,
   pure and testable: it never touches a database, a DOM or storage, and it
   never logs. The edge function supabase/functions/portfolio_connect carries a
   verbatim copy between its BEGIN / END CONNECT CORE markers
   (tools/portfolio/inline_connect_core.js; the test fails on drift).

   WHAT IS HERE
     1. exact fixed-point arithmetic (6 decimal places, BigInt) for the few
        amounts a normalizer must split or convert — never a float;
     2. the PLATFORM REGISTRY: what each platform genuinely offers, how it was
        verified and when, and what still needs legal / terms review. Nothing
        here is "enabled": the runtime switch lives in the database
        (portfolio_platform_registry) and can only be thrown after a recorded
        live smoke test (supabase/portfolio_connect.sql);
     3. the ADAPTER CONTRACT every source implements (13 methods);
     4. the CREDENTIAL VAULT: AES-256-GCM sealing bound to the account, for
        server use only; redaction for anything that might be logged;
     5. KALSHI: request signing (RSA-PSS SHA-256 or Ed25519 over
        timestamp + METHOD + path), read-only scope check, and the net-position
        replay that turns Kalshi's fills into YES / NO positions with buys and
        sells — fills reconstruct positions; they never become fake bets;
     6. POLYMARKET: a public wallet's trades, positions, fees and resolutions;
     7. RECONCILIATION: our derived holdings against the platform's own;
    10. SHARPSPORTS BETSYNC: sportsbook history through an approved
        aggregator — the linking context, discovery of the reader's linked
        books, refresh requests, the bet-slip normalizer (singles, parlays,
        teasers, round robins, pushes, voids, cash-outs) and the webhook's
        hint extraction and signature check. The reader links on
        SharpSports' own page; EdgeDesk reads SharpSports server-side.
        RETIRED 2026-10-14 (cost): registered below, active on no server;
    11. SPORTSBOOK SYNC PROVIDERS: the registry every sportsbook provider
        joins (link, discover, sync, refresh, account state, webhook hints,
        normalize). The server switches at most one on
        (SPORTSBOOK_SYNC_PROVIDER); none is the default.

   WHAT IS NOT HERE: anything that asks for a sportsbook password, scrapes a
   site, bypasses MFA / CAPTCHA / geolocation, or places, cancels or changes
   an order. EdgeDesk is read-only.

   Browser / Deno: self.EDPortfolioConnect.   Node: require('./edgedesk_portfolio_connect_core.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDPortfolioConnect = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'portfolio_connect_core_v1';

  /* ═══ 1. EXACT FIXED-POINT (micro-units) ══════════════════════════════ */
  var SCALE = 1000000n;
  function toMicro(x) {
    if (x == null || x === '') return null;
    var s = String(x).trim();
    var m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === '' && (m[3] == null || m[3] === ''))) return null;
    var frac = (m[3] || '');
    var keep = frac.slice(0, 6).padEnd(6, '0'), rest = frac.slice(6);
    var v = BigInt(m[2] || '0') * SCALE + BigInt(keep);
    /* round half away from zero at the 7th place */
    if (rest && rest.charCodeAt(0) >= 53) v += 1n;
    return m[1] === '-' ? -v : v;
  }
  function fromMicro(v) {
    if (v == null) return null;
    var neg = v < 0n, a = neg ? -v : v, i = a / SCALE, f = String(a % SCALE).padStart(6, '0').replace(/0+$/, '');
    return (neg && (i > 0n || f) ? '-' : '') + String(i) + (f ? '.' + f : '');
  }
  /* a × b / c, rounded half away from zero */
  function mulDiv(a, b, c) {
    if (c === 0n) return null;
    var n = a * b, neg = (n < 0n) !== (c < 0n), an = n < 0n ? -n : n, ac = c < 0n ? -c : c;
    var q = an / ac, r = an % ac;
    if (r * 2n >= ac) q += 1n;
    return neg ? -q : q;
  }
  var dec = {
    micro: toMicro, str: fromMicro,
    add: function (a, b) { return fromMicro(toMicro(a) + toMicro(b)); },
    sub: function (a, b) { return fromMicro(toMicro(a) - toMicro(b)); },
    mul: function (a, b) { return fromMicro(mulDiv(toMicro(a), toMicro(b), SCALE)); },
    div: function (a, b) { return fromMicro(mulDiv(toMicro(a), SCALE, toMicro(b))); },
    cmp: function (a, b) { var x = toMicro(a), y = toMicro(b); return x < y ? -1 : x > y ? 1 : 0; },
    cents: function (c) { var v = toMicro(c); return v == null ? null : fromMicro(mulDiv(v, 1n, 100n)); }
  };

  /* ═══ 2. THE PLATFORM REGISTRY ════════════════════════════════════════ */
  /* source types and ingestion methods are separate axes (a sportsbook can be
     imported; a prediction market can be connected by key or by wallet) */
  var SOURCE_TYPES = ['SPORTSBOOK', 'PREDICTION_MARKET', 'MANUAL'];
  var INGESTION_METHODS = ['OAUTH', 'API_KEY', 'PUBLIC_WALLET', 'AUTHORIZED_API', 'FILE_IMPORT', 'MANUAL'];
  var TIER = { OAUTH: 1, AUTHORIZED_API: 1, API_KEY: 2, PUBLIC_WALLET: 2, FILE_IMPORT: 3, MANUAL: 4 };
  var TIER_LABEL = { 1: 'Automatic', 2: 'Automatic (assisted)', 3: 'Quick import', 4: 'Manual' };
  /* the live smoke test a connector passes, in order, before it can be enabled */
  var SMOKE_STAGES = ['CONNECT', 'IMPORT', 'VERIFY', 'INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'DISCONNECT', 'RECONNECT', 'NO_DUPLICATES'];
  /* An automatic method is listed only where the platform documents one that
     a retail account can use. "verified" says how: from the platform's own
     published client source, because the documentation sites could not be
     reached from the build environment — re-read the live documentation and
     terms before production (docs/platform-connections.md). */
  var REGISTRY = [
    { key: 'kalshi', label: 'Kalshi', source_type: 'PREDICTION_MARKET',
      automatic: { method: 'API_KEY', connector: 'kalshi', connector_version: 'kalshi_v1', read_only: true,
        what_the_reader_gives: 'An API key id and its private key, created in Kalshi with read access only. EdgeDesk refuses a key that can trade.',
        verified: { on: '2026-10-04', from: 'Kalshi\'s published API client source (trade-api v2)', docs: 'https://docs.kalshi.com',
          facts: ['RSA-PSS (SHA-256) or Ed25519 signature over timestamp + METHOD + path, in KALSHI-ACCESS-KEY / -SIGNATURE / -TIMESTAMP headers',
            'GET /api_keys returns each key\'s scopes, so a key that can trade can be refused',
            'GET /portfolio/fills (cursor, limit ≤ 500), GET /historical/fills before GET /historical/cutoff',
            'GET /portfolio/settlements, GET /portfolio/positions, GET /markets/{ticker}, GET /events/{event_ticker}',
            'HTTP 429 when rate limited'] },
        tos_review: ['Kalshi Developer / API terms: storing a customer\'s read-only key on their behalf for portfolio analytics',
          'Rate limits for a background sync across many customers',
          'Whether partner OAuth (registered partners only) should replace customer keys before scale'] },
      import: { profile: 'kalshi_csv', verified: false } },
    { key: 'polymarket', label: 'Polymarket', source_type: 'PREDICTION_MARKET',
      automatic: { method: 'PUBLIC_WALLET', connector: 'polymarket', connector_version: 'polymarket_v1', read_only: true,
        what_the_reader_gives: 'The public address of the wallet they trade from. Never a seed phrase, private key or password.',
        verified: { on: '2026-10-04', from: 'Polymarket\'s published client source (data API v2, gamma public profile)', docs: 'https://docs.polymarket.com',
          facts: ['GET data-api /v2/activity?user= (TRADE, REDEEM; cursor; limit ≤ 1000; start=1 for full history)',
            'GET data-api /v2/positions?user=&status=OPEN|REDEEMABLE|REDEEMABLE_LOST|MERGEABLE|CLOSED',
            'GET gamma /public-profile?address= returns the proxy wallet',
            'No credential: public on-chain activity; HTTP 429 with Retry-After'] },
        tos_review: ['Polymarket terms for third-party display of a user\'s public activity',
          'Regional availability: a US reader\'s exchange account may differ from the international wallet product'] },
      import: { profile: 'polymarket_csv', verified: false } },
    { key: 'draftkings', label: 'DraftKings', source_type: 'SPORTSBOOK', automatic: null, import: { profile: 'draftkings', verified: false } },
    { key: 'fanduel', label: 'FanDuel', source_type: 'SPORTSBOOK', automatic: null, import: { profile: 'fanduel', verified: false } },
    { key: 'betmgm', label: 'BetMGM', source_type: 'SPORTSBOOK', automatic: null, import: { profile: 'betmgm', verified: false } },
    { key: 'williamhill_us', label: 'Caesars', source_type: 'SPORTSBOOK', automatic: null, import: { profile: 'caesars', verified: false } },
    { key: 'bet365', label: 'bet365', source_type: 'SPORTSBOOK', automatic: null, import: { profile: 'bet365', verified: false } }
  ];
  /* why no sportsbook connects automatically: stated once, used by the UI */
  var NO_SPORTSBOOK_API = 'No US sportsbook offers customers an API or authorized connection for their bet history. EdgeDesk imports a file you download, '
    + 'or you record bets by hand — it never asks for your sportsbook password.';
  var BY_KEY = {};
  REGISTRY.forEach(function (p) { BY_KEY[p.key] = p; });
  function platformInfo(key) { return BY_KEY[key] || null; }
  /* what the UI may say about a platform, given the database's runtime switch */
  function connectionOffer(key, runtime) {
    var p = BY_KEY[key], rt = runtime || {};
    if (!p) return { kind: 'MANUAL', label: 'Record by hand or import a file', tier: 4 };
    if (p.automatic && rt.automatic_enabled === true) return { kind: 'AUTOMATIC', method: p.automatic.method, label: 'Connect', tier: TIER[p.automatic.method] };
    if (p.automatic) return { kind: 'IMPORT', label: 'Import', tier: 3, automatic_pending: true,
      note: p.label + ' supports a read-only connection; EdgeDesk turns it on after a live end-to-end test. Until then, import a file or record by hand.' };
    return { kind: 'IMPORT', label: 'Import', tier: 3, note: NO_SPORTSBOOK_API };
  }

  /* ═══ 3. THE ADAPTER CONTRACT ═════════════════════════════════════════ */
  var CONTRACT = ['describe', 'validateCredential', 'connect', 'disconnect', 'healthCheck', 'initialSync', 'incrementalSync',
    'fetchAccount', 'fetchPositions', 'fetchTransactions', 'fetchSettlements', 'normalize', 'reconcile'];
  function defineAdapter(spec) {
    var missing = CONTRACT.filter(function (m) { return !spec || typeof spec[m] !== 'function'; });
    if (!spec || !BY_KEY[spec.key]) missing.push('key (a registered platform)');
    if (!spec || INGESTION_METHODS.indexOf(spec.method) < 0) missing.push('method');
    if (spec && spec.places_orders) missing.push('read-only (an adapter never trades)');
    if (missing.length) throw new Error('portfolio adapter "' + (spec && spec.key) + '" is incomplete: ' + missing.join(', '));
    return Object.freeze(Object.assign({}, spec));
  }
  /* errors a reader may see: a code and a plain sentence, never a secret,
     a raw response body or a stack */
  var ERRORS = {
    BAD_CREDENTIAL: 'The platform rejected the key. Check the key id and the private key, then connect again.',
    WRITE_SCOPE: 'This key can place or cancel orders. EdgeDesk only accepts a read-only key — create one with read access and connect with that.',
    SCOPE_UNKNOWN: 'EdgeDesk could not confirm the key is read-only, so it was not stored.',
    BAD_WALLET: 'That is not a wallet address (0x followed by 40 hexadecimal characters).',
    SECRET_PASTED: 'That looks like a seed phrase or a private key. Never share those — EdgeDesk only needs your public wallet address.',
    RATE_LIMITED: 'The platform asked EdgeDesk to slow down. The sync resumes automatically.',
    PLATFORM_DOWN: 'The platform did not answer. The sync retries automatically.',
    DISABLED: 'Automatic connection for this platform is not switched on yet. Import a file or record by hand.',
    SYNC_OFF: 'Automatic sportsbook sync is switched off. Import a file or a screenshot, or record bets by hand; your history is kept.',
    TIMEOUT: 'This history is larger than one sync can read in time. EdgeDesk retries automatically; a very long history may need a file import first.',
    MALFORMED: 'Some records from the platform could not be read; they are listed with the sync and were not guessed at.',
    /* an aggregator's link (SharpSports BetSync) */
    RELINK_REQUIRED: 'SharpSports can no longer sign in to this sportsbook account (a changed password, a verification the book asked for, or an expired link). '
      + 'Reconnect it to resume syncing; your history is kept.',
    BOOK_INACCESSIBLE: 'SharpSports no longer has access to this sportsbook account, so nothing new can be read. Reconnect it to resume syncing; your history is kept.',
    PROVIDER_AUTH: 'EdgeDesk\'s own connection to SharpSports was refused. This is on EdgeDesk\'s side; syncing resumes automatically once it is fixed.',
    PROVIDER_NOT_FOUND: 'SharpSports did not recognise this linked account. If this repeats, reconnect it.',
    PROVIDER_CONTRACT: 'SharpSports answered in a form EdgeDesk does not recognise, so nothing was stored. EdgeDesk retries automatically.',
    NOT_CONFIGURED: 'Sportsbook linking is not configured on this server yet.',
    ENV_MISMATCH: 'This account was linked in a different SharpSports environment (test or live) from the one this server reads, so it is not synced here.',
    UNKNOWN: 'Something went wrong. Nothing was changed.'
  };
  function readerError(code) { return { code: ERRORS[code] ? code : 'UNKNOWN', message: ERRORS[code] || ERRORS.UNKNOWN }; }
  /* anything about to be logged passes through this: secrets become [redacted] */
  var SECRET_KEYS = /^(private_?key|secret|password|passphrase|seed|mnemonic|token|access_token|refresh_token|authorization|signature|kalshi-access-signature|ciphertext|plaintext|cookie)$/i;
  var SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b|\b0x[0-9a-fA-F]{64}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
  function redact(x, depth) {
    depth = depth || 0;
    if (depth > 6) return '[deep]';
    if (x == null || typeof x === 'number' || typeof x === 'boolean') return x;
    if (typeof x === 'string') return x.replace(SECRET_TEXT, '[redacted]');
    if (Array.isArray(x)) return x.map(function (v) { return redact(v, depth + 1); });
    if (typeof x === 'object') {
      var o = {};
      Object.keys(x).forEach(function (k) { o[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x[k], depth + 1); });
      return o;
    }
    return '[' + typeof x + ']';
  }

  /* ═══ 4. THE CREDENTIAL VAULT (server only) ═══════════════════════════ */
  function cryptoApi() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error('WebCrypto is required');
    return c;
  }
  var enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var decd = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  function b64(bytes) {
    var s = ''; bytes = new Uint8Array(bytes);
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
  }
  function unb64(s) {
    var bin = typeof atob === 'function' ? atob(String(s)) : Buffer.from(String(s), 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  /* the associated data binds a ciphertext to one reader's one account: a
     sealed credential copied onto another account cannot be opened */
  function aadFor(userId, accountId, kind) { return enc.encode(['edgedesk-portfolio-credential-v1', userId, accountId, kind].join('|')); }
  async function vaultKey(keyB64, usage) {
    var raw = unb64(keyB64);
    if (raw.length !== 32) throw new Error('the credential key must be 32 bytes (base64)');
    return cryptoApi().subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
  }
  async function sealCredential(secret, o) {
    var key = await vaultKey(o.keyB64, 'encrypt'), nonce = cryptoApi().getRandomValues(new Uint8Array(12));
    var ct = await cryptoApi().subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aadFor(o.userId, o.accountId, o.kind) }, key, enc.encode(JSON.stringify(secret)));
    return { ciphertext_b64: b64(ct), nonce_b64: b64(nonce), key_version: o.keyVersion, credential_kind: o.kind };
  }
  async function openCredential(row, o) {
    var key = await vaultKey(o.keyB64, 'decrypt');
    var pt = await cryptoApi().subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.nonce_b64), additionalData: aadFor(o.userId, o.accountId, row.credential_kind) }, key, unb64(row.ciphertext_b64));
    return JSON.parse(decd.decode(pt));
  }
  /* a hint a reader can recognise their key by, never enough to use it */
  function keyHint(id) { var s = String(id || '').replace(/[^A-Za-z0-9]/g, ''); return s.length >= 8 ? '…' + s.slice(-4) : null; }

  /* ═══ 5. KALSHI ═══════════════════════════════════════════════════════ */
  var KALSHI = {
    base: 'https://external-api.kalshi.com/trade-api/v2',
    pathPrefix: '/trade-api/v2',
    pageLimit: 500,
    maxPages: 400
  };
  /* the string Kalshi signs: milliseconds + METHOD + the path, without the query */
  function kalshiSigningString(tsMs, method, path) {
    var p = String(path).split('?')[0];
    if (p.indexOf(KALSHI.pathPrefix) !== 0) p = KALSHI.pathPrefix + (p.charAt(0) === '/' ? '' : '/') + p;
    return String(tsMs) + String(method).toUpperCase() + p;
  }
  /* PEM → DER; a PKCS#1 RSA key (BEGIN RSA PRIVATE KEY) is wrapped into
     PKCS#8, the only form WebCrypto imports */
  function pemBody(pem) {
    var m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(String(pem || ''));
    if (!m) return null;
    return { label: m[1], der: unb64(m[2].replace(/[^A-Za-z0-9+/=]/g, '')) };
  }
  function derLen(n) {
    if (n < 128) return [n];
    var out = []; while (n > 0) { out.unshift(n & 255); n >>= 8; }
    return [0x80 | out.length].concat(out);
  }
  function pkcs1ToPkcs8(der) {
    var algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    var octet = [0x04].concat(derLen(der.length));
    var inner = [0x02, 0x01, 0x00].concat(algo, octet);
    var total = inner.length + der.length;
    var head = [0x30].concat(derLen(total), inner);
    var out = new Uint8Array(head.length + der.length);
    out.set(head, 0); out.set(der, head.length);
    return out;
  }
  async function kalshiSigner(keyId, privatePem) {
    var body = pemBody(privatePem);
    if (!keyId || !/^[A-Za-z0-9-]{8,80}$/.test(String(keyId))) throw Object.assign(new Error('bad key id'), { code: 'BAD_CREDENTIAL' });
    if (!body || !/PRIVATE KEY$/.test(body.label)) throw Object.assign(new Error('bad private key'), { code: 'BAD_CREDENTIAL' });
    var subtle = cryptoApi().subtle, key, algo;
    try {
      if (body.label === 'RSA PRIVATE KEY') {
        key = await subtle.importKey('pkcs8', pkcs1ToPkcs8(body.der), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
        algo = { name: 'RSA-PSS', saltLength: 32 };
      } else {
        try {
          key = await subtle.importKey('pkcs8', body.der, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
          algo = { name: 'RSA-PSS', saltLength: 32 };
        } catch (_) {
          key = await subtle.importKey('pkcs8', body.der, { name: 'Ed25519' }, false, ['sign']);
          algo = { name: 'Ed25519' };
        }
      }
    } catch (e) { throw Object.assign(new Error('the private key could not be read'), { code: 'BAD_CREDENTIAL' }); }
    return {
      keyId: String(keyId),
      headers: async function (method, path, nowMs) {
        var ts = String(nowMs == null ? Date.now() : nowMs);
        var sig = await subtle.sign(algo, key, enc.encode(kalshiSigningString(ts, method, path)));
        return { 'KALSHI-ACCESS-KEY': String(keyId), 'KALSHI-ACCESS-SIGNATURE': b64(sig), 'KALSHI-ACCESS-TIMESTAMP': ts };
      }
    };
  }
  /* a key that can do anything but read is refused before it is stored */
  function kalshiScopeVerdict(apiKeysResponse, keyId) {
    var list = (apiKeysResponse && (apiKeysResponse.api_keys || apiKeysResponse.keys)) || [];
    var mine = list.filter(function (k) { return String(k.api_key_id || k.id || '') === String(keyId); })[0];
    if (!mine || !Array.isArray(mine.scopes)) return { ok: false, code: 'SCOPE_UNKNOWN' };
    var scopes = mine.scopes.map(function (s) { return String(s).toLowerCase(); });
    if (!scopes.length) return { ok: false, code: 'SCOPE_UNKNOWN' };
    var other = scopes.filter(function (s) { return s !== 'read' && !/^read(::|:)/.test(s); });
    if (other.length) return { ok: false, code: 'WRITE_SCOPE', scopes: scopes };
    return { ok: true, scopes: scopes };
  }
  function kalshiQuery(path, q) {
    var parts = [];
    Object.keys(q || {}).forEach(function (k) { if (q[k] != null && q[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))); });
    return path + (parts.length ? '?' + parts.join('&') : '');
  }
  function iso(x) {
    if (x == null || x === '') return null;
    if (typeof x === 'number' || /^\d+$/.test(String(x))) { var n = Number(x); var t = n > 1e12 ? n : n * 1000; var d = new Date(t); return isFinite(d.getTime()) ? d.toISOString() : null; }
    var p = Date.parse(String(x)); return isFinite(p) ? new Date(p).toISOString() : null;
  }
  /* one Kalshi fill, either schema, → { dir: +1 YES exposure up / -1 down, q, yes, no, fee, at } */
  function kalshiFillParts(f) {
    var q = f.count_fp != null ? String(f.count_fp) : (f.count != null ? String(f.count) : null);
    var yes = f.yes_price_dollars != null ? String(f.yes_price_dollars) : (f.yes_price != null ? dec.cents(f.yes_price) : null);
    var no = f.no_price_dollars != null ? String(f.no_price_dollars) : (f.no_price != null ? dec.cents(f.no_price) : null);
    var dir = null;
    if (f.outcome_side) dir = String(f.outcome_side).toLowerCase() === 'yes' ? 1 : String(f.outcome_side).toLowerCase() === 'no' ? -1 : null;
    else if (f.side && f.action) {
      var s = String(f.side).toLowerCase(), a = String(f.action).toLowerCase();
      if ((s === 'yes' || s === 'no') && (a === 'buy' || a === 'sell')) dir = ((s === 'yes') === (a === 'buy')) ? 1 : -1;
    }
    if (yes == null && no != null) yes = dec.sub('1', no);
    if (no == null && yes != null) no = dec.sub('1', yes);
    var fee = f.fee_cost != null ? String(f.fee_cost) : (f.fee_cost_dollars != null ? String(f.fee_cost_dollars) : '0');
    /* one spelling per amount ("0.4000" and "0.40" are the same price) */
    var canon = function (x) { var v = toMicro(x); return v == null ? null : fromMicro(v); };
    return { id: f.fill_id || f.trade_id || null, ticker: f.ticker || f.market_ticker || null, dir: dir, q: canon(q), yes: canon(yes), no: canon(no),
      fee: canon(fee) == null ? null : canon(fee), at: iso(f.created_time || f.ts) };
  }
  function bad(code, ref, message) { return { code: code, ref: ref == null ? null : String(ref).slice(0, 120), message: message }; }
  /* THE NET-POSITION REPLAY. Kalshi nets a market: holding NO and buying YES
     closes NO first. EdgeDesk keeps YES and NO as positions with buys and
     sells, so each fill is split at zero: the part that closes the other side
     is a SELL of that side (at its price, 1 − the YES price), the rest is a
     BUY of this side. The fee is shared in proportion. `start` carries each
     ticker's signed YES holding from earlier syncs. */
  function kalshiReplay(fills, start) {
    var net = Object.assign({}, start || {}), out = [], issues = [];
    var parts = (fills || []).map(kalshiFillParts);
    parts.forEach(function (p, i) {
      var ok = p.id && p.ticker && p.dir && p.q && p.yes != null && p.at && dec.micro(p.q) > 0n
        && dec.micro(p.yes) >= 0n && dec.micro(p.yes) <= SCALE && p.fee != null && dec.micro(p.fee) >= 0n;
      if (!ok) { issues.push(bad('MALFORMED_FILL', p.id || ('#' + i), 'A Kalshi fill was missing its id, market, direction, size, price or time.')); p.skip = true; }
    });
    parts = parts.filter(function (p) { return !p.skip; }).sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var seen = {};
    parts.forEach(function (p) {
      if (seen[p.id]) return; seen[p.id] = 1;
      var n = dec.micro(net[p.ticker] || '0'), q = dec.micro(p.q), fee = dec.micro(p.fee);
      var against = p.dir > 0 ? (n < 0n ? -n : 0n) : (n > 0n ? n : 0n);
      var close = against < q ? against : q, open = q - close;
      var closeFee = close > 0n ? mulDiv(fee, close, q) : 0n, openFee = fee - closeFee;
      var thisSide = p.dir > 0 ? 'YES' : 'NO', otherSide = p.dir > 0 ? 'NO' : 'YES';
      var priceOf = function (side) { return side === 'YES' ? p.yes : p.no; };
      if (close > 0n) out.push({ ticker: p.ticker, side: otherSide, action: 'SELL', quantity: fromMicro(close), price: priceOf(otherSide), fee: fromMicro(closeFee), executed_at: p.at, external_transaction_id: 'kalshi:' + p.id + ':c' });
      if (open > 0n) out.push({ ticker: p.ticker, side: thisSide, action: 'BUY', quantity: fromMicro(open), price: priceOf(thisSide), fee: fromMicro(openFee), executed_at: p.at, external_transaction_id: 'kalshi:' + p.id + ':o' });
      net[p.ticker] = fromMicro(n + (p.dir > 0 ? q : -q));
    });
    return { fills: out, net: net, issues: issues };
  }
  /* a settlement → the resolution of both sides of its market */
  function kalshiSettlement(s) {
    var r = String(s.market_result || '').toLowerCase(), at = iso(s.settled_time);
    if (!s.ticker || !at) return { issue: bad('MALFORMED_SETTLEMENT', s.ticker, 'A Kalshi settlement was missing its market or time.') };
    var fee = s.fee_cost != null ? String(s.fee_cost) : '0';
    if (r === 'yes' || r === 'no') return { ticker: s.ticker, resolution: r.toUpperCase(), yes_price: r === 'yes' ? '1' : '0', settled_at: at, fee: fee, revenue: s.revenue != null ? dec.cents(s.revenue) : null };
    if (r === 'void') return { ticker: s.ticker, resolution: 'VOID', settled_at: at, fee: fee };
    if (r === 'scalar' && s.value != null) { var y = dec.cents(s.value); return { ticker: s.ticker, resolution: 'SCALAR', yes_price: y, settled_at: at, fee: fee, revenue: s.revenue != null ? dec.cents(s.revenue) : null }; }
    return { issue: bad('UNKNOWN_SETTLEMENT', s.ticker, 'A Kalshi settlement had a result EdgeDesk does not know (' + String(s.market_result).slice(0, 20) + '); it was not guessed at.') };
  }
  /* fills + settlements + market metadata → normalized positions */
  function kalshiNormalize(input) {
    input = input || {};
    var rep = kalshiReplay(input.fills, input.startNet), issues = rep.issues.slice();
    var meta = input.markets || {}, events = input.events || {}, pos = {};
    function position(ticker, side) {
      var k = ticker + ':' + side;
      if (!pos[k]) {
        var m = meta[ticker] || {}, ev = events[m.event_ticker] || {};
        var title = String(ev.title || m.title || ticker).slice(0, 200);
        var mkt = String(m.yes_sub_title || m.subtitle || m.title || ticker).slice(0, 200);
        pos[k] = { platform: 'kalshi', platform_label: 'Kalshi', position_type: 'EVENT_CONTRACT', external_position_id: 'kalshi:' + k,
          contract_key: 'kalshi:' + ticker, event_name: title, event_id: m.event_ticker || null, market_name: mkt, selection: side, side: side,
          event_start_at: iso(m.event_start_at || (input.starts || {})[m.event_ticker]) || null, sport: null, league: null,
          current_price: null, resolution: null, settlement_price: null, settled_at: null, fills: [], fees: [] };
      }
      return pos[k];
    }
    rep.fills.forEach(function (f) { position(f.ticker, f.side).fills.push({ external_transaction_id: f.external_transaction_id, action: f.action, quantity: f.quantity, price: f.price, fee: f.fee, executed_at: f.executed_at }); });
    (input.settlements || []).forEach(function (s) {
      var x = kalshiSettlement(s);
      if (x.issue) { issues.push(x.issue); return; }
      ['YES', 'NO'].forEach(function (side) {
        var k = x.ticker + ':' + side;
        if (!pos[k] && !(input.known || {})[k]) return;
        var p = position(x.ticker, side);
        p.resolution = x.resolution === 'SCALAR' ? 'SCALAR' : x.resolution;
        p.settlement_price = x.resolution === 'VOID' ? null : (side === 'YES' ? x.yes_price : dec.sub('1', x.yes_price));
        p.settled_at = x.settled_at;
      });
      /* a settlement fee belongs to the side that was held */
      if (dec.micro(x.fee) > 0n) {
        var held = (input.heldAtSettle || {})[x.ticker] || (dec.micro(rep.net[x.ticker] || '0') < 0n ? 'NO' : 'YES');
        position(x.ticker, held).fees.push({ external_transaction_id: 'kalshi:settle-fee:' + x.ticker, fee: x.fee, executed_at: x.settled_at });
      }
    });
    (input.marks || []).forEach(function (m) {
      ['YES', 'NO'].forEach(function (side) {
        var k = m.ticker + ':' + side; if (!pos[k]) return;
        var y = m.yes_price != null ? String(m.yes_price) : null; if (y == null) return;
        pos[k].current_price = side === 'YES' ? y : dec.sub('1', y); pos[k].current_price_at = iso(m.at) || null;
      });
    });
    return { positions: Object.keys(pos).sort().map(function (k) { return pos[k]; }), net: rep.net, issues: issues };
  }

  /* ═══ 6. POLYMARKET ═══════════════════════════════════════════════════ */
  var POLYMARKET = { data: 'https://data-api.polymarket.com', gamma: 'https://gamma-api.polymarket.com', pageLimit: 500, maxPages: 400 };
  var WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
  /* only a public address is accepted; anything shaped like a secret is
     refused before it leaves the form, and again on the server */
  function walletVerdict(text) {
    var t = String(text == null ? '' : text).trim();
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(t) || /PRIVATE KEY/.test(t) || t.split(/\s+/).filter(function (w) { return /^[a-z]{3,8}$/.test(w); }).length >= 11) return { ok: false, code: 'SECRET_PASTED' };
    if (!WALLET_RE.test(t)) return { ok: false, code: 'BAD_WALLET' };
    return { ok: true, address: t.toLowerCase() };
  }
  function pmPositionKey(tokenId) { return 'polymarket:' + String(tokenId); }
  function polymarketNormalize(input) {
    input = input || {};
    var issues = [], pos = {}, redeems = {};
    function position(tokenId, row) {
      var k = pmPositionKey(tokenId);
      if (!pos[k]) {
        var outcome = String((row && row.outcome) || 'Yes').slice(0, 80);
        pos[k] = { platform: 'polymarket', platform_label: 'Polymarket', position_type: 'EVENT_CONTRACT', external_position_id: k, contract_key: k,
          event_name: String((row && row.title) || 'Polymarket market').slice(0, 200), event_id: (row && (row.event_slug || row.eventSlug || row.event_id)) || null,
          market_name: String((row && row.title) || 'Polymarket market').slice(0, 200), selection: outcome, side: outcome, sport: null, league: null,
          event_start_at: null, current_price: null, current_price_at: null, resolution: null, settlement_price: null, settled_at: null, fills: [], fees: [],
          condition_id: (row && (row.condition_id || row.conditionId)) || null };
      }
      return pos[k];
    }
    var counts = {};
    (input.activity || []).forEach(function (a, i) {
      var type = String(a.type || '').toUpperCase();
      if (type === 'REDEEM') { var c = a.condition_id || a.conditionId; if (c) (redeems[c] = redeems[c] || []).push(a); return; }
      if (type !== 'TRADE') return;
      var token = a.token_id || a.asset, side = String(a.side || '').toUpperCase(), size = a.size != null ? String(a.size) : null;
      var price = a.price != null ? String(a.price) : null, at = iso(a.timestamp), hash = a.transaction_hash || a.transactionHash;
      if (!token || (side !== 'BUY' && side !== 'SELL') || !size || dec.micro(size) == null || dec.micro(size) <= 0n || price == null || dec.micro(price) == null
          || dec.micro(price) < 0n || dec.micro(price) > SCALE || !at || !hash) {
        issues.push(bad('MALFORMED_TRADE', hash || ('#' + i), 'A Polymarket trade was missing its token, side, size, price, time or transaction.'));
        return;
      }
      var base = 'polymarket:' + hash + ':' + token + ':' + side + ':' + fromMicro(dec.micro(price)) + ':' + fromMicro(dec.micro(size));
      counts[base] = (counts[base] || 0) + 1;
      position(token, a).fills.push({ external_transaction_id: base + (counts[base] > 1 ? ':' + counts[base] : ''), action: side,
        quantity: fromMicro(dec.micro(size)), price: fromMicro(dec.micro(price)), fee: '0', executed_at: at });
    });
    (input.positions || []).forEach(function (r) {
      var token = r.token_id || r.asset;
      if (!token) { issues.push(bad('MALFORMED_POSITION', r.condition_id, 'A Polymarket position had no token.')); return; }
      /* a position row describes a holding EdgeDesk has trades for — from this
         batch or an earlier sync; one it has none for waits for its trades */
      if (input.known && !input.known[pmPositionKey(token)] && !pos[pmPositionKey(token)]) return;
      var p = position(token, r), st = String(r.status || '').toUpperCase();
      p.event_name = String(r.title || p.event_name).slice(0, 200); p.market_name = p.event_name;
      p.event_id = r.event_slug || p.event_id; p.side = p.selection = String(r.outcome || p.side).slice(0, 80);
      p.condition_id = r.condition_id || p.condition_id;
      if (r.end_date && !p.event_start_at) p.market_end_at = iso(r.end_date);
      if (r.entry_fees_usdc != null && dec.micro(r.entry_fees_usdc) != null && dec.micro(r.entry_fees_usdc) > 0n) {
        p.fees = [{ external_transaction_id: 'polymarket:entry-fees:' + token, fee: fromMicro(dec.micro(r.entry_fees_usdc)), executed_at: iso(r.last_event_at) || null }];
      }
      if (st === 'OPEN' && r.current_price != null) { p.current_price = fromMicro(dec.micro(r.current_price)); p.current_price_at = input.asOf || null; }
      if (st === 'REDEEMABLE') { p.resolution = p.side; p.settlement_price = '1'; p.settled_at = iso(r.last_event_at) || iso(r.end_date); }
      if (st === 'REDEEMABLE_LOST') { p.resolution = 'OTHER OUTCOME'; p.settlement_price = '0'; p.settled_at = iso(r.last_event_at) || iso(r.end_date); }
      if (st === 'CLOSED') p.closed = true;
      p.reported = { size: r.current_size != null ? String(r.current_size) : null, realized_pnl: r.realized_pnl != null ? String(r.realized_pnl) : null };
    });
    /* what each position holds: an earlier sync's holding plus this batch */
    var heldOf = function (k, p) {
      return (dec.micro((input.held || {})[k] || '0') || 0n) + p.fills.reduce(function (s, f) { return s + (f.action === 'BUY' ? dec.micro(f.quantity) : -dec.micro(f.quantity)); }, 0n);
    };
    /* a redeemed (closed) winner: its redemption paid out what it held */
    Object.keys(pos).forEach(function (k) {
      var p = pos[k], rd = p.condition_id ? redeems[p.condition_id] : null;
      if (!p.closed || p.resolution || !rd) return;
      var paid = rd.reduce(function (s, a) { return s + (dec.micro(a.usdc_size || a.usdcSize || '0') || 0n); }, 0n);
      var held = heldOf(k, p);
      if (held <= 0n) return;
      if (paid > 0n) { p.resolution = p.side; p.settlement_price = '1'; p.settled_at = iso(rd[rd.length - 1].timestamp); }
      else if (paid === 0n) { p.resolution = 'OTHER OUTCOME'; p.settlement_price = '0'; p.settled_at = iso(rd[rd.length - 1].timestamp); }
    });
    var list = Object.keys(pos).sort().map(function (k) { var p = pos[k]; delete p.closed; return p; });
    list.forEach(function (p) {
      var held = heldOf(p.external_position_id, p);
      if (held < 0n) issues.push(bad('SOLD_MORE_THAN_BOUGHT', p.external_position_id, 'The trades for this Polymarket position sell more than they buy; part of its history is missing. It will be re-fetched.'));
    });
    return { positions: list, issues: issues };
  }

  /* ═══ 7. RECONCILIATION ═══════════════════════════════════════════════ */
  /* our holdings, from the fills we stored, against what the platform says it
     holds; a difference is reported, and a full re-fetch of that market is
     the repair — the stored figure is never overwritten to make it agree */
  function heldFromFills(fills) {
    return fromMicro((fills || []).reduce(function (s, f) { return s + (String(f.action || f.side).toUpperCase() === 'SELL' ? -dec.micro(f.quantity) : dec.micro(f.quantity)); }, 0n));
  }
  function reconcile(ours, theirs, opts) {
    opts = opts || {};
    var tol = dec.micro(opts.tolerance || '0.01'), out = [];
    Object.keys(theirs || {}).forEach(function (k) {
      var a = ours[k] == null ? '0' : String(ours[k]), b = String(theirs[k]);
      var d = dec.micro(a) - dec.micro(b);
      if ((d < 0n ? -d : d) > tol) out.push({ key: k, ours: a, theirs: b, difference: fromMicro(d) });
    });
    Object.keys(ours || {}).forEach(function (k) {
      if (theirs && Object.prototype.hasOwnProperty.call(theirs, k)) return;
      if (dec.micro(String(ours[k])) !== 0n && opts.complete) out.push({ key: k, ours: String(ours[k]), theirs: '0', difference: String(ours[k]) });
    });
    return { ok: out.length === 0, mismatches: out };
  }
  /* Kalshi's signed position (YES positive) for each market, from its positions endpoint */
  function kalshiReportedNet(resp) {
    var o = {};
    ((resp && (resp.market_positions || resp.positions)) || []).forEach(function (p) {
      var v = p.position_fp != null ? String(p.position_fp) : (p.position != null ? String(p.position) : null);
      if (p.ticker && v != null && dec.micro(v) != null) o[p.ticker] = fromMicro(dec.micro(v));
    });
    return o;
  }

  /* ═══ 8. THE INGEST PAYLOAD (what portfolio_svc_ingest receives) ══════ */
  function ingestPayload(normalized, extra) {
    var ps = (normalized.positions || []).map(function (p) {
      var o = {};
      ['platform', 'platform_label', 'position_type', 'external_position_id', 'contract_key', 'event_name', 'event_id', 'event_start_at', 'market_name', 'selection',
        'side', 'sport', 'league', 'current_price', 'current_price_at', 'resolution', 'settlement_price', 'settled_at'].forEach(function (k) { o[k] = p[k] == null ? null : p[k]; });
      o.fills = (p.fills || []).map(function (f) { return { external_transaction_id: f.external_transaction_id, action: f.action, quantity: f.quantity, price: f.price, fee: f.fee || '0', executed_at: f.executed_at }; });
      o.fees = (p.fees || []).map(function (f) { return { external_transaction_id: f.external_transaction_id, fee: f.fee, executed_at: f.executed_at }; });
      return o;
    });
    return Object.assign({ version: VERSION, positions: ps, issues: (normalized.issues || []).slice(0, 200) }, extra || {});
  }

  /* ═══ 9. CONNECT AND SYNC (server; the platform and the database injected) ═══
     ctx = { fetch, rpc(fn, args) → parsed JSON, now() → ms, budgetMs, keyring:
     { current: version, keys: { version: base64 } }, log(event, fields) }.
     Every log line passes through redact(). Nothing here writes a credential
     anywhere but through portfolio_svc_store_credential, sealed. */
  function codedError(code, extra) { var e = new Error(code); e.code = code; if (extra) Object.assign(e, extra); return e; }
  function logSafe(ctx, event, fields) { try { if (ctx.log) ctx.log(event, redact(fields || {})); } catch (_) { /* logging never breaks a sync */ } }
  function overBudget(ctx, started) { return ctx.budgetMs && (ctx.now() - started) > ctx.budgetMs; }
  async function getJson(ctx, url, headers) {
    var r;
    try { r = await ctx.fetch(url, { method: 'GET', headers: Object.assign({ accept: 'application/json' }, headers || {}) }); }
    catch (_) { throw codedError('PLATFORM_DOWN'); }
    if (r.status === 401 || r.status === 403) throw codedError('BAD_CREDENTIAL');
    if (r.status === 404) return null;
    if (r.status === 429) throw codedError('RATE_LIMITED', { retryAfter: Number((r.headers && r.headers.get && r.headers.get('retry-after')) || 0) || null });
    if (!r.ok) throw codedError('PLATFORM_DOWN', { status: r.status });
    try { return await r.json(); } catch (_) { throw codedError('MALFORMED'); }
  }
  async function kalshiGet(ctx, signer, path, query) {
    var full = kalshiQuery(path, query);
    return getJson(ctx, KALSHI.base + full, await signer.headers('GET', KALSHI.pathPrefix + path, ctx.now()));
  }
  /* every page of a cursor-paged list */
  async function kalshiAll(ctx, signer, path, query, key, started) {
    var out = [], cursor = null;
    for (var i = 0; i < KALSHI.maxPages; i++) {
      if (overBudget(ctx, started)) throw codedError('TIMEOUT');
      var page = await kalshiGet(ctx, signer, path, Object.assign({ limit: KALSHI.pageLimit }, query || {}, cursor ? { cursor: cursor } : {}));
      if (!page) break;
      out = out.concat(page[key] || []);
      cursor = page.cursor || null;
      if (!cursor || !(page[key] || []).length) break;
    }
    return out;
  }
  function parseCursor(text) { try { var c = JSON.parse(text || '{}'); return c && typeof c === 'object' ? c : {}; } catch (_) { return {}; } }
  /* the newest point seen, and the ids at exactly that point, so the next
     page can start there without re-counting what it already holds */
  function advance(prev, rows, timeOf, idOf) {
    var ts = prev && prev.ts || null, ids = (prev && prev.ids) || [];
    rows.forEach(function (r) {
      var t = timeOf(r), id = String(idOf(r));
      if (!t) return;
      if (!ts || t > ts) { ts = t; ids = [id]; } else if (t === ts && ids.indexOf(id) < 0) ids.push(id);
    });
    return { ts: ts, ids: ids.slice(-500) };
  }
  function after(prev, rows, timeOf, idOf) {
    if (!prev || !prev.ts) return rows;
    return rows.filter(function (r) { var t = timeOf(r); return t && (t > prev.ts || (t === prev.ts && (prev.ids || []).indexOf(String(idOf(r))) < 0)); });
  }
  async function openStoredCredential(ctx, account) {
    var rows = await ctx.rpc('portfolio_svc_credential', { p_account: account.account_id });
    var row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) throw codedError('BAD_CREDENTIAL');
    var key = ctx.keyring.keys[String(row.key_version)];
    if (!key) throw codedError('UNKNOWN', { note: 'no key for version ' + row.key_version });
    var secret = await openCredential(row, { keyB64: key, userId: row.user_id, accountId: account.account_id });
    /* rotation: a credential sealed under an older key is re-sealed under the current one */
    if (String(row.key_version) !== String(ctx.keyring.current)) {
      var resealed = await sealCredential(secret, { keyB64: ctx.keyring.keys[String(ctx.keyring.current)], keyVersion: +ctx.keyring.current,
        userId: row.user_id, accountId: account.account_id, kind: row.credential_kind });
      await ctx.rpc('portfolio_svc_store_credential', { p_account: account.account_id, p_kind: row.credential_kind, p_ciphertext_b64: resealed.ciphertext_b64,
        p_nonce_b64: resealed.nonce_b64, p_key_version: +ctx.keyring.current, p_key_hint: keyHint(secret.key_id), p_scopes: secret.scopes || null });
    }
    return secret;
  }
  async function ingestChunks(ctx, accountId, runId, payload) {
    var tot = { positions_inserted: 0, positions_updated: 0, positions_settled: 0, transactions_inserted: 0, transactions_unchanged: 0, rejected: 0, healed: 0 };
    var ps = payload.positions || [], first = true;
    for (var i = 0; i < Math.max(1, ps.length); i += 200) {
      var chunk = Object.assign({}, payload, { positions: ps.slice(i, i + 200), issues: first ? payload.issues : [], fetched: first ? payload.fetched : 0,
        replace_prefixes: payload.replace_prefixes || [] });
      var r = await ctx.rpc('portfolio_svc_ingest', { p_account: accountId, p_run: runId, p_payload: chunk }) || {};
      Object.keys(tot).forEach(function (k) { tot[k] += +r[k] || 0; });
      first = false;
    }
    return tot;
  }
  async function storedPositions(ctx, accountId) { return (await ctx.rpc('portfolio_svc_account_positions', { p_account: accountId })) || []; }

  /* CONNECT KALSHI: validate the key against Kalshi, refuse one that can
     trade, then — and only then — seal and store it */
  async function connectKalshi(ctx, o) {
    var signer = await kalshiSigner(o.keyId, o.privateKey);
    var keys = await kalshiGet(ctx, signer, '/api_keys', null);
    var verdict = kalshiScopeVerdict(keys, o.keyId);
    if (!verdict.ok) throw codedError(verdict.code);
    var accountId = await ctx.rpc('portfolio_svc_account_connect', { p_user: o.userId, p_platform: 'kalshi', p_method: 'API_KEY',
      p_external_account_id: null, p_display_name: o.displayName || null, p_smoke_test: o.smokeTestId || null });
    var sealed = await sealCredential({ key_id: String(o.keyId), private_key: String(o.privateKey), scopes: verdict.scopes },
      { keyB64: ctx.keyring.keys[String(ctx.keyring.current)], keyVersion: +ctx.keyring.current, userId: o.userId, accountId: accountId, kind: 'API_KEY' });
    await ctx.rpc('portfolio_svc_store_credential', { p_account: accountId, p_kind: 'API_KEY', p_ciphertext_b64: sealed.ciphertext_b64, p_nonce_b64: sealed.nonce_b64,
      p_key_version: +ctx.keyring.current, p_key_hint: keyHint(o.keyId), p_scopes: verdict.scopes });
    logSafe(ctx, 'connect.kalshi', { account: accountId, scopes: verdict.scopes });
    return { account_id: accountId, scopes: verdict.scopes };
  }
  /* CONNECT POLYMARKET: a public address; its proxy wallet if it has one */
  async function connectPolymarket(ctx, o) {
    var v = walletVerdict(o.wallet);
    if (!v.ok) throw codedError(v.code);
    var addr = v.address, prof = null;
    try { prof = await getJson(ctx, POLYMARKET.gamma + '/public-profile?address=' + encodeURIComponent(addr)); } catch (e) { if (e.code !== 'MALFORMED') throw e; }
    var proxy = prof && typeof prof.proxyWallet === 'string' && WALLET_RE.test(prof.proxyWallet) ? prof.proxyWallet.toLowerCase() : addr;
    var accountId = await ctx.rpc('portfolio_svc_account_connect', { p_user: o.userId, p_platform: 'polymarket', p_method: 'PUBLIC_WALLET',
      p_external_account_id: proxy, p_display_name: o.displayName || null, p_smoke_test: o.smokeTestId || null });
    logSafe(ctx, 'connect.polymarket', { account: accountId });
    return { account_id: accountId, wallet: proxy };
  }

  /* SYNC KALSHI: history (before the cutoff) once, then fills and settlements
     since the cursor; replay from the stored holding; ingest; reconcile against
     Kalshi's own positions; a market that disagrees is re-fetched in full
     next time and rebuilt */
  async function syncKalshiRun(ctx, account, runId, started) {
    var secret = await openStoredCredential(ctx, account);
    var signer = await kalshiSigner(secret.key_id, secret.private_key);
    var cur = parseCursor(account.sync_cursor), fetched = 0;
    var stored = await storedPositions(ctx, account.account_id), startNet = {}, known = {};
    stored.forEach(function (p) {
      var m = /^kalshi:(.+):(YES|NO)$/.exec(p.external_position_id || ''); if (!m) return;
      known[m[1] + ':' + m[2]] = true;
      var v = dec.micro(p.contracts || '0') || 0n;
      startNet[m[1]] = fromMicro((dec.micro(startNet[m[1]] || '0') || 0n) + (m[2] === 'YES' ? v : -v));
    });
    var fillTime = function (f) { return iso(f.created_time || f.ts); }, fillId = function (f) { return f.fill_id || f.trade_id; };
    var fills;
    if (!cur.historical_done) {
      var hist = [];
      var cutoff = await kalshiGet(ctx, signer, '/historical/cutoff', null);
      if (cutoff && (cutoff.trades_created_ts || cutoff.fills_created_ts)) hist = await kalshiAll(ctx, signer, '/historical/fills', null, 'fills', started);
      fills = hist.concat(await kalshiAll(ctx, signer, '/portfolio/fills', null, 'fills', started));
      startNet = {};   /* the whole history replays from nothing */
    } else {
      var since = cur.fills && cur.fills.ts ? Math.floor(Date.parse(cur.fills.ts) / 1000) - 1 : null;
      fills = after(cur.fills, await kalshiAll(ctx, signer, '/portfolio/fills', since ? { min_ts: since } : null, 'fills', started), fillTime, fillId);
    }
    fetched += fills.length;
    var sSince = cur.settlements && cur.settlements.ts ? Math.floor(Date.parse(cur.settlements.ts) / 1000) - 1 : null;
    var setts = after(cur.settlements, await kalshiAll(ctx, signer, '/portfolio/settlements', sSince ? { min_ts: sSince } : null, 'settlements', started),
      function (x) { return iso(x.settled_time); }, function (x) { return x.ticker; });
    fetched += setts.length;
    /* markets to rebuild in full, from the last reconciliation */
    var refetch = (cur.refetch || []).slice(0, 20), rebuild = [];
    for (var i = 0; i < refetch.length; i++) {
      var t = refetch[i];
      var all = (await kalshiAll(ctx, signer, '/historical/fills', { ticker: t }, 'fills', started)).concat(await kalshiAll(ctx, signer, '/portfolio/fills', { ticker: t }, 'fills', started));
      rebuild = rebuild.concat(all); fetched += all.length;
    }
    var tickers = {};
    fills.concat(rebuild).forEach(function (f) { var t2 = f.ticker || f.market_ticker; if (t2) tickers[t2] = 1; });
    setts.forEach(function (x) { if (x.ticker) tickers[x.ticker] = 1; });
    var markets = {}, events = {};
    var tk = Object.keys(tickers);
    for (var j = 0; j < tk.length; j++) {
      if (overBudget(ctx, started)) throw codedError('TIMEOUT');
      var mr = await kalshiGet(ctx, signer, '/markets/' + encodeURIComponent(tk[j]), null);
      var m = mr && (mr.market || mr);
      if (m) {
        markets[tk[j]] = m;
        if (m.event_ticker && !events[m.event_ticker]) { var er = await kalshiGet(ctx, signer, '/events/' + encodeURIComponent(m.event_ticker), null); events[m.event_ticker] = (er && (er.event || er)) || {}; }
      }
    }
    var rebuildSet = {}; refetch.forEach(function (t3) { rebuildSet[t3] = 1; });
    var normal = kalshiNormalize({ fills: fills.filter(function (f) { return !rebuildSet[f.ticker || f.market_ticker]; }), startNet: startNet,
      settlements: setts.filter(function (x) { return !rebuildSet[x.ticker]; }), markets: markets, events: events, known: known });
    var tot = await ingestChunks(ctx, account.account_id, runId, ingestPayload(normal, { fetched: fetched }));
    if (refetch.length) {
      var allSetts = await kalshiAll(ctx, signer, '/portfolio/settlements', null, 'settlements', started);
      var healed = kalshiNormalize({ fills: rebuild, settlements: allSetts.filter(function (x) { return rebuildSet[x.ticker]; }), markets: markets, events: events });
      var h = await ingestChunks(ctx, account.account_id, runId, ingestPayload(healed, { replace_prefixes: refetch.map(function (t4) { return 'kalshi:' + t4 + ':'; }) }));
      Object.keys(tot).forEach(function (k) { tot[k] += h[k] || 0; });
    }
    /* reconcile: our net holding per market against Kalshi's */
    var after2 = await storedPositions(ctx, account.account_id), ours = {};
    after2.forEach(function (p) {
      var mm = /^kalshi:(.+):(YES|NO)$/.exec(p.external_position_id || ''); if (!mm || p.status === 'VOID') return;
      if (p.resolution) return;   /* a settled market holds nothing at Kalshi */
      var v = dec.micro(p.contracts || '0') || 0n;
      ours[mm[1]] = fromMicro((dec.micro(ours[mm[1]] || '0') || 0n) + (mm[2] === 'YES' ? v : -v));
    });
    var reported = kalshiReportedNet({ market_positions: await kalshiAll(ctx, signer, '/portfolio/positions', null, 'market_positions', started) });
    var rec = reconcile(ours, reported, { complete: true });
    var next = { v: 1, historical_done: true, fills: advance(cur.fills, fills, fillTime, fillId),
      settlements: advance(cur.settlements, setts, function (x) { return iso(x.settled_time); }, function (x) { return x.ticker; }),
      refetch: rec.mismatches.map(function (x) { return x.key; }).filter(function (k) { return !rebuildSet[k]; }).slice(0, 20) };
    return { totals: tot, issues: normal.issues, reconcile: { ok: rec.ok, mismatches: rec.mismatches.slice(0, 20), healed: refetch }, cursor: JSON.stringify(next) };
  }

  /* SYNC POLYMARKET: activity since the cursor (all of it the first time),
     the positions by status, ingest, reconcile the open sizes */
  async function pmAll(ctx, path, query, started) {
    var out = [], cursor = null;
    for (var i = 0; i < POLYMARKET.maxPages; i++) {
      if (overBudget(ctx, started)) throw codedError('TIMEOUT');
      var q = Object.assign({ limit: POLYMARKET.pageLimit }, query, cursor ? { cursor: cursor } : {});
      var page = await getJson(ctx, POLYMARKET.data + kalshiQuery(path, q));
      if (!page) break;
      var rows = Array.isArray(page) ? page : (page.data || []);
      out = out.concat(rows);
      var pg = page.pagination || {};
      cursor = pg.has_more ? pg.next_cursor : null;
      if (!cursor || !rows.length) break;
    }
    return out;
  }
  async function syncPolymarketRun(ctx, account, runId, started) {
    var user = account.external_account_id, cur = parseCursor(account.sync_cursor);
    if (!user || !WALLET_RE.test(user)) throw codedError('BAD_WALLET');
    var stored = await storedPositions(ctx, account.account_id), known = {}, held = {};
    stored.forEach(function (p) { known[p.external_position_id] = true; held[p.external_position_id] = p.contracts || '0'; });
    var full = !cur.activity || cur.full_refetch;
    var activity = await pmAll(ctx, '/v2/activity', { user: user, type: 'TRADE,REDEEM', sort_direction: 'ASC', start: full ? 1 : Math.max(1, (cur.activity.ts_s || 1) - 1) }, started);
    var actId = function (a) { return [a.transaction_hash || a.transactionHash, a.token_id || a.asset, a.type, a.side, a.size, a.price].join(':'); };
    var actTime = function (a) { return iso(a.timestamp); };
    if (!full) activity = after(cur.activity, activity, actTime, actId);
    var positions = [];
    var statuses = ['OPEN', 'REDEEMABLE', 'REDEEMABLE_LOST', 'CLOSED'];
    for (var i = 0; i < statuses.length; i++) positions = positions.concat(await pmAll(ctx, '/v2/positions', { user: user, status: statuses[i] }, started));
    var normal = polymarketNormalize({ activity: activity, positions: positions, known: full ? null : known, held: full ? {} : held, asOf: new Date(ctx.now()).toISOString() });
    var tot = await ingestChunks(ctx, account.account_id, runId, ingestPayload(normal, { fetched: activity.length + positions.length }));
    var after2 = await storedPositions(ctx, account.account_id), ours = {}, reported = {};
    after2.forEach(function (p) { if (!p.resolution && p.status === 'OPEN') ours[p.external_position_id] = p.contracts || '0'; });
    positions.filter(function (r) { return String(r.status || '').toUpperCase() === 'OPEN'; }).forEach(function (r) {
      var k = pmPositionKey(r.token_id || r.asset); if (r.current_size != null) reported[k] = fromMicro(dec.micro(r.current_size));
    });
    var rec = reconcile(ours, reported, {});
    var bad = normal.issues.some(function (x) { return x.code === 'SOLD_MORE_THAN_BOUGHT'; }) || !rec.ok;
    var last = advance(cur.activity, activity, actTime, actId);
    last.ts_s = last.ts ? Math.floor(Date.parse(last.ts) / 1000) : (cur.activity && cur.activity.ts_s) || null;
    var next = { v: 1, activity: last, full_refetch: bad };
    return { totals: tot, issues: normal.issues, reconcile: { ok: rec.ok, mismatches: rec.mismatches.slice(0, 20), will_refetch: bad }, cursor: JSON.stringify(next) };
  }

  /* ═══ 10. SHARPSPORTS BETSYNC — an approved aggregator for sportsbooks ═══
     The reader links their book on SharpSports' own page (a context EdgeDesk
     creates server-side, opened at ui.sharpsports.io/link/<cid>). SharpSports
     signs in to the book; EdgeDesk reads SharpSports with its own key, which
     never leaves the server. EdgeDesk never sees a sportsbook password.

     HOW THE FACTS WERE VERIFIED. docs.sharpsports.io was unreachable from the
     build environment (DNS / egress policy). The facts below were read from
     SharpSports' own documentation pages as quoted in web-search excerpts on
     2026-10-14. Each request is labelled: DOCUMENTED — the path appears in
     SharpSports' docs; INFERRED — the resource and its name are documented
     but the path was not seen, so the REST-consistent form is used. Every
     INFERRED request is a read-only GET: a mismatch fails the sync with
     PROVIDER_CONTRACT and stores nothing. The sandbox smoke test confirms
     them; docs.sharpsports.io/llms.txt is the page to re-read. */
  var SHARPSPORTS = {
    key: 'sharpsports', label: 'SharpSports BetSync', source_type: 'SPORTSBOOK', method: 'AUTHORIZED_API', connector_version: 'sharpsports_v1',
    api: 'https://api.sharpsports.io/v1', ui: 'https://ui.sharpsports.io',
    what_the_reader_gives: 'Nothing to EdgeDesk. You sign in to your sportsbook on SharpSports\' own page; SharpSports reads your bet history and EdgeDesk reads it from SharpSports. EdgeDesk never sees your sportsbook password.',
    contract: {
      context: { method: 'POST', path: '/context', key: 'public', seen: 'DOCUMENTED' },
      books: { method: 'GET', path: '/books', key: 'public', seen: 'DOCUMENTED' },
      accountRefresh: { method: 'POST', path: '/bettorAccounts/{id}/refresh', key: 'public', seen: 'DOCUMENTED' },
      bettorAccounts: { method: 'GET', path: '/bettors/{id}/bettorAccounts', key: 'private', seen: 'INFERRED' },
      bettorAccount: { method: 'GET', path: '/bettorAccounts/{id}', key: 'private', seen: 'INFERRED' },
      accountBetSlips: { method: 'GET', path: '/bettorAccounts/{id}/betSlips', key: 'private', seen: 'INFERRED' }
    },
    verified: { on: '2026-10-14', from: 'docs.sharpsports.io as quoted in web-search excerpts (the site itself was unreachable from the build environment)',
      docs: 'https://docs.sharpsports.io', index: 'https://docs.sharpsports.io/llms.txt',
      facts: ['Base URL https://api.sharpsports.io/v1; sandbox and live are separated by their own API keys (Dashboard toggle), not by host',
        'Authorization: Token <key>; public key for /books, /context and refresh; private key never exposed to a browser',
        'POST /v1/context {internalId, redirectUrl} returns {cid}; linking UI at ui.sharpsports.io/link/<cid>; a new cid each time the UI is opened',
        'POST /v1/bettorAccounts/<BACT_id>/refresh[?reverify=true]; refreshes at least 60 s apart and never overlapping (429); the result arrives asynchronously as refreshResponse.created',
        'RefreshResponse status: 200 pulled, 202 pulled (slips by refreshResponseId), 401 handled failure (password, terms, 2FA), 403 access revoked, 406 bad OTP, 424 book down, 429 rate limited, 500 unhandled',
        'BettorAccount: id BACT_, book, bookRegion, verified, isUnverifiable, access, paused, refreshInProgress, latestRefreshResponse, latestRefreshRequestId; access=false: nothing can be refreshed or read',
        'BetSlip: id SLIP_, bettorAccount, book, type (single | parlay), subtype (teaser, round robin), oddsAmerican, atRisk and toWin in CENTS (toWin never changes), netProfit, status pending | completed, outcome (null until completed), timePlaced (null when the book gives none), timeClosed, incomplete, bets[]',
        'Bet (leg): id, event {name, sport, league, startTime, contestantHome, contestantAway}, proposition, position, line, oddsAmerican, status, outcome, segment, bookDescription',
        'Webhooks: bettor.created, bettorAccount.verified, bettorAccount.unverified, refreshResponse.created; each subscription has its own hmac_secret (HMAC-SHA256) and every post carries its id in the Hook-Subscription header; answer 200 within 10 s',
        'Sandbox: test users only (gooduser / Test1 succeeds; errorloginuser / Test3 fails verification; changepassworduser / Test5 later refreshes 401; 2FAuser / Test6 OTP 123456); each refresh generates a few real-market bets that grade after the events'],
      unverified: ['The webhook signature header name and the exact signed string (the HMAC Verification page was not readable): verified here as the HMAC of the raw body in any header, hex or base64',
        'The webhook body\'s official top-level shape: only documented id prefixes (BACT_, BTTR_, RRES_, SLIP_) and EdgeDesk\'s own internalId are read from it',
        'The event name of "Bettor Account Inaccessible": not read; every delivery is a hint to re-read what it names',
        'The paths of the INFERRED requests above, and list pagination (a same-origin next link is followed when present)',
        'Cash-out and free-bet fields: payout is atRisk + netProfit; a slip with no stake is not stored',
        'A provider-side "remove access" call on disconnect (its path was not documented in what was readable): EdgeDesk stops reading; access is removed in the SharpSports dashboard'] },
    tos_review: ['A SharpSports commercial agreement and live-mode plan (EdgeDesk stays in sandbox until then; nothing here subscribes or bills)',
      'How SharpSports obtains each book\'s data, per book and jurisdiction, and the books that need SharpSports\' own SDK or browser extension',
      'Reader consent wording for linking, and retention / deletion of synced history',
      'Billing: a linked account with access=true is billable; refresh cadence and limits on the plan'],
    pageCap: 200, readEveryMs: 24 * 3600 * 1000
  };
  var AGGREGATORS = [SHARPSPORTS];
  function aggregatorInfo(key) { return AGGREGATORS.filter(function (g) { return g.key === key; })[0] || null; }
  /* SharpSports' documented id prefixes, and EdgeDesk's own internalId shape */
  var SS_ID = /^[A-Za-z0-9_-]{3,100}$/;
  var SS_INTERNAL = /^ed_[0-9a-f]{32}$/;
  /* a SharpSports book → EdgeDesk's platform key (lib/edgedesk_portfolio.js
     PLATFORMS); a book EdgeDesk does not list keeps its own name as custom_<name> */
  var SS_BOOKS = [[/^draft\s*kings/i, 'draftkings', 'DraftKings'], [/^fan\s*duel/i, 'fanduel', 'FanDuel'], [/^bet\s*mgm/i, 'betmgm', 'BetMGM'],
    [/^(caesars|william\s*hill)/i, 'williamhill_us', 'Caesars'], [/^bet\s*365/i, 'bet365', 'bet365'], [/^bet\s*rivers/i, 'betrivers', 'BetRivers'],
    [/^(espn\s*bet|the\s*score)/i, 'espnbet', 'theScore Bet (ESPN BET)'], [/^fanatics/i, 'fanatics', 'Fanatics'], [/^hard\s*rock/i, 'hardrockbet', 'Hard Rock Bet'],
    [/^circa/i, 'circasports', 'Circa Sports'], [/^super\s*book/i, 'superbook', 'SuperBook'], [/^pinnacle/i, 'pinnacle', 'Pinnacle'], [/^novig/i, 'novig', 'Novig'],
    [/^prophet\s*x?\b/i, 'prophetx', 'ProphetX']];
  function ssText(x, n) { if (x == null || typeof x === 'object') return null; var s = String(x).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n || 200) : null; }
  function ssBookPlatform(book) {
    var name = ssText(book && typeof book === 'object' ? book.name : null, 60);
    if (!name) return null;
    for (var i = 0; i < SS_BOOKS.length; i++) if (SS_BOOKS[i][0].test(name)) return { platform: SS_BOOKS[i][1], label: SS_BOOKS[i][2] };
    var slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return slug ? { platform: 'custom_' + slug, label: name } : null;
  }
  /* whole cents → dollars, exactly; anything that is not whole cents is refused */
  function ssCents(x) {
    if (x == null || x === '' || typeof x === 'object' || typeof x === 'boolean') return null;
    var v = toMicro(String(x));
    if (v == null || v % SCALE !== 0n) return null;
    return v / SCALE;
  }
  function ssDollars(c) { return fromMicro(mulDiv(c * SCALE, 1n, 100n)); }
  var SS_SPORTS = [[/^nfl$/i, 'NFL'], [/^(ncaaf|cfb|college football|ncaa football)$/i, 'CFB'], [/^nba$/i, 'NBA'], [/^(ncaab|ncaam|cbb|college basketball|ncaa basketball)$/i, 'CBB'],
    [/^wnba$/i, 'WNBA'], [/^mlb$/i, 'MLB'], [/^nhl$/i, 'NHL'], [/^(ufc|mma)$/i, 'UFC'], [/^(soccer|epl|mls|ucl|uefa|premier league|la liga|serie a|bundesliga|ligue 1)/i, 'Soccer'],
    [/^(tennis|atp|wta)/i, 'Tennis'], [/^(golf|pga|lpga|liv)/i, 'Golf']];
  function ssSport(ev) {
    var lg = ssText(ev && ev.league, 30), sp = ssText(ev && ev.sport, 30);
    for (var i = 0; i < SS_SPORTS.length; i++) { if ((lg && SS_SPORTS[i][0].test(lg)) || (sp && SS_SPORTS[i][0].test(sp))) return SS_SPORTS[i][1]; }
    return sp;
  }
  var SS_OUTCOME = { win: 'WON', loss: 'LOST', push: 'PUSH', void: 'VOID', cashout: 'CASHED_OUT', halfwin: 'WON', halfloss: 'LOST', canceled: 'VOID', cancelled: 'VOID' };
  function ssOutcome(x) { return SS_OUTCOME[String(x == null ? '' : x).toLowerCase().replace(/[\s_-]+/g, '')] || null; }
  function ssAmerican(x) { var n = Number(x); return Number.isInteger(n) && Math.abs(n) >= 100 && Math.abs(n) <= 1000000 ? n : null; }
  function ssLine(line, ptype) {
    if (line == null || ptype === 'MONEYLINE') return '';
    var s = fromMicro(toMicro(line));
    return ' ' + (ptype === 'SPREAD' && toMicro(line) > 0n ? '+' : '') + s;
  }
  /* one Bet (a leg) → EdgeDesk's leg shape (lib/edgedesk_portfolio_import.js groupLegRecords) */
  function ssLeg(b, i) {
    b = b && typeof b === 'object' ? b : {};
    var ev = b.event && typeof b.event === 'object' ? b.event : {};
    var home = ev.contestantHome && ssText(ev.contestantHome.fullName, 90), away = ev.contestantAway && ssText(ev.contestantAway.fullName, 90);
    var prop = String(b.proposition || '').toLowerCase();
    var ptype = prop === 'moneyline' ? 'MONEYLINE' : prop === 'spread' ? 'SPREAD' : prop === 'total' ? 'TOTAL'
      : /prop|player/.test(prop) ? 'PLAYER_PROP' : /future|outright/.test(prop) ? 'FUTURE' : 'OTHER';
    var line = b.line != null && b.line !== '' && toMicro(String(b.line)) != null ? fromMicro(toMicro(String(b.line))) : null;
    var pos = ssText(b.position, 120), desc = ssText(b.bookDescription, 200), seg = ssText(b.segment, 40);
    var market = prop ? prop.charAt(0).toUpperCase() + prop.slice(1, 80) : null;
    if (market && seg && !/full|game|match/i.test(seg)) market += ' · ' + seg;
    var st = String(b.status || '').toLowerCase();
    return { leg_number: String(i + 1), selection: pos ? (pos + ssLine(line, ptype)).slice(0, 200) : desc, event_name: ssText(ev.name, 200) || (home && away ? away + ' at ' + home : null),
      market_name: market || (desc ? null : 'Wager'), position_type: ptype, line: line, odds_american: ssAmerican(b.oddsAmerican),
      result: st === 'completed' || b.outcome ? (ssOutcome(b.outcome) || null) : 'OPEN', sport: ssSport(ev), league: ssText(ev.league, 30),
      event_start_at: iso(ev.startTime) || null, home: home || null, away: away || null, description: desc,
      position: pos ? pos.slice(0, 80) : null, event_ref: ssText(ev.id, 100) };
  }
  function ssCompact(o) { var c = {}; Object.keys(o).forEach(function (k) { if (o[k] != null && o[k] !== '') c[k] = o[k]; }); return c; }
  /* the raw record kept with the position: SharpSports' own slip, never a
     credential, capped so the row stays small */
  function ssRaw(slip) {
    var r = redact(slip);
    var s = JSON.stringify(r);
    if (s.length <= 60000) return r;
    var o = {}; Object.keys(r).forEach(function (k) { if (k !== 'bets') o[k] = r[k]; });
    o.bets_omitted = Array.isArray(slip.bets) ? slip.bets.length : null;
    return JSON.stringify(o).length <= 60000 ? o : { id: r.id, note: 'raw record too large to keep' };
  }
  /* BetSlips → normalized wagers. Money is in cents and is converted
     exactly; the payout of a settled slip is atRisk + netProfit (netProfit
     is the book's own figure — it carries a pushed parlay leg or a cash-out);
     a slip the platform has not settled stays OPEN; anything that cannot be
     read without guessing is skipped and listed, never invented. */
  function sharpsportsNormalize(slips, o) {
    o = o || {};
    var out = [], issues = [], skipped = 0;
    function skip(code, ref, msg) { skipped++; if (issues.length < 200) issues.push(bad(code, ref, msg)); }
    (slips || []).forEach(function (s, idx) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SS_ID.test(s.id)) return skip('MALFORMED_SLIP', '#' + idx, 'A SharpSports bet slip had no id.');
      var ref = s.id, risk = ssCents(s.atRisk), toWin = ssCents(s.toWin), net = ssCents(s.netProfit);
      if (risk == null) return skip('MALFORMED_SLIP', ref, 'A bet slip\'s stake was not a whole number of cents.');
      if (risk <= 0n) return skip('NO_STAKE', ref, 'A bet slip with no cash stake (a free bet, as SharpSports reports it) was not stored: its stake is not known.');
      var placed = iso(s.timePlaced);
      if (!placed) return skip('NO_PLACED_TIME', ref, 'The book did not report when this bet was placed, so it was not stored (EdgeDesk does not guess the time).');
      var legs = (Array.isArray(s.bets) ? s.bets : []).map(ssLeg);
      var american = ssAmerican(s.oddsAmerican), decimal = null;
      if (american == null) {
        if (toWin == null || toWin <= 0n) return skip('NO_PRICE', ref, 'A bet slip had neither American odds nor a to-win amount.');
        decimal = fromMicro(SCALE + mulDiv(toWin, SCALE, risk));
      }
      var st = String(s.status || '').toLowerCase(), status, payout = null;
      if (st === 'pending') status = 'OPEN';
      else {
        status = ssOutcome(s.outcome);
        if (!status && net != null && st === 'completed') status = 'SETTLED';
        if (!status) return skip('UNKNOWN_OUTCOME', ref, 'A bet slip reported a status or outcome EdgeDesk does not know (' + String(s.status || s.outcome || '').slice(0, 20) + '); it was not guessed at.');
        if (net != null) {
          if (risk + net < 0n) return skip('MALFORMED_SLIP', ref, 'A bet slip reported losing more than its stake.');
          payout = ssDollars(risk + net);
        } else if (status === 'CASHED_OUT' || status === 'SETTLED') {
          return skip('NO_PAYOUT', ref, 'A cashed-out slip without the amount paid was not stored.');
        }
      }
      var type = String(s.type || '').toLowerCase(), sub = String(s.subtype || '').toLowerCase().replace(/[\s_-]+/g, '');
      var multi = type === 'parlay' || legs.length > 1;
      var events = []; legs.forEach(function (l) { if (l.event_name && events.indexOf(l.event_name) < 0) events.push(l.event_name); });
      var first = legs[0] || {}, desc = ssText(s.bookDescription, 200) || first.description || null;
      var p = { platform: o.platform, platform_label: o.platform_label || null, external_position_id: 'sharpsports:' + ref,
        odds_american: american, odds_decimal: decimal, stake: ssDollars(risk), stake_type: 'CASH', currency: 'USD', status: status,
        reported_payout: payout, placed_at: placed, settled_at: status === 'OPEN' ? null : (iso(s.timeClosed) || iso(s.dateClosed) || null) };
      if (!multi) {
        p.position_type = first.position_type || 'OTHER';
        p.event_name = first.event_name || desc || 'Wager';
        p.market_name = first.market_name || 'Wager';
        p.selection = first.selection || desc || 'As placed';
        p.side = first.position || null;
        p.line = first.line;
        p.sport = first.sport || null; p.league = first.league || null;
        p.event_start_at = first.event_start_at || null;
        p.event_id = first.event_ref ? ('sharpsports:' + first.event_ref).slice(0, 120) : null;
      } else {
        var oneEvent = events.length === 1, n = legs.length;
        p.position_type = sub === 'roundrobin' ? 'OTHER' : oneEvent && n > 1 ? 'SAME_GAME_PARLAY' : 'PARLAY';
        p.market_name = (sub === 'roundrobin' ? 'Round robin' : sub === 'teaser' ? 'Teaser' : oneEvent ? 'Same-game parlay' : 'Parlay') + ' (' + n + ' leg' + (n === 1 ? '' : 's') + ')';
        p.event_name = oneEvent ? events[0] : events.length ? ('Parlay: ' + events.slice(0, 2).join(' · ') + (events.length > 2 ? ' +' + (events.length - 2) : '')).slice(0, 200) : (desc || 'Parlay');
        p.selection = legs.map(function (l) { return l.selection || '?'; }).join(' + ').slice(0, 200) || desc || 'As placed';
        var sports = []; legs.forEach(function (l) { if (l.sport && sports.indexOf(l.sport) < 0) sports.push(l.sport); });
        p.sport = sports.length === 1 ? sports[0] : null;
        var lgs = []; legs.forEach(function (l) { if (l.league && lgs.indexOf(l.league) < 0) lgs.push(l.league); });
        p.league = lgs.length === 1 ? lgs[0] : null;
        var starts = legs.map(function (l) { return l.event_start_at; }).filter(Boolean).sort();
        p.event_start_at = starts[0] || null;
        if (n > 30 && issues.length < 200) issues.push(bad('LEGS_TRUNCATED', ref, 'A slip had ' + n + ' legs; the first 30 are kept with it.'));
      }
      p.legs = legs.length ? legs.slice(0, 30).map(function (l) {
        return ssCompact({ leg_number: l.leg_number, selection: l.selection, event_name: l.event_name, market_name: l.market_name, position_type: l.position_type,
          line: l.line, odds_american: l.odds_american, result: l.result, sport: l.sport, league: l.league, event_start_at: l.event_start_at, home: l.home, away: l.away });
      }) : null;
      if (!multi && p.legs && p.legs.length === 1) p.legs = null;   /* a single keeps its one leg in the position itself */
      if (s.incomplete === true && issues.length < 200) issues.push(bad('INCOMPLETE_SLIP', ref, 'SharpSports marks this slip incomplete: its money is exact, but some of the event or market detail is missing.'));
      p.raw = ssRaw(s);
      out.push(p);
    });
    return { positions: out, issues: issues, skipped: skipped };
  }
  /* the state SharpSports reports for a linked account — what a reader and
     an operator may see, never a credential */
  function ssAccountState(ba) {
    ba = ba || {};
    var rr = ba.latestRefreshResponse && typeof ba.latestRefreshResponse === 'object' ? ba.latestRefreshResponse : null;
    var book = ba.book && typeof ba.book === 'object' ? ba.book : null, region = ba.bookRegion && typeof ba.bookRegion === 'object' ? ba.bookRegion : null;
    return { verified: ba.verified === true ? true : ba.verified === false ? false : null, unverifiable: ba.isUnverifiable === true,
      access: ba.access === false ? false : ba.access === true ? true : null, paused: ba.paused === true,
      refresh_in_progress: ba.refreshInProgress === true, missing_bets: Number.isInteger(ba.missingBets) ? ba.missingBets : null,
      book: book ? ssCompact({ id: ssText(book.id, 60), name: ssText(book.name, 60), abbr: ssText(book.abbr, 10) }) : null,
      region: region ? ssCompact({ id: ssText(region.id, 60), name: ssText(region.name, 60), abbr: ssText(region.abbr, 10) }) : null,
      latest_refresh: rr ? ssCompact({ id: ssText(rr.id, 100), status: Number.isInteger(rr.status) ? rr.status : null, at: iso(rr.timeCreated),
        type: ssText(rr.type, 20), detail: ssText(rr.detail, 200) }) : null,
      requested_refresh: ssText(ba.latestRefreshRequestId, 100) };
  }
  function ssUrl(cfg, name, id, query) {
    var c = SHARPSPORTS.contract[name], path = c.path;
    if (path.indexOf('{id}') >= 0) {
      if (typeof id !== 'string' || !SS_ID.test(id)) throw codedError('PROVIDER_CONTRACT', { note: 'an id that cannot go in a path' });
      path = path.replace('{id}', encodeURIComponent(id));
    }
    return (cfg.api || SHARPSPORTS.api) + path + (query || '');
  }
  /* one request to SharpSports. 401/403 is EdgeDesk's key being refused (not
     the reader's); 404 is reported to the caller; the body never reaches a log */
  async function ssCall(ctx, cfg, name, id, opts) {
    opts = opts || {};
    var c = SHARPSPORTS.contract[name], key = c.key === 'public' ? cfg.publicKey : cfg.privateKey;
    if (!key) throw codedError('NOT_CONFIGURED');
    var url = opts.url || ssUrl(cfg, name, id, opts.query), r;
    var headers = { accept: 'application/json', authorization: 'Token ' + key };
    if (opts.body) headers['content-type'] = 'application/json';
    try { r = await ctx.fetch(url, { method: c.method, headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }); }
    catch (_) { throw codedError('PLATFORM_DOWN'); }
    var body = null;
    try { var t = await r.text(); body = t ? JSON.parse(t) : null; } catch (_) { body = undefined; }
    if (opts.raw) return { status: r.status, body: body };
    if (r.status === 401 || r.status === 403) throw codedError('PROVIDER_AUTH', { status: r.status });
    if (r.status === 429) throw codedError('RATE_LIMITED');
    if (r.status >= 500) throw codedError('PLATFORM_DOWN', { status: r.status });
    if (r.status === 404) return { status: 404, body: null };
    if (r.status < 200 || r.status > 299 || body === undefined) throw codedError('PROVIDER_CONTRACT', { status: r.status });
    return { status: r.status, body: body };
  }
  /* a list answer: an array, or an object holding one under data; a
     same-origin next link is followed when there is one */
  function ssRows(body) { return Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null; }
  function ssObject(body, prefix) {
    var o = body && typeof body === 'object' && !Array.isArray(body) ? (typeof body.id === 'string' ? body : body.data && typeof body.data === 'object' ? body.data : null) : null;
    return o && typeof o.id === 'string' && (!prefix || o.id.indexOf(prefix) === 0) ? o : null;
  }
  async function ssList(ctx, cfg, name, id, started) {
    var out = [], first = await ssCall(ctx, cfg, name, id);
    if (first.status === 404) return null;
    var page = first.body;
    for (var i = 0; i < SHARPSPORTS.pageCap; i++) {
      var rows = ssRows(page);
      if (rows == null) throw codedError('PROVIDER_CONTRACT', { note: 'not a list' });
      out = out.concat(rows);
      var next = page && !Array.isArray(page) && typeof page.next === 'string' ? page.next : null;
      if (!next || next.indexOf((cfg.api || SHARPSPORTS.api) + '/') !== 0 || !rows.length) break;
      if (overBudget(ctx, started)) throw codedError('TIMEOUT');
      page = (await ssCall(ctx, cfg, name, id, { url: next })).body;
    }
    return out;
  }
  async function ssBettorRef(ctx, cfg, userId, smokeTestId) {
    var rows = await ctx.rpc('portfolio_svc_ag_bettor', { p_provider: 'sharpsports', p_env: cfg.env, p_user: userId, p_smoke_test: smokeTestId || null });
    var ref = Array.isArray(rows) ? rows[0] : rows;
    if (!ref || !SS_INTERNAL.test(String(ref.internal_id || ''))) throw codedError('UNKNOWN', { note: 'no bettor reference' });
    return ref;
  }
  /* LINK: a fresh context for the reader's opaque internal id; the reader is
     sent to SharpSports' own page and comes back to redirectUrl */
  async function sharpsportsLink(ctx, cfg, o) {
    var ref = await ssBettorRef(ctx, cfg, o.userId, o.smokeTestId);
    var body = { internalId: ref.internal_id };
    if (o.redirectUrl) body.redirectUrl = o.redirectUrl;
    var r = await ssCall(ctx, cfg, 'context', null, { body: body });
    var cid = r.body && typeof r.body.cid === 'string' ? r.body.cid : null;
    if (!cid || !SS_ID.test(cid)) throw codedError('PROVIDER_CONTRACT', { note: 'no cid' });
    /* if the reader never comes back to the page, the scheduler still looks */
    await ctx.rpc('portfolio_svc_ag_bettor_discover_soon', { p_provider: 'sharpsports', p_env: cfg.env, p_user: o.userId, p_minutes: 3 });
    logSafe(ctx, 'sharpsports.link', { env: cfg.env });
    return { url: (cfg.ui || SHARPSPORTS.ui) + '/link/' + encodeURIComponent(cid) };
  }
  /* DISCOVER: the reader's linked accounts, as SharpSports' API lists them
     for the reader's own bettor. Each becomes (or refreshes) a platform
     account of its book; nothing from a webhook is trusted for this */
  async function sharpsportsDiscover(ctx, cfg, o) {
    var ref = await ssBettorRef(ctx, cfg, o.userId, o.smokeTestId), issues = [], accounts = [];
    var list = await ssList(ctx, cfg, 'bettorAccounts', ref.provider_bettor_id || ref.internal_id, ctx.now());
    for (var i = 0; i < (list || []).length; i++) {
      var ba = list[i];
      if (!ba || typeof ba.id !== 'string' || !SS_ID.test(ba.id)) { issues.push(bad('MALFORMED_ACCOUNT', '#' + i, 'SharpSports listed an account without an id.')); continue; }
      var bet = ba.bettor, bettorId = typeof bet === 'string' ? bet : bet && typeof bet === 'object' ? bet.id : null;
      var internal = bet && typeof bet === 'object' ? bet.internalId : null;
      if ((internal && internal !== ref.internal_id) || (ref.provider_bettor_id && bettorId && bettorId !== ref.provider_bettor_id)) {
        issues.push(bad('NOT_THIS_BETTOR', ba.id, 'SharpSports listed an account of another bettor; it was ignored.')); continue;
      }
      if (!ref.provider_bettor_id && typeof bettorId === 'string' && SS_ID.test(bettorId)) {
        await ctx.rpc('portfolio_svc_ag_bettor_confirm', { p_provider: 'sharpsports', p_env: cfg.env, p_internal_id: ref.internal_id, p_provider_bettor_id: bettorId });
        ref.provider_bettor_id = bettorId;
      }
      var st = ssAccountState(ba), map = ssBookPlatform(ba.book) || ssBookPlatform(ba.bookRegion);
      if (!map) { issues.push(bad('UNKNOWN_BOOK', ba.id, 'SharpSports did not name the book of a linked account, so it was not added.')); continue; }
      var up = await ctx.rpc('portfolio_svc_ag_account_upsert', { p_provider: 'sharpsports', p_env: cfg.env, p_user: o.userId, p_external_account_id: ba.id,
        p_platform: map.platform, p_platform_label: map.label, p_detail: st, p_smoke_test: o.smokeTestId || null }) || {};
      accounts.push({ account_id: up.account_id, created: !!up.created, platform: map.platform, label: map.label, verified: st.verified, access: st.access });
    }
    await ctx.rpc('portfolio_svc_ag_bettor_discovered', { p_provider: 'sharpsports', p_env: cfg.env, p_user: o.userId });
    logSafe(ctx, 'sharpsports.discover', { env: cfg.env, accounts: accounts.length, issues: issues.length });
    return { accounts: accounts, issues: issues, listed: list != null };
  }
  /* REFRESH: ask SharpSports to read the book now. Asynchronous: SharpSports
     answers later (refreshResponse.created), and the sync reads the result
     from the account itself. Never more often than p_min_minutes per account */
  async function sharpsportsRefresh(ctx, cfg, account, by, opts) {
    opts = opts || {};
    var rid = await ctx.rpc('portfolio_svc_ag_refresh_begin', { p_account: account.account_id, p_requested_by: by, p_min_minutes: opts.minMinutes || 15 });
    if (!rid) return { status: 'TOO_SOON' };
    var r;
    try { r = await ssCall(ctx, cfg, 'accountRefresh', account.external_account_id, { raw: true, query: opts.reverify ? '?reverify=true' : '' }); }
    catch (e) {
      await ctx.rpc('portfolio_svc_ag_refresh_update', { p_refresh: rid, p_status: 'FAILED', p_provider_request_id: null, p_code: e.code || 'PLATFORM_DOWN', p_message: ERRORS[e.code] || null });
      return { status: 'FAILED', error: readerError(e.code || 'PLATFORM_DOWN') };
    }
    var ok = r.status >= 200 && r.status <= 299, code = ok ? null : r.status === 429 ? 'RATE_LIMITED' : r.status === 404 ? 'PROVIDER_NOT_FOUND'
      : r.status === 401 || r.status === 403 ? 'PROVIDER_REFUSED' : r.status >= 500 ? 'PLATFORM_DOWN' : 'HTTP_' + r.status;
    var b = r.body && typeof r.body === 'object' ? r.body : {};
    var reqId = ssText(b.requestId || b.id, 100);
    await ctx.rpc('portfolio_svc_ag_refresh_update', { p_refresh: rid, p_status: ok ? 'ACCEPTED' : r.status === 429 ? 'REFUSED' : 'FAILED',
      p_provider_request_id: reqId, p_code: code, p_message: ok ? null : 'SharpSports did not start a refresh (' + (code || r.status) + ').' });
    /* a book that asks for a one-time code: SharpSports hands back a cid for its OTP page */
    var otp = ok && typeof b.cid === 'string' && SS_ID.test(b.cid) ? (cfg.ui || SHARPSPORTS.ui) + '/otp/' + encodeURIComponent(b.cid) : null;
    logSafe(ctx, 'sharpsports.refresh', { env: cfg.env, by: by, status: r.status });
    return { status: ok ? 'ACCEPTED' : 'REFUSED', code: code, otp_url: otp };
  }
  async function ingestWagerChunks(ctx, accountId, runId, payload) {
    var tot = { positions_inserted: 0, positions_updated: 0, positions_unchanged: 0, positions_settled: 0, positions_adopted: 0, rejected: 0,
      transactions_inserted: 0, transactions_unchanged: 0, healed: 0 }, issues = [];
    var ps = payload.positions || [];
    for (var i = 0; i < Math.max(1, ps.length); i += 200) {
      var chunk = { version: VERSION, positions: ps.slice(i, i + 200), issues: i === 0 ? (payload.issues || []).slice(0, 200) : [], fetched: i === 0 ? payload.fetched || 0 : 0 };
      var r = await ctx.rpc('portfolio_svc_ingest_wagers', { p_account: accountId, p_run: runId, p_payload: chunk }) || {};
      Object.keys(tot).forEach(function (k) { tot[k] += +r[k] || 0; });
      /* the database returns the payload's own issues with any it added */
      (r.issues || []).forEach(function (x) { if (x && issues.length < 200) issues.push(x); });
    }
    return { totals: tot, issues: issues };
  }
  /* SYNC ONE LINKED ACCOUNT: its state from SharpSports (verified, access,
     the latest refresh), its slips when there is something new to read, an
     optional scheduled refresh, and an honest finish */
  async function syncSharpSportsRun(ctx, account, runId, started, kind) {
    var cfg = ctx.sharpsports;
    if (!cfg || !cfg.privateKey) throw codedError('NOT_CONFIGURED');
    if (account.environment && account.environment !== cfg.env) throw codedError('ENV_MISMATCH');
    var cur = parseCursor(account.sync_cursor);
    var got = await ssCall(ctx, cfg, 'bettorAccount', account.external_account_id);
    var ba = ssObject(got.body, 'BACT_') || ssObject(got.body);
    if (!ba) throw codedError(got.status === 404 ? 'PROVIDER_NOT_FOUND' : 'PROVIDER_CONTRACT');
    var st = ssAccountState(ba);
    await ctx.rpc('portfolio_svc_ag_account_state', { p_account: account.account_id, p_detail: st });
    var rr = st.latest_refresh;
    if (rr && rr.id) {
      await ctx.rpc('portfolio_svc_ag_refresh_seen', { p_account: account.account_id, p_provider_response_id: rr.id, p_ok: rr.status === 200 || rr.status === 202,
        p_code: rr.status != null ? String(rr.status) : null, p_message: rr.detail || null, p_at: rr.at || null });
    }
    if (st.access === false) throw codedError('BOOK_INACCESSIBLE');
    var newRefresh = !!(rr && rr.id && rr.id !== cur.rres);
    var stale = !cur.full_at || (ctx.now() - Date.parse(cur.full_at)) > SHARPSPORTS.readEveryMs;
    var read = kind !== 'INCREMENTAL' || newRefresh || stale;
    var res = { totals: { positions_inserted: 0, positions_updated: 0, positions_unchanged: 0, positions_settled: 0, positions_adopted: 0, rejected: 0,
      transactions_inserted: 0, transactions_unchanged: 0, healed: 0 }, issues: [] }, fetched = 0, normal = { positions: [], issues: [], skipped: 0 };
    if (read) {
      var slips = await ssList(ctx, cfg, 'accountBetSlips', account.external_account_id, started);
      if (slips == null) throw codedError('PROVIDER_CONTRACT', { note: 'no slips list' });
      fetched = slips.length;
      normal = sharpsportsNormalize(slips, { platform: account.platform, platform_label: account.platform_label || null });
      res = await ingestWagerChunks(ctx, account.account_id, runId, { positions: normal.positions, issues: normal.issues, fetched: fetched });
    }
    /* an optional refresh on the operator's schedule — never more often than
       configured, never while one is running or the account cannot refresh */
    var refreshed = null;
    if (kind !== 'MANUAL' && cfg.scheduledRefreshMinutes > 0 && st.verified === true && st.access === true && !st.paused && !st.refresh_in_progress
        && (!rr || !rr.at || ctx.now() - Date.parse(rr.at) > cfg.scheduledRefreshMinutes * 60000)) {
      refreshed = await sharpsportsRefresh(ctx, cfg, account, 'SCHEDULER', { minMinutes: cfg.scheduledRefreshMinutes });
    }
    if (st.verified === false) throw codedError('RELINK_REQUIRED');
    var rec = { ok: !read || (res.totals.rejected === 0 && normal.skipped === 0), read: read, fetched: fetched, skipped: normal.skipped,
      stored: read ? res.totals.positions_inserted + res.totals.positions_updated + res.totals.positions_unchanged : null,
      provider: { verified: st.verified, access: st.access, paused: st.paused, missing_bets: st.missing_bets }, refresh: refreshed ? refreshed.status : null };
    var next = { v: 1, env: cfg.env, rres: rr && rr.id ? rr.id : cur.rres || null, full_at: read ? new Date(ctx.now()).toISOString() : cur.full_at || null };
    var issues = (res.issues || []).filter(function (x) { return x && x.code !== 'INCOMPLETE_SLIP'; });
    return { totals: res.totals, issues: issues, reconcile: rec, cursor: JSON.stringify(next) };
  }
  /* THE WEBHOOK, as a hint. Only what the docs name is read from a delivery —
     the id prefixes (BACT_, BTTR_, RRES_, SLIP_) and EdgeDesk's own internal
     id — wherever they sit in the body; nothing else in it is trusted */
  function sharpsportsWebhookRefs(text) {
    var s = String(text || ''), take = function (re, n) { var seen = []; (s.match(re) || []).forEach(function (x) { if (seen.indexOf(x) < 0 && seen.length < n) seen.push(x); }); return seen; };
    return { bettor_account_ids: take(/\bBACT_[A-Za-z0-9]{4,64}\b/g, 50), bettor_ids: take(/\bBTTR_[A-Za-z0-9]{4,64}\b/g, 10),
      internal_ids: take(/\bed_[0-9a-f]{32}\b/g, 10), refresh_response_ids: take(/\bRRES_[A-Za-z0-9]{4,64}\b/g, 10),
      slips: take(/\bSLIP_[A-Za-z0-9]{4,64}\b/g, 5000).length };
  }
  function hexOf(bytes) { var s = ''; bytes = new Uint8Array(bytes); for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }
  /* equal-length strings compared in constant time */
  function sameText(a, b) {
    a = String(a); b = String(b);
    if (!a.length || a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }
  /* SharpSports signs every post with HMAC-SHA256 under the subscription's
     hmac_secret (documented). The header that carries it and the exact
     string signed were not readable, so a post is accepted as signed when
     any header carries the HMAC of the raw body — hex or base64, with or
     without a "sha256=" prefix — under one of the configured secrets. The
     header found is reported, so the operator can pin it. */
  async function webhookSignature(rawBytes, headerPairs, secrets, pinned) {
    var subtle = cryptoApi().subtle, list = (secrets || []).filter(function (x) { return typeof x === 'string' && x.length >= 8; });
    for (var i = 0; i < list.length; i++) {
      var key = await subtle.importKey('raw', enc.encode(list[i]), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      var mac = new Uint8Array(await subtle.sign('HMAC', key, rawBytes));
      var hx = hexOf(mac), b = b64(mac), bu = b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      for (var j = 0; j < headerPairs.length; j++) {
        var name = String(headerPairs[j][0]).toLowerCase();
        if (pinned && name !== String(pinned).toLowerCase()) continue;
        var v = String(headerPairs[j][1] || '').trim().replace(/^sha256=/i, '');
        if (v.length > 200) continue;
        if (sameText(v.toLowerCase(), hx) || sameText(v, b) || sameText(v.replace(/=+$/, ''), bu)) return { ok: true, header: name, secret_index: i };
      }
    }
    return { ok: false, header: null };
  }

  /* one sync of one account: a run row, the platform's work, an honest finish */
  async function syncAccount(ctx, account, kind) {
    var started = ctx.now();
    var runId = await ctx.rpc('portfolio_svc_run_begin', { p_account: account.account_id, p_kind: kind || 'INCREMENTAL' });
    if (!runId) return { skipped: 'A sync for this account is already running.' };
    try {
      var prov = account.provider ? activeSportsbookProvider(ctx, account.provider) : null;
      var r = prov ? await prov.sync(ctx, account, runId, started, kind || 'INCREMENTAL')
        : account.provider ? (function () { throw codedError('SYNC_OFF'); }())
        : account.platform === 'kalshi' ? await syncKalshiRun(ctx, account, runId, started)
        : account.platform === 'polymarket' ? await syncPolymarketRun(ctx, account, runId, started)
        : (function () { throw codedError('DISABLED'); }());
      var status = r.totals.rejected || (r.issues && r.issues.length) || !r.reconcile.ok ? 'PARTIAL' : 'SUCCEEDED';
      await ctx.rpc('portfolio_svc_run_finish', { p_run: runId, p_status: status, p_error_code: null, p_error_message: null, p_cursor: r.cursor, p_reconcile: r.reconcile });
      logSafe(ctx, 'sync.done', { account: account.account_id, platform: account.platform, status: status, totals: r.totals, ms: ctx.now() - started });
      return { run_id: runId, status: status, totals: r.totals, reconcile: r.reconcile };
    } catch (e) {
      var code = e && e.code && ERRORS[e.code] ? e.code : 'UNKNOWN';
      try { await ctx.rpc('portfolio_svc_run_finish', { p_run: runId, p_status: 'FAILED', p_error_code: code, p_error_message: ERRORS[code], p_cursor: null, p_reconcile: null }); }
      catch (_) { /* the run is closed as stale after 15 minutes */ }
      logSafe(ctx, 'sync.failed', { account: account.account_id, platform: account.platform, code: code, error: String(e && e.message || e).slice(0, 200) });
      return { run_id: runId, status: 'FAILED', error: readerError(code) };
    }
  }
  /* the scheduler's pass: due accounts, one after another, inside the budget —
     platforms connected directly, then each aggregator configured on this
     server (its linked accounts in this server's environment only, and the
     bettors a webhook said have something new to list) */
  async function sweep(ctx, limit) {
    var started = ctx.now(), done = [];
    var left = function () { return Object.assign({}, ctx, { budgetMs: Math.max(5000, (ctx.budgetMs || 60000) - (ctx.now() - started)) }); };
    var due = (await ctx.rpc('portfolio_svc_due_accounts', { p_limit: limit || 10 })) || [];
    for (var i = 0; i < due.length; i++) {
      if (overBudget(ctx, started)) break;
      var a = due[i];
      var res = await syncAccount(left(), a, a.has_run ? 'INCREMENTAL' : 'INITIAL');
      done.push({ platform: a.platform, status: res.status || 'SKIPPED' });
    }
    var n = due.length, prov = activeSportsbookProvider(ctx, ctx.sportsbook), cfg = prov ? ctx[prov.key] : null;
    if (prov && cfg && cfg.privateKey && cfg.env) {
      var ag = (await ctx.rpc('portfolio_svc_ag_due', { p_provider: prov.key, p_env: cfg.env, p_limit: limit || 10 })) || [];
      n += ag.length;
      for (var j = 0; j < ag.length; j++) {
        if (overBudget(ctx, started)) break;
        var g = ag[j];
        if (g.kind === 'BETTOR') {
          try { var d = await prov.discover(left(), cfg, { userId: g.user_id }); done.push({ platform: prov.key, status: 'DISCOVERED', accounts: d.accounts.length }); }
          catch (e) { logSafe(ctx, prov.key + '.discover_failed', { code: e && e.code || 'UNKNOWN' }); done.push({ platform: prov.key, status: 'FAILED' }); }
          continue;
        }
        var acct = { account_id: g.account_id, user_id: g.user_id, platform: g.platform, external_account_id: g.external_account_id, sync_cursor: g.sync_cursor,
          provider: prov.key, environment: cfg.env };
        var res2 = await syncAccount(left(), acct, g.has_run ? 'INCREMENTAL' : 'INITIAL');
        done.push({ platform: g.platform, status: res2.status || 'SKIPPED' });
      }
    }
    return { due: n, done: done };
  }

  /* ── 11. SPORTSBOOK SYNC PROVIDERS ─────────────────────────────────────
     The seam that keeps a provider replaceable. A provider links a reader's
     sportsbook accounts on its OWN page (EdgeDesk never sees a sportsbook
     password), lists them, and returns their bets in EdgeDesk's normalized
     wager shape. Everything after that is shared by every provider and by
     CSV, screenshot and manual entry alike: portfolio_svc_ingest_wagers
     (dedupe by the provider's bet id, adoption of an imported twin, the
     settlement history), the derived P&L, analytics and the Portfolio UI.
     Replacing a provider = one adapter here + its rows in the function's
     handler table; no table, view or screen changes.

     At most ONE provider is active on a server: the one the
     SPORTSBOOK_SYNC_PROVIDER secret names (none by default). A provider that
     is not active syncs nothing, links nothing and answers no webhook; its
     linked accounts and their synced history stay readable. */
  var SPORTSBOOK_PROVIDER_CONTRACT = ['link', 'discover', 'sync', 'refresh', 'accountState', 'webhookRefs', 'normalize'];
  var SPORTSBOOK_PROVIDERS = {};
  function defineSportsbookProvider(spec) {
    var missing = SPORTSBOOK_PROVIDER_CONTRACT.filter(function (m) { return !spec || typeof spec[m] !== 'function'; });
    if (!spec || !/^[a-z][a-z0-9_]{1,30}$/.test(String(spec.key || ''))) missing.push('key');
    if (!spec || !spec.label || !spec.short) missing.push('label and short');
    if (!spec || !/^https:\/\/[a-z0-9.-]+$/.test(String(spec.link_origin || ''))) missing.push('link_origin (the https origin of its linking page)');
    if (!spec || ['ACTIVE', 'RETIRED'].indexOf(spec.status) < 0) missing.push('status');
    if (spec && spec.places_orders) missing.push('read-only (a provider never bets)');
    if (missing.length) throw new Error('sportsbook provider "' + (spec && spec.key) + '" is incomplete: ' + missing.join(', '));
    SPORTSBOOK_PROVIDERS[spec.key] = Object.freeze(Object.assign({}, spec));
    return SPORTSBOOK_PROVIDERS[spec.key];
  }
  function sportsbookProvider(key) { return Object.prototype.hasOwnProperty.call(SPORTSBOOK_PROVIDERS, key) ? SPORTSBOOK_PROVIDERS[key] : null; }
  /* the provider a request may use: registered, and the one this server switched on */
  function activeSportsbookProvider(ctx, key) {
    var on = ctx && ctx.sportsbook;
    return key && on && key === on ? sportsbookProvider(key) : null;
  }
  defineSportsbookProvider({
    key: 'sharpsports', label: SHARPSPORTS.label, short: 'SharpSports', link_origin: SHARPSPORTS.ui, what_the_reader_gives: SHARPSPORTS.what_the_reader_gives,
    status: 'RETIRED', status_note: 'Off since 2026-10-14: its $500/month minimum is above EdgeDesk\'s budget. The adapter stays so its synced history stays readable, and as the reference for the next provider.',
    link: sharpsportsLink, discover: sharpsportsDiscover, sync: syncSharpSportsRun, refresh: sharpsportsRefresh,
    accountState: ssAccountState, webhookRefs: sharpsportsWebhookRefs, normalize: sharpsportsNormalize
  });

  return {
    VERSION: VERSION, dec: dec,
    SPORTSBOOK_PROVIDER_CONTRACT: SPORTSBOOK_PROVIDER_CONTRACT, SPORTSBOOK_PROVIDERS: SPORTSBOOK_PROVIDERS, defineSportsbookProvider: defineSportsbookProvider,
    sportsbookProvider: sportsbookProvider, activeSportsbookProvider: activeSportsbookProvider,
    SOURCE_TYPES: SOURCE_TYPES, INGESTION_METHODS: INGESTION_METHODS, TIER: TIER, TIER_LABEL: TIER_LABEL, SMOKE_STAGES: SMOKE_STAGES,
    REGISTRY: REGISTRY, platformInfo: platformInfo, connectionOffer: connectionOffer, NO_SPORTSBOOK_API: NO_SPORTSBOOK_API,
    CONTRACT: CONTRACT, defineAdapter: defineAdapter, ERRORS: ERRORS, readerError: readerError, redact: redact,
    sealCredential: sealCredential, openCredential: openCredential, keyHint: keyHint, b64: b64, unb64: unb64,
    KALSHI: KALSHI, kalshiSigningString: kalshiSigningString, kalshiSigner: kalshiSigner, kalshiScopeVerdict: kalshiScopeVerdict,
    kalshiQuery: kalshiQuery, kalshiFillParts: kalshiFillParts, kalshiReplay: kalshiReplay, kalshiSettlement: kalshiSettlement,
    kalshiNormalize: kalshiNormalize, kalshiReportedNet: kalshiReportedNet, pkcs1ToPkcs8: pkcs1ToPkcs8,
    POLYMARKET: POLYMARKET, walletVerdict: walletVerdict, polymarketNormalize: polymarketNormalize,
    heldFromFills: heldFromFills, reconcile: reconcile, ingestPayload: ingestPayload, iso: iso,
    connectKalshi: connectKalshi, connectPolymarket: connectPolymarket, syncAccount: syncAccount, sweep: sweep, parseCursor: parseCursor,
    SHARPSPORTS: SHARPSPORTS, AGGREGATORS: AGGREGATORS, aggregatorInfo: aggregatorInfo, ssBookPlatform: ssBookPlatform, ssAccountState: ssAccountState,
    sharpsportsNormalize: sharpsportsNormalize, sharpsportsLink: sharpsportsLink, sharpsportsDiscover: sharpsportsDiscover, sharpsportsRefresh: sharpsportsRefresh,
    sharpsportsWebhookRefs: sharpsportsWebhookRefs, webhookSignature: webhookSignature, ssCall: ssCall, hexOf: hexOf
  };
}));
// ── END CONNECT CORE ────────────────────────────────────────────────────

const K = globalThis.EDPortfolioConnect;

function logLine(level, event, fields) {
  try { console.log(JSON.stringify({ fn: 'sharpsports-webhook', build: BUILD, level, event, at: new Date().toISOString(), fields: K.redact(fields || {}) })); }
  catch (_) { /* never let logging break a request */ }
}
async function fetchWithTimeout(url, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, init || {}, { signal: ctl.signal })); }
  finally { clearTimeout(t); }
}
function rpc(c) {
  return async function call(fn, args) {
    const r = await fetchWithTimeout(c.url + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: { apikey: c.serviceKey, authorization: 'Bearer ' + c.serviceKey, 'content-type': 'application/json' },
      body: JSON.stringify(args || {}) }, 6000);
    const text = await r.text();
    if (!r.ok) { const e = new Error('rpc ' + fn + ' ' + r.status); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : null;
  };
}
async function sha256Hex(text) {
  return K.hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
/* a refused delivery: counted, nothing of it kept */
async function reject(c, reason, status, message) {
  try { await rpc(c)('portfolio_svc_ag_webhook_reject', { p_provider: 'sharpsports', p_reason: reason }); } catch (_) { /* counting never blocks the answer */ }
  logLine('warn', 'rejected', { reason });
  return json({ ok: false, reason, message }, status);
}
/* the sync is portfolio_connect's: poke its sweep, which syncs only what the
   database says is due, without holding SharpSports' 10-second window */
function pokeSweep(c) {
  const p = fetchWithTimeout(c.url + '/functions/v1/portfolio_connect', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sweep' }) }, 120000).then((r) => r.text()).catch(() => null);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime && typeof EdgeRuntime.waitUntil === 'function') { EdgeRuntime.waitUntil(p); return null; }
  return Promise.race([p, new Promise((res) => setTimeout(res, 2500))]);
}

async function handle(req) {
  const c = config();
  if (req.method === 'GET') {
    return json({ ok: true, service: 'sharpsports-webhook', core: K.VERSION, active: c.active, environment: c.env,
      configured: { database: !!(c.url && c.serviceKey), subscription_secrets: Object.keys(c.secrets).length, verify: c.verify, pinned_header: !!c.pinned } });
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'method' }, 405);
  /* retired: answer at once, read nothing, store nothing */
  if (!c.active) return json({ ok: true, ignored: 'sync_off' });
  if (!c.url || !c.serviceKey) return json({ ok: false, reason: 'not_configured' }, 503);
  if (+(req.headers.get('content-length') || 0) > MAX_BODY) return reject(c, 'TOO_LARGE', 413, 'The body is over 256 KB.');
  let raw;
  try { raw = new Uint8Array(await req.arrayBuffer()); } catch (_) { return reject(c, 'UNREADABLE', 400, 'The body could not be read.'); }
  if (raw.length > MAX_BODY) return reject(c, 'TOO_LARGE', 413, 'The body is over 256 KB.');

  /* the signature, under the named subscription's OWN secret: a post naming
     a subscription EdgeDesk does not hold is never checked against the others */
  const sub = (req.headers.get('hook-subscription') || '').trim().toLowerCase().slice(0, 80) || null;
  const all = Object.keys(c.secrets).map((k) => c.secrets[k]);
  const mine = sub ? (c.secrets[sub] ? [c.secrets[sub]] : []) : all;
  let sig = { ok: false, header: null };
  if (mine.length) {
    const pairs = [];
    req.headers.forEach((v, k) => { pairs.push([k, v]); });
    try { sig = await K.webhookSignature(raw, pairs, mine, c.pinned); } catch (_) { sig = { ok: false, header: null }; }
  }
  if (c.verify === 'required' && !sig.ok) {
    return reject(c, !all.length ? 'NO_SECRET_CONFIGURED' : sub && !c.secrets[sub] ? 'UNKNOWN_SUBSCRIPTION' : 'BAD_SIGNATURE', 401,
      'This endpoint accepts only deliveries signed by SharpSports.');
  }

  const text = new TextDecoder().decode(raw);
  let body;
  try { body = JSON.parse(text); } catch (_) { return reject(c, 'NOT_JSON', 400, 'The body is not JSON.'); }
  if (!body || typeof body !== 'object') return reject(c, 'NOT_JSON', 400, 'The body is not a JSON object.');

  const refs = K.sharpsportsWebhookRefs(text);
  const type = typeof body.type === 'string' ? body.type.slice(0, 80) : typeof body.event === 'string' ? body.event.slice(0, 80) : 'unknown';
  const dedupe = await sha256Hex((sub || '') + '|' + text);
  /* the payload itself is kept only when SharpSports signed it */
  let payload = null;
  if (sig.ok) { const red = K.redact(body); payload = JSON.stringify(red).length <= 30000 ? red : { note: 'payload too large to keep', slips: refs.slips }; }
  const call = rpc(c);
  let rec;
  try {
    rec = await call('portfolio_svc_ag_webhook_record', { p_provider: 'sharpsports', p_env: c.env, p_dedupe_key: dedupe, p_event_type: type,
      p_authenticated_by: sig.ok ? 'SIGNATURE' : 'FETCH_BACK', p_refs: { bettor_account_ids: refs.bettor_account_ids, bettor_ids: refs.bettor_ids,
        internal_ids: refs.internal_ids, refresh_response_ids: refs.refresh_response_ids, slips: refs.slips },
      p_payload: payload, p_signature_header: sig.ok ? sig.header : null, p_subscription_id: sub });
  } catch (e) {
    logLine('error', 'record_failed', { status: e && e.status || null });
    return json({ ok: false, reason: 'unavailable' }, 503);
  }
  if (rec && rec.duplicate) {
    logLine('info', 'duplicate', { type, attempts: rec.attempts });
    return json({ ok: true, duplicate: true });
  }
  let applied;
  try { applied = await call('portfolio_svc_ag_webhook_apply', { p_event: rec.event_id }); }
  catch (e) {
    try { await call('portfolio_svc_ag_webhook_finish', { p_event: rec.event_id, p_status: 'FAILED', p_error_code: 'APPLY_FAILED', p_error_message: null }); } catch (_) { /* stays RECEIVED */ }
    logLine('error', 'apply_failed', { type, status: e && e.status || null });
    return json({ ok: false, reason: 'not_applied' }, 500);
  }
  const marked = (+applied.accounts_marked || 0) + (+applied.bettors_marked || 0);
  if (marked > 0) await pokeSweep(c);
  logLine('info', 'delivery', { type, signed: sig.ok, header: sig.header, status: applied.status, accounts: applied.accounts_marked, bettors: applied.bettors_marked });
  return json({ ok: true, status: applied.status, accounts_marked: +applied.accounts_marked || 0, bettors_marked: +applied.bettors_marked || 0 });
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') Deno.serve(handle);
