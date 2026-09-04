/* ============================================================================
   TALENT — how much football ability is currently on this roster.

   THE QUESTION IT ANSWERS:  who is here, how good are they, and how much are
                             they going to play?
   THE QUESTION IT REFUSES:  how did they play last Saturday?

   That separation is the whole point of the file. A talent rating that falls
   nine points after a blowout is not a talent rating, it is a performance
   rating wearing the wrong label — and the two are published side by side
   precisely so a reader can see an elite roster that has not yet played like
   one, which is one of the most useful things in college football research.

   WHY IT MOVES SLOWLY, WITHOUT ANY SMOOTHING BEING APPLIED
   Talent is built from EPIR, and EPIR is career-shrunk toward the prior by a
   MEASURED constant k that runs into the hundreds for the positions that
   matter most (quarterback k = 532 over 252 observed season pairs). One
   Saturday is a few dozen plays against that; it moves a player rating by a
   fraction of a point and it cannot move a roster. So no extra week-to-week
   smoothing is imposed — that would be a second, invented brake on top of a
   measured one — and the observed week-over-week talent volatility is written
   into the dataset so the decision can be revisited with evidence.

   WHAT IS ALLOWED TO MOVE IT: availability, depth-chart change, transfer
   eligibility, and accumulated player evidence changing EPIR.
   WHAT IS NOT: a bad game, a turnover game, a blowout, a poll, the market.
   `rankings.test.js` holds both lists.

   Runs in the browser (window.EDRankTalent) and in node.
   ========================================================================== */
(function (root, factory) {
  var req = (typeof require === 'function' && typeof module === 'object' && module.exports);
  var cfg = req ? require('./config.js') : root.EDRankConfig;
  var pcfg = req ? require('../players/config.js') : root.EDPlayerConfig;
  var api = factory(cfg, pcfg);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankTalent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG, PCFG) {
  'use strict';

  var SCHEMA = 'edgedesk_team_talent_v1';
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

  /* The rankings' own unit vocabulary. The player layer spells a secondary as
     CB, S and DB depending on how each programme spells its own roster; the
     rankings publish ONE secondary number and say which spellings fed it. */
  var UNIT_MAP = {
    QB: ['QB'], RB: ['RB'], WR: ['WR', 'TE'], TE: ['TE'], OL: ['OL'],
    DL: ['DL'], EDGE: ['EDGE'], LB: ['LB'], SECONDARY: ['CB', 'S', 'DB'],
    K: ['K'], P: ['P']
  };
  var OFFENSE_UNITS = ['QB', 'RB', 'WR', 'TE', 'OL'];
  var DEFENSE_UNITS = ['DL', 'EDGE', 'LB', 'SECONDARY'];

  /* A UNIT A ROSTER DOES NOT SPELL IS NOT A MISSING UNIT.
     123 of 138 FBS programmes list their edge rushers as DL rather than EDGE.
     Treating that as absent data raises 123 false alarms a week and buries the
     real ones. Where a coarser spelling on the SAME roster already contains
     those players, the unit is COVERED: it has no separate rating, it is not
     reported as missing, and the record says which spelling absorbed it. */
  var COVERED_BY = { EDGE: 'DL', TE: 'WR' };

  /* Read one group off either shape the player layer publishes: the compact
     league summary in current.json, or the full record in teams/<key>.json. */
  function grp(units, g) {
    if (!units || !units.groups || !units.groups[g]) return null;
    var x = units.groups[g];
    var r = num(x.r != null ? x.r : x.rating);
    if (r == null) return null;
    return {
      rating: r,
      confidence: num(x.c != null ? x.c : x.confidence) || 0,
      starter: num(x.sq != null ? x.sq : x.starter_quality),
      depth: num(x.dq != null ? x.dq : x.depth_quality),
      continuity: num(x.ct != null ? x.ct : x.continuity),
      experience: num(x.ex != null ? x.ex : x.experience),
      roster_size: num(x.n != null ? x.n : x.roster_size) || 0,
      starters_out: num(x.out != null ? x.out : (x.availability && x.availability.starters_out)) || 0,
      unknown_share: num(x.unk != null ? x.unk : (x.availability && x.availability.unknown_share))
    };
  }

  /* One rankings unit out of the player layer's groups, position-value
     weighted where a unit maps to more than one spelling. */
  function unit(units, name) {
    var spellings = UNIT_MAP[name] || [name];
    var parts = [], i;
    for (i = 0; i < spellings.length; i++) {
      var g = grp(units, spellings[i]);
      if (!g) continue;
      parts.push({ spelling: spellings[i], g: g, pv: PCFG.POSITION_VALUE[spellings[i]] || 0.3 });
    }
    if (!parts.length) {
      return { available: false, rating: null, confidence: 0,
        reason: 'no player on this roster resolves to ' + spellings.join('/') + ', so this unit has no rating — which is not a rating of zero',
        spellings_found: [] };
    }
    function w(field) {
      var s = 0, ws = 0;
      for (var j = 0; j < parts.length; j++) {
        var v = parts[j].g[field];
        if (!isNum(v)) continue;
        s += v * parts[j].pv; ws += parts[j].pv;
      }
      return ws > 0 ? s / ws : null;
    }
    return {
      available: true,
      rating: r1(w('rating')), confidence: r3(w('confidence')),
      starter_quality: r1(w('starter')), depth_quality: r1(w('depth')),
      continuity: r3(w('continuity')), experience: r3(w('experience')),
      roster_size: parts.reduce(function (a, b) { return a + b.g.roster_size; }, 0),
      starters_out: parts.reduce(function (a, b) { return a + b.g.starters_out; }, 0),
      unknown_share: r3(w('unknown_share')),
      spellings_found: parts.map(function (p) { return p.spelling; })
    };
  }
  function r1(v) { return isNum(v) ? Math.round(v * 10) / 10 : null; }
  function r3(v) { return isNum(v) ? Math.round(v * 1000) / 1000 : null; }

  /* Position-value weighted roll-up across a set of rankings units. */
  function roll(unitsOut, list, field) {
    var s = 0, w = 0, missing = [], covered = [], i;
    for (i = 0; i < list.length; i++) {
      var name = list[i], u = unitsOut[name];
      var pv = unitPositionValue(name);
      if (!u || !u.available || !isNum(u[field])) {
        var by = COVERED_BY[name];
        if (by && unitsOut[by] && unitsOut[by].available) covered.push({ unit: name, by: by });
        else if (pv >= 0.3) missing.push(name);
        continue;
      }
      s += u[field] * pv; w += pv;
    }
    return { value: w > 0 ? s / w : null, missing: missing, covered: covered };
  }
  function unitPositionValue(name) {
    var spellings = UNIT_MAP[name] || [name], s = 0, i;
    for (i = 0; i < spellings.length; i++) s += PCFG.POSITION_VALUE[spellings[i]] || 0.3;
    return s / spellings.length;
  }

  /* ---------------------------------------------------------------------
     THE LEAGUE PASS
     Some talent components (returning value, transfer value, availability) are
     shares or indices, not EPIR-scale numbers. They are standardised across
     the FBS population so every component means the same thing before they are
     weighted together — which is why this takes the whole league at once.
     --------------------------------------------------------------------- */
  function build(teamsUnits, opts) {
    opts = opts || {};
    var keys = Object.keys(teamsUnits), i, k;
    var per = {};

    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      var U = teamsUnits[k];
      var units = {}, uname;
      var names = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'EDGE', 'LB', 'SECONDARY', 'K', 'P'];
      for (var n = 0; n < names.length; n++) units[names[n]] = unit(U, names[n]);

      var all = OFFENSE_UNITS.concat(DEFENSE_UNITS);
      var starter = roll(units, all, 'starter_quality');
      /* the unit record says so on its own face too, so a reader who opens
         EDGE sees "your ends are inside DL" rather than a blank */
      for (var cv = 0; cv < starter.covered.length; cv++) {
        var cu = units[starter.covered[cv].unit];
        if (cu) { cu.covered_by = starter.covered[cv].by;
          cu.reason = 'this roster spells its ' + starter.covered[cv].unit + ' players as '
            + starter.covered[cv].by + ', which 123 of 138 FBS programmes do. They are rated inside that unit; nothing is missing.'; }
      }
      var rotation = roll(units, all, 'rating');
      var depth = roll(units, all, 'depth_quality');

      var ret = U.returning || null;
      var tx = U.transfers || null;

      /* availability: a share of PROJECTED STARTER position value that is
         known to be unavailable. UNKNOWN is carried as unknown, never as fit. */
      var outPv = 0, totPv = 0, unkPv = 0, records = 0;
      for (var a = 0; a < all.length; a++) {
        var uu = units[all[a]];
        if (!uu || !uu.available) continue;
        var pv = unitPositionValue(all[a]);
        totPv += pv;
        if (uu.starters_out > 0) outPv += pv * Math.min(1, uu.starters_out / 2);
        if (uu.unknown_share != null) { unkPv += pv * uu.unknown_share; if (uu.unknown_share < 1) records++; }
      }
      per[k] = {
        covered_units: [],
        units: units,
        starter_quality: starter.value, rotation_quality: rotation.value, depth_quality: depth.value,
        missing_units: starter.missing, covered_units: starter.covered,
        value_continuity: ret && ret.value_continuity != null ? ret.value_continuity : null,
        roster_continuity: ret && ret.roster_continuity != null ? ret.roster_continuity : null,
        returning_reason: (ret && ret.available === false) ? ret.reason : null,
        transfer_index: tx && tx.net_index != null ? tx.net_index : null,
        transfer_in: tx ? tx.in : null, transfer_out: tx ? tx.out : null,
        transfer_net_value: tx ? tx.net_value : null,
        transfer_starters_in: tx ? tx.starters_in : null, transfer_starters_out: tx ? tx.starters_out : null,
        availability_out_share: totPv > 0 ? outPv / totPv : null,
        availability_unknown_share: totPv > 0 ? unkPv / totPv : null,
        availability_records: records,
        offense_units: roll(units, OFFENSE_UNITS, 'rating').value,
        defense_units: roll(units, DEFENSE_UNITS, 'rating').value,
        confidence: roll(units, all, 'confidence').value
      };
    }

    /* standardise every component onto the same 0-100 EPIR scale */
    function zStats(field) {
      var vals = [];
      for (var j = 0; j < keys.length; j++) { var v = per[keys[j]][field]; if (isNum(v)) vals.push(v); }
      var m = mean(vals), s = sd(vals);
      return { mean: m, sd: s, n: vals.length, usable: !!(s > 0 && vals.length >= 12) };
    }
    var S = CFG.TALENT.scale;
    var stats = {
      starter_quality: zStats('starter_quality'), rotation_quality: zStats('rotation_quality'),
      depth_quality: zStats('depth_quality'), value_continuity: zStats('value_continuity'),
      transfer_index: zStats('transfer_index'), availability_out_share: zStats('availability_out_share')
    };
    function scaled(field, key, invert) {
      var v = per[key][field], st = stats[field];
      if (!isNum(v)) return null;
      if (!st.usable) return null;
      var z = (v - st.mean) / st.sd;
      if (invert) z = -z;
      return clamp(S.center + S.sd * z, S.floor, S.ceiling);
    }

    var out = {};
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      var P = per[k];
      var comps = CFG.TALENT.components, parts = [], ws = 0, ss = 0, missing = [];
      for (var c = 0; c < comps.length; c++) {
        var comp = comps[c], val = null, note = null;
        if (comp.id === 'starter_quality') val = scaled('starter_quality', k);
        else if (comp.id === 'rotation_quality') val = scaled('rotation_quality', k);
        else if (comp.id === 'depth_quality') val = scaled('depth_quality', k);
        else if (comp.id === 'returning_value') { val = scaled('value_continuity', k); if (val == null) note = P.returning_reason || 'no prior-season player ratings for this team, so returning VALUE cannot be computed'; }
        else if (comp.id === 'transfer_value') { val = scaled('transfer_index', k); if (val == null) note = 'no league-wide spread of net transfer value was available'; }
        else if (comp.id === 'availability') {
          val = scaled('availability_out_share', k, true);
          if (val == null) note = 'no availability record reached this roster — UNKNOWN, which is not the same as healthy';
        }
        if (val == null) { missing.push({ id: comp.id, why: note || (comp.id + ' could not be standardised across the league'), w: comp.w }); continue; }
        parts.push({ id: comp.id, value: r1(val), w: comp.w, basis: comp.basis });
        ss += val * comp.w; ws += comp.w;
      }
      var rating = ws > 0 ? ss / ws : null;
      out[k] = {
        schema: SCHEMA, version: CFG.VERSIONS.talent, key: k,
        rating: r1(rating),
        available: rating != null,
        components: parts, missing: missing,
        contract_covered: r3(ws),
        units: P.units,
        starter_quality: r1(P.starter_quality), rotation_quality: r1(P.rotation_quality),
        depth_quality: r1(P.depth_quality), missing_units: P.missing_units,
        covered_units: P.covered_units,
        offense_units: r1(P.offense_units), defense_units: r1(P.defense_units),
        returning: { value_continuity: P.value_continuity, roster_continuity: P.roster_continuity,
          reason: P.returning_reason },
        transfers: { index: P.transfer_index, net_value: P.transfer_net_value,
          in: P.transfer_in, out: P.transfer_out,
          starters_in: P.transfer_starters_in, starters_out: P.transfer_starters_out },
        availability: { out_share: r3(P.availability_out_share), unknown_share: r3(P.availability_unknown_share),
          records: P.availability_records,
          rating: r1(scaled('availability_out_share', k, true)),
          basis: P.availability_records ? 'from football/availability/current.json, EdgeDesk’s own evidence-ranked dataset'
            : 'no live availability record reached this roster. UNKNOWN is carried as unknown; it is never read as healthy.' },
        player_confidence: r3(P.confidence),
        recruiting: { applied: false, reason: CFG.TALENT.recruiting.reason },
        smoothing: CFG.TALENT.smoothing,
        may_move: CFG.TALENT.may_move, may_not_move: CFG.TALENT.may_not_move
      };
    }
    return { schema: SCHEMA, version: CFG.VERSIONS.talent, teams: out, league: stats,
      basis: 'position-value weighted roster ability from the player layer, with every share-shaped component standardised across FBS so the pieces are on one scale before they are weighted together' };
  }

  /* ---------------------------------------------------------------------
     DEPTH, CONTINUITY, PERSONNEL-TENDENCY ALIGNMENT
     Published as their own ratings because the brief asks for them to be
     rankable, and because each answers a different question.
     --------------------------------------------------------------------- */
  function continuityRating(talentTeam, unitsTeam) {
    var inputs = CFG.CARRYOVER.inputs, parts = [], ws = 0, ss = 0, missing = [];
    var vals = {
      value_continuity: talentTeam.returning.value_continuity,
      qb_continuity: qbContinuity(unitsTeam),
      ol_continuity: talentTeam.units.OL && talentTeam.units.OL.available ? talentTeam.units.OL.continuity : null,
      starts_continuity: startersContinuity(unitsTeam),
      transfer_churn: churn(talentTeam)
    };
    for (var i = 0; i < inputs.length; i++) {
      var it = inputs[i], v = vals[it.id];
      if (!isNum(v)) { missing.push({ id: it.id, why: 'not observable for this team', w: it.w }); continue; }
      if (it.dir === -1) v = 1 - clamp(v, 0, 1);
      parts.push({ id: it.id, value: r3(v), w: it.w, basis: it.basis });
      ss += clamp(v, 0, 1) * it.w; ws += it.w;
    }
    return { value: ws > 0 ? ss / ws : null, components: parts, missing: missing, covered: r3(ws),
      coordinator: CFG.CARRYOVER.coordinator_continuity };
  }
  function qbContinuity(unitsTeam) {
    if (!unitsTeam || !unitsTeam.groups || !unitsTeam.groups.QB) return null;
    var q = unitsTeam.groups.QB;
    var c = num(q.ct != null ? q.ct : q.continuity);
    return isNum(c) ? c : null;
  }
  function startersContinuity(unitsTeam) {
    var ret = unitsTeam && unitsTeam.returning;
    if (!ret || !ret.by_group) return null;
    var vals = [], g;
    for (g in ret.by_group) {
      if (!Object.prototype.hasOwnProperty.call(ret.by_group, g)) continue;
      var b = ret.by_group[g];
      if (b && b.starters_returning != null) vals.push(b.starters_returning);
    }
    return vals.length ? mean(vals) : null;
  }
  function churn(talentTeam) {
    var t = talentTeam.transfers;
    if (!t || t.in == null) return null;
    var inN = num(t.in), outN = num(t.out);
    if (!isNum(inN)) return null;
    return clamp(((inN || 0) + (outN || 0)) / 60, 0, 1);   /* 60 movements is a total rebuild */
  }

  /* PERSONNEL-TENDENCY ALIGNMENT, published under the name `scheme_fit`.
     READ THE BASIS BEFORE READING THE NUMBER: this is NOT a film read of
     scheme. Concepts, coverages, personnel groupings and blitz rates are in no
     public feed and this system never claims them. What IS computable is
     whether what a team actually DOES lines up with what its roster is good
     at — a run-leaning offence with a strong line and backfield is aligned; a
     pass-leaning one with a thin quarterback room is not. */
  function alignment(talentTeam, scheme) {
    if (!scheme) {
      return { value: null, available: false,
        reason: 'no tendency profile for this team, so personnel-tendency alignment cannot be computed' };
    }
    function tz(side, key) {
      var x = scheme[side] && scheme[side][key];
      if (!x) return null;
      var z = (x.z != null) ? x.z : null;
      return isNum(z) ? z : null;
    }
    function uz(name) {
      var u = talentTeam.units[name];
      if (!u || !u.available || !isNum(u.rating)) return null;
      return (u.rating - CFG.TALENT.scale.center) / CFG.TALENT.scale.sd;
    }
    function pair(tendency, unitZ) {
      if (tendency == null || unitZ == null) return null;
      return clamp(tendency, -2.5, 2.5) * clamp(unitZ, -2.5, 2.5);
    }
    var rushRate = tz('offense', 'rush_rate');
    var pairs = [
      { id: 'run_identity_vs_run_personnel', v: pair(rushRate, avg([uz('OL'), uz('RB')])),
        basis: 'how much the offence runs, against how good its line and backfield are' },
      { id: 'pass_identity_vs_pass_personnel', v: pair(rushRate == null ? null : -rushRate, avg([uz('QB'), uz('WR')])),
        basis: 'how much the offence throws, against how good its quarterback and receivers are' },
      { id: 'vertical_identity_vs_receivers', v: pair(tz('offense', 'explosive_pass_rate'), uz('WR')),
        basis: 'how explosive the passing game is, against the receiver room behind it' },
      { id: 'pressure_identity_vs_front', v: pair(tz('defense', 'def_sack_rate'), avg([uz('EDGE'), uz('DL')])),
        basis: 'how often the defence gets home, against the front doing it' }
    ];
    var got = pairs.filter(function (p) { return p.v != null; });
    if (!got.length) {
      return { value: null, available: false, pairs: pairs,
        reason: 'neither a measured tendency nor a rated unit was available on any pair' };
    }
    return { value: mean(got.map(function (p) { return p.v; })), available: true, pairs: pairs,
      scored: got.length, contract: pairs.length,
      basis: 'personnel-tendency alignment: whether what this team actually does lines up with what its roster is good at. It is NOT a film read of scheme — concepts, coverage shells, personnel groupings and blitz rates are in no public feed and are never claimed here.' };
  }
  function avg(list) {
    var v = list.filter(function (x) { return isNum(x); });
    return v.length ? mean(v) : null;
  }

  return { SCHEMA: SCHEMA, build: build, unit: unit, grp: grp, roll: roll,
    unitPositionValue: unitPositionValue, UNIT_MAP: UNIT_MAP,
    OFFENSE_UNITS: OFFENSE_UNITS, DEFENSE_UNITS: DEFENSE_UNITS,
    continuityRating: continuityRating, alignment: alignment,
    mean: mean, sd: sd, config: CFG };
});
