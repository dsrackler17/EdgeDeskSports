/* ============================================================================
   SPECIAL TEAMS — the third phase of football, rated from the two feeds this
   pipeline already ingests and from nothing else.

   WHAT WAS THERE BEFORE. The rankings board carried a "Special teams" column
   that was `units.K.rating` — the KICKER ROOM out of the player-talent layer.
   That is a statement about who is on the depth chart. It cannot move when a
   team misses three field goals, it says nothing about punting, returns or
   coverage, and it was published under a label that promised all four.

   WHAT THIS FILE DOES. Two jobs, both mechanical:

     1  FIT THE EXPECTED FIELD-GOAL CURVE from the play table this build
        already loaded. Five-yard distance buckets, league make rate per
        bucket, each bucket shrunk toward its neighbours by a fixed
        pseudo-count so a thin bucket cannot return 0% or 100%. It is refitted
        every build from the seasons in the window. No table is imported and
        none is hand-written.

     2  JOIN THE BOX ROWS onto the play table's team-games. The ESPN player box
        is the only public keyless feed that carries punting, returns and
        touchbacks, and it carries them per player per game — so per TEAM per
        game. Both sides of a game are in it, which is what makes COVERAGE a
        measured event here rather than a residual: the yards the opponent
        gained returning my kickoffs are in the opponent's own row.

   WHAT IT REFUSES TO DO. It does not estimate a punt that is not in the feed,
   it does not infer a kickoff from a touchback that could have been a punt,
   and it does not fill a team's missing game with a league average. A team
   whose special-teams contract does not clear its coverage floor gets NO
   special-teams rating and a stated reason — the same treatment every other
   unit in this pipeline gets when its inputs are absent.

   The rating itself is not computed here. It is computed by performance.js,
   through the SAME opponent-adjustment fixed point, the SAME observation
   floors, the SAME reliability shrink and the SAME 0-100 scale as offence and
   defence, from the metric contract in config.js. There is one rating engine.

   Runs in the browser (window.EDRankSpecialTeams) and in node.
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDRankConfig;
  var api = factory(cfg);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankSpecialTeams = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG) {
  'use strict';

  var SCHEMA = 'edgedesk_special_teams_v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : null; }

  /* ---------------------------------------------------------------------
     1. THE EXPECTED FIELD-GOAL CURVE
     Fitted from attempts, not from a published table. `kicks` is a flat list
     of [distance_yards, made] over every team-game handed in.
     --------------------------------------------------------------------- */
  function bucketOf(dist) {
    var E = CFG.SPECIAL_TEAMS.fg_expectation;
    var d = Math.max(E.min_distance, Math.min(E.max_distance, dist));
    return Math.floor(d / E.bucket_yards) * E.bucket_yards;
  }

  function fitFgCurve(kickLists) {
    var E = CFG.SPECIAL_TEAMS.fg_expectation;
    var att = {}, made = {}, total = 0, totalMade = 0, i, j, b;
    for (i = 0; i < kickLists.length; i++) {
      var ks = kickLists[i];
      if (!ks || !ks.length) continue;
      for (j = 0; j < ks.length; j++) {
        var d = +ks[j][0];
        if (!isFinite(d) || d < E.min_distance || d > E.max_distance) continue;
        b = bucketOf(d);
        att[b] = (att[b] || 0) + 1;
        made[b] = (made[b] || 0) + (ks[j][1] ? 1 : 0);
        total++; totalMade += (ks[j][1] ? 1 : 0);
      }
    }
    if (!total) {
      return { available: false, buckets: {}, attempts: 0,
        reason: 'no field-goal attempt with a usable distance was found in the seasons this build read, so no expectation curve can be fitted and place kicking is DECLARED MISSING rather than scored on percentage' };
    }
    var league = totalMade / total;
    /* neighbour shrink: each bucket is pulled toward the mean of the buckets
       on either side of it, weighted by a fixed pseudo-count. Monotonicity is
       not imposed — the data is allowed to say something surprising — but a
       bucket holding four kicks cannot swing the rating. */
    var keys = Object.keys(att).map(Number).sort(function (a, c) { return a - c; });
    var curve = {}, detail = [];
    for (i = 0; i < keys.length; i++) {
      b = keys[i];
      var nAtt = att[b], nMade = made[b];
      var nb = [], nbA = 0, nbM = 0;
      if (i > 0) nb.push(keys[i - 1]);
      if (i < keys.length - 1) nb.push(keys[i + 1]);
      for (j = 0; j < nb.length; j++) { nbA += att[nb[j]]; nbM += made[nb[j]]; }
      var k = E.neighbour_shrink_n;
      /* the neighbourhood is itself shrunk toward the league rate by the same
         pseudo-count, so a bucket whose only neighbour holds four kicks cannot
         hand this bucket a prior of 0 or 1 */
      var prior = (nbM + k * league) / (nbA + k);
      var p = (nMade + k * prior) / (nAtt + k);
      curve[b] = r3(p);
      detail.push({ bucket: b, label: b + '-' + (b + E.bucket_yards - 1) + ' yards',
        attempts: nAtt, made: nMade, observed: r3(nAtt ? nMade / nAtt : null),
        expected: r3(p), shrunk_toward: r3(prior) });
    }
    return { available: true, buckets: curve, detail: detail, attempts: total,
      league_make_rate: r3(league), bucket_yards: E.bucket_yards,
      shrink_pseudo_attempts: E.neighbour_shrink_n,
      basis: CFG.SPECIAL_TEAMS.fg_expectation.basis };
  }

  /* the expected make probability for one kick */
  function expectedMake(curve, dist) {
    if (!curve || !curve.available) return null;
    var b = bucketOf(dist);
    if (isNum(curve.buckets[b])) return curve.buckets[b];
    /* outside every observed bucket: fall back to the nearest one that exists,
       never to a guess */
    var keys = Object.keys(curve.buckets).map(Number).sort(function (a, c) { return a - c; });
    if (!keys.length) return null;
    var best = keys[0], bestD = Math.abs(keys[0] - b), i;
    for (i = 1; i < keys.length; i++) {
      var d = Math.abs(keys[i] - b);
      if (d < bestD) { best = keys[i]; bestD = d; }
    }
    return curve.buckets[best];
  }

  /* ---------------------------------------------------------------------
     2. THE JOIN
     `teamGames` is the play table's Map (or array) of team-game records, each
     already carrying `st` with the field-goal half filled. `box` is one
     season's committed box artifact. Everything else is attached here.
     --------------------------------------------------------------------- */
  function attach(teamGames, box, opts) {
    opts = opts || {};
    var list = [];
    if (teamGames && typeof teamGames.forEach === 'function' && !Array.isArray(teamGames)) {
      teamGames.forEach(function (tg) { list.push(tg); });
    } else list = teamGames || [];

    /* the expectation curve is fitted from the games handed in — the caller
       decides whether that is one season or the whole window */
    var curve = fitFgCurve((opts.kick_source || list).map(function (tg) {
      return (tg && tg.st && tg.st.fg_kicks) || [];
    }));

    var report = {
      schema: SCHEMA, version: CFG.VERSIONS.special_teams,
      team_games: list.length, box_joined: 0, box_missing: 0,
      coverage_joined: 0, fg_scored: 0,
      curve: curve,
      box_available: !!(box && box.team_games),
      box_reason: null, columns: null
    };
    if (!report.box_available) {
      report.box_reason = box
        ? 'the box artifact for this season carries no per-team-game rows — rebuild it with football/data/build_box.js so punting, returns and coverage can be joined'
        : 'no box artifact was supplied for this season, so punting, returns and coverage are DECLARED MISSING rather than estimated';
    }

    var cols = report.box_available ? (box.team_game_columns || []) : [];
    report.columns = cols.length ? cols : null;
    var ci = {};
    for (var c = 0; c < cols.length; c++) ci[cols[c]] = c;
    function col(row, name) {
      if (!row || ci[name] == null) return null;
      var v = row[ci[name]];
      return isNum(v) ? v : null;
    }

    /* pass 1: this team's own kicking row */
    var byKey = {};
    for (var i = 0; i < list.length; i++) {
      var tg = list[i];
      if (!tg || !tg.st) continue;
      byKey[tg.game_id + '|' + tg.team] = tg;
      /* place kicking over expectation, from the play table alone */
      var ks = tg.st.fg_kicks || [];
      if (ks.length && curve.available) {
        var over = 0, scored = 0;
        for (var j = 0; j < ks.length; j++) {
          var e = expectedMake(curve, +ks[j][0]);
          if (e == null) continue;
          over += (ks[j][1] ? 1 : 0) - e;
          scored++;
        }
        if (scored > 0) { tg.st.fg_over_expected = r3(over); tg.st.fg_scored_att = scored; report.fg_scored++; }
      }
      if (!report.box_available) continue;
      var row = box.team_games[tg.game_id + '|' + tg.team];
      if (!row) { report.box_missing++; continue; }
      report.box_joined++;
      tg.st.box_joined = true;
      tg.st.xp_made = col(row, 'xp_made'); tg.st.xp_att = col(row, 'xp_att');
      tg.st.punts = col(row, 'punts'); tg.st.punt_yds = col(row, 'punt_yds');
      tg.st.punts_in20 = col(row, 'punts_in20'); tg.st.punt_touchbacks = col(row, 'touchbacks');
      tg.st.kr = col(row, 'kr'); tg.st.kr_yds = col(row, 'kr_yds');
      tg.st.pr = col(row, 'pr'); tg.st.pr_yds = col(row, 'pr_yds');
      tg.st.kr_td = col(row, 'kr_td'); tg.st.pr_td = col(row, 'pr_td');
    }

    /* pass 2: COVERAGE. The opponent's own row in the same game is what this
       team's coverage units gave up. Nothing is inferred: if the other side of
       the game is not in the feed, coverage stays null for this team-game. */
    if (report.box_available) {
      for (var k = 0; k < list.length; k++) {
        var t2 = list[k];
        if (!t2 || !t2.st || !t2.st.box_joined) continue;
        var oppRow = box.team_games[t2.game_id + '|' + t2.opp];
        if (!oppRow) continue;
        t2.st.kr_allowed = col(oppRow, 'kr');
        t2.st.kr_yds_allowed = col(oppRow, 'kr_yds');
        t2.st.punt_ret_yds_allowed = col(oppRow, 'pr_yds');
        t2.st.punt_ret_allowed = col(oppRow, 'pr');
        report.coverage_joined++;
      }
    }
    report.join_rate = list.length ? r3(report.box_joined / list.length) : null;
    report.coverage_rate = report.box_joined ? r3(report.coverage_joined / report.box_joined) : null;
    report.basis = 'field-goal distance and blocks from the cfbfastR play table; punting, extra points, returns and touchbacks from the ESPN player box, joined per team-game on the same ESPN game id both feeds are keyed on. Coverage is the OPPONENT’s row in the same game, which makes it a measured event rather than a residual.';
    report.unobservable = CFG.SPECIAL_TEAMS.unobservable;
    return report;
  }

  /* A plain-language description of what actually fed one team's rating, for
     the artifact and the page. Nothing here computes a rating. */
  function provenance(perfTeam) {
    var st = perfTeam && perfTeam.special_teams;
    if (!st) return { available: false, reason: 'this team has no special-teams record' };
    var used = (st.used || []).map(function (u) { return u.id; });
    var missing = (st.missing || []).map(function (m) { return { id: m.id, why: m.why }; });
    return {
      available: !!st.available, rating: st.rating,
      coverage: st.coverage, coverage_floor: st.coverage_floor,
      components_used: used, components_missing: missing,
      reliability: st.reliability,
      feeds: ['cfbfastR player_stats (field-goal distance, makes, blocks)',
        'sportsdataverse ESPN player box (punting, extra points, returns, touchbacks, and the opponent row that supplies coverage)'],
      unobservable: CFG.SPECIAL_TEAMS.unobservable,
      reason: st.reason || null
    };
  }

  return { SCHEMA: SCHEMA, fitFgCurve: fitFgCurve, expectedMake: expectedMake,
    bucketOf: bucketOf, attach: attach, provenance: provenance, config: CFG };
});
