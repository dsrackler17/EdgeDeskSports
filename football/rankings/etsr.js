/* ============================================================================
   THE EDGEDESK TEAM STRENGTH RATING (ETSR)

   ONE NUMBER, IN POINTS AGAINST AN AVERAGE FBS TEAM, ON A NEUTRAL FIELD.

       ETSR(A) − ETSR(B)  =  the neutral-field spread.

   HOME FIELD IS NOT IN IT. Neither is travel, rest, weather, a specific
   quarterback's absence or a scheme matchup. All of those are GAME facts, not
   TEAM facts, and they are applied by the matchup layer on top of this number.
   Baking home field into a team rating makes every rating wrong by the same
   few points and then double-counts it at kickoff.

   HOW THE NUMBER IS MADE

       ETSR = (1 − wP) × PRIOR        + wP × PERFORMANCE
              PRIOR   = c × last season's ETSR + (1 − c) × talent
              wP      = g / (g + k),  g = FBS-equivalent games played

   * `c` is the PORTAL-ERA CARRYOVER COEFFICIENT. The league slope is measured
     every build by regressing each season's ratings on the previous season's —
     the same arithmetic this repo already uses to answer the NIL argument with
     data instead of an opinion. Each team then moves around that league number
     on its OWN continuity: returning production VALUE, quarterback continuity,
     line continuity, returning starters, transfer churn. A team returning 75%
     of its production value carries more of last season than a team that
     rebuilt through thirty-five transfers, and the arithmetic says by how much.
   * `k` is FITTED, not chosen: the ramp constant that minimises out-of-sample
     margin error on a tune window. Until that fit has been run the rating says
     `scalars_measured: false` and uses a declared fallback.
   * Both points-per-z scalars are fitted the same way and carry the same flag.

   TALENT AND PERFORMANCE NEVER COLLAPSE INTO EACH OTHER. They are published
   separately, ranked separately, and the gap between them is one of the more
   useful things on the board: an elite roster that has not yet played like one
   is a real and visible state, not a rounding error.

   Runs in the browser (window.EDRankETSR) and in node.
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDRankConfig;
  var talent = req ? require('./talent.js') : root.EDRankTalent;
  var api = factory(cfg, talent);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankETSR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, TAL) {
  'use strict';

  var SCHEMA = 'edgedesk_team_strength_rating_v1';
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function r1(v) { return isNum(v) ? Math.round(v * 10) / 10 : null; }
  function r2(v) { return isNum(v) ? Math.round(v * 100) / 100 : null; }
  function r3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : null; }
  function get(obj, path) {
    var parts = String(path).split('.'), cur = obj, i;
    for (i = 0; i < parts.length; i++) { if (cur == null) return null; cur = cur[parts[i]]; }
    return cur;
  }

  /* ---------------------------------------------------------------------
     CARRYOVER
     --------------------------------------------------------------------- */
  function carryover(continuityValue, leagueSlope) {
    var C = CFG.CARRYOVER;
    if (!isNum(leagueSlope)) {
      return { coefficient: null, available: false,
        reason: 'the league carryover slope could not be measured this build (too few teams with a rating in both seasons), so no prior-season carry is applied and the rating rests on talent' };
    }
    if (!isNum(continuityValue)) {
      return { coefficient: clamp(leagueSlope, C.min_coef, C.max_coef), available: true,
        league_slope: r3(leagueSlope), team_continuity: null, applied_span: 0,
        basis: 'this team’s own continuity could not be measured, so it carries exactly the league slope and nothing more specific is claimed' };
    }
    var centred = 2 * clamp(continuityValue, 0, 1) - 1;          /* -1 .. +1 */
    var coef = clamp(leagueSlope * (1 + C.span * centred), C.min_coef, C.max_coef);
    return { coefficient: coef, available: true, league_slope: r3(leagueSlope),
      team_continuity: r3(continuityValue), applied_span: r3(C.span * centred),
      basis: 'the MEASURED league slope, moved by up to ' + Math.round(C.span * 100) + '% on this team’s own continuity, then clamped to [' + C.min_coef + ', ' + C.max_coef + ']: ' + C.clamp_basis };
  }

  /* ---------------------------------------------------------------------
     RUN DEFENCE POWER
     --------------------------------------------------------------------- */
  function runDefencePower(talentTeam, perfTeam) {
    var R = CFG.RUN_DEFENCE_POWER, parts = [], missing = [], ws = 0, ss = 0;
    function push(id, v01, why) {
      var def = null, i;
      for (i = 0; i < R.components.length; i++) if (R.components[i].id === id) def = R.components[i];
      if (!def) return;
      if (!isNum(v01)) { missing.push({ id: id, why: why || (id + ' is not observable for this team'), w: def.w }); return; }
      parts.push({ id: id, value: r3(v01), weight: def.w, basis: def.basis });
      ss += clamp(v01, 0, 1) * def.w; ws += def.w;
    }
    function fromRating(r) { return isNum(r) ? clamp((r - 20) / 60, 0, 1) : null; }
    function fromZ(z, invert) { return isNum(z) ? clamp(0.5 + (invert ? -z : z) / 4, 0, 1) : null; }

    var u = talentTeam ? talentTeam.units : null;
    var hasEdge = !!(u && u.EDGE && u.EDGE.available);
    var hasDl = !!(u && u.DL && u.DL.available);
    /* A ROSTER THAT SPELLS ITS ENDS "DL" HAS NOT LOST ITS EDGE RUSHERS.
       123 of 138 FBS programmes do exactly that. Counting edge_unit as absent
       for them would drop the contract below its own completeness bar on a
       naming convention alone — so where DL covers it, edge_unit's weight is
       FOLDED INTO dl_unit rather than declared missing, and the record says so. */
    var edgeW = 0;
    for (var ci = 0; ci < R.components.length; ci++) if (R.components[ci].id === 'edge_unit') edgeW = R.components[ci].w;
    if (!hasEdge && hasDl) {
      var v = fromRating(u.DL.rating);
      if (isNum(v)) {
        parts.push({ id: 'dl_unit', value: r3(v), weight: R.components[0].w + edgeW,
          basis: 'defensive-line unit rating, carrying the edge weight too because this roster spells its ends DL — a naming convention, not a missing unit',
          absorbed: 'edge_unit' });
        ss += clamp(v, 0, 1) * (R.components[0].w + edgeW); ws += R.components[0].w + edgeW;
      } else missing.push({ id: 'dl_unit', why: 'no defensive-line rating for this roster', w: R.components[0].w + edgeW });
    } else {
      push('dl_unit', fromRating(hasDl ? u.DL.rating : null));
      push('edge_unit', fromRating(hasEdge ? u.EDGE.rating : null),
        'this roster spells neither EDGE nor DL, so the front has no rating at all');
    }
    push('lb_unit', fromRating(u && u.LB && u.LB.available ? u.LB.rating : null));

    var ret = talentTeam && talentTeam.returning ? null : null;
    var frontRet = null;
    if (talentTeam && talentTeam._front_returning != null) frontRet = talentTeam._front_returning;
    push('front_returning_value', frontRet,
      'no prior-season player ratings for this front, so returning VALUE cannot be computed');

    var rd = perfTeam && perfTeam.sub_units ? perfTeam.sub_units.run_defense : null;
    function metricZ(id) {
      if (!rd || !rd.used) return null;
      for (var i = 0; i < rd.used.length; i++) if (rd.used[i].id === id) return rd.used[i].z;
      return null;
    }
    push('rush_success_allowed', fromZ(metricZ('rd_success')));
    push('stuff_rate', fromZ(metricZ('rd_stuffed')));
    push('explosive_rush_allowed', fromZ(metricZ('rd_explosive')));
    push('yards_per_rush_allowed', fromZ(metricZ('rd_ypc')));

    var totalW = 0, i2;
    for (i2 = 0; i2 < R.components.length; i2++) totalW += R.components[i2].w;
    var completeness = totalW > 0 ? ws / totalW : 0;
    if (completeness < R.min_completeness) {
      return { score: null, available: false, band: 'UNKNOWN',
        completeness: r2(completeness), components: parts, missing: missing,
        reason: 'only ' + Math.round(completeness * 100) + '% of the run-defence contract arrived, below the '
          + Math.round(R.min_completeness * 100) + '% it needs. A gate that always answers is a gate that is sometimes lying.',
        unobservable: R.unobservable, qb_rush_defence: R.qb_rush_defence };
    }
    var score = (ss / ws) * 100;
    var band = 'FRAGILE';
    for (i2 = 0; i2 < R.bands.length; i2++) if (score >= R.bands[i2].min) { band = R.bands[i2].label; break; }
    return { score: r1(score), available: true, band: band, completeness: r2(completeness),
      components: parts, missing: missing, unobservable: R.unobservable,
      qb_rush_defence: R.qb_rush_defence,
      basis: 'a 0-100 run-defence power score over the components that arrived, renormalised over their weights. It feeds the game-level Run Defence Gate; it is not itself a spread adjustment.' };
  }

  /* ---------------------------------------------------------------------
     DATA-QUALITY GATES  —  they cost CONFIDENCE, never points
     --------------------------------------------------------------------- */
  function gates(ctx) {
    var T = CFG.GATE_THRESHOLDS, out = [];
    function fire(id, detail) {
      var g = CFG.gate(id);
      if (!g) return;
      out.push({ id: id, severity: g.severity, confidence_cost: g.confidence_cost,
        duplicates_component: g.duplicates_component || null, basis: g.basis, detail: detail });
    }
    var s = ctx.sample || {};
    if (!(s.fbs_equivalent_games >= T.low_sample_games)) {
      fire('LOW_SAMPLE_SIZE', (s.fbs_equivalent_games == null ? 'no' : s.fbs_equivalent_games) + ' FBS-equivalent games played');
    }
    var qb = ctx.talent && ctx.talent.units && ctx.talent.units.QB;
    if (!qb || !qb.available) fire('QB_UNKNOWN', 'the quarterback room produced no rateable player');
    else if (qb.confidence < T.qb_confidence_floor) fire('QB_UNKNOWN', 'quarterback-room confidence ' + Math.round(qb.confidence * 100) + '%');
    if (ctx.talent && isNum(ctx.talent.availability.unknown_share) && ctx.talent.availability.unknown_share >= T.injury_unknown_share) {
      fire('INJURY_UNCERTAINTY', Math.round(ctx.talent.availability.unknown_share * 100) + '% of projected starter value has no availability record');
    }
    var vc = ctx.talent && ctx.talent.returning ? ctx.talent.returning.value_continuity : null;
    if (isNum(vc) && (1 - vc) > T.transfer_turnover_share) {
      fire('EXTREME_TRANSFER_TURNOVER', Math.round((1 - vc) * 100) + '% of last season’s production value is gone');
    }
    if (isNum(s.offensive_plays) && s.offensive_plays < T.thin_side_plays) fire('THIN_OFFENSIVE_DATA', s.offensive_plays + ' offensive plays observed');
    if (isNum(s.defensive_plays) && s.defensive_plays < T.thin_side_plays) fire('THIN_DEFENSIVE_DATA', s.defensive_plays + ' defensive plays faced');
    if (isNum(s.non_fbs_share) && s.non_fbs_share >= T.fcs_share) {
      fire('FCS_DOMINATED_SAMPLE', Math.round(s.non_fbs_share * 100) + '% of games were against a pooled non-FBS opponent');
    }
    if (ctx.scheme_confidence != null && ctx.scheme_confidence < T.scheme_confidence_floor) {
      fire('SCHEME_DATA_LOW_CONFIDENCE', 'tendency profile confidence ' + Math.round(ctx.scheme_confidence * 100) + '%');
    }
    if (!isNum(ctx.prev_etsr)) fire('PRIOR_SEASON_MISSING', 'no prior-season rating on file, so the prior term rests on talent alone');
    return out;
  }

  function confidence(ctx, firedGates, wPerf) {
    var C = CFG.CONFIDENCE, s = ctx.sample || {}, parts = {};
    parts.player_data = clamp(num(ctx.talent && ctx.talent.player_confidence) || 0, 0, 1);
    var g = num(s.fbs_equivalent_games) || 0;
    parts.game_sample = g / (g + C.game_sample_k);
    var opp = num(s.distinct_opponents) || 0;
    parts.opponent_sample = opp / (opp + 3);
    var qb = ctx.talent && ctx.talent.units && ctx.talent.units.QB;
    parts.starter_certainty = clamp(((qb && qb.available ? qb.confidence : 0) + (num(ctx.talent && ctx.talent.player_confidence) || 0)) / 2, 0, 1);
    var unk = num(ctx.talent && ctx.talent.availability.unknown_share);
    parts.availability = isNum(unk) ? clamp(1 - unk, 0, 1) : 0;
    parts.scheme_data = clamp(num(ctx.scheme_confidence) || 0, 0, 1);
    parts.returning_production = (ctx.talent && ctx.talent.returning && isNum(ctx.talent.returning.value_continuity)) ? 0.9 : 0.25;

    /* each block normalised internally, then mixed in the SAME proportion the
       rating itself mixes prior and performance */
    function block(spec) {
      var s2 = 0, w2 = 0, k;
      for (k in spec) {
        if (!Object.prototype.hasOwnProperty.call(spec, k)) continue;
        s2 += (parts[k] || 0) * spec[k]; w2 += spec[k];
      }
      return w2 > 0 ? s2 / w2 : 0;
    }
    var wp = clamp(isNum(wPerf) ? wPerf : 0, 0, 1);
    var priorBlock = block(C.prior_side);
    var perfBlock = block(C.performance_side);
    var alwaysW = 0, alwaysS = 0, k3;
    for (k3 in C.always) {
      if (!Object.prototype.hasOwnProperty.call(C.always, k3)) continue;
      alwaysS += (parts[k3] || 0) * C.always[k3]; alwaysW += C.always[k3];
    }
    var mixed = (1 - wp) * priorBlock + wp * perfBlock;
    var base = mixed * (1 - alwaysW) + alwaysS;

    var cost = 0;
    for (var i = 0; i < firedGates.length; i++) cost += firedGates[i].confidence_cost;
    /* a non-FBS-heavy sample is additionally proportional, not just a flag, and
       only matters to the extent the rating leans on those games at all */
    if (isNum(s.non_fbs_share)) cost += s.non_fbs_share * CFG.NON_FBS.confidence_penalty_per_share * 0.5 * wp;
    return { value: r3(clamp(base - cost, 0.05, 0.99)), before_gates: r3(base),
      gate_cost: r3(cost),
      mix: { performance_weight: r3(wp), prior_block: r3(priorBlock), performance_block: r3(perfBlock),
        always_block: r3(alwaysW > 0 ? alwaysS / alwaysW : 0), basis: C.split_basis },
      parts: {
        player_data: r3(parts.player_data), game_sample: r3(parts.game_sample),
        opponent_sample: r3(parts.opponent_sample), starter_certainty: r3(parts.starter_certainty),
        availability: r3(parts.availability), scheme_data: r3(parts.scheme_data),
        returning_production: r3(parts.returning_production) },
      basis: C.basis };
  }

  /* ---------------------------------------------------------------------
     ONE TEAM
     --------------------------------------------------------------------- */
  function rateTeam(key, ctx, params) {
    params = params || {};
    var cal = params.calibration || {};
    var talentPts = cal.talent_points_per_z, perfPts = cal.performance_points_per_z, rampK = cal.prior_ramp_k;
    var measured = !!(cal.measured === true);
    var tp = isNum(num(talentPts && talentPts.value)) ? num(talentPts.value) : CFG.ETSR.fallback_talent_points_per_z;
    var pp = isNum(num(perfPts && perfPts.value)) ? num(perfPts.value) : CFG.ETSR.fallback_performance_points_per_z;
    var kk = isNum(num(rampK && rampK.value)) ? num(rampK.value) : CFG.PRIORS.fallback_ramp_k;

    var t = ctx.talent, p = ctx.performance;
    var talentZ = (t && isNum(t.rating)) ? (t.rating - CFG.TALENT.scale.center) / CFG.TALENT.scale.sd : null;
    var talentPoints = isNum(talentZ) ? talentZ * tp : null;
    var perfZ = p && isNum(p.net_z) ? p.net_z : null;
    var perfPoints = isNum(perfZ) ? perfZ * pp : null;

    var cont = ctx.continuity;
    var carry = carryover(cont ? cont.value : null, ctx.league_slope);
    var cEff = carry.coefficient;
    if (isNum(cEff)) cEff = Math.min(cEff, 1 - CFG.PRIORS.talent_floor_weight);

    var prevEtsr = num(ctx.prev_etsr);
    var priorPoints, priorParts;
    if (isNum(prevEtsr) && isNum(cEff) && isNum(talentPoints)) {
      priorPoints = cEff * prevEtsr + (1 - cEff) * talentPoints;
      priorParts = { carried_from_last_season: r2(cEff * prevEtsr), from_talent: r2((1 - cEff) * talentPoints),
        coefficient: r3(cEff), prev_etsr: r2(prevEtsr) };
    } else if (isNum(talentPoints)) {
      priorPoints = talentPoints;
      priorParts = { carried_from_last_season: 0, from_talent: r2(talentPoints), coefficient: 0,
        prev_etsr: isNum(prevEtsr) ? r2(prevEtsr) : null,
        note: isNum(prevEtsr) ? 'no carryover coefficient could be formed, so the prior is talent alone'
          : 'no prior-season rating exists for this team, so the prior is talent alone' };
    } else {
      priorPoints = null;
      priorParts = { note: 'neither a prior-season rating nor a talent rating is available — no prior term can be formed' };
    }

    var gp = num(ctx.sample && ctx.sample.fbs_equivalent_games) || 0;
    var wPerf = isNum(perfPoints) ? gp / (gp + kk) : 0;
    if (!(gp >= CFG.PRIORS.min_games_for_performance)) wPerf = 0;

    var etsrRaw = null;
    if (isNum(priorPoints) && isNum(perfPoints)) etsrRaw = (1 - wPerf) * priorPoints + wPerf * perfPoints;
    else if (isNum(priorPoints)) etsrRaw = priorPoints;
    else if (isNum(perfPoints)) etsrRaw = perfPoints;

    var fired = gates(ctx);
    var conf = confidence(ctx, fired, wPerf);

    return {
      key: key,
      etsr_raw: r2(etsrRaw), etsr: null,            /* filled after the league re-centre */
      available: isNum(etsrRaw),
      weights: { performance: r3(wPerf), prior: r3(1 - wPerf), ramp_k: kk,
        ramp_basis: CFG.PRIORS.ramp_basis, games_used: r2(gp),
        talent_floor: CFG.PRIORS.talent_floor_weight, talent_floor_basis: CFG.PRIORS.talent_floor_basis },
      prior: { points: r2(priorPoints), parts: priorParts, carryover: carry },
      performance_points: r2(perfPoints), talent_points: r2(talentPoints),
      scalars: { talent_points_per_z: tp, performance_points_per_z: pp, measured: measured,
        basis: CFG.ETSR.scalar_basis },
      confidence: conf, gates: fired,
      home_field: CFG.ETSR.home_field
    };
  }

  /* ---------------------------------------------------------------------
     THE LEAGUE
     --------------------------------------------------------------------- */
  function build(input) {
    var keys = input.keys, i, k;
    var rows = {}, raws = [];
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      var ctx = input.context[k];
      rows[k] = rateTeam(k, ctx, input.params);
      if (rows[k].available) raws.push(rows[k].etsr_raw);
    }
    /* RE-CENTRE so the average FBS team is exactly 0.0 — the convention that
       makes "+17.2" mean something. */
    var centre = raws.length ? mean(raws) : 0;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      if (!rows[k].available) continue;
      rows[k].etsr = r2(rows[k].etsr_raw - centre);
      rows[k].centre_applied = r2(-centre);
    }
    return { rows: rows, centre: r2(centre), centre_basis: CFG.ETSR.centre_basis };
  }

  /* ---------------------------------------------------------------------
     RANKS
     A team below the confidence floor keeps its RATING and loses its RANK.
     --------------------------------------------------------------------- */
  function rank(teams, category) {
    var list = [], k;
    for (k in teams) {
      if (!Object.prototype.hasOwnProperty.call(teams, k)) continue;
      var v = get(teams[k], category.field);
      var conf = num(teams[k].confidence && teams[k].confidence.value);
      if (!isNum(num(v))) continue;
      list.push({ key: k, value: num(v), confidence: conf == null ? 0 : conf });
    }
    list.sort(function (a, b) {
      if (b.value !== a.value) return category.dir === -1 ? b.value - a.value : a.value - b.value;
      return a.key < b.key ? -1 : 1;
    });
    var out = {}, rankNo = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].confidence < CFG.RANK_MIN_CONFIDENCE) {
        out[list[i].key] = { rank: null, value: r2(list[i].value), unranked: true,
          reason: 'confidence ' + Math.round(list[i].confidence * 100) + '% is below the '
            + Math.round(CFG.RANK_MIN_CONFIDENCE * 100) + '% floor. ' + CFG.RANK_MIN_CONFIDENCE_BASIS };
        continue;
      }
      rankNo++;
      out[list[i].key] = { rank: rankNo, value: r2(list[i].value), unranked: false };
    }
    return { ranks: out, ranked: rankNo, listed: list.length, category: category.id };
  }

  function rankAll(teams) {
    var out = {}, i;
    for (i = 0; i < CFG.RANKINGS.length; i++) {
      var c = CFG.RANKINGS[i];
      out[c.id] = rank(teams, c);
    }
    return out;
  }

  /* ---------------------------------------------------------------------
     MOVEMENT — differenced, never narrated by a model
     --------------------------------------------------------------------- */
  function movement(now, prev) {
    if (!prev) {
      return { available: false,
        reason: 'no earlier snapshot for this team, so nothing can be differenced. This is the first week it was rated.' };
    }
    var drivers = [], k;
    var pairs = [
      ['talent', 'talent.rating', 'talent'],
      ['performance', 'performance.rating', 'performance'],
      ['offense', 'performance.offense', 'offense'],
      ['defense', 'performance.defense', 'defense'],
      ['run_offense', 'performance.run_offense', 'run offense'],
      ['pass_offense', 'performance.pass_offense', 'pass offense'],
      ['run_defense', 'run_defence_power.score', 'run defense'],
      ['pass_defense', 'performance.pass_defense', 'pass defense'],
      ['availability', 'availability.rating', 'availability'],
      ['prior_weight', 'weights.performance', 'weight on this season'],
      ['opponent_adjustment', 'performance.opponent_delta', 'opponent adjustment']
    ];
    for (var i = 0; i < pairs.length; i++) {
      var a = num(get(now, pairs[i][1])), b = num(get(prev, pairs[i][1]));
      if (!isNum(a) || !isNum(b)) continue;
      var d = a - b;
      if (Math.abs(d) < CFG.MOVEMENT.min_reportable_points) continue;
      drivers.push({ id: pairs[i][0], label: pairs[i][2], from: r2(b), to: r2(a), delta: r2(d) });
    }
    drivers.sort(function (x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });
    var etsrNow = num(get(now, 'etsr')), etsrPrev = num(get(prev, 'etsr'));
    var rankNow = num(get(now, 'rank')), rankPrev = num(get(prev, 'rank'));
    return {
      available: true,
      etsr: { from: r2(etsrPrev), to: r2(etsrNow),
        delta: (isNum(etsrNow) && isNum(etsrPrev)) ? r2(etsrNow - etsrPrev) : null },
      rank: { from: rankPrev, to: rankNow,
        delta: (isNum(rankNow) && isNum(rankPrev)) ? (rankPrev - rankNow) : null },
      drivers: drivers,
      basis: CFG.MOVEMENT.basis
    };
  }

  /* ---------------------------------------------------------------------
     "WHY #1?"  —  built from ranked components, not from prose
     --------------------------------------------------------------------- */
  function why(teamKey, teams, ranks, opts) {
    opts = opts || {};
    var strengths = [], weaknesses = [], i;
    var total = opts.team_count || Object.keys(teams).length;
    for (i = 0; i < CFG.RANKINGS.length; i++) {
      var c = CFG.RANKINGS[i];
      if (c.id === 'overall') continue;
      var r = ranks[c.id] && ranks[c.id].ranks[teamKey];
      if (!r || r.unranked || !isNum(r.rank)) continue;
      var row = { id: c.id, label: c.label, rank: r.rank, value: r.value, of: ranks[c.id].ranked };
      if (r.rank <= Math.max(10, Math.round(total * 0.08))) strengths.push(row);
      else if (r.rank >= Math.round(total * 0.55)) weaknesses.push(row);
    }
    strengths.sort(function (a, b) { return a.rank - b.rank; });
    weaknesses.sort(function (a, b) { return b.rank - a.rank; });
    var t = teams[teamKey];
    var extra = [];
    if (t && t.talent && t.talent.returning && isNum(t.talent.returning.value_continuity)) {
      extra.push({ id: 'returning_value', label: 'returning production value',
        text: Math.round(t.talent.returning.value_continuity * 100) + '% of last season’s production value is still on the roster' });
    }
    if (t && t.run_defence_power && t.run_defence_power.available) {
      extra.push({ id: 'run_defence', label: 'run defence power',
        text: 'run defence grades ' + t.run_defence_power.band + ' at ' + t.run_defence_power.score + '/100' });
    }
    return {
      strengths: strengths.slice(0, 6), weaknesses: weaknesses.slice(0, 4), notes: extra,
      basis: 'assembled from this team’s own component RANKS. Nothing here is written, chosen or ordered by a language model — the components are ranked, the top ones are the strengths and the bottom ones are the weaknesses.'
    };
  }

  /* ---------------------------------------------------------------------
     OVER / UNDERACHIEVEMENT, and the market column
     --------------------------------------------------------------------- */
  function achievement(teamKey, ranks) {
    var t = ranks.talent && ranks.talent.ranks[teamKey];
    var p = ranks.performance && ranks.performance.ranks[teamKey];
    if (!t || !p || t.unranked || p.unranked || !isNum(t.rank) || !isNum(p.rank)) {
      return { state: 'UNKNOWN', gap: null,
        reason: 'a talent rank and a performance rank are both needed, and at least one is unranked' };
    }
    var gap = t.rank - p.rank;                     /* + = playing better than the roster says */
    var th = CFG.ACHIEVEMENT.threshold_ranks;
    var state = gap >= th ? 'OVERPERFORMING TALENT' : (gap <= -th ? 'UNDERPERFORMING TALENT' : 'IN LINE');
    return { state: state, gap: gap, talent_rank: t.rank, performance_rank: p.rank,
      basis: CFG.ACHIEVEMENT.basis };
  }

  function marketCompare(etsr, marketImplied) {
    if (!isNum(num(marketImplied))) {
      return { available: false, reason: 'no market-implied power number for this team — the closing-line archive did not reach enough of its games' };
    }
    var diff = num(etsr) - num(marketImplied);
    var label = 'IN LINE';
    for (var i = 0; i < CFG.MARKET.labels.length; i++) {
      if (Math.abs(diff) >= CFG.MARKET.labels[i].min) { label = CFG.MARKET.labels[i].label; break; }
    }
    return { available: true, etsr: r2(num(etsr)), market_implied: r2(num(marketImplied)),
      difference: r2(diff), label: label, is_input: false,
      basis: CFG.MARKET.basis, never_call_it: CFG.MARKET.never_call_it };
  }

  /* ---------------------------------------------------------------------
     STABILITY AND ANOMALIES  —  these FAIL a build
     --------------------------------------------------------------------- */
  function stability(nowTeams, prevTeams) {
    if (!prevTeams) return { available: false, reason: 'no earlier snapshot to compare against' };
    var shifts = [], ratingShifts = [], big = 0, n = 0, k;
    for (k in nowTeams) {
      if (!Object.prototype.hasOwnProperty.call(nowTeams, k)) continue;
      var a = nowTeams[k], b = prevTeams[k];
      if (!b) continue;
      if (isNum(a.rank) && isNum(b.rank)) { var s = Math.abs(a.rank - b.rank); shifts.push(s); if (s >= 15) big++; n++; }
      if (isNum(a.etsr) && isNum(b.etsr)) ratingShifts.push(Math.abs(a.etsr - b.etsr));
    }
    var meanShift = shifts.length ? mean(shifts) : null;
    var maxRating = ratingShifts.length ? Math.max.apply(null, ratingShifts) : null;
    var shareBig = n ? big / n : null;
    var S = CFG.STABILITY;
    var failures = [];
    if (isNum(meanShift) && meanShift > S.max_mean_rank_shift) failures.push('mean rank shift ' + r2(meanShift) + ' exceeds ' + S.max_mean_rank_shift);
    if (isNum(shareBig) && shareBig > S.max_share_moving_15) failures.push(Math.round(shareBig * 100) + '% of teams moved 15+ places, above the ' + Math.round(S.max_share_moving_15 * 100) + '% bound');
    if (isNum(maxRating) && maxRating > S.max_rating_shift_points) failures.push('largest ETSR move ' + r2(maxRating) + ' exceeds ' + S.max_rating_shift_points);
    return { available: true, mean_rank_shift: r2(meanShift), share_moving_15: r3(shareBig),
      max_rating_shift: r2(maxRating), teams_compared: n, failures: failures, basis: S.basis };
  }

  function anomalies(teams, prevTeams, opts) {
    opts = opts || {};
    var T = CFG.ANOMALY_THRESHOLDS, out = [], k;
    var seenKeys = {};
    for (k in teams) {
      if (!Object.prototype.hasOwnProperty.call(teams, k)) continue;
      var t = teams[k];
      if (seenKeys[k]) out.push({ id: 'DUPLICATE_TEAM', severity: 'severe', team: k, detail: 'two rating rows for one team key' });
      seenKeys[k] = 1;
      if (t.etsr != null && (!isNum(t.etsr) || Math.abs(t.etsr) > T.rating_abs_max)) {
        out.push({ id: 'IMPOSSIBLE_RATING', severity: 'severe', team: k, detail: 'ETSR ' + t.etsr + ' is outside the plausible band of ±' + T.rating_abs_max });
      }
      var tr = t.talent && t.talent.rating;
      if (tr != null && (!isNum(tr) || tr < T.talent_abs_min || tr > T.talent_abs_max)) {
        out.push({ id: 'IMPOSSIBLE_RATING', severity: 'severe', team: k, detail: 'talent rating ' + tr + ' is outside 1-99' });
      }
      var prev = prevTeams && prevTeams[k];
      if (prev) {
        if (isNum(t.etsr) && isNum(prev.etsr) && Math.abs(t.etsr - prev.etsr) > T.rating_jump_points) {
          out.push({ id: 'RATING_JUMP', severity: 'severe', team: k,
            detail: 'ETSR moved ' + r2(t.etsr - prev.etsr) + ' points in one week, beyond the ' + T.rating_jump_points + ' bound' });
        }
        var pt = prev.talent && prev.talent.rating;
        if (isNum(tr) && isNum(pt) && (pt - tr) > T.talent_drop_points) {
          out.push({ id: 'TALENT_COLLAPSE', severity: 'severe', team: k,
            detail: 'talent fell ' + r2(pt - tr) + ' points in one week. Talent is not allowed to react to a result.' });
        }
      }
      if (t.duplicate_games && t.duplicate_games.length) {
        out.push({ id: 'DUPLICATE_GAME', severity: 'severe', team: k, detail: t.duplicate_games.length + ' duplicated team-games' });
      }
      if (t.zero_snap_starters && t.zero_snap_starters.length) {
        out.push({ id: 'ZERO_SNAP_STARTER', severity: 'warn', team: k,
          detail: t.zero_snap_starters.length + ' projected starters have no attributed volume in any season read' });
      }
      if (t.talent && t.talent.missing_units && t.talent.missing_units.length) {
        out.push({ id: 'MISSING_PLAYER_DATA', severity: 'warn', team: k,
          detail: 'no rating at ' + t.talent.missing_units.join(', ') });
      }
    }
    var expected = opts.expected_teams || null;
    if (expected) {
      for (var i = 0; i < expected.length; i++) {
        if (!teams[expected[i]]) out.push({ id: 'MISSING_TEAM', severity: 'severe', team: expected[i], detail: 'in the schedule as FBS but produced no rating' });
      }
      for (k in teams) {
        if (!Object.prototype.hasOwnProperty.call(teams, k)) continue;
        if (expected.indexOf(k) < 0) out.push({ id: 'TEAM_MAPPING', severity: 'severe', team: k, detail: 'rated, but no schedule recognises this team key as FBS' });
      }
    }
    if (opts.stability && opts.stability.failures && opts.stability.failures.length) {
      out.push({ id: 'STABILITY', severity: 'severe', team: null, detail: opts.stability.failures.join('; ') });
    }
    if (opts.missing_snapshot) out.push({ id: 'MISSING_SNAPSHOT', severity: 'severe', team: null, detail: opts.missing_snapshot });
    return { list: out, severe: out.filter(function (a) { return a.severity === 'severe'; }).length,
      warn: out.filter(function (a) { return a.severity === 'warn'; }).length, contract: CFG.ANOMALIES };
  }

  return { SCHEMA: SCHEMA, rateTeam: rateTeam, build: build, carryover: carryover,
    runDefencePower: runDefencePower, gates: gates, confidence: confidence,
    rank: rank, rankAll: rankAll, movement: movement, why: why,
    achievement: achievement, marketCompare: marketCompare,
    stability: stability, anomalies: anomalies, get: get, config: CFG };
});
