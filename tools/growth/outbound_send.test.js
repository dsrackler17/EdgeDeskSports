#!/usr/bin/env node
/* ===========================================================================
   THE SEND EDGE FUNCTION, tested as deployed
   (supabase/functions/growth_outbound_send/index.ts).

   The DEPLOYED file is imported — not a copy — under Node's native type
   stripping with a Deno shim and a mocked network (GoTrue, PostgREST,
   Resend), the way tools/editorial/editorial_cron.test.js holds its function.

     1  the owner check is the canonical one, byte for byte
     2  CORS answers only EdgeDesk's own pages; only POST
     3  nothing is claimed or sent without a GoTrue-verified OWNER; a non-owner
        gets 403 and no database write; a bad body 400; no Resend key 503 —
        all before any claim
     4  the happy path: claim AS THE CALLER, Resend with the claim's
        Idempotency-Key and EXACTLY the claimed message, result recorded
     5  the database's refusal, an already-sent draft and a retry: no second
        send, and a retry reuses the key
     6  Resend's answers: 422 → failed (permanent); 5xx, 429, 409, timeout →
        still claimed (retry with the same key); 401 → stop the batch
     7  a message that is not one EdgeDesk email to one person (wrong sender,
        two recipients, a header injection) is never sent
     8  no service-role key anywhere; every database call as the caller with
        the anon apikey; no token or key in any response

   Run: node tools/growth/outbound_send.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : '')); } };

const FN = path.join(__dirname, '..', '..', 'supabase', 'functions', 'growth_outbound_send', 'index.ts');
const SRC = fs.readFileSync(FN, 'utf8');
const INLINE = require(path.join(__dirname, 'inline_outbound_auth.js'));

/* ── 1. the canonical owner check, verbatim ────────────────────────────── */
chk('1 the function carries tools/growth/outbound_auth.js byte for byte', INLINE.drifted().length === 0);
chk('1 … and no service-role key, anywhere in its source', !/SERVICE_ROLE/i.test(SRC) && !/service_role/.test(SRC.replace(/no service-role key|NO service-role key/gi, '')));

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const RKEY = 're_test_secret_key_123';
const ENV = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, RESEND_API_KEY: RKEY };
globalThis.Deno = { env: { get: (k) => ENV[k] } };   /* no serve: the server stays uninstalled */

const D1 = '20000000-0000-0000-0000-000000000001', D2 = '20000000-0000-0000-0000-000000000002', D3 = '20000000-0000-0000-0000-000000000003';
const MSG = (o) => Object.assign({ from: 'Davis <davis@edgedesksports.com>', to: 'owner-test@edgedesk.test', reply_to: 'davis@edgedesksports.com',
  subject: 'Your CFB ratings', text: 'Hi Pat.\n\n--\nDavis, EdgeDesk Sports\n100 Example St\nNot for you? Reply "stop"',
  headers: { 'List-Unsubscribe': '<https://x.supabase.co/functions/v1/growth_outbound_optout?t=abc>, <mailto:davis@edgedesksports.com?subject=stop>',
             'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }, o || {});
const CLAIM_OK = (id, o) => Object.assign({ ok: true, send_id: 's-' + id.slice(-1), idempotency_key: 'edgedesk-outbound-' + id, test: true, message: MSG() }, o || {});

let S;   /* the scenario for the next request */
let LOG; /* every request the function made */
const res = (status, body) => ({ ok: status >= 200 && status < 300, status,
  text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => { if (body === undefined || typeof body === 'string') throw new Error('not json'); return body; } });
globalThis.fetch = async (url, init) => {
  url = String(url);
  const h = (init && init.headers) || {};
  const entry = { url, authz: h.authorization, apikey: h.apikey, idem: h['idempotency-key'], body: init && init.body ? JSON.parse(init.body) : null };
  LOG.push(entry);
  if (/\/auth\/v1\/user$/.test(url)) return S.user || res(200, { id: 'owner-uuid', email: 'owner@edgedesk.test' });
  if (/rpc\/growth_outbound_is_owner$/.test(url)) return S.owner || res(200, true);
  if (/rpc\/growth_outbound_send_claim$/.test(url)) {
    const id = entry.body.p_draft_id;
    const v = typeof S.claim === 'function' ? S.claim(id) : S.claim;
    return v || res(200, CLAIM_OK(id));
  }
  if (/rpc\/growth_outbound_send_result$/.test(url)) return S.result || res(200, { ok: true });
  if (url === 'https://api.resend.com/emails') {
    if (S.resend === 'throw') throw new TypeError('network');
    const v = typeof S.resend === 'function' ? S.resend(entry) : S.resend;
    return v || res(200, { id: 'msg_' + entry.body.tags[1].value });
  }
  return res(404, { message: 'unexpected ' + url });
};

const req = (o) => new Request('https://proj.supabase.test/functions/v1/growth_outbound_send', {
  method: o.method || 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, o.authz === null ? {} : { authorization: o.authz || 'Bearer ' + OWNER }, o.origin ? { origin: o.origin } : {}),
  body: o.method === 'OPTIONS' || o.method === 'GET' ? undefined : (o.raw != null ? o.raw : JSON.stringify(o.body))
});
const of = (pat) => LOG.filter((e) => pat.test(e.url));

(async () => {
  const M = await import(FN);
  const run = async (scenario, o) => { S = scenario || {}; LOG = []; const r = await M.handle(req(o)); let b = null; try { b = await r.json(); } catch (_) { b = null; } return { r, b }; };

  /* ── 2. CORS and method ──────────────────────────────────────────────── */
  let x = await run({}, { method: 'OPTIONS', origin: 'https://edgedesksports.com', authz: null });
  chk('2 a preflight from EdgeDesk is answered, for EdgeDesk', x.r.status === 204 && x.r.headers.get('access-control-allow-origin') === 'https://edgedesksports.com'
    && /POST/.test(x.r.headers.get('access-control-allow-methods')) && LOG.length === 0);
  x = await run({}, { method: 'OPTIONS', origin: 'https://evil.test', authz: null });
  chk('2 … and not for anyone else', x.r.status === 204 && x.r.headers.get('access-control-allow-origin') === null);
  x = await run({}, { method: 'GET' });
  chk('2 only POST', x.r.status === 405 && LOG.length === 0);

  /* ── 3. who, and what, before anything is claimed ────────────────────── */
  x = await run({}, { authz: null, body: { draft_ids: [D1] } });
  chk('3 no token → 401, nothing claimed, nothing sent', x.r.status === 401 && of(/send_claim|resend/).length === 0);
  x = await run({}, { authz: 'Bearer ' + ANON, body: { draft_ids: [D1] } });
  chk('3 the public anon key is nobody → 401', x.r.status === 401 && LOG.length === 0);
  x = await run({ user: res(401, { msg: 'expired' }) }, { body: { draft_ids: [D1] } });
  chk('3 a token GoTrue rejects → 401', x.r.status === 401 && of(/send_claim|resend/).length === 0);
  x = await run({ owner: res(200, false) }, { body: { draft_ids: [D1] } });
  chk('3 a signed-in non-owner → 403, nothing claimed, nothing sent', x.r.status === 403 && x.b.reason === 'not_an_owner' && of(/send_claim|resend/).length === 0);
  x = await run({ owner: res(404, { code: 'PGRST202' }) }, { body: { draft_ids: [D1] } });
  chk('3 outbound not installed → 503', x.r.status === 503 && of(/send_claim/).length === 0);
  for (const [label, body, raw] of [['no ids', {}], ['an empty list', { draft_ids: [] }], ['not a uuid', { draft_ids: ['x'] }],
                                    ['26 drafts', { draft_ids: Array.from({ length: 26 }, (_, i) => '20000000-0000-0000-0000-' + String(i).padStart(12, '0')) }],
                                    ['not JSON', null, '{nope']]) {
    x = await run({}, { body, raw });
    chk('3 a bad request (' + label + ') → 400, nothing claimed', x.r.status === 400 && of(/send_claim/).length === 0, x.b);
  }
  ENV.RESEND_API_KEY = '';
  x = await run({}, { body: { draft_ids: [D1] } });
  chk('3 no Resend key → 503 BEFORE anything is claimed', x.r.status === 503 && x.b.reason === 'resend_not_configured' && of(/send_claim/).length === 0);
  ENV.RESEND_API_KEY = RKEY;

  /* ── 4. the happy path ───────────────────────────────────────────────── */
  x = await run({}, { origin: 'https://edgedesksports.com', body: { draft_ids: [D1] } });
  const cl = of(/send_claim/)[0], rs = of(/api\.resend\.com/)[0], rec = of(/send_result/)[0];
  chk('4 one draft: claimed, sent, recorded — in that order', x.r.status === 200 && x.b.ok === true && x.b.sent === 1 && x.b.results[0].state === 'sent'
    && LOG.indexOf(cl) < LOG.indexOf(rs) && LOG.indexOf(rs) < LOG.indexOf(rec), x.b);
  chk('4 the claim is made AS THE CALLER, with the anon apikey', cl.authz === 'Bearer ' + OWNER && cl.apikey === ANON && cl.body.p_draft_id === D1);
  chk('4 Resend gets the claim\'s Idempotency-Key and the provider key', rs.idem === 'edgedesk-outbound-' + D1 && rs.authz === 'Bearer ' + RKEY);
  const m = MSG();
  chk('4 … and EXACTLY the message the database composed', rs.body.from === m.from && JSON.stringify(rs.body.to) === JSON.stringify([m.to]) && rs.body.subject === m.subject
    && rs.body.text === m.text && rs.body.reply_to === m.reply_to && JSON.stringify(rs.body.headers) === JSON.stringify(m.headers), rs.body);
  chk('4 the one-click List-Unsubscribe headers go with it', /<https:\/\/.+growth_outbound_optout\?t=abc>/.test(rs.body.headers['List-Unsubscribe'])
    && rs.body.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
  chk('4 the result is recorded as the caller, with Resend\'s id', rec.authz === 'Bearer ' + OWNER && rec.body.p_send_id === 's-1' && rec.body.p_resend_id === 'msg_s-1' && rec.body.p_permanent === false);
  chk('4 the answer is readable by EdgeDesk and carries no key or token', x.r.headers.get('access-control-allow-origin') === 'https://edgedesksports.com'
    && !JSON.stringify(x.b).includes(RKEY) && !JSON.stringify(x.b).includes(OWNER) && !JSON.stringify(x.b).includes(ANON));
  x = await run({}, { body: { draft_ids: [D1, D2, D1.toUpperCase()] } });
  chk('4 several drafts, each once, one after another', x.b.results.length === 2 && x.b.sent === 2 && of(/api\.resend\.com/).length === 2
    && of(/api\.resend\.com/).map((e) => e.idem).join() === 'edgedesk-outbound-' + D1 + ',edgedesk-outbound-' + D2);
  x = await run({}, { body: { draft_id: D3 } });
  chk('4 a single draft_id works too', x.b.sent === 1);

  /* ── 5. the database decides ─────────────────────────────────────────── */
  x = await run({ claim: res(200, { ok: false, reason: 'refused', detail: 'the daily send cap (20) is reached' }) }, { body: { draft_ids: [D1, D2] } });
  chk('5 a refused claim sends nothing, and says why', of(/api\.resend\.com/).length === 0 && x.b.results.every((r) => r.ok === false && /daily send cap/.test(r.detail)) && x.b.sent === 0);
  x = await run({ claim: res(200, { ok: true, already: true, send_id: 's-1', state: 'sent' }) }, { body: { draft_ids: [D1] } });
  chk('5 an already-sent draft is never sent again', of(/api\.resend\.com/).length === 0 && x.b.results[0].already === true && x.b.sent === 0);
  x = await run({ claim: (id) => res(200, CLAIM_OK(id, { retry: true })) }, { body: { draft_ids: [D1] } });
  chk('5 a retry of an unanswered claim reuses the SAME key', of(/api\.resend\.com/)[0].idem === 'edgedesk-outbound-' + D1 && x.b.results[0].retry === true);
  x = await run({ claim: res(403, { code: '42501', message: 'outbound owner only' }) }, { body: { draft_ids: [D1, D2] } });
  chk('5 an owner demoted mid-batch stops the batch', x.b.results.length === 1 && x.b.results[0].reason === 'not_an_owner' && of(/api\.resend\.com/).length === 0);

  /* ── 6. Resend's answers ─────────────────────────────────────────────── */
  x = await run({ resend: res(422, { name: 'validation_error', message: 'Invalid `to` field' }) }, { body: { draft_ids: [D1] } });
  let rr = of(/send_result/)[0];
  chk('6 a 422 is a permanent refusal: recorded failed, with Resend\'s words', x.b.results[0].state === 'failed' && rr.body.p_permanent === true && /Invalid `to` field/.test(rr.body.p_error));
  for (const [label, ans] of [['a 500', res(500, { message: 'oops' })], ['a 429', res(429, { message: 'slow down' })],
                              ['a 409 (same key in flight)', res(409, { name: 'concurrent_idempotent_requests' })], ['no answer at all', 'throw']]) {
    x = await run({ resend: ans }, { body: { draft_ids: [D1] } });
    rr = of(/send_result/)[0];
    chk('6 ' + label + ' leaves the send claimed for a retry with the same key', x.b.results[0].state === 'claimed' && x.b.results[0].retry === true
      && rr.body.p_permanent === false && rr.body.p_resend_id === null, x.b.results[0]);
  }
  x = await run({ resend: res(401, { message: 'API key is invalid' }) }, { body: { draft_ids: [D1, D2] } });
  chk('6 a refused API key stops the batch after the first (nothing marked failed)', x.b.results.length === 1 && x.b.results[0].reason === 'resend_key_refused'
    && of(/send_result/)[0].body.p_permanent === false && of(/api\.resend\.com/).length === 1);
  x = await run({ resend: res(200, {}) }, { body: { draft_ids: [D1] } });
  chk('6 a 200 without an id is not "sent"', x.b.results[0].state === 'claimed');
  x = await run({ result: res(500, null) }, { body: { draft_ids: [D1] } });
  chk('6 sent but not recorded: says so, and that pressing Send again records it without sending twice', x.b.results[0].state === 'sent'
    && x.b.results[0].recorded === false && /cannot send twice/.test(x.b.results[0].warning));

  /* ── 7. only one EdgeDesk email to one person ────────────────────────── */
  for (const [label, msg] of [
    ['a sender off edgedesksports.com', MSG({ from: 'Davis <davis@evil.test>' })],
    ['a sender address pretending', MSG({ from: 'Davis <davis@edgedesksports.com.evil.test>' })],
    ['two recipients', MSG({ to: 'a@x.test, b@y.test' })],
    ['a header injection in the subject', MSG({ subject: 'Hi\r\nBcc: everyone@x.test' })],
    ['a header injection in a header', MSG({ headers: { 'List-Unsubscribe': '<https://x>\r\nBcc: x@y.test' } })],
    ['an extra header', MSG({ headers: { Bcc: 'x@y.test' } })],
    ['a reply-to elsewhere', MSG({ reply_to: 'someone@evil.test' })],
    ['an empty body', MSG({ text: '  ' })]]) {
    x = await run({ claim: (id) => res(200, CLAIM_OK(id, { message: msg })) }, { body: { draft_ids: [D1] } });
    chk('7 ' + label + ': never sent, and the claim stays open (not failed)', of(/api\.resend\.com/).length === 0 && x.b.results[0].reason === 'message_check_failed'
      && of(/send_result/)[0].body.p_permanent === false, x.b.results[0]);
  }
  chk('7 the check passes a real EdgeDesk message', M.checkMessage(MSG()) === null);

  /* ── 8. credentials ──────────────────────────────────────────────────── */
  x = await run({}, { body: { draft_ids: [D1, D2] } });
  const sb = LOG.filter((e) => e.url.indexOf(URL_) === 0);
  chk('8 every database call carries the anon apikey and the CALLER\'s token — never another credential', sb.length >= 5
    && sb.every((e) => e.apikey === ANON && e.authz === 'Bearer ' + OWNER));
  chk('8 the provider key goes only to Resend', LOG.filter((e) => e.authz === 'Bearer ' + RKEY).every((e) => e.url === 'https://api.resend.com/emails'));

  for (const f of failures) console.log('FAIL | ' + f);
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound send function: ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
