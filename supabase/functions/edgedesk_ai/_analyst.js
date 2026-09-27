// deno-lint-ignore-file
/* ============================================================================
   EdgeDesk ANALYST KERNEL — the matchup interaction engine, recent-form
   assessment, nearby-line sensitivity from the registered margin
   distributions, conditional scenarios, follow-up resolution, the
   investigation planner and the packet diff.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHY IT EXISTS
     Slice 2 put the football layers INTO the packet: drivers, profiles,
     ratings, starters, the injury report, the forecast. What the desk still
     did was list them. This kernel reads them the way an analyst does:
       1. INTERACTIONS — one side's unit against the unit that has to stop
          it, with the mechanism, the counter-argument, the uncertainty and
          whether the rating already prices it. A module with no measured
          input says NOT_MEASURED; nothing is invented to fill a slot.
       2. FORM — did they improve, or did they play somebody weak? Opponent
          quality, garbage time, turnovers and explosive dependence, with the
          sample size beside every claim.
       3. SENSITIVITY — what happens at +7? Under the model's OWN residual
          distribution, cover / push / lose at nearby numbers, key numbers
          named, and the probability the market price REQUIRES. The
          validation registry decides whether any of that may be called a
          betting probability; here it is model-conditional and says so.
       4. SCENARIOS — conditional estimates where a validated engine re-run
          exists (published by the NFL slate build), qualitative otherwise,
          always labelled, never the projection.
       5. FOLLOW-UPS — "what about their line?", "does that change at +7?",
          "who have they played?", "strongest case against us?" resolved
          against the conversation's structured state.
       6. INVESTIGATION — which unanswered questions would change the
          analysis, in order of consequence, for the orchestrator to send
          to configured providers under a budget.

   THE RULES
     - Every evidence item carries value, source and observed time; a
       missing input is named as missing.
     - No coverage, route, personnel-grouping or tracking statistic exists
       in EdgeDesk's data, so no module claims one.
     - The rating already includes what it includes; a module says so and
       an advantage the rating priced is not counted twice.
     - No probability is produced as a betting probability unless the
       validation registry permits it for that sport and market.
     - A user's belief is a hypothesis; the kernel investigates, it does not
       record it as fact.
   ============================================================================ */
/*__EDANALYST_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDANALYST = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_analysis_v1';
  var CFB = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
  var KEY_NUMBERS = { 3: 'the most common margin', 7: 'a touchdown', 10: 'a touchdown and a field goal', 14: 'two touchdowns', 4: 'a common margin', 6: 'a common margin' };

  /* ---------------------------------------------------------------- util */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r1(v) { var n = num(v); return n == null ? null : Math.round(n * 10) / 10; }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
  function pct(v, d) { var n = num(v); if (n == null) return null; var f = Math.pow(10, d == null ? 1 : d); return Math.round(n * 100 * f) / f + '%'; }
  function clip(s, n) { s = str(s); return s.length > n ? s.slice(0, n) : s; }
  function R() { return root && root.EDRESEARCH; }
  function I() { return root && root.EDINTEL; }
  function val(f) { var r = R(); if (r && typeof r.val === 'function') return r.val(f); return f && typeof f === 'object' && 'value' in f ? (f.missing ? null : f.value) : (f === undefined ? null : f); }
  function normName(s) { return str(s).toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ').replace(/\bst\.?\b/g, 'state').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function sideName(p, side) { return p && p.game ? (side === 'home' ? p.game.home : p.game.away) : null; }
  function otherSide(s) { return s === 'home' ? 'away' : 'home'; }
  function fmtLine(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + n; }
  function parsePct(s) { if (typeof s === 'number') return s; var m = /^(-?\d+(?:\.\d+)?)%$/.exec(str(s).trim()); return m ? Number(m[1]) / 100 : num(s); }
  function isKey(line) { var a = Math.abs(Math.round(num(line) * 2) / 2); return KEY_NUMBERS[a] ? a : null; }

  /* ====================================================================== */
  /* 1. NEARBY-LINE SENSITIVITY                                              */
  /* ====================================================================== */
  /** win / push / lose for the HOME side of `homeLine` under a residual pmf
      centred on the model's home margin. The pmf is integer residuals; a
      whole-number line pushes on the rounded residual, a half line never. */
  function coverFromPmf(pmf, homeMargin, homeLine) {
    var M = num(homeMargin), L = num(homeLine);
    if (!pmf || M == null || L == null) return null;
    var t = -L - M;                                  /* residual needed to cover, home side */
    var whole = Math.abs(L % 1) < 1e-9;
    var win = 0, push = 0, lose = 0, tot = 0, k, r, p, tr = Math.round(t);
    for (k in pmf) {
      if (!Object.prototype.hasOwnProperty.call(pmf, k)) continue;
      r = parseInt(k, 10); p = num(pmf[k]); if (p == null) continue;
      tot += p;
      if (whole) { if (r === tr) push += p; else if (r > tr) win += p; else lose += p; }
      else { if (r > t) win += p; else lose += p; }
    }
    if (tot <= 0.5) return null;
    return { win: r4(win / tot), push: r4(push / tot), lose: r4(lose / tot) };
  }
  function pickCurve(curve, homeLine) {
    if (!Array.isArray(curve) || !curve.length) return null;
    var L = num(homeLine), best = null, i;
    for (i = 0; i < curve.length; i++) { var c = curve[i]; if (num(c.home_line) != null && Math.abs(num(c.home_line) - L) < 1e-9) { best = c; break; } }
    return best ? { win: r4(best.win), push: r4(best.push), lose: r4(best.lose) } : null;
  }
  /**
   * lineSensitivity({ sport, side, selection, model_home_line, market_selection_line,
   *                   distribution?, cover_curve?, validation?, odds_american?, span?, key_mass? })
   * Everything is stated from the SELECTION's side. Probabilities are the
   * model's own residual distribution around its own projection: they are
   * conditional on the projection being right, which the validation record
   * says it is not better than the market at. So they are labelled
   * MODEL_CONDITIONAL and never become an expected value here.
   */
  function lineSensitivity(o) {
    o = o || {};
    var side = o.side === 'home' || o.side === 'away' ? o.side : null;
    var mhl = num(o.model_home_line), mkt = num(o.market_selection_line);
    if (!side || mhl == null || mkt == null) return { ok: false, error: 'a side, a model home line and a market selection line are required' };
    var sgn = side === 'home' ? 1 : -1;
    var modelSel = r2(sgn * mhl), homeMargin = -mhl;
    var dist = o.distribution || null;
    var Ik = I();
    if (!dist && Ik && typeof Ik.distribution === 'function' && o.sport) { try { dist = Ik.distribution(o.sport + '|margin_resid'); } catch (_) { dist = null; } }
    var v = o.validation || null;
    if (!v && Ik && typeof Ik.validationFor === 'function' && o.sport) { try { v = Ik.validationFor(o.sport, 'spreads'); } catch (_) { v = null; } }
    var permitted = !!(v && v.may_produce_probability);
    var span = num(o.span) != null ? Math.min(14, Math.max(1, num(o.span))) : 7;
    var keyMass = o.key_mass || null;
    var basis = Array.isArray(o.cover_curve) && o.cover_curve.length ? 'margin_pmf_by_spread (published with the projection)' : (dist ? 'pooled residual pmf ' + (dist.key || '') : null);
    var ladder = [], crossed = [], i;
    for (i = -span * 2; i <= span * 2; i++) {
      var selLine = r2(mkt + i * 0.5);
      var homeLine = r2(sgn * selLine);
      var c = pickCurve(o.cover_curve, homeLine) || (dist ? coverFromPmf(dist.pmf, homeMargin, homeLine) : null);
      var row = { selection_line: selLine, points_vs_model: r2(selLine - modelSel), key_number: isKey(selLine), key_mass: null, cover: null, push: null, lose: null };
      if (row.key_number != null && keyMass && num(keyMass[String(row.key_number)]) != null) row.key_mass = r4(keyMass[String(row.key_number)]);
      if (c) { if (side === 'home') { row.cover = c.win; row.push = c.push; row.lose = c.lose; } else { row.cover = c.lose; row.push = c.push; row.lose = c.win; } }
      ladder.push(row);
    }
    var at = null;
    ladder.forEach(function (r) { if (Math.abs(r.selection_line - mkt) < 1e-9) at = r; });
    /* key numbers between the market line and the model line, both signed from the selection */
    var lo = Math.min(mkt, modelSel), hi = Math.max(mkt, modelSel);
    [3, 7, 10, 14].forEach(function (k) { [k, -k].forEach(function (s) { if (s > lo && s < hi) crossed.push({ number: s, meaning: KEY_NUMBERS[k], mass: keyMass && num(keyMass[String(k)]) != null ? r4(keyMass[String(k)]) : null }); }); });
    var requires = null, dec = null;
    var Rk = R();
    if (num(o.odds_american) != null && Rk && typeof Rk.americanToDec === 'function') {
      dec = Rk.americanToDec(num(o.odds_american));
      if (dec) {
        var pushP = at && at.push != null ? at.push : 0;
        /* break-even on a push-refunded bet: p_win * (dec - 1) = p_lose, p_lose = 1 - p_win - p_push */
        var be = (1 - pushP) / dec;
        requires = { price: num(o.odds_american), break_even_cover_probability: r4(be), note: 'The probability the price requires is arithmetic on the price alone' + (pushP ? ', with the model-conditional push mass refunded' : '') + '. It is not a claim about the model.' };
      }
    }
    var verdict = null;
    if (at && at.cover != null && requires) {
      var diff = at.cover - requires.break_even_cover_probability;
      verdict = {
        model_conditional_cover: at.cover, required: requires.break_even_cover_probability, difference_pp: r2(diff * 100),
        reading: permitted ? 'The model is validated to produce a probability in this market; the difference may feed an expected value.'
          : 'MODEL-CONDITIONAL, NOT AN EDGE. The cover figure assumes the projection is right, and the validation record (tier ' + (v ? v.tier : 'none') + ') says this model does not beat the close. "Likely to cover if the model is right" and "worth betting at this price" are different questions; this answers only the first.'
      };
    }
    return {
      ok: true, side: side, selection: o.selection || null, sport: o.sport || null, _params: o,
      model_selection_line: modelSel, market_selection_line: r2(mkt), gap_points: r2(mkt - modelSel),
      basis: basis, distribution: dist ? { key: dist.key || null, sigma: num(dist.sigma), window: dist.window || null, limitations: dist.limitations || null } : null,
      probability_status: basis ? (permitted ? 'VALIDATED' : 'MODEL_CONDITIONAL') : 'NOT_PRODUCED',
      validation_tier: v ? v.tier : null,
      at_market: at, ladder: ladder, key_numbers_crossed: crossed,
      requires: requires, verdict: verdict,
      note: basis ? 'cover / push / lose are the probabilities the model’s OWN residual distribution assigns around its OWN projection. They describe the spread of outcomes if the projection is right; the validation record decides whether they may be treated as betting probabilities, and for this market it ' + (permitted ? 'does' : 'does not') + '.'
        : 'No margin distribution is registered for this sport, so only the points of disagreement are shown; no cover probability is produced.'
    };
  }

  /** The same ladder read at ONE alternative line — the follow-up "does that change at +7?". */
  function atLine(sens, line) {
    if (!sens || !sens.ok) return { ok: false, error: 'no sensitivity on file' };
    var L = num(line); if (L == null) return { ok: false, error: 'a line is required' };
    var row = null;
    sens.ladder.forEach(function (r) { if (Math.abs(r.selection_line - L) < 1e-9) row = r; });
    /* a line off the ladder is read by widening it, not refused: the reader named it */
    if (!row && sens._params && Math.abs(L - sens.market_selection_line) <= 30) {
      var wider = lineSensitivity(Object.assign({}, sens._params, { span: Math.ceil(Math.abs(L - sens.market_selection_line)) + 1 }));
      if (wider.ok) { wider.ladder.forEach(function (r) { if (Math.abs(r.selection_line - L) < 1e-9) row = r; }); }
    }
    if (!row) return { ok: false, error: 'the line ' + fmtLine(L) + ' is outside the ladder (' + fmtLine(sens.ladder[0].selection_line) + ' to ' + fmtLine(sens.ladder[sens.ladder.length - 1].selection_line) + ')' };
    if (Math.abs(L % 1) > 1e-9 && Math.abs((L * 2) % 1) > 1e-9) return { ok: false, error: 'lines are read in half points' };
    var Rk = R(); var th = Rk && Rk.DEFAULT_THRESHOLDS ? Rk.DEFAULT_THRESHOLDS : { disagreement_points: 2.5, disagreement_hard: 6 };
    var g = Math.abs(row.points_vs_model);
    var label = g >= th.disagreement_hard ? 'MODEL DISAGREEMENT' : g >= th.disagreement_points ? 'RESEARCH LEAD' : 'PASS';
    return { ok: true, line: row, from_market: sens.at_market, change_in_cover_pp: row.cover != null && sens.at_market && sens.at_market.cover != null ? r2((row.cover - sens.at_market.cover) * 100) : null,
      label_on_gap_alone: label, probability_status: sens.probability_status,
      note: 'At ' + fmtLine(row.selection_line) + ' the market gives this side ' + fmtLine(row.points_vs_model) + ' points against the model’s ' + fmtLine(sens.model_selection_line) + (row.key_number != null ? '; ' + Math.abs(row.selection_line) + ' is a key number (' + KEY_NUMBERS[row.key_number] + ')' : '') + '. The label implied by the gap alone is ' + label + '; the price and the data confidence still govern.' };
  }

  /* ====================================================================== */
  /* 2. MEASURED INPUTS — one accessor over the identity record and the       */
  /*    packet, so every module reads the same numbers                       */
  /* ====================================================================== */
  /* Unit ids are the rankings build's ids for FBS and the engine's feature
     names for the NFL, mapped onto one vocabulary the modules read. */
  var UNIT = {
    /* common id : { cfb: [offense id, defense counter], nfl: [offense id, defense counter], label, unit, higher_is_better(offense) } */
    protection:   { cfb: ['sack_rate_allowed', 'def_sack_rate'],            nfl: ['sack_rate_all', 'sack_rate_made'],          label: 'sack rate', unit: 'rate', lower_better: true },
    explosive_pass: { cfb: ['explosive_pass_rate', 'def_explosive_pass_allowed'], nfl: ['expl_pass', 'def_expl_pass'],        label: 'explosive pass rate', unit: 'rate' },
    explosive_rush: { cfb: ['explosive_rush_rate', 'def_explosive_rush_allowed'], nfl: ['expl_rush', 'def_expl_rush'],        label: 'explosive rush rate', unit: 'rate' },
    rush_eff:     { cfb: ['yards_per_rush', 'def_yards_per_rush'],           nfl: ['rush_epa_att', 'def_rush_epa_att'],        label: 'rushing efficiency', unit: 'yards' },
    stuff:        { cfb: ['stuff_rate', 'def_stuff_rate'],                   nfl: null,                                        label: 'stuff rate', unit: 'rate', lower_better: true },
    pass_eff:     { cfb: ['yards_per_attempt', 'def_yards_per_attempt'],     nfl: ['pass_epa_db', 'def_pass_epa_db'],          label: 'passing efficiency', unit: 'yards' },
    success:      { cfb: ['success_rate', 'def_success_allowed'],            nfl: ['off_epa_play', 'def_epa_play'],            label: 'efficiency per play', unit: 'rate' },
    early_down:   { cfb: ['early_down_success', 'def_early_down_allowed'],   nfl: null,                                        label: 'early-down success', unit: 'rate' },
    third_down:   { cfb: ['third_success', 'def_third_allowed'],             nfl: null,                                        label: 'third-down conversion', unit: 'rate' },
    finishing:    { cfb: ['rz_success', 'def_rz_allowed'],                   nfl: null,                                        label: 'red-zone finishing', unit: 'rate' },
    turnovers:    { cfb: ['turnover_rate', 'def_turnovers_forced'],          nfl: null,                                        label: 'turnover rate', unit: 'rate', lower_better: true }
  };
  /** One measured unit value for a side: {value, adjusted, league, z, n, reliability, source, as_of} or null. */
  function unitOf(ctx, side, id) {
    var idn = ctx.identity && ctx.identity[side];
    var u = idn && idn.measured && idn.measured.units ? idn.measured.units[id] : null;
    if (u && (num(u.adjusted) != null || num(u.raw) != null)) {
      return { id: id, value: num(u.adjusted) != null ? num(u.adjusted) : num(u.raw), raw: num(u.raw), adjusted: num(u.adjusted), league: num(u.league), z: num(u.z), n: num(u.n), reliability: num(u.reliability),
        basis: num(u.adjusted) != null ? 'opponent-adjusted' : 'raw', source: u.source || (idn.sources && idn.sources[0]) || 'football/identity/teams.json', observed_at: u.as_of || idn.verified_at || null };
    }
    /* fall back to the packet's drivers, which carry both units of a pair */
    var ds = (ctx.packet && ctx.packet.drivers) || [];
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      var att = normName(d.attacker) === normName(sideName(ctx.packet, side));
      if (d.id === id && att && d.attacker_value) return fromShow(d.attacker_value, d, id, 'attacker');
      var dm = counterOf(ctx.sport, id);
      if (dm && d.id === dm && !att && d.defender_value) return fromShow(d.defender_value, d, id, 'defender');
    }
    return null;
  }
  function counterOf(sport, defId) { var k, U; for (k in UNIT) { U = UNIT[k][sport === NFL ? 'nfl' : 'cfb']; if (U && U[1] === defId) return U[0]; } return null; }
  function fromShow(sv, d, id, role) {
    var v = parsePct(sv.adjusted != null ? sv.adjusted : sv.raw), lg = parsePct(sv.league);
    return { id: id, value: v, raw: parsePct(sv.raw), adjusted: parsePct(sv.adjusted), league: lg, z: num(sv.z), n: num(sv.plays), reliability: num(d.reliability),
      basis: sv.show_basis || 'opponent-adjusted', source: d.source || 'football/matchup/metrics.json', observed_at: d.observed_at || null, via: 'driver:' + role };
  }
  /** Both halves of a pair: attacker's offence unit against defender's defence unit. */
  function pair(ctx, key, attacker) {
    var U = UNIT[key]; if (!U) return null;
    var ids = U[ctx.sport === NFL ? 'nfl' : 'cfb'];
    if (!ids) return { key: key, status: 'NOT_MEASURED', reason: U.label + ' is not measured for this league in EdgeDesk’s data' };
    var defender = otherSide(attacker);
    var off = unitOf(ctx, attacker, ids[0]), def = unitOf(ctx, defender, ids[1]);
    if (!off && !def) return { key: key, status: 'NOT_MEASURED', reason: 'neither side has a published ' + U.label };
    if (!off || !def) return { key: key, status: 'PARTIAL', off: off, def: def, reason: (!off ? sideName(ctx.packet, attacker) : sideName(ctx.packet, defender)) + ' has no published ' + U.label };
    /* z is direction-corrected by the rankings build (higher is better for
       that unit); for the NFL raw values, orient by the sign convention. */
    var zo = off.z, zd = def.z, adv = null;
    if (zo != null && zd != null) adv = zo - zd;
    else if (off.league != null && def.league != null && off.value != null && def.value != null) {
      /* raw-minus-league on both halves, oriented so positive favours the attacker */
      var oGap = (off.value - off.league) * (U.lower_better ? -1 : 1);
      var dGap = (def.value - def.league) * (U.lower_better ? 1 : -1); /* a defence that ALLOWS more than league is worse */
      adv = oGap + dGap; /* in the unit's own scale, not z */
    }
    return { key: key, status: 'MEASURED', label: U.label, off: off, def: def, advantage: adv == null ? null : r2(adv), scale: zo != null && zd != null ? 'z' : U.unit,
      reliability: r2(Math.min(off.reliability == null ? 1 : off.reliability, def.reliability == null ? 1 : def.reliability)) };
  }
  function evidenceItem(side, ctx, u, label) {
    if (!u) return null;
    return { team: sideName(ctx.packet, side), metric: label, value: u.value, raw: u.raw, adjusted: u.adjusted, league: u.league, z: u.z, sample: u.n, basis: u.basis, source: u.source, observed_at: u.observed_at };
  }
  function gapWord(z) { var m = Math.abs(num(z) || 0); return m >= 1.5 ? 'a wide gap' : m >= 0.8 ? 'a clear gap' : m >= 0.3 ? 'a modest gap' : 'close to level'; }
  function uncertaintyOf(parts) {
    var reasons = [], level = 'LOW';
    parts.forEach(function (u) { if (!u) return; if (u.reliability != null && u.reliability < 0.5) { reasons.push('thin sample behind ' + (u.id || 'a metric') + ' (reliability ' + u.reliability + ')'); } if (u.n != null && u.n < 60) reasons.push((u.id || 'a metric') + ' rests on ' + u.n + ' plays'); });
    if (reasons.length >= 2) level = 'HIGH'; else if (reasons.length === 1) level = 'MEDIUM';
    return { level: level, reasons: reasons.slice(0, 4) };
  }
  /* what the rating already includes, per sport and module */
  var IN_MODEL = {
    cfb: {
      pass_rush_vs_protection: { included: true, how: 'sack_rate_allowed, front_disruption_rate and their defensive counterparts are efficiency features of edgedesk_cfb_p4 (layer B); the rating prices the unit levels, not this pairing’s interaction' },
      qb_under_pressure: { included: 'partial', how: 'the quarterback’s EPA per dropback is priced through the p4 QB layer; his split under pressure is not measured anywhere' },
      rushing_vs_front: { included: true, how: 'epa_rush, stuff_rate and yards_per_play are p4 efficiency features' },
      explosive_pass_vs_coverage: { included: true, how: 'expl_epa_rate and def_expl_epa_rate are p4 efficiency features; coverage is not measured' },
      personnel_vs_availability: { included: 'partial', how: 'only the quarterback’s absence is priced (params.unavailable_by_design); every other position ships untrained' },
      tempo_vs_depth: { included: 'partial', how: 'plays_per_game is a p4 efficiency feature; depth enters the rating through the roster continuity layer, not as a tempo interaction' },
      finishing_drives: { included: true, how: 'red_zone_success and points_per_drive are p4 efficiency features' },
      weather_vs_style: { included: false, how: 'no weather coefficient was earned (params.unavailable_by_design); supplied weather only narrows the uncertainty band' },
      special_teams_field_position: { included: 'partial', how: 'start_field_position is a p4 efficiency feature; the special-teams rating is a rankings-build overlay, not a p4 input' },
      late_game_backdoor: { included: false, how: 'the residual distribution carries margin variance in general; no backdoor-cover mechanism is modelled' }
    },
    nfl: {
      pass_rush_vs_protection: { included: 'partial', how: 'sack rates enter the total model (sack_env) and the spread only through net EPA; the spread model has no protection feature' },
      qb_under_pressure: { included: 'partial', how: 'qb_adj_diff prices the starter’s EPA level; no pressure split is measured' },
      rushing_vs_front: { included: true, how: 'net_rush (rush EPA per attempt, both sides) is a spread feature' },
      explosive_pass_vs_coverage: { included: 'partial', how: 'explosive rates enter the total model (expl_sum); the spread prices passing through net_pass' },
      personnel_vs_availability: { included: 'partial', how: 'only the starting quarterback id changes the projection; the injury report is not an engine input' },
      tempo_vs_depth: { included: 'partial', how: 'pace_sum is a total feature; depth is not measured' },
      finishing_drives: { included: false, how: 'red-zone rates are not engine features' },
      weather_vs_style: { included: 'partial', how: 'temperature and wind are total features (temp_c, wind_o) and not spread features' },
      special_teams_field_position: { included: false, how: 'special teams are not measured for the NFL in EdgeDesk’s data' },
      late_game_backdoor: { included: false, how: 'the margin pmf carries variance in general; no backdoor mechanism is modelled' }
    }
  };
  function inModel(sport, id) { var m = IN_MODEL[sport === NFL ? 'nfl' : 'cfb'][id]; return m || { included: null, how: 'not stated' }; }

  /* ====================================================================== */
  /* 3. THE MATCHUP INTERACTION ENGINE                                       */
  /* ====================================================================== */
  function module(o) {
    return { id: o.id, label: o.label, status: o.status || 'MEASURED', advantage: o.advantage || { side: null, magnitude: null, scale: null, word: null },
      evidence: o.evidence || { home: [], away: [] }, mechanism: o.mechanism || null, counter: o.counter || null,
      uncertainty: o.uncertainty || { level: 'HIGH', reasons: ['not measured'] }, in_model: o.in_model, missing: o.missing || [], kind: o.kind || 'measured' };
  }
  function advOf(ctx, p, attacker) {
    if (!p || p.status !== 'MEASURED' || p.advantage == null) return { side: null, magnitude: null, scale: null, word: null };
    var fav = p.advantage >= 0 ? attacker : otherSide(attacker);
    return { side: sideName(ctx.packet, fav), magnitude: p.advantage, scale: p.scale, word: p.scale === 'z' ? gapWord(p.advantage) : (Math.abs(p.advantage) < 1e-9 ? 'level' : 'measured in ' + p.scale) };
  }
  /** Pair-based module for both directions; picks the wider one as the advantage and keeps the other as the counter. */
  function pairModule(ctx, id, label, key, mechanism, counterText) {
    var a = pair(ctx, key, 'away'), h = pair(ctx, key, 'home');
    var missing = [];
    [a, h].forEach(function (p) { if (p && p.status !== 'MEASURED') missing.push(p.reason); });
    var ev = { home: [], away: [] };
    if (a && a.off) ev.away.push(evidenceItem('away', ctx, a.off, UNIT[key].label + ' (offence)'));
    if (a && a.def) ev.home.push(evidenceItem('home', ctx, a.def, UNIT[key].label + ' allowed (defence)'));
    if (h && h.off) ev.home.push(evidenceItem('home', ctx, h.off, UNIT[key].label + ' (offence)'));
    if (h && h.def) ev.away.push(evidenceItem('away', ctx, h.def, UNIT[key].label + ' allowed (defence)'));
    var measured = [a, h].filter(function (p) { return p && p.status === 'MEASURED' && p.advantage != null; });
    if (!measured.length) return module({ id: id, label: label, status: (a && a.status === 'PARTIAL') || (h && h.status === 'PARTIAL') ? 'PARTIAL' : 'NOT_MEASURED', evidence: ev, mechanism: mechanism, counter: null, uncertainty: { level: 'HIGH', reasons: missing.length ? missing : ['no measured pair'] }, in_model: inModel(ctx.sport, id), missing: missing });
    measured.sort(function (x, y) { return Math.abs(y.advantage) - Math.abs(x.advantage); });
    var lead = measured[0], leadAtt = lead === a ? 'away' : 'home';
    var other = measured.length > 1 ? measured[1] : null, otherAtt = other === a ? 'away' : 'home';
    var adv = advOf(ctx, lead, leadAtt);
    var counter = counterText || null;
    if (other && other.advantage != null) {
      var oa = advOf(ctx, other, otherAtt);
      counter = 'The other direction: ' + sideName(ctx.packet, otherAtt) + '’s ' + UNIT[key].label + ' against ' + sideName(ctx.packet, otherSide(otherAtt)) + '’s is ' + oa.word + (oa.side ? ' in ' + oa.side + '’s favour' : '') + '.';
    } else if (missing.length) counter = 'One direction is unmeasured: ' + missing[0] + '.';
    return module({ id: id, label: label, status: missing.length ? 'PARTIAL' : 'MEASURED', advantage: adv, evidence: ev, mechanism: mechanism, counter: counter,
      uncertainty: uncertaintyOf([lead.off, lead.def].concat(other ? [other.off, other.def] : [])), in_model: inModel(ctx.sport, id), missing: missing });
  }
  function profileOf(ctx, side) {
    var idn = ctx.identity && ctx.identity[side];
    var p = idn && idn.measured && idn.measured.profile ? idn.measured.profile : (ctx.packet && ctx.packet.profiles ? ctx.packet.profiles[side] : null);
    return p && (num(p.plays_per_game) != null || num(p.pass_rate) != null) ? p : null;
  }
  function ratingOf(ctx, side) { var idn = ctx.identity && ctx.identity[side]; return (idn && idn.measured && idn.measured.rating) || (ctx.packet && ctx.packet.ratings ? ctx.packet.ratings[side] : null) || null; }
  function qbOf(ctx, side) { var idn = ctx.identity && ctx.identity[side]; return (idn && idn.measured && idn.measured.quarterback) || null; }
  function availOf(ctx, side) { var idn = ctx.identity && ctx.identity[side]; var a = ctx.packet && ctx.packet.availability ? ctx.packet.availability[side] : null; var inj = ctx.packet && ctx.packet.injuries ? ctx.packet.injuries[side] : null; return { state: a && !a.missing ? a.state : 'UNKNOWN', report: inj, groups: idn && idn.measured && idn.measured.availability ? idn.measured.availability.by_position_group : (inj && inj.players ? groupsOf(inj.players) : null), source: (inj && inj.source) || (a && a.source) || null, observed_at: (inj && inj.retrieved_at) || (a && a.observed_at) || null }; }
  var OL = /^(OT|OG|C|G|T|OL|LT|RT|LG|RG)$/i, DL = /^(DE|DT|NT|DL|EDGE|OLB)$/i, DB = /^(CB|S|FS|SS|DB|NB)$/i, WR = /^(WR|TE)$/i, RB = /^(RB|FB|HB)$/i, LB = /^(LB|ILB|MLB|OLB)$/i;
  function groupsOf(players) {
    var g = { OL: [], DL: [], DB: [], LB: [], WR_TE: [], RB: [], QB: [], other: [] };
    (players || []).forEach(function (p) {
      var pos = str(p.position).toUpperCase(), st = str(p.status).toUpperCase();
      if (!/OUT|DOUBTFUL|QUESTIONABLE|IR/.test(st)) return;
      var e = { name: p.name || p.player_name, position: pos, status: p.status, practice: p.practice || p.practice_status || null };
      if (pos === 'QB') g.QB.push(e); else if (OL.test(pos)) g.OL.push(e); else if (DL.test(pos)) g.DL.push(e); else if (DB.test(pos)) g.DB.push(e); else if (LB.test(pos)) g.LB.push(e); else if (WR.test(pos)) g.WR_TE.push(e); else if (RB.test(pos)) g.RB.push(e); else g.other.push(e);
    });
    return g;
  }
  function weatherOf(ctx) { var s = ctx.packet && ctx.packet.situation; var w = s && s.weather; return w && !w.missing && w.value ? { value: w.value, source: w.source, observed_at: w.observed_at, freshness: w.freshness, roof: s.roof || null, note: s.weather_note || null } : { value: null, missing: true, reason: w && w.reason ? w.reason : 'no forecast on file', roof: s ? s.roof : null }; }

  function interactions(o) {
    o = o || {};
    var p = o.packet || {}, sport = o.sport || (p.game && p.game.sport) || CFB;
    var ctx = { packet: p, identity: o.identity || null, sport: sport };
    var home = sideName(p, 'home') || 'the home side', away = sideName(p, 'away') || 'the away side';
    var mods = [];

    /* 1. pass rush versus protection */
    mods.push(pairModule(ctx, 'pass_rush_vs_protection', 'Pass rush versus protection', 'protection',
      'A sack is a drive-killer twice over: the yardage and the down. Protection that holds turns third-and-seven into third-and-three; a rush that gets home pushes the offence into the down-and-distance where the defence already has the advantage.'));

    /* 2. quarterback under pressure versus expected pressure */
    (function () {
      var ev = { home: [], away: [] }, missing = [], adv = { side: null, magnitude: null, scale: null, word: null };
      var pressure = null;
      ['home', 'away'].forEach(function (side) {
        var q = qbOf(ctx, side) || null, st = p.starters && p.starters[side];
        var name = q && q.starter ? q.starter.name : (st && !st.missing ? st.player_name : null);
        var epa = q && q.epa ? q.epa : null;
        if (name) ev[side].push({ team: sideName(p, side), metric: 'projected starter', value: name, status: (q && q.starter && q.starter.status) || (st && st.status) || null, confirmed: !!((q && q.starter && q.starter.confirmed) || (st && st.confirmed)), source: (q && q.starter && q.starter.source) || (st && st.source) || null, observed_at: (st && (st.retrieved_at || st.published_at)) || null });
        if (epa && epa.season && num(epa.season.epa_per_dropback) != null) ev[side].push({ team: sideName(p, side), metric: 'QB EPA per dropback (season)', value: r4(epa.season.epa_per_dropback), sample: num(epa.season.dropbacks), league: num(epa.league_epa_per_dropback), source: epa.source || 'football/fbs_epa', observed_at: epa.observed_through || null });
        if (epa && epa.career && num(epa.career.sack_rate) != null) ev[side].push({ team: sideName(p, side), metric: 'QB sack rate taken (career)', value: r4(epa.career.sack_rate), sample: num(epa.career.dropbacks), source: epa.source || 'football/fbs_epa', observed_at: epa.observed_through || null });
        if (!name) missing.push('no projected starter on file for ' + sideName(p, side));
        if (!epa) missing.push('no quarterback EPA record for ' + sideName(p, side));
        var def = unitOf(ctx, otherSide(side), (UNIT.protection[sport === NFL ? 'nfl' : 'cfb'] || [])[1]);
        if (def) ev[otherSide(side)].push(evidenceItem(otherSide(side), ctx, def, 'sack rate made (defence)'));
        if (epa && epa.career && num(epa.career.sack_rate) != null && def && def.league != null && def.value != null) {
          /* a QB who takes sacks against a defence that gets home: the exposure is the product of two above-league rates */
          var exposure = (epa.career.sack_rate - (num(epa.league_sack_rate) != null ? epa.league_sack_rate : epa.career.sack_rate)) + (def.value - def.league);
          if (!pressure || Math.abs(exposure) > Math.abs(pressure.exposure)) pressure = { side: side, exposure: r4(exposure) };
        }
      });
      if (pressure) adv = { side: sideName(p, pressure.exposure > 0 ? otherSide(pressure.side) : pressure.side), magnitude: pressure.exposure, scale: 'rate points above league (QB sacks taken + defence sacks made)', word: Math.abs(pressure.exposure) >= 0.04 ? 'a clear exposure' : Math.abs(pressure.exposure) >= 0.015 ? 'a modest exposure' : 'close to level' };
      mods.push(module({ id: 'qb_under_pressure', label: 'Quarterback under pressure versus expected pressure', status: pressure ? 'MEASURED' : (ev.home.length || ev.away.length ? 'PARTIAL' : 'NOT_MEASURED'), advantage: adv, evidence: ev,
        mechanism: 'Pressure changes a quarterback more than any other input: completion rate, interception rate and sack rate all move with it. The read is how often this quarterback has taken sacks against how often this defence gets home; the split of his efficiency WITH pressure against WITHOUT is not measured anywhere in EdgeDesk’s data.',
        counter: 'A high sack rate taken can be the quarterback holding the ball for explosives rather than a protection failure; the explosive-pass module is the check.',
        uncertainty: { level: pressure ? 'MEDIUM' : 'HIGH', reasons: ['no pressure-rate or time-to-throw statistic exists in EdgeDesk’s data; sacks stand in for pressure'].concat(missing.slice(0, 2)) }, in_model: inModel(sport, 'qb_under_pressure'), missing: missing }));
    })();

    /* 3. rushing attack versus defensive front */
    (function () {
      var m = pairModule(ctx, 'rushing_vs_front', 'Rushing attack versus defensive front', 'rush_eff',
        'The blunt measure of whether the run game works against this front, read together with stuff rate: a front that stops runs at the line produces exactly the long-yardage downs a defence wants.');
      var s = pair(ctx, 'stuff', 'away'), s2 = pair(ctx, 'stuff', 'home');
      [s, s2].forEach(function (x, i) { if (x && x.status === 'MEASURED') { var att = i === 0 ? 'away' : 'home'; m.evidence[att].push(evidenceItem(att, ctx, x.off, 'stuff rate taken (offence)')); m.evidence[otherSide(att)].push(evidenceItem(otherSide(att), ctx, x.def, 'stuff rate made (defence)')); } });
      mods.push(m);
    })();

    /* 4. explosive passing versus coverage vulnerabilities */
    mods.push((function () {
      var m = pairModule(ctx, 'explosive_pass_vs_coverage', 'Explosive passing versus coverage', 'explosive_pass',
        'College and pro scoring margin comes disproportionately from explosives: one replaces a whole drive of successful plays, which is why a defence can hold a good success rate and still lose the scoreboard.');
      m.uncertainty.reasons.unshift('coverage scheme, route data and tracking are not measured; the read is explosive rate against explosives allowed, not a coverage read');
      if (m.uncertainty.level === 'LOW') m.uncertainty.level = 'MEDIUM';
      return m;
    })());

    /* 5. offensive personnel versus defensive availability */
    (function () {
      var ev = { home: [], away: [] }, missing = [], notes = [], status = 'NOT_MEASURED', adv = { side: null, magnitude: null, scale: null, word: null };
      ['home', 'away'].forEach(function (side) {
        var a = availOf(ctx, side);
        if (a.state === 'OFFICIAL_REPORT' && a.groups) {
          status = 'MEASURED';
          var g = a.groups;
          Object.keys(g).forEach(function (k) { if (Array.isArray(g[k]) && g[k].length) ev[side].push({ team: sideName(p, side), metric: k + ' on the injury report', value: g[k].length, players: g[k].slice(0, 6).map(function (x) { return x.name + ' (' + x.position + ', ' + x.status + ')'; }), source: a.source, observed_at: a.observed_at }); });
          if (!ev[side].length) ev[side].push({ team: sideName(p, side), metric: 'injury report', value: 'nobody listed out, doubtful or questionable', source: a.source, observed_at: a.observed_at });
        } else if (a.state && a.state !== 'UNKNOWN' && a.state !== 'NOT_DUE') {
          status = status === 'MEASURED' ? 'MEASURED' : 'PARTIAL';
          ev[side].push({ team: sideName(p, side), metric: 'availability state', value: a.state, source: a.source, observed_at: a.observed_at });
        } else missing.push('availability for ' + sideName(p, side) + ' is ' + (a.state || 'not on file') + ' — not healthy, unknown');
      });
      /* the one measurable interaction: an offence's dependence versus the defence's listed absences by group */
      ['home', 'away'].forEach(function (side) {
        var a = availOf(ctx, otherSide(side)); var g = a.groups;
        var pr = profileOf(ctx, side);
        if (g && pr && num(pr.pass_rate) != null) {
          var dbOut = (g.DB || []).filter(function (x) { return /OUT|DOUBTFUL/i.test(x.status); }).length;
          var dlOut = (g.DL || []).filter(function (x) { return /OUT|DOUBTFUL/i.test(x.status); }).length;
          if (dbOut && pr.pass_rate >= 0.5) notes.push(sideName(p, side) + ' passes on ' + pct(pr.pass_rate, 0) + ' of plays and ' + sideName(p, otherSide(side)) + ' lists ' + dbOut + ' defensive back' + (dbOut > 1 ? 's' : '') + ' out or doubtful.');
          if (dlOut && pr.pass_rate < 0.5) notes.push(sideName(p, side) + ' runs on ' + pct(1 - pr.pass_rate, 0) + ' of plays and ' + sideName(p, otherSide(side)) + ' lists ' + dlOut + ' defensive line' + (dlOut > 1 ? 'men' : 'man') + ' out or doubtful.');
        }
      });
      mods.push(module({ id: 'personnel_vs_availability', label: 'Offensive personnel versus defensive availability', status: status, advantage: adv, evidence: ev,
        mechanism: notes.length ? notes.join(' ') : 'An absence matters in proportion to how much the opponent attacks that group. The report says who is out; the play profile says what the offence leans on.',
        counter: 'A listed player’s replacement is not measured: the report names absences, not the quality of who steps in. Questionable players frequently play.',
        uncertainty: { level: status === 'MEASURED' ? 'MEDIUM' : 'HIGH', reasons: ['replacement quality is not measured'].concat(missing) }, in_model: inModel(sport, 'personnel_vs_availability'), missing: missing }));
    })();

    /* 6. tempo versus opponent depth */
    (function () {
      var ev = { home: [], away: [] }, missing = [], adv = { side: null, magnitude: null, scale: null, word: null }, status = 'NOT_MEASURED';
      ['home', 'away'].forEach(function (side) {
        var pr = profileOf(ctx, side), rt = ratingOf(ctx, otherSide(side));
        if (pr && num(pr.plays_per_game) != null) { status = status === 'NOT_MEASURED' ? 'PARTIAL' : status; ev[side].push({ team: sideName(p, side), metric: 'plays per game', value: r1(pr.plays_per_game), garbage_time_free: pr.excluding_garbage_time ? r1(pr.excluding_garbage_time.plays_per_game) : null, source: pr.source || 'football/matchup/profiles', observed_at: pr.as_of || null }); } else missing.push('no pace on file for ' + sideName(p, side));
        var depth = rt && rt.depth != null ? (typeof rt.depth === 'object' ? num(rt.depth.rating) : num(rt.depth)) : null;
        if (depth != null) { status = 'MEASURED'; ev[otherSide(side)].push({ team: sideName(p, otherSide(side)), metric: 'depth rating (rankings build)', value: r1(depth), source: rt.source || 'football/rankings/current.json', observed_at: rt.as_of || null }); } else missing.push('depth is not measured for ' + sideName(p, otherSide(side)));
      });
      var fast = null;
      ['home', 'away'].forEach(function (side) { var pr = profileOf(ctx, side); if (pr && num(pr.plays_per_game) != null && (!fast || pr.plays_per_game > fast.v)) fast = { side: side, v: pr.plays_per_game }; });
      if (fast && status === 'MEASURED') adv = { side: sideName(p, fast.side), magnitude: r1(fast.v), scale: 'plays per game', word: 'the faster offence' };
      mods.push(module({ id: 'tempo_vs_depth', label: 'Tempo versus opponent depth', status: status, advantage: adv, evidence: ev,
        mechanism: 'A fast offence turns a thin opponent into a tired one by the fourth quarter; the effect is on the defence’s second unit, which no season average shows.',
        counter: 'Pace also shortens the favourite’s advantage by adding possessions to a game the underdog needs variance in; a fast favourite is not always the beneficiary.',
        uncertainty: { level: 'HIGH', reasons: ['no snap-count or rotation data exists in EdgeDesk’s data'].concat(missing.slice(0, 2)) }, in_model: inModel(sport, 'tempo_vs_depth'), missing: missing }));
    })();

    /* 7. scoring opportunities versus finishing */
    mods.push((function () {
      var m = pairModule(ctx, 'finishing_drives', 'Scoring opportunities versus finishing drives', 'finishing',
        'The field shortens and explosives disappear inside the twenty, so finishing is a different skill from moving the ball. A team that moves well and finishes badly leaves points the margin will show.');
      ['home', 'away'].forEach(function (side) { var pr = profileOf(ctx, side); if (pr && num(pr.red_zone_td_rate) != null) m.evidence[side].push({ team: sideName(p, side), metric: 'red-zone touchdown rate', value: r4(pr.red_zone_td_rate), source: pr.source || 'football/matchup/profiles', observed_at: pr.as_of || null }); if (pr && num(pr.third_down_rate) != null) m.evidence[side].push({ team: sideName(p, side), metric: 'third-down conversion', value: r4(pr.third_down_rate), source: pr.source || 'football/matchup/profiles', observed_at: pr.as_of || null }); });
      return m;
    })());

    /* 8. weather versus offensive style */
    (function () {
      var w = weatherOf(ctx), ev = { home: [], away: [] }, missing = [], status = 'NOT_MEASURED', adv = { side: null, magnitude: null, scale: null, word: null }, mech;
      if (w.missing) { missing.push(w.reason); mech = 'No forecast is on file for this game' + (w.roof && /dome|closed/i.test(w.roof) ? ' and the roof is ' + w.roof + ', so weather does not apply' : '') + '.'; }
      else {
        status = 'PARTIAL';
        var v = w.value;
        var wind = num(v.wind_mph), temp = num(v.temp_f), precip = num(v.precip_pct);
        ['home', 'away'].forEach(function (side) { ev[side].push({ team: sideName(p, side), metric: 'forecast at kickoff', value: [temp != null ? Math.round(temp) + '°F' : null, wind != null ? 'wind ' + Math.round(wind) + ' mph' : null, precip != null ? 'precip ' + Math.round(precip) + '%' : null].filter(Boolean).join(', '), source: w.source, observed_at: w.observed_at }); var pr = profileOf(ctx, side); if (pr && num(pr.pass_rate) != null) { status = 'MEASURED'; ev[side].push({ team: sideName(p, side), metric: 'pass rate', value: r4(pr.pass_rate), explosive_pass_rate: r4(pr.explosive_pass_rate), source: pr.source || 'football/matchup/profiles', observed_at: pr.as_of || null }); } });
        var strong = wind != null && wind >= 15, cold = temp != null && temp <= 35, wet = precip != null && precip >= 50;
        if (w.note) mech = w.note;
        else if (!strong && !cold && !wet) mech = 'The forecast is benign (' + (wind != null ? Math.round(wind) + ' mph' : 'wind not stated') + '); neither passing game is expected to be constrained by it.';
        else {
          var heavier = null;
          ['home', 'away'].forEach(function (side) { var pr = profileOf(ctx, side); if (pr && num(pr.pass_rate) != null && (!heavier || pr.pass_rate > heavier.v)) heavier = { side: side, v: pr.pass_rate }; });
          mech = (strong ? 'Wind of ' + Math.round(wind) + ' mph shortens the deep passing game and field goals. ' : '') + (cold ? 'At ' + Math.round(temp) + '°F ball handling and kicking suffer. ' : '') + (wet ? 'A ' + Math.round(precip) + '% chance of precipitation raises fumble and drop risk. ' : '') + (heavier ? 'The more pass-reliant offence is ' + sideName(p, heavier.side) + ' (' + pct(heavier.v, 0) + ' pass rate), so the constraint falls more on it.' : '');
          if (heavier) adv = { side: sideName(p, otherSide(heavier.side)), magnitude: null, scale: null, word: 'the less pass-reliant side is less constrained' };
        }
      }
      mods.push(module({ id: 'weather_vs_style', label: 'Weather versus offensive style', status: status, advantage: adv, evidence: ev, mechanism: mech,
        counter: 'Forecasts move; a kickoff-hour reading taken ' + (w.observed_at ? 'at ' + String(w.observed_at).slice(0, 16) + 'Z' : 'at an unknown time') + ' is the last observation, not the game-day fact. Domes and closed roofs make the whole module moot.',
        uncertainty: { level: w.missing ? 'HIGH' : 'MEDIUM', reasons: (w.missing ? [w.reason] : ['the forecast is an observation with a horizon, not a measurement of the game']).concat(missing) }, in_model: inModel(sport, 'weather_vs_style'), missing: missing }));
    })();

    /* 9. special teams and field position */
    (function () {
      var ev = { home: [], away: [] }, missing = [], status = 'NOT_MEASURED', adv = { side: null, magnitude: null, scale: null, word: null };
      var best = null;
      ['home', 'away'].forEach(function (side) {
        var rt = ratingOf(ctx, side), st = rt && rt.special_teams;
        if (st && num(st.z) != null && st.available !== false) { status = 'MEASURED'; ev[side].push({ team: sideName(p, side), metric: 'special-teams rating (z)', value: r2(st.z), coverage: num(st.coverage), source: rt.source || 'football/rankings/current.json', observed_at: rt.as_of || null }); if (!best || st.z > best.z) best = { side: side, z: st.z }; }
        else missing.push('no special-teams rating for ' + sideName(p, side) + (sport === NFL ? ' (not measured for the NFL)' : ''));
        var pr = profileOf(ctx, side);
        if (pr && num(pr.avg_drive_start_ytg) != null) { if (status === 'NOT_MEASURED') status = 'PARTIAL'; ev[side].push({ team: sideName(p, side), metric: 'average drive start (yards to goal)', value: r1(pr.avg_drive_start_ytg), source: pr.source || 'football/matchup/profiles', observed_at: pr.as_of || null }); }
      });
      if (best) { var oz = ratingOf(ctx, otherSide(best.side)); var oz2 = oz && oz.special_teams ? num(oz.special_teams.z) : null; var g = oz2 != null ? best.z - oz2 : null; adv = { side: sideName(p, best.side), magnitude: g != null ? r2(g) : null, scale: 'z', word: g != null ? gapWord(g) : null }; }
      mods.push(module({ id: 'special_teams_field_position', label: 'Special teams and field position', status: status, advantage: adv, evidence: ev,
        mechanism: 'Field position is hidden margin: thirty yards of it per possession is a touchdown a game that no efficiency number shows. The rating is coverage-gated; below coverage it is not shown.',
        counter: 'Special-teams ratings are among the least stable season to season and week to week; a big edge here is mostly variance until the sample is large.',
        uncertainty: { level: status === 'MEASURED' ? 'MEDIUM' : 'HIGH', reasons: ['special-teams measures are noisy'].concat(missing) }, in_model: inModel(sport, 'special_teams_field_position'), missing: missing }));
    })();

    /* 10. late-game pace, substitutions and backdoor-cover exposure — an inference from measured pieces */
    (function () {
      var m = p.model || {}, hl = m.home_line && !m.home_line.missing ? num(val(m.home_line)) : null;
      var ev = { home: [], away: [] }, reasons = [], status = 'NOT_MEASURED', adv = { side: null, magnitude: null, scale: null, word: null }, mech;
      if (hl == null || Math.abs(hl) < 6.5) { mech = hl == null ? 'No projection is on file, so no favourite is defined.' : 'The projected margin (' + fmtLine(-hl) + ' for ' + home + ') is under a touchdown; a backdoor cover is not the structure of this game.'; }
      else {
        var favSide = hl < 0 ? 'home' : 'away', dogSide = otherSide(favSide);
        var dog = profileOf(ctx, dogSide), fav = profileOf(ctx, favSide);
        var ex = unitOf(ctx, dogSide, (UNIT.explosive_pass[sport === NFL ? 'nfl' : 'cfb'] || [])[0]);
        status = 'PARTIAL';
        if (dog && num(dog.pass_rate) != null) ev[dogSide].push({ team: sideName(p, dogSide), metric: 'pass rate', value: r4(dog.pass_rate), source: dog.source || 'football/matchup/profiles', observed_at: dog.as_of || null });
        if (dog && num(dog.plays_per_game) != null) ev[dogSide].push({ team: sideName(p, dogSide), metric: 'plays per game', value: r1(dog.plays_per_game), source: dog.source || 'football/matchup/profiles', observed_at: dog.as_of || null });
        if (ex) { status = 'MEASURED'; ev[dogSide].push(evidenceItem(dogSide, ctx, ex, 'explosive pass rate (offence)')); }
        if (fav && num(fav.plays_per_game) != null) ev[favSide].push({ team: sideName(p, favSide), metric: 'plays per game', value: r1(fav.plays_per_game), source: fav.source || 'football/matchup/profiles', observed_at: fav.as_of || null });
        var expl = ex && ex.league != null && ex.value != null ? ex.value - ex.league : null;
        var passy = dog && num(dog.pass_rate) != null ? dog.pass_rate : null;
        var exposure = (expl != null && expl > 0 ? 1 : 0) + (passy != null && passy >= 0.55 ? 1 : 0);
        mech = sideName(p, favSide) + ' is projected to win by ' + Math.abs(hl) + '. A cover needs the margin to hold through the fourth quarter, when a leading favourite substitutes and shortens the game while a trailing underdog throws.' + (expl != null ? ' ' + sideName(p, dogSide) + '’s explosive pass rate is ' + (expl > 0 ? 'above' : 'at or below') + ' league (' + pct(ex.value) + ' vs ' + pct(ex.league) + ')' + (expl > 0 ? ', the profile that produces a late score.' : ', which lowers the late-score path.') : '');
        adv = { side: sideName(p, exposure >= 1 ? dogSide : favSide), magnitude: exposure, scale: 'exposure count (explosive above league, pass-heavy)', word: exposure >= 2 ? 'a real backdoor path' : exposure === 1 ? 'a modest backdoor path' : 'little backdoor path' };
        reasons.push('an inference from pace, pass rate and explosiveness; no late-game or substitution data is measured');
      }
      mods.push(module({ id: 'late_game_backdoor', label: 'Late-game pace, substitutions and backdoor-cover exposure', status: status, advantage: adv, evidence: ev, mechanism: mech,
        counter: 'A favourite that keeps its starters and its tempo closes the door; garbage-time points are the reason a margin can miss a number the game never threatened.',
        uncertainty: { level: 'HIGH', reasons: reasons.length ? reasons : ['not applicable'] }, in_model: inModel(sport, 'late_game_backdoor'), kind: 'inference' }));
    })();

    /* decisive factors: the three measured modules with the widest advantage, weighted by certainty */
    var scored = mods.filter(function (m) { return m.status === 'MEASURED' && m.advantage && m.advantage.side && m.advantage.magnitude != null; }).map(function (m) {
      var mag = Math.abs(num(m.advantage.magnitude) || 0);
      var scale = m.advantage.scale === 'z' ? mag : m.advantage.scale === 'rate' ? mag * 20 : m.advantage.scale === 'yards' ? mag : m.advantage.scale === 'plays per game' ? 0.2 : mag;
      var cert = m.uncertainty.level === 'LOW' ? 1 : m.uncertainty.level === 'MEDIUM' ? 0.7 : 0.4;
      return { m: m, score: scale * cert };
    }).sort(function (a, b) { return b.score - a.score; });
    var decisive = scored.slice(0, 3).map(function (s) { return summarise(s.m, p); });
    /* the counter-case: the strongest measured factor that favours the OTHER side from the model favourite (or from the first decisive factor) */
    var favSide = p.model && p.model.home_line && !p.model.home_line.missing ? (num(val(p.model.home_line)) < 0 ? home : num(val(p.model.home_line)) > 0 ? away : null) : (decisive[0] ? decisive[0].favours : null);
    var counter = scored.filter(function (s) { return favSide && s.m.advantage.side && normName(s.m.advantage.side) !== normName(favSide); })[0];
    var counterCase = counter ? summarise(counter.m, p) : null;
    return {
      schema: SCHEMA, version: VERSION, sport: sport, modules: mods,
      measured: mods.filter(function (m) { return m.status === 'MEASURED'; }).length, partial: mods.filter(function (m) { return m.status === 'PARTIAL'; }).length, not_measured: mods.filter(function (m) { return m.status === 'NOT_MEASURED'; }).length,
      decisive_factors: decisive, counter_case: counterCase, model_favourite: favSide,
      not_measured_note: 'No coverage, route, personnel-grouping, snap-count or tracking statistic exists in EdgeDesk’s data. A module that would need one says NOT_MEASURED or names the proxy it used.',
      double_count_note: 'in_model says what the rating already prices. A MEASURED advantage the rating includes explains the number; it does not add to it.'
    };
  }
  function summarise(m, p) {
    var e = [];
    ['away', 'home'].forEach(function (s) { (m.evidence[s] || []).slice(0, 2).forEach(function (x) { if (x) e.push(x.team + ' ' + x.metric + ' ' + (typeof x.value === 'number' ? (x.metric.indexOf('rate') >= 0 || x.metric.indexOf('efficiency') >= 0 || x.metric.indexOf('conversion') >= 0 ? pct(x.value) : x.value) : x.value) + (x.league != null ? ' (league ' + (x.metric.indexOf('rate') >= 0 || x.metric.indexOf('efficiency') >= 0 ? pct(x.league) : x.league) + ')' : '')); }); });
    return { id: m.id, label: m.label, favours: m.advantage.side, word: m.advantage.word, magnitude: m.advantage.magnitude, scale: m.advantage.scale, status: m.status, uncertainty: m.uncertainty.level,
      in_model: m.in_model && m.in_model.included, evidence: e.slice(0, 4), mechanism: m.mechanism, counter: m.counter,
      sentence: m.label + ': ' + (m.advantage.word || '') + (m.advantage.side ? ' in ' + m.advantage.side + '’s favour' : '') + (m.in_model && m.in_model.included === true ? ' (already in the rating)' : m.in_model && m.in_model.included === 'partial' ? ' (partly in the rating)' : ' (not in the rating)') + '.' };
  }

  /* ====================================================================== */
  /* 4. RECENT FORM                                                          */
  /* ====================================================================== */
  function formAssessment(o) {
    o = o || {};
    var p = o.packet || {}, sport = o.sport || (p.game && p.game.sport) || CFB;
    var ctx = { packet: p, identity: o.identity || null, sport: sport };
    var out = { schema: 'edgedesk_form_assessment_v1', sides: {}, questions: [] };
    ['home', 'away'].forEach(function (side) {
      var name = sideName(p, side) || side;
      var idn = ctx.identity && ctx.identity[side];
      var games = (p.previous_games && p.previous_games[side]) || [];
      var fromIdentity = false;
      /* no completed-games table for this league: the identity's own schedule
         (results with the opponent's engine rank now) is the next best read */
      if (!games.length && idn && idn.measured && idn.measured.schedule && Array.isArray(idn.measured.schedule.opponents) && idn.measured.schedule.opponents.some(function (g) { return num(g.margin) != null; })) {
        games = idn.measured.schedule.opponents.filter(function (g) { return num(g.margin) != null; }).map(function (g) { return { date: g.date, week: g.week, opponent: g.opponent, venue: g.venue, result: g.result, margin: g.margin, points_for: g.points_for, points_against: g.points_against, opponent_sp_plus_now: null, opponent_sp_rank_now: g.opponent_rank_now != null ? g.opponent_rank_now : null, opponent_rating_time_basis: g.opponent_rank_basis || 'AS_ASSESSED_NOW' }; });
        fromIdentity = true;
      }
      var trend = idn && idn.trend ? idn.trend : null;
      var pr = profileOf(ctx, side);
      var rt = ratingOf(ctx, side);
      var ownSp = p.matchup && p.matchup[side] ? num(p.matchup[side].sp_plus_overall) : null;
      var rows = games.map(function (g) {
        var opp = num(g.opponent_sp_plus_now);
        var expected = ownSp != null && opp != null ? r1(ownSp - opp + (g.venue === 'home' ? 2.5 : g.venue === 'away' ? -2.5 : 0)) : null;
        return { date: g.date, week: g.week, opponent: g.opponent, venue: g.venue, result: g.result, margin: num(g.margin), points_for: num(g.points_for), points_against: num(g.points_against), opponent_rank_now: num(g.opponent_sp_rank_now) != null && num(g.opponent_sp_plus_now) == null ? num(g.opponent_sp_rank_now) : null,
          opponent_rating_now: opp, opponent_rank_now: num(g.opponent_sp_rank_now), opponent_rating_basis: g.opponent_rating_time_basis || 'AS_ASSESSED_NOW',
          expected_margin_sp: expected, margin_vs_expected: expected != null && num(g.margin) != null ? r1(num(g.margin) - expected) : null };
      });
      var n = rows.length, wins = rows.filter(function (r) { return r.result === 'W'; }).length;
      var avgMargin = n ? r1(rows.reduce(function (s, r) { return s + (r.margin || 0); }, 0) / n) : null;
      var withOpp = rows.filter(function (r) { return r.opponent_rating_now != null; });
      var avgOpp = withOpp.length ? r1(withOpp.reduce(function (s, r) { return s + r.opponent_rating_now; }, 0) / withOpp.length) : null;
      var withExp = rows.filter(function (r) { return r.margin_vs_expected != null; });
      var avgVsExp = withExp.length ? r1(withExp.reduce(function (s, r) { return s + r.margin_vs_expected; }, 0) / withExp.length) : null;
      var gt = pr && pr.excluding_garbage_time && num(pr.plays_per_game) != null && num(pr.excluding_garbage_time.plays_per_game) != null ? r4(1 - pr.excluding_garbage_time.plays_per_game / pr.plays_per_game) : null;
      var toLuck = pr && num(pr.giveaways) != null && num(pr.takeaways) != null ? pr.takeaways - pr.giveaways : null;
      var expl = pr && num(pr.explosive_pass_rate) != null ? { pass: r4(pr.explosive_pass_rate), rush: r4(pr.explosive_rush_rate), gt_free_pass: pr.excluding_garbage_time ? r4(pr.excluding_garbage_time.explosive_pass_rate) : null } : null;
      var small = n < 4;
      var hyp = [];
      if (n && avgVsExp != null) hyp.push({ id: 'vs_expected', claim: name + ' has ' + (avgVsExp > 3 ? 'beaten' : avgVsExp < -3 ? 'fallen short of' : 'matched') + ' the margin SP+ would imply by ' + Math.abs(avgVsExp) + ' points a game over ' + n + ' game' + (n > 1 ? 's' : ''), status: small ? 'HYPOTHESIS (small sample)' : 'SUPPORTED', basis: 'own SP+ minus opponent SP+ now, with a home-field allowance of 2.5; the opponent ratings are as assessed NOW, not at the time', source: 'cfb.games + cfb.ratings (CollegeFootballData SP+)' });
      var ranks = rows.map(function (r) { return r.opponent_rank_now; }).filter(function (x) { return x != null; });
      if (avgOpp == null && ranks.length) hyp.push({ id: 'opponent_quality', claim: 'the opponents so far rank ' + ranks.join(', ') + ' of 32 by net EPA as assessed now (' + (ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length <= 12 ? 'a strong slate' : ranks.reduce(function (a, b) { return a + b; }, 0) / ranks.length >= 21 ? 'a weak slate' : 'a middling slate') + ')', status: 'MEASURED', basis: 'engine net-EPA rank of the opponent now, not at the time', source: 'football/nfl/slate.json' });
      if (avgOpp != null) hyp.push({ id: 'opponent_quality', claim: 'the average opponent so far rates ' + avgOpp + ' SP+ (' + (avgOpp > 10 ? 'strong' : avgOpp > 0 ? 'above average' : avgOpp > -10 ? 'below average' : 'weak') + ')', status: 'MEASURED', basis: 'SP+ of opponents as assessed now', source: 'cfb.ratings' });
      if (gt != null && gt >= 0.15) hyp.push({ id: 'garbage_time', claim: pct(gt, 0) + ' of ' + name + '’s plays came in garbage time; the garbage-time-free profile is the one to read', status: 'MEASURED', basis: 'plays per game with and without garbage time', source: pr.source || 'football/matchup/profiles' });
      if (toLuck != null && Math.abs(toLuck) >= 3) hyp.push({ id: 'turnovers', claim: name + ' is ' + (toLuck > 0 ? '+' : '') + toLuck + ' in turnovers, the least repeatable input on this list; results that lean on it are less likely to carry forward', status: 'MEASURED', basis: 'takeaways minus giveaways', source: pr.source || 'football/matchup/profiles' });
      if (expl && expl.gt_free_pass != null && expl.pass != null && expl.pass - expl.gt_free_pass >= 0.02) hyp.push({ id: 'explosive_dependence', claim: 'the explosive pass rate falls from ' + pct(expl.pass) + ' to ' + pct(expl.gt_free_pass) + ' once garbage time is removed', status: 'MEASURED', basis: 'explosive rate with and without garbage time', source: pr.source || 'football/matchup/profiles' });
      if (trend && trend.early_vs_recent) hyp.push({ id: 'trend', claim: trend.early_vs_recent.summary || 'a within-season change is measured', status: (trend.games || []).length < 4 ? 'HYPOTHESIS (small sample)' : 'MEASURED', basis: trend.basis || 'per-game profile', source: trend.source || 'football/identity/teams.json' });
      if (small) hyp.push({ id: 'sample', claim: 'only ' + n + ' completed game' + (n === 1 ? '' : 's') + ' this season: every read above is a hypothesis to test, not a rating change' + (rt && num(rt.confidence) != null ? ' (rating confidence ' + pct(rt.confidence, 0) + ')' : ''), status: 'CAVEAT', basis: 'sample size', source: 'cfb.games' });
      out.sides[side] = { team: name, games: rows, n: n, record: n ? wins + '-' + (n - wins) : null, avg_margin: avgMargin, avg_opponent_rating_now: avgOpp, avg_margin_vs_expected: avgVsExp, games_source: fromIdentity ? 'the identity profile\u2019s schedule (results from the schedule feed)' : 'cfb.games',
        garbage_time_share: gt, turnover_margin: toLuck, explosive: expl, rating_confidence: rt ? num(rt.confidence) : null, small_sample: small, hypotheses: hyp };
    });
    /* the three questions */
    var H = out.sides.home, A = out.sides.away;
    [['home', H], ['away', A]].forEach(function (pair2) {
      var side = pair2[0], s = pair2[1]; if (!s || !s.n) return;
      var rk = s.games.map(function (g) { return g.opponent_rank_now; }).filter(function (x) { return x != null; });
      var q1 = s.avg_margin_vs_expected == null ? (rk.length ? s.team + ' is ' + s.record + ' (average margin ' + fmtLine(s.avg_margin) + ') against opponents ranked ' + rk.join(', ') + ' of 32 by net EPA now; no opponent-adjusted expected margin is on file for the NFL, so whether that beats the schedule is not measured.' : s.team + ': whether the results beat what the opponents’ quality implies cannot be measured (no opponent ratings on file).')
        : s.avg_margin_vs_expected > 3 ? s.team + ' has outperformed the margin its opponents’ ratings imply by ' + s.avg_margin_vs_expected + ' a game against opponents averaging ' + s.avg_opponent_rating_now + ' SP+' + (s.small_sample ? ' — over ' + s.n + ' games, a hypothesis, not an improvement.' : '.')
        : s.avg_margin_vs_expected < -3 ? s.team + ' has underperformed the margin its opponents’ ratings imply by ' + Math.abs(s.avg_margin_vs_expected) + ' a game' + (s.small_sample ? ' over ' + s.n + ' games — too few to call it a decline.' : '.')
        : s.team + '’s results are about what its opponents’ ratings imply' + (s.avg_opponent_rating_now != null && s.avg_opponent_rating_now < -5 ? ', and those opponents rate weak (' + s.avg_opponent_rating_now + ' SP+): the record says less than it looks.' : '.');
      out.questions.push({ side: side, question: 'Did they improve, or did they face weak opponents?', answer: q1 });
      var big = s.games.filter(function (g) { return g.margin != null && g.margin >= 21; })[0];
      if (big) out.questions.push({ side: side, question: 'Does that dominant win translate to this matchup?', answer: s.team + ' beat ' + big.opponent + ' by ' + big.margin + (big.opponent_rating_now != null ? ' against an opponent rated ' + big.opponent_rating_now + ' SP+' + (big.opponent_rating_now < -5 ? ' — a weak side; the margin says little about this opponent' : big.opponent_rating_now > 10 ? ' — a strong side; the margin is meaningful' : '') : big.opponent_rank_now != null ? ' against an opponent ranked ' + big.opponent_rank_now + ' of 32 by net EPA now' + (big.opponent_rank_now >= 21 ? ' — a weak side; the margin says little about this opponent' : big.opponent_rank_now <= 8 ? ' — a strong side; the margin is meaningful' : '') : ' (opponent rating not on file)') + (s.garbage_time_share != null && s.garbage_time_share >= 0.15 ? '. ' + pct(s.garbage_time_share, 0) + ' of the season’s plays were garbage time, so read the garbage-time-free numbers.' : '.') });
      var rt = ratingOf({ packet: o.packet, identity: o.identity, sport: 'x' }, side);
      if (rt && num(rt.defense_rating) != null) out.questions.push({ side: side, question: 'Is the defensive reputation supported by this season’s evidence?', answer: s.team + '’s defence rates ' + r1(rt.defense_rating) + ' in the rankings build (50 is average; higher is better)' + (num(rt.confidence) != null ? ' at ' + pct(rt.confidence, 0) + ' confidence' : '') + (s.n < 4 ? ' on ' + s.n + ' games — the number is a prior more than a measurement this early.' : '.') + (s.avg_opponent_rating_now != null ? ' Opponents so far average ' + s.avg_opponent_rating_now + ' SP+.' : '') });
    });
    out.note = 'Recent form is read against opponent quality, garbage time and turnovers, with the sample beside it. Early-season improvement is a hypothesis to evaluate, not a rating change; the rating’s own confidence says how much to trust it.';
    return out;
  }

  /* ====================================================================== */
  /* 5. SCENARIOS — conditional estimates, labelled                          */
  /* ====================================================================== */
  function scenarios(o) {
    o = o || {};
    var p = o.packet || {}, sport = o.sport || (p.game && p.game.sport) || CFB;
    var ctx = { packet: p, identity: o.identity || null, sport: sport };
    var eng = o.engine_scenarios || null;        /* published by the NFL slate build: { home_qb_out: {...}, ... } */
    var sens = o.sensitivity || null;
    var home = sideName(p, 'home') || 'the home side', away = sideName(p, 'away') || 'the away side';
    var m = p.model || {}, hl = m.home_line && !m.home_line.missing ? num(val(m.home_line)) : null;
    var out = [];
    var LABEL = 'CONDITIONAL ESTIMATE — the engine re-run with one input changed; not the projection, not a prediction of the change happening.';

    function qbOut(side) {
      var name = sideName(p, side), q = qbOf(ctx, side), st = p.starters && p.starters[side];
      var starter = (q && q.starter && q.starter.name) || (st && !st.missing ? st.player_name : null);
      var key = side + '_qb_out';
      var e = eng && eng[key] ? eng[key] : null;
      if (e && num(e.home_line) != null) {
        out.push({ id: key, question: 'What changes if ' + (starter || name + '’s starting quarterback') + ' is out?', kind: 'CONDITIONAL_ESTIMATE', label: LABEL,
          assumptions: ['the replacement carries the team’s season quarterback level (the engine’s own fallback when no starter id is supplied), not a measured backup', 'every other input unchanged'],
          result: { home_line: r2(e.home_line), delta_home_line: r2(e.delta_home_line), total: num(e.total) != null ? r2(e.total) : null, home_win_prob: num(e.home_win_prob) != null ? r4(e.home_win_prob) : null, basis: e.basis || 'engine re-run with ' + side + '_qb_id = null' },
          evidence: [starter ? name + '’s projected starter ' + starter + ' (' + ((q && q.starter && q.starter.status) || (st && st.status) || 'status unknown') + ')' : name + '’s starter is not on file'].concat(q && q.backup && q.backup.name ? ['depth chart backup: ' + q.backup.name + ' (' + (q.backup.basis || 'depth chart') + ')'] : ['no backup is identified in EdgeDesk’s data']),
          source: e.source || 'football/nfl/slate.json (engine scenarios)', observed_at: e.observed_at || null });
      } else {
        var epa = q && q.epa ? q.epa : null, room = q && q.room_rating != null ? q.room_rating : null, comp = q && q.competition ? q.competition : null;
        var ev = [];
        if (starter) ev.push(name + '’s projected starter is ' + starter + ' (' + ((q && q.starter && q.starter.status) || (st && st.status) || 'status unknown') + ', ' + ((q && q.starter && q.starter.confirmed) || (st && st.confirmed) ? 'confirmed' : 'not confirmed') + ')');
        if (epa && epa.career && num(epa.career.epa_per_dropback) != null) ev.push('his career EPA per dropback is ' + r4(epa.career.epa_per_dropback) + ' over ' + epa.career.dropbacks + ' dropbacks (league ' + r4(epa.league_epa_per_dropback) + ')');
        if (comp && comp.players && comp.players.length > 1) ev.push('the next most-used passer this season is ' + comp.players[1].player_name + ' (' + comp.players[1].dropbacks + ' dropbacks, ' + pct(comp.players[1].share, 0) + ' share)');
        if (room != null) ev.push('the quarterback room rates ' + r1(room) + ' in EdgeDesk’s player build (a research rating, not priced)');
        if (q && q.backup && q.backup.name) ev.push('depth-chart backup: ' + q.backup.name);
        out.push({ id: key, question: 'What changes if ' + (starter || name + '’s starting quarterback') + ' is out?', kind: 'QUALITATIVE', label: 'QUALITATIVE — no validated engine re-run exists for a college quarterback change in this build; what is known about the replacement is stated, nothing is estimated.',
          assumptions: ['the p4 model prices only the quarterback’s absence among positions, through his EPA per dropback (' + (sport === CFB ? '10.09 points per unit of EPA per dropback' : 'qb_adj_diff') + '); the replacement’s EPA is ' + (comp && comp.players && comp.players.length > 1 ? 'thin (' + comp.players[1].dropbacks + ' dropbacks)' : 'not measured')],
          result: { direction: 'the projection would move against ' + name + ' by the difference between the starter’s and the replacement’s EPA per dropback; that difference is not on file', home_line: null },
          evidence: ev.length ? ev : [name + '’s quarterback situation is not on file'], source: (q && q.starter && q.starter.source) || (st && st.source) || 'football/starters' });
      }
    }
    qbOut('home'); qbOut('away');

    /* the favourite cannot protect */
    (function () {
      if (hl == null) return;
      var favSide = hl < 0 ? 'home' : hl > 0 ? 'away' : null; if (!favSide) return;
      var pr = pair(ctx, 'protection', favSide);
      var e = eng && eng.protection_fails ? eng.protection_fails : null;
      var ev = [];
      if (pr && pr.status === 'MEASURED') { ev.push(sideName(p, favSide) + ' sack rate allowed ' + pct(pr.off.value) + ' (league ' + pct(pr.off.league) + ')'); ev.push(sideName(p, otherSide(favSide)) + ' sack rate made ' + pct(pr.def.value) + ' (league ' + pct(pr.def.league) + ')'); }
      out.push({ id: 'favourite_cannot_protect', question: 'What happens if ' + sideName(p, favSide) + ' cannot protect?', kind: e ? 'CONDITIONAL_ESTIMATE' : 'QUALITATIVE', label: e ? LABEL : 'QUALITATIVE — no engine input isolates protection; the evidence is the measured pairing.',
        assumptions: ['"cannot protect" means a sack rate allowed above what the season shows; the engine prices the season level, not a game-specific failure'],
        result: e ? { home_line: r2(e.home_line), delta_home_line: r2(e.delta_home_line), basis: e.basis } : { direction: 'a favourite that takes sacks turns early-down efficiency into third-and-long; the measured pairing is ' + (pr && pr.status === 'MEASURED' ? gapWord(pr.advantage) + (pr.advantage >= 0 ? ' in the favourite’s favour' : ' against the favourite') : 'not measured') },
        evidence: ev.length ? ev : ['protection is not measured for this pairing'], source: pr && pr.off ? pr.off.source : null });
    })();

    /* a slower game */
    (function () {
      var prs = { home: profileOf(ctx, 'home'), away: profileOf(ctx, 'away') };
      var dogSide = hl != null ? (hl < 0 ? 'away' : 'home') : null;
      var ev = [];
      ['home', 'away'].forEach(function (s) { if (prs[s] && num(prs[s].plays_per_game) != null) ev.push(sideName(p, s) + ' runs ' + r1(prs[s].plays_per_game) + ' plays a game' + (prs[s].excluding_garbage_time && num(prs[s].excluding_garbage_time.plays_per_game) != null ? ' (' + r1(prs[s].excluding_garbage_time.plays_per_game) + ' without garbage time)' : '')); });
      var ft = m.fair_total && !m.fair_total.missing ? num(val(m.fair_total)) : null;
      out.push({ id: 'slower_game', question: 'How does a slower game affect the underdog?', kind: 'QUALITATIVE', label: 'QUALITATIVE — the spread model has no pace input; pace enters only the total.',
        assumptions: ['fewer possessions reduce the number of chances for the better team’s per-play edge to compound'],
        result: { direction: dogSide ? 'fewer possessions favour ' + sideName(p, dogSide) + ' against the number: a per-play edge needs plays to become points, so a slow game narrows the expected margin and raises the share of outcomes inside the spread' : 'no favourite is defined', total_context: ft != null ? 'the projected total is ' + r1(ft) + '; a slower game pulls the total down and the margin toward zero' : null },
        evidence: ev.length ? ev : ['pace is not on file for either side'], source: (prs.home && prs.home.source) || (prs.away && prs.away.source) || null });
    })();

    /* win comfortably without covering */
    (function () {
      if (hl == null) return;
      var favSide = hl < 0 ? 'home' : 'away';
      var wp = m.home_win_probability && !m.home_win_probability.missing ? num(val(m.home_win_probability)) : null;
      var favWin = wp == null ? null : (favSide === 'home' ? wp : 1 - wp);
      var at = sens && sens.ok && sens.at_market ? sens.at_market : null;
      var favCover = at && at.cover != null ? (sens.side === favSide ? at.cover : (at.lose != null ? at.lose : null)) : null;
      var ev = [];
      if (favWin != null) ev.push(sideName(p, favSide) + ' wins the game in ' + pct(favWin, 0) + ' of the model’s own distribution');
      if (favCover != null) ev.push('and covers ' + fmtLine(sens.side === favSide ? sens.market_selection_line : -sens.market_selection_line) + ' in ' + pct(favCover, 0) + ' (model-conditional)');
      out.push({ id: 'win_not_cover', question: 'Could ' + sideName(p, favSide) + ' win comfortably without covering?', kind: favWin != null && favCover != null ? 'CONDITIONAL_ESTIMATE' : 'QUALITATIVE',
        label: favWin != null && favCover != null ? 'MODEL-CONDITIONAL — both figures come from the model’s own residual distribution around its own projection (validation tier ' + (sens ? sens.validation_tier : 'n/a') + '); the difference is the win-without-cover share, not a betting probability.' : 'QUALITATIVE — the distribution or the market line is not on file.',
        assumptions: ['the model’s projection is the centre of the outcome distribution'],
        result: { win_probability: favWin != null ? r4(favWin) : null, cover_probability_model_conditional: favCover != null ? r4(favCover) : null, win_without_cover: favWin != null && favCover != null ? r4(Math.max(0, favWin - favCover)) : null,
          direction: favWin != null && favCover != null ? Math.max(0, favWin - favCover) >= 0.2 ? 'a large share of the wins are by less than the number' : 'most wins also cover' : 'not computable' },
        evidence: ev.length ? ev : ['no win probability or cover distribution on file'], source: sens && sens.basis ? sens.basis : (m.home_win_probability && m.home_win_probability.source) || null });
    })();

    /* which assumption carries the projection */
    (function () {
      var drivers = m.drivers || {}, pos = drivers.positive || [], neg = drivers.negative || [];
      var carrying = [];
      if (pos.length) carrying.push('the largest positive engine contribution: ' + pos[0]);
      if (neg.length) carrying.push('the largest contribution against: ' + neg[0]);
      ['home', 'away'].forEach(function (s) { var st = p.starters && p.starters[s]; if (st && !st.missing && !st.confirmed) carrying.push(sideName(p, s) + '’s starter ' + (st.player_name || '') + ' is projected from ' + str(st.status).toLowerCase().replace(/_/g, ' ') + ' evidence, not announced'); });
      var rt = { home: ratingOf(ctx, 'home'), away: ratingOf(ctx, 'away') };
      ['home', 'away'].forEach(function (s) { if (rt[s] && num(rt[s].confidence) != null && rt[s].confidence < 0.5) carrying.push(sideName(p, s) + '’s rating confidence is ' + pct(rt[s].confidence, 0) + (rt[s].gates && rt[s].gates.length ? ' (' + rt[s].gates.join(', ').toLowerCase().replace(/_/g, ' ') + ')' : '')); });
      if (m.interval && !m.interval.missing) { var iv = val(m.interval); carrying.push('the projection’s own range is ' + fmtLine(iv.p10) + ' to ' + fmtLine(iv.p90) + ' (home margin)'); }
      out.push({ id: 'carrying_assumption', question: 'Which assumption carries this projection?', kind: 'QUALITATIVE', label: 'DIAGNOSTIC — read from the published contributions, the starter status and the rating confidence.',
        assumptions: [], result: { direction: carrying.length ? carrying[0] : 'the projection publishes no contributions; it rests on the two ratings' }, evidence: carrying, source: drivers.source || (m.home_line && m.home_line.source) || null });
    })();
    return { schema: 'edgedesk_scenarios_v1', items: out, note: 'A CONDITIONAL_ESTIMATE re-runs the validated engine with one input changed and is labelled as such. A QUALITATIVE scenario states the evidence and the direction and estimates nothing. Neither is the projection; the baseline is unchanged.' };
  }

  /* ====================================================================== */
  /* 6. FOLLOW-UPS AND CONVERSATION STATE                                    */
  /* ====================================================================== */
  var FOLLOW = [
    { kind: 'offensive_line', re: /\b(o-?line|offensive line|protection|pass (pro|protection|block)|blocking|line play|front|trenches)\b/i, modules: ['pass_rush_vs_protection', 'rushing_vs_front'], sections: ['interactions'] },
    { kind: 'quarterback', re: /\b(qb|quarterback|starter|backup|under center)\b/i, modules: ['qb_under_pressure'], sections: ['starters', 'scenarios'] },
    { kind: 'alt_line', re: /\b(at|to|if it (moves|goes|gets) to|move to|buy|sell|get)\s*([+−-]\s?\d+(?:\.\d)?)\b|\b([+−-]\s?\d+(?:\.\d)?)\s*(instead|now|line)/i, sections: ['sensitivity'] },
    { kind: 'schedule', re: /\b(who have they (actually )?played|who did they play|schedule|strength of schedule|opponents? (so far|faced)|played (so far|anyone))\b/i, sections: ['form'] },
    { kind: 'counter_case', re: /\b(strongest case against|case against|argument against|why (would|could) (we|this|it) (lose|fail|be wrong)|what am i missing|devil'?s advocate|counter)\b/i, sections: ['counter_case'] },
    { kind: 'scenario_qb_out', re: /\b(if|without|when|should)\b.*\b(qb|quarterback|starter)\b.*\b(out|miss|sits|injur|hurt|doesn'?t play|can'?t play)|\b(qb|quarterback)\b.*\b(out|injur)\b/i, sections: ['scenarios'] },
    { kind: 'weather', re: /\b(weather|wind|rain|snow|cold|temperature|forecast|dome)\b/i, modules: ['weather_vs_style'], sections: ['situation'] },
    { kind: 'injuries', re: /\b(injur|injuries|hurt|availability|out for|questionable|doubtful|report)\b/i, modules: ['personnel_vs_availability'], sections: ['availability'] },
    { kind: 'form', re: /\b(form|improv|trend|last (game|week)|recent|momentum|dominant|blowout|garbage time|reputation)\b/i, sections: ['form'] },
    { kind: 'changed_since', re: /\b(what('s| has| is) changed|changed since|since (yesterday|last (time|week|night))|any (news|updates?)|update me)\b/i, sections: ['diff'] },
    { kind: 'price', re: /\b(price|odds|juice|vig|-1[01]\d|\+1[01]\d|playable|worth (it|betting|a bet)|value)\b/i, sections: ['price'] },
    { kind: 'pace', re: /\b(pace|tempo|slow|fast|plays per game|possessions)\b/i, modules: ['tempo_vs_depth'], sections: ['scenarios'] }
  ];
  /** Classify a follow-up against the conversation's structured state. */
  function followUp(o) {
    o = o || {};
    var q = str(o.question), st = o.state || null;
    var out = { kind: null, kinds: [], modules: [], sections: [], line_override: null, side_hint: null, is_follow_up: false, belief: null };
    FOLLOW.forEach(function (f) { if (f.re.test(q)) { out.kinds.push(f.kind); (f.modules || []).forEach(function (m) { if (out.modules.indexOf(m) < 0) out.modules.push(m); }); (f.sections || []).forEach(function (s) { if (out.sections.indexOf(s) < 0) out.sections.push(s); }); } });
    var lm = /(?:^|[\s(])([+−-])\s?(\d{1,2}(?:\.5)?)(?=[\s)?.,!]|$)/.exec(q);
    if (lm && out.kinds.indexOf('alt_line') >= 0) out.line_override = Number((lm[1] === '−' ? '-' : lm[1]) + lm[2]);
    else if (lm && /\b(at|to|line|spread|number)\b/i.test(q)) { out.line_override = Number((lm[1] === '−' ? '-' : lm[1]) + lm[2]); if (out.kinds.indexOf('alt_line') < 0) out.kinds.push('alt_line'); if (out.sections.indexOf('sensitivity') < 0) out.sections.push('sensitivity'); }
    /* "us" / "our side" / "their" resolve against the state's side */
    if (st && st.side) { if (/\b(us|our|we|my side|the side)\b/i.test(q)) out.side_hint = st.side; if (/\b(they|their|them)\b/i.test(q) && !/\b(both|either)\b/i.test(q)) out.side_hint = out.side_hint || (st.side === 'home' ? 'away' : st.side === 'away' ? 'home' : null); }
    /* a stated belief is a hypothesis to test, not a fact to store */
    var bm = /\b(i (think|believe|heard|read|saw)|isn'?t (he|she|their|the)|apparently|rumou?r|supposedly|word is)\b/i.exec(q);
    if (bm) out.belief = { text: clip(q, 200), treatment: 'HYPOTHESIS', note: 'The reader’s claim is investigated against the sources on file; it is not saved as a fact and it is not answered as one.' };
    out.kind = out.kinds[0] || null;
    var short = q.trim().split(/\s+/).length <= 12;
    out.is_follow_up = !!(st && st.game_id && (out.kinds.length || short || /\b(they|their|them|it|that|this|us|our)\b/i.test(q)) && !/\bvs\.?|versus|@\b/i.test(q));
    return out;
  }
  /** The structured conversation state returned with a turn and carried back on the next. IDs and numbers the SERVER produced only. */
  function conversationState(o) {
    o = o || {};
    var p = o.packet || null, prev = o.previous || null, ctx = o.context || null;
    var prim = p && p.market ? p.market.primary : null;
    var st = {
      schema: 'edgedesk_conversation_state_v1',
      game: p && p.game ? { sport: p.game.sport, game_id: p.game.game_id, home: p.game.home, away: p.game.away, home_id: p.game.home_id, away_id: p.game.away_id, kickoff: p.game.kickoff } : (ctx ? { sport: ctx.sport, game_id: ctx.game_id, home: ctx.home, away: ctx.away, home_id: ctx.home_id, away_id: ctx.away_id, kickoff: ctx.kickoff } : null),
      side: prim ? prim.side : (prev && prev.side) || null,
      market: prim ? prim.market : (prev && prev.market) || null,
      selection: prim ? prim.selection : (prev && prev.selection) || null,
      quoted_line: prim && num(prim.handicap) != null ? num(prim.handicap) : (prev && num(prev.quoted_line) != null ? num(prev.quoted_line) : null),
      quoted_odds: prim ? prim.odds_american : (prev && prev.quoted_odds) || null,
      quoted_at: prim ? prim.captured_at : (prev && prev.quoted_at) || null,
      evidence_retrieved: p && p.sources ? p.sources.map(function (s) { return { source: s.source, observed_at: s.observed_at, freshness: s.freshness }; }).slice(0, 24) : (prev && prev.evidence_retrieved) || [],
      unresolved: (o.investigation && o.investigation.log ? o.investigation.log.filter(function (l) { return l.outcome !== 'FOUND'; }).map(function (l) { return { gap: l.gap, question: l.question, outcome: l.outcome, blocker: l.blocker || null }; }) : []).slice(0, 12),
      line_override: o.line_override != null ? num(o.line_override) : null,
      turns: prev && num(prev.turns) != null ? num(prev.turns) + 1 : 1,
      packet_id: p ? p.packet_id : null,
      built_at: p ? p.built_at : null,
      note: 'Server-built. On the next turn the client hands it back; the server re-resolves the game against the card and re-reads every time-sensitive item before calling it current. Nothing here is believed on the client’s say-so.'
    };
    return st;
  }

  /* ====================================================================== */
  /* 7. THE INVESTIGATION PLANNER                                            */
  /* ====================================================================== */
  /** Rank the unanswered questions most likely to change the analysis. The orchestrator maps gap ids to providers. */
  function investigationPlan(o) {
    o = o || {};
    var p = o.packet || {}, sport = o.sport || (p.game && p.game.sport) || CFB;
    var gaps = [];
    function gap(id, side, question, why, priority) { gaps.push({ id: id, side: side, team: side ? sideName(p, side) : null, question: question, why_it_matters: why, priority: priority }); }
    ['home', 'away'].forEach(function (side) {
      var name = sideName(p, side) || side;
      var st = p.starters && p.starters[side];
      if (!st || st.missing || !st.player_name) gap('starting_qb', side, 'Who starts at quarterback for ' + name + '?', 'the quarterback is the only position the model prices; an unknown starter is the largest single uncertainty in the number', 1);
      else if (!st.confirmed) gap('starting_qb_confirmation', side, 'Is ' + st.player_name + ' confirmed to start for ' + name + '?', 'the projection carries a starter read from ' + str(st.status).toLowerCase().replace(/_/g, ' ') + ' evidence, not an announcement', 2);
      var a = p.availability && p.availability[side];
      var stt = a && !a.missing ? a.state : 'UNKNOWN';
      if (/UNKNOWN|NOT_DUE|LIMITED|UNAVAILABLE/.test(str(stt))) { gap('ol_availability', side, 'Is ' + name + '’s offensive line intact?', 'protection decides whether early-down efficiency survives; nothing on file says who is out', 2); gap('defensive_personnel', side, 'Which defensive starters is ' + name + ' missing?', 'availability is ' + stt + ' — unknown, not healthy', 3); }
      else if (stt === 'OFFICIAL_REPORT') { var inj = p.injuries && p.injuries[side]; var g = inj && inj.players ? groupsOf(inj.players) : null; if (g && g.OL.length) gap('ol_replacement', side, 'Who replaces ' + g.OL.map(function (x) { return x.name; }).join(', ') + ' on ' + name + '’s line?', 'the report names the absence, not the replacement', 3); }
    });
    if (!(p.drivers && p.drivers.length)) gap('opponent_adjusted', null, 'What do the opponent-adjusted unit numbers say about this pairing?', 'without them the football read rests on ratings and records', 2);
    var w = p.situation && p.situation.weather;
    if (w && w.missing && !(p.situation && p.situation.roof && /dome|closed/i.test(p.situation.roof))) gap('weather', null, 'What is the kickoff forecast?', 'wind and precipitation constrain the passing game and the total; no forecast is on file', 3);
    var prim = p.market && p.market.primary;
    if (!prim) gap('current_price', null, 'What is the current price at a book EdgeDesk captures?', 'without a price there is nothing to compare the number to; the label cannot rise above RESEARCH LEAD', 1);
    else if (!prim.actionable) gap('current_price', null, 'What is the current price? The captured one is ' + (prim.quote_age_min != null ? prim.quote_age_min + ' minutes old' : 'of unknown age'), 'a stale price is research, never an action', 1);
    if (p.model && p.model.home_line && p.model.home_line.missing) gap('projection', null, 'Is there a projection for this game?', 'no model number is on file', 2);
    gaps.sort(function (a, b) { return a.priority - b.priority; });
    return { schema: 'edgedesk_investigation_plan_v1', gaps: gaps, sport: sport, note: 'Gaps in order of consequence. Each is sent only to a configured provider that can answer it, under the turn’s time and request budget; a provider that is not configured is reported as a blocker, never skipped silently.' };
  }
  /** Rank competing findings on one question by source quality then time; the winner is stated with why. */
  var SOURCE_TIER = { OFFICIAL_REPORT: 1, OFFICIAL: 1, LEAGUE_FEED: 1, SCHEDULE_FEED: 2, PROVIDER_API: 2, DEPTH_CHART: 3, ARTIFACT: 3, PLAY_ATTRIBUTION: 3, PREVIOUS_GAME: 4, REPUTABLE_MEDIA: 4, SEARCH: 5, USER: 6 };
  function resolveConflicts(findings) {
    var fs = (findings || []).filter(Boolean);
    if (!fs.length) return { resolved: null, considered: [], note: 'nothing to resolve' };
    fs.forEach(function (f) { f._tier = SOURCE_TIER[str(f.source_kind).toUpperCase()] || 5; f._t = Date.parse(f.published_at || f.observed_at || '') || 0; });
    fs.sort(function (a, b) { return a._tier - b._tier || b._t - a._t; });
    var win = fs[0];
    var disagree = fs.filter(function (f) { return f !== win && f.value != null && win.value != null && normName(String(f.value)) !== normName(String(win.value)); });
    var out = { resolved: { value: win.value, source: win.source, source_kind: win.source_kind, published_at: win.published_at || null, observed_at: win.observed_at || null, why: 'highest source tier (' + win.source_kind + ')' + (fs.length > 1 && fs[1]._tier === win._tier ? ', most recent among equals' : '') },
      considered: fs.map(function (f) { return { value: f.value, source: f.source, source_kind: f.source_kind, published_at: f.published_at || null, tier: f._tier }; }),
      disagreement: disagree.length ? disagree.map(function (f) { return f.source + ' says ' + f.value; }) : null,
      note: disagree.length ? 'Sources disagree; the higher-quality, more recent source is stated and the disagreement is kept beside it.' : 'Sources agree.' };
    fs.forEach(function (f) { delete f._tier; delete f._t; });
    return out;
  }

  /* ====================================================================== */
  /* 8. THE PACKET DIFF — what changed since the last snapshot               */
  /* ====================================================================== */
  function packetDiff(prev, now) {
    if (!prev || !now) return { ok: false, error: 'two packets are required', changes: [] };
    var ch = [];
    function cmp(label, a, b, fmt) { if (a == null && b == null) return; var sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) ch.push({ field: label, from: fmt ? fmt(a) : a, to: fmt ? fmt(b) : b }); }
    cmp('label', prev.label && prev.label.label, now.label && now.label.label);
    cmp('model home line', prev.model && prev.model.home_line ? val(prev.model.home_line) : null, now.model && now.model.home_line ? val(now.model.home_line) : null);
    var pp = prev.market && prev.market.primary, np = now.market && now.market.primary;
    cmp('market price', pp ? pp.odds_american + (pp.handicap != null ? ' at ' + fmtLine(pp.handicap) : '') + (pp.book ? ' (' + pp.book + ')' : '') : null, np ? np.odds_american + (np.handicap != null ? ' at ' + fmtLine(np.handicap) : '') + (np.book ? ' (' + np.book + ')' : '') : null);
    cmp('market freshness', prev.market && prev.market.freshness, now.market && now.market.freshness);
    ['home', 'away'].forEach(function (s) {
      cmp((s === 'home' ? (now.game && now.game.home) || 'home' : (now.game && now.game.away) || 'away') + ' availability', prev.availability && prev.availability[s] && prev.availability[s].state, now.availability && now.availability[s] && now.availability[s].state);
      cmp((s === 'home' ? (now.game && now.game.home) || 'home' : (now.game && now.game.away) || 'away') + ' projected starter', prev.starters && prev.starters[s] && prev.starters[s].player_name, now.starters && now.starters[s] && now.starters[s].player_name);
      var pi = prev.injuries && prev.injuries[s], ni = now.injuries && now.injuries[s];
      if (pi && ni && Array.isArray(pi.players) && Array.isArray(ni.players)) {
        var pn = {}, added = [], removed = [];
        pi.players.forEach(function (x) { pn[normName(x.name)] = x.status; });
        ni.players.forEach(function (x) { if (!(normName(x.name) in pn)) added.push(x.name + ' (' + x.status + ')'); else if (pn[normName(x.name)] !== x.status) added.push(x.name + ' (' + pn[normName(x.name)] + ' → ' + x.status + ')'); });
        var nn = {}; ni.players.forEach(function (x) { nn[normName(x.name)] = 1; });
        pi.players.forEach(function (x) { if (!nn[normName(x.name)]) removed.push(x.name); });
        if (added.length || removed.length) ch.push({ field: (s === 'home' ? now.game.home : now.game.away) + ' injury report', from: null, to: null, added: added, removed: removed });
      }
    });
    cmp('weather', prev.situation && prev.situation.weather && !prev.situation.weather.missing ? val(prev.situation.weather) : null, now.situation && now.situation.weather && !now.situation.weather.missing ? val(now.situation.weather) : null, function (w) { return w ? { temp_f: w.temp_f, wind_mph: w.wind_mph, precip_pct: w.precip_pct } : null; });
    cmp('data confidence', prev.confidence && prev.confidence.data && prev.confidence.data.band, now.confidence && now.confidence.data && now.confidence.data.band);
    var pd = (prev.drivers || []).slice(0, 3).map(function (d) { return d.id + ':' + d.favoured; }), nd = (now.drivers || []).slice(0, 3).map(function (d) { return d.id + ':' + d.favoured; });
    cmp('top matchup drivers', pd, nd);
    return { ok: true, from: { packet_id: prev.packet_id, built_at: prev.built_at }, to: { packet_id: now.packet_id, built_at: now.built_at }, changes: ch, unchanged: ch.length === 0,
      note: ch.length ? ch.length + ' field' + (ch.length > 1 ? 's' : '') + ' changed between the two snapshots.' : 'Nothing EdgeDesk measures changed between the two snapshots.' };
  }

  /* ====================================================================== */
  /* 9. THE ANALYSIS, ASSEMBLED, AND ITS PROMPT BLOCK                        */
  /* ====================================================================== */
  function analyse(o) {
    o = o || {};
    var p = o.packet || null; if (!p) return null;
    var sport = p.game && p.game.sport;
    var inter = interactions({ packet: p, identity: o.identity, sport: sport });
    var form = formAssessment({ packet: p, identity: o.identity, sport: sport });
    var sens = null;
    var c = p.comparison || {}, orient = c.orientation;
    if (orient && orient.side && orient.model_selection_line != null && orient.market_selection_line != null && p.model && p.model.home_line && !p.model.home_line.missing) {
      sens = lineSensitivity({ sport: sport, side: orient.side, selection: orient.selection, model_home_line: val(p.model.home_line), market_selection_line: orient.market_selection_line,
        cover_curve: o.cover_curve || null, key_mass: o.key_mass || null, odds_american: p.market && p.market.primary && p.market.primary.market === 'spreads' ? num(p.market.primary.odds_american) : null, validation: o.validation || null });
    }
    var alt = null;
    if (sens && o.line_override != null) alt = atLine(sens, o.line_override);
    var scen = scenarios({ packet: p, identity: o.identity, sport: sport, engine_scenarios: o.engine_scenarios || null, sensitivity: sens });
    var plan = investigationPlan({ packet: p, sport: sport });
    var whatChanges = [];
    (plan.gaps || []).slice(0, 3).forEach(function (g) { whatChanges.push('An answer to: ' + g.question + ' (' + g.why_it_matters + ').'); });
    if (sens && sens.ok && sens.key_numbers_crossed.length) whatChanges.push('The line crossing ' + sens.key_numbers_crossed.map(function (k) { return fmtLine(k.number); }).join(' or ') + ' — key numbers between the market and the model.');
    if (p.market && p.market.primary && p.market.primary.actionable === false) whatChanges.push('A fresh price: the captured one is past its freshness limit.');
    if (inter.counter_case) whatChanges.push(inter.counter_case.label + ' turning out wider than measured (' + inter.counter_case.favours + '’s side).');
    return {
      schema: SCHEMA, version: VERSION, built_at: new Date(o.now || Date.now()).toISOString(),
      interactions: inter, form: form, sensitivity: sens, alternative_line: alt, scenarios: scen, investigation_plan: plan,
      investigation: o.investigation || null, identity: o.identity ? { home: identitySummary(o.identity.home), away: identitySummary(o.identity.away) } : null,
      what_changes_it: whatChanges.slice(0, 5),
      diff: o.diff || null
    };
  }
  function identitySummary(t) {
    if (!t) return null;
    return { team: t.team, league: t.league, season: t.season, effective_from: t.effective_from || null, verified_at: t.verified_at || null,
      inferences: (t.inferences || []).slice(0, 6).map(function (i) { return { id: i.id, label: i.label, confidence: i.confidence, inputs: i.inputs }; }),
      qualitative: (t.qualitative || []).slice(0, 6), trend: t.trend && t.trend.early_vs_recent ? t.trend.early_vs_recent : null,
      quarterback: t.measured && t.measured.quarterback ? { starter: t.measured.quarterback.starter, backup: t.measured.quarterback.backup || null, epa: t.measured.quarterback.epa ? { career: t.measured.quarterback.epa.career, season: t.measured.quarterback.epa.season } : null } : null,
      coaching: t.measured ? t.measured.coaching || null : null, ol_continuity: t.measured ? t.measured.ol_continuity || null : null, talent: t.measured ? t.measured.talent || null : null, schedule: t.measured ? t.measured.schedule || null : null };
  }
  /** The compact block the writing model reads. Numbers here are the packet's; every one is quotable. */
  function promptBlock(A, p) {
    if (!A) return '';
    var L = [];
    L.push('ANALYST LAYER (' + A.schema + ') — EdgeDesk’s own reading of the packet. Quote it; do not extend it.');
    var I2 = A.interactions;
    if (I2) {
      L.push('DECISIVE MATCHUP FACTORS (' + I2.measured + ' measured, ' + I2.partial + ' partial, ' + I2.not_measured + ' not measured of ' + I2.modules.length + '):');
      I2.decisive_factors.forEach(function (d, i) { L.push('  ' + (i + 1) + '. ' + d.sentence + ' Evidence: ' + d.evidence.join('; ') + '. Mechanism: ' + clip(d.mechanism, 220) + ' Uncertainty ' + d.uncertainty + '.'); });
      if (I2.counter_case) L.push('STRONGEST COUNTER-CASE: ' + I2.counter_case.sentence + ' Evidence: ' + I2.counter_case.evidence.join('; ') + '. ' + clip(I2.counter_case.counter || '', 200));
      var nm = I2.modules.filter(function (m) { return m.status === 'NOT_MEASURED'; }).map(function (m) { return m.label; });
      if (nm.length) L.push('NOT MEASURED (say so if asked; never fill): ' + nm.join('; ') + '.');
    }
    if (A.sensitivity && A.sensitivity.ok) {
      var s = A.sensitivity, at = s.at_market;
      L.push('LINE SENSITIVITY (' + s.probability_status + ', basis ' + (s.basis || 'none') + '): ' + s.selection + ' at ' + fmtLine(s.market_selection_line) + ' against the model’s ' + fmtLine(s.model_selection_line) + ' (gap ' + fmtLine(s.gap_points) + ').'
        + (at && at.cover != null ? ' Model-conditional cover ' + pct(at.cover) + ', push ' + pct(at.push) + '.' : '')
        + (s.requires ? ' The price ' + fmtLine(s.requires.price) + ' requires ' + pct(s.requires.break_even_cover_probability) + ' to break even.' : '')
        + (s.key_numbers_crossed.length ? ' Key numbers between market and model: ' + s.key_numbers_crossed.map(function (k) { return fmtLine(k.number); }).join(', ') + '.' : '')
        + (s.probability_status === 'MODEL_CONDITIONAL' ? ' These are NOT betting probabilities and produce no expected value: the model does not beat the close.' : ''));
      var rows = s.ladder.filter(function (r) { return Math.abs(r.selection_line - s.market_selection_line) <= 3.01 && (Math.abs((r.selection_line - s.market_selection_line) % 1) < 1e-9 || r.key_number != null); });
      L.push('  Ladder: ' + rows.map(function (r) { return fmtLine(r.selection_line) + (r.cover != null ? ' cover ' + pct(r.cover, 0) : '') + (r.key_number != null ? ' (key)' : ''); }).join(' · '));
    } else if (A.sensitivity && !A.sensitivity.ok) L.push('LINE SENSITIVITY: not computed — ' + A.sensitivity.error + '.');
    if (A.alternative_line && A.alternative_line.ok) L.push('THE READER’S ALTERNATIVE LINE: ' + A.alternative_line.note + (A.alternative_line.change_in_cover_pp != null ? ' Model-conditional cover moves ' + fmtLine(A.alternative_line.change_in_cover_pp) + ' pp.' : ''));
    if (A.form && A.form.questions.length) { L.push('RECENT FORM:'); A.form.questions.slice(0, 4).forEach(function (q) { L.push('  - ' + q.answer); }); }
    if (A.scenarios && A.scenarios.items.length) { L.push('SCENARIOS (each labelled; none is the projection):'); A.scenarios.items.slice(0, 6).forEach(function (sc) { L.push('  - ' + sc.question + ' [' + sc.kind + '] ' + (sc.result && sc.result.home_line != null ? 'home line ' + fmtLine(sc.result.home_line) + ' (' + fmtLine(sc.result.delta_home_line) + ' vs baseline). ' : '') + clip(sc.result && sc.result.direction ? sc.result.direction : '', 220) + ' Assumes: ' + (sc.assumptions || []).slice(0, 1).join('') ); }); }
    if (A.investigation) {
      var inv = A.investigation;
      L.push('INVESTIGATION (what EdgeDesk went and checked this turn, ' + (inv.log || []).length + ' questions, ' + (inv.budget ? inv.budget.requests_used + ' requests, ' + inv.budget.ms_used + ' ms' : '') + '):');
      (inv.log || []).slice(0, 8).forEach(function (l) { L.push('  - ' + l.question + ' → ' + l.outcome + (l.finding ? ': ' + clip(l.finding, 200) : '') + (l.blocker ? ' (blocked: ' + clip(l.blocker, 160) + ')' : '') + (l.source ? ' [' + l.source + (l.observed_at ? ', ' + String(l.observed_at).slice(0, 16) + 'Z' : '') + ']' : '')); });
      L.push('  Say "EdgeDesk checked X" ONLY for questions listed here with outcome FOUND or UNAVAILABLE. Never claim a search that is not in this log.');
    }
    if (A.what_changes_it && A.what_changes_it.length) L.push('WHAT COULD CHANGE THE CONCLUSION: ' + A.what_changes_it.join(' '));
    if (A.diff && A.diff.ok) L.push('SINCE THE LAST SNAPSHOT (' + String(A.diff.from.built_at).slice(0, 16) + 'Z): ' + (A.diff.changes.length ? A.diff.changes.map(function (c) { return c.field + ': ' + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to) + (c.added ? ' added ' + c.added.join(', ') : '') + (c.removed ? ' removed ' + c.removed.join(', ') : ''); }).join('; ') : 'nothing measured changed.'));
    if (A.identity) {
      ['away', 'home'].forEach(function (s) { var t = A.identity[s]; if (!t) return; var inf = (t.inferences || []).map(function (i) { return i.label; }).join('; '); L.push('IDENTITY — ' + t.team + ' (' + t.season + ', verified ' + String(t.verified_at || '').slice(0, 10) + '): ' + (inf || 'no inferences') + (t.trend && t.trend.summary ? '. Trend: ' + t.trend.summary : '') + (t.quarterback && t.quarterback.backup ? '. Backup QB: ' + t.quarterback.backup.name : '') + '.'); });
    }
    return L.join('\n');
  }
  /** Findings the research critic does not cover: search claims the log does not support, scenarios presented as the projection. */
  function criticExtras(o) {
    o = o || {};
    var text = str(o.answer), A = o.analysis || null, findings = [];
    if (!text.trim()) return findings;
    var claims = text.match(/\b(EdgeDesk|I|we) (searched|checked|looked up|pulled|queried|went and (checked|looked)|investigated|verified)\b[^.]{0,80}/gi) || [];
    var logged = A && A.investigation && A.investigation.log ? A.investigation.log.filter(function (l) { return l.outcome === 'FOUND' || l.outcome === 'UNAVAILABLE' || l.outcome === 'BLOCKED'; }) : [];
    var found = logged.filter(function (l) { return l.outcome === 'FOUND'; });
    if (claims.length && !logged.length) findings.push({ code: 'SEARCH_CLAIM_UNSUPPORTED', severity: 'FAIL', detail: 'the answer claims a search or check ("' + clip(claims[0], 80) + '") but no investigation ran this turn' });
    /* a search that "confirmed" something needs a FOUND question on the same subject */
    claims.forEach(function (c) {
      var lc = c.toLowerCase();
      var confirms = /\b(confirm(ed|s|ing)?|verified|found (that|every|all|no)|shows?|report(s|ed)? that)\b/.test(lc);
      if (!confirms) return;
      var subject = /injur|starter|healthy|availability|report|line|quarterback|qb/.test(lc) ? 'availability' : /weather|forecast|wind/.test(lc) ? 'weather' : /price|odds|line moved|book/.test(lc) ? 'price' : null;
      var hit = found.some(function (l) { var g = str(l.gap); return subject === 'availability' ? /qb|ol_|personnel|starting/.test(g) : subject === 'weather' ? g === 'weather' : subject === 'price' ? g === 'current_price' : true; });
      if (!hit) findings.push({ code: 'SEARCH_CLAIM_UNSUPPORTED', severity: 'FAIL', detail: 'the answer says a check confirmed something ("' + clip(c, 80) + '") but no question on that subject came back FOUND this turn' });
    });
    /* a clean sheet asserted while availability is UNKNOWN */
    var av = (o.packet && o.packet.availability) || null;
    var unknownSide = av && ['home', 'away'].some(function (s2) { var st = av[s2] && av[s2].state; return !st || /UNKNOWN|NOT_DUE|LIMITED|UNAVAILABLE/.test(String(st)); });
    var inj = (o.packet && o.packet.injuries) || null;
    var listed = inj && ['home', 'away'].some(function (s2) { var r = inj[s2]; return r && Array.isArray(r.players) && r.players.some(function (x) { return /out|doubtful|questionable/i.test(str(x.status)); }); });
    if ((unknownSide || listed) && /\b(every(one| starter| player)|all (the )?starters|both (teams|sides)|no (injuries|injury concerns)|fully (healthy|available)|clean bill|at full strength)\b[^.]{0,40}\b(healthy|available|fit|cleared|in)\b|\b(is|are) (fully )?healthy\b/i.test(text)) findings.push({ code: 'CLEAN_SHEET_CLAIM', severity: 'FAIL', detail: unknownSide ? 'the answer asserts a clean availability sheet while at least one side\u2019s availability is UNKNOWN (not healthy: unknown)' : 'the answer asserts a clean availability sheet while the official report lists players out, doubtful or questionable' });
    /* a statistic EdgeDesk never measures, with a number attached */
    var nm = text.match(/\b(blitz(es|ed|ing)? (on|rate|at)|time to throw|seconds to throw|pressure rate|pressures? per|man coverage|zone coverage|cover \d|snap (count|share)|separation|yards? (before|after) contact|missed tackles?|target share|route participation|personnel grouping|1[12] personnel|box count|light boxes|stacked boxes)\b[^.]{0,40}?\d|\d[^.]{0,40}?\b(blitz(es|ed|ing)? (on|rate|at)|time to throw|seconds to throw|pressure rate|pressures? per|man coverage|zone coverage|snap (count|share)|separation|yards? (before|after) contact|missed tackles?|target share|route participation|personnel grouping|box count)\b/i);
    if (nm) findings.push({ code: 'NOT_MEASURED_STAT_CLAIM', severity: 'FAIL', detail: 'the answer quantifies a statistic EdgeDesk does not measure ("' + clip(nm[0], 80) + '"): coverage, blitz, pressure-rate, snap, tracking and personnel numbers are not in the data' });
    if (A && A.scenarios && A.scenarios.items.length) {
      var condLines = A.scenarios.items.filter(function (s) { return s.result && s.result.home_line != null; }).map(function (s) { return Math.abs(s.result.home_line); });
      condLines.forEach(function (n) {
        var re = new RegExp('\\b(model|projection|EdgeDesk) (projects|has|makes|says|puts)[^.]{0,40}\\b' + String(n).replace('.', '\\.') + '\\b', 'i');
        if (re.test(text) && !/\b(if|without|scenario|conditional|were|would)\b/i.test(text.match(re)[0])) findings.push({ code: 'SCENARIO_AS_PROJECTION', severity: 'FAIL', detail: 'a conditional scenario number (' + n + ') is written as the projection' });
      });
    }
    return findings;
  }

  /* ====================================================================== */
  /* 10. TOOLS — registered into EDRESEARCH.TOOLS so the same runTool,        */
  /*     budget and allowlist govern them                                    */
  /* ====================================================================== */
  function registerTools() {
    var Rk = R(); if (!Rk || !Rk.TOOLS || !Rk.T) return false;
    var T = Rk.T;
    function tool(name, description, input, run) { Rk.TOOLS[name] = { name: name, llm: true, category: 'data', description: description, input: input, output: T.any(), run: run }; }
    function A(ctx) { return ctx && ctx.packet && ctx.packet.analysis ? ctx.packet.analysis : null; }
    tool('get_matchup_interactions', 'The ten matchup interaction modules (pass rush v protection, QB under pressure, rushing v front, explosive pass v coverage, personnel v availability, tempo v depth, finishing, weather v style, special teams, backdoor exposure): evidence from both sides, mechanism, counter, uncertainty and whether the rating already prices it. Optional module id to fetch one.',
      T.obj({ module: T.opt(T.str({ max: 60 })) }), function (i, ctx) { var a = A(ctx); if (!a || !a.interactions) return { ok: false, error: 'no analysis on this turn', missing: ['analysis'] }; if (i && i.module) { var m = a.interactions.modules.filter(function (x) { return x.id === i.module; })[0]; return m ? { ok: true, module: m } : { ok: false, error: 'no module named ' + i.module, missing: [i.module] }; } return { ok: true, decisive_factors: a.interactions.decisive_factors, counter_case: a.interactions.counter_case, modules: a.interactions.modules.map(function (m) { return { id: m.id, label: m.label, status: m.status, advantage: m.advantage, in_model: m.in_model, uncertainty: m.uncertainty.level }; }), notes: [a.interactions.not_measured_note, a.interactions.double_count_note] }; });
    tool('get_line_sensitivity', 'Cover / push / lose at nearby lines under the model’s own residual distribution (model-conditional unless the validation record permits a probability), key numbers, and the probability the price requires. Pass line to read one alternative number from the selection’s side.',
      T.obj({ line: T.opt(T.num()) }), function (i, ctx) { var a = A(ctx); if (!a || !a.sensitivity) return { ok: false, error: 'no line sensitivity on this turn (no spread comparison)', missing: ['sensitivity'] }; if (i && i.line != null) return Object.assign({ ok: true }, atLine(a.sensitivity, i.line)); var s = a.sensitivity; return { ok: true, probability_status: s.probability_status, basis: s.basis, at_market: s.at_market, ladder: s.ladder.filter(function (r) { return Math.abs(r.selection_line - s.market_selection_line) <= 3.01; }), key_numbers_crossed: s.key_numbers_crossed, requires: s.requires, verdict: s.verdict, note: s.note }; });
    tool('run_matchup_scenario', 'One grounded scenario for this game: home_qb_out, away_qb_out, favourite_cannot_protect, slower_game, win_not_cover, carrying_assumption. Conditional estimates come from the validated engine re-run where one exists; otherwise the scenario is qualitative and says so.',
      T.obj({ scenario: T.enm(['home_qb_out', 'away_qb_out', 'favourite_cannot_protect', 'slower_game', 'win_not_cover', 'carrying_assumption']) }), function (i, ctx) { var a = A(ctx); if (!a || !a.scenarios) return { ok: false, error: 'no scenarios on this turn', missing: ['scenarios'] }; var s = a.scenarios.items.filter(function (x) { return x.id === i.scenario; })[0]; return s ? { ok: true, scenario: s, note: a.scenarios.note } : { ok: false, error: 'the scenario ' + i.scenario + ' is not available for this game', missing: [i.scenario] }; });
    tool('get_recent_form_assessment', 'Recent form read against opponent quality, garbage time, turnovers and explosive dependence, with the sample size, and the three questions: improved or weak opponents, does the dominant win translate, is the defensive reputation supported.',
      T.obj({}, { open: true }), function (i, ctx) { var a = A(ctx); return a && a.form ? { ok: true, form: a.form } : { ok: false, error: 'no form assessment on this turn', missing: ['form'] }; });
    tool('get_investigation_log', 'What EdgeDesk went and checked this turn: each question, the providers tried, the outcome (FOUND / UNAVAILABLE / BLOCKED / SKIPPED), the finding with its source and time, and the budget used. Anything not in this log was not checked.',
      T.obj({}, { open: true }), function (i, ctx) { var a = A(ctx); return a && a.investigation ? { ok: true, investigation: a.investigation } : { ok: false, error: 'no investigation ran this turn', missing: ['investigation'] }; });
    tool('get_team_identity', 'One side’s identity profile: measured statistics, sourced qualitative observations and analytical inferences kept apart, with season, effective dates and last verification. Input: {side}.',
      T.obj({ side: T.enm(['home', 'away']) }), function (i, ctx) { var a = A(ctx); var t = a && a.identity ? a.identity[i.side] : null; return t ? { ok: true, side: i.side, identity: t } : { ok: false, error: 'no identity profile on file for the ' + i.side + ' side', missing: ['identity'] }; });
    tool('get_what_changed', 'The diff between this turn’s packet and the previous snapshot of the same game: label, model line, price, availability, starters, injury report, weather, drivers.',
      T.obj({}, { open: true }), function (i, ctx) { var a = A(ctx); return a && a.diff ? { ok: true, diff: a.diff } : { ok: false, error: 'no previous snapshot of this game is on file to compare against', missing: ['previous_packet'] }; });
    return true;
  }
  var TOOL_NAMES = ['get_matchup_interactions', 'get_line_sensitivity', 'run_matchup_scenario', 'get_recent_form_assessment', 'get_investigation_log', 'get_team_identity', 'get_what_changed'];

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, KEY_NUMBERS: KEY_NUMBERS, UNIT: UNIT, IN_MODEL: IN_MODEL, TOOL_NAMES: TOOL_NAMES, SOURCE_TIER: SOURCE_TIER,
    coverFromPmf: coverFromPmf, lineSensitivity: lineSensitivity, atLine: atLine,
    interactions: interactions, formAssessment: formAssessment, scenarios: scenarios,
    followUp: followUp, conversationState: conversationState,
    investigationPlan: investigationPlan, resolveConflicts: resolveConflicts, groupsOf: groupsOf,
    packetDiff: packetDiff, analyse: analyse, promptBlock: promptBlock, criticExtras: criticExtras, registerTools: registerTools
  };
});
/*__EDANALYST_END__*/
