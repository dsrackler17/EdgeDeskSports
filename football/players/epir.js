/* ============================================================================
   THE EDGEDESK PLAYER IMPACT RATING (EPIR) — what a college football player is
   actually worth right now, on evidence EdgeDesk can show you.

   0-100. 50 is positional replacement. One standard deviation of the position's
   own qualified population is 12 points.

   THE RULE THAT MAKES IT HONEST, inherited from the Power 4 engine and not
   relaxed here: A MISSING INPUT CONTRIBUTES EXACTLY NOTHING TO THE RATING AND
   INSTEAD LOWERS ITS CONFIDENCE. No substitution, no league-average stand-in,
   no quiet default. A freshman with no snaps is MAXIMUM uncertainty, not an
   average player — and the rating says which of the two it is on its face.

   WHAT THIS IS NOT
   * It is not an LLM output. Nothing in this file, in the build that feeds it,
     or in the app that renders it asks a model to produce a number. AI may
     explain a rating; AI may never invent one. Every component is arithmetic
     over counted events and every rating carries the counts.
   * It is not a scouting grade. It cannot see blocking, tackling, coverage,
     pressure short of a sack, or a snap count, because no public feed carries
     them. Where it cannot see, it says so and the confidence collapses.
   * It is not a betting number. Nothing here prices a line by itself.

   HOW A RATING IS BUILT
     1  COUNT      events attributed to the player, from cfbfastR's public
                   play-attribution table. Counted, never modelled.
     2  RATE       position-specific rate statistics with their own
                   denominators (see config.js MEASURES).
     3  ADJUST     each rate is moved by the quality of the defences actually
                   faced, when the build could measure them.
     4  STANDARDISE against the player's OWN position group in the SAME season.
     5  SHRINK     toward the prior by n/(n+k), where k is the group's MEASURED
                   season-to-season reliability, not a chosen constant.
     6  SCALE      z -> 0-100, plus two small, capped, separable additions
                   (role, experience) that each declare themselves.
     7  DECLARE    confidence, sample size, data completeness, every component
                   used, every component missing, and where it all came from.

   Runs in the browser (window.EDPlayerRating) and in node (module.exports).
   Pure: no I/O, no clock reads except an optional caller-supplied `as_of`.
   ========================================================================== */
(function (root, factory) {
  var cfg = (typeof require === 'function' && typeof module === 'object' && module.exports)
    ? require('./config.js')
    : root.EDPlayerConfig;
  var api = factory(cfg);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerRating = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG) {
  'use strict';

  var SCHEMA = 'edgedesk_player_impact_rating_v1';
  var VERSION = 1;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  function sd(a) {
    if (a.length < 2) return null;
    var m = mean(a), s = 0, i;
    for (i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  function fold(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return t;
  }
  /* THE SAME TEAM KEY THE POWER 4 ENGINE USES, character for character.
     app.html joins this layer to the football board through EDCfbP4.normKey,
     so any divergence here silently loses a team rather than erroring — and
     the team it would lose first is Texas A&M, because an ampersand is exactly
     the kind of character two normalisers disagree about. normKey folds
     accents and strips every non-alphanumeric, so "Texas A&M" is "texasam".
     Mirror it; do not improve on it. */
  function teamKey(s) {
    if (s == null) return null;
    return fold(s).toLowerCase().replace(/[^a-z0-9]/g, '') || null;
  }
  function nameKey(s) {
    if (s == null) return null;
    return fold(s).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim() || null;
  }

  /* ---------------------------------------------------------------------
     TYPED MEASUREMENT — identical in shape to the Power 4 engine's M(), so
     the app renders a player measurement and a team measurement with one
     code path and "I don't know" is a first-class value in both.
     --------------------------------------------------------------------- */
  function M(value, opts) {
    opts = opts || {};
    var ok = isNum(value);
    return {
      value: ok ? value : null,
      available: ok,
      confidence: ok ? clamp(isNum(opts.confidence) ? opts.confidence : 1, 0, 1) : 0,
      n: isNum(opts.n) ? opts.n : null,
      source: opts.source || null,
      as_of: opts.as_of || null,
      basis: opts.basis || null,
      reason: ok ? null : (opts.reason || 'not supplied')
    };
  }
  M.missing = function (reason, source) {
    return { value: null, available: false, confidence: 0, n: null,
      source: source || null, as_of: null, basis: null, reason: reason };
  };
  function avail(m) { return !!(m && m.available); }

  /* =====================================================================
     1. IDENTITY
     Never join players by name alone when a stable id exists. The public
     feeds agree on ESPN's athlete id, which is the backbone; a name join is
     a LAST resort, is only allowed within one team-season, and is recorded
     on the player so its cost is visible in the confidence.
     ===================================================================== */
  var identity = {
    /* canonical player key. An athlete id is globally unique; a name join is
       scoped to the team so two different players never collide. */
    key: function (rec) {
      var id = rec && rec.athlete_id != null ? String(rec.athlete_id).trim() : '';
      if (id && id !== 'NA' && id !== '0') return 'a:' + id;
      var n = nameKey(rec && rec.name), t = teamKey(rec && (rec.team_key || rec.team));
      if (n && t) return 'n:' + t + ':' + n.replace(/ /g, '_');
      return null;
    },
    tier: function (rec) {
      var id = rec && rec.athlete_id != null ? String(rec.athlete_id).trim() : '';
      if (id && id !== 'NA' && id !== '0') return 'athlete_id';
      if (nameKey(rec && rec.name) && teamKey(rec && (rec.team_key || rec.team))) return 'name_and_team';
      return 'name_only';
    },
    teamKey: teamKey,
    nameKey: nameKey,

    /* Merge duplicate rows for ONE player within ONE season. This happens for
       real: a mid-season transfer appears under two teams, and a feed can emit
       the same athlete twice. Counting stats add; the team, position and class
       come from the LATEST week seen, because that is where the player is now.
       Nothing is dropped silently — `duplicates` records what was merged. */
    mergeSeason: function (rows) {
      if (!rows || !rows.length) return null;
      var sorted = rows.slice().sort(function (a, b) {
        return (num(a.last_week) || 0) - (num(b.last_week) || 0);
      });
      var latest = sorted[sorted.length - 1];
      var out = {
        athlete_id: latest.athlete_id, name: latest.name,
        team: latest.team, team_key: teamKey(latest.team_key || latest.team),
        conference: latest.conference, season: latest.season,
        pos: latest.pos, group: latest.group || CFG.group(latest.pos),
        class_year: latest.class_year, height_in: latest.height_in, weight_lb: latest.weight_lb,
        prior_school: latest.prior_school, status: latest.status,
        roster: latest.roster || null,
        games: 0, first_week: null, last_week: null,
        stat: {}, opponent: null,
        teams_this_season: [], duplicates: rows.length > 1 ? rows.length : 0
      };
      var seenTeams = {}, i, r, k;
      for (i = 0; i < sorted.length; i++) {
        r = sorted[i];
        out.games += num(r.games) || 0;
        var fw = num(r.first_week), lw = num(r.last_week);
        if (fw != null && (out.first_week == null || fw < out.first_week)) out.first_week = fw;
        if (lw != null && (out.last_week == null || lw > out.last_week)) out.last_week = lw;
        var tk = teamKey(r.team_key || r.team);
        if (tk && !seenTeams[tk]) { seenTeams[tk] = 1; out.teams_this_season.push({ team: r.team, key: tk }); }
        for (k in (r.stat || {})) {
          if (!has(r.stat, k)) continue;
          var v = num(r.stat[k]);
          if (v == null) continue;
          out.stat[k] = (out.stat[k] || 0) + v;
        }
      }
      /* opponent-adjustment offsets are plays-weighted, so they cannot simply
         add. The build supplies them already weighted per row; re-weight by
         each row's own denominator when more than one row exists. */
      out.opponent = mergeOpponent(sorted);
      out.mid_season_move = out.teams_this_season.length > 1;
      return out;
    }
  };

  function mergeOpponent(rows) {
    var acc = {}, wacc = {}, i, r, k;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r.opponent) continue;
      var w = num(r.opponent._weight);
      if (w == null) w = 1;
      for (k in r.opponent) {
        if (!has(r.opponent, k) || k.charAt(0) === '_') continue;
        var v = num(r.opponent[k]);
        if (v == null) continue;
        acc[k] = (acc[k] || 0) + v * w;
        wacc[k] = (wacc[k] || 0) + w;
      }
    }
    var out = null;
    for (k in acc) { if (wacc[k] > 0) { out = out || {}; out[k] = acc[k] / wacc[k]; } }
    return out;
  }

  /* =====================================================================
     2. RATES — counting stats to position-specific rate statistics.
     Every rate returns { v, n } or null. A rate with no denominator is null,
     never 0: a receiver with no targets has no catch rate, and pretending he
     has a catch rate of zero is the exact lie this layer exists to avoid.
     ===================================================================== */
  function rate(numr, den) {
    var a = num(numr), b = num(den);
    if (a == null || b == null || !(b > 0)) return null;
    return { v: a / b, n: b };
  }
  function denom(st, key) {
    switch (key) {
      case 'dropbacks': return (num(st.pass_att) || 0) + (num(st.sacks_taken) || 0);
      case 'pass_att': return num(st.pass_att);
      case 'rush_att': return num(st.rush_att);
      case 'qb_rush_att': return num(st.qb_rush_att);
      case 'receptions': return num(st.receptions);
      case 'targets': return num(st.targets);
      case 'touches': return (num(st.rush_att) || 0) + (num(st.receptions) || 0);
      case 'fg_att': return num(st.fg_att);
      case 'fg_att_long': return num(st.fg_att_long);
      case 'def_dropbacks_faced': return num(st.def_dropbacks_faced);
      case 'def_plays_faced': return num(st.def_plays_faced);
      case 'team_def_games': return num(st.team_def_games);
      case 'punts': return num(st.box_punts);
      default: return null;
    }
  }

  /* The full rate contract. Each entry is computed only from counted events. */
  function rates(ps) {
    var st = (ps && ps.stat) || {};
    var db = (num(st.pass_att) || 0) + (num(st.sacks_taken) || 0);
    var touches = (num(st.rush_att) || 0) + (num(st.receptions) || 0);
    var R = {
      /* passing */
      pass_success_rate:   rate(st.pass_success, db),
      yards_per_attempt:   rate(st.pass_yds, st.pass_att),
      explosive_pass_rate: rate(st.pass_explosive, st.pass_att),
      completion_pct:      rate(st.pass_cmp, st.pass_att),
      sack_rate_taken:     rate(st.sacks_taken, db),
      int_rate:            rate(st.int_thrown, st.pass_att),
      /* quarterback rushing, kept apart from a running back's */
      qb_rush_success_rate: rate(st.qb_rush_success, st.qb_rush_att),
      qb_yards_per_rush:    rate(st.qb_rush_yds, st.qb_rush_att),
      /* rushing */
      rush_success_rate:   rate(st.rush_success, st.rush_att),
      yards_per_rush:      rate(st.rush_yds, st.rush_att),
      explosive_rush_rate: rate(st.rush_explosive, st.rush_att),
      stuff_rate:          rate(st.rush_stuffed, st.rush_att),
      fumble_rate:         rate(st.fumbles, touches),
      /* receiving */
      rec_success_rate:    rate(st.rec_success, st.receptions),
      rec_yards_per_catch: rate(st.rec_yds, st.receptions),
      explosive_rec_rate:  rate(st.rec_explosive, st.receptions),
      first_down_rate_rec: rate(st.rec_first_downs, st.receptions),
      catch_rate:          rate(st.receptions, st.targets),
      /* defence — everything the feed actually attributes to a defender.
         The denominator is TEAM DEFENSIVE GAMES, not snaps: no public feed
         publishes a defensive snap count, so these are production-per-game
         measures and the rating record says so rather than implying a rate
         per opportunity it cannot see. */
      sacks_per_game:      rate(st.def_sacks, st.team_def_games),
      pbu_per_game:        rate(st.def_pbu, st.team_def_games),
      int_per_game:        rate(st.def_int, st.team_def_games),
      ff_per_game:         rate(st.def_ff, st.team_def_games),
      /* kept for callers that want a per-opportunity view where the team
         volume is known; not part of any measure contract */
      sack_rate_def:       rate(st.def_sacks, st.def_dropbacks_faced),
      /* ---- BOX-SCORE ENRICHMENT (football/data/build_box.js) ----
         Distinct keys from the play-table measures on purpose: v1 must be
         provably unchanged by this file's existence, and a reader must be able
         to see which feed a number came from. All of these are gated per
         season — the columns are only filled in from 2024 onward. */
      box_tackles_per_game: rate(st.box_tackles, st.team_def_games),
      box_tfl_per_game:     rate(st.box_tfl, st.team_def_games),
      box_hurries_per_game: rate(st.box_hurries, st.team_def_games),
      box_sacks_per_game:   rate(st.box_sacks, st.team_def_games),
      box_pbu_per_game:     rate(st.box_pbu, st.team_def_games),
      box_int_per_game:     rate(st.box_ints, st.team_def_games),
      /* punting: gross, never net — no public feed attributes return yardage
         against a named punter */
      punt_average:         rate(st.box_punt_yds, st.box_punts),
      punts_inside_20_rate: rate(st.box_punts_in20, st.box_punts),
      /* kicking */
      fg_pct:              rate(st.fg_made, st.fg_att),
      fg_pct_long:         rate(st.fg_made_long, st.fg_att_long)
    };
    return R;
  }

  /* Total observed volume for the player, the number the confidence reads.
     It is TOUCHES AND ATTRIBUTED EVENTS, not snaps. Snaps are not in any
     public feed and this layer never claims otherwise. */
  function volume(ps) {
    var st = (ps && ps.stat) || {};
    var g = ps.group;
    if (g === 'QB') return (num(st.pass_att) || 0) + (num(st.sacks_taken) || 0) + (num(st.qb_rush_att) || 0);
    if (g === 'RB') return (num(st.rush_att) || 0) + (num(st.receptions) || 0);
    if (g === 'WR' || g === 'TE') return (num(st.receptions) || 0) + Math.max(0, (num(st.targets) || 0) - (num(st.receptions) || 0));
    if (g === 'K') return num(st.fg_att) || 0;
    if (CFG.DEFENSE_GROUPS.indexOf(g) >= 0) {
      var playSide = (num(st.def_sacks) || 0) + (num(st.def_int) || 0) + (num(st.def_pbu) || 0)
        + (num(st.def_ff) || 0) + (num(st.def_fr) || 0);
      /* where the box score is present it observes far more of a defender's
         work than the play table ever did, and volume should say so */
      var boxSide = (num(st.box_tackles) || 0) + (num(st.box_tfl) || 0) + (num(st.box_hurries) || 0)
        + (num(st.box_pbu) || 0) + (num(st.box_ints) || 0);
      return Math.max(playSide, boxSide);
    }
    if (g === 'P') return num(st.box_punts) || 0;
    return 0;
  }

  /* =====================================================================
     3. BASELINES — the position group's own qualified population, per season.
     Standardising a quarterback against quarterbacks and a corner against
     corners is the whole reason there is no single generic formula here.
     ===================================================================== */
  function buildBaselines(seasonPlayers, coverage, variant) {
    var CONTRACTS = CFG.measures ? CFG.measures(variant || 'v1') : CFG.MEASURES;
    var out = {};
    var byGroup = {}, i, p, g;
    for (i = 0; i < seasonPlayers.length; i++) {
      p = seasonPlayers[i];
      g = p.group;
      if (!g) continue;
      (byGroup[g] = byGroup[g] || []).push(p);
    }
    for (g in byGroup) {
      if (!has(byGroup, g)) continue;
      var contract = CONTRACTS[g] || [];
      var stats = {};
      for (var mi = 0; mi < contract.length; mi++) {
        var mdef = contract[mi];
        if (mdef.gate && coverage && coverage[mdef.gate] && coverage[mdef.gate].usable === false) {
          stats[mdef.key] = { usable: false, reason: coverage[mdef.gate].reason, n: 0 };
          continue;
        }
        var vals = [];
        for (i = 0; i < byGroup[g].length; i++) {
          var r = rates(byGroup[g][i]);
          var m = r[mdef.key];
          if (m && m.n >= mdef.min_n) vals.push(m.v);
        }
        if (vals.length < 12) {
          stats[mdef.key] = { usable: false, n: vals.length,
            reason: 'only ' + vals.length + ' ' + g + 's cleared the minimum sample for ' + mdef.key
              + ' this season — too few to standardise against, so the measure is not scored' };
          continue;
        }
        var mu = mean(vals), s = sd(vals);
        stats[mdef.key] = { usable: !!(s > 0), mean: mu, sd: s, n: vals.length,
          reason: s > 0 ? null : 'zero variance in ' + mdef.key + ' across the qualified population' };
      }
      out[g] = { measures: stats, population: byGroup[g].length };
    }
    return out;
  }

  /* Opponent adjustment. `ps.opponent` carries, per measure key, the
     plays-weighted mean rate the DEFENCES THIS PLAYER FACED allowed, and
     `leagueAllowed` the FBS mean. The adjustment moves the player's raw rate
     by how much easier or harder his schedule was. When the build could not
     measure it, the raw rate is used and the record says it was not adjusted. */
  function adjustForOpponent(key, raw, ps, leagueAllowed, dir) {
    var opp = ps && ps.opponent;
    if (!opp || !isNum(num(opp[key])) || !leagueAllowed || !isNum(num(leagueAllowed[key]))) {
      return { v: raw, adjusted: false, delta: null };
    }
    var faced = num(opp[key]), league = num(leagueAllowed[key]);
    /* A defence that allows MORE than league average made this rate easier, so
       the player's number comes down; dir flips it for a lower-is-better rate. */
    var delta = (faced - league) * (dir >= 0 ? 1 : -1);
    return { v: raw - delta, adjusted: true, delta: delta };
  }

  /* =====================================================================
     4. THE RATING
     ===================================================================== */
  function shrinkK(group, params) {
    var rel = params && params.reliability && params.reliability[group];
    if (rel && isNum(num(rel.k)) && rel.pairs >= (CFG.SHRINK.min_pairs_to_measure || 40)) {
      return { k: num(rel.k), measured: true, r: num(rel.r), pairs: rel.pairs,
        basis: 'k = n_bar (1 - r) / r from ' + rel.pairs + ' consecutive-season pairs, r = ' + (num(rel.r) || 0).toFixed(3) };
    }
    var fk = CFG.SHRINK.fallback_k[group];
    return { k: isNum(fk) ? fk : 1e9, measured: false, r: null, pairs: rel ? rel.pairs : 0,
      basis: 'the group had too few consecutive-season pairs to measure its own reliability, so a declared fallback is used and this rating is marked k_measured:false' };
  }

  function roleBand(share, hasParticipation) {
    if (share == null) return 'UNKNOWN';
    /* participation-based shares live on a different scale from touch shares —
       a starting lineman appears in 100% of games but takes 0% of the touches —
       so they get their own bands rather than being read against v1's. */
    if (hasParticipation && CFG.PARTICIPATION) {
      var pb = CFG.PARTICIPATION.bands, j;
      for (j = 0; j < pb.length; j++) {
        if (pb[j].min == null) return pb[j].role;
        if (share >= pb[j].min) return pb[j].role;
      }
      return 'UNKNOWN';
    }
    var bands = CFG.ROLE.bands, i;
    for (i = 0; i < bands.length; i++) {
      if (bands[i].min_share == null) return bands[i].role;
      if (share >= bands[i].min_share) return bands[i].role;
    }
    return 'UNKNOWN';
  }

  /* One player, one season of evidence, one rating.
     ctx = { baselines, params, leagueAllowed, coverage, season, as_of,
             career: [ {season, z, n} ... ] older seasons already rated,
             availability: {status, source, as_of} } */
  function ratePlayer(ps, ctx) {
    ctx = ctx || {};
    var g = ps.group || CFG.group(ps.pos);
    var CONTRACTS = CFG.measures ? CFG.measures(ctx.variant || 'v1') : CFG.MEASURES;
    var contract = CONTRACTS[g] || [];
    var base = (ctx.baselines && ctx.baselines[g]) || null;
    var R = rates(ps);
    var used = [], missing = [], zParts = [], wSum = 0, zSum = 0, oppAdjusted = 0, oppTotal = 0;
    var nEffective = 0;

    for (var i = 0; i < contract.length; i++) {
      var mdef = contract[i];
      var raw = R[mdef.key];
      var bstat = base && base.measures ? base.measures[mdef.key] : null;
      if (mdef.gate && ctx.coverage && ctx.coverage[mdef.gate] && ctx.coverage[mdef.gate].usable === false) {
        missing.push({ key: mdef.key, reason: ctx.coverage[mdef.gate].reason, kind: 'coverage_gate' });
        continue;
      }
      if (!raw) {
        missing.push({ key: mdef.key, reason: 'no ' + mdef.den + ' recorded for this player', kind: 'no_denominator' });
        continue;
      }
      if (raw.n < mdef.min_n) {
        missing.push({ key: mdef.key, n: raw.n, min_n: mdef.min_n,
          reason: raw.n + ' ' + mdef.den + ' is below the ' + mdef.min_n + ' this measure needs to be read at all', kind: 'below_min_sample' });
        continue;
      }
      if (!bstat || bstat.usable === false) {
        missing.push({ key: mdef.key, reason: (bstat && bstat.reason) || 'no baseline for this measure this season', kind: 'no_baseline' });
        continue;
      }
      oppTotal++;
      var adj = adjustForOpponent(mdef.key, raw.v, ps, ctx.leagueAllowed, mdef.dir);
      if (adj.adjusted) oppAdjusted++;
      var z = ((adj.v - bstat.mean) / bstat.sd) * mdef.dir;
      zSum += z * mdef.w; wSum += mdef.w;
      nEffective = Math.max(nEffective, raw.n);
      used.push({ key: mdef.key, value: raw.v, adjusted_value: adj.v, n: raw.n, z: z, w: mdef.w,
        opponent_adjusted: adj.adjusted, opponent_delta: adj.delta,
        baseline_mean: bstat.mean, baseline_sd: bstat.sd, baseline_n: bstat.n, basis: mdef.basis });
    }

    var vol = volume(ps);
    var K = shrinkK(g, ctx.params);
    var zRaw = wSum > 0 ? zSum / wSum : null;

    /* career evidence: this season plus prior seasons already rated, decayed. */
    var careerZ = null, careerN = 0, careerParts = [];
    var decay = CFG.SHRINK.career_decay;
    if (zRaw != null) { careerParts.push({ season: ps.season, z: zRaw, n: vol, w: 1 }); careerN += vol; }
    /* THE CAREER INDEX IS FILTERED HERE, ONCE, AND EVERYTHING DOWNSTREAM READS
       THE FILTERED LIST. A season at or after this one is the future: it may
       not touch the rating, the experience count, the completeness or the
       confidence. Filtering it at each use site is how a leak gets in. */
    var prior = [];
    var supplied = ctx.career || [];
    for (i = 0; i < supplied.length; i++) if (supplied[i].season < ps.season) prior.push(supplied[i]);
    for (i = 0; i < prior.length; i++) {
      var age = (ps.season - prior[i].season);
      if (!(age > 0)) continue;
      var w = Math.pow(decay, age);
      if (prior[i].z == null || !(prior[i].n > 0)) continue;
      careerParts.push({ season: prior[i].season, z: prior[i].z, n: prior[i].n, w: w });
      careerN += prior[i].n * w;
    }
    if (careerParts.length) {
      var cw = 0, cz = 0;
      for (i = 0; i < careerParts.length; i++) {
        var ww = careerParts[i].w * careerParts[i].n;
        cz += careerParts[i].z * ww; cw += ww;
      }
      careerZ = cw > 0 ? cz / cw : null;
    }

    /* the prior the shrinkage pulls toward */
    var priorZ = 0, priorSource = 'positional replacement (z = 0)';
    var rec = ps.recruiting;
    if (rec && isNum(num(rec.z))) { priorZ = num(rec.z); priorSource = 'recruiting prior from ' + (rec.source || 'unknown source'); }

    var wSelf = careerN > 0 ? careerN / (careerN + K.k) : 0;
    var zHat = careerZ == null ? priorZ : (careerZ * wSelf + priorZ * (1 - wSelf));

    /* --- ROLE (participation v2) ---
       v1 could only see TOUCH share, which meant every offensive lineman and
       most defenders came out UNKNOWN: the layer genuinely did not know who
       played. The box score records an APPEARANCE per player per game, which
       is direct participation evidence for every position, including the ones
       with no touches at all.

       An appearance is still NOT a snap: four snaps and seventy both count
       once. So appearances answer WHO PLAYS and touch share answers HOW MUCH,
       and the two are combined rather than one being dressed up as the other.
       Where this season has produced nothing yet, LAST season's usage is
       carried forward and said to be carried forward. */
    var st = ps.stat || {};
    var P = CFG.PARTICIPATION || null;
    var touchShare = null, appearShare = null, share = null, shareBasis = null, shareParts = [];
    if (isNum(num(st.team_group_volume)) && num(st.team_group_volume) > 0 && vol > 0) {
      touchShare = vol / num(st.team_group_volume);
    }
    var teamGames = num(st.team_games) != null ? num(st.team_games) : num(st.team_def_games);
    if (P && isNum(num(st.box_games)) && isNum(teamGames) && teamGames >= P.min_team_games) {
      appearShare = clamp(num(st.box_games) / teamGames, 0, 1);
    }
    if (P && (touchShare != null || appearShare != null)) {
      var wA = appearShare != null ? P.appearance_weight : 0;
      var wT = touchShare != null ? P.touch_weight : 0;
      share = ((appearShare || 0) * wA + (touchShare || 0) * wT) / (wA + wT);
      if (appearShare != null) shareParts.push({ id: 'appearances', value: Math.round(appearShare * 1000) / 1000,
        w: wA / (wA + wT), basis: 'games this player appeared in the box score for, over his team’s games. Direct participation evidence — NOT a snap count.' });
      if (touchShare != null) shareParts.push({ id: 'touch_share', value: Math.round(touchShare * 1000) / 1000,
        w: wT / (wA + wT), basis: 'his share of the position group’s attributed volume this season' });
      shareBasis = 'expected participation share: ' + shareParts.map(function (x) { return x.id; }).join(' + ')
        + '. ' + P.basis;
    } else if (touchShare != null) {
      share = touchShare;
      shareBasis = 'share of his position group’s attributed volume THIS season. This is TOUCH share, not SNAP share; no public feed carries snap counts.';
    } else if (ps.prior_role && isNum(num(ps.prior_role.share))) {
      share = num(ps.prior_role.share);
      shareBasis = 'carried forward from ' + ps.prior_role.season + ', because this season has not produced enough attributed volume for this group yet. Previous usage, stated as previous usage.';
    }
    var role = roleBand(share, appearShare != null);
    var rolePts = 0;
    if (CFG.EPIR_COMPONENTS.role_value.applied && share != null) {
      /* linear in share above the rotation floor, capped. Weak evidence,
         treated as weak evidence. */
      rolePts = clamp((share - 0.15) / 0.45, 0, 1) * CFG.EPIR_COMPONENTS.role_value.max_points;
    }

    /* --- experience, from seasons OBSERVED IN THIS FEED, never the roster
       feed's class column (which carries a player's eventual class and would
       leak the future — established in cfb_p4/README.md). --- */
    var seasonsObserved = 1 + prior.length;
    var expPts = 0;
    if (CFG.EPIR_COMPONENTS.experience_value.applied) {
      expPts = clamp((seasonsObserved - 1) / 3, 0, 1) * CFG.EPIR_COMPONENTS.experience_value.max_points;
      if (vol <= 0 && seasonsObserved <= 1) expPts = 0;
    }

    var S = CFG.EPIR_SCALE;
    var epir = clamp(S.center + S.sd * zHat + rolePts + expPts, S.floor, S.ceiling);

    /* ---------------- confidence ---------------- */
    var C = CFG.CONFIDENCE;
    var idTier = ps.identity || identity.tier(ps);
    var idScore = C.identity[idTier] != null ? C.identity[idTier] : 0;
    var completeness = contract.length ? used.length / contract.length : 0;
    /* Completeness is about the PLAYER's evidence, not about this calendar
       season. In week one nobody has this season's measures, and treating a
       four-year starter as a blank would be as wrong as treating a true
       freshman as known. The most recent season in which his contract WAS
       populated carries, decayed by how long ago it was, and the record says
       which season it came from. */
    var completenessFrom = ps.season, priorDc = 0;
    for (i = 0; i < prior.length; i++) {
      if (prior[i].dc == null) continue;
      var dcW = prior[i].dc * Math.pow(0.8, Math.max(0, ps.season - prior[i].season));
      if (dcW > priorDc) { priorDc = dcW; completenessFrom = prior[i].season; }
    }
    if (priorDc > completeness) completeness = priorDc; else completenessFrom = ps.season;
    var sampleScore = wSelf;
    var newest = ps.season;
    var recency = ctx.season != null ? Math.pow(C.recency_decay, Math.max(0, ctx.season - newest)) : 1;
    var conf = idScore * C.weights.identity + sampleScore * C.weights.sample
      + completeness * C.weights.completeness + recency * C.weights.recency;
    if (ps.status === 'transfer' || ps.mid_season_move) conf *= C.transfer_penalty;
    if (!contract.length) conf = Math.min(conf, C.blind_role_cap);
    if (role === 'UNKNOWN') conf = Math.min(conf, C.unknown_role_cap);
    if (!K.measured) conf *= 0.9;
    conf = clamp(conf, 0, 1);

    /* every declared gap, in the player's own words */
    var unmeasured = [];
    if (!contract.length && CFG.NO_PRODUCTION_FEED[g]) unmeasured.push(CFG.NO_PRODUCTION_FEED[g]);
    if (!rec || !isNum(num(rec.z))) unmeasured.push(CFG.OBSERVABILITY.recruiting_rating.reason);
    unmeasured.push(CFG.OBSERVABILITY.snap_share.reason);
    if (g === 'OL') unmeasured.push(CFG.OBSERVABILITY.ol_individual.reason);
    if (CFG.DEFENSE_GROUPS.indexOf(g) >= 0) unmeasured.push(CFG.OBSERVABILITY.tackles.reason);
    if (g === 'CB' || g === 'S' || g === 'DB') unmeasured.push(CFG.OBSERVABILITY.coverage_targets.reason);

    return {
      schema: SCHEMA, rating_version: VERSION,
      variant: ctx.variant || 'v1', config_version: CFG.versions.player_rating,
      key: identity.key(ps), athlete_id: ps.athlete_id == null ? null : String(ps.athlete_id),
      name: ps.name, team: ps.team, team_key: ps.team_key || teamKey(ps.team),
      conference: ps.conference || null,
      pos: ps.pos, group: g, season: ps.season, pos_source: ps.pos_source || null,
      class_year: ps.class_year || null,
      height_in: num(ps.height_in), weight_lb: num(ps.weight_lb),
      prior_school: ps.prior_school || null, status: ps.status || 'unknown',
      mid_season_move: !!ps.mid_season_move,
      teams_this_season: ps.teams_this_season || null,

      epir: Math.round(epir * 10) / 10,
      confidence: Math.round(conf * 1000) / 1000,
      sample_size: Math.round(vol),
      career_sample: Math.round(careerN),
      data_completeness: Math.round(completeness * 1000) / 1000,
      data_completeness_from_season: completenessFrom,
      seasons_observed: seasonsObserved,
      games: num(ps.games),

      role: { expected_role: role, share: share == null ? null : Math.round(share * 1000) / 1000,
        participation_share: appearShare == null ? null : Math.round(appearShare * 1000) / 1000,
        touch_share: touchShare == null ? null : Math.round(touchShare * 1000) / 1000,
        parts: shareParts,
        from_participation: appearShare != null,
        carried_forward: !!(shareBasis && ps.prior_role && share != null && touchShare == null && appearShare == null),
        confidence: appearShare != null ? 0.8 : (touchShare != null ? 0.55 : 0.15),
        confidence_basis: appearShare != null
          ? 'direct box-score appearances plus touch share'
          : (touchShare != null ? 'touch share only — no box-score appearances for this player' : 'nothing observed'),
        basis: shareBasis || 'no attributed volume and no box-score appearance for this player in any season this build read, so his role is UNKNOWN — which is not the same as DEPTH, and is not the same as being bad' },

      components: {
        quality: { z_raw: zRaw, z_career: careerZ, z_shrunk: zHat, prior_z: priorZ, prior_source: priorSource,
          shrink_weight: Math.round(wSelf * 1000) / 1000, k: K.k, k_measured: K.measured,
          k_reliability_r: K.r, k_pairs: K.pairs, k_basis: K.basis,
          points: Math.round((S.sd * zHat) * 10) / 10, applied: true },
        role_value: { points: Math.round(rolePts * 10) / 10, applied: CFG.EPIR_COMPONENTS.role_value.applied,
          basis: CFG.EPIR_COMPONENTS.role_value.basis },
        experience_value: { points: Math.round(expPts * 10) / 10, applied: CFG.EPIR_COMPONENTS.experience_value.applied,
          seasons_observed: seasonsObserved, basis: CFG.EPIR_COMPONENTS.experience_value.basis },
        recruiting_prior: { points: 0, applied: false, value: rec || null,
          basis: CFG.EPIR_COMPONENTS.recruiting_prior.basis },
        availability_adjustment: { points: 0, applied: false, basis: CFG.EPIR_COMPONENTS.availability_adjustment.basis },
        scheme_fit_adjustment: { points: 0, applied: false, basis: CFG.EPIR_COMPONENTS.scheme_fit_adjustment.basis },
        transfer_adjustment: { points: 0, applied: false, basis: CFG.EPIR_COMPONENTS.transfer_adjustment.basis }
      },
      measures_used: used,
      measures_missing: missing,
      opponent_adjustment: { measures_adjusted: oppAdjusted, measures_total: oppTotal,
        available: oppTotal > 0 && oppAdjusted > 0,
        basis: 'each rate is moved by how much better or worse than FBS average the defences he actually faced were at allowing it' },
      identity_tier: idTier,
      unmeasured: unmeasured,
      sources: ps.sources || null,
      as_of: ctx.as_of || null
    };
  }

  /* Rate a whole season's population. `careerIndex` maps player key -> array
     of {season, z, n} from EARLIER seasons only; the caller builds it by
     walking seasons forward, which is what keeps a rating leak-free. */
  function rateSeason(seasonPlayers, ctx) {
    ctx = ctx || {};
    var baselines = ctx.baselines || buildBaselines(seasonPlayers, ctx.coverage, ctx.variant);
    var out = [], i;
    for (i = 0; i < seasonPlayers.length; i++) {
      var p = seasonPlayers[i];
      var key = identity.key(p);
      var career = (ctx.careerIndex && key && ctx.careerIndex[key]) || [];
      out.push(ratePlayer(p, {
        baselines: baselines, params: ctx.params, leagueAllowed: ctx.leagueAllowed,
        coverage: ctx.coverage, season: ctx.season != null ? ctx.season : p.season,
        as_of: ctx.as_of, career: career, variant: ctx.variant
      }));
    }
    return { ratings: out, baselines: baselines };
  }

  /* Measured reliability: the season-to-season correlation of a group's own
     composite z. This is what turns k from a preference into a measurement.
     `pairs` is [{group, z1, z2, n1, n2}]. */
  function measureReliability(pairs, minPairs) {
    var byGroup = {}, i, p;
    for (i = 0; i < pairs.length; i++) {
      p = pairs[i];
      if (p.z1 == null || p.z2 == null) continue;
      (byGroup[p.group] = byGroup[p.group] || []).push(p);
    }
    var out = {};
    for (var g in byGroup) {
      if (!has(byGroup, g)) continue;
      var rows = byGroup[g];
      var a = [], b = [], ns = [];
      for (i = 0; i < rows.length; i++) { a.push(rows[i].z1); b.push(rows[i].z2); ns.push(rows[i].n2); }
      var r = pearson(a, b);
      var nbar = mean(ns);
      var k = (r != null && r > 0.02 && nbar != null) ? nbar * (1 - r) / r : null;
      out[g] = {
        r: r == null ? null : Math.round(r * 10000) / 10000,
        pairs: rows.length, n_bar: nbar == null ? null : Math.round(nbar * 10) / 10,
        k: k == null ? null : Math.round(k * 10) / 10,
        measured: !!(k != null && rows.length >= (minPairs || CFG.SHRINK.min_pairs_to_measure)),
        basis: 'Pearson correlation of the group composite between consecutive seasons for the same athlete id; k = n_bar (1 - r) / r'
      };
    }
    return out;
  }
  function pearson(a, b) {
    if (!a || a.length < 3) return null;
    var ma = mean(a), mb = mean(b), sa = 0, sb = 0, sab = 0, i;
    for (i = 0; i < a.length; i++) {
      var da = a[i] - ma, db = b[i] - mb;
      sa += da * da; sb += db * db; sab += da * db;
    }
    if (!(sa > 0) || !(sb > 0)) return null;
    return sab / Math.sqrt(sa * sb);
  }

  return {
    SCHEMA: SCHEMA, VERSION: VERSION,
    M: M, avail: avail, isNum: isNum, clamp: clamp, mean: mean, sd: sd, pearson: pearson,
    teamKey: teamKey, nameKey: nameKey,
    identity: identity,
    rates: rates, volume: volume, denom: denom,
    buildBaselines: buildBaselines,
    adjustForOpponent: adjustForOpponent,
    ratePlayer: ratePlayer, rateSeason: rateSeason,
    measureReliability: measureReliability,
    config: CFG
  };
});
