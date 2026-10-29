/* ===========================================================================
   EdgeDesk CFB — SP+ as an EXTERNAL estimate (browser + node, ES5, pure).
   football/sp_plus/README.md

   SP+ is ESPN's opponent-adjusted efficiency rating, created by Bill
   Connelly. EdgeDesk shows a line derived from it beside its own fair spread.
   It is a second opinion, never an input: nothing here is read by EdgeDesk's
   model, EV, rankings or grades.

   PROVENANCE
     SP+ rating            T3 Research Model, external (not EdgeDesk's, not
                           validated by EdgeDesk)
     SP+ projected line    T2 Computed: the deterministic transform below

   THE PROJECTION (cfb_sp_projection_v1)
     home margin = home SP+ − away SP+ + home field     (0 at a neutral site)
     The home field is the one EdgeDesk's CFB engine applies
     (football/cfb_p4/home_field.js through the engine; the build records the
     value and its source). Stored at 0.01, shown at 0.1. A margin is home
     minus away (+ = home favoured); a home line is the book's sign
     (− = home favoured).

   Never combined with EdgeDesk's number: the two sit side by side, and a
   difference of DISAGREE_PTS or more is said in plain words.

   THE DISPLAY RULE (rowFor): a line is shown only from a capture of the
   game's own week, no older than MAX_AGE_DAYS. Anything else — the file did
   not load, no sync yet, the sync failed, the capture is stale, the game is
   from another week, a team SP+ does not rate — is UNAVAILABLE with its
   reason. A stale number is never shown.

   THE FILE: football/sp_plus/lines.json (football/sp_plus/sync.js), derived
   lines only. fetchLines() reads it once per page; load() takes it directly.
   =========================================================================== */
(function (root) {
  'use strict';
  var V = {
    VERSION: 'edgedesk_cfb_sp_plus/1',
    RULE: 'cfb_sp_projection_v1',
    FORM: 'home SP+ − away SP+ + home field (0 at a neutral site)',
    DISAGREE_PTS: 3,
    LABEL: 'SP+ projection',
    ATTRIBUTION: 'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.',
    TIER: { rating: 'T3', line: 'T2', text: 'T3 external model · T2 computed line', external: true, edgedesk_model: false }
  };

  V.SCHEMA = 'edgedesk_cfb_sp_plus_lines_v1';
  V.URL = '/football/sp_plus/lines.json';
  V.MAX_AGE_DAYS = 8;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  /* to 0.01, and never a negative zero */
  function r2(x) { var v = Math.round(x * 100) / 100; return v === 0 ? 0 : v; }

  /*__TRANSFORM_START__*/
  /* the T2 transform: pure and deterministic, no clock, no randomness */
  V.projectHomeMargin = function (homeSp, awaySp, neutral, hfa) {
    if (!isNum(homeSp) || !isNum(awaySp)) return null;
    if (!neutral && !isNum(hfa)) return null;
    return r2(homeSp - awaySp + (neutral ? 0 : hfa));
  };
  V.homeLine = function (margin) { return isNum(margin) ? r2(-margin) : null; };

  /* "Middle Tennessee −1.3": the line named for its own favourite, at 0.1 */
  V.lineText = function (home, away, margin) {
    if (!isNum(margin)) return null;
    var m = Math.round(margin * 10) / 10;
    if (m === 0) return 'Pick’em';
    return (m > 0 ? home : away) + ' −' + Math.abs(m).toFixed(1);
  };

  /* EdgeDesk's home margin against SP+'s: the size of the gap, and whether it
     reaches the plain-words threshold. Never an average of the two. */
  V.disagreement = function (edgedeskMargin, spMargin) {
    if (!isNum(edgedeskMargin) || !isNum(spMargin)) return null;
    var pts = r2(Math.abs(edgedeskMargin - spMargin));
    return { points: pts, disagree: pts >= V.DISAGREE_PTS };
  };
  /*__TRANSFORM_END__*/

  /* ---------------------------------------------------------- the file */
  var DOC = null, LOADS = {};
  V.load = function (doc) { DOC = doc && typeof doc === 'object' ? doc : null; return DOC; };
  V.doc = function () { return DOC; };
  /* one read per URL per page; a failed read leaves no document (every row
     then says the file did not load) and may be tried again */
  V.fetchLines = function (url, fetchFn) {
    url = url || V.URL;
    if (LOADS[url]) return LOADS[url];
    var f = fetchFn || root.fetch;
    if (typeof f !== 'function') return Promise.reject(new Error('no fetch'));
    LOADS[url] = f(url, { cache: 'no-cache' }).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
      return r.json();
    }).then(function (j) { V.load(j); return j; }, function (e) { delete LOADS[url]; V.load(null); throw e; });
    return LOADS[url];
  };

  /* "2026:0:09" -> "week 9"; "2026:1:01" -> "postseason week 1" */
  V.weekText = function (key) {
    var m = /^(\d{4}):([01]):(\d{2})$/.exec(String(key || ''));
    if (!m) return 'an unknown week';
    return (m[2] === '1' ? 'postseason ' : '') + 'week ' + Number(m[3]);
  };

  function unavailable(reason) {
    return { state: 'UNAVAILABLE', label: V.LABEL, reason: reason, text: null, home_margin: null, home_line: null,
      tier_text: V.TIER.text, attribution: null, disagreement: null, disagree: false, disagree_text: null };
  }

  /* gameId: the ESPN game id the slate keys games by.
     o: { now (ms or ISO; default the page's clock), home, away (names to print),
          edgedesk_home_margin (EdgeDesk's home margin, + = home favoured),
          doc (a document to read instead of the loaded one) } */
  V.rowFor = function (gameId, o) {
    o = o || {};
    var D = o.doc !== undefined ? o.doc : DOC;
    if (!D) return unavailable('the SP+ file did not load');
    if (D.schema !== V.SCHEMA) return unavailable('the SP+ file is not one this page reads');
    var la = D.last_attempt || null, S = D.snapshot || null;
    if (!S) return unavailable(la && la.status === 'FAILED' ? 'the SP+ sync failed: ' + la.reason
      : (la && la.status === 'UNCHANGED' ? la.reason : 'SP+ has not been synced yet'));
    var now = o.now == null ? Date.now() : (typeof o.now === 'number' ? o.now : Date.parse(o.now));
    var cap = Date.parse(S.captured_at);
    if (!isFinite(cap)) return unavailable('the SP+ capture has no time');
    if (!isFinite(now) || now - cap > V.MAX_AGE_DAYS * 864e5) {
      return unavailable('stale: the last SP+ capture is ' + V.weekText(S.week_key) + ' (' + String(S.captured_at).slice(0, 10) + '), older than the current week');
    }
    var g = D.games && D.games[String(gameId)];
    if (!g) {
      if (la && la.status !== 'OK' && la.week_key && la.week_key !== S.week_key) {
        return unavailable('no SP+ line for this game: the sync for ' + V.weekText(la.week_key)
          + (la.status === 'FAILED' ? ' failed (' + la.reason + ')' : ' found SP+ not yet updated'));
      }
      return unavailable('no SP+ line for this game: lines are published for ' + V.weekText(S.week_key) + ', the captured week, only');
    }
    if (g.week_key !== S.week_key) return unavailable('stale: this line is from ' + V.weekText(g.week_key) + ', not the captured week');
    if (g.state !== 'AVAILABLE' || !isNum(g.home_margin)) return unavailable(g.reason || 'no SP+ line for this game');
    var home = o.home || g.home, away = o.away || g.away;
    var dis = V.disagreement(o.edgedesk_home_margin, g.home_margin);
    return { state: 'AVAILABLE', label: V.LABEL, reason: null, text: V.lineText(home, away, g.home_margin),
      home_margin: g.home_margin, home_line: g.home_line, week_key: g.week_key,
      captured_at: S.captured_at, source_version: S.source_version || null,
      source_text: 'SP+ ' + V.weekText(S.week_key) + ' · captured ' + String(S.captured_at).slice(0, 10),
      tier_text: V.TIER.text, attribution: V.ATTRIBUTION,
      disagreement: dis, disagree: !!(dis && dis.disagree),
      disagree_text: dis && dis.disagree ? 'EdgeDesk and SP+ are ' + dis.points.toFixed(1) + ' points apart. The two numbers are never combined.' : null };
  };

  root.EDCfbSpPlus = V;
  if (typeof module !== 'undefined' && module.exports) module.exports = V;
})(typeof window !== 'undefined' ? window : globalThis);
