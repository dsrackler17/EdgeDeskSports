/* ============================================================================
   ALTITUDE & TRAVEL — one definition of every altitude and travel fact, for
   the research harness, the slate build, the research page and the desk.

   WHY ONE FILE. The repository already measured altitude twice and the two
   measurements disagree about what altitude IS: the V1 engine's travel layer
   reads `homeVenue.elev - awayVenue.elev` from each TEAM's current stadium
   (metres, a team-keyed snapshot), and the V2 research reads the same snapshot
   in feet. Neither knows where a game was actually played, so a neutral site,
   a stadium move or a home game moved to another city is measured as if it
   were played at the home team's current address. Here a game is located by
   the schedule's own venue_id, a team's NORMAL elevation is the venue it
   actually played its home games in that season, and every number the
   research fitted is computed by the same function the live page shows.

   WHAT IS MEASURED, AND WHAT IS NOT CONFUSED WITH WHAT.
     game elevation      the venue's height above sea level (feet)
     usual elevation     a team's normal home venue that season, from the
                         schedule (modal non-neutral home venue id)
     gain                game elevation MINUS the team's usual elevation —
                         signed. A descent is not "no gain": it is reported as
                         a loss and bucketed as one
     positive gain       max(0, gain)
     ratio               game elevation / usual elevation. DESCRIPTIVE ONLY:
                         a sea-level visitor reaches "6x" at a 60 ft venue, so
                         the ratio flags trips that are not altitude at all
     distance            great-circle miles from the usual home venue
     time-zone change    signed hours at kickoff, daylight saving applied
     rest                days since the team's previous game
     acclimatization     two proxies the schedule supports and nothing more:
                         the team LIVES high (usual elevation >= 3,000 ft) and
                         the team's previous game was played high, within 14 days

   WHAT IT DOES NOT CLAIM. Nothing here says altitude causes missed tackles,
   penalties, turnovers or fourth-quarter fades. The adjustment is a fitted
   residual on the V1 margin, it is SHADOW until the promotion gates pass and a
   person turns the server flag on, and its text says exactly that.

   Runs in the browser (window.EDCfbAltitude) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDCfbAltitude = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'edgedesk_cfb_altitude_context_v1';
  var FT_PER_M = 3.28084;
  var HIGH_FT = 3000, MODERATE_FT = 1000, NONE_FT = 100, VERY_HIGH_FT = 6000;
  var RECENT_DAYS = 14;
  var MS_DAY = 864e5;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r0(x) { return isNum(x) ? Math.round(x) : null; }
  function r1(x) { return isNum(x) ? Math.round(x * 10) / 10 : null; }
  function r2(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
  function defaultKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function fmtFt(x) { return isNum(x) ? Math.round(x).toLocaleString('en-US') + ' ft' : 'unavailable'; }
  function signedFt(x) { return isNum(x) ? (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(Math.round(x)).toLocaleString('en-US') + ' ft' : 'unavailable'; }

  /* -------------------------------------------------------- classification */
  /* The gain buckets keep a descent apart from a level trip: the research
     package's "<1,000 ft" bucket held both, which is how a Colorado team
     flying to Miami and Purdue driving to Indiana became the same reference
     group. */
  function gainBucket(gainFt) {
    if (!isNum(gainFt)) return null;
    if (gainFt >= HIGH_FT) return 'high_gain';
    if (gainFt >= MODERATE_FT) return 'moderate_gain';
    if (gainFt > -MODERATE_FT) return 'level';
    if (gainFt > -HIGH_FT) return 'descent';
    return 'large_descent';
  }
  function direction(gainFt) {
    if (!isNum(gainFt)) return null;
    return gainFt >= NONE_FT ? 'gain' : (gainFt <= -NONE_FT ? 'loss' : 'none');
  }
  function venueClass(elevFt) {
    if (!isNum(elevFt)) return null;
    if (elevFt >= VERY_HIGH_FT) return 'very_high';
    if (elevFt >= HIGH_FT) return 'high';
    if (elevFt >= MODERATE_FT) return 'moderate';
    return 'low';
  }
  var BUCKET_TEXT = {
    high_gain: '3,000 ft or more of elevation gain',
    moderate_gain: '1,000–2,999 ft of elevation gain',
    level: 'within 1,000 ft of normal elevation',
    descent: '1,000–2,999 ft lower than normal',
    large_descent: '3,000 ft or more lower than normal'
  };
  var EXPOSURE = {
    HIGH: 'High altitude exposure',
    MODERATE: 'Moderate altitude exposure',
    MINIMAL: 'Minimal altitude exposure',
    DESCENT: 'Playing below normal elevation',
    UNKNOWN: 'Altitude exposure unavailable'
  };

  /* ------------------------------------------------------------ time zones */
  /* A STATIC TABLE AND THE US DAYLIGHT-SAVING RULE, not the platform's Intl
     data, so the browser, node and the research harness compute the same
     offset for the same instant. Arizona and Hawaii do not observe DST, which
     is exactly the case a fixed-offset column gets wrong every September. */
  /* [standard offset, observes DST, first year it did (null = throughout)].
     Most of Indiana adopted daylight saving only in 2006, so a 2004 game in
     South Bend was on UTC-5 in September while New York was on UTC-4. */
  var ZONES = {
    'America/New_York': [-5, true], 'America/Detroit': [-5, true],
    'America/Indiana/Indianapolis': [-5, true, 2006], 'America/Kentucky/Louisville': [-5, true],
    'America/Indiana/Vincennes': [-5, true, 2006], 'America/Indiana/Winamac': [-5, true, 2006],
    'America/Indiana/Marengo': [-5, true, 2006], 'America/Indiana/Petersburg': [-5, true, 2006],
    'America/Indiana/Vevay': [-5, true, 2006], 'America/Kentucky/Monticello': [-5, true],
    'America/Chicago': [-6, true], 'America/Indiana/Knox': [-6, true, 2006], 'America/Indiana/Tell_City': [-6, true, 2006],
    'America/Menominee': [-6, true], 'America/North_Dakota/Center': [-6, true],
    'America/North_Dakota/New_Salem': [-6, true], 'America/North_Dakota/Beulah': [-6, true],
    'America/Denver': [-7, true], 'America/Boise': [-7, true], 'America/Phoenix': [-7, false],
    'America/Los_Angeles': [-8, true], 'America/Anchorage': [-9, true], 'Pacific/Honolulu': [-10, false],
    'America/Puerto_Rico': [-4, false]
  };
  function nthSundayUtc(year, month, n) {          /* month 0-based; n>0 from start, n<0 from end */
    var d, day;
    if (n > 0) {
      d = Date.UTC(year, month, 1); day = new Date(d).getUTCDay();
      return d + (((7 - day) % 7) + (n - 1) * 7) * MS_DAY;
    }
    d = Date.UTC(year, month + 1, 0); day = new Date(d).getUTCDay();
    return d - day * MS_DAY;
  }
  function usDst(utcMs, stdOffset) {
    var y = new Date(utcMs).getUTCFullYear(), start, end;
    if (y >= 2007) { start = nthSundayUtc(y, 2, 2); end = nthSundayUtc(y, 10, 1); }
    else { start = nthSundayUtc(y, 3, 1); end = nthSundayUtc(y, 9, -1); }
    /* 02:00 local standard time on the start day, 02:00 local daylight time on the end day */
    start += (2 - stdOffset) * 3600e3;
    end += (2 - (stdOffset + 1)) * 3600e3;
    return utcMs >= start && utcMs < end;
  }
  function tzOffsetAt(tzName, utcMs) {
    var z = ZONES[tzName];
    if (!z || !isNum(utcMs)) return null;
    var observes = z[1] && (z[2] == null || new Date(utcMs).getUTCFullYear() >= z[2]);
    return z[0] + (observes && usDst(utcMs, z[0]) ? 1 : 0);
  }

  function haversineMi(lat1, lon1, lat2, lon2) {
    if (![lat1, lon1, lat2, lon2].every(isNum)) return null;
    var R = 3958.7613, d2r = Math.PI / 180;
    var p1 = lat1 * d2r, p2 = lat2 * d2r, dp = p2 - p1, dl = (lon2 - lon1) * d2r;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
  }

  /* ------------------------------------------------------------- venues */
  function venueOf(registry, venueId) {
    var v = registry && registry.venues && venueId != null ? registry.venues[String(Math.round(+venueId))] : null;
    return v || null;
  }
  function venueView(v, locatedBy) {
    if (!v) return null;
    return { venue_id: v.venue_id, name: v.name || null, city: v.city || null,
      elev_ft: r0(v.elev_ft), elev_m: r0(v.elev_m), confidence: v.confidence,
      source: v.elev_source, basis: v.basis, tz_name: v.tz_name || null, located_by: locatedBy || null };
  }

  /* ------------------------------------------------------- the schedule
     rows: every game of the season (and optionally the previous one), each
     { game_id, season, start_date, neutral_site, venue_id, home_team,
       away_team }. Nothing in a row is a result: only who played where and
     when, which the schedule publishes before the season. */
  function teamIndex(rows, key) {
    key = key || defaultKey;
    var idx = {};
    (rows || []).forEach(function (g) {
      var t = Date.parse(g.start_date || g.kickoff);
      if (!isFinite(t)) return;
      var hk = key(g.home_team), ak = key(g.away_team);
      var base = { game_id: String(g.game_id), season: +g.season, t: t,
        venue_id: g.venue_id == null || g.venue_id === '' ? null : Math.round(+g.venue_id), neutral: !!g.neutral_site };
      if (hk) (idx[hk] = idx[hk] || []).push(Object.assign({ home: true }, base));
      if (ak) (idx[ak] = idx[ak] || []).push(Object.assign({ home: false }, base));
    });
    Object.keys(idx).forEach(function (k) { idx[k].sort(function (a, b) { return a.t - b.t || (a.game_id < b.game_id ? -1 : 1); }); });
    return idx;
  }

  /* A team's NORMAL home venue in a season: the venue id it hosts the most
     non-neutral home games in, ties to the most recent. Falls back to the
     previous season, then to the listed venue a caller supplies — and says
     which it used. */
  function usualVenue(idx, teamKey, season, listed) {
    var list = idx[teamKey] || [];
    function modal(s) {
      var n = {}, last = {}, best = null;
      list.forEach(function (g) {
        if (!g.home || g.neutral || g.season !== s || g.venue_id == null) return;
        n[g.venue_id] = (n[g.venue_id] || 0) + 1; last[g.venue_id] = Math.max(last[g.venue_id] || 0, g.t);
      });
      Object.keys(n).forEach(function (k) {
        if (best == null || n[k] > n[best] || (n[k] === n[best] && last[k] > last[best])) best = k;
      });
      return best == null ? null : { venue_id: +best, games: n[best] };
    }
    var m = modal(season);
    if (m) return { venue_id: m.venue_id, basis: 'modal home venue of ' + m.games + ' scheduled home game' + (m.games === 1 ? '' : 's') + ' in ' + season, from: 'season' };
    m = modal(season - 1);
    if (m) return { venue_id: m.venue_id, basis: 'no ' + season + ' home game scheduled; modal home venue in ' + (season - 1), from: 'prior_season' };
    if (listed && listed.venue_id != null) return { venue_id: +listed.venue_id, basis: 'no scheduled home game found; the venue the team table lists', from: 'listed' };
    return null;
  }

  /* the team's previous game IN THE SAME SEASON. A season opener has no
     previous game, so its rest is reported as unavailable rather than as the
     eight months since last year's bowl. */
  function previousGame(idx, teamKey, gameId, t, season) {
    var list = idx[teamKey] || [], prev = null;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].game_id) === String(gameId)) break;
      if (list[i].t < t && (season == null || list[i].season === season)) prev = list[i];
    }
    return prev;
  }

  /* ------------------------------------------------------------ the context */
  function side(env, idx, game, which, gameVenue, t) {
    var key = env.normKey || defaultKey;
    var team = which === 'home' ? game.home_team : game.away_team;
    var tk = key(team);
    var listed = env.listed ? env.listed[tk] : null;
    var uv = usualVenue(idx, tk, +game.season, listed);
    var usual = uv ? venueOf(env.registry, uv.venue_id) : null;
    var missing = [];
    if (!uv) missing.push('no normal home venue could be established for ' + team);
    else if (!usual) missing.push(team + '’s normal home venue (id ' + uv.venue_id + ') has no sourced elevation');
    var gElev = gameVenue ? gameVenue.elev_ft : null, uElev = usual ? usual.elev_ft : null;
    var gain = (isNum(gElev) && isNum(uElev)) ? gElev - uElev : null;
    var tzG = gameVenue ? tzOffsetAt(gameVenue.tz_name, t) : null, tzU = usual ? tzOffsetAt(usual.tz_name, t) : null;
    var dist = (gameVenue && usual) ? haversineMi(usual.lat, usual.lon, gameVenue.lat, gameVenue.lon) : null;
    var prev = previousGame(idx, tk, game.game_id, t, +game.season);
    var prevVenue = prev ? venueOf(env.registry, prev.venue_id) : null;
    var rest = prev ? Math.round((t - prev.t) / MS_DAY) : null;
    var recentDays = prev ? (t - prev.t) / MS_DAY : null;
    var residentHigh = isNum(uElev) ? uElev >= HIGH_FT : null;
    var recentHigh = prev ? (prevVenue && isNum(prevVenue.elev_ft) ? (recentDays <= RECENT_DAYS && prevVenue.elev_ft >= HIGH_FT) : null) : false;
    return {
      team: team, team_key: tk,
      usual_venue: usual ? Object.assign(venueView(usual, uv.from), { basis_venue: uv.basis }) : (uv ? { venue_id: uv.venue_id, elev_ft: null, basis_venue: uv.basis, located_by: uv.from } : null),
      usual_elev_ft: r0(uElev),
      gain_ft: r0(gain),
      gain_pos_ft: isNum(gain) ? r0(Math.max(0, gain)) : null,
      direction: direction(gain),
      bucket: gainBucket(gain),
      ratio: (isNum(gElev) && isNum(uElev)) ? r2(gElev / Math.max(uElev, 1)) : null,
      ratio_ge6: (isNum(gElev) && isNum(uElev)) ? gElev >= 6 * Math.max(uElev, 1) : null,
      distance_mi: r0(dist),
      tz_change_h: (isNum(tzG) && isNum(tzU)) ? tzG - tzU : null,
      rest_days: rest,
      previous_game: prev ? { game_id: prev.game_id, venue_id: prev.venue_id,
        elev_ft: prevVenue ? r0(prevVenue.elev_ft) : null, days_before: r1(recentDays) } : null,
      acclimatization: {
        resident_high: residentHigh,
        recent_high_exposure: recentHigh,
        basis: 'schedule proxies only: the team’s normal home elevation, and whether its previous game (within '
          + RECENT_DAYS + ' days) was played at 3,000 ft or higher. No training, travel-timing or physiological data exists here.'
      },
      elevation_confidence: usual ? usual.confidence : null,
      missing: missing
    };
  }

  /* game: { game_id, season, kickoff|start_date, neutral_site, venue_id,
     home_team, away_team }. env: { registry, rows, normKey, listed }. */
  function context(game, env) {
    env = env || {};
    var t = Date.parse(game.kickoff || game.start_date);
    var idx = env.index || teamIndex(env.rows || [], env.normKey);
    var gv = venueOf(env.registry, game.venue_id), locatedBy = 'schedule venue id';
    var missing = [];
    if (!gv && !game.neutral_site) {
      /* a home game whose venue id the registry does not carry: located at the
         home team's normal venue, and SAID so */
      var hk = (env.normKey || defaultKey)(game.home_team);
      var uvh = usualVenue(idx, hk, +game.season, env.listed ? env.listed[hk] : null);
      if (uvh && venueOf(env.registry, uvh.venue_id) && (game.venue_id == null)) {
        gv = venueOf(env.registry, uvh.venue_id); locatedBy = 'home team’s normal venue (the schedule gives no venue id)';
      }
    }
    if (!gv) missing.push(game.venue_id == null ? 'the schedule gives no venue for this game'
      : 'venue ' + game.venue_id + ' has no sourced elevation');
    var home = side(env, idx, game, 'home', gv, t), away = side(env, idx, game, 'away', gv, t);
    missing = missing.concat(home.missing, away.missing);

    /* the side the altitude story is about: the visitor at a true home game;
       at a neutral site, whichever team climbed more */
    var focus = 'away';
    if (game.neutral_site && isNum(home.gain_ft) && (!isNum(away.gain_ft) || home.gain_ft > away.gain_ft)) focus = 'home';
    var f = focus === 'home' ? home : away;
    var cls;
    if (!isNum(f.gain_ft)) cls = 'UNKNOWN';
    else if (f.gain_ft >= HIGH_FT) cls = 'HIGH';
    else if (f.gain_ft >= MODERATE_FT) cls = 'MODERATE';
    else if (f.gain_ft <= -MODERATE_FT) cls = 'DESCENT';
    else cls = 'MINIMAL';

    var confs = [gv && gv.confidence, home.elevation_confidence, away.elevation_confidence];
    var low = confs.indexOf('LOW') >= 0;
    var usable = !!gv && isNum(home.gain_ft) && isNum(away.gain_ft) && !low;
    var reasons = [];
    if (!gv) reasons.push('game venue elevation unavailable');
    if (!isNum(home.gain_ft) || !isNum(away.gain_ft)) reasons.push('a team’s normal elevation is unavailable');
    if (low) reasons.push('an elevation used here is LOW confidence (its sources disagree)');
    /* bucket boundaries within an elevation's disagreement band */
    var band = Math.max(gv ? (gv.spread_ft || 0) : 0, 0);
    var nearEdge = isNum(f.gain_ft) && [HIGH_FT, MODERATE_FT, -MODERATE_FT, -HIGH_FT].some(function (b) { return Math.abs(f.gain_ft - b) <= Math.max(band, 50); });

    return {
      schema: SCHEMA,
      game_id: String(game.game_id), season: +game.season, kickoff: game.kickoff || game.start_date || null,
      neutral_site: !!game.neutral_site,
      venue: gv ? Object.assign(venueView(gv, locatedBy), { class: venueClass(gv.elev_ft) }) : null,
      home: home, away: away,
      focus: focus,
      exposure: { class: cls, label: EXPOSURE[cls], team: f.team, gain_ft: f.gain_ft,
        bucket: f.bucket, bucket_text: f.bucket ? BUCKET_TEXT[f.bucket] : null, near_bucket_edge: nearEdge },
      rest_diff: (isNum(home.rest_days) && isNum(away.rest_days)) ? Math.min(home.rest_days, 21) - Math.min(away.rest_days, 21) : null,
      quality: { usable: usable, reasons: reasons },
      missing: missing
    };
  }

  /* ----------------------------------------------------------- features
     Every feature is HOME-MARGIN signed: (what the visitor faces) minus (what
     the home team faces), so a positive value is a burden on the visitor. At
     a true home game the home team is at its own venue and its terms are ~0. */
  function sideFeat(s) {
    var g = s && isNum(s.gain_ft) ? s.gain_ft : null;
    if (g == null) return null;
    var pos = Math.max(0, g);
    return {
      gain_pos_k: pos / 1000,
      spline_0_1000: Math.min(pos, 1000) / 1000,
      spline_1000_3000: Math.min(Math.max(pos - 1000, 0), 2000) / 1000,
      spline_3000_plus: Math.max(pos - 3000, 0) / 1000,
      moderate_gain: (g >= MODERATE_FT && g < HIGH_FT) ? 1 : 0,
      high_gain: g >= HIGH_FT ? 1 : 0,
      descent_1000: g <= -MODERATE_FT ? 1 : 0,
      ratio_ge6: s.ratio_ge6 ? 1 : 0,
      resident_high: s.acclimatization && s.acclimatization.resident_high ? 1 : 0,
      recent_high: s.acclimatization && s.acclimatization.recent_high_exposure ? 1 : 0
    };
  }
  function features(ctx, extra) {
    if (!ctx || !ctx.quality || !ctx.quality.usable) return null;
    var a = sideFeat(ctx.away), h = sideFeat(ctx.home);
    if (!a || !h) return null;
    var x = {};
    Object.keys(a).forEach(function (k) { if (k !== 'resident_high' && k !== 'recent_high') x[k] = a[k] - h[k]; });
    /* interactions, defined on the visitor (the side a true home game is about) */
    x.high_gain_x_resident_high = a.high_gain * a.resident_high;
    x.high_gain_x_recent_high = a.high_gain * a.recent_high;
    extra = extra || {};
    x.high_gain_x_total_c = isNum(extra.total_c) ? a.high_gain * extra.total_c : null;
    x.high_gain_x_def_load_c = isNum(extra.def_load_c) ? a.high_gain * extra.def_load_c : null;
    x.high_gain_x_opp_pace_c = isNum(extra.opp_pace_c) ? a.high_gain * extra.opp_pace_c : null;
    /* the main effects the two play-count interactions must be read against:
       without them an interaction is free to absorb a general play-load or
       pace effect that has nothing to do with altitude */
    x.def_load_c = isNum(extra.def_load_c) ? extra.def_load_c : null;
    x.opp_pace_c = isNum(extra.opp_pace_c) ? extra.opp_pace_c : null;
    /* travel, as CONTROLS for a diagnostic only: V1's travel layer was
       rejected, and these never price */
    var da = ctx.away.distance_mi, dh = ctx.home.distance_mi;
    x.log_distance = (isNum(da) && isNum(dh)) ? Math.log(1 + da) - Math.log(1 + dh) : null;
    var ta = ctx.away.tz_change_h, th = ctx.home.tz_change_h;
    x.abs_tz = (isNum(ta) && isNum(th)) ? Math.abs(ta) - Math.abs(th) : null;
    return x;
  }

  /* --------------------------------------------------------- candidates
     Pre-registered BEFORE any fit: the research harness fits exactly these and
     nothing else, so the winner cannot be chosen from a larger search than the
     report admits. `eligible:false` marks the diagnostics that are measured
     and reported but can never price. */
  var CANDIDATES = {
    linear_gain:     { label: 'continuous: points per 1,000 ft of positive gain', features: ['gain_pos_k'], eligible: true },
    piecewise:       { label: 'piecewise linear, knots at 1,000 and 3,000 ft', features: ['spline_0_1000', 'spline_1000_3000', 'spline_3000_plus'], eligible: true },
    cat_3000:        { label: 'categorical: gain of 3,000 ft or more', features: ['high_gain'], eligible: true },
    buckets:         { label: 'categorical: 1,000-2,999 and 3,000+ ft (the research package specification)', features: ['moderate_gain', 'high_gain'], eligible: true },
    cat_3000_acclim: { label: '3,000+ ft, with a visitor that lives at altitude', features: ['high_gain', 'high_gain_x_resident_high'], eligible: true },
    cat_3000_recent: { label: '3,000+ ft, with a visitor whose previous game was at altitude', features: ['high_gain', 'high_gain_x_recent_high'], eligible: true },
    cat_3000_pace:   { label: '3,000+ ft x V1\u2019s pregame expected total (a scoring-pace proxy available live)', features: ['high_gain', 'high_gain_x_total_c'], eligible: true },
    cat_3000_load:   { label: '3,000+ ft x visitor defence plays faced per game, season to date', features: ['high_gain', 'def_load_c', 'high_gain_x_def_load_c'], eligible: false,
                       why_ineligible: 'play counts exist only through 2021 in the research package, so no live pregame input exists to price it' },
    cat_3000_opp_pace: { label: '3,000+ ft x home offence plays per game, season to date (opponent pace)', features: ['high_gain', 'opp_pace_c', 'high_gain_x_opp_pace_c'], eligible: false,
                       why_ineligible: 'play counts exist only through 2021 in the research package, so no live pregame input exists to price it' },
    cat_3000_travel: { label: 'DIAGNOSTIC: 3,000+ ft with travel distance and time-zone change as controls', features: ['high_gain', 'log_distance', 'abs_tz'], eligible: false,
                       why_ineligible: 'a diagnostic: it asks whether the altitude term survives travel controls; travel itself was rejected by V1\u2019s validation and never prices' },
    ratio6:          { label: 'DESCRIPTIVE: game elevation at least 6x the visitor’s normal elevation', features: ['ratio_ge6'], eligible: false,
                       why_ineligible: 'the ratio is descriptive research only: a sea-level visitor reaches 6x at a 60 ft venue' },
    placebo_descent: { label: 'PLACEBO: visitor plays 1,000 ft or more BELOW normal', features: ['descent_1000'], eligible: false,
                       why_ineligible: 'a placebo: altitude physiology predicts no visitor penalty for a descent' }
  };

  function linear(x, coef) {
    var s = 0, k;
    for (k in coef) if (Object.prototype.hasOwnProperty.call(coef, k)) {
      if (!isNum(x[k])) return null;
      s += coef[k] * x[k];
    }
    return s;
  }

  /* ----------------------------------------------------------- adjustment
     THREE LOCKS, ALL REQUIRED BEFORE A POINT MOVES:
       1 params.status === 'VALIDATED' — the promotion gates passed
       2 params.points_applied === true — the research run that passed them
         wrote it, nobody typed it
       3 opts.flag_enabled === true — a person turned
         cfb_altitude_adjustment_enabled on, with evidence
     Otherwise the shadow number is computed, published as SHADOW, and the
     applied number is exactly zero. */
  function adjustment(ctx, params, opts) {
    opts = opts || {};
    var P = params || null;
    var base = { model: null, shadow_points: null, applied_points: 0, applied: false, status: 'UNAVAILABLE', reason: null,
      model_version: P ? P.model_version || null : null };
    if (!ctx) { base.reason = 'no altitude context'; return base; }
    if (ctx.neutral_site) {
      base.status = 'NOT_APPLICABLE';
      base.reason = 'neutral site: the adjustment was fitted on true home games only, and no neutral-site effect was estimated';
      return base;
    }
    if (!ctx.quality.usable) { base.reason = ctx.quality.reasons.join('; ') || 'inputs unavailable'; return base; }
    var cand = P && P.shadow_candidate ? P.shadow_candidate : null;
    if (!cand || !cand.coefficients) {
      base.status = 'SHADOW'; base.shadow_points = 0;
      base.reason = 'no candidate has been fitted; the shadow adjustment is zero';
      return base;
    }
    var x = features(ctx, opts.extra);
    var s = x ? linear(x, cand.coefficients) : null;
    if (!isNum(s)) { base.reason = 'a feature the candidate needs is unavailable for this game'; return base; }
    var cap = P && isNum(P.cap_points) ? P.cap_points : 3;
    s = Math.max(-cap, Math.min(cap, s));
    base.model = cand.id;
    base.shadow_points = r2(s);
    var locks = { validated: P.status === 'VALIDATED', points_applied: P.points_applied === true, flag_enabled: opts.flag_enabled === true };
    base.locks = locks;
    if (locks.validated && locks.points_applied && locks.flag_enabled) {
      base.applied = true; base.applied_points = r2(s); base.status = 'APPLIED';
      base.reason = 'validated by the promotion gates and enabled by the server flag';
    } else {
      base.status = 'SHADOW';
      base.reason = !locks.validated
        ? 'research only: the altitude adjustment has not passed its validation gates (' + (P.status || 'not validated') + ')'
        : (!locks.points_applied ? 'research only: the validated parameters do not enable points'
          : 'research only: the server flag cfb_altitude_adjustment_enabled is off');
    }
    return base;
  }

  /* ---------------------------------------------------- the fan's words
     Built from the context, the adjustment and the validation summary. Every
     sentence states a measured number or the record's verdict; none of them
     describes how the game will be played. */
  function support(params) {
    var v = params && params.validation ? params.validation : null;
    if (!v) return { state: 'NOT_ESTABLISHED', text: 'Not established: no validation record is loaded.' };
    var st = v.support_state || 'NOT_ESTABLISHED';
    return { state: st, text: v.support_text || 'Not established.' };
  }
  function explain(ctx, adj, params) {
    if (!ctx) return null;
    var sup = support(params);
    var f = ctx.focus === 'home' ? ctx.home : ctx.away;
    var other = ctx.focus === 'home' ? ctx.away : ctx.home;
    var lines = [];
    var headline;
    if (!ctx.venue) headline = 'Venue elevation unavailable';
    else headline = ctx.exposure.label;
    if (ctx.venue && isNum(f.gain_ft)) {
      if (f.gain_ft >= MODERATE_FT) {
        lines.push(f.team + ' normally plays at ' + fmtFt(f.usual_elev_ft) + ' and this game is at '
          + fmtFt(ctx.venue.elev_ft) + ' — ' + fmtFt(f.gain_ft) + ' higher.');
        lines.push(ctx.exposure.class === 'HIGH'
          ? 'Historical studies of college football find a possible disadvantage for visitors climbing this far, but its size for any one game is uncertain.'
          : 'This is a moderate climb; the historical record does not separate an effect of this size from noise.');
      } else if (f.gain_ft <= -MODERATE_FT) {
        lines.push(f.team + ' plays ' + fmtFt(-f.gain_ft) + ' below its normal ' + fmtFt(f.usual_elev_ft) + ' home elevation.');
        lines.push('Playing lower than normal is not an altitude disadvantage, and EdgeDesk applies nothing for it.');
      } else {
        lines.push('Neither team changes elevation materially: ' + f.team + ' is within 1,000 ft of its normal ' + fmtFt(f.usual_elev_ft) + '.');
      }
    }
    if (isNum(f.distance_mi)) {
      lines.push(f.team + ' travels about ' + Math.round(f.distance_mi).toLocaleString('en-US') + ' miles'
        + (isNum(f.tz_change_h) && f.tz_change_h !== 0 ? ' and crosses ' + Math.abs(f.tz_change_h) + ' time zone' + (Math.abs(f.tz_change_h) === 1 ? '' : 's') : '') + '.');
    }
    if (f.acclimatization && f.acclimatization.resident_high) lines.push(f.team + ' plays its own home games above 3,000 ft.');
    else if (f.acclimatization && f.acclimatization.recent_high_exposure) lines.push(f.team + '’s previous game was also played above 3,000 ft.');
    var model;
    if (!adj || adj.status === 'UNAVAILABLE') model = { label: 'Unavailable', text: 'Not computed: ' + ((adj && adj.reason) || 'inputs unavailable') + '.' };
    else if (adj.status === 'NOT_APPLICABLE') model = { label: 'Not applicable', text: 'Neutral site — no altitude adjustment is modelled.' };
    else if (adj.applied) model = { label: (adj.applied_points >= 0 ? '+' : '') + adj.applied_points.toFixed(1) + ' pts', text: 'Validated adjustment applied to EdgeDesk’s number.' };
    else model = { label: 'Research only', text: '0.0 pts applied to EdgeDesk’s number, pending validation.' };
    return {
      headline: headline,
      interpretation: lines,
      statistical_support: sup,
      model_adjustment: model,
      fair_line_impact_pts: adj && adj.applied ? adj.applied_points : 0,
      provenance: provenance(ctx),
      not_claimed: 'EdgeDesk does not claim altitude causes missed tackles, penalties, turnovers or late-game collapses; none of those has been validated.',
      other_team: other.team
    };
  }
  function provenance(ctx) {
    var out = [];
    if (ctx.venue) out.push(ctx.venue.name + ': ' + fmtFt(ctx.venue.elev_ft) + ' (' + ctx.venue.confidence + ' confidence; ' + ctx.venue.basis + ')');
    ['home', 'away'].forEach(function (k) {
      var s = ctx[k];
      if (s.usual_venue && isNum(s.usual_venue.elev_ft) && (!ctx.venue || s.usual_venue.venue_id !== ctx.venue.venue_id))
        out.push(s.team + ' normal venue ' + s.usual_venue.name + ': ' + fmtFt(s.usual_venue.elev_ft) + ' (' + s.usual_venue.basis_venue + ')');
    });
    return out;
  }

  /* --------------------------------------------- the published section
     The compact object the slate row, the research page and the desk read.
     Rounded for display; units always feet. */
  function publish(ctx, adj, params) {
    if (!ctx) return null;
    var f = ctx.focus === 'home' ? ctx.home : ctx.away;
    var ex = explain(ctx, adj, params);
    function sideOut(s) {
      return { team: s.team, usual_elev_ft: s.usual_elev_ft,
        usual_venue: s.usual_venue ? { venue_id: s.usual_venue.venue_id, name: s.usual_venue.name || null } : null,
        gain_ft: s.gain_ft, direction: s.direction, bucket: s.bucket,
        distance_mi: s.distance_mi, tz_change_h: s.tz_change_h, rest_days: s.rest_days,
        resident_high: s.acclimatization.resident_high, recent_high_exposure: s.acclimatization.recent_high_exposure,
        ratio: s.ratio, ratio_ge6: s.ratio_ge6 };
    }
    return {
      schema: 'edgedesk_cfb_altitude_section_v1',
      game_id: ctx.game_id,
      neutral_site: ctx.neutral_site,
      venue: ctx.venue ? { venue_id: ctx.venue.venue_id, name: ctx.venue.name, elev_ft: ctx.venue.elev_ft,
        class: ctx.venue.class, confidence: ctx.venue.confidence, source: ctx.venue.source, located_by: ctx.venue.located_by } : null,
      home: sideOut(ctx.home), away: sideOut(ctx.away),
      focus: ctx.focus,
      exposure: { class: ctx.exposure.class, label: ctx.exposure.label, team: f.team, gain_ft: f.gain_ft,
        bucket_text: ctx.exposure.bucket_text, near_bucket_edge: ctx.exposure.near_bucket_edge },
      adjustment: adj ? { status: adj.status, model: adj.model, shadow_points: adj.shadow_points,
        applied_points: adj.applied_points, applied: adj.applied, reason: adj.reason, model_version: adj.model_version,
        locks: adj.locks || null, params_status: params && params.status ? params.status : 'NONE' } : null,
      statistical_support: ex.statistical_support,
      model_adjustment: ex.model_adjustment,
      fair_line_impact_pts: ex.fair_line_impact_pts,
      interpretation: ex.interpretation,
      provenance: ex.provenance,
      not_claimed: ex.not_claimed,
      quality: ctx.quality,
      missing: ctx.missing
    };
  }

  /* ------------------------------------------------------- the desk
     What Ask EdgeDesk may say about altitude: the section's own numbers and
     verdicts, as facts, and nothing it does not carry. */
  function deskFacts(section) {
    if (!section) return null;
    var f = section.focus === 'home' ? section.home : section.away;
    var facts = [];
    if (section.venue) facts.push({ key: 'game_elevation_ft', value: section.venue.elev_ft, text: section.venue.name + ' sits at ' + fmtFt(section.venue.elev_ft) + '.' });
    if (isNum(section.home.usual_elev_ft)) facts.push({ key: 'home_normal_elevation_ft', value: section.home.usual_elev_ft, text: section.home.team + ' normally plays at ' + fmtFt(section.home.usual_elev_ft) + '.' });
    if (isNum(section.away.usual_elev_ft)) facts.push({ key: 'away_normal_elevation_ft', value: section.away.usual_elev_ft, text: section.away.team + ' normally plays at ' + fmtFt(section.away.usual_elev_ft) + '.' });
    if (isNum(f.gain_ft)) facts.push({ key: 'elevation_gain_ft', value: f.gain_ft, text: f.team + '’s elevation change for this game is ' + signedFt(f.gain_ft) + '.' });
    if (isNum(f.distance_mi)) facts.push({ key: 'travel_miles', value: f.distance_mi, text: f.team + ' travels about ' + f.distance_mi + ' miles.' });
    if (isNum(f.tz_change_h)) facts.push({ key: 'time_zone_change_h', value: f.tz_change_h, text: f.team + '’s time-zone change is ' + f.tz_change_h + ' h.' });
    facts.push({ key: 'altitude_exposure', value: section.exposure.class, text: section.exposure.label + '.' });
    facts.push({ key: 'altitude_support', value: section.statistical_support.state, text: 'Statistical support: ' + section.statistical_support.text });
    facts.push({ key: 'altitude_points_applied', value: section.fair_line_impact_pts, text: 'Altitude points applied to EdgeDesk’s number: ' + (section.fair_line_impact_pts || 0).toFixed(1) + '.' });
    return { facts: facts, not_claimed: section.not_claimed,
      travel_text: isNum(f.distance_mi) ? f.team + ' travels about ' + f.distance_mi + ' miles' + (isNum(f.tz_change_h) && f.tz_change_h !== 0 ? ' and crosses ' + Math.abs(f.tz_change_h) + ' time zone(s)' : '') + '; travel moves 0 points.' : null,
      altitude_text: section.venue ? section.exposure.label + ': ' + (isNum(f.gain_ft) ? signedFt(f.gain_ft) + ' for ' + f.team : 'gain unavailable') + '. ' + section.model_adjustment.text : null };
  }

  return {
    SCHEMA: SCHEMA, FT_PER_M: FT_PER_M, HIGH_FT: HIGH_FT, MODERATE_FT: MODERATE_FT, RECENT_DAYS: RECENT_DAYS,
    CANDIDATES: CANDIDATES, BUCKET_TEXT: BUCKET_TEXT, EXPOSURE: EXPOSURE,
    gainBucket: gainBucket, direction: direction, venueClass: venueClass,
    tzOffsetAt: tzOffsetAt, haversineMi: haversineMi,
    teamIndex: teamIndex, usualVenue: usualVenue, context: context,
    features: features, linear: linear, adjustment: adjustment,
    explain: explain, publish: publish, deskFacts: deskFacts, support: support
  };
});
