/* ===========================================================================
   EdgeDesk BET CHECKER — the page's arithmetic and words, with no DOM.
   docs/bet-checker.md

   The grade itself is NEVER decided here. supabase/bet_checker.sql decides it
   (bet_checker_log_bet, bet_checker_grade_pending) and its thresholds live in
   one constant, public.bet_checker_rules(); this file only says, in plain
   words, what the database already decided — and refuses to say more than it
   knows: an ungraded bet says why, a close that is not available says so.

     americanToProb / americanToDecimal / probToAmerican / centsToAmerican
     fmtOdds, fmtPct, fmtLine, sideLabel, betTitle
     gradeView(bet)    the entry grade chip and its sentence
     closeView(bet)    CLV, or "no close available", or "after the close"
     resultView(bet)   the result once settled
     usageLine(usage)  "3 of 10 grades used this month"
     check(form)       the form's shape, before anything is sent
     newClientKey()    makes a double submit one bet

   Browser: window.EDBetCheckerCore. Node: require('./edgedesk_bet_checker_core.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDBetCheckerCore = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = { VERSION: 'edgedesk_bet_checker_core/1' };

  /* what the form offers; the database refuses anything else */
  X.BOOKS = ['DraftKings', 'Kalshi', 'DK Predictions', 'Other'];
  X.PREDICTION_MARKETS = ['Kalshi', 'DK Predictions'];
  X.MARKETS = [
    { key: 'spread', label: 'Spread', sides: ['away', 'home'] },
    { key: 'total', label: 'Total', sides: ['over', 'under'] },
    { key: 'moneyline', label: 'Moneyline', sides: ['away', 'home'] }
  ];

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  X.num = num;

  /* ── odds ─────────────────────────────────────────────────────────────── */
  X.americanToProb = function (a) {
    a = num(a); if (a == null || Math.abs(a) < 100) return null;
    return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
  };
  X.americanToDecimal = function (a) {
    a = num(a); if (a == null || Math.abs(a) < 100) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
  };
  X.probToAmerican = function (p) {
    p = num(p); if (p == null || p <= 0 || p >= 1) return null;
    return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  };
  /* A prediction market's price per $1 contract, in cents, as American odds.
     The reader enters the ALL-IN price (fees included), so the conversion is
     exact arithmetic, not an estimate of anything. */
  X.centsToAmerican = function (c) {
    c = num(c); if (c == null || c <= 0 || c >= 100) return null;
    return X.probToAmerican(c / 100);
  };

  /* ── words ────────────────────────────────────────────────────────────── */
  X.fmtOdds = function (a) {
    a = num(a); if (a == null) return '—';
    return a > 0 ? '+' + Math.round(a) : String(Math.round(a));
  };
  X.fmtPct = function (v, digits) {
    v = num(v); if (v == null) return '—';
    var d = digits == null ? 2 : digits;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%';
  };
  X.fmtPts = function (v) {
    v = num(v); if (v == null) return '—';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' pts';
  };
  X.fmtLine = function (market, line) {
    line = num(line);
    if (market === 'moneyline' || line == null) return '';
    if (market === 'total') return String(line);
    return (line > 0 ? '+' : line < 0 ? '−' : '') + String(Math.abs(line));
  };
  X.sideLabel = function (b) {
    if (!b) return '';
    if (b.market === 'total') return (b.side === 'over' ? 'Over ' : 'Under ') + X.fmtLine('total', b.line);
    var team = b.team || (b.side === 'home' ? b.home_team : b.away_team) || (b.side === 'home' ? 'Home' : 'Away');
    return b.market === 'moneyline' ? team + ' ML' : team + ' ' + X.fmtLine('spread', b.line);
  };
  X.betTitle = function (b) {
    if (!b) return '';
    return (b.away_team || 'Away') + ' at ' + (b.home_team || 'Home');
  };

  /* every reason the database can give, as a sentence a reader can act on */
  X.ENTRY_REASONS = {
    no_fair_price_at_line: 'EdgeDesk has no fair price at exactly this line, so this bet has no entry grade. We never estimate one from a nearby line.',
    fair_price_stale: 'EdgeDesk’s last fair price for this line is too old to call current, so this bet has no entry grade.',
    free_limit_reached: 'You have used this month’s free grades. The bet is saved, and its CLV still arrives after the close.',
    not_logged_through_bet_checker: 'Recorded outside Bet Checker, so it has no entry grade.'
  };
  X.CLOSE_REASONS = {
    line_pulled_no_close: 'The market closed at a different line, so there is no closing price at yours. Nothing is adjusted or estimated.',
    line_not_on_board_at_close: 'EdgeDesk never priced this line, so there is no closing price for it.',
    no_close_captured: 'No close was captured for this game.',
    no_close_reference: 'The close had too few independent books to give a fair price.',
    invalid_close_fair: 'The close did not produce a valid fair price.',
    implausible_close_price: 'The closing price failed EdgeDesk’s sanity checks.',
    incoherent_close_market: 'The closing market was not coherent enough to price.',
    no_sharp_at_close: 'No reference book was quoting this market at the close.',
    missed_close_window: 'The close was not captured inside its window.',
    no_close_price: 'No closing price was available.'
  };

  X.gradeView = function (b) {
    var g = b && b.entry_grade;
    if (g === 'green' || g === 'yellow' || g === 'red') {
      var label = g === 'green' ? 'Beat fair' : g === 'red' ? 'Below fair' : 'Near fair';
      return { cls: g, label: label, edge: X.fmtPts(b.entry_edge_pct), fair: X.fmtOdds(b.entry_fair_price),
               sentence: 'Your ' + X.fmtOdds(b.odds) + ' vs EdgeDesk fair ' + X.fmtOdds(b.entry_fair_price) + ': ' +
                         X.fmtPts(b.entry_edge_pct) + ' of implied probability.' };
    }
    var why = b && b.entry_grade_reason;
    return { cls: 'ungraded', label: why === 'free_limit_reached' ? 'Not graded — free limit' : 'Not graded', edge: null, fair: null,
             sentence: X.ENTRY_REASONS[why] || 'This bet has no entry grade.' };
  };

  X.closeView = function (b) {
    var st = b && b.close_status;
    if (st === 'captured') {
      return { cls: num(b.clv_pct) > 0 ? 'beat' : num(b.clv_pct) < 0 ? 'lost' : 'even', label: 'CLV ' + X.fmtPct(b.clv_pct),
               sentence: 'Closed ' + X.fmtOdds(b.closing_price != null ? b.closing_price : b.close_odds) + ' (no-vig) at your line' +
                         (b.market === 'moneyline' ? '' : ' ' + X.fmtLine(b.market, b.line)) + '. ' +
                         (num(b.clv_pct) > 0 ? 'You beat the close.' : num(b.clv_pct) < 0 ? 'The close beat you.' : 'Even with the close.') };
    }
    if (st === 'no_close_available') {
      var at = b.closing_line != null ? b.closing_line : b.close_line;
      return { cls: 'none', label: 'No close available',
               sentence: (X.CLOSE_REASONS[b.close_reason] || 'No closing price is available for this bet.') +
                         (at != null && b.market !== 'moneyline' && num(at) !== num(b.line) ? ' The market closed at ' + X.fmtLine(b.market, at) + '.' : '') };
    }
    return { cls: 'pending', label: 'CLV after the close', sentence: 'Graded against EdgeDesk’s captured close once the game starts.' };
  };

  X.resultView = function (b) {
    var r = b && b.result;
    if (r === 'win') return { cls: 'win', label: 'Won', units: num(b.units_won) };
    if (r === 'loss') return { cls: 'loss', label: 'Lost', units: num(b.units_won) };
    if (r === 'push') return { cls: 'push', label: 'Push', units: 0 };
    if (r === 'void') return { cls: 'void', label: 'Void', units: 0 };
    return { cls: 'pending', label: 'Pending', units: null };
  };

  X.usageLine = function (u) {
    if (!u) return '';
    if (u.paid) return 'Unlimited grades';
    var used = Math.min(Number(u.free_grades_used || 0), Number(u.free_limit || 0));
    return used + ' of ' + u.free_limit + ' grades used this month';
  };

  /* the rules' words, from what the database answered (bet_checker_rules) */
  X.legend = function (rules) {
    var g = rules && num(rules.green_min_edge_pct), r = rules && num(rules.red_max_edge_pct);
    if (g == null || r == null) return null;
    return { green: 'Green: your price beats EdgeDesk’s fair by ' + g + ' points of implied probability or more',
             yellow: 'Yellow: within ' + g + ' points either way',
             red: 'Red: ' + Math.abs(r) + ' points or more worse than fair' };
  };

  /* ── the form ─────────────────────────────────────────────────────────── */
  X.check = function (f) {
    var o = f || {};
    var m = null;
    for (var i = 0; i < X.MARKETS.length; i++) if (X.MARKETS[i].key === o.market) m = X.MARKETS[i];
    if (!o.event_id) return { ok: false, field: 'game', message: 'Pick a game.' };
    if (!m) return { ok: false, field: 'market', message: 'Pick a market.' };
    if (m.sides.indexOf(o.side) < 0) return { ok: false, field: 'side', message: 'Pick a side.' };
    var line = m.key === 'moneyline' ? null : num(o.line);
    if (m.key !== 'moneyline' && line == null) return { ok: false, field: 'line', message: 'Enter the line you took.' };
    var odds = num(o.odds);
    if (odds == null || Math.round(odds) !== odds || Math.abs(odds) < 100) return { ok: false, field: 'odds', message: 'Enter American odds, like -110 or +150.' };
    if (X.BOOKS.indexOf(o.book) < 0) return { ok: false, field: 'book', message: 'Pick the book.' };
    var units = o.stake_units === '' || o.stake_units == null ? 1 : num(o.stake_units);
    if (units == null || units <= 0 || units > 100) return { ok: false, field: 'stake', message: 'Stake is between 0 and 100 units.' };
    return { ok: true, bet: { event_id: o.event_id, market: m.key, side: o.side, line: line, odds: odds, book: o.book, stake_units: units } };
  };

  X.newClientKey = function () {
    var a = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '', b = null;
    try { if (typeof crypto !== 'undefined' && crypto.getRandomValues) { b = new Uint8Array(20); crypto.getRandomValues(b); } } catch (_) { b = null; }
    for (var i = 0; i < 20; i++) s += a.charAt((b ? b[i] : Math.floor(Math.random() * 256)) % a.length);
    return s;
  };

  /* a stats row as the page prints it */
  X.statRow = function (r) {
    if (!r) return null;
    return { label: r.val, bets: r.bets || 0, graded: r.graded || 0,
             clv_rate: r.clv_rate_pct == null ? '—' : num(r.clv_rate_pct).toFixed(0) + '%',
             avg_edge: r.avg_entry_edge_pct == null ? '—' : X.fmtPts(r.avg_entry_edge_pct),
             avg_clv: r.avg_clv_pct == null ? '—' : X.fmtPct(r.avg_clv_pct),
             clv_bets: r.clv_bets || 0 };
  };

  return X;
}));
