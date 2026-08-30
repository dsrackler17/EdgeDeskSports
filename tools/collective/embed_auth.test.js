#!/usr/bin/env node
/* ===========================================================================
   Tests for how the Collective embed decides whether it has a reader to
   vouch for (viewerToken in collective/embed.js).

   THE CASE: the embed asked for its bootstrap anonymously, always, so every
   pre-kickoff number came back locked -- including for a reader signed in to
   the very site the embed is running on. Inside the EdgeDesk app that is the
   whole board greyed out for somebody who is paying for it, with no way from
   that screen to say so.

   The embed now lets a host page hand over its reader's access token. That is
   a credential, and this script also runs on OTHER PEOPLE'S sites, so the
   rules it is allowed to break are none:

     - never to an API base a host page chose. `data-api` exists for testing.
     - never the project's publishable anon key, which is also a JWT and would
       make the panel claim a stranger is signed in.
     - never anything that is not a token for an actual person.
     - a host that provides nothing, or throws, costs the panel nothing.

   Run: node tools/collective/embed_auth.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'collective', 'embed.js'), 'utf8');
const a = SRC.indexOf('  var VIEWER = false;');
const b = SRC.indexOf('  /* When the market arrives', a);
if (a < 0 || b < 0) {
  console.log('FAIL | collective/embed.js no longer carries the viewerToken block between its markers');
  process.exit(1);
}
const BLOCK = SRC.slice(a, b);
global.window = global;
global.DEFAULT_API = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1';
global.API = global.DEFAULT_API;
global.THEME = 'dark';
global.HOST = '';
global.TIMEOUT_MS = 6000;
/* The block runs its bootstrap fetch on load, so give it somewhere harmless
   to land before the pure checks below re-run it for real. */
global.fetch = () => new Promise(() => {});
global.render = () => {};
global.fallback = () => {};
vm.runInThisContext(BLOCK, { filename: 'collective/embed.js [viewer + bootstrap]' });

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = claims => 'h.' + b64u(claims) + '.sig';
const PERSON = jwt({ role: 'authenticated', sub: '9f1c0c2e-0000-4000-8000-abcdefabcdef', exp: 9e9 });
/* The shape Supabase's publishable anon key really has. */
const ANON = jwt({ iss: 'supabase', ref: 'iattxbkbufslbauoumga', role: 'anon', iat: 1, exp: 9e9 });

async function ask(fn, api) {
  global.API = api || global.DEFAULT_API;
  if (fn === undefined) delete global.MCEmbedToken; else global.MCEmbedToken = fn;
  return await global.viewerToken();
}

(async function () {
  chk('a signed-in reader is handed over',
    (await ask(() => PERSON)) === PERSON);
  chk('a promise works as well as a plain return',
    (await ask(() => Promise.resolve(PERSON))) === PERSON);

  chk('the publishable anon key is NOT an identity',
    (await ask(() => ANON)) === null, { got: await ask(() => ANON) });
  chk('a token with no subject is not a person',
    (await ask(() => jwt({ role: 'authenticated' }))) === null);
  chk('a service role token is not accepted as a reader either',
    (await ask(() => jwt({ role: 'service_role', sub: 'x' }))) === null);
  chk('a string that is not a JWT is refused',
    (await ask(() => 'let-me-in')) === null);
  chk('undecodable middle segment is refused rather than thrown on',
    (await ask(() => 'h.@@@@.sig')) === null);
  chk('empty and null are refused',
    (await ask(() => '')) === null && (await ask(() => null)) === null);
  chk('whitespace is not a credential',
    (await ask(() => '   ')) === null);

  chk('a host that provides no hook gets no credential sent',
    (await ask(undefined)) === null);
  chk('a hook that is not a function is ignored',
    (await ask('not a function')) === null);
  chk('a hook that throws costs nothing',
    (await ask(() => { throw new Error('nope'); })) === null);
  chk('a hook that rejects costs nothing',
    (await ask(() => Promise.reject(new Error('nope')))) === null);

  chk('a credential NEVER follows a host-supplied API base',
    (await ask(() => PERSON, 'https://not-the-collective.example/functions/v1')) === null);
  chk('not even to something that merely looks like the real one',
    (await ask(() => PERSON, global.DEFAULT_API + '.evil.example')) === null);

  /* ---- the wire: what actually leaves the page -------------------------
     viewerToken() deciding correctly is half of it. The half that was never
     covered is whether the decision reaches the request, and whether VIEWER
     is true at the moment render() reads it to choose what the locked panel
     says. A reader looking at a grey board cannot tell those apart, so the
     suite has to. */
  async function boot(opts) {
    opts = opts || {};
    const sent = [];
    let statuses = opts.statuses ? opts.statuses.slice() : [200];
    global.API = global.DEFAULT_API;
    if (opts.hook === undefined) delete global.MCEmbedToken; else global.MCEmbedToken = opts.hook;
    const done = {};
    const settled = new Promise(res => { done.res = res; });
    let throws = opts.throws || 0;
    global.fetch = function (url, init) {
      sent.push({ url: String(url), headers: (init && init.headers) || null });
      /* A preflight the server refuses reaches JS as a plain network error,
         which is what `throws` stands in for here. */
      if (throws > 0) { throws--; return Promise.reject(new TypeError('Failed to fetch')); }
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return Promise.resolve({
        status, ok: status >= 200 && status < 300,
        json: () => Promise.resolve({ wall: [] })
      });
    };
    global.render = d => done.res({ what: 'render', viewer: global.VIEWER, sent, d });
    global.fallback = f => done.res({ what: 'fallback', forbidden: !!f, viewer: global.VIEWER, sent });
    vm.runInThisContext(BLOCK, { filename: 'collective/embed.js [bootstrap]' });
    return settled;
  }
  const authOf = r => (r.sent[0] && r.sent[0].headers && r.sent[0].headers.authorization) || null;

  let r = await boot({ hook: () => PERSON });
  chk('a signed-in reader\'s token actually reaches the bootstrap request',
    authOf(r) === 'Bearer ' + PERSON, { got: authOf(r) });
  chk('and render is told it is looking at a known reader',
    r.what === 'render' && r.viewer === true, { got: r.what + '/' + r.viewer });

  r = await boot({ hook: undefined });
  chk('a signed-out reader sends no Authorization header at all',
    authOf(r) === null && (r.sent[0].headers == null), { got: r.sent[0] });
  chk('and render is told so',
    r.what === 'render' && r.viewer === false, { got: r.what + '/' + r.viewer });

  r = await boot({ hook: () => ANON });
  chk('the anon key never reaches the wire either', authOf(r) === null, { got: authOf(r) });

  r = await boot({ hook: () => PERSON, statuses: [401, 200] });
  chk('a refused identity is retried WITHOUT it rather than showing nothing',
    r.what === 'render' && r.sent.length === 2
    && authOf(r) === 'Bearer ' + PERSON
    && (r.sent[1].headers == null || !r.sent[1].headers.authorization), { got: r.sent });
  chk('and the panel is not told a reader was recognised after a 401',
    r.viewer === false, { got: r.viewer });

  /* The case that matters while the API catches up: a deployment whose CORS
     preflight does not allow Authorization kills the request before it
     leaves the browser. Sending a token must never turn a locked board into
     no board at all. */
  r = await boot({ hook: () => PERSON, throws: 1 });
  chk('a blocked preflight is retried as a stranger, not turned into an outage',
    r.what === 'render' && r.sent.length === 2
    && (r.sent[1].headers == null || !r.sent[1].headers.authorization), { got: r.sent });
  chk('and the panel is not told a reader was recognised', r.viewer === false, { got: r.viewer });

  r = await boot({ hook: undefined, throws: 1 });
  chk('a genuine outage with no identity to drop falls back at once',
    r.what === 'fallback' && r.sent.length === 1, { got: r.sent.length });

  r = await boot({ hook: () => PERSON, throws: 2 });
  chk('if the anonymous retry fails too, it is an outage and says so',
    r.what === 'fallback' && r.sent.length === 2, { got: r.sent.length });

  r = await boot({ hook: () => PERSON, statuses: [403] });
  chk('a 403 is the host-not-registered fallback, not a lock',
    r.what === 'fallback' && r.forbidden === true, { got: r });

  r = await boot({ hook: () => PERSON, statuses: [500] });
  chk('any other failure falls back rather than rendering nothing',
    r.what === 'fallback' && r.forbidden === false, { got: r });

  failures.forEach(f => console.log('FAIL | ' + f.name
    + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e)); process.exit(1); });
