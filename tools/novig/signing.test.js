#!/usr/bin/env node
/* ===========================================================================
   lib/novig_signing.js — NOVIG-V3, against Novig's own published vectors.

     vectors     all 30 of tools/novig/fixtures/signing-vectors.public.json:
                 our string to sign equals Novig's, byte for byte, and Novig's
                 published signature verifies, with Novig's published public
                 key, over OUR string (Ed25519 and P-256)
     canonical   every divergence the vectors name (absent query, empty body,
                 + vs %20, hex case, sort by name then value, repeats, bare
                 param, '=' in a value, non-ASCII, trailing slash, % in path)
     keys        a PKCS#8 PEM, the same PEM with its newlines flattened to
                 "\n", and the bare base64 body all import; the algorithm is
                 read from the key's OID; RSA, an SPKI public key and garbage
                 are refused; no error message carries key material
     sign        a signed request verifies with the key's public half, P-256
                 signatures are DER (not raw r‖s), a wrong key does not verify,
                 the body bytes hashed are the bytes sent with a content type,
                 a GET carries no body and the hash of zero bytes
     clock       the offset from GET /v3/time, the ±30 s window, an unpadded
                 timestamp; the environment host table refuses anything else
     redaction   the signature and key id never reach a log line

   No private key is committed: the vectors' published test keys were removed
   from the fixture; every key signed with here is generated in the test.

   Run: node tools/novig/signing.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const S = require(path.join(__dirname, '..', '..', 'lib', 'novig_signing.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
async function throwsAsync(fn, re) { try { await fn(); return false; } catch (e) { return re ? re.test(String(e && e.message)) : true; } }

const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'signing-vectors.public.json'), 'utf8'));

(async () => {
  /* ---------------------------------------------------------------- the published vectors */
  chk('fixture: 30 vectors, two published public keys, no private key material', VEC.vectors.length === 30
    && Object.keys(VEC.keypairs).length === 2 && !/PRIVATE KEY/.test(JSON.stringify(VEC)) && Object.values(VEC.keypairs).every((k) => !('private_key_pkcs8_pem' in k)));
  const pubs = {};
  for (const [id, k] of Object.entries(VEC.keypairs)) {
    pubs[id] = await S.importPublicKey(k.public_key_spki_pem);
    chk('fingerprint: ' + id + ' is sha256 of its SPKI DER, as Novig publishes it', (await S.spkiFingerprint(k.public_key_spki_pem)) === k.public_key_fingerprint);
  }
  chk('keys: the published Ed25519 key reads as Ed25519, the P-256 key as P-256', pubs['ed25519-test-1'].algorithm === 'Ed25519' && pubs['ecdsa-p256-test-1'].algorithm === 'P-256');
  let stringsOk = 0, sigsOk = 0, hashOk = 0;
  for (const v of VEC.vectors) {
    const i = v.input;
    const ours = await S.stringToSign({ timestamp: i.timestamp, method: i.method, path: i.path, query: i.query, body: i.body });
    const same = ours === v.string_to_sign;
    chk('vector ' + v.id + ': the string to sign is Novig\'s, byte for byte', same, same ? undefined : { ours, theirs: v.string_to_sign });
    if (same) stringsOk++;
    if ((await S.sha256Hex(i.body)) === v.body_hash) hashOk++;
    const ok = await S.verifyString(ours, v.signature, pubs[v.keypair_id]);
    chk('vector ' + v.id + ': Novig\'s published signature verifies over our string', ok);
    if (ok) sigsOk++;
  }
  chk('vectors: 30 of 30 strings, 30 of 30 body hashes, 30 of 30 signatures', stringsOk === 30 && hashOk === 30 && sigsOk === 30, { stringsOk, hashOk, sigsOk });

  /* ---------------------------------------------------------------- the canonical query, by rule */
  const cq = S.canonicalQuery;
  chk('canonical: absent query is an empty line 5', cq('') === '' && cq(null) === '' && cq(undefined) === '' && cq('?') === '');
  chk('canonical: a space is %20, a bare + is %2B, a pre-encoded %2B stays', cq('q=New%20York') === 'q=New%20York' && cq('q=foo+bar') === 'q=foo%2Bbar' && cq('q=foo%2Bbar') === 'q=foo%2Bbar');
  chk('canonical: hex is upper case', cq('path=%2ftmp%2ffile') === 'path=%2Ftmp%2Ffile');
  chk('canonical: sorted bytewise by name (Z before a), then by value, repeats kept', cq('apple=1&Zebra=2') === 'Zebra=2&apple=1' && cq('s=b&s=a&s=a') === 's=a&s=a&s=b');
  chk('canonical: a bare param is name=, an "=" in a value is %3D', cq('flag') === 'flag=' && cq('token=abc=') === 'token=abc%3D');
  chk('canonical: non-ASCII is its UTF-8 bytes; unreserved ~ is kept', cq('lang=%C3%BC') === 'lang=%C3%BC' && cq('lang=ü') === 'lang=%C3%BC' && cq('p=%7Ehome&t=a~b') === 'p=~home&t=a~b');
  chk('canonical: a malformed escape stays literal and is re-encoded', cq('x=%zz') === 'x=%25zz' && cq('x=%4') === 'x=%254');
  chk('canonical: Novig\'s own catalog filters (comma lists) canonicalize as sent', cq(S.buildQuery({ league: 'NFL', marketType: 'MONEY,SPREAD', limit: 500 })) === 'league=NFL&limit=500&marketType=MONEY%2CSPREAD');
  chk('buildQuery: what is sent canonicalizes to itself (sorted)', (() => { const q = S.buildQuery({ status: 'OPEN_PREGAME,OPEN_INGAME', league: 'NFL', after: 'eyJvIjoxfQ==' }); return cq(q) === q.split('&').sort().join('&'); })());
  const sts = await S.stringToSign({ timestamp: 1755000000000, method: 'get', path: '/v3/keys', query: '', body: '' });
  chk('string: the GET /v3/keys example from the docs (six lines, LF, no trailing newline)', sts === 'NOVIG-V3\n1755000000000\nGET\n/v3/keys\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  chk('string: a trailing slash is kept, a % in the path is never decoded', (await S.stringToSign({ timestamp: 1, method: 'GET', path: '/v3/keys/', body: '' })).split('\n')[3] === '/v3/keys/'
    && (await S.stringToSign({ timestamp: 1, method: 'GET', path: '/a/foo%2Fbar', body: '' })).split('\n')[3] === '/a/foo%2Fbar');
  chk('string: {} hashes differently from an empty body', (await S.sha256Hex('{}')) !== S.EMPTY_SHA256 && (await S.sha256Hex('')) === S.EMPTY_SHA256);
  chk('string: a padded timestamp, a full URL as the path and a query in the path are refused', await throwsAsync(() => S.stringToSign({ timestamp: '01755000000000', method: 'GET', path: '/v3/keys' }))
    && await throwsAsync(() => S.stringToSign({ timestamp: 1, method: 'GET', path: 'https://api.novig.com/v3/keys' }))
    && await throwsAsync(() => S.stringToSign({ timestamp: 1, method: 'GET', path: '/v3/keys?x=1' })));

  /* ---------------------------------------------------------------- keys (generated here; nothing committed) */
  const ed = nodeCrypto.generateKeyPairSync('ed25519');
  const edPem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const edPub = ed.publicKey.export({ type: 'spki', format: 'pem' });
  const ec = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ecPub = ec.publicKey.export({ type: 'spki', format: 'pem' });
  const rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const k1 = await S.importPrivateKey(edPem);
  const k2 = await S.importPrivateKey(edPem.replace(/\n/g, '\\n'));
  const k3 = await S.importPrivateKey(edPem.split('\n').filter((l) => l && !/^-----/.test(l)).join(''));
  const k4 = await S.importPrivateKey(ecPem);
  chk('pem: PKCS#8 PEM, the PEM with flattened "\\n", and the bare base64 body all import as Ed25519', k1.algorithm === 'Ed25519' && k2.algorithm === 'Ed25519' && k3.algorithm === 'Ed25519');
  chk('pem: a P-256 PKCS#8 key imports as P-256 (the algorithm comes from the key, never from config)', k4.algorithm === 'P-256');
  chk('pem: an imported key is not extractable (it cannot be read back out of the process)', k1.key.extractable === false && k4.key.extractable === false);
  const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' });
  let leaked = false;
  for (const bad of [rsaPem, edPub, 'not a key', '', null]) {
    try { await S.importPrivateKey(bad); leaked = true; } catch (e) {
      const m = String(e.message);
      if (bad && m.includes(String(bad).split('\n')[1] || '§§')) leaked = true;
      if (/MC4CAQ|MIGHAg|BEGIN/.test(m.replace(/"PRIVATE KEY"|"PUBLIC KEY"|BEGIN PRIVATE KEY/g, ''))) leaked = true;
    }
  }
  chk('pem: RSA, a public key, garbage, empty and null are refused, and no error repeats key material', !leaked);

  /* ---------------------------------------------------------------- signing a request */
  const KID = '2c9a7e1d-5b3f-4e8a-a6d0-9f1b3c5e7a24';
  const edPubK = await S.importPublicKey(edPub), ecPubK = await S.importPublicKey(ecPub);
  const g = await S.signRequest({ host: 'https://api.paper.novig.com', keyId: KID, signer: k1, method: 'GET', path: '/v3/catalog/markets', query: { league: 'NFL', marketType: 'MONEY,SPREAD,TOTAL', limit: 500 }, nowMs: 1755000000000 });
  const gs = await S.stringToSign({ timestamp: g.headers['Novig-Timestamp'], method: 'GET', path: '/v3/catalog/markets', query: new URL(g.url).search.slice(1), body: '' });
  chk('sign: a GET carries the three headers, no body and no content type', g.headers['Novig-Key-Id'] === KID && g.headers['Novig-Timestamp'] === '1755000000000' && g.body === undefined && !g.headers['Content-Type']);
  chk('sign: the URL sent is the path and query that were signed', g.url === 'https://api.paper.novig.com/v3/catalog/markets?league=NFL&marketType=MONEY%2CSPREAD%2CTOTAL&limit=500');
  chk('sign: an Ed25519 request verifies with the key\'s public half (64-byte signature, padded base64)', await S.verifyString(gs, g.headers['Novig-Signature'], edPubK) && Buffer.from(g.headers['Novig-Signature'], 'base64').length === 64);
  const body = '{"name":"edgedesk-read","publicKey":"x","algorithm":"Ed25519"}';
  const p = await S.signRequest({ host: 'https://api.novig.com', keyId: KID, signer: k4, method: 'POST', path: '/v3/echo', body, nowMs: 1755000000123 });
  const ps = await S.stringToSign({ timestamp: p.headers['Novig-Timestamp'], method: 'POST', path: '/v3/echo', query: '', body });
  const der = Buffer.from(p.headers['Novig-Signature'], 'base64');
  chk('sign: a P-256 signature is DER (SEQUENCE of two INTEGERs, 70-72 bytes), not raw r‖s', der[0] === 0x30 && der.length >= 68 && der.length <= 72 && der[2] === 0x02);
  chk('sign: a P-256 request verifies with its public key, and with Node\'s own DER verifier', await S.verifyString(ps, p.headers['Novig-Signature'], ecPubK)
    && nodeCrypto.verify('sha256', Buffer.from(ps), ec.publicKey, der));
  chk('sign: the body bytes hashed are the bytes sent, with Content-Type: application/json', Buffer.from(p.body).toString() === body && p.headers['Content-Type'] === 'application/json'
    && ps.split('\n')[5] === nodeCrypto.createHash('sha256').update(body).digest('hex'));
  chk('sign: Node\'s Ed25519 verifier agrees with ours', nodeCrypto.verify(null, Buffer.from(gs), ed.publicKey, Buffer.from(g.headers['Novig-Signature'], 'base64')));
  const other = nodeCrypto.generateKeyPairSync('ed25519');
  chk('wrong key: a signature by one key never verifies under another', !(await S.verifyString(gs, g.headers['Novig-Signature'], await S.importPublicKey(other.publicKey.export({ type: 'spki', format: 'pem' })))));
  chk('wrong key: a tampered query never verifies', !(await S.verifyString(gs.replace('limit=500', 'limit=501'), g.headers['Novig-Signature'], edPubK)));
  chk('sign: a key id that is not a UUID (a label) is refused', await throwsAsync(() => S.signRequest({ keyId: 'edgedesk-read', signer: k1, method: 'GET', path: '/v3/time' }), /UUID/));
  chk('der: raw r‖s round-trips through DER, including high-bit and leading-zero integers', (() => {
    const raw = new Uint8Array(64); raw[0] = 0x80; raw[32] = 0; raw[33] = 0x01;
    const back = S.derToP1363(S.p1363ToDer(raw));
    return Buffer.from(back).equals(Buffer.from(raw));
  })());

  /* ---------------------------------------------------------------- the clock and the environments */
  chk('clock: the offset is Novig\'s time minus our midpoint', S.clockOffset(1000, 1200, 6100) === 5000 && S.clockOffset(1000, 1000, 1000) === 0);
  chk('clock: inside ±10 s ok, 10-30 s drifting, past 30 s outside the window', S.skewState(2000) === 'ok' && S.skewState(-15000) === 'drifting' && S.skewState(30001) === 'outside_window');
  const off = await S.signRequest({ keyId: KID, signer: k1, method: 'GET', path: '/v3/time', nowMs: 1755000000000, clockOffsetMs: -2500 });
  chk('clock: the timestamp signed is our clock plus the offset, unpadded', off.headers['Novig-Timestamp'] === '1754999997500');
  chk('env: production and paper hosts are Novig\'s two; anything else is refused', S.hostFor('production') === 'https://api.novig.com' && S.hostFor('paper') === 'https://api.paper.novig.com'
    && (() => { try { S.hostFor('staging'); return false; } catch (_) { return true; } })());

  /* ---------------------------------------------------------------- redaction */
  const red = S.redactHeaders(Object.assign({ accept: 'application/json' }, g.headers));
  chk('redaction: the signature and the key id are redacted, the timestamp and accept are not', red['Novig-Signature'] === '[redacted]' && red['Novig-Key-Id'] === '[redacted]' && red['Novig-Timestamp'] === '1755000000000' && red.accept === 'application/json');

  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig signing: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAILED novig signing: ' + (e && e.stack || e)); process.exit(1); });
