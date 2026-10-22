/* ===========================================================================
   EdgeDesk GAME CONTEXT — the game conditions a projection does not see on
   its own: who is refereeing and how many flags that crew throws, how far
   and across how many time zones each team travels, and how rested each
   team is. Every number is observed (counted from play-by-play, measured
   between stadium coordinates, read from the schedule), never fitted.
   Browser: window.EDGameContext. Node: require('./edgedesk_game_context.js').

   WHAT IT BUILDS (pure functions; tools/football/game_context.js reads the files)
     travel(x)        miles, time zones crossed, the body-clock kickoff and
                      rest for both teams, and which side the conditions favour
     officials(x)     the assigned referee's flags per game this season and
                      over three seasons, against the league, with his rank,
                      his crew's over/under record and the measured over rate
                      of games worked by crews in the same flag tier
     cfbCrew(x)       college: the assigned referee when one is on record,
                      otherwise the home conference's crews (college crews
                      work inside their own conference)

   THE RULES
     * A missing input gives a null, never an estimate.
     * A referee's tier comes from his three-season flag rate among referees
       with at least MIN_REF_GAMES games; the tier's over rate is the share
       of lined, non-push games those referees worked that went over.
     * The over/under lines here are nflverse's consensus closing lines: a
       record, not a price.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDGameContext = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var GC = { VERSION: 'edgedesk_game_context/1' };
  GC.MIN_REF_GAMES = 16;
  /* a trip is worth a note from this many miles, or any time-zone change */
  GC.FAR_MILES = 1000;
  /* a rest edge is worth a note from this many days */
  GC.REST_EDGE_DAYS = 3;

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function possessive(n) { n = String(n || ''); return /s$/i.test(n) ? n + '’' : n + '’s'; }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }

  /* ================================================================ TRAVEL */
  GC.miles = function (lat1, lon1, lat2, lon2) {
    lat1 = num(lat1); lon1 = num(lon1); lat2 = num(lat2); lon2 = num(lon2);
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    var R = 3958.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
  };
  /* the UTC offset of an IANA zone at an instant, in hours (null without Intl) */
  GC.utcOffset = function (tz, iso) {
    var t = Date.parse(iso);
    if (!tz || !isFinite(t) || typeof Intl === 'undefined') return null;
    try {
      var p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
      var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
      return Math.round((asUtc - Math.floor(t / 60000) * 60000) / 36e5 * 4) / 4;
    } catch (_) { return null; }
  };
  /* "9:15 PM" in a zone */
  GC.clockIn = function (tz, iso) {
    var t = Date.parse(iso);
    if (!tz || !isFinite(t) || typeof Intl === 'undefined') return null;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t)); } catch (_) { return null; }
  };
  function hourIn(tz, iso) {
    try {
      var h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false, hourCycle: 'h23' }).format(new Date(Date.parse(iso)));
      return num(h) == null ? null : num(h) % 24;
    } catch (_) { return null; }
  }
  /* x: { kickoff, neutral_site, venue: { name, lat, lon, tz_name },
          home: { abbr, name, base: { lat, lon, tz_name }, rest },
          away: { abbr, name, base: { lat, lon, tz_name }, rest } }
     → null without the venue, else { home, away, rest_diff, favors, material,
       strength, title, short, text } */
  GC.travel = function (x) {
    if (!x || !x.venue || num(x.venue.lat) == null) return null;
    var V = x.venue, out = { venue: V.name || null, neutral_site: !!x.neutral_site, international: x.international || null };
    function leg(t, isHome) {
      if (!t) return null;
      var b = t.base || null, rest = num(t.rest);
      var miles = b ? GC.miles(b.lat, b.lon, V.lat, V.lon) : null;
      if (isHome && !x.neutral_site && miles != null && miles < 60) miles = 0;
      var tzc = null, body = null, bodyHour = null;
      if (b && b.tz_name && V.tz_name) {
        var ov = GC.utcOffset(V.tz_name, x.kickoff), oh = GC.utcOffset(b.tz_name, x.kickoff);
        tzc = ov != null && oh != null ? ov - oh : null;
        body = GC.clockIn(b.tz_name, x.kickoff); bodyHour = hourIn(b.tz_name, x.kickoff);
      }
      return { abbr: t.abbr || null, name: t.name || null, miles: miles, tz_change_h: tzc,
        direction: tzc == null || tzc === 0 ? 'none' : (tzc > 0 ? 'east' : 'west'),
        body_clock: body, body_hour: bodyHour, local_clock: V.tz_name ? GC.clockIn(V.tz_name, x.kickoff) : null, rest_days: rest };
    }
    out.home = leg(x.home, true); out.away = leg(x.away, false);
    return GC.travelSummary(out);
  };
  /* the words and the side, from two legs already measured ({ abbr, name,
     miles, tz_change_h, direction, body_clock, body_hour, rest_days }); the
     college slate measures its own legs (football/altitude) */
  GC.travelSummary = function (out) {
    if (!out || (!out.home && !out.away)) return null;
    var H = out.home || {}, A = out.away || {};
    out.rest_diff = H.rest_days != null && A.rest_days != null ? H.rest_days - A.rest_days : null;
    /* a burden score per side: distance, zones crossed, an early or late body clock, less rest */
    function burden(s, oppRest) {
      if (!s) return 0;
      var b = 0;
      if (s.miles != null) b += Math.min(s.miles, 3000) / 3000 * 0.5;
      if (s.tz_change_h != null) b += Math.min(Math.abs(s.tz_change_h), 3) * 0.12;
      if (s.body_hour != null && (s.body_hour <= 10 || s.body_hour >= 23)) b += 0.15;
      if (s.rest_days != null && oppRest != null && oppRest - s.rest_days >= GC.REST_EDGE_DAYS) b += 0.25;
      return b;
    }
    var bh = burden(out.home, A.rest_days), ba = burden(out.away, H.rest_days), d = ba - bh;
    out.favors = Math.abs(d) < 0.05 ? null : (d > 0 ? 'home' : 'away');
    var tough = d > 0 ? out.away : out.home;
    function odd(x) { return x && x.body_hour != null && (x.body_hour <= 10 || x.body_hour >= 23); }
    var far = (tough && tough.miles != null && tough.miles >= GC.FAR_MILES) || (tough && tough.tz_change_h != null && Math.abs(tough.tz_change_h) >= 2);
    var restEdge = out.rest_diff != null && Math.abs(out.rest_diff) >= GC.REST_EDGE_DAYS;
    out.material = !!(far || restEdge || odd(tough));
    out.strength = r2(Math.min(1, Math.abs(d)));
    if (Math.abs(d) < 0.15) out.favors = null;
    function say(full) {
      function nm(x) { return full ? (x.name || x.abbr) : (x.abbr || x.name); }
      function clock(x) { return odd(x) && x.body_clock ? 'kickoff is ' + x.body_clock + ' on ' + possessive(nm(x)) + ' body clock' : null; }
      var parts = [];
      if (out.international || (out.neutral_site && H.miles && A.miles)) {
        parts.push((out.international ? 'Played in ' + out.international : 'Neutral site') + ': ' + nm(A) + ' ' + A.miles.toLocaleString('en-US') + ' mi' + zones(A) + ', ' + nm(H) + ' ' + H.miles.toLocaleString('en-US') + ' mi' + zones(H));
        [A, H].forEach(function (x) { var c = clock(x); if (c) parts.push(c); });
      } else {
        /* the travelling side's trip */
        var who = tough && tough.miles ? tough : (A.miles ? A : null);
        if (who && who.miles != null) {
          parts.push(nm(who) + ' travels ' + who.miles.toLocaleString('en-US') + ' mi' + zones(who));
          var c1 = clock(who); if (c1) parts.push(c1);
        }
      }
      if (H.rest_days != null && A.rest_days != null) {
        parts.push(out.rest_diff === 0 ? (H.rest_days <= 5 ? 'both on a short week (' + H.rest_days + ' days)' : 'both on ' + H.rest_days + ' days’ rest')
          : (out.rest_diff > 0 ? nm(H) : nm(A)) + ' has ' + Math.abs(out.rest_diff) + ' more day' + (Math.abs(out.rest_diff) === 1 ? '' : 's') + ' of rest (' + (A.abbr || A.name) + ' ' + A.rest_days + ', ' + (H.abbr || H.name) + ' ' + H.rest_days + ')');
      }
      return parts.length ? parts.join('; ').replace(/^./, function (ch) { return ch.toUpperCase(); }) + '.' : null;
    }
    function zones(x) { return x.tz_change_h ? ', ' + Math.abs(x.tz_change_h) + ' time zone' + (Math.abs(x.tz_change_h) === 1 ? '' : 's') + ' ' + x.direction : ''; }
    var parts = say(false) ? [say(false)] : [];
    if (!parts.length) return null;
    out.title = restEdge && !far ? 'REST EDGE' : (far || odd(tough) ? 'TRAVEL EDGE' : 'TRAVEL & REST');
    out.short = parts[0];
    out.text = say(true) + (out.favors && out.material ? ' The travel and rest picture favours ' + (out.favors === 'home' ? (H.name || H.abbr) : (A.name || A.abbr)) + '.' : '');
    return out;
  };

  /* ================================================================ OFFICIALS
     rows: one per game (data/refs/ref_game_penalties.csv): referee, season,
     gameday, flags, total, total_line. Returns the league table once, so a
     slate of games reads it without re-counting. */
  GC.refTable = function (rows, opts) {
    opts = opts || {};
    var season = num(opts.season), by = {}, lg = { season: [], all: [] };
    (rows || []).forEach(function (r) {
      var f = num(r.flags), ref = r.referee;
      if (!ref || f == null) return;
      var s = num(r.season), t = num(r.total), l = num(r.total_line);
      var e = by[ref] = by[ref] || { referee: ref, all: [], season: [], ou: { overs: 0, unders: 0, pushes: 0, vs_line: [] } };
      e.all.push(f); lg.all.push(f);
      if (season != null && s === season) { e.season.push(f); lg.season.push(f); }
      if (t != null && l != null) {
        if (t > l) e.ou.overs++; else if (t < l) e.ou.unders++; else e.ou.pushes++;
        e.ou.vs_line.push(t - l);
      }
    });
    var lgAll = mean(lg.all), lgSeason = mean(lg.season);
    var refs = Object.keys(by).map(function (k) {
      var e = by[k];
      return { referee: k, games: e.all.length, flags_pg: mean(e.all), season_games: e.season.length, season_flags_pg: mean(e.season),
        overs: e.ou.overs, unders: e.ou.unders, pushes: e.ou.pushes, avg_vs_line: mean(e.ou.vs_line) };
    });
    var ranked = refs.filter(function (r) { return r.games >= GC.MIN_REF_GAMES; }).sort(function (a, b) { return b.flags_pg - a.flags_pg || (a.referee < b.referee ? -1 : 1); });
    var sRanked = refs.filter(function (r) { return r.season_games >= 3; }).sort(function (a, b) { return b.season_flags_pg - a.season_flags_pg || (a.referee < b.referee ? -1 : 1); });
    ranked.forEach(function (r, i) { r.rank = i + 1; r.tier = i < ranked.length / 3 ? 'high' : (i >= ranked.length * 2 / 3 ? 'low' : 'mid'); });
    sRanked.forEach(function (r, i) { r.season_rank = i + 1; });
    /* each tier's measured over rate: the lined, non-push games its referees worked */
    var tiers = {};
    ['high', 'mid', 'low'].forEach(function (t) {
      var o = 0, u = 0, v = [];
      ranked.filter(function (r) { return r.tier === t; }).forEach(function (r) { o += r.overs; u += r.unders; if (r.avg_vs_line != null) v.push(r.avg_vs_line * (r.overs + r.unders + r.pushes)); });
      tiers[t] = { games: o + u, overs: o, unders: u, over_pct: o + u ? r1(o / (o + u) * 100) : null };
    });
    var map = {};
    refs.forEach(function (r) { map[r.referee] = r; });
    return { refs: map, ranked: ranked.length, season_ranked: sRanked.length, league_flags_pg: r2(lgAll), season_league_flags_pg: r2(lgSeason), season: season, tiers: tiers,
      window: opts.window || null };
  };
  /* one game's officiating block from the table: null when no referee is assigned */
  GC.officials = function (referee, table, opts) {
    opts = opts || {};
    if (!referee || !table) return null;
    var r = table.refs[referee] || null;
    var out = { referee: referee, source: opts.source || null, league: 'nfl', window: table.window };
    if (!r) { out.known = false; out.short = referee + ' (no officiating history on file)'; return out; }
    out.known = true;
    out.games = r.games; out.flags_pg = r2(r.flags_pg); out.league_flags_pg = table.league_flags_pg;
    out.vs_league = r2(r.flags_pg - table.league_flags_pg);
    out.rank = r.rank || null; out.of = table.ranked; out.tier = r.tier || null;
    out.season_games = r.season_games; out.season_flags_pg = r2(r.season_flags_pg); out.season_league_flags_pg = table.season_league_flags_pg;
    out.season_vs_league = r.season_flags_pg != null && table.season_league_flags_pg != null ? r2(r.season_flags_pg - table.season_league_flags_pg) : null;
    out.season_rank = r.season_rank || null; out.season_of = table.season_ranked;
    out.ou = { overs: r.overs, unders: r.unders, pushes: r.pushes, avg_vs_line: r2(r.avg_vs_line) };
    var T = r.tier ? table.tiers[r.tier] : null;
    out.tier_over = T && T.over_pct != null ? { over_pct: T.over_pct, games: T.games } : null;
    out.lean = T && T.over_pct != null && Math.abs(T.over_pct - 50) >= 3 ? (T.over_pct > 50 ? 'over' : 'under') : null;
    var tierWord = r.tier === 'high' ? 'flag-heavy' : (r.tier === 'low' ? 'low-flag' : 'middle-of-the-pack');
    out.title = 'REF: ' + referee.toUpperCase();
    var place = !out.rank ? '' : (out.rank === 1 ? ', most in the league' : (out.rank === out.of ? ', fewest in the league' : ', #' + out.rank + ' of ' + out.of + ' crews'));
    var vs = Math.abs(out.vs_league) < 0.05 ? 'even with the league' : (out.vs_league > 0 ? '+' : '−') + Math.abs(out.vs_league).toFixed(1) + ' vs league';
    out.short = referee + ' crew: ' + out.flags_pg.toFixed(1) + ' flags/g' + place + ' (' + vs + '); his games ' + r.overs + '-' + r.unders + (r.pushes ? '-' + r.pushes : '') + ' O/U.';
    out.text = out.short + (T && T.over_pct != null ? ' Games under ' + tierWord + ' crews went over ' + Math.round(T.over_pct) + '% (' + T.games + ' games since 2024).' : '');
    out.strength = r2(Math.min(0.6, 0.25 + Math.abs(out.vs_league) / 6 + (out.lean ? 0.05 : 0)));
    return out;
  };
  /* college: the assigned referee's line when one is on record (rows from
     data/refs/cfb/cfb_ref_summary.csv, window '3yr' or a season), else the
     home conference's crews this season against all FBS crews
     (data/refs/cfb/cfb_conference_baselines.csv) */
  GC.cfbCrew = function (x) {
    if (!x) return null;
    var conf = x.conference || null, base = x.baselines || [], season = num(x.season);
    var rows = base.filter(function (b) { return num(b.season) === season && num(b.games) >= 5; });
    var all = rows.reduce(function (a, b) { return { g: a.g + num(b.games), f: a.f + num(b.games) * num(b.flags_pg) }; }, { g: 0, f: 0 });
    var fbs = all.g ? all.f / all.g : null;
    var ref = x.referee || null;
    if (ref && num(ref.flags_pg) != null) {
      var v = fbs != null ? r2(num(ref.flags_pg) - fbs) : null;
      return { league: 'cfb', referee: ref.referee, source: ref.source || 'assignment on record', known: true, games: num(ref.games), flags_pg: r2(num(ref.flags_pg)),
        vs_league: v, league_flags_pg: r2(fbs), conference: conf, title: 'REF: ' + String(ref.referee).toUpperCase(),
        short: ref.referee + ' crew: ' + num(ref.flags_pg).toFixed(1) + ' flags/g' + (v != null ? ', ' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' vs FBS crews' : '') + ' (' + num(ref.games) + ' games).',
        text: ref.referee + ' crew averages ' + num(ref.flags_pg).toFixed(1) + ' flags a game over ' + num(ref.games) + ' games' + (v != null ? ' (' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + ' against FBS crews)' : '') + '.',
        strength: v != null ? r2(Math.min(0.5, 0.2 + Math.abs(v) / 6)) : 0.2 };
    }
    var c = rows.filter(function (b) { return b.home_conference === conf; })[0];
    if (!c || fbs == null) return null;
    var vc = r2(num(c.flags_pg) - fbs), rankList = rows.slice().sort(function (a, b) { return num(b.flags_pg) - num(a.flags_pg); });
    var rank = rankList.indexOf(c) + 1;
    return { league: 'cfb', referee: null, source: 'home-conference crews', known: false, conference: conf, games: num(c.games), flags_pg: r2(num(c.flags_pg)),
      vs_league: vc, league_flags_pg: r2(fbs), rank: rank, of: rankList.length, title: 'OFFICIATING',
      short: conf + ' crews: ' + num(c.flags_pg).toFixed(1) + ' flags/g in ' + season + ', ' + (vc >= 0 ? '+' : '−') + Math.abs(vc).toFixed(1) + ' vs FBS (#' + rank + ' of ' + rankList.length + ' most).',
      text: 'The crew comes from the ' + conf + ': its crews average ' + num(c.flags_pg).toFixed(1) + ' flags a game this season (' + (vc >= 0 ? '+' : '−') + Math.abs(vc).toFixed(1) + ' against all FBS crews, ' + num(c.games) + ' games). The individual referee is not announced yet.',
      strength: r2(Math.min(0.45, 0.12 + Math.abs(vc) / 6)) };
  };
  return GC;
});
