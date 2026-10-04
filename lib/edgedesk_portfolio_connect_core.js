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
     7. RECONCILIATION: our derived holdings against the platform's own.

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
    MALFORMED: 'Some records from the platform could not be read; they are listed with the sync and were not guessed at.',
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
    /* a redeemed (closed) winner: its redemption paid out what it held */
    Object.keys(pos).forEach(function (k) {
      var p = pos[k], rd = p.condition_id ? redeems[p.condition_id] : null;
      if (!p.closed || p.resolution || !rd) return;
      var paid = rd.reduce(function (s, a) { return s + (dec.micro(a.usdc_size || a.usdcSize || '0') || 0n); }, 0n);
      var held = p.fills.reduce(function (s, f) { return s + (f.action === 'BUY' ? dec.micro(f.quantity) : -dec.micro(f.quantity)); }, 0n);
      if (held <= 0n) return;
      if (paid > 0n) { p.resolution = p.side; p.settlement_price = '1'; p.settled_at = iso(rd[rd.length - 1].timestamp); }
      else if (paid === 0n) { p.resolution = 'OTHER OUTCOME'; p.settlement_price = '0'; p.settled_at = iso(rd[rd.length - 1].timestamp); }
    });
    var list = Object.keys(pos).sort().map(function (k) { var p = pos[k]; delete p.closed; return p; });
    list.forEach(function (p) {
      var held = p.fills.reduce(function (s, f) { return s + (f.action === 'BUY' ? dec.micro(f.quantity) : -dec.micro(f.quantity)); }, 0n);
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

  return {
    VERSION: VERSION, dec: dec,
    SOURCE_TYPES: SOURCE_TYPES, INGESTION_METHODS: INGESTION_METHODS, TIER: TIER, TIER_LABEL: TIER_LABEL, SMOKE_STAGES: SMOKE_STAGES,
    REGISTRY: REGISTRY, platformInfo: platformInfo, connectionOffer: connectionOffer, NO_SPORTSBOOK_API: NO_SPORTSBOOK_API,
    CONTRACT: CONTRACT, defineAdapter: defineAdapter, ERRORS: ERRORS, readerError: readerError, redact: redact,
    sealCredential: sealCredential, openCredential: openCredential, keyHint: keyHint, b64: b64, unb64: unb64,
    KALSHI: KALSHI, kalshiSigningString: kalshiSigningString, kalshiSigner: kalshiSigner, kalshiScopeVerdict: kalshiScopeVerdict,
    kalshiQuery: kalshiQuery, kalshiFillParts: kalshiFillParts, kalshiReplay: kalshiReplay, kalshiSettlement: kalshiSettlement,
    kalshiNormalize: kalshiNormalize, kalshiReportedNet: kalshiReportedNet, pkcs1ToPkcs8: pkcs1ToPkcs8,
    POLYMARKET: POLYMARKET, walletVerdict: walletVerdict, polymarketNormalize: polymarketNormalize,
    heldFromFills: heldFromFills, reconcile: reconcile, ingestPayload: ingestPayload, iso: iso
  };
}));
