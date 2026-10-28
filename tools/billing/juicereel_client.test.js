#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_juicereel_billing.js — the browser's door to juicereel_billing.
   What it must never do: navigate anywhere but Juice Reel, hand the server a
   stale or foreign return, keep the return in the tab once read, or decide
   access itself. No database or browser needed.
   Run: node tools/billing/juicereel_client.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const X = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_juicereel_billing.js'));

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); }
}
function store(init) {
  const m = Object.assign({}, init || {});
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, m };
}

(async () => {
  /* go(): Juice Reel only */
  const went = [];
  const loc = { assign: (u) => went.push(u) };
  chk('go() navigates to https://www.juicereel.com/…', X.go('https://www.juicereel.com/checkout/sessions/x', loc) === true && went.length === 1);
  chk('go() navigates to https://juicereel.com/…', X.go('https://juicereel.com/oauth2/authorize?x=1', loc) === true && went.length === 2);
  for (const bad of ['http://www.juicereel.com/x', 'https://www.juicereel.com.evil.example/x', 'https://evil.example/https://www.juicereel.com/',
    'javascript:alert(1)', '//www.juicereel.com/x', 'https://wwwjuicereel.com/x', null, 42]) {
    chk('go() refuses ' + JSON.stringify(bad), X.go(bad, loc) === false);
  }
  chk('…and navigated nowhere for any of them', went.length === 2);

  /* takeReturn(): read once, never stale */
  const fresh = store({ [X.HANDOFF_KEY]: JSON.stringify({ at: Date.now(), state: 's'.repeat(43), code: 'c1', error: null }) });
  chk('peekReturn() sees a return without consuming it', X.peekReturn(fresh) === true && X.HANDOFF_KEY in fresh.m);
  const r = X.takeReturn(fresh);
  chk('takeReturn() gives state and code', r && r.state === 's'.repeat(43) && r.code === 'c1' && r.error === null, r);
  chk('…and removes it from the tab as it reads it', !(X.HANDOFF_KEY in fresh.m) && X.takeReturn(fresh) === null);
  const old = store({ [X.HANDOFF_KEY]: JSON.stringify({ at: Date.now() - 31 * 60 * 1000, state: 's'.repeat(43), code: 'c1' }) });
  chk('a return older than 30 minutes is dropped (and still removed)', X.takeReturn(old) === null && !(X.HANDOFF_KEY in old.m));
  chk('junk in the tab is not a return', X.takeReturn(store({ [X.HANDOFF_KEY]: '{not json' })) === null
    && X.takeReturn(store({ [X.HANDOFF_KEY]: JSON.stringify({ at: Date.now(), code: 'c' }) })) === null);
  const blocked = { getItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  chk('storage that throws is no return, and no crash', X.takeReturn(blocked) === null && X.peekReturn(blocked) === false);

  /* the network door: never navigates to a URL the server did not vouch for */
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    const b = JSON.parse(init.body);
    if (b.action === 'start') return { status: 200, json: async () => ({ ok: true, url: b.kind === 'link' ? 'https://evil.example/x' : 'https://www.juicereel.com/checkout/sessions/1' }) };
    if (b.action === 'complete') return { status: 503, json: async () => ({ ok: false, retryable: calls.filter((c) => JSON.parse(c.init.body).action === 'complete').length === 1, reason: 'PLATFORM_DOWN' }) };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const cfg = { url: 'https://sb.test/', key: 'anon', token: () => Promise.resolve('tok') };
  let s = await X.start(cfg, 'checkout');
  chk('start() returns the Juice Reel URL the server gave', s.ok && s.url === 'https://www.juicereel.com/checkout/sessions/1');
  chk('…to the juicereel_billing function, with the reader\'s token', calls[0].url === 'https://sb.test/functions/v1/juicereel_billing' && calls[0].init.headers.authorization === 'Bearer tok');
  s = await X.start(cfg, 'link');
  chk('start() refuses a URL from the server that is not Juice Reel\'s', s.ok === false);
  s = await X.start({ url: 'https://sb.test', key: 'anon', token: null }, 'checkout');
  chk('signed out: start() asks nothing and says sign in', s.ok === false && s.reason === 'signed_out' && calls.length === 2);
  const c = await X.complete(cfg, { state: 'st', code: 'cd' }, { retryMs: 1 });
  const completes = calls.filter((x) => JSON.parse(x.init.body).action === 'complete');
  chk('complete() retries once, only when the server says retryable, then reports', completes.length === 2 && c.ok === false && c.status === 503);
  chk('complete() sends state and code, and the refusal word when there is one',
    JSON.parse(completes[0].init.body).state === 'st' && JSON.parse(completes[0].init.body).code === 'cd'
      && !('error' in JSON.parse(completes[0].init.body)));

  /* rows */
  chk('isJuiceReelRow() names a Juice Reel row and nothing else', X.isJuiceReelRow({ price_id: 'juicereel' }) && !X.isJuiceReelRow({ price_id: 'price_x' })
    && !X.isJuiceReelRow({ price_id: 'owner_comp' }) && !X.isJuiceReelRow(null));
  chk('live() is ON and ready only', X.live({ mode: 'on', ready: true }) && !X.live({ mode: 'on', ready: false }) && !X.live({ mode: 'operators', ready: true }) && !X.live(null));

  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | juicereel client | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
