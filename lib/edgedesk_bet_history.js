/* ===========================================================================
   EDGEDESK BET HISTORY — private performance intelligence over a reader's
   own sportsbook tickets.
   docs/portfolio-architecture.md § Bet-history intelligence

   One question: "Why did I lose money on my recent bets, and were my singles
   or parlays more profitable?" — answered from the reader's own history,
   exactly, with every figure's sample size beside it.

   TWO INPUTS, ONE ANALYSIS
     fromCSV(text)          a bet-tracker export (Juice Reel style). Rows are
                            grouped into TICKETS by the ticket id with the
                            Portfolio importer's leg-row adapter
                            (EDPortfolioImport, leg_rows_sportsbook_v1): a
                            3-leg parlay exported as 3 rows is ONE ticket with
                            3 legs, and its stake is counted once. The CSV is
                            parsed here, in the reader's browser.
     fromPositions(rows)    the reader's stored portfolio_positions rows (read
                            under row level security), legs jsonb included.

   EXACT MONEY
     Every amount is an exact decimal string, computed with EDPortfolio's
     BigInt decimals and its derive() rules (the database trigger's rules) —
     never a binary float. Money is reported to the cent ("-183.55"); ratios
     (ROI, win rate, shares) to six places, rounded half away from zero.

   WHAT COUNTS
     settled     WON / LOST / PUSH (and a book's re-priced SETTLED): in P&L,
                 risked and ROI.
     cashed out  in P&L, risked and ROI at what the book actually paid;
                 kept apart from the win rate.
     open        not in P&L; reported as open exposure (stake at risk).
     void        left out of everything (the stake came back).
     excluded    a ticket whose own rows disagree on its stake, price or
                 result, or whose P&L cannot be computed: listed, never guessed.
     ROI = net P&L / risked (settled + cashed out). Win rate = wins / (wins +
     losses). Groups under 30 counted tickets are labelled "small sample".

   WHAT IT NEVER SAYS
     answer() describes the past only. It never implies past results predict
     future profit and never suggests betting more to get money back;
     checkLanguage() is the guard the tests run on every answer.

   Browser: window.EDBETS.   Node: require('./edgedesk_bet_history.js').
   =========================================================================== */
(function (root, factory) {
  var req = typeof require === 'function' ? require : null;
  var E = root.EDPortfolio || (req ? req('./edgedesk_portfolio.js') : null);
  var I = root.EDPortfolioImport || (req ? req('./edgedesk_portfolio_import.js') : null);
  var api = factory(E, I);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDBETS = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E, I) {
  'use strict';

  var VERSION = 'bet_history_v1';
  var D = E.dec;
  var SMALL_SAMPLE = 30;
  var DAY_SHARE = '0.25';
  var QUESTION = 'Why did I lose money on my recent bets, and were my singles or parlays more profitable?';

  /* ═══ 1. VOCABULARY ═══════════════════════════════════════════════════ */
  /* price bands, by the ticket's American price (exact decimal bounds when
     only a decimal price exists: -200 ⇔ 1.5, -110 ⇔ 21/11, +100 ⇔ 2,
     +200 ⇔ 3, +500 ⇔ 6) */
  var ODDS_RANGES = [
    { key: 'LE_M200', label: '≤ −200' },
    { key: 'M199_M110', label: '−199 to −110' },
    { key: 'M109_P100', label: '−109 to +100' },
    { key: 'P101_P200', label: '+101 to +200' },
    { key: 'P201_P500', label: '+201 to +500' },
    { key: 'GT_P500', label: '> +500' },
    { key: 'NO_PRICE', label: 'No price recorded' }
  ];
  /* stake bands, in dollars: [from, to) */
  var STAKE_BANDS = [
    { key: 'S0', from: '0', to: '10', label: 'Under $10' },
    { key: 'S10', from: '10', to: '25', label: '$10–$24.99' },
    { key: 'S25', from: '25', to: '50', label: '$25–$49.99' },
    { key: 'S50', from: '50', to: '100', label: '$50–$99.99' },
    { key: 'S100', from: '100', to: '250', label: '$100–$249.99' },
    { key: 'S250', from: '250', to: '500', label: '$250–$499.99' },
    { key: 'S500', from: '500', to: null, label: '$500 and over' }
  ];
  var BET_TYPE_LABEL = { SINGLE: 'Single', PARLAY: 'Parlay', SAME_GAME_PARLAY: 'Same-game parlay', TEASER: 'Teaser', ROUND_ROBIN: 'Round robin' };
  /* the ticket-level fields whose disagreement makes a ticket's P&L unknowable (the importer's list) */
  var MONEY_CONFLICTS = I.TICKET_MONEY_FIELDS;
  /* what each data-quality code means, in words */
  var ISSUE_LABEL = {
    NO_TICKET_ID: 'Rows with no ticket id, counted as singles', TICKET_FIELDS_DIFFER: 'Tickets whose rows disagree on stake, price, result or dates',
    DUPLICATE_ROW_MERGED: 'Duplicate rows counted once', DUPLICATE_LEG_DIFFERS: 'A leg listed twice with different details',
    LEG_COUNT_MISMATCH: 'Leg count differs from the leg rows', LEG_STATUS_DISAGREES: 'Ticket result differs from its legs', BET_TYPE_DISAGREES: 'Bet type differs from the legs',
    ODDS_FROM_LEGS: 'Parlay priced from its legs (no ticket price)', STATUS_FROM_LEGS: 'Ticket result read from its legs',
    SETTLED_BEFORE_PLACED: 'Settled before it was placed', PAYOUT_MISMATCH: 'Payout differs from what the price pays', UNKNOWN_STATUS: 'Unknown status (read as pending)',
    PNL_UNKNOWN: 'No price or payout to compute P&L', NO_STAKE: 'No usable stake', BAD_ODDS: 'Odds unreadable', BAD_STAKE: 'Stake unreadable',
    AMBIGUOUS_DECIMAL: 'Decimal comma in an amount', BAD_PLACED_AT: 'Placed date unreadable', PAYOUT_NEEDED: 'Cash-out with no amount paid',
    BAD_PLATFORM: 'No sportsbook named', FUTURE_PLACED_AT: 'Placed in the future', MISSING_EVENT_NAME: 'No event', MISSING_SELECTION: 'No selection'
  };

  function up(x) { return x == null ? null : (String(x).trim().toUpperCase() || null); }
  function txt(x) { return x == null ? null : (String(x).trim() || null); }
  function num(x) { return x == null || x === '' || !D.valid(x) ? null : D.str(x); }
  function cents(x) { return D.fixed(x == null ? '0' : x, 2); }
  function ratio(a, b) { return D.sign(b) > 0 ? D.divRound(a, b, 6) : null; }
  function ms(x) { var t = Date.parse(x); return x && isFinite(t) ? t : null; }
  function absS(x) { return D.sign(x) < 0 ? D.sub('0', x) : D.str(x); }
  /* the local day of an instant: EDPortfolio.localDate's format, with one
     formatter per zone (building one per ticket is what made big books slow) */
  var DAY_FMT = {};
  function localDay(t, tz) {
    var k = tz || 'UTC', f = DAY_FMT[k];
    if (f === undefined) {
      try { f = new Intl.DateTimeFormat('en-CA', { timeZone: k, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch (_) { f = null; }
      DAY_FMT[k] = f;
    }
    return f ? f.format(new Date(t)) : E.localDate(t, k);
  }

  /* a price as an exact fraction (num / den = decimal odds) */
  function priceFraction(american, decimal) {
    var a = E.intAmerican(american);
    if (a != null) return a >= 100 ? { n: String(a + 100), d: '100' } : { n: String(Math.abs(a) + 100), d: String(Math.abs(a)) };
    var dc = num(decimal);
    return dc && D.cmp(dc, '1') > 0 ? { n: dc, d: '1' } : null;
  }
  function oddsRangeKey(american, decimal) {
    var a = E.intAmerican(american);
    if (a != null) {
      if (a <= -200) return 'LE_M200';
      if (a <= -110) return 'M199_M110';
      if (a <= 100) return 'M109_P100';
      if (a <= 200) return 'P101_P200';
      if (a <= 500) return 'P201_P500';
      return 'GT_P500';
    }
    var d = num(decimal);
    if (!d || D.cmp(d, '1') <= 0) return 'NO_PRICE';
    if (D.cmp(d, '1.5') <= 0) return 'LE_M200';
    if (D.cmp(D.mul(d, '11'), '21') <= 0) return 'M199_M110';
    if (D.cmp(d, '2') <= 0) return 'M109_P100';
    if (D.cmp(d, '3') <= 0) return 'P101_P200';
    if (D.cmp(d, '6') <= 0) return 'P201_P500';
    return 'GT_P500';
  }
  function stakeBandKey(stake) {
    var s = num(stake);
    if (!s) return null;
    for (var i = 0; i < STAKE_BANDS.length; i++) {
      var b = STAKE_BANDS[i];
      if (D.cmp(s, b.from) >= 0 && (b.to == null || D.cmp(s, b.to) < 0)) return b.key;
    }
    return null;
  }
  /* the win rate a price needs to break even: 1 / decimal, exactly */
  function breakEven(american, decimal) {
    var f = priceFraction(american, decimal);
    return f ? D.divRound(f.d, f.n, 6) : null;
  }
  function heavyJuice(american, decimal) {
    var a = E.intAmerican(american);
    if (a != null) return a <= -200;
    var d = num(decimal);
    return !!d && D.cmp(d, '1') > 0 && D.cmp(d, '1.5') <= 0;
  }
  /* a heavily juiced alternate line: an alt spread / total priced -200 or
     shorter, or any market the book itself calls "alt" / "alternate" */
  var ALT_WORD = /\balt(ernate)?\b/i;
  function isAltLine(marketType, marketText, american, decimal) {
    var mt = up(marketType);
    return ALT_WORD.test(String(marketText || '')) || ((mt === 'SPREAD' || mt === 'TOTAL') && heavyJuice(american, decimal));
  }

  /* ═══ 2. TICKETS ══════════════════════════════════════════════════════ */
  function legFrom(l) {
    l = l || {};
    var market = txt(l.market_name || l.market), sel = txt(l.selection);
    var mt = up(l.position_type || l.market_type) || I.inferType([market, sel].join(' '));
    if (E.POSITION_TYPES.indexOf(mt) < 0) mt = I.inferType(mt);
    var am = E.intAmerican(l.odds_american), dc = am == null ? num(l.odds_decimal) : null;
    return { selection: sel, event: txt(l.event_name || l.event), market: market, marketType: mt, line: num(l.line),
      oddsAmerican: am, oddsDecimal: dc, result: up(l.result || l.status), sport: txt(l.sport),
      alt: isAltLine(mt, market, am, dc) };
  }
  function parseLegs(x) {
    if (Array.isArray(x)) return x;
    if (typeof x === 'string' && x.trim()) { try { var v = JSON.parse(x); return Array.isArray(v) ? v : null; } catch (_) { return null; } }
    return null;
  }
  function betTypeOf(w, legs) {
    var t = String([w.bet_type, w.market_name].join(' ')).toLowerCase(), pt = up(w.position_type);
    if (up(w.bet_type) === 'TEASER' || /teaser/.test(t)) return 'TEASER';
    if (up(w.bet_type) === 'ROUND_ROBIN' || /round ?robin/.test(t)) return 'ROUND_ROBIN';
    if (pt === 'SAME_GAME_PARLAY') return 'SAME_GAME_PARLAY';
    if (pt === 'PARLAY') return 'PARLAY';
    if (legs.length > 1) return 'PARLAY';
    return 'SINGLE';
  }
  var DATE_MESSAGES = {
    MISSING_PLACED_AT: 'No placed date.', BAD_PLACED_AT: 'The placed date could not be read.',
    SETTLED_BEFORE_PLACED: 'Settled before it was placed (or placed after it settled).', FUTURE_DATE: 'Dated in the future.',
    MISSING_SETTLED_AT: 'Settled, with no settled date; dated by when it was placed.', OPEN_WITH_SETTLED_AT: 'Pending, yet it has a settled date.'
  };
  /* the timestamp checks, on what the source actually said */
  function dateIssues(placedRaw, settledRaw, placed, settled, open, now, readable) {
    var out = [], tp = ms(placed), ts = ms(settled), soon = (now == null ? Date.now() : now) + 86400000;
    if (txt(placedRaw) == null) out.push('MISSING_PLACED_AT');
    else if (tp == null || readable === false) out.push('BAD_PLACED_AT');
    if (tp != null && ts != null && ts < tp) out.push('SETTLED_BEFORE_PLACED');
    if ((tp != null && tp > soon) || (ts != null && ts > soon)) out.push('FUTURE_DATE');
    if (!open && txt(settledRaw) == null) out.push('MISSING_SETTLED_AT');
    if (open && txt(settledRaw) != null) out.push('OPEN_WITH_SETTLED_AT');
    return out;
  }
  /* one wager-shaped record (an import-normalized wager or a stored
     position) → a ticket. meta: { source, ref, rows, issues, conflicts,
     storedPnl, storedRisk, placedRaw, settledRaw, settledForDay, now } */
  function ticketFrom(w, meta) {
    meta = meta || {};
    var legs = (parseLegs(w.legs) || []).map(legFrom);
    var betType = betTypeOf(w, legs), kind = betType === 'SINGLE' ? 'SINGLE' : 'PARLAY';
    var status = up(w.status) || 'OPEN';
    var am = E.intAmerican(w.odds_american), dc = am == null ? num(w.odds_decimal) : null;
    var stake = num(w.stake);
    var d = E.derive({ platform_type: 'SPORTSBOOK', stake: stake, odds_american: am, odds_decimal: dc, status: status,
      reported_payout: num(w.reported_payout), fees: num(w.fees), stake_type: w.stake_type });
    var pnl = num(meta.storedPnl) != null ? num(meta.storedPnl) : d.profit_loss;
    var risked = num(meta.storedRisk) != null ? num(meta.storedRisk) : d.cost_basis;
    var state = status === 'OPEN' ? 'OPEN' : status === 'VOID' ? 'VOID' : status === 'CASHED_OUT' ? 'CASHED_OUT' : 'SETTLED';
    var issues = (meta.issues || []).map(function (x) { return { level: x.level, code: x.code, message: x.message }; });
    var excluded = null;
    var conflicts = (meta.conflicts || []).filter(function (f) { return MONEY_CONFLICTS.indexOf(f) >= 0; });
    if (conflicts.length) excluded = 'TICKET_FIELDS_DIFFER';
    else if (!stake || D.sign(stake) <= 0) excluded = 'NO_STAKE';
    else if ((state === 'SETTLED' || state === 'CASHED_OUT') && pnl == null) excluded = 'PNL_UNKNOWN';
    if (excluded && excluded !== 'TICKET_FIELDS_DIFFER') issues.push({ level: 'error', code: excluded, message: excluded === 'NO_STAKE' ? 'No usable stake.' : 'Its profit or loss cannot be computed from the file (no price or payout).' });
    var marketType = kind === 'PARLAY' ? betType : (up(w.position_type) || 'OTHER');
    if (kind === 'SINGLE' && E.POSITION_TYPES.indexOf(marketType) < 0) marketType = 'OTHER';
    if (kind === 'SINGLE' && (marketType === 'PARLAY' || marketType === 'SAME_GAME_PARLAY')) marketType = 'OTHER';
    var sports = {};
    legs.forEach(function (l) { if (l.sport) sports[l.sport.toUpperCase()] = 1; });
    var sport = txt(w.sport) ? String(w.sport).trim().toUpperCase() : (Object.keys(sports).length === 1 ? Object.keys(sports)[0] : null);
    if (Object.keys(sports).length > 1) sport = 'MULTI';
    var placed = txt(w.placed_at), settled = state === 'OPEN' ? null : txt(meta.settledForDay !== undefined ? meta.settledForDay : w.settled_at);
    var dates = dateIssues(meta.placedRaw !== undefined ? meta.placedRaw : w.placed_at, meta.settledRaw !== undefined ? meta.settledRaw : w.settled_at,
      meta.placedParsed !== undefined ? meta.placedParsed : w.placed_at, meta.settledParsed !== undefined ? meta.settledParsed : w.settled_at,
      state === 'OPEN', meta.now, meta.placedReadable);
    var closeAm = E.intAmerican(w.closing_odds_american), closeDc = closeAm == null ? num(w.closing_odds_decimal) : null;
    var t = {
      ref: meta.ref != null ? String(meta.ref) : (w.external_position_id || w.id || null), source: meta.source || null, positionId: w.id || null,
      rows: meta.rows || null, kind: kind, betType: betType, status: status,
      state: excluded ? 'EXCLUDED' : state, excludedReason: excluded,
      result: excluded || state === 'OPEN' || state === 'VOID' ? null : (d.result || (pnl != null ? (D.sign(pnl) > 0 ? 'WIN' : D.sign(pnl) < 0 ? 'LOSS' : 'PUSH') : null)),
      platform: txt(w.platform), platformLabel: txt(w.platform_label), sport: sport, league: txt(w.league),
      marketType: marketType, market: txt(w.market_name), event: txt(w.event_name), selection: txt(w.selection),
      stake: stake, risked: risked == null ? stake : risked, pnl: excluded || state === 'OPEN' || state === 'VOID' ? null : pnl,
      payout: num(w.reported_payout), oddsAmerican: am, oddsDecimal: dc != null ? dc : d.odds_decimal,
      closingAmerican: closeAm, closingDecimal: closeDc,
      placedAt: placed, settledAt: settled, dayAt: settled || placed,
      legs: legs, legCount: legs.length ? legs.length : (kind === 'SINGLE' ? 1 : null),
      alt: kind === 'SINGLE' && isAltLine(marketType, [w.market_name, w.bet_type].join(' '), am, dc),
      altLegs: kind === 'PARLAY' ? legs.filter(function (l) { return l.alt; }).length : 0,
      dateIssues: dates, issues: issues
    };
    t.counted = t.state === 'SETTLED' || t.state === 'CASHED_OUT';
    return t;
  }

  /* ═══ 3. SOURCES ══════════════════════════════════════════════════════ */
  /* a bet-tracker CSV → tickets, grouped by ticket id (the importer's
     leg-row adapter). opts: timezone, dateOrder ('MDY' | 'DMY'), now, map,
     platform, fileName */
  function fromCSV(text, opts) {
    opts = opts || {};
    var st = I.stage(text, { adapter: 'leg_rows_sportsbook_v1', map: opts.map, platform: opts.platform, platformLabel: opts.platformLabel,
      timezone: opts.timezone || opts.tz, dateOrder: opts.dateOrder, now: opts.now, fileName: opts.fileName });
    var map = st.map || {}, tz = st.timezone || 'UTC', order = st.dateOrder || 'MDY';
    var tickets = (st.rows || []).map(function (r) {
      var rec = r.merged || r.raw || {}, n = r.normalized || {};
      var placedRaw = map.placed_at ? rec[map.placed_at] : null, settledRaw = map.settled_at ? rec[map.settled_at] : null;
      var pd = I.readDate(placedRaw, tz, order), sd = I.readDate(settledRaw, tz, order);
      return ticketFrom(n, { source: 'csv', ref: r.ticket && r.ticket.id ? r.ticket.id : 'row ' + r.row_number, rows: r.ticket ? r.ticket.rows : [r.row_number],
        issues: r.issues, conflicts: r.ticket ? r.ticket.conflicts : [], placedRaw: placedRaw, settledRaw: settledRaw,
        placedParsed: pd.value || null, settledParsed: sd.value || null, placedReadable: !pd.error, now: opts.now });
    });
    var rep = st.tickets || { rowsRead: (st.rows || []).length, tickets: tickets.length, multiLegTickets: 0, legRowsJoined: 0, duplicateRows: 0, duplicateRowsExact: 0, noTicketId: 0, conflictedTickets: 0 };
    return { source: 'csv', tickets: tickets, report: rep, fileIssues: st.fileIssues || [], map: map, headers: st.headers || [], timezone: tz,
      clvColumn: !!map.closing_odds, totals: st.totals || null };
  }
  /* the reader's stored portfolio_positions rows → tickets. Prediction-market
     positions are not sportsbook tickets and are counted apart; a row listed
     twice (by id) is counted once. */
  function fromPositions(rows, opts) {
    opts = opts || {};
    var seen = {}, tickets = [], report = { positions: (rows || []).length, duplicateIds: 0, predictionMarket: 0, legsUnknown: 0 };
    (rows || []).forEach(function (p) {
      if (!p) return;
      if (up(p.platform_type) === 'PREDICTION_MARKET') { report.predictionMarket++; return; }
      if (p.id != null) { if (seen[p.id]) { report.duplicateIds++; return; } seen[p.id] = 1; }
      var stored = p.profit_loss != null ? p.profit_loss : p.realized_profit_loss;
      var t = ticketFrom(p, { source: 'positions', ref: p.external_position_id || p.id, storedPnl: up(p.status) === 'OPEN' ? null : stored,
        storedRisk: p.cost_basis, now: opts.now });
      if (t.kind === 'PARLAY' && !t.legs.length) report.legsUnknown++;
      tickets.push(t);
    });
    return { source: 'positions', tickets: tickets, report: report, fileIssues: [],
      clvColumn: tickets.some(function (t) { return t.closingAmerican != null || t.closingDecimal; }) };
  }
  function sourceOf(input, opts) {
    if (typeof input === 'string') return fromCSV(input, opts);
    if (Array.isArray(input)) {
      /* tickets already built, or stored position rows */
      if (input.length && input[0] && input[0].kind && input[0].state) return { source: 'tickets', tickets: input, report: {}, fileIssues: [], clvColumn: input.some(function (t) { return t.closingAmerican != null || t.closingDecimal; }) };
      return fromPositions(input, opts);
    }
    return input && input.tickets ? input : { source: 'empty', tickets: [], report: {}, fileIssues: [], clvColumn: false };
  }

  /* ═══ 4. GROUPS ═══════════════════════════════════════════════════════ */
  function newGroup(key, label) {
    return { key: key, label: label, n: 0, risked: '0', pnl: '0', wins: 0, losses: 0, pushes: 0, cashouts: 0, legs: 0, legsUnknown: 0,
      open: 0, openExposure: '0', void: 0, excluded: 0, tickets: [] };
  }
  function put(g, t) {
    if (t.counted) {
      g.n++; g.risked = D.add(g.risked, t.risked || '0'); g.pnl = D.add(g.pnl, t.pnl || '0');
      if (t.result === 'WIN') g.wins++; else if (t.result === 'LOSS') g.losses++; else if (t.result === 'PUSH') g.pushes++; else if (t.result === 'CASHOUT') g.cashouts++;
      if (t.legCount != null) g.legs += t.legCount; else g.legsUnknown++;
      if (t.ref != null) g.tickets.push(t.ref);
    } else if (t.state === 'OPEN') { g.open++; g.openExposure = D.add(g.openExposure, t.risked || t.stake || '0'); }
    else if (t.state === 'VOID') g.void++;
    else if (t.state === 'EXCLUDED') g.excluded++;
  }
  function finish(g, small) {
    var wl = g.wins + g.losses;
    return { key: g.key, label: g.label, n: g.n, risked: cents(g.risked), pnl: cents(g.pnl), roi: ratio(g.pnl, g.risked),
      wins: g.wins, losses: g.losses, pushes: g.pushes, cashouts: g.cashouts, winRate: wl ? D.divRound(String(g.wins), String(wl), 6) : null,
      legs: g.legs, legsUnknown: g.legsUnknown, open: g.open, openExposure: cents(g.openExposure), void: g.void, excluded: g.excluded,
      small: g.n < small, sample: g.n < small ? 'small sample' : null, tickets: g.tickets };
  }
  /* counted tickets grouped by keyFn → finished groups, worst P&L first */
  function groupBy(tickets, keyFn, labelFn, small, order) {
    var by = {}, keys = [];
    tickets.forEach(function (t) {
      if (!t.counted) return;
      var k = keyFn(t);
      if (k == null) return;
      if (!by[k]) { by[k] = newGroup(k, labelFn(k, t)); keys.push(k); }
      put(by[k], t);
    });
    var out = keys.map(function (k) { return finish(by[k], small); });
    if (order) return out.sort(function (a, b) { return order.indexOf(a.key) - order.indexOf(b.key); });
    return out.sort(function (a, b) { return D.cmp(a.pnl, b.pnl) || b.n - a.n || String(a.label).localeCompare(String(b.label)); });
  }
  var ODDS_LABEL = {}, STAKE_LABEL = {};
  ODDS_RANGES.forEach(function (r) { ODDS_LABEL[r.key] = r.label; });
  STAKE_BANDS.forEach(function (b) { STAKE_LABEL[b.key] = b.label; });

  /* ═══ 5. analyze() ════════════════════════════════════════════════════
     input: fromCSV(...) / fromPositions(...) output, a CSV string, or an
     array of stored position rows. opts: tz (local days), from / to (epoch
     ms: settled tickets by the day they settled; open tickets are always
     now), now, smallSample (30), lossDayShare ('0.25'). */
  function analyze(input, opts) {
    opts = opts || {};
    var src = sourceOf(input, opts);
    var tz = opts.tz || opts.timezone || src.timezone || 'UTC', small = opts.smallSample || SMALL_SAMPLE;
    var share = num(opts.lossDayShare) || DAY_SHARE;
    var from = opts.from == null ? null : opts.from, to = opts.to == null ? null : opts.to;
    var all = src.tickets || [];
    var tickets = all.filter(function (t) {
      if (t.state === 'OPEN' || (from == null && to == null)) return true;
      var at = ms(t.dayAt);
      return at != null && (from == null || at >= from) && (to == null || at < to);
    });
    var counted = tickets.filter(function (t) { return t.counted; });

    /* totals */
    var tot = newGroup('ALL', 'All tickets');
    tickets.forEach(function (t) { put(tot, t); });
    var totals = finish(tot, small);
    var voidStake = tickets.filter(function (t) { return t.state === 'VOID'; }).reduce(function (s, t) { return D.add(s, t.stake || '0'); }, '0');
    totals.voidStake = cents(voidStake);
    var counts = { tickets: tickets.length, legs: 0, legsUnknown: 0, singles: 0, parlays: 0, settled: 0, cashedOut: 0, open: 0, void: 0, excluded: 0, counted: counted.length };
    tickets.forEach(function (t) {
      if (t.legCount != null) counts.legs += t.legCount; else counts.legsUnknown++;
      if (t.kind === 'SINGLE') counts.singles++; else counts.parlays++;
      if (t.state === 'SETTLED') counts.settled++; else if (t.state === 'CASHED_OUT') counts.cashedOut++; else if (t.state === 'OPEN') counts.open++;
      else if (t.state === 'VOID') counts.void++; else counts.excluded++;
    });

    /* singles vs parlays (every state, so open and void show beside them) */
    var kinds = { SINGLE: newGroup('SINGLE', 'Singles'), PARLAY: newGroup('PARLAY', 'Parlays') };
    tickets.forEach(function (t) { put(kinds[t.kind], t); });
    var singles = finish(kinds.SINGLE, small), parlays = finish(kinds.PARLAY, small);
    var comparison = compare(singles, parlays, small);

    /* the dimensions */
    var bySport = groupBy(counted, function (t) { return t.sport || 'UNSPECIFIED'; }, function (k) { return k === 'UNSPECIFIED' ? 'No sport recorded' : k === 'MULTI' ? 'Multi-sport parlays' : k; }, small);
    var byMarketType = groupBy(counted, function (t) { return t.marketType; }, function (k) { return BET_TYPE_LABEL[k] && k !== 'SINGLE' ? BET_TYPE_LABEL[k] : (E.POSITION_TYPE_LABEL[k] || k); }, small);
    var byBetType = groupBy(counted, function (t) { return t.betType; }, function (k) { return BET_TYPE_LABEL[k] || k; }, small);
    var byOddsRange = groupBy(counted, function (t) { return oddsRangeKey(t.oddsAmerican, t.oddsDecimal); }, function (k) { return ODDS_LABEL[k]; }, small, ODDS_RANGES.map(function (r) { return r.key; }));
    var byStakeSize = groupBy(counted, function (t) { return stakeBandKey(t.stake); }, function (k) { return STAKE_LABEL[k]; }, small, STAKE_BANDS.map(function (b) { return b.key; }));

    /* days: the local day each ticket settled (its placed day when the
       settled date is missing or comes before it) */
    var dayGroups = groupBy(counted, function (t) { var at = ms(t.dayAt); return at == null ? null : localDay(at, tz); }, function (k) { return k; }, small);
    var undated = counted.filter(function (t) { return ms(t.dayAt) == null; }).length;
    var losing = dayGroups.filter(function (g) { return D.sign(g.pnl) < 0; });
    var totalLosses = losing.reduce(function (s, g) { return D.add(s, absS(g.pnl)); }, '0');
    losing.forEach(function (g) { g.share = ratio(absS(g.pnl), totalLosses); });
    var days = {
      list: dayGroups.slice().sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }).map(function (g) { return { date: g.key, n: g.n, risked: g.risked, pnl: g.pnl, share: g.share || null }; }),
      count: dayGroups.length, losingDays: losing.length, totalLosses: cents(totalLosses), threshold: share, undated: undated,
      disproportionate: losing.filter(function (g) { return D.cmp(g.share, share) >= 0; }).map(function (g) { return { date: g.key, n: g.n, pnl: g.pnl, risked: g.risked, share: g.share, small: g.small }; }),
      worst: losing.length ? { date: losing[0].key, n: losing[0].n, pnl: losing[0].pnl, risked: losing[0].risked, share: losing[0].share } : null
    };

    /* heavily juiced alternate lines */
    var altS = newGroup('ALT_SINGLES', 'Alt-line singles'), altP = newGroup('ALT_PARLAYS', 'Parlays with alt-line legs'), altA = newGroup('ALT_ALL', 'Heavily juiced alternate lines');
    var altLegs = 0, altLegBe = [], altSingleBe = [], grossLoss = '0', altLoss = '0';
    counted.forEach(function (t) {
      if (D.sign(t.pnl) < 0) grossLoss = D.add(grossLoss, absS(t.pnl));
      var touches = (t.kind === 'SINGLE' && t.alt) || (t.kind === 'PARLAY' && t.altLegs > 0);
      if (!touches) return;
      put(altA, t);
      if (t.kind === 'SINGLE') { put(altS, t); var be = breakEven(t.oddsAmerican, t.oddsDecimal); if (be) altSingleBe.push(be); }
      else {
        put(altP, t); altLegs += t.altLegs;
        t.legs.forEach(function (l) { if (l.alt) { var b = breakEven(l.oddsAmerican, l.oddsDecimal); if (b) altLegBe.push(b); } });
      }
      if (D.sign(t.pnl) < 0) altLoss = D.add(altLoss, absS(t.pnl));
    });
    var mean = function (list) { return list.length ? D.divRound(D.sum(list), String(list.length), 6) : null; };
    var altLines = { singles: finish(altS, small), parlays: finish(altP, small), combined: finish(altA, small), legs: altLegs,
      singlesBreakEven: mean(altSingleBe), legsBreakEven: mean(altLegBe), losses: cents(altLoss), grossLosses: cents(grossLoss),
      shareOfLosses: ratio(altLoss, grossLoss), rule: 'Alt spreads and totals priced −200 or shorter, or any market named "alt" / "alternate".' };

    /* closing-line value: singles only, when the source has closing prices */
    var clv = closing(tickets, src.clvColumn, small);

    /* data quality */
    var issueCount = {}, issueTickets = {};
    var timestamps = { missingPlaced: 0, badPlaced: 0, settledBeforePlaced: 0, futureDates: 0, missingSettled: 0, openWithSettled: 0, tickets: {} };
    var DATE_KEY = { MISSING_PLACED_AT: 'missingPlaced', BAD_PLACED_AT: 'badPlaced', SETTLED_BEFORE_PLACED: 'settledBeforePlaced', FUTURE_DATE: 'futureDates', MISSING_SETTLED_AT: 'missingSettled', OPEN_WITH_SETTLED_AT: 'openWithSettled' };
    tickets.forEach(function (t) {
      t.dateIssues.forEach(function (c) { timestamps[DATE_KEY[c]]++; (timestamps.tickets[c] = timestamps.tickets[c] || []).push(t.ref); });
      var seen = {};
      t.issues.forEach(function (x) {
        if (x.level === 'info' && ['DUPLICATE_ROW_MERGED', 'ODDS_FROM_LEGS', 'STATUS_FROM_LEGS'].indexOf(x.code) < 0) return;
        if (seen[x.code]) { if (x.code === 'DUPLICATE_ROW_MERGED') issueCount[x.code]++; return; }
        seen[x.code] = 1; issueCount[x.code] = (issueCount[x.code] || 0) + 1; (issueTickets[x.code] = issueTickets[x.code] || []).push(t.ref);
      });
    });
    var LEVEL = {}; tickets.forEach(function (t) { t.issues.forEach(function (x) { if (!LEVEL[x.code] || x.level === 'error') LEVEL[x.code] = x.level; }); });
    var dataQuality = {
      issues: Object.keys(issueCount).sort().map(function (c) { return { code: c, level: LEVEL[c] || 'info', n: issueCount[c], tickets: issueTickets[c] }; }),
      excluded: tickets.filter(function (t) { return t.state === 'EXCLUDED'; }).map(function (t) { return { ref: t.ref, reason: t.excludedReason, rows: t.rows }; }),
      timestamps: timestamps,
      dedupe: dedupeReport(src),
      fileIssues: (src.fileIssues || []).map(function (x) { return { level: x.level, code: x.code, message: x.message }; })
    };

    /* the worst segments across every dimension */
    var segments = [];
    [['sport', 'Sport', bySport], ['market', 'Market type', byMarketType], ['odds', 'Price range', byOddsRange], ['stake', 'Stake size', byStakeSize], ['day', 'Day', dayGroups]]
      .forEach(function (d) {
        d[2].forEach(function (g) { if (g.n > 0 && D.sign(g.pnl) < 0) segments.push({ dimension: d[0], dimensionLabel: d[1], key: g.key, label: g.label, n: g.n, risked: g.risked, pnl: g.pnl, roi: g.roi, small: g.small, sample: g.sample, share: g.share || null }); });
      });
    segments.sort(function (a, b) { return D.cmp(a.pnl, b.pnl) || b.n - a.n || (a.dimension + a.label).localeCompare(b.dimension + b.label); });

    return {
      version: VERSION, question: QUESTION, source: src.source, tz: tz, from: from, to: to, smallSample: small,
      counts: counts, totals: totals, singles: singles, parlays: parlays, comparison: comparison,
      bySport: bySport, byMarketType: byMarketType, byBetType: byBetType, byOddsRange: byOddsRange, byStakeSize: byStakeSize,
      days: days, altLines: altLines, clv: clv, dataQuality: dataQuality, worstSegments: segments,
      tickets: tickets.map(ticketSummary),
      definitions: {
        risked: 'The stake of every settled and cashed-out ticket (a bonus bet risks no cash). Pending and void tickets are not included.',
        pnl: 'Net realized profit or loss: what settled and cashed-out tickets returned, less their stakes. Payout is not profit.',
        roi: 'Net P&L divided by the amount risked.',
        winRate: 'Wins divided by wins plus losses; pushes and cash-outs are left out.',
        openExposure: 'The stakes of pending tickets: at risk, not yet won or lost.',
        days: 'A ticket counts on the local day it settled (its placed day when the settled date is missing or earlier than the placed date). A day’s share is its loss over the losses of all losing days.',
        sample: 'Any group of fewer than ' + small + ' counted tickets is marked "small sample".'
      }
    };
  }
  function compare(s, p, small) {
    var out = { better: null, basis: 'roi', bothSmall: s.small && p.small, roiGap: null, note: null };
    if (!s.n && !p.n) { out.note = 'No settled singles or parlays.'; return out; }
    if (!p.n) { out.note = 'No settled parlays to compare.'; return out; }
    if (!s.n) { out.note = 'No settled singles to compare.'; return out; }
    if (s.roi == null || p.roi == null) return out;
    var c = D.cmp(s.roi, p.roi);
    out.better = c > 0 ? 'singles' : c < 0 ? 'parlays' : 'even';
    out.roiGap = D.sub(s.roi, p.roi);
    out.pnlGap = cents(D.sub(s.pnl, p.pnl));
    return out;
  }
  function closing(tickets, column, small) {
    if (!column) return { available: false, n: 0, note: 'The history has no closing prices, so closing-line value (CLV) is not verifiable.' };
    var list = [];
    tickets.forEach(function (t) {
      if (t.kind !== 'SINGLE' || t.state === 'VOID' || t.state === 'EXCLUDED') return;
      var a = priceFraction(t.oddsAmerican, t.oddsDecimal), c = priceFraction(t.closingAmerican, t.closingDecimal);
      if (!a || !c) return;
      /* (taken / closing) − 1, exactly: (aN × cD) / (aD × cN) − 1 */
      var v = D.sub(D.divRound(D.mul(a.n, c.d), D.mul(a.d, c.n), 6), '1');
      list.push({ ref: t.ref, clv: v });
    });
    if (!list.length) return { available: true, n: 0, note: 'Closing prices are present, but none line up with a single ticket’s price.' };
    var beat = list.filter(function (x) { return D.sign(x.clv) > 0; }).length, worse = list.filter(function (x) { return D.sign(x.clv) < 0; }).length;
    return { available: true, n: list.length, beat: beat, matched: list.length - beat - worse, worse: worse,
      average: D.divRound(D.sum(list.map(function (x) { return x.clv; })), String(list.length), 6),
      small: list.length < small, sample: list.length < small ? 'small sample' : null, tickets: list,
      note: 'Singles only: a parlay’s closing price is not in the file as one number.' };
  }
  function dedupeReport(src) {
    var r = src.report || {};
    if (src.source === 'csv') return { rowsRead: r.rowsRead || 0, tickets: r.tickets || 0, legRowsJoined: r.legRowsJoined || 0, multiLegTickets: r.multiLegTickets || 0,
      duplicateRows: r.duplicateRows || 0, duplicateRowsExact: r.duplicateRowsExact || 0, noTicketId: r.noTicketId || 0, conflictedTickets: r.conflictedTickets || 0 };
    if (src.source === 'positions') return { positions: r.positions || 0, duplicateIds: r.duplicateIds || 0, predictionMarket: r.predictionMarket || 0, legsUnknown: r.legsUnknown || 0 };
    return {};
  }
  function ticketSummary(t) {
    return { ref: t.ref, kind: t.kind, betType: t.betType, state: t.state, status: t.status, result: t.result, sport: t.sport, marketType: t.marketType,
      event: t.event, selection: t.selection, stake: t.stake == null ? null : cents(t.stake), risked: t.risked == null ? null : cents(t.risked),
      pnl: t.pnl == null ? null : cents(t.pnl), oddsAmerican: t.oddsAmerican, oddsDecimal: t.oddsDecimal, legs: t.legCount, altLegs: t.altLegs, alt: t.alt,
      placedAt: t.placedAt, settledAt: t.settledAt, rows: t.rows, excludedReason: t.excludedReason, dateIssues: t.dateIssues };
  }

  /* ═══ 6. THE ANSWER, IN WORDS ═════════════════════════════════════════
     Deterministic: the same analytics give the same text. Every number in
     it comes from the analytics; nothing is predicted, nothing is urged. */
  var LANGUAGE_RULES = [
    { code: 'CHASING', re: /\bwin (it |them |that |this |those |your money )?back\b/i },
    { code: 'CHASING', re: /\brecover(s|ed|ing|y)?\b/i },
    { code: 'CHASING', re: /\brecoup/i },
    { code: 'CHASING', re: /\bchas(e|es|ed|ing)\b/i },
    { code: 'CHASING', re: /\bmake (it|that|this|them|the money) back\b/i },
    { code: 'CHASING', re: /\bmake up (for )?(the |your |those |these )?loss/i },
    { code: 'CHASING', re: /\b(get|getting|got) (back )?(to )?even\b/i },
    { code: 'CHASING', re: /\bdouble (up|down)\b/i },
    { code: 'CHASING', re: /\bmartingale\b/i },
    { code: 'STAKE_UP', re: /\b(raise|raising|increase|increasing|up|upping|boost|boosting|bump|bumping|press|pressing)\s+(your |the |my )?(stakes?|bet sizes?|units?|wagers?|bets?|bankroll)\b/i },
    { code: 'STAKE_UP', re: /\bbet (more|bigger|larger|heavier)\b/i },
    { code: 'STAKE_UP', re: /\b(bigger|larger|higher|heavier) (bets|stakes|wagers|units)\b/i },
    { code: 'PREDICTIVE', re: /\b(due|bound) (for|to)\b/i },
    { code: 'PREDICTIVE', re: /\bbounce back\b/i },
    { code: 'PREDICTIVE', re: /\bturn (it|things) around\b/i },
    { code: 'PREDICTIVE', re: /\bguarantee/i },
    { code: 'PREDICTIVE', re: /\bsure (thing|bet|win)\b/i },
    { code: 'PREDICTIVE', re: /\bhot streak\b/i },
    { code: 'PREDICTIVE', re: /\b(will|should|going to|expect(ed)? to|likely to)\s+(be\s+)?(win|profit|profitable|make money|pay off|come good)/i },
    { code: 'PREDICTIVE', re: /\bfuture (profits?|winnings|wins)\b/i }
  ];
  /* the guard: no chasing, no "bet more", no prediction of profit */
  function checkLanguage(text) {
    var hits = [];
    LANGUAGE_RULES.forEach(function (r) { var m = r.re.exec(String(text || '')); if (m) hits.push({ code: r.code, text: m[0] }); });
    return { ok: hits.length === 0, hits: hits };
  }
  function m(x, sign) { return E.money(x, sign ? { sign: true } : null); }
  function pctOf(x) { return x == null ? '—' : E.pct(x, 1); }
  function plainPct(x) { return x == null ? '—' : E.pct(x, 1, { plain: true }); }
  function nTickets(n) { return n + ' ticket' + (n === 1 ? '' : 's'); }
  function smallTag(g) { return g.small ? ' (small sample)' : ''; }
  function kindLine(name, g, isParlay) {
    if (!g.n) return name + ': no settled tickets.';
    return name + ': ' + m(g.pnl, true) + ' on ' + nTickets(g.n) + (isParlay && g.legs ? ' with ' + g.legs + ' legs' : '') + ' \u2014 risked ' + m(g.risked) + ', ROI ' + pctOf(g.roi)
      + (g.winRate != null ? ', won ' + g.wins + ' and lost ' + g.losses + ' (win rate ' + plainPct(g.winRate) + ')' : '') + (g.small ? '; small sample' : '') + '.';
  }
  var DIM_WORD = { sport: function (s) { return s.key === 'MULTI' ? 'Multi-sport parlays' : s.key === 'UNSPECIFIED' ? 'Bets with no sport recorded' : s.label + ' bets'; },
    market: function (s) { return /parlay|teaser|robin/i.test(s.label) ? s.label + 's' : s.label + ' bets'; },
    odds: function (s) { return s.key === 'NO_PRICE' ? 'Bets with no price recorded' : 'Bets priced ' + s.label; }, stake: function (s) { return 'Stakes of ' + s.label; } };
  /* analytics → { question, text, paragraphs, drivers, caveats } */
  function answer(a, opts) {
    opts = opts || {};
    var maxDrivers = opts.drivers || 3, paras = [], caveats = [], drivers = [], parts = {};
    var t = a.totals, c = a.counts;
    /* 1. the headline */
    var head;
    if (!t.n) head = 'There are no settled or cashed-out tickets in this history, so there is no realized result to explain yet.';
    else if (D.sign(t.pnl) < 0) head = 'You lost ' + m(absS(t.pnl)) + ' on ' + nTickets(t.n) + ' that settled or were cashed out (risked ' + m(t.risked) + ', ROI ' + pctOf(t.roi) + ').';
    else if (D.sign(t.pnl) > 0) head = 'Overall you did not lose money: ' + m(t.pnl, true) + ' on ' + nTickets(t.n) + ' that settled or were cashed out (risked ' + m(t.risked) + ', ROI ' + pctOf(t.roi) + '). The losses below came from parts of it.';
    else head = 'You finished even: ' + m(t.pnl, true) + ' on ' + nTickets(t.n) + ' (risked ' + m(t.risked) + ').';
    if (c.open) head += ' ' + c.open + ' pending ticket' + (c.open === 1 ? '' : 's') + ' (' + m(t.openExposure) + ' at risk) ' + (c.open === 1 ? 'is' : 'are') + ' not counted until ' + (c.open === 1 ? 'it settles' : 'they settle') + '.';
    if (c.void) head += ' ' + c.void + ' voided ticket' + (c.void === 1 ? ' is' : 's are') + ' left out.';
    paras.push(head); parts.headline = head;
    /* 2. singles or parlays */
    var cmp = a.comparison, s = a.singles, p = a.parlays, verdict;
    if (cmp.better === 'parlays') verdict = 'Parlays were more profitable per dollar risked than singles (ROI ' + pctOf(p.roi) + ' against ' + pctOf(s.roi) + ').';
    else if (cmp.better === 'singles') verdict = 'Singles were more profitable per dollar risked than parlays (ROI ' + pctOf(s.roi) + ' against ' + pctOf(p.roi) + ').';
    else if (cmp.better === 'even') verdict = 'Singles and parlays returned the same per dollar risked (ROI ' + pctOf(s.roi) + ').';
    else verdict = cmp.note || '';
    var weak = s.n && p.n && (s.small || p.small) ? (s.small && p.small ? 'Both samples are' : (s.small ? 'The singles sample is' : 'The parlay sample is')) + ' under ' + a.smallSample + ' tickets, so this comparison is weak evidence either way.' : '';
    parts.singles = kindLine('Singles', s, false); parts.parlays = kindLine('Parlays', p, true); parts.verdict = [verdict, weak].filter(Boolean).join(' ');
    paras.push('Singles or parlays? ' + parts.singles + ' ' + parts.parlays + (parts.verdict ? ' ' + parts.verdict : ''));
    /* 3. the biggest loss drivers: the worst group of each dimension, and the alt lines */
    var cands = [];
    ['sport', 'market', 'odds', 'stake'].forEach(function (dim) {
      var w = a.worstSegments.filter(function (x) { return x.dimension === dim; })[0];
      if (w) cands.push({ dimension: dim, label: DIM_WORD[dim](w), key: w.key, n: w.n, pnl: w.pnl, risked: w.risked, roi: w.roi, small: w.small });
    });
    var alt = a.altLines;
    if (alt.combined.n && D.sign(alt.combined.pnl) < 0) cands.push({ dimension: 'alt', label: 'Heavily juiced alternate lines', key: 'ALT', n: alt.combined.n, pnl: alt.combined.pnl, risked: alt.combined.risked, roi: alt.combined.roi, small: alt.combined.small, share: alt.shareOfLosses });
    cands.sort(function (x, y) { return D.cmp(x.pnl, y.pnl) || y.n - x.n || x.label.localeCompare(y.label); });
    drivers = cands.slice(0, maxDrivers);
    if (drivers.length) {
      parts.drivers = 'The biggest loss drivers: ' + drivers.map(function (d, i) {
        return '(' + (i + 1) + ') ' + d.label + ': ' + m(d.pnl, true) + ' on ' + nTickets(d.n) + ' (risked ' + m(d.risked) + ', ROI ' + pctOf(d.roi) + ')'
          + (d.share != null ? ', ' + plainPct(d.share) + ' of the money lost on losing tickets' : '') + (d.small ? ', small sample' : '');
      }).join('; ') + '.';
      paras.push(parts.drivers);
    } else if (t.n) { parts.drivers = 'No group of tickets lost money on balance.'; paras.push(parts.drivers); }
    /* 4. the days */
    var dy = a.days;
    if (dy.worst) {
      var dline = 'Worst day: ' + dy.worst.date + ', ' + m(dy.worst.pnl, true) + ' on ' + nTickets(dy.worst.n) + ' — ' + plainPct(dy.worst.share) + ' of the ' + m(dy.totalLosses) + ' lost across ' + dy.losingDays + ' losing day' + (dy.losingDays === 1 ? '' : 's') + '.';
      var others = dy.disproportionate.filter(function (x) { return x.date !== dy.worst.date; });
      if (others.length) dline += ' Also at or above ' + plainPct(dy.threshold) + ' of those losses: ' + others.map(function (x) { return x.date + ' (' + m(x.pnl, true) + ', ' + plainPct(x.share) + ')'; }).join(', ') + '.';
      paras.push(dline); parts.days = dline;
    }
    /* 5. what the juice did */
    if (alt.combined.n) {
      var al = 'Alternate lines: ';
      var bits = [];
      if (alt.singles.n) bits.push(nTickets(alt.singles.n).replace('ticket', 'single') + ' ' + m(alt.singles.pnl, true) + ', won ' + alt.singles.wins + ' of ' + (alt.singles.wins + alt.singles.losses)
        + (alt.singlesBreakEven ? '; at those prices a single needs to win ' + plainPct(alt.singlesBreakEven) + ' of the time just to break even' : ''));
      if (alt.parlays.n) bits.push(nTickets(alt.parlays.n).replace('ticket', 'parlay') + ' carrying ' + alt.legs + ' alt leg' + (alt.legs === 1 ? '' : 's') + ' ' + m(alt.parlays.pnl, true)
        + (alt.legsBreakEven ? '; each such leg needs to win about ' + plainPct(alt.legsBreakEven) + ' of the time and adds little to the price' : ''));
      parts.alt = al + bits.join('; ') + '.';
      paras.push(parts.alt);
    }
    /* 6. caveats */
    var dq = a.dataQuality, dd = dq.dedupe || {}, ts = dq.timestamps;
    if (dq.excluded.length) caveats.push(nTickets(dq.excluded.length) + ' left out because ' + (dq.excluded.length === 1 ? 'its' : 'their') + ' rows disagree on the stake, price or result, or the P&L cannot be computed (' + dq.excluded.map(function (x) { return x.ref || 'no id'; }).join(', ') + ').');
    if (dd.noTicketId) caveats.push(dd.noTicketId + ' row' + (dd.noTicketId === 1 ? '' : 's') + ' had no ticket id and ' + (dd.noTicketId === 1 ? 'was' : 'were') + ' counted as ' + (dd.noTicketId === 1 ? 'a single' : 'singles') + '.');
    if (dd.duplicateRows) caveats.push(dd.duplicateRows + ' duplicate row' + (dd.duplicateRows === 1 ? '' : 's') + ' (the same leg of the same ticket) counted once.');
    if (dd.legRowsJoined) caveats.push(dd.legRowsJoined + ' leg row' + (dd.legRowsJoined === 1 ? '' : 's') + ' joined to ' + (dd.multiLegTickets === 1 ? 'its ticket' : 'their tickets') + ', so no parlay stake was counted twice.');
    if (dd.legsUnknown) caveats.push(dd.legsUnknown + ' parlay' + (dd.legsUnknown === 1 ? ' has' : 's have') + ' no leg detail stored, so ' + (dd.legsUnknown === 1 ? 'its' : 'their') + ' legs are not counted.');
    var tsBits = [];
    if (ts.settledBeforePlaced) tsBits.push(ts.settledBeforePlaced + ' settled before ' + (ts.settledBeforePlaced === 1 ? 'it was' : 'they were') + ' placed');
    if (ts.missingPlaced) tsBits.push(ts.missingPlaced + ' with no placed date');
    if (ts.badPlaced) tsBits.push(ts.badPlaced + ' with an unreadable placed date');
    if (ts.futureDates) tsBits.push(ts.futureDates + ' dated in the future');
    if (ts.openWithSettled) tsBits.push(ts.openWithSettled + ' pending with a settled date');
    if (tsBits.length) caveats.push('Timestamps to check: ' + tsBits.join('; ') + '. Those tickets are dated by when they were placed where possible.');
    if (!a.clv.available) caveats.push(a.clv.note);
    else if (a.clv.n) caveats.push('Closing-line value on ' + nTickets(a.clv.n).replace('ticket', 'single') + ': beat the close on ' + a.clv.beat + ', average ' + pctOf(a.clv.average) + (a.clv.small ? ' (small sample)' : '') + '. Price versus the close is a measure of the prices you took, not of results.');
    var smallGroups = t.n < a.smallSample;
    if (smallGroups) caveats.push('All of this rests on ' + nTickets(t.n) + ', under ' + a.smallSample + ': a small sample, where luck alone moves results a lot.');
    else caveats.push('Groups under ' + a.smallSample + ' tickets are marked small samples; luck alone moves them a lot.');
    if (opts.scope) caveats.push(String(opts.scope));
    paras.push('Caveats: ' + caveats.join(' '));
    parts.closing = 'These figures describe your past results only; they do not predict future results.';
    paras.push(parts.closing);
    var text = paras.join('\n\n');
    return { question: QUESTION, text: text, paragraphs: paras, parts: parts, drivers: drivers, caveats: caveats, language: checkLanguage(text) };
  }

  return {
    VERSION: VERSION, QUESTION: QUESTION, SMALL_SAMPLE: SMALL_SAMPLE, ODDS_RANGES: ODDS_RANGES, STAKE_BANDS: STAKE_BANDS, BET_TYPE_LABEL: BET_TYPE_LABEL, ISSUE_LABEL: ISSUE_LABEL,
    fromCSV: fromCSV, fromPositions: fromPositions, ticketFrom: ticketFrom, analyze: analyze, answer: answer, checkLanguage: checkLanguage,
    oddsRangeKey: oddsRangeKey, stakeBandKey: stakeBandKey, breakEven: breakEven, isAltLine: isAltLine, LANGUAGE_RULES: LANGUAGE_RULES
  };
}));
