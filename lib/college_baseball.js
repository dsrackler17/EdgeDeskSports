/* ===========================================================================
   COLLEGE BASEBALL — the query layer over cbb.

   ONE SOURCE OF TRUTH, AND IT IS THE GAME LOG. cbb.games is a union of the
   day scoreboard and every team's own schedule, because measurement showed
   neither is complete alone. Everything a club's page says about it — record,
   runs, home and away form, streak — is folded out of that same log inside
   the database, so a number here cannot disagree with the games listed under
   it.

   WHAT THIS LAYER REFUSES TO DO:

     - It will not publish a projection, a fair line, a win probability or an
       edge. EdgeDesk has no validated college baseball model and no
       walk-forward record for one anywhere in this repository. Pythagorean
       expectation is carried because it is a plain statement about runs
       already scored; it is labelled as descriptive and never priced.
     - It will not claim a starting pitcher. College programmes rarely post
       one, the source does not carry it, and a brief that guessed would be
       guessing the largest single input in a baseball number.
     - It will not present a partial card as a whole one. Every game carries
       which sources saw it, and a board says when its window is outside the
       season rather than rendering empty and looking broken.
     - It will not treat an absent record as a zero. A team with no games has
       no runs per game — not 0.00.

   THE SEASON. College baseball runs February to June, so the season is the
   calendar year, and for most of the year there are legitimately no games.
   That is a fact to state, not an error to hide.
   =========================================================================== */
/*__EDCBB_START__*/
(function (root, factory) {
  var api = factory();
  root.EDCollegeBaseball = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SCHEMA = 'cbb';
  var SOURCE = 'ESPN college baseball scoreboard and team schedules, unioned';

  /* The window in which games legitimately exist. Opening weekend is the
     middle Friday of February; the College World Series ends in late June. */
  var SEASON = { first_month: 2, last_month: 6 };

  function seasonOf(dateISO) { return Number(String(dateISO).slice(0, 4)); }
  function inSeason(dateISO) {
    var m = Number(String(dateISO).slice(5, 7));
    return m >= SEASON.first_month && m <= SEASON.last_month;
  }

  var COLS = {
    games: 'game_id,season,game_date,start_time,start_time_tbd,'
      + 'away_team_id,home_team_id,away_name,home_name,away_abbr,home_abbr,'
      + 'venue,venue_city,venue_state,neutral_site,conference_game,'
      + 'status_state,status_detail,completed,away_score,home_score,innings,'
      + 'away_rank,home_rank,notes,seen_by',
    teamSeasons: 'season,team_id,team_name,games,wins,losses,ties,runs_for,runs_against,'
      + 'home_wins,home_losses,away_wins,away_losses,neutral_wins,neutral_losses,'
      + 'conf_wins,conf_losses,last10_wins,last10_losses,streak,'
      + 'runs_per_game,runs_allowed_per_game,run_diff_per_game,pythag_win_pct,'
      + 'scheduled_games,first_game,last_game',
    teams: 'team_id,name,short_name,abbreviation,slug,conference_id,conference_name,logo,color',
  };

  var LIMITS = { board: 400, h2h: 40, form: 25, teams: 500 };

  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function int(v) { var n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }

  function shapeGame(r) {
    if (!r) return null;
    var as = int(r.away_score), hs = int(r.home_score);
    var done = r.completed === true || r.status_state === 'post';
    return {
      game_id: String(r.game_id),
      season: int(r.season), date: r.game_date,
      start_time: r.start_time || null,
      /* a time the source never settled is said to be unknown rather than
         printed as midnight, which a reader would take for a real first pitch */
      start_time_tbd: r.start_time_tbd === true || !r.start_time,
      away: { team_id: r.away_team_id || null, name: r.away_name,
              abbr: r.away_abbr || null, score: as, rank: int(r.away_rank) },
      home: { team_id: r.home_team_id || null, name: r.home_name,
              abbr: r.home_abbr || null, score: hs, rank: int(r.home_rank) },
      venue: r.venue || null, venue_city: r.venue_city || null, venue_state: r.venue_state || null,
      neutral_site: r.neutral_site === true,
      conference_game: r.conference_game === true,
      state: r.status_state || null, status: r.status_detail || null,
      completed: done,
      /* a finished game with no score is abandoned, not a nil-nil draw */
      abandoned: done && (as === null || hs === null),
      innings: int(r.innings),
      notes: r.notes || null,
      seen_by: Array.isArray(r.seen_by) ? r.seen_by.slice() : [],
      winner: (done && as !== null && hs !== null)
        ? (hs > as ? 'home' : (as > hs ? 'away' : 'tie')) : null,
    };
  }

  function shapeTeamSeason(r) {
    if (!r) return null;
    var g = int(r.games) || 0;
    return {
      season: int(r.season), team_id: String(r.team_id), name: r.team_name,
      games: g, wins: int(r.wins) || 0, losses: int(r.losses) || 0, ties: int(r.ties) || 0,
      runs_for: int(r.runs_for) || 0, runs_against: int(r.runs_against) || 0,
      home: { wins: int(r.home_wins) || 0, losses: int(r.home_losses) || 0 },
      away: { wins: int(r.away_wins) || 0, losses: int(r.away_losses) || 0 },
      neutral: { wins: int(r.neutral_wins) || 0, losses: int(r.neutral_losses) || 0 },
      conference: { wins: int(r.conf_wins) || 0, losses: int(r.conf_losses) || 0 },
      last10: { wins: int(r.last10_wins) || 0, losses: int(r.last10_losses) || 0 },
      streak: int(r.streak) || 0,
      /* NEVER A ZERO WHEN THERE IS NO SAMPLE. A club with no completed games
         has no runs per game; printing 0.00 would say it was shut out. */
      runs_per_game: g ? num(r.runs_per_game) : null,
      runs_allowed_per_game: g ? num(r.runs_allowed_per_game) : null,
      run_diff_per_game: g ? num(r.run_diff_per_game) : null,
      pythag_win_pct: g ? num(r.pythag_win_pct) : null,
      scheduled_games: int(r.scheduled_games) || 0,
      first_game: r.first_game || null, last_game: r.last_game || null,
      win_pct: (g > 0) ? (int(r.wins) || 0) / g : null,
    };
  }

  function shapeTeam(r) {
    if (!r) return null;
    return { team_id: String(r.team_id), name: r.name, short_name: r.short_name || r.name,
      abbr: r.abbreviation || null, conference: r.conference_name || null,
      logo: r.logo || null, color: r.color || null };
  }

  function recordOf(ts) {
    if (!ts) return null;
    return ts.wins + '-' + ts.losses + (ts.ties ? '-' + ts.ties : '');
  }
  function streakText(ts) {
    if (!ts || !ts.streak) return null;
    return (ts.streak > 0 ? 'won ' : 'lost ') + Math.abs(ts.streak) + ' straight';
  }

  /* ── the service ───────────────────────────────────────────────────────── */
  function createService(opts) {
    var read = opts.read;
    var cache = {};
    function fail(code, message, extra) {
      return Object.assign({ ok: false, code: code, error: message }, extra || {});
    }
    function classify(e) {
      var m = String((e && e.message) || e || '');
      if (/abort/i.test(m)) return 'ABORTED';
      if (/40[13]/.test(m)) return 'FORBIDDEN';
      if (/does not exist|schema|relation/i.test(m)) return 'NOT_INSTALLED';
      return 'QUERY_UNAVAILABLE';
    }

    return {
      SOURCE: SOURCE, SCHEMA: SCHEMA, COLS: COLS, SEASON: SEASON,
      seasonOf: seasonOf, inSeason: inSeason,
      shapeGame: shapeGame, shapeTeamSeason: shapeTeamSeason, shapeTeam: shapeTeam,
      recordOf: recordOf, streakText: streakText,

      /* what the archive covers, and whether it is installed at all */
      status: async function (force) {
        if (!force && cache.status) return cache.status;
        try {
          var rows = await read('season_status', 'select=*');
          var s = (rows || [])[0];
          if (!s) {
            return fail('NOT_PROMOTED',
              'The college baseball archive is installed but no import has been promoted yet.');
          }
          var out = { ok: true,
            coverage: { first_season: int(s.first_season), last_season: int(s.last_season),
              seasons: s.seasons || [], promoted_at: s.promoted_at || null,
              source: s.source || SOURCE, note: s.source_note || null },
            counts: { games: int(s.games), teams: int(s.teams), team_seasons: int(s.team_seasons) } };
          cache.status = out;
          return out;
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* THE BOARD. Every game in a window, earliest first. Out of season it
         says so rather than returning an empty list that reads as an outage. */
      board: async function (q) {
        q = q || {};
        var from = q.from, through = q.through || q.from;
        if (!from) return fail('NO_WINDOW', 'A board needs a date window.');
        try {
          var rows = await read('games',
            'select=' + COLS.games
            + '&game_date=gte.' + from + '&game_date=lte.' + through
            + '&order=game_date.asc,start_time.asc&limit=' + LIMITS.board);
          var games = (rows || []).map(shapeGame).filter(Boolean);
          return { ok: true, from: from, through: through,
            in_season: inSeason(from) || inSeason(through),
            games: games,
            counts: {
              total: games.length,
              final: games.filter(function (g) { return g.completed && !g.abandoned; }).length,
              live: games.filter(function (g) { return g.state === 'in'; }).length,
              scheduled: games.filter(function (g) { return g.state === 'pre'; }).length,
              abandoned: games.filter(function (g) { return g.abandoned; }).length,
            } };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      game: async function (gameId) {
        if (!gameId) return fail('NO_GAME', 'No game id.');
        try {
          var rows = await read('games', 'select=' + COLS.games + '&game_id=eq.' + encodeURIComponent(gameId) + '&limit=1');
          var g = shapeGame((rows || [])[0]);
          return g ? { ok: true, game: g } : fail('NOT_FOUND', 'That game is not in the archive.');
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      teamSeason: async function (teamId, season) {
        if (!teamId || !season) return fail('NO_TEAM', 'A team and a season are needed.');
        try {
          var rows = await read('team_seasons',
            'select=' + COLS.teamSeasons + '&team_id=eq.' + encodeURIComponent(teamId)
            + '&season=eq.' + season + '&limit=1');
          var ts = shapeTeamSeason((rows || [])[0]);
          return ts ? { ok: true, team: ts }
            : fail('NO_SEASON_ROW', 'That club has no completed games in the archive for ' + season + '.');
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* Prior meetings, out of the same game log the board is drawn from.
         TWO READS RATHER THAN ONE `or=` FILTER. PostgREST would accept a
         nested or(and(..),and(..)) and the fixture harness deliberately will
         not translate one, on the grounds that a silently mistranslated
         filter is a test that proves nothing. Two plain reads need no new
         grammar, are obviously correct, and cost one extra round trip on a
         path a reader hits once per brief. */
      headToHead: async function (aId, bId, opts2) {
        opts2 = opts2 || {};
        if (!aId || !bId) return fail('NO_TEAMS', 'Two clubs are needed.');
        try {
          var lim = opts2.limit || LIMITS.h2h;
          var q = function (homeId, awayId) {
            return read('games', 'select=' + COLS.games
              + '&home_team_id=eq.' + encodeURIComponent(homeId)
              + '&away_team_id=eq.' + encodeURIComponent(awayId)
              + '&completed=is.true&order=game_date.desc&limit=' + lim);
          };
          var both = await Promise.all([q(aId, bId), q(bId, aId)]);
          var rows = [].concat(both[0] || [], both[1] || []);
          var games = rows.map(shapeGame).filter(Boolean)
            .filter(function (g) { return !g.abandoned; })
            .sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); })
            .slice(0, lim);
          var aw = 0, bw = 0;
          games.forEach(function (g) {
            var winnerId = g.winner === 'home' ? g.home.team_id : g.away.team_id;
            if (winnerId === String(aId)) aw++; else if (winnerId === String(bId)) bw++;
          });
          return { ok: true, games: games, a_wins: aw, b_wins: bw, meetings: games.length };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* Recent form: the last N completed games, most recent first. Two reads
         for the same reason head-to-head uses two — see there. Each side is
         asked for N, so the merge cannot miss a game that belongs in the top
         N whichever venue it was played at. */
      form: async function (teamId, season, n) {
        if (!teamId) return fail('NO_TEAM', 'A club is needed.');
        try {
          var lim = n || 10;
          var q = function (field) {
            return read('games', 'select=' + COLS.games
              + '&' + field + '=eq.' + encodeURIComponent(teamId)
              + (season ? '&season=eq.' + season : '')
              + '&completed=is.true&order=game_date.desc&limit=' + lim);
          };
          var both = await Promise.all([q('home_team_id'), q('away_team_id')]);
          var rows = [].concat(both[0] || [], both[1] || []);
          var games = rows.map(shapeGame).filter(Boolean)
            .filter(function (g) { return !g.abandoned; })
            .sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); })
            .slice(0, lim);
          var results = games.map(function (g) {
            var isHome = g.home.team_id === String(teamId);
            var me = isHome ? g.home : g.away, them = isHome ? g.away : g.home;
            return { date: g.date, opponent: them.name, home: isHome && !g.neutral_site,
              neutral: g.neutral_site, scored: me.score, allowed: them.score,
              result: me.score > them.score ? 'W' : (me.score < them.score ? 'L' : 'T') };
          });
          return { ok: true, results: results,
            wins: results.filter(function (r) { return r.result === 'W'; }).length,
            losses: results.filter(function (r) { return r.result === 'L'; }).length };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      teams: async function () {
        if (cache.teams) return cache.teams;
        try {
          var rows = await read('teams', 'select=' + COLS.teams + '&order=name.asc&limit=' + LIMITS.teams);
          var out = { ok: true, teams: (rows || []).map(shapeTeam).filter(Boolean) };
          cache.teams = out;
          return out;
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      invalidate: function () { cache = {}; },
    };
  }

  return { createService: createService, COLS: COLS, LIMITS: LIMITS, SEASON: SEASON, SOURCE: SOURCE,
    seasonOf: seasonOf, inSeason: inSeason,
    shapeGame: shapeGame, shapeTeamSeason: shapeTeamSeason, shapeTeam: shapeTeam,
    recordOf: recordOf, streakText: streakText };
});
/*__EDCBB_END__*/
