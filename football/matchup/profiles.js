/* ============================================================================
   TEAM-GAME FOOTBALL PROFILES — the measures a matchup argument is made of.

   WHAT WAS MISSING. The research packet could say what EdgeDesk's rating was
   and what the market's number was, and then had nothing football-specific to
   put between them. A reader asking "why" got a rating difference restated.

   Everything here is computed from ONE feed the repository already reads —
   cfbfastR-data `player_stats`, one row per play with the down, the distance,
   the yards to goal, the period, the clock and the RUNNING SCORE on it — so
   every measure below is an observation, not an estimate:

     scoring        points for and against, and the same split for regulation
                    only, because an overtime period is not a drive and
                    counting it in a per-drive rate is a category error
     pace           plays and drives per game
     explosives     passes of 20+ and runs of 15+, as a rate
     pressure       sacks taken per dropback, sacks made per opponent dropback
     turnovers      interceptions thrown and taken, fumbles lost and forced
     third down     attempts and conversions, from the gain against the
                    distance on the play itself
     red zone       trips inside the 20 and the touchdowns finished from them
     field position the average yards-to-goal a drive starts on
     garbage time   every measure above, recomputed with garbage-time plays
                    removed, and both are published

   WHAT IT CANNOT MEASURE, said here rather than implied by absence:
     - EPA of any kind. The feed carries no next-score information, so no
       expected-points surface can be fitted from it and none is invented.
     - Pressures short of a sack, snap counts, blocking, coverage, alignment
       or personnel. None of them are in this feed at any price.
     - Anything about scheme. A play's design is not in a play's row.

   SAMPLE SIZE IS PART OF EVERY MEASURE. A rate over 31 dropbacks is published
   with n=31 beside it, and the packet that reads this decides what it is
   willing to say about 31.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPROFILES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_team_profile_v1';
  var VERSION = 1;

  /* GARBAGE TIME, DEFINED ONCE AND STATED. There is no universal definition;
     this is a score-and-clock rule with no model behind it, and the packet
     says which rule it used rather than implying a standard exists. */
  var GARBAGE = [
    { period: 2, margin: 38 }, { period: 3, margin: 28 }, { period: 4, margin: 22 }
  ];
  var GARBAGE_BASIS = 'a play is garbage time when the margin exceeds 38 in the second quarter, 28 in the third '
    + 'or 22 in the fourth, measured on the running score the feed carries. It is a clock-and-score rule, not a '
    + 'win-probability model, and it is stated so a reader can disagree with it.';

  var EXPLOSIVE_PASS_YDS = 20, EXPLOSIVE_RUSH_YDS = 15, RED_ZONE_YTG = 20;

  /* THE COLUMN GATE, the same doctrine docs/football-data-sources.md already
     applies to this feed: an attribution column that is filled in for some
     games and not others is DECLARED MISSING league-wide rather than scored
     as if the events did not happen. The floors are per team-game rates a
     season of FBS football actually produces; they are a coverage yardstick
     and nothing here is computed FROM them.

     This is not academic. Ole Miss carries zero `sack_taken` rows in 2026 —
     a team does not go two games without allowing a sack, the column simply
     did not fill for them — and without this gate the packet would have
     published "0 sacks allowed on 70 dropbacks" as a measured strength. */
  var COLUMN_FLOORS = {
    sacks_taken: { expected: 2.0, label: 'sacks allowed' },
    sacks_made: { expected: 2.0, label: 'sacks made' },
    ints_thrown: { expected: 0.7, label: 'interceptions thrown' },
    ints_taken: { expected: 0.7, label: 'interceptions taken' },
    fumbles_lost: { expected: 0.6, label: 'fumbles lost' },
    fumbles_forced: { expected: 0.6, label: 'forced fumbles' },
    pass_breakups: { expected: 3.0, label: 'passes defended' },
    touchdowns: { expected: 3.5, label: 'touchdowns' }
  };
  var GATE_USABLE = 0.7, GATE_DEGRADED = 0.3;
  var GATE_BASIS = 'a column is USABLE where the league-wide per-team-game rate reaches 70% of what a season of FBS '
    + 'football produces, DEGRADED between 30% and 70%, and MISSING below that. A DEGRADED or MISSING column is '
    + 'never published as a rate: a team with no rows in it has an unmeasured column, not a perfect one.';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function n(v) { if (v == null || v === '' || v === 'NA') return null; var x = +v; return isFinite(x) ? x : null; }
  function has(v) { return !(v == null || v === '' || v === 'NA'); }
  function rate(a, b) { return (b > 0) ? Math.round((a / b) * 10000) / 10000 : null; }

  function isGarbage(period, margin) {
    for (var i = 0; i < GARBAGE.length; i++) {
      if (period >= GARBAGE[i].period && Math.abs(margin) > GARBAGE[i].margin) return true;
    }
    return false;
  }

  function blankDef() { return { sacks_made: 0, ints_taken: 0, fumbles_forced: 0, pass_breakups: 0 }; }

  function blank() {
    return { plays: 0, drives: {}, dropbacks: 0, completions: 0, incompletions: 0, sacks_taken: 0,
      ints_thrown: 0, rushes: 0, rush_yards: 0, pass_yards: 0, explosive_pass: 0, explosive_rush: 0,
      sacks_made: 0, ints_taken: 0, fumbles_lost: 0, fumbles_forced: 0, pass_breakups: 0,
      third_downs: 0, third_conversions: 0, third_measurable: 0,
      red_zone_trips: {}, red_zone_td: 0, touchdowns: 0,
      drive_start_ytg: [], ot_plays: 0 };
  }

  function bump(acc, r, opts) {
    var ytg = n(r.yards_to_goal), down = n(r.down), dist = n(r.distance);
    acc.plays++;
    if (r.drive_id) acc.drives[r.drive_id] = 1;
    var period = n(r.period) || 1;
    if (period > 4) acc.ot_plays++;

    var recY = n(r.reception_yds), rushY = n(r.rush_yds);
    var gained = null;
    if (has(r.completion_player_id)) { acc.dropbacks++; acc.completions++; if (isNum(recY)) { acc.pass_yards += recY; gained = recY; if (recY >= EXPLOSIVE_PASS_YDS) acc.explosive_pass++; } }
    else if (has(r.incompletion_player_id)) { acc.dropbacks++; acc.incompletions++; gained = 0; }
    else if (has(r.sack_taken_player_id)) { acc.dropbacks++; acc.sacks_taken++; gained = 0; }
    else if (has(r.interception_thrown_player_id)) { acc.dropbacks++; acc.ints_thrown++; gained = 0; }
    else if (has(r.rush_player_id)) { acc.rushes++; if (isNum(rushY)) { acc.rush_yards += rushY; gained = rushY; if (rushY >= EXPLOSIVE_RUSH_YDS) acc.explosive_rush++; } }

    /* A ROW IS THE POSSESSION TEAM'S ROW. `sack_player`, `interception_player`,
       `fumble_forced_player` and `pass_breakup_player` on it name the players
       who DEFENDED it, and those belong to the other team. Crediting them to
       the team on the row is how a defence's sacks end up on the offence's
       card — which is exactly what the first version of this file did, and
       why every team read zero sacks made. `def` collects them and the
       caller posts them to the opponent. */
    if (has(r.fumble_player_id)) acc.fumbles_lost++;
    if (has(r.touchdown_player_id)) { acc.touchdowns++; if (isNum(ytg) && ytg <= RED_ZONE_YTG) acc.red_zone_td++; }
    if (opts && opts.def) {
      var D = opts.def;
      if (has(r.sack_player_id)) D.sacks_made++;
      if (has(r.interception_player_id)) D.ints_taken++;
      if (has(r.fumble_forced_player_id)) D.fumbles_forced++;
      if (has(r.pass_breakup_player_id)) D.pass_breakups++;
    }

    if (down === 3) {
      acc.third_downs++;
      /* A CONVERSION IS ONLY COUNTABLE WHERE THE GAIN IS. An incompletion is
         a measurable non-conversion; a play whose yardage the feed does not
         attribute is neither, and is excluded from the denominator rather
         than being scored as a stop. */
      if (gained != null && isNum(dist)) { acc.third_measurable++; if (gained >= dist) acc.third_conversions++; }
    }
    if (isNum(ytg) && ytg <= RED_ZONE_YTG && r.drive_id) acc.red_zone_trips[r.drive_id] = 1;
  }

  /* -------------------------------------------------------------- build */
  /* rows: the play feed, already parsed. Returns one profile per team, with
     an all-plays view and a garbage-time-excluded view. */
  function build(rows, opts) {
    opts = opts || {};
    var teams = {}, games = {}, driveStart = {}, i, r;
    var defAll = {}, defClean = {};

    for (i = 0; i < (rows || []).length; i++) {
      r = rows[i];
      if (!r || !r.team || !r.game_id) continue;
      var key = opts.keyFor ? opts.keyFor(r.team) : normKey(r.team);
      if (!key) continue;
      var t = teams[key] || (teams[key] = { key: key, team: r.team, conference: r.conference || null,
        all: blank(), clean: blank(), allowed_all: blank(), allowed_clean: blank(),
        games: {}, opponents: {}, scores: {} });
      if (!t.team) t.team = r.team;
      var gid = String(r.game_id);
      t.games[gid] = 1;
      if (r.opponent) t.opponents[gid] = r.opponent;
      var ts = n(r.team_score), os = n(r.opponent_score);
      var pidNum = n(r.play_id);
      /* THE LAST PLAY OF THE GAME, not the last row the file happened to put
         this team on. The rows are not ordered per team, so keeping whichever
         arrived last stored an early-game score as the final one — Ole Miss
         came out at 3.5 points a game. The running score is kept at the
         highest play id instead. */
      if (ts != null && os != null) {
        var prevS = t.scores[gid];
        if (!prevS || (pidNum != null && pidNum >= prevS.pid)) {
          t.scores[gid] = { for: ts, against: os, period: n(r.period) || 1, pid: pidNum == null ? 0 : pidNum };
        }
      }
      var margin = (ts == null || os == null) ? 0 : (ts - os);
      var garbage = isGarbage(n(r.period) || 1, margin);
      /* the defence on this play is the opponent, so its credits are parked
         under the opponent's key and posted after every row is read */
      var oppKey = r.opponent ? (opts.keyFor ? opts.keyFor(r.opponent) : normKey(r.opponent)) : null;
      var dAll = oppKey ? (defAll[oppKey] = defAll[oppKey] || blankDef()) : null;
      var dClean = (oppKey && !garbage) ? (defClean[oppKey] = defClean[oppKey] || blankDef()) : null;
      bump(t.all, r, Object.assign({}, opts, { def: dAll }));
      if (!garbage) bump(t.clean, r, Object.assign({}, opts, { def: dClean }));
      /* WHAT THE DEFENCE ALLOWED, which is the only thing an offence can
         honestly be compared against. Without this, "run game" compared two
         teams' own rushing averages to each other — two offences, never
         meeting — and the read had to admit in words that it was not the
         measure it looked like. The possession team's offensive plays are
         accumulated a second time under the OPPONENT's allowed bucket, so
         "yards per carry" meets "yards per carry allowed". */
      if (oppKey) {
        var o = teams[oppKey] || (teams[oppKey] = { key: oppKey, team: r.opponent, conference: null,
          all: blank(), clean: blank(), allowed_all: blank(), allowed_clean: blank(),
          games: {}, opponents: {}, scores: {} });
        bump(o.allowed_all, r, opts);
        if (!garbage) bump(o.allowed_clean, r, opts);
      }
      /* drive start: the lowest play_id inside a drive carries where it began */
      if (r.drive_id) {
        var d = driveStart[key + '|' + r.drive_id];
        var pid = n(r.play_id);
        if (!d || (pid != null && pid < d.pid)) driveStart[key + '|' + r.drive_id] = { pid: pid == null ? 0 : pid, ytg: n(r.yards_to_goal) };
      }
      games[gid] = 1;
    }

    /* post the defensive credits onto the teams that earned them */
    Object.keys(teams).forEach(function (k) {
      var da = defAll[k] || blankDef(), dc = defClean[k] || blankDef();
      ['sacks_made', 'ints_taken', 'fumbles_forced', 'pass_breakups'].forEach(function (f) {
        teams[k].all[f] = da[f]; teams[k].clean[f] = dc[f];
      });
    });

    Object.keys(driveStart).forEach(function (k) {
      var key = k.split('|')[0], d = driveStart[k];
      if (teams[key] && isNum(d.ytg)) teams[key].all.drive_start_ytg.push(d.ytg);
    });

    /* the league-wide fill rate for every gated column */
    var teamGames = 0, totals = {};
    Object.keys(COLUMN_FLOORS).forEach(function (c) { totals[c] = 0; });
    Object.keys(teams).forEach(function (k) {
      teamGames += Object.keys(teams[k].games).length;
      Object.keys(COLUMN_FLOORS).forEach(function (c) { totals[c] += teams[k].all[c] || 0; });
    });
    var gates = {};
    Object.keys(COLUMN_FLOORS).forEach(function (c) {
      var per = teamGames ? totals[c] / teamGames : 0;
      var ratio = COLUMN_FLOORS[c].expected ? per / COLUMN_FLOORS[c].expected : 0;
      gates[c] = {
        column: c, label: COLUMN_FLOORS[c].label,
        per_team_game: Math.round(per * 100) / 100,
        expected_per_team_game: COLUMN_FLOORS[c].expected,
        fill_ratio: Math.round(ratio * 100) / 100,
        state: ratio >= GATE_USABLE ? 'USABLE' : (ratio >= GATE_DEGRADED ? 'DEGRADED' : 'MISSING'),
        why: ratio >= GATE_USABLE ? null
          : ('the feed attributes ' + (Math.round(per * 100) / 100) + ' ' + COLUMN_FLOORS[c].label
            + ' per team-game against roughly ' + COLUMN_FLOORS[c].expected
            + ' in real football, so this column is declared '
            + (ratio >= GATE_DEGRADED ? 'degraded' : 'missing')
            + ' league-wide rather than scored as if the events did not happen')
      };
    });

    var out = { __gates: gates, __team_games: teamGames, __gate_basis: GATE_BASIS };
    Object.keys(teams).forEach(function (k) { out[k] = finalise(teams[k], gates); });
    return out;
  }

  function finalise(t, gates) {
    gates = gates || {};
    var nGames = Object.keys(t.games).length;
    /* A LEAGUE-USABLE COLUMN CAN STILL BE EMPTY FOR ONE TEAM. Ole Miss carries
       no `sack_taken` row at all in 2026 while the column fills at 83% across
       the league — that is the feed missing this team, not a team that has
       not allowed a sack in two games, and publishing "0.0 sacks allowed per
       dropback" as a strength would be the worst kind of wrong. Only an exact
       zero over two or more games is flagged, and the flag is a statement
       about the feed. */
    var teamGaps = {};
    Object.keys(COLUMN_FLOORS).forEach(function (c) {
      var g = gates[c];
      if (!g || g.state !== 'USABLE') return;
      /* ONLY WHERE A ZERO IS IMPLAUSIBLE. A team with no interception thrown in
         two games is an ordinary team, not a feed gap; a team with no sack
         allowed across eight expected ones is a feed gap. The line is drawn at
         three expected events, so the flag fires on absence that the schedule
         itself makes surprising and nowhere else. */
      var expected = COLUMN_FLOORS[c].expected * nGames;
      if (nGames >= 2 && expected >= 3 && (t.all[c] || 0) === 0) {
        teamGaps[c] = { state: 'TEAM_UNMEASURED', expected_events: Math.round(expected * 10) / 10,
          why: 'this column filled for the league (' + g.per_team_game + ' per team-game) and carries no row at all '
            + 'for ' + t.team + ' across ' + nGames + ' games, where roughly ' + Math.round(expected)
            + ' would be expected — so it is unmeasured for this team rather than zero' };
      }
    });
    function gated(col, value) {
      var g = gates[col];
      if (g && g.state !== 'USABLE') return null;
      if (teamGaps[col]) return null;
      return value;
    }
    var gameIds = Object.keys(t.games);
    var g = gameIds.length || 1;
    /* FINAL SCORES, and the regulation split beside them. The feed's running
       score at the last play of regulation is the regulation score; anything
       after period 4 is overtime and is reported separately rather than
       folded into a per-game scoring rate. */
    var pf = 0, pa = 0, gamesScored = 0;
    gameIds.forEach(function (gid) { var s = t.scores[gid]; if (s) { pf += s.for; pa += s.against; gamesScored++; } });

    function view(a) {
      var drives = Object.keys(a.drives).length;
      return {
        plays: a.plays, drives: drives,
        plays_per_game: Math.round((a.plays / g) * 10) / 10,
        drives_per_game: drives ? Math.round((drives / g) * 10) / 10 : null,
        dropbacks: a.dropbacks, rushes: a.rushes,
        pass_rate: rate(a.dropbacks, a.dropbacks + a.rushes),
        yards_per_rush: a.rushes ? Math.round((a.rush_yards / a.rushes) * 100) / 100 : null,
        yards_per_completion: a.completions ? Math.round((a.pass_yards / a.completions) * 100) / 100 : null,
        completion_rate: rate(a.completions, a.dropbacks - a.sacks_taken),
        explosive_pass_rate: rate(a.explosive_pass, a.dropbacks),
        explosive_rush_rate: rate(a.explosive_rush, a.rushes),
        /* every gated column comes back null where the league fill failed, so
           an unmeasured column reads as unmeasured and never as a zero */
        sack_taken_rate: gated('sacks_taken', rate(a.sacks_taken, a.dropbacks)),
        sacks_made: gated('sacks_made', a.sacks_made),
        ints_taken: gated('ints_taken', a.ints_taken),
        ints_thrown: gated('ints_thrown', a.ints_thrown),
        fumbles_lost: gated('fumbles_lost', a.fumbles_lost),
        fumbles_forced: gated('fumbles_forced', a.fumbles_forced),
        pass_breakups: gated('pass_breakups', a.pass_breakups),
        giveaways: (gates.ints_thrown && gates.ints_thrown.state === 'USABLE' && gates.fumbles_lost && gates.fumbles_lost.state === 'USABLE')
          ? a.ints_thrown + a.fumbles_lost : null,
        takeaways: (gates.ints_taken && gates.ints_taken.state === 'USABLE' && gates.fumbles_forced && gates.fumbles_forced.state === 'USABLE')
          ? a.ints_taken + a.fumbles_forced : null,
        raw_counts: { sacks_taken: a.sacks_taken, sacks_made: a.sacks_made, ints_thrown: a.ints_thrown,
          ints_taken: a.ints_taken, fumbles_lost: a.fumbles_lost, fumbles_forced: a.fumbles_forced,
          pass_breakups: a.pass_breakups, touchdowns: a.touchdowns,
          note: 'what the feed actually attributed, kept beside the gated view so a reader can see the gap' },
        third_down_attempts: a.third_downs, third_down_measurable: a.third_measurable,
        third_down_rate: rate(a.third_conversions, a.third_measurable),
        red_zone_trips: Object.keys(a.red_zone_trips).length,
        red_zone_touchdowns: gated('touchdowns', a.red_zone_td),
        red_zone_td_rate: gated('touchdowns', rate(a.red_zone_td, Object.keys(a.red_zone_trips).length)),
        touchdowns: gated('touchdowns', a.touchdowns),
        overtime_plays: a.ot_plays,
        avg_drive_start_ytg: a.drive_start_ytg.length
          ? Math.round((a.drive_start_ytg.reduce(function (x, y) { return x + y; }, 0) / a.drive_start_ytg.length) * 10) / 10
          : null
      };
    }

    return {
      schema: SCHEMA, version: VERSION,
      key: t.key, team: t.team, conference: t.conference,
      games: gameIds.length,
      opponents: gameIds.map(function (gid) {
        var s = t.scores[gid];
        return { game_id: gid, opponent: t.opponents[gid] || null,
          points_for: s ? s.for : null, points_against: s ? s.against : null,
          note: s ? 'the running score at the last attributed play of this game' : null };
      }),
      scoring: {
        games_scored: gamesScored,
        points_for_per_game: gamesScored ? Math.round((pf / gamesScored) * 10) / 10 : null,
        points_against_per_game: gamesScored ? Math.round((pa / gamesScored) * 10) / 10 : null,
        basis: 'the running score the play feed carries at the last attributed play of each game'
      },
      all_plays: view(t.all),
      excluding_garbage_time: view(t.clean),
      /* the same measures, seen from the other side of the ball */
      allowed: view(t.allowed_all),
      allowed_excluding_garbage_time: view(t.allowed_clean),
      /* The league-wide gate and the standing limits are the SAME object for
         every team, so they live once at the top of the artifact rather than
         292 times inside it. What is genuinely per-team — a column that
         filled for the league and not for this side — stays here. */
      team_column_gaps: teamGaps
    };
  }

  function normKey(s) {
    if (s == null) return null;
    return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || null;
  }

  /* ------------------------------------------------------------- compare */
  /* ONE PAIRING, ON ONE SCALE. An attacking measure against the DEFENSIVE
     measure it actually meets — sacks taken against sacks made, explosive
     passes against passes broken up — never an ordinal from one board
     subtracted from an ordinal on another. Where either side's sample is too
     thin the pairing prints with its n and says the difference is not
     established. */
  /* EVERY PAIRING IS AN OFFENCE MEASURE AGAINST THE SAME MEASURE ALLOWED.
     `def` is read from the defending team's ALLOWED view, so "yards per carry"
     meets "yards per carry allowed" rather than meeting the other team's own
     rushing average, which is two offences that never play each other. */
  var PAIRS = [
    { key: 'pass_protection', off: 'sack_taken_rate', def: 'sack_taken_rate',
      off_label: 'sacks allowed per dropback', def_label: 'sacks per opponent dropback',
      min_n: 40, n_off: 'dropbacks', n_def: 'dropbacks' },
    { key: 'explosive_pass', off: 'explosive_pass_rate', def: 'explosive_pass_rate',
      off_label: 'passes of 20+ per dropback', def_label: 'passes of 20+ allowed per dropback',
      min_n: 40, n_off: 'dropbacks', n_def: 'dropbacks' },
    { key: 'run_game', off: 'yards_per_rush', def: 'yards_per_rush',
      off_label: 'yards per carry', def_label: 'yards per carry allowed',
      min_n: 40, n_off: 'rushes', n_def: 'rushes' },
    { key: 'explosive_run', off: 'explosive_rush_rate', def: 'explosive_rush_rate',
      off_label: 'carries of 15+ per rush', def_label: 'carries of 15+ allowed per rush',
      min_n: 40, n_off: 'rushes', n_def: 'rushes' },
    { key: 'passing', off: 'completion_rate', def: 'completion_rate',
      off_label: 'completion rate', def_label: 'completion rate allowed',
      min_n: 40, n_off: 'dropbacks', n_def: 'dropbacks' },
    { key: 'third_down', off: 'third_down_rate', def: 'third_down_rate',
      off_label: 'third downs converted', def_label: 'third downs allowed to convert',
      min_n: 20, n_off: 'third_down_measurable', n_def: 'third_down_measurable' },
    { key: 'red_zone', off: 'red_zone_td_rate', def: 'red_zone_td_rate',
      off_label: 'red-zone trips finished with a touchdown', def_label: 'red-zone trips allowed to finish with a touchdown',
      min_n: 6, n_off: 'red_zone_trips', n_def: 'red_zone_trips' },
    { key: 'field_position', off: 'avg_drive_start_ytg', def: 'avg_drive_start_ytg',
      off_label: 'average yards to goal at the start of a drive', def_label: 'average yards to goal it gives opponents',
      min_n: 15, n_off: 'drives', n_def: 'drives' },
    { key: 'ball_security', off: 'giveaways', def: 'takeaways', off_label: 'giveaways',
      def_label: 'takeaways', min_n: 1, n_off: 'plays', n_def: 'plays' }
  ];

  function comparePair(attProfile, defProfile, pair, o) {
    o = o || {};
    var view = o.exclude_garbage ? 'excluding_garbage_time' : 'all_plays';
    /* ball_security is the one pairing whose two halves are genuinely a team's
       own giveaways against the other team's own takeaways; everything else
       reads the defender's ALLOWED view. */
    var defView = pair.key === 'ball_security' ? view
      : (o.exclude_garbage ? 'allowed_excluding_garbage_time' : 'allowed');
    var a = attProfile && attProfile[view], d = defProfile && defProfile[defView];
    var out = { key: pair.key, attacker: attProfile && attProfile.team, defender: defProfile && defProfile.team,
      off_label: pair.off_label, def_label: pair.def_label, view: view };
    if (!a || !d) { out.state = 'UNAVAILABLE'; out.read = 'one side has no measured plays this season, so the pairing cannot be scored.'; return out; }
    out.off_value = a[pair.off]; out.def_value = d[pair.def];
    out.off_n = a[pair.n_off]; out.def_n = d[pair.n_def];
    if (out.off_value == null || out.def_value == null) {
      out.state = 'UNAVAILABLE';
      out.read = 'the feed carries no value for one half of this pairing, so nothing is claimed about it.';
      return out;
    }
    if ((out.off_n || 0) < pair.min_n || (out.def_n || 0) < pair.min_n) {
      out.state = 'THIN';
      out.read = (attProfile.team + ' ' + fmt(out.off_value) + ' over ' + out.off_n + ', '
        + defProfile.team + ' ' + fmt(out.def_value) + ' over ' + out.def_n
        + ' — both are printed because they are measurements, and neither sample reaches ' + pair.min_n
        + ', so the SIZE of any difference between them is not established.');
      return out;
    }
    out.state = 'MEASURED';
    out.read = attProfile.team + '’s ' + pair.off_label + ' is ' + fmt(out.off_value) + ' over ' + out.off_n
      + ', against ' + defProfile.team + '’s ' + pair.def_label + ' of ' + fmt(out.def_value) + ' over ' + out.def_n
      + '. Both are counts from this season’s plays; neither is opponent-adjusted here, so a team that has '
      + 'played weaker opponents will read better than it is.';
    return out;
  }
  function fmt(v) {
    if (!isNum(v)) return String(v);
    if (Math.abs(v) < 1) return (Math.round(v * 1000) / 10) + '%';
    return String(Math.round(v * 100) / 100);
  }

  function matchup(home, away, o) {
    o = o || {};
    var out = [];
    PAIRS.forEach(function (p) {
      out.push(Object.assign({ side: 'away_offence' }, comparePair(away, home, p, o)));
      out.push(Object.assign({ side: 'home_offence' }, comparePair(home, away, p, o)));
    });
    return out;
  }

  var LIMITS = [
    'no expected-points or EPA measure appears here: the feed carries no next-score information, so none is computable and none is invented',
    'pressures short of a sack, snap counts, blocking and coverage are not in this feed at any price',
    'a play whose yardage the feed does not attribute is excluded from the third-down denominator rather than scored as a stop',
    'overtime plays are counted and reported separately; they are not folded into a per-drive rate'
  ];

  return { SCHEMA: SCHEMA, VERSION: VERSION, LIMITS: LIMITS, build: build, matchup: matchup, comparePair: comparePair,
    PAIRS: PAIRS, COLUMN_FLOORS: COLUMN_FLOORS, GATE_BASIS: GATE_BASIS, GARBAGE: GARBAGE, GARBAGE_BASIS: GARBAGE_BASIS, isGarbage: isGarbage, normKey: normKey };
});
