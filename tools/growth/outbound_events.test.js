#!/usr/bin/env node
/* ===========================================================================
   PHASE 6 EDGE FUNCTIONS, tested as deployed:
     supabase/functions/growth_outbound_webhook/index.ts
     supabase/functions/growth_outbound_optout/index.ts
     supabase/functions/newsletter/index.ts   (it must ignore outbound events)

   The DEPLOYED files are imported — not copies — under Node's native type
   stripping with a Deno shim and a mocked network. The database side (the
   signature check, the events, the opt-out) is
   tools/growth/outbound_events_sql.test.js.

     W  WEBHOOK   only a POST with the three signature headers reaches the
                  database; the raw body goes through byte for byte with the
                  headers, as anon; an unverified delivery is a 401 that says
                  nothing more; a missing door or an unreachable database is
                  a 503 (Resend retries); oversized bodies 413; no CORS
     O  OPT-OUT   a GET changes nothing: a 303 to the static page with the
                  token in the fragment; the RFC 8058 POST stops email with
                  the token in the URL (or the form); a bad token never
                  reaches the database; answers in plain text, masked only
     N  NEWSLETTER the newsletter's webhook keeps nothing about an outbound
                  email (tagged edgedesk=outbound, either tag shape) and
                  still handles its own
     S  SOURCE    no secret in either new function: the project URL and the
                  anon key only

   Run: node tools/growth/outbound_events.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : '')); } };

const FNS = path.join(__dirname, '..', '..', 'supabase', 'functions');
const WEBHOOK = path.join(FNS, 'growth_outbound_webhook', 'index.ts');
const OPTOUT = path.join(FNS, 'growth_outbound_optout', 'index.ts');
const NEWSLETTER = path.join(FNS, 'newsletter', 'index.ts');

/* ── S. the source holds no secret ─────────────────────────────────────── */
for (const f of [WEBHOOK, OPTOUT]) {
  const src = fs.readFileSync(f, 'utf8');
  const envs = [...src.matchAll(/env\('([A-Z_]+)'\)/g)].map((m) => m[1]).sort();
  const name = path.basename(path.dirname(f));
  chk('S ' + name + ' reads only the project URL, the anon key' + (name.endsWith('optout') ? ' and the page' : ''),
    JSON.stringify(envs) === JSON.stringify(name.endsWith('optout') ? ['OUTBOUND_OPTOUT_PAGE', 'SUPABASE_ANON_KEY', 'SUPABASE_URL'] : ['SUPABASE_ANON_KEY', 'SUPABASE_URL']), envs);
  chk('S ' + name + ' names no service-role key, no Resend key, no signing secret', !/SERVICE_ROLE|RESEND_API_KEY|WEBHOOK_SECRET|whsec_/i.test(src.replace(/no service-role key|NO service-role key|Not the signing secret, not a service-role key, not\s*\/\/ the Resend key/g, '')));
  chk('S ' + name + ' calls exactly one door', (src.match(/\/rest\/v1\/rpc\/[a-z_]+/g) || []).join() === '/rest/v1/rpc/' + name);
}

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const SERVICE = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service';
const NL_SECRET = 'whsec_' + Buffer.from('newsletter-signing-secret-123456').toString('base64');
const ENV = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE, NEWSLETTER_WEBHOOK_SECRET: NL_SECRET };
globalThis.Deno = { env: { get: (k) => ENV[k] } };   /* no serve: the servers stay uninstalled */

let S;   /* the scenario for the next request */
let LOG; /* every request a function made */
let LOGGED; /* what a function logged */
const res = (status, body) => ({ ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => { if (body === undefined || typeof body === 'string') throw new Error('not json'); return body; } });
globalThis.fetch = async (url, init) => {
  url = String(url);
  const h = (init && init.headers) || {};
  let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) { body = init.body; }
  const entry = { url, method: init && init.method, authz: h.authorization, apikey: h.apikey, body };
  LOG.push(entry);
  if (S.throw) throw new TypeError('network');
  if (S.hang) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  if (/rpc\/growth_outbound_webhook$/.test(url)) return S.door || res(200, { ok: true, outcome: 'delivered' });
  if (/rpc\/growth_outbound_optout$/.test(url)) return S.door || res(200, { ok: true, masked: 'p•••@cfbnumbers.test', already: false, done: true });
  if (/rest\/v1\/newsletter_events/.test(url)) return res(201, [{ id: 1 }]);
  return res(200, []);
};
const cfgOf = (o) => Object.assign({ url: URL_, anonKey: ANON, page: 'https://edgedesksports.com/email/stop/', fetch: (u, i) => globalThis.fetch(u, i),
  log: (s) => LOGGED.push(s), timeoutMs: 200 }, o || {});
const TOK = 'ab'.repeat(32);

(async () => {
  const W = await import(WEBHOOK);
  const O = await import(OPTOUT);
  const N = await import(NEWSLETTER);
  const run = async (M, scenario, request, cfg) => {
    S = scenario || {}; LOG = []; LOGGED = [];
    const r = await M.handle(request, cfg === undefined ? cfgOf() : cfg);
    const txt = await r.text();
    let b = null; try { b = JSON.parse(txt); } catch (_) { b = null; }
    return { r, b, txt };
  };

  /* ══ W. THE WEBHOOK RELAY ═════════════════════════════════════════════ */
  const BODY = '{"type":"email.delivered",  "data":{"email_id":"msg_1","to":["pat@cfbnumbers.test"],"subject":"Ünïcödé — 🏈"}}\n';
  const hook = (o = {}) => new Request(URL_ + '/functions/v1/growth_outbound_webhook', {
    method: o.method || 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      o.headers !== undefined ? o.headers : { 'svix-id': 'msg_evt_1', 'svix-timestamp': '1790000000', 'svix-signature': 'v1,abc= v1,def=' }),
    body: o.method === 'GET' || o.method === 'HEAD' ? undefined : (o.body !== undefined ? o.body : BODY) });

  let x = await run(W, {}, hook());
  const call = LOG[0];
  chk('W a signed delivery goes to the door exactly once, as anon', x.r.status === 200 && x.b.ok === true && LOG.length === 1
    && call.url === URL_ + '/rest/v1/rpc/growth_outbound_webhook' && call.method === 'POST' && call.apikey === ANON && call.authz === 'Bearer ' + ANON, LOG);
  chk('W … with the raw body byte for byte (the signature covers those bytes) and the three headers as given',
    call.body.p_body === BODY && call.body.p_id === 'msg_evt_1' && call.body.p_timestamp === '1790000000' && call.body.p_signature === 'v1,abc= v1,def=', call.body);
  chk('W … and answers with nothing but ok, and no CORS header', JSON.stringify(x.b) === '{"ok":true}' && x.r.headers.get('access-control-allow-origin') === null);
  x = await run(W, {}, hook({ headers: { 'webhook-id': 'msg_evt_2', 'webhook-timestamp': '1790000001', 'webhook-signature': 'v1,xyz=' } }));
  chk('W the Standard Webhooks header names work too', x.r.status === 200 && LOG[0].body.p_id === 'msg_evt_2' && LOG[0].body.p_signature === 'v1,xyz=');
  for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    x = await run(W, {}, hook({ method: m, body: m === 'GET' ? undefined : '' }));
    chk('W ' + m + ' → 405, the database is not asked', x.r.status === 405 && LOG.length === 0, x.r.status);
  }
  for (const [label, headers] of [['no headers', {}], ['no signature', { 'svix-id': 'a', 'svix-timestamp': '1' }], ['no id', { 'svix-timestamp': '1', 'svix-signature': 'v1,x' }],
    ['no timestamp', { 'svix-id': 'a', 'svix-signature': 'v1,x' }], ['an absurd id', { 'svix-id': 'a'.repeat(201), 'svix-timestamp': '1', 'svix-signature': 'v1,x' }]]) {
    x = await run(W, {}, hook({ headers }));
    chk('W ' + label + ' → 401 before the database is asked anything', x.r.status === 401 && LOG.length === 0 && JSON.stringify(x.b) === '{"ok":false}', x.b);
  }
  x = await run(W, {}, hook({ body: 'x'.repeat(262145) }));
  chk('W a body over 256 KB → 413, never relayed', x.r.status === 413 && LOG.length === 0);
  x = await run(W, { door: res(200, { ok: false, verified: false, reason: 'signature_mismatch' }) }, hook());
  chk('W the database says it is not Resend\'s → 401, and the caller learns nothing more', x.r.status === 401 && JSON.stringify(x.b) === '{"ok":false}');
  chk('W … the reason goes to the owner\'s logs (no body, no header)', LOGGED.length === 1 && /signature_mismatch/.test(LOGGED[0]) && !LOGGED[0].includes('msg_1') && !LOGGED[0].includes('v1,'), LOGGED);
  x = await run(W, { door: res(200, { ok: false, verified: false, reason: 'no_secret_configured' }) }, hook());
  chk('W no secret configured → 401 too (and logged, so the owner can see why)', x.r.status === 401 && /no_secret_configured/.test(LOGGED[0]));
  x = await run(W, { door: res(200, { ok: false, verified: true, reason: 'unparseable' }) }, hook());
  chk('W signed but not a JSON object → 400 (a retry will not help)', x.r.status === 400 && x.b.ok === false);
  x = await run(W, { door: res(200, { ok: true, duplicate: true }) }, hook());
  chk('W a repeat → 200 (so Resend stops retrying)', x.r.status === 200 && x.b.ok === true);
  for (const [label, sc] of [['the door not installed (404)', { door: res(404, { code: 'PGRST202' }) }], ['a database error (500)', { door: res(500, { message: 'boom' }) }],
    ['the database unreachable', { throw: true }], ['the database hanging', { hang: true }], ['a non-JSON answer', { door: res(200, 'oops') }]]) {
    x = await run(W, sc, hook());
    chk('W ' + label + ' → 503, so Resend retries', x.r.status === 503 && x.b.ok === false, x.r.status);
    if (/404/.test(label)) chk('W … and the owner\'s log says to run the SQL', LOGGED.some((l) => /not installed \(run supabase\/growth_outbound\.sql\)/.test(l)), LOGGED);
  }
  x = await run(W, {}, hook(), cfgOf({ anonKey: '' }));
  chk('W not configured → 503, nothing relayed', x.r.status === 503 && LOG.length === 0);

  /* ══ O. THE OPT-OUT ENDPOINT ══════════════════════════════════════════ */
  const out = (o = {}) => new Request(URL_ + '/functions/v1/growth_outbound_optout' + (o.q !== undefined ? o.q : '?t=' + TOK), {
    method: o.method || 'POST',
    headers: { 'content-type': o.ct || 'application/x-www-form-urlencoded' },
    body: o.method === 'GET' || o.method === 'HEAD' ? undefined : (o.body !== undefined ? o.body : 'List-Unsubscribe=One-Click') });

  x = await run(O, {}, out({ method: 'GET' }));
  chk('O a GET (a person, or a scanner prefetching the link) changes nothing: 303 to the page, the token in the fragment', x.r.status === 303
    && x.r.headers.get('location') === 'https://edgedesksports.com/email/stop/#t=' + TOK && LOG.length === 0, x.r.headers.get('location'));
  chk('O … with no Referer to leak it', x.r.headers.get('referrer-policy') === 'no-referrer');
  x = await run(O, {}, out({ method: 'HEAD' }));
  chk('O HEAD likewise', x.r.status === 303 && LOG.length === 0);
  x = await run(O, {}, out({ method: 'GET', q: '?t=' + TOK.toUpperCase() }));
  chk('O an upper-cased token is lower-cased', x.r.headers.get('location').endsWith('#t=' + TOK));
  for (const q of ['', '?t=', '?t=abc', '?t=' + TOK + 'ff', '?t=%3Cscript%3E', '?t=' + 'g'.repeat(64)]) {
    x = await run(O, {}, out({ method: 'GET', q }));
    chk('O a GET without a token-shaped token goes to the page with no fragment: ' + q.slice(0, 12), x.r.status === 303 && x.r.headers.get('location') === 'https://edgedesksports.com/email/stop/' && LOG.length === 0);
  }
  x = await run(O, {}, out());
  chk('O the RFC 8058 one-click POST stops email: the door, confirmed, with the token, as anon', x.r.status === 200 && LOG.length === 1
    && LOG[0].url === URL_ + '/rest/v1/rpc/growth_outbound_optout' && LOG[0].body.p_token === TOK && LOG[0].body.p_confirm === true
    && LOG[0].apikey === ANON && LOG[0].authz === 'Bearer ' + ANON, LOG);
  chk('O … and says so in plain text, with the masked address only', /^Done\. EdgeDesk will not email p•••@cfbnumbers\.test again\./.test(x.txt)
    && /^text\/plain/.test(x.r.headers.get('content-type')) && x.r.headers.get('x-content-type-options') === 'nosniff', x.txt);
  x = await run(O, {}, out({ q: '', body: 't=' + TOK + '&List-Unsubscribe=One-Click' }));
  chk('O the token in the form instead of the URL works', x.r.status === 200 && LOG.length === 1 && LOG[0].body.p_token === TOK);
  x = await run(O, {}, out({ body: '' }));
  chk('O a POST with the token in the URL and no body still stops email (the token is the proof)', x.r.status === 200 && LOG.length === 1);
  for (const q of ['', '?t=abc', '?t=' + 'z'.repeat(64)]) {
    x = await run(O, {}, out({ q, body: 'List-Unsubscribe=One-Click' }));
    chk('O a POST without a valid token → 400, the database is not asked: ' + (q || '(none)'), x.r.status === 400 && LOG.length === 0 && /not valid/.test(x.txt));
  }
  x = await run(O, { door: res(200, { ok: false, reason: 'invalid' }) }, out());
  chk('O a token no send carries → 400, the same words as a malformed one', x.r.status === 400 && /^That link is not valid/.test(x.txt));
  x = await run(O, { door: res(200, { ok: true, test: true, masked: 'o•••@edgedesk.test', done: false }) }, out());
  chk('O a test send\'s token → "a test email; nothing was changed"', x.r.status === 200 && /test email\. Nothing was changed/.test(x.txt));
  for (const [label, sc] of [['the door not installed', { door: res(404, {}) }], ['a database error', { door: res(500, {}) }], ['unreachable', { throw: true }], ['hanging', { hang: true }]]) {
    x = await run(O, sc, out());
    chk('O ' + label + ' → 503, and the reader is told to reply STOP', x.r.status === 503 && /reply STOP/.test(x.txt), x.r.status);
  }
  x = await run(O, {}, out({ method: 'PUT' }));
  chk('O PUT → 405', x.r.status === 405 && LOG.length === 0);
  x = await run(O, {}, out({ method: 'GET' }), cfgOf({ page: 'https://www.edgedesksports.com/email/stop/' }));
  chk('O the page can be configured (OUTBOUND_OPTOUT_PAGE)', x.r.headers.get('location') === 'https://www.edgedesksports.com/email/stop/#t=' + TOK);
  x = await run(O, {}, out(), cfgOf({ url: '' }));
  chk('O not configured → 503, nothing asked', x.r.status === 503 && LOG.length === 0);
  ENV.OUTBOUND_OPTOUT_PAGE = '';
  S = {}; LOG = [];
  const dflt = await O.handle(out({ method: 'GET' }));
  chk('O by default the page is edgedesksports.com/email/stop/', dflt.headers.get('location') === 'https://edgedesksports.com/email/stop/#t=' + TOK);

  /* ══ N. THE NEWSLETTER'S WEBHOOK IGNORES OUTBOUND EMAIL ═══════════════ */
  const sign = (id, ts, body) => 'v1,' + crypto.createHmac('sha256', Buffer.from(NL_SECRET.slice(6), 'base64')).update(id + '.' + ts + '.' + body).digest('base64');
  const nl = (data, id, type) => {
    const body = JSON.stringify({ type: type || 'email.bounced', created_at: '2026-10-07T10:00:00Z', data });
    const ts = String(Math.floor(Date.now() / 1000));
    return new Request(URL_ + '/functions/v1/newsletter/webhook', { method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sign(id, ts, body) }, body });
  };
  const bounce = { email_id: 'msg_out_1', to: ['pat@cfbnumbers.test'], bounce: { type: 'Permanent', subType: 'General' } };
  for (const [label, tags] of [['tags as an object', { edgedesk: 'outbound', send: 's-1' }], ['tags as a list', [{ name: 'edgedesk', value: 'outbound' }, { name: 'send', value: 's-1' }]]]) {
    x = await run(N, {}, nl(Object.assign({}, bounce, { tags }), 'evt_out_' + label.length), null);
    chk('N an OUTBOUND email\'s event (' + label + ') is acknowledged and NOTHING is written: no event row, no suppression', x.r.status === 200 && x.b.state === 'not_newsletter'
      && LOG.length === 0, LOG.map((e) => e.url));
  }
  x = await run(N, {}, nl({ email_id: 'rcv_1', from: 'Pat Analyst <pat@cfbnumbers.test>', to: ['replies@edgedesksports.com'], subject: 'Re: your ratings',
    received_for: ['replies@edgedesksports.com'], message_id: '<a@b>', attachments: [] }, 'evt_rcv_1', 'email.received'), null);
  chk('N an email RECEIVED (a reply to the outbound engine) is not the newsletter\'s: acknowledged, nothing written — no sender, no subject', x.r.status === 200
    && x.b.state === 'not_newsletter' && LOG.length === 0, LOG.map((e) => e.url));
  x = await run(N, {}, nl(Object.assign({}, bounce, { email_id: 'msg_nl_1', to: ['reader@x.test'], tags: { category: 'newsletter' } }), 'evt_nl_1'), null);
  chk('N the newsletter\'s own events are still handled (stored, and a hard bounce suppressed)', x.r.status === 200 && LOG.some((e) => /newsletter_events/.test(e.url))
    && LOG.some((e) => /rpc\/newsletter_suppress$/.test(e.url)), LOG.map((e) => e.url));
  x = await run(N, {}, nl(Object.assign({}, bounce, { email_id: 'msg_nl_2', to: ['reader@x.test'] }), 'evt_nl_2'), null);
  chk('N … including one with no tags at all', x.r.status === 200 && LOG.some((e) => /newsletter_events/.test(e.url)));
  chk('N the tag test: only edgedesk=outbound counts', N.isOutboundEvent({ tags: { edgedesk: 'outbound' } }) && N.isOutboundEvent({ tags: [{ name: 'edgedesk', value: 'outbound' }] })
    && !N.isOutboundEvent({ tags: { edgedesk: 'newsletter' } }) && !N.isOutboundEvent({ tags: [{ name: 'category', value: 'outbound' }] }) && !N.isOutboundEvent({})
    && !N.isOutboundEvent(null) && !N.isOutboundEvent({ tags: 'edgedesk=outbound' }) && !N.isOutboundEvent({ tags: [null] }));
  chk('N a Content Engine email (edgedesk=content) is not the newsletter’s either', N.isContentEvent({ tags: { edgedesk: 'content' } }) && N.isContentEvent({ tags: [{ name: 'edgedesk', value: 'content' }] })
    && !N.isContentEvent({ tags: { edgedesk: 'outbound' } }) && !N.isContentEvent({}) && !N.isContentEvent(null) && !N.isOutboundEvent({ tags: { edgedesk: 'content' } }));
  const unsigned = nl(Object.assign({}, bounce, { tags: { edgedesk: 'outbound' } }), 'evt_x');
  const forged = new Request(unsigned.url, { method: 'POST', headers: { 'svix-id': 'evt_x', 'svix-timestamp': unsigned.headers.get('svix-timestamp'), 'svix-signature': 'v1,forged' }, body: await unsigned.text() });
  x = await run(N, {}, forged, null);
  chk('N the signature is still checked first (an unsigned "outbound" event is a 401, not a 200)', x.r.status === 401 && LOG.length === 0);

  for (const f of failures) console.log('FAIL | ' + f);
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound webhook + opt-out functions: ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
