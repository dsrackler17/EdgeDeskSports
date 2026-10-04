/* ============================================================================
   CURRENT-SEASON PERFORMANCE — how well a team has actually played, adjusted
   for who it played, weighted for when it played them, with garbage time
   discounted rather than deleted and the discount left auditable.

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

   3  IT DOES NOT DELETE DATA IT DISLIKES. Garbage time is DISCOUNTED, not
      dropped: the scored aggregate is the competitive one plus the garbage-time
      residual at CFG.GARBAGE.scored_weight, and the full, competitive and
      scored counts all ship per team so the constant is auditable. v1 scored
      the competitive-only aggregate and binned the rest, which in a 73-6 win
      over an FCS side threw away most of a game of football.

   4  IT DOES NOT THROW AWAY WEEK ONE. Every metric states the sample at which
      it is worth full credit (min_n). That is a CREDIT LINE, not a gate: a team
      holding a fraction of it is scored at that fraction, shrunk toward the
      league mean, with the fraction published beside the number. Only below
      CFG.SAMPLE.score_floor_fraction of the stated sample is a metric left
      unscored for a team. Read as a hard cut it meant that in September, when
      nobody has 150 plays yet, the layer returned null for all 136 teams and
      the rankings could not move on a result they had already read.

   5  IT ASKS THE FLOOR AND THE SHRINK TWO DIFFERENT QUESTIONS, because they
      ARE two different questions, and v1 asked both of them the same one.
      Every metric now carries TWO denominators:

        n_obs   how many plays/attempts were actually observed. min_n is
                stated in these units, so this is what the scoring floor is
                tested against.
        n_eff   what that evidence is WORTH once recency decay, the non-FBS
                discount and the garbage-time discount are applied. This is the
                denominator the opponent-adjustment fixed point weighs on, and
                it is what the reliability shrink is measured against.

      v1 had only n_eff and tested the floor with it. A team that beat an FCS
      side 73-6 observed 57 offensive plays, and arrived at a 30-play floor
      carrying 11 — so all eleven metrics went unscored, offence and defence
      came back null, and thirty-one teams that had played real football sat on
      the board with an em dash. The discount belongs in the shrink and in the
      confidence. It never belonged in the floor.

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

  var SCHEMA = 'edgedesk_team_performance_v2';
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
    /* NET PUNTING. Gross yards, less the return the opponent actually gained on
       those punts, less the touchback charge. Both halves are measured events
       from the same two box rows — nothing here is a residual. */
    if (key === 'punt_net_yds') {
      if (!(agg.punts > 0)) return null;
      /* the return half is NOT optional. Reading a missing opponent row as
         zero return yards would hand this punt unit a free net average, which
         is a fabrication, so the metric goes missing instead. */
      if (!isNum(num(agg.punt_ret_yds_allowed))) return null;
      return (agg.punt_yds || 0) - num(agg.punt_ret_yds_allowed)
        - (agg.punt_touchbacks || 0) * CFG.SPECIAL_TEAMS.touchback_yards;
    }
    return num(agg[key]);
  }

  /* THE SCORED AGGREGATE. Competitive football at full price, garbage time at
     CFG.GARBAGE.scored_weight, in BOTH the numerator and the denominator so the
     result is a blended rate over a discounted-but-real sample. v1 used the
     competitive aggregate alone, which deleted the rest. */
  function blendAggregate(full, comp) {
    if (!full) return comp || null;
    if (!comp) return full;
    var w = CFG.GARBAGE.scored_weight, out = {}, k;
    for (k in full) {
      if (!Object.prototype.hasOwnProperty.call(full, k)) continue;
      var f = num(full[k]), c = num(comp[k]);
      if (f == null) { out[k] = full[k]; continue; }
      if (c == null) c = 0;
      /* the garbage residual can only be >= 0: comp is a subset of full */
      out[k] = c + w * Math.max(0, f - c);
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     1. GAME ROWS
     One row per team-game, carrying the SCORED aggregate (competitive plus
     discounted garbage time), the full and competitive aggregates it was built
     from, the special-teams aggregate where one was joined, the opponent, and
     the weight this game gets.
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
        var hasComp = !!(tg2.comp && (tg2.comp.rush_att || tg2.comp.dropbacks));
        var agg = (useCompetitive && hasComp) ? blendAggregate(tg2.off, tg2.comp) : tg2.off;
        rows.push({
          game_id: tg2.game_id, week: tg2.week, team: fbs[tg2.team] ? tg2.team : POOL,
          opp: oppIsFbs ? tg2.opp : POOL, team_is_fbs: !!fbs[tg2.team], opp_is_fbs: oppIsFbs,
          games_ago: agesAgo, recency: recency, weight: w,
          /* A game the BOX carries and the play table does not is a game that
             was played, with a kicking line and no scrimmage plays. It counts
             as a game; it supplies no performance evidence, and must not raise
             the weight this season carries in ETSR. */
          play_evidence: tg2.play_evidence !== false,
          agg: agg, full: tg2.off, competitive: tg2.comp || null,
          /* special teams is joined per team-game from the box feed and is not
             split by game state — no public feed says which kick was garbage
             time — so it is carried whole and weighted like everything else */
          st: tg2.st || null,
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
    /* A metric names the aggregate it reads. Offence and defence read the
       scored play aggregate; special teams reads the special-teams one. */
    var src = metric.src === 'st' ? 'st' : 'agg';
    var use = [], sumN = 0, sumD = 0, i;
    for (i = 0; i < rows.length; i++) {
      var from = rows[i][src];
      if (!from) continue;
      var nu = field(from, metric.num), de = field(from, metric.den);
      if (!(de > 0) || nu == null) continue;
      /* d is the WEIGHTED evidence the fixed point balances on; raw_d is the
         OBSERVATIONS. They are different questions and are kept apart. */
      use.push({ off: rows[i].team, def: rows[i].opp, r: nu / de, d: de * rows[i].weight, raw_d: de });
      sumN += nu; sumD += de;
    }
    if (!use.length || !(sumD > 0)) {
      return { available: false, metric: metric.id,
        reason: 'no team-game supplied both a numerator and a denominator for ' + metric.id
          + (src === 'st' ? ' — the special-teams feed reached none of these games' : '') };
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

    /* the unadjusted number, for the raw / adjusted / delta triple, plus the
       two denominators the floor and the shrink each need */
    var rawOff = {}, rawOffW = {}, rawDef = {}, rawDefW = {}, obsOff = {}, obsDef = {};
    for (i = 0; i < use.length; i++) {
      rawOff[use[i].off] = (rawOff[use[i].off] || 0) + use[i].r * use[i].d;
      rawOffW[use[i].off] = (rawOffW[use[i].off] || 0) + use[i].d;
      obsOff[use[i].off] = (obsOff[use[i].off] || 0) + use[i].raw_d;
      rawDef[use[i].def] = (rawDef[use[i].def] || 0) + use[i].r * use[i].d;
      rawDefW[use[i].def] = (rawDefW[use[i].def] || 0) + use[i].d;
      obsDef[use[i].def] = (obsDef[use[i].def] || 0) + use[i].raw_d;
    }
    var offOut = {}, defOut = {};
    for (var ko in OFF) offOut[ko] = { raw: rawOffW[ko] > 0 ? rawOff[ko] / rawOffW[ko] : null,
      adjusted: OFF[ko], n: rawOffW[ko], n_obs: obsOff[ko] || 0 };
    for (var kd in DEF) defOut[kd] = { raw: rawDefW[kd] > 0 ? rawDef[kd] / rawDefW[kd] : null,
      adjusted: DEF[kd], n: rawDefW[kd], n_obs: obsDef[kd] || 0 };
    for (var k2 in offOut) offOut[k2].delta = (offOut[k2].raw == null) ? null : offOut[k2].adjusted - offOut[k2].raw;
    for (var k3 in defOut) defOut[k3].delta = (defOut[k3].raw == null) ? null : defOut[k3].adjusted - defOut[k3].raw;

    return {
      available: true, metric: metric.id, source: src, league: league,
      offense: offOut, defense: defOut,
      rows: use.length, iterations: it, final_movement: movement,
      tolerance: tol, converged: movement <= tol,
      denominator_basis: CFG.SAMPLE.floor_on_basis,
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
    var minTeams = (CFG.SAMPLE && CFG.SAMPLE.standardise_min_teams) || 12;
    return { mean: m, sd: s, n: vals.length, usable: !!(s > 0 && vals.length >= minTeams) };
  }

  /* How much of a metric's stated sample this team actually has. Full credit at
     min_n, proportional below it, and nothing at all below the floor — the
     whole argument is in CFG.SAMPLE. */
  function scoreFloor(metric) {
    /* a metric may state its floor in EVENTS instead of as a fraction of
       min_n — see CFG.SPECIAL_TEAMS, where a fifth of a season's kicks would
       be November */
    if (isNum(metric.floor_n)) return metric.floor_n;
    var f = (CFG.SAMPLE && CFG.SAMPLE.score_floor_fraction);
    return metric.min_n * (isNum(f) ? f : 1);
  }
  function reliability(n, metric) {
    if (!isNum(n) || !(metric.min_n > 0)) return 0;
    return clamp(n / metric.min_n, 0, 1);
  }

  /* The floor is asked of the OBSERVATIONS. n_obs is what a metric's min_n is
     stated in; n (the weighted evidence) is what the shrink is measured
     against. An older build tested the floor with n and deleted ratings that a
     whole game of football supported — see the header, point 5. */
  function observations(rec) {
    if (!rec) return 0;
    return isNum(rec.n_obs) ? rec.n_obs : (isNum(rec.n) ? rec.n : 0);
  }

  function composite(teamKeys, adjusted, metrics, side, opts) {
    opts = opts || {};
    var out = {}, stats = {}, i, k;
    /* one standardisation per metric, over the FBS population only */
    for (i = 0; i < metrics.length; i++) {
      var m = metrics[i], a = adjusted[m.id];
      if (!a || !a.available) { stats[m.id] = { usable: false, reason: (a && a.reason) || 'metric not adjusted' }; continue; }
      var src = a[side];
      var floorN = scoreFloor(m);
      var vals = {};
      for (k = 0; k < teamKeys.length; k++) {
        var rec = src[teamKeys[k]];
        if (!rec || !isNum(rec.adjusted) || !(observations(rec) >= floorN)) continue;
        vals[teamKeys[k]] = rec.adjusted;
      }
      var st = standardise(vals);
      st.league = a.league;
      st.min_n = m.min_n;
      st.score_floor = Math.round(floorN * 10) / 10;
      st.reason = st.usable ? null : 'only ' + st.n + ' teams observed the ' + (Math.round(floorN * 10) / 10)
        + ' the scoring floor for ' + m.id + ' asks for ('
        + Math.round(CFG.SAMPLE.score_floor_fraction * 100) + '% of the ' + m.min_n
        + ' it is worth full credit at) — too few to standardise against';
      stats[m.id] = st;
    }
    for (k = 0; k < teamKeys.length; k++) {
      var key = teamKeys[k], zs = 0, ws = 0, relSum = 0, scoredW = 0, used = [], missing = [];
      var contractW = 0;
      for (i = 0; i < metrics.length; i++) contractW += metrics[i].w;
      for (i = 0; i < metrics.length; i++) {
        var mm = metrics[i], aa = adjusted[mm.id], ss = stats[mm.id];
        if (!aa || !aa.available || !ss || !ss.usable) { missing.push({ id: mm.id, why: (ss && ss.reason) || 'metric unavailable' }); continue; }
        var r2 = aa[side][key];
        if (!r2 || !isNum(r2.adjusted)) { missing.push({ id: mm.id, why: 'this team has no ' + mm.id }); continue; }
        var fl = scoreFloor(mm);
        var nObs = observations(r2);
        if (!(nObs >= fl)) {
          missing.push({ id: mm.id, why: 'only ' + Math.round(nObs) + ' observed, below the '
            + (Math.round(fl * 10) / 10) + ' this metric needs before it means anything',
            n_obs: Math.round(nObs), floor: Math.round(fl * 10) / 10 });
          continue;
        }
        /* the shrink reads the WEIGHTED evidence: a non-FBS game, an old game
           and a garbage-time snap are all worth less, and that is priced HERE,
           by pulling the number toward the league mean — never by deleting it */
        var rel = reliability(r2.n, mm);
        var z = ((r2.adjusted - ss.mean) / ss.sd) * mm.dir;
        if (mm.regress > 0) z = z * (1 - mm.regress);      /* measured not to repeat -> mostly regressed away */
        z = z * rel;                                        /* a partial sample is shrunk toward the league mean, not thrown away */
        zs += z * mm.w; ws += mm.w; relSum += rel * mm.w; scoredW += mm.w;
        used.push({ id: mm.id, raw: r2.raw, adjusted: r2.adjusted, delta: r2.delta,
          n: Math.round(r2.n * 10) / 10, n_obs: Math.round(nObs), z: z, w: mm.w, regressed: mm.regress || 0,
          reliability: Math.round(rel * 1000) / 1000, full_credit_at: mm.min_n, league: aa.league });
      }
      out[key] = { z: ws > 0 ? zs / ws : null, used: used, missing: missing,
        contract: metrics.length, scored: used.length,
        contract_weight: Math.round(contractW * 1000) / 1000,
        scored_weight: Math.round(scoredW * 1000) / 1000,
        coverage: contractW > 0 ? Math.round((scoredW / contractW) * 1000) / 1000 : null,
        reliability: ws > 0 ? Math.round((relSum / ws) * 1000) / 1000 : null,
        reliability_basis: CFG.SAMPLE && CFG.SAMPLE.reliability_basis };
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

    /* SPECIAL TEAMS. Its own aggregate, its own contract, the SAME fixed point
       and the SAME standardisation as everything else — one rating engine. */
    var stAdj = {}, stAvailable = 0;
    for (var si = 0; si < CFG.SPECIAL_TEAMS.metrics.length; si++) {
      var stm = CFG.SPECIAL_TEAMS.metrics[si];
      var stSig = 'st|' + stm.num + '|' + stm.den;
      if (!done[stSig]) done[stSig] = adjust(rows, stm, opts);
      stAdj[stm.id] = Object.assign({}, done[stSig], { metric: stm.id });
      if (done[stSig].available) stAvailable++;
      diagnostics.push(done[stSig].available
        ? { metric: stm.id, unit: 'special_teams', iterations: done[stSig].iterations,
            final_movement: done[stSig].final_movement, converged: done[stSig].converged, rows: done[stSig].rows }
        : { metric: stm.id, unit: 'special_teams', available: false, reason: done[stSig].reason });
    }

    var off = composite(teamKeys, adjusted, CFG.OFFENSE_METRICS, 'offense');
    var def = composite(teamKeys, adjusted, CFG.DEFENSE_METRICS, 'defense');
    var st = composite(teamKeys, stAdj, CFG.SPECIAL_TEAMS.metrics, 'offense');
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

    /* THE SHRINK HAS TO SURVIVE THE SECOND STANDARDISATION.
       net_z is re-standardised across the league so that ETSR's points-per-z
       scalar has one well-defined unit. Re-standardising a set of already
       shrunk numbers rescales them straight back to unit variance — which in
       week one turned a team that hung 60 on somebody into a +4z season. So
       the team's own sample reliability is re-applied AFTER the league z, and
       it is the reliability of the two sides mixed on the same weights the net
       itself uses. */
    var netRel = {};
    for (k2 = 0; k2 < teamKeys.length; k2++) {
      var kr = teamKeys[k2];
      var ro = off.teams[kr] && off.teams[kr].reliability, rd = def.teams[kr] && def.teams[kr].reliability;
      netRel[kr] = (isNum(ro) && isNum(rd))
        ? clamp(CFG.NET.offense_weight * ro + CFG.NET.defense_weight * rd, 0, 1)
        : (isNum(ro) ? ro : (isNum(rd) ? rd : null));
    }

    /* per-team sample facts the confidence and the gates read */
    var sample = {};
    function blankSample() {
      return { games: 0, games_played: 0, box_only_games: 0, fbs_games: 0, weighted_games: 0,
        plays: 0, competitive_plays: 0, garbage_plays: 0, scored_plays: 0,
        off_plays: 0, def_plays: 0, opponents: {},
        st_games: 0, fg_att: 0, fg_att_box: 0, punts: 0, kick_returns: 0, punt_returns: 0, xp_att: 0 };
    }
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.team_is_fbs) continue;
      var s = sample[r.team] || (sample[r.team] = blankSample());
      /* GAMES PLAYED and GAMES THE PERFORMANCE LAYER COULD READ are two
         different counts, and conflating them is how a team that played on
         Sunday reads as a team that has not played. `games` prices the
         performance evidence and drives the ETSR ramp and the confidence;
         `games_played` is the fact. */
      s.games_played++;
      if (!r.play_evidence) { s.box_only_games++; }
      else {
        s.games++;
        if (r.opp_is_fbs) s.fbs_games++;
        s.weighted_games += (r.opp_is_fbs ? 1 : CFG.NON_FBS.game_weight);
      }
      /* the three play counts ship side by side so the garbage-time discount
         is arithmetic anybody can redo: scored = competitive + w x garbage */
      s.plays += field(r.full, 'plays_all') || 0;
      s.competitive_plays += r.competitive ? (field(r.competitive, 'plays_all') || 0) : 0;
      s.garbage_plays += r.garbage_plays;
      s.scored_plays += field(r.agg, 'plays_all') || 0;
      s.off_plays += field(r.agg, 'plays_all') || 0;
      if (r.play_evidence) s.opponents[r.opp] = 1;
      if (r.st) {
        s.st_games++;
        s.fg_att += num(r.st.fg_att) || 0;
        s.fg_att_box += num(r.st.fg_att_box) || 0;
        s.punts += num(r.st.punts) || 0;
        s.kick_returns += num(r.st.kr) || 0;
        s.punt_returns += num(r.st.pr) || 0;
        s.xp_att += num(r.st.xp_att) || 0;
      }
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
      var so = off.teams[kk], sdd = def.teams[kk], sm2 = sample[kk] || blankSample();
      var netZraw = (netRaw[kk] != null && netStat.usable) ? (netRaw[kk] - netStat.mean) / netStat.sd : null;
      var netRelK = netRel[kk];
      var netZ = (netZraw == null) ? null : netZraw * (isNum(netRelK) ? netRelK : 0);
      var sub = {};
      for (var sn in subs) {
        if (!Object.prototype.hasOwnProperty.call(subs, sn)) continue;
        var st2 = subs[sn].teams[kk];
        sub[sn] = { z: st2 ? st2.z : null, rating: toRating(st2 ? st2.z : null),
          used: st2 ? st2.used : [], missing: st2 ? st2.missing : [],
          scored: st2 ? st2.scored : 0, contract: st2 ? st2.contract : 0,
          basis: CFG.SUB_UNITS[sn].basis };
      }
      /* SPECIAL TEAMS gets a coverage floor of its own: unlike offence, whose
         eleven metrics all describe the same thing, one punt-return average is
         not a special-teams rating and must not be published under that name. */
      var stT = st.teams[kk];
      var stCov = stT && isNum(stT.coverage) ? stT.coverage : 0;
      var stOk = !!(stT && stT.z != null && stCov >= CFG.SPECIAL_TEAMS.coverage_floor);
      var special = {
        z: stOk ? stT.z : null,
        rating: stOk ? toRating(stT.z) : null,
        available: stOk,
        coverage: stT ? stT.coverage : null,
        coverage_floor: CFG.SPECIAL_TEAMS.coverage_floor,
        used: stT ? stT.used : [], missing: stT ? stT.missing : [],
        scored: stT ? stT.scored : 0, contract: stT ? stT.contract : 0,
        reliability: stT ? stT.reliability : null,
        reason: stOk ? null : (stT && stT.z == null
          ? 'no special-teams metric cleared its observation floor for this team — the kicking, punting and return feeds reached none of its games'
          : 'the special-teams contract scored ' + Math.round(stCov * 100) + '% of its weight, below the '
            + Math.round(CFG.SPECIAL_TEAMS.coverage_floor * 100) + '% floor. '
            + CFG.SPECIAL_TEAMS.coverage_floor_basis),
        basis: 'place kicking over expectation by distance, net punting, kickoff coverage, punt and kick returns, punts inside the 20, extra points and blocked kicks — opponent-adjusted and standardised on the same 0-100 scale as every other unit here',
        unobservable: CFG.SPECIAL_TEAMS.unobservable
      };
      teams[kk] = {
        key: kk,
        offense: { z: so ? so.z : null, rating: toRating(so ? so.z : null),
          used: so ? so.used : [], missing: so ? so.missing : [],
          coverage: so ? so.coverage : null,
          scored: so ? so.scored : 0, contract: so ? so.contract : 0 },
        defense: { z: sdd ? sdd.z : null, rating: toRating(sdd ? sdd.z : null),
          used: sdd ? sdd.used : [], missing: sdd ? sdd.missing : [],
          coverage: sdd ? sdd.coverage : null,
          scored: sdd ? sdd.scored : 0, contract: sdd ? sdd.contract : 0 },
        special_teams: special,
        net_z: netZ, rating: toRating(netZ),
        net_z_before_reliability: netZraw == null ? null : Math.round(netZraw * 1000) / 1000,
        reliability: isNum(netRelK) ? Math.round(netRelK * 1000) / 1000 : null,
        reliability_basis: CFG.SAMPLE.reliability_basis,
        sub_units: sub,
        sample: {
          games: sm2.games, fbs_games: sm2.fbs_games,
          /* the fact, and the evidence, side by side */
          games_played: sm2.games_played,
          box_only_games: sm2.box_only_games,
          games_basis: sm2.box_only_games
            ? sm2.games_played + ' game(s) played; ' + sm2.games + ' the play table has published. '
              + sm2.box_only_games + ' game(s) are confirmed by the ESPN box alone — they are real games with a real kicking line, '
              + 'they carry no scrimmage play, and they therefore raise no performance rating and no ETSR weight.'
            : 'every game this team has played is in the play table',
          fbs_equivalent_games: Math.round(sm2.weighted_games * 100) / 100,
          non_fbs_share: sm2.games ? Math.round((1 - sm2.fbs_games / sm2.games) * 1000) / 1000 : null,
          plays: sm2.plays, competitive_plays: sm2.competitive_plays,
          garbage_plays: sm2.garbage_plays,
          scored_plays: Math.round(sm2.scored_plays * 10) / 10,
          garbage_share: sm2.plays ? Math.round((sm2.garbage_plays / sm2.plays) * 1000) / 1000 : null,
          offensive_plays: Math.round(sm2.off_plays), defensive_plays: Math.round(sm2.def_plays),
          distinct_opponents: Object.keys(sm2.opponents).length,
          special_teams: { games: sm2.st_games, fg_attempts: sm2.fg_att, punts: sm2.punts,
            kick_returns: sm2.kick_returns, punt_returns: sm2.punt_returns, xp_attempts: sm2.xp_att,
            fg_attempts_in_box: sm2.fg_att_box,
            fg_basis: (sm2.fg_att_box > sm2.fg_att)
              ? sm2.fg_att_box + ' field-goal attempt(s) are in the box and ' + sm2.fg_att
                + ' in the play table. Place kicking is rated over expectation BY DISTANCE and the box carries no distances, '
                + 'so the attempts the play table has not published cannot be scored — and are not silently counted as zero either.'
              : 'every field-goal attempt in the box is also in the play table, with its distance' }
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
      league: { net: netStat, offense_stats: off.stats, defense_stats: def.stats,
        special_teams_stats: st.stats },
      diagnostics: {
        metrics: diagnostics,
        all_converged: diagnostics.every(function (d) { return d.available === false || d.converged; }),
        duplicate_team_games: G.duplicate_team_games,
        team_game_rows: rows.length,
        garbage_filter: 'the scored aggregate is the competitive one plus the garbage-time residual at ' + CFG.GARBAGE.scored_weight + ' weight; the full, competitive, garbage and scored counts all ship per team so the discount is auditable',
        garbage: CFG.GARBAGE,
        special_teams: { metrics_available: stAvailable, contract: CFG.SPECIAL_TEAMS.metrics.length,
          team_games_joined: rows.filter(function (rr) { return !!rr.st; }).length,
          coverage_floor: CFG.SPECIAL_TEAMS.coverage_floor,
          unobservable: CFG.SPECIAL_TEAMS.unobservable },
        sample_contract: { floor_on: CFG.SAMPLE.floor_on, floor_basis: CFG.SAMPLE.floor_on_basis,
          reliability_on: CFG.SAMPLE.reliability_on, reliability_basis: CFG.SAMPLE.reliability_basis },
        recency: CFG.RECENCY, non_fbs: CFG.NON_FBS
      }
    };
  }

  return { SCHEMA: SCHEMA, build: build, adjust: adjust, gameRows: gameRows,
    composite: composite, standardise: standardise, toRating: toRating, field: field,
    scoreFloor: scoreFloor, reliability: reliability, observations: observations,
    blendAggregate: blendAggregate,
    mean: mean, sd: sd, wmean: wmean, config: CFG };
});
