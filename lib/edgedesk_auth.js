/* ===========================================================================
   EdgeDesk — the one place that knows what an auth answer means.

   Three copies of this logic used to exist (index.html, reset.html,
   games/lib/auth.js) and they disagreed: the landing page told an existing
   customer who re-typed their email that a NEW account had been created, and
   nothing anywhere read the link Supabase actually sends people back on. So
   both halves live here, once:

     consume()   what the browser was handed when the visitor clicked the
                 link in their email — the session, the reason it failed, or
                 nothing at all — and the URL scrubbed of it afterwards.
     message()   a Supabase Auth error body turned into a sentence a person
                 can act on, instead of the gateway's own words.

   WHY THE CALLBACK MATTERS. Signing up with email confirmation on returns no
   token: the visitor leaves for their inbox and comes back on a link. Supabase
   can hand that link back in three shapes and NOTHING here read any of them,
   so every confirmed account landed on a marketing page that still said "Start
   researching" and still called them a stranger. The three shapes:

     #access_token=...&refresh_token=...&type=signup     implicit — the session
     ?token_hash=...&type=signup                         verify it, then a session
     #error=...  /  ?error=...&error_description=...     an expired or used link

   A fourth, `?code=`, is the PKCE flow. It can only be completed by the client
   that minted the verifier, and no page here uses supabase-js, so a code we
   never issued is reported as a link we cannot finish rather than swallowed.

   THE TOKENS DO NOT STAY IN THE ADDRESS BAR. They are read once and the URL is
   rewritten, so a session does not survive in history, in a screenshot, or in
   whatever the next `Referer` header happens to be.
   =========================================================================== */
(function (root) {
  'use strict';

  var SESSION_KEY = 'edgedesk_session';
  var TIMEOUT_MS = 12000;

  /* ── email ─────────────────────────────────────────────────────────────
     Deliberately permissive: this exists to catch a typo before it costs a
     round trip and a gateway error, not to adjudicate RFC 5322. The server
     is still the authority on whether an address is real. */
  function validEmail(s) {
    s = String(s == null ? '' : s).trim();
    if (s.length < 3 || s.length > 254) return false;
    if (/\s/.test(s)) return false;
    var at = s.indexOf('@');
    if (at < 1 || at !== s.lastIndexOf('@')) return false;
    var dom = s.slice(at + 1);
    if (dom.length < 3 || dom.indexOf('.') < 1 || /\.$/.test(dom) || /\.\./.test(dom)) return false;
    return /^[^@\s]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(s);
  }

  /* ── error text ────────────────────────────────────────────────────────
     Every branch says what happened AND what to do next, because an error a
     visitor cannot act on is the same as no error at all. `mode` picks the
     fallback wording when Supabase says nothing useful. */
  function message(d, status, mode) {
    var em = String((d && (d.msg || d.error_description || d.message || d.error)) || '').toLowerCase();
    /* A 429 IS NOT ONE THING, and the difference decides what the person does
       next. Supabase returns it for a per-address cooldown, for an email-send
       quota, and for a plain request flood — and the old single answer, "wait
       a minute and try again", was wrong for two of the three. An email quota
       is hourly, so a minute's wait sends somebody round a loop that cannot
       succeed; worse, a signup refused for an email quota may or may not have
       created the account, so "try again" is the one instruction that helps
       least. Each case now says what happened and what actually gets them in. */
    var wait = em.match(/after (\d+) seconds?/);
    if (wait) return 'Please wait ' + wait[1] + ' seconds before asking for another email.';
    if (em.indexOf('email') >= 0 && (em.indexOf('rate limit') >= 0 || status === 429))
      return 'We could not send the email just now — our email service is at its limit for the moment. '
           + 'Your account may already exist: try logging in with the password you just chose. '
           + 'If that does not work, email support@edgedesksports.com and we will let you in by hand.';
    if (status === 429 || em.indexOf('rate limit') >= 0 || em.indexOf('too many') >= 0)
      return 'Too many attempts from this connection. Wait a few minutes and try again.';
    if (status === 0 || em.indexOf('failed to fetch') >= 0 || em.indexOf('networkerror') >= 0)
      return 'Could not reach EdgeDesk. Check your connection and try again.';
    if (status >= 500)
      return 'EdgeDesk could not complete that just now. Nothing was changed — please try again in a moment.';
    if (em.indexOf('invalid login') >= 0 || (em.indexOf('invalid') >= 0 && em.indexOf('credential') >= 0))
      return 'Wrong email or password. Check them and try again, or use "Forgot password?".';
    if (em.indexOf('not confirmed') >= 0 || em.indexOf('email not confirmed') >= 0)
      return 'Confirm your email first — check your inbox (and spam) for the link we sent.';
    if (em.indexOf('already registered') >= 0 || em.indexOf('already been registered') >= 0)
      return 'That email already has an EdgeDesk account. Log in instead.';
    if (em.indexOf('weak') >= 0 || (em.indexOf('password') >= 0 && (em.indexOf('short') >= 0 || em.indexOf('at least') >= 0)))
      return 'Choose a longer password — at least 6 characters.';
    if (em.indexOf('validate email') >= 0 || em.indexOf('invalid format') >= 0 || em.indexOf('invalid email') >= 0)
      return 'That email address does not look right. Check it and try again.';
    if (em.indexOf('expired') >= 0 || em.indexOf('token has expired') >= 0)
      return 'That link has expired. Request a new one and use it within the hour.';
    if (em.indexOf('user not found') >= 0)
      return 'No EdgeDesk account uses that email. Sign up instead.';
    /* Nothing recognised. Say something honest and generic rather than
       forwarding a database or gateway sentence to a customer. */
    return mode === 'signup' ? 'Could not create the account. Please try again.'
         : mode === 'recover' ? 'Could not send the reset email. Please try again.'
         : 'Could not sign you in. Please try again.';
  }

  /* ── did a signup actually create anything? ────────────────────────────
     With email confirmation ON, signing up with an address that is ALREADY
     registered is answered 200 with a user whose `identities` array is empty.
     Supabase does this on purpose — telling a stranger which emails have
     accounts is an enumeration oracle — but a page that does not read it
     tells a returning customer their new account is on its way and leaves
     them waiting for an email that is never sent. */
  function isExistingUser(d) {
    var u = (d && (d.user || d)) || null;
    return !!(u && Array.isArray(u.identities) && u.identities.length === 0);
  }

  /* ── the callback ──────────────────────────────────────────────────────
     `loc` is a {hash, search, pathname, origin} — location, or a stand-in.
     Returns one of:
       {kind:'none'}
       {kind:'session', session, type}          a session to store
       {kind:'verify',  token_hash, type}       exchange it, then store
       {kind:'error',   code, message, type}    say this to the visitor
       {kind:'unfinishable', code}              a PKCE code we cannot spend
     Never throws: a malformed URL is 'none', not an exception on boot. */
  function parse(loc) {
    var out = { kind: 'none' };
    try {
      var h = String((loc && loc.hash) || '').replace(/^#/, '');
      var q = String((loc && loc.search) || '').replace(/^\?/, '');
      var H = new URLSearchParams(h), Q = new URLSearchParams(q);
      var pick = function (k) { return H.get(k) || Q.get(k); };

      var err = pick('error') || pick('error_code');
      if (err) {
        var desc = pick('error_description') || '';
        return { kind: 'error', code: String(err),
                 type: pick('type') || null,
                 message: friendlyLinkError(String(err), String(desc)) };
      }

      var at = pick('access_token');
      if (at) {
        var exp = pick('expires_at'), ein = pick('expires_in');
        return { kind: 'session', type: pick('type') || null, session: {
          access_token: at,
          refresh_token: pick('refresh_token') || null,
          token_type: pick('token_type') || 'bearer',
          expires_in: ein ? +ein : undefined,
          expires_at: exp ? +exp : (ein ? Math.floor(Date.now() / 1000) + (+ein) : undefined)
        } };
      }

      var th = pick('token_hash') || pick('token');
      if (th && pick('type')) return { kind: 'verify', token_hash: th, type: pick('type') };

      var code = Q.get('code');
      if (code) return { kind: 'unfinishable', code: code, type: pick('type') || null };
    } catch (_) { /* fall through to 'none' */ }
    return out;
  }

  function friendlyLinkError(code, desc) {
    var c = (code + ' ' + desc).toLowerCase();
    if (c.indexOf('expired') >= 0) return 'That link has expired. Request a new one — links are good for one hour.';
    if (c.indexOf('already') >= 0 || c.indexOf('used') >= 0) return 'That link has already been used. Log in with your email and password.';
    if (c.indexOf('access_denied') >= 0) return 'That link is no longer valid. Request a new one and open it on this device.';
    return desc ? desc.replace(/\+/g, ' ') : 'That link could not be used. Request a new one.';
  }

  /* Take the credentials OUT of the address bar, keeping the path, any
     non-auth query and any non-auth hash the page itself uses. */
  var AUTH_KEYS = ['access_token','refresh_token','expires_in','expires_at','token_type','type',
                   'provider_token','provider_refresh_token','token_hash','token','code',
                   'error','error_code','error_description'];
  function scrubbed(loc) {
    var pathname = String((loc && loc.pathname) || '/');
    /* A hash is not always a query string. `#research/football` is a route
       this app owns, and running it through URLSearchParams turns it into
       `research%2Ffootball=` — a deep link destroyed by the cleanup meant to
       protect it. Only a hash that actually carries `k=v` pairs is rewritten;
       anything else is left exactly as the page wrote it. */
    var keep = function (raw, isHash) {
      var body = String(raw || '').replace(/^[#?]/, '');
      if (!body) return '';
      if (isHash && body.indexOf('=') < 0) return body;
      var p = new URLSearchParams(body), had = false;
      AUTH_KEYS.forEach(function (k) { if (p.has(k)) { had = true; p.delete(k); } });
      if (!had && isHash) return body;      /* not ours: hand it back untouched */
      return p.toString();
    };
    var s = keep(loc && loc.search, false), f = keep(loc && loc.hash, true);
    return pathname + (s ? '?' + s : '') + (f ? '#' + f : '');
  }

  function storeSession(s, storage) {
    try { (storage || root.localStorage).setItem(SESSION_KEY, JSON.stringify(s)); return true; }
    catch (_) { return false; }
  }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms || TIMEOUT_MS);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
             function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  /* Spend a `token_hash` for a session. The newer Supabase email templates
     send this shape, and it is the only one that can be completed without a
     verifier the browser never had. */
  function verify(sbUrl, sbKey, token_hash, type, fetchImpl) {
    var f = fetchImpl || root.fetch;
    return withTimeout(f(sbUrl + '/auth/v1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: sbKey },
      body: JSON.stringify({ type: type, token_hash: token_hash })
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) {}
        if (r.ok && d && d.access_token) return { ok: true, session: d };
        return { ok: false, message: message(d, r.status, 'signin') };
      });
    })).catch(function () {
      return { ok: false, message: 'Could not reach EdgeDesk to finish that link. Check your connection and open it again.' };
    });
  }

  /* THE WHOLE CALLBACK, DONE. Resolves to a plain result the caller renders;
     the URL is already clean by the time it does, whatever the outcome. */
  function consume(opts) {
    opts = opts || {};
    var loc = opts.location || root.location;
    var r = parse(loc);
    if (r.kind === 'none') return Promise.resolve({ handled: false });

    var clean = function () {
      if (opts.scrub === false) return;
      try { (opts.history || root.history).replaceState({}, '', scrubbed(loc)); } catch (_) {}
    };

    if (r.kind === 'session') {
      storeSession(r.session, opts.storage);
      clean();
      return Promise.resolve({ handled: true, ok: true, type: r.type, session: r.session });
    }
    if (r.kind === 'error') {
      clean();
      return Promise.resolve({ handled: true, ok: false, type: r.type, code: r.code, message: r.message });
    }
    if (r.kind === 'unfinishable') {
      clean();
      return Promise.resolve({ handled: true, ok: false, type: r.type, code: 'pkce_code',
        message: 'That link needs to be opened in the browser you signed up in. Log in with your email and password instead — your account is already set up.' });
    }
    /* verify */
    var type = r.type;
    return verify(opts.url, opts.key, r.token_hash, type, opts.fetch).then(function (v) {
      clean();
      if (v.ok) { storeSession(v.session, opts.storage); return { handled: true, ok: true, type: type, session: v.session }; }
      return { handled: true, ok: false, type: type, code: 'verify_failed', message: v.message };
    });
  }

  var API = {
    SESSION_KEY: SESSION_KEY,
    validEmail: validEmail, message: message, isExistingUser: isExistingUser,
    parse: parse, scrubbed: scrubbed, verify: verify, consume: consume,
    friendlyLinkError: friendlyLinkError, storeSession: storeSession
  };
  root.EDAuth = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
