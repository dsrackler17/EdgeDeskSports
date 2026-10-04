/* ===========================================================================
   EdgeDesk PORTFOLIO — what the reader actually did, and whether they are up
   or down.

   This is the reader's own activity and nothing else. EdgeDesk's model record
   (More → Model performance) is a different question and never enters here:
   no number below is read from `signals`, `record/pnl/` or any recommendation
   ledger except to GRADE a position the reader logged.

   Sources (none of them is new; this file only reads them together):
     ledger  localStorage `edgedesk_bets` — a price tracked from an edge, a bet
             logged by hand, or a row imported from a file. Auto-settled
             against `signals` by the app when it has an event link.
     card    the EdgeDesk Card's BET PLACED records (EDDecisionUI.placed()),
             graded against the committed football record when available.

   Pure: no DOM, no storage, no network. Browser: window.EDPortfolio.
   Node: require('./edgedesk_portfolio.js'). Held by
   tools/app/portfolio_process.test.js.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDPortfolio = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_portfolio_v1';
  var TABS = ['overview', 'open', 'calendar', 'history', 'accounts'];

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* American → decimal. null for anything that is not a real price. */
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decToAm(d) { d = num(d); if (d == null || d <= 1) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
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

  /* ------------------------------------------------------------- overview */
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
  function overview(positions, now) {
    now = now || Date.now();
    var all = positions || [];
    var s = summary(all);
    var weekAgo = now - 7 * 864e5;
    var wk = summary(all.filter(function (x) { var t = dayOf(x); return x.result && t != null && t >= weekAgo && t <= now; }));
    var activity = [];
    all.forEach(function (x) {
      var t = Date.parse(x.ts); if (isFinite(t)) activity.push({ kind: 'logged', at: t, p: x });
      if (x.result) { var g = dayOf(x); if (g != null) activity.push({ kind: 'settled', at: Math.max(g, isFinite(t) ? t : 0), p: x }); }
    });
    activity.sort(function (a, b) { return b.at - a.at; });
    var open = all.filter(function (x) { return !x.result; })
      .sort(function (a, b) { return (Date.parse(a.commence) || Infinity) - (Date.parse(b.commence) || Infinity); });
    return { totals: s, week: wk, open: open.slice(0, 4), open_n: open.length, activity: activity.slice(0, 6), empty: !all.length,
      sources: { ledger: all.filter(function (x) { return x.src === 'ledger'; }).length, card: all.filter(function (x) { return x.src === 'card'; }).length } };
  }

  /* ------------------------------------------------------------- calendar
     A month of settled positions by day. Dollars where the positions carried a
     stake; the W-L count always, so a reader who never enters stakes still has
     a calendar. Days are the reader's local days. */
  function calendar(positions, year, month) {
    var days = {}, first = new Date(year, month, 1), last = new Date(year, month + 1, 0);
    (positions || []).forEach(function (x) {
      if (!x.result) return;
      var t = dayOf(x); if (t == null) return;
      var d = new Date(t); if (d.getFullYear() !== year || d.getMonth() !== month) return;
      var k = d.getDate(), c = days[k] || (days[k] = { n: 0, w: 0, l: 0, p: 0, pnl: 0, staked: 0, has_dollars: false });
      c.n++; if (x.result === 'win') c.w++; else if (x.result === 'loss') c.l++; else c.p++;
      if (x.pnl != null && x.stake != null && x.result !== 'push') { c.pnl = r2(c.pnl + x.pnl); c.staked += x.stake; c.has_dollars = true; }
    });
    var cells = [], lead = first.getDay();
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var dd = 1; dd <= last.getDate(); dd++) cells.push(Object.assign({ day: dd }, days[dd] || { n: 0 }));
    while (cells.length % 7) cells.push(null);
    var month_pnl = 0, month_n = 0, dollars = false, w = 0, l = 0, p = 0;
    Object.keys(days).forEach(function (k) { var c = days[k]; month_n += c.n; w += c.w; l += c.l; p += c.p; if (c.has_dollars) { month_pnl += c.pnl; dollars = true; } });
    return { year: year, month: month, cells: cells, n: month_n, w: w, l: l, p: p, pnl: dollars ? r2(month_pnl) : null };
  }

  /* --------------------------------------------------------------- import
     A CSV of the reader's own history, mapped by header name, into ledger rows.
     It never guesses a result or a stake: a missing result is an open position,
     a missing stake is an unstaked one. Rows that cannot be read are reported
     with the reason, not silently dropped. */
  var HEAD = {
    date: /^(date|placed|placed_at|placed at|time|datetime|bet date|date placed)$/,
    sel: /^(selection|bet|pick|description|wager|sel|market selection|bet description)$/,
    odds: /^(odds|price|american|american odds|line odds)$/,
    stake: /^(stake|risk|amount|wager amount|risked|stake \$|bet amount)$/,
    result: /^(result|status|outcome|grade|settled)$/,
    sport: /^(sport|league)$/,
    book: /^(book|sportsbook|site|operator)$/,
    game: /^(game date|event date|start|kickoff|commence|event time)$/
  };
  function splitCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (q) { if (c === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function parseOdds(s) {
    s = String(s == null ? '' : s).trim().replace(/^\+/, '');
    if (!s) return null;
    var n = Number(s); if (!isFinite(n)) return null;
    if (Math.abs(n) >= 100) return Math.round(n);               // American
    if (n > 1 && n < 100 && /\./.test(s)) return decToAm(n);     // decimal, e.g. 1.91
    return null;
  }
  function parseResult(s) {
    var k = String(s == null ? '' : s).trim().toLowerCase();
    if (/^(w|win|won|winner)$/.test(k)) return 'win';
    if (/^(l|loss|lost|lose|loser)$/.test(k)) return 'loss';
    if (/^(p|push|void|refund|refunded|cancelled|canceled|no action|draw)$/.test(k)) return 'push';
    return null;
  }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
  function parseCsv(text, now) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return l.trim(); });
    if (lines.length < 2) return { rows: [], errors: ['The file needs a header row and at least one bet.'], columns: {} };
    var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase().replace(/[_]+/g, ' ').trim(); });
    var col = {};
    Object.keys(HEAD).forEach(function (k) { for (var i = 0; i < head.length; i++) if (HEAD[k].test(head[i])) { col[k] = i; break; } });
    var errors = [];
    if (col.sel == null) errors.push('No selection column (looked for: selection, bet, pick, description).');
    if (col.odds == null) errors.push('No odds column (looked for: odds, price, american).');
    if (errors.length) return { rows: [], errors: errors, columns: col };
    var rows = [], seen = {};
    for (var li = 1; li < lines.length; li++) {
      var f = splitCsvLine(lines[li]);
      var sel = f[col.sel] || '', odds = parseOdds(f[col.odds]);
      if (!sel) { errors.push('Row ' + (li + 1) + ': no selection.'); continue; }
      if (odds == null) { errors.push('Row ' + (li + 1) + ': odds "' + (f[col.odds] || '') + '" are not American (−110, +150) or decimal (1.91).'); continue; }
      var t = col.date != null ? Date.parse(f[col.date]) : NaN;
      var ts = isFinite(t) ? new Date(t).toISOString() : new Date(now || Date.now()).toISOString();
      var g = col.game != null ? Date.parse(f[col.game]) : NaN;
      var stake = col.stake != null ? num(String(f[col.stake] || '').replace(/[$,\s]/g, '')) : null;
      if (stake != null && stake <= 0) stake = null;
      var res = col.result != null ? parseResult(f[col.result]) : null;
      var dec = amToDec(odds);
      var key = 'imp_' + hash([ts, sel, odds, stake].join('|'));
      if (seen[key]) continue; seen[key] = 1;
      rows.push({ id: key, ts: ts, sport: col.sport != null ? f[col.sport] || '' : '', sel: sel, book: col.book != null ? f[col.book] || '' : '',
        odds: odds, stake: stake, model: null, closeFair: null, result: res,
        pnl: res && stake != null ? (res === 'win' ? r2(stake * (dec - 1)) : res === 'loss' ? -stake : 0) : null,
        commence: isFinite(g) ? new Date(g).toISOString() : null, auto: false, imported: true, manual: !!res });
    }
    return { rows: rows, errors: errors, columns: col };
  }
  /* merge imported rows into the ledger without duplicating a re-import */
  function mergeImport(existing, rows) {
    var have = {}; (existing || []).forEach(function (b) { if (b && b.id) have[b.id] = 1; });
    var add = (rows || []).filter(function (r) { return !have[r.id]; });
    return { list: add.concat(existing || []), added: add.length, skipped: (rows || []).length - add.length };
  }

  /* ------------------------------------------------------------ rendering */
  function kpi(v, l, cls, note) {
    return '<div class="pf-kpi' + (cls ? ' ' + cls : '') + '"><div class="v">' + v + '</div><div class="l">' + esc(l) + '</div>' + (note ? '<div class="n">' + esc(note) + '</div>' : '') + '</div>';
  }
  function tone(x) { return !isNum(x) ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : ''; }
  function when(ms) {
    if (!isNum(ms)) return '';
    try { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
  }
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
  function emptyHTML() {
    return '<div class="pf-empty"><div class="pf-ey">Build your portfolio</div>'
      + '<div class="pf-t">Bring in where you bet to see your P&amp;L, history, calendar and performance.</div>'
      + '<ul class="pf-ul"><li><b>P&amp;L and ROI</b> — are you up or down, in dollars when you record stakes</li><li><b>History and calendar</b> — every settled position, by day</li><li><b>Performance</b> — how often your prices beat the close, which feeds Process</li></ul>'
      + '<div class="pf-acts"><button type="button" class="btn" data-pf-go="accounts">Connect accounts</button></div>'
      + '<div class="pf-note">Today that means importing a file from your sportsbook or logging bets here. EdgeDesk does not sync with sportsbooks or prediction markets yet and will not pretend to.</div></div>';
  }
  function overviewHTML(ov, fmt) {
    if (ov.empty) return emptyHTML();
    var s = ov.totals;
    var head = s.pnl_n
      ? kpi(money(s.pnl, true), 'Profit & loss', tone(s.pnl), s.pnl_n + ' settled with a stake') + kpi(pct(s.roi, true), 'ROI', tone(s.roi), 'on ' + money(s.staked) + ' risked')
      : kpi(isNum(s.unit_pnl) && s.unit_n ? (s.unit_pnl > 0 ? '+' : '') + s.unit_pnl.toFixed(2) + 'u' : '—', 'Profit & loss (flat 1u)', tone(s.unit_pnl), s.unit_n ? 'no stakes recorded, so each position counts 1 unit' : 'nothing settled yet')
        + kpi(pct(s.unit_roi, true), 'ROI (flat 1u)', tone(s.unit_roi), s.unit_n ? s.unit_n + ' settled' : '');
    var h = '<div class="pf-hero">' + head
      + kpi(s.open_staked ? money(s.open_staked) : String(s.open), 'Open exposure', '', s.open + ' open' + (s.open_staked ? ' · to win ' + money(s.open_to_win) : '') + (s.open_unstaked && s.open_staked ? ' · ' + s.open_unstaked + ' unstaked' : ''))
      + kpi(s.w + '-' + s.l + (s.p ? '-' + s.p : ''), 'Record', '', s.settled + ' settled')
      + '</div>';
    if (ov.week.settled) h += '<div class="pf-week">This week: <b class="' + tone(ov.week.pnl_n ? ov.week.pnl : ov.week.unit_pnl) + '">' + (ov.week.pnl_n ? money(ov.week.pnl, true) : ((ov.week.unit_pnl > 0 ? '+' : '') + ov.week.unit_pnl.toFixed(2) + 'u')) + '</b> on ' + ov.week.settled + ' settled (' + ov.week.w + '-' + ov.week.l + (ov.week.p ? '-' + ov.week.p : '') + ')</div>';
    h += '<div class="pf-sec"><div class="pf-h">Current positions <span>' + ov.open_n + '</span>' + (ov.open_n ? '<button type="button" class="pf-more" data-pf-go="open">All open ›</button>' : '') + '</div>'
      + (ov.open.length ? ov.open.map(function (x) { return posRow(x, fmt); }).join('') : '<div class="pf-none">Nothing open right now.</div>') + '</div>';
    h += '<div class="pf-sec"><div class="pf-h">Recent activity<button type="button" class="pf-more" data-pf-go="history">History ›</button></div>'
      + (ov.activity.length ? ov.activity.map(function (a) { return '<div class="pf-act"><span class="k">' + (a.kind === 'logged' ? 'Logged' : 'Settled') + '</span>' + posRow(a.p, fmt) + '</div>'; }).join('') : '<div class="pf-none">No activity yet.</div>') + '</div>';
    if (s.graded) h += '<div class="pf-note">Price quality: ' + s.beat + ' of ' + s.graded + ' graded positions beat the closing line'
      + (s.avg_clv_price != null ? ' · average CLV ' + pct(s.avg_clv_price, true) : '') + (s.avg_clv_points != null ? ' · ' + (s.avg_clv_points > 0 ? '+' : '') + s.avg_clv_points.toFixed(1) + ' pts on spreads' : '')
      + '. <button type="button" class="pf-link" data-nav="process">What does that say about your process? ›</button></div>';
    return h;
  }
  /* a day cell is ~48px on a phone: whole dollars, thousands as k */
  function short$(x) {
    if (!isNum(x)) return '';
    var a = Math.abs(x), v = a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k' : String(Math.round(a));
    return (x > 0 ? '+' : x < 0 ? '−' : '') + '$' + v;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function calendarHTML(cal) {
    var h = '<div class="pf-cal-hd"><button type="button" class="pf-cal-nav" data-pf-cal="-1" aria-label="Previous month">‹</button>'
      + '<b>' + MONTHS[cal.month] + ' ' + cal.year + '</b><button type="button" class="pf-cal-nav" data-pf-cal="1" aria-label="Next month">›</button></div>'
      + '<div class="pf-cal-sum">' + (cal.n ? (cal.pnl != null ? '<b class="' + tone(cal.pnl) + '">' + money(cal.pnl, true) + '</b> · ' : '') + cal.w + '-' + cal.l + (cal.p ? '-' + cal.p : '') + ' on ' + cal.n + ' settled' : 'Nothing settled this month.') + '</div>'
      + '<div class="pf-cal" role="grid">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (d) { return '<div class="pf-cal-dow">' + d + '</div>'; }).join('');
    cal.cells.forEach(function (c) {
      if (!c) { h += '<div class="pf-cal-c x"></div>'; return; }
      var v = c.n ? (c.has_dollars ? short$(c.pnl) : c.w + '-' + c.l) : '';
      var cls = c.n ? (c.has_dollars ? tone(c.pnl) : (c.w > c.l ? 'up' : c.l > c.w ? 'dn' : '')) : '';
      h += '<div class="pf-cal-c ' + cls + (c.n ? ' on' : '') + '" role="gridcell"><span class="d">' + c.day + '</span>' + (v ? '<span class="v">' + esc(v) + '</span>' : '') + '</div>';
    });
    return h + '</div><div class="pf-note">Each position sits on the day of its game, or the day you logged it when no game time was recorded.</div>';
  }
  function cardListHTML(list, fmt, title) {
    if (!list.length) return '';
    return '<div class="pf-sec"><div class="pf-h">' + esc(title) + ' <span>' + list.length + '</span></div>' + list.map(function (x) { return posRow(x, fmt); }).join('')
      + '<div class="pf-note">Recorded from the EdgeDesk Card with BET PLACED. Their full receipt — your price against EdgeDesk’s — stays on the Card.</div></div>';
  }
  function sourcesHTML(ov) {
    var n = ov.sources;
    return '<div class="pf-src"><div class="pf-src-r"><b>Logged on this device</b><span>' + n.ledger + ' position' + (n.ledger === 1 ? '' : 's') + ' · tracked from an edge, logged by hand, or imported. Saved in this browser only.</span></div>'
      + '<div class="pf-src-r"><b>EdgeDesk Card</b><span>' + n.card + ' bet' + (n.card === 1 ? '' : 's') + ' marked BET PLACED · saved to your account when you are signed in.</span></div>'
      + '<div class="pf-src-r off"><b>Sportsbook &amp; prediction-market connections</b><span>Not available yet. Nothing syncs automatically; export your history from your book and import it below.</span></div></div>';
  }

  return {
    VERSION: VERSION, TABS: TABS,
    amToDec: amToDec, decToAm: decToAm, fromLedger: fromLedger, fromCard: fromCard, collect: collect,
    summary: summary, overview: overview, calendar: calendar, parseCsv: parseCsv, mergeImport: mergeImport,
    overviewHTML: overviewHTML, calendarHTML: calendarHTML, cardListHTML: cardListHTML, sourcesHTML: sourcesHTML, emptyHTML: emptyHTML,
    posRow: posRow, money: money, pct: pct, dayOf: dayOf, dayKey: dayKey, marketLabel: marketLabel, sportLabel: sportLabel
  };
}));
