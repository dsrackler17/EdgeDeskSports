/* ===========================================================================
   EdgeDesk — "Report a problem", once, everywhere.

   There used to be one way to tell EdgeDesk something was broken: a form
   buried in the terminal's settings, behind the paywall, behind an avatar
   menu — and it did not work. Its textarea was `id="fbBody"`, which is also
   the id of the football research board, so `document.getElementById('fbBody')`
   returned the board, `.value` was undefined, `.trim()` threw before the
   try/catch, and the Submit button did nothing at all: no message, no request,
   no error the reporter could see. It also posted to a table `public.feedback`
   whose definition was never committed to this repository, so even a working
   button had nowhere to write.

   This is the replacement, and it is deliberately the ONLY one. It is a
   plain script with no dependencies, so it loads on the landing page, on the
   404 page, inside Games and inside the terminal — the four places a first
   time user actually gets stuck — and it says out loud whether the report was
   stored.

   WHAT IT SENDS. Enough to triage without asking the reporter a second
   question: who (only if signed in), where, when, what they typed, what
   browser, what size screen, which build, and which surface. WHAT IT NEVER
   SENDS: the access token, the refresh token, the anon key, a password, or
   any query/hash parameter that could carry one — the URL is scrubbed with
   the same list the auth callback uses before it is recorded.

   IF THE WRITE FAILS the reporter is told so plainly and handed a mailto:
   with the whole report already in it. A report that cannot be stored must
   still be sendable; what must never happen is a button that says thank you
   and drops it.
   =========================================================================== */
(function (root) {
  'use strict';

  var TABLE = 'issue_reports';
  var TIMEOUT_MS = 12000;
  var SUPPORT = 'support@edgedesksports.com';
  var SESSION_KEY = 'edgedesk_session';
  var CATEGORIES = ['Something is broken', 'I could not sign up or log in',
                    'Payment or billing', 'Wrong or missing data',
                    'Confusing or hard to use', 'Suggestion', 'Something else'];

  var cfg = { url: null, key: null, version: 'unknown', surface: 'web' };
  function configure(o) {
    o = o || {};
    if (o.url) cfg.url = o.url;
    if (o.key) cfg.key = o.key;
    if (o.version) cfg.version = String(o.version);
    if (o.surface) cfg.surface = String(o.surface);
    return cfg;
  }
  function configured() { return !!(cfg.url && cfg.key); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── who is asking ────────────────────────────────────────────────────
     Read from the access token's own claims, never from a stored `user`
     envelope that may be older than the session. A token we cannot parse is
     an anonymous reporter, not a crash. */
  function session() {
    try { return JSON.parse(root.localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }
  function claims() {
    var s = session();
    if (!s || !s.access_token) return null;
    try {
      var b = s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var p = JSON.parse(decodeURIComponent(escape(root.atob(b))));
      return p && p.sub ? p : null;
    } catch (_) { return null; }
  }
  /* Four states, not two. "Signed in but the token lapsed" is the single most
     useful thing to know about a report that says "it logged me out". */
  function authState() {
    var s = session(), c = claims();
    if (!s) return 'anonymous';
    if (!c) return 'session_unreadable';
    if (c.exp && c.exp * 1000 < Date.now()) return 'session_expired';
    return 'authenticated';
  }

  /* ── where ────────────────────────────────────────────────────────────
     The URL with every auth-bearing parameter removed. A report filed from
     the confirmation link would otherwise carry a live access token into a
     table an operator reads. */
  function safeUrl(loc) {
    loc = loc || root.location;
    try {
      if (root.EDAuth && root.EDAuth.scrubbed) return (loc.origin || '') + root.EDAuth.scrubbed(loc);
      return (loc.origin || '') + (loc.pathname || '');
    } catch (_) { return String((loc && loc.pathname) || ''); }
  }

  /* The path plus whatever non-auth hash the app uses for its own routing
     (#research/football, #pricing) — never a credential. */
  function routeOf(loc) {
    loc = loc || root.location;
    try {
      var clean = (root.EDAuth && root.EDAuth.scrubbed) ? root.EDAuth.scrubbed(loc)
                : String(loc.pathname || '');
      return clean.split('?')[0].slice(0, 160);
    } catch (_) { return String((loc && loc.pathname) || ''); }
  }

  function metadata(loc) {
    loc = loc || root.location;
    var c = claims(), nav = root.navigator || {}, scr = root.screen || {};
    /* THE ID ONLY GOES ON A REPORT THE SERVER WILL AGREE WITH.
       claims() reads the token whether or not it has expired, deliberately —
       `auth_state` below is more useful for triage than a null. But the row is
       inserted on the ANON key once the token has lapsed, and the insert
       policy requires user_id to be null unless it equals auth.uid(). Filing
       the stale id would have had the database refuse the report of exactly
       the person best placed to file one: somebody whose session just died. */
    var live = c && !(c.exp && c.exp * 1000 < Date.now());
    return {
      user_id: live ? c.sub : null,
      user_email: (live && c.email) || null,
      /* THE ROUTE IS SCRUBBED TOO. It used to be pathname + the raw hash, and
         a report filed from the confirmation link therefore carried
         `#access_token=...` into a table an operator reads. safeUrl already
         drops every auth parameter; the route is derived from it rather than
         from the live location. */
      route: routeOf(loc),
      page_url: safeUrl(loc),
      reported_at: new Date().toISOString(),
      app_version: cfg.version,
      surface: cfg.surface,
      auth_state: authState(),
      user_agent: String(nav.userAgent || '').slice(0, 400),
      viewport: (root.innerWidth || 0) + 'x' + (root.innerHeight || 0) +
                ' @' + (root.devicePixelRatio || 1) + 'x' +
                (scr.width ? ' screen ' + scr.width + 'x' + scr.height : ''),
      language: String(nav.language || ''),
      referrer: String((root.document && root.document.referrer) || '').slice(0, 300)
    };
  }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms || TIMEOUT_MS);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
             function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  /* ── the write ────────────────────────────────────────────────────────
     Signed in, the reporter's own bearer is used so RLS records the row
     against auth.uid(); anonymous, the anon key is, and the insert policy
     accepts a row whose user_id is null. Resolves — never rejects — so a
     caller cannot forget to catch and leave a spinner running forever. */
  function submit(input, fetchImpl) {
    input = input || {};
    var summary = String(input.summary || '').trim();
    var details = String(input.details || '').trim();
    if (!summary) return Promise.resolve({ ok: false, reason: 'input', message: 'Give the problem a one-line summary.' });
    if (summary.length > 200) summary = summary.slice(0, 200);
    if (!details) return Promise.resolve({ ok: false, reason: 'input', message: 'Describe what happened — even one sentence helps.' });
    if (!configured()) return Promise.resolve({ ok: false, reason: 'not_configured',
      message: 'Reporting is not configured in this build.' });

    var m = metadata(input.location);
    var contact = String(input.contact_email || '').trim();
    if (contact && root.EDAuth && !root.EDAuth.validEmail(contact))
      return Promise.resolve({ ok: false, reason: 'input', message: 'That contact email does not look right.' });

    var row = {
      user_id: m.user_id, user_email: m.user_email || contact || null,
      contact_email: contact || null,
      category: CATEGORIES.indexOf(input.category) >= 0 ? input.category : 'Something else',
      summary: summary, details: details.slice(0, 8000),
      steps: String(input.steps || '').trim().slice(0, 4000) || null,
      route: m.route, page_url: m.page_url, app_version: m.app_version,
      surface: m.surface, auth_state: m.auth_state, user_agent: m.user_agent,
      viewport: m.viewport, language: m.language, referrer: m.referrer,
      reported_at: m.reported_at
    };

    var s = session();
    var bearer = (m.auth_state === 'authenticated' && s && s.access_token) ? s.access_token : cfg.key;
    var f = fetchImpl || root.fetch;

    return withTimeout(f(cfg.url + '/rest/v1/' + TABLE, {
      method: 'POST',
      headers: { apikey: cfg.key, authorization: 'Bearer ' + bearer,
                 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify([row])
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = t ? JSON.parse(t) : null; } catch (_) {}
        if (r.ok) {
          var id = (Array.isArray(d) && d[0] && d[0].id) || null;
          return { ok: true, id: id, row: row };
        }
        return { ok: false, reason: 'server', status: r.status, row: row,
                 message: writeMessage(r.status, d) };
      });
    })).catch(function (e) {
      return { ok: false, reason: 'unreachable', row: row,
               message: String(e && e.message) === 'timeout'
                 ? 'The report took too long to send. Your connection may be slow — try again, or email it.'
                 : 'Could not reach EdgeDesk to send the report. Check your connection and try again, or email it.' };
    });
  }

  /* The operator needs the status; the reporter needs a sentence. Both, and
     no PostgREST payload forwarded to a customer. */
  function writeMessage(status, d) {
    var code = String((d && (d.code || d.error)) || '');
    if (status === 404 || code === 'PGRST205')
      return 'Reporting is not switched on for this project yet. Your report is safe below — send it by email and it will be read.';
    if (status === 401 || status === 403 || code === '42501')
      return 'EdgeDesk would not accept the report from this session. Send it by email instead and it will be read.';
    if (status === 429) return 'Too many reports from here just now. Wait a minute and try again.';
    if (status >= 500) return 'EdgeDesk could not store the report just now. Try again in a moment, or send it by email.';
    return 'The report could not be stored (' + status + '). Send it by email instead and it will be read.';
  }

  /* Everything the operator would have got, in an email, so a failed write
     never costs the report. */
  function mailtoFor(row) {
    var body = [
      row.summary, '', row.details, '',
      row.steps ? 'Steps: ' + row.steps : '',
      '--- automatic ---',
      'category: ' + row.category,
      'route: ' + row.route,
      'url: ' + row.page_url,
      'when: ' + row.reported_at,
      'build: ' + row.app_version + ' (' + row.surface + ')',
      'auth: ' + row.auth_state + (row.user_id ? ' · user ' + row.user_id : ''),
      'viewport: ' + row.viewport,
      'browser: ' + row.user_agent
    ].filter(function (x) { return x !== ''; }).join('\n');
    return 'mailto:' + SUPPORT + '?subject=' + encodeURIComponent('EdgeDesk problem report: ' + row.summary.slice(0, 80)) +
           '&body=' + encodeURIComponent(body.slice(0, 1800));
  }

  var API = {
    TABLE: TABLE, SUPPORT: SUPPORT, CATEGORIES: CATEGORIES,
    configure: configure, configured: configured,
    metadata: metadata, authState: authState, safeUrl: safeUrl, routeOf: routeOf,
    submit: submit, writeMessage: writeMessage, mailtoFor: mailtoFor, esc: esc
  };
  root.EDReport = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
