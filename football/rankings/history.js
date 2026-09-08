/* ============================================================================
   WEEKLY HISTORY — what this board said, week by week, for ever.

   THE PROBLEM THIS FIXES. The build already wrote one snapshot per week and
   already differenced the current board against "the latest snapshot before
   this one". Two things were missing and both were visible on the page:

     1  A snapshot carried ETSR, a rank and a handful of performance numbers.
        It did NOT carry every ranking category, so "how did Texas Tech's
        special teams move between week 2 and week 3" had no answer on file
        and never would — the evidence was gone by the time anyone asked.

     2  Nothing assembled the snapshots into a SERIES. The artifact carried
        one movement object per team, so the page could show a Δ and could
        show nothing else. Preseason, week 1, week 2, week 3 existed on disk
        as separate files no reader could reach.

   WHAT A SNAPSHOT IS. An immutable record of (season, week ordinal, team,
   rating version). The week the board currently stands at is refreshed as its
   games land; every earlier week is finished and is never rewritten. That is
   what makes the series worth reading: a history you are allowed to edit is
   not a history.

   Δ WEEK is differenced against the latest snapshot STRICTLY BEFORE the
   current ordinal — not against "the file with the previous number", because a
   bye, a cancelled Saturday or a build that did not run leaves a gap, and the
   comparison across that gap is still the honest one. The ordinal actually
   compared against ships beside every delta, so a Δ over two weeks is never
   read as a Δ over one.

   Runs in the browser (window.EDRankHistory) and in node.
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDRankConfig;
  var api = factory(cfg);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG) {
  'use strict';

  var SCHEMA = 'edgedesk_rankings_history_v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r2(v) { return isNum(v) ? Math.round(v * 100) / 100 : null; }

  /* the categories a snapshot must carry: every ranking on the board, so a
     category added to config.js is in the history the first week it exists */
  function categories() {
    var out = [], i;
    for (i = 0; i < CFG.RANKINGS.length; i++) out.push(CFG.RANKINGS[i].id);
    return out;
  }

  /* --------------------------------------------------------------------
     ONE TEAM'S ROW INSIDE A SNAPSHOT
     Small on purpose — this file is written every week for ever — but
     complete: every category's rating AND its rank.
     -------------------------------------------------------------------- */
  function snapshotTeam(team) {
    var cats = categories(), out = {}, i;
    for (i = 0; i < cats.length; i++) {
      var c = cats[i];
      var r = team.ranks && team.ranks[c];
      if (!r) { continue; }
      out[c] = [r.value == null ? null : r2(r.value), r.rank == null ? null : r.rank];
    }
    return {
      etsr: team.etsr, rank: team.rank,
      confidence: team.confidence ? team.confidence.value : null,
      /* the components ETSR itself was assembled from, so a movement can be
         explained rather than only measured */
      talent: { rating: team.talent ? team.talent.rating : null },
      weights: { performance: team.weights ? team.weights.performance : null },
      performance: team.performance ? {
        rating: team.performance.rating, offense: team.performance.offense,
        defense: team.performance.defense, special_teams: team.performance.special_teams,
        run_offense: team.performance.run_offense, pass_offense: team.performance.pass_offense,
        run_defense: team.performance.run_defense, pass_defense: team.performance.pass_defense,
        opponent_delta: team.performance.opponent_delta
      } : null,
      run_defence_power: { score: team.run_defence_power ? team.run_defence_power.score : null },
      availability: { rating: team.availability ? team.availability.rating : null },
      /* [value, rank] per category — the whole board, per team, per week */
      cat: out,
      gates: (team.gates || []).map(function (g) { return g.id; })
    };
  }

  /* --------------------------------------------------------------------
     THE SERIES
     `snaps` is [{season, week_ordinal, week_label, season_type, generated_at,
     versions, teams}], in any order. Returns one series per team, oldest
     first, plus the delta against the immediately preceding entry.
     -------------------------------------------------------------------- */
  function order(snaps) {
    return (snaps || []).slice().sort(function (a, b) {
      if (a.season !== b.season) return a.season - b.season;
      return (a.week_ordinal || 0) - (b.week_ordinal || 0);
    });
  }

  function seriesFor(teamKey, snaps, opts) {
    opts = opts || {};
    var cats = categories();
    var list = order(snaps), out = [], i, j;
    for (i = 0; i < list.length; i++) {
      var s = list[i], t = s.teams && s.teams[teamKey];
      if (!t) continue;
      var row = {
        season: s.season, week_ordinal: s.week_ordinal,
        week: s.week == null ? null : s.week,
        week_label: s.week_label || (s.week_ordinal === CFG.HISTORY.preseason_ordinal ? 'Preseason' : ('Week ' + s.week_ordinal)),
        season_type: s.season_type || 'regular',
        generated_at: s.generated_at || null,
        rating_version: (s.versions && s.versions.team_rating) || null,
        etsr: t.etsr, rank: t.rank, confidence: t.confidence,
        categories: {}
      };
      for (j = 0; j < cats.length; j++) {
        var c = cats[j];
        var v = null, rk = null;
        if (t.cat && t.cat[c]) { v = t.cat[c][0]; rk = t.cat[c][1]; }
        else if (c === 'overall') { v = t.etsr; rk = t.rank; }
        row.categories[c] = { value: v, rank: rk };
      }
      out.push(row);
    }
    /* deltas against the PREVIOUS ENTRY IN THIS SERIES, whatever gap sits
       between them, with the gap stated */
    for (i = 1; i < out.length; i++) {
      var prev = out[i - 1], cur = out[i];
      cur.previous = { season: prev.season, week_ordinal: prev.week_ordinal, week_label: prev.week_label,
        weeks_between: (cur.season === prev.season) ? (cur.week_ordinal - prev.week_ordinal) : null };
      cur.delta = { etsr: (isNum(cur.etsr) && isNum(prev.etsr)) ? r2(cur.etsr - prev.etsr) : null,
        rank: (isNum(cur.rank) && isNum(prev.rank)) ? (prev.rank - cur.rank) : null, categories: {} };
      for (j = 0; j < cats.length; j++) {
        var cc = cats[j];
        var a = cur.categories[cc], b = prev.categories[cc];
        cur.delta.categories[cc] = {
          value: (isNum(a.value) && isNum(b.value)) ? r2(a.value - b.value) : null,
          rank: (isNum(a.rank) && isNum(b.rank)) ? (b.rank - a.rank) : null
        };
      }
    }
    if (out.length) {
      out[0].previous = null;
      out[0].delta = null;
      out[0].first_entry_note = 'the first week this team appears on the board — there is nothing before it to difference against, and an invented zero would read as "did not move"';
    }
    return out;
  }

  /* every team's series in one pass, for the published artifact */
  function build(snaps, teamKeys, opts) {
    opts = opts || {};
    var list = order(snaps), out = {}, i;
    for (i = 0; i < teamKeys.length; i++) {
      var s = seriesFor(teamKeys[i], list, opts);
      if (s.length) out[teamKeys[i]] = s;
    }
    return {
      schema: SCHEMA,
      contract: CFG.HISTORY,
      categories: categories(),
      snapshots: list.map(function (s) {
        return { season: s.season, week_ordinal: s.week_ordinal, week_label: s.week_label,
          season_type: s.season_type || 'regular', generated_at: s.generated_at || null,
          team_count: s.teams ? Object.keys(s.teams).length : 0,
          rating_version: (s.versions && s.versions.team_rating) || null };
      }),
      teams: out
    };
  }

  /* the entry Δ-week must be measured against: the latest snapshot strictly
     before (season, ordinal). One place, so the build and the page cannot
     disagree about which week "last week" was. */
  function previousSnapshot(snaps, season, ordinal) {
    var list = order(snaps), best = null, i;
    for (i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.season > season) continue;
      if (s.season === season && (s.week_ordinal || 0) >= ordinal) continue;
      best = s;
    }
    return best;
  }

  return { SCHEMA: SCHEMA, categories: categories, snapshotTeam: snapshotTeam,
    seriesFor: seriesFor, build: build, previousSnapshot: previousSnapshot, order: order,
    config: CFG };
});
