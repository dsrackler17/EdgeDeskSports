/* ============================================================================
   POSITION GROUPS, TEAM UNITS, RETURNING VALUE AND TRANSFER VALUE.

   The layer between "how good is this player" and "how good is this football
   team". Three things it refuses to do:

   1  IT DOES NOT AVERAGE THE ROOM. A quarterback room is not the mean of its
      quarterbacks; it is overwhelmingly QB1. A defensive front is much closer
      to a mean, because a front rotates. Each group is weighted by the shape
      of how that position is actually played (config.js ROLE.depth_curve),
      and the shape is playing time, never quality.

   2  IT DOES NOT TREAT A RETURNING PLAYER AS A GOOD PLAYER. "74 returning"
      is a count. VALUE CONTINUITY is the share of last season's PRODUCTION
      VALUE still on the roster, and the two are published side by side
      precisely because they disagree — a team can return most of its bodies
      and little of its value, and that is the interesting case.

   3  IT DOES NOT SCORE AN EMPTY ROOM. A group with no rateable players is
      UNAVAILABLE, not zero. A team that returns nobody at quarterback does
      not get a quarterback rating of 0; it gets no rating and maximum
      uncertainty, which is a different and more useful statement.

   Runs in the browser (window.EDPlayerUnits) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDPlayerConfig;
  var epir = req ? require('./epir.js') : root.EDPlayerRating;
  var api = factory(cfg, epir);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerUnits = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, EPIR) {
  'use strict';

  var SCHEMA = 'edgedesk_team_units_v1';
  var M = EPIR.M, isNum = EPIR.isNum, clamp = EPIR.clamp, mean = EPIR.mean;
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /* Availability multipliers. OUT removes a player from the projected
     participants entirely; QUESTIONABLE halves his expected participation;
     UNKNOWN is UNKNOWN and is carried as full participation with the
     uncertainty raised, because assuming a silent player is hurt would be
     just as invented as assuming he is fine. */
  var AVAIL_W = { OUT: 0, DOUBTFUL: 0.15, QUESTIONABLE: 0.5, PROBABLE: 0.9, ACTIVE: 1, UNKNOWN: 1 };

  function availStatus(rec) {
    if (!rec) return 'UNKNOWN';
    var s = String(rec.status || rec.state || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (/OUT|SUSPEND|SEASON/.test(s)) return 'OUT';
    if (/DOUBT/.test(s)) return 'DOUBTFUL';
    if (/QUESTION|GTD|DAYTODAY/.test(s)) return 'QUESTIONABLE';
    if (/PROBABLE|LIKELY/.test(s)) return 'PROBABLE';
    if (/ACTIVE|AVAILABLE|CLEARED/.test(s)) return 'ACTIVE';
    return 'UNKNOWN';
  }

  /* ---------------------------------------------------------------------
     ONE POSITION GROUP
     players: rating records from epir.js, already filtered to one team+group
     availability: map of player key -> {status, source, as_of}
     teamContext: observable TEAM-level facts that stand in where individual
       data does not exist (OL is the whole reason this parameter exists)
     --------------------------------------------------------------------- */
  function rateGroup(group, players, opts) {
    opts = opts || {};
    var avail = opts.availability || {};
    var curve = CFG.ROLE.depth_curve[group] || [1];
    var contract = CFG.MEASURES[group] || [];

    /* project participation: order by EPIR x confidence so an unknown player
       does not leapfrog a proven one, then lay the depth curve over it. */
    var ranked = players.slice().sort(function (a, b) {
      var ka = a.epir * (0.5 + 0.5 * a.confidence), kb = b.epir * (0.5 + 0.5 * b.confidence);
      if (kb !== ka) return kb - ka;
      return (b.sample_size || 0) - (a.sample_size || 0);
    });

    var participants = [], i, w, st, aw, totalW = 0;
    for (i = 0; i < ranked.length; i++) {
      w = i < curve.length ? curve[i] : 0;
      if (!(w > 0)) w = 0;
      st = availStatus(avail[ranked[i].key]);
      aw = AVAIL_W[st] != null ? AVAIL_W[st] : 1;
      participants.push({ player: ranked[i], slot: i + 1, depth_weight: w,
        availability: st, availability_source: (avail[ranked[i].key] || {}).source || null,
        effective_weight: w * aw });
      totalW += w * aw;
    }
    /* players removed by availability free up their share; it flows down the
       depth chart rather than vanishing. */
    if (totalW > 0) for (i = 0; i < participants.length; i++) participants[i].effective_weight /= totalW;

    var rateable = [];
    for (i = 0; i < participants.length; i++) {
      if (participants[i].effective_weight > 0) rateable.push(participants[i]);
    }
    if (!rateable.length) {
      return emptyGroup(group, players.length, 'no rateable player is projected to take a snap in this group');
    }

    var ratingSum = 0, confSum = 0, wsum = 0;
    for (i = 0; i < rateable.length; i++) {
      var p = rateable[i];
      ratingSum += p.player.epir * p.effective_weight;
      confSum += p.player.confidence * p.effective_weight;
      wsum += p.effective_weight;
    }
    var raw = wsum > 0 ? ratingSum / wsum : null;
    var conf = wsum > 0 ? confSum / wsum : 0;

    /* starter quality vs depth quality, separated because they answer
       different questions: what happens normally, and what happens when
       somebody goes down. */
    var starterSlots = starterCount(group);
    var starters = ranked.slice(0, starterSlots);
    var depth = ranked.slice(starterSlots, starterSlots + Math.max(2, starterSlots));
    var starterQ = starters.length ? weightedEpir(starters, curve) : null;
    var depthQ = depth.length ? mean(depth.map(function (x) { return x.epir; })) : null;

    /* continuity and value continuity of the group */
    var returning = players.filter(function (p) { return p.status === 'returning'; });
    var cont = players.length ? returning.length / players.length : null;

    /* experience: seasons OBSERVED in the production feed, never the roster
       feed's class column. */
    var expVals = ranked.slice(0, Math.max(starterSlots, 1)).map(function (p) { return p.seasons_observed; });
    var exper = expVals.length ? clamp((mean(expVals) - 1) / 3, 0, 1) : null;

    /* availability of the projected starters, and how much of it is UNKNOWN */
    var unknownShare = 0, outCount = 0;
    for (i = 0; i < Math.min(starterSlots, participants.length); i++) {
      if (participants[i].availability === 'UNKNOWN') unknownShare++;
      if (participants[i].availability === 'OUT' || participants[i].availability === 'DOUBTFUL') outCount++;
    }
    unknownShare = starterSlots ? unknownShare / Math.min(starterSlots, participants.length || 1) : 1;

    /* TEAM CONTEXT: for groups with no individual production feed, the team's
       own observed play-level record is the only real evidence, and it is
       real. It is blended in explicitly, never silently. */
    var ctxBlend = null;
    if (opts.teamContext && isNum(num(opts.teamContext[group + '_z']))) {
      var cz = num(opts.teamContext[group + '_z']);
      var ctxRating = clamp(CFG.EPIR_SCALE.center + CFG.EPIR_SCALE.sd * cz, CFG.EPIR_SCALE.floor, CFG.EPIR_SCALE.ceiling);
      var wCtx = contract.length ? CFG.ROLE.team_context_weight.with_production : CFG.ROLE.team_context_weight.blind;
      ctxBlend = { z: cz, rating: Math.round(ctxRating * 10) / 10, weight: wCtx,
        basis: opts.teamContext[group + '_basis'] || 'opponent-adjusted team play-level record for this unit',
        why: CFG.ROLE.team_context_basis };
      raw = raw * (1 - wCtx) + ctxRating * wCtx;
      conf = conf * (1 - wCtx) + (num(opts.teamContext[group + '_conf']) || 0.5) * wCtx;
    }

    return {
      schema: SCHEMA, group: group,
      rating: raw == null ? null : Math.round(raw * 10) / 10,
      available: raw != null,
      confidence: Math.round(clamp(conf, 0, 1) * 1000) / 1000,
      starter_quality: starterQ == null ? null : Math.round(starterQ * 10) / 10,
      depth_quality: depthQ == null ? null : Math.round(depthQ * 10) / 10,
      continuity: cont == null ? null : Math.round(cont * 1000) / 1000,
      experience: exper == null ? null : Math.round(exper * 1000) / 1000,
      availability: { starters_out: outCount, unknown_share: Math.round(unknownShare * 100) / 100,
        basis: outCount || unknownShare < 1
          ? 'from football/availability/current.json, EdgeDesk’s own evidence-ranked college availability dataset'
          : 'no availability record reached this group — UNKNOWN, which is not the same as healthy' },
      roster_size: players.length,
      projected: participants.slice(0, Math.max(curve.length, starterSlots)).map(function (p) {
        return { key: p.player.key, name: p.player.name, pos: p.player.pos, slot: p.slot,
          epir: p.player.epir, confidence: p.player.confidence,
          role: p.player.role.expected_role, depth_weight: Math.round(p.depth_weight * 1000) / 1000,
          effective_weight: Math.round(p.effective_weight * 1000) / 1000,
          availability: p.availability, status: p.player.status };
      }),
      team_context: ctxBlend,
      production_feed: contract.length ? true : false,
      production_feed_reason: contract.length ? null : (CFG.NO_PRODUCTION_FEED[group] || null),
      depth_curve_basis: CFG.ROLE.depth_curve_basis
    };
  }

  function emptyGroup(group, rosterSize, reason) {
    return { schema: SCHEMA, group: group, rating: null, available: false, confidence: 0,
      starter_quality: null, depth_quality: null, continuity: null, experience: null,
      availability: { starters_out: 0, unknown_share: 1, basis: 'no projected participant' },
      roster_size: rosterSize || 0, projected: [], team_context: null,
      production_feed: (CFG.MEASURES[group] || []).length > 0,
      production_feed_reason: CFG.NO_PRODUCTION_FEED[group] || null,
      reason: reason };
  }

  function starterCount(group) {
    var c = { QB: 1, RB: 1, WR: 3, TE: 1, OL: 5, EDGE: 2, DL: 2, LB: 3, CB: 3, S: 2, DB: 3, K: 1, P: 1 };
    return c[group] || 1;
  }
  function weightedEpir(list, curve) {
    var s = 0, w = 0, i;
    for (i = 0; i < list.length; i++) {
      var ww = i < curve.length ? curve[i] : (curve[curve.length - 1] || 1);
      s += list[i].epir * ww; w += ww;
    }
    return w > 0 ? s / w : null;
  }

  /* ---------------------------------------------------------------------
     ONE TEAM: every group, then offence / defence / roster.
     --------------------------------------------------------------------- */
  function rateTeam(teamKey, teamName, ratings, opts) {
    opts = opts || {};
    var byGroup = {}, i, g;
    for (i = 0; i < ratings.length; i++) {
      g = ratings[i].group;
      if (!g) continue;
      (byGroup[g] = byGroup[g] || []).push(ratings[i]);
    }
    var groups = {}, order = CFG.GROUP_ORDER;
    for (i = 0; i < order.length; i++) {
      g = order[i];
      if (g === 'LS' || g === 'RET' || g === 'ATH') continue;
      groups[g] = byGroup[g] && byGroup[g].length
        ? rateGroup(g, byGroup[g], opts)
        : emptyGroup(g, 0, 'no player on this roster resolves to ' + g);
    }
    var offense = rollUp(groups, CFG.OFFENSE_GROUPS);
    var defense = rollUp(groups, CFG.DEFENSE_GROUPS);
    var special = rollUp(groups, CFG.SPECIAL_GROUPS);
    var overall = rollUp(groups, CFG.OFFENSE_GROUPS.concat(CFG.DEFENSE_GROUPS, CFG.SPECIAL_GROUPS));

    return {
      schema: SCHEMA, team: teamName, key: teamKey,
      conference: opts.conference || null, season: opts.season || null,
      groups: groups,
      offense: offense, defense: defense, special_teams: special, overall: overall,
      returning: opts.returning || null,
      transfers: opts.transfers || null,
      players_rated: ratings.length,
      as_of: opts.as_of || null
    };
  }

  function rollUp(groups, list) {
    var s = 0, w = 0, cs = 0, i, g, pv;
    var missing = [];
    for (i = 0; i < list.length; i++) {
      g = groups[list[i]];
      pv = CFG.POSITION_VALUE[list[i]] || 0;
      if (!g || !g.available) { if (pv > 0.2) missing.push(list[i]); continue; }
      s += g.rating * pv; w += pv; cs += g.confidence * pv;
    }
    if (!(w > 0)) {
      return { rating: null, available: false, confidence: 0,
        reason: 'no group in this unit produced a rating', missing_groups: missing };
    }
    return { rating: Math.round((s / w) * 10) / 10, available: true,
      confidence: Math.round((cs / w) * 1000) / 1000,
      missing_groups: missing,
      basis: 'position-value weighted mean of the groups that produced a rating; groups that did not are named, never counted as zero' };
  }

  /* ---------------------------------------------------------------------
     RETURNING PRODUCTION 2.0
     Roster continuity and VALUE continuity are different numbers and both
     are published. `prev` is last season's rating records for this team.
     --------------------------------------------------------------------- */
  function returningValue(prevRatings, currentKeys, opts) {
    opts = opts || {};
    if (!prevRatings || !prevRatings.length) {
      return { available: false, reason: 'no prior-season player ratings for this team, so returning VALUE cannot be computed — only the roster count, which is a different statement' };
    }
    var totalValue = 0, retValue = 0, totalPlayers = 0, retPlayers = 0;
    var byGroup = {}, i, p, g;
    for (i = 0; i < prevRatings.length; i++) {
      p = prevRatings[i];
      g = p.group || 'ATH';
      /* VALUE = how much football the player actually played, times how good
         he was relative to replacement. A replacement-level returner adds
         nothing, which is the entire point. */
      var v = playerValue(p);
      var back = !!currentKeys[p.key];
      totalValue += v; totalPlayers++;
      if (back) { retValue += v; retPlayers++; }
      var b = byGroup[g] = byGroup[g] || { total: 0, ret: 0, n: 0, nret: 0, starters: 0, starters_back: 0 };
      b.total += v; b.n++;
      if (back) { b.ret += v; b.nret++; }
      if (p.role && p.role.expected_role === 'STARTER') { b.starters++; if (back) b.starters_back++; }
    }
    var groups = {};
    for (g in byGroup) {
      if (!has(byGroup, g)) continue;
      var bb = byGroup[g];
      groups[g] = {
        value_returning: bb.total > 0 ? Math.round((bb.ret / bb.total) * 1000) / 1000 : null,
        count_returning: bb.n > 0 ? Math.round((bb.nret / bb.n) * 1000) / 1000 : null,
        starters_returning: bb.starters > 0 ? Math.round((bb.starters_back / bb.starters) * 1000) / 1000 : null,
        players: bb.n, starters: bb.starters
      };
    }
    return {
      available: true,
      value_continuity: totalValue > 0 ? Math.round((retValue / totalValue) * 1000) / 1000 : null,
      roster_continuity: totalPlayers > 0 ? Math.round((retPlayers / totalPlayers) * 1000) / 1000 : null,
      players_returning: retPlayers, players_prior: totalPlayers,
      by_group: groups,
      basis: 'VALUE = (EPIR − replacement) × the volume the player actually took, summed. ROSTER CONTINUITY counts bodies. They are published side by side because they disagree, and the disagreement is the information.',
      prior_season: opts.prior_season || null
    };
  }

  function playerValue(p) {
    var above = Math.max(0, (p.epir || 0) - CFG.EPIR_SCALE.center);
    var vol = Math.max(0, p.sample_size || 0);
    var pv = CFG.POSITION_VALUE[p.group] || 0.2;
    return above * Math.sqrt(vol) * pv;
  }

  /* ---------------------------------------------------------------------
     TRANSFER PORTAL INTELLIGENCE
     "41 transfers in" is a headcount. What matters is what came in and what
     left, valued the same way, and how much of it is a guess.
     --------------------------------------------------------------------- */
  function transferValue(incoming, outgoing, opts) {
    opts = opts || {};
    function bucket(list) {
      var starters = [], depthP = [], unknown = [], value = 0, i, p;
      for (i = 0; i < (list || []).length; i++) {
        p = list[i];
        var v = playerValue(p);
        value += v;
        var row = { key: p.key, name: p.name, pos: p.pos, group: p.group, epir: p.epir,
          confidence: p.confidence, from: p.prior_school || null, team: p.team, value: Math.round(v) };
        if (p.confidence < 0.3 || (p.role && p.role.expected_role === 'UNKNOWN')) unknown.push(row);
        else if (p.role && p.role.expected_role === 'STARTER') starters.push(row);
        else depthP.push(row);
      }
      starters.sort(function (a, b) { return b.value - a.value; });
      depthP.sort(function (a, b) { return b.value - a.value; });
      return { count: (list || []).length, value: Math.round(value),
        starter_level: starters, depth_level: depthP, high_uncertainty: unknown };
    }
    var inB = bucket(incoming), outB = bucket(outgoing);
    var net = inB.value - outB.value;
    /* normalise to a readable scale using the league spread the caller
       measured; without it the raw units ship and are labelled as raw. */
    var scale = num(opts.league_value_sd);
    var normal = scale && scale > 0 ? clamp(50 + 12 * (net / scale), 1, 99) : null;
    return {
      available: true,
      in: inB, out: outB, net_value: net,
      net_index: normal == null ? null : Math.round(normal * 10) / 10,
      net_index_basis: normal == null
        ? 'no league-wide spread of net transfer value was supplied, so only the raw units ship'
        : 'net value expressed against the FBS spread of net transfer value: 50 is a typical off-season, 12 points is one standard deviation',
      basis: 'each transfer is valued exactly as any other player is — (EPIR − replacement) × volume × position value. A team adding thirty backups cannot out-grade a team adding five starters, because the arithmetic will not let it.',
      unknown_note: 'an incoming transfer with no production history is HIGH UNCERTAINTY, not zero value and not average value; he is listed separately so he cannot quietly inflate the total.'
    };
  }

  return {
    SCHEMA: SCHEMA,
    AVAIL_W: AVAIL_W, availStatus: availStatus,
    starterCount: starterCount, playerValue: playerValue,
    rateGroup: rateGroup, rateTeam: rateTeam, rollUp: rollUp,
    returningValue: returningValue, transferValue: transferValue,
    config: CFG
  };
});
