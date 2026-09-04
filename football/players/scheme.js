/* ============================================================================
   TEAM SCHEME AND TENDENCY PROFILES.

   What this can honestly say, and what it refuses to say, are both first-class
   outputs. A public play-attribution table carries down, distance, field
   position and who touched the ball. It does NOT carry personnel groupings,
   run concepts, coverage shells, blitz calls, motion or box counts. Nobody
   publishes those for college football without a paid film-charting contract.

   So this module publishes TWO blocks on every team:

     TENDENCIES   measured from plays, opponent-adjusted where it matters, each
                  with its sample size — how often they pass on early downs,
                  how fast they play, how explosive they are, how often they
                  are stopped at the line, how often they allow an explosive.

     UNKNOWN      the named list of things a scheme database is supposed to
                  contain and this one cannot: 11 personnel, inside zone,
                  Cover 3, blitz rate, box count. Each with the reason.

   The one inference it does make — whether a program plays an even or an odd
   front — comes from how that program SPELLS its own front seven on its roster
   (EDGE/OLB versus DE/DT), is capped at 0.35 confidence, and is labelled a
   GUESS everywhere it appears. It is a naming convention, not film study.

   Runs in the browser (window.EDPlayerScheme) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDPlayerConfig;
  var epir = req ? require('./epir.js') : root.EDPlayerRating;
  var api = factory(cfg, epir);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerScheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, EPIR) {
  'use strict';

  var SCHEMA = 'edgedesk_team_scheme_v1';
  var M = EPIR.M, isNum = EPIR.isNum, clamp = EPIR.clamp, mean = EPIR.mean, sd = EPIR.sd;
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function safe(a, b) { return (b > 0) ? a / b : null; }

  /* The tendency contract: what is derived, from what, with what denominator. */
  var TENDENCIES = [
    { id: 'plays_per_game',        basis: 'attributed plays per game — a PACE PROXY, not a true snap count, because the play table does not carry every snap (kickoffs, punts and penalty-only plays are absent)' },
    { id: 'rush_rate',             basis: 'share of attributed scrimmage plays that were runs' },
    { id: 'early_down_pass_rate',  basis: 'share of first- and second-down plays that were dropbacks' },
    { id: 'third_down_pass_rate',  basis: 'share of third-down plays that were dropbacks' },
    { id: 'red_zone_rush_rate',    basis: 'share of plays inside the opponent 20 that were runs' },
    { id: 'success_rate',          basis: 'the conventional down-by-down success definition over all attributed plays' },
    { id: 'explosive_rush_rate',   basis: 'share of carries gaining 15 or more' },
    { id: 'explosive_pass_rate',   basis: 'share of attempts gaining 20 or more' },
    { id: 'stuff_rate_allowed',    basis: 'share of the team’s own carries stopped at or behind the line' },
    { id: 'sack_rate_allowed',     basis: 'sacks taken per dropback' },
    { id: 'yards_per_rush',        basis: 'rushing yards per carry' },
    { id: 'yards_per_attempt',     basis: 'passing yards per attempt' }
  ];
  var DEF_TENDENCIES = [
    { id: 'def_success_allowed',      basis: 'opponent success rate, opponent-adjusted' },
    { id: 'def_rush_success_allowed', basis: 'opponent rushing success rate, opponent-adjusted' },
    { id: 'def_pass_success_allowed', basis: 'opponent dropback success rate, opponent-adjusted' },
    { id: 'def_explosive_rush_allowed', basis: 'share of opponent carries of 15 or more' },
    { id: 'def_explosive_pass_allowed', basis: 'share of opponent attempts of 20 or more' },
    { id: 'def_stuff_rate',           basis: 'share of opponent carries stopped at or behind the line' },
    { id: 'def_sack_rate',            basis: 'sacks generated per opponent dropback' },
    { id: 'def_yards_per_rush',       basis: 'opponent yards per carry' },
    { id: 'def_yards_per_attempt',    basis: 'opponent yards per attempt' }
  ];

  function offenseRates(a) {
    if (!a) return null;
    return {
      plays_per_game: safe(a.plays, a.games),
      rush_rate: safe(a.rush_att, a.rush_att + a.dropbacks),
      early_down_pass_rate: safe(a.early_down_pass, a.early_down_plays),
      third_down_pass_rate: safe(a.third_pass, a.third_plays),
      red_zone_rush_rate: safe(a.rz_rush, a.rz_plays),
      success_rate: safe(a.rush_success + a.pass_success, a.rush_att + a.dropbacks),
      explosive_rush_rate: safe(a.rush_explosive, a.rush_att),
      explosive_pass_rate: safe(a.pass_explosive, a.pass_att),
      stuff_rate_allowed: safe(a.rush_stuffed, a.rush_att),
      sack_rate_allowed: safe(a.sacks_taken, a.dropbacks),
      yards_per_rush: safe(a.rush_yds, a.rush_att),
      yards_per_attempt: safe(a.pass_yds, a.pass_att),
      _n: { plays: a.plays, games: a.games, rush_att: a.rush_att, dropbacks: a.dropbacks }
    };
  }
  function defenseRates(a) {
    if (!a) return null;
    return {
      def_success_allowed: safe(a.rush_success + a.pass_success, a.rush_att + a.dropbacks),
      def_rush_success_allowed: safe(a.rush_success, a.rush_att),
      def_pass_success_allowed: safe(a.pass_success, a.dropbacks),
      def_explosive_rush_allowed: safe(a.rush_explosive, a.rush_att),
      def_explosive_pass_allowed: safe(a.pass_explosive, a.pass_att),
      def_stuff_rate: safe(a.rush_stuffed, a.rush_att),
      def_sack_rate: safe(a.sacks_taken, a.dropbacks),
      def_yards_per_rush: safe(a.rush_yds, a.rush_att),
      def_yards_per_attempt: safe(a.pass_yds, a.pass_att),
      _n: { plays: a.plays, games: a.games, rush_att: a.rush_att, dropbacks: a.dropbacks }
    };
  }

  /* League standardisation, so every tendency can be read as "how unusual". */
  function leagueStats(rows, keys) {
    var out = {}, i, k;
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      var vals = [];
      for (var j = 0; j < rows.length; j++) {
        var v = num(rows[j][k]);
        if (v != null) vals.push(v);
      }
      out[k] = vals.length >= 8
        ? { mean: mean(vals), sd: sd(vals), n: vals.length }
        : { mean: null, sd: null, n: vals.length };
    }
    return out;
  }

  /* Front-family GUESS from the roster's own position spelling. Capped, and
     labelled a guess wherever it appears. */
  function frontGuess(rosterPositions) {
    var odd = 0, even = 0, i, p;
    for (i = 0; i < (rosterPositions || []).length; i++) {
      p = String(rosterPositions[i] || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (p === 'EDGE' || p === 'OLB' || p === 'RUSH') odd++;
      else if (p === 'DE' || p === 'DT' || p === 'NT') even++;
    }
    var tot = odd + even;
    if (tot < 6) {
      return M.missing('fewer than six front-seven players carry a position spelling this inference can read');
    }
    var share = odd / tot;
    return M(share, {
      confidence: CFG.SCHEME.front_guess.max_confidence,
      n: tot,
      source: 'roster position spelling',
      basis: CFG.SCHEME.front_guess.basis
    });
  }
  function frontLabel(g) {
    if (!g || !g.available) return { label: 'UNKNOWN', guess: true, reason: g ? g.reason : 'no front inference' };
    if (g.value >= 0.6) return { label: 'ODD-FRONT LEAN (guess)', guess: true, share: g.value };
    if (g.value <= 0.25) return { label: 'EVEN-FRONT LEAN (guess)', guess: true, share: g.value };
    return { label: 'MIXED SPELLING (guess)', guess: true, share: g.value };
  }

  function paceLabel(z) {
    if (z == null) return 'UNKNOWN';
    if (z >= CFG.SCHEME.pace.fast_z) return 'FAST';
    if (z <= CFG.SCHEME.pace.slow_z) return 'SLOW';
    return 'AVERAGE';
  }
  function identityLabel(o, lg) {
    if (!o || o.rush_rate == null || !lg.rush_rate || lg.rush_rate.mean == null) return 'UNKNOWN';
    var z = (o.rush_rate - lg.rush_rate.mean) / (lg.rush_rate.sd || 1);
    if (z >= 0.9) return 'RUN-LEANING';
    if (z <= -0.9) return 'PASS-LEANING';
    return 'BALANCED';
  }

  /* --------------------------------------------------------------------
     BLENDING THIS SEASON WITH LAST SEASON.
     In week one a team has sixty plays and no scheme profile worth the name;
     by week eight it has five hundred and last season is noise. Rather than
     switch abruptly, the counters are summed with last season's down-weighted
     by a factor that decays as this season accumulates:

         lambda = clamp(1 - plays_this_season / full_weight_plays, 0, 1)

     Every blended profile reports the lambda it used and how many plays came
     from each season, so a week-one profile is visibly mostly last year's team
     and a week-ten profile is visibly this year's.
     -------------------------------------------------------------------- */
  var BLEND_FULL_WEIGHT_PLAYS = 600;   /* about eight games of attributed plays */

  function blendAggregates(curMap, prevMap, fullWeightPlays) {
    var full = fullWeightPlays || BLEND_FULL_WEIGHT_PLAYS;
    var out = new Map(), keys = {}, k;
    if (curMap) curMap.forEach(function (v, kk) { keys[kk] = 1; });
    if (prevMap) prevMap.forEach(function (v, kk) { keys[kk] = 1; });
    for (k in keys) {
      if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
      var c = curMap ? curMap.get(k) : null;
      var p = prevMap ? prevMap.get(k) : null;
      var curPlays = c ? (c.plays || 0) : 0;
      var lambda = clamp(1 - curPlays / full, 0, 1);
      if (!p) { if (c) { c._blend = { lambda: 0, cur_plays: curPlays, prev_plays: 0 }; out.set(k, c); } continue; }
      if (!c) {
        var only = {};
        for (var kk2 in p) if (typeof p[kk2] === 'number') only[kk2] = p[kk2];
        only._blend = { lambda: 1, cur_plays: 0, prev_plays: p.plays || 0,
          note: 'this team has produced no attributed play this season, so the profile is entirely last season’s' };
        out.set(k, only);
        continue;
      }
      var m = {};
      for (var kk in c) if (typeof c[kk] === 'number') m[kk] = c[kk] + lambda * (typeof p[kk] === 'number' ? p[kk] : 0);
      m._blend = { lambda: Math.round(lambda * 1000) / 1000, cur_plays: curPlays, prev_plays: p.plays || 0 };
      out.set(k, m);
    }
    return out;
  }

  /* Build every team's profile in one pass, because standardisation needs the
     whole league. offAgg/defAgg are Maps of teamKey -> aggregate. */
  function buildProfiles(offAgg, defAgg, opts) {
    opts = opts || {};
    var teams = {}, k;
    var offRows = [], defRows = [], keys = [];
    var offBy = {}, defBy = {};
    offAgg.forEach(function (a, key) { var r = offenseRates(a); if (r) { offBy[key] = r; offRows.push(r); } });
    defAgg.forEach(function (a, key) { var r = defenseRates(a); if (r) { defBy[key] = r; defRows.push(r); } });
    var offKeys = TENDENCIES.map(function (t) { return t.id; });
    var defKeys = DEF_TENDENCIES.map(function (t) { return t.id; });
    var lgOff = leagueStats(offRows, offKeys), lgDef = leagueStats(defRows, defKeys);

    function typed(v, lg, id, basis, n, source) {
      if (v == null) return M.missing('no ' + id + ' observed for this team');
      var z = (lg && lg.mean != null && lg.sd > 0) ? (v - lg.mean) / lg.sd : null;
      var m = M(v, { confidence: n && n >= 200 ? 0.85 : (n && n >= 60 ? 0.6 : 0.35), n: n || null, source: source, basis: basis });
      m.z = z == null ? null : Math.round(z * 1000) / 1000;
      m.league_mean = lg && lg.mean != null ? Math.round(lg.mean * 10000) / 10000 : null;
      return m;
    }

    for (k in offBy) {
      if (!Object.prototype.hasOwnProperty.call(offBy, k)) continue;
      teams[k] = teams[k] || { schema: SCHEMA, key: k, season: opts.season || null,
        version: CFG.versions.scheme_matchup, offense: {}, defense: {}, labels: {}, unknown: CFG.SCHEME.not_derivable };
      var o = offBy[k], i;
      for (i = 0; i < TENDENCIES.length; i++) {
        var t = TENDENCIES[i];
        teams[k].offense[t.id] = typed(o[t.id], lgOff[t.id], t.id, t.basis, o._n.plays, 'cfbfastR player_stats play attribution');
      }
      teams[k].offense._n = o._n;
      var ba = offAgg.get(k);
      if (ba && ba._blend) teams[k].blend = ba._blend;
    }
    for (k in defBy) {
      if (!Object.prototype.hasOwnProperty.call(defBy, k)) continue;
      teams[k] = teams[k] || { schema: SCHEMA, key: k, season: opts.season || null,
        version: CFG.versions.scheme_matchup, offense: {}, defense: {}, labels: {}, unknown: CFG.SCHEME.not_derivable };
      var d = defBy[k];
      for (var j = 0; j < DEF_TENDENCIES.length; j++) {
        var dt = DEF_TENDENCIES[j];
        teams[k].defense[dt.id] = typed(d[dt.id], lgDef[dt.id], dt.id, dt.basis, d._n.plays, 'cfbfastR player_stats play attribution');
      }
      teams[k].defense._n = d._n;
    }
    for (k in teams) {
      if (!Object.prototype.hasOwnProperty.call(teams, k)) continue;
      var T = teams[k];
      var pz = T.offense.plays_per_game && T.offense.plays_per_game.z;
      T.labels.pace = paceLabel(pz);
      T.labels.identity = identityLabel(offBy[k], lgOff);
      var fg = frontGuess(opts.rosterPositions ? opts.rosterPositions[k] : null);
      T.front = fg;
      T.labels.front = frontLabel(fg);
      T.derivable = CFG.SCHEME.derivable;
      T.confidence = confidenceOf(T);
    }
    return { teams: teams, league: { offense: lgOff, defense: lgDef },
      basis: 'every tendency is counted from the public play-attribution table and standardised against the FBS teams that season' };
  }

  function confidenceOf(T) {
    var vals = [], k;
    for (k in T.offense) { if (k.charAt(0) !== '_' && T.offense[k] && T.offense[k].available) vals.push(T.offense[k].confidence); }
    for (k in T.defense) { if (k.charAt(0) !== '_' && T.defense[k] && T.defense[k].available) vals.push(T.defense[k].confidence); }
    var total = Object.keys(CFG.SCHEME.not_derivable).length;
    var got = vals.length, want = TENDENCIES.length + DEF_TENDENCIES.length;
    var m = vals.length ? mean(vals) : 0;
    /* the unknown block is part of the honesty: a scheme profile that cannot
       see coverage or personnel is NEVER a complete scheme profile, and its
       confidence says so rather than reporting completeness over what it did
       manage to measure. */
    return {
      value: Math.round(m * (got / want) * 1000) / 1000,
      measured_tendencies: got, contracted_tendencies: want,
      undecidable_dimensions: total,
      basis: 'mean confidence of the tendencies actually measured, scaled by how many of the contracted tendencies were measured at all. It is NOT scaled up for the ' + total + ' scheme dimensions no public feed carries — those are listed separately and never counted as measured.'
    };
  }

  /* team-context z-scores the unit layer reads for groups whose individuals
     the feed cannot see (OL) and for defensive groups generally. */
  function unitContext(profile) {
    if (!profile) return null;
    function z(m) { return (m && m.available && m.z != null) ? m.z : null; }
    var out = {};
    /* an offensive line is what its team's sack rate allowed and stuff rate
       allowed say it is — both fully observed, both opponent-adjustable */
    var sackAllowed = z(profile.offense.sack_rate_allowed);
    var stuffAllowed = z(profile.offense.stuff_rate_allowed);
    if (sackAllowed != null || stuffAllowed != null) {
      var parts = [];
      if (sackAllowed != null) parts.push(-sackAllowed);
      if (stuffAllowed != null) parts.push(-stuffAllowed);
      out.OL_z = mean(parts);
      out.OL_conf = (sackAllowed != null && stuffAllowed != null) ? 0.7 : 0.45;
      out.OL_basis = 'the team’s own opponent-adjusted sack rate allowed and stuff rate allowed — the only observable evidence about a college offensive line anywhere public';
    }
    var dRush = z(profile.defense.def_rush_success_allowed), dStuff = z(profile.defense.def_stuff_rate),
      dExpR = z(profile.defense.def_explosive_rush_allowed);
    var runParts = [];
    if (dRush != null) runParts.push(-dRush);
    if (dStuff != null) runParts.push(dStuff);
    if (dExpR != null) runParts.push(-dExpR);
    if (runParts.length) {
      out.DL_z = mean(runParts); out.DL_conf = 0.7;
      out.DL_basis = 'the team’s own run defence: opponent-adjusted rushing success allowed, stuff rate and explosive runs allowed';
      out.LB_z = mean(runParts) * 0.8; out.LB_conf = 0.55;
      out.LB_basis = 'the same run-defence record, weighted down because a linebacker’s coverage work is unobserved';
    }
    var dSack = z(profile.defense.def_sack_rate), dPass = z(profile.defense.def_pass_success_allowed);
    var rushParts = [];
    if (dSack != null) rushParts.push(dSack);
    if (dPass != null) rushParts.push(-dPass);
    if (rushParts.length) {
      out.EDGE_z = mean(rushParts); out.EDGE_conf = 0.65;
      out.EDGE_basis = 'the team’s own opponent-adjusted sack rate and dropback success allowed';
    }
    var dExpP = z(profile.defense.def_explosive_pass_allowed);
    var covParts = [];
    if (dPass != null) covParts.push(-dPass);
    if (dExpP != null) covParts.push(-dExpP);
    if (covParts.length) {
      out.CB_z = mean(covParts); out.CB_conf = 0.6;
      out.CB_basis = 'the team’s own opponent-adjusted dropback success and explosive passes allowed';
      out.S_z = mean(covParts) * 0.9; out.S_conf = 0.55;
      out.S_basis = 'the same coverage record, weighted down because safety run support is unobserved';
      out.DB_z = out.CB_z; out.DB_conf = 0.5; out.DB_basis = out.CB_basis;
    }
    return out;
  }

  return {
    SCHEMA: SCHEMA,
    TENDENCIES: TENDENCIES, DEF_TENDENCIES: DEF_TENDENCIES,
    offenseRates: offenseRates, defenseRates: defenseRates,
    blendAggregates: blendAggregates, BLEND_FULL_WEIGHT_PLAYS: BLEND_FULL_WEIGHT_PLAYS,
    leagueStats: leagueStats, buildProfiles: buildProfiles,
    frontGuess: frontGuess, frontLabel: frontLabel,
    unitContext: unitContext, paceLabel: paceLabel,
    config: CFG
  };
});
