/* ===========================================================================
   EDGEDESK PORTFOLIO — the import engine.
   docs/portfolio-architecture.md § Imports

   A CSV becomes staged rows, and nothing more. This file parses the file in
   the reader's own browser (the file itself is never uploaded), proposes a
   column mapping, and normalizes each row into the one shape every source
   writes — with its problems listed beside it. It inserts nothing: the rows
   are staged in portfolio_import_rows, the DATABASE classifies them (new,
   duplicate, needs review, invalid) and the reader confirms before
   portfolio_import_commit() writes a single position.

   ADAPTERS, NOT ASSUMPTIONS
     generic_sportsbook_v1          one row per wager
     generic_prediction_market_v1   one row per trade (a buy or a sell);
                                    rows for the same market and side become
                                    one position with several fills
   A platform-specific importer (a DraftKings or Kalshi export) is another
   adapter with its own aliases and detect() — the core never changes.

   NEVER GUESSED
     - a decimal comma ("12,50") is refused, not read as 1250 or 12.5;
     - a date that only works one way round (13/02/2026 under month-first) is
       refused with the reason, and the reader chooses the order;
     - a time with no zone is read in the zone the reader picked, and a time
       with a zone is read in that zone — "same instant, same position";
     - a contract price column of whole numbers 1-99 is read as cents only
       when EVERY price in it is, and the file says so.

   Browser: window.EDPortfolioImport.   Node: require('./edgedesk_portfolio_import.js').
   =========================================================================== */
(function (root, factory) {
  var E = root.EDPortfolio || (typeof require === 'function' ? require('./edgedesk_portfolio.js') : null);
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolioImport = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E) {
  'use strict';

  var MAX_ROWS = 5000;
  var MAX_BYTES = 5 * 1024 * 1024;
  var MAX_CELL = 500;

  /* ═══ 1. CSV ══════════════════════════════════════════════════════════ */
  function detectDelimiter(text) {
    var line = '', q = false;
    for (var i = 0; i < text.length && i < 20000; i++) {
      var c = text[i];
      if (c === '"') q = !q;
      if (!q && (c === '\n' || c === '\r')) break;
      if (!q) line += c;
    }
    var best = ',', n = 0;
    [',', ';', '\t', '|'].forEach(function (d) { var k = line.split(d).length - 1; if (k > n) { n = k; best = d; } });
    return best;
  }
  /* RFC 4180: quoted fields, doubled quotes, CRLF / LF / CR, newlines inside quotes */
  function parseCSV(text, delimiter) {
    text = String(text == null ? '' : text).replace(/^﻿/, '');
    var d = delimiter || detectDelimiter(text), rows = [], row = [], cell = '', q = false, i = 0;
    while (i < text.length) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === '') { q = true; i++; continue; }
      if (c === d) { row.push(cell); cell = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; continue;
      }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { delimiter: d, rows: rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); }) };
  }
  function headerToken(h) { return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* ═══ 2. CELL READERS ═════════════════════════════════════════════════ */
  function cellText(x) { var t = String(x == null ? '' : x).trim(); return t === '' ? null : t; }
  /* dollars: "$1,234.56" "(12.00)" "-12" "USD 12" → "1234.56"; "12,50" → AMBIGUOUS */
  function readMoney(x) {
    var t = cellText(x);
    if (t == null) return { value: null };
    var negative = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/^[\s$]+/, ''));
    t = t.replace(/^\(|\)$/g, '').replace(/usd|\$|\s/gi, '').replace(/^[-+]/, '');
    if (/^\d+,\d{1,2}$/.test(t)) return { error: 'AMBIGUOUS_DECIMAL' };
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    if (!/^\d*\.?\d+$/.test(t)) return { error: 'BAD_NUMBER' };
    return { value: E.dec.str((negative ? '-' : '') + t) };
  }
  function readNumber(x) {
    var t = cellText(x);
    if (t == null) return { value: null };
    t = t.replace(/,/g, '');
    if (!/^[+-]?\d*\.?\d+$/.test(t)) return { error: 'BAD_NUMBER' };
    return { value: E.dec.str(t) };
  }
  /* odds: "+150" "-110" "150" "EVEN" → American; "1.91" "2" → decimal; "5/2" → decimal 3.5 */
  function readOdds(x, forceDecimal) {
    var t = cellText(x);
    if (t == null) return { value: null };
    t = t.replace(/\s/g, '');
    if (/^(even|evens|ev|pk)$/i.test(t)) return { american: 100 };
    var fr = /^(\d+)\/(\d+)$/.exec(t);
    if (fr && +fr[2] > 0) return { decimal: E.dec.add('1', E.dec.divRound(fr[1], fr[2], 6)) };
    if (!/^[+-]?\d*\.?\d+$/.test(t)) return { error: 'BAD_ODDS' };
    if (forceDecimal) return E.dec.cmp(t, '1') > 0 ? { decimal: E.dec.str(t) } : { error: 'BAD_ODDS' };
    var signed = /^[+-]/.test(t), isInt = /^[+-]?\d+$/.test(t), v = Number(t);
    if (signed || (isInt && Math.abs(v) >= 100)) {
      var a = E.intAmerican(t.replace(/^\+/, ''));
      return a == null ? { error: 'BAD_ODDS' } : { american: a };
    }
    return E.dec.cmp(t, '1') > 0 ? { decimal: E.dec.str(t) } : { error: 'BAD_ODDS' };
  }
  /* a contract price: "0.61" "$0.61" "61¢" "61c"; cents=true reads "61" as $0.61 */
  function readPrice(x, cents) {
    var t = cellText(x);
    if (t == null) return { value: null };
    var c = /(¢|c)$/i.test(t);
    t = t.replace(/[$¢\s]|c$/gi, '');
    if (!/^\d*\.?\d+$/.test(t)) return { error: 'BAD_PRICE' };
    var v = (c || cents) ? E.dec.divRound(t, '100', 6) : E.dec.str(t);
    if (E.dec.cmp(v, '0') < 0 || E.dec.cmp(v, '1') > 0) return { error: 'BAD_PRICE' };
    return { value: v };
  }
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function hour12(h, ap) { h = +h; if (!ap) return h; ap = ap.toUpperCase(); if (ap === 'PM' && h < 12) return h + 12; if (ap === 'AM' && h === 12) return 0; return h; }
  function okParts(y, mo, d, h, mi, s) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59)) return false;
    var probe = new Date(Date.UTC(y, mo - 1, d));
    return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
  }
  /* → { value: ISO-8601 UTC } or { error } (+ dateOnly when no time was given) */
  function readDate(x, tz, order) {
    var t = cellText(x), m;
    if (t == null) return { value: null };
    tz = tz || 'UTC';
    /* an explicit zone: read exactly */
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
      var z = Date.parse(t.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
      return isFinite(z) ? { value: new Date(z).toISOString() } : { error: 'BAD_DATE' };
    }
    var y, mo, d, h = 0, mi = 0, s = 0, dateOnly = false;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(AM|PM)?)?$/i.exec(t))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
      if (m[4] != null) { h = hour12(m[4], m[7]); mi = +m[5]; s = +(m[6] || 0); } else dateOnly = true;
    } else if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(t))) {
      var a = +m[1], b = +m[2];
      if (order === 'DMY') { d = a; mo = b; } else { mo = a; d = b; }
      y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (m[4] != null) { h = hour12(m[4], m[7]); mi = +m[5]; s = +(m[6] || 0); } else dateOnly = true;
      if (!okParts(y, mo, d, h, mi, s)) return { error: order === 'DMY' ? 'BAD_DATE' : 'BAD_DATE_ORDER' };
    } else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[ ,]+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(t))) {
      mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)]; d = +m[2]; y = +m[3];
      if (m[4] != null) { h = hour12(m[4], m[7]); mi = +m[5]; s = +(m[6] || 0); } else dateOnly = true;
    } else return { error: 'BAD_DATE' };
    if (!okParts(y, mo, d, h, mi, s)) return { error: 'BAD_DATE' };
    if (dateOnly) h = 12;    /* a date with no time: midday, so no zone moves it to another day */
    return { value: new Date(E.zonedToUtc(y, mo, d, h, mi, s, tz)).toISOString(), dateOnly: dateOnly };
  }
  var WAGER_STATUS_WORDS = [
    [/^(w|win|won|winner|winning|paid|cashed)$/, 'WON'], [/^(l|loss|lost|lose|loser|losing)$/, 'LOST'],
    [/^(p|push|pushed|tie|draw)$/, 'PUSH'],
    [/^(void|voided|cancel+ed|cancel+ation|refund(ed)?|no ?action|rejected|returned)$/, 'VOID'],
    [/^(cash ?out|cashed ?out|cashout|early ?payout)$/, 'CASHED_OUT'],
    [/^(open|pending|unsettled|active|in ?play|live|placed|accepted|running)$/, 'OPEN'],
    [/^(settled|graded|closed)$/, 'SETTLED']
  ];
  function readStatus(x) {
    var t = cellText(x);
    if (t == null) return { value: 'OPEN', defaulted: true };
    t = t.toLowerCase().replace(/[^a-z ]/g, '').trim();
    for (var i = 0; i < WAGER_STATUS_WORDS.length; i++) if (WAGER_STATUS_WORDS[i][0].test(t)) return { value: WAGER_STATUS_WORDS[i][1] };
    return { error: 'BAD_STATUS' };
  }
  function readSide(x) {
    var t = cellText(x);
    if (t == null) return null;
    if (/^(y|yes|long)$/i.test(t)) return 'YES';
    if (/^(n|no|short)$/i.test(t)) return 'NO';
    return t;
  }
  function readAction(x) {
    var t = cellText(x);
    if (t == null) return { value: 'BUY', defaulted: true };
    if (/^(b|buy|bought|open|opened|purchase|long)$/i.test(t)) return { value: 'BUY' };
    if (/^(s|sell|sold|close|closed|exit)$/i.test(t)) return { value: 'SELL' };
    return { error: 'BAD_ACTION' };
  }
  var TYPE_RULES = [
    [/same[ -]?game|\bsgp\b/, 'SAME_GAME_PARLAY'], [/parlay|accumulator|\bmulti\b|teaser|round robin/, 'PARLAY'],
    [/future|outright|champion|to win the (super bowl|title|championship|pennant|world series|cup)|\bmvp\b|award|division winner|win total/, 'FUTURE'],
    [/player|passing|rushing|receiving|rebounds|assists|strikeouts|anytime|scorer|\bprop\b|props/, 'PLAYER_PROP'],
    [/spread|handicap|run ?line|puck ?line|\bats\b/, 'SPREAD'],
    [/total|over|under|\bo\/u\b/, 'TOTAL'],
    [/moneyline|money line|\bml\b|h2h|match winner|to win/, 'MONEYLINE']
  ];
  function inferType(text) {
    var t = String(text || '').toLowerCase();
    for (var i = 0; i < TYPE_RULES.length; i++) if (TYPE_RULES[i][0].test(t)) return TYPE_RULES[i][1];
    return 'OTHER';
  }
  /* a bonus (free) bet: stated in its own column, or named in the status or
     bet type — never assumed from a stake that merely looks small */
  function readStakeType(x, alsoText) {
    var t = cellText(x);
    if (t != null) {
      if (/^(y|yes|true|1|bonus|free|free ?bet|bonus ?bet|site ?credit|bet ?credit|promo|token)$/i.test(t)) return 'BONUS';
      if (/^(n|no|false|0|cash|real|standard|none)$/i.test(t)) return 'CASH';
    }
    if (/\b(free ?bet|bonus ?bet|bet ?credit|site ?credit|no[- ]sweat)\b/i.test(String(alsoText || ''))) return 'BONUS';
    return t == null ? null : 'UNKNOWN';
  }
  function readPositionType(x) {
    var t = cellText(x);
    if (t == null) return null;
    var u = t.toUpperCase().replace(/[^A-Z]+/g, '_').replace(/^_|_$/g, '');
    if (E.POSITION_TYPES.indexOf(u) >= 0) return u;
    return inferType(t);
  }

  /* ═══ 3. ADAPTERS ═════════════════════════════════════════════════════ */
  /* field order is assignment priority: an earlier field claims a header first */
  var SPORTSBOOK_FIELDS = [
    { key: 'placed_at', label: 'Placed (date/time)', required: true, aliases: ['placedat', 'dateplaced', 'placed', 'placeddate', 'betdate', 'wagerdate', 'betplaced', 'date', 'datetime', 'time', 'timestamp', 'created', 'createdat'] },
    { key: 'settled_at', label: 'Settled (date/time)', aliases: ['settledat', 'settled', 'settleddate', 'datesettled', 'gradeddate', 'resultdate'] },
    { key: 'event_start_at', label: 'Event start', aliases: ['eventstart', 'eventdate', 'gamedate', 'starttime', 'kickoff', 'gametime'] },
    { key: 'platform', label: 'Sportsbook', aliases: ['platform', 'sportsbook', 'book', 'bookmaker', 'operator', 'site'] },
    { key: 'sport', label: 'Sport', aliases: ['sport'] },
    { key: 'league', label: 'League', aliases: ['league', 'competition'] },
    { key: 'external_id', label: 'Bet ID', aliases: ['betid', 'wagerid', 'ticketid', 'ticket', 'ticketnumber', 'betnumber', 'betslipid', 'reference', 'receipt', 'id'] },
    { key: 'status', label: 'Status / result', aliases: ['status', 'result', 'betstatus', 'wagerstatus', 'grade', 'settlement', 'outcome'] },
    { key: 'odds_decimal', label: 'Decimal odds', aliases: ['decimalodds', 'oddsdecimal', 'decimalprice', 'decimal'] },
    { key: 'odds', label: 'Odds', required: true, aliases: ['americanodds', 'oddsamerican', 'usodds', 'americanprice', 'odds', 'price'] },
    { key: 'stake', label: 'Stake', required: true, aliases: ['stake', 'risk', 'risked', 'wager', 'wageramount', 'betamount', 'stakeamount', 'amount'] },
    { key: 'payout', label: 'Payout (amount returned)', aliases: ['payout', 'totalpayout', 'return', 'returned', 'totalreturn', 'amountreturned', 'paid', 'winnings', 'cashoutamount'] },
    { key: 'profit', label: 'Profit', aliases: ['profit', 'netprofit', 'profitloss', 'pl', 'pnl', 'net', 'netwin'] },
    { key: 'fees', label: 'Fees', aliases: ['fees', 'fee', 'commission'] },
    { key: 'stake_type', label: 'Bonus / free bet', aliases: ['staketype', 'freebet', 'bonusbet', 'bonus', 'promo', 'promotion', 'betcredit', 'sitecredit', 'tokentype', 'boost'] },
    { key: 'line', label: 'Line', aliases: ['line', 'handicap', 'spread', 'points', 'number'] },
    { key: 'position_type', label: 'Bet type', aliases: ['positiontype', 'bettype', 'wagertype', 'markettype'] },
    { key: 'market_name', label: 'Market', aliases: ['market', 'marketname', 'category', 'type'] },
    { key: 'event_name', label: 'Event', required: true, aliases: ['event', 'eventname', 'game', 'matchup', 'match', 'fixture', 'teams', 'description'] },
    { key: 'selection', label: 'Selection', required: true, aliases: ['selection', 'selectionname', 'pick', 'bet', 'betdescription', 'team', 'side'] },
    { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'memo'] }
  ];
  var PREDICTION_FIELDS = [
    { key: 'executed_at', label: 'Traded (date/time)', required: true, aliases: ['executedat', 'executed', 'filledat', 'filled', 'tradedate', 'tradetime', 'date', 'datetime', 'time', 'timestamp', 'created', 'createdat'] },
    { key: 'settled_at', label: 'Resolved (date/time)', aliases: ['settledat', 'settled', 'resolvedat', 'resolutiondate'] },
    { key: 'platform', label: 'Platform', aliases: ['platform', 'exchange', 'venue', 'site'] },
    { key: 'sport', label: 'Sport', aliases: ['sport'] },
    { key: 'league', label: 'League', aliases: ['league'] },
    { key: 'external_id', label: 'Trade ID', aliases: ['tradeid', 'fillid', 'transactionid', 'executionid', 'txid', 'txhash', 'id'] },
    { key: 'action', label: 'Buy / sell', aliases: ['action', 'buysell', 'direction', 'tradetype', 'type'] },
    { key: 'side', label: 'Side (YES / NO / outcome)', required: true, aliases: ['side', 'outcome', 'position', 'yesno', 'contractside'] },
    { key: 'quantity', label: 'Contracts', required: true, aliases: ['contracts', 'shares', 'quantity', 'qty', 'size', 'count'] },
    { key: 'price', label: 'Price per contract', required: true, aliases: ['price', 'fillprice', 'avgprice', 'averageprice', 'entryprice', 'pricepershare', 'pricepercontract'] },
    { key: 'fee', label: 'Fee', aliases: ['fee', 'fees', 'tradingfee', 'commission'] },
    { key: 'resolution', label: 'Resolved as', aliases: ['resolution', 'resolvedas', 'settledas', 'result', 'winner', 'settlement'] },
    { key: 'settlement_price', label: 'Settlement price', aliases: ['settlementprice', 'resolutionprice', 'settlevalue'] },
    { key: 'current_price', label: 'Current price (your mark)', aliases: ['currentprice', 'lastprice', 'markprice', 'mark', 'marketprice'] },
    { key: 'position_type', label: 'Market type', aliases: ['positiontype', 'markettype'] },
    { key: 'market_name', label: 'Market', aliases: ['market', 'marketname', 'markettitle', 'contract', 'contractname', 'ticker', 'marketticker'] },
    { key: 'event_name', label: 'Event / question', required: true, aliases: ['event', 'eventname', 'eventtitle', 'question', 'title'] },
    { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comment', 'memo'] }
  ];
  function proposeMap(fields, headers) {
    var tokens = headers.map(headerToken), used = {}, map = {};
    fields.forEach(function (f) {
      for (var a = 0; a < f.aliases.length; a++) {
        var i = tokens.indexOf(f.aliases[a]);
        if (i >= 0 && !used[i]) { map[f.key] = headers[i]; used[i] = true; return; }
      }
    });
    return map;
  }
  function scoreMap(fields, map, bonus) {
    var s = 0;
    fields.forEach(function (f) { if (map[f.key]) s += f.required ? 3 : 1; });
    return s + (bonus || 0);
  }
  function cell(record, map, key) { return map[key] ? record[map[key]] : null; }

  function normalizeWager(record, map, ctx) {
    var issues = [], n = { kind: 'wager', platform_type: 'SPORTSBOOK' };
    function err(code, msg) { issues.push({ level: 'error', code: code, message: msg }); }
    function warn(code, msg) { issues.push({ level: 'warning', code: code, message: msg }); }
    function info(code, msg) { issues.push({ level: 'info', code: code, message: msg }); }
    platformInto(n, cell(record, map, 'platform'), ctx, err);
    var pd = readDate(cell(record, map, 'placed_at'), ctx.timezone, ctx.dateOrder);
    if (pd.error || !pd.value) err(pd.error === 'BAD_DATE_ORDER' ? 'BAD_DATE_ORDER' : 'BAD_PLACED_AT', pd.error === 'BAD_DATE_ORDER' ? 'This date only reads day-first. Switch the date order.' : 'The placed date could not be read.');
    else { n.placed_at = pd.value; if (pd.dateOnly) info('DATE_ONLY', 'No time given; recorded at midday.'); }
    var sd = readDate(cell(record, map, 'settled_at'), ctx.timezone, ctx.dateOrder);
    if (sd.error) warn('BAD_SETTLED_AT', 'The settled date could not be read; it will be recorded at import time.');
    else if (sd.value) n.settled_at = sd.value;
    var ed = readDate(cell(record, map, 'event_start_at'), ctx.timezone, ctx.dateOrder);
    if (ed.value) n.event_start_at = ed.value;
    n.sport = shortText(cell(record, map, 'sport'), 30, true);
    n.league = shortText(cell(record, map, 'league'), 30, true);
    n.event_name = shortText(cell(record, map, 'event_name'), 200);
    n.selection = shortText(cell(record, map, 'selection'), 200);
    var typed = readPositionType(cell(record, map, 'position_type'));
    var market = shortText(cell(record, map, 'market_name'), 200);
    n.position_type = typed || inferType([market, n.selection].join(' '));
    if (!typed && n.position_type !== 'OTHER') info('TYPE_INFERRED', 'Bet type read from the market text.');
    n.market_name = market || E.POSITION_TYPE_LABEL[n.position_type];
    if (!n.event_name) err('MISSING_EVENT_NAME', 'No event.');
    if (!n.selection) err('MISSING_SELECTION', 'No selection.');
    var ln = readNumber(cell(record, map, 'line'));
    if (ln.error) warn('BAD_LINE', 'The line could not be read and was left blank.');
    else if (ln.value != null) n.line = ln.value;
    else if (n.selection && /^(SPREAD|TOTAL|PLAYER_PROP)$/.test(n.position_type)) {
      var lm = /(?:^|\s)([+-]?\d{1,3}(?:\.\d+)?)\s*$/.exec(n.selection);
      if (lm && Math.abs(Number(lm[1])) < 100) { n.line = E.dec.str(lm[1]); info('LINE_FROM_SELECTION', 'Line read from the selection.'); }
    }
    var od = readOdds(cell(record, map, 'odds'), false), oc = readOdds(cell(record, map, 'odds_decimal'), true);
    if (od.american != null) n.odds_american = od.american;
    else if (od.decimal) n.odds_decimal = od.decimal;
    if (oc.decimal) { if (n.odds_american == null) n.odds_decimal = oc.decimal; }
    /* "50" reads as decimal 50.00 — a real longshot price, or a typo for an
       American price that does not exist; a person decides which */
    if (od.decimal && /^\d+$/.test(String(cellText(cell(record, map, 'odds')) || '')) && +od.decimal >= 21) {
      warn('ODDS_AMBIGUOUS', 'Odds of ' + od.decimal + ' were read as decimal (' + E.americanText(E.decimalToAmerican(od.decimal)) + '). Check that is right.');
    }
    if (od.error || (oc.error && n.odds_american == null && !n.odds_decimal)) err('BAD_ODDS', 'The odds could not be read.');
    else if (n.odds_american == null && !n.odds_decimal) err('BAD_ODDS', 'No odds.');
    var st = readMoney(cell(record, map, 'stake'));
    if (st.error === 'AMBIGUOUS_DECIMAL') err('AMBIGUOUS_DECIMAL', 'The stake uses a decimal comma; EdgeDesk will not guess which.');
    else if (st.error || !st.value || E.dec.sign(st.value) <= 0) err('BAD_STAKE', 'The stake must be a positive amount.');
    else if (E.dec.cmp(E.dec.round(st.value, 2), st.value) !== 0) err('BAD_STAKE', 'The stake has fractions of a cent.');
    else n.stake = st.value;
    var ss = readStatus(cell(record, map, 'status'));
    if (ss.error) { warn('UNKNOWN_STATUS', 'Status "' + String(cell(record, map, 'status')).slice(0, 40) + '" is not one EdgeDesk knows; recorded as open.'); n.status = 'OPEN'; }
    else n.status = ss.value;
    var pay = readMoney(cell(record, map, 'payout')), prof = readMoney(cell(record, map, 'profit'));
    if (pay.error) warn('BAD_PAYOUT', 'The payout could not be read.');
    if (pay.value != null && n.status !== 'OPEN') n.reported_payout = pay.value;
    if (n.reported_payout == null && prof.value != null && n.stake && n.status !== 'OPEN') {
      n.reported_payout = E.dec.add(n.stake, prof.value);
      info('PAYOUT_FROM_PROFIT', 'Payout taken as stake plus the reported profit.');
    }
    if (n.reported_payout != null && E.dec.sign(n.reported_payout) < 0) { err('BAD_PAYOUT', 'A payout cannot be negative.'); delete n.reported_payout; }
    var fe = readMoney(cell(record, map, 'fees'));
    if (fe.error) warn('BAD_FEES', 'Fees could not be read; recorded as 0.');
    else if (fe.value != null) n.fees = fe.value;
    var sk = readStakeType(cell(record, map, 'stake_type'), [cell(record, map, 'status'), cell(record, map, 'position_type'), market].join(' '));
    if (sk === 'BONUS') { n.stake_type = 'BONUS'; info('BONUS_BET', 'A bonus (free) bet: it risks no cash and only its winnings count.'); }
    else if (sk === 'UNKNOWN') warn('UNKNOWN_STAKE_TYPE', 'The bonus / free-bet column says "' + String(cell(record, map, 'stake_type')).slice(0, 30) + '"; recorded as cash.');
    if ((n.status === 'CASHED_OUT' || n.status === 'SETTLED') && n.reported_payout == null) err('PAYOUT_NEEDED', 'A cash-out or settled bet needs the amount paid.');
    /* the book's own number wins, but a disagreement with the price is worth a look */
    if (n.stake && (n.odds_american != null || n.odds_decimal) && n.reported_payout != null) {
      var win = E.wagerProfit(n.stake, n.odds_american, n.odds_decimal), bonus = n.stake_type === 'BONUS';
      var expect = n.status === 'WON' ? (bonus ? win : E.dec.add(n.stake, win))
        : n.status === 'LOST' ? '0' : (n.status === 'PUSH' || n.status === 'VOID') ? (bonus ? '0' : n.stake) : null;
      if (expect != null && E.dec.cmp(E.dec.sub(expect, n.reported_payout).replace(/^-/, ''), '0.01') > 0) {
        warn('PAYOUT_MISMATCH', 'The payout (' + E.money(n.reported_payout) + ') differs from what the odds pay (' + E.money(expect) + ').');
      }
    }
    var ext = cellText(cell(record, map, 'external_id'));
    if (ext) n.external_position_id = ext.slice(0, 200);
    n.notes = shortText(cell(record, map, 'notes'), 2000);
    if (n.placed_at && Date.parse(n.placed_at) > (ctx.now || Date.now()) + 86400000) err('FUTURE_PLACED_AT', 'Placed in the future.');
    if (n.settled_at && n.placed_at && Date.parse(n.settled_at) < Date.parse(n.placed_at)) { warn('SETTLED_BEFORE_PLACED', 'Settled before it was placed; the settled time was dropped.'); delete n.settled_at; }
    if (n.status === 'OPEN') delete n.settled_at;
    /* a settled bet with no settled time: the placed time, never "today" —
       otherwise a year of imported history would all land in the last 7 days */
    else if (!n.settled_at && n.placed_at) { n.settled_at = n.placed_at; info('SETTLED_AT_PLACED', 'No settled time in the file; recorded at the placed time.'); }
    return { normalized: compact(n), issues: issues };
  }

  function normalizeFill(record, map, ctx) {
    var issues = [], n = { kind: 'fill', platform_type: 'PREDICTION_MARKET' };
    function err(code, msg) { issues.push({ level: 'error', code: code, message: msg }); }
    function warn(code, msg) { issues.push({ level: 'warning', code: code, message: msg }); }
    function info(code, msg) { issues.push({ level: 'info', code: code, message: msg }); }
    platformInto(n, cell(record, map, 'platform'), ctx, err);
    var xd = readDate(cell(record, map, 'executed_at'), ctx.timezone, ctx.dateOrder);
    if (xd.error || !xd.value) err(xd.error === 'BAD_DATE_ORDER' ? 'BAD_DATE_ORDER' : 'BAD_EXECUTED_AT', xd.error === 'BAD_DATE_ORDER' ? 'This date only reads day-first. Switch the date order.' : 'The trade date could not be read.');
    else { n.executed_at = xd.value; if (xd.dateOnly) info('DATE_ONLY', 'No time given; recorded at midday.'); }
    var sd = readDate(cell(record, map, 'settled_at'), ctx.timezone, ctx.dateOrder);
    if (sd.value) n.settled_at = sd.value;
    n.sport = shortText(cell(record, map, 'sport'), 30, true);
    n.league = shortText(cell(record, map, 'league'), 30, true);
    n.event_name = shortText(cell(record, map, 'event_name'), 200);
    n.market_name = shortText(cell(record, map, 'market_name'), 200);
    if (!n.event_name && n.market_name) n.event_name = n.market_name;
    if (!n.market_name && n.event_name) { n.market_name = n.event_name; info('MARKET_FROM_EVENT', 'Market taken from the event.'); }
    if (!n.event_name) err('MISSING_EVENT_NAME', 'No event or question.');
    n.side = readSide(cell(record, map, 'side'));
    if (!n.side) err('MISSING_SIDE', 'No side (YES / NO or the outcome).');
    else n.selection = n.side;
    n.position_type = readPositionType(cell(record, map, 'position_type')) || 'EVENT_CONTRACT';
    var ac = readAction(cell(record, map, 'action'));
    if (ac.error) err('BAD_ACTION', 'A trade is a buy or a sell.');
    else n.action = ac.value;
    var q = readNumber(cell(record, map, 'quantity'));
    if (q.error || !q.value || E.dec.sign(q.value) <= 0) err('BAD_QUANTITY', 'Contracts must be a positive number.');
    else if (E.dec.cmp(E.dec.round(q.value, 6), q.value) !== 0) err('BAD_QUANTITY', 'Contracts carry at most six decimals.');
    else n.quantity = q.value;
    var pr = readPrice(cell(record, map, 'price'), ctx.priceCents);
    if (pr.error || pr.value == null) err('BAD_PRICE', 'A contract price is between $0.00 and $1.00.');
    else n.price = pr.value;
    var fe = readMoney(cell(record, map, 'fee'));
    if (fe.error) warn('BAD_FEES', 'The fee could not be read; recorded as 0.');
    else if (fe.value != null) { if (E.dec.sign(fe.value) < 0) err('BAD_FEES', 'A fee cannot be negative.'); else n.fee = fe.value; }
    var res = cellText(cell(record, map, 'resolution'));
    if (res) {
      var rs = readSide(res);
      n.resolution = /^(void|voided|cancel+ed|refund(ed)?)$/i.test(res) ? 'VOID' : rs;
    }
    ['settlement_price', 'current_price'].forEach(function (k) {
      var v = readPrice(cell(record, map, k), ctx.priceCents);
      if (v.error) warn('BAD_' + k.toUpperCase(), 'The ' + k.replace('_', ' ') + ' could not be read.');
      else if (v.value != null) n[k] = v.value;
    });
    if (n.resolution && !n.settled_at && n.executed_at) { n.settled_at = n.executed_at; info('SETTLED_AT_TRADE', 'No resolution time in the file; recorded at this trade\u2019s time.'); }
    var ext = cellText(cell(record, map, 'external_id'));
    if (ext) n.external_transaction_id = ext.slice(0, 200);
    n.notes = shortText(cell(record, map, 'notes'), 1000);
    if (n.executed_at && Date.parse(n.executed_at) > (ctx.now || Date.now()) + 86400000) err('FUTURE_EXECUTED_AT', 'Traded in the future.');
    return { normalized: compact(n), issues: issues };
  }

  function platformInto(n, text, ctx, err) {
    var t = cellText(text), key = t ? E.resolvePlatform(t) : null;
    if (t && !key) { key = E.customPlatformKey(t); n.platform_label = t.slice(0, 60); }
    if (!t) { key = ctx.platform || null; n.platform_label = ctx.platformLabel || null; }
    if (!key || !E.PLATFORM_KEY_RE.test(key)) { err('BAD_PLATFORM', 'No platform: map a platform column or choose one for the whole file.'); return; }
    n.platform = key;
    n.platform_label = n.platform_label || E.platformLabel(key);
  }
  function shortText(x, max, upper) {
    var t = cellText(x);
    if (t == null) return null;
    t = t.replace(/\s+/g, ' ').slice(0, max);
    return upper && t.length <= 6 ? t.toUpperCase() : t;
  }
  function compact(o) { var r = {}; Object.keys(o).forEach(function (k) { if (o[k] != null && o[k] !== '') r[k] = o[k]; }); return r; }

  /* ═══ 3b. LEG ROWS: one row per parlay leg, the ticket repeated ═══════
     Bet trackers (Juice Reel style) export ONE ROW PER LEG: the ticket's id,
     stake, price, status and payout are repeated on every leg row. Summing
     those rows would count a 3-leg parlay's stake three times, so the rows
     are grouped by the ticket id FIRST — before normalizeWager — into one
     wager with its legs. Rules:
       - the ticket id (bet / ticket / wager id) is the grouping key (split
         only when one id's rows name two different books); a row with no id
         is its own single (NO_TICKET_ID);
       - a ticket-level amount is never summed across its rows: the first
         row that states it is used, and rows that DISAGREE on one are
         flagged (TICKET_FIELDS_DIFFER) instead of guessed;
       - the same leg listed twice under one ticket is counted once and
         reported (DUPLICATE_ROW_MERGED, or DUPLICATE_LEG_DIFFERS when the
         copies are not identical);
       - with no ticket price, the price is the legs' product
         (EDPortfolio.parlay); with no ticket status, the legs decide it. */
  function sbAliases(key) { return SPORTSBOOK_FIELDS.filter(function (f) { return f.key === key; })[0].aliases; }
  var LEG_ROW_FIELDS = [
    { key: 'external_id', label: 'Ticket / bet ID', required: true, aliases: ['ticketid', 'betid', 'wagerid', 'ticket', 'ticketnumber', 'ticketno', 'betnumber', 'betno', 'betslipid', 'slipid', 'betslip', 'parlayid', 'reference', 'receipt', 'confirmation', 'confirmationnumber', 'id'] },
    { key: 'leg_number', label: 'Leg number', aliases: ['legnumber', 'legno', 'legnum', 'leg', 'legindex', 'legid', 'legseq', 'legsequence', 'legposition', 'selectionnumber'] },
    { key: 'leg_count', label: 'Legs on the ticket', aliases: ['legs', 'legcount', 'numlegs', 'numberoflegs', 'totallegs', 'nlegs'] },
    { key: 'placed_at', label: 'Placed (date/time)', required: true, aliases: sbAliases('placed_at') },
    { key: 'settled_at', label: 'Settled (date/time)', aliases: sbAliases('settled_at') },
    { key: 'event_start_at', label: 'Event start', aliases: sbAliases('event_start_at') },
    { key: 'platform', label: 'Sportsbook', aliases: sbAliases('platform') },
    { key: 'sport', label: 'Sport', aliases: ['sport'] },
    { key: 'league', label: 'League', aliases: ['league', 'competition'] },
    { key: 'bet_type', label: 'Bet type (single / parlay)', aliases: ['bettype', 'wagertype', 'tickettype', 'betkind', 'betstyle', 'straightparlay'] },
    { key: 'status', label: 'Ticket status / result', aliases: ['status', 'result', 'betstatus', 'wagerstatus', 'ticketstatus', 'betresult', 'grade', 'settlement', 'outcome'] },
    { key: 'leg_status', label: 'Leg result', aliases: ['legstatus', 'legresult', 'legoutcome', 'leggrade', 'selectionresult', 'selectionstatus'] },
    { key: 'odds_decimal', label: 'Ticket decimal odds', aliases: ['decimalodds', 'oddsdecimal', 'decimalprice', 'decimal', 'ticketdecimalodds'] },
    { key: 'odds', label: 'Ticket odds', aliases: ['ticketodds', 'totalodds', 'parlayodds', 'betodds', 'americanodds', 'oddsamerican', 'usodds', 'americanprice', 'odds', 'price'] },
    { key: 'leg_odds', label: 'Leg odds', aliases: ['legodds', 'legprice', 'legamericanodds', 'selectionodds', 'legdecimalodds'] },
    { key: 'closing_odds', label: 'Closing odds', aliases: ['closingodds', 'closingline', 'closingprice', 'close', 'closeodds', 'closingamericanodds', 'clvodds'] },
    { key: 'stake', label: 'Stake', required: true, aliases: ['stake', 'risk', 'risked', 'wager', 'wageramount', 'betamount', 'stakeamount', 'amount', 'towager', 'riskamount'] },
    { key: 'payout', label: 'Payout (amount returned)', aliases: sbAliases('payout').concat(['payoutamount']) },
    { key: 'profit', label: 'Profit', aliases: sbAliases('profit').concat(['netresult']) },
    { key: 'fees', label: 'Fees', aliases: ['fees', 'fee', 'commission'] },
    { key: 'stake_type', label: 'Bonus / free bet', aliases: sbAliases('stake_type') },
    { key: 'line', label: 'Line', aliases: ['line', 'handicap', 'spread', 'points', 'number', 'legline'] },
    { key: 'position_type', label: 'Market type (of the leg)', aliases: ['markettype', 'positiontype', 'legtype', 'legmarkettype'] },
    { key: 'market_name', label: 'Market', aliases: ['market', 'marketname', 'legmarket', 'category', 'type'] },
    { key: 'event_name', label: 'Event', required: true, aliases: ['event', 'eventname', 'game', 'matchup', 'match', 'fixture', 'teams', 'legevent', 'eventdescription', 'description'] },
    { key: 'selection', label: 'Selection', required: true, aliases: ['selection', 'selectionname', 'pick', 'bet', 'betdescription', 'team', 'side', 'legselection', 'legdescription'] },
    { key: 'notes', label: 'Notes', aliases: ['notes', 'note', 'comments', 'comment', 'memo'] }
  ];
  /* ticket-level fields: compared across a ticket's rows, never summed.
     MONEY ones decide the ticket's figures, so a disagreement there makes the
     ticket unusable for P&L until the reader says which row is right. */
  var TICKET_FIELDS = ['stake', 'odds', 'odds_decimal', 'payout', 'profit', 'status', 'fees', 'stake_type', 'placed_at', 'settled_at', 'bet_type', 'platform', 'leg_count'];
  var TICKET_MONEY_FIELDS = ['stake', 'odds', 'odds_decimal', 'payout', 'profit', 'status', 'fees', 'stake_type'];
  var PARLAY_WORDS = /parlay|accumulator|\bacca\b|\bmulti\b|same[ -]?game|\bsgp\b|bet ?builder|teaser|round ?robin/;
  function ticketValue(k, x, ctx) {
    var t = cellText(x);
    if (t == null) return null;
    if (k === 'stake' || k === 'payout' || k === 'profit' || k === 'fees') { var m = readMoney(t); return m.value != null ? 'm' + m.value : 'x' + t; }
    if (k === 'odds' || k === 'odds_decimal') { var o = readOdds(t, k === 'odds_decimal'); return o.american != null ? 'a' + o.american : o.decimal ? 'd' + o.decimal : 'x' + t; }
    if (k === 'status') { var s = readStatus(t); return s.value || 'x' + t.toLowerCase(); }
    if (k === 'placed_at' || k === 'settled_at') { var d = readDate(t, ctx.timezone, ctx.dateOrder); return d.value || 'x' + t; }
    if (k === 'platform') return E.resolvePlatform(t) || E.customPlatformKey(t) || t.toLowerCase();
    return t.toLowerCase().replace(/\s+/g, ' ');
  }
  function legOdds(x) { var o = readOdds(x, false); return o.american != null ? { odds_american: o.american } : o.decimal ? { odds_decimal: o.decimal } : {}; }
  function legKey(rec, map) {
    var ln = cellText(cell(rec, map, 'leg_number'));
    if (ln) return '#' + ln.toLowerCase();
    var lo = legOdds(cell(rec, map, 'leg_odds'));
    return [E.normText(cell(rec, map, 'event_name')), E.normText(cell(rec, map, 'market_name')), E.normText(cell(rec, map, 'selection')),
      E.numText(readNumber(cell(rec, map, 'line')).value), lo.odds_american != null ? 'a' + lo.odds_american : lo.odds_decimal ? 'd' + lo.odds_decimal : ''].join('|');
  }
  function sameCells(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) if (String(a[ka[i]] == null ? '' : a[ka[i]]).trim() !== String(b[ka[i]] == null ? '' : b[ka[i]]).trim()) return false;
    return true;
  }
  /* records → tickets, on the raw cells. Each ticket: { id, rows: [indexes],
     legs: [indexes of distinct legs], duplicates: [{ index, of, exact }],
     conflicts: [field keys], merged: one record with every ticket-level cell
     filled from the first row that states it }. Pure; reads no clock. */
  function groupTickets(records, map, ctx) {
    ctx = ctx || {};
    /* by id first; one id is split only when its rows name two different
       books (a row that leaves the book blank stays with the row before it) */
    var tickets = [], byId = {};
    records.forEach(function (rec, i) {
      var id = cellText(cell(rec, map, 'external_id'));
      if (!id) { tickets.push({ id: null, rows: [i] }); return; }
      if (!byId[id]) { byId[id] = { id: id.slice(0, 200), rows: [] }; tickets.push(byId[id]); }
      byId[id].rows.push(i);
    });
    tickets = [].concat.apply([], tickets.map(function (t) {
      if (!t.id) return [t];
      var subs = [], byBook = {}, last = null;
      var fresh = function () { var g = { id: t.id, rows: [], book: null }; subs.push(g); return g; };
      t.rows.forEach(function (i) {
        var pt = cellText(cell(records[i], map, 'platform')), k = pt ? (E.resolvePlatform(pt) || E.customPlatformKey(pt) || pt.toLowerCase()) : null, g;
        if (k) {
          g = byBook[k] || (last && !last.book ? last : null) || fresh();
          g.book = k; byBook[k] = g;
        } else g = last || fresh();
        g.rows.push(i); last = g;
      });
      subs.forEach(function (g) { delete g.book; });
      return subs;
    }));
    tickets.forEach(function (t) {
      var seen = {};
      t.legs = []; t.duplicates = []; t.conflicts = [];
      t.rows.forEach(function (i) {
        var k = legKey(records[i], map);
        if (seen[k] == null) { seen[k] = i; t.legs.push(i); return; }
        t.duplicates.push({ index: i, of: seen[k], exact: sameCells(records[i], records[seen[k]]) });
      });
      var merged = Object.assign({}, records[t.rows[0]]);
      TICKET_FIELDS.forEach(function (f) {
        if (!map[f]) return;
        var vals = {}, first = null;
        t.rows.forEach(function (i) {
          var raw = records[i][map[f]], v = ticketValue(f, raw, ctx);
          if (v == null) return;
          vals[v] = 1;
          if (first == null) first = raw;
        });
        if (Object.keys(vals).length > 1) t.conflicts.push(f);
        if (first != null) merged[map[f]] = first;
      });
      t.merged = merged;
    });
    return tickets;
  }
  function betTypeOf(text, legs, oneEvent) {
    var t = String(text || '').toLowerCase();
    if (/same[ -]?game|\bsgp\b|bet ?builder/.test(t)) return 'SAME_GAME_PARLAY';
    if (/teaser/.test(t)) return 'TEASER';
    if (/round ?robin/.test(t)) return 'ROUND_ROBIN';
    if (PARLAY_WORDS.test(t)) return 'PARLAY';
    if (legs > 1) return oneEvent ? 'SAME_GAME_PARLAY' : 'PARLAY';
    return 'SINGLE';
  }
  var BET_TYPE_NAME = { PARLAY: 'Parlay', SAME_GAME_PARLAY: 'Same-game parlay', TEASER: 'Teaser', ROUND_ROBIN: 'Round robin' };
  /* a ticket's result from its legs' (EDPortfolio.parlay's rule, no prices
     needed): one lost leg loses it, an open leg keeps it open, pushed and
     voided legs drop out, and a ticket of nothing but those is a push */
  function legsStatus(legs) {
    var rs = legs.map(function (l) { return String(l.result || 'OPEN').toUpperCase(); });
    if (rs.indexOf('LOST') >= 0) return 'LOST';
    if (rs.some(function (r) { return r !== 'WON' && r !== 'PUSH' && r !== 'VOID'; })) return 'OPEN';
    return rs.indexOf('WON') >= 0 ? 'WON' : 'PUSH';
  }
  /* the leg-row adapter's grouping step: records → one staged row per ticket */
  function groupLegRecords(records, map, ctx) {
    var tickets = groupTickets(records, map, ctx), rows = [], fileIssues = [];
    var joined = 0, multi = 0, dupExact = 0, dupDiffer = 0, noId = 0, conflicted = 0;
    tickets.forEach(function (t) {
      var issues = [], m2 = Object.assign({}, map), merged = Object.assign({}, t.merged);
      var legs = t.legs.map(function (i) {
        var rec = records[i], lo = legOdds(cell(rec, map, 'leg_odds')), ls = readStatus(cell(rec, map, 'leg_status'));
        var market = shortText(cell(rec, map, 'market_name'), 200), sel = shortText(cell(rec, map, 'selection'), 200);
        var leg = { leg_number: cellText(cell(rec, map, 'leg_number')), selection: sel, event_name: shortText(cell(rec, map, 'event_name'), 200), market_name: market,
          position_type: readPositionType(cell(rec, map, 'position_type')) || inferType([market, sel].join(' ')),
          line: readNumber(cell(rec, map, 'line')).value || null, odds_american: lo.odds_american != null ? lo.odds_american : null, odds_decimal: lo.odds_decimal || null,
          result: map.leg_status && !ls.error && !ls.defaulted ? ls.value : null, sport: shortText(cell(rec, map, 'sport'), 30, true), league: shortText(cell(rec, map, 'league'), 30, true) };
        var co = legOdds(cell(rec, map, 'closing_odds'));
        if (co.odds_american != null) leg.closing_odds_american = co.odds_american; else if (co.odds_decimal) leg.closing_odds_decimal = co.odds_decimal;
        return compact(leg);
      });
      var events = {}; legs.forEach(function (l) { if (l.event_name) events[E.normText(l.event_name)] = l.event_name; });
      var oneEvent = Object.keys(events).length <= 1;
      var btText = cellText(cell(merged, map, 'bet_type'));
      var bt = betTypeOf(btText, legs.length, oneEvent), parlayFamily = bt !== 'SINGLE';
      var noTicketPrice = !cellText(cell(merged, map, 'odds')) && !cellText(cell(merged, map, 'odds_decimal'));
      /* the legs that price the ticket: a pushed or voided leg drops out (the book re-prices without it) */
      var pricing = legs.filter(function (l) { return l.result !== 'PUSH' && l.result !== 'VOID'; });
      if (noTicketPrice && legs.length > 1 && pricing.length && pricing.every(function (l) { return l.odds_american != null || l.odds_decimal; })) {
        /* a parlay with no ticket price: the legs' product, by the engine's own rule */
        var pxAll = E.parlay(pricing.map(function (l) { return { odds_american: l.odds_american, odds_decimal: l.odds_decimal, result: 'OPEN' }; }));
        if (pxAll && pxAll.odds_decimal) {
          merged.__ticket_odds = pxAll.odds_decimal; m2.odds_decimal = '__ticket_odds'; m2.odds = null;
          issues.push({ level: 'info', code: 'ODDS_FROM_LEGS', message: 'No ticket price in the file; the price is the product of the ' + pricing.length + ' legs’ prices ('
            + E.americanText(pxAll.odds_american) + ')' + (pricing.length < legs.length ? ', without the ' + (legs.length - pricing.length) + ' pushed or voided' : '') + '.' });
        }
      } else if (noTicketPrice && legs.length === 1 && (legs[0].odds_american != null || legs[0].odds_decimal)) {
        /* a single's price may sit in the leg column */
        if (legs[0].odds_american != null) { merged.__ticket_odds = String(legs[0].odds_american); m2.odds = '__ticket_odds'; m2.odds_decimal = null; }
        else { merged.__ticket_odds = legs[0].odds_decimal; m2.odds_decimal = '__ticket_odds'; m2.odds = null; }
      }
      /* no ticket status: the legs decide it, when every leg has a result */
      var legsGraded = legs.length > 1 && legs.every(function (l) { return l.result; }), fromLegs = legsGraded ? legsStatus(legs) : null;
      if (!cellText(cell(merged, map, 'status')) && fromLegs) {
        merged.__ticket_status = fromLegs; m2.status = '__ticket_status';
        issues.push({ level: 'info', code: 'STATUS_FROM_LEGS', message: 'No ticket status in the file; read from the legs’ results (' + fromLegs.toLowerCase() + ').' });
      }
      if (legs.length > 1 && btText && /^(single|straight|straight bet|singles?)$/i.test(btText)) {
        issues.push({ level: 'warning', code: 'BET_TYPE_DISAGREES', message: 'The bet type reads "' + btText.slice(0, 30) + '" but ' + legs.length + ' different legs share this ticket id.' });
      }
      var out = normalizeWager(merged, m2, ctx), n = out.normalized;
      issues = out.issues.concat(issues);
      if (!t.id) {
        noId++;
        issues.push({ level: 'warning', code: 'NO_TICKET_ID', message: 'This row has no ticket id, so it is read as its own single bet.' });
      }
      if (t.conflicts.length) {
        conflicted++;
        issues.push({ level: 'warning', code: 'TICKET_FIELDS_DIFFER', fields: t.conflicts.slice(),
          message: 'The rows of ticket ' + t.id + ' disagree on ' + t.conflicts.map(function (f) { return f.replace('_', ' '); }).join(', ') + '; EdgeDesk will not guess which is right.' });
      }
      t.duplicates.forEach(function (d) {
        if (d.exact) dupExact++; else dupDiffer++;
        issues.push(d.exact ? { level: 'info', code: 'DUPLICATE_ROW_MERGED', message: 'Row ' + (d.index + 1) + ' repeats row ' + (d.of + 1) + ' exactly and was counted once.' }
          : { level: 'warning', code: 'DUPLICATE_LEG_DIFFERS', message: 'Row ' + (d.index + 1) + ' lists the same leg as row ' + (d.of + 1) + ' with different details; the first was kept.' });
      });
      var lc = cellText(cell(merged, map, 'leg_count'));
      if (lc && /^\d+$/.test(lc) && +lc !== legs.length && (+lc > 1 || legs.length > 1)) {
        issues.push({ level: 'warning', code: 'LEG_COUNT_MISMATCH', message: 'The file says ' + lc + ' legs; ' + legs.length + ' leg row' + (legs.length === 1 ? ' was' : 's were') + ' found.' });
      }
      if (parlayFamily) {
        if (legs.length > 1) {
          multi++; joined += t.rows.length - 1;
          /* the first leg's own line and type notes say nothing about the ticket */
          issues = issues.filter(function (x) { return x.code !== 'LINE_FROM_SELECTION' && x.code !== 'TYPE_INFERRED'; });
          n.legs =legs.slice(0, 30).map(function (l) { var c = Object.assign({}, l); delete c.sport; delete c.league; return c; });
          if (legs.length > 30) issues.push({ level: 'warning', code: 'TOO_MANY_LEGS', message: 'Only the first 30 legs are kept.' });
          n.event_name = oneEvent ? (legs[0].event_name || n.event_name) : ('Parlay: ' + Object.keys(events).slice(0, 3).map(function (k) { return events[k]; }).join(' · ')).slice(0, 200);
          n.selection = legs.map(function (l) { return l.selection; }).filter(Boolean).join(' + ').slice(0, 200) || n.selection;
          n.market_name = BET_TYPE_NAME[bt] + ' (' + legs.length + ' legs)';
          delete n.line;
          var sports = {}; legs.forEach(function (l) { if (l.sport) sports[l.sport] = 1; });
          if (Object.keys(sports).length > 1) n.sport = 'MULTI';
          issues.push({ level: 'info', code: 'LEGS_GROUPED', message: t.rows.length + ' rows share ticket ' + t.id + ' and were read as one ' + BET_TYPE_NAME[bt].toLowerCase() + ' with ' + legs.length + ' legs; its stake is counted once.' });
          /* the book's grading wins, but a ticket that disagrees with its own legs is worth a look */
          if (fromLegs && (n.status === 'WON' || n.status === 'LOST') && fromLegs !== 'OPEN' && fromLegs !== n.status) {
            issues.push({ level: 'warning', code: 'LEG_STATUS_DISAGREES', message: 'The ticket reads ' + n.status.toLowerCase() + ' but its legs read ' + fromLegs.toLowerCase() + '.' });
          }
        } else if (!/parlay/i.test(n.market_name || '')) {
          n.market_name = (BET_TYPE_NAME[bt] + (n.market_name ? ': ' + n.market_name : '')).slice(0, 200);
        }
        n.position_type = bt === 'SAME_GAME_PARLAY' ? 'SAME_GAME_PARLAY' : 'PARLAY';
        if (bt === 'TEASER' || bt === 'ROUND_ROBIN') n.bet_type = bt;
      } else if (legs.length === 1) {
        if (legs[0].closing_odds_american != null) n.closing_odds_american = legs[0].closing_odds_american;
        else if (legs[0].closing_odds_decimal) n.closing_odds_decimal = legs[0].closing_odds_decimal;
      }
      rows.push({ row_number: t.rows[0] + 1, raw: records[t.rows[0]], normalized: n, issues: issues,
        legRows: t.rows.slice(1).map(function (i) { return i + 1; }), merged: merged,
        ticket: { id: t.id, rows: t.rows.map(function (i) { return i + 1; }), legs: legs.length, duplicates: t.duplicates.length, conflicts: t.conflicts.slice(), betType: bt } });
    });
    if (multi) fileIssues.push({ level: 'info', code: 'LEG_ROWS_JOINED', message: joined + ' leg row' + (joined === 1 ? '' : 's') + ' were joined into ' + multi + ' multi-leg ticket' + (multi === 1 ? '' : 's') + '; each ticket’s stake is counted once.' });
    if (dupExact || dupDiffer) fileIssues.push({ level: dupDiffer ? 'warning' : 'info', code: 'DUPLICATE_ROWS_MERGED', message: (dupExact + dupDiffer) + ' row' + (dupExact + dupDiffer === 1 ? '' : 's') + ' repeated a leg already listed for the same ticket and ' + (dupExact + dupDiffer === 1 ? 'was' : 'were') + ' counted once' + (dupDiffer ? ' (' + dupDiffer + ' with different details: check them)' : '') + '.' });
    if (noId) fileIssues.push({ level: 'warning', code: 'NO_TICKET_ID_ROWS', message: noId + ' row' + (noId === 1 ? ' has' : 's have') + ' no ticket id; each is read as its own single bet.' });
    if (conflicted) fileIssues.push({ level: 'warning', code: 'TICKET_FIELDS_DIFFER', message: conflicted + ' ticket' + (conflicted === 1 ? '' : 's') + ' list different stakes, prices, results or dates on different rows; ' + (conflicted === 1 ? 'it needs' : 'they need') + ' review.' });
    return { rows: rows, fileIssues: fileIssues, report: { rowsRead: records.length, tickets: tickets.length, multiLegTickets: multi, legRowsJoined: joined, duplicateRows: dupExact + dupDiffer, duplicateRowsExact: dupExact, noTicketId: noId, conflictedTickets: conflicted } };
  }
  /* does a file look like leg rows? a leg column, or a ticket id repeated on
     rows that list different legs AND repeat the same stake (the shape that
     double-counts when summed). One row per bet never does. */
  function looksLikeLegRows(headers, records) {
    var map = proposeMap(LEG_ROW_FIELDS, headers);
    if (map.leg_number || map.leg_odds || map.leg_status || map.leg_count) return true;
    if (!records || !map.external_id || !map.stake) return false;
    var groups = {};
    records.forEach(function (r) { var id = cellText(r[map.external_id]); if (id) (groups[id] = groups[id] || []).push(r); });
    return Object.keys(groups).some(function (id) {
      var g = groups[id];
      if (g.length < 2) return false;
      var legsSeen = {}, stakes = {};
      g.forEach(function (r) { legsSeen[legKey(r, map)] = 1; var s = cellText(r[map.stake]); if (s) stakes[s] = (stakes[s] || 0) + 1; });
      return Object.keys(legsSeen).length > 1 && Object.keys(stakes).some(function (s) { return stakes[s] > 1; });
    });
  }

  var ADAPTERS = {
    generic_sportsbook_v1: {
      key: 'generic_sportsbook_v1', label: 'Sportsbook bets — one row per bet', platformType: 'SPORTSBOOK', fields: SPORTSBOOK_FIELDS,
      detect: function (headers) {
        var map = proposeMap(SPORTSBOOK_FIELDS, headers), t = headers.map(headerToken).join(' ');
        return scoreMap(SPORTSBOOK_FIELDS, map, (/odds|stake|risk|wager/.test(t) ? 3 : 0) - (/contracts|shares|yes|no\b/.test(t) ? 3 : 0));
      },
      normalize: normalizeWager
    },
    /* one row per LEG, the ticket repeated on each (bet trackers such as
       Juice Reel): rows are grouped by ticket id before normalizing, so a
       3-leg parlay is ONE wager with 3 legs and its stake counted once.
       Chosen automatically only when the file shows it: a leg column, or a
       ticket id repeated on rows with different legs and the same stake —
       otherwise the generic reading above wins, unchanged. */
    leg_rows_sportsbook_v1: {
      key: 'leg_rows_sportsbook_v1', label: 'Sportsbook bets — one row per parlay leg (bet trackers)', platformType: 'SPORTSBOOK', fields: LEG_ROW_FIELDS,
      detect: function (headers, records) {
        var map = proposeMap(SPORTSBOOK_FIELDS, headers), t = headers.map(headerToken).join(' ');
        var base = scoreMap(SPORTSBOOK_FIELDS, map, (/odds|stake|risk|wager/.test(t) ? 3 : 0) - (/contracts|shares|yes|no\b/.test(t) ? 3 : 0));
        return base + (looksLikeLegRows(headers, records) ? 4 : -1);
      },
      group: groupLegRecords,
      normalize: normalizeWager
    },
    generic_prediction_market_v1: {
      key: 'generic_prediction_market_v1', label: 'Prediction-market trades — one row per buy or sell', platformType: 'PREDICTION_MARKET', fields: PREDICTION_FIELDS,
      detect: function (headers) {
        var map = proposeMap(PREDICTION_FIELDS, headers), t = headers.map(headerToken).join(' ');
        return scoreMap(PREDICTION_FIELDS, map, (/contracts|shares|question|resolution/.test(t) ? 3 : 0) - (/odds|stake|risk/.test(t) ? 3 : 0));
      },
      normalize: normalizeFill
    }
  };
  /* headers (and, when given, the parsed records) → the best adapter; a tie
     goes to the one registered first */
  function detect(headers, records) {
    var best = null, bestScore = -1e9;
    Object.keys(ADAPTERS).forEach(function (k) {
      var sc = ADAPTERS[k].detect(headers, records);
      if (sc > bestScore) { bestScore = sc; best = ADAPTERS[k]; }
    });
    return { adapter: best, score: bestScore };
  }
  /* contract prices given as whole cents (Kalshi style) — only when EVERY price is */
  function pricesLookLikeCents(rows, column) {
    if (!column) return false;
    var seen = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = cellText(rows[i][column]);
      if (v == null) continue;
      if (!/^\d{1,2}$/.test(v) || +v < 1) return false;
      seen++;
    }
    return seen > 0;
  }

  /* ═══ 4. PLATFORM PROFILES ══════════════════════════════════════════════
     A profile names a platform and how a file can be recognised as theirs:
     the file's name, or a platform column in it. It does NOT assert a column
     layout: EdgeDesk has not checked any sportsbook's export against a real
     file yet (verified: false), so every column is mapped by the generic
     aliases and shown for review, and a layout the reader has imported
     before is remembered (headerSignature) instead of guessed. */
  var PROFILES = [
    { key: 'draftkings', platform: 'draftkings', adapter: 'generic_sportsbook_v1', verified: false, fileName: /draft ?kings|\bdk[_ -]/i },
    { key: 'fanduel', platform: 'fanduel', adapter: 'generic_sportsbook_v1', verified: false, fileName: /fan ?duel|\bfd[_ -]/i },
    { key: 'betmgm', platform: 'betmgm', adapter: 'generic_sportsbook_v1', verified: false, fileName: /bet ?mgm|\bmgm\b/i },
    { key: 'caesars', platform: 'williamhill_us', adapter: 'generic_sportsbook_v1', verified: false, fileName: /caesars|william ?hill/i },
    { key: 'bet365', platform: 'bet365', adapter: 'generic_sportsbook_v1', verified: false, fileName: /bet ?365/i },
    /* secondary sportsbooks: the same generic reading, recognised by name */
    { key: 'betrivers', platform: 'betrivers', adapter: 'generic_sportsbook_v1', verified: false, secondary: true, fileName: /bet ?rivers/i },
    { key: 'fanatics', platform: 'fanatics', adapter: 'generic_sportsbook_v1', verified: false, secondary: true, fileName: /fanatics/i },
    { key: 'espnbet', platform: 'espnbet', adapter: 'generic_sportsbook_v1', verified: false, secondary: true, fileName: /espn ?bet|the ?score ?bet/i },
    { key: 'kalshi_csv', platform: 'kalshi', adapter: 'generic_prediction_market_v1', verified: false, fileName: /kalshi/i },
    { key: 'polymarket_csv', platform: 'polymarket', adapter: 'generic_prediction_market_v1', verified: false, fileName: /polymarket/i }
  ];
  function profileFor(platform) { return PROFILES.filter(function (p) { return p.platform === platform; })[0] || null; }
  /* the columns of a file, as a stable signature: normalized header names,
     sorted — never a cell of data */
  function headerSignature(headers) {
    var seen = {}, out = [];
    (headers || []).forEach(function (h) { var t = headerToken(h); if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out.sort().join('|').slice(0, 2000);
  }
  /* which platform a file is from, and how EdgeDesk knows: the reader's
     choice, a platform column every row agrees on, or the file's name — in
     that order. Anything less certain asks the reader. */
  function detectPlatform(headers, records, map, fileName, chosen) {
    if (chosen) return { platform: chosen, how: 'CHOSEN' };
    if (map && map.platform) {
      var keys = {};
      (records || []).forEach(function (r) { var t = cellText(r[map.platform]); if (t) keys[E.resolvePlatform(t) || E.customPlatformKey(t)] = 1; });
      var k = Object.keys(keys);
      if (k.length === 1) return { platform: k[0], how: 'COLUMN' };
      if (k.length > 1) return { platform: null, how: 'MIXED', platforms: k };
    }
    var byName = PROFILES.filter(function (p) { return p.fileName.test(String(fileName || '')); });
    if (byName.length === 1) return { platform: byName[0].platform, how: 'FILE_NAME' };
    return { platform: null, how: 'ASK' };
  }
  /* A parlay exported one leg per row under one bet id becomes one position
     with its legs: the price, stake, status and payout are the bet's (the
     first row that states them); every leg's selection is kept. */
  function groupLegs(rows) {
    var groups = {}, merged = {};
    rows.forEach(function (r) {
      var n = r.normalized, id = n && n.kind === 'wager' && n.external_position_id ? n.platform + '|' + n.external_position_id : null;
      if (id) (groups[id] = groups[id] || []).push(r);
    });
    Object.keys(groups).forEach(function (id) {
      var g = groups[id];
      if (g.length < 2) return;
      /* the same bet listed twice is a duplicate (the server says so), not a parlay */
      var distinct = {}; g.forEach(function (r) { distinct[(r.normalized.selection || '') + '|' + (r.normalized.event_name || '')] = 1; });
      if (Object.keys(distinct).length < 2) return;
      var head = g[0], n = Object.assign({}, head.normalized);
      var legs = g.map(function (r) { return { selection: r.normalized.selection || null, event_name: r.normalized.event_name || null,
        market_name: r.normalized.market_name || null, line: r.normalized.line || null, odds_american: r.normalized.odds_american || null }; }).slice(0, 30);
      var events = {}; legs.forEach(function (l) { if (l.event_name) events[l.event_name] = 1; });
      var oneEvent = Object.keys(events).length === 1;
      n.legs = legs;
      n.position_type = oneEvent ? 'SAME_GAME_PARLAY' : 'PARLAY';
      n.market_name = (oneEvent ? 'Same-game parlay' : 'Parlay') + ' (' + legs.length + ' legs)';
      n.event_name = oneEvent ? Object.keys(events)[0] : ('Parlay: ' + Object.keys(events).slice(0, 3).join(' · ')).slice(0, 200);
      n.selection = legs.map(function (l) { return l.selection; }).filter(Boolean).join(' + ').slice(0, 200);
      delete n.line;
      ['stake', 'odds_american', 'odds_decimal', 'reported_payout', 'status', 'settled_at', 'stake_type'].forEach(function (k) {
        if (n[k] == null) { var w = g.filter(function (r) { return r.normalized[k] != null; })[0]; if (w) n[k] = w.normalized[k]; }
      });
      var issues = head.issues.slice();
      var stakes = {}; g.forEach(function (r) { if (r.normalized.stake) stakes[r.normalized.stake] = 1; });
      if (Object.keys(stakes).length > 1) issues.push({ level: 'warning', code: 'LEG_STAKES_DIFFER', message: 'The legs of this bet list different stakes; the first was used.' });
      issues.push({ level: 'info', code: 'LEGS_GROUPED', message: legs.length + ' rows share this bet id and were read as one parlay.' });
      head.normalized = n; head.issues = issues; head.legRows = g.slice(1).map(function (r) { return r.row_number; });
      g.slice(1).forEach(function (r) { merged[r.row_number] = head.row_number; });
    });
    return rows.filter(function (r) { return !merged[r.row_number]; });
  }
  /* the span of a file's activity, as months ("Aug 2024 – Oct 2026") */
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateRange(rows) {
    var lo = null, hi = null;
    (rows || []).forEach(function (r) {
      var n = r.normalized || r, t = Date.parse(n.placed_at || n.executed_at || '');
      if (!isFinite(t)) return;
      if (lo == null || t < lo) lo = t; if (hi == null || t > hi) hi = t;
    });
    if (lo == null) return null;
    var f = function (t) { var d = new Date(t); return MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
    return { from: new Date(lo).toISOString(), to: new Date(hi).toISOString(), text: f(lo) === f(hi) ? f(lo) : f(lo) + ' – ' + f(hi) };
  }
  /* THE TOTALS CHECK: where the file states each bet's profit (or payout),
     its own total over the won / lost / pushed / voided bets is compared with
     what the stated odds and stakes pay (cash-outs have no independent check
     and are left out); a difference is shown, never silently reconciled */
  function totalsCheck(records, rows, map) {
    if (!map || (!map.profit && !map.payout)) return null;
    var stated = '0', computed = '0', n = 0;
    rows.forEach(function (r, i) {
      var nz = r.normalized;
      if (!nz || nz.kind !== 'wager' || !nz.stake || nz.status === 'OPEN' || r.issues.some(function (x) { return x.level === 'error'; })) return;
      if (['WON', 'LOST', 'PUSH', 'VOID'].indexOf(nz.status) < 0) return;
      var rec = records[i] || r.raw || {}, d = E.derive(Object.assign({}, nz, { reported_payout: null }));
      if (d.profit_loss == null) return;
      var v = null;
      if (map.profit) { var pr = readMoney(rec[map.profit]); if (pr.value != null) v = pr.value; }
      if (v == null && map.payout) { var py = readMoney(rec[map.payout]); if (py.value != null) v = E.dec.sub(py.value, nz.stake_type === 'BONUS' ? '0' : nz.stake); }
      if (v == null) return;
      stated = E.dec.add(stated, v); computed = E.dec.add(computed, d.profit_loss); n++;
    });
    if (!n) return null;
    var diff = E.dec.sub(computed, stated), off = E.dec.cmp(diff.replace(/^-/, ''), '0.01') > 0;
    return { rows: n, stated: stated, computed: computed, difference: diff, agrees: !off };
  }
  /* What the rows about to be imported come to, by the same arithmetic the
     database runs — an estimate until they are stored and derived there. */
  function estimate(rows) {
    var out = { rows: 0, settled: 0, open: 0, pnl: '0', staked: '0', exposure: '0', bonus: 0 };
    (rows || []).forEach(function (r) {
      var n = r.normalized || r;
      if (!n || n.kind !== 'wager' || !n.stake) return;
      out.rows++;
      if (n.stake_type === 'BONUS') out.bonus++;
      var d = E.derive(n);
      if (d.profit_loss != null) { out.settled++; out.pnl = E.dec.add(out.pnl, d.profit_loss); out.staked = E.dec.add(out.staked, d.cost_basis || '0'); }
      else if (d.status === 'OPEN') { out.open++; out.exposure = E.dec.add(out.exposure, d.open_cost_basis || '0'); }
    });
    out.roi = E.dec.sign(out.staked) > 0 ? E.dec.divRound(out.pnl, out.staked, 6) : null;
    return out;
  }

  /* text → staged rows. opts: adapter (key), map, platform, platformLabel,
     timezone, dateOrder ('MDY' | 'DMY'), now, fileName */
  function stage(text, opts) {
    opts = opts || {};
    var fileIssues = [];
    if (String(text || '').length > MAX_BYTES) return { fileIssues: [{ level: 'error', code: 'FILE_TOO_LARGE', message: 'Files up to 5 MB.' }], rows: [] };
    var parsed = parseCSV(text);
    if (parsed.rows.length < 2) return { fileIssues: [{ level: 'error', code: 'NO_ROWS', message: 'The file has a header row and no data.' }], rows: [], delimiter: parsed.delimiter, headers: parsed.rows[0] || [] };
    var headers = parsed.rows[0].map(function (h, i) { var t = String(h).trim() || ('Column ' + (i + 1)); return t.slice(0, 80); });
    var seen = {};
    headers = headers.map(function (h) { var k = h; var j = 2; while (seen[k]) k = h + ' (' + (j++) + ')'; seen[k] = true; return k; });
    var tz = opts.timezone && E.validTz(opts.timezone) ? opts.timezone : 'UTC';
    if (opts.timezone && tz !== opts.timezone) fileIssues.push({ level: 'warning', code: 'BAD_TIMEZONE', message: 'Unknown time zone; times read as UTC.' });
    var body = parsed.rows.slice(1);
    if (body.length > MAX_ROWS) {
      fileIssues.push({ level: 'error', code: 'TOO_MANY_ROWS', message: 'One import holds at most ' + MAX_ROWS + ' rows; split the file.' });
      body = body.slice(0, MAX_ROWS);
    }
    var records = body.map(function (r) {
      var o = {};
      headers.forEach(function (h, i) { var v = r[i] == null ? '' : String(r[i]); o[h] = v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v; });
      return o;
    });
    /* the records are read before the format is chosen, so an adapter can
       recognise a shape (leg rows) that the header names alone do not show */
    var found = detect(headers, records);
    var adapter = (opts.adapter && ADAPTERS[opts.adapter]) || found.adapter;
    var map = opts.map || proposeMap(adapter.fields, headers);
    var cents = adapter.platformType === 'PREDICTION_MARKET' && pricesLookLikeCents(records, map.price);
    if (cents) fileIssues.push({ level: 'info', code: 'PRICES_IN_CENTS', message: 'Every price is a whole number from 1 to 99, so prices are read as cents.' });
    adapter.fields.forEach(function (f) {
      if (f.required && !map[f.key] && !(f.key === 'platform' && opts.platform)) fileIssues.push({ level: 'warning', code: 'UNMAPPED_' + f.key.toUpperCase(), message: f.label + ' is not mapped to a column.' });
    });
    if (!map.platform && !opts.platform) fileIssues.push({ level: 'warning', code: 'NO_PLATFORM', message: 'Choose the platform these rows came from, or map a platform column.' });
    var plat = detectPlatform(headers, records, map, opts.fileName, opts.platform);
    if (plat.how === 'MIXED') fileIssues.push({ level: 'info', code: 'MANY_PLATFORMS', message: 'The file names ' + plat.platforms.length + ' platforms; each row keeps its own.' });
    var ctx = { timezone: tz, dateOrder: opts.dateOrder === 'DMY' ? 'DMY' : 'MDY', platform: opts.platform || (plat.how === 'FILE_NAME' ? plat.platform : undefined),
      platformLabel: opts.platformLabel || (plat.how === 'FILE_NAME' ? E.platformLabel(plat.platform) : undefined), priceCents: cents, now: opts.now };
    var rows, staged, totals, grouping = null;
    if (adapter.group) {
      /* leg rows: grouped into tickets BEFORE normalizing, one staged row each */
      grouping = adapter.group(records, map, ctx);
      rows = staged = grouping.rows;
      grouping.fileIssues.forEach(function (x) { fileIssues.push(x); });
      totals = totalsCheck(staged.map(function (r) { return r.merged || r.raw; }), staged, map);
    } else {
      rows = records.map(function (rec, i) {
        var out = adapter.normalize(rec, map, ctx);
        return { row_number: i + 1, raw: rec, normalized: out.normalized, issues: out.issues };
      });
      staged = adapter.platformType === 'SPORTSBOOK' ? groupLegs(rows) : rows;
      totals = adapter.platformType === 'SPORTSBOOK' ? totalsCheck(records, rows, map) : null;
    }
    if (totals) {
      fileIssues.push(totals.agrees
        ? { level: 'info', code: 'TOTALS_AGREE', message: 'Totals check: the file\u2019s own results over ' + totals.rows + ' settled bets (' + E.money(totals.stated, { sign: true }) + ') match what their odds and stakes pay.' }
        : { level: 'warning', code: 'TOTALS_DIFFER', message: 'Totals check: the file\u2019s own results over ' + totals.rows + ' settled bets come to ' + E.money(totals.stated, { sign: true })
          + '; their odds and stakes pay ' + E.money(totals.computed, { sign: true }) + ' (EdgeDesk calculates). The rows marked "payout differs" explain the gap; the book\u2019s own figures are what get stored.' });
    }
    var profile = plat.platform ? profileFor(plat.platform) : null;
    if (profile && profile.verified === false && plat.how !== 'MIXED') {
      fileIssues.push({ level: 'info', code: 'PROFILE_UNVERIFIED', message: 'EdgeDesk has not yet checked this format against a real ' + E.platformLabel(plat.platform)
        + ' export. Check the columns below before importing.' });
    }
    return { adapter: adapter.key, adapterLabel: adapter.label, platformType: adapter.platformType, detectedScore: found.score,
      headers: headers, map: map, delimiter: parsed.delimiter, timezone: tz, dateOrder: ctx.dateOrder, priceCents: cents,
      rows: staged, mergedRows: records.length - staged.length, tickets: grouping ? grouping.report : null, fileIssues: fileIssues, signature: headerSignature(headers), range: dateRange(staged), totals: totals,
      platform: plat.platform, platformHow: plat.how, profile: profile ? { key: profile.key, verified: profile.verified } : null };
  }
  /* what the browser can say before the server classifies: errors are
     INVALID, warnings NEED REVIEW; duplicates are the server's call */
  function localCounts(rows) {
    var c = { total: rows.length, ok: 0, review: 0, invalid: 0 };
    rows.forEach(function (r) {
      var lv = r.issues.map(function (x) { return x.level; });
      if (lv.indexOf('error') >= 0) c.invalid++; else if (lv.indexOf('warning') >= 0) c.review++; else c.ok++;
    });
    return c;
  }

  return {
    MAX_ROWS: MAX_ROWS, MAX_BYTES: MAX_BYTES, ADAPTERS: ADAPTERS,
    parseCSV: parseCSV, detectDelimiter: detectDelimiter, headerToken: headerToken, detect: detect, proposeMap: proposeMap,
    readMoney: readMoney, readNumber: readNumber, readOdds: readOdds, readPrice: readPrice, readDate: readDate,
    readStatus: readStatus, readSide: readSide, readAction: readAction, inferType: inferType,
    normalizeWager: normalizeWager, normalizeFill: normalizeFill, stage: stage, localCounts: localCounts,
    PROFILES: PROFILES, profileFor: profileFor, headerSignature: headerSignature, detectPlatform: detectPlatform, groupLegs: groupLegs,
    LEG_ROW_FIELDS: LEG_ROW_FIELDS, TICKET_MONEY_FIELDS: TICKET_MONEY_FIELDS, groupTickets: groupTickets, groupLegRecords: groupLegRecords, looksLikeLegRows: looksLikeLegRows, legsStatus: legsStatus,
    estimate: estimate, readStakeType: readStakeType, dateRange: dateRange, totalsCheck: totalsCheck
  };
}));
