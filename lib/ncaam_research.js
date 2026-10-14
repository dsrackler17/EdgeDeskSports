/* ===========================================================================
   EdgeDesk men's college basketball — the research math shared by the Node
   build (basketball/ncaam_research) and the research pages (research/ncaam).

   Three layers, kept apart on purpose:

   1. SCENARIOS (conditional, never confirmed availability)
      redistribute(rotation, changes) moves minutes, not points: a player who
      is out, capped, in foul trouble, or a transfer who joins, changes who
      plays the 200 player-minutes of a regulation game. Freed minutes go to
      the remaining players in proportion to their usual minutes and their
      positional similarity, each capped at what he has actually played in a
      game this season. teamDelta() then prices the change with each player's
      on-court impact (points per 100 possessions):

        delta = sum_i (minutes'_i - baseline_i) / 40 * impact_i

      The baseline is the minutes distribution the team rating already
      contains (season average per team game, absences included), so a
      player's value is never counted twice: once in the team rating and
      again on top of it.

   2. THE MATCHUP (independent of any price)
      project(home, away, opts) returns possessions, points per 100 for both
      offenses, expected points, margin and total with calibrated normal
      distributions, the win probability (overtime included) and integer
      score-margin probabilities, from the team ratings, venue, the calibration
      learned out of sample and any scenario deltas.

   3. THE MARKET (optional, separate, allowed to say PASS)
      compareMarket(projection, quotes, opts) prices exact quotes (moneyline,
      spread with pushes, total with pushes; overtime included) against the
      projection, de-vigs two-way prices for reference, and returns PASS with
      every failed gate: stale or missing price, suspended market, unsupported
      market (player props are not validated here), unconfirmed availability,
      no market validation, insufficient data. Missing prices never disable
      the research above; they only empty this section.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NCAAMResearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REG_MIN = 40; var TEAM_MIN = 200;

  /* ---------------------------------------------------------------- numerics */
  function erf(x) { var s = x < 0 ? -1 : 1; x = Math.abs(x); var t = 1 / (1 + 0.3275911 * x); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
  function Phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  function round(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k == null ? 1 : k); return Math.round(v * f) / f; }

  /* ---------------------------------------------------------------- 1. scenarios */
  function affinity(a, b) {
    if (!a || !b) return 1;
    if (a === b) return 1;
    var pair = [a, b].sort().join('');
    if (pair === 'FG' || pair === 'CF') return 0.5;
    if (pair === 'CG') return 0.2;
    return 0.6;
  }

  /**
   * rotation: [{ id, name, pos, baseline (season avg minutes per team game, absences included),
   *              expected (minutes when available), cap (max minutes in a game), o, d, sd_o, sd_d }]
   * changes:  { out: [id], cap: {id: minutes}, add: [{id, name, pos, expected, cap, o, d, sd_o, sd_d}], bench_share: +x (fraction of starter minutes moved to the bench), closing: [ids] }
   * returns   { players: [{id, name, baseline, minutes, delta_minutes}], unassigned }
   */
  function redistribute(rotation, changes) {
    changes = changes || {};
    var outSet = {}; (changes.out || []).forEach(function (id) { outSet[id] = true; });
    var caps = changes.cap || {};
    var list = rotation.map(function (p) { return Object.assign({}, p); }).concat((changes.add || []).map(function (p) { return Object.assign({ added: true, baseline: 0 }, p); }));
    // the usual rotation, everyone available, scaled once to the team's 200 minutes; absences and caps then free minutes
    var usual = list.filter(function (p) { return !p.added; }).reduce(function (s, p) { return s + (p.expected || 0); }, 0);
    var scale = usual > 0 ? Math.max(0.8, Math.min(1.25, TEAM_MIN / usual)) : 1;
    list.forEach(function (p) {
      p.cap_eff = Math.min(REG_MIN, Math.max(p.cap || 0, p.expected || 0, 4));
      if (caps[p.id] != null) p.cap_eff = Math.min(p.cap_eff, caps[p.id]);
      p.minutes = outSet[p.id] ? 0 : Math.min(p.cap_eff, (p.expected || 0) * (p.added ? 1 : scale));
    });
    if (changes.bench_share) {
      var starters = list.filter(function (p) { return !outSet[p.id] && p.starter; });
      var moved = 0; starters.forEach(function (p) { var m = p.minutes * changes.bench_share; p.minutes -= m; moved += m; });
      var bench = list.filter(function (p) { return !outSet[p.id] && !p.starter; });
      fill(bench, moved, null);
    }
    if (changes.closing && changes.closing.length) {
      var close = {}; changes.closing.forEach(function (id) { close[id] = true; });
      var extra = 0;
      list.forEach(function (p) { if (close[p.id] && !outSet[p.id]) { var add = Math.min(p.cap_eff, p.minutes + 5 * (1 - p.minutes / REG_MIN)) - p.minutes; if (add > 0) { p.minutes += add; extra += add; } } });
      var others = list.filter(function (p) { return !close[p.id] && !outSet[p.id] && p.minutes > 0; });
      var tot = others.reduce(function (s, p) { return s + p.minutes; }, 0);
      others.forEach(function (p) { p.minutes -= extra * (p.minutes / tot); });
    }
    var total = list.reduce(function (s, p) { return s + p.minutes; }, 0);
    var freed = TEAM_MIN - total;
    var outPos = list.filter(function (p) { return outSet[p.id] || (caps[p.id] != null); }).map(function (p) { return p.pos; });
    var left = fill(list.filter(function (p) { return !outSet[p.id]; }), freed, outPos);
    return {
      players: list.map(function (p) { return { id: p.id, name: p.name, pos: p.pos, baseline: p.baseline || 0, minutes: p.minutes, delta_minutes: p.minutes - (p.baseline || 0), added: !!p.added, out: !!outSet[p.id], o: p.o, d: p.d, sd_o: p.sd_o, sd_d: p.sd_d }; }),
      unassigned: left,
    };
  }

  /* proportional water-filling with per-player caps; returns the minutes that did not fit */
  function fill(players, amount, fromPos) {
    var left = amount; var guard = 0;
    while (Math.abs(left) > 1e-6 && guard++ < 50) {
      var room = players.filter(function (p) { return left > 0 ? p.minutes < p.cap_eff - 1e-9 : p.minutes > 1e-9; });
      if (!room.length) break;
      var w = room.map(function (p) {
        var aff = fromPos && fromPos.length ? Math.max.apply(null, fromPos.map(function (q) { return affinity(p.pos, q); })) : 1;
        return Math.max(0.5, p.minutes) * aff;
      });
      var W = w.reduce(function (s, x) { return s + x; }, 0); var used = 0;
      room.forEach(function (p, i) {
        var share = left * w[i] / W;
        var nm = left > 0 ? Math.min(p.cap_eff, p.minutes + share) : Math.max(0, p.minutes + share);
        used += nm - p.minutes; p.minutes = nm;
      });
      left -= used;
    }
    return left;
  }

  /** price a minutes change with on-court impact; returns per-100 deltas and their SD (independence approximation) */
  function teamDelta(rotation, result) {
    var by = {}; rotation.forEach(function (p) { by[p.id] = p; });
    var o = 0; var d = 0; var vo = 0; var vd = 0; var rows = [];
    result.players.forEach(function (p) {
      var src = by[p.id] || p; var f = (p.minutes - p.baseline) / REG_MIN;
      if (!f) return;
      var io = src.o || 0; var id = src.d || 0;
      o += f * io; d += f * id; vo += f * f * Math.pow(src.sd_o || 0, 2); vd += f * f * Math.pow(src.sd_d || 0, 2);
      rows.push({ id: p.id, name: p.name, delta_minutes: round(p.minutes - p.baseline, 1), net_effect: round(f * (io + id), 2) });
    });
    return { off: o, def: d, net: o + d, sd_off: Math.sqrt(vo), sd_def: Math.sqrt(vd), sd_net: Math.sqrt(vo + vd), contributions: rows.sort(function (a, b) { return Math.abs(b.net_effect) - Math.abs(a.net_effect); }) };
  }

  /**
   * delta          change against the minutes the team rating contains (season average, absences included):
   *                what the validation priced when availability was known
   * delta_vs_usual change against the usual rotation with everyone available: zero when nothing changes;
   *                used for "if he is out", foul trouble and the matchup conditions
   */
  function scenario(rotation, changes) {
    var r = redistribute(rotation, changes);
    var usual = redistribute(rotation, {}); var um = {}; usual.players.forEach(function (p) { um[p.id] = p.minutes; });
    var rebased = { players: r.players.map(function (p) { return Object.assign({}, p, { baseline: p.added ? 0 : um[p.id] }); }), unassigned: r.unassigned };
    var rebasedRot = rotation.map(function (p) { return Object.assign({}, p, { baseline: um[p.id] }); });
    return { minutes: r, delta: teamDelta(rotation, r), delta_vs_usual: teamDelta(rebasedRot, rebased), usual: usual, full_strength_vs_rating: teamDelta(rotation, usual) };
  }

  /* ---------------------------------------------------------------- 2. the matchup */
  /**
   * home/away: matchup ratings { off, allow, pace_off, pace_allow, var_off, var_allow } (relative to league)
   * league: { mu, eta, tau, cal: { margin:{a,b}, total:{a,b}, var_margin:{s0,k}, var_total:{s0,k}, rho } }
   * opts: { neutral, delta_home: {off, def, sd_net}, delta_away }
   */
  function project(home, away, league, opts) {
    opts = opts || {};
    var v = opts.neutral ? 0 : 1; var H = home; var A = away;
    var dh = opts.delta_home || { off: 0, def: 0, sd_net: 0 }; var da = opts.delta_away || { off: 0, def: 0, sd_net: 0 };
    var pppH = league.mu + H.off + A.allow + league.eta * v + dh.off - da.def;
    var pppA = league.mu + A.off + H.allow - league.eta * v + da.off - dh.def;
    var tempo = league.tau + 0.5 * (H.pace_off + A.pace_allow + A.pace_off + H.pace_allow);
    var rawMargin = tempo * (pppH - pppA) / 100; var rawTotal = tempo * (pppH + pppA) / 100;
    var varParam = Math.pow(tempo / 100, 2) * ((H.var_off || 0) + (H.var_allow || 0) + (A.var_off || 0) + (A.var_allow || 0));
    var varScen = Math.pow(tempo / 100, 2) * (Math.pow(dh.sd_net || 0, 2) + Math.pow(da.sd_net || 0, 2));
    var c = league.cal;
    var mMu = c.margin.a + c.margin.b * rawMargin; var tMu = c.total.a + c.total.b * rawTotal;
    var mSd = Math.sqrt(c.var_margin.s0 + c.var_margin.k * varParam + varScen);
    var tSd = Math.sqrt(c.var_total.s0 + c.var_total.k * varParam + varScen);
    var pHome = Phi(mMu / mSd);
    return {
      possessions: tempo, ppp_home: pppH, ppp_away: pppA,
      points_home: (tMu + mMu) / 2, points_away: (tMu - mMu) / 2,
      margin: { mean: mMu, sd: mSd, p10: mMu - 1.2816 * mSd, p90: mMu + 1.2816 * mSd },
      total: { mean: tMu, sd: tSd, p10: tMu - 1.2816 * tSd, p90: tMu + 1.2816 * tSd },
      win_home: pHome, win_away: 1 - pHome, rho: c.rho,
      fair_spread_home: -mMu, fair_total: tMu,
      inputs: { raw_margin: rawMargin, raw_total: rawTotal, var_param: varParam, var_scenario: varScen, neutral: !!opts.neutral },
    };
  }

  /* integer-margin probabilities: the normal mass on each integer, regulation ties resolved half each way (overtime) */
  function marginPmf(proj, lo, hi) {
    var m = proj.margin.mean; var s = proj.margin.sd; var out = {};
    for (var k = lo; k <= hi; k++) out[k] = Phi((k + 0.5 - m) / s) - Phi((k - 0.5 - m) / s);
    var tie = out[0] || 0; out[0] = 0; out[1] = (out[1] || 0) + tie / 2; out[-1] = (out[-1] || 0) + tie / 2;
    return out;
  }
  function totalPmf(proj, lo, hi) { var m = proj.total.mean; var s = proj.total.sd; var out = {}; for (var k = lo; k <= hi; k++) out[k] = Phi((k + 0.5 - m) / s) - Phi((k - 0.5 - m) / s); return out; }

  /** P(win), P(push), P(lose) for one side of an exact market (overtime included) */
  function outcomeProbs(proj, market, side, line) {
    if (market === 'moneyline') { var p = side === 'home' ? proj.win_home : proj.win_away; return { win: p, push: 0, lose: 1 - p }; }
    if (market === 'spread') {
      // each side carries its own handicap: home -4.5 covers if margin - 4.5 > 0; away +4.5 covers if -margin + 4.5 > 0
      var pm = marginPmf(proj, -90, 90); var w = 0; var pu = 0; var l = 0;
      for (var k in pm) { var adj = (side === 'home' ? Number(k) : -Number(k)) + line; if (adj > 1e-9) w += pm[k]; else if (Math.abs(adj) <= 1e-9) pu += pm[k]; else l += pm[k]; }
      return { win: w, push: pu, lose: l };
    }
    if (market === 'total') {
      var tp = totalPmf(proj, 40, 260); var wo = 0; var po = 0; var lo = 0;
      for (var t in tp) { var diff = Number(t) - line; var over = side === 'over'; if (Math.abs(diff) <= 1e-9) po += tp[t]; else if ((diff > 0) === over) wo += tp[t]; else lo += tp[t]; }
      return { win: wo, push: po, lose: lo };
    }
    return null;
  }

  /* ---------------------------------------------------------------- 3. the market */
  function toDecimal(q) {
    if (q.decimal != null) return Number(q.decimal);
    var a = Number(q.american); if (!isFinite(a) || a === 0) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
  }
  function devigTwoWay(d1, d2) { var a = 1 / d1; var b = 1 / d2; var s = a + b; return { p1: a / s, p2: b / s, overround: s - 1 }; }

  var SUPPORTED = { moneyline: true, spread: true, total: true };

  /**
   * quotes: [{ provider, book, game_id, market, side, line, american|decimal, quote_at, observed_at, status, limit, rules: { overtime_included } }]
   * opts:   { now, max_age_min (15), min_ev (0.02), availability_confirmed (false), market_validated (false), data_ok (true), identity_ok (true), settlement_ok }
   */
  function compareMarket(proj, quotes, opts) {
    opts = opts || {};
    if (!quotes || !quotes.length) return { status: 'UNAVAILABLE', message: 'market comparison unavailable', reason: opts.unavailable_reason || 'no price for this game from any configured source', rows: [] };
    var now = opts.now != null ? opts.now : Date.now(); var maxAge = (opts.max_age_min || 15) * 60e3;
    var rows = quotes.map(function (q) {
      var gates = [];
      var dec = toDecimal(q);
      if (!SUPPORTED[q.market]) gates.push('UNSUPPORTED_MARKET: ' + q.market + ' (player and derivative markets need their own validated model)');
      if (!dec || dec <= 1) gates.push('INVALID_PRICE');
      var seen = Date.parse(q.observed_at || q.quote_at || '');
      if (!isFinite(seen)) gates.push('NO_QUOTE_TIME'); else if (now - seen > maxAge) gates.push('STALE_PRICE: observed ' + Math.round((now - seen) / 60e3) + ' min ago');
      if (q.status && q.status !== 'open') gates.push('MARKET_' + String(q.status).toUpperCase());
      if (q.expires_at && Date.parse(q.expires_at) < now) gates.push('QUOTE_EXPIRED');
      if (!q.rules || q.rules.overtime_included !== true) gates.push('SETTLEMENT_RULES_UNKNOWN: overtime inclusion not stated by the book');
      if (!opts.availability_confirmed) gates.push('AVAILABILITY_UNCONFIRMED: no confirmed availability feed; the projection assumes the usual rotation');
      if (!opts.market_validated) gates.push('NOT_MARKET_VALIDATED: no timestamped price archive has been used to test the model against the market');
      if (opts.data_ok === false) gates.push('INSUFFICIENT_DATA');
      if (opts.identity_ok === false) gates.push('IDENTITY_UNVERIFIED');
      var pr = SUPPORTED[q.market] && dec ? outcomeProbs(proj, q.market, q.side, Number(q.line)) : null;
      var ev = pr ? pr.win * (dec - 1) - pr.lose : null;
      // uncertainty-adjusted: the same EV with the margin/total SD widened by the scenario and parameter terms already inside proj; require min_ev
      if (ev != null && ev < (opts.min_ev != null ? opts.min_ev : 0.02)) gates.push('EXPECTED_RETURN_BELOW_BAR');
      return {
        book: q.book, provider: q.provider, market: q.market, side: q.side, line: q.line, decimal: dec,
        model: pr ? { win: round(pr.win, 4), push: round(pr.push, 4), lose: round(pr.lose, 4) } : null,
        breakeven: dec ? round(1 / dec, 4) : null, expected_return_per_unit: ev == null ? null : round(ev, 4),
        decision: gates.length ? 'PASS' : 'ELIGIBLE', gates: gates,
      };
    });
    // reference: de-vigged two-way prices per book/market/line
    var ref = [];
    var key = function (q) { return [q.book, q.market, q.market === 'moneyline' ? '' : Math.abs(Number(q.line))].join('|'); };
    var groups = {}; quotes.forEach(function (q) { (groups[key(q)] = groups[key(q)] || []).push(q); });
    Object.keys(groups).forEach(function (k) { var g = groups[k]; if (g.length !== 2) return; var a = toDecimal(g[0]); var b = toDecimal(g[1]); if (!a || !b) return; var dv = devigTwoWay(a, b); ref.push({ book: g[0].book, market: g[0].market, line: g[0].line, side_1: g[0].side, no_vig_1: round(dv.p1, 4), side_2: g[1].side, no_vig_2: round(dv.p2, 4), overround: round(dv.overround, 4), method: 'multiplicative' }); });
    var eligible = rows.filter(function (r) { return r.decision === 'ELIGIBLE'; });
    return { status: 'COMPARED', decision: eligible.length ? 'ELIGIBLE_FOUND' : 'PASS', rows: rows, no_vig_reference: ref };
  }

  /* ---------------------------------------------------------------- the matchup report */
  var FACTOR_LINES = [
    { key: 'efg', label: 'Effective FG%', w: 'efg', fmt: 'pct' },
    { key: 'tov_pct', label: 'Turnover %', w: 'tov_pct', fmt: 'pct' },
    { key: 'orb_pct', label: 'Offensive rebound %', w: 'orb_pct', fmt: 'pct' },
    { key: 'ftr', label: 'Free-throw rate (FTA/FGA)', w: 'ftr', fmt: 'pct' },
  ];
  var PROFILE_LINES = [
    { key: 'three_rate', label: '3-point attempt share', pair: 'three_rate' }, { key: 'rim_rate', label: 'Rim attempt share', pair: 'rim_rate' },
    { key: 'mid_rate', label: 'Mid-range attempt share', pair: null }, { key: 'three_pct', label: '3-point FG%', pair: null },
    { key: 'rim_pct', label: 'Rim FG%', pair: null }, { key: 'stl_pct', label: 'Steal %', pair: null }, { key: 'blk_pct', label: 'Block % of 2PA', pair: null },
    { key: 'ast_share', label: 'Assisted share of makes', pair: null }, { key: 'sec_per_poss', label: 'Seconds per possession', pair: null },
  ];

  function factorProjection(offTeam, defTeam, key, league) {
    var o = offTeam.style && offTeam.style[key] && offTeam.style[key].off; var d = defTeam.style && defTeam.style[key] && defTeam.style[key].def;
    var lg = league.factor_league[key];
    if (!o || lg == null) return null;
    var dv = d ? d.sustainable : lg;
    return { offense: o.sustainable, defense: d ? d.sustainable : null, league: lg, projected: o.sustainable + dv - lg, offense_observed: o.observed, defense_observed: d ? d.observed : null };
  }

  function direction(offTeam, defTeam, league, proj, isHome) {
    var lines = FACTOR_LINES.map(function (f) {
      var p = factorProjection(offTeam, defTeam, f.key, league); if (!p) return null;
      var w = league.four_factor_weights[f.w];
      return { key: f.key, label: f.label, offense: p.offense, defense_allows: p.defense, league: p.league, projected: p.projected, points_per_100_vs_league: w * (p.projected - p.league) };
    }).filter(Boolean);
    var implied = lines.reduce(function (s, l) { return s + l.points_per_100_vs_league; }, 0);
    var profile = PROFILE_LINES.map(function (f) { var p = factorProjection(offTeam, defTeam, f.key, league); if (!p) return null; return { key: f.key, label: f.label, offense: p.offense, defense_allows: p.defense, league: p.league, projected: p.projected, interaction: f.pair ? (league.interactions && league.interactions[f.pair]) || 'UNTESTED' : 'UNTESTED' }; }).filter(Boolean);
    return {
      offense: offTeam.team.short, defense: defTeam.team.short,
      adj_offense: offTeam.rating.adj_o, adj_defense_of_opponent: defTeam.rating.adj_d,
      projected_points_per_100: isHome ? proj.ppp_home : proj.ppp_away,
      four_factors: lines, factor_implied_points_per_100_vs_league: implied, shot_and_style_profile: profile,
      note: 'Projected rates are additive (offense + defense - league): a description of the matchup on the scale of each rate. The score projection comes from the efficiency ratings; style terms add no points because no style interaction passed validation.',
    };
  }

  function topPlayers(team, n) {
    return (team.players || []).filter(function (p) { return p.impact && p.minutes && p.minutes.expected > 0; })
      .sort(function (a, b) { return (b.contribution ? b.contribution.points_per_game : 0) - (a.contribution ? a.contribution.points_per_game : 0); }).slice(0, n || 5)
      .map(function (p) { return { id: p.id, name: p.name, pos: p.pos, expected_minutes: p.minutes.expected, impact_net: p.impact.net, impact_sd: p.impact.sd_net, contribution_ppg: p.contribution ? p.contribution.points_per_game : null, replacement_cost_ppg: p.replacement ? p.replacement.points_per_game : null, separable: p.separability ? p.separability.separable : null, roles: p.roles || [] }; });
  }

  function conditions(home, away, league, base, opts) {
    var out = [];
    [[home, 'home'], [away, 'away']].forEach(function (pair) {
      var t = pair[0]; var side = pair[1];
      var rot = t.scenario_rotation || []; if (!rot.length) return;
      var key = rot.slice().sort(function (a, b) { return (b.expected * ((b.o || 0) + (b.d || 0))) - (a.expected * ((a.o || 0) + (a.d || 0))); }).slice(0, 2);
      key.forEach(function (p) {
        var sc = scenario(rot, { out: [p.id] });
        var o = {}; o['delta_' + side] = sc.delta_vs_usual;
        var pr = project(home.matchup_rating, away.matchup_rating, league, Object.assign({}, opts, o));
        out.push({ kind: 'player_out', team: t.team.short, player: p.name, conditional: true, margin_change_home: pr.margin.mean - base.margin.mean, win_home_after: pr.win_home, sd_added: Math.sqrt(Math.max(0, pr.margin.sd * pr.margin.sd - base.margin.sd * base.margin.sd)) });
      });
      var creator = rot.filter(function (p) { return (p.roles || []).indexOf('creator') >= 0; }).sort(function (a, b) { return b.expected - a.expected; })[0];
      if (creator && creator.expected > 24) {
        var cap = {}; cap[creator.id] = 22; var sc2 = scenario(rot, { cap: cap }); var o2 = {}; o2['delta_' + side] = sc2.delta_vs_usual;
        var pr2 = project(home.matchup_rating, away.matchup_rating, league, Object.assign({}, opts, o2));
        out.push({ kind: 'foul_trouble', team: t.team.short, player: creator.name, minutes_cap: 22, conditional: true, margin_change_home: pr2.margin.mean - base.margin.mean, win_home_after: pr2.win_home });
      }
    });
    out.push({ kind: 'pace', detail: 'four possessions more or fewer than projected', total_change: 4 * (base.ppp_home + base.ppp_away) / 100 });
    [[home, away], [away, home]].forEach(function (pr) {
      var sv = pr[0].style_variance; if (!sv || sv.three_pct_game_sd == null) return;
      var att = pr[0].style && pr[0].style.three_rate ? pr[0].style.three_rate.off.sustainable : null;
      var fga = pr[0].box_per_game ? pr[0].box_per_game.fga : null;
      if (att == null || fga == null) return;
      out.push({ kind: 'three_point_variance', team: pr[0].team.short, detail: 'one game-level standard deviation of its 3-point percentage', points: 3 * sv.three_pct_game_sd * att * fga });
    });
    return out;
  }

  /** a full research report for one game; home/away are published team documents, league the published league document */
  function matchupReport(home, away, league, opts) {
    opts = opts || {};
    var base = project(home.matchup_rating, away.matchup_rating, league, { neutral: !!opts.neutral });
    var hasScen = opts.delta_home || opts.delta_away;
    var proj = hasScen ? project(home.matchup_rating, away.matchup_rating, league, opts) : base;
    var pmf = marginPmf(proj, -60, 60);
    return {
      teams: { home: home.team, away: away.team, venue: opts.neutral ? 'neutral' : 'home: ' + home.team.short },
      as_of: opts.as_of || home.as_of || null,
      baseline: {
        home: pick(home.rating), away: pick(away.rating),
        net_difference: home.rating.net - away.rating.net, net_difference_sd: Math.sqrt(Math.pow(home.rating.sd_net || 0, 2) + Math.pow(away.rating.sd_net || 0, 2)),
        venue_points: opts.neutral ? 0 : 2 * league.eta * proj.possessions / 100,
      },
      projection: {
        possessions: proj.possessions, points_home: proj.points_home, points_away: proj.points_away,
        margin_home: proj.margin, total: proj.total, win_home: proj.win_home, win_away: proj.win_away,
        fair_spread_home: proj.fair_spread_home, fair_total: proj.fair_total,
        margin_probabilities: { home_by_10_plus: sumPmf(pmf, 10, 60), home_by_1_9: sumPmf(pmf, 1, 9), away_by_1_9: sumPmf(pmf, -9, -1), away_by_10_plus: sumPmf(pmf, -60, -10) },
        scenario_applied: !!hasScen, baseline_without_scenario: hasScen ? { margin_home: base.margin.mean, win_home: base.win_home } : null,
      },
      tempo: { projected_possessions: proj.possessions, home: { tempo: home.rating.tempo, sec_per_poss_off: styleVal(home, 'sec_per_poss', 'off'), sec_per_poss_def: styleVal(home, 'sec_per_poss', 'def') }, away: { tempo: away.rating.tempo, sec_per_poss_off: styleVal(away, 'sec_per_poss', 'off'), sec_per_poss_def: styleVal(away, 'sec_per_poss', 'def') } },
      home_offense_vs_away_defense: direction(home, away, league, proj, true),
      away_offense_vs_home_defense: direction(away, home, league, proj, false),
      players: { home: topPlayers(home, 5), away: topPlayers(away, 5) },
      lineups: { home: (home.lineups || []).slice(0, 3), away: (away.lineups || []).slice(0, 3) },
      context: {
        venue: opts.neutral ? 'neutral site' : home.team.short + ' at home',
        rest_days: opts.rest || null,
        depth: { home: home.rotation_summary || null, away: away.rotation_summary || null },
        personnel: opts.availability_note || 'No confirmed availability or starting-lineup feed exists: the projection assumes each team\'s usual rotation as of the data date.',
      },
      conditions: conditions(home, away, league, proj, { neutral: !!opts.neutral }),
      interactions: league.interactions_summary || null,
      assumptions: [
        'Ratings are opponent-adjusted points per 100 possessions against an average D1 team; uncertainty is the calibrated out-of-sample spread.',
        'Win probability includes overtime; margin and total are normal distributions calibrated on earlier out-of-sample games.',
        'Player scenarios move minutes between players and price them with on-court impact estimates; they are conditional estimates, not confirmed availability, and did not improve game predictions in validation.',
        'Style comparisons are descriptive; no style interaction is added to the score because none passed validation.',
      ],
    };
  }
  function pick(r) { return { adj_o: r.adj_o, adj_d: r.adj_d, net: r.net, tempo: r.tempo, sd_net: r.sd_net, rank_net: r.rank_net, games: r.games }; }
  function styleVal(t, k, role) { return t.style && t.style[k] && t.style[k][role] ? t.style[k][role].sustainable : null; }
  function sumPmf(pmf, lo, hi) { var s = 0; for (var k = lo; k <= hi; k++) s += pmf[k] || 0; return s; }

  return { matchupReport: matchupReport, project: project, marginPmf: marginPmf, totalPmf: totalPmf, outcomeProbs: outcomeProbs, redistribute: redistribute, teamDelta: teamDelta, scenario: scenario, compareMarket: compareMarket, devigTwoWay: devigTwoWay, toDecimal: toDecimal, Phi: Phi, round: round, affinity: affinity, REG_MIN: REG_MIN, TEAM_MIN: TEAM_MIN };
});
