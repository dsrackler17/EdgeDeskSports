/* ===========================================================================
   EdgeDesk Tennis — the MODEL engine, shared by the pipeline, the AI and the
   page.

   ONE implementation of every number the tennis research surface shows, loaded
   by tools/tennis/*.js under Node (where it is tested), by the edgedesk_ai
   function (where it is quoted) and by app.html in the browser (where it is
   displayed). If the three disagreed, a fair price would differ between the
   board and the match page, and a research grade would pass in a test and fail
   on a phone. So there is one file.

   IT IS THE SECOND HALF OF lib/tennis_research.js, NOT A REPLACEMENT FOR IT.
   That file owns identity, market linkage, first-point tagging, freshness and
   the live serve baselines. This one owns the historical record: how an
   archive row becomes a match, what was knowable before it, what a rating
   means, what a fair price is, and when EdgeDesk should decline to show any of
   it. Neither imports the other; the name-folding rule is duplicated
   deliberately and tools/tennis/model.test.js fails if the two ever disagree
   on a single name.

   WHAT LIVES HERE, and the rule each part obeys:

     keys        deterministic ids. A match's identity is the draw slot it was
                 played in, never its result — correct a winner upstream and
                 the same row is updated, not duplicated.
     parse       an archive row -> normalised entities. An empty cell is NULL,
                 never 0. "Did not happen" and "not recorded" are different
                 facts and this file never conflates them.
     features    the point-in-time vector. Every input is something that was
                 true BEFORE the match. Nothing derived from the row's own
                 serve statistics is ever in it — those are the result.
     model       a logistic model over feature DIFFERENCES, with the
                 coefficients passed in rather than baked in, so a model
                 version is data and can be rolled back without a deploy.
     price       probability -> fair decimal and American odds, de-vigged
                 market probability, edge, EV. No stake, no recommendation.
     rating      the 0-100 power rating, shrunk toward the tour median in
                 proportion to how little is known, with its uncertainty.
     grade       the research gate. What EdgeDesk refuses to publish, and why.
     metrics     log loss, Brier, calibration curve, accuracy, and the bucket
                 breakdowns the public record is built from.
     fit         a small L2-regularised logistic fitter, so a model version can
                 be trained on a bare Node install with no dependencies.

   RESEARCH, NOT PICKS. Nothing here produces a selection, a stake or a verb.
   It produces a probability, the price that probability implies, the market's
   own number beside it, and the reasons the gap might not be real.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDTennisModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION         = 'tennis-model-1.0';
  var FEATURE_VERSION = 'tennis-features-1.0.0';
  var RATING_VERSION  = 'tennis-rating-1.0.0';
  var SCHEMA_VERSION  = 'tennis-archive-108';

  /* ───────────────────────────── small helpers ─────────────────────────── */

  /* THE NULL RULE. An empty cell, a whitespace cell, 'NA', 'nan' and 'None'
     are all ABSENT. They are not zero. A zero here would say "this player has
     played zero matches in the last fortnight", which is a measurement; absent
     says EdgeDesk does not know. Every downstream consumer can tell them
     apart because this function refuses to blur them. */
  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    if (!s) return null;
    if (/^(na|n\/a|nan|none|null|-)$/i.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function str(v) {
    if (v == null) return null;
    var s = String(v).trim();
    if (!s) return null;
    if (/^(na|n\/a|nan|none|null)$/i.test(s)) return null;
    return s;
  }
  function bool(v) {
    if (v == null) return null;
    if (typeof v === 'boolean') return v;
    var s = String(v).trim().toLowerCase();
    if (!s) return null;
    if (/^(t|true|1|y|yes)$/.test(s)) return true;
    if (/^(f|false|0|n|no)$/.test(s)) return false;
    return null;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function round(x, p) {
    if (x == null || !isFinite(x)) return null;
    var f = Math.pow(10, p == null ? 4 : p);
    return Math.round(x * f) / f;
  }
  function mean(a) {
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { s += a[i]; n++; }
    return n ? s / n : null;
  }
  function stdev(a) {
    var m = mean(a);
    if (m == null) return null;
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : null;
  }

  /* Name folding. Byte-for-byte the rule lib/tennis_research.js uses, so a
     name resolves identically whichever engine asks. Duplicated rather than
     imported because the two files load independently in three hosts;
     tools/tennis/model.test.js proves they never drift. */
  function normName(n) {
    var s = String(n == null ? '' : n);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    s = s.replace(/["“”][^"“”]*["“”]/g, ' ')
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, ' ')
         .trim().replace(/\s+/g, ' ');
    return s;
  }
  function slug(s) {
    return normName(s).replace(/\s+/g, '-');
  }

  /* ───────────────────────────── deterministic keys ────────────────────── */

  /* A MATCH'S IDENTITY IS ITS DRAW SLOT, NOT ITS RESULT.

     The archive's own match_uid is TOUR_tourney_matchnum_winnerid_loserid.
     Correct a mis-recorded winner upstream and that string changes, so keying
     on it would store the correction as a SECOND match and the record would
     carry both. Tour, tournament and match number identify the slot and do not
     move, so a re-import of a corrected row UPDATES the match it corrects. */
  /* A MATCH'S IDENTITY IS ITS DRAW SLOT AND WHO PLAYED IN IT.
     Never its result — the archive's own match_uid encodes the winner, so
     keying on that would store a CORRECTED result as a second match instead of
     updating the one it corrects.

     The player pair is UNORDERED, which is what preserves that property: swap
     winner and loser (exactly what a correction does) and the key is unchanged.
     Two genuinely different matches, however, get different keys.

     WHY THE PAIR IS IN THE KEY AT ALL. The slot alone —
     (source, tour, tournament, match number) — is not unique in the real
     archive. Five WTA events restart match_num within what the source calls one
     tourney_id (combined draws and satellite series such as
     1973-W-SL-USA-01A-1973), producing 16 slots that each hold two DIFFERENT
     matches. With the slot as the whole key the second silently overwrote the
     first and sixteen real matches vanished — while every total still
     reconciled, because they were read and accepted; they just never became
     rows. That is the exact failure the multi-part verifier exists to prevent,
     one layer further down, and it was found by importing the real archive.

     The pair is optional so a caller that only has a slot still gets a stable
     key; the importer always supplies it. */
  function matchKey(tour, tourneyId, matchNum, sourceKey, playerA, playerB) {
    var src = sourceKey || 'archive';
    var base = src + ':' + String(tour).toUpperCase() + ':' + String(tourneyId) + ':' + String(matchNum);
    var a = str(playerA), b = str(playerB);
    if (a == null || b == null) return base;
    return base + ':' + (a < b ? a + '-' + b : b + '-' + a);
  }
  function playerKey(tour, sourcePlayerId, sourceKey) {
    var src = sourceKey || 'archive';
    return src + ':' + String(tour).toUpperCase() + ':' + String(sourcePlayerId);
  }
  function tournamentKey(tour, tourneyId, sourceKey) {
    var src = sourceKey || 'archive';
    return src + ':' + String(tour).toUpperCase() + ':' + String(tourneyId);
  }
  function venueKey(tourneyName, sourceKey) {
    var src = sourceKey || 'archive';
    return src + ':' + slug(tourneyName);
  }

  /* ───────────────────────────── vocabulary ────────────────────────────── */

  var SURFACES = ['hard', 'clay', 'grass', 'carpet'];
  function normSurface(s) {
    var k = String(s == null ? '' : s).toLowerCase().trim();
    if (!k) return null;
    if (/hard/.test(k)) return 'hard';
    if (/clay/.test(k)) return 'clay';
    if (/grass/.test(k)) return 'grass';
    if (/carpet/.test(k)) return 'carpet';
    return null;
  }
  /* Surface is shown only where the source publishes it and is NEVER inferred
     from the tournament name. An unknown surface stays unknown, because a
     wrong surface is worse than no surface on a screen whose entire premise is
     that surface changes the matchup. */
  function surfaceOrUnknown(s) { return normSurface(s) || 'unknown'; }

  /* The archive's environment column is 'Indoor' / 'Outdoor/unknown' / blank.
     'Outdoor/unknown' is exactly what it says — it is not a claim that the
     event was outdoors, so it maps to unknown rather than outdoor, and weather
     never attaches to it. */
  function normEnvironment(s) {
    var k = String(s == null ? '' : s).toLowerCase().trim();
    if (!k) return 'unknown';
    if (/^indoor/.test(k)) return 'indoor';
    if (/^outdoor$/.test(k)) return 'outdoor';
    return 'unknown';
  }

  /* Tournament level, as the archive codes it. */
  var LEVELS = {
    G: { label: 'Grand Slam',      weight: 1.00 },
    M: { label: 'Masters 1000',    weight: 0.90 },
    P: { label: 'Premier / WTA 1000', weight: 0.88 },
    PM: { label: 'Premier Mandatory', weight: 0.92 },
    A: { label: 'Tour',            weight: 0.75 },
    I: { label: 'International',   weight: 0.70 },
    F: { label: 'Tour Finals',     weight: 0.95 },
    D: { label: 'Davis / Billie Jean King Cup', weight: 0.65 },
    C: { label: 'Challenger',      weight: 0.45 },
    S: { label: 'Satellite / ITF', weight: 0.30 },
    Q: { label: 'Qualifying',      weight: 0.40 },
    O: { label: 'Olympics',        weight: 0.85 },
    T: { label: 'Team event',      weight: 0.60 }
  };
  function levelWeight(code) {
    var k = String(code == null ? '' : code).toUpperCase().trim();
    return LEVELS[k] ? LEVELS[k].weight : 0.6;
  }
  function levelLabel(code) {
    var k = String(code == null ? '' : code).toUpperCase().trim();
    return LEVELS[k] ? LEVELS[k].label : (k || 'Unknown');
  }

  /* Round ordering, so a draw sorts the way it is played. */
  var ROUND_ORDER = {
    'RR': 5, 'BR': 6, 'Q1': 1, 'Q2': 2, 'Q3': 3, 'Q4': 4,
    'R128': 10, 'R64': 20, 'R32': 30, 'R16': 40, 'QF': 50, 'SF': 60, 'F': 70
  };
  function roundOrder(r) {
    var k = String(r == null ? '' : r).toUpperCase().trim();
    return ROUND_ORDER[k] != null ? ROUND_ORDER[k] : null;
  }

  var TOURS = { ATP: 1, WTA: 1, MIXED: 1, OTHER: 1 };
  function normTour(t) {
    var k = String(t == null ? '' : t).toUpperCase().trim();
    return TOURS[k] ? k : 'OTHER';
  }

  /* ───────────────────────────── score parsing ─────────────────────────── */

  /* What the score string tells us, and nothing more. A retirement, a walkover
     and a defaulted match are three different things and the record keeps them
     apart: a retirement HAPPENED and its games count, a walkover means no ball
     was struck. A model that treats a walkover as a straight-sets win is
     learning from a match that was never played. */
  function parseScore(score) {
    var out = { sets: [], sets_played: 0, retirement: false, walkover: false,
                defaulted: false, unfinished: false, parsed: false };
    var s = str(score);
    if (!s) return out;
    var low = s.toLowerCase();
    out.retirement = /\bret\b|\bretired\b/.test(low);
    out.walkover   = /\bw\/?o\b|\bwalkover\b/.test(low);
    out.defaulted  = /\bdef\b|\bdefault\b/.test(low);
    out.unfinished = /\bunfinished\b|\babandoned\b|\bin progress\b/.test(low);
    var cleaned = s.replace(/\(([^)]*)\)/g, ' ')
                   .replace(/\b(ret|retired|w\/?o|walkover|def|default|unfinished|abandoned)\b/gi, ' ');
    var parts = cleaned.split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var m = /^(\d{1,2})[-–](\d{1,2})$/.exec(parts[i]);
      if (!m) continue;
      out.sets.push([Number(m[1]), Number(m[2])]);
    }
    out.sets_played = out.sets.length;
    out.parsed = out.sets_played > 0 || out.walkover;
    return out;
  }

  /* ───────────────────────────── archive row -> entities ───────────────── */

  /* The 108-column contract, as columns this file actually reads. A source
     that stops publishing one of these is a change worth failing on rather
     than a column that quietly becomes null, so the importer checks the header
     against this list before it reads a single row. */
  var REQUIRED_COLUMNS = [
    'tourney_id', 'tourney_name', 'surface', 'tourney_date', 'match_num',
    'winner_id', 'winner_name', 'loser_id', 'loser_name', 'score', 'round',
    'tour', 'best_of', 'match_uid'
  ];
  var FEATURE_COLUMNS = [
    'winner_elo_pre', 'winner_surface_elo_pre', 'winner_win_pct_30d_pre',
    'winner_win_pct_90d_pre', 'winner_win_pct_365d_pre', 'winner_matches_7d_pre',
    'winner_matches_14d_pre', 'winner_rest_days_pre', 'winner_career_surface_win_pct_pre',
    'winner_career_surface_matches_pre',
    'loser_elo_pre', 'loser_surface_elo_pre', 'loser_win_pct_30d_pre',
    'loser_win_pct_90d_pre', 'loser_win_pct_365d_pre', 'loser_matches_7d_pre',
    'loser_matches_14d_pre', 'loser_rest_days_pre', 'loser_career_surface_win_pct_pre',
    'loser_career_surface_matches_pre'
  ];
  /* POST-MATCH. Stored as the record; NEVER an input. Named here so the
     leakage suite can assert, mechanically, that no feature name overlaps. */
  var POST_MATCH_COLUMNS = [
    'minutes', 'w_ace', 'w_df', 'w_svpt', 'w_1stIn', 'w_1stWon', 'w_2ndWon',
    'w_SvGms', 'w_bpSaved', 'w_bpFaced', 'l_ace', 'l_df', 'l_svpt', 'l_1stIn',
    'l_1stWon', 'l_2ndWon', 'l_SvGms', 'l_bpSaved', 'l_bpFaced',
    'winner_ace_rate', 'winner_double_fault_rate', 'winner_first_serve_in_pct',
    'winner_first_serve_won_pct', 'winner_second_serve_won_pct', 'winner_break_points_saved_pct',
    'loser_ace_rate', 'loser_double_fault_rate', 'loser_first_serve_in_pct',
    'loser_first_serve_won_pct', 'loser_second_serve_won_pct', 'loser_break_points_saved_pct',
    'score', 'sets_played'
  ];

  /* The archive dates a match to its tournament week. Accepts YYYY-MM-DD,
     YYYYMMDD and an ISO timestamp, because three of them appear across the
     source's own files and its JSON fixtures. */
  function parseDate(v) {
    var s = str(v);
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    var t = Date.parse(s);
    if (!isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  function seasonOf(dateStr, fallbackYear) {
    var d = parseDate(dateStr);
    if (d) return Number(d.slice(0, 4));
    var y = int(fallbackYear);
    return y == null ? null : y;
  }

  /* A HEIGHT THAT CANNOT BE A PERSON IS NOT A HEIGHT.

     The archive carries values like 71 and 2 in `winner_ht` — transcription
     noise, not centimetres. Storing one would put a 71cm professional in the
     record and would break the database's own plausibility constraint on the
     next import. Storing ZERO would be worse: it would read as a measurement.
     So an implausible height becomes ABSENT and the row records an
     impossible_statistic issue beside it. The same rule applies to an age and
     to a ranking, for the same reason. */
  var HEIGHT_MIN = 120, HEIGHT_MAX = 250;
  var AGE_MIN = 10, AGE_MAX = 65;
  /* A PLACEHOLDER IS NOT A PLAYER.
     The archive uses sentinel names for competitors it could not identify, and
     the worst of them is a single id ("U Unknown", ATP 199999) carrying 87
     matches by 87 different people. It is not one person, so its rating is not
     a rating — and the daily brief duly published "U Unknown up 7.4 rating
     points" as a research finding about a human being who does not exist.

     The match rows stay: they happened, and the OPPONENTS' records are real and
     must keep them. What changes is that the placeholder never appears AS a
     player — not in a leaderboard, a search, a brief or an AI answer.

     "Unknown <Surname>" is deliberately NOT caught. Those are real people whose
     given name the archive does not know; suppressing them would delete genuine
     records to tidy up a display. The test only fires on a name that is a
     placeholder in whole. */
  var PLACEHOLDER_NAMES = ['unknown', 'u unknown', 'unknown unknown', 'bye', 'qualifier',
    'unnamed', 'n a', 'na', 'tbd', 'walkover'];
  function isPlaceholderPlayer(name) {
    var n = normName(name);
    if (!n) return true;                    // no name at all is not a player either
    return PLACEHOLDER_NAMES.indexOf(n) >= 0;
  }

  function plausibleHeight(v) {
    var n = int(v);
    return (n != null && n >= HEIGHT_MIN && n <= HEIGHT_MAX) ? n : null;
  }
  function plausibleAge(v) {
    var n = num(v);
    return (n != null && n >= AGE_MIN && n <= AGE_MAX) ? round(n, 2) : null;
  }
  function plausibleRank(v) {
    var n = int(v);
    return (n != null && n > 0 && n <= 5000) ? n : null;
  }

  /* Is this row usable at all? A rejection is a FACT about the source, so it
     carries a reason code the importer stores rather than a boolean. */
  function validateRow(r) {
    var issues = [];
    var tour = normTour(r.tour);
    if (tour === 'OTHER') issues.push({ type: 'malformed_record', field: 'tour', detail: 'tour is not ATP or WTA', fatal: true });
    if (!str(r.tourney_id))  issues.push({ type: 'malformed_record', field: 'tourney_id', detail: 'no tournament id', fatal: true });
    if (int(r.match_num) == null) issues.push({ type: 'malformed_record', field: 'match_num', detail: 'no match number', fatal: true });
    if (!str(r.winner_id))   issues.push({ type: 'malformed_record', field: 'winner_id', detail: 'no winner id', fatal: true });
    if (!str(r.loser_id))    issues.push({ type: 'malformed_record', field: 'loser_id', detail: 'no loser id', fatal: true });
    if (str(r.winner_id) && str(r.winner_id) === str(r.loser_id))
      issues.push({ type: 'duplicate_identifier', field: 'winner_id', detail: 'winner and loser are the same player', fatal: true });
    var d = parseDate(r.tourney_date);
    if (!d) issues.push({ type: 'malformed_record', field: 'tourney_date', detail: 'unparseable tournament date', fatal: true });
    else {
      var y = Number(d.slice(0, 4));
      if (y < 1960 || y > 2100)
        issues.push({ type: 'out_of_range', field: 'tourney_date', observed: d, detail: 'date outside 1960-2100', fatal: true });
    }
    /* Non-fatal: the row is stored, the problem is recorded beside it. */
    if (!normSurface(r.surface))
      issues.push({ type: 'missing_surface', field: 'surface', observed: str(r.surface), detail: 'surface not published; stored as unknown and never inferred' });
    var mins = int(r.minutes);
    if (mins != null && (mins < 1 || mins > 900))
      issues.push({ type: 'impossible_statistic', field: 'minutes', observed: String(mins), expected: '1..900', detail: 'match duration outside any plausible range' });
    var bo = int(r.best_of);
    if (bo != null && bo !== 3 && bo !== 5)
      issues.push({ type: 'impossible_statistic', field: 'best_of', observed: String(bo), expected: '3 or 5', detail: 'best-of is neither 3 nor 5' });
    ['winner', 'loser'].forEach(function (who) {
      var h = int(r[who + '_ht']);
      if (h != null && plausibleHeight(h) == null)
        issues.push({ type: 'impossible_statistic', field: who + '_ht', observed: String(h),
                      expected: HEIGHT_MIN + '..' + HEIGHT_MAX + ' cm',
                      detail: 'height is not a plausible human height; stored as absent, never as zero' });
      var ag = num(r[who + '_age']);
      if (ag != null && plausibleAge(ag) == null)
        issues.push({ type: 'impossible_statistic', field: who + '_age', observed: String(ag),
                      expected: AGE_MIN + '..' + AGE_MAX,
                      detail: 'age outside any plausible range; stored as absent' });
      var rk = int(r[who + '_rank']);
      if (rk != null && plausibleRank(rk) == null)
        issues.push({ type: 'impossible_statistic', field: who + '_rank', observed: String(rk),
                      expected: '1..5000', detail: 'ranking outside any plausible range; stored as absent' });
    });
    ['w', 'l'].forEach(function (side) {
      var svpt = int(r[side + '_svpt']), firstIn = int(r[side + '_1stIn']);
      if (svpt != null && firstIn != null && firstIn > svpt)
        issues.push({ type: 'impossible_statistic', field: side + '_1stIn', observed: String(firstIn), expected: '<= ' + svpt,
                      detail: 'more first serves in than service points played' });
      var bpS = int(r[side + '_bpSaved']), bpF = int(r[side + '_bpFaced']);
      if (bpS != null && bpF != null && bpS > bpF)
        issues.push({ type: 'impossible_statistic', field: side + '_bpSaved', observed: String(bpS), expected: '<= ' + bpF,
                      detail: 'more break points saved than faced' });
    });
    var fatal = issues.filter(function (i) { return i.fatal; });
    return { ok: fatal.length === 0, issues: issues,
             reject_reason: fatal.length ? fatal.map(function (i) { return i.field + ': ' + i.detail; }).join('; ') : null };
  }

  /* One archive row -> the entities it implies. Pure: no clock, no io. */
  function parseArchiveRow(r, opts) {
    opts = opts || {};
    var sourceKey = opts.source_key || 'archive';
    var tour = normTour(r.tour);
    var tourneyId = str(r.tourney_id);
    var matchNum = int(r.match_num);
    var date = parseDate(r.tourney_date);
    var endDate = parseDate(r.event_end_date);
    var season = seasonOf(r.tourney_date, r.source_year);
    var surface = surfaceOrUnknown(r.surface);
    var environment = normEnvironment(r.environment);
    var sc = parseScore(r.score);
    var tname = str(r.tourney_name);

    var mId = matchKey(tour, tourneyId, matchNum, sourceKey, str(r.winner_id), str(r.loser_id));
    var tId = tournamentKey(tour, tourneyId, sourceKey);
    var vId = tname ? venueKey(tname, sourceKey) : null;
    var wId = playerKey(tour, str(r.winner_id), sourceKey);
    var lId = playerKey(tour, str(r.loser_id), sourceKey);

    function player(prefix, sid) {
      var name = str(r[prefix + '_name']);
      return {
        player_id: playerKey(tour, sid, sourceKey),
        tour: tour,
        source_key: sourceKey,
        source_player_id: sid,
        full_name: name,
        name_norm: normName(name),
        country: str(r[prefix + '_ioc']),
        plays: (function (h) { var k = str(h); return k && /^[RLAU]$/i.test(k) ? k.toUpperCase() : null; })(r[prefix + '_hand']),
        height_cm: plausibleHeight(r[prefix + '_ht']),
        latest_age: plausibleAge(r[prefix + '_age']),
        latest_age_on: date,
        last_match: date
      };
    }

    var venue = null;
    if (vId) {
      venue = {
        venue_id: vId,
        source_key: sourceKey,
        venue_name: str(r.venue_name),
        tourney_name: tname,
        country: str(r.venue_country),
        latitude: num(r.latitude),
        longitude: num(r.longitude),
        timezone: str(r.timezone),
        environment: environment,
        resolution_method: str(r.geocode_confidence) ? 'name_inferred' : null,
        resolution_confidence: (function (c) {
          var k = String(c == null ? '' : c).toLowerCase().trim();
          if (!k) return 'unknown';
          if (/exact/.test(k)) return 'exact';
          if (/high/.test(k)) return 'high';
          if (/name_inferred|inferred/.test(k)) return 'name_inferred';
          if (/low/.test(k)) return 'low';
          return 'unknown';
        })(r.geocode_confidence),
        weather_query: str(r.weather_query)
      };
    }

    /* WEATHER. Only where the source actually carried it, only where the venue
       resolved, and always labelled with its temporal precision. An indoor
       event gets a row that SAYS indoor rather than a null that looks like a
       gap somebody could later fill in by mistake. */
    var weather = null;
    var wPrec = str(r.weather_precision);
    var anyWeather = ['weather_temp_mean_f', 'weather_temp_max_f', 'weather_temp_min_f',
                      'weather_humidity_mean_pct', 'weather_precip_week_in', 'weather_wind_mean_mph',
                      'weather_gust_max_mph', 'weather_solar_week_mj_m2']
      .some(function (k) { return num(r[k]) != null; });
    if (environment === 'indoor') {
      weather = { venue_id: vId, tournament_id: tId, source_key: str(r.weather_source) ? 'open-meteo' : 'open-meteo',
                  observed_on: date, window_start: date, window_end: endDate,
                  temporal_precision: 'indoor', quality: 'unusable',
                  venue_confidence: venue ? venue.resolution_confidence : 'unknown',
                  indoor_note: 'indoor event: weather is not a factor and none is stored' };
    } else if (anyWeather) {
      weather = {
        venue_id: vId, tournament_id: tId, source_key: 'open-meteo',
        observed_on: date, window_start: date, window_end: endDate,
        temporal_precision: wPrec && /hour/i.test(wPrec) ? 'hourly'
                          : wPrec && /day/i.test(wPrec) ? 'daily' : 'tournament_week',
        temp_mean_f: num(r.weather_temp_mean_f), temp_max_f: num(r.weather_temp_max_f),
        temp_min_f: num(r.weather_temp_min_f), humidity_mean_pct: num(r.weather_humidity_mean_pct),
        precip_in: num(r.weather_precip_week_in), wind_mean_mph: num(r.weather_wind_mean_mph),
        gust_max_mph: num(r.weather_gust_max_mph), solar_mj_m2: num(r.weather_solar_week_mj_m2),
        days_covered: int(r.weather_days_covered),
        venue_confidence: venue ? venue.resolution_confidence : 'unknown',
        quality: (function () {
          var days = int(r.weather_days_covered);
          var conf = venue ? venue.resolution_confidence : 'unknown';
          if (conf === 'unknown' || conf === 'low') return 'low';
          if (days != null && days >= 5) return 'usable';
          if (days != null && days >= 3) return 'low';
          return 'unknown';
        })()
      };
    }

    var match = {
      match_id: mId,
      source_key: sourceKey,
      tour: tour,
      source_tourney_id: tourneyId,
      match_num: matchNum,
      source_match_uid: str(r.match_uid),
      tournament_id: tId,
      tourney_name: tname,
      season: season,
      match_date: date,
      tourney_date: date,
      date_precision: 'tournament_week',
      scheduled_at: null,
      level: str(r.tourney_level),
      round: str(r.round),
      round_order: roundOrder(r.round),
      best_of: (function (b) { return b === 3 || b === 5 ? b : null; })(int(r.best_of)),
      surface: surface,
      surface_group: str(r.surface_group) || (surface === 'unknown' ? null : surface),
      environment: environment,
      draw_size: int(r.draw_size),
      winner_id: wId,
      loser_id: lId,
      winner_seed: int(r.winner_seed),
      loser_seed: int(r.loser_seed),
      winner_entry: str(r.winner_entry),
      loser_entry: str(r.loser_entry),
      score: str(r.score),
      sets_played: sc.sets_played || null,
      retirement: sc.retirement,
      walkover: sc.walkover,
      minutes: (function (m) { return m != null && m >= 1 && m <= 900 ? m : null; })(int(r.minutes)),
      winner_rank: plausibleRank(r.winner_rank), winner_rank_points: int(r.winner_rank_points),
      loser_rank: plausibleRank(r.loser_rank), loser_rank_points: int(r.loser_rank_points),
      winner_age: plausibleAge(r.winner_age), loser_age: plausibleAge(r.loser_age),
      w_ace: int(r.w_ace), w_df: int(r.w_df), w_svpt: int(r.w_svpt),
      w_1st_in: int(r.w_1stIn), w_1st_won: int(r.w_1stWon), w_2nd_won: int(r.w_2ndWon),
      w_sv_gms: int(r.w_SvGms), w_bp_saved: int(r.w_bpSaved), w_bp_faced: int(r.w_bpFaced),
      l_ace: int(r.l_ace), l_df: int(r.l_df), l_svpt: int(r.l_svpt),
      l_1st_in: int(r.l_1stIn), l_1st_won: int(r.l_1stWon), l_2nd_won: int(r.l_2ndWon),
      l_sv_gms: int(r.l_SvGms), l_bp_saved: int(r.l_bpSaved), l_bp_faced: int(r.l_bpFaced),
      stats_available: int(r.w_svpt) != null && int(r.l_svpt) != null,
      venue_id: vId,
      source_version: opts.source_version || null,
      ingestion_version: VERSION
    };

    var tournament = {
      tournament_id: tId,
      provider: sourceKey,
      provider_tournament_id: String(tour).toUpperCase() + ':' + tourneyId,
      tour: tour,
      name: tname,
      level: str(r.tourney_level),
      surface: surface,
      indoor: environment === 'indoor' ? true : (environment === 'outdoor' ? false : null),
      environment: environment,
      surface_group: str(r.surface_group),
      venue: str(r.venue_name),
      country: str(r.venue_country),
      timezone: str(r.timezone),
      start_date: date,
      end_date: endDate,
      draw_size: int(r.draw_size),
      season: season,
      state: 'final',
      venue_id: vId,
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      venue_confidence: venue ? venue.resolution_confidence : null,
      source: sourceKey,
      source_key: sourceKey,
      source_version: opts.source_version || null
    };

    return {
      match: match,
      tournament: tournament,
      venue: venue,
      weather: weather,
      winner: player('winner', str(r.winner_id)),
      loser: player('loser', str(r.loser_id)),
      features: [
        featureRowFromArchive(r, 'winner', match, wId, lId),
        featureRowFromArchive(r, 'loser', match, lId, wId)
      ]
    };
  }

  /* ───────────────────────────── point-in-time features ────────────────── */

  /* THE LEAKAGE BOUNDARY, in one function.

     Everything read here carries the suffix `_pre` in the source, which is the
     archive's own promise that it was computed strictly before this match. The
     row's serve statistics, its score, its duration and its result are NOT
     read, and cannot be: the names are not in this function. The leakage suite
     asserts that mechanically by intersecting POST_MATCH_COLUMNS with the keys
     this returns. */
  function featureRowFromArchive(r, role, match, playerId, opponentId) {
    var p = role === 'winner' ? 'winner' : 'loser';
    var f = {
      match_id: match.match_id,
      player_id: playerId,
      opponent_id: opponentId,
      tour: match.tour,
      match_date: match.match_date,
      surface: match.surface,
      player_role: role,
      won: role === 'winner',
      elo_pre: num(r[p + '_elo_pre']),
      surface_elo_pre: num(r[p + '_surface_elo_pre']),
      win_pct_30d_pre: num(r[p + '_win_pct_30d_pre']),
      win_pct_90d_pre: num(r[p + '_win_pct_90d_pre']),
      win_pct_365d_pre: num(r[p + '_win_pct_365d_pre']),
      matches_7d_pre: int(r[p + '_matches_7d_pre']),
      matches_14d_pre: int(r[p + '_matches_14d_pre']),
      rest_days_pre: int(r[p + '_rest_days_pre']),
      career_surface_win_pct_pre: num(r[p + '_career_surface_win_pct_pre']),
      career_surface_matches_pre: int(r[p + '_career_surface_matches_pre']),
      rank_pre: plausibleRank(r[p + '_rank']),
      rank_points_pre: int(r[p + '_rank_points']),
      age_pre: plausibleAge(r[p + '_age']),
      height_cm: plausibleHeight(r[p + '_ht']),
      plays: (function (h) { var k = str(h); return k && /^[RLAU]$/i.test(k) ? k.toUpperCase() : null; })(r[p + '_hand']),
      best_of: match.best_of,
      tourney_level: match.level,
      environment: match.environment,
      /* Rolling serve/return strength is NOT in the archive row — the row's
         serve numbers are this match's, which is the leak. These are filled by
         tools/tennis/build_features.js from matches strictly before this one,
         and stay null until it has run. Null, never zero. */
      serve_strength_pre: null,
      return_strength_pre: null,
      serve_sample_pre: null,
      sos_elo_pre: null,
      sos_sample_pre: null,
      feature_version: FEATURE_VERSION,
      feature_source_key: 'edgedesk'
    };
    var missing = [];
    MODEL_INPUTS.forEach(function (k) { if (f[k] == null) missing.push(k); });
    f.missing_fields = missing;
    f.completeness = round(1 - (missing.length / MODEL_INPUTS.length), 3);
    return f;
  }

  /* The inputs the model may read. Naming them once means the completeness
     score, the missing-field list and the feature vector can never disagree
     about what "complete" means. */
  var MODEL_INPUTS = [
    'elo_pre', 'surface_elo_pre', 'win_pct_30d_pre', 'win_pct_90d_pre', 'win_pct_365d_pre',
    'matches_7d_pre', 'matches_14d_pre', 'rest_days_pre',
    'career_surface_win_pct_pre', 'career_surface_matches_pre',
    'rank_pre', 'rank_points_pre', 'age_pre',
    'serve_strength_pre', 'return_strength_pre', 'sos_elo_pre'
  ];

  /* ───────────────────────────── the feature vector ────────────────────── */

  /* The model reads DIFFERENCES, not levels. Two players' Elos matter only
     relative to each other, and a difference is stable across eras in a way a
     level is not: 1800 was elite in 1985 and is mid-table now.

     A missing input does NOT become zero. It becomes the neutral value for a
     DIFFERENCE, which is zero only because "no difference" is the honest
     statement when one side is unknown — and it is RECORDED in `missing`, so
     uncertainty widens and the research gate can refuse the match entirely. */
  var FEATURE_NAMES = [
    'd_elo',            // (elo_a - elo_b) / 100
    'd_surface_elo',    // (surface_elo_a - surface_elo_b) / 100
    'd_rank_log',       // log(rank_b) - log(rank_a): higher = a is better ranked
    'd_rank_points_log',
    'd_form_90',
    'd_form_365',
    'd_rest',           // capped and scaled; too much rest is not linearly good
    'd_workload_14d',
    'd_surface_experience',
    'd_age',
    'd_serve_strength',
    'd_return_strength',
    'd_sos',
    'best_of_5',        // 1 when best of five; interacts with the Elo edge
    'level_weight',
    'elo_x_bo5'
  ];

  function featureVector(a, b, ctx) {
    a = a || {}; b = b || {}; ctx = ctx || {};
    var missing = [];
    function d(key, scale, name) {
      var x = a[key], y = b[key];
      if (x == null || y == null) { missing.push(name); return 0; }
      return (Number(x) - Number(y)) / (scale || 1);
    }
    function dLog(key, name) {
      var x = num(a[key]), y = num(b[key]);
      if (x == null || y == null || x <= 0 || y <= 0) { missing.push(name); return 0; }
      return Math.log(y) - Math.log(x);
    }
    var dElo = d('elo_pre', 100, 'd_elo');
    var bo5 = (ctx.best_of != null ? Number(ctx.best_of) : (a.best_of != null ? Number(a.best_of) : null)) === 5 ? 1 : 0;

    /* Rest: a day off helps, a fortnight off is a layoff. Capped at 14 and
       scaled, so 40 days of absence is not read as forty days of freshness. */
    function restTerm(v) {
      var x = num(v);
      if (x == null) return null;
      return clamp(x, 0, 14) / 14;
    }
    var ra = restTerm(a.rest_days_pre), rb = restTerm(b.rest_days_pre);
    var dRest = (ra == null || rb == null) ? (missing.push('d_rest'), 0) : (ra - rb);

    /* Surface experience: a win rate is only worth reading with a sample. A
       player with four clay matches contributes a shrunk figure, not a 100%. */
    function surfExp(row) {
      var pct = num(row.career_surface_win_pct_pre), n = num(row.career_surface_matches_pre);
      if (pct == null || n == null) return null;
      var k = 30;                         // matches at which the raw rate is trusted
      return ((pct * n) + (0.5 * k)) / (n + k) - 0.5;
    }
    var sa = surfExp(a), sb = surfExp(b);
    var dSurfExp = (sa == null || sb == null) ? (missing.push('d_surface_experience'), 0) : (sa - sb);

    var x = {
      d_elo: dElo,
      d_surface_elo: d('surface_elo_pre', 100, 'd_surface_elo'),
      d_rank_log: dLog('rank_pre', 'd_rank_log'),
      d_rank_points_log: (function () {
        var p = num(a.rank_points_pre), q = num(b.rank_points_pre);
        if (p == null || q == null || p <= 0 || q <= 0) { missing.push('d_rank_points_log'); return 0; }
        return Math.log(p) - Math.log(q);
      })(),
      d_form_90: d('win_pct_90d_pre', 1, 'd_form_90'),
      d_form_365: d('win_pct_365d_pre', 1, 'd_form_365'),
      d_rest: dRest,
      d_workload_14d: d('matches_14d_pre', 5, 'd_workload_14d'),
      d_surface_experience: dSurfExp,
      d_age: d('age_pre', 10, 'd_age'),
      d_serve_strength: d('serve_strength_pre', 1, 'd_serve_strength'),
      d_return_strength: d('return_strength_pre', 1, 'd_return_strength'),
      d_sos: d('sos_elo_pre', 100, 'd_sos'),
      best_of_5: bo5,
      level_weight: levelWeight(ctx.level != null ? ctx.level : a.tourney_level),
      elo_x_bo5: dElo * bo5
    };
    var vec = FEATURE_NAMES.map(function (n) { return x[n]; });
    return { names: FEATURE_NAMES, values: vec, map: x, missing: missing,
             completeness: round(1 - (missing.length / FEATURE_NAMES.length), 3) };
  }

  /* ───────────────────────────── the model ─────────────────────────────── */

  function sigmoid(z) {
    if (z >= 0) { var e = Math.exp(-z); return 1 / (1 + e); }
    var f = Math.exp(z); return f / (1 + f);
  }

  /* SEED COEFFICIENTS. A usable model on day one, before anything is trained:
     fitted offline on the development sample and deliberately conservative.
     tools/tennis/build_model.js replaces them with a fitted, evaluated,
     registered version — and the registry, not this file, is what production
     reads. These exist so a fresh database is never silently unpredicted. */
  var SEED_MODEL = {
    model_version: 'tennis-baseline-seed-1.0.0',
    feature_version: FEATURE_VERSION,
    algorithm: 'logistic_regression_l2',
    intercept: 0,
    coefficients: {
      d_elo: 0.62, d_surface_elo: 0.34, d_rank_log: 0.18, d_rank_points_log: 0.06,
      d_form_90: 0.22, d_form_365: 0.30, d_rest: 0.05, d_workload_14d: -0.04,
      d_surface_experience: 0.45, d_age: -0.05, d_serve_strength: 0.35,
      d_return_strength: 0.30, d_sos: 0.08, best_of_5: 0, level_weight: 0,
      elo_x_bo5: 0.10
    }
  };

  /* Predict P(player A beats player B). `model` is a registry row: an
     intercept and a coefficient per feature name. A coefficient the model does
     not carry is zero — a new feature added to this file cannot change what an
     old, already-published model version predicted. That is what makes a model
     version reproducible. */
  function predict(model, fv) {
    var m = model || SEED_MODEL;
    var c = m.coefficients || {};
    var z = Number(m.intercept || 0);
    for (var i = 0; i < fv.names.length; i++) {
      var k = fv.names[i], w = c[k];
      if (w == null) continue;
      var v = fv.values[i];
      if (v == null || !isFinite(v)) continue;
      z += Number(w) * Number(v);
    }
    var p = sigmoid(z);
    /* Never 0 and never 1: a tennis match is not certain, and a log loss of
       infinity is a bug rather than a measurement. */
    p = clamp(p, 0.005, 0.995);
    return p;
  }

  /* ───────────────────────────── price ─────────────────────────────────── */

  function decimalFromProb(p) {
    if (p == null || !(p > 0 && p < 1)) return null;
    return round(1 / p, 4);
  }
  function americanFromDecimal(d) {
    if (d == null || !(d > 1)) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
  }
  function decimalFromAmerican(a) {
    var n = num(a);
    if (n == null || n === 0) return null;
    return round(n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n), 4);
  }
  function probFromDecimal(d) {
    var n = num(d);
    if (n == null || !(n > 1)) return null;
    return round(1 / n, 5);
  }
  /* Two-way de-vig, proportional. The market's own number, with the book's
     margin removed — labelled as the market's, never as EdgeDesk's. */
  function devigTwoWay(pA, pB) {
    var a = num(pA), b = num(pB);
    if (a == null || b == null) return { a: null, b: null, overround: null };
    var s = a + b;
    if (!(s > 0)) return { a: null, b: null, overround: null };
    return { a: round(a / s, 5), b: round(b / s, 5), overround: round(s - 1, 5) };
  }
  function edge(modelProb, marketProb) {
    var m = num(modelProb), k = num(marketProb);
    if (m == null || k == null) return null;
    return round(m - k, 5);
  }
  /* Expected value per unit staked at this price, given the model's
     probability. It is a research quantity, not an instruction: there is no
     stake here and no bankroll. */
  function expectedValue(modelProb, decimalOdds) {
    var p = num(modelProb), d = num(decimalOdds);
    if (p == null || d == null || !(d > 1)) return null;
    return round(p * (d - 1) - (1 - p), 5);
  }

  /* ───────────────────────────── power rating ──────────────────────────── */

  var RATING_FULL_SAMPLE = 40;      // matches at which a rating is fully trusted

  /* Elo -> the 0-100 scale, with the tour's own distribution as the reference,
     shrunk toward 50 by how little is known. Documented on screen by
     tennis.power_rating_scale() in SQL and by ratingScaleText() here, and the
     two strings are asserted equal by the SQL suite. */
  function powerRating(elo, sample, tourStats) {
    var e = num(elo);
    if (e == null) return { power_rating: null, uncertainty: 1, sample: sample || 0 };
    var ref = tourStats || {};
    var mu = num(ref.mean) != null ? num(ref.mean) : 1500;
    var sd = num(ref.stdev) != null && num(ref.stdev) > 1 ? num(ref.stdev) : 150;
    var n = Math.max(0, int(sample) || 0);
    var raw = 50 + 10 * ((e - mu) / sd);
    var trust = n >= RATING_FULL_SAMPLE ? 1 : (n / RATING_FULL_SAMPLE);
    var shrunk = 50 + (raw - 50) * trust;
    return {
      power_rating: round(clamp(shrunk, 0, 100), 2),
      uncertainty: round(clamp(1 - trust, 0, 1), 3),
      sample: n,
      raw: round(clamp(raw, 0, 100), 2)
    };
  }
  function ratingScaleText() {
    return 'EdgeDesk power rating, 0-100. 50 is the median rated player on this '
         + 'tour on the day the rating was built. Ten points is about one '
         + 'standard deviation of tour Elo. A player with a thin record is '
         + 'shrunk toward 50 in proportion to what is missing, so the number '
         + 'always carries its sample and its uncertainty beside it. It is a '
         + 'description of the record on file, not a forecast of a match.';
  }

  /* ───────────────────────────── the research gate ─────────────────────── */

  /* WHAT EDGEDESK REFUSES TO PUBLISH.

     Every threshold is named, every refusal carries a reason code, and a
     refused match is SHOWN as refused rather than hidden — a reader who cannot
     see why a match is missing learns nothing from its absence. */
  var GATES = {
    version: 'tennis-research-gates-1.0',
    minCompleteness: 0.55,          // share of model inputs actually present
    minRatingSample: 10,            // matches behind each side's rating
    maxUncertainty: 0.70,
    maxMarketAgeMinutes: 180,
    maxFeatureAgeHours: 48,
    minEdge: 0.02,                  // below this the gap is noise, not a finding
    maxOverround: 0.12              // a market this wide is not a reference price
  };

  function gradeResearch(input) {
    var i = input || {};
    var reasons = [];
    var completeness = num(i.completeness);
    if (completeness == null || completeness < GATES.minCompleteness)
      reasons.push('incomplete_features');
    var sa = int(i.rating_sample_a), sb = int(i.rating_sample_b);
    if (sa == null || sb == null || sa < GATES.minRatingSample || sb < GATES.minRatingSample)
      reasons.push('thin_rating_sample');
    var unc = num(i.uncertainty);
    if (unc != null && unc > GATES.maxUncertainty) reasons.push('high_uncertainty');
    if (i.surface == null || i.surface === 'unknown') reasons.push('surface_unknown');
    if (i.market_prob == null) reasons.push('no_market_price');
    var overround = num(i.overround);
    if (overround != null && overround > GATES.maxOverround) reasons.push('market_too_wide');
    var mAge = num(i.market_age_minutes);
    if (mAge != null && mAge > GATES.maxMarketAgeMinutes) reasons.push('market_stale');
    var fAge = num(i.feature_age_hours);
    if (fAge != null && fAge > GATES.maxFeatureAgeHours) reasons.push('features_stale');
    if (i.model_active === false) reasons.push('model_not_active');
    if (i.doubles === true) reasons.push('doubles_not_modelled');
    if (i.players_resolved === false) reasons.push('player_unresolved');

    /* 'research' is the full grade. 'provisional' means EdgeDesk will show the
       number with the caveat attached. 'excluded' means it will not show a
       price at all — the match still appears, saying why. */
    var hard = ['no_market_price', 'model_not_active', 'doubles_not_modelled',
                'player_unresolved', 'incomplete_features'];
    var isHard = reasons.some(function (r) { return hard.indexOf(r) >= 0; });
    var grade = reasons.length === 0 ? 'research' : (isHard ? 'excluded' : 'provisional');
    return { grade: grade, reasons: reasons, gates_version: GATES.version };
  }

  /* Confidence: how much weight a careful reader should give this number. It
     is NOT the probability, and it never becomes one. */
  function confidence(input) {
    var i = input || {};
    var c = 1;
    var completeness = num(i.completeness);
    if (completeness != null) c *= clamp(completeness, 0, 1);
    var unc = num(i.uncertainty);
    if (unc != null) c *= clamp(1 - unc, 0, 1);
    var sa = int(i.rating_sample_a) || 0, sb = int(i.rating_sample_b) || 0;
    var sampleTrust = clamp(Math.min(sa, sb) / RATING_FULL_SAMPLE, 0, 1);
    c *= (0.4 + 0.6 * sampleTrust);
    if (i.surface == null || i.surface === 'unknown') c *= 0.8;
    return round(clamp(c, 0, 1), 3);
  }
  function confidenceBucket(c) {
    var x = num(c);
    if (x == null) return 'unknown';
    if (x >= 0.75) return 'high';
    if (x >= 0.50) return 'moderate';
    if (x >= 0.25) return 'low';
    return 'very_low';
  }
  function calibrationBucket(p) {
    var x = num(p);
    if (x == null) return null;
    var b = Math.min(9, Math.floor(x * 10));
    return (b * 10) + '-' + ((b + 1) * 10);
  }

  /* ───────────────────────────── metrics ───────────────────────────────── */

  function logLoss(preds, outcomes) {
    var s = 0, n = 0;
    for (var i = 0; i < preds.length; i++) {
      var p = num(preds[i]), y = outcomes[i] ? 1 : 0;
      if (p == null) continue;
      p = clamp(p, 1e-9, 1 - 1e-9);
      s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
      n++;
    }
    return n ? round(s / n, 6) : null;
  }
  function brier(preds, outcomes) {
    var s = 0, n = 0;
    for (var i = 0; i < preds.length; i++) {
      var p = num(preds[i]);
      if (p == null) continue;
      var y = outcomes[i] ? 1 : 0;
      s += (p - y) * (p - y);
      n++;
    }
    return n ? round(s / n, 6) : null;
  }
  function accuracy(preds, outcomes) {
    var ok = 0, n = 0;
    for (var i = 0; i < preds.length; i++) {
      var p = num(preds[i]);
      if (p == null) continue;
      if ((p >= 0.5) === !!outcomes[i]) ok++;
      n++;
    }
    return n ? round(ok / n, 5) : null;
  }
  function calibrationCurve(preds, outcomes, bins) {
    var k = bins || 10, out = [];
    for (var b = 0; b < k; b++) out.push({ bin: b, lo: b / k, hi: (b + 1) / k, n: 0, sum_p: 0, sum_y: 0 });
    for (var i = 0; i < preds.length; i++) {
      var p = num(preds[i]);
      if (p == null) continue;
      var idx = Math.min(k - 1, Math.floor(p * k));
      out[idx].n++; out[idx].sum_p += p; out[idx].sum_y += (outcomes[i] ? 1 : 0);
    }
    return out.map(function (r) {
      return { bin: r.bin, lo: round(r.lo, 3), hi: round(r.hi, 3), n: r.n,
               mean_predicted: r.n ? round(r.sum_p / r.n, 4) : null,
               observed_rate: r.n ? round(r.sum_y / r.n, 4) : null,
               gap: r.n ? round((r.sum_y / r.n) - (r.sum_p / r.n), 4) : null };
    });
  }
  /* Expected calibration error: the mean absolute gap, weighted by bin size.
     One number for "is this model honest about its own confidence".

     BINS BELOW minBinN ARE EXCLUDED, and this is a correction rather than a
     convenience. A bucket holding five matches has a binomial standard error
     near 22 points, so its "gap" is mostly noise — and because ECE is a
     weighted MEAN of absolute gaps, noise can only ever push it UP. Including
     such a bucket therefore makes a well-calibrated model look miscalibrated,
     never the reverse, which is the wrong direction for a gate to fail in.
     The excluded matches are reported (`unmeasured`), so the number is never
     quietly computed over less than it claims. */
  var ECE_MIN_BIN = 30;
  function expectedCalibrationError(curve, minBinN) {
    var floorN = minBinN == null ? ECE_MIN_BIN : minBinN;
    var tot = 0, s = 0, unmeasured = 0, bins = 0;
    (curve || []).forEach(function (r) {
      if (!r.n || r.gap == null) return;
      if (r.n < floorN) { unmeasured += r.n; return; }
      tot += r.n; s += r.n * Math.abs(r.gap); bins++;
    });
    var ece = tot ? round(s / tot, 5) : null;
    /* the older single-number contract is preserved: callers that want the
       detail read .detail, callers that want the number get the number */
    var out = Number(ece);
    if (ece == null) return null;
    out = ece;
    expectedCalibrationError.lastDetail = { ece: ece, measured: tot, unmeasured: unmeasured,
                                            bins: bins, min_bin_n: floorN };
    return out;
  }
  /* The same thing with its workings, for a registry row that has to explain
     itself later. */
  function calibrationError(curve, minBinN) {
    var floorN = minBinN == null ? ECE_MIN_BIN : minBinN;
    var tot = 0, s = 0, unmeasured = 0, bins = 0, worst = null;
    (curve || []).forEach(function (r) {
      if (!r.n || r.gap == null) return;
      if (r.n < floorN) { unmeasured += r.n; return; }
      tot += r.n; s += r.n * Math.abs(r.gap); bins++;
      if (worst == null || Math.abs(r.gap) > Math.abs(worst.gap)) worst = r;
    });
    return { ece: tot ? round(s / tot, 5) : null, measured: tot, unmeasured: unmeasured,
             bins: bins, min_bin_n: floorN,
             worst_bin: worst ? { lo: worst.lo, hi: worst.hi, n: worst.n, gap: worst.gap } : null };
  }

  /* ───────────────────────────── the fitter ────────────────────────────── */

  /* L2-regularised logistic regression by gradient descent. Deliberately
     small: this repository has no dependencies and a model that cannot be
     retrained on a bare Node install is a model nobody retrains. Inputs are
     standardised internally and the coefficients are returned on the ORIGINAL
     scale, so a registry row is readable without carrying a scaler with it. */
  function fitLogistic(X, y, opts) {
    opts = opts || {};
    var lr = opts.lr || 0.15, epochs = opts.epochs || 400, l2 = opts.l2 == null ? 1e-3 : opts.l2;
    var n = X.length, d = n ? X[0].length : 0;
    if (!n || !d) return { intercept: 0, weights: new Array(d).fill(0), epochs: 0, converged: false };

    var mu = new Array(d).fill(0), sd = new Array(d).fill(1);
    var j, i;
    for (j = 0; j < d; j++) {
      var col = [];
      for (i = 0; i < n; i++) col.push(X[i][j]);
      mu[j] = mean(col) || 0;
      var s = stdev(col);
      sd[j] = (s != null && s > 1e-9) ? s : 1;
    }
    var w = new Array(d).fill(0), b = 0;
    var prevLoss = Infinity, converged = false, used = 0;
    for (var ep = 0; ep < epochs; ep++) {
      var gw = new Array(d).fill(0), gb = 0, loss = 0;
      for (i = 0; i < n; i++) {
        var z = b;
        for (j = 0; j < d; j++) z += w[j] * ((X[i][j] - mu[j]) / sd[j]);
        var p = clamp(sigmoid(z), 1e-9, 1 - 1e-9);
        var yi = y[i] ? 1 : 0;
        var err = p - yi;
        loss += -(yi * Math.log(p) + (1 - yi) * Math.log(1 - p));
        gb += err;
        for (j = 0; j < d; j++) gw[j] += err * ((X[i][j] - mu[j]) / sd[j]);
      }
      loss = loss / n;
      for (j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
      b -= lr * (gb / n);
      used = ep + 1;
      if (Math.abs(prevLoss - loss) < 1e-7) { converged = true; break; }
      prevLoss = loss;
    }
    /* back to the original scale */
    var weights = new Array(d), intercept = b;
    for (j = 0; j < d; j++) {
      weights[j] = w[j] / sd[j];
      intercept -= w[j] * mu[j] / sd[j];
    }
    return { intercept: round(intercept, 6), weights: weights.map(function (x) { return round(x, 6); }),
             epochs: used, converged: converged, train_loss: round(prevLoss, 6) };
  }

  function modelFromFit(fit, names, meta) {
    var c = {};
    (names || FEATURE_NAMES).forEach(function (nm, i) { c[nm] = fit.weights[i]; });
    return Object.assign({
      feature_version: FEATURE_VERSION,
      algorithm: 'logistic_regression_l2',
      intercept: fit.intercept,
      coefficients: c
    }, meta || {});
  }

  /* ───────────────────────────── baselines to beat ─────────────────────── */

  /* A model is only worth deploying if it beats the obvious alternatives. These
     are those alternatives, implemented here so the comparison is the same
     arithmetic every time it is quoted. */
  function eloProb(eloA, eloB) {
    var a = num(eloA), b = num(eloB);
    if (a == null || b == null) return null;
    return clamp(1 / (1 + Math.pow(10, (b - a) / 400)), 0.005, 0.995);
  }
  function rankProb(rankA, rankB) {
    var a = num(rankA), b = num(rankB);
    if (a == null || b == null || a <= 0 || b <= 0) return null;
    /* log-rank difference through a logistic with a slope fitted on the
       development sample; the point is a reference, not a product. */
    var z = 0.55 * (Math.log(b) - Math.log(a));
    return clamp(sigmoid(z), 0.005, 0.995);
  }

  return {
    VERSION: VERSION,
    FEATURE_VERSION: FEATURE_VERSION,
    RATING_VERSION: RATING_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    FEATURE_COLUMNS: FEATURE_COLUMNS,
    POST_MATCH_COLUMNS: POST_MATCH_COLUMNS,
    MODEL_INPUTS: MODEL_INPUTS,
    FEATURE_NAMES: FEATURE_NAMES,
    SURFACES: SURFACES,
    LEVELS: LEVELS,
    GATES: GATES,
    SEED_MODEL: SEED_MODEL,
    RATING_FULL_SAMPLE: RATING_FULL_SAMPLE,
    num: num, int: int, str: str, bool: bool, round: round, clamp: clamp,
    mean: mean, stdev: stdev,
    normName: normName, slug: slug,
    plausibleHeight: plausibleHeight, plausibleAge: plausibleAge, plausibleRank: plausibleRank,
    isPlaceholderPlayer: isPlaceholderPlayer, PLACEHOLDER_NAMES: PLACEHOLDER_NAMES,
    HEIGHT_MIN: HEIGHT_MIN, HEIGHT_MAX: HEIGHT_MAX,
    matchKey: matchKey, playerKey: playerKey, tournamentKey: tournamentKey, venueKey: venueKey,
    normSurface: normSurface, surfaceOrUnknown: surfaceOrUnknown, normEnvironment: normEnvironment,
    normTour: normTour, levelWeight: levelWeight, levelLabel: levelLabel, roundOrder: roundOrder,
    parseDate: parseDate, seasonOf: seasonOf, parseScore: parseScore,
    validateRow: validateRow, parseArchiveRow: parseArchiveRow,
    featureVector: featureVector,
    sigmoid: sigmoid, predict: predict,
    decimalFromProb: decimalFromProb, americanFromDecimal: americanFromDecimal,
    decimalFromAmerican: decimalFromAmerican, probFromDecimal: probFromDecimal,
    devigTwoWay: devigTwoWay, edge: edge, expectedValue: expectedValue,
    powerRating: powerRating, ratingScaleText: ratingScaleText,
    gradeResearch: gradeResearch, confidence: confidence,
    confidenceBucket: confidenceBucket, calibrationBucket: calibrationBucket,
    logLoss: logLoss, brier: brier, accuracy: accuracy,
    calibrationCurve: calibrationCurve, expectedCalibrationError: expectedCalibrationError,
    calibrationError: calibrationError, ECE_MIN_BIN: ECE_MIN_BIN,
    fitLogistic: fitLogistic, modelFromFit: modelFromFit,
    eloProb: eloProb, rankProb: rankProb
  };
});
