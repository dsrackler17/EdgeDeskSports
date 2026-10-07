#!/usr/bin/env node
/* ===========================================================================
   THE OPERATOR CONSOLES' SESSION, OFFLINE (lib/edgedesk_admin_session.js).

   The bug this replaces: /admin/growth/ presented a stored access token with
   no refresh, so every visit after the first hour was answered 401 PGRST303
   "JWT expired" and reported as "this account cannot open the growth
   console". What has to be true now:

     * an expired / expiring token is refreshed before it is sent
     * a 401 refreshes ONCE and retries ONCE — then stops (no loop)
     * a refused refresh drops the session and says "sign in again", in words
     * a 5xx / network failure on refresh keeps the session (transient)
     * concurrent callers share ONE refresh (rotating single-use tokens)
     * another tab's rotation is adopted rather than fought
     * an operator call is never downgraded to the anon key
     * not-an-operator, not-installed and signed-out are distinct answers
     * no message, and nothing logged, ever carries a token or a password
     * sign-out clears local state first, then revokes server-side

   Run: node tools/growth/admin_session.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(ROOT, 'lib', 'edgedesk_admin_session.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) pass++; else { fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const eq = (n, got, want) => chk(n, got === want, { got, want });

/* everything printed during the run is captured: no token may appear in it */
const printed = [];
for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[k];
  console[k] = (...a) => { printed.push(a.map(String).join(' ')); if (k === 'log') orig.apply(console, a); };
}

const URL_ = 'https://proj.supabase.test';
const ANON = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature';
const SKEY = 'edgedesk_growth_admin_session';
let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
const now = () => clock;
const sec = () => Math.floor(clock / 1000);

/* a JWT-shaped token whose exp claim is real, so the jwt fallback is exercised */
function jwt(tag, expSec) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256' }) + '.' + b({ sub: 'u-' + tag, exp: expSec, role: 'authenticated' }) + '.sig-' + tag;
}
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)) });

/* A scripted Supabase. `rpc(name, token, body)` decides each PostgREST answer;
   `refresh(rt)` decides each refresh answer. Every request is logged with the
   bearer it carried. */
function fakeSupabase(o) {
  const log = [];
  let n = 0;
  const f = async (url, init) => {
    /* a real round trip yields to the event loop, and a client that loops is
       stopped here rather than hanging the suite */
    await new Promise((r) => setImmediate(r));
    if (log.length >= 60) throw new Error('request storm: more than 60 requests from one client');
    url = String(url);
    const h = (init && init.headers) || {};
    const bearer = String(h.authorization || '').replace(/^Bearer /, '');
    const body = init && init.body ? JSON.parse(init.body) : null;
    const entry = { url: url.replace(URL_, ''), bearer, body, apikey: h.apikey };
    log.push(entry);
    if (o.network && o.network(entry)) throw new TypeError('Failed to fetch');
    if (/\/auth\/v1\/token\?grant_type=refresh_token/.test(url)) return o.refresh ? o.refresh(body.refresh_token, ++n) : res(400, { error: 'invalid_grant' });
    if (/\/auth\/v1\/token\?grant_type=password/.test(url)) return o.password ? o.password(body) : res(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    if (/\/auth\/v1\/logout/.test(url)) return o.logout ? o.logout(bearer) : res(204, null);
    const m = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(url);
    if (m) return o.rpc(m[1], bearer, body);
    const fm = /\/functions\/v1\/([a-z_-]+)/.exec(url);
    if (fm && o.fn) return o.fn(fm[1], bearer, body);
    return res(404, { message: 'no route' });
  };
  return { f, log };
}
const expiredPgrst = res.bind(null, 401, { code: 'PGRST303', details: null, hint: null, message: 'JWT expired' });

function stored(at, rt, expSec, extra) {
  return Object.assign({ access_token: at, refresh_token: rt, expires_at: expSec, user: { id: 'owner-1', email: 'owner@edgedesk.test' } }, extra || {});
}
function make(store, sb, extra) {
  return M.create(Object.assign({ url: URL_, key: ANON, storageKey: SKEY, storage: store, fetch: sb.f, now, adminRpc: 'growth_is_admin', watchStorage: false }, extra || {}));
}
const rpcCalls = (log, name) => log.filter((e) => e.url.indexOf('/rest/v1/rpc/' + name) === 0);
const refreshes = (log) => log.filter((e) => /grant_type=refresh_token/.test(e.url));

/* a retry loop must fail the suite, never hang it */
setTimeout(() => { console.log('FAIL — admin session: the suite did not finish in 30 s (a retry loop?)'); process.exit(1); }, 30000).unref();

(async () => {
  /* ===================================================================== */
  /* 1. THE REPORTED BUG — a stored session an hour old                    */
  /* ===================================================================== */
  {
    const OLD = jwt('old', sec() - 600), NEW = jwt('new', sec() + 3600);
    /* the legacy shape: the whole /token answer, as the old page stored it */
    const legacy = { access_token: OLD, refresh_token: 'rt-1', expires_in: 3600, expires_at: sec() - 600, token_type: 'bearer',
      user: { id: 'owner-1', email: 'owner@edgedesk.test', phone: '+15555550100', user_metadata: { full_name: 'X' }, identities: [{}] } };
    const store = memStore({ [SKEY]: JSON.stringify(legacy) });
    const sb = fakeSupabase({
      refresh: (rt) => rt === 'rt-1' ? res(200, { access_token: NEW, refresh_token: 'rt-2', expires_in: 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } }) : res(400, { error: 'invalid_grant' }),
      rpc: (name, bearer) => bearer === NEW ? res(200, name === 'growth_is_admin' ? true : { ok: true }) : expiredPgrst()
    });
    const S = make(store, sb);
    const a = await S.checkAdmin();
    eq('expired stored session → refreshed, then the operator check passes', a.state, 'ok');
    eq('… with exactly one refresh', refreshes(sb.log).length, 1);
    eq('… and the expired token is never sent (proactive refresh)', sb.log.filter((e) => e.bearer === OLD).length, 0);
    const saved = JSON.parse(store.getItem(SKEY));
    eq('the rotated session is stored', saved.access_token, NEW);
    eq('… with the rotated refresh token', saved.refresh_token, 'rt-2');
    chk('the stored session keeps only what the console needs (no phone, metadata, identities)',
      !('phone' in saved.user) && !('user_metadata' in saved.user) && !('identities' in saved.user) && Object.keys(saved).sort().join() === 'access_token,expires_at,refresh_token,token_type,user', saved);
    eq('the console can name the operator without decoding the JWT', S.email(), 'owner@edgedesk.test');
  }

  /* ===================================================================== */
  /* 2. A 401 MID-LIFE (server clock ahead, revoked token…) — ONE retry      */
  /* ===================================================================== */
  {
    const A = jwt('a', sec() + 1800), B = jwt('b', sec() + 3600);
    const store = memStore({ [SKEY]: JSON.stringify(stored(A, 'rt-a', sec() + 1800)) });
    const sb = fakeSupabase({
      refresh: () => res(200, { access_token: B, refresh_token: 'rt-b', expires_in: 3600 }),
      rpc: (name, bearer) => bearer === B ? res(200, { ok: true, n: 7 }) : expiredPgrst()
    });
    const S = make(store, sb);
    const out = await S.rpc('growth_admin_samples', {});
    eq('401 PGRST303 → refresh → the request is retried and succeeds', out && out.n, 7);
    eq('… one refresh', refreshes(sb.log).length, 1);
    eq('… two attempts at the RPC, no more', rpcCalls(sb.log, 'growth_admin_samples').length, 2);
  }

  /* ===================================================================== */
  /* 3. A FRESH TOKEN REJECTED TOO — stop, do not loop                      */
  /* ===================================================================== */
  {
    const A = jwt('a', sec() + 1800);
    let k = 0;
    const store = memStore({ [SKEY]: JSON.stringify(stored(A, 'rt-a', sec() + 1800)) });
    const sb = fakeSupabase({
      refresh: () => res(200, { access_token: jwt('fresh' + (++k), sec() + 3600), refresh_token: 'rt-' + k, expires_in: 3600 }),
      rpc: () => expiredPgrst()
    });
    let signedOutWhy = null;
    const S = make(store, sb, { onSignedOut: (w) => { signedOutWhy = w; } });
    let err = null;
    try { await S.rpc('growth_admin_funnel', { p_days: 90 }); } catch (e) { err = e; }
    eq('a 401 that survives a refresh ends the session', err && err.kind, 'signed_out');
    eq('… after exactly one refresh', refreshes(sb.log).length, 1);
    eq('… and exactly two attempts', rpcCalls(sb.log, 'growth_admin_funnel').length, 2);
    eq('… the stored session is gone', store.getItem(SKEY), null);
    chk('… the page is told, in words', /sign in again/i.test(String(signedOutWhy)), signedOutWhy);
    chk('… and the error is a sentence, not PostgREST JSON', err && !/[{}]|PGRST|JWT expired/.test(err.message), err && err.message);
  }

  /* ===================================================================== */
  /* 4. THE REFRESH IS REFUSED — clean sign-in state                        */
  /* ===================================================================== */
  {
    const OLD = jwt('old', sec() - 60);
    const store = memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-dead', sec() - 60)) });
    const sb = fakeSupabase({
      refresh: () => res(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }),
      rpc: () => res(200, true)
    });
    const S = make(store, sb);
    const a = await S.checkAdmin();
    eq('refused refresh → signed_out', a.state, 'signed_out');
    chk('… with a human sentence', /sign in again/i.test(a.message) && !/refresh_token_not_found|\{/.test(a.message), a.message);
    eq('… the dead session is removed from storage', store.getItem(SKEY), null);
    eq('… no RPC was sent with a dead token (nor with anon)', rpcCalls(sb.log, 'growth_is_admin').length, 0);
    eq('… hasSession() is false', S.hasSession(), false);
    let e2 = null; try { await S.rpc('growth_admin_activation', {}); } catch (e) { e2 = e; }
    eq('a later call makes no request at all', sb.log.length, 1);
    eq('… and says signed_out', e2 && e2.kind, 'signed_out');
  }

  /* ===================================================================== */
  /* 5. TRANSIENT REFRESH FAILURE — keep the session, no loop               */
  /* ===================================================================== */
  {
    const OLD = jwt('old', sec() - 60);
    const store = memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-ok', sec() - 60)) });
    const sb = fakeSupabase({ refresh: () => res(503, { message: 'upstream unavailable' }), rpc: () => res(200, true) });
    const S = make(store, sb);
    const a = await S.checkAdmin();
    eq('auth server 503 on an expired token → server, not signed_out', a.state, 'server');
    chk('… the session survives for the next try', store.getItem(SKEY) !== null);
    eq('… one refresh attempt, no retry storm', refreshes(sb.log).length, 1);
    eq('… nothing sent with the expired token', rpcCalls(sb.log, 'growth_is_admin').length, 0);

    const sb2 = fakeSupabase({ network: (e) => /refresh_token/.test(e.url), rpc: () => res(200, true) });
    const S2 = make(memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-ok', sec() - 60)) }), sb2);
    eq('a network failure on refresh → network', (await S2.checkAdmin()).state, 'network');

    /* expiring-but-not-expired + transient refresh: the old token is still good */
    const SOON = jwt('soon', sec() + 30);
    const sb3 = fakeSupabase({ refresh: () => res(502, null), rpc: (n, b) => res(200, b === SOON) });
    const S3 = make(memStore({ [SKEY]: JSON.stringify(stored(SOON, 'rt', sec() + 30)) }), sb3);
    eq('token with 30 s left and a 502 refresh → still used while it lives', (await S3.checkAdmin()).state, 'ok');
  }

  /* ===================================================================== */
  /* 6. SINGLE-FLIGHT — five loaders at once spend the refresh token once   */
  /* ===================================================================== */
  {
    const OLD = jwt('old', sec() - 5), NEW = jwt('new', sec() + 3600);
    const store = memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-once', sec() - 5)) });
    let spent = 0;
    const sb = fakeSupabase({
      refresh: async (rt) => { await new Promise((r) => setTimeout(r, 15)); if (rt !== 'rt-once' || spent++) return res(400, { error_code: 'refresh_token_already_used' }); return res(200, { access_token: NEW, refresh_token: 'rt-next', expires_in: 3600 }); },
      rpc: (n, b) => b === NEW ? res(200, { ok: n }) : expiredPgrst()
    });
    const S = make(store, sb);
    const outs = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => S.rpc('growth_x_' + x, {})));
    chk('five concurrent calls all succeed', outs.every((o, i) => o && o.ok === 'growth_x_' + 'abcde'[i]), outs);
    eq('… with ONE refresh between them', refreshes(sb.log).length, 1);

    /* reactive: five 401s on a token the client thought was fine */
    const A = jwt('a', sec() + 1800), B = jwt('b', sec() + 3600);
    let spentR = 0;
    const sbR = fakeSupabase({
      refresh: async () => { await new Promise((r) => setTimeout(r, 10)); return spentR++ ? res(400, { error_code: 'refresh_token_already_used' }) : res(200, { access_token: B, refresh_token: 'rt-b', expires_in: 3600 }); },
      rpc: async (n, b) => { await new Promise((r) => setTimeout(r, 1)); return b === B ? res(200, true) : expiredPgrst(); }
    });
    const SR = make(memStore({ [SKEY]: JSON.stringify(stored(A, 'rt-a', sec() + 1800)) }), sbR);
    const r5 = await Promise.allSettled([1, 2, 3, 4, 5].map(() => SR.rpc('growth_is_admin', {})));
    chk('five concurrent 401s → all recover', r5.every((x) => x.status === 'fulfilled' && x.value === true), r5.map((x) => x.status + ':' + (x.reason && x.reason.kind)));
    eq('… with ONE refresh between them', refreshes(sbR.log).length, 1);
  }

  /* ===================================================================== */
  /* 7. ANOTHER TAB ROTATED FIRST — adopt its session, do not sign out       */
  /* ===================================================================== */
  {
    const OLD = jwt('old', sec() - 5), OTHER = jwt('other-tab', sec() + 3600);
    const store = memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-shared', sec() - 5)) });
    const sb = fakeSupabase({
      /* while our refresh is in the air, the other tab wins and stores its result */
      refresh: () => { store.setItem(SKEY, JSON.stringify(stored(OTHER, 'rt-other', sec() + 3600))); return res(400, { error_code: 'refresh_token_already_used' }); },
      rpc: (n, b) => res(200, b === OTHER)
    });
    const S = make(store, sb);
    eq('refresh refused because another tab spent it → that tab\'s session is used', (await S.checkAdmin()).state, 'ok');
    eq('… and kept', JSON.parse(store.getItem(SKEY)).access_token, OTHER);

    /* the other tab already refreshed BEFORE we tried: no network refresh at all */
    const store2 = memStore({ [SKEY]: JSON.stringify(stored(OTHER, 'rt-other', sec() + 3600)) });
    const sb2 = fakeSupabase({ rpc: (n, b) => b === OTHER ? res(200, true) : expiredPgrst() });
    const S2 = make(store2, sb2);
    store2.setItem(SKEY, JSON.stringify(stored(OTHER, 'rt-other', sec() + 3600)));
    eq('a token already rotated by another tab is simply read', (await S2.checkAdmin()).state, 'ok');
    eq('… without spending a refresh', refreshes(sb2.log).length, 0);
  }

  /* ===================================================================== */
  /* 8. WHO MAY OPEN THE CONSOLE — the database decides, the answers differ  */
  /* ===================================================================== */
  {
    const T = jwt('t', sec() + 3600);
    const mk = (rpcAns) => { const sb = fakeSupabase({ rpc: rpcAns }); return { sb, S: make(memStore({ [SKEY]: JSON.stringify(stored(T, 'rt', sec() + 3600)) }), sb) }; };

    const anon = fakeSupabase({ rpc: () => res(200, true) });
    const SA = make(memStore(), anon);
    const a0 = await SA.checkAdmin();
    eq('anonymous (no session) → signed_out', a0.state, 'signed_out');
    eq('… without a single request (never falls back to the anon key)', anon.log.length, 0);
    let ea = null; try { await SA.rpc('growth_admin_activation', {}); } catch (e) { ea = e; }
    eq('… and an operator RPC refuses to run anonymously', ea && ea.kind, 'signed_out');
    eq('… still without a request', anon.log.length, 0);

    const sub = mk(() => res(200, false));
    eq('a subscriber (growth_is_admin = false) → not_admin', (await sub.S.checkAdmin()).state, 'not_admin');
    chk('… told plainly, without naming tables', /does not have access/.test((await sub.S.checkAdmin()).message) && !/affiliate_admins|growth\.sql/.test((await sub.S.checkAdmin()).message));

    const sub403 = mk(() => res(403, { code: '42501', message: 'not an admin' }));
    eq('a raised insufficient_privilege → not_admin', (await sub403.S.checkAdmin()).state, 'not_admin');
    eq('… and no refresh is attempted for a 403', refreshes(sub403.sb.log).length, 0);

    const owner = mk((n, b) => res(200, b === T));
    eq('the owner (growth_is_admin = true) → ok', (await owner.S.checkAdmin()).state, 'ok');
    chk('… the operator token, not the anon key, was the bearer', owner.sb.log.every((e) => e.bearer === T && e.apikey === ANON));

    const missing = mk(() => res(404, { code: 'PGRST202', message: 'Could not find the function public.growth_is_admin without parameters in the schema cache' }));
    const am = await missing.S.checkAdmin();
    eq('growth.sql not installed → not_installed (not "not an operator")', am.state, 'not_installed');
    chk('… in words', /not installed/.test(am.message) && !/schema cache|PGRST/.test(am.message), am.message);

    const down = mk(() => res(500, { message: 'boom' }));
    eq('a 500 → server', (await down.S.checkAdmin()).state, 'server');
    const lim = mk(() => res(429, {}));
    eq('a 429 → rate_limited', (await lim.S.checkAdmin()).state, 'rate_limited');
    const bad = mk(() => res(400, { code: '22023', message: 'p_days must be between 1 and 730' }));
    let eb = null; try { await bad.S.rpc('growth_admin_activation', { p_days: 9999 }); } catch (e) { eb = e; }
    chk('a validation refusal is passed through as a sentence', eb && eb.kind === 'request' && /p_days must be between/.test(eb.message) && !/[{}]/.test(eb.message), eb && eb.message);
  }

  /* ===================================================================== */
  /* 9. SIGN IN / SIGN OUT                                                  */
  /* ===================================================================== */
  {
    const T = jwt('in', sec() + 3600);
    const store = memStore();
    const sb = fakeSupabase({
      password: (b) => b.email === 'owner@edgedesk.test' && b.password === 'correct horse'
        ? res(200, { access_token: T, refresh_token: 'rt-in', expires_in: 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } })
        : res(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }),
      rpc: (n, b) => res(200, b === T)
    });
    const S = make(store, sb);
    const bad = await S.signIn('owner@edgedesk.test', 'wrong');
    chk('wrong password → a sentence, nothing stored', !bad.ok && /wrong email or password/i.test(bad.message) && store.getItem(SKEY) === null, bad);
    const ok = await S.signIn('  owner@edgedesk.test ', 'correct horse');
    eq('right password → signed in', ok.ok, true);
    chk('… a fresh session is stored', JSON.parse(store.getItem(SKEY)).access_token === T);
    chk('… the password is stored nowhere', [...store._m.values()].every((v) => v.indexOf('correct horse') < 0));
    eq('… and the console opens', (await S.checkAdmin()).state, 'ok');

    const out = await S.signOut();
    chk('sign-out resolves', out === undefined);
    eq('… local session cleared', store.getItem(SKEY), null);
    const lo = sb.log.filter((e) => /\/auth\/v1\/logout/.test(e.url));
    chk('… the server-side session is revoked with the operator token', lo.length === 1 && lo[0].bearer === T, lo);
    eq('… hasSession() false', S.hasSession(), false);
    eq('… the next check is signed_out, without a request', (await S.checkAdmin()).state, 'signed_out');

    /* sign-out while offline still clears local state */
    const store2 = memStore({ [SKEY]: JSON.stringify(stored(T, 'rt', sec() + 3600)) });
    const S2 = make(store2, fakeSupabase({ network: () => true, rpc: () => res(200, true) }));
    await S2.signOut();
    eq('sign-out with no network still clears the session', store2.getItem(SKEY), null);

    /* sign-out with an expired token refreshes once so the revoke can land */
    const OLD = jwt('old', sec() - 30), NEW = jwt('new', sec() + 3600);
    const store3 = memStore({ [SKEY]: JSON.stringify(stored(OLD, 'rt-3', sec() - 30)) });
    const sb3 = fakeSupabase({ refresh: () => res(200, { access_token: NEW, refresh_token: 'rt-4', expires_in: 3600 }), rpc: () => res(200, true) });
    await make(store3, sb3).signOut();
    const lo3 = sb3.log.filter((e) => /logout/.test(e.url));
    chk('expired token at sign-out → refreshed, then revoked with the fresh token', lo3.length === 1 && lo3[0].bearer === NEW, sb3.log.map((e) => e.url));
    eq('… and the refreshed session is NOT stored back', store3.getItem(SKEY), null);

    const off = await make(memStore(), fakeSupabase({ network: () => true, rpc: () => res(200, true) })).signIn('a@b.co', 'x');
    chk('sign-in with no network → a sentence', !off.ok && /could not reach/i.test(off.message), off);
  }

  /* ===================================================================== */
  /* 10. EDGE FUNCTIONS share the same rules (the send pipeline will use it) */
  /* ===================================================================== */
  {
    const A = jwt('a', sec() + 1800), B = jwt('b', sec() + 3600);
    const sb = fakeSupabase({
      refresh: () => res(200, { access_token: B, refresh_token: 'rt-b', expires_in: 3600 }),
      rpc: () => res(200, true),
      fn: (name, bearer) => bearer === B ? res(200, { ok: true, fn: name }) : res(401, { code: 401, message: 'Invalid JWT' })
    });
    const S = make(memStore({ [SKEY]: JSON.stringify(stored(A, 'rt-a', sec() + 1800)) }), sb);
    const r = await S.invoke('growth_outbound_send', { draft_id: 1 });
    chk('functions gateway 401 "Invalid JWT" → refresh, retry once, succeed', r && r.fn === 'growth_outbound_send', r);
    eq('… two attempts', sb.log.filter((e) => /functions\/v1/.test(e.url)).length, 2);
    chk('the caller cannot override the bearer', (await (async () => {
      const sb2 = fakeSupabase({ rpc: (n, b) => res(200, { bearer: b }) });
      const S2 = make(memStore({ [SKEY]: JSON.stringify(stored(A, 'rt', sec() + 1800)) }), sb2);
      const got = await S2.request('rest/v1/rpc/echo', { method: 'POST', headers: { authorization: 'Bearer ' + ANON }, body: '{}' });
      return got && got.bearer === A;
    })()));
  }

  /* a slow function (the research engine) may be given longer, call by call */
  {
    const A = jwt('a', sec() + 3600);
    let seenInit = null;
    const hang = { f: (url, init) => { seenInit = init; return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); } };
    const S = make(memStore({ [SKEY]: JSON.stringify(stored(A, 'rt', sec() + 3600)) }), hang, { timeoutMs: 40 });
    let t0 = Date.now();
    let e = await S.invoke('growth_outbound_research', {}).catch((x) => x);
    const short = Date.now() - t0;
    t0 = Date.now();
    e = await S.invoke('growth_outbound_research', {}, { timeoutMs: 250 }).catch((x) => x);
    const long = Date.now() - t0;
    chk('invoke(…, { timeoutMs }) waits longer for that call only; the default stays', short < 200 && long >= 240 && e && e.kind === 'network', [short, long, e && e.kind]);
    chk('… and the timeout is not sent to the server', !!seenInit && !('timeoutMs' in seenInit));
  }

  /* ===================================================================== */
  /* 11. CLASSIFY / DESCRIBE — every error is a sentence without secrets    */
  /* ===================================================================== */
  {
    const T = jwt('leak', sec() + 3600);
    const cases = [
      [401, { code: 'PGRST303', message: 'JWT expired' }, 'auth'],
      [401, { code: 'PGRST301', message: 'JWSError (CompactDecodeError Invalid number of parts)' }, 'auth'],
      [403, { code: '42501', message: 'not an admin' }, 'forbidden'],
      [401, { code: '42501', message: 'permission denied for function x' }, 'forbidden'],
      [404, { code: 'PGRST202', message: 'Could not find the function' }, 'not_installed'],
      [404, { code: 'PGRST205', message: 'Could not find the table' }, 'not_installed'],
      [400, { code: '22023', message: 'bad input' }, 'request'],
      [429, null, 'rate_limited'],
      [502, null, 'server'],
      [0, null, 'network']
    ];
    for (const [st, b, want] of cases) eq('classify ' + st + ' ' + (b && b.code), M.classify(st, b), want);
    const leaky = M.describe('request', 400, { message: 'token ' + T + ' rejected\n{"x":1}' });
    chk('a token inside a server message is redacted', leaky.indexOf(T) < 0 && /\[token\]/.test(leaky), leaky);
    chk('… and newlines are flattened', !/\n/.test(leaky));
    chk('long server messages are cut', M.describe('request', 400, { message: 'x'.repeat(1000) }).length < 220);
  }

  /* ===================================================================== */
  /* 12. NOTHING PRINTED CARRIES A TOKEN                                     */
  /* ===================================================================== */
  chk('the module printed nothing during the whole run (no token can leak to the console)',
    printed.filter((l) => !/^(PASS|FAIL)/.test(l)).length === 0, printed.slice(0, 5));

  /* ===================================================================== */
  const total = pass + fail;
  if (fail) { for (const f of failures) console.log('FAIL | ' + f); }
  console.log((fail ? 'FAIL' : 'PASS') + ' — admin session: ' + pass + '/' + total + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
