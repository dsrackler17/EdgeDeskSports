/*__EDED_RESULTS_START__*/
/* ============================================================================
   THE POSTGAME RESULT — what actually happened, and whether it is safe to
   write about yet.

   THE RULE THIS FILE EXISTS TO ENFORCE: a final score is not a game. Ten
   minutes after a whistle, a scoreboard endpoint has two integers and a box
   score has nothing; an article written from that would have to invent every
   sentence between "Seattle won 27-20" and the reader. So a postgame article
   is gated on STATISTICS, not on status, and the gate is in readiness()
   below: enough team statistics to explain the game, or no article.

   THE METRIC VOCABULARY is the other half. Everything the audit may observe
   is one of the keys in METRICS — a closed set, each with a unit, a direction
   and the provider field it is read from. A thesis that wants a metric not on
   this list evaluates to INCONCLUSIVE and says which metric it wanted. That
   is how "did EdgeDesk's explosive-play thesis hold up?" stays honest when
   the provider publishes no explosive-play rate: the audit reports that it
   could not be observed, rather than quietly substituting yards per play and
   calling it the same thing.

   PURE. Every function here takes provider JSON (or a fixture) and returns a
   value. The network lives in fetch_results.js, so this whole file is
   testable offline against committed fixtures, which is what the suite does.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.results = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_game_result_v1';

  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function int(v) { var n = num(v); return n == null ? null : Math.round(n); }
  function txt(v) { if (v == null) return null; var s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }

  /* ------------------------------------------------- the metric vocabulary */
  /* key            what it is
     unit           how an article is allowed to write it
     better         which direction is good for the team it describes
     provider       the ESPN box-score label it is read from, or 'derived'
     abs / rel      how big a gap between the two sides has to be before one
                    game is allowed to call it a real edge rather than noise.
                    Both are per-metric on purpose: half a yard per play is a
                    large edge and half a sack is nothing, and a single relative
                    threshold across thirty-five metrics would have graded one
                    of those wrong every week. A gap counts "at size" if it
                    clears EITHER the absolute or the relative bar.
     A metric absent from a provider's payload is absent from the observation,
     never zero: a team with no recorded sacks and a provider that does not
     publish sacks are different facts. */
  var METRICS = {
    points:            { label: 'points', unit: 'points', better: 'high', provider: 'scoreboard', abs: 7, rel: 0.25 },
    total_points:      { label: 'combined points', unit: 'points', better: null, provider: 'derived', abs: 7, rel: 0.2 },
    margin:            { label: 'scoring margin', unit: 'points', better: 'high', provider: 'derived', abs: 7, rel: 0.25 },
    total_yards:       { label: 'total yards', unit: 'yards', better: 'high', provider: 'totalYards', abs: 60, rel: 0.15 },
    total_plays:       { label: 'offensive plays', unit: 'plays', better: null, provider: 'totalOffensivePlays', abs: 10, rel: 0.15 },
    yards_per_play:    { label: 'yards per play', unit: 'yards', better: 'high', provider: 'yardsPerPlay', abs: 0.8, rel: 0.12 },
    net_pass_yards:    { label: 'net passing yards', unit: 'yards', better: 'high', provider: 'netPassingYards', abs: 60, rel: 0.2 },
    yards_per_pass:    { label: 'yards per pass attempt', unit: 'yards', better: 'high', provider: 'yardsPerPass', abs: 1.2, rel: 0.15 },
    pass_attempts:     { label: 'pass attempts', unit: 'attempts', better: null, provider: 'completionAttempts', abs: 8, rel: 0.2 },
    completions:       { label: 'completions', unit: 'completions', better: 'high', provider: 'completionAttempts', abs: 6, rel: 0.2 },
    completion_pct:    { label: 'completion percentage', unit: '%', better: 'high', provider: 'derived', abs: 10, rel: 0.15 },
    rush_yards:        { label: 'rushing yards', unit: 'yards', better: 'high', provider: 'rushingYards', abs: 50, rel: 0.25 },
    rush_attempts:     { label: 'rushing attempts', unit: 'carries', better: null, provider: 'rushingAttempts', abs: 10, rel: 0.25 },
    yards_per_rush:    { label: 'yards per carry', unit: 'yards', better: 'high', provider: 'yardsPerRushAttempt', abs: 1.0, rel: 0.2 },
    first_downs:       { label: 'first downs', unit: 'first downs', better: 'high', provider: 'firstDowns', abs: 5, rel: 0.2 },
    third_down_pct:    { label: 'third-down conversion rate', unit: '%', better: 'high', provider: 'thirdDownEff', abs: 15, rel: 0.25 },
    third_down_att:    { label: 'third-down attempts', unit: 'attempts', better: null, provider: 'thirdDownEff', abs: 5, rel: 0.3 },
    fourth_down_pct:   { label: 'fourth-down conversion rate', unit: '%', better: 'high', provider: 'fourthDownEff', abs: 34, rel: 0.5 },
    red_zone_pct:      { label: 'red-zone touchdown rate', unit: '%', better: 'high', provider: 'redZoneAttempts', abs: 34, rel: 0.4 },
    red_zone_trips:    { label: 'red-zone trips', unit: 'trips', better: null, provider: 'redZoneAttempts', abs: 2, rel: null },
    turnovers:         { label: 'turnovers committed', unit: 'turnovers', better: 'low', provider: 'turnovers', abs: 2, rel: null },
    interceptions_thrown: { label: 'interceptions thrown', unit: 'interceptions', better: 'low', provider: 'interceptions', abs: 2, rel: null },
    fumbles_lost:      { label: 'fumbles lost', unit: 'fumbles', better: 'low', provider: 'fumblesLost', abs: 2, rel: null },
    turnover_margin:   { label: 'turnover margin', unit: 'turnovers', better: 'high', provider: 'derived', abs: 2, rel: null },
    sacks_allowed:     { label: 'sacks allowed', unit: 'sacks', better: 'low', provider: 'sacksYardsLost', abs: 2, rel: null },
    sack_yards_allowed:{ label: 'yards lost to sacks', unit: 'yards', better: 'low', provider: 'sacksYardsLost', abs: 15, rel: 0.4 },
    sacks_generated:   { label: 'sacks generated', unit: 'sacks', better: 'high', provider: 'derived', abs: 2, rel: null },
    penalties:         { label: 'penalties', unit: 'penalties', better: 'low', provider: 'totalPenaltiesYards', abs: 4, rel: null },
    penalty_yards:     { label: 'penalty yards', unit: 'yards', better: 'low', provider: 'totalPenaltiesYards', abs: 35, rel: 0.4 },
    possession_seconds:{ label: 'time of possession', unit: 'seconds', better: null, provider: 'possessionTime', abs: 300, rel: 0.15 },
    drives:            { label: 'offensive drives', unit: 'drives', better: null, provider: 'totalDrives', abs: 3, rel: null },
    points_per_drive:  { label: 'points per drive', unit: 'points', better: 'high', provider: 'derived', abs: 0.8, rel: 0.3 },
    yards_per_drive:   { label: 'yards per drive', unit: 'yards', better: 'high', provider: 'derived', abs: 8, rel: 0.25 },
    plays_per_minute:  { label: 'plays per minute of possession', unit: 'plays', better: null, provider: 'derived', abs: 0.4, rel: 0.2 },
    defensive_tds:     { label: 'defensive touchdowns', unit: 'touchdowns', better: 'high', provider: 'defensiveTouchdowns', abs: 1, rel: null }
  };

  /* ------------------------------------------------ provider field parsing */
  /* ESPN publishes several of these as one string: "5-13", "22-35", "3-19",
     "31:12". Each is split HERE, once, and anything that does not parse comes
     back null rather than half a number. */
  function pair(s) {
    var m = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(String(s == null ? '' : s));
    return m ? { a: +m[1], b: +m[2] } : null;
  }
  function clock(s) {
    var m = /^\s*(\d+)\s*:\s*(\d{1,2})\s*$/.exec(String(s == null ? '' : s));
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function pct(a, b) { return (a == null || b == null || b === 0) ? null : Math.round((a / b) * 1000) / 10; }

  /* ESPN's boxscore.teams[].statistics is [{name, displayValue, value}]. */
  function statMap(team) {
    var out = Object.create(null);
    ((team && team.statistics) || []).forEach(function (s) {
      if (!s || !s.name) return;
      out[String(s.name)] = { display: txt(s.displayValue), value: s.value == null ? null : s.value };
    });
    return out;
  }
  function raw(m, name) {
    var s = m[name];
    if (!s) return null;
    var v = num(s.value);
    if (v != null) return v;
    return num(s.display);
  }

  /* One side's observed metrics, from one provider's box score. Absent keys
     stay absent. */
  function sideMetrics(team, points) {
    var m = statMap(team);
    var o = Object.create(null);
    function set(k, v) { if (v != null) o[k] = v; }

    set('points', int(points));
    set('total_yards', raw(m, 'totalYards'));
    set('total_plays', raw(m, 'totalOffensivePlays'));
    set('yards_per_play', raw(m, 'yardsPerPlay'));
    set('net_pass_yards', raw(m, 'netPassingYards'));
    set('yards_per_pass', raw(m, 'yardsPerPass'));
    set('rush_yards', raw(m, 'rushingYards'));
    set('rush_attempts', raw(m, 'rushingAttempts'));
    set('yards_per_rush', raw(m, 'yardsPerRushAttempt'));
    set('first_downs', raw(m, 'firstDowns'));
    set('turnovers', raw(m, 'turnovers'));
    set('interceptions_thrown', raw(m, 'interceptions'));
    set('fumbles_lost', raw(m, 'fumblesLost'));
    set('defensive_tds', raw(m, 'defensiveTouchdowns'));
    set('drives', raw(m, 'totalDrives'));

    var ca = pair(m.completionAttempts && m.completionAttempts.display);
    if (ca) { set('completions', ca.a); set('pass_attempts', ca.b); set('completion_pct', pct(ca.a, ca.b)); }
    var td = pair(m.thirdDownEff && m.thirdDownEff.display);
    if (td) { set('third_down_att', td.b); set('third_down_pct', pct(td.a, td.b)); }
    var fd = pair(m.fourthDownEff && m.fourthDownEff.display);
    if (fd) set('fourth_down_pct', pct(fd.a, fd.b));
    var rz = pair(m.redZoneAttempts && m.redZoneAttempts.display);
    if (rz) { set('red_zone_trips', rz.b); set('red_zone_pct', pct(rz.a, rz.b)); }
    var sk = pair(m.sacksYardsLost && m.sacksYardsLost.display);
    if (sk) { set('sacks_allowed', sk.a); set('sack_yards_allowed', sk.b); }
    var pen = pair(m.totalPenaltiesYards && m.totalPenaltiesYards.display);
    if (pen) { set('penalties', pen.a); set('penalty_yards', pen.b); }
    var pos = clock(m.possessionTime && m.possessionTime.display);
    if (pos != null) set('possession_seconds', pos);

    /* derived, in deterministic code and never by a language model */
    if (o.points != null && o.drives) set('points_per_drive', r2(o.points / o.drives));
    if (o.total_yards != null && o.drives) set('yards_per_drive', r1(o.total_yards / o.drives));
    if (o.total_plays != null && o.possession_seconds) set('plays_per_minute', r2(o.total_plays / (o.possession_seconds / 60)));
    if (o.yards_per_play == null && o.total_yards != null && o.total_plays) set('yards_per_play', r2(o.total_yards / o.total_plays));

    return o;
  }

  /* Cross-side derivations: a team's sacks GENERATED are the other team's
     sacks allowed, and a turnover margin needs both columns. */
  function crossDerive(home, away) {
    if (away.sacks_allowed != null) home.sacks_generated = away.sacks_allowed;
    if (home.sacks_allowed != null) away.sacks_generated = home.sacks_allowed;
    if (home.turnovers != null && away.turnovers != null) {
      home.turnover_margin = away.turnovers - home.turnovers;
      away.turnover_margin = home.turnovers - away.turnovers;
    }
    if (home.points != null && away.points != null) {
      home.margin = home.points - away.points;
      away.margin = away.points - home.points;
    }
  }

  /* ---------------------------------------------------- the ESPN summary */
  /* boxscore.teams[] does NOT carry the score; header.competitions[0]
     .competitors[] does, and so does the scoreboard. Both are accepted and
     the caller says which it had. */
  function normalizeSummary(summary, opts) {
    opts = opts || {};
    if (!summary || typeof summary !== 'object') return null;
    var bs = summary.boxscore || {};
    var header = summary.header || {};
    var compHeader = ((header.competitions || [])[0]) || {};
    var competitors = compHeader.competitors || [];

    function sideOf(ha) {
      var c = competitors.filter(function (x) { return String(x.homeAway) === ha; })[0] || null;
      return c;
    }
    var hC = sideOf('home'), aC = sideOf('away');
    function teamBlockFor(c) {
      var id = c && c.team && c.team.id != null ? String(c.team.id) : null;
      var hit = ((bs.teams) || []).filter(function (t) {
        return t && t.team && t.team.id != null && String(t.team.id) === id;
      })[0];
      return hit || null;
    }
    var homeTeam = teamBlockFor(hC), awayTeam = teamBlockFor(aC);
    /* a summary with a box score but no header ordering: fall back to the
       box score's own order, which ESPN publishes away-first */
    if (!homeTeam && !awayTeam && (bs.teams || []).length === 2) {
      awayTeam = bs.teams[0]; homeTeam = bs.teams[1];
    }

    var hs = int(hC && hC.score), as = int(aC && aC.score);
    if (hs == null && opts.home_score != null) hs = int(opts.home_score);
    if (as == null && opts.away_score != null) as = int(opts.away_score);

    var home = sideMetrics(homeTeam, hs);
    var away = sideMetrics(awayTeam, as);
    crossDerive(home, away);

    var st = (compHeader.status && compHeader.status.type) || {};
    var nameOf = function (c, t) {
      return txt(c && c.team && (c.team.displayName || c.team.location || c.team.name))
        || txt(t && t.team && (t.team.displayName || t.team.location));
    };

    return {
      provider: 'espn_summary',
      event_id: txt(header.id) || txt(summary.gameId) || txt(opts.event_id),
      home_team: nameOf(hC, homeTeam),
      away_team: nameOf(aC, awayTeam),
      home_score: hs, away_score: as,
      completed: st.completed === true && !/POSTPONED|CANCEL|SUSPEND|FORFEIT/i.test(String(st.name || '')),
      status_name: txt(st.name) || txt(st.description),
      period: int(compHeader.status && compHeader.status.period),
      metrics: { home: home, away: away },
      line_scores: lineScores(hC, aC),
      scoring_plays: scoringPlays(summary),
      drive_summary: driveSummary(summary),
      win_probability: winProbabilitySwings(summary),
      leaders: leaders(summary),
      stat_fields_seen: Object.keys(statMap(homeTeam)).concat(Object.keys(statMap(awayTeam)))
        .filter(function (v, i, a) { return a.indexOf(v) === i; }).sort()
    };
  }

  function lineScores(hC, aC) {
    function of(c) {
      var l = (c && c.linescores) || [];
      var out = l.map(function (x) { return int(x && (x.displayValue != null ? x.displayValue : x.value)); });
      return out.every(function (v) { return v != null; }) && out.length ? out : null;
    }
    var h = of(hC), a = of(aC);
    return (h || a) ? { home: h, away: a } : null;
  }

  /* Scoring plays, as the provider published them. Kept because the SEQUENCE
     of a game is sometimes the explanation — a pick-six inside two minutes is
     a different game from the same points in the first quarter — and because
     nothing else in the payload can show a defensive or special-teams score. */
  function scoringPlays(summary) {
    var sp = summary && summary.scoringPlays;
    if (!Array.isArray(sp) || !sp.length) return null;
    return sp.map(function (p) {
      return {
        period: int(p.period && p.period.number),
        clock: txt(p.clock && p.clock.displayValue),
        team: txt(p.team && (p.team.displayName || p.team.abbreviation)),
        type: txt(p.type && (p.type.abbreviation || p.type.text)),
        text: txt(p.text),
        scoring_type: txt(p.scoringType && p.scoringType.displayName),
        home_score: int(p.homeScore), away_score: int(p.awayScore)
      };
    }).filter(function (p) { return p.text || p.type; });
  }

  /* Drive counts and outcomes, aggregated. The aggregate is what explains a
     game; the play list is not something an article should recite. */
  function driveSummary(summary) {
    var d = summary && summary.drives;
    var all = (d && (d.previous || d.current)) || null;
    if (!Array.isArray(all) || !all.length) return null;
    var by = Object.create(null);
    all.forEach(function (dr) {
      var t = txt(dr.team && (dr.team.displayName || dr.team.abbreviation || dr.team.shortDisplayName));
      if (!t) return;
      var b = by[t] || (by[t] = { team: t, drives: 0, plays: 0, yards: 0, scoring: 0, results: {} });
      b.drives++;
      b.plays += int(dr.offensivePlays) || 0;
      b.yards += int(dr.yards) || 0;
      if (dr.isScore === true) b.scoring++;
      var res = txt(dr.result || dr.displayResult);
      if (res) b.results[res] = (b.results[res] || 0) + 1;
    });
    var rows = Object.keys(by).map(function (k) { return by[k]; });
    return rows.length ? rows : null;
  }

  /* The largest single swing in the provider's own win-probability series, and
     the play it belongs to. One number, not a chart: it is the closest thing
     the payload has to "the moment the game turned", and it is the PROVIDER'S
     number rather than one computed here. */
  function winProbabilitySwings(summary) {
    var wp = summary && summary.winprobability;
    if (!Array.isArray(wp) || wp.length < 3) return null;
    var biggest = null, prev = null;
    wp.forEach(function (p) {
      var v = num(p && p.homeWinPercentage);
      if (v == null) return;
      if (prev != null) {
        var delta = v - prev.v;
        if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) {
          biggest = { delta: r2(delta), from: r2(prev.v), to: r2(v), play_id: txt(p.playId) };
        }
      }
      prev = { v: v, play_id: txt(p.playId) };
    });
    var first = num(wp[0] && wp[0].homeWinPercentage);
    var last = num(wp[wp.length - 1] && wp[wp.length - 1].homeWinPercentage);
    return {
      provider: 'espn win probability',
      points: wp.length,
      opening_home_pct: first == null ? null : Math.round(first * 1000) / 10,
      closing_home_pct: last == null ? null : Math.round(last * 1000) / 10,
      largest_swing: biggest
    };
  }

  /* Player statistics, as leaders only. EdgeDesk holds no NFL player model, so
     an article that quoted a full box score would be asserting figures it has
     no way to check; the provider's own leader list is enough to name who
     carried a game and no more. */
  function leaders(summary) {
    var ls = summary && summary.leaders;
    if (!Array.isArray(ls) || !ls.length) return null;
    var out = [];
    ls.forEach(function (team) {
      var tname = txt(team.team && (team.team.displayName || team.team.abbreviation));
      ((team.leaders) || []).forEach(function (cat) {
        var top = ((cat.leaders) || [])[0];
        if (!top) return;
        out.push({
          team: tname,
          category: txt(cat.displayName || cat.name),
          athlete: txt(top.athlete && (top.athlete.displayName || top.athlete.shortName)),
          position: txt(top.athlete && top.athlete.position && top.athlete.position.abbreviation),
          line: txt(top.displayValue)
        });
      });
    });
    return out.length ? out : null;
  }

  /* --------------------------------------------- a score-only observation */
  /* nflverse / cfbfastR / the committed settlement record carry a final and
     nothing else. That is a legitimate source for the RESULT and is never
     enough for an ARTICLE, which readiness() below enforces. */
  function fromScore(o) {
    var hs = int(o && o.home_score), as = int(o && o.away_score);
    if (hs == null || as == null) return null;
    var home = { points: hs }, away = { points: as };
    crossDerive(home, away);
    return {
      provider: txt(o.provider) || 'score feed',
      event_id: txt(o.event_id),
      home_team: txt(o.home_team), away_team: txt(o.away_team),
      home_score: hs, away_score: as,
      completed: o.completed !== false,
      status_name: txt(o.status_name) || 'STATUS_FINAL',
      metrics: { home: home, away: away },
      line_scores: null, scoring_plays: null, drive_summary: null,
      win_probability: null, leaders: null, stat_fields_seen: []
    };
  }

  /* -------------------------------------------------------- reconciliation */
  /* TWO SOURCES THAT DISAGREE ABOUT A FINAL IS THE ONE CASE WHERE PUBLISHING
     IS WORSE THAN WAITING. The disagreement is recorded on the result and
     readiness() refuses it; the same rule settle_finals.js already applies to
     a graded model record. */
  function reconcile(observations, opts) {
    opts = opts || {};
    var live = (observations || []).filter(Boolean);
    if (!live.length) return { ok: false, why: 'no source carried this game', sources: [] };
    var scored = live.filter(function (o) { return o.home_score != null && o.away_score != null; });
    if (!scored.length) return { ok: false, why: 'no source carried a final score', sources: live.map(srcOf) };

    var key = function (o) { return o.home_score + '-' + o.away_score; };
    var groups = Object.create(null);
    scored.forEach(function (o) { (groups[key(o)] = groups[key(o)] || []).push(o); });
    var keys = Object.keys(groups);
    if (keys.length > 1) {
      return {
        ok: false, conflict: true,
        why: 'sources disagree about the final score: '
          + keys.map(function (k) { return k + ' (' + groups[k].map(srcOf).join(', ') + ')'; }).join(' vs '),
        sources: scored.map(srcOf),
        candidates: keys
      };
    }
    /* one agreed score. Prefer the RICHEST observation as the base — the one
       that carries statistics — and record every source that agreed. */
    var ranked = scored.slice().sort(function (a, b) {
      return Object.keys(b.metrics.home).length - Object.keys(a.metrics.home).length;
    });
    var base = ranked[0];
    var agreed = scored.map(srcOf);
    var completed = scored.some(function (o) { return o.completed === true; });
    return { ok: true, conflict: false, observation: base, agreed_by: agreed,
      completed: completed, sources: agreed };
  }
  function srcOf(o) { return txt(o && o.provider) || 'unknown'; }

  /* ------------------------------------------------------------ readiness */
  /* THE GATE. A postgame article is allowed when, and only when, all of this
     is true. Each failure is named, because "not ready" with no reason is how
     a pipeline stalls silently for a week. */
  var DEFAULTS = {
    /* the provider needs a moment after the whistle to finish the box score */
    settle_minutes: 20,
    /* how many of the metric keys below must be present on BOTH sides before
       an article can claim to explain a game */
    min_core_metrics: 5,
    core: ['total_yards', 'yards_per_play', 'third_down_pct', 'turnovers', 'first_downs',
      'net_pass_yards', 'rush_yards', 'possession_seconds']
  };
  function readiness(o, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var now = opts.now ? new Date(opts.now).getTime() : Date.now();
    var reasons = [], missing = [];
    var obs = o && o.observation;
    var snap = o && o.snapshot;

    if (!o || o.ok === false) {
      reasons.push(txt(o && o.why) || 'no usable observation of this game');
      return { ready: false, reasons: reasons, missing: missing, conflict: !!(o && o.conflict) };
    }
    if (!obs) { reasons.push('no observation'); return { ready: false, reasons: reasons, missing: missing }; }

    if (obs.completed !== true) reasons.push('no source has called the game final');
    if (obs.home_score == null || obs.away_score == null) reasons.push('the final score is incomplete');
    /* 0-0 is a results form nobody typed in, never a football game */
    if (obs.home_score === 0 && obs.away_score === 0) reasons.push('0-0 is not a football final');

    var kick = snap && snap.kickoff ? Date.parse(snap.kickoff) : (o.kickoff ? Date.parse(o.kickoff) : NaN);
    if (isFinite(kick) && now < kick) reasons.push('kickoff is still in the future');
    var settleMs = (opts.settle_minutes || 0) * 60000;
    var endedAt = o.final_seen_at ? Date.parse(o.final_seen_at) : NaN;
    if (isFinite(endedAt) && now < endedAt + settleMs) {
      reasons.push('waiting ' + opts.settle_minutes + ' minutes after the final for the box score to settle ('
        + Math.max(0, Math.ceil((endedAt + settleMs - now) / 60000)) + ' to go)');
    }

    var hm = (obs.metrics && obs.metrics.home) || {}, am = (obs.metrics && obs.metrics.away) || {};
    var have = opts.core.filter(function (k) { return hm[k] != null && am[k] != null; });
    missing = opts.core.filter(function (k) { return hm[k] == null || am[k] == null; });
    if (have.length < opts.min_core_metrics) {
      reasons.push('only ' + have.length + ' of the ' + opts.core.length
        + ' core team statistics are published on both sides; ' + opts.min_core_metrics
        + ' are required before an article may claim to explain the game');
    }

    if (!snap) {
      reasons.push('no pregame snapshot for this game — there is nothing to audit the result against');
    } else if (snap.schema && snap.snapshot_id == null) {
      reasons.push('the pregame snapshot carries no id');
    }

    return {
      ready: !reasons.length,
      reasons: reasons,
      missing_metrics: missing,
      core_metrics_present: have,
      conflict: !!o.conflict,
      settle_minutes: opts.settle_minutes
    };
  }

  /* --------------------------------------------------------- the record */
  function build(o, opts) {
    opts = opts || {};
    var obs = o.observation;
    var now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();
    return {
      schema: SCHEMA,
      key: String(opts.sport || '').toUpperCase() + ':' + String(opts.game_id),
      game_id: String(opts.game_id),
      sport: String(opts.sport || '').toUpperCase(),
      season: num(opts.season), week: num(opts.week),
      observed_at: now,
      kickoff: txt(opts.kickoff),
      final_seen_at: txt(o.final_seen_at) || null,
      home_team: txt(obs.home_team) || txt(opts.home), away_team: txt(obs.away_team) || txt(opts.away),
      home_score: obs.home_score, away_score: obs.away_score,
      completed: obs.completed === true,
      status_name: obs.status_name,
      winner: obs.home_score === obs.away_score ? null
        : (obs.home_score > obs.away_score ? (txt(obs.home_team) || txt(opts.home)) : (txt(obs.away_team) || txt(opts.away))),
      margin: obs.home_score != null && obs.away_score != null ? Math.abs(obs.home_score - obs.away_score) : null,
      total_points: obs.home_score != null && obs.away_score != null ? obs.home_score + obs.away_score : null,
      metrics: obs.metrics,
      line_scores: obs.line_scores,
      scoring_plays: obs.scoring_plays,
      drive_summary: obs.drive_summary,
      win_probability: obs.win_probability,
      leaders: obs.leaders,
      stat_fields_seen: obs.stat_fields_seen || [],
      primary_source: obs.provider,
      agreed_by: o.agreed_by || [obs.provider],
      source_notes: opts.source_notes || [],
      metric_vocabulary_version: SCHEMA
    };
  }

  /* Both sides of one metric, plus the differential, or null if either side
     is missing it. The single reader the audit uses, so "the provider did not
     publish it" is one code path rather than eleven. */
  function observed(result, metric) {
    var M = METRICS[metric];
    if (!M) return { metric: metric, available: false, why: 'not in the EdgeDesk metric vocabulary' };
    var hm = (result && result.metrics && result.metrics.home) || {};
    var am = (result && result.metrics && result.metrics.away) || {};
    var h = hm[metric] == null ? null : num(hm[metric]);
    var a = am[metric] == null ? null : num(am[metric]);
    if (h == null && a == null) {
      return { metric: metric, available: false, label: M.label, unit: M.unit,
        why: 'the box score for this game published no ' + M.label };
    }
    return {
      metric: metric, available: h != null && a != null, label: M.label, unit: M.unit,
      better: M.better, home: h, away: a,
      diff: (h != null && a != null) ? r2(h - a) : null,
      why: (h != null && a != null) ? null : 'the box score published ' + M.label + ' for only one side'
    };
  }

  /* Is the gap between two sides on one metric big enough for one game to
     mean anything? EITHER bar clears it; both are declared on the metric. */
  function atSize(metric, mine, theirs) {
    var M = METRICS[metric];
    if (!M || mine == null || theirs == null) return false;
    var d = Math.abs(mine - theirs);
    var scale = Math.max(Math.abs(mine), Math.abs(theirs), 1e-9);
    var rel = d / scale;
    var okAbs = M.abs != null && d >= M.abs;
    var okRel = M.rel != null && rel >= M.rel;
    return !!(okAbs || okRel);
  }

  return {
    SCHEMA: SCHEMA, METRICS: METRICS, DEFAULTS: DEFAULTS, atSize: atSize,
    pair: pair, clock: clock, pct: pct, statMap: statMap, sideMetrics: sideMetrics,
    crossDerive: crossDerive, normalizeSummary: normalizeSummary, fromScore: fromScore,
    scoringPlays: scoringPlays, driveSummary: driveSummary,
    winProbabilitySwings: winProbabilitySwings, leaders: leaders,
    reconcile: reconcile, readiness: readiness, build: build, observed: observed
  };
});
/*__EDED_RESULTS_END__*/
