#!/usr/bin/env node
/* ===========================================================================
   supabase/functions/novig_key_bootstrap/index.ts and tools/novig/provision.js
   — credential provisioning, end to end against a mock Novig that verifies
   every management-key signature (keys generated here, nothing committed).

     source      only echo, key list, subaccount list and the two key-minting
                 routes; never an order, transfer, revoke (DELETE) or
                 subaccount OPENING (POST /v3/account/subaccounts); the only
                 scope it ever names is trading::read
     auth        no one-time secret set: 401 for everyone; a wrong secret: 401
     whoami      the management key answers on production and is refused on
                 paper ("api key not found"): environment = production; keys
                 and subaccounts listed, no balance returned; as the workflow
                 runs it: exit 0 found, exit 3 when Novig answered without one
                 (a 451 on both hosts: one echo each, then the run stops),
                 exit 1 only when the bootstrap cannot be asked yet — the one
                 answer the workflow's loop retries
     read key    POST /v3/keys carries name, the SPKI public key and the
                 algorithm, and NO scope (Novig refuses one there); the runner's
                 fingerprint must equal Novig's; the secrets file holds the key
                 id, the single-line private body and NOVIG_ENV, mode 0600,
                 and that body signs a request Novig verifies
     refusals    a private key sent as the "public key" is refused before
                 Novig is called; a fingerprint mismatch is refused and writes
                 nothing; an environment that is not named is refused
     stream key  only for an EXISTING subaccount, with scope trading::read;
                 an unknown subaccount is refused and nothing is opened
     output      nothing printed by provision.js carries the private key

   Run: node tools/novig/novig_bootstrap.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const NS = require(path.join(ROOT, 'lib', 'novig_signing.js'));
const PROV = require(path.join(__dirname, 'provision.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const MG = nodeCrypto.generateKeyPairSync('ed25519');
const MGMT_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'b'.repeat(64);
const ENV = { NOVIG_MANAGEMENT_KEY_ID: MGMT_ID, NOVIG_MANAGEMENT_PRIVATE_KEY: MG.privateKey.export({ type: 'pkcs8', format: 'pem' }), NOVIG_BOOTSTRAP_SECRET: SECRET };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const SRC = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'novig_key_bootstrap', 'index.ts'), 'utf8');
const OWN = SRC.slice(0, SRC.indexOf('// ── BEGIN NOVIG CORE')) + SRC.slice(SRC.indexOf('// ── END NOVIG CORE'));
chk('copy: the inlined signer matches lib/novig_signing.js', require(path.join(__dirname, 'inline.js')).current('supabase/functions/novig_key_bootstrap/index.ts'));
const CALLS = [...OWN.matchAll(/call\([^,]+, "([A-Z]+)", ("[^"]+"|path)/g)].map((m) => m[1] + ' ' + m[2]);
chk('source: only echo, the key list, the subaccount list and the two minting routes; no order, transfer, revoke or subaccount opening', CALLS.sort().join('|') === ['GET "/v3/account/subaccounts"', 'GET "/v3/account/subaccounts"', 'GET "/v3/keys"', 'POST "/v3/echo"', 'POST path'].sort().join('|')
  && !/\/v3\/orders|\/transfer|"DELETE"|\/v3\/portfolio/.test(OWN) && /path = "\/v3\/account\/subaccounts\/" \+ sub \+ "\/keys"/.test(OWN), CALLS);
chk('source: the only scope it ever names is trading::read (never trading, never management)', (OWN.match(/scope: "[^"]+"/g) || []).join(',') === 'scope: "trading::read"');

/* ---------------------------------------------------------------- Novig, mocked */
let W;
const MGPUB = NS.importPublicKey(MG.publicKey.export({ type: 'spki', format: 'pem' }));
function resetNovig(o) { W = Object.assign({ calls: [], bad: [], minted: [], registeredPubs: {}, lieFingerprint: false, subs: [{ keyId: '99999999-8888-4777-8666-555555555555', label: 'research', balance: '1234.50000' }] }, o || {}); }
function resp(status, body) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; }
async function novig(u, init) {
  const url = new URL(u), method = init.method || 'GET', p = url.pathname, H = init.headers || {};
  W.calls.push(url.host + ' ' + method + ' ' + p);
  if (W.geo451) return resp(451, { code: 'RESTRICTED_NETWORK_REGION', message: 'requests from this network are not permitted' });
  const body = init.body ? Buffer.from(init.body).toString() : '';
  const kid = H['Novig-Key-Id'];
  /* paper does not know this key (environments.md: a key works only where it was made) */
  if (url.host === 'api.paper.novig.com' || kid !== MGMT_ID) return resp(401, { code: 'SIGNATURE_REJECTED', message: 'api key not found' });
  const s = await NS.stringToSign({ timestamp: H['Novig-Timestamp'], method, path: p, query: url.search.slice(1), body: H['Content-Type'] === 'application/json' ? body : '' });
  if (!(await NS.verifyString(s, H['Novig-Signature'], await MGPUB))) { W.bad.push(method + ' ' + p); return resp(401, { code: 'SIGNATURE_REJECTED', message: 'signature verification failed' }); }
  if (p === '/v3/echo') return resp(200, body);
  if (p === '/v3/keys' && method === 'GET') return resp(200, [{ keyId: MGMT_ID, name: 'mgmt-1', scope: 'management', algorithm: 'Ed25519', fingerprint: 'sha256:aa', restriction: null, createdAt: '2026-10-29T00:00:00Z', lastUsedAt: null, expiresAt: null }]);
  if (p === '/v3/account/subaccounts' && method === 'GET') return resp(200, W.subs);
  if (p === '/v3/account/subaccounts' && method === 'POST') { W.minted.push('OPENED A SUBACCOUNT'); return resp(201, { keyId: 'x' }); }
  if (method === 'POST' && (p === '/v3/keys' || /^\/v3\/account\/subaccounts\/[^/]+\/keys$/.test(p))) {
    const j = JSON.parse(body);
    if (p === '/v3/keys' && 'scope' in j) return resp(400, { code: 'INVALID_BODY', message: 'scope: unknown field' });
    if (/PRIVATE KEY/.test(j.publicKey)) return resp(400, { code: 'INVALID_BODY', message: 'You sent the private half of your keypair' });
    const der = nodeCrypto.createPublicKey(j.publicKey).export({ type: 'spki', format: 'der' });
    const fp = 'sha256:' + (W.lieFingerprint ? '00'.repeat(32) : nodeCrypto.createHash('sha256').update(der).digest('hex'));
    const keyId = nodeCrypto.randomUUID();
    W.minted.push({ path: p, scope: j.scope || 'management::read', name: j.name, algorithm: j.algorithm, keyId });
    W.registeredPubs[keyId] = j.publicKey;
    return resp(201, { keyId, algorithm: j.algorithm, fingerprint: fp });
  }
  return resp(404, { code: 'NOT_FOUND', message: p });
}

(async () => {
  let F;
  try { F = await import(path.join(ROOT, 'supabase', 'functions', 'novig_key_bootstrap', 'index.ts')); } catch (e) { chk('the function imports', false, e.message); return finish(); }
  const URL_ = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/novig_key_bootstrap';
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u === URL_) return F.handle(new Request(u, { method: init.method, headers: init.headers, body: init.body }));
    return novig(u, init);
  };
  const post = (b, sec) => F.handle(new Request(URL_, { method: 'POST', headers: { 'x-bootstrap-secret': sec === undefined ? SECRET : sec, 'content-type': 'application/json' }, body: JSON.stringify(b) }));
  resetNovig();

  /* ---- auth ---- */
  chk('auth: a wrong secret is refused', (await post({ action: 'whoami' }, 'c'.repeat(64))).status === 401 && W.calls.length === 0);
  const keepS = ENV.NOVIG_BOOTSTRAP_SECRET; ENV.NOVIG_BOOTSTRAP_SECRET = '';
  chk('auth: with no one-time secret set, nobody is answered (outside a provisioning run)', (await post({ action: 'whoami' }, '')).status === 401);
  ENV.NOVIG_BOOTSTRAP_SECRET = keepS;

  /* ---- whoami ---- */
  const env0 = process.env;
  process.env = Object.assign({}, env0, { NOVIG_BOOTSTRAP_URL: URL_, NOVIG_BOOTSTRAP_SECRET: SECRET });
  const who = await PROV.whoami();
  chk('whoami: production accepts the management key, paper says "api key not found": the key is production\'s', who.json.ok && who.json.environment === 'production' && who.json.probes.paper.status === 401 && W.bad.length === 0, who.json);
  chk('whoami: keys and existing subaccounts are listed; the management key is marked; no balance is returned', who.json.keys[0].is_management_key === true && who.json.subaccounts.length === 1
    && !JSON.stringify(who.json).includes('1234.50000') && /existing subaccounts \(1\)/.test(who.text));
  chk('whoami: the printed text (a public log) shows a subaccount id by its first 8 characters only', who.text.includes('99999999…') && !who.text.includes('99999999-8888-4777-8666-555555555555'), who.text);

  /* ---- whoami must never be retried once Novig has answered: repeated 451s can lock the account ---- */
  chk('whoami (CLI): the environment found is exit 0', typeof PROV.whoamiCli === 'function' && (await PROV.whoamiCli()).code === 0);
  resetNovig({ geo451: true });
  const g = typeof PROV.whoamiCli === 'function' ? await PROV.whoamiCli() : { code: null, text: '' };
  chk('whoami (CLI): a location refusal (451) on both hosts is exit 3 — Novig answered, so the run must stop — with each host\'s answer printed, after one echo per host and nothing else',
    g.code === 3 && /echo on production: 451 /.test(g.text) && /echo on paper: 451 /.test(g.text) && W.calls.length === 2 && W.calls.every((c) => / POST \/v3\/echo$/.test(c)), [g, W.calls]);
  resetNovig();
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async (u, init) => (String(u) === URL_ ? resp(503, '<html>booting</html>') : fetch0(u, init));
  const u1 = typeof PROV.whoamiCli === 'function' ? await PROV.whoamiCli() : { code: null };
  globalThis.fetch = fetch0;
  chk('whoami (CLI): a bootstrap that is not up yet (503, not JSON) is exit 1, the only answer the workflow retries; Novig was not called', u1.code === 1 && W.calls.length === 0, u1);
  const PY = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'novig-provision.yml'), 'utf8');
  const loop = (PY.match(/for i in \$\(seq 1 10\); do[\s\S]*?\n\s*done/) || [''])[0];
  chk('workflow: the whoami loop retries only exit 1; exit 3 (Novig answered) ends the run at once',
    /rc=0; node tools\/novig\/provision\.js whoami \|\| rc=\$\?/.test(loop) && /if \[ "\$rc" = 3 \]; then[^\n]*exit 1; fi/.test(loop) && !/if node tools\/novig\/provision\.js whoami; then/.test(PY), loop);

  /* ---- the read key ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novig-prov-'));
  const envFile = path.join(dir, 'read.env');
  const OUT = [];
  const r = await PROV.register({ kind: 'read', environment: 'production', envFile });
  OUT.push(r.text);
  const minted = W.minted[0];
  chk('read key: POST /v3/keys with a name, the SPKI public key and the algorithm, and no scope (Novig issues management::read)', minted && minted.path === '/v3/keys' && minted.scope === 'management::read' && minted.algorithm === 'Ed25519' && r.scope === 'management::read');
  const lines = fs.readFileSync(envFile, 'utf8').trim().split('\n');
  const kv = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  chk('read key: the secrets file holds NOVIG_READ_KEY_ID, a single-line NOVIG_READ_PRIVATE_KEY and NOVIG_ENV=production, mode 0600', lines.length === 3 && kv.NOVIG_READ_KEY_ID === minted.keyId && kv.NOVIG_ENV === 'production'
    && /^[A-Za-z0-9+/=]+$/.test(kv.NOVIG_READ_PRIVATE_KEY) && (fs.statSync(envFile).mode & 0o777) === 0o600);
  const signer = await NS.importPrivateKey(kv.NOVIG_READ_PRIVATE_KEY);
  const sreq = await NS.signRequest({ keyId: kv.NOVIG_READ_KEY_ID, signer, method: 'GET', path: '/v3/catalog/events', query: { league: 'NFL' }, nowMs: Date.now() });
  const sstr = await NS.stringToSign({ timestamp: sreq.headers['Novig-Timestamp'], method: 'GET', path: '/v3/catalog/events', query: 'league=NFL', body: '' });
  chk('read key: the private body in the secrets file signs a request that verifies with the public key Novig registered', await NS.verifyString(sstr, sreq.headers['Novig-Signature'], await NS.importPublicKey(W.registeredPubs[minted.keyId])));
  chk('output: nothing printed carries the private key', !OUT.join('\n').includes(kv.NOVIG_READ_PRIVATE_KEY.slice(0, 20)) && !/PRIVATE/.test(OUT.join('\n')) && /ending /.test(r.text));

  /* ---- refusals ---- */
  const nCalls = W.calls.length;
  const priv = await post({ action: 'register_read', environment: 'production', public_key_pem: nodeCrypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  chk('refused: a private key sent as the public key never reaches Novig', priv.status === 400 && (await priv.json()).error === 'bad_public_key' && W.calls.length === nCalls);
  chk('refused: an environment that is not named (never guessed)', (await post({ action: 'register_read', public_key_pem: 'x' })).status === 400);
  resetNovig({ lieFingerprint: true });
  const bad = path.join(dir, 'bad.env');
  let threw = null; try { await PROV.register({ kind: 'read', environment: 'production', envFile: bad }); } catch (e) { threw = e.message; }
  chk('refused: a fingerprint that is not the key\'s refuses, and no secrets file is written', /fingerprint_mismatch/.test(threw || '') && !fs.existsSync(bad), threw);

  /* ---- the stream key ---- */
  resetNovig();
  const sEnv = path.join(dir, 'stream.env');
  threw = null; try { await PROV.register({ kind: 'stream', environment: 'production', envFile: sEnv, subaccount: '00000000-0000-4000-8000-000000000000' }); } catch (e) { threw = e.message; }
  chk('stream key: an unknown subaccount is refused, nothing is opened and nothing minted', /not_an_existing_subaccount/.test(threw || '') && W.minted.length === 0 && !fs.existsSync(sEnv), threw);
  const s = await PROV.register({ kind: 'stream', environment: 'production', envFile: sEnv, subaccount: W.subs[0].keyId });
  chk('stream key: for the existing subaccount, scope trading::read, via its own route; no subaccount opened', W.minted.length === 1 && W.minted[0].scope === 'trading::read' && W.minted[0].path === '/v3/account/subaccounts/' + W.subs[0].keyId + '/keys'
    && !W.minted.includes('OPENED A SUBACCOUNT') && s.scope === 'trading::read' && /NOVIG_STREAM_KEY_ID=/.test(fs.readFileSync(sEnv, 'utf8')));
  chk('signatures: every management-key request verified at Novig', W.bad.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = env0;
  finish();
})().catch((e) => { console.log('FAILED novig bootstrap: ' + (e && e.stack || e)); process.exit(1); });

function finish() {
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' novig bootstrap: ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  process.exit(fail ? 1 : 0);
}
