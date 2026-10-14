/* ===========================================================================
   EDGEDESK NHL COMPARE — EdgeDesk's own NHL lines beside a sportsbook's, and
   which side EdgeDesk rates higher than the book does.

   Browser and Node (window.EDNHLCompare / module.exports). Pure: it reads
   numbers the NHL slate already published (hockey/slate.json) and one book's
   captured prices, and returns numbers, labels and sentences. It never
   computes a hockey probability, and a price never moves one.

   view(g, slate)           EdgeDesk's numbers for one game in the one shape
                            compare() reads (also carried, compact, by the
                            Today's Games slate: tools/slate/research.js)
   compare(view, market)    for every market the book prices on both sides
                            (moneyline, puck line, total): EdgeDesk's
                            probability and fair price, the book's price and
                            its no-vig probability, the gap, the EV at the
                            book's price and the label lib/edgedesk_nhl_market.js
                            gives it, with a sentence per market and a
                            summary per game
   tape(g)                  who is better where: each club's ratings from the
                            slate's evidence block on one scale (+ is better
                            than league average) and the side with the edge

   THE RULES
     1. Two questions, answered apart. "Which side does EdgeDesk rate higher
        than the book?" compares probabilities: EdgeDesk's minus the book's
        no-vig. "Does the book's price pay enough?" is EV at that price,
        labelled by EDNHLMarket.evaluate with every failing gate listed. A
        side EdgeDesk rates higher is not a bet: the book's margin usually
        means neither price pays.
     2. VERIFIED VALUE is impossible until the NHL model is tested against
        closing prices (EDNHLMarket's market_tested gate).
     3. A price republished by ESPN's public scoreboard is a REFERENCE: named
        as such, it fails the price_verified gate, and its age is shown. Past
        `stale_minutes` (the slate's own 90-minute limit) it is a past price.
     4. Like for like only. The book's 2-way moneyline, puck line and total
        include overtime and the shootout, as EdgeDesk's do. A line EdgeDesk
        has no probability for is reported as not compared, never
        interpolated. On a whole-number line both numbers exclude the push.
     5. One rounding policy: probabilities are shown to 0.1 % and every gap
        is the difference of the two shown numbers.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDNHLCompare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var VERSION = 'edgedesk_nhl_compare_v1';
  var DEFAULTS = { stale_minutes: 90, even_points: 1 };

  function market() {
    if (root && root.EDNHLMarket) return root.EDNHLMarket;
    try { return typeof require === 'function' ? require('./edgedesk_nhl_market.js') : null; } catch (_) { return null; }
  }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r1(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10) / 10; }
  /* one rounding, from the raw probability, everywhere a percentage is shown */
  function pct1(p) { return p == null || !isFinite(p) ? null : r1(p * 100); }
  function am(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' : '−') + Math.abs(Math.round(a)); }
  function pctText(v) { return v == null ? '—' : v.toFixed(1) + '%'; }
  function ppText(v) { return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + ' pp'; }
  function evText(v) { return v == null ? '—' : Math.abs(v) < 0.0005 ? '±0.0%' : (v > 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%'; }
  function words(s) { return String(s || '').replace(/_/g, ' ').toLowerCase(); }
  function validAm(a) { a = num(a); return a != null && Math.abs(a) >= 100; }

  /* ------------------------------------------------------------ the view */
  /**
   * EdgeDesk's numbers for one game. g: a hockey/slate.json game; slate: the
   * file it came from (market statuses, readiness). o.compact keeps only the
   * ±1.5 puck lines (what the Today's Games slate carries).
   */
  function view(g, slate, o) {
    o = o || {};
    if (!g || !g.prices || !g.prices.moneyline || num(g.prices.moneyline.home) == null || num(g.prices.moneyline.away) == null) return null;
    var st = (slate && slate.market_statuses) || {};
    var rm = (slate && slate.readiness && slate.readiness.model) || {};
    var P = g.prices, M = g.markets || null, ml = P.moneyline;
    var mlS = st.moneyline || rm.moneyline || {}, plS = rm.puck_line || {}, totS = rm.total || {};
    var v = {
      schema: VERSION, game_id: g.game_id != null ? String(g.game_id) : null, home: g.home, away: g.away, start_utc: g.start_utc || null,
      moneyline: { home: num(ml.home), away: num(ml.away), status: mlS.status || null, market_status: mlS.market_status || 'NOT_TESTED', market_n: num(mlS.market_n) },
      puck_line: [],
      total: { expected: num(P.total && P.total.expected), fair_line: num(P.total && P.total.fair_line), lines: [] },
      sd_pp: num(g.uncertainty && g.uncertainty.moneyline_sd_pp),
      scenarios_home: ((g.goalies && g.goalies.scenarios) || []).map(function (x) { return num(x.p_home); }).filter(function (x) { return x != null; }),
      goalie_certainty: (g.goalies && g.goalies.certainty) || null,
      data_state: (slate && slate.readiness && slate.readiness.data && slate.readiness.data.state) || null
    };
    if (M && Array.isArray(M.puck_line)) {
      M.puck_line.forEach(function (x) {
        if (o.compact && Math.abs(Math.abs(num(x.home_line)) - 1.5) > 1e-9) return;
        v.puck_line.push({ home_line: num(x.home_line), home: num(x.p), away: num(x.p_other), push: num(x.push) || 0, status: x.validation || null, market_status: plS.market_status || 'NOT_TESTED' });
      });
    } else if (P.puck_line) {
      var pl = P.puck_line;
      v.puck_line.push({ home_line: -1.5, home: num(pl.home_minus_1_5), away: num(pl.away_plus_1_5), push: 0, status: plS.status || null, market_status: plS.market_status || 'NOT_TESTED' });
      v.puck_line.push({ home_line: 1.5, home: num(pl.home_plus_1_5), away: num(pl.away_minus_1_5), push: 0, status: plS.status || null, market_status: plS.market_status || 'NOT_TESTED' });
    }
    if (M && Array.isArray(M.total)) {
      M.total.forEach(function (x) { v.total.lines.push({ line: num(x.line), over: num(x.p), under: num(x.p_other), push: num(x.push) || 0, status: x.validation || null, market_status: totS.market_status || 'NOT_TESTED' }); });
    } else if (P.total && P.total.lines) {
      Object.keys(P.total.lines).forEach(function (L) { var x = P.total.lines[L]; v.total.lines.push({ line: num(L), over: num(x.over), under: num(x.under), push: num(x.push) || 0, status: totS.status || null, market_status: totS.market_status || 'NOT_TESTED' }); });
      v.total.lines.sort(function (a, b) { return a.line - b.line; });
    }
    return v;
  }

  /* --------------------------------------------------------- the source */
  function source(mk, now, staleMin) {
    var book = String(mk.book || '').trim().replace(/^draft\s*kings$/i, 'DraftKings') || null;
    var ref = mk.source === 'espn_scoreboard';
    var t = Date.parse(mk.captured_at), age = isFinite(t) ? Math.max(0, (now - t) / 60000) : null;
    return {
      book: book, kind: ref ? 'reference' : 'captured', via: ref ? 'ESPN' : null,
      label: (book || 'A sportsbook') + (ref ? ' via ESPN' : ''),
      captured_at: isFinite(t) ? new Date(t).toISOString() : null, age_min: age == null ? null : Math.round(age),
      stale: age == null || age > staleMin, stale_minutes: staleMin
    };
  }

  /* ------------------------------------------------------------ compare */
  /* EdgeDesk's moneyline favourite */
  function favOf(view) {
    var ml = view && view.moneyline, EM = market();
    if (!ml || ml.home == null || ml.away == null) return null;
    var home = ml.home >= ml.away, p = home ? ml.home : ml.away;
    return { key: home ? 'home' : 'away', name: home ? view.home : view.away, pct: pct1(p), fair_american: EM ? EM.decToAm(1 / p) : null };
  }

  /**
   * view: from view(); mk: one captured market { book, source, captured_at,
   * moneyline:{home,away}, spread:{home:{point,price},away:{point,price}},
   * total:{point,over,under}, partial:[..] } (lib/edgedesk_games.js);
   * ctx: { now, stale_minutes, min_ev }.
   */
  function compare(view, mk, ctx) {
    ctx = ctx || {};
    var now = num(ctx.now) != null ? num(ctx.now) : Date.now();
    var staleMin = num(ctx.stale_minutes) != null ? num(ctx.stale_minutes) : DEFAULTS.stale_minutes;
    var EM = market();
    var out = { version: VERSION, ok: false, reason: null, source: null, markets: [], not_compared: [], summary: null };
    if (!view) { out.reason = 'EdgeDesk has no NHL price for this game.'; return out; }
    if (!EM) { out.reason = 'The market engine (lib/edgedesk_nhl_market.js) is not loaded.'; return out; }
    out.summary = { fav: favOf(view), book_fav: null, agree_on_fav: null, biggest: null, best: null, any_pays: false };
    if (!mk) { out.reason = 'No sportsbook price for this game yet.'; return out; }
    var src = out.source = source(mk, now, staleMin);
    if (!src.captured_at) { out.reason = 'The captured price carries no capture time, so it is not compared.'; out.source = null; return out; }
    var cx = { now: now, data_state: view.data_state, goalie_certainty: view.goalie_certainty };
    var opts = ctx.min_ev != null ? { min_ev: ctx.min_ev } : {};

    function side(o) {
      var r = EM.evaluate({
        market: { kind: o.kind, label: o.label },
        model: { p_win: o.p_win, p_push: o.p_push, sd_pp: o.sd_pp, status: o.status, market_status: o.market_status, market_n: o.market_n, scenario_p_win: o.scen },
        quote: { american: o.american, other_american: o.other_american, book: src.book, via: src.via, captured_at: src.captured_at, source: src.kind },
        context: cx, opts: opts
      });
      /* both percentages from the raw probabilities (EdgeDesk's conditional
         on no push, the book's with its margin removed), each rounded once */
      var n = r.numbers, nv = EM.noVig(o.american, o.other_american), pu = o.p_push || 0;
      var mp = o.p_win != null && pu < 1 ? pct1(o.p_win / (1 - pu)) : null, kp = nv ? pct1(nv.p) : null;
      return {
        key: o.key, name: o.name, label: o.label, american: num(o.american), p_win: o.p_win, p_push: o.p_push || 0,
        edgedesk_pct: mp, book_pct: kp, gap_pp: mp != null && kp != null ? r1(mp - kp) : null,
        fair_american: n.fair_american, min_american: n.min_acceptable_american, ev: n.ev,
        verdict: r.label, reasons: r.reasons, gates: r.gates, status: o.status || null
      };
    }
    function pair(kind, title, line, a, b, band) {
      var sides = [side(a), side(b)];
      var lean = sides[0].gap_pp == null ? null : sides[0].gap_pp > sides[1].gap_pp ? sides[0] : sides[1].gap_pp > sides[0].gap_pp ? sides[1] : null;
      if (lean && !(lean.gap_pp > 0)) lean = null;
      var best = sides[0].ev == null ? sides[1] : sides[1].ev == null ? sides[0] : sides[0].ev >= sides[1].ev ? sides[0] : sides[1];
      var m = { kind: kind, title: title, line: line, sides: sides, lean: lean ? lean.key : null, band_pp: band, within_band: lean && band != null ? lean.gap_pp <= band : null, best: best.key, pays: best.ev > 0 };
      m.sentence = say(m, lean, best, view, src);
      out.markets.push(m);
    }

    /* the moneyline: two-way, overtime and the shootout included */
    var ml = mk.moneyline;
    if (ml && validAm(ml.home) && validAm(ml.away) && view.moneyline && view.moneyline.home != null) {
      var M0 = view.moneyline, scenAway = view.scenarios_home.map(function (p) { return 1 - p; });
      pair('moneyline', 'Moneyline', null,
        { kind: 'moneyline', key: 'away', name: view.away, label: view.away + ' moneyline', p_win: M0.away, american: ml.away, other_american: ml.home, sd_pp: view.sd_pp, status: M0.status, market_status: M0.market_status, market_n: M0.market_n, scen: scenAway },
        { kind: 'moneyline', key: 'home', name: view.home, label: view.home + ' moneyline', p_win: M0.home, american: ml.home, other_american: ml.away, sd_pp: view.sd_pp, status: M0.status, market_status: M0.market_status, market_n: M0.market_n, scen: view.scenarios_home },
        view.sd_pp);
    }
    /* the puck line: the book's line must be one EdgeDesk priced */
    var sp = mk.spread;
    if (sp && sp.home && sp.away && validAm(sp.home.price) && validAm(sp.away.price) && num(sp.home.point) != null && Math.abs(num(sp.home.point) + num(sp.away.point)) < 1e-9) {
      var hl = num(sp.home.point), row = view.puck_line.filter(function (x) { return Math.abs(x.home_line - hl) < 1e-9; })[0];
      var ln = function (v) { return (v > 0 ? '+' : '−') + Math.abs(v); };
      if (row && row.home != null && row.away != null) {
        pair('puck_line', 'Puck line', hl,
          { kind: 'puck_line', key: 'away', name: view.away + ' ' + ln(-hl), label: view.away + ' ' + ln(-hl), p_win: row.away, p_push: row.push, american: sp.away.price, other_american: sp.home.price, status: row.status, market_status: row.market_status },
          { kind: 'puck_line', key: 'home', name: view.home + ' ' + ln(hl), label: view.home + ' ' + ln(hl), p_win: row.home, p_push: row.push, american: sp.home.price, other_american: sp.away.price, status: row.status, market_status: row.market_status },
          null);
      } else out.not_compared.push('puck line ' + view.home + ' ' + ln(hl) + ': EdgeDesk has no probability at that line');
    }
    /* the total: the book's point must be one EdgeDesk priced */
    var t = mk.total;
    if (t && num(t.point) != null && validAm(t.over) && validAm(t.under)) {
      var pt = num(t.point), tr = view.total.lines.filter(function (x) { return Math.abs(x.line - pt) < 1e-9; })[0];
      if (tr && tr.over != null && tr.under != null) {
        pair('total', 'Total', pt,
          { kind: 'total', key: 'over', name: 'Over ' + pt, label: 'Over ' + pt, p_win: tr.over, p_push: tr.push, american: t.over, other_american: t.under, status: tr.status, market_status: tr.market_status },
          { kind: 'total', key: 'under', name: 'Under ' + pt, label: 'Under ' + pt, p_win: tr.under, p_push: tr.push, american: t.under, other_american: t.over, status: tr.status, market_status: tr.market_status },
          null);
      } else out.not_compared.push('total ' + pt + ': EdgeDesk has no probability at that line');
    }
    (mk.partial || []).forEach(function (x) { out.not_compared.push(String(x)); });
    out.ok = out.markets.length > 0;
    if (!out.ok) { out.reason = 'The captured price has no market EdgeDesk can compare like for like.'; return out; }

    /* the summary: the favourites, the largest gap, the best price */
    var S = out.summary;
    out.markets.forEach(function (m) {
      if (m.kind === 'moneyline') {
        var bf = m.sides[0].book_pct > m.sides[1].book_pct ? m.sides[0] : m.sides[1];
        S.book_fav = { key: bf.key, name: bf.name, pct: bf.book_pct, american: bf.american };
        S.agree_on_fav = S.fav ? bf.key === S.fav.key : null;
      }
      var lean = m.lean ? m.sides.filter(function (x) { return x.key === m.lean; })[0] : null;
      if (lean && (!S.biggest || lean.gap_pp > S.biggest.gap_pp)) S.biggest = { kind: m.kind, title: m.title, key: lean.key, name: lean.name, gap_pp: lean.gap_pp, within_band: m.within_band, band_pp: m.band_pp, status: lean.status };
      var b = m.sides.filter(function (x) { return x.key === m.best; })[0];
      if (b && b.ev != null && (!S.best || b.ev > S.best.ev)) S.best = { kind: m.kind, title: m.title, key: b.key, name: b.name, american: b.american, fair_american: b.fair_american, min_american: b.min_american, ev: b.ev, verdict: b.verdict, reasons: b.reasons, gates: b.gates, status: b.status };
    });
    S.any_pays = !!(S.best && S.best.ev > 0);
    S.sentence = summarySentence(S, src);
    return out;
  }

  /* one market in words: which side EdgeDesk rates higher, then the price */
  function say(m, lean, best, view, src) {
    var bk = src.book || 'the book';
    var s = '';
    var basis = m.sides.some(function (x) { return x.p_push > 0; }) ? ' (pushes excluded)' : '';
    if (m.kind === 'total' && view.total.expected != null) s += 'EdgeDesk expects ' + view.total.expected + ' goals; ' + bk + ' has the line at ' + m.line + '. ';
    if (!lean) {
      var a = m.sides[0];
      s += 'EdgeDesk and ' + bk + ' price ' + a.name + ' the same: ' + pctText(a.edgedesk_pct) + ' each after removing the book’s margin' + basis + '. ';
    } else if (m.within_band) {
      s += 'EdgeDesk has ' + lean.name + ' at ' + pctText(lean.edgedesk_pct) + ', ' + bk + ' at ' + pctText(lean.book_pct) + ' after removing its margin: ' + lean.gap_pp.toFixed(1) + ' pp apart, inside EdgeDesk’s own ±' + m.band_pp + ' pp model spread, so the two agree. ';
    } else {
      s += 'EdgeDesk rates ' + lean.name + ' ' + lean.gap_pp.toFixed(1) + ' pp higher than ' + bk + ' does: ' + pctText(lean.edgedesk_pct) + ' against ' + pctText(lean.book_pct) + ' after removing the book’s margin' + basis + '. ';
    }
    if (best.ev > 0) {
      s += 'At ' + am(best.american) + ', ' + best.name + ' pays more than EdgeDesk’s fair ' + am(best.fair_american) + ': EV ' + evText(best.ev) + ' a unit on paper. ' + why(best) + '.';
    } else {
      var w = lean || best;
      s += 'Neither price pays at EdgeDesk’s numbers: ' + w.name + ' at ' + am(w.american) + (am(w.american) === am(w.fair_american) ? ' is right at' : ' is below') + ' EdgeDesk’s fair ' + am(w.fair_american) + ' (EV ' + evText(w.ev) + '); it would take ' + am(w.min_american) + ' or better to clear EdgeDesk’s 2% bar.';
    }
    return s.replace(/\.\./g, '.');
  }
  /* why a side that pays on paper is still not a verified edge */
  function why(x) {
    var failed = (x.gates || []).filter(function (g) { return !g.ok; }).map(function (g) { return words(g.gate); });
    if (x.verdict === 'VERIFIED_VALUE') return 'Every gate passes';
    if (x.verdict === 'RESEARCH_ONLY') return 'Research only: EdgeDesk’s ' + words(x.status || 'unvalidated') + ' record on this market is not a value signal';
    return 'Provisional, not a verified edge: it fails ' + failed.length + ' of the value gates (' + failed.join(', ') + ')';
  }
  function summarySentence(S, src) {
    var parts = [];
    if (S.fav) parts.push('EdgeDesk makes ' + S.fav.name + ' the likelier winner, ' + pctText(S.fav.pct) + ' (fair ' + am(S.fav.fair_american) + ').');
    if (S.book_fav) parts.push(S.agree_on_fav ? src.label + ' agrees: ' + S.book_fav.name + ' ' + pctText(S.book_fav.pct) + ' after its margin.' : src.label + ' has ' + S.book_fav.name + ' as the favourite instead, ' + pctText(S.book_fav.pct) + ' after its margin: the two disagree on who should win.');
    if (S.biggest) parts.push('Largest difference: EdgeDesk rates ' + S.biggest.name + (S.biggest.kind === 'moneyline' ? ' to win' : '') + ' ' + S.biggest.gap_pp.toFixed(1) + ' pp higher than the book'
      + (S.biggest.within_band ? ', inside EdgeDesk’s own ±' + S.biggest.band_pp + ' pp model spread' : '')
      + (S.biggest.status && S.biggest.status !== 'OUTCOME_VALIDATED' ? ' (EdgeDesk’s record on this market is ' + words(S.biggest.status) + ')' : '') + '.');
    parts.push(S.any_pays ? S.best.name + ' at ' + am(S.best.american) + ' pays above EdgeDesk’s fair ' + am(S.best.fair_american) + ' (EV ' + evText(S.best.ev) + '): ' + why(S.best).replace(/^./, function (c) { return c.toLowerCase(); }) + '.' : 'No price pays above EdgeDesk’s numbers.');
    return parts.join(' ');
  }

  /* --------------------------------------------------------------- tape */
  /* each area: [key, label, evidence field, direction (+1: higher is better), what it measures] */
  var AREAS = [
    ['attack', '5v5 chances created', 'ev_xg_for_vs_league', 1, 'expected goals for at 5-on-5, score- and opponent-adjusted'],
    ['defence', '5v5 chances allowed', 'ev_xg_against_vs_league', -1, 'expected goals against at 5-on-5, score- and opponent-adjusted'],
    ['scoring', 'Goals scored', 'goals_for_vs_league', 1, 'goals for, all situations'],
    ['keeping_out', 'Goals allowed', 'goals_against_vs_league', -1, 'goals against, all situations'],
    ['power_play', 'Power play', 'pp_vs_league', 1, 'power-play scoring rate'],
    ['penalty_kill', 'Penalty kill', 'pk_xga_vs_league', -1, 'expected goals allowed short-handed']
  ];
  function edgeOf(h, a, band) { if (h == null || a == null) return null; var d = r1(h - a); return Math.abs(d) < band ? 'even' : d > 0 ? 'home' : 'away'; }
  function starter(list) { return (list || []).slice().sort(function (x, y) { return (y.p_start || 0) - (x.p_start || 0); })[0] || null; }
  /**
   * Who is better where. Every score is "+ is better than league average",
   * in percent: a rating 4% above average on a higher-is-better area is +4.0,
   * on a lower-is-better area −4.0. Within `even_points` is called even.
   */
  function tape(g, o) {
    o = o || {};
    var band = num(o.even_points) != null ? num(o.even_points) : DEFAULTS.even_points;
    var E = g && g.evidence;
    if (!E || !E.home || !E.away) return null;
    var rows = AREAS.map(function (A) {
      var h = num(E.home[A[2]]), a = num(E.away[A[2]]);
      var sh = h == null ? null : r1((h - 1) * 100 * A[3]), sa = a == null ? null : r1((a - 1) * 100 * A[3]);
      return { key: A[0], label: A[1], what: A[4], home: sh, away: sa, raw: { home: h, away: a }, edge: edgeOf(sh, sa, band) };
    });
    var gh = starter(g.goalies && g.goalies.home), ga = starter(g.goalies && g.goalies.away);
    if (gh && ga && gh.gsax_rate != null && ga.gsax_rate != null) {
      var qh = r1(gh.gsax_rate * 100), qa = r1(ga.gsax_rate * 100);
      rows.push({ key: 'goalie', label: 'Projected goalie', what: 'goals saved above expected, as a share of the expected goals he faces; the likeliest starter (' + words((g.goalies && g.goalies.certainty) || 'projected') + ')',
        home: qh, away: qa, names: { home: gh.name || null, away: ga.name || null }, p_start: { home: num(gh.p_start), away: num(ga.p_start) }, edge: edgeOf(qh, qa, band) });
    }
    var rh = num(E.home.rest_days), ra = num(E.away.rest_days);
    if (rh != null && ra != null) {
      var bh = !!E.home.back_to_back, ba = !!E.away.back_to_back;
      rows.push({ key: 'rest', label: 'Rest', what: 'days since the last game', home: rh, away: ra, b2b: { home: bh, away: ba }, unit: 'days',
        edge: bh === ba && Math.min(rh, 3) === Math.min(ra, 3) ? 'even' : bh !== ba ? (bh ? 'away' : 'home') : (Math.min(rh, 3) > Math.min(ra, 3) ? 'home' : 'away') });
    }
    var lam = g.lambda || {}, xh = num(lam.home), xa = num(lam.away);
    var count = { home: 0, away: 0, even: 0 };
    rows.forEach(function (r) { if (r.edge) count[r.edge]++; });
    var proj = xh != null && xa != null ? { home: Math.round(xh * 100) / 100, away: Math.round(xa * 100) / 100, edge: Math.abs(xh - xa) < 0.005 ? 'even' : xh > xa ? 'home' : 'away' } : null;
    var name = function (k) { return k === 'home' ? g.home : g.away; };
    var sum = [];
    sum.push(g.home + ' has the edge in ' + count.home + ' of ' + rows.length + ' areas, ' + g.away + ' in ' + count.away + (count.even ? '; ' + count.even + ' even' : '') + '.');
    if (proj) sum.push('EdgeDesk’s bottom line, with home ice and everything above: ' + g.home + ' projects ' + proj.home.toFixed(2) + ' goals, ' + g.away + ' ' + proj.away.toFixed(2) + (proj.edge === 'even' ? ': dead even.' : ', so ' + name(proj.edge) + ' is the stronger side tonight.'));
    return { rows: rows, count: count, projected: proj, even_points: band, sentence: sum.join(' '), notes: (E.notes || []).slice() };
  }

  return { VERSION: VERSION, DEFAULTS: DEFAULTS, view: view, compare: compare, tape: tape, source: source,
    _fmt: { am: am, pct: pctText, pp: ppText, ev: evText } };
});
