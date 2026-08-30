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
/* stateFrom lives above the block, beside the emitter it feeds. */
const sfA = SRC.indexOf('  function stateFrom(d, locked) {');
const sfB = SRC.indexOf('  function emitState(detail) {', sfA);
if (sfA < 0 || sfB < 0) {
  console.log('FAIL | collective/embed.js no longer carries stateFrom between its markers');
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
vm.runInThisContext(SRC.slice(sfA, sfB), { filename: 'collective/embed.js [stateFrom]' });

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
    const painted = [];
    const fell = [];
    global.API = global.DEFAULT_API;
    if (opts.hook === undefined) delete global.MCEmbedToken; else global.MCEmbedToken = opts.hook;
    /* Answers are keyed by whether the request carried an identity, because
       that is the whole point: the two can differ, and the anonymous one is
       the floor that must survive whatever happens to the other. */
    const plan = { anon: opts.anon || { status: 200 }, auth: opts.auth || { status: 200 } };
    global.fetch = function (url, init) {
      const auth = !!(init && init.headers && init.headers.authorization);
      sent.push({ auth, headers: (init && init.headers) || null });
      const p = auth ? plan.auth : plan.anon;
      if (p.throws) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        status: p.status, ok: p.status >= 200 && p.status < 300,
        json: () => Promise.resolve(p.body || { wall: [], upcoming: { entitled: !auth ? false : true } })
      });
    };
    global.render = d => { global.LAST = d; painted.push({ d, viewer: global.VIEWER, handoff: global.HANDOFF }); };
    global.fallback = f => fell.push(!!f);
    global.LAST = null;
    vm.runInThisContext(BLOCK, { filename: 'collective/embed.js [bootstrap]' });
    /* every stubbed promise is immediate; a few turns of the loop is plenty */
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    return { sent, painted, fell, viewer: global.VIEWER, handoff: global.HANDOFF };
  }

  const anonReqs = r => r.sent.filter(x => !x.auth).length;
  const authReqs = r => r.sent.filter(x => x.auth).length;
  const last = r => r.painted[r.painted.length - 1];

  let r = await boot({ hook: () => PERSON });
  chk('a signed-in reader is asked for both ways: the floor and the upgrade',
    anonReqs(r) === 1 && authReqs(r) === 1, { got: r.sent });
  chk('the identity really is on the identified request',
    r.sent.find(x => x.auth).headers.authorization === 'Bearer ' + PERSON);
  chk('and never on the anonymous one',
    r.sent.filter(x => !x.auth).every(x => x.headers == null || !x.headers.authorization));
  chk('the identified answer is what ends up on screen',
    last(r).handoff === 'ok' && last(r).viewer === true, { got: last(r) });
  chk('nothing fell back', r.fell.length === 0);

  r = await boot({ hook: undefined });
  chk('a signed-out reader makes exactly one request, with no header',
    r.sent.length === 1 && !r.sent[0].auth);
  chk('and is reported as never handed over', r.handoff === 'none', { got: r.handoff });

  r = await boot({ hook: () => ANON });
  chk('the publishable anon key never reaches the wire', authReqs(r) === 0, { got: r.sent });

  /* THE CASE THAT BROKE THE PANEL. An API that does not allow the
     Authorization header on its preflight kills that request in the browser
     -- and the board must not notice. */
  r = await boot({ hook: () => PERSON, auth: { throws: true } });
  chk('a refused preflight does NOT take the board down',
    r.painted.length >= 1 && r.fell.length === 0, { painted: r.painted.length, fell: r.fell });
  chk('the anonymous board is what is showing', anonReqs(r) === 1);
  chk('and it says the hand-off was refused, not that the reader is signed out',
    r.handoff === 'refused', { got: r.handoff });

  r = await boot({ hook: () => PERSON, auth: { status: 401 } });
  chk('a rejected token is the same: board stands, hand-off refused',
    r.painted.length >= 1 && r.fell.length === 0 && r.handoff === 'refused', { got: r });
  r = await boot({ hook: () => PERSON, auth: { status: 500 } });
  chk('so is a server error on the identified request',
    r.painted.length >= 1 && r.fell.length === 0 && r.handoff === 'refused');
  r = await boot({ hook: () => PERSON, auth: { status: 403 } });
  chk('and a 403 on it is not the host-not-registered fallback either',
    r.fell.length === 0 && r.handoff === 'refused', { got: r.fell });

  /* "Unreachable" means nothing on screen and nothing still coming. */
  r = await boot({ hook: undefined, anon: { status: 403 } });
  chk('a 403 with nothing else coming is the host-not-registered fallback',
    r.fell.length === 1 && r.fell[0] === true, { got: r.fell });
  r = await boot({ hook: undefined, anon: { status: 500 } });
  chk('a server error falls back', r.fell.length === 1 && r.fell[0] === false);
  r = await boot({ hook: undefined, anon: { throws: true } });
  chk('a genuine outage falls back', r.fell.length === 1);
  r = await boot({ hook: () => PERSON, anon: { throws: true }, auth: { throws: true } });
  chk('both failing is a real outage, and falls back exactly once',
    r.fell.length === 1 && r.painted.length === 0, { got: r });

  /* The race that would otherwise flash an error over a board about to
     arrive, and report an outage that is not happening. */
  r = await boot({ hook: () => PERSON, anon: { throws: true } });
  chk('a floor failure is NOT an outage while the identified answer is still coming',
    r.painted.length === 1 && r.fell.length === 0, { painted: r.painted.length, fell: r.fell });
  chk('and that answer is the one on screen', last(r).handoff === 'ok');
  r = await boot({ hook: () => PERSON, anon: { status: 403 } });
  chk('the same holds for a 403 on the floor when an identity is in flight',
    r.fell.length === 0 && r.painted.length === 1, { got: r.fell });

    /* ---- what the host page is told, and what it says -------------------
     A locked row looks the same whichever reason it is. The Collective's
     payload now names the reason; these hold the translation of it, because
     a diagnostic that is itself wrong is worse than none -- it sends the
     reader after the wrong thing. */
  global.VIEWER = true;
  let st = global.stateFrom({ entitlement: { identified: true, entitled: true, via: 'edgedesk' } }, true);
  chk('the API\'s own answer beats the local guess about the lock',
    st.entitled === true && st.via === 'edgedesk' && st.viewer === true, { got: st });
  st = global.stateFrom({ entitlement: { identified: true, entitled: false, via: null } }, true);
  chk('recognised but not paid is carried through as exactly that',
    st.viewer === true && st.entitled === false && st.via === null, { got: st });
  st = global.stateFrom({ entitlement: { identified: false, entitled: false, via: null } }, true);
  chk('an unidentified reader is reported unidentified even when a token was sent',
    st.viewer === false, { got: st });
  global.VIEWER = true;
  st = global.stateFrom({ wall: [] }, false);
  chk('a payload with no entitlement block falls back to what it always used',
    st.viewer === true && st.entitled === true && st.via === null, { got: st });
  st = global.stateFrom({ wall: [] }, true);
  chk('and to the lock when there is one', st.entitled === false, { got: st });

  failures.forEach(f => console.log('FAIL | ' + f.name
    + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e)); process.exit(1); });
