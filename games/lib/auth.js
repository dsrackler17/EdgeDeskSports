/* ===========================================================================
   EdgeDesk Games — signing in, for the franchise.

   Games has never had its own identity, and it still does not: a signed-in
   player IS the Supabase session the research terminal keeps in
   localStorage under `edgedesk_session` (games/lib/social.js reads it). What
   was missing is a way to CREATE that session from inside Games. The landing
   page's sign-up is built for the research product and walks a new account
   straight into a paid trial, which is the wrong door for someone who wants
   to found a free football franchise.

   So this file talks to the same Supabase Auth endpoints the landing page
   uses (`/auth/v1/signup`, `/auth/v1/token?grant_type=password`), writes the
   same session key in the same shape, records the same 21+ and Terms
   consent on the account, and carries the same first-touch attribution
   into user_metadata — so an account created here is indistinguishable
   from one created on the landing page, and partner credit is never lost.

   No password ever touches localStorage. The session (access + refresh
   token) is the only thing kept, exactly as the terminal keeps it.
   =========================================================================== */
(function (root) {
  'use strict';

  var SESSION_KEY = 'edgedesk_session';
  var CONSENT_VERSION = '2026-07';
  var TIMEOUT_MS = 12000;
  var SB_URL = null, SB_KEY = null;

  var S = root.EDGamesSocial || (typeof require === 'function' ? require('./social.js') : null);
  var AT = root.EDGamesAttribution || (typeof require === 'function' ? require('./attribution.js') : null);

  function configure(url, key) { SB_URL = url || SB_URL; SB_KEY = key || SB_KEY; }
  function configured() { return !!(SB_URL && SB_KEY); }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
             function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  /* The attribution the landing page hands to the database at sign-up, in
     the same field names, read from the SAME ledger (games/lib/attribution.js
     writes the landing page's keys). */
  function attrPayload() {
    var f = (AT && AT.first()) || {};
    return {
      ref: f.ref || null,
      utm_source: f.utm_source || null, utm_medium: f.utm_medium || null,
      utm_campaign: f.utm_campaign || null, utm_content: f.utm_content || null,
      landing_page: f.landing || null, referrer_host: f.referrer || null,
      first_seen_at: f.seen_at || null,
      organic_first_seen_at: f.organic_first_seen_at || null,
      signup_surface: 'games_franchise'
    };
  }

  function storeSession(d) {
    try { root.localStorage.setItem(SESSION_KEY, JSON.stringify(d)); return true; } catch (_) { return false; }
  }

  /* A readable sentence from a Supabase Auth error body. */
  function authMessage(d, status, mode) {
    var em = String((d && (d.msg || d.error_description || d.error || d.message)) || '').toLowerCase();
    if (em.indexOf('invalid login') >= 0 || (em.indexOf('invalid') >= 0 && em.indexOf('credential') >= 0))
      return 'Wrong email or password. Check them and try again.';
    if (em.indexOf('not confirmed') >= 0 || em.indexOf('confirm') >= 0)
      return 'Please confirm your email first, then sign in.';
    if (em.indexOf('already registered') >= 0 || em.indexOf('already been registered') >= 0)
      return 'That email already has an account. Sign in instead.';
    if (em.indexOf('weak') >= 0 || (em.indexOf('password') >= 0 && em.indexOf('short') >= 0))
      return 'Choose a longer password — at least 6 characters.';
    if (em.indexOf('rate limit') >= 0 || status === 429) return 'Too many tries. Wait a minute and try again.';
    if (em) return em.charAt(0).toUpperCase() + em.slice(1);
    return mode === 'signup' ? 'Could not create the account. Try again.' : 'Could not sign in. Try again.';
  }

  function post(path, body) {
    return withTimeout(fetch(SB_URL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SB_KEY },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = null; }
        return { status: r.status, ok: r.ok, data: d };
      });
    }), TIMEOUT_MS);
  }

  /* Sign in. Resolves — never rejects — to { ok, user } or { ok:false, message }. */
  function signIn(email, password) {
    email = String(email || '').trim(); password = String(password || '');
    if (!configured()) return Promise.resolve({ ok: false, error: 'not_configured', message: 'Sign-in is not configured in this build.' });
    if (!email || !password) return Promise.resolve({ ok: false, error: 'input', message: 'Enter your email and password.' });
    return post('/auth/v1/token?grant_type=password', { email: email, password: password })
      .then(function (r) {
        if (!r.ok || !r.data || !r.data.access_token)
          return { ok: false, error: 'auth', status: r.status, message: authMessage(r.data, r.status, 'signin') };
        storeSession(r.data);
        return { ok: true, user: S ? S.user() : null };
      })
      .catch(function () { return { ok: false, error: 'unreachable', message: 'Could not reach EdgeDesk. Check your connection and try again.' }; });
  }

  /* Create an account. `consent` must be true: the 21+ and Terms affirmation
     is recorded on the account with a timestamp, the same way the landing
     page records it. Resolves to { ok, user } when a session was issued, or
     { ok:true, confirm:true } when email confirmation is on and the player
     must confirm before signing in. */
  function signUp(email, password, consent) {
    email = String(email || '').trim(); password = String(password || '');
    if (!configured()) return Promise.resolve({ ok: false, error: 'not_configured', message: 'Sign-up is not configured in this build.' });
    if (!email || !password) return Promise.resolve({ ok: false, error: 'input', message: 'Enter your email and a password.' });
    if (password.length < 6) return Promise.resolve({ ok: false, error: 'input', message: 'Choose a password of at least 6 characters.' });
    if (!consent) return Promise.resolve({ ok: false, error: 'consent', message: 'Please confirm you are 21+ and agree to the Terms to continue.' });
    var data = { consent_21plus: true, consent_terms: true, consent_at: new Date().toISOString(),
      consent_version: CONSENT_VERSION };
    var a = attrPayload(), k;
    for (k in a) if (a.hasOwnProperty(k)) data[k] = a[k];
    return post('/auth/v1/signup', { email: email, password: password, data: data })
      .then(function (r) {
        if (!r.ok) return { ok: false, error: 'auth', status: r.status, message: authMessage(r.data, r.status, 'signup') };
        if (r.data && r.data.access_token) {
          storeSession(r.data);
          return { ok: true, user: S ? S.user() : null };
        }
        /* no token: email confirmation is on for this project */
        return { ok: true, confirm: true, user: null };
      })
      .catch(function () { return { ok: false, error: 'unreachable', message: 'Could not reach EdgeDesk. Check your connection and try again.' }; });
  }

  /* Sign out of this browser. The session is removed locally whatever the
     server says; the franchise cache is cleared by the caller (store). */
  function signOut() {
    var s = S ? S.session() : null;
    try { root.localStorage.removeItem(SESSION_KEY); } catch (_) {}
    if (!configured() || !s || !s.access_token) return Promise.resolve({ ok: true });
    return withTimeout(fetch(SB_URL + '/auth/v1/logout', {
      method: 'POST', headers: { apikey: SB_KEY, authorization: 'Bearer ' + s.access_token }
    }), 5000).then(function () { return { ok: true }; }, function () { return { ok: true }; });
  }

  function user() { return S ? S.user() : null; }
  function signedIn() { return !!user(); }

  var API = {
    SESSION_KEY: SESSION_KEY, CONSENT_VERSION: CONSENT_VERSION,
    configure: configure, configured: configured, attrPayload: attrPayload,
    signIn: signIn, signUp: signUp, signOut: signOut, user: user, signedIn: signedIn,
    authMessage: authMessage
  };
  root.EDGamesAuth = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
