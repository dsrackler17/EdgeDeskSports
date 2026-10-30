#!/usr/bin/env node
/* ===========================================================================
   The runner half of Novig credential provisioning
   (.github/workflows/novig-provision.yml, docs/novig/README.md §Credentials).

     node tools/novig/provision.js whoami
         asks the transient novig_key_bootstrap function which environment
         the management key belongs to; prints the key list (names, scopes,
         fingerprints) and the subaccount labels; writes environment=<env>
         to $GITHUB_OUTPUT. Exit 0: one environment accepted the key.
         Exit 3: Novig answered and neither environment accepted it (a 451
         location refusal, a wrong key, the clock): final, never retried,
         because repeated 451s can lock the account. Exit 4: the bootstrap
         could not sign a request at all, so Novig was never asked (the
         management key is not set on the project, or is not a key): final.
         Exit 1: the bootstrap could not be asked (not deployed yet, not
         JSON): the only answer the workflow retries.

     node tools/novig/provision.js register --kind read|stream --environment <env>
                                    --env-file <path> [--subaccount <trading key id>]
         generates an Ed25519 keypair HERE, sends only the public half,
         checks that Novig's fingerprint is the SHA-256 of that public key,
         and writes the secrets file `supabase secrets set --env-file` reads
         (mode 0600):
           read   NOVIG_READ_KEY_ID, NOVIG_READ_PRIVATE_KEY, NOVIG_ENV
           stream NOVIG_STREAM_KEY_ID, NOVIG_STREAM_PRIVATE_KEY, NOVIG_ENV
         The private key is written as its single-line base64 PKCS#8 body
         (lib/novig_signing.js reads that form; a multi-line value in a
         secrets file is not something the Supabase docs define). It is
         never printed, logged or sent anywhere but that file.

   ENV: NOVIG_BOOTSTRAP_URL (the function's URL), NOVIG_BOOTSTRAP_SECRET.
   No dependency: Node's own crypto and fetch.
   =========================================================================== */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
async function boot(body, o) {
  o = o || {};
  const url = (o.url || process.env.NOVIG_BOOTSTRAP_URL || '').trim(), secret = o.secret || process.env.NOVIG_BOOTSTRAP_SECRET || '';
  if (!/^https:\/\//.test(url)) throw new Error('NOVIG_BOOTSTRAP_URL is not set');
  if (secret.length < 32) throw new Error('NOVIG_BOOTSTRAP_SECRET is not set');
  const r = await (o.fetch || fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-secret': secret }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: 'not JSON (HTTP ' + r.status + ')' }));
  if (!r.ok || j.ok === false) { const e = new Error((j.error || 'HTTP ' + r.status) + (j.detail ? ': ' + JSON.stringify(j.detail) : '')); e.body = j; throw e; }
  return j;
}

/* the workflow's log is public (a public repository): an account's ids are shown by their first 8 characters */
const mask = (id) => (id ? String(id).slice(0, 8) + '…' : id);

async function whoami(o) {
  let j;
  /* a whoami answer that names no environment is still Novig's answer: return it, do not throw */
  try { j = await boot({ action: 'whoami' }, o); } catch (e) { if (e.body && e.body.probes) j = e.body; else throw e; }
  const lines = ['environment: ' + j.environment];
  for (const [e, p] of Object.entries(j.probes || {})) lines.push('  echo on ' + e + ': ' + p.status + ' ' + (p.message || p.code || ''));
  if (Array.isArray(j.keys)) {
    lines.push('keys (' + j.keys.length + '):');
    for (const k of j.keys) lines.push('  ' + (k.is_management_key ? '[management] ' : '') + k.scope + '  "' + k.name + '"  ' + k.algorithm + '  ' + k.fingerprint + (k.restriction ? '  subaccount=' + mask(k.restriction) : '') + (k.expires_at ? '  expires ' + k.expires_at : ''));
  }
  if (Array.isArray(j.subaccounts)) {
    lines.push('existing subaccounts (' + j.subaccounts.length + '):');
    for (const s of j.subaccounts) lines.push('  ' + mask(s.key_id) + '  "' + s.label + '"');
  }
  if (j.hint) lines.push('hint: ' + j.hint);
  return { json: j, text: lines.join('\n') };
}

/** whoami as the workflow runs it: 0 found; 3 Novig answered without one; 4 Novig was never asked (the bootstrap
    could not sign: its management key is missing or malformed); 1 the bootstrap could not be asked — only 1 is retried */
async function whoamiCli(o) {
  let r;
  try { r = await whoami(o); } catch (e) { return { code: 1, text: 'FAILED: ' + e.message, json: null }; }
  if (r.json.ok) return { code: 0, text: r.text, json: r.json };
  const asked = Object.values(r.json.probes || {}).some((p) => p && Number(p.status) > 0);
  return { code: asked ? 3 : 4, text: r.text, json: r.json };
}

/** the single-line base64 body of a PKCS#8 PEM */
function pemBody(pem) { return String(pem).split('\n').filter((l) => l && !/^-----/.test(l)).join(''); }

async function register(o) {
  const kind = o.kind;
  if (kind !== 'read' && kind !== 'stream') throw new Error('--kind must be read or stream');
  if (o.environment !== 'production' && o.environment !== 'paper') throw new Error('--environment must be production or paper (from whoami)');
  if (!o.envFile) throw new Error('--env-file is required');
  if (kind === 'stream' && !o.subaccount) throw new Error('--subaccount (an EXISTING subaccount\'s trading key id) is required for a stream key');
  const kp = crypto.generateKeyPairSync('ed25519');
  const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
  const fp = 'sha256:' + crypto.createHash('sha256').update(kp.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const j = await boot(Object.assign({ action: kind === 'read' ? 'register_read' : 'register_stream', environment: o.environment, public_key_pem: pub, name: o.name || undefined },
    kind === 'stream' ? { subaccount_key_id: o.subaccount } : {}), o);
  if (String(j.fingerprint).toLowerCase() !== fp) throw new Error('the registered fingerprint is not this key\'s: nothing was written');
  const P = kind === 'read' ? 'NOVIG_READ' : 'NOVIG_STREAM';
  const priv = pemBody(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const old = process.umask(0o077);
  try {
    fs.writeFileSync(o.envFile, P + '_KEY_ID=' + j.key_id + '\n' + P + '_PRIVATE_KEY=' + priv + '\nNOVIG_ENV=' + o.environment + '\n', { mode: 0o600 });
  } finally { process.umask(old); }
  return { key_id: j.key_id, scope: j.scope, fingerprint: fp, environment: o.environment, text: 'registered a ' + j.scope + ' key "' + j.name + '" in ' + o.environment + ': key id ending ' + String(j.key_id).slice(-4) + ', ' + fp };
}

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    if (cmd === 'whoami') {
      const r = await whoamiCli();
      console.log(r.text);
      if (r.json && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'environment=' + r.json.environment + '\n');
      if (r.code) process.exit(r.code);
    } else if (cmd === 'register') {
      const r = await register({ kind: arg('kind'), environment: arg('environment'), envFile: arg('env-file'), subaccount: arg('subaccount'), name: arg('name') });
      console.log(r.text);
    } else { console.log('usage: provision.js whoami | register --kind read|stream --environment <env> --env-file <path> [--subaccount <id>]'); process.exit(2); }
  })().catch((e) => { console.log('FAILED: ' + e.message); process.exit(1); });
}
module.exports = { whoami, whoamiCli, register, boot, pemBody };
