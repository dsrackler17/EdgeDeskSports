/* ============================================================================
   CURRENT-SEASON PERFORMANCE — how well a team has actually played, adjusted
   for who it played, weighted for when it played them, with garbage time
   filtered out and the filter left auditable.

   THIS IS NOT A RECORD, AND IT IS NOT POINTS SCORED.
   Points are the noisiest thing on a scoreboard: they carry field position,
   turnover luck, garbage time and special-teams variance in one number. This
   layer reads the plays instead — success rate, explosive rate, yards per
   play, conversion rate, sacks, stuffs — and then asks the only question that
   makes any of it comparable: WHO WAS ON THE OTHER SIDE?

   THREE THINGS IT REFUSES TO DO

   1  IT DOES NOT CLAIM AN EPA. The public play table carries no next-score
      information and the expected-points surface this repo once fitted is no
      longer reproducible from public files. Rather than invent one, this layer
      measures the components EPA is mostly made of, directly, and says so.

   2  IT DOES NOT TREAT A 50-POINT WIN OVER AN FCS TEAM AS FOOTBALL EVIDENCE
      AT FULL PRICE. Every non-FBS opponent shares one pooled identity that is
      SOLVED FOR like any other team, the game is weighted at 45%, and a team
      whose sample is mostly non-FBS has its confidence cut and a gate raised.

   3  IT DOES NOT DELETE DATA IT DISLIKES. Garbage time is filtered, but both
      the full and the competitive-only aggregates are carried through, both are
      published, and the difference between them is a column.

   Runs in the browser (window.EDRankPerformance) and in node.
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDRankConfig;
  var api = factory(cfg);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankPerformance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG) {
  'use strict';

  var SCHEMA = 'edgedesk_team_performance_v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function sd(a) {
    if (a.length < 2) return null;
    var m = mean(a), s = 0, i;
    for (i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  function wmean(vals, ws) {
    var s = 0, w = 0, i;
    for (i = 0; i < vals.length; i++) { if (!isNum(vals[i]) || !isNum(ws[i])) continue; s += vals[i] * ws[i]; w += ws[i]; }
    return w > 0 ? s / w : null;
  }

  /* Derived counters the metric contract asks for but the raw aggregate does
     not carry as a single field. Kept here, once, so nothing re-derives them. */
  function field(agg, key) {
    if (!agg) return null;
    if (key === 'plays_all') return (agg.rush_att || 0) + (agg.dropbacks || 0);
    if (key === 'success_all') return (agg.rush_success || 0) + (agg.pass_success || 0);
    return num(agg[key]);
  }

  /* ---------------------------------------------------------------------
     1. GAME ROWS
     One row per team-game, carrying the aggregate the caller chose (full or
     competitive-only), the opponent, and the weight this game gets.
     --------------------------------------------------------------------- */
  function gameRows(teamGames, opts) {
    opts = opts || {};
    var fbs = opts.fbs || {};
    var useCompetitive = opts.competitive !== false;
    var POOL = CFG.OPPONENT.fcs_pooled_key;
    var rows = [], seen = {}, dupes = [];

    var list = [];
    teamGames.forEach ? teamGames.forEach(function (tg) { list.push(tg); }) : (list = teamGames);
    /* order each team's games so recency can be counted in GAMES, not weeks —
       a bye week is not a football event and must not decay anything */
    list.sort(function (a, b) { return (a.week || 0) - (b.week || 0); });

    var byTeam = {};
    for (var i = 0; i < list.length; i++) {
      var tg = list[i];
      if (!tg || !tg.team) continue;
      var dk = tg.team + '|' + tg.game_id;
      if (seen[dk]) { dupes.push(dk); continue; }        /* a duplicated game is dropped, and named */
      seen[dk] = 1;
      (byTeam[tg.team] = byTeam[tg.team] || []).push(tg);
    }
    var teamKeys = Object.keys(byTeam);
    for (var t = 0; t < teamKeys.length; t++) {
      var games = byTeam[teamKeys[t]];
      var n = games.length;
      for (var g = 0; g < n; g++) {
        var tg2 = games[g];
        var agesAgo = (n - 1) - g;                        /* 0 = most recent */
        var decay = Math.pow(0.5, agesAgo / CFG.RECENCY.half_life_games);
        var recency = Math.max(CFG.RECENCY.floor, decay);
        var oppIsFbs = !!fbs[tg2.opp];
        var w = recency * (oppIsFbs ? 1 : CFG.NON_FBS.game_weight);
        var agg = (useCompetitive && tg2.comp && (tg2.comp.rush_att || tg2.comp.dropbacks)) ? tg2.comp : tg2.off;
        rows.push({
          game_id: tg2.game_id, week: tg2.week, team: fbs[tg2.team] ? tg2.team : POOL,
          opp: oppIsFbs ? tg2.opp : POOL, team_is_fbs: !!fbs[tg2.team], opp_is_fbs: oppIsFbs,
          games_ago: agesAgo, recency: recency, weight: w,
          agg: agg, full: tg2.off, competitive: tg2.comp || null,
          garbage_plays: tg2.garbage_plays || 0
        });
      }
    }
    return { rows: rows, duplicate_team_games: dupes };
  }

  /* ---------------------------------------------------------------------
     2. OPPONENT ADJUSTMENT
     A fixed point, iterated to CONVERGENCE rather than to a round number of
     passes, with a small pull toward the league mean on every pass so that two
     teams who only play each other cannot inflate one another without bound.
     --------------------------------------------------------------------- */
  function adjust(rows, metric, opts) {
    opts = opts || {};
    var O = CFG.OPPONENT;
    var use = [], sumN = 0, sumD = 0, i;
    for (i = 0; i < rows.length; i++) {
      var nu = field(rows[i].agg, metric.num), de = field(rows[i].agg, metric.den);
      if (!(de > 0) || nu == null) continue;
      use.push({ off: rows[i].team, def: rows[i].opp, r: nu / de, d: de * rows[i].weight, raw_d: de });
      sumN += nu; sumD += de;
    }
    if (!use.length || !(sumD > 0)) {
      return { available: false, metric: metric.id,
        reason: 'no team-game supplied both a numerator and a denominator for ' + metric.id };
    }
    var league = sumN / sumD;
    var OFF = {}, DEF = {};
    for (i = 0; i < use.length; i++) { OFF[use[i].off] = league; DEF[use[i].def] = league; }

    /* relative to the metric's own scale — see OPPONENT.tolerance_basis */
    var tol = O.tolerance * Math.max(Math.abs(league), 1e-6);
    var it = 0, movement = Infinity;
    for (it = 0; it < O.max_iterations && movement > tol; it++) {
      var on = {}, ow = {}, dn = {}, dw = {}, k;
      for (i = 0; i < use.length; i++) {
        var u = use[i];
        var dAdj = (DEF[u.def] == null ? league : DEF[u.def]) - league;
        var oAdj = (OFF[u.off] == null ? league : OFF[u.off]) - league;
        on[u.off] = (on[u.off] || 0) + (u.r - dAdj) * u.d; ow[u.off] = (ow[u.off] || 0) + u.d;
        dn[u.def] = (dn[u.def] || 0) + (u.r - oAdj) * u.d; dw[u.def] = (dw[u.def] || 0) + u.d;
      }
      movement = 0;
      for (k in on) {
        if (!(ow[k] > 0)) continue;
        var nv = league + (on[k] / ow[k] - league) * O.shrink_per_iteration;
        movement = Math.max(movement, Math.abs(nv - OFF[k]));
        OFF[k] = nv;
      }
      for (k in dn) {
        if (!(dw[k] > 0)) continue;
        var nv2 = league + (dn[k] / dw[k] - league) * O.shrink_per_iteration;
        movement = Math.max(movement, Math.abs(nv2 - DEF[k]));
        DEF[k] = nv2;
      }
    }

    /* the unadjusted number, for the raw / adjusted / delta triple */
    var rawOff = {}, rawOffW = {}, rawDef = {}, rawDefW = {};
    for (i = 0; i < use.length; i++) {
      rawOff[use[i].off] = (rawOff[use[i].off] || 0) + use[i].r * use[i].d;
      rawOffW[use[i].off] = (rawOffW[use[i].off] || 0) + use[i].d;
      rawDef[use[i].def] = (rawDef[use[i].def] || 0) + use[i].r * use[i].d;
      rawDefW[use[i].def] = (rawDefW[use[i].def] || 0) + use[i].d;
    }
    var offOut = {}, defOut = {};
    for (var ko in OFF) offOut[ko] = { raw: rawOffW[ko] > 0 ? rawOff[ko] / rawOffW[ko] : null, adjusted: OFF[ko], n: rawOffW[ko] };
    for (var kd in DEF) defOut[kd] = { raw: rawDefW[kd] > 0 ? rawDef[kd] / rawDefW[kd] : null, adjusted: DEF[kd], n: rawDefW[kd] };
    for (var k2 in offOut) offOut[k2].delta = (offOut[k2].raw == null) ? null : offOut[k2].adjusted - offOut[k2].raw;
    for (var k3 in defOut) defOut[k3].delta = (defOut[k3].raw == null) ? null : defOut[k3].adjusted - defOut[k3].raw;

    return {
      available: true, metric: metric.id, league: league,
      offense: offOut, defense: defOut,
      rows: use.length, iterations: it, final_movement: movement,
      tolerance: tol, converged: movement <= tol,
      basis: O.basis
    };
  }

  /* ---------------------------------------------------------------------
     3. THE COMPOSITE
     --------------------------------------------------------------------- */
  function standardise(values) {
    var vals = [], k;
    for (k in values) if (isNum(values[k])) vals.push(values[k]);
    var m = mean(vals), s = sd(vals);
    return { mean: m, sd: s, n: vals.length, usable: !!(s > 0 && vals.length >= 12) };
  }

  function composite(teamKeys, adjusted, metrics, side, opts) {
    opts = opts || {};
    var out = {}, stats = {}, i, k;
    /* one standardisation per metric, over the FBS population only */
    for (i = 0; i < metrics.length; i++) {
      var m = metrics[i], a = adjusted[m.id];
      if (!a || !a.available) { stats[m.id] = { usable: false, reason: (a && a.reason) || 'metric not adjusted' }; continue; }
      var src = a[side];
      var vals = {};
      for (k = 0; k < teamKeys.length; k++) {
        var rec = src[teamKeys[k]];
        if (!rec || !isNum(rec.adjusted) || !(rec.n >= m.min_n)) continue;
        vals[teamKeys[k]] = rec.adjusted;
      }
      var st = standardise(vals);
      st.league = a.league;
      st.reason = st.usable ? null : 'only ' + st.n + ' teams cleared the ' + m.min_n + ' minimum sample for ' + m.id + ' — too few to standardise against';
      stats[m.id] = st;
    }
    for (k = 0; k < teamKeys.length; k++) {
      var key = teamKeys[k], zs = 0, ws = 0, used = [], missing = [];
      for (i = 0; i < metrics.length; i++) {
        var mm = metrics[i], aa = adjusted[mm.id], ss = stats[mm.id];
        if (!aa || !aa.available || !ss || !ss.usable) { missing.push({ id: mm.id, why: (ss && ss.reason) || 'metric unavailable' }); continue; }
        var r2 = aa[side][key];
        if (!r2 || !isNum(r2.adjusted)) { missing.push({ id: mm.id, why: 'this team has no ' + mm.id }); continue; }
        if (!(r2.n >= mm.min_n)) { missing.push({ id: mm.id, why: 'sample of ' + Math.round(r2.n) + ' is below the ' + mm.min_n + ' this metric needs' }); continue; }
        var z = ((r2.adjusted - ss.mean) / ss.sd) * mm.dir;
        if (mm.regress > 0) z = z * (1 - mm.regress);      /* measured not to repeat -> mostly regressed away */
        zs += z * mm.w; ws += mm.w;
        used.push({ id: mm.id, raw: r2.raw, adjusted: r2.adjusted, delta: r2.delta,
          n: Math.round(r2.n), z: z, w: mm.w, regressed: mm.regress || 0, league: aa.league });
      }
      out[key] = { z: ws > 0 ? zs / ws : null, used: used, missing: missing,
        contract: metrics.length, scored: used.length };
    }
    return { teams: out, stats: stats };
  }

  /* 0-100 on the same scale the player layer uses. */
  function toRating(z) {
    if (!isNum(z)) return null;
    var S = CFG.TALENT.scale;
    return Math.round(clamp(S.center + S.sd * z, S.floor, S.ceiling) * 10) / 10;
  }

  /* ---------------------------------------------------------------------
     4. BUILD
     --------------------------------------------------------------------- */
  function build(teamGames, opts) {
    opts = opts || {};
    var fbs = opts.fbs || {};
    var G = gameRows(teamGames, { fbs: fbs, competitive: opts.competitive !== false });
    var rows = G.rows;
    var POOL = CFG.OPPONENT.fcs_pooled_key;

    var teamKeys = [], seenT = {};
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].team_is_fbs) continue;
      if (!seenT[rows[i].team]) { seenT[rows[i].team] = 1; teamKeys.push(rows[i].team); }
    }

    var all = CFG.OFFENSE_METRICS.concat(CFG.DEFENSE_METRICS);
    var adjusted = {}, diagnostics = [];
    var done = {};
    for (i = 0; i < all.length; i++) {
      var m = all[i];
      var sig = m.num + '|' + m.den;
      if (!done[sig]) done[sig] = adjust(rows, m, opts);
      adjusted[m.id] = Object.assign({}, done[sig], { metric: m.id });
      if (done[sig].available) {
        diagnostics.push({ metric: m.id, iterations: done[sig].iterations,
          final_movement: done[sig].final_movement, converged: done[sig].converged, rows: done[sig].rows });
      } else diagnostics.push({ metric: m.id, available: false, reason: done[sig].reason });
    }
    /* sub-units reuse the same fixed points where the numerator/denominator
       pair already exists, and solve their own where it does not */
    var subAdj = {};
    for (var sname in CFG.SUB_UNITS) {
      if (!Object.prototype.hasOwnProperty.call(CFG.SUB_UNITS, sname)) continue;
      var su = CFG.SUB_UNITS[sname];
      for (var j = 0; j < su.metrics.length; j++) {
        var sm = su.metrics[j], sig2 = sm.num + '|' + sm.den;
        if (!done[sig2]) done[sig2] = adjust(rows, sm, opts);
        subAdj[sm.id] = Object.assign({}, done[sig2], { metric: sm.id });
      }
    }

    var off = composite(teamKeys, adjusted, CFG.OFFENSE_METRICS, 'offense');
    var def = composite(teamKeys, adjusted, CFG.DEFENSE_METRICS, 'defense');
    var subs = {};
    for (var sname2 in CFG.SUB_UNITS) {
      if (!Object.prototype.hasOwnProperty.call(CFG.SUB_UNITS, sname2)) continue;
      var su2 = CFG.SUB_UNITS[sname2];
      subs[sname2] = composite(teamKeys, subAdj, su2.metrics, su2.side === 'offense' ? 'offense' : 'defense');
    }

    /* net efficiency, standardised across the league so ETSR's scalar has one
       well-defined unit to be measured in */
    var netRaw = {}, k2;
    for (k2 = 0; k2 < teamKeys.length; k2++) {
      var key = teamKeys[k2];
      var o = off.teams[key], d = def.teams[key];
      if (!o || !d || o.z == null || d.z == null) { netRaw[key] = null; continue; }
      netRaw[key] = CFG.NET.offense_weight * o.z + CFG.NET.defense_weight * d.z;
    }
    var netStat = standardise(netRaw);

    /* per-team sample facts the confidence and the gates read */
    var sample = {};
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.team_is_fbs) continue;
      var s = sample[r.team] || (sample[r.team] = { games: 0, fbs_games: 0, weighted_games: 0,
        plays: 0, competitive_plays: 0, garbage_plays: 0, off_plays: 0, def_plays: 0, opponents: {} });
      s.games++;
      if (r.opp_is_fbs) s.fbs_games++;
      s.weighted_games += (r.opp_is_fbs ? 1 : CFG.NON_FBS.game_weight);
      s.plays += field(r.full, 'plays_all') || 0;
      s.competitive_plays += r.competitive ? (field(r.competitive, 'plays_all') || 0) : 0;
      s.garbage_plays += r.garbage_plays;
      s.off_plays += field(r.agg, 'plays_all') || 0;
      s.opponents[r.opp] = 1;
    }
    /* defensive volume faced: the same rows, from the other side */
    for (i = 0; i < rows.length; i++) {
      var r2b = rows[i];
      if (!sample[r2b.opp]) continue;
      sample[r2b.opp].def_plays += field(r2b.agg, 'plays_all') || 0;
    }

    var teams = {};
    for (k2 = 0; k2 < teamKeys.length; k2++) {
      var kk = teamKeys[k2];
      var so = off.teams[kk], sdd = def.teams[kk], sm2 = sample[kk] || { games: 0, fbs_games: 0, weighted_games: 0, plays: 0, competitive_plays: 0, garbage_plays: 0, off_plays: 0, def_plays: 0, opponents: {} };
      var netZ = (netRaw[kk] != null && netStat.usable) ? (netRaw[kk] - netStat.mean) / netStat.sd : null;
      var sub = {};
      for (var sn in subs) {
        if (!Object.prototype.hasOwnProperty.call(subs, sn)) continue;
        var st2 = subs[sn].teams[kk];
        sub[sn] = { z: st2 ? st2.z : null, rating: toRating(st2 ? st2.z : null),
          used: st2 ? st2.used : [], missing: st2 ? st2.missing : [],
          scored: st2 ? st2.scored : 0, contract: st2 ? st2.contract : 0,
          basis: CFG.SUB_UNITS[sn].basis };
      }
      teams[kk] = {
        key: kk,
        offense: { z: so ? so.z : null, rating: toRating(so ? so.z : null),
          used: so ? so.used : [], missing: so ? so.missing : [],
          scored: so ? so.scored : 0, contract: so ? so.contract : 0 },
        defense: { z: sdd ? sdd.z : null, rating: toRating(sdd ? sdd.z : null),
          used: sdd ? sdd.used : [], missing: sdd ? sdd.missing : [],
          scored: sdd ? sdd.scored : 0, contract: sdd ? sdd.contract : 0 },
        net_z: netZ, rating: toRating(netZ),
        sub_units: sub,
        sample: {
          games: sm2.games, fbs_games: sm2.fbs_games,
          fbs_equivalent_games: Math.round(sm2.weighted_games * 100) / 100,
          non_fbs_share: sm2.games ? Math.round((1 - sm2.fbs_games / sm2.games) * 1000) / 1000 : null,
          plays: sm2.plays, competitive_plays: sm2.competitive_plays,
          garbage_plays: sm2.garbage_plays,
          garbage_share: sm2.plays ? Math.round((sm2.garbage_plays / sm2.plays) * 1000) / 1000 : null,
          offensive_plays: sm2.off_plays, defensive_plays: sm2.def_plays,
          distinct_opponents: Object.keys(sm2.opponents).length
        }
      };
    }

    return {
      schema: SCHEMA, version: CFG.VERSIONS.performance,
      teams: teams,
      non_fbs_pool: {
        key: POOL,
        offense_solved: !!(adjusted.success_rate && adjusted.success_rate.available && adjusted.success_rate.offense[POOL]),
        basis: CFG.OPPONENT.fcs_basis
      },
      league: { net: netStat, offense_stats: off.stats, defense_stats: def.stats },
      diagnostics: {
        metrics: diagnostics,
        all_converged: diagnostics.every(function (d) { return d.available === false || d.converged; }),
        duplicate_team_games: G.duplicate_team_games,
        team_game_rows: rows.length,
        garbage_filter: 'competitive-only aggregates were used where a team-game had any; both the full and the competitive counts ship per team so the filter is auditable',
        recency: CFG.RECENCY, non_fbs: CFG.NON_FBS
      }
    };
  }

  return { SCHEMA: SCHEMA, build: build, adjust: adjust, gameRows: gameRows,
    composite: composite, standardise: standardise, toRating: toRating, field: field,
    mean: mean, sd: sd, wmean: wmean, config: CFG };
});
