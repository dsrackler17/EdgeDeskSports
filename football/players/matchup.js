/* ============================================================================
   THE MATCHUP ENGINE — why, not just who.

   "Team A 84, Team B 78" is a conclusion with the football removed. This module
   puts it back: which unit beats which, by how much, on what evidence, and how
   the two teams' measured tendencies make that edge matter more or less.

   FOUR RULES IT KEEPS

   1  A UNIT EDGE IS NOT A SPREAD. Everything here is denominated in MATCHUP
      POINTS on the 0-100 unit scale. Turning matchup points into points of
      spread happens in exactly one place — the calibrated scalar in params.js,
      which ships with its own walk-forward record and a `points_applied` flag
      that is allowed to be false. Nothing else in this file may convert.

   2  IT NEVER ASSIGNS A DEFENDER IT CANNOT SEE. College defences travel their
      corners, or they don't, and no public feed says which. Every player-level
      matchup is labelled DIRECT, LIKELY or UNIT-LEVEL, and almost all of them
      are UNIT-LEVEL, because that is the truth.

   3  A STYLE MULTIPLIER APPLIES ONLY WHEN BOTH SIDES ARE MEASURED. A run-heavy
      offence meeting a weak run defence is a real amplifier; a run-heavy
      offence meeting a defence whose run record is unknown is not, and the
      multiplier is simply not applied rather than half-applied.

   4  THE RUN DEFENCE GATE MAY SAY "UNKNOWN". It publishes a state only when
      enough of its component contract arrived. A gate that always answers is
      a gate that is sometimes lying.

   Runs in the browser (window.EDPlayerMatchup) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDPlayerConfig;
  var epir = req ? require('./epir.js') : root.EDPlayerRating;
  var api = factory(cfg, epir);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerMatchup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, EPIR) {
  'use strict';

  var SCHEMA = 'edgedesk_matchup_v1';
  var isNum = EPIR.isNum, clamp = EPIR.clamp, mean = EPIR.mean;
  function num(v) { if (v == null || v === '') return null; var n = +v; return isFinite(n) ? n : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /* group rating + confidence out of a unit summary (current.json shape) or a
     full unit record (teams/<key>.json shape). One reader for both. */
  function grp(units, g) {
    if (!units || !units.groups || !units.groups[g]) return null;
    var x = units.groups[g];
    var r = num(x.r != null ? x.r : x.rating);
    if (r == null) return null;
    return { rating: r, confidence: num(x.c != null ? x.c : x.confidence) || 0,
      starter: num(x.sq != null ? x.sq : x.starter_quality),
      depth: num(x.dq != null ? x.dq : x.depth_quality),
      continuity: num(x.ct != null ? x.ct : x.continuity),
      out: num(x.out) || 0, unknown: num(x.unk != null ? x.unk : (x.availability && x.availability.unknown_share)),
      production_feed: (x.pf != null ? !!x.pf : !!x.production_feed) };
  }
  function side(units, list) {
    var s = 0, w = 0, c = 0, n = 0, missing = [];
    for (var i = 0; i < list.length; i++) {
      var g = grp(units, list[i]);
      var pv = CFG.POSITION_VALUE[list[i]] || 0.2;
      if (!g) { missing.push(list[i]); continue; }
      s += g.rating * pv; w += pv; c += g.confidence * pv; n++;
    }
    if (!(w > 0)) return null;
    return { rating: s / w, confidence: c / w, groups: n, missing: missing };
  }

  function bandLabel(mag) {
    var b = CFG.SCHEME.magnitude_bands, i;
    for (i = 0; i < b.length; i++) if (mag >= b[i].min) return b[i].label;
    return 'MARGINAL';
  }

  /* ---------------------------------------------------------------------
     1. THE MATCHUP MATRIX — one row per position group.
     --------------------------------------------------------------------- */
  function matrix(home, away, names) {
    var rows = [], order = CFG.GROUP_ORDER, i;
    for (i = 0; i < order.length; i++) {
      var g = order[i];
      if (g === 'LS' || g === 'RET' || g === 'ATH') continue;
      var h = grp(home, g), a = grp(away, g);
      if (!h && !a) continue;
      var diff = (h && a) ? h.rating - a.rating : null;
      rows.push({
        group: g,
        home: h ? Math.round(h.rating * 10) / 10 : null,
        away: a ? Math.round(a.rating * 10) / 10 : null,
        home_confidence: h ? Math.round(h.confidence * 100) / 100 : 0,
        away_confidence: a ? Math.round(a.confidence * 100) / 100 : 0,
        edge: diff == null ? null : (Math.abs(diff) < 1.5 ? 'EVEN' : (diff > 0 ? 'HOME' : 'AWAY')),
        edge_team: diff == null ? null : (Math.abs(diff) < 1.5 ? null : (diff > 0 ? names.home : names.away)),
        margin: diff == null ? null : Math.round(Math.abs(diff) * 10) / 10,
        confidence: (h && a) ? Math.round(Math.min(h.confidence, a.confidence) * 100) / 100 : 0,
        production_feed: !!(h && h.production_feed) && !!(a && a.production_feed),
        reason: diff == null ? ((!h ? names.home : names.away) + ' has no rating for ' + g + ' — the row is blank rather than zero') : null
      });
    }
    return rows;
  }

  /* ---------------------------------------------------------------------
     2. SCHEME EDGES — unit-vs-unit, amplified by measured tendency.
     --------------------------------------------------------------------- */
  function tz(profile, phase, key) {
    if (!profile || !profile[phase] || !profile[phase][key]) return null;
    var x = profile[phase][key];
    var z = (x.z != null) ? x.z : (x.value != null && x.league_mean != null ? null : null);
    return isNum(num(z)) ? num(z) : null;
  }

  function schemeEdges(H, A, names) {
    var out = [], pairs = CFG.SCHEME.pairs, i;
    for (i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      /* home offence vs away defence, then away offence vs home defence */
      out.push(onePair(p, H, A, names.home, names.away, 'home'));
      out.push(onePair(p, A, H, names.away, names.home, 'away'));
    }
    /* order by how big the edge is, not by its sign, and keep the matchups
       that could not be evaluated at the bottom where they belong */
    return out.filter(Boolean).sort(function (a, b) {
      var ka = a.available ? Math.abs(a.magnitude) : -1, kb = b.available ? Math.abs(b.magnitude) : -1;
      return kb - ka;
    });
  }

  function onePair(pair, off, def, offName, defName, offSide) {
    var o = side(off.units, pair.off), d = side(def.units, pair.def);
    if (!o || !d) {
      return { id: pair.id + ':' + offSide, label: pair.label, offense: offName, defense: defName,
        available: false, magnitude: 0, confidence: 0,
        reason: (!o ? offName + ' has no rating for ' + pair.off.join('/') : defName + ' has no rating for ' + pair.def.join('/'))
          + ' — this matchup is not evaluated rather than assumed even' };
    }
    var base = (o.rating - d.rating) * pair.w;
    var mult = 1, applied = [], skipped = [];
    var S = CFG.SCHEME.style;

    function amp(id, offZ, defZ, max, invertDef) {
      if (offZ == null || defZ == null) {
        skipped.push({ id: id, why: 'needs both sides measured; ' + (offZ == null ? 'the offence' : 'the defence') + ' tendency is not observed' });
        return;
      }
      var dz = invertDef ? -defZ : defZ;
      var k = clamp((offZ * dz) / 4, -1, 1) * max;
      mult += k;
      applied.push({ id: id, points: Math.round(k * 1000) / 1000, offense_z: offZ, defense_z: dz, basis: S[id].basis });
    }

    if (pair.id === 'run_off_vs_run_def') {
      amp('run_heavy_vs_weak_run_def', tz(off.scheme, 'offense', 'rush_rate'),
        tz(def.scheme, 'defense', 'def_rush_success_allowed'), S.run_heavy_vs_weak_run_def.max, false);
    } else if (pair.id === 'pass_pro_vs_rush' || pair.id === 'qb_vs_pressure') {
      amp('pass_heavy_vs_weak_rush', neg(tz(off.scheme, 'offense', 'rush_rate')),
        tz(def.scheme, 'defense', 'def_sack_rate'), S.pass_heavy_vs_weak_rush.max, false);
    } else if (pair.id === 'explosive_vs_deep' || pair.id === 'receivers_vs_cover') {
      amp('vertical_vs_explosive_allowed', tz(off.scheme, 'offense', 'explosive_pass_rate'),
        tz(def.scheme, 'defense', 'def_explosive_pass_allowed'), S.vertical_vs_explosive_allowed.max, false);
    }
    /* pace amplifies every structural edge equally: more plays, more chances */
    var paceZ = tz(off.scheme, 'offense', 'plays_per_game');
    if (paceZ != null) {
      var pk = clamp(paceZ / 2, -1, 1) * S.pace_amplifier.max;
      mult += pk;
      applied.push({ id: 'pace_amplifier', points: Math.round(pk * 1000) / 1000, offense_z: paceZ, basis: S.pace_amplifier.basis });
    } else skipped.push({ id: 'pace_amplifier', why: 'this offence’s pace is not observed' });

    var magnitude = base * mult;
    return {
      id: pair.id + ':' + offSide, label: pair.label, offense: offName, defense: defName, side: offSide,
      available: true,
      unit_gap: Math.round(base * 10) / 10,
      style_multiplier: Math.round(mult * 1000) / 1000,
      magnitude: Math.round(magnitude * 10) / 10,
      favours: magnitude > 0 ? offName : defName,
      band: bandLabel(Math.abs(magnitude)),
      confidence: Math.round(Math.min(o.confidence, d.confidence) * 100) / 100,
      offense_rating: Math.round(o.rating * 10) / 10, defense_rating: Math.round(d.rating * 10) / 10,
      offense_groups: pair.off, defense_groups: pair.def,
      style_applied: applied, style_skipped: skipped,
      units_note: 'MATCHUP POINTS on the 0-100 unit scale. This is not a spread and nothing here converts it to one.'
    };
  }
  function neg(z) { return z == null ? null : -z; }

  /* ---------------------------------------------------------------------
     3. RUN DEFENCE GATE
     --------------------------------------------------------------------- */
  function runDefenceGate(defTeam, offTeam, names, which) {
    var C = CFG.RUN_GATE.components;
    var parts = [], wsum = 0, ssum = 0, missing = [];
    function push(id, value01, note) {
      if (value01 == null) { missing.push({ id: id, why: note || (id + ' is not observable for this team') }); return; }
      var w = C[id].w;
      parts.push({ id: id, value: Math.round(value01 * 1000) / 1000, weight: w, basis: C[id].basis });
      ssum += value01 * w; wsum += w;
    }
    function fromRating(r) { return r == null ? null : clamp((r - 20) / 60, 0, 1); }
    function fromZ(z, invert) { return z == null ? null : clamp(0.5 + (invert ? -z : z) / 4, 0, 1); }

    var dl = grp(defTeam.units, 'DL'), lb = grp(defTeam.units, 'LB');
    push('dl_unit', fromRating(dl && dl.rating));
    push('lb_unit', fromRating(lb && lb.rating));

    var ret = defTeam.units && defTeam.units.returning;
    var frontRet = null;
    if (ret && ret.by_group) {
      var vals = [], gs = ['DL', 'EDGE', 'LB'], i;
      for (i = 0; i < gs.length; i++) {
        var b = ret.by_group[gs[i]];
        if (b && b.value_returning != null) vals.push(b.value_returning);
      }
      if (vals.length) frontRet = mean(vals);
    }
    push('returning_front_value', frontRet, 'no prior-season player ratings for this front, so returning VALUE cannot be computed');

    push('rush_success_allowed', fromZ(tz(defTeam.scheme, 'defense', 'def_rush_success_allowed'), true));
    push('stuff_rate', fromZ(tz(defTeam.scheme, 'defense', 'def_stuff_rate'), false));
    push('explosive_rush_allowed', fromZ(tz(defTeam.scheme, 'defense', 'def_explosive_rush_allowed'), true));

    var totalW = 0, k;
    for (k in C) if (has(C, k)) totalW += C[k].w;
    var completeness = totalW > 0 ? wsum / totalW : 0;
    if (completeness < CFG.RUN_GATE.min_completeness) {
      return { schema: SCHEMA, version: CFG.versions.run_gate, team: names[which], side: which,
        state: CFG.RUN_GATE.unknown_state, score: null, available: false,
        completeness: Math.round(completeness * 100) / 100, components: parts, missing: missing,
        reason: 'only ' + Math.round(completeness * 100) + '% of the gate’s own component contract arrived, below the '
          + Math.round(CFG.RUN_GATE.min_completeness * 100) + '% it needs. ' + CFG.RUN_GATE.unknown_basis };
    }
    var base = (ssum / wsum) * 100;

    /* the opponent's rushing threat moves the gate: a stable front against a
       bad run game is not the same football problem as the same front against
       a good one. */
    var offRun = side(offTeam.units, ['OL', 'RB']);
    var oppSwing = 0, oppNote = null;
    if (offRun) {
      var qb = grp(offTeam.units, 'QB');
      var qbRush = tz(offTeam.scheme, 'offense', 'rush_rate');
      var threat = (offRun.rating - 50) / 25;                 /* SDs of opponent run quality */
      if (qbRush != null && qb) threat += clamp(qbRush, -2, 2) * 0.25;
      oppSwing = -clamp(threat, -2, 2) / 2 * CFG.RUN_GATE.opponent_swing;
      oppNote = 'the opponent’s own run game (OL + RB rating ' + Math.round(offRun.rating * 10) / 10
        + (qbRush != null ? ', rush-rate z ' + qbRush : '') + ') moves the gate by ' + (Math.round(oppSwing * 10) / 10) + ' points';
    }
    var score = clamp(base + oppSwing, 0, 100);
    var bands = CFG.RUN_GATE.bands, state = 'UNKNOWN';
    for (var b = 0; b < bands.length; b++) if (score >= bands[b].min) { state = bands[b].state; break; }
    return {
      schema: SCHEMA, version: CFG.versions.run_gate, team: names[which], side: which,
      state: state, score: Math.round(score * 10) / 10, base_score: Math.round(base * 10) / 10,
      opponent_swing: Math.round(oppSwing * 10) / 10, opponent_note: oppNote,
      available: true, completeness: Math.round(completeness * 100) / 100,
      components: parts, missing: missing,
      basis: 'a 0-100 stability score over the components that arrived, renormalised over their weights, then moved by the opponent’s measured rushing threat. It is a research state, not a spread adjustment.'
    };
  }

  /* ---------------------------------------------------------------------
     4. PLAYER-LEVEL EDGES
     The feed cannot tell you which corner travels or which end aligns wide,
     so this deliberately publishes very few DIRECT matchups.
     --------------------------------------------------------------------- */
  function playerEdges(H, A, names, limit) {
    var out = [];
    function pull(team, g) {
      var u = team.units && team.units.groups && team.units.groups[g];
      var list = (u && (u.projected || u.players)) || [];
      return list;
    }
    function best(team, g, n) { return pull(team, g).slice(0, n || 1); }

    /* pass rush vs tackles: UNIT-LEVEL, because no feed says which end rushes
       which side, and college fronts move. */
    [['home', H, A], ['away', A, H]].forEach(function (row) {
      var which = row[0], off = row[2], def = row[1];
      var rushers = best(def, 'EDGE', 2).concat(best(def, 'DL', 1));
      var line = best(off, 'OL', 5);
      if (rushers.length && line.length) {
        var rMean = mean(rushers.map(function (p) { return p.epir; }));
        var lMean = mean(line.map(function (p) { return p.epir; }));
        out.push({
          id: 'rush_vs_line:' + which,
          label: (which === 'home' ? names.home : names.away) + ' pass rush vs ' + (which === 'home' ? names.away : names.home) + ' offensive line',
          classification: 'UNIT-LEVEL',
          classification_why: 'no public feed says which rusher aligns against which lineman, and college fronts move. Naming a one-on-one here would be invented.',
          attackers: rushers.map(short), defenders: line.map(short),
          magnitude: Math.round((rMean - lMean) * 10) / 10,
          favours: rMean > lMean ? (which === 'home' ? names.home : names.away) : (which === 'home' ? names.away : names.home),
          confidence: Math.round(Math.min(meanConf(rushers), meanConf(line)) * 100) / 100
        });
      }
      var wrs = best(off, 'WR', 3);
      var cbs = best(def, 'CB', 3).concat(best(def, 'S', 1));
      if (wrs.length && cbs.length) {
        var wMean = mean(wrs.map(function (p) { return p.epir; })), cMean = mean(cbs.map(function (p) { return p.epir; }));
        out.push({
          id: 'wr_vs_secondary:' + which,
          label: (which === 'home' ? names.home : names.away) + ' receivers vs ' + (which === 'home' ? names.away : names.home) + ' secondary',
          classification: 'LIKELY',
          classification_why: 'the receivers are the ones the ball actually went to, which the feed does observe. Which defender covered them is not observed, so the defence is read as a unit.',
          attackers: wrs.map(short), defenders: cbs.map(short),
          magnitude: Math.round((wMean - cMean) * 10) / 10,
          favours: wMean > cMean ? (which === 'home' ? names.home : names.away) : (which === 'home' ? names.away : names.home),
          confidence: Math.round(Math.min(meanConf(wrs), meanConf(cbs)) * 100) / 100
        });
      }
      var qb = best(off, 'QB', 1), front = best(def, 'EDGE', 2).concat(best(def, 'DL', 2));
      if (qb.length && front.length) {
        out.push({
          id: 'qb_vs_front:' + which,
          label: (which === 'home' ? names.away : names.home) + ' quarterback vs ' + (which === 'home' ? names.home : names.away) + ' front',
          classification: 'DIRECT',
          classification_why: 'the quarterback is named by the feed on every dropback and the sack is attributed to a named rusher, so both ends of this matchup are observed events rather than assumed alignments.',
          attackers: front.map(short), defenders: qb.map(short),
          magnitude: Math.round((mean(front.map(function (p) { return p.epir; })) - qb[0].epir) * 10) / 10,
          favours: mean(front.map(function (p) { return p.epir; })) > qb[0].epir
            ? (which === 'home' ? names.home : names.away) : (which === 'home' ? names.away : names.home),
          confidence: Math.round(Math.min(meanConf(front), meanConf(qb)) * 100) / 100
        });
      }
      var rb = best(off, 'RB', 1), box = best(def, 'DL', 2).concat(best(def, 'LB', 2));
      if (rb.length && box.length) {
        out.push({
          id: 'rb_vs_box:' + which,
          label: (which === 'home' ? names.away : names.home) + ' run game vs ' + (which === 'home' ? names.home : names.away) + ' interior defence',
          classification: 'UNIT-LEVEL',
          classification_why: 'a carry is attributed to a runner, but no defender is attributed to stopping it — the feed carries no tackle column at all.',
          attackers: box.map(short), defenders: rb.map(short),
          magnitude: Math.round((mean(box.map(function (p) { return p.epir; })) - rb[0].epir) * 10) / 10,
          favours: mean(box.map(function (p) { return p.epir; })) > rb[0].epir
            ? (which === 'home' ? names.home : names.away) : (which === 'home' ? names.away : names.home),
          confidence: Math.round(Math.min(meanConf(box), meanConf(rb)) * 100) / 100
        });
      }
    });
    out.sort(function (a, b) { return Math.abs(b.magnitude) * b.confidence - Math.abs(a.magnitude) * a.confidence; });
    return limit ? out.slice(0, limit) : out;
  }
  function short(p) { return { name: p.name, pos: p.pos, epir: p.epir, confidence: p.confidence, role: p.role, availability: p.availability }; }
  function meanConf(list) { var v = list.map(function (p) { return p.confidence || 0; }); return v.length ? mean(v) : 0; }

  /* ---------------------------------------------------------------------
     5. RISK GATES
     --------------------------------------------------------------------- */
  function riskGates(H, A, names, ctx) {
    ctx = ctx || {};
    var T = CFG.RISK_THRESHOLDS, out = [];
    function fire(id, side, detail) {
      var def = null, i;
      for (i = 0; i < CFG.RISK_GATES.length; i++) if (CFG.RISK_GATES[i].id === id) def = CFG.RISK_GATES[i];
      out.push({ id: id, label: def ? def.label : id, severity: def ? def.severity : 'medium',
        side: side, team: side === 'home' ? names.home : (side === 'away' ? names.away : null), detail: detail });
    }
    [['home', H, ctx.runGateHome], ['away', A, ctx.runGateAway]].forEach(function (row) {
      var which = row[0], t = row[1], gate = row[2];
      if (gate && gate.available && T.run_gate_states.indexOf(gate.state) >= 0) {
        fire('RUN_DEFENCE_FRAGILITY', which, gate.state + ' (' + gate.score + '/100) — ' + (gate.opponent_note || 'own front only'));
      }
      var qb = grp(t.units, 'QB');
      if (!qb) fire('NEW_QB', which, 'no quarterback rating at all — the room produced no rateable player');
      else if (qb.confidence < T.new_qb_confidence) fire('NEW_QB', which, 'quarterback confidence ' + Math.round(qb.confidence * 100) + '%, below the ' + Math.round(T.new_qb_confidence * 100) + '% floor');
      var ol = grp(t.units, 'OL');
      if (ol && ol.depth != null && ol.depth < T.depth_quality_floor) fire('LOW_DEPTH', which, 'offensive-line depth quality ' + ol.depth);
      if (ol && ol.unknown != null && ol.unknown >= T.availability_unknown_share) {
        fire('INJURY_UNCERTAINTY', which, Math.round(ol.unknown * 100) + '% of the projected line has no availability record — UNKNOWN, not healthy');
      }
      var tv = t.units && t.units.transfers;
      var ret = t.units && t.units.returning;
      if (ret && ret.value_continuity != null && (1 - ret.value_continuity) > T.transfer_turnover_share) {
        fire('EXTREME_TRANSFER_TURNOVER', which, Math.round((1 - ret.value_continuity) * 100) + '% of last season’s production value is gone (roster continuity ' + Math.round((ret.roster_continuity || 0) * 100) + '%, which is a different number on purpose)');
      }
      var sec = tz(t.scheme, 'defense', 'def_explosive_pass_allowed');
      if (sec != null && sec >= T.secondary_explosive_z) fire('SECONDARY_EXPLOSIVE_RISK', which, 'explosive passes allowed sit ' + sec.toFixed(2) + ' SD above FBS average');
      var conf = t.units && t.units.overall && (t.units.overall.c != null ? t.units.overall.c : t.units.overall.confidence);
      if (conf != null && conf < T.player_confidence_floor) fire('LOW_PLAYER_DATA_CONFIDENCE', which, 'roster-wide player-data confidence ' + Math.round(conf * 100) + '%');
    });
    var olEdge = ctx.olMismatch;
    if (olEdge != null && Math.abs(olEdge) >= T.ol_mismatch_points) {
      fire('OL_MISMATCH', olEdge > 0 ? 'away' : 'home', 'the line/front gap is ' + Math.abs(Math.round(olEdge * 10) / 10) + ' matchup points');
    }
    if (ctx.modelMarketGap != null && Math.abs(ctx.modelMarketGap) >= T.model_market_points) {
      fire('MODEL_MARKET_EXTREME_DISAGREEMENT', null, 'the model and the market are ' + Math.abs(Math.round(ctx.modelMarketGap * 10) / 10) + ' points apart, which is more often a data fault than an edge');
    }
    /* things nobody publishes: named, so their absence is not read as calm */
    out.push({ id: 'SCHEME_CHANGE', label: 'Scheme change', severity: 'low', side: null,
      detail: 'not observable: no public feed records a coordinator hire or a scheme change, so EdgeDesk cannot fire this gate and does not pretend to.' , unobservable: true });
    out.push({ id: 'COORDINATOR_CHANGE', label: 'Coordinator change', severity: 'low', side: null,
      detail: 'not observable in any public feed wired into this repo.', unobservable: true });
    return out;
  }

  /* ---------------------------------------------------------------------
     6. THE WHOLE MATCHUP
     H/A = { units, scheme, name }. Everything is optional and everything
     missing is declared.
     --------------------------------------------------------------------- */
  function evaluate(req) {
    var H = req.home || {}, A = req.away || {};
    var names = { home: H.name || 'home', away: A.name || 'away' };
    var mat = matrix(H.units, A.units, names);
    var edges = schemeEdges(H, A, names);
    var gateH = runDefenceGate(H, A, names, 'home');
    var gateA = runDefenceGate(A, H, names, 'away');
    var pe = playerEdges(H, A, names, 8);

    /* the two summary features the line ladder is allowed to read */
    var hAll = side(H.units, CFG.OFFENSE_GROUPS.concat(CFG.DEFENSE_GROUPS));
    var aAll = side(A.units, CFG.OFFENSE_GROUPS.concat(CFG.DEFENSE_GROUPS));
    var playerGap = (hAll && aAll) ? hAll.rating - aAll.rating : null;
    var schemeGap = null, sw = 0, ss = 0, i;
    for (i = 0; i < edges.length; i++) {
      if (!edges[i].available) continue;
      var sgn = edges[i].side === 'home' ? 1 : -1;
      var w = edges[i].confidence;
      ss += sgn * (edges[i].magnitude - edges[i].unit_gap) * w; sw += w;
    }
    if (sw > 0) schemeGap = ss / sw;

    var olH = null;
    for (i = 0; i < edges.length; i++) if (edges[i].id === 'pass_pro_vs_rush:away') olH = edges[i].magnitude;

    var risks = riskGates(H, A, names, {
      runGateHome: gateH, runGateAway: gateA, olMismatch: olH,
      modelMarketGap: req.model_market_gap == null ? null : req.model_market_gap
    });

    /* the single most important matchup: biggest magnitude x confidence */
    var top = null;
    for (i = 0; i < edges.length; i++) {
      if (!edges[i].available) continue;
      var sc = Math.abs(edges[i].magnitude) * Math.max(0.15, edges[i].confidence);
      if (!top || sc > top._score) { top = edges[i]; top._score = sc; }
    }

    return {
      schema: SCHEMA, version: CFG.versions.scheme_matchup,
      home: names.home, away: names.away,
      matrix: mat,
      scheme_edges: edges,
      run_defence_gate: { home: gateH, away: gateA },
      player_edges: pe,
      risk_gates: risks,
      most_important: top ? { id: top.id, label: top.label, favours: top.favours,
        magnitude: top.magnitude, band: top.band, confidence: top.confidence } : null,
      features: {
        player_quality_gap: playerGap == null ? null : Math.round(playerGap * 100) / 100,
        scheme_gap: schemeGap == null ? null : Math.round(schemeGap * 100) / 100,
        home_confidence: hAll ? Math.round(hAll.confidence * 100) / 100 : 0,
        away_confidence: aAll ? Math.round(aAll.confidence * 100) / 100 : 0,
        units_note: 'both gaps are in MATCHUP POINTS on the 0-100 unit scale. Converting them to points of spread happens only through the calibrated, walk-forward-tested scalars in params.js.'
      }
    };
  }

  return { SCHEMA: SCHEMA, evaluate: evaluate, matrix: matrix, schemeEdges: schemeEdges,
    runDefenceGate: runDefenceGate, playerEdges: playerEdges, riskGates: riskGates,
    grp: grp, side: side, bandLabel: bandLabel, config: CFG };
});
