/* ===========================================================================
   EDGEDESK CARD FEED — every sport on the Card, from the free price feed.

   The EdgeDesk Card used to read one thing: the football decision build and
   the football boards' live overlay, both priced from The Odds API capture.
   When that paid capture stopped (docs/odds-api-incident-2026-10/INCIDENT.md:
   the October credits ran out, paid retrieval paused until the reset), every
   game on the Card read NO DECISION. Meanwhile today/slate.json (tools/slate/
   build.js, every 30 minutes, keyless) already carries a DraftKings price for
   most pregame games in every sport, ESPN's public scoreboard as the source,
   and the model fair price for every sport EdgeDesk models.

   This module reads that slate and gives the Card two things:

     footballQuotes(slate, sport, gid)
         the slate's DraftKings spread / total / moneyline for one NFL or CFB
         game, in the quote shape the football boards price (app.html
         fbQevQuotes). The page adds them when its paid capture has no fresh
         quote, so the football decision engine decides on a real price
         instead of NO MARKET.

     rows(slate, opts)
         one Card row per pregame game the football engine does not already
         decide: NBA, NHL, MLB, soccer, UFC, college sports — and any football
         game the engine has not reached. A row is decision-shaped (decision,
         reference_quote, edge_pp, decision_ev_pct, action_reason_text …) so
         the Card's sections, filters and sorts read it like any other.

   THE RULES FOR A ROW (no new authority is invented here):
     - A model price exists and a book price exists → the model probability is
       pulled toward the book's no-vig probability (the optimiser's curse,
       lib/edgedesk_xboard.js), by how far the sport's model has been
       validated. Edge and EV are taken at the actual book price.
     - None of these models is validated against closing prices, so a row is
       never a BET and never carries units: the best class is LEAN, exactly
       where the football engine caps totals, moneylines and props.
     - A price that reads as value on a gap too large to be believed (raw
       EV >= 25%) is WATCH · CHECK THE NUMBER, never LEAN: at that size
       missing information is the usual cause.
     - A stale price caps the class at WATCH.
     - No model → PRICE ONLY (the line, shown so the reader does not have to
       go anywhere else for it). No price yet → AWAITING LINES, with the
       model's fair number. Neither is a decision and neither is counted as one.

   Pure except the loader (ensure / current / onUpdate). Browser:
   window.EDCardFeed. Node: require('./edgedesk_card_feed.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDCardFeed = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_card_feed_v1';
  var MIN = 60000, H = 3600000;
  var CFG = {
    /* how far a model probability is trusted against the book's no-vig one,
       by the model's own validation tier (1 = the model alone) */
    shrink: { MARKET_VALIDATED: 0.7, OUTCOME_VALIDATED: 0.5, LEAN: 0.5, PROVISIONAL: 0.35, _default: 0.35 },
    limited_data_factor: 0.6,
    lean: { ev: 0.02, edge_pp: 1.5 },
    /* a WATCH needs the LEAN price within this many cents */
    watch_cents: 15,
    check_raw_ev: 0.25,
    /* a price older than this (minutes) is stale, by hours to the start */
    stale_minutes: function (hoursToStart) { return hoursToStart <= 3 ? 90 : (hoursToStart <= 24 ? 240 : 720); }
  };
  var SPORT = {
    nfl: { label: 'NFL', ml: 'ML' }, cfb: { label: 'CFB', ml: 'ML' }, nba: { label: 'NBA', ml: 'ML' }, wnba: { label: 'WNBA', ml: 'ML' },
    ncaam: { label: 'NCAAB', ml: 'ML' }, ncaaw: { label: 'NCAAW', ml: 'ML' }, nhl: { label: 'NHL', ml: 'ML' }, mlb: { label: 'MLB', ml: 'ML' },
    ncaabase: { label: 'NCAA BASEBALL', ml: 'ML' }, soccer: { label: 'SOCCER', ml: '1X2' }, mma: { label: 'UFC', ml: 'ML' }
  };
  /* the order sport pills read in */
  var SPORT_ORDER = ['nfl', 'cfb', 'nba', 'nhl', 'mlb', 'soccer', 'mma', 'ncaam', 'ncaaw', 'wnba', 'ncaabase'];

  /* ------------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function ms(t) { if (isNum(t)) return t; var v = Date.parse(t); return isFinite(v) ? v : null; }
  function r(x, dp) { if (!isNum(x)) return null; var f = Math.pow(10, dp == null ? 4 : dp); return Math.round(x * f) / f; }
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  function implied(a) { var d = amToDec(a); return d ? 1 / d : null; }
  function priceText(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' + Math.round(a) : String(Math.round(a))); }
  function lineText(v) { v = num(v); if (v == null) return '—'; if (Math.abs(v) < 1e-9) return 'PK'; var s = String(Math.round(v * 10) / 10); return (v > 0 ? '+' : '') + s; }
  /* American price as cents from even money: -110 → -10, +120 → +20 */
  function cents(a) { a = num(a); return a == null ? null : (a > 0 ? a - 100 : a + 100); }
  function sportId(e) { return String((e && e.sport) || '').toLowerCase(); }
  function sportLabel(id) { var G = root && root.EDGames, s = G && G.sport ? G.sport(id) : null; return (SPORT[id] && SPORT[id].label) || (s ? String(s.label).toUpperCase() : String(id || '').toUpperCase()); }
  function bookName(m) { var b = String((m && m.book) || '').replace(/\s+/g, ''); return /^draftkings$/i.test(b) ? 'DraftKings' : ((m && m.book) || null); }
  function teamName(t) { return t ? (t.name || t.short || t.abbr || null) : null; }
  function normalize(ps) { var s = 0, ok = true; ps.forEach(function (p) { if (!isNum(p) || p <= 0) ok = false; else s += p; }); return ok && s > 0 ? ps.map(function (p) { return p / s; }) : null; }

  /* the football engine's game id for a slate event (the key the Card's
     engine decisions are filed under), or null */
  function footballKey(e) {
    var sp = sportId(e), rs = (e && e.research) || {};
    if (sp === 'cfb') return 'cfb|' + String(e.provider_id || rs.entity || '');
    if (sp === 'nfl') { var k = String(rs.game_key || ''); return k.indexOf('nfl|') === 0 ? k : null; }
    return null;
  }

  /* ============================================================== INDEX */
  var IDX = { key: null, byId: {}, byFootball: {} };
  function index(slate) {
    var key = slate ? String(slate.generated_at || '') + '|' + ((slate.events || []).length) + '|' + ((slate.upcoming || []).length) : null;
    if (key && IDX.key === key && IDX.slate === slate) return IDX;
    var byId = {}, byFb = {};
    ((slate && slate.events) || []).concat((slate && slate.upcoming) || []).forEach(function (e) {
      if (!e || !e.id || byId[e.id]) return;
      byId[e.id] = e;
      var fk = footballKey(e); if (fk) byFb[fk] = e;
    });
    IDX = { key: key, slate: slate, byId: byId, byFootball: byFb };
    return IDX;
  }
  function marketOf(slate, e) { return e && slate && slate.markets ? slate.markets[e.id] || null : null; }

  /* ===================================================== FOOTBALL QUOTES
     One NFL / CFB game's slate price, as the football boards' quote rows.
     sport: 'cfb' | 'nfl'; gid: the board's game id (CFB: the ESPN id, NFL:
     the nflverse id). Freshness is left to the caller's own ladder. */
  function footballQuotes(slate, sport, gid) {
    var sp = String(sport || '').toLowerCase(), I = index(slate);
    var e = I.byFootball[sp + '|' + String(gid)];
    if (!e) return [];
    var m = marketOf(slate, e);
    if (!m || !m.captured_at) return [];
    var out = [], book = bookName(m) || 'DraftKings';
    function add(o) { out.push(Object.assign({ game_id: String(gid), book: book, n_books: 1, captured_at: m.captured_at, provider_market_key: 'espn', source: 'espn_scoreboard', slate_id: e.id }, o)); }
    var s = m.spread;
    if (s && s.home && s.away && num(s.home.point) != null && num(s.home.price) != null && num(s.away.price) != null) {
      add({ side: 'home', market_type: 'spread', line: num(s.home.point), american: num(s.home.price) });
      add({ side: 'away', market_type: 'spread', line: num(s.away.point) != null ? num(s.away.point) : -num(s.home.point), american: num(s.away.price) });
    }
    var t = m.total;
    if (t && num(t.point) != null && num(t.over) != null && num(t.under) != null) {
      add({ side: 'over', market_type: 'total', line: num(t.point), american: num(t.over) });
      add({ side: 'under', market_type: 'total', line: num(t.point), american: num(t.under) });
    }
    var ml = m.moneyline;
    if (ml && num(ml.home) != null && num(ml.away) != null) {
      add({ side: 'home', market_type: 'moneyline', line: null, american: num(ml.home) });
      add({ side: 'away', market_type: 'moneyline', line: null, american: num(ml.away) });
    }
    return out;
  }

  /* ======================================================== MODEL PROBS
     The model's outcome probabilities from its fair prices (fair prices
     carry no vig; they are normalised anyway so rounding cannot leak) */
  function modelProbs(model, sp) {
    var f = (model && model.fair) || {};
    if (sp === 'soccer' && num(f.ml_home) != null && num(f.ml_draw) != null && num(f.ml_away) != null) {
      var p3 = normalize([implied(f.ml_home), implied(f.ml_draw), implied(f.ml_away)]);
      return p3 ? { home: p3[0], draw: p3[1], away: p3[2], three_way: true } : null;
    }
    if (num(f.ml_home) != null && num(f.ml_away) != null) {
      var p2 = normalize([implied(f.ml_home), implied(f.ml_away)]);
      if (p2) return { home: p2[0], away: p2[1] };
    }
    var hw = num(f.home_win);
    if (hw != null && hw > 0 && hw < 1) return { home: hw, away: 1 - hw };
    return null;
  }
  function overProb(model) {
    var f = (model && model.fair) || {};
    var p = implied(f.total_over_2_5);
    return p != null && p > 0 && p < 1 ? p : null;
  }
  function shrinkOf(model) {
    var k = CFG.shrink[(model && model.tier) || '_default'];
    if (k == null) k = CFG.shrink._default;
    if (model && model.data_quality && model.data_quality !== 'OK') k *= CFG.limited_data_factor;
    return k;
  }

  /* the candidates one game offers: every priced outcome the model speaks to */
  function candidates(e, m, model) {
    var sp = sportId(e), out = [];
    var home = teamName(e.home), away = teamName(e.away), k = shrinkOf(model);
    var mp = modelProbs(model, sp), ml = m && m.moneyline;
    if (mp && ml && num(ml.home) != null && num(ml.away) != null && (!mp.three_way || num(ml.draw) != null)) {
      var sides = mp.three_way ? ['home', 'draw', 'away'] : ['home', 'away'];
      var nv = normalize(sides.map(function (s) { return implied(ml[s]); }));
      if (nv) sides.forEach(function (s, i) {
        out.push({ market_type: 'moneyline', side: s, team: s === 'home' ? home : (s === 'away' ? away : 'Draw'), line: null, american: num(ml[s]),
          p_model: mp[s], p_market: nv[i], k: k, label: (s === 'draw' ? 'Draw' : (s === 'home' ? home : away) + ' ' + (mp.three_way ? 'to win' : 'ML')) });
      });
    }
    var po = sp === 'soccer' ? overProb(model) : null, t = m && m.total;
    if (po != null && t && num(t.point) === 2.5 && num(t.over) != null && num(t.under) != null) {
      var nt = normalize([implied(t.over), implied(t.under)]);
      if (nt) [['over', po, nt[0], t.over], ['under', 1 - po, nt[1], t.under]].forEach(function (c) {
        out.push({ market_type: 'total', side: c[0], team: null, line: 2.5, american: num(c[3]), p_model: c[1], p_market: c[2], k: k,
          label: (c[0] === 'over' ? 'Over' : 'Under') + ' 2.5 goals' });
      });
    }
    out.forEach(function (c) {
      var d = amToDec(c.american);
      c.decimal = d;
      c.p = c.k * c.p_model + (1 - c.k) * c.p_market;
      c.break_even = d ? 1 / d : null;
      c.edge = d ? c.p - 1 / d : null;
      c.ev = d ? c.p * d - 1 : null;
      c.raw_ev = d ? c.p_model * d - 1 : null;
      /* the price at which this outcome would read LEAN */
      var need = Math.max((1 + CFG.lean.ev) / c.p, 1 / Math.max(1e-6, c.p - CFG.lean.edge_pp / 100));
      c.lean_at = c.p - CFG.lean.edge_pp / 100 > 0 ? decToAm(need) : null;
      c.fair = decToAm(1 / c.p_model);
    });
    return out;
  }

  /* -------------------------------------------------------- text bits */
  function fairText(e, model) {
    var f = (model && model.fair) || {}, sp = sportId(e), home = teamName(e.home), away = teamName(e.away);
    if (sp === 'soccer' && num(f.ml_home) != null) return 'Fair 1X2 ' + priceText(f.ml_home) + ' / ' + priceText(f.ml_draw) + ' / ' + priceText(f.ml_away) + (num(f.expected_total) != null ? ' · ' + f.expected_total + ' goals expected' : '');
    if (num(f.spread_home) != null) { var s = f.spread_home; return 'Fair ' + (s <= 0 ? home + ' ' + lineText(s) : away + ' ' + lineText(-s)) + (num(f.total) != null ? ' · total ' + (Math.round(f.total * 10) / 10) : ''); }
    if (num(f.ml_home) != null && num(f.ml_away) != null) { var fav = f.ml_home <= f.ml_away; return 'Fair ' + (fav ? home : away) + ' ' + priceText(fav ? f.ml_home : f.ml_away) + (num(f.total) != null ? ' · total ' + f.total : ''); }
    if (num(f.home_win) != null) return 'Fair ' + home + ' ' + Math.round(f.home_win * 100) + '% to win';
    return null;
  }
  function marketText(e, m) {
    if (!m) return null;
    var parts = [], home = e.home || {}, away = e.away || {}, hA = home.abbr || teamName(home), aA = away.abbr || teamName(away);
    var s = m.spread;
    if (s && s.home && num(s.home.point) != null) parts.push((s.home.point <= 0 ? hA + ' ' + lineText(s.home.point) + ' (' + priceText(s.home.price) + ')' : aA + ' ' + lineText(s.away && s.away.point != null ? s.away.point : -s.home.point) + ' (' + priceText(s.away && s.away.price) + ')'));
    var t = m.total;
    if (t && num(t.point) != null) parts.push('O/U ' + t.point + ' (' + priceText(t.over) + '/' + priceText(t.under) + ')');
    var ml = m.moneyline;
    if (ml && num(ml.home) != null) parts.push(aA + ' ' + priceText(ml.away) + (num(ml.draw) != null ? ' · Draw ' + priceText(ml.draw) : '') + ' · ' + hA + ' ' + priceText(ml.home));
    return parts.join(' · ') || null;
  }
  function pct(x) { return isNum(x) ? Math.round(x * 1000) / 10 + '%' : '—'; }
  function pp(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pp' : '—'; }
  function evp(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + '%' : '—'; }

  /* ================================================================ ROWS */
  function marketState(m, startMs, now) {
    if (!m || !m.captured_at) return { key: 'NO_MARKET', label: 'NO LINE YET', tone: 'none', stale: true, age_minutes: null };
    var age = (now - ms(m.captured_at)) / MIN, hrs = (startMs - now) / H;
    var stale = !(age <= CFG.stale_minutes(hrs));
    return stale ? { key: 'STALE_MARKET', label: 'STALE PRICE', tone: 'stale', stale: true, age_minutes: Math.round(age) }
      : { key: 'LIVE_MARKET', label: 'LIVE PRICE', tone: 'live', stale: false, age_minutes: Math.round(Math.max(0, age)) };
  }
  function rowOf(e, m, now) {
    var sp = sportId(e), startMs = ms(e.start_utc), rs = e.research || {}, model = rs.model && rs.model.status === 'PREDICTED' ? rs.model : null;
    var home = teamName(e.home), away = teamName(e.away), ms0 = marketState(m, startMs, now);
    var base = {
      schema: VERSION, source: 'slate', board: true, game_id: e.id, slate_id: e.id, sport: sportLabel(sp), sport_id: sp, league: e.league || null,
      home: home, away: away, home_abbr: (e.home && e.home.abbr) || null, away_abbr: (e.away && e.away.abbr) || null,
      home_logo: (e.home && e.home.logo) || null, away_logo: (e.away && e.away.logo) || null, home_rank: e.home && e.home.rank, away_rank: e.away && e.away.rank,
      kickoff: e.start_utc, venue: e.venue || null, evaluated_at: new Date(now).toISOString(), recommended_units: 0, units: 0, tier: null,
      model_tier: model ? model.tier || null : null, model_note: model ? model.note || null : null, model_source: model ? model.source || null : null,
      model_fair_text: model ? fairText(e, model) : null, market_text: marketText(e, m), market_state: ms0,
      book: m ? bookName(m) : null, quote_captured_at: m ? m.captured_at : null, quote_age_minutes: ms0.age_minutes,
      probability_source: model ? 'model_estimated' : null, probability_source_label: model ? 'MODEL-ESTIMATED (UNVALIDATED VS THE MARKET)' : null,
      research_module: rs.module || null, research_entity: rs.entity || null, football_key: footballKey(e)
    };
    if (!model && !m) return null;
    if (!model) return Object.assign(base, { board_kind: 'PRICE_ONLY', decision: 'NO_DECISION', action_reason_code: 'NO_MODEL',
      action_reason_text: 'No EdgeDesk model for ' + (e.league || base.sport) + ' games yet — the current line is here so you do not have to look it up.' });
    if (!m) return Object.assign(base, { board_kind: 'AWAITING_LINES', decision: 'NO_DECISION', action_reason_code: 'AWAITING_LINES',
      action_reason_text: 'No line posted yet. ' + (base.model_fair_text ? 'EdgeDesk ' + base.model_fair_text.charAt(0).toLowerCase() + base.model_fair_text.slice(1) + '.' : 'EdgeDesk has a number for this game.') });

    var cs = candidates(e, m, model).filter(function (c) { return isNum(c.ev); });
    if (!cs.length) return Object.assign(base, { board_kind: 'PRICE_ONLY', decision: 'NO_DECISION', action_reason_code: 'NO_COMPARABLE_PRICE',
      action_reason_text: 'EdgeDesk has a ' + (base.model_fair_text ? base.model_fair_text.toLowerCase() : 'number') + ', but the posted price is not a market the model prices (' + (base.market_text || 'no two-sided price') + ').' });
    cs.sort(function (a, b) { return b.ev - a.ev; });
    var best = cs[0];
    var q = { side: best.side, team: best.team, market_type: best.market_type, line: best.line, odds: best.american, book: base.book, captured_at: m.captured_at,
      quote_age_minutes: ms0.age_minutes, label: best.label + ' (' + priceText(best.american) + ')', decision_cover: r(best.p), cover_probability: r(best.p),
      model_probability: r(best.p_model), market_probability: r(best.p_market), break_even_probability: r(best.break_even), edge_pp: r(best.edge * 100, 2),
      decision_ev: r(best.ev), raw_ev: r(best.raw_ev), fair_odds: best.fair, lean_at: best.lean_at, provider_market_key: 'espn',
      probability_basis: 'MODEL_MARKET_BLEND', independent_model_probability: r(best.p_model), blend_weight_on_model: r(best.k) };
    /* the decision number is a MODEL–MARKET BLEND (k on the model): a benchmark, said as one — EdgeDesk's own independent number is the model's */
    var why = 'Model–market blend ' + pct(best.p) + ' (EdgeDesk model ' + pct(best.p_model) + ', no-vig market ' + pct(best.p_market) + ', weight ' + pct(best.k) + ' on the model) vs ' + (base.book || 'the book') + ' ' + priceText(best.american) + ', which needs ' + pct(best.break_even) + ': edge ' + pp(best.edge) + ', EV ' + evp(best.ev) + '.';
    var gapC = best.lean_at != null ? cents(best.lean_at) - cents(best.american) : null;
    var trigger = best.lean_at != null ? 'LEAN at ' + priceText(best.lean_at) + ' or better.' : null;
    var o = { board_kind: 'MODEL', side: best.team || best.side, side_key: best.side, market_type: best.market_type, reference_quote: q,
      edge_pp: q.edge_pp, decision_ev_pct: r(best.ev * 100, 2), raw_ev_pct: r(best.raw_ev * 100, 2), probability: q.decision_cover,
      alternatives: cs.slice(1, 3).map(function (c) { return { label: c.label + ' (' + priceText(c.american) + ')', edge_pp: r(c.edge * 100, 2), ev_pct: r(c.ev * 100, 2) }; }) };
    /* a price that reads as value on a gap too large to believe is checked first, never leaned */
    if (best.ev > 0 && best.raw_ev >= CFG.check_raw_ev) return Object.assign(base, o, { decision: 'WATCH', decision_qualifier: 'CHECK THE NUMBER', action_reason_code: 'PRICE_ANOMALY',
      action_reason_text: why + ' The raw model gap (EV ' + evp(best.raw_ev) + ') is large enough that missing information (injury, lineup, a model gap) is the likelier cause — verify before acting.', bet_trigger_text: null });
    if (best.ev >= CFG.lean.ev && best.edge * 100 >= CFG.lean.edge_pp) {
      if (ms0.stale) return Object.assign(base, o, { decision: 'WATCH', decision_qualifier: 'STALE PRICE', action_reason_code: 'QUOTE_REFRESH_PENDING',
        action_reason_text: why + ' The price is ' + ms0.age_minutes + ' min old — confirm it is still there.', bet_trigger_text: null });
      return Object.assign(base, o, { decision: 'LEAN', decision_qualifier: model.data_quality && model.data_quality !== 'OK' ? 'LIMITED DATA' : 'UNVALIDATED MODEL',
        action_reason_code: 'MODEL_EDGE_UNVALIDATED', action_reason_text: why + ' This sport’s model is not yet validated against closing prices, so it is capped at LEAN with no stake.', bet_trigger_text: null });
    }
    if (best.ev > 0 || (gapC != null && gapC <= CFG.watch_cents)) {
      return Object.assign(base, o, { decision: 'WATCH', decision_qualifier: ms0.stale ? 'STALE PRICE' : null, action_reason_code: 'NEAR_THRESHOLD',
        action_reason_text: why + (trigger ? ' ' + trigger : ''), bet_trigger_text: trigger });
    }
    var aligned = Math.abs(best.p - best.p_market) < 0.01;
    return Object.assign(base, o, { decision: 'PASS', decision_qualifier: null, action_reason_code: aligned ? 'MARKET_ALIGNED' : 'NO_MODEL_EDGE',
      action_reason_text: (aligned ? 'The price matches EdgeDesk’s number. ' : 'The price does not clear EdgeDesk’s number. ') + why + (trigger && gapC != null && gapC <= 60 ? ' ' + trigger : ''), bet_trigger_text: trigger });
  }

  /* every pregame game in the slate the engine does not already decide.
     opts.covered: { 'cfb|<gid>': 1, 'nfl|<gid>': 1 } — engine decisions */
  function rows(slate, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : (ms(opts.now) || Date.now()), cov = opts.covered || {};
    var I = index(slate), out = [];
    Object.keys(I.byId).forEach(function (id) {
      var e = I.byId[id], st = ms(e.start_utc);
      if (!st || st <= now || (e.status && e.status !== 'SCHEDULED')) return;
      var fk = footballKey(e);
      if (fk && cov[fk]) return;
      var row = rowOf(e, marketOf(slate, e), now);
      if (row) out.push(row);
    });
    out.sort(function (a, b) { return (ms(a.kickoff) || 0) - (ms(b.kickoff) || 0); });
    return out;
  }

  /* ============================================================== STATUS
     what the reader is told about the free feed: how old, how much is priced */
  function status(slate, opts) {
    opts = opts || {};
    var now = isNum(opts.now) ? opts.now : Date.now();
    if (!slate) return { ok: false, text: 'The free price feed has not loaded.' };
    var I = index(slate), by = {}, newest = null, n = 0, priced = 0;
    Object.keys(I.byId).forEach(function (id) {
      var e = I.byId[id], st = ms(e.start_utc);
      if (!st || st <= now || (e.status && e.status !== 'SCHEDULED')) return;
      var sp = sportId(e), m = marketOf(slate, e), b = by[sp] = by[sp] || { id: sp, label: sportLabel(sp), games: 0, priced: 0, modeled: 0 };
      b.games++; n++;
      if (m) { b.priced++; priced++; var c = ms(m.captured_at); if (c && (newest == null || c > newest)) newest = c; }
      if (e.research && e.research.model && e.research.model.status === 'PREDICTED') b.modeled++;
    });
    var gen = ms(slate.generated_at);
    return { ok: true, generated_at: slate.generated_at || null, age_minutes: gen ? Math.max(0, Math.round((now - gen) / MIN)) : null,
      newest_capture: newest ? new Date(newest).toISOString() : null, capture_age_minutes: newest ? Math.max(0, Math.round((now - newest) / MIN)) : null,
      games: n, priced: priced, sports: SPORT_ORDER.filter(function (s) { return by[s]; }).map(function (s) { return by[s]; })
        .concat(Object.keys(by).filter(function (s) { return SPORT_ORDER.indexOf(s) < 0; }).map(function (s) { return by[s]; })),
      source: 'DraftKings via ESPN’s public scoreboard (free, no credits)' };
  }

  /* ============================================================== LOADER
     The Card's own read of the slate (the Games strip may hold a newer one) */
  var L = { slate: null, at: 0, err: null, p: null, subs: [] };
  function newer(a, b) { if (!a) return b; if (!b) return a; return (ms(b.generated_at) || 0) > (ms(a.generated_at) || 0) ? b : a; }
  function current() {
    var gs = null;
    try { gs = root && root.EDGamesUI && root.EDGamesUI._state ? root.EDGamesUI._state.snap : null; } catch (e) { gs = null; }
    return newer(L.slate, gs && gs.markets ? gs : null);
  }
  function onUpdate(fn) { if (typeof fn === 'function') L.subs.push(fn); }
  function ensure(opts) {
    opts = opts || {};
    if (L.p) return L.p;
    if (L.slate && Date.now() - L.at < (opts.maxAgeMs || 10 * MIN)) return Promise.resolve(L.slate);
    if (typeof fetch !== 'function') return Promise.resolve(null);
    L.p = fetch(opts.url || 'today/slate.json', { cache: 'no-cache' }).then(function (res) { if (!res.ok) throw new Error('slate.json ' + res.status); return res.json(); })
      .then(function (j) { L.slate = j; L.at = Date.now(); L.err = null; L.p = null; L.subs.forEach(function (fn) { try { fn(j); } catch (e) { /* a subscriber's failure is its own */ } }); return j; })
      .catch(function (e) { L.err = String((e && e.message) || e).slice(0, 120); L.p = null; L.subs.forEach(function (fn) { try { fn(null); } catch (x) { /* ignore */ } }); return null; });
    return L.p;
  }

  return {
    VERSION: VERSION, CFG: CFG, SPORT_ORDER: SPORT_ORDER, sportLabel: sportLabel,
    footballKey: footballKey, footballQuotes: footballQuotes, rows: rows, status: status, index: index,
    candidates: candidates, modelProbs: modelProbs, priceText: priceText,
    ensure: ensure, current: current, onUpdate: onUpdate, _loader: L
  };
}));
