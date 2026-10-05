/* ===========================================================================
   EdgeDesk — the operator consoles' session: sign in, stay signed in, sign out.

   WHY THIS EXISTS. /admin/growth/ (and the other operator pages) kept the
   whole /auth/v1/token answer in localStorage and presented its access_token
   on every later visit, with no refresh. Supabase access tokens live about an
   hour, so any visit after that sent an expired JWT, PostgREST answered
   401 PGRST303 "JWT expired", and the page reported it as "this account cannot
   open the growth console: an operator must add it to affiliate_admins" — an
   authorization verdict for what was only a stale login.

   app.html solved the same problem for readers (edRefreshSession / edToken);
   this is that logic for the consoles, in one testable place:

     * a token within two minutes of expiry is refreshed BEFORE it is used
     * a request answered 401 (expired / invalid JWT) refreshes ONCE and is
       retried ONCE; a second 401 ends the session — never a loop
     * every refresh is single-flight: Supabase refresh tokens rotate and are
       single-use, so two callers spending the same one race and one loses
     * a refresh the auth server REFUSES (400/401) is final: the stored session
       is dropped and the page shows sign-in. A 5xx or a network failure is
       transient and leaves the session alone
     * another tab may have rotated the token first: storage is re-read before
       a refresh is spent and after one is refused
     * an operator call is NEVER downgraded to the anon key. A console with no
       usable session makes no request at all and says "sign in"
     * errors are sentences, not PostgREST JSON, and never carry a token
     * nothing here logs. The password is sent once and not kept

   What it does NOT do: decide who is an operator. That is the database's job
   (affiliate_is_admin() over public.affiliate_admins, under the operator's own
   token). checkAdmin() only asks it and reports the answer.
   =========================================================================== */
(function (root) {
  'use strict';

  var REFRESH_MARGIN_MS = 120000;   /* refresh when < 2 min of life is left */
  var TIMEOUT_MS = 15000;

  /* ── errors ─────────────────────────────────────────────────────────────
     kind is one of:
       signed_out     no usable session (never had one, refused refresh, or a
                      fresh token was rejected too) — show sign-in
       forbidden      signed in, but the database says this account may not
       not_installed  the function/table the console calls does not exist
       network        the request did not get an answer
       server         5xx
       rate_limited   429
       request        any other refusal (bad input and the like) */
  function AdminError(kind, message, status, code) {
    var e = new Error(message);
    e.name = 'EDAdminError';
    e.kind = kind;
    e.status = status == null ? null : status;
    e.code = code == null ? null : String(code);
    return e;
  }

  var MESSAGES = {
    signed_out: 'Your sign-in has expired. Sign in again to continue.',
    signed_out_fresh: 'Sign in to continue.',
    forbidden: 'This account does not have access to this console.',
    not_installed: 'This console is not installed on the database yet (its functions are missing). Nothing was changed.',
    network: 'Could not reach EdgeDesk. Check your connection and try again.',
    rate_limited: 'Too many requests just now. Wait a moment and try again.'
  };

  /* A server sentence, cut down to something a person can read: no JSON, no
     newlines, nothing long, and nothing that looks like a token. */
  function tidy(s) {
    s = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    s = s.replace(/eyJ[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]+){0,2}/g, '[token]');
    if (s.length > 160) s = s.slice(0, 157) + '…';
    return s;
  }

  function bodyMessage(b) {
    if (!b || typeof b !== 'object') return '';
    return String(b.message || b.msg || b.error_description || b.error || b.reason || '');
  }
  function bodyCode(b) {
    if (!b || typeof b !== 'object') return null;
    return b.code != null ? String(b.code) : (b.error_code != null ? String(b.error_code) : null);
  }

  /* What a failed answer MEANS. PostgREST: 401 PGRST301/302/303 is the JWT
     (bad, missing, expired). 42501 is a raised insufficient_privilege — the
     operator check refusing — and PostgREST sends it as 403 for a signed-in
     role (401 for anon, which this module never sends). PGRST202/PGRST205: no
     such function / table. The Edge Functions gateway says 401 "Invalid JWT". */
  function classify(status, body) {
    var code = bodyCode(body), msg = bodyMessage(body);
    if (!status) return 'network';
    if (code === '42501' || status === 403) return 'forbidden';
    if (status === 401) return 'auth';
    if (code === 'PGRST202' || code === 'PGRST205' || code === '42883' || code === '42P01') return 'not_installed';
    if (status === 404 && /could not find|does not exist|not found/i.test(msg)) return 'not_installed';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
    return 'request';
  }

  function describe(kind, status, body) {
    if (kind === 'server') return 'EdgeDesk could not complete that just now (HTTP ' + status + '). Try again in a moment.';
    if (kind === 'request') {
      var m = tidy(bodyMessage(body)), c = bodyCode(body);
      return 'The request was refused' + (m ? ': ' + m : '') + (c && !/^PGRST/.test(c) ? ' (' + tidy(c) + ')' : '') + '.';
    }
    return MESSAGES[kind] || MESSAGES.network;
  }

  /* ── tokens ─────────────────────────────────────────────────────────────
     The exp claim is read only to schedule a refresh when an old stored
     session has no expires_at. Nothing is verified here; the server does that. */
  function b64urlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof root.atob === 'function') return root.atob(s);
    /* eslint-disable-next-line no-undef */
    return Buffer.from(s, 'base64').toString('binary');
  }
  function jwtExp(t) {
    try { var p = JSON.parse(b64urlDecode(String(t).split('.')[1])); return p && +p.exp > 0 ? +p.exp : null; }
    catch (_) { return null; }
  }

  /* Keep only what the console needs. The /token answer also carries the
     whole user record (metadata, identities, phone…); none of it belongs in
     an operator's localStorage. */
  function normalize(d, nowMs) {
    if (!d || typeof d !== 'object' || typeof d.access_token !== 'string' || !d.access_token) return null;
    var exp = +d.expires_at;
    if (!(exp > 0)) {
      var ein = +d.expires_in;
      exp = ein > 0 ? Math.floor(nowMs / 1000) + ein : jwtExp(d.access_token);
    }
    var u = (d.user && typeof d.user === 'object') ? d.user : {};
    return {
      access_token: d.access_token,
      refresh_token: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
      token_type: 'bearer',
      expires_at: exp > 0 ? exp : null,
      user: { id: u.id ? String(u.id) : null, email: u.email ? String(u.email) : null }
    };
  }

  function safeStorage() {
    try { var s = root.localStorage; s.getItem('__probe__'); return s; } catch (_) { return null; }
  }

  function create(opts) {
    opts = opts || {};
    var URL_ = String(opts.url || '').replace(/\/+$/, '');
    var KEY = opts.key;
    var SKEY = opts.storageKey;
    if (!URL_ || !KEY || !SKEY) throw new Error('EDAdminSession.create needs url, key and storageKey');
    var store = opts.storage === undefined ? safeStorage() : opts.storage;
    var fetchImpl = opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    var now = opts.now || function () { return Date.now(); };
    var timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    var adminRpc = opts.adminRpc || null;
    var onSignedOut = typeof opts.onSignedOut === 'function' ? opts.onSignedOut : null;

    var session = null;     /* in memory; storage is the cross-tab truth */
    var inflight = null;    /* the one refresh in progress, if any */
    var expiredOut = false; /* the last session ended by expiry/refusal, not by sign-out */

    function read() {
      if (!store) return session;
      try { return normalize(JSON.parse(store.getItem(SKEY) || 'null'), now()); } catch (_) { return null; }
    }
    function save(s) {
      session = s;
      /* storage that will not take a write is no storage: keep the session in
         memory rather than let current() re-read the stale copy over it */
      if (store) { try { store.setItem(SKEY, JSON.stringify(s)); } catch (_) { store = null; } }
    }
    function wipe() {
      session = null;
      if (store) { try { store.removeItem(SKEY); } catch (_) {} }
    }
    function current() {
      var s = read();
      if (s) session = s; else if (store) session = null;
      return session;
    }
    function nearExpiry(s) { return !!(s && s.expires_at && s.expires_at * 1000 - now() < REFRESH_MARGIN_MS); }
    function expired(s) { return !!(s && s.expires_at && s.expires_at * 1000 <= now()); }

    /* The session ended underneath the console (refused refresh, rejected
       fresh token). Not a sign-out: the page is told so it can show sign-in. */
    function drop() {
      wipe();
      expiredOut = true;
      if (onSignedOut) { try { onSignedOut(MESSAGES.signed_out); } catch (_) {} }
    }

    function timed(url, init) {
      if (!fetchImpl) return Promise.reject(new Error('no fetch'));
      var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      var t = null;
      var p = fetchImpl(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init);
      if (!ctl) return p;
      t = setTimeout(function () { try { ctl.abort(); } catch (_) {} }, timeoutMs);
      return p.then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
    }
    function readBody(r) {
      return Promise.resolve(r.text ? r.text() : (r.json ? r.json().then(JSON.stringify) : ''))
        .then(function (t) { if (!t) return null; try { return JSON.parse(t); } catch (_) { return { message: t }; } })
        .catch(function () { return null; });
    }

    /* One refresh against the auth server. Resolves to
         { session }    a new session, stored
         { dead: true } the auth server refused it; session dropped
         { transient }  no answer / 5xx / 429; session left alone */
    function refreshOnce() {
      var s = current();
      if (!s || !s.refresh_token) { drop(); return Promise.resolve({ dead: true }); }
      var spent = s.refresh_token;
      return timed(URL_ + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: spent })
      }).then(function (r) {
        return readBody(r).then(function (b) {
          if (r.ok) {
            var n = normalize(b, now());
            if (n) { save(n); expiredOut = false; return { session: n }; }
            return { transient: true, status: r.status };
          }
          if (r.status === 400 || r.status === 401 || r.status === 403) {
            /* another tab may have spent this token and stored the successor */
            var other = read();
            if (other && other.refresh_token && other.refresh_token !== spent) { session = other; return { session: other }; }
            drop();
            return { dead: true };
          }
          return { transient: true, status: r.status };
        });
      }, function () { return { transient: true, status: 0 }; });
    }

    /* Single-flight. `failedToken` is the access token the caller just had
       refused (or is about to retire): if the session has already moved past
       it — another caller's refresh, another tab — use that, spend nothing. */
    function refreshShared(failedToken) {
      var latest = current();
      if (latest && latest.access_token !== failedToken && !nearExpiry(latest)) return Promise.resolve({ session: latest });
      if (!inflight) {
        inflight = refreshOnce().then(function (v) { inflight = null; return v; }, function (e) { inflight = null; throw e; });
      }
      return inflight;
    }

    function signedOutError() {
      return AdminError('signed_out', expiredOut ? MESSAGES.signed_out : MESSAGES.signed_out_fresh, 401, null);
    }

    /* The access token to send now, refreshed first if it is about to lapse. */
    function token() {
      var s = current();
      if (!s || !s.access_token) return Promise.reject(signedOutError());
      if (!nearExpiry(s)) return Promise.resolve(s.access_token);
      return refreshShared(s.access_token).then(function (res) {
        if (res.session) return res.session.access_token;
        if (res.dead) throw signedOutError();
        /* transient: the old token is still good for a little while */
        if (!expired(s)) return s.access_token;
        throw AdminError(res.status ? (res.status === 429 ? 'rate_limited' : 'server') : 'network',
          res.status ? describe(res.status === 429 ? 'rate_limited' : 'server', res.status, null) : MESSAGES.network, res.status || 0, null);
      });
    }

    /* An authorized request: path is relative to the project URL
       ('rest/v1/rpc/x' or 'functions/v1/y'). One retry, only after a refresh
       that produced a new token. */
    function request(path, init) {
      init = init || {};
      function send(tok) {
        var h = Object.assign({ 'content-type': 'application/json' }, init.headers || {}, { apikey: KEY, authorization: 'Bearer ' + tok });
        return timed(URL_ + '/' + String(path).replace(/^\/+/, ''), Object.assign({}, init, { headers: h }))
          .then(function (r) { return readBody(r).then(function (b) { return { r: r, b: b }; }); },
                function () { throw AdminError('network', MESSAGES.network, 0, null); });
      }
      function fail(x) {
        var kind = classify(x.r.status, x.b);
        if (kind === 'auth') { drop(); throw signedOutError(); }
        throw AdminError(kind, describe(kind, x.r.status, x.b), x.r.status, bodyCode(x.b));
      }
      return token().then(function (tok) {
        return send(tok).then(function (x) {
          if (x.r.ok) return x.b;
          if (classify(x.r.status, x.b) !== 'auth') return fail(x);
          return refreshShared(tok).then(function (res) {
            if (res.dead) throw signedOutError();
            if (!res.session) {
              var k = res.status === 429 ? 'rate_limited' : res.status ? 'server' : 'network';
              throw AdminError(k, describe(k, res.status, null), res.status || 0, null);
            }
            if (res.session.access_token === tok) return fail(x);   /* nothing new to try */
            return send(res.session.access_token).then(function (y) { return y.r.ok ? y.b : fail(y); });
          });
        });
      });
    }

    function rpc(name, args) {
      return request('rest/v1/rpc/' + encodeURIComponent(name), { method: 'POST', body: JSON.stringify(args || {}) });
    }
    function invoke(fn, body) {
      return request('functions/v1/' + encodeURIComponent(fn), { method: 'POST', body: JSON.stringify(body || {}) });
    }

    function message(e) {
      if (e && e.name === 'EDAdminError') return e.message;
      return MESSAGES.network;
    }

    /* Ask the database whether this account is an operator. Resolves (never
       rejects) to { state, message } with state one of ok, signed_out,
       not_admin, not_installed, network, server, rate_limited, request. */
    function checkAdmin() {
      if (!adminRpc) return Promise.reject(new Error('no adminRpc configured'));
      if (!current()) return Promise.resolve({ state: 'signed_out', message: expiredOut ? MESSAGES.signed_out : '' });
      return rpc(adminRpc, {}).then(function (v) {
        return v === true ? { state: 'ok', message: '' } : { state: 'not_admin', message: MESSAGES.forbidden };
      }, function (e) {
        var k = e && e.kind;
        return { state: k === 'forbidden' ? 'not_admin' : (k || 'network'), message: message(e) };
      });
    }

    /* Password sign-in. The password goes to the auth server once and is not
       kept anywhere here; the caller should clear its input. */
    function signIn(email, password) {
      var msgOf = function (b, st) {
        /* the operator pages have no "Forgot password?" link, so this one is
           said here rather than in EDAuth's reader-facing words */
        if ((st === 400 || st === 401) && /invalid.*(login|credential|grant)|invalid_grant/i.test(bodyMessage(b) + ' ' + (b && b.error || '')))
          return 'Wrong email or password. Check them and try again.';
        if (root.EDAuth && typeof root.EDAuth.message === 'function') return root.EDAuth.message(b, st, 'signin');
        if (st === 400 || st === 401) return 'Wrong email or password. Check them and try again.';
        if (st === 429) return MESSAGES.rate_limited;
        return 'Could not sign you in. Please try again.';
      };
      return timed(URL_ + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim(), password: String(password || '') })
      }).then(function (r) {
        return readBody(r).then(function (b) {
          if (!r.ok) return { ok: false, message: tidy(msgOf(b, r.status)) };
          var n = normalize(b, now());
          if (!n) return { ok: false, message: 'Could not sign you in. Please try again.' };
          save(n); expiredOut = false;
          return { ok: true };
        });
      }, function () { return { ok: false, message: MESSAGES.network }; });
    }

    /* Sign out: local state goes FIRST, so a network failure can never leave a
       session behind; then the server-side session is revoked, best effort
       (an expired access token is refreshed once so the revoke can land). */
    function signOut() {
      var s = current();
      wipe();
      expiredOut = false;
      if (!s || !s.access_token) return Promise.resolve();
      var revoke = function (tok) {
        return timed(URL_ + '/auth/v1/logout?scope=local', {
          method: 'POST', headers: { apikey: KEY, authorization: 'Bearer ' + tok, 'content-type': 'application/json' }
        }).then(function () {}, function () {});
      };
      if (!nearExpiry(s) || !s.refresh_token) return revoke(s.access_token);
      return timed(URL_ + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      }).then(function (r) { return r.ok ? readBody(r) : null; }, function () { return null; })
        .then(function (b) { var n = normalize(b, now()); return revoke(n ? n.access_token : s.access_token); });
    }

    /* Another tab signing out (or in) is this tab's news too. */
    if (opts.watchStorage !== false && root.addEventListener && store) {
      try {
        root.addEventListener('storage', function (ev) {
          if (!ev || ev.key !== SKEY) return;
          var had = !!session;
          session = read();
          if (had && !session && onSignedOut) { try { onSignedOut(MESSAGES.signed_out_fresh); } catch (_) {} }
        });
      } catch (_) {}
    }

    current();
    return {
      signIn: signIn, signOut: signOut, checkAdmin: checkAdmin,
      rpc: rpc, invoke: invoke, request: request, token: token, message: message,
      hasSession: function () { return !!current(); },
      email: function () { var s = current(); return (s && s.user && s.user.email) || ''; },
      userId: function () { var s = current(); return (s && s.user && s.user.id) || ''; }
    };
  }

  var API = {
    create: create, classify: classify, normalize: normalize, describe: describe,
    MESSAGES: MESSAGES, REFRESH_MARGIN_MS: REFRESH_MARGIN_MS
  };
  root.EDAdminSession = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
