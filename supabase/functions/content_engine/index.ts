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

// ── BEGIN INTEGRITY LAYER ──────────────────────────────────────────────
// Canonical sources: lib/edgedesk_calc.js, lib/edgedesk_schedule.js, lib/edgedesk_availability.js, lib/edgedesk_integrity.js, lib/edgedesk_broadcast.js, lib/edgedesk_matchup.js,
// copied VERBATIM by tools/content/inline.js. Edit the canonical files, then run it.
// ── lib/edgedesk_calc.js
/* ===========================================================================
   EdgeDesk CALC — the one calculation layer for every number a reader sees
   beside another number. docs/system-integrity/DATA_CONTRACT.md §4

   WHY IT EXISTS (docs/system-integrity/AUDIT.md §1)
     The same game used to show three different arithmetics:
       - the board printed a near pick'em at the engine's one-point DISPLAY
         FLOOR ("Ole Miss -1.0") beside a gap measured from the RAW margin
         (-0.18), so "-1.0 vs -9.5 = 9.3" could not be reproduced by a reader;
       - the terminal rounded the fair line, the consensus and the full-
         precision gap independently, so 11 of 70 priced rows showed a gap
         that differed from their displayed inputs by 0.1;
       - projected scores were rounded on their own, so 65 of 114 score lines
         did not add up to the fair margin they sat beside.

   THE POLICY (POLICY below, id display_rounding_v1)
     1. Every value is rounded to its display precision ONCE, half away from
        zero, by round() here.
     2. Every displayed difference (a model-market gap, a total gap, a
        probability edge) is the difference OF THE DISPLAYED INPUTS, computed
        in integer tenths so no float residue can leak into the last digit.
        A reader can always reproduce it from the two numbers beside it.
     3. The full-precision value is kept beside the display (gap_exact) for
        ranking-free analytics. It never replaces the model's number and it is
        never printed as the gap.
     4. The model's number is never moved toward or away from the market to
        make a comparison look cleaner. A near pick'em is shown at its real
        value ("Ole Miss -0.2") with a NEAR PICK'EM tag — the engine's one-point
        floor (football/cfb_p4/engine.js fairLine.normalize) is a presentation
        convention, kept in the engine's output, and never used as a
        comparison input.
     5. Projected scores always sum exactly to the displayed total and differ
        by exactly the displayed margin. When both cannot be exact at one
        decimal (the total's and the margin's last digits have different
        parity), the scores are shown to two decimals rather than rounded
        into a contradiction.

   CONVENTIONS
     home margin   home points minus away points (+ = home favoured). The CFB
                   engine's fair_spread and the board's market spread_line both
                   use it.
     book line     what a sportsbook prints for a side: -margin for that side
                   (negative = favoured).

   WHAT THIS FILE NEVER DOES
     - compute a projection, a probability distribution or a calibration;
     - fill a missing value: a null input gives a null output with a reason;
     - decide a research status or a bet (lib/edgedesk_canon.js and
       lib/edgedesk_decision.js do; they read the gap from here).

   Browser: window.EDCalc. Node: require('./edgedesk_calc.js'). ES5, no
   dependencies, the same code in both.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCalc = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var C = { VERSION: 'edgedesk_calc/1' };

  C.POLICY = {
    id: 'display_rounding_v1',
    mode: 'half_away_from_zero',
    spread_dp: 1, total_dp: 1, score_dp: 1, gap_dp: 1, prob_dp: 1, ev_dp: 1, pp_dp: 1, odds_dp: 0,
    rule: 'Each input is rounded to its display precision once; every displayed difference is the difference of the displayed inputs; the full-precision value is kept beside it and never replaces the model’s number.'
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  C.num = num;

  /* half away from zero at dp decimals. The 1e-9 guard absorbs the binary
     residue of a decimal that is meant to sit exactly on a half (9.45 is
     9.4499999… in binary and must display 9.5). */
  function round(x, dp) {
    x = num(x);
    if (x === null) return null;
    var m = Math.pow(10, dp == null ? 1 : dp);
    var a = Math.floor(Math.abs(x) * m + 0.5 + 1e-9);
    var v = (x < 0 ? -a : a) / m;
    return v === 0 ? 0 : v;
  }
  C.round = round;
  /* integer tenths: the unit every displayed difference is computed in */
  function tenths(x) { return Math.round(round(x, 1) * 10); }
  function fromTenths(t) { var v = t / 10; return v === 0 ? 0 : v; }

  function fixed(x, dp) { return isNum(x) ? x.toFixed(dp == null ? 1 : dp) : '—'; }
  function pts(x) { var a = Math.abs(x); return fixed(a, 1) + (a === 1 ? ' pt' : ' pts'); }

  /* ================================================================ SPREADS
     One side of a spread comparison: the full-precision home margin, its
     display value, the side it names and the line text a reader sees. */
  C.NEAR_PICKEM = 1;
  C.spread = function (homeMargin, names, opts) {
    names = names || {};
    opts = opts || {};
    var home = names.home || 'Home', away = names.away || 'Away';
    var m = num(homeMargin);
    if (m === null) return { available: false, exact: null, display: null, favorite: null, favorite_team: null, text: '—', reason: opts.missing || 'no number on file' };
    var d = round(m, C.POLICY.spread_dp);
    var fav = d > 0 ? 'home' : (d < 0 ? 'away' : null);
    var team = fav === 'home' ? home : (fav === 'away' ? away : null);
    /* an exact display zero: the side the raw number still leans to, said
       in words, never as a manufactured line */
    var lean = m > 0 ? home : (m < 0 ? away : null);
    var text = team ? team + ' -' + fixed(Math.abs(d), 1) : 'Pick’em';
    return {
      available: true,
      exact: m,
      display: d,
      book_line_home: d === 0 ? 0 : -d,
      favorite: fav,
      favorite_team: team,
      lean_team: d === 0 ? lean : team,
      near_pickem: Math.abs(m) < C.NEAR_PICKEM,
      text: text,
      note: d === 0 && lean ? 'rounds to a pick’em; the raw number leans ' + lean + ' by ' + fixed(Math.abs(m), 2) : null
    };
  };
  /* a sportsbook line for a named team ("Ole Miss -9.5") as a home margin */
  C.marginFromLine = function (team, line, names) {
    var l = num(line);
    if (l === null || !names) return null;
    var t = String(team || '').toLowerCase(), h = String(names.home || '').toLowerCase(), a = String(names.away || '').toLowerCase();
    if (t && t === h) return l === 0 ? 0 : -l;
    if (t && t === a) return l;
    return null;
  };

  /* THE SPREAD COMPARISON. model and market as home margins (full precision
     or already displayed; the result is the same either way, because the
     comparison is made on the displayed values). */
  C.spreadComparison = function (x) {
    x = x || {};
    var names = { home: x.home || 'Home', away: x.away || 'Away' };
    var model = C.spread(x.model_home_margin, names, { missing: 'no EdgeDesk projection' });
    var market = C.spread(x.market_home_margin, names, { missing: 'no market line' });
    var out = {
      calc_version: C.VERSION, policy: C.POLICY.id, market_type: 'spread',
      model: model, market: market,
      model_snapshot_id: x.model_snapshot_id || null, market_snapshot_id: x.market_snapshot_id || null,
      available: model.available && market.available
    };
    if (!out.available) {
      out.reason = !model.available ? model.reason : market.reason;
      out.gap = null; out.gap_exact = null; out.signed = null; out.toward = null; out.toward_team = null;
      out.text = '—';
      return out;
    }
    var st = tenths(model.display) - tenths(market.display);
    var signed = fromTenths(st);
    out.signed = signed;                         /* + = EdgeDesk likes HOME more than the market */
    out.gap = Math.abs(signed);
    out.gap_exact = Math.abs(model.exact - market.exact);
    out.toward = st > 0 ? 'home' : (st < 0 ? 'away' : null);
    out.toward_team = out.toward === 'home' ? names.home : (out.toward === 'away' ? names.away : null);
    out.favorite_differs = !!(model.favorite && market.favorite && model.favorite !== market.favorite);
    out.text = st === 0 ? '0.0 pts — EdgeDesk matches the market' : pts(out.gap) + ' toward ' + out.toward_team;
    out.reconcile = {
      formula: '|' + fixed(model.display, 1) + ' − ' + fixed(market.display, 1) + '| = ' + fixed(out.gap, 1),
      inputs: [model.text, market.text],
      convention: 'home margin (home points minus away points)'
    };
    return out;
  };

  /* Comparison of two DISPLAYED book lines, each named for a team — the case
     where the figures on screen are the authoritative comparison inputs
     ("Ole Miss -1.0" vs "Ole Miss -9.5" is 8.5 points). */
  C.compareLines = function (modelLine, marketLine, names) {
    var mm = C.marginFromLine(modelLine && modelLine.team, modelLine && modelLine.line, names);
    var km = C.marginFromLine(marketLine && marketLine.team, marketLine && marketLine.line, names);
    return C.spreadComparison({ home: names && names.home, away: names && names.away, model_home_margin: mm, market_home_margin: km });
  };

  /* ================================================================= TOTALS */
  C.totalComparison = function (x) {
    x = x || {};
    var m = num(x.model_total), k = num(x.market_total);
    var out = { calc_version: C.VERSION, policy: C.POLICY.id, market_type: 'total',
      model_exact: m, market_exact: k, model: round(m, C.POLICY.total_dp), market: round(k, C.POLICY.total_dp),
      model_snapshot_id: x.model_snapshot_id || null, market_snapshot_id: x.market_snapshot_id || null };
    out.available = m !== null && k !== null;
    if (!out.available) { out.gap = null; out.direction = null; out.text = '—'; out.reason = m === null ? 'no EdgeDesk total' : 'no market total'; return out; }
    var st = tenths(m) - tenths(k);
    out.signed = fromTenths(st);
    out.gap = Math.abs(out.signed);
    out.gap_exact = Math.abs(m - k);
    out.direction = st > 0 ? 'over' : (st < 0 ? 'under' : null);
    out.text = st === 0 ? 'EdgeDesk matches the market total' : 'EdgeDesk is ' + pts(out.gap) + ' ' + (st > 0 ? 'above' : 'below') + ' the market total';
    out.reconcile = { formula: '|' + fixed(out.model, 1) + ' − ' + fixed(out.market, 1) + '| = ' + fixed(out.gap, 1) };
    return out;
  };

  /* ======================================================= PROJECTED SCORES
     The score line, the fair margin and the fair total always agree. */
  C.projectedScores = function (x) {
    x = x || {};
    var names = { home: x.home || 'Home', away: x.away || 'Away' };
    var m = num(x.home_margin), t = num(x.total);
    if (m === null || t === null) return { available: false, text: '—', reason: m === null ? 'no projected margin' : 'no projected total' };
    var T = tenths(t), M = tenths(m);
    var aM = Math.abs(M);
    var dp = ((T + aM) % 2 === 0) ? 1 : 2;
    /* in twentieths when needed: (T ± |M|) / 2 tenths is exact in hundredths */
    var favH = (T + aM) / 2, dogH = (T - aM) / 2;     /* tenths, possibly .5 */
    var fav = favH / 10, dog = dogH / 10;
    var favSide = M > 0 ? 'home' : (M < 0 ? 'away' : null);
    var homeS = favSide === 'away' ? dog : fav, awayS = favSide === 'away' ? fav : dog;
    function s(v) { return v.toFixed(dp); }
    var first = favSide === 'home' ? 'home' : 'away';
    var second = first === 'home' ? 'away' : 'home';
    var sc = { home: homeS, away: awayS };
    return {
      available: true, calc_version: C.VERSION, policy: C.POLICY.id,
      home: homeS, away: awayS, decimals: dp,
      margin_display: fromTenths(M), total_display: fromTenths(T),
      text: names[first] + ' ' + s(sc[first]) + ' — ' + names[second] + ' ' + s(sc[second]),
      reconcile: { sum: s(fromTenths(T)), difference: s(aM / 10) },
      note: dp === 2 ? 'shown to two decimals so the scores add to the total and differ by the margin exactly' : null
    };
  };
  /* does a score line agree with the margin and total printed beside it?
     tolerance: the display unit of the scores themselves */
  C.scoresReconcile = function (homeScore, awayScore, homeMargin, total, decimals) {
    var h = num(homeScore), a = num(awayScore), m = num(homeMargin), t = num(total);
    if (h === null || a === null || m === null || t === null) return { ok: null, reason: 'missing input' };
    var unit = Math.pow(10, -(decimals == null ? 1 : decimals)) / 2 + 1e-9;
    var dM = Math.abs((h - a) - round(m, 1)), dT = Math.abs((h + a) - round(t, 1));
    var sideOk = round(m, 1) === 0 || ((h - a) > 0) === (m > 0);
    var ok = dM <= unit && dT <= unit && sideOk;
    return { ok: ok, margin_difference: round(dM, 3), total_difference: round(dT, 3), side_agrees: sideOk,
      reason: ok ? null : (!sideOk ? 'the score line names a different winner from the fair line'
        : 'the score line differs from the ' + (dM > unit ? 'margin by ' + round(dM, 2) : 'total by ' + round(dT, 2)) + ' points') };
  };

  /* ========================================================= PROBABILITIES
     The same formulas EDQuoteEV and research_core use; tools/integrity
     pins the parity, so a second copy cannot drift silently. */
  C.decimalFromAmerican = function (a) { a = num(a); if (a === null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };
  C.impliedFromAmerican = function (a) { var d = C.decimalFromAmerican(a); return d ? 1 / d : null; };
  C.breakEven = function (decimal) { decimal = num(decimal); return decimal !== null && decimal > 1 ? 1 / decimal : null; };
  /* multiplicative no-vig for a two-way market; null when the pair cannot be a market */
  C.noVigTwoWay = function (aAm, bAm) {
    var pa = C.impliedFromAmerican(aAm), pb = C.impliedFromAmerican(bAm);
    if (pa === null || pb === null) return null;
    var s = pa + pb;
    if (!(s > 0)) return null;
    return { a: pa / s, b: pb / s, overround: s - 1 };
  };
  /* EV per unit staked: P(win)(d−1) − P(loss); a push returns the stake */
  C.expectedValue = function (win, push, loss, decimal) {
    win = num(win); push = num(push) === null ? 0 : num(push); decimal = num(decimal);
    if (win === null || decimal === null || decimal <= 1) return null;
    loss = num(loss) === null ? 1 - win - push : num(loss);
    if (Math.abs(win + push + loss - 1) > 1e-6 || win < 0 || loss < 0 || push < 0) return null;
    return win * (decimal - 1) - loss;
  };

  /* A SELECTION is one exact bet: market, side, line, price, book, capture.
     Raw and calibrated EV are only comparable for the same selection. */
  function isoOrEmpty(t) { var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? new Date(v).toISOString() : ''; }
  C.selectionKey = function (s) {
    if (!s) return null;
    var line = num(s.line);
    return [String(s.market_type || 'spread').toLowerCase(), String(s.side || s.team || '').toLowerCase(),
      line === null ? '' : String(round(line, 1)), num(s.american) === null ? '' : String(Math.round(num(s.american))),
      String(s.book || '').toLowerCase(), isoOrEmpty(s.captured_at)].join('|');
  };
  C.evPair = function (raw, cal) {
    var kr = raw ? C.selectionKey(raw.selection) : null, kc = cal ? C.selectionKey(cal.selection) : null;
    var out = { calc_version: C.VERSION, raw_key: kr, calibrated_key: kc };
    if (!raw || num(raw.ev) === null) { out.comparable = false; out.reason = 'no raw EV'; return out; }
    if (!cal || num(cal.ev) === null) { out.comparable = false; out.reason = 'no calibrated EV'; out.raw_ev = raw.ev; return out; }
    if (kr !== kc) {
      out.comparable = false;
      out.reason = 'raw EV and calibrated EV were computed for different selections (' + (kr || '?') + ' vs ' + (kc || '?') + '); they cannot be shown as one bet';
      return out;
    }
    out.comparable = true;
    out.raw_ev = raw.ev; out.calibrated_ev = cal.ev;
    out.shrink = raw.ev - cal.ev;
    return out;
  };

  /* ============================================================ FORMATTING
     The canonical formatters every surface and every export uses. */
  C.fmt = {
    spread: function (team, line) { var l = round(line, 1); if (l === null) return '—'; if (l === 0) return 'Pick’em'; return team + ' ' + (l > 0 ? '+' : '-') + fixed(Math.abs(l), 1); },
    total: function (t) { var v = round(t, 1); return v === null ? '—' : fixed(v, 1); },
    gap: function (g) { var v = round(g, 1); return v === null ? '—' : pts(v); },
    prob: function (p, dp) { p = num(p); return p === null ? '—' : fixed(round(100 * p, dp == null ? 1 : dp), dp == null ? 1 : dp) + '%'; },
    ev: function (e, dp) { e = num(e); if (e === null) return '—'; var v = round(100 * e, dp == null ? 1 : dp); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fixed(Math.abs(v), dp == null ? 1 : dp) + '%'; },
    pp: function (x) { x = num(x); if (x === null) return '—'; var v = round(x, 1); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fixed(Math.abs(v), 1) + ' pp'; },
    american: function (a) { a = num(a); return a === null ? '—' : (a > 0 ? '+' : '') + String(Math.round(a)); },
    rank: function (n) { n = num(n); return n === null ? '—' : '#' + Math.round(n); },
    score100: function (s, what) { s = num(s); return s === null ? 'unavailable' : Math.round(s) + '/100' + (what ? ' (' + what + ')' : ''); },
    age: function (minutes) {
      minutes = num(minutes);
      if (minutes === null) return 'age unknown';
      if (minutes < 1) return 'under a minute old';
      if (minutes < 90) return Math.round(minutes) + ' min old';
      if (minutes < 48 * 60) return round(minutes / 60, 1) + ' h old';
      return Math.round(minutes / 1440) + ' days old';
    }
  };

  /* a fingerprint of the numbers a document may print, so an export can be
     checked against the snapshot it was approved on (FNV-1a over canonical JSON) */
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  }
  C.canonicalJson = canonicalJson;
  C.fingerprint = function (v) {
    var s = canonicalJson(v), h1 = 0x811c9dc5, h2 = 0x01000193, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 ^= c; h2 = Math.imul(h2 ^ (h1 >>> 7), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  };

  return C;
});
// ── lib/edgedesk_schedule.js
/* ===========================================================================
   EdgeDesk SCHEDULE — kickoff truth, game status, time zones and week scope.
   docs/system-integrity/DATA_CONTRACT.md §2 · AUDIT.md §2

   WHY IT EXISTS
     The cfbfastR schedule marks a game whose time is not announced with
     start_time_tbd = TRUE and a placeholder instant of midnight Eastern
     (04:00Z in daylight time, 05:00Z in standard time). Every reader of the
     feed dropped that column, so 43 week-7 games reached the board as
     confirmed "FRI 11:00p" kickoffs, and the board's rolling 10-day window put
     them beside the current week's games. A clock rule alone cannot catch it:
     the same feed has a real 04:00Z kickoff (a Hawai'i night game).

   THE RULES
     1. The source's own flag decides. A game the source marks TBA is TBA,
        whatever its timestamp says. A source that supplies no flag and a
        timestamp at a known placeholder instant (midnight Eastern) is
        SUSPECT_PLACEHOLDER — never CONFIRMED.
     2. Every instant is held in UTC. A timestamp without a time zone is
        refused (it is ambiguous), not assumed to be UTC.
     3. A kickoff is displayed in the reader's selected time zone, with the
        zone named. An unconfirmed time is displayed as "time TBA" on the
        game's own date (the placeholder's Eastern date), never as a clock
        time.
     4. A kickoff is never invented: a missing time stays missing.
     5. The week is the source's own week (season, season type, week). The
        CURRENT week is the earliest week that still has an unstarted game
        inside its own schedule cluster, so one rescheduled game cannot pin the
        board to an old week. Everything after it is FUTURE_WEEK research.
     6. Only a CONFIRMED, SCHEDULED, CURRENT_WEEK, not-yet-started game is
        publishable (publishable()). Everything else is research only.

   Browser: window.EDSchedule. Node: require('./edgedesk_schedule.js'). ES5
   apart from Intl (present in every supported browser and in Node).
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDSchedule = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var S = { VERSION: 'edgedesk_schedule/1' };

  var H = 3600e3, D = 86400e3;
  S.CONFIG = {
    /* the feed's placeholder convention: midnight in this zone */
    placeholder_zone: 'America/New_York',
    /* a game more than this far from its week's median kickoff is outside
       the week's cluster (rescheduled) and does not decide the current week */
    cluster_days: 4,
    /* a started game with no result is presumed LIVE for this long */
    live_hours: 8,
    default_zone: 'America/Chicago'
  };

  S.ZONES = [
    { id: 'America/New_York', label: 'Eastern' },
    { id: 'America/Chicago', label: 'Central' },
    { id: 'America/Denver', label: 'Mountain' },
    { id: 'America/Phoenix', label: 'Arizona' },
    { id: 'America/Los_Angeles', label: 'Pacific' },
    { id: 'America/Anchorage', label: 'Alaska' },
    { id: 'Pacific/Honolulu', label: 'Hawaii' },
    { id: 'UTC', label: 'UTC' }
  ];

  S.KICKOFF_STATE = {
    CONFIRMED: { key: 'CONFIRMED', label: 'Kickoff confirmed', verified: true,
      means: 'The schedule source gives a time and does not mark it as to be announced.' },
    TBA: { key: 'TBA', label: 'Time TBA', verified: false,
      means: 'The source knows the date but marks the time as to be announced; its timestamp is a placeholder.' },
    SUSPECT_PLACEHOLDER: { key: 'SUSPECT_PLACEHOLDER', label: 'Time unverified', verified: false,
      means: 'The source supplied no TBA flag and the timestamp sits on the feed’s placeholder instant (midnight Eastern). Treated as unannounced until a source confirms it.' },
    MISSING: { key: 'MISSING', label: 'No kickoff on file', verified: false,
      means: 'No usable kickoff timestamp (none, unparseable, or without a time zone).' }
  };
  S.STATUS = {
    SCHEDULED: { key: 'SCHEDULED', label: 'Scheduled', pregame: true },
    TENTATIVE: { key: 'TENTATIVE', label: 'Tentative', pregame: true },
    POSTPONED: { key: 'POSTPONED', label: 'Postponed', pregame: false },
    CANCELED: { key: 'CANCELED', label: 'Canceled', pregame: false },
    LIVE: { key: 'LIVE', label: 'Live', pregame: false },
    COMPLETED: { key: 'COMPLETED', label: 'Final', pregame: false }
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function truthy(v) { return v === true || /^(true|t|1|yes)$/i.test(String(v == null ? '' : v).trim()); }
  function falsy(v) { return v === false || /^(false|f|0|no)$/i.test(String(v == null ? '' : v).trim()); }

  /* ============================================================ UTC */
  /* An ISO instant WITH a zone (Z or ±hh:mm) or epoch ms → epoch ms. A date
     alone is a date, not an instant (returned as {date}). A naive local
     timestamp is refused. */
  S.parse = function (t) {
    if (typeof t === 'number') return isFinite(t) ? { ms: t } : { error: 'not a finite epoch' };
    if (!present(t)) return { error: 'no timestamp' };
    var s = String(t).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return { error: 'timestamp without a time zone (' + s + ')' };
    var v = Date.parse(s);
    return isFinite(v) ? { ms: v } : { error: 'unparseable timestamp (' + s + ')' };
  };
  S.toUtc = function (t) { var p = S.parse(t); return p.ms != null ? new Date(p.ms).toISOString() : null; };

  /* the wall clock of an instant in a zone */
  var fmtCache = {};
  function parts(ms, zone) {
    var key = zone || 'UTC';
    if (!fmtCache[key]) fmtCache[key] = new Intl.DateTimeFormat('en-US', { timeZone: key, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    var o = {};
    fmtCache[key].formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  S.wallClock = parts;
  function zoneAbbr(ms, zone) {
    try {
      var p = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
      for (var i = 0; i < p.length; i++) if (p[i].type === 'timeZoneName') return p[i].value;
    } catch (_) { /* unknown zone */ }
    return zone;
  }
  S.validZone = function (zone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; } catch (_) { return false; }
  };
  /* the instant is midnight in the placeholder zone */
  S.isPlaceholderInstant = function (ms) {
    var p = parts(ms, S.CONFIG.placeholder_zone);
    return p.h === 0 && p.mi === 0 && p.s === 0;
  };

  /* ===================================================== KICKOFF STATE
     g: { kickoff | start_date | commence_time, start_time_tbd | kickoff_tbd |
          time_tbd, kickoff_state } — any of the source spellings */
  function tbdFlag(g) {
    var k = ['start_time_tbd', 'kickoff_tbd', 'time_tbd', 'startTimeTBD', 'tbd'];
    for (var i = 0; i < k.length; i++) if (g && Object.prototype.hasOwnProperty.call(g, k[i]) && present(g[k[i]])) {
      if (truthy(g[k[i]])) return true;
      if (falsy(g[k[i]])) return false;
    }
    return null;
  }
  S.kickoffOf = function (g) {
    g = g || {};
    var raw = present(g.kickoff) ? g.kickoff : (present(g.start_date) ? g.start_date : (present(g.commence_time) ? g.commence_time : g.kickoff_utc));
    var p = S.parse(raw);
    var flag = tbdFlag(g);
    var st, basis;
    /* an upstream verdict already made by this module is kept — but a carried
       verdict can only ever keep a time UNverified: it never confirms a time
       the source now marks TBA, and a carried CONFIRMED on the placeholder
       instant stands only if it was confirmed by the source's own flag */
    if (g.kickoff_state && S.KICKOFF_STATE[g.kickoff_state] && p.ms != null) {
      st = g.kickoff_state; basis = g.kickoff_basis || 'carried from the source artifact';
      if (st === 'CONFIRMED' && flag === true) { st = 'TBA'; basis = 'the source marks the time as to be announced (start_time_tbd); a carried CONFIRMED cannot override it'; }
      else if (st === 'CONFIRMED' && flag !== false && S.isPlaceholderInstant(p.ms) && !/start_time_tbd = false/.test(String(g.kickoff_basis || ''))) {
        st = 'SUSPECT_PLACEHOLDER'; basis = 'a carried CONFIRMED on the feed’s placeholder instant (midnight Eastern) with no source flag behind it';
      }
    } else if (p.error && !p.date) { st = 'MISSING'; basis = p.error; }
    else if (p.date) { st = 'TBA'; basis = 'the source gives a date only'; }
    else if (flag === true) { st = 'TBA'; basis = 'the source marks the time as to be announced (start_time_tbd)'; }
    else if (flag === false) { st = 'CONFIRMED'; basis = 'the source gives a time and marks it as set (start_time_tbd = false)'; }
    else if (S.isPlaceholderInstant(p.ms)) { st = 'SUSPECT_PLACEHOLDER'; basis = 'no TBA flag supplied, and the time is the feed’s placeholder instant (midnight Eastern)'; }
    else { st = 'CONFIRMED'; basis = 'the source gives a time (no TBA flag supplied; not a placeholder instant)'; }
    var ms = p.ms != null ? p.ms : null;
    /* the game's own calendar date: for a placeholder, the Eastern date the
       placeholder encodes; for a confirmed time, the Eastern date of kickoff */
    var date = null;
    if (p.date) date = p.date;
    else if (ms != null) { var e = parts(ms, S.CONFIG.placeholder_zone); date = e.y + '-' + ('0' + e.mo).slice(-2) + '-' + ('0' + e.d).slice(-2); }
    var def = S.KICKOFF_STATE[st];
    return { state: st, verified: def.verified, label: def.label, basis: basis,
      utc: ms != null ? new Date(ms).toISOString() : null, ms: ms, game_date: date, source_flag: flag };
  };

  /* ======================================================== GAME STATUS */
  var STATUS_WORDS = [
    [/cancel/i, 'CANCELED'], [/no[_ ]?contest|forfeit/i, 'CANCELED'],
    [/postpon|suspend|delay/i, 'POSTPONED'],
    [/final|complete|finished|status_final|^post$/i, 'COMPLETED'],
    [/in[_ ]?progress|live|halftime|end[_ ]of[_ ]period|^in$/i, 'LIVE'],
    [/scheduled|pre|status_scheduled|^tbd$/i, 'SCHEDULED']
  ];
  S.statusOf = function (g, now) {
    g = g || {};
    now = now == null ? Date.now() : now;
    var k = S.kickoffOf(g);
    var raw = g.status || g.game_status || g.state || null;
    var from = null, i;
    if (present(raw)) for (i = 0; i < STATUS_WORDS.length; i++) if (STATUS_WORDS[i][0].test(String(raw))) { from = STATUS_WORDS[i][1]; break; }
    if (truthy(g.completed)) from = 'COMPLETED';
    var st, inferred = false;
    if (from === 'CANCELED' || from === 'POSTPONED' || from === 'COMPLETED' || from === 'LIVE') st = from;
    else if (k.ms != null && k.verified && now >= k.ms) { st = 'LIVE'; inferred = true; }
    else if (!k.verified) st = 'TENTATIVE';
    else st = 'SCHEDULED';
    var def = S.STATUS[st];
    return { status: st, label: def.label, pregame: def.pregame && !(k.ms != null && k.verified && now >= k.ms),
      inferred: inferred, result_overdue: inferred && now - k.ms > S.CONFIG.live_hours * H, source_status: raw || null, kickoff: k };
  };

  /* ============================================================ DISPLAY */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateText(y, mo, d) {
    var wd = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd] + ', ' + MON[mo - 1] + ' ' + d;
  }
  /* "Sat, Oct 10 · 2:30 PM CDT" — or "Sat, Oct 17 · time TBA" */
  S.display = function (g, zone, opts) {
    opts = opts || {};
    zone = zone && S.validZone(zone) ? zone : S.CONFIG.default_zone;
    var k = g && g.state && g.ms !== undefined ? g : S.kickoffOf(g);
    if (k.state === 'MISSING') return { text: 'Kickoff not on file', short: 'TBA', zone: zone, verified: false, state: k.state };
    if (!k.verified) {
      var dt = k.game_date ? k.game_date.split('-').map(Number) : null;
      var t = (dt ? dateText(dt[0], dt[1], dt[2]) + ' · ' : '') + 'time TBA';
      return { text: t, short: dt ? dateText(dt[0], dt[1], dt[2]).slice(0, 3).toUpperCase() + ' TBA' : 'TBA', zone: zone, verified: false, state: k.state };
    }
    var p = parts(k.ms, zone);
    var h12 = (p.h % 12) || 12, ap = p.h < 12 ? 'AM' : 'PM';
    var clock = h12 + ':' + ('0' + p.mi).slice(-2) + ' ' + ap;
    var abbr = zoneAbbr(k.ms, zone);
    return { text: dateText(p.y, p.mo, p.d) + ' · ' + clock + ' ' + abbr, clock: clock, zone_abbr: abbr,
      short: p.wd.toUpperCase() + ' ' + h12 + ':' + ('0' + p.mi).slice(-2) + (p.h < 12 ? 'a' : 'p'),
      zone: zone, verified: true, state: k.state, local: { y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi } };
  };
  /* a capture time, for "as of" lines */
  S.timestampText = function (t, zone) {
    var p = S.parse(t);
    if (p.ms == null) return 'time unknown';
    zone = zone && S.validZone(zone) ? zone : S.CONFIG.default_zone;
    var w = parts(p.ms, zone), h12 = (w.h % 12) || 12;
    return MON[w.mo - 1] + ' ' + w.d + ', ' + h12 + ':' + ('0' + w.mi).slice(-2) + ' ' + (w.h < 12 ? 'AM' : 'PM') + ' ' + zoneAbbr(p.ms, zone);
  };

  /* ============================================================== WEEKS */
  function seasonTypeRank(t) { return /post/i.test(String(t || '')) ? 1 : 0; }
  S.weekKey = function (g) {
    if (!g || g.week == null || g.season == null) return null;
    return g.season + ':' + seasonTypeRank(g.season_type) + ':' + ('0' + g.week).slice(-2);
  };
  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); var n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; }
  /* the current week of a slate: games carry season, week, (season_type),
     a kickoff and optionally a status */
  S.currentWeek = function (games, now) {
    now = now == null ? Date.now() : now;
    var byWeek = {};
    (games || []).forEach(function (g) {
      var key = S.weekKey(g); if (!key) return;
      var k = S.kickoffOf(g);
      (byWeek[key] = byWeek[key] || []).push({ g: g, k: k });
    });
    var keys = Object.keys(byWeek).sort();
    for (var i = 0; i < keys.length; i++) {
      var list = byWeek[keys[i]];
      var conf = list.filter(function (x) { return x.k.verified && x.k.ms != null; }).map(function (x) { return x.k.ms; });
      var all = list.filter(function (x) { return x.k.ms != null; }).map(function (x) { return x.k.ms; });
      var med = median(conf.length ? conf : all);
      if (med == null) continue;
      var open = list.some(function (x) {
        if (x.k.ms == null || Math.abs(x.k.ms - med) > S.CONFIG.cluster_days * D) return false;
        var st = S.statusOf(x.g, now).status;
        if (st === 'COMPLETED' || st === 'CANCELED' || st === 'POSTPONED') return false;
        /* a TBA game is open until the end of its date */
        var end = x.k.verified ? x.k.ms : x.k.ms + D;
        return end > now;
      });
      if (open) return { key: keys[i], season: list[0].g.season, week: list[0].g.week, season_type: list[0].g.season_type || null, median_kickoff: new Date(med).toISOString() };
    }
    return null;
  };
  /* where a game sits relative to the current week */
  S.scope = function (g, current) {
    var key = S.weekKey(g);
    if (!current || !key) return 'UNKNOWN_WEEK';
    return key === current.key ? 'CURRENT_WEEK' : (key > current.key ? 'FUTURE_WEEK' : 'PAST_WEEK');
  };

  /* ===================================================== PUBLISHABILITY */
  S.publishable = function (g, now, current) {
    now = now == null ? Date.now() : now;
    var st = S.statusOf(g, now), reasons = [];
    if (!st.kickoff.verified) reasons.push({ code: 'KICKOFF_' + st.kickoff.state, text: 'The kickoff is not confirmed (' + st.kickoff.label.toLowerCase() + ': ' + st.kickoff.basis + ').' });
    if (st.status !== 'SCHEDULED' && st.status !== 'TENTATIVE') reasons.push({ code: 'STATUS_' + st.status, text: 'The game is ' + st.label.toLowerCase() + '.' });
    else if (!st.pregame) reasons.push({ code: 'STARTED', text: 'The game has kicked off.' });
    var sc = current ? S.scope(g, current) : 'UNKNOWN_WEEK';
    if (current && sc !== 'CURRENT_WEEK') reasons.push({ code: sc, text: sc === 'FUTURE_WEEK' ? 'The game is in a future week (week ' + g.week + '); it belongs to future-week research, not this week’s content.' : 'The game belongs to a past week.' });
    return { ok: !reasons.length, reasons: reasons, status: st.status, kickoff_state: st.kickoff.state, scope: sc };
  };

  /* ====================================================== EVENT MATCHING
     Odds are assigned to a game only when the event is the same game:
     the same two teams in the same orientation, on the same game date
     (a TBA game) or within the kickoff window (a confirmed game). */
  S.EVENT_WINDOW_H = 36;
  S.eventMatch = function (ev, g, sameTeam) {
    sameTeam = sameTeam || function (a, b) { return String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '') === String(b || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
    if (!ev || !g) return { match: false, code: 'MISSING' };
    var gh = g.home_team || g.home, ga = g.away_team || g.away;
    var eh = ev.home_team || ev.home, ea = ev.away_team || ev.away;
    var straight = sameTeam(eh, gh) && sameTeam(ea, ga), swapped = sameTeam(eh, ga) && sameTeam(ea, gh);
    if (!straight && !swapped) return { match: false, code: 'TEAM_MISMATCH', text: 'the event names different teams' };
    var k = S.kickoffOf(g), e = S.parse(ev.commence_time || ev.kickoff || ev.start);
    if (e.ms == null) return { match: false, code: 'EVENT_TIME_MISSING', text: 'the event carries no usable start time' };
    var ok;
    if (k.verified && k.ms != null) ok = Math.abs(e.ms - k.ms) <= S.EVENT_WINDOW_H * H;
    else {
      var ed = parts(e.ms, S.CONFIG.placeholder_zone), d = ed.y + '-' + ('0' + ed.mo).slice(-2) + '-' + ('0' + ed.d).slice(-2);
      ok = !!k.game_date && (d === k.game_date || Math.abs(Date.parse(d) - Date.parse(k.game_date)) <= D);
    }
    if (!ok) return { match: false, code: 'DATE_MISMATCH', text: 'the event starts on a different date from the game' };
    return { match: true, code: swapped ? 'ORIENTATION_REVERSED' : 'MATCH', reversed: swapped,
      text: swapped ? 'the provider lists home and away the other way round; every line must be re-signed to the schedule’s home team' : 'same game' };
  };

  return S;
});
// ── lib/edgedesk_availability.js
/* ===========================================================================
   EdgeDesk AVAILABILITY — what is actually known about who plays.
   docs/system-integrity/DATA_CONTRACT.md §7 · AUDIT.md §6

   WHY IT EXISTS
     The Week 6 article said, game after game, that the starting quarterbacks
     were "not confirmed". The data behind it said something much narrower:
     the player started the previous game and no one had announced a starter
     for this one — which is the normal state of nearly every college game
     until kickoff. 215 of 234 CFB quarterback rows were exactly that. The
     other 19 ("COMPETITION") were inferred from a dropback split in play-by-
     play attribution, not from any report of a competition. The writer turned
     both into claims of uncertainty.

   THE CLASSES (one per player, for one game)
     CONFIRMED_ACTIVE     a sourced report says the player plays / starts
     EXPECTED_STARTER     no announcement; he started the last game and no
                          sourced report says otherwise. NOT uncertainty.
     GENUINE_COMPETITION  a sourced report of an open competition (a coach,
                          the team, a depth chart "OR", a named reporter)
     QUESTIONABLE         a sourced status of questionable / doubtful / game-
                          time decision
     RULED_OUT            a sourced status of out / suspended / season-ending
     UNKNOWN              no player identified at all
     NOT_VERIFIED         a claim with no verifiable source, a claim past its
                          effective date, or an inference (a usage split) that
                          suggests more than the data shows

   THE RULES
     1. Missing an announcement never implies a controversy.
     2. Uncertainty may be ASSERTED in prose only for GENUINE_COMPETITION,
        QUESTIONABLE or RULED_OUT, and only with the source and its time.
     3. A measured usage split may be printed as a measured fact ("57% of the
        recent dropbacks"), never as a claim that the job is unsettled.
     4. Every classification carries its source, publication time, effective
        date and verification state. A report published within the
        revalidation window before kickoff (a breaking development) must be
        revalidated before publication.

   Browser: window.EDAvailability. Node: require('./edgedesk_availability.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDAvailability = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var A = { VERSION: 'edgedesk_availability/1' };

  A.CLASSES = {
    CONFIRMED_ACTIVE: { label: 'Confirmed active', may_assert_uncertainty: false, uncertain: false },
    EXPECTED_STARTER: { label: 'Expected starter', may_assert_uncertainty: false, uncertain: false },
    GENUINE_COMPETITION: { label: 'Genuine competition', may_assert_uncertainty: true, uncertain: true },
    QUESTIONABLE: { label: 'Questionable', may_assert_uncertainty: true, uncertain: true },
    RULED_OUT: { label: 'Ruled out', may_assert_uncertainty: true, uncertain: true },
    UNKNOWN: { label: 'Unknown', may_assert_uncertainty: false, uncertain: false },
    NOT_VERIFIED: { label: 'Not verified', may_assert_uncertainty: false, uncertain: false }
  };
  A.CONFIG = {
    /* a report this close to kickoff, or newer than the approval it rides
       on, is a breaking development: revalidate before publishing */
    revalidate_hours_before_kickoff: 24,
    /* a sourced status older than this is not evidence about this game */
    max_report_age_days: 8,
    /* source kinds that can carry a claim on their own */
    verifiable_sources: ['official', 'team', 'league', 'reporter', 'depth_chart']
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }

  /* a report: { player, claim: 'starting'|'active'|'competition'|'questionable'|
     'doubtful'|'game_time'|'out'|'suspended'|'season_ending', injury,
     source: { name, kind, url }, published_at, effective_date, verified } */
  function claimClass(c) {
    c = low(c);
    if (/^(out|suspended|season[_ ]ending|injured[_ ]reserve|ir)$/.test(c)) return 'RULED_OUT';
    if (/^(questionable|doubtful|game[_ ]time|gtd|probable)$/.test(c)) return 'QUESTIONABLE';
    if (/^(competition|co[_ ]starters|or|open)$/.test(c)) return 'GENUINE_COMPETITION';
    if (/^(starting|starter|active|confirmed|named)$/.test(c)) return 'CONFIRMED_ACTIVE';
    return null;
  }
  function sourceOk(src) {
    if (!src || !present(src.name)) return false;
    return A.CONFIG.verifiable_sources.indexOf(low(src.kind)) >= 0;
  }

  /* x: { team, player, reports: [report], usage: { primary_share, secondary,
          secondary_share, source }, previous_start: bool, source_status,
          source, as_of }, ctx: { kickoff, now, approved_at } */
  A.classify = function (x, ctx) {
    x = x || {}; ctx = ctx || {};
    var now = ctx.now == null ? Date.now() : ctx.now, kick = ms(ctx.kickoff);
    var reps = (x.reports || []).filter(function (r) { return r && present(r.claim); }).slice()
      .sort(function (a, b) { return (ms(b.published_at) || 0) - (ms(a.published_at) || 0); });
    var out = { team: x.team || null, player: x.player || null, version: A.VERSION, source: null, published_at: null,
      effective_date: null, verification: 'NONE', revalidate_required: false, evidence: [] };
    function fin(k, extra) {
      var d = A.CLASSES[k];
      out['class'] = k; out.label = d.label; out.may_assert_uncertainty = d.may_assert_uncertainty; out.uncertain = d.uncertain;
      if (extra) for (var e in extra) if (Object.prototype.hasOwnProperty.call(extra, e)) out[e] = extra[e];
      return out;
    }
    /* 1. the newest sourced report decides */
    for (var i = 0; i < reps.length; i++) {
      var r = reps[i], k = claimClass(r.claim);
      if (!k) continue;
      var pub = ms(r.published_at), eff = ms(r.effective_date) != null ? ms(r.effective_date) : pub;
      out.source = r.source || null; out.published_at = pub != null ? new Date(pub).toISOString() : null;
      out.effective_date = eff != null ? new Date(eff).toISOString() : null;
      out.evidence.push({ kind: 'report', claim: r.claim, source: r.source ? r.source.name : null, published_at: out.published_at });
      if (!sourceOk(r.source) || r.verified === false)
        return fin('NOT_VERIFIED', { verification: 'UNVERIFIED_SOURCE', reason: 'a ' + low(r.claim) + ' claim with no verifiable source' + (r.source && r.source.name ? ' (' + r.source.name + ')' : '') });
      if (pub == null)
        return fin('NOT_VERIFIED', { verification: 'NO_TIMESTAMP', reason: 'a sourced claim with no publication time' });
      if (now - (eff || pub) > A.CONFIG.max_report_age_days * 86400e3)
        return fin('NOT_VERIFIED', { verification: 'STALE', reason: 'the report is older than ' + A.CONFIG.max_report_age_days + ' days' });
      var breaking = (kick != null && kick - pub <= A.CONFIG.revalidate_hours_before_kickoff * 3600e3 && pub <= kick)
        || (ms(ctx.approved_at) != null && pub > ms(ctx.approved_at));
      return fin(k, { verification: 'SOURCED', revalidate_required: !!breaking, injury: r.injury || null,
        reason: (r.source.name) + ' (' + out.published_at.slice(0, 10) + '): ' + low(r.claim) });
    }
    if (!present(x.player)) return fin('UNKNOWN', { reason: 'no player identified for this position' });
    /* 2. no report: an inferred split is a measured fact, not a competition */
    var st = low(x.source_status);
    if (x.usage && x.usage.secondary && x.usage.secondary_share != null && x.usage.secondary_share >= 0.25) {
      out.evidence.push({ kind: 'usage', source: x.usage.source || x.source || null, primary_share: x.usage.primary_share, secondary: x.usage.secondary, secondary_share: x.usage.secondary_share });
      return fin('NOT_VERIFIED', { verification: 'INFERRED', reason: 'a usage split in play-by-play data, with no report of a competition',
        measured_note: true });
    }
    if (st === 'competition' || x.contested === true)
      return fin('NOT_VERIFIED', { verification: 'INFERRED', reason: 'flagged as a competition by an inference, with no report' });
    if (x.previous_start || st === 'previous_game' || st === 'expected')
      return fin('EXPECTED_STARTER', { verification: 'INFERRED', reason: 'started the previous game; no report says otherwise', source: x.source ? { name: x.source, kind: 'inferred' } : null });
    if (st === 'confirmed' || x.confirmed === true)
      return fin('NOT_VERIFIED', { verification: 'NO_SOURCE', reason: 'marked confirmed upstream, but no source is attached' });
    return fin('UNKNOWN', { reason: 'no start, no report' });
  };

  /* the CFB terminal's qb row ({player, status, confirmed, contested, label,
     source, as_of}) as classify() input. A COMPETITION row's label carries the
     measured split ("A 57% of recent dropbacks and B 38% …"). */
  A.fromTerminal = function (team, q) {
    if (!q) return { team: team, player: null };
    var x = { team: team, player: q.player || null, source_status: q.status || null, source: q.source || null, as_of: q.as_of || null,
      contested: !!q.contested, confirmed: !!q.confirmed, previous_start: /previous/i.test(String(q.status || '')), reports: q.reports || [] };
    var m = /([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})% of recent dropbacks and ([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})%/.exec(String(q.label || ''));
    if (m) x.usage = { primary: m[1], primary_share: +m[2] / 100, secondary: m[3], secondary_share: +m[4] / 100, source: q.source || null };
    return x;
  };
  /* an NFL injury report row ({name, status, injury, report_date|as_of}) */
  A.fromInjuryReport = function (team, row, sourceName) {
    if (!row) return { team: team, player: null };
    var st = low(row.status);
    var claim = /out|ir|reserve|suspend/.test(st) ? 'out' : (/doubt/.test(st) ? 'doubtful' : (/question/.test(st) ? 'questionable' : (/active|full|probable/.test(st) ? 'active' : null)));
    return { team: team, player: row.name || row.player || null,
      reports: claim ? [{ claim: claim, injury: row.injury || null, published_at: row.report_date || row.as_of || row.date_modified || null,
        source: { name: sourceName || 'the official NFL injury report', kind: 'official' } }] : [] };
  };

  /* the ONE sentence a document may print about a classified player, or null */
  A.sentence = function (c) {
    if (!c || !c['class']) return null;
    var who = c.player || 'the starter', team = c.team || 'the team', src = c.source && c.source.name ? c.source.name : null;
    var date = c.published_at ? c.published_at.slice(0, 10) : null;
    switch (c['class']) {
      case 'RULED_OUT': return src ? src + ' has ' + who + ' out' + (c.injury ? ' (' + low(c.injury) + ')' : '') + (date ? ', as of ' + date : '') + '.' : null;
      case 'QUESTIONABLE': return src ? src + ' lists ' + who + ' as questionable' + (c.injury ? ' (' + low(c.injury) + ')' : '') + (date ? ', as of ' + date : '') + '.' : null;
      case 'GENUINE_COMPETITION': return src ? team + ' has not settled its starting quarterback, according to ' + src + (date ? ' (' + date + ')' : '') + '.' : null;
      case 'NOT_VERIFIED': {
        var u = (c.evidence || []).filter(function (e) { return e.kind === 'usage'; })[0];
        if (u && c.measured_note && u.primary_share != null) return who === u.secondary
          ? u.secondary + ' has taken ' + Math.round(100 * u.secondary_share) + '% of ' + team + '’s recent dropbacks.'
          : who + ' has taken ' + Math.round(100 * u.primary_share) + '% of ' + team + '’s recent dropbacks and ' + u.secondary + ' ' + Math.round(100 * u.secondary_share) + '%.';
        return null;
      }
      default: return null;
    }
  };

  /* PROSE GUARD: sentences that assert quarterback / availability
     uncertainty, and the team they are about. A claim is allowed only when
     that team's classification may assert it. */
  A.UNCERTAINTY = /\b(not (?:been )?confirmed|unconfirmed|unsettled|uncertain(?:ty)?|question mark|no starter has been announced|has not (?:been )?(?:named|announced)|quarterback (?:battle|competition|controversy)|competition at quarterback|could start|may not (?:play|start)|game-time decision|questionable|doubtful|ruled out|will not play|won’t play|won't play)\b/i;
  A.guardProse = function (text, byTeam) {
    var issues = [];
    var sentences = String(text || '').replace(/([.!?])\s+/g, '$1\u0001').split('\u0001');
    sentences.forEach(function (s) {
      if (!A.UNCERTAINTY.test(s) || !/quarterback|\bQB\b|starter|play\b|\bout\b|injur|status/i.test(s)) return;
      var teams = Object.keys(byTeam || {}).filter(function (t) { return t && s.indexOf(t) >= 0; });
      (byTeam && teams.length ? teams : ['?']).forEach(function (t) {
        var list = (byTeam && byTeam[t]) || [];
        var ok = list.some(function (c) { return c && c.may_assert_uncertainty && c.verification === 'SOURCED'; });
        if (!ok) issues.push({ team: t === '?' ? null : t, sentence: s.trim().slice(0, 240),
          reason: t === '?' ? 'an availability-uncertainty claim not tied to a team with a sourced report'
            : 'asserts availability uncertainty for ' + t + ', whose classification is ' + (list.map(function (c) { return c.label; }).join(' / ') || 'none') + ' — no sourced report supports it' });
      });
    });
    return issues;
  };

  return A;
});
// ── lib/edgedesk_integrity.js
/* ===========================================================================
   EdgeDesk INTEGRITY — the one validation engine every boundary runs.
   docs/system-integrity/DATA_CONTRACT.md · docs/system-integrity/RULES.md

   ONE RECORD, ONE ENGINE, EVERY BOUNDARY
     A research record (EDIntegrity.record / fromTerminalGame) is the data
     contract: the game, its kickoff truth, the model snapshot, the market
     snapshot, the canonical comparison (lib/edgedesk_calc.js), the research
     status, the decision, the EV pair, availability and provenance.

     evaluate(record, boundary) runs every deterministic rule and returns, per
     rule: PASS, WARNING or BLOCKED, with the rule id, severity, the record,
     the evidence, a plain-English explanation and the remediation. The
     boundary decides what blocks: a placeholder kickoff is a WARNING on the
     research dashboard (shown as "time TBA") and BLOCKED in a publisher
     export. Nothing BLOCKED at READY_TO_SEND may be sent.

       RESEARCH_DASHBOARD   the boards and research pages (warn, rarely block)
       BETTING_DECISION     what may become BET / LEAN / WATCH
       PUBLIC_BRIEF         a public game brief or article page
       AI_CONTEXT           what an AI writer may be handed as fact
       EDITORIAL_APPROVAL   the owner's approval
       READY_TO_SEND        the last gate before anything leaves EdgeDesk
       PUBLISHER_EXPORT     Markdown / HTML / DOCX / publisher files

   WHAT THIS FILE NEVER DOES
     - ask an AI anything. Arithmetic and structure are checked by code;
     - change a number, a label or a decision. It reports; callers refuse;
     - pass a check by default: a rule with no input it needs is WARNING
       (unknown is never PASS) unless the rule says absence is fine.

   Browser: window.EDIntegrity (load edgedesk_calc.js, edgedesk_schedule.js,
   edgedesk_availability.js first). Node: require('./edgedesk_integrity.js').
   =========================================================================== */
(function (root, factory) {
  var deps = {};
  if (typeof module === 'object' && module.exports) {
    deps.calc = require('./edgedesk_calc.js');
    deps.schedule = require('./edgedesk_schedule.js');
    deps.availability = require('./edgedesk_availability.js');
    module.exports = factory(deps);
  } else {
    deps.calc = root.EDCalc; deps.schedule = root.EDSchedule; deps.availability = root.EDAvailability;
    root.EDIntegrity = factory(deps);
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (deps) {
  'use strict';
  var CALC = deps.calc, SCHED = deps.schedule, AV = deps.availability;
  if (!CALC || !SCHED || !AV) throw new Error('EDIntegrity needs EDCalc, EDSchedule and EDAvailability loaded first');
  var I = { VERSION: 'edgedesk_integrity/1', RECORD_SCHEMA: 'edgedesk_research_record_v1' };

  var BOUNDARIES = ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'];
  var PUBLICATION = ['PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'];
  I.BOUNDARIES = BOUNDARIES; I.PUBLICATION = PUBLICATION;
  I.THRESHOLDS = { stale_minutes: 180, min_reliability: 60, future_tolerance_minutes: 5, score_tolerance: 0.1, prob_sum_tolerance: 0.005 };

  function num(x) { return CALC.num(x); }
  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function pick(o, path) { var c = o, p = path.split('.'); for (var i = 0; i < p.length; i++) { if (c == null) return null; c = c[p[i]]; } return c === undefined ? null : c; }
  function fixed(x, d) { return num(x) == null ? '—' : num(x).toFixed(d == null ? 1 : d); }

  /* ======================================================== THE RECORD
     The data contract (DATA_CONTRACT.md §1). Every field is optional in the
     input; a missing field is carried as null and the rules say so. */
  I.record = function (x) {
    x = x || {};
    var g = x.game || {}, m = x.model || {}, k = x.market || {};
    var names = { home: g.home || null, away: g.away || null };
    var kick = SCHED.kickoffOf({ kickoff: g.kickoff, start_time_tbd: has(g, 'start_time_tbd') ? g.start_time_tbd : (has(g, 'kickoff_tbd') ? g.kickoff_tbd : undefined), kickoff_state: g.kickoff_state, kickoff_basis: g.kickoff_basis });
    var cmp = CALC.spreadComparison({ home: names.home, away: names.away, model_home_margin: m.available === false ? null : m.home_margin,
      market_home_margin: k.available === false ? null : k.home_margin, model_snapshot_id: m.snapshot_id, market_snapshot_id: k.snapshot_id });
    var scores = num(m.total) != null && num(m.home_margin) != null ? CALC.projectedScores({ home: names.home, away: names.away, home_margin: m.home_margin, total: m.total }) : { available: false };
    var r = {
      schema: I.RECORD_SCHEMA, integrity_version: I.VERSION, calc_version: CALC.VERSION,
      game: { game_id: g.game_id != null ? String(g.game_id) : null, sport: g.sport || 'CFB', season: num(g.season), season_type: g.season_type || null, week: num(g.week),
        home: names.home, away: names.away, home_id: g.home_id != null ? String(g.home_id) : null, away_id: g.away_id != null ? String(g.away_id) : null,
        home_conference: g.home_conference || null, away_conference: g.away_conference || null, neutral_site: has(g, 'neutral_site') ? !!g.neutral_site : null,
        venue: g.venue || null, status: g.status || null, completed: g.completed || null },
      kickoff: kick,
      model: { available: m.available !== false && num(m.home_margin) != null, version: m.version || null, snapshot_id: m.snapshot_id || null, projected_at: iso(m.projected_at),
        home_margin: num(m.home_margin), total: num(m.total), home_win_prob: num(m.home_win_prob), away_win_prob: num(m.away_win_prob),
        projected_score: m.projected_score || null, confidence: num(m.confidence), reliability: num(m.reliability), completeness: num(m.completeness), near_pickem: num(m.home_margin) != null && Math.abs(m.home_margin) < 1,
        /* false when the league's model publishes no reliability score at all
           (the NFL model): the record says so instead of inventing a number */
        reliability_published: has(m, 'reliability_published') ? m.reliability_published !== false : true },
      market: { available: k.available !== false && num(k.home_margin) != null, snapshot_id: k.snapshot_id || null, captured_at: iso(k.captured_at), market_type: k.market_type || 'spread',
        is_main_line: has(k, 'is_main_line') ? k.is_main_line : null, home_margin: num(k.home_margin), book: k.book || null, source: k.source || null, method: k.method || null,
        books_fresh: num(k.books_fresh), books_total: num(k.books_total), stale: has(k, 'stale') ? !!k.stale : null, fault: k.fault || null, mapping_ok: has(k, 'mapping_ok') ? k.mapping_ok : null,
        orientation_ok: has(k, 'orientation_ok') ? k.orientation_ok : null, quarantined_in_consensus: k.quarantined_in_consensus || [], claim: k.claim || null,
        /* a REFERENCE line: a published line with a source but no book price
           or capture time. It is labelled as a reference and never presented
           as a price, so a missing capture time is not a clock fault for it. */
        reference: has(k, 'reference') ? !!k.reference : false },
      comparison: cmp,
      projected_scores: scores,
      research: x.research || null,
      decision: x.decision || null,
      ev: x.ev || null,
      availability: x.availability || null,
      displayed: x.displayed || null,
      provenance: x.provenance || [],
      built_at: iso(x.built_at) || null
    };
    r.record_id = 'rr_' + CALC.fingerprint([r.game.game_id, r.model.version, r.model.snapshot_id, r.model.home_margin, r.market.snapshot_id, r.market.home_margin, r.market.captured_at, r.calc_version]);
    return r;
  };

  /* ===================== ADAPTER: a CFB terminal research object (games.json)
     opts: { slate_row (football/fbs/slate.json game, for start_time_tbd and
     team ids), board_row (board.json), built_at } */
  I.fromTerminalGame = function (o, opts) {
    opts = opts || {};
    if (!o) return null;
    var G = o.game || {}, A = o.edgedesk || {}, B = o.market || {}, S = opts.slate_row || {}, R = opts.board_row || {};
    var cons = num(B.consensus_home_line);
    var bestQ = (B.quotes || []).filter(function (q) { return q && q.fresh; })[0] || null;
    var dq = o.data_quality || {};
    var ev = o.ev || null, qev = R.quote_ev || compactQuoteEv(o.quote_ev);
    var evSel = ev && ev.selected ? ev.selected : null;
    var qb = o.qb || {};
    var av = { home: [AV.classify(AV.fromTerminal(G.home, qb.home), { kickoff: o.kickoff })], away: [AV.classify(AV.fromTerminal(G.away, qb.away), { kickoff: o.kickoff })] };
    return I.record({
      game: { game_id: o.game_id, season: o.season, week: o.week, season_type: S.season_type || null, home: G.home, away: G.away,
        home_id: S.home_team_id || null, away_id: S.away_team_id || null, home_conference: G.home_conference, away_conference: G.away_conference,
        neutral_site: G.neutral_site, venue: G.venue, kickoff: o.kickoff,
        start_time_tbd: has(S, 'start_time_tbd') ? S.start_time_tbd : (has(o, 'kickoff_tbd') ? o.kickoff_tbd : undefined),
        kickoff_state: S.kickoff_state || o.kickoff_state || null, kickoff_basis: S.kickoff_basis || o.kickoff_basis || null },
      model: { available: !!A.available, version: A.model_version, snapshot_id: opts.model_snapshot_id || (A.prediction_ts ? 'v1@' + A.prediction_ts : null), projected_at: A.prediction_ts,
        home_margin: A.home_margin, total: A.fair_total, home_win_prob: A.home_win_prob, away_win_prob: A.away_win_prob, projected_score: A.projected_score || null,
        confidence: A.football_confidence ? A.football_confidence.score : null, reliability: dq.reliability, completeness: S.data_completeness != null ? S.data_completeness : null },
      market: { available: !!B.available && cons != null, snapshot_id: B.as_of ? 'mkt@' + B.as_of : null, captured_at: B.as_of, market_type: 'spread', is_main_line: true,
        home_margin: cons == null ? null : -cons, book: bestQ ? bestQ.book : (B.quotes && B.quotes[0] ? B.quotes[0].book : null), source: bestQ ? bestQ.source : null,
        method: B.books_fresh > 1 ? 'MEDIAN' : 'SINGLE_BOOK', books_fresh: B.books_fresh, books_total: B.books_total, stale: !!B.stale,
        fault: B.consensus_fault ? B.consensus_fault.reason : (o.research_status && o.research_status.key === 'MARKET_FAULT' ? o.research_status.reason : null),
        mapping_ok: pick(R, 'decision_facts.game.mapping_ok'), orientation_ok: pick(R, 'decision_facts.game.orientation_ok'), quarantined_in_consensus: B.quarantined_in_consensus || [] },
      research: o.research_status ? { key: o.research_status.key, label: o.research_status.label, rule: o.research_status.rule, reason: o.research_status.reason, flags: o.research_status.flags || [] } : null,
      decision: o.decision_status ? { key: o.decision_status.key, label: o.decision_status.label, reason: o.decision_status.reason, engine_status: o.decision_status.engine_status,
        bettor: R.bettor || null } : null,
      ev: ev ? {
        raw: evSel && num(evSel.raw_model_ev) != null ? { ev: evSel.raw_model_ev, p: evSel.p_cover_raw, selection: selOf(evSel) } : null,
        calibrated: evSel && num(evSel.calibrated_ev) != null ? { ev: evSel.calibrated_ev, p: evSel.p_cover_calibrated, selection: selOf(evSel) } : null,
        quote_raw: qev && qev.best_side && num(qev.expected_value_pct) != null ? { ev: qev.expected_value_pct / 100, p: qev.model_cover_probability,
          selection: { market_type: 'spread', side: qev.best_side, line: qev.best_spread, american: qev.best_price, book: qev.best_book, captured_at: qev.best_quote_timestamp } } : null,
        quote_calibrated: qev && qev.best_side && num(qev.calibrated_expected_value_pct) != null ? { ev: qev.calibrated_expected_value_pct / 100,
          selection: { market_type: 'spread', side: qev.best_side, line: qev.best_spread, american: qev.best_price, book: qev.best_book, captured_at: qev.best_quote_timestamp } } : null,
        calibration: ev.calibration || null, anchor: ev.calibration_anchor || null, policy_maturity: ev.policy_maturity || null
      } : null,
      availability: av,
      displayed: opts.displayed || { fair_text: A.fair_text || null, market_text: B.consensus_text || null, gap: o.disagreement && o.disagreement.available ? o.disagreement.points : null,
        gap_text: o.disagreement ? o.disagreement.text || null : null, score_text: A.projected_score ? A.projected_score.text : null, market_claim: B.stale ? 'stale' : (B.available ? 'current' : null) },
      provenance: (o.sources || []).map(function (s) { return { id: s.id, path: s.path, updated_at: s.updated_at || null }; }),
      built_at: o.built_at || opts.built_at || null
    });
  };
  /* the best-raw-EV main-line quote of a full quote-EV object (games.json),
     in the board row's compact shape */
  function compactQuoteEv(full) {
    if (!full || (!full.home && !full.away)) return null;
    var best = null;
    ['home', 'away'].forEach(function (s) {
      ((full[s] && full[s].quotes) || []).forEach(function (q) {
        if (!q || !q.ev_available || num(q.expected_value_pct) == null || q.is_main_line === false) return;
        if (!best || q.expected_value_pct > best.expected_value_pct) best = q;
      });
    });
    if (!best) return null;
    return { best_side: best.side, best_spread: best.line, best_price: best.american_odds, best_book: best.sportsbook, best_quote_timestamp: best.captured_at,
      model_cover_probability: best.model_cover_probability, expected_value_pct: best.expected_value_pct,
      calibrated_expected_value_pct: best.adjusted && best.adjusted.available ? best.adjusted.expected_value_pct : null };
  }
  function selOf(s) { return { market_type: s.market_type || 'spread', side: s.side, line: s.line, american: s.odds ? s.odds.american : s.american, book: s.book, captured_at: s.quote_ts || s.captured_at }; }

  /* =========================================================== CALIBRATION
     A calibrator that maps every probability to (about) 50% has learned
     that the raw probabilities carry no information. It is not a broken
     calibrator — it is a finding — but it must never be presented as a
     validated probability. */
  I.calibrationQuality = function (cal) {
    if (!cal) return { state: 'MISSING', usable: false, text: 'No calibration is attached: the probability is the raw model’s.' };
    var oof = cal.oof || {};
    var ll = num(oof.log_loss), br = num(oof.brier), ill = num(oof.identity_log_loss), ibr = num(oof.identity_brier), isl = num(oof.identity_slope);
    var T = cal.map && num(cal.map.T);
    /* a temperature this large divides every logit to ~0: every probability is 50% */
    var degenerate = ((ll != null && Math.abs(ll - Math.LN2) < 0.0015) && (br != null && Math.abs(br - 0.25) < 0.0015)) || (T != null && T >= 1000);
    var rawWorse = ill != null && ill > Math.LN2 + 0.002;
    var state = degenerate ? 'DEGENERATE' : (/shadow|experimental/i.test(String(cal.maturity || '')) ? 'SHADOW' : (cal.usable ? 'VALIDATED' : 'UNUSABLE'));
    var text;
    if (degenerate) text = 'The calibrator maps every cover probability to about 50%' + (T != null && T >= 1000 ? ' (a temperature of ' + Math.round(T).toLocaleString('en-US') + ')' : '') + ' (out-of-sample log loss ' + fixed(ll, 3) + ', Brier ' + fixed(br, 3)
      + ' — a coin flip). Out of sample' + (cal.training_window ? ' (' + cal.training_window + ', ' + (oof.n || '?') + ' games)' : '') + ', the raw model’s cover probabilities scored '
      + (rawWorse ? 'worse than a coin flip (log loss ' + fixed(ill, 3) + (isl != null ? ', slope ' + fixed(isl, 2) : '') + ')' : 'no better than a coin flip')
      + '. A calibrated EV from it is the price’s vig, not a measurement of an edge. Status in the artifact: ' + (cal.status || '?') + ' / ' + (cal.maturity || '?') + '.';
    else if (state === 'SHADOW') text = 'Calibration is ' + cal.maturity + ': fitted out of sample but not yet validated on live games. Shadow-only.';
    else if (state === 'VALIDATED') text = 'Calibration validated out of sample.';
    else text = 'Calibration is not usable: ' + (cal.reason || 'no reason recorded') + '.';
    return { state: state, usable: state === 'VALIDATED', degenerate: degenerate, raw_worse_than_coin: rawWorse, text: text,
      oof: { n: oof.n || null, log_loss: ll, brier: br, identity_log_loss: ill, identity_brier: ibr, identity_slope: isl } };
  };

  /* ================================================================ RULES
     at: per boundary, 'BLOCK' | 'WARN' | 'OFF'; default for an unlisted
     boundary is dflt. check() returns null when the rule holds. */
  function at(block, warn, off, dflt) {
    var o = {}; (block || []).forEach(function (b) { o[b] = 'BLOCK'; }); (warn || []).forEach(function (b) { o[b] = 'WARN'; }); (off || []).forEach(function (b) { o[b] = 'OFF'; });
    o._default = dflt || 'BLOCK'; return o;
  }
  var ALL_BLOCK = at([], [], [], 'BLOCK');
  var DASH_WARN = at([], ['RESEARCH_DASHBOARD'], [], 'BLOCK');
  var DASH_DEC_WARN = at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION'], [], 'BLOCK');
  var WARN_ALL = at([], [], [], 'WARN');

  var RULES = [
    /* ------------------------------------------------------------ SCHEDULE */
    { id: 'SCHED.REAL_EVENT', group: 'schedule', title: 'A real, identified event', at: ALL_BLOCK,
      check: function (r) {
        var g = r.game;
        if (!g.game_id || !g.home || !g.away) return { evidence: { game_id: g.game_id, home: g.home, away: g.away }, explanation: 'The record has no stable game id or is missing a team.', remediation: 'Rebuild the record from the schedule source; never publish a game without a canonical id.' };
        if (String(g.home).toLowerCase() === String(g.away).toLowerCase()) return { evidence: { home: g.home, away: g.away }, explanation: 'The home and away teams are the same.', remediation: 'Fix the schedule join.' };
        return null;
      } },
    { id: 'SCHED.TEAM_IDS', group: 'schedule', title: 'Stable team identifiers', at: WARN_ALL,
      check: function (r) { return r.game.home_id && r.game.away_id ? null : { evidence: { home_id: r.game.home_id, away_id: r.game.away_id }, explanation: 'Team ids are not on the record; teams are matched by name only.', remediation: 'Carry the schedule’s home_team_id / away_team_id into the record.' }; } },
    { id: 'SCHED.SEASON_WEEK', group: 'schedule', title: 'Season and week on the record', at: DASH_WARN,
      check: function (r) { return r.game.season != null && r.game.week != null ? null : { evidence: { season: r.game.season, week: r.game.week }, explanation: 'The record does not say which season and week it belongs to.', remediation: 'Carry the schedule’s season and week.' }; } },
    { id: 'SCHED.KICKOFF_VERIFIED', group: 'schedule', title: 'Kickoff time confirmed by the source', at: DASH_DEC_WARN,
      check: function (r) {
        var k = r.kickoff;
        return k.verified ? null : { evidence: { state: k.state, utc: k.utc, basis: k.basis, game_date: k.game_date },
          explanation: k.state === 'MISSING' ? 'No usable kickoff is on file.' : 'The kickoff time is not confirmed: ' + k.basis + '. The timestamp is a placeholder, not a time.',
          remediation: 'Show "time TBA" on the game date; keep the game out of publications until the source confirms a time.' };
      } },
    { id: 'SCHED.PREGAME', group: 'schedule', title: 'The game has not started and is not postponed or canceled', at: at([], ['RESEARCH_DASHBOARD'], [], 'BLOCK'),
      check: function (r, ctx) {
        var st = SCHED.statusOf({ kickoff: r.kickoff.utc, start_time_tbd: r.kickoff.verified ? false : true, status: r.game.status, completed: r.game.completed }, ctx.now);
        return st.pregame ? null : { evidence: { status: st.status, inferred: st.inferred }, explanation: 'The game is ' + st.label.toLowerCase() + (st.inferred ? ' (kickoff has passed)' : '') + '.', remediation: 'Remove it from pregame research, decisions and articles.' };
      } },
    { id: 'SCHED.WEEK_SCOPE', group: 'schedule', title: 'The game belongs to the week being published', at: DASH_DEC_WARN,
      check: function (r, ctx) {
        var tgt = ctx.target_week || ctx.current_week;
        if (!tgt) return { evidence: {}, explanation: 'No target week was supplied, so week scope could not be checked.', remediation: 'Pass the current week (EDSchedule.currentWeek) or the article’s target week.' };
        var sc = SCHED.scope(r.game, tgt);
        return sc === 'CURRENT_WEEK' ? null : { evidence: { scope: sc, week: r.game.week, target_week: tgt.week },
          explanation: sc === 'FUTURE_WEEK' ? 'Week ' + r.game.week + ' is a future week; this is look-ahead research, not this week’s.' : 'The game is outside the target week (' + sc + ').',
          remediation: 'Label it FUTURE WEEK on research surfaces; keep it out of this week’s articles.' };
      } },
    { id: 'SCHED.VENUE', group: 'schedule', title: 'Venue and neutral-site designation on file', at: WARN_ALL,
      check: function (r) { return r.game.venue && r.game.neutral_site !== null ? null : { evidence: { venue: r.game.venue, neutral_site: r.game.neutral_site }, explanation: 'The venue or the neutral-site flag is missing; home field cannot be checked.', remediation: 'Carry the schedule’s venue and neutral_site.' }; } },

    /* ---------------------------------------------------------- PROJECTION */
    { id: 'PROJ.AVAILABLE', group: 'projection', title: 'A model projection with its version', at: DASH_WARN,
      check: function (r) { return r.model.available && r.model.version ? null : { evidence: { available: r.model.available, version: r.model.version }, explanation: 'There is no projection, or it carries no model version.', remediation: 'Show the game without a model number; never fill one in.' }; } },
    { id: 'PROJ.SNAPSHOT', group: 'projection', title: 'Projection snapshot id and timestamp', at: DASH_DEC_WARN,
      check: function (r) { if (!r.model.available) return null; return r.model.snapshot_id && r.model.projected_at ? null : { evidence: { snapshot_id: r.model.snapshot_id, projected_at: r.model.projected_at }, explanation: 'The projection cannot be traced to a snapshot.', remediation: 'Carry the projection’s snapshot id and prediction timestamp.' }; } },
    { id: 'PROJ.MODEL_VERSION', group: 'projection', title: 'The champion model produced the number', at: DASH_WARN,
      check: function (r, ctx) { if (!r.model.available || !ctx.champion) return null; return r.model.version === ctx.champion ? null : { evidence: { version: r.model.version, champion: ctx.champion }, explanation: 'The projection came from ' + r.model.version + ', not the champion ' + ctx.champion + '.', remediation: 'Rebuild from the champion, or label the number as a challenger’s.' }; } },
    { id: 'PROJ.PROBABILITIES', group: 'projection', title: 'Valid win probabilities', at: ALL_BLOCK,
      check: function (r) {
        var h = r.model.home_win_prob, a = r.model.away_win_prob;
        if (!r.model.available || (h == null && a == null)) return null;
        if (h == null || a == null || h < 0 || h > 1 || a < 0 || a > 1 || Math.abs(h + a - 1) > I.THRESHOLDS.prob_sum_tolerance)
          return { evidence: { home_win_prob: h, away_win_prob: a }, explanation: 'The win probabilities are outside [0, 1] or do not sum to 1.', remediation: 'Rebuild the projection; never show it.' };
        return null;
      } },
    { id: 'PROJ.DIRECTION', group: 'projection', title: 'Spread direction agrees with the win probability', at: ALL_BLOCK,
      check: function (r) {
        var m = r.model.home_margin, h = r.model.home_win_prob;
        if (!r.model.available || m == null || h == null || Math.abs(m) < 0.5) return null;
        return (m > 0) === (h > 0.5) ? null : { evidence: { home_margin: m, home_win_prob: h }, explanation: 'The projected margin favours one team and the win probability the other: a sign error.', remediation: 'Check the orientation of the projection; block until fixed.' };
      } },
    { id: 'PROJ.SCORES', group: 'projection', title: 'Projected scores agree with the margin and the total', at: DASH_WARN,
      check: function (r) {
        var ps = r.model.projected_score;
        if (!r.model.available || !ps || num(ps.home) == null || num(ps.away) == null || r.model.total == null) return null;
        var dm = Math.abs((ps.home - ps.away) - r.model.home_margin), dt = Math.abs((ps.home + ps.away) - r.model.total), tol = I.THRESHOLDS.score_tolerance + 1e-9;
        var side = Math.abs(r.model.home_margin) < 0.05 || ((ps.home - ps.away) >= 0) === (r.model.home_margin > 0);
        if (dm <= tol && dt <= tol && side) return null;
        return { evidence: { projected_score: { home: ps.home, away: ps.away }, home_margin: r.model.home_margin, total: r.model.total, margin_off: CALC.round(dm, 2), total_off: CALC.round(dt, 2) },
          explanation: 'The projected scores do not reproduce the projected margin and total.', remediation: 'Print scores from EDCalc.projectedScores (derived from the margin and the total).' };
      } },
    { id: 'PROJ.INPUTS', group: 'projection', title: 'Thin or unmeasured inputs are labelled as such', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION'], [], 'BLOCK'),
      check: function (r) {
        if (!r.model.available) return null;
        var rel = r.model.reliability, key = r.research && r.research.key;
        if (rel == null && r.model.reliability_published === false) return { soft: true, evidence: { reliability: null, published: false },
          explanation: 'This league’s model publishes no reliability score, so none is shown and none may be claimed.', remediation: 'Say nothing about reliability; never describe the read as "reliable".' };
        var thin = rel == null || rel < I.THRESHOLDS.min_reliability;
        var labelled = key === 'LIMITED_DATA' || key === 'NO_MARKET' || key === 'DATA_FAULT';
        return !thin || labelled ? null : { evidence: { reliability: rel, research_status: key },
          explanation: 'Reliability is ' + (rel == null ? 'unmeasured' : rel) + ' (under ' + I.THRESHOLDS.min_reliability + '), but the game is presented as ' + (key || 'research') + ', not as limited data.',
          remediation: 'Investigate internally; never publish a thin-data game as a reliable read.' };
      } },

    /* -------------------------------------------------------------- MARKET */
    { id: 'MKT.PRESENT', group: 'market', title: 'A market quote exists', at: at(['BETTING_DECISION'], [], ['RESEARCH_DASHBOARD', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'], 'OFF'),
      check: function (r) { return r.market.available ? null : { evidence: {}, explanation: 'No market line is joined to this game.', remediation: 'Nothing to decide on; the projection stands alone.' }; } },
    { id: 'MKT.TIMESTAMP', group: 'market', title: 'The quote has a valid capture time', at: ALL_BLOCK,
      check: function (r, ctx) {
        if (!r.market.available) return null;
        var t = ms(r.market.captured_at);
        if (t == null && r.market.reference) return null;   /* labelled a reference: MKT.FRESH says it is not a price */
        if (t == null) return { evidence: { captured_at: r.market.captured_at }, explanation: 'The market line has no capture time, so its age cannot be known.', remediation: 'Treat it as a reference line, never as a price.' };
        if (t > ctx.now + I.THRESHOLDS.future_tolerance_minutes * 60e3) return { evidence: { captured_at: r.market.captured_at }, explanation: 'The capture time is in the future: a clock fault.', remediation: 'Quarantine the quote.' };
        return null;
      } },
    { id: 'MKT.FRESH', group: 'market', title: 'The quote is current (inside the freshness window)', at: at(['BETTING_DECISION'], ['RESEARCH_DASHBOARD', 'PUBLIC_BRIEF', 'AI_CONTEXT', 'EDITORIAL_APPROVAL', 'READY_TO_SEND', 'PUBLISHER_EXPORT'], [], 'WARN'),
      check: function (r, ctx) {
        if (!r.market.available) return null;
        var t = ms(r.market.captured_at), age = t == null ? null : (ctx.now - t) / 60e3;
        var stale = r.market.stale === true || age == null || age > I.THRESHOLDS.stale_minutes;
        if (r.market.reference) return { evidence: { reference: true, source: r.market.source, captured_at: r.market.captured_at },
          explanation: 'The market line is a reference line' + (r.market.source ? ' (' + r.market.source + ')' : '') + ' with no book price' + (t == null ? ' or capture time' : '') + ': it can be quoted as a reference, never as a current price.',
          remediation: 'Label it as a reference line with its source; never call it current or price a decision on it.' };
        return stale ? { evidence: { captured_at: r.market.captured_at, age_minutes: age == null ? null : Math.round(age), stale_minutes: I.THRESHOLDS.stale_minutes },
          explanation: 'The market line is ' + (age == null ? 'of unknown age' : CALC.fmt.age(age)) + ', past the ' + I.THRESHOLDS.stale_minutes + '-minute freshness rule: it is the last line EdgeDesk saw, not a current price.',
          remediation: 'Label it "last captured line (stale)" with its capture time; never call it current.' } : null;
      } },
    { id: 'MKT.CURRENT_CLAIM', group: 'market', title: 'No unsupported "current price" claim', at: ALL_BLOCK,
      check: function (r, ctx) {
        var d = r.displayed || {};
        if (d.market_claim !== 'current' || !r.market.available) return null;
        var t = ms(r.market.captured_at), age = t == null ? null : (ctx.now - t) / 60e3;
        return age != null && age <= I.THRESHOLDS.stale_minutes && r.market.stale !== true ? null : { evidence: { claim: 'current', age_minutes: age == null ? null : Math.round(age) },
          explanation: 'A surface calls the market line current, but it is ' + (age == null ? 'of unknown age' : CALC.fmt.age(age)) + '.', remediation: 'Re-judge freshness at render time from the capture time.' };
      } },
    { id: 'MKT.EVENT_MATCH', group: 'market', title: 'The quote belongs to this game, in this orientation', at: ALL_BLOCK,
      check: function (r) {
        if (!r.market.available) return null;
        if (r.market.mapping_ok === false || r.market.orientation_ok === false) return { evidence: { mapping_ok: r.market.mapping_ok, orientation_ok: r.market.orientation_ok }, explanation: 'The market line could not be matched to this game, or its home/away orientation disagrees with the schedule.', remediation: 'Re-join the event by game id and team ids; re-sign the line to the schedule’s home team.' };
        return null;
      } },
    { id: 'MKT.MAIN_LINE', group: 'market', title: 'Main line compared with main line', at: ALL_BLOCK,
      check: function (r) {
        if (!r.market.available) return null;
        if (r.market.is_main_line === false) return { evidence: { is_main_line: false, market_type: r.market.market_type }, explanation: 'The comparison line is an alternate line; it cannot be compared with the model’s fair line or a main-line consensus.', remediation: 'Compare equivalent markets only: main spread vs fair spread.' };
        if (r.market.market_type && r.comparison && r.comparison.market_type && r.market.market_type !== r.comparison.market_type) return { evidence: { market_type: r.market.market_type, comparison: r.comparison.market_type }, explanation: 'Different market types are being compared.', remediation: 'Compare equivalent markets only.' };
        return null;
      } },
    { id: 'MKT.FAULT', group: 'market', title: 'No market fault', at: DASH_WARN,
      check: function (r) {
        var f = r.market.fault || (r.research && r.research.key === 'MARKET_FAULT' ? (r.research.reason || 'MARKET FAULT') : null);
        return f ? { evidence: { fault: f }, explanation: 'The market data is faulted: ' + f + ' It is not verified market consensus.', remediation: 'Quarantine for validation; keep it out of decisions and anything publisher-facing until cleared.' } : null;
      } },
    { id: 'MKT.QUARANTINE', group: 'market', title: 'No quarantined quote inside the consensus', at: DASH_WARN,
      check: function (r) {
        var q = r.market.quarantined_in_consensus || [];
        return q.length ? { evidence: { quarantined: q.slice(0, 5) }, explanation: q.length + ' quarantined quote' + (q.length === 1 ? ' is' : 's are') + ' inside the consensus.', remediation: 'Rebuild the consensus from clean quotes only.' } : null;
      } },
    { id: 'MKT.BOOK', group: 'market', title: 'A quoted price names its sportsbook', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'AI_CONTEXT'], [], 'BLOCK'),
      check: function (r) { if (!r.market.available) return null; return r.market.book || r.market.method === 'MEDIAN' || (r.market.reference && r.market.source) ? null : { evidence: { book: r.market.book, source: r.market.source }, explanation: 'The market line names no sportsbook or consensus method.', remediation: 'Attribute every quoted line to its book (or to "consensus of N books").' }; } },

    /* --------------------------------------------------------- CALCULATION */
    { id: 'CALC.GAP_RECONCILES', group: 'calculation', title: 'The displayed gap reconciles with the displayed lines', at: ALL_BLOCK,
      check: function (r) {
        var d = r.displayed || {}, c = r.comparison;
        if (!c || !c.available) return null;
        var bad = [];
        if (num(d.gap) != null && CALC.round(d.gap, 1) !== c.gap) bad.push('a gap of ' + fixed(CALC.round(d.gap, 1)) + ' is shown, but the displayed lines give ' + c.reconcile.formula);
        if (d.fair_text && d.fair_text !== c.model.text) bad.push('fair line "' + d.fair_text + '" vs "' + c.model.text + '"');
        if (d.market_text && String(d.market_text).replace(/ \(stale\)$/, '') !== c.market.text) bad.push('market "' + d.market_text + '" vs "' + c.market.text + '"');
        return bad.length ? { evidence: { displayed: { fair: d.fair_text, market: d.market_text, gap: d.gap }, canonical: { fair: c.model.text, market: c.market.text, gap: c.gap, formula: c.reconcile.formula } },
          explanation: 'What the surface shows does not reconcile: ' + bad.join('; ') + '.', remediation: 'Render the fair line, the market line and the gap from EDCalc.spreadComparison.' } : null;
      } },
    { id: 'CALC.SNAPSHOT_IDS', group: 'calculation', title: 'Model and market snapshot ids travel with the comparison', at: at([], ['RESEARCH_DASHBOARD', 'BETTING_DECISION', 'PUBLIC_BRIEF', 'AI_CONTEXT'], [], 'BLOCK'),
      check: function (r) { if (!r.comparison || !r.comparison.available) return null; return r.comparison.model_snapshot_id && r.comparison.market_snapshot_id ? null : { evidence: { model: r.comparison.model_snapshot_id, market: r.comparison.market_snapshot_id }, explanation: 'The comparison cannot be traced to the two snapshots it was computed from.', remediation: 'Carry both snapshot ids.' }; } },

    /* ------------------------------------------------------------ DECISION */
    { id: 'DEC.EV_PAIR', group: 'decision', title: 'Raw and calibrated EV of one layer describe the same bet', at: DASH_WARN,
      check: function (r) {
        var e = r.ev; if (!e) return null;
        var bad = [];
        [['raw', 'calibrated'], ['quote_raw', 'quote_calibrated']].forEach(function (p) {
          if (e[p[0]] && e[p[1]]) { var pr = CALC.evPair(e[p[0]], e[p[1]]); if (!pr.comparable) bad.push(pr.reason); }
        });
        return bad.length ? { evidence: { pairs: bad }, explanation: 'Raw and calibrated EV were computed for different selections: ' + bad[0] + '.',
          remediation: 'Recompute both EVs on one selection (EDCalc.evPair).' } : null;
      } },
    /* the two EV layers (the EV engine's calibrated selection, quote EV's best
       raw quote) may legitimately choose different sides; printing them as ONE
       pair is what is wrong. WARNING everywhere; BLOCKED when a surface says it
       prints them together (displayed.ev_pair). */
    { id: 'DEC.EV_LAYERS', group: 'decision', title: 'EV figures from different layers are never printed as one bet', at: WARN_ALL,
      check: function (r) {
        var e = r.ev; if (!e || !e.quote_raw || !e.calibrated) return null;
        var x = CALC.evPair(e.quote_raw, e.calibrated);
        if (x.comparable) return null;
        var printed = !!(r.displayed && r.displayed.ev_pair);
        return { escalate: printed, evidence: { best_raw: selText(e.quote_raw.selection), raw_ev: e.quote_raw.ev, calibrated_selection: selText(e.calibrated.selection), calibrated_ev: e.calibrated.ev, printed_together: printed },
          explanation: 'The best raw quote (' + selText(e.quote_raw.selection) + ', raw ' + CALC.fmt.ev(e.quote_raw.ev) + ') and the calibrated selection (' + selText(e.calibrated.selection) + ', calibrated ' + CALC.fmt.ev(e.calibrated.ev) + ') are different bets' + (printed ? ', and a surface prints them as one.' : '; each must be shown beside its own selection.'),
          remediation: 'Print each EV beside its own selection; never "raw X% / calibrated Y%" across two selections.' };
      } },
    { id: 'DEC.CALIBRATION', group: 'decision', title: 'An actionable decision rests on a validated probability', at: at(['BETTING_DECISION'], ['RESEARCH_DASHBOARD'], [], 'WARN'),
      check: function (r) {
        var e = r.ev, d = r.decision, q = I.calibrationQuality(e && e.calibration);
        var actionable = d && /^(BET|LEAN)$/.test(String((d.bettor && d.bettor.decision) || d.key || ''));
        if (q.state === 'VALIDATED') return null;
        if (!actionable && q.state !== 'DEGENERATE') return null;
        return { evidence: { calibration_state: q.state, oof: q.oof, decision: d ? (d.bettor && d.bettor.decision) || d.key : null }, explanation: q.text + (actionable ? ' A ' + ((d.bettor && d.bettor.decision) || d.key) + ' cannot rest on it.' : ''),
          remediation: 'Present EV as research only; no BET or LEAN on an unvalidated probability.' };
      } },
    { id: 'DEC.RAW_EV_NOT_EDGE', group: 'decision', title: 'Raw model EV is never labelled an actionable edge', at: ALL_BLOCK,
      check: function (r) {
        var d = r.displayed || {}, e = r.ev;
        if (!d.edge_claim || !e) return null;
        var q = I.calibrationQuality(e.calibration), cal = e.calibrated ? e.calibrated.ev : (e.quote_calibrated ? e.quote_calibrated.ev : null);
        return q.state !== 'VALIDATED' || cal == null || cal <= 0 ? { evidence: { claim: d.edge_claim, calibrated_ev: cal, calibration: q.state }, explanation: 'A surface calls a raw model EV an edge, but ' + (cal != null && cal <= 0 ? 'the calibrated EV is ' + CALC.fmt.ev(cal) : 'the calibration is ' + q.state) + '.', remediation: 'Remove the edge claim; show raw EV only as an unvalidated research number.' } : null;
      } },
    { id: 'DEC.RESEARCH_IS_NOT_DECISION', group: 'decision', title: 'A BET comes only from the decision engine', at: ALL_BLOCK,
      check: function (r) {
        var d = r.decision; if (!d) return null;
        var cls = (d.bettor && d.bettor.decision) || d.key;
        if (cls === 'BET' && !(d.bettor || d.engine_status)) return { evidence: { decision: cls }, explanation: 'A BET without a decision-engine verdict behind it.', remediation: 'Only lib/edgedesk_decision.js may produce BET.' };
        return null;
      } }
  ];
  function selText(s) { if (!s) return '?'; return (s.side || '?') + ' ' + (num(s.line) == null ? '' : (s.line > 0 ? '+' : '') + s.line) + ' ' + (num(s.american) == null ? '' : CALC.fmt.american(s.american)) + (s.book ? ' @ ' + s.book : ''); }
  I.RULES = RULES.map(function (x) { return { id: x.id, group: x.group, title: x.title, at: x.at }; });

  var SEVERITY = { BLOCK: 'HIGH', WARN: 'MEDIUM', PASS: 'INFO' };
  var CRITICAL = { 'SCHED.REAL_EVENT': 1, 'PROJ.PROBABILITIES': 1, 'PROJ.DIRECTION': 1, 'MKT.EVENT_MATCH': 1, 'CALC.GAP_RECONCILES': 1, 'DEC.RAW_EV_NOT_EDGE': 1 };

  /* ============================================================ EVALUATE */
  I.evaluate = function (rec, boundary, ctx) {
    ctx = ctx || {};
    boundary = boundary || 'RESEARCH_DASHBOARD';
    if (BOUNDARIES.indexOf(boundary) < 0) throw new Error('unknown boundary ' + boundary);
    var c2 = { now: ctx.now == null ? Date.now() : ctx.now, current_week: ctx.current_week || null, target_week: ctx.target_week || null, champion: ctx.champion || null };
    var checks = [];
    RULES.forEach(function (rule) {
      var mode = has(rule.at, boundary) ? rule.at[boundary] : rule.at._default;
      if (mode === 'OFF') return;
      var res = null;
      try { res = rule.check(rec, c2); } catch (e) { res = { evidence: { error: String(e && e.message || e) }, explanation: 'The check could not run: ' + String(e && e.message || e) + '. Unknown is not PASS.', remediation: 'Fix the record shape.' }; }
      /* res.soft: a condition stated, never a block (an unpublished score); res.escalate: a warning that becomes a block */
      var status = res ? (res.soft ? 'WARNING' : (mode === 'BLOCK' || res.escalate ? 'BLOCKED' : 'WARNING')) : 'PASS';
      checks.push({ rule_id: rule.id, group: rule.group, title: rule.title, boundary: boundary, status: status,
        severity: status === 'PASS' ? 'INFO' : (status === 'BLOCKED' && CRITICAL[rule.id] ? 'CRITICAL' : SEVERITY[mode]),
        record: { record_id: rec.record_id, game_id: rec.game.game_id, matchup: (rec.game.away || '?') + ' @ ' + (rec.game.home || '?') },
        evidence: res ? res.evidence : null, explanation: res ? res.explanation : null, remediation: res ? res.remediation : null });
    });
    /* DECISION INTEGRITY: a fault that affects actionability caps the decision */
    if (boundary === 'BETTING_DECISION') {
      var d = rec.decision, cls = d ? ((d.bettor && d.bettor.decision) || d.key) : null;
      var faults = checks.filter(function (c) { return c.status === 'BLOCKED' && c.group !== 'decision'; });
      if (cls && /^(BET|LEAN|WATCH|WAIT)$/.test(cls) && faults.length)
        checks.push({ rule_id: 'DEC.INTEGRITY_FAULT', group: 'decision', title: 'No integrity fault under an actionable decision', boundary: boundary, status: 'BLOCKED', severity: 'CRITICAL',
          record: { record_id: rec.record_id, game_id: rec.game.game_id, matchup: (rec.game.away || '?') + ' @ ' + (rec.game.home || '?') },
          evidence: { decision: cls, faults: faults.map(function (f) { return f.rule_id; }) },
          explanation: 'The decision reads ' + cls + ' while ' + faults.map(function (f) { return f.rule_id; }).join(', ') + ' block it.', remediation: 'Show NO DECISION with the blocking rule until the fault clears.' });
    }
    var blocked = checks.filter(function (c) { return c.status === 'BLOCKED'; }), warn = checks.filter(function (c) { return c.status === 'WARNING'; });
    return { version: I.VERSION, boundary: boundary, record_id: rec.record_id, game_id: rec.game.game_id, evaluated_at: new Date(c2.now).toISOString(),
      status: blocked.length ? 'BLOCKED' : (warn.length ? 'WARNING' : 'PASS'), ok: !blocked.length,
      checks: checks, blocking: blocked, warnings: warn,
      blocking_reasons: blocked.map(function (c) { return c.rule_id + ': ' + c.explanation; }) };
  };
  /* a set of records: per-record results plus set-level rules (duplicates) */
  I.evaluateSet = function (recs, boundary, ctx) {
    var res = (recs || []).map(function (r) { return I.evaluate(r, boundary, ctx); });
    var seen = {};
    (recs || []).forEach(function (r, i) {
      var key = [String(r.game.home || '').toLowerCase(), String(r.game.away || '').toLowerCase(), r.kickoff.game_date || ''].join('|');
      var key2 = [String(r.game.away || '').toLowerCase(), String(r.game.home || '').toLowerCase(), r.kickoff.game_date || ''].join('|');
      var prev = has(seen, key) ? seen[key] : (has(seen, key2) ? seen[key2] : null);
      if (prev != null && recs[prev].game.game_id !== r.game.game_id) {
        var chk = { rule_id: 'SCHED.DUPLICATE_GAME', group: 'schedule', title: 'No accidental duplicate game', boundary: boundary, status: 'BLOCKED', severity: 'HIGH',
          record: { record_id: r.record_id, game_id: r.game.game_id, matchup: r.game.away + ' @ ' + r.game.home },
          evidence: { other_game_id: recs[prev].game.game_id, game_date: r.kickoff.game_date },
          explanation: 'The same matchup on the same date appears under two game ids (' + recs[prev].game.game_id + ', ' + r.game.game_id + ').', remediation: 'Keep the schedule’s canonical id; drop the duplicate.' };
        res[i].checks.push(chk); res[i].blocking.push(chk); res[i].status = 'BLOCKED'; res[i].ok = false; res[i].blocking_reasons.push(chk.rule_id + ': ' + chk.explanation);
      } else seen[key] = i;
    });
    var tally = { PASS: 0, WARNING: 0, BLOCKED: 0 };
    res.forEach(function (x) { tally[x.status]++; });
    return { version: I.VERSION, boundary: boundary, results: res, counts: tally };
  };

  /* the one sentence on why research status and decision differ */
  I.whyDiffer = function (researchKey, decisionClass, decisionReason) {
    var rk = researchKey || 'NONE', cls = decisionClass || 'NO_DECISION';
    if (rk === 'WORTH_RESEARCHING' && cls === 'PASS') return 'The gap is big enough to research, but the price fails the decision rules: research interest is not a profitable bet.';
    if (rk === 'WORTH_RESEARCHING' && cls === 'NO_DECISION') return 'Research compares EdgeDesk with the consensus line; the decision needs a fresh two-sided priced quote and found none, so it could not evaluate a bet.';
    if (rk === 'INVESTIGATE' && (cls === 'WATCH' || cls === 'WAIT')) return 'The gap is large but unverified; the decision layer caps anything unverified at WATCH until the data is checked.';
    if (rk === 'INVESTIGATE' && cls === 'PASS') return 'The gap is large enough to investigate but has not been verified, and the price fails the decision rules; an unverified gap is a question about the data, not a bet.';
    if ((rk === 'MARKET_ALIGNED' || rk === 'NEAR_PICKEM') && cls === 'PASS') return 'EdgeDesk agrees with the market, so there is no disagreement to price and the decision rules find nothing to approve.';
    if ((rk === 'MARKET_ALIGNED' || rk === 'NEAR_PICKEM') && (cls === 'WATCH' || cls === 'WAIT')) return 'EdgeDesk agrees with the market line; the WATCH is about one book’s price, not about a disagreement.';
    if (rk === 'NO_MARKET' && cls === 'NO_DECISION') return 'There is no current price, so there is nothing to research against and nothing to decide on.';
    if (cls === 'BET') return 'The decision engine approved this exact price; the research status describes the matchup, not the bet.';
    if (cls === 'NO_DECISION') return 'No decision was possible: ' + (decisionReason || 'essential data is missing') + '.';
    return 'Research status describes how interesting the matchup is; the decision describes whether this price passes the betting rules. They answer different questions.';
  };

  /* ================================================ TWO CLASSIFICATIONS
     Research status ("is this worth investigating?") and decision status
     ("do the decision rules approve this exact price?"), each with the rules
     that passed and failed, and one sentence on why they differ. */
  I.explainStatuses = function (rec, ctx) {
    ctx = ctx || {};
    var R = rec.research || {}, D = rec.decision || {}, c = rec.comparison || {};
    var cls = (D.bettor && D.bettor.decision) || D.key || 'NO_DECISION';
    var gap = c.available ? c.gap : null;
    var rel = rec.model.reliability, conf = rec.model.confidence;
    var rows = [];
    function row(rule, pass, detail) { rows.push({ rule: rule, pass: pass, detail: detail }); }
    row('EdgeDesk has a projection', !!rec.model.available, rec.model.available ? rec.model.version : 'none');
    row('a market line is on file', !!rec.market.available, rec.market.available ? c.market.text : 'none');
    if (rec.market.available) {
      var age = ms(rec.market.captured_at) == null ? null : ((ctx.now == null ? Date.now() : ctx.now) - ms(rec.market.captured_at)) / 60e3;
      row('the market line is current (≤ ' + I.THRESHOLDS.stale_minutes + ' min)', rec.market.stale === false && age != null && age <= I.THRESHOLDS.stale_minutes, CALC.fmt.age(age));
    }
    if (gap != null) {
      row('the gap reaches the 2-pt research threshold', gap >= 2, CALC.fmt.gap(gap) + ' (' + c.reconcile.formula + ')');
      if (gap >= 7) row('a 7+ gap passed the integrity gate', R.key === 'VERIFIED_MAJOR', R.key === 'VERIFIED_MAJOR' ? 'verified' : (R.reason || 'not verified'));
    }
    row('football confidence ≥ 35', conf != null && conf >= 35, conf == null ? 'unmeasured' : Math.round(conf) + '/100');
    row('reliability ≥ 60', rel != null && rel >= 60, rel == null ? 'unmeasured' : Math.round(rel) + '/100');
    (R.flags || []).forEach(function (f) { if (f.key === 'REGIME_CHANGE') row('no regime change blocks research', false, (f.teams || []).map(function (t) { return t.team + ' ' + t.games_played + '/' + t.min_games + ' games'; }).join('; ')); });

    var drows = [];
    function drow(rule, pass, detail) { drows.push({ rule: rule, pass: pass, detail: detail }); }
    var bettor = D.bettor || null;
    drow('a fresh two-sided priced quote', !/no fresh|stale|no market|not priced/i.test(String(D.reason || '')) && rec.market.stale === false, D.reason || null);
    var e = rec.ev, q = I.calibrationQuality(e && e.calibration);
    if (e && e.calibrated) drow('calibrated EV > 0 at this exact price', e.calibrated.ev > 0, CALC.fmt.ev(e.calibrated.ev) + ' on ' + selText(e.calibrated.selection));
    drow('the probability is validated', q.state === 'VALIDATED', q.state);
    drow('betting is enabled by policy', ctx.bet_enabled === true, ctx.bet_enabled === true ? 'enabled' : 'disabled (frozen policy)');
    var rk = R.key || 'NONE';
    var why = I.whyDiffer(rk, cls, D.reason);
    return { research: { status: rk, label: R.label || rk, rule: R.rule || null, reason: R.reason || null, rules: rows,
        means: 'How useful further investigation would be. It is never a bet signal.' },
      decision: { status: cls, label: bettor && bettor.label ? bettor.label : (D.label || cls), reason: D.reason || null, rules: drows,
        means: 'Whether the existing decision rules approve this exact market and price.' },
      why_differ: why };
  };

  /* ================================================ WHY A RAW EDGE IS REJECTED */
  I.explainEv = function (rec) {
    var e = rec && rec.ev;
    if (!e) return { text: 'No EV was computed for this game.', rejected: null };
    var raw = e.quote_raw || e.raw, cal = raw === e.quote_raw ? e.quote_calibrated : e.calibrated;
    var q = I.calibrationQuality(e.calibration);
    if (!raw) return { text: 'No raw EV: no priced quote.', rejected: null, calibration: q };
    var parts = ['Raw EV ' + CALC.fmt.ev(raw.ev) + ' on ' + selText(raw.selection) + ' comes from EdgeDesk’s own cover probability (' + CALC.fmt.prob(raw.p) + ').'];
    if (cal) parts.push('Calibrated, the same bet is ' + CALC.fmt.ev(cal.ev) + '.');
    parts.push(q.text);
    var rejected = raw.ev > 0 && (!cal || cal.ev <= 0 || q.state !== 'VALIDATED');
    if (rejected) parts.push('A raw edge the model has not shown it can earn is not an edge, so it is not actionable.');
    var pair = cal ? CALC.evPair(raw, cal) : null;
    if (pair && !pair.comparable) parts.push('(The calibrated figure on file belongs to a different selection and is not shown beside it.)');
    return { text: parts.join(' '), rejected: rejected, calibration: q, raw: raw, calibrated: cal };
  };

  /* ======================================================= BOARD COUNTS
     Every count says what it counts, and the counts reconcile. rows:
     { research_key, research_rule, market_state: 'FRESH'|'STALE'|'FAULT'|'NONE', scope } */
  I.COUNT_DEFINITIONS = {
    displayed: 'every pregame game the board lists',
    current_week: 'games in the current week (the schedule’s own week)',
    future_week: 'look-ahead games from a later week',
    market_usable: 'a current, unfaulted market line is joined',
    market_stale: 'only a line older than the freshness rule is on file',
    market_faulted: 'the joined line is faulted (MARKET FAULT / DATA FAULT): not verified consensus',
    no_market: 'no line is joined',
    research_grade: 'cleared every research gate: WORTH RESEARCHING or VERIFIED MAJOR',
    investigate: 'a 7+ point gap that has not cleared the integrity gate',
    aligned: 'MARKET ALIGNED or NEAR PICK’EM',
    limited: 'LIMITED DATA (no projection, thin confidence or reliability)'
  };
  I.countBoard = function (rows) {
    var c = { displayed: 0, current_week: 0, future_week: 0, other_week: 0, market_usable: 0, market_stale: 0, market_faulted: 0, no_market: 0,
      research_grade: 0, investigate: 0, aligned: 0, limited: 0, data_fault: 0, market_fault: 0, no_market_status: 0, kickoff_unverified: 0 };
    (rows || []).forEach(function (r) {
      c.displayed++;
      if (r.scope === 'CURRENT_WEEK') c.current_week++; else if (r.scope === 'FUTURE_WEEK') c.future_week++; else c.other_week++;
      if (r.market_state === 'FRESH') c.market_usable++; else if (r.market_state === 'STALE') c.market_stale++; else if (r.market_state === 'FAULT') c.market_faulted++; else c.no_market++;
      var k = r.research_key;
      if (k === 'WORTH_RESEARCHING' || k === 'VERIFIED_MAJOR') c.research_grade++;
      else if (k === 'INVESTIGATE') c.investigate++;
      else if (k === 'MARKET_ALIGNED' || k === 'NEAR_PICKEM') c.aligned++;
      else if (k === 'LIMITED_DATA') c.limited++;
      else if (k === 'DATA_FAULT') c.data_fault++;
      else if (k === 'MARKET_FAULT') c.market_fault++;
      else c.no_market_status++;
      if (r.kickoff_verified === false) c.kickoff_unverified++;
    });
    c.reconciles = {
      by_market: c.market_usable + c.market_stale + c.market_faulted + c.no_market === c.displayed,
      by_week: c.current_week + c.future_week + c.other_week === c.displayed,
      by_research: c.research_grade + c.investigate + c.aligned + c.limited + c.data_fault + c.market_fault + c.no_market_status === c.displayed
    };
    c.definitions = I.COUNT_DEFINITIONS;
    return c;
  };

  return I;
});
// ── lib/edgedesk_broadcast.js
/* ===========================================================================
   EdgeDesk — BROADCAST AND SCHEDULE VERIFICATION (EDBroadcast)
   docs/content-engine/GAMES_TO_WATCH.md §Broadcasts

   "Where to watch" is a factual claim, so it is verified like one. A network
   is printed only with the source that verified it and the time it was
   verified; anything less is held, never guessed.

   SOURCES, in the order they are trusted
     OWNER_VERIFIED   the owner recorded the network from an official source
                      (a conference schedule, a school athletics site, the
                      network's own release) with its URL, in /admin/content/
     OFFICIAL_NETWORK ESPN's public scoreboard listing a network ESPN itself
                      operates (ABC, ESPN, ESPN2, ESPNU, ESPNEWS, SEC Network,
                      ACC Network, ESPN+): the rights holder's own listing
     CORROBORATED     two independent listings agree
     LISTED           a single third-party listing (ESPN's scoreboard naming
                      CBS, FOX, NBC, Big Ten Network, The CW …): useful, NOT
                      confirmation — the article is held until the owner
                      verifies it or a second listing agrees
     NONE             nothing on file

   STATUS (what the article may do)
     CONFIRMED        print the network, its streaming options, the source and
                      the verification time
     TENTATIVE        held: a listing exists but is not confirmed
     CONFLICT         held: two sources disagree on the network or the time
     CHANGED          held: the listing changed after it was verified (flex
                      scheduling, a regional split) — re-verify
     STALE            held: verified, but not inside the revalidation window
     POSTPONED / CANCELED   the game is withdrawn from the article
     UNVERIFIED       held: no listing at all

   STREAMING. A streaming option is printed only when (a) the source listed it
   for this game, or (b) it is the verified network's OWN live-streaming
   service (NETWORK_SERVICE in STREAMING below), described as exactly that —
   "CBS games stream live on Paramount+" — never as a game-specific claim.

   Time zones: the instant is UTC (EDSchedule); Eastern and Central are
   formatted from it with their own DST rules, never by a fixed offset.

   Browser: window.EDBroadcast. Node: require('./edgedesk_broadcast.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDBroadcast = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var B = { VERSION: 'edgedesk_broadcast/1' };

  B.CONFIG = {
    /* a verification older than this before publication is revalidated */
    revalidate_hours: 24,
    /* inside this many hours of kickoff, a verification must be this fresh */
    gameweek_hours: 72, gameweek_revalidate_hours: 12,
    /* a source time this far from the schedule's is a conflict */
    time_tolerance_minutes: 5
  };

  /* networks ESPN operates: its scoreboard listing one of these is the
     rights holder's own listing */
  var ESPN_FAMILY = ['ABC', 'ESPN', 'ESPN2', 'ESPNU', 'ESPNEWS', 'SEC Network', 'ACC Network', 'ESPN+', 'SEC Network+', 'ACC Network Extra'];
  var ALIASES = {
    'SECN': 'SEC Network', 'SEC NETWORK': 'SEC Network', 'ACCN': 'ACC Network', 'ACC NETWORK': 'ACC Network', 'ESPN+': 'ESPN+', 'ESPN PLUS': 'ESPN+',
    'SECN+': 'SEC Network+', 'ACCNX': 'ACC Network Extra', 'BTN': 'Big Ten Network', 'BIG TEN NETWORK': 'Big Ten Network', 'FS1': 'FS1', 'FS2': 'FS2',
    'CBSSN': 'CBS Sports Network', 'CBS SPORTS NETWORK': 'CBS Sports Network', 'CW': 'The CW', 'THE CW': 'The CW', 'CW NETWORK': 'The CW',
    'ABC': 'ABC', 'ESPN': 'ESPN', 'ESPN2': 'ESPN2', 'ESPNU': 'ESPNU', 'ESPNEWS': 'ESPNEWS', 'CBS': 'CBS', 'FOX': 'FOX', 'NBC': 'NBC',
    'PEACOCK': 'Peacock', 'TRUTV': 'truTV', 'TNT': 'TNT', 'TBS': 'TBS', 'NFL NETWORK': 'NFL Network', 'NFLN': 'NFL Network', 'AMAZON PRIME VIDEO': 'Prime Video',
    'PRIME VIDEO': 'Prime Video', 'NETFLIX': 'Netflix', 'YOUTUBE': 'YouTube', 'PARAMOUNT+': 'Paramount+'
  };
  B.normalizeNetwork = function (name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return null;
    var k = s.toUpperCase().replace(/\s+/g, ' ');
    return ALIASES[k] || s;
  };
  B.espnOperated = function (network) { return ESPN_FAMILY.indexOf(B.normalizeNetwork(network)) >= 0; };

  /* THE NETWORK'S OWN LIVE-STREAMING SERVICE (reviewed 2026-10). Only
     services the network itself runs or names for live games; a network not
     listed here gets no streaming line. The owner reviews this table each
     season (docs/content-engine/GAMES_TO_WATCH.md). */
  B.STREAMING = {
    ABC: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPN: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPN2: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    ESPNU: { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'SEC Network': { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'ACC Network': { service: 'the ESPN app', note: 'with a participating TV provider or an ESPN subscription', url: 'https://www.espn.com/watch/' },
    'ESPN+': { service: 'ESPN+', note: 'a streaming-only broadcast in the ESPN app', url: 'https://www.espn.com/watch/' },
    CBS: { service: 'Paramount+', note: 'plans that include live CBS', url: 'https://www.paramountplus.com/' },
    NBC: { service: 'Peacock', note: 'a Peacock subscription', url: 'https://www.peacocktv.com/' },
    Peacock: { service: 'Peacock', note: 'a streaming-only broadcast on Peacock', url: 'https://www.peacocktv.com/' }
  };

  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function uniq(a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }

  /* ======================================================== ESPN PARSER
     One public scoreboard payload (site.api.espn.com … /scoreboard) → one
     LISTING per event: the date ESPN carries, whether its time is valid
     (timeValid false = TBA), the game status, the venue, and every TV and
     streaming outlet by market (national, home, away). Nothing is inferred:
     a field ESPN does not carry stays null. */
  B.parseEspnScoreboard = function (payload, retrievedAt, sourceUrl) {
    var out = {};
    var evs = (payload && payload.events) || [];
    evs.forEach(function (e) {
      if (!e || !e.id) return;
      var c = (e.competitions && e.competitions[0]) || {};
      var st = (c.status && c.status.type) || (e.status && e.status.type) || {};
      var outlets = [];
      (c.geoBroadcasts || []).forEach(function (g) {
        var name = g && g.media && (g.media.shortName || g.media.name);
        if (!name) return;
        outlets.push({ network: B.normalizeNetwork(name), type: g.type && g.type.shortName ? String(g.type.shortName) : null,
          market: g.market && g.market.type ? String(g.market.type).toLowerCase() : null, region: g.region || null });
      });
      if (!outlets.length) (c.broadcasts || []).forEach(function (b) {
        (b.names || []).forEach(function (n) { outlets.push({ network: B.normalizeNetwork(n), type: 'TV', market: b.market ? String(b.market).toLowerCase() : null, region: null }); });
      });
      var comp = (c.competitors || []);
      var home = comp.filter(function (x) { return x.homeAway === 'home'; })[0], away = comp.filter(function (x) { return x.homeAway === 'away'; })[0];
      out[String(e.id)] = {
        game_id: String(e.id), source: { name: 'ESPN scoreboard', kind: 'listing', url: sourceUrl || null, operator: 'ESPN' },
        retrieved_at: iso(retrievedAt) || null,
        kickoff: iso(c.date || e.date), time_valid: c.timeValid === false ? false : (c.timeValid === true ? true : null),
        status: st.name || null, status_detail: st.detail || st.shortDetail || st.description || null,
        home: home && home.team ? home.team.location || home.team.displayName : null, away: away && away.team ? away.team.location || away.team.displayName : null,
        venue: c.venue ? { name: c.venue.fullName || null, city: c.venue.address ? c.venue.address.city || null : null, state: c.venue.address ? c.venue.address.state || null : null } : null,
        outlets: outlets
      };
    });
    return out;
  };

  /* ===================================================== VERIFICATION
     listing  one game's ESPN listing (parseEspnScoreboard) or null
     owner    the owner's verification row, or null:
              { network, streaming, source_url, source_kind, source_name,
                verified_at, kickoff (a verified changed kickoff), reason,
                status ('postponed' | 'canceled' | null) }
     schedule the game's schedule truth: { kickoff (ISO), kickoff_verified }
     → the record an article reads */
  var STATUS_WITHDRAWN = { STATUS_POSTPONED: 'POSTPONED', STATUS_CANCELED: 'CANCELED', STATUS_CANCELLED: 'CANCELED', STATUS_FORFEIT: 'CANCELED' };
  B.verify = function (gameId, listing, owner, schedule) {
    schedule = schedule || {};
    var rec = { schema: 'edgedesk_broadcast_v1', version: B.VERSION, game_id: String(gameId), status: 'UNVERIFIED', tier: 'NONE',
      network: null, networks: [], regional: [], streaming: [], source: null, verified_at: null, verified_by: null,
      kickoff: schedule.kickoff || null, kickoff_source: schedule.kickoff ? 'schedule feed' : null, schedule_change: null,
      problems: [], listing: listing || null };
    var natTV = [], natStream = [], regional = [];
    if (listing) (listing.outlets || []).forEach(function (o) {
      if (!o.network) return;
      var tv = !o.type || /tv/i.test(o.type), stream = /stream/i.test(o.type || ''), nat = !o.market || o.market === 'national';
      if (/radio/i.test(o.type || '')) return;
      if (nat && tv) natTV.push(o.network); else if (nat && stream) natStream.push(o.network); else if (tv) regional.push({ network: o.network, market: o.market });
    });
    natTV = uniq(natTV); natStream = uniq(natStream);
    var withdrawn = listing && STATUS_WITHDRAWN[listing.status];
    if (owner && /postpon/i.test(owner.status || '')) withdrawn = 'POSTPONED';
    if (owner && /cancel/i.test(owner.status || '')) withdrawn = 'CANCELED';
    /* the network */
    if (owner && present(owner.network)) {
      rec.network = B.normalizeNetwork(owner.network); rec.tier = 'OWNER_VERIFIED';
      rec.source = { name: owner.source_name || owner.source_kind || 'owner verification', kind: owner.source_kind || 'official', url: owner.source_url || null };
      rec.verified_at = iso(owner.verified_at); rec.verified_by = 'owner';
      if (!present(owner.source_url)) rec.problems.push({ code: 'NO_SOURCE_URL', text: 'the owner verification carries no source URL' });
      if (natTV.length && natTV.indexOf(rec.network) < 0) {
        var listedAfter = listing && ms(listing.retrieved_at) != null && ms(owner.verified_at) != null && ms(listing.retrieved_at) > ms(owner.verified_at);
        rec.problems.push({ code: listedAfter ? 'LISTING_CHANGED' : 'LISTING_DIFFERS', text: 'ESPN’s scoreboard lists ' + natTV.join(' / ') + (listedAfter ? ', after the owner verified ' + rec.network : '') });
      }
    } else if (natTV.length || natStream.length) {
      /* a streaming-only national broadcast (ESPN+, Peacock) is the network */
      var nets = natTV.length ? natTV : natStream;
      rec.network = nets[0];
      rec.tier = nets.every(B.espnOperated) ? 'OFFICIAL_NETWORK' : 'LISTED';
      rec.source = listing.source; rec.verified_at = listing.retrieved_at; rec.verified_by = 'feed';
      if (nets.length > 1) rec.networks = nets.slice();
      if (!natTV.length) natStream = [];
    }
    rec.networks = rec.networks.length ? rec.networks : (rec.network ? [rec.network] : []);
    rec.regional = regional;
    /* streaming: listed for this game, else the verified network's own service */
    natStream.forEach(function (s) { rec.streaming.push({ service: s, basis: 'LISTED_FOR_GAME', note: null, url: null }); });
    if (owner && Array.isArray(owner.streaming)) owner.streaming.forEach(function (s) { if (s && present(s.service || s)) rec.streaming.push({ service: s.service || s, basis: 'OWNER_VERIFIED', note: s.note || null, url: s.url || null }); });
    if (rec.network && B.STREAMING[rec.network] && !rec.streaming.some(function (s) { return s.service === B.STREAMING[rec.network].service; })) {
      var S = B.STREAMING[rec.network];
      rec.streaming.push({ service: S.service, basis: 'NETWORK_SERVICE', note: S.note, url: S.url });
    }
    /* the time: an owner-verified change wins; a listing time that disagrees
       with the schedule is a conflict until someone verifies it */
    var schedMs = ms(schedule.kickoff);
    if (owner && present(owner.kickoff)) {
      rec.schedule_change = { from: iso(schedule.kickoff), to: iso(owner.kickoff), reason: owner.reason || null, source_url: owner.source_url || null, verified_at: iso(owner.verified_at) };
      rec.kickoff = iso(owner.kickoff); rec.kickoff_source = 'owner verification';
    } else if (listing && ms(listing.kickoff) != null && schedMs != null && listing.time_valid !== false
      && Math.abs(ms(listing.kickoff) - schedMs) > B.CONFIG.time_tolerance_minutes * 60e3) {
      rec.problems.push({ code: 'TIME_CONFLICT', text: 'ESPN’s scoreboard has the game at ' + iso(listing.kickoff) + ', the schedule at ' + iso(schedule.kickoff) });
    }
    if (listing && listing.time_valid === false && schedule.kickoff_verified) rec.problems.push({ code: 'TIME_TBA_AT_SOURCE', text: 'ESPN’s scoreboard marks the time as to be announced' });
    if (schedule.kickoff_verified === false && !(owner && present(owner.kickoff))) rec.problems.push({ code: 'KICKOFF_UNVERIFIED', text: 'the schedule has not confirmed a kickoff time' });
    /* the status */
    if (withdrawn) rec.status = withdrawn;
    else if (!rec.network) rec.status = 'UNVERIFIED';
    else if (rec.problems.some(function (p) { return p.code === 'LISTING_CHANGED'; })) rec.status = 'CHANGED';
    else if (rec.problems.some(function (p) { return p.code === 'LISTING_DIFFERS' || p.code === 'TIME_CONFLICT' || p.code === 'TIME_TBA_AT_SOURCE'; })) rec.status = 'CONFLICT';
    else if (rec.tier === 'LISTED') rec.status = 'TENTATIVE';
    else if (rec.problems.some(function (p) { return p.code === 'NO_SOURCE_URL' || p.code === 'KICKOFF_UNVERIFIED'; })) rec.status = 'TENTATIVE';
    else rec.status = 'CONFIRMED';
    return rec;
  };

  /* is a CONFIRMED record still fresh enough to publish at `at`? */
  B.fresh = function (rec, at, kickoff) {
    if (!rec || rec.status !== 'CONFIRMED') return { ok: false, reason: rec ? rec.status : 'UNVERIFIED' };
    var t = ms(rec.verified_at), when = ms(at) == null ? Date.now() : ms(at), k = ms(kickoff || rec.kickoff);
    if (t == null) return { ok: false, reason: 'NO_TIMESTAMP' };
    var limit = (k != null && k - when <= B.CONFIG.gameweek_hours * 3600e3) ? B.CONFIG.gameweek_revalidate_hours : B.CONFIG.revalidate_hours;
    var age = (when - t) / 3600e3;
    return age <= limit ? { ok: true, age_hours: Math.round(age * 10) / 10, limit_hours: limit }
      : { ok: false, reason: 'STALE', age_hours: Math.round(age * 10) / 10, limit_hours: limit };
  };

  /* may an article print this record as where to watch? */
  B.publishable = function (rec, at) {
    if (!rec) return { ok: false, reason: 'UNVERIFIED', text: 'no broadcast listing is on file' };
    if (rec.status === 'POSTPONED' || rec.status === 'CANCELED') return { ok: false, reason: rec.status, withdraw: true, text: 'the game is ' + rec.status.toLowerCase() };
    if (rec.status !== 'CONFIRMED') return { ok: false, reason: rec.status, text: B.STATUS_TEXT[rec.status] || rec.status };
    var f = B.fresh(rec, at);
    if (!f.ok) return { ok: false, reason: 'STALE', text: 'the broadcast was verified ' + f.age_hours + ' hours ago; it must be re-verified within ' + f.limit_hours + ' hours of publication' };
    return { ok: true, reason: null, text: null };
  };
  B.STATUS_TEXT = {
    UNVERIFIED: 'no broadcast listing is on file',
    TENTATIVE: 'a single third-party listing names the network; it is not confirmed',
    CONFLICT: 'two sources disagree on the network or the time',
    CHANGED: 'the listing changed after it was verified',
    STALE: 'the verification is too old for publication'
  };

  /* ====================================================== DISPLAY
     Eastern and Central times from the UTC instant, each with its own DST.
     Uses EDSchedule when present so there is one formatter. */
  function sched() { var G = typeof globalThis !== 'undefined' ? globalThis : {}; return G.EDSchedule || (typeof require === 'function' ? (function () { try { return require('./edgedesk_schedule.js'); } catch (e) { return null; } })() : null); }
  B.timesText = function (kickoffIso) {
    var S = sched(); if (!S || !kickoffIso) return null;
    var g = { kickoff: kickoffIso, start_time_tbd: false };
    var et = S.display(g, 'America/New_York'), ct = S.display(g, 'America/Chicago');
    if (!et.verified) return null;
    return { date: et.text.split(' · ')[0], et: et.clock + ' ' + et.zone_abbr, ct: ct.clock + ' ' + ct.zone_abbr, et_abbr: et.zone_abbr, ct_abbr: ct.zone_abbr };
  };
  /* "Watch: ABC · Stream: the ESPN app (with a participating TV provider or an
     ESPN subscription) · Verified Oct. 8, 5:00 PM ET (ESPN scoreboard)" */
  B.watchLine = function (rec) {
    if (!rec || rec.status !== 'CONFIRMED') return null;
    var s = rec.streaming.map(function (x) { return x.service + (x.basis === 'NETWORK_SERVICE' && x.note ? ' (' + x.note + ')' : ''); });
    return { tv: rec.networks.join(' / '), stream: s.length ? s.join('; ') : null, regional: rec.regional.length ? rec.regional.map(function (r) { return r.network + ' (' + r.market + ' market)'; }).join(', ') : null };
  };
  return B;
});
// ── lib/edgedesk_matchup.js
/* ===========================================================================
   EdgeDesk — THE EDITORIAL MATCHUP PACKET (EDMatchup)
   docs/content-engine/GAMES_TO_WATCH.md

   One verified research packet per game, built BEFORE any article is written,
   from what EdgeDesk already publishes:

     football/matchup/packet.js   measured pairings (each offence against the
                                  defence it meets, garbage time excluded,
                                  with sample sizes), the quarterback's
                                  measured season, position-group standings
     football/cfb_terminal        the champion projection, the market check,
                                  the integrity verdict, the model's inputs,
                                  its sensitivity and the other models' lines
     football/personnel           the conference's OFFICIAL availability report
     football/availability        the report's URL and publication time
     football/fbs_epa             every quarterback's game logs
     football/cfb_terminal/record.json, collective/settled
                                  verified final scores
     football/broadcasts          the broadcast listing, verified (EDBroadcast)

   It writes nothing a feed did not measure. Every fact carries its numbers,
   its source and whether a reader could check it independently: a count from
   the play-by-play, a final score or an official report is INDEPENDENT; a
   projection, a rating or an opponent-adjusted metric is EdgeDesk's ANALYSIS
   and never counts toward the two independent facts a featured game needs.

   THE REASONING GATE (M.gate) — six questions, each answered from the packet:
     1 why should a reader watch?   2 what matchup could decide it?
     3 what recent evidence?        4 what does EdgeDesk project?
     5 why might the model be wrong?  6 what should a viewer watch for?
   A game that cannot answer all six, with at least two independent facts that
   support the argument, is not featured.

   Browser: window.EDMatchup. Node: require('./edgedesk_matchup.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDMatchup = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var M = { VERSION: 'edgedesk_matchup_packet/1', SCHEMA: 'edgedesk_editorial_matchup_packet_v1' };

  function dep(name, file) {
    var G = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    if (G && G[name]) return G[name];
    if (typeof require === 'function') { try { return require('./' + file); } catch (e) { /* not in this host */ } }
    return null;
  }
  var CALC = dep('EDCalc', 'edgedesk_calc.js'), SCHED = dep('EDSchedule', 'edgedesk_schedule.js'),
    AVAIL = dep('EDAvailability', 'edgedesk_availability.js'), BC = dep('EDBroadcast', 'edgedesk_broadcast.js');

  M.CONFIG = {
    min_independent_facts: 2,
    /* a pairing sample below this is printed, never argued from */
    min_pair_n: 40,
    /* a genuine upset case needs the model to give the underdog at least this */
    upset_min_dog_prob: 0.25,
    /* "strength on strength": both units at least this many SD better than average */
    clash_z: 0.75,
    /* "mismatch": one side this many SD better than the other */
    mismatch_z: 1.0,
    /* a unit counts as a strength this many SD better than average */
    strength_z: 0.5,
    /* a quarterback's interception rate this many times the FBS rate is a
       ball-security story (with at least int_min_attempts throws) */
    int_ratio: 1.4, int_min_attempts: 60
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function present(x) { return !(x === null || x === undefined || x === ''); }
  function ms(t) { if (!present(t)) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v == null ? null : new Date(v).toISOString(); }
  function key(s) { return s == null ? null : String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null; }
  M.key = key;
  function r1(x) { return CALC ? CALC.round(x, 1) : Math.round(x * 10) / 10; }
  function pct1(x) { return r1(x * 100); }
  function f1(x) { return r1(x).toFixed(1); }
  function int(x) { return Math.round(x); }
  function comma(n) { return String(int(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  var WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  function nword(n) { return n >= 0 && n < 10 ? WORDS[n] : String(n); }
  var MON = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
  function dateShort(t) { var d = new Date(ms(t)); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  /* "Alabama by 5.4": a projected margin, never written like a betting line */
  function byText(homeMargin, home, away) { var m = r1(Math.abs(homeMargin)); return m === 0 ? 'a pick’em' : (homeMargin > 0 ? home : away) + ' by ' + m.toFixed(1); }
  function possessive(t) { return /s$/.test(t) ? t + '’' : t + '’s'; }

  /* =================================================== LEAGUE CONTEXT
     FBS averages and spreads of each team-level rate, from the profiles
     (garbage time excluded), so a fact can say "against an FBS average of". */
  var RATE_FIELDS = ['yards_per_rush', 'explosive_rush_rate', 'completion_rate', 'explosive_pass_rate', 'sack_taken_rate', 'third_down_rate'];
  /* THE CONSISTENCY GATE. Every play has an offence and a defence, so across
     the league a rate's offensive and defensive views describe the same
     plays: their team means can differ a little (each side's schedule mixes
     in different opponents) but not by much. When they differ by more than
     this share, the feed is attributing the event to the wrong side on some
     plays, and the rate is quarantined: printed nowhere, argued from never.
     (2026: sacks — 13.9% taken against 5.4% made per team, on the same 2,088
     sacks — because sack plays are sometimes credited to the defence's
     possession.) */
  M.CONSISTENCY_MAX = 0.25;
  M.leagueFromProfiles = function (profiles) {
    var teams = profiles && profiles.teams ? Object.keys(profiles.teams).map(function (k) { return profiles.teams[k]; }) : [];
    var out = { basis: 'mean and spread of team rates across FBS team profiles, garbage time excluded (football/matchup/profiles_' + (profiles && profiles.season) + '.json)', n_teams: 0, quarantined: [] };
    ['excluding_garbage_time', 'allowed_excluding_garbage_time'].forEach(function (view) {
      out[view] = {};
      RATE_FIELDS.forEach(function (f) {
        var xs = teams.map(function (t) { return t[view] ? t[view][f] : null; }).filter(isNum);
        if (xs.length < 20) return;
        var m = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
        var sd = Math.sqrt(xs.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (xs.length - 1));
        out[view][f] = { mean: m, sd: sd, n: xs.length };
      });
    });
    RATE_FIELDS.forEach(function (f) {
      var o = out.excluding_garbage_time[f], a = out.allowed_excluding_garbage_time[f];
      if (!o || !a) { out.quarantined.push({ field: f, why: 'fewer than 20 teams carry this rate' }); return; }
      var rel = Math.abs(o.mean - a.mean) / Math.max(1e-9, Math.min(o.mean, a.mean));
      o.consistency = a.consistency = Math.round(rel * 1000) / 1000;
      if (rel > M.CONSISTENCY_MAX) out.quarantined.push({ field: f, offense_mean: Math.round(o.mean * 10000) / 10000, defense_mean: Math.round(a.mean * 10000) / 10000,
        why: 'the offensive and defensive views of the same plays disagree by ' + Math.round(rel * 100) + '% (team means ' + (o.mean < 1 ? f1(o.mean * 100) + '%' : f1(o.mean)) + ' and ' + (a.mean < 1 ? f1(a.mean * 100) + '%' : f1(a.mean)) + '): the feed credits some of these plays to the wrong side' });
    });
    out.n_teams = teams.length;
    return out;
  };
  function quarantined(league, field) { return !!(league && league.quarantined && league.quarantined.some(function (q) { return q.field === field; })); }
  M.quarantined = quarantined;

  /* =================================================== FINALS INDEX
     Verified final scores, by team key, newest first. record.json rows carry
     game ids and full names; the Collective's settlement record carries
     shortened names, joined on the first ten letters and the date. */
  M.finalsIndex = function (recordRows, settledGames) {
    var byGame = {}, byTeam = {};
    function add(t, x) { (byTeam[t] = byTeam[t] || []).push(x); }
    (recordRows || []).forEach(function (r) {
      if (!r || !r.game_id || !isNum(r.final_margin) || !r.final_text) return;
      var m = /^(.+?) (\d+) — (.+?) (\d+)$/.exec(r.final_text);
      if (!m) return;
      byGame[String(r.game_id)] = { game_id: String(r.game_id), kickoff: r.kickoff, home: r.home, away: r.away,
        away_score: +m[2], home_score: +m[4], source: 'EdgeDesk’s graded record (football/cfb_terminal/record.json)', week: r.week };
    });
    var cut = function (s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); };
    /* the settlement record names schools as the feed does; these differ */
    var ALIAS = { OLEMISS: 'MISSISSIPP', MIAMI: 'MIAMI', UCONN: 'CONNECTICU', UMASS: 'MASSACHUSE', LSU: 'LSU', SMU: 'SMU', UCF: 'UCF', USC: 'USC', BYU: 'BYU', TCU: 'TCU', UTSA: 'UTSA', UTEP: 'UTEP', UNLV: 'UNLV' };
    var cutA = function (s) { var c = cut(s); return ALIAS[c] || c; };
    if (settledGames && !Array.isArray(settledGames)) settledGames = Object.keys(settledGames).map(function (k) { return settledGames[k]; });
    var settled = (settledGames || []).filter(function (g) { return g && isNum(g.home_score) && isNum(g.away_score) && !(g.home_score === 0 && g.away_score === 0); });
    return {
      byGame: byGame,
      settled: settled.map(function (g) { return { h: cut(g.home), a: cut(g.away), day: String(g.kickoff_at || '').slice(0, 10), g: g }; }),
      /* one team's game on one date: a team plays once a day, so the date
         and the team's own name identify it; the opponent breaks a tie
         between two schools whose shortened names collide */
      find: function (gameId, team, opponent, kickoff) {
        if (byGame[String(gameId)]) return byGame[String(gameId)];
        var k = ms(kickoff); if (k == null) return null;
        var t = cutA(team), o = cutA(opponent);
        var hits = this.settled.filter(function (s) { var d = ms(s.g.kickoff_at); return d != null && Math.abs(d - k) <= 18 * 3600e3 && (s.h === t || s.a === t); });
        if (hits.length > 1) hits = hits.filter(function (s) { return (s.h === t ? s.a : s.h).slice(0, 4) === o.slice(0, 4); });
        if (hits.length !== 1) return null;
        var hit = hits[0], teamHome = hit.h === t;
        return { game_id: String(gameId), kickoff: iso(hit.g.kickoff_at), home: teamHome ? team : opponent, away: teamHome ? opponent : team,
          home_score: hit.g.home_score, away_score: hit.g.away_score,
          source: 'the Collective’s settlement record (collective/settled), score source: ' + (hit.g.score_source || 'feeds'), week: hit.g.week };
      }
    };
  };

  /* =================================================== QB INDEX */
  M.qbIndex = function (qbEpa) {
    var by = {};
    var P = qbEpa && qbEpa.players ? (Array.isArray(qbEpa.players) ? qbEpa.players : Object.keys(qbEpa.players).map(function (k) { return qbEpa.players[k]; })) : [];
    var att = 0, ints = 0;
    P.forEach(function (p) {
      if (p && p.team_key && p.name) (by[p.team_key] = by[p.team_key] || []).push(p);
      ((p && p.season_log) || []).forEach(function (g) { if (isNum(g.attempts) && isNum(g.interceptions)) { att += g.attempts; ints += g.interceptions; } });
    });
    /* every team's games, with their kickoffs: the schedule a result joins on */
    var games = {};
    var TM = qbEpa && qbEpa.teams ? qbEpa.teams : {};
    Object.keys(TM).forEach(function (k) { (TM[k].offence_log || []).forEach(function (g) { if (g && g.game_id && g.kickoff) games[String(g.game_id)] = g.kickoff; }); });
    return { by_team: by, league_epa: qbEpa && qbEpa.league && qbEpa.league.season ? qbEpa.league.season.epa_per_dropback : null,
      league_int_rate: att >= 1000 ? ints / att : null, league_attempts: att, games: games,
      generated_at: qbEpa ? qbEpa.generated_at : null };
  };
  function qbSeason(p, beforeMs) {
    var L = (p.season_log || []).filter(function (g) { return g && (beforeMs == null || ms(g.kickoff) < beforeMs); });
    var t = { games: L.length, attempts: 0, completions: 0, yards: 0, tds: 0, interceptions: 0, sacks: 0, dropbacks: 0, epa: 0, epa_n: 0, last: null };
    L.forEach(function (g) {
      ['attempts', 'completions', 'yards', 'tds', 'interceptions', 'sacks', 'dropbacks'].forEach(function (k) { if (isNum(g[k])) t[k] += g[k]; });
      if (isNum(g.epa) && g.epa_state === 'MEASURED') { t.epa += g.epa; t.epa_n += g.dropbacks || 0; }
      if (!t.last || ms(g.kickoff) > ms(t.last.kickoff)) t.last = g;
    });
    t.completion_pct = t.attempts ? pct1(t.completions / t.attempts) : null;
    t.ypa = t.attempts ? r1(t.yards / t.attempts) : null;
    t.epa_per_dropback = t.epa_n ? Math.round(t.epa / t.epa_n * 1000) / 1000 : null;
    return t;
  }

  /* =================================================== FACT WRITERS
     Each fact has two phrasings: `text` (publisher edition) and `alt`
     (EdgeDesk's own edition), so the two articles share verified numbers but
     not sentences. */
  function fact(o) {
    return { id: o.id, team: o.team || null, kind: o.kind, unit: o.unit || null, independent: !!o.independent,
      text: o.text, alt: o.alt || o.text, numbers: (o.numbers || []).filter(isNum), source: o.source || null,
      supports: o.supports || [], verify: o.verify || null, direction: o.direction || null };
  }
  /* the full description (URL, basis, time) is the packet's sources entry;
     each fact carries the short reference */
  var PLAY_SRC = function () { return { name: 'cfbfastR-data play-by-play', artifact: 'football/matchup/profiles_2026.json' }; };
  var PAIR_TEXT = {
    run_game: {
      off: function (t, v, n) { return [t + ' has run for ' + f1(v) + ' yards per carry this season (' + n + ' carries outside garbage time).', t + ' averages ' + f1(v) + ' yards a carry on ' + n + ' non-garbage-time runs.']; },
      def: function (t, v, n) { return [t + ' has allowed ' + f1(v) + ' yards per carry (' + n + ' carries).', 'Opponents have managed ' + f1(v) + ' yards a carry against ' + t + ' (' + n + ' runs).']; },
      fmt: function (v) { return f1(v) + ' yards a carry'; }, pct: false, unit: 'yards per carry', higher_is_better_for_offense: true, label: 'the run game', off_label: 'run game', def_label: 'run defense', field: 'yards_per_rush' },
    explosive_run: {
      off: function (t, v, n) { return [t + ' has gained 15 yards or more on ' + f1(v * 100) + '% of its carries (' + n + ' carries).', t + ' breaks a run of 15-plus yards on ' + f1(v * 100) + '% of its carries (' + n + ').']; },
      def: function (t, v, n) { return [t + ' has allowed a run of 15 yards or more on ' + f1(v * 100) + '% of opponent carries (' + n + ').', t + ' gives up a 15-plus-yard run on ' + f1(v * 100) + '% of carries (' + n + ').']; },
      fmt: function (v) { return f1(v * 100) + '%'; }, pct: true, unit: 'carries of 15+ yards', higher_is_better_for_offense: true, label: 'big runs', off_label: 'big-play run game', def_label: 'defense against big runs', field: 'explosive_rush_rate' },
    passing: {
      off: function (t, v, n) { return [t + ' completes ' + f1(v * 100) + '% of its passes (' + n + ' dropbacks).', possessive(t) + ' passers hit on ' + f1(v * 100) + '% of their throws across ' + n + ' dropbacks.']; },
      def: function (t, v, n) { return [t + ' has allowed a ' + f1(v * 100) + '% completion rate (' + n + ' dropbacks).', 'Quarterbacks have completed ' + f1(v * 100) + '% of their throws against ' + t + ' (' + n + ' dropbacks).']; },
      fmt: function (v) { return f1(v * 100) + '%'; }, pct: true, unit: 'completion rate', higher_is_better_for_offense: true, label: 'the passing game', off_label: 'passing game', def_label: 'pass defense', field: 'completion_rate' },
    explosive_pass: {
      off: function (t, v, n) { return [t + ' has completed a pass of 20 yards or more on ' + f1(v * 100) + '% of its dropbacks (' + n + ' dropbacks).', t + ' connects on a 20-plus-yard pass on ' + f1(v * 100) + '% of dropbacks (' + n + ').']; },
      def: function (t, v, n) { return [t + ' has allowed a 20-yard completion on ' + f1(v * 100) + '% of opponent dropbacks (' + n + ').', 'Opponents have hit a 20-plus-yard pass on ' + f1(v * 100) + '% of dropbacks against ' + t + ' (' + n + ').']; },
      fmt: function (v) { return f1(v * 100) + '%'; }, pct: true, unit: 'explosive passes', higher_is_better_for_offense: true, label: 'the deep passing game', off_label: 'deep passing game', def_label: 'defense against big passes', field: 'explosive_pass_rate' },
    pass_protection: {
      off: function (t, v, n) { return [t + ' has allowed a sack on ' + f1(v * 100) + '% of dropbacks (' + n + ').', possessive(t) + ' quarterbacks have been sacked on ' + f1(v * 100) + '% of their ' + n + ' dropbacks.']; },
      def: function (t, v, n) { return [possessive(t) + ' defense has sacked the quarterback on ' + f1(v * 100) + '% of opponent dropbacks (' + n + ').', t + ' gets a sack on ' + f1(v * 100) + '% of opponent dropbacks (' + n + ').']; },
      fmt: function (v) { return f1(v * 100) + '%'; }, pct: true, unit: 'sacks per dropback', higher_is_better_for_offense: false, label: 'pass protection against the pass rush', off_label: 'pass protection', def_label: 'pass rush', field: 'sack_taken_rate' },
    third_down: {
      off: function (t, v, n) { return [t + ' converts ' + f1(v * 100) + '% of its third downs (' + n + ').', t + ' has moved the chains on ' + f1(v * 100) + '% of ' + n + ' third downs.']; },
      def: function (t, v, n) { return [t + ' allows opponents to convert ' + f1(v * 100) + '% of third downs (' + n + ').', 'Opponents convert ' + f1(v * 100) + '% of third downs against ' + t + ' (' + n + ').']; },
      fmt: function (v) { return f1(v * 100) + '%'; }, pct: true, unit: 'third-down conversions', higher_is_better_for_offense: true, label: 'third downs', off_label: 'third-down offense', def_label: 'third-down defense', field: 'third_down_rate' }
  };
  var QUARANTINE_TEXT = { sack_taken_rate: 'sack rates are not used', completion_rate: 'completion rates are not used', yards_per_rush: 'rushing averages are not used',
    explosive_rush_rate: 'big-run rates are not used', explosive_pass_rate: 'big-pass rates are not used', third_down_rate: 'third-down rates are not used' };
  var UNIT_OF_PAIR = { run_game: 'RUN', explosive_run: 'RUN', passing: 'PASS', explosive_pass: 'PASS', pass_protection: 'TRENCHES', third_down: 'SITUATIONAL' };
  M.PAIR_KEYS = Object.keys(PAIR_TEXT);

  /* z of a value against the league: positive is GOOD for the side named */
  function zOf(league, view, field, v) {
    var L = league && league[view] && league[view][field];
    if (!L || !isNum(v) || !L.sd) return null;
    return (v - L.mean) / L.sd;
  }

  /* ======================================================== BUILD
     src: { terminal (games.json game), football (packet.js build), personnel
            (personnel game entry), reports ({home, away} bundle entries),
            finals (M.finalsIndex), qb (M.qbIndex), rankings (content
            engine rankingsIndex-like {by_name: {rank}}), profiles (teams),
            league (M.leagueFromProfiles), broadcast (EDBroadcast.verify),
            now } */
  M.build = function (src) {
    src = src || {};
    var T = src.terminal || {}, F = src.football && src.football.ok ? src.football : null, gm = T.game || {};
    var now = isNum(src.now) ? src.now : Date.now();
    var home = gm.home, away = gm.away, hk = key(home), ak = key(away), gid = String(T.game_id);
    var kickMs = ms(T.kickoff);
    var facts = [], problems = [], unresolved = [], sources = [];
    function addSource(s) { if (s && !sources.some(function (x) { return x.name === s.name; })) sources.push(s); }
    var pushF = function (o) { var f = fact(o); facts.push(f); return f; };
    var nfid = 0; function fid(k) { nfid++; return 'f_' + gid + '_' + k + '_' + nfid; }

    /* ---------------- identity and schedule */
    var ranks = src.rankings && src.rankings.by_name ? src.rankings.by_name : {};
    var rkH = ranks[home] || null, rkA = ranks[away] || null;
    var kt = SCHED ? SCHED.kickoffOf({ kickoff: T.kickoff, start_time_tbd: T.kickoff_tbd, kickoff_state: T.kickoff_state, kickoff_basis: T.kickoff_basis }) : { state: 'MISSING', verified: false };
    var B = src.broadcast || null;
    var kickoffIso = B && B.schedule_change ? B.kickoff : iso(T.kickoff);
    var times = BC && kt.verified ? BC.timesText(kickoffIso) : null;
    var schedule = { kickoff: kickoffIso, kickoff_state: kt.state, kickoff_verified: !!kt.verified, kickoff_basis: kt.basis || null,
      times: times, venue: gm.venue || null, neutral_site: !!gm.neutral_site, schedule_change: B ? B.schedule_change : null,
      status: B ? B.status : null, source: 'the season schedule feed (cfbfastR-data / ESPN), via football/cfb_terminal' };
    if (!kt.verified) problems.push({ code: 'KICKOFF_UNVERIFIED', text: 'the kickoff time is not confirmed (' + (kt.state || 'missing') + ')' });
    if (kickMs != null && kickMs <= now) problems.push({ code: 'STARTED', text: 'the game has kicked off' });

    /* ---------------- broadcast */
    var bb = broadcastBlock(B, now);
    var broadcast = bb.broadcast;
    if (bb.problem) problems.push(bb.problem);
    if (B && B.source) addSource({ name: B.source.name, url: B.source.url, as_of: B.verified_at, what: 'the television network and streaming listing' });

    /* ---------------- the model */
    var e = T.edgedesk || {}, mk = T.market || {}, D = T.disagreement || {};
    var model = { available: !!(e.available && isNum(e.home_margin)) };
    if (model.available) {
      var fav = e.home_margin >= 0 ? home : away, dog = fav === home ? away : home, mg = Math.abs(e.home_margin);
      var cmpM = CALC ? CALC.spread(e.home_margin, { home: home, away: away }) : null;
      model.fair_text = cmpM ? cmpM.text : e.fair_text;
      model.favorite = r1(mg) === 0 ? null : fav; model.underdog = r1(mg) === 0 ? null : dog; model.margin = r1(mg);
      model.home_win_prob = isNum(e.home_win_prob) ? e.home_win_prob : null;
      model.fav_win_pct = isNum(e.home_win_prob) ? Math.round((fav === home ? e.home_win_prob : 1 - e.home_win_prob) * 100) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.total = isNum(e.fair_total) ? r1(e.fair_total) : null;
      model.version = e.model_version || null; model.as_of = e.prediction_ts || null;
      model.reliability = T.data_quality && isNum(T.data_quality.reliability) ? Math.round(T.data_quality.reliability) : null;
      model.reliability_grade = T.data_quality ? T.data_quality.grade || null : null;
      model.reliability_note = T.data_quality ? T.data_quality.main_deduction || null : null;
      model.confidence = e.football_confidence && isNum(e.football_confidence.score) ? Math.round(e.football_confidence.score) : null;
      model.inputs = ((T.why && T.why.rows) || []).filter(function (w) { return w && w.available !== false && isNum(w.points) && Math.abs(w.points) >= 0.5; })
        .sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 3)
        .map(function (w) { return { label: w.label, points: r1(Math.abs(w.points)), favors: w.favors }; });
      model.unpriced = ((T.why && T.why.unpriced) || []).slice(0, 4);
      var sens = ((T.sensitivity && T.sensitivity.rows) || []).filter(function (s) { return isNum(s.home_margin); });
      if (sens.length) {
        var lo = Math.min.apply(null, sens.map(function (s) { return s.home_margin; })), hi = Math.max.apply(null, sens.map(function (s) { return s.home_margin; }));
        model.sensitivity = { low: byText(lo, home, away), high: byText(hi, home, away), low_home_margin: r1(lo), high_home_margin: r1(hi),
          basis: 'one-standard-deviation rating and input scenarios (football/cfb_terminal sensitivity)' };
      }
      var cons = ((T.consensus && T.consensus.rows) || []).filter(function (c) { return isNum(c.home_margin) && c.role !== 'champion'; });
      if (cons.length) model.other_models = cons.slice(0, 4).map(function (c) { return { label: c.label, home_margin: r1(c.home_margin), text: byText(c.home_margin, home, away) }; });
      var unc = ((T.risks && T.risks.items) || []).filter(function (r) { return r.key === 'model_uncertainty'; })[0];
      model.typical_miss = unc ? unc.text : null;
    }
    var pubInt = T.integrity && T.integrity.publication ? T.integrity.publication : null;
    model.integrity = pubInt ? { status: pubInt.status, blocking: pubInt.blocking || [] } : null;
    model.research_status = T.research_status ? { key: T.research_status.key, label: T.research_status.label, reason: T.research_status.reason || null } : null;
    /* the market comparison: only a current, unfaulted, main line is a comparable */
    var best = null;
    (mk.quotes || []).forEach(function (q) { var t = ms(q.observed_at); if (t != null && isNum(q.home_line) && (!best || t > best.t)) best = { t: t, q: q }; });
    var market = { state: 'NONE', text: null, book: null, captured_at: null };
    if (best) {
      var age = (now - best.t) / 60e3;
      market = { state: age <= 180 ? 'CURRENT' : 'STALE', home_line: best.q.home_line, text: CALC ? CALC.spread(-best.q.home_line, { home: home, away: away }).text : null,
        book: best.q.book || null, captured_at: iso(best.t), age_minutes: Math.round(age) };
    }
    if (T.research_status && /FAULT/.test(T.research_status.key)) market.state = 'FAULT';
    if (pubInt && pubInt.blocking && pubInt.blocking.some(function (b) { return /^MKT\./.test(b); })) market.state = 'FAULT';
    model.market = market;
    if (model.available && market.state === 'CURRENT' && CALC) {
      var c = CALC.spreadComparison({ home: home, away: away, model_home_margin: e.home_margin, market_home_margin: -market.home_line });
      model.gap = { points: c.gap, text: c.text, formula: c.reconcile ? c.reconcile.formula : null, toward: c.toward_team };
      model.gap_state = 'COMPARABLE';
      if (c.gap >= 7 && D.verification !== 'VERIFIED') { model.gap_state = 'UNRESOLVED'; unresolved.push({ code: 'LARGE_GAP_UNVERIFIED', text: 'a ' + f1(c.gap) + '-point gap from the market that has not cleared EdgeDesk’s integrity gate: a question about the data, not a prediction' }); }
      else if (c.gap >= 2) model.gap_why = T.summary && T.summary.why ? T.summary.why : null;
    } else model.gap_state = market.state === 'NONE' ? 'NO_MARKET' : (market.state === 'FAULT' ? 'FAULT' : 'STALE_MARKET');
    if (!model.available) problems.push({ code: 'NO_PROJECTION', text: 'EdgeDesk has no projection for this game' });
    if (model.integrity && model.integrity.status === 'BLOCKED') problems.push({ code: 'INTEGRITY_BLOCKED', text: 'the integrity engine blocks this game from publication (' + model.integrity.blocking.join(', ') + ')' });

    /* ---------------- teams: form, results, opposition */
    var teams = {};
    var profiles = src.profiles || {};
    [['home', home, hk], ['away', away, ak]].forEach(function (s) {
      var side = s[0], name = s[1], k = s[2], prof = profiles[k] || null;
      var t = { name: name, key: k, rank: (side === 'home' ? rkH : rkA) ? (side === 'home' ? rkH : rkA).rank : null, conference: side === 'home' ? gm.home_conference : gm.away_conference };
      /* every game played, newest first, each with its verified final or a
         gap: the profile's own running score is NOT a final */
      var sched = src.qb && src.qb.games ? src.qb.games : {};
      var played = (prof && prof.opponents ? prof.opponents.slice() : []).filter(function (o) { var kk = ms(sched[String(o.game_id)]); return kickMs == null || kk == null || kk < kickMs; })
        .sort(function (a, b) { return (ms(sched[String(b.game_id)]) || 0) - (ms(sched[String(a.game_id)]) || 0); });
      var results = [], missing = 0, chain = [];
      played.forEach(function (o) {
        var kk = sched[String(o.game_id)] || null;
        var fin = src.finals ? (src.finals.byGame[String(o.game_id)] || src.finals.find(o.game_id, name, o.opponent, kk)) : null;
        var pf = null, pa = null, isHome = null;
        if (fin) { isHome = key(fin.home) === k; pf = isHome ? fin.home_score : fin.away_score; pa = isHome ? fin.away_score : fin.home_score; }
        if (!fin || !isNum(pf) || !isNum(pa)) { missing++; chain.push(null); return; }
        var r = { game_id: String(o.game_id), opponent: o.opponent, opponent_rank: ranks[o.opponent] ? ranks[o.opponent].rank : null,
          points_for: pf, points_against: pa, result: pf > pa ? 'W' : (pf < pa ? 'L' : 'T'), kickoff: fin.kickoff || kk, week: fin.week || null, home: isHome, source: fin.source };
        results.push(r); chain.push(r);
      });
      t.results = results;
      t.games_played = played.length;
      /* the most recent games, only while they are consecutive and verified */
      t.recent = []; for (var ci = 0; ci < chain.length && chain[ci]; ci++) t.recent.push(chain[ci]);
      t.record_complete = played.length > 0 && missing === 0;
      if (t.record_complete) {
        t.wins = results.filter(function (r) { return r.result === 'W'; }).length; t.losses = results.filter(function (r) { return r.result === 'L'; }).length;
        t.points_for_pg = r1(results.reduce(function (a, r) { return a + r.points_for; }, 0) / results.length);
        t.points_against_pg = r1(results.reduce(function (a, r) { return a + r.points_against; }, 0) / results.length);
      } else if (played.length) unresolved.push({ code: 'RESULTS_INCOMPLETE', text: name + ': ' + missing + ' of ' + played.length + ' results have no verified final, so no season record is stated' });
      var oppRanks = played.map(function (o) { return ranks[o.opponent] ? ranks[o.opponent].rank : null; }).filter(isNum);
      t.opposition = oppRanks.length ? { avg_rank: Math.round(oppRanks.reduce(function (a, b) { return a + b; }, 0) / oppRanks.length), top25: oppRanks.filter(function (r) { return r <= 25; }).length, n: oppRanks.length, of: played.length } : null;
      teams[side] = t;
      /* facts: the last result, the record */
      var last = t.recent[0];
      if (last) {
        var w = last.result === 'W';
        pushF({ id: fid('last'), team: name, kind: 'result', independent: true,
          text: name + ' ' + (w ? 'beat ' : (last.result === 'L' ? 'lost to ' : 'tied ')) + last.opponent + ' ' + Math.max(last.points_for, last.points_against) + '-' + Math.min(last.points_for, last.points_against) + (last.week ? ' in Week ' + last.week : '') + '.',
          alt: 'Last time out, ' + name + ' ' + (w ? 'beat ' : (last.result === 'L' ? 'lost to ' : 'tied ')) + last.opponent + ', ' + Math.max(last.points_for, last.points_against) + '-' + Math.min(last.points_for, last.points_against) + (last.home ? ', at home.' : ', on the road.'),
          numbers: [last.points_for, last.points_against, last.week], source: { name: 'verified final score', artifact: last.source }, supports: ['why_watch', 'form'], verify: 'the final score of ' + name + ' vs. ' + last.opponent });
      }
      if (!t.record_complete && t.recent.length >= 2) {
        var r2 = t.recent.slice(0, Math.min(3, t.recent.length));
        var wr = r2.filter(function (r) { return r.result === 'W'; }).length;
        pushF({ id: fid('recent'), team: name, kind: 'form', independent: true,
          text: name + ' has ' + (wr === r2.length ? 'won' : (wr === 0 ? 'lost' : 'gone ' + wr + '-' + (r2.length - wr) + ' in')) + ' its last ' + nword(r2.length) + ' games, scoring ' + f1(r2.reduce(function (a, r) { return a + r.points_for; }, 0) / r2.length) + ' points a game and allowing ' + f1(r2.reduce(function (a, r) { return a + r.points_against; }, 0) / r2.length) + '.',
          alt: 'Over its last ' + nword(r2.length) + ' games ' + name + ' is ' + wr + '-' + (r2.length - wr) + ': ' + r2.map(function (r) { return r.result + ' ' + Math.max(r.points_for, r.points_against) + '-' + Math.min(r.points_for, r.points_against) + ' ' + (r.home ? 'vs.' : 'at') + ' ' + r.opponent; }).join(', ') + '.',
          numbers: r2.reduce(function (a, r) { return a.concat([r.points_for, r.points_against]); }, [wr, r2.length - wr, r1(r2.reduce(function (a, r) { return a + r.points_for; }, 0) / r2.length), r1(r2.reduce(function (a, r) { return a + r.points_against; }, 0) / r2.length)]), source: { name: 'verified final scores', artifact: 'football/cfb_terminal/record.json, collective/settled' }, supports: ['why_watch', 'form'], verify: name + '’s recent results' });
      }
      if (t.record_complete && results.length >= 2) {
        pushF({ id: fid('record'), team: name, kind: 'form', independent: true,
          text: name + ' is ' + t.wins + '-' + t.losses + ', scoring ' + f1(t.points_for_pg) + ' points a game and allowing ' + f1(t.points_against_pg) + '.',
          alt: 'At ' + t.wins + '-' + t.losses + ', ' + name + ' has averaged ' + f1(t.points_for_pg) + ' points and given up ' + f1(t.points_against_pg) + ' per game.',
          numbers: [t.wins, t.losses, t.points_for_pg, t.points_against_pg], source: { name: 'verified final scores', artifact: 'football/cfb_terminal/record.json, collective/settled' }, supports: ['why_watch', 'form'], verify: name + '’s season results' });
      }
      if (t.opposition && t.opposition.n >= 3) {
        pushF({ id: fid('opp'), team: name, kind: 'opposition', independent: false,
          text: possessive(name) + ' opponents so far have an average EdgeDesk rank of ' + t.opposition.avg_rank + (t.opposition.top25 ? ', with ' + nword(t.opposition.top25) + ' from EdgeDesk’s top 25' : '') + '.',
          alt: name + ' has faced a schedule averaging No. ' + t.opposition.avg_rank + ' in EdgeDesk’s ratings' + (t.opposition.top25 ? ' (' + nword(t.opposition.top25) + ' top-25 ' + plural(t.opposition.top25, 'opponent') + ')' : '') + '.',
          numbers: [t.opposition.avg_rank, t.opposition.top25], source: { name: 'EdgeDesk team ratings', artifact: 'football/rankings/current.json' }, supports: ['context'] });
      }
    });
    if (src.profiles_generated_at) addSource({ name: 'cfbfastR-data play-by-play', url: 'https://github.com/sportsdataverse/cfbfastR-data', as_of: src.profiles_generated_at, what: 'unit rates (this season’s plays, garbage time excluded, not opponent-adjusted) and quarterback lines' });

    /* ---------------- quarterbacks */
    var qbs = {};
    ['home', 'away'].forEach(function (side) {
      var name = side === 'home' ? home : away, k = side === 'home' ? hk : ak;
      var tq = T.qb && T.qb[side] ? T.qb[side] : null;
      var cls = AVAIL && tq ? AVAIL.classify(AVAIL.fromTerminal(name, tq), { kickoff: T.kickoff, now: now }) : null;
      var players = src.qb && src.qb.by_team ? (src.qb.by_team[k] || []) : [];
      var usage = cls && cls.evidence ? cls.evidence.filter(function (x) { return x.kind === 'usage'; })[0] : null;
      var names = usage ? [usage.primary, usage.secondary] : (tq && tq.player ? [tq.player] : []);
      if (usage && cls) {
        /* the label names the primary by its share; keep both, primary first */
        var m = /([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})% of recent dropbacks and ([A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+)*) (\d{1,3})%/.exec(String(tq.label || ''));
        if (m) names = [m[1], m[3]];
      }
      var lines = names.map(function (n) {
        var p = players.filter(function (x) { return x.name === n; })[0];
        if (!p) return { player: n, season: null };
        return { player: n, season: qbSeason(p, kickMs) };
      });
      var q = { player: tq ? tq.player : null, status: tq ? tq.status : null, classification: cls ? cls['class'] : null, may_assert_uncertainty: cls ? cls.may_assert_uncertainty : false,
        split: usage ? { primary: names[0], primary_share: m && m[2] ? +m[2] / 100 : usage.primary_share, secondary: names[1], secondary_share: m && m[4] ? +m[4] / 100 : usage.secondary_share } : null,
        lines: lines, availability: null };
      qbs[side] = q;
      lines.forEach(function (L, i) {
        var s = L.season; if (!s || !s.attempts) return;
        var ipt = s.interceptions;
        pushF({ id: fid('qb'), team: name, kind: 'qb', unit: 'QB', independent: true,
          text: possessive(name) + ' ' + L.player + ' has completed ' + s.completions + ' of ' + s.attempts + ' passes (' + f1(s.completion_pct) + '%) for ' + comma(s.yards) + ' yards, ' + s.tds + ' ' + plural(s.tds, 'touchdown') + ' and ' + ipt + ' ' + plural(ipt, 'interception') + ' this season.',
          alt: L.player + ' (' + name + '): ' + s.completions + ' of ' + s.attempts + ', ' + comma(s.yards) + ' yards (' + f1(s.ypa) + ' a throw), ' + s.tds + ' TD, ' + ipt + ' INT, sacked ' + (s.sacks === 1 ? 'once' : s.sacks + ' times') + ' on ' + s.dropbacks + ' dropbacks.',
          numbers: [s.completions, s.attempts, s.completion_pct, s.yards, s.tds, ipt, s.ypa, s.sacks, s.dropbacks], source: { name: 'cfbfastR-data passing lines', artifact: 'football/fbs_epa/qb_epa_2026.json', as_of: src.qb ? src.qb.generated_at : null },
          supports: ['qb', 'deciding'], verify: L.player + '’s season passing line' });
        /* ball security: interceptions are attributed to the passer in the
           player stats (team turnover columns are not: fumbles are gated
           MISSING league-wide, so no turnover margin is ever stated) */
        var lir = src.qb ? src.qb.league_int_rate : null;
        if (isNum(lir) && s.attempts >= M.CONFIG.int_min_attempts) {
          var ir = s.interceptions / s.attempts;
          L.int_rate = ir;
          var hiInt = ir >= M.CONFIG.int_ratio * lir, loInt = ir <= lir / M.CONFIG.int_ratio;
          if (hiInt || loInt) pushF({ id: fid(hiInt ? 'ints' : 'secure'), team: name, kind: 'turnovers', unit: 'QB', independent: true, direction: hiInt ? 'HIGH' : 'LOW',
            text: L.player + ' has thrown ' + nword(s.interceptions) + ' ' + plural(s.interceptions, 'interception') + ' in ' + s.attempts + ' attempts (' + f1(ir * 100) + '%), against an FBS rate of ' + f1(lir * 100) + '%.',
            alt: (hiInt ? 'Ball security is the question for ' + L.player + ': ' : 'Ball security has been a strength for ' + L.player + ': ') + s.interceptions + ' ' + plural(s.interceptions, 'interception') + ' on ' + s.attempts + ' throws, ' + f1(ir * 100) + '% against ' + f1(lir * 100) + '% across FBS.',
            numbers: [s.interceptions, s.attempts, r1(ir * 100), r1(lir * 100)], source: { name: 'cfbfastR-data passing lines', artifact: 'football/fbs_epa/qb_epa_2026.json', as_of: src.qb.generated_at },
            supports: ['qb', 'turnovers', 'upset'], verify: L.player + '’s interceptions and attempts' });
        }
        if (isNum(s.epa_per_dropback) && s.epa_n >= 40 && i === 0 && src.qb && isNum(src.qb.league_epa)) {
          pushF({ id: fid('qbepa'), team: name, kind: 'qb_efficiency', unit: 'QB', independent: false,
            text: L.player + ' has produced ' + s.epa_per_dropback.toFixed(2) + ' expected points added per dropback, against an FBS average of ' + src.qb.league_epa.toFixed(2) + '.',
            alt: 'By expected points added — how much each dropback moves a team toward points — ' + L.player + ' sits at ' + s.epa_per_dropback.toFixed(2) + ' per dropback (FBS average ' + src.qb.league_epa.toFixed(2) + ').',
            numbers: [s.epa_per_dropback, src.qb.league_epa], source: { name: 'cfbfastR-data expected points (provider model)', artifact: 'football/fbs_epa/qb_epa_2026.json' }, supports: ['qb'] });
        }
      });
      if (q.split && lines.length === 2) {
        pushF({ id: fid('qbsplit'), team: name, kind: 'qb_split', unit: 'QB', independent: true,
          text: q.split.primary + ' has taken ' + Math.round(q.split.primary_share * 100) + '% of ' + possessive(name) + ' recent dropbacks and ' + q.split.secondary + ' ' + Math.round(q.split.secondary_share * 100) + '%, according to the play-by-play.',
          alt: possessive(name) + ' recent dropbacks have been split: ' + q.split.primary + ' ' + Math.round(q.split.primary_share * 100) + '%, ' + q.split.secondary + ' ' + Math.round(q.split.secondary_share * 100) + '% (play-by-play attribution).',
          numbers: [Math.round(q.split.primary_share * 100), Math.round(q.split.secondary_share * 100)], source: { name: 'cfbfastR-data player stats (play attribution)', artifact: 'football/cfb_terminal games.json qb' },
          supports: ['qb', 'why_watch', 'deciding'], verify: possessive(name) + ' dropbacks by passer' });
        unresolved.push({ code: 'QB_STARTER_UNSETTLED', text: name + ': no source EdgeDesk holds names the starter; the play-by-play shows a split (' + q.split.primary + ' ' + Math.round(q.split.primary_share * 100) + '%, ' + q.split.secondary + ' ' + Math.round(q.split.secondary_share * 100) + '%)' });
      }
    });

    /* ---------------- official availability */
    var availability = {};
    ['home', 'away'].forEach(function (side) {
      var name = side === 'home' ? home : away;
      var P = src.personnel && src.personnel[side] ? src.personnel[side] : null;
      var rep = src.reports && src.reports[side] ? src.reports[side] : null;
      if (!P || !P.coverage) { availability[side] = { grade: 'NONE', official: false, note: 'no availability report is on file for ' + name }; return; }
      var cov = P.coverage;
      var all = [].concat(P.absences || [], P.unrated || []);
      var listed = all.map(function (x) { return { player: x.player_name, position: x.position, status: x.injury_status, status_label: x.status_label || x.injury_status, depth_rank: isNum(x.depth_rank) ? x.depth_rank : null, unit: x.unit_label || x.unit || null }; });
      var srcObj = { name: cov.source || 'availability report', kind: cov.official ? 'official' : 'reporter', url: rep && rep.source_url ? rep.source_url : null,
        published_at: rep && rep.published_at ? rep.published_at : (cov.as_of || null), retrieved_at: rep && rep.retrieved_at ? rep.retrieved_at : null };
      availability[side] = { grade: cov.grade, official: !!cov.official, comprehensive: !!cov.comprehensive, source: srcObj, listed: listed,
        units: (P.units || []).map(function (u) { return { unit: u.label, unit_code: u.unit || null, absences: u.absences, concern: u.concern }; }) };
      if (srcObj.name) addSource({ name: srcObj.name, url: srcObj.url, as_of: srcObj.published_at, what: name + ' availability' });
      var out = listed.filter(function (x) { return /^OUT/.test(x.status || ''); });
      var q2 = listed.filter(function (x) { return /QUESTIONABLE|DOUBTFUL/.test(x.status || ''); });
      /* the classifications the prose guard reads: a listed player is SOURCED */
      availability[side].classified = AVAIL ? listed.map(function (x) {
        return AVAIL.classify({ team: name, player: x.player, reports: [{ claim: /^OUT/.test(x.status) ? 'out' : (/DOUBT/.test(x.status) ? 'doubtful' : (/QUESTION/.test(x.status) ? 'questionable' : 'active')),
          source: { name: srcObj.name, kind: srcObj.kind, url: srcObj.url }, published_at: srcObj.published_at }] }, { kickoff: T.kickoff, now: now });
      }) : [];
      /* the quarterbacks on a comprehensive report that does not list them are available */
      var Q = qbs[side];
      if (Q && cov.comprehensive) {
        var qbNames = Q.lines.map(function (l) { return l.player; });
        var listedQb = listed.filter(function (x) { return qbNames.indexOf(x.player) >= 0; });
        Q.availability = { report: srcObj.name, published_at: srcObj.published_at, listed: listedQb, available: qbNames.filter(function (n) { return !listedQb.some(function (x) { return x.player === n; }); }) };
      }
      var keyOut = out.filter(function (x) { return x.depth_rank != null && x.depth_rank <= 2; }).concat(out.filter(function (x) { return !(x.depth_rank != null && x.depth_rank <= 2); })).slice(0, 3);
      if (out.length || q2.length) {
        var when = srcObj.published_at ? dateShort(srcObj.published_at) : null;
        var outText = keyOut.map(function (x) { return POS[x.position] ? POS[x.position] + ' ' + x.player : x.player + ' (' + x.position + ')'; });
        pushF({ id: fid('avail'), team: name, kind: 'availability', unit: 'AVAILABILITY', independent: !!cov.official,
          text: 'The ' + (cov.source || 'availability report') + ' lists ' + out.length + ' ' + plural(out.length, 'player') + ' out for ' + name + (outText.length ? (out.length === outText.length ? ' (' + sl(outText) + ')' : ', including ' + sl(outText)) : '') + (q2.length ? (out.length === outText.length ? ' and ' : ', and ') + q2.length + ' as questionable or doubtful' : '') + (when ? ' (report dated ' + when + ')' : '') + '.',
          alt: 'Out for ' + name + ': ' + (outText.length ? sl(outText) : 'none listed') + (out.length > outText.length ? ', plus ' + (out.length - outText.length) + ' more' : '') + (q2.length ? '; ' + q2.length + ' more ' + name + ' ' + plural(q2.length, 'player') + ' questionable or doubtful' : '') + ' (' + (cov.source || 'availability report') + (when ? ', ' + when : '') + ').',
          numbers: [out.length, q2.length], source: { name: cov.source, url: srcObj.url, published_at: srcObj.published_at, kind: 'official' }, supports: ['availability', 'deciding', 'upset'], verify: 'the conference availability report' });
      }
      if (Q && Q.availability && Q.availability.available.length && cov.comprehensive) {
        var avn = Q.availability.available;
        pushF({ id: fid('qbavail'), team: name, kind: 'qb_availability', unit: 'QB', independent: !!cov.official,
          text: sl(avn) + (avn.length > 1 ? ' are' : ' is') + ' not on the ' + (cov.source || 'availability report') + '.',
          alt: avn.length > 1 ? 'Neither ' + avn.join(' nor ') + ' appears on the ' + (cov.source || 'availability report') + '.' : avn[0] + ' does not appear on the ' + (cov.source || 'availability report') + '.',
          numbers: [], source: { name: cov.source, url: srcObj.url, published_at: srcObj.published_at, kind: 'official' }, supports: ['qb', 'availability'], verify: 'the conference availability report' });
      }
    });

    /* ---------------- the football: measured pairings */
    var league = src.league || null;
    var pairs = [], quarantinedSeen = [];
    var raw = F && F.football ? (F.football.pairings_excluding_garbage_time || []) : [];
    raw.forEach(function (p) {
      var Tm = PAIR_TEXT[p.key];
      if (!Tm || p.state !== 'MEASURED' || !isNum(p.off_value) || !isNum(p.def_value)) return;
      if (quarantined(league, Tm.field)) { if (quarantinedSeen.indexOf(Tm.field) < 0) quarantinedSeen.push(Tm.field); return; }
      if ((p.off_n || 0) < M.CONFIG.min_pair_n || (p.def_n || 0) < M.CONFIG.min_pair_n) return;
      var zo = zOf(league, 'excluding_garbage_time', Tm.field, p.off_value), zd = zOf(league, 'allowed_excluding_garbage_time', Tm.field, p.def_value);
      /* offence quality and defence quality, each positive when that unit is good */
      var oq = zo == null ? null : (Tm.higher_is_better_for_offense ? zo : -zo);
      var dq = zd == null ? null : (Tm.higher_is_better_for_offense ? -zd : zd);
      var Lo = league && league.excluding_garbage_time && league.excluding_garbage_time[Tm.field] ? league.excluding_garbage_time[Tm.field].mean : null;
      var o = { id: p.key + ':' + key(p.attacker), key: p.key, unit: UNIT_OF_PAIR[p.key], label: Tm.label, off_label: Tm.off_label, def_label: Tm.def_label, attacker: p.attacker, defender: p.defender,
        off_value: p.off_value, off_n: p.off_n, def_value: p.def_value, def_n: p.def_n, off_text: Tm.fmt(p.off_value), def_text: Tm.fmt(p.def_value),
        league: isNum(Lo) ? Tm.fmt(Lo) : null, off_quality: oq == null ? null : Math.round(oq * 100) / 100, def_quality: dq == null ? null : Math.round(dq * 100) / 100,
        edge: oq != null && dq != null ? Math.round((oq - dq) * 100) / 100 : null, clash: oq != null && dq != null ? Math.round(Math.min(oq, dq) * 100) / 100 : null };
      var tO = Tm.off(p.attacker, p.off_value, p.off_n), tD = Tm.def(p.defender, p.def_value, p.def_n);
      var leagueTail = o.league ? ' The FBS average is ' + o.league + '.' : '';
      o.fact_off = pushF({ id: fid(p.key + '_off'), team: p.attacker, kind: 'unit', unit: o.unit, independent: true, text: tO[0], alt: tO[1],
        numbers: [Tm.pct ? pct1(p.off_value) : r1(p.off_value), p.off_n], source: PLAY_SRC(src.profiles_generated_at), supports: [p.key], verify: p.attacker + ' ' + Tm.unit }).id;
      o.fact_def = pushF({ id: fid(p.key + '_def'), team: p.defender, kind: 'unit', unit: o.unit, independent: true, text: tD[0] + leagueTail, alt: tD[1],
        numbers: [Tm.pct ? pct1(p.def_value) : r1(p.def_value), p.def_n].concat(isNum(Lo) ? [Tm.pct ? pct1(Lo) : r1(Lo)] : []), source: PLAY_SRC(src.profiles_generated_at), supports: [p.key], verify: p.defender + ' ' + Tm.unit + ' allowed' }).id;
      pairs.push(o);
    });

    /* position-group standings (EdgeDesk's own boards: analysis, not independent) */
    var standings = F && F.football && F.football.unit_standing ? F.football.unit_standing : null;
    /* the opponent-adjusted read from the terminal's matchup cards */
    var cards = ((T.matchup && T.matchup.cards) || []).map(function (c) { return { key: c.key, label: c.label, favors: c.favors, magnitude: c.magnitude, net_sd: c.net_sd, confidence: c.confidence }; });

    /* ---------------- the arguments */
    var A = {};
    /* 2 the deciding matchup: a clear mismatch or a strength-on-strength clash */
    /* a MISMATCH needs the favoured unit to be a strength in its own right
       (above the FBS average), not merely the other side's weakness */
    var ranked = pairs.filter(function (p) { return p.edge != null; }).map(function (p) {
      var winQ = p.edge > 0 ? p.off_quality : p.def_quality;
      var mis = Math.abs(p.edge) >= M.CONFIG.mismatch_z && winQ >= M.CONFIG.strength_z;
      /* ranked by the favoured unit's own strength first, the size of the gap second */
      var s = Math.max(mis ? winQ + 0.5 * Math.abs(p.edge) : 0, p.clash >= M.CONFIG.clash_z ? 1.5 * p.clash + 0.25 * Math.abs(p.edge) : 0);
      return { p: p, s: s, kind: p.clash >= M.CONFIG.clash_z ? 'CLASH' : (mis ? 'MISMATCH' : 'EVEN') };
    }).sort(function (a, b) { return b.s - a.s; });
    var top = ranked.filter(function (x) { return x.s > 0; });
    if (top.length) {
      var d = top[0].p, kind = top[0].kind;
      var winner = d.edge > 0 ? d.attacker : d.defender;
      A.deciding = { pair_id: d.id, pairing: d.key, unit: d.unit, kind: kind, attacker: d.attacker, defender: d.defender, favors: kind === 'CLASH' ? null : winner,
        facts: [d.fact_off, d.fact_def],
        claim: kind === 'CLASH'
          ? possessive(d.attacker) + ' ' + d.off_label + ' against ' + possessive(d.defender) + ' ' + d.def_label + ' is strength against strength.'
          : (d.edge > 0 ? possessive(d.attacker) + ' ' + d.off_label + ' has the edge over ' + possessive(d.defender) + ' ' + d.def_label + ' on the season numbers.'
            : possessive(d.defender) + ' ' + d.def_label + ' has the edge over ' + possessive(d.attacker) + ' ' + d.off_label + ' on the season numbers.'),
        alt: kind === 'CLASH' ? 'The best unit-on-unit fight: ' + possessive(d.attacker) + ' ' + d.off_label + ' against ' + article(d.defender) + ' ' + d.defender + ' ' + d.def_label + ' that has been just as good.'
          : 'The clearest gap on paper: ' + (d.edge > 0 ? possessive(d.attacker) + ' ' + d.off_label + ' against ' + possessive(d.defender) + ' ' + d.def_label : possessive(d.defender) + ' ' + d.def_label + ' against ' + possessive(d.attacker) + ' ' + d.off_label) + '.' };
      /* the second storyline: a different kind of matchup when one stands out */
      var nx = top.filter(function (x) { return x.p.key !== d.key; })[0] || top.filter(function (x) { return x.p.id !== d.id; })[0];
      if (nx) A.second = { pair_id: nx.p.id, pairing: nx.p.key, attacker: nx.p.attacker, defender: nx.p.defender, facts: [nx.p.fact_off, nx.p.fact_def], kind: nx.kind };
    }
    /* adjusted corroboration: does the opponent-adjusted card agree? */
    if (A.deciding) {
      var card = cards.filter(function (c) { return c.key === A.deciding.unit; })[0];
      if (card) A.deciding.adjusted = { label: card.label, favors: card.favors, magnitude: card.magnitude, net_sd: card.net_sd, confidence: card.confidence,
        agrees: A.deciding.favors ? card.favors === A.deciding.favors : null };
    }
    /* 1 why watch */
    var why = [];
    var bothRanked = teams.home.rank != null && teams.home.rank <= 25 && teams.away.rank != null && teams.away.rank <= 25;
    if (bothRanked) why.push({ kind: 'RANKED', text: 'two of EdgeDesk’s top 25 teams (No. ' + Math.min(teams.home.rank, teams.away.rank) + ' and No. ' + Math.max(teams.home.rank, teams.away.rank) + ')', facts: [] });
    else if ((teams.home.rank != null && teams.home.rank <= 25) || (teams.away.rank != null && teams.away.rank <= 25)) {
      var rt = teams.home.rank != null && teams.home.rank <= 25 ? teams.home : teams.away;
      why.push({ kind: 'RANKED_ONE', text: 'EdgeDesk’s No. ' + rt.rank + ' team, ' + rt.name, facts: [] });
    }
    if (gm.matchup_type === 'conference' && gm.home_conference) why.push({ kind: 'CONFERENCE', text: article(gm.home_conference) + ' ' + gm.home_conference + ' game', facts: [] });
    ['home', 'away'].forEach(function (s) {
      var t = teams[s];
      if (t.record_complete && t.losses === 0 && t.wins >= 3) why.push({ kind: 'UNBEATEN', text: t.name + ' is unbeaten (' + t.wins + '-0)', facts: facts.filter(function (f) { return f.team === t.name && f.kind === 'form'; }).map(function (f) { return f.id; }) });
    });
    if (A.deciding && A.deciding.kind === 'CLASH') why.push({ kind: 'CLASH', text: 'strength against strength: ' + possessive(A.deciding.attacker) + ' ' + PAIR_TEXT[A.deciding.pairing].off_label + ' against ' + possessive(A.deciding.defender) + ' ' + PAIR_TEXT[A.deciding.pairing].def_label, facts: A.deciding.facts });
    ['home', 'away'].forEach(function (s) { if (qbs[s].split) why.push({ kind: 'QB_SPLIT', text: (s === 'home' ? home : away) + ' has split its quarterback dropbacks', facts: facts.filter(function (f) { return f.kind === 'qb_split' && f.team === (s === 'home' ? home : away); }).map(function (f) { return f.id; }) }); });
    if (model.available && isNum(model.fav_win_pct) && model.fav_win_pct <= 62) why.push({ kind: 'CLOSE', text: 'EdgeDesk’s projection is close: ' + (model.favorite ? model.fav_win_pct + '% for ' + model.favorite : 'a pick’em'), facts: [], model: true });
    if (gm.neutral_site && gm.venue) why.push({ kind: 'NEUTRAL', text: 'played at a neutral site, ' + gm.venue, facts: [] });
    A.why_watch = why;
    /* 3 recent evidence: independent facts that support the deciding matchup or the why */
    var supportIds = [].concat(A.deciding ? A.deciding.facts : [], A.second ? A.second.facts : []);
    why.forEach(function (w) { supportIds = supportIds.concat(w.facts || []); });
    facts.filter(function (f) { return f.kind === 'result' || f.kind === 'form' || f.kind === 'qb' || f.kind === 'turnovers'; }).forEach(function (f) { supportIds.push(f.id); });
    (A.upset_facts || []).forEach(function (id) { supportIds.push(id); });
    var evidence = facts.filter(function (f) { return f.independent && supportIds.indexOf(f.id) >= 0; });
    A.evidence = evidence.map(function (f) { return f.id; });
    /* 4 projection */
    A.projection = model.available ? { fair_text: model.fair_text, favorite: model.favorite, fav_win_pct: model.fav_win_pct, total: model.total, inputs: model.inputs,
      market: model.market, gap: model.gap || null, gap_state: model.gap_state, gap_why: model.gap_why || null,
      reliability: model.reliability, reliability_grade: model.reliability_grade, integrity: model.integrity ? model.integrity.status : null } : null;
    /* 5 why the model could be wrong */
    var wrong = [];
    if (model.sensitivity) wrong.push({ kind: 'SENSITIVITY', text: 'reasonable changes to the ratings move EdgeDesk’s number between ' + model.sensitivity.low + ' and ' + model.sensitivity.high });
    if (model.other_models && model.other_models.length) {
      var oms = model.other_models.map(function (m) { return m.home_margin; });
      var omLo = Math.min.apply(null, oms), omHi = Math.max.apply(null, oms);
      wrong.push({ kind: 'OTHER_MODELS', text: 'EdgeDesk’s ' + nword(oms.length) + ' other models range from ' + byText(omLo, home, away) + ' to ' + byText(omHi, home, away), home_margins: oms });
    }
    if (A.deciding && A.deciding.adjusted && A.deciding.adjusted.agrees === false) wrong.push({ kind: 'ADJUSTED_DISAGREES', text: 'adjusted for the opponents each side has faced, EdgeDesk’s matchup metrics ' + (A.deciding.adjusted.favors ? 'lean ' + A.deciding.adjusted.favors + ' in the ' + A.deciding.adjusted.label.toLowerCase() + ', not ' + A.deciding.favors : 'call the ' + A.deciding.adjusted.label.toLowerCase() + ' even rather than an edge for ' + A.deciding.favors) });
    ['home', 'away'].forEach(function (s) {
      var av = availability[s], name = s === 'home' ? home : away;
      if (av && av.listed && av.listed.length && model.available) wrong.push({ kind: 'ABSENCES', text: 'the projection does not price individual absences, and ' + name + ' has ' + av.listed.length + ' ' + plural(av.listed.length, 'player') + ' on the availability report' });
    });
    ['home', 'away'].forEach(function (s) { if (qbs[s].split) wrong.push({ kind: 'QB_SPLIT', text: 'the projection cannot know which ' + (s === 'home' ? home : away) + ' quarterback plays most' }); });
    if (model.typical_miss) wrong.push({ kind: 'TYPICAL_MISS', text: model.typical_miss.replace(/\.$/, '') });
    if (model.gap_state === 'UNRESOLVED') wrong.push({ kind: 'UNRESOLVED_GAP', text: unresolved.filter(function (u) { return u.code === 'LARGE_GAP_UNVERIFIED'; })[0].text });
    A.model_wrong = wrong;
    /* the upset case: only on the evidence */
    var up = { credible: false, team: model.underdog || null, conditions: [], counter: [], reason: null };
    if (model.available && model.underdog && isNum(model.dog_win_pct) && model.fav_win_pct <= 55) {
      up.reason = 'EdgeDesk sees this as close to even (' + model.fav_win_pct + '% for ' + model.favorite + '), so neither result would be an upset on its numbers';
      up.dog_win_pct = model.dog_win_pct; up.near_even = true;
    } else if (model.available && model.underdog && isNum(model.dog_win_pct)) {
      var dogN = model.underdog, favN = model.favorite;
      /* the underdog's MEASURED STRENGTHS where they meet this opponent:
         a unit at least strength_z better than average, with the edge */
      var dogEdges = pairs.filter(function (p) {
        if (p.edge == null) return false;
        if (p.attacker === dogN) return p.edge >= 0.5 && p.off_quality >= M.CONFIG.strength_z;
        return p.defender === dogN && p.edge <= -0.5 && p.def_quality >= M.CONFIG.strength_z;
      }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); });
      dogEdges.slice(0, 2).forEach(function (p) {
        var onO = p.attacker === dogN;
        up.conditions.push({ kind: 'UNIT_EDGE', pairing: p.key, facts: [p.fact_off, p.fact_def],
          text: onO ? possessive(dogN) + ' ' + p.off_label + ' keeps producing (' + p.off_text + ' this season) against ' + article(favN) + ' ' + favN + ' ' + p.def_label + ' that has allowed ' + p.def_text + (p.league ? ' (FBS average ' + p.league + ')' : '')
            : possessive(dogN) + ' ' + p.def_label + ' (' + p.def_text + ' allowed' + (p.league ? ', FBS average ' + p.league : '') + ') slows ' + possessive(favN) + ' ' + p.off_label + ' (' + p.off_text + ')' });
      });
      var favSide = favN === home ? 'home' : 'away', dogSide = favSide === 'home' ? 'away' : 'home';
      var favInts = facts.filter(function (f) { return f.kind === 'turnovers' && f.team === favN && f.direction === 'HIGH'; })[0];
      if (favInts) up.conditions.push({ kind: 'FAV_TURNOVERS', facts: [favInts.id], text: possessive(favN) + ' passer keeps throwing interceptions at the season rate (' + favInts.text.replace(/^.*?\((\d+(?:\.\d)?%)\).*$/, '$1') + ' of throws)' });
      var avF = availability[favSide];
      if (avF && avF.units) {
        var hi = avF.units.filter(function (u) { return u.concern === 'HIGH'; })[0];
        if (hi) up.conditions.push({ kind: 'FAV_ABSENCES', facts: facts.filter(function (f) { return f.kind === 'availability' && f.team === favN; }).map(function (f) { return f.id; }),
          text: favN + ' is missing ' + hi.absences + ' ' + plural(hi.absences, 'player') + ' ' + unitWhere(hi.unit_code, hi.unit) + ' on the availability report' });
      }
      var dogInts = facts.filter(function (f) { return f.kind === 'turnovers' && f.team === dogN && f.direction === 'HIGH'; })[0];
      if (dogInts) up.counter.push({ kind: 'DOG_TURNOVERS', facts: [dogInts.id], text: dogInts.text.replace(/\.$/, '') });
      var favEdge = pairs.filter(function (p) {
        if (p.edge == null) return false;
        if (p.attacker === favN) return p.edge >= 0.5 && p.off_quality >= M.CONFIG.strength_z;
        return p.defender === favN && p.edge <= -0.5 && p.def_quality >= M.CONFIG.strength_z;
      }).sort(function (a, b) { return Math.abs(b.edge) - Math.abs(a.edge); })[0];
      if (favEdge) up.counter.push({ kind: 'FAV_EDGE', facts: [favEdge.fact_off, favEdge.fact_def],
        text: (favEdge.attacker === favN ? possessive(favN) + ' ' + favEdge.off_label + ' (' + favEdge.off_text + ') meets ' + article(dogN) + ' ' + dogN + ' ' + favEdge.def_label + ' that has allowed ' + favEdge.def_text
          : possessive(favN) + ' ' + favEdge.def_label + ' (' + favEdge.def_text + ' allowed) meets ' + possessive(dogN) + ' ' + favEdge.off_label + ' (' + favEdge.off_text + ')') });
      up.counter.push({ kind: 'MODEL', text: 'EdgeDesk still makes ' + favN + ' the ' + model.fav_win_pct + '% favorite', model: true });
      /* credible only on a measured strength of the underdog's own; an
         absence or a turnover rate can add to a case, never make one */
      up.credible = model.dog_win_pct >= Math.round(M.CONFIG.upset_min_dog_prob * 100) && up.conditions.some(function (c) { return c.kind === 'UNIT_EDGE'; });
      if (!up.credible) up.reason = model.dog_win_pct < Math.round(M.CONFIG.upset_min_dog_prob * 100)
        ? 'EdgeDesk gives ' + dogN + ' a ' + model.dog_win_pct + '% chance; the numbers do not make an upset case'
        : 'none of ' + possessive(dogN) + ' measured units is a strength with an edge in this matchup';
      up.dog_win_pct = model.dog_win_pct;
    } else up.reason = model.available ? 'EdgeDesk projects a pick’em' : 'no projection';
    A.upset = up;
    /* 6 what to watch: concrete, tied to the evidence */
    var wf = [];
    if (A.deciding) {
      var dk = A.deciding, dp = pairs.filter(function (p) { return p.id === dk.pair_id; })[0];
      wf.push({ pairing: dk.pairing, facts: dk.facts, text: WATCH[dk.pairing](dp) });
    }
    ['home', 'away'].forEach(function (s) {
      var q = qbs[s];
      if (q.split && wf.length < 2) wf.push({ kind: 'QB_SPLIT', facts: facts.filter(function (f) { return f.kind === 'qb_split' && f.team === (s === 'home' ? home : away); }).map(function (f) { return f.id; }),
        text: 'Who takes ' + possessive(s === 'home' ? home : away) + ' first snap, and whether ' + q.split.secondary + ' still gets a series: the dropbacks have been split ' + Math.round(q.split.primary_share * 100) + '-' + Math.round(q.split.secondary_share * 100) + '.' });
    });
    if (wf.length < 2 && A.second) {
      var sp = pairs.filter(function (p) { return p.id === A.second.pair_id; })[0];
      if (sp) wf.push({ pairing: sp.key, facts: A.second.facts, text: WATCH[sp.key](sp) });
    }
    var tov = facts.filter(function (f) { return f.kind === 'turnovers' && f.direction === 'HIGH'; })[0];
    if (wf.length < 2 && tov) wf.push({ kind: 'TURNOVERS', facts: [tov.id], text: 'Ball security: ' + tov.text });
    if (wf.length < 2 && up.credible && up.conditions[0]) wf.push({ kind: 'UPSET', facts: up.conditions[0].facts, text: 'The upset path: ' + up.conditions[0].text + '.' });
    A.watch_for = wf.slice(0, 2);

    var packet = {
      schema: M.SCHEMA, version: M.VERSION, built_at: new Date(now).toISOString(), game_id: gid, season: T.season, week: T.week,
      identity: { home: home, away: away, home_key: hk, away_key: ak, neutral_site: !!gm.neutral_site, venue: gm.venue || null,
        home_conference: gm.home_conference || null, away_conference: gm.away_conference || null, conference_game: gm.matchup_type === 'conference',
        home_rank: teams.home.rank, away_rank: teams.away.rank, heading: away + (gm.neutral_site ? ' vs. ' : ' at ') + home },
      schedule: schedule, broadcast: broadcast, model: model, teams: teams, quarterbacks: qbs, availability: availability,
      pairings: pairs, standings: standings ? summarizeStandings(standings, home, away) : null, adjusted_cards: cards,
      facts: facts, arguments: A, problems: problems, unresolved: unresolved, sources: sources,
      research_as_of: [T.generated_at || null, src.profiles_generated_at || null].filter(Boolean).sort()[0] || null,
      limits: [
        'unit rates are counts from this season’s plays with garbage time excluded, and are NOT opponent-adjusted',
        'pressures short of a sack, blocking grades, coverage and snap counts are in no feed EdgeDesk reads, so none is claimed',
        'fumbles are attributed for too few plays this season to measure turnovers, so turnover margins are not stated; interceptions are stated per passer',
        'availability is as of the report’s publication time; a later change is revalidated before publication'
      ]
    };
    /* a quarantined rate is stated in every packet, whether or not this
       game's pairing would have used it: the reader learns what is missing */
    ((league && league.quarantined) || []).filter(function (q) { return q.offense_mean != null; }).forEach(function (q) {
      packet.limits.push(QUARANTINE_TEXT[q.field] ? QUARANTINE_TEXT[q.field] + ': ' + q.why : q.field + ' is not used: ' + q.why);
    });
    packet.quarantined = quarantinedSeen;
    packet.gate = M.gate(packet);
    return packet;
  };
  var UNIT_WHERE = { OFFENSIVE_LINE: 'on the offensive line', DEFENSIVE_FRONT: 'on the defensive front', SECONDARY: 'in the secondary', RECEIVERS: 'at receiver',
    WIDE_RECEIVERS: 'at receiver', LINEBACKERS: 'at linebacker', QUARTERBACK: 'at quarterback', QB: 'at quarterback', RUNNING_BACKS: 'at running back', BACKFIELD: 'in the backfield',
    TIGHT_ENDS: 'at tight end', SPECIALISTS: 'among the specialists', SPECIAL_TEAMS: 'on special teams' };
  function unitWhere(code, label) { return UNIT_WHERE[code] || ('in the ' + String(label || 'unit').toLowerCase()); }
  function broadcastBlock(B, now) {
    var bpub = BC ? BC.publishable(B, now) : { ok: false, reason: 'UNVERIFIED', text: 'the broadcast layer did not load' };
    var watch = B && BC ? BC.watchLine(B) : null;
    var broadcast = { status: B ? B.status : 'UNVERIFIED', tier: B ? B.tier : 'NONE', network: B ? B.network : null, networks: B ? B.networks : [],
      streaming: B ? B.streaming : [], regional: B ? B.regional : [], source: B ? B.source : null, verified_at: B ? B.verified_at : null,
      verified_by: B ? B.verified_by : null, kickoff: B ? B.kickoff : null, schedule_change: B ? B.schedule_change : null,
      publishable: bpub.ok, hold_reason: bpub.ok ? null : bpub.text, withdraw: !!bpub.withdraw, watch: watch, problems: B ? B.problems : [] };
    return { broadcast: broadcast, problem: bpub.ok ? null : { code: 'BROADCAST_' + bpub.reason, text: 'where to watch: ' + bpub.text, hold: true, withdraw: !!bpub.withdraw } };
  }
  /* RE-VERIFY a built packet's broadcast — the owner's verification from the
     admin page, or a fresh listing before publication — without rebuilding
     the football. Returns a new packet; the input is not changed. */
  M.applyBroadcast = function (packet, record, now) {
    var p = JSON.parse(JSON.stringify(packet));
    now = isNum(now) ? now : Date.now();
    var bb = broadcastBlock(record, now);
    p.broadcast = bb.broadcast;
    p.problems = (p.problems || []).filter(function (x) { return !/^BROADCAST_/.test(x.code); });
    if (bb.problem) p.problems.push(bb.problem);
    if (record && record.schedule_change && record.kickoff) {
      p.schedule.kickoff = record.kickoff;
      p.schedule.times = BC ? BC.timesText(record.kickoff) : null;
      p.schedule.schedule_change = record.schedule_change;
      p.schedule.kickoff_verified = true;
      p.problems = p.problems.filter(function (x) { return x.code !== 'KICKOFF_UNVERIFIED'; });
    }
    p.schedule.status = record ? record.status : null;
    p.gate = M.gate(p);
    return p;
  };
  var POS = { QB: 'quarterback', RB: 'running back', WR: 'receiver', TE: 'tight end', OL: 'offensive lineman', DL: 'defensive lineman', EDGE: 'edge rusher',
    LB: 'linebacker', CB: 'cornerback', S: 'safety', DB: 'defensive back', NB: 'nickel back', K: 'kicker', P: 'punter' };
  /* "an SEC game", "a Big Ten game": initialisms by their first letter's sound */
  var AN_LETTERS = 'AEFHILMNORSX';
  function article(w) {
    w = String(w || '');
    if (/^(MAC|MWC)\b/.test(w)) return 'a';
    if (/^[A-Z]{2,}\b/.test(w)) return AN_LETTERS.indexOf(w[0]) >= 0 ? 'an' : 'a';
    if (/^(U[a-z]|Eu|One\b)/.test(w)) return 'a';
    return /^[aeiou]/i.test(w) ? 'an' : 'a';
  }
  M.article = article;
  function sl(a) { a = a.filter(Boolean); if (a.length <= 1) return a[0] || ''; return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
  /* one concrete, checkable thing per pairing: the two season numbers and
     what it would look like on Saturday if the attacker's number holds */
  var WATCH = {
    run_game: function (p) { return possessive(p.attacker) + ' yards per carry against ' + possessive(p.defender) + ' run defense: ' + p.off_text + ' this season against ' + p.def_text + ' allowed, and the halftime rushing average shows whose number is holding.'; },
    explosive_run: function (p) { return 'Runs of 15 yards or more: ' + p.attacker + ' breaks one on ' + p.off_text + ' of carries and ' + p.defender + ' allows one on ' + p.def_text + '.'; },
    passing: function (p) { return possessive(p.attacker) + ' completion rate against ' + possessive(p.defender) + ' coverage: ' + p.off_text + ' this season for the offense, ' + p.def_text + ' allowed by the defense.'; },
    explosive_pass: function (p) { return 'Completions of 20 yards or more: ' + p.attacker + ' hits one on ' + p.off_text + ' of dropbacks and ' + p.defender + ' allows one on ' + p.def_text + ', so count ' + possessive(p.attacker) + ' deep completions.'; },
    pass_protection: function (p) { return possessive(p.attacker) + ' protection: it allows a sack on ' + p.off_text + ' of dropbacks, and ' + p.defender + ' gets one on ' + p.def_text + '.'; },
    third_down: function (p) { return 'Third downs: ' + p.attacker + ' converts ' + p.off_text + ' and ' + p.defender + ' allows ' + p.def_text + ', so ' + possessive(p.attacker) + ' third-down rate decides how long its drives last.'; }
  };

  function summarizeStandings(U, home, away) {
    var out = [];
    function one(k, att, def) {
      var u = U[k]; if (!u) return;
      out.push({ key: k, attacker: att, defender: def, offense_group: u.offense.group, offense_rank: u.offense.rank, offense_of: u.offense.of, offense_percentile: u.offense.percentile,
        defense_group: u.defense.group, defense_rank: u.defense.rank, defense_of: u.defense.of, defense_percentile: u.defense.percentile });
    }
    one('home_pass_offence_vs_away_secondary', home, away); one('away_pass_offence_vs_home_secondary', away, home);
    one('home_run_offence_vs_away_front', home, away); one('away_run_offence_vs_home_front', away, home);
    return out;
  }

  /* ======================================================= THE GATE */
  M.gate = function (p) {
    var A = p.arguments || {}, ans = {}, missing = [];
    ans.why_watch = (A.why_watch || []).filter(function (w) { return !w.model; });
    if (!ans.why_watch.length) missing.push({ q: 1, code: 'NO_REASON_TO_WATCH', text: 'no reason to watch beyond the projection' });
    ans.deciding = A.deciding || null;
    if (!ans.deciding) missing.push({ q: 2, code: 'NO_DECIDING_MATCHUP', text: 'no measured unit matchup stands out (every pairing is even or too thin)' });
    var ind = (A.evidence || []).filter(function (id) { return p.facts.some(function (f) { return f.id === id && f.independent; }); });
    ans.evidence = ind;
    if (ind.length < M.CONFIG.min_independent_facts) missing.push({ q: 3, code: 'TOO_FEW_FACTS', text: ind.length + ' independent supporting ' + plural(ind.length, 'fact') + '; ' + M.CONFIG.min_independent_facts + ' are required' });
    /* the deciding matchup itself must rest on two independent facts */
    if (ans.deciding && ans.deciding.facts.filter(function (id) { return ind.indexOf(id) >= 0; }).length < 2) missing.push({ q: 3, code: 'DECIDING_UNSUPPORTED', text: 'the deciding matchup is not backed by two independent facts' });
    ans.projection = A.projection || null;
    if (!ans.projection) missing.push({ q: 4, code: 'NO_PROJECTION', text: 'EdgeDesk has no projection' });
    ans.model_wrong = A.model_wrong || [];
    if (!ans.model_wrong.length) missing.push({ q: 5, code: 'NO_COUNTERARGUMENT', text: 'no specific reason the model could be wrong' });
    ans.watch_for = A.watch_for || [];
    if (!ans.watch_for.length) missing.push({ q: 6, code: 'NOTHING_TO_WATCH', text: 'no concrete development to watch for' });
    var hold = (p.problems || []).filter(function (x) { return x.hold; });
    var block = (p.problems || []).filter(function (x) { return !x.hold; });
    return { ok: !missing.length && !block.length, publishable: !missing.length && !block.length && !hold.length,
      missing: missing, blocking: block, holds: hold, independent_facts: ind.length, answers: { why_watch: ans.why_watch.length, deciding: !!ans.deciding, evidence: ind.length,
        projection: !!ans.projection, model_wrong: ans.model_wrong.length, watch_for: ans.watch_for.length } };
  };

  /* ====================================================== SELECTION
     packets → the featured set. Never the largest gaps: audience interest,
     football significance, evidence quality, matchup advantage, upset
     potential, reliability, publisher fit and timeliness, with one storyline
     per game and a balance of national and under-the-radar games.
     opts: { count (5), required: [game_id], publisher, prefer_broad, now } */
  var POWER = ['SEC', 'Big Ten', 'Big 12', 'ACC'];
  M.scoreGame = function (p, opts) {
    opts = opts || {};
    var id = p.identity, g = p.gate || M.gate(p), A = p.arguments || {}, m = p.model || {};
    var parts = {};
    var rk = [id.home_rank, id.away_rank].filter(isNum);
    parts.audience = Math.min(100, rk.reduce(function (a, r) { return a + (r <= 10 ? 45 : (r <= 25 ? 30 : (r <= 40 ? 10 : 0))); }, 0)
      + (POWER.indexOf(id.home_conference) >= 0 || POWER.indexOf(id.away_conference) >= 0 ? 20 : 0));
    parts.significance = (id.conference_game ? 35 : 10) + (rk.length === 2 && rk.every(function (r) { return r <= 25; }) ? 30 : 0)
      + ((A.why_watch || []).some(function (w) { return w.kind === 'UNBEATEN'; }) ? 20 : 0) + (isNum(m.fav_win_pct) && m.fav_win_pct <= 62 ? 15 : 0);
    parts.evidence = Math.min(100, g.independent_facts * 12 + (p.pairings || []).length * 5 + (p.availability && p.availability.home && p.availability.home.official ? 10 : 0));
    parts.matchup = Math.max(0, Math.min(100, A.deciding ? (A.deciding.kind === 'CLASH' ? 85 : 65) : 0));
    parts.upset = A.upset && A.upset.credible ? Math.min(100, 40 + (A.upset.dog_win_pct || 0)) : 0;
    parts.reliability = isNum(m.reliability) ? m.reliability : 40;
    parts.fit = opts.prefer_broad ? parts.audience : 50;
    parts.timeliness = p.schedule && p.schedule.kickoff_verified ? 100 : 0;
    /* a comparable market gap is context, never a selector on its own */
    parts.market = m.gap_state === 'COMPARABLE' && m.gap && m.gap.points >= 2 ? Math.min(30, m.gap.points * 5) : 0;
    var W = { audience: 0.22, significance: 0.16, evidence: 0.16, matchup: 0.14, upset: 0.08, reliability: 0.10, fit: 0.06, timeliness: 0.05, market: 0.03 };
    var s = 0; Object.keys(W).forEach(function (k) { s += W[k] * (parts[k] || 0); });
    return { score: Math.round(s), parts: parts, weights: W, national: parts.audience >= 50 };
  };
  M.storylineOf = function (p) {
    var A = p.arguments || {};
    if (A.upset && A.upset.credible) return 'upset:' + (A.upset.conditions[0] ? A.upset.conditions[0].kind : 'model');
    if ((A.why_watch || []).some(function (w) { return w.kind === 'QB_SPLIT'; })) return 'qb_split';
    if (A.deciding) return (A.deciding.kind === 'CLASH' ? 'clash:' : 'mismatch:') + A.deciding.pairing;
    return 'projection';
  };
  M.select = function (packets, opts) {
    opts = opts || {};
    var count = isNum(opts.count) ? Math.max(1, Math.min(8, opts.count)) : 5;
    var req = (opts.required || []).map(String);
    var scored = packets.map(function (p) { return { p: p, s: M.scoreGame(p, opts), story: M.storylineOf(p), gate: p.gate || M.gate(p) }; });
    var eligible = scored.filter(function (x) { return x.gate.ok; }).sort(function (a, b) { return b.s.score - a.s.score; });
    var out = [], stories = {}, report = { required_failed: [], skipped: [] };
    req.forEach(function (id) {
      var x = scored.filter(function (y) { return y.p.game_id === id; })[0];
      if (!x) { report.required_failed.push({ game_id: id, reason: 'not in this week’s research' }); return; }
      if (!x.gate.ok) { report.required_failed.push({ game_id: id, matchup: x.p.identity.heading, reason: (x.gate.missing.concat(x.gate.blocking)).map(function (m) { return m.text; }).join('; ') }); return; }
      out.push(x); stories[x.story] = (stories[x.story] || 0) + 1;
    });
    /* balance: up to two under-the-radar games when the set has room */
    var nationalSlots = Math.max(0, count - Math.min(2, Math.max(0, count - 3)));
    eligible.forEach(function (x) {
      if (out.length >= count || out.indexOf(x) >= 0) return;
      var nat = out.filter(function (y) { return y.s.national; }).length;
      if (x.s.national && nat >= nationalSlots && eligible.some(function (y) { return !y.s.national && out.indexOf(y) < 0; })) { report.skipped.push({ game_id: x.p.game_id, reason: 'balance: national slots full' }); return; }
      if (stories[x.story] && eligible.filter(function (y) { return out.indexOf(y) < 0 && !stories[y.story]; }).length >= count - out.length) { report.skipped.push({ game_id: x.p.game_id, reason: 'storyline already featured (' + x.story + ')' }); return; }
      out.push(x); stories[x.story] = (stories[x.story] || 0) + 1;
    });
    /* fill if balance rules left room */
    eligible.forEach(function (x) { if (out.length < count && out.indexOf(x) < 0) out.push(x); });
    return { games: out.map(function (x) { return { game_id: x.p.game_id, heading: x.p.identity.heading, score: x.s.score, parts: x.s.parts, storyline: x.story, national: x.s.national, publishable: x.gate.publishable }; }),
      packets: out.map(function (x) { return x.p; }), rejected: scored.filter(function (x) { return !x.gate.ok; }).map(function (x) { return { game_id: x.p.game_id, heading: x.p.identity.heading, missing: x.gate.missing.concat(x.gate.blocking).map(function (m) { return m.code; }) }; }),
      report: report, count: count };
  };
  return M;
});
// ── END INTEGRITY LAYER ────────────────────────────────────────────────
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

  var VERSION = 'content_engine_v1';
  var SITE = 'https://edgedesksports.com';

  /* THE INTEGRITY LAYER (docs/system-integrity): the one calculation layer,
     kickoff truth, availability classes and the integrity engine. The page
     loads them with <script> tags, Node requires them, and the Edge Function
     carries verbatim copies (tools/content/inline.js). Without them every
     number is unchecked, so validation FAILS CLOSED (check integrity_engine). */
  function dep(name, file) {
    var G = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
    if (G && G[name]) return G[name];
    if (typeof require === 'function') { try { return require('./' + file); } catch (e) { /* not in this host */ } }
    return null;
  }
  var CALC = dep('EDCalc', 'edgedesk_calc.js'), SCHED = dep('EDSchedule', 'edgedesk_schedule.js'),
    AVAIL = dep('EDAvailability', 'edgedesk_availability.js'), INTEG = dep('EDIntegrity', 'edgedesk_integrity.js');
  var INTEGRITY_OK = !!(CALC && SCHED && AVAIL && INTEG);
  /* the editorial matchup packets and broadcast verification (Five Games to
     Watch, docs/content-engine/GAMES_TO_WATCH.md); without them that template
     is not offered and its checks fail closed */
  var MATCH = dep('EDMatchup', 'edgedesk_matchup.js'), BCAST = dep('EDBroadcast', 'edgedesk_broadcast.js');
  var GTW_OK = !!(MATCH && BCAST);

  /* ------------------------------------------------------------ vocabulary */
  var STATUSES = ['draft', 'in_review', 'approved', 'ready_to_send', 'sent', 'published', 'rejected', 'archived'];
  /* The same matrix the database enforces (supabase/content_engine.sql).
     REJECTED: the owner turned the draft down in review; it can be reworked
     (back to draft) or archived, never approved as it stands. */
  var TRANSITIONS = {
    /* draft → rejected: only through the auto-reject door, for a draft whose
       own editorial review is REJECT (docs/content-engine/GAMES_TO_WATCH.md) */
    draft: ['in_review', 'rejected', 'archived'],
    in_review: ['draft', 'approved', 'rejected', 'archived'],
    rejected: ['draft', 'archived'],
    approved: ['ready_to_send', 'in_review', 'draft', 'archived'],
    ready_to_send: ['sent', 'approved', 'in_review', 'archived'],
    sent: ['published', 'archived'],
    published: ['archived'],
    archived: ['draft']
  };
  var STATUS_LABELS = {
    draft: 'Draft', in_review: 'In review', approved: 'Approved', ready_to_send: 'Ready to send',
    sent: 'Sent', published: 'Published', rejected: 'Rejected', archived: 'Archived'
  };

  var KINDS = {
    weekly_preview: 'Weekly preview',
    upset_watch: 'Upset watch',
    conference_race: 'Conference race',
    market_discrepancy: 'Market discrepancy',
    injury_impact: 'Injury implications',
    trending_story: 'Trending story',
    weekend_storylines: 'Biggest weekend storylines',
    game_deep_dive: 'Individual game deep dive',
    model_performance: 'Weekly model performance review',
    games_to_watch: 'Five games to watch'
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
      label: 'Model vs. Market', league: null,
      sections: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'limits', 'conclusion'],
      required: ['intro', 'the_gap', 'why_they_differ', 'how_to_read', 'market_case', 'conclusion'],
      words: [500, 1200]
    },
    /* docs/system-integrity/TEMPLATES.md: one central story each, verified
       numbers only, uncertainty stated, EdgeDesk credited, methodology kept short */
    weekend_storylines: {
      label: 'Biggest Weekend Storylines', league: null,
      sections: ['intro', 'storylines', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'storylines', 'how_to_read', 'limits', 'conclusion'],
      words: [600, 1400]
    },
    game_deep_dive: {
      label: 'Individual Game Deep Dive', league: null,
      sections: ['intro', 'the_matchup', 'numbers', 'why_they_differ', 'what_could_change', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'the_matchup', 'numbers', 'how_to_read', 'limits', 'conclusion'],
      words: [500, 1200]
    },
    conference_race: {
      label: 'Conference Race Analysis', league: 'cfb',
      sections: ['intro', 'race', 'games', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'race', 'games', 'how_to_read', 'conclusion'],
      words: [450, 1200]
    },
    upset_watch: {
      label: 'Upset Watch', league: null,
      sections: ['intro', 'upsets', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'upsets', 'how_to_read', 'conclusion'],
      words: [450, 1100]
    },
    model_performance_review: {
      label: 'Weekly Model Performance Review', league: null,
      sections: ['intro', 'record', 'where_it_missed', 'calibration', 'how_to_read', 'conclusion'],
      required: ['intro', 'record', 'how_to_read', 'conclusion'],
      words: [350, 1000]
    },
    /* docs/content-engine/GAMES_TO_WATCH.md: N featured games (5 by default),
       each in six parts — where to watch, why it matters, the key matchup,
       EdgeDesk's projection, upset potential, what to watch. Two editions
       from the same verified packets, never the same sentences. */
    weekly_games_to_watch: {
      label: 'Five Games to Watch (publisher edition)', league: 'cfb', edition: 'publisher',
      sections: ['intro', 'watch_guide', 'game_1', 'game_2', 'game_3', 'game_4', 'game_5', 'game_6', 'game_7', 'game_8', 'how_to_read', 'limits', 'conclusion'],
      required: ['intro', 'watch_guide', 'game_1', 'game_2', 'game_3', 'how_to_read', 'limits', 'conclusion'],
      words: [1100, 2600]
    },
    weekly_games_to_watch_first_party: {
      label: 'Five Games to Watch (EdgeDesk edition)', league: 'cfb', edition: 'first_party',
      sections: ['intro', 'research_nav', 'game_1', 'game_2', 'game_3', 'game_4', 'game_5', 'game_6', 'game_7', 'game_8', 'how_to_read', 'limits', 'next_steps'],
      required: ['intro', 'research_nav', 'game_1', 'game_2', 'game_3', 'how_to_read', 'limits', 'next_steps'],
      words: [1200, 3000]
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
    storylines: 'The storylines',
    the_matchup: 'The matchup',
    numbers: 'What EdgeDesk’s numbers say',
    what_could_change: 'What could change it',
    race: 'The state of the race',
    record: 'How the numbers did',
    where_it_missed: 'Where it missed',
    calibration: 'Were the probabilities honest?',
    watch_guide: 'The schedule at a glance',
    research_nav: 'This week’s research, game by game',
    next_steps: 'Follow these games on EdgeDesk'
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
  /* canonical rounding (lib/edgedesk_calc.js, half away from zero) so every
     number an article prints matches the terminal and the board digit for digit */
  function r1(x) { return CALC ? CALC.round(+x, 1) : +(+x).toFixed(1); }
  function oneDp(x) { return Math.abs(r1(x)).toFixed(1); }
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
  /* a kickoff as an article prints it (lib/edgedesk_schedule.js): a time the
     schedule marks TBA — or a midnight-Eastern placeholder with no flag — is
     "Sat., Oct. 17, time TBA", never "12 a.m. ET" */
  function kickoffTruth(g) {
    var raw = { kickoff: g.kickoff, kickoff_state: g.kickoff_state || null };
    if (g.kickoff_tbd != null) raw.start_time_tbd = g.kickoff_tbd;
    else if (g.start_time_tbd != null) raw.start_time_tbd = g.start_time_tbd;
    var k = SCHED ? SCHED.kickoffOf(raw) : { state: 'CONFIRMED', verified: true, ms: ts(g.kickoff), game_date: null, basis: 'no schedule module loaded' };
    var text = null;
    if (k.ms != null) {
      if (k.verified) text = whenText(k.ms);
      else if (k.game_date) { var d = k.game_date.split('-').map(Number); text = dayText(Date.UTC(d[0], d[1] - 1, d[2], 16)) + ', time TBA'; }
      else text = 'time TBA';
    }
    return { state: k.state, verified: k.verified, basis: k.basis, game_date: k.game_date, text: text };
  }

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
    /* the live-forward model record, graded (tools/integrity/performance.js) */
    performance: 'football/validation/integrity_performance.json',
    /* the editorial matchup packets (tools/content/build_packets.js) */
    packets: 'football/content/packets.json'
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
    var g = (Math.round(r1(marketHomeLine) * 10) - Math.round(r1(modelHomeLine) * 10)) / 10; /* >0: model likes home more than the market */
    var pts = Math.abs(g);
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
      /* the two chances always add to 100: the underdog's is 100 minus the
         favourite's PRINTED figure (rounding each side alone printed 51% / 50%) */
      var favPct = CALC ? CALC.round(100 * favP, 0) : Math.round(100 * favP);
      d.win = favT + ' ' + favPct + '%';
      d.dog_win = (favT === home ? away : home) + ' ' + (100 - favPct) + '%';
    }
    if (proj && isNum(proj.home) && isNum(proj.away)) {
      /* the scores come from EDCalc.projectedScores: they add to the total and
         differ by the margin exactly, at one decimal or, when both cannot be
         exact at one, two */
      var dp = proj.decimals === 2 ? 2 : 1, fx = function (v) { return (+v).toFixed(dp); };
      var hi = homeLine == null ? proj.home >= proj.away : homeLine <= 0;
      d.score = (hi ? home + ' ' + fx(proj.home) + ', ' + away + ' ' + fx(proj.away) : away + ' ' + fx(proj.away) + ', ' + home + ' ' + fx(proj.home));
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
    var kick = ts(g.kickoff), kt = kickoffTruth(g);
    var model = { available: !!(e.available && isNum(e.fair_home_line)) };
    if (model.available) {
      var f = favOf(home, away, r1(e.fair_home_line));
      model.version = e.model_version || null;
      model.as_of = e.prediction_ts || null;
      model.home_line = r1(e.fair_home_line);
      model.favorite = f.favorite; model.underdog = f.underdog; model.margin = f.margin;
      model.home_win_prob = isNum(e.home_win_prob) ? Math.round(e.home_win_prob * 1000) / 1000 : null;
      model.fav_win_pct = isNum(e.home_win_prob) ? (CALC ? CALC.round : function (x) { return Math.round(x); })((f.favorite === away ? 1 - e.home_win_prob : e.home_win_prob) * 100, 0) : null;
      model.dog_win_pct = model.fav_win_pct == null ? null : 100 - model.fav_win_pct;
      model.fair_total = isNum(e.fair_total) ? r1(e.fair_total) : null;
      /* scores derived from the margin and total the article prints (EDCalc) */
      var psc = CALC && isNum(e.fair_total) ? CALC.projectedScores({ home: home, away: away, home_margin: -model.home_line, total: r1(e.fair_total) }) : null;
      model.projected = psc && psc.available ? { home: psc.home, away: psc.away, decimals: psc.decimals }
        : (e.projected_score && isNum(e.projected_score.home) ? { home: r1(e.projected_score.home), away: r1(e.projected_score.away) } : null);
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
      return { player: q.player, confirmed: !!q.confirmed, contested: !!q.contested, label: q.label || null, status: q.status || null, source: q.source || null, as_of: q.as_of || null };
    }
    var qb = { home: qbOf(g.qb && g.qb.home), away: qbOf(g.qb && g.qb.away) };
    /* AVAILABILITY TRUTH (lib/edgedesk_availability.js): an unannounced starter
       who started last time is an EXPECTED STARTER, not an uncertainty; a
       dropback split is a measured fact, not a reported competition */
    var availability = AVAIL ? { home: AVAIL.classify(AVAIL.fromTerminal(home, g.qb && g.qb.home), { kickoff: g.kickoff, now: now }),
      away: AVAIL.classify(AVAIL.fromTerminal(away, g.qb && g.qb.away), { kickoff: g.kickoff, now: now }) } : null;
    var flags = [];
    if (market.status === 'none') flags.push('NO_MARKET');
    if (market.status === 'stale') flags.push('STALE_MARKET');
    if (availability && ((availability.home && availability.home.may_assert_uncertainty) || (availability.away && availability.away.may_assert_uncertainty))) flags.push('QB_UNCERTAIN');
    if (availability && ((availability.home && availability.home.measured_note) || (availability.away && availability.away.measured_note))) flags.push('QB_USAGE_SPLIT');
    if (!kt.verified) flags.push('KICKOFF_TBA');
    if (model.confidence && model.confidence.score < MIN_CONFIDENCE) flags.push('LOW_CONFIDENCE');
    if (!model.available) flags.push('NO_PROJECTION');
    /* AUDIT 2026-10-08 (docs/system-integrity/AUDIT.md §7): this read
       verification === 'FAILED', a value the terminal never writes (it writes
       VERIFIED, UNVERIFIED, NOT_RUN, DATA_FAULT, MARKET_FAULT, NOT_REQUIRED), so
       every unverified 7+ gap was treated as verified. A gap is VERIFIED only
       when the integrity gate said so; anything else at 7+ is not. */
    var verification = g.disagreement && g.disagreement.verification ? g.disagreement.verification : null;
    var verified = verification === 'VERIFIED';
    if (verification && verification !== 'VERIFIED' && verification !== 'NOT_REQUIRED') flags.push('VERIFICATION_FAILED');
    if (kick != null && kt.verified && kick <= now) flags.push('KICKED_OFF');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    var p = {
      league: 'cfb', game_id: String(g.game_id), season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kt.text, kickoff_state: kt.state, kickoff_verified: kt.verified, kickoff_basis: kt.basis,
      kickoff_tbd: g.kickoff_tbd == null ? null : g.kickoff_tbd, week_scope: g.week_scope || null, verified: verified,
      availability: availability, regime_flags: (g.research_status && g.research_status.flags) || [],
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
    var home = g.home_team, away = g.away_team, kick = ts(g.kickoff), kt = kickoffTruth(g);
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
    if (kick != null && kt.verified && kick <= now) flags.push('KICKED_OFF');
    if (!kt.verified) flags.push('KICKOFF_TBA');
    var gap = market.status !== 'none' && model.available ? gapOf(home, away, model.home_line, market.home_line) : null;
    var mfav = market.status !== 'none' ? favOf(home, away, market.home_line) : null;
    /* the NFL's availability is the official injury report: a listed starter on
       it is QUESTIONABLE / RULED OUT with the report as the source; a listed
       starter not on it is an EXPECTED STARTER (lib/edgedesk_availability.js) */
    function nflAvail(team, starter, injBlock) {
      if (!AVAIL) return null;
      var row = injBlock && (injBlock.qbs || []).filter(function (x) { return x.starter; })[0];
      if (row) return AVAIL.classify(AVAIL.fromInjuryReport(team, { name: row.name, status: row.status, injury: row.injury, report_date: injBlock.retrieved_at }, 'the official NFL injury report'), { kickoff: g.kickoff, now: now });
      return starter ? AVAIL.classify({ team: team, player: starter, previous_start: true, source: 'the schedule feed’s listed starter' }, { kickoff: g.kickoff, now: now }) : AVAIL.classify({ team: team }, {});
    }
    var p = {
      league: 'nfl', game_id: g.game_id, season: g.season, week: g.week,
      kickoff: g.kickoff, kickoff_text: kt.text, kickoff_state: kt.state, kickoff_verified: kt.verified, kickoff_basis: kt.basis,
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
    p.availability = { home: nflAvail(home, hs, p.injuries.home), away: nflAvail(away, as, p.injuries.away) };
    if ((p.availability.home && p.availability.home.may_assert_uncertainty) || (p.availability.away && p.availability.away.may_assert_uncertainty)) p.flags.push('QB_UNCERTAIN');
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
      var tw = targetWeekOf(cg.season || (all[0] && all[0].season), week);
      var games = all.filter(function (g) { return g.week === week; })
        .map(function (g) { return attachIntegrity(cfbPacket(g, rk, now, links), 'CFB', now, tw); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
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
        /* games this week's content may not use, each with the rule that withholds it */
        withheld: games.filter(function (p) { return !p.publishable; }).map(function (p) { return { game_id: p.game_id, matchup: p.away + ' at ' + p.home, blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [] }; }),
        typical_games_played: medianGamesPlayed(all.filter(function (g) { return g.week === week; })),
        rankings: { as_of: rk.as_of, week: rk.week, top: topTeams(rk, 25), conference_top: rk.conference_top },
        games: games
      };
      snap.sources.push({ id: 'cfb_terminal', path: ARTIFACTS.cfb_games, as_of: cg.generated_at || null, what: 'CFB projections, captured quotes, research and decision status' });
      snap.cfb.matchups = matchupsOf(art.packets, week, now, opts.broadcastChecks);
      if (snap.cfb.matchups) snap.sources.push({ id: 'packets', path: ARTIFACTS.packets, as_of: snap.cfb.matchups.generated_at, what: 'verified matchup research packets and broadcast listings' });
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
      var ntw = targetWeekOf(ns.season, nweek);
      var ngames = ns.games.filter(function (g) { return g.week === nweek; })
        .map(function (g) { return attachIntegrity(nflPacket(g, ns, art.nflInjuries, quotes, now, links), 'NFL', now, ntw); })
        .sort(function (a, b) { return (ts(a.kickoff) || 0) - (ts(b.kickoff) || 0); });
      var nflNamesAll = {};
      ns.games.forEach(function (g) { nflNamesAll[g.home_team] = 1; nflNamesAll[g.away_team] = 1; });
      snap.nfl = {
        season: ns.season || null, week: nweek, generated_at: ns.generated_at || null,
        team_names: Object.keys(nflNamesAll).filter(Boolean).sort(),
        injuries_as_of: art.nflInjuries && art.nflInjuries.retrieved_at || null,
        games_total: ngames.length,
        fresh_markets: ngames.filter(function (p) { return p.market.status === 'current'; }).length,
        withheld: ngames.filter(function (p) { return !p.publishable; }).map(function (p) { return { game_id: p.game_id, matchup: p.away + ' at ' + p.home, blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [] }; }),
        games: ngames
      };
      snap.sources.push({ id: 'nfl_slate', path: ARTIFACTS.nfl_slate, as_of: ns.generated_at || null, what: 'NFL projections and reference lines' });
      if (art.nflInjuries) snap.sources.push({ id: 'nfl_injuries', path: ARTIFACTS.nfl_injuries, as_of: art.nflInjuries.retrieved_at || null, what: 'Official NFL injury report (nflverse)' });
    }
    /* the live-forward record (never a backtest) for the performance review */
    var PF = art.performance && art.performance.live_forward;
    if (PF && PF.overall) snap.performance = { kind: PF.kind, source: PF.source, generated_at: art.performance.generated_at || null,
      overall: PF.overall, by_gap: PF.by_gap_at_close || null, by_reliability: PF.by_reliability || null, look_ahead_guard: PF.look_ahead_guard || null };
    return snap;
  }

  /* THE EDITORIAL MATCHUP PACKETS for the week, each with its broadcast
     RE-VERIFIED NOW: the listing it was built with, plus the owner's
     verification row when there is one (content_engine.broadcast_checks),
     judged at this moment's freshness window — so a broadcast confirmed on
     Tuesday is held on Friday until it is checked again.
     checks: [{ game_id, network, streaming, source_url, source_kind,
                source_name, verified_at, kickoff, reason, status }] */
  function matchupsOf(doc, week, now, checks) {
    if (!GTW_OK || !doc || !Array.isArray(doc.packets) || doc.week !== week) return null;
    var owner = {};
    (checks || []).forEach(function (c) { if (c && c.game_id != null) { var k = String(c.game_id); if (!owner[k] || (ts(c.verified_at) || 0) > (ts(owner[k].verified_at) || 0)) owner[k] = c; } });
    var packets = doc.packets.map(function (m) {
      var bi = m.broadcast_input || {};
      var rec = BCAST.verify(m.game_id, bi.listing || null, owner[m.game_id] || null, { kickoff: bi.schedule_kickoff || m.schedule.kickoff, kickoff_verified: bi.kickoff_verified !== false && m.schedule.kickoff_verified });
      var p = MATCH.applyBroadcast(m, rec, now);
      p.broadcast.verified_text = ts(p.broadcast.verified_at) != null ? whenText(ts(p.broadcast.verified_at)) : null;
      p.broadcast.owner_verified = !!owner[m.game_id];
      return p;
    });
    return { generated_at: doc.generated_at || null, week: doc.week, fixture: doc.fixture || null, league: doc.league || null, counts: doc.counts || null, packets: packets };
  }

  /* THE RESEARCH RECORD a packet is written from (lib/edgedesk_integrity.js):
     the exact numbers the article prints — the fair line, the named book quote
     and its capture time, the gap between them — so the integrity engine checks
     what a reader will see, not a different snapshot */
  function packetRecord(p, sport) {
    if (!INTEG) return null;
    var m = p.model || {}, k = p.market || {};
    return INTEG.record({
      game: { game_id: p.game_id, sport: sport, season: p.season, week: p.week, home: p.home, away: p.away,
        home_conference: p.home_conference || null, away_conference: p.away_conference || null,
        neutral_site: p.neutral_site, venue: p.venue || null, kickoff: p.kickoff, kickoff_state: p.kickoff_state || null,
        start_time_tbd: p.kickoff_tbd == null ? undefined : p.kickoff_tbd },
      model: { available: !!m.available, version: m.version || null, snapshot_id: m.version && m.as_of ? m.version + '@' + m.as_of : null, projected_at: m.as_of || null,
        home_margin: m.available ? -m.home_line : null, total: m.fair_total, home_win_prob: m.home_win_prob,
        away_win_prob: isNum(m.home_win_prob) ? 1 - m.home_win_prob : null,
        projected_score: m.projected ? { home: m.projected.home, away: m.projected.away } : null,
        confidence: m.confidence ? m.confidence.score : null, reliability: isNum(m.reliability) ? m.reliability : null,
        /* the NFL model publishes no reliability score: say so, never assume one */
        reliability_published: sport !== 'NFL' || isNum(m.reliability) },
      market: { available: k.status && k.status !== 'none', snapshot_id: k.captured_at ? (k.book || 'line') + '@' + k.captured_at : (k.status === 'reference' ? 'reference@' + (k.read_at || p.week) : null),
        captured_at: k.captured_at || null, market_type: 'spread', is_main_line: true, home_margin: isNum(k.home_line) ? -k.home_line : null,
        book: k.book || null, source: k.source_label || null, method: k.status === 'reference' ? 'REFERENCE' : null,
        stale: k.status !== 'current', reference: k.status === 'reference' },
      research: p.research_status ? { key: p.research_status.key, label: p.research_status.label, flags: p.regime_flags || [] } : null,
      decision: p.decision || null,
      displayed: { gap: p.gap ? p.gap.points : null, market_claim: k.status === 'current' ? 'current' : null },
      provenance: []
    });
  }
  function summarize(ev) {
    return { status: ev.status, ok: ev.ok,
      blocking: ev.blocking.map(function (c) { return { rule_id: c.rule_id, explanation: c.explanation }; }),
      warnings: ev.warnings.map(function (c) { return c.rule_id; }) };
  }
  function attachIntegrity(p, sport, now, target) {
    var rec = packetRecord(p, sport);
    if (!rec) { p.integrity = { status: 'BLOCKED', ok: false, missing: true, blocking: [{ rule_id: 'INTEGRITY.ENGINE', explanation: 'the integrity engine did not load' }] }; p.publishable = false; return p; }
    var ctx = { now: now, target_week: target };
    var pub = INTEG.evaluate(rec, 'PUBLIC_BRIEF', ctx), ai = INTEG.evaluate(rec, 'AI_CONTEXT', ctx);
    p.record_id = rec.record_id;
    p.integrity = { version: INTEG.VERSION, record_id: rec.record_id, public: summarize(pub), ai: summarize(ai) };
    p.publishable = pub.ok;
    return p;
  }
  function targetWeekOf(season, week, seasonType) {
    if (!SCHED || !isNum(week)) return null;
    var g = { season: season, week: week, season_type: seasonType || null };
    return { key: SCHED.weekKey(g), season: season, week: week };
  }

  /* the week whose games are still to come: the schedule's own week, the
     earliest one that still has an unstarted game inside its own schedule
     cluster (lib/edgedesk_schedule.js currentWeek), so one rescheduled game
     cannot pin the article to an old week */
  function chooseWeek(games, now) {
    if (SCHED) {
      var cw = SCHED.currentWeek((games || []).map(function (g) { return { season: g.season || 0, week: g.week, season_type: g.season_type || null,
        kickoff: g.kickoff, kickoff_state: g.kickoff_state || null, start_time_tbd: g.kickoff_tbd == null ? undefined : g.kickoff_tbd }; }), now);
      if (cw) return cw.week;
    }
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
    var est = { weekly_preview: 'high', upset_watch: 'medium', conference_race: 'medium', market_discrepancy: 'low', injury_impact: 'medium', trending_story: 'medium' }[kind] || 'medium';
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
    if (o.kind === 'market_discrepancy' && (R.games || []).length === 1) return ['market_discrepancy', 'game_deep_dive', 'publisher_custom'];
    if (o.kind === 'game_deep_dive') return ['game_deep_dive', 'publisher_custom'];
    if (o.kind === 'model_performance') return ['model_performance_review'];
    if (o.kind === 'games_to_watch') return ['weekly_games_to_watch', 'weekly_games_to_watch_first_party'];
    if (o.kind === 'weekend_storylines') return ['weekend_storylines', 'publisher_custom'];
    if (o.kind === 'upset_watch') return [o.league + '_weekly_preview', 'upset_watch', 'publisher_custom'];
    if (o.kind === 'conference_race') return ['cfb_weekly_preview', 'conference_race', 'publisher_custom'];
    return [o.league + '_weekly_preview', 'weekend_storylines', 'publisher_custom'];
  }
  function baseFormatOf(o, format) {
    var f = formatsFor(o);
    if (f.indexOf(format) < 0) format = f[0];
    return format === 'publisher_custom' ? f[0] : format;
  }

  function mkOpp(o) {
    o.formats = formatsFor(o);
    o.key = [o.league, o.season, 'w' + o.week, o.kind, o.slug_part || ''].join(':').replace(/:$/, '');
    o.priority = score(o.scores);
    o.scores.total = o.priority;
    delete o.slug_part;
    return o;
  }

  /* the games-to-watch opportunity. opts.games_to_watch: { count, required:
     [game_id], prefer_broad } — the count defaults to the publisher's
     editorial.featured_games, else 5 */
  function gtwOpportunity(snap, L, upcoming, pub, opts, now, firstKick, lastKick, limitations) {
    var G = opts.games_to_watch || {};
    var ed = (pub && pub.editorial) || {};
    var count = isNum(G.count) ? G.count : (isNum(ed.featured_games) ? ed.featured_games : 5);
    var byId = {}; upcoming.forEach(function (p) { byId[String(p.game_id)] = p; });
    var pool = L.matchups.packets.filter(function (m) { return byId[m.game_id] && !m.problems.some(function (x) { return x.code === 'STARTED'; }); });
    var sel = MATCH.select(pool, { count: count, required: G.required || [], prefer_broad: G.prefer_broad != null ? !!G.prefer_broad : ed.prefer_broad !== false });
    /* required games that are not this week's or not cleared at all */
    (G.required || []).forEach(function (id) {
      if (!byId[String(id)] && !sel.report.required_failed.some(function (r) { return r.game_id === String(id); })) sel.report.required_failed.push({ game_id: String(id), reason: 'not cleared for publication this week (see the withheld list)' });
    });
    if (sel.packets.length < Math.min(3, count)) return null;
    var games = sel.packets.map(function (m) { return byId[m.game_id]; });
    var kw = 'college football week ' + L.week + ' games to watch';
    var demand = demandFor(kw, 'weekly_preview', opts.gsc);
    var held = sel.packets.filter(function (m) { return !m.broadcast.publishable; });
    var lim = limitations.slice();
    if (L.matchups.fixture) lim.push('These packets are a HISTORICAL TEST FIXTURE (' + L.matchups.fixture + '); an article built from them can never be published.');
    return mkOpp({
      league: 'cfb', season: L.season, week: L.week, kind: 'games_to_watch',
      title: 'College Football Week ' + L.week + ' Games to Watch',
      angle: 'The week’s ' + numWord(sel.packets.length) + ' games worth a viewer’s Saturday, each with where to watch it, the matchup that decides it, the evidence, EdgeDesk’s projection and an honest read on the upset chance.',
      summary: sel.games.map(function (g) { return g.heading; }).join('; ') + (held.length ? ' — ' + held.length + ' broadcast' + (held.length === 1 ? '' : 's') + ' still to verify' : ''),
      teams: uniq([].concat.apply([], games.map(function (p) { return [p.home, p.away]; }))),
      research: { league: 'cfb', season: L.season, week: L.week, as_of: L.matchups.generated_at || L.generated_at, kind: 'games_to_watch', context: contextOf(snap, 'cfb'),
        games: games, matchups: sel.packets, fixture: L.matchups.fixture || null,
        selection: { count: count, games: sel.games, rejected: sel.rejected, report: sel.report, basis: 'EDMatchup.select: audience interest, football significance, evidence quality, matchup advantage, upset potential, reliability, publisher fit and timeliness; one storyline per game; a market gap is capped context, never a selector' },
        upsets: [], races: [], limitations: lim },
      sources: sourcesOf(snap, 'cfb').concat(gtwSources(sel.packets)),
      demand: demand,
      scores: {
        search_relevance: { score: demand.measured ? 92 : 82, basis: demand.measured ? 'measured Search Console exposure for the query' : 'estimate: “games to watch” and “where to watch” are recurring weekly queries' },
        timeliness: timelinessScore(firstKick, now),
        audience_interest: { score: clamp(Math.round(sel.games.reduce(function (a, g) { return a + g.parts.audience; }, 0) / Math.max(1, sel.games.length)), 0, 100), basis: 'mean audience-interest score of the featured games' },
        research_availability: { score: Math.round(100 * sel.games.length / Math.max(1, count)), basis: sel.games.length + ' of ' + count + ' requested games pass the six-question reasoning gate' },
        editorial_relevance: { score: 95, basis: 'football evidence for every game, not a list of projections' },
        publisher_fit: publisherFit(pub, 'cfb', 'weekly_preview', 'broad'),
        research_confidence: { score: clamp(Math.round(sel.games.reduce(function (a, g) { return a + g.parts.reliability; }, 0) / Math.max(1, sel.games.length)), 0, 100), basis: 'mean research reliability of the featured games' }
      },
      expires_at: iso(Math.min.apply(null, games.map(function (p) { return ts(p.kickoff) || lastKick; })))
    });
  }
  function gtwSources(ms) {
    var out = [], seen = {};
    /* a source the database can hold names its page and its time; one
       without both stays in the packet, never in the cited list */
    ms.forEach(function (m) { (m.sources || []).forEach(function (x) { var k = x.name + '|' + (x.url || ''); if (seen[k] || !/^https:\/\//.test(x.url || '') || !x.as_of) return; seen[k] = 1; out.push({ kind: 'research_source', name: x.name, url: x.url, as_of: x.as_of, what: x.what || null }); }); });
    return out;
  }

  /* opts: { now, publisher, news: [items from matchNews], gsc: {keyword: {impressions, clicks, days}} } */
  function discover(snap, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    var pub = opts.publisher || null;
    var out = [];

    ['cfb', 'nfl'].forEach(function (league) {
      var L = snap[league]; if (!L || !L.games || !L.games.length) return;
      /* only games the integrity engine clears for publication (PUBLIC_BRIEF):
         a TBA kickoff, a look-ahead week, a clock fault or a faulted market
         keeps a game out of every article; L.withheld says why */
      var upcoming = L.games.filter(function (p) { return p.flags.indexOf('KICKED_OFF') < 0 && p.model.available && p.publishable !== false; });
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

      /* 1 · weekly preview: one central storyline and its supporting games
         (storyScore), never the six biggest numbers */
      var SL = storyline(upcoming, league);
      var feature = SL ? [SL.central].concat(SL.supporting) : ranked.slice(0, 5).map(function (x) { return x.p; });
      var slc = SL ? { type: SL.type, central_id: SL.central.game_id, supporting_ids: SL.supporting.map(function (p) { return p.game_id; }), why: SL.why, ranked: SL.ranked.slice(0, 12),
        basis: storyScore(SL.central).basis } : null;
      var kw = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' predictions';
      var demand = demandFor(kw, 'weekly_preview', opts.gsc);
      var researchAvail = Math.round(100 * upcoming.length / Math.max(1, L.games_total));
      out.push(mkOpp({
        league: league, season: L.season, week: L.week, kind: 'weekly_preview',
        title: Lname + ' Week ' + L.week + ' Predictions',
        angle: 'A broad preview of the week’s biggest games: EdgeDesk’s projections, the closest calls and the realistic upsets, explained for fans.',
        summary: feature.length + ' featured games from ' + upcoming.length + ' projected; headliner ' + feature[0].away + ' at ' + feature[0].home + '.',
        teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
        research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekly_preview', context: contextOf(snap, league), games: feature, storyline: slc, upsets: upsetsOf(league, upcoming).slice(0, 3), races: league === 'cfb' ? conferenceRaces(snap).slice(0, 3) : [], limitations: limitations },
        sources: sourcesOf(snap, league),
        demand: demand,
        formats: [league + '_weekly_preview', 'publisher_custom'],
        scores: {
          search_relevance: { score: demand.measured ? 95 : 85, basis: demand.measured ? 'measured Search Console exposure for the query' : 'estimate: “week N predictions” is a recurring high-intent query pattern' },
          timeliness: timelinessScore(firstKick, now),
          audience_interest: { score: clamp(50 + feature.reduce(function (a, p) { return a + storyScore(p).editorial_interest; }, 0) / 10, 0, 100) | 0, basis: 'featured games include ' + sentenceList(uniq([].concat.apply([], feature.map(function (p) { return storyScore(p).why; }))).slice(0, 4)) },
          research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games have a current EdgeDesk projection' },
          editorial_relevance: { score: 90, basis: 'projections for every featured game, explained as research rather than picks' },
          publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
          research_confidence: { score: confidenceScore(conf, L, league), basis: confidenceBasis(conf, L, league) }
        },
        expires_at: iso(lastKick)
      }));

      /* 1b · biggest weekend storylines, and a deep dive on the central game */
      if (SL && SL.supporting.length >= 2) {
        var kwS = (league === 'cfb' ? 'college football week ' : 'nfl week ') + L.week + ' storylines';
        var dS = demandFor(kwS, 'weekly_preview', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'weekend_storylines',
          title: 'The Biggest ' + Lname + ' Storylines of Week ' + L.week,
          angle: 'The week’s few stories that matter most, chosen for their stakes and how firmly the numbers stand behind them — not for the biggest gap.',
          summary: 'Lead: ' + SL.central.away + ' at ' + SL.central.home + ' (' + SL.type.replace(/_/g, ' ') + '); ' + SL.supporting.length + ' supporting games.',
          teams: uniq([].concat.apply([], feature.map(function (p) { return [p.home, p.away]; }))),
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'weekend_storylines', context: contextOf(snap, league), games: feature, storyline: slc, upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: dS,
          scores: {
            search_relevance: { score: dS.measured ? 85 : 70, basis: dS.measured ? 'measured Search Console exposure' : 'estimate: weekly “storylines” queries recur all season' },
            timeliness: timelinessScore(firstKick, now),
            audience_interest: { score: clamp(SL.central_score.editorial_interest + 10, 0, 100), basis: 'the lead game: ' + (sentenceList(SL.why) || 'the week’s top story score') },
            research_availability: { score: researchAvail, basis: upcoming.length + ' of ' + L.games_total + ' games cleared for publication' },
            editorial_relevance: { score: 92, basis: 'one central story with supporting games, not a list of summaries' },
            publisher_fit: publisherFit(pub, league, 'weekly_preview', 'broad'),
            research_confidence: { score: SL.central_score.research_reliability, basis: 'the lead game’s research reliability' }
          },
          expires_at: iso(lastKick)
        }));
      }
      if (SL && SL.central_score.editorial_interest >= 45 && SL.central_score.research_reliability >= 60) {
        var c0 = SL.central, kwD = slugify(c0.away + ' vs ' + c0.home).replace(/-/g, ' ') + ' prediction';
        var dD = demandFor(kwD, 'market_discrepancy', opts.gsc);
        out.push(mkOpp({
          league: league, season: L.season, week: L.week, kind: 'game_deep_dive', slug_part: String(c0.game_id),
          title: c0.away + ' vs. ' + c0.home + ' Prediction: Inside the Numbers',
          angle: 'The week’s central game, taken apart: what the model expects, what it is built on and what would change it.',
          summary: (c0.display.fair || 'Projection on file') + '; ' + (sentenceList(SL.why) || 'the week’s top story score') + '.',
          teams: [c0.home, c0.away],
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'game_deep_dive', context: contextOf(snap, league), games: [c0], upsets: [], races: [], limitations: limitations },
          sources: sourcesOf(snap, league), demand: dD,
          scores: {
            search_relevance: { score: dD.measured ? 80 : 55, basis: dD.measured ? 'measured Search Console exposure' : 'estimate: a marquee single-game query' },
            timeliness: timelinessScore(ts(c0.kickoff), now),
            audience_interest: { score: clamp(SL.central_score.editorial_interest + 15, 0, 100), basis: sentenceList(SL.why) || 'the week’s central game' },
            research_availability: { score: 90, basis: 'a full research packet for the game' },
            editorial_relevance: { score: 85, basis: 'explains the projection rather than summarising it' },
            publisher_fit: publisherFit(pub, league, 'weekly_preview', 'narrow'),
            research_confidence: { score: SL.central_score.research_reliability, basis: 'the game’s research reliability' }
          },
          expires_at: iso(ts(c0.kickoff))
        }));
      }

      /* 1c · FIVE GAMES TO WATCH (docs/content-engine/GAMES_TO_WATCH.md):
         the featured set is chosen by MATCH.select from games whose packet
         answers all six questions, never by the largest gaps */
      if (league === 'cfb' && L.matchups) {
        var gtw = gtwOpportunity(snap, L, upcoming, pub, opts, now, firstKick, lastKick, limitations);
        if (gtw) out.push(gtw);
      }

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
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'upset_watch', context: contextOf(snap, league), games: ups.slice(0, 4), upsets: ups.slice(0, 4), races: [], limitations: limitations },
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
            research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'conference_race', conference: cname, conference_top: L.rankings.conference_top[cname] || [], context: contextOf(snap, league), games: gs, upsets: [], races: gs, limitations: limitations },
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
      /* AUDIT 2026-10-08 §5 and docs/system-integrity/PERFORMANCE.md: the largest
         gaps are where the model has been least accurate (7+ pts at the close:
         MAE 15.4 vs the close's 10.4 live, 14.7 vs 12.4 in the backtest). A gap
         earns a public story only when research cleared it (WORTH RESEARCHING or
         VERIFIED MAJOR); an unverified 7+ gap is investigated internally
         (investigations()), never promoted. Ranked by the story score, not size. */
      var cleared = function (p) { var k = p.research_status && p.research_status.key; return league !== 'cfb' || k === 'WORTH_RESEARCHING' || k === 'VERIFIED_MAJOR'; };
      var gaps = upcoming.filter(function (p) { return p.gap && p.gap.points >= RESEARCH_GAP && p.market.status !== 'none' && cleared(p); })
        .sort(function (a, b) { var fa = a.market.status === 'current' ? 1 : 0, fb = b.market.status === 'current' ? 1 : 0; return fb - fa || storyScore(b).story - storyScore(a).story || b.gap.points - a.gap.points; });
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
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'market_discrepancy', context: contextOf(snap, league), games: gaps.slice(0, 5), upsets: [], races: [], limitations: limitations },
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
        var verified = p.verified === true;
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
          research: { league: league, season: L.season, week: L.week, as_of: L.generated_at, kind: 'trending_story', news: [n], context: contextOf(snap, league), games: games.slice(0, 2), upsets: [], races: [], limitations: limitations },
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

    /* 7 · the weekly model performance review: the live-forward record only,
       and only once the sample is past "too early" */
    var PF = snap.performance;
    if (PF && PF.overall && PF.overall.n >= 50 && snap.cfb) {
      var Lc = snap.cfb, kwP = 'college football model accuracy week ' + Lc.week;
      var dP = demandFor(kwP, 'market_discrepancy', opts.gsc);
      out.push(mkOpp({
        league: 'cfb', season: Lc.season, week: Lc.week, kind: 'model_performance',
        title: 'How EdgeDesk’s College Football Model Has Done Through Week ' + Lc.week,
        angle: 'The published numbers graded against what happened: wins, misses and the sample size, never a profit claim.',
        summary: PF.overall.n + ' graded games; ATS ' + (PF.overall.ats.pct == null ? '—' : PF.overall.ats.pct + '%') + ' against the close.',
        teams: [],
        research: { league: 'cfb', season: Lc.season, week: Lc.week, as_of: PF.generated_at, kind: 'model_performance', context: contextOf(snap, 'cfb'), games: [], upsets: [], races: [], performance: PF, limitations: [] },
        sources: [{ kind: 'edgedesk_record', path: 'football/validation/integrity_performance.json', url: SITE + '/record.html', as_of: PF.generated_at || iso(now) }],
        demand: dP,
        scores: {
          search_relevance: { score: dP.measured ? 70 : 40, basis: dP.measured ? 'measured Search Console exposure' : 'estimate: a niche accountability query' },
          timeliness: { score: 70, basis: 'weekly, after the week’s games are graded' },
          audience_interest: { score: 45, basis: 'accountability content builds trust more than traffic' },
          research_availability: { score: 95, basis: PF.overall.n + ' graded live-forward games' },
          editorial_relevance: { score: 90, basis: 'reports misses as plainly as wins' },
          publisher_fit: publisherFit(pub, 'cfb', 'market_discrepancy', 'broad'),
          research_confidence: { score: PF.overall.n >= 200 ? 75 : 55, basis: PF.overall.sample }
        },
        expires_at: iso(now + 7 * 86400000)
      }));
    }

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
      case 'games_to_watch':
        b.primary_keyword = l + ' week ' + w + ' games to watch';
        b.secondary_keywords = [l + ' week ' + w + ' tv schedule', 'where to watch ' + (head ? head.replace(' vs. ', ' vs ') : l), l + ' week ' + w + ' predictions', l + ' week ' + w + ' upsets'];
        b.headline = gtwHeadline(o, 'publisher', 'standard');
        b.alternatives = [gtwHeadline(o, 'publisher', 'listicle'), gtwHeadline(o, 'publisher', 'where_to_watch')];
        b.structure = ['Intro: the week in one paragraph', 'The schedule at a glance (times ET/CT, verified TV)', 'One section per game: where to watch, why it matters, the key matchup, EdgeDesk’s projection, upset potential, what to watch', 'How to read projections (not picks)', 'What the numbers can’t see', 'Bottom line'];
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
    else if (o.kind === 'games_to_watch') m = 'Week ' + o.week + ' college football games to watch: TV and streaming, kickoff times, the matchups that decide them and the real upset cases.';
    else if (o.kind === 'injury_impact') m = 'What the injury report says about ' + (R.focus && R.focus.player) + ', and how EdgeDesk’s projection changes if he can’t play. Research, not picks.';
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
  /* QUARTERBACKS (docs/system-integrity/AUDIT.md §6). The Week 6 article said,
     game after game, that neither starter was confirmed — because no college
     team announces a starter before kickoff and the writer read that silence
     as uncertainty. Now: an EXPECTED STARTER gets no sentence at all; a
     dropback split is printed as the measured fact it is; uncertainty is
     written only from a sourced report (lib/edgedesk_availability.js), with
     the source and its date. */
  function qbLine(p) {
    if (p.league !== 'cfb' || !AVAIL) return null;
    var out = [];
    ['away', 'home'].forEach(function (s) {
      var c = p.availability && p.availability[s]; if (!c) return;
      if ((c.may_assert_uncertainty && c.verification === 'SOURCED') || c.measured_note) { var t = AVAIL.sentence(c); if (t) out.push(t); }
    });
    return out.length ? 'Quarterback watch: ' + out.join(' ') : null;
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
      'When we compare the model with a sportsbook line, we say where the line came from and when it was captured.',
      o.league === 'cfb' ? 'Rankings shown with team names (such as No. 6) are EdgeDesk’s own power ratings, not the AP poll.' : null);
  }

  function upsetsSection(o, gamesShown) {
    var ups = (o.research.upsets || []).filter(function (p) { return o.kind === 'upset_watch' || gamesShown.indexOf(p.game_id) < 0 || true; });
    if (!ups.length) return null;
    var lines = ups.slice(0, 3).map(function (p) {
      var favRank = p.model.favorite === p.home ? p.home_rank : p.away_rank;
      var rankTxt = p.league === 'cfb' && isNum(favRank) && favRank <= 25 ? ' (No. ' + favRank + ' in EdgeDesk’s ratings)' : '';
      var s = '- **' + p.model.underdog + '** over ' + p.model.favorite + rankTxt + ': the model gives ' + p.model.underdog + ' a ' + p.model.dog_win_pct + '% chance.';
      if (p.favorite_flip && p.market.status !== 'none') s += ' The ' + (p.market.status === 'current' ? 'current betting line' : 'last captured line') + ' has the favorite the other way around.';
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
    var qbN = gs.filter(function (p) { return p.flags.indexOf('QB_UNCERTAIN') >= 0; }).length;
    if (o.league === 'cfb' && qbN) bullets.push('**Quarterbacks:** in ' + numWord(qbN) + ' of the games above, a reported quarterback situation (named in that game’s section, with its source) could move the number.');
    else if (o.league === 'cfb') bullets.push('**Quarterbacks:** college teams seldom name a starter before kickoff, so EdgeDesk reads each starter from recent play. A late change would move a projection more than almost anything else.');
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

  /* market discrepancy, one game */
  function mdSections(o) {
    var p = o.research.games[0];
    var s = {};
    var verified = p.verified === true;
    s.intro = para(p.away + (p.neutral_site ? ' vs. ' : ' at ') + p.home + (p.kickoff_text ? ' (' + p.kickoff_text + ')' : '') + ' is one of the games where EdgeDesk’s number and the betting line disagree the most this week.',
      'EdgeDesk’s model has ' + p.display.fair + '; ' + (p.market.status === 'current' ? 'the betting line is ' : 'the last line EdgeDesk captured was ') + p.display.market + '.',
      verified ? 'Here is where the gap comes from, and what would have to be true for the market to be right.' : 'EdgeDesk’s own checks haven’t verified this gap yet, and at this size missing information is a more likely explanation than a market mistake. Here is what we know and what we don’t.');
    s.the_gap = para('The difference is ' + oneDp(p.gap.points) + ' points, toward ' + p.gap.toward + '.',
      p.market.status === 'current' ? 'The line was captured ' + (p.market.captured_text || '') + ', inside EdgeDesk’s three-hour freshness window.' : 'That line is older than EdgeDesk’s three-hour freshness rule, so the market may have moved since.',
      fanLine(p), scoreLine(p));
    s.why_they_differ = para(driverLine(p) || 'EdgeDesk’s projection is built from team ratings, home field and matchup data.',
      matchupLine(p),
      'When the model and the market disagree, the disagreement usually sits in one of those inputs: either EdgeDesk rates a team differently, or the market is pricing something the model can’t see.');
    s.how_to_read = howToRead(o);
    var risks = (p.risks || []).slice(0, 2);
    s.market_case = para('There are good reasons the market could be right.',
      qbLine(p) ? qbLine(p).replace(/^What could change it: /, '') : null,
      risks.length ? 'EdgeDesk’s research also flags: ' + risks.join(' ') : null,
      p.price_note ? 'EdgeDesk’s pricing note: ' + p.price_note : null,
      verified ? null : 'The gap failed EdgeDesk’s verification check, which is exactly the case where the market usually knows something the model doesn’t.');
    s.limits = limitsSection(o);
    s.conclusion = para('The takeaway: EdgeDesk and the market see ' + p.away + '–' + p.home + ' differently by ' + oneDp(p.gap.points) + ' points.',
      'That is a research question worth following through the week, not a bet. If the quarterback news or the line changes, the answer changes with it.');
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
      s.research = '**Next game: ' + gameHeading(p) + '**\n\n' + para(fanLine(p), scoreLine(p), driverLine(p), scTxt, marketLine(p), p.league === 'cfb' ? qbLine(p) : injuryLine(p), confLine(p),
        'A projection is not a bet: it is EdgeDesk’s estimate of what is likely, not a judgment about any price.');
    }
    s.unknowns = para('What we don’t know: final game-day status, how a replacement would actually play, and whether the betting market has already moved.',
      'EdgeDesk’s numbers update as the official report and captured prices do.');
    s.conclusion = para('The report is the news; the projection is EdgeDesk’s estimate of what it might mean. Neither is a pick.');
    return s;
  }

  /* ======================================================================
     STORY RANKING (docs/system-integrity/TEMPLATES.md §1)
     Four separate questions, never folded into one another:
       editorial_interest     would a fan want to read about this game?
       statistical_surprise   is there a RESEARCH-CLEARED surprise in it?
       research_reliability   can EdgeDesk stand behind its numbers here?
       betting_actionable     did the decision engine approve a price? —
                              reported, never part of a story's score: an
                              article is research, not a betting card.
     A big gap earns surprise only when research cleared it (WORTH
     RESEARCHING or VERIFIED MAJOR), and surprise is weighted by
     reliability, so a large discrepancy on weak data never leads a story:
     it goes to investigations() instead.
     ====================================================================== */
  function storyScore(p) {
    var ei = 0, why = [];
    var top = function (r) { return isNum(r) && r <= 25; };
    if (p.league === 'cfb') {
      if (top(p.home_rank) && top(p.away_rank)) { ei += 45; why.push('two top-25 teams'); }
      else if (top(p.home_rank) || top(p.away_rank)) { ei += 22; why.push('a top-25 team'); }
      if ((isNum(p.home_rank) && p.home_rank <= 10) || (isNum(p.away_rank) && p.away_rank <= 10)) { ei += 10; why.push('a top-10 team'); }
      if (p.conference_game && POWER4.indexOf(p.home_conference) >= 0) { ei += 10; why.push('a power-conference game'); }
      if (p.fcs) ei -= 30;
    } else {
      if (p.divisional) { ei += 12; why.push('a division game'); }
      var win = function (rec) { if (!rec) return false; var a = rec.split('-'); return +a[0] > +a[1]; };
      if (win(p.home_record) && win(p.away_record)) { ei += 25; why.push('two winning teams'); }
      else if (win(p.home_record) || win(p.away_record)) ei += 10;
    }
    if (p.model.available && isNum(p.model.fav_win_pct)) { var close = 1 - Math.abs(p.model.fav_win_pct - 50) / 50; ei += 30 * close; if (close > 0.6) why.push('a close projection'); }
    var rk = p.research_status && p.research_status.key, gap = p.gap && p.market && p.market.status === 'current' ? p.gap.points : null;
    var ss = 0, sw = [];
    if (rk === 'VERIFIED_MAJOR') { ss = 85; sw.push('a verified major disagreement with the market'); }
    else if (rk === 'WORTH_RESEARCHING' && isNum(gap)) { ss = clamp(30 + 8 * (gap - 2), 30, 70); sw.push('a ' + oneDp(gap) + '-point research-grade disagreement with a current price'); }
    if (p.favorite_flip && (rk === 'WORTH_RESEARCHING' || rk === 'VERIFIED_MAJOR')) { ss += 10; sw.push('the model and the market name different favorites'); }
    if (p.model.available && isNum(p.model.dog_win_pct) && p.model.dog_win_pct >= 30 && p.model.dog_win_pct <= 46) { ss += 20 * (p.model.dog_win_pct - 30) / 16; sw.push('a ' + p.model.dog_win_pct + '% underdog'); }
    /* an unmeasured reliability or confidence counts as 40 — never as good —
       and the score says it was unmeasured (no league is assumed reliable) */
    var relM = isNum(p.model.reliability), confM = p.model.confidence && isNum(p.model.confidence.score);
    var rel = relM ? p.model.reliability : 40;
    var conf = confM ? p.model.confidence.score : 40;
    var rr = 0.6 * rel + 0.4 * conf;
    if (p.flags.indexOf('QB_UNCERTAIN') >= 0) rr -= 10;
    if (p.flags.indexOf('LOW_CONFIDENCE') >= 0) rr -= 25;
    rr = clamp(Math.round(rr), 0, 100);
    var ba = p.decision && p.decision.key === 'BET' ? 100 : 0;
    var e = clamp(Math.round(ei), 0, 100), sur = clamp(Math.round(ss), 0, 100);
    var story = Math.round(0.55 * e + 0.25 * sur * rr / 100 + 0.20 * rr);
    if (p.publishable === false) story = 0;
    return { story: story, editorial_interest: e, statistical_surprise: sur, research_reliability: rr, reliability_measured: relM, confidence_measured: confM, betting_actionable: ba,
      why: why.concat(sw), basis: 'story = 0.55 × editorial interest + 0.25 × research-cleared surprise × reliability + 0.20 × reliability; betting actionability is reported, never scored' };
  }
  function storyline(games, league) {
    var ranked = games.map(function (p) { return { p: p, s: storyScore(p) }; }).filter(function (x) { return x.s.story > 0; })
      .sort(function (a, b) { return b.s.story - a.s.story || ((ts(a.p.kickoff) || 0) - (ts(b.p.kickoff) || 0)); });
    if (!ranked.length) return null;
    var c = ranked[0], type = 'marquee';
    if (c.s.statistical_surprise >= 60 && c.s.research_reliability >= 70) type = 'model_vs_market';
    else if (c.p.model.dog_win_pct >= 38 && c.s.editorial_interest >= 40) type = 'upset';
    else if (c.p.conference_game && league === 'cfb' && c.s.editorial_interest >= 50) type = 'conference';
    /* supporting games: the next by story score, no team twice */
    var seen = {}; seen[c.p.home] = 1; seen[c.p.away] = 1;
    var support = [];
    ranked.slice(1).forEach(function (x) { if (support.length >= 4 || seen[x.p.home] || seen[x.p.away]) return; seen[x.p.home] = 1; seen[x.p.away] = 1; support.push(x.p); });
    return { type: type, central: c.p, central_score: c.s, supporting: support,
      why: c.s.why.slice(0, 3), ranked: ranked.map(function (x) { return { game_id: x.p.game_id, story: x.s.story, editorial_interest: x.s.editorial_interest,
        statistical_surprise: x.s.statistical_surprise, research_reliability: x.s.research_reliability, betting_actionable: x.s.betting_actionable }; }) };
  }
  /* the internal list: big gaps that did NOT clear research — investigated by
     a person, never promoted (docs/system-integrity/PERFORMANCE.md) */
  function investigations(snap) {
    var out = [];
    ['cfb', 'nfl'].forEach(function (lg) {
      var L = snap && snap[lg]; if (!L) return;
      L.games.forEach(function (p) {
        var k = p.research_status && p.research_status.key;
        var big = p.gap && p.gap.points >= 7;
        if ((big && k !== 'VERIFIED_MAJOR') || k === 'INVESTIGATE' || k === 'MARKET_FAULT' || k === 'DATA_FAULT' || p.publishable === false)
          out.push({ league: lg, game_id: p.game_id, matchup: p.away + ' at ' + p.home, research_status: k || null,
            gap: p.gap ? p.gap.points : null, reason: k === 'INVESTIGATE' ? 'a large gap the integrity gate has not cleared'
              : (k === 'MARKET_FAULT' || k === 'DATA_FAULT' ? 'faulted data' : (p.publishable === false ? 'withheld from publication by the integrity engine' : 'a 7+ point gap without verification')),
            blocking: p.integrity && p.integrity.public ? p.integrity.public.blocking : [], publishable: false });
      });
    });
    return out;
  }

  /* ---------------------------------------------------- the new templates */
  function storylinesSections(o) {
    var R = o.research, L0 = R.storyline || {}, s = {};
    var byId = {}; (R.games || []).forEach(function (p) { byId[p.game_id] = p; });
    var L = { central: byId[L0.central_id] || (R.games || [])[0] || null, supporting: (L0.supporting_ids || []).map(function (id) { return byId[id]; }).filter(Boolean) };
    var items = [];
    if (L.central) items.push(L.central);
    (L.supporting || []).forEach(function (p) { if (items.length < 5 && items.indexOf(p) < 0) items.push(p); });
    var lg = o.league === 'cfb' ? 'college football' : 'NFL';
    s.intro = para('Every ' + lg + ' weekend has a few stories that will still be talked about on Monday. These are Week ' + o.week + '’s, chosen for how much they matter to the season and how firmly EdgeDesk’s numbers stand behind them, not for how big a number looks.',
      L.central ? 'The lead: ' + L.central.away + (L.central.neutral_site ? ' vs. ' : ' at ') + L.central.home + (L.central.kickoff_text ? ' (' + L.central.kickoff_text + ')' : '') + '.' : null);
    s.storylines = items.map(function (p, i) {
      var why = storyScore(p).why;
      return '### ' + (i + 1) + '. ' + gameHeading(p) + '\n\n' + para(why.length ? 'Why it matters: ' + sentenceList(why.slice(0, 3)) + '.' : null,
        fanLine(p), scoreLine(p), i === 0 ? driverLine(p) : null, i === 0 ? matchupLine(p) : null, marketLine(p), qbLine(p));
    }).join('\n\n');
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('Each of these will look different by kickoff as news and prices arrive. EdgeDesk updates its numbers as they do; none of this is a pick.');
    return s;
  }
  function deepDiveSections(o) {
    var p = (o.research.games || [])[0], s = {};
    if (!p) return s;
    s.intro = para(gameHeading(p).replace(/ — /, ', ') + ' is the game this piece takes apart: what EdgeDesk’s model expects, what the numbers are built on, and what would change them.');
    s.the_matchup = para(p.away + ' ' + (p.neutral_site ? 'and' : 'travels to') + ' ' + p.home + (p.venue ? ' (' + p.venue + ')' : '') + '.',
      p.league === 'cfb' && (isNum(p.home_rank) || isNum(p.away_rank)) ? 'In EdgeDesk’s power ratings, ' + [isNum(p.away_rank) ? p.away + ' is No. ' + p.away_rank : null, isNum(p.home_rank) ? p.home + ' is No. ' + p.home_rank : null].filter(Boolean).join(' and ') + '.' : null,
      matchupLine(p));
    s.numbers = para(fanLine(p), scoreLine(p), confLine(p), marketLine(p));
    s.why_they_differ = para(driverLine(p) || 'EdgeDesk’s projection is built from team ratings, home field and matchup data.');
    var risks = (p.risks || []).slice(0, 2);
    s.what_could_change = para(qbLine(p), p.league === 'nfl' ? injuryLine(p) : null, risks.length ? 'EdgeDesk’s research also flags: ' + risks.join(' ') : null) || 'No reported development is on file that would move this number.';
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('The takeaway: ' + (p.display.fair ? 'EdgeDesk has ' + p.display.fair + '. ' : '') + 'That is an estimate with real uncertainty, not a pick, and it moves if the news or the line does.');
    return s;
  }
  function raceSections(o) {
    var R = o.research, s = {};
    s.intro = para('The ' + R.conference + ' race runs through ' + sentenceList((R.games || []).map(function (p) { return p.away + ' at ' + p.home; })) + ' this week.');
    s.race = para((R.conference_top || []).length ? 'In EdgeDesk’s ratings, ' + sentenceList(R.conference_top.slice(0, 3)) + ' are the conference’s three highest-rated teams.' : null,
      'EdgeDesk doesn’t carry a conference standings feed, so this reads the race through ratings and projections, not tiebreakers.');
    s.games = (R.games || []).map(function (p) { return capsule(p, { short: true }); }).join('\n\n');
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = para('These games shape the race more than any other in the conference this week. Projections are estimates, not picks.');
    return s;
  }
  function upsetOnlySections(o) {
    var s = {};
    s.intro = ctxIntro(o);
    s.upsets = upsetsSection(o, []);
    s.how_to_read = howToRead(o);
    s.limits = limitsSection(o);
    s.conclusion = conclusionSection(o);
    return s;
  }
  function performanceSections(o) {
    var P = o.research.performance || {}, ov = P.overall || {}, s = {};
    var ats = ov.ats || {}, sp = ov.spread || {}, clv = ov.clv || {};
    s.intro = para('Every week EdgeDesk grades the numbers it published before kickoff against what happened. This is that report for the ' + (o.league === 'cfb' ? 'college' : 'NFL') + ' model through Week ' + o.week + ': the wins and the misses, with the sample size beside every figure.');
    s.record = para(isNum(ov.n) ? 'Graded games: ' + ov.n + ' (' + String(ov.sample || '').toLowerCase() + ').' : null,
      isNum(sp.model_mae_paired) ? 'EdgeDesk’s average miss on the final margin was ' + oneDp(sp.model_mae_paired) + ' points, against ' + oneDp(sp.close_mae_paired) + ' for the closing line on the same games.' : null,
      isNum(ats.pct) ? 'Against the closing number, EdgeDesk’s side covered ' + oneDp(ats.pct) + '% of the time (95% interval ' + ats.ci95.join('–') + '%); about 52.4% is needed to break even at standard prices.' : null,
      isNum(clv.avg_points) ? 'Closing-line value averaged ' + oneDp(Math.abs(clv.avg_points)) + ' points ' + (clv.avg_points >= 0 ? 'in EdgeDesk’s favor' : 'against EdgeDesk') + ' over ' + clv.n + ' games with a captured close.' : null);
    var g7 = P.by_gap && P.by_gap['7+ pts'];
    s.where_it_missed = g7 && g7.spread && isNum(g7.spread.model_mae_paired) ? para('The biggest disagreements with the market were the weakest: in games where EdgeDesk was 7 or more points from the close, its average miss was ' + oneDp(g7.spread.model_mae_paired) + ' points, against ' + oneDp(g7.spread.close_mae_paired) + ' for the close.', 'That is why EdgeDesk treats a big gap as a question to investigate, not as a strong opinion.') : null;
    s.calibration = ov.win_probability && isNum(ov.win_probability.brier) ? para('Win probabilities scored a Brier score of ' + ov.win_probability.brier.toFixed(3) + ' (0.25 is what a coin flip scores; lower is better).') : null;
    s.how_to_read = para('A season’s results are a small sample. A record inside its interval is consistent with no edge at all, and EdgeDesk does not claim one on this evidence. A projection is not a bet.');
    s.conclusion = para('The numbers above are the record as published, never re-graded with hindsight. EdgeDesk will keep reporting them every week.');
    return s;
  }

  /* ======================================================================
     FIVE GAMES TO WATCH — the writers (docs/content-engine/GAMES_TO_WATCH.md)
     Every sentence below is assembled from a verified packet fact or a
     packet argument; the writer adds connective words, never a number. The
     publisher edition reads each fact's `text`, EdgeDesk's own edition its
     `alt`, in a different order under different labels, so the two articles
     share the evidence and not the sentences.
     ====================================================================== */
  var GTW_PARTS = [
    { key: 'where', re: /\*\*(?:Where to watch|Kickoff and broadcast)\b/ },
    { key: 'why', re: /\*\*(?:Why it matters|The stakes)\b/ },
    { key: 'matchup', re: /\*\*(?:The key matchup|Where it’s decided|Where it's decided)\b/ },
    { key: 'model', re: /\*\*(?:EdgeDesk’s projection|EdgeDesk's projection|EdgeDesk’s number|EdgeDesk's number)\b/ },
    { key: 'upset', re: /\*\*(?:Upset potential|If the underdog wins|Why there’s no upset case|Why there's no upset case)\b/ },
    { key: 'watch', re: /\*\*(?:What to watch|Watch for)\b/ }
  ];
  var BROADCAST_SOURCE_TEXT = { 'ESPN scoreboard': 'ESPN’s public scoreboard listing' };
  function gtwPairs(o) {
    var R = o.research || {}, ms = R.matchups || [];
    var byId = {}; (R.games || []).forEach(function (p) { byId[String(p.game_id)] = p; });
    return ms.map(function (m) { return { m: m, p: byId[m.game_id] || null }; }).filter(function (x) { return x.p; });
  }
  function gtwClock(s) {
    /* "3:30 PM EDT" → "3:30 p.m. ET"; noon is "noon" */
    var m = /^(\d{1,2}):(\d{2}) (AM|PM) ([A-Z])[DS]T$/.exec(String(s || ''));
    if (!m) return s || null;
    if (m[1] === '12' && m[2] === '00' && m[3] === 'PM') return 'noon ' + m[4] + 'T';
    return m[1] + (m[2] === '00' ? '' : ':' + m[2]) + ' ' + (m[3] === 'AM' ? 'a.m.' : 'p.m.') + ' ' + m[4] + 'T';
  }
  var DAYS_FULL = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  function gtwDate(d) {
    var m = /^(\w{3}), (\w{3}) (\d{1,2})$/.exec(String(d || ''));
    return m ? (DAYS_FULL[m[1]] || m[1]) + ', ' + (MONTHS_AP[m[2]] || m[2]) + ' ' + m[3] : d;
  }
  function gtwWhen(m) {
    var t = m.schedule && m.schedule.times;
    if (!t || !m.schedule.kickoff_verified) return null;
    return { date: gtwDate(t.date), et: gtwClock(t.et), ct: gtwClock(t.ct) };
  }
  function gtwFact(m, id) { return (m.facts || []).filter(function (f) { return f.id === id; })[0] || null; }
  function gtwFacts(m, pred) { return (m.facts || []).filter(pred); }
  function gtwSay(f, ed) { return f ? (ed === 'first_party' ? f.alt : f.text) : null; }
  function gtwVenue(m) { var v = m.identity.venue || (m.schedule && m.schedule.venue); return v ? (m.identity.neutral_site ? v + ' (neutral site)' : v) : null; }
  function gtwResearchUrl(m) { return SITE + '/research/cfb/#/game/' + encodeURIComponent(m.game_id); }
  function gtwStory(m) {
    var A = m.arguments || {};
    if (A.upset && A.upset.credible) return 'an upset case on the numbers';
    if ((A.why_watch || []).some(function (w) { return w.kind === 'QB_SPLIT'; })) return 'a quarterback split to watch';
    if (A.deciding) return A.deciding.kind === 'CLASH' ? 'strength against strength' : 'one clear mismatch';
    return 'the projection';
  }
  function gtwHeading(m, i, ed) {
    var id = m.identity;
    var tag = function (side) { var r = side === 'home' ? id.home_rank : id.away_rank; return isNum(r) && r <= 25 ? 'No. ' + r + ' ' : ''; };
    var h = tag('away') + id.away + (id.neutral_site ? ' vs. ' : ' at ') + tag('home') + id.home;
    return (i + 1) + '. ' + h + (ed === 'first_party' ? ': ' + cap(gtwStory(m)) : '');
  }
  function gtwHeadline(o, ed, style) {
    var w = o.week, n = ((o.research && o.research.matchups) || []).length || 5, N = cap(numWord(n));
    /* every style carries the primary keyword's words and stays near 60–70 characters */
    if (ed === 'first_party') return 'College Football Week ' + w + ' Games to Watch: The Evidence Behind Each';
    if (style === 'listicle') return N + ' College Football Games to Watch in Week ' + w + ': TV, Matchups, Upsets';
    if (style === 'where_to_watch') return 'Week ' + w + ' College Football Games to Watch and Where to Watch Them';
    return 'College Football Week ' + w + ' Games to Watch: TV Channels and Key Matchups';
  }

  /* A · where to watch */
  function gtwWhere(m, ed) {
    var w = gtwWhen(m), b = m.broadcast || {}, v = gtwVenue(m);
    var when = w ? w.date + ', ' + w.et + ' (' + w.ct + ')' : 'kickoff time not yet announced';
    var srcName = b.source && b.source.name ? (BROADCAST_SOURCE_TEXT[b.source.name] || b.source.name) : 'the listing';
    var verified = b.publishable && b.verified_text ? 'Broadcast verified ' + b.verified_text + ' from ' + (b.source && /^https:\/\//.test(b.source.url || '') && b.verified_by === 'owner' ? '[' + srcName + '](' + b.source.url + ')' : srcName) + '.' : null;
    var tv = b.publishable && b.watch ? b.watch.tv : null, stream = b.publishable && b.watch ? b.watch.stream : null;
    var change = m.schedule && m.schedule.schedule_change && m.schedule.schedule_change.to
      ? 'Schedule change: moved from ' + whenText(ts(m.schedule.schedule_change.from)) + ' to ' + whenText(ts(m.schedule.schedule_change.to)) + (m.schedule.schedule_change.reason ? ' (' + m.schedule.schedule_change.reason + ')' : '') + ', verified ' + whenText(ts(m.schedule.schedule_change.verified_at)) + '.' : null;
    if (ed === 'first_party') {
      return '**Kickoff and broadcast.** ' + cap(when) + (v ? ', ' + v : '') + '. ' + (tv ? 'On ' + tv + (stream ? '; streaming on ' + stream : '') + '. ' : 'Network not yet verified: EdgeDesk lists a network only after it is verified. ')
        + (b.publishable && b.watch && b.watch.regional ? 'Regional coverage: ' + b.watch.regional + '. ' : '') + (change ? change + ' ' : '') + (verified ? '*' + verified + '*' : '');
    }
    var lines = ['- **When:** ' + when, v ? '- **Where:** ' + v : null,
      '- **TV:** ' + (tv || 'not yet verified (EdgeDesk lists a network only after it is verified)'),
      stream ? '- **Streaming:** ' + stream : null,
      b.publishable && b.watch && b.watch.regional ? '- **Regional coverage:** ' + b.watch.regional : null,
      change ? '- **' + change.replace(/^Schedule change:/, 'Schedule change:**') : null,
      verified ? '- *' + verified + '*' : null].filter(Boolean);
    return '**Where to watch**\n\n' + lines.join('\n');
  }
  /* B · why it matters */
  function gtwWhy(m, ed) {
    var A = m.arguments || {}, id = m.identity, out = [];
    var ws = (A.why_watch || []).filter(function (w) { return !w.model; });
    var has = function (k) { return ws.some(function (w) { return w.kind === k; }); };
    var rk = function (side) { return side === 'home' ? id.home_rank : id.away_rank; };
    var conf = has('CONFERENCE') ? id.home_conference : null;
    var meet = id.neutral_site ? ' meets ' : ' visits ';
    var tagR = function (side) { return isNum(rk(side)) && rk(side) <= 25 ? 'No. ' + rk(side) + ' ' : ''; };
    if (has('RANKED')) out.push(ed === 'first_party'
      ? 'Two EdgeDesk top-25 teams' + (conf ? ' in ' + conf + ' play' : '') + ': No. ' + rk('away') + ' ' + id.away + ' and No. ' + rk('home') + ' ' + id.home + (id.neutral_site ? ', on a neutral field (' + id.venue + ')' : '') + '.'
      : tagR('away') + id.away + meet + tagR('home') + id.home + (conf ? ' in ' + conf + ' play' : '') + ', a meeting of two teams in EdgeDesk’s top 25' + (id.neutral_site ? ', on a neutral field (' + id.venue + ')' : '') + '.');
    else if (has('RANKED_ONE')) { var rt = isNum(id.home_rank) && id.home_rank <= 25 ? 'home' : 'away'; out.push(ed === 'first_party'
      ? id[rt] + ' is No. ' + rk(rt) + ' in EdgeDesk’s ratings; ' + id[rt === 'home' ? 'away' : 'home'] + ' is outside the top 25' + (conf ? ', and it is ' + conf + ' play' : '') + '.'
      : tagR('away') + id.away + meet + tagR('home') + id.home + (conf ? ' in ' + conf + ' play' : '') + ', with ' + id[rt] + ' No. ' + rk(rt) + ' in EdgeDesk’s ratings.'); }
    else if (conf) out.push(id.away + meet + id.home + ' in ' + conf + ' play' + (id.neutral_site ? ', on a neutral field (' + id.venue + ')' : '') + '.');
    if (has('NEUTRAL') && !has('RANKED') && !conf) out.push('It is played on a neutral field (' + id.venue + ').');
    ['away', 'home'].forEach(function (side) {
      var team = id[side];
      var form = gtwFacts(m, function (f) { return f.team === team && f.kind === 'form'; })[0];
      var last = gtwFacts(m, function (f) { return f.team === team && f.kind === 'result'; })[0];
      if (form) out.push(gtwSay(form, ed));
      /* a recent-form line already carries the last game in the EdgeDesk
         edition; the publisher edition names the last result every time */
      if (last && (ed !== 'first_party' || !form || form.id.indexOf('_recent_') < 0)) out.push(gtwSay(last, ed));
    });
    if (has('CLASH') && ed !== 'first_party') out.push('On the season numbers, it is also ' + ws.filter(function (w) { return w.kind === 'CLASH'; })[0].text + '.');
    return (ed === 'first_party' ? '**The stakes.** ' : '**Why it matters.** ') + out.join(' ');
  }
  /* C · the key football matchup */
  function gtwMatchup(m, ed) {
    var A = m.arguments || {}, d = A.deciding, out = [];
    if (d) {
      out.push(ed === 'first_party' ? d.alt : d.claim);
      d.facts.forEach(function (id) { var f = gtwFact(m, id); if (f) out.push(gtwSay(f, ed)); });
      if (d.adjusted && d.adjusted.agrees === true) out.push(ed === 'first_party' ? 'Adjusted for the opponents each side has faced, EdgeDesk’s matchup metrics agree: a ' + d.adjusted.magnitude + ' ' + String(d.adjusted.label).toLowerCase() + ' edge for ' + d.adjusted.favors + '.' : 'EdgeDesk’s opponent-adjusted numbers agree, rating it a ' + d.adjusted.magnitude + ' edge for ' + d.adjusted.favors + '.');
    }
    if (A.second && ed === 'first_party') {
      out.push('The secondary fight:');
      A.second.facts.forEach(function (id) { var f = gtwFact(m, id); if (f) out.push(gtwSay(f, ed)); });
    }
    /* the quarterbacks: a split is a measured fact; then each passer's line */
    ['away', 'home'].forEach(function (side) {
      var team = m.identity[side];
      var split = gtwFacts(m, function (f) { return f.team === team && f.kind === 'qb_split'; })[0];
      if (split) out.push(gtwSay(split, ed));
      var qbs = gtwFacts(m, function (f) { return f.team === team && f.kind === 'qb'; });
      qbs.slice(0, split ? 2 : 1).forEach(function (f) { out.push(gtwSay(f, ed)); });
      gtwFacts(m, function (f) { return f.team === team && f.kind === 'turnovers' && (ed === 'first_party' || f.direction === 'HIGH'); }).slice(0, 1).forEach(function (f) { out.push(gtwSay(f, ed)); });
      if (ed === 'first_party') gtwFacts(m, function (f) { return f.team === team && f.kind === 'qb_efficiency'; }).slice(0, 1).forEach(function (f) { out.push(gtwSay(f, ed)); });
    });
    var avail = [];
    ['away', 'home'].forEach(function (side) {
      var team = m.identity[side];
      var split = gtwFacts(m, function (f) { return f.team === team && f.kind === 'qb_split'; }).length > 0;
      gtwFacts(m, function (f) { return f.team === team && (f.kind === 'availability' || (f.kind === 'qb_availability' && (ed === 'first_party' || split))); }).forEach(function (f) { avail.push(gtwSay(f, ed)); });
    });
    var body = out.join(' ');
    return (ed === 'first_party' ? '**Where it’s decided.** ' : '**The key matchup.** ') + body + (avail.length ? '\n\n' + (ed === 'first_party' ? '*Availability.* ' : '**Injuries and availability:** ') + avail.join(' ') : '');
  }
  /* D · EdgeDesk's projection */
  function gtwModel(m, ed) {
    var md = m.model || {}, A = m.arguments || {}, out = [];
    if (!md.available) return null;
    var head = md.favorite ? (md.favorite + ' by ' + oneDp(md.margin) + (isNum(md.fav_win_pct) ? ', a ' + md.fav_win_pct + '% chance to win' : '')) : 'a pick’em';
    out.push(ed === 'first_party' ? 'EdgeDesk’s fair line is ' + md.fair_text + (isNum(md.fav_win_pct) && md.favorite ? ' (' + md.favorite + ' ' + md.fav_win_pct + '% to win)' : '') + (isNum(md.total) ? ', with a projected total of ' + oneDp(md.total) + ' points' : '') + '.'
      : 'EdgeDesk’s model has ' + head + (isNum(md.total) ? ', with a projected total of ' + oneDp(md.total) + ' points' : '') + '.');
    if ((md.inputs || []).length) out.push((ed === 'first_party' ? 'What moves the number most: ' : 'The biggest input: ') + sentenceList(md.inputs.slice(0, ed === 'first_party' ? 2 : 1).map(function (x) { return String(x.label).replace(/\s*\(.*\)\s*/g, '').toLowerCase() + ' (' + oneDp(x.points) + ' points toward ' + x.favors + ')'; })) + '.');
    var mk = md.market || {};
    if (md.gap_state === 'COMPARABLE' && md.gap) out.push('The betting line' + (mk.book ? ' at ' + bookName(mk.book) : '') + ' was ' + mk.text + ' when captured ' + whenText(ts(mk.captured_at)) + '; that is ' + oneDp(md.gap.points) + ' points from EdgeDesk’s number. A gap is a research question, not a bet.');
    else if (md.gap_state === 'UNRESOLVED') out.push('EdgeDesk’s number is far from the betting line, and that gap has not cleared EdgeDesk’s integrity checks, so it is treated as a question about the data rather than a signal.');
    else if (md.gap_state === 'STALE_MARKET') out.push('The newest sportsbook line on file was captured ' + whenText(ts(mk.captured_at)) + ', older than EdgeDesk’s three-hour freshness rule, so no gap to the market is stated.');
    else if (md.gap_state === 'NO_MARKET') out.push('No sportsbook line is on file for a comparison.');
    if (isNum(md.reliability)) out.push('Research reliability: ' + md.reliability + ' out of 100.');
    var wrong = (A.model_wrong || []).filter(function (w) { return w.kind !== 'UNRESOLVED_GAP'; });
    var pick = ed === 'first_party' ? wrong.slice(0, 3) : wrong.filter(function (w) { return w.kind !== 'OTHER_MODELS'; }).slice(0, 2);
    if (pick.length) out.push((ed === 'first_party' ? 'Where this number could be wrong: ' : 'Why it could be wrong: ') + pick.map(function (w) { return w.text; }).join('; ') + '.');
    if (ed === 'first_party') out.push('[Open the full research for ' + m.identity.heading + '](' + gtwResearchUrl(m) + ').');
    return (ed === 'first_party' ? '**EdgeDesk’s number.** ' : '**EdgeDesk’s projection.** ') + out.join(' ');
  }
  /* E · upset potential: only on the evidence */
  function gtwUpset(m, ed) {
    var u = (m.arguments || {}).upset || {};
    if (!u.credible && !u.near_even && isNum(u.dog_win_pct)) {
      return (ed === 'first_party' ? '**Why there’s no upset case.** ' : '**Upset potential.** ') + 'EdgeDesk gives ' + u.team + ' a ' + u.dog_win_pct + '% chance, but ' + String(u.reason || 'the numbers do not make an upset case').replace(/^EdgeDesk gives .*?; /, '') + '.';
    }
    if (!u.credible) {
      return (ed === 'first_party' ? '**Why there’s no upset case.** ' : '**Upset potential.** ') + cap(u.reason || 'the numbers do not make an upset case') + '.';
    }
    var cond = u.conditions.map(function (c) { return c.text; });
    var counter = u.counter.map(function (c) { return c.text; });
    if (ed === 'first_party') return '**If the underdog wins, here’s how.** EdgeDesk gives ' + u.team + ' a ' + u.dog_win_pct + '% chance. ' + cond.map(function (c) { return cap(c) + '.'; }).join(' ') + ' Against it: ' + counter.join('; ') + '.';
    return '**Upset potential.** EdgeDesk gives ' + u.team + ' a ' + u.dog_win_pct + '% chance. The case for it: ' + cond.join('; ') + '. The case against: ' + counter.join('; ') + '.';
  }
  /* F · what to watch */
  function gtwWatch(m, ed) {
    var wf = ((m.arguments || {}).watch_for || []).slice(0, 2);
    if (!wf.length) return null;
    return (ed === 'first_party' ? '**Watch for.**' : '**What to watch**') + '\n\n' + wf.map(function (w) { return '- ' + w.text; }).join('\n');
  }
  function gtwGame(m, ed) {
    var parts = [gtwWhere(m, ed), gtwWhy(m, ed), gtwMatchup(m, ed), gtwModel(m, ed), gtwUpset(m, ed), gtwWatch(m, ed)].filter(Boolean);
    if (ed === 'first_party') parts.splice(1, 0, parts.splice(parts.length - 1, 1)[0]);
    return parts.join('\n\n');
  }
  function gtwSections(o, ed, ctx) {
    ctx = ctx || {};
    var pairs = gtwPairs(o), s = { __headings: {} };
    var w = o.week;
    var ms = pairs.map(function (x) { return x.m; });
    var heads = ms.map(function (m) { return m.identity.away + (m.identity.neutral_site ? ' vs. ' : ' at ') + m.identity.home; });
    var kw = 'college football week ' + w + ' games to watch';
    if (ed === 'first_party') {
      s.intro = para('These are EdgeDesk’s college football Week ' + w + ' games to watch: ' + sentenceList(heads) + '.',
        'Each one is here because the research gives a reason beyond the projection — a measured matchup, a quarterback situation, a result that changed the picture — and each comes with the evidence, so you can check our reasoning against the game.');
      s.research_nav = ms.map(function (m) { return '- [' + m.identity.heading + '](' + gtwResearchUrl(m) + ') — ' + gtwStory(m); }).join('\n');
    } else {
      var first = ms.slice().sort(function (a, b) { return (ts(a.schedule.kickoff) || 0) - (ts(b.schedule.kickoff) || 0); })[0];
      var fw = first ? gtwWhen(first) : null;
      s.intro = para('Here are the college football Week ' + w + ' games to watch, with where to watch each one, the matchup most likely to decide it and what EdgeDesk’s numbers expect.',
        cap(numWord(ms.length)) + ' games made the list: ' + sentenceList(heads) + '.',
        fw ? 'The first kicks off ' + fw.date + ' at ' + fw.et + '.' : null);
      s.watch_guide = ms.slice().sort(function (a, b) { return (ts(a.schedule.kickoff) || 0) - (ts(b.schedule.kickoff) || 0); }).map(function (m) {
        var t = gtwWhen(m), b = m.broadcast || {};
        return '- **' + m.identity.heading + '** — ' + (t ? t.et + ' (' + t.ct + ')' : 'time not yet announced') + ', ' + (b.publishable && b.watch ? b.watch.tv : 'network not yet verified');
      }).join('\n');
    }
    pairs.forEach(function (x, i) {
      var k = 'game_' + (i + 1);
      s[k] = gtwGame(x.m, ed);
      s.__headings[k] = gtwHeading(x.m, i, ed);
    });
    s.how_to_read = para(howToRead(o), ed === 'first_party'
      ? 'Two kinds of evidence appear above. Counts — a final score, a completion rate over a stated number of dropbacks, a name on a conference availability report — you can check yourself. Ratings, projections and expected points are EdgeDesk’s analysis, and are labelled as such.'
      : 'Every stat in the game sections is a count from this season’s games (with the sample size beside it) or comes from an official availability report, and the broadcast for each game was verified at the time shown.');
    var lim = uniq([].concat.apply([], ms.map(function (m) { return m.limits || []; })));
    s.limits = lim.map(function (l) { return '- ' + cap(l) + '.'; }).concat(['- Even a 70% favorite loses about three times in ten. Projections describe likelihoods, not outcomes.']).join('\n');
    if (ed === 'first_party') {
      var camp = ctx.campaign || 'gtw-w' + w;
      s.next_steps = para('Every game above has a full research page: the projection’s inputs, the market check, both teams’ units and the availability report.',
        '[Get EdgeDesk’s free weekly email](' + SITE + '/newsletter/?from=' + encodeURIComponent(camp) + ') for next week’s games to watch, or [see every game on today’s free board](' + SITE + '/today/).',
        'For the full research terminal, EdgeDesk Full Access starts with a 7-day free trial ([details](' + SITE + '/#pricing)).');
    } else {
      s.conclusion = para('The short version: ' + sentenceList(ms.map(function (m) { return m.identity.heading + ' is ' + gtwStory(m); })) + '.',
        'Times, networks and availability can change during the week, so check the official listings before kickoff.',
        'None of it is a pick. It’s a guide to what to watch, and why.');
    }
    s.__seo = { headline: gtwHeadline(o, ed, ctx.headline_style || 'standard'), primary_keyword: ed === 'first_party' ? kw : kw,
      secondary_keywords: ed === 'first_party' ? ['college football week ' + w + ' matchups', 'college football week ' + w + ' predictions', 'college football week ' + w + ' research'] : (o.seo && o.seo.secondary_keywords) || [],
      meta_description: ed === 'first_party'
        ? 'Week ' + w + ' college football games to watch, with the evidence behind each: matchups, quarterbacks, availability and EdgeDesk’s projections.'
        : null };
    if (!s.__seo.meta_description) delete s.__seo.meta_description;
    s.__standfirst = ed === 'first_party'
      ? numWord(ms.length).replace(/^./, function (c) { return c.toUpperCase(); }) + ' games, the football evidence behind each, and what EdgeDesk’s model expects. Research, not picks.'
      : 'Where to watch, what decides it and whether an upset is realistic, for Week ' + w + '’s ' + numWord(ms.length) + ' best games. Research, not picks.';
    return s;
  }

  function sectionsFor(o, format, ctx) {
    var s = {};
    if (format === 'market_discrepancy' && o.research.games && o.research.games.length === 1 && o.research.games[0].gap) return mdSections(o);
    if (format === 'trending_story') return storySections(o);
    if (format === 'weekend_storylines') return storylinesSections(o);
    if (format === 'game_deep_dive') return deepDiveSections(o);
    if (format === 'conference_race' && o.research.conference) return raceSections(o);
    if (format === 'upset_watch') return upsetOnlySections(o);
    if (format === 'model_performance_review') return performanceSections(o);
    if (format === 'weekly_games_to_watch' || format === 'weekly_games_to_watch_first_party') return gtwSections(o, FORMATS[format].edition, ctx);
    var gs = o.research.games || [];
    var angle = ctx.angle || 'full_slate';
    var shown = gs;
    if (angle === 'upsets_first' && o.research.upsets && o.research.upsets.length) {
      var ids = o.research.upsets.map(function (p) { return p.game_id; });
      shown = o.research.upsets.concat(gs.filter(function (p) { return ids.indexOf(p.game_id) < 0; })).slice(0, gs.length);
    }
    var maxGames = Math.min(ctx.maxGames || 5, 5);
    shown = shown.slice(0, maxGames);
    s.intro = ctxIntro(o);
    s.why_it_matters = whyItMatters(o);
    s.how_to_read = howToRead(o);
    /* ONE CENTRAL STORY (docs/system-integrity/TEMPLATES.md): the lead game in
       full, the supporting games short, so the piece reads as a story with
       context rather than a list of equal summaries */
    s.games = shown.map(function (p, i) { return capsule(p, { links: ctx.links, short: i > 0 }); }).join('\n\n');
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
    var raw = sectionsFor(o, baseFormat, { angle: ctx.angle, maxGames: maxGames, links: links, publisher: publisher, headline_style: ctx.headline_style, audience: ctx.audience, campaign: ctx.campaign });
    var preview = /_weekly_preview$/.test(baseFormat);
    var order = format === 'publisher_custom' && preview ? sectionOrder(format, publisher) : sectionOrder(baseFormat, publisher);
    var sections = [];
    order.forEach(function (k) {
      var body = raw[k];
      if (!body) return;
      sections.push({ key: k, heading: (raw.__headings && raw.__headings[k]) || SECTION_HEADINGS[k] || null, body: body });
    });
    var seo = o.seo || seoBrief(o, publisher);
    var title = ctx.title || (raw.__seo && raw.__seo.headline) || seo.headline || o.title;
    if (raw.__seo) seo = Object.assign({}, seo, raw.__seo);
    var a = {
      format: format, base_format: baseFormat, angle: ctx.angle || 'full_slate', title: title, slug: slugify(title), meta_description: seo.meta_description,
      primary_keyword: seo.primary_keyword, secondary_keywords: seo.secondary_keywords,
      standfirst: raw.__standfirst || standfirstFor(o), sections: sections, generator: 'template:' + VERSION, generated_at: iso(isNum(ctx.now) ? ctx.now : Date.now()),
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
    [25, 30, 49, 50, 70, 95, 100, 180, 2024, 2025, 2026, 2027].forEach(function (v) { addNum(nums, v); });
    (o.research.games || []).concat(o.research.upsets || [], o.research.races || []).forEach(function (p) {
      teams[p.home] = 1; teams[p.away] = 1;
      [p.home_conference, p.away_conference, p.venue, p.market && p.market.book, p.market && bookName(p.market.book)].forEach(function (x) { if (x) names[x] = 1; });
      ['home', 'away'].forEach(function (s) { var q = p.qb && p.qb[s]; if (q && q.player) names[q.player] = 1;
        var inj = p.injuries && p.injuries[s]; (inj && inj.qbs || []).forEach(function (x) { names[x.name] = 1; }); });
    });
    /* a matchup packet's results name past opponents, and its quarterback
       lines and availability report name players: both are evidence */
    (o.research.matchups || []).forEach(function (m) {
      ['home', 'away'].forEach(function (s) {
        var t = m.teams && m.teams[s]; ((t && t.results) || []).forEach(function (r) { if (r.opponent) teams[r.opponent] = 1; });
        var q = m.quarterbacks && m.quarterbacks[s]; ((q && q.lines) || []).forEach(function (l) { if (l.player) names[l.player] = 1; });
        var av = m.availability && m.availability[s]; ((av && av.listed) || []).forEach(function (x) { if (x.player) names[x.player] = 1; });
      });
      if (m.identity && m.identity.venue) names[m.identity.venue] = 1;
      ((m.broadcast && m.broadcast.networks) || []).forEach(function (n) { names[n] = 1; });
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
  /* sentences that never run across a block: a heading, a list item or a
     paragraph ends a sentence even without a full stop, so a capsule's last
     line is never read together with the next game's heading. A paragraph
     wrapped over several lines stays one block. */
  function blockSentencesOf(t) {
    return [].concat.apply([], String(t)
      .replace(/\n(?=[ \t]*(?:#|[-*•][ \t]|\d+\.[ \t]|>|\|))/g, '\n\n')
      .replace(/(^|\n)([ \t]*#[^\n]*)\n/g, '$1$2\n\n')
      .split(/\n[ \t]*\n/)
      .map(function (b) { return sentencesOf(b.trim()); }))
      .filter(function (x) { return x && x.trim(); });
  }
  /* the same, plus each heading read with the sentence under it, so
     "### Florida at Texas" over "Kickoff 2:30 p.m." is still one claim */
  function headedSentencesOf(t) {
    var out = blockSentencesOf(t), lines = blockSentencesOf(String(t).replace(/(^|\n)([ \t]*#[^\n]*)\n/g, '$1$2\n\n'));
    lines.forEach(function (x, i) { if (/^\s*#/.test(x) && lines[i + 1]) out.push(x + ' ' + lines[i + 1]); });
    return out;
  }

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

    /* 3 numbers: every figure must be in the evidence */
    var unsupported = uniq(numbersIn(stripForNumbers(text)).filter(function (n) { return !ev.numbers[String(+n.toFixed(2))]; }));
    add('numbers_in_evidence', unsupported.length ? 'fail' : 'pass', 'Every number comes from EdgeDesk research or a cited source',
      unsupported.length ? 'not in the evidence: ' + unsupported.slice(0, 10).join(', ') : null);

    /* 4 teams: no team the research does not cover */
    var lists = opts.teamLists || {};
    var known = (lists[o.league] && lists[o.league].length ? lists[o.league] : ((o.research.context && o.research.context.team_names) || []));
    if (known.length) {
      /* a person's name is masked before teams are matched (Isaiah Marshall is
         not Marshall) — but never a name that is itself a team */
      var people = Object.keys(ev.names).filter(function (n) { return known.indexOf(n) < 0 && !known.some(function (t) { return n.indexOf(t) === 0 && n.length === t.length; }); });
      var extra = teamsMentioned(text, known, people).filter(function (t) { return !ev.teams[t]; });
      add('teams_in_evidence', extra.length ? 'fail' : 'pass', 'Every team named is in the research', extra.length ? 'not in this article’s research: ' + extra.join(', ') : null);
    }
    /* people: capitalised two-word names that are not teams or evidence */
    var people = [], pm, PRE = /\b([A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?)\b/g;
    var allowWords = /^(EdgeDesk|Research|The|Projected|Model|Full|Bottom|Week|What|Why|How|Upset|Injury|Matchup|Sportsbook|Search|Gamble|Nothing|College|National|Football|League|Pass|Run|Team|Home|Stylistic|Official|Not|Prices|Quarterbacks|Uncertainty|Injuries|For|From|Each|These|None|This|That|It|If|When|Here|Every|Most|Some|Sat|Sun|Mon|Tue|Wed|Thu|Fri|Oct|Sept|Nov|Dec|Jan|Aug)\b/;
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

    /* ── EDITORIAL INTEGRITY (docs/system-integrity/RULES.md §EDIT) ──────────
       Deterministic rules over the article and the packets it was written
       from. Any failure here sets integrity_status BLOCKED, which the
       database refuses at approval, ready-to-send and Send. */
    var IG = [];
    function ig(id, rule, status, label, detail) { add(id, status, label, detail); IG.push({ rule_id: rule, status: status, explanation: detail || label }); }
    var gamesAll = (o.research.games || []).concat(o.research.upsets || [], o.research.races || []);
    var byGid = {}; gamesAll.forEach(function (p) { if (p && p.game_id != null) byGid[p.game_id] = p; });
    var featured = Object.keys(byGid).map(function (k) { return byGid[k]; });
    ig('integrity_engine', 'EDIT.ENGINE', INTEGRITY_OK ? 'pass' : 'fail', 'The integrity engine ran', INTEGRITY_OK ? null : 'lib/edgedesk_calc.js, edgedesk_schedule.js, edgedesk_availability.js or edgedesk_integrity.js did not load: nothing can be verified');
    var unpub = featured.filter(function (p) { return p.publishable === false; });
    ig('games_publishable', 'EDIT.GAMES_VALID', unpub.length ? 'fail' : 'pass', 'Every featured game is cleared for publication',
      unpub.length ? unpub.map(function (p) { return p.away + ' at ' + p.home + ' (' + ((p.integrity && p.integrity.public && p.integrity.public.blocking) || []).map(function (b) { return b.rule_id; }).join(', ') + ')'; }).join('; ') : null);
    /* numbers tied to the game they are written about */
    var gameTeams = {};
    featured.forEach(function (p) { [p.home, p.away].forEach(function (t) { if (t) (gameTeams[t] = gameTeams[t] || []).push(p.game_id); }); });
    var teamNames = Object.keys(gameTeams);
    var gameNums = {};
    var mByGid = {}; (o.research.matchups || []).forEach(function (m) { mByGid[m.game_id] = m; });
    function numsOfGame(p) {
      if (gameNums[p.game_id]) return gameNums[p.game_id];
      var set = {};
      [p, mByGid[String(p.game_id)]].filter(Boolean).forEach(function (src) {
        walk(src, function (v) { if (typeof v === 'number') addNum(set, v); else if (typeof v === 'string') numbersIn(v).forEach(function (n) { addNum(set, n); }); }, 0);
        walk(src, function (v) { if (typeof v === 'number' && v > 0 && v < 1) addNum(set, 1 - v); }, 0);
      });
      gameNums[p.game_id] = set; return set;
    }
    var GENERIC = {}; [o.week, o.season].forEach(function (v) { addNum(GENERIC, v); });
    for (var gi = 0; gi <= 12; gi++) addNum(GENERIC, gi);
    [25, 30, 49, 50, 70, 95, 100, 180].forEach(function (v) { addNum(GENERIC, v); });
    var misplaced = [];
    blockSentencesOf(stripForNumbers(body)).forEach(function (sent) {
      var ts0 = teamsMentioned(sent, teamNames, []);
      if (!ts0.length) return;
      var ids = uniq([].concat.apply([], ts0.map(function (t) { return gameTeams[t] || []; })));
      numbersIn(sent).forEach(function (n) {
        var key = String(+n.toFixed(2));
        if (GENERIC[key]) return;
        if (ids.some(function (id) { return numsOfGame(byGid[id])[key]; })) return;
        misplaced.push(n + ' (in a sentence about ' + ts0.join(' and ') + ')');
      });
    });
    ig('numbers_per_game', 'EDIT.NUMBERS', misplaced.length ? 'fail' : 'pass', 'Every number belongs to the game it is written about',
      misplaced.length ? 'not in that game’s research: ' + uniq(misplaced).slice(0, 6).join('; ') : null);
    /* quarterback and availability claims need a sourced report */
    if (AVAIL) {
      var byTeam = {};
      featured.forEach(function (p) { ['home', 'away'].forEach(function (s) {
        var c = p.availability && p.availability[s], team = s === 'home' ? p.home : p.away;
        if (!c) return; (byTeam[team] = byTeam[team] || []).push(c); if (c.player) (byTeam[c.player] = byTeam[c.player] || []).push(c);
      }); });
      /* the conference's official availability report, player by player */
      (o.research.matchups || []).forEach(function (m) { ['home', 'away'].forEach(function (s) {
        var av = m.availability && m.availability[s]; if (!av || !av.official) return;
        (av.classified || []).forEach(function (c) { if (!c) return; (byTeam[c.team] = byTeam[c.team] || []).push(c); if (c.player) (byTeam[c.player] = byTeam[c.player] || []).push(c); });
      }); });
      var qbIssues = AVAIL.guardProse(body, byTeam);
      ig('qb_claims_sourced', 'EDIT.QB_UNCERTAINTY', qbIssues.length ? 'fail' : 'pass', 'Quarterback and injury uncertainty only from a sourced report',
        qbIssues.length ? qbIssues.slice(0, 3).map(function (q) { return q.reason + ': “' + q.sentence.slice(0, 120) + '”'; }).join(' · ') : null);
    }
    /* conference claims match the teams in the sentence */
    var CONFS = ['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12', 'American', 'Mountain West', 'MAC', 'Sun Belt', 'Conference USA', 'AFC', 'NFC'];
    var confBad = [];
    if (o.league === 'cfb') blockSentencesOf(body).forEach(function (sent) {
      var ts1 = teamsMentioned(sent, teamNames, []);
      if (!ts1.length) return;
      CONFS.forEach(function (c) {
        if (!new RegExp('(^|[^A-Za-z-])' + c.replace(/[-]/g, '\\-') + '(?![A-Za-z])').test(sent)) return;
        var confsOf = [];
        ts1.forEach(function (t) { (gameTeams[t] || []).forEach(function (id) { var p = byGid[id]; confsOf.push(t === p.home ? p.home_conference : p.away_conference); }); });
        if (confsOf.indexOf(c) < 0 && !/conference(?:’s|'s)? (?:three )?highest|power-conference|non-conference/i.test(sent)) confBad.push(c + ' with ' + ts1.join(', '));
      });
    });
    ig('conference_claims', 'EDIT.CONFERENCE', confBad.length ? 'fail' : 'pass', 'Conference claims match the teams', confBad.length ? 'no team in the sentence plays in: ' + uniq(confBad).slice(0, 4).join('; ') : null);
    /* a TBA kickoff is never printed as a clock time */
    var tbaBad = [];
    featured.filter(function (p) { return p.kickoff_verified === false; }).forEach(function (p) {
      headedSentencesOf(text).forEach(function (sent) {
        if (sent.indexOf(p.home) >= 0 && sent.indexOf(p.away) >= 0 && /\b\d{1,2}(?::\d{2})? ?(?:a\.m\.|p\.m\.|am|pm)/i.test(sent)) tbaBad.push(p.away + ' at ' + p.home);
      });
    });
    ig('kickoff_claims', 'EDIT.KICKOFF', tbaBad.length ? 'fail' : 'pass', 'An unannounced kickoff is never given a time', tbaBad.length ? uniq(tbaBad).join(', ') + ': the schedule has not set a time' : null);
    /* no spread that contradicts the snapshot */
    var lineBad = [];
    featured.forEach(function (p) {
      var ok = {};
      function allow(team, line) { if (team && isNum(line)) (ok[team] = ok[team] || {})[r1(line).toFixed(1)] = 1; }
      if (p.model && p.model.available && p.model.favorite) { allow(p.model.favorite, -p.model.margin); allow(p.model.underdog, p.model.margin); }
      if (p.market && isNum(p.market.home_line)) { allow(p.home, p.market.home_line); allow(p.away, -p.market.home_line); }
      /* the packet's own alternative numbers: the sensitivity range and the
         challenger models, printed as "Team by N" */
      var mp = mByGid[String(p.game_id)], byOk = {};
      if (mp && mp.model) {
        var alts = [];
        if (mp.model.sensitivity) alts.push(mp.model.sensitivity.low_home_margin, mp.model.sensitivity.high_home_margin);
        (mp.model.other_models || []).forEach(function (x) { alts.push(x.home_margin); });
        alts.filter(isNum).forEach(function (hm) { var t = hm > 0 ? p.home : p.away; (byOk[t] = byOk[t] || {})[r1(Math.abs(hm)).toFixed(1)] = 1; allow(t, -Math.abs(hm)); });
      }
      [p.home, p.away].forEach(function (team) {
        var re = new RegExp('(^|[^A-Za-z])' + team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ([+\\-−])(\\d+(?:\\.\\d)?)(?![\\d.])', 'g'), m;
        while ((m = re.exec(body))) {
          var v = (m[2] === '+' ? 1 : -1) * parseFloat(m[3]);
          if (!(ok[team] && ok[team][r1(v).toFixed(1)])) lineBad.push(team + ' ' + m[2] + m[3]);
        }
        var re2 = new RegExp('(^|[^A-Za-z])' + team.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' by (\\d+(?:\\.\\d)?)\\b', 'g'), m2;
        while ((m2 = re2.exec(body))) {
          var v2 = parseFloat(m2[2]);
          var mm = p.model && p.model.favorite === team ? r1(p.model.margin) : null;
          var km = p.market && isNum(p.market.home_line) ? (team === p.home ? -r1(p.market.home_line) : r1(p.market.home_line)) : null;
          if (v2 !== mm && v2 !== km && !(byOk[team] && byOk[team][r1(v2).toFixed(1)])) lineBad.push(team + ' by ' + m2[2]);
        }
      });
    });
    ig('spread_claims', 'EDIT.CONTRADICTION', lineBad.length ? 'fail' : 'pass', 'Every spread printed matches the research snapshot', lineBad.length ? 'not EdgeDesk’s number or the quoted line: ' + uniq(lineBad).slice(0, 6).join(', ') : null);
    /* the research the draft was written on is still the research on file */
    if (opts.current_research_hash) {
      var stale = a.research_hash && a.research_hash !== opts.current_research_hash;
      ig('snapshot_current', 'EDIT.SNAPSHOT', stale ? 'fail' : 'pass', 'Written on the current research snapshot', stale ? 'the research changed after this draft was written: refresh it' : null);
    }
    /* ── FIVE GAMES TO WATCH (docs/content-engine/GAMES_TO_WATCH.md §Checks) ── */
    if (FORMATS[base] && FORMATS[base].edition) gtwChecks(a, o, now, ig, ed);
    var igFail = IG.filter(function (x) { return x.status === 'fail'; });
    var igWarn = checks.filter(function (c) { return c.status === 'warn'; }).length > 0 || featured.some(function (p) { return p.integrity && p.integrity.public && p.integrity.public.status === 'WARNING'; });
    var integrity = { version: INTEG ? INTEG.VERSION : null, status: igFail.length ? 'BLOCKED' : (igWarn ? 'WARNING' : 'PASS'),
      blocking: igFail.map(function (x) { return { rule_id: x.rule_id, explanation: x.explanation }; }),
      games: featured.map(function (p) { return { game_id: p.game_id, record_id: p.record_id || null, status: p.integrity && p.integrity.public ? p.integrity.public.status : 'UNKNOWN' }; }) };

    var fails = checks.filter(function (c) { return c.status === 'fail'; });
    var warns = checks.filter(function (c) { return c.status === 'warn'; });
    return {
      ok: fails.length === 0, checks: checks, failed: fails.map(function (c) { return c.id; }), warned: warns.map(function (c) { return c.id; }),
      /* the verdict the database enforces (supabase/content_engine.sql integrity_ok) */
      integrity_status: integrity.status, integrity: integrity,
      checked_at: iso(now), version: VERSION
    };
  }

  /* ======================================================================
     FIVE GAMES TO WATCH — the editorial checks. Each is deterministic and
     reads the article against the packets it was written from; every
     failure blocks approval (integrity BLOCKED), and reviewReport() says
     which failures HOLD an article (fixable by verification) and which
     REJECT it.
     ====================================================================== */
  var GTW_FILLER = [/anything can happen/i, /on any given (?:saturday|sunday|day)/i, /should be a (?:great|fun|good) (?:one|game)/i, /both teams (?:will be|are) looking/i,
    /statement (?:game|win)/i, /must[- ]win/i, /only time will tell/i, /buckle up/i, /fireworks/i, /throw the records out/i, /a game you won’t want to miss|a game you won't want to miss/i,
    /it all comes down to/i, /when the dust settles/i, /circle (?:this|it) on (?:your|the) calendar/i, /something has to give/i, /edge of your seat/i, /\btrap game\b/i];
  /* networks a "where to watch" line could name */
  var NETWORK_WORDS = ['ABC', 'CBS', 'NBC', 'FOX', 'ESPN', 'ESPN2', 'ESPNU', 'ESPNEWS', 'ESPN\\+', 'SEC Network\\+?', 'ACC Network(?: Extra)?', 'Big Ten Network', 'BTN', 'FS1', 'FS2',
    'CBS Sports Network', 'The CW', 'CW', 'Peacock', 'Paramount\\+', 'Prime Video', 'Netflix', 'truTV', 'TNT', 'TBS', 'NFL Network', 'YouTube', 'Fubo', 'Sling', 'Hulu'];
  function gtwSectionsOf(a) {
    return (a.sections || []).filter(function (s) { return /^game_\d+$/.test(s.key); });
  }
  function gtwPartsOf(body) {
    /* the six labelled parts, each to the next label */
    var hits = GTW_PARTS.map(function (P) { var m = P.re.exec(body); return m ? { key: P.key, at: m.index } : null; }).filter(Boolean).sort(function (x, y) { return x.at - y.at; });
    var out = {};
    hits.forEach(function (h, i) { out[h.key] = body.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : body.length); });
    return out;
  }
  function gtwChecks(a, o, now, ig, ed) {
    var R = o.research || {}, ms = R.matchups || [];
    var secs = gtwSectionsOf(a);
    if (!GTW_OK) { ig('gtw_engine', 'EDIT.GTW_ENGINE', 'fail', 'The matchup and broadcast layers ran', 'lib/edgedesk_matchup.js or lib/edgedesk_broadcast.js did not load: nothing about the games can be verified'); return; }
    /* a fixture never publishes */
    ig('not_fixture', 'EDIT.FIXTURE', R.fixture ? 'fail' : 'pass', 'Built from live research, not a test fixture', R.fixture ? 'these packets are a historical test fixture (' + R.fixture + '); an article built from them can never be published' : null);
    /* which packet each section is about: by its heading, never by position alone */
    var rows = secs.map(function (s) {
      var h = String(s.heading || '') + '\n' + s.body.slice(0, 200);
      var m = ms.filter(function (x) { return h.indexOf(x.identity.home) >= 0 && h.indexOf(x.identity.away) >= 0; })[0] || null;
      return { s: s, m: m, parts: gtwPartsOf(s.body) };
    });
    var unknown = rows.filter(function (r) { return !r.m; }).map(function (r) { return r.s.key; });
    var ids = rows.filter(function (r) { return r.m; }).map(function (r) { return r.m.game_id; });
    var dupIds = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
    ig('duplicate_matchup', 'EDIT.DUPLICATE_MATCHUP', dupIds.length || unknown.length ? 'fail' : 'pass', 'Each game appears once, and every game section is a researched game',
      (dupIds.length ? 'featured twice: ' + uniq(dupIds).map(function (id) { return ms.filter(function (m) { return m.game_id === id; })[0].identity.heading; }).join(', ') : '') + (unknown.length ? (dupIds.length ? '; ' : '') + 'no research packet for ' + unknown.join(', ') : '') || null);
    var missingGames = ms.filter(function (m) { return ids.indexOf(m.game_id) < 0; }).map(function (m) { return m.identity.heading; });
    if (missingGames.length) ig('games_covered', 'EDIT.SECTIONS', 'fail', 'Every selected game has its section', 'no section for ' + missingGames.join(', '));
    /* 1 · the reasoning gate, per game */
    var gateBad = ms.filter(function (m) { return !(m.gate && m.gate.ok); }).map(function (m) { return m.identity.heading + ' (' + ((m.gate && m.gate.missing) || []).concat((m.gate && m.gate.blocking) || []).map(function (x) { return x.code; }).join(', ') + ')'; });
    ig('reasoning_gate', 'EDIT.REASONING', gateBad.length ? 'fail' : 'pass', 'Every game answers the six questions (why watch, deciding matchup, evidence, projection, why it could be wrong, what to watch)', gateBad.length ? gateBad.join('; ') : null);
    /* 2 · six parts in every section */
    var partBad = [];
    rows.forEach(function (r) { var miss = GTW_PARTS.filter(function (P) { return !r.parts[P.key]; }).map(function (P) { return P.key; }); if (miss.length) partBad.push((r.m ? r.m.identity.heading : r.s.key) + ': ' + miss.join(', ')); });
    ig('six_parts', 'EDIT.SECTIONS', partBad.length ? 'fail' : 'pass', 'Every game has all six parts (where to watch, why it matters, key matchup, projection, upset potential, what to watch)', partBad.length ? 'missing ' + partBad.join('; ') : null);
    /* 3 · two independent, matchup-relevant facts written into each section
       (the projection never counts) */
    var factBad = [], factCount = {};
    rows.forEach(function (r) {
      if (!r.m) return;
      var body = stripForNumbers(r.s.body);
      var have = {}; numbersIn(body).forEach(function (n) { have[String(+n.toFixed(2))] = 1; });
      var used = (r.m.facts || []).filter(function (f) {
        if (!f.independent) return false;
        var nums = (f.numbers || []).filter(function (x) { return isNum(x) && Math.abs(x) >= 1; }).slice(0, 2);
        if (!nums.length) return f.kind === 'qb_availability' && (f.text && (r.s.body.indexOf(f.text) >= 0 || r.s.body.indexOf(f.alt) >= 0));
        return nums.every(function (x) { return have[String(+(+x).toFixed(2))] || have[String(+r1(x).toFixed(2))]; }) && (r.s.body.indexOf(f.team) >= 0);
      });
      var relevant = used.filter(function (f) { return f.kind === 'unit' || f.kind === 'qb' || f.kind === 'qb_split' || f.kind === 'turnovers' || f.kind === 'availability' || f.kind === 'form' || f.kind === 'result' || f.kind === 'qb_availability'; });
      factCount[r.m.game_id] = relevant.length;
      if (relevant.length < (MATCH ? MATCH.CONFIG.min_independent_facts : 2)) factBad.push(r.m.identity.heading + ' (' + relevant.length + ')');
    });
    ig('facts_per_game', 'EDIT.FACTS_PER_GAME', factBad.length ? 'fail' : 'pass', 'At least two independent, verifiable facts per game, besides the projection', factBad.length ? 'too few: ' + factBad.join(', ') : null);
    /* 4 · where to watch: only the verified network, and only when it is
       CONFIRMED and fresh at this moment */
    var held = [], wrongNet = [];
    rows.forEach(function (r) {
      if (!r.m) return;
      var b = r.m.broadcast || {};
      var rec = { status: b.status, verified_at: b.verified_at, kickoff: r.m.schedule.kickoff };
      var pubNow = BCAST.publishable(Object.assign({}, rec, { networks: b.networks || [], streaming: b.streaming || [], regional: b.regional || [] }), now);
      if (!pubNow.ok) held.push(r.m.identity.heading + ': ' + pubNow.text);
      var allowed = [].concat(b.publishable ? (b.networks || []) : [], b.publishable ? (b.streaming || []).map(function (x) { return x.service; }) : [], b.publishable ? (b.regional || []).map(function (x) { return x.network; }) : []);
      var where = (r.parts.where || '') + '\n' + (r.parts.why || '').slice(0, 0);
      /* the source line names ESPN as a SOURCE, not a network */
      var scan = where.replace(/\*?Broadcast verified[^\n]*/g, ' ').replace(/ESPN’s (?:public )?scoreboard(?: listing)?|ESPN's (?:public )?scoreboard(?: listing)?|the ESPN app|an ESPN subscription/g, ' ');
      NETWORK_WORDS.forEach(function (nw) {
        var re = new RegExp('(^|[^A-Za-z0-9])(' + nw + ')(?![A-Za-z0-9+])', 'g'), mm;
        while ((mm = re.exec(scan))) {
          var name = BCAST.normalizeNetwork(mm[2].replace(/\\/g, ''));
          if (!allowed.some(function (x) { return BCAST.normalizeNetwork(x) === name; })) wrongNet.push(r.m.identity.heading + ': ' + name);
        }
      });
      if (/the ESPN app/.test(where) && !allowed.some(function (x) { return x === 'the ESPN app'; })) wrongNet.push(r.m.identity.heading + ': the ESPN app');
    });
    /* the schedule table, too */
    var guide = (a.sections || []).filter(function (s) { return s.key === 'watch_guide'; })[0];
    if (guide) String(guide.body).split('\n').forEach(function (line) {
      var m = ms.filter(function (x) { return line.indexOf(x.identity.home) >= 0 && line.indexOf(x.identity.away) >= 0; })[0];
      if (!m) return;
      var b = m.broadcast || {}, allowed = b.publishable ? (b.networks || []) : [];
      NETWORK_WORDS.forEach(function (nw) {
        var re = new RegExp('(^|[^A-Za-z0-9])(' + nw + ')(?![A-Za-z0-9+])', 'g'), mm;
        while ((mm = re.exec(line))) { var name = BCAST.normalizeNetwork(mm[2].replace(/\\/g, '')); if (!allowed.some(function (x) { return BCAST.normalizeNetwork(x) === name; })) wrongNet.push(m.identity.heading + ' (schedule table): ' + name); }
      });
    });
    ig('where_to_watch', 'EDIT.WHERE_TO_WATCH', wrongNet.length ? 'fail' : 'pass', 'Every network and streaming service named is the verified one', wrongNet.length ? 'not verified for that game: ' + uniq(wrongNet).join(', ') : null);
    ig('broadcast_verified', 'EDIT.BROADCAST', held.length ? 'fail' : 'pass', 'Every broadcast is verified and fresh at this moment', held.length ? 'held: ' + held.join('; ') : null);
    /* 5 · kickoff times: the verified time, in ET and CT, and no other clock */
    var kickBad = [];
    rows.forEach(function (r) {
      if (!r.m) return;
      var w = gtwWhen(r.m), where = r.parts.where || '';
      if (!w) { kickBad.push(r.m.identity.heading + ': no verified kickoff'); return; }
      if (where.indexOf(w.et) < 0 || where.indexOf(w.ct) < 0) kickBad.push(r.m.identity.heading + ': the section does not give ' + w.et + ' and ' + w.ct);
      var clocks = (where.replace(/\*?Broadcast verified[^\n]*/g, ' ').replace(/Schedule change:[^\n]*/g, ' ').match(/\b(?:\d{1,2}(?::\d{2})? ?(?:a\.m\.|p\.m\.|am|pm)|noon) [ECMP]T\b/gi) || []);
      var change = r.m.schedule.schedule_change;
      clocks.forEach(function (c) {
        if (c === w.et || c === w.ct) return;
        if (change) return; /* a verified move prints the old time once */
        kickBad.push(r.m.identity.heading + ': prints ' + c);
      });
    });
    ig('kickoff_times', 'EDIT.KICKOFF_TIMES', kickBad.length ? 'fail' : 'pass', 'Each game gives its verified kickoff in ET and CT, and no other time', kickBad.length ? uniq(kickBad).join('; ') : null);
    /* 6 · no generic filler, and no sentence repeated across games */
    var filler = [];
    var allBody = (a.sections || []).map(function (s) { return s.body; }).join('\n\n');
    GTW_FILLER.forEach(function (re) { var mm = re.exec(allBody); if (mm) filler.push('“' + mm[0] + '”'); });
    var seenS = {}, repeats = [];
    rows.forEach(function (r) {
      gtwSentences(r.s.body.replace(r.parts.where || '', ' ')).forEach(function (sent) {
        var norm = sent; if (r.m) [r.m.identity.home, r.m.identity.away].forEach(function (t) { norm = norm.split(t).join('TEAM'); });
        /* a sentence carrying the game's own numbers is data; only a
           number-free sentence repeated across games is boilerplate */
        if (/\d/.test(sent)) return;
        norm = norm.replace(/\s+/g, ' ').trim();
        if (norm.length < 50 || /^\*\*[^*]+\*\*\s*$|^- \*\*|^\*Broadcast|^- \*Broadcast/.test(sent.trim())) return;
        if (seenS[norm] && seenS[norm] !== r.s.key) repeats.push(sent.trim().slice(0, 90));
        seenS[norm] = seenS[norm] || r.s.key;
      });
    });
    ig('generic_filler', 'EDIT.GENERIC', filler.length ? 'fail' : 'pass', 'No generic filler', filler.length ? filler.join(', ') : null);
    add2(ig, 'repeated_sentences', repeats.length > 2 ? 'fail' : (repeats.length ? 'warn' : 'pass'), 'No boilerplate repeated from game to game', repeats.length ? repeats.length + ' repeated: “' + repeats[0] + '…”' : null);
    /* 7 · an upset case only where the packet makes one */
    var upBad = [];
    rows.forEach(function (r) {
      if (!r.m) return;
      var u = (r.m.arguments || {}).upset || {}, part = r.parts.upset || '';
      var claims = /\b(?:upset (?:path|alert|special|pick)|could (?:pull (?:off )?the|spring the) upset|the case for (?:it|an upset)|here’s how|here's how)\b/i.test(part);
      if (!u.credible && claims) upBad.push(r.m.identity.heading + ': writes an upset case the evidence does not make');
      if (u.credible) {
        var nums = {}; numbersIn(stripForNumbers(part)).forEach(function (n) { nums[String(+n.toFixed(2))] = 1; });
        var backed = (u.conditions || []).some(function (c) { return (c.facts || []).some(function (id) { var f = (r.m.facts || []).filter(function (x) { return x.id === id; })[0]; return f && (f.numbers || []).filter(function (x) { return Math.abs(x) >= 1; }).slice(0, 1).every(function (x) { return nums[String(+(+x).toFixed(2))] || nums[String(+r1(x).toFixed(2))]; }); }); });
        if (!backed) upBad.push(r.m.identity.heading + ': the upset case cites none of its evidence');
      }
    });
    ig('upset_supported', 'EDIT.UPSET_SUPPORTED', upBad.length ? 'fail' : 'pass', 'Upset cases only where the evidence makes one, with that evidence', upBad.length ? upBad.join('; ') : null);
    /* 8 · injuries: a player given a status is on the official report with that status */
    var injBad = [];
    var listed = {};
    ms.forEach(function (m) { ['home', 'away'].forEach(function (s) { var av = m.availability && m.availability[s]; ((av && av.listed) || []).forEach(function (x) { listed[x.player] = x.status; }); }); });
    var known = {};
    ms.forEach(function (m) { ['home', 'away'].forEach(function (s) { var q = m.quarterbacks && m.quarterbacks[s]; ((q && q.lines) || []).forEach(function (l) { known[l.player] = 1; }); }); });
    blockSentencesOf(allBody).forEach(function (sent) {
      var st = /\b(?:ruled out|is out|are out|will not play|won’t play|won't play|questionable|doubtful|injured|out for the (?:game|season)|day-to-day|game-time decision)\b/i.exec(sent);
      if (!st) return;
      Object.keys(known).concat(Object.keys(listed)).forEach(function (pl) {
        if (sent.indexOf(pl) < 0) return;
        if (/\bnot on the\b|does not appear|appears? on the|nor .* appears/i.test(sent) && !listed[pl]) return;
        if (!listed[pl]) injBad.push(pl + ' is given a status but is not on the official report');
      });
    });
    var people = (sentenceText(allBody).match(/\b[A-Z][a-z]+(?:[-'’][A-Z][a-z]+)? [A-Z][a-z]+(?:[-'’][A-Z][a-z]+)?\b(?= (?:is|was) (?:out|questionable|doubtful|injured|ruled out))/g) || []);
    people.forEach(function (pl) { if (!listed[pl]) injBad.push(pl + ': an injury status with no official report on file'); });
    ig('injury_claims', 'EDIT.INJURY_VERIFIED', injBad.length ? 'fail' : 'pass', 'Every injury status is from the official availability report', injBad.length ? uniq(injBad).slice(0, 5).join('; ') : null);
    /* 9 · attribution: the publisher edition carries EdgeDesk's credit line;
       EdgeDesk's own edition links its research and the free signup */
    if (FORMATS[a.format] && FORMATS[a.format].edition === 'first_party') {
      var links = (allBody.match(/\]\(https:\/\/edgedesksports\.com\/research\/cfb\/[^)]*\)/g) || []).length;
      var cta = /\/newsletter\//.test(allBody);
      ig('first_party_links', 'EDIT.FIRST_PARTY', links >= ms.length && cta ? 'pass' : 'fail', 'EdgeDesk edition links each game’s research and the free signup', (links < ms.length ? links + ' research links for ' + ms.length + ' games; ' : '') + (cta ? '' : 'no free-signup link'));
    } else {
      var att = attributionFor(a, o, { publisher: { editorial: ed } });
      ig('publisher_attribution', 'EDIT.ATTRIBUTION', /Research by EdgeDesk Sports/.test(att) ? 'pass' : 'fail', 'EdgeDesk is credited in the publisher edition', null);
    }
  }
  /* sentences without splitting at "p.m.", "Oct." or "No." */
  var ABBR = /\b(a\.m|p\.m|vs|No|Jan|Feb|Aug|Sept|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|St|Jr|Sr)\./g;
  function gtwSentences(t) {
    return blockSentencesOf(String(t).replace(ABBR, function (m) { return m.replace(/\./g, '\u2024'); })).map(function (x) { return x.replace(/\u2024/g, '.'); });
  }
  function sentenceText(t) { return String(t || '').replace(/\*+/g, ''); }
  function add2(ig, id, status, label, detail) { ig(id, 'EDIT.GENERIC', status, label, detail); }

  /* THE EDITORIAL REVIEW REPORT: per game, the six answers, the facts used,
     the broadcast, and the verdict — REJECT (fails an essential requirement:
     regenerate or discard), HOLD (verify a broadcast or a kickoff and run the
     checks again), or READY (the owner may approve). */
  var GTW_HOLD_RULES = ['EDIT.BROADCAST', 'EDIT.KICKOFF_TIMES'];
  var GTW_REJECT_RULES = ['EDIT.REASONING', 'EDIT.FACTS_PER_GAME', 'EDIT.SECTIONS', 'EDIT.DUPLICATE_MATCHUP', 'EDIT.WHERE_TO_WATCH', 'EDIT.GENERIC', 'EDIT.UPSET_SUPPORTED',
    'EDIT.INJURY_VERIFIED', 'EDIT.NUMBERS', 'EDIT.CONTRADICTION', 'EDIT.QB_UNCERTAINTY', 'EDIT.FIXTURE', 'EDIT.ATTRIBUTION', 'EDIT.FIRST_PARTY', 'EDIT.GTW_ENGINE', 'EDIT.ENGINE'];
  function reviewReport(a, o, report) {
    var R = o.research || {}, ms = R.matchups || [];
    var checks = (report && report.checks) || [], blocking = (report && report.integrity && report.integrity.blocking) || [];
    var fails = checks.filter(function (c) { return c.status === 'fail'; });
    var essential = fails.filter(function (c) { return ['numbers_in_evidence', 'no_recommendation', 'teams_in_evidence', 'structure', 'empty_sections', 'no_stringified_nothing'].indexOf(c.id) >= 0; });
    var rejectR = blocking.filter(function (b) { return GTW_REJECT_RULES.indexOf(b.rule_id) >= 0; });
    var holdR = blocking.filter(function (b) { return GTW_HOLD_RULES.indexOf(b.rule_id) >= 0; });
    var other = blocking.filter(function (b) { return GTW_REJECT_RULES.indexOf(b.rule_id) < 0 && GTW_HOLD_RULES.indexOf(b.rule_id) < 0; });
    var verdict = essential.length || rejectR.length ? 'REJECT' : (holdR.length || other.length || fails.length ? 'HOLD' : 'READY');
    var secs = gtwSectionsOf(a);
    var games = ms.map(function (m) {
      var s = secs.filter(function (x) { var h = String(x.heading || '') + x.body.slice(0, 200); return h.indexOf(m.identity.home) >= 0 && h.indexOf(m.identity.away) >= 0; })[0];
      var g = m.gate || {};
      return { game_id: m.game_id, heading: m.identity.heading, section: s ? s.key : null,
        answers: g.answers || null, independent_facts: g.independent_facts, missing: (g.missing || []).map(function (x) { return x.code; }),
        deciding: m.arguments && m.arguments.deciding ? m.arguments.deciding.claim : null,
        upset: m.arguments && m.arguments.upset ? (m.arguments.upset.credible ? 'case on the evidence' : 'no case: ' + m.arguments.upset.reason) : null,
        broadcast: { status: m.broadcast.status, tier: m.broadcast.tier, network: m.broadcast.network, verified_at: m.broadcast.verified_at, publishable: m.broadcast.publishable, hold: m.broadcast.hold_reason },
        kickoff: gtwWhen(m), unresolved: (m.unresolved || []).map(function (u) { return u.text; }) };
    });
    return { schema: 'edgedesk_editorial_review_v1', format: a.format, verdict: verdict,
      reject: essential.map(function (c) { return { id: c.id, detail: c.detail }; }).concat(rejectR.map(function (b) { return { id: b.rule_id, detail: b.explanation }; })),
      hold: holdR.concat(other).map(function (b) { return { id: b.rule_id, detail: b.explanation }; }),
      warnings: checks.filter(function (c) { return c.status === 'warn'; }).map(function (c) { return { id: c.id, detail: c.detail }; }),
      games: games, selection: R.selection ? { report: R.selection.report, rejected: R.selection.rejected } : null,
      checked_at: report ? report.checked_at : null };
  }

  /* HOW INFORMATIVE an article is: the independent facts it states and
     their variety, per game — the measure the regression compares with the
     old projection-only preview */
  function informativeness(a, o) {
    var R = o.research || {}, ms = R.matchups || [];
    var body = (a.sections || []).map(function (s) { return s.body; }).join('\n\n');
    var have = {}; numbersIn(stripForNumbers(body)).forEach(function (n) { have[String(+n.toFixed(2))] = 1; });
    var perGame = ms.map(function (m) {
      var used = (m.facts || []).filter(function (f) { return f.independent && (f.numbers || []).filter(function (x) { return Math.abs(x) >= 1; }).slice(0, 2).every(function (x) { return have[String(+(+x).toFixed(2))] || have[String(+r1(x).toFixed(2))]; }) && (f.numbers || []).some(function (x) { return Math.abs(x) >= 1; }) && body.indexOf(f.team) >= 0; });
      return { game_id: m.game_id, heading: m.identity.heading, facts: used.length, kinds: uniq(used.map(function (f) { return f.kind; })) };
    });
    var where = GTW_PARTS[0].re.test(body);
    return { games: perGame.length, independent_facts: perGame.reduce(function (x, g) { return x + g.facts; }, 0),
      min_facts_per_game: perGame.length ? Math.min.apply(null, perGame.map(function (g) { return g.facts; })) : 0,
      fact_kinds: uniq([].concat.apply([], perGame.map(function (g) { return g.kinds; }))), where_to_watch: where,
      words: wordCount(body), per_game: perGame };
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
    /* EdgeDesk's own edition: its own site, no campaign tags */
    if (a && FORMATS[a.format] && FORMATS[a.format].edition === 'first_party') return line + ' Every game’s full research is on [EdgeDesk’s free board](' + SITE + '/today/).';
    var landing = ctx.landing || SITE + '/today/';
    return line + ' See every game’s numbers at [EdgeDesk](' + tagLink(landing, utmFor(pub, a, ctx.campaign)) + ').' + (ed.attribution ? ' ' + ed.attribution : '');
  }

  /* ctx: { publisher, campaign, frontMatter: bool, opportunity } */
  function toMarkdown(a, ctx) {
    ctx = ctx || {};
    /* EdgeDesk's own edition links within its own site: no campaign tags,
       which would overwrite the reader's real source */
    var utm = FORMATS[a.format] && FORMATS[a.format].edition === 'first_party' ? null : utmFor(ctx.publisher, a, ctx.campaign);
    var out = [];
    if (ctx.frontMatter) {
      out.push('---');
      out.push('title: ' + JSON.stringify(a.title));
      out.push('slug: ' + JSON.stringify(a.slug));
      out.push('meta_description: ' + JSON.stringify(a.meta_description || ''));
      out.push('primary_keyword: ' + JSON.stringify(a.primary_keyword || ''));
      out.push('secondary_keywords: ' + JSON.stringify(a.secondary_keywords || []));
      if (ctx.snapshot) {
        out.push('edgedesk_revision: ' + JSON.stringify(ctx.snapshot.revision));
        out.push('edgedesk_content_hash: ' + JSON.stringify(ctx.snapshot.content_hash || ''));
        out.push('edgedesk_research_hash: ' + JSON.stringify(ctx.snapshot.research_hash || ''));
        out.push('edgedesk_research_as_of: ' + JSON.stringify(ctx.snapshot.research_as_of || ''));
        out.push('edgedesk_approved: ' + JSON.stringify(!!(ctx.snapshot.approved_hash && ctx.snapshot.approved_hash === ctx.snapshot.content_hash)));
      }
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
      + (ctx.snapshot ? '<meta name="edgedesk-snapshot" content="' + esc(snapshotLine(ctx.snapshot)) + '">' : '')
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
      if (ctx.snapshot) body.push(para(null, run({ t: snapshotLine(ctx.snapshot) })));
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
     THE APPROVED SNAPSHOT IN EVERY EXPORT (docs/system-integrity/RULES.md,
     EXPORT.*). Every file carries the snapshot it was made from — revision,
     content and research fingerprints, the research time, the approval — and
     every file is READ BACK before it leaves: the numbers in the Markdown
     text, the HTML's text and the Word file's runs must be the approved
     article's numbers, in the same order. A renderer that drops, rounds or
     reorders a number is caught here, not by a publisher's reader.
     ====================================================================== */
  function snapshotOf(row) {
    row = row || {};
    return { revision: row.revision != null ? row.revision : null, status: row.status || null,
      content_hash: row.content_hash || null, approved_hash: row.approved_hash || null, approved_at: row.approved_at || null,
      research_hash: row.research_hash || null, approved_research_hash: row.approved_research_hash || null,
      research_as_of: row.research_as_of || null, numbers: null };
  }
  function shortHash(h) { return h ? String(h).slice(0, 12) : 'none'; }
  function snapshotLine(snap) {
    if (!snap) return null;
    var asOf = ts(snap.research_as_of), at = ts(snap.approved_at);
    return 'EdgeDesk snapshot: revision ' + (snap.revision != null ? snap.revision : '?') + ' · content ' + shortHash(snap.content_hash)
      + ' · research ' + shortHash(snap.research_hash) + (asOf ? ' · research as of ' + new Date(asOf).toISOString() : '')
      + ' · ' + (snap.approved_hash && snap.approved_hash === snap.content_hash ? 'approved' + (at ? ' ' + new Date(at).toISOString() : '') : 'NOT APPROVED')
      + (snap.numbers ? ' · numbers ' + snap.numbers : '');
  }
  /* the article's own text, independent of every renderer: what the
     approved snapshot says, in reading order */
  function canonicalText(a, ctx) {
    var parts = [a.title, a.standfirst];
    (a.sections || []).forEach(function (s) { parts.push(s.heading || '', s.body); });
    parts.push(attributionFor(a, ctx && ctx.opportunity, ctx || {}), DISCLAIMER);
    return parts.filter(function (x) { return x; }).join('\n\n');
  }
  function plainOfMarkdown(md) {
    return String(md).replace(/\]\((?:https?:\/\/[^)\s]+)\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
  }
  function plainOfHtml(html) {
    return String(html).replace(/<[^>]*>/g, ' ')
      .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&(amp|lt|gt|quot|nbsp);/g, function (_, e) { return { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }[e]; });
  }
  /* the Word file's text, up to the editor's page: zipStore writes entries
     uncompressed, so document.xml is readable as it is */
  function plainOfDocx(bytes) {
    var s = new TextDecoder().decode(bytes);
    var i = s.indexOf('<w:document'), j = s.indexOf('</w:document>', i);
    if (i < 0 || j < 0) return null;
    var doc = s.slice(i, j), stop = doc.indexOf('For the editor (not for publication)');
    if (stop >= 0) doc = doc.slice(0, doc.lastIndexOf('<w:p>', stop) >= 0 ? doc.lastIndexOf('<w:p>', stop) : stop);
    return doc.split('</w:p>').map(function (p) {
      var out = [], re = /<w:t[^>]*>([^<]*)<\/w:t>/g, m;
      while ((m = re.exec(p))) out.push(m[1]);
      return out.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }).join('\n');
  }
  function numberSeq(text) { return numbersIn(stripForNumbers(text)).map(function (n) { return String(+n.toFixed(4)); }); }
  function numbersFingerprint(a, ctx) { return hash(numberSeq(plainOfMarkdown(canonicalText(a, ctx))).join(',')).slice(0, 12); }
  function firstDiff(x, y) {
    for (var i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { at: i, approved: x[i] == null ? null : x[i], exported: y[i] == null ? null : y[i] };
    return null;
  }
  /* exportCheck(a, row, ctx, opts) → { ok, snapshot, formats: { md, html, docx }, problems }
     a    the article being exported (built from the row)
     row  the stored article (status, hashes, revision)
     opts.require_approved  (default true) the export must be of the approved content */
  function exportCheck(a, row, ctx, opts) {
    ctx = ctx || {}; opts = opts || {};
    var snap = snapshotOf(row), problems = [];
    snap.numbers = numbersFingerprint(a, ctx);
    var requireApproved = opts.require_approved !== false;
    if (requireApproved && !(snap.approved_hash && snap.approved_hash === snap.content_hash))
      problems.push({ id: 'EXPORT.APPROVED', detail: 'this is not the approved content: approve the current revision first' });
    if (requireApproved && snap.approved_research_hash && snap.research_hash && snap.approved_research_hash !== snap.research_hash)
      problems.push({ id: 'EXPORT.RESEARCH', detail: 'the research changed after approval' });
    var want = numberSeq(plainOfMarkdown(canonicalText(a, ctx)));
    var c = Object.assign({}, ctx, { snapshot: null });
    var got = {
      md: numberSeq(plainOfMarkdown(toMarkdown(a, Object.assign({}, c, { frontMatter: false })))),
      html: numberSeq(plainOfHtml(toHtml(a, c))),
      docx: (function () { var t = plainOfDocx(toDocx(a, Object.assign({}, c, { editorNotes: false }))); return t == null ? null : numberSeq(t); })()
    };
    var formats = {};
    Object.keys(got).forEach(function (k) {
      var seq = got[k], d = seq ? firstDiff(want, seq) : { at: 0, approved: want[0] || null, exported: null };
      formats[k] = { ok: !d, numbers: seq ? seq.length : 0, first_difference: d };
      if (d) problems.push({ id: 'EXPORT.NUMBERS', format: k, detail: k + ' export differs from the approved numbers at #' + (d.at + 1) + ': approved ' + d.approved + ', exported ' + d.exported });
    });
    var mdFull = toMarkdown(a, c);
    if (mdFull.indexOf(DISCLAIMER) < 0) problems.push({ id: 'EXPORT.DISCLOSURE', detail: 'the disclaimer is missing from the export' });
    var ed = (ctx.publisher && ctx.publisher.editorial) || {};
    var camp = (row && row.campaign_code) || ctx.campaign;
    if (ed.links_allowed !== false && (!camp || mdFull.indexOf('utm_campaign=' + camp) < 0))
      problems.push({ id: 'EXPORT.REFERRAL', detail: 'no EdgeDesk link carries this article’s campaign code' });
    return { ok: problems.length === 0, snapshot: snap, snapshot_line: snapshotLine(snap), expected_numbers: want.length, formats: formats, problems: problems };
  }

  /* compareCopy(text, a, ctx) — an edited or published copy against the
     approved numbers: which ones changed. Read-only; for the owner's check
     of what a publisher ran. */
  function compareCopy(text, a, ctx) {
    var want = numberSeq(plainOfMarkdown(canonicalText(a, ctx)));
    var got = numberSeq(/<[a-z][\s\S]*>/i.test(text) ? plainOfHtml(text) : plainOfMarkdown(text));
    var bag = {}; want.forEach(function (n) { bag[n] = (bag[n] || 0) + 1; });
    var extra = []; got.forEach(function (n) { if (bag[n]) bag[n]--; else extra.push(n); });
    var dropped = []; Object.keys(bag).forEach(function (n) { for (var i = 0; i < bag[n]; i++) dropped.push(n); });
    return { same: !extra.length && !dropped.length, not_in_approved: extra, missing_from_copy: dropped };
  }

  /* readiness(row, opts) — the checklist before "Ready to send". Each item
     names what it checks, and the database enforces the starred ones again
     (supabase/content_engine.sql: articles_guard, the transition door).
     opts: { opportunity (with research_hash), publisher, ctx (export ctx) } */
  function readiness(row, opts) {
    opts = opts || {}; row = row || {};
    var ch = row.checks || {}, list = ch.checks || [], items = [];
    function st(ids) {
      var got = list.filter(function (c) { return ids.indexOf(c.id) >= 0; });
      if (!got.length) return { status: 'unknown', detail: 'not checked: run the checks again' };
      var bad = got.filter(function (c) { return c.status === 'fail'; });
      return bad.length ? { status: 'fail', detail: bad.map(function (c) { return c.label + (c.detail ? ': ' + c.detail : ''); }).join(' · ') } : { status: 'pass', detail: null };
    }
    function item(id, label, r, db) { items.push({ id: id, label: label, status: r.status, detail: r.detail || null, enforced_by_database: !!db }); }
    var approved = !!(row.approved_hash && row.approved_hash === row.content_hash && row.approved_by);
    item('owner_approval', 'Approved by the owner, exactly this revision', { status: approved ? 'pass' : 'fail', detail: approved ? null : 'approve the current revision' }, true);
    var ist = ch.integrity_status;
    item('integrity', 'Integrity engine: no blocked game or claim', { status: ist === 'PASS' || ist === 'WARNING' ? 'pass' : (ist ? 'fail' : 'unknown'),
      detail: ist === 'BLOCKED' ? ((ch.integrity && ch.integrity.blocking) || []).map(function (b) { return b.rule_id; }).join(', ') : (ist ? null : 'no integrity verdict on file: run the checks again') }, true);
    var o = opts.opportunity;
    var resOk = o && o.research_hash ? (row.research_hash === o.research_hash && (!row.approved_research_hash || row.approved_research_hash === o.research_hash)) : null;
    item('research_unchanged', 'The research has not changed since approval', { status: resOk === null ? 'unknown' : (resOk ? 'pass' : 'fail'), detail: resOk === false ? 'the research changed: refresh, check and approve again' : null }, true);
    item('matchups', 'Every matchup is a real, verified, unstarted game', st(['teams_in_evidence', 'games_publishable', 'games_not_started', 'kickoff_claims']));
    item('numbers', 'Every number is from the research, on the right game', st(['numbers_in_evidence', 'numbers_per_game', 'spread_claims']));
    item('claims', 'Outside claims attributed; injury and quarterback claims sourced', st(['reporting_attributed', 'unsourced_reporting', 'qb_claims_sourced', 'conference_claims', 'names_in_evidence']));
    item('sources_timestamps', 'Research time stated; old prices labelled old', (function () {
      var r = st(['research_fresh', 'stale_prices_labelled']);
      if (!row.research_as_of) return { status: 'fail', detail: 'no research time on file' };
      return r;
    })());
    item('language', 'No pick, lock or value language', st(['no_recommendation', 'projection_not_value']));
    if (FORMATS[row.format] && FORMATS[row.format].edition) {
      /* re-verified at this moment: a broadcast confirmed on Tuesday is held
         on Friday until it is checked again */
      var gtwNow = opts.opportunity && opts.opportunity.research && opts.opportunity.research.matchups ? opts.opportunity.research.matchups : null;
      var held = gtwNow && BCAST ? gtwNow.filter(function (m) { return !BCAST.publishable({ status: m.broadcast.status, verified_at: m.broadcast.verified_at, kickoff: m.schedule.kickoff }, isNum(opts.now) ? opts.now : Date.now()).ok; }) : null;
      item('broadcasts', 'Every broadcast verified and fresh now; kickoffs in ET and CT', held && held.length ? { status: 'fail', detail: 'verify again: ' + held.map(function (m) { return m.identity.heading + ' (' + (m.broadcast.hold_reason || m.broadcast.status) + ')'; }).join('; ') } : st(['broadcast_verified', 'where_to_watch', 'kickoff_times']));
      item('editorial', 'Six answers and two independent facts per game; no filler, duplicates or unsupported upset cases', st(['reasoning_gate', 'six_parts', 'facts_per_game', 'generic_filler', 'duplicate_matchup', 'upset_supported', 'injury_claims', 'not_fixture']));
    }
    item('seo', 'Headline, slug, meta description and keyword', st(['headline', 'seo_meta', 'seo_slug', 'seo_keyword']));
    var x = row.title ? exportCheck({ format: row.format, title: row.title, slug: row.slug, meta_description: row.meta_description, standfirst: row.standfirst,
      primary_keyword: row.primary_keyword, secondary_keywords: row.secondary_keywords, sections: row.sections }, row, opts.ctx || {}) : null;
    var ref = x && x.problems.filter(function (p) { return p.id === 'EXPORT.REFERRAL'; });
    item('referral', 'The EdgeDesk link carries this article’s campaign code', !row.campaign_code ? { status: 'fail', detail: 'no campaign code' } : (ref && ref.length ? { status: 'fail', detail: ref[0].detail } : { status: x ? 'pass' : 'unknown', detail: null }));
    var dis = x && x.problems.filter(function (p) { return p.id === 'EXPORT.DISCLOSURE'; });
    var disc = st(['disclaimer']);
    item('disclosures', 'Disclaimer, 21+ line and research credit', dis && dis.length ? { status: 'fail', detail: dis[0].detail } : disc);
    var num = x && x.problems.filter(function (p) { return p.id === 'EXPORT.NUMBERS'; });
    item('exports_reconcile', 'Markdown, HTML and Word carry the approved numbers', !x ? { status: 'unknown', detail: null } : (num.length ? { status: 'fail', detail: num.map(function (p) { return p.detail; }).join(' · ') } : { status: 'pass', detail: null }));
    var failed = items.filter(function (i) { return i.status !== 'pass'; });
    return { ok: failed.length === 0, items: items, blocking: failed.map(function (i) { return i.id; }), snapshot_line: x ? x.snapshot_line : null };
  }

  /* ======================================================================
     COST — what a Claude call can cost and did cost (docs/system-integrity/
     COST.md). One implementation for both hosts that make calls (the Edge
     Function, the weekly job): each call is RESERVED in the database before
     it is made at the UPPER BOUND estimate() returns
     (content_engine_ai_reserve takes one month lock, so concurrent calls
     cannot pass the $10 cap together) and SETTLED after it at measured()
     (content_engine_ai_settle). Prices are list prices, USD per million
     tokens (Anthropic first-party API, 2026-10); cacheWrite is the 5-minute
     write (1.25× input). A model missing from the table is priced at
     CEILING, so a new or renamed model is never counted as cheaper than it
     is.
     ====================================================================== */
  var PRICES = {
    'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
    'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
  };
  var PRICE_CEILING = { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 };
  /* the models the server-side fallback ('default') can hand a declined request to */
  var FALLBACK_MODELS = ['claude-opus-5', 'claude-opus-4-8'];
  function priceOf(model) { return PRICES[String(model || '')] || PRICE_CEILING; }
  /* the most a request can cost: input at one token per three characters
     (prose runs nearer four, so this over-counts), output at the full
     max_tokens (thinking included), and — because a policy decline can be
     billed and then re-run on a fallback model — the same again at the
     dearest fallback's price. Capped at the $5 a single reservation may hold. */
  function costEstimate(req, model) {
    var inTok = Math.ceil(JSON.stringify({ system: req.system, messages: req.messages }).length / 3) + 500;
    var outTok = +req.max_tokens || 16000;
    var p = priceOf(model);
    var f = FALLBACK_MODELS.map(priceOf).reduce(function (a, b) { return a.out >= b.out ? a : b; });
    var usd = (inTok * p.in + outTok * p.out) / 1e6 + (inTok * f.in + outTok * f.out) / 1e6;
    return Math.min(5, Math.ceil(usd * 1e6) / 1e6);
  }
  /* the measured cost of a reply, from the token counts the API reports.
     usage.iterations (present when a fallback ran) is the per-attempt record:
     a plain attempt is priced at the requested model, the fallback attempt at
     the model that served it. No usage at all → null: settled at the estimate. */
  function costMeasured(message, model) {
    var u = message && message.usage;
    if (!u) return null;
    var its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
    var t = { usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, basis: its === u.iterations ? 'iterations' : 'usage' };
    its.forEach(function (it) {
      var p = it && it.type === 'fallback_message' ? (PRICES[String(message.model || '')] || PRICE_CEILING) : priceOf(model);
      var i = +it.input_tokens || 0, o = +it.output_tokens || 0, cr = +it.cache_read_input_tokens || 0, cw = +it.cache_creation_input_tokens || 0;
      t.input_tokens += i; t.output_tokens += o; t.cache_read_tokens += cr; t.cache_write_tokens += cw;
      t.usd += (i * p.in + o * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1e6;
    });
    t.usd = Math.round(t.usd * 1e6) / 1e6;
    return t;
  }
  /* the request's fingerprint (SHA-256, hex): the same model, article
     version, section and prompt make the same key, so a request already made
     and paid for is refused as a duplicate instead of being paid for twice.
     scope: { article, content_hash, section } or { opportunity, research_hash, format } */
  function costRequestKey(model, scope, req) {
    var body = canonicalJson({ model: model, scope: scope || {}, system: req.system, messages: req.messages, output_config: req.output_config, max_tokens: req.max_tokens });
    var C = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle;
    if (!C) return Promise.reject(new Error('no WebCrypto in this host'));
    return C.digest('SHA-256', new TextEncoder().encode(body)).then(function (d) {
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    });
  }
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  }
  /* what the owner is told when the budget door refuses a call */
  var COST_REFUSALS = {
    duplicate: 'Claude already rewrote exactly this draft from exactly this research, and that version failed the checks; edit the draft or refresh the research before asking again (nothing was spent)',
    in_flight: 'a rewrite of this article is already running',
    retry_limit: 'this request failed too many times; nothing more is spent on it',
    monthly_budget_exhausted: 'the content engine’s monthly AI budget is used up; the deterministic draft stands',
    job_budget_exhausted: 'this run’s AI budget is used up; the deterministic draft stands'
  };

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
    '7. Explain jargon in plain words. No generic filler ("delve into", "game-changer", "at the end of the day", "must-watch", "buckle up").',
    'Formatting: section bodies are Markdown — paragraphs, "### " game headings inside the games section, "- " bullets, **bold**, [text](https://...) links. Do not write the disclaimer or the attribution footer; EdgeDesk adds both.'
  ].join('\n');

  /* a games-to-watch packet for the writer: the verified facts, the
     arguments and the where-to-watch block it must copy — not the raw
     pairings, cards and listings it was built from (fewer tokens, nothing
     the writer could misuse). section: only that game's packet. */
  function compactMatchup(m, i, ed) {
    var A = m.arguments || {}, md = m.model || {};
    return {
      section: 'game_' + (i + 1), heading: gtwHeading(m, i, ed), where_to_watch_block: gtwWhere(m, ed),
      facts: (m.facts || []).filter(function (f) { return f.kind !== 'opposition'; }).map(function (f) { return { id: f.id, team: f.team, kind: f.kind, independent: f.independent, text: ed === 'first_party' ? f.alt : f.text }; }),
      why_watch: (A.why_watch || []).filter(function (w) { return !w.model; }).map(function (w) { return w.text; }),
      deciding: A.deciding ? { claim: ed === 'first_party' ? A.deciding.alt : A.deciding.claim, facts: A.deciding.facts } : null,
      projection: md.available ? { line: md.favorite ? md.favorite + ' by ' + oneDp(md.margin) : 'pick’em', favorite_win_pct: md.fav_win_pct, total: md.total, reliability: md.reliability,
        market: md.gap_state === 'COMPARABLE' ? { line: md.market.text, book: md.market.book, captured: whenText(ts(md.market.captured_at)), gap: md.gap ? oneDp(md.gap.points) : null } : { state: md.gap_state, captured: md.market && md.market.captured_at ? whenText(ts(md.market.captured_at)) : null },
        inputs: (md.inputs || []).map(function (x) { return x.label + ' (' + oneDp(x.points) + ' points toward ' + x.favors + ')'; }) } : null,
      why_model_could_be_wrong: (A.model_wrong || []).map(function (w) { return w.text; }),
      upset: A.upset ? { credible: !!A.upset.credible, underdog: A.upset.team, underdog_win_pct: A.upset.dog_win_pct, case_for: (A.upset.conditions || []).map(function (c) { return c.text; }), case_against: (A.upset.counter || []).map(function (c) { return c.text; }), no_case_reason: A.upset.credible ? null : A.upset.reason } : null,
      what_to_watch: (A.watch_for || []).map(function (w) { return w.text; }),
      limits: m.limits || []
    };
  }
  function compactPacket(o, ctx) {
    ctx = ctx || {};
    if (o.kind === 'games_to_watch') {
      var ed = FORMATS[ctx.format] && FORMATS[ctx.format].edition || 'publisher';
      var ms = (o.research.matchups || []).map(function (m, i) { return compactMatchup(m, i, ed); });
      if (ctx.section && /^game_\d+$/.test(ctx.section)) ms = ms.filter(function (x) { return x.section === ctx.section; });
      return { league: o.league, season: o.season, week: o.week, kind: o.kind, edition: ed, as_of: o.research.as_of, games: ms, limitations: o.research.limitations || [] };
    }
    /* what the writer may use: the research minus internal identifiers */
    return {
      league: o.league, season: o.season, week: o.week, kind: o.kind, as_of: o.research.as_of,
      context: Object.assign({}, o.research.context, { team_names: undefined }), conference: o.research.conference || null, conference_top: o.research.conference_top || null,
      focus: o.research.focus || null, news: o.research.news || [],
      games: (o.research.games || []).map(stripGame), upsets: (o.research.upsets || []).map(stripGame), races: (o.research.races || []).map(stripGame),
      limitations: o.research.limitations || []
    };
  }
  function stripGame(p) {
    var c = Object.assign({}, p);
    delete c.flags; delete c.game_id;
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
      ? 'Rewrite ONLY the section with key "' + ctx.section + '". Return the article object with the title, meta description and standfirst copied unchanged and "sections" holding that one section; EdgeDesk keeps every other section as it is.'
      : 'Write the full article. Keep the section keys and order of the CURRENT DRAFT (you may improve every heading and every word). The deterministic CURRENT DRAFT is accurate but plain: make it read like good sports journalism without adding facts.';
    var user = [
      task,
      'FORMAT: ' + format + ' — ' + ((FORMATS[format] || {}).label || ''),
      'SEO: primary keyword "' + (o.seo && o.seo.primary_keyword) + '"; use it naturally in the headline and first paragraph, never stuffed. Meta description 120–155 characters.',
      pubTxt,
      ctx.objections && ctx.objections.length ? 'YOUR PREVIOUS DRAFT WAS REJECTED FOR: ' + ctx.objections.join(' | ') + '. Fix exactly these.' : null,
      o.kind === 'games_to_watch' ? GTW_RULES(FORMATS[format] && FORMATS[format].edition) : null,
      'RESEARCH PACKET (the only facts you may use):\n' + JSON.stringify(compactPacket(o, { format: format, section: ctx.section })),
      'CURRENT DRAFT:\n' + JSON.stringify({ title: base.title, meta_description: base.meta_description, standfirst: base.standfirst,
        /* a one-section rewrite carries only that section: the rest is kept from the draft */
        sections: ctx.section ? base.sections.filter(function (x) { return x.key === ctx.section; }) : base.sections })
    ].filter(Boolean).join('\n\n');
    return {
      system: AI_SYSTEM,
      messages: [{ role: 'user', content: user }],
      /* a one-section rewrite cannot need the whole article's output budget,
         and the reservation is made at this bound */
      max_tokens: ctx.section ? 4000 : 16000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: AI_SCHEMA } }
    };
  }

  function GTW_RULES(ed) {
    var L = ed === 'first_party'
      ? ['**Kickoff and broadcast.**', '**The stakes.**', '**Where it’s decided.**', '**EdgeDesk’s number.**', '**If the underdog wins, here’s how.** (or **Why there’s no upset case.**)', '**Watch for.**']
      : ['**Where to watch**', '**Why it matters.**', '**The key matchup.**', '**EdgeDesk’s projection.**', '**Upset potential.**', '**What to watch**'];
    return ['FIVE GAMES TO WATCH — RULES FOR THIS FORMAT (each one is checked by machine):',
      'a. Every game section (game_1 … game_N) keeps these six bold labels, in this order: ' + L.join(', ') + '.',
      'b. Copy each game’s where_to_watch_block exactly. Never name any other TV network or streaming service, and never change a kickoff time.',
      'c. Each game section states at least two facts whose "independent" is true, with their numbers exactly as written. The projection never counts as one.',
      'd. Write an upset case only where upset.credible is true, using case_for and case_against; otherwise say why there is no case (no_case_reason).',
      'e. Give an injury or availability status only for players named in an availability fact, as the fact states it.',
      'f. No generic filler ("anything can happen", "statement game", "must-win", "something has to give"). Each game needs its own sentences.',
      ed === 'first_party' ? 'g. Keep every link to edgedesksports.com research pages and the free newsletter signup.' : 'g. Write for a general sports audience: explain each number in plain words.'].join('\n');
  }
  /* which game sections a failed check names, so only those are rewritten */
  function failingSections(report, a) {
    var out = [];
    var bad = ((report && report.checks) || []).filter(function (c) { return c.status === 'fail' && c.detail; });
    gtwSectionsOf(a).forEach(function (s) {
      var h = String(s.heading || '').replace(/^\d+\.\s*/, '').replace(/No\. \d+ /g, '').replace(/:.*$/, '');
      if (bad.some(function (c) { return c.detail.indexOf(h) >= 0; })) out.push(s.key);
    });
    /* a failure that names no game is the whole article's */
    var global = bad.some(function (c) { return !gtwSectionsOf(a).some(function (s) { var h = String(s.heading || '').replace(/^\d+\.\s*/, '').replace(/No\. \d+ /g, '').replace(/:.*$/, ''); return c.detail.indexOf(h) >= 0; }); });
    return { sections: out, whole_article: global };
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
    story: { score: storyScore, storyline: storyline }, investigations: investigations,
    integrity: { ok: INTEGRITY_OK, packetRecord: packetRecord, attach: attachIntegrity },
    news: { parseFeed: parseFeed, match: matchNews, classify: classifyNews },
    discover: discover, seoBrief: seoBrief, outline: outline, draft: draft,
    evidence: evidenceOf, validate: validate, similarity: similarity, teamsMentioned: teamsMentioned,
    gamesToWatch: { OK: GTW_OK, PARTS: GTW_PARTS, HOLD_RULES: GTW_HOLD_RULES, REJECT_RULES: GTW_REJECT_RULES, matchupsOf: matchupsOf, sections: gtwSections, headline: gtwHeadline,
      review: reviewReport, informativeness: informativeness, when: gtwWhen },
    campaignCode: campaignCode, tagLink: tagLink, attribution: attributionFor,
    toMarkdown: toMarkdown, toHtml: toHtml, mdToHtml: mdToHtml, seoSheet: seoSheet, toDocx: toDocx, DOCX_TYPE: DOCX_TYPE,
    exportCheck: exportCheck, snapshotOf: snapshotOf, snapshotLine: snapshotLine, compareCopy: compareCopy, readiness: readiness, numbersFingerprint: numbersFingerprint,
    ai: { SCHEMA: AI_SCHEMA, SYSTEM: AI_SYSTEM, buildRequest: buildRequest, parseReply: parseReply, objections: objections, failingSections: failingSections },
    cost: { PRICES: PRICES, CEILING: PRICE_CEILING, FALLBACK_MODELS: FALLBACK_MODELS, priceOf: priceOf, estimate: costEstimate, measured: costMeasured, requestKey: costRequestKey, REFUSALS: COST_REFUSALS },
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

// ── what a Claude call costs: the content engine's own $10 hard cap ─────────
// docs/system-integrity/COST.md. Every call is RESERVED in the database before
// it is made (content_engine_ai_reserve: one month lock, so concurrent calls
// cannot pass the cap together) at an UPPER BOUND, and SETTLED after it with
// the cost of the tokens the API reports (content_engine_ai_settle). Other AI
// products' budgets are not touched here.
//
// The prices, the upper-bound estimate, the measured cost and the request
// fingerprint are the core's (CE.cost, lib/content_engine.js), shared with the
// weekly job; exported here for the tests.
export const PRICES = CE.cost.PRICES;
export const CEILING = CE.cost.CEILING;
export const priceOf = (model: string) => CE.cost.priceOf(model);
export const estimateUsd = (req: any, model: string): number => CE.cost.estimate(req, model);
export const usageCost = (message: any, model: string) => CE.cost.measured(message, model);
export const requestKey = (model: string, articleId: string, contentHash: string, section: string | null, req: any): Promise<string> =>
  CE.cost.requestKey(model, { article: articleId, content_hash: contentHash, section }, req);
async function settle(x: Ctx, key: string, ok: boolean, cost: any, error: string | null) {
  try {
    return await db(x, 'content_engine_ai_settle', { p_request_key: key, p_ok: ok, p_input_tokens: cost ? cost.input_tokens : null, p_output_tokens: cost ? cost.output_tokens : null,
      p_actual_usd: cost ? cost.usd : null, p_error: error ? String(error).slice(0, 300) : null,
      p_cache_read_tokens: cost ? cost.cache_read_tokens : null, p_cache_write_tokens: cost ? cost.cache_write_tokens : null });
  } catch (_) { return null; /* unsettled: the database charges it at its estimate after 30 minutes */ }
}

// ── one Claude call ─────────────────────────────────────────────────────────
// maxRetries 0: an SDK retry would be a second billed attempt the reservation
// never saw. A retry is a new reservation (content_engine_ai_reserve counts
// attempts against the owner's limit).
async function claude(x: Ctx, req: any): Promise<any> {
  const client = new Anthropic({ apiKey: x.c.anthropicKey, timeout: 120_000, maxRetries: 0 });
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
  let spentUsd = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const req = CE.ai.buildRequest(opp, { publisher, format: row.format, section, current: base, objections });
    /* the money first: reserve the most this call can cost, or make no call */
    const key = await requestKey(x.c.model, articleId, row.content_hash, section, req);
    const rsv = await db(x, 'content_engine_ai_reserve', { p_request_key: key, p_estimated_usd: estimateUsd(req, x.c.model),
      p_purpose: section ? 'section' : 'rewrite', p_article: articleId, p_model: x.c.model, p_run: null });
    if (!rsv || rsv.ok !== true) {
      const why = rsv && rsv.reason || 'not_reserved';
      await log(x, 'ai_not_reserved', { reason: why, attempt, cap_usd: rsv && rsv.cap_usd }, articleId, opp.id);
      if (attempt > 0) return { ok: false, reason: lastReason || 'validation_failed', objections, llm_calls: x.llmCalls, spent_usd: spentUsd,
        detail: 'the AI draft did not pass the checks and the second try was not made (' + why + '); nothing was saved and the existing draft stands' };
      return { ok: false, reason: why, detail: CE.cost.REFUSALS[why] || (rsv && rsv.detail) || 'the AI budget door refused the call', cap_usd: rsv && rsv.cap_usd };
    }
    if (!(await spend(x, 'llm'))) {
      await settle(x, key, false, null, 'daily call limit reached before the call');
      await log(x, 'ai_discarded', { reason: 'budget_exhausted', attempt }, articleId, opp.id);
      return { ok: false, reason: 'budget_exhausted', detail: 'today’s AI budget is used up; the existing draft stands' };
    }
    let reply: any;
    try { reply = await claude(x, req); } catch (e: any) {
      lastReason = 'api_error: ' + String(e && (e.status || e.message) || e).slice(0, 120);
      /* an error the API answered with is not billed: release it. No answer at
         all (a timeout, a dropped connection) may have been billed: charge the
         reservation's upper bound rather than guess low. */
      const answered = typeof (e && e.status) === 'number';
      await settle(x, key, !answered, null, lastReason + (answered ? '' : ' (no answer: charged at the estimate)'));
      await log(x, 'generation_failed', { reason: lastReason, attempt }, articleId, opp.id);
      break;
    }
    /* whatever happens to the draft next, the tokens were used: settle them */
    const cost = usageCost(reply, x.c.model);
    const st = await settle(x, key, true, cost, null);
    spentUsd += st && typeof st.actual_usd === 'number' ? st.actual_usd : 0;
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
    await log(x, 'ai_accepted', { attempt, generator, section, spent_usd: spentUsd }, articleId, opp.id);
    return { ok: true, revision: saved.revision, status: saved.status, content_hash: saved.content_hash, checks: report, generator, llm_calls: x.llmCalls, spent_usd: spentUsd };
  }
  return { ok: false, reason: lastReason || 'validation_failed', objections, detail: 'the AI draft did not pass the checks; nothing was saved and the existing draft stands', llm_calls: x.llmCalls, spent_usd: spentUsd };
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
