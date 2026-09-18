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
    playerGames: 'game_id,athlete_id,line_type,season,game_date,team_id,team_name,'
      + 'athlete_name,position,jersey,starter,ab,runs,hits,rbi,hr,bb,so,pitches_seen,'
      + 'stolen_bases,outs,p_hits,p_runs,earned_runs,p_bb,p_so,p_hr,pitch_count,strikes,'
      + 'season_avg_at_game,season_obp_at_game,season_slg_at_game,season_era_at_game',
    playerSeasons: 'season,athlete_id,athlete_name,team_id,team_name,position,'
      + 'games_batting,ab,runs,hits,rbi,hr,bb,so,pitches_seen,stolen_bases,batting_avg,'
      + 'obp_reported,slg_reported,rates_as_of,games_pitching,outs,p_hits,p_runs,'
      + 'earned_runs,p_bb,p_so,p_hr,pitch_count,strikes,era,whip,k_per_9,bb_per_9,'
      + 'era_reported,first_game,last_game',
    ncaaSeasons: 'season,player_id,identity_resolved,person_id,name,team_code,team_name,'
      + 'division,class_year,bats,b_games,pa,ab,h,doubles,triples,hr,r,rbi,bb,so,hbp,sf,'
      + 'sh,gdp,sb,cs,qualified_batting,total_bases,batting_avg,obp,slg,ops,iso,'
      + 'pitches,p_games,gs,w,l,cg,sho,sv,outs,tbf,p_h,p_r,er,p_hr,p_bb,p_hbp,wp,bk,'
      + 'p_so,qualified_pitching,era,whip,k_per_9,bb_per_9,k_pct',
    teamStats: 'season,team_id,team_name,games_with_lines,games_played,line_coverage,'
      + 'ab,runs,hits,rbi,hr,bb,so,stolen_bases,batting_avg,outs,p_hits,earned_runs,'
      + 'p_bb,p_so,p_hr,era,whip,batters_used,pitchers_used,first_game,last_game',
  };

  var LIMITS = { board: 400, h2h: 40, form: 25, teams: 500,
    /* A box score is two clubs' worth of hitters and pitchers. Fifty is
       generous for college baseball, where rosters bat deep in blowouts. */
    box: 120,
    /* A club's own players, for the brief's leaders. Not the league. */
    roster: 80,
    /* Leaders are a short list by construction. A reader who wants the whole
       league is asking for a different page, not a longer brief. */
    leaders: 25,
    /* THE ARCHIVE IS 61,239 ROWS AND THE BROWSER GETS NONE OF THEM WHOLE.
       Every read below is one player, one club, or a capped leaderboard. */
    archiveRoster: 60, archiveSearch: 40, archiveLeaders: 50 };

  /* NULL IS NOT ZERO, AND Number() DISAGREES. Number(null) is 0 and Number('')
     is 0, so the obvious one-liner turns every unknown in the archive into a
     confident zero — which is exactly the failure this whole schema is built to
     avoid. A hitter with no at-bats would get a .000 average, a club with no
     box score a 0.00 ERA. The guard is the point of the function, not noise. */
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function int(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

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

  /* ── the stats shapes ────────────────────────────────────────────────────
     Every rate here either arrives computed from counting stats or arrives
     carried from the source under a name that says so. NOTHING in this file
     computes a rate the source cannot support. In particular there is no obp
     or slg: the box score has no hit-by-pitch, sacrifice fly, double or triple,
     so those two cannot be derived, and (H+BB)/(AB+BB) is a different
     statistic that would be a lie under that name. */

  /* Innings, for display. The archive stores outs precisely so that nothing
     ever adds innings as decimals; this turns them back at the last moment. */
  function ipText(outs) {
    var o = int(outs);
    if (o === null) return null;
    return Math.floor(o / 3) + '.' + (o % 3);
  }

  /* A batting average prints as .312, and 1.000 prints as 1.000 — a leading
     zero on a rate that cannot exceed one is wrong, but 1.000 is real. */
  function rateText(v, places) {
    var n = num(v);
    if (n === null) return null;
    var s = n.toFixed(places === undefined ? 3 : places);
    return s.charAt(0) === '0' ? s.slice(1) : s;
  }

  function shapePlayerLine(r) {
    if (!r) return null;
    var out = {
      game_id: String(r.game_id), athlete_id: String(r.athlete_id),
      line_type: r.line_type, season: int(r.season), date: r.game_date,
      team_id: r.team_id ? String(r.team_id) : null, team_name: r.team_name,
      name: r.athlete_name, position: r.position || null,
      jersey: r.jersey || null, starter: r.starter === null ? null : !!r.starter,
      /* THESE ARE THE PLAYER'S SEASON FIGURES AS OF THIS GAME, not this game's
         rates. The names carry that, and the UI is not free to relabel them. */
      season_to_date: {
        avg: num(r.season_avg_at_game), obp: num(r.season_obp_at_game),
        slg: num(r.season_slg_at_game), era: num(r.season_era_at_game),
      },
    };
    if (r.line_type === 'batting') {
      out.ab = int(r.ab); out.runs = int(r.runs); out.hits = int(r.hits);
      out.rbi = int(r.rbi); out.hr = int(r.hr); out.bb = int(r.bb); out.so = int(r.so);
      out.pitches_seen = int(r.pitches_seen); out.sb = int(r.stolen_bases);
      /* the line as a reader reads it: 2-for-4 */
      out.line = (out.hits === null || out.ab === null) ? null : out.hits + '-' + out.ab;
    } else {
      out.outs = int(r.outs); out.ip = ipText(r.outs);
      out.hits_allowed = int(r.p_hits); out.runs_allowed = int(r.p_runs);
      out.earned_runs = int(r.earned_runs); out.bb = int(r.p_bb); out.so = int(r.p_so);
      out.hr = int(r.p_hr); out.pitch_count = int(r.pitch_count); out.strikes = int(r.strikes);
    }
    return out;
  }

  function shapePlayerSeason(r) {
    if (!r) return null;
    var batted = int(r.games_batting) || 0;
    var pitched = int(r.games_pitching) || 0;
    return {
      season: int(r.season), athlete_id: String(r.athlete_id), name: r.athlete_name,
      team_id: r.team_id ? String(r.team_id) : null, team_name: r.team_name || null,
      position: r.position || null,
      /* A player is a hitter, a pitcher, or both, and the brief should not have
         to guess from whether a column happens to be zero. */
      bats: batted > 0, pitches: pitched > 0,
      batting: batted > 0 ? {
        games: batted, ab: int(r.ab), runs: int(r.runs), hits: int(r.hits),
        rbi: int(r.rbi), hr: int(r.hr), bb: int(r.bb), so: int(r.so),
        sb: int(r.stolen_bases), pitches_seen: int(r.pitches_seen),
        /* computed from the sums; null with no at-bats, never .000 */
        avg: num(r.batting_avg), avg_text: rateText(r.batting_avg),
        /* the source's own, as of a stated date — see the note above */
        obp_reported: num(r.obp_reported), slg_reported: num(r.slg_reported),
        rates_as_of: r.rates_as_of || null,
      } : null,
      pitching: pitched > 0 ? {
        games: pitched, outs: int(r.outs), ip: ipText(r.outs),
        hits_allowed: int(r.p_hits), runs_allowed: int(r.p_runs),
        earned_runs: int(r.earned_runs), bb: int(r.p_bb), so: int(r.p_so), hr: int(r.p_hr),
        pitch_count: int(r.pitch_count), strikes: int(r.strikes),
        era: num(r.era), whip: num(r.whip), k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9),
        era_reported: num(r.era_reported),
      } : null,
      first_game: r.first_game || null, last_game: r.last_game || null,
    };
  }

  function shapeTeamStats(r) {
    if (!r) return null;
    var withLines = int(r.games_with_lines) || 0;
    var played = int(r.games_played) || 0;
    var cov = num(r.line_coverage);
    return {
      season: int(r.season), team_id: String(r.team_id), team_name: r.team_name,
      games_with_lines: withLines, games_played: played, coverage: cov,
      /* THE HONEST SENTENCE ABOUT THIS ROW. Not every college box score carries
         players, so a club's hitting line can be drawn from fewer games than it
         played, and a reader is owed that in words rather than a ratio to
         interpret. A row at full coverage says nothing, because there is
         nothing to warn about. */
      coverage_note: (cov === null || cov >= 0.999) ? null
        : ('These hitting and pitching numbers come from ' + withLines + ' of '
          + played + ' games played — the source does not carry a box score for '
          + 'every college game. They are a sample of the season, not the season.'),
      batting: {
        ab: int(r.ab), runs: int(r.runs), hits: int(r.hits), rbi: int(r.rbi),
        hr: int(r.hr), bb: int(r.bb), so: int(r.so), sb: int(r.stolen_bases),
        avg: num(r.batting_avg), avg_text: rateText(r.batting_avg),
        batters_used: int(r.batters_used),
      },
      pitching: {
        outs: int(r.outs), ip: ipText(r.outs), hits_allowed: int(r.p_hits),
        earned_runs: int(r.earned_runs), bb: int(r.p_bb), so: int(r.p_so), hr: int(r.p_hr),
        era: num(r.era), whip: num(r.whip), pitchers_used: int(r.pitchers_used),
      },
      first_game: r.first_game || null, last_game: r.last_game || null,
    };
  }

  /* ── the NCAA season archive ─────────────────────────────────────────────
     A DIFFERENT SOURCE FROM EVERYTHING ABOVE, and shaped separately on purpose.
     The box-score fold covers the current season with partial coverage and no
     doubles, triples, hit-by-pitch or sacrifice flies. This covers 2021-2026
     completely and has all four, so its on-base and slugging are computed from
     the definitions rather than carried from the source. Nothing merges the two:
     each says where it came from, and two sources that disagree have to be able
     to be seen disagreeing. */
  function shapeArchiveSeason(r) {
    if (!r) return null;
    var bats = r.bats === true || r.bats === 't' || r.bats === 'true';
    var pitches = r.pitches === true || r.pitches === 't' || r.pitches === 'true';
    var resolved = !(r.identity_resolved === false || r.identity_resolved === 'f'
      || r.identity_resolved === 'false');
    return {
      season: int(r.season), player_id: String(r.player_id), name: r.name,
      person_id: r.person_id || null,
      team_code: r.team_code || null, team_name: r.team_name || null,
      division: int(r.division), class_year: r.class_year || null,
      /* FALSE where the upstream identity resolution failed and the key was
         built from season, club and name. Such a player cannot be followed
         across a transfer. A reader is told rather than left to find out. */
      identity_resolved: resolved,
      identity_note: resolved ? null
        : 'This player had no identifier in the source, so his row is keyed on season, '
          + 'club and name. His numbers are unaffected; he cannot be followed across a '
          + 'transfer.',
      bats: bats, pitches: pitches,
      batting: bats ? {
        games: int(r.b_games), pa: int(r.pa), ab: int(r.ab), h: int(r.h),
        doubles: int(r.doubles), triples: int(r.triples), hr: int(r.hr),
        r: int(r.r), rbi: int(r.rbi), bb: int(r.bb), so: int(r.so),
        hbp: int(r.hbp), sf: int(r.sf), sh: int(r.sh), gdp: int(r.gdp),
        sb: int(r.sb), cs: int(r.cs), total_bases: int(r.total_bases),
        qualified: r.qualified_batting === true || r.qualified_batting === 't',
        avg: num(r.batting_avg), avg_text: rateText(r.batting_avg),
        /* COMPUTED, NOT CARRIED — the distinction the whole archive exists for */
        obp: num(r.obp), obp_text: rateText(r.obp),
        slg: num(r.slg), slg_text: rateText(r.slg),
        ops: num(r.ops), ops_text: rateText(r.ops),
        iso: num(r.iso), iso_text: rateText(r.iso),
      } : null,
      pitching: pitches ? {
        games: int(r.p_games), gs: int(r.gs), w: int(r.w), l: int(r.l),
        cg: int(r.cg), sho: int(r.sho), sv: int(r.sv),
        outs: int(r.outs), ip: ipText(r.outs), tbf: int(r.tbf),
        hits_allowed: int(r.p_h), runs_allowed: int(r.p_r), earned_runs: int(r.er),
        hr: int(r.p_hr), bb: int(r.p_bb), hbp: int(r.p_hbp),
        wp: int(r.wp), bk: int(r.bk), so: int(r.p_so),
        qualified: r.qualified_pitching === true || r.qualified_pitching === 't',
        era: num(r.era), whip: num(r.whip),
        k_per_9: num(r.k_per_9), bb_per_9: num(r.bb_per_9),
        /* per batter faced, because this source publishes TBF */
        k_pct: num(r.k_pct),
      } : null,
    };
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

      /* ── THE BOX SCORE of one game, both clubs, hitters and pitchers ─────
         Read for one game id under an explicit cap. This is what keeps a
         readable archive from being "ship the dataset to the browser": the
         grant makes cbb.player_games readable, and this asks for one game. */
      box: async function (gameId) {
        if (!gameId) return fail('NO_GAME', 'No game id.');
        try {
          var rows = await read('player_games',
            'select=' + COLS.playerGames
            + '&game_id=eq.' + encodeURIComponent(gameId)
            + '&order=line_type.asc,starter.desc,ab.desc&limit=' + LIMITS.box);
          var lines = (rows || []).map(shapePlayerLine).filter(Boolean);
          /* A GAME WITH NO LINES IS NOT AN ERROR AND NOT AN EMPTY GAME. The
             source does not carry a box score for every college game, and the
             difference between "nobody batted" and "the source has no box
             score" has to survive all the way to the reader. */
          if (!lines.length) {
            return { ok: true, game_id: String(gameId), has_box: false, sides: [],
              note: 'The source does not carry a box score for this game. That is a gap '
                + 'in the feed, not a game in which nobody batted.' };
          }
          var byTeam = {};
          lines.forEach(function (l) {
            var k = l.team_id || l.team_name || '?';
            if (!byTeam[k]) byTeam[k] = { team_id: l.team_id, team_name: l.team_name,
              batting: [], pitching: [] };
            byTeam[k][l.line_type === 'pitching' ? 'pitching' : 'batting'].push(l);
          });
          return { ok: true, game_id: String(gameId), has_box: true,
            sides: Object.keys(byTeam).map(function (k) { return byTeam[k]; }),
            counts: { lines: lines.length,
              batting: lines.filter(function (l) { return l.line_type === 'batting'; }).length,
              pitching: lines.filter(function (l) { return l.line_type === 'pitching'; }).length } };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* a club's batting and pitching season, with its coverage stated */
      teamStats: async function (teamId, season) {
        if (!teamId || !season) return fail('NO_TEAM', 'A team and a season are needed.');
        try {
          var rows = await read('team_stat_seasons',
            'select=' + COLS.teamStats + '&team_id=eq.' + encodeURIComponent(teamId)
            + '&season=eq.' + season + '&limit=1');
          var ts = shapeTeamStats((rows || [])[0]);
          return ts ? { ok: true, team: ts }
            : fail('NO_STATS_ROW', 'There are no box-score lines for that club in ' + season
              + '. Its record still comes from the game log.');
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* one player's season */
      player: async function (athleteId, season) {
        if (!athleteId || !season) return fail('NO_PLAYER', 'A player and a season are needed.');
        try {
          var rows = await read('player_seasons',
            'select=' + COLS.playerSeasons + '&athlete_id=eq.' + encodeURIComponent(athleteId)
            + '&season=eq.' + season + '&limit=1');
          var ps = shapePlayerSeason((rows || [])[0]);
          return ps ? { ok: true, player: ps }
            : fail('NOT_FOUND', 'That player has no lines in the ' + season + ' archive.');
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* ── a club's leaders, for the brief ─────────────────────────────────
         ORDERED AND FILTERED IN THE DATABASE, then trimmed here. The minimum
         at-bats is the point: a hitter who is 2-for-2 on the season leads every
         club in the country on batting average, and putting him at the top of a
         brief would be technically true and completely useless. College seasons
         run to roughly 55 games, so 30 at-bats is a low bar that still excludes
         the accident. The threshold is returned alongside the list so a reader
         can see it was applied rather than wonder. */
      leaders: async function (teamId, season, opts2) {
        if (!teamId || !season) return fail('NO_TEAM', 'A team and a season are needed.');
        opts2 = opts2 || {};
        var minAb = opts2.min_ab === undefined ? 30 : opts2.min_ab;
        var minOuts = opts2.min_outs === undefined ? 30 : opts2.min_outs;  /* ten innings */
        try {
          var rows = await read('player_seasons',
            'select=' + COLS.playerSeasons + '&team_id=eq.' + encodeURIComponent(teamId)
            + '&season=eq.' + season + '&order=ab.desc&limit=' + LIMITS.roster);
          var all = (rows || []).map(shapePlayerSeason).filter(Boolean);
          var hitters = all.filter(function (p) { return p.batting && p.batting.ab >= minAb; });
          var pitchers = all.filter(function (p) { return p.pitching && p.pitching.outs >= minOuts; });
          hitters.sort(function (a, b) { return (b.batting.avg || 0) - (a.batting.avg || 0); });
          /* a LOWER era is better, and a null era must not sort as the best */
          pitchers.sort(function (a, b) {
            var x = a.pitching.era === null ? Infinity : a.pitching.era;
            var y = b.pitching.era === null ? Infinity : b.pitching.era;
            return x - y;
          });
          var power = all.filter(function (p) { return p.batting && p.batting.hr > 0; })
            .sort(function (a, b) { return b.batting.hr - a.batting.hr; });
          var k = pitchers.slice().sort(function (a, b) { return b.pitching.so - a.pitching.so; });
          return { ok: true, season: season, team_id: String(teamId),
            thresholds: { min_ab: minAb, min_outs: minOuts,
              note: 'Batting leaders need at least ' + minAb + ' at-bats and pitching leaders '
                + 'at least ' + minOuts + ' outs (' + Math.floor(minOuts / 3) + ' innings). '
                + 'Without a threshold a hitter who is 2-for-2 leads the country.' },
            roster_size: all.length,
            avg: hitters.slice(0, LIMITS.leaders),
            hr: power.slice(0, LIMITS.leaders),
            era: pitchers.slice(0, LIMITS.leaders),
            so: k.slice(0, LIMITS.leaders) };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* how much of a season the stats archive actually covers */
      statsCoverage: async function (season) {
        try {
          var q = 'select=*' + (season ? '&season=eq.' + season : '') + '&limit=20';
          var rows = await read('stats_coverage', q);
          var out = (rows || []).map(function (r) {
            return { season: int(r.season), completed_games: int(r.completed_games),
              games_with_lines: int(r.games_with_lines), coverage: num(r.coverage),
              players: int(r.players) };
          });
          if (!out.length) {
            return fail('NO_STATS', 'No box-score lines have been imported yet. The games '
              + 'board and club records do not depend on them.');
          }
          return { ok: true, seasons: out };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* ── THE SEASON ARCHIVE ──────────────────────────────────────────────
         NCAA's own published season totals, 2021-2026, Division I. Separate
         from everything above: the box-score fold is the current season and
         per-game; this is complete seasons with every counting column. */

      archiveStatus: async function () {
        try {
          var rows = await read('ncaa_archive_status', 'select=*&order=season.desc&limit=20');
          if (!rows || !rows.length) {
            return fail('NO_ARCHIVE', 'The NCAA season archive has not been imported yet. '
              + 'The games board and club records do not depend on it.');
          }
          return { ok: true, seasons: (rows || []).map(function (r) {
            return { season: int(r.season), players: int(r.players),
              batters: int(r.batters), pitchers: int(r.pitchers), teams: int(r.teams),
              qualified_batters: int(r.qualified_batters), imported_at: r.imported_at || null };
          }) };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      archivePlayer: async function (playerId, season) {
        if (!playerId) return fail('NO_PLAYER', 'A player id is needed.');
        try {
          var q = 'select=' + COLS.ncaaSeasons
            + '&player_id=eq.' + encodeURIComponent(playerId)
            + (season ? '&season=eq.' + season : '')
            + '&order=season.desc&limit=12';
          var rows = await read('ncaa_player_seasons', q);
          var seasons = (rows || []).map(shapeArchiveSeason).filter(Boolean);
          if (!seasons.length) return fail('NOT_FOUND', 'That player is not in the season archive.');
          return { ok: true, player_id: String(playerId), name: seasons[0].name,
            seasons: seasons };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* Search by name. A prefix-and-substring match, capped, ordered so the
         most recent season comes first — a reader looking up a name almost
         always means the current one. */
      archiveSearch: async function (name, opts2) {
        var term = String(name || '').trim();
        if (term.length < 3) {
          return fail('TOO_SHORT', 'Give at least three letters of a name. A two-letter '
            + 'search over 61,000 player-seasons is not a search.');
        }
        opts2 = opts2 || {};
        try {
          var q = 'select=' + COLS.ncaaSeasons
            + '&name=ilike.*' + encodeURIComponent(term).replace(/%20/g, '%20') + '*'
            + (opts2.season ? '&season=eq.' + opts2.season : '')
            + '&order=season.desc,name.asc&limit=' + LIMITS.archiveSearch;
          var rows = await read('ncaa_player_seasons', q);
          var found = (rows || []).map(shapeArchiveSeason).filter(Boolean);
          return { ok: true, term: term, count: found.length,
            capped: found.length >= LIMITS.archiveSearch,
            players: found };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      archiveTeam: async function (teamCode, season) {
        if (!teamCode || !season) return fail('NO_TEAM', 'A club code and a season are needed.');
        try {
          var rows = await read('ncaa_player_seasons',
            'select=' + COLS.ncaaSeasons + '&team_code=eq.' + encodeURIComponent(teamCode)
            + '&season=eq.' + season + '&order=ab.desc.nullslast&limit=' + LIMITS.archiveRoster);
          var players = (rows || []).map(shapeArchiveSeason).filter(Boolean);
          if (!players.length) {
            return fail('NOT_FOUND', 'That club has no players in the archive for ' + season + '.');
          }
          return { ok: true, team_code: String(teamCode), season: int(season),
            team_name: players[0].team_name,
            players: players,
            batters: players.filter(function (p) { return p.bats; }).length,
            pitchers: players.filter(function (p) { return p.pitches; }).length };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      /* ── LEADERBOARDS, WITH THE QUALIFIER THE SOURCE ITSELF PUBLISHES ─────
         This archive carries a `qualified` flag per row, computed upstream from
         plate appearances per team game. Using it is better than inventing a
         threshold here, for the reason a threshold exists at all: a hitter who
         is 2-for-2 leads the country on average and belongs on no leaderboard.
         The flag is applied by default and the fact is returned, so a reader
         can see a filter was used rather than wonder why a name is missing. */
      archiveLeaders: async function (season, opts2) {
        if (!season) return fail('NO_SEASON', 'A season is needed.');
        opts2 = opts2 || {};
        var stat = opts2.stat || 'avg';
        var qualifiedOnly = opts2.qualified !== false;
        var PITCHING = { era: 1, whip: 1, k_per_9: 1, so: 1, w: 1, sv: 1 };
        var isPitching = !!PITCHING[stat];
        var ORDER = {
          avg: 'batting_avg.desc.nullslast', obp: 'obp.desc.nullslast',
          slg: 'slg.desc.nullslast', ops: 'ops.desc.nullslast',
          iso: 'iso.desc.nullslast', hr: 'hr.desc.nullslast',
          rbi: 'rbi.desc.nullslast', h: 'h.desc.nullslast', sb: 'sb.desc.nullslast',
          /* LOWER IS BETTER for these two, and nullslast keeps a pitcher with
             no ERA from being handed the lead by an ascending sort. */
          era: 'era.asc.nullslast', whip: 'whip.asc.nullslast',
          k_per_9: 'k_per_9.desc.nullslast', so: 'p_so.desc.nullslast',
          w: 'w.desc.nullslast', sv: 'sv.desc.nullslast',
        };
        if (!ORDER[stat]) {
          return fail('UNKNOWN_STAT', 'There is no leaderboard for "' + stat + '". '
            + 'Available: ' + Object.keys(ORDER).join(', ') + '.');
        }
        try {
          var q = 'select=' + COLS.ncaaSeasons + '&season=eq.' + season
            + (isPitching ? '&pitches=is.true' : '&bats=is.true')
            + (qualifiedOnly
              ? (isPitching ? '&qualified_pitching=is.true' : '&qualified_batting=is.true')
              : '')
            + (opts2.division ? '&division=eq.' + opts2.division : '')
            + '&order=' + ORDER[stat] + '&limit=' + LIMITS.archiveLeaders;
          var rows = await read('ncaa_player_seasons', q);
          var players = (rows || []).map(shapeArchiveSeason).filter(Boolean);
          return { ok: true, season: int(season), stat: stat,
            side: isPitching ? 'pitching' : 'batting',
            lower_is_better: stat === 'era' || stat === 'whip',
            qualified_only: qualifiedOnly,
            qualifier_note: qualifiedOnly
              ? 'Only players the source marks as qualified are listed. Without that '
                + 'filter a hitter with two at-bats leads the country on average.'
              : 'Every player is listed, qualified or not, because that was asked for. '
                + 'Expect the top of a rate leaderboard to be players with almost no '
                + 'playing time.',
            players: players };
        } catch (e) { return fail(classify(e), String((e && e.message) || e)); }
      },

      invalidate: function () { cache = {}; },
    };
  }

  return { createService: createService, COLS: COLS, LIMITS: LIMITS, SEASON: SEASON, SOURCE: SOURCE,
    ipText: ipText, rateText: rateText, shapePlayerLine: shapePlayerLine,
    shapePlayerSeason: shapePlayerSeason, shapeTeamStats: shapeTeamStats,
    shapeArchiveSeason: shapeArchiveSeason,
    seasonOf: seasonOf, inSeason: inSeason,
    shapeGame: shapeGame, shapeTeamSeason: shapeTeamSeason, shapeTeam: shapeTeam,
    recordOf: recordOf, streakText: streakText };
});
/*__EDCBB_END__*/
