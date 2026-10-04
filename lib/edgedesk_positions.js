/* ===========================================================================
   EdgeDesk POSITIONS — the reader's positions that EdgeDesk can grade against a
   closing line, in one shape.

   Portfolio (lib/edgedesk_portfolio*.js, supabase/portfolio.sql) is the book:
   every bet and prediction-market position the reader records or imports, and
   their P&L. This file is narrower and older than that book: the two stores
   that carry a CLOSING-LINE grade, which is what Process reads.

     ledger  localStorage `edgedesk_bets` — a price tracked from an edge (frozen
             at its number, settled and graded from `signals`) or a bet logged
             by hand. Shown in Portfolio as "Tracked from EdgeDesk".
     card    the EdgeDesk Card's BET PLACED records (EDDecisionUI.placed()),
             graded against the committed football record.

   One shape for both, so Process can pool them on the one unit-free measure —
   did the price beat the close — without converting CLV units.

   Pure: no DOM, no storage, no network. Browser: window.EDPositions.
   Node: require('./edgedesk_positions.js'). Held by
   tools/app/portfolio_process.test.js.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDPositions = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_positions_v1';

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* American → decimal. null for anything that is not a real price. */
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function fmtAm(a) { a = num(a); return a == null ? '—' : (a > 0 ? '+' : '') + a; }
  function money(x, signed) {
    if (!isNum(x)) return '—';
    var s = Math.abs(x) >= 1000 ? Math.round(Math.abs(x)).toLocaleString('en-US') : Math.abs(x).toFixed(Math.abs(x) >= 100 ? 0 : 2);
    if (signed) return (x > 0 ? '+$' : x < 0 ? '−$' : '$') + s;
    return (x < 0 ? '−$' : '$') + s;
  }
  function pct(x, signed, dp) { if (!isNum(x)) return '—'; var v = (x * 100).toFixed(dp == null ? 1 : dp); return (signed && x > 0 ? '+' : '') + v + '%'; }

  var MARKET = { h2h: 'Moneyline', moneyline: 'Moneyline', ml: 'Moneyline', spreads: 'Spread', spread: 'Spread', totals: 'Total', total: 'Total' };
  function marketLabel(m) {
    if (!m) return null;
    var k = String(m).toLowerCase();
    if (MARKET[k]) return MARKET[k];
    if (/^player_|prop/.test(k)) return 'Prop';
    return k.charAt(0).toUpperCase() + k.slice(1);
  }
  function sportLabel(s) {
    if (!s) return null;
    var k = String(s).trim();
    var u = k.toUpperCase();
    if (u === 'NCAAF' || u === 'CFB' || /COLLEGE FOOTBALL/.test(u)) return 'CFB';
    if (u === 'NFL' || u === 'AMERICANFOOTBALL_NFL') return 'NFL';
    return k;
  }

  /* ------------------------------------------------------------ positions
     One shape for every source, so a total can never count one source in one
     unit and another in a second. `stake` is dollars or null: a position with
     no stake is still a position, and still graded for CLV, but it adds
     nothing to a dollar P&L (it adds to the flat-unit record instead). */
  function fromLedger(b) {
    if (!b || typeof b !== 'object') return null;
    var odds = num(b.odds), dec = amToDec(odds), stake = num(b.stake);
    if (stake != null && stake <= 0) stake = null;
    var res = (b.result === 'win' || b.result === 'loss' || b.result === 'push') ? b.result : null;
    var pnl = null;
    if (res && stake != null && dec) pnl = res === 'win' ? r2(stake * (dec - 1)) : res === 'loss' ? -stake : 0;
    var clv = null;
    if (isNum(num(b.clv))) clv = { kind: 'price', v: num(b.clv) };
    else if (isNum(num(b.closeFair)) && dec) clv = { kind: 'price', v: dec / (1 / (num(b.closeFair) / 100)) - 1 };
    var beat = b.beat_close != null ? !!b.beat_close : (clv ? (clv.v > 0 ? true : clv.v < 0 ? false : null) : null);
    var sf = num(b.sharp_fair) != null ? num(b.sharp_fair) : (num(b.model) != null ? num(b.model) / 100 : null);
    return {
      id: String(b.id || ''), src: 'ledger', how: b.imported ? 'import' : (b.auto ? 'tracked' : 'manual'),
      sel: String(b.sel || '—'), sport: sportLabel(b.sport), market: marketLabel(b.market), book: b.book || null,
      odds: odds, dec: dec, stake: stake, units: null, ts: b.ts || null, commence: b.commence || null,
      result: res, pnl: pnl, clv: clv, beat_close: res === 'push' && beat == null ? null : beat,
      liveClv: isNum(num(b.liveClv)) ? num(b.liveClv) : null,
      entryEdge: (sf != null && dec) ? sf * dec - 1 : null, range: null
    };
  }
  function fromCard(p, g) {
    if (!p || typeof p !== 'object') return null;
    var odds = num(p.odds), dec = amToDec(odds), stake = num(p.stake_dollars), units = num(p.units);
    if (stake != null && stake <= 0) stake = null;
    var res = g && (g.result === 'win' || g.result === 'loss' || g.result === 'push') ? g.result : null;
    var pnl = null;
    if (res && stake != null && dec) pnl = res === 'win' ? r2(stake * (dec - 1)) : res === 'loss' ? -stake : 0;
    else if (res && g && isNum(num(g.units_won)) && isNum(num(p.unit_value))) pnl = r2(num(g.units_won) * num(p.unit_value));
    var pts = g && isNum(num(g.clv_points)) ? num(g.clv_points) : null;
    var line = num(p.line);
    var sel = (p.team || p.side || '—') + (line != null ? ' ' + (line > 0 ? '+' : '') + line : '');
    var range = p.entry_vs_recommendation === 'OUTSIDE_RANGE' ? 'outside'
      : (p.entry_vs_recommendation === 'INSIDE_RANGE' || p.entry_vs_recommendation === 'AT_EDGEDESK_PRICE') ? 'inside' : null;
    return {
      id: String(p.bet_key || ''), src: 'card', how: 'card', sel: sel,
      sport: sportLabel(p.sport), market: marketLabel(p.market_type || 'spread'), book: p.book || null,
      odds: odds, dec: dec, stake: stake, units: units, ts: p.placed_at || null, commence: p.kickoff || null,
      matchup: (p.away_team && p.home_team) ? p.away_team + ' @ ' + p.home_team : null,
      result: res, pnl: pnl, clv: pts != null ? { kind: 'points', v: pts } : null,
      beat_close: pts == null ? null : (pts > 0 ? true : pts < 0 ? false : null),
      liveClv: null, entryEdge: null, range: range, game_id: p.game_id || null
    };
  }
  /* gradeCard(p) → { result, clv_points, units_won } | null — injected so this
     file never has to know where the football record lives. */
  function collect(ledgerBets, cardBets, gradeCard) {
    var out = [];
    (ledgerBets || []).forEach(function (b) { var x = fromLedger(b); if (x) out.push(x); });
    (cardBets || []).forEach(function (p) { var g = null; try { g = gradeCard ? gradeCard(p) : null; } catch (e) { g = null; } var x = fromCard(p, g); if (x) out.push(x); });
    out.sort(function (a, b) { return (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0); });
    return out;
  }

  /* the day a position belongs to on the calendar and in "this week": the game
     when the reader logged one, otherwise the moment they logged it */
  function dayOf(p) { var t = Date.parse(p.commence || p.ts); return isFinite(t) ? t : null; }
  function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  /* ------------------------------------------------------------- totals */
  function summary(list) {
    var s = { n: list.length, open: 0, settled: 0, w: 0, l: 0, p: 0, staked: 0, pnl: 0, pnl_n: 0, unit_pnl: 0, unit_n: 0,
      open_staked: 0, open_to_win: 0, open_unstaked: 0, graded: 0, beat: 0, clv_price: [], clv_points: [] };
    list.forEach(function (x) {
      if (!x.result) {
        s.open++;
        if (x.stake != null) { s.open_staked += x.stake; if (x.dec) s.open_to_win += x.stake * (x.dec - 1); }
        else s.open_unstaked++;
      } else {
        s.settled++;
        if (x.result === 'win') s.w++; else if (x.result === 'loss') s.l++; else s.p++;
        if (x.result !== 'push') {
          if (x.pnl != null && x.stake != null) { s.staked += x.stake; s.pnl += x.pnl; s.pnl_n++; }
          if (x.dec) { s.unit_pnl += x.result === 'win' ? x.dec - 1 : -1; s.unit_n++; }
        }
      }
      if (x.beat_close != null) { s.graded++; if (x.beat_close) s.beat++; }
      if (x.clv && x.clv.kind === 'price') s.clv_price.push(x.clv.v);
      if (x.clv && x.clv.kind === 'points') s.clv_points.push(x.clv.v);
    });
    function avg(a) { return a.length ? a.reduce(function (m, v) { return m + v; }, 0) / a.length : null; }
    s.pnl = r2(s.pnl); s.staked = r2(s.staked); s.open_staked = r2(s.open_staked); s.open_to_win = r2(s.open_to_win);
    s.roi = s.staked > 0 ? s.pnl / s.staked : null;
    s.unit_roi = s.unit_n ? s.unit_pnl / s.unit_n : null;
    s.unit_pnl = r2(s.unit_pnl);
    s.beat_rate = s.graded ? s.beat / s.graded : null;
    s.avg_clv_price = avg(s.clv_price); s.avg_clv_points = avg(s.clv_points);
    s.clv_price_n = s.clv_price.length; s.clv_points_n = s.clv_points.length;
    delete s.clv_price; delete s.clv_points;
    return s;
  }
  /* ------------------------------------------------------------ rendering
     every value that reaches HTML is escaped: selections and books can come
     from a sportsbook feed or from the reader's own typing */
  function when(ms) {
    if (!isNum(ms)) return '';
    try { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
  function tone(x) { return !isNum(x) ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : ''; }
  function posRow(x, fmt) {
    var o = (fmt && fmt.odds) ? fmt.odds(x.odds) : fmtAm(x.odds);
    var right = x.result
      ? '<span class="pf-res ' + (x.result === 'win' ? 'up' : x.result === 'loss' ? 'dn' : '') + '">' + x.result.toUpperCase() + (x.pnl != null && x.result !== 'push' ? ' ' + money(x.pnl, true) : '') + '</span>'
      : (x.liveClv != null ? '<span class="pf-live ' + tone(x.liveClv) + '">' + pct(x.liveClv, true) + ' since logged</span>' : '<span class="pf-live">open</span>');
    var meta = [x.sport, x.market, x.book, o, x.stake != null ? money(x.stake) : (x.units != null ? x.units + 'u' : 'no stake'), x.src === 'card' ? 'from Card' : (x.how === 'import' ? 'imported' : null)]
      .filter(Boolean).map(esc).join(' · ');
    var t = dayOf(x);
    return '<div class="pf-pos"><div class="pf-pos-l"><b>' + esc(x.sel) + '</b><span>' + meta + (t != null ? ' · ' + esc(when(t)) : '') + '</span></div>' + right + '</div>';
  }
  function cardListHTML(list, fmt, title) {
    if (!list.length) return '';
    return '<div class="pf-sec"><div class="pf-h">' + esc(title) + ' <span>' + list.length + '</span></div>' + list.map(function (x) { return posRow(x, fmt); }).join('')
      + '<div class="pf-note">Recorded from the EdgeDesk Card with BET PLACED. Their full receipt — your price against EdgeDesk’s — stays on the Card.</div></div>';
  }

  return {
    VERSION: VERSION, amToDec: amToDec, fromLedger: fromLedger, fromCard: fromCard, collect: collect, summary: summary,
    posRow: posRow, cardListHTML: cardListHTML, money: money, pct: pct, dayOf: dayOf, marketLabel: marketLabel, sportLabel: sportLabel
  };
}));
