/* ===========================================================================
   EDGEDESK BANKROLL — units to dollars, and the exposure of a card.
   docs/bettor-decision/DESIGN.md §5, §9

   UNITS ARE EDGEDESK'S; DOLLARS ARE THE READER'S.
     The decision engine classifies a wager in units (0.25 / 0.50 / 0.75 /
     1.00U). This file only converts units to the reader's dollars. A bankroll
     never changes a unit classification.

     default          1 unit = 1% of bankroll   ($2,500 → $25)
     fixed            a custom unit amount the reader types
     no bankroll      units only; the page asks for a bankroll or a unit

   EXPOSURE
     Total recommended units and dollars, grouped by sport, kickoff window,
     game, team and market, with correlation notes. A guardrail WARNS when
     active exposure exceeds the reader's maximum (default 5U); it suppresses
     nothing unless the reader turned exposure limiting on.

   NEVER
     - size from results: there is no input for wins, losses, streaks or
       drawdown. No martingale, no loss-chasing.
     - store anything itself: the page stores settings (localStorage when
       signed out, public.bankroll_settings when signed in).

   Browser: window.EDBankroll. Node: require('./edgedesk_bankroll.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EDBankroll = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_bankroll_v1';
  var DEFAULTS = { bankroll_amount: null, unit_mode: 'percent', unit_percent: 0.01, base_unit_amount: null, max_active_units: 5, exposure_limit_enabled: false, beginner_mode: false };
  var LOCAL_KEY = 'edgedesk_bankroll_v1';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(String(x).replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; }
  function cents(x) { return isNum(x) ? Math.round(x * 100) / 100 : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  /* the reader's settings, normalised; anything invalid falls back to the
     default rather than to a guess */
  function normalize(s) {
    s = s || {};
    var o = {}, k;
    for (k in DEFAULTS) if (has(DEFAULTS, k)) o[k] = DEFAULTS[k];
    var b = num(s.bankroll_amount != null ? s.bankroll_amount : s.bankroll);
    o.bankroll_amount = b != null && b > 0 && b < 1e9 ? cents(b) : null;
    var mode = s.unit_mode === 'fixed' || s.unit_mode === 'percent' ? s.unit_mode : (num(s.custom_unit) > 0 ? 'fixed' : DEFAULTS.unit_mode);
    o.unit_mode = mode;
    var pct = num(s.unit_percent);
    if (pct != null && pct >= 1 && pct <= 10) pct = pct / 100;          /* "1" means 1% */
    o.unit_percent = pct != null && pct > 0 && pct <= 0.10 ? pct : DEFAULTS.unit_percent;
    var u = num(s.base_unit_amount != null ? s.base_unit_amount : s.custom_unit);
    o.base_unit_amount = u != null && u > 0 && u < 1e8 ? cents(u) : null;
    var mx = num(s.max_active_units);
    o.max_active_units = mx != null && mx > 0 && mx <= 100 ? mx : DEFAULTS.max_active_units;
    o.exposure_limit_enabled = s.exposure_limit_enabled === true;
    o.beginner_mode = s.beginner_mode === true;
    return o;
  }
  /* the dollar value of one unit, with where it came from */
  function unitValue(s) {
    var o = normalize(s);
    if (o.unit_mode === 'fixed' && o.base_unit_amount != null) return { unit: o.base_unit_amount, basis: 'CUSTOM', text: 'your custom $' + fmt(o.base_unit_amount) + ' unit' };
    if (o.bankroll_amount != null) {
      var u = cents(o.bankroll_amount * o.unit_percent);
      return { unit: u, basis: 'PERCENT', text: 'your $' + fmt(u) + ' unit (' + +(100 * o.unit_percent).toFixed(2) + '% of a $' + fmt(o.bankroll_amount) + ' bankroll)' };
    }
    if (o.base_unit_amount != null) return { unit: o.base_unit_amount, basis: 'CUSTOM', text: 'your custom $' + fmt(o.base_unit_amount) + ' unit' };
    return { unit: null, basis: 'NOT_SET', text: 'Set a bankroll or a unit to see dollar amounts.' };
  }
  function fmt(x) { if (!isNum(x)) return '—'; var s = x.toFixed(2); if (/\.00$/.test(s) && x >= 100) s = s.slice(0, -3); return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function dollars(units, s) { var u = unitValue(s).unit, n = num(units); return u == null || n == null ? null : cents(n * u); }
  function dollarText(units, s) { var d = dollars(units, s); return d == null ? null : '$' + fmt(d); }

  /* ============================================================ EXPOSURE
     positions: the canonical decision objects (BET only are counted) and,
     optionally, the reader's placed bets {game_id, sport, side, team,
     market_type, units, kickoff, source:'placed'}. */
  function windowOf(kickoff, opts) {
    var t = Date.parse(kickoff);
    if (!isFinite(t)) return 'unscheduled';
    var off = opts && isNum(opts.tz_offset_minutes) ? opts.tz_offset_minutes : 0;
    var d = new Date(t + off * 60000), h = d.getUTCHours();
    var part = h < 12 ? 'early' : (h < 16 ? 'afternoon' : (h < 20 ? 'evening' : 'late'));
    return d.toISOString().slice(0, 10) + ' ' + part;
  }
  /* COMMITTED EXPOSURE: a decision object counts only when it is a BET with a
     stake (LEAN, WATCH, PASS and NO DECISION never do, whatever units field
     they carry); a reader's placed bet counts only as a placed bet, never
     because it carries a decision word */
  function countsAsExposure(p) {
    if (!p) return false;
    var u = num(p.recommended_units != null ? p.recommended_units : p.units);
    if (!isNum(u) || !(u > 0)) return false;
    if (p.decision != null) return p.decision === 'BET';
    return p.source === 'placed';
  }
  function add(map, k, u, d) { var e = map[k] || (map[k] = { units: 0, dollars: d == null ? null : 0, n: 0 }); e.units = Math.round((e.units + u) * 100) / 100; if (d != null) e.dollars = cents((e.dollars || 0) + d); e.n++; }
  function exposure(positions, s, opts) {
    opts = opts || {};
    var o = normalize(s), uv = unitValue(o);
    var bets = (positions || []).filter(countsAsExposure);
    var ordered = bets.slice().sort(function (a, b) {
      var TR = { MAX: 4, STRONG: 3, STANDARD: 2, SMALL: 1, VERY_STRONG: 3, QUALIFIED: 1 };
      var sa = TR[a.tier || a.strength] || 0, sb = TR[b.tier || b.strength] || 0;
      return (sb - sa) || ((num(b.calibrated_ev_pct) || 0) - (num(a.calibrated_ev_pct) || 0)) || String(a.kickoff || '').localeCompare(String(b.kickoff || ''));
    });
    var kept = [], held = [], total = 0;
    ordered.forEach(function (p) {
      var u = num(p.recommended_units != null ? p.recommended_units : p.units);
      if (o.exposure_limit_enabled && p.source !== 'placed' && total + u > o.max_active_units + 1e-9) { held.push({ game_id: p.game_id, units: u, reason: 'EXPOSURE_LIMIT', text: 'Held by your exposure limit (' + o.max_active_units + 'U).' }); return; }
      total = Math.round((total + u) * 100) / 100; kept.push(p);
    });
    var out = { schema: VERSION, n_bets: kept.filter(function (p) { return p.source !== 'placed'; }).length, n_placed: kept.filter(function (p) { return p.source === 'placed'; }).length,
      total_units: total, total_dollars: uv.unit == null ? null : cents(total * uv.unit), unit: uv,
      by_sport: {}, by_window: {}, by_game: {}, by_team: {}, by_market: {}, correlation_notes: [], held: held, guardrail: null };
    kept.forEach(function (p) {
      var u = num(p.recommended_units != null ? p.recommended_units : p.units), d = uv.unit == null ? null : u * uv.unit;
      add(out.by_sport, String(p.sport || '—').toUpperCase(), u, d);
      add(out.by_window, windowOf(p.kickoff, opts), u, d);
      add(out.by_game, String(p.game_id), u, d);
      add(out.by_team, String(p.side || p.team || '—'), u, d);
      add(out.by_market, String(p.market_type || 'spread'), u, d);
    });
    /* correlation: positions that depend on the same game outcome are one
       conviction, not two, however many markets show positive EV */
    Object.keys(out.by_game).forEach(function (g) {
      var ps = kept.filter(function (p) { return String(p.game_id) === g; });
      if (ps.length > 1) {
        var sides = {}; ps.forEach(function (p) { sides[p.side_key || p.side || '?'] = 1; });
        out.correlation_notes.push({ code: Object.keys(sides).length > 1 ? 'OPPOSITE_SIDES_SAME_GAME' : 'SAME_GAME',
          game_id: g, units: out.by_game[g].units,
          text: Object.keys(sides).length > 1 ? 'Positions on both sides of the same game offset each other.'
            : 'Two recommended positions depend heavily on the same game outcome. Do not double-count conviction simply because multiple correlated markets show positive EV.' });
      }
    });
    Object.keys(out.by_team).forEach(function (t) {
      var games = {}; kept.filter(function (p) { return String(p.side || p.team) === t; }).forEach(function (p) { games[p.game_id] = 1; });
      if (Object.keys(games).length > 1) out.correlation_notes.push({ code: 'SAME_TEAM', team: t, text: t + ' appears in more than one position.' });
    });
    var exceeded = total > o.max_active_units + 1e-9;
    out.guardrail = { max_active_units: o.max_active_units, exposure_limit_enabled: o.exposure_limit_enabled, exceeded: exceeded,
      text: exceeded ? 'Recommended active exposure ' + total + 'U exceeds your ' + o.max_active_units + 'U maximum.' : (held.length ? held.length + ' position' + (held.length === 1 ? '' : 's') + ' held by your ' + o.max_active_units + 'U exposure limit.' : null) };
    return out;
  }

  /* local storage (signed out); keys use the edgedesk_ prefix so sign-out
     purges them with the rest of the device's EdgeDesk data */
  function load(storage) {
    try { var st = storage || (typeof localStorage !== 'undefined' ? localStorage : null); if (!st) return normalize(null); var raw = st.getItem(LOCAL_KEY); return normalize(raw ? JSON.parse(raw) : null); } catch (e) { return normalize(null); }
  }
  function save(s, storage) {
    var o = normalize(s);
    try { var st = storage || (typeof localStorage !== 'undefined' ? localStorage : null); if (st) st.setItem(LOCAL_KEY, JSON.stringify(o)); } catch (e) { /* storage unavailable: the in-memory value still applies */ }
    return o;
  }
  /* the public.bankroll_settings row (supabase/bettor_decisions.sql adds the
     unit mode, percent, exposure and beginner columns) ↔ these settings */
  function fromRow(row) {
    if (!row) return null;
    return normalize({ bankroll_amount: row.bankroll_amount, unit_mode: row.unit_mode, unit_percent: row.unit_percent, base_unit_amount: row.base_unit_amount,
      max_active_units: row.max_active_exposure_units, exposure_limit_enabled: row.exposure_limit_enabled, beginner_mode: row.beginner_mode });
  }
  function toRow(s) {
    var o = normalize(s);
    return { bankroll_amount: o.bankroll_amount, unit_mode: o.unit_mode, unit_percent: o.unit_percent, base_unit_amount: o.base_unit_amount,
      max_active_exposure_units: o.max_active_units, exposure_limit_enabled: o.exposure_limit_enabled, beginner_mode: o.beginner_mode };
  }

  return { VERSION: VERSION, DEFAULTS: DEFAULTS, LOCAL_KEY: LOCAL_KEY, normalize: normalize, unitValue: unitValue, dollars: dollars, dollarText: dollarText, fmt: fmt,
    exposure: exposure, countsAsExposure: countsAsExposure, windowOf: windowOf, load: load, save: save, fromRow: fromRow, toRow: toRow };
}));
