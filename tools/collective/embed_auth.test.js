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
const b = SRC.indexOf('  /* ---------- fetch ---------- */', a);
if (a < 0 || b < 0) {
  console.log('FAIL | collective/embed.js no longer carries the viewerToken block between its markers');
  process.exit(1);
}
global.window = global;
global.DEFAULT_API = 'https://iattxbkbufslbauoumga.supabase.co/functions/v1';
global.API = global.DEFAULT_API;
vm.runInThisContext(SRC.slice(a, b), { filename: 'collective/embed.js [viewerToken]' });

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

  failures.forEach(f => console.log('FAIL | ' + f.name
    + (f.detail ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('FAIL | the suite could not run  ' + String((e && e.stack) || e)); process.exit(1); });
