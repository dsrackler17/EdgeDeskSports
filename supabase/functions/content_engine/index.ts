// ============================================================
//  FILE:    supabase/functions/content_engine/index.ts
//  TYPE:    Edge Function (deployed) — the Content Engine's server half:
//           the AI editorial pass, the trending-news fetch, and the email the
//           OWNER sends to a publisher by pressing Send. It never approves or
//           publishes anything, and never sends on its own.
//  DEPLOY:  supabase functions deploy content_engine --no-verify-jwt
//           (the owner's token is verified inside, by requireOutboundOwner)
// ============================================================
// WHAT IT DOES, WHEN THE OWNER ASKS (admin/content/)
//
//   POST { action: 'status' }
//        whether Claude is configured (never the key), the model, and
//        today's budget.
//   POST { action: 'draft', article_id, section? }
//        1  the article, its opportunity's FROZEN research packet, the
//           publisher's editorial profile and its sibling articles, read
//           from the database as the owner (content_engine_article);
//        2  one Claude call, counted against today's budget FIRST
//           (content_engine_spend), structured JSON out;
//        3  the reply is checked by the same gate the page and the weekly
//           job use (lib/content_engine.js validate): every number and team
//           in the research, no pick/lock/guarantee language, projections
//           never sold as bets, stale prices labelled, reporting attributed,
//           no near-duplicate of a sibling;
//        4  refused → Claude gets the objections and one more try; refused
//           again → nothing is saved, the reasons are logged and returned,
//           and the existing draft stands;
//        5  accepted → saved as a new revision (content_engine_article_save,
//           which puts an approved article back into review).
//        With `section`, only that section is rewritten.
//   POST { action: 'send', article_id, recipient, subject?, note?, test? }
//        THE OWNER'S SEND. Only when the owner presses Send in the publishing
//        queue (the page confirms the address first):
//        1  content_engine_send_claim, as the owner: the article is approved
//           and ready to send, the content is the approved hash on screen, and
//           the recipient is a contact on that publisher's profile — or, with
//           test, the owner's own sign-in address. The send is WRITTEN before
//           anything goes out, with one idempotency key;
//        2  Resend, with that Idempotency-Key: the owner's note, the article
//           as HTML (and as text), and as attachments the Word file the
//           editor can touch up, the Markdown, the HTML and the SEO sheet,
//           from the engine's edgedesksports.com sender;
//        3  content_engine_send_result: a delivery row and `sent`, or the
//           failure. An unanswered send is retried with the same key and
//           the message as first claimed, so it can never arrive twice.
//   POST { action: 'trending', leagues?: ['cfb','nfl'] }
//        the public RSS feeds in lib/content_engine.js FEEDS (headline, link,
//        time and the feed's own description — never an article body), each
//        fetch counted against the budget. Matching to the slate happens in
//        the page, against the research it already holds.
//
// WHO: the owner's own session. requireOutboundOwner (verbatim from
// tools/growth/outbound_auth.js) first; every database call is made AS THE
// CALLER, so the database checks the owner again at every step. No
// service-role key.
//
// ENVIRONMENT (Supabase → Edge Functions → Secrets; never in a page)
//   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the platform
//   ANTHROPIC_API_KEY        optional: without it the deterministic draft is
//                            the draft (the page says so)
//   RESEND_API_KEY           Send to publisher (already set for the newsletter
//                            and outbound; Supabase secrets are shared)
//   CONTENT_ENGINE_MODEL     optional; defaults to claude-opus-5-5
//   CONTENT_ENGINE_ALLOWED_ORIGINS  optional; defaults to edgedesksports.com
// ============================================================

// ── BEGIN OUTBOUND AUTH ──────────────────────────────────────────────────
// Canonical source: tools/growth/outbound_auth.js, copied VERBATIM by
// tools/growth/inline_outbound_auth.js. Edit the canonical file, then run it.
/* ===========================================================================
   requireOutboundOwner — the server-side owner check every privileged
   outbound Edge Function runs before it does anything.

   Written once, here, with its tests (tools/growth/outbound_auth.test.js),
   and copied byte-for-byte into each Edge Function that needs it (the repo's
   functions are single files with no imports; a test holds the copies equal,
   as tools/billing/billing_core.test.js does for the billing core).

   THE RULE: the caller is somebody only because GoTrue says so, and an owner
   only because the DATABASE says so, asked as that caller. Nothing in the
   request body names the user; nothing is cached; every failure is a refusal.

     1  Authorization must be `Bearer <jwt>`, and not the public anon key
        (which names nobody)                                   → else 401
     2  GoTrue /auth/v1/user must accept the token (it also rejects a revoked
        or expired session)                                    → else 401;
        unreachable or 5xx                                     → 503
     3  public.growth_outbound_is_owner() called AS THE CALLER must answer
        exactly `true`                                         → else 403;
        not installed                                          → 503;
        unreachable or 5xx                                     → 503

   It needs only the project URL and the anon key: no service-role secret is
   involved in deciding who the caller is. Every door the function then calls
   is called AS THE CALLER too (rpcAsCaller), so the database checks the owner
   again on every action.
   =========================================================================== */
(function (root) {
  'use strict';

  var TIMEOUT_MS = 8000;

  function refuse(status, reason) { return { ok: false, status: status, reason: reason }; }

  function withTimeout(fetchImpl, url, init, ms) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { try { ctl.abort(); } catch (_) {} }, ms || TIMEOUT_MS) : null;
    return Promise.resolve()
      .then(function () { return fetchImpl(url, ctl ? Object.assign({}, init, { signal: ctl.signal }) : init); })
      .then(function (r) { if (t) clearTimeout(t); return r; }, function (e) { if (t) clearTimeout(t); throw e; });
  }

  function readJson(r) {
    return Promise.resolve(r.text ? r.text() : '').then(function (t) {
      if (!t) return null;
      try { return JSON.parse(t); } catch (_) { return undefined; }
    }, function () { return undefined; });
  }

  function headerOf(req, name) {
    try {
      if (req && req.headers && typeof req.headers.get === 'function') return req.headers.get(name) || '';
      if (req && req.headers) return req.headers[name] || req.headers[name.toLowerCase()] || '';
    } catch (_) {}
    return '';
  }

  /* cfg: { url, anonKey, fetch, timeoutMs } */
  function requireOutboundOwner(req, cfg) {
    cfg = cfg || {};
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var anon = String(cfg.anonKey || '');
    var f = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!base || !anon || !f) return Promise.resolve(refuse(500, 'misconfigured'));

    var authz = String(headerOf(req, 'authorization') || '');
    var m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
    if (!m) return Promise.resolve(refuse(401, 'sign_in_required'));
    var token = m[1];
    if (token === anon) return Promise.resolve(refuse(401, 'sign_in_required'));
    if (token.split('.').length !== 3) return Promise.resolve(refuse(401, 'sign_in_required'));
    var callerAuthz = 'Bearer ' + token;

    return withTimeout(f, base + '/auth/v1/user', { method: 'GET', headers: { apikey: anon, authorization: callerAuthz } }, cfg.timeoutMs)
      .then(function (r) {
        if (r.status >= 500) return refuse(503, 'auth_unavailable');
        if (!r.ok) return refuse(401, 'session_invalid');
        return readJson(r).then(function (u) {
          if (!u || typeof u.id !== 'string' || !u.id) return refuse(401, 'session_invalid');
          return withTimeout(f, base + '/rest/v1/rpc/growth_outbound_is_owner', {
            method: 'POST', headers: { apikey: anon, authorization: callerAuthz, 'content-type': 'application/json' }, body: '{}'
          }, cfg.timeoutMs).then(function (o) {
            return readJson(o).then(function (b) {
              if (o.status >= 500) return refuse(503, 'owner_check_unavailable');
              if (o.status === 404 || (b && (b.code === 'PGRST202' || b.code === '42883'))) return refuse(503, 'outbound_not_installed');
              if (o.status === 401) return refuse(401, 'session_invalid');
              if (o.ok && b === true) return { ok: true, status: 200, user: { id: u.id, email: u.email || null }, authz: callerAuthz };
              return refuse(403, 'not_an_owner');
            });
          }, function () { return refuse(503, 'owner_check_unavailable'); });
        });
      }, function () { return refuse(503, 'auth_unavailable'); });
  }

  /* Every door afterwards, called as the caller: the database checks again. */
  function rpcAsCaller(cfg, callerAuthz, name, args) {
    var base = String(cfg.url || '').replace(/\/+$/, '');
    var f = cfg.fetch || fetch;
    return withTimeout(f, base + '/rest/v1/rpc/' + encodeURIComponent(name), {
      method: 'POST', headers: { apikey: cfg.anonKey, authorization: callerAuthz, 'content-type': 'application/json' },
      body: JSON.stringify(args || {})
    }, cfg.timeoutMs).then(function (r) {
      return readJson(r).then(function (b) { return { status: r.status, ok: r.ok, body: b }; });
    });
  }

  var API = { requireOutboundOwner: requireOutboundOwner, rpcAsCaller: rpcAsCaller };
  root.EDOutboundAuth = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
// ── END OUTBOUND AUTH ────────────────────────────────────────────────────

// ── BEGIN FOOTBALL EVIDENCE ─────────────────────────────────────────────
// Canonical source: lib/football_evidence.js, copied VERBATIM by
// tools/content/inline.js. Edit the canonical file, then run it.
/* ===========================================================================
   EdgeDesk — football evidence packets (EDFootballEvidence).

   WHY THIS EXISTS
     A publisher told us, correctly, that an article presented EdgeDesk's
     Ole Miss–Vanderbilt number as a near toss-up against a market that made
     Ole Miss a 9.5-point favourite, and gave no football reason for the
     disagreement. A projection is not evidence of its own explanation. This
     file turns what EdgeDesk already measures into FOOTBALL EVIDENCE, explains
     the model-versus-market gap in football terms (or says plainly that it
     cannot), and gates every article on that evidence.

   One file, no dependencies, three hosts (like lib/content_engine.js):
     · Node: tools/content/evidence.js builds one packet per matchup from the
       committed artifacts; tools/articles + tools/editorial read it for the
       first-party pages;
     · the owner's Content Engine page loads it before lib/content_engine.js;
     · the content_engine Edge Function carries a VERBATIM copy
       (tools/content/inline.js) so the gate runs on every AI rewrite.

   WHAT IT DOES
     build      one packet per matchup: CLAIMS, each with its source, the time
                its source was observed, a verification status and a scope
                (current season / historical / model / market / report), plus
                a COVERAGE list naming every research item the desk wanted and
                whether it was available. A missing statistic stays missing.
     explain    the model-versus-market explanation: thesis, supporting and
                contradicting evidence, the critical matchup, the game script
                each number needs, unresolved uncertainty, an input audit and a
                status — EXPLAINED / PARTIALLY_EXPLAINED / UNEXPLAINED. An
                unexplained gap is never actionable.
     gate       the editorial gate an article must pass: football evidence for
                every featured game, contrary evidence, quarterback and injury
                status as the evidence states it, no unsupported causal
                explanation of a gap, no edge language, historical facts dated,
                correct gap arithmetic, no repeated filler, no unknown sources.
                It returns checks for lib/content_engine.js validate() and an
                evidence record for every claim the article cites.

   VERIFICATION VOCABULARY (a claim's `verification`)
     VERIFIED_DATA    measured from EdgeDesk's committed play-by-play, box and
                      results artifacts, with the artifact's own timestamp
     OFFICIAL_REPORT  an official availability / injury report on file
     VERIFIED_REPORT  outside reporting a person confirmed at the source
     REPORTED         outside reporting recorded with outlet, URL and date but
                      NOT confirmed at the source — citable with attribution,
                      and an article that relies on it is held for review
     RATING           an EdgeDesk position-group or team rating (derived)
     MODEL_OUTPUT     a number the model produced. Never football evidence.
     MARKET_DATA      a captured sportsbook line
     CONFLICTING      two inputs disagree; cited only to disclose the conflict
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDFootballEvidence = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_football_evidence_v1';
  var VERSION = 'football_evidence_v1';
  var SITE = 'https://edgedesksports.com';

  /* a gap under this is ordinary model disagreement, not a story */
  var MATERIAL_GAP = 2;
  var MAJOR_GAP = 7;
  var STALE_MINUTES = 180;

  var FOOTBALL = { VERIFIED_DATA: 1, OFFICIAL_REPORT: 1, VERIFIED_REPORT: 1, REPORTED: 1, RATING: 1 };
  var MEASURED = { VERIFIED_DATA: 1, OFFICIAL_REPORT: 1, VERIFIED_REPORT: 1, REPORTED: 1 };

  /* ---------------------------------------------------------------- utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r1(x) { return +(+x).toFixed(1); }
  function r2(x) { return +(+x).toFixed(2); }
  function f1(x) { return (+x).toFixed(1); }
  function pct1(p) { return (p * 100).toFixed(1) + '%'; }
  function pct0(p) { return Math.round(p * 100) + '%'; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function ts(x) { var t = x ? Date.parse(x) : NaN; return isFinite(t) ? t : null; }
  function iso(t) { return new Date(t).toISOString(); }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!s[k]) { s[k] = 1; out.push(x); } }); return out; }
  function hash(s) {
    s = String(s); var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
  }
  /* a model term in words — never the code's own key (“net_pass”) */
  var NFL_TERMS = { net_pts: 'scoring margin', net_epa: 'overall efficiency', net_pass: 'passing efficiency', net_rush: 'rushing efficiency', qb_adj_diff: 'quarterback adjustment', rest_diff: 'rest', div_game: 'division game' };
  function termLabel(r) {
    var l = NFL_TERMS[r.key] || (r.label && !/_/.test(r.label) ? r.label : String(r.label || r.key || '').replace(/_/g, ' '));
    return String(l).replace(/\s*\(.*\)\s*/g, '');
  }
  function poss(team) { return /s$/.test(team) ? team + '’' : team + '’s'; }
  function lastName(n) { var p = String(n || '').replace(/\s+(Jr\.?|Sr\.?|II|III|IV)$/i, '').split(/\s+/); return p[p.length - 1] || n; }
  function sentenceList(arr, conj) {
    arr = (arr || []).filter(Boolean); conj = ' ' + (conj || 'and') + ' ';
    if (arr.length <= 1) return arr.join('');
    if (arr.length === 2) return arr[0] + conj + arr[1];
    return arr.slice(0, -1).join(', ') + conj + arr[arr.length - 1];
  }
  var NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function numWord(n) { return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n); }
  function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function score(a, b) { return Math.max(a, b) + '–' + Math.min(a, b); }
  function countWord(n, w) { return (n === 0 ? 'no ' + w + 's' : n + ' ' + w + (n === 1 ? '' : 's')); }
  /* a passer's yards per attempt against the FBS average (7.5) */
  function qbRel(ypa) { return (ypa - 7.49) / 7.49; }

  /* Dates the way a sports desk prints them, in Eastern time. */
  var MONTHS_AP = { Jan: 'Jan.', Feb: 'Feb.', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'Aug.', Sep: 'Sept.', Oct: 'Oct.', Nov: 'Nov.', Dec: 'Dec.' };
  function dayMonth(t) {
    if (t == null) return null;
    try {
      var parts = {};
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
        .formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
      return (MONTHS_AP[parts.month] || parts.month) + ' ' + parts.day;
    } catch (e) {
      var d = new Date(t - 4 * 3600000);
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      return MONTHS_AP[mo] + ' ' + d.getUTCDate();
    }
  }

  /* ======================================================================
     CLAIMS
     ====================================================================== */
  /* cite: { nums: ['10.3'], words: ['sack'] } — an article cites the claim
     when ONE sentence carries every number and at least one of the words.
     With all: true, that sentence must carry EVERY word, where 'a|b' is a
     choice — how a claim with no number is told apart from any sentence that
     merely names the team or the player (“Vanderbilt’s availability report
     lists four players as out” is not cited by a sentence about Vanderbilt). */
  function claim(o) {
    var c = {
      id: 'c_' + hash([o.topic, o.key, o.team || '', o.subject || ''].join('|')).slice(0, 12),
      topic: o.topic, key: o.key, team: o.team || null, side: o.side || null, subject: o.subject || null,
      text: o.text, short: o.short || o.text, label: o.label || null,
      cite: { nums: (o.cite && o.cite.nums || []).map(String), words: (o.cite && o.cite.words || []).map(String), any: !!(o.cite && o.cite.any), all: !!(o.cite && o.cite.all) },
      values: o.values || null,
      scope: o.scope || 'current_season',
      source: o.source || null,
      observed_at: o.observed_at || null,
      verification: o.verification,
      football: !!FOOTBALL[o.verification],
      measured: !!MEASURED[o.verification],
      needs_confirmation: o.verification === 'REPORTED',
      leans: o.leans || null,
      strength: o.strength || null,
      sample: isNum(o.sample) ? Math.round(o.sample) : null,
      caveat: o.caveat || null,
      material: !!o.material,
      status: o.status || null
    };
    return c;
  }

  /* ---- unit metrics: football/matchup/metrics.json performance.*_detail ---- */
  var METRICS = {
    success_rate:        { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'efficiency', words: ['succe'], phrase: 'succeeds on {v} of its offensive plays', label: 'Success rate' },
    early_down_success:  { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'early_downs', words: ['early', 'first- and second', 'first and second'], phrase: 'succeeds on {v} of its first- and second-down plays', label: 'Early-down success' },
    explosive_pass_rate: { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'explosive_pass', words: ['explosive', 'big play', 'big gain'], phrase: 'turns {v} of its pass plays into explosive gains', label: 'Explosive pass rate' },
    yards_per_attempt:   { side: 'off', topic: 'offense', unit: 'num', better: 'high', pair: 'pass', words: ['per attempt', 'per pass', 'yards a throw', 'per throw'], phrase: 'averages {v} yards per pass attempt', label: 'Yards per pass attempt' },
    explosive_rush_rate: { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'explosive_rush', words: ['explosive', 'big run', 'big gain'], phrase: 'turns {v} of its runs into explosive gains', label: 'Explosive run rate' },
    sack_rate_allowed:   { side: 'off', topic: 'line', unit: 'pct', better: 'low', pair: 'protection', words: ['sack'], phrase: 'has allowed a sack on {v} of its dropbacks', label: 'Sack rate allowed' },
    yards_per_rush:      { side: 'off', topic: 'offense', unit: 'num', better: 'high', pair: 'rush', words: ['per carry', 'per rush', 'per run'], phrase: 'averages {v} yards per carry', label: 'Yards per carry' },
    third_success:       { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'third_down', words: ['third'], phrase: 'converts {v} of its third downs', label: 'Third-down conversion' },
    stuff_rate:          { side: 'off', topic: 'line', unit: 'pct', better: 'low', pair: 'run_blocking', words: ['behind the line', 'stuffed', 'stopped'], phrase: 'is stopped at or behind the line on {v} of its runs', label: 'Runs stuffed' },
    rz_success:          { side: 'off', topic: 'offense', unit: 'pct', better: 'high', pair: 'red_zone', words: ['red zone', 'red-zone'], phrase: 'succeeds on {v} of its red-zone plays', label: 'Red-zone success' },
    turnover_rate:       { side: 'off', topic: 'offense', unit: 'pct', better: 'low', pair: 'turnovers', words: ['turn', 'giveaway'], phrase: 'turns the ball over on {v} of its plays', label: 'Turnover rate', unreliable: 'the play-by-play feed does not attribute fumbles reliably (football/matchup/profiles_2026.json column gates)' },
    def_success_allowed:        { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'efficiency', words: ['succe'], phrase: 'allows opponents to succeed on {v} of their plays', label: 'Success allowed' },
    def_early_down_allowed:     { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'early_downs', words: ['early', 'first- and second', 'first and second'], phrase: 'allows success on {v} of first- and second-down plays', label: 'Early-down success allowed' },
    def_explosive_pass_allowed: { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'explosive_pass', words: ['explosive', 'big play', 'big gain'], phrase: 'gives up explosive gains on {v} of opponent pass plays', label: 'Explosive passes allowed' },
    def_yards_per_attempt:      { side: 'def', topic: 'defense', unit: 'num', better: 'low', pair: 'pass', words: ['per attempt', 'per pass', 'per throw'], phrase: 'allows {v} yards per pass attempt', label: 'Yards per pass attempt allowed' },
    def_explosive_rush_allowed: { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'explosive_rush', words: ['explosive', 'big run', 'big gain'], phrase: 'gives up explosive gains on {v} of opponent runs', label: 'Explosive runs allowed' },
    def_sack_rate:              { side: 'def', topic: 'pressure', unit: 'pct', better: 'high', pair: 'protection', words: ['sack'], phrase: 'sacks the quarterback on {v} of opponent dropbacks', label: 'Sack rate' },
    def_yards_per_rush:         { side: 'def', topic: 'defense', unit: 'num', better: 'low', pair: 'rush', words: ['per carry', 'per rush', 'per run'], phrase: 'allows {v} yards per carry', label: 'Yards per carry allowed' },
    def_third_allowed:          { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'third_down', words: ['third'], phrase: 'allows opponents to convert {v} of their third downs', label: 'Third downs allowed' },
    def_stuff_rate:             { side: 'def', topic: 'defense', unit: 'pct', better: 'high', pair: 'run_blocking', words: ['behind the line', 'stuff', 'stop'], phrase: 'stops {v} of opponent runs at or behind the line', label: 'Runs stuffed (defense)' },
    def_rz_allowed:             { side: 'def', topic: 'defense', unit: 'pct', better: 'low', pair: 'red_zone', words: ['red zone', 'red-zone'], phrase: 'allows success on {v} of opponent red-zone plays', label: 'Red-zone success allowed' },
    def_turnovers_forced:       { side: 'def', topic: 'defense', unit: 'pct', better: 'high', pair: 'turnovers', words: ['turnover', 'takeaway', 'force'], phrase: 'forces a turnover on {v} of opponent plays', label: 'Takeaway rate', unreliable: 'the play-by-play feed does not attribute fumbles reliably (football/matchup/profiles_2026.json column gates)' }
  };
  /* How one side's offence meets the other's defence, and the football
     question each collision asks. {O} offence, {D} defence, {QB} O's passer. */
  var PAIRS = {
    protection:     { off: 'sack_rate_allowed', def: 'def_sack_rate', label: 'pass protection against the pass rush', q: 'Can {D}’s Pass Rush Get to {QB}?', watch: 'whether {D} can get pressure on {QB}' },
    pass:           { off: 'yards_per_attempt', def: 'def_yards_per_attempt', label: 'the passing game against the pass defense', q: 'Can {D}’s Pass Defense Slow {O}’s Passing Game?', watch: 'how many yards {O} gains per throw against {D}’s secondary' },
    rush:           { off: 'yards_per_rush', def: 'def_yards_per_rush', label: 'the run game against the run defense', q: 'Can {D} Stop {O}’s Run Game?', watch: 'whether {O} can run on {D}' },
    early_downs:    { off: 'early_down_success', def: 'def_early_down_allowed', label: 'early downs', q: 'Can {D} Keep {O} Behind Schedule?', watch: 'whether {D} keeps {O} behind schedule on first and second down' },
    third_down:     { off: 'third_success', def: 'def_third_allowed', label: 'third down', q: 'Can {D} Get {O} Off the Field on Third Down?', watch: 'third-down conversions when {O} has the ball' },
    red_zone:       { off: 'rz_success', def: 'def_rz_allowed', label: 'the red zone', q: 'Can {D} Hold {O} to Field Goals?', watch: 'touchdowns versus field goals when {O} reaches the red zone' },
    explosive_pass: { off: 'explosive_pass_rate', def: 'def_explosive_pass_allowed', label: 'big plays through the air', q: 'Can {D} Take Away {O}’s Big Plays?', watch: 'explosive pass plays by {O}' },
    explosive_rush: { off: 'explosive_rush_rate', def: 'def_explosive_rush_allowed', label: 'big plays on the ground', q: 'Can {D} Contain {O}’s Explosive Runs?', watch: 'long runs by {O}' },
    turnovers:      { off: 'turnover_rate', def: 'def_turnovers_forced', label: 'ball security against takeaways', q: 'Can {D} Force {O} Into Mistakes?', watch: 'turnovers' },
    run_blocking:   { off: 'stuff_rate', def: 'def_stuff_rate', label: 'the line of scrimmage on running plays', q: 'Can {D} Win at the Line of Scrimmage?', watch: 'how often {D} stops {O}’s runs at or behind the line' },
    efficiency:     { off: 'success_rate', def: 'def_success_allowed', label: 'down-to-down efficiency', q: 'Can {D}’s Defense Slow {O}’s Offense?', watch: 'down-to-down success when {O} has the ball' }
  };

  function metricText(id, v) { var m = METRICS[id]; return m.unit === 'pct' ? pct1(v) : f1(v); }
  function metricNum(id, v) { var m = METRICS[id]; return m.unit === 'pct' ? f1(v * 100) : f1(v); }
  /* goodness of a value for its own team, relative to the league: +0.3 = 30% better */
  function goodness(id, v, lg) {
    var m = METRICS[id]; if (!isNum(v) || !isNum(lg) || lg === 0) return null;
    return clamp(m.better === 'high' ? (v - lg) / lg : (lg - v) / lg, -1, 1);
  }
  function strengthOf(g) { var a = Math.abs(g); return a >= 0.35 ? 'large' : a >= 0.2 ? 'moderate' : a >= 0.1 ? 'small' : null; }
  /* The lean a reader can SEE: the printed (raw) number and the
     opponent-adjusted one must agree in direction, and the smaller of the two
     sets the size — so a claim never "leans" on a number the text hides. */
  function leanOf(id, u) {
    var gr = goodness(id, u.raw, u.league), ga = isNum(u.adjusted) ? goodness(id, u.adjusted, u.league) : gr;
    if (gr == null || ga == null) return null;
    if (gr * ga <= 0) return 0;
    return gr > 0 ? Math.min(gr, ga) : Math.max(gr, ga);
  }
  function metricIndex(team) {
    var out = {};
    var p = team && team.performance || {};
    ['offense_detail', 'defense_detail'].forEach(function (k) {
      ((p[k] && p[k].used) || []).forEach(function (u) { if (u && METRICS[u.id]) out[u.id] = u; });
    });
    return out;
  }

  /* ======================================================================
     BUILD — CFB
     x: { game (cfb_terminal record), keys {home, away}, metrics {home, away},
          profiles {home, away}, qbs {home: [players], away: [players]},
          reports {home, away}, forecast, h2h [lines archive games], finals
          {game_id: {...}}, rankings {teams}, record (first-party), facts [],
          notes [], as_of {metrics, profiles, qbs, record, lines, rankings,
          forecasts, terminal} }
     ====================================================================== */
  function buildCfb(x, opts) {
    opts = opts || {};
    var g = x.game || {}, gm = g.game || {};
    var home = gm.home, away = gm.away;
    var now = isNum(opts.now) ? opts.now : Date.now();
    var A = x.as_of || {};
    var claims = [], cov = {};
    function add(c) { if (c && claims.every(function (y) { return y.id !== c.id; })) claims.push(c); return c; }
    function covered(item, c) { (cov[item] = cov[item] || []).push(c.id); }
    var teams = { home: home, away: away };
    var keys = x.keys || {};
    var M = { home: metricIndex(x.metrics && x.metrics.home), away: metricIndex(x.metrics && x.metrics.away) };
    var lg = 'FBS average';
    var srcMetrics = { id: 'matchup_metrics', label: 'EdgeDesk play-by-play unit metrics (2026 season)', path: 'football/matchup/metrics.json' };

    /* ---- cross-check: sack figures. EdgeDesk's play-by-play feed under-
       attributes sacks (profiles_2026.json column_gates), so the unit metric
       is checked against the quarterback logs (offence) and the ESPN box
       (defence). Where they disagree the corroborated figure is used and the
       metric is kept only as a CONFLICTING claim. ---- */
    var over = { home: {}, away: {} }, dataConflicts = [];
    ['home', 'away'].forEach(function (side) {
      var qs = (x.qbs && x.qbs[side]) || [], sk = 0, db = 0;
      qs.forEach(function (p) { (p.season_log || []).forEach(function (l) { if (l.team_key === keys[side]) { sk += l.sacks || 0; db += l.dropbacks || 0; } }); });
      var mu = M[side].sack_rate_allowed;
      if (db >= 60 && mu && isNum(mu.raw) && Math.abs(sk / db - mu.raw) > 0.015) {
        over[side].sack_rate_allowed = { raw: sk / db, adjusted: null, league: mu.league, n_obs: db, count: sk, base: db,
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs, unit: 'dropbacks' };
        dataConflicts.push({ side: side, id: 'sack_rate_allowed', metric: mu.raw, used: sk / db, why: 'unit metrics ' + pct1(mu.raw) + ' against quarterback logs ' + pct1(sk / db) + ' (' + sk + ' of ' + db + ')' });
      }
      var bt = x.box && x.box[side], pa = x.profiles && x.profiles[side] && x.profiles[side].allowed, md = M[side].def_sack_rate;
      if (bt && isNum(bt.sacks) && pa && isNum(pa.dropbacks) && pa.dropbacks >= 60 && md && isNum(md.raw) && Math.abs(bt.sacks / pa.dropbacks - md.raw) > 0.02) {
        over[side].def_sack_rate = { raw: bt.sacks / pa.dropbacks, adjusted: null, league: md.league, n_obs: pa.dropbacks, count: bt.sacks, base: pa.dropbacks,
          source: { id: 'box', label: 'ESPN box scores (sacks) over play-by-play opponent dropbacks', path: 'football/data/box/2026.json' }, observed_at: A.box, unit: 'opponent dropbacks' };
        dataConflicts.push({ side: side, id: 'def_sack_rate', metric: md.raw, used: bt.sacks / pa.dropbacks, why: 'unit metrics ' + pct1(md.raw) + ' against box-score sacks ' + pct1(bt.sacks / pa.dropbacks) + ' (' + bt.sacks + ' of ' + pa.dropbacks + ')' });
      }
    });
    function U(side, id) { return over[side][id] || M[side][id]; }

    /* ---- team unit metrics ---- */
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      Object.keys(M[side]).forEach(function (id) {
        var m = METRICS[id], ov = over[side][id], u = U(side, id);
        if (!isNum(u.raw) || !isNum(u.league) || m.unreliable) return;
        if (ov) {
          var mu0 = M[side][id];
          add(claim({
            topic: 'data', key: 'metric_conflict:' + id + ':' + side, team: team, side: side, label: m.label + ' (sources disagree)',
            text: 'EdgeDesk’s sources disagree on ' + poss(team) + ' ' + m.label.toLowerCase() + ': the play-by-play unit metric says ' + metricText(id, mu0.raw) + ', the ' + (id === 'def_sack_rate' ? 'box scores' : 'quarterback logs') + ' say ' + metricText(id, ov.raw) + '.',
            short: poss(team) + ' ' + m.label.toLowerCase() + ' is disputed between EdgeDesk’s sources',
            cite: { nums: [metricNum(id, mu0.raw)], words: m.words }, values: { metric: mu0.raw, corroborated: ov.raw },
            source: srcMetrics, observed_at: A.metrics, verification: 'CONFLICTING', caveat: 'not used as evidence'
          }));
        }
        var gd = leanOf(id, u);
        var small = isNum(u.n_obs) && u.n_obs < 40;
        var count = ov ? ' — ' + ov.count + ' sack' + (ov.count === 1 ? '' : 's') + ' on ' + ov.base + ' ' + ov.unit : '';
        var c = add(claim({
          topic: m.topic, key: 'metric:' + id, team: team, side: side,
          label: m.label,
          text: poss(team) + (m.side === 'off' ? ' offense ' : ' defense ') + m.phrase.replace('{v}', metricText(id, u.raw)) + count + ' (' + lg + ' ' + metricText(id, u.league) + ').',
          short: poss(team) + (m.side === 'off' ? ' offense ' : ' defense ') + m.phrase.replace('{v}', metricText(id, u.raw)),
          cite: { nums: [metricNum(id, u.raw)], words: m.words },
          values: { raw: u.raw, adjusted: u.adjusted, league: u.league, plays: u.n_obs },
          source: ov ? ov.source : srcMetrics, observed_at: ov ? ov.observed_at : A.metrics,
          verification: 'VERIFIED_DATA',
          leans: gd == null || !strengthOf(gd) ? null : (gd > 0 ? team : (side === 'home' ? away : home)),
          strength: gd == null ? null : strengthOf(gd), sample: u.n_obs,
          caveat: small ? 'small sample: ' + Math.round(u.n_obs) + ' plays' : null
        }));
        c.component = true;
        var item = { yards_per_attempt: 'off_rush_pass', yards_per_rush: 'off_rush_pass', success_rate: 'off_efficiency', early_down_success: 'off_efficiency',
          explosive_pass_rate: 'off_explosive', explosive_rush_rate: 'off_explosive', third_success: 'off_third', rz_success: 'off_red_zone',
          sack_rate_allowed: 'off_line', stuff_rate: 'off_line', turnover_rate: 'off_efficiency',
          def_yards_per_attempt: 'def_rush_pass', def_yards_per_rush: 'def_rush_pass', def_sack_rate: 'def_pressure', def_explosive_pass_allowed: 'def_explosive',
          def_explosive_rush_allowed: 'def_explosive', def_third_allowed: 'def_third', def_rz_allowed: 'def_red_zone', def_success_allowed: 'def_efficiency',
          def_early_down_allowed: 'def_efficiency', def_stuff_rate: 'def_rush_pass', def_turnovers_forced: 'def_efficiency' }[id];
        if (item) covered(item, c);
      });
    });

    /* ---- matchups: one side's offence against the other's defence ---- */
    var pairs = [];
    ['home', 'away'].forEach(function (oside) {
      var dside = oside === 'home' ? 'away' : 'home';
      var O = teams[oside], D = teams[dside];
      Object.keys(PAIRS).forEach(function (pk) {
        var P = PAIRS[pk], uo = U(oside, P.off), ud = U(dside, P.def);
        if (METRICS[P.off].unreliable || METRICS[P.def].unreliable) return;
        if (!uo || !ud || !isNum(uo.raw) || !isNum(ud.raw)) return;
        var go = leanOf(P.off, uo), gdf = leanOf(P.def, ud);
        if (go == null || gdf == null) return;
        var edge = go - gdf;
        var favors = Math.abs(edge) >= 0.12 ? (edge > 0 ? O : D) : null;
        var collision = Math.min(go, gdf);
        var sample = Math.min(uo.n_obs || 0, ud.n_obs || 0);
        var mo = METRICS[P.off], md = METRICS[P.def];
        var c = add(claim({
          topic: 'matchup', key: 'pair:' + pk + ':' + oside, team: O, side: oside,
          label: cap(P.label),
          text: 'When ' + O + ' has the ball (' + P.label + '): ' + poss(O) + ' offense ' + mo.phrase.replace('{v}', metricText(P.off, uo.raw))
            + ', and ' + poss(D) + ' defense ' + md.phrase.replace('{v}', metricText(P.def, ud.raw)) + ' (' + lg + ' ' + metricText(P.off, uo.league) + ').',
          /* the league average stays in the short form: without it, 5.7% against 6.0% does not say who has the edge */
          short: poss(O) + ' offense ' + mo.phrase.replace('{v}', metricText(P.off, uo.raw)) + '; ' + poss(D) + ' defense ' + md.phrase.replace('{v}', metricText(P.def, ud.raw)) + ' (' + lg + ' ' + metricText(P.off, uo.league) + ')',
          cite: { nums: [metricNum(P.off, uo.raw), metricNum(P.def, ud.raw)], words: mo.words, any: true },
          values: { offense: uo.raw, defense: ud.raw, league: uo.league, edge: r2(edge), collision: r2(collision) },
          source: (over[oside][P.off] || over[dside][P.def]) ? { id: 'matchup_mixed', label: 'EdgeDesk play-by-play metrics, quarterback logs and box scores', path: 'football/matchup/metrics.json' } : srcMetrics,
          observed_at: A.metrics, verification: 'VERIFIED_DATA',
          leans: favors, strength: favors ? strengthOf(edge) : null, sample: sample,
          caveat: sample < 40 ? 'small sample: ' + Math.round(sample) + ' plays' : null
        }));
        pairs.push({ key: pk, oside: oside, O: O, D: D, edge: edge, collision: collision, go: go, gd: gdf, favors: favors, claim: c, sample: sample });
      });
    });

    /* ---- position groups (EdgeDesk ratings) ---- */
    var RK = (x.rankings && x.rankings.teams) || {};
    var rh = RK[keys.home], ra = RK[keys.away];
    var GROUPS = [['qb', 'quarterback room'], ['ol', 'offensive line'], ['dl', 'defensive line'], ['secondary', 'secondary'], ['wr', 'receivers'], ['rb', 'running backs'], ['lb', 'linebackers'], ['pass_defense', 'pass defense'], ['run_defense', 'run defense'], ['offense', 'offense'], ['defense', 'defense']];
    if (rh && ra && rh.ranks && ra.ranks) {
      GROUPS.forEach(function (gp) {
        var a = ra.ranks[gp[0]], h = rh.ranks[gp[0]];
        if (!a || !h || !isNum(a.rank) || !isNum(h.rank)) return;
        var gap = h.rank - a.rank; /* >0: away ranks higher (better) */
        var lead = gap > 0 ? away : home, trail = gap > 0 ? home : away;
        var lr = gap > 0 ? a.rank : h.rank, tr = gap > 0 ? h.rank : a.rank;
        var c = add(claim({
          topic: 'position', key: 'group:' + gp[0], team: lead,
          label: cap(gp[1]),
          text: 'EdgeDesk’s position-group ratings put ' + poss(lead) + ' ' + gp[1] + ' No. ' + lr + ' nationally and ' + poss(trail) + ' No. ' + tr + '.',
          short: poss(lead) + ' ' + gp[1] + ' (No. ' + lr + ') against ' + poss(trail) + ' (No. ' + tr + ')',
          cite: { nums: [String(lr), String(tr)], words: [gp[1].split(' ')[0]] },
          values: { lead_rank: lr, trail_rank: tr, of: Object.keys(RK).length },
          source: { id: 'rankings', label: 'EdgeDesk position-group ratings', path: 'football/rankings/current.json' }, observed_at: A.rankings,
          verification: 'RATING', leans: Math.abs(gap) >= 25 ? lead : null,
          strength: Math.abs(gap) >= 60 ? 'large' : Math.abs(gap) >= 35 ? 'moderate' : Math.abs(gap) >= 25 ? 'small' : null
        }));
        covered('position_groups', c);
      });
    }

    /* ---- quarterbacks ---- */
    var qbClaims = { home: [], away: [] };
    var nameOf = function (key) { var t = RK[key]; return t && t.team || key; };
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      var list = ((x.qbs && x.qbs[side]) || []).map(function (p) {
        var log = (p.season_log || []).filter(function (l) { return l.team_key === keys[side] && isNum(l.attempts); })
          .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
        return { p: p, log: log, db: log.reduce(function (s, l) { return s + (l.dropbacks || 0); }, 0) };
      }).filter(function (q) { return q.db >= 15; }).sort(function (a, b) { return b.db - a.db; }).slice(0, 2);
      list.forEach(function (q) {
        var L = q.log, n = q.p.name;
        var att = 0, cmp = 0, yds = 0, td = 0, ints = 0, sk = 0, db = 0, epa = 0, epaN = 0;
        L.forEach(function (l) { att += l.attempts || 0; cmp += l.completions || 0; yds += l.yards || 0; td += l.tds || 0; ints += l.interceptions || 0; sk += l.sacks || 0; db += l.dropbacks || 0; if (isNum(l.epa)) { epa += l.epa; epaN += l.dropbacks || 0; } });
        if (!att) return;
        var ypa = yds / att, cp = cmp / att;
        var c = add(claim({
          topic: 'qb', key: 'qb_season:' + q.p.athlete_id, team: team, side: side, subject: n,
          label: n + ' (2026)',
          text: n + ' has completed ' + cmp + ' of ' + att + ' passes (' + pct1(cp) + ') for ' + thousands(yds) + ' yards, ' + f1(ypa) + ' yards per attempt, '
            + countWord(td, 'touchdown') + ' and ' + countWord(ints, 'interception') + ' in ' + numWord(L.length) + ' game' + (L.length === 1 ? '' : 's') + ' for ' + team
            + ', and has been sacked on ' + sk + ' of ' + db + ' dropbacks.',
          short: n + ': ' + pct1(cp) + ' completions, ' + f1(ypa) + ' yards per attempt, ' + td + ' TD, ' + ints + ' INT',
          cite: { nums: [f1(ypa)], words: [lastName(n)] },
          values: { attempts: att, completions: cmp, yards: yds, tds: td, ints: ints, sacks: sk, dropbacks: db, epa_per_dropback: epaN ? r2(epa / epaN) : null, games: L.length },
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
          verification: 'VERIFIED_DATA', leans: Math.abs(qbRel(ypa)) >= 0.1 ? (qbRel(ypa) > 0 ? team : (side === 'home' ? away : home)) : null,
          strength: Math.abs(qbRel(ypa)) >= 0.2 ? 'moderate' : (Math.abs(qbRel(ypa)) >= 0.1 ? 'small' : null), sample: db,
          caveat: 'play-by-play attribution; official box scores can differ by a few yards or attempts'
        }));
        qbClaims[side].push(c); covered('qb_efficiency', c); covered('qb_completion', c); covered('qb_ypa', c); covered('qb_td_int', c); covered('qb_sacks', c);
        /* the trend: the last two games against the ones before */
        if (L.length >= 4) {
          var last = L.slice(-2), early = L.slice(0, -2);
          var sum = function (arr, k) { return arr.reduce(function (s, l) { return s + (l[k] || 0); }, 0); };
          var ly = sum(last, 'yards') / Math.max(1, sum(last, 'attempts')), ey = sum(early, 'yards') / Math.max(1, sum(early, 'attempts'));
          var opps = last.map(function (l) { return nameOf(l.opponent_key); });
          var dir = ly - ey;
          var tc = add(claim({
            topic: 'qb', key: 'qb_trend:' + q.p.athlete_id, team: team, side: side, subject: n,
            label: n + ': recent form',
            text: 'In his last two games (' + sentenceList(opps) + '), ' + lastName(n) + ' averaged ' + f1(ly) + ' yards per attempt, against ' + f1(ey) + ' in his ' + (early.length === 1 ? 'game' : numWord(early.length) + ' games') + ' before that.',
            short: lastName(n) + ' ' + f1(ly) + ' yards per attempt over his last two games (' + f1(ey) + ' before)',
            cite: { nums: [f1(ly)], words: [lastName(n)] },
            values: { last_two_ypa: r1(ly), before_ypa: r1(ey), change: r1(dir) },
            source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
            verification: 'VERIFIED_DATA', leans: Math.abs(dir) >= 1 ? (dir > 0 ? team : (side === 'home' ? away : home)) : null,
            strength: Math.abs(dir) >= 1.5 ? 'moderate' : Math.abs(dir) >= 1 ? 'small' : null
          }));
          qbClaims[side].push(tc); covered('qb_trend', tc);
        }
        var lg0 = L[L.length - 1];
        var lc = add(claim({
          topic: 'qb', key: 'qb_last:' + q.p.athlete_id, team: team, side: side, subject: n,
          label: n + ': last game',
          text: 'Against ' + nameOf(lg0.opponent_key) + (lg0.kickoff ? ' on ' + dayMonth(ts(lg0.kickoff)) : '') + ', ' + n + ' went ' + lg0.completions + ' of ' + lg0.attempts + ' for ' + lg0.yards + ' yards with '
            + countWord(lg0.tds, 'touchdown') + ' and ' + countWord(lg0.interceptions, 'interception') + '.',
          short: lastName(n) + ' went ' + lg0.completions + ' of ' + lg0.attempts + ' for ' + lg0.yards + ' yards against ' + nameOf(lg0.opponent_key),
          cite: { nums: [String(lg0.completions), String(lg0.attempts), String(lg0.yards)], words: [lastName(n)] },
          values: { completions: lg0.completions, attempts: lg0.attempts, yards: lg0.yards, tds: lg0.tds, ints: lg0.interceptions, game_id: lg0.game_id },
          source: { id: 'qb_epa', label: 'EdgeDesk play-by-play quarterback logs (2026)', path: 'football/fbs_epa/qb_epa_2026.json' }, observed_at: A.qbs,
          verification: 'VERIFIED_DATA', strength: null
        }));
        qbClaims[side].push(lc); covered('qb_trend', lc);
      });
    });

    /* ---- quarterback status: the model's expectation against the official report ---- */
    var conflicts = [];
    ['home', 'away'].forEach(function (side) {
      var team = teams[side], q = g.qb && g.qb[side];
      var rep = x.reports && x.reports[side];
      var repQbs = rep && rep.rows ? rep.rows.filter(function (r) { return r.position === 'QB'; }) : [];
      if (q && q.player) {
        var contested = !!q.contested;
        var txt = contested
          ? poss(team) + ' quarterback job is unsettled in EdgeDesk’s play-by-play: ' + q.label.replace(/^unresolved:\s*/i, '').replace(/\s*—\s*sources disagree\.?$/i, '') + '. EdgeDesk’s model is built on ' + q.player + ' starting.'
          : q.player + ' started ' + poss(team) + ' last game; no starter has been announced for this one.';
        var sc = add(claim({
          topic: 'qb_status', key: 'qb_model:' + side, team: team, side: side, subject: q.player,
          label: team + ' quarterback (model input)', text: txt,
          short: contested ? poss(team) + ' quarterback job is unsettled' : q.player + ' started the last game',
          cite: contested ? { nums: [], words: ['quarterback', 'unsettled|' + lastName(q.player)], all: true } : { nums: [], words: [lastName(q.player), 'start'], all: true },
          values: { player: q.player, status: q.status, contested: contested },
          source: { id: 'cfb_terminal', label: 'EdgeDesk starter tracking (play-by-play attribution)', path: 'football/cfb_terminal/games.json' }, observed_at: q.as_of || A.terminal,
          verification: 'VERIFIED_DATA', status: q.status, material: contested
        }));
        covered('qb_availability', sc);
      }
      if (rep) {
        repQbs.forEach(function (r) {
          var st = String(r.status || '').toLowerCase();
          var rc = add(claim({
            topic: 'injury', key: 'report:' + side + ':' + r.player_name, team: team, side: side, subject: r.player_name,
            label: r.player_name + ' (official availability)',
            text: poss(team) + ' ' + (rep.report_type ? String(rep.report_type).toLowerCase() + ' ' : '') + (rep.conference_id ? rep.conference_id.toUpperCase() + ' ' : '') + 'availability report' + (rep.published_at ? ' (published ' + dayMonth(ts(rep.published_at)) + ')' : '') + ' lists quarterback ' + r.player_name + ' as ' + st + '.',
            short: r.player_name + ' is listed as ' + st + ' on the ' + (rep.conference_id ? rep.conference_id.toUpperCase() + ' ' : '') + 'availability report',
            cite: { nums: [], words: [lastName(r.player_name), 'report|lists|listed|' + st], all: true },
            values: { status: r.status, position: 'QB' },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at || rep.retrieved_at, verification: 'OFFICIAL_REPORT', status: r.status, material: true
          }));
          covered('qb_availability', rc); covered('injuries', rc);
        });
        if (q && q.player && !repQbs.some(function (r) { return r.player_name === q.player; }) && rep.listing_scope === 'FULL_ROSTER') {
          var nl = add(claim({
            topic: 'injury', key: 'report_absent:' + side, team: team, side: side, subject: q.player, label: q.player + ' (not on the report)',
            text: q.player + ' does not appear on ' + poss(team) + ' ' + (rep.report_type ? String(rep.report_type).toLowerCase() + ' ' : '') + 'availability report.',
            short: q.player + ' is not on the availability report',
            cite: { nums: [], words: [lastName(q.player), 'report|lists|listed'], all: true }, values: { status: 'NOT_LISTED', position: 'QB' },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at, verification: 'OFFICIAL_REPORT', status: 'NOT_LISTED'
          }));
          covered('qb_availability', nl);
        }
        /* conflict: the model expects one passer, the official report says another can play */
        if (q && q.player) {
          var shares = {};
          String(q.label || '').replace(/([A-Z][A-Za-z.'’-]+(?: [A-Z][A-Za-z.'’-]+)+) (\d+)% of recent dropbacks/g, function (_, nm, s) { shares[nm] = +s; return _; });
          repQbs.forEach(function (r) {
            if (r.player_name === q.player) {
              if (r.status === 'OUT' || r.status === 'DOUBTFUL') conflicts.push({ side: side, team: team, model: q.player, report: r, at: rep.published_at || rep.retrieved_at, kind: 'expected_starter_listed_' + r.status.toLowerCase() });
              return;
            }
            var avail = r.status === 'PROBABLE' || r.status === 'AVAILABLE' || r.status === 'QUESTIONABLE';
            if (avail && (shares[r.player_name] || 0) > (shares[q.player] || 0)) conflicts.push({ side: side, team: team, model: q.player, report: r, at: rep.published_at || rep.retrieved_at, share: shares[r.player_name], model_share: shares[q.player] || null, kind: 'other_qb_available' });
          });
        }
        /* everyone else on the report */
        var rows = (rep.rows || []).filter(function (r) { return r.position !== 'QB' && r.status && r.status !== 'AVAILABLE'; });
        var byStatus = {};
        rows.forEach(function (r) { (byStatus[r.status] = byStatus[r.status] || []).push(r); });
        var KEYPOS = { RB: 1, WR: 1, TE: 1, OL: 1 };
        rows.filter(function (r) { return KEYPOS[r.position] && (r.status === 'QUESTIONABLE' || r.status === 'DOUBTFUL'); }).forEach(function (r) {
          var st = String(r.status).toLowerCase();
          var ic = add(claim({
            topic: 'injury', key: 'report:' + side + ':' + r.player_name, team: team, side: side, subject: r.player_name,
            label: r.player_name + ' (' + r.position + ')',
            text: poss(team) + ' availability report lists ' + ({ RB: 'running back', WR: 'receiver', TE: 'tight end', OL: 'offensive lineman' })[r.position] + ' ' + r.player_name + ' as ' + st + '.',
            short: r.position + ' ' + r.player_name + ' (' + st + ')',
            cite: { nums: [], words: [lastName(r.player_name), 'report|lists|listed|' + st], all: true },
            values: { status: r.status, position: r.position },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report (' + (rep.report_type || 'report') + ')', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at || rep.retrieved_at, verification: 'OFFICIAL_REPORT', status: r.status, material: r.position !== 'OL' || r.status === 'DOUBTFUL'
          }));
          covered('injuries', ic);
        });
        var outN = (byStatus.OUT || []).length, olOut = (byStatus.OUT || []).filter(function (r) { return r.position === 'OL'; });
        if (outN) {
          var oc = add(claim({
            topic: 'injury', key: 'report_out:' + side, team: team, side: side,
            label: team + ': players out',
            text: poss(team) + ' availability report lists ' + numWord(outN) + ' player' + (outN === 1 ? '' : 's') + ' as out' + (olOut.length ? ', including offensive ' + (olOut.length > 1 ? 'linemen ' : 'lineman ') + sentenceList(olOut.map(function (r) { return r.player_name; })) : '') + '.',
            short: numWord(outN) + ' ' + team + ' player' + (outN === 1 ? '' : 's') + ' listed out',
            cite: { nums: outN > 10 ? [String(outN)] : [], words: [team, 'out'], all: true },
            values: { out: outN, players: (byStatus.OUT || []).map(function (r) { return r.player_name + ' (' + r.position + ')'; }) },
            source: { id: 'availability_report', label: (rep.conference || 'Conference') + ' availability report', path: 'football/availability/reports/', url: rep.source_url || null, published_at: rep.published_at },
            observed_at: rep.published_at, verification: 'OFFICIAL_REPORT', material: olOut.length >= 2
          }));
          covered('injuries', oc);
        }
      }
    });
    conflicts.forEach(function (cf) {
      var txt = cf.kind === 'other_qb_available'
        ? 'EdgeDesk’s model is built on ' + cf.model + ' starting for ' + cf.team + ', but the availability report lists ' + cf.report.player_name + ' — who took ' + (cf.share ? cf.share + '% of ' + poss(cf.team) + ' recent dropbacks' : 'the larger share of recent snaps') + ' — as ' + String(cf.report.status).toLowerCase() + '. The model’s quarterback input may be out of date.'
        : 'EdgeDesk’s model is built on ' + cf.model + ' starting for ' + cf.team + ', but the availability report lists him as ' + String(cf.report.status).toLowerCase() + '.';
      add(claim({
        topic: 'input', key: 'qb_conflict:' + cf.side, team: cf.team, side: cf.side, subject: cf.report.player_name,
        label: cf.team + ': quarterback input conflict', text: txt,
        short: 'the model expects ' + cf.model + ', but ' + cf.report.player_name + ' is listed as ' + String(cf.report.status).toLowerCase(),
        cite: { nums: [], words: [lastName(cf.report.player_name), 'model|report|lists|listed|' + String(cf.report.status).toLowerCase()], all: true },
        values: { model_starter: cf.model, reported: cf.report.player_name, status: cf.report.status },
        source: { id: 'input_audit', label: 'EdgeDesk input audit (model starter vs official availability report)' }, observed_at: [A.terminal, cf.at].filter(function (t) { return ts(t) != null; }).sort(function (a, b) { return ts(b) - ts(a); })[0] || null,
        verification: 'CONFLICTING', material: true
      }));
    });

    /* ---- results, records, schedule ---- */
    var finals = x.finals || {};
    var kick = ts(g.kickoff);
    var lastKick = { home: null, away: null };
    var confRec = {};
    ['home', 'away'].forEach(function (side) {
      var team = teams[side], prof = x.profiles && x.profiles[side];
      var opps = (prof && prof.opponents) || [];
      if (!opps.length) return;
      var w = 0, l = 0, cw = 0, cl = 0, confKnown = true;
      var rows = opps.map(function (o) {
        var f = finals[String(o.game_id)];
        var pf = o.points_for, pa = o.points_against, certified = false, where = null, t = null, conf = null;
        if (f && f.final) {
          var isHome = f.home === team;
          pf = isHome ? f.final.home_score : f.final.away_score; pa = isHome ? f.final.away_score : f.final.home_score;
          certified = true; where = f.neutral_site ? 'vs.' : (isHome ? 'vs.' : 'at'); t = ts(f.kickoff); conf = f.matchup_type === 'conference';
        } else {
          t = f ? ts(f.kickoff) : null;
          /* no certified final: it only blocks the conference record if it was a conference game */
          var oc = (x.rankings && x.rankings.by_name || {})[o.opponent];
          var myConf = side === 'home' ? gm.home_conference : gm.away_conference;
          if (oc && (!oc.conference || oc.conference === myConf)) confKnown = false;
        }
        if (!isNum(pf) || !isNum(pa)) return null;
        if (pf > pa) w++; else if (pa > pf) l++;
        if (conf) { if (pf > pa) cw++; else cl++; }
        return { opp: o.opponent, pf: pf, pa: pa, certified: certified, where: where, t: t, game_id: String(o.game_id) };
      }).filter(Boolean);
      rows.forEach(function (r) { if (r.t != null && r.t < (kick || now) && (lastKick[side] == null || r.t > lastKick[side])) lastKick[side] = r.t; });
      var recC = add(claim({
        topic: 'results', key: 'record:' + side, team: team, side: side, label: team + ' record',
        text: team + ' is ' + w + '–' + l + ' this season, scoring ' + f1(prof.scoring && isNum(prof.scoring.points_for_per_game) ? prof.scoring.points_for_per_game : rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length)
          + ' points per game and allowing ' + f1(rows.reduce(function (s, r) { return s + r.pa; }, 0) / rows.length) + '.',
        short: team + ' (' + w + '–' + l + ')',
        cite: { nums: [String(w), String(l)], words: [team] },
        values: { wins: w, losses: l, ppg: r1(rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length), papg: r1(rows.reduce(function (s, r) { return s + r.pa; }, 0) / rows.length) },
        source: { id: 'results', label: 'EdgeDesk results record (certified finals) and play-by-play scores', path: 'record/football/cfb_2026.json' }, observed_at: A.record,
        verification: 'VERIFIED_DATA', caveat: rows.every(function (r) { return r.certified; }) ? null : 'one or more scores are the play-by-play final, not a certified final'
      }));
      /* points per game must reproduce from the rows above, so recompute the text from them */
      recC.values.ppg = r1(rows.reduce(function (s, r) { return s + r.pf; }, 0) / rows.length);
      recC.text = team + ' is ' + w + '–' + l + ' this season, scoring ' + f1(recC.values.ppg) + ' points per game and allowing ' + f1(recC.values.papg) + '.';
      recC.cite = { nums: [String(w), String(l)], words: [team] };
      covered('recent_results', recC); covered('off_points', recC); covered('def_points', recC);
      if (confKnown && (cw + cl) > 0) confRec[side] = { w: cw, l: cl };
      rows.slice(-2).forEach(function (r) {
        var won = r.pf > r.pa;
        var rc = add(claim({
          topic: 'results', key: 'result:' + r.game_id + ':' + side, team: team, side: side, label: team + ' vs ' + r.opp,
          text: team + ' ' + (won ? 'beat ' : 'lost ') + (won ? '' : '') + score(r.pf, r.pa) + (won ? '' : '') + ' ' + (won ? '' : (r.where === 'at' ? 'at ' : 'to ')) + (won ? '' : r.opp) + (won ? r.opp + ' ' + score(r.pf, r.pa) : '') + (r.t ? ' on ' + dayMonth(r.t) : '') + '.',
          short: (won ? 'beat ' + r.opp + ' ' : 'lost ' + score(r.pf, r.pa) + ' ' + (r.where === 'at' ? 'at ' : 'to ') + r.opp) + (won ? score(r.pf, r.pa) : ''),
          cite: { nums: [String(Math.max(r.pf, r.pa)), String(Math.min(r.pf, r.pa))], words: [r.opp] },
          values: { opponent: r.opp, points_for: r.pf, points_against: r.pa, certified: r.certified },
          source: r.certified ? { id: 'results', label: 'Certified final (EdgeDesk results record)', path: 'record/football/cfb_2026.json' } : { id: 'profiles', label: 'Play-by-play final score', path: 'football/matchup/profiles_2026.json' },
          observed_at: r.certified ? A.record : A.profiles, verification: 'VERIFIED_DATA'
        }));
        /* a cleaner sentence than the concatenation above */
        rc.text = won ? team + ' beat ' + r.opp + ' ' + score(r.pf, r.pa) + (r.t ? ' on ' + dayMonth(r.t) : '') + '.'
          : team + ' lost ' + score(r.pf, r.pa) + ' ' + (r.where === 'at' ? 'at ' : 'to ') + r.opp + (r.t ? ' on ' + dayMonth(r.t) : '') + '.';
        covered('recent_results', rc);
      });
      /* who they have played: EdgeDesk ranks of the opponents (a proxy, not a schedule-strength number) */
      var ranked = rows.map(function (r) { var t = (x.rankings && x.rankings.by_name || {})[r.opp]; return t && isNum(t.rank) ? { opp: r.opp, rank: t.rank } : null; }).filter(Boolean);
      if (ranked.length >= 2) {
        var avg = ranked.reduce(function (s, r) { return s + r.rank; }, 0) / ranked.length;
        var top = ranked.filter(function (r) { return r.rank <= 25; });
        var oc2 = add(claim({
          topic: 'schedule', key: 'opponents:' + side, team: team, side: side, label: team + ': opponents faced',
          text: poss(team) + ' opponents so far have an average EdgeDesk rank of ' + Math.round(avg) + (top.length ? ', with ' + sentenceList(top.map(function (r) { return r.opp + ' (No. ' + r.rank + ')'; })) + ' inside the top 25' : ' and none inside the top 25') + '.',
          short: poss(team) + ' opponents average an EdgeDesk rank of ' + Math.round(avg),
          cite: { nums: [String(Math.round(avg))], words: ['opponents', 'schedule'] },
          values: { average_rank: Math.round(avg), opponents: ranked },
          source: { id: 'rankings', label: 'EdgeDesk national ranks of the opponents played', path: 'football/rankings/current.json' }, observed_at: A.rankings,
          verification: 'RATING', caveat: 'an average of current EdgeDesk ranks; EdgeDesk publishes no strength-of-schedule number'
        }));
        covered('opp_strength', oc2); covered('schedule_strength', oc2);
      }
    });
    if (confRec.home && confRec.away && gm.matchup_type === 'conference') {
      var cn = gm.home_conference || 'conference';
      var cc = add(claim({
        topic: 'conference', key: 'conference', team: null, label: cn + ' records',
        text: home + ' is ' + confRec.home.w + '–' + confRec.home.l + ' and ' + away + ' is ' + confRec.away.w + '–' + confRec.away.l + ' in ' + cn + ' play.',
        short: home + ' ' + confRec.home.w + '–' + confRec.home.l + ', ' + away + ' ' + confRec.away.w + '–' + confRec.away.l + ' in ' + cn + ' play',
        cite: { nums: [], words: [cn + ' play', 'conference'] },
        values: { home: confRec.home, away: confRec.away, conference: cn },
        source: { id: 'results', label: 'Certified finals (EdgeDesk results record)', path: 'record/football/cfb_2026.json' }, observed_at: A.record, verification: 'VERIFIED_DATA'
      }));
      covered('conference', cc);
    }
    /* rest */
    if (kick != null && lastKick.home != null && lastKick.away != null) {
      var dh = Math.round((kick - lastKick.home) / 86400000), da = Math.round((kick - lastKick.away) / 86400000);
      var more = dh > da ? home : (da > dh ? away : null);
      var rest = add(claim({
        topic: 'situational', key: 'rest', team: more, label: 'Rest',
        text: more ? more + ' comes in on ' + Math.max(dh, da) + ' days of rest' + (Math.max(dh, da) >= 13 ? ' after an open week' : '') + '; ' + (more === home ? away : home) + ' has had ' + Math.min(dh, da) + ' days.' : 'Both teams have had ' + dh + ' days since their last game.',
        short: more ? more + ' has ' + Math.max(dh, da) + ' days of rest to ' + Math.min(dh, da) : 'equal rest',
        cite: { nums: more ? [String(Math.max(dh, da))] : [String(dh)], words: ['rest', 'days', 'open week', 'bye'] },
        values: { home_days: dh, away_days: da },
        source: { id: 'results', label: 'Kickoff times of each team’s previous game', path: 'record/football/cfb_2026.json' }, observed_at: A.record,
        verification: 'VERIFIED_DATA', leans: more && Math.abs(dh - da) >= 5 ? more : null, strength: more && Math.abs(dh - da) >= 5 ? 'small' : null,
        caveat: (g.why && (g.why.rows || []).some(function (r) { return r.key === 'schedule' && Math.abs(r.points) < 0.05; })) ? 'EdgeDesk’s model gives rest no weight in this game' : null
      }));
      covered('rest_travel', rest);
    }
    /* home field: the model's number, and what the market has historically made of it */
    var hfaRow = ((g.why && g.why.rows) || []).filter(function (r) { return r.key === 'hfa'; })[0];
    var exPart = g.disagreement_explainer && (g.disagreement_explainer.parts || []).filter(function (p) { return p.key === 'home_field'; })[0];
    if (hfaRow && Math.abs(hfaRow.points) >= 0.5) {
      var priced = exPart && isNum(exPart.discount) ? clamp(1 - exPart.discount, 0, 1) : null;
      var hc = add(claim({
        topic: 'model', key: 'hfa', team: hfaRow.favors, label: 'Home field (model)',
        text: 'EdgeDesk’s model gives ' + home + ' ' + f1(hfaRow.points) + ' points for playing at home — a league-wide value, not one measured for this stadium' + (priced != null ? '; historically, the closing market has priced about ' + pct0(priced) + ' of EdgeDesk’s home-field number' : '') + '.',
        short: 'the model’s league-wide home-field value (' + f1(hfaRow.points) + ' points)',
        cite: { nums: [f1(hfaRow.points)], words: ['home'] },
        values: { points: r2(hfaRow.points), market_priced_share: priced },
        source: { id: 'cfb_terminal', label: 'EdgeDesk model terms and disagreement explainer', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal,
        verification: 'MODEL_OUTPUT'
      }));
      covered('home_field', hc);
    } else if (gm.neutral_site) {
      var nc = add(claim({ topic: 'situational', key: 'neutral', label: 'Neutral site', text: 'The game is at a neutral site' + (gm.venue ? ', ' + gm.venue : '') + ', so neither team gets home field.', short: 'a neutral site', cite: { nums: [], words: ['neutral'] }, source: { id: 'cfb_terminal', label: 'EdgeDesk schedule', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal, verification: 'VERIFIED_DATA' }));
      covered('home_field', nc);
    }
    /* weather */
    var fc = x.forecast;
    if (fc && !fc.dome && isNum(fc.temp_f)) {
      var material = (isNum(fc.wind_mph) && fc.wind_mph >= 15) || (isNum(fc.gust_mph) && fc.gust_mph >= 25) || (isNum(fc.precip_pct) && fc.precip_pct >= 60);
      var wc = add(claim({
        topic: 'situational', key: 'weather', label: 'Forecast',
        text: 'The kickoff forecast' + (fc.as_of ? ' (as of ' + dayMonth(ts(fc.as_of)) + ')' : '') + ' calls for ' + Math.round(fc.temp_f) + ' degrees' + (fc.text ? ' and ' + String(fc.text).toLowerCase() : '')
          + (isNum(fc.precip_pct) ? ' (' + Math.round(fc.precip_pct) + '% chance of rain)' : '') + (isNum(fc.wind_mph) ? ', with wind around ' + Math.round(fc.wind_mph) + ' mph' + (isNum(fc.gust_mph) && fc.gust_mph >= 20 ? ' and gusts near ' + Math.round(fc.gust_mph) : '') : '') + '.',
        short: Math.round(fc.temp_f) + ' degrees' + (fc.text ? ', ' + String(fc.text).toLowerCase() : '') + (isNum(fc.gust_mph) && fc.gust_mph >= 20 ? ', gusts near ' + Math.round(fc.gust_mph) + ' mph' : ''),
        cite: { nums: [String(Math.round(fc.temp_f))], words: ['forecast', 'degrees', 'wind', 'rain'] },
        values: { temp_f: fc.temp_f, wind_mph: fc.wind_mph, gust_mph: fc.gust_mph, precip_pct: fc.precip_pct, text: fc.text },
        source: { id: 'forecast', label: 'Open-Meteo kickoff-hour forecast', path: 'football/venues/forecasts.json' }, observed_at: fc.as_of || A.forecasts,
        verification: 'VERIFIED_DATA', material: material,
        caveat: 'a forecast, not an observation; EdgeDesk’s model moves no spread for weather'
      }));
      covered('weather', wc);
    } else if (fc && fc.dome) {
      covered('weather', add(claim({ topic: 'situational', key: 'weather', label: 'Indoors', text: 'The game is indoors, so weather is not a factor.', short: 'indoors', cite: { nums: [], words: ['indoors', 'dome'] }, source: { id: 'forecast', label: 'EdgeDesk venue table', path: 'football/venues/forecasts.json' }, observed_at: A.forecasts, verification: 'VERIFIED_DATA' })));
    }
    /* head-to-head: the archive, dated (historical, never current) */
    var h2h = (x.h2h || []).filter(function (r) { return isNum(r.home_points) && isNum(r.away_points); }).sort(function (a, b) { return (a.season - b.season) || ((ts(a.kickoff) || 0) - (ts(b.kickoff) || 0)); });
    if (h2h.length) {
      var lastM = h2h[h2h.length - 1];
      var hw = {}, n0 = h2h[0].season;
      h2h.forEach(function (r) { var wnr = r.home_points > r.away_points ? r.home : (r.away_points > r.home_points ? r.away : null); if (wnr) hw[wnr] = (hw[wnr] || 0) + 1; });
      var lw = lastM.home_points > lastM.away_points ? lastM.home : lastM.away, ll = lw === lastM.home ? lastM.away : lastM.home;
      var hc2 = add(claim({
        topic: 'history', key: 'h2h', team: null, label: 'Head-to-head',
        text: 'The last meeting, in ' + lastM.season + ', went to ' + lw + ', ' + score(lastM.home_points, lastM.away_points) + (lastM.neutral ? ' at a neutral site' : ' at ' + (lastM.home === lw ? 'home' : ll)) + '; in EdgeDesk’s archive of ' + h2h.length + ' meetings since ' + n0 + ', '
          + home + ' won ' + (hw[home] || 0) + ' and ' + away + ' won ' + (hw[away] || 0) + '. Those games were played by different rosters.',
        short: lw + ' won the last meeting, ' + score(lastM.home_points, lastM.away_points) + ', in ' + lastM.season,
        cite: { nums: [String(lastM.season)], words: ['meeting', 'met', 'series', 'last time'] },
        values: { last: { season: lastM.season, home: lastM.home, away: lastM.away, home_points: lastM.home_points, away_points: lastM.away_points }, meetings: h2h.length, wins: hw, since: n0 },
        scope: 'historical',
        source: { id: 'lines_archive', label: 'EdgeDesk college results-and-lines archive (2006–2025)', path: 'football/pricing/lines_cfb.json' }, observed_at: A.lines,
        verification: 'VERIFIED_DATA', caveat: 'historical results; rosters and coaches have changed'
      }));
      covered('head_to_head', hc2);
    }
    /* coaching and roster turnover (what the model weights differently) */
    ['home', 'away'].forEach(function (side) {
      var team = teams[side];
      var co = x.metrics && x.metrics[side] && x.metrics[side].coaching;
      var rg = g.edgedesk && g.edgedesk.regime && g.edgedesk.regime[side];
      if (co && co.new_hc) {
        var pc = add(claim({
          topic: 'personnel', key: 'coach:' + side, team: team, side: side, subject: co.hc,
          label: team + ': new head coach',
          text: team + ' is in its first season under head coach ' + co.hc + (rg && rg.reason && /returning roster share at the (\d+)/.test(rg.reason) ? ', with a returning roster share in the ' + rg.reason.match(/returning roster share at the (\d+\w*)/)[1] + ' percentile nationally' : '') + '.',
          short: poss(team) + ' first season under ' + co.hc,
          cite: { nums: [], words: [lastName(co.hc), 'first season|first year|returning|new coach|new head coach'], all: true },
          values: { hc: co.hc, regime: rg ? { weight: rg.weight, standard_weight: rg.standard_weight, reason: rg.reason } : null },
          source: { id: 'coaching', label: 'EdgeDesk coaching and roster-continuity data', path: 'football/coaching/continuity.json' }, observed_at: co.as_of || A.metrics,
          verification: 'VERIFIED_DATA'
        }));
        covered('injuries', pc);
      }
    });

    /* ---- outside reporting: the desk's facts ledger and notebook ---- */
    (x.facts || []).forEach(function (f) {
      var exp = ts(f.expires_at);
      if (exp != null && exp <= now) return;
      var status = f.verification === 'VERIFIED' ? 'VERIFIED_REPORT' : 'REPORTED';
      var c = add(claim({
        topic: f.kind === 'availability' ? 'injury' : (f.kind === 'result' ? 'results' : (f.kind === 'head_to_head' ? 'history' : (f.kind === 'preseason_note' ? 'preseason' : (f.kind === 'qb_stats' ? 'qb' : (f.topic || 'report'))))),
        key: 'fact:' + f.id, team: f.team || null, subject: f.subject || null,
        label: f.label || (f.subject || f.team || 'Report'),
        text: f.text, short: f.short || f.text,
        cite: f.cite || { nums: [], words: [f.subject ? lastName(f.subject) : (f.team || '')] },
        values: f.values || null,
        scope: f.scope || 'report',
        source: { id: 'facts', label: f.source && f.source.publisher || 'reporting', publisher: f.source && f.source.publisher, url: f.source && f.source.url, title: f.source && f.source.title, published_at: f.source && f.source.published_at, corroboration: f.corroboration || [] },
        observed_at: f.source && f.source.published_at || f.recorded_at,
        verification: status, leans: f.leans || null, strength: f.strength || null, material: !!f.material, status: f.status_designation || null,
        caveat: status === 'REPORTED' ? 'recorded from ' + (f.source && f.source.publisher || 'reporting') + '; not yet confirmed at the source by an EdgeDesk editor' : null
      }));
      if (f.covers) [].concat(f.covers).forEach(function (it) { covered(it, c); });
    });
    (x.notes || []).forEach(function (n) {
      var exp = ts(n.expires_at); if (exp != null && exp <= now) return;
      var c = add(claim({ topic: 'report', key: 'note:' + n.id, team: n.team || null, label: 'Desk note', text: n.text, cite: { nums: [], words: [n.text.split(' ').slice(0, 2).join(' ')] },
        source: { id: 'desk_notes', label: n.source, url: n.url, published_at: n.published_at }, observed_at: n.published_at, verification: 'REPORTED',
        caveat: 'desk note recorded by ' + n.recorded_by }));
      covered('injuries', c);
    });

    /* ---- the model and the market ---- */
    var model = modelOf(g), market = marketOf(g, now);
    var mclaims = modelClaims(g, model, market, x.record, A);
    mclaims.forEach(add);

    var packet = {
      schema: SCHEMA, version: VERSION, league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      key: 'cfb:' + g.season + ':' + g.game_id,
      home: home, away: away, kickoff: g.kickoff, venue: gm.venue || null, neutral_site: !!gm.neutral_site,
      built_at: iso(now), observed: A,
      model: model, market: market,
      claims: claims,
      coverage: coverageOf(cov, 'cfb', x),
      pairs: pairs.map(function (p) { return { key: p.key, offense: p.O, defense: p.D, edge: r2(p.edge), collision: r2(p.collision), favors: p.favors, claim: p.claim.id, sample: Math.round(p.sample) }; })
    };
    packet.explanation = explain(packet, g, x);
    finalize(packet);
    packet.inputs_hash = hash(JSON.stringify([g.built_at, A, (x.facts || []).map(function (f) { return f.id + (f.expires_at || ''); }), x.reports && [x.reports.home && x.reports.home.published_at, x.reports.away && x.reports.away.published_at]]));
    packet.hash = hash(JSON.stringify(packet.claims) + JSON.stringify(packet.explanation));
    return packet;
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function modelOf(g) {
    var e = g.edgedesk || {}, gm = g.game || {};
    if (!e.available || !isNum(e.fair_home_line)) return { available: false };
    var hl = r1(e.fair_home_line);
    var fav = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null);
    return {
      available: true, home_line: hl, favorite: fav, margin: r1(Math.abs(hl)),
      text: fav ? fav + ' by ' + f1(Math.abs(hl)) : 'a pick’em',
      home_win_prob: isNum(e.home_win_prob) ? r2(e.home_win_prob) : null,
      projected: e.projected_score && isNum(e.projected_score.home) ? { home: r1(e.projected_score.home), away: r1(e.projected_score.away) } : null,
      total: isNum(e.fair_total) ? r1(e.fair_total) : null, version: e.model_version || null, as_of: e.prediction_ts || null
    };
  }
  function marketOf(g, now) {
    var m = g.market || {}, gm = g.game || {};
    var best = null;
    (m.quotes || []).forEach(function (q) { var t = ts(q.observed_at); if (t == null || !isNum(q.home_line)) return; if (!best || t > best.t) best = { t: t, q: q }; });
    if (!best) return { status: 'none', comparable: false, reason: 'no captured line' };
    var age = Math.round((now - best.t) / 60000);
    var hl = r1(best.q.home_line);
    var fav = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null);
    var book = { draftkings: 'DraftKings', fanduel: 'FanDuel', 'cfbd consensus': 'CollegeFootballData consensus', betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN BET' }[String(best.q.book || '').toLowerCase()] || best.q.book || null;
    var mapping = ((g.market_check && g.market_check.checks) || []).filter(function (c) { return c.area === 'Mapping'; })[0];
    return {
      status: age <= STALE_MINUTES ? 'current' : 'stale', home_line: hl, favorite: fav, margin: r1(Math.abs(hl)),
      text: fav ? fav + ' -' + (Math.abs(hl) % 1 === 0 ? String(Math.abs(hl)) : Math.abs(hl).toFixed(1)) : 'pick’em',
      book: book, captured_at: iso(best.t),
      open_home_line: isNum(m.open_home_line) ? r1(m.open_home_line) : null,
      comparable: !(mapping && mapping.status === 'FAIL'),
      reason: age <= STALE_MINUTES ? 'a full-game spread captured within three hours' : 'a full-game spread captured more than three hours before this build: comparable, but not a current price'
    };
  }

  /* the model's own numbers about this game — never football evidence */
  function modelClaims(g, model, market, record, A) {
    var out = [], gm = g.game || {};
    var src = { id: 'cfb_terminal', label: 'EdgeDesk CFB research terminal', path: 'football/cfb_terminal/games.json' };
    if (model.available) {
      out.push(claim({ topic: 'model', key: 'projection', label: 'EdgeDesk projection', text: 'EdgeDesk’s model makes it ' + model.text + (model.projected ? ' (projected ' + f1(Math.max(model.projected.home, model.projected.away)) + '–' + f1(Math.min(model.projected.home, model.projected.away)) + ')' : '') + '.',
        short: 'EdgeDesk ' + model.text, cite: { nums: [f1(model.margin)], words: ['EdgeDesk', 'model', 'projection'] }, values: model, source: src, observed_at: model.as_of || A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    if (market.status !== 'none') {
      out.push(claim({ topic: 'market', key: 'market', label: 'Captured line', text: 'The ' + (market.status === 'current' ? 'current' : 'last captured') + ' line had ' + market.text + (market.book ? ' (' + market.book + ', captured ' + dayMonth(ts(market.captured_at)) + ')' : '') + '.',
        short: market.text, cite: { nums: [String(market.margin)], words: ['line', 'market', 'captured'] }, values: market, source: { id: 'market', label: market.book ? market.book + ' (captured line)' : 'captured line', path: 'football/cfb_lab/ledger/2026' },
        observed_at: market.captured_at, verification: 'MARKET_DATA', scope: 'market' }));
    }
    ((g.why && g.why.rows) || []).forEach(function (r) {
      if (!isNum(r.points) || Math.abs(r.points) < 0.3 || r.key === 'hfa') return;
      var lab = termLabel(r);
      out.push(claim({ topic: 'model', key: 'term:' + r.key, team: r.favors, label: 'Model term: ' + lab,
        text: 'In EdgeDesk’s model, ' + lab.toLowerCase() + ' is worth ' + f1(Math.abs(r.points)) + ' points toward ' + r.favors + '.',
        short: lab.toLowerCase() + ' (' + f1(Math.abs(r.points)) + ' points toward ' + r.favors + ')',
        cite: { nums: [f1(Math.abs(r.points))], words: [lab.split(' ')[0].toLowerCase(), r.favors] }, values: { points: r2(r.points), favors: r.favors }, source: src, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    });
    var ex = g.disagreement_explainer;
    var ourGap = model.available && market.status !== 'none' ? Math.abs(market.home_line - model.home_line) : null;
    if (ex && ex.available && isNum(ex.explained_points) && isNum(ex.gap_points) && Math.abs(ex.gap_points) > 0 && ourGap != null && ourGap >= MATERIAL_GAP) {
      /* the explainer's share, applied to the gap THIS article states (the explainer
         runs against the consensus line, which can differ by a few tenths) */
      var shareX = clamp(isNum(ex.share_explained) ? ex.share_explained : ex.explained_points / ex.gap_points, 0, 1);
      var gapP = r1(ourGap), expl = r1(gapP * shareX);
      out.push(claim({ topic: 'model', key: 'explainer', label: 'How much of the gap EdgeDesk can explain',
        text: 'EdgeDesk’s own breakdown of how the closing market has historically treated each piece of its number accounts for about ' + f1(expl) + ' of the ' + f1(gapP) + ' points between the model and the line.',
        short: 'EdgeDesk’s breakdown accounts for about ' + f1(expl) + ' of the ' + f1(gapP) + ' points',
        cite: { nums: [f1(expl)], words: ['account', 'explain', 'unexplained', 'traced', 'trace', 'breakdown'] }, values: { explained: expl, gap: gapP, share: r2(shareX), caveat: ex.caveat || null },
        source: { id: 'cfb_terminal', label: 'EdgeDesk disagreement explainer (fit 2021–2025)', path: 'football/cfb_terminal/games.json' }, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    var cons = g.consensus;
    if (cons && cons.available) {
      var others = (cons.rows || []).filter(function (r) { return r.key !== 'v1' && r.independent && isNum(r.home_margin); });
      if (others.length) {
        var lines = others.map(function (r) { return -r.home_margin; }).sort(function (a, b) { return a - b; });
        var medLine = lines.length % 2 ? lines[(lines.length - 1) / 2] : (lines[lines.length / 2 - 1] + lines[lines.length / 2]) / 2;
        var say = function (hl) { var fv = hl < -0.05 ? gm.home : (hl > 0.05 ? gm.away : null); return fv ? fv + ' by ' + f1(Math.abs(hl)) : 'a pick’em'; };
        out.push(claim({ topic: 'model', key: 'other_models', label: 'EdgeDesk’s other models',
          text: 'EdgeDesk’s ' + numWord(others.length) + ' other, independently built models have ' + sentenceList(lines.map(say)) + '.',
          short: 'EdgeDesk’s other models: ' + sentenceList(lines.map(say)),
          cite: { nums: [f1(Math.abs(lines[0]))], words: ['other', 'models'] }, values: { median_home_line: r1(medLine), models: others.map(function (r) { return { label: r.label, text: r.text }; }) },
          source: src, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
      }
    }
    var hist = g.historical && (g.historical.sets || [])[0];
    if (hist && isNum(hist.n) && hist.n >= 30) {
      out.push(claim({ topic: 'model', key: 'track_record', label: 'EdgeDesk’s record in similar spots',
        text: 'When EdgeDesk’s number has been this far from the closing line (' + String(hist.label).replace(/^EdgeDesk\s*/, '').replace(/ off the close$/, ' off') + '), the side it favored covered ' + hist.w + ' of ' + (hist.w + hist.l) + ' times (' + f1(hist.pct) + '%).',
        short: 'EdgeDesk ' + hist.w + '–' + hist.l + ' against the spread in similar spots',
        cite: { nums: [String(hist.w), String(hist.w + hist.l)], words: ['covered', 'record'] }, values: hist,
        scope: 'historical', source: { id: 'record', label: 'EdgeDesk’s public record, graded against the close', path: 'record/football/cfb_2026.json' }, observed_at: A.terminal, verification: 'MODEL_OUTPUT' }));
    }
    var fp = record && record.research && record.research.market;
    if (fp && fp.classification) {
      out.push(claim({ topic: 'model', key: 'classification', label: 'EdgeDesk’s own label for this gap', text: 'EdgeDesk’s game page labels this comparison “' + fp.classification + '”: ' + (fp.classification_note || '') ,
        short: 'labelled ' + fp.classification, cite: { nums: [], words: [String(fp.classification).toLowerCase().split(' ')[0]] }, values: { classification: fp.classification },
        source: { id: 'article_record', label: 'EdgeDesk game research page', path: 'articles/data/records/' }, observed_at: record.updated_at || null, verification: 'MODEL_OUTPUT' }));
    }
    return out;
  }

  /* the research items the brief asks for, and whether each was available */
  var COVERAGE = [
    ['qb_efficiency', 'Quarterback efficiency'], ['qb_completion', 'Completion rate'], ['qb_ypa', 'Yards per attempt'], ['qb_td_int', 'Touchdowns and interceptions'],
    ['qb_sacks', 'Sacks taken'], ['qb_trend', 'Recent quarterback form'], ['qb_availability', 'Quarterback availability'],
    ['off_points', 'Points per game'], ['off_efficiency', 'Offensive efficiency'], ['off_rush_pass', 'Rushing and passing production'], ['off_explosive', 'Explosive plays'],
    ['off_third', 'Third-down conversion'], ['off_red_zone', 'Red-zone production'], ['off_line', 'Offensive-line performance'], ['opp_strength', 'Recent opponent strength'],
    ['def_points', 'Points allowed'], ['def_rush_pass', 'Rushing and passing defense'], ['def_pressure', 'Pressure and sacks'], ['def_explosive', 'Explosive plays allowed'],
    ['def_third', 'Third-down defense'], ['def_red_zone', 'Red-zone defense'], ['position_groups', 'Position-group advantages'], ['turnovers', 'Turnover rates'],
    ['home_field', 'Home field'], ['recent_results', 'Recent results'], ['schedule_strength', 'Strength of schedule'], ['head_to_head', 'Historical meetings'],
    ['injuries', 'Injuries and personnel'], ['rest_travel', 'Rest and travel'], ['weather', 'Weather'], ['conference', 'Conference implications'], ['penalties', 'Penalty rate']
  ];
  var MISSING_WHY = {
    penalties: 'EdgeDesk holds no current-season penalty data for this league',
    turnovers: 'the play-by-play feed does not attribute fumbles reliably, so turnover rates are not used (quarterback interceptions are)',
    schedule_strength: 'EdgeDesk publishes no strength-of-schedule number; opponent ranks are shown instead where available',
    head_to_head: 'no prior meeting in EdgeDesk’s results archive',
    conference: 'not a conference game, or a conference record could not be certified',
    weather: 'no forecast on file',
    rest_travel: 'previous-game kickoff times not on file',
    off_third: 'no third-down data for this league', def_third: 'no third-down data for this league',
    off_red_zone: 'no red-zone data for this league', def_red_zone: 'no red-zone data for this league'
  };
  function coverageOf(cov, league, x) {
    return COVERAGE.map(function (it) {
      var ids = uniq(cov[it[0]] || []);
      var proxy = it[0] === 'schedule_strength' && ids.length;
      return { item: it[0], label: it[1], status: ids.length ? (proxy ? 'PROXY' : 'AVAILABLE') : 'MISSING', claims: ids, why: ids.length && !proxy ? null : (MISSING_WHY[it[0]] || 'not in EdgeDesk’s verified data for this game') };
    });
  }

  /* ======================================================================
     EXPLAIN — the model against the market, in football terms
     ====================================================================== */
  var WEIGHT = { large: 3, moderate: 2, small: 1 };
  function explain(packet, g, x) {
    var model = packet.model, market = packet.market;
    var home = packet.home, away = packet.away;
    var C = packet.claims;
    var byId = {}; C.forEach(function (c) { byId[c.id] = c; });
    var out = { status: null, actionable: false, input_suspect: false, input_flags: [], supporting: [], contradicting: [], uncertainty: [], what_must_happen: [], game_script: { model_case: [], market_case: [] } };
    if (!model.available) { out.status = 'NO_PROJECTION'; out.assessment = 'EdgeDesk has no projection for this game.'; return out; }
    out.projection = { text: model.text, home_line: model.home_line };
    if (market.status === 'none' || !market.comparable) {
      out.status = 'NO_COMPARABLE_MARKET';
      out.market = { status: market.status, text: null };
      out.assessment = 'There is no verified comparable market line on file, so there is no disagreement to explain.';
    } else {
      out.market = { status: market.status, text: market.text, book: market.book, captured_at: market.captured_at, home_line: market.home_line, comparable_reason: market.reason };
    }
    var gap = out.market && out.market.text ? Math.abs(market.home_line - model.home_line) : null;
    /* toward: the team the model likes MORE than the market does */
    var towardSide = gap == null ? null : (market.home_line - model.home_line > 0 ? 'home' : 'away');
    var T = towardSide ? packet[towardSide] : null, O = towardSide ? packet[towardSide === 'home' ? 'away' : 'home'] : null;
    if (gap != null) out.gap = { points: r1(gap), toward: T, other: O, toward_side: towardSide, size: gap >= MAJOR_GAP ? 'major' : gap >= 5 ? 'notable' : gap >= MATERIAL_GAP ? 'moderate' : 'minor' };

    /* model terms */
    out.model_terms = ((g.why && g.why.rows) || []).filter(function (r) { return isNum(r.points) && Math.abs(r.points) >= 0.05; }).map(function (r) {
      return { key: r.key, label: termLabel(r), points: r2(Math.abs(r.points)), favors: r.favors, toward_gap: T ? r.favors === T : null };
    });
    var ex = g.disagreement_explainer;
    if (ex && ex.available && isNum(ex.explained_points) && isNum(ex.gap_points) && Math.abs(ex.gap_points) > 0) {
      var share = clamp(isNum(ex.share_explained) ? ex.share_explained : ex.explained_points / ex.gap_points, 0, 1);
      var gapN = gap != null ? gap : Math.abs(ex.gap_points);
      out.mechanical = { share: r2(share), explained_points: r1(r1(gapN) * share), unexplained_points: r1(r1(gapN) - r1(r1(gapN) * share)),
        parts: (ex.parts || []).filter(function (p) { return p.significant && isNum(p.explained_points) && Math.abs(p.explained_points) >= 0.3; }).map(function (p) { return { key: p.key, label: p.label, points: r1(p.explained_points) }; }),
        basis: ex.caveat || null };
    }
    out.market_implied = g.why && g.why.market_implied && g.why.market_implied.text || null;

    /* football balance: measured claims leaning toward T support the model's side of the gap */
    if (T) {
      C.forEach(function (c) {
        if (!c.football || !c.leans || !c.strength || c.component) return;
        if (c.leans === T) out.supporting.push(c.id); else if (c.leans === O) out.contradicting.push(c.id);
      });
      var w = function (ids) { return ids.reduce(function (s, id) { var c = byId[id]; return s + (WEIGHT[c.strength] || 0) * (c.measured ? 1 : 0.5) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1); }, 0); };
      var rankOf = function (c) { return (WEIGHT[c.strength] || 0) * (c.measured ? 1 : 0.6) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1) + (c.topic === 'matchup' ? 0.1 : 0); };
      var sortIds = function (ids) { return ids.sort(function (a, b) { return rankOf(byId[b]) - rankOf(byId[a]); }); };
      sortIds(out.supporting); sortIds(out.contradicting);
      out.football_balance = { supporting: r1(w(out.supporting)), contradicting: r1(w(out.contradicting)) };
      out.football_balance.score = r1(out.football_balance.supporting - out.football_balance.contradicting);
      /* the model's own reasons to doubt itself */
      ['track_record', 'other_models', 'explainer'].forEach(function (k) {
        var c = C.filter(function (y) { return y.key === k; })[0]; if (!c) return;
        if (k === 'track_record' && c.values && isNum(c.values.pct) && c.values.pct < 52.4) out.contradicting.push(c.id);
        if (k === 'other_models' && c.values && isNum(c.values.median_home_line) && Math.abs(c.values.median_home_line - market.home_line) < Math.abs(model.home_line - market.home_line) - 1) out.contradicting.push(c.id);
        if (k === 'explainer' && out.mechanical && out.mechanical.share < 0.35) out.contradicting.push(c.id);
      });
    }

    /* the input audit: is the gap a data problem rather than football? */
    function flag(key, severity, text, ids) { out.input_flags.push({ key: key, severity: severity, text: text, claims: ids || [] }); }
    if (market.status === 'stale') flag('STALE_MARKET', 'info', 'The only line on file was captured ' + (market.captured_at ? dayMonth(ts(market.captured_at)) : 'more than three hours before this build') + ', so the market may have moved.');
    C.filter(function (c) { return c.verification === 'CONFLICTING' && c.topic === 'input'; }).forEach(function (c) { flag('QB_INPUT_CONFLICT', 'high', c.text, [c.id]); });
    var dc = C.filter(function (c) { return c.topic === 'data' && c.verification === 'CONFLICTING'; });
    if (dc.length) flag('DATA_CONFLICT', 'medium', 'EdgeDesk’s own sources disagree on ' + sentenceList(dc.map(function (c) { return c.label.replace(/ \(sources disagree\)$/, '').toLowerCase() + ' (' + c.team + ')'; })) + '; the evidence uses the corroborated figures, and any model term built on the play-by-play figure may be off.', dc.map(function (c) { return c.id; }));
    var inj = ((g.why && g.why.rows) || []).filter(function (r) { return r.key === 'injury' && isNum(r.points) && Math.abs(r.points) >= 2; })[0];
    if (inj) {
      var hurt = inj.favors === home ? away : home, hs = hurt === home ? 'home' : 'away';
      var q = g.qb && g.qb[hs];
      var outQb = C.filter(function (c) { return c.team === hurt && c.topic === 'injury' && c.values && c.values.position === 'QB' && c.status === 'OUT'; })[0];
      var repl = outQb ? C.filter(function (c) { return c.team === hurt && /^(qb_season):/.test(c.key) && c.subject !== outQb.subject; })[0] : null;
      if (outQb) flag('QB_REPLACEMENT_GENERIC', 'medium', 'The availability report lists ' + outQb.subject + ' out, and EdgeDesk’s main model subtracts a generic quarterback absence (' + f1(Math.abs(inj.points)) + ' points) from ' + hurt + ' — it does not price the replacement’s own play' + (repl ? ' (' + repl.short + ')' : '') + '.', [outQb.id].concat(repl ? [repl.id] : []));
      else if (q && (q.contested || q.status === 'COMPETITION')) flag('QB_ABSENCE_APPLIED', 'high', 'EdgeDesk’s main model subtracts a full quarterback absence (' + f1(Math.abs(inj.points)) + ' points) from ' + hurt + ', while its own play-by-play shows ' + poss(hurt) + ' job shared rather than vacant and no official report confirms an absence. The replacement’s measured play is not priced.');
    }
    var cons = g.consensus;
    if (cons && cons.available) {
      var others = (cons.rows || []).filter(function (r) { return r.key !== 'v1' && r.independent && isNum(r.home_margin); });
      if (others.length >= 2) {
        var med = others.map(function (r) { return -r.home_margin; }).sort(function (a, b) { return a - b; })[Math.floor(others.length / 2)];
        var d = Math.abs(med - model.home_line);
        if (d >= 3) flag('CROSS_MODEL_OUTLIER', d >= 6 ? 'high' : 'medium', 'EdgeDesk’s published number sits ' + f1(d) + ' points from the middle of its own other models.');
      }
    }
    var fp = x && x.record && x.record.research && x.record.research.market;
    if (fp && /DATA FAULT/.test(String(fp.classification || ''))) flag('DATA_FAULT', 'high', 'EdgeDesk’s game page already labels this gap a DATA FAULT: ' + String(fp.classification_note || 'a gap larger than any real disagreement explains').replace(/\.\s*$/, '') + '.');
    var hfa = C.filter(function (c) { return c.key === 'hfa'; })[0];
    if (hfa && hfa.values && hfa.values.points >= 3.5 && isNum(hfa.values.market_priced_share) && hfa.values.market_priced_share < 0.8 && T && hfa.team === T) flag('HFA_CONSTANT', 'medium', hfa.text, [hfa.id]);
    var rg = g.edgedesk && g.edgedesk.regime;
    ['home', 'away'].forEach(function (s) { var r = rg && rg[s]; if (r && r.applied) flag('REGIME_CHANGE', 'medium', packet[s] + ': ' + String(r.why || r.reason).replace(/^REGIME CHANGE:\s*/i, ''), []); });
    if (g.games_played && isNum(g.games_played.min) && g.games_played.min <= 4) flag('THIN_SAMPLE', 'medium', 'One team has played only ' + g.games_played.min + ' games; ratings this early carry wide error.');
    out.input_suspect = out.input_flags.some(function (f) { return f.severity === 'high'; });

    /* status */
    if (!out.status) {
      if (gap < MATERIAL_GAP) { out.status = 'NO_MATERIAL_DISAGREEMENT'; }
      else {
        var share2 = out.mechanical ? out.mechanical.share : null;
        var fb = out.football_balance ? out.football_balance.score : 0;
        if (share2 != null && share2 >= 0.7) out.status = 'EXPLAINED';
        else if ((share2 != null && share2 >= 0.35) || fb > 0) out.status = 'PARTIALLY_EXPLAINED';
        else out.status = 'UNEXPLAINED';
        if (gap >= MAJOR_GAP && out.status !== 'EXPLAINED' && fb <= 2) out.status = 'UNEXPLAINED';
      }
    }
    out.actionable = false;
    out.actionable_reason = 'EdgeDesk’s articles are research. A gap is never presented as a bet; ' + (market.status !== 'current' ? 'the only line on file is not a current price; ' : '') + (out.status === 'UNEXPLAINED' ? 'and this gap is unexplained.' : 'any betting decision belongs to EdgeDesk’s decision engine, at a live price.');

    /* the critical matchup: strength against strength, else the biggest mismatch */
    var P = packet.pairs || [];
    var strong = P.filter(function (p) { return p.collision >= 0.15 && p.sample >= 40 && p.key !== 'turnovers'; }).sort(function (a, b) { return b.collision - a.collision; });
    var mism = P.filter(function (p) { return p.favors && p.sample >= 40; }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); });
    var crit = strong[0] || mism[0] || null;
    if (crit) {
      var qbO = qbNameFor(packet, crit.offense);
      var def = PAIRS[crit.key];
      /* NFL teams read as “the Bengals”; possessives follow the name (Ole Miss’, the Bengals’) */
      var nm = function (t) { return packet.league === 'nfl' ? 'the ' + String(t).split(' ').slice(-1)[0] : t; };
      var fill = function (t, qbDefault) { return t.replace(/\{D\}’s/g, poss(nm(crit.defense))).replace(/\{O\}’s/g, poss(nm(crit.offense))).replace(/\{D\}/g, nm(crit.defense)).replace(/\{O\}/g, nm(crit.offense)).replace(/\{QB\}/g, qbO || qbDefault); };
      /* sentence case for the body: the template's own words lower-cased, names kept */
      var sentenceCase = def.q.split(' ').map(function (w, i) { return i === 0 || /\{/.test(w) ? w : w.toLowerCase(); }).join(' ');
      out.critical_matchup = { key: crit.key, offense: crit.offense, defense: crit.defense, claim: crit.claim, why: strong[0] === crit ? 'strength against strength' : 'the biggest mismatch',
        question: fill(def.q, poss(nm(crit.offense)) + ' Quarterback').replace(qbO || '\u0000', qbO ? lastName(qbO) : ''), question_text: fill(sentenceCase, poss(nm(crit.offense)) + ' quarterback'),
        watch: fill(def.watch, poss(nm(crit.offense)) + ' quarterback'), text: byId[crit.claim] ? byId[crit.claim].text : null };
      out.headline_question = out.critical_matchup.question;
    }

    /* the game script each number needs: a full line with the evidence, and
       the same condition as a short unit (the first-party scorecard) */
    if (T) {
      var tOff = mism.filter(function (p) { return p.favors === T; }).slice(0, 2);
      var oOff = mism.filter(function (p) { return p.favors === O; }).slice(0, 2);
      var MC = [], KC = [];
      var push = function (list, line, unit) { if (line && !list.some(function (x) { return x.line === line; })) list.push({ line: line, unit: unit }); };
      if (crit) push(MC, scriptLine(crit, T, byId, 'win'), unitLine(crit, T, 'win'));
      oOff.forEach(function (p) { if (p !== crit) push(MC, scriptLine(p, T, byId, 'neutralize'), unitLine(p, T, 'neutralize')); });
      tOff.forEach(function (p) { if (p !== crit) push(MC, scriptLine(p, T, byId, 'win'), unitLine(p, T, 'win')); });
      var tqb = statusLine(packet, T);
      if (tqb) push(MC, tqb, poss(T) + ' quarterback question breaks its way');
      if (hfa && hfa.team === T) push(MC, 'Home field has to be worth something close to the full ' + f1(hfa.values.points) + ' points EdgeDesk gives it.', 'home field worth close to the full ' + f1(hfa.values.points) + ' points the model gives it');
      oOff.forEach(function (p) { push(KC, scriptLine(p, O, byId, 'win'), unitLine(p, O, 'win')); });
      if (crit) push(KC, scriptLine(crit, O, byId, 'win'), unitLine(crit, O, 'win'));
      var oqb = qbSeasonClaim(packet, O);
      if (oqb) push(KC, lastName(oqb.subject) + ' keeps producing at his season rate (' + oqb.short.replace(/^[^:]+:\s*/, '') + ').', lastName(oqb.subject) + ' plays to his season form');
      MC = MC.slice(0, 4); KC = KC.slice(0, 3);
      out.game_script.model_case = MC.map(function (x) { return x.line; });
      out.game_script.market_case = KC.map(function (x) { return x.line; });
      out.game_script.units = { model: MC.map(function (x) { return x.unit; }), market: KC.map(function (x) { return x.unit; }) };
      out.what_must_happen = out.game_script.model_case.slice();
    }

    /* unresolved uncertainty */
    C.forEach(function (c) {
      if (c.topic === 'qb_status' && c.values && c.values.contested) out.uncertainty.push(c.short + '.');
      if (c.topic === 'qb_status' && c.status === 'PREVIOUS_GAME') out.uncertainty.push(c.subject + ' has not been confirmed as ' + poss(c.team) + ' starter.');
      if (c.topic === 'injury' && c.material && /QUESTIONABLE|DOUBTFUL/.test(c.status || '')) out.uncertainty.push(c.text);
      if (c.verification === 'CONFLICTING' && c.topic === 'input') out.uncertainty.push(cap(c.short) + '.');
      if (c.key === 'weather' && c.material) out.uncertainty.push('Weather: ' + c.short + '.');
    });
    if (dc.length) out.uncertainty.push('EdgeDesk’s own sources disagree on ' + sentenceList(uniq(dc.map(function (c) { return c.label.replace(/ \(sources disagree\)$/, '').toLowerCase(); }))) + ' for ' + sentenceList(uniq(dc.map(function (c) { return c.team; }))) + '.');
    var miss = (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return c.label.toLowerCase(); });
    if (miss.length) out.uncertainty.push('Not in EdgeDesk’s verified data for this game: ' + sentenceList(miss) + '.');
    if (market.status === 'stale') out.uncertainty.push('The line on file was captured ' + (market.captured_at ? dayMonth(ts(market.captured_at)) : 'more than three hours ago') + ' and may have moved.');
    out.uncertainty = uniq(out.uncertainty);

    /* thesis and assessment, in plain words */
    var termsTxt = (out.model_terms || []).filter(function (t) { return t.points >= 1; }).sort(function (a, b) { return b.points - a.points; }).slice(0, 3)
      .map(function (t) { return t.label.toLowerCase() + ' (' + f1(t.points) + ' points toward ' + t.favors + ')'; });
    if (out.gap && out.gap.points >= MATERIAL_GAP) {
      out.thesis = 'EdgeDesk’s model makes it ' + model.text + '; the ' + (market.status === 'current' ? 'current' : 'last captured') + ' line had ' + market.text + '. That is ' + f1(out.gap.points) + ' points closer to ' + T + ' than the market. '
        + (termsTxt.length ? 'The model’s biggest pieces are ' + sentenceList(termsTxt) + '. ' : '')
        + 'Those are the model’s mechanics, not football reasons in themselves.';
    } else if (out.gap) {
      out.thesis = 'EdgeDesk’s model (' + model.text + ') and the ' + (market.status === 'current' ? 'current' : 'last captured') + ' line (' + market.text + ') largely agree; the interest here is the football, not a disagreement.';
    } else out.thesis = 'EdgeDesk’s model makes it ' + model.text + '.';
    var flagsHigh = out.input_flags.filter(function (f) { return f.severity === 'high'; });
    if (out.status === 'UNEXPLAINED') {
      out.assessment = 'UNEXPLAINED. EdgeDesk’s number is ' + f1(out.gap.points) + ' points closer to ' + T + ' than the line, and EdgeDesk cannot account for most of that'
        + (out.mechanical ? ': its own breakdown accounts for about ' + f1(out.mechanical.explained_points) + ' of the ' + f1(out.gap.points) + ' points' : '') + '. '
        + (out.football_balance && out.football_balance.score < 0 ? 'The measured football evidence leans toward ' + O + ', not toward EdgeDesk’s number. ' : '')
        + (flagsHigh.length ? 'There is a specific reason to suspect EdgeDesk’s inputs: ' + flagsHigh[0].text + ' ' : '')
        + 'Treat the gap as an open research question, not as an edge.';
    } else if (out.status === 'PARTIALLY_EXPLAINED') {
      out.assessment = 'PARTIALLY EXPLAINED. Some measured evidence supports EdgeDesk’s lean toward ' + T + (out.mechanical ? ', and its own breakdown accounts for about ' + f1(out.mechanical.explained_points) + ' of the ' + f1(out.gap.points) + ' points' : '') + ', but not the full gap. '
        + (flagsHigh.length ? 'Input warning: ' + flagsHigh[0].text + ' ' : '') + 'It is a research question, not a bet.';
    } else if (out.status === 'EXPLAINED') {
      var main = out.mechanical && out.mechanical.parts && out.mechanical.parts.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      out.assessment = 'EXPLAINED. Most of the ' + f1(out.gap.points) + '-point difference traces to ' + (main ? main.label + ' (about ' + f1(Math.abs(main.points)) + ' points)' : 'identifiable pieces of EdgeDesk’s number')
        + ', which the closing market has historically priced differently. That explains the gap; it does not make either number a bet.';
    } else if (out.status === 'NO_MATERIAL_DISAGREEMENT') {
      out.assessment = 'No material disagreement: EdgeDesk and the line are within ' + f1(out.gap.points) + ' points.';
    }
    return out;
  }
  function qbNameFor(packet, team) {
    var st = packet.claims.filter(function (c) { return c.topic === 'qb_status' && c.team === team; })[0];
    if (st && st.values && !st.values.contested) return st.subject;
    var conf = packet.claims.filter(function (c) { return c.topic === 'injury' && c.team === team && c.values && c.values.position === 'QB' && /PROBABLE|AVAILABLE/.test(c.status || ''); })[0];
    return conf ? conf.subject : (st ? null : null);
  }
  function qbSeasonClaim(packet, team) {
    return packet.claims.filter(function (c) { return c.team === team && /^qb_season:/.test(c.key); })[0] || null;
  }
  function statusLine(packet, team) {
    var cf = packet.claims.filter(function (c) { return c.verification === 'CONFLICTING' && c.topic === 'input' && c.team === team; })[0];
    if (cf) return team + ' needs its quarterback question answered in its favor: ' + cf.short + '.';
    var st = packet.claims.filter(function (c) { return c.topic === 'qb_status' && c.team === team && c.values && c.values.contested; })[0];
    if (st) return poss(team) + ' quarterback situation has to settle: ' + st.short + '.';
    return null;
  }
  var WHERE = { protection: 'in the pass-rush matchup', pass: 'through the air', rush: 'on the ground', early_downs: 'on early downs', third_down: 'on third down',
    red_zone: 'in the red zone', explosive_pass: 'on big pass plays', explosive_rush: 'on long runs', turnovers: 'in the turnover battle', run_blocking: 'at the line of scrimmage', efficiency: 'down to down' };
  /* the same condition as a short unit, no figures (they are in the evidence) */
  function unitLine(p, forTeam, mode) {
    var P = PAIRS[p.key], where = WHERE[p.key] || 'in ' + (P && P.label || p.key), isOff = forTeam === p.offense;
    if (mode === 'neutralize') return isOff ? poss(p.offense) + ' offense holds its own ' + where : poss(p.defense) + ' defense slows ' + p.offense + ' ' + where;
    return isOff ? poss(p.offense) + ' offense wins ' + where : poss(p.defense) + ' defense wins ' + where;
  }
  /* one line of the game script: what `forTeam` must do in pair p.
     mode 'win' (its own strength), 'neutralize' (the other side's strength) */
  function scriptLine(p, forTeam, byId, mode) {
    var c = byId[p.claim]; if (!c) return null;
    var v = c.values || {}, P = PAIRS[p.key], where = WHERE[p.key] || 'in ' + (P && P.label || p.key);
    var isOff = forTeam === p.offense;
    if (!P || !isNum(v.offense) || !isNum(v.defense)) {
      /* rank-based (NFL) pairs */
      return mode === 'neutralize' ? (isOff ? 'The ' + p.offense + ' have to hold their own ' + where + ' (' + c.short + ').' : 'The ' + p.defense + ' have to slow the ' + p.offense + ' ' + where + ' (' + c.short + ').')
        : (isOff ? 'The ' + p.offense + ' have to win ' + where + ' (' + c.short + ').' : 'The ' + p.defense + ' have to win ' + where + ' (' + c.short + ').');
    }
    var offTxt = METRICS[P.off].phrase.replace('{v}', metricText(P.off, v.offense));
    var defTxt = METRICS[P.def].phrase.replace('{v}', metricText(P.def, v.defense));
    if (mode === 'neutralize') {
      return isOff ? poss(p.offense) + ' offense has to hold its own ' + where + ' against a defense that ' + defTxt + '.'
        : poss(p.defense) + ' defense has to slow ' + p.offense + ' ' + where + ' — ' + poss(p.offense) + ' offense ' + offTxt + '.';
    }
    return isOff ? poss(p.offense) + ' offense has to keep winning ' + where + ': it ' + offTxt + ', and ' + poss(p.defense) + ' defense ' + defTxt + '.'
      : poss(p.defense) + ' defense has to come out ahead ' + where + ': it ' + defTxt + ', against an offense that ' + offTxt + '.';
  }

  /* ======================================================================
     BUILD — NFL (the slate, its team ratings and results, the official
     injury report, nflverse team-week stats)
     x: { game (slate game), teams (slate.teams), injuries, teamWeeks
          {CODE: [rows]}, h2h, facts, notes, as_of {...} }
     ====================================================================== */
  var NFL_RANKS = [
    ['off_epa_play', 'offense', 'offense', 'offense', 'efficiency per play'], ['def_epa_play', 'defense', 'defense', 'defense', 'efficiency allowed per play'],
    ['pass_epa_db', 'offense', 'off_rush_pass', 'passing offense', 'passing efficiency'], ['rush_epa_att', 'offense', 'off_rush_pass', 'running game', 'rushing efficiency'],
    ['def_pass_epa_db', 'defense', 'def_rush_pass', 'pass defense', 'pass defense'], ['def_rush_epa_att', 'defense', 'def_rush_pass', 'run defense', 'run defense'],
    ['sack_rate_all', 'line', 'off_line', 'pass protection', 'sack rate allowed'], ['sack_rate_made', 'pressure', 'def_pressure', 'pass rush', 'sack rate'],
    ['expl_pass', 'offense', 'off_explosive', 'explosive passing', 'explosive pass rate'], ['def_expl_pass', 'defense', 'def_explosive', 'explosive passes allowed', 'explosive passes allowed'],
    ['pts_for', 'offense', 'off_points', 'scoring offense', 'points scored'], ['pts_against', 'defense', 'def_points', 'scoring defense', 'points allowed']
  ];
  function buildNfl(x, opts) {
    opts = opts || {};
    var g = x.game || {}, now = isNum(opts.now) ? opts.now : Date.now();
    var A = x.as_of || {};
    var home = g.home_team, away = g.away_team, teams = { home: home, away: away }, codes = { home: g.home_code, away: g.away_code };
    var claims = [], cov = {};
    function add(c) { if (c && claims.every(function (y) { return y.id !== c.id; })) claims.push(c); return c; }
    function covered(item, c) { (cov[item] = cov[item] || []).push(c.id); }
    var TT = x.teams || {};
    var srcSlate = { id: 'nfl_slate', label: 'EdgeDesk NFL team ratings (2026)', path: 'football/nfl/slate.json' };
    /* unit ranks */
    ['home', 'away'].forEach(function (side) {
      var t = TT[codes[side]]; if (!t || !t.ranks) return;
      NFL_RANKS.forEach(function (r) {
        var rk = t.ranks[r[0]]; if (!rk || !isNum(rk.rank)) return;
        var good = rk.rank <= 8, bad = rk.rank >= 25;
        var c = add(claim({
          topic: r[1], key: 'rank:' + r[0], team: teams[side], side: side, label: cap(r[4]),
          text: poss(teams[side]) + ' ' + r[3] + ' ranks No. ' + rk.rank + ' of ' + (rk.of || 32) + ' in ' + r[4] + ' this season.',
          short: poss(teams[side]) + ' ' + r[3] + ' (No. ' + rk.rank + ')',
          cite: { nums: [String(rk.rank)], words: [r[3].split(' ')[0], r[4].split(' ')[0]] },
          values: { rank: rk.rank, of: rk.of || 32 },
          source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA',
          leans: good ? teams[side] : (bad ? teams[side === 'home' ? 'away' : 'home'] : null),
          strength: rk.rank <= 4 || rk.rank >= 29 ? 'moderate' : (good || bad ? 'small' : null)
        }));
        covered(r[2], c);
      });
    });
    /* matchups from ranks: offense unit vs the other defense */
    var NPAIRS = [['pass_epa_db', 'def_pass_epa_db', 'pass', 'the passing game against the pass defense'], ['rush_epa_att', 'def_rush_epa_att', 'rush', 'the run game against the run defense'], ['sack_rate_all', 'sack_rate_made', 'protection', 'pass protection against the pass rush']];
    var pairs = [];
    ['home', 'away'].forEach(function (oside) {
      var dside = oside === 'home' ? 'away' : 'home', to = TT[codes[oside]], td = TT[codes[dside]];
      if (!to || !td || !to.ranks || !td.ranks) return;
      NPAIRS.forEach(function (np) {
        var a = to.ranks[np[0]], b = td.ranks[np[1]]; if (!a || !b || !isNum(a.rank) || !isNum(b.rank)) return;
        var go = (16.5 - a.rank) / 16, gd = (16.5 - b.rank) / 16, edge = go - gd;
        var O = teams[oside], D = teams[dside];
        var favors = Math.abs(edge) >= 0.5 ? (edge > 0 ? O : D) : null;
        var c = add(claim({ topic: 'matchup', key: 'pair:' + np[2] + ':' + oside, team: O, side: oside, label: cap(np[3]),
          text: 'When ' + O + ' have the ball: their ' + np[3].replace(/^the /, '').split(' against ')[0] + ' ranks No. ' + a.rank + ', and ' + poss(D) + ' ' + np[3].split(' against the ')[1] + ' ranks No. ' + b.rank + '.',
          short: poss(O) + ' No. ' + a.rank + ' ' + np[3].split(' against ')[0].replace(/^the /, '') + ' against ' + poss(D) + ' No. ' + b.rank + ' ' + np[3].split(' against the ')[1],
          cite: { nums: [String(a.rank), String(b.rank)], words: np[2] === 'protection' ? ['protection', 'pass rush', 'sack'] : (np[2] === 'pass' ? ['pass'] : ['run', 'rush']) },
          values: { offense_rank: a.rank, defense_rank: b.rank, edge: r2(edge) }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA',
          leans: favors, strength: favors ? (Math.abs(edge) >= 1 ? 'large' : Math.abs(edge) >= 0.75 ? 'moderate' : 'small') : null }));
        pairs.push({ key: np[2], offense: O, defense: D, edge: r2(edge), collision: r2(Math.min(go, gd)), favors: favors, claim: c.id, sample: 100 });
      });
    });
    /* team passing from nflverse team-week stats (completion %, YPA, TD, INT, sacks) and penalties */
    ['home', 'away'].forEach(function (side) {
      var rows = (x.teamWeeks && x.teamWeeks[codes[side]]) || [];
      if (!rows.length) return;
      var s = function (k) { return rows.reduce(function (a, r) { return a + (+r[k] || 0); }, 0); };
      var att = s('attempts'), cmp = s('completions'), yds = s('passing_yards'), td = s('passing_tds'), ints = s('passing_interceptions'), sk = s('sacks_suffered'), pen = s('penalties'), peny = s('penalty_yards');
      if (att) {
        var qb = g[side + '_starter'] && g[side + '_starter'].player_name;
        var c = add(claim({ topic: 'qb', key: 'team_passing:' + side, team: teams[side], side: side, subject: qb || null, label: teams[side] + ' passing (2026)',
          text: poss(teams[side]) + ' passers have completed ' + cmp + ' of ' + att + ' (' + pct1(cmp / att) + ') for ' + thousands(yds) + ' yards, ' + f1(yds / att) + ' yards per attempt, with ' + td + ' touchdowns, ' + ints + ' interceptions and ' + sk + ' sacks taken in ' + numWord(rows.length) + ' games.',
          short: poss(teams[side]) + ' passing: ' + pct1(cmp / att) + ' completions, ' + f1(yds / att) + ' yards per attempt, ' + td + ' TD, ' + ints + ' INT',
          cite: { nums: [f1(yds / att)], words: ['per attempt', 'yards per'] }, values: { attempts: att, completions: cmp, yards: yds, tds: td, ints: ints, sacks: sk, games: rows.length },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA' }));
        ['qb_efficiency', 'qb_completion', 'qb_ypa', 'qb_td_int', 'qb_sacks'].forEach(function (k) { covered(k, c); });
      }
      if (rows.length && isNum(pen)) {
        var pc = add(claim({ topic: 'discipline', key: 'penalties:' + side, team: teams[side], side: side, label: teams[side] + ' penalties',
          text: teams[side] + ' have been flagged ' + pen + ' times for ' + peny + ' yards in ' + numWord(rows.length) + ' games (' + f1(pen / rows.length) + ' per game).',
          short: f1(pen / rows.length) + ' penalties per game for ' + teams[side],
          cite: { nums: [f1(pen / rows.length)], words: ['penalt', 'flag'] }, values: { penalties: pen, yards: peny, per_game: r1(pen / rows.length) },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA' }));
        covered('penalties', pc);
      }
      /* last two QB-by-game lines for the trend */
      if (rows.length >= 3) {
        var sorted = rows.slice().sort(function (a, b) { return (+a.week) - (+b.week); });
        var last = sorted.slice(-2), early = sorted.slice(0, -2);
        var ly = last.reduce(function (a, r) { return a + (+r.passing_yards || 0); }, 0) / Math.max(1, last.reduce(function (a, r) { return a + (+r.attempts || 0); }, 0));
        var ey = early.reduce(function (a, r) { return a + (+r.passing_yards || 0); }, 0) / Math.max(1, early.reduce(function (a, r) { return a + (+r.attempts || 0); }, 0));
        var tc = add(claim({ topic: 'qb', key: 'team_passing_trend:' + side, team: teams[side], side: side, label: teams[side] + ' passing trend',
          text: 'Over their last two games, ' + poss(teams[side]) + ' passers averaged ' + f1(ly) + ' yards per attempt, against ' + f1(ey) + ' before that.',
          short: poss(teams[side]) + ' passing ' + f1(ly) + ' yards per attempt over the last two games (' + f1(ey) + ' before)',
          cite: { nums: [f1(ly)], words: ['last two', 'per attempt'] }, values: { last_two_ypa: r1(ly), before_ypa: r1(ey) },
          source: { id: 'nflverse_team_week', label: 'nflverse team-week stats (2026)', path: 'football/nfl/stats_team_week_2026.csv' }, observed_at: A.team_weeks, verification: 'VERIFIED_DATA',
          leans: Math.abs(ly - ey) >= 1 ? (ly > ey ? teams[side] : teams[side === 'home' ? 'away' : 'home']) : null, strength: Math.abs(ly - ey) >= 1 ? 'small' : null }));
        covered('qb_trend', tc);
      }
    });
    /* results */
    ['home', 'away'].forEach(function (side) {
      var t = TT[codes[side]]; var res = (t && t.results) || [];
      if (!res.length) return;
      var w = res.filter(function (r) { return r.result === 'W'; }).length, l = res.filter(function (r) { return r.result === 'L'; }).length, tie = res.length - w - l;
      var ppg = res.reduce(function (a, r) { return a + r.points_for; }, 0) / res.length, papg = res.reduce(function (a, r) { return a + r.points_against; }, 0) / res.length;
      var rc = add(claim({ topic: 'results', key: 'record:' + side, team: teams[side], side: side, label: teams[side] + ' record',
        text: 'The ' + teams[side] + ' are ' + w + '–' + l + (tie ? '–' + tie : '') + ', scoring ' + f1(ppg) + ' points per game and allowing ' + f1(papg) + '.',
        short: teams[side] + ' (' + w + '–' + l + (tie ? '–' + tie : '') + ')', cite: { nums: [String(w), String(l)], words: [teams[side].split(' ').slice(-1)[0]] },
        values: { wins: w, losses: l, ties: tie, ppg: r1(ppg), papg: r1(papg) }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' }));
      covered('recent_results', rc); covered('off_points', rc); covered('def_points', rc);
      res.slice(-2).forEach(function (r) {
        var won = r.result === 'W';
        var cc = add(claim({ topic: 'results', key: 'result:' + r.game_id + ':' + side, team: teams[side], side: side, label: teams[side] + ' vs ' + r.opponent,
          text: 'The ' + teams[side] + ' ' + (won ? 'beat the ' + r.opponent + ' ' : (r.result === 'L' ? 'lost ' : 'tied ')) + score(r.points_for, r.points_against) + (won ? '' : (r.result === 'L' ? (r.venue === 'away' ? ' at ' : ' to ') + 'the ' + r.opponent : ' with the ' + r.opponent)) + ' in Week ' + r.week + '.',
          short: (won ? 'beat the ' + r.opponent + ' ' : 'lost ' ) + score(r.points_for, r.points_against) + (won ? '' : (r.venue === 'away' ? ' at ' : ' to ') + 'the ' + r.opponent),
          cite: { nums: [String(Math.max(r.points_for, r.points_against)), String(Math.min(r.points_for, r.points_against))], words: [String(r.opponent).split(' ').slice(-1)[0]] },
          values: r, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' }));
        covered('recent_results', cc);
      });
    });
    /* quarterbacks and the official injury report */
    var inj = x.injuries || {};
    ['home', 'away'].forEach(function (side) {
      var st = g[side + '_starter'], code = codes[side], team = teams[side];
      var tr = inj.teams && inj.teams[code];
      var players = tr && tr.week === g.week ? (tr.players || []) : [];
      if (st && st.player_name) {
        var rep = players.filter(function (p) { return p.name === st.player_name && p.status; })[0];
        var sc = add(claim({ topic: 'qb_status', key: 'qb_model:' + side, team: team, side: side, subject: st.player_name, label: team + ' quarterback',
          text: st.player_name + ' is ' + poss(team) + ' listed starter in the schedule feed' + (rep ? '; the official injury report lists him as ' + String(rep.status).toLowerCase() + (rep.injury ? ' (' + String(rep.injury).toLowerCase() + ')' : '') : '') + '.',
          short: st.player_name + (rep ? ' (' + String(rep.status).toLowerCase() + ')' : ' (listed starter)'), cite: { nums: [], words: [lastName(st.player_name), 'start|report|lists|listed' + (rep ? '|' + String(rep.status).toLowerCase() : '')], all: true },
          values: { player: st.player_name, status: rep ? rep.status : 'LISTED', contested: false }, source: { id: 'nfl_slate', label: 'nflverse schedule feed and official injury report', path: 'football/nfl/slate.json' }, observed_at: A.slate,
          verification: rep ? 'OFFICIAL_REPORT' : 'VERIFIED_DATA', status: rep ? String(rep.status).toUpperCase() : 'PREVIOUS_GAME', material: !!rep }));
        covered('qb_availability', sc);
        var regime = g.regime && g.regime[side];
        if (regime && regime.qb_out) add(claim({ topic: 'input', key: 'qb_regime:' + side, team: team, side: side, label: team + ': quarterback change', text: poss(team) + ' regular starter ' + (regime.regular_starter || '') + ' is not the listed starter this week.', short: poss(team) + ' regular starter is out', cite: { nums: [], words: [lastName(regime.regular_starter || team), 'start|out'], all: true }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA', material: true }));
      }
      var outs = players.filter(function (p) { return p.status === 'Out' || p.status === 'Doubtful'; });
      var key = outs.filter(function (p) { return /^(QB|T|G|C|WR|TE|RB|CB|S|DE|DT|LB|EDGE|OLB)$/.test(p.position); }).slice(0, 4);
      if (outs.length) {
        var ic = add(claim({ topic: 'injury', key: 'report_out:' + side, team: team, side: side, label: team + ' injuries',
          text: 'The official injury report lists ' + numWord(outs.length) + ' ' + team + ' player' + (outs.length === 1 ? '' : 's') + ' as out or doubtful' + (key.length ? ', including ' + sentenceList(key.map(function (p) { return p.position + ' ' + p.name + ' (' + p.status.toLowerCase() + ')'; })) : '') + '.',
          short: numWord(outs.length) + ' ' + team + ' players out or doubtful', cite: { nums: [], words: [team.split(' ').slice(-1)[0], 'out|doubtful'], all: true },
          values: { players: outs.map(function (p) { return { name: p.name, position: p.position, status: p.status, injury: p.injury }; }) },
          source: { id: 'nfl_injuries', label: 'Official NFL injury report (nflverse)', path: 'football/injuries/nfl_2026.json' }, observed_at: inj.retrieved_at || A.injuries, verification: 'OFFICIAL_REPORT', material: key.length > 0 }));
        covered('injuries', ic);
      }
    });
    /* rest, weather, head-to-head */
    if (isNum(g.home_rest) && isNum(g.away_rest)) {
      var more = g.home_rest > g.away_rest ? home : (g.away_rest > g.home_rest ? away : null);
      var rc2 = add(claim({ topic: 'situational', key: 'rest', team: more, label: 'Rest', text: more ? 'The ' + more + ' come in on ' + Math.max(g.home_rest, g.away_rest) + ' days of rest; the ' + (more === home ? away : home) + ' have had ' + Math.min(g.home_rest, g.away_rest) + '.' : 'Both teams are on ' + g.home_rest + ' days of rest.',
        short: more ? more + ' ' + Math.max(g.home_rest, g.away_rest) + ' days of rest to ' + Math.min(g.home_rest, g.away_rest) : 'equal rest', cite: { nums: [String(Math.max(g.home_rest, g.away_rest))], words: ['rest', 'days'] },
        values: { home_days: g.home_rest, away_days: g.away_rest }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA', leans: more && Math.abs(g.home_rest - g.away_rest) >= 3 ? more : null, strength: more && Math.abs(g.home_rest - g.away_rest) >= 3 ? 'small' : null }));
      covered('rest_travel', rc2);
    }
    var fc = g.forecast;
    if (fc && isNum(fc.temp_f) && !fc.dome) {
      var wc = add(claim({ topic: 'situational', key: 'weather', label: 'Forecast', text: 'The kickoff forecast calls for ' + Math.round(fc.temp_f) + ' degrees' + (isNum(fc.wind_mph) ? ' with wind around ' + Math.round(fc.wind_mph) + ' mph' : '') + (fc.text ? ' (' + String(fc.text).toLowerCase() + ')' : '') + '.',
        short: Math.round(fc.temp_f) + ' degrees', cite: { nums: [String(Math.round(fc.temp_f))], words: ['forecast', 'degrees', 'wind'] }, values: fc, source: { id: 'forecast', label: 'Kickoff forecast', path: 'football/nfl/slate.json' }, observed_at: fc.as_of || A.slate,
        verification: 'VERIFIED_DATA', material: (isNum(fc.wind_mph) && fc.wind_mph >= 15), caveat: 'a forecast, not an observation' }));
      covered('weather', wc);
    } else if (g.roof === 'dome' || g.roof === 'closed') covered('weather', add(claim({ topic: 'situational', key: 'weather', label: 'Indoors', text: 'The game is played indoors.', short: 'indoors', cite: { nums: [], words: ['indoors', 'dome', 'roof'] }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' })));
    var h2h = (x.h2h || []).filter(function (r) { return isNum(r.home_points) && isNum(r.away_points); }).sort(function (a, b) { return (a.season - b.season) || ((ts(a.kickoff) || 0) - (ts(b.kickoff) || 0)); });
    if (h2h.length) {
      var lm = h2h[h2h.length - 1];
      var lw = lm.home_points > lm.away_points ? lm.home : lm.away;
      covered('head_to_head', add(claim({ topic: 'history', key: 'h2h', label: 'Head-to-head', text: 'The last meeting, in ' + lm.season + ', went to the ' + lw + ', ' + score(lm.home_points, lm.away_points) + '.', short: 'the ' + lw + ' won the last meeting in ' + lm.season,
        cite: { nums: [String(lm.season)], words: ['meeting', 'met'] }, values: lm, scope: 'historical', source: { id: 'lines_archive', label: 'EdgeDesk NFL results-and-lines archive', path: 'football/pricing/lines_nfl.json' }, observed_at: A.lines, verification: 'VERIFIED_DATA' })));
    }
    if (g.div_game) covered('conference', add(claim({ topic: 'conference', key: 'division', label: 'Division game', text: 'It is a division game.', short: 'a division game', cite: { nums: [], words: ['division'] }, source: srcSlate, observed_at: A.slate, verification: 'VERIFIED_DATA' })));
    (x.facts || []).forEach(function (f) {
      var exp = ts(f.expires_at); if (exp != null && exp <= now) return;
      var c = add(claim({ topic: f.kind === 'availability' ? 'injury' : (f.topic || 'report'), key: 'fact:' + f.id, team: f.team || null, subject: f.subject || null, label: f.label || f.subject || 'Report', text: f.text, short: f.short || f.text,
        cite: f.cite || { nums: [], words: [f.subject ? lastName(f.subject) : (f.team || '')] }, values: f.values || null, scope: f.scope || 'report',
        source: { id: 'facts', label: f.source && f.source.publisher, publisher: f.source && f.source.publisher, url: f.source && f.source.url, published_at: f.source && f.source.published_at },
        observed_at: f.source && f.source.published_at || f.recorded_at, verification: f.verification === 'VERIFIED' ? 'VERIFIED_REPORT' : 'REPORTED', material: !!f.material, status: f.status_designation || null,
        caveat: f.verification === 'VERIFIED' ? null : 'not yet confirmed at the source by an EdgeDesk editor' }));
      if (f.covers) [].concat(f.covers).forEach(function (it) { covered(it, c); });
    });

    /* model and market */
    var model = { available: g.model_status === 'PREDICTED' && isNum(g.model_home_line) };
    if (model.available) {
      var hl = r1(g.model_home_line), fav = hl < -0.05 ? home : (hl > 0.05 ? away : null);
      model = { available: true, home_line: hl, favorite: fav, margin: r1(Math.abs(hl)), text: fav ? 'the ' + fav + ' by ' + f1(Math.abs(hl)) : 'a pick’em', home_win_prob: isNum(g.model_home_win_prob) ? r2(g.model_home_win_prob) : null, total: isNum(g.model_fair_total) ? r1(g.model_fair_total) : null, version: g.model_version || null };
    }
    var q = x.quote;
    var market = { status: 'none', comparable: false };
    if (q && isNum(q.home_line)) {
      var age = q.captured_at ? Math.round((now - ts(q.captured_at)) / 60000) : null;
      var mhl = r1(q.home_line), mf = mhl < -0.05 ? home : (mhl > 0.05 ? away : null);
      market = { status: age != null && age <= STALE_MINUTES ? 'current' : 'stale', home_line: mhl, favorite: mf, margin: r1(Math.abs(mhl)), text: mf ? 'the ' + mf + ' -' + (Math.abs(mhl) % 1 === 0 ? String(Math.abs(mhl)) : Math.abs(mhl).toFixed(1)) : 'pick’em', book: q.book || null, captured_at: q.captured_at || null, comparable: true, reason: 'a captured sportsbook spread' };
    } else if (g.reference_market && isNum(g.reference_market.home_line)) {
      var rhl = r1(g.reference_market.home_line), rf = rhl < -0.05 ? home : (rhl > 0.05 ? away : null);
      market = { status: 'reference', home_line: rhl, favorite: rf, margin: r1(Math.abs(rhl)), text: rf ? 'the ' + rf + ' -' + (Math.abs(rhl) % 1 === 0 ? String(Math.abs(rhl)) : Math.abs(rhl).toFixed(1)) : 'pick’em', book: null, captured_at: null, comparable: true, reason: 'a consensus reference line with no sportsbook and no capture time: comparable for research, never a price' };
    }
    if (model.available) add(claim({ topic: 'model', key: 'projection', label: 'EdgeDesk projection', text: 'EdgeDesk’s model makes it ' + model.text + '.', short: 'EdgeDesk ' + model.text, cite: { nums: [f1(model.margin)], words: ['EdgeDesk', 'model'] }, values: model, source: srcSlate, observed_at: A.slate, verification: 'MODEL_OUTPUT' }));
    if (market.status !== 'none') add(claim({ topic: 'market', key: 'market', label: market.status === 'reference' ? 'Reference line' : 'Captured line', text: (market.status === 'reference' ? 'The consensus reference line (no sportsbook, no capture time)' : 'The last captured line') + ' had ' + market.text + '.', short: market.text, cite: { nums: [String(market.margin)], words: ['line'] }, values: market, scope: 'market', source: { id: 'market', label: market.status === 'reference' ? 'nflverse consensus (reference)' : (market.book || 'captured line') }, observed_at: market.captured_at || A.slate, verification: 'MARKET_DATA' }));
    ((g.contributions && g.contributions.spread) || []).filter(function (r) { return r.key !== 'baseline' && isNum(r.points) && Math.abs(r.points) >= 0.5; }).forEach(function (r) {
      var fav3 = r.points > 0 ? home : away; /* contributions are in home-margin points */
      var lab = termLabel(r);
      add(claim({ topic: 'model', key: 'term:' + r.key, team: fav3, label: 'Model term: ' + lab, text: 'In EdgeDesk’s model, ' + lab + ' is worth ' + f1(Math.abs(r.points)) + ' points toward the ' + fav3 + '.', short: lab + ' (' + f1(Math.abs(r.points)) + ' points toward the ' + fav3 + ')', cite: { nums: [f1(Math.abs(r.points))], words: [lab.split(' ')[0]] }, values: r, source: srcSlate, observed_at: A.slate, verification: 'MODEL_OUTPUT' }));
    });
    var packet = {
      schema: SCHEMA, version: VERSION, league: 'nfl', game_id: String(g.game_id), season: g.season, week: g.week, key: 'nfl:' + g.season + ':' + g.game_id,
      home: home, away: away, kickoff: g.kickoff, venue: g.venue || null, neutral_site: false, built_at: iso(now), observed: A,
      model: model, market: market, claims: claims, coverage: coverageOf(cov, 'nfl', x), pairs: pairs
    };
    /* a minimal terminal-shaped record so explain() reads the NFL game the same way */
    var gshape = { game: { home: home, away: away }, why: { rows: ((g.contributions && g.contributions.spread) || []).filter(function (r) { return r.key !== 'baseline' && isNum(r.points); }).map(function (r) { return { key: r.key, label: r.key, points: -r.points, favors: r.points > 0 ? home : away }; }) }, games_played: null };
    packet.explanation = explain(packet, gshape, x);
    finalize(packet);
    packet.inputs_hash = hash(JSON.stringify([g.fingerprint || g.game_id, A, (x.facts || []).map(function (f) { return f.id; })]));
    packet.hash = hash(JSON.stringify(packet.claims) + JSON.stringify(packet.explanation));
    return packet;
  }

  /* The stored packet: single-team stats are folded into the matchup claims
     that carry the same numbers, sources are listed once, empty fields go. */
  function finalize(packet) {
    var keep = {}, srcs = {}, idx = {}, n = 0;
    packet.claims = packet.claims.filter(function (c) { return !c.component; }).map(function (c) {
      var out = {};
      Object.keys(c).forEach(function (k) {
        var v = c[k];
        if (v == null || v === false || (k === 'short' && v === c.text) || (k === 'scope' && v === 'current_season') || k === 'source' || k === 'observed_at') return;
        out[k] = v;
      });
      if (c.source) {
        var sk = JSON.stringify([c.source, c.observed_at || null]);
        if (!idx[sk]) { idx[sk] = 's' + (n++); srcs[idx[sk]] = Object.assign({}, c.source, { observed_at: c.observed_at || null }); }
        out.src = idx[sk];
      }
      if (!out.cite.any) delete out.cite.any;
      if (!out.cite.all) delete out.cite.all;
      keep[c.id] = 1;
      return out;
    });
    packet.sources = srcs;
    (packet.coverage || []).forEach(function (cv) { cv.claims = cv.claims.filter(function (id) { return keep[id]; }); });
    var X = packet.explanation || {};
    ['supporting', 'contradicting'].forEach(function (k) { if (X[k]) X[k] = X[k].filter(function (id) { return keep[id]; }); });
    return packet;
  }
  /* A smaller packet for a multi-game article: the explanation's own
     evidence, every quarterback / availability / results / situational /
     model claim, and the strongest matchups and position groups. */
  var ALWAYS = { qb: 1, qb_status: 1, injury: 1, input: 1, results: 1, situational: 1, model: 1, market: 1, history: 1, conference: 1, personnel: 1, schedule: 1, discipline: 1 };
  function trim(packet, opts) {
    if (!packet || !packet.claims) return packet;
    opts = opts || {};
    var X = packet.explanation || {};
    var want = {};
    (X.supporting || []).slice(0, opts.per || 6).concat((X.contradicting || []).slice(0, opts.per || 6)).forEach(function (id) { want[id] = 1; });
    if (X.critical_matchup) want[X.critical_matchup.claim] = 1;
    (packet.pairs || []).slice().sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); }).slice(0, opts.pairs || 6).forEach(function (p) { want[p.claim] = 1; });
    var claims = packet.claims.filter(function (c) { return want[c.id] || ALWAYS[c.topic] || (c.topic === 'position' && c.strength); });
    var used = {}; claims.forEach(function (c) { if (c.src) used[c.src] = 1; });
    var srcs = {}; Object.keys(packet.sources || {}).forEach(function (k) { if (used[k]) srcs[k] = packet.sources[k]; });
    var keep = {}; claims.forEach(function (c) { keep[c.id] = 1; });
    var X2 = Object.assign({}, X, { supporting: (X.supporting || []).filter(function (id) { return keep[id]; }), contradicting: (X.contradicting || []).filter(function (id) { return keep[id]; }) });
    return Object.assign({}, packet, { claims: claims, sources: srcs, explanation: X2, pairs: (packet.pairs || []).filter(function (p) { return keep[p.claim]; }), trimmed: true });
  }
  /* ======================================================================
     FIRST-PARTY — the summary an EdgeDesk game page renders, and the
     preflight that holds a page whose evidence an editor must still confirm
     ====================================================================== */
  function articleSummary(packet) {
    if (!packet || !packet.explanation) return null;
    var X = packet.explanation, by = byIdOf(packet);
    var qbs = packet.claims.filter(function (c) { return /^(qb_season|team_passing):/.test(c.key) || (c.topic === 'injury' && c.values && c.values.position === 'QB') || (c.topic === 'input' && c.verification === 'CONFLICTING'); });
    var avail = materialInjuries(packet).filter(function (c) { return c.topic === 'injury' && !(c.values && c.values.position === 'QB'); });
    var football = function (ids) { return (ids || []).map(function (id) { return by[id]; }).filter(function (c) { return c && c.football; }).slice(0, 4); };
    var sup = football(X.supporting), con = football(X.contradicting);
    var used = sup.concat(con, qbs, avail);
    var srcs = {};
    used.forEach(function (c) {
      var so = sourceOf(packet, c); if (!so) return;
      var k = (so.url || so.path || so.label) + '|' + c.verification;
      if (!srcs[k]) srcs[k] = { label: so.publisher || so.label, url: so.url || null, path: so.path || null, observed_at: so.observed_at || so.published_at || null, verification: c.verification };
    });
    return {
      schema: 'edgedesk_article_evidence_v1', packet_hash: packet.hash, status: X.status || null, input_suspect: !!X.input_suspect,
      question: X.critical_matchup && X.critical_matchup.question_text || null,
      assessment: String(X.assessment || '').replace(/^[A-Z_ ]+\.\s*/, ''),
      gap: X.gap ? { points: X.gap.points, toward: X.gap.toward, other: X.gap.other } : null,
      supporting: sup.map(function (c) { return c.text; }), contradicting: con.map(function (c) { return c.text; }),
      quarterbacks: qbs.map(function (c) { return c.text; }), availability: avail.map(function (c) { return c.text; }),
      script: { model: (X.game_script && X.game_script.model_case) || [], market: (X.game_script && X.game_script.market_case) || [] },
      unknown: (X.uncertainty || []).slice(0, 6),
      flags: (X.input_flags || []).filter(function (f) { return f.severity !== 'info'; }).map(function (f) { return { key: f.key, severity: f.severity, text: f.text }; }),
      sources: Object.keys(srcs).map(function (k) { return srcs[k]; }),
      needs_confirmation: used.filter(function (c) { return c.needs_confirmation; }).map(function (c) { return c.short || c.text; })
    };
  }
  /* blocking conditions for an EdgeDesk page that would publish on its own */
  function firstPartyGate(rec) {
    var fe = rec && rec.football_evidence, blocking = [];
    if (!fe) blocking.push({ id: 'football_evidence', why: 'a pregame page is published only with a football evidence packet behind it (tools/content/evidence.js); there is none for this game yet', detail: null });
    else {
      if (fe.input_suspect) blocking.push({ id: 'evidence_inputs_suspect', why: 'EdgeDesk’s own inputs for this game are suspect, so a person reviews the page before it goes out', detail: (fe.flags || []).filter(function (f) { return f.severity === 'high'; }).map(function (f) { return f.key; }).join(', ') || null });
      if ((fe.needs_confirmation || []).length) blocking.push({ id: 'evidence_unconfirmed', why: 'the page cites outside reporting an editor has not yet confirmed at the source (tools/content/add_fact.js --verify)', detail: fe.needs_confirmation.slice(0, 4).join(' · ') });
    }
    return { ok: !blocking.length, blocking: blocking };
  }
  function sourceOf(packet, c) { return c && c.src && packet && packet.sources ? packet.sources[c.src] || null : (c && c.source) || null; }
  function vOf(c) { return c.verification; }

  /* ======================================================================
     WRITER HELPERS — what an article may say, chosen from the packet
     ====================================================================== */
  function byIdOf(packet) { var m = {}; (packet && packet.claims || []).forEach(function (c) { m[c.id] = c; }); return m; }
  function pick(packet, ids, n, filter) {
    var b = byIdOf(packet);
    return (ids || []).map(function (id) { return b[id]; }).filter(function (c) { return c && (!filter || filter(c)); }).slice(0, n);
  }
  function qbSummary(packet, side) {
    var team = packet[side];
    var season = packet.claims.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key); });
    var status = packet.claims.filter(function (c) { return c.team === team && (c.topic === 'qb_status' || (c.topic === 'injury' && c.values && c.values.position === 'QB')); });
    var conflict = packet.claims.filter(function (c) { return c.team === team && c.verification === 'CONFLICTING'; });
    var trend = packet.claims.filter(function (c) { return c.team === team && /^qb_trend:/.test(c.key); });
    return { season: season, status: status, conflict: conflict, trend: trend };
  }
  function materialInjuries(packet) {
    return packet.claims.filter(function (c) { return (c.topic === 'injury' && c.material) || (c.verification === 'CONFLICTING' && c.topic === 'input'); });
  }

  /* ======================================================================
     GATE — the editorial checks an article must pass
     ====================================================================== */
  var EDGE_RE = /\b(betting edge|an edge (?:on|against|over) the (?:market|line|books?|close)|(?:there(?:’|')s|there is|has) value (?:on|in|with)|value (?:side|bet|play|pick)|mispric\w*|overvalued|undervalued|sharp (?:side|play|money|bet)|the (?:market|books?|line|oddsmakers?) (?:is|are|has it|have it|got it) wrong|market (?:is )?(?:missing|asleep|overreacting)|market inefficien\w*|beat the (?:line|market|close|closing line)|fade (?:the|this)|(?:the|an|this) edge is (?:intact|real)|exploitable)\b/i;
  var CAUSAL_RE = /\b(because|due to|driven by|thanks to|the reason|which is why|that(?:’|')s why|is why|explains?|explained by|stems? from|comes? from|caused by|owing to|reflects?)\b/i;
  var MODEL_SUBJ_RE = /\b(EdgeDesk|the model|model(?:’|')s|projection|our number|EdgeDesk(?:’|')s number)\b/i;
  var GAP_RE = /\b(gap|difference|disagree\w*|apart|closer to|further from|than the (?:line|market))\b/i;
  /* an unexplained or suspect gap must be disclosed twice over: that EdgeDesk
     cannot explain it, AND that it is not an edge (either alone sells it) */
  var UNEXPLAINED_RE = /\b(unexplained|can(?:no|’|')t (?:fully )?(?:explain|account)|cannot (?:fully )?(?:explain|account)|doesn(?:’|')t (?:fully )?(?:explain|account)|does not (?:fully )?(?:explain|account)|no (?:measured )?explanation|accounts? for (?:only |about |roughly |just |most )?[^.]{0,30}?of (?:the|these|those|that|this)|open (?:research )?question|data (?:problem|fault|issue)|input (?:problem|error|may be)|part does not|not all of it|only part)\b/i;
  var NOT_EDGE_RE = /\b(not (?:a|an) (?:betting )?edge|not an? (?:bet|wager|pick)|not (?:for )?a wager|not to bet|not as an edge)\b/i;
  var DISCLOSE_RE = { unexplained: UNEXPLAINED_RE, not_edge: NOT_EDGE_RE };
  var JARGON_RE = /\b(V2\.\d|V2|V1|champion (?:engine|model)|ensemble|ridge regression|gradient-boosted|PMF|sigma|perturbation|regime curve|cfbfastR|play attribution|JSON|pipeline|explainer|holdout|R²|backtest)\b/;
  /* a year, or last season — “the last meeting” alone does not tell a reader it was 2023 */
  var HIST_DATE_RE = /\b(19|20)\d{2}\b|\b(?:last|previous) (?:season|year)\b/i;

  var WORD_RE_CACHE = {};
  function wordRe(w) {
    w = String(w);
    if (!WORD_RE_CACHE[w]) WORD_RE_CACHE[w] = new RegExp('(^|[^A-Za-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/[a-z]$/i.test(w) && w.length >= 5 ? '' : '(?![A-Za-z])'), 'i');
    return WORD_RE_CACHE[w];
  }
  function normNums(s) { return String(s).replace(/(\d),(?=\d{3}\b)/g, '$1'); }
  function hasNum(s, n) {
    var t = String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^0-9.])' + t + '(?![0-9]|\\.[0-9])').test(s);
  }
  function sentences(t) {
    return normNums(String(t)).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\n+|(?<=[.!?])\s+(?=[A-Z“"*(\-])/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function citedIn(c, sents) {
    var nums = c.cite && c.cite.nums || [], words = (c.cite && c.cite.words || []).filter(Boolean);
    return sents.some(function (s) {
      var hit = c.cite && c.cite.any ? nums.some(function (n) { return hasNum(s, normNums(n)); }) : nums.every(function (n) { return hasNum(s, normNums(n)); });
      if (nums.length && !hit) return false;
      if (!words.length) return true;
      var has = function (w) { return String(w).split('|').some(function (x) { return x && wordRe(x).test(s); }); };
      return c.cite && c.cite.all ? words.every(has) : words.some(has);
    });
  }
  var STATUS_TOPICS = { qb_status: 1, injury: 1, input: 1 };
  var COUNTER_SECTIONS = { counterargument: 1, game_script: 1, market_case: 1 };
  function citedClaims(packet, text) {
    var s = sentences(text);
    return (packet && packet.claims || []).filter(function (c) { return (c.cite.nums.length || c.cite.words.length) && citedIn(c, s); });
  }

  /* the text an article says about each featured game: a ### block in a
     multi-game article, the whole body in a single-game one */
  function blocksFor(article, games, single) {
    var body = (article.sections || []).map(function (s) { return s.body; }).join('\n\n');
    if (single == null) single = games.length === 1;
    var out = {};
    if (single) { out[games[0].game_id] = { text: body, single: true }; return out; }
    var parts = body.split(/\n(?=### )/);
    games.forEach(function (p) {
      var hit = parts.filter(function (b) { var h = b.split('\n')[0]; return /^### /.test(h) && h.indexOf(p.home) >= 0 && h.indexOf(p.away) >= 0; });
      if (hit.length) out[p.game_id] = { text: hit.join('\n\n'), single: false };
    });
    return out;
  }

  /* article: {sections, title, standfirst, format, base_format}
     research: o.research ({games:[packets with .evidence]})
     opts: { publisher (bool), firstParty (bool), kind } */
  function gate(article, research, opts) {
    opts = opts || {};
    var checks = [];
    function add(id, status, label, detail, game) { checks.push({ id: id, status: status, label: label, detail: detail || null, game: game || null, gate: 'evidence' }); }
    var games = (research && research.games) || [];
    var body = (article.sections || []).map(function (s) { return s.body; }).join('\n\n');
    var all = [article.title, article.standfirst, body].join('\n\n');
    var single = opts.single != null ? !!opts.single : games.length === 1;
    var blocks = blocksFor(article, games, single);
    var storyLike = /trending_story/.test(article.base_format || article.format || '');
    var record = [];
    var holds = [];
    var shown = games.filter(function (p) { return blocks[p.game_id]; });

    if (!games.length) { add('evidence_scope', 'pass', 'No featured games to evidence'); return finish(); }
    if (!shown.length) add('evidence_games_shown', 'fail', 'The article discusses its featured games', 'no featured game could be found in the article text');

    shown.forEach(function (p) {
      var ev = p.evidence, name = p.away + ' at ' + p.home;
      var blk = blocks[p.game_id], sents = sentences(blk.text);
      if (!ev || ev.schema !== SCHEMA) { add('evidence_packet', 'fail', 'A football evidence packet backs every featured game', name + ': no evidence packet' + (p.evidence_stale ? ' — ' + p.evidence_stale : ''), p.game_id); return; }
      var X = ev.explanation || {};
      var cited = ev.claims.filter(function (c) { return (c.cite.nums.length || c.cite.words.length) && citedIn(c, sents); });
      /* who is playing is a status, judged by injuries_addressed below; it is
         not a football reason for the number (“Chambliss started the last
         game” explains nothing about how the game will be played) */
      var football = cited.filter(function (c) { return c.football && !STATUS_TOPICS[c.topic]; });
      var measured = football.filter(function (c) { return c.measured; });
      var need = storyLike ? 1 : (single ? 5 : 2);
      add('football_evidence', football.length >= need && measured.length >= Math.min(need, single ? 3 : 1) ? 'pass' : 'fail', 'Football evidence, not just the projection',
        name + ': ' + football.length + ' football claim' + (football.length === 1 ? '' : 's') + ' cited, availability aside (' + measured.length + ' measured; need ' + need + ')', p.game_id);
      /* quarterbacks */
      var qbNames = uniq(ev.claims.filter(function (c) { return (c.topic === 'qb' || c.topic === 'qb_status') && c.subject; }).map(function (c) { return c.subject; }));
      var qbCited = cited.filter(function (c) { return c.topic === 'qb' && c.football; });
      if (!storyLike) {
        var teamsWithQb = uniq(ev.claims.filter(function (c) { return /^(qb_season|team_passing):/.test(c.key); }).map(function (c) { return c.team; }));
        var named = qbNames.filter(function (n) { return blk.text.indexOf(lastName(n)) >= 0; });
        var ok = single ? (qbCited.length >= Math.min(2, teamsWithQb.length) && teamsWithQb.every(function (t) { return qbCited.some(function (c) { return c.team === t; }); })) : (named.length >= 1 || qbCited.length >= 1);
        add('qb_discussed', ok || !qbNames.length ? 'pass' : 'fail', 'Discusses recent quarterback performance', name + ': ' + (ok ? 'quarterbacks discussed' : 'no measured quarterback performance cited' + (single ? ' for both teams' : '')), p.game_id);
      }
      /* material injuries and conflicts must be addressed */
      var mat = materialInjuries(ev);
      var needMat = single && !storyLike ? mat : mat.filter(function (c) { return c.verification === 'CONFLICTING' || (c.values && c.values.position === 'QB'); });
      /* a conflict is addressed only by stating it; naming the player is not enough */
      var missing = needMat.filter(function (c) { return !citedIn(c, sents) && (c.verification === 'CONFLICTING' || !(c.subject && blk.text.indexOf(lastName(c.subject)) >= 0)); });
      add('injuries_addressed', missing.length ? 'fail' : 'pass', 'Material injuries and availability are addressed', missing.length ? name + ': not mentioned — ' + missing.map(function (c) { return c.short || c.text; }).join('; ') : null, p.game_id);
      /* contrary evidence where the numbers disagree (and always in a single-game piece) */
      var gap = X.gap && X.gap.points || 0;
      var mentionsGap = !!(ev.market && ev.market.text && (blk.text.indexOf(String(ev.market.margin)) >= 0 || /\bline\b|\bmarket\b|\bspread\b/i.test(blk.text)));
      if ((single && !storyLike) || (gap >= MATERIAL_GAP && mentionsGap)) {
        var contra = (X.contradicting || []).map(function (id) { return ev.claims.filter(function (c) { return c.id === id; })[0]; }).filter(Boolean);
        /* a single-game piece argues the other side where it says it does (the
           counterargument, the game script, the market's case): a stat that
           merely appears in the evidence section is not an argument against */
        var counter = single ? (article.sections || []).filter(function (x) { return COUNTER_SECTIONS[x.key]; }).map(function (x) { return x.body; }).join('\n\n') : '';
        var csents = counter ? sentences(counter) : sents;
        var cc = contra.filter(function (c) { return citedIn(c, csents); });
        var needC = counter && contra.length >= 2 ? 2 : 1;
        var pool = contra.length ? cc.length : (cited.filter(function (c) { return c.football && c.leans && c.leans !== (X.gap && X.gap.toward); }).length);
        add('contrary_evidence', pool >= needC ? 'pass' : 'fail', 'Includes the evidence against EdgeDesk’s view', name + ': ' + pool + ' contradicting claim(s) cited' + (counter ? ' where the article argues the other side' : '') + ' (need ' + needC + ')', p.game_id);
      }
      /* an unexplained or suspect gap is disclosed as such, never sold */
      if ((X.status === 'UNEXPLAINED' || X.input_suspect) && gap >= MATERIAL_GAP && (mentionsGap || single || gap >= MAJOR_GAP)) {
        var saysUnexp = UNEXPLAINED_RE.test(blk.text), saysNotEdge = NOT_EDGE_RE.test(blk.text);
        add('unexplained_disclosed', saysUnexp && saysNotEdge ? 'pass' : 'fail', 'An unexplained gap is called unexplained',
          name + ': status ' + X.status + (X.input_suspect ? ' (input suspect)' : '') + (saysUnexp && saysNotEdge ? '' : ' — the article must say EdgeDesk cannot explain the gap' + (saysUnexp ? ' (it does)' : '') + ' and that it is not an edge' + (saysNotEdge ? ' (it does)' : '')), p.game_id);
      }
      /* causal claims about the model must rest on the model's own terms */
      var bad = [];
      sents.forEach(function (s) {
        if (!CAUSAL_RE.test(s)) return;
        var about = MODEL_SUBJ_RE.test(s) || GAP_RE.test(s);
        if (!about) return;
        var cs = ev.claims.filter(function (c) { return citedIn(c, [s]); });
        var mech = cs.filter(function (c) { return c.verification === 'MODEL_OUTPUT' || c.verification === 'CONFLICTING' || c.verification === 'MARKET_DATA'; });
        var foot = cs.filter(function (c) { return c.football; });
        if (!cs.length && /\b(because|due to|driven by|thanks to|stems? from|caused by|the reason)\b/i.test(s)) bad.push('“' + s.slice(0, 110) + '” — no evidence in the sentence');
        else if (MODEL_SUBJ_RE.test(s) && /\b(likes?|favou?rs?|rates?|sees?|backs?|is high on|projects?)\b/i.test(s) && foot.length && !mech.length) bad.push('“' + s.slice(0, 110) + '” — presents a football stat as the model’s reason; the model’s reasons are its terms');
        else if (X.status === 'UNEXPLAINED' && GAP_RE.test(s) && foot.length && !mech.length && !/\b(not|no|isn(?:’|')t|cannot|can(?:’|')t)\b/i.test(s)) bad.push('“' + s.slice(0, 110) + '” — attributes an unexplained gap to a football cause');
      });
      add('causal_supported', bad.length ? 'fail' : 'pass', 'No unsupported causal explanation', bad.length ? bad.slice(0, 3).join(' · ') : null, p.game_id);
      /* availability stated as the evidence states it */
      var wrong = [];
      ev.claims.filter(function (c) { return c.subject && (c.topic === 'injury' || c.topic === 'qb_status' || c.verification === 'CONFLICTING'); }).forEach(function (c) {
        var st = String(c.status || (c.values && c.values.status) || '').toUpperCase();
        sents.filter(function (s) { return s.indexOf(lastName(c.subject)) >= 0; }).forEach(function (s) {
          var past = /\b(missed|was ruled out|sat out|did not play|didn(?:’|')t play|was scratched|last (?:week|game|saturday))\b/i.test(s);
          if (!past && /\b(ruled out|is out|will miss|won(?:’|')t play|will not play|out for the|sidelined)\b/i.test(s) && st && st !== 'OUT' && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is ' + st.toLowerCase() + ', not out');
          if (/\b(will start|is confirmed|confirmed (?:as|to start)|has been cleared|is cleared|fully healthy|is healthy)\b/i.test(s) && !/\b(not|never|no|isn(?:’|')t|hasn(?:’|')t|yet to|unless|if)\b/i.test(s) && st !== 'CONFIRMED' && st !== 'AVAILABLE' && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is not confirmed (' + (st || 'unconfirmed').toLowerCase() + ')');
          if (st === 'OUT' && /\b(will start|is expected to (?:start|play)|available|probable)\b/i.test(s) && !past && c.subject === subjectOf(s, ev)) wrong.push(c.subject + ' is listed out');
        });
      });
      add('injury_status_correct', wrong.length ? 'fail' : 'pass', 'Injury and starter status match the report', wrong.length ? uniq(wrong).join('; ') : null, p.game_id);
      /* historical facts carry their date — in EVERY sentence that states
         them: one dated mention does not license an undated one elsewhere */
      var undated = ev.claims.filter(function (c) { return c.scope === 'historical' && c.topic !== 'model'; }).filter(function (c) {
        return sents.some(function (s) {
          var mentions = citedIn(c, [s]) || !!(c.values && c.values.last && hasNum(s, String(c.values.last.home_points)) && hasNum(s, String(c.values.last.away_points)));
          return mentions && !HIST_DATE_RE.test(s);
        });
      });
      add('historical_dated', undated.length ? 'fail' : 'pass', 'Historical facts are dated, not presented as current', undated.length ? undated.map(function (c) { return c.short || c.text; }).join('; ') : null, p.game_id);
      /* the gap, if stated, is the gap */
      if (X.gap) {
        var wrongGap = [];
        sents.forEach(function (s) {
          if (/\baccount|explain/i.test(s)) return;
          var m = s.match(/(\d+(?:\.\d+)?)[- ](?:point|pt)s?\s+(?:gap|apart|difference|closer|further|disagreement|away from)|gap of (\d+(?:\.\d+)?)|differ(?:s|ence)? (?:by|of) (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?) points? (?:closer|apart)/i);
          if (!m) return;
          var v = parseFloat(m[1] || m[2] || m[3] || m[4]);
          if (Math.abs(v - X.gap.points) > 0.15 && Math.abs(v - Math.round(X.gap.points)) > 0.01) wrongGap.push(v + ' (the gap is ' + f1(X.gap.points) + ')');
        });
        add('gap_arithmetic', wrongGap.length ? 'fail' : 'pass', 'Model-versus-line arithmetic is correct', wrongGap.length ? name + ': ' + wrongGap.join(', ') : null, p.game_id);
      }
      cited.forEach(function (c) {
        var so = sourceOf(ev, c);
        record.push({ game_id: p.game_id, claim_id: c.id, text: c.text, topic: c.topic, verification: c.verification, scope: c.scope || 'current_season', observed_at: so && so.observed_at || null,
          source: so ? { label: so.label, path: so.path || null, url: so.url || null, publisher: so.publisher || null, published_at: so.published_at || null } : null,
          needs_confirmation: !!c.needs_confirmation, central: !!c.football || c.topic === 'model' || c.topic === 'market' });
        if (c.needs_confirmation) holds.push((c.short || c.text) + ' (' + (so && so.label || 'report') + ')');
      });
      if (X.input_suspect) holds.push(name + ': EdgeDesk’s inputs are suspect (' + X.input_flags.filter(function (f) { return f.severity === 'high'; }).map(function (f) { return f.key; }).join(', ') + ')');
    });

    /* whole-article checks */
    var edge = all.match(EDGE_RE);
    add('no_edge_language', edge ? 'fail' : 'pass', 'No betting-edge language', edge ? '“' + edge[0] + '”' : null);
    var counts = {};
    sentences(body).forEach(function (s) { var k = s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); if (k.split(' ').length >= 8) counts[k] = (counts[k] || 0) + 1; });
    var rep = Object.keys(counts).filter(function (k) { return counts[k] >= 3; }), rep2 = Object.keys(counts).filter(function (k) { return counts[k] === 2; });
    add('no_repetition', rep.length ? 'fail' : (rep2.length ? 'warn' : 'pass'), 'No repeated boilerplate', rep.length ? rep.length + ' sentence(s) repeated 3+ times, e.g. “' + rep[0].slice(0, 80) + '”' : (rep2.length ? rep2.length + ' sentence(s) repeated twice' : null));
    if (opts.publisher) {
      var jg = all.match(JARGON_RE) || all.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '').match(/\b[a-z]+(?:_[a-z0-9]+)+\b/);
      add('no_software_jargon', jg ? 'fail' : 'pass', 'No software or modelling jargon for a general audience', jg ? '“' + jg[0] + '”' : null);
    }
    /* every link points at EdgeDesk or a source in the evidence */
    var known = {};
    games.forEach(function (p) { var sv = (p.evidence && p.evidence.sources) || {}; Object.keys(sv).forEach(function (k) { var so = sv[k]; if (so && so.url) known[hostOf(so.url)] = 1; (so && so.corroboration || []).forEach(function (y) { if (y.url) known[hostOf(y.url)] = 1; }); }); });
    (opts.sources || []).forEach(function (s) { if (s && s.url) known[hostOf(s.url)] = 1; });
    var unknown = [];
    String(body).replace(/\]\((https?:\/\/[^)\s]+)\)/g, function (_, u) { var h = hostOf(u); if (!/(^|\.)edgedesksports\.com$/.test(h) && !known[h]) unknown.push(h); return _; });
    add('sources_known', unknown.length ? 'fail' : 'pass', 'No source outside the research', unknown.length ? 'links to ' + uniq(unknown).join(', ') : null);
    return finish();

    function finish() {
      var fails = checks.filter(function (c) { return c.status === 'fail'; });
      return {
        checks: checks, evidence_record: record, holds: uniq(holds),
        readiness: fails.length ? 'BLOCKED' : (holds.length ? 'HOLD_FOR_REVIEW' : 'READY'),
        version: VERSION
      };
    }
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u); } }
  /* which person a sentence is about: the evidence subject whose surname appears first */
  function subjectOf(s, ev) {
    var best = null, at = Infinity;
    ev.claims.forEach(function (c) { if (!c.subject) return; var i = s.indexOf(lastName(c.subject)); if (i >= 0 && i < at) { at = i; best = c.subject; } });
    return best;
  }

  /* ======================================================================
     FACTS LEDGER — outside reporting the desk recorded, with receipts
     ====================================================================== */
  var FACT_KINDS = ['availability', 'result', 'qb_stats', 'head_to_head', 'personnel', 'team_stats', 'preseason_note', 'schedule'];
  var FACT_TTL_HOURS = { availability: 72, personnel: 24 * 14, qb_stats: 24 * 7, team_stats: 24 * 7, preseason_note: 24 * 120, schedule: 24 * 30 };
  function validateFact(f, nowMs) {
    var reasons = [];
    if (!f || typeof f !== 'object') return { ok: false, reasons: ['not an object'] };
    if (!/^[a-z0-9_.-]{6,80}$/.test(String(f.id || ''))) reasons.push('id: lower-case slug, 6–80 characters');
    if (['cfb', 'nfl'].indexOf(f.league) < 0) reasons.push('league must be cfb or nfl');
    if (FACT_KINDS.indexOf(f.kind) < 0) reasons.push('kind must be one of ' + FACT_KINDS.join(', '));
    if (!Array.isArray(f.teams) || !f.teams.length) reasons.push('teams: the team names the fact concerns');
    if (!f.text || String(f.text).length < 12) reasons.push('text is required');
    var s = f.source || {};
    if (!s.publisher) reasons.push('source.publisher is required');
    if (!/^https:\/\/\S+\.\S+/.test(String(s.url || ''))) reasons.push('source.url is required (https)');
    if (!isFinite(Date.parse(s.published_at || ''))) reasons.push('source.published_at (when the SOURCE said it) is required');
    if (!f.recorded_by) reasons.push('recorded_by is required');
    if (['VERIFIED', 'REPORTED'].indexOf(f.verification) < 0) reasons.push('verification must be VERIFIED (a person opened the source and confirmed it) or REPORTED');
    if (f.verification === 'VERIFIED' && !f.verified_by) reasons.push('a VERIFIED fact names verified_by');
    if (isFinite(Date.parse(s.published_at || '')) && Date.parse(s.published_at) > (nowMs || Date.now()) + 3600000) reasons.push('published_at is in the future');
    var nums = String(f.text).match(/\d+(?:\.\d+)?/g) || [];
    var cnums = (f.cite && f.cite.nums) || [];
    cnums.forEach(function (n) { if (nums.indexOf(String(n)) < 0 && normNums(f.text).indexOf(String(n)) < 0) reasons.push('cite number ' + n + ' does not appear in the text'); });
    return reasons.length ? { ok: false, reasons: reasons } : { ok: true };
  }
  function factsFor(ledger, packetish, nowMs) {
    var facts = (ledger && ledger.facts) || [];
    return facts.filter(function (f) {
      if (f.game_id && String(f.game_id) !== String(packetish.game_id)) return false;
      if (!f.game_id && !(f.teams || []).some(function (t) { return t === packetish.home || t === packetish.away; })) return false;
      var exp = ts(f.expires_at); if (exp != null && exp <= (nowMs || Date.now())) return false;
      return true;
    });
  }
  /* what to look up for a featured game: missing or expired research items */
  function researchPlan(packet) {
    var gaps = (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return { item: c.item, label: c.label, why: c.why }; });
    var conf = (packet.claims || []).filter(function (c) { return c.needs_confirmation; }).map(function (c) { var so = sourceOf(packet, c); return { claim: c.id, confirm: c.short || c.text, source: so && so.url }; });
    var qb = (packet.claims || []).filter(function (c) { return c.topic === 'qb_status' && c.status !== 'CONFIRMED'; }).map(function (c) { return { item: 'starter_confirmation', team: c.team, question: 'Has ' + c.team + ' named its starting quarterback?' }; });
    return { game: packet.away + ' at ' + packet.home, game_id: packet.game_id, status: packet.explanation && packet.explanation.status, missing: gaps, to_confirm: conf, starters: qb };
  }

  /* a compact view for the AI request: the claims a writer may use */
  function forWriter(packet) {
    if (!packet) return null;
    var X = packet.explanation || {};
    return {
      game: packet.away + ' at ' + packet.home, status: X.status, input_suspect: X.input_suspect, actionable: false,
      thesis: X.thesis, assessment: X.assessment, gap: X.gap || null, headline_question: X.headline_question || null,
      critical_matchup: X.critical_matchup || null,
      supporting: (X.supporting || []).slice(0, 6), contradicting: (X.contradicting || []).slice(0, 6),
      game_script: X.game_script, uncertainty: X.uncertainty, input_flags: X.input_flags,
      claims: packet.claims.filter(function (c) { return c.verification !== 'MISSING'; }).map(function (c) {
        var so = sourceOf(packet, c);
        return { id: c.id, topic: c.topic, team: c.team || null, text: c.text, verification: c.verification, scope: c.scope || 'current_season', source: so && (so.publisher || so.label), url: so && so.url || null, needs_attribution: c.verification === 'REPORTED' || c.verification === 'VERIFIED_REPORT', caveat: c.caveat || null };
      }),
      missing: (packet.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return c.label; })
    };
  }

  return {
    SCHEMA: SCHEMA, VERSION: VERSION, METRICS: METRICS, PAIRS: PAIRS, COVERAGE: COVERAGE, FACT_KINDS: FACT_KINDS, FACT_TTL_HOURS: FACT_TTL_HOURS, DISCLOSE_RE: DISCLOSE_RE,
    MATERIAL_GAP: MATERIAL_GAP, MAJOR_GAP: MAJOR_GAP,
    buildCfb: buildCfb, buildNfl: buildNfl, explain: explain,
    gate: gate, citedClaims: citedClaims, sentences: sentences,
    validateFact: validateFact, factsFor: factsFor, researchPlan: researchPlan, forWriter: forWriter,
    sourceOf: sourceOf, trim: trim, articleSummary: articleSummary, firstPartyGate: firstPartyGate,
    writer: { pick: pick, qbSummary: qbSummary, materialInjuries: materialInjuries, byId: byIdOf, lastName: lastName, poss: poss, dayMonth: dayMonth, sentenceList: sentenceList, f1: f1 },
    util: { hash: hash }
  };
});
// ── END FOOTBALL EVIDENCE ───────────────────────────────────────────────
// ── BEGIN CONTENT ENGINE CORE ────────────────────────────────────────────
// Canonical source: lib/content_engine.js, copied VERBATIM by
// tools/content/inline.js. Edit the canonical file, then run it.
/* ===========================================================================
   EdgeDesk — the Sports Media Content Engine's core (EDContentEngine).

   One file, three hosts, no dependencies:
     · the owner's Content Engine page (admin/content/) loads it in a browser;
     · the weekly job (tools/content/run.js) requires it in Node;
     · the content_engine Edge Function carries a VERBATIM copy
       (tools/content/inline.js; a test fails on drift).

   WHAT IT DOES
     research   reads artifacts EdgeDesk already publishes (the CFB terminal,
                the rankings, the NFL slate, the NFL injury report, the
                captured market snapshots) into one normalised packet per game.
                It computes nothing a model did not already compute: it
                SELECTS, ROUNDS and LABELS, and it states how old each number
                is. A stale price is labelled stale; a reference line with no
                book and no capture time is labelled a reference; a missing
                confidence stays missing, with the reason.
     discover   turns a research snapshot (plus optional, attributed news
                headlines and EdgeDesk's own Search Console queries) into
                scored article opportunities. Every score carries its basis;
                search demand is an ESTIMATE unless measured evidence exists,
                and says so.
     seo        a brief per opportunity: keywords, intent, headlines, meta
                description, slug, structure, links, demand evidence.
     draft      a deterministic draft in one of five formats, written only
                from the packet. It is the floor the AI pass must beat, and
                what ships when no model is configured.
     validate   the quality gate: every number and team must be in the
                evidence; no pick, lock or guarantee language; projections
                never presented as betting value; stale prices never
                presented as current; external reporting attributed;
                disclaimer and attribution present; SEO and length checks;
                near-duplicate detection against sibling articles.
     export     Markdown and HTML, with a UTM-tagged EdgeDesk link.
     news       parses public RSS headlines (title, link, time — never an
                article body) and matches them to teams on this week's slate.
     ai         builds the drafting request (structured JSON output) and
                parses the reply. The CALL is the host's: the Edge Function
                uses the SDK, the Node job raw HTTP. Whatever comes back is
                validated by the same gate and discarded if it fails.

   THE RULE IT SERVES: research, not picks. A team projected to win is not a
   bet; nothing here turns a projection into a recommendation.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDContentEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'content_engine_v2';
  var SITE = 'https://edgedesksports.com';

  /* The football evidence module (lib/football_evidence.js). Node requires it;
     the admin page loads it before this file; the Edge Function inlines it
     before this core. Looked up on use, so load order never matters — and if
     it is missing, validate() FAILS the article rather than skipping the gate. */
  var FE_CACHE = null;
  function fe() {
    if (FE_CACHE) return FE_CACHE;
    var g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    if (g.EDFootballEvidence) return (FE_CACHE = g.EDFootballEvidence);
    try { if (typeof require === 'function') FE_CACHE = require('./football_evidence.js'); } catch (e) { FE_CACHE = null; }
    return FE_CACHE;
  }

  /* ------------------------------------------------------------ vocabulary */
  var STATUSES = ['draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'archived'];
  /* The same matrix the database enforces (supabase/content_engine.sql). */
  var TRANSITIONS = {
    draft: ['in_review', 'archived'],
    in_review: ['draft', 'approved', 'archived'],
    approved: ['ready_to_send', 'in_review', 'draft', 'archived'],
    ready_to_send: ['sent', 'approved', 'in_review', 'archived'],
    sent: ['published', 'archived'],
    published: ['archived'],
    archived: ['draft']
  };
  var STATUS_LABELS = {
    draft: 'Draft', in_review: 'In review', approved: 'Approved', ready_to_send: 'Ready to send',
    sent: 'Sent', published: 'Published', archived: 'Archived'
  };

  var KINDS = {
    weekly_preview: 'Weekly preview',
    upset_watch: 'Upset watch',
    conference_race: 'Conference race',
    market_discrepancy: 'Market discrepancy',
    injury_impact: 'Injury implications',
    trending_story: 'Trending story',
    matchup_analysis: 'Matchup analysis'
  };

  /* Each format names the sections a draft must carry, in order. `required`
     sections must be present for the structure check to pass. */
  var FORMATS = {
    cfb_weekly_preview: {
      label: 'Weekly CFB preview', league: 'cfb',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'conference', 'limits', 'conclusion'],
      required: ['intro', 'why_it_matters', 'how_to_read', 'games', 'limits', 'conclusion'],
      words: [900, 1800]
    },
    nfl_weekly_preview: {
      label: 'Weekly NFL preview', league: 'nfl',
      sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'disagreements', 'injuries', 'limits', 'conclusion'],
      required: ['intro', 'why_it_matters', 'how_to_read', 'games', 'limits', 'conclusion'],
      words: [900, 1800]
    },
    trending_story: {
      label: 'Trending sports story', league: null,
      sections: ['intro', 'reported', 'why_it_matters', 'research', 'unknowns', 'conclusion'],
      required: ['intro', 'reported', 'research', 'unknowns', 'conclusion'],
      words: [450, 1000]
    },
    market_discrepancy: {
      label: 'Market discrepancy analysis', league: null,
      sections: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'limits', 'conclusion'],
      required: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'conclusion'],
      words: [500, 1200]
    },
    /* the journalist-first single-game piece (football/evidence packets) */
    matchup_analysis: {
      label: 'Matchup analysis (for a publisher)', league: null,
      sections: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'conclusion'],
      required: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'conclusion'],
      headings: { conclusion: 'What to watch, and what we still don’t know' },
      words: [800, 1600]
    },
    edgedesk_analysis: {
      label: 'Matchup analysis (EdgeDesk first-party)', league: null, first_party: true,
      sections: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'model_detail', 'conclusion'],
      required: ['intro', 'thesis', 'evidence', 'counterargument', 'game_script', 'model_detail', 'conclusion'],
      headings: { thesis: 'Where EdgeDesk differs, and why', evidence: 'The evidence, unit by unit', counterargument: 'The case against EdgeDesk’s number', conclusion: 'What to watch' },
      words: [900, 2400]
    },
    publisher_custom: {
      label: 'Publisher-specific article', league: null,
      sections: null, /* from the publisher's profile, else the league preview */
      required: ['intro', 'how_to_read', 'conclusion'],
      words: null
    }
  };

  var SECTION_HEADINGS = {
    intro: null,
    why_it_matters: 'Why this week matters',
    how_to_read: 'How to read these numbers',
    games: 'The games that matter most',
    upsets: 'Upset watch',
    conference: 'What it means for the conference races',
    disagreements: 'Where the numbers tell a different story',
    injuries: 'Injury report: what to watch',
    limits: 'What the numbers can’t see',
    conclusion: 'The bottom line',
    reported: 'What was reported',
    research: 'What EdgeDesk’s research shows',
    unknowns: 'What we don’t know yet',
    the_gap: 'The gap',
    why_they_differ: 'Why the numbers differ',
    market_case: 'The case for the market',
    thesis: 'What EdgeDesk sees differently',
    evidence: 'The football evidence',
    counterargument: 'What could make EdgeDesk wrong',
    game_script: 'What has to happen on the field',
    model_detail: 'Inside EdgeDesk’s number'
  };

  var DISCLAIMER = 'EdgeDesk publishes research, not betting advice. Nothing in this article is a pick, a wager or a recommendation. 21+. Gamble responsibly — 1-800-GAMBLER.';

  /* Opportunity score: seven parts, each 0–100 with a stated basis. */
  var SCORE_WEIGHTS = {
    search_relevance: 0.18, timeliness: 0.14, audience_interest: 0.16, research_availability: 0.16,
    editorial_relevance: 0.10, publisher_fit: 0.14, research_confidence: 0.12
  };
  var SCORE_LABELS = {
    search_relevance: 'Search relevance', timeliness: 'Timeliness', audience_interest: 'Audience interest',
    research_availability: 'Research availability', editorial_relevance: 'Editorial relevance',
    publisher_fit: 'Publisher fit', research_confidence: 'Research confidence'
  };

  /* Thresholds shared with the rest of EdgeDesk (lib/edgedesk_canon.js,
     the CFB decision policy): a quote older than 180 minutes is not a price. */
  var STALE_MINUTES = 180;
  var MIN_CONFIDENCE = 35;
  var RESEARCH_GAP = 2;
  var POWER4 = ['SEC', 'Big Ten', 'Big 12', 'ACC'];

  /* ------------------------------------------------------ banned language */
  /* Copied from tools/articles/article_model.js FORBIDDEN and
     tools/articles/community.js BANNED_TERMS (tools/content/content.test.js
     fails if either list grows a phrase this one lacks), plus the engine's
     own additions for prediction copy. */
  var BANNED = [
    ['best bets?', 'EdgeDesk does not publish best bets.'],
    ['lock of the', 'Nothing is a lock.'],
    ['locks? of', 'Nothing is a lock.'],
    ['mortal lock', 'Nothing is a lock.'],
    ['guaranteed win(?:ner|s)?', 'No outcome is guaranteed.'],
    ['guaranteed', 'No outcome is guaranteed.'],
    ['guarantee', 'No outcome is guaranteed.'],
    ['free money', 'There is no free money in a priced market.'],
    ['sure thing', 'Nothing on a football field is a sure thing.'],
    ['cannot lose', 'A bet that cannot lose does not exist.'],
    ['can.?t[- ]lose', 'A bet that cannot lose does not exist.'],
    ['can.?t[- ]miss', 'Nothing is certain.'],
    ['no.?brainer', 'If it were obvious the price would already reflect it.'],
    ['easy money', 'There is no easy money in a priced market.'],
    ['100% winner', 'No selection wins every time.'],
    ['bet the house', 'EdgeDesk does not tell anyone how much to stake.'],
    ['bet the', 'That is a recommendation.'],
    ['max bet', 'EdgeDesk does not tell anyone how much to stake.'],
    ['mortgage', 'EdgeDesk does not tell anyone how much to stake.'],
    ['hammer(?:ing)? (?:this|the|it)', 'Write what the numbers show, not how hard to bet it.'],
    ['smash (?:play|spot|this)', 'Write what the numbers show, not how hard to bet it.'],
    ['(?:my|our|the) pick is', 'A pick is not what this article is for.'],
    ['our picks?', 'A pick is not what this article is for.'],
    ['take the points', 'That is a recommendation.'],
    ['take the (?:over|under)', 'That is a recommendation.'],
    ['play of the (?:day|week|year)', 'That is a recommendation.'],
    ['guaranteed profit', 'Nothing here is a guarantee of profit.'],
    ['risk.?free', 'No wager is risk free.'],
    ['best value', 'Value depends on the price at the moment of a bet; the article does not rank bets.'],
    ['value play', 'That is a recommendation.'],
    ['worth a bet', 'That is a recommendation.'],
    ['(?:you|fans|readers) should (?:bet|back|take|wager)', 'That is a recommendation.'],
    ['bet on (?:the )?[A-Z][a-z]+', 'That is a recommendation.'],
    ['slam dunk', 'Nothing is certain.'],
    ['will (?:win|cover|beat|lose)', 'A projection is a probability, not a certainty: write "is projected to".'],
    ['certain to', 'A projection is a probability, not a certainty.'],
    ['no doubt', 'A projection is a probability, not a certainty.']
  ];
  var BANNED_RE = BANNED.map(function (b) { return { re: new RegExp('\\b' + b[0] + '\\b', b[0].indexOf('[A-Z]') >= 0 ? '' : 'i'), why: b[1], term: b[0] }; });

  /* tools/editorial/quality.js AI_TELLS, verbatim in intent. */
  var AI_TELLS = [
    /\bdelve[sd]? into\b/i, /\bin the (?:ever-?(?:changing|evolving)|fast-?paced) (?:world|landscape|realm)\b/i,
    /\bit(?:'|’)s important to note\b/i, /\bit is important to note\b/i, /\bgame[- ]chang(?:er|ing)\b/i,
    /\bonly time will tell\b/i, /\bwhether you(?:'|’)?re a (?:seasoned|casual|novice)\b/i,
    /\bthis thrilling (?:matchup|contest|clash)\b/i, /\bwhen (?:it|all) comes down to it\b/i,
    /\bat the end of the day\b/i, /\bin conclusion\b/i, /\bneedless to say\b/i, /\bthe perfect storm\b/i,
    /\bleave(?:s|) no stone unturned\b/i, /\ba testament to\b/i,
    /\bnavigat(?:e|ing) the (?:complexities|challenges|landscape)\b/i, /\bmust[- ]watch\b/i,
    /\bbuckle up\b/i, /\ball eyes will be on\b/i, /\bwithout a doubt\b/i
  ];
  var STRINGIFIED_NOTHING = /(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/;

  /* ---------------------------------------------------------------- utils */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* one decimal the way EdgeDesk's own displays print it (toFixed), so a
     5.35 reads 5.3 here exactly as it does on the terminal */
  function r1(x) { return +(+x).toFixed(1); }
  function oneDp(x) { return Math.abs(+(+x).toFixed(1)).toFixed(1); }
  function aOrAn(numText) { return /^(8|11|18|8\d)(\.|$)/.test(String(numText)) ? 'an' : 'a'; }
  /* a betting line as books print it: 3, 6.5, 1.5 */
  function lineNum(x) { var a = Math.abs(r1(x)); return a % 1 === 0 ? String(a) : a.toFixed(1); }
  function pct(p) { return Math.round(p * 100) + '%'; }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function uniq(a) { var s = {}, out = []; (a || []).forEach(function (x) { var k = typeof x === 'string' ? x : JSON.stringify(x); if (!s[k]) { s[k] = 1; out.push(x); } }); return out; }
  function ts(x) { var t = x ? Date.parse(x) : NaN; return isFinite(t) ? t : null; }
  function iso(t) { return new Date(t).toISOString(); }
  function minutesBetween(a, b) { return Math.round((b - a) / 60000); }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 80).replace(/-+$/, '');
  }
  function words(s) { return String(s || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter(function (w) { return /[A-Za-z0-9]/.test(w); }); }
  function wordCount(s) { return words(s).length; }
  function sentenceList(arr, conj) {
    arr = (arr || []).filter(Boolean); conj = ' ' + (conj || 'and') + ' ';
    if (arr.length <= 1) return arr.join('');
    if (arr.length === 2) return arr[0] + conj + arr[1];
    return arr.slice(0, -1).join(', ') + conj + arr[arr.length - 1];
  }
  var NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  function numWord(n) { return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  /* "Alabama is" but "the Dallas Cowboys are" */
  function verb(league, singular, plural) { return league === 'nfl' ? plural : singular; }
  /* djb2 → base36; used for deterministic keys and hashes, not security */
  function hash(s) {
    s = String(s); var h1 = 5381, h2 = 52711;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 33) ^ c; }
    return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36));
  }

  /* Dates, the way an American sports desk prints them: Sat., Oct. 10,
     7:30 p.m. ET. Intl exists in every host this file runs in. */
  var MONTHS_AP = { Jan: 'Jan.', Feb: 'Feb.', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'Aug.', Sep: 'Sept.', Oct: 'Oct.', Nov: 'Nov.', Dec: 'Dec.' };
  var DAYS_AP = { Sun: 'Sun.', Mon: 'Mon.', Tue: 'Tue.', Wed: 'Wed.', Thu: 'Thu.', Fri: 'Fri.', Sat: 'Sat.' };
  function etParts(t) {
    var parts = {};
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
        .formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) {
      var d = new Date(t - 4 * 3600000); /* EDT fallback */
      var wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
      var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      var h = d.getUTCHours(), m = d.getUTCMinutes();
      parts = { weekday: wd, month: mo, day: String(d.getUTCDate()), hour: String(h % 12 || 12), minute: (m < 10 ? '0' : '') + m, dayPeriod: h < 12 ? 'AM' : 'PM' };
    }
    return parts;
  }
  function dayText(t) { var p = etParts(t); return (DAYS_AP[p.weekday] || p.weekday) + ', ' + (MONTHS_AP[p.month] || p.month) + ' ' + p.day; }
  function timeText(t) {
    var p = etParts(t);
    var ap = String(p.dayPeriod || '').toUpperCase() === 'AM' ? 'a.m.' : 'p.m.';
    return (p.minute === '00' ? p.hour : p.hour + ':' + p.minute) + ' ' + ap + ' ET';
  }
  function whenText(t) { return t == null ? null : dayText(t) + ', ' + timeText(t); }

  /* ======================================================================
     RESEARCH — committed artifacts → one packet per game
     ====================================================================== */

  /* The files the engine reads, by role. Paths are repository paths and,
     because the site is served from the repository, also site paths. */
  var ARTIFACTS = {
    cfb_games: 'football/cfb_terminal/games.json',
    cfb_brief: 'football/cfb_terminal/brief.json',
    rankings: 'football/rankings/current.json',
    nfl_slate: 'football/nfl/slate.json',
    nfl_injuries: 'football/injuries/nfl_2026.json',
    published: 'articles/data/published.json',
    market: 'articles/data/market/{season}-week-{ww}.json',
    evidence: 'football/evidence/packets.json'
  };

  function rankingsIndex(rk) {
    var out = { as_of: null, week: null, teams: {}, by_name: {}, conference_top: {} };
    if (!rk || !rk.teams) return out;
    out.as_of = rk.data_as_of || rk.generated_at || null;
    out.week = rk.week || null;
    Object.keys(rk.teams).forEach(function (k) {
      var t = rk.teams[k]; if (!t || !t.team) return;
      var mv = t.movement && t.movement.rank;
      var row = {
        key: k, team: t.team, conference: t.conference || null, rank: isNum(t.rank) ? t.rank : null,
        rating: isNum(t.etsr) ? r1(t.etsr) : null,
        rank_from: mv && isNum(mv.from) ? mv.from : null, rank_to: mv && isNum(mv.to) ? mv.to : null
      };
      out.teams[k] = row; out.by_name[t.team] = row;
    });
    /* each conference's top three by EdgeDesk rating */
    var conf = {};
    Object.keys(out.teams).forEach(function (k) { var t = out.teams[k]; if (t.conference && t.rank) (conf[t.conference] = conf[t.conference] || []).push(t); });
    Object.keys(conf).forEach(function (c) {
      conf[c].sort(function (a, b) { return a.rank - b.rank; });
      out.conference_top[c] = conf[c].slice(0, 3).map(function (t) { return t.team; });
    });
    return out;
  }

  function marketState(capturedAtMs, now, staleMinutes) {
    if (capturedAtMs == null) return { status: 'reference', age_minutes: null };
    var age = minutesBetween(capturedAtMs, now);
    return { status: age <= (staleMinutes || STALE_MINUTES) ? 'current' : 'stale', age_minutes: age };
  }

  /* model-vs-market gap from the home side (negative home_line = home favoured) */
  function gapOf(home, away, modelHomeLine, marketHomeLine) {
    if (!isNum(modelHomeLine) || !isNum(marketHomeLine)) return null;
    var g = marketHomeLine - modelHomeLine; /* >0: model likes home more than the market */
    var pts = r1(Math.abs(g));
    if (pts < 0.1) return { points: 0, toward: null, text: 'no gap' };
    var toward = g > 0 ? home : away;
    return { points: pts, toward: toward, text: oneDp(pts) + ' points toward ' + toward };
  }

  function favOf(home, away, homeLine) {
    if (!isNum(homeLine)) return null;
    if (Math.abs(homeLine) < 0.05) return { favorite: null, underdog: null, margin: 0 };
    return homeLine < 0 ? { favorite: home, underdog: away, margin: r1(-homeLine) } : { favorite: away, underdog: home, margin: r1(homeLine) };
  }

  function modelDisplay(home, away, homeLine, homeWinProb, proj) {
    var f = favOf(home, away, homeLine);
    var d = {};
    if (f && f.favorite) d.fair = f.favorite + ' by ' + oneDp(f.margin);
    else if (f) d.fair = 'a pick’em';
    if (isNum(homeWinProb)) {
      var favP = f && f.favorite === away ? 1 - homeWinProb : homeWinProb;
      var favT = f && f.favorite ? f.favorite : home;
      d.win = favT + ' ' + pct(favP);
      d.dog_win = (favT === home ? away : home) + ' ' + pct(1 - favP);
    }
    if (proj && isNum(proj.home) && isNum(proj.away)) {
      var hi = proj.home >= proj.away;
      d.score = (hi ? home + ' ' + oneDp(proj.home) + ', ' + away + ' ' + oneDp(proj.away) : away + ' ' + oneDp(proj.away) + ', ' + home + ' ' + oneDp(proj.home));
    }
    return d;
  }

  var BOOKS = { draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', 'cfbd consensus': 'CollegeFootballData consensus',
    espnbet: 'ESPN BET', bovada: 'Bovada', pinnacle: 'Pinnacle', betrivers: 'BetRivers', fanatics: 'Fanatics', 'hard rock bet': 'Hard Rock Bet' };
  function bookName(b) { if (!b) return null; var k = String(b).toLowerCase(); return BOOKS[k] || b; }
  function marketDisplay(m) {
    if (!m || m.status === 'none' || !isNum(m.home_line)) return null;
    var f = favOf(m.home, m.away, m.home_line);
    var line = f && f.favorite ? f.favorite + ' -' + lineNum(f.margin) : 'pick’em';
    var where = m.status === 'reference'
      ? 'consensus line from public schedule data, no sportsbook or capture time'
      : (m.book ? bookName(m.book) + ', ' : '') + 'captured ' + m.captured_text;
    return line + ' (' + where + ')';
  }

  function cfbPacket(g, rk, now, links) {
    var e = g.edgedesk || {}, m = g.market || {}, gm = g.game || {};
    var home = gm.home, away = gm.away;
    var kick = ts(g.kickoff);
    var model = { available: !!(e.available && isNum(e.fair_home_line)) };
    if (model.available) {
      var f = favOf(home, away, r1(e.fair_home_line));
      model.version = e.model_version || null;
      model.as_of = e.prediction_ts || null;
      model.home_line = r1(e.fair_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(e.home_win_prob) ? Math.round(e.home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(e.home_win_prob) ? Math.round((f.favorite === away ? 1 - e.home_win_prob : e.home_win_prob) * 100) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.fair_total = isNum(e.fair_total) ? r1(e.fair_total) : null;
      model.projected = e.projected_score && isNum(e.projected_score.home) ? { home: r1(e.projected_score.home), away: r1(e.projected_score.away) } : null;
      var fc = e.football_confidence;
      model.confidence = fc && isNum(fc.score) ? { score: Math.round(fc.score), label: fc.label || fc.tier || null } : null;
      model.reliability = g.data_quality && isNum(g.data_quality.reliability) ? Math.round(g.data_quality.reliability) : null;
    }
    /* the market: the freshest quote on file, judged against NOW, not the build */
    var best = null;
    (m.quotes || []).forEach(function (q) {
      var t = ts(q.observed_at); if (t == null || !isNum(q.home_line)) return;
      if (!best || t > best.t) best = { t: t, q: q };
    });
    var market = { status: 'none', home: home, away: away };
    if (best) {
      var st = marketState(best.t, now);
      market = {
        status: st.status, home: home, away: away, home_line: r1(best.q.home_line), book: best.q.book || null,
        captured_at: iso(best.t), captured_text: whenText(best.t), age_minutes: st.age_minutes,
        source_label: best.q.source || null
      };
    }
    var rH = rk.by_name[home] || null, rA = rk.by_name[away] || null;
    var drivers = ((g.why && g.why.rows) || []).filter(function (w) { return w && w.available !== false && isNum(w.points) && Math.abs(w.points) >= 0.5; })
      .sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 3)
      .map(function (w) { return { label: w.label, team: w.favors, points: r1(Math.abs(w.points)) }; });
    var matchup = (((g.matchup && g.matchup.cards) || []).filter(function (c) { return c && c.favors && (c.magnitude === 'large' || c.magnitude === 'moderate'); })
      .slice(0, 2).map(function (c) { return { label: c.label, favors: c.favors, magnitude: c.magnitude }; }));
    function qbOf(q) {
      if (!q || !q.player) return null;
      return { player: q.player, confirmed: !!q.confirmed, contested: !!q.contested, label: q.label || null };
    }
    var qb = { home: qbOf(g.qb && g.qb.home), away: qbOf(g.qb && g.qb.away) };
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if ((qb.home && !qb.home.confirmed) || (qb.away && !qb.away.confirmed)) flags.push('QB_UNCONFIRMED');
    if ((qb.home && qb.home.contested) || (qb.away && qb.away.contested)) flags.push('QB_CONTESTED');
    if (model.confidence && model.confidence.score < MIN_CONFIDENCE) flags.push('LOW_CONFIDENCE');
    if (!model.available) flags.push('NO_PROJECTION');
    var verification = g.disagreement && g.disagreement.verification ? g.disagreement.verification : null;
    if (verification === 'FAILED') flags.push('VERIFICATION_FAILED');
    if (kick != null && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kick == null ? null : whenText(kick),
      home: home, away: away, venue: gm.venue || null, neutral_site: !!gm.neutral_site,
      home_conference: gm.home_conference || null, away_conference: gm.away_conference || null,
      conference_game: gm.matchup_type === 'conference', fcs: !!gm.fcs,
      home_rank: rH ? rH.rank : null, away_rank: rA ? rA.rank : null,
      home_rank_from: rH ? rH.rank_from : null, away_rank_from: rA ? rA.rank_from : null,
      model: model, market: market, gap: gap,
      favorite_flip: !!(mfav && mfav.favorite && model.favorite && mfav.favorite !== model.favorite),
      drivers: drivers, matchup: matchup, qb: qb,
      risks: ((g.risks && g.risks.items) || []).map(function (r) { return r.text; }).filter(Boolean).slice(0, 3),
      unpriced: ((g.why && g.why.unpriced) || []).slice(0, 4),
      research_status: g.research_status ? { key: g.research_status.key, label: g.research_status.label } : null,
      decision: g.decision_status ? { key: g.decision_status.key, label: g.decision_status.label, reason: g.decision_status.reason || null } : null,
      price_note: g.summary && g.summary.price ? g.summary.price : null,
      verification: verification,
      flags: flags,
      link: links && links[String(g.game_id)] || null
    };
    p.display = modelDisplay(home, away, model.home_line, model.home_win_prob, model.projected);
    p.display.kickoff = p.kickoff_text;
    p.display.market = marketDisplay(market);
    p.display.gap = gap ? gap.text : null;
    if (model.fair_total != null) p.display.total = oneDp(model.fair_total);
    return p;
  }

  function nflRecord(results) {
    var w = 0, l = 0, t = 0;
    (results || []).forEach(function (r) { if (r.result === 'W') w++; else if (r.result === 'L') l++; else if (r.result === 'T') t++; });
    return (w + l + t) ? w + '-' + l + (t ? '-' + t : '') : null;
  }

  function nflPacket(g, slate, inj, quotes, now, links) {
    var home = g.home_team, away = g.away_team, kick = ts(g.kickoff);
    var model = { available: g.model_status === 'PREDICTED' && isNum(g.model_home_line) };
    if (model.available) {
      var f = favOf(home, away, r1(g.model_home_line));
      model.version = g.model_version || null;
      model.as_of = slate.generated_at || null;
      model.home_line = r1(g.model_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(g.model_home_win_prob) ? Math.round(g.model_home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(g.model_home_win_prob) ? Math.round((f.favorite === away ? 1 - g.model_home_win_prob : g.model_home_win_prob) * 100) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.fair_total = isNum(g.model_fair_total) ? r1(g.model_fair_total) : null;
      model.projected = null;
      /* the NFL model publishes no confidence score, by design */
      model.confidence = null;
      model.confidence_note = 'The NFL model publishes no confidence score; its record is graded against the closing line instead.';
      model.data_quality = g.data_quality && g.data_quality.status || null;
    }
    /* market: a captured sportsbook quote if one is on file, else the
       reference consensus (no book, no capture time) */
    var q = quotes && quotes[g.game_id];
    var market = { status: 'none', home: home, away: away };
    if (q && q.spread && isNum(q.spread.point)) {
      var t = ts(q.captured_at || q.spread.captured_at);
      var st = marketState(t, now);
      market = {
        status: st.status, home: home, away: away,
        home_line: r1(q.spread.side === 'home' ? q.spread.point : -q.spread.point),
        book: q.spread.book || null, captured_at: t == null ? null : iso(t), captured_text: t == null ? null : whenText(t),
        age_minutes: st.age_minutes, source_label: 'EdgeDesk odds capture'
      };
    } else if (g.reference_market && isNum(g.reference_market.home_line)) {
      market = {
        status: 'reference', home: home, away: away, home_line: r1(g.reference_market.home_line), book: null,
        captured_at: null, captured_text: null, age_minutes: null,
        source_label: 'nflverse schedule consensus (reference, not a price)', read_at: slate.generated_at || null
      };
    }
    var tH = slate.teams && slate.teams[g.home_code], tA = slate.teams && slate.teams[g.away_code];
    function injuriesOf(code, starterName) {
      var t = inj && inj.teams && inj.teams[code];
      if (!t || t.week !== g.week) return null;
      var players = (t.players || []);
      var out = players.filter(function (p) { return p.status === 'Out'; });
      var doubtful = players.filter(function (p) { return p.status === 'Doubtful'; });
      var qbs = players.filter(function (p) { return p.position === 'QB' && p.status; })
        .map(function (p) { return { name: p.name, status: p.status, injury: p.injury || null, starter: !!starterName && p.name === starterName }; });
      return { out_count: out.length, doubtful_count: doubtful.length, qbs: qbs, retrieved_at: inj.retrieved_at || null };
    }
    var hs = g.home_starter && g.home_starter.player_name, as = g.away_starter && g.away_starter.player_name;
    function scen(k) {
      var s = g.scenarios && g.scenarios[k];
      if (!s || !isNum(s.home_line)) return null;
      return { home_line: r1(s.home_line), home_win_prob: isNum(s.home_win_prob) ? Math.round(s.home_win_prob * 1000) / 1000 : null };
    }
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if (market.status === 'reference') flags.push('REFERENCE_LINE_ONLY');
    if (!model.available) flags.push('NO_PROJECTION');
    if (kick != null && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'nfl', game_id: g.game_id, season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kick == null ? null : whenText(kick),
      home: home, away: away, home_code: g.home_code, away_code: g.away_code, venue: g.venue || null,
      divisional: !!g.div_game, home_rest: isNum(g.home_rest) ? g.home_rest : null, away_rest: isNum(g.away_rest) ? g.away_rest : null,
      home_record: tH ? nflRecord(tH.results) : null, away_record: tA ? nflRecord(tA.results) : null,
      model: model, market: market, gap: gap,
      favorite_flip: !!(mfav && mfav.favorite && model.favorite && mfav.favorite !== model.favorite),
      qb: { home: hs ? { player: hs, confirmed: false, label: hs + ' is the listed starter in the schedule feed.' } : null,
            away: as ? { player: as, confirmed: false, label: as + ' is the listed starter in the schedule feed.' } : null },
      injuries: { home: injuriesOf(g.home_code, hs), away: injuriesOf(g.away_code, as) },
      scenarios: { home_qb_out: scen('home_qb_out'), away_qb_out: scen('away_qb_out') },
      flags: flags,
      link: links && links[String(g.game_id)] || null
    };
    p.display = modelDisplay(home, away, model.home_line, model.home_win_prob, null);
    p.display.kickoff = p.kickoff_text;
    p.display.market = marketDisplay(market);
    p.display.gap = gap ? gap.text : null;
    if (model.fair_total != null) p.display.total = oneDp(model.fair_total);
    return p;
  }

  /* art: { cfbGames, cfbBrief, rankings, nflSlate, nflInjuries, marketSnapshots: [..], published }
     opts: { now (ms), cfbWeek, nflWeek } */
  function fromArtifacts(art, opts) {
    opts = opts || {};
    art = art || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var links = {};
    var pub = art.published && (art.published.articles || art.published);
    if (Array.isArray(pub)) pub.forEach(function (a) { if (a && a.type !== 'postgame' && a.game_id && a.url) links[String(a.game_id)] = a.url; });
    var rk = rankingsIndex(art.rankings);
    var snap = { schema: 'edgedesk_content_research_v1', version: VERSION, built_at: iso(now), sources: [], cfb: null, nfl: null };

    /* ── CFB ── */
    var cg = art.cfbGames;
    if (cg && cg.games) {
      var all = Object.keys(cg.games).map(function (k) { return cg.games[k]; });
      var week = isNum(opts.cfbWeek) ? opts.cfbWeek : (art.cfbBrief && isNum(art.cfbBrief.week) ? art.cfbBrief.week : chooseWeek(all, now));
      var games = all.filter(function (g) { return g.week === week; })
        .map(function (g) { return cfbPacket(g, rk, now, links); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      attachEvidence(games, art.evidence && art.evidence.cfb);
      var fresh = games.filter(function (p) { return p.market.status === 'current'; }).length;
      var brief = art.cfbBrief || {};
      var cfbNames = {};
      Object.keys(rk.by_name).forEach(function (n) { cfbNames[n] = 1; });
      all.forEach(function (g) { if (g.game) { cfbNames[g.game.home] = 1; cfbNames[g.game.away] = 1; } });
      snap.cfb = {
        season: cg.season || null, week: week, generated_at: cg.generated_at || null,
        team_names: Object.keys(cfbNames).filter(Boolean).sort(),
        betting_enabled: !!(cg.decision && cg.decision.bet_enabled),
        operations_status: cg.operations && cg.operations.status || null,
        certified_bets: brief.counts && isNum(brief.counts.BET) ? brief.counts.BET : null,
        games_total: games.length, fresh_markets: fresh,
        typical_games_played: medianGamesPlayed(all.filter(function (g) { return g.week === week; })),
        rankings: { as_of: rk.as_of, week: rk.week, top: topTeams(rk, 25), conference_top: rk.conference_top },
        games: games
      };
      snap.sources.push({ id: 'cfb_terminal', path: ARTIFACTS.cfb_games, as_of: cg.generated_at || null, what: 'CFB projections, captured quotes, research and decision status' });
      if (art.rankings) snap.sources.push({ id: 'rankings', path: ARTIFACTS.rankings, as_of: rk.as_of, what: 'EdgeDesk team ratings and ranks' });
    }

    /* ── NFL ── */
    var ns = art.nflSlate;
    if (ns && Array.isArray(ns.games)) {
      var nweek = isNum(opts.nflWeek) ? opts.nflWeek : chooseWeek(ns.games, now);
      var quotes = {};
      (art.marketSnapshots || []).forEach(function (s) {
        (s && s.quotes || []).forEach(function (q) { if (q && q.sport === 'NFL' && q.game_id) quotes[q.game_id] = q; });
      });
      var ngames = ns.games.filter(function (g) { return g.week === nweek; })
        .map(function (g) { return nflPacket(g, ns, art.nflInjuries, quotes, now, links); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      attachEvidence(ngames, art.evidence && art.evidence.nfl);
      var nflNamesAll = {};
      ns.games.forEach(function (g) { nflNamesAll[g.home_team] = 1; nflNamesAll[g.away_team] = 1; });
      snap.nfl = {
        season: ns.season || null, week: nweek, generated_at: ns.generated_at || null,
        team_names: Object.keys(nflNamesAll).filter(Boolean).sort(),
        injuries_as_of: art.nflInjuries && art.nflInjuries.retrieved_at || null,
        games_total: ngames.length,
        fresh_markets: ngames.filter(function (p) { return p.market.status === 'current'; }).length,
        games: ngames
      };
      snap.sources.push({ id: 'nfl_slate', path: ARTIFACTS.nfl_slate, as_of: ns.generated_at || null, what: 'NFL projections and reference lines' });
      if (art.nflInjuries) snap.sources.push({ id: 'nfl_injuries', path: ARTIFACTS.nfl_injuries, as_of: art.nflInjuries.retrieved_at || null, what: 'Official NFL injury report (nflverse)' });
    }
    if (art.evidence) snap.sources.push({ id: 'evidence', path: ARTIFACTS.evidence, as_of: art.evidence.built_at || null, what: 'Football evidence packets: verified stats, availability, results and the model-versus-market explanation' });
    return snap;
  }

  /* one evidence packet per game (football/evidence/packets.json), and the
     underdog's best measured case for the upset lines */
  function attachEvidence(games, set) {
    var packets = (set && set.packets) || {};
    games.forEach(function (p) {
      var ev = packets[String(p.game_id)] || null;
      /* a packet built from older research than this page shows is refused,
         never mixed in: the gate then fails closed for the game */
      var off = function (a, b) { return isNum(a) !== isNum(b) || (isNum(a) && Math.abs(a - b) > 0.05); };
      if (ev && ((ev.model && off(ev.model.home_line, p.model && p.model.available ? p.model.home_line : null)) || (ev.market && ev.market.status !== 'none' && p.market && p.market.status !== 'none' && off(ev.market.home_line, p.market.home_line)))) {
        p.evidence_stale = 'the evidence packet was built from different numbers than this research (model or line changed since); rebuild with node tools/content/evidence.js build';
        ev = null;
      }
      p.evidence = ev;
      if (!ev || !p.model.available || !p.model.underdog) return;
      var dog = p.model.underdog;
      var best = (ev.claims || []).filter(function (c) { return c.football && c.measured && c.leans === dog && c.strength && c.topic !== 'results'; })
        .sort(function (a, b) { return ({ large: 3, moderate: 2, small: 1 }[b.strength] || 0) - ({ large: 3, moderate: 2, small: 1 }[a.strength] || 0); })[0];
      if (best) p.underdog_case = best.short || best.text;
    });
  }
  /* research copies: the full packet for a one-game piece, a trimmed one for
     a slate, none where a game is only listed */
  function withEv(list, mode) {
    var F = fe();
    return (list || []).map(function (p) {
      var c = Object.assign({}, p);
      if (mode === 'none') delete c.evidence;
      else if (mode === 'trim' && c.evidence && F) c.evidence = F.trim(c.evidence);
      return c;
    });
  }

  /* the week whose games are still to come: the earliest week with a game
     kicking off after now */
  function chooseWeek(games, now) {
    var best = null;
    games.forEach(function (g) {
      var t = ts(g.kickoff); if (t == null || t <= now || !isNum(g.week)) return;
      if (best == null || g.week < best) best = g.week;
    });
    return best;
  }
  function medianGamesPlayed(games) {
    var v = games.map(function (g) { return g.games_played && isNum(g.games_played.min) ? g.games_played.min : null; })
      .filter(isNum).sort(function (a, b) { return a - b; });
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }
  function topTeams(rk, n) {
    return Object.keys(rk.teams).map(function (k) { return rk.teams[k]; })
      .filter(function (t) { return isNum(t.rank) && t.rank <= n; })
      .sort(function (a, b) { return a.rank - b.rank; })
      .map(function (t) { return { team: t.team, rank: t.rank, rating: t.rating, conference: t.conference, rank_from: t.rank_from }; });
  }

  /* ======================================================================
     NEWS — public RSS headlines, attributed, never article bodies
     ====================================================================== */
  /* Feeds the publishers offer for exactly this use. Only the headline, the
     link, the time and the feed's own short description are kept. Nothing is
     fetched beyond the feed URL itself. */
  var FEEDS = [
    { id: 'espn_nfl', league: 'nfl', publisher: 'ESPN', url: 'https://www.espn.com/espn/rss/nfl/news' },
    { id: 'espn_cfb', league: 'cfb', publisher: 'ESPN', url: 'https://www.espn.com/espn/rss/ncf/news' },
    { id: 'cbs_nfl', league: 'nfl', publisher: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nfl/' },
    { id: 'cbs_cfb', league: 'cfb', publisher: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' },
    { id: 'yahoo_nfl', league: 'nfl', publisher: 'Yahoo Sports', url: 'https://sports.yahoo.com/nfl/rss/' },
    { id: 'yahoo_cfb', league: 'cfb', publisher: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss/' }
  ];

  function decodeEntities(s) {
    return String(s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/<[^>]+>/g, ' ')   /* markup that arrived entity-encoded is still markup */
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }
  function tag(block, name) {
    var m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
    return m ? m[1] : null;
  }
  function parseFeed(xml, feed, retrievedAt) {
    var items = [];
    var re = /<item[\s>][\s\S]*?<\/item>/gi, m;
    while ((m = re.exec(String(xml || ''))) && items.length < 60) {
      var b = m[0];
      var title = decodeEntities(tag(b, 'title'));
      var link = decodeEntities(tag(b, 'link') || tag(b, 'guid'));
      var pub = ts(decodeEntities(tag(b, 'pubDate') || tag(b, 'dc:date') || ''));
      if (!title || !/^https:\/\//.test(link)) continue;
      items.push({
        title: title.slice(0, 240), url: link.slice(0, 500),
        published_at: pub == null ? null : iso(pub),
        summary: decodeEntities(tag(b, 'description') || '').slice(0, 400) || null,
        publisher: feed && feed.publisher || null, feed: feed && feed.id || null, league: feed && feed.league || null,
        retrieved_at: retrievedAt || null
      });
    }
    return items;
  }

  /* [keyword, headline words] per kind of news */
  var NEWS_WORDS = { injury: ['injury', 'Injury Update'], qb_change: ['quarterback', 'Quarterback News'], trade: ['trade', 'Trade News'],
    coaching: ['coach', 'Coaching News'], ranking: ['ranking', 'Rankings News'], suspension: ['suspension', 'Suspension News'], general: ['news', 'News'] };
  var NEWS_KINDS = [
    ['injury', /\b(injur(?:y|ed|ies)|out for|ruled out|torn|acl|sprain|concussion|questionable|doubtful|ir\b|injured reserve|surgery)\b/i],
    ['qb_change', /\b(quarterback|qb|starter|starting|benched|bench)\b/i],
    ['trade', /\b(trade[sd]?|trading|acquir(?:e|es|ed)|deal for)\b/i],
    ['coaching', /\b(fire[sd]|hire[sd]?|coach(?:ing)? (?:search|change)|interim|coordinator|resign)/i],
    ['ranking', /\b(poll|rankings?|top 25|ap top|cfp|playoff)\b/i],
    ['suspension', /\b(suspend(?:ed|s)?|suspension|arrest(?:ed)?)\b/i]
  ];
  function classifyNews(title) {
    for (var i = 0; i < NEWS_KINDS.length; i++) if (NEWS_KINDS[i][1].test(title)) return NEWS_KINDS[i][0];
    return 'general';
  }

  /* NFL nicknames → full names, built from the slate itself */
  function nflNames(snap) {
    var out = {};
    ((snap.nfl && snap.nfl.games) || []).forEach(function (g) {
      [g.home, g.away].forEach(function (full) {
        out[full] = full;
        var nick = full.split(' ').slice(-1)[0];
        if (nick && nick.length > 3) out[nick] = full;
      });
    });
    return out;
  }
  /* Match each headline to the teams it names on this week's slate. A
     headline naming no slate team is dropped: the engine writes about what
     its research covers. */
  function matchNews(items, snap) {
    var nfl = nflNames(snap);
    var cfbTeams = {};
    ((snap.cfb && snap.cfb.games) || []).forEach(function (g) { cfbTeams[g.home] = 1; cfbTeams[g.away] = 1; });
    var out = [];
    (items || []).forEach(function (it) {
      var text = it.title + ' ' + (it.summary || '');
      var names = it.league === 'nfl' ? Object.keys(nfl) : Object.keys(cfbTeams);
      names.sort(function (a, b) { return b.length - a.length; });
      var found = [], rest = text;
      names.forEach(function (n) {
        var re = new RegExp('(^|[^A-Za-z])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])');
        if (re.test(rest)) { found.push(it.league === 'nfl' ? nfl[n] : n); rest = rest.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' '); }
      });
      found = uniq(found);
      if (!found.length) return;
      out.push(Object.assign({}, it, { teams: found, kind: classifyNews(it.title) }));
    });
    return out;
  }

  /* ======================================================================
     DISCOVER — opportunities, scored, each part with its basis
     ====================================================================== */
  function hoursUntil(t, now) { return t == null ? null : (t - now) / 3600000; }
  function timelinessScore(firstKick, now) {
    var h = hoursUntil(firstKick, now);
    if (h == null) return { score: 0, basis: 'no kickoff time on file' };
    if (h <= 0) return { score: 5, basis: 'the first game has already kicked off' };
    var s = h < 6 ? 55 : h <= 120 ? 100 - Math.max(0, h - 48) / 2 : clamp(100 - (h - 120) / 2, 20, 70);
    return { score: Math.round(clamp(s, 0, 100)), basis: 'first relevant kickoff in ' + Math.round(h) + ' hours (best 6–48 h before)' };
  }
  function interestCfb(p) {
    var s = 0, why = [];
    var top = function (r) { return isNum(r) && r <= 25; };
    if (top(p.home_rank) && top(p.away_rank)) { s += 45; why.push('two top-25 teams'); }
    else if (top(p.home_rank) || top(p.away_rank)) { s += 22; why.push('a top-25 team'); }
    if ((isNum(p.home_rank) && p.home_rank <= 10) || (isNum(p.away_rank) && p.away_rank <= 10)) { s += 10; why.push('a top-10 team'); }
    if (p.model.available && isNum(p.model.fav_win_pct)) {
      var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50;
      s += 25 * close; if (close > 0.6) why.push('a close projection');
    }
    if (p.conference_game && POWER4.indexOf(p.home_conference) >= 0) { s += 8; why.push('a power-conference game'); }
    if (p.favorite_flip) { s += 6; why.push('model and market disagree on the favorite'); }
    if (p.fcs) s -= 25;
    if (p.flags.indexOf('LOW_CONFIDENCE') >= 0 || !p.model.available) s -= 40;
    if (p.flags.indexOf('KICKED_OFF') >= 0) s -= 100;
    return { score: Math.round(s), why: why };
  }
  function interestNfl(p) {
    var s = 0, why = [];
    var t = ts(p.kickoff), et = t == null ? null : etParts(t);
    var prime = et && (et.weekday === 'Thu' || et.weekday === 'Mon' || (String(et.dayPeriod).toUpperCase() === 'PM' && +et.hour >= 8 && +et.hour < 12));
    if (prime) { s += 20; why.push('a prime-time game'); }
    if (p.model.available && isNum(p.model.fav_win_pct)) { var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50; s += 25 * close; if (close > 0.6) why.push('a close projection'); }
    var winning = function (rec) { if (!rec) return false; var a = rec.split('-'); return +a[0] > +a[1]; };
    if (winning(p.home_record) && winning(p.away_record)) { s += 15; why.push('two winning teams'); }
    else if (winning(p.home_record) || winning(p.away_record)) s += 7;
    if (p.divisional) { s += 8; why.push('a division game'); }
    if (p.gap && p.gap.points >= RESEARCH_GAP) { s += 6; why.push('model and line differ'); }
    if (!p.model.available) s -= 40;
    if (p.flags.indexOf('KICKED_OFF') >= 0) s -= 100;
    return { score: Math.round(s), why: why };
  }

  function rankGames(league, games) {
    var f = league === 'cfb' ? interestCfb : interestNfl;
    return games.map(function (p) { var i = f(p); return { p: p, interest: i.score, why: i.why }; })
      .filter(function (x) { return x.interest > -50; })
      .sort(function (a, b) { return b.interest - a.interest; });
  }

  function upsetsOf(league, games) {
    return games.filter(function (p) {
      if (!p.model.available || p.flags.indexOf('KICKED_OFF') >= 0 || !isNum(p.model.dog_win_pct)) return false;
      var flip = p.favorite_flip && p.market && p.market.status !== 'none';
      if (p.model.dog_win_pct < 30 || p.model.dog_win_pct >= 50) return false;
      if (p.model.dog_win_pct > 46 && !flip) return false;   /* a coin flip is not an upset */
      if (league === 'cfb') {
        var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
        return (isNum(favRank) && favRank <= 25) || flip;
      }
      /* NFL: the favorite must be a real favorite (3+ points) */
      return p.model.margin >= 3 || flip;
    }).sort(function (a, b) { return b.model.dog_win_pct - a.model.dog_win_pct; });
  }

  function conferenceRaces(snap) {
    var c = snap.cfb; if (!c) return [];
    var out = [];
    c.games.forEach(function (p) {
      if (!p.conference_game || !p.home_conference || p.flags.indexOf('KICKED_OFF') >= 0 || !p.model.available) return;
      var top = c.rankings.conference_top[p.home_conference] || [];
      if (top.indexOf(p.home) >= 0 && top.indexOf(p.away) >= 0) out.push(p);
    });
    return out;
  }

  function avgConfidence(games) {
    var v = games.map(function (p) { return p.model.confidence ? p.model.confidence.score : null; }).filter(isNum);
    return v.length ? Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length) : null;
  }

  /* publisher fit: does the profile want this sport, this category, this breadth? */
  function publisherFit(publisher, league, kind, breadth) {
    if (!publisher) return { score: 60, basis: 'no publisher selected: neutral fit' };
    var ed = publisher.editorial || {};
    var s = 40, why = [];
    var sports = (ed.preferred_sports || []).map(function (x) { return String(x).toLowerCase(); });
    if (!sports.length || sports.indexOf(league) >= 0) { s += 25; why.push(league.toUpperCase() + ' is a preferred sport'); }
    else why.push(league.toUpperCase() + ' is not in the preferred sports');
    var cats = ed.categories || [];
    if (!cats.length || cats.indexOf(kind) >= 0) { s += 20; why.push(KINDS[kind] + ' is a wanted category'); }
    if (ed.prefer_broad && breadth === 'broad') { s += 15; why.push('broad, searchable topic (preferred over single matchups)'); }
    if (ed.prefer_broad && breadth === 'narrow') { s -= 15; why.push('a single-matchup topic, which this publisher has found draws less interest'); }
    return { score: clamp(Math.round(s), 0, 100), basis: why.join('; ') };
  }

  /* search demand: measured only if Search Console rows match; else an estimate */
  function demandFor(keyword, kind, gsc) {
    var rows = (gsc && gsc[keyword]) || null;
    if (rows && isNum(rows.impressions) && rows.impressions > 0) {
      return {
        basis: 'search_console', measured: true,
        note: 'EdgeDesk’s own Search Console: ' + rows.impressions + ' impressions and ' + (rows.clicks || 0) + ' clicks over ' + (rows.days || 28)
          + ' days for queries containing “' + keyword + '”. This is EdgeDesk’s own search exposure, not total search volume.',
        evidence: rows
      };
    }
    var est = { weekly_preview: 'high', upset_watch: 'medium', conference_race: 'medium', market_discrepancy: 'low', injury_impact: 'medium', trending_story: 'medium', matchup_analysis: 'medium' }[kind] || 'medium';
    return {
      basis: 'estimate', measured: false, level: est,
      note: 'ESTIMATE, not measured search volume: “' + keyword + '” follows a query pattern that recurs every week of the season. '
        + 'No keyword-volume data source is connected; connect Search Console data to replace this with EdgeDesk’s own measured impressions.'
    };
  }

  function score(parts) {
    var total = 0;
    Object.keys(SCORE_WEIGHTS).forEach(function (k) { total += SCORE_WEIGHTS[k] * ((parts[k] && parts[k].score) || 0); });
    return Math.round(total);
  }

  /* the formats an opportunity can honestly fill: a weekly slate is not a
     news story, and one game is not a slate */
  function formatsFor(o) {
    var R = o.research || {};
    if (o.kind === 'trending_story' || o.kind === 'injury_impact') return ['trending_story', 'publisher_custom'];
    if (o.kind === 'market_discrepancy' && (R.games || []).length === 1) return ['market_discrepancy', 'matchup_analysis', 'edgedesk_analysis'];
    if (o.kind === 'matchup_analysis') return ['matchup_analysis', 'edgedesk_analysis'];
    return [o.league + '_weekly_preview', 'publisher_custom'];
  }
  function baseFormatOf(o, format) {
    var f = formatsFor(o);
    if (f.indexOf(format) < 0) format = f[0];
    return format === 'publisher_custom' ? f[0] : format;
  }
  /* formats about ONE game: the gate holds them to the single-game standard */
  var SINGLE_GAME = { matchup_analysis: true, edgedesk_analysis: true, market_discrepancy: true, trending_story: true };
  function isFirstParty(format) { return !!(FORMATS[format] && FORMATS[format].first_party);
  }

  function mkOpp(o) {
    o.formats = formatsFor(o);
    o.key = [o.league, o.season, 'w' + o.week, o.kind, o.slug_part || ''].join(':').replace(/:$/, '');
    o.priority = score(o.scores);
    o.scores.total = o.priority;
    delete o.slug_part;
    return o;
  }

  /* opts: { now, publisher, news: [items from matchNews], gsc: {keyword: {impressions, clicks, days}} } */
  function discover(snap, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var pub = opts.publisher || null;
    var out = [];

    ['cfb', 'nfl'].forEach(function (league) {
      var L = snap[league]; if (!L || !L.games || !L.games.length) return;
      var upcoming = L.games.filter(function (p) { return p.flags.indexOf('KICKED_OFF') < 0 && p.model.available; });
      if (!upcoming.length) return;
      var ranked = rankGames(league, upcoming);
      var firstKick = Math.min.apply(null, upcoming.map(function (p) { return ts(p.kickoff) || Infinity; }));
      var lastKick = Math.max.apply(null, upcoming.map(function (p) { return ts(p.kickoff) || 0; }));
      var Lname = league === 'cfb' ? 'College Football' : 'NFL';
      var conf = avgConfidence(upcoming);
      var limitations = [];
      if (L.fresh_markets === 0) limitations.push('No game has a sportsbook price from the last three hours; market comparisons use older captured lines, labelled with their capture time.');
      else if (L.fresh_markets < upcoming.length / 2) limitations.push('Only ' + L.fresh_markets + ' of ' + L.games_total + ' games this week had a sportsbook price from the last three hours when this research was read.');
      if (league === 'cfb' && L.betting_enabled === false) limitations.push('EdgeDesk’s college decision engine is not certifying bets this week; nothing here is a betting card.');
      if (league === 'nfl') limitations.push('The NFL model publishes no confidence score; its lines are compared with captured or reference lines, each labelled.');

      /* 1 · weekly preview */
      var feature = ranked.slice(0, 6).map(function (x) { return x.p; });
      var kw = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' predictions';
      var demand = demandFor(kw, 'weekly_preview', opts.gsc);
      var researchAvail = Math.round(100 * upcoming.length / Math.max(1, L.games_total));
      out.push(mkOpp({
        league: league, season: L.season, week: L.week, kind: 'weekly_preview',
        title: Lname + ' Week ' + L.week + ' Predictions',
        angle: 'A broad preview of the week’s biggest games: EdgeDesk’s projections, the closest calls and the realistic upsets, explained for fans.',
        summary: feature.length + ' featured games from ' + upcoming.length + ' projected; headliner ' + feature[0].away + ' at ' + feature[0].home + '.',
        teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
        research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekly_preview', context: contextOf(snap, league), games: withEv(feature, 'trim'), upsets: withEv(upsetsOf(league, upcoming).slice(0, 3), 'none'), races: withEv(league === 'cfb' ? conferenceRaces(snap).slice(0, 3) : [], 'none'), limitations: limitations },
        sources: sourcesOf(snap, league),
        demand: demand,
        formats: [league + '_weekly_preview', 'publisher_custom'],
        scores: {
          search_relevance: { score: demand.measured ? 95 : 85, basis: demand.measured ? 'measured Search Console exposure for the query' : 'estimate: “week N predictions” is a recurring high-intent query pattern' },
          timeliness: timelinessScore(firstKick, now),
          audience_interest: { score: clamp(50 + ranked.slice(0, 6).reduce(function (a, x) { return a + Math.max(0, x.interest); }, 0) / 12, 0, 100) | 0, basis: 'featured games include ' + sentenceList(uniq([].concat.apply([], ranked.slice(0, 6).map(function (x) { return x.why; }))).slice(0, 4)) },
          research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games have a current EdgeDesk projection' },
          editorial_relevance: { score: 90, basis: 'projections for every featured game, explained as research rather than picks' },
          publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
          research_confidence: { score: confidenceScore(conf, L, league), basis: confidenceBasis(conf, L, league) }
        },
        expires_at: iso(lastKick)
      }));

      /* 2 · upset watch */
      var ups = upsetsOf(league, upcoming);
      if (ups.length >= 2) {
        var kw2 = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' upset picks';
        kw2 = kw2.replace(' picks', ' predictions');
        var d2 = demandFor(kw2, 'upset_watch', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'upset_watch',
          title: Lname + ' Week ' + L.week + ' Upset Watch',
          angle: 'The underdogs EdgeDesk’s model gives a real chance — and why a likely loser is still not a bet.',
          summary: ups.length + ' underdogs with a 30%-plus projected chance; best: ' + ups[0].model.underdog + ' (' + ups[0].model.dog_win_pct + '%).',
          teams: uniq([].concat.apply([], ups.slice(0, 4).map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'upset_watch', context: contextOf(snap, league), games: withEv(ups.slice(0, 4), 'trim'), upsets: withEv(ups.slice(0, 4), 'none'), races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d2,
          formats: [league + '_weekly_preview', 'publisher_custom'],
          scores: {
            search_relevance: { score: d2.measured ? 85 : 72, basis: d2.measured ? 'measured Search Console exposure' : 'estimate: weekly “upsets” queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(55 + Math.min(ups.length, 5) * 6, 0, 100), basis: ups.length + ' credible underdogs' + (league === 'cfb' ? ' against ranked favorites' : '') },
            research_availability: { score: 90, basis: 'every underdog has a model win probability' },
            editorial_relevance: { score: 85, basis: 'separates “could win” from “worth a bet”, which is the EdgeDesk distinction' },
            publisher_fit: publisherFit(pub, league, 'upset_watch', 'broad'),
            research_confidence: { score: confidenceScore(avgConfidence(ups), L, league), basis: confidenceBasis(avgConfidence(ups), L, league) }
          },
          expires_at: iso(lastKick)
        }));
      }

      /* 3 · conference races (CFB) */
      if (league === 'cfb') {
        var races = conferenceRaces(snap);
        var byConf = {};
        races.forEach(function (p) { (byConf[p.home_conference] = byConf[p.home_conference] || []).push(p); });
        Object.keys(byConf).forEach(function (cname) {
          var gs = byConf[cname];
          var kw3 = cname.toLowerCase() + ' championship race';
          var d3 = demandFor(kw3, 'conference_race', opts.gsc);
          var k0 = ts(gs[0].kickoff);
          out.push(mkOpp({
            league: league, season: L.season, week: L.week, kind: 'conference_race', slug_part: slugify(cname),
            title: cname + ' Championship Race: What Week ' + L.week + ' Could Decide',
            angle: 'Games between the conference’s highest-rated teams in EdgeDesk’s ratings, and what the projections say about the title race.',
            summary: gs.map(function (p) { return p.away + ' at ' + p.home; }).join('; '),
            teams: uniq([].concat.apply([], gs.map(function (p) { return [p.home, p.away]; }))),
            research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'conference_race', conference: cname, conference_top: L.rankings.conference_top[cname] || [], context: contextOf(snap, league), games: withEv(gs, 'trim'), upsets: [], races: withEv(gs, 'none'), limitations: limitations },
            sources: sourcesOf(snap, league), demand: d3,
            formats: ['cfb_weekly_preview', 'publisher_custom'],
            scores: {
              search_relevance: { score: d3.measured ? 80 : 62, basis: d3.measured ? 'measured Search Console exposure' : 'estimate: conference-race queries peak in October and November' },
              timeliness: timelinessScore(k0, now),
              audience_interest: { score: clamp(50 + gs.length * 15, 0, 100), basis: gs.length + ' game(s) between top-three teams in the ' + cname },
              research_availability: { score: 85, basis: 'projections and EdgeDesk ratings for each team; no conference standings feed is connected' },
              editorial_relevance: { score: 75, basis: 'implications rather than predictions alone' },
              publisher_fit: publisherFit(pub, league, 'conference_race', 'broad'),
              research_confidence: { score: confidenceScore(avgConfidence(gs), L, league), basis: confidenceBasis(avgConfidence(gs), L, league) }
            },
            expires_at: iso(Math.max.apply(null, gs.map(function (p) { return ts(p.kickoff) || 0; })))
          }));
        });
      }

      /* 4 · market discrepancies: model vs market where a price exists */
      var gaps = upcoming.filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none'; })
        .sort(function (a, b) { var fa = a.market.status === 'current' ? 1 : 0, fb = b.market.status === 'current' ? 1 : 0; return fb - fa || b.gap.points - a.gap.points; });
      if (league === 'nfl' && gaps.length >= 3) {
        var kw4 = 'nfl week ' + L.week + ' predictions vs spread';
        var d4 = demandFor(kw4, 'market_discrepancy', opts.gsc);
        var anyCurrent = gaps.some(function (p) { return p.market.status === 'current'; });
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'market_discrepancy', slug_part: 'slate',
          title: 'NFL Week ' + L.week + ': Matchups Where the Numbers Tell a Different Story',
          angle: 'Where EdgeDesk’s projection and the betting line disagree by two points or more — and why a disagreement is a research question, not a bet.',
          summary: gaps.length + ' games with a gap of 2+ points; largest ' + gaps[0].away + ' at ' + gaps[0].home + ' (' + gaps[0].gap.text + ').',
          teams: uniq([].concat.apply([], gaps.slice(0, 5).map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: withEv(gaps.slice(0, 5), 'trim'), upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d4,
          formats: ['nfl_weekly_preview', 'market_discrepancy', 'publisher_custom'],
          scores: {
            search_relevance: { score: d4.measured ? 80 : 70, basis: d4.measured ? 'measured Search Console exposure' : 'estimate: weekly spread-prediction queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(50 + gaps.length * 6, 0, 100), basis: gaps.length + ' games where the numbers differ' },
            research_availability: { score: anyCurrent ? 85 : 55, basis: anyCurrent ? 'at least one current captured price' : 'only stale or reference lines: every comparison is labelled with its age' },
            editorial_relevance: { score: 85, basis: 'EdgeDesk’s independent number against the consensus is the brand’s core research' },
            publisher_fit: publisherFit(pub, league, 'market_discrepancy', 'broad'),
            research_confidence: { score: anyCurrent ? 60 : 40, basis: anyCurrent ? 'current prices on part of the slate' : 'no current price: the gaps describe a line that may have moved' }
          },
          expires_at: iso(lastKick)
        }));
      }
      gaps.filter(function (p) { return league === 'cfb' && p.market.status === 'current'; }).slice(0, 3).forEach(function (p) {
        var verified = p.verification !== 'FAILED';
        var kw5 = slugify(p.away + ' vs ' + p.home).replace(/-/g, ' ') + ' prediction';
        var d5 = demandFor(kw5, 'market_discrepancy', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'market_discrepancy', slug_part: String(p.game_id),
          title: p.away + ' vs. ' + p.home + ' Prediction: Model vs. Line',
          angle: verified ? 'An accessible explanation of a model-versus-market gap with a current price.'
            : 'A large gap EdgeDesk’s own integrity checks do not yet trust — and why missing information is the likelier explanation.',
          summary: 'Model ' + p.display.fair + ' vs. market ' + (p.display.market || '?') + ' — ' + p.gap.text + '.',
          teams: [p.home, p.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: [p], upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d5,
          formats: ['market_discrepancy', 'publisher_custom'],
          scores: {
            search_relevance: { score: d5.measured ? 70 : 35, basis: d5.measured ? 'measured Search Console exposure' : 'estimate: a single-matchup query, narrower than a weekly preview' },
            timeliness: timelinessScore(ts(p.kickoff), now),
            audience_interest: { score: clamp(30 + Math.max(0, interestCfb(p).score) / 2, 0, 100) | 0, basis: 'single game' + (interestCfb(p).why.length ? ': ' + interestCfb(p).why.join(', ') : '') },
            research_availability: { score: 90, basis: 'current captured price and full research packet' },
            editorial_relevance: { score: verified ? 85 : 70, basis: verified ? 'a verified disagreement' : 'a disagreement that failed verification: honest, but explain it as unresolved' },
            publisher_fit: publisherFit(pub, league, 'market_discrepancy', 'narrow'),
            research_confidence: { score: verified ? 70 : 35, basis: verified ? 'gap passed the integrity checks' : 'gap failed EdgeDesk’s verification check' }
          },
          expires_at: iso(ts(p.kickoff))
        }));
      });

      /* 4b · matchup analysis: one game, researched in full — the week's
         headliners and every game where EdgeDesk and the line are far apart.
         A stale line does not disqualify it (the piece says how old the line
         is); a missing evidence packet does. */
      var bigGap = league === 'cfb' ? 7 : 4;
      var maGames = ranked.slice(0, 2).map(function (x) { return x.p; });
      upcoming.filter(function (p) { return p.gap && p.gap.points >= bigGap && p.market.status !== 'none'; })
        .sort(function (a, b) { return b.gap.points - a.gap.points; }).slice(0, 3)
        .forEach(function (p) { if (maGames.indexOf(p) < 0) maGames.push(p); });
      maGames.filter(function (p) { return p.evidence && p.evidence.explanation; }).forEach(function (p) {
        var X = p.evidence.explanation;
        var big = p.gap && p.gap.points >= bigGap;
        var kw8 = slugify(p.away + ' vs ' + p.home).replace(/-/g, ' ') + ' prediction';
        var d8 = demandFor(kw8, 'matchup_analysis', opts.gsc);
        var cov = (p.evidence.coverage || []).filter(function (c) { return c.status !== 'MISSING'; }).length;
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'matchup_analysis', slug_part: String(p.game_id),
          title: p.away + ' vs. ' + p.home + (X.headline_question ? ': ' + X.headline_question : ' Preview'),
          angle: big && X.status === 'UNEXPLAINED'
            ? 'A full football read of a game where EdgeDesk and the line are ' + oneDp(p.gap.points) + ' points apart — the evidence on both sides, and an honest account of why EdgeDesk cannot yet explain the gap.'
            : 'A full football read of one of the week’s biggest games: the quarterbacks, the matchups and what has to happen on the field.',
          summary: 'Model ' + p.display.fair + (p.display.market ? ' vs. ' + p.display.market : '') + ' — ' + String(X.status || '').replace(/_/g, ' ').toLowerCase() + (X.input_suspect ? ', inputs suspect' : ''),
          teams: [p.home, p.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'matchup_analysis', context: contextOf(snap, league), games: withEv([p], 'full'), upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: d8,
          formats: ['matchup_analysis', 'edgedesk_analysis'],
          scores: {
            search_relevance: { score: d8.measured ? 80 : 55, basis: d8.measured ? 'measured Search Console exposure' : 'estimate: “team vs team prediction” queries spike in game week' },
            timeliness: timelinessScore(ts(p.kickoff), now),
            audience_interest: { score: clamp(40 + Math.max(0, (league === 'cfb' ? interestCfb(p) : interestNfl(p)).score) / 2 + (big ? 10 : 0), 0, 100) | 0, basis: (big ? 'a ' + oneDp(p.gap.points) + '-point model-versus-line gap; ' : '') + 'a featured game' },
            research_availability: { score: clamp(Math.round(100 * cov / Math.max(1, (p.evidence.coverage || []).length)), 0, 100), basis: cov + ' of ' + (p.evidence.coverage || []).length + ' research items available in the evidence packet' },
            editorial_relevance: { score: 90, basis: 'football evidence on both sides, with the model explained in football terms' },
            publisher_fit: publisherFit(pub, league, 'matchup_analysis', 'narrow'),
            research_confidence: { score: X.input_suspect ? 40 : (X.status === 'UNEXPLAINED' ? 50 : 70), basis: 'explanation status ' + X.status + (X.input_suspect ? '; EdgeDesk’s inputs are suspect' : '') }
          },
          expires_at: iso(ts(p.kickoff))
        }));
      });

      /* 5 · injury implications (NFL): a listed starting QB on the report */
      if (league === 'nfl') {
        upcoming.forEach(function (p) {
          ['home', 'away'].forEach(function (side) {
            var inj = p.injuries && p.injuries[side];
            var q = inj && inj.qbs && inj.qbs.filter(function (x) { return x.starter && x.status !== 'Active'; })[0];
            var sc = p.scenarios && p.scenarios[side + '_qb_out'];
            if (!q || !sc) return;
            var team = side === 'home' ? p.home : p.away;
            var kw6 = (q.name + ' injury').toLowerCase();
            var d6 = demandFor(kw6, 'injury_impact', opts.gsc);
            out.push(mkOpp({
              league: league, season: L.season, week: L.week, kind: 'injury_impact', slug_part: slugify(q.name),
              title: q.name + ' Injury: What It Means for the ' + team,
              angle: 'What the official injury report says, and how EdgeDesk’s projection changes if the starter does not play.',
              summary: q.name + ' (' + q.status + (q.injury ? ', ' + q.injury : '') + ') — model scenario available.',
              teams: [p.home, p.away],
              research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'injury_impact', focus: { side: side, team: team, player: q.name, status: q.status, injury: q.injury }, context: contextOf(snap, league), games: [p], upsets: [], races: [], limitations: limitations },
              sources: sourcesOf(snap, league), demand: d6,
              formats: ['trending_story', 'publisher_custom'],
              scores: {
                search_relevance: { score: d6.measured ? 85 : 75, basis: d6.measured ? 'measured Search Console exposure' : 'estimate: starting-quarterback injury queries spike in game week' },
                timeliness: timelinessScore(ts(p.kickoff), now),
                audience_interest: { score: 80, basis: 'a starting quarterback on the official injury report' },
                research_availability: { score: 90, basis: 'official injury report plus the model’s quarterback-out scenario' },
                editorial_relevance: { score: 85, basis: 'quantifies an injury’s effect instead of guessing' },
                publisher_fit: publisherFit(pub, league, 'injury_impact', 'broad'),
                research_confidence: { score: 65, basis: 'scenario re-runs the engine with one input changed; the replacement’s level is the club’s carried level' }
              },
              expires_at: iso(ts(p.kickoff))
            }));
          });
        });
      }

      /* 6 · trending stories: attributed headlines matched to this slate */
      (opts.news || []).filter(function (n) { return n.league === league; }).forEach(function (n) {
        var games = upcoming.filter(function (p) { return n.teams.indexOf(p.home) >= 0 || n.teams.indexOf(p.away) >= 0; });
        if (!games.length) return;
        var pubT = ts(n.published_at), ageH = pubT == null ? null : (now - pubT) / 3600000;
        if (ageH != null && ageH > 72) return;
        var team = n.teams[0];
        var kw7 = (team + ' ' + (n.kind === 'general' ? 'news' : n.kind.replace('_', ' '))).toLowerCase();
        var d7 = demandFor(kw7, 'trending_story', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'trending_story', slug_part: hash(n.url).slice(0, 10),
          title: team + ' ' + (NEWS_WORDS[n.kind] || NEWS_WORDS.general)[1] + ': What It Means for Week ' + L.week,
          angle: 'Attributed reporting (' + n.publisher + ') read against EdgeDesk’s numbers for ' + team + '’s next game.',
          summary: n.publisher + ': “' + n.title + '”',
          teams: uniq([].concat.apply([], games.map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'trending_story', news: [n], context: contextOf(snap, league), games: withEv(games.slice(0, 1), 'trim'), upsets: [], races: [], limitations: limitations },
          sources: [{ kind: 'external_report', publisher: n.publisher, title: n.title, url: n.url, published_at: n.published_at, retrieved_at: n.retrieved_at }].concat(sourcesOf(snap, league)),
          demand: d7,
          formats: ['trending_story', 'publisher_custom'],
          scores: {
            search_relevance: { score: d7.measured ? 85 : 60, basis: d7.measured ? 'measured Search Console exposure' : 'estimate: a named team in a current headline' },
            timeliness: ageH == null ? { score: 40, basis: 'the feed gave no publication time' } : { score: Math.round(clamp(100 - ageH * 2, 10, 100)), basis: 'reported ' + Math.round(ageH) + ' hours ago' },
            audience_interest: { score: n.kind === 'general' ? 55 : 75, basis: n.kind === 'general' ? 'a general headline' : 'a ' + n.kind.replace('_', ' ') + ' story' },
            research_availability: { score: 75, basis: 'EdgeDesk has a projection for ' + team + '’s next game; the reported facts themselves are the outlet’s' },
            editorial_relevance: { score: 70, basis: 'reporting is attributed; EdgeDesk adds its numbers, clearly separated' },
            publisher_fit: publisherFit(pub, league, 'trending_story', 'broad'),
            research_confidence: { score: 55, basis: 'only the headline is verified (by its source); details beyond it are not used' }
          },
          expires_at: iso(Math.min(ts(games[0].kickoff) || Infinity, (pubT || now) + 72 * 3600000))
        }));
      });
    });

    out.forEach(function (o) { o.seo = seoBrief(o, pub); o.discovered_at = iso(now); });
    out.sort(function (a, b) { return b.priority - a.priority; });
    return out;
  }

  function confidenceScore(avg, L, league) {
    var s = league === 'nfl' ? 55 : (isNum(avg) ? avg : 50);
    if (L.fresh_markets === 0) s -= 10;
    if (league === 'cfb' && L.operations_status === 'CRITICAL') s -= 5;
    return clamp(Math.round(s), 0, 100);
  }
  function confidenceBasis(avg, L, league) {
    var b = [];
    if (league === 'nfl') b.push('the NFL model publishes no confidence score; data-quality status is used');
    else if (isNum(avg)) b.push('average model confidence ' + avg + '/100');
    if (L.fresh_markets === 0) b.push('no current prices');
    if (league === 'cfb' && L.operations_status === 'CRITICAL') b.push('CFB operations status CRITICAL');
    return b.join('; ');
  }
  function contextOf(snap, league) {
    var L = snap[league];
    if (league === 'cfb') {
      return {
        league: 'cfb', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets,
        betting_enabled: L.betting_enabled, certified_bets: L.certified_bets, operations_status: L.operations_status,
        typical_games_played: L.typical_games_played, rankings_as_of: L.rankings.as_of,
        top10: L.rankings.top.slice(0, 10), generated_at: L.generated_at, team_names: L.team_names
      };
    }
    return { league: 'nfl', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets, injuries_as_of: L.injuries_as_of, generated_at: L.generated_at, team_names: L.team_names };
  }
  function sourcesOf(snap, league) {
    return snap.sources.filter(function (s) { return league === 'cfb' ? (s.id === 'cfb_terminal' || s.id === 'rankings') : (s.id === 'nfl_slate' || s.id === 'nfl_injuries'); })
      .map(function (s) { return { kind: 'edgedesk_research', label: s.what, path: s.path, url: SITE + '/' + s.path, as_of: s.as_of }; });
  }

  /* ======================================================================
     SEO — the brief
     ====================================================================== */
  function seoBrief(o, publisher) {
    var L = o.league === 'cfb' ? 'College Football' : 'NFL';
    var l = o.league === 'cfb' ? 'college football' : 'nfl';
    var w = o.week;
    var R = o.research || {};
    var g0 = (R.games || [])[0];
    var head = g0 ? g0.away + ' vs. ' + g0.home : null;
    var b = { primary_keyword: null, secondary_keywords: [], intent: 'informational', headline: o.title, alternatives: [], structure: [] };
    switch (o.kind) {
      case 'weekly_preview':
        b.primary_keyword = l + ' week ' + w + ' predictions';
        b.secondary_keywords = [l + ' week ' + w + ' preview', l + ' week ' + w + ' upsets', (o.league === 'cfb' ? 'cfb' : 'nfl') + ' week ' + w + ' projections', head ? slugify(head).replace(/-/g, ' ') + ' prediction' : null, l + ' week ' + w + ' games to watch'].filter(Boolean);
        b.headline = L + ' Week ' + w + ' Predictions: ' + ((R.upsets || []).length ? 'Biggest Games and Potential Upsets' : 'The Games That Matter Most');
        b.alternatives = [
          L + ' Week ' + w + ' Predictions: ' + (o.league === 'nfl' ? 'Five Matchups Where the Numbers Tell a Different Story' : 'What EdgeDesk’s Model Expects'),
          L + ' Week ' + w + ' Preview: ' + (head ? head + ' Headlines a Big Weekend' : 'The Games That Matter Most'),
          'Week ' + w + ' ' + L + ' Projections: Favorites, Close Calls and Upset Alerts'
        ];
        b.structure = ['Intro: the headline game and why this week matters', 'How to read projections (not picks)', 'Game-by-game capsules (H3 per game)', 'Upset watch', o.league === 'cfb' ? 'Conference-race implications' : 'Where the numbers differ from the line', 'What the numbers can’t see', 'Bottom line'];
        break;
      case 'upset_watch':
        b.primary_keyword = l + ' week ' + w + ' upsets';
        b.secondary_keywords = [l + ' week ' + w + ' upset predictions', l + ' week ' + w + ' underdogs', l + ' week ' + w + ' predictions'];
        b.headline = L + ' Week ' + w + ' Upset Watch: The Underdogs With a Real Chance';
        b.alternatives = ['Week ' + w + ' ' + L + ' Upsets: Where the Model Sees an Opening', L + ' Week ' + w + ': Underdogs EdgeDesk’s Model Won’t Count Out'];
        b.structure = ['Intro', 'How to read win chances', 'Each underdog (H3)', 'Why a likely loser is not a bet', 'Bottom line'];
        break;
      case 'conference_race':
        b.primary_keyword = String(R.conference || '').toLowerCase() + ' championship race';
        b.secondary_keywords = [String(R.conference || '').toLowerCase() + ' title race', String(R.conference || '').toLowerCase() + ' week ' + w + ' predictions', String(R.conference || '').toLowerCase() + ' power rankings'];
        b.headline = o.title;
        b.alternatives = [R.conference + ' Title Race: The Week ' + w + ' Games That Matter Most', 'What Week ' + w + ' Means for the ' + R.conference + ' Race'];
        b.structure = ['Intro', 'Who leads EdgeDesk’s ratings in the conference', 'The key games (H3)', 'What the numbers can’t see', 'Bottom line'];
        break;
      case 'market_discrepancy':
        b.primary_keyword = o.league === 'nfl' ? 'nfl week ' + w + ' predictions vs spread' : (head ? slugify(head).replace(/-/g, ' ') + ' prediction' : l + ' prediction');
        b.headline = o.league === 'nfl' ? 'NFL Week ' + w + ' Predictions vs. the Spread: Where the Numbers Disagree' : (head ? head + ' Prediction: Model vs. Line' : o.title);
        b.secondary_keywords = o.league === 'nfl' ? ['nfl week ' + w + ' model predictions', 'nfl week ' + w + ' spreads', 'nfl week ' + w + ' predictions'] : [head ? slugify(head).replace(/-/g, ' ') + ' odds' : null, head ? slugify(head).replace(/-/g, ' ') + ' spread' : null].filter(Boolean);
        b.intent = 'informational (comparison)';
        b.alternatives = [o.league === 'nfl' ? 'NFL Week ' + w + ' Predictions: ' + cap(numWord(Math.min(5, (R.games || []).length))) + ' Games Where the Numbers Tell a Different Story' : (head + ': Why the Model and the Line Disagree'), 'Why EdgeDesk and the Sportsbooks See ' + (head || 'This Game') + ' Differently'];
        b.structure = ['Intro', 'The gap, with capture times', 'Why the numbers differ (drivers)', 'How to read a disagreement (not a bet)', 'The case for the market', 'Bottom line'];
        break;
      case 'matchup_analysis':
        var X0 = g0 && g0.evidence && g0.evidence.explanation || {};
        b.primary_keyword = head ? slugify(head).replace(/-/g, ' ') + ' prediction' : l + ' prediction';
        b.secondary_keywords = head ? [slugify(head).replace(/-/g, ' ') + ' preview', slugify(head).replace(/-/g, ' ') + ' odds', g0.away.toLowerCase() + ' ' + g0.home.toLowerCase() + ' key matchups'] : [];
        b.headline = head ? head + (X0.headline_question ? ': ' + X0.headline_question : ' Prediction and Preview') : o.title;
        b.alternatives = head ? [head + ' Prediction: ' + (X0.status === 'UNEXPLAINED' ? 'Why EdgeDesk’s Number Is So Far From the Line' : 'The Matchups That Decide It'), head + ': The Football Case for Each Side'] : [];
        b.intent = 'informational (analysis)';
        b.structure = ['Opening: why the matchup matters', 'What EdgeDesk sees differently', 'The football evidence (quarterbacks, units, personnel, history)', 'What could make EdgeDesk wrong', 'What has to happen on the field', 'What to watch and what remains uncertain'];
        break;
      case 'injury_impact':
        b.primary_keyword = String((R.focus && R.focus.player) || '').toLowerCase() + ' injury';
        b.headline = (R.focus && R.focus.player) + ' Injury: What It Means for the ' + (R.focus && R.focus.team);
        b.secondary_keywords = [String((R.focus && R.focus.player) || '').toLowerCase() + ' injury update', String((R.focus && R.focus.team) || '').toLowerCase() + ' quarterback', head ? slugify(head).replace(/-/g, ' ') + ' prediction' : null].filter(Boolean);
        b.intent = 'informational (news)';
        b.alternatives = [R.focus && (R.focus.team + ' Without ' + R.focus.player + '? What EdgeDesk’s Model Says'), head && (head + ': How the Injury Report Moves the Projection')].filter(Boolean);
        b.structure = ['Intro', 'What the injury report says (attributed)', 'What the model says with and without the starter', 'What we don’t know yet', 'Bottom line'];
        break;
      default:
        var nw = (R.news || [])[0];
        var nk = nw ? NEWS_WORDS[nw.kind] || NEWS_WORDS.general : NEWS_WORDS.general;
        var nteam = nw ? nw.teams[0] : (o.teams && o.teams[0]) || '';
        b.primary_keyword = (nteam + ' ' + nk[0]).toLowerCase();
        b.headline = nteam + ' ' + nk[1] + ': What It Means for Week ' + w;
        b.secondary_keywords = (o.teams || []).slice(0, 3).map(function (t) { return String(t).toLowerCase() + ' prediction'; });
        b.intent = 'informational (news)';
        b.alternatives = [];
        b.structure = ['Intro', 'What was reported (attributed, linked)', 'Why it matters', 'What EdgeDesk’s research shows', 'What we don’t know yet', 'Bottom line'];
    }
    b.slug = slugify(b.headline);
    b.meta_description = metaFor(o, b);
    b.teams = o.teams || [];
    b.players = uniq([].concat.apply([], (R.games || []).map(function (p) { return [p.qb && p.qb.home && p.qb.home.player, p.qb && p.qb.away && p.qb.away.player]; })).filter(Boolean)).slice(0, 8);
    b.audience = 'General sports fans following ' + (o.league === 'cfb' ? 'college football' : 'the NFL') + ', not only bettors';
    b.angle = o.angle;
    b.internal_links = uniq((R.games || []).map(function (p) { return p.link; }).filter(Boolean)).slice(0, 6)
      .map(function (u) { return { url: u, anchor: 'EdgeDesk’s full research on this game' }; })
      .concat([{ url: SITE + '/today/', anchor: 'EdgeDesk’s free Today’s Games page' }, { url: SITE + '/methodology/', anchor: 'how EdgeDesk’s models work' }]);
    b.external_links = (o.sources || []).filter(function (s) { return s.kind === 'external_report'; }).map(function (s) { return { url: s.url, anchor: s.publisher + ': ' + s.title }; });
    b.demand = o.demand || null;
    if (publisher && publisher.editorial && publisher.editorial.seo_requirements) b.publisher_requirements = publisher.editorial.seo_requirements;
    return b;
  }
  function metaFor(o, b) {
    var R = o.research || {}, g0 = (R.games || [])[0];
    var m;
    if (o.kind === 'weekly_preview') m = 'EdgeDesk’s Week ' + o.week + ' ' + (o.league === 'cfb' ? 'college football' : 'NFL') + ' predictions' + (g0 ? ', from ' + g0.away + ' vs. ' + g0.home : '') + ' to the upsets worth watching. Research, not picks.';
    else if (o.kind === 'upset_watch') m = 'Which Week ' + o.week + ' underdogs have a real chance? EdgeDesk’s model names them, with win chances and the risks. Research, not picks.';
    else if (o.kind === 'conference_race') m = 'The ' + R.conference + ' games that shape the title race in Week ' + o.week + ', with EdgeDesk’s projections and ratings. Research, not picks.';
    else if (o.kind === 'market_discrepancy') m = 'Why EdgeDesk’s projection differs from the betting line' + (g0 && R.games.length === 1 ? ' for ' + g0.away + ' vs. ' + g0.home : ' this week') + ', and what could explain it. Research, not picks.';
    else if (o.kind === 'injury_impact') m = 'What the injury report says about ' + (R.focus && R.focus.player) + ', and how EdgeDesk’s projection changes if he can’t play. Research, not picks.';
    else if (o.kind === 'matchup_analysis') m = (g0 ? g0.away + ' vs. ' + g0.home + ': ' : '') + 'the quarterbacks, the matchups and the evidence on both sides of EdgeDesk’s projection. Research, not picks.';
    else m = 'The latest ' + (o.teams && o.teams[0] || '') + ' news, read against EdgeDesk’s numbers for the next game. Research, not picks.';
    return m.length > 160 ? m.slice(0, 157).replace(/\s+\S*$/, '') + '…' : m;
  }

  /* ======================================================================
     DRAFT — deterministic prose, from the packet only
     ====================================================================== */
  function para() { return Array.prototype.slice.call(arguments).filter(Boolean).join(' '); }

  function fanLine(p) {
    /* "EdgeDesk’s model makes Alabama a 5.3-point favorite (64% to win)" */
    var m = p.model;
    if (!m.available) return null;
    if (!m.favorite) return 'EdgeDesk’s model sees ' + p.away + ' at ' + p.home + ' as a pick’em.';
    if (m.margin < 1) return 'EdgeDesk’s model sees a near coin flip: ' + m.favorite + ' by ' + oneDp(m.margin) + (isNum(m.fav_win_pct) ? ', with a ' + m.fav_win_pct + '% chance to win' : '') + '.';
    return 'EdgeDesk’s model makes ' + m.favorite + ' ' + aOrAn(oneDp(m.margin)) + ' ' + oneDp(m.margin) + '-point favorite' + (isNum(m.fav_win_pct) ? ', with a ' + m.fav_win_pct + '% chance to win' : '') + '.';
  }
  function scoreLine(p) {
    if (!p.display.score) return null;
    return 'Projected score: ' + p.display.score + (p.display.total ? ' (a projected total of ' + p.display.total + ' points).' : '.');
  }
  function driverLine(p) {
    var d = p.drivers || [];
    if (!d.length || !p.model.favorite) return null;
    var parts = d.slice(0, 2).map(function (x) {
      var lab = String(x.label).replace(/\s*\(.*\)\s*/g, '').toLowerCase();
      return lab + ' (' + oneDp(x.points) + ' points toward ' + x.team + ')';
    });
    return 'The biggest pieces of the projection: ' + sentenceList(parts) + '.';
  }
  function matchupLine(p) {
    var mu = p.matchup || [];
    if (!mu.length) return null;
    var x = mu[0];
    return 'Matchup to watch: EdgeDesk’s unit data gives ' + x.favors + ' a ' + x.magnitude + ' edge in the ' + String(x.label).toLowerCase() + '.';
  }
  function marketLine(p) {
    var m = p.market;
    if (!m || m.status === 'none' || !p.display.market) return null;
    var gapTxt = p.gap && p.gap.points >= 0.1 ? ' That is ' + oneDp(p.gap.points) + ' points away from EdgeDesk’s number, toward ' + p.gap.toward + '.' : ' EdgeDesk’s number is essentially the same.';
    if (m.status === 'current') return 'The betting line: ' + p.display.market + '.' + gapTxt + ' A gap is a question for research, not a reason to bet.';
    if (m.status === 'stale') return 'The last sportsbook line EdgeDesk captured: ' + p.display.market + '. That line is older than EdgeDesk’s three-hour freshness rule, so treat it as context, not a current price.' + gapTxt;
    return 'For reference, the ' + p.display.market + ' had ' + (favOf(p.home, p.away, m.home_line).favorite || 'neither team') + ' favored. It is a reference, not a sportsbook price.' + gapTxt;
  }
  function qbLine(p) {
    if (p.league !== 'cfb') return null;
    var unconfirmed = [], unsettled = [];
    ['away', 'home'].forEach(function (s) {
      var q = p.qb && p.qb[s]; if (!q) return;
      var team = s === 'home' ? p.home : p.away;
      if (q.contested) unsettled.push(team);
      else if (!q.confirmed) unconfirmed.push(team + '’s ' + q.player);
    });
    var out = [];
    if (unconfirmed.length === 2) out.push('neither starting quarterback is confirmed: ' + unconfirmed[0] + ' and ' + unconfirmed[1] + ' started their last games, but no starter has been announced for this one.');
    else if (unconfirmed.length === 1) out.push(unconfirmed[0] + ' started the last game, but no starter has been announced for this one.');
    unsettled.forEach(function (t) { out.push(t + '’s quarterback job is unsettled.'); });
    return out.length ? 'What could change it: ' + out.join(' ') : null;
  }
  function injuryLine(p) {
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var i = p.injuries && p.injuries[s]; if (!i) return;
      var team = s === 'home' ? p.home : p.away;
      var q = (i.qbs || []).filter(function (x) { return x.starter; })[0];
      if (q) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' starting quarterback ' + q.name + ' as ' + String(q.status).toLowerCase() + (q.injury ? ' (' + String(q.injury).toLowerCase() + ')' : '') + ' on the official injury report.');
      else if (i.out_count) out.push(team + ' ' + verb(p.league, 'lists', 'list') + ' ' + numWord(i.out_count) + ' player' + (i.out_count === 1 ? '' : 's') + ' as out.');
    });
    return out.length ? 'Injury report: ' + out.join(' ') : null;
  }
  function confLine(p) {
    var m = p.model;
    if (m.confidence) return 'Model confidence: ' + (m.confidence.label || '') + ' (' + m.confidence.score + ' out of 100).';
    return null;
  }
  function rankTag(p, side) {
    var r = side === 'home' ? p.home_rank : p.away_rank;
    return p.league === 'cfb' && isNum(r) && r <= 25 ? 'No. ' + r + ' ' : '';
  }
  function recTag(p, side) {
    var r = side === 'home' ? p.home_record : p.away_record;
    return p.league === 'nfl' && r ? ' (' + r + ')' : '';
  }
  function gameHeading(p) {
    var sep = p.neutral_site ? ' vs. ' : ' at ';
    return rankTag(p, 'away') + p.away + recTag(p, 'away') + sep + rankTag(p, 'home') + p.home + recTag(p, 'home') + (p.kickoff_text ? ' — ' + p.kickoff_text : '');
  }
  function capsule(p, opts) {
    opts = opts || {};
    if (p.evidence && p.evidence.explanation) return capsuleEv(p, opts);
    var lines = [fanLine(p), scoreLine(p), driverLine(p), opts.short ? null : matchupLine(p), marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p)];
    var linkTxt = p.link && opts.links !== false ? 'Full research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : null;
    return '### ' + gameHeading(p) + '\n\n' + lines.filter(Boolean).join(' ') + (linkTxt ? '\n\n' + linkTxt : '');
  }

  function ctxIntro(o) {
    var R = o.research, c = R.context || {}, g = R.games || [];
    var g0 = g[0];
    var L = o.league === 'cfb' ? 'college football' : 'NFL';
    if (!g0) return null;
    if (o.kind === 'upset_watch') {
      return para('Every week of the ' + L + ' season brings at least one result nobody saw coming. EdgeDesk’s model can’t say which one, but it can say where an upset is realistic.',
        'For Week ' + o.week + ', the model gives ' + sentenceList(g.slice(0, 3).map(function (p) { return p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance'; })) + '.',
        'Here is why each one has a path, and what would have to go right.');
    }
    if (o.kind === 'market_discrepancy' && g.length > 1) {
      return para('EdgeDesk’s ' + (o.league === 'nfl' ? 'NFL' : 'college football') + ' Week ' + o.week + ' predictions differ from the betting line by two points or more in ' + numWord(g.length) + ' of the games below.',
        'The biggest gap: ' + g0.away + ' at ' + g0.home + ', where EdgeDesk has ' + g0.display.fair + ' and the line was ' + (g0.display.market || 'not available') + '.',
        'A disagreement is not a bet. It is a question about what the model sees that the market does not, or the other way around, and the answers are below.');
    }
    if (o.kind === 'conference_race') {
      return para('The ' + R.conference + ' championship race runs through ' + sentenceList(g.map(function (p) { return p.away + ' at ' + p.home; })) + ' this week.',
        'In EdgeDesk’s ratings, ' + sentenceList((R.conference_top || []).slice(0, 3)) + ' are the conference’s three highest-rated teams, so the result' + (g.length > 1 ? 's' : '') + ' will carry extra weight for the rest of the season.');
    }
    var headline = g0.away + (g0.neutral_site ? ' vs. ' : ' at ') + g0.home;
    var n = c.games_total;
    return para('Week ' + o.week + ' of the ' + L + ' season puts ' + (isNum(n) ? n + ' games' : 'a full slate') + ' on EdgeDesk’s board, and a handful of them will shape the season’s storylines.',
      'The headliner is ' + headline + (g0.kickoff_text ? ' (' + g0.kickoff_text + ')' : '') + ', where ' + (fanLine(g0) || 'EdgeDesk has a projection').replace(/^EdgeDesk’s model makes/, 'EdgeDesk’s model makes').replace(/\.$/, '') + '.',
      'Below are EdgeDesk’s Week ' + o.week + ' predictions for the games that matter most, what the numbers expect in each, and where the underdog has a realistic chance.');
  }

  function whyItMatters(o) {
    var c = o.research.context || {};
    if (o.league === 'cfb') {
      return para(isNum(c.typical_games_played) ? 'Most teams have now played ' + numWord(c.typical_games_played) + ' games, so EdgeDesk’s ratings lean on what teams have actually done this season rather than on preseason expectations.' : 'Ratings now lean on what teams have actually done this season rather than on preseason expectations.',
        'That makes this the point of the season where the numbers start to separate contenders from teams that had a soft early schedule.',
        c.top10 && c.top10.length >= 3 ? 'EdgeDesk’s current top three: ' + sentenceList(c.top10.slice(0, 3).map(function (t) { return t.team; })) + '.' : null);
    }
    return para('A month into the NFL season, records are starting to mean something and early-season surprises are being tested.',
      'EdgeDesk’s NFL projections are built from each team’s efficiency this season, quarterback play, rest and home field, and they are compared with the betting line only when EdgeDesk knows when that line was captured.');
  }

  function howToRead(o) {
    return para('A projection is the margin and win chance EdgeDesk’s model expects, built from team ratings, home field and matchup data.',
      'A projection is not a bet. A team can be the likelier winner and still be a poor wager if the betting line already expects more than the model does, which is why this article doesn’t make picks.',
      'When we compare the model with a sportsbook line, we say where the line came from and when it was captured; a line marked “last captured” is older than three hours and may have moved.',
      'Each game below is argued with measured football — quarterback play, how each offense matches up with the other defense, availability — not just the projection.',
      o.league === 'cfb' ? 'Rankings shown with team names (such as No. 6) are EdgeDesk’s own power ratings, not the AP poll.' : null);
  }

  function upsetsSection(o, gamesShown) {
    var ups = (o.research.upsets || []).filter(function (p) { return o.kind === 'upset_watch' || gamesShown.indexOf(p.game_id) < 0 || true; });
    if (!ups.length) return null;
    var lines = ups.slice(0, 3).map(function (p) {
      var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
      var rankTxt = p.league === 'cfb' && isNum(favRank) && favRank <= 25 ? ' (No. ' + favRank + ' in EdgeDesk’s ratings)' : '';
      var s = '- **' + p.model.underdog + '** over ' + p.model.favorite + rankTxt + ': the model gives ' + p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance.' + (p.underdog_case ? ' Its best measured case: ' + sent(p.underdog_case) : '');
      if (p.favorite_flip && p.market.status !== 'none') s += ' The ' + (p.market.status === 'current' ? 'current' : 'last captured') + ' line has ' + p.model.underdog + ' favored instead.';
      return s;
    });
    return para('An underdog the model gives a 30 percent chance or better still loses more often than it wins, but over a full slate a few of them come through.') + '\n\n' + lines.join('\n') + '\n\n'
      + 'None of these is a prediction that the underdog wins, and none is a bet: whether an underdog is worth backing depends entirely on the price, which this article doesn’t assess.';
  }

  function conferenceSection(o) {
    var races = o.research.races || [];
    if (!races.length) return null;
    var c = o.research.context || {};
    return races.map(function (p) {
      var top = (o.research.conference_top && o.research.conference_top.length ? o.research.conference_top : null);
      return para('**' + p.home_conference + ':** ' + p.away + ' and ' + p.home + ' are both among the conference’s three highest-rated teams in EdgeDesk’s ratings, so this game carries extra weight for the title race.',
        fanLine(p));
    }).join('\n\n') + '\n\n' + 'EdgeDesk doesn’t carry a conference standings feed, so this reads the race through ratings and projections, not tiebreakers.';
  }

  function disagreementsSection(o) {
    var gs = (o.research.games || []).filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none'; });
    if (!gs.length) return null;
    var any = gs[0];
    var intro = any.market.status === 'reference'
      ? 'These comparisons use the consensus line from public schedule data, which has no sportsbook and no capture time: treat each gap as a research note.'
      : any.market.status === 'stale' ? 'These comparisons use the last lines EdgeDesk captured, each older than its three-hour freshness rule: lines move, so treat each gap as a research note.'
      : 'These comparisons use lines EdgeDesk captured within the last three hours.';
    var lines = gs.slice(0, 5).map(function (p) {
      return '- **' + p.away + ' at ' + p.home + ':** EdgeDesk has ' + p.display.fair + '; the line was ' + p.display.market + '. Gap: ' + p.gap.text + '.';
    });
    return intro + '\n\n' + lines.join('\n') + '\n\n' + 'A gap means the model and the market weigh something differently. Sometimes the model has spotted something; often the market knows something the model can’t see, like an injury that hasn’t been reported yet.';
  }

  function injuriesSection(o) {
    var lines = [];
    (o.research.games || []).forEach(function (p) { var l = injuryLine(p); if (l) lines.push('- **' + p.away + ' at ' + p.home + ':** ' + l.replace(/^Injury report: /, '')); });
    if (!lines.length) return null;
    var asOf = o.research.context && o.research.context.injuries_as_of;
    return 'From the official NFL injury report' + (asOf ? ' (as read ' + whenText(ts(asOf)) + ')' : '') + ':\n\n' + lines.join('\n');
  }

  function limitsSection(o) {
    var R = o.research, gs = R.games || [];
    var bullets = [];
    var qbN = gs.filter(function (p) { return p.flags.indexOf('QB_UNCONFIRMED') >= 0 || p.flags.indexOf('QB_CONTESTED') >= 0; }).length;
    if (o.league === 'cfb' && qbN) bullets.push('**Quarterbacks:** ' + numWord(qbN) + ' of the games above ' + (qbN === 1 ? 'has' : 'have') + ' at least one starter who hasn’t been confirmed. A late change moves a projection more than almost anything else.');
    /* only what is unpriced in EVERY featured game: a factor priced in one
       game must not be called unpriced in general */
    var unp = gs.length ? (gs[0].unpriced || []).filter(function (u) { return gs.every(function (p) { return (p.unpriced || []).indexOf(u) >= 0; }); }) : [];
    var UNPRICED = { 'Quarterback / personnel': 'quarterback and personnel changes', 'Reported availability': 'reported injuries', 'Rivalry situational effect': 'rivalry effects' };
    if (unp.length) bullets.push('**Not in the main number:** EdgeDesk’s college projection does not directly price ' + sentenceList(unp.map(function (u) { return UNPRICED[u] || u.toLowerCase(); }), 'or') + '.');
    if ((R.limitations || []).length) bullets.push('**Prices and bets:** ' + R.limitations.join(' '));
    if (o.league === 'nfl') bullets.push('**Injuries:** the official report is a snapshot; game-day inactives can change the picture.');
    bullets.push('**Uncertainty:** even a 70% favorite loses about three times in ten. Projections describe likelihoods, not outcomes.');
    return uniq(bullets).map(function (b) { return '- ' + b; }).join('\n');
  }

  function conclusionSection(o) {
    var gs = (o.research.games || []).filter(function (p) { return p.model.available && p.model.favorite; });
    if (!gs.length) return 'Projections move during the week as quarterback news and prices arrive. EdgeDesk updates its numbers as they do.';
    var fav = gs.slice().sort(function (a, b) { return (b.model.fav_win_pct || 0) - (a.model.fav_win_pct || 0); })[0];
    var close = gs.slice().sort(function (a, b) { return Math.abs((a.model.fav_win_pct || 50) - 50) - Math.abs((b.model.fav_win_pct || 50) - 50); })[0];
    var ups = (o.research.upsets || [])[0];
    var bits = [];
    var be = verb(o.league, ' is ', ' are ');
    if (o.kind !== 'upset_watch') bits.push(fav.model.favorite + be + 'the most comfortable favorite among these games (' + fav.model.fav_win_pct + '%)');
    if (close && close !== fav) bits.push(close.away + ' at ' + close.home + ' is the closest call');
    if (ups) bits.push(ups.model.underdog + be + 'the underdog with the best chance (' + ups.model.dog_win_pct + '%)');
    return para('The short version: ' + sentenceList(bits) + '.',
      'Projections move during the week as quarterback news and prices arrive, and EdgeDesk updates its numbers as they do.',
      'None of it is a pick. It’s a way to watch the weekend knowing where the real uncertainty is.');
  }

  /* market discrepancy, one game: the gap, then the football on both sides */
  function mdSections(o) {
    var p = o.research.games[0];
    if (p.evidence && p.evidence.explanation) return mdSectionsEv(o, p);
    var s = {};
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.', 'EdgeDesk has no football evidence packet for it, so this piece cannot explain the gap.');
    s.the_gap = para(fanLine(p), marketLine(p));
    s.why_they_differ = 'EdgeDesk does not have the football evidence to explain this gap.';
    s.how_to_read = howToRead(o);
    s.market_case = 'Without football evidence, the market’s number deserves the benefit of the doubt.';
    s.conclusion = 'A gap without football evidence is not publishable analysis; it is not a bet either.';
    return s;
  }
  function mdSectionsEv(o, p) {
    var X = p.evidence.explanation || {}, S = sidesOf(p), C = evClaims(p), used = {}, s = {};
    var F = fe();
    var q = X.critical_matchup && X.critical_matchup.question_text;
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.',
      q ? 'The football question underneath it: ' + q : null);
    s.the_gap = para(X.thesis, disclosure(p));
    var pro = pickClaims(S.pro, 3, used);
    var qb = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side);
      var out = Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status === 'OUT'; }).map(function (c) { return c.subject; });
      Q.season.filter(function (c) { return out.indexOf(c.subject) < 0; }).slice(0, 1).forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
      Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; }).forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
      Q.conflict.forEach(function (c) { used[c.id] = 1; qb.push(sent(c.text)); });
    });
    s.why_they_differ = [pro.length ? 'The football that points toward ' + S.forTeam + ': ' + pro.map(function (c) { return sent(stripWhen(c.text)); }).join(' ') : null,
      qb.length ? '**The quarterbacks.** ' + qb.join(' ') : null].filter(Boolean).join('\n\n');
    s.how_to_read = howToRead(o);
    var con = pickClaims(S.con, 3, used);
    var inj = (F ? F.writer.materialInjuries(p.evidence) : []).filter(function (c) { return !used[c.id]; });
    s.market_case = [con.length ? 'The case for ' + S.against + ': ' + con.map(function (c) { return sent(stripWhen(c.text)); }).join(' ') : null,
      inj.length ? 'Availability: ' + inj.map(function (c) { used[c.id] = 1; return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ') : null].filter(Boolean).join('\n\n');
    s.limits = limitsSection(o);
    s.conclusion = para(X.critical_matchup && X.critical_matchup.watch ? 'Watch ' + X.critical_matchup.watch + '.' : null,
      X.status === 'UNEXPLAINED' ? 'Until EdgeDesk can explain the gap, it is an open question, not a bet.' : 'That is a research question worth following through the week, not a bet.');
    return s;
  }

  /* trending story / injury implications, one team in the news */
  function storySections(o) {
    var R = o.research, p = (R.games || [])[0], s = {};
    var news = (R.news || [])[0], focus = R.focus;
    if (news) {
      s.intro = para(news.publisher + ' reported' + (news.published_at ? ' on ' + dayText(ts(news.published_at)) : '') + ': “' + news.title + '.”',
        'Here is what that report says, what it could mean for ' + (news.teams[0]) + '’s next game, and what EdgeDesk’s numbers show — kept separate, so you can tell reporting from model inference.');
      s.reported = para('According to ' + news.publisher + ' ([' + news.title + '](' + news.url + ')): ' + (news.summary ? '“' + news.summary.replace(/\s+$/, '') + '”' : 'the headline above is all the feed provides; EdgeDesk has not independently confirmed further details.'),
        'EdgeDesk has not independently verified the report.');
    } else if (focus) {
      var inj = p.injuries && p.injuries[focus.side];
      s.intro = para(focus.team + ' ' + verb(p.league, 'lists', 'list') + ' ' + focus.player + ' as ' + String(focus.status).toLowerCase() + (focus.injury ? ' with a ' + String(focus.injury).toLowerCase() + ' injury' : '') + ' on the official NFL injury report.',
        'Here is what that could mean for ' + p.away + ' at ' + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ', using EdgeDesk’s model.');
      s.reported = para('The official NFL injury report' + (inj && inj.retrieved_at ? ', as read ' + whenText(ts(inj.retrieved_at)) : '') + ', lists ' + focus.player + ' as ' + String(focus.status).toLowerCase() + '.',
        'A status can change before kickoff; the report is the league’s, not EdgeDesk’s.');
    }
    var WHY = { injury: 'Availability moves a projection more than almost any other single piece of news, and the closer to kickoff, the less time the market has to settle on it.',
      qb_change: 'A quarterback change moves a projection more than almost any other single piece of news.',
      trade: 'A roster move changes who is on the field, and a projection built on last week’s roster can lag behind it.',
      coaching: 'A coaching change can change how a team plays faster than its results can show it.',
      ranking: 'Rankings shape the playoff conversation, but a ranking is an opinion about the past; a projection is an estimate of the next game.',
      suspension: 'A suspension changes who is available, which a projection only sees once it is confirmed.',
      general: 'News moves the conversation. The question for a fan is whether it moves the numbers, and by how much.' };
    s.why_it_matters = news ? WHY[news.kind] || WHY.general : WHY.injury;
    if (p) {
      var side = news ? (p.home === news.teams[0] ? 'home' : 'away') : focus.side;
      var team = side === 'home' ? p.home : p.away;
      var rk = side === 'home' ? p.home_rank : p.away_rank, rec = side === 'home' ? p.home_record : p.away_record;
      var ctxBits = [];
      if (p.league === 'cfb' && isNum(rk)) ctxBits.push(team + ' is No. ' + rk + ' in EdgeDesk’s power ratings');
      if (p.league === 'nfl' && rec) ctxBits.push(team + ' is ' + rec + ' this season');
      if (ctxBits.length) s.why_it_matters += ' For context, ' + ctxBits.join(' and ') + '.';
    }
    if (p) {
      var sc = focus && p.scenarios && p.scenarios[focus.side + '_qb_out'];
      var scTxt = null;
      if (sc) {
        var f2 = favOf(p.home, p.away, sc.home_line);
        scTxt = 'If ' + focus.team + '’s listed starter does not play, the model’s projection becomes ' + (f2.favorite ? f2.favorite + ' by ' + oneDp(f2.margin) : 'a pick’em') + (isNum(sc.home_win_prob) ? ', with ' + p.home + ' at ' + pct(sc.home_win_prob) + ' to win' : '') + '. That re-run changes one input and gives the replacement the club’s carried quarterback level.';
      }
      var foot = '';
      if (p.evidence && p.evidence.explanation) {
        var tm = news ? news.teams[0] : focus.team, sd = p.home === tm ? 'home' : 'away';
        var Qs = qbOf(p, sd), Sx = sidesOf(p);
        var fc = pickClaims([].concat(Qs.season.slice(0, 1), pairsFor(p, tm, 1), Sx.con.slice(0, 1)), 3, {});
        if (fc.length) foot = '\n\n' + 'The football behind it: ' + fc.map(function (c) { return sent(stripWhen(c.text)); }).join(' ');
        var dsc = disclosure(p);
        if (dsc) foot += ' ' + dsc;
      }
      s.research = '**Next game: ' + gameHeading(p) + '**\n\n' + para(fanLine(p), scoreLine(p), driverLine(p), scTxt, marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p),
        'A projection is not a bet: it is EdgeDesk’s estimate of what is likely, not a judgment about any price.') + foot;
    }
    s.unknowns = para('What we don’t know: final game-day status, how a replacement would actually play, and whether the betting market has already moved.',
      'EdgeDesk’s numbers update as the official report and captured prices do.');
    s.conclusion = para('The report is the news; the projection is EdgeDesk’s estimate of what it might mean. Neither is a pick.');
    return s;
  }


  /* ======================================================================
     EVIDENCE WRITER — football first, every sentence from the packet.
     A capsule or an analysis says what EdgeDesk projects, then argues each
     side with measured football, then says what EdgeDesk cannot explain.
     ====================================================================== */
  var STRENGTH_W = { large: 3, moderate: 2, small: 1 };
  function evClaims(p) { return (p && p.evidence && p.evidence.claims) || []; }
  function evById(p) { var m = {}; evClaims(p).forEach(function (c) { m[c.id] = c; }); return m; }
  function shortOf(c) { return c.short || c.text; }
  function sent(t) { t = String(t || '').trim(); return /[.!?”]$/.test(t) ? t : t + '.'; }
  function linkReported(p, c) {
    /* outside reporting carries its outlet, linked */
    var F = fe(), so = F && F.sourceOf ? F.sourceOf(p.evidence, c) : null;
    var t = sent(c.text);
    if (so && so.publisher && so.url && (c.verification === 'REPORTED' || c.verification === 'VERIFIED_REPORT')) {
      var i = t.lastIndexOf(so.publisher);
      if (i >= 0) t = t.slice(0, i) + '[' + so.publisher + '](' + so.url + ')' + t.slice(i + so.publisher.length);
    }
    return t;
  }
  function claimRank(c) { return (STRENGTH_W[c.strength] || 0) * (c.measured ? 1 : 0.6) * (c.caveat && /small sample/.test(c.caveat) ? 0.5 : 1) + (c.topic === 'matchup' ? 0.1 : 0); }
  function sortStrength(a, b) { return claimRank(b) - claimRank(a); }
  /* which side each list of claims argues for */
  function sidesOf(p) {
    var X = (p.evidence && p.evidence.explanation) || {}, by = evById(p);
    var mf = p.market && p.market.status !== 'none' ? favOf(p.home, p.away, p.market.home_line) : null;
    if (X.gap && X.gap.toward && X.gap.points >= RESEARCH_GAP) {
      var T = X.gap.toward, O = X.gap.other, flip = p.favorite_flip;
      var proLabel = flip ? 'Why ' + T + ' can win' : (p.model.favorite === T ? 'Why ' + T + ' could win by more than the line says' : 'Why it could be closer than the line says');
      var conLabel = flip ? 'Why ' + O + ' can win' : (p.model.favorite === T ? 'Why it could be closer' : 'Why ' + O + ' could win comfortably');
      return { forTeam: T, against: O, pro: (X.supporting || []).map(function (id) { return by[id]; }).filter(Boolean).sort(sortStrength), con: (X.contradicting || []).map(function (id) { return by[id]; }).filter(function (c) { return c && c.football; }).sort(sortStrength), proLabel: proLabel, conLabel: conLabel, gap: true };
    }
    var fav = p.model.favorite || p.home, dog = fav === p.home ? p.away : p.home;
    var foot = evClaims(p).filter(function (c) { return c.football && c.leans && c.strength; });
    return { forTeam: fav, against: dog, pro: foot.filter(function (c) { return c.leans === fav; }).sort(sortStrength), con: foot.filter(function (c) { return c.leans === dog; }).sort(sortStrength),
      proLabel: p.model.favorite ? 'Why ' + fav + ' is favored' : 'The case for ' + fav, conLabel: 'Why ' + dog + ' has a chance', gap: false, market_favorite: mf && mf.favorite };
  }
  /* n claims, never two citing the same numbers, never one already used */
  function pickClaims(list, n, used) {
    used = used || {};
    var out = [];
    (list || []).forEach(function (c) {
      if (out.length >= n || !c) return;
      var k = (c.cite && c.cite.nums || []).join('|');
      if (used[c.id] || (k && used['n:' + k])) return;
      used[c.id] = 1; if (k) used['n:' + k] = 1; out.push(c);
    });
    return out;
  }
  function qbOf(p, side) {
    var team = p[side], C = evClaims(p);
    var qbNames = C.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key) && c.subject; }).map(function (c) { return c.subject; });
    return {
      season: C.filter(function (c) { return c.team === team && /^(qb_season|team_passing):/.test(c.key); }),
      trend: C.filter(function (c) { return c.team === team && /^(qb_trend|team_passing_trend):/.test(c.key) && c.strength; }),
      last: C.filter(function (c) { return c.team === team && /^qb_last:/.test(c.key); }),
      status: C.filter(function (c) { return c.team === team && (c.topic === 'qb_status' || /^report_absent:/.test(c.key) || (c.topic === 'injury' && c.values && c.values.position === 'QB')); }),
      conflict: C.filter(function (c) { return c.team === team && c.verification === 'CONFLICTING' && c.topic === 'input'; }),
      facts: C.filter(function (c) { return c.team === team && /^fact:/.test(c.key) && (c.topic === 'injury' || c.topic === 'qb') && (!c.subject || qbNames.indexOf(c.subject) >= 0 || /quarterback/i.test(c.text)); })
    };
  }
  /* the matchups when one team has the ball: clear edges first, then the
     even ones (an even matchup is information too) */
  var PAIR_ORDER = ['pass', 'rush', 'protection', 'early_downs', 'third_down', 'explosive_pass', 'explosive_rush', 'run_blocking', 'turnovers', 'efficiency', 'red_zone'];
  function pairsFor(p, offenseTeam, n, skip) {
    var by = evById(p);
    var all = ((p.evidence && p.evidence.pairs) || []).filter(function (pr) { return pr.offense === offenseTeam && pr.sample >= 40 && !(skip && skip[pr.claim]) && by[pr.claim]; });
    var edges = all.filter(function (pr) { return pr.favors; }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); });
    var even = all.filter(function (pr) { return !pr.favors; }).sort(function (a, b) { return PAIR_ORDER.indexOf(a.key) - PAIR_ORDER.indexOf(b.key); });
    return edges.concat(even).slice(0, n).map(function (pr) { return by[pr.claim]; });
  }
  function stripWhen(t) { return cap(String(t).replace(/^When .+? ha(?:s|ve) the ball(?: \(([^)]+)\))?: /, function (_, l) { return l ? cap(l) + ': ' : ''; })); }
  function plainFlags(p) {
    var X = (p.evidence && p.evidence.explanation) || {}, C = evClaims(p), out = [];
    (X.input_flags || []).forEach(function (f) {
      if (f.key === 'QB_INPUT_CONFLICT') { var c = C.filter(function (y) { return y.topic === 'input' && y.verification === 'CONFLICTING'; })[0]; if (c) out.push('the model’s quarterback input may be out of date (' + c.short + ')'); }
      else if (f.key === 'QB_ABSENCE_APPLIED') out.push('the model subtracts a full quarterback absence that no official report confirms');
      else if (f.key === 'QB_REPLACEMENT_GENERIC') out.push('the model prices the quarterback absence generically, not the replacement’s own play');
      else if (f.key === 'DATA_FAULT') out.push('EdgeDesk’s own game page already flags the gap as a likely data problem');
      else if (f.key === 'CROSS_MODEL_OUTLIER' && f.severity === 'high') out.push('EdgeDesk’s other models disagree sharply with its published number');
    });
    return uniq(out);
  }
  var PART_PLAIN = { home_field: 'EdgeDesk’s league-wide home-field value', prior: 'how much weight EdgeDesk still gives last season', turnover: 'how EdgeDesk carries last season onto a turned-over roster',
    qb_change: 'a quarterback change', rating: 'the size of EdgeDesk’s rating gap', conference: 'conference strength' };
  /* the same idea in different words for different games: a slate of
     capsules must not repeat one sentence (the gate fails boilerplate) */
  function variant(p, n) { var h = 0, k = String(p.game_id); for (var i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return h % n; }
  function disclosure(p, opts) {
    var X = (p.evidence && p.evidence.explanation) || {};
    if (!X.gap || X.gap.points < RESEARCH_GAP) return null;
    var g = oneDp(X.gap.points), flags = plainFlags(p);
    var v = opts && isNum(opts.index) ? opts.index % 5 : variant(p, 5), v3 = v % 3;
    if (X.status === 'UNEXPLAINED' || X.input_suspect) {
      var e = X.mechanical ? oneDp(X.mechanical.explained_points) : null;
      var exp = e == null ? ['EdgeDesk cannot account for most of the ' + g + ' points', 'Most of the ' + g + ' points have no explanation EdgeDesk can point to', 'EdgeDesk has no measured explanation for most of the ' + g + ' points',
            'Nothing EdgeDesk measures accounts for most of this ' + g + '-point gap', 'The bulk of the ' + g + ' points is unexplained by anything in EdgeDesk’s data'][v]
        : [ 'EdgeDesk’s own breakdown accounts for about ' + e + ' of the ' + g + ' points; the rest is unexplained',
            'Only about ' + e + ' of the ' + g + ' points can be traced to identifiable pieces of EdgeDesk’s number; the remainder is unexplained',
            'EdgeDesk can account for roughly ' + e + ' of the ' + g + ' points and cannot explain the rest',
            'About ' + e + ' of the ' + g + ' points trace to known pieces of the model; EdgeDesk cannot explain the other part',
            'EdgeDesk’s breakdown explains roughly ' + e + ' of these ' + g + ' points and leaves the rest unexplained' ][v];
      var warn = flags.length ? (flags.length === 1 ? ' One warning sign points at EdgeDesk’s inputs rather than the football: ' : ' ' + cap(numWord(flags.length)) + ' warning signs point at EdgeDesk’s inputs rather than the football: ') + flags.join('; ') + '.' : '';
      var end = [' Until that changes, the gap is an open question, not an edge.', ' Treat it as an open question, not an edge.', ' That makes it a research question, not an edge.', ' It is not an edge until EdgeDesk can say why.', ' Read the gap as a question for research, not an edge.'][v];
      return exp + '.' + warn + end;
    }
    if (X.status === 'PARTIALLY_EXPLAINED') {
      return ['Part of the ' + g + '-point gap has football support and part does not', 'The football supports some of the ' + g + '-point gap, not all of it', 'Only part of the ' + g + '-point gap is backed by the football'][v3]
        + (X.mechanical ? '; EdgeDesk’s breakdown accounts for about ' + oneDp(X.mechanical.explained_points) + ' of the ' + g + ' points' : '') + ['. It is a research question, not a bet.', '. Read it as research, not a bet.', ' — something to investigate, not to bet.'][v3];
    }
    if (X.status === 'EXPLAINED') {
      var part = X.mechanical && X.mechanical.parts && X.mechanical.parts.slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); })[0];
      var hfa = evClaims(p).filter(function (c) { return c.key === 'hfa'; })[0];
      var what = part && part.key === 'home_field' && hfa ? 'EdgeDesk’s league-wide home-field value (' + oneDp(hfa.values.points) + ' points), which the closing market has historically priced at about ' + Math.round((hfa.values.market_priced_share || 0) * 100) + '%'
        : (part ? (PART_PLAIN[part.key] || part.label) + ', which the closing market has historically priced differently' : 'identifiable pieces of EdgeDesk’s number');
      return ['Most of the ' + g + '-point gap traces to ' + what + '. That explains the difference; it does not make either number a bet.',
        'The ' + g + '-point difference comes mostly from ' + what + '. An explained gap is still not a bet.',
        'Nearly all of the ' + g + '-point gap is ' + what + ' — an explanation, not a betting signal.'][v3];
    }
    return null;
  }
  function marketSentence(p) {
    if (!p.display.market) return null;
    var X = (p.evidence && p.evidence.explanation) || {};
    var lead = p.market.status === 'current' ? 'The current line is ' : (p.market.status === 'stale' ? 'The last line EdgeDesk captured had ' : 'For reference, the ');
    var gapTxt = X.gap && X.gap.points >= 0.1 ? ', a ' + oneDp(X.gap.points) + '-point gap' + (X.gap.points >= RESEARCH_GAP ? ' toward ' + X.gap.toward : '') : '';
    return lead + p.display.market + gapTxt + '.';
  }

  /* a weekly-preview capsule */
  function capsuleEv(p, opts) {
    opts = opts || {};
    var X = p.evidence.explanation || {}, S = sidesOf(p), used = {};
    var lines = [];
    var q = X.critical_matchup && X.critical_matchup.question_text;
    if (q) lines.push('**The question:** ' + q);
    lines.push('**EdgeDesk’s view:** ' + para(fanLine(p), marketSentence(p)));
    var per = opts.tight ? 1 : 2;
    var pro = pickClaims(S.pro, per, used), con = pickClaims(S.con, per, used);
    if (pro.length) lines.push('**' + S.proLabel + ':** ' + pro.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    if (con.length) lines.push('**' + S.conLabel + ':** ' + con.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    var qb = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side);
      var out = Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status === 'OUT'; }).map(function (c) { return c.subject; });
      var s0 = Q.season.filter(function (c) { return out.indexOf(c.subject) < 0; })[0];
      if (s0) qb.push(sent(cap(shortOf(s0))));
      if (Q.conflict[0]) qb.push(sent(cap(Q.conflict[0].short)));
      else Q.status.filter(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; }).slice(0, 1).forEach(function (st) { qb.push(sent(cap(shortOf(st)))); });
      if (!Q.conflict[0] && !Q.status.some(function (c) { return c.verification === 'OFFICIAL_REPORT' && c.status !== 'NOT_LISTED'; })) {
        var cont = Q.status.filter(function (c) { return c.values && c.values.contested; })[0];
        if (cont) qb.push(sent(cap(shortOf(cont))));
      }
    });
    if (qb.length) lines.push('**Quarterbacks:** ' + qb.join(' '));
    var inj = (fe() ? fe().writer.materialInjuries(p.evidence) : []).filter(function (c) { return c.topic === 'injury' && !(c.values && c.values.position === 'QB') && c.verification === 'OFFICIAL_REPORT' && (!opts.tight || c.status === 'DOUBTFUL' || /^report_out:/.test(c.key)); }).slice(0, opts.tight ? 1 : 2);
    if (inj.length) lines.push('**Availability:** ' + inj.map(function (c) { return sent(cap(shortOf(c))); }).join(' '));
    var d = disclosure(p, { index: opts.index });
    if (d) lines.push('**' + (X.status === 'EXPLAINED' ? 'Why the numbers differ' : 'What EdgeDesk can’t explain') + ':** ' + d);
    if (X.critical_matchup && X.critical_matchup.watch) lines.push('**Watch:** ' + cap(X.critical_matchup.watch) + '.');
    var linkTxt = p.link && opts.links !== false ? 'Full research: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + ')' : null;
    return '### ' + gameHeading(p) + '\n\n' + lines.join('\n\n') + (linkTxt ? '\n\n' + linkTxt : '');
  }

  /* the single-game analysis: publisher (prose) or first-party (structured) */
  function analysisSections(o, firstParty) {
    var p = o.research.games[0], ev = p.evidence, X = ev.explanation || {}, S = sidesOf(p);
    var C = evClaims(p), used = {}, s = {};
    var F = fe();
    function one(key) { return C.filter(function (c) { return c.key === key; })[0] || null; }
    function lastResult(side) { var r = C.filter(function (c) { return /^result:/.test(c.key) && c.side === side && !/^fact:/.test(c.key); }); return r[r.length - 1] || null; }
    var conf = C.filter(function (c) { return c.topic === 'conference'; })[0];
    var recA = one('record:away'), recH = one('record:home');
    /* reserve the strongest evidence for the sections that argue it */
    var reservePro = pickClaims(S.pro, 3, {}), reserveCon = pickClaims(S.con.filter(function (c) { return c.football; }), 4, {});
    var reserved = {}; reservePro.concat(reserveCon).forEach(function (c) { reserved[c.id] = 1; });

    /* 1 · the opening: why the matchup matters */
    var nflT = p.league === 'nfl';
    var open1 = para((nflT ? 'The ' : '') + p.away + (p.neutral_site ? ' and ' + (nflT ? 'the ' : '') + p.home + ' meet at a neutral site' : (nflT ? ' visit the ' : ' visits ') + p.home) + (p.kickoff_text ? ' on ' + p.kickoff_text : '') + (conf ? ' in ' + conf.values.conference + ' play' : '') + '.',
      recA && sent(recA.text), recH && sent(recH.text), conf && sent(conf.text));
    var la = lastResult('away'), lh = lastResult('home');
    var restC = one('rest');
    var open2 = para(la && sent(la.text), lh && sent(lh.text), restC && sent(restC.text));
    var q = X.critical_matchup && X.critical_matchup.question_text;
    if (firstParty) {
      /* EdgeDesk's own page: a fact sheet first, not the publisher's prose */
      var glance = [
        '- **Kickoff:** ' + (p.kickoff_text || 'time to be announced') + (p.neutral_site ? ', at a neutral site' : ', at ' + p.home) + (conf ? ' (' + conf.values.conference + ')' : '') + '.',
        (recA || recH) ? '- **Records:** ' + [recA, recH].filter(Boolean).map(shortOf).join('; ') + (conf ? '; ' + shortOf(conf) : '') + '.' : null,
        (la || lh) ? '- **Last time out:** ' + [la && p.away + ' ' + shortOf(la), lh && p.home + ' ' + shortOf(lh)].filter(Boolean).join('; ') + '.' : null,
        restC ? '- **Rest:** ' + sent(shortOf(restC)) : null,
        q ? '- **The deciding matchup:** ' + q : null
      ].filter(Boolean);
      s.intro = 'This is EdgeDesk’s own research page for the game: the model’s number, the football for and against it, and what EdgeDesk cannot yet verify.\n\n' + glance.join('\n');
    } else {
      var open3 = para(q ? q + ' That collision sits at the center of this game, and it is the place to start for anyone trying to understand ' + (X.gap && X.gap.points >= RESEARCH_GAP ? 'why EdgeDesk’s model and the betting market see it so differently.' : 'how it will be decided.') : null);
      s.intro = [open1, open2, open3].filter(Boolean).join('\n\n');
    }
    if (restC) used[restC.id] = 1; [la, lh, recA, recH, conf].forEach(function (c) { if (c) used[c.id] = 1; });

    /* 2 · the thesis: what EdgeDesk sees, in model terms and football terms */
    var mk = one('market'); if (mk) used[mk.id] = 1;
    var th = firstParty ? [[
      ev.model && ev.model.text ? '- **EdgeDesk’s model:** ' + ev.model.text + '.' : null,
      mk ? '- **' + (p.market.status === 'current' ? 'Current line' : (p.market.status === 'stale' ? 'Last captured line' : 'Reference line')) + ':** ' + sent(String(mk.text).replace(/^.*? had /, '')) : null,
      X.gap && X.gap.points >= 0.1 ? '- **The difference:** ' + oneDp(X.gap.points) + ' points, toward ' + X.gap.toward + '.' : null,
      X.status ? '- **Research status:** ' + String(X.status).replace(/_/g, ' ').toLowerCase() + (X.input_suspect ? ', with EdgeDesk’s own inputs under suspicion' : '') + '.' : null
    ].filter(Boolean).join('\n')] : [X.thesis];
    /* the first-party page words its disclosure differently from the publisher piece */
    var d = disclosure(p, firstParty ? { index: variant(p, 5) + 2 } : null);
    if (d) th.push((!firstParty && (X.status === 'UNEXPLAINED' || X.input_suspect) ? 'Here is the uncomfortable part. ' : '') + d);
    if (reservePro.length && X.gap && X.gap.points >= RESEARCH_GAP) {
      th.push('The football that does point toward ' + S.forTeam + ':' + '\n\n' + reservePro.map(function (c) { used[c.id] = 1; return '- ' + sent(cap(firstParty ? shortOf(c) : stripWhen(c.text))); }).join('\n'));
    }
    th.push(firstParty ? 'The model’s inputs are itemised under “Inside EdgeDesk’s number” below. A projection is EdgeDesk’s estimate of the game, not a bet.'
      : 'A projection is not a bet. ' + (X.status === 'UNEXPLAINED' ? 'This one comes with a gap EdgeDesk cannot yet explain, which is a reason for more research, not for a wager.' : 'It is EdgeDesk’s estimate of the game, and the evidence below is how to judge it.'));
    s.thesis = th.filter(Boolean).join('\n\n');

    /* 3 · the evidence: quarterbacks, both offenses, personnel, form, history, conditions */
    var E = [];
    var qbBlock = [];
    ['away', 'home'].forEach(function (side) {
      var Q = qbOf(p, side), bits = [];
      Q.season.slice(0, 2).forEach(function (c) { used[c.id] = 1; bits.push(firstParty ? shortOf(c) : c.text); });
      Q.trend.slice(0, 1).forEach(function (c) { used[c.id] = 1; bits.push(c.text); });
      Q.last.slice(0, 1).forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(c.text); } });
      Q.status.forEach(function (c) {
        if (used[c.id]) return;
        used[c.id] = 1;
        if (Q.conflict.length && (c.topic === 'qb_status' || /^report_absent:/.test(c.key))) return;   /* the conflict line says it */
        bits.push(c.text);
      });
      Q.facts.forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(linkReported(p, c)); } });
      Q.conflict.forEach(function (c) { if (!used[c.id]) { used[c.id] = 1; bits.push(c.text); } });
      if (bits.length) qbBlock.push(firstParty ? bits.map(function (b) { return '- ' + sent(cap(b)); }).join('\n') : bits.map(sent).join(' '));
    });
    if (qbBlock.length) E.push('**The quarterbacks.** ' + (firstParty ? '\n\n' : '') + qbBlock.join(firstParty ? '\n' : '\n\n'));
    ['away', 'home'].forEach(function (side) {
      var team = p[side];
      var prs = pairsFor(p, team, 3, reserved);
      if (!prs.length) return;
      prs.forEach(function (c) { used[c.id] = 1; });
      E.push('**When ' + team + (p.league === 'nfl' ? ' have' : ' has') + ' the ball.** ' + (firstParty ? '\n\n' + prs.map(function (c) { return '- ' + sent(cap(shortOf(c))); }).join('\n') : prs.map(function (c) { return sent(stripWhen(c.text)); }).join(' ')));
    });
    var pos = C.filter(function (c) { return c.topic === 'position' && c.strength && !reserved[c.id] && !used[c.id]; }).sort(sortStrength).slice(0, 3);
    var injs = (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { return !used[c.id] && c.topic === 'injury'; });
    var pers = C.filter(function (c) { return c.topic === 'personnel' && !used[c.id]; });
    var persBits = pos.concat(injs, pers);
    if (persBits.length) {
      persBits.forEach(function (c) { used[c.id] = 1; });
      E.push('**Personnel.** ' + (firstParty ? '\n\n' + persBits.map(function (c) { return '- ' + sent(cap(c.verification === 'REPORTED' ? linkReported(p, c) : shortOf(c))); }).join('\n') : persBits.map(function (c) { return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ')));
    }
    var form = C.filter(function (c) { return (c.topic === 'schedule' || (c.topic === 'results' && /^fact:/.test(c.key)) || c.topic === 'preseason') && !used[c.id] && !reserved[c.id]; });
    if (form.length) {
      form.forEach(function (c) { used[c.id] = 1; });
      E.push('**Form and schedule.** ' + (firstParty ? '\n\n' + form.map(function (c) { return '- ' + (/^fact:/.test(c.key) ? linkReported(p, c) : sent(cap(shortOf(c)))); }).join('\n')
        : form.map(function (c) { return /^fact:/.test(c.key) ? linkReported(p, c) : sent(c.text); }).join(' ')));
    }
    var hist = one('h2h');
    if (hist) { used[hist.id] = 1; E.push('**History.** ' + sent(firstParty ? cap(shortOf(hist)) + ' (earlier meetings were played by different rosters)' : hist.text)); }
    var cond = [one('weather'), one('hfa'), one('neutral'), one('division')].filter(function (c) { return c && !used[c.id]; });
    var CONDL = { weather: 'Forecast', hfa: 'Home field', neutral: 'Site', division: 'Division' };
    if (cond.length) { cond.forEach(function (c) { used[c.id] = 1; }); E.push('**Conditions.** ' + (firstParty ? '\n\n' + cond.map(function (c) { return '- **' + (CONDL[c.key] || 'Note') + ':** ' + sent(shortOf(c)); }).join('\n') : cond.map(function (c) { return sent(c.text); }).join(' '))); }
    s.evidence = E.join('\n\n');

    /* 4 · the counterargument: what could make EdgeDesk wrong */
    var K = [];
    var conTxt = reserveCon.map(function (c) { used[c.id] = 1; return firstParty ? '- ' + sent(cap(shortOf(c))) : sent(stripWhen(c.text)); });
    if (conTxt.length) K.push(firstParty ? 'Where the measured football cuts toward ' + S.against + ':\n\n' + conTxt.join('\n')
      : (X.gap && X.gap.points >= RESEARCH_GAP ? 'The case for ' + S.against + ', and against EdgeDesk’s number, starts with the matchups.' : 'The case for ' + S.against + ' is real.') + ' ' + conTxt.join(' '));
    /* the first-party page lists EdgeDesk's own diagnostics once, inside the number */
    var doubts = firstParty ? [] : ['track_record', 'other_models', 'explainer', 'classification'].map(one).filter(function (c) { return c && !used[c.id] && (X.contradicting || []).concat(c.key === 'classification' ? [c.id] : []).indexOf(c.id) >= 0; });
    if (doubts.length) { doubts.forEach(function (c) { used[c.id] = 1; }); K.push('EdgeDesk’s own record argues for caution, too. ' + doubts.map(function (c) { return sent(c.text); }).join(' ')); }
    var hfaUsed = C.some(function (c) { return c.key === 'hfa' && used[c.id]; });
    var printed = String([s.intro, s.thesis, s.evidence].join(' ') + ' ' + K.join(' '));
    var flags = (X.input_flags || []).filter(function (f) { return (/DATA_CONFLICT|HFA_CONSTANT/.test(f.key) || (firstParty && f.severity !== 'info')) && !(f.key === 'HFA_CONSTANT' && hfaUsed) && !(firstParty && f.key === 'QB_INPUT_CONFLICT') && !(firstParty && f.key === 'DATA_FAULT' && one('classification')) && printed.indexOf(f.text) < 0; });
    if (flags.length) K.push((firstParty ? 'Input audit:\n\n' + flags.map(function (f) { return '- **' + f.key.replace(/_/g, ' ').toLowerCase() + ':** ' + sent(f.text); }).join('\n')
      : flags.map(function (f) { return f.key === 'DATA_CONFLICT' ? 'EdgeDesk’s own sources also disagree on the sack numbers for ' + sentenceList(uniq(C.filter(function (c) { return c.topic === 'data'; }).map(function (c) { return c.team; }))) + '; the figures above use the corroborated counts.' : sent(f.text); }).join(' ')));
    s.counterargument = K.join('\n\n') || 'The evidence against EdgeDesk’s number is thin in the data on file; the uncertainty below is the case against it.';

    /* 5 · the game script each number needs */
    var GS = X.game_script || {};
    var gsTxt = [];
    var mtext0 = ev.market && ev.market.text;
    if (firstParty && GS.units) {
      /* a scorecard: the conditions, without repeating the figures above */
      if (GS.units.model.length) gsTxt.push('**If EdgeDesk’s number (' + (p.display.fair || (ev.model && ev.model.text) || '') + ') is right,** expect to see:\n\n' + GS.units.model.map(function (t) { return '- ' + sent(cap(t)); }).join('\n'));
      if (GS.units.market.length) gsTxt.push('**If the ' + (p.market.status === 'current' ? 'current' : 'last captured') + ' line' + (mtext0 ? ' (' + mtext0 + ')' : '') + ' is right,** expect to see:\n\n' + GS.units.market.map(function (t) { return '- ' + sent(cap(t)); }).join('\n'));
      gsTxt.push('These are conditions, not forecasts; the figures behind each are in the evidence above.');
    }
    if (!(firstParty && GS.units) && (GS.model_case || []).length) gsTxt.push('For EdgeDesk’s number (' + (p.display.fair || '') + ') to look right:\n\n' + GS.model_case.map(function (t) { return '- ' + t; }).join('\n'));
    var mtext = ev.market && ev.market.text;
    if (!(firstParty && GS.units) && (GS.market_case || []).length) gsTxt.push('For the ' + (p.market.status === 'current' ? 'current' : 'last captured') + ' line' + (mtext ? ', ' + mtext + ',' : '') + ' to look right:\n\n' + GS.market_case.map(function (t) { return '- ' + t; }).join('\n'));
    if (!(firstParty && GS.units)) gsTxt.push('Neither list is a prediction. Each is what one number needs from the game.');
    s.game_script = gsTxt.join('\n\n');

    /* 6 · first-party only: inside the number */
    if (firstParty) {
      var terms = C.filter(function (c) { return /^term:/.test(c.key) || c.key === 'hfa' || c.key === 'projection'; });
      var mech = ['explainer', 'other_models', 'track_record', 'classification'].map(one).filter(Boolean);
      var covA = (ev.coverage || []).filter(function (c) { return c.status !== 'MISSING'; }).map(function (c) { return c.label.toLowerCase(); });
      var covM = (ev.coverage || []).filter(function (c) { return c.status === 'MISSING'; }).map(function (c) { return '- ' + cap(c.label.toLowerCase()) + (c.why ? ': ' + c.why : '') + '.'; });
      /* the assessment, less what the page has already said */
      var shown0 = String([s.intro, s.thesis, s.evidence, s.counterargument, s.game_script].join('\n'));
      var assess = X.assessment && F ? F.sentences(String(X.assessment).replace(/^[A-Z_ ]+\.\s*/, '')).filter(function (x) { return shown0.indexOf(x) < 0; }).join(' ') : '';
      s.model_detail = [
        'How EdgeDesk’s number is built for this game:\n\n' + terms.map(function (c) { return '- ' + sent(c.text); }).join('\n'),
        mech.length ? 'What EdgeDesk’s own diagnostics say:\n\n' + mech.map(function (c) { return '- ' + sent(c.text); }).join('\n') : null,
        'Research status: **' + String(X.status || '').replace(/_/g, ' ') + '**' + (X.input_suspect ? ' (inputs suspect)' : '') + '. ' + (assess ? sent(assess) : ''),
        covM.length ? 'Not in EdgeDesk’s verified data for this game:\n\n' + covM.join('\n') : 'Every research item EdgeDesk looks for is on file for this game.',
        p.link ? 'The full game research, with every input and its timestamp: [' + p.away + ' vs. ' + p.home + ' on EdgeDesk](' + p.link + '). How the model works: [EdgeDesk methodology](' + SITE + '/methodology/).' : 'How the model works: [EdgeDesk methodology](' + SITE + '/methodology/).'
      ].filter(Boolean).join('\n\n');
    }

    /* 7 · what to watch, and what we still don't know */
    var W = [];
    if (X.critical_matchup && X.critical_matchup.watch) W.push(cap(X.critical_matchup.watch) + '.');
    ['away', 'home'].forEach(function (side) { var Q = qbOf(p, side); var st = Q.conflict[0] || Q.status.filter(function (c) { return c.values && c.values.contested; })[0]; if (st) W.push('Who starts at quarterback for ' + p[side] + '.'); });
    (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { return c.topic === 'injury' && c.subject && !(c.values && c.values.position === 'QB') && /QUESTIONABLE|DOUBTFUL/.test(c.status || ''); }).slice(0, 2)
      .forEach(function (c) { W.push(c.subject + ', listed ' + String(c.status).toLowerCase() + ': whether he plays, and how much.'); });
    var wx = one('weather'); if (wx && wx.material) W.push('The weather: ' + shortOf(wx) + ' in the forecast.');
    var said = String([s.intro, s.thesis, s.evidence, s.counterargument, s.game_script].join(' ')).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'), watched = W.join(' ');
    /* the open questions, without repeating what the article or the watch list
       already said; what EdgeDesk does not have on file is always listed */
    var U0 = (X.uncertainty || []).filter(function (t) {
      if (/sources disagree|availability report lists/.test(t) || said.indexOf(t.split(', according to ')[0]) >= 0) return false;
      if (/^Weather:/.test(t) && /The weather:/.test(watched)) return false;
      if (/quarterback job is unsettled/.test(t) && /Who starts at quarterback/.test(watched)) return false;
      return true;
    });
    var must = U0.filter(function (t) { return /^Not in EdgeDesk’s verified data/.test(t); });
    var U = must.concat(U0.filter(function (t) { return must.indexOf(t) < 0; }).slice(0, 5 - must.length));
    if (firstParty) {
      /* the missing data is itemised inside the number; the watch list is terse */
      var seenW = {};
      var injW = (F ? F.writer.materialInjuries(ev) : []).filter(function (c) { if (!(c.topic === 'injury' && c.subject && !(c.values && c.values.position === 'QB') && /QUESTIONABLE|DOUBTFUL/.test(c.status || '')) || seenW[c.subject]) return false; seenW[c.subject] = 1; return true; }).slice(0, 3);
      var W2 = [];
      if (X.critical_matchup && X.critical_matchup.watch) W2.push(cap(X.critical_matchup.watch) + '.');
      ['away', 'home'].forEach(function (side) { var Q = qbOf(p, side); if (Q.conflict[0] || Q.status.some(function (c) { return c.values && c.values.contested; })) W2.push((F ? F.writer.poss(p[side]) : p[side] + '’s') + ' starting quarterback.'); });
      if (injW.length) W2.push(sentenceList(injW.map(function (c) { return c.subject + ' (' + String(c.status).toLowerCase() + ')'; })) + ': who plays, and how much.');
      if (wx && wx.material) W2.push('The kickoff weather.');
      var U2 = U.filter(function (t) { return !/^Not in EdgeDesk’s verified data/.test(t); });
      s.conclusion = (W2.length ? 'Before kickoff, watch:\n\n' + W2.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
        + (U2.length ? 'Still open:\n\n' + U2.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
        + (X.status === 'UNEXPLAINED' || X.input_suspect ? 'Until those are settled, EdgeDesk’s number is a research question, not a bet.' : 'EdgeDesk’s number is an estimate of the game, not a pick.');
      return s;
    }
    s.conclusion = (W.length ? 'What to watch:\n\n' + uniq(W).map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
      + (U.length ? 'What EdgeDesk still doesn’t know:\n\n' + U.map(function (t) { return '- ' + t; }).join('\n') + '\n\n' : '')
      + (X.status === 'UNEXPLAINED' ? 'EdgeDesk’s number stays an open question until those answers arrive. None of this is a pick.' : 'None of this is a pick: it is the football that will decide the game, and the uncertainty around it.');
    return s;
  }

  function sectionsFor(o, format, ctx) {
    var s = {};
    if ((format === 'matchup_analysis' || format === 'edgedesk_analysis') && o.research.games && o.research.games.length === 1 && o.research.games[0].evidence) return analysisSections(o, format === 'edgedesk_analysis');
    if (format === 'market_discrepancy' && o.research.games && o.research.games.length === 1 && o.research.games[0].gap) return mdSections(o);
    if (format === 'trending_story') return storySections(o);
    var gs = o.research.games || [];
    var angle = ctx.angle || 'full_slate';
    var shown = gs;
    if (angle === 'upsets_first' && o.research.upsets && o.research.upsets.length) {
      var ids = o.research.upsets.map(function (p) { return p.game_id; });
      shown = o.research.upsets.concat(gs.filter(function (p) { return ids.indexOf(p.game_id) < 0; })).slice(0, gs.length);
    }
    var maxGames = ctx.maxGames || 6;
    shown = shown.slice(0, maxGames);
    s.intro = ctxIntro(o);
    s.why_it_matters = whyItMatters(o);
    s.how_to_read = howToRead(o);
    s.games = shown.map(function (p, i) { return capsule(p, { links: ctx.links, tight: ctx.tight, index: i }); }).join('\n\n');
    s.upsets = o.kind === 'upset_watch' ? null : upsetsSection(o, shown.map(function (p) { return p.game_id; }));
    s.conference = o.league === 'cfb' ? conferenceSection(o) : null;
    s.disagreements = o.league === 'nfl' || format === 'market_discrepancy' ? disagreementsSection(o) : null;
    s.injuries = o.league === 'nfl' ? injuriesSection(o) : null;
    s.limits = limitsSection(o);
    s.conclusion = conclusionSection(o);
    if (o.kind === 'upset_watch') {
      s.upsets = 'Whether an underdog is worth backing depends entirely on the price, which this article doesn’t assess. These are the games where the model says the favorite is more vulnerable than its billing.';
    }
    return s;
  }

  function sectionOrder(format, publisher) {
    var F = FORMATS[format] || FORMATS.cfb_weekly_preview;
    if (F.sections) return F.sections;
    var custom = publisher && publisher.editorial && publisher.editorial.sections;
    return Array.isArray(custom) && custom.length ? custom : FORMATS.cfb_weekly_preview.sections;
  }

  /* The article. ctx: { publisher, format, angle, campaign, now, links } */
  function draft(o, ctx) {
    ctx = ctx || {};
    var format = ctx.format || formatsFor(o)[0];
    if (formatsFor(o).indexOf(format) < 0) format = formatsFor(o)[0];
    var publisher = ctx.publisher || null;
    var ed = (publisher && publisher.editorial) || {};
    var links = ed.links_allowed !== false;
    var baseFormat = baseFormatOf(o, format);
    var maxGames = ed.max_games || (ed.length && ed.length.max && ed.length.max < 1200 ? 4 : 6);
    var raw = sectionsFor(o, baseFormat, { angle: ctx.angle, maxGames: maxGames, links: links, tight: !!(ed.length && ed.length.max && ed.length.max <= 1500) });
    var preview = /_weekly_preview$/.test(baseFormat);
    var order = format === 'publisher_custom' && preview ? sectionOrder(format, publisher) : sectionOrder(baseFormat, publisher);
    var sections = [];
    order.forEach(function (k) {
      var body = raw[k];
      if (!body) return;
      var FF = FORMATS[format] || FORMATS[baseFormat] || {};
      sections.push({ key: k, heading: (FF.headings && FF.headings[k]) || SECTION_HEADINGS[k] || null, body: body });
    });
    var seo = o.seo || seoBrief(o, publisher);
    var title = ctx.title || seo.headline || o.title;
    var a = {
      format: format, base_format: baseFormat, angle: ctx.angle || 'full_slate', title: title, slug: slugify(title), meta_description: seo.meta_description,
      primary_keyword: seo.primary_keyword, secondary_keywords: seo.secondary_keywords,
      standfirst: standfirstFor(o), sections: sections, generator: 'template:' + VERSION, generated_at: iso(isNum(ctx.now) ? ctx.now : Date.now()),
      research_as_of: o.research && o.research.as_of || null, research_hash: researchHash(o)
    };
    a.word_count = wordCount(a.standfirst + ' ' + sections.map(function (s) { return s.body; }).join(' '));
    return a;
  }
  function standfirstFor(o) {
    if (o.kind === 'weekly_preview') return 'EdgeDesk’s model projects the biggest games of Week ' + o.week + ', from the clear favorites to the upsets worth watching. Research, not picks.';
    if (o.kind === 'upset_watch') return 'The Week ' + o.week + ' underdogs EdgeDesk’s model gives a real chance, and why a possible upset is not the same thing as a bet.';
    if (o.kind === 'conference_race') return 'What EdgeDesk’s ratings and projections say about the ' + o.research.conference + ' race this week.';
    if (o.kind === 'market_discrepancy') return 'Where EdgeDesk’s projection and the betting line disagree, and what could explain the gap.';
    if (o.kind === 'matchup_analysis') {
      var p0 = (o.research.games || [])[0], X1 = p0 && p0.evidence && p0.evidence.explanation || {};
      return p0 ? (X1.headline_question ? X1.headline_question.replace(/’/g, '’') + ' ' : '') + 'The football behind EdgeDesk’s ' + p0.away + '–' + p0.home + ' projection, the evidence against it, and what has to happen on the field.' : 'The football behind EdgeDesk’s projection.';
    }
    return 'The news, and what EdgeDesk’s numbers say about it, kept separate.';
  }
  function researchHash(o) { return hash(JSON.stringify(o && o.research || {})); }

  /* the outline: the brief plus the section plan, before any prose */
  function outline(o, ctx) {
    var a = draft(o, ctx);
    return {
      title: a.title, slug: a.slug, meta_description: a.meta_description, primary_keyword: a.primary_keyword,
      secondary_keywords: a.secondary_keywords, standfirst: a.standfirst,
      sections: a.sections.map(function (s) {
        var first = String(s.body).split(/\n\n/)[0];
        return { key: s.key, heading: s.heading, plan: first.length > 220 ? first.slice(0, 217).replace(/\s+\S*$/, '') + '…' : first };
      }),
      structure: (o.seo || {}).structure || []
    };
  }

  /* ======================================================================
     EVIDENCE + VALIDATE
     ====================================================================== */
  var NUM_RE = /(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?)/g;
  function numbersIn(text) {
    var out = [], m;
    text = String(text).replace(/(\d),(?=\d{3}\b)/g, '$1');   /* 1,222 is one number */
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(text))) out.push(parseFloat(m[1]));
    return out;
  }
  function addNum(set, x) {
    if (!isNum(x)) return;
    var a = Math.abs(x);
    [a, r1(a), Math.round(a), Math.round(a * 100), r1(a * 100), Math.floor(a), Math.ceil(a)].forEach(function (v) { set[String(+v.toFixed(2))] = 1; });
  }
  function walk(x, fn, depth) {
    if (depth > 8 || x == null) return;
    if (Array.isArray(x)) { x.forEach(function (v) { walk(v, fn, depth + 1); }); return; }
    if (typeof x === 'object') { Object.keys(x).forEach(function (k) { walk(x[k], fn, depth + 1); }); return; }
    fn(x);
  }
  /* everything an article about this opportunity may say: numbers (with the
     rounding a writer would use), teams, people, sources */
  function evidenceOf(o) {
    var nums = {}, teams = {}, names = {}, srcs = [];
    var NAME_RE = /\b[A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?\b/g;
    /* the league-wide team list is for catching teams, never evidence of them */
    var research = Object.assign({}, o.research, { context: Object.assign({}, o.research.context, { team_names: undefined }) });
    /* an evidence packet's numbers are NOT a general pool: each is valid only in
       a sentence that cites its claim (validate step 3). Its names are. */
    research.games = (research.games || []).map(function (p) {
      var c = Object.assign({}, p);
      /* the explanation (gap, explained share, audit, script) is EdgeDesk's own
         deterministic reading of this game: its figures are research */
      var X = p.evidence && p.evidence.explanation;
      if (X) c.explanation_figures = [X.gap ? X.gap.points : null, X.mechanical ? X.mechanical.explained_points : null, X.mechanical ? X.mechanical.unexplained_points : null].filter(isNum);
      delete c.evidence;
      return c;
    });
    (o.research.games || []).forEach(function (p) {
      evClaims(p).forEach(function (c) { [c.text, c.short].forEach(function (t) { if (t && t.length < 600) (t.match(NAME_RE) || []).forEach(function (n) { names[n] = 1; }); }); });
    });
    walk(research, function (v) {
      if (typeof v === 'number') addNum(nums, v);
      else if (typeof v === 'string') {
        numbersIn(v).forEach(function (n) { addNum(nums, n); });
        /* a person the research itself names (a risk note, a quarterback battle) may be named */
        (v.length < 600 ? v.match(NAME_RE) || [] : []).forEach(function (n) { names[n] = 1; });
      }
    }, 0);
    /* derived numbers the writer prints: complements and the week */
    walk(research, function (v) { if (typeof v === 'number' && v > 0 && v < 1) addNum(nums, 1 - v); }, 0);
    [o.week, o.season].forEach(function (v) { addNum(nums, v); });
    for (var i = 0; i <= 12; i++) addNum(nums, i);
    [25, 30, 49, 50, 70, 100, 180, 2024, 2025, 2026, 2027].forEach(function (v) { addNum(nums, v); });
    (o.research.games || []).concat(o.research.upsets || [], o.research.races || []).forEach(function (p) {
      teams[p.home] = 1; teams[p.away] = 1;
      [p.home_conference, p.away_conference, p.venue, p.market && p.market.book, p.market && bookName(p.market.book)].forEach(function (x) { if (x) names[x] = 1; });
      ['home', 'away'].forEach(function (s) { var q = p.qb && p.qb[s]; if (q && q.player) names[q.player] = 1;
        var inj = p.injuries && p.injuries[s]; (inj && inj.qbs || []).forEach(function (x) { names[x.name] = 1; }); });
    });
    ((o.research.context && o.research.context.top10) || []).forEach(function (t) { teams[t.team] = 1; });
    (o.research.conference_top || []).forEach(function (t) { teams[t] = 1; });
    (o.research.news || []).forEach(function (n) { (n.teams || []).forEach(function (t) { teams[t] = 1; }); numbersIn(n.title + ' ' + (n.summary || '')).forEach(function (x) { addNum(nums, x); }); });
    (o.sources || []).forEach(function (s) { srcs.push(s); });
    return { numbers: nums, teams: teams, names: names, sources: srcs };
  }

  function textOf(a) {
    return [a.title, a.standfirst, a.meta_description].concat((a.sections || []).map(function (s) { return (s.heading || '') + '\n' + s.body; })).join('\n\n');
  }
  function stripForNumbers(t) {
    return String(t)
      .replace(/\]\((https?:\/\/[^)\s]+)\)/g, ']')            /* link targets */
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/1-800-GAMBLER/gi, ' ').replace(/\b21\+/g, ' ')
      .replace(/\b(?:19|20)\d{2}\b/g, ' ');                    /* years */
  }
  function sentencesOf(t) { return String(t).replace(/\n+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z“"*(\-])/); }

  /* team names every league knows, so a team the evidence never mentions is
     caught. lists: { cfb: [names], nfl: [names] } supplied by the host (the
     admin page and the job pass the season's full lists). */
  function teamsMentioned(text, list, people) {
    var found = [], rest = ' ' + text + ' ';
    (people || []).forEach(function (n) { if (n) rest = rest.split(n).join(' '); });
    (list || []).slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (n) {
      var re = new RegExp('(^|[^A-Za-z&])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'g');
      if (re.test(rest)) { found.push(n); rest = rest.replace(re, '$1 '); }
    });
    return found;
  }

  /* opts: { publisher, now, siblings: [{id, title, text}], teamLists: {cfb:[], nfl:[]}, generator } */
  function validate(a, o, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var checks = [];
    function add(id, status, label, detail) { checks.push({ id: id, status: status, label: label, detail: detail || null }); }
    var text = textOf(a);
    var body = (a.sections || []).map(function (s) { return s.body; }).join('\n\n');
    var ev = evidenceOf(o);
    var format = a.format || 'cfb_weekly_preview';
    var base = a.base_format || baseFormatOf(o, format);
    var F = FORMATS[base] || {};
    var ed = (opts.publisher && opts.publisher.editorial) || {};

    /* 1 structure */
    var keys = (a.sections || []).map(function (s) { return s.key; });
    var need = (F.required || []).filter(function (k) { return format !== 'publisher_custom' || /_weekly_preview$/.test(base) ? true : true; });
    if (format === 'publisher_custom' && /_weekly_preview$/.test(base)) need = FORMATS.publisher_custom.required;
    var missing = need.filter(function (k) { return keys.indexOf(k) < 0; });
    add('structure', missing.length ? 'fail' : 'pass', 'Required sections present', missing.length ? 'missing: ' + missing.join(', ') : null);
    var empty = (a.sections || []).filter(function (s) { return !s.body || wordCount(s.body) < 8; }).map(function (s) { return s.key; });
    if (empty.length) add('empty_sections', 'fail', 'No empty sections', empty.join(', '));
    if (!a.title || a.title.length < 20) add('headline', 'fail', 'Headline present', 'too short');
    else add('headline', a.title.length > 75 ? 'warn' : 'pass', 'Headline length', a.title.length + ' characters' + (a.title.length > 75 ? ' (search results cut off near 60–70)' : ''));

    /* 2 language */
    var banned = [];
    BANNED_RE.forEach(function (b) { var m = b.re.exec(text); if (m) banned.push('“' + m[0] + '” — ' + b.why); });
    add('no_recommendation', banned.length ? 'fail' : 'pass', 'No pick, lock, guarantee or staking language', banned.length ? banned.slice(0, 5).join(' · ') : null);
    var tells = AI_TELLS.filter(function (re) { return re.test(text); }).map(function (re) { var m = re.exec(text); return m && m[0]; });
    add('no_filler', tells.length ? 'warn' : 'pass', 'No generic AI filler', tells.length ? tells.join(', ') : null);
    add('no_stringified_nothing', STRINGIFIED_NOTHING.test(text) ? 'fail' : 'pass', 'No “null”, “undefined” or “NaN” in the copy');

    /* 3 numbers: every figure must be in the research, or in a football claim
       that the same sentence cites */
    var FEm = fe(), packets = (o.research.games || []).map(function (p) { return p.evidence; }).filter(Boolean);
    var unsupported = [];
    sentencesOf(text).forEach(function (orig) {
      var miss = numbersIn(stripForNumbers(orig)).filter(function (n) { return !ev.numbers[String(+n.toFixed(2))]; });
      if (!miss.length) return;
      var claimNums = {};
      if (FEm) packets.forEach(function (pk) { FEm.citedClaims(pk, orig).forEach(function (c) { numbersIn(c.text + ' ' + (c.short || '')).forEach(function (m) { addNum(claimNums, m); }); }); });
      /* …or in EdgeDesk's own explanation of this game, when the sentence uses that explanation's words */
      var sh = shingles(orig);
      packets.forEach(function (pk) {
        explanationFragments(pk).forEach(function (fr) {
          var fs = shingles(fr), share = false;
          for (var k in fs) { if (sh[k]) { share = true; break; } }
          if (share) numbersIn(fr).forEach(function (m) { addNum(claimNums, m); });
        });
      });
      miss.forEach(function (n) { if (!claimNums[String(+n.toFixed(2))]) unsupported.push(n); });
    });
    unsupported = uniq(unsupported);
    add('numbers_in_evidence', unsupported.length ? 'fail' : 'pass', 'Every number comes from EdgeDesk research or a cited source',
      unsupported.length ? 'not in the evidence: ' + unsupported.slice(0, 10).join(', ') : null);

    /* 4 teams: no team the research does not cover */
    var lists = opts.teamLists || {};
    var known = (lists[o.league] && lists[o.league].length ? lists[o.league] : ((o.research.context && o.research.context.team_names) || []));
    if (known.length) {
      /* a person's name is masked before teams are matched (Isaiah Marshall is
         not Marshall) — but never a name that is itself a team */
      var people = Object.keys(ev.names).filter(function (n) { return known.indexOf(n) < 0 && !known.some(function (t) { return n.indexOf(t) === 0 && n.length === t.length; }); });
      var evText = (o.research.games || []).map(function (p) { return evClaims(p).map(function (c) { return c.text; }).join(' '); }).join(' ');
      var extra = teamsMentioned(text, known, people).filter(function (t) { return !ev.teams[t] && evText.indexOf(t) < 0; });
      add('teams_in_evidence', extra.length ? 'fail' : 'pass', 'Every team named is in the research', extra.length ? 'not in this article’s research: ' + extra.join(', ') : null);
    }
    /* people: capitalised two-word names that are not teams or evidence */
    var people = [], pm, PRE = /\b([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\b/g;
    var allowWords = /^(EdgeDesk|Research|The|Projected|Model|Full|Bottom|Week|What|Why|How|Upset|Injury|Matchup|Sportsbook|Search|Gamble|Nothing|College|National|Football|League|Pass|Run|Team|Home|Stylistic|Official|Not|Prices|Quarterbacks|Uncertainty|Injuries|For|From|Each|These|None|This|That|It|If|When|Here|Every|Most|Some|Sat|Sun|Mon|Tue|Wed|Thu|Fri|Oct|Sept|Nov|Dec|Jan|Aug|Whether|Who|Can|Against|Before|Since|Over|In|At|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Only|Nearly|Part|Treat|Until)\b/;
    var teamWords = Object.keys(ev.teams).join(' ');
    while ((pm = PRE.exec(body))) {
      var nm = pm[1];
      if (ev.names[nm] || allowWords.test(nm) || teamWords.indexOf(nm) >= 0 || Object.keys(ev.names).some(function (x) { return x.indexOf(nm) >= 0; })) continue;
      if (known.some(function (t) { return t.indexOf(nm) >= 0 || nm.indexOf(t) >= 0; })) continue;
      people.push(nm);
    }
    people = uniq(people);
    add('names_in_evidence', people.length ? 'warn' : 'pass', 'People named appear in the research', people.length ? 'check: ' + people.slice(0, 8).join(', ') : null);

    /* 5 projection is not betting value */
    var hasExplainer = /not a bet|isn’t a bet|is not a bet|not the same thing as a bet|not betting advice/i.test(body);
    add('projection_not_value', hasExplainer ? 'pass' : 'fail', 'Explains that a projection is not a bet', hasExplainer ? null : 'add the “how to read” explanation');

    /* 6 stale prices never presented as current */
    var staleBad = [];
    (o.research.games || []).forEach(function (p) {
      if (!p.market || p.market.status === 'current' || p.market.status === 'none' || !isNum(p.market.home_line)) return;
      var mf = favOf(p.home, p.away, p.market.home_line);
      var needle = mf && mf.favorite ? mf.favorite + ' -' + lineNum(mf.margin) : null;
      if (!needle) return;
      sentencesOf(body).forEach(function (s) {
        if (s.indexOf(needle) >= 0 && !/captured|as of|reference|stale|older|last line|last sportsbook|no capture|freshness|was\b/i.test(s)) staleBad.push(needle);
      });
      if (/\b(?:current|live) (?:line|price|odds)\b/i.test(body) && p.market.status !== 'current' && body.indexOf(needle) >= 0) {
        sentencesOf(body).forEach(function (s) { if (s.indexOf(needle) >= 0 && /\b(?:current|live) (?:line|price|odds)\b/i.test(s)) staleBad.push(needle + ' called current'); });
      }
    });
    add('stale_prices_labelled', staleBad.length ? 'fail' : 'pass', 'Old or reference prices are labelled with their age', staleBad.length ? uniq(staleBad).join(', ') : null);

    /* 7 games already started */
    var started = (o.research.games || []).filter(function (p) { var t = ts(p.kickoff); return t != null && t <= now; });
    add('games_not_started', started.length ? 'warn' : 'pass', 'Featured games have not kicked off', started.length ? started.map(function (p) { return p.away + ' at ' + p.home; }).join(', ') + ' — refresh or remove' : null);

    /* 8 research freshness at validation time */
    var asOf = ts(o.research.as_of);
    var ageH = asOf == null ? null : (now - asOf) / 3600000;
    add('research_fresh', ageH == null ? 'warn' : ageH > 36 ? 'warn' : 'pass', 'Research is recent', ageH == null ? 'research has no timestamp' : 'research is ' + Math.round(ageH) + ' hours old' + (ageH > 36 ? ' — refresh the opportunity before sending' : ''));

    /* 9 external reporting attributed */
    var ext = (o.sources || []).filter(function (s) { return s.kind === 'external_report'; });
    if (ext.length) {
      var unattributed = ext.filter(function (s) { return body.indexOf(s.publisher) < 0 || body.indexOf(s.url) < 0; });
      add('reporting_attributed', unattributed.length ? 'fail' : 'pass', 'External reporting is attributed and linked', unattributed.length ? unattributed.map(function (s) { return s.publisher; }).join(', ') : null);
    }
    if (/\b(?:reportedly|sources say|according to reports)\b/i.test(body) && !ext.length) add('unsourced_reporting', 'fail', 'No unsourced reporting', 'the article cites reporting with no source on file');

    /* 10 disclaimer + attribution are added at export; check the publisher permits a link */
    add('disclaimer', 'pass', 'Disclaimer (21+, 1-800-GAMBLER) is added to every export', DISCLAIMER);

    /* 11 length */
    var wc = a.word_count || wordCount(body);
    /* a publisher's length target is for its weekly previews; a news story
       or a one-game analysis keeps its own format's range */
    var range = (/_weekly_preview$/.test(base) && ed.length && ed.length.min && ed.length.max) ? [ed.length.min, ed.length.max] : (F.words || [500, 2000]);
    add('length', wc < range[0] * 0.8 || wc > range[1] * 1.25 ? 'warn' : 'pass', 'Length fits the target', wc + ' words (target ' + range[0] + '–' + range[1] + ')');

    /* 12 SEO */
    var kw = String(a.primary_keyword || '').toLowerCase();
    if (kw) {
      var stem = function (t) { return t.replace(/(?:es|s)$/, ''); };
      var kwTokens = kw.split(/\s+/).filter(function (t) { return t.length > 2; }).map(stem);
      var inTitle = kwTokens.every(function (t) { return a.title.toLowerCase().indexOf(t) >= 0; });
      var first = words(body).slice(0, 150).join(' ').toLowerCase();
      var inIntro = kwTokens.filter(function (t) { return first.indexOf(t) >= 0; }).length >= Math.ceil(kwTokens.length * 0.75);
      add('seo_keyword', inTitle && inIntro ? 'pass' : 'warn', 'Primary keyword in the headline and opening', (inTitle ? '' : 'not in headline; ') + (inIntro ? '' : 'not in the first 150 words'));
    }
    var md = String(a.meta_description || '');
    add('seo_meta', md.length >= 90 && md.length <= 160 ? 'pass' : 'warn', 'Meta description 90–160 characters', md.length + ' characters');
    add('seo_slug', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug || '') && (a.slug || '').length <= 80 ? 'pass' : 'warn', 'URL slug is clean', a.slug || null);
    var stuffing = kw ? (text.toLowerCase().split(kw).length - 1) : 0;
    if (stuffing > 4) add('seo_stuffing', 'warn', 'No keyword stuffing', 'primary keyword appears ' + stuffing + ' times');

    /* 13 near-duplicates among articles from the same research */
    var dup = (opts.siblings || []).map(function (sb) { return { id: sb.id, title: sb.title, sim: similarity(body, sb.text) }; })
      .sort(function (x, y) { return y.sim - x.sim; })[0];
    if (dup) add('not_duplicate', dup.sim >= 0.7 ? 'fail' : dup.sim >= 0.45 ? 'warn' : 'pass', 'Original against sibling articles', 'closest: ' + Math.round(dup.sim * 100) + '% overlap with “' + dup.title + '”');

    /* 14 the football evidence gate (lib/football_evidence.js): fluent prose,
       SEO and a high quality score are not enough — every featured game needs
       measured football, the evidence against EdgeDesk, correct availability,
       no unsupported causal story and no edge language */
    var F = fe(), gate = null;
    if (!F) add('evidence_gate', 'fail', 'Football evidence gate available', 'lib/football_evidence.js is not loaded, so the article cannot be checked against football evidence');
    else {
      gate = F.gate(a, o.research, { publisher: !isFirstParty(format), sources: o.sources, single: SINGLE_GAME[base] === true || SINGLE_GAME[format] === true });
      gate.checks.forEach(function (c) { checks.push(c); });
      /* outside reporting an article cites names its outlet */
      var unattributed = [];
      (gate.evidence_record || []).forEach(function (r) {
        if ((r.verification === 'REPORTED' || r.verification === 'VERIFIED_REPORT') && r.source && r.source.publisher && body.indexOf(r.source.publisher) < 0) unattributed.push(r.source.publisher);
      });
      add('reported_attributed', unattributed.length ? 'fail' : 'pass', 'Outside reporting is attributed to its outlet', unattributed.length ? 'name ' + uniq(unattributed).join(', ') : null);
    }

    var fails = checks.filter(function (c) { return c.status === 'fail'; });
    var warns = checks.filter(function (c) { return c.status === 'warn'; });
    return {
      ok: fails.length === 0, checks: checks, failed: uniq(fails.map(function (c) { return c.id; })), warned: uniq(warns.map(function (c) { return c.id; })),
      /* READY only with nothing failed and nothing awaiting an editor's confirmation */
      readiness: fails.length ? 'BLOCKED' : (gate && gate.readiness === 'HOLD_FOR_REVIEW' ? 'HOLD_FOR_REVIEW' : 'READY'),
      holds: gate ? gate.holds : [], evidence_record: gate ? gate.evidence_record : [],
      checked_at: iso(now), version: VERSION
    };
  }

  function explanationFragments(pk) {
    var X = (pk && pk.explanation) || {};
    return [X.thesis, X.assessment, X.critical_matchup && X.critical_matchup.text].concat((X.input_flags || []).map(function (f) { return f.text; }),
      (X.game_script && X.game_script.model_case) || [], (X.game_script && X.game_script.market_case) || [], X.uncertainty || []).filter(Boolean);
  }
  /* 5-word shingle Jaccard similarity */
  function shingles(t) {
    var w = words(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')), out = {};
    for (var i = 0; i + 5 <= w.length; i++) out[w.slice(i, i + 5).join(' ')] = 1;
    return out;
  }
  function similarity(a, b) {
    var A = shingles(a), B = shingles(b), inter = 0, na = 0, nb = 0;
    Object.keys(A).forEach(function (k) { na++; if (B[k]) inter++; });
    nb = Object.keys(B).length;
    var union = na + nb - inter;
    return union ? inter / union : 0;
  }

  /* ======================================================================
     ATTRIBUTION + EXPORT
     ====================================================================== */
  /* utm_campaign as growth.sql keeps it: lowercase [a-z0-9_.-], ≤ 64 */
  function campaignCode(publisherSlug, articleId) {
    var p = String(publisherSlug || 'direct').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'direct';
    var a = String(articleId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || hash(String(Date.now())).slice(0, 8);
    return ('ce_' + p + '_' + a).slice(0, 64);
  }
  function tagLink(url, utm) {
    utm = utm || {};
    var u;
    try { u = new URL(url); } catch (e) { return url; }
    if (!/(^|\.)edgedesksports\.com$/.test(u.hostname)) return url; /* only EdgeDesk links are tagged */
    if (utm.source) u.searchParams.set('utm_source', String(utm.source).toLowerCase().replace(/[^a-z0-9_.-]/g, ''));
    if (utm.medium) u.searchParams.set('utm_medium', String(utm.medium).toLowerCase().replace(/[^a-z0-9_.-]/g, ''));
    if (utm.campaign) u.searchParams.set('utm_campaign', String(utm.campaign).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64));
    if (utm.content) u.searchParams.set('utm_content', String(utm.content).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 64));
    return u.toString();
  }
  function utmFor(publisher, a, campaign) {
    return { source: (publisher && (publisher.utm_source || publisher.slug)) || 'direct', medium: 'publisher', campaign: campaign, content: a.format };
  }
  /* rewrite every EdgeDesk link in a body with the article's UTM tags */
  function tagBody(md, utm) {
    return String(md).replace(/\]\((https:\/\/(?:www\.)?edgedesksports\.com[^)\s]*)\)/g, function (_, u) { return '](' + tagLink(u, utm) + ')'; });
  }

  function attributionFor(a, o, ctx) {
    ctx = ctx || {};
    var pub = ctx.publisher, ed = (pub && pub.editorial) || {};
    var asOf = o && o.research && ts(o.research.as_of);
    var league = o && o.league === 'nfl' ? 'NFL' : 'college football';
    var line = 'Research by EdgeDesk Sports, an independent sports research platform. Projections are from EdgeDesk’s ' + league + ' model' + (asOf ? ' as of ' + whenText(asOf) : '') + '.';
    if (ed.links_allowed === false) return line + (ed.attribution ? ' ' + ed.attribution : '');
    var landing = ctx.landing || SITE + '/today/';
    return line + ' See every game’s numbers at [EdgeDesk](' + tagLink(landing, utmFor(pub, a, ctx.campaign)) + ').' + (ed.attribution ? ' ' + ed.attribution : '');
  }

  /* ctx: { publisher, campaign, frontMatter: bool, opportunity } */
  function toMarkdown(a, ctx) {
    ctx = ctx || {};
    var utm = utmFor(ctx.publisher, a, ctx.campaign);
    var out = [];
    if (ctx.frontMatter) {
      out.push('---');
      out.push('title: ' + JSON.stringify(a.title));
      out.push('slug: ' + JSON.stringify(a.slug));
      out.push('meta_description: ' + JSON.stringify(a.meta_description || ''));
      out.push('primary_keyword: ' + JSON.stringify(a.primary_keyword || ''));
      out.push('secondary_keywords: ' + JSON.stringify(a.secondary_keywords || []));
      out.push('---', '');
    }
    out.push('# ' + a.title, '');
    if (a.standfirst) out.push('*' + a.standfirst + '*', '');
    (a.sections || []).forEach(function (s) {
      if (s.heading) out.push('## ' + s.heading, '');
      out.push(tagBody(s.body, utm), '');
    });
    out.push('---', '');
    out.push(tagBody(attributionFor(a, ctx.opportunity, ctx), utm), '');
    out.push('*' + DISCLAIMER + '*', '');
    return out.join('\n');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]; }); }
  /* the small Markdown subset the writer uses: paragraphs, ### headings,
     "- " bullets, **bold**, *italic*, [text](https://…). Everything else is
     text, escaped. */
  function inline(s) {
    var t = esc(s);
    t = t.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, function (_, txt, url) { return '<a href="' + url.replace(/&amp;/g, '&').replace(/"/g, '%22').replace(/&/g, '&amp;') + '" rel="noopener">' + txt + '</a>'; });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return t;
  }
  function mdToHtml(md) {
    var blocks = String(md || '').split(/\n{2,}/), out = [];
    blocks.forEach(function (b) {
      b = b.replace(/^\n+|\n+$/g, '');
      if (!b) return;
      if (/^### /.test(b)) { out.push('<h3>' + inline(b.slice(4)) + '</h3>'); return; }
      if (/^## /.test(b)) { out.push('<h2>' + inline(b.slice(3)) + '</h2>'); return; }
      if (/^# /.test(b)) { out.push('<h1>' + inline(b.slice(2)) + '</h1>'); return; }
      if (/^---$/.test(b)) { out.push('<hr>'); return; }
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^- /.test(l); })) { out.push('<ul>' + lines.map(function (l) { return '<li>' + inline(l.slice(2)) + '</li>'; }).join('') + '</ul>'); return; }
      out.push('<p>' + lines.map(inline).join('<br>') + '</p>');
    });
    return out.join('\n');
  }
  /* ctx as toMarkdown, plus standalone: a complete document for preview */
  function toHtml(a, ctx) {
    ctx = ctx || {};
    var md = toMarkdown(a, Object.assign({}, ctx, { frontMatter: false }));
    var body = mdToHtml(md);
    if (!ctx.standalone) return body;
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta name="robots" content="noindex,nofollow"><title>' + esc(a.title) + '</title>'
      + '<meta name="description" content="' + esc(a.meta_description || '') + '">'
      + '<style>body{font:17px/1.6 Georgia,serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1d1d1f;background:#fff}h1{font:700 30px/1.2 system-ui,sans-serif}h2{font:700 21px/1.3 system-ui,sans-serif;margin-top:32px}h3{font:600 17px/1.35 system-ui,sans-serif;margin-top:22px}a{color:#0b6e63}hr{border:0;border-top:1px solid #ddd;margin:28px 0}em{color:#555}</style>'
      + '</head><body>\n' + body + '\n</body></html>\n';
  }
  /* the SEO sheet that travels with an export */
  function seoSheet(a, o) {
    var s = (o && o.seo) || {};
    return [
      'Headline: ' + a.title,
      'Alternatives: ' + (s.alternatives || []).join(' | '),
      'Slug: ' + a.slug,
      'Meta description: ' + (a.meta_description || ''),
      'Primary keyword: ' + (a.primary_keyword || ''),
      'Secondary keywords: ' + (a.secondary_keywords || []).join(', '),
      'Search intent: ' + (s.intent || ''),
      'Demand: ' + ((s.demand && s.demand.note) || 'estimate'),
      'Internal links: ' + (s.internal_links || []).map(function (l) { return l.url; }).join(' '),
      'External links: ' + ((s.external_links || []).map(function (l) { return l.url; }).join(' ') || 'none')
    ].join('\n');
  }

  /* ======================================================================
     WORD (.docx) — the copy an editor touches up. Built here, with no
     dependency: the same Markdown the other exports use, as WordprocessingML
     (headings as Word headings, so Google Docs keeps them too; bullets, bold,
     italic, live links), zipped with stored entries. The tagged EdgeDesk link,
     the research credit and the disclaimer are in it, and a last page "For
     the editor" (not for publication) carries the SEO sheet and asks that
     those three stay. Returns a Uint8Array.
     ====================================================================== */
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = [];
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  /* files: [{ name, data: string }] → a ZIP (stored, no compression) */
  function zipStore(files) {
    var parts = [], central = [], offset = 0;
    var DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; /* fixed: the same article gives the same bytes */
    files.forEach(function (f) {
      var name = utf8(f.name), data = utf8(f.data), crc = crc32(data);
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0, true); h.setUint16(8, 0, true);
      h.setUint16(10, DOS_TIME, true); h.setUint16(12, DOS_DATE, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
      c.setUint16(12, DOS_TIME, true); c.setUint16(14, DOS_DATE, true); c.setUint32(16, crc, true);
      c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (n, b) { return n + b.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(e.buffer)]);
    var out = new Uint8Array(all.reduce(function (n, b) { return n + b.length; }, 0)), at = 0;
    all.forEach(function (b) { out.set(b, at); at += b.length; });
    return out;
  }
  /* text safe inside XML: escaped, and without the control characters XML forbids */
  function xesc(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  /* the writer's inline subset → runs: { t, b, i, link } */
  function docxRuns(s) {
    var out = [], re = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|(^|[\s(])\*([^*\s][^*]*)\*/g, last = 0, m;
    while ((m = re.exec(s))) {
      var lead = m[4] || '';
      var start = m.index + lead.length;
      if (start > last) out.push({ t: s.slice(last, start) });
      if (m[1] != null) out.push({ t: m[1], link: m[2] });
      else if (m[3] != null) out.push({ t: m[3], b: true });
      else out.push({ t: m[5], i: true });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: s.slice(last) });
    return out;
  }
  function toDocx(a, ctx) {
    ctx = ctx || {};
    var md = toMarkdown(a, Object.assign({}, ctx, { frontMatter: false }));
    var links = [];
    function run(r, extra) {
      var pr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (extra || '');
      return '<w:r>' + (pr ? '<w:rPr>' + pr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + xesc(r.t) + '</w:t></w:r>';
    }
    function runs(text, allItalic) {
      return docxRuns(text).map(function (r) {
        if (allItalic) r.i = true;
        if (!r.link) return run(r);
        links.push(r.link);
        return '<w:hyperlink r:id="rIdL' + links.length + '" w:history="1">' + run(r, '<w:rStyle w:val="Hyperlink"/>') + '</w:hyperlink>';
      }).join('');
    }
    function para(style, inner, extraPr) {
      var pr = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (extraPr || '');
      return '<w:p>' + (pr ? '<w:pPr>' + pr + '</w:pPr>' : '') + inner + '</w:p>';
    }
    var body = [];
    String(md).split(/\n{2,}/).forEach(function (b) {
      b = b.replace(/^\n+|\n+$/g, '');
      if (!b) return;
      if (/^# /.test(b)) { body.push(para('Title', runs(b.slice(2)))); return; }
      if (/^## /.test(b)) { body.push(para('Heading2', runs(b.slice(3)))); return; }
      if (/^### /.test(b)) { body.push(para('Heading3', runs(b.slice(4)))); return; }
      if (/^---$/.test(b)) { body.push(para(null, '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr>')); return; }
      var lines = b.split('\n');
      if (lines.every(function (l) { return /^- /.test(l); })) {
        lines.forEach(function (l) { body.push(para('ListParagraph', runs(l.slice(2)), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')); });
        return;
      }
      /* a whole paragraph in *…* (the standfirst, the disclaimer) is italic */
      var whole = /^\*([^*][\s\S]*[^*])\*$/.exec(b);
      if (whole && lines.length === 1) { body.push(para(null, runs(whole[1], true))); return; }
      body.push(para(null, lines.map(function (l) { return runs(l); }).join('<w:r><w:br/></w:r>')));
    });
    if (ctx.editorNotes !== false) {
      body.push(para('Heading1', runs('For the editor (not for publication)'), '<w:pageBreakBefore/>'));
      body.push(para(null, runs('Edit freely for your style. Please keep three things: the EdgeDesk link (it is tagged so we can count the readers you send us), the research credit, and the 21+ responsible-gambling line. If you change a projection, a number or a team’s chances, please check it with us first: those come straight from EdgeDesk’s model.')));
      seoSheet(a, ctx.opportunity).split('\n').forEach(function (l) {
        var k = l.indexOf(': ');
        body.push(para(null, k > 0 ? run({ t: l.slice(0, k + 1), b: true }) + run({ t: ' ' + l.slice(k + 2) }) : runs(l)));
      });
    }
    var W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    var R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    var XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var doc = XML + '<w:document ' + W + ' xmlns:r="' + R + '"><w:body>' + body.join('')
      + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
    function style(id, name, type, rpr, ppr, extra) {
      return '<w:style w:type="' + type + '" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' + (extra || '') + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '</w:style>';
    }
    var head = function (lvl, sz) { return ['<w:keepNext/><w:spacing w:before="' + (lvl === 0 ? 360 : 280) + '" w:after="120"/><w:outlineLvl w:val="' + lvl + '"/>', '<w:b/><w:sz w:val="' + sz + '"/>']; };
    var h1 = head(0, 32), h2 = head(1, 28), h3 = head(2, 24);
    var styles = XML + '<w:styles ' + W + '>'
      + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
      + style('Title', 'Title', 'paragraph', '<w:b/><w:sz w:val="44"/>', '<w:spacing w:after="200"/>', '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading1', 'heading 1', 'paragraph', h1[1], h1[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading2', 'heading 2', 'paragraph', h2[1], h2[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('Heading3', 'heading 3', 'paragraph', h3[1], h3[0], '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>')
      + style('ListParagraph', 'List Paragraph', 'paragraph', null, '<w:spacing w:after="80"/><w:ind w:left="720"/>', '<w:basedOn w:val="Normal"/><w:qFormat/>')
      + style('Hyperlink', 'Hyperlink', 'character', '<w:color w:val="0B6E63"/><w:u w:val="single"/>', null, '<w:uiPriority w:val="99"/><w:unhideWhenUsed/>')
      + '</w:styles>';
    var numbering = XML + '<w:numbering ' + W + '><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>'
      + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>'
      + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
    var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    var docRels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdS" Type="' + REL + 'styles" Target="styles.xml"/>'
      + '<Relationship Id="rIdN" Type="' + REL + 'numbering" Target="numbering.xml"/>'
      + links.map(function (u, i) { return '<Relationship Id="rIdL' + (i + 1) + '" Type="' + REL + 'hyperlink" Target="' + xesc(u) + '" TargetMode="External"/>'; }).join('')
      + '</Relationships>';
    var CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
    var types = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="' + CT + 'document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="' + CT + 'styles+xml"/>'
      + '<Override PartName="/word/numbering.xml" ContentType="' + CT + 'numbering+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>';
    var rels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="' + REL + 'officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';
    var core = XML + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + '<dc:title>' + xesc(a.title) + '</dc:title><dc:description>' + xesc(a.meta_description || '') + '</dc:description><dc:creator>EdgeDesk Sports</dc:creator></cp:coreProperties>';
    return zipStore([
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: rels },
      { name: 'docProps/core.xml', data: core },
      { name: 'word/document.xml', data: doc },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/numbering.xml', data: numbering }
    ]);
  }
  var DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /* ======================================================================
     AI — the drafting request and the reply. The CALL belongs to the host.
     ====================================================================== */
  var AI_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['title', 'meta_description', 'standfirst', 'sections'],
    properties: {
      title: { type: 'string' },
      meta_description: { type: 'string' },
      standfirst: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['key', 'heading', 'body'],
          properties: { key: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' } }
        }
      }
    }
  };
  var AI_SYSTEM = [
    'You are a sports editor writing for EdgeDesk Sports, an independent sports research platform whose motto is "research, not picks".',
    'You write clear, engaging, accurate journalism for ordinary sports fans, not quantitative analysts.',
    'HARD RULES — a draft that breaks one is discarded automatically:',
    '1. Every number you write must appear in the RESEARCH PACKET (the display strings are pre-formatted; reuse them). Never estimate, round differently, or add a statistic, record, ranking, injury detail or price that is not in the packet.',
    '2. Name only teams and people that appear in the packet.',
    '3. No picks, locks, guarantees, "best bets", staking advice, or certainty ("will win"). Write "is projected to", "the model gives X a 64% chance".',
    '4. A projection is not a bet: say so plainly in the "how_to_read" section, and never imply a team is worth betting because it is projected to win.',
    '5. A market line whose status is "stale" or "reference" must be described with its source and capture time (or "reference, no capture time"), never as the current price.',
    '6. External reporting must be attributed to its outlet with a Markdown link to the URL in the packet, and kept separate from EdgeDesk\'s model inference. Do not add details beyond what the packet quotes.',
    '7. Explain jargon in plain words. No generic filler ("delve into", "game-changer", "at the end of the day", "must-watch", "buckle up"), and never the same sentence twice.',
    'FOOTBALL EVIDENCE — each game carries a "football" packet: claims (each with its source and verification), the explanation of EdgeDesk versus the line, and the game script. A projection is not evidence of its own explanation.',
    '8. Argue every featured game with football: cite at least two of its claims (five in a one-game article), including quarterback play for both teams, using the claim\'s own numbers in the same sentence as what they measure.',
    '9. Include the evidence AGAINST EdgeDesk\'s view (the "contradicting" claims) wherever the article mentions the line or the gap.',
    '10. If a game\'s status is UNEXPLAINED or input_suspect is true, say plainly that EdgeDesk cannot explain the gap and that it is not an edge. Never write a football reason for a gap the explanation does not give; never present a football stat as the model\'s reason (the model\'s reasons are its terms).',
    '11. State availability exactly as the claims do (probable is not confirmed; questionable is not out). Name the outlet of any claim whose verification is REPORTED, with its link. Put the year on anything historical.',
    '12. Never write "edge", "value", "mispriced", "sharp" or "the market is wrong" about a line. Use only the sources in the packet; do not add links.',
    'Formatting: section bodies are Markdown — paragraphs, "### " game headings inside the games section (keep each heading exactly as in the CURRENT DRAFT), "- " bullets, **bold**, [text](https://...) links. Do not write the disclaimer or the attribution footer; EdgeDesk adds both.'
  ].join('\n');

  function compactPacket(o) {
    /* what the writer may use: the research minus internal identifiers */
    return {
      league: o.league, season: o.season, week: o.week, kind: o.kind, as_of: o.research.as_of,
      context: Object.assign({}, o.research.context, { team_names: undefined }), conference: o.research.conference || null, conference_top: o.research.conference_top || null,
      focus: o.research.focus || null, news: o.research.news || [],
      games: (o.research.games || []).map(function (p, i, all) { return stripGame(p, all.length === 1); }), upsets: (o.research.upsets || []).map(function (p) { return stripGame(p, false); }), races: (o.research.races || []).map(function (p) { return stripGame(p, false); }),
      limitations: o.research.limitations || []
    };
  }
  function stripGame(p, single) {
    var c = Object.assign({}, p);
    delete c.flags; delete c.game_id;
    var F = fe();
    if (c.evidence && F) c.football = F.forWriter(single ? c.evidence : F.trim(c.evidence, { per: 4, pairs: 4 }));
    delete c.evidence;
    return c;
  }

  /* ctx: { publisher, format, section (key, optional), current (article), objections: [..] } */
  function buildRequest(o, ctx) {
    ctx = ctx || {};
    var format = ctx.format || (o.formats && o.formats[0]);
    var base = ctx.current || draft(o, { publisher: ctx.publisher, format: format, angle: ctx.angle });
    var ed = (ctx.publisher && ctx.publisher.editorial) || {};
    var pubTxt = ctx.publisher ? [
      'PUBLISHER: ' + ctx.publisher.name,
      ed.tone ? 'Tone: ' + ed.tone : null,
      ed.length ? 'Length: ' + ed.length.min + '–' + ed.length.max + ' words' : null,
      ed.audience ? 'Audience: ' + ed.audience : null,
      ed.notes ? 'Editorial notes: ' + ed.notes : null,
      ed.seo_requirements ? 'SEO requirements: ' + ed.seo_requirements : null
    ].filter(Boolean).join('\n') : 'PUBLISHER: none (EdgeDesk house style)';
    var task = ctx.section
      ? 'Rewrite ONLY the section with key "' + ctx.section + '". Return the full article object with every other section copied unchanged from the CURRENT DRAFT.'
      : 'Write the full article. Keep the section keys and order of the CURRENT DRAFT (you may improve every heading and every word). The deterministic CURRENT DRAFT is accurate but plain: make it read like good sports journalism without adding facts.';
    var user = [
      task,
      'FORMAT: ' + format + ' — ' + ((FORMATS[format] || {}).label || ''),
      'SEO: primary keyword "' + (o.seo && o.seo.primary_keyword) + '"; use it naturally in the headline and first paragraph, never stuffed. Meta description 120–155 characters.',
      pubTxt,
      ctx.objections && ctx.objections.length ? 'YOUR PREVIOUS DRAFT WAS REJECTED FOR: ' + ctx.objections.join(' | ') + '. Fix exactly these.' : null,
      'RESEARCH PACKET (the only facts you may use):\n' + JSON.stringify(compactPacket(o)),
      'CURRENT DRAFT:\n' + JSON.stringify({ title: base.title, meta_description: base.meta_description, standfirst: base.standfirst, sections: base.sections })
    ].filter(Boolean).join('\n\n');
    return {
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: user }],
      max_tokens: 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA } }
    };
  }

  /* message: the Messages API reply. → { ok, article?, reason } */
  function parseReply(message, base) {
    if (!message) return { ok: false, reason: 'no_reply' };
    if (message.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
    if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
    var text = (message.content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var j;
    try { j = JSON.parse(text); } catch (e) { return { ok: false, reason: 'invalid_json' }; }
    if (!j || typeof j.title !== 'string' || !Array.isArray(j.sections) || !j.sections.length) return { ok: false, reason: 'bad_shape' };
    var keys = (base && base.sections || []).map(function (s) { return s.key; });
    var secs = j.sections.filter(function (s) { return s && typeof s.key === 'string' && typeof s.body === 'string'; })
      .map(function (s) { return { key: s.key, heading: s.heading || SECTION_HEADINGS[s.key] || null, body: s.body.trim() }; });
    if (keys.length) secs = keys.map(function (k) { return secs.filter(function (s) { return s.key === k; })[0] || (base.sections.filter(function (s) { return s.key === k; })[0]); });
    var a = Object.assign({}, base, {
      title: j.title.trim(), meta_description: String(j.meta_description || '').trim(), standfirst: String(j.standfirst || '').trim(),
      sections: secs, slug: slugify(j.title)
    });
    a.word_count = wordCount(a.standfirst + ' ' + secs.map(function (s) { return s.body; }).join(' '));
    return { ok: true, article: a };
  }
  /* At most two model calls per draft (each counted against the budget
     before it is made); a retry rewrites only the sections that failed. */
  var AI_MAX_ATTEMPTS = 2;
  /* which sections a failed report points at: the one section holding every
     failing game's capsule; null when any failure is article-wide */
  function affectedSections(report, article, o) {
    var fails = (report.checks || []).filter(function (c) { return c.status === 'fail'; });
    if (!fails.length) return [];
    var keys = [];
    for (var i = 0; i < fails.length; i++) {
      var f = fails[i];
      if (!f.game) return null;
      var p = ((o && o.research && o.research.games) || []).filter(function (g) { return String(g.game_id) === String(f.game); })[0];
      var hit = (article.sections || []).filter(function (s) { return p ? s.body.indexOf('### ') >= 0 && s.body.indexOf(p.away) >= 0 && s.body.indexOf(p.home) >= 0 : false; })[0];
      if (!hit) return null;
      if (keys.indexOf(hit.key) < 0) keys.push(hit.key);
    }
    return keys;
  }
  /* the objections a failed validation sends back for one more try */
  function objections(report) {
    return (report.checks || []).filter(function (c) { return c.status === 'fail'; }).map(function (c) { return c.label + (c.detail ? ': ' + c.detail : ''); });
  }

  /* ======================================================================
     PUBLISHER — the Stadium Rant template (editorial only; contacts and
     benchmarks live in the owner-only database, never in this public file)
     ====================================================================== */
  var PUBLISHER_TEMPLATES = {
    'stadium-rant': {
      slug: 'stadium-rant', name: 'Stadium Rant', website: 'https://www.stadiumrant.com', utm_source: 'stadiumrant',
      editorial: {
        preferred_sports: ['cfb', 'nfl'],
        categories: ['weekly_preview', 'upset_watch', 'conference_race', 'injury_impact', 'trending_story', 'market_discrepancy'],
        prefer_broad: true,
        tone: 'Accessible, energetic sports-fan voice; explain every number in plain words; no betting jargon without a one-line explanation.',
        audience: 'General college football and NFL fans, beyond experienced bettors',
        length: { min: 900, max: 1500 },
        max_games: 6,
        sections: ['intro', 'why_it_matters', 'how_to_read', 'games', 'upsets', 'conference', 'disagreements', 'limits', 'conclusion'],
        seo_requirements: 'Broad, searchable headline built on a recognisable query ("Week N predictions", team names); primary keyword in the headline and first paragraph; meta description under 160 characters.',
        attribution: null,
        links_allowed: true,
        cadence: 'Weekly: CFB preview by Thursday, NFL preview by Friday',
        notes: 'Prefer weekly previews and major storylines over isolated low-interest matchups. Integrate predictions naturally; keep EdgeDesk’s analysis meaningful, not promotional.'
      }
    }
  };

  return {
    VERSION: VERSION, SITE: SITE, STATUSES: STATUSES, STATUS_LABELS: STATUS_LABELS, TRANSITIONS: TRANSITIONS,
    KINDS: KINDS, FORMATS: FORMATS, SECTION_HEADINGS: SECTION_HEADINGS, DISCLAIMER: DISCLAIMER,
    SCORE_WEIGHTS: SCORE_WEIGHTS, SCORE_LABELS: SCORE_LABELS, STALE_MINUTES: STALE_MINUTES, BANNED: BANNED, AI_TELLS: AI_TELLS,
    ARTIFACTS: ARTIFACTS, FEEDS: FEEDS, PUBLISHER_TEMPLATES: PUBLISHER_TEMPLATES,
    research: { fromArtifacts: fromArtifacts, chooseWeek: chooseWeek },
    news: { parseFeed: parseFeed, match: matchNews, classify: classifyNews },
    discover: discover, seoBrief: seoBrief, outline: outline, draft: draft,
    evidence: evidenceOf, validate: validate, similarity: similarity, teamsMentioned: teamsMentioned,
    campaignCode: campaignCode, tagLink: tagLink, attribution: attributionFor,
    toMarkdown: toMarkdown, toHtml: toHtml, mdToHtml: mdToHtml, seoSheet: seoSheet, toDocx: toDocx, DOCX_TYPE: DOCX_TYPE,
    ai: { SCHEMA: AI_SCHEMA, SYSTEM: AI_SYSTEM, MAX_ATTEMPTS: AI_MAX_ATTEMPTS, buildRequest: buildRequest, parseReply: parseReply, objections: objections, affectedSections: affectedSections },
    evidenceModule: function () { return fe(); }, SINGLE_GAME: SINGLE_GAME,
    util: { slugify: slugify, wordCount: wordCount, hash: hash, whenText: whenText, esc: esc, canTransition: function (from, to) { return (TRANSITIONS[from] || []).indexOf(to) >= 0; } }
  };
});
// ── END CONTENT ENGINE CORE ──────────────────────────────────────────────

import Anthropic from 'npm:@anthropic-ai/sdk';

// @ts-ignore the blocks above define them on globalThis
const AUTH = (globalThis as any).EDOutboundAuth;
// @ts-ignore
const CE = (globalThis as any).EDContentEngine;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const USER_AGENT = 'EdgeDeskContentEngine/1.0 (+https://edgedesksports.com)';

type Cfg = {
  url: string; anonKey: string; anthropicKey: string; resendKey: string; model: string; origins: string[];
  fetch: typeof fetch; timeoutMs?: number;
};

function config(): Cfg {
  // @ts-ignore Deno exists in the edge runtime
  const D = typeof Deno !== 'undefined' ? Deno : null;
  const env = (k: string) => (D ? D.env.get(k) : undefined) ?? '';
  const origins = (env('CONTENT_ENGINE_ALLOWED_ORIGINS') || 'https://edgedesksports.com,https://www.edgedesksports.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'), anthropicKey: env('ANTHROPIC_API_KEY'), resendKey: env('RESEND_API_KEY'),
    model: env('CONTENT_ENGINE_MODEL') || 'claude-opus-5-5', origins, fetch: globalThis.fetch.bind(globalThis),
  };
}

function cors(req: Request, c: Cfg): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const h: Record<string, string> = {
    'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS', 'access-control-max-age': '600', vary: 'origin',
  };
  if (c.origins.indexOf(origin) >= 0) h['access-control-allow-origin'] = origin;
  return h;
}
function json(req: Request, c: Cfg, body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(req, c) } });
}

class Refused extends Error {
  reason: string; detail: string; status: number;
  constructor(reason: string, detail: string, status = 502) { super(detail); this.reason = reason; this.detail = detail; this.status = status; }
}
type Ctx = { c: Cfg; authz: string; llmCalls: number };

async function db(x: Ctx, fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await AUTH.rpcAsCaller(x.c, x.authz, fn, args);
  if (r.status === 404) throw new Refused('not_installed', 'the content engine SQL is not applied: run supabase/content_engine.sql', 503);
  if (r.status === 401 || r.status === 403) throw new Refused('not_an_owner', 'this account is not an owner', 403);
  if (!r.ok) throw new Refused('database_error', fn + ' answered ' + r.status);
  return r.body;
}
async function spend(x: Ctx, provider: 'llm' | 'fetch'): Promise<boolean> {
  const r = await db(x, 'content_engine_spend', { p_provider: provider, p_n: 1 });
  if (r && r.ok === true) { if (provider === 'llm') x.llmCalls++; return true; }
  if (r && r.reason === 'budget_exhausted') return false;
  throw new Refused(r?.reason || 'spend_refused', 'the budget door refused');
}
async function log(x: Ctx, kind: string, detail: Record<string, unknown>, article?: string, opportunity?: string) {
  try { await db(x, 'content_engine_log', { p_kind: kind, p_detail: detail, p_article: article ?? null, p_opportunity: opportunity ?? null, p_run: null }); } catch (_) { /* a log that fails never fails the answer */ }
}

// ── one Claude call ─────────────────────────────────────────────────────────
async function claude(x: Ctx, req: any): Promise<any> {
  const client = new Anthropic({ apiKey: x.c.anthropicKey, timeout: 120_000, maxRetries: 1 });
  return client.beta.messages.create({
    model: x.c.model, max_tokens: req.max_tokens, system: req.system, messages: req.messages,
    output_config: req.output_config, betas: [FALLBACK_BETA], fallbacks: 'default',
  });
}

// the article as the validator reads it, from the database row
function asArticle(row: any) {
  return {
    format: row.format, angle: row.angle, title: row.title, slug: row.slug, meta_description: row.meta_description,
    standfirst: row.standfirst, primary_keyword: row.primary_keyword, secondary_keywords: row.secondary_keywords || [],
    sections: row.sections || [], word_count: row.word_count, generator: row.generator,
    research_as_of: row.research_as_of, research_hash: row.research_hash,
  };
}

async function draft(x: Ctx, articleId: string, section: string | null): Promise<any> {
  const row = await db(x, 'content_engine_article', { p_id: articleId });
  if (!row) throw new Refused('not_found', 'no such article', 404);
  if (row.status !== 'draft' && row.status !== 'in_review') {
    return { ok: false, reason: 'not_editable', detail: 'only drafts and articles in review are rewritten (this one is ' + row.status + ')' };
  }
  if (section && !(row.sections || []).some((s: any) => s.key === section)) return { ok: false, reason: 'bad_section' };
  if (!x.c.anthropicKey) return { ok: false, reason: 'ai_not_configured', detail: 'ANTHROPIC_API_KEY is not set: the deterministic draft stands' };
  const opp = row.opportunity;
  const publisher = row.publisher_profile || null;
  const base = asArticle(row);
  const siblings = (row.siblings || []).map((s: any) => ({ id: s.id, title: s.title, text: s.text || '' }));
  let objections: string[] = [];
  let lastReason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await spend(x, 'llm'))) {
      await log(x, 'ai_discarded', { reason: 'budget_exhausted', attempt }, articleId, opp.id);
      return { ok: false, reason: 'budget_exhausted', detail: 'today’s AI budget is used up; the existing draft stands' };
    }
    const req = CE.ai.buildRequest(opp, { publisher, format: row.format, section, current: base, objections });
    let reply: any;
    try { reply = await claude(x, req); } catch (e: any) {
      lastReason = 'api_error: ' + String(e && (e.status || e.message) || e).slice(0, 120);
      await log(x, 'generation_failed', { reason: lastReason, attempt }, articleId, opp.id);
      break;
    }
    const parsed = CE.ai.parseReply(reply, base);
    if (!parsed.ok) { lastReason = parsed.reason; await log(x, 'generation_failed', { reason: parsed.reason, attempt }, articleId, opp.id); if (parsed.reason === 'refusal') break; continue; }
    let next = parsed.article;
    if (section) {
      // only the asked-for section changes
      next = Object.assign({}, base, { sections: base.sections.map((s: any) => s.key === section ? (next.sections.find((n: any) => n.key === section) || s) : s) });
      next.word_count = CE.util.wordCount(next.standfirst + ' ' + next.sections.map((s: any) => s.body).join(' '));
    }
    const report = CE.validate(next, opp, { publisher, siblings, now: Date.now() });
    if (!report.ok) {
      objections = CE.ai.objections(report);
      lastReason = 'validation_failed';
      await log(x, 'ai_discarded', { attempt, objections }, articleId, opp.id);
      continue;
    }
    const generator = 'claude:' + String(reply.model || x.c.model).slice(0, 60);
    const saved = await db(x, 'content_engine_article_save', {
      p_id: articleId,
      p: { title: next.title, slug: next.slug, meta_description: next.meta_description, standfirst: next.standfirst, sections: next.sections,
           word_count: next.word_count, generator, checks: report },
      p_reason: section ? 'ai: rewrote section ' + section : 'ai: full draft', p_expected_hash: row.content_hash,
    });
    if (!saved || saved.ok !== true) return { ok: false, reason: saved?.reason || 'save_refused', detail: saved?.detail };
    await log(x, 'ai_accepted', { attempt, generator, section }, articleId, opp.id);
    return { ok: true, revision: saved.revision, status: saved.status, content_hash: saved.content_hash, checks: report, generator, llm_calls: x.llmCalls };
  }
  return { ok: false, reason: lastReason || 'validation_failed', objections, detail: 'the AI draft did not pass the checks; nothing was saved and the existing draft stands', llm_calls: x.llmCalls };
}

// ── Send to publisher: the owner's own send ─────────────────────────────────
const RESEND_URL = 'https://api.resend.com/emails';
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function b64(text: string | Uint8Array): string {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

// The database composed the envelope; it goes out only if it still looks like
// exactly one EdgeDesk email to exactly one person.
export function checkEnvelope(m: any): string | null {
  if (!m || typeof m !== 'object') return 'no message';
  const one = (v: unknown) => typeof v === 'string' && !/[\r\n]/.test(v);
  if (!one(m.from) || !/^[^<>@]{1,60} <[a-z0-9._%+-]+@edgedesksports\.com>$/.test(m.from)) return 'the sender is not an edgedesksports.com address';
  if (!one(m.to) || !EMAIL.test(m.to) || m.to.length > 254) return 'the recipient is not one email address';
  if (!one(m.reply_to) || !EMAIL.test(m.reply_to)) return 'the reply-to is not one email address';
  if (!one(m.subject) || !m.subject.trim() || m.subject.length > 150) return 'the subject is missing, too long or spans lines';
  return null;
}

// The email: the owner's note, then the article exactly as the export renders
// it (disclaimer and tagged EdgeDesk link included), and the three files.
export function composeEmail(row: any, note: string) {
  const a = asArticle(row);
  const ctx = { publisher: row.publisher_profile, campaign: row.campaign_code, opportunity: row.opportunity, landing: row.landing_url };
  const noteText = String(note || '').trim();
  const noteHtml = noteText ? noteText.split(/\n{2,}/).map((p) => '<p>' + CE.util.esc(p).replace(/\n/g, '<br>') + '</p>').join('') : '';
  const html = '<div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1d1d1f;max-width:720px">'
    + noteHtml + (noteHtml ? '<hr style="border:0;border-top:1px solid #ddd;margin:22px 0">' : '') + CE.toHtml(a, ctx) + '</div>';
  const text = (noteText ? noteText + '\n\n---\n\n' : '') + CE.toMarkdown(a, ctx);
  const attachments = [
    // first: the Word copy the editor can touch up (Word or Google Docs)
    { filename: a.slug + '.docx', content: b64(CE.toDocx(a, ctx)) },
    { filename: a.slug + '.md', content: b64(CE.toMarkdown(a, Object.assign({ frontMatter: true }, ctx))) },
    { filename: a.slug + '.html', content: b64(CE.toHtml(a, Object.assign({ standalone: true }, ctx))) },
    { filename: a.slug + '-seo.txt', content: b64(CE.seoSheet(a, row.opportunity) + '\n') },
  ];
  return { html, text, attachments };
}

async function send(x: Ctx, articleId: string, recipient: string, subject: string | null, note: string, test: boolean): Promise<any> {
  if (!x.c.resendKey) return { ok: false, reason: 'email_not_configured', detail: 'RESEND_API_KEY is not set on this project: nothing can be sent' };
  const row = await db(x, 'content_engine_article', { p_id: articleId });
  if (!row) throw new Refused('not_found', 'no such article', 404);
  const claim = await db(x, 'content_engine_send_claim', { p_id: articleId, p_recipient: recipient, p_subject: subject, p_content_hash: row.content_hash, p_test: test, p_note: note });
  if (!claim || claim.ok !== true) return { ok: false, reason: claim?.reason || 'refused', detail: claim?.detail };
  if (claim.already) return { ok: true, already: true, state: 'sent', detail: 'this article was already emailed to that address' };
  const m = claim.message;
  const record = async (id: string | null, error: string | null) => {
    try { const r = await db(x, 'content_engine_send_result', { p_send_id: claim.send_id, p_provider_id: id, p_error: error }); return r; } catch (_) { return null; }
  };
  const bad = checkEnvelope(m);
  if (bad) { await record(null, 'not sent: ' + bad); return { ok: false, reason: 'message_check_failed', detail: bad }; }
  // a retry sends the message first claimed, byte for byte: Resend refuses a key reused with a different body
  const body = composeEmail(row, claim.retry ? String(m.note || '') : note);
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, 20000);
  let status = 0, providerId: string | undefined, message: string | undefined;
  try {
    const r = await x.c.fetch(RESEND_URL, {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: 'Bearer ' + x.c.resendKey, 'content-type': 'application/json', 'idempotency-key': String(claim.idempotency_key) },
      body: JSON.stringify({ from: m.from, to: [m.to], reply_to: m.reply_to, subject: m.subject, html: body.html, text: body.text,
        attachments: body.attachments, tags: [{ name: 'edgedesk', value: 'content' }, { name: 'send', value: String(claim.send_id) }] }),
    });
    status = r.status;
    let b: any = null; try { b = await r.json(); } catch (_) { b = null; }
    providerId = b && typeof b.id === 'string' ? b.id : undefined;
    message = b && (b.message || b.name) ? String(b.message || b.name).slice(0, 300) : undefined;
  } catch (_) { status = 0; } finally { clearTimeout(t); }
  if (status >= 200 && status < 300 && providerId) {
    const res = await record(providerId, null);
    return { ok: true, state: 'sent', test: !!claim.test, to: m.to, recipient_name: claim.recipient_name, status: res && res.status,
      recorded: !!(res && res.ok), retried: !!claim.retry, ...(res && res.ok ? {} : { warning: 'sent, but not yet recorded: press Send again to record it (the same key cannot send twice)' }) };
  }
  if (status === 400 || status === 403 || status === 422) {
    await record(null, 'refused by Resend (' + status + '): ' + (message || 'invalid'));
    return { ok: false, reason: 'provider_rejected', detail: message || ('Resend answered ' + status) };
  }
  // unknown outcome: the claim stays open, and a retry reuses the same key
  return { ok: false, reason: 'outcome_unknown', detail: 'Resend did not answer clearly (' + (status || 'no response') + '). Press Send again: the same key cannot send twice.' };
}

async function trending(x: Ctx, leagues: string[]): Promise<any> {
  const feeds = CE.FEEDS.filter((f: any) => leagues.indexOf(f.league) >= 0);
  const items: any[] = [];
  const problems: any[] = [];
  for (const f of feeds) {
    if (!(await spend(x, 'fetch'))) { problems.push({ feed: f.id, reason: 'budget_exhausted' }); break; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await x.c.fetch(f.url, { headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml' }, signal: ctl.signal, redirect: 'follow' });
      if (!r.ok) { problems.push({ feed: f.id, reason: 'http_' + r.status }); continue; }
      const xml = (await r.text()).slice(0, 2_000_000);
      CE.news.parseFeed(xml, f, new Date().toISOString()).forEach((it: any) => items.push(it));
    } catch (e: any) {
      problems.push({ feed: f.id, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' });
    } finally { clearTimeout(t); }
  }
  if (problems.length) await log(x, 'fetch_failed', { problems });
  return { ok: true, items, problems, feeds: feeds.map((f: any) => ({ id: f.id, publisher: f.publisher, url: f.url })) };
}

export async function handle(req: Request, cfgOverride?: Partial<Cfg>): Promise<Response> {
  const c = { ...config(), ...(cfgOverride || {}) } as Cfg;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, c) });
  if (req.method !== 'POST') return json(req, c, { ok: false, reason: 'method_not_allowed' }, 405);
  const who = await AUTH.requireOutboundOwner(req, c);
  if (!who.ok) return json(req, c, { ok: false, reason: who.reason }, who.status);
  let body: any = {};
  try { body = await req.json(); } catch (_) { return json(req, c, { ok: false, reason: 'bad_request', detail: 'JSON body required' }, 400); }
  const x: Ctx = { c, authz: who.authz, llmCalls: 0 };
  try {
    if (body.action === 'status') {
      const ov = await db(x, 'content_engine_overview', {});
      return json(req, c, { ok: true, ai_configured: !!c.anthropicKey, email_configured: !!c.resendKey, sender: ov && ov.sender ? ov.sender.from : null,
        model: c.model, budget: ov && ov.budget, feeds: CE.FEEDS.length, version: CE.VERSION });
    }
    if (body.action === 'draft') {
      const id = String(body.article_id || '');
      if (!UUID.test(id)) return json(req, c, { ok: false, reason: 'bad_request', detail: 'article_id required' }, 400);
      const section = body.section ? String(body.section).slice(0, 40) : null;
      if (section && !/^[a-z_]{3,30}$/.test(section)) return json(req, c, { ok: false, reason: 'bad_request', detail: 'bad section key' }, 400);
      return json(req, c, await draft(x, id, section));
    }
    if (body.action === 'send') {
      const id = String(body.article_id || '');
      const to = String(body.recipient || '').trim().toLowerCase();
      if (!UUID.test(id) || !EMAIL.test(to)) return json(req, c, { ok: false, reason: 'bad_request', detail: 'article_id and one recipient address required' }, 400);
      const subject = body.subject == null ? null : String(body.subject).slice(0, 200);
      const note = String(body.note == null ? '' : body.note).slice(0, 4000);
      return json(req, c, await send(x, id, to, subject, note, body.test === true));
    }
    if (body.action === 'trending') {
      const leagues = (Array.isArray(body.leagues) ? body.leagues : ['cfb', 'nfl']).filter((l: string) => l === 'cfb' || l === 'nfl');
      return json(req, c, await trending(x, leagues.length ? leagues : ['cfb', 'nfl']));
    }
    return json(req, c, { ok: false, reason: 'bad_request', detail: 'action: status, draft, send or trending' }, 400);
  } catch (e: any) {
    if (e instanceof Refused) return json(req, c, { ok: false, reason: e.reason, detail: e.detail }, e.status);
    return json(req, c, { ok: false, reason: 'unhandled', detail: 'the content engine stopped unexpectedly' }, 500);
  }
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req));
}
