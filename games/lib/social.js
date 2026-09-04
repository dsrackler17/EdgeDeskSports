/* ===========================================================================
   EdgeDesk Games — the social layer's client.

   The seam between the /games pages and supabase/games_social.sql. Every call
   here is an RPC against a security-definer function; NOTHING competitive is
   decided in this file.

   In particular this file cannot see an opponent's prediction before it is
   allowed to. h2h_view() returns the opponent's answer only once the challenge
   has locked, so there is no "hidden" field for the page to leak, no filtered
   array, and nothing to accidentally render. If you find yourself wanting to
   pass a flag to make a prediction appear, the bug is in the wrong file.

   IDENTITY
     A signed-in EdgeDesk reader is identified by the same Supabase session the
     terminal uses (localStorage `edgedesk_session`), so Games needs no auth of
     its own. A visitor who has not signed in gets a high-entropy bearer secret
     generated in their browser and stored locally; the server keeps only its
     SHA-256. That secret IS their identity for challenges they entered
     anonymously, which is what lets a friend play before they sign up.

   NOT DEPLOYED YET?
     Every call resolves to a structured failure rather than throwing, and
     `available()` reports whether the backend answered at all, so the pages can
     say plainly that the social layer needs its SQL applied instead of
     spinning or lying.
   =========================================================================== */
(function (root) {
  'use strict';

  var SB_URL = 'https://iattxbkbufslbauoumga.supabase.co';
  /* the public anon key, the same one the terminal declares. Public by design:
     it authenticates nothing on its own and RLS governs what it can reach. */
  var SB_KEY = null;
  var SESSION_KEY = 'edgedesk_session';
  var SECRET_KEY = 'edgedesk_games_secret';
  var TIMEOUT_MS = 9000;

  function configure(url, key) {
    if (url) SB_URL = url;
    if (key) SB_KEY = key;
  }

  /* ── identity ─────────────────────────────────────────────────────────── */

  function session() {
    try { return JSON.parse(root.localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (_) { return null; }
  }

  /* The signed-in user, decoded from the access token the terminal already
     stores. Read-only: Games never mints or refreshes a session. */
  function user() {
    var s = session();
    if (!s || !s.access_token) return null;
    try {
      var p = JSON.parse(root.atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!p || !p.sub) return null;
      if (p.exp && (p.exp * 1000) < Date.now()) return null;   /* expired is not signed in */
      return { id: p.sub, email: p.email, meta: p.user_metadata || {} };
    } catch (_) { return null; }
  }

  function signedIn() { return !!user(); }

  function displayName(fallback) {
    var u = user();
    if (u) {
      var n = (u.meta && u.meta.display_name) || (u.email ? String(u.email).split('@')[0] : null);
      if (n) return String(n).slice(0, 24);
    }
    var local = root.EDGamesStore && root.EDGamesStore.displayName();
    return local || fallback || 'Player';
  }

  /* The anonymous bearer secret. 256 bits from the platform CSPRNG — this is a
     credential, so Math.random() is not acceptable and its absence is an error
     rather than something to fall back from. */
  function secret() {
    var s = null;
    try { s = root.localStorage.getItem(SECRET_KEY); } catch (_) {}
    if (s && s.length >= 32) return s;
    var c = root.crypto || root.msCrypto;
    if (!c || !c.getRandomValues) return null;
    var b = new Uint8Array(32), i, out = '';
    c.getRandomValues(b);
    for (i = 0; i < b.length; i++) out += ('0' + b[i].toString(16)).slice(-2);
    try { root.localStorage.setItem(SECRET_KEY, out); } catch (_) { /* memory-only */ }
    return out;
  }

  /* ── transport ────────────────────────────────────────────────────────── */

  var _available = null;
  function available() { return _available; }

  function withTimeout(p, ms) {
    return new Promise(function (res, rej) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; rej(new Error('timeout')); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(t); res(v); } },
             function (e) { if (!done) { done = true; clearTimeout(t); rej(e); } });
    });
  }

  /* Call a database function. Resolves to { ok, data } or { ok:false, error },
     never rejects — a page that has to try/catch around a social call ends up
     with half-rendered states. */
  function rpc(fn, args) {
    if (!SB_KEY || typeof fetch !== 'function') {
      _available = false;
      return Promise.resolve({ ok: false, error: 'not_configured',
        message: 'The social layer is not configured in this build.' });
    }
    var s = session();
    var h = {
      apikey: SB_KEY,
      authorization: 'Bearer ' + ((s && s.access_token) || SB_KEY),
      'content-type': 'application/json'
    };
    return withTimeout(fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', headers: h, body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.text().then(function (body) {
        var data = null;
        try { data = body ? JSON.parse(body) : null; } catch (_) { data = body; }
        if (!r.ok) {
          _available = (r.status !== 404);   /* 404 = the function is not deployed */
          return { ok: false, status: r.status, error: pgCode(data),
            message: pgMessage(data, r.status) };
        }
        _available = true;
        return { ok: true, data: data };
      });
    }), TIMEOUT_MS).catch(function (e) {
      _available = false;
      return { ok: false, error: 'unreachable',
        message: 'Could not reach EdgeDesk Games. Check your connection and try again.' };
    });
  }

  function pgCode(d) { return (d && (d.code || d.hint)) || 'error'; }

  /* Postgres raises are the real error messages here; they were written to be
     read by a person. Anything unrecognised gets a plain sentence rather than
     a status code. */
  function pgMessage(d, status) {
    var m = d && (d.message || d.details);
    if (m) return String(m).replace(/^ERROR:\s*/, '');
    if (status === 404) return 'The social layer has not been deployed yet.';
    if (status === 401 || status === 403) return 'You are not allowed to do that.';
    return 'Something went wrong. Try again.';
  }

  /* ── head-to-head ─────────────────────────────────────────────────────── */

  var MODES = {
    winner:   { key: 'winner',   label: 'Winner',   blurb: 'Pick who wins the game outright.' },
    spread:   { key: 'spread',   label: 'Spread',   blurb: 'Pick a side against the locked line.' },
    price_it: { key: 'price_it', label: 'Price It', blurb: 'Each of you sets the line you think is fair.' }
  };

  function createChallenge(o) {
    return rpc('h2h_create', {
      p_mode: o.mode,
      p_sport: o.sport || 'americanfootball_ncaaf',
      p_game_id: String(o.game_id),
      p_game_slug: o.slug || null,
      p_home: o.home_team,
      p_away: o.away_team,
      p_kickoff: o.kickoff || null,
      p_market: o.market || {},
      p_selection: o.selection,
      p_display_name: o.display_name || displayName(),
      p_secret: signedIn() ? null : secret(),
      p_group: o.group_id || null
    });
  }

  function submitChallenge(token, selection, name) {
    return rpc('h2h_submit', {
      p_token: token,
      p_selection: selection,
      p_display_name: name || displayName(),
      p_secret: signedIn() ? null : secret()
    });
  }

  function viewChallenge(token) {
    return rpc('h2h_view', { p_token: token, p_secret: secret() });
  }

  function claimChallenge(token) {
    return rpc('h2h_claim', { p_token: token, p_secret: secret() });
  }

  /* ── groups ───────────────────────────────────────────────────────────── */

  function createGroup(name, emoji) {
    return rpc('group_create', { p_name: name, p_emoji: emoji || null });
  }
  function previewGroup(token) { return rpc('group_preview', { p_token: token }); }
  function joinGroup(token, name) {
    return rpc('group_join', { p_token: token, p_display_name: name || displayName() });
  }
  function groupDashboard(token) { return rpc('group_dashboard', { p_token: token }); }

  /* ── links ────────────────────────────────────────────────────────────── */

  function challengeUrl(token) {
    return (root.location ? root.location.origin : '') + '/games/h2h/' + encodeURIComponent(token);
  }
  function groupUrl(token) {
    return (root.location ? root.location.origin : '') + '/games/groups/' + encodeURIComponent(token);
  }

  /* ── reading a challenge, for the page ────────────────────────────────── */

  /* The single place that answers "what should this screen be?", so the three
     H2H views cannot disagree about a state. */
  function phase(ch) {
    if (!ch) return 'MISSING';
    if (ch.status === 'EXPIRED') return 'EXPIRED';
    if (ch.status === 'CANCELLED') return 'CANCELLED';
    if (ch.settled_at) return ch.status === 'DRAW' ? 'DRAW' : 'FINAL';
    if (!ch.locked_at) return ch.your_slot ? 'WAITING_FOR_OPPONENT' : 'YOUR_TURN';
    var kick = ch.kickoff ? Date.parse(ch.kickoff) : NaN;
    if (isFinite(kick) && kick <= Date.now()) return 'IN_PROGRESS';
    return 'LOCKED';
  }

  var PHASE_LABEL = {
    YOUR_TURN: 'Your turn',
    WAITING_FOR_OPPONENT: 'Waiting for opponent',
    LOCKED: 'Picks locked',
    IN_PROGRESS: 'Game in progress',
    FINAL: 'Final',
    DRAW: 'Draw',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    MISSING: 'Not found'
  };

  function entry(ch, slot) {
    var e = (ch && ch.entries) || [];
    for (var i = 0; i < e.length; i++) if (e[i].slot === slot) return e[i];
    return null;
  }
  function you(ch) { return ch && ch.your_slot ? entry(ch, ch.your_slot) : null; }
  function them(ch) {
    if (!ch) return null;
    var other = ch.your_slot === 'a' ? 'b' : 'a';
    return entry(ch, ch.your_slot ? other : 'a');
  }

  /* A selection is present only if the server chose to send it. */
  function selectionOf(ch, slot) {
    return (ch && ch.selections && ch.selections[slot]) || null;
  }

  var API = {
    SB_URL: SB_URL, SESSION_KEY: SESSION_KEY, SECRET_KEY: SECRET_KEY, MODES: MODES,
    PHASE_LABEL: PHASE_LABEL,
    configure: configure, available: available, rpc: rpc,
    session: session, user: user, signedIn: signedIn, displayName: displayName, secret: secret,
    createChallenge: createChallenge, submitChallenge: submitChallenge,
    viewChallenge: viewChallenge, claimChallenge: claimChallenge,
    createGroup: createGroup, previewGroup: previewGroup,
    joinGroup: joinGroup, groupDashboard: groupDashboard,
    challengeUrl: challengeUrl, groupUrl: groupUrl,
    phase: phase, entry: entry, you: you, them: them, selectionOf: selectionOf
  };
  root.EDGamesSocial = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
