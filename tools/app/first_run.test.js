#!/usr/bin/env node
/* ===========================================================================
   THE FIRST-TIME USER, HELD IN PLACE.

   Everything a stranger has to get through before EdgeDesk is any use to
   them — land, sign up, confirm the email, reach the terminal, reach Games,
   and say something is broken — and each thing here failed for a real reason
   that a real person hit:

     1  The link in the confirmation email went NOWHERE. Nothing on the site
        read #access_token, ?token_hash or ?error, so a confirmed account
        landed on a marketing page that still said "Start researching" and
        left an access token in the address bar.
     2  Signing up twice with the same address said "Account created" both
        times. Supabase answers an existing address with 200 and an empty
        `identities` array; reading only `access_token` turned a returning
        customer into somebody waiting for an email that was never sent.
     3  The reset link was sent with no redirect_to, so it landed on a page
        with no password form on it — and reset.html only understood one of
        the three shapes the link can arrive in anyway.
     4  Reporting a problem was a dead button. The textarea's id collided
        with the football research board's, so the handler read the BOARD,
        `.value` was undefined and `.trim()` threw before the try/catch: no
        message, no request, nothing. It posted to a table this repository
        never created.
     5  Games — the free, no-account half of the product — was hidden from
        the nav below 1080px, so no phone or tablet visitor could see it.

   Run: node tools/app/first_run.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
const has = (h, n, name) => chk(name, String(h).indexOf(n) >= 0, 'missing: ' + n);
const lacks = (h, n, name) => chk(name, String(h).indexOf(n) < 0, 'unexpectedly present: ' + n);
const eq = (name, got, want) => chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

/* Some assertions need a promise to settle. They are collected here and
   awaited before the summary is printed, so a suite can never report green
   while half of it is still in flight. */
const PENDING = [];
const later = (p) => { PENDING.push(p.catch((e) => { fail++; failures.push('threw: ' + (e && e.message)); })); };

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LANDING = read('index.html'), APP = read('app.html'), RESET = read('reset.html'),
      NOTFOUND = read('404.html'), GAMESJS = read('games/games.js'),
      GAMESAUTH = read('games/lib/auth.js'), ADMIN = read('admin.html'),
      SQL = read('supabase/issue_reports.sql');

/* A DOM-free window, so the two shared modules can be loaded and driven the
   way the pages drive them. */
function sandbox(overrides) {
  const store = {};
  const w = Object.assign({
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    location: { origin: 'https://edgedesksports.com', pathname: '/', search: '', hash: '' },
    history: { replaceState: function (a, b, u) { w.__replaced = u; } },
    navigator: { userAgent: 'TestAgent/1.0', language: 'en-GB' },
    screen: { width: 390, height: 844 },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
    document: { referrer: '' },
    __store: store
  }, overrides || {});
  return w;
}
function loadAuth(w) {
  const src = read('lib/edgedesk_auth.js');
  new Function('window', 'globalThis', 'module', src + '\nreturn window.EDAuth;')(w, w, { exports: {} });
  return w.EDAuth;
}
function loadReport(w) {
  const src = read('lib/edgedesk_report.js');
  new Function('window', 'globalThis', 'module', src + '\nreturn window.EDReport;')(w, w, { exports: {} });
  return w.EDReport;
}
/* A believable access token: header.payload.signature, base64url payload. */
function tok(claims) {
  const b = Buffer.from(JSON.stringify(claims)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'eyJhbGciOiJIUzI1NiJ9.' + b + '.sig';
}

/* ======================================================================== */
/* 1. THE LINK FROM THE EMAIL                                               */
/* ======================================================================== */
{
  const A = loadAuth(sandbox());

  eq('a page with nothing in its URL is not an auth callback',
    A.parse({ hash: '', search: '' }).kind, 'none');

  const implicit = A.parse({ hash: '#access_token=abc&refresh_token=r1&expires_in=3600&token_type=bearer&type=signup', search: '' });
  eq('the implicit shape is recognised', implicit.kind, 'session');
  eq('and carries the type through', implicit.type, 'signup');
  eq('and the refresh token is kept, not dropped', implicit.session.refresh_token, 'r1');
  chk('and an absolute expiry is derived when only expires_in was sent',
    implicit.session.expires_at > Math.floor(Date.now() / 1000));

  eq('the token_hash shape is recognised as something to verify',
    A.parse({ hash: '', search: '?token_hash=xyz&type=recovery' }).kind, 'verify');
  eq('a link error in the query string is an error, not a session',
    A.parse({ hash: '', search: '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired' }).kind, 'error');
  eq('and the same error in the hash is read too',
    A.parse({ hash: '#error=access_denied&error_description=expired', search: '' }).kind, 'error');
  chk('an expired link says so in words a person can act on',
    /expired/i.test(A.parse({ hash: '', search: '?error=access_denied&error_code=otp_expired&error_description=Email+link+has+expired' }).message));
  eq('a PKCE code we never minted is reported, not swallowed',
    A.parse({ hash: '', search: '?code=abc123' }).kind, 'unfinishable');
  eq('a malformed URL is "none" rather than a thrown boot error',
    A.parse(null).kind, 'none');

  /* THE TOKENS DO NOT STAY IN THE ADDRESS BAR. */
  eq('scrubbing removes every auth parameter',
    A.scrubbed({ pathname: '/index.html', search: '?ref=abc&code=1', hash: '#access_token=x&type=signup' }),
    '/index.html?ref=abc');
  eq('and leaves a route hash the app owns exactly as it was',
    A.scrubbed({ pathname: '/app.html', search: '', hash: '#research/football' }), '/app.html#research/football');
  eq('including one that is not a key=value list at all',
    A.scrubbed({ pathname: '/', search: '', hash: '#pricing' }), '/#pricing');
  lacks(A.scrubbed({ pathname: '/', search: '?token_hash=t&type=recovery', hash: '' }), 'token_hash',
    'a token_hash never survives the scrub either');
}

/* consume(): the whole round trip, without a browser */
{
  const w = sandbox({ location: { origin: 'https://edgedesksports.com', pathname: '/index.html', search: '', hash: '#access_token=' + tok({ sub: 'u1', email: 'a@b.co', exp: 4102444800 }) + '&refresh_token=r&type=signup' } });
  const A = loadAuth(w);
  later(A.consume({ url: 'https://sb', key: 'k' }).then((r) => {
    chk('consuming a confirmation link reports success', r.handled === true && r.ok === true);
    eq('and the type reaches the caller', r.type, 'signup');
    chk('and the session is stored under the key every page reads',
      !!w.__store['edgedesk_session'] && JSON.parse(w.__store['edgedesk_session']).refresh_token === 'r');
    eq('and the URL no longer carries the token', w.__replaced, '/index.html');
  }));
}
{
  const w = sandbox({ location: { origin: 'https://x', pathname: '/index.html', search: '?error=access_denied&error_description=Email+link+is+invalid+or+has+expired', hash: '' } });
  const A = loadAuth(w);
  later(A.consume({ url: 'https://sb', key: 'k' }).then((r) => {
    chk('an expired link is handled and reported as a failure', r.handled === true && r.ok === false);
    chk('with a sentence rather than a code', /expired/i.test(r.message));
    chk('and no session is invented for it', !w.__store['edgedesk_session']);
    eq('and the error is cleared from the URL too', w.__replaced, '/index.html');
  }));
}
{
  /* token_hash: the shape reset.html used to call invalid */
  const w = sandbox({ location: { origin: 'https://x', pathname: '/reset.html', search: '?token_hash=th&type=recovery', hash: '' } });
  const A = loadAuth(w);
  let sent = null;
  const fakeFetch = (url, o) => { sent = { url, body: JSON.parse(o.body) };
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ access_token: tok({ sub: 'u2', exp: 4102444800 }), refresh_token: 'r2' })) }); };
  later(A.consume({ url: 'https://sb', key: 'k', fetch: fakeFetch }).then((r) => {
    chk('a token_hash is exchanged at /auth/v1/verify', /\/auth\/v1\/verify$/.test(sent.url));
    chk('with the type it was given', sent.body.type === 'recovery' && sent.body.token_hash === 'th');
    chk('and the session that comes back is stored', r.ok === true && !!w.__store['edgedesk_session']);
  }));
}
{
  const w = sandbox({ location: { origin: 'https://x', pathname: '/reset.html', search: '?token_hash=th&type=recovery', hash: '' } });
  const A = loadAuth(w);
  const fakeFetch = () => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ msg: 'Token has expired or is invalid' })) });
  later(A.consume({ url: 'https://sb', key: 'k', fetch: fakeFetch }).then((r) => {
    chk('a refused verify is a failure with a readable reason', r.ok === false && /expired/i.test(r.message));
    chk('and stores nothing', !w.__store['edgedesk_session']);
  }));
}

/* ======================================================================== */
/* 2. WHAT A SUPABASE ANSWER MEANS                                          */
/* ======================================================================== */
{
  const A = loadAuth(sandbox());
  chk('an already-registered signup is recognised from the empty identities array',
    A.isExistingUser({ id: 'x', identities: [] }) === true);
  chk('and a real new account is not', A.isExistingUser({ id: 'x', identities: [{ id: 'i' }] }) === false);
  chk('and neither is a response that has no identities field at all',
    A.isExistingUser({ access_token: 'x' }) === false);

  ['a@b.co', 'first.last@sub.example.com', 'x+tag@example.co.uk'].forEach((e) =>
    chk('a valid address passes: ' + e, A.validEmail(e) === true));
  ['', 'nope', 'a@b', 'a b@c.co', 'a@@b.co', 'a@.co', 'a@b..co', 'a@b.', '  '].forEach((e) =>
    chk('a bad address is caught before the round trip: ' + JSON.stringify(e), A.validEmail(e) === false));

  /* THE GATEWAY'S OWN WORDS NEVER REACH A CUSTOMER. */
  const raw = 'Unable to validate email address: invalid format';
  const out = A.message({ msg: raw }, 400, 'signup');
  lacks(out, 'Unable to validate', 'a raw Supabase sentence is never forwarded verbatim');
  chk('and it is replaced with something actionable', /email address does not look right/i.test(out));
  chk('a bad password is a sentence', /at least 6/i.test(A.message({ msg: 'Password should be at least 6 characters' }, 422, 'signup')));
  chk('a wrong password says what to do next', /Forgot password/i.test(A.message({ error_description: 'Invalid login credentials' }, 400, 'signin')));
  chk('an unconfirmed email points at the inbox', /inbox/i.test(A.message({ msg: 'Email not confirmed' }, 400, 'signin')));
  chk('a rate limit is not dressed up as a password problem', /Too many/i.test(A.message({}, 429, 'signin')));
  chk('a 5xx says nothing was changed', /Nothing was changed/i.test(A.message({}, 503, 'signup')));
  chk('an unrecognised error gets an honest generic, not a database string',
    A.message({ msg: 'pq: relation "x" does not exist' }, 400, 'signup') === 'Could not create the account. Please try again.');
}

/* ======================================================================== */
/* 3. REPORTING A PROBLEM                                                   */
/* ======================================================================== */
{
  const w = sandbox();
  loadAuth(w); const R = loadReport(w);
  R.configure({ url: 'https://sb', key: 'anon-key', version: '1.4.0', surface: 'terminal' });

  eq('a visitor with no session is classified anonymous', R.authState(), 'anonymous');
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: tok({ sub: 'u1', email: 'a@b.co', exp: 1 }) });
  eq('an expired session is its own state, not "anonymous"', R.authState(), 'session_expired');
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: 'not-a-jwt' });
  eq('and an unreadable one is too', R.authState(), 'session_unreadable');
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: tok({ sub: 'u1', email: 'a@b.co', exp: 4102444800 }) });
  eq('a live session is authenticated', R.authState(), 'authenticated');

  const m = R.metadata();
  eq('the report knows who filed it', m.user_id, 'u1');
  /* A lapsed session is the state of the person most likely to be reporting a
     problem. Sending the stale id on the anon key would have the insert policy
     refuse the row, so the id is dropped and only the auth_state is kept. */
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: tok({ sub: 'u1', email: 'a@b.co', exp: 1 }) });
  const stale = R.metadata();
  eq('a lapsed session files anonymously rather than being refused', stale.user_id, null);
  eq('but says so, which is the useful half', stale.auth_state, 'session_expired');
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: tok({ sub: 'u1', email: 'a@b.co', exp: 4102444800 }) });
  eq('and their email, from the token rather than a stale envelope', m.user_email, 'a@b.co');
  chk('and where, when, on what and how big', !!m.route && !!m.reported_at && !!m.user_agent && /390x844/.test(m.viewport));
  eq('and which build', m.app_version, '1.4.0');

  /* NOTHING SENSITIVE, EVER. */
  const w2 = sandbox({ location: { origin: 'https://edgedesksports.com', pathname: '/index.html', search: '', hash: '#access_token=SECRET&type=signup' } });
  loadAuth(w2); const R2 = loadReport(w2);
  R2.configure({ url: 'https://sb', key: 'anon-key', version: 'x', surface: 'landing' });
  const m2 = R2.metadata();
  lacks(JSON.stringify(m2), 'SECRET', 'a report filed from the confirmation link carries no access token');
  lacks(JSON.stringify(m2), 'anon-key', 'and never the api key either');
}
{
  const w = sandbox();
  loadAuth(w); const R = loadReport(w);
  R.configure({ url: 'https://sb', key: 'anon-key', version: '1', surface: 'landing' });

  later(R.submit({ summary: '', details: 'x' }).then((r) =>
    chk('an empty summary is refused before any request', r.ok === false && r.reason === 'input')));
  later(R.submit({ summary: 'x', details: '' }).then((r) =>
    chk('and so is an empty description', r.ok === false && r.reason === 'input')));

  let sent = null;
  const okFetch = (url, o) => { sent = { url, headers: o.headers, body: JSON.parse(o.body) };
    return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve(JSON.stringify([{ id: 'abcd1234-0000' }])) }); };
  later(R.submit({ summary: 'It broke', details: 'I clicked and nothing happened', category: 'Something is broken' }, okFetch)
    .then((r) => {
      chk('a stored report reports success', r.ok === true);
      eq('with a reference the reporter can quote', r.id, 'abcd1234-0000');
      chk('written to the committed table', /\/rest\/v1\/issue_reports$/.test(sent.url));
      chk('an anonymous report goes out on the anon key', sent.headers.authorization === 'Bearer anon-key');
      chk('and files no user_id, so nobody can be impersonated', sent.body[0].user_id === null);
      lacks(JSON.stringify(sent.body), 'password', 'no password field exists to send');
    }));

  /* THE FAILURE PATH IS THE POINT. */
  const missing = () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.issue_reports'" })) });
  later(R.submit({ summary: 'It broke', details: 'again' }, missing).then((r) => {
    chk('a missing table is a failure, never a thank-you', r.ok === false);
    lacks(r.message, 'PGRST205', 'and the customer is not shown a PostgREST code');
    lacks(r.message, 'issue_reports', 'nor the name of a table they cannot do anything about');
    chk('and the whole report comes back as a mailto so it is not lost',
      /^mailto:support@edgedesksports\.com\?/.test(R.mailtoFor(r.row)) && /It%20broke/.test(R.mailtoFor(r.row)));
  }));
  later(R.submit({ summary: 'x', details: 'y' }, () => Promise.reject(new Error('offline'))).then((r) =>
    chk('an unreachable server is reported as one', r.ok === false && r.reason === 'unreachable' && /connection/i.test(r.message))));
  later(R.submit({ summary: 'x', details: 'y' }, () => Promise.resolve({ ok: false, status: 403, text: () => Promise.resolve('{}') })).then((r) =>
    chk('a refused write is reported as one', r.ok === false && /email/i.test(r.message))));

  /* signed in: the reporter's own bearer, so RLS records auth.uid() */
  w.__store['edgedesk_session'] = JSON.stringify({ access_token: tok({ sub: 'u9', email: 'z@b.co', exp: 4102444800 }) });
  let sent2 = null;
  later(R.submit({ summary: 'x', details: 'y' }, (url, o) => { sent2 = JSON.parse(o.body); 
    return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve('[]') }); }).then(() => {
    eq('a signed-in report is filed against the account', sent2[0].user_id, 'u9');
    eq('and records which auth state it was filed from', sent2[0].auth_state, 'authenticated');
  }));
}

/* ======================================================================== */
/* 4. THE PAGES ACTUALLY OFFER IT                                           */
/* ======================================================================== */
has(LANDING, 'lib/edgedesk_report.js', 'the landing page loads the reporter');
has(LANDING, 'data-ed-report', 'and has a way in');
chk('including on the signup form itself, which is where people get stuck',
  /data-ed-report="I could not sign up or log in"/.test(LANDING));
has(APP, 'lib/edgedesk_report.js', 'the terminal loads the reporter');
has(APP, 'data-ed-report', 'and has a way in');
chk('including from the paywall, which locks out exactly the newest users',
  APP.indexOf('data-ed-report="Payment or billing"') > 0);
chk('and the paywall is no longer a dead end for a free user',
  /href="\/games\/\?ref=paygate"/.test(APP));
has(NOTFOUND, 'data-ed-report', 'the 404 page can report a broken link');
has(GAMESJS, 'data-ed-report', 'every Games page gets the link through the shared footer');
has(GAMESJS, 'function sharedLibs', 'and loads the shared libraries once rather than per page');
has(ADMIN, 'issue_reports?select=', 'the operator screen reads the real table');
has(ADMIN, 'Problem reports', 'and is reachable as its own tab');

/* THE DEAD BUTTON IS GONE, AND SO IS WHAT MADE IT DEAD. */
eq('the id collision that killed the old feedback form is gone',
  (APP.match(/<[a-z]+[^>]*\bid="fbBody"/g) || []).length, 1);
chk('and no textarea claims that id any more',
  !/<textarea[^>]*id="fbBody"/.test(APP));
lacks(APP, '__submitFeedback', 'the handler that threw before its own try/catch is removed');
lacks(APP, "/rest/v1/feedback'", 'nothing posts to the table this repo never created');
chk('and no customer is told to run a migration',
  !/textContent\s*=[^;]*feedback\.sql/.test(APP) && !/msg\([^)]*feedback\.sql/.test(APP));

/* ======================================================================== */
/* 5. THE SIGNUP FLOW ITSELF                                                */
/* ======================================================================== */
has(LANDING, 'handleAuthCallback', 'the landing page finishes the link from the email');
chk('and does it before it decides what to market at the visitor',
  LANDING.indexOf('if(await handleAuthCallback()) return;') > 0
  && LANDING.indexOf('if(await handleAuthCallback()) return;') < LANDING.indexOf('var s=edSession();\n  if(s&&(s.access_token||s.refresh_token))'));
has(LANDING, 'function showExisting', 'an address that already has an account gets one honest answer');
chk('used on BOTH the ways Supabase reports it — the explicit error and the silent 200',
  (LANDING.match(/showExisting\(email\);/g) || []).length === 2);
chk('signup asks for the confirmation link to come back here',
  /\/auth\/v1\/signup\?redirect_to='\+encodeURIComponent\(location\.origin\+'\/'\)/.test(LANDING));
chk('the reset link is aimed at the page that can reset a password',
  /recover\?redirect_to='\+encodeURIComponent\(location\.origin\+'\/reset\.html'\)/.test(LANDING));
has(LANDING, 'EDAuth.validEmail(email)', 'a mistyped address is caught before the round trip');
has(LANDING, 'EDAuth.message(d,r.status', 'and every other error goes through the shared vocabulary');

has(RESET, 'lib/edgedesk_auth.js', 'the reset page shares that vocabulary too');
has(RESET, 'EDAuth.consume', 'and understands every shape the link arrives in');
lacks(RESET, "p.get('access_token')", 'rather than the single hash form it used to insist on');

/* Games */
has(GAMESAUTH, 'grant_type=refresh_token', 'Games can renew a lapsed session');
has(GAMESAUTH, 'function ensure()', 'and does it on boot rather than demoting the player');
has(GAMESJS, 'consumeAuthLink', 'a confirmation link that lands in Games is finished there');
chk('the landing nav no longer hides the free half of the product on a phone',
  /<a class="nlink" href="\/games\/">Games<\/a>/.test(LANDING));

/* ======================================================================== */
/* 6. THE SQL SAYS WHAT THE CLIENT ASSUMES                                  */
/* ======================================================================== */
has(SQL, 'create table if not exists public.issue_reports', 'the table is committed, not folklore');
has(SQL, 'enable row level security', 'with RLS on');
has(SQL, 'to anon, authenticated', 'anyone may file a report');
chk('but nobody may file one under another account id',
  /with check \(user_id is null or user_id = auth\.uid\(\)\)/.test(SQL));
chk('anon has no read policy at all',
  !/create policy issue_reports_read[\s\S]{0,200}to anon/.test(SQL));
lacks(SQL, 'for delete', 'and there is no delete path for anybody');
has(SQL, 'issue_reports_no_credentials', 'a pasted token is refused by the database itself');

Promise.all(PENDING).then(() => {
  console.log('');
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('\nfirst-run experience: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
