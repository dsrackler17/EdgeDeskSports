// @ts-nocheck — a plain JavaScript core (lib/novig_signing.js) inlined in a .ts file.
// ============================================================
//  FILE:    supabase/functions/novig_key_bootstrap/index.ts
//  TYPE:    Edge Function — TRANSIENT, privileged: registers EdgeDesk's
//           read-only Novig keys with the management key
//  DEPLOY:  ONLY by .github/workflows/novig-provision.yml, for the length of
//           one run: deployed, called, then DELETED (and its one-time secret
//           unset) in an always() step. It is never left running.
//  DOCS:    docs/novig/README.md §Credentials
// ============================================================
// WHY IT EXISTS. Novig creates every key below `management` through a route
// that only the management key may sign (POST /v3/keys,
// POST /v3/account/subaccounts/{keyId}/keys). The management key's private
// half lives only in this project's Edge Function secrets
// (NOVIG_MANAGEMENT_KEY_ID, NOVIG_MANAGEMENT_PRIVATE_KEY), so the signing
// has to happen here. The new keypair is generated on the GitHub runner;
// only its PUBLIC half is sent to this function and on to Novig. The private
// half goes from the runner straight into Edge Function secrets with
// `supabase secrets set` and is shredded; it never reaches this function,
// a log, the repository or the database.
//
// WHAT IT DOES (POST, header x-bootstrap-secret = NOVIG_BOOTSTRAP_SECRET, a
// value the workflow generates for one run and unsets after):
//   whoami          the management key signs POST /v3/echo on production AND
//                   paper: a key works only in its own environment, so the
//                   one that answers 200 is the key's environment. Then, on
//                   that environment, GET /v3/keys (name, scope, fingerprint,
//                   created/expiry — no secret exists in the list) and
//                   GET /v3/account/subaccounts (key id and label; the balance
//                   is not returned)
//   register_read   POST /v3/keys with {name, publicKey, algorithm}: Novig
//                   always issues management::read from this route (it takes
//                   no scope). The fingerprint Novig returns must equal the
//                   SHA-256 of the SPKI we sent, or the result is refused
//   register_stream POST /v3/account/subaccounts/{keyId}/keys with scope
//                   trading::read, ONLY for a subaccount that already exists
//                   (it must appear in GET /v3/account/subaccounts). It never
//                   opens a subaccount (POST /v3/account/subaccounts mints a
//                   TRADING key) and never mints `trading`
// WHAT IT NEVER DOES: place, cancel or read orders; move money; open a
// subaccount; revoke or rotate any key (the management key above all);
// accept a private key (a body carrying one is refused); log or return a
// signature, a key or the management key id.
// ============================================================

const BUILD = "novig_key_bootstrap@2026-10-30.1";
const UA = "edgedesk-provisioning/1.0 (+https://edgedesksports.com)";

// ── BEGIN NOVIG CORE ── lib/novig_signing.js, copied by tools/novig/inline.js; do not edit here
// ---- lib/novig_signing.js
/* ===========================================================================
   EdgeDesk — NOVIG-V3 REQUEST SIGNING (server side only).

   Novig signs every v3 request, GET included, with three headers:
     Novig-Key-Id      the key's UUID (not a secret)
     Novig-Timestamp   Unix milliseconds, unpadded decimal, within ±30 s of
                       Novig's clock (GET /v3/time)
     Novig-Signature   standard padded base64 of the raw signature bytes
   over a six-line string (https://docs.novig.com/api/signing.md):
     NOVIG-V3 \n {unix_millis} \n {METHOD} \n {path} \n {canonical_query} \n
     {lowercase_hex(sha256(raw_body))}
   joined by LF, no trailing newline. Ed25519 signs the string itself (64
   bytes); P-256 is ECDSA prime256v1 + SHA-256, DER-encoded SEQUENCE { r, s }.
   WebCrypto returns ECDSA as raw r‖s, which never verifies, so it is
   converted to DER here.

   Tested against all 30 of Novig's published vectors
   (tools/novig/fixtures/signing-vectors.public.json, tools/novig/signing.test.js).

   WHY NO PACKAGE. Every script here runs on a bare Node install (AGENTS.md
   §2), and the edge runtime is Deno: both ship WebCrypto with Ed25519 and
   ECDSA P-256 and SHA-256, which is all this needs. No hand-rolled
   cryptography: the primitives are the runtime's; this file only builds the
   string Novig specifies and moves bytes between encodings.

   SECRETS. The private key is read once into a non-extractable CryptoKey.
   No function here logs, returns or embeds key material, the string to sign
   or the signature in an error message; errors name the problem only.

   Usable in Node (require), Deno (inlined into supabase/functions/novig_*
   by tools/novig/inline.js, drift-tested) and a browser (window.NovigSigning,
   never given a key: nothing in the browser signs).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NovigSigning = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var SCHEME = 'NOVIG-V3';
  var MAX_SKEW_MS = 30000;
  var EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  var HOSTS = { production: 'https://api.novig.com', paper: 'https://api.paper.novig.com' };

  function subtle() {
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (!c || !c.subtle) throw new Error('NOVIG-V3: WebCrypto (crypto.subtle) is not available in this runtime');
    return c.subtle;
  }
  var enc = new TextEncoder();
  function utf8(s) { return enc.encode(String(s)); }
  function toBytes(body) {
    if (body === null || body === undefined || body === '') return new Uint8Array(0);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return utf8(body);
  }
  function hex(bytes) {
    var b = new Uint8Array(bytes), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return out;
  }
  function b64(bytes) {
    var b = new Uint8Array(bytes), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function unb64(s) {
    var t = atob(String(s).replace(/[\s]/g, '')), out = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
    return out;
  }

  /* ------------------------------------------------------------ the canonical query
     1 split on '&'; 2 split each pair at the FIRST '=' (no '=' -> empty value);
     3 decode only %XX, as UTF-8 bytes (a bare '+' stays '+'); 4 re-encode,
     keeping ALPHA DIGIT - . _ ~ and writing every other byte as %XX upper
     case; 5 sort by encoded name, then encoded value, keeping repeats;
     6 join with '&'. An absent query is the empty string. */
  function isHex(c) { return /^[0-9A-Fa-f]$/.test(c); }
  function decodePercent(part) {
    var raw = utf8(part), out = [];
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] === 0x25 && i + 2 < raw.length
          && isHex(String.fromCharCode(raw[i + 1])) && isHex(String.fromCharCode(raw[i + 2]))) {
        out.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
        i += 2;
      } else out.push(raw[i]);
    }
    return out;
  }
  function encodeBytes(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      var keep = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
      s += keep ? String.fromCharCode(b) : '%' + (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
    }
    return s;
  }
  function canonicalPart(part) { return encodeBytes(decodePercent(part)); }
  function canonicalQuery(raw) {
    var q = raw === null || raw === undefined ? '' : String(raw);
    if (q.charAt(0) === '?') q = q.slice(1);
    if (!q) return '';
    var pairs = [];
    q.split('&').forEach(function (p) {
      if (!p) return;
      var i = p.indexOf('=');
      var name = i < 0 ? p : p.slice(0, i), value = i < 0 ? '' : p.slice(i + 1);
      pairs.push([canonicalPart(name), canonicalPart(value)]);
    });
    /* encoded parts are ASCII, so code-unit order is byte order */
    pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; });
    return pairs.map(function (x) { return x[0] + '=' + x[1]; }).join('&');
  }
  /* a query string to SEND: every value encoded the same way, so the bytes
     on the wire canonicalize to themselves */
  function buildQuery(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { parts.push(encodeBytes(utf8(k)) + '=' + encodeBytes(utf8(String(x)))); });
    });
    return parts.join('&');
  }

  async function sha256Hex(body) {
    var bytes = toBytes(body);
    if (!bytes.length) return EMPTY_SHA256;
    return hex(await subtle().digest('SHA-256', bytes));
  }

  function validateTimestamp(ts) {
    var s = String(ts);
    if (!/^[1-9][0-9]*$/.test(s)) throw new Error('NOVIG-V3: the timestamp must be unpadded decimal Unix milliseconds');
    return s;
  }
  function validatePath(path) {
    var p = String(path || '');
    if (p.charAt(0) !== '/' || /^\/\//.test(p) || /[?#]/.test(p) || /^[a-z]+:/i.test(p)) throw new Error('NOVIG-V3: sign the path only (leading /, no host, no query)');
    return p;
  }

  /** the six lines, joined by LF, no trailing newline */
  async function stringToSign(o) {
    var lines = [SCHEME, validateTimestamp(o.timestamp), String(o.method || '').toUpperCase(), validatePath(o.path),
      canonicalQuery(o.query), o.bodyHash || await sha256Hex(o.body)];
    if (!/^[A-Z]+$/.test(lines[2])) throw new Error('NOVIG-V3: the method must be ASCII letters');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------ keys
     A PKCS#8 PEM, as Novig's Profile screen and `openssl genpkey` write it.
     Secrets stores often flatten newlines to a literal "\n", or keep only the
     base64 body: both are accepted. The algorithm is read from the key's own
     OID, never from configuration, so a key cannot be used as the other kind. */
  var OID_ED25519 = [0x06, 0x03, 0x2b, 0x65, 0x70];
  var OID_EC = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
  var OID_P256 = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
  function hasSeq(bytes, seq) {
    outer: for (var i = 0; i + seq.length <= bytes.length; i++) {
      for (var j = 0; j < seq.length; j++) if (bytes[i + j] !== seq[j]) continue outer;
      return true;
    }
    return false;
  }
  function pemBody(pem, label) {
    var t = String(pem === null || pem === undefined ? '' : pem).replace(/\\n/g, '\n').replace(/\r/g, '').trim();
    if (!t) throw new Error('NOVIG-V3: no ' + label + ' was given');
    if (/-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )PRIVATE KEY-----/.test(t)) throw new Error('NOVIG-V3: the ' + label + ' must be an unencrypted PKCS#8 PEM ("BEGIN PRIVATE KEY"), Ed25519 or P-256');
    var m = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(t);
    var body = m ? m[2] : t;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) throw new Error('NOVIG-V3: the ' + label + ' is not PEM or base64');
    return { kind: m ? m[1] : null, der: unb64(body) };
  }
  function algorithmOfDer(der) {
    if (hasSeq(der, OID_ED25519)) return 'Ed25519';
    if (hasSeq(der, OID_EC) && hasSeq(der, OID_P256)) return 'P-256';
    return null;
  }
  async function importPrivateKey(pem) {
    var p = pemBody(pem, 'private key');
    if (p.kind && p.kind !== 'PRIVATE KEY') throw new Error('NOVIG-V3: expected a "PRIVATE KEY" PEM, got "' + p.kind + '"');
    var alg = algorithmOfDer(p.der);
    if (!alg) throw new Error('NOVIG-V3: the private key is neither Ed25519 nor P-256 (Novig accepts only those)');
    var key;
    try {
      key = await subtle().importKey('pkcs8', p.der, alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    } catch (_) {
      throw new Error('NOVIG-V3: the ' + alg + ' private key could not be imported (not valid PKCS#8)');
    }
    return { algorithm: alg, key: key };
  }
  async function importPublicKey(pem) {
    var p = pemBody(pem, 'public key');
    if (p.kind && p.kind !== 'PUBLIC KEY') throw new Error('NOVIG-V3: expected a "PUBLIC KEY" (SPKI) PEM');
    var alg = algorithmOfDer(p.der);
    if (!alg) throw new Error('NOVIG-V3: the public key is neither Ed25519 nor P-256');
    var key = await subtle().importKey('spki', p.der, alg === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    return { algorithm: alg, key: key, der: p.der };
  }
  /** Novig's fingerprint of a public key: sha256 of the SPKI DER ("sha256:<hex>") */
  async function spkiFingerprint(pem) {
    var p = pemBody(pem, 'public key');
    return 'sha256:' + hex(await subtle().digest('SHA-256', p.der));
  }

  /* ------------------------------------------------------------ ECDSA encodings */
  function derInt(bytes) {
    var i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    var v = Array.prototype.slice.call(bytes, i);
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length].concat(v);
  }
  /** WebCrypto's raw r‖s (64 bytes) -> DER SEQUENCE { INTEGER r, INTEGER s } */
  function p1363ToDer(sig) {
    var b = new Uint8Array(sig);
    if (b.length !== 64) throw new Error('NOVIG-V3: a P-256 raw signature is 64 bytes');
    var body = derInt(b.slice(0, 32)).concat(derInt(b.slice(32)));
    return new Uint8Array([0x30, body.length].concat(body));
  }
  /** DER -> raw r‖s, for verifying with WebCrypto */
  function derToP1363(der) {
    var b = new Uint8Array(der), i = 0;
    if (b[i++] !== 0x30) throw new Error('NOVIG-V3: not a DER signature');
    if (b[i] & 0x80) i += 1 + (b[i] & 0x7f); else i++;
    function int() {
      if (b[i++] !== 0x02) throw new Error('NOVIG-V3: not a DER integer');
      var n = b[i++], v = b.slice(i, i + n); i += n;
      while (v.length > 32 && v[0] === 0) v = v.slice(1);
      if (v.length > 32) throw new Error('NOVIG-V3: integer too long for P-256');
      var out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
    }
    var r = int(), s = int(), raw = new Uint8Array(64);
    raw.set(r, 0); raw.set(s, 32);
    return raw;
  }

  async function signString(s, k) {
    if (!k || !k.key || !k.algorithm) throw new Error('NOVIG-V3: no signing key');
    if (k.algorithm === 'Ed25519') return b64(await subtle().sign({ name: 'Ed25519' }, k.key, utf8(s)));
    return b64(p1363ToDer(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, k.key, utf8(s))));
  }
  async function verifyString(s, signatureB64, pub) {
    var sig = unb64(signatureB64);
    if (pub.algorithm === 'Ed25519') return subtle().verify({ name: 'Ed25519' }, pub.key, sig, utf8(s));
    return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, pub.key, derToP1363(sig), utf8(s));
  }

  /* ------------------------------------------------------------ one signed request
     Returns the URL, the headers and the exact body bytes to send: what is
     signed is what is sent, so the two can never disagree. `clockOffsetMs`
     is Novig's clock minus ours (from GET /v3/time). */
  async function signRequest(o) {
    if (!o || !o.keyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(o.keyId))) throw new Error('NOVIG-V3: the key id must be the key\'s UUID');
    var method = String(o.method || 'GET').toUpperCase();
    var path = validatePath(o.path);
    var query = typeof o.query === 'string' ? (o.query.charAt(0) === '?' ? o.query.slice(1) : o.query) : buildQuery(o.query);
    var bodyBytes = o.body === undefined || o.body === null ? new Uint8Array(0) : toBytes(typeof o.body === 'string' || o.body instanceof Uint8Array ? o.body : JSON.stringify(o.body));
    var ts = String(Math.round((o.nowMs === undefined ? Date.now() : o.nowMs) + (o.clockOffsetMs || 0)));
    var s = await stringToSign({ timestamp: ts, method: method, path: path, query: query, body: bodyBytes });
    var headers = { 'Novig-Key-Id': String(o.keyId), 'Novig-Timestamp': ts, 'Novig-Signature': await signString(s, o.signer) };
    /* without a content type the server hashes zero bytes, not the body */
    if (bodyBytes.length) headers['Content-Type'] = 'application/json';
    var base = String(o.host || '').replace(/\/$/, '');
    return { url: base + path + (query ? '?' + query : ''), method: method, headers: headers, body: bodyBytes.length ? bodyBytes : undefined, timestamp: ts };
  }

  /** a header set safe to log: the signature and key id never are */
  function redactHeaders(h) {
    var out = {};
    Object.keys(h || {}).forEach(function (k) {
      out[k] = /signature|key-id|authorization|apikey|secret|token/i.test(k) ? '[redacted]' : h[k];
    });
    return out;
  }

  /* ------------------------------------------------------------ the clock
     offset = Novig's clock minus ours, corrected by half the round trip. */
  function clockOffset(localBeforeMs, localAfterMs, serverTs) {
    var mid = (localBeforeMs + localAfterMs) / 2;
    return Math.round(Number(serverTs) - mid);
  }
  function skewState(offsetMs) {
    var a = Math.abs(offsetMs);
    return a > MAX_SKEW_MS ? 'outside_window' : a > MAX_SKEW_MS / 3 ? 'drifting' : 'ok';
  }

  function hostFor(environment) {
    if (!Object.prototype.hasOwnProperty.call(HOSTS, environment)) throw new Error('NOVIG-V3: the environment must be production or paper');
    return HOSTS[environment];
  }

  return {
    SCHEME: SCHEME, MAX_SKEW_MS: MAX_SKEW_MS, EMPTY_SHA256: EMPTY_SHA256, HOSTS: HOSTS,
    canonicalQuery: canonicalQuery, buildQuery: buildQuery, sha256Hex: sha256Hex, stringToSign: stringToSign,
    importPrivateKey: importPrivateKey, importPublicKey: importPublicKey, spkiFingerprint: spkiFingerprint,
    algorithmOfDer: algorithmOfDer, p1363ToDer: p1363ToDer, derToP1363: derToP1363,
    signString: signString, verifyString: verifyString, signRequest: signRequest, redactHeaders: redactHeaders,
    clockOffset: clockOffset, skewState: skewState, hostFor: hostFor,
  };
});
// ── END NOVIG CORE ──

// deno-lint-ignore no-explicit-any
type Any = any;
const G: Any = globalThis as Any;
const NS: Any = G.NovigSigning;
const env = (k: string): string => (G.Deno?.env.get(k) ?? "");
const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
export const hooks: Any = { now: () => Date.now() };
function deadline(ms: number): AbortSignal | undefined { try { return (AbortSignal as Any).timeout(ms); } catch { return undefined; } }

let MGMT: Any = null;
async function mgmt() {
  if (MGMT) return MGMT;
  if (!/^[0-9a-f-]{36}$/i.test(env("NOVIG_MANAGEMENT_KEY_ID"))) throw new Error("NOVIG_MANAGEMENT_KEY_ID is not set to a key UUID");
  MGMT = await NS.importPrivateKey(env("NOVIG_MANAGEMENT_PRIVATE_KEY"));
  return MGMT;
}
/** one request signed by the management key; Novig's error code and message, never our headers */
async function call(environment: string, method: string, path: string, body?: string) {
  const signer = await mgmt();
  const s = await NS.signRequest({ host: NS.hostFor(environment), keyId: env("NOVIG_MANAGEMENT_KEY_ID"), signer, method, path, query: "", body, nowMs: hooks.now() });
  const r = await fetch(s.url, { method, headers: { ...s.headers, accept: "application/json", "user-agent": UA }, body: s.body, signal: deadline(15000) });
  const text = await r.text();
  let json: Any = null; try { json = text ? JSON.parse(text) : null; } catch { /* HTML from the edge */ }
  return { status: r.status, json, code: json && json.code ? String(json.code) : null, message: json && json.message ? String(json.message).slice(0, 200) : (r.ok ? null : text.slice(0, 120)) };
}
const fail = (status: number, error: string, detail?: Any) => Response.json({ ok: false, error, detail: detail ?? null }, { status });

/** which environment this management key belongs to: echo on both */
async function whoami() {
  const probes: Any = {};
  for (const e of ["production", "paper"]) {
    try { const r = await call(e, "POST", "/v3/echo", '{"bootstrap":"whoami"}'); probes[e] = { status: r.status, code: r.code, message: r.status === 200 ? "ok" : r.message }; }
    catch (x) { probes[e] = { status: 0, message: msg(x) }; }
  }
  const ok = Object.keys(probes).filter((e) => probes[e].status === 200);
  const environment = ok.length === 1 ? ok[0] : ok.length === 2 ? "both" : "unknown";
  const out: Any = { ok: ok.length === 1, environment, probes };
  if (ok.length === 1) {
    const k = await call(environment, "GET", "/v3/keys");
    out.keys = k.status === 200 ? (Array.isArray(k.json) ? k.json : (k.json && k.json.items) || []).map((x: Any) => ({ key_id: x.keyId, name: x.name, scope: x.scope, algorithm: x.algorithm, fingerprint: x.fingerprint,
      restriction: x.restriction ?? null, created_at: x.createdAt, expires_at: x.expiresAt ?? null, is_management_key: x.keyId === env("NOVIG_MANAGEMENT_KEY_ID") })) : { error: k.status + " " + (k.code || k.message) };
    const s = await call(environment, "GET", "/v3/account/subaccounts");
    out.subaccounts = s.status === 200 ? (Array.isArray(s.json) ? s.json : (s.json && s.json.items) || []).map((x: Any) => ({ key_id: x.keyId, label: x.label })) : { error: s.status + " " + (s.code || s.message) };
  }
  if (environment === "unknown") out.hint = "neither environment accepted the management key: check NOVIG_MANAGEMENT_KEY_ID / NOVIG_MANAGEMENT_PRIVATE_KEY, the key holder's geolocation (451) and the clock";
  return out;
}

/** the public key a request carries: an SPKI PEM, Ed25519 or P-256, never a private key */
async function publicKeyOf(b: Any) {
  const pem = String(b.public_key_pem || "");
  if (/PRIVATE KEY/.test(pem) || /^MC4CAQAw|^MIGHAgEA/.test(pem.trim())) throw new Error("that is a PRIVATE key: send only the public half (openssl pkey -pubout)");
  const pub = await NS.importPublicKey(pem);
  return { pem: pem.replace(/\r/g, "").trim() + "\n", algorithm: pub.algorithm, fingerprint: await NS.spkiFingerprint(pem) };
}
const ENVS = ["production", "paper"];

export async function handle(req: Request): Promise<Response> {
  if (req.method === "GET") return Response.json({ ok: true, build: BUILD, transient: true });
  if (req.method !== "POST") return fail(405, "method");
  const secret = env("NOVIG_BOOTSTRAP_SECRET");
  if (!secret || secret.length < 32) return fail(401, "unauthorized", "NOVIG_BOOTSTRAP_SECRET is not set: this function only answers inside a provisioning run");
  const got = req.headers.get("x-bootstrap-secret") ?? "";
  let d = got.length === secret.length ? 0 : 1;
  for (let i = 0; i < Math.min(got.length, secret.length); i++) d |= got.charCodeAt(i) ^ secret.charCodeAt(i);
  if (d !== 0) return fail(401, "unauthorized");
  const b: Any = await req.json().catch(() => ({}));
  try {
    if (b.action === "whoami") return Response.json(await whoami());
    if (b.action === "register_read" || b.action === "register_stream") {
      if (!ENVS.includes(b.environment)) return fail(400, "environment must be production or paper (run whoami first; it is never guessed)");
      const name = String(b.name || (b.action === "register_read" ? "edgedesk-ingest-read" : "edgedesk-stream-read")).slice(0, 64);
      let pk: Any;
      try { pk = await publicKeyOf(b); } catch (e) { return fail(400, "bad_public_key", msg(e)); }
      let path = "/v3/keys", body: Any = { name, publicKey: pk.pem, algorithm: pk.algorithm };
      if (b.action === "register_stream") {
        const sub = String(b.subaccount_key_id || "");
        const list = await call(b.environment, "GET", "/v3/account/subaccounts");
        const subs = list.status === 200 ? (Array.isArray(list.json) ? list.json : (list.json && list.json.items) || []) : null;
        if (!subs) return fail(502, "subaccounts_unreadable", list.status + " " + (list.code || list.message));
        if (!subs.some((x: Any) => x.keyId === sub)) return fail(400, "not_an_existing_subaccount", "subaccount_key_id must name a subaccount that already exists; this function never opens one");
        path = "/v3/account/subaccounts/" + sub + "/keys";
        body = Object.assign(body, { scope: "trading::read" });
      }
      const r = await call(b.environment, "POST", path, JSON.stringify(body));
      if (r.status !== 201 && r.status !== 200) return fail(r.status === 451 || r.status === 423 ? r.status : 502, "novig_refused", { status: r.status, code: r.code, message: r.message });
      const keyId = r.json && r.json.keyId, fp = r.json && r.json.fingerprint;
      const norm = (f: string) => String(f || "").replace(/^sha256:/, "").toLowerCase();
      if (!keyId || norm(fp) !== norm(pk.fingerprint)) return fail(502, "fingerprint_mismatch", "Novig's fingerprint for the new key is not the SHA-256 of the key that was sent; do not use it");
      return Response.json({ ok: true, environment: b.environment, key_id: keyId, fingerprint: pk.fingerprint, algorithm: pk.algorithm,
        scope: b.action === "register_read" ? "management::read" : "trading::read", name });
    }
    return fail(400, "action must be whoami, register_read or register_stream");
  } catch (e) {
    return fail(500, "bootstrap_error", msg(e));
  }
}
if (typeof G.Deno !== "undefined" && G.Deno.serve) G.Deno.serve(handle);
