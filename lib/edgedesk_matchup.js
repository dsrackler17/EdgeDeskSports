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
