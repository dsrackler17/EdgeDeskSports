/* ===========================================================================
   EDGEDESK PORTFOLIO — Screenshot / Paste Import ("Import picks").
   docs/bet-import.md

   For books with no history export (Novig, ProphetX, Kalshi, DraftKings
   Predictions, …): the reader adds screenshots of their bet history, or
   pastes its text; EdgeDesk's reader (supabase/functions/parse_bet_import —
   Claude, vision) turns them into one row per bet; the reader checks every
   row in an editable table; and only the rows they confirm are saved.

     1  BOOK     Detect automatically (the default: the reader names the
                 platform from the screenshot itself) · Novig · ProphetX ·
                 Kalshi · DK Predictions · Other; each row's platform can be
                 changed in review
     2  ADD      screenshots (camera roll; scaled and re-encoded on this
                 device, tall scrolling captures cut into overlapping tiles;
                 never stored) — reading starts as soon as they are chosen —
                 or pasted text
     3  REVIEW   every field editable; fields the reader was unsure of are
                 highlighted; a row with an error cannot be confirmed; each
                 pick is matched to an EdgeDesk game (public.signals) so its
                 CLV can be graded, and an unmatched one says so and offers
                 the games to pick from. A row with nothing to check (valid,
                 no warning, nothing unsure, its game settled) arrives
                 already confirmed; the reader can untick it. More
                 screenshots can be added to the same review.
     4  SAVE     the confirmed rows go through the Portfolio's OWN import
                 pipeline under the reader's token — portfolio_imports →
                 portfolio_import_rows → portfolio_import_commit() — into
                 public.portfolio_positions, labelled IMPORT_SCREENSHOT or
                 IMPORT_PASTE. A pick already in the portfolio (same platform,
                 event, market, selection, price, stake and placed minute: the
                 Portfolio's fingerprint) is never saved twice: when it was
                 saved Open and this screenshot shows its result, that one
                 position is UPDATED in place (status / resolution, what it
                 paid, when) under RLS; otherwise it is skipped.

   NOTHING IS WRITTEN before the reader presses Confirm: reading, matching
   and the duplicate check are reads; a pre-confirmed row is a tick, not a
   save. Nothing financial is kept in localStorage. Every value is escaped
   where it is rendered.

   Browser: window.EDBetImport.attach(host, ctx).   Node: the pure parts are
   exported for tools/portfolio/bet_import.test.js.
   =========================================================================== */
(function (root, factory) {
  var req = typeof require === 'function' ? require : null;
  var E = root.EDPortfolio || (req ? req('./edgedesk_portfolio.js') : null);
  var C = root.EDBetImportCore || (req ? req('./edgedesk_bet_import_core.js') : null);
  var api = factory(root, E, C);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDBetImport = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root, E, C) {
  'use strict';

  var VERSION = 'bet_import_ui_v2';
  var FUNCTION = 'parse_bet_import';
  var IMPORTER = { screenshot: 'screenshot_v1', paste: 'paste_v1' };
  var MAX_FILES = 12;                 /* per session; each may become several tiles */
  var MAX_FILE_BYTES = 30 * 1048576;  /* what a phone camera roll can hand over, before scaling */
  var BATCH = 3;                      /* images per request: shorter calls, progress the reader can see */
  var LONG_EDGE = 2576;               /* the model's own high-resolution limit */
  var PASTE_MAX = 120000;             /* pasted text, read in parts of under 40,000 characters */
  var POSITION_TYPE = { moneyline: 'MONEYLINE', spread: 'SPREAD', total: 'TOTAL', prop: 'PLAYER_PROP', parlay: 'PARLAY', future: 'FUTURE', other: 'OTHER' };
  var STATUS = { open: 'OPEN', won: 'WON', lost: 'LOST', push: 'PUSH', void: 'VOID', cashed_out: 'CASHED_OUT', unknown: 'OPEN' };
  var STATUS_LABEL = { open: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', cashed_out: 'Cashed out', unknown: 'Not read' };
  var MARKET_LABEL = { moneyline: 'Moneyline', spread: 'Spread', total: 'Total', prop: 'Prop', parlay: 'Parlay', future: 'Future', other: 'Other' };
  /* a league as the reader read it → the capture's sport keys */
  var SPORT_KEYS = { NFL: ['americanfootball_nfl'], NCAAF: ['americanfootball_ncaaf'], CFB: ['americanfootball_ncaaf'],
    NBA: ['basketball_nba'], WNBA: ['basketball_wnba'], NCAAB: ['basketball_ncaab'], CBB: ['basketball_ncaab'], NCAAM: ['basketball_ncaab'],
    MLB: ['baseball_mlb'], NHL: ['icehockey_nhl'], MLS: ['soccer_usa_mls'], EPL: ['soccer_epl'], UFC: ['mma_mixed_martial_arts'], MMA: ['mma_mixed_martial_arts'] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function blank(x) { return x == null || String(x).trim() === ''; }

  /* ═══ 1. TIME — the reader's local wall time ⇄ UTC ═════════════════════ */
  function toUtc(local, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
    if (!m) return null;
    var t = E.zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 0, tz || 'UTC');
    return isFinite(t) ? new Date(t).toISOString() : null;
  }
  function toLocal(iso, tz) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    try {
      var p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(t)).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day + 'T' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute;
    } catch (_) { return new Date(t).toISOString().slice(0, 16); }
  }
  function todayIn(tz, now) { return E.localDate(now == null ? Date.now() : now, tz || 'UTC'); }
  function whenText(iso, tz) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t)); }
    catch (_) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* ═══ 2. THE PLATFORM a row is filed under ═════════════════════════════ */
  function platformOf(bet) {
    var key = bet.book_key, p = key ? E.platform(key) : null;
    if (key && !p && E.PLATFORM_KEY_RE.test(key)) return { platform: key, platform_label: E.platformLabel(key, bet.book_label), platform_type: bet.platform_type };
    if (p) return { platform: p.key, platform_label: p.label, platform_type: p.type };
    var label = String(bet.book_label || '').trim().slice(0, 60), resolved = label ? E.resolvePlatform(label) : null;
    if (resolved && E.platform(resolved)) { p = E.platform(resolved); return { platform: p.key, platform_label: p.label, platform_type: p.type }; }
    var custom = label ? E.customPlatformKey(label) : null;
    return { platform: custom, platform_label: label || null, platform_type: bet.platform_type || null };
  }

  /* ═══ 3. MATCHING A PICK TO AN EDGEDESK GAME ═══════════════════════════
     A team as the capture names it ("Kansas City Chiefs") against the text
     the book printed: the full name inside it scores 3, the nickname as a
     whole word 2, the city as whole words 1. A game is matched on its own
     only when BOTH teams are found, it is the only such game, and its start
     fits the bet (placed at most 10 days before, or during, the game; within
     3 hours of a start the screenshot printed). Anything else is offered,
     never chosen. */
  function N(x) { return E.normText(x); }
  function hasWords(hay, needle) { return needle.length > 0 && (' ' + hay + ' ').indexOf(' ' + needle + ' ') >= 0; }
  function teamScore(text, team) {
    var t = N(text), m = N(team);
    if (!t || !m) return 0;
    if (t === m || hasWords(t, m)) return 3;
    var w = m.split(' '), nick = w[w.length - 1], city = w.slice(0, -1).join(' ');
    if (w.length > 1 && nick.length >= 3 && hasWords(t, nick)) return 2;
    if (city.length >= 4 && hasWords(t, city)) return 1;
    return 0;
  }
  function betTexts(bet) {
    var out = [bet.event, bet.selection, bet.market].concat(bet.teams || []).filter(Boolean);
    return out.length ? out : [''];
  }
  function cityOf(team) { var w = N(team).split(' '); return w.slice(0, -1).join(' '); }
  function scoreEvent(bet, ev, tz) {
    var texts = betTexts(bet), h = 0, a = 0;
    texts.forEach(function (t) { h = Math.max(h, teamScore(t, ev.home_team)); a = Math.max(a, teamScore(t, ev.away_team)); });
    /* a city two teams share (New York Jets / Giants, LA Rams / Chargers) is
       evidence for neither: "New York Giants" does not name the Jets */
    if (cityOf(ev.home_team) && cityOf(ev.home_team) === cityOf(ev.away_team)) { if (h === 1) h = 0; if (a === 1) a = 0; }
    if (!h && !a) return null;
    var start = Date.parse(ev.commence_time), placed = Date.parse(toUtc(bet.placed_at, tz) || '');
    if (isFinite(placed) && isFinite(start) && (placed > start + 5 * 3600000 || start - placed > 10 * 86400000)) return null;
    var printed = bet.event_start ? Date.parse(toUtc(bet.event_start, tz) || '') : NaN, timeFit = 0;
    if (isFinite(printed) && isFinite(start)) { if (Math.abs(printed - start) <= 3 * 3600000) timeFit = 2; else if (Math.abs(printed - start) > 26 * 3600000) return null; }
    var keys = SPORT_KEYS[String(bet.league || '').toUpperCase()];
    if (keys && ev.sport_key && keys.indexOf(ev.sport_key) < 0) return null;
    return { both: h > 0 && a > 0, score: h + a + timeFit, gap: isFinite(placed) && isFinite(start) ? Math.abs(start - placed) : 9e15 };
  }
  function candidates(bet, events, tz) {
    var out = [];
    (events || []).forEach(function (ev) { var s = scoreEvent(bet, ev, tz); if (s) out.push({ ev: ev, both: s.both, score: s.score, gap: s.gap }); });
    out.sort(function (x, y) { return (y.both - x.both) || (y.score - x.score) || (x.gap - y.gap) || (x.ev.event_id < y.ev.event_id ? -1 : 1); });
    return out;
  }
  /* → { state: 'auto' | 'unmatched' | 'na', event, candidates } */
  function matchBet(bet, events, tz) {
    if (bet.market_type === 'parlay' || bet.market_type === 'future') return { state: 'na', event: null, candidates: [] };
    var list = candidates(bet, events, tz);
    var top = list[0], next = list[1];
    var sure = top && top.both && (!next || !next.both || next.score < top.score || next.gap > top.gap + 86400000);
    return { state: sure ? 'auto' : 'unmatched', event: sure ? top.ev : null, candidates: list.slice(0, 8).map(function (c) { return c.ev; }) };
  }
  /* the exact capture key of a sportsbook single, once its game is known */
  function sigKeyFor(bet, ev, markets) {
    if (!ev || bet.platform_type !== 'SPORTSBOOK' || ['moneyline', 'spread', 'total'].indexOf(bet.market_type) < 0) return null;
    var rows = (markets || []).filter(function (m) { return m.event_id === ev.event_id; });
    var line = blank(bet.line) ? null : Number(bet.line);
    if (bet.market_type === 'total') {
      var ou = /\b(over|o)\b|^o\s?\d/i.test(bet.selection) ? 'Over' : /\b(under|u)\b|^u\s?\d/i.test(bet.selection) ? 'Under' : null;
      if (!ou || line == null) return null;
      var t = rows.filter(function (m) { return m.market === 'totals' && m.selection === ou && Number(m.point) === Math.abs(line); })[0];
      return t ? t.sig_key : null;
    }
    /* the pick names its team ("Buffalo Bills", "Chiefs -2.5"); a market that
       names it instead ("Kansas City to win") is read when the pick does not */
    var sh = teamScore(bet.selection, ev.home_team), sa = teamScore(bet.selection, ev.away_team);
    if (!sh && !sa && bet.market) { sh = teamScore(bet.market, ev.home_team); sa = teamScore(bet.market, ev.away_team); }
    if (sh === sa) return null;
    var team = sh > sa ? ev.home_team : ev.away_team;
    var hit = rows.filter(function (m) {
      return m.selection === team && (bet.market_type === 'moneyline' ? m.market === 'h2h' : (m.market === 'spreads' && line != null && Number(m.point) === line));
    })[0];
    return hit ? hit.sig_key : null;
  }
  /* the window of games to fetch for a set of bets: at most 45 days a call */
  function eventWindows(bets, tz) {
    var ts = bets.map(function (b) { return Date.parse(toUtc(b.placed_at, tz) || ''); }).filter(isFinite).sort(function (a, b) { return a - b; });
    if (!ts.length) return [];
    var out = [], from = ts[0] - 86400000, end = ts[ts.length - 1] + 10 * 86400000;
    while (from < end && out.length < 6) { var to = Math.min(end, from + 44 * 86400000); out.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString() }); from = to; }
    return out;
  }
  function sportKeysOf(bets) {
    var keys = {};
    for (var i = 0; i < bets.length; i++) {
      var k = SPORT_KEYS[String(bets[i].league || '').toUpperCase()];
      if (!k) return null;
      k.forEach(function (x) { keys[x] = 1; });
    }
    return Object.keys(keys);
  }

  /* ═══ 4. A CONFIRMED ROW → the staged import rows (the CSV importer's shape)
     A sportsbook pick is one `wager`; a prediction-market pick is one BUY
     `fill` (and a SELL fill when it was sold before it settled). The staged
     `raw` carries what the commit's columns do not — the price as shown, the
     matched game, the reader's confidence — and never an image.
     A contract's count and fee come from the core (C.contractsFor: exact to
     the millionth the database requires; the cost stored is what was paid),
     and what a settled contract paid — a boosted win pays more than $1 a
     contract — is its reported payout. */
  function check(bet, ctx) { return C.checkBet(bet, { today: ctx && ctx.today }); }
  function opposite(side) { return side === 'YES' ? 'NO' : side === 'NO' ? 'YES' : null; }
  /* one game's Over and Under (or two teams' spreads) are different
     contracts: the selection is part of the market's name */
  function contractMarket(bet) {
    var m = String(bet.market || '').trim(), sel = String(bet.selection || '').trim();
    if (!m) return sel || bet.event;
    return !sel || N(m).indexOf(N(sel)) >= 0 ? m : m + ' · ' + sel;
  }
  function stagedRows(bet, ctx, firstRow) {
    var tz = ctx.tz || 'UTC', pl = platformOf(bet), chk = check(bet, ctx), price = chk.price;
    var placed = toUtc(bet.placed_at, tz), m = bet.match || {}, ev = m.event || null;
    var start = ev ? new Date(Date.parse(ev.commence_time)).toISOString() : (bet.event_start ? toUtc(bet.event_start, tz) : null);
    var settledAt = start && placed && Date.parse(start) >= Date.parse(placed) ? start : placed;
    var raw = {
      parser: FUNCTION, core: C.VERSION, ui: VERSION, origin: bet.origin || 'screenshot', model: bet.model || null,
      source_image: bet.source_image, book_as_read: bet.book_as_read || null,
      price_display: bet.price_display || null, price_format: price.format, price_american: price.american,
      event_id: ev ? ev.event_id : null, event_start_at: start, market_sig_key: (m.sig_key || null), match: m.state || 'unmatched',
      confidence: bet.confidence || {}, edited: Object.keys(bet.edited || {}),
      warnings: chk.issues.filter(function (i) { return i.level === 'warning'; }).map(function (i) { return i.code; })
    };
    var common = { platform: pl.platform, platform_label: pl.platform_label, sport: bet.sport || undefined, league: bet.league || undefined,
      event_name: bet.event, event_id: ev ? ev.event_id : undefined, notes: bet.notes ? String(bet.notes).slice(0, 1000) : undefined };
    function clean(o) { var r = {}; Object.keys(o).forEach(function (k) { if (o[k] != null && o[k] !== '') r[k] = o[k]; }); return r; }
    var rows = [];
    if (pl.platform_type === 'PREDICTION_MARKET') {
      var cq = price.error ? null : C.contractsFor(bet, price), q = cq && cq.fit ? C.fromMicro(cq.q) : null, status = bet.status, res = null;
      if (status === 'won') res = bet.side; else if (status === 'lost') res = opposite(bet.side); else if (status === 'void' || status === 'push') res = 'VOID';
      raw.contracts_from = cq ? cq.from : null; raw.boost_pct = bet.boost_pct || null;
      var buy = clean(Object.assign({}, common, { kind: 'fill', platform_type: 'PREDICTION_MARKET', market_name: contractMarket(bet), side: bet.side,
        selection: bet.selection || bet.side, position_type: bet.market_type === 'future' ? 'FUTURE' : 'EVENT_CONTRACT', action: 'BUY',
        quantity: q, price: price.prob, executed_at: placed, fee: cq && cq.fit && cq.fee > 0 ? C.fromMicro(cq.fee) : undefined,
        resolution: res, settled_at: res ? settledAt : undefined, reported_payout: res && !blank(bet.payout) ? bet.payout : undefined,
        external_transaction_id: bet.bet_id || undefined }));
      rows.push({ row_number: firstRow, raw: raw, normalized: buy, issues: [] });
      if (status === 'cashed_out' && q && !blank(bet.payout)) {
        var sellAt = settledAt === placed ? new Date(Date.parse(placed) + 60000).toISOString() : settledAt;
        rows.push({ row_number: firstRow + 1, raw: raw, issues: [], normalized: clean(Object.assign({}, buy, { action: 'SELL', price: C.sellPriceFor(q, bet.payout),
          executed_at: sellAt, fee: undefined, resolution: undefined, settled_at: undefined, reported_payout: undefined,
          external_transaction_id: bet.bet_id ? bet.bet_id + ':sell' : undefined })) });
      }
      return rows;
    }
    var st = STATUS[bet.status] || 'OPEN', w = { kind: 'wager', platform_type: 'SPORTSBOOK', market_name: bet.market || MARKET_LABEL[bet.market_type] || 'Other',
      selection: bet.selection, position_type: POSITION_TYPE[bet.market_type] || 'OTHER', line: blank(bet.line) ? undefined : E.dec.str(bet.line),
      stake: bet.stake ? E.dec.round(bet.stake, 2) : undefined, status: st, placed_at: placed, settled_at: st === 'OPEN' ? undefined : settledAt,
      reported_payout: st !== 'OPEN' && !blank(bet.payout) ? bet.payout : undefined, fees: blank(bet.fees) ? undefined : bet.fees,
      event_start_at: start || undefined, external_position_id: bet.bet_id || undefined, stake_type: bet.is_bonus ? 'BONUS' : undefined,
      legs: bet.market_type === 'parlay' && bet.legs && bet.legs.length ? bet.legs.map(function (l) {
        return clean({ selection: l.selection, event: l.event, market: l.market, line: l.line, price: l.price_display, result: l.status ? (STATUS[l.status] || null) : null });
      }) : undefined };
    if (price.format === 'decimal' || price.format === 'fractional') w.odds_decimal = price.decimal; else w.odds_american = price.american;
    rows.push({ row_number: firstRow, raw: raw, normalized: clean(Object.assign({}, common, w)), issues: [] });
    return rows;
  }
  /* every confirmed bet → staged rows numbered from 1, and which bet each row is */
  function toImportRows(bets, ctx) {
    var rows = [], of = {}, n = 1;
    bets.forEach(function (b) { stagedRows(b, ctx, n).forEach(function (r) { rows.push(r); of[r.row_number] = b.id; n = r.row_number + 1; }); });
    return { rows: rows, betOf: of };
  }
  /* the Portfolio's fingerprint material for a staged row (EDPortfolio ≡ SQL) */
  function materialOf(n) { return n.kind === 'wager' ? E.wagerMaterial(n) : E.fillMaterial(n); }

  /* ═══ 4b. A PICK ALREADY SAVED: what this screenshot changes ══════════
     The fingerprint leaves the result out, so the Open pick saved last week
     and today's screenshot of it Won are the same pick. `ex` is that saved
     position ({ id, status, resolution, reported_payout (text), source }).
     → null (nothing new: skip it, as before)
     | { id, from, to, patch }  the one PATCH that settles it (RLS: the
                                reader's own row; the derive trigger
                                recomputes its profit and result)
     | { conflict, from, to }   it was already settled another way: left
                                alone, the reader edits it in History
     A synced position is the platform's record and is never patched. */
  function sameMoney(a, b) { return C.micro(String(a == null ? '' : a)) === C.micro(String(b == null ? '' : b)); }
  function updatePlan(bet, ex, ctx) {
    if (!ex || ex.source === 'SYNC') return null;
    var n = stagedRows(bet, ctx || {}, 1)[0].normalized, paid = n.reported_payout != null ? String(n.reported_payout) : null;
    var was = String(ex.status || 'OPEN').toUpperCase();
    if (n.kind === 'wager') {
      var to = n.status || 'OPEN';
      if (to === 'OPEN') return null;
      if (was === to) {
        if (paid == null || sameMoney(paid, ex.reported_payout)) return null;
        if (ex.reported_payout == null) return { id: ex.id, from: was, to: to, patch: { reported_payout: paid } };
        return { conflict: true, from: was, to: to };
      }
      if (was !== 'OPEN') return { conflict: true, from: was, to: to };
      return { id: ex.id, from: was, to: to, patch: { status: to, reported_payout: paid, settled_at: n.settled_at || null } };
    }
    if (bet.status === 'cashed_out') return ex.resolution || was !== 'OPEN' ? null : { conflict: true, from: was, to: 'SOLD' };
    var res = n.resolution || null;
    if (!res) return null;
    var toPm = res === 'VOID' ? 'VOID' : res === n.side ? 'WON' : 'LOST';
    if (ex.resolution) {
      if (String(ex.resolution).toUpperCase() !== res) return { conflict: true, from: was, to: toPm };
      if (paid == null || sameMoney(paid, ex.reported_payout)) return null;
      if (ex.reported_payout == null) return { id: ex.id, from: was, to: toPm, patch: { reported_payout: paid } };
      return { conflict: true, from: was, to: toPm };
    }
    if (was !== 'OPEN') return { conflict: true, from: was, to: toPm };
    return { id: ex.id, from: was, to: toPm, patch: { resolution: res, reported_payout: paid, settled_at: n.settled_at || null } };
  }
  async function sha256Hex(s) {
    if (root.crypto && root.crypto.subtle && root.TextEncoder) {
      var d = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(s));
      return Array.prototype.map.call(new Uint8Array(d), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    }
    return require('crypto').createHash('sha256').update(s, 'utf8').digest('hex');
  }

  /* ═══ 5. SCREENSHOTS, PREPARED ON THIS DEVICE ══════════════════════════
     Scaled to the model's limit, re-encoded as JPEG (which also drops the
     photo's location and other metadata), and a tall scrolling capture cut
     into overlapping tiles so its text stays legible. */
  function tilePlan(w, h) {
    if (!(w > 0 && h > 0)) return [];
    var maxH = Math.round(w * 2.2);
    if (h <= Math.round(w * 2.6)) return [{ y: 0, h: h }];
    var overlap = Math.round(maxH * 0.08), out = [], y = 0;
    while (y < h && out.length < 6) { var th = Math.min(maxH, h - y); out.push({ y: y, h: th }); if (y + th >= h) break; y += th - overlap; }
    return out;
  }
  function loadImage(win, file) {
    return new Promise(function (resolve, reject) {
      var url = win.URL.createObjectURL(file), img = new win.Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { win.URL.revokeObjectURL(url); reject(new Error('That file could not be opened as an image.')); };
      img.src = url;
    });
  }
  function canvasB64(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob) return resolve(null);
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ''); resolve({ data: s.slice(s.indexOf(',') + 1), bytes: blob.size }); };
        fr.onerror = function () { resolve(null); };
        fr.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    });
  }
  async function prepareFile(win, file, fileIndex) {
    if (!/^image\//i.test(String(file.type || '')) && !/\.(png|jpe?g|webp|gif|heic|heif)$/i.test(String(file.name || ''))) throw new Error((file.name || 'That file') + ' is not an image.');
    if (file.size > MAX_FILE_BYTES) throw new Error((file.name || 'That image') + ' is over 30 MB.');
    var L = await loadImage(win, file), img = L.img, w = img.naturalWidth, h = img.naturalHeight, out = [];
    try {
      var plan = tilePlan(w, h);
      for (var i = 0; i < plan.length; i++) {
        var t = plan[i], k = Math.min(1, LONG_EDGE / Math.max(w, t.h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(t.h * k));
        var c = win.document.createElement('canvas'); c.width = cw; c.height = ch;
        var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); g.drawImage(img, 0, t.y, w, t.h, 0, 0, cw, ch);
        var enc = await canvasB64(c, 0.86);
        if (enc && enc.bytes > C.LIMITS.maxImageBytes) enc = await canvasB64(c, 0.7);
        if (!enc || enc.bytes > C.LIMITS.maxImageBytes) throw new Error((file.name || 'That image') + ' is too large to send even after scaling.');
        out.push({ media_type: 'image/jpeg', data: enc.data, bytes: enc.bytes, file: fileIndex, tile: i, tiles: plan.length });
      }
    } finally { win.URL.revokeObjectURL(L.url); }
    return out;
  }

  /* ═══ 6. THE COMPONENT ═════════════════════════════════════════════════ */
  function newState() {
    return { step: 'input', kind: 'screenshot', book: 'auto', bookLabel: '', bookType: 'SPORTSBOOK', files: [], filesRead: 0, text: '', bets: [], warnings: [],
      error: null, progress: null, events: null, eventsError: null, markets: [], filter: 'all', saving: null, result: null, seq: 0, quota: null };
  }
  function bookChoice(S) { return C.BOOK_BY_KEY[S.book] || C.BOOK_BY_KEY.auto; }
  function ready(S) {
    var b = bookChoice(S);
    if (b.key === 'other' && blank(S.bookLabel)) return false;
    return S.kind === 'paste' ? !blank(S.text) : S.files.length > 0;
  }
  /* a saved pick this row would settle (and nothing in the way) */
  function updates(b) { return !!(b.existing && b.update && b.update.patch); }
  function hasWarning(b) { return ((b.check && b.check.issues) || []).some(function (i) { return i.level === 'warning'; }); }
  function unmatched(b) { return !!(b.match && (b.match.state === 'unmatched' || (b.match.state === 'none' && b.match.auto))); }
  /* nothing for the reader to look at: it arrives confirmed */
  function clean(b) {
    var c = b.check || {};
    return !!c.valid && !hasWarning(b) && !(c.low && c.low.length) && b.duplicate_of == null && !b.saved
      && (!b.existing || updates(b)) && !(b.match && b.match.state === 'unmatched');
  }
  function counts(S) {
    var n = { total: S.bets.length, bad: 0, unmatched: 0, nogame: 0, confirmed: 0, existing: 0, low: 0, updates: 0 };
    S.bets.forEach(function (b) {
      var c = b.check || {};
      if (!c.valid) n.bad++;
      if (b.match && b.match.state === 'unmatched') n.unmatched++;
      if (b.match && b.match.state === 'none' && b.match.auto) n.nogame++;
      if (b.confirmed) n.confirmed++;
      if (b.existing && !updates(b)) n.existing++;
      if (updates(b)) n.updates++;
      if (c.low && c.low.length) n.low++;
    });
    return n;
  }
  function canConfirm(b) { return !!(b.check && b.check.valid) && b.duplicate_of == null && !b.saved && (!b.existing || updates(b)); }
  function savable(b) { return !!b.confirmed && canConfirm(b); }

  /* ── rendering (pure: state in, HTML out) ── */
  function chip(act, v, label, pressed) { return '<button type="button" class="pfo-chip" data-bim="' + act + '" data-v="' + esc(v) + '" aria-pressed="' + (!!pressed) + '">' + esc(label) + '</button>'; }
  function flow(S) {
    var step = S.step === 'done' ? 4 : (S.step === 'review' || S.step === 'saving') ? 3 : 2;
    return '<ol class="pfo-flow" aria-label="Import steps">' + ['Book', 'Add', 'Review', 'Saved'].map(function (x, i) {
      return '<li class="' + (i + 1 < step ? 'done' : i + 1 === step ? 'now' : '') + '"' + (i + 1 === step ? ' aria-current="step"' : '') + '>' + (i + 1) + ' · ' + x + '</li>';
    }).join('') + '</ol>';
  }
  function inputView(S) {
    var b = bookChoice(S), h = '';
    h += '<div class="bim-step"><div class="bim-lbl">1 · Which platform are these from?</div><div class="pfo-chips" role="group" aria-label="Platform">'
      + C.BOOKS.map(function (x) { return chip('book', x.key, x.label, b.key === x.key); }).join('') + '</div>';
    if (b && b.key === 'other') {
      h += '<div class="bim-other"><label class="pfo-fld"><span>Platform name</span><input data-bim-in="bookLabel" value="' + esc(S.bookLabel) + '" maxlength="60" autocomplete="off" placeholder="e.g. Sporttrade"></label>'
        + '<div class="pfo-fld"><span>It is a</span><div class="pfo-seg">' + chip('bookType', 'SPORTSBOOK', 'Sportsbook or exchange', S.bookType === 'SPORTSBOOK')
        + chip('bookType', 'PREDICTION_MARKET', 'Prediction market', S.bookType === 'PREDICTION_MARKET') + '</div></div></div>';
    }
    h += '<div class="pfo-note">' + (b.key === 'auto'
      ? 'EdgeDesk tells the platform from the screenshot (DraftKings Predictions, Kalshi, Novig, ProphetX, a sportsbook…). Choose one only if it reads it wrong; each pick\'s platform can also be changed in review.'
      : 'The platform is a hint for reading prices (Kalshi and DK Predictions show a price per contract; Novig and ProphetX show odds) and the account the picks are filed under.') + '</div></div>';
    h += '<div class="bim-step"><div class="bim-lbl">2 · Add your bet history</div><div class="pfo-seg" role="tablist" aria-label="How">'
      + '<button type="button" class="pfo-chip" role="tab" data-bim="kind" data-v="screenshot" aria-selected="' + (S.kind === 'screenshot') + '" aria-pressed="' + (S.kind === 'screenshot') + '">Screenshots</button>'
      + '<button type="button" class="pfo-chip" role="tab" data-bim="kind" data-v="paste" aria-selected="' + (S.kind === 'paste') + '" aria-pressed="' + (S.kind === 'paste') + '">Paste text</button></div>';
    if (S.kind === 'screenshot') {
      h += '<label class="pfo-drop bim-drop" data-bim-drop><input type="file" accept="image/*" multiple data-bim-file aria-label="Choose screenshots">'
        + '<b>' + (S.files.length ? 'Add more screenshots' : 'Choose screenshots') + '</b><span>From your camera roll or files · up to ' + MAX_FILES + ' at a time · long scrolling captures are fine · reading starts right away</span></label>';
      if (S.files.length) {
        h += '<ul class="bim-files">' + S.files.map(function (f, i) {
          return '<li><span class="bim-fname">' + esc(f.name || 'Screenshot ' + (i + 1)) + '</span><span class="pfo-mut">' + esc(Math.max(1, Math.round(f.size / 1024))) + ' KB</span>'
            + '<button type="button" class="pfo-x" data-bim="file-remove" data-v="' + i + '" aria-label="Remove ' + esc(f.name || 'screenshot') + '">×</button></li>';
        }).join('') + '</ul>';
      }
    } else {
      h += '<label class="pfo-fld bim-paste"><span>Bet history text <em>' + esc(S.text.length.toLocaleString('en-US')) + ' / ' + PASTE_MAX.toLocaleString('en-US') + '</em></span>'
        + '<textarea data-bim-in="text" rows="10" maxlength="' + PASTE_MAX + '" placeholder="Open your bet or trade history, select it, copy, and paste it here.">' + esc(S.text) + '</textarea></label>';
    }
    h += '<div class="pfo-note">Screenshots and text are sent to EdgeDesk\'s reader (Anthropic\'s Claude) only to be read, and are not stored. '
      + 'Nothing is added to your portfolio until you review the picks and press Confirm.</div></div>';
    if (S.error) h += '<div class="pfo-err" role="alert">' + esc(S.error) + '</div>';
    h += '<div class="pfo-btns"><button type="button" class="pfo-btn" data-bim="read"' + (ready(S) ? '' : ' disabled') + '>' + (S.kind === 'screenshot' && S.files.length && S.error ? 'Try again' : 'Read my picks') + '</button></div>';
    return h;
  }
  function readingView(S) {
    var p = S.progress || {};
    return '<div class="bim-reading" role="status" aria-live="polite"><div class="bim-spin" aria-hidden="true"></div><div><b>' + esc(p.label || 'Reading…') + '</b>'
      + '<div class="pfo-mut">' + esc(p.detail || 'This usually takes under a minute per batch.') + '</div></div></div>'
      + (p.total > 1 ? '<div class="bim-bar" aria-hidden="true"><i style="width:' + Math.round(100 * (p.done || 0) / p.total) + '%"></i></div>' : '');
  }
  function fieldCls(b, field) {
    var c = b.check || {}, cls = [];
    if ((c.issues || []).some(function (i) { return i.field === field && i.level === 'error'; })) cls.push('bim-bad');
    else if ((c.low || []).indexOf(field) >= 0) cls.push('bim-low');
    return cls.join(' ');
  }
  function lowTitle(b, field) { return (b.check && (b.check.low || []).indexOf(field) >= 0) ? ' title="The reader was not sure of this — check it."' : ''; }
  function inp(b, field, conf, value, attrs, label) {
    return '<input data-bim-f="' + field + '" data-id="' + esc(b.id) + '" value="' + esc(value) + '" class="' + fieldCls(b, conf) + '"' + lowTitle(b, conf)
      + ' aria-label="' + esc(label) + '"' + (attrs || '') + '>';
  }
  function selectEl(b, field, conf, value, options, label) {
    return '<select data-bim-f="' + field + '" data-id="' + esc(b.id) + '" class="' + fieldCls(b, conf) + '"' + lowTitle(b, conf) + ' aria-label="' + esc(label) + '">'
      + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(value) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  /* the row's platform: every platform the Portfolio knows, and the name the
     reader printed when it is none of them (then: which kind it is) */
  var WAS = { OPEN: 'Open', WON: 'Won', LOST: 'Lost', PUSH: 'Push', VOID: 'Void', CASHED_OUT: 'Cashed out', SETTLED: 'Settled', SOLD: 'Sold' };
  function platformSelect(b) {
    var known = b.book_key && E.platform(b.book_key), val = known ? b.book_key : (b.book_key ? b.book_key : (b.book_label ? '__custom:' + (b.platform_type || '') : ''));
    var opts = [['', 'Choose the platform…']].concat(E.PLATFORMS.map(function (p) { return [p.key, p.label]; }));
    if (b.book_key && !known) opts.push([b.book_key, b.book_label || E.platformLabel(b.book_key)]);
    else if (!b.book_key && b.book_label) {
      if (!b.platform_type) opts.push(['__custom:', b.book_label]);
      opts.push(['__custom:SPORTSBOOK', b.book_label + ' (sportsbook or exchange)'], ['__custom:PREDICTION_MARKET', b.book_label + ' (prediction market)']);
    }
    var bad = !b.book_key && !(b.book_label && b.platform_type);
    return '<select data-bim-book data-id="' + esc(b.id) + '" class="bim-plat ' + (bad ? 'bim-bad' : fieldCls(b, 'book')) + '"' + lowTitle(b, 'book') + ' aria-label="Platform">'
      + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  function evLabel(ev, tz) { return ev ? (ev.away_team + ' @ ' + ev.home_team + ' · ' + whenText(ev.commence_time, tz)) : ''; }
  function gameOptions(b, S, q) {
    var m = b.match || {}, list = (m.candidates || []).slice();
    if (q) {
      var nq = N(q);
      list = (S.events || []).filter(function (ev) { return N(ev.home_team + ' ' + ev.away_team + ' ' + (ev.sport_title || '')).indexOf(nq) >= 0; }).slice(0, 40);
    }
    if (m.event && !list.some(function (ev) { return ev.event_id === m.event.event_id; })) list.unshift(m.event);
    return '<option value="">Pick the game…</option>'
      + list.map(function (ev) { return '<option value="' + esc(ev.event_id) + '"' + (m.event && m.event.event_id === ev.event_id ? ' selected' : '') + '>' + esc(evLabel(ev, S.tz)) + '</option>'; }).join('')
      + '<option value="__none"' + (m.state === 'none' ? ' selected' : '') + '>No EdgeDesk game — save without CLV</option>';
  }
  function gameCell(b, S) {
    var m = b.match || {};
    if (S.events == null) return '<div class="bim-game pfo-mut">' + (S.eventsError ? esc(S.eventsError) : 'Finding the game…') + '</div>';
    if (m.state === 'na') return '<div class="bim-game pfo-mut">' + (b.market_type === 'parlay' ? 'Parlay: legs are not matched' : 'Future: no single game') + '</div>';
    var badge = m.state === 'auto' ? '<span class="bim-tag ok">Matched</span>' : m.state === 'picked' ? '<span class="bim-tag ok">You picked</span>'
      : m.state === 'none' ? (m.auto ? '<span class="bim-tag warn">No game found</span>' : '<span class="bim-tag">No game</span>') : '<span class="bim-tag warn">Not matched</span>';
    var clv = (m.state === 'auto' || m.state === 'picked') && b.platform_type === 'SPORTSBOOK' && ['moneyline', 'spread', 'total'].indexOf(b.market_type) >= 0
      ? (m.sig_key ? '<span class="bim-sub">CLV will be graded</span>' : '<span class="bim-sub">This line is not in EdgeDesk\'s capture; CLV may not be graded</span>')
      : (m.state === 'unmatched' || m.state === 'none' ? '<span class="bim-sub">' + (m.auto ? 'No EdgeDesk game fits this pick; search for it, or save it without CLV' : 'Without a game, CLV is not graded') + '</span>' : '');
    return '<div class="bim-game">' + badge + '<select data-bim-game data-id="' + esc(b.id) + '" class="' + (m.state === 'unmatched' ? 'bim-low' : '') + '" aria-label="EdgeDesk game">' + gameOptions(b, S) + '</select>'
      + '<input data-bim-search data-id="' + esc(b.id) + '" placeholder="Search games" aria-label="Search EdgeDesk games" autocomplete="off">' + clv + '</div>';
  }
  function priceHint(b) {
    var p = b.check && b.check.price;
    if (!p || p.error) return '';
    return b.platform_type === 'PREDICTION_MARKET' ? (p.american != null ? '≈ ' + C.americanText(p.american) + ' · ' + E.priceText(p.prob) : '')
      : (p.format !== 'american' && p.american != null ? '≈ ' + C.americanText(p.american) : '');
  }
  function existingText(b) {
    var u = b.update;
    if (u && u.patch && u.from === u.to) return { level: 'ok', text: 'Already in your portfolio as ' + (WAS[u.from] || u.from) + ' — saving adds what it paid (' + u.patch.reported_payout + ').' };
    if (u && u.patch) return { level: 'ok', text: 'Already in your portfolio as ' + (WAS[u.from] || u.from) + ' — saving updates it to ' + (WAS[u.to] || u.to) + (u.patch.reported_payout ? ' (paid ' + u.patch.reported_payout + ')' : '') + '.' };
    if (u && u.conflict && u.to === 'SOLD') return { level: 'warning', text: 'Already in your portfolio, still open; this shows it sold. Record the sale on it in History.' };
    if (u && u.conflict) return { level: 'warning', text: 'Already in your portfolio as ' + (WAS[u.from] || u.from) + '; this shows ' + (WAS[u.to] || u.to) + '. It was not changed — edit it in History if this is right.' };
    return { level: 'warning', text: 'Already in your portfolio — it will not be saved again.' };
  }
  function issuesHtml(b) {
    var c = b.check || {}, out = (c.issues || []).map(function (i) { return '<li class="pfo-issue ' + esc(i.level) + '">' + esc(i.message) + '</li>'; });
    if (b.existing && !b.outcome) { var x = existingText(b); out.unshift('<li class="pfo-issue ' + x.level + '">' + esc(x.text) + '</li>'); }
    if (b.duplicate_of != null) out.unshift('<li class="pfo-issue warning">Same bet as another row in this import — only that one is saved.</li>');
    if (b.outcome) out.unshift('<li class="pfo-issue ' + (b.outcome.ok ? 'ok' : 'error') + '">' + esc(b.outcome.text) + '</li>');
    return out.length ? '<ul class="bim-issues">' + out.join('') + '</ul>' : '';
  }
  function rowHtml(b, S, i) {
    var pm = b.platform_type === 'PREDICTION_MARKET', c = b.check || {};
    var src = b.origin === 'paste' ? 'Pasted text' : b.file != null ? 'Screenshot ' + (b.file + 1) + (b.tiles > 1 ? ' (part ' + (b.tile + 1) + ')' : '') : 'Screenshot';
    var cls = ['bim-row', c.valid ? '' : 'has-error', b.confirmed ? 'is-confirmed' : '', ((b.existing && !updates(b)) || b.duplicate_of != null) ? 'is-dup' : ''].filter(Boolean).join(' ');
    var can = canConfirm(b) && S.step !== 'saving' && S.step !== 'done';
    var h = '<tr class="' + cls + '" data-row="' + esc(b.id) + '">'
      + '<td data-label="Confirm" class="bim-c"><label class="bim-check"><input type="checkbox" data-bim-confirm data-id="' + esc(b.id) + '"' + (b.confirmed ? ' checked' : '') + (can || b.confirmed ? '' : ' disabled')
      + ' aria-label="Confirm pick ' + (i + 1) + '"><span>' + (b.confirmed ? (updates(b) ? 'Update' : 'Confirmed') : 'Confirm') + '</span></label></td>'
      + '<td data-label="Game">' + platformSelect(b) + inp(b, 'event', 'event', b.event, ' maxlength="200"', 'Event')
      + '<div class="bim-pair">' + inp(b, 'league', 'league', b.league, ' maxlength="30" placeholder="League"', 'League') + inp(b, 'sport', 'sport', b.sport, ' maxlength="30" placeholder="Sport"', 'Sport') + '</div>'
      + gameCell(b, S) + '</td>'
      + '<td data-label="Pick">' + selectEl(b, 'market_type', 'market_type', b.market_type, C.MARKET_TYPES.map(function (k) { return [k, MARKET_LABEL[k]]; }), 'Market type')
      + inp(b, 'selection', 'selection', b.selection, ' maxlength="200"', 'Selection')
      + '<div class="bim-pair">' + (pm ? selectEl(b, 'side', 'selection', b.side, [['', 'Side…'], ['YES', 'YES'], ['NO', 'NO']], 'Side') : '')
      + inp(b, 'line', 'line', b.line, ' inputmode="decimal" placeholder="Line"', 'Line') + '</div>'
      + (b.market ? '<span class="bim-sub">' + esc(b.market) + '</span>' : '') + '</td>'
      + '<td data-label="Price">' + inp(b, 'price_display', 'price', b.price_display, ' maxlength="40" placeholder="' + (pm ? '54¢' : '-110') + '"', 'Price as shown')
      + '<span class="bim-sub" data-bim-hint="' + esc(b.id) + '">' + esc(priceHint(b)) + '</span></td>'
      + '<td data-label="' + (pm ? 'Cost · contracts' : 'Stake') + '">' + inp(b, 'stake', 'stake', b.stake, ' inputmode="decimal" placeholder="$"', pm ? 'Cost' : 'Stake')
      + (pm ? inp(b, 'contracts', 'stake', b.contracts, ' inputmode="decimal" placeholder="Contracts"', 'Contracts') : '')
      + inp(b, 'potential_payout', 'payout', b.potential_payout, ' inputmode="decimal" placeholder="To pay"', 'Potential payout') + '</td>'
      + '<td data-label="Result · placed">' + selectEl(b, 'status', 'status', b.status, C.STATUSES.map(function (k) { return [k, STATUS_LABEL[k]]; }), 'Status')
      + inp(b, 'payout', 'payout', b.payout, ' inputmode="decimal" placeholder="Paid"', 'Amount paid')
      + inp(b, 'placed_at', 'placed_at', b.placed_at, ' type="datetime-local"', 'Placed') + '</td>'
      + '<td data-label="" class="bim-x"><button type="button" class="pfo-x" data-bim="delete" data-v="' + esc(b.id) + '" aria-label="Delete pick ' + (i + 1) + '">×</button></td></tr>'
      + '<tr class="bim-meta' + (c.valid ? '' : ' has-error') + '" data-meta="' + esc(b.id) + '"><td colspan="7"><span class="pfo-mut">' + esc(i + 1) + ' · ' + esc(src) + ' · ' + esc(b.book_label || b.book_as_read || '')
      + (b.book_detected && !(b.edited && b.edited.book) ? ' (detected)' : '') + (b.boost_pct ? ' · ' + esc(b.boost_pct) + '% boost' : '')
      + (b.notes ? ' · ' + esc(b.notes) : '') + (b.auto_confirmed && b.confirmed ? ' · nothing to check, confirmed for you' : '') + '</span>' + issuesHtml(b) + '</td></tr>';
    return h;
  }
  function visible(S) {
    return S.bets.filter(function (b) {
      if (S.filter === 'attention') return !b.saved && !clean(b);
      if (S.filter === 'unmatched') return unmatched(b);
      if (S.filter === 'confirmed') return b.confirmed;
      return true;
    });
  }
  function saveLabel(S) {
    var list = S.bets.filter(savable), up = list.filter(updates).length, add = list.length - up;
    function picks(k) { return k + ' pick' + (k === 1 ? '' : 's'); }
    if (S.step === 'saving') return 'Saving…';
    if (up && add) return 'Confirm: save ' + picks(add) + ', update ' + up;
    if (up) return 'Confirm and update ' + picks(up);
    return 'Confirm and save ' + picks(add);
  }
  function summaryHtml(S) {
    var n = counts(S), save = S.bets.filter(savable).length;
    return '<div class="bim-sum" data-bim-sum><b>' + n.total + '</b> pick' + (n.total === 1 ? '' : 's') + ' read'
      + (n.bad ? ' · <span class="pfo-down">' + n.bad + ' need' + (n.bad === 1 ? 's' : '') + ' a fix</span>' : '')
      + (n.low ? ' · <span class="bim-warn">' + n.low + ' with fields to check</span>' : '')
      + (n.unmatched ? ' · <span class="bim-warn">' + n.unmatched + ' not matched to a game</span>' : '')
      + (n.nogame ? ' · ' + n.nogame + ' with no EdgeDesk game (no CLV)' : '')
      + (n.updates ? ' · ' + n.updates + ' saved before, now settled' : '')
      + (n.existing ? ' · ' + n.existing + ' already saved' : '')
      + ' · <b>' + n.confirmed + '</b> confirmed</div>'
      + '<div class="pfo-btns bim-save"><button type="button" class="pfo-btn" data-bim="save"' + (save && S.step === 'review' ? '' : ' disabled') + '>'
      + esc(saveLabel(S)) + '</button>'
      + '<span class="pfo-mut bim-savenote">Nothing is saved until you press this.</span></div>';
  }
  function reviewView(S) {
    var n = counts(S), h = '';
    if (S.warnings.length) h += '<ul class="bim-warnings">' + S.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
    if (!S.bets.length) {
      return h + '<div class="pfo-empty"><b>No bets were found.</b> Try a sharper screenshot of your bet history, or paste the text instead.</div>'
        + '<div class="pfo-btns"><button type="button" class="pfo-btn ghost" data-bim="restart">Start over</button></div>';
    }
    h += '<div class="pfo-filters bim-filters"><div class="pfo-chips" role="group" aria-label="Show">' + chip('filter', 'all', 'All ' + n.total, S.filter === 'all')
      + chip('filter', 'attention', 'Needs attention', S.filter === 'attention') + chip('filter', 'unmatched', 'Not matched ' + (n.unmatched + n.nogame), S.filter === 'unmatched')
      + chip('filter', 'confirmed', 'Confirmed ' + n.confirmed, S.filter === 'confirmed') + '</div>'
      + '<div class="pfo-btns"><button type="button" class="pfo-btn ghost sm" data-bim="confirm-ready"' + (S.step === 'review' ? '' : ' disabled') + '>Confirm all without errors</button>'
      + (S.kind === 'screenshot' ? '<label class="pfo-btn ghost sm bim-more' + (S.step === 'review' ? '' : ' is-off') + '"><input type="file" accept="image/*" multiple data-bim-file data-bim-more class="pfo-sr"'
        + (S.step === 'review' ? '' : ' disabled') + ' aria-label="Add more screenshots">Add more screenshots</label>' : '')
      + '<button type="button" class="pfo-btn ghost sm" data-bim="restart"' + (S.step === 'saving' ? ' disabled' : '') + '>Start over</button></div></div>';
    h += '<div class="pfo-note">Picks with nothing to check arrive confirmed. Highlighted fields are ones the reader was not sure of: edit anything that is wrong, delete what is not a bet, and confirm the rest.</div>';
    var rows = visible(S);
    h += '<div class="pfo-tablewrap bim-wrap"><table class="pfo-table bim-table"><colgroup><col class="w-c"><col class="w-game"><col class="w-pick"><col class="w-price"><col class="w-stake"><col class="w-res"><col class="w-x"></colgroup>'
      + '<thead><tr><th>✓</th><th>Game</th><th>Pick</th><th>Price</th><th>Stake</th><th>Result · placed</th><th><span class="pfo-sr">Delete</span></th></tr></thead><tbody>'
      + (rows.length ? rows.map(function (b) { return rowHtml(b, S, S.bets.indexOf(b)); }).join('') : '<tr><td colspan="7" class="pfo-mut">Nothing to show with this filter.</td></tr>')
      + '</tbody></table></div>';
    if (S.error) h += '<div class="pfo-err" role="alert">' + esc(S.error) + '</div>';
    return h + summaryHtml(S);
  }
  function doneView(S) {
    var r = S.result || {};
    return '<div class="bim-done" role="status"><b>' + (r.imported || 0) + ' pick' + (r.imported === 1 ? '' : 's') + ' saved to your portfolio.</b>'
      + (r.updated ? ' ' + r.updated + ' saved before ' + (r.updated === 1 ? 'was' : 'were') + ' updated with ' + (r.updated === 1 ? 'its' : 'their') + ' result.' : '')
      + (r.duplicates ? ' ' + r.duplicates + ' already there ' + (r.duplicates === 1 ? 'was' : 'were') + ' skipped.' : '')
      + (r.failed ? ' <span class="pfo-down">' + r.failed + ' could not be saved — see the rows below.</span>' : '') + '</div>'
      + '<div class="pfo-btns"><button type="button" class="pfo-btn" data-bim="restart">Import more</button>'
      + '<button type="button" class="pfo-btn ghost" data-bim="history">See them in History</button></div>'
      + '<div class="pfo-tablewrap bim-wrap"><table class="pfo-table bim-table bim-ro"><tbody>' + S.bets.map(function (b, i) {
        return '<tr class="bim-meta"><td>' + esc(i + 1) + ' · ' + esc([b.event, b.selection || b.side, b.price_display].filter(Boolean).join(' · ')) + issuesHtml(b) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function render(S) {
    var body = S.step === 'input' ? inputView(S) : S.step === 'reading' ? readingView(S) : S.step === 'done' ? doneView(S) : reviewView(S);
    return '<section class="pfo-sec bim" data-bim-root><div class="pfo-sec-h">Import picks · screenshots or pasted text'
      + '<span class="pfo-right"><button type="button" class="pfo-btn ghost sm" data-bim="close">Back to file import</button></span></div>'
      + flow(S) + body + '</section>';
  }

  /* ── what happens: reading, matching, saving ── */
  function friendly(r) {
    var b = r && r.body;
    if (r && r.status === 0) return 'EdgeDesk could not be reached. Check your connection; nothing was saved.';
    if (r && r.status === 404 && !(b && b.reason)) return 'Screenshot import is not available on this server yet.';
    if (r && r.status === 401) return 'Your session has ended. Sign in again, then try once more.';
    if (b && b.message) return b.message + (b.retry_after_s ? ' (about ' + Math.max(1, Math.round(b.retry_after_s / 60)) + ' min)' : '');
    return 'Reading failed (' + (r && r.status) + '). Nothing was saved.';
  }
  function adopt(S, bets, meta) {
    bets.forEach(function (raw) {
      var b = Object.assign({}, raw);
      b.id = 'b' + (++S.seq);
      b.origin = meta.origin; b.model = meta.model || null;
      if (meta.tiles) { var t = meta.tiles[b.source_image]; b.file = t ? t.file : null; b.tile = t ? t.tile : 0; b.tiles = t ? t.tiles : 1; }
      b.confirmed = false; b.edited = {}; b.fresh = true;
      delete b.issues; delete b.valid; delete b.price; delete b.low; delete b.duplicate_of;
      S.bets.push(b);
    });
  }
  /* the rows just read that have nothing to check arrive confirmed (once:
     a row the reader unticks stays unticked) */
  function autoConfirm(S) {
    S.bets.forEach(function (b) {
      if (!b.fresh) return;
      delete b.fresh;
      if (clean(b)) { b.confirmed = true; b.auto_confirmed = true; }
    });
  }
  function recheck(S, b) {
    var pl = platformOf(b);
    b.platform_type = pl.platform_type || b.platform_type;
    b.check = check(b, { today: todayIn(S.tz) });
    if (!b.check.valid) b.confirmed = false;
  }
  function markInBatchDuplicates(S) {
    var seen = {};
    S.bets.forEach(function (b, i) {
      var k = C.sameBetKey(b);
      if (seen[k] != null && seen[k] !== b.id) { b.duplicate_of = seen[k]; b.confirmed = false; } else { seen[k] = b.id; if (b.duplicate_of != null) delete b.duplicate_of; }
    });
  }

  function attach(host, ctx) {
    ctx = ctx || {};
    var S = ctx.state || newState(), doc = host.ownerDocument || root.document, win = doc.defaultView || root;
    S.tz = ctx.tz || S.tz || 'UTC';
    var api = ctx.api;
    function paint() { host.innerHTML = render(S); }
    function byId(id) { return S.bets.filter(function (b) { return b.id === id; })[0] || null; }

    async function callFn(body) {
      try { return await api.fn(FUNCTION, body); } catch (_) { return { status: 0, body: null }; }
    }
    /* `more`: screenshots added in review — read, then appended to the rows
       already there (their edits, ticks and picked games kept) */
    async function readPicks(more) {
      var b = bookChoice(S);
      if (!ready(S) || S.step === 'reading' || S.step === 'saving') return;
      S.error = null; S.result = null;
      if (!more) { S.warnings = []; S.bets = []; S.events = null; S.eventsError = null; S.markets = []; S.filter = 'all'; S.filesRead = 0; }
      var had = S.bets.length;
      S.step = 'reading'; S.progress = { label: S.kind === 'paste' ? 'Reading your pasted text…' : 'Preparing your screenshots…', done: 0, total: 1 }; paint();
      var base = { kind: S.kind, book: b.key, book_label: b.key === 'other' ? S.bookLabel : undefined, book_type: b.key === 'other' ? S.bookType : undefined,
        tz: S.tz, today: todayIn(S.tz) };
      try {
        if (S.kind === 'paste') {
          var parts = splitText(S.text, C.LIMITS.maxTextChars - 500);
          for (var p = 0; p < parts.length; p++) {
            S.progress = { label: 'Reading your pasted text' + (parts.length > 1 ? ' (part ' + (p + 1) + ' of ' + parts.length + ')' : '') + '…', done: p, total: parts.length }; paint();
            var r = await callFn(Object.assign({ text: parts[p] }, base));
            if (!r.body || r.status !== 200 || !r.body.ok) throw new Error(friendly(r));
            adopt(S, r.body.bets || [], { origin: 'paste', model: r.body.model });
            S.warnings = S.warnings.concat(r.body.warnings || []); S.quota = r.body.quota || S.quota;
          }
        } else {
          var tiles = [];
          for (var f = 0; f < S.files.length; f++) {
            S.progress = { label: 'Preparing screenshot ' + (f + 1) + ' of ' + S.files.length + '…', done: f, total: S.files.length }; paint();
            (await prepareFile(win, S.files[f].file, S.filesRead + f)).forEach(function (t) { tiles.push(t); });
          }
          var batches = [];
          for (var i = 0; i < tiles.length; i += BATCH) batches.push(tiles.slice(i, i + BATCH));
          for (var k = 0; k < batches.length; k++) {
            var lo = k * BATCH + 1, hi = Math.min(tiles.length, (k + 1) * BATCH);
            S.progress = { label: 'Reading ' + (tiles.length === 1 ? 'your screenshot' : 'images ' + lo + (hi > lo ? '–' + hi : '') + ' of ' + tiles.length) + '…', done: k, total: batches.length,
              detail: tiles.length > S.files.length ? 'Long screenshots are read in overlapping parts.' : null }; paint();
            var rr = await callFn(Object.assign({ images: batches[k].map(function (t) { return { media_type: t.media_type, data: t.data }; }) }, base));
            if (!rr.body || rr.status !== 200 || !rr.body.ok) throw new Error(friendly(rr) + (k > 0 ? ' The screenshots read before this were kept.' : ''));
            adopt(S, rr.body.bets || [], { origin: 'screenshot', model: rr.body.model, tiles: batches[k] });
            S.warnings = S.warnings.concat(rr.body.warnings || []); S.quota = rr.body.quota || S.quota;
          }
          tiles.length = 0;
        }
      } catch (e) {
        S.error = String((e && e.message) || 'Reading failed. Nothing was saved.');
        if (!S.bets.length) { S.step = 'input'; S.progress = null; paint(); return; }
        if (more && S.bets.length === had) { S.files = []; S.step = 'review'; S.progress = null; paint(); return; }
      }
      if (S.kind === 'screenshot') S.filesRead += S.files.length;
      S.files.forEach(function (x) { x.file = null; });
      S.files = [];
      S.bets.forEach(function (x) { recheck(S, x); });
      markInBatchDuplicates(S);
      S.step = 'review'; S.progress = null; paint();
      if (ctx.onRead) { try { ctx.onRead(S.bets.length); } catch (_) { /* telemetry only */ } }
      await loadGames();
      await precheck(S.bets);
      autoConfirm(S);
      paint();
    }
    function splitText(t, max) {
      if (t.length <= max) return [t];
      var out = [], lines = t.split('\n'), cur = '';
      lines.forEach(function (l) { if ((cur + '\n' + l).length > max && cur) { out.push(cur); cur = l; } else cur = cur ? cur + '\n' + l : l; });
      if (cur) out.push(cur);
      return out.slice(0, 4);
    }
    async function loadGames() {
      try {
        var wins = eventWindows(S.bets, S.tz), sports = sportKeysOf(S.bets), all = [], seen = {};
        for (var i = 0; i < wins.length; i++) {
          var r = await api.rpc('bet_import_events', { p_from: wins[i].from, p_to: wins[i].to, p_sports: sports && sports.length ? sports : null }) || [];
          r.forEach(function (ev) { if (!seen[ev.event_id]) { seen[ev.event_id] = 1; all.push(ev); } });
        }
        S.events = all;
        if (!all.length) S.eventsError = 'No EdgeDesk games were found around these dates.';
      } catch (_) { S.events = []; S.eventsError = 'Games could not be loaded, so picks are saved without a game (no CLV).'; }
      S.bets.forEach(function (b) { if (!(b.match && b.match.user)) b.match = autoMatch(b); });
      await loadMarkets(); paint();
    }
    /* a pick no EdgeDesk game fits at all is saved without a game unless the
       reader finds one; one with games to choose from waits for the reader */
    function autoMatch(b) {
      var m = matchBet(b, S.events, S.tz);
      if (m.state === 'unmatched' && !m.candidates.length) { m.state = 'none'; m.auto = true; }
      return m;
    }
    async function loadMarkets() {
      var ids = {}, need = S.bets.filter(function (b) { return b.match && b.match.event && b.platform_type === 'SPORTSBOOK'; });
      need.forEach(function (b) { ids[b.match.event.event_id] = 1; });
      var list = Object.keys(ids).filter(function (id) { return !S.markets.some(function (m) { return m.event_id === id; }); });
      for (var i = 0; i < list.length; i += 50) {
        try { S.markets = S.markets.concat(await api.rpc('bet_import_markets', { p_event_ids: list.slice(i, i + 50) }) || []); } catch (_) { /* no keys: no CLV, still matched */ }
      }
      S.bets.forEach(function (b) { if (b.match) b.match.sig_key = b.match.event ? sigKeyFor(b, b.match.event, S.markets) : null; });
    }
    /* a read: is this pick already in the portfolio — and if it was saved
       Open, does this screenshot settle it? (the server decides again on
       save: a duplicate is never inserted twice) */
    async function precheck(list) {
      var today = todayIn(S.tz), want = [], c = { tz: S.tz, today: today };
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        b.existing = null; b.update = null;
        if (!(b.check && b.check.valid) || b.saved) continue;
        var rows = stagedRows(b, c, 1), n = rows[0].normalized;
        want.push({ b: b, kind: n.kind, fp: await sha256Hex(materialOf(n)) });
      }
      var POS = 'id,status,resolution,reported_payout::text,source';
      function found(x, pos) {
        x.b.existing = pos.id;
        x.b.update = updatePlan(x.b, pos, c);
        if (!updates(x.b)) x.b.confirmed = false;
      }
      for (var k = 0; k < want.length; k += 40) {
        var chunk = want.slice(k, k + 40);
        var w = chunk.filter(function (x) { return x.kind === 'wager'; }), f = chunk.filter(function (x) { return x.kind === 'fill'; });
        try {
          if (w.length) (await api.call('portfolio_positions?select=fingerprint,' + POS + '&fingerprint=in.(' + w.map(function (x) { return x.fp; }).join(',') + ')') || [])
            .forEach(function (r) { w.forEach(function (x) { if (x.fp === r.fingerprint && !x.b.existing) found(x, r); }); });
          if (f.length) {
            var tx = await api.call('portfolio_transactions?select=fingerprint,position_id&fingerprint=in.(' + f.map(function (x) { return x.fp; }).join(',') + ')') || [];
            var ids = tx.map(function (t) { return t.position_id; }).filter(function (v, j, a) { return v && a.indexOf(v) === j; });
            var pos = ids.length ? await api.call('portfolio_positions?select=' + POS + '&id=in.(' + ids.join(',') + ')') || [] : [];
            tx.forEach(function (t) {
              var p = pos.filter(function (q) { return q.id === t.position_id; })[0] || { id: t.position_id, source: 'SYNC' };
              f.forEach(function (x) { if (x.fp === t.fingerprint && !x.b.existing) found(x, p); });
            });
          }
        } catch (_) { /* the server still refuses a duplicate on save */ }
      }
    }

    async function save() {
      var list = S.bets.filter(savable);
      if (!list.length || S.step !== 'review') return;
      S.step = 'saving'; S.error = null; paint();
      var res = { imported: 0, updated: 0, duplicates: 0, failed: 0 }, today = todayIn(S.tz);
      try {
        /* a pick saved Open before, settled by this screenshot: its one
           position is patched (the reader's own row, under RLS) */
        var ups = list.filter(updates);
        for (var u = 0; u < ups.length; u++) {
          var ub = ups[u];
          try {
            await api.updatePosition(ub.update.id, ub.update.patch);
            res.updated++; ub.saved = true; ub.confirmed = false;
            ub.outcome = { ok: true, text: 'Updated: ' + (WAS[ub.update.from] || ub.update.from) + ' → ' + (WAS[ub.update.to] || ub.update.to) + '.' };
          } catch (e) { res.failed++; ub.outcome = { ok: false, text: 'Not updated: ' + String((e && e.message) || 'refused').slice(0, 200) }; }
        }
        var groups = { screenshot: [], paste: [] };
        list.filter(function (b) { return !updates(b); }).forEach(function (b) { groups[b.origin === 'paste' ? 'paste' : 'screenshot'].push(b); });
        for (var kind in groups) {
          var g = groups[kind];
          if (!g.length) continue;
          var built = toImportRows(g, { tz: S.tz, today: today }), plats = {};
          built.rows.forEach(function (r) { plats[r.normalized.platform] = r.normalized.platform_type; });
          var pk = Object.keys(plats);
          var id = await api.createImport({ platform_type: plats[pk[0]] || 'SPORTSBOOK', importer: IMPORTER[kind], timezone: S.tz, column_map: {},
            file_name: kind === 'paste' ? 'Pasted text' : 'Screenshots (' + g.length + ' pick' + (g.length === 1 ? '' : 's') + ')', platform: pk.length === 1 ? pk[0] : null });
          if (!id) throw new Error('The import could not be started. Nothing was saved.');
          await api.stageRows(id, built.rows);
          var r, calls = 0;
          do { r = await api.commit(id); } while (r && r.status !== 'COMMITTED' && r.remaining > 0 && ++calls < 50);
          if (!r || r.status !== 'COMMITTED') throw new Error('The save stopped part-way; what went in is marked on each row. Press Confirm again to finish it.');
          try { await api.rpc('portfolio_bet_import_finalize', { p_import: id }); } catch (_) { /* the display price and game can be re-attached later; the picks are saved */ }
          var rows = await api.importRows(id) || [];
          rows.forEach(function (row) {
            var b = byId(built.betOf[row.row_number]);
            if (!b || (b.outcome && b.outcome.ok && row.outcome !== 'IMPORTED')) return;
            if (row.outcome === 'IMPORTED') { if (!b.outcome) res.imported++; b.outcome = { ok: true, text: 'Saved.' }; b.saved = true; b.confirmed = false; }
            else if (row.outcome === 'UPDATED') { res.duplicates++; b.outcome = { ok: true, text: 'Already in your portfolio — its result was updated.' }; b.saved = true; b.confirmed = false; }
            else if (row.classification === 'DUPLICATE' || row.classification === 'DUPLICATE_IN_FILE') { res.duplicates++; b.outcome = { ok: true, text: 'Already in your portfolio — skipped.' }; }
            else if (row.classification === 'NEEDS_REVIEW') { res.duplicates++; b.outcome = { ok: false, text: ((row.issues || []).filter(function (x) { return x.code === 'MATCHES_RECORDED_POSITION'; })[0] || {}).message || 'Held: it matches a bet you already recorded.' }; }
            else { res.failed++; b.outcome = { ok: false, text: 'Not saved: ' + (row.outcome_message || (row.issues || []).filter(function (x) { return x.level === 'error'; }).map(function (x) { return x.code; }).join(', ') || 'refused') }; }
          });
        }
        S.result = res; S.step = 'done';
        if (ctx.onSaved) { try { ctx.onSaved(res); } catch (_) { /* the page refresh is best effort */ } }
      } catch (e) {
        S.error = String((e && e.message) || 'Saving failed. Nothing was saved.') ; S.step = 'review';
      }
      paint();
    }

    /* ── events: this component's own (data-bim*), never the page's data-act ── */
    host.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-bim]') : null;
      if (!t || !host.contains(t)) return;
      var act = t.getAttribute('data-bim'), v = t.getAttribute('data-v');
      ev.preventDefault();
      if (act === 'book') { S.book = v; S.error = null; return paint(); }
      if (act === 'bookType') { S.bookType = v; return paint(); }
      if (act === 'kind') { S.kind = v; S.error = null; return paint(); }
      if (act === 'file-remove') { S.files.splice(+v, 1); return paint(); }
      if (act === 'read') return readPicks();
      if (act === 'filter') { S.filter = v; return paint(); }
      if (act === 'delete') { S.bets = S.bets.filter(function (b) { return b.id !== v; }); markInBatchDuplicates(S); return paint(); }
      if (act === 'confirm-ready') { S.bets.forEach(function (b) { if (canConfirm(b)) b.confirmed = true; }); return paint(); }
      if (act === 'save') return save();
      if (act === 'restart') { var keep = { book: S.book, bookLabel: S.bookLabel, bookType: S.bookType, kind: S.kind, tz: S.tz }; Object.assign(S, newState(), keep); return paint(); }
      if (act === 'close') { if (ctx.onClose) ctx.onClose(); return; }
      if (act === 'history') { if (ctx.onHistory) ctx.onHistory(); return; }
    });
    host.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t.hasAttribute && t.hasAttribute('data-bim-file')) {
        var more = t.hasAttribute('data-bim-more');
        addFiles(Array.prototype.slice.call(t.files || []), more);
        t.value = '';
        return;
      }
      var id = t.getAttribute && t.getAttribute('data-id'), b = id ? byId(id) : null;
      if (!b) return;
      if (t.hasAttribute('data-bim-confirm')) { b.confirmed = !!t.checked && canConfirm(b); b.auto_confirmed = false; return refreshRow(b, true); }
      if (t.hasAttribute('data-bim-book')) { setPlatform(b, t.value); refreshRow(b, true); precheck([b]).then(function () { refreshRow(b, false); }); return; }
      if (t.hasAttribute('data-bim-game')) {
        var val = t.value;
        b.match = b.match || { candidates: [] };
        b.match.user = true; b.match.auto = false;
        if (val === '__none') { b.match.state = 'none'; b.match.event = null; b.match.sig_key = null; }
        else if (!val) { b.match.state = 'unmatched'; b.match.event = null; b.match.sig_key = null; b.match.user = false; }
        else {
          var pick = (S.events || []).filter(function (x) { return x.event_id === val; })[0] || null;
          b.match.event = pick; b.match.state = pick ? 'picked' : 'unmatched';
          loadMarkets().then(function () { b.match.sig_key = pick ? sigKeyFor(b, pick, S.markets) : null; refreshRow(b, true); });
        }
        return refreshRow(b, true);
      }
      var f = t.getAttribute('data-bim-f');
      if (!f) return;
      b[f] = String(t.value || '').trim();
      if (f === 'league') b.league = b.league.toUpperCase();
      b.edited[f] = true;
      var conf = { event: 'event', league: 'league', sport: 'sport', market_type: 'market_type', selection: 'selection', side: 'selection', line: 'line', price_display: 'price', stake: 'stake', contracts: 'stake', potential_payout: 'payout', payout: 'payout', status: 'status', placed_at: 'placed_at' }[f];
      if (conf) b.edited[conf] = true;
      recheck(S, b); markInBatchDuplicates(S);
      if (['event', 'league', 'selection', 'placed_at', 'market_type'].indexOf(f) >= 0 && S.events && !(b.match && b.match.user)) {
        b.match = autoMatch(b);
        b.match.sig_key = b.match.event ? sigKeyFor(b, b.match.event, S.markets) : null;
        refreshRow(b, true);
      } else refreshRow(b, f === 'market_type' || f === 'status' || f === 'side');
      precheck([b]).then(function () { refreshRow(b, false); });
    });
    host.addEventListener('input', function (ev) {
      var t = ev.target, k = t.getAttribute && t.getAttribute('data-bim-in');
      if (k === 'text') { S.text = String(t.value || '').slice(0, PASTE_MAX); var em = host.querySelector('.bim-paste em'); if (em) em.textContent = S.text.length.toLocaleString('en-US') + ' / ' + PASTE_MAX.toLocaleString('en-US'); syncRead(); return; }
      if (k === 'bookLabel') { S.bookLabel = String(t.value || '').slice(0, 60); syncRead(); return; }
      if (t.hasAttribute && t.hasAttribute('data-bim-search')) {
        var b = byId(t.getAttribute('data-id')), sel = b && host.querySelector('select[data-bim-game][data-id="' + b.id + '"]');
        if (sel) sel.innerHTML = gameOptions(b, S, t.value);
      }
    });
    function syncRead() { var btn = host.querySelector('[data-bim="read"]'); if (btn) btn.disabled = !ready(S); }
    /* screenshots chosen (or dropped) are read straight away: on the first
       step when the platform needs nothing typed, in review as more rows */
    function addFiles(add, more) {
      add = add.filter(function (f) { return /^image\//i.test(String(f.type || '')) || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(String(f.name || '')); });
      if (!add.length) return;
      if (more) S.files = [];
      var room = MAX_FILES - S.files.length;
      S.error = add.length > room ? 'Up to ' + MAX_FILES + ' screenshots at a time; the first ' + Math.max(0, room) + ' were added.' : null;
      add.slice(0, Math.max(0, room)).forEach(function (f) { S.files.push({ name: f.name, size: f.size, file: f }); });
      var note = S.error;
      if (more) { S.kind = 'screenshot'; return readPicks(true).then(function () { if (note && !S.error) { S.error = note; paint(); } }); }
      if (ready(S) && S.step === 'input') return readPicks(false).then(function () { if (note && !S.error) { S.error = note; paint(); } });
      paint();
    }
    /* the reader names a row's platform (the screenshot's was not read, or
       was read wrong) */
    function setPlatform(b, v) {
      var c = /^__custom:(.*)$/.exec(v || ''), p = c ? null : E.platform(v);
      if (c) { b.book_key = ''; b.platform_type = c[1] || null; }
      else if (p) { b.book_key = p.key; b.book_label = p.label; b.platform_type = p.type; }
      else if (v && E.PLATFORM_KEY_RE.test(v)) b.book_key = v;
      else { b.book_key = ''; if (!b.book_label) b.platform_type = null; }
      delete b.book_differs; b.book_detected = false; b.edited.book = true;
      if (b.platform_type === 'PREDICTION_MARKET' && !b.side && b.selection) {
        if (/^(no|buy no)\b/i.test(b.selection)) b.side = 'NO'; else { b.side = 'YES'; b.side_assumed = !/^(yes|buy yes)$/i.test(b.selection); }
      }
      recheck(S, b); markInBatchDuplicates(S);
    }
    /* one row repainted in place; with `whole` the row is rebuilt (a select
       changed its shape), else only its marks, so a field being typed into
       keeps its focus */
    function refreshRow(b, whole) {
      var tr = host.querySelector('tr[data-row="' + b.id + '"]'), meta = host.querySelector('tr[data-meta="' + b.id + '"]');
      if (!tr || !meta) return paint();
      if (whole) {
        var tmp = doc.createElement('tbody'); tmp.innerHTML = rowHtml(b, S, S.bets.indexOf(b));
        var active = doc.activeElement, aField = active && active.getAttribute && active.getAttribute('data-bim-f'), aId = active && active.getAttribute && active.getAttribute('data-id');
        tr.replaceWith(tmp.children[0]); meta.replaceWith(tmp.children[0]);
        if (aField && aId) { var again = host.querySelector('[data-bim-f="' + aField + '"][data-id="' + aId + '"]'); if (again && again.focus) again.focus(); }
      } else {
        tr.querySelectorAll('[data-bim-f]').forEach(function (el) {
          var f = el.getAttribute('data-bim-f'), conf = { side: 'selection', price_display: 'price', contracts: 'stake', potential_payout: 'payout' }[f] || f;
          el.className = fieldCls(b, conf);
        });
        var hint = tr.querySelector('[data-bim-hint]'); if (hint) hint.textContent = priceHint(b);
        var box = tr.querySelector('[data-bim-confirm]');
        if (box) { box.disabled = !(canConfirm(b) || b.confirmed); box.checked = !!b.confirmed; }
        tr.classList.toggle('has-error', !(b.check && b.check.valid)); tr.classList.toggle('is-confirmed', !!b.confirmed);
        var tmp2 = doc.createElement('tbody'); tmp2.innerHTML = rowHtml(b, S, S.bets.indexOf(b)); meta.replaceWith(tmp2.children[1]);
      }
      var sum = host.querySelector('[data-bim-sum]');
      if (sum) { var wrap = doc.createElement('div'); wrap.innerHTML = summaryHtml(S); var next = sum.nextElementSibling; sum.replaceWith(wrap.children[0]); if (next && next.classList.contains('bim-save')) next.replaceWith(wrap.children[0]); }
    }
    /* dropped files read like chosen ones */
    host.addEventListener('dragover', function (ev) { var z = ev.target.closest && ev.target.closest('[data-bim-drop]'); if (z) { ev.preventDefault(); z.classList.add('over'); } });
    host.addEventListener('dragleave', function (ev) { var z = ev.target.closest && ev.target.closest('[data-bim-drop]'); if (z) z.classList.remove('over'); });
    host.addEventListener('drop', function (ev) {
      var z = ev.target.closest && ev.target.closest('[data-bim-drop]');
      if (!z) return;
      ev.preventDefault(); ev.stopPropagation(); z.classList.remove('over');
      addFiles(Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []), S.step === 'review');
    });
    paint();
    return { state: S, paint: paint };
  }

  return {
    VERSION: VERSION, FUNCTION: FUNCTION, IMPORTER: IMPORTER, BATCH: BATCH, MAX_FILES: MAX_FILES, SPORT_KEYS: SPORT_KEYS,
    newState: newState, attach: attach, render: render,
    toUtc: toUtc, toLocal: toLocal, platformOf: platformOf, teamScore: teamScore, matchBet: matchBet, candidates: candidates, sigKeyFor: sigKeyFor,
    eventWindows: eventWindows, sportKeysOf: sportKeysOf, stagedRows: stagedRows, toImportRows: toImportRows, materialOf: materialOf, sha256Hex: sha256Hex,
    tilePlan: tilePlan, counts: counts, savable: savable, clean: clean, updatePlan: updatePlan, contractMarket: contractMarket, esc: esc
  };
}));
