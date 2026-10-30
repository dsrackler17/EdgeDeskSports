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
