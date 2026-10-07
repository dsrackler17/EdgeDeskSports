#!/usr/bin/env node
/* ===========================================================================
   The Edge Functions' owner check, offline (tools/growth/outbound_auth.js).

   Every privileged outbound Edge Function (send, later phases) runs this
   before anything else. What has to be true:

     * no Authorization, a malformed one, or the public anon key        → 401
     * a token GoTrue rejects (expired, revoked, forged)                → 401
     * GoTrue unreachable / 5xx                                         → 503
     * a real account the database says is not an owner                → 403
     * the owner check answering anything but exactly `true`           → 403
     * outbound not installed / the database unreachable               → 503
     * ONLY a GoTrue-verified account the database calls an owner       → ok
     * the user id comes from GoTrue, never from the request body
     * the owner question is asked AS THE CALLER, with the anon apikey —
       no service-role secret is involved
     * across every failure combination, ok is never true

   Run: node tools/growth/outbound_auth.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, 'outbound_auth.js'));

let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) pass++; else { fail++; failures.push(n + (d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : '')); } };

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon';
const OWNER_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig-owner';
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });
const req = (authz, body) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? authz : null) }, body });

function fake(o) {
  const log = [];
  const f = async (url, init) => {
    url = String(url);
    log.push({ url: url.replace(URL_, ''), apikey: init.headers.apikey, authz: init.headers.authorization, body: init.body });
    if (/\/auth\/v1\/user$/.test(url)) { if (o.user === 'throw') throw new TypeError('network'); return o.user; }
    if (/growth_outbound_is_owner$/.test(url)) { if (o.owner === 'throw') throw new TypeError('network'); return o.owner; }
    return res(404, {});
  };
  return { f, log };
}
const cfg = (f) => ({ url: URL_, anonKey: ANON, fetch: f });
const USER_OK = res(200, { id: 'owner-uuid', email: 'owner@edgedesk.test' });

(async () => {
  /* 1. the header */
  for (const [label, h] of [['no Authorization', null], ['not Bearer', 'Basic abc'], ['Bearer with nothing', 'Bearer '],
                            ['the anon key', 'Bearer ' + ANON], ['not a JWT', 'Bearer abc.def'], ['two tokens', 'Bearer a.b.c d.e.f']]) {
    const s = fake({ user: USER_OK, owner: res(200, true) });
    const r = await A.requireOutboundOwner(req(h), cfg(s.f));
    chk('1 ' + label + ' → 401 without asking anyone', r.ok === false && r.status === 401 && s.log.length === 0, r);
  }

  /* 2. GoTrue */
  for (const [label, user, status, reason] of [
    ['an expired / revoked token', res(401, { msg: 'invalid JWT' }), 401, 'session_invalid'],
    ['a forged token', res(403, { msg: 'bad signature' }), 401, 'session_invalid'],
    ['a 200 with no user id', res(200, { email: 'x@y.z' }), 401, 'session_invalid'],
    ['a 200 that is not JSON', res(200, '<html>'), 401, 'session_invalid'],
    ['GoTrue down (5xx)', res(502, null), 503, 'auth_unavailable'],
    ['GoTrue unreachable', 'throw', 503, 'auth_unavailable']]) {
    const s = fake({ user, owner: res(200, true) });
    const r = await A.requireOutboundOwner(req('Bearer ' + OWNER_JWT), cfg(s.f));
    chk('2 ' + label + ' → ' + status, r.ok === false && r.status === status && r.reason === reason, r);
    chk('2 … and the owner question is never asked', !s.log.some((e) => /is_owner/.test(e.url)));
  }

  /* 3. the database's answer */
  for (const [label, owner, status, reason] of [
    ['not an owner (false)', res(200, false), 403, 'not_an_owner'],
    ['an affiliate admin who is not an owner (false)', res(200, false), 403, 'not_an_owner'],
    ['"true" as a string', res(200, '"true"'), 403, 'not_an_owner'],
    ['an object', res(200, { owner: true }), 403, 'not_an_owner'],
    ['null', res(200, null), 403, 'not_an_owner'],
    ['refused (403)', res(403, { code: '42501' }), 403, 'not_an_owner'],
    ['outbound not installed', res(404, { code: 'PGRST202' }), 503, 'outbound_not_installed'],
    ['token rejected by PostgREST', res(401, { code: 'PGRST303' }), 401, 'session_invalid'],
    ['database down', res(503, null), 503, 'owner_check_unavailable'],
    ['database unreachable', 'throw', 503, 'owner_check_unavailable']]) {
    const s = fake({ user: USER_OK, owner });
    const r = await A.requireOutboundOwner(req('Bearer ' + OWNER_JWT), cfg(s.f));
    chk('3 ' + label + ' → ' + status, r.ok === false && r.status === status && r.reason === reason, r);
  }

  /* 4. the owner */
  {
    const s = fake({ user: USER_OK, owner: res(200, true) });
    const r = await A.requireOutboundOwner(req('Bearer ' + OWNER_JWT, { user_id: 'someone-else' }), cfg(s.f));
    chk('4 a GoTrue-verified owner → ok', r.ok === true && r.status === 200);
    chk('4 … the user id is GoTrue\'s, never the body\'s', r.user.id === 'owner-uuid');
    const ask = s.log.find((e) => /is_owner/.test(e.url));
    chk('4 … the owner question is asked AS THE CALLER with the anon apikey', ask && ask.authz === 'Bearer ' + OWNER_JWT && ask.apikey === ANON);
    chk('4 … GoTrue is asked with the caller\'s token too', s.log[0].authz === 'Bearer ' + OWNER_JWT && s.log[0].apikey === ANON);
    chk('4 … no service-role secret appears in any request', s.log.every((e) => e.apikey === ANON && !/service/i.test(String(e.authz))));
    chk('4 lower-case "bearer" is accepted', (await A.requireOutboundOwner(req('bearer ' + OWNER_JWT), cfg(fake({ user: USER_OK, owner: res(200, true) }).f))).ok === true);
    const c = await A.rpcAsCaller(cfg(s.f), r.authz, 'growth_outbound_draft_approve', { p_draft_id: 'x' });
    const last = s.log[s.log.length - 1];
    chk('4 later doors are called as the caller as well', last.authz === 'Bearer ' + OWNER_JWT && last.apikey === ANON && /draft_approve/.test(last.url) && c.status === 404);
  }

  /* 5. never ok on any failure combination */
  {
    const users = [USER_OK, res(401, {}), res(500, null), 'throw', res(200, {})];
    const owners = [res(200, true), res(200, false), res(500, null), 'throw', res(404, { code: 'PGRST202' }), res(200, '"true"'), res(401, {})];
    let bad = 0, n = 0;
    for (const u of users) for (const o of owners) {
      n++;
      const r = await A.requireOutboundOwner(req('Bearer ' + OWNER_JWT), cfg(fake({ user: u, owner: o }).f));
      const shouldPass = u === USER_OK && o === owners[0];
      if (r.ok !== shouldPass) bad++;
    }
    chk('5 across ' + n + ' combinations, only (verified user, owner = true) passes', bad === 0, bad);
  }

  /* 6. misconfiguration fails closed */
  chk('6 no URL or key configured → refused', (await A.requireOutboundOwner(req('Bearer ' + OWNER_JWT), { fetch: async () => USER_OK })).ok === false);

  if (fail) for (const x of failures) console.log('FAIL | ' + x);
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound owner check: ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
